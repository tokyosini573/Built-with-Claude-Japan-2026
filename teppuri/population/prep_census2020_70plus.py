"""令和2年国勢調査の全国値から「70歳以上」の就業6区分を作る前処理。

労働力調査 2025年平均は「70歳以上」が1区分（80歳以上を含む）なので、
70〜74歳・75〜79歳に分けるために、2020年国勢調査の全国の
70〜74 / 75〜79 / 70歳以上（80歳以上を含む）の6区分比率が要る。
既存の派生CSV（derived_employment6_pref_sex_age_census2020.csv）は 75〜79歳までしかないため、
同じ規則で元の xlsx（第2-1表・第8-1表）から全国値を計算し直す。

実行: python -m teppuri.population.prep_census2020_70plus
出力: data/sources/demographics/derived_employment6_sex_70plus_national_census2020.csv
      data/sources/demographics/derived_selfemp_owner_share_sex_age_national_census2020.csv
      （自営等のうち「業主」（雇人のある業主・雇人のない業主・家庭内職者）の割合。
        所得の付与で、業主には自営業主の所得分布、役員・家族従業者には有業者全体の分布を使うため）

規則（DATA_SOURCES 2-4 と既存派生CSVの列名に合わせる）:
- 従業上の地位「不詳」は 正規・非正規・自営等 に比例配分
- 非正規 = 派遣 + パート・アルバイト・その他 から「通学のかたわら仕事」を引く
- 自営等 = 役員 + 雇人のある業主 + 雇人のない業主 + 家族従業者 + 家庭内職者
- 学生 = 通学 + 通学のかたわら仕事
- 無職・家事 = 完全失業者 + 家事（+ 60歳未満の「その他」）
- 引退（代理）= 60歳以上の非労働力「その他」
- 分母 = 総数 − 労働力状態「不詳」
"""

from pathlib import Path

import openpyxl
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "data" / "sources" / "demographics"
T2 = SRC / "census2020_t2-1_age_sex_marital_laborstatus_pref.xlsx"
T8 = SRC / "census2020_t8-1_age_sex_empstatus_occupation_pref.xlsx"
OUT = SRC / "derived_employment6_sex_70plus_national_census2020.csv"
OUT_OWNER = SRC / "derived_selfemp_owner_share_sex_age_national_census2020.csv"
CHECK = SRC / "derived_employment6_pref_sex_age_census2020.csv"

CATS = ["regular", "nonregular", "selfemp_exec", "student", "unemployed_homemaker", "retired_proxy"]
# 第8-1表の年齢列（index 6 = 15〜19歳 … index 22 = 95歳以上）
T8_AGES = ["15-19", "20-24", "25-29", "30-34", "35-39", "40-44", "45-49", "50-54",
           "55-59", "60-64", "65-69", "70-74", "75-79", "80-84", "85-89", "90-94", "95+"]


def _national_rows(path):
    """全国の行だけを読む（全国の行はファイルの先頭にまとまっている）。"""
    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb[wb.sheetnames[0]]
    for r in ws.iter_rows(values_only=True):
        if not r or r[0] != "a":
            continue
        if r[1] != "00000_全国":
            break
        yield r


def _num(v):
    return 0 if v in (None, "-", "…") else float(v)


def compute_counts():
    """性 × 年齢（5歳、80歳以上は各階級）ごとの6区分人数を返す。"""
    labor = {}
    for r in _national_rows(T2):
        if r[2] != "0_国籍総数" or r[3] != "0_総数" or r[4] not in ("1_男", "2_女"):
            continue
        age = r[5].split("_", 1)[1].replace("～", "-").replace("歳以上", "+").replace("歳", "")
        v = [_num(x) for x in r[6:19]]
        labor[(r[4], age)] = {
            "total": v[0], "employed": v[2], "work_while_school": v[5], "unemployed": v[7],
            "housework": v[9], "school": v[10], "other": v[11], "unknown": v[12],
        }
    status = {}
    for r in _national_rows(T8):
        if r[3] != "0_総数" or r[2] not in ("1_男", "2_女"):
            continue
        for i, age in enumerate(T8_AGES):
            status.setdefault((r[2], age), {})[r[4]] = _num(r[6 + i])

    rows = []
    for (sex, age), lb in labor.items():
        if age not in T8_AGES:
            continue
        st = status[(sex, age)]
        reg = st["11_（雇用者）正規の職員・従業員"]
        nonreg = st["12_（雇用者）労働者派遣事業所の派遣社員"] + st["13_（雇用者）パート・アルバイト・その他"]
        selfe = (st["2_役員"] + st["3_雇人のある業主"] + st["4_雇人のない業主"]
                 + st["5_家族従業者"] + st["6_家庭内職者"])
        unk = st["7_従業上の地位「不詳」"]
        known = reg + nonreg + selfe
        if known > 0:
            reg, nonreg, selfe = (x + unk * x / known for x in (reg, nonreg, selfe))
        owner = st["3_雇人のある業主"] + st["4_雇人のない業主"] + st["6_家庭内職者"]
        owner_share = owner / selfe if selfe > 0 else 0.0
        nonreg -= lb["work_while_school"]
        senior = int(age.split("-")[0].rstrip("+")) >= 60
        rows.append({
            "sex": sex, "age": age,
            "regular": reg, "nonregular": nonreg, "selfemp_exec": selfe,
            "student": lb["school"] + lb["work_while_school"],
            "unemployed_homemaker": lb["unemployed"] + lb["housework"] + (0 if senior else lb["other"]),
            "retired_proxy": lb["other"] if senior else 0.0,
            "base": lb["total"] - lb["unknown"],
            "owner_share": owner_share,
        })
    return pd.DataFrame(rows)


def main():
    df = compute_counts()
    # 既存の派生CSV（全国、15〜79歳）と照合して、規則の再現を確かめる
    chk = pd.read_csv(CHECK)
    chk = chk[chk["pref"] == "00000_全国"]
    chk.columns = ["pref", "sex", "age"] + CATS + ["base_persons", "check"]
    max_diff = 0.0
    for _, c in chk.iterrows():
        d = df[(df.sex == c.sex) & (df.age == c.age)].iloc[0]
        for k in CATS:
            max_diff = max(max_diff, abs(d[k] / d["base"] - c[k]))
    print(f"既存派生CSVとの最大差（比率）: {max_diff:.5f}")
    assert max_diff < 0.001, "既存派生CSVの規則を再現できていない"

    out = []
    for sex in ("1_男", "2_女"):
        s = df[df.sex == sex]
        groups = {"70-74": ["70-74"], "75-79": ["75-79"],
                  "70+": ["70-74", "75-79", "80-84", "85-89", "90-94", "95+"]}
        for name, ages in groups.items():
            g = s[s.age.isin(ages)][CATS + ["base"]].sum()
            row = {"sex": sex, "age": name}
            row.update({k: round(g[k] / g["base"], 4) for k in CATS})
            row["base_persons"] = int(g["base"])
            out.append(row)
    pd.DataFrame(out).to_csv(OUT, index=False)
    print(f"書き出し: {OUT.relative_to(ROOT)}")

    own = df[df.age.isin(T8_AGES[:13])][["sex", "age", "owner_share"]].copy()
    own["owner_share"] = own["owner_share"].round(4)
    own.to_csv(OUT_OWNER, index=False)
    print(f"書き出し: {OUT_OWNER.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
