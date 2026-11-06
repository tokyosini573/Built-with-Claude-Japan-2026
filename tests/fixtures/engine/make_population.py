"""テスト用の小さな合成人口（1,000人）を作る。統計ではなく、エンジンのテスト専用。

.venv/bin/python tests/fixtures/engine/make_population.py
"""

from pathlib import Path

import numpy as np
import pandas as pd

N = 1000
SEED = 7


def make(n: int = N, seed: int = SEED) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    age = rng.integers(15, 80, n)
    sex = rng.choice(["M", "F"], n)
    pref = rng.choice([13, 14, 11, 12, 27, 1, 47], n, p=[0.3, 0.2, 0.15, 0.1, 0.15, 0.05, 0.05])
    city = rng.choice(["metro", "city", "town"], n, p=[0.4, 0.5, 0.1])
    emp = np.where(age < 23, "student", rng.choice(["regular", "nonregular", "self_employed",
                                                    "unemployed_homemaker", "retired"], n))
    phone = rng.random(n) < np.where(age < 70, 0.95, 0.7)
    young = age < 40

    def sns(p_young, p_old):
        return phone & (rng.random(n) < np.where(young, p_young, p_old))

    lv = ["low", "mid", "high"]
    df = pd.DataFrame({
        "person_id": np.arange(n),
        "age": age,
        "sex": sex,
        "pref_code": pref,
        "pref_name": "",
        "city_size": city,
        "marital": np.where(age < 30, "unmarried", "married"),
        "household": "single",
        "employment": emp,
        "income_band": "none",
        "has_smartphone": phone,
        "os": np.where(phone, "ios", "none"),
        "sns_line": sns(0.95, 0.8),
        "sns_x": sns(0.6, 0.25),
        "sns_instagram": sns(0.7, 0.3),
        "sns_tiktok": sns(0.5, 0.1),
        "sns_youtube": sns(0.95, 0.7),
        "trait_price": rng.choice(lv, n),
        "trait_novelty": rng.choice(lv, n),
        "trait_privacy": rng.choice(lv, n),
        "trait_wom": rng.choice(lv, n),
        "trait_ad_aversion": rng.choice(lv, n),
        "weight": 96_806_585 / n,
        "cluster_id": (age // 10 - 1) * 2 + (sex == "M"),
    })
    return df


if __name__ == "__main__":
    out = Path(__file__).parent
    df = make()
    df.to_csv(out / "population_small.csv", index=False)
    reps = (df.groupby("cluster_id").agg(person_id=("person_id", "first"), cluster_size=("person_id", "size"),
                                          cluster_weight=("weight", "sum")).reset_index())
    reps["label_ja"] = ["テスト用クラスター" + str(c) for c in reps["cluster_id"]]
    reps.to_csv(out / "representatives.csv", index=False)
    print(len(df), len(reps))
