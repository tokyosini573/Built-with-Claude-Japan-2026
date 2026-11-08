// リプレイ JSON（契約 v0 §4 + v1 の追補）の型と読み込み。
// 数字はすべて1万人基準。日本全体は meta.scale_to_japan を掛けて表示する（cpi_jpy・roas など比の指標は掛けない）。

export type PlanId = "A" | "B";

/** 30回実行の分位点（日別は配列、合計は数値） */
export interface Band<T = number[]> {
  p10: T;
  p50: T;
  p90: T;
}

/** daily に置く指標。active だけ「その日に使っている人数」、ほかは「その日に新しく起きた数」 */
export const DAILY_KEYS = [
  "impressions",
  "reached",
  "installs",
  "signups",
  "core_actions",
  "active",
  "payers",
  "revenue_jpy",
] as const;
export type DailyKey = (typeof DAILY_KEYS)[number];

/** daily_cumulative に置く指標（回ごとに累計してから分位点を取ったもの） */
export const CUMULATIVE_KEYS = ["installs", "payers", "revenue_jpy", "core_actions"] as const;
export type CumulativeKey = (typeof CUMULATIVE_KEYS)[number];

/**
 * totals の正式項目。ほかに "gate:<id>" も入る。
 * payers = 期間中に一度でも決済した人数、active_end = 最終日の active、reached = 広告が届いた人数（重複なし）
 */
export type TotalKey =
  | "impressions"
  | "reached"
  | "installs"
  | "installs_ad"
  | "installs_wom"
  | "installs_wom_x"
  | "installs_wom_local"
  | "signups"
  | "core_actions"
  | "trials"
  | "payers"
  | "revenue_jpy"
  | "active_end"
  | "spend_jpy"
  | "cpi_jpy"
  | "roas"
  | `gate:${string}`;

/** comparison の指標 */
export const COMPARISON_KEYS = ["installs", "core_actions", "active_end", "payers", "revenue_jpy"] as const;
export type ComparisonKey = (typeof COMPARISON_KEYS)[number];

/** 画面で扱う指標の名前（daily と totals の和） */
export type MetricKey = DailyKey | TotalKey;

export interface ReplayMeta {
  app_id: string;
  name_ja: string;
  period_days: number;
  runs: number;
  population: number;
  scale_to_japan: number;
  generated_at: string;
  /** この日より後は90日までのデータを延ばした推計 */
  extrapolated_after_day: number;
  /** モックのときだけ true（任意項目） */
  is_mock?: boolean;
  /** モックのときだけの注記（任意項目） */
  note_ja?: string;
  /** app.yaml の gates（v1 追補） */
  gates?: { id: string; name_ja: string }[];
}

/** reached は v0 のリプレイにないので省略可 */
export type DailyMetrics = { day: number[] } & { [K in Exclude<DailyKey, "reached">]: Band<number[]> } & {
  reached?: Band<number[]>;
  /** クチコミの内訳（v1 追補）。installs_wom = installs_wom_x（X 上の拡散）+ installs_wom_local（身近な人づて） */
  installs_wom?: Band<number[]>;
  installs_wom_x?: Band<number[]>;
  installs_wom_local?: Band<number[]>;
};
export type DailyCumulative = { [K in CumulativeKey]?: Band<number[]> };
export type TotalMetrics = Partial<Record<TotalKey, Band<number>>>;

/** 契約 v1 の step（impression はイベントにない） */
export type EventStep = "install" | "signup" | `gate:${string}` | "core_action" | "trial" | "pay" | "churn";

/** [person_id, day, step, n]。n = この人が表す約9,680人のうち、その日にその段階へ進んだ人数 */
export type ReplayEvent = [number, number, string, number];

/** plans.X.config = app.yaml の plan（価格の上書きを反映したもの） */
export interface PlanConfig {
  regions?: number[];
  period_days?: number;
  campaign_days?: number;
  target?: { age?: [number, number]; sex?: string; [k: string]: unknown };
  channels?: Record<string, number>;
  creatives?: string[];
  pricing?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface DropReason {
  step: string;
  cluster_id: number;
  share: number;
  reason_ja: string;
}

/** report.json のテーマ（合成時に入る） */
export interface DropTheme {
  theme_ja: string;
  plan: string;
  step: string;
  drop_reason_ids: string[];
  summary_ja: string;
}

export interface PlanResult {
  config: PlanConfig;
  daily: DailyMetrics;
  daily_cumulative: DailyCumulative;
  totals: TotalMetrics;
  /** 回ごとの合計（1万人基準）。比べる指標だけ。古いリプレイにはない */
  per_run?: Partial<Record<string, number[]>>;
  sample_run: { events: ReplayEvent[] };
  drop_reasons: DropReason[];
  drop_themes: DropTheme[];
}

export interface Comparison {
  /** 同じ回どうしの B − A の分位点 */
  B_minus_A: Partial<Record<ComparisonKey, Band<number>>>;
  /** B が A より良い確率（0〜1） */
  p_B_better: Partial<Record<ComparisonKey, number>>;
}

export type CitySize = "metro" | "city" | "town";
/** [person_id, pref_code, city_size, age, sex, cluster_id] */
export type PersonRow = [number, number, CitySize, number, "M" | "F", number];

export interface Cluster {
  cluster_id: number;
  label_ja: string;
  representative: number;
}

export interface Interview {
  person_id: number;
  plan: PlanId;
  qa: { q_ja: string; a_ja: string }[];
}

/**
 * 一人ずつの Claude の判断（任意。Web からの提案）。decisions.json（契約 v2）のうち、
 * 地図で選べる人の分だけをリプレイに入れてもらう想定。ないときは drop_reasons（グループの判断）で代用する。
 */
export interface PersonDecision {
  plan: PlanId;
  person_id: number;
  step: string;
  level: "higher" | "similar" | "lower";
  reason_ja: string;
  creative?: string | null;
}

export interface Replay {
  meta: ReplayMeta;
  plans: Partial<Record<PlanId, PlanResult>>;
  comparison: Comparison | null;
  people: PersonRow[];
  clusters: Cluster[];
  interviews: Interview[];
  report_ja: string;
  /** 合成コマンドが一番外側に置く report.json のテーマ（plans.X.drop_themes がないとき使う） */
  drop_themes?: DropTheme[];
  person_decisions?: PersonDecision[];
  /** 読み込み時に見つけた、表示はできるが契約 v1 と違う点 */
  warnings: string[];
}

/** 読み込みや検証の失敗。画面にそのまま出せる日本語メッセージを持つ */
export class ReplayError extends Error {
  readonly problems: string[];
  constructor(message: string, problems: string[] = []) {
    super(message);
    this.name = "ReplayError";
    this.problems = problems;
  }
}

/** リプレイ ID からファイルの URL を作る（vite の base を考慮） */
export function replayUrl(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new ReplayError(`リプレイ ID に使えない文字があります: 「${id}」`);
  return `${import.meta.env.BASE_URL}replays/${id}.json`;
}

export async function loadReplay(id: string, signal?: AbortSignal): Promise<Replay> {
  const url = replayUrl(id);
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ReplayError(`リプレイを取得できませんでした（${url}）。ネットワークを確認してください。`);
  }
  // 開発サーバーやホスティングによっては、ないファイルに index.html を返すので 404 と同じに扱う
  const isHtml = (res.headers.get("content-type") ?? "").includes("text/html");
  if (!res.ok || isHtml) {
    throw new ReplayError(
      res.status === 404 || isHtml
        ? `リプレイ「${id}」が見つかりません（${url}）。public/replays/ にファイルがあるか確認してください。`
        : `リプレイの取得に失敗しました（HTTP ${res.status}、${url}）。`,
    );
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ReplayError(`リプレイ「${id}」が JSON として読めません。ファイルが壊れています。`);
  }
  return validateReplay(data);
}

// ---- 検証 ----
// problems = 表示できない（エラー）。warnings = 表示はできるが契約 v1 と違う（開発用ページに出す）。

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNumArr = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNum);
const isBandNum = (v: unknown) => isObj(v) && isNum(v.p10) && isNum(v.p50) && isNum(v.p90);

/** 必須の daily 指標（reached は v0 のリプレイにないので警告にとどめる） */
const REQUIRED_DAILY: DailyKey[] = ["impressions", "installs", "signups", "core_actions", "active", "payers", "revenue_jpy"];

export function validateReplay(data: unknown): Replay {
  const problems: string[] = [];
  const warnings: string[] = [];
  const need = (cond: boolean, msg: string) => {
    if (!cond) problems.push(msg);
    return cond;
  };
  const want = (cond: boolean, msg: string) => {
    if (!cond) warnings.push(msg);
    return cond;
  };

  if (!isObj(data)) throw new ReplayError("リプレイの形が正しくありません（一番外側がオブジェクトではない）。");

  const meta = data.meta;
  if (need(isObj(meta), "meta がありません")) {
    const m = meta as Record<string, unknown>;
    for (const k of ["period_days", "runs", "population", "scale_to_japan", "extrapolated_after_day"]) {
      need(isNum(m[k]), `meta.${k} が数値ではありません`);
    }
    for (const k of ["app_id", "name_ja"]) need(typeof m[k] === "string", `meta.${k} が文字列ではありません`);
  }

  const plans = data.plans;
  if (need(isObj(plans), "plans がありません")) {
    const p = plans as Record<string, unknown>;
    const ids = Object.keys(p).filter((k) => k === "A" || k === "B");
    need(ids.length > 0, "plans に A も B もありません");
    for (const id of ids) {
      const plan = p[id];
      if (!need(isObj(plan), `plans.${id} がオブジェクトではありません`)) continue;
      const pl = plan as Record<string, unknown>;

      // daily
      let n = -1;
      const daily = pl.daily;
      if (need(isObj(daily), `plans.${id}.daily がありません`)) {
        const d = daily as Record<string, unknown>;
        n = isNumArr(d.day) ? d.day.length : -1;
        need(n > 0, `plans.${id}.daily.day が数値の配列ではありません`);
        for (const k of DAILY_KEYS) {
          const b = d[k];
          if (b === undefined && !REQUIRED_DAILY.includes(k)) {
            want(false, `plans.${id}.daily.${k} がありません（v1 の項目）`);
            continue;
          }
          checkDailyBand(b, `plans.${id}.daily.${k}`, n, need);
        }
      }

      // daily_cumulative（v1）
      if (want(isObj(pl.daily_cumulative), `plans.${id}.daily_cumulative がありません（累計グラフは出せません）`)) {
        const c = pl.daily_cumulative as Record<string, unknown>;
        for (const k of CUMULATIVE_KEYS) {
          if (c[k] === undefined) want(false, `plans.${id}.daily_cumulative.${k} がありません`);
          else checkDailyBand(c[k], `plans.${id}.daily_cumulative.${k}`, n, need);
        }
      } else pl.daily_cumulative = {};

      // totals
      if (need(isObj(pl.totals), `plans.${id}.totals がありません`)) {
        const t = pl.totals as Record<string, unknown>;
        for (const [k, v] of Object.entries(t)) need(isBandNum(v), `plans.${id}.totals.${k} が {p10, p50, p90} の数値ではありません`);
        for (const k of ["reached", "active_end", "payers", "installs"]) want(k in t, `plans.${id}.totals.${k} がありません`);
      }

      // config（v1）
      if (!want(isObj(pl.config), `plans.${id}.config がありません（地域の強調などは出せません）`)) pl.config = {};

      // sample_run.events: [person_id, day, step, n]。v0 の3要素なら n = 1 とみなす
      const sr = pl.sample_run;
      if (need(isObj(sr) && Array.isArray((sr as Record<string, unknown>).events), `plans.${id}.sample_run.events がありません`)) {
        const ev = (sr as { events: unknown[] }).events;
        const bad = ev.findIndex(
          (e) => !Array.isArray(e) || !isNum(e[0]) || !isNum(e[1]) || typeof e[2] !== "string" || (e.length > 3 && !isNum(e[3])),
        );
        if (need(bad < 0, `plans.${id}.sample_run.events[${bad}] が [person_id, day, step, n] の形ではありません`)) {
          let short = 0;
          for (const e of ev as unknown[][]) {
            if (e.length < 4) {
              e[3] = 1;
              short++;
            }
          }
          want(short === 0, `plans.${id}.sample_run.events の ${short}件に n がありません（1 とみなしました）`);
        }
      }
      if (!Array.isArray(pl.drop_reasons)) pl.drop_reasons = [];
      if (!Array.isArray(pl.drop_themes)) pl.drop_themes = [];
    }
  }

  // comparison（v1）
  if (data.comparison !== undefined && data.comparison !== null) {
    const c = data.comparison;
    if (need(isObj(c) && isObj(c.B_minus_A) && isObj(c.p_B_better), "comparison が {B_minus_A, p_B_better} の形ではありません")) {
      const cc = c as { B_minus_A: Record<string, unknown>; p_B_better: Record<string, unknown> };
      for (const [k, v] of Object.entries(cc.B_minus_A)) need(isBandNum(v), `comparison.B_minus_A.${k} が {p10, p50, p90} ではありません`);
      for (const [k, v] of Object.entries(cc.p_B_better)) need(isNum(v) && v >= 0 && v <= 1, `comparison.p_B_better.${k} が 0〜1 の数値ではありません`);
    }
  } else {
    want(false, "comparison がありません（A/B の差は出せません）");
    data.comparison = null;
  }

  if (need(Array.isArray(data.people), "people がありません")) {
    const people = data.people as unknown[];
    const bad = people.findIndex((r) => !Array.isArray(r) || !isNum(r[0]) || !isNum(r[1]) || r[1] < 1 || r[1] > 47);
    need(bad < 0, `people[${bad}] が [person_id, pref_code(1〜47), city_size, age, sex, cluster_id] の形ではありません`);
  }

  // 任意扱いにしておくもの（ないときは空で補う）
  if (!Array.isArray(data.clusters)) data.clusters = [];
  if (!Array.isArray(data.interviews)) data.interviews = [];
  if (typeof data.report_ja !== "string") data.report_ja = "";
  if (!Array.isArray(data.drop_themes)) data.drop_themes = [];
  if (!Array.isArray(data.person_decisions)) data.person_decisions = [];

  if (problems.length > 0) {
    throw new ReplayError(`リプレイの形が契約（§4・v1 追補）と合いません（${problems.length}件）。`, problems.slice(0, 20));
  }
  data.warnings = warnings;
  return data as unknown as Replay;
}

function checkDailyBand(b: unknown, path: string, n: number, need: (c: boolean, m: string) => boolean) {
  if (!need(isObj(b), `${path} がありません`)) return;
  for (const q of ["p10", "p50", "p90"] as const) {
    const arr = (b as Record<string, unknown>)[q];
    if (need(isNumArr(arr), `${path}.${q} が数値の配列ではありません`) && n > 0) {
      need((arr as number[]).length === n, `${path}.${q} の長さ（${(arr as number[]).length}）が day（${n}）と違います`);
    }
  }
}

export function planIds(replay: Replay): PlanId[] {
  return (["A", "B"] as const).filter((id) => replay.plans[id]);
}
