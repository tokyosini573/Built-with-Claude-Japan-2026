# ちかくにの対照実験3つ（t5 / m8 / q3）を v1 と同じ抽選値（同じシード）で回し、回ごとの差を取る。
# runs/demo_matching_v2/compare_with_v1.py を広げたもの。エンジン・ルール・判断のコードは変えずに呼ぶだけ。
# 実行: PYTHONPATH=. .venv/bin/python runs/controls/compare_controls.py  → runs/controls/compare_controls.json
#
# - t5 = v2 の名札を外したコピー（ブラインド v2）、m8 = 見た目だけ変えた版（プラセボ）、q3 = 悪くした版
# - 価格などエンジンに直接効く数字が変わった版（t5, q3）は、v1 の判断のままその数字だけ変えた中間も回す
# - totals の各配列は runs+1 行（最後の1行は中央の回）なので [:30] で切る
import collections, copy, json
from pathlib import Path
import numpy as np
from teppuri.engine.inputs import DEFAULT_POPULATION, Population, load_app, load_decisions
from teppuri.engine.rules import Draws, Rules
from teppuri.engine.simulate import simulate_plan
from teppuri.engine.run import DEFAULT_SEED, horizon_of, load_personas, run_dir

S = 9680.6585
RUNS = 30
METRICS = ["installs", "signups", "core_actions", "payers", "revenue_jpy", "paying_end"]
OUT = Path(__file__).with_name("compare_controls.json")

pop = Population.load(DEFAULT_POPULATION) if hasattr(Population, "load") else Population(DEFAULT_POPULATION)
rules = Rules.load() if hasattr(Rules, "load") else Rules()


def run(app, dec, per):
    draws = Draws(seed=DEFAULT_SEED, runs=RUNS)
    h = horizon_of(app)
    return {k: {m: np.asarray(simulate_plan(app, k, pop, rules, draws, dec, h, per).totals[m])[:RUNS] * S
                for m in METRICS} for k in app["plans"]}


def load(app_id):
    dec = load_decisions(run_dir(app_id) / "decisions.json")
    # 判断ファイルが無いと load_decisions は黙って空（全員 similar）を返すので、ここで止める
    assert len(dec) > 10000, f"{app_id} の判断が読めない（{len(dec)}件）"
    return (load_app(f"apps/{app_id}/app.yaml"), dec, load_personas(run_dir(app_id) / "personas.json"))


def q(x):
    return [round(float(v)) for v in np.percentile(x, [10, 50, 90])]


def with_engine_inputs(base, src, gates=False):
    """base（v1）の判断のまま、src の価格（と gates の review_hours）だけ入れたアプリ。"""
    mid = copy.deepcopy(base)
    mid["pricing"] = copy.deepcopy(src["pricing"])
    for k in mid["plans"]:
        if "pricing" in mid["plans"][k] or "pricing" in src["plans"][k]:
            mid["plans"][k]["pricing"] = copy.deepcopy(src["plans"][k].get("pricing"))
    if gates:
        by_id = {g["id"]: g for g in src.get("gates") or []}
        for g in mid.get("gates") or []:
            if g["id"] in by_id:
                g["review_hours"] = by_id[g["id"]]["review_hours"]
    return mid


def diff_table(a, b):
    """b − a を回ごとに。a, b は run() の結果。"""
    out = {}
    for plan in a:
        for m in METRICS:
            x, y = a[plan][m], b[plan][m]
            out[f"{plan}.{m}"] = {"base": q(x), "variant": q(y), "diff": q(y - x),
                                  "median_diff": round(float(np.median(y) - np.median(x))),
                                  "p_better": round(float(np.mean(y > x)), 3),
                                  "p_worse": round(float(np.mean(y < x)), 3)}
    return out


def level_dist(decs):
    """案・段階ごとの判断の割合（install は広告素材ごとの判断をまとめて数える）。"""
    c = collections.defaultdict(collections.Counter)
    for d in decs:
        c[f"{d['plan']}.{d['step']}"][d["level"]] += 1
    out = {}
    for k in sorted(c):
        n = sum(c[k].values())
        out[k] = {"n": n, **{lv: round(c[k][lv] / n, 4) for lv in ("higher", "similar", "lower")}}
    return out


V1 = "demo_matching"
VARIANTS = {
    "demo_matching_t5": {"role_ja": "v2 の名札を外したコピー（ブラインド v2）", "intermediates": {"price_only": False}},
    "demo_matching_m8": {"role_ja": "見た目だけ変えた版（プラセボ）", "intermediates": {}},
    "demo_matching_q3": {"role_ja": "v1 の離脱理由に逆らって悪くした版", "intermediates": {"price_only": False, "engine_inputs_only": True}},
}

a1, d1, p1 = load(V1)
R1 = run(a1, d1, p1)

# 確認: v1 の中央値が公開リプレイ（web/public/replays/demo_matching.json）と同じになるか
rep = json.loads(Path("web/public/replays/demo_matching.json").read_text(encoding="utf-8"))
sanity = {}
for plan in "AB":
    for m in METRICS:
        here = float(np.median(R1[plan][m]))
        there = float(rep["plans"][plan]["totals"][m]["p50"]) * S
        sanity[f"{plan}.{m}"] = {"this_script_p50": round(here, 1), "replay_p50": round(there, 1),
                                 "match": bool(abs(here - there) <= max(1.0, 0.002 * abs(there)))}

out = {"meta": {"note_ja": "日本全体に換算した人数・円。diff は回ごとの (対照 − v1) の p10/p50/p90、"
                           "median_diff は中央値どうしの差、p_better は対照が v1 を上回った回の割合（同じ抽選値の30回）。",
                "runs": RUNS, "seed": DEFAULT_SEED, "base": V1},
       "sanity_v1_vs_replay": sanity,
       "v1_levels": level_dist(d1),
       "variants": {}}

for vid, spec in VARIANTS.items():
    av, dv, pv = load(vid)
    Rv = run(av, dv, pv)
    entry = {"role_ja": spec["role_ja"], "n_decisions": len(dv),
             "engine_inputs": {"monthly_jpy": av["pricing"].get("monthly_jpy"),
                               "review_hours": [g.get("review_hours") for g in av.get("gates") or []]},
             "vs_v1": diff_table(R1, Rv), "levels": level_dist(dv), "intermediates": {}}
    # 設置（広告）の段階の判断だけをこの版のものに差し替え、ほかの段階は v1 の判断のまま（v1 のアプリ・価格で回す）
    hybrid = [d for d in d1 if d["step"] != "install"] + [d for d in dv if d["step"] == "install"]
    entry["install_judgments_only_vs_v1"] = {
        "desc_ja": "v1 のアプリ・判断のまま、install の段階の判断だけこの版のものにした場合（広告の判断の効き目）",
        "table": diff_table(R1, run(a1, hybrid, p1))}
    for name, gates in spec["intermediates"].items():
        Rm = run(with_engine_inputs(a1, av, gates=gates), d1, p1)
        entry["intermediates"][name] = {
            "desc_ja": "v1 の判断のまま、価格" + ("と審査時間" if gates else "") + "だけこの版の値にした中間",
            "mid_vs_v1": diff_table(R1, Rm),        # エンジンに直接効く分
            "variant_vs_mid": diff_table(Rm, Rv),   # 判断の変化の分（新しい数字への反応も含む）
        }
    out["variants"][vid] = entry

# ブラインド v2 と名札つき v2 の直接比較（名札だけの違い）
if Path(run_dir("demo_matching_v2") / "decisions.json").exists():
    a2, d2, p2 = load("demo_matching_v2")
    out["labeled_v2_vs_blind_t5"] = {
        "desc_ja": "variant = 名札つき v2（demo_matching_v2）、base = 名札なしコピー（t5）。中身は同じで app_id だけ違う",
        "table": diff_table(run(*load("demo_matching_t5")), run(a2, d2, p2))}

OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"書き出し: {OUT}")
print("v1 とリプレイの一致:", all(v["match"] for v in sanity.values()))
for vid, e in out["variants"].items():
    print(f"\n== {vid}: {e['role_ja']}")
    for k, v in e["vs_v1"].items():
        print(f"  {k:16s} v1 {v['base'][1]:>10,}  対照 {v['variant'][1]:>10,}  差 {v['diff']}  P(良い) {v['p_better']:.2f}")
