# テプリ — 開発ルール

アプリを日本で出す前に、統計から作った「架空の日本人1万人」で発売とマーケティングを試し、A案とB案の結果を範囲で比べるシミュレーター。Built with Claude: Japan 2026 の応募作品。

## 必ず守ること
- **コードはこのリポジトリで一から書く。** 他のプロジェクト（Rehearsal、作者の別アプリなど）のコード・データ・画面・画像・映像は持ち込まない。
- 画面、README、コードコメント、コミットメッセージは**日本語**。変数名・関数名は英語。
- **数字はエンジンだけが作る。** Claude の判断は「このカテゴリの平均より 高い / 同じくらい / 低い」と理由だけ。エンジンが倍率にしてベンチマークに掛ける。
- ベンチマーク値には**必ず出典**（`data/DATA_SOURCES.md` の略称と表・ページ）を付ける。出典のない値は入れない。
- 実在の会社・アプリの名前やデザインをデモに使わない。デモアプリは架空の日本のマッチングアプリ。
- 再配布できない資料（企業レポートPDF、MMD の数値など）はリポジトリに入れない。`data/DATA_SOURCES.md` 6章に従う。
- API キーは `.env`（コミットしない）。コードやログにキーを書かない。
- **コミットとプッシュはメインセッションだけが行う。** 担当エージェントはファイルを作るまで。

## ディレクトリと担当
| パス | 内容 | 担当 |
|---|---|---|
| `data/` | 出典ファイル、`DATA_SOURCES.md`、生成した人口 | 人口担当 |
| `teppuri/population/` | 架空の日本1万人と代表人物の生成（LLM を使わない） | 人口担当 |
| `teppuri/engine/` | 世界エンジン（毎日のファネル計算、30回実行、リプレイ出力） | エンジン担当 |
| `rules/` | プリセット・ベンチマーク・倍率（出典付き YAML）。バックテスト前に固定 | エンジン担当 |
| `teppuri/judge/` | Claude による判断・ペルソナ設計・インタビュー・レポート | 判断担当 |
| `apps/` | アプリと実験の入力（デモアプリなど） | メイン |
| `web/` | 公開サイト（リプレイ再生のみ） | Web担当 |
| `backtest/` | バックテストの事例・予測・正解・レポート | メイン（正解は予測のコミット後にだけ入れる） |
| `docs/iterations.md` | 試行錯誤の記録 | 全員（追記のみ） |

自分の担当外のファイルは変えない。下の契約を変えたいときは、変えずに報告する。

## 契約 v0（担当どうしの受け渡し形式）

### 1. 人口 `data/population/japan_10k.csv`（UTF-8、1行1人、10,000行）
| 列 | 値 |
|---|---|
| `person_id` | 0〜9999 |
| `age` | 15〜79 |
| `sex` | `M` / `F` |
| `pref_code` | 1〜47（JIS）、`pref_name` は日本語 |
| `city_size` | `metro`（大都市）/ `city`（地方都市）/ `town`（町村） |
| `marital` | `unmarried` / `married` / `widowed_divorced` |
| `household` | 出典 CSV の区分を英語スラッグにしたもの（対応表を `data/population/README.md` に書く） |
| `employment` | 同上（6区分） |
| `income_band` | 同上 |
| `has_smartphone` | `true` / `false` |
| `os` | `ios` / `android` / `none` |
| `sns_line` `sns_x` `sns_instagram` `sns_tiktok` `sns_youtube` | `true` / `false`（利用の有無） |
| `trait_price` `trait_novelty` `trait_privacy` `trait_wom` `trait_ad_aversion` | `low` / `mid` / `high` |
| `weight` | この1人が表す実際の人数。合計 = 96,806,585（2025年国勢調査 15〜79歳） |
| `cluster_id` | 代表人物のグループ |

代表人物 `data/population/representatives.csv`: `cluster_id, person_id, cluster_size, cluster_weight, label_ja`（300〜500行）。

乱数は固定シード。同じコマンドで同じファイルが出ること。

### 2. アプリと実験 `apps/<app_id>/app.yaml`
```yaml
app_id: demo_matching
name_ja: （架空名）
preset: matching        # matching / subscription / habit / shopping
min_age: 18
description_ja: ...
screens: [screens/01.png, ...]
gates:                  # アプリが宣言する関門
  - id: id_verification
    name_ja: 本人確認
    docs_ja: 運転免許証など
    review_hours: 24
pricing: {monthly_jpy: 3900, free_trial_days: 0, who_pays: male}   # 例
plans:
  A:
    regions: [13, 14, 11, 12]       # pref_code。空なら全国
    period_days: 90                 # 30 / 90 / 180 / 365
    campaign_days: 30
    target: {age: [20, 34], sex: any}
    channels: {instagram: 3000000, tiktok: 2000000}   # 円
    creatives: [ads/a1.png]         # 最大3つ
  B: {...}
```

### 3. 判断 `teppuri/judge` → エンジン（`runs/<app_id>/decisions.json`）
```json
[{"plan": "A", "step": "install", "creative": "a1", "cluster_id": 12,
  "level": "higher", "reason_ja": "…", "model": "claude-haiku-5-5"}]
```
- `step`: `install` / `signup` / `gate:<gate_id>` / `core_action` / `retention` / `pay`
- `level`: `higher` / `similar` / `lower`。倍率は `rules/multipliers.yaml`（エンジン担当）。
- 判断がないときエンジンは `similar` として動く（判断担当の完成を待たずに作れる）。

### 4. リプレイ `web/public/replays/<app_id>.json`（エンジン → Web）
```json
{
  "meta": {"app_id": "...", "name_ja": "...", "period_days": 90, "runs": 30,
           "population": 10000, "scale_to_japan": 9680.6585, "generated_at": "...",
           "extrapolated_after_day": 90},
  "plans": {
    "A": {
      "daily": {"day": [1,2,...],
                "impressions": {"p10": [], "p50": [], "p90": []},
                "installs": {...}, "signups": {...}, "core_actions": {...},
                "active": {...}, "payers": {...}, "revenue_jpy": {...}},
      "totals": {"installs": {"p10": 0, "p50": 0, "p90": 0}, "...": {}},
      "sample_run": {"events": [[person_id, day, "install"], ...]},
      "drop_reasons": [{"step": "signup", "cluster_id": 12, "share": 0.18, "reason_ja": "…"}]
    },
    "B": {}
  },
  "people": [[person_id, pref_code, city_size, age, sex, cluster_id], ...],
  "clusters": [{"cluster_id": 12, "label_ja": "…", "representative": 1234}],
  "interviews": [{"person_id": 1234, "plan": "A", "qa": [{"q_ja": "…", "a_ja": "…"}]}],
  "report_ja": "…"
}
```
数字は1万人基準。日本全体は `scale_to_japan` を掛けて画面で出す。

## 契約 v1 の追補（2026-11-06、v0 より優先）
担当3者の報告で出た空欄を決めた。

**流れ:** エンジン → `runs/<app_id>/engine.json` ／ 判断（interview・report）→ `runs/<app_id>/interviews.json`、`report.json` ／ **合成** `python -m teppuri.engine.build_replay <app_id>` → `web/public/replays/<app_id>.json`。判断担当はリプレイに直接書かない（エンジン再実行で消えないように）。

**イベント** `sample_run.events` = `[person_id, day, step, n]`。`n` = この人が表す約9,680人のうち、その日にその段階へ進んだ人数（整数、1以上）。`step` は `install` / `signup` / `gate:<id>` / `core_action` / `trial` / `pay` / `churn` のみ。

**daily の意味:** `active` は「その日に使っている人数」。それ以外（impressions, reached, installs, signups, core_actions, payers, revenue_jpy）は「その日に新しく起きた数」。累計は `daily_cumulative`（installs, payers, revenue_jpy）に**回ごとに累計してから**分位点を取った p10/p50/p90 を置く。

**指標の定義:** `impressions` = 広告の表示回数。`reached` = 広告が届いた人数（重複なし、daily と totals）。`totals.payers` = 期間中に一度でも決済した人数。`totals.active_end` = 最終日の `active`。totals の追加項目（spend_jpy, installs_ad, installs_wom, gate:<id>, trials, cpi_jpy, roas）は正式項目。

**案の条件:** `plans.<A/B>.config` = app.yaml の plan（価格の上書きを反映したもの）をそのまま写す。

**比較:** `comparison` = `{"B_minus_A": {指標: {p10,p50,p90}}, "p_B_better": {指標: 0〜1}}`。同じ回どうしの差から計算する。指標は installs, payers, revenue_jpy, active_end, core_actions。

**判断まわり:** `install` 以外の段階の `creative` は `null`。creative の ID はファイル名（拡張子なし）で、案ごとに一意であればよい（判断は plan と組で引く）。`personas.json` の各クラスター `interest`（low/mid/high）をエンジンが読み、広告クリック率に `multipliers.yaml` の interest 倍率を掛ける。

**離脱理由:** `drop_reasons` はエンジンが判断の理由から作る（v0 のまま）。`drop_themes` = `report.json` のテーマを合成時に入れる。

**クチコミの内訳:** totals と daily に `installs_wom_x`（X 上の拡散経由）と `installs_wom_local`（身近な人づて）。`installs_wom` はその合計。

**追加（Web の要望）:** `daily_cumulative` に `reached` も入れる。`meta.gates` = `[{id, name_ja}]`（app.yaml の gates から）。

**地域:** plan の `regions` は既定で「出荷地域＝広告の出稿地域」。`available_outside_regions: true` なら regions は出稿地域だけを意味し、地域外の人もクチコミ経由で設置できる。`daily.payers` は「その日に新しく決済した人数」。

**任意項目:** `meta.is_mock`、`meta.note_ja`（モックのときだけ）。日付は「n日目」で表示し、`start_date` は置かない。

## 契約 v2 の追補（2026-11-06 夜、v1 より優先）
- **判断は1万人全員。** `decisions.json` の各要素は `cluster_id` の代わりに `person_id` を持つ（`cluster_id` も参考として残す）。エンジンは `person_id` があればその人の判断を使い、なければ `cluster_id` の判断、どちらもなければ `similar`。人ごとの揺らぎは person 判断のときは入れない。
- **運営中のアプリから始める（バックテスト用）:** app.yaml の plan に任意で
  - `initial_state: {active: <人数>, payers: <人数>, as_of_day_since_launch: <日>}`（日本全体の実人数。エンジンが1万人基準に換算して、属性に合う人へ配る）
  - `changes: [{day: 31, pricing: {...}}, {day: 31, channels: {...}}]`（期間の途中で価格・広告予算を変える）
- 代表人物のグループには `marital` も使う。
- `daily.paying`（その日に払い続けている人数、既存の決済者を含む）と `totals.paying_end`。`daily.payers` / `totals.payers` は新規の決済のみ。
- **判断の意味:** 「この人がその段階まで来たとき、カテゴリ平均のアプリと比べて進みやすいか」。地域・SNS利用・広告到達・密度はエンジンが計算するので判断の理由にしない。人単位の判断がある人には persona の `interest` 倍率を掛けない。
- `initial_state` に任意で `monthly_churn`（成熟期の月次解約率。公開値があるとき）と `ever_installed`（累計設置者。無ければエンジンが推定）。`changes` に任意で `phase_in_days`（既存の決済者へ新価格を N 日かけて適用）。
- リプレイに `person_decisions: [{plan, person_id, step, level, reason_ja}]`（`people` にいる人の分だけ、build_replay が decisions.json から入れる）。`daily_cumulative` に `core_actions` も入れる。
- バックテストの表示用 `web/public/backtest.json` の形は `web/src/lib/backtest.ts` に従う（`teppuri/backtest` が書き出す）。
- 区間集計は `teppuri/engine/window.py` の `interval_band`（回ごとに集計してから分位点）を使う。

## コマンド
```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m teppuri.population.build      # 人口を作る
.venv/bin/python -m pytest
cd web && npm install && npm run dev
```
