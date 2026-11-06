// sample_run.events から「その日のその人の状態」を計算する。
// 地図の点1つ = 1人（実際には約9,680人を表す）。点の状態 = 「この人のグループの中で、ここまで進んだ人がいた」。
// 広告が届いた人はイベントにないので、点ではなく数字（daily.reached）で出す。

import type { ReplayEvent } from "./replay";

/** 点の状態。数値は進み具合の順（離脱だけは別扱い） */
export const PersonState = {
  None: 0, // 未接触（広告が届いただけの人もここ）
  Install: 1, // インストール
  Signup: 2, // 登録（関門を通った人もここ）
  CoreAction: 3, // 核心行動
  Trial: 4, // 無料体験
  Paid: 5, // 決済
  Churned: 6, // 離脱（グループで使っている人が0人になった）
} as const;
export type PersonState = (typeof PersonState)[keyof typeof PersonState];

export const STATE_COUNT = 7;

export const STATE_LABELS_JA: Record<PersonState, string> = {
  0: "未接触",
  1: "インストール",
  2: "登録",
  3: "核心行動",
  4: "無料体験",
  5: "決済",
  6: "離脱",
};

/**
 * 状態の色（開発用の仮の配色。画面デザインが決まったらここだけ差し替える）。
 * 進み具合は青の濃淡、決済はオレンジで目立たせ、離脱は赤みの灰色。未接触はテーマの変数 --dot-untouched。
 * 色だけに頼らず、凡例には必ずラベルと人数を出す。
 */
export const STATE_COLORS: Record<PersonState, string> = {
  0: "#a9a8a1",
  1: "#8fbcef",
  2: "#4f92e0",
  3: "#2a6fc9",
  4: "#7a6ad8",
  5: "#eb6834",
  6: "#b5706f",
};

/** step → 状態。契約 v1 の step 以外は null（無視して件数を数える） */
export function eventToState(step: string): PersonState | null {
  if (step.startsWith("gate:")) return PersonState.Signup;
  switch (step) {
    case "install":
      return PersonState.Install;
    case "signup":
      return PersonState.Signup;
    case "core_action":
      return PersonState.CoreAction;
    case "trial":
      return PersonState.Trial;
    case "pay":
      return PersonState.Paid;
    case "churn":
      return PersonState.Churned;
    default:
      return null;
  }
}

export interface StateTimeline {
  /** person_id → 行番号 */
  index: Map<number, number>;
  personCount: number;
  dayCount: number;
  /** snapshots[(day-1) * personCount + row] = その日の終わりの状態。day は 1 始まり */
  snapshots: Uint8Array;
  /** counts[(day-1) * STATE_COUNT + state] = 点の数 */
  counts: Uint32Array;
  /** 行ごとの、期間中にインストールした人数 n の合計（点の濃さに使う） */
  installN: Float32Array;
  /** 知らない step（無視したもの）と件数 */
  unknownEvents: Map<string, number>;
}

/**
 * 1日ずつ状態を進めて、全日のスナップショットを作る。
 * 規則: 同じ日の中では進み具合の順に適用し、離脱は最後。離脱後に新しいイベントがあれば、その状態に戻る（再開）。
 * 1万人 × 365日でも 3.6MB 程度。
 */
export function buildStateTimeline(personIds: number[], events: ReplayEvent[], dayCount: number): StateTimeline {
  const personCount = personIds.length;
  const index = new Map<number, number>();
  personIds.forEach((id, row) => index.set(id, row));

  const unknownEvents = new Map<string, number>();
  const installN = new Float32Array(personCount);
  const byDay: [number, PersonState][][] = Array.from({ length: dayCount + 1 }, () => []);
  for (const [pid, day, step, n] of events) {
    const state = eventToState(step);
    if (state === null) {
      unknownEvents.set(step, (unknownEvents.get(step) ?? 0) + 1);
      continue;
    }
    const row = index.get(pid);
    if (row === undefined || day < 1 || day > dayCount) continue;
    if (state === PersonState.Install) installN[row] += n ?? 1;
    byDay[day].push([row, state]);
  }

  const snapshots = new Uint8Array(personCount * dayCount);
  const counts = new Uint32Array(STATE_COUNT * dayCount);
  const current = new Uint8Array(personCount);
  for (let day = 1; day <= dayCount; day++) {
    const list = byDay[day].sort((a, b) => a[1] - b[1]);
    for (const [row, state] of list) {
      const prev = current[row];
      if (state === PersonState.Churned || prev === PersonState.Churned) current[row] = state;
      else if (state > prev) current[row] = state;
    }
    snapshots.set(current, (day - 1) * personCount);
    const base = (day - 1) * STATE_COUNT;
    for (let i = 0; i < personCount; i++) counts[base + current[i]]++;
  }
  return { index, personCount, dayCount, snapshots, counts, installN, unknownEvents };
}

/** その日の状態配列（コピーしない view）。day=0 は全員未接触 */
export function statesOnDay(t: StateTimeline, day: number): Uint8Array {
  if (day < 1) return new Uint8Array(t.personCount);
  const d = Math.min(day, t.dayCount);
  return t.snapshots.subarray((d - 1) * t.personCount, d * t.personCount);
}

export function countsOnDay(t: StateTimeline, day: number): number[] {
  if (day < 1) return [t.personCount, ...new Array(STATE_COUNT - 1).fill(0)];
  const d = Math.min(day, t.dayCount);
  return Array.from(t.counts.subarray((d - 1) * STATE_COUNT, d * STATE_COUNT));
}
