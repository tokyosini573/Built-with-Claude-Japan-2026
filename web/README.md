# テプリ Web（リプレイ再生）

エンジンが事前に計算したリプレイ（`public/replays/<app_id>.json`）を読み込んで再生するだけの静的サイトです。ライブ実行はしません。

> 画面のレイアウトとデモの見せ方はまだ決めていません。いまあるのは、どの画面にも使う**土台の部品**と、それを並べた**開発用ページ**（`/?dev`）だけです。

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
| `JapanMap` | `src/components/JapanMap.tsx` | Canvas に47都道府県と1万点。出稿地域の強調、テーマ対応 |
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
