"""動画の大量投稿チャネル（organic_video）: 広告費を払わない短尺動画を、複数アカウントで毎日投稿する。

※ 12d263a でルールを固定した後に追加した機能。バックテストでは検証していない。
  app.yaml の plan に organic_video が無ければ simulate_plan はこのモジュールを使わず、結果は固定時と完全に同じ。
※ 各アカウントがアプリ公式・広告と明示し、AI 生成表示をつけ、アカウントごとに別の動画を出す前提。同じ動画の
  使い回しや一般人を装う運用は、各社規約の違反と景品表示法のステマ規制に当たるおそれがある（rules/organic_video.yaml）。

app.yaml の plan（任意）:
  organic_video:
    platforms: [tiktok, instagram, youtube]   # リール = instagram、ショート = youtube
    accounts: 10                               # 各アカウントは全プラットフォームに同じ動画を投稿する
    posts_per_account_per_day: 1               # 小数も可（0.5 = 2日に1本）
    start_day: 1
    days: 50                                   # 省略時は期間の最後まで
    cost_per_video_jpy: 1050                   # 動画1本の制作費（プラットフォームの数には掛けない）
    unique_videos_per_account: true            # 既定 true。false = 同じ動画を全アカウントで投稿（重複のペナルティ）
    creative_ids: [v1, v2]                     # 任意。判断（install）を引く creative の ID

仕組み（値は rules/organic_video.yaml）:
  1投稿の再生数
    本体: 中央値 × 調整 × exp(σ_between z_アカウント + σ_within z_投稿)
    裾:   確率 q で 最小値 × U^(−1/α) × 調整（パレート）。q は p_post_over_10k に合うように決める
    上限で切る。調整 = max(1, フォロワー/基準)^k × 頻度の上積み × 同じアカウントの飽き × 重複のペナルティ
  フォロワー += 再生数 × follow_per_view
  人口に届く再生 = 再生数 × japan_view_share を、その SNS の利用者へ weight に比例して配る（全国。地域は絞れない）
  1再生あたり設置確率 = view_to_install × 判断 × 傾向 × 関心 × exp(−λ × これまでに見た回数)
  1日の設置確率 = 1 − exp(−h)、h = 基準 × (exp(−λS) − exp(−λ(S + f))) / λ（その日に f 回見たときの積分）
"""

from __future__ import annotations

import math

import numpy as np

from .rules import Draws, Rules

DAILY_KEYS = ["video_posts", "video_views", "video_reached", "installs_video", "spend_video_jpy"]
FREE_POSTS = 10   # 同じアカウントの飽きが始まるまでの本数（[VQ26] 最初の10本で低下なし）


def posts_schedule(spec: dict, horizon: int) -> np.ndarray:
    """1アカウントが各日に投稿する本数 (日,)。小数の本数は累計の切り捨ての差で配る。"""
    ppd = float(spec.get("posts_per_account_per_day", 1) or 0)
    start = max(int(spec.get("start_day") or 1) - 1, 0)
    days = spec.get("days")
    end = horizon if days is None else min(start + int(days), horizon)
    out = np.zeros(horizon, dtype=int)
    for t in range(start, end):
        k = t - start
        out[t] = int(math.floor((k + 1) * ppd + 1e-9) - math.floor(k * ppd + 1e-9))
    return out


def _norm_sf(x: np.ndarray) -> np.ndarray:
    """標準正規の上側確率。"""
    return 0.5 * np.vectorize(math.erfc)(np.asarray(x, dtype=float) / math.sqrt(2.0))


def tail_probability(median: np.ndarray, sigma_total: np.ndarray, p_over: np.ndarray,
                     threshold: np.ndarray) -> np.ndarray:
    """パレートの裾の出現確率 q: q + (1 − q) × 本体で閾値を超える割合 = p_over。本体だけで超えていれば 0。"""
    body = _norm_sf(np.log(threshold / median) / np.maximum(sigma_total, 1e-9))
    return np.clip((p_over - body) / np.maximum(1.0 - body, 1e-9), 0.0, 1.0)


class OrganicVideo:
    """1つの案の動画チャネル。毎日 step(t, rest) を呼ぶ。配列の形は (回, 人)。"""

    def __init__(self, spec: dict, rules: Rules, draws: Draws, pop, eligible: np.ndarray,
                 person_q: np.ndarray, horizon: int):
        R = rules.organic_video
        if not R:
            raise ValueError("rules/organic_video.yaml がありません（organic_video を使う plan には必要）")
        RR, N = draws.n, pop.n
        self.RR, self.N = RR, N
        self.platforms = [str(p) for p in (spec.get("platforms") or list(R["platforms"]))]
        for p in self.platforms:
            if p not in R["platforms"]:
                raise ValueError(f"organic_video の未知のプラットフォーム: {p}")
        self.accounts = int(spec.get("accounts") or 0)
        self.unique = bool(spec.get("unique_videos_per_account", True))
        self.cost = float(spec.get("cost_per_video_jpy") or 0)
        self.posts = posts_schedule(spec, horizon) * (self.accounts > 0)
        A = max(self.accounts, 1)
        P = len(self.platforms)

        v = lambda key: draws.value("organic_video:" + key, R[key])  # noqa: E731
        self.median = v("median_new_account")
        self.s_within = v("sigma_within_account")
        s_between = v("sigma_between_accounts")
        self.alpha = v("viral_tail_alpha")
        self.tail_min = v("viral_tail_min_views")
        self.cap = v("max_views_per_post")
        self.q_tail = tail_probability(self.median, np.sqrt(self.s_within ** 2 + s_between ** 2),
                                       v("p_post_over_10k"), np.full(RR, 10000.0))
        self.f2v = v("follow_per_view")
        self.k_fol = v("followers_exponent")
        self.f_ref = v("followers_reference")
        ppd = float(spec.get("posts_per_account_per_day", 1) or 0)
        ramp = min(max((ppd * 7.0 - 1.0) / 6.0, 0.0), 1.0)          # 週1本で0、週7本以上で1
        self.uplift = 1.0 + v("freq_uplift_daily") * ramp
        self.decay = v("same_account_decay_per_post")
        dup = v("cross_account_duplicate_penalty")
        self.dup = np.ones((RR, A))                                  # アカウントごとの重複のペナルティ
        if not self.unique and A > 1:
            self.dup[:, 1:] = (1.0 - dup)[:, None]
        self.jp_share = v("japan_view_share")
        v2i = v("view_to_install")
        half = v("viewer_fatigue_half_views")
        self.lam = (math.log(2.0) / np.maximum(half, 1e-9))[:, None]          # (回, 1)
        self.base = v2i[:, None] * person_q * eligible[None, :]               # 1再生目の設置確率

        self.draws = draws
        self.reach, self.audience, self.acct = [], [], []
        for p in self.platforms:
            reach = pop.sns[R["platforms"][p]["sns_column"]].astype(float)
            self.reach.append(reach)
            self.audience.append(float(np.sum(pop.weight * reach)))
            # アカウントの当たり外れ。(アカウント, 回) の順に引くので、アカウントを増やしても
            # 前からのアカウントの値は変わらない（アカウント数を比べるときに同じ乱数になる）。
            z_acct = draws.rng(f"organic_video:account:{p}").standard_normal((A, RR)).T
            self.acct.append(np.exp(s_between[:, None] * z_acct))
        self.followers = np.zeros((RR, P, A))
        self.posted = 0                          # 1アカウントがこれまでに出した本数（全アカウント同じ）
        self.seen = np.zeros((RR, N))           # これまでに見た回数（期待値）
        self.not_reached = np.ones((RR, N))     # まだ一度も見ていない確率
        self.zero = np.zeros((RR, N))

    def _uniform_like(self, key: str, k: int, normal: bool = False) -> np.ndarray:
        """(回, アカウント, k) の乱数。日・プラットフォーム・種類ごとに流れを分け、(k, アカウント, 回) の順に引く
        （アカウントや1日の本数を増やしても、前からの投稿の乱数は変わらない）。A案・B案は同じ回で同じ乱数。
        mid 回も抽選する（中央値だけでは大当たりの投稿が出ず、平均を大きく下回るため）。"""
        rng = self.draws.rng(key)
        shape = (k, self.accounts, self.RR)
        x = rng.standard_normal(shape) if normal else rng.random(shape)
        return x.transpose(2, 1, 0)

    def post_views(self, pi: int, k: int, t: int = 0) -> np.ndarray:
        """プラットフォーム pi で、t 日目に各アカウントが k 本出したときの1投稿ごとの再生数 (回, アカウント, k)。"""
        A, RR = self.accounts, self.RR
        key = f"organic_video:{self.platforms[pi]}:{t}:"
        fol = np.maximum(1.0, self.followers[:, pi, :A] / self.f_ref[:, None]) ** self.k_fol[:, None]
        n = self.posted + 1 + np.arange(k)                                   # 何本目か
        tired = (1.0 - self.decay[:, None]) ** np.maximum(n[None, :] - FREE_POSTS, 0)   # (回, k)
        adj = (fol * self.dup[:, :A] * self.uplift[:, None])[:, :, None] * tired[:, None, :]
        z = self._uniform_like(key + "z", k, normal=True)
        body = (self.median[:, None, None] * self.acct[pi][:, :A, None]
                * np.exp(self.s_within[:, None, None] * z))
        is_tail = self._uniform_like(key + "tail", k) < self.q_tail[:, None, None]
        u = 1.0 - self._uniform_like(key + "pareto", k)                      # (0, 1]
        tail = self.tail_min[:, None, None] * u ** (-1.0 / self.alpha[:, None, None])
        return np.minimum(np.where(is_tail, tail, body) * adj, self.cap[:, None, None])

    def step(self, t: int, rest: np.ndarray):
        """その日の (設置 (回, 人), 設置確率 (回, 人), 集計 dict（日本全体の実数）)。"""
        k = int(self.posts[t])
        if k <= 0:
            return self.zero, self.zero, {"posts": 0.0, "views": np.zeros(self.RR),
                                          "newly_reached": None, "spend": 0.0}
        A = self.accounts
        f = np.zeros((self.RR, self.N))        # 1人あたりのその日の再生回数
        views = np.zeros(self.RR)
        for pi in range(len(self.platforms)):
            per_account = self.post_views(pi, k, t).sum(axis=2)                  # (回, アカウント)
            self.followers[:, pi, :A] += per_account * self.f2v[:, None]
            total = per_account.sum(axis=1)                                    # (回,)
            views += total
            if self.audience[pi] > 0:
                f += (total * self.jp_share)[:, None] * self.reach[pi][None, :] / self.audience[pi]
        self.posted += k
        lam = self.lam
        h = self.base * (np.exp(-lam * self.seen) - np.exp(-lam * (self.seen + f))) / lam
        p = 1.0 - np.exp(-h)
        newly = self.not_reached * (1.0 - np.exp(-f))
        self.not_reached = self.not_reached - newly
        self.seen = self.seen + f
        videos = A * k if self.unique else k   # 同じ動画を使い回すなら制作は k 本だけ
        stats = {"posts": float(A * k * len(self.platforms)), "views": views,
                 "newly_reached": newly, "spend": videos * self.cost}
        return rest * p, p, stats
