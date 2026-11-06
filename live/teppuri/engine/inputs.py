"""人口・アプリ・判断の読み込み（契約 v0 §1〜§3）。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from .rules import REPO_ROOT

SNS_COLUMNS = ["sns_line", "sns_x", "sns_instagram", "sns_tiktok", "sns_youtube"]
TRAIT_COLUMNS = ["trait_price", "trait_novelty", "trait_privacy", "trait_wom", "trait_ad_aversion"]
JAPAN_TOTAL = 96_806_585  # 2025年国勢調査 15〜79歳（契約 §1）
BASIS = 10_000  # 数字は1万人基準

DEFAULT_POPULATION = REPO_ROOT / "data" / "population" / "japan_10k.csv"
DEFAULT_REPRESENTATIVES = REPO_ROOT / "data" / "population" / "representatives.csv"


def _bool(series: pd.Series) -> np.ndarray:
    if series.dtype == bool:
        return series.to_numpy()
    return series.astype(str).str.strip().str.lower().isin(["true", "1", "yes"]).to_numpy()


@dataclass
class Population:
    df: pd.DataFrame
    person_id: np.ndarray
    age: np.ndarray
    male: np.ndarray
    pref: np.ndarray
    city_size: np.ndarray
    employment: np.ndarray
    smartphone: np.ndarray
    sns: dict
    traits: dict
    weight: np.ndarray
    cluster: np.ndarray
    representatives: pd.DataFrame | None

    @property
    def n(self) -> int:
        return len(self.person_id)

    @property
    def scale(self) -> float:
        """1万人基準の1人 = 日本の何人か。"""
        return float(self.weight.sum()) / BASIS

    @classmethod
    def load(cls, path: Path | str = DEFAULT_POPULATION,
             representatives: Path | str | None = None) -> "Population":
        path = Path(path)
        df = pd.read_csv(path)
        rep_path = Path(representatives) if representatives else path.parent / "representatives.csv"
        if not rep_path.exists() and path == DEFAULT_POPULATION:
            rep_path = DEFAULT_REPRESENTATIVES
        reps = pd.read_csv(rep_path) if rep_path.exists() else None
        return cls.from_frame(df, reps)

    @classmethod
    def from_frame(cls, df: pd.DataFrame, reps: pd.DataFrame | None = None) -> "Population":
        df = df.sort_values("person_id").reset_index(drop=True)
        weight = df["weight"].to_numpy(dtype=float) if "weight" in df else np.full(len(df), JAPAN_TOTAL / len(df))
        cluster = df["cluster_id"].to_numpy(dtype=int) if "cluster_id" in df else np.zeros(len(df), dtype=int)
        employment = (df["employment"].astype(str).to_numpy() if "employment" in df
                      else np.array(["unknown"] * len(df)))
        return cls(
            df=df,
            person_id=df["person_id"].to_numpy(dtype=int),
            age=df["age"].to_numpy(dtype=int),
            male=(df["sex"].astype(str) == "M").to_numpy(),
            pref=df["pref_code"].to_numpy(dtype=int),
            city_size=df["city_size"].astype(str).to_numpy(),
            employment=employment,
            smartphone=_bool(df["has_smartphone"]),
            sns={c: _bool(df[c]) for c in SNS_COLUMNS},
            traits={c: df[c].astype(str).to_numpy() for c in TRAIT_COLUMNS},
            weight=weight,
            cluster=cluster,
            representatives=reps,
        )


def load_app(path: Path | str) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def default_decisions_path(app: dict) -> Path:
    return REPO_ROOT / "runs" / str(app["app_id"]) / "decisions.json"


def load_decisions(path: Path | str | None) -> list[dict]:
    """判断ファイルがなければ空（＝全て similar）。"""
    if path is None:
        return []
    path = Path(path)
    if not path.exists() and Path(str(path) + ".gz").exists():  # コミット用の decisions.json.gz も読む
        path = Path(str(path) + ".gz")
    if not path.exists():
        return []
    if path.suffix == ".gz":
        import gzip
        with gzip.open(path, "rt", encoding="utf-8") as f:
            data = json.load(f)
    else:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    return data if isinstance(data, list) else data.get("decisions", [])


def creative_id(path_or_id: str) -> str:
    """ads/a1.png → a1"""
    return Path(str(path_or_id)).stem
