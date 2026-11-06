"""事前インタビュー（Sonnet 5.5）。

公開サイトはリアルタイムに Claude を呼ばず、ここで作った質問と答えだけを表示する（設計 4-1）。
エンジンの出力 runs/<app_id>/engine.json の sample_run に出てくる代表人物から、案ごとに数人を選び、
その人の記録（属性・ペルソナ・この回で起きたこと・その人のグループの判断）だけを根拠に答えさせる。

出力: runs/<app_id>/interviews.json（契約 §4 の interviews 配列と同じ形）。
リプレイには直接書かない。合成はエンジン担当の build_replay が行う（契約 v1）。
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from pathlib import Path
from string import Template

from . import common as c

PEOPLE_COLS = ["person_id", "pref_code", "city_size", "age", "sex", "cluster_id"]

# 契約 v1 のイベント名 → インタビューの記録に書く言葉
STEP_JA = {"install": "インストールした", "signup": "会員登録した", "core_action": "初めて核となる行動をした",
           "trial": "無料体験を始めた", "pay": "支払った", "churn": "使うのをやめた"}


def step_ja(step: str) -> str:
    if step.startswith("gate:"):
        return f"関門（{step.split(':', 1)[1]}）を通過した"
    return STEP_JA.get(step, step)


def answer_schema(n: int) -> dict:
    props = {f"a{i}": {"type": "string"} for i in range(1, n + 1)}
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


def events_by_person(engine_out: dict, plan: str) -> dict[int, list[tuple[int, str]]]:
    """契約 v1: events は [person_id, day, step, n]（v0 の3要素も読める）。n はこの人が表す人数なので使わない。"""
    out: dict[int, list[tuple[int, str]]] = defaultdict(list)
    for ev in engine_out["plans"].get(plan, {}).get("sample_run", {}).get("events", []):
        pid, day, step = ev[0], ev[1], ev[2]
        out[int(pid)].append((int(day), str(step)))
    for v in out.values():
        v.sort()
    return out


def pick_people(engine_out: dict, plan: str, per_plan: int) -> list[int]:
    """代表人物のうち、この回に何か起きた人から選ぶ。先に進んだ人と早く離れた人が両方入るように並べて間引く。"""
    reps = {int(cl["representative"]) for cl in engine_out.get("clusters", [])}
    evs = events_by_person(engine_out, plan)
    # 進んだ段階の数（churn は除く）が多い順
    cands = sorted((p for p in evs if p in reps), key=lambda p: (-len({e for _, e in evs[p] if e != "churn"}), p))
    if len(cands) <= per_plan:
        return cands
    step = (len(cands) - 1) / (per_plan - 1) if per_plan > 1 else 0
    return sorted({cands[round(i * step)] for i in range(per_plan)}, key=cands.index)


def person_record(person_id: int, plan: str, engine_out: dict, pop_rows: dict[int, dict],
                  personas: dict[str, dict], decisions: list[dict], app: c.App | None) -> tuple[str, int | None]:
    people = {int(r[0]): dict(zip(PEOPLE_COLS, r)) for r in engine_out.get("people", [])}
    row = people.get(person_id, {})
    cluster_id = row.get("cluster_id")
    attrs = pop_rows.get(person_id) or row
    lines = [f"- 属性: {c.attrs_line_ja(attrs) or attrs}"]
    p = personas.get(str(cluster_id), {})
    if p:
        lines.append(f"- ペルソナ: {p.get('persona_ja', '')}")
    if app:
        lines.append(f"- 見たアプリ: {app.data.get('name_ja', app.app_id)}（{app.data.get('description_ja', '')}）"
                     f" / 料金: {app.data.get('pricing', {})}")
    evs = events_by_person(engine_out, plan).get(person_id, [])
    if evs:
        lines.append("- この回のシミュレーションで起きたこと: " + "、".join(f"{d}日目に{step_ja(e)}" for d, e in evs))
    else:
        lines.append("- この回のシミュレーションで起きたこと: なし（広告を見ていない）")
    # 契約 v2: 判断は一人ずつ。その人の判断が無ければ所属グループの判断を使う
    mine = [d for d in decisions if d["plan"] == plan and d.get("person_id") == person_id]
    whose = "あなたの判断"
    if not mine:
        mine = [d for d in decisions if d["plan"] == plan and d.get("person_id") is None
                and d.get("cluster_id") == cluster_id]
        whose = "あなたのグループの判断"
    if mine:
        lines.append(f"- {whose}（同じカテゴリの平均と比べて）:")
        for d in mine:
            label = d["step"] + (f"（広告 {d['creative']}）" if d.get("creative") else "")
            lines.append(f"  - {label}: {d['level']} — {d['reason_ja']}")
    return "\n".join(lines), cluster_id


def build_jobs(engine_out: dict, app: c.App | None, pop_rows: dict[int, dict], personas: dict[str, dict],
               decisions: list[dict], per_plan: int) -> list[c.Job]:
    questions = c.load_prompt_yaml("interview_questions.yaml")
    q_text = "\n".join(f"{i}. {q}" for i, q in enumerate(questions, 1))
    system = c.load_prompt("interview_system.md")
    jobs = []
    for plan in sorted(engine_out.get("plans", {})):
        for pid in pick_people(engine_out, plan, per_plan):
            record, _ = person_record(pid, plan, engine_out, pop_rows, personas, decisions, app)
            user = Template(c.load_prompt("interview_user.md")).substitute(record=record, questions=q_text)
            request = {
                "model": c.MODEL_INTERVIEW,
                "max_tokens": 8000,
                "thinking": {"type": "adaptive"},
                "output_config": {"effort": "low", **c.json_output(answer_schema(len(questions)))},
                "system": [c.text_block(system)],
                "messages": [{"role": "user", "content": user}],
            }
            jobs.append(c.Job("interview", request, est_output_tokens=900,
                              meta={"person_id": pid, "plan": plan, "questions": questions}))
    return jobs


def build(engine_path: Path, app: c.App | None, ctx: c.RunContext, population_dir: Path,
          per_plan: int = 4) -> list[dict] | None:
    engine_out = c.read_json(engine_path)
    personas = c.read_json(ctx.out_dir / "personas.json")["personas"] if (ctx.out_dir / "personas.json").exists() else {}
    decisions = c.read_json(ctx.out_dir / "decisions.json") if c.json_exists(ctx.out_dir / "decisions.json") else []
    jobs = build_jobs(engine_out, app, c.load_population_rows(population_dir), personas, decisions, per_plan)
    res = c.run_jobs(jobs, ctx)
    if res is None:
        return None
    interviews = []
    for j in jobs:
        r = res.get(j.key)
        if not r:
            continue
        qs = j.meta["questions"]
        interviews.append({"person_id": j.meta["person_id"], "plan": j.meta["plan"],
                           "qa": [{"q_ja": q, "a_ja": r["output"][f"a{i}"]} for i, q in enumerate(qs, 1)]})
    c.write_json(ctx.out_dir / "interviews.json", interviews)
    print(f"書き出し: {ctx.out_dir / 'interviews.json'}（{len(interviews)} 人）")
    return interviews


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="事前インタビューを作る（Sonnet 5.5）")
    c.add_common_args(ap)
    ap.add_argument("--engine", default=None, help="エンジンの出力（既定: runs/<app_id>/engine.json）")
    ap.add_argument("--population-dir", default=str(c.DEFAULT_POPULATION_DIR))
    ap.add_argument("--per-plan", type=int, default=4)
    args = ap.parse_args(argv)
    app = c.load_app(args.app)
    ctx = c.RunContext(Path(args.runs_dir), app.app_id, mock=args.mock, yes=args.yes)
    engine = Path(args.engine) if args.engine else ctx.out_dir / "engine.json"
    build(engine, app, ctx, Path(args.population_dir), args.per_plan)


if __name__ == "__main__":
    main()
