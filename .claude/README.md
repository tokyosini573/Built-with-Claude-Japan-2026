# `.claude/` — この開発での Claude Code の使い方

テプリは Claude Code を中心に作っています。このフォルダは、実際の開発のやり方をそのまま設定にしたものです。使っていない機能は入れていません。

## やり方
- **メインセッションは点検と再指示だけ。** 合意した設計（範囲・人口・エンジン・Claude の使い方・バックテスト・画面）に照らして、担当サブエージェントの結果を点検し、出典がない・設計とずれるときはやり直させます。コミットとプッシュもメインセッションだけです。
- **担当サブエージェントを同時に動かす。** 調査、検証、人口、エンジン、判断、Web、バックテスト、デモアプリ。担当ごとに触ってよいフォルダが決まっていて（`CLAUDE.md` の表）、受け渡しの形式は `CLAUDE.md` の「契約」です。
- **検証担当は調査担当と独立に元資料を読み直す。** 人口の出典は調査5本と独立検証4回を経ています（`docs/iterations.md`）。
- **数字はエンジンだけが作る。** Claude（製品の中の Claude）は「平均より高い / 同じ / 低い」と理由、文章だけを出します。
- **バックテストはコミットの順番が証拠。** ①ルール固定 ②入力 ③予測 ④正解 ⑤レポート。正解は予測のコミットまでリポジトリの外に封印します。

## 中身

| 種類 | ファイル | なぜ使うか |
|---|---|---|
| サブエージェント | `agents/researcher.md` | 数字の元資料を探す。出典（URL・表・ページ）のない数字を作らせない |
| | `agents/verifier.md` | 調査担当の説明に頼らず、元資料を開き直して照合する。作り話の数字を見つける役 |
| | `agents/population.md` | 架空の日本1万人を出典 CSV から作る（LLM を使わない） |
| | `agents/engine.md` | ファネル計算と `rules/`。数字を作る唯一の場所 |
| | `agents/judge.md` | 製品の中の Claude（ペルソナ・判断・インタビュー・レポート）。数字を作らせない仕組みを守る |
| | `agents/web.md` | リプレイを再生するだけのサイト |
| | `agents/backtest.md` | 事例の入力と質問。正解は封印フォルダへ |
| | `agents/demo-app.md` | 架空のマッチングアプリの入力と A/B 案 |
| Skills | `skills/add-benchmark/` | ベンチマーク値を足す手順。出典・範囲・assumption の理由・テスト・感度表まで |
| | `skills/regenerate-replay/` | エンジン → 判断 → build_replay → Web 確認。何度も繰り返す作業なので手順を固定 |
| | `skills/backtest-freeze/` | バックテストのコミット順とチェックリスト |
| Hooks | `settings.json` + `hooks/` | 下の3つ。人やエージェントが忘れても止まる・知らせる仕組み |

### Hooks

| いつ | スクリプト | すること |
|---|---|---|
| PostToolUse（Edit / Write） | `hooks/engine_tests.sh` | `teppuri/engine/` か `rules/` のファイルが変わったら `pytest tests/test_engine.py -q` を走らせる。失敗したら exit 2 で結果の末尾を Claude に返す |
| PreToolUse（Edit / Write） | `hooks/rules_source_guard.sh` → `hooks/check_rules_source.py` | `rules/*.yaml` の書き込み後の内容を YAML として読み、数値の `low / mid / high / value` があるのに `source` がない項目を見つけたら止める。誤検出を避けるため、今回の書き込みで**新しく増えた**違反だけを止め、すぐ上の階層の `source` も認める |
| PreToolUse（Edit / Write / Bash） | `hooks/answers_seal.sh` | `backtest/predictions.json` がコミットされる（`git log -- backtest/predictions.json` が空でなくなる）まで、`backtest/answers.yaml` への書き込みを止める。Bash は、書き込みに使う書き方（`>`、`cp`、`mv`、`tee`、`sed -i`、`git add` など）とファイル名が一緒にあるときだけ止める |

スクリプトは macOS の `/bin/bash` と `jq`、リポジトリの `.venv`（PyYAML）で動きます。hooks は Claude Code を `teppuri/` で起動したときに読み込まれます。権限の設定（allow など）はここでは変えていません。

## 使っていないもの
- **MCP**: 必要な外部の情報は公開資料の調査（Web 検索・取得）で足り、常に繋いでおくデータベースや社内ツールがありません。入れても目的に合わないので使っていません。
- **Managed Agents**: 担当の並列作業はローカルの Claude Code のサブエージェントで足ります。製品の中の Claude は Messages API（Batch API・プロンプトキャッシュ）を `teppuri/judge/` から直接呼ぶ形で、サーバー側のエージェント環境は要りません。

## 関連
- 開発ルールと担当どうしの契約: `../CLAUDE.md`
- 試行錯誤の記録: `../docs/iterations.md`
- 出典: `../data/DATA_SOURCES.md`
