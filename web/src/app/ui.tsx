// 画面で共通に使う小さな部品と言い回し。

import { formatCount } from "../lib/format";
import type { PlanId, Replay } from "../lib/replay";

export const PLAN_VAR: Record<PlanId, string> = { A: "var(--a)", B: "var(--b)" };

export function PlanName({ id }: { id: PlanId }) {
  return (
    <span className="plan-tag" style={{ color: PLAN_VAR[id] }}>
      {id}案
    </span>
  );
}

/** 数の単位 */
export function unit(metric: string): string {
  if (metric.endsWith("_jpy")) return "円";
  if (metric === "impressions") return "回";
  return "人";
}

/** 「90日間」「180日間（90日より後は推計の延長）」 */
export function periodText(replay: Replay): string {
  const { period_days, extrapolated_after_day } = replay.meta;
  return period_days > extrapolated_after_day
    ? `${period_days}日間（${extrapolated_after_day}日より後は推計の延長）`
    : `${period_days}日間`;
}

/** 人数（小数は四捨五入。1人未満は「1人未満」） */
export function people(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v > 0 && v < 0.5) return "1人未満";
  if (Math.abs(v) < 1e4) return `${Math.round(v).toLocaleString("ja-JP")}人`;
  return `${formatCount(v)}人`;
}

/** 指標の値（人は整数、円は万・億） */
export function value(metric: string, v: number): string {
  return unit(metric) === "人" ? people(v) : `${formatCount(v)}${unit(metric)}`;
}

/** 数だけ（単位なし）。1万未満は整数 */
export function count(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return Math.abs(v) < 1e4 ? Math.round(v).toLocaleString("ja-JP") : formatCount(v);
}
