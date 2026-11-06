#!/bin/bash
# PreToolUse（Edit|Write|Bash）: backtest/answers.yaml への書き込みを、
# backtest/predictions.json がコミットされるまで止める（設計 5-3・5-4。コミット順が証拠）。
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INPUT="$(cat)"
TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')"
TARGET=0
case "$TOOL" in
  Edit|Write)
    FILE="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')"
    case "$FILE" in
      */backtest/answers.yaml|backtest/answers.yaml) TARGET=1 ;;
    esac
    ;;
  Bash)
    CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')"
    if printf '%s' "$CMD" | grep -q 'answers\.yaml'; then
      # 書き込みに使われる書き方だけを対象にする（cat や grep で読むだけなら通す）
      if printf '%s' "$CMD" | grep -Eq '>|(^|[^[:alnum:]_])(tee|cp|mv|ln|rsync|install|dd|touch|truncate|python3?|perl|ruby|node)([^[:alnum:]_]|$)|sed[[:space:]]+(-[[:alnum:]]*[[:space:]]+)*-i|git[[:space:]]+(add|checkout|restore|mv|stash)'; then
        TARGET=1
      fi
    fi
    ;;
esac
[ $TARGET -eq 1 ] || exit 0
if [ -n "$(git -C "$ROOT" log --oneline -- backtest/predictions.json 2>/dev/null)" ]; then
  exit 0
fi
{
  echo "backtest/answers.yaml にはまだ書けません: backtest/predictions.json がコミットされていません。"
  echo "順番: ①ルール固定 ②入力 ③予測のコミット ④正解 ⑤レポート（/backtest-freeze）。"
  echo "正解はそれまでリポジトリ外の封印フォルダ（非公開）に封印したままにします。"
} >&2
exit 2
