# テプリ Web（リプレイ再生）

エンジンが事前に計算したリプレイ（`public/replays/<app_id>.json`）を読み込んで再生する静的サイトです。「ライブで試す」（`#/live`）だけは、ブラウザの中でエンジンを回し直します（下の節）。

## ライブで試す（`#/live`）

デモアプリの A案・B案の条件（期間、キャンペーン日数、地域、チャネル別の予算、男性の月額、無料体験日数、動画の大量投稿）を変えて、ブラウザの中で世界エンジンをもう一度回します。

- **Claude は呼ばない。** 判断は事前に取った1万人分（`runs/demo_matching/decisions.json`）の level をそのまま使う。広告・動画の素材は変えられない（判断が素材に結びついているため）。
- **エンジンは Python のものをそのまま使う。** Pyodide（cdn.jsdelivr.net の 314.0.7、numpy・pandas・PyYAML）を Web Worker（`src/live/live.worker.ts`）で読み込み、`teppuri/engine/live.py` の `LiveSession`（= `python -m teppuri.engine.run` と同じ処理）で回す。結果は結果画面の部品（`ResultPage`）で出す。インタビュー・レポート・理由の文はライブでは出さない。
- ファイル一式 `public/live/`（エンジンの .py、`rules/*.yaml`、1万人、判断の level だけ、ペルソナの interest だけ、app.yaml、`manifest.json`）は `npm run build-live` で作る（約1.9MB、gzip で約0.26MB）。エンジン・ルール・判断を変えたら作り直す。
- ネイティブとの一致: `npm run check-live`（条件を変えないときの `engine.run` との一致と、Node の Pyodide（`scripts/live-pyodide-node.mjs`、devDependencies の pyodide 同じ版）とネイティブの一致を、いくつかの条件で確かめる）。

## 公開画面（設計 6章 v2）

トップ（`#/`、`src/app/TopPage.tsx`）は1枚の縦長ページです。上から: ヒーロー（点でできた日本地図 `src/components/HeroDots.tsx`。下の「ヒーローの図」。動きを減らす設定では静止）→ 解決したいこと → しくみ → 得られるもの → 期待できる効果 → なぜ信じられるか → デモ → Claude の使い方 → 「テプリで試す」（デモを再生 / ライブで試す）。デモの数字はリプレイ、バックテストの的中数は `backtest.json` から読みます（画面に数字を書き写さない）。「デモを再生」は結果へ移って自動で再生し、「ライブで試す」は `#/live`（今は「準備中」の仮ページ）に移ります。

### ヒーローの図

- 点1つが架空の1万人の1人。結果画面の地図と同じ置き方（`src/lib/geo.ts` の `placePeople`: 県の形の内側に person_id をシードにしたゆらぎ）なので、人の多い県ほど点が密になる。沖縄県ははめ込み。県の境界は描かない（点だけで形を出す）。
- 色づき方（広告が届いた → インストール → 使い続けている → 課金した）は**イメージ**で、実際の結果ではない（person_id から決まる固定の割り当て。地域の差はない）。図の下にそう書いている。
- 点の都道府県は `public/hero/people.json`（約28KB）から読む。リプレイ本体（約11MB）をトップで読まないため。リプレイの `people` が変わったら作り直す:

```bash
npm run build-hero   # public/replays/demo_matching.json → public/hero/people.json
```

メニューは4つで、どれも「最初は要点だけ、押すと詳しく」の3段です。

| メニュー | 1段目 | 2段目（押すと） | 3段目 |
|---|---|---|---|
| 結果 `#/result` | 一行の結論（`comparison.p_B_better`）、再生される地図（A/B 並べて。スマホは切り替え）、数字カード3枚 | カード → ファネル・日ごとの推移・離れた理由の上位3つ | 地図の点か「話を聞いた人」→ 一人のシート（プロフィール、たどった道、Claude の判断、インタビュー）。Esc で閉じる |
| 入力 `#/input` | アプリ画面5枚、A案・B案の条件カード | 広告費の内訳・広告素材・関門・価格・途中の変更 | — |
| 検証 `#/verify`（白黒） | 「◯問中◯問的中」と比較の基準 | 事例カード | 質問ごとの「はい」の確率と実際、出典 |
| 根拠 `#/sources` | 「1万人は何からできているか」の図 | 属性ごとの出典表 | 限界の全文（`data/population/README.md` と `data/DATA_SOURCES.md` 5章をそのまま読み込む）、`#/sources-full` で DATA_SOURCES 全文 |

- リプレイは `?replay=<id>`。なければ `demo_matching` → `mock` の順に探します（`src/config.ts`）。モックのときは上に注意を出します。
- 結論に使う指標、カードの指標、指標の呼び名（core_actions =「初マッチ」）、画像の置き場所も `src/config.ts`。
- アプリ画面と広告素材: `npm run sync-apps` で `apps/<app_id>/` の `screens/`・`ads/` を `public/apps/<app_id>/` に写し、`app.yaml` から `app.json`（名前・説明・関門の詳細）を作ります（PyYAML は `../.venv`）。
- バックテスト: `public/backtest.json`（今はモック。形は `src/lib/backtest.ts`）。
- 一人の判断の理由: リプレイに任意の `person_decisions: [{plan, person_id, step, level, reason_ja}]` があれば使い、なければ同じグループの `drop_reasons` を出します。
- 色は `src/index.css` のトークンだけ。主役色は深い藍（`--brand`）で、ヒーロー・しくみ・はじめる・下の帯の大きな面に敷く（相棒は若竹 `--b`）。白いカード（やわらかい影・角丸）、節の上のラベルは主役色。背景の形（波・しずく・リボン）は `src/components/Shapes.tsx`。検証は白黒のまま（主役色はラベルだけ）。A案 = 藍、B案 = 若竹。
- 結果の地図はトップの図と同じ「点だけ」の見た目（`JapanMap` の `variant="dots"`。県の境界と塗りは描かない）。点の色は 未接触（灰）→ インストール（案の色・薄）→ 初マッチ（案の色・濃）→ 課金（ピンク `--pay`）、やめた（灰）。出稿地域があるときは地域の中の点を濃く、外を薄くする。
- トップの上のバーはロゴだけ。メニュー（結果・入力・検証・根拠）は結果などのページで出す。
- ファビコンは `public/favicon.svg`（マスコットの顔とヘッドホンだけ）と `public/apple-touch-icon.png`（180px、同じ顔を主役色の地に）。

以下は前からある土台の部品と開発用ページ（`/?dev`）の説明です。

## 起動

```bash
cd web
npm install
npm run dev          # http://localhost:5173/?dev を開く
```

- `/?dev` … 開発用ページ（モックリプレイで部品を確認）
- `/?dev&replay=<id>` … `public/replays/<id>.json` を読む（例: エンジンが出した `demo_matching`）

## ビルド

```bash
npm run build        # 型チェック（tsc）→ dist/ に出力
npm run preview      # ビルド結果を確認
```

既定では相対パス（`base: "./"`）で出力するので、どのサブパスにも置けます。GitHub Pages などで絶対パスにしたいときは:

```bash
VITE_BASE=/teppuri/ npm run build
```

## モックリプレイ

エンジンが本物を出すまでの開発用です。数字に根拠はありません（`meta.is_mock: true` と `meta.note_ja` で明示）。

```bash
npm run mock         # → public/replays/mock.json（固定シード。何度実行しても同じファイル）
```

内容: 架空の1万人（都道府県はおおよその比率）、A案（首都圏・30日）と B案（全国・60日）、180日間（90日より後は「推計の延長」扱い）、30回分の p10/p50/p90、地図用の1回分のイベント。

## 地図データ

```bash
npm run build-map    # 固定コミットの元データを取得して public/geo/japan-prefectures.json を作り直す（約160KB）
```

出典とライセンスは [ATTRIBUTION.md](./ATTRIBUTION.md)。地図を出す画面には出典表記が必要です。

## 部品一覧

| 部品 | ファイル | 内容 |
|---|---|---|
| リプレイの型・読み込み・検証 | `src/lib/replay.ts` | 契約 §4 の型。`loadReplay(id)` は形が合わないとき、どこが違うかを日本語で列挙した `ReplayError` を投げる |
| 読み込みフック | `src/lib/useReplay.ts` | `useReplay(id)`、`useStateTimeline(replay, "A")` |
| 状態の計算 | `src/lib/states.ts` | `sample_run.events` から各日・各人の状態（未接触/インストール/登録/核心行動/無料体験/決済/離脱）と点の数を作る。色とラベルもここ |
| 地図の計算 | `src/lib/geo.ts` | 境界の読み込み、投影（沖縄はめ込み）、person_id をシードに県の形の内側へ点を置く |
| 数字の表示 | `src/lib/format.ts` | 万・億の表記、1万人基準 ⇔ 日本全体換算（`scale_to_japan`） |
| `JapanMap` | `src/components/JapanMap.tsx` | Canvas に47都道府県と1万点。出稿地域の強調、テーマ対応。`variant="dots"` で県の形を描かず丸い点だけ（結果画面） |
| `Timeline` / `usePlayback` | `src/components/Timeline.tsx` | 日付スライダー、再生/一時停止、速度（1/3/7/15日/秒）。延長部分の表示 |
| `RangeCompare` | `src/components/Metrics.tsx` | 主要指標（インストール・登録・継続（最終日）・決済した人・売上）を A/B で p50 と p10〜p90 の帯で比べる |
| `ABComparison` / `ProbabilityBar` | 同上 | `comparison` から、差（B − A）の範囲と「B案が良い確率」を出す |
| `Funnel` | 同上 | 広告が届いた人 → インストール → 登録 → 関門 → 核心行動 →（無料体験）→ 決済した人。表示回数と最終日の継続は別に出す |
| `ScaleToggle` / `ExtrapolationNote` / `StateLegend` | 同上 | 1万人/日本全体の切り替え、「推計の延長」注記、地図の凡例（状態ごとの人数） |
| `DailyChart` | `src/components/DailyChart.tsx` | 日別または累計（`daily_cumulative`）の中央値（線）と10〜90%（帯）。延長部分の網掛け、再生中の日の縦線、ホバーで数値 |
| `ReplayErrorView` / `MockBanner` | `src/components/ReplayErrorView.tsx` | 壊れたデータのエラー表示、モックの注意 |

色は `src/index.css` の変数（ライト/ダーク）と `src/lib/states.ts` の `STATE_COLORS` にまとめてあります。どちらも仮の配色で、画面デザインが決まったら差し替えます。

## リプレイの読み方（契約 v1）

- 契約は `CLAUDE.md` の §4 と「契約 v1 の追補」。モック（`npm run mock`）も v1 の形で出す。
- エンジンの合成コマンドが出す `public/replays/<app_id>.json` は `/?dev&replay=<app_id>` で読む。v1 の項目（`reached`、`daily_cumulative`、`config`、`comparison`、`drop_themes`、events の `n`）がない古い形でも表示はでき、足りない点は開発用ページに「契約 v1 と違う点」として出る。
- 地図の点は events の step（`install` / `signup` / `gate:<id>` / `core_action` / `trial` / `pay` / `churn`）だけで色を変える。広告が届いた人はイベントにないので、`daily.reached` の数字で出す。
- 点の濃さは、その人が表すグループのうち期間中にインストールした人数 `n` の合計で少しだけ変える。
- 点の数は日本全体換算を掛けない（点は「グループの中で進んだ人がいた」という意味のため）。`cpi_jpy`・`roas` も比なので掛けない。
- 地域の強調表示は `plans.X.config.regions`（空なら全国）。
