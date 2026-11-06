# 判断担当（teppuri/judge）

テプリの中で Claude が働く部分です。**数字は作りません。** Claude が出すのは「このカテゴリの平均より higher / similar / lower」と理由、人物像、インタビューの答え、レポートの文章だけです。数字はエンジンが作り、レポートはエンジンの数字を ID で引用します。

## 流れ

```
apps/<app_id>/app.yaml + 画面・広告画像
data/population/representatives.csv (+ japan_10k.csv の属性)
        │
        ▼ personas.py（Opus 5.5・アプリごとに1回）
runs/<app_id>/personas.json        市場の整理（人の種類）と、代表人物ごとのペルソナ
        │
        ▼ decide.py（Haiku 5.5・Batch API + プロンプトキャッシュ）
runs/<app_id>/decisions.json       契約 §3。案 × 段階（install は広告素材ごと）× クラスター
runs/<app_id>/decisions_detail.json  やめる理由・進む理由・根拠も含む全文
runs/<app_id>/decisions_summary.json 判断の分布と偏りの警告
        │
        ▼ エンジン（別担当）→ runs/<app_id>/engine.json
        │
        ├─▶ interview.py（Sonnet 5.5）→ runs/<app_id>/interviews.json
        └─▶ report.py（Opus 5.5）   → runs/<app_id>/report.json
                │
                ▼ python -m teppuri.engine.build_replay <app_id>（エンジン担当）
          web/public/replays/<app_id>.json
```

判断担当はリプレイに直接書かない（エンジンを再実行しても消えないように。契約 v1）。

## 使い方

すべて **既定は dry-run**（費用見積もりを出すだけで API を呼ばない）。実行は `--yes`。`--mock` は API を呼ばずにダミーの出力を作る（費用ゼロなので `--yes` 不要）。

```bash
APP=apps/demo_matching/app.yaml
.venv/bin/python -m teppuri.judge.personas  --app $APP            # 見積もりだけ
.venv/bin/python -m teppuri.judge.personas  --app $APP --yes
.venv/bin/python -m teppuri.judge.decide    --app $APP --yes      # Batch API（最大24時間、多くは1時間以内）
.venv/bin/python -m teppuri.judge.decide    --app $APP --sync --limit 5 --yes   # 少数の動作確認
# エンジンが runs/<app_id>/engine.json を出したあと（別の場所なら --engine で指定）
.venv/bin/python -m teppuri.judge.interview --app $APP --yes
.venv/bin/python -m teppuri.judge.report    --app $APP --yes
.venv/bin/python -m teppuri.engine.build_replay demo_matching   # 合成（エンジン担当）
```

## 出力ファイルの形（エンジン担当が読む）

### personas.json
```json
{"app_id": "...", "models": ["claude-opus-5-5"], "market_summary_ja": "...",
 "segments": [{"segment_id": "...", "name_ja": "...", "description_ja": "...", "typical_attributes_ja": "..."}],
 "personas": {"12": {"cluster_id": 12, "interest": "low", "category_interest": "low", "segment_id": "...",
                     "persona_ja": "...", "motivations_ja": [], "concerns_ja": [], "person_id": 1234,
                     "label_ja": "...", "attributes": {}}},
 "missing_cluster_ids": []}
```
- `personas` のキーは cluster_id の文字列。**各クラスターの `interest`（low / mid / high）はこのアプリのカテゴリへの関心で、エンジンが広告クリック率に `multipliers.yaml` の interest 倍率を掛けるのに使う。** `category_interest` は同じ値（旧名）。
- 作られなかったクラスターは `missing_cluster_ids` に入る（エンジンは mid として扱うのが安全）。

### interviews.json
契約 §4 の `interviews` 配列と同じ形: `[{"person_id": 1234, "plan": "A", "qa": [{"q_ja": "…", "a_ja": "…"}]}]`

### report.json
```json
{"app_id": "...", "model": "claude-opus-5-5",
 "headline_ja": "一行の結論",
 "report_ja": "一行の結論\n\n本文（見出し付き。数字は事実の表の値に置き換え済み）",
 "drop_themes": [{"theme_ja": "本人確認への抵抗", "plan": "A", "step": "gate:id_verification",
                  "drop_reason_ids": ["A.dr0"], "summary_ja": "…"}],
 "facts": {"A.totals.installs.p50": {"value": "154", "label": "…"}},
 "template": {"headline_ja": "…", "report_ja": "…{{A.totals.installs.p50}}…", "themes": []}}
```
- リプレイに入れるのは `report_ja` と `drop_themes`。
- `drop_reason_ids` の `A.dr0` は `engine.json` の `plans.A.drop_reasons[0]`（案と配列の位置）を指す。
- `facts` は report_ja の数字の出どころ（すべて engine.json の値を整形しただけ）。`template` は置き換え前の文章。

- API キーは `teppuri/.env` の `ANTHROPIC_API_KEY`。表示も記録もしない。
- 結果は `runs/<app_id>/.judge_cache/` に1リクエスト1ファイルで保存する。同じリクエストは二度送らない（プロンプトや画像を変えると別のキーになる）。
- Batch は送信した ID を保存するので、途中で止めても再実行すれば同じ Batch の結果を待つ（二重送信しない）。
- 画像は Files API で一度だけアップロードし、`file_id` で参照する（Batch の容量制限を避けるため）。
- プロンプトはすべて `prompts/` の日本語ファイル。

## モデルの選び方

| 仕事 | モデル | 理由 |
|---|---|---|
| 市場の整理とペルソナ（代表人物 50 人ずつ） | Opus 5.5（effort high / medium） | 1回だけで、ペルソナの質が全判断の土台になる |
| 段階ごとの判断 | Haiku 5.5（effort low） | 数千回。Batch API で半額、先頭（system・アプリ情報・全画面・全広告）は全呼び出しで同じなので1時間キャッシュ。変わるのは末尾の人物と段階だけ |
| 離脱理由のテーマとレポート | Opus 5.5（effort high） | 文章の質が見られる。数字は ID 引用だけにして検査する |
| インタビュー | Sonnet 5.5（effort low） | その人の記録だけを根拠に、自然な話し言葉で答える。公開サイト用に事前生成 |

Opus / Sonnet の同期呼び出しでは、安全判定で拒否されたときにサーバー側で別モデルに切り替える `fallbacks: "default"`（beta `server-side-fallback-2026-07-01`）を付けている。実際に答えたモデルは出力の `model` に記録する。

## 甘い判断への対策（decide）

LLM はアプリに好意的に偏りやすい。プロンプトと出力形式で次のように抑える。

- 比べる相手は「同じカテゴリの平均的なアプリ」。平均的なアプリでも多くの人が離れる、それは similar だと明示。
- 画面と広告は作り手が良く見せたもの。見た目だけで higher にしない。根拠がなければ similar。
- higher / lower には根拠（画面の具体的な要素 or 属性・性向）を必須にし、`evidence_kind` / `evidence_ja` として記録。
- 出力の順番を「やめる理由 → 進む理由 → 根拠 → level」にして、先に否定側を考えさせる。
- 判断の分布を `decisions_summary.json` に出し、higher が半分を超える・全部 similar・根拠のない higher/lower・理由に数字、を警告する。

## レポートに数字を作らせない仕組み（report）

1. コードが engine.json から「事実の表」（`A.totals.installs.p50 = 154`、比較 `cmp.B_minus_A.*` / `cmp.p_B_better.*` など）を作る。
2. Opus は本文に数字を書かず `{{A.totals.installs.p50}}` で引用する。
3. コードが検査: 算用数字・全角数字・漢数字の割合や倍率（「二倍」「三割」）の直書き、表にない ID。違反なら1回だけ書き直させ、それでも駄目なら止める。
4. コードが ID を値に置き換え、最後に「本文の数字はすべて表の値」かを確かめる。案の差はエンジンの comparison だけを引用し、自分で計算した差・比率・日本全体への換算は書かせない（換算は Web が `scale_to_japan` で行う）。

## 費用の目安（1アプリ × A/B、代表 400 人、広告 3 素材ずつ、関門 1 つ、画面 5 枚）

見積もり機能での推定（トークンは文字数と画像サイズからの概算）。

| 段階 | 呼び出し | 推定 |
|---|---|---|
| personas（Opus 5.5） | 9 回（市場の整理 1 + 50人×8） | 約 $3.7〜4.2 |
| decide（Haiku 5.5, Batch） | 6,400 回 = 2案 × (広告3 + 段階5) × 400人 | 約 $1.5（キャッシュあり）〜 $6.6（なし） |
| interview（Sonnet 5.5） | 8 回（案ごと4人 × 4問を1回で） | 約 $0.1 |
| report（Opus 5.5） | 1〜2 回 | 約 $0.15〜0.3 |
| 合計 | 約 6,420 回 | **約 $5.5〜11** |

Batch 内のキャッシュはベストエフォートなので、上限側（キャッシュなし）も見ておく。2回目以降はディスクキャッシュで $0。

## 限界

- **LLM の偏り。** 対策を入れても好意的・紋切り型の判断は残りうる。分布を必ず見て、偏りはレポートで正直に書く。
- **代表人物の判断を全員が受け継ぐ。** 1クラスター（約 20〜30 人、実人口で数十万人）が同じ判断を持つ。クラスター内の違いはエンジンの揺らぎでしか表れない。画面ではその人の理由を「代表人物の声」と明示する。
- **ペルソナは属性からの推測。** 属性にない性格や事情は作らない決まりだが、Opus の想像が入る。
- **画面と広告の静止画だけを見る。** 実際の操作感、読み込み速度、通知、ストアのレビューは判断に入らない。
- **数字の妥当性はエンジン次第。** 判断は倍率（`rules/multipliers.yaml`）を通して効くだけで、判断の質が良くてもベンチマークが外れていれば結果は外れる。
- **相対判断の基準が曖昧。** 「カテゴリの平均」をモデルがどう想像しているかは検証できない。バックテストで方向が合うかを見る。

## テスト

```bash
.venv/bin/python -m pytest tests/test_judge.py
```

モッククライアントで、出力スキーマ（構造化出力の決まりと契約 §3）、ディスクキャッシュ、dry-run で API を呼ばないこと、キャッシュの先頭が全判断で同じこと、レポートに engine.json にない数字が入らないこと、リプレイやエンジンの出力に書き込まないこと、を確かめる。仮データは `tests/fixtures/judge/`。
