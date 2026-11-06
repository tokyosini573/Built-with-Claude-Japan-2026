// トップの図: 点でできた日本地図。点1つが架空の1万人の1人（public/hero/people.json の都道府県）。
// 置き方は結果画面の地図と同じ（lib/geo.ts の placePeople: 県の形の内側に person_id をシードにしたゆらぎ）。
// 人の多い県ほど点が密になり、点の集まりそのものが日本の形と人口の分布になる。沖縄県ははめ込み。
// 色づき方はイメージで、実際の結果ではない（person_id から決まる固定の割り当てで、毎回同じ絵）。
// 動きを減らす設定のときは、最後の状態をそのまま描く。
// people.json は scripts/build-hero-people.mjs がリプレイから作る（リプレイ本体の約11MBをトップで読まないため）。

import { useEffect, useRef, useState } from "react";
import { hashSeed, loadJapanMap, makeProjection, placePeople, rng } from "../lib/geo";

/** 0 まだ知らない / 1 広告が届いた / 2 インストール / 3 使い続けている / 4 課金した */
export const HERO_LEGEND = [
  { level: 1, label: "広告が届いた" },
  { level: 2, label: "インストール" },
  { level: 3, label: "使い続けている" },
  { level: 4, label: "課金した" },
] as const;

export interface HeroPeople {
  app_id: string;
  population: number;
  scale_to_japan: number;
  /** person_id の順の pref_code */
  pref: number[];
}

let peopleCache: Promise<HeroPeople> | null = null;

export function loadHeroPeople(): Promise<HeroPeople> {
  if (!peopleCache) {
    peopleCache = fetch(`${import.meta.env.BASE_URL}hero/people.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`図のデータを取得できませんでした（HTTP ${r.status}）`);
        return r.json() as Promise<HeroPeople>;
      })
      .catch((e) => {
        peopleCache = null;
        throw e;
      });
  }
  return peopleCache;
}

/** 地図の縦横比（幅 / 高さ）の目安。読み込む前の場所取りに使う（読み込み後は投影の値） */
const FALLBACK_ASPECT = 0.94;

/** イメージの色づき方（person_id から決まる。全国一様で、地域の差はない） */
function goalOf(id: number): number {
  const r = hashSeed(id, 20261108) / 4294967296;
  return r < 0.012 ? 4 : r < 0.05 ? 3 : r < 0.11 ? 2 : r < 0.42 ? 1 : 0;
}

function palette(el: Element): string[] {
  const css = (n: string) => getComputedStyle(el).getPropertyValue(n).trim();
  return [css("--dot-untouched"), css("--a-reach"), css("--a-dot"), css("--a"), css("--gold")];
}

/** 1色の丸を小さなキャンバスに描いておく（1万個を毎フレーム描くため） */
function sprite(color: string, r: number, dpr: number, alpha: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const side = Math.ceil((2 * r + 2) * dpr);
  c.width = c.height = side;
  const g = c.getContext("2d")!;
  g.globalAlpha = alpha;
  g.fillStyle = color;
  g.beginPath();
  g.arc(side / 2, side / 2, r * dpr, 0, Math.PI * 2);
  g.fill();
  return c;
}

interface Layout {
  /** 正規化座標 [x0, y0, x1, y1, ...]（person_id の順） */
  pos: Float32Array;
  goal: Uint8Array;
  aspect: number;
  insetBox: [number, number, number, number] | null;
}

export function HeroDots({ onPeople }: { onPeople?: (p: HeroPeople) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([loadJapanMap(), loadHeroPeople()])
      .then(([map, people]) => {
        if (!alive) return;
        const proj = makeProjection(map, true);
        const list = people.pref.map((pref, id) => ({ id, pref }));
        const pos = placePeople(list, map, proj);
        const goal = new Uint8Array(list.length);
        for (let i = 0; i < list.length; i++) goal[i] = goalOf(i);
        setLayout({ pos, goal, aspect: proj.aspect, insetBox: proj.insetBox });
        onPeople?.(people);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // onPeople は最初の1回だけ使う
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !layout) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { pos, goal, insetBox } = layout;
    const n = goal.length;
    const state = new Uint8Array(n);
    let pal = palette(canvas);
    let sprites: HTMLCanvasElement[] = [];
    let spriteKey = "";
    let raf = 0;
    let timer = 0;

    const draw = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // 点の大きさは図の幅に合わせる（スマホでも形がつぶれないように）
      const unit = Math.max(0.75, Math.min(1.5, w / 320));
      const radius = [0.9, 1.05, 1.2, 1.4, 1.75].map((f) => f * unit);
      const key = `${pal.join()}|${unit}|${dpr}`;
      if (key !== spriteKey) {
        spriteKey = key;
        sprites = radius.map((r, v) => sprite(pal[v], r, dpr, v === 0 ? 0.75 : 1));
      }
      const dot = (i: number) => {
        const x = pos[i * 2] * w, y = pos[i * 2 + 1] * h;
        if (Number.isNaN(x)) return;
        const r = radius[state[i]];
        ctx.drawImage(sprites[state[i]], x - r - 1, y - r - 1, 2 * r + 2, 2 * r + 2);
      };
      // 「まだ知らない」と「広告が届いた」は人の順に混ぜて描く（人の多い県で片方の色だけが上に見えないように）。
      // その先の段階は少ないので、上に重ねて見えるようにする
      for (let i = 0; i < n; i++) if (state[i] <= 1) dot(i);
      for (let v = 2; v < 5; v++) for (let i = 0; i < n; i++) if (state[i] === v) dot(i);
      ctx.globalAlpha = 1;
      // 沖縄県のはめ込み枠
      if (insetBox) {
        const [x0, y0, x1, y1] = insetBox;
        ctx.strokeStyle = pal[0];
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h);
        ctx.setLineDash([]);
      }
    };

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      state.set(goal);
      draw();
    } else {
      // 未接触の状態から、段階ごとに少しずつ色づける（約4秒）
      const rnd = rng(7);
      let t = 0;
      draw();
      const tick = () => {
        t++;
        const level = Math.min(4, 1 + Math.floor(t / 40));
        for (let i = 0; i < n; i++) {
          if (state[i] < goal[i] && state[i] < level && rnd() < 0.06) state[i]++;
        }
        draw();
        if (t < 260) raf = requestAnimationFrame(tick);
        else {
          state.set(goal);
          draw();
        }
      };
      timer = window.setTimeout(() => (raf = requestAnimationFrame(tick)), 400);
    }

    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    const onTheme = () => {
      pal = palette(canvas);
      draw();
    };
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", onTheme);
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      ro.disconnect();
      mq.removeEventListener("change", onTheme);
      mo.disconnect();
    };
  }, [layout]);

  if (error) {
    return (
      <p className="small muted hero-dots" style={{ aspectRatio: FALLBACK_ASPECT }}>
        {error}
      </p>
    );
  }
  return (
    <canvas
      ref={ref}
      className="hero-dots"
      style={{ aspectRatio: layout?.aspect ?? FALLBACK_ASPECT }}
      role="img"
      aria-label="点でできた日本地図。点1つが架空の1万人の1人で、人の多い都道府県ほど点が密になる。広告が届いた人、インストールした人、使い続けている人、課金した人の順に色がつくイメージ図"
    />
  );
}
