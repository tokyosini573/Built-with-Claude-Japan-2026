// 都道府県の境界データを作るスクリプト。
// 元データ: スマートニュース メディア研究所「japan-topography」の prefectures.json（簡素化1%、TopoJSON）
//   = 国土交通省 国土数値情報（行政区域 N03、令和3年）を加工したもの。出典とライセンスは ATTRIBUTION.md。
// ここでさらに線を間引き、小さな島を落とし、座標を丸めて軽くする。
//
// 使い方:
//   node scripts/build-japan-map.mjs              # 固定コミットの URL から取得
//   node scripts/build-japan-map.mjs <path.json>  # 手元の TopoJSON を使う
// 出力: public/geo/japan-prefectures.json

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../public/geo/japan-prefectures.json");
const SOURCE_COMMIT = "b403e71eb97f1fdf32f63d16bd485129f703855e";
const SOURCE_URL = `https://raw.githubusercontent.com/smartnews-smri/japan-topography/${SOURCE_COMMIT}/data/municipality/topojson/s0010/prefectures.json`;

// 間引きの許容誤差（度）。0.006度 ≈ 600m
const TOLERANCE = 0.006;
// これより小さい島（度^2）は落とす。ただし県内で最大のポリゴンは必ず残す
const MIN_AREA = 0.0008;

// JIS 都道府県コード順
const PREF_NAMES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
  "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

async function loadTopology() {
  const arg = process.argv[2];
  if (arg) return JSON.parse(await readFile(arg, "utf8"));
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`取得に失敗しました: ${res.status} ${SOURCE_URL}`);
  return res.json();
}

// TopoJSON の arc をデルタ復号して経緯度にする
function decodeArcs(topo) {
  const [sx, sy] = topo.transform?.scale ?? [1, 1];
  const [tx, ty] = topo.transform?.translate ?? [0, 0];
  return topo.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => {
      if (topo.transform) { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; }
      return [dx, dy];
    });
  });
}

// Douglas-Peucker（端点は残すので、隣の県と共有する境界はずれない）
function simplify(points, tol) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a], [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      let d;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else d = Math.abs(dy * px - dx * py + bx * ay - by * ax) / Math.sqrt(len2);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

function ringFromArcs(arcIdx, arcs) {
  const ring = [];
  for (const i of arcIdx) {
    const a = i >= 0 ? arcs[i] : arcs[~i].slice().reverse();
    a.forEach((p, k) => { if (k > 0 || ring.length === 0) ring.push(p); });
  }
  return ring;
}

function ringArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return Math.abs(s / 2);
}

const round = (v) => Math.round(v * 1000) / 1000;

const topo = await loadTopology();
const object = Object.values(topo.objects)[0];
const arcs = decodeArcs(topo).map((a) => simplify(a, TOLERANCE));

const prefs = object.geometries.map((g) => {
  const name = g.properties?.N03_001;
  const code = PREF_NAMES.indexOf(name) + 1;
  if (code === 0) throw new Error(`未知の都道府県名: ${name}`);
  const polygons = g.type === "Polygon" ? [g.arcs] : g.type === "MultiPolygon" ? g.arcs : [];
  // ポリゴン = [外周, 穴...]
  let polys = polygons.map((rings) => rings.map((r) => ringFromArcs(r, arcs)));
  // 小笠原など遠い島は地図の外枠を大きく広げるので落とす（東京都の北緯32度より南）
  if (code === 13) polys = polys.filter((p) => p[0].some(([, lat]) => lat > 32));
  // 沖縄県の大東諸島（東経130度より東）は、はめ込み枠を広げるので落とす
  if (code === 47) polys = polys.filter((p) => p[0].every(([lon]) => lon < 130));
  const largest = Math.max(...polys.map((p) => ringArea(p[0])));
  polys = polys.filter((p) => p[0].length >= 4 && (ringArea(p[0]) >= MIN_AREA || ringArea(p[0]) === largest));
  return {
    code,
    name,
    // 各リングは [lon, lat, lon, lat, ...] の平らな配列
    polygons: polys.map((p) => p.map((ring) => ring.flatMap(([x, y]) => [round(x), round(y)]))),
  };
}).sort((a, b) => a.code - b.code);

if (prefs.length !== 47) throw new Error(`都道府県の数が47ではありません: ${prefs.length}`);

const out = {
  source: "国土数値情報（行政区域データ N03, 令和3年）国土交通省 を smartnews-smri/japan-topography が簡素化したものを、さらに簡素化して作成",
  source_url: SOURCE_URL,
  tolerance_deg: TOLERANCE,
  prefs,
};
await mkdir(dirname(OUT), { recursive: true });
const json = JSON.stringify(out);
await writeFile(OUT, json);
const points = prefs.reduce((s, p) => s + p.polygons.flat().reduce((t, r) => t + r.length / 2, 0), 0);
console.log(`書き出し: ${OUT} (${(json.length / 1024).toFixed(0)} KB, 頂点 ${points})`);
