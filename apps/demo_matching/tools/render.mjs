// src/ の HTML をヘッドレスブラウザで撮影して PNG にする。
// 使い方: cd apps/demo_matching/tools && npm install && npx playwright install chromium && npm run render
// アプリ名は src/brand.js だけで変える。app.yaml の name_ja もここで同じ値に書き換える。
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 出力先: [HTML, PNG, CSS 幅, CSS 高さ, 倍率]
const JOBS = [
  // 画面（CSS 390×844 × 3倍 = 1170×2532）
  ["src/screens/01_start.html", "screens/01.png", 390, 844, 3],
  ["src/screens/02_profile.html", "screens/02.png", 390, 844, 3],
  ["src/screens/03_verify.html", "screens/03.png", 390, 844, 3],
  ["src/screens/04_nearby.html", "screens/04.png", 390, 844, 3],
  ["src/screens/05_plan.html", "screens/05.png", 390, 844, 3],
  // A案: 全国 SNS（縦型）
  ["src/ads/a1.html", "ads/a1.png", 540, 960, 2],   // TikTok 9:16 → 1080×1920
  ["src/ads/a2.html", "ads/a2.png", 540, 960, 2],   // Instagram ストーリーズ・リール 9:16
  ["src/ads/a3.html", "ads/a3.png", 540, 675, 2],   // X 縦 4:5 → 1080×1350
  // B案: 首都圏の電車広告 + SNS
  ["src/ads/b1.html", "ads/b1.png", 728, 515, 2],   // 中づり B3横 → 1456×1030
  ["src/ads/b2.html", "ads/b2.png", 960, 540, 2],   // 車内ビジョン 16:9 → 1920×1080
  ["src/ads/b3.html", "ads/b3.png", 540, 675, 2],   // Instagram フィード 4:5 → 1080×1350
  // 短尺動画の見本（絵コンテ1枚、オーガニック投稿用）
  ["src/ads/v1.html", "ads/v1.png", 540, 960, 2],
  ["src/ads/v2.html", "ads/v2.png", 540, 960, 2],
  ["src/ads/v3.html", "ads/v3.png", 540, 960, 2],
];

const only = process.argv.slice(2);
const browser = await chromium.launch();
for (const [src, out, w, h, scale] of JOBS) {
  if (only.length && !only.some((o) => src.includes(o))) continue;
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
  await page.goto(pathToFileURL(resolve(ROOT, src)).href, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__ready === true);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(ROOT, out), clip: { x: 0, y: 0, width: w, height: h } });
  await page.close();
  console.log(`${out}  (${w * scale}×${h * scale})`);
}
await browser.close();

// app.yaml の先頭の name_ja を brand.js の値にそろえる
const brandSrc = readFileSync(resolve(ROOT, "src/brand.js"), "utf8");
const brand = JSON.parse(brandSrc.slice(brandSrc.indexOf("{"), brandSrc.lastIndexOf("}") + 1));
const yamlPath = resolve(ROOT, "app.yaml");
try {
  const y = readFileSync(yamlPath, "utf8");
  const y2 = y.replace(/^name_ja: .*$/m, `name_ja: ${brand.name_ja}`);
  if (y2 !== y) { writeFileSync(yamlPath, y2); console.log(`app.yaml name_ja → ${brand.name_ja}`); }
} catch { /* app.yaml がまだないときは何もしない */ }
