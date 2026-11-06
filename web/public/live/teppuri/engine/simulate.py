"""世界エンジン本体: 1つの案（plan）を、全ての回（run）まとめて毎日計算する。

設計 3-2 の毎日のループ:
  広告露出 → 設置 → 登録 → 関門（審査待ち）→ 核心行動 → 継続 → 決済 → クチコミ
設計 3-5 のとおり、人ごとに 0/1 ではなく各段階の確率（期待値）を積み上げる。
配列の形は (回, 人)。回は runs 回 + 最後に mid 回（sample_run 用）。

動画の大量投稿（plan の organic_video、organic_video.py）は 12d263a でルールを固定した後に追加した
チャネルで、バックテストでは検証していない。plan に organic_video が無ければ結果は固定時と完全に同じ。
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field

import numpy as np

from .inputs import Population, creative_id
from .organic_video import DAILY_KEYS as VIDEO_KEYS, OrganicVideo
from .rules import Draws, EXP_RATES, Rules, fit_exponentials, fitted_curve, retention_curve

STEPS = ["install", "signup", "core_action", "retention", "pay"]
CLIP = 0.99


@dataclass
class GateSpec:
    gate_id: str
    delay: int
    p_pass: np.ndarray  # (回, 人)


@dataclass
class PlanResult:
    plan_key: str
    daily: dict          # 名前 → (回, 日) 1万人基準
    totals: dict         # 名前 → (回,)
    person: dict         # mid 回の人ごとの累計（drop_reasons 用）名前 → (人,)
    sample: dict = field(default_factory=dict)  # mid 回の確率（sample_run 用）


# ---------------------------------------------------------------------------
# 判断 → 倍率
# ---------------------------------------------------------------------------

class DecisionIndex:
    """decisions.json を (案, 段階, 人) と (案, 段階, クラスター) で引けるようにする（契約 v2）。

    person_id がある判断はその人の判断。ない判断は cluster_id の判断（クラスターの全員が受け継ぐ）。
    """

    def __init__(self, decisions: list[dict]):
        self.map: dict[tuple, list[dict]] = {}          # クラスター判断
        self.person: dict[tuple, list[dict]] = {}       # 人の判断
        self.person_by_cluster: dict[tuple, list[dict]] = {}  # 離脱理由用（cluster_id は参考値）
        for d in decisions:
            plan, step = str(d.get("plan")), str(d.get("step"))
            if d.get("person_id") is not None:
                self.person.setdefault((plan, step, int(d["person_id"])), []).append(d)
                if d.get("cluster_id") is not None:
                    self.person_by_cluster.setdefault((plan, step, int(d["cluster_id"])), []).append(d)
            elif d.get("cluster_id") is not None:
                self.map.setdefault((plan, step, int(d["cluster_id"])), []).append(d)

    def get(self, plan: str, step: str, cluster: int) -> list[dict]:
        return self.map.get((plan, step, cluster), [])

    def reasons(self, plan: str, step: str, cluster: int) -> list[dict]:
        """クラスターの判断。なければそのクラスターの人の判断。"""
        return self.get(plan, step, cluster) or self.person_by_cluster.get((plan, step, cluster), [])


def level_values(draws: Draws, rules: Rules) -> dict[str, np.ndarray]:
    return {lvl: draws.value(f"level:{lvl}", spec)
            for lvl, spec in rules.multipliers["levels"].items()}


def _decision_mult(decs: list[dict], step: str, creatives: list[str], levels: dict) -> np.ndarray:
    if step == "install" and creatives:
        by_creative = {creative_id(d.get("creative") or ""): d["level"] for d in decs}
        lv = [by_creative.get(cr, "similar") for cr in creatives]
    else:
        lv = [decs[0]["level"]]
    return np.mean([levels.get(x, levels["similar"]) for x in lv], axis=0)


def step_multiplier(step: str, plan_key: str, creatives: list[str], pop: Population,
                    index: DecisionIndex, levels: dict, draws: Draws, jitter_sd: np.ndarray) -> np.ndarray:
    """人ごとの倍率 (回, 人)。

    その人の判断（person_id）があればそれを使い、揺らぎは入れない。なければ cluster_id の判断を
    受け継いで少し揺らぐ。どちらもなければ similar（揺らぎあり）。
    install は広告素材ごとの判断を平均する（予算を素材で等分すると考える）。
    """
    clusters, inv = np.unique(pop.cluster, return_inverse=True)
    per_cluster = np.ones((draws.n, len(clusters)))
    for ci, c in enumerate(clusters):
        decs = index.get(plan_key, step, int(c))
        if decs:
            per_cluster[:, ci] = _decision_mult(decs, step, creatives, levels)
    mult = per_cluster[:, inv]
    z = draws.normal("jitter:" + step, pop.n)
    mult = mult * np.exp(jitter_sd[:, None] * z)
    if index.person:
        for i, pid in enumerate(pop.person_id):
            decs = index.person.get((plan_key, step, int(pid)))
            if decs:
                mult[:, i] = _decision_mult(decs, step, creatives, levels)
    return mult


def trait_factor(pop: Population, rules: Rules, column: str, normalize: bool = True) -> np.ndarray:
    """傾向の係数 (人,)。人口全体の加重平均が 1 になるように割り直す。"""
    spec = rules.multipliers["traits"][column]["factor"]
    vals = pop.traits[column]
    f = np.ones(pop.n)
    for level, v in spec.items():
        f[vals == level] = float(v)
    if normalize:
        f = f / (np.sum(pop.weight * f) / np.sum(pop.weight))
    return f


# ---------------------------------------------------------------------------
# 途中の変更（changes）
# ---------------------------------------------------------------------------

def budget_schedule(plan: dict, changes: list[dict], horizon: int) -> dict[str, np.ndarray]:
    """チャネルごとの1日の予算 (日,)。

    最初は channels の予算を campaign_days で等分。changes の channels は、そのチャネルの予算を
    day 日目から置き換える: 合計を campaign_days（変更に書けば）日で等分。書かなければ元のキャンペーンの
    残り日数、キャンペーンが終わっていれば30日。0 ならその日から止まる。書かれていないチャネルは変わらない。
    """
    campaign = int(plan.get("campaign_days") or 0)
    sched: dict[str, np.ndarray] = {}
    for ch, budget in (plan.get("channels") or {}).items():
        arr = np.zeros(horizon)
        if campaign > 0 and float(budget) > 0:
            arr[:campaign] = float(budget) / campaign
        sched[ch] = arr
    for c in changes:
        if "channels" not in c:
            continue
        d0 = int(c["day"]) - 1
        span = int(c.get("campaign_days") or (campaign - d0 if campaign - d0 > 0 else 30))
        for ch, total in (c.get("channels") or {}).items():
            arr = sched.setdefault(ch, np.zeros(horizon))
            arr[d0:] = 0.0
            if float(total) > 0 and span > 0:
                arr[d0:d0 + span] = float(total) / span
    return sched


def price_schedule(pricing: dict, changes: list[dict], horizon: int, key: str = "monthly_jpy"):
    """(新規の決済に使う価格 (日,), 既存の決済者にも当てる変更 [(日の index, 新しい価格, 移行日数)])。

    key = monthly_jpy（サブスク型）または order_jpy（shopping の1回の注文額）。
    applies_to: all（既定）は既存の決済者にも、phase_in_days 日かけて均等に新価格を当てる（0 なら次の更新日から）。
    """
    base = float(pricing.get(key) or 0)
    new_price = np.full(horizon, base)
    for_all = []
    for c in changes:
        pr = c.get("pricing") or {}
        if key not in pr:
            continue
        d0 = int(c["day"]) - 1
        new_price[d0:] = float(pr[key])
        if str(c.get("applies_to", "all")) == "all":
            for_all.append((d0, float(pr[key]), int(c.get("phase_in_days") or 0)))
    return new_price, for_all


# ---------------------------------------------------------------------------
# 本体
# ---------------------------------------------------------------------------

def interest_factor(pop: Population, rules: Rules, draws: Draws, personas: dict | None) -> np.ndarray:
    """ペルソナのカテゴリ関心（low / mid / high）→ 広告への反応の倍率 (回, 人)。ペルソナがなければ 1。"""
    out = np.ones((draws.n, pop.n))
    if not personas:
        return out
    spec = rules.multipliers["interest"]
    values = {lvl: draws.value(f"interest:{lvl}", spec[lvl]) for lvl in ("low", "mid", "high")}
    level_of = {}
    for cid, p in personas.items():
        lvl = p.get("interest") or p.get("category_interest")
        if lvl in values:
            level_of[int(cid)] = lvl
    for cid, lvl in level_of.items():
        mask = pop.cluster == cid
        if mask.any():
            out[:, mask] = values[lvl][:, None]
    return out


def simulate_plan(app: dict, plan_key: str, pop: Population, rules: Rules, draws: Draws,
                  decisions: list[dict], horizon: int, personas: dict | None = None) -> PlanResult:
    plan = app["plans"][plan_key]
    preset_name = app["preset"]
    P = rules.presets["presets"][preset_name]
    C = rules.channels
    RR, N, T = draws.n, pop.n, horizon
    w = pop.weight
    scale = pop.scale
    pricing = {**(app.get("pricing") or {}), **(plan.get("pricing") or {})}
    creatives = [creative_id(c) for c in (plan.get("creatives") or [])]

    # --- 対象者 ---------------------------------------------------------
    regions = plan.get("regions") or []
    in_region = np.isin(pop.pref, regions) if regions else np.ones(N, dtype=bool)
    min_age = int(app.get("min_age") or 0)
    # regions は出荷地域（地域外ではアプリを使えない）。available_outside_regions: true のときだけ、
    # regions は広告の出稿地域になり、アプリは全国で使える（地域外にも X のクチコミ経由で設置が起きる）。
    available = np.ones(N, dtype=bool) if plan.get("available_outside_regions") else in_region
    can_install = pop.smartphone & (pop.age >= min_age)
    eligible = can_install & available           # 設置できる人
    local = can_install & in_region & available  # 身近な人づての市場（地域内）
    market = float(np.sum(w * local))            # M（実人数）
    x_user = can_install & pop.sns["sns_x"]      # X のクチコミが届く人（全国）
    market_x = float(np.sum(w * x_user))

    target = plan.get("target") or {}
    age_lo, age_hi = (target.get("age") or [0, 200])
    sex = str(target.get("sex", "any"))
    target_mask = (pop.age >= age_lo) & (pop.age <= age_hi)
    if sex in ("M", "male"):
        target_mask &= pop.male
    elif sex in ("F", "female"):
        target_mask &= ~pop.male

    # --- 判断の倍率 -------------------------------------------------------
    index = DecisionIndex(decisions)
    levels = level_values(draws, rules)
    jitter_sd = draws.value("person_jitter_sd", rules.multipliers["person_jitter_sd"])

    def mult(step: str) -> np.ndarray:
        return step_multiplier(step, plan_key, creatives, pop, index, levels, draws, jitter_sd)

    m_install = mult("install")

    def mult_install_for(creative_ids: list[str]) -> np.ndarray:
        """動画の creative_ids で引いた install の倍率（organic_video 用）。"""
        return step_multiplier("install", plan_key, creative_ids, pop, index, levels, draws, jitter_sd)
    m_signup = mult("signup")
    m_core = mult("core_action")
    m_ret = mult("retention")
    m_pay = mult("pay")

    t_ad = trait_factor(pop, rules, "trait_ad_aversion")
    t_nov = trait_factor(pop, rules, "trait_novelty")
    t_wom = trait_factor(pop, rules, "trait_wom")
    t_priv = trait_factor(pop, rules, "trait_privacy")
    t_price = trait_factor(pop, rules, "trait_price", normalize=False)

    # --- 広告: 日ごとの予算（changes で途中から変わる）→ 1日あたりの設置ハザード -------
    campaign = int(plan.get("campaign_days") or 0)
    changes = sorted(plan.get("changes") or [], key=lambda c: int(c["day"]))
    schedule = budget_schedule(plan, changes, T)          # チャネル → (日,) 1日の予算
    cti = draws.value("click_to_install:" + preset_name, C["click_to_install"][preset_name])
    # 判断の倍率 × 傾向 × ペルソナのカテゴリ関心（広告への反応だけに掛ける）
    interest = interest_factor(pop, rules, draws, personas)
    # その人の判断（person_id）がある人には関心の倍率を掛けない（判断が本人に合うかを既に含むので二重になる）
    judged = {pid for (pl, _, pid) in index.person if pl == plan_key}
    if judged:
        interest[:, np.isin(pop.person_id, list(judged))] = 1.0
    person_q = m_install * (t_ad * t_nov)[None, :] * interest
    commuter = np.isin(pop.employment, C["transit"]["commuter_employment"])
    rail = np.array([C["transit"]["rail_share_by_pref"]["values"].get(int(p), 0.0) for p in pop.pref])
    channel_specs = []   # (チャネル, 届く重み, 届く実人数, 単価, 1表示あたり反応)
    for ch in schedule:
        if ch in C["online"]:
            spec = C["online"][ch]
            reach = (pop.sns[spec["sns_column"]] & in_region & target_mask).astype(float)
            cost = draws.value(f"cpm:{ch}", spec["cpm_jpy"])
            per_imp = draws.value(f"ctr:{ch}", spec["ctr"]) * cti
        elif ch == "transit":
            spec = C["transit"]
            reach = (commuter & in_region) * rail
            cost = draws.value("transit:cost", spec["cost_per_1000_riders_jpy"])
            per_imp = (draws.value("transit:view", spec["view_rate"])
                       * draws.value("transit:install", spec["view_to_install"]))
        elif ch == "offline":
            spec = C["offline"]
            a0, a1 = spec["age"]
            reach = ((pop.employment == spec["student_employment"]) & (pop.age >= a0)
                     & (pop.age <= a1) & in_region).astype(float)
            cost = draws.value("offline:cost", spec["cost_per_1000_contacts_jpy"])
            per_imp = draws.value("offline:install", spec["contact_to_install"])
        else:
            raise ValueError(f"未知のチャネル: {ch}")
        audience = float(np.sum(w * reach))
        if audience <= 0:
            continue  # 届く人がいなければ出稿できない（費用もかからない）
        channel_specs.append((ch, reach, audience, cost, per_imp))

    # --- 動画の大量投稿（organic_video、12d263a の固定後に追加・バックテスト未検証） ---------
    # plan に organic_video が無ければ video = None で、以下の計算は固定時と完全に同じ。
    video = None
    if plan.get("organic_video"):
        vspec = plan["organic_video"]
        v_creatives = [creative_id(c) for c in (vspec.get("creative_ids") or [])]
        m_video = mult_install_for(v_creatives) if v_creatives else m_install
        video = OrganicVideo(vspec, rules, draws, pop, eligible,
                             m_video * (t_ad * t_nov)[None, :] * interest, T)

    ad_cache: dict[tuple, tuple] = {}

    def ad_for_day(t: int):
        """その日の予算での (設置確率, 1回以上表示される確率, 表示回数, 費用)。同じ予算の日は使い回す。"""
        key = tuple(schedule[ch][t] for ch, *_ in channel_specs)
        if key not in ad_cache:
            hazard_ad = np.zeros((RR, N))
            exposure = np.zeros((RR, N))      # 1日あたりの表示回数（人ごと、実人数あたり）
            imp_day = np.zeros(RR)            # 1日の表示回数（日本全体）
            spend_day = 0.0
            for (ch, reach, audience, cost, per_imp), daily_budget in zip(channel_specs, key):
                if daily_budget <= 0:
                    continue
                spend_day += daily_budget
                imps = daily_budget / cost * 1000.0                      # (回,)
                freq = imps[:, None] * reach[None, :] / audience          # 1人あたり表示回数
                hazard_ad += freq * per_imp[:, None] * person_q
                exposure += freq
                imp_day += imps
            active_day = spend_day > 0
            p_ad = (1.0 - np.exp(-hazard_ad)) * eligible[None, :] if active_day else 0.0
            ad_cache[key] = (p_ad, 1.0 - np.exp(-exposure), imp_day, spend_day, active_day)
        return ad_cache[key]

    # --- クチコミ ----------------------------------------------------------
    # (b) 身近な人づて（LINE・対面）: 地域内
    wom_q = draws.value("wom:q", rules.multipliers["wom"]["q_per_active_day"])
    wom_factor = m_install * (t_wom * t_nov)[None, :] * local[None, :]
    # (a) X 上の拡散: 発信源は使っている X 利用者、受け手は全国の X 利用者。
    #     地域外の受け手にも届くが、出荷地域の外では設置できない（届いた分は無駄になる）。
    wom_x_q = draws.value("wom_x:q", rules.multipliers["wom_x"]["q_per_active_x_user_day"])
    wom_x_reach = m_install * (t_wom * t_nov)[None, :] * x_user[None, :]   # 届く重み
    wom_x_install = available[None, :]

    # --- 登録・関門 --------------------------------------------------------
    signup_rate = draws.value(f"{preset_name}:signup", P["signup"])
    p_signup = np.clip(signup_rate[:, None] * m_signup, 0, CLIP)

    G = rules.presets["gates"]
    wait_loss = draws.value("gates:wait_loss", G["wait_loss_per_day"])
    baseline_wait = G["baseline_wait_days"]["mid"]
    gates: list[GateSpec] = []
    gate_ref = np.ones(RR)
    for g in app.get("gates") or []:
        gid = str(g["id"])
        table = G[gid] if gid in G and isinstance(G[gid], dict) and "pass" in G[gid] else G["default"]
        base = draws.value(f"gate_pass:{gid}", table["pass"])
        gate_ref *= base
        delay = int(math.ceil(float(g.get("review_hours") or 0) / 24.0))
        wait = (1.0 - wait_loss) ** max(0, delay - baseline_wait)
        priv = t_priv if table.get("privacy_sensitive") else np.ones(N)
        p_pass = np.clip(base[:, None] * mult("gate:" + gid) * priv[None, :], 0, CLIP) * wait[:, None]
        gates.append(GateSpec(gid, delay, p_pass))

    # --- リテンション ------------------------------------------------------
    rk = "retention:" + preset_name
    d1 = draws.value(rk + ":d1", P["retention"]["d1"], u_key=rk)
    d7 = draws.value(rk + ":d7", P["retention"]["d7"], u_key=rk)
    d30 = draws.value(rk + ":d30", P["retention"]["d30"], u_key=rk)
    curves = np.stack([retention_curve(d1[r], d7[r], d30[r], T + 1) for r in range(RR)])
    alpha = np.stack([fit_exponentials(curves[r]) for r in range(RR)])  # (回, K)
    curves = np.stack([fitted_curve(alpha[r], T + 2) for r in range(RR)])  # 近似曲線をそのまま使う
    alpha_k = alpha.T[:, :, None]                                       # (K, 回, 1)
    decay = np.exp(-EXP_RATES)[:, None, None]
    K = len(EXP_RATES)

    # --- 運営中のアプリから始める（initial_state、契約 v2） -----------------------
    existing = initial_users(plan.get("initial_state"), app, pop, rules, draws, alpha, eligible,
                             m_install * m_ret * interest, T)

    # --- 核心行動 ---------------------------------------------------------
    matching = preset_name == "matching"
    if matching:
        hz_base = draws.value("matching:core_hazard", P["core"]["daily_hazard"])
        dens_half = draws.value("matching:density_half", P["core"]["density_half"])
        a = np.arange(curves.shape[1])
        core_ref = np.array([np.sum(hz_base[r] * (1 - hz_base[r]) ** a * curves[r]) for r in range(RR)])
        sides = str(app.get("matching_sides", "opposite_sex"))
        n_pref = 48
        cell_self = pop.pref * 2 + pop.male.astype(int)
        cell_opp = pop.pref * 2 + (~pop.male).astype(int)
    elif preset_name == "shopping":
        i2fp = draws.value("shopping:first_purchase", P["core"]["install_to_first_purchase"])
        core_ref = np.clip(i2fp / signup_rate, 0, 1)
    else:
        core_ref = draws.value(f"{preset_name}:core", P["core"]["rate"])
    if not matching:
        p_core = np.clip(core_ref[:, None] * m_core, 0, CLIP)

    # --- 決済（価格は changes で途中から変わる） -------------------------------
    price_new, price_all = price_schedule(pricing, changes, T)
    order_new, _ = price_schedule(pricing, changes, T, "order_jpy")
    order0 = float(order_new[0])
    order_changes = preset_name == "shopping" and order0 > 0 and bool(np.any(order_new != order0))
    order_cache: dict[float, np.ndarray] = {}

    def order_factor(order: float) -> np.ndarray:
        """shopping: 注文額が変わったときの初回購入の倍率 (注文額/最初の注文額)^(−弾力性 × 価格感度)。"""
        if order not in order_cache:
            order_cache[order] = (order / order0) ** (-eps[:, None] * t_price[None, :])
        return order_cache[order]
    trial_days = int(pricing.get("free_trial_days") or 0)
    eps = draws.value("price_elasticity", rules.presets["price_elasticity"])
    PP = P["pay"]
    pay_cache: dict[float, tuple] = {}

    def pay_probs(price: float):
        if price not in pay_cache:
            pay_cache[price] = _pay_probs(price)
        return pay_cache[price]

    def _pay_probs(price: float):
        if "reference_monthly_jpy" in PP and price > 0:
            ref = draws.value(f"{preset_name}:ref_price", PP["reference_monthly_jpy"])
            price_factor = (price / ref)[:, None] ** (-eps[:, None] * t_price[None, :])
        else:
            price_factor = np.ones((RR, N))
        free = price <= 0 and preset_name != "shopping"

        p_pay = p_trial = p_t2p = None
        paywall_day = 0
        if matching:
            i2p = draws.value("matching:install_to_paid", PP["install_to_paid"])
            base = i2p / (signup_rate * gate_ref * core_ref)
            s_m = draws.value("matching:pay_male", PP["paying_share_male"])
            s_f = draws.value("matching:pay_female", PP["paying_share_female"])
            who = str(pricing.get("who_pays", "both"))
            s_bar = (s_m + s_f) / 2
            sex_f = np.ones((RR, N))
            if who == "male":
                sex_f = np.where(pop.male[None, :], (s_m / s_bar)[:, None], (s_f / s_bar)[:, None])
            elif who == "female":
                sex_f = np.where(pop.male[None, :], (s_f / s_bar)[:, None], (s_m / s_bar)[:, None])
            p_pay = np.clip(base[:, None] * sex_f * m_pay * price_factor, 0, 0.95)
        elif preset_name in ("subscription", "habit"):
            cond = signup_rate * core_ref
            if trial_days > 0:
                d2t = draws.value(f"{preset_name}:dl_to_trial", PP["download_to_trial"])
                t2p = draws.value(f"{preset_name}:trial_to_paid", PP["trial_to_paid"])
                p_trial = np.clip((d2t / cond)[:, None] * np.ones(N), 0, CLIP)
                p_t2p = np.clip(t2p[:, None] * m_pay * price_factor, 0, 0.95)
            else:
                d2p = draws.value(f"{preset_name}:dl_to_paid", PP["download_to_paid"])
                p_pay = np.clip((d2p / cond)[:, None] * m_pay * price_factor, 0, 0.95)
                if preset_name == "habit":
                    paywall_day = int(P["core"]["paywall_day"]["mid"])
        if free:
            p_pay = np.zeros((RR, N)) if p_pay is not None else None
            if p_t2p is not None:
                p_t2p = np.zeros((RR, N))
        return p_pay, p_trial, p_t2p, paywall_day

    p_pay, p_trial, p_t2p, paywall_day = pay_probs(float(price_new[0]))
    price_changes = bool(np.any(price_new != price_new[0]))
    sample_pay = (p_pay, p_trial, p_t2p)   # sample_run は最初の価格で抽選する

    # --- 状態 -----------------------------------------------------------
    U = np.ones((RR, N))                 # まだ設置していない確率
    A = np.zeros((K, RR, N))             # 設置の残り（リテンション成分）
    if matching:
        Pn = np.zeros((K, RR, N))        # 関門を通ってまだマッチしていない人
    queues = [deque() for _ in gates]
    trial_q: deque = deque()
    paywall_q: deque = deque()

    names = ["impressions", "reached", "installs", "installs_ad", "installs_wom",
             "installs_wom_local", "installs_wom_x", "signups", "core_actions",
             "active", "new_payers", "spend_jpy"]
    if video is not None:
        names = names + VIDEO_KEYS
    daily = {k: np.zeros((RR, T)) for k in names}
    gate_daily = {g.gate_id: np.zeros((RR, T)) for g in gates}
    cum = {k: np.zeros((RR, N)) for k in ["installs", "signups", "ready", "core", "pay", "trial"]}
    cum_gate_in = [np.zeros((RR, N)) for _ in gates]
    cum_gate_pass = [np.zeros((RR, N)) for _ in gates]
    p_inst_mid = np.zeros((T, N), dtype=np.float32)
    hz_mid = np.zeros((T, N), dtype=np.float32) if matching else None

    installed_local = np.zeros(RR)       # 地域内で設置した実人数（身近な人づての N）
    installed_x = np.zeros(RR)           # X 利用者で設置した実人数（X 拡散の N）
    active_x_prev = np.zeros(RR)         # 前日に使っていた X 利用者（実人数）
    ex0 = existing["x"] if existing else None    # 既存の利用者（人ごとの確率、1日目の時点）
    if ex0 is not None:
        ever = existing["ever"]                   # 過去に設置した人（やめた人を含む）
        U = U - ever
        installed_local = (ever * w * local).sum(axis=1)
        installed_x = (ever * w * x_user).sum(axis=1)
        active_x_prev = (ex0 * w * x_user).sum(axis=1)
    not_reached = np.ones((RR, N))       # まだ一度も広告が届いていない確率
    active_real_prev = np.zeros(RR) if ex0 is None else (ex0 * w).sum(axis=1)
    wsum = lambda x: (x * w).sum(axis=1) / scale  # noqa: E731  1万人基準の合計

    for t in range(T):
        pa, p_reach_day, imp_day, spend_day, in_campaign = ad_for_day(t)
        # 1) 広告 → 設置
        if in_campaign:
            inst_ad = U * pa
            newly = not_reached * p_reach_day
            not_reached = not_reached - newly
            daily["reached"][:, t] = wsum(newly)
        else:
            inst_ad = np.zeros((RR, N))
        # 6) クチコミ（前日のアクティブ数から）: 合計 = q × A × (M − N) / M
        rest = U - inst_ad
        if video is not None:   # 1') 動画の投稿 → 設置（広告で設置しなかった分に）
            inst_video, p_video, vstats = video.step(t, rest)
            rest = rest - inst_video
        # (b) 身近な人づて: 合計 = q × A × (M − N) / M
        if market > 0:
            room = np.maximum(market - installed_local, 0.0) / market          # (M − N)/M
            total_wom = wom_q * active_real_prev * room                        # 実人数
            denom = np.sum(w * rest * wom_factor, axis=1)                     # 未設置の重み
            rate = np.where(denom > 0, total_wom / np.maximum(denom, 1e-12), 0.0)
            p_wom = 1.0 - np.exp(-rate[:, None] * wom_factor)
        else:
            p_wom = np.zeros((RR, N))
        inst_local = rest * p_wom
        rest = rest - inst_local
        # (a) X 上の拡散: 合計（届く量）= q_x × A_x × (M_x − N_x) / M_x、全国の未設置の X 利用者に配る
        if market_x > 0:
            room_x = np.maximum(market_x - installed_x, 0.0) / market_x
            total_x = wom_x_q * active_x_prev * room_x
            denom_x = np.sum(w * rest * wom_x_reach, axis=1)
            rate_x = np.where(denom_x > 0, total_x / np.maximum(denom_x, 1e-12), 0.0)
            p_x = (1.0 - np.exp(-rate_x[:, None] * wom_x_reach)) * wom_x_install
        else:
            p_x = np.zeros((RR, N))
        inst_x = rest * p_x
        inst_wom = inst_local + inst_x
        inst = inst_ad + inst_wom
        if video is not None:
            inst = inst + inst_video
        U = U - inst
        installed_local += (inst * w * local).sum(axis=1)
        installed_x += (inst * w * x_user).sum(axis=1)
        pa_mid = pa[-1] if in_campaign else 0.0
        p_inst_mid[t] = 1.0 - (1.0 - pa_mid) * (1.0 - p_wom[-1]) * (1.0 - p_x[-1])
        if video is not None:
            p_inst_mid[t] = 1.0 - (1.0 - p_inst_mid[t]) * (1.0 - p_video[-1])

        # 2) 登録
        signup = inst * p_signup
        # 3) 関門（審査待ちのあいだは列に並ぶ）
        entering = signup
        for gi, g in enumerate(gates):
            queues[gi].append(entering)
            cum_gate_in[gi] += entering
            out = queues[gi].popleft() if len(queues[gi]) > g.delay else np.zeros((RR, N))
            passed = out * g.p_pass
            cum_gate_pass[gi] += passed
            gate_daily[g.gate_id][:, t] = wsum(passed)
            entering = passed
        ready = entering

        # 4) 継続（リテンション成分を1日進める）
        A *= decay
        active = inst + m_ret * A.sum(axis=0)
        A += alpha_k * inst
        if ex0 is not None:   # 既存の利用者は成熟期の曲線（発売からの日数の位置）で続ける
            active = active + ex0 * existing["E"][:, t][:, None]

        # 3') 核心行動
        if matching:
            Pn *= decay
            # 相手側 = 関門を通って表示されているプロフィールの累計（都道府県 × 性別、実人数）
            profiles = cum["ready"] + ready
            if ex0 is not None:
                profiles = profiles + ex0
            idx = (np.arange(RR)[:, None] * (n_pref * 2))
            n_cell = np.bincount((idx + cell_self[None, :]).ravel(), weights=(profiles * w).ravel(),
                                 minlength=RR * n_pref * 2).reshape(RR, n_pref * 2)
            if sides == "any":
                n_pref_tot = n_cell.reshape(RR, n_pref, 2).sum(axis=2)
                opp = n_pref_tot[:, pop.pref]
            else:
                opp = n_cell[:, cell_opp]
            factor = opp / (opp + dens_half[:, None])
            hz = np.clip(hz_base[:, None] * m_core * factor, 0, CLIP)
            hz_mid[t] = hz[-1]
            pending = ready + m_ret * Pn.sum(axis=0)
            core = pending * hz
            Pn *= (1.0 - hz)[None]
            Pn += alpha_k * (ready * (1.0 - hz))[None]
        else:
            core = ready * p_core
            if order_changes:
                core = np.minimum(core * order_factor(float(order_new[t])), ready)

        # 5) 決済（その日の新規向け価格で判断）
        if price_changes:
            p_pay, p_trial, p_t2p, _ = pay_probs(float(price_new[t]))
        if matching or (preset_name == "subscription" and trial_days == 0):
            pay = core * p_pay
        elif preset_name == "shopping":
            pay = core
        elif trial_days > 0:
            trial = core * p_trial
            cum["trial"] += trial
            trial_q.append(trial)
            pay = trial_q.popleft() * p_t2p if len(trial_q) > trial_days else np.zeros((RR, N))
        else:  # habit で無料体験なし: 7日後に、まだ使っている人へ決済画面
            paywall_q.append(core)
            pay = (paywall_q.popleft() * np.clip(m_ret * p_pay, 0, 0.95)
                   if len(paywall_q) > paywall_day else np.zeros((RR, N)))

        # 集計
        cum["installs"] += inst
        cum["signups"] += signup
        cum["ready"] += ready
        cum["core"] += core
        cum["pay"] += pay
        active_real_prev = (active * w).sum(axis=1)
        active_x_prev = (active * w * x_user).sum(axis=1)
        daily["impressions"][:, t] = (imp_day if in_campaign else 0.0) / scale
        daily["spend_jpy"][:, t] = (spend_day if in_campaign else 0.0) / scale
        daily["installs"][:, t] = wsum(inst)
        daily["installs_ad"][:, t] = wsum(inst_ad)
        daily["installs_wom"][:, t] = wsum(inst_wom)
        daily["installs_wom_local"][:, t] = wsum(inst_local)
        daily["installs_wom_x"][:, t] = wsum(inst_x)
        daily["signups"][:, t] = wsum(signup)
        daily["core_actions"][:, t] = wsum(core)
        daily["active"][:, t] = active_real_prev / scale
        daily["new_payers"][:, t] = wsum(pay)
        if video is not None:   # 制作費は広告費とは別に spend_jpy に足す
            daily["video_posts"][:, t] = vstats["posts"] / scale
            daily["video_views"][:, t] = vstats["views"] / scale
            if vstats["newly_reached"] is not None:
                daily["video_reached"][:, t] = wsum(vstats["newly_reached"])
            daily["installs_video"][:, t] = wsum(inst_video)
            daily["spend_video_jpy"][:, t] = vstats["spend"] / scale
            daily["spend_jpy"][:, t] += vstats["spend"] / scale

    # --- 決済後: 継続課金と売上（集計値で計算） --------------------------------
    # daily の payers は「その日に新しく決済した人数」（契約 v1）
    paying, revenue = _revenue(preset_name, pricing, P, rules, draws, daily, curves, T,
                               price_new, price_all, eps, existing, order_new)
    daily["payers"] = daily["new_payers"]
    daily["paying"] = paying          # その日に払い続けている人数（参考、リプレイには出さない）
    daily["revenue_jpy"] = revenue

    totals = {
        "impressions": daily["impressions"].sum(1),
        "reached": daily["reached"].sum(1),
        "spend_jpy": daily["spend_jpy"].sum(1),
        "installs": daily["installs"].sum(1),
        "installs_ad": daily["installs_ad"].sum(1),
        "installs_wom": daily["installs_wom"].sum(1),
        "installs_wom_local": daily["installs_wom_local"].sum(1),
        "installs_wom_x": daily["installs_wom_x"].sum(1),
        "signups": daily["signups"].sum(1),
        "core_actions": daily["core_actions"].sum(1),
        "payers": daily["new_payers"].sum(1),
        "revenue_jpy": daily["revenue_jpy"].sum(1),
        "active_end": daily["active"][:, -1],
        "paying_end": daily["paying"][:, -1],
    }
    if video is not None:
        for k in VIDEO_KEYS:
            totals[k] = daily[k].sum(1)
    for g in gates:
        totals["gate:" + g.gate_id] = gate_daily[g.gate_id].sum(1)
    if trial_days > 0 and preset_name in ("subscription", "habit"):
        totals["trials"] = wsum(cum["trial"])
    with np.errstate(divide="ignore", invalid="ignore"):
        totals["cpi_jpy"] = np.where(totals["installs"] > 0, totals["spend_jpy"] / totals["installs"], 0.0)
        totals["roas"] = np.where(totals["spend_jpy"] > 0, totals["revenue_jpy"] / totals["spend_jpy"], 0.0)

    # --- mid 回の人ごとの累計（離脱理由用） -----------------------------------
    if video is not None:   # 広告か動画のどちらかが届いた人
        not_reached = not_reached * video.not_reached
    person = {
        "reached": (1.0 - not_reached[-1]) * eligible,
        "installs": cum["installs"][-1],
        "signups": cum["signups"][-1],
        "ready": cum["ready"][-1],
        "core": cum["core"][-1],
        "pay": cum["pay"][-1],
        "active_end": active[-1],
    }
    for gi, g in enumerate(gates):
        person["gate_in:" + g.gate_id] = cum_gate_in[gi][-1]
        person["gate_pass:" + g.gate_id] = cum_gate_pass[gi][-1]

    sample = {
        "p_install": p_inst_mid,
        "p_signup": p_signup[-1],
        "gates": [(g.gate_id, g.delay, g.p_pass[-1]) for g in gates],
        "matching": matching,
        "hz": hz_mid,
        "p_core": None if matching else p_core[-1],
        "p_pay": None if sample_pay[0] is None else sample_pay[0][-1],
        "p_trial": None if sample_pay[1] is None else sample_pay[1][-1],
        "p_t2p": None if sample_pay[2] is None else sample_pay[2][-1],
        "trial_days": trial_days if preset_name in ("subscription", "habit") else 0,
        "paywall_day": paywall_day,
        "preset": preset_name,
        "curve": curves[-1],
        "m_ret": m_ret[-1],
    }
    return PlanResult(plan_key, daily, totals, person, sample)


def _switch_groups(d0: int, phase: int, start: int):
    """移行の開始日 d0 から phase 日かけて均等に新価格へ移るとき、更新日が start + 30k の人が
    何回目の更新で切り替わるか → [(更新の経過日数, 割合)]。"""
    ks = np.arange(max(phase, 1))
    first = 30 * np.ceil((d0 + ks - start) / 30.0).astype(int)
    first = np.maximum(first, 30)
    vals, counts = np.unique(first, return_counts=True)
    return list(zip(vals.tolist(), (counts / len(ks)).tolist()))


def _split_segments(segments, d0, p, phase, start, n, eps_r):
    """値上げで既存の決済者を分ける。segments = [(割合 (n,), 価格 (n,))]。切り替わった人は
    その更新で (新価格/旧価格)^(−弾力性) の割合だけ続ける（値上げのときだけ）。"""
    out = []
    for weight, price in segments:
        rest = weight.copy()
        for first, share in _switch_groups(d0, phase, start):
            if first >= n:
                continue
            prev = price[first]
            f = min(1.0, (p / prev) ** (-eps_r)) if prev > 0 and p > 0 else 1.0
            moved = np.zeros(n)
            moved[first:] = weight[first:] * share
            rest = rest - moved
            new_price = price.copy()
            new_price[first:] = p
            out.append((moved * f, new_price))
        out.append((rest, price))
    return out


def _revenue(preset_name, pricing, P, rules, draws, daily, curves, T,
             price_new=None, price_all=(), eps=None, existing=None, order_new=None):
    """新しい決済者の日別系列から、続けて払っている人数と売上を出す（1万人基準）。

    - 決済後の継続: 初回更新 → 12か月目までは paying_retention、13か月目以降は成熟期の月次解約率。
    - 価格の変更: 新規の決済は price_new（その日の価格）で始まる。applies_to: all の変更は、
      既存の決済者にも phase_in_days 日かけて（0 なら次の更新日から）新しい価格を当て、切り替わる更新で
      価格弾力性の分だけ解約する（値上げのときだけ。値下げで戻ってくる人は入れない）。
    - initial_state の既存の決済者は成熟期の月次解約率で減り、更新日は30日に均等に散らばるとする。
    - shopping: 1回の注文額が途中で変わると、再購入の頻度に価格弾力性を掛ける（初回購入は simulate 側）。
    """
    new = daily["new_payers"]
    RR = new.shape[0]
    payers = np.zeros_like(new)
    revenue = np.zeros_like(new)
    a = np.arange(T)
    if preset_name == "shopping":
        order0 = float(pricing.get("order_jpy") or 0)
        order_t = order_new if order_new is not None else np.full(T, order0)
        cycle = draws.value("shopping:cycle", P["pay"]["repurchase_cycle_days"])
        arpmau = draws.value("shopping:arpmau", P["pay"]["arpmau_jpy"])
        for r in range(RR):
            act_buyers = np.convolve(new[r], curves[r][:T])[:T]   # 続けて使っている購入者
            if existing:
                act_buyers_ex = existing["payers"][r] * existing["E"][r, :T]
            else:
                act_buyers_ex = 0.0
            payers[r] = act_buyers + act_buyers_ex
            if order0 > 0:
                repeat = act_buyers - new[r] + act_buyers_ex        # 初回購入の当日を除く
                elastic = (order_t / order0) ** (-eps[r]) if eps is not None else 1.0
                revenue[r] = order_t * new[r] + order_t / cycle[r] * repeat * elastic
            else:
                revenue[r] = daily["active"][r] * arpmau[r] / 30.0
        return payers, revenue

    price0 = float(pricing.get("monthly_jpy") or 0)
    if price_new is None:
        price_new = np.full(T, price0)
    pr = rules.presets["paying_retention"]
    fr = draws.value("paying:first_renewal", pr["first_renewal"])
    y1 = draws.value("paying:year1", pr["year1_monthly"])
    mature = draws.value("paying:mature_churn", pr["mature_monthly_churn"])
    month = a // 30
    simple = not price_all and np.all(price_new == price_new[0])
    for r in range(RR):
        rate = (y1[r] / fr[r]) ** (1.0 / 11.0)
        s = np.where(month == 0, 1.0, fr[r] * rate ** np.clip(month - 1, 0, 11))  # 支払いが続く割合
        s = s * (1.0 - mature[r]) ** np.maximum(month - 12, 0)                     # 13か月目以降
        book = np.where(a % 30 == 0, s, 0.0)                                  # 30日ごとに課金
        if simple:
            payers[r] = np.convolve(new[r], s)[:T]
            revenue[r] = price_new[0] * np.convolve(new[r], book)[:T]
        else:
            for c in np.flatnonzero(new[r] > 0):
                n = T - c
                segs = [(s[:n].copy(), np.full(n, price_new[c]))]
                for d0, p, phase in price_all:
                    if d0 > c:
                        segs = _split_segments(segs, d0, p, phase, c, n, eps[r])
                renew = (a[:n] % 30 == 0)
                for weight, price in segs:
                    payers[r, c:] += new[r, c] * weight
                    revenue[r, c:] += new[r, c] * weight * price * renew
        if existing and existing["payers"][r] > 0:
            base = existing["payers"][r] * (1.0 - existing["churn"][r]) ** (a / 30.0)
            weight = np.ones(T)
            segs = [(weight, np.full(T, price0))]
            for d0, p, phase in price_all:
                out = []
                ks = np.arange(max(phase, 1))
                # 更新日は30日に均等。k 日目から切り替える人は、その後の最初の更新で新価格になる
                frac = np.clip((a[None, :] - d0 - ks[:, None] + 1) / 30.0, 0.0, 1.0).mean(axis=0)
                for wgt, price in segs:
                    prev = price[min(d0, T - 1)]
                    f = min(1.0, (p / prev) ** (-eps[r])) if prev > 0 and p > 0 else 1.0
                    new_price = price.copy()
                    new_price[:] = p
                    out.append((wgt * frac * f, new_price))
                    out.append((wgt * (1.0 - frac), price))
                segs = out
            for wgt, price in segs:
                payers[r] += base * wgt
                revenue[r] += base * wgt / 30.0 * price
    return payers, revenue


def initial_users(init: dict | None, app: dict, pop: Population, rules: Rules, draws: Draws,
                  alpha: np.ndarray, eligible: np.ndarray, affinity_mult: np.ndarray, T: int) -> dict | None:
    """initial_state（日本全体の実人数）を1万人基準にして、属性に合う人へ確率で配る。

    配る重み = 設置できる（min_age・地域・スマホ）× プリセットの属性の傾向（initial_affinity）
              × 判断の倍率（install・retention）× ペルソナの関心。
    - 過去に設置した人（ever_installed、やめた人を含む）をこの重みで配り、そのうち active の割合を
      今使っている人とする。やめた人はもう一度は設置しない（クチコミの (M − N)/M の N に入る）。
      ever_installed が無ければ「発売から as_of 日まで一定のペースで設置されてきた」とみなして推定する:
      1日の設置 = active ÷ Σ_{a=0..as_of} R(a)、ever_installed = 1日の設置 × (as_of + 1)。
    - 今使っている人の継続は成熟期の曲線 E(t) = R(as_of + t) / R(as_of)（発売からの日数の位置から続ける）。
    - 既存の決済者は成熟期の月次解約率（monthly_churn、無ければ rules の mature_monthly_churn）で減る。
    """
    if not init:
        return None
    RR, N = draws.n, pop.n
    w = pop.weight
    P = rules.presets["presets"][app["preset"]]
    aff = eligible.astype(float)
    spec = P.get("initial_affinity") or {}
    for col, table in spec.items():
        if col not in pop.df:
            continue
        vals = pop.df[col].astype(str).to_numpy()
        f = np.ones((RR, N))
        for level, v in table.items():
            if isinstance(v, dict) and "low" in v:
                f[:, vals == level] = draws.value(f"initial_affinity:{col}:{level}", v)[:, None]
        aff = aff * f
    aff = aff * affinity_mult
    active = float(init.get("active") or 0)
    a0 = int(init.get("as_of_day_since_launch") or 0)
    cap = float(np.sum(w * eligible))
    x = np.zeros((RR, N))
    ever_x = np.zeros((RR, N))
    E = np.zeros((RR, T + 1))
    ever_real = np.zeros(RR)
    for r in range(RR):
        R = fitted_curve(alpha[r], a0 + T + 2)
        if init.get("ever_installed") is not None:
            ever_real[r] = float(init["ever_installed"])
        else:
            ever_real[r] = active / R[: a0 + 1].sum() * (a0 + 1)
        ever_real[r] = min(max(ever_real[r], active), cap)
        ever_x[r] = _allocate(aff[r], w, ever_real[r])
        got = float(np.sum(w * ever_x[r]))
        x[r] = ever_x[r] * (active / got if got > 0 else 0.0)
        E[r] = R[a0: a0 + T + 1] / R[a0]
    payers = np.full(RR, float(init.get("payers") or 0) / pop.scale)
    if init.get("monthly_churn") is not None:
        churn = np.full(RR, float(init["monthly_churn"]))
    else:
        churn = draws.value("paying:mature_churn", rules.presets["paying_retention"]["mature_monthly_churn"])
    return {"x": x, "ever": ever_x, "ever_real": ever_real, "E": E, "payers": payers,
            "churn": churn, "as_of": a0}


def _allocate(aff: np.ndarray, w: np.ndarray, target: float) -> np.ndarray:
    """Σ w·min(1, k·aff) = target となる k を二分法で探し、人ごとの確率を返す。"""
    if target <= 0 or aff.max() <= 0:
        return np.zeros_like(aff)
    cap = float(np.sum(w * (aff > 0)))
    if target >= cap:
        return (aff > 0).astype(float)
    lo, hi = 0.0, 1.0 / aff[aff > 0].min()
    for _ in range(60):
        k = (lo + hi) / 2
        if np.sum(w * np.minimum(1.0, k * aff)) < target:
            lo = k
        else:
            hi = k
    return np.minimum(1.0, hi * aff)
