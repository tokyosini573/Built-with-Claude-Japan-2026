#!/bin/bash
# PostToolUse（Edit|Write）: teppuri/engine/ か rules/ のファイルが変わったら
# エンジンのテストを走らせる。失敗したら exit 2 で結果を Claude に返す（編集は取り消さない）。
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INPUT="$(cat)"
FILE="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')"
[ -n "$FILE" ] || exit 0
case "$FILE" in
  /*) ;;
  *) FILE="$(printf '%s' "$INPUT" | jq -r '.cwd // empty')/$FILE" ;;
esac
case "$FILE" in
  "$ROOT"/teppuri/engine/*|"$ROOT"/rules/*) ;;
  *) exit 0 ;;
esac
PY="$ROOT/.venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "テストを実行できません: $PY がありません（CLAUDE.md のコマンドで .venv を作る）" >&2
  exit 0
fi
OUT="$(cd "$ROOT" && "$PY" -m pytest tests/test_engine.py -q -x 2>&1)"
STATUS=$?
if [ $STATUS -ne 0 ]; then
  {
    echo "エンジンのテストが失敗しました（${FILE#"$ROOT"/} の変更後、pytest tests/test_engine.py -q）:"
    printf '%s\n' "$OUT" | tail -n 40
    echo "直してから次へ進んでください。rules/ の値を変えたなら docs/iterations.md に理由を書きます。"
  } >&2
  exit 2
fi
exit 0
