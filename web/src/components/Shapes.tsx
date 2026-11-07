// 背景の大きな形（飾り）。色は index.css のトークン（--brand など）を CSS で塗る。どれも aria-hidden。
// Wave: 主役色の面の上下の、ゆるい波の縁。面の外側にはみ出して描く（隣の節の色に関係なくつながる）。
// Decor: 節の背景に敷く、しずくのような面と流れるリボン。親の .decor（overflow: hidden）の中に置く。

export function Wave({ position }: { position: "top" | "bottom" }) {
  return (
    <svg className={`wave wave-${position}`} viewBox="0 0 1440 72" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path d="M0 72 L0 44 C 200 6, 430 0, 720 28 S 1250 70, 1440 22 L1440 72 Z" />
    </svg>
  );
}

const BLOB = "M421 64c74 38 140 112 152 198 12 87-30 186-104 246-74 60-180 82-270 54C109 534 35 457 14 366-7 276 25 172 92 108 159 44 262 20 331 28c35 4 64 18 90 36z";
const DROP = "M300 20c70 90 190 200 190 330a190 190 0 0 1-380 0C110 220 230 110 300 20z";
const RIBBON = "M-60 430 C 160 300, 320 560, 540 400 S 860 150, 1080 250 L1080 400 C 860 300, 720 560, 520 540 S 160 440, -60 580 Z";

/** 節の背景の形。kind ごとに置き方を変える（位置と大きさは index.css の .decor-*） */
export function Decor({ kind }: { kind: "hero" | "how" | "tint" | "start" | "page" }) {
  return (
    <div className={`decor decor-${kind}`} aria-hidden="true">
      {(kind === "hero" || kind === "how" || kind === "start") && (
        <svg className="d-ribbon" viewBox="0 0 1000 700" preserveAspectRatio="none" focusable="false">
          <path d={RIBBON} />
        </svg>
      )}
      <svg className="d-blob" viewBox="0 0 600 600" focusable="false">
        <path d={BLOB} />
      </svg>
      {kind !== "page" && (
        <svg className="d-drop" viewBox="0 0 600 600" focusable="false">
          <path d={DROP} />
        </svg>
      )}
    </div>
  );
}
