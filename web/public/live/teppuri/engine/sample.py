"""地図と個人の話用: mid 回の確率から1回だけ抽選した結果（sample_run.events）。

1人は実際には約9,680人を表す（weight）。1人を 0/1 で抽選すると、500万円の広告でも
1万人の中で設置が1人いるかどうかになり、地図に何も出ない。そこで「この人が表す weight 人のうち、
何人がその段階に進んだか」を整数で抽選し、1人以上いた日にイベント [person_id, 日, 段階, 人数] を出す（契約 v1）。
地図の点は「この人（と同じような約9,680人）の中で、この日にそれをした人がいた」という意味になる。

使う確率は期待値の計算（simulate.py）の mid 回と同じ。クチコミの強さとマッチの起きやすさ
（相手側の密度）は、期待値の計算で出た日ごとの値をそのまま使う。
churn は、その人のグループで使うのをやめた人がいた日に、やめた人数で出す。
"""

from __future__ import annotations

from collections import deque

import numpy as np

from .inputs import Population


def sample_events(sample: dict, pop: Population, seed: int, horizon: int) -> list[list]:
    rng = np.random.default_rng(seed)
    N, T = pop.n, horizon
    pid = pop.person_id
    w = np.rint(pop.weight).astype(np.int64)
    curve = sample["curve"]
    m_ret = sample["m_ret"]
    gates = sample["gates"]
    events: list[list] = []

    def emit(count: np.ndarray, t: int, kind: str):
        for i in np.flatnonzero(count > 0):
            events.append([int(pid[i]), t + 1, kind, int(count[i])])

    def binom(n: np.ndarray, p) -> np.ndarray:
        return rng.binomial(n, np.clip(p, 0.0, 1.0))

    # 継続: 設置した日の翌日まで残る率 min(1, m·D1)、その後は D1→D30 の平均の1日あたり残存率
    s1 = np.minimum(1.0, m_ret * curve[1])
    s_later = (curve[30] / curve[1]) ** (1.0 / 29.0) if len(curve) > 30 else 0.95

    remaining = w.copy()                 # まだ設置していない人数
    act_new = np.zeros(N, dtype=np.int64)    # 今日設置して使っている人数
    act_old = np.zeros(N, dtype=np.int64)    # 前日以前に設置して使っている人数
    gate_q = [deque() for _ in gates]
    pend_new = np.zeros(N, dtype=np.int64)   # マッチ待ち（今日入った）
    pend_old = np.zeros(N, dtype=np.int64)   # マッチ待ち（前日以前）
    trial_q: deque = deque()
    wall_q: deque = deque()
    zero = np.zeros(N, dtype=np.int64)

    for t in range(T):
        # 継続
        before = act_new + act_old
        act_old = binom(act_new, s1) + binom(act_old, s_later)
        emit(before - act_old, t, "churn")
        act_new = zero.copy()
        pend_old = binom(pend_new, s1) + binom(pend_old, s_later)
        pend_new = zero.copy()

        # 設置
        inst = binom(remaining, sample["p_install"][t].astype(float))
        remaining -= inst
        act_new = inst
        emit(inst, t, "install")

        # 登録 → 関門
        entering = binom(inst, sample["p_signup"])
        emit(entering, t, "signup")
        for gi, (gid, delay, p_pass) in enumerate(gates):
            gate_q[gi].append(entering)
            out = gate_q[gi].popleft() if len(gate_q[gi]) > delay else zero
            entering = binom(out, p_pass)
            emit(entering, t, "gate:" + gid)
        ready = entering

        # 核心行動
        if sample["matching"]:
            pend_new = ready
            hz = sample["hz"][t].astype(float)
            m_new = binom(pend_new, hz)
            m_old = binom(pend_old, hz)
            pend_new -= m_new
            pend_old -= m_old
            core = m_new + m_old
        else:
            core = binom(ready, sample["p_core"])
        emit(core, t, "core_action")

        # 決済
        if sample["preset"] == "shopping":
            pay = core
        elif sample["p_trial"] is not None:
            trial = binom(core, sample["p_trial"])
            emit(trial, t, "trial")
            trial_q.append(trial)
            pay = binom(trial_q.popleft(), sample["p_t2p"]) if len(trial_q) > sample["trial_days"] else zero
        elif sample["paywall_day"] > 0:
            wall_q.append(core)
            pay = (binom(wall_q.popleft(), np.minimum(0.95, m_ret * sample["p_pay"]))
                   if len(wall_q) > sample["paywall_day"] else zero)
        elif sample["p_pay"] is not None:
            pay = binom(core, sample["p_pay"])
        else:
            pay = zero
        emit(pay, t, "pay")

    events.sort(key=lambda e: (e[1], e[0]))
    return events
