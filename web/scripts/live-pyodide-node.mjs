// 「ライブで試す」と同じ計算を、Node の Pyodide（ブラウザと同じ版）で行う。ネイティブとの一致を確かめる用。
//
//   node scripts/live-pyodide-node.mjs <条件の配列.json> <出力.json>
//
// public/live/（npm run build-live が作る）をそのまま Pyodide のファイルに書き、teppuri.engine.live を回す。
// 出力は条件ごとのリプレイの配列と、読み込み・実行の秒数。ブラウザの live.worker.ts と同じ手順。

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPyodide, version } from "pyodide";

const here = dirname(fileURLToPath(import.meta.url));
const LIVE = join(here, "..", "public", "live");
const ROOT = "/repo";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("使い方: node scripts/live-pyodide-node.mjs <条件の配列.json> <出力.json>");
  process.exit(2);
}

const t0 = performance.now();
const py = await loadPyodide();
await py.loadPackage(["numpy", "pandas", "pyyaml"], { messageCallback: () => {} });
const manifest = JSON.parse(await readFile(join(LIVE, "manifest.json"), "utf-8"));
for (const rel of manifest.files) {
  const dst = `${ROOT}/${rel}`;
  py.FS.mkdirTree(dst.slice(0, dst.lastIndexOf("/")));
  py.FS.writeFile(dst, await readFile(join(LIVE, rel)));
}
py.runPython(`
import sys
sys.path.insert(0, "${ROOT}")
from teppuri.engine.live import LiveSession
session = LiveSession("${ROOT}", "${manifest.app_id}")
`);
const loadSec = (performance.now() - t0) / 1000;

const list = JSON.parse(await readFile(inPath, "utf-8"));
const results = [];
for (const overrides of list) {
  const t1 = performance.now();
  py.globals.set("overrides_json", JSON.stringify(overrides));
  const text = py.runPython("session.run_json(overrides_json)");
  results.push({ seconds: (performance.now() - t1) / 1000, replay: JSON.parse(text) });
}
await writeFile(outPath, JSON.stringify({ pyodide: version, load_seconds: loadSec, results }));
console.error(`Pyodide ${version}: 読み込み ${loadSec.toFixed(1)}秒、実行 ${results.map((r) => r.seconds.toFixed(1) + "秒").join(" / ")}`);
