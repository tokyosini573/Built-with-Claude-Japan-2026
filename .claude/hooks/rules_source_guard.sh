#!/bin/bash
# PreToolUse（Edit|Write）: rules/*.yaml に出典（source）のない値を書かせない。
# 判定本体は check_rules_source.py（PyYAML が要るので .venv の Python を使う）。
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PY="$ROOT/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"
[ -n "$PY" ] || exit 0
exec "$PY" "$ROOT/.claude/hooks/check_rules_source.py" "$ROOT"
