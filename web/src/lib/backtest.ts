// バックテスト結果（public/backtest.json）の型と読み込み。
// 形はバックテスト担当と後で合わせる。足りない項目は画面で「—」にする。

import { BACKTEST_PATH } from "../config";

export interface BacktestQuestion {
  q_id: string;
  q_ja: string;
  /** テプリが出した「はい」の確率（30回のうち「はい」になった割合） */
  p_yes: number;
  /** 実際の答え。まだ入れていなければ null */
  answer: boolean | null;
  /** 実際の答えの出典 */
  source_ja?: string;
  source_url?: string;
}

export interface BacktestCase {
  case_id: string;
  /** 匿名の事例名（アプリ名は出さない） */
  title_ja: string;
  description_ja: string;
  /** 予測のあとに「このアプリが何か分かるか」を聞いて、分かったと答えた事例 */
  recognized?: boolean;
  questions: BacktestQuestion[];
}

export interface BacktestBaseline {
  id: string;
  name_ja: string;
  hits: number;
  brier?: number;
}

export interface Backtest {
  is_mock?: boolean;
  note_ja?: string;
  /** 予測を記録したコミット（後から答えを足した証拠） */
  prediction_commit?: string;
  baselines: BacktestBaseline[];
  cases: BacktestCase[];
}

export interface QuestionResult extends BacktestQuestion {
  predicted: boolean;
  hit: boolean | null;
}

export function judge(q: BacktestQuestion): QuestionResult {
  const predicted = q.p_yes >= 0.5;
  return { ...q, predicted, hit: q.answer === null ? null : predicted === q.answer };
}

export function summarize(bt: Backtest) {
  const all = bt.cases.flatMap((c) => c.questions.map(judge));
  const answered = all.filter((q) => q.hit !== null);
  const hits = answered.filter((q) => q.hit).length;
  const brier = answered.length
    ? answered.reduce((s, q) => s + (q.p_yes - (q.answer ? 1 : 0)) ** 2, 0) / answered.length
    : null;
  return { total: all.length, answered: answered.length, hits, brier };
}

export async function loadBacktest(signal?: AbortSignal): Promise<Backtest> {
  const res = await fetch(`${import.meta.env.BASE_URL}${BACKTEST_PATH}`, { signal });
  const isHtml = (res.headers.get("content-type") ?? "").includes("text/html");
  if (!res.ok || isHtml) throw new Error("バックテストの結果がまだありません。");
  const data = (await res.json()) as Backtest;
  if (!Array.isArray(data.cases)) throw new Error("バックテストの結果の形が正しくありません（cases がない）。");
  if (!Array.isArray(data.baselines)) data.baselines = [];
  return data;
}
