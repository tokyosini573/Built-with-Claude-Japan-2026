"""レポートと離脱理由のテーマ（Opus 5.5）。

数字を Claude に書かせないために:
1. コードがエンジンの出力 runs/<app_id>/engine.json から「事実の表」（ID → 値）を作る。値はエンジンの数字をそのまま整形したもの。
2. Claude は本文に数字を書かず、{{ID}} で表を引用する（JSON スキーマで出力を強制）。
3. コードが検査する: 数字の直書きがない / 知らない ID がない。違反なら1回だけ書き直させる。
4. コードが {{ID}} を値に置き換える。最後に「本文の数字はすべて事実の表の値」であることを確かめる。

出力: runs/<app_id>/report.json（report_ja・drop_themes・事実の表・置き換え前の文章）。形は README を参照。
リプレイには直接書かない。合成はエンジン担当の build_replay が行う（契約 v1）。
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from string import Template

from . import common as c

PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z0-9_.:\-]+)\s*\}\}")
DIGITS = re.compile(r"[0-9０-９]")
KANJI_NUM = re.compile(r"[一二三四五六七八九十百千万億]+\s*(割|%|％|パーセント|人|倍|件|円|日|ポイント)")
ALLOWED_KANJI = ("一万人",)
NUMBER_TOKEN = re.compile(r"\d[\d,]*(?:\.\d+)?")

REPORT_SCHEMA = {
    "type": "object",
    "properties": {
        "headline_ja": {"type": "string"},
        "report_ja": {"type": "string"},
        "themes": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "theme_ja": {"type": "string"},
                "plan": {"type": "string"},
                "step": {"type": "string"},
                "drop_reason_ids": {"type": "array", "items": {"type": "string"}},
                "summary_ja": {"type": "string"},
            },
            "required": ["theme_ja", "plan", "step", "drop_reason_ids", "summary_ja"],
            "additionalProperties": False,
        }},
    },
    "required": ["headline_ja", "report_ja", "themes"],
    "additionalProperties": False,
}

METRIC_JA = {"impressions": "広告表示", "installs": "インストール", "signups": "会員登録",
             "core_actions": "核となる行動", "active": "アクティブ", "active_end": "最終日のアクティブ",
             "payers": "課金者（期間中に一度でも決済）", "revenue_jpy": "売上（円）", "reached": "広告が届いた人数",
             "spend_jpy": "費用（広告費・制作費、円）", "installs_ad": "広告経由のインストール", "installs_wom": "口コミ経由のインストール",
             "trials": "無料体験", "cpi_jpy": "インストール単価（円）", "roas": "ROAS"}


def pct(x: float) -> str:
    """0〜1 の値を百分率で表示（エンジンの値の表示形を変えるだけ）。"""
    v = x * 100
    return f"{v:.0f}%" if abs(v) >= 1 or v == 0 else f"{v:.1f}%"


def fmt(v) -> str:
    """エンジンの値の表示形。整数はカンマ区切り、小数は小数第1位まで。"""
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, int) or (isinstance(v, float) and v.is_integer() and abs(v) >= 1):
        return f"{int(round(v)):,}"
    if isinstance(v, float):
        return f"{v:,.1f}" if abs(v) >= 1 else f"{v:.3g}"
    return str(v)


# 日本全体に換算しない項目（単価・比率）
NOT_SCALED = {"cpi_jpy", "roas"}


def japan_value(v: float, scale: float) -> str:
    """1万人基準の件数・人数・円を日本全体に換算した表示（× scale_to_japan）。

    整数に丸め、1,000 以上は有効数字3桁にする（エンジンの値は有効数字4桁ほどなので、それより細かい桁は意味がない）。
    """
    x = int(round(v * scale))
    if abs(x) >= 1000:
        digits = len(str(abs(x))) - 3
        x = int(round(x, -digits))
    return f"{x:,}"


def build_facts(engine_out: dict) -> tuple[dict[str, dict], list[dict]]:
    """(facts, drops)。facts は ID → {"value": 表示文字列, "label": 説明}。"""
    facts: dict[str, dict] = {}
    meta = engine_out.get("meta", {})
    for k in ("period_days", "runs", "population"):
        if k in meta:
            facts[f"meta.{k}"] = {"value": fmt(meta[k]), "label": {"period_days": "期間（日）", "runs": "実行回数",
                                                                   "population": "人口（人）"}[k]}
    scale = meta.get("scale_to_japan")
    drops = []
    for plan_id, plan in sorted(engine_out.get("plans", {}).items()):
        for metric, q in (plan.get("totals") or {}).items():
            if not isinstance(q, dict):
                continue
            for pk in ("p10", "p50", "p90"):
                if pk in q:
                    if scale and metric not in NOT_SCALED:
                        facts[f"{plan_id}.japan.{metric}.{pk}"] = {
                            "value": japan_value(q[pk], scale),
                            "label": f"{plan_id}案 {METRIC_JA.get(metric, metric)} {pk}（日本全体換算）"}
                    facts[f"{plan_id}.totals.{metric}.{pk}"] = {
                        "value": fmt(q[pk]), "label": f"{plan_id}案 {METRIC_JA.get(metric, metric)} {pk}（一万人あたり）"}
        for i, d in enumerate(plan.get("drop_reasons") or []):
            did = f"{plan_id}.dr{i}"
            share = d.get("share")
            if share is not None:
                facts[f"{did}.share"] = {"value": pct(share),
                                         "label": f"{plan_id}案 {d.get('step')} の離脱理由 {did} の割合"}
            drops.append({"id": did, "plan": plan_id, **d})
    # 案の比較（エンジンが同じ回どうしの差から計算したもの。契約 v1 の comparison）
    cmp = engine_out.get("comparison") or {}
    for metric, q in (cmp.get("B_minus_A") or {}).items():
        for pk in ("p10", "p50", "p90"):
            if pk in q:
                if scale and metric not in NOT_SCALED:
                    facts[f"cmp.japan.B_minus_A.{metric}.{pk}"] = {
                        "value": japan_value(q[pk], scale),
                        "label": f"B案−A案 {METRIC_JA.get(metric, metric)} の差 {pk}（同じ回どうし、日本全体換算）"}
                facts[f"cmp.B_minus_A.{metric}.{pk}"] = {
                    "value": fmt(q[pk]), "label": f"B案−A案 {METRIC_JA.get(metric, metric)} の差 {pk}（同じ回どうし）"}
    for metric, v in (cmp.get("p_B_better") or {}).items():
        facts[f"cmp.p_B_better.{metric}"] = {"value": pct(v),
                                             "label": f"{METRIC_JA.get(metric, metric)} でB案がA案を上回った回の割合"}
    return facts, drops


def validate_template(text: str, facts: dict[str, dict]) -> list[str]:
    """置き換え前の文章を検査する。問題の一覧を返す（空なら合格）。"""
    problems = []
    unknown = sorted({m for m in PLACEHOLDER.findall(text) if m not in facts})
    if unknown:
        problems.append(f"事実の表にない ID: {unknown}")
    bare = PLACEHOLDER.sub("", text)
    if DIGITS.search(bare):
        problems.append(f"数字が直接書かれています: {sorted(set(DIGITS.findall(bare)))[:10]}")
    stripped = bare
    for ok in ALLOWED_KANJI:
        stripped = stripped.replace(ok, "")
    if KANJI_NUM.search(stripped):
        problems.append(f"漢数字の割合・人数などがあります: {KANJI_NUM.findall(stripped)[:5]}")
    return problems


def render(text: str, facts: dict[str, dict]) -> str:
    return PLACEHOLDER.sub(lambda m: facts[m.group(1)]["value"], text)


def numbers_not_in_facts(text: str, facts: dict[str, dict]) -> list[str]:
    """最終文章の数字のうち、事実の表の値に含まれないもの（テストと最終確認で使う）。"""
    allowed = set()
    for f in facts.values():
        allowed.update(NUMBER_TOKEN.findall(f["value"]))
    return [n for n in NUMBER_TOKEN.findall(text) if n not in allowed]


def build_job(engine_out: dict, app: c.App | None, facts: dict, drops: list[dict],
              feedback: tuple[dict, list[str]] | None = None) -> c.Job:
    facts_text = "\n".join(f"- {k} = {v['value']}（{v['label']}）" for k, v in facts.items())
    drops_text = "\n".join(f"- {d['id']}: {d.get('step')} / cluster {d.get('cluster_id')} / 割合 {{{{{d['id']}.share}}}}"
                           f" / {d.get('reason_ja', '')}" for d in drops) or "（なし）"
    app_text = c.app_summary_ja(app) if app else json.dumps(engine_out.get("meta", {}), ensure_ascii=False)
    user = Template(c.load_prompt("report_user.md")).substitute(app=app_text, facts=facts_text, drops=drops_text)
    messages = [{"role": "user", "content": user}]
    if feedback:
        prev, problems = feedback
        messages += [
            {"role": "assistant", "content": json.dumps(prev, ensure_ascii=False)},
            {"role": "user", "content": "次の問題があるので、同じ形式で書き直してください: " + " / ".join(problems)},
        ]
    request = {
        "model": c.MODEL_REPORT,
        "max_tokens": 32000,
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": "high", **c.json_output(REPORT_SCHEMA)},
        "system": c.load_prompt("report_system.md"),
        "messages": messages,
    }
    return c.Job("report", request, est_output_tokens=6000, mock_output=mock_report(facts, drops))


def mock_report(facts: dict, drops: list[dict]) -> dict:
    ids = [k for k in facts if k.endswith(".installs.p50")]
    body = "## 結論\n（モック）" + "、".join(f"{k.split('.')[0]}案のインストールは中央値 {{{{{k}}}}}" for k in ids) + "でした。"
    return {"headline_ja": "（モック）差ははっきりしない", "report_ja": body,
            "themes": [{"theme_ja": "（モック）手間", "plan": d["plan"], "step": str(d.get("step")),
                        "drop_reason_ids": [d["id"]], "summary_ja": "（モック）"} for d in drops[:3]]}


def build(engine_path: Path, app: c.App | None, ctx: c.RunContext) -> dict | None:
    engine_out = c.read_json(engine_path)
    facts, drops = build_facts(engine_out)
    job = build_job(engine_out, app, facts, drops)
    res = c.run_jobs([job], ctx)
    if res is None:
        return None
    out = res[job.key]["output"]
    model = res[job.key]["model"]
    problems = validate_template(out["headline_ja"] + "\n" + out["report_ja"]
                                 + "\n".join(t["summary_ja"] for t in out["themes"]), facts)
    if problems:
        print(f"検査で問題: {problems} → 1回だけ書き直させます")
        job2 = build_job(engine_out, app, facts, drops, feedback=(out, problems))
        res2 = c.run_jobs([job2], ctx)
        out = res2[job2.key]["output"]
        problems = validate_template(out["headline_ja"] + "\n" + out["report_ja"]
                                     + "\n".join(t["summary_ja"] for t in out["themes"]), facts)
        if problems:
            c.write_json(ctx.out_dir / "report_rejected.json", {"output": out, "problems": problems})
            raise c.JudgeError(f"レポートが検査に通りません: {problems}")
    drop_ids = {d["id"] for d in drops}
    themes = []
    for t in out["themes"]:
        ids = [i for i in t["drop_reason_ids"] if i in drop_ids]
        themes.append({**t, "drop_reason_ids": ids, "summary_ja": render(t["summary_ja"], facts)})
    report_ja = render(out["headline_ja"], facts) + "\n\n" + render(out["report_ja"], facts)
    extra = numbers_not_in_facts(report_ja, facts)
    if extra:  # 置き換え後に表にない数字が残ることはないはずだが念のため
        raise c.JudgeError(f"表にない数字が残っています: {extra}")
    result = {"app_id": engine_out.get("meta", {}).get("app_id"), "model": model,
              "headline_ja": render(out["headline_ja"], facts), "report_ja": report_ja,
              "drop_themes": themes, "facts": facts, "template": out}
    c.write_json(ctx.out_dir / "report.json", result)
    print(f"書き出し: {ctx.out_dir / 'report.json'}")
    return result


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="レポートと離脱理由のテーマを作る（Opus 5.5）")
    c.add_common_args(ap)
    ap.add_argument("--engine", default=None, help="エンジンの出力（既定: runs/<app_id>/engine.json）")
    args = ap.parse_args(argv)
    app = c.load_app(args.app)
    ctx = c.RunContext(Path(args.runs_dir), app.app_id, mock=args.mock, yes=args.yes)
    build(Path(args.engine) if args.engine else ctx.out_dir / "engine.json", app, ctx)


if __name__ == "__main__":
    main()
