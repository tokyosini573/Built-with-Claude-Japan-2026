"""Web の「ライブで試す」（#/live）用の入口。ブラウザの Pyodide で、このエンジンをそのまま回す。

- 判断は事前に取ったもの（decisions.json）を使い、Claude は呼ばない。38MB あるので、
  人 × 案 × 段階 × 素材の level だけを小さな形にして配り（compact_decisions）、エンジンに渡す前に
  元の形に戻す（expand_decisions）。理由の文は持たない（数字には使われないため）。
- 画面で変えた条件を app.yaml の plan に当てて（apply_overrides）、run.run_app と同じ処理で回す。
- このモジュールは既存の計算を変えない。条件を何も変えなければ、python -m teppuri.engine.run と同じ数字になる
  （web/scripts/check_live_parity.py で確かめる）。

コマンド（ネイティブで同じ計算をする。Pyodide の結果との比較用）:
  python -m teppuri.engine.live --root web/public/live --overrides o.json --out out.json
"""

from __future__ import annotations

import argparse
import copy
import json
import time
from pathlib import Path

from .inputs import Population, load_app
from .rules import Rules
from .run import DEFAULT_SEED, run_app

LEVEL_CODE = {"higher": "h", "similar": "s", "lower": "l"}
CODE_LEVEL = {v: k for k, v in LEVEL_CODE.items()}
NO_DECISION = "-"

PERIODS = (30, 90, 180, 365)
MAX_RUNS = 30
# 動画を判断の素材なしで足すときの既定（app.yaml のどの案にも organic_video が無いとき）
VIDEO_DEFAULTS = {"platforms": ["tiktok", "instagram", "youtube"], "accounts": 10,
                  "posts_per_account_per_day": 1, "start_day": 1, "days": 50,
                  "cost_per_video_jpy": 1050, "unique_videos_per_account": True}
VIDEO_EDITABLE = ("accounts", "posts_per_account_per_day", "days", "cost_per_video_jpy",
                  "unique_videos_per_account")


# ---------------------------------------------------------------------------
# 判断を小さくする / 戻す
# ---------------------------------------------------------------------------

def compact_decisions(decisions: list[dict], app_id: str = "") -> dict:
    """人単位の判断を「列（案, 段階, 素材）ごとに、人の順に level を1文字で並べた文字列」にする。

    エンジンは (案, 段階, 人) ごとの判断の並び順を使う（素材の無い案の install は最初の判断を使う）ので、
    列の順は元のファイルに出てきた順にし、どの人も同じ順であることを確かめる。
    """
    columns: list[tuple] = []
    col_index: dict[tuple, int] = {}
    per_person: dict[int, dict[int, str]] = {}
    cluster_of: dict[int, int] = {}
    order_of: dict[int, list[int]] = {}
    for d in decisions:
        if d.get("person_id") is None:
            raise ValueError("cluster 単位の判断はこの形にできません（契約 v2 の人単位の判断だけ）")
        col = (str(d["plan"]), str(d["step"]), d.get("creative"))
        if col not in col_index:
            col_index[col] = len(columns)
            columns.append(col)
        ci = col_index[col]
        pid = int(d["person_id"])
        if ci in per_person.setdefault(pid, {}):
            raise ValueError(f"同じ人・案・段階・素材の判断が2つあります: {col} person {pid}")
        per_person[pid][ci] = LEVEL_CODE.get(d.get("level"), "s")
        order_of.setdefault(pid, []).append(ci)
        if d.get("cluster_id") is not None:
            cluster_of[pid] = int(d["cluster_id"])
    for pid, order in order_of.items():
        if order != sorted(order):
            raise ValueError(f"person {pid} の判断の並び順が列の順と違います")
    pids = sorted(per_person)
    levels = ["".join(per_person[p].get(ci, NO_DECISION) for p in pids) for ci in range(len(columns))]
    return {
        "format": "teppuri-live-decisions-v1",
        "app_id": app_id,
        "note_ja": "decisions.json の level だけ（理由の文は無し）。列ごとに person_ids の順で h=higher / s=similar / l=lower / -=判断なし",
        "person_ids": pids,
        "cluster_ids": [cluster_of.get(p) for p in pids],
        "columns": [{"plan": c[0], "step": c[1], "creative": c[2]} for c in columns],
        "levels": levels,
    }


def expand_decisions(compact: dict) -> list[dict]:
    """compact_decisions の逆。人ごとに列の順で並べる（元のファイルと同じ並び）。reason_ja は空。"""
    cols = compact["columns"]
    levels = compact["levels"]
    out: list[dict] = []
    for i, pid in enumerate(compact["person_ids"]):
        cid = compact["cluster_ids"][i]
        for ci, col in enumerate(cols):
            code = levels[ci][i]
            if code == NO_DECISION:
                continue
            out.append({"plan": col["plan"], "step": col["step"], "creative": col["creative"],
                        "person_id": pid, "cluster_id": cid, "level": CODE_LEVEL[code], "reason_ja": ""})
    return out


def compact_personas(personas: dict) -> dict:
    """personas.json のうちエンジンが使う interest だけ（cluster_id → {interest}）。"""
    out = {}
    for cid, p in personas.items():
        lvl = p.get("interest") or p.get("category_interest")
        if lvl:
            out[str(cid)] = {"interest": lvl}
    return out


# ---------------------------------------------------------------------------
# 画面の条件 → app.yaml
# ---------------------------------------------------------------------------

def _video_template(app: dict) -> dict:
    for plan in app["plans"].values():
        if plan.get("organic_video"):
            t = copy.deepcopy(plan["organic_video"])
            t.pop("creative_ids", None)   # 判断の素材は元の案のものなので、ほかの案には持ち込まない
            return {**VIDEO_DEFAULTS, **t}
    return dict(VIDEO_DEFAULTS)


def editable_defaults(app: dict) -> dict:
    """画面の初期値（app.yaml の値）。apply_overrides に渡す形と同じ。"""
    plans = {}
    for key, plan in app["plans"].items():
        pricing = {**(app.get("pricing") or {}), **(plan.get("pricing") or {})}
        ov = plan.get("organic_video")
        plans[key] = {
            "campaign_days": int(plan.get("campaign_days") or 0),
            "regions": list(plan.get("regions") or []),
            "channels": {k: float(v) for k, v in (plan.get("channels") or {}).items()},
            "monthly_jpy": float(pricing.get("monthly_jpy") or 0),
            "free_trial_days": int(pricing.get("free_trial_days") or 0),
            "organic_video": ({k: ov.get(k, VIDEO_DEFAULTS.get(k)) for k in VIDEO_EDITABLE} if ov else None),
            "creatives": [Path(str(c)).stem for c in plan.get("creatives") or []],
            "video_creatives": list((ov or {}).get("creative_ids") or []),
        }
    period = max(int(p.get("period_days") or 90) for p in app["plans"].values())
    return {"period_days": period, "runs": 10, "plans": plans,
            "video_template": {k: _video_template(app)[k] for k in VIDEO_EDITABLE}}


def apply_overrides(app: dict, overrides: dict, channel_names: set[str] | None = None) -> dict:
    """画面で変えた条件を app.yaml（dict）に当てたコピーを返す。素材（creatives / creative_ids）は変えない。

    overrides = {"period_days": 90, "plans": {"A": {"campaign_days", "regions", "channels",
                 "monthly_jpy", "free_trial_days", "organic_video": null | {...}}}}
    書いていない項目は app.yaml のまま。期間は両案に同じ値を入れる（エンジンは長いほうの期間で両案を回すため）。
    """
    app = copy.deepcopy(app)
    period = overrides.get("period_days")
    if period is not None:
        period = int(period)
        if period not in PERIODS:
            raise ValueError(f"期間は {PERIODS} のどれか: {period}")
    template = _video_template(app)
    for key, plan in app["plans"].items():
        if period is not None:
            plan["period_days"] = period
        o = (overrides.get("plans") or {}).get(key) or {}
        horizon = int(plan.get("period_days") or 90)
        if "campaign_days" in o:
            plan["campaign_days"] = max(0, min(int(o["campaign_days"]), horizon))
        if "regions" in o:
            regions = sorted({int(r) for r in o["regions"] or []})
            if any(r < 1 or r > 47 for r in regions):
                raise ValueError(f"pref_code は 1〜47: {regions}")
            plan["regions"] = regions
        if "channels" in o:
            ch = {}
            for name, yen in (o["channels"] or {}).items():
                if channel_names is not None and name not in channel_names:
                    raise ValueError(f"未知のチャネル: {name}")
                if float(yen) > 0:
                    ch[str(name)] = float(yen)
            plan["channels"] = ch
        pricing = dict(plan.get("pricing") or {})
        if "monthly_jpy" in o:
            pricing["monthly_jpy"] = max(0.0, float(o["monthly_jpy"]))
        if "free_trial_days" in o:
            pricing["free_trial_days"] = max(0, int(o["free_trial_days"]))
        if pricing:
            plan["pricing"] = pricing
        if "organic_video" in o:
            ov = o["organic_video"]
            if not ov:
                plan.pop("organic_video", None)
            else:
                base = copy.deepcopy(plan.get("organic_video") or template)
                for k in VIDEO_EDITABLE:
                    if k in ov:
                        base[k] = ov[k]
                base["accounts"] = max(0, int(base["accounts"]))
                base["posts_per_account_per_day"] = max(0.0, float(base["posts_per_account_per_day"]))
                base["days"] = max(0, min(int(base["days"]), horizon))
                base["cost_per_video_jpy"] = max(0.0, float(base["cost_per_video_jpy"]))
                base["unique_videos_per_account"] = bool(base["unique_videos_per_account"])
                plan["organic_video"] = base
    return app


# ---------------------------------------------------------------------------
# 実行
# ---------------------------------------------------------------------------

class LiveSession:
    """入力を一度だけ読み、条件を変えて何度でも回す。root はリポジトリと同じ並びのフォルダ
    （teppuri/engine, rules, data/population, apps/<id>/app.yaml, runs/<id>/decisions_levels.json,
    runs/<id>/personas_interest.json）。"""

    def __init__(self, root: Path | str, app_id: str = "demo_matching"):
        root = Path(root)
        self.root = root
        self.app = load_app(root / "apps" / app_id / "app.yaml")
        self.pop = Population.load(root / "data" / "population" / "japan_10k.csv",
                                   root / "data" / "population" / "representatives.csv")
        self.rules = Rules.load(root / "rules")
        rd = root / "runs" / app_id
        with open(rd / "decisions_levels.json", encoding="utf-8") as f:
            self.decisions = expand_decisions(json.load(f))
        with open(rd / "personas_interest.json", encoding="utf-8") as f:
            self.personas = json.load(f)
        self.channel_names = set(self.rules.channels["online"]) | {"transit", "offline"}

    def run(self, overrides: dict | None = None, seed: int = DEFAULT_SEED, progress=None) -> dict:
        overrides = overrides or {}
        runs = max(1, min(int(overrides.get("runs") or 10), MAX_RUNS))
        app = apply_overrides(self.app, overrides, self.channel_names)
        t0 = time.time()
        replay = run_app(app, self.pop, self.rules, self.decisions, runs=runs, seed=seed,
                         personas=self.personas, progress=progress)
        # 理由の文は持っていないので、理由を使う項目は空にする（画面は「事前計算のデモだけ」と出す）
        replay["person_decisions"] = []
        for p in replay["plans"].values():
            p["drop_reasons"] = []
        replay["meta"]["live"] = {"seconds": round(time.time() - t0, 2), "overrides": overrides}
        return replay

    def run_json(self, overrides_json: str, progress=None) -> str:
        return json.dumps(self.run(json.loads(overrides_json), progress=progress),
                          ensure_ascii=False, separators=(",", ":"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="ライブで試す（ネイティブで同じ計算）")
    ap.add_argument("--root", required=True, help="web/public/live")
    ap.add_argument("--overrides", default=None, help="条件の JSON ファイル（省略時は app.yaml のまま）")
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    overrides = {}
    if args.overrides:
        with open(args.overrides, encoding="utf-8") as f:
            overrides = json.load(f)
    replay = LiveSession(args.root).run(overrides)
    Path(args.out).write_text(json.dumps(replay, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
