---
name: add-benchmark
description: ベンチマーク値（リテンション、登録率、決済率、CPM・CTR など）を rules/*.yaml に足す・直すときの手順。出典の略称・表・ページを必ず付け、範囲 low/mid/high で書き、テストと感度表まで回す。
argument-hint: "[項目名] [値の説明]"
---

# ベンチマーク値を rules に足す

対象: `$ARGUMENTS`

出典のない値は入れない（`CLAUDE.md`）。`rules/*.yaml` に `source` のない値を書こうとすると PreToolUse の hook が止める。

## 1. 出典を確かめる
1. `data/DATA_SOURCES.md` 3-0 の略称表に、その資料があるかを見る（`[L19]`、`[LD22]`、`[CFA24]` など）。
2. ない資料なら、先に調査担当（`researcher`）に一次資料と表・ページを調べさせ、独立検証担当（`verifier`）に元資料で照合させる。`DATA_SOURCES.md` への登録は人口担当・メインセッションに頼む（このスキルでは書かない）。
3. 再配布できない資料（企業レポート PDF、MMD）は数値の出典表記だけにし、ファイルはリポジトリに入れない。

## 2. 値を書く
```yaml
signup:
  low: 0.466        # 出典の最小値
  mid: 0.466        # 最も新しい日本の値
  high: 0.584       # 出典の最大値
  source: "[LD22] p.18 国別チャート 日本 / [L19] p.9"
  note: mid は最新の日本値。規則から外れたらここに理由。
```
- 割合は 0〜1 の小数。ドル建ては `usd_jpy`（仮定 150円）で円に。
- `source` は「略称 + 表・ページ」。複数なら ` / ` でつなぎ、どれが low/mid/high かを書く。
- 出典が1本なら low = mid = high（範囲を作らない）。
- 出典がない設計上の値だけ `source: assumption`。**`note` に理由と置いた考え方を必ず書く**。範囲は広めにとる。
- 同じ階層に `source` を書けない形（`factor: {low, mid, high}` など）は、すぐ上の辞書に `source` を書く。

## 3. 確かめる
1. `.venv/bin/python -m pytest tests/test_engine.py -q`（`rules/` を編集すると PostToolUse の hook が自動で走らせる。失敗したら直す）
2. `.venv/bin/python -m teppuri.engine.sensitivity` で `rules/sensitivity.md` を作り直し、その値が結果をどれだけ動かすかを見る。
3. `docs/iterations.md` に、何をなぜ足した・変えたかを追記する（追記のみ）。
4. `assumption` を足したら `rules/README.md` の「限界」の仮定の一覧にも足す。

## してはいけないこと
- 結果を見て、望む方向に値を寄せる。
- バックテストの予測をコミットしたあとに `rules/` を変える（`/backtest-freeze`）。
