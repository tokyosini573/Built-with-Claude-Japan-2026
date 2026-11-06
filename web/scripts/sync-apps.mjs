// apps/<app_id>/ の画面と広告素材を web/public/apps/<app_id>/ に写し、app.yaml から app.json を作る。
// 入力画面（#/input）が読む。apps/ はメインの担当なので、ここでは読むだけ。
//
// 使い方: node scripts/sync-apps.mjs [app_id ...]（省略時は apps/ の全部）
// app.yaml の読み込みにはリポジトリの .venv（PyYAML）を使う。

import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const appsDir = resolve(repo, "apps");
const outRoot = resolve(here, "../public/apps");

const SCREEN_LABELS = ["はじめの画面", "プロフィール作成", "本人確認", "近くのおすすめ", "有料プラン"];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function readYaml(path) {
  const py = resolve(repo, ".venv/bin/python");
  const out = execFileSync(py, ["-c", "import sys, json, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding='utf-8')), ensure_ascii=False))", path]);
  return JSON.parse(out.toString("utf-8"));
}

const ids = process.argv.slice(2).length ? process.argv.slice(2) : (await readdir(appsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);

for (const id of ids) {
  const src = resolve(appsDir, id);
  const out = resolve(outRoot, id);
  await mkdir(out, { recursive: true });
  for (const sub of ["screens", "ads"]) {
    if (await exists(resolve(src, sub))) await cp(resolve(src, sub), resolve(out, sub), { recursive: true });
  }
  const yamlPath = resolve(src, "app.yaml");
  if (await exists(yamlPath)) {
    const app = readYaml(yamlPath);
    const creatives = {};
    for (const plan of Object.values(app.plans ?? {})) {
      for (const c of plan.creatives ?? []) creatives[c.replace(/^.*\//, "").replace(/\.[a-z]+$/i, "")] = c;
    }
    const manifest = {
      app_id: app.app_id,
      name_ja: app.name_ja,
      description_ja: app.description_ja,
      screens: (app.screens ?? []).map((s, i) => ({ src: s, label_ja: SCREEN_LABELS[i] ?? `画面${i + 1}` })),
      gates: app.gates ?? [],
      pricing: app.pricing ?? {},
      creatives,
    };
    await writeFile(resolve(out, "app.json"), JSON.stringify(manifest, null, 1) + "\n");
  }
  console.log(`写しました: apps/${id} → public/apps/${id}`);
}
