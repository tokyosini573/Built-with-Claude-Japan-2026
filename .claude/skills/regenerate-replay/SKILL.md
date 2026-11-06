---
name: regenerate-replay
description: アプリの入力やルールを変えたあと、公開サイト用のリプレイ JSON を作り直す手順。エンジン実行 → 判断（interview・report）→ build_replay → Web で表示確認。
argument-hint: "[app_id]"
---

# リプレイを作り直す

対象アプリ: `$ARGUMENTS`（以下 `<app_id>`）

流れは契約 v1: エンジン → `runs/<app_id>/engine.json` ／ 判断 → `runs/<app_id>/interviews.json`・`report.json` ／ 合成 → `web/public/replays/<app_id>.json`。判断担当はリプレイに直接書かない。

## 0. 前提を確かめる
- `apps/<app_id>/app.yaml` が契約 §2 の形か。
- 判断（`runs/<app_id>/personas.json`、`decisions.json`）が今の app.yaml・画面と合っているか。画面・広告・案を変えたなら判断から作り直す:
  ```bash
  APP=apps/<app_id>/app.yaml
  .venv/bin/python -m teppuri.judge.personas --app $APP          # まず dry-run で費用を見る
  .venv/bin/python -m teppuri.judge.personas --app $APP --yes
  .venv/bin/python -m teppuri.judge.decide   --app $APP --sync --limit 5 --yes   # 少数で実測
  .venv/bin/python -m teppuri.judge.decide   --app $APP --yes   # Batch API
  ```
  `decisions_summary.json` の分布と警告（higher が半分超、根拠なしなど）を必ず見る。

## 1. エンジン
```bash
.venv/bin/python -m teppuri.engine.run apps/<app_id>/app.yaml --runs 30
```
`runs/<app_id>/engine.json` の totals（p10/p50/p90）と comparison を見て、桁がおかしくないか（設置 > 登録 > 決済、CPI が出典の範囲付近か）を確かめる。

## 2. 判断（エンジンの数字を使う部分）
```bash
.venv/bin/python -m teppuri.judge.interview --app apps/<app_id>/app.yaml --yes
.venv/bin/python -m teppuri.judge.report    --app apps/<app_id>/app.yaml --yes
```
レポートは数字を事実の表の ID で引用する。検査に落ちたら止まるので、プロンプトではなく原因（表にない ID など）を直す。

## 3. 合成
```bash
.venv/bin/python -m teppuri.engine.build_replay <app_id>
```

## 4. Web で確かめる
```bash
cd web && npm run typecheck && npm run dev
```
ブラウザで `<app_id>` を開き、A/B の範囲、地図の点、離脱理由、インタビュー、レポートが出ること、90日を超える部分に「推定」の表示があることを見る。

## 5. 記録
- 結果が前回から大きく動いたら、理由を `docs/iterations.md` に追記する。
- コミットはメインセッションだけ。
