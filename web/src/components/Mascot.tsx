// マスコット「小さなリハーサル監督」。テプリは本番前に架空の1万人が演じるリハーサルの舞台で、
// このキャラクターはその舞台を仕切る小さな監督（名前はまだ付けない）。
// 共通のパーツ（体・ヘッドホン・顔・手・足）と小道具（クリップボード・カチンコ・虫めがね）を組み合わせて、6つのポーズを作る。
// 色は index.css の --a（藍）・--b（若竹）と、マスコット用の中間色 --m-* だけを使う（ライト・ダークの両方で見える）。
// ヘッドホンの耳あてとクリップボードの紙に、サイトの地図と同じ「点」を入れている。
// 飾りなので既定は aria-hidden。動きは busy の小さな上下の揺れだけで、動きを減らす設定では止まる（index.css）。

import { useId } from "react";

export type MascotPose = "point" | "wonder" | "action" | "busy" | "inspect" | "oops";

export const MASCOT_POSES: { pose: MascotPose; label: string; place: string }[] = [
  { pose: "point", label: "笑顔で地図を指す", place: "トップのヒーロー（日本地図の横）" },
  { pose: "wonder", label: "首をかしげる", place: "トップ「リリースしてみないと分からない」の節" },
  { pose: "action", label: "カチンコを持って意気込む", place: "トップ「テプリで試す」の節" },
  { pose: "busy", label: "走って作業中", place: "ライブで試すの読み込み中・実行中" },
  { pose: "inspect", label: "虫めがねで結果をのぞく", place: "結果画面の見出しのそば" },
  { pose: "oops", label: "頭をかいて苦笑い", place: "今は使っていない（検証の画面は根拠の「限界」に移した）" },
];

interface Props {
  pose: MascotPose;
  /** 表示の幅と高さ（px）。CSS で上書きしてもよい */
  size?: number;
  className?: string;
  /** 意味を持たせるときだけ渡す（渡さなければ aria-hidden の飾り） */
  label?: string;
}

const LINE = "var(--m-line)";
const INK = "var(--m-ink)";
const SW = 2.2;

export function Mascot({ pose, size = 96, className, label }: Props) {
  const uid = useId().replace(/:/g, "");
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={`mascot mascot-${pose}${className ? ` ${className}` : ""}`}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true, focusable: false })}
    >
      {POSES[pose](uid)}
    </svg>
  );
}

// ---- ポーズ ----

const POSES: Record<MascotPose, (uid: string) => React.ReactNode> = {
  // 1. 笑顔で右上（地図）を指す。左手にクリップボード
  point: () => (
    <g>
      <Feet />
      <Body />
      <Headphones />
      <Face expr="smile" dx={2} />
      <Clipboard x={19} y={89} rot={-10} />
      <Hand x={27} y={93} />
      <PointHand x={102} y={80} angle={-48} />
      <Sparkle x={114} y={57} />
    </g>
  ),

  // 2. 首をかしげる。右手をほおに当てて、頭の上にはてな
  wonder: () => (
    <g>
      <g transform="rotate(-10 60 104)">
        <Feet />
        <Body />
        <Headphones />
        <Face expr="wonder" />
        <Clipboard x={19} y={90} rot={-6} />
        <Hand x={27} y={94} />
        <Hand x={80} y={87} />
      </g>
      <Question x={101} y={18} />
    </g>
  ),

  // 3. 左手を握って意気込み、右手にカチンコ
  action: (uid) => (
    <g>
      <Feet />
      <Body />
      <Headphones />
      <Face expr="determined" />
      <Clapper uid={uid} x={99} y={88} rot={8} />
      <Hand x={91} y={96} />
      <Effort x={17} y={44} />
      <Hand x={17} y={44} fist />
    </g>
  ),

  // 4. 前のめりで走る。右手にクリップボード、後ろに流れる線
  busy: () => (
    <g>
      <SpeedLines />
      <g className="m-bob">
        <g transform="rotate(8 60 102)">
          <Feet run />
          <Body />
          <Headphones />
          <Face expr="busy" dx={3} />
          <Hand x={23} y={88} />
          <Clipboard x={101} y={83} rot={14} />
          <Hand x={95} y={90} />
        </g>
      </g>
    </g>
  ),

  // 5. 虫めがねで結果をのぞく（レンズの中で目が大きく見える）
  inspect: () => (
    <g>
      <g transform="rotate(4 60 102)">
        <Feet />
        <Body />
        <Headphones />
        <Face expr="inspect" />
        <Lens />
        <Hand x={91} y={88} />
        <Clipboard x={19} y={90} rot={-8} />
        <Hand x={27} y={94} />
      </g>
    </g>
  ),

  // 6. 頭をかいて苦笑い。汗ひとつぶ
  oops: () => (
    <g>
      <Feet />
      <Body />
      <Headphones />
      <Face expr="oops" />
      <Sweat x={33} y={40} />
      <Clipboard x={19} y={90} rot={-6} />
      <Hand x={27} y={94} />
      <Scratch />
      <Hand x={83} y={38} />
    </g>
  ),
};

// ---- 体のパーツ ----

const BODY_D = "M60 39 C82 39 95 54 95 72 C95 89 80 101 60 101 C40 101 25 89 25 72 C25 54 38 39 60 39 Z";

function Body() {
  return (
    <g>
      <path d={BODY_D} fill="var(--m-body)" stroke={LINE} strokeWidth={SW} />
      {/* 下の影 */}
      <path d="M28.6 82 C33 94 45 99.6 60 99.6 C75 99.6 87 94 91.4 82 C83 90 72 93.5 60 93.5 C48 93.5 37 90 28.6 82 Z" fill="var(--m-shade)" />
      {/* 頭のつや */}
      <path d="M41 49 Q46 44.5 52 43.6" fill="none" stroke="var(--m-gloss)" strokeWidth={2.4} strokeLinecap="round" />
    </g>
  );
}

function Feet({ run = false }: { run?: boolean }) {
  const foot = { fill: "var(--m-shoe)", stroke: LINE, strokeWidth: SW };
  if (run) {
    return (
      <g>
        <ellipse cx={40} cy={100} rx={8} ry={4.6} transform="rotate(-28 40 100)" {...foot} />
        <ellipse cx={80} cy={100.5} rx={8} ry={4.6} transform="rotate(18 80 100.5)" {...foot} />
      </g>
    );
  }
  return (
    <g>
      <ellipse cx={47} cy={102} rx={8} ry={4.6} {...foot} />
      <ellipse cx={73} cy={102} rx={8} ry={4.6} {...foot} />
    </g>
  );
}

/** ヘッドホン。耳あてに点を3つ（サイトの地図の点） */
function Headphones() {
  const band = "M24 56 C24 27 96 27 96 56";
  return (
    <g>
      <path d={band} fill="none" stroke={LINE} strokeWidth={7} strokeLinecap="round" />
      <path d={band} fill="none" stroke="var(--a)" strokeWidth={3} strokeLinecap="round" />
      {[18.5, 90.5].map((x) => (
        <g key={x}>
          <rect x={x} y={52} width={11} height={21} rx={5.5} fill="var(--a)" stroke={LINE} strokeWidth={SW} />
          {[57.2, 62.5, 67.8].map((y) => (
            <circle key={y} cx={x + 5.5} cy={y} r={1.45} fill="var(--m-body)" />
          ))}
        </g>
      ))}
    </g>
  );
}

function Hand({ x, y, fist = false }: { x: number; y: number; fist?: boolean }) {
  return (
    <g>
      <circle cx={x} cy={y} r={fist ? 6.4 : 5.8} fill="var(--m-body)" stroke={LINE} strokeWidth={SW} />
    </g>
  );
}

/** 人さし指を伸ばした手（angle は指の向き。0 で右） */
function PointHand({ x, y, angle }: { x: number; y: number; angle: number }) {
  const body = { fill: "var(--m-body)" };
  return (
    <g transform={`translate(${x} ${y}) rotate(${angle})`}>
      <rect x={1} y={-5.2} width={11.4} height={4.6} rx={2.3} {...body} stroke={LINE} strokeWidth={SW} />
      <circle cx={0} cy={0} r={6} {...body} stroke={LINE} strokeWidth={SW} />
      {/* 指と手のつなぎ目の線を消す */}
      <rect x={1.2} y={-4.1} width={5.4} height={2.4} {...body} />
      <path d="M-1.6 2.2 Q1.2 3.4 3.6 1.6" fill="none" stroke={LINE} strokeWidth={1.3} strokeLinecap="round" />
    </g>
  );
}

// ---- 顔 ----

type Expr = "smile" | "wonder" | "determined" | "busy" | "inspect" | "oops";

function Eye({ cx, cy, r = 3.4 }: { cx: number; cy: number; r?: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={INK} />
      <circle cx={cx + r * 0.36} cy={cy - r * 0.38} r={r * 0.32} fill="var(--m-shine)" />
    </g>
  );
}

function Brow({ d }: { d: string }) {
  return <path d={d} fill="none" stroke={INK} strokeWidth={2.2} strokeLinecap="round" />;
}

function Face({ expr, dx = 0 }: { expr: Expr; dx?: number }) {
  const L = 49;
  const R = 71;
  const Y = 66;
  return (
    <g transform={dx ? `translate(${dx} 0)` : undefined}>
      <ellipse cx={41.5} cy={74.5} rx={4.6} ry={2.8} fill="var(--m-cheek)" />
      <ellipse cx={78.5} cy={74.5} rx={4.6} ry={2.8} fill="var(--m-cheek)" />

      {expr === "smile" && (
        <>
          <Eye cx={L} cy={Y} />
          <Eye cx={R} cy={Y} />
          <OpenMouth />
        </>
      )}

      {expr === "wonder" && (
        <>
          <Brow d="M44.5 58.6 Q48.8 57.8 53 59" />
          <Brow d="M66.5 56.4 Q71 52.6 75.6 55" />
          <Eye cx={L} cy={Y} />
          <Eye cx={R} cy={Y - 0.6} r={3.6} />
          <ellipse cx={61.5} cy={77} rx={2.1} ry={2.5} fill={INK} />
        </>
      )}

      {expr === "determined" && (
        <>
          <Brow d="M43.6 57 L53.2 60.4" />
          <Brow d="M76.4 57 L66.8 60.4" />
          <Eye cx={L} cy={Y + 0.4} />
          <Eye cx={R} cy={Y + 0.4} />
          <OpenMouth wide />
        </>
      )}

      {expr === "busy" && (
        <>
          <Brow d="M44.5 58.4 L53 59.8" />
          <Brow d="M75.5 58.4 L67 59.8" />
          <Eye cx={L} cy={Y} />
          <Eye cx={R} cy={Y} />
          <ellipse cx={60} cy={77} rx={2.6} ry={2.2} fill={INK} />
        </>
      )}

      {expr === "inspect" && (
        <>
          <Brow d="M44.6 58 Q48.8 55.6 53 57.6" />
          <Eye cx={L} cy={Y} />
          {/* レンズの中で大きく見える目 */}
          <Eye cx={73} cy={Y} r={5.8} />
          <path d="M56.5 77.4 Q59.5 79.4 62.5 77.4" fill="none" stroke={INK} strokeWidth={2} strokeLinecap="round" />
        </>
      )}

      {expr === "oops" && (
        <>
          <Brow d="M44.4 58.6 L52.8 56.6" />
          <Brow d="M75.6 58.6 L67.2 56.6" />
          <path d="M45.2 67 Q49 62.6 52.8 67" fill="none" stroke={INK} strokeWidth={2.4} strokeLinecap="round" />
          <path d="M67.2 67 Q71 62.6 74.8 67" fill="none" stroke={INK} strokeWidth={2.4} strokeLinecap="round" />
          <path d="M53 77.2 q2.33 -2.2 4.66 0 t4.66 0 t4.66 0" fill="none" stroke={INK} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </g>
  );
}

function OpenMouth({ wide = false }: { wide?: boolean }) {
  const w = wide ? 6.4 : 5.6;
  const d = wide ? `M${60 - w} 74.4 L${60 + w} 74.4 Q${60 + w} 82.4 60 82.4 Q${60 - w} 82.4 ${60 - w} 74.4 Z` : `M${60 - w} 74.6 Q60 83 ${60 + w} 74.6 Z`;
  return (
    <g>
      <path d={d} fill={INK} stroke={INK} strokeWidth={1.2} strokeLinejoin="round" />
      <path d={`M56.6 ${wide ? 80.6 : 79.4} Q60 ${wide ? 78 : 77.4} 63.4 ${wide ? 80.6 : 79.4} Q60 ${wide ? 82.2 : 81.2} 56.6 ${wide ? 80.6 : 79.4} Z`} fill="var(--m-tongue)" />
    </g>
  );
}

// ---- 小道具 ----

/** クリップボード（板は若竹、紙に点が並ぶ） */
function Clipboard({ x, y, rot = 0 }: { x: number; y: number; rot?: number }) {
  const dots: string[][] = [
    ["var(--a)", "var(--a)", "var(--m-dot)"],
    ["var(--b)", "var(--a)", "var(--m-dot)"],
    ["var(--b)", "var(--m-dot)", "var(--a)"],
  ];
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
      <rect x={-10} y={-13} width={20} height={26} rx={3} fill="var(--b)" stroke={LINE} strokeWidth={SW} />
      <rect x={-7} y={-8.6} width={14} height={18.6} rx={1.6} fill="var(--m-paper)" />
      {dots.map((row, i) => row.map((c, j) => <circle key={`${i}-${j}`} cx={-3.8 + j * 3.8} cy={-3.4 + i * 4} r={1.25} fill={c} />))}
      <rect x={-4.6} y={-15.4} width={9.2} height={5} rx={1.6} fill="var(--m-shoe)" stroke={LINE} strokeWidth={1.6} />
    </g>
  );
}

/** カチンコ（板は藍、拍子木に若竹の縞）。上の拍子木は開いている */
function Clapper({ uid, x, y, rot = 0 }: { uid: string; x: number; y: number; rot?: number }) {
  const stripes = (top: number, h: number, id: string) => (
    <g>
      <clipPath id={id}>
        <rect x={-14} y={top} width={28} height={h} rx={1.4} />
      </clipPath>
      <rect x={-14} y={top} width={28} height={h} rx={1.4} fill="var(--m-body)" />
      <g clipPath={`url(#${id})`}>
        {[-15, -6, 3, 12].map((sx) => (
          <path key={sx} d={`M${sx} ${top + h} l${h * 0.7} ${-h} h4.4 l${-h * 0.7} ${h} Z`} fill="var(--b)" />
        ))}
      </g>
      <rect x={-14} y={top} width={28} height={h} rx={1.4} fill="none" stroke={LINE} strokeWidth={SW} />
    </g>
  );
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
      <rect x={-14} y={-1} width={28} height={17} rx={2.4} fill="var(--a)" stroke={LINE} strokeWidth={SW} />
      <path d="M-9.5 6 H9.5 M-9.5 10.6 H3" stroke="var(--m-body)" strokeWidth={1.5} strokeLinecap="round" opacity={0.85} />
      {stripes(-6.4, 5.4, `${uid}-c1`)}
      <g transform="rotate(-24 -14 -6.4)">{stripes(-12.6, 5.4, `${uid}-c2`)}</g>
    </g>
  );
}

/** 虫めがね（縁は若竹）。右目の上に重ねる */
function Lens() {
  return (
    <g>
      <g strokeLinecap="round">
        <line x1={81} y1={74.5} x2={89.5} y2={85} stroke={LINE} strokeWidth={7.4} />
        <line x1={81} y1={74.5} x2={89.5} y2={85} stroke="var(--m-shoe)" strokeWidth={3.2} />
      </g>
      <circle cx={73} cy={66} r={10.6} fill="var(--m-glass)" stroke={LINE} strokeWidth={6.6} />
      <circle cx={73} cy={66} r={10.6} fill="none" stroke="var(--b)" strokeWidth={3} />
      <path d="M66.4 61.4 Q68 58.2 71.6 57.4" fill="none" stroke="var(--m-shine)" strokeWidth={1.6} strokeLinecap="round" opacity={0.9} />
    </g>
  );
}

// ---- 記号 ----

function Question({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <path
        d={`M${x - 6} ${y + 5} C${x - 6} ${y - 2.5} ${x + 6} ${y - 2.5} ${x + 6} ${y + 5} C${x + 6} ${y + 10} ${x} ${y + 10} ${x} ${y + 15.5}`}
        fill="none"
        stroke="var(--a)"
        strokeWidth={3.6}
        strokeLinecap="round"
      />
      <circle cx={x} cy={y + 22} r={2.2} fill="var(--a)" />
    </g>
  );
}

/** 指の先の小さなきらめき */
function Sparkle({ x, y }: { x: number; y: number }) {
  return (
    <path
      d={`M${x} ${y - 5} Q${x + 0.9} ${y - 0.9} ${x + 5} ${y} Q${x + 0.9} ${y + 0.9} ${x} ${y + 5} Q${x - 0.9} ${y + 0.9} ${x - 5} ${y} Q${x - 0.9} ${y - 0.9} ${x} ${y - 5} Z`}
      fill="var(--gold)"
    />
  );
}

/** 握りこぶしのまわりの「ぐっ」の線 */
function Effort({ x, y }: { x: number; y: number }) {
  const rays = [
    [-160, 9.5, 13.5],
    [-125, 9.5, 14.5],
    [-90, 9.5, 13.5],
  ];
  return (
    <g stroke="var(--gold)" strokeWidth={2.2} strokeLinecap="round">
      {rays.map(([deg, r1, r2]) => {
        const a = (deg * Math.PI) / 180;
        return <line key={deg} x1={x + Math.cos(a) * r1} y1={y + Math.sin(a) * r1} x2={x + Math.cos(a) * r2} y2={y + Math.sin(a) * r2} />;
      })}
    </g>
  );
}

function SpeedLines() {
  return (
    <g stroke="var(--m-speed)" strokeWidth={2.4} strokeLinecap="round">
      <line x1={5} y1={60} x2={17} y2={60} />
      <line x1={2} y1={71} x2={16} y2={71} />
      <line x1={6} y1={82} x2={15} y2={82} />
    </g>
  );
}

function Sweat({ x, y }: { x: number; y: number }) {
  return (
    <path
      d={`M${x} ${y} C${x + 2.6} ${y + 4} ${x + 4.2} ${y + 6.2} ${x + 4.2} ${y + 8.4} A4.2 4.2 0 0 1 ${x - 4.2} ${y + 8.4} C${x - 4.2} ${y + 6.2} ${x - 2.6} ${y + 4} ${x} ${y} Z`}
      fill="var(--m-sweat)"
      stroke={LINE}
      strokeWidth={1.6}
      strokeLinejoin="round"
    />
  );
}

/** 頭をかく「かきかき」の線 */
function Scratch() {
  return (
    <g fill="none" stroke="var(--m-speed)" strokeWidth={2} strokeLinecap="round">
      <path d="M92 27 q3 -2.4 6 0" />
      <path d="M95 33.5 q3 -2.4 6 0" />
    </g>
  );
}
