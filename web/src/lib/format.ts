// 数字の表示。1万人基準と「日本全体換算」を切り替える。

import type { MetricKey, ReplayMeta } from "./replay";

export type Scale = "sample" | "japan";

const LABELS_JA: Record<string, string> = {
  impressions: "広告の表示回数",
  reached: "広告が届いた人",
  installs: "インストール",
  installs_ad: "インストール（広告）",
  installs_wom: "インストール（クチコミ）",
  installs_wom_x: "クチコミ（X 上の拡散）",
  installs_wom_local: "クチコミ（身近な人づて）",
  signups: "登録",
  core_actions: "核心行動",
  trials: "無料体験",
  active: "使っている人",
  active_end: "継続（最終日）",
  payers: "決済した人",
  revenue_jpy: "売上",
  spend_jpy: "広告費",
  cpi_jpy: "インストール単価",
  roas: "広告費あたり売上",
};

/** 指標の日本語名。gate:<id> は「関門（id）」。関門の日本語名はリプレイにないので id のまま出す */
export function metricLabel(key: MetricKey | string): string {
  if (key.startsWith("gate:")) return `関門を通過（${key.slice(5)}）`;
  return LABELS_JA[key] ?? key;
}

/** 日本全体換算で掛けない指標（比や単価） */
const RATIO_METRICS = new Set(["cpi_jpy", "roas"]);

export function scaleFactor(meta: ReplayMeta, scale: Scale, key?: string): number {
  if (key && RATIO_METRICS.has(key)) return 1;
  return scale === "japan" ? meta.scale_to_japan : 1;
}

/** 日本語の大きな数の単位（万・億）で短く。例: 12,345 → 1.2万 */
export function formatCount(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${trim(v / 1e8)}億`;
  if (abs >= 1e4) return `${trim(v / 1e4)}万`;
  if (abs >= 100) return Math.round(v).toLocaleString("ja-JP");
  return trim(v);
}

function trim(v: number): string {
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 0 : abs >= 1 ? 1 : 2;
  return Number(v.toFixed(digits)).toLocaleString("ja-JP");
}

/** 単位つき。signed = true なら +/− を付ける（差の表示） */
export function formatValue(key: MetricKey | string, v: number, signed = false): string {
  const sign = signed && v > 0 ? "+" : "";
  if (key === "roas") return `${sign}${(v * 100).toFixed(0)}%`;
  if (key.endsWith("_jpy")) return `${sign}${formatCount(v)}円`;
  if (key === "impressions") return `${sign}${formatCount(v)}回`;
  return `${sign}${formatCount(v)}人`;
}

export function scaleLabel(scale: Scale): string {
  return scale === "japan" ? "日本全体換算" : "1万人あたり";
}
