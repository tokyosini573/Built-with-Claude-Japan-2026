// 日本地図と1万人の点。Canvas に描く。
// 地図（県の形）は大きさが変わったときだけ描き直し、点は状態が変わるたびに描く。

import { useEffect, useMemo, useRef, useState } from "react";
import { loadJapanMap, makeProjection, placePeople, type JapanMapData, type Projection } from "../lib/geo";
import type { PersonRow } from "../lib/replay";
import { PersonState, STATE_COLORS, STATE_COUNT } from "../lib/states";

export interface JapanMapProps {
  people: PersonRow[];
  /** people と同じ順の状態。なければ全員「未接触」 */
  states?: Uint8Array;
  /** people と同じ順の重み（例: 期間中にインストールした人数 n の合計）。点の濃さを控えめに変える */
  weights?: Float32Array;
  /** 強調する都道府県（出稿地域など）。空なら全国 */
  highlightPrefs?: number[];
  /** 沖縄県を左上にはめ込む */
  insetOkinawa?: boolean;
  /** 点の直径（CSS ピクセル） */
  dotSize?: number;
  /** 未接触の点を描くか */
  showUntouched?: boolean;
  /** 表示幅の上限 */
  maxWidth?: number;
  ariaLabel?: string;
  /** 地図の出典表記を出す（ATTRIBUTION.md。別の場所にまとめて出すときだけ false） */
  showCredit?: boolean;
}

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

export function JapanMap({
  people,
  states,
  weights,
  highlightPrefs = [],
  insetOkinawa = true,
  dotSize = 2,
  showUntouched = true,
  maxWidth = 720,
  ariaLabel = "日本地図。点は架空の1万人",
  showCredit = true,
}: JapanMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const [map, setMap] = useState<JapanMapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  // テーマ切り替えで地図の色を描き直すための印
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    let alive = true;
    loadJapanMap()
      .then((m) => alive && setMap(m))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => setThemeTick((t) => t + 1);
    mq.addEventListener("change", onTheme);
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      ro.disconnect();
      mq.removeEventListener("change", onTheme);
      mo.disconnect();
    };
  }, []);

  const proj: Projection | null = useMemo(() => (map ? makeProjection(map, insetOkinawa) : null), [map, insetOkinawa]);

  // 点の位置は people と地図が変わったときだけ計算（1万人で数十ms）
  const positions = useMemo(() => {
    if (!map || !proj) return null;
    return placePeople(
      people.map((p) => ({ id: p[0], pref: p[1] })),
      map,
      proj,
    );
  }, [people, map, proj]);

  const highlightKey = highlightPrefs.join(",");
  const cssWidth = Math.min(width, maxWidth);
  const cssHeight = proj ? Math.round(cssWidth / proj.aspect) : 0;

  // 県の形を裏のキャンバスに描く
  useEffect(() => {
    const host = wrapRef.current;
    if (!map || !proj || cssWidth <= 0 || !host) return;
    const dpr = window.devicePixelRatio || 1;
    const base = baseRef.current ?? document.createElement("canvas");
    baseRef.current = base;
    base.width = Math.round(cssWidth * dpr);
    base.height = Math.round(cssHeight * dpr);
    const ctx = base.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    const land = cssVar(host, "--map-land", "#e6e5df");
    const dim = cssVar(host, "--map-dim", "#d2d1cb");
    const line = cssVar(host, "--map-line", "#ffffff");
    const muted = cssVar(host, "--text-muted", "#888");
    const highlight = new Set(highlightPrefs);
    for (const pref of map.prefs) {
      ctx.beginPath();
      for (const poly of pref.polygons) {
        for (const ring of poly) {
          for (let i = 0; i < ring.length; i += 2) {
            const [x, y] = proj.project(ring[i], ring[i + 1], pref.code);
            if (i === 0) ctx.moveTo(x * cssWidth, y * cssHeight);
            else ctx.lineTo(x * cssWidth, y * cssHeight);
          }
          ctx.closePath();
        }
      }
      ctx.fillStyle = highlight.size === 0 || highlight.has(pref.code) ? land : dim;
      ctx.fill("evenodd");
      ctx.strokeStyle = line;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
    if (proj.insetBox) {
      const [x0, y0, x1, y1] = proj.insetBox;
      ctx.strokeStyle = muted;
      ctx.lineWidth = 0.8;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(x0 * cssWidth, y0 * cssHeight, (x1 - x0) * cssWidth, (y1 - y0) * cssHeight);
      ctx.setLineDash([]);
    }
  }, [map, proj, cssWidth, cssHeight, highlightKey, themeTick]);

  // 地図 + 点を表のキャンバスに描く（再生中は毎フレーム）
  useEffect(() => {
    const canvas = canvasRef.current;
    const base = baseRef.current;
    if (!canvas || !base || !positions || cssWidth <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== base.width || canvas.height !== base.height) {
      canvas.width = base.width;
      canvas.height = base.height;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const n = people.length;
    const r = dotSize;
    // 状態ごとにまとめて描く（進んだ状態ほど上に重ねる）
    const order: PersonState[] = [
      PersonState.None,
      PersonState.Churned,
      PersonState.Install,
      PersonState.Signup,
      PersonState.CoreAction,
      PersonState.Trial,
      PersonState.Paid,
    ];
    const buckets: number[][] = Array.from({ length: STATE_COUNT }, () => []);
    for (let i = 0; i < n; i++) buckets[states ? states[i] : 0]?.push(i);
    for (const s of order) {
      if (s === PersonState.None && !showUntouched) continue;
      const list = buckets[s];
      if (list.length === 0) continue;
      // 未接触だけはテーマに合わせる（暗い背景で明るすぎないように）
      ctx.fillStyle = s === PersonState.None && wrapRef.current ? cssVar(wrapRef.current, "--dot-untouched", STATE_COLORS[s]) : STATE_COLORS[s];
      const size = s === PersonState.None ? r * 0.8 : r;
      for (const i of list) {
        const x = positions[i * 2], y = positions[i * 2 + 1];
        if (Number.isNaN(x)) continue;
        // n（このグループで進んだ人数）が多い点ほど少し濃く。0.6〜1.0 の範囲に抑える
        ctx.globalAlpha = s === PersonState.None ? 0.55 : weights ? 0.6 + 0.4 * Math.min(1, Math.log10(1 + weights[i]) / 3) : 1;
        ctx.fillRect(x * cssWidth - size / 2, y * cssHeight - size / 2, size, size);
      }
    }
    ctx.globalAlpha = 1;
  }, [positions, states, weights, cssWidth, cssHeight, dotSize, showUntouched, people.length, highlightKey, themeTick]);

  return (
    <div ref={wrapRef} style={{ width: "100%" }}>
      {error ? (
        <p className="small" style={{ color: "var(--error-text)" }}>
          {error}
        </p>
      ) : !map ? (
        <p className="small muted">地図を読み込み中…</p>
      ) : null}
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={ariaLabel}
        style={{ display: map ? "block" : "none", width: cssWidth, height: cssHeight, margin: "0 auto" }}
      />
      {map && showCredit && (
        <p className="muted" style={{ fontSize: 10, margin: "4px 0 0", textAlign: "right" }}>
          「国土数値情報（行政区域データ）」（国土交通省）をもとにテプリ作成
        </p>
      )}
    </div>
  );
}
