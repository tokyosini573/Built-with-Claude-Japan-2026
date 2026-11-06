"""区間の集計（バックテストの採点用）。

例: 31〜120日目の売上の合計、active の平均。
- 回ごとの日別系列 (回, 日) があれば、回ごとに区間を集計してから分位点を取る（正しい範囲）。
- リプレイ JSON しかないときは、日ごとの p10/p50/p90 を区間で集計する（近似。分位点の和は和の分位点ではない）。
日は 1 始まりで、start と end を含む。
"""

from __future__ import annotations

import numpy as np

HOW = ("sum", "mean", "last", "first")


def _reduce(x: np.ndarray, how: str) -> np.ndarray:
    if how == "sum":
        return x.sum(axis=-1)
    if how == "mean":
        return x.mean(axis=-1)
    if how == "last":
        return x[..., -1]
    if how == "first":
        return x[..., 0]
    raise ValueError(f"how は {HOW} のどれか: {how}")


def _slice(n_days: int, start: int, end: int) -> slice:
    if not (1 <= start <= end <= n_days):
        raise ValueError(f"区間 {start}〜{end} 日目が期間 1〜{n_days} 日目の外です")
    return slice(start - 1, end)


def interval_runs(series: np.ndarray, start: int, end: int, how: str = "sum") -> np.ndarray:
    """series: (回, 日) または (日,)。回ごとの区間集計を返す。"""
    series = np.asarray(series, dtype=float)
    return _reduce(series[..., _slice(series.shape[-1], start, end)], how)


def interval_band(series: np.ndarray, start: int, end: int, how: str = "sum", runs: int | None = None) -> dict:
    """回ごとに区間を集計してから p10 / p50 / p90。runs を渡すと先頭 runs 回だけ（mid 回を除く）。"""
    v = interval_runs(series, start, end, how)
    if runs is not None:
        v = v[:runs]
    q = np.percentile(v, [10, 50, 90])
    return {"p10": float(q[0]), "p50": float(q[1]), "p90": float(q[2])}


def interval_from_replay(replay: dict, plan: str, metric: str, start: int, end: int,
                         how: str = "sum", japan: bool = False) -> dict:
    """リプレイ JSON の daily から区間を集計する（近似）。japan=True なら日本全体に換算。"""
    band = replay["plans"][plan]["daily"][metric]
    scale = replay["meta"]["scale_to_japan"] if japan else 1.0
    out = {}
    for k in ("p10", "p50", "p90"):
        x = np.asarray(band[k], dtype=float)
        out[k] = float(_reduce(x[_slice(len(x), start, end)], how)) * scale
    return out
