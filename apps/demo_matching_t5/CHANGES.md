# 対照実験 t5: v2 の名札を外したコピー（ブラインド v2）

**中身は `apps/demo_matching_v2` とまったく同じ。** 違うのは `app_id`（`demo_matching_v2` → `demo_matching_t5`）だけ。

## なぜ作ったか

`teppuri/judge/common.py` の `app_summary_ja()` は `app_id` を判断のプロンプトに入れる。v2 の判断では、判断する Claude（Haiku）に `demo_matching_v2` という名前が見えていた。「v2」という名前だけで「直した版だから良いはず」と判断が甘くなった可能性がある。名前を意味のない `t5` にして同じ判断をやり直し、v2 の伸びが名前なしでも残るかを確かめる。

ID（t5 / m8 / q3）は3つの対照実験に無作為に割り当てた。どれがどの実験かは ID から読み取れない。

## 変えたもの

| # | 変更 | 触れる v1 のテーマ | エンジンに直接効くか |
|---|---|---|---|
| 1 | `app_id`: `demo_matching_v2` → `demo_matching_t5` | なし | 効かない（判断のプロンプトにだけ見える） |
| 2 | app.yaml・`src/brand.js`・`tools/` のコメントから「v2」「v1」の文字を消した | なし | 効かない（コメントは判断にもエンジンにも渡らない） |

- 判断に渡る app.yaml の項目（`name_ja` `preset` `min_age` `description_ja` `gates` `pricing` と各案の条件）は v2 と同一（YAML として読み込んで比較済み）。
- 画面 `screens/*.png`・広告 `ads/*.png` は v2 のファイルをそのままコピーした（バイト単位で同一。判断は画像のハッシュで Files API の ID を使い回すので、同じ画像が送られる）。
- 価格 2,980円・審査 12時間など v2 の変更点（`apps/demo_matching_v2/CHANGES.md` の18項目）はすべてそのまま。エンジンに直接効くのは v2 と同じく価格だけ。

## 残る「名前」

動画の絵コンテの見出し「短尺動画の見本 v1 / v2 / v3」と creative ID（`v1` `v2` `v3`）は、v1 から同じ表記で全版に入っている素材の番号なので変えていない（v1 と同じ条件にするため）。
