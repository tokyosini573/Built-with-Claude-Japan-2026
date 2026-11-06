// 都道府県の境界の読み込み、投影、人の点の配置。
// 境界データは scripts/build-japan-map.mjs で作る（出典は ATTRIBUTION.md）。

export interface PrefShape {
  code: number;
  name: string;
  /** ポリゴン = [外周, 穴...]。リングは [lon, lat, lon, lat, ...] */
  polygons: number[][][];
}

export interface JapanMapData {
  source: string;
  source_url: string;
  prefs: PrefShape[];
}

let cache: Promise<JapanMapData> | null = null;

export function loadJapanMap(): Promise<JapanMapData> {
  if (!cache) {
    cache = fetch(`${import.meta.env.BASE_URL}geo/japan-prefectures.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`地図データを取得できませんでした（HTTP ${r.status}）`);
        return r.json() as Promise<JapanMapData>;
      })
      .catch((e) => {
        cache = null;
        throw e;
      });
  }
  return cache;
}

// ---- 投影 ----
// 日本付近だけなので、緯度36度で横を縮めた正距円筒図法で十分。
// 沖縄県は左上（日本海側）に移して見せる「はめ込み」をする。

const COS_LAT = Math.cos((36 * Math.PI) / 180);
export const OKINAWA_CODE = 47;
const OKINAWA_SHIFT: [number, number] = [4.5, 14];

export interface Projection {
  /** 経緯度 → 0〜1 の正規化座標（左上原点） */
  project(lon: number, lat: number, prefCode: number): [number, number];
  /** 地図の縦横比（幅 / 高さ） */
  aspect: number;
  /** はめ込み枠（正規化座標）。はめ込みなしなら null */
  insetBox: [number, number, number, number] | null;
}

export function makeProjection(data: JapanMapData, insetOkinawa = true): Projection {
  const shift = (lon: number, lat: number, code: number): [number, number] =>
    insetOkinawa && code === OKINAWA_CODE ? [lon + OKINAWA_SHIFT[0], lat + OKINAWA_SHIFT[1]] : [lon, lat];

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let iMinX = Infinity, iMaxX = -Infinity, iMinY = Infinity, iMaxY = -Infinity;
  for (const p of data.prefs) {
    for (const poly of p.polygons) {
      const ring = poly[0];
      for (let i = 0; i < ring.length; i += 2) {
        const [lon, lat] = shift(ring[i], ring[i + 1], p.code);
        const x = lon * COS_LAT, y = -lat;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        if (insetOkinawa && p.code === OKINAWA_CODE) {
          iMinX = Math.min(iMinX, x); iMaxX = Math.max(iMaxX, x);
          iMinY = Math.min(iMinY, y); iMaxY = Math.max(iMaxY, y);
        }
      }
    }
  }
  // 余白
  const pad = 0.3;
  minX -= pad; maxX += pad; minY -= pad; maxY += pad;
  const w = maxX - minX, h = maxY - minY;
  const norm = (x: number, y: number): [number, number] => [(x - minX) / w, (y - minY) / h];

  let insetBox: Projection["insetBox"] = null;
  if (insetOkinawa && Number.isFinite(iMinX)) {
    const m = 0.15;
    const [x0, y0] = norm(iMinX - m, iMinY - m);
    const [x1, y1] = norm(iMaxX + m, iMaxY + m);
    insetBox = [x0, y0, x1, y1];
  }

  return {
    project(lon, lat, code) {
      const [l, t] = shift(lon, lat, code);
      return norm(l * COS_LAT, -t);
    },
    aspect: w / h,
    insetBox,
  };
}

// ---- 決定的な乱数 ----

/** person_id などの整数から 32bit のシードを作る */
export function hashSeed(n: number, salt = 0x9e3779b9): number {
  let h = (n ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32。同じシードなら同じ列 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 点の配置 ----

function ringArea(r: number[]): number {
  let s = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) s += (r[j] - r[i]) * (r[j + 1] + r[i + 1]);
  return Math.abs(s / 2);
}

/** 偶奇規則でポリゴン（穴つき）の内側か */
function insidePolygon(poly: number[][], x: number, y: number): boolean {
  let inside = false;
  for (const r of poly) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

interface PrefSampler {
  polys: { poly: number[][]; bbox: [number, number, number, number] }[];
  cumArea: number[];
}

function makeSampler(p: PrefShape): PrefSampler {
  const polys = p.polygons.map((poly) => {
    const r = poly[0];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) {
      x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]);
      y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]);
    }
    return { poly, bbox: [x0, y0, x1, y1] as [number, number, number, number] };
  });
  let acc = 0;
  const cumArea = p.polygons.map((poly) => (acc += ringArea(poly[0])));
  return { polys, cumArea };
}

/**
 * 人ごとに、その都道府県の形の内側にゆらいだ点を置く（person_id がシード）。
 * 戻り値: 正規化座標 [x0, y0, x1, y1, ...]（people と同じ順）
 */
export function placePeople(
  people: { id: number; pref: number }[],
  data: JapanMapData,
  proj: Projection,
): Float32Array {
  const samplers = new Map<number, PrefSampler>();
  for (const p of data.prefs) samplers.set(p.code, makeSampler(p));
  const out = new Float32Array(people.length * 2);

  people.forEach(({ id, pref }, i) => {
    const s = samplers.get(pref);
    if (!s || s.polys.length === 0) {
      out[i * 2] = out[i * 2 + 1] = NaN;
      return;
    }
    const rand = rng(hashSeed(id));
    // 面積に比例して島（ポリゴン）を選ぶ
    const total = s.cumArea[s.cumArea.length - 1];
    const pick = rand() * total;
    let k = s.cumArea.findIndex((c) => c >= pick);
    if (k < 0) k = 0;
    const { poly, bbox } = s.polys[k];
    let lon = poly[0][0], lat = poly[0][1];
    for (let tries = 0; tries < 60; tries++) {
      const x = bbox[0] + rand() * (bbox[2] - bbox[0]);
      const y = bbox[1] + rand() * (bbox[3] - bbox[1]);
      if (insidePolygon(poly, x, y)) {
        lon = x; lat = y;
        break;
      }
    }
    const [nx, ny] = proj.project(lon, lat, pref);
    out[i * 2] = nx;
    out[i * 2 + 1] = ny;
  });
  return out;
}
