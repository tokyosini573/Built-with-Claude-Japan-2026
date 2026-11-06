"""合成コマンド: python -m teppuri.engine.build_replay <app_id>

runs/<app_id>/engine.json（エンジン）に、あれば判断担当の
  runs/<app_id>/interviews.json → interviews
  runs/<app_id>/report.json     → report_ja、drop_themes（report.json の themes）
  runs/<app_id>/decisions.json  → person_decisions（people にいる人の人単位の判断）
を入れて web/public/replays/<app_id>.json に書く（契約 v1）。無いものは空のまま。
判断担当はリプレイに直接書かないので、エンジンを回し直してもインタビューとレポートは消えない。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .replay import person_decision_rows
from .rules import REPO_ROOT
from .run import run_dir, write_json


def _read(path: Path):
    if Path(path).suffix == ".gz":
        import gzip
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def build(app_id: str, runs_root: Path | None = None, out: Path | None = None) -> Path:
    rd = (Path(runs_root) / app_id) if runs_root else run_dir(app_id)
    engine_path = rd / "engine.json"
    if not engine_path.exists():
        raise FileNotFoundError(f"{engine_path} がありません。先に python -m teppuri.engine.run を実行してください")
    replay = _read(engine_path)

    replay["interviews"] = []
    replay["report_ja"] = ""
    replay["drop_themes"] = []
    interviews = rd / "interviews.json"
    if interviews.exists():
        data = _read(interviews)
        replay["interviews"] = data if isinstance(data, list) else data.get("interviews", [])
    report = rd / "report.json"
    if report.exists():
        data = _read(report)
        replay["report_ja"] = data.get("report_ja", "")
        replay["drop_themes"] = data.get("themes", data.get("drop_themes", []))

    decisions = rd / "decisions.json"
    if not decisions.exists():  # コミット用の decisions.json.gz も読む
        decisions = rd / "decisions.json.gz"
    if decisions.exists():   # 判断を回し直したときも最新を入れる（数字はエンジンを回し直すまで変わらない）
        data = _read(decisions)
        data = data if isinstance(data, list) else data.get("decisions", [])
        replay["person_decisions"] = person_decision_rows(data, [p[0] for p in replay.get("people", [])])
    replay.setdefault("person_decisions", [])

    out = Path(out) if out else REPO_ROOT / "web" / "public" / "replays" / f"{app_id}.json"
    write_json(replay, out)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="エンジンの出力と判断担当の出力をリプレイにまとめる")
    ap.add_argument("app_id")
    ap.add_argument("--runs-root", default=None, help="省略時は runs/")
    ap.add_argument("--out", default=None, help="省略時は web/public/replays/<app_id>.json")
    args = ap.parse_args(argv)
    out = build(args.app_id, args.runs_root, args.out)
    replay = _read(out)
    print(f"出力: {out}（インタビュー {len(replay['interviews'])}人、テーマ {len(replay['drop_themes'])}件、"
          f"レポート {'あり' if replay['report_ja'] else 'なし'}）", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
