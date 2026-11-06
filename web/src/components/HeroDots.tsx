// トップの図: 1万個の点（100 × 100）が少しずつ色づく。点1つが1人。
// 色づき方はイメージで、実際の結果ではない（固定シードの疑似乱数で毎回同じ絵）。
// 動きを減らす設定のときは、最後の状態をそのまま描く。

import { useEffect, useRef } from "react";

const SIDE = 100; // 100 × 100 = 10,000人

/** 0 まだ知らない / 1 広告が届いた / 2 インストール / 3 使い続けている / 4 課金した */
export const HERO_LEGEND = [
  { level: 1, label: "広告が届いた" },
  { level: 2, label: "インストール" },
  { level: 3, label: "使い続けている" },
  { level: 4, label: "課金した" },
] as const;

function makeGoal(): Uint8Array {
  let s = 20261108;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const goal = new Uint8Array(SIDE * SIDE);
  for (let i = 0; i < goal.length; i++) {
    const r = rnd();
    goal[i] = r < 0.012 ? 4 : r < 0.05 ? 3 : r < 0.11 ? 2 : r < 0.42 ? 1 : 0;
  }
  return goal;
}

function palette(): string[] {
  const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  return [css("--line"), css("--a-reach"), css("--a-dot"), css("--a"), css("--gold")];
}

export function HeroDots() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const goal = makeGoal();
    const state = new Uint8Array(goal.length);
    let pal = palette();
    let raf = 0;
    let timer = 0;

    const draw = () => {
      const size = canvas.clientWidth;
      if (!size) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const px = Math.round(size * dpr);
      if (canvas.width !== px) {
        canvas.width = px;
        canvas.height = px;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      const cell = size / SIDE;
      // 先へ進んだ人ほど少し大きく
      const radius = [0.26, 0.36, 0.44, 0.48, 0.5].map((f) => cell * f);
      // 色ごとにまとめて塗る（1フレーム5回の fill）
      for (let v = 0; v < 5; v++) {
        ctx.fillStyle = pal[v];
        ctx.beginPath();
        const r = radius[v];
        for (let i = 0; i < state.length; i++) {
          if (state[i] !== v) continue;
          const x = (i % SIDE) * cell + cell / 2;
          const y = Math.floor(i / SIDE) * cell + cell / 2;
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    };

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      state.set(goal);
      draw();
    } else {
      // 未接触の状態から、段階ごとに少しずつ色づける（約4秒）
      let s = 7;
      const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
      let t = 0;
      draw();
      const tick = () => {
        t++;
        const level = Math.min(4, 1 + Math.floor(t / 40));
        for (let i = 0; i < state.length; i++) {
          if (state[i] < goal[i] && state[i] < level && rnd() < 0.06) state[i]++;
        }
        draw();
        if (t < 260) raf = requestAnimationFrame(tick);
        else {
          state.set(goal);
          draw();
        }
      };
      timer = window.setTimeout(() => (raf = requestAnimationFrame(tick)), 500);
    }

    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => {
      pal = palette();
      draw();
    };
    mq.addEventListener("change", onTheme);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      ro.disconnect();
      mq.removeEventListener("change", onTheme);
    };
  }, []);

  return <canvas ref={ref} className="hero-dots" role="img" aria-label="1万個の点。広告が届いた人、インストールした人、使い続けている人、課金した人の順に色がつくイメージ図" />;
}
