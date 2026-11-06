// 日別グラフ: A/B の中央値（線）と10〜90%の範囲（帯）。延長部分は網掛け、再生中の日に縦線。
// SVG を手で描く（グラフライブラリは使わない）。

import { useEffect, useMemo, useRef, useState } from "react";
import type { Band, CumulativeKey, DailyKey, PlanId, PlanResult, Replay } from "../lib/replay";
import { CUMULATIVE_KEYS } from "../lib/replay";
import { metricLabel, formatCount, formatValue, scaleFactor, scaleLabel, type Scale } from "../lib/format";
import { PLAN_COLOR, PLAN_LABEL } from "./Metrics";

export interface DailyChartProps {
  replay: Replay;
  metric: DailyKey;
  /** true なら daily_cumulative（回ごとに累計してから分位点）を描く。installs / payers / revenue_jpy のみ */
  cumulative?: boolean;
  scale: Scale;
  /** 再生中の日（縦線）。0 なら出さない */
  cursorDay?: number;
  height?: number;
  plans?: PlanId[];
  /** 見出し行（凡例）を出さない（画面側で別に出すとき） */
  hideHeader?: boolean;
}

const M = { top: 16, right: 16, bottom: 32, left: 60 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** 累計を描けるか（daily_cumulative にその指標があるか） */
export function canCumulate(replay: Replay, metric: DailyKey): boolean {
  if (!(CUMULATIVE_KEYS as readonly string[]).includes(metric)) return false;
  return (["A", "B"] as const).some((id) => replay.plans[id]?.daily_cumulative[metric as CumulativeKey]);
}

function seriesOf(plan: PlanResult, metric: DailyKey, cumulative: boolean): Band<number[]> | undefined {
  if (cumulative) return plan.daily_cumulative[metric as CumulativeKey];
  return plan.daily[metric];
}

export function DailyChart({ replay, metric, scale, cumulative = false, cursorDay = 0, height = 220, plans, hideHeader = false }: DailyChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hoverDay, setHoverDay] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cum = cumulative && canCumulate(replay, metric);
  const ids = (plans ?? (["A", "B"] as const)).filter((id) => replay.plans[id] && seriesOf(replay.plans[id]!, metric, cum));
  const get = (id: PlanId) => seriesOf(replay.plans[id]!, metric, cum)!;
  const k = scaleFactor(replay.meta, scale);
  const extraAfter = replay.meta.extrapolated_after_day;

  const geom = useMemo(() => {
    const days = replay.plans[ids[0]]?.daily.day ?? [];
    const maxDay = days.length ? days[days.length - 1] : 1;
    let maxY = 0;
    for (const id of ids) for (const v of get(id).p90) maxY = Math.max(maxY, v * k);
    return { days, maxDay, maxY: niceMax(maxY) };
  }, [replay, metric, k, cum, ids.join(",")]);

  const iw = Math.max(0, width - M.left - M.right);
  const ih = height - M.top - M.bottom;
  const x = (d: number) => M.left + ((d - 1) / Math.max(1, geom.maxDay - 1)) * iw;
  const y = (v: number) => M.top + ih - (v / geom.maxY) * ih;

  const paths = ids.map((id) => {
    const d = replay.plans[id]!.daily;
    const b = get(id);
    const line = d.day.map((day, i) => `${i ? "L" : "M"}${x(day).toFixed(1)},${y(b.p50[i] * k).toFixed(1)}`).join("");
    const upper = d.day.map((day, i) => `${i ? "L" : "M"}${x(day).toFixed(1)},${y(b.p90[i] * k).toFixed(1)}`).join("");
    const lower = d.day
      .map((day, i) => [day, i] as const)
      .reverse()
      .map(([day, i]) => `L${x(day).toFixed(1)},${y(b.p10[i] * k).toFixed(1)}`)
      .join("");
    return { id, line, band: `${upper}${lower}Z` };
  });

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * geom.maxY);
  const xTicks = [1, ...[30, 60, 90, 180, 270, 365].filter((d) => d < geom.maxDay), geom.maxDay];

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const day = Math.round(1 + (px / Math.max(1, iw)) * (geom.maxDay - 1));
    setHoverDay(Math.max(1, Math.min(geom.maxDay, day)));
  };

  const hoverIdx = hoverDay !== null ? geom.days.indexOf(hoverDay) : -1;

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      {!hideHeader && <div className="small secondary" style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 4 }}>
        <strong style={{ color: "var(--text-primary)" }}>{metricLabel(metric)}（{cum ? "累計" : "日別"}）</strong>
        {ids.map((id) => (
          <span key={id} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <span className="swatch" style={{ background: PLAN_COLOR[id] }} />
            {PLAN_LABEL[id]}
          </span>
        ))}
        <span className="muted">線 = 中央値、帯 = 10〜90%（{scaleLabel(scale)}）</span>
      </div>}
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${metricLabel(metric)}の${cum ? "累計" : "日別"}推移`}>
          {/* 延長部分 */}
          {extraAfter < geom.maxDay && (
            <g>
              <rect x={x(extraAfter)} y={M.top} width={x(geom.maxDay) - x(extraAfter)} height={ih} fill="var(--extrapolated)" />
              <line x1={x(extraAfter)} x2={x(extraAfter)} y1={M.top} y2={M.top + ih} stroke="var(--text-muted)" strokeDasharray="3 3" />
              <text x={x(extraAfter) + 6} y={M.top + 12} fontSize={14} fill="var(--text-muted)">
                推計の延長
              </text>
            </g>
          )}
          {/* 目盛り */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + iw} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
              <text x={M.left - 6} y={y(t) + 4} fontSize={14} textAnchor="end" fill="var(--text-muted)" className="num">
                {formatCount(t)}
              </text>
            </g>
          ))}
          {xTicks.map((d) => (
            <text key={d} x={x(d)} y={height - 8} fontSize={14} textAnchor={d === geom.maxDay ? "end" : d === 1 ? "start" : "middle"} fill="var(--text-muted)" className="num">
              {d}日
            </text>
          ))}
          {/* 帯 → 線の順に重ねる */}
          {paths.map((p) => (
            <path key={`b${p.id}`} d={p.band} fill={PLAN_COLOR[p.id]} opacity={0.18} />
          ))}
          {paths.map((p) => (
            <path key={`l${p.id}`} d={p.line} fill="none" stroke={PLAN_COLOR[p.id]} strokeWidth={2} strokeLinejoin="round" />
          ))}
          {/* 再生中の日 */}
          {cursorDay > 0 && cursorDay <= geom.maxDay && (
            <line x1={x(cursorDay)} x2={x(cursorDay)} y1={M.top} y2={M.top + ih} stroke="var(--text-primary)" strokeWidth={1} />
          )}
          {/* ホバー */}
          {hoverIdx >= 0 && (
            <g pointerEvents="none">
              <line x1={x(hoverDay!)} x2={x(hoverDay!)} y1={M.top} y2={M.top + ih} stroke="var(--text-secondary)" strokeDasharray="2 2" />
              {ids.map((id) => (
                <circle
                  key={id}
                  cx={x(hoverDay!)}
                  cy={y(get(id).p50[hoverIdx] * k)}
                  r={4}
                  fill={PLAN_COLOR[id]}
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
              ))}
            </g>
          )}
          <rect
            x={M.left}
            y={M.top}
            width={iw}
            height={ih}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHoverDay(null)}
          />
        </svg>
      )}
      {hoverIdx >= 0 && (
        <div
          className="small"
          style={{
            position: "absolute",
            top: hideHeader ? 0 : 28,
            left: Math.min(Math.max(0, x(hoverDay!) + 10), Math.max(0, width - 240)),
            background: "var(--surface-1)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "6px 8px",
            pointerEvents: "none",
            minWidth: 220,
            fontSize: 15,
            whiteSpace: "nowrap",
            boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
          }}
        >
          <div style={{ fontWeight: 700 }}>
            {hoverDay}日目{hoverDay! > extraAfter && <span className="badge" style={{ marginLeft: 6 }}>推計の延長</span>}
          </div>
          {ids.map((id) => {
            const b = get(id);
            return (
              <div key={id} className="num" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className="swatch" style={{ background: PLAN_COLOR[id] }} />
                {PLAN_LABEL[id]} {formatValue(metric, b.p50[hoverIdx] * k)}
                <span className="muted">
                  （{formatCount(b.p10[hoverIdx] * k)}〜{formatCount(b.p90[hoverIdx] * k)}）
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
