// 「ライブで試す」の Worker を1つだけ持つ入れ物。ページを離れて戻っても、読み込んだ Pyodide と最後の結果は残る。

import { useSyncExternalStore } from "react";
import { validateReplay, type Replay } from "../lib/replay";
import type { LiveFromWorker, LiveOverrides, LiveToWorker } from "./protocol";

export type LivePhase = "idle" | "loading" | "ready" | "running" | "error";

export interface LiveResult {
  replay: Replay;
  overrides: LiveOverrides;
  seconds: number;
  id: number;
}

export interface LiveState {
  phase: LivePhase;
  progress: { text: string; ratio: number } | null;
  loadSeconds: number | null;
  pyodide: string | null;
  error: string | null;
  result: LiveResult | null;
}

let state: LiveState = { phase: "idle", progress: null, loadSeconds: null, pyodide: null, error: null, result: null };
const listeners = new Set<() => void>();
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, LiveOverrides>();
let queued: LiveOverrides | null = null;

function set(patch: Partial<LiveState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function send(m: LiveToWorker) {
  worker!.postMessage(m);
}

function onMessage(e: MessageEvent<LiveFromWorker>) {
  const m = e.data;
  if (m.type === "progress") {
    set({ progress: { text: m.text, ratio: m.ratio } });
  } else if (m.type === "ready") {
    set({ phase: "ready", loadSeconds: m.loadSeconds, pyodide: m.pyodide, progress: null });
    if (queued) {
      const o = queued;
      queued = null;
      runLive(o);
    }
  } else if (m.type === "result") {
    const overrides = pending.get(m.id)!;
    pending.delete(m.id);
    try {
      const replay = validateReplay(JSON.parse(m.json));
      set({ phase: "ready", progress: null, error: null, result: { replay, overrides, seconds: m.seconds, id: m.id } });
    } catch (err) {
      set({ phase: "ready", progress: null, error: `結果の形が読めませんでした: ${(err as Error).message}` });
    }
  } else if (m.type === "error") {
    if (m.id !== undefined) pending.delete(m.id);
    const loading = state.phase === "loading";
    set({ phase: loading ? "error" : "ready", progress: null, error: m.message });
    if (loading) {
      // 読み込みに失敗したら作り直せるようにする
      worker?.terminate();
      worker = null;
      queued = null;
    }
  }
}

/** live/ の場所（ページと同じ階層。GitHub Pages のサブパスでも動くように document.baseURI から） */
export function liveBase(): string {
  return new URL("live/", document.baseURI).href;
}

export function startLive() {
  if (worker) return;
  worker = new Worker(new URL("./live.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = onMessage;
  worker.onerror = (e) => {
    set({ phase: "error", progress: null, error: e.message || "Worker を起動できませんでした" });
    worker?.terminate();
    worker = null;
  };
  set({ phase: "loading", error: null, progress: { text: "準備しています", ratio: 0 } });
  send({ type: "init", base: liveBase() });
}

export function runLive(overrides: LiveOverrides) {
  if (!worker || state.phase === "loading" || state.phase === "error") {
    queued = overrides;
    if (!worker) startLive();
    return;
  }
  const id = nextId++;
  pending.set(id, overrides);
  set({ phase: "running", error: null, progress: { text: "計算を始めます", ratio: 0 } });
  send({ type: "run", id, overrides });
}

export function useLive(): LiveState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
