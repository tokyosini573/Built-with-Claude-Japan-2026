"""「ライブで試す」（#/live）で Pyodide に渡すファイル一式を web/public/live/ に作る。

  ../.venv/bin/python scripts/build_live_bundle.py      （npm run build-live）

中身はリポジトリと同じ並び（Pyodide の中でも teppuri.engine がそのまま動くように）:
  teppuri/engine/*.py、rules/*.yaml、data/population/japan_10k.csv・representatives.csv、
  apps/<app_id>/app.yaml、
  runs/<app_id>/decisions_levels.json（判断の level だけ。理由の文は無し。teppuri.engine.live.compact_decisions）、
  runs/<app_id>/personas_interest.json（ペルソナの interest だけ）、
  manifest.json（ファイルの一覧と大きさ、画面の初期値）。
同じ入力からは同じファイルが出る（日時を入れない）。
"""

from __future__ import annotations

import gzip
import hashlib
import json
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from teppuri.engine.inputs import load_app, load_decisions  # noqa: E402
from teppuri.engine.live import compact_decisions, compact_personas, editable_defaults, expand_decisions  # noqa: E402
from teppuri.engine.run import load_personas  # noqa: E402

APP_ID = "demo_matching"
OUT = REPO / "web" / "public" / "live"


def main() -> int:
    if OUT.exists():
        shutil.rmtree(OUT)
    files: list[str] = []

    def copy(rel: str) -> None:
        dst = OUT / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPO / rel, dst)
        files.append(rel)

    def write(rel: str, obj) -> None:
        dst = OUT / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        files.append(rel)

    for p in sorted((REPO / "teppuri" / "engine").glob("*.py")):
        copy(str(p.relative_to(REPO)))
    copy("teppuri/__init__.py")
    for p in sorted((REPO / "rules").glob("*.yaml")):
        copy(str(p.relative_to(REPO)))
    copy("data/population/japan_10k.csv")
    copy("data/population/representatives.csv")
    app_rel = f"apps/{APP_ID}/app.yaml"
    copy(app_rel)

    rd = REPO / "runs" / APP_ID
    decisions = load_decisions(rd / "decisions.json")
    compact = compact_decisions(decisions, APP_ID)
    # 戻したものが元と同じ（理由の文と model を除く）ことを確かめる。人どうしの並びはエンジンに関係しないので
    # 人の番号で安定ソートして比べる（同じ人の中の並びはそのまま比べる）
    strip = lambda d: (int(d["person_id"]), d["plan"], d["step"], d.get("creative"), d.get("cluster_id"), d["level"])  # noqa: E731
    by_person = lambda rows: sorted((strip(d) for d in rows), key=lambda r: r[0])  # noqa: E731
    if by_person(expand_decisions(compact)) != by_person(decisions):
        raise SystemExit("判断を小さくした形から元に戻せません")
    write(f"runs/{APP_ID}/decisions_levels.json", compact)
    write(f"runs/{APP_ID}/personas_interest.json", compact_personas(load_personas(rd / "personas.json")))

    app = load_app(REPO / app_rel)
    sizes = {}
    total = gz_total = 0
    for rel in files:
        b = (OUT / rel).read_bytes()
        sizes[rel] = len(b)
        total += len(b)
        gz_total += len(gzip.compress(b, mtime=0))
    digest = hashlib.sha256(b"".join((OUT / f).read_bytes() for f in files)).hexdigest()[:16]
    manifest = {
        "app_id": APP_ID,
        "name_ja": app.get("name_ja", ""),
        "version": digest,
        "files": files,
        "sizes": sizes,
        "total_bytes": total,
        "total_gzip_bytes": gz_total,
        "defaults": editable_defaults(app),
        "decisions": {"rows": len(decisions), "people": len(compact["person_ids"])},
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    src = sum((rd / n).stat().st_size for n in ["decisions.json"] if (rd / n).exists())
    print(f"出力: {OUT}（{len(files)}ファイル、{total / 1e6:.2f}MB、gzip で {gz_total / 1e6:.2f}MB）", file=sys.stderr)
    print(f"  判断: {len(decisions)}件 → {sizes[f'runs/{APP_ID}/decisions_levels.json'] / 1e3:.0f}KB"
          f"（元の decisions.json {src / 1e6:.1f}MB）", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
