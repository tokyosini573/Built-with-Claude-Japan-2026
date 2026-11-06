// 画面の言葉（コードの値 → 日本語）。

import { METRIC_NAMES } from "../config";
import { metricLabel } from "./format";
import type { Replay } from "./replay";

export function metricName(key: string, replay?: Replay): string {
  if (key.startsWith("gate:")) return gateName(key.slice(5), replay);
  return METRIC_NAMES[key] ?? metricLabel(key);
}

export function gateName(id: string, replay?: Replay): string {
  return replay?.meta.gates?.find((g) => g.id === id)?.name_ja || id;
}

/** drop_reasons / 判断の step の言い方（「〜で離れた」の前の部分） */
export function stepName(step: string, replay?: Replay): string {
  if (step.startsWith("gate:")) return gateName(step.slice(5), replay);
  return (
    {
      install: "インストール",
      signup: "登録",
      core_action: "初マッチ",
      trial: "無料体験",
      retention: "使い続ける",
      pay: "課金",
      churn: "やめた",
    } as Record<string, string>
  )[step] ?? step;
}

export const LEVEL_JA = { higher: "平均より進みやすい", similar: "平均と同じくらい", lower: "平均より進みにくい" } as const;

export const CITY_JA = { metro: "大都市", city: "地方都市", town: "町村" } as const;

export const PREF_JA = [
  "", "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県",
  "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県",
  "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県",
  "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

export const CHANNEL_JA: Record<string, string> = {
  instagram: "Instagram", tiktok: "TikTok", x: "X", youtube: "YouTube", line: "LINE", facebook: "Facebook",
  train: "電車の広告", transit: "電車の広告", campus: "大学キャンパス", tv: "テレビ",
};

export function regionText(regions?: number[]): string {
  if (!regions || regions.length === 0) return "全国";
  const set = new Set(regions);
  if (regions.length === 4 && [11, 12, 13, 14].every((c) => set.has(c))) return "首都圏（東京・神奈川・埼玉・千葉）";
  return regions.map((c) => PREF_JA[c] ?? c).join("・");
}

export function yen(v: number): string {
  if (v >= 1e8) return `${+(v / 1e8).toFixed(2)}億円`;
  if (v >= 1e4) return `${+(v / 1e4).toFixed(1)}万円`;
  return `${v.toLocaleString("ja-JP")}円`;
}
