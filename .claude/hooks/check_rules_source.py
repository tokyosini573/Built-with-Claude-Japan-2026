"""rules/*.yaml に「値（low / mid / high / value）があるのに source がない項目」を入れさせない。

PreToolUse（Edit / Write）から呼ばれる。標準入力 = フックの入力 JSON。
- 書き込み後の内容を組み立てて YAML として読み、数値の low / mid / high / value を持つ
  辞書に `source` があるかを見る。
- 誤検出を避けるため、**今回の書き込みで新しく増えた違反だけ**を止める（既存の違反や、
  関係のない行の編集では止めない）。YAML として読めないとき・PyYAML がないときは止めない。
終了コード: 0 = 通す / 2 = 止める（理由は標準エラーに出し、Claude に伝わる）。
"""

from __future__ import annotations

import json
import os
import sys

VALUE_KEYS = ("low", "mid", "high", "value")


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    root = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    tool_input = data.get("tool_input") or {}
    path = tool_input.get("file_path") or ""
    if not path:
        return 0
    if not os.path.isabs(path):
        path = os.path.join(data.get("cwd") or root, path)
    path = os.path.realpath(path)
    rules_dir = os.path.realpath(os.path.join(root, "rules"))
    if os.path.dirname(path) != rules_dir or not path.endswith((".yaml", ".yml")):
        return 0

    try:
        import yaml  # noqa: PLC0415
    except ImportError:
        return 0

    before = ""
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            before = f.read()

    tool = data.get("tool_name")
    if tool == "Write":
        after = tool_input.get("content") or ""
    elif tool == "Edit":
        old = tool_input.get("old_string") or ""
        new = tool_input.get("new_string") or ""
        if not old or old not in before:
            return 0  # Edit 自体が失敗するので任せる
        after = before.replace(old, new) if tool_input.get("replace_all") else before.replace(old, new, 1)
    else:
        return 0

    try:
        doc_after = yaml.safe_load(after)
    except Exception:
        return 0
    try:
        doc_before = yaml.safe_load(before) if before else None
    except Exception:
        doc_before = None

    new_violations = sorted(set(violations(doc_after)) - set(violations(doc_before)))
    if not new_violations:
        return 0
    rel = os.path.relpath(path, root)
    print(
        f"{rel}: 値があるのに source がない項目があります（出典のない値は入れない、CLAUDE.md）:",
        file=sys.stderr,
    )
    for v in new_violations[:20]:
        print(f"  - {v}", file=sys.stderr)
    print(
        '各項目に source: "[略称] 表・ページ"（data/DATA_SOURCES.md 3-0）を付けてください。'
        "出典がない値は source: assumption と、理由を note に書きます（/add-benchmark の手順）。",
        file=sys.stderr,
    )
    return 2


def violations(node, trail: str = "", parent_has_source: bool = False) -> list[str]:
    """source のない「値の辞書」の位置を返す。

    すぐ上の辞書に source があれば、その中の値はその出典を持つとみなす
    （例: multipliers.yaml の traits.<名前>.factor: {low, mid, high} と同じ階層の source）。
    """
    out: list[str] = []
    if isinstance(node, dict):
        has_source = _has_source(node)
        has_value = any(_is_number(node.get(k)) for k in VALUE_KEYS)
        if has_value and not has_source and not parent_has_source:
            out.append(trail or "(最上位)")
        for k, v in node.items():
            out.extend(violations(v, f"{trail}.{k}" if trail else str(k), has_source))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            out.extend(violations(v, f"{trail}[{i}]", parent_has_source))
    return out


def _has_source(node: dict) -> bool:
    src = node.get("source")
    return src is not None and not (isinstance(src, str) and not src.strip())


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


if __name__ == "__main__":
    sys.exit(main())
