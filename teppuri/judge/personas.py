"""ペルソナ設計（Opus 5.5、アプリごとに1回）。

app.yaml + 画面・広告画像 + 代表人物（representatives.csv と属性）
→ runs/<app_id>/personas.json

手順:
1. 市場の整理（人の種類 4〜8 個）を1回。
2. 代表人物を CHUNK 人ずつに分けてペルソナを作る。アプリ情報と画像、市場の整理は全チャンク共通なのでキャッシュする。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from string import Template

from . import common as c

CHUNK = 50

OVERVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "market_summary_ja": {"type": "string"},
        "segments": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "segment_id": {"type": "string"},
                "name_ja": {"type": "string"},
                "description_ja": {"type": "string"},
                "typical_attributes_ja": {"type": "string"},
            },
            "required": ["segment_id", "name_ja", "description_ja", "typical_attributes_ja"],
            "additionalProperties": False,
        }},
    },
    "required": ["market_summary_ja", "segments"],
    "additionalProperties": False,
}

CHUNK_SCHEMA = {
    "type": "object",
    "properties": {
        "personas": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "cluster_id": {"type": "integer"},
                "segment_id": {"type": "string"},
                "category_interest": {"type": "string", "enum": ["low", "mid", "high"]},
                "persona_ja": {"type": "string"},
                "motivations_ja": {"type": "array", "items": {"type": "string"}},
                "concerns_ja": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["cluster_id", "segment_id", "category_interest", "persona_ja",
                         "motivations_ja", "concerns_ja"],
            "additionalProperties": False,
        }},
    },
    "required": ["personas"],
    "additionalProperties": False,
}


def overview_job(app: c.App) -> c.Job:
    request = {
        "model": c.MODEL_PERSONA,
        "max_tokens": 16000,
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": "high", **c.json_output(OVERVIEW_SCHEMA)},
        "system": c.load_prompt("personas_system.md"),
        "messages": [{"role": "user", "content": [
            *c.app_context_blocks(app, cache="5m"),
            c.text_block(c.load_prompt("personas_overview.md")),
        ]}],
    }
    mock = {"market_summary_ja": "（モック）市場の整理", "segments": [
        {"segment_id": "interested", "name_ja": "（モック）関心層", "description_ja": "（モック）",
         "typical_attributes_ja": "（モック）"},
        {"segment_id": "indifferent", "name_ja": "（モック）無関心層", "description_ja": "（モック）",
         "typical_attributes_ja": "（モック）"},
    ]}
    return c.Job("personas_overview", request, est_output_tokens=4000, mock_output=mock)


def rep_line(rep: dict) -> str:
    return f"{rep['cluster_id']} | {rep['label_ja']} | {c.attrs_line_ja(rep['attributes'])}"


def chunk_jobs(app: c.App, reps: list[dict], overview: dict | None) -> list[c.Job]:
    """overview が None（dry-run）のときは見積もり用の仮の文章で組み立てる。"""
    overview_text = json.dumps(overview, ensure_ascii=False, indent=1) if overview else "（市場の整理がここに入る）" * 40
    jobs = []
    for i in range(0, len(reps), CHUNK):
        part = reps[i:i + CHUNK]
        body = Template(c.load_prompt("personas_chunk.md")).substitute(
            overview=overview_text, people="\n".join(rep_line(r) for r in part))
        # 市場の整理までを共通の先頭にしたいので、整理の直後で分けてキャッシュ境界を置く
        head, tail = body.split("## 代表人物の一覧", 1)
        request = {
            "model": c.MODEL_PERSONA,
            "max_tokens": 64000,
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": "medium", **c.json_output(CHUNK_SCHEMA)},
            "system": c.load_prompt("personas_system.md"),
            "messages": [{"role": "user", "content": [
                *c.app_context_blocks(app, cache="5m"),
                c.text_block(head, cache="5m"),
                c.text_block("## 代表人物の一覧" + tail),
            ]}],
        }
        mock = {"personas": [mock_persona(r) for r in part]}
        jobs.append(c.Job("personas_chunk", request, est_output_tokens=350 * len(part) + 3000,
                          mock_output=mock, meta={"cluster_ids": [r["cluster_id"] for r in part]}))
    return jobs


def mock_persona(rep: dict) -> dict:
    a = rep["attributes"]
    interest = {"high": "high", "low": "low"}.get(a.get("trait_novelty", ""), "mid")
    return {
        "cluster_id": rep["cluster_id"],
        "segment_id": "interested" if interest != "low" else "indifferent",
        "category_interest": interest,
        "persona_ja": f"（モック）{rep['label_ja']}。{c.attrs_line_ja(a)}",
        "motivations_ja": ["（モック）出会いの機会がほしい"],
        "concerns_ja": ["（モック）個人情報が心配"],
    }


def build(app: c.App, reps: list[dict], ctx: c.RunContext) -> dict | None:
    ov_job = overview_job(app)
    if not ctx.mock and not ctx.yes:
        # dry-run: 2段目は1段目の結果に依存するので、仮の文章で見積もる
        c.run_jobs([ov_job, *chunk_jobs(app, reps, None)], ctx)
        return None
    ov_res = c.run_jobs([ov_job], ctx)
    if not ov_res or ov_job.key not in ov_res:
        raise c.JudgeError("市場の整理に失敗しました")
    overview = ov_res[ov_job.key]["output"]
    jobs = chunk_jobs(app, reps, overview)
    res = c.run_jobs(jobs, ctx) or {}

    by_cluster = {r["cluster_id"]: r for r in reps}
    personas: dict[str, dict] = {}
    models = {ov_res[ov_job.key]["model"]}
    for j in jobs:
        r = res.get(j.key)
        if not r:
            continue
        models.add(r["model"])
        for p in r["output"]["personas"]:
            cid = p["cluster_id"]
            if cid in by_cluster and cid in j.meta["cluster_ids"]:
                # interest はエンジンが広告クリック率の倍率に使う（契約 v1）
                personas[str(cid)] = {**p, "interest": p["category_interest"],
                                      "person_id": by_cluster[cid]["person_id"],
                                      "label_ja": by_cluster[cid]["label_ja"],
                                      "attributes": by_cluster[cid]["attributes"]}
    missing = [r["cluster_id"] for r in reps if str(r["cluster_id"]) not in personas]
    if missing:
        print(f"注意: ペルソナが作られなかった代表人物 {len(missing)} 人（判断では属性だけを使う）: {missing[:20]}")
    out = {
        "app_id": app.app_id,
        "models": sorted(models),
        "market_summary_ja": overview["market_summary_ja"],
        "segments": overview["segments"],
        "personas": personas,
        "missing_cluster_ids": missing,
    }
    c.write_json(ctx.out_dir / "personas.json", out)
    print(f"書き出し: {ctx.out_dir / 'personas.json'}（{len(personas)} 人）")
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="代表人物のペルソナを作る（Opus 5.5）")
    c.add_common_args(ap)
    ap.add_argument("--population-dir", default=str(c.DEFAULT_POPULATION_DIR))
    args = ap.parse_args(argv)
    app = c.load_app(args.app)
    reps = c.load_representatives(Path(args.population_dir))
    ctx = c.RunContext(Path(args.runs_dir), app.app_id, mock=args.mock, yes=args.yes)
    build(app, reps, ctx)


if __name__ == "__main__":
    main()
