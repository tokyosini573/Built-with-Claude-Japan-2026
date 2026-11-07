// トップのヒーロー図（点でできた日本地図）用に、リプレイから小さなファイルを2つ作る。
// リプレイ本体（約11MB）をトップで読まないため。
//
// 使い方: node scripts/build-hero-people.mjs [app_id]（既定 demo_matching）
// 入力: public/replays/<app_id>.json の people・meta・plans.A.sample_run.events
// 出力:
//   public/hero/people.json（約30KB）
//     { app_id, generated_at, population, scale_to_japan, pref: [person_id 0 の pref_code, 1 の pref_code, ...] }
//   public/hero/regions.json（再生の終わりに出す、地方別の割合）
//     A案の sample_run.events（[person_id, day, step, n]。n はその人が表す約9,681人のうち進んだ人数）を
//     8地方ごとに合計し、全国の合計のうち各地方が占める割合（整数の%）にする。
//     インストール = install の n、課金した = pay の n、
//     使い続けている = 期間の終わりに使っている人 = install − churn
//     （teppuri/engine/sample.py では churn は設置して使っている人からしか出ない）。
//     丸めの差は最大剰余法で調整し、合計を100にそろえる。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appId = process.argv[2] ?? "demo_matching";
const src = resolve(here, `../public/replays/${appId}.json`);
const out = resolve(here, "../public/hero/people.json");
const outRegions = resolve(here, "../public/hero/regions.json");

const replay = JSON.parse(await readFile(src, "utf8"));
const people = replay.people;
if (!Array.isArray(people) || people.length === 0) throw new Error(`${src} に people がありません`);

// person_id の順に並べる（契約 §4 の people = [person_id, pref_code, ...]）
const pref = new Array(people.length).fill(0);
for (const row of people) {
  const [id, code] = row;
  if (!Number.isInteger(id) || id < 0 || id >= people.length) throw new Error(`person_id が範囲外です: ${id}`);
  if (!Number.isInteger(code) || code < 1 || code > 47) throw new Error(`pref_code が範囲外です: person_id ${id} → ${code}`);
  pref[id] = code;
}

const result = {
  app_id: replay.meta.app_id,
  generated_at: replay.meta.generated_at,
  population: replay.meta.population,
  scale_to_japan: replay.meta.scale_to_japan,
  pref,
};

await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(result) + "\n");
console.log(`${out} を書きました（${people.length}人、${(JSON.stringify(result).length / 1024).toFixed(0)}KB）`);

// ---- 地方別の割合（A案の1回分の結果） ----

// 8地方。都道府県コード（JIS）で分ける
const REGIONS = [
  { id: "hokkaido", name_ja: "北海道", prefs: [1] },
  { id: "tohoku", name_ja: "東北", prefs: [2, 3, 4, 5, 6, 7] },
  { id: "kanto", name_ja: "関東", prefs: [8, 9, 10, 11, 12, 13, 14] },
  { id: "chubu", name_ja: "中部", prefs: [15, 16, 17, 18, 19, 20, 21, 22, 23] },
  { id: "kinki", name_ja: "近畿", prefs: [24, 25, 26, 27, 28, 29, 30] },
  { id: "chugoku", name_ja: "中国", prefs: [31, 32, 33, 34, 35] },
  { id: "shikoku", name_ja: "四国", prefs: [36, 37, 38, 39] },
  { id: "kyushu", name_ja: "九州・沖縄", prefs: [40, 41, 42, 43, 44, 45, 46, 47] },
];
const regionOfPref = new Map(REGIONS.flatMap((r, ri) => r.prefs.map((p) => [p, ri])));

const PLAN = "A";
const events = replay.plans?.[PLAN]?.sample_run?.events;
if (!Array.isArray(events) || events.length === 0) throw new Error(`${src} に plans.${PLAN}.sample_run.events がありません`);

// 1人ずつ install・churn・pay を足してから地方に集める
const inst = new Array(people.length).fill(0);
const churn = new Array(people.length).fill(0);
const pay = new Array(people.length).fill(0);
for (const [id, , step, n] of events) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`events の人数が不正です: ${id} ${step} ${n}`);
  if (step === "install") inst[id] += n;
  else if (step === "churn") churn[id] += n;
  else if (step === "pay") pay[id] += n;
}
const sums = REGIONS.map(() => ({ install: 0, active: 0, pay: 0 }));
for (let id = 0; id < people.length; id++) {
  if (churn[id] > inst[id]) throw new Error(`person_id ${id} の churn（${churn[id]}）が install（${inst[id]}）より多い`);
  const s = sums[regionOfPref.get(pref[id])];
  s.install += inst[id];
  s.active += inst[id] - churn[id];
  s.pay += pay[id];
}

/** 合計100になる整数の%（最大剰余法） */
function shares(values) {
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return values.map(() => 0);
  const raw = values.map((v) => (v / total) * 100);
  const res = raw.map(Math.floor);
  let left = 100 - res.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    res[i]++;
    left--;
  }
  return res;
}

const KEYS = ["install", "active", "pay"];
const pct = Object.fromEntries(KEYS.map((k) => [k, shares(sums.map((s) => s[k]))]));
const totals = Object.fromEntries(KEYS.map((k) => [k, sums.reduce((a, s) => a + s[k], 0)]));
for (const k of KEYS) {
  const t = pct[k].reduce((a, b) => a + b, 0);
  if (totals[k] > 0 && t !== 100) throw new Error(`${k} の割合の合計が ${t}% です`);
}

const regions = {
  app_id: replay.meta.app_id,
  name_ja: replay.meta.name_ja,
  generated_at: replay.meta.generated_at,
  plan: PLAN,
  period_days: replay.meta.period_days,
  note: "sample_run の1回分。*_pct は全国の合計のうち、その地方が占める割合（%）。*_n は実際の人数に換算した値",
  totals,
  regions: REGIONS.map((r, i) => ({
    id: r.id,
    name_ja: r.name_ja,
    prefs: r.prefs,
    install_pct: pct.install[i],
    active_pct: pct.active[i],
    pay_pct: pct.pay[i],
    install_n: sums[i].install,
    active_n: sums[i].active,
    pay_n: sums[i].pay,
  })),
};

await writeFile(outRegions, JSON.stringify(regions) + "\n");
console.log(
  `${outRegions} を書きました（${PLAN}案、全国の合計 インストール ${totals.install}・使い続けている ${totals.active}・課金した ${totals.pay}）`,
);
for (const r of regions.regions) {
  console.log(`  ${r.name_ja}\tインストール ${r.install_pct}%\t使い続けている ${r.active_pct}%\t課金した ${r.pay_pct}%`);
}
