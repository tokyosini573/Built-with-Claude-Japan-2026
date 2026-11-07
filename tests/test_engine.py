"""世界エンジンのテスト。小さな合成人口（tests/fixtures/engine/）で動かす。"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import numpy as np
import pytest

from teppuri.engine.inputs import Population, load_app
from teppuri.engine.rules import Draws, Rules, fit_exponentials, fitted_curve, retention_curve, split_uniform
from teppuri.engine.run import main, run_app
from teppuri.engine.simulate import simulate_plan

FIX = Path(__file__).parent / "fixtures" / "engine"
RUNS = 8


@pytest.fixture(scope="module")
def pop():
    return Population.load(FIX / "population_small.csv")


@pytest.fixture(scope="module")
def rules():
    return Rules.load()


@pytest.fixture()
def app():
    return load_app(FIX / "app.yaml")


def sim(app, pop, rules, plan="A", decisions=None, runs=RUNS, seed=1, horizon=None):
    draws = Draws(seed=seed, runs=runs)
    h = horizon or int(app["plans"][plan]["period_days"])
    return simulate_plan(app, plan, pop, rules, draws, decisions or [], h)


# ---------------------------------------------------------------------------
# ルール
# ---------------------------------------------------------------------------

def _walk(node, path=""):
    if isinstance(node, dict):
        if {"low", "mid", "high"} <= set(node) and not isinstance(node["low"], dict):
            yield path, node
        for k, v in node.items():
            yield from _walk(v, f"{path}.{k}")


def test_every_rule_value_has_source(rules):
    """全ての値に source があり、範囲が low <= mid <= high（交通・傾向の係数表は除く）。"""
    for doc in (rules.presets, rules.channels, rules.multipliers):
        for path, node in _walk(doc):
            if ".traits." in path:
                continue
            assert "source" in node, path
            assert node["low"] <= node["mid"] <= node["high"], path
            if node["source"] == "assumption":
                assert node.get("note"), f"assumption には理由が必要: {path}"


def test_split_uniform_median_is_mid():
    spec = {"low": 1.0, "mid": 2.0, "high": 10.0}
    assert split_uniform(spec, np.array([0.5]))[0] == pytest.approx(2.0)
    assert split_uniform(spec, np.array([0.0]))[0] == pytest.approx(1.0)
    assert split_uniform(spec, np.array([1.0]))[0] == pytest.approx(10.0)


def test_retention_fit_is_close():
    """近似曲線は出典のある点（D1・D7・D30）を5%以内で通り、単調に減る。"""
    for d1, d7, d30 in [(0.26, 0.15, 0.09), (0.26, 0.15, 0.027), (0.12, 0.05, 0.02), (0.18, 0.10, 0.07)]:
        curve = retention_curve(d1, d7, d30, 366)
        approx = fitted_curve(fit_exponentials(curve), 367)
        for day, target in [(0, 1.0), (1, d1), (7, d7), (30, d30)]:
            assert approx[day] == pytest.approx(target, rel=0.05)
        assert (np.diff(approx) <= 1e-12).all()
        assert approx[365] > 0


# ---------------------------------------------------------------------------
# 広告
# ---------------------------------------------------------------------------

def test_zero_budget_gives_zero_installs(app, pop, rules):
    app["plans"]["A"]["channels"] = {"instagram": 0, "tiktok": 0}
    res = sim(app, pop, rules)
    assert res.totals["installs_ad"].max() == 0
    assert res.totals["installs"].max() == 0      # 利用者がいなければクチコミも0
    assert res.totals["impressions"].max() == 0


def test_installs_increase_with_budget(app, pop, rules):
    prev = None
    for budget in [1e5, 1e6, 5e6, 2e7, 1e8]:
        a = copy.deepcopy(app)
        a["plans"]["A"]["channels"] = {"instagram": budget}
        inst = sim(a, pop, rules).totals["installs"]
        if prev is not None:
            assert (inst > prev).all()
        prev = inst


def test_no_ads_outside_campaign(app, pop, rules):
    res = sim(app, pop, rules)
    camp = app["plans"]["A"]["campaign_days"]
    assert res.daily["impressions"][:, camp:].max() == 0
    assert res.daily["installs_ad"][:, camp:].max() == 0
    assert res.daily["impressions"][:, :camp].min() > 0


def test_ads_do_not_reach_outside_regions(app, pop, rules):
    res = sim(app, pop, rules)
    outside = ~np.isin(pop.pref, app["plans"]["A"]["regions"])
    assert outside.any()
    assert res.person["installs"][outside].max() == 0
    assert res.person["reached"][outside].max() == 0
    assert res.person["installs"][~outside].sum() > 0


def test_under_min_age_never_installs(app, pop, rules):
    app["plans"]["A"]["target"] = {"age": [15, 79], "sex": "any"}
    res = sim(app, pop, rules)
    young = pop.age < app["min_age"]
    assert young.any()
    assert res.person["installs"][young].max() == 0


def test_target_sex(app, pop, rules):
    app["plans"]["A"]["target"] = {"age": [20, 34], "sex": "F"}
    app["plans"]["A"]["channels"] = {"instagram": 3e6}
    res = sim(app, pop, rules)
    assert res.person["reached"][pop.male].max() == 0


def test_transit_and_offline_reach(app, pop, rules):
    plan = app["plans"]["A"]
    plan["regions"] = []
    plan["channels"] = {"offline": 5e6}
    res = sim(app, pop, rules)
    student = (pop.employment == "student") & (pop.age >= 18) & (pop.age <= 29)
    assert res.person["reached"][~student].max() == 0
    assert res.person["reached"][student].max() > 0
    plan["channels"] = {"transit": 5e6}
    res = sim(app, pop, rules)
    non_commuter = np.isin(pop.employment, ["retired", "unemployed_homemaker"])
    assert res.person["reached"][non_commuter].max() == 0
    assert res.totals["installs_ad"].min() > 0


# ---------------------------------------------------------------------------
# クチコミ
# ---------------------------------------------------------------------------

def test_wom_never_exceeds_market(app, pop, rules):
    r = copy.deepcopy(rules)
    r.multipliers["wom"]["q_per_active_day"] = {"low": 5.0, "mid": 5.0, "high": 5.0, "source": "test"}
    app["plans"]["A"]["channels"] = {"instagram": 5e7}
    res = sim(app, pop, r, horizon=365)
    plan = app["plans"]["A"]
    eligible = pop.smartphone & (pop.age >= app["min_age"]) & np.isin(pop.pref, plan["regions"])
    market_basis = (pop.weight * eligible).sum() / pop.scale
    assert (res.totals["installs"] <= market_basis * (1 + 1e-9)).all()
    assert res.totals["installs"].max() > 0.5 * market_basis   # 強いクチコミなら市場に近づく
    assert (res.person["installs"] <= 1 + 1e-9).all()
    # 市場が埋まるにつれてクチコミの設置は減る
    wom = res.daily["installs_wom"][-1]
    assert wom[-30:].sum() < wom[30:60].sum()


# ---------------------------------------------------------------------------
# 判断・再現性・A/B の公平さ
# ---------------------------------------------------------------------------

def _all_clusters(pop, plan, step, level, creative=None):
    return [{"plan": plan, "step": step, "creative": creative, "cluster_id": int(c), "level": level,
             "reason_ja": "テスト"} for c in np.unique(pop.cluster)]


def test_higher_decision_beats_similar(app, pop, rules):
    base = sim(app, pop, rules)
    for step, key in [("install", "installs"), ("signup", "signups"), ("pay", "payers")]:
        dec = _all_clusters(pop, "A", step, "higher", creative="a1")
        hi = sim(app, pop, rules, decisions=dec)
        lo = sim(app, pop, rules, decisions=_all_clusters(pop, "A", step, "lower", creative="a1"))
        assert (hi.totals[key] > base.totals[key]).all(), step
        assert (lo.totals[key] < base.totals[key]).all(), step


def test_same_seed_same_result(app, pop, rules, tmp_path):
    r1 = run_app(app, pop, rules, [], runs=RUNS, seed=42)
    r2 = run_app(app, pop, rules, [], runs=RUNS, seed=42)
    r3 = run_app(app, pop, rules, [], runs=RUNS, seed=43)
    for r in (r1, r2, r3):
        r["meta"].pop("generated_at")
    assert json.dumps(r1, sort_keys=True) == json.dumps(r2, sort_keys=True)
    assert json.dumps(r1["plans"], sort_keys=True) != json.dumps(r3["plans"], sort_keys=True)


def test_identical_plans_get_identical_results(app, pop, rules):
    """A と B は同じ回で同じ抽選値を使う。同じ中身の案なら結果も同じ。"""
    app["plans"]["B"] = copy.deepcopy(app["plans"]["A"])
    r = run_app(app, pop, rules, [], runs=RUNS, seed=5)
    assert r["plans"]["A"]["totals"] == r["plans"]["B"]["totals"]


def test_density_helps_matching(app, pop, rules):
    """特別規則: 同じ予算なら、地域を絞って相手側を集めたほうが初マッチの率が高い。"""
    a = copy.deepcopy(app)
    a["plans"]["A"]["regions"] = [13]
    a["plans"]["A"]["target"] = {"age": [20, 39], "sex": "any"}
    narrow = sim(a, pop, rules)
    a["plans"]["A"]["regions"] = []
    wide = sim(a, pop, rules)
    rate_n = narrow.totals["core_actions"] / narrow.totals["gate:id_verification"]
    rate_w = wide.totals["core_actions"] / wide.totals["gate:id_verification"]
    assert (rate_n > rate_w).all()


def test_longer_review_loses_people(app, pop, rules):
    fast = sim(app, pop, rules)
    app["gates"][0]["review_hours"] = 96
    slow = sim(app, pop, rules)
    assert (slow.totals["gate:id_verification"] < fast.totals["gate:id_verification"]).all()


# ---------------------------------------------------------------------------
# 他のプリセット
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("preset,pricing", [
    ("subscription", {"monthly_jpy": 980, "free_trial_days": 7}),
    ("subscription", {"monthly_jpy": 980, "free_trial_days": 0}),
    ("habit", {"monthly_jpy": 480, "free_trial_days": 0}),
    ("habit", {"monthly_jpy": 480, "free_trial_days": 14}),
    ("shopping", {"order_jpy": 4000}),
    ("shopping", {}),
])
def test_other_presets_run(app, pop, rules, preset, pricing):
    app["preset"] = preset
    app["gates"] = []
    app["min_age"] = 15
    app["pricing"] = pricing
    res = sim(app, pop, rules)
    for k, v in res.totals.items():
        assert np.isfinite(v).all() and (v >= 0).all(), k
    assert res.totals["payers"].min() > 0
    assert res.totals["revenue_jpy"].min() > 0
    trial = pricing.get("free_trial_days", 0)
    if preset in ("subscription", "habit") and trial > 0:
        assert res.daily["new_payers"][:, :trial].max() == 0   # 体験が終わるまで決済なし
    if preset == "habit" and trial == 0:
        assert res.daily["new_payers"][:, :7].max() == 0       # 7日目の決済画面まで決済なし


def test_free_app_has_no_revenue(app, pop, rules):
    app["pricing"] = {"monthly_jpy": 0}
    res = sim(app, pop, rules)
    assert res.totals["revenue_jpy"].max() == 0


def test_higher_price_fewer_payers(app, pop, rules):
    cheap = sim(app, pop, rules)
    app["pricing"]["monthly_jpy"] = 9800
    pricey = sim(app, pop, rules)
    assert (pricey.totals["payers"] < cheap.totals["payers"]).all()


# ---------------------------------------------------------------------------
# 出力（契約 §4）
# ---------------------------------------------------------------------------

def test_replay_contract(app, pop, rules, tmp_path):
    out = tmp_path / "replay.json"
    dec = tmp_path / "decisions.json"
    dec.write_text(json.dumps(_all_clusters(pop, "A", "signup", "lower")), encoding="utf-8")
    assert main([str(FIX / "app.yaml"), "--runs", "5", "--out", str(out),
                 "--population", str(FIX / "population_small.csv"), "--decisions", str(dec)]) == 0
    r = json.loads(out.read_text(encoding="utf-8"))
    assert set(r) == {"meta", "plans", "comparison", "people", "person_decisions", "clusters", "interviews",
                      "report_ja"}
    m = r["meta"]
    assert m["runs"] == 5 and m["population"] == 10000 and m["period_days"] == 90
    assert m["scale_to_japan"] == pytest.approx(9680.6585)
    assert m["extrapolated_after_day"] == 90
    assert m["gates"] == [{"id": "id_verification", "name_ja": "本人確認"}]
    kinds_ok = {"install", "signup", "gate:id_verification", "core_action", "pay", "churn", "trial"}
    for key in ("A", "B"):
        p = r["plans"][key]
        assert p["daily"]["day"] == list(range(1, 91))
        for k in ["impressions", "reached", "installs", "signups", "core_actions", "active", "payers",
                  "revenue_jpy"]:
            band = p["daily"][k]
            assert len(band["p50"]) == 90
            assert all(a <= b <= c for a, b, c in zip(band["p10"], band["p50"], band["p90"]))
        t = p["totals"]
        assert t["installs"]["p10"] <= t["installs"]["p50"] <= t["installs"]["p90"]
        assert 0 < t["reached"]["p50"] and t["installs"]["p50"] < t["reached"]["p50"]
        # 累計は回ごとに累計してから分位点。最終日の累計 = totals
        for k in ["installs", "payers", "revenue_jpy", "reached", "core_actions"]:
            cum = p["daily_cumulative"][k]
            assert all(x <= y + 1e-9 for x, y in zip(cum["p50"], cum["p50"][1:]))
            assert cum["p50"][-1] == pytest.approx(t[k]["p50"], rel=1e-3)
        assert p["config"]["channels"] == load_app(FIX / "app.yaml")["plans"][key]["channels"]
        assert p["config"]["pricing"]["monthly_jpy"] == 3900
        ev = p["sample_run"]["events"]
        assert ev and all(len(e) == 4 and 1 <= e[1] <= 90 and e[2] in kinds_ok and e[3] >= 1 for e in ev)
        assert all(0 < d["share"] <= 1 for d in p["drop_reasons"])
    assert any(d["step"] == "signup" and d["reason_ja"] == "テスト" for d in r["plans"]["A"]["drop_reasons"])
    assert len(r["people"]) == pop.n and len(r["people"][0]) == 6
    # 課金の離脱理由は払う側（who_pays: male）だけで数える。女性のクラスターは出ない
    female_clusters = {row[5] for row in r["people"] if row[4] == "F"} - {row[5] for row in r["people"] if row[4] == "M"}
    for key in ("A", "B"):
        pay = [d for d in r["plans"][key]["drop_reasons"] if d["step"] == "pay"]
        assert pay and not any(d["cluster_id"] in female_clusters for d in pay)
    cmp = r["comparison"]
    for k in ["installs", "payers", "revenue_jpy", "active_end", "core_actions"]:
        assert set(cmp["B_minus_A"][k]) == {"p10", "p50", "p90"}
        assert 0 <= cmp["p_B_better"][k] <= 1


def test_sample_events_follow_funnel(app, pop, rules):
    """抽選結果でも、設置より前に登録や決済は起きない。"""
    r = run_app(app, pop, rules, [], runs=3, seed=9)
    ev = r["plans"]["A"]["sample_run"]["events"]
    first = {}
    for pid, day, kind, n in ev:
        assert isinstance(n, int) and n >= 1
        first.setdefault((pid, kind), day)
    for (pid, kind), day in first.items():
        if kind in ("signup", "core_action", "pay"):
            assert first[(pid, "install")] <= day


REAL_POP = Path(__file__).resolve().parents[1] / "data" / "population" / "japan_10k.csv"


@pytest.mark.skipif(not REAL_POP.exists(), reason="実データ人口がまだない")
def test_real_population_runs(app, rules):
    """人口担当の実データ（1万人）でも動き、数が妥当な大きさになる。"""
    real = Population.load(REAL_POP)
    assert real.n == 10000
    r = run_app(app, real, rules, [], runs=5, seed=3)
    t = r["plans"]["A"]["totals"]
    assert r["meta"]["scale_to_japan"] == pytest.approx(9680.6585)
    assert 0 < t["installs"]["p50"] < 10          # 500万円で日本全体 数千〜数万設置
    assert t["payers"]["p50"] <= t["core_actions"]["p50"] <= t["signups"]["p50"] <= t["installs"]["p50"]
    assert len(r["clusters"]) >= 300


# ---------------------------------------------------------------------------
# 契約 v1: 比較・ペルソナの関心・合成
# ---------------------------------------------------------------------------

def test_comparison_uses_paired_runs(app, pop, rules):
    """B を A より明らかに強くすれば p_B_better = 1、同じなら差は 0。"""
    app["plans"]["B"] = copy.deepcopy(app["plans"]["A"])
    app["plans"]["B"]["channels"] = {k: v * 3 for k, v in app["plans"]["A"]["channels"].items()}
    r = run_app(app, pop, rules, [], runs=RUNS, seed=2)
    assert r["comparison"]["p_B_better"]["installs"] == 1.0
    assert r["comparison"]["B_minus_A"]["installs"]["p10"] > 0
    app["plans"]["B"] = copy.deepcopy(app["plans"]["A"])
    r = run_app(app, pop, rules, [], runs=RUNS, seed=2)
    assert r["comparison"]["B_minus_A"]["installs"] == {"p10": 0.0, "p50": 0.0, "p90": 0.0}
    assert r["comparison"]["p_B_better"]["installs"] == 0.0


def test_persona_interest_changes_ad_response(app, pop, rules):
    base = sim(app, pop, rules)
    draws = Draws(seed=1, runs=RUNS)
    for level, cmp in [("high", np.greater), ("low", np.less)]:
        personas = {str(c): {"category_interest": level} for c in np.unique(pop.cluster)}
        res = simulate_plan(app, "A", pop, rules, draws, [], 90, personas)
        assert cmp(res.totals["installs_ad"], base.totals["installs_ad"]).all(), level
    personas = {str(c): {"interest": "mid"} for c in np.unique(pop.cluster)}
    mid = simulate_plan(app, "A", pop, rules, draws, [], 90, personas)
    assert np.allclose(mid.totals["installs_ad"], base.totals["installs_ad"])


def test_daily_payers_are_new_payers(app, pop, rules):
    res = sim(app, pop, rules)
    assert np.allclose(res.daily["payers"].sum(1), res.totals["payers"])
    assert np.allclose(res.daily["reached"].sum(1), res.totals["reached"])
    assert (res.person["reached"] <= 1 + 1e-9).all()


def test_build_replay_merges_judge_outputs(app, pop, rules, tmp_path):
    from teppuri.engine.build_replay import build
    from teppuri.engine.run import write_json

    rd = tmp_path / "runs" / "test_matching"
    write_json(run_app(app, pop, rules, [], runs=3), rd / "engine.json")
    out = build("test_matching", tmp_path / "runs", tmp_path / "replay.json")
    r = json.loads(out.read_text(encoding="utf-8"))
    assert r["interviews"] == [] and r["report_ja"] == "" and r["drop_themes"] == []

    iv = [{"person_id": 1, "plan": "A", "model": "m", "qa": [{"q_ja": "q", "a_ja": "a"}]}]
    rep = {"app_id": "test_matching", "report_ja": "本文", "headline_ja": "見出し",
           "themes": [{"theme_ja": "テーマ", "plan": "A", "step": "signup", "drop_reason_ids": [],
                       "summary_ja": "要約"}]}
    (rd / "interviews.json").write_text(json.dumps(iv, ensure_ascii=False), encoding="utf-8")
    (rd / "report.json").write_text(json.dumps(rep, ensure_ascii=False), encoding="utf-8")
    r = json.loads(build("test_matching", tmp_path / "runs", tmp_path / "replay.json").read_text(encoding="utf-8"))
    assert r["interviews"] == iv
    assert r["report_ja"] == "本文"
    assert r["drop_themes"][0]["theme_ja"] == "テーマ"
    assert r["plans"]["A"]["totals"]  # エンジンの数字はそのまま


def test_default_output_path(tmp_path, monkeypatch):
    from teppuri.engine import run as run_mod
    monkeypatch.setattr(run_mod, "REPO_ROOT", tmp_path)
    assert run_mod.run_dir("demo") == tmp_path / "runs" / "demo"
    assert run_mod.main([str(FIX / "app.yaml"), "--runs", "3",
                         "--population", str(FIX / "population_small.csv")]) == 0
    assert (tmp_path / "runs" / "test_matching" / "engine.json").exists()


# ---------------------------------------------------------------------------
# クチコミの内訳: X 上の拡散 / 身近な人づて
# ---------------------------------------------------------------------------

def _strong_x(rules):
    r = copy.deepcopy(rules)
    r.multipliers["wom_x"]["q_per_active_x_user_day"] = {"low": 0.2, "mid": 0.2, "high": 0.2, "source": "test"}
    return r


def test_wom_split_adds_up(app, pop, rules):
    res = sim(app, pop, rules)
    t = res.totals
    assert np.allclose(t["installs_wom"], t["installs_wom_local"] + t["installs_wom_x"])
    assert (t["installs_wom_x"] > 0).all() and (t["installs_wom_local"] > 0).all()


def test_no_x_users_means_no_x_wom(app, pop, rules):
    df = pop.df.copy()
    df["sns_x"] = False
    no_x = Population.from_frame(df)
    res = sim(app, no_x, _strong_x(rules))
    assert res.totals["installs_wom_x"].max() == 0
    assert res.totals["installs_wom_local"].min() > 0


def test_x_wom_reaches_outside_regions(app, pop, rules):
    """regions は出荷地域。地域外の X 利用者にも X の拡散は届くが、既定では使えないので設置0。
    available_outside_regions: true なら regions は出稿地域だけを意味し、地域外の X 利用者が X 経由で設置する。"""
    r = _strong_x(rules)
    plan = app["plans"]["A"]
    outside = ~np.isin(pop.pref, plan["regions"])
    x_out = outside & pop.sns["sns_x"]
    closed = sim(app, pop, r)
    assert closed.person["installs"][outside].max() == 0
    plan["available_outside_regions"] = True
    opened = sim(app, pop, r)
    assert opened.person["installs"][x_out].sum() > 0          # 地域外の X 利用者に届いて設置
    assert opened.person["installs"][outside & ~pop.sns["sns_x"]].max() == 0   # 地域外の X 非利用者は0
    assert opened.person["reached"][outside].max() == 0         # 広告は地域外に出ない
    assert (opened.totals["installs_wom_x"] > closed.totals["installs_wom_x"]).all()


# ---------------------------------------------------------------------------
# 契約 v2: 人単位の判断
# ---------------------------------------------------------------------------

def test_person_decision_overrides_cluster_without_jitter(app, pop, rules):
    from teppuri.engine.simulate import DecisionIndex, level_values, step_multiplier
    draws = Draws(seed=1, runs=RUNS)
    levels = level_values(draws, rules)
    jitter = draws.value("person_jitter_sd", rules.multipliers["person_jitter_sd"])
    i = 5
    c = int(pop.cluster[i])
    decs = [{"plan": "A", "step": "signup", "cluster_id": c, "level": "lower", "creative": None},
            {"plan": "A", "step": "signup", "person_id": int(pop.person_id[i]), "cluster_id": c,
             "level": "higher", "creative": None}]
    m = step_multiplier("signup", "A", [], pop, DecisionIndex(decs), levels, draws, jitter)
    assert np.array_equal(m[:, i], levels["higher"])                 # 揺らぎなし
    same_cluster = np.flatnonzero((pop.cluster == c) & (np.arange(pop.n) != i))
    j = same_cluster[0]
    assert not np.allclose(m[:, j], levels["lower"])                  # クラスター判断は揺らぐ
    assert np.allclose(np.median(m[:RUNS, same_cluster] / levels["lower"][:RUNS, None]), 1.0, atol=0.1)


def test_person_decisions_change_results(app, pop, rules):
    base = sim(app, pop, rules)
    dec = [{"plan": "A", "step": "install", "creative": "a1", "person_id": int(p),
            "cluster_id": int(c), "level": "higher", "reason_ja": "テスト"}
           for p, c in zip(pop.person_id, pop.cluster)]
    hi = sim(app, pop, rules, decisions=dec)
    assert (hi.totals["installs_ad"] > base.totals["installs_ad"]).all()


# ---------------------------------------------------------------------------
# 契約 v2: 運営中のアプリから始める・途中の変更
# ---------------------------------------------------------------------------

INIT = {"active": 300000, "payers": 30000, "as_of_day_since_launch": 365}


def _quiet(rules):
    """広告もクチコミもない状態（既存の利用者だけを見る）。"""
    r = copy.deepcopy(rules)
    r.multipliers["wom"]["q_per_active_day"] = {"low": 0.0, "mid": 0.0, "high": 0.0, "source": "test"}
    r.multipliers["wom_x"]["q_per_active_x_user_day"] = {"low": 0.0, "mid": 0.0, "high": 0.0, "source": "test"}
    return r


def test_without_initial_state_or_changes_results_are_identical(app, pop, rules):
    base = sim(app, pop, rules)
    app["plans"]["A"]["initial_state"] = None
    app["plans"]["A"]["changes"] = []
    same = sim(app, pop, rules)
    for k in base.totals:
        assert np.array_equal(base.totals[k], same.totals[k]), k
    for k in base.daily:
        assert np.array_equal(base.daily[k], same.daily[k]), k


def test_initial_users_match_target_and_attributes(app, pop, rules):
    plan = app["plans"]["A"]
    plan["channels"] = {}
    plan["initial_state"] = INIT
    res = sim(app, pop, _quiet(rules), horizon=60)
    assert np.allclose(res.daily["active"][:, 0] * pop.scale, INIT["active"], rtol=1e-3)
    assert np.allclose(res.daily["paying"][:, 0] * pop.scale, INIT["payers"], rtol=0.05)
    # 地域外・min_age 未満には配らない
    outside = ~np.isin(pop.pref, plan["regions"]) | (pop.age < app["min_age"])
    assert res.person["active_end"][outside].max() == 0
    # matching は既婚者に配る重みが小さい
    act = res.person["active_end"]
    married = (pop.df["marital"] == "married").to_numpy() & ~outside
    unmarried = (pop.df["marital"] == "unmarried").to_numpy() & ~outside
    assert act[married].mean() < act[unmarried].mean()


def test_existing_users_churn_less_than_new(app, pop, rules):
    plan = app["plans"]["A"]
    plan["channels"] = {}
    plan["initial_state"] = INIT
    res = sim(app, pop, _quiet(rules), horizon=60)
    keep_day2 = res.daily["active"][:, 1] / res.daily["active"][:, 0]
    assert (keep_day2 > 0.8).all()                       # 新規の D1（約26%）よりずっと残る
    assert (np.diff(res.daily["active"], axis=1) <= 1e-12).all()   # 新規がいなければ減るだけ


def test_budget_cut_stops_ad_installs_that_day(app, pop, rules):
    app["plans"]["A"]["changes"] = [{"day": 11, "channels": {"instagram": 0, "tiktok": 0}}]
    res = sim(app, pop, rules)
    assert res.daily["installs_ad"][:, :10].min() > 0
    assert res.daily["installs_ad"][:, 10:].max() == 0
    assert res.daily["spend_jpy"][:, 10:].max() == 0
    # 途中から予算を足すと、その日から再開する
    app["plans"]["A"]["changes"] = [{"day": 50, "channels": {"instagram": 3e6}, "campaign_days": 20}]
    res = sim(app, pop, rules)
    assert res.daily["installs_ad"][:, 30:49].max() == 0
    assert res.daily["installs_ad"][:, 49:69].min() > 0
    assert res.daily["installs_ad"][:, 69:].max() == 0


def test_price_increase_for_all_reduces_payers(app, pop, rules):
    plan = app["plans"]["A"]
    plan["initial_state"] = INIT
    base = sim(app, pop, rules, horizon=120)
    plan["changes"] = [{"day": 31, "pricing": {"monthly_jpy": 5900}, "applies_to": "all"}]
    up_all = sim(app, pop, rules, horizon=120)
    plan["changes"] = [{"day": 31, "pricing": {"monthly_jpy": 5900}, "applies_to": "new"}]
    up_new = sim(app, pop, rules, horizon=120)
    assert np.allclose(base.daily["paying"][:, :30], up_all.daily["paying"][:, :30])
    assert (up_all.daily["paying"][:, -1] < base.daily["paying"][:, -1]).all()
    assert (up_all.daily["paying"][:, -1] < up_new.daily["paying"][:, -1]).all()
    assert (up_new.daily["new_payers"][:, 30:].sum(1) < base.daily["new_payers"][:, 30:].sum(1)).all()


def test_interval_helpers(app, pop, rules):
    from teppuri.engine.window import interval_band, interval_from_replay, interval_runs
    res = sim(app, pop, rules)
    rev = res.daily["revenue_jpy"]
    assert np.allclose(interval_runs(rev, 31, 60), rev[:, 30:60].sum(1))
    assert np.allclose(interval_runs(res.daily["active"], 1, 90, "mean"), res.daily["active"].mean(1))
    b = interval_band(rev, 31, 60, runs=RUNS)
    assert b["p10"] <= b["p50"] <= b["p90"]
    r = run_app(app, pop, rules, [], runs=5)
    j = interval_from_replay(r, "A", "revenue_jpy", 1, 90, japan=True)
    assert j["p50"] > 0
    with pytest.raises(ValueError):
        interval_runs(rev, 0, 10)


def test_interest_not_applied_to_person_judged(app, pop, rules):
    """person 判断がある人には関心の倍率を掛けない。cluster 判断・判断なしの人には掛ける。"""
    draws = Draws(seed=1, runs=RUNS)
    personas = {str(c): {"interest": "high"} for c in np.unique(pop.cluster)}
    judged = pop.person_id[::2]
    dec = [{"plan": "A", "step": "signup", "person_id": int(p), "cluster_id": None, "level": "similar",
            "creative": None} for p in judged]
    r = _quiet(rules)   # クチコミを止めて、広告からの設置だけを比べる
    plain = simulate_plan(app, "A", pop, r, draws, dec, 90, None)
    with_int = simulate_plan(app, "A", pop, r, draws, dec, 90, personas)
    m = np.isin(pop.person_id, judged)
    reached = with_int.person["reached"] > 0
    assert np.allclose(with_int.person["installs"][m], plain.person["installs"][m])
    assert (with_int.person["installs"][~m & reached] > plain.person["installs"][~m & reached]).all()
    # 別の案の person 判断は関係しない
    dec_b = [{**d, "plan": "B"} for d in dec]
    other = simulate_plan(app, "A", pop, r, draws, dec_b, 90, personas)
    assert (other.person["installs"][m & reached] > plain.person["installs"][m & reached]).all()


# ---------------------------------------------------------------------------
# 運営中モードの修正: 成熟期の解約・市場の飽和・shopping の値上げ・段階的な移行
# ---------------------------------------------------------------------------

def _running(app, init=None):
    plan = app["plans"]["A"]
    plan["channels"] = {}
    plan["initial_state"] = dict(init or INIT)
    return app


def test_mature_churn_is_smaller_than_new(app, pop, rules):
    res = sim(_running(app), pop, _quiet(rules), horizon=120)
    month = res.daily["paying"][:, 30] / res.daily["paying"][:, 0]
    assert (month >= 1 - 0.076 - 1e-9).all()          # 1年目の平均月次解約（約7.6%）より小さい
    act = res.daily["active"][:, 30] / res.daily["active"][:, 0]
    assert (act > 0.8).all()                           # 成熟期の利用者は1か月で大きくは減らない


def test_monthly_churn_input_overrides(app, pop, rules):
    res = sim(_running(app, {**INIT, "monthly_churn": 0.10}), pop, _quiet(rules), horizon=60)
    month = res.daily["paying"][:, 30] / res.daily["paying"][:, 0]
    assert np.allclose(month, 0.9, atol=1e-6)


def test_ever_installed_reduces_wom(app, pop, rules):
    app["plans"]["A"]["initial_state"] = {**INIT, "ever_installed": 400000}
    few = sim(app, pop, rules, horizon=90)
    app["plans"]["A"]["initial_state"] = {**INIT, "ever_installed": 4000000}
    many = sim(app, pop, rules, horizon=90)
    assert (many.totals["installs_wom"] < few.totals["installs_wom"]).all()
    # 推定値は active より大きい（やめた人を含む）
    from teppuri.engine.simulate import initial_users
    from teppuri.engine.rules import fit_exponentials, retention_curve
    draws = Draws(seed=1, runs=2)
    alpha = np.stack([fit_exponentials(retention_curve(0.26, 0.15, 0.09, 400))] * draws.n)
    ex = initial_users(INIT, app, pop, rules, draws, alpha, np.ones(pop.n, bool), np.ones((draws.n, pop.n)), 30)
    assert (ex["ever_real"] > INIT["active"]).all()
    assert np.allclose((ex["x"] * pop.weight).sum(1), INIT["active"], rtol=1e-3)


def test_shopping_price_increase_reduces_purchases(app, pop, rules):
    app["preset"] = "shopping"
    app["gates"] = []
    app["min_age"] = 15
    app["pricing"] = {"order_jpy": 4000}
    base = sim(app, pop, rules)
    app["plans"]["A"]["changes"] = [{"day": 11, "pricing": {"order_jpy": 6000}}]
    up = sim(app, pop, rules)
    assert np.allclose(base.daily["new_payers"][:, :10], up.daily["new_payers"][:, :10])
    assert (up.daily["new_payers"][:, 10:].sum(1) < base.daily["new_payers"][:, 10:].sum(1)).all()


def test_phase_in_spreads_price_change(app, pop, rules):
    plan = _running(app)["plans"]["A"]
    plan["changes"] = [{"day": 31, "pricing": {"monthly_jpy": 5900}, "applies_to": "all"}]
    fast = sim(app, pop, _quiet(rules), horizon=180)
    plan["changes"] = [{"day": 31, "pricing": {"monthly_jpy": 5900}, "applies_to": "all", "phase_in_days": 90}]
    slow = sim(app, pop, _quiet(rules), horizon=180)
    assert np.allclose(fast.daily["paying"][:, :30], slow.daily["paying"][:, :30])
    assert (slow.daily["paying"][:, 60] > fast.daily["paying"][:, 60]).all()     # 移行の途中は解約が少ない
    assert np.allclose(slow.daily["paying"][:, -1], fast.daily["paying"][:, -1], rtol=0.02)  # 移行後はそろう


def test_person_decisions_in_replay(app, pop, rules, tmp_path):
    from teppuri.engine.build_replay import build
    from teppuri.engine.run import write_json
    dec = [{"plan": "A", "step": "signup", "person_id": 3, "cluster_id": int(pop.cluster[3]), "level": "lower",
            "reason_ja": "登録が面倒", "creative": None, "model": "m"},
           {"plan": "A", "step": "signup", "person_id": 99999, "level": "lower", "reason_ja": "いない人"},
           {"plan": "A", "step": "signup", "cluster_id": 1, "level": "higher", "reason_ja": "クラスター判断"}]
    r = run_app(app, pop, rules, dec, runs=3)
    assert r["person_decisions"] == [{"plan": "A", "person_id": 3, "step": "signup", "level": "lower",
                                      "reason_ja": "登録が面倒"}]
    rd = tmp_path / "runs" / "test_matching"
    write_json(run_app(app, pop, rules, [], runs=3), rd / "engine.json")
    (rd / "decisions.json").write_text(json.dumps(dec, ensure_ascii=False), encoding="utf-8")
    # 合成では、地図で何か起きた人かインタビューした人の分だけ入れる。person 3 をインタビュー対象にする
    (rd / "interviews.json").write_text(json.dumps([{"person_id": 3, "plan": "A", "qa": []}]), encoding="utf-8")
    out = json.loads(build("test_matching", tmp_path / "runs", tmp_path / "r.json").read_text(encoding="utf-8"))
    assert [d["person_id"] for d in out["person_decisions"]] == [3]
    # インタビューも出来事もない人は入らない
    (rd / "interviews.json").write_text("[]", encoding="utf-8")
    out = json.loads(build("test_matching", tmp_path / "runs", tmp_path / "r.json").read_text(encoding="utf-8"))
    events = {e[0] for pl in out["plans"].values() for e in pl["sample_run"]["events"]}
    assert all(d["person_id"] in events for d in out["person_decisions"])
