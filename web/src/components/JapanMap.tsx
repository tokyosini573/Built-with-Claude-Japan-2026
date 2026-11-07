// 日本地図と1万人の点。Canvas に描く。
// 地図（県の形）は大きさが変わったときだけ描き直し、点は状態が変わるたびに描く。
// variant="dots" のときは県の境界も塗りも描かず、トップの図（HeroDots）と同じく丸い点だけで形を出す。
// そのときの地域の強調は、出稿地域の中の点を濃く、外の点を薄くして見せる（全国のときは強調しない）。

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
  /** 状態ごとの色・濃さ・大きさ（指定しなければ STATE_COLORS） */
  stateStyle?: (s: PersonState) => { color: string; alpha?: number; size?: number } | null;
  /** 点を押したとき（people の行番号）。近くに点がなければ呼ばれない */
  onPick?: (row: number) => void;
  /** 強調して描く人（people の行番号） */
  selectedRow?: number | null;
  /** 選んだ人の印の色 */
  selectedColor?: string;
  /** "dots" = 県の形を描かず、丸い点だけ（トップの図と同じ見た目）。size は幅に合わせて少し大きくなる */
  variant?: "fill" | "dots";
}

/** 1色の丸を小さなキャンバスに描いておく（1万個を毎フレーム描くため。HeroDots と同じやり方） */
const spriteCache = new Map<string, HTMLCanvasElement>();
function dotSprite(color: string, d: number, dpr: number): HTMLCanvasElement {
  const key = `${color}|${d.toFixed(2)}|${dpr}`;
  let c = spriteCache.get(key);
  if (c) return c;
  if (spriteCache.size > 64) spriteCache.clear();
  c = document.createElement("canvas");
  const side = Math.ceil((d + 2) * dpr);
  c.width = c.height = side;
  const g = c.getContext("2d")!;
  g.fillStyle = color;
  g.beginPath();
  g.arc(side / 2, side / 2, (d / 2) * dpr, 0, Math.PI * 2);
  g.fill();
  spriteCache.set(key, c);
  return c;
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
  stateStyle,
  onPick,
  selectedRow = null,
  selectedColor = "#000",
  variant = "fill",
}: JapanMapProps) {
  const dots = variant === "dots";
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
    for (const pref of dots ? [] : map.prefs) {
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
      ctx.strokeStyle = dots ? cssVar(host, "--dot-untouched", muted) : muted;
      ctx.lineWidth = dots ? 1 : 0.8;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(x0 * cssWidth, y0 * cssHeight, (x1 - x0) * cssWidth, (y1 - y0) * cssHeight);
      ctx.setLineDash([]);
    }
  }, [map, proj, cssWidth, cssHeight, highlightKey, themeTick, dots]);

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
    const hl = new Set(highlightPrefs);
    // 点だけの地図: 点の大きさを図の幅に合わせる（HeroDots と同じ考え方。スマホでも形がつぶれないように）
    const unit = dots ? Math.max(0.75, Math.min(1.5, cssWidth / 320)) : 1;
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
      const custom = stateStyle ? stateStyle(s) : undefined;
      if (custom === null) continue;
      // 未接触だけはテーマに合わせる（暗い背景で明るすぎないように）
      ctx.fillStyle = custom
        ? custom.color
        : s === PersonState.None && wrapRef.current
          ? cssVar(wrapRef.current, "--dot-untouched", STATE_COLORS[s])
          : STATE_COLORS[s];
      const size = (custom?.size ?? (s === PersonState.None ? r * 0.8 : r)) * unit;
      const color = ctx.fillStyle as string;
      const sprite = dots ? dotSprite(color, size, dpr) : null;
      const half = sprite ? (size + 2) / 2 : 0;
      for (const i of list) {
        const x = positions[i * 2], y = positions[i * 2 + 1];
        if (Number.isNaN(x)) continue;
        // n（このグループで進んだ人数）が多い点ほど少し濃く。0.6〜1.0 の範囲に抑える
        const base = custom?.alpha ?? 1;
        // 出稿地域の外にいる未接触の点は薄くして、地域の違いを見えるようにする
        const outside = hl.size > 0 && !hl.has(people[i][1]);
        // 点だけの地図では、地域の中の未接触の点を少し濃くして、地域の形が点で浮かぶようにする
        const inside = dots && hl.size > 0 && !outside;
        ctx.globalAlpha =
          s === PersonState.None
            ? Math.min(1, (custom?.alpha ?? 0.55) * (outside ? (dots ? 0.4 : 0.45) : inside ? 1.5 : 1))
            : base * (weights ? 0.6 + 0.4 * Math.min(1, Math.log10(1 + weights[i]) / 3) : 1);
        if (sprite) ctx.drawImage(sprite, x * cssWidth - half, y * cssHeight - half, size + 2, size + 2);
        else ctx.fillRect(x * cssWidth - size / 2, y * cssHeight - size / 2, size, size);
      }
    }
    ctx.globalAlpha = 1;
    if (selectedRow !== null && selectedRow >= 0) {
      const x = positions[selectedRow * 2] * cssWidth, y = positions[selectedRow * 2 + 1] * cssHeight;
      if (!Number.isNaN(x)) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = cssVar(wrapRef.current!, "--surface", "#fff");
        ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 2;
        ctx.strokeStyle = selectedColor;
        ctx.beginPath(); ctx.arc(x, y, 7.5, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }, [positions, states, weights, cssWidth, cssHeight, dotSize, showUntouched, people, highlightKey, themeTick, stateStyle, selectedRow, selectedColor, dots]);

  // 押した位置に一番近い点（未接触は除かない。12px 以内）
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onPick || !positions) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    let best = -1, bestD = 144;
    const n = people.length;
    for (let i = 0; i < n; i++) {
      const x = positions[i * 2] * cssWidth, y = positions[i * 2 + 1] * cssHeight;
      if (Number.isNaN(x)) continue;
      // 進んだ点を優先（同じくらいの距離なら状態のある点）
      const bonus = states && states[i] !== PersonState.None ? 0.5 : 1;
      const d = ((x - px) ** 2 + (y - py) ** 2) * bonus;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) onPick(best);
  };

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
        onClick={onPick ? handleClick : undefined}
        style={{ display: map ? "block" : "none", width: cssWidth, height: cssHeight, margin: "0 auto", cursor: onPick ? "pointer" : undefined }}
      />
      {map && showCredit && (
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 0", textAlign: "right" }}>
          「国土数値情報（行政区域データ）」（国土交通省）をもとにテプリ作成
        </p>
      )}
    </div>
  );
}
