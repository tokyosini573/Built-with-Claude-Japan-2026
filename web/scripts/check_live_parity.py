"""「ライブで試す」の数字が、ネイティブのエンジンと同じかを確かめる（npm run check-live）。

  ../.venv/bin/python scripts/check_live_parity.py [--runs 10] [--skip-pyodide]

1. 条件を変えないとき: teppuri.engine.live（小さくした判断から戻したもの）と、
   python -m teppuri.engine.run と同じ処理（元の decisions.json・personas.json）が完全に同じか。
2. いくつかの条件で: ネイティブの teppuri.engine.live と、Node の Pyodide（ブラウザと同じ版、
   scripts/live-pyodide-node.mjs）が同じシードで同じ数字を出すか。浮動小数の計算の違い（wasm の libm）で
   丸めの境目がずれることがあるので、完全一致の割合と最大の相対差を出す。

先に npm run build-live で public/live/ を作っておく。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
WEB = REPO / "web"
LIVE = WEB / "public" / "live"
sys.path.insert(0, str(REPO))

from teppuri.engine.inputs import Population, load_app, load_decisions  # noqa: E402
from teppuri.engine.live import LiveSession  # noqa: E402
from teppuri.engine.rules import Rules  # noqa: E402
from teppuri.engine.run import load_personas, run_app  # noqa: E402


def cases(runs: int) -> list[tuple[str, dict]]:
    return [
        ("app.yaml のまま", {"runs": runs}),
        ("首都圏・180日・YouTube と交通広告を追加・価格 2,980円・B案の動画を半分に", {
            "runs": runs, "period_days": 180,
            "plans": {
                "A": {"regions": [11, 12, 13, 14], "campaign_days": 45, "monthly_jpy": 2980,
                      "channels": {"tiktok": 2000000, "instagram": 1000000, "x": 0, "youtube": 1500000,
                                   "transit": 1000000}},
                "B": {"regions": [11, 12, 13, 14], "monthly_jpy": 2980,
                      "organic_video": {"accounts": 5, "posts_per_account_per_day": 0.5, "days": 120,
                                        "cost_per_video_jpy": 2000, "unique_videos_per_account": False}},
            }}),
        ("関西・30日・A案に動画を追加・B案に LINE と大学", {
            "runs": runs, "period_days": 30,
            "plans": {
                "A": {"regions": [25, 26, 27, 28, 29, 30], "campaign_days": 30,
                      "organic_video": {"accounts": 3, "posts_per_account_per_day": 2, "days": 30,
                                        "cost_per_video_jpy": 1050, "unique_videos_per_account": True}},
                "B": {"regions": [25, 26, 27, 28, 29, 30], "organic_video": None, "campaign_days": 20,
                      "channels": {"line": 800000, "offline": 300000}, "free_trial_days": 7},
            }}),
    ]


def strip(replay: dict) -> dict:
    """比べない項目（日時、ライブだけの meta、理由の文を使う項目）を除く。"""
    r = json.loads(json.dumps(replay))
    r["meta"].pop("generated_at", None)
    r["meta"].pop("live", None)
    r["person_decisions"] = []
    for p in r["plans"].values():
        p["drop_reasons"] = []
    return r


def compare(a, b, path="", out=None):
    """数の葉ごとに (一致した数, 全体の数, 最大の相対差, 最大の差の場所, 数以外の違い)。"""
    if out is None:
        out = {"same": 0, "total": 0, "max_rel": 0.0, "where": "", "other": []}
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a) != set(b):
            out["other"].append(f"{path}: キーが違う {sorted(set(a) ^ set(b))[:5]}")
        for k in set(a) & set(b):
            compare(a[k], b[k], f"{path}.{k}", out)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out["other"].append(f"{path}: 長さが違う {len(a)} / {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            compare(x, y, f"{path}[{i}]", out)
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        out["total"] += 1
        if a == b:
            out["same"] += 1
        else:
            rel = abs(a - b) / max(abs(a), abs(b), 1e-12)
            if rel > out["max_rel"]:
                out["max_rel"], out["where"] = rel, path
    elif a != b:
        out["other"].append(f"{path}: {a!r} / {b!r}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=10)
    ap.add_argument("--skip-pyodide", action="store_true")
    args = ap.parse_args()
    if not (LIVE / "manifest.json").exists():
        raise SystemExit("public/live/ がありません。先に npm run build-live")

    ok = True
    session = LiveSession(LIVE)
    all_cases = cases(args.runs)

    # 1. ライブの入口 = python -m teppuri.engine.run と同じ処理
    app = load_app(REPO / "apps" / "demo_matching" / "app.yaml")
    rd = REPO / "runs" / "demo_matching"
    ref = run_app(app, Population.load(), Rules.load(), load_decisions(rd / "decisions.json"),
                  runs=args.runs, personas=load_personas(rd / "personas.json"))
    live = session.run(all_cases[0][1])
    same = json.dumps(strip(ref), sort_keys=True) == json.dumps(strip(live), sort_keys=True)
    print(f"[1] 条件を変えないとき、ライブの入口と engine.run（元の判断 38MB）: {'完全に同じ' if same else '違う'}")
    ok &= same

    # 2. ネイティブ と Pyodide
    native = [session.run(o) for _, o in all_cases]
    if args.skip_pyodide:
        return 0 if ok else 1
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "in.json", Path(tmp) / "out.json"
        src.write_text(json.dumps([o for _, o in all_cases]), encoding="utf-8")
        subprocess.run(["node", str(WEB / "scripts" / "live-pyodide-node.mjs"), str(src), str(dst)],
                       check=True, cwd=WEB)
        pyo = json.loads(dst.read_text(encoding="utf-8"))
    print(f"[2] ネイティブ と Pyodide {pyo['pyodide']}（読み込み {pyo['load_seconds']:.1f}秒）")
    for (name, _), n, p in zip(all_cases, native, pyo["results"]):
        c = compare(strip(n), strip(p["replay"]))
        ev_n = sum(len(pl["sample_run"]["events"]) for pl in n["plans"].values())
        exact = c["same"] == c["total"] and not c["other"]
        print(f"  - {name}（Pyodide {p['seconds']:.1f}秒 / ネイティブ {n['meta']['live']['seconds']:.1f}秒）: "
              f"数 {c['same']}/{c['total']} が完全一致、最大の相対差 {c['max_rel']:.2e}"
              f"{'（' + c['where'] + '）' if c['where'] else ''}、地図のイベント {ev_n}件"
              f"{'、数以外の違い ' + str(len(c['other'])) + '件: ' + '; '.join(c['other'][:3]) if c['other'] else ''}")
        # 有効数字4桁に丸めた値なので、1e-3 を超える差はエンジンの計算が違うとみなす
        ok &= c["max_rel"] <= 1e-3 and not c["other"]
        if exact:
            print("    完全に同じ")
    print("結果: " + ("一致" if ok else "不一致あり"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
