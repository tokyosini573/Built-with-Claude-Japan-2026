// 開発用のモックリプレイ（契約 v1 の形）を作る。エンジンが本物を出すまで画面の確認に使う。
// 数字に根拠はない（契約 §4 の形に合わせただけ）。meta.is_mock = true で明示する。
//
// 使い方: node scripts/make-mock-replay.mjs [出力パス]
// 既定の出力: public/replays/mock.json

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.argv[2] ?? resolve(here, "../public/replays/mock.json"));

const POPULATION = 10000;
const RUNS = 30;
const PERIOD = 180;
const EXTRAPOLATED_AFTER = 90;
const SCALE_TO_JAPAN = 96806585 / POPULATION; // 契約 §1 の weight 合計 / 1万人
const MONTHLY_JPY = 3900;

// ---- 決定的な乱数 ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 架空の1万人 ----
// 都道府県の比率はモック用のおおよその値（本物は人口担当の data/population/japan_10k.csv）
const PREF_WEIGHT = [
  51, 12, 12, 23, 9, 10, 18, 28, 19, 19, 73, 63, 140, 92, 22, 10, 11, 8, 8, 20, 20,
  36, 75, 18, 14, 26, 88, 54, 13, 9, 5, 7, 19, 28, 13, 7, 9, 13, 7, 51, 8, 13, 17,
  11, 11, 16, 15,
];
const METRO_SHARE = { 13: 0.9, 14: 0.7, 27: 0.7, 23: 0.5, 1: 0.4, 26: 0.5, 28: 0.4, 40: 0.45, 11: 0.35, 12: 0.35, 4: 0.45, 34: 0.4, 22: 0.3, 33: 0.3, 43: 0.4, 15: 0.3 };

const rnd = mulberry32(20261108);
function pickWeighted(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (let i = 0; i < weights.length; i++) if ((r -= weights[i]) < 0) return i;
  return weights.length - 1;
}

const AGE_BANDS = [[15, 19], [20, 24], [25, 29], [30, 34], [35, 39], [40, 49], [50, 59], [60, 69], [70, 79]];
const AGE_BAND_WEIGHT = [5, 6, 6, 7, 7, 17, 17, 16, 19];
const CITY_SIZES = ["metro", "city", "town"];
const CITY_JA = { metro: "大都市", city: "地方都市", town: "町村" };

const people = [];
for (let id = 0; id < POPULATION; id++) {
  const pref = pickWeighted(PREF_WEIGHT) + 1;
  const metro = METRO_SHARE[pref] ?? 0.1;
  const r = rnd();
  const city = r < metro ? "metro" : r < metro + (1 - metro) * 0.75 ? "city" : "town";
  const band = pickWeighted(AGE_BAND_WEIGHT);
  const [lo, hi] = AGE_BANDS[band];
  const age = lo + Math.floor(rnd() * (hi - lo + 1));
  const sex = rnd() < 0.5 ? "M" : "F";
  // クラスタ = 年齢帯 × 性別 × 都市規模（モック）
  const cluster = band * 6 + (sex === "M" ? 0 : 3) + CITY_SIZES.indexOf(city);
  people.push([id, pref, city, age, sex, cluster]);
}

const clusterMap = new Map();
for (const p of people) {
  if (!clusterMap.has(p[5])) {
    const band = Math.floor(p[5] / 6);
    const [lo, hi] = AGE_BANDS[band];
    clusterMap.set(p[5], {
      cluster_id: p[5],
      label_ja: `${lo}〜${hi}歳・${p[4] === "M" ? "男性" : "女性"}・${CITY_JA[p[2]]}（モック）`,
      representative: p[0],
    });
  }
}
const clusters = [...clusterMap.values()].sort((a, b) => a.cluster_id - b.cluster_id);

// ---- 実験（モック） ----
// config は app.yaml の plan の形（契約 v1: plans.X.config）。sim はモック計算だけで使う値
const PLANS = {
  A: {
    config: {
      regions: [11, 12, 13, 14],
      period_days: PERIOD,
      campaign_days: 30,
      target: { age: [18, 44], sex: "any" },
      channels: { instagram: 3000000, tiktok: 2000000 },
      creatives: ["a1", "a2"],
      pricing: { monthly_jpy: MONTHLY_JPY, free_trial_days: 0, who_pays: "male" },
    },
    sim: { reachPerDay: 0.06, install: 0.14 },
  },
  B: {
    config: {
      regions: [],
      period_days: PERIOD,
      campaign_days: 60,
      target: { age: [18, 49], sex: "any" },
      channels: { youtube: 2500000, line: 2500000 },
      creatives: ["b1"],
      pricing: { monthly_jpy: MONTHLY_JPY, free_trial_days: 7, who_pays: "male" },
    },
    sim: { reachPerDay: 0.02, install: 0.1 },
  },
};

const DAILY_KEYS = ["impressions", "reached", "installs", "installs_ad", "installs_wom", "installs_wom_x", "installs_wom_local", "signups", "gate", "core_actions", "trials", "active", "payers", "revenue_jpy", "spend_jpy"];

/** 1回分の実行。events を記録するかは recordEvents で切り替え */
function simulate({ config, sim }, seed, recordEvents) {
  const r = mulberry32(seed);
  // 実行ごとに倍率をゆらす（30回の幅を作るため）
  const jitter = () => 0.8 + r() * 0.4;
  const pInstall = sim.install * jitter();
  const pSignup = 0.62 * jitter();
  const pGate = 0.72 * jitter();
  const pCoreDaily = 0.09 * jitter();
  const churnDaily = 0.012 * jitter();
  const pPay = 0.1 * jitter();
  const pTrialToPay = 0.45 * jitter();
  const wom = 0.0000006 * jitter();
  const cpi = 1800 * jitter(); // モックの広告費は「広告経由インストール × 単価」で作る
  const trialDays = config.pricing.free_trial_days;
  const [ageLo, ageHi] = config.target.age;

  const daily = {};
  for (const k of DAILY_KEYS) daily[k] = new Array(PERIOD).fill(0);
  const events = [];
  // n = このグループ（約9,680人）のうち進んだ人数（モックは適当な整数）
  const ev = (pid, day, step) => recordEvents && events.push([pid, day, step, 1 + Math.floor(r() ** 3 * 60)]);

  // 状態: 0 未接触, 1 広告が届いた, 2 インストール, 3 登録, 4 関門通過, 5 核心行動, 6 無料体験中, 9 離脱
  const state = new Uint8Array(POPULATION);
  const since = new Int16Array(POPULATION);
  const paying = new Uint8Array(POPULATION);
  const eligible = people.map(([, pref, , age]) => {
    const inRegion = config.regions.length === 0 || config.regions.includes(pref);
    return inRegion && age >= 18 && age >= ageLo && age <= ageHi;
  });
  let activeCount = 0;
  const churn = (i, day) => {
    if (state[i] >= 3) activeCount--;
    state[i] = 9;
    paying[i] = 0;
    ev(i, day, "churn");
  };

  for (let day = 1; day <= PERIOD; day++) {
    const di = day - 1;
    for (let i = 0; i < POPULATION; i++) {
      const s = state[i];
      if (s === 0 || s === 1) {
        let installed = false;
        if (day <= config.campaign_days && eligible[i] && r() < sim.reachPerDay) {
          if (s === 0) { state[i] = 1; daily.reached[di]++; }
          daily.impressions[di] += 1 + Math.floor(r() * 3);
          if (r() < pInstall) { installed = true; daily.installs_ad[di]++; }
        }
        // 口コミ: 継続中の人数に比例して広告なしでインストール
        if (!installed && people[i][3] >= 18 && r() < wom * activeCount) {
          installed = true;
          daily.installs_wom[di]++;
          // クチコミの内訳（モック）: 若い人ほど X 経由が多い
          if (r() < (people[i][3] < 30 ? 0.6 : 0.3)) daily.installs_wom_x[di]++;
          else daily.installs_wom_local[di]++;
        }
        if (installed) { state[i] = 2; since[i] = day; ev(i, day, "install"); daily.installs[di]++; }
        continue;
      }
      if (s === 9) continue;
      const age = day - since[i];
      if (s === 2) {
        if (age > 2) continue;
        if (r() < pSignup / 2) { state[i] = 3; since[i] = day; ev(i, day, "signup"); daily.signups[di]++; activeCount++; }
        else if (age === 2) churn(i, day);
        continue;
      }
      // 本人確認の審査（1日）
      if (s === 3 && age >= 1) {
        if (r() < pGate) { state[i] = 4; since[i] = day; ev(i, day, "gate:id_verification"); daily.gate[di]++; }
        else churn(i, day);
        continue;
      }
      if (s === 4) {
        const metroBoost = people[i][2] === "metro" ? 1.4 : people[i][2] === "city" ? 1 : 0.6;
        if (r() < pCoreDaily * metroBoost) { state[i] = 5; since[i] = day; ev(i, day, "core_action"); daily.core_actions[di]++; }
        else if (r() < churnDaily * 1.5) churn(i, day);
        continue;
      }
      if (s === 5) {
        const payer = people[i][4] === "M";
        if (!paying[i] && payer && r() < pPay / 7) {
          if (trialDays > 0) { state[i] = 6; since[i] = day; ev(i, day, "trial"); daily.trials[di]++; }
          else { paying[i] = 1; ev(i, day, "pay"); daily.payers[di]++; }
        } else if (r() < churnDaily * (paying[i] ? 0.5 : 1)) churn(i, day);
        continue;
      }
      if (s === 6 && age >= trialDays) {
        if (r() < pTrialToPay) { state[i] = 5; paying[i] = 1; ev(i, day, "pay"); daily.payers[di]++; }
        else churn(i, day);
      }
    }
    daily.active[di] = activeCount;
    daily.spend_jpy[di] = Math.round(daily.installs_ad[di] * cpi);
    let payingNow = 0;
    for (let i = 0; i < POPULATION; i++) payingNow += paying[i];
    daily.revenue_jpy[di] = Math.round((payingNow * MONTHLY_JPY) / 30);
  }
  return { daily, events };
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const sig = (v) => Number(Number(v).toPrecision(4));

function bands(values) {
  const s = [...values].sort((a, b) => a - b);
  return { p10: sig(quantile(s, 0.1)), p50: sig(quantile(s, 0.5)), p90: sig(quantile(s, 0.9)) };
}
function dailyBands(rows) {
  const b = { p10: [], p50: [], p90: [] };
  for (let d = 0; d < PERIOD; d++) {
    const q = bands(rows.map((row) => row[d]));
    b.p10.push(q.p10); b.p50.push(q.p50); b.p90.push(q.p90);
  }
  return b;
}
const sum = (a) => a.reduce((x, y) => x + y, 0);
const cumsum = (a) => { let s = 0; return a.map((v) => (s += v)); };

/** 1回分の合計（契約 v1 の totals の定義どおり） */
function runTotals(run) {
  const d = run.daily;
  const t = {
    impressions: sum(d.impressions),
    reached: sum(d.reached),
    installs: sum(d.installs),
    installs_ad: sum(d.installs_ad),
    installs_wom: sum(d.installs_wom),
    installs_wom_x: sum(d.installs_wom_x),
    installs_wom_local: sum(d.installs_wom_local),
    signups: sum(d.signups),
    "gate:id_verification": sum(d.gate),
    core_actions: sum(d.core_actions),
    trials: sum(d.trials),
    payers: sum(d.payers), // モックでは1人1回しか決済しないので、新規決済の合計 = 一度でも決済した人数
    revenue_jpy: sum(d.revenue_jpy),
    active_end: d.active[PERIOD - 1],
    spend_jpy: sum(d.spend_jpy),
  };
  t.cpi_jpy = t.installs > 0 ? t.spend_jpy / t.installs : 0;
  t.roas = t.spend_jpy > 0 ? t.revenue_jpy / t.spend_jpy : 0;
  return t;
}

const OUT_DAILY = ["impressions", "reached", "installs", "installs_wom", "installs_wom_x", "installs_wom_local", "signups", "core_actions", "active", "payers", "revenue_jpy"];
const CUMULATIVE = ["installs", "payers", "revenue_jpy"];
const COMPARISON = ["installs", "payers", "revenue_jpy", "active_end", "core_actions"];

const plansOut = {};
const runTotalsByPlan = {};
let planSeed = 1000;
for (const [id, plan] of Object.entries(PLANS)) {
  const runs = [];
  for (let k = 0; k < RUNS; k++) runs.push(simulate(plan, planSeed + k, false));
  const daily = { day: Array.from({ length: PERIOD }, (_, i) => i + 1) };
  for (const key of OUT_DAILY) daily[key] = dailyBands(runs.map((r) => r.daily[key]));
  // 累計: 回ごとに累計してから分位点を取る
  const daily_cumulative = {};
  for (const key of CUMULATIVE) daily_cumulative[key] = dailyBands(runs.map((r) => cumsum(r.daily[key])));

  const perRun = runs.map(runTotals);
  runTotalsByPlan[id] = perRun;
  const totals = {};
  for (const key of Object.keys(perRun[0])) {
    if (key === "trials" && plan.config.pricing.free_trial_days === 0) continue;
    totals[key] = bands(perRun.map((t) => t[key]));
  }

  // 地図用の1回: インストール合計が中央値に近い実行と同じシードで、イベント付きでやり直す
  const median = totals.installs.p50;
  let best = 0;
  perRun.forEach((t, k) => {
    if (Math.abs(t.installs - median) < Math.abs(perRun[best].installs - median)) best = k;
  });
  const sample = simulate(plan, planSeed + best, true);

  plansOut[id] = {
    config: plan.config,
    daily,
    daily_cumulative,
    totals,
    sample_run: { events: sample.events },
    drop_reasons: [
      { step: "gate:id_verification", cluster_id: 13, share: 0.22, reason_ja: "（モック）本人確認の書類を出すのが面倒" },
      { step: "signup", cluster_id: 7, share: 0.15, reason_ja: "（モック）電話番号の登録に抵抗がある" },
      { step: "core_action", cluster_id: 20, share: 0.12, reason_ja: "（モック）近くに相手が少なかった" },
    ],
    drop_themes: [
      { theme_ja: "（モック）登録の手間", plan: id, step: "gate:id_verification", drop_reason_ids: [`${id}.dr0`, `${id}.dr1`], summary_ja: "（モック）書類と電話番号の手間で離れる人が多い。" },
      { theme_ja: "（モック）相手の少なさ", plan: id, step: "core_action", drop_reason_ids: [`${id}.dr2`], summary_ja: "（モック）地方では近くに相手が見つからない。" },
    ],
  };
  planSeed += 1000;
}

// 比較: 同じ回どうしの B − A
const comparison = { B_minus_A: {}, p_B_better: {} };
for (const key of COMPARISON) {
  const diffs = runTotalsByPlan.B.map((t, k) => t[key] - runTotalsByPlan.A[k][key]);
  comparison.B_minus_A[key] = bands(diffs);
  comparison.p_B_better[key] = sig(diffs.reduce((s, d) => s + (d > 0 ? 1 : d === 0 ? 0.5 : 0), 0) / diffs.length);
}

const replay = {
  meta: {
    app_id: "mock",
    name_ja: "モックアプリ（開発用）",
    period_days: PERIOD,
    runs: RUNS,
    population: POPULATION,
    scale_to_japan: SCALE_TO_JAPAN,
    generated_at: "2026-11-06T00:00:00+09:00",
    extrapolated_after_day: EXTRAPOLATED_AFTER,
    is_mock: true,
    note_ja: "これは画面確認用のモックです。数字に根拠はありません（web/scripts/make-mock-replay.mjs）。",
  },
  plans: plansOut,
  comparison,
  people,
  clusters,
  interviews: [
    {
      person_id: clusters[8].representative,
      plan: "A",
      qa: [
        { q_ja: "（モック）なぜインストールしましたか？", a_ja: "（モック）友だちが使っていると聞いたからです。" },
        { q_ja: "（モック）本人確認はどう感じましたか？", a_ja: "（モック）少し面倒でしたが、安心感はありました。" },
      ],
    },
  ],
  report_ja: "（モック）A案は首都圏に絞ったため早く伸び、B案は全国で長く伸びました。数字はモックです。",
};

await mkdir(dirname(OUT), { recursive: true });
const json = JSON.stringify(replay);
await writeFile(OUT, json);
const evCount = Object.values(plansOut).map((p) => p.sample_run.events.length).join(" / ");
console.log(`書き出し: ${OUT} (${(json.length / 1024).toFixed(0)} KB, イベント A/B = ${evCount})`);
for (const [id, p] of Object.entries(plansOut)) {
  console.log(id, Object.fromEntries(Object.entries(p.totals).map(([k, v]) => [k, v.p50])));
}
console.log("p_B_better", comparison.p_B_better);
