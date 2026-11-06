# 判断担当（teppuri/judge）

テプリの中で Claude が働く部分です。**数字は作りません。** Claude が出すのは「このカテゴリの平均より higher / similar / lower」と理由、人物像、インタビューの答え、レポートの文章だけです。数字はエンジンが作り、レポートはエンジンの数字を ID で引用します。

## 流れ

```
apps/<app_id>/app.yaml + 画面・広告画像
data/population/representatives.csv (+ japan_10k.csv の属性)
        │
        ▼ personas.py（Opus 5.5・アプリごとに1回）
runs/<app_id>/personas.json        市場の整理（人の種類）と、グループ（代表人物）ごとのペルソナ
        │
        ▼ decide.py（Haiku 5.5・Batch API + プロンプトキャッシュ。1人 × 1案 = 1回）
runs/<app_id>/decisions.json       契約 v2。1万人の一人ずつ × 案 × 段階（install は広告素材ごと）
runs/<app_id>/decisions_detail.json  やめる理由・進む理由・根拠の種類も含む全文
runs/<app_id>/decisions_summary.json 判断の分布と偏りの警告
runs/<app_id>/recognition_check.json 「このアプリが何か分かるか」の確認（--recognition-check のとき）
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
.venv/bin/python -m teppuri.judge.decide    --app $APP --yes      # 全員。Batch API（最大24時間、多くは1時間以内）
.venv/bin/python -m teppuri.judge.decide    --app $APP --sample 50 --yes        # 対象者から50人（固定シード）
.venv/bin/python -m teppuri.judge.decide    --app $APP --sync --limit 5 --yes   # 少数の動作確認
.venv/bin/python -m teppuri.judge.decide    --app $APP --recognition-check 3 --yes  # 記憶の確認（バックテスト用）
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
| 一人ひとりの判断 | Haiku 5.5（effort low） | 約1万7千回（対象者 × 2案）。1回でその案の全段階を判断。Batch API で半額、先頭（指示・アプリ情報・全画面・全広告）と出力スキーマは全呼び出しで同じなので1時間キャッシュ。変わるのは末尾の人と案の条件だけ |
| 離脱理由のテーマとレポート | Opus 5.5（effort high） | 文章の質が見られる。数字は ID 引用だけにして検査する |
| インタビュー | Sonnet 5.5（effort low） | その人の記録だけを根拠に、自然な話し言葉で答える。公開サイト用に事前生成 |

Opus / Sonnet の同期呼び出しでは、安全判定で拒否されたときにサーバー側で別モデルに切り替える `fallbacks: "default"`（beta `server-side-fallback-2026-07-01`）を付けている。実際に答えたモデルは出力の `model` に記録する。

## 偏った判断への対策（decide）

LLM は好意的にも、指示しだいで厳しくも偏る。プロンプトと出力形式で次のように抑える。

- 比べる相手は「同じカテゴリの平均的なアプリ」。平均的なアプリでも多くの人が離れる、それは similar だと明示。
- higher と lower は対称: 同じ強さの根拠が要る。具体的な長所がこの人に合えば higher、具体的な短所が合わなければ lower、どちらとも言えなければ similar。見た目の印象だけでは higher も lower もしない（2026-11-06、higher を抑えすぎたため非対称な決まりを直した）。
- higher / lower には根拠（画面の具体的な要素 or 属性・性向）を必須にし、`evidence_kind` / `evidence_ja` として記録。
- 出力の順番を「やめる理由 → 進む理由 → 根拠 → level」にして、先に否定側を考えさせる。
- 判断の分布を `decisions_summary.json` に出し、higher か lower が半分を超える・全部 similar・根拠のない higher/lower・理由に数字・判断の欠け、を警告する。

## 判断の意味（エンジンとの約束、2026-11-06 決定）

各段階の level は「**この人が、その段階まで来たとき、このカテゴリの平均的なアプリと比べて進みやすいか**」。

- **条件付き**: install は「この人が自分の使うチャネルで、この広告を見た」前提。signup 以降は「前の段階まで進んだ」前提。
- **使わせない理由**（エンジンが別に計算する）: 地域・出稿地域の外かどうか、その SNS を使っているか、広告が届くか、近くに相手がいるか（密度）。判断の入力からも、案の地域・ターゲット・チャネルと、本人の都道府県・都市規模・SNS 利用を外している。
- **使ってよい理由**（エンジンは扱わない）: 婚姻・年齢・ライフステージなど本人に合うか、性向（価格、プライバシー、新しさ、口コミ、広告嫌い）、画面・広告・料金・関門の中身。
- **エンジン側**: 人単位の判断がある人には、personas.json の `interest` 倍率を掛けない（関心は判断に含まれているので二重計算になる）。`interest` は人単位の判断がない人（グループの判断で補う人）にだけ使う。

## モデルの記憶への対策（decide）

有名なアプリだと「知っているから使う」と答えるおそれがある。

- プロンプトで、アプリ名・会社名・ブランドを判断材料にしない、実在のアプリに似ていても入力された情報だけで判断する、比べる相手はいつもカテゴリ平均、と明記。
- `--recognition-check N` で「このアプリが何か分かるか」を N 回だけ別に聞き、`recognition_check.json` に残す。バックテストでは、分かったと答えた事例を分けて報告する（設計 5-6）。

## 対象者

`japan_10k.csv` の全員のうち、app.yaml の `min_age` 以上でスマホを持つ人だけを呼ぶ（対象外の人は判断を出さず、エンジンが扱う）。`cluster_id` は personas.json を引くためだけに使い、値には依存しない（グループ分けが変わったら personas を作り直せばよい）。

## レポートに数字を作らせない仕組み（report）

1. コードが engine.json から「事実の表」（`A.totals.installs.p50 = 154`、比較 `cmp.B_minus_A.*` / `cmp.p_B_better.*` など）を作る。
2. Opus は本文に数字を書かず `{{A.totals.installs.p50}}` で引用する。
3. コードが検査: 算用数字・全角数字・漢数字の割合や倍率（「二倍」「三割」）の直書き、表にない ID。違反なら1回だけ書き直させ、それでも駄目なら止める。
4. コードが ID を値に置き換え、最後に「本文の数字はすべて表の値」かを確かめる。案の差はエンジンの comparison だけを引用し、自分で計算した差・比率・日本全体への換算は書かせない（換算は Web が `scale_to_japan` で行う）。

## 費用の目安（1アプリ × A/B、1万人）

### 実測（2026-11-06、decide のみ）
仮アプリ（画面なし、広告3素材ずつは画像なし、関門1つ）と実際の人口 `data/population/` から、対象者50人 × 2案 = 100回を Batch API（キャッシュあり）で実行した。

| 項目 | 実測 |
|---|---|
| 費用 | 100回で $0.032（1人×1案あたり約 $0.00032） |
| トークン（1回平均） | 入力 514 + キャッシュ読み込み 3,736 + 出力 1,058（思考を含む） |
| キャッシュ | 書き込みは2回だけ（同期1回 + Batch 1回）、残りはすべて読み込み |
| 時間 | Batch 99回の送信から結果まで 459秒（約8分） |

再測定（判断の意味を決めた後のプロンプト、A案のみ、ターゲット内50人 + 無作為50人 = 100回）: $0.031、キャッシュ書き込み1回・残り99回は読み込み、2つの Batch を並行して 368秒。単価は変わらない。

### 1万人 × 2案の見積もり
対象者 8,489人（18歳未満・スマホなし 1,511人は対象外）× 2案 = 16,978回。

| 条件 | 推定 |
|---|---|
| 画面なし（実測の単価 × 回数） | 約 $5.4 |
| 画面5枚 + 広告3枚ずつの画像あり（デモアプリで実測した単価 × 回数） | 約 $9.5（キャッシュが効いた場合）〜 約 $36（効かなかった場合） |

デモアプリでの実測（2026-11-06、ターゲット内25人×A案 + 25人×B案 = 50回、Batch）: $0.028（1回あたり約 $0.00056）。先頭（指示・アプリ情報・画像11枚）は約3万7千トークンで、書き込み1回・残り49回は読み込み（A案とB案で同じ先頭を共有）。2つの Batch を並行して 403秒。画像のトークンは当初の推定式の約2倍だったので、見積もりに補正を入れた。

他の段階（推定）: personas（Opus、市場の整理1回 + 50人ずつ8回）約 $3.7〜4.2、interview（Sonnet、8回）約 $0.1、report（Opus、1〜2回）約 $0.15〜0.3。**1アプリ × A/B の合計は約 $14（キャッシュが効いた場合）**。2回目以降はディスクキャッシュで $0。Batch の処理時間は件数に比例するとは限らず、公式には多くが1時間以内、最大24時間。

## 限界

- **LLM の偏り。** 対策を入れても好意的・紋切り型の判断は残りうる。分布を必ず見て、偏りはレポートで正直に書く。
- **判断は一人ずつだが、人物像はグループ単位。** 属性は本人のもの、ペルソナ要約は所属グループ（代表人物）のもの。同じグループの人は似た判断になりやすい。
- **使わせない理由が漏れることがある。** プロンプトと入力で地域・SNS・密度を外しているが、モデルが別の言い方で持ち込む可能性はある。理由の文は `decisions_detail.json` で確かめる。
- **ペルソナは属性からの推測。** 属性にない性格や事情は作らない決まりだが、Opus の想像が入る。
- **画面と広告の静止画だけを見る。** 実際の操作感、読み込み速度、通知、ストアのレビューは判断に入らない。
- **数字の妥当性はエンジン次第。** 判断は倍率（`rules/multipliers.yaml`）を通して効くだけで、判断の質が良くてもベンチマークが外れていれば結果は外れる。
- **相対判断の基準が曖昧。** 「カテゴリの平均」をモデルがどう想像しているかは検証できない。バックテストで方向が合うかを見る。

## テスト

```bash
.venv/bin/python -m pytest tests/test_judge.py
```

モッククライアントで、出力スキーマ（構造化出力の決まりと契約 §3）、ディスクキャッシュ、dry-run で API を呼ばないこと、キャッシュの先頭が全判断で同じこと、レポートに engine.json にない数字が入らないこと、リプレイやエンジンの出力に書き込まないこと、を確かめる。仮データは `tests/fixtures/judge/`。
