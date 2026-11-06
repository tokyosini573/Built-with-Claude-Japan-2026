// 「ライブで試す」の計算役（Web Worker）。ページを固めないよう、Pyodide の読み込みとエンジンの計算はここで行う。
//
// 1. cdn.jsdelivr.net の Pyodide（版は固定）と numpy・pandas・PyYAML を読み込む
// 2. public/live/（npm run build-live が作る）のファイルを、リポジトリと同じ並びで Pyodide のファイルに書く
// 3. teppuri.engine.live.LiveSession（= python -m teppuri.engine.run と同じ処理）で回す
//
// module worker（type: "module"）。Pyodide は CDN から動的 import で読む（バンドルには入れない）。
// 手順は scripts/live-pyodide-node.mjs と同じ（そちらでネイティブとの一致を確かめている）。

/// <reference lib="webworker" />

import type { LiveFromWorker, LiveToWorker } from "./protocol";

const PYODIDE_VERSION = "314.0.7";
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const ROOT = "/repo";

interface PyodideLike {
  loadPackage(names: string[], opts?: { messageCallback?: (m: string) => void }): Promise<void>;
  runPython(code: string): unknown;
  globals: { set(name: string, v: unknown): void };
  FS: { mkdirTree(p: string): void; writeFile(p: string, data: Uint8Array): void };
}

declare const self: DedicatedWorkerGlobalScope;

const post = (m: LiveFromWorker) => self.postMessage(m);
let ready: Promise<PyodideLike> | null = null;

async function init(base: string): Promise<PyodideLike> {
  const t0 = performance.now();
  post({ type: "progress", stage: "load", text: `Pyodide ${PYODIDE_VERSION}（ブラウザで動く Python）を読み込んでいます`, ratio: 0.05 });
  // module worker で CDN の pyodide.mjs を読む（classic worker の importScripts は環境によって使えないため）
  const mod = (await import(/* @vite-ignore */ `${INDEX_URL}pyodide.mjs`)) as { loadPyodide?: (opts: { indexURL: string }) => Promise<PyodideLike> };
  if (!mod.loadPyodide) throw new Error("Pyodide を読み込めませんでした");
  const py = await mod.loadPyodide({ indexURL: INDEX_URL });
  post({ type: "progress", stage: "load", text: "numpy・pandas・PyYAML を読み込んでいます", ratio: 0.35 });
  await py.loadPackage(["numpy", "pandas", "pyyaml"], {
    messageCallback: (m) => {
      if (/^Loaded /.test(m)) post({ type: "progress", stage: "load", text: m.replace(/^Loaded /, "読み込み済み: "), ratio: 0.7 });
    },
  });

  post({ type: "progress", stage: "load", text: "エンジン・ルール・1万人・判断のファイルを読み込んでいます", ratio: 0.75 });
  const manifest = await (await fetch(`${base}manifest.json`, { cache: "no-cache" })).json();
  const files: string[] = manifest.files;
  let done = 0;
  await Promise.all(
    files.map(async (rel) => {
      const res = await fetch(`${base}${rel}?v=${manifest.version}`);
      if (!res.ok) throw new Error(`${rel} を取得できませんでした（HTTP ${res.status}）`);
      const data = new Uint8Array(await res.arrayBuffer());
      const dst = `${ROOT}/${rel}`;
      py.FS.mkdirTree(dst.slice(0, dst.lastIndexOf("/")));
      py.FS.writeFile(dst, data);
      done += 1;
      post({ type: "progress", stage: "load", text: `エンジンのファイル ${done}/${files.length}`, ratio: 0.75 + 0.2 * (done / files.length) });
    }),
  );
  post({ type: "progress", stage: "load", text: "1万人と判断をエンジンに読み込んでいます", ratio: 0.96 });
  py.runPython(`
import sys
sys.path.insert(0, "${ROOT}")
from teppuri.engine.live import LiveSession
session = LiveSession("${ROOT}", "${manifest.app_id}")
`);
  post({ type: "ready", loadSeconds: (performance.now() - t0) / 1000, pyodide: PYODIDE_VERSION });
  return py;
}

const STAGE_JA: Record<string, string> = {
  simulate: "案の毎日の計算",
  sample: "案の地図用の1回を抽選",
  assemble: "結果をまとめています",
};

self.onmessage = async (e: MessageEvent<LiveToWorker>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      ready ??= init(msg.base);
      await ready;
      return;
    }
    if (msg.type === "run") {
      if (!ready) throw new Error("先に init を送ってください");
      const py = await ready;
      const t0 = performance.now();
      let step = 0;
      const steps = 5; // A の計算・抽選、B の計算・抽選、まとめ
      py.globals.set("js_progress", (stage: string, plan: string) => {
        step += 1;
        const label = STAGE_JA[stage] ?? stage;
        post({ type: "progress", stage: "run", text: plan ? `${plan}${label}` : label, ratio: Math.min(0.98, (step - 1) / steps) });
      });
      py.globals.set("overrides_json", JSON.stringify(msg.overrides));
      const text = py.runPython("session.run_json(overrides_json, js_progress)") as string;
      post({ type: "result", id: msg.id, json: text, seconds: (performance.now() - t0) / 1000 });
    }
  } catch (err) {
    if (msg.type === "init") ready = null;
    post({ type: "error", id: msg.type === "run" ? msg.id : undefined, message: (err as Error).message ?? String(err) });
  }
};
