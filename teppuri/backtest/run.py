"""バックテストの実行器。

    python -m teppuri.backtest.run judge      [--sample N] [--yes]   # 判断を取る（既定は費用見積もりだけ）
    python -m teppuri.backtest.run predict    [--judge none|mock|real] [--sample N] [--yes] [--dry-run]
    python -m teppuri.backtest.run score                              # answers.yaml と比べて report.md
    python -m teppuri.backtest.run recognize  [--trials N] [--yes]    # 「どのサービスか分かるか」

- 事例: backtest/cases/<case_id>/app.yaml（契約 v2 の initial_state / changes を使う）
- 質問: backtest/questions.yaml
- 判断: teppuri.judge.decide を使う。出力は backtest/runs/<app_id>/（リポジトリの runs/ とは分ける）
- 予測: 各事例をエンジンで30回まわし、質問ごとに「はい」になった回の割合を backtest/predictions.json に書く
- 実際の API 呼び出しは --yes を付けたときだけ。付けなければ呼び出し数と費用の見積もりだけを出す
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import yaml

from teppuri.engine.inputs import DEFAULT_POPULATION, Population, load_app
from teppuri.engine.rules import REPO_ROOT, RULES_DIR, Draws, Rules
from teppuri.engine.run import DEFAULT_SEED, load_personas
from teppuri.engine.simulate import simulate_plan
from teppuri.engine.window import interval_runs

BACKTEST_DIR = REPO_ROOT / "backtest"
CASES_DIR = BACKTEST_DIR / "cases"
QUESTIONS = BACKTEST_DIR / "questions.yaml"
PREDICTIONS = BACKTEST_DIR / "predictions.json"
ANSWERS = BACKTEST_DIR / "answers.yaml"
RECOGNITION = BACKTEST_DIR / "recognition.json"
REPORT = BACKTEST_DIR / "report.md"
JUDGE_RUNS = BACKTEST_DIR / "runs"

PLAN = "A"            # バックテストの事例は1案だけ（A）
METRICS = ("revenue_jpy", "paying", "active", "arpu")
HOWS = ("sum", "last", "mean", "delta", "ratio")


# ---------------------------------------------------------------------------
# 質問の読み込みと検査
# ---------------------------------------------------------------------------

def load_questions(path: Path = QUESTIONS) -> tuple[dict, list[dict]]:
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    cases = data.get("cases") or {}
    questions = data.get("questions") or []
    validate_questions(cases, questions)
    return cases, questions


def date_to_day(day1: str, date: str) -> int:
    """day1 を 1日目として、date が何日目か。"""
    return (dt.date.fromisoformat(str(date)) - dt.date.fromisoformat(str(day1))).days + 1


def validate_questions(cases: dict, questions: list[dict]) -> None:
    """日付と日の一致、指標・集計の種類、区間が期間内かを確かめる。違えば止める。"""
    seen = set()
    for q in questions:
        qid = q["id"]
        if qid in seen:
            raise ValueError(f"質問 ID が重複しています: {qid}")
        seen.add(qid)
        if q["case"] not in cases:
            raise ValueError(f"{qid}: cases に {q['case']} がありません")
        if q["metric"] not in METRICS:
            raise ValueError(f"{qid}: metric は {METRICS} のどれか: {q['metric']}")
        if q["how"] not in HOWS:
            raise ValueError(f"{qid}: how は {HOWS} のどれか: {q['how']}")
        if (q["metric"] == "arpu") != (q["how"] == "ratio"):
            raise ValueError(f"{qid}: arpu と ratio は組で使う")
        if q["direction"] not in ("greater", "less"):
            raise ValueError(f"{qid}: direction は greater / less")
        case = cases[q["case"]]
        for side in ("a", "b"):
            s, e = q[side]["days"]
            if not (1 <= s <= e <= int(case["horizon"])):
                raise ValueError(f"{qid}.{side}: {s}〜{e} 日目が期間 1〜{case['horizon']} の外です")
            dates = q[side].get("dates")
            if dates:
                ds = [date_to_day(case["day1"], d) for d in dates]
                if ds != [s, e]:
                    raise ValueError(f"{qid}.{side}: dates {dates} は {ds} 日目で、days {[s, e]} と合いません")
            if q["how"] == "last" and s != e:
                raise ValueError(f"{qid}.{side}: last は1日だけの区間 [d, d] で書く")


# ---------------------------------------------------------------------------
# 区間の値と「はい」の確率
# ---------------------------------------------------------------------------

def interval_value(daily: dict, metric: str, how: str, days: list[int]) -> np.ndarray:
    """回ごとの区間の値 (回,)。daily は名前 → (回, 日)。"""
    s, e = int(days[0]), int(days[1])
    if metric == "arpu":
        rev = interval_runs(daily["revenue_jpy"], s, e, "sum")
        pay = interval_runs(daily["paying"], s, e, "mean")
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.where(pay > 0, rev / pay, 0.0)
    series = daily[metric]
    if how == "delta":
        before = max(s - 1, 1)   # 1日目より前の値はないので1日目で代用
        return interval_runs(series, e, e, "last") - interval_runs(series, before, before, "last")
    return interval_runs(series, s, e, how)


def band(v: np.ndarray) -> dict:
    q = np.percentile(v, [10, 50, 90])
    return {"p10": float(q[0]), "p50": float(q[1]), "p90": float(q[2])}


def answer_question(daily: dict, q: dict) -> dict:
    """回ごとに B と A を比べ、「はい」の割合と、両区間の値の範囲を返す（1万人基準）。"""
    va = interval_value(daily, q["metric"], q["how"], q["a"]["days"])
    vb = interval_value(daily, q["metric"], q["how"], q["b"]["days"])
    yes = vb > va if q["direction"] == "greater" else vb < va
    with np.errstate(divide="ignore", invalid="ignore"):
        rel = np.where(va != 0, (vb - va) / np.abs(va), 0.0)
    return {"p_yes": float(np.mean(yes)), "runs": int(len(yes)),
            "a": band(va), "b": band(vb), "b_vs_a_change": band(rel)}


# ---------------------------------------------------------------------------
# 比較の基準
# ---------------------------------------------------------------------------

def baseline_answers(q: dict) -> dict:
    """基準の「はい」の確率（0 か 1）。

    always_up: 指標は常に増える（売上・会員数・単価が増え、純増減も悪くならない）。
    naive:     A〜B の間に値上げか広告減があれば指標は減る、それ以外は増える。
               ただし 1人あたり単価（arpu）は値上げなら増える。
    「増える」は direction greater なら「はい」、less なら「いいえ」。
    """
    def says(up: bool) -> float:
        return 1.0 if (up == (q["direction"] == "greater")) else 0.0

    changes = set(q.get("change_between") or [])
    if q["metric"] == "arpu":
        naive_up = True
    else:
        naive_up = not ({"price_up", "ad_down"} & changes)
    return {"always_up": says(True), "naive": says(naive_up)}


# ---------------------------------------------------------------------------
# エンジン
# ---------------------------------------------------------------------------

def case_app_path(case_id: str, cases_dir: Path = CASES_DIR) -> Path:
    return cases_dir / case_id / "app.yaml"


def simulate_case(app: dict, pop: Population, rules: Rules, decisions: list[dict],
                  personas: dict | None, runs: int, seed: int) -> dict:
    """事例の A 案を runs 回まわし、回ごとの日別系列（mid 回を除く）を返す。"""
    plan = app["plans"][PLAN]
    horizon = int(plan.get("period_days") or 90)
    draws = Draws(seed=seed, runs=runs)
    res = simulate_plan(app, PLAN, pop, rules, draws, decisions, horizon, personas)
    out = {k: np.asarray(v)[:runs] for k, v in res.daily.items() if np.ndim(v) == 2}
    if "paying" not in out:
        raise RuntimeError("エンジンの daily に paying（払い続けている人数）がありません（契約 v2）")
    return out


# ---------------------------------------------------------------------------
# 判断（teppuri.judge.decide）
# ---------------------------------------------------------------------------

def stratified_people(rows: dict[int, dict], ok, n: int | None, seed: int) -> list[dict]:
    """対象者から n 人をクラスターごとの比例で抜き出す（各クラスター最低1人）。n が None なら全員。"""
    people = [r for _, r in sorted(rows.items()) if ok(r)]
    if not n or n >= len(people):
        return people
    by_cluster: dict[str, list[dict]] = defaultdict(list)
    for r in people:
        by_cluster[str(r.get("cluster_id"))].append(r)
    rng = random.Random(seed)
    frac = n / len(people)
    chosen = []
    for cid in sorted(by_cluster):
        members = by_cluster[cid]
        k = max(1, int(round(len(members) * frac)))
        chosen.extend(rng.sample(members, min(k, len(members))))
    return sorted(chosen, key=lambda r: int(r["person_id"]))


def fill_cluster_decisions(decisions: list[dict]) -> list[dict]:
    """人の判断から、クラスターごとの多数決の判断を足す（判断を取っていない人が受け継ぐ）。

    エンジンは person_id の判断を優先し、なければ cluster_id の判断を使う（契約 v2）。
    標本で判断を取ったとき、標本外の人はこのクラスター判断を受け継ぐ。全員で取ったときは
    対象外の人（最低年齢未満・スマホなし。もともと設置しない）にしか効かない。
    """
    groups: dict[tuple, Counter] = defaultdict(Counter)
    for d in decisions:
        if d.get("person_id") is None or d.get("cluster_id") is None:
            continue
        groups[(d["plan"], d["step"], d.get("creative"), int(d["cluster_id"]))][d["level"]] += 1
    filled = [d for d in decisions]
    for (plan, step, creative, cid), cnt in sorted(groups.items(), key=lambda x: str(x[0])):
        top = cnt.most_common()
        level = top[0][0] if len(top) == 1 or top[0][1] > top[1][1] else "similar"   # 同数なら similar
        filled.append({"plan": plan, "step": step, "creative": creative, "cluster_id": cid,
                       "level": level, "reason_ja": "（標本の多数決）", "model": "backtest:majority"})
    return filled


def judge_case(app_path: Path, sample: int | None, seed: int, yes: bool, mock: bool,
               runs_dir: Path, population_dir: Path, out=None) -> tuple[list[dict] | None, dict]:
    """1事例の判断を取る。dry-run（yes も mock もない）なら見積もりだけで (None, 情報)。"""
    from teppuri.judge import common as c
    from teppuri.judge import decide

    out = out or sys.stdout
    app = c.load_app(app_path)
    rows = c.load_population_rows(population_dir)
    if not rows:
        raise RuntimeError(f"人口ファイルがありません: {population_dir}/japan_10k.csv")
    people = stratified_people(rows, lambda r: decide.eligible(app, r), sample, seed)
    info = {"people_judged": len(people), "sampled": bool(sample), "sample_n": sample}
    ctx = c.RunContext(runs_dir, app.app_id, mock=mock, yes=yes, batch=not mock)
    print(f"[{app.app_id}] 判断の対象: {len(people)} 人"
          + (f"（クラスター比例の標本、指定 {sample} 人）" if sample else "（対象者全員）"), file=out)
    decisions = decide.build(app, people, ctx)
    return decisions, info


def estimate_judgments(case_ids: list[str], sample: int | None, seed: int,
                       cases_dir: Path, population_dir: Path, runs_dir: Path, out=None) -> dict:
    """全事例の判断の呼び出し数と費用の見積もり（API は呼ばない）。"""
    from teppuri.judge import common as c
    from teppuri.judge import decide

    out = out or sys.stdout
    rows = c.load_population_rows(population_dir)
    total = {"calls": 0, "usd_with_cache": 0.0, "usd_without_cache": 0.0, "cases": {}}
    for cid in case_ids:
        app = c.load_app(case_app_path(cid, cases_dir))
        people = stratified_people(rows, lambda r: decide.eligible(app, r), sample, seed)
        personas = {}
        pp = runs_dir / app.app_id / "personas.json"
        if pp.exists():
            personas = c.read_json(pp).get("personas", {})
        jobs = decide.build_jobs(app, people, personas)
        cache = c.DiskCache(runs_dir / app.app_id / ".judge_cache" / "real")
        ests = c.estimate_jobs(jobs, cache, batch=True)
        calls = sum(e.calls - e.cached_calls for e in ests)
        w = sum(e.usd_with_cache for e in ests)
        wo = sum(e.usd_without_cache for e in ests)
        total["cases"][cid] = {"people": len(people), "calls": calls,
                               "usd_with_cache": round(w, 3), "usd_without_cache": round(wo, 3)}
        total["calls"] += calls
        total["usd_with_cache"] += w
        total["usd_without_cache"] += wo
        print(f"- {cid}: {len(people)} 人 × 1案 = 呼び出し {calls} 回、推定 ${w:.2f}〜${wo:.2f}（Batch）", file=out)
    print(f"合計: 呼び出し {total['calls']} 回、推定 ${total['usd_with_cache']:.2f}〜"
          f"${total['usd_without_cache']:.2f}（Haiku 5.5、Batch 半額。キャッシュが効いた場合〜効かない場合）", file=out)
    print("dry-run です（API は呼んでいません）。", file=out)
    return total


def load_case_decisions(app_id: str, runs_dir: Path) -> list[dict] | None:
    p = runs_dir / app_id / "decisions.json"
    if not p.exists():
        return None
    with open(p, encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, list) else data.get("decisions", [])


# ---------------------------------------------------------------------------
# predict
# ---------------------------------------------------------------------------

def predict(cases_dir: Path = CASES_DIR, questions_path: Path = QUESTIONS, out_path: Path = PREDICTIONS,
            population: Path = DEFAULT_POPULATION, rules_dir: Path = RULES_DIR, runs: int = 30,
            seed: int = DEFAULT_SEED, judge: str = "none", sample: int | None = None,
            yes: bool = False, runs_dir: Path = JUDGE_RUNS, only: list[str] | None = None,
            log=None) -> dict | None:
    log = log or sys.stderr
    cases, questions = load_questions(questions_path)
    case_ids = [c for c in cases if not only or c in only]
    pop = Population.load(population)
    rules = Rules.load(rules_dir)
    population_dir = Path(population).parent

    # 判断を先に揃える（real で足りない事例があり --yes がなければ、見積もりだけで止める）
    decisions_by_case: dict[str, list[dict]] = {}
    judge_info: dict[str, dict] = {}
    if judge in ("mock", "real"):
        missing = []
        for cid in case_ids:
            app = load_app(case_app_path(cid, cases_dir))
            have = load_case_decisions(app["app_id"], runs_dir) if judge == "real" else None
            if have is None:
                missing.append(cid)
            else:
                decisions_by_case[cid] = have
        if missing and judge == "real" and not yes:
            print("判断がまだない事例があります。費用の見積もり:", file=log)
            estimate_judgments(missing, sample, seed, cases_dir, population_dir, runs_dir, out=log)
            print("実行するには --yes を付けてください。予測は書いていません。", file=log)
            return None
        for cid in missing:
            decs, info = judge_case(case_app_path(cid, cases_dir), sample, seed, yes=yes,
                                    mock=(judge == "mock"), runs_dir=runs_dir,
                                    population_dir=population_dir, out=log)
            if decs is None:
                return None
            decisions_by_case[cid] = decs
            judge_info[cid] = info

    result = {
        "meta": {
            "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
            "runs": runs, "seed": seed, "plan": PLAN,
            "population": str(Path(population).relative_to(REPO_ROOT)) if Path(population).is_relative_to(REPO_ROOT) else str(population),
            "judge": judge,
            "note_ja": "p_yes = エンジンを runs 回まわして「はい」になった回の割合。値は1万人基準。"
                       "baselines は 0/1 の基準（always_up = 常に増える、naive = 値上げ・広告減なら減る）。",
        },
        "cases": {},
        "questions": [],
    }
    qs_by_case: dict[str, list[dict]] = defaultdict(list)
    for q in questions:
        qs_by_case[q["case"]].append(q)

    for cid in case_ids:
        app = load_app(case_app_path(cid, cases_dir))
        decs = decisions_by_case.get(cid, [])
        persons = {d["person_id"] for d in decs if d.get("person_id") is not None}
        filled = fill_cluster_decisions(decs) if decs else []
        personas = load_personas(runs_dir / app["app_id"] / "personas.json") if judge != "none" else {}
        daily = simulate_case(app, pop, rules, filled, personas, runs, seed)
        info = judge_info.get(cid, {})
        result["cases"][cid] = {
            "app_id": app["app_id"],
            "judge": judge if decs else "none",
            "decision_rows": len(decs),
            "people_judged": len(persons),
            "sampled": info.get("sampled", None),
            "personas": len(personas),
        }
        print(f"[{cid}] エンジン {runs}回（判断 {len(decs)}行・{len(persons)}人）", file=log)
        for q in qs_by_case.get(cid, []):
            ans = answer_question(daily, q)
            row = {"id": q["id"], "case": cid, "text_ja": q["text_ja"], "metric": q["metric"],
                   "how": q["how"], "direction": q["direction"],
                   "a_days": q["a"]["days"], "b_days": q["b"]["days"],
                   **ans, "baselines": baseline_answers(q)}
            result["questions"].append(row)
            print(f"  {q['id']}: はいの確率 {ans['p_yes']:.2f}（B/A−1 の中央値 {ans['b_vs_a_change']['p50']:+.3f}）",
                  file=log)

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(f"書き出し: {out_path}", file=log)
    return result


# ---------------------------------------------------------------------------
# score
# ---------------------------------------------------------------------------

def _yes_no(qid: str, v) -> bool:
    if isinstance(v, bool):        # YAML 1.1 では yes/no が真偽値として読まれる
        return v
    s = str(v).strip().lower()
    if s in ("yes", "はい", "true"):
        return True
    if s in ("no", "いいえ", "false"):
        return False
    raise ValueError(f"answers.yaml の {qid} は yes / no: {v}")


def load_answers_full(path: Path = ANSWERS) -> dict[str, dict]:
    """answers.yaml を {Q ID: {"answer": bool, "source_ja"?, "source_url"?}} で読む。

    値は yes / no だけでも、{answer: yes, source_ja: …, source_url: …} でもよい（形式は backtest/README.md）。
    """
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    raw = data.get("answers", data)
    out = {}
    for qid, v in raw.items():
        if isinstance(v, dict):
            row = {"answer": _yes_no(qid, v.get("answer"))}
            for k in ("source_ja", "source_url"):
                if v.get(k):
                    row[k] = str(v[k])
        else:
            row = {"answer": _yes_no(qid, v)}
        out[str(qid)] = row
    return out


def load_answers(path: Path = ANSWERS) -> dict[str, bool]:
    """answers.yaml の Q ID → はい(True) / いいえ(False)。"""
    return {k: v["answer"] for k, v in load_answers_full(path).items()}


def recognized_cases(path: Path = RECOGNITION) -> dict[str, bool] | None:
    """記憶チェックの結果。1回でも「分かった」と答えた事例を「分かった」とする（厳しめ）。"""
    if not Path(path).exists():
        return None
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return {cid: bool(v.get("recognized_any")) for cid, v in (data.get("cases") or {}).items()}


def hit(p: float, y: bool) -> float:
    """的中: 0.5 より大きければ「はい」と答えたとみなす。ちょうど 0.5 は 0.5 点。"""
    if p == 0.5:
        return 0.5
    return 1.0 if (p > 0.5) == y else 0.0


def summarize_scores(rows: list[dict]) -> dict:
    out = {"n": len(rows)}
    for name in ("teppuri", "always_up", "naive"):
        ps = [r["p"][name] for r in rows]
        ys = [r["y"] for r in rows]
        out[name] = {
            "hits": sum(hit(p, y) for p, y in zip(ps, ys)),
            "brier": float(np.mean([(p - float(y)) ** 2 for p, y in zip(ps, ys)])) if rows else None,
        }
    return out


def score(predictions_path: Path = PREDICTIONS, answers_path: Path = ANSWERS,
          recognition_path: Path = RECOGNITION, report_path: Path = REPORT, log=None) -> dict:
    log = log or sys.stderr
    with open(predictions_path, encoding="utf-8") as f:
        pred = json.load(f)
    answers = load_answers(answers_path)
    rec = recognized_cases(recognition_path)

    rows, missing = [], []
    for q in pred["questions"]:
        if q["id"] not in answers:
            missing.append(q["id"])
            continue
        rows.append({"id": q["id"], "case": q["case"], "text_ja": q["text_ja"], "y": answers[q["id"]],
                     "p": {"teppuri": q["p_yes"], **q["baselines"]},
                     "recognized": None if rec is None else rec.get(q["case"])})
    extra = sorted(set(answers) - {q["id"] for q in pred["questions"]})

    groups = {"all": rows}
    if rec is not None:
        groups["recognized"] = [r for r in rows if r["recognized"]]
        groups["not_recognized"] = [r for r in rows if not r["recognized"]]
    summary = {k: summarize_scores(v) for k, v in groups.items()}

    report_path.write_text(render_report(pred, rows, summary, rec, missing, extra), encoding="utf-8")
    print(f"書き出し: {report_path}", file=log)
    s = summary["all"]
    print(f"的中 テプリ {s['teppuri']['hits']}/{s['n']}、常に増える {s['always_up']['hits']}、"
          f"素朴 {s['naive']['hits']}", file=log)
    return {"summary": summary, "missing": missing, "extra": extra}


def _fmt(x) -> str:
    return "—" if x is None else f"{x:.3f}"


def render_report(pred: dict, rows: list[dict], summary: dict, rec: dict | None,
                  missing: list[str], extra: list[str]) -> str:
    m = pred["meta"]
    judged = {cid: c for cid, c in pred.get("cases", {}).items()}
    lines = [
        "# バックテストの結果",
        "",
        "テプリが「方向」を当てられるかの点検です。**この問題数は方法の点検であって、精度の測定ではありません。**"
        "外れた質問も含めて全部を載せます。",
        "",
        f"- 予測の作成: {m['generated_at']}（エンジン {m['runs']}回、シード {m['seed']}、判断: {m['judge']}）",
        "- テプリの値 = 30回のうち「はい」になった回の割合。0.5 より大きければ「はい」と答えたとみなす。",
        "- 基準: **常に増える**（指標はいつも増える）、**素朴**（値上げか広告減の後は減る、それ以外は増える。1人あたり単価は値上げで増える）。どちらも 0 か 1。",
        "- Brier スコア = (確率 − 正解(1/0))² の平均。小さいほど良い。0/1 の基準では「外れ率」と同じ。",
        "",
        "## 判断の取り方",
        "",
        "| 事例 | 判断 | 判断した人数 | 標本か |",
        "|---|---|---|---|",
    ]
    for cid, c in judged.items():
        samp = "—" if c.get("sampled") is None else ("標本（クラスター比例）" if c["sampled"] else "対象者全員")
        lines.append(f"| {cid} | {c['judge']} | {c['people_judged']} | {samp} |")
    lines += ["", "## まとめ", "",
              "| 集計 | 問題数 | テプリ 的中 | テプリ Brier | 常に増える 的中 | 常に増える Brier | 素朴 的中 | 素朴 Brier |",
              "|---|---|---|---|---|---|---|---|"]
    names = {"all": "全体", "recognized": "記憶チェックで「分かった」事例",
             "not_recognized": "「分からなかった」事例"}
    for key, s in summary.items():
        lines.append(f"| {names[key]} | {s['n']} | {s['teppuri']['hits']:g} | {_fmt(s['teppuri']['brier'])} | "
                     f"{s['always_up']['hits']:g} | {_fmt(s['always_up']['brier'])} | "
                     f"{s['naive']['hits']:g} | {_fmt(s['naive']['brier'])} |")
    if rec is None:
        lines += ["", "記憶チェック（`run.py recognize`）はまだ実行していません。"]
    else:
        known = [c for c, v in rec.items() if v]
        lines += ["", f"記憶チェックで「分かった」事例（1回でも分かったと答えた）: {', '.join(known) or 'なし'}。"
                  "分かった事例も外さずに載せ、別に集計しています。"]
    lines += ["", "## 質問ごと", "",
              "| Q ID | 質問 | 正解 | テプリ（はいの確率） | 常に増える | 素朴 | テプリ的中 | 記憶 |",
              "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        recog = "—" if r["recognized"] is None else ("分かった" if r["recognized"] else "分からない")
        lines.append(f"| {r['id']} | {r['text_ja']} | {'はい' if r['y'] else 'いいえ'} | {r['p']['teppuri']:.2f} | "
                     f"{r['p']['always_up']:g} | {r['p']['naive']:g} | "
                     f"{'○' if hit(r['p']['teppuri'], r['y']) == 1 else ('△' if hit(r['p']['teppuri'], r['y']) == 0.5 else '×')} | {recog} |")
    if missing:
        lines += ["", f"正解がまだない質問: {', '.join(missing)}"]
    if extra:
        lines += ["", f"answers.yaml にあって予測にない質問: {', '.join(extra)}"]
    lines += ["", "入力（推定値と根拠）は `backtest/cases/*/app.yaml`、質問の機械可読版は `backtest/questions.yaml`、"
              "手順は `backtest/README.md`。", ""]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# export（Web 表示用 web/public/backtest.json、形は web/src/lib/backtest.ts）
# ---------------------------------------------------------------------------

WEB_BACKTEST = REPO_ROOT / "web" / "public" / "backtest.json"
BASELINE_NAMES = {
    "always_up": "いつも「増える」と答える",
    "naive": "値上げ・広告減なら「減る」、それ以外は「増える」と答える",
}


def export_web(predictions_path: Path = PREDICTIONS, answers_path: Path = ANSWERS,
               recognition_path: Path = RECOGNITION, out_path: Path = WEB_BACKTEST,
               cases_dir: Path = CASES_DIR, prediction_commit: str | None = None, log=None) -> dict:
    """predictions.json（と、あれば answers.yaml・recognition.json）から Web 用の JSON を書く。

    正解がまだない質問は answer: null。基準の hits / brier は正解のある質問だけで数える
    （正解が1つもなければ hits 0、brier なし）。テプリ自身の的中は画面が p_yes と answer から計算する。
    """
    log = log or sys.stderr
    with open(predictions_path, encoding="utf-8") as f:
        pred = json.load(f)
    answers = load_answers_full(answers_path) if Path(answers_path).exists() else {}
    rec = recognized_cases(recognition_path)

    by_case: dict[str, list[dict]] = defaultdict(list)
    for q in pred["questions"]:
        by_case[q["case"]].append(q)

    cases = []
    for cid, qs in by_case.items():
        app = load_app(case_app_path(cid, cases_dir))
        case = {"case_id": cid,
                "title_ja": str(app.get("title_ja") or app.get("name_ja") or cid),
                "description_ja": " ".join(str(app.get("description_ja") or "").split()),
                "questions": []}
        if rec is not None and cid in rec:
            case["recognized"] = rec[cid]
        for q in qs:
            a = answers.get(q["id"])
            row = {"q_id": q["id"], "q_ja": q["text_ja"], "p_yes": q["p_yes"],
                   "answer": None if a is None else a["answer"]}
            if a:
                row.update({k: a[k] for k in ("source_ja", "source_url") if k in a})
            case["questions"].append(row)
        cases.append(case)

    baselines = []
    answered = [q for q in pred["questions"] if q["id"] in answers]
    for bid, name in BASELINE_NAMES.items():
        b = {"id": bid, "name_ja": name,
             "hits": sum(hit(q["baselines"][bid], answers[q["id"]]["answer"]) for q in answered)}
        if answered:
            b["brier"] = float(np.mean([(q["baselines"][bid] - float(answers[q["id"]]["answer"])) ** 2
                                        for q in answered]))
        baselines.append(b)

    m = pred.get("meta", {})
    note = (f"実在の日本のサービス{len(cases)}事例・{len(pred['questions'])}問の方向の点検（名前は伏せています）。"
            f"テプリの値はエンジン{m.get('runs', 30)}回のうち「はい」になった割合。"
            "問題数が少ないので、方法の点検であって精度の測定ではありません。")
    if not answered:
        note += "正解はまだ入れていません。"
    out = {"is_mock": False, "note_ja": note, "prediction_commit": prediction_commit,
           "baselines": baselines, "cases": cases}
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"書き出し: {out_path}（{len(cases)}事例、正解あり {len(answered)}/{len(pred['questions'])}問）", file=log)
    return out


# ---------------------------------------------------------------------------
# recognize
# ---------------------------------------------------------------------------

def recognize(cases_dir: Path = CASES_DIR, questions_path: Path = QUESTIONS, out_path: Path = RECOGNITION,
              trials: int = 3, yes: bool = False, mock: bool = False, runs_dir: Path = JUDGE_RUNS,
              log=None) -> dict | None:
    """各事例の匿名の説明（判断のときに Claude が見たものと同じ app.yaml の内容）を見せて、
    実在のどのサービスか分かるかを聞く（teppuri.judge.decide の recognition_check を使う）。"""
    from teppuri.judge import common as c
    from teppuri.judge import decide

    log = log or sys.stderr
    cases, _ = load_questions(questions_path)
    out = {"generated_at": dt.datetime.now().isoformat(timespec="seconds"), "trials": trials,
           "model": c.MODEL_DECIDE, "rule_ja": "1回でも recognized: true と答えた事例を「分かった」とする", "cases": {}}
    for cid in cases:
        app = c.load_app(case_app_path(cid, cases_dir))
        ctx = c.RunContext(runs_dir, app.app_id, mock=mock, yes=yes, batch=False)
        print(f"[{cid}]", file=log)
        res = decide.recognition_check(app, ctx, trials)
        if res is None:
            continue
        out["cases"][cid] = {"app_id": app.app_id, "recognized_any": res["recognized_any"],
                             "trials": res["trials"]}
    if not out["cases"]:
        print("dry-run です。recognition.json は書いていません。", file=log)
        return None
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"書き出し: {out_path}", file=log)
    return out


# ---------------------------------------------------------------------------
# コマンド
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="テプリ バックテスト")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--cases-dir", default=str(CASES_DIR))
        p.add_argument("--questions", default=str(QUESTIONS))
        p.add_argument("--runs-dir", default=str(JUDGE_RUNS), help="判断の出力先（既定 backtest/runs）")

    pj = sub.add_parser("judge", help="判断を取る（既定は費用見積もりだけ）")
    common(pj)
    pj.add_argument("--sample", type=int, default=None, help="事例ごとに N 人（クラスター比例の標本）。省略で対象者全員")
    pj.add_argument("--seed", type=int, default=DEFAULT_SEED)
    pj.add_argument("--population", default=str(DEFAULT_POPULATION))
    pj.add_argument("--only", nargs="*", default=None, help="事例 ID を絞る")
    pj.add_argument("--yes", action="store_true", help="実際に API を呼ぶ")
    pj.add_argument("--mock", action="store_true", help="API を呼ばずにダミーの判断を作る")

    pp = sub.add_parser("predict", help="エンジンを30回まわして各質問の「はい」の確率を出す")
    common(pp)
    pp.add_argument("--judge", choices=["none", "mock", "real"], default="real",
                    help="none = 判断なし（全て similar）、mock = ダミー、real = Claude（既定）")
    pp.add_argument("--sample", type=int, default=None)
    pp.add_argument("--runs", type=int, default=30)
    pp.add_argument("--seed", type=int, default=DEFAULT_SEED)
    pp.add_argument("--population", default=str(DEFAULT_POPULATION))
    pp.add_argument("--rules", default=str(RULES_DIR))
    pp.add_argument("--out", default=str(PREDICTIONS))
    pp.add_argument("--only", nargs="*", default=None)
    pp.add_argument("--yes", action="store_true", help="判断がない事例は実際に API を呼んで取る")
    pp.add_argument("--dry-run", action="store_true", help="判断の呼び出し数と費用の見積もりだけを出して終わる")

    ps = sub.add_parser("score", help="answers.yaml と比べて report.md を書く")
    ps.add_argument("--predictions", default=str(PREDICTIONS))
    ps.add_argument("--answers", default=str(ANSWERS))
    ps.add_argument("--recognition", default=str(RECOGNITION))
    ps.add_argument("--out", default=str(REPORT))

    pe = sub.add_parser("export", help="Web 表示用の web/public/backtest.json を書く")
    pe.add_argument("--predictions", default=str(PREDICTIONS))
    pe.add_argument("--answers", default=str(ANSWERS))
    pe.add_argument("--recognition", default=str(RECOGNITION))
    pe.add_argument("--cases-dir", default=str(CASES_DIR))
    pe.add_argument("--out", default=str(WEB_BACKTEST))
    pe.add_argument("--prediction-commit", default=None, help="予測を記録したコミットのハッシュ")

    pr = sub.add_parser("recognize", help="記憶チェック（どのサービスか分かるか）")
    common(pr)
    pr.add_argument("--trials", type=int, default=3)
    pr.add_argument("--out", default=str(RECOGNITION))
    pr.add_argument("--yes", action="store_true")
    pr.add_argument("--mock", action="store_true")

    args = ap.parse_args(argv)
    if args.cmd in ("judge",) or (args.cmd == "predict" and args.dry_run):
        cases, _ = load_questions(Path(args.questions))
        ids = [c for c in cases if not args.only or c in args.only]
        if args.cmd == "predict" or not (args.yes or args.mock):
            estimate_judgments(ids, args.sample, args.seed, Path(args.cases_dir),
                               Path(args.population).parent, Path(args.runs_dir))
            return 0
        for cid in ids:
            judge_case(case_app_path(cid, Path(args.cases_dir)), args.sample, args.seed, yes=args.yes,
                       mock=args.mock, runs_dir=Path(args.runs_dir), population_dir=Path(args.population).parent)
        return 0
    if args.cmd == "predict":
        res = predict(Path(args.cases_dir), Path(args.questions), Path(args.out), Path(args.population),
                      Path(args.rules), args.runs, args.seed, args.judge, args.sample, args.yes,
                      Path(args.runs_dir), args.only)
        return 0 if res is not None else 1
    if args.cmd == "score":
        score(Path(args.predictions), Path(args.answers), Path(args.recognition), Path(args.out))
        return 0
    if args.cmd == "export":
        export_web(Path(args.predictions), Path(args.answers), Path(args.recognition), Path(args.out),
                   Path(args.cases_dir), args.prediction_commit)
        return 0
    if args.cmd == "recognize":
        recognize(Path(args.cases_dir), Path(args.questions), Path(args.out), args.trials, args.yes,
                  args.mock, Path(args.runs_dir))
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
