"""ルール YAML の読み込みと、範囲からの抽選。

範囲 low / mid / high からの抽選は「中央値が mid になる二分一様分布」:
  u < 0.5 なら low〜mid の一様、u >= 0.5 なら mid〜high の一様。
1回（run）ごとに u を1つ引き、同じ回では A案・B案が同じ u（＝同じ値）を使う。
最後の1回（index = runs）は u = 0.5 の「mid 回」で、地図と個人の話（sample_run）に使い、範囲の計算には入れない。
"""

from __future__ import annotations

import zlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
RULES_DIR = REPO_ROOT / "rules"


@dataclass
class Rules:
    presets: dict
    channels: dict
    multipliers: dict

    @classmethod
    def load(cls, rules_dir: Path | str = RULES_DIR) -> "Rules":
        rules_dir = Path(rules_dir)
        with open(rules_dir / "presets.yaml", encoding="utf-8") as f:
            presets = yaml.safe_load(f)
        with open(rules_dir / "channels.yaml", encoding="utf-8") as f:
            channels = yaml.safe_load(f)
        with open(rules_dir / "multipliers.yaml", encoding="utf-8") as f:
            multipliers = yaml.safe_load(f)
        return cls(presets=presets, channels=channels, multipliers=multipliers)


def triple(spec: dict) -> tuple[float, float, float]:
    """YAML の値 {low, mid, high} を数の組にする。"""
    return float(spec["low"]), float(spec["mid"]), float(spec["high"])


def split_uniform(spec: dict, u: np.ndarray) -> np.ndarray:
    """u（0〜1）を範囲の値に変える。u = 0.5 で mid。"""
    lo, mid, hi = triple(spec)
    u = np.asarray(u, dtype=float)
    below = lo + (mid - lo) * (2.0 * u)
    above = mid + (hi - mid) * (2.0 * u - 1.0)
    return np.where(u < 0.5, below, above)


@dataclass
class Draws:
    """回ごとの抽選値。名前ごとに乱数の流れを分けるので、呼ぶ順番や案（A/B）に左右されない。"""

    seed: int
    runs: int
    _u: dict = field(default_factory=dict)

    @property
    def n(self) -> int:
        # 最後の1回は mid 回
        return self.runs + 1

    def rng(self, key: str) -> np.random.Generator:
        return np.random.default_rng([self.seed, zlib.crc32(key.encode("utf-8"))])

    def u(self, key: str) -> np.ndarray:
        if key not in self._u:
            u = self.rng("u:" + key).random(self.n)
            u[-1] = 0.5
            self._u[key] = u
        return self._u[key]

    def value(self, key: str, spec: dict, u_key: str | None = None) -> np.ndarray:
        """形 (runs+1,) の抽選値。u_key を同じにした値どうしは同じ方向に動く（例: リテンションの各点）。"""
        return split_uniform(spec, self.u(u_key or key))

    def normal(self, key: str, size: int) -> np.ndarray:
        """人ごとの揺らぎ用の標準正規乱数 (runs+1, size)。mid 回は 0。"""
        z = self.rng("z:" + key).standard_normal((self.n, size))
        z[-1] = 0.0
        return z


# ---------------------------------------------------------------------------
# リテンション曲線
# ---------------------------------------------------------------------------

def retention_curve(d1: float, d7: float, d30: float, horizon: int) -> np.ndarray:
    """設置からの経過日数 a = 0..horizon のアクティブ率 R(a)。

    R(0) = 1、D1・D7・D30 の間は対数で直線補間、30日より後は D7→D30 のべき乗減衰を延長する
    （D90 の出典がないため。rules/presets.yaml の d90）。
    """
    d1 = min(max(d1, 1e-6), 1.0)
    d7 = min(max(d7, 1e-6), d1)
    d30 = min(max(d30, 1e-6), d7)
    a = np.arange(horizon + 1, dtype=float)
    r = np.empty_like(a)
    r[0] = 1.0
    xs = np.array([1.0, 7.0, 30.0])
    ys = np.log(np.array([d1, d7, d30]))
    mid_mask = (a >= 1) & (a <= 30)
    r[mid_mask] = np.exp(np.interp(a[mid_mask], xs, ys))
    b = np.log(d7 / d30) / np.log(30.0 / 7.0)
    tail = a > 30
    r[tail] = d30 * (a[tail] / 30.0) ** (-b)
    return r


# 指数の和で曲線を近似するときの減衰率（1日あたり）
EXP_RATES = np.geomspace(8.0, 0.0008, 12)


def _nnls(a: np.ndarray, b: np.ndarray, iters: int = 200) -> np.ndarray:
    """非負最小二乗（Lawson–Hanson の能動集合法、小さい問題用）。"""
    m, n = a.shape
    x = np.zeros(n)
    passive = np.zeros(n, dtype=bool)
    w = a.T @ (b - a @ x)
    for _ in range(iters):
        if passive.all() or (w[~passive] <= 1e-12).all():
            break
        j = np.argmax(np.where(passive, -np.inf, w))
        passive[j] = True
        while True:
            z = np.zeros(n)
            z[passive] = np.linalg.lstsq(a[:, passive], b, rcond=None)[0]
            if (z[passive] > 0).all():
                x = z
                break
            neg = passive & (z <= 0)
            alpha = np.min(x[neg] / (x[neg] - z[neg]))
            x = x + alpha * (z - x)
            passive &= x > 1e-12
        w = a.T @ (b - a @ x)
    return x


def fit_exponentials(curve: np.ndarray, rates: np.ndarray = EXP_RATES) -> np.ndarray:
    """R(a) ≈ Σ_k α_k exp(-λ_k a) の α を求める（相対誤差で合わせる）。

    毎日のループで、人ごとの「残っている設置」を指数の成分ごとに持てば、
    設置日ごとの履歴を持たずにリテンションを計算できる。
    出典のある点（設置日、D1・D7・D30）は強く合わせ（誤差はおよそ3%以内）、
    その間の補間と30日より後の延長は指数の和の形にまかせる（どちらも仮定の部分）。
    エンジンはこの近似曲線そのものをリテンション曲線として使う（fitted_curve）。
    """
    a = np.arange(len(curve), dtype=float)
    basis = np.exp(-np.outer(a, rates))
    weight = 1.0 / curve
    anchors = [x for x in (0, 1, 7, 30) if x < len(curve)]
    weight[anchors] *= 30.0
    alpha = _nnls(basis * weight[:, None], curve * weight)
    return alpha


def fitted_curve(alpha: np.ndarray, length: int, rates: np.ndarray = EXP_RATES) -> np.ndarray:
    a = np.arange(length, dtype=float)
    return np.exp(-np.outer(a, rates)) @ alpha
