# v1 と v2 を同じ抽選値（同じシード）で回し、回ごとの差を取る。価格だけ変えた中間案も作る。
import copy, json, sys
import numpy as np
from teppuri.engine.inputs import DEFAULT_POPULATION, Population, load_app, load_decisions
from teppuri.engine.rules import Draws, Rules
from teppuri.engine.simulate import simulate_plan
from teppuri.engine.run import DEFAULT_SEED, horizon_of, load_personas, run_dir

S = 9680.6585  # 実行: PYTHONPATH=. .venv/bin/python runs/demo_matching_v2/compare_with_v1.py
pop = Population.load(DEFAULT_POPULATION) if hasattr(Population, "load") else Population(DEFAULT_POPULATION)
rules = Rules.load() if hasattr(Rules, "load") else Rules()

def run(app, dec, per):
    draws = Draws(seed=DEFAULT_SEED, runs=30)
    h = horizon_of(app)
    return {k: simulate_plan(app, k, pop, rules, draws, dec, h, per).totals for k in app["plans"]}

v1 = load_app("apps/demo_matching/app.yaml"); v2 = load_app("apps/demo_matching_v2/app.yaml")
d1 = load_decisions(run_dir("demo_matching") / "decisions.json"); d2 = load_decisions(run_dir("demo_matching_v2") / "decisions.json")
p1 = load_personas(run_dir("demo_matching") / "personas.json"); p2 = load_personas(run_dir("demo_matching_v2") / "personas.json")
mid = copy.deepcopy(v1)  # v1 の判断のまま、価格だけ v2（2,980円）
mid["pricing"] = copy.deepcopy(v2["pricing"])
for k in mid["plans"]:
    if "pricing" in mid["plans"][k]: mid["plans"][k]["pricing"] = copy.deepcopy(v2["plans"][k].get("pricing"))
R = {"v1": run(v1, d1, p1), "price_only": run(mid, d1, p1), "v2": run(v2, d2, p2)}
out = {}
for plan in "AB":
    for m in ["installs", "signups", "core_actions", "payers", "revenue_jpy", "paying_end"]:
        a, b, c = (np.asarray(R[x][plan][m])[:30] * S for x in ["v1", "price_only", "v2"])
        q = lambda x: [round(float(v)) for v in np.percentile(x, [10, 50, 90])]
        out[f"{plan}.{m}"] = {"v1": q(a), "price_only": q(b), "v2": q(c),
                              "v2_minus_v1": q(c - a), "p_v2_better": float(np.mean(c > a)),
                              "price_only_minus_v1": q(b - a), "v2_minus_price_only": q(c - b)}
print(json.dumps(out, ensure_ascii=False, indent=1))
