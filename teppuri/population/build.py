"""架空の日本1万人（15〜79歳）と代表人物を作る。LLM は使わない。

実行: python -m teppuri.population.build
出力:
  data/population/japan_10k.csv        1行1人、10,000行（契約 v0 §1）
  data/population/representatives.csv  代表人物（300〜500行）

作り方の要点
1. 都道府県 × 性 × 5歳階級（1,222セル）に 10,000人を最大剰余法で配分する（乱数なし）。
2. 残りの属性は、出典 CSV の条件付き分布から付ける。
   各条件グループ（例: 性 × 年齢）の人数に対して、期待値を保つ丸め（controlled rounding）で
   区分ごとの人数を決め、グループ内でランダムに割り振る。こうすると、グループごとの比率が
   出典とほぼ一致し（1人単位の誤差）、単純な抽選より出典からのぶれが小さい。
3. 性 × 年齢（または 都道府県 × 性 × 年齢）以外の属性どうしの相関は入れない（条件付き独立）。
   例外: 配偶関係と世帯類型は結合分布から同時に付ける。SNS どうしはガウシアンコピュラ
   （ρ = 0.5、DATA_SOURCES 5章 限界3 の設計値）で相関を入れる（各 SNS の人数は変わらない）。
どの属性をどの CSV のどの条件で付けたかは ATTRIBUTE_SOURCES と data/population/README.md に書く。
"""

from __future__ import annotations

import csv
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "data" / "sources"
OUT_DIR = ROOT / "data" / "population"

SEED = 20261108
N_PEOPLE = 10_000
TOTAL_POP = 96_806_585  # 2025年国勢調査 15〜79歳（DATA_SOURCES 2-1）
SNS_RHO = 0.5           # SNS 間の相関（設計値、DATA_SOURCES 5章 限界3）
IOS_SEX_GAP = 5.6       # OS の性差 d（ポイント、DATA_SOURCES 2-7）。女性 +d/2、男性 −d/2

AGE5 = ["15-19", "20-24", "25-29", "30-34", "35-39", "40-44", "45-49",
        "50-54", "55-59", "60-64", "65-69", "70-74", "75-79"]
SEXES = ["M", "F"]
SNS = ["line", "x", "instagram", "tiktok", "youtube"]
TRAITS = {  # 契約の列名 → trait_mapping_sex_age.csv の trait
    "trait_price": "price_sensitivity",
    "trait_novelty": "novelty",
    "trait_privacy": "privacy_concern",
    "trait_wom": "review_reliance",
    "trait_ad_aversion": "ad_aversion",
}
CITY = {"daitoshi": "metro", "other_shi": "city", "chouson": "town"}
EMPLOYMENT = ["regular", "nonregular", "self_employed", "student", "unemployed_homemaker", "retired"]
MARITAL = {"1_未婚": "unmarried", "2_有配偶": "married", "3_死別": "widowed_divorced", "4_離別": "widowed_divorced"}
HOUSEHOLD = ["single_living_alone", "couple_only", "parent_with_children",
             "unmarried_child_with_parents", "extended_or_other"]
# 所得（万円/年）。就業構造基本調査の16階級 + 所得なし
INCOME_BANDS = [  # (slug, 下限, 上限)
    ("lt50", 0, 50), ("50_99", 50, 100), ("100_149", 100, 150), ("150_199", 150, 200),
    ("200_249", 200, 250), ("250_299", 250, 300), ("300_399", 300, 400), ("400_499", 400, 500),
    ("500_599", 500, 600), ("600_699", 600, 700), ("700_799", 700, 800), ("800_899", 800, 900),
    ("900_999", 900, 1000), ("1000_1249", 1000, 1250), ("1250_1499", 1250, 1500), ("1500_plus", 1500, 1500),
]
# 年金額（万円/年）。国民生活基礎調査 第81表の13階級。最上位「300万円以上」は 300 として扱う
PENSION_BANDS = [("２０万円未満", 0, 20), ("２０～４０", 20, 40), ("４０～６０", 40, 60), ("６０～８０", 60, 80),
                 ("８０～１００", 80, 100), ("１００～１２０", 100, 120), ("１２０～１４０", 120, 140),
                 ("１４０～１６０", 140, 160), ("１６０～１８０", 160, 180), ("１８０～２００", 180, 200),
                 ("２００～２５０", 200, 250), ("２５０～３００", 250, 300), ("３００万円以上", 300, 300)]

# 属性ごとの出典と条件（README とテストでも使う）
ATTRIBUTE_SOURCES = {
    "pref_code/sex/age": ("demographics/derived_pop_pref_sex_age_15-79_census2025.csv",
                          "都道府県×性×5歳階級に最大剰余法で配分。各歳は階級内で一様", "DATA_SOURCES 2-1"),
    "city_size": ("demographics2/derived_citysize_pref_sex_age_15-79_census2025.csv",
                  "都道府県×性×5歳階級", "DATA_SOURCES 2-2"),
    "marital/household": ("demographics/derived_census2025_t5_pref_sex_marital_hhtype_age_15-79.csv",
                          "都道府県×性×5歳階級（配偶関係と世帯類型の結合分布）", "DATA_SOURCES 2-3"),
    "employment": ("demographics2/derived_employment6_sex_age_lfs2025avg.csv ほか",
                   "都道府県×性×5歳階級（全国水準は労働力調査2025、都道府県差は2020年国勢調査）", "DATA_SOURCES 2-4"),
    "income_band": ("demographics/derived_income_dist_sex_age_emptype_shugyo2022.csv、"
                    "demographics2/derived_pension_dist_sex_age_kokumin2025.csv",
                    "性×5歳階級×就業形態（勤労所得）＋性×年齢（年金）", "DATA_SOURCES 2-5"),
    "has_smartphone": ("demographics2/derived_tsushin2025_smartphone_sns_by_sex_age.csv",
                       "性×年齢（15-19、10歳階級、60歳以上は5歳階級）", "DATA_SOURCES 2-6"),
    "os": ("digital/mobaken_20260319/20260319_04〜10.csv", "性×10歳階級（スマホ保有者）", "DATA_SOURCES 2-7"),
    "sns_*": ("digital/derived_media2025_sns_smartphone_by_age.csv、"
              "demographics2/derived_mobaken2026_sns_freq_by_sex_age.csv",
              "水準は性×10歳階級、スマホ保有者の中で性×第24表の年齢帯に割り振り", "DATA_SOURCES 2-8"),
    "trait_*": ("psychographics/trait_mapping_sex_age.csv", "性×10歳階級（15-19は別）", "DATA_SOURCES 2-12"),
}


# ---------------------------------------------------------------------------
# 丸めと割り振り
# ---------------------------------------------------------------------------

def largest_remainder(weights: np.ndarray, total: int) -> np.ndarray:
    """重みに比例して整数 total を配分する（最大剰余法、乱数なし）。"""
    w = np.asarray(weights, dtype=float)
    quota = w / w.sum() * total
    base = np.floor(quota).astype(int)
    rest = total - base.sum()
    order = np.argsort(-(quota - base), kind="stable")
    base[order[:rest]] += 1
    return base


def controlled_round(n: int, probs: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """n 人を確率 probs に従って区分に分ける人数。

    floor(n·p) を先に確定し、残りは端数に比例して重複なしで抽選する。
    各区分の人数の期待値は n·p のままで、ずれは1人未満になる。
    """
    p = np.clip(np.asarray(probs, dtype=float), 0, None)
    if p.sum() <= 0:
        raise ValueError("確率がすべて0")
    p = p / p.sum()
    quota = n * p
    base = np.floor(quota + 1e-9).astype(int)
    rest = n - base.sum()
    if rest > 0:
        frac = np.clip(quota - base, 0, None)
        if frac.sum() <= 0:
            frac = p.copy()
        pick = rng.choice(len(p), size=rest, replace=False, p=frac / frac.sum())
        base[pick] += 1
    return base


def assign_by_group(df: pd.DataFrame, mask: pd.Series, group_cols: list[str], prob_fn,
                    rng: np.random.Generator) -> pd.Series:
    """mask の人を group_cols でまとめ、prob_fn(key) -> (区分, 確率) から区分を割り振る。"""
    out = pd.Series(index=df.index, dtype=object)
    sub = df[mask]
    for key, idx in sub.groupby(group_cols, sort=True).groups.items():
        cats, probs = prob_fn(key if isinstance(key, tuple) else (key,))
        counts = controlled_round(len(idx), probs, rng)
        labels = np.repeat(np.asarray(cats, dtype=object), counts)
        rng.shuffle(labels)
        out.loc[idx] = labels
    return out


# ---------------------------------------------------------------------------
# 年齢帯の変換
# ---------------------------------------------------------------------------

def band10(age5: str) -> str:
    """5歳階級 → 10歳階級（15-19 は別扱い）。メディア調査・モバイル社会研究所の「10代」と同じ。"""
    lo = int(age5[:2])
    return "10s" if lo < 20 else f"{lo // 10 * 10}s"


def tsushin_band(age5: str) -> str:
    lo = int(age5[:2])
    if lo < 20 or lo >= 60:
        return age5
    return f"{lo // 10 * 10}-{lo // 10 * 10 + 9}"


def trait_band(age5: str) -> str:
    lo = int(age5[:2])
    return "15～19歳" if lo < 20 else f"{lo // 10 * 10}～{lo // 10 * 10 + 9}歳"


def pension_band(age5: str) -> str:
    return "15-59" if int(age5[:2]) < 60 else age5


# ---------------------------------------------------------------------------
# 出典の読み込み
# ---------------------------------------------------------------------------

def _sex_code(s: str) -> str:
    return {"1_男": "M", "2_女": "F", "male": "M", "female": "F", "M": "M", "F": "F"}[s]


def load_population_cells() -> pd.DataFrame:
    """都道府県 × 性 × 5歳階級の人口（長い形式）。"""
    df = pd.read_csv(SRC / "demographics/derived_pop_pref_sex_age_15-79_census2025.csv")
    df = df[df["pref"] != "00000_全国"]
    long = df.melt(id_vars=["pref", "sex"], value_vars=AGE5, var_name="age5", value_name="pop")
    long["pref_code"] = long["pref"].str[:2].astype(int)
    long["pref_name"] = long["pref"].str.split("_").str[1]
    long["sex"] = long["sex"].map(_sex_code)
    return long.sort_values(["pref_code", "sex", "age5"], key=lambda s: s.map(
        {a: i for i, a in enumerate(AGE5)}) if s.name == "age5" else s).reset_index(drop=True)


def load_citysize() -> dict:
    df = pd.read_csv(SRC / "demographics2/derived_citysize_pref_sex_age_15-79_census2025.csv")
    df["pref_code"] = df["pref"].str[:2].astype(int)
    df["sex"] = df["sex"].map(_sex_code)
    table = {}
    for (p, s, a), g in df.groupby(["pref_code", "sex", "age"]):
        g = g.set_index("citysize")["pop"]
        table[(p, s, a)] = np.array([g.get(k, 0) for k in CITY], dtype=float)
    return table


def household_class(marital: str, hhtype_en: str) -> str:
    """t5 の世帯の家族類型 → 5分類（DATA_SOURCES 2-3 の再編規則）。"""
    if hhtype_en == "one_person":
        return "single_living_alone"
    if hhtype_en == "couple_only":
        return "couple_only"
    if hhtype_en in ("couple_children", "single_father_children", "single_mother_children"):
        return "unmarried_child_with_parents" if marital == "1_未婚" else "parent_with_children"
    return "extended_or_other"


def load_marital_household() -> dict:
    """(pref_code, sex, age5) → {(marital, household): 人数}。配偶関係「不詳」は除く。"""
    df = pd.read_csv(SRC / "demographics/derived_census2025_t5_pref_sex_marital_hhtype_age_15-79.csv")
    df = df[(df["pref"] != "00000_全国") & (df["sex"] != "0_総数")
            & (df["marital"].isin(MARITAL.keys())) & (df["hhtype"] != "0_総数")]
    df = df.assign(pref_code=df["pref"].str[:2].astype(int), sex=df["sex"].map(_sex_code),
                   mar=df["marital"].map(MARITAL),
                   hh=[household_class(m, h) for m, h in zip(df["marital"], df["hhtype_en"])])
    long = df.melt(id_vars=["pref_code", "sex", "mar", "hh"], value_vars=AGE5, var_name="age5", value_name="n")
    agg = long.groupby(["pref_code", "sex", "age5", "mar", "hh"])["n"].sum()
    table: dict = {}
    for (p, s, a, m, h), n in agg.items():
        table.setdefault((p, s, a), {})[(m, h)] = n
    return table


def load_employment() -> dict:
    """(pref_code, sex, age5) → 6区分の確率。DATA_SOURCES 2-4 の方法。

    q(都道府県) = 2020国勢調査の都道府県比率 × (労働力調査2025の全国比率 ÷ 2020国勢調査の全国比率) を再正規化。
    労働力調査の「70歳以上」は 2020年国勢調査の 70〜74 / 75〜79 / 70歳以上 の比で分ける。
    """
    cats20 = ["regular", "nonregular", "selfemp_exec", "student", "unemployed_homemaker", "retired_proxy"]
    lfs = pd.read_csv(SRC / "demographics2/derived_employment6_sex_age_lfs2025avg.csv")
    lfs = lfs[lfs["sex"] != "total"]
    lfs_cols = ["regular", "nonregular", "self_exec_family", "student", "unemployed_or_housework",
                "retired_or_other_nilf"]
    L = {(_sex_code(r.sex), r.age): np.array([getattr(r, c) for c in lfs_cols]) / 100 for r in lfs.itertuples()}
    c70 = pd.read_csv(SRC / "demographics/derived_employment6_sex_70plus_national_census2020.csv")
    C70 = {(_sex_code(r.sex), r.age): np.array([getattr(r, c) for c in cats20]) for r in c70.itertuples()}
    for s in SEXES:
        for a in ("70-74", "75-79"):
            ratio = np.divide(C70[(s, a)], C70[(s, "70+")], out=np.zeros(6), where=C70[(s, "70+")] > 0)
            v = L[(s, "70+")] * ratio
            L[(s, a)] = v / v.sum()

    e20 = pd.read_csv(SRC / "demographics/derived_employment6_pref_sex_age_census2020.csv")
    e20.columns = ["pref", "sex", "age"] + cats20 + ["base", "check"]
    e20["pref_code"] = e20["pref"].str[:2].astype(int)
    e20["sex"] = e20["sex"].map(_sex_code)
    nat = {(r.sex, r.age): np.array([getattr(r, c) for c in cats20]) for r in e20[e20.pref_code == 0].itertuples()}
    table = {}
    for r in e20[e20.pref_code > 0].itertuples():
        c_pref = np.array([getattr(r, c) for c in cats20])
        c_nat = nat[(r.sex, r.age)]
        lv = L[(r.sex, r.age)]
        q = np.where(c_nat > 0, c_pref * np.divide(lv, c_nat, out=np.zeros(6), where=c_nat > 0), lv)
        table[(r.pref_code, r.sex, r.age)] = q / q.sum()
    return table


def load_income() -> tuple[dict, dict, dict]:
    inc = pd.read_csv(SRC / "demographics/derived_income_dist_sex_age_emptype_shugyo2022.csv")
    band_cols = list(inc.columns[4:])
    assert len(band_cols) == len(INCOME_BANDS)
    work = {}
    for r in inc.itertuples(index=False):
        age5 = r.age.replace("～", "-").replace("歳", "")
        work[(_sex_code(r.sex), age5, r.emptype)] = np.array(r[4:], dtype=float)
    pen = pd.read_csv(SRC / "demographics2/derived_pension_dist_sex_age_kokumin2025.csv")
    pen = pen[pen["sex"] != "total"]
    pension = {}
    cats = [b[0] for b in PENSION_BANDS] + ["受給なし"]
    for (s, a), g in pen.groupby(["sex", "age"]):
        g = g.set_index("category")["share_pct_of_age_sex"]
        pension[(_sex_code(s), a)] = np.array([g[c] for c in cats], dtype=float)
    own = pd.read_csv(SRC / "demographics/derived_selfemp_owner_share_sex_age_national_census2020.csv")
    owner = {(_sex_code(r.sex), r.age): r.owner_share for r in own.itertuples()}
    return work, pension, owner


def load_smartphone() -> dict:
    df = pd.read_csv(SRC / "demographics2/derived_tsushin2025_smartphone_sns_by_sex_age.csv")
    df = df[df["sex"] != "total"]
    return {(_sex_code(r["sex"]), r["age"]): r["smartphone_pct_all(t24)"] / 100 for _, r in df.iterrows()}


def _read_mobaken_csv(path: Path) -> list[list[str]]:
    for enc in ("utf-8-sig", "cp932"):
        try:
            with open(path, encoding=enc) as f:
                return list(csv.reader(f))
        except UnicodeDecodeError:
            continue
    raise ValueError(path)


def load_ios_share() -> dict:
    """10歳階級 → スマホ利用者のうち iPhone の比率（2026年、性別なし）。"""
    bands = {"04": "10s", "05": "20s", "06": "30s", "07": "40s", "08": "50s", "09": "60s", "10": "70s"}
    out = {}
    for num, band in bands.items():
        rows = _read_mobaken_csv(SRC / f"digital/mobaken_20260319/20260319_{num}.csv")
        header = rows[1]
        assert header[-1].startswith("2026年"), header
        iphone = next(r for r in rows if len(r) > 1 and r[1] == "iPhone")
        out[band] = float(iphone[-1]) / 100
    return out


def load_sns() -> tuple[dict, dict]:
    """(service, sex, band10) → 人口全体での利用率、band10 → メディア調査のスマホ利用率。

    DATA_SOURCES 2-8: P(k|a,s) = P_media(k|a) × r(k,a,s)、
    r = u(k,a,s) ÷ Σ_s w(a,s)·u(k,a,s)（u = モバイル社会研究所の認知者のうち利用率、w = 国勢調査の性比）。
    LINE・YouTube は表5-1-1 の男女別 ÷ 全体 を年齢に関係なく掛ける。
    """
    media = pd.read_csv(SRC / "digital/derived_media2025_sns_smartphone_by_age.csv").set_index("item")
    bands = ["10s", "20s", "30s", "40s", "50s", "60s", "70s"]
    mob = pd.read_csv(SRC / "demographics2/derived_mobaken2026_sns_freq_by_sex_age.csv")
    mob["service"] = mob["service"].str.lower()
    u = {(r.service, _sex_code(r.sex), r.age): r.use_pct_among_aware for r in mob.itertuples()}
    cells = load_population_cells()
    cells["band"] = cells["age5"].map(band10)
    pop = cells.groupby(["band", "sex"])["pop"].sum()
    out = {}
    for k in SNS:
        for b in bands:
            level = media.loc[k, b] / 100
            w = {s: pop[(b, s)] / (pop[(b, "M")] + pop[(b, "F")]) for s in SEXES}
            for s in SEXES:
                if k in ("line", "youtube"):
                    r = media.loc[k, "male" if s == "M" else "female"] / media.loc[k, "total"]
                else:
                    denom = sum(w[t] * u[(k, t, b)] for t in SEXES)
                    r = u[(k, s, b)] / denom
                out[(k, s, b)] = level * r
    smart_media = {b: media.loc["smartphone", b] / 100 for b in bands}
    return out, smart_media


def sns_rate_among_holders(sns: dict, smart: dict, k: str, s: str, tband: str) -> float:
    """スマホ保有者の中での SNS 利用率 = min(1, P(k|a,s) ÷ P_gen(スマホ|a,s))。

    tband は通信利用動向調査の年齢帯（15-19 / 20-29 … / 60-64 / 65-69 / 70-74 / 75-79）。
    SNS の水準は10歳階級なので、60代・70代は同じ P(k|a,s) を2つの5歳階級で使う。
    """
    return min(1.0, sns[(k, s, band10(tband))] / smart[(s, tband)])


def sns_capped_cells() -> list[tuple[str, str, str, float, float]]:
    """上限1で切れて、人口全体の率が出典に届かないセル (service, sex, tband, 出典, 届く上限)。"""
    sns, _ = load_sns()
    smart = load_smartphone()
    out = []
    for (s, tb), p_smart in sorted(smart.items()):
        for k in SNS:
            target = sns[(k, s, band10(tb))]
            if target > p_smart:
                out.append((k, s, tb, target, p_smart))
    return out


def load_traits() -> dict:
    df = pd.read_csv(SRC / "psychographics/trait_mapping_sex_age.csv")
    return {(r.trait, r.sex, r.age): np.array([r.P_low, r.P_mid, r.P_high], dtype=float) for r in df.itertuples()}


# ---------------------------------------------------------------------------
# 人口の生成
# ---------------------------------------------------------------------------

def build_people(seed: int = SEED) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    cells = load_population_cells()
    cells["n"] = largest_remainder(cells["pop"].to_numpy(), N_PEOPLE)
    df = cells.loc[cells.index.repeat(cells["n"]), ["pref_code", "pref_name", "sex", "age5"]].reset_index(drop=True)
    lo = df["age5"].str[:2].astype(int).to_numpy()
    df["age"] = lo + rng.integers(0, 5, size=len(df))
    everyone = pd.Series(True, index=df.index)

    # 都市規模
    city = load_citysize()
    df["city_size"] = assign_by_group(df, everyone, ["pref_code", "sex", "age5"],
                                      lambda k: (list(CITY.values()), city[k]), rng)

    # 配偶関係 × 世帯類型（結合分布）
    mh = load_marital_household()

    def mh_probs(k):
        d = mh[k]
        keys = sorted(d)
        return [f"{m}|{h}" for m, h in keys], np.array([d[x] for x in keys], dtype=float)

    joint = assign_by_group(df, everyone, ["pref_code", "sex", "age5"], mh_probs, rng)
    df["marital"] = joint.str.split("|").str[0]
    df["household"] = joint.str.split("|").str[1]

    # 就業形態
    emp = load_employment()
    df["employment"] = assign_by_group(df, everyone, ["pref_code", "sex", "age5"], lambda k: (EMPLOYMENT, emp[k]), rng)

    # 所得: 勤労所得（就業者）＋ 年金（全員、年齢別の受給なしを含む）
    work, pension, owner = load_income()
    emp_map = {"regular": "regular", "nonregular": "nonregular"}

    def work_probs(k):
        s, a, e = k
        if e == "self_employed":
            sh = owner[(s, a)]
            p = sh * work[(s, a, "self_employed")] + (1 - sh) * work[(s, a, "all_employed")]
        else:
            p = work[(s, a, emp_map[e])]
        return list(range(len(INCOME_BANDS))), p

    employed = df["employment"].isin(["regular", "nonregular", "self_employed"])
    work_band = assign_by_group(df, employed, ["sex", "age5", "employment"], work_probs, rng)
    df["_pband"] = df["age5"].map(pension_band)
    pen_band = assign_by_group(df, everyone, ["sex", "_pband"],
                               lambda k: (list(range(len(PENSION_BANDS) + 1)), pension[k]), rng)
    amount = np.zeros(len(df))
    has_income = np.zeros(len(df), dtype=bool)
    for i in range(len(df)):
        wb = work_band.iat[i]
        if wb == wb and wb is not None:  # NaN でない＝就業者
            _, l, h = INCOME_BANDS[int(wb)]
            amount[i] += rng.uniform(l, h) if h > l else l
            has_income[i] = True
        pb = int(pen_band.iat[i])
        if pb < len(PENSION_BANDS):
            _, l, h = PENSION_BANDS[pb]
            amount[i] += rng.uniform(l, h) if h > l else l
            has_income[i] = True
    edges = [b[1] for b in INCOME_BANDS[1:]]
    idx = np.searchsorted(edges, amount, side="right")
    df["income_band"] = np.where(has_income, [INCOME_BANDS[j][0] for j in idx], "none")

    # スマートフォン保有
    smart = load_smartphone()
    df["_tband"] = df["age5"].map(tsushin_band)
    sp = assign_by_group(df, everyone, ["sex", "_tband"], lambda k: ([True, False], [smart[k], 1 - smart[k]]), rng)
    df["has_smartphone"] = sp.astype(bool)
    holders = df["has_smartphone"]

    # OS（スマホ保有者のみ）
    ios = load_ios_share()
    df["_band10"] = df["age5"].map(band10)

    def os_probs(k):
        s, b = k
        p = ios[b] + (IOS_SEX_GAP / 200 if s == "F" else -IOS_SEX_GAP / 200)
        return ["ios", "android"], [p, 1 - p]

    df["os"] = assign_by_group(df, holders, ["sex", "_band10"], os_probs, rng).fillna("none")

    # SNS（スマホ保有者のみ）。保有者の中での率 = min(1, P(k|a,s) ÷ P_gen(スマホ|a,s))。
    # P_gen は実際に付けたスマホ保有率（第24表、性×年齢）なので、人口全体の率が P(k|a,s) と一致する
    # （上限1で切れるセルだけ不足が残る。sns_capped_cells() 参照）。
    sns, _ = load_sns()
    for k in SNS:
        df[f"sns_{k}"] = False
    cov = np.full((len(SNS), len(SNS)), SNS_RHO)
    np.fill_diagonal(cov, 1.0)
    for (s, tb), idx in df[holders].groupby(["sex", "_tband"], sort=True).groups.items():
        n = len(idx)
        z = rng.multivariate_normal(np.zeros(len(SNS)), cov, size=n)
        for j, k in enumerate(SNS):
            p = sns_rate_among_holders(sns, smart, k, s, tb)
            c = controlled_round(n, [p, 1 - p], rng)[0]
            top = np.argsort(-z[:, j], kind="stable")[:c]
            df.loc[np.asarray(idx)[top], f"sns_{k}"] = True

    # 性向5指標
    tr = load_traits()
    df["_trband"] = df["age5"].map(trait_band)
    for col, name in TRAITS.items():
        df[col] = assign_by_group(df, everyone, ["sex", "_trband"],
                                  lambda k, name=name: (["low", "mid", "high"], tr[(name, k[0], k[1])]), rng)

    df["weight"] = TOTAL_POP / N_PEOPLE
    df.insert(0, "person_id", np.arange(len(df)))
    return df


# ---------------------------------------------------------------------------
# 代表人物（クラスタ）
# ---------------------------------------------------------------------------

CLUSTER_AGE_BANDS = [(15, 19, "10代後半"), (20, 24, "20代前半"), (25, 29, "20代後半"), (30, 34, "30代前半"),
                     (35, 39, "30代後半"), (40, 49, "40代"), (50, 59, "50代"), (60, 69, "60代"), (70, 79, "70代")]
CITY_JA = {"metro": "大都市", "city": "地方都市", "town": "町村"}
TRAIT_WORDS = {
    "trait_price": ("出費をためらわない", "節約志向"),
    "trait_novelty": ("新しいものに慎重", "新しいもの好き"),
    "trait_privacy": ("個人情報をあまり気にしない", "個人情報に敏感"),
    "trait_wom": ("口コミに左右されない", "口コミ重視"),
    "trait_ad_aversion": ("広告に抵抗なし", "広告嫌い"),
}
TARGET_CLUSTERS = 400
MIN_CLUSTER = 8


def _kmeans(x: np.ndarray, k: int, rng: np.random.Generator, iters: int = 30) -> np.ndarray:
    """小さな k-means（k-means++ 初期化）。ラベルを返す。"""
    n = len(x)
    if k <= 1 or n <= k:
        return np.zeros(n, dtype=int) if k <= 1 else np.arange(n)
    centers = [x[rng.integers(n)]]
    for _ in range(1, k):
        d = np.min(((x[:, None, :] - np.array(centers)[None]) ** 2).sum(-1), axis=1)
        if d.sum() == 0:
            centers.append(x[rng.integers(n)])
        else:
            centers.append(x[rng.choice(n, p=d / d.sum())])
    c = np.array(centers, dtype=float)
    labels = np.zeros(n, dtype=int)
    for _ in range(iters):
        d = ((x[:, None, :] - c[None]) ** 2).sum(-1)
        new = np.argmin(d, axis=1)
        if np.array_equal(new, labels) and _ > 0:
            break
        labels = new
        for j in range(k):
            if (labels == j).any():
                c[j] = x[labels == j].mean(0)
    return labels


MARITAL_CLASS = {"unmarried": "never", "married": "ever", "widowed_divorced": "ever"}
MARITAL_JA = {
    frozenset({"unmarried"}): "未婚",
    frozenset({"married"}): "既婚",
    frozenset({"widowed_divorced"}): "離別・死別",
    frozenset({"married", "widowed_divorced"}): "既婚・離死別",
}


def build_groups(df: pd.DataFrame) -> list[dict]:
    """ペルソナ要約の単位となるグループ（年齢帯 × 性 × 都市規模 × 婚姻）を作る。

    MIN_CLUSTER 人未満のグループは、次の順で隣のグループに統合する（都市規模と性はまたがない）。
      1. 同じ年齢帯・性・都市規模の married ⇔ widowed_divorced（「既婚・離死別」になる）
      2. 同じ性・都市規模・婚姻（未婚 / 結婚経験あり）で、隣の年齢帯（人数の少ない方、同数なら若い方）
      3. 同じ年齢帯・性・都市規模の別の婚姻（最後の手段。ラベルは「未婚・既婚」など）
    """
    band_idx = np.zeros(len(df), dtype=int)
    for i, (lo, hi, _) in enumerate(CLUSTER_AGE_BANDS):
        band_idx[(df["age"] >= lo).to_numpy() & (df["age"] <= hi).to_numpy()] = i
    keys = pd.DataFrame({"band": band_idx, "sex": df["sex"].to_numpy(), "city": df["city_size"].to_numpy(),
                         "marital": df["marital"].to_numpy()})
    groups = []
    for (band, sex, city, mar), idx in keys.groupby(["band", "sex", "city", "marital"], sort=True).groups.items():
        groups.append({"bands": {int(band)}, "sex": sex, "city": city, "marital": {mar}, "idx": list(idx)})

    def mclass(g):
        return {MARITAL_CLASS[m] for m in g["marital"]}

    def same_cell(a, b):
        return a["sex"] == b["sex"] and a["city"] == b["city"]

    def adjacent(a, b):
        return min(b["bands"]) == max(a["bands"]) + 1 or max(b["bands"]) == min(a["bands"]) - 1

    def merge(t, g):
        t["bands"] |= g["bands"]
        t["marital"] |= g["marital"]
        t["idx"] += g["idx"]
        groups.remove(g)

    # 規則1を先にすべてのセルで適用する（離別・死別だけが年齢帯をまたいで集まるのを避ける）
    for g in [g for g in groups if g["marital"] == {"widowed_divorced"}]:
        mates = [h for h in groups if h["marital"] == {"married"} and same_cell(g, h) and h["bands"] == g["bands"]]
        if mates and min(len(g["idx"]), len(mates[0]["idx"])) < MIN_CLUSTER:
            merge(mates[0], g)

    while True:
        small = [g for g in groups if len(g["idx"]) < MIN_CLUSTER]
        if not small:
            break
        g = min(small, key=lambda g: (len(g["idx"]), min(g["bands"]), g["sex"], g["city"], sorted(g["marital"])))
        others = [h for h in groups if h is not g and same_cell(g, h)]
        cand = [h for h in others if h["bands"] == g["bands"] and mclass(h) == mclass(g) == {"ever"}]
        if not cand:
            cand = [h for h in others if adjacent(g, h) and mclass(h) == mclass(g)]
            cand.sort(key=lambda h: (len(h["idx"]), min(h["bands"])))
        if not cand:
            cand = [h for h in others if h["bands"] == g["bands"]]
        if not cand:
            cand = [h for h in others if adjacent(g, h)]
        if not cand:
            break
        merge(cand[0], g)
    city_order = {"metro": 0, "city": 1, "town": 2}
    mar_order = {"never": 0, "ever": 1}
    groups.sort(key=lambda g: (min(g["bands"]), g["sex"] != "F", city_order[g["city"]],
                               min(mar_order[c] for c in mclass(g)), sorted(g["marital"])))
    return groups


def _group_label(g: dict) -> str:
    bands = sorted(g["bands"])
    band_ja = CLUSTER_AGE_BANDS[bands[0]][2]
    if len(bands) > 1:
        band_ja = f"{band_ja}〜{CLUSTER_AGE_BANDS[bands[-1]][2]}"
    mar = MARITAL_JA.get(frozenset(g["marital"]))
    if mar is None:
        mar = "未婚・既婚" if "married" in g["marital"] else "未婚・離死別"
    sex_ja = "男性" if g["sex"] == "M" else "女性"
    return f"{CITY_JA[g['city']]}・{band_ja}・{mar}{sex_ja}"


def build_clusters(df: pd.DataFrame, seed: int = SEED) -> tuple[pd.Series, pd.DataFrame]:
    """年齢帯 × 性 × 都市規模 × 婚姻 でまとめ（build_groups）、その中を性向5指標で k-means に分ける。

    クラスタ数はグループの人数に比例させて全体で TARGET_CLUSTERS。
    小さすぎるクラスタ（MIN_CLUSTER 人未満）は同じグループ内の最も近いクラスタに統合する。
    代表人物は性向の重心に最も近い人（同点なら年齢がクラスタの中央値に近い人、次に person_id が小さい人）。
    """
    rng = np.random.default_rng(seed + 1)
    level = {"low": 0.0, "mid": 1.0, "high": 2.0}
    tcols = list(TRAITS)
    x_all = df[tcols].apply(lambda s: s.map(level)).to_numpy()
    nat_mean = x_all.mean(0)
    groups = build_groups(df)
    sizes = np.array([len(g["idx"]) for g in groups])
    ks = np.maximum(1, largest_remainder(sizes, TARGET_CLUSTERS))

    cluster_id = pd.Series(-1, index=df.index, dtype=int)
    reps = []
    next_id = 0
    ages_all = df["age"].to_numpy()
    for g, k in zip(groups, ks):
        idx = np.asarray(sorted(g["idx"]))
        x = x_all[idx]
        labels = _kmeans(x, int(min(k, max(1, len(idx) // MIN_CLUSTER))), rng)
        while True:  # 小さいクラスタの統合
            uniq, cnt = np.unique(labels, return_counts=True)
            if len(uniq) <= 1 or cnt.min() >= MIN_CLUSTER:
                break
            small = uniq[np.argmin(cnt)]
            cents = {u: x[labels == u].mean(0) for u in uniq}
            others = [u for u in uniq if u != small]
            target = min(others, key=lambda u: (((cents[u] - cents[small]) ** 2).sum(), u))
            labels[labels == small] = target
        base = _group_label(g)
        used_labels = set()
        clusters_here = []
        for u in np.unique(labels):
            members = idx[labels == u]
            xm = x_all[members]
            cent = xm.mean(0)
            dist = ((xm - cent) ** 2).sum(1)
            ages = ages_all[members]
            order = np.lexsort((members, np.abs(ages - np.median(ages)), np.round(dist, 9)))
            rep = int(df["person_id"].iat[members[order[0]]])
            dev = cent - nat_mean
            clusters_here.append((members, rep, dev, np.argsort(-np.abs(dev), kind="stable")))
        clusters_here.sort(key=lambda c: (-len(c[0]), c[1]))  # 大きいクラスタから ID を付ける
        for members, rep, dev, ranked in clusters_here:
            words = [TRAIT_WORDS[tcols[j]][1 if dev[j] > 0 else 0] for j in ranked]
            label = f"{base}・{words[0]}"
            if label in used_labels:
                label = f"{label}・{words[1]}"
            used_labels.add(label)
            cluster_id.iloc[members] = next_id
            reps.append({"cluster_id": next_id, "person_id": rep, "cluster_size": len(members),
                         "cluster_weight": round(float(df["weight"].iloc[members].sum()), 4), "label_ja": label})
            next_id += 1
    return cluster_id, pd.DataFrame(reps)


# ---------------------------------------------------------------------------
# 書き出し
# ---------------------------------------------------------------------------

COLUMNS = ["person_id", "age", "sex", "pref_code", "pref_name", "city_size", "marital", "household",
           "employment", "income_band", "has_smartphone", "os",
           "sns_line", "sns_x", "sns_instagram", "sns_tiktok", "sns_youtube",
           "trait_price", "trait_novelty", "trait_privacy", "trait_wom", "trait_ad_aversion",
           "weight", "cluster_id"]


def build(seed: int = SEED) -> tuple[pd.DataFrame, pd.DataFrame]:
    people = build_people(seed)
    people["cluster_id"], reps = build_clusters(people, seed)
    people = people[COLUMNS].copy()
    for c in ["has_smartphone"] + [f"sns_{k}" for k in SNS]:
        people[c] = people[c].map({True: "true", False: "false"})
    return people, reps


def write(people: pd.DataFrame, reps: pd.DataFrame, out_dir: Path = OUT_DIR) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    people.to_csv(out_dir / "japan_10k.csv", index=False, float_format="%.4f", lineterminator="\n")
    reps.to_csv(out_dir / "representatives.csv", index=False, lineterminator="\n")


def main() -> None:
    people, reps = build()
    write(people, reps)
    print(f"japan_10k.csv: {len(people)}人、重み合計 {people['weight'].sum():,.0f}")
    print(f"representatives.csv: {len(reps)}クラスタ（最小 {reps.cluster_size.min()}人、最大 {reps.cluster_size.max()}人）")


if __name__ == "__main__":
    main()
