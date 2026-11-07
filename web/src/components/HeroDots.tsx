// トップの図: 点でできた日本地図。点1つが架空の1万人の1人（public/hero/people.json の都道府県）。
// 置き方は結果画面の地図と同じ（lib/geo.ts の placePeople: 県の形の内側に person_id をシードにしたゆらぎ）。
// 人の多い県ほど点が密になり、点の集まりそのものが日本の形と人口の分布になる。沖縄県ははめ込み。
// 色づき方はイメージで、実際の結果ではない（person_id から決まる固定の割り当てで、毎回同じ絵）。
// 1回の再生は5秒。終わると地方別の割合の吹き出しを出し、少し置いてから、まっさらに戻ってくり返す。
// タブが見えていないときは止める。動きを減らす設定のときは、最後の状態（吹き出しつき）をそのまま描く。
// 吹き出しの数字は実データ（デモ A案の sample_run の1回分）で、scripts/build-hero-people.mjs が
// public/hero/regions.json に計算しておく（画面では計算しない）。
// people.json も同じスクリプトがリプレイから作る（リプレイ本体の約11MBをトップで読まないため）。

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { hashSeed, loadJapanMap, makeProjection, OKINAWA_CODE, placePeople, rng } from "../lib/geo";

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

/** 地方別の割合（全国の合計のうち、その地方が占める%）。scripts/build-hero-people.mjs が作る */
export interface HeroRegion {
  id: string;
  name_ja: string;
  prefs: number[];
  install_pct: number;
  active_pct: number;
  pay_pct: number;
}

export interface HeroRegions {
  app_id: string;
  name_ja: string;
  plan: string;
  regions: HeroRegion[];
}

function cachedJson<T>(path: string, what: string): () => Promise<T> {
  let cache: Promise<T> | null = null;
  return () => {
    if (!cache) {
      cache = fetch(`${import.meta.env.BASE_URL}${path}`)
        .then((r) => {
          if (!r.ok) throw new Error(`${what}を取得できませんでした（HTTP ${r.status}）`);
          return r.json() as Promise<T>;
        })
        .catch((e) => {
          cache = null;
          throw e;
        });
    }
    return cache;
  };
}

export const loadHeroPeople = cachedJson<HeroPeople>("hero/people.json", "図のデータ");
export const loadHeroRegions = cachedJson<HeroRegions>("hero/regions.json", "地方別の割合");

/** 地図の縦横比（幅 / 高さ）の目安。読み込む前の場所取りに使う（読み込み後は投影の値） */
const FALLBACK_ASPECT = 0.94;

// 再生の時間（ミリ秒）
const PLAY_MS = 5000;
/** 終わりの絵と吹き出しを見せておく時間 */
const HOLD_MS = 3800;
/** まっさらな地図で置く時間 */
const BLANK_MS = 500;
const CYCLE_MS = PLAY_MS + HOLD_MS + BLANK_MS;
/** 段階ごとの色づき始め（ミリ秒）と、ばらつきの幅。どれも PLAY_MS までに終わる */
const STAGE_START = [150, 1050, 1950, 2850];
const STAGE_SPREAD = [1700, 1700, 1600, 1500];

/** イメージの色づき方（person_id から決まる。全国一様で、地域の差はない） */
function goalOf(id: number): number {
  const r = hashSeed(id, 20261108) / 4294967296;
  return r < 0.012 ? 4 : r < 0.05 ? 3 : r < 0.11 ? 2 : r < 0.42 ? 1 : 0;
}

function palette(el: Element): string[] {
  const css = (n: string) => getComputedStyle(el).getPropertyValue(n).trim();
  return [css("--dot-untouched"), css("--a-reach"), css("--a-dot"), css("--a"), css("--pay")];
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

/**
 * 吹き出しの置き場所（地図の正規化座標、吹き出しの中心）。線は地方の点の重心へ引く。
 * 海の空いたところに置き、互いに重ならないように手で決めた。沖縄のはめ込み（左上）とマスコット（右下）を避ける
 */
const BUBBLE_AT: Record<string, { x: number; y: number; small?: boolean }> = {
  hokkaido: { x: 0.46, y: 0.11, small: true },
  tohoku: { x: 0.88, y: 0.42, small: true },
  kanto: { x: 0.83, y: 0.64 },
  chubu: { x: 0.35, y: 0.4 },
  kinki: { x: 0.62, y: 0.84 },
  chugoku: { x: 0.17, y: 0.5, small: true },
  shikoku: { x: 0.38, y: 0.745, small: true },
  kyushu: { x: 0.19, y: 0.87 },
};

interface Layout {
  /** 正規化座標 [x0, y0, x1, y1, ...]（person_id の順） */
  pos: Float32Array;
  goal: Uint8Array;
  aspect: number;
  insetBox: [number, number, number, number] | null;
  /** 地方ごとの点の重心（正規化座標）。沖縄のはめ込みは含めない */
  centers: Record<string, [number, number]>;
}

function centersOf(pos: Float32Array, pref: number[], regions: HeroRegion[]): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const r of regions) {
    const set = new Set(r.prefs.filter((p) => p !== OKINAWA_CODE));
    let sx = 0, sy = 0, k = 0;
    for (let i = 0; i < pref.length; i++) {
      if (!set.has(pref[i]) || Number.isNaN(pos[i * 2])) continue;
      sx += pos[i * 2];
      sy += pos[i * 2 + 1];
      k++;
    }
    if (k) out[r.id] = [sx / k, sy / k];
  }
  return out;
}

/** 人ごと・段階ごとに、色が1段上がる時刻（ミリ秒）。届かない段階は Infinity */
function schedule(goal: Uint8Array): Float32Array {
  const rnd = rng(7);
  const t = new Float32Array(goal.length * 4).fill(Infinity);
  for (let i = 0; i < goal.length; i++) {
    let prev = 0;
    for (let k = 0; k < goal[i]; k++) {
      const at = Math.max(prev + 120, STAGE_START[k] + Math.pow(rnd(), 1.4) * STAGE_SPREAD[k]);
      prev = Math.min(PLAY_MS - 100, at);
      t[i * 4 + k] = prev;
    }
  }
  return t;
}

export function HeroDots({ onPeople, onReveal }: { onPeople?: (p: HeroPeople) => void; onReveal?: (shown: boolean) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [regions, setRegions] = useState<HeroRegion[] | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revealRef = useRef(onReveal);
  revealRef.current = onReveal;

  useEffect(() => {
    let alive = true;
    // 吹き出しのデータがなくても地図は出す
    const reg = loadHeroRegions().catch(() => null);
    Promise.all([loadJapanMap(), loadHeroPeople(), reg])
      .then(([map, people, rg]) => {
        if (!alive) return;
        const proj = makeProjection(map, true);
        const list = people.pref.map((pref, id) => ({ id, pref }));
        const pos = placePeople(list, map, proj);
        const goal = new Uint8Array(list.length);
        for (let i = 0; i < list.length; i++) goal[i] = goalOf(i);
        const centers = rg ? centersOf(pos, people.pref, rg.regions) : {};
        setLayout({ pos, goal, aspect: proj.aspect, insetBox: proj.insetBox, centers });
        setRegions(rg?.regions ?? null);
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
    const times = schedule(goal);
    let pal = palette(canvas);
    let sprites: HTMLCanvasElement[] = [];
    let spriteKey = "";
    let raf = 0;
    let shown = false;
    const reveal = (v: boolean) => {
      if (v === shown) return;
      shown = v;
      setRevealed(v);
      revealRef.current?.(v);
    };

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

    /** 再生の中の時刻 e（ミリ秒）の状態にする */
    const setAt = (e: number) => {
      for (let i = 0; i < n; i++) {
        const g = goal[i];
        if (!g) continue;
        let s = 0;
        while (s < g && times[i * 4 + s] <= e) s++;
        state[i] = s;
      }
    };

    const reduceMq = window.matchMedia("(prefers-reduced-motion: reduce)");
    // 1周の中の経過時間。タブが見えないときは止め、戻ったら続きから
    let start = 0;
    let pausedAt: number | null = 0;
    /** 0 色づき中 / 1 終わりの絵（吹き出し） / 2 まっさら */
    let phase = -1;

    const frame = (now: number) => {
      const e = (now - start) % CYCLE_MS;
      const p = e < PLAY_MS ? 0 : e < PLAY_MS + HOLD_MS ? 1 : 2;
      if (p === 0) {
        setAt(e);
        draw();
      } else if (p !== phase) {
        if (p === 1) state.set(goal);
        else state.fill(0);
        draw();
      }
      phase = p;
      reveal(p === 1);
      raf = requestAnimationFrame(frame);
    };

    const run = () => {
      if (pausedAt === null || document.hidden || reduceMq.matches) return;
      start = performance.now() - pausedAt;
      pausedAt = null;
      phase = -1;
      raf = requestAnimationFrame(frame);
    };
    const pause = () => {
      if (pausedAt !== null) return;
      cancelAnimationFrame(raf);
      pausedAt = (performance.now() - start) % CYCLE_MS;
    };
    const showFinal = () => {
      pause();
      state.set(goal);
      draw();
      reveal(true);
    };

    const onVisibility = () => (document.hidden ? pause() : run());
    const onReduce = () => {
      if (reduceMq.matches) showFinal();
      else {
        pausedAt = 0;
        state.fill(0);
        reveal(false);
        draw();
        run();
      }
    };

    if (reduceMq.matches) showFinal();
    else {
      draw();
      run();
    }
    document.addEventListener("visibilitychange", onVisibility);
    reduceMq.addEventListener("change", onReduce);

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
      document.removeEventListener("visibilitychange", onVisibility);
      reduceMq.removeEventListener("change", onReduce);
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
    <div className="hero-map">
      <canvas
        ref={ref}
        className="hero-dots"
        style={{ aspectRatio: layout?.aspect ?? FALLBACK_ASPECT }}
        role="img"
        aria-label="点でできた日本地図。点1つが架空の1万人の1人で、人の多い都道府県ほど点が密になる。広告が届いた人、インストールした人、使い続けている人、課金した人の順に色がつくイメージ図。終わりに地方別の割合を吹き出しで示す"
      />
      {layout && regions && (
        <div className={`hero-bubbles${revealed ? " on" : ""}`} aria-hidden="true">
          <svg className="hero-leaders" viewBox="0 0 1 1" preserveAspectRatio="none">
            {regions.map((r) => {
              const at = BUBBLE_AT[r.id];
              const c = layout.centers[r.id];
              if (!at || !c) return null;
              return <line key={r.id} x1={at.x} y1={at.y} x2={c[0]} y2={c[1]} vectorEffect="non-scaling-stroke" />;
            })}
            {regions.map((r) => {
              const c = layout.centers[r.id];
              return c && BUBBLE_AT[r.id] ? <circle key={r.id} cx={c[0]} cy={c[1]} r={0.006} /> : null;
            })}
          </svg>
          {regions.map((r) => {
            const at = BUBBLE_AT[r.id];
            if (!at || !layout.centers[r.id]) return null;
            return (
              <div key={r.id} className={`hb${at.small ? " sm" : ""}`} style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}>
                <strong>{r.name_ja}</strong>
                <span className="hb-nums">
                  <Pct level={2} v={r.install_pct} />
                  <Pct level={3} v={r.active_pct} />
                  <Pct level={4} v={r.pay_pct} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Pct({ level, v }: { level: number; v: number }) {
  return (
    <span className="num">
      <span className={`swatch lv${level}`} />
      {v}%
    </span>
  );
}

/**
 * 地方別の割合の一覧。スマホでは地図の下に見える形で出し（吹き出しの代わり）、
 * それより広い画面では読み上げ用にだけ置く（見た目は地図の吹き出し）
 */
export function HeroRegionList({ shown }: { shown: boolean }) {
  const [data, setData] = useState<HeroRegions | null>(null);
  useEffect(() => {
    let alive = true;
    loadHeroRegions()
      .then((d) => alive && setData(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!data) return null;
  return (
    <div className={`hero-regions${shown ? " on" : ""}`}>
      <table>
        <caption className="sr-only">地方別の割合（全国の合計のうち、その地方が占める割合）</caption>
        <thead>
          <tr>
            <th scope="col">地方</th>
            <th scope="col">
              <span className="swatch lv2" aria-hidden />
              インストール
            </th>
            <th scope="col">
              <span className="swatch lv3" aria-hidden />
              使い続けている
            </th>
            <th scope="col">
              <span className="swatch lv4" aria-hidden />
              課金した
            </th>
          </tr>
        </thead>
        <tbody>
          {data.regions.map((r) => (
            <tr key={r.id}>
              <th scope="row">{r.name_ja}</th>
              <td className="num">{r.install_pct}%</td>
              <td className="num">{r.active_pct}%</td>
              <td className="num">{r.pay_pct}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 丸の中のはてなのボタンと、押すと開く小さな吹き出し。Esc と外側のクリックで閉じる */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    // 画面からはみ出さないように、横にずらす
    const place = () => {
      const p = pop.current;
      if (!p) return;
      p.style.setProperty("--shift", "0px");
      const r = p.getBoundingClientRect();
      const margin = 12;
      const vw = document.documentElement.clientWidth;
      let dx = 0;
      if (r.right > vw - margin) dx = vw - margin - r.right;
      if (r.left + dx < margin) dx = margin - r.left;
      setShift(dx);
    };
    place();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  return (
    <span className="tip" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className="tip-btn"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M7.6 7.7a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="10" cy="14.6" r="1" fill="currentColor" />
        </svg>
      </button>
      <span
        ref={pop}
        id={id}
        role="note"
        className="tip-pop"
        hidden={!open}
        style={{ ["--shift" as string]: `${shift}px` }}
      >
        {children}
      </span>
    </span>
  );
}
