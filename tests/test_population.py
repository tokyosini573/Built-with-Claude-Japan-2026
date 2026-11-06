"""架空の日本1万人（data/population/）のテスト。

許容幅の考え方
- 割り振りは条件グループごとに「期待値を保つ丸め」をしているので、グループ内の比率は
  出典と「1人分（1/グループ人数）」以内で一致するはず。これを厳密に確かめる。
- 人口全体での SNS 率は出典 P(k|a,s) と2人以内（スマホと SNS の2段の丸め）（性×10歳でまとめると ±2ポイント）。
  ただし出典の率がスマホ保有率を超えるセル（主に LINE、若い男性の YouTube）は上限1で切れ、
  スマホ保有者全員が利用する形になる（README の限界に列挙）。
- 就業形態は都道府県補正のあと再正規化するため、全国の性×年齢の比率は労働力調査から少しずれる。
  許容幅 3ポイント。
"""

from pathlib import Path

import hashlib

import numpy as np
import pandas as pd
import pytest

from teppuri.population import build as b

ROOT = Path(__file__).resolve().parents[1]
POP = ROOT / "data" / "population" / "japan_10k.csv"
REPS = ROOT / "data" / "population" / "representatives.csv"


@pytest.fixture(scope="module")
def built():
    return b.build()


@pytest.fixture(scope="module")
def people():
    df = pd.read_csv(POP, dtype={"has_smartphone": str, **{f"sns_{k}": str for k in b.SNS}})
    lo = (df["age"] // 5 * 5).clip(15, 75)
    df["age5"] = lo.astype(str) + "-" + (lo + 4).astype(str)
    df["band10"] = df["age5"].map(b.band10)
    return df


@pytest.fixture(scope="module")
def reps():
    return pd.read_csv(REPS)


def _bool(s):
    return s.map({"true": True, "false": False})


def test_columns_and_rows(people):
    assert list(people.columns[:len(b.COLUMNS)]) == b.COLUMNS
    assert len(people) == 10_000
    assert people["person_id"].tolist() == list(range(10_000))
    assert people["age"].between(15, 79).all()
    assert set(people["sex"]) == {"M", "F"}
    assert set(people["pref_code"]) == set(range(1, 48))
    assert set(people["city_size"]) <= {"metro", "city", "town"}
    assert set(people["marital"]) <= {"unmarried", "married", "widowed_divorced"}
    assert set(people["household"]) <= set(b.HOUSEHOLD)
    assert set(people["employment"]) <= set(b.EMPLOYMENT)
    assert set(people["income_band"]) <= {x[0] for x in b.INCOME_BANDS} | {"none"}
    assert set(people["os"]) <= {"ios", "android", "none"}
    for c in ["has_smartphone"] + [f"sns_{k}" for k in b.SNS]:
        assert set(people[c]) <= {"true", "false"}
    for c in b.TRAITS:
        assert set(people[c]) <= {"low", "mid", "high"}


def test_weight_sum(people):
    assert people["weight"].sum() == pytest.approx(96_806_585, abs=0.5)


def test_same_seed_same_output(built):
    p1, r1 = built
    p2, r2 = b.build()
    pd.testing.assert_frame_equal(p1, p2)
    pd.testing.assert_frame_equal(r1, r2)


def test_file_matches_code(built, tmp_path):
    """リポジトリのファイルが今のコードの出力と同じであること（作り直し忘れの検出）。"""
    p, r = built
    b.write(p, r, tmp_path)
    assert (tmp_path / "japan_10k.csv").read_bytes() == POP.read_bytes()
    assert (tmp_path / "representatives.csv").read_bytes() == REPS.read_bytes()


def test_pref_sex_age_marginal(people):
    """都道府県×性×5歳階級の人数が、出典人口に比例した割り当てと1人未満の差で一致。"""
    cells = b.load_population_cells()
    quota = cells["pop"] / cells["pop"].sum() * 10_000
    got = people.groupby(["pref_code", "sex", "age5"]).size()
    n = np.array([got.get((r.pref_code, r.sex, r.age5), 0) for r in cells.itertuples()])
    assert np.abs(n - quota.to_numpy()).max() < 1.0
    # 周辺（都道府県、性×年齢）もずれが小さい
    by_pref = people.groupby("pref_code").size()
    q_pref = cells.assign(q=quota).groupby("pref_code")["q"].sum()
    assert (by_pref - q_pref).abs().max() < 5


def _group_within_one_person(df, group_cols, value_fn, target_fn):
    worst = 0.0
    for key, g in df.groupby(group_cols):
        key = key if isinstance(key, tuple) else (key,)
        diff = abs(value_fn(g) - target_fn(key)) * len(g)
        worst = max(worst, diff)
    return worst


def test_smartphone_rate_by_sex_age(people):
    """性×年齢ごとのスマホ保有率 = 通信利用動向調査 第24表（1人以内）。"""
    smart = b.load_smartphone()
    df = people.assign(tband=people["age5"].map(b.tsushin_band), sp=_bool(people["has_smartphone"]))
    worst = _group_within_one_person(df, ["sex", "tband"], lambda g: g["sp"].mean(), lambda k: smart[k])
    assert worst < 1.0 + 1e-9


def test_no_smartphone_means_no_os_no_sns(people):
    no = people[people["has_smartphone"] == "false"]
    assert (no["os"] == "none").all()
    for k in b.SNS:
        assert (no[f"sns_{k}"] == "false").all()
    yes = people[people["has_smartphone"] == "true"]
    assert yes["os"].isin(["ios", "android"]).all()


def test_sns_rate_among_holders(people):
    """スマホ保有者の SNS 率 = min(1, P(k|年齢,性) ÷ P_gen(スマホ|年齢,性))（1人以内）。"""
    sns, _ = b.load_sns()
    smart = b.load_smartphone()
    holders = people[people["has_smartphone"] == "true"].assign(tband=lambda d: d["age5"].map(b.tsushin_band))
    for k in b.SNS:
        worst = _group_within_one_person(
            holders, ["sex", "tband"], lambda g: _bool(g[f"sns_{k}"]).mean(),
            lambda key: b.sns_rate_among_holders(sns, smart, k, key[0], key[1]))
        assert worst < 1.0 + 1e-9, k


def test_sns_rate_population_matches_source(people):
    """人口全体の SNS 率が出典 P(k|a,s)（メディア調査の水準 × 性比）と一致する。

    - 上限1で切れないセル（性×通信利用動向調査の年齢帯）: 2人以内（スマホと SNS の2段の丸め）
    - 切れるセル（README に列挙）: スマホ保有者全員が利用（= スマホ保有率）
    - 性×10歳階級でまとめても、切れるセルを含まない SNS は ±2ポイント以内
    """
    sns, _ = b.load_sns()
    smart = b.load_smartphone()
    capped = {(k, s, tb) for k, s, tb, _, _ in b.sns_capped_cells()}
    df = people.assign(tband=people["age5"].map(b.tsushin_band))
    for k in b.SNS:
        for (s, tb), g in df.groupby(["sex", "tband"]):
            got = _bool(g[f"sns_{k}"]).mean()
            if (k, s, tb) in capped:
                assert got == pytest.approx(_bool(g["has_smartphone"]).mean()), (k, s, tb)
            else:
                assert abs(got - sns[(k, s, b.band10(tb))]) * len(g) < 2.0 + 1e-6, (k, s, tb, got)
    for (s, band), g in df.groupby(["sex", "band10"]):
        for k in b.SNS:
            if any((k, s, tb) in capped for tb in g["tband"].unique()):
                continue
            assert abs(_bool(g[f"sns_{k}"]).mean() - sns[(k, s, band)]) <= 0.02, (k, s, band)


def test_os_share(people):
    """iPhone 比率 = モバイル社会研究所 2026 の年齢別値 ± 性差 d/2（1人以内）。"""
    ios = b.load_ios_share()
    holders = people[people["has_smartphone"] == "true"]
    worst = _group_within_one_person(
        holders, ["sex", "band10"], lambda g: (g["os"] == "ios").mean(),
        lambda k: ios[k[1]] + (b.IOS_SEX_GAP / 200 if k[0] == "F" else -b.IOS_SEX_GAP / 200))
    assert worst < 1.0 + 1e-9


def test_traits_by_sex_age(people):
    tr = b.load_traits()
    df = people.assign(trband=people["age5"].map(b.trait_band))
    for col, name in b.TRAITS.items():
        for i, lvl in enumerate(["low", "mid", "high"]):
            worst = _group_within_one_person(
                df, ["sex", "trband"], lambda g: (g[col] == lvl).mean(),
                lambda k: tr[(name, k[0], k[1])][i] / tr[(name, k[0], k[1])].sum())
            assert worst < 1.0 + 1e-9, (col, lvl)


def test_household_rule_reproduces_source():
    """世帯5分類の再編規則が、検証済みの derived_hhclass CSV（全国）を再現する。"""
    mh = b.load_marital_household()
    hh = pd.read_csv(b.SRC / "demographics/derived_hhclass_pref_sex_age_census2025.csv")
    nat = hh[hh["pref"] == "00000_全国"]
    for sex, code in (("M", "1_男"), ("F", "2_女")):
        for a in b.AGE5:
            tot = {}
            for p in range(1, 48):
                for (m, h), n in mh[(p, sex, a)].items():
                    tot[h] = tot.get(h, 0) + n
            s = sum(tot.values())
            for r in nat[nat["sex"] == code].itertuples():
                assert abs(tot.get(r[3], 0) / s - getattr(r, f"_{4 + b.AGE5.index(a)}")) < 0.002


def test_employment_close_to_lfs(people):
    lfs = pd.read_csv(b.SRC / "demographics2/derived_employment6_sex_age_lfs2025avg.csv")
    cols = ["regular", "nonregular", "self_exec_family", "student", "unemployed_or_housework", "retired_or_other_nilf"]
    for r in lfs[(lfs["sex"] != "total") & (lfs["age"] != "70+")].itertuples():
        s = "M" if r.sex == "male" else "F"
        g = people[(people["sex"] == s) & (people["age5"] == r.age)]
        for emp, c in zip(b.EMPLOYMENT, cols):
            assert abs((g["employment"] == emp).mean() * 100 - getattr(r, c)) < 3.0, (s, r.age, emp)


def test_representatives(people, reps):
    assert 300 <= len(reps) <= 500
    assert list(reps.columns) == ["cluster_id", "person_id", "cluster_size", "cluster_weight", "label_ja"]
    assert people["cluster_id"].notna().all() and (people["cluster_id"] >= 0).all()
    assert set(people["cluster_id"]) == set(reps["cluster_id"])
    sizes = people.groupby("cluster_id").size()
    assert (reps.set_index("cluster_id")["cluster_size"] == sizes).all()
    assert reps["cluster_size"].sum() == 10_000
    assert reps["cluster_weight"].sum() == pytest.approx(96_806_585, abs=1)
    assert reps["cluster_size"].min() >= b.MIN_CLUSTER
    # 代表人物は自分のクラスタに属する
    rep_cluster = people.set_index("person_id").loc[reps["person_id"], "cluster_id"].to_numpy()
    assert (rep_cluster == reps["cluster_id"].to_numpy()).all()
    # 各クラスタは 年齢帯×性×都市規模 が1つ
    for cid, g in people.groupby("cluster_id"):
        assert g["sex"].nunique() == 1 and g["city_size"].nunique() == 1
    assert reps["label_ja"].str.len().max() <= 40


# 代表人物のグループに婚姻を加えた（契約 v2）ときの属性値のハッシュ。
# cluster_id 以外の列は1つも変わっていないことを確かめる。人口本体を意図して変えたときだけ更新する。
ATTRIBUTES_SHA256 = "110c78757218731cd20f4038139865faaff1fe28d292639446bb95b4c26281e7"


def test_attributes_unchanged():
    df = pd.read_csv(POP, dtype=str).drop(columns=["cluster_id"])
    assert hashlib.sha256(df.to_csv(index=False).encode()).hexdigest() == ATTRIBUTES_SHA256


def test_clusters_split_by_marital(people, reps):
    """クラスタは婚姻でも分かれる。ラベルの婚姻とメンバーの婚姻が合う。"""
    label = reps.set_index("cluster_id")["label_ja"]
    allowed = {"未婚": {"unmarried"}, "既婚": {"married"}, "離別・死別": {"widowed_divorced"},
               "既婚・離死別": {"married", "widowed_divorced"}}
    for cid, g in people.groupby("cluster_id"):
        word = next(w for w in ("既婚・離死別", "離別・死別", "未婚", "既婚") if f"・{w}" in label[cid])
        assert set(g["marital"]) <= allowed[word], (cid, label[cid], set(g["marital"]))
    # 未婚と結婚経験ありが混ざったクラスタはない
    mixed = people.groupby("cluster_id")["marital"].agg(lambda s: ("unmarried" in set(s)) and len(set(s)) > 1)
    assert not mixed.any()
