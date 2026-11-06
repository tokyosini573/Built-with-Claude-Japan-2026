// 数字の部品: 1万人/日本全体の切り替え、A/B の範囲比較、A/B の差と「B が良い確率」、ファネル、状態の凡例。

import type { Band, ComparisonKey, PlanId, Replay, TotalKey, TotalMetrics } from "../lib/replay";
import { COMPARISON_KEYS } from "../lib/replay";
import { formatCount, formatValue, metricLabel, scaleFactor, scaleLabel, type Scale } from "../lib/format";
import { STATE_COLORS, STATE_LABELS_JA, type PersonState } from "../lib/states";

export const PLAN_COLOR: Record<PlanId, string> = { A: "var(--plan-a)", B: "var(--plan-b)" };
export const PLAN_LABEL: Record<PlanId, string> = { A: "A案", B: "B案" };

const planIdsOf = (replay: Replay) => (["A", "B"] as const).filter((id) => replay.plans[id]);

// ---- 1万人 / 日本全体 ----

export function ScaleToggle({ scale, onChange }: { scale: Scale; onChange: (s: Scale) => void }) {
  return (
    <span className="seg" role="group" aria-label="数字の基準">
      {(["sample", "japan"] as const).map((s) => (
        <button key={s} type="button" aria-pressed={scale === s} onClick={() => onChange(s)}>
          {scaleLabel(s)}
        </button>
      ))}
    </span>
  );
}

/** 期間が延長部分を含むときの注記 */
export function ExtrapolationNote({ replay }: { replay: Replay }) {
  const { period_days, extrapolated_after_day } = replay.meta;
  if (period_days <= extrapolated_after_day) return null;
  return (
    <span className="badge" title="90日までの公開ベンチマークに合わせ、それより後は曲線を延ばした推計です">
      {extrapolated_after_day}日より後は推計の延長を含む
    </span>
  );
}

// ---- A/B の範囲比較 ----

export const HEADLINE_METRICS: TotalKey[] = ["installs", "signups", "active_end", "payers", "revenue_jpy"];

export interface RangeCompareProps {
  replay: Replay;
  scale: Scale;
  metrics?: TotalKey[];
}

/** 指標ごとに A と B の中央値（p50）と範囲（p10〜p90）を同じ目盛りで並べる */
export function RangeCompare({ replay, scale, metrics = HEADLINE_METRICS }: RangeCompareProps) {
  const ids = planIdsOf(replay);
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="small secondary" style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
        {ids.map((id) => (
          <span key={id} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <span className="swatch" style={{ background: PLAN_COLOR[id] }} />
            {PLAN_LABEL[id]}
          </span>
        ))}
        <span className="muted">太字 = 中央値、帯 = 30回のうち10〜90%の範囲（{scaleLabel(scale)}）</span>
      </div>
      {metrics.map((m) => {
        const k = scaleFactor(replay.meta, scale, m);
        const rows = ids.map((id) => ({ id, t: replay.plans[id]!.totals[m] }));
        const max = Math.max(1e-9, ...rows.map((r) => (r.t ? r.t.p90 * k : 0)));
        return (
          <div key={m}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{metricLabel(m)}</div>
            <div style={{ display: "grid", gap: 4 }}>
              {rows.map(({ id, t }) => (
                <div
                  key={id}
                  style={{ display: "grid", gridTemplateColumns: "40px minmax(0,1fr) auto", gap: 8, alignItems: "center" }}
                >
                  <span className="small secondary">{PLAN_LABEL[id]}</span>
                  {t ? (
                    <>
                      <RangeBar p10={(t.p10 * k) / max} p50={(t.p50 * k) / max} p90={(t.p90 * k) / max} color={PLAN_COLOR[id]} />
                      <BandText metric={m} band={t} k={k} />
                    </>
                  ) : (
                    <span className="small muted">データなし</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BandText({ metric, band, k, signed = false }: { metric: string; band: Band<number>; k: number; signed?: boolean }) {
  return (
    <span className="num" style={{ textAlign: "right", minWidth: 150 }}>
      <strong>{formatValue(metric, band.p50 * k, signed)}</strong>
      <span className="small muted">
        {" "}
        （{formatValue(metric, band.p10 * k, signed)}〜{formatValue(metric, band.p90 * k, signed)}）
      </span>
    </span>
  );
}

function RangeBar({ p10, p50, p90, color }: { p10: number; p50: number; p90: number; color: string }) {
  const pct = (v: number) => `${Math.max(0, Math.min(1, v)) * 100}%`;
  return (
    <div style={{ position: "relative", height: 14 }} aria-hidden>
      <div style={{ position: "absolute", left: 0, right: 0, top: 6, height: 2, background: "var(--grid)" }} />
      <div
        style={{
          position: "absolute",
          left: pct(p10),
          width: `calc(${pct(p90 - p10)} + 2px)`,
          top: 3,
          height: 8,
          borderRadius: 4,
          background: color,
          opacity: 0.35,
        }}
      />
      <div
        style={{ position: "absolute", left: `calc(${pct(p50)} - 1px)`, top: 0, width: 3, height: 14, borderRadius: 2, background: color }}
      />
    </div>
  );
}

// ---- A/B の差（comparison） ----

export interface ABComparisonProps {
  replay: Replay;
  scale: Scale;
  metrics?: readonly ComparisonKey[];
}

/**
 * 同じ回どうしの差（B − A）と「B が A より良い確率」。数字はエンジンの comparison をそのまま出す。
 * 確率の帯は 0〜100%、真ん中（50%）に線。左が A 寄り、右が B 寄り。
 */
export function ABComparison({ replay, scale, metrics = COMPARISON_KEYS }: ABComparisonProps) {
  const c = replay.comparison;
  if (!c) return <p className="small muted">このリプレイには A/B の比較（comparison）がありません。</p>;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="small muted">30回の同じ回どうしで B − A を計算。確率は「B案のほうが多かった回の割合」。</div>
      {metrics.map((m) => {
        const p = c.p_B_better[m];
        const diff = c.B_minus_A[m];
        if (p === undefined && !diff) return null;
        const k = scaleFactor(replay.meta, scale, m);
        return (
          <div key={m} style={{ display: "grid", gap: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{metricLabel(m)}</span>
              {diff && (
                <span className="small">
                  <span className="secondary">差（B − A）</span> <BandText metric={m} band={diff} k={k} signed />
                </span>
              )}
            </div>
            {p !== undefined && <ProbabilityBar p={p} />}
          </div>
        );
      })}
    </div>
  );
}

/** B が良い確率の帯。文言は確率から機械的に決める（数字の解釈を足さない） */
export function ProbabilityBar({ p }: { p: number }) {
  const pct = Math.round(p * 100);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 8, alignItems: "center" }}>
      <div
        style={{ position: "relative", height: 10, borderRadius: 5, background: "var(--grid)", overflow: "hidden" }}
        role="img"
        aria-label={`B案が良い確率 ${pct}%`}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: p >= 0.5 ? "50%" : `${p * 100}%`,
            width: `${Math.abs(p - 0.5) * 100}%`,
            background: p >= 0.5 ? PLAN_COLOR.B : PLAN_COLOR.A,
          }}
        />
        <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--text-muted)" }} />
      </div>
      <span className="num small" style={{ minWidth: 150, textAlign: "right" }}>
        B案が良い確率 <strong>{pct}%</strong>
      </span>
    </div>
  );
}

// ---- ファネル ----

/** ファネルの段階。gate:<id> は totals にあるものを登録と核心行動の間に入れる */
export function funnelSteps(totals: TotalMetrics): TotalKey[] {
  const gates = Object.keys(totals).filter((k) => k.startsWith("gate:")) as TotalKey[];
  const steps: TotalKey[] = ["reached", "installs", "signups", ...gates, "core_actions"];
  if (totals.trials) steps.push("trials");
  steps.push("payers");
  return steps;
}

export interface FunnelProps {
  replay: Replay;
  scale: Scale;
}

/** 段階ごとの人数（中央値）と、前の段階からの割合。表示回数と最終日の継続は別に出す */
export function Funnel({ replay, scale }: FunnelProps) {
  const ids = planIdsOf(replay);
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(260px, 1fr))`, gap: 16 }}>
      {ids.map((id) => {
        const totals = replay.plans[id]!.totals;
        const steps = funnelSteps(totals).filter((s) => totals[s]);
        const first = steps.length ? totals[steps[0]]!.p50 : 0;
        const k = scaleFactor(replay.meta, scale);
        return (
          <div key={id}>
            <div style={{ fontWeight: 700, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
              <span className="swatch" style={{ background: PLAN_COLOR[id] }} />
              {PLAN_LABEL[id]}
            </div>
            {!totals.reached && <p className="small muted">reached がないので、最初の段階はインストールです。</p>}
            <div style={{ display: "grid", gap: 6 }}>
              {steps.map((s, i) => {
                const t = totals[s]!;
                const prev = i > 0 ? totals[steps[i - 1]]!.p50 : undefined;
                const rate = prev ? t.p50 / prev : null;
                const w = first > 0 ? t.p50 / first : 0;
                return (
                  <div key={s}>
                    <div className="small" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span>{metricLabel(s)}</span>
                      <span className="num">
                        {formatValue(s, t.p50 * k)}
                        {rate !== null && <span className="muted">（{(rate * 100).toFixed(rate < 0.1 ? 1 : 0)}%）</span>}
                      </span>
                    </div>
                    <div style={{ height: 8, background: "var(--grid)", borderRadius: 4 }}>
                      <div
                        style={{
                          width: `max(2px, ${Math.min(1, w) * 100}%)`,
                          height: 8,
                          borderRadius: 4,
                          background: PLAN_COLOR[id],
                          opacity: Math.max(0.4, 1 - i * 0.1),
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="small secondary num" style={{ marginTop: 8, display: "grid", gap: 2 }}>
              {(["impressions", "active_end"] as const).map((s) =>
                totals[s] ? (
                  <div key={s} style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>{metricLabel(s)}</span>
                    <span>{formatValue(s, totals[s]!.p50 * k)}</span>
                  </div>
                ) : null,
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- 地図の点の凡例 ----

export interface StateLegendProps {
  counts: number[];
  scale?: Scale;
  scaleToJapan?: number;
  /** 広告が届いた人（その日までの累計）。点にはしないので数字だけ出す */
  reached?: number | null;
}

/**
 * 点の数（1点 = 1人）。点は「このグループの中で進んだ人がいた」という意味なので、日本全体換算は掛けない。
 * 広告が届いた人だけは daily.reached の数字なので、基準に合わせて換算する。
 */
export function StateLegend({ counts, scale = "sample", scaleToJapan = 1, reached }: StateLegendProps) {
  const k = scale === "japan" ? scaleToJapan : 1;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {reached !== undefined && reached !== null && (
        <div className="small" style={{ display: "flex", justifyContent: "space-between" }}>
          <span className="secondary">広告が届いた人（累計、中央値の和）</span>
          <span className="num">{formatCount(reached * k)}人</span>
        </div>
      )}
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
          gap: "4px 12px",
        }}
      >
        {counts.map((c, s) => (
          <li key={s} className="small" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="swatch" style={{ background: s === 0 ? "var(--dot-untouched)" : STATE_COLORS[s as PersonState] }} />
            <span>{STATE_LABELS_JA[s as PersonState]}</span>
            <span className="num secondary" style={{ marginLeft: "auto" }}>
              {c.toLocaleString("ja-JP")}点
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
