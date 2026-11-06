"""動画の大量投稿チャネル（organic_video）のテスト。

12d263a でルールを固定した後に追加した機能（バックテストでは未検証）。
既存の計算を変えていないこと（organic_video の無い plan は固定時と同じ）を最初に確かめる。
"""

from __future__ import annotations

import copy
from pathlib import Path

import numpy as np
import pytest

from teppuri.engine.inputs import Population, load_app
from teppuri.engine.organic_video import OrganicVideo, posts_schedule
from teppuri.engine.rules import Draws, Rules
from teppuri.engine.run import run_app
from teppuri.engine.simulate import simulate_plan

FIX = Path(__file__).parent / "fixtures" / "engine"
RUNS = 8
VIDEO = {"platforms": ["tiktok", "instagram", "youtube"], "accounts": 10,
         "posts_per_account_per_day": 1, "start_day": 1, "days": 50, "cost_per_video_jpy": 3000}
VIDEO_KEYS = ["video_posts", "video_views", "video_reached", "installs_video", "spend_video_jpy"]


@pytest.fixture(scope="module")
def pop():
    return Population.load(FIX / "population_small.csv")


@pytest.fixture(scope="module")
def rules():
    return Rules.load()


@pytest.fixture()
def app():
    return load_app(FIX / "app.yaml")


def sim(app, pop, rules, plan="A", runs=RUNS, seed=1):
    return simulate_plan(app, plan, pop, rules, Draws(seed=seed, runs=runs), [],
                         int(app["plans"][plan]["period_days"]))


def with_video(app, plan="A", **kw):
    a = copy.deepcopy(app)
    a["plans"][plan]["organic_video"] = {**VIDEO, **kw}
    return a


def video_only(app, plan="A", **kw):
    """広告なし・動画だけの案（広告とクチコミの影響を除いて見る）。"""
    a = with_video(app, plan, **kw)
    a["plans"][plan]["channels"] = {}
    return a


def test_rule_values_have_source(rules):
    R = rules.organic_video
    specs = [(k, v) for k, v in R.items() if isinstance(v, dict) and "low" in v]
    specs += [(f"reference.{k}", v) for k, v in R["reference_cost_per_video_jpy"].items()]
    assert len(specs) >= 18
    assert all(p["sns_column"].startswith("sns_") for p in R["platforms"].values())
    for name, s in specs:
        assert s.get("source"), name
        assert s["low"] <= s["mid"] <= s["high"], name
        if s["source"] in ("assumption", "pending_research"):
            assert s.get("note"), name


def test_without_video_existing_keys_identical(app, pop, rules):
    """organic_video が無い plan には動画の項目が出ず、accounts = 0 の plan と既存の数字が完全に同じ。"""
    for plan in ("A", "B"):
        base = sim(app, pop, rules, plan)
        assert not any(k in base.daily or k in base.totals for k in VIDEO_KEYS)
        zero = sim(with_video(app, plan, accounts=0), pop, rules, plan)
        for k, v in base.daily.items():
            assert np.array_equal(v, zero.daily[k]), k
        for k, v in base.totals.items():
            assert np.array_equal(v, zero.totals[k]), k
        for k, v in base.person.items():
            assert np.array_equal(v, zero.person[k]), k


def test_rules_without_video_file_still_work(app, pop, rules, tmp_path):
    """organic_video.yaml が無いルールの場所でも、動画を使わない plan はそのまま動く。"""
    r = Rules(presets=rules.presets, channels=rules.channels, multipliers=rules.multipliers)
    base = sim(app, pop, rules)
    other = sim(app, pop, r)
    assert np.array_equal(base.totals["installs"], other.totals["installs"])
    with pytest.raises(ValueError):
        sim(with_video(app), pop, r)


def test_zero_accounts_zero_installs(app, pop, rules):
    res = sim(video_only(app, accounts=0), pop, rules)
    for k in VIDEO_KEYS:
        assert np.all(res.totals[k] == 0), k
    assert np.all(res.totals["installs"] == 0)
    assert np.all(res.totals["spend_jpy"] == 0)


def test_more_posts_more_views_and_installs(app, pop, rules):
    """アカウント数・1日の本数を増やすと、再生と設置が単調に増える（回の平均で）。"""
    def means(**kw):
        t = sim(video_only(app, **kw), pop, rules).totals
        return t["video_views"][:RUNS].mean(), t["installs_video"][:RUNS].mean()

    for key, values in (("accounts", [2, 5, 10, 20, 40]), ("posts_per_account_per_day", [0.5, 1, 2, 4])):
        got = [means(**{key: v}) for v in values]
        views = [g[0] for g in got]
        inst = [g[1] for g in got]
        assert all(b > a for a, b in zip(views, views[1:])), (key, views)
        assert all(b > a for a, b in zip(inst, inst[1:])), (key, inst)
        assert inst[0] > 0
    # アカウントは同じ乱数で足されていくので、回ごとにも単調に増える
    runs = [sim(video_only(app, accounts=a), pop, rules).totals for a in (2, 5, 10, 20, 40)]
    for x, y in zip(runs, runs[1:]):
        assert np.all(y["video_views"] > x["video_views"])
        assert np.all(y["installs_video"] > x["installs_video"])


def test_production_cost_in_spend(app, pop, rules):
    """制作費 = 動画の本数 × 1本の費用（プラットフォーム数には掛けない）を spend_jpy に足す。"""
    base = sim(app, pop, rules)
    res = sim(with_video(app), pop, rules)
    expect = 10 * 1 * 50 * 3000 / pop.scale
    assert np.allclose(res.totals["spend_video_jpy"], expect)
    assert np.allclose(res.totals["spend_jpy"] - base.totals["spend_jpy"], expect)
    assert np.allclose(res.totals["video_posts"], 10 * 50 * 3 / pop.scale)
    # 投稿日の外は費用も再生もない
    assert np.all(res.daily["spend_video_jpy"][:, 50:] == 0)
    assert np.all(res.daily["video_views"][:, 50:] == 0)


def test_posts_schedule():
    assert posts_schedule({"posts_per_account_per_day": 1, "start_day": 3, "days": 4}, 10).tolist() == \
        [0, 0, 1, 1, 1, 1, 0, 0, 0, 0]
    assert posts_schedule({"posts_per_account_per_day": 0.5, "start_day": 1, "days": 4}, 6).sum() == 2
    assert posts_schedule({"posts_per_account_per_day": 2}, 5).sum() == 10   # days を省くと最後まで


def test_fatigue_lowers_response(pop, rules):
    """同じ量を毎日見せると、飽きで1人あたりの設置確率が日ごとに下がる。"""
    r = copy.deepcopy(rules)
    const = lambda x: {"low": x, "mid": x, "high": x, "source": "test"}  # noqa: E731
    for key in ("sigma_within_account", "sigma_between_accounts", "follow_per_view", "p_post_over_10k",
                "same_account_decay_per_post", "freq_uplift_daily"):
        r.organic_video[key] = const(0.0)
    # 1人が1日に1回前後見るくらいの再生にする（実際の規模では1人あたりの再生が少なく、飽きはほぼ効かない）
    r.organic_video["max_views_per_post"] = const(1e12)
    r.organic_video["median_new_account"] = const(3e6)
    draws = Draws(seed=1, runs=2)
    eligible = pop.smartphone.copy()
    v = OrganicVideo(VIDEO, r, draws, pop, eligible, np.ones((draws.n, pop.n)), 60)
    rest = np.ones((draws.n, pop.n))
    ps = [v.step(t, rest)[1] for t in range(5)]
    watcher = eligible & pop.sns["sns_tiktok"]
    assert watcher.any()
    for a, b in zip(ps, ps[1:]):
        assert np.all(b[:, watcher] < a[:, watcher])
    assert np.all(ps[4][:, watcher] < 0.7 * ps[0][:, watcher])
    # 飽きを弱くすると（半減までの回数を大きくすると）5日目の反応は高い
    r2 = copy.deepcopy(r)
    r2.organic_video["viewer_fatigue_half_views"] = {"low": 1e3, "mid": 1e3, "high": 1e3, "source": "test"}
    v2 = OrganicVideo(VIDEO, r2, draws, pop, eligible, np.ones((draws.n, pop.n)), 60)
    ps2 = [v2.step(t, rest)[1] for t in range(5)]
    assert np.all(ps2[4][:, watcher] > ps[4][:, watcher])


def test_outside_region_does_not_install(app, pop, rules):
    """動画は全国に届くが、出荷地域の外の人は設置しない（available_outside_regions なら設置できる）。"""
    a = video_only(app)
    a["plans"]["A"]["regions"] = [13]
    res = sim(a, pop, rules)
    outside = pop.pref != 13
    assert outside.any() and (~outside).any()
    assert np.all(res.person["installs"][outside] == 0)
    assert res.person["installs"][~outside].sum() > 0
    assert res.person["reached"][outside].sum() == 0          # person.reached は設置できる人だけ
    assert np.all(res.totals["video_reached"] > 0)
    a["plans"]["A"]["available_outside_regions"] = True
    res2 = sim(a, pop, rules)
    assert res2.person["installs"][outside].sum() > 0


def test_creative_decisions_change_video_installs(app, pop, rules):
    """creative_ids の install 判断（higher）で動画の設置が増える。"""
    a = video_only(app, creative_ids=["videos/v1.mp4"])
    clusters = np.unique(pop.cluster)
    dec = [{"plan": "A", "step": "install", "creative": "v1", "cluster_id": int(c), "level": "higher"}
           for c in clusters]
    draws = lambda: Draws(seed=1, runs=RUNS)  # noqa: E731
    base = simulate_plan(a, "A", pop, rules, draws(), [], 90)
    up = simulate_plan(a, "A", pop, rules, draws(), dec, 90)
    assert np.all(up.totals["installs_video"] > base.totals["installs_video"])


def test_replay_has_video_fields(app, pop, rules):
    a = copy.deepcopy(app)
    a["plans"]["B"]["organic_video"] = dict(VIDEO)
    rep = run_app(a, pop, rules, [], runs=4)
    B, A = rep["plans"]["B"], rep["plans"]["A"]
    for k in VIDEO_KEYS:
        assert k in B["daily"] and k in B["totals"], k
        assert k not in A["daily"] and k not in A["totals"], k
    assert "video_reached" in B["daily_cumulative"] and "installs_video" in B["daily_cumulative"]
    assert "video_reached" not in A["daily_cumulative"]
    assert B["config"]["organic_video"]["accounts"] == 10


def test_views_match_p_over_10k(pop, rules):
    """新しいアカウントの投稿のうち1万回以上の割合が p_post_over_10k に合う（本体だけで超える回を除く）。"""
    draws = Draws(seed=3, runs=4)
    spec = {**VIDEO, "accounts": 4000}
    v = OrganicVideo(spec, rules, draws, pop, pop.smartphone, np.ones((draws.n, pop.n)), 60)
    views = v.post_views(0, 1)[..., 0]                         # (回, アカウント)
    R = rules.organic_video
    p_over = draws.value("organic_video:p_post_over_10k", R["p_post_over_10k"])
    share = (views >= 10000).mean(axis=1)
    for r in range(draws.n):
        if v.q_tail[r] > 0:
            assert share[r] == pytest.approx(p_over[r], abs=0.02)
        else:
            assert share[r] >= p_over[r] - 0.02
    assert np.all(v.q_tail >= 0) and np.all(v.q_tail <= 1)


def test_more_followers_more_views(pop, rules):
    """フォロワーが基準を超えると、再生の中央値が (フォロワー / 基準)^k 倍に上がる。"""
    draws = Draws(seed=3, runs=2)
    spec = {**VIDEO, "accounts": 4000}
    a = OrganicVideo(spec, rules, draws, pop, pop.smartphone, np.ones((draws.n, pop.n)), 60)
    b = OrganicVideo(spec, rules, draws, pop, pop.smartphone, np.ones((draws.n, pop.n)), 60)
    b.followers[:] = 50000
    va, vb = np.median(a.post_views(0, 1), axis=(1, 2)), np.median(b.post_views(0, 1), axis=(1, 2))
    R = rules.organic_video
    k = draws.value("organic_video:followers_exponent", R["followers_exponent"])
    ref = draws.value("organic_video:followers_reference", R["followers_reference"])
    assert np.allclose(vb / va, (50000 / ref) ** k, rtol=0.1)


def test_duplicate_videos_penalized(app, pop, rules):
    """同じ動画を全アカウントで使い回すと、再生と設置が減り、制作費は本数分だけになる。"""
    uniq = sim(video_only(app), pop, rules).totals
    dup = sim(video_only(app, unique_videos_per_account=False), pop, rules).totals
    assert np.all(dup["video_views"] < uniq["video_views"])
    assert np.all(dup["installs_video"] < uniq["installs_video"])
    assert np.allclose(dup["spend_video_jpy"], 1 * 50 * 3000 / pop.scale)
    assert np.allclose(uniq["spend_video_jpy"], 10 * 50 * 3000 / pop.scale)
    assert np.allclose(dup["video_posts"], uniq["video_posts"])   # 投稿の数は同じ
