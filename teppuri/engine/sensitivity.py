"""感度表: 仮定の値を1つずつ low / high に固定したとき、A/B の結果がどう動くか。

python -m teppuri.engine.sensitivity [--out rules/sensitivity.md]

バックテストで rules/ を固定する前の確認用。fixture アプリ（tests/fixtures/engine/app.yaml）を
実データ人口で30回まわす。判断は「なし（全て similar）」と「仮の判断あり」
（tests/fixtures/engine/decisions_sensitivity.json: A の広告は lower、B の広告と決済は higher）の2通り。
"""

from __future__ import annotations

import argparse
import copy
import time
from pathlib import Path

import numpy as np

from .inputs import DEFAULT_POPULATION, Population, load_app, load_decisions
from .rules import REPO_ROOT, Rules, triple
from .run import run_app

FIX = REPO_ROOT / "tests" / "fixtures" / "engine"
RUNS = 30
SEED = 20261108


def _fix(spec: dict, which: str) -> None:
    v = spec[which]
    spec["low"] = spec["mid"] = spec["high"] = v


def variants(rules: Rules):
    """(名前, 値の説明, ルールを書き換える関数) の列。"""
    def path_param(label, getter):
        lo, mid, hi = triple(getter(rules))
        for which, val in (("low", lo), ("high", hi)):
            def apply(r, which=which):
                _fix(getter(r), which)
            yield label, f"{which} = {val:g}", apply

    yield from path_param("matching 1日あたりマッチ確率",
                          lambda r: r.presets["presets"]["matching"]["core"]["daily_hazard"])
    yield from path_param("matching 密度が半分になる人数",
                          lambda r: r.presets["presets"]["matching"]["core"]["density_half"])
    yield from path_param("クリック→設置率（matching）",
                          lambda r: r.channels["click_to_install"]["matching"])
    yield from path_param("身近なクチコミ q", lambda r: r.multipliers["wom"]["q_per_active_day"])
    yield from path_param("X クチコミ q_x", lambda r: r.multipliers["wom_x"]["q_per_active_x_user_day"])

    lv = rules.multipliers["levels"]
    weak = f"higher = {lv['higher']['low']:g}, lower = {lv['lower']['high']:g}"
    strong = f"higher = {lv['higher']['high']:g}, lower = {lv['lower']['low']:g}"

    def levels_weak(r):
        _fix(r.multipliers["levels"]["higher"], "low")
        _fix(r.multipliers["levels"]["lower"], "high")

    def levels_strong(r):
        _fix(r.multipliers["levels"]["higher"], "high")
        _fix(r.multipliers["levels"]["lower"], "low")

    yield "判断倍率", f"弱い（{weak}）", levels_weak
    yield "判断倍率", f"強い（{strong}）", levels_strong
    yield from path_param("価格弾力性", lambda r: r.presets["price_elasticity"])
    yield from path_param("既存利用者の配分 既婚の重み",
                          lambda r: r.presets["presets"]["matching"]["initial_affinity"]["marital"]["married"])


def summarize(replay: dict, scale: float, metric: str = "payers") -> dict:
    a, b = replay["plans"]["A"]["totals"], replay["plans"]["B"]["totals"]
    pb = replay["comparison"]["p_B_better"]
    return {"A": a[metric]["p50"] * scale, "B": b[metric]["p50"] * scale,
            "pB": pb.get(metric, pb["revenue_jpy"]), "pB_rev": pb["revenue_jpy"]}


def running_app(app: dict) -> dict:
    """運営中モードの確認用: 両案とも既存の利用者30万人・決済者3万人（発売から365日）から120日。
    A は価格そのまま、B は31日目に全員 3,900円 → 4,900円（applies_to: all）。広告は両案とも A の条件。"""
    a = copy.deepcopy(app)
    init = {"active": 300000, "payers": 30000, "as_of_day_since_launch": 365}
    a["plans"]["B"] = copy.deepcopy(a["plans"]["A"])
    for k in ("A", "B"):
        a["plans"][k]["initial_state"] = init
        a["plans"][k]["period_days"] = 120
    a["plans"]["B"]["changes"] = [{"day": 31, "pricing": {"monthly_jpy": 4900}, "applies_to": "all"}]
    return a


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="感度表を作る")
    ap.add_argument("--out", default=str(REPO_ROOT / "rules" / "sensitivity.md"))
    ap.add_argument("--population", default=str(DEFAULT_POPULATION))
    args = ap.parse_args(argv)

    t0 = time.time()
    pop = Population.load(args.population)
    app = load_app(FIX / "app.yaml")
    base_rules = Rules.load()
    scenarios = {
        "判断なし": (app, [], "payers"),
        "仮の判断あり": (app, load_decisions(FIX / "decisions_sensitivity.json"), "payers"),
        "運営中モード（値上げ）": (running_app(app), [], "paying_end"),
    }

    rows = []  # (パラメータ, 値, シナリオ → 要約)
    def run(r):
        return {name: summarize(run_app(a, pop, r, dec, runs=RUNS, seed=SEED), pop.scale, metric)
                for name, (a, dec, metric) in scenarios.items()}

    rows.append(("（基準）", "範囲どおりに抽選", run(base_rules)))
    for label, desc, apply in variants(base_rules):
        r = copy.deepcopy(base_rules)
        apply(r)
        rows.append((label, desc, run(r)))
    write_markdown(Path(args.out), rows, app, time.time() - t0)
    print(f"出力: {args.out}（{time.time() - t0:.0f}秒）")
    return 0


def _flip(base: float, v: float) -> str:
    """B が良い確率が 0.5 をまたいだら印を付ける。"""
    return " **逆転**" if (base - 0.5) * (v - 0.5) < 0 else ""


def write_markdown(path: Path, rows, app: dict, seconds: float) -> None:
    base = rows[0][2]
    lines = [
        "# 感度表（バックテストで固定する前の確認用）",
        "",
        "`python -m teppuri.engine.sensitivity` で作り直せます（実データ人口、"
        f"{RUNS}回、シード {SEED}、約{seconds:.0f}秒）。",
        "",
        "仮定の値を1つずつ low / high に固定し（ほかは範囲どおりに抽選）、fixture アプリ"
        "（`tests/fixtures/engine/app.yaml`、架空のマッチングアプリ、90日）の結果を比べます。",
        "",
        "- A案: 首都圏4都県、20〜34歳、Instagram 300万円＋TikTok 200万円",
        "- B案: 全国、20〜39歳、Instagram 200万円＋LINE 100万円＋電車広告 100万円＋大学 50万円",
        "- 決済者は日本全体に換算した p50（人）。「B が良い確率」は同じ回どうしで B の決済者が A を上回った回の割合"
        "（括弧内は売上）。",
        "- 判断: 「判断なし」= 全て similar。「仮の判断あり」= A の広告は lower、B の広告と決済は higher"
        "（`tests/fixtures/engine/decisions_sensitivity.json`、感度を見るための仮の判断で、Claude の判断ではない）。",
        "- 運営中モード（値上げ）: 両案とも既存の利用者30万人・決済者3万人（発売から365日）から120日。A は価格そのまま、"
        "B は31日目に全員 3,900円 → 4,900円（applies_to: all）。この表だけ、人数は最終日に払い続けている人（paying_end）、"
        "「B が良い確率」は売上で比べる（値上げは決済者を減らし、売上を増やしうるため）。",
        "- **逆転** = B が良い確率が基準と比べて 0.5 をまたいだ（結論がひっくり返った）。",
        "",
    ]
    for scen in base:
        running = scen.startswith("運営中")
        who = "払い続けている人（最終日）" if running else "決済者"
        lines += [f"## {scen}", "",
                  f"| 仮定 | 値 | A {who} p50 | B {who} p50 | B が良い確率（売上） |",
                  "|---|---|---:|---:|---:|"]
        b0 = base[scen]["pB"]
        for label, desc, res in rows:
            s = res[scen]
            lines.append(f"| {label} | {desc} | {s['A']:,.0f} | {s['B']:,.0f} | "
                         f"{s['pB']:.2f}（{s['pB_rev']:.2f}）{_flip(b0, s['pB'])} |")
        lines.append("")
    lines += conclusions(rows)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def conclusions(rows) -> list[str]:
    base = rows[0][2]
    out = ["## 読み取り", ""]
    for scen in base:
        b0 = base[scen]["pB"]
        flips = [(l, d) for l, d, r in rows[1:] if (b0 - 0.5) * (r[scen]["pB"] - 0.5) < 0]
        a_vals = [r[scen]["A"] for _, _, r in rows[1:]]
        swing = max(a_vals) / max(min(a_vals), 1e-9)
        # どの仮定が A の決済者を最も動かすか
        by_param = {}
        for l, d, r in rows[1:]:
            by_param.setdefault(l, []).append(r[scen]["A"])
        top = max(by_param.items(), key=lambda kv: max(kv[1]) / max(min(kv[1]), 1e-9))
        msg = (f"- {scen}: 基準の「B が良い確率」は {b0:.2f}。A の決済者 p50 は仮定1つで最大 {swing:.1f} 倍動き、"
               f"最も効くのは「{top[0]}」（{min(top[1]):,.0f}〜{max(top[1]):,.0f} 人）。")
        if flips:
            msg += " **仮定1つで結論がひっくり返る**: " + "、".join(f"{l}（{d}）" for l, d in flips) + "。"
        else:
            msg += " どの仮定を1つ動かしても、A/B の優劣は変わらない。"
        if 0.35 <= b0 <= 0.65:
            msg += " 基準でも五分五分に近く、この組み合わせでは「どちらが良い」とは言えない。"
        out.append(msg)
    out += [
        "- 判断倍率の行は、判断がない（全て similar）と結果が変わらない（倍率 1.0 のため）。"
        "「既存利用者の配分」の行は、initial_state がない表では結果が変わらない。",
        "- クリック→設置率は決済者の水準を最も大きく動かす。代理店相場（high）と計測会社の CPI（low・mid）の差が"
        "そのまま出ている。水準（何人）を言うときは、この幅を必ず添える。",
        "- X クチコミは全国の X 利用者に届くので、全国で出す案ほど設置に変わりやすい（出荷地域を絞った案では"
        "地域外に届いた分が無駄になる）。q_x を大きくすると全国展開の案が相対的に有利になる。",
        "- 運営中モードでは既存の利用者がクチコミの発信源になるので、クチコミの強さ q が水準（払い続けている人数）を最も動かす（約2倍）。クチコミは出典のない仮定なので、バックテストでまず確かめる値。値上げ（B）の売上が上回る結論は、価格弾力性を high（1.0）にしても変わらない。",
        "- 判断がある場合、A/B の優劣は判断倍率の大きさに強く依存する。バックテストで倍率を固定する前に、"
        "この表を見て倍率の幅を決める。",
        "",
    ]
    return out


if __name__ == "__main__":
    raise SystemExit(main())
