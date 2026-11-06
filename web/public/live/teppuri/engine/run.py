"""コマンド: python -m teppuri.engine.run apps/<id>/app.yaml --runs 30 [--out <path>.json]

人口（契約 §1）、アプリ（§2）、判断（§3、なければ全て similar）、ペルソナ（v1、あれば関心を使う）を読み、
A案・B案を同じ抽選値で runs 回まわして、エンジンの出力を書く。
--out を省くと runs/<app_id>/engine.json（契約 v1）。リプレイへの合成は teppuri.engine.build_replay。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import zlib
from pathlib import Path

from .inputs import DEFAULT_POPULATION, Population, load_app, load_decisions
from .replay import assemble_replay
from .rules import REPO_ROOT, RULES_DIR, Draws, Rules
from .sample import sample_events
from .simulate import simulate_plan

DEFAULT_SEED = 20261108


def run_dir(app_id: str) -> Path:
    return REPO_ROOT / "runs" / str(app_id)


def load_personas(path: Path | str | None) -> dict:
    """runs/<app_id>/personas.json の personas（cluster_id → ペルソナ）。なければ空。"""
    if path is None or not Path(path).exists():
        return {}
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("personas", data) if isinstance(data, dict) else {}


def horizon_of(app: dict) -> int:
    """期間は両案の period_days の長いほう（キャンペーン日数以上）。"""
    days = []
    for plan in app["plans"].values():
        days.append(max(int(plan.get("period_days") or 90), int(plan.get("campaign_days") or 0)))
    return max(days)


def run_app(app: dict, pop: Population, rules: Rules, decisions: list[dict],
            runs: int = 30, seed: int = DEFAULT_SEED, personas: dict | None = None,
            progress=None) -> dict:
    """progress（任意）: 段階ごとに progress(段階, 案) を呼ぶ（Web の「ライブで試す」の進み具合用。結果は変わらない）。"""
    horizon = horizon_of(app)
    draws = Draws(seed=seed, runs=runs)  # A と B で共有する
    results, events = {}, {}
    for key in app["plans"]:
        if progress:
            progress("simulate", str(key))
        res = simulate_plan(app, key, pop, rules, draws, decisions, horizon, personas)
        results[key] = res
        if progress:
            progress("sample", str(key))
        ev_seed = (seed * 31 + zlib.crc32(str(key).encode())) % (2**32)
        events[key] = sample_events(res.sample, pop, ev_seed, horizon)
    if progress:
        progress("assemble", "")
    return assemble_replay(app, pop, results, events, decisions, runs, horizon)


def write_json(obj: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="テプリ 世界エンジン")
    ap.add_argument("app", help="apps/<app_id>/app.yaml")
    ap.add_argument("--runs", type=int, default=30)
    ap.add_argument("--out", default=None, help="出力パス（省略時 runs/<app_id>/engine.json）")
    ap.add_argument("--population", default=str(DEFAULT_POPULATION))
    ap.add_argument("--representatives", default=None)
    ap.add_argument("--decisions", default=None, help="省略時は runs/<app_id>/decisions.json（なければ全て similar）")
    ap.add_argument("--personas", default=None, help="省略時は runs/<app_id>/personas.json（なければ関心は使わない）")
    ap.add_argument("--rules", default=str(RULES_DIR))
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = ap.parse_args(argv)

    t0 = time.time()
    app = load_app(args.app)
    rd = run_dir(app["app_id"])
    pop = Population.load(args.population, args.representatives)
    rules = Rules.load(args.rules)
    decisions = load_decisions(Path(args.decisions) if args.decisions else rd / "decisions.json")
    personas = load_personas(Path(args.personas) if args.personas else rd / "personas.json")
    replay = run_app(app, pop, rules, decisions, runs=args.runs, seed=args.seed, personas=personas)

    out = Path(args.out) if args.out else rd / "engine.json"
    write_json(replay, out)
    dt = time.time() - t0

    print(f"出力: {out}（{dt:.1f}秒、人口 {pop.n}人、{args.runs}回、判断 {len(decisions)}件、"
          f"ペルソナ {len(personas)}人）", file=sys.stderr)
    for key, p in replay["plans"].items():
        t = p["totals"]
        print(f"  {key}: 設置 p50={t['installs']['p50']} [{t['installs']['p10']}〜{t['installs']['p90']}]"
              f" 決済者 p50={t['payers']['p50']} 売上 p50={t['revenue_jpy']['p50']}円（1万人基準）",
              file=sys.stderr)
    if replay.get("comparison"):
        pb = replay["comparison"]["p_B_better"]
        print(f"  B が A より良い確率: 決済者 {pb['payers']}、売上 {pb['revenue_jpy']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
