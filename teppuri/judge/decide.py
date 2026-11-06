"""一人ひとりの判断（Haiku 5.5、Batch API + プロンプトキャッシュ）。契約 v2。

1人 × 1案 = 1回の呼び出し。1回の出力で、その案の広告素材ごとの install、signup、gate:<id>、
core_action、retention、pay をすべて「このカテゴリの平均と比べて higher / similar / lower」と理由で判断する。

- 先頭（system の指示 + アプリ情報 + 全画面 + 全広告）は全呼び出しで同じ → 1時間キャッシュ。
- 末尾（その人の属性、所属グループのペルソナ要約、案の条件）だけが変わる。
- 出力スキーマは全呼び出しで同じ（キャッシュを壊さないため）。install は広告素材の配列で、
  その案の素材以外は捨てる。
- cluster_id は personas.json を引くためだけに使い、値そのものには依存しない（グループ分けは変わりうる）。
- 判断の分布を decisions_summary.json に出し、偏りを報告する。
- --recognition-check N で「このアプリが何か分かるか」を N 回だけ別に聞く（記憶への対策の確認、バックテスト用）。
"""
from __future__ import annotations

import argparse
import hashlib
import random
from collections import Counter, defaultdict
from pathlib import Path
from string import Template

from . import common as c

# 広告素材を除く段階（gate は app.yaml の宣言による）
STEP_ITEM = {
    "type": "object",
    "properties": {
        "cons_ja": {"type": "string"},
        "pros_ja": {"type": "string"},
        "evidence_kind": {"type": "string", "enum": ["screen", "attribute", "both", "none"]},
        "level": {"type": "string", "enum": c.LEVELS},
        "reason_ja": {"type": "string"},
    },
    # 順番に意味がある: やめる理由 → 進む理由 → 根拠 → 判断
    "required": ["cons_ja", "pros_ja", "evidence_kind", "level", "reason_ja"],
    "additionalProperties": False,
}

RECOGNITION_SCHEMA = {
    "type": "object",
    "properties": {
        "recognized": {"type": "boolean"},
        "guess_ja": {"type": "string"},
        "confidence": {"type": "string", "enum": ["low", "mid", "high"]},
        "clues_ja": {"type": "string"},
    },
    "required": ["recognized", "guess_ja", "confidence", "clues_ja"],
    "additionalProperties": False,
}

# 偏りの警告を出す目安（higher がこれを超えたら「甘すぎる」疑い）
HIGHER_WARN_SHARE = 0.5
EST_OUTPUT_PER_STEP = 130  # 1段階あたりの出力トークン（実測で調整する）


def decision_schema(app: c.App) -> dict:
    """アプリごとに一つ。全案の広告素材 ID を enum に持つ（案ごとに変えるとキャッシュが分かれるため）。"""
    creative_ids = sorted({cid for _, cid, _ in app.creatives()})
    install_item = {
        "type": "object",
        "properties": {"creative": {"type": "string", "enum": creative_ids or ["none"]},
                       **STEP_ITEM["properties"]},
        "required": ["creative", *STEP_ITEM["required"]],
        "additionalProperties": False,
    }
    props: dict = {"install": {"type": "array", "items": install_item}}
    for step in app.steps():
        props[step] = STEP_ITEM
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


def load_personas(out_dir: Path) -> dict[str, dict]:
    p = out_dir / "personas.json"
    if not p.exists():
        print("注意: personas.json がありません。属性だけで判断します（先に personas を実行するのがおすすめ）。")
        return {}
    return c.read_json(p).get("personas", {})


def eligible(app: c.App, row: dict) -> bool:
    """呼び出す対象: 最低年齢以上でスマホを持つ人。対象外の人は判断を出さない（エンジンが扱う）。"""
    try:
        age = int(row.get("age", 0))
    except ValueError:
        return False
    if age < int(app.data.get("min_age") or 0):
        return False
    return str(row.get("has_smartphone", "true")).lower() == "true"


def select_people(app: c.App, rows: dict[int, dict], sample: int | None, seed: int,
                  person_ids: list[int] | None) -> tuple[list[dict], int]:
    """(呼び出す人, 対象外の人数)。sample があれば対象者から固定シードで抜き出す。"""
    if person_ids:
        chosen = [rows[p] for p in person_ids if p in rows]
        return [r for r in chosen if eligible(app, r)], 0
    ok = [r for _, r in sorted(rows.items()) if eligible(app, r)]
    skipped = len(rows) - len(ok)
    if sample and sample < len(ok):
        ok = sorted(random.Random(seed).sample(ok, sample), key=lambda r: int(r["person_id"]))
    return ok, skipped


def _plan_text(plan: dict) -> dict:
    t = plan.get("target") or {}
    return {
        "target": f"年齢 {t.get('age', 'any')} / 性別 {t.get('sex', 'any')}",
        "channels": "、".join((plan.get("channels") or {}).keys()) or "なし",
        "regions": ",".join(str(r) for r in plan.get("regions") or []) or "全国",
        "period": plan.get("period_days", "?"),
    }


def _gates_text(app: c.App) -> str:
    lines = []
    for g in app.data.get("gates", []) or []:
        lines.append(f"- 関門 gate:{g['id']}: {g.get('name_ja', g['id'])}（必要なもの: {g.get('docs_ja', '不明')}、"
                     f"審査の待ち時間: {g.get('review_hours', '不明')} 時間）\n")
    lines.append(f"- 料金: {app.data.get('pricing', {})}\n")
    return "".join(lines)


def build_jobs(app: c.App, people: list[dict], personas: dict[str, dict]) -> list[c.Job]:
    system = c.load_prompt("decide_system.md")
    template = Template(c.load_prompt("decide_person.md"))
    schema = decision_schema(app)
    prefix = c.app_context_blocks(app, cache="1h")
    gates = _gates_text(app)
    creatives_by_plan: dict[str, list[str]] = defaultdict(list)
    for plan_id, cid, _ in app.creatives():
        creatives_by_plan[plan_id].append(cid)
    n_steps_by_plan = {pid: len(creatives_by_plan[pid]) + len(app.steps()) for pid in app.plans()}

    jobs = []
    for plan_id, plan in sorted(app.plans().items()):
        pt = _plan_text(plan)
        for row in people:
            cluster_id = row.get("cluster_id")
            p = personas.get(str(cluster_id), {}) if cluster_id not in (None, "") else {}
            tail = template.substitute(
                person_id=row["person_id"], attrs=c.attrs_line_ja(row) or "（属性なし）",
                persona=p.get("persona_ja", "（なし。属性から考える）"),
                interest=p.get("interest", p.get("category_interest", "不明")),
                plan=plan_id, creatives="、".join(creatives_by_plan[plan_id]) or "なし", gates=gates, **pt,
            )
            request = {
                "model": c.MODEL_DECIDE,
                "max_tokens": 8000,
                "thinking": {"type": "adaptive"},
                "output_config": {"effort": "low", **c.json_output(schema)},
                "system": system,
                "messages": [{"role": "user", "content": [*prefix, c.text_block(tail)]}],
            }
            cid_val = int(cluster_id) if str(cluster_id or "").lstrip("-").isdigit() else None
            jobs.append(c.Job("decide", request, est_output_tokens=EST_OUTPUT_PER_STEP * n_steps_by_plan[plan_id],
                              mock_output=mock_decision(app, creatives_by_plan[plan_id],
                                                        f"{plan_id}-{row['person_id']}"), meta={"plan": plan_id, "person_id": int(row["person_id"]),
                                                      "cluster_id": cid_val,
                                                      "creatives": creatives_by_plan[plan_id]}))
    return jobs


def mock_decision(app: c.App, creatives: list[str], seed: str) -> dict:
    """モック用: その案の広告素材をすべて含む、決定的なダミー出力。"""
    def item(tag: str) -> dict:
        lvl = c.LEVELS[int(hashlib.sha256((seed + tag).encode()).hexdigest(), 16) % 3]
        return {"cons_ja": "（モック）", "pros_ja": "（モック）",
                "evidence_kind": "none" if lvl == "similar" else "attribute", "level": lvl,
                "reason_ja": f"（モック）{tag}"}
    out: dict = {"install": [{"creative": cid, **item(cid)} for cid in creatives]}
    for step in app.steps():
        out[step] = item(step)
    return out


def flatten(job: c.Job, output: dict, model: str, app: c.App) -> list[dict]:
    """1回の出力を契約 v2 の行（段階ごと）に展開する。案の広告素材以外の install は捨てる。"""
    m = job.meta
    base = {"plan": m["plan"], "person_id": m["person_id"], "cluster_id": m["cluster_id"]}
    rows = []
    seen = set()
    for it in output.get("install", []):
        cid = it.get("creative")
        if cid in m["creatives"] and cid not in seen:
            seen.add(cid)
            rows.append({**base, "step": "install", "creative": cid, **_item(it), "model": model})
    for step in app.steps():
        if step in output:
            rows.append({**base, "step": step, "creative": None, **_item(output[step]), "model": model})
    return rows


def _item(it: dict) -> dict:
    return {"level": it["level"], "reason_ja": it["reason_ja"].strip(), "cons_ja": it["cons_ja"],
            "pros_ja": it["pros_ja"], "evidence_kind": it["evidence_kind"]}


CONTRACT_KEYS = ("plan", "step", "creative", "person_id", "cluster_id", "level", "reason_ja", "model")


def step_sort_key(d: dict) -> tuple:
    base = d["step"].split(":", 1)[0]
    return (d["plan"], d["person_id"], c.STEP_ORDER.index(base), d["step"], d["creative"] or "")


def summarize(details: list[dict], expected_rows: int, skipped_people: int) -> dict:
    """判断の分布（コードが数えた件数）と偏りの警告。"""
    by_group: dict[str, Counter] = defaultdict(Counter)
    total: Counter = Counter()
    numeric = no_evidence = 0
    for d in details:
        g = f"{d['plan']}|{d['step']}" + (f"|{d['creative']}" if d["creative"] else "")
        by_group[g][d["level"]] += 1
        total[d["level"]] += 1
        numeric += int(bool(c.NUMERIC_IN_REASON.search(d["reason_ja"])))
        no_evidence += int(d["level"] != "similar" and d["evidence_kind"] == "none")
    n = sum(total.values()) or 1
    warnings = []
    if total["higher"] / n > HIGHER_WARN_SHARE:
        warnings.append("higher が半分を超えています。判断が甘く偏っている可能性があります。")
    if total["similar"] == n:
        warnings.append("すべて similar です。判断が情報を使えていない可能性があります。")
    if numeric:
        warnings.append(f"理由に数字が入った判断が {numeric} 件あります（数字はエンジンだけが作る決まり）。")
    if no_evidence:
        warnings.append(f"根拠なしの higher/lower が {no_evidence} 件あります。")
    if len(details) < expected_rows:
        warnings.append(f"判断が欠けています: {len(details)}/{expected_rows} 行（欠けた分はエンジンが cluster 判断か similar で補う）。")
    return {
        "people": len({d["person_id"] for d in details}),
        "rows": len(details),
        "skipped_people_not_eligible": skipped_people,
        "total": dict(total),
        "by_group": {k: dict(v) for k, v in sorted(by_group.items())},
        "warnings": warnings,
    }


def build(app: c.App, people: list[dict], ctx: c.RunContext, skipped_people: int = 0,
          limit: int | None = None) -> list[dict] | None:
    personas = load_personas(ctx.out_dir)
    jobs = build_jobs(app, people, personas)
    if limit:
        jobs = jobs[:limit]
    res = c.run_jobs(jobs, ctx)
    if res is None:
        return None
    details = []
    expected = 0
    for j in jobs:
        expected += len(j.meta["creatives"]) + len(app.steps())
        r = res.get(j.key)
        if r:
            details.extend(flatten(j, r["output"], r["model"], app))
    details.sort(key=step_sort_key)
    decisions = [{k: d[k] for k in CONTRACT_KEYS} for d in details]
    summary = summarize(details, expected, skipped_people)
    c.write_json(ctx.out_dir / "decisions.json", decisions)
    c.write_json(ctx.out_dir / "decisions_detail.json", details)
    c.write_json(ctx.out_dir / "decisions_summary.json", summary)
    print(f"書き出し: {ctx.out_dir / 'decisions.json'}（{summary['people']} 人、{len(decisions)} 行）")
    print(f"判断の分布: {summary['total']}")
    for w in summary["warnings"]:
        print(f"警告: {w}")
    return decisions


# --- 記憶の確認 -------------------------------------------------------------
def recognition_jobs(app: c.App, n: int) -> list[c.Job]:
    prefix = c.app_context_blocks(app, cache="1h")
    jobs = []
    for i in range(n):
        # 同じ質問はキャッシュで1回にまとまるので、試行番号を末尾に入れて別の呼び出しにする
        request = {
            "model": c.MODEL_DECIDE,
            "max_tokens": 4000,
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": "low", **c.json_output(RECOGNITION_SCHEMA)},
            "system": "あなたはアプリ市場に詳しい調査員です。",
            "messages": [{"role": "user", "content": [
                *prefix, c.text_block(c.load_prompt("recognition.md") + f"\n\n（試行 {i + 1}）")]}],
        }
        jobs.append(c.Job("recognition", request, est_output_tokens=300, meta={"trial": i + 1}))
    return jobs


def recognition_check(app: c.App, ctx: c.RunContext, n: int) -> dict | None:
    jobs = recognition_jobs(app, n)
    res = c.run_jobs(jobs, ctx)
    if res is None:
        return None
    trials = [{**j.meta, **res[j.key]["output"], "model": res[j.key]["model"]} for j in jobs if j.key in res]
    out = {"app_id": app.app_id, "trials": trials,
           "recognized_any": any(t["recognized"] for t in trials)}
    c.write_json(ctx.out_dir / "recognition_check.json", out)
    print(f"書き出し: {ctx.out_dir / 'recognition_check.json'}（分かったと答えた試行: "
          f"{sum(t['recognized'] for t in trials)}/{len(trials)}）")
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="一人ひとりの判断を作る（Haiku 5.5、1人×1案=1回）")
    c.add_common_args(ap)
    ap.add_argument("--population-dir", default=str(c.DEFAULT_POPULATION_DIR))
    ap.add_argument("--sample", type=int, default=None, help="対象者から N 人だけ（固定シードで抜き出す）")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--person-ids", default=None, help="カンマ区切りで人を指定")
    ap.add_argument("--sync", action="store_true", help="Batch API を使わず1件ずつ呼ぶ（少数の動作確認用）")
    ap.add_argument("--limit", type=int, default=None, help="先頭 N 回の呼び出しだけ（動作確認用）")
    ap.add_argument("--recognition-check", type=int, default=0, metavar="N",
                    help="判断の代わりに「このアプリが何か分かるか」を N 回だけ聞く")
    args = ap.parse_args(argv)
    app = c.load_app(args.app)
    ctx = c.RunContext(Path(args.runs_dir), app.app_id, mock=args.mock, yes=args.yes, batch=not args.sync)
    if args.recognition_check:
        ctx.batch = False
        recognition_check(app, ctx, args.recognition_check)
        return
    rows = c.load_population_rows(Path(args.population_dir))
    if not rows:
        raise c.JudgeError(f"人口ファイルがありません: {args.population_dir}/japan_10k.csv")
    ids = [int(x) for x in args.person_ids.split(",")] if args.person_ids else None
    people, skipped = select_people(app, rows, args.sample, args.seed, ids)
    print(f"対象: {len(people)} 人 × {len(app.plans())} 案（最低年齢未満・スマホなしで対象外: {skipped} 人）")
    build(app, people, ctx, skipped, limit=args.limit)


if __name__ == "__main__":
    main()
