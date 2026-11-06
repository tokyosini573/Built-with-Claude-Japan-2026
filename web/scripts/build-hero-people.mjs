// トップのヒーロー図（点でできた日本地図）用に、リプレイから「1万人の都道府県」だけを抜き出す。
// リプレイ本体（約11MB）をトップで読まないための小さなファイル（約30KB）。
//
// 使い方: node scripts/build-hero-people.mjs [app_id]（既定 demo_matching）
// 入力: public/replays/<app_id>.json の people と meta
// 出力: public/hero/people.json
//   { app_id, generated_at, population, scale_to_japan, pref: [person_id 0 の pref_code, 1 の pref_code, ...] }

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appId = process.argv[2] ?? "demo_matching";
const src = resolve(here, `../public/replays/${appId}.json`);
const out = resolve(here, "../public/hero/people.json");

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
