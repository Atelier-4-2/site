// North-up A3 plan plates. Pure ES module; no DOM or external libraries.
// Inputs use EPSG:2154 metres. ctx.convergence follows dgenv/climate convention.
// No input object or array is mutated.
import { contourRings, gaussian } from "./dgcontour_v03.js?v=20261113cards2";
import { makeSurface, nearestStation } from "./dgenv_v02.js?v=20261116n";

export const LB_KINDS = [
  {
    kind: "B1", ko: "바람길", fr: "Corridors de ventilation",
    controls: [{
      key: "season", type: "select", label: "계절", default: "annual",
      options: [
        { value: "annual", label: "연간" },
        { value: "summer", label: "여름" },
        { value: "winter", label: "겨울" }
      ]
    }]
  },
  {
    kind: "B2", ko: "야간 찬공기 흐름",
    fr: "Drainage nocturne d’air froid",
    controls: []
  }
];

const R = Math.PI / 180;
const W = 420, H = 297;
const INK = "#1E293B", SUB = "#475569", EDGE = "#CBD5E1";
const TEAL = "#168F89", YELLOW = "#E8CB68", BROWN = "#946044";
const LILAC = "#B69BCB";
// B1 (2026-11-16): the resistance classes are neutral-to-warm and only the corridors are blue, as on
// urban climate maps (VDI 3787-1 convention); before, classes, corridors, aligned streets and water were all teal.
export const WIND_B1 = { low: "#ECEAE4", mid: "#E6C994", high: "#C98A70", corridor: "#005A9C", street: "#168F89" };
const FONT = "'Noto Sans','Noto Sans KR','Malgun Gothic',sans-serif";
const DISCLAIMER = "참고용 시뮬레이션 · CFD 아님 · 법적 효력 없음";
export const KO_B1 = { primary: "1차 바람길", secondary: "2차 바람길", street: "정렬 도로 ±30° · λf ≤ 0.40", avoid: "2차는 1차 주변 90 m를 피해 탐색", limit: "보행자 높이 풍속 아님" };
const DIRS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"
];
const MOVES = [
  [-1, -1], [0, -1], [1, -1], [-1, 0],
  [1, 0], [-1, 1], [0, 1], [1, 1]
];
const finite = Number.isFinite;
const fmt = v => String(Math.round(v * 1000) / 1000);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;",
  '"': "&quot;", "'": "&apos;"
}[c]));
const pathD = (pts, close = false) =>
  "M" + pts.map(p => `${fmt(p[0])} ${fmt(p[1])}`).join("L") +
  (close ? "Z" : "");

function inside(ring, x, y) {
  let yes = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) &&
        x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) {
      yes = !yes;
    }
  }
  return yes;
}

// All map geometry is clipped before recording, including CAD geometry.
function clipRing(ring, e) {
  let out = ring.slice();
  for (const [axis, bound, sign] of [
    [0, e[0], 1], [0, e[2], -1],
    [1, e[1], 1], [1, e[3], -1]
  ]) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[(i + input.length - 1) % input.length];
      const b = input[i];
      const ia = sign * (a[axis] - bound) >= 0;
      const ib = sign * (b[axis] - bound) >= 0;
      if (ia !== ib) {
        const t = (bound - a[axis]) / (b[axis] - a[axis]);
        out.push([
          a[0] + t * (b[0] - a[0]),
          a[1] + t * (b[1] - a[1])
        ]);
      }
      if (ib) out.push(b);
    }
  }
  return out;
}

function clipSegment(a, b, e) {
  let lo = 0, hi = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - e[0], e[2] - a[0], a[1] - e[1], e[3] - a[1]];
  for (let k = 0; k < 4; k++) {
    if (p[k] === 0) {
      if (q[k] < 0) return null;
    } else {
      const t = q[k] / p[k];
      if (p[k] < 0) lo = Math.max(lo, t);
      else hi = Math.min(hi, t);
      if (lo > hi) return null;
    }
  }
  return [
    [a[0] + lo * dx, a[1] + lo * dy],
    [a[0] + hi * dx, a[1] + hi * dy]
  ];
}

// One recorder drives SVG and the existing paper-space CAD sheet schema.
class Drawing {
  constructor() {
    this.svg = [];
    this.groups = new Map();
    this.legend = [];
  }
  add(layer, item) {
    if (!this.groups.has(layer)) {
      this.groups.set(layer, { id: layer, name: layer, items: [] });
    }
    this.groups.get(layer).items.push(item);
  }
  cad(p) { return [p[0], H - p[1]]; }
  poly(rings, fill = "none", stroke = EDGE, sw = .15, layer = "line", op = 1) {
    rings = rings.filter(r => r.length >= 3);
    if (!rings.length) return;
    this.svg.push(
      `<path d="${rings.map(r => pathD(r, true)).join("")}" ` +
      `fill="${esc(fill)}" fill-rule="evenodd" stroke="${esc(stroke)}" ` +
      `stroke-width="${fmt(sw)}" opacity="${op}" stroke-linejoin="round"/>`
    );
    this.add(layer, {
      k: "poly", rings: rings.map(r => r.map(p => this.cad(p))),
      fill: "none", stroke: stroke === "none" ? fill : stroke, sw
    });
  }
  line(pts, stroke = INK, sw = .2, layer = "line", op = 1) {
    if (pts.length < 2) return;
    this.svg.push(
      `<path d="${pathD(pts)}" fill="none" stroke="${esc(stroke)}" ` +
      `stroke-width="${fmt(sw)}" opacity="${op}" ` +
      `stroke-linecap="round" stroke-linejoin="round"/>`
    );
    this.add(layer, {
      k: "line", pts: pts.map(p => this.cad(p)), stroke, sw
    });
  }
  rect(x, y, w, h, fill, stroke = "none", sw = .1, layer = "line", op = 1) {
    this.poly([[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]],
      fill, stroke, sw, layer, op);
  }
  text(x, y, text, size = 2.6, anchor = "start", fill = INK) {
    this.svg.push(
      `<text x="${fmt(x)}" y="${fmt(y)}" font-size="${size}" ` +
      `text-anchor="${anchor}" fill="${esc(fill)}">${esc(text)}</text>`
    );
    this.add("text", {
      k: "text", p: this.cad([x, y]), text: String(text), fill, hm: size
    });
  }
  dot(p, r, fill, stroke = fill, sw = .15, layer = "site") {
    this.svg.push(
      `<circle cx="${fmt(p[0])}" cy="${fmt(p[1])}" r="${r}" ` +
      `fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${sw}"/>`
    );
    this.add(layer, {
      k: "dot", p: this.cad(p), r, fill, stroke, sw
    });
  }
  arrow(a, b, color, size = 2, layer = "flow") {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < .01) return;
    const ux = dx / length, uy = dy / length;
    this.poly([[
      b,
      [b[0] - size * ux - size * .4 * uy,
       b[1] - size * uy + size * .4 * ux],
      [b[0] - size * ux + size * .4 * uy,
       b[1] - size * uy - size * .4 * ux]
    ]], color, color, .1, layer);
  }
}

function projection(ctx) {
  const e = ctx.extent;
  const cx = (e[0] + e[2]) / 2, cy = (e[1] + e[3]) / 2;
  const a = (ctx.convergence || 0) * R;
  const c = Math.cos(a), s = Math.sin(a);
  const raw = (x, y) => [
    (x - cx) * c - (y - cy) * s,
    -((x - cx) * s + (y - cy) * c)
  ];
  const corners = [
    [e[0], e[1]], [e[2], e[1]], [e[2], e[3]], [e[0], e[3]]
  ].map(p => raw(...p));
  const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
  const scale = Math.min(
    286 / (Math.max(...xs) - Math.min(...xs)),
    196 / (Math.max(...ys) - Math.min(...ys))
  );
  return {
    scale,
    P: (x, y) => {
      const p = raw(x, y);
      return [161 + p[0] * scale, 138 + p[1] * scale];
    }
  };
}

function grid(extent, step) {
  return {
    x0: extent[0], y0: extent[1], step, extent,
    nx: Math.ceil((extent[2] - extent[0]) / step),
    ny: Math.ceil((extent[3] - extent[1]) / step)
  };
}
function cellRect(G, i, j) {
  const x = G.x0 + i * G.step, y = G.y0 + j * G.step;
  return [
    [x, y], [Math.min(x + G.step, G.extent[2]), y],
    [Math.min(x + G.step, G.extent[2]), Math.min(y + G.step, G.extent[3])],
    [x, Math.min(y + G.step, G.extent[3])]
  ];
}
function center(G, k) {
  const r = cellRect(G, k % G.nx, Math.floor(k / G.nx));
  return [(r[0][0] + r[2][0]) / 2, (r[0][1] + r[2][1]) / 2];
}
function indexAt(G, x, y) {
  const i = Math.floor((x - G.x0) / G.step);
  const j = Math.floor((y - G.y0) / G.step);
  return i < 0 || j < 0 || i >= G.nx || j >= G.ny ? -1 : j * G.nx + i;
}
function paintRuns(d, G, classify, colors, P, layer, opacity = 1) {
  for (let j = 0; j < G.ny; j++) {
    for (let i = 0; i < G.nx;) {
      const c = classify(j * G.nx + i);
      let end = i + 1;
      while (end < G.nx && classify(j * G.nx + end) === c) end++;
      if (c >= 0) {
        const left = cellRect(G, i, j), right = cellRect(G, end - 1, j);
        d.poly([[left[0], right[1], right[2], left[3]].map(p => P(...p))],
          colors[c], "none", .08, layer, opacity);
      }
      i = end;
    }
  }
}
// Bilinear resample of a cell-centred grid to a finer step, then a gaussian blur (sigma in fine cells).
function refine(G, values, step, sigma) {
  const f = G.step / step, nx = Math.round(G.nx * f), ny = Math.round(G.ny * f);
  const out = new Float64Array(nx * ny);
  const at = (i, j) => values[Math.max(0, Math.min(G.ny - 1, j)) * G.nx + Math.max(0, Math.min(G.nx - 1, i))];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const gx = (i + .5) / f - .5, gy = (j + .5) / f - .5;
    const i0 = Math.floor(gx), j0 = Math.floor(gy), u = gx - i0, v = gy - j0;
    out[j * nx + i] = at(i0, j0) * (1 - u) * (1 - v) + at(i0 + 1, j0) * u * (1 - v) +
      at(i0, j0 + 1) * (1 - u) * v + at(i0 + 1, j0 + 1) * u * v;
  }
  return { x0: G.x0, y0: G.y0, step, nx, ny, values: gaussian(out, nx, ny, sigma) };
}
function drawWorldLine(d, pts, e, P, color, width, layer, opacity = 1) {
  for (let i = 1; i < pts.length; i++) {
    const seg = clipSegment(pts[i - 1], pts[i], e);
    if (seg) d.line(seg.map(p => P(...p)), color, width, layer, opacity);
  }
}

// Accepted vector forms: polygon/holes or GeoJSON Polygon/MultiPolygon.
function polygonParts(feature) {
  if (Array.isArray(feature?.polygon)) {
    return [[feature.polygon, ...(feature.holes || [])]];
  }
  const g = feature?.geometry || feature;
  if (g?.type === "Polygon") return [g.coordinates];
  if (g?.type === "MultiPolygon") return g.coordinates;
  return [];
}
function features(value) {
  return Array.isArray(value) ? value : value?.features || [];
}
function rasterPolygons(G, collection) {
  const mask = new Uint8Array(G.nx * G.ny);
  for (const feature of features(collection)) {
    for (const rings of polygonParts(feature)) {
      const outer = rings[0];
      if (!outer?.length) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of outer) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      const ia = Math.max(0, Math.floor((x0 - G.x0) / G.step));
      const ib = Math.min(G.nx - 1, Math.floor((x1 - G.x0) / G.step));
      const ja = Math.max(0, Math.floor((y0 - G.y0) / G.step));
      const jb = Math.min(G.ny - 1, Math.floor((y1 - G.y0) / G.step));
      for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) {
        const k = j * G.nx + i, p = center(G, k);
        if (inside(outer, ...p) && !rings.slice(1).some(r => inside(r, ...p))) {
          mask[k] = 1;
        }
      }
    }
  }
  return mask;
}
function roadLines(road) {
  for (const key of ["points", "line", "coords", "polyline"]) {
    const p = road?.[key];
    if (Array.isArray(p) && Array.isArray(p[0]) && finite(p[0][0])) return [p];
  }
  const g = road?.geometry || road;
  if (g?.type === "LineString") return [g.coordinates];
  if (g?.type === "MultiLineString") return g.coordinates;
  return [];
}

class Heap {
  constructor() { this.a = []; }
  push(k, v) {
    const a = this.a;
    let i = a.length;
    a.push([k, v]);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][1] <= v) break;
      a[i] = a[p]; i = p;
    }
    a[i] = [k, v];
  }
  pop() {
    const a = this.a, first = a[0], last = a.pop();
    if (a.length) {
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let c = i * 2 + 1;
        if (c + 1 < a.length && a[c + 1][1] < a[c][1]) c++;
        if (a[c][1] >= last[1]) break;
        a[i] = a[c]; i = c;
      }
      a[i] = last;
    }
    return first;
  }
}

// Corridor candidates that do not pile up on the one open axis (a river, a boulevard). The cheapest
// path is the primary corridor; each further search avoids the surroundings of the paths already found
// (cost x4 within 90 m: iterative penalty, a k-dissimilar-paths variant of the least-cost-path method of
// Wong et al. 2010). A secondary path that ploughs through built-up cells (mean lambda_f > 0.35) is
// not a corridor and is dropped.
const CORRIDOR = { count: 3, avoid: 90, penalty: 4, maxLambda: .35 };   // 1 primary + up to 2 secondary per wind direction
function corridors(G, lambda, ux, uy, S) {
  // Routing runs on the 4 m surface raster and never enters a building cell: at pedestrian height the
  // wind goes round buildings, not through them (on the 25 m grid a path could cross a built-up cell).
  // The cost of a step is the frontal-area resistance of the 25 m cell it lies in; cells next to a
  // facade cost more, so a path keeps to the middle of a street.
  const n = S.nx * S.ny, cost = new Float32Array(n), lam = new Float32Array(n);
  const near = new Uint8Array(n).fill(3);                         // cells to the nearest building, capped at 3
  for (let k = 0; k < n; k++) if (S.bld[k]) near[k] = 0;
  for (let pass = 1; pass <= 2; pass++) for (let j = 0; j < S.ny; j++) for (let i = 0; i < S.nx; i++) {
    const k = j * S.nx + i;
    if (near[k] < 3) continue;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const x = i + di, y = j + dj;
      if (x >= 0 && y >= 0 && x < S.nx && y < S.ny && near[y * S.nx + x] === pass - 1) near[k] = pass;
    }
  }
  const side = [0, 2.2, 1.4, 1];
  for (let k = 0; k < n; k++) {
    const g = indexAt(G, ...center(S, k));
    lam[k] = g < 0 ? 1 : lambda[g];
    cost[k] = (.02 + lam[k]) * side[near[k]];
  }
  const pen = new Float32Array(n).fill(1), out = [];
  const reach = Math.ceil(CORRIDOR.avoid / S.step);
  for (let round = 0; round < CORRIDOR.count; round++) {
    const path = cheapestPath(S, cost, ux, uy, pen);
    if (!path) break;
    path.meanLambda = path.ids.reduce((sum, k) => sum + lam[k], 0) / path.ids.length;
    path.primary = !round;
    if (!round || path.meanLambda <= CORRIDOR.maxLambda) out.push(path);
    const mark = new Uint8Array(n);
    for (let q = 0; q < path.ids.length; q += 2) {
      const k = path.ids[q], i = k % S.nx, j = Math.floor(k / S.nx);
      for (let dj = -reach; dj <= reach; dj++) for (let di = -reach; di <= reach; di++) {
        const x = i + di, y = j + dj;
        if (x < 0 || y < 0 || x >= S.nx || y >= S.ny) continue;
        if (di * di + dj * dj <= reach * reach) mark[y * S.nx + x] = 1;
      }
    }
    for (let k = 0; k < n; k++) if (mark[k]) pen[k] *= CORRIDOR.penalty;
  }
  return out;
}
// Multi-source Dijkstra on the surface raster R: positive cost, forward/lateral eight-neighbour graph,
// building cells impassable, no diagonal step between two building corners. `pen` multiplies the cell
// cost. Returns the cheapest downwind terminal path only.
function cheapestPath(R, cost, ux, uy, pen) {
  const n = R.nx * R.ny;
  const distance = new Float64Array(n); distance.fill(Infinity);
  const previous = new Int32Array(n); previous.fill(-1);
  const heap = new Heap(), sinks = [];
  const ax = Math.abs(ux), ay = Math.abs(uy);
  const source = (i, j) =>
    (ax > 1e-8 && i === (ux > 0 ? 0 : R.nx - 1)) ||
    (ay > 1e-8 && j === (uy > 0 ? 0 : R.ny - 1));
  const sink = (i, j) =>
    (ax > 1e-8 && i === (ux > 0 ? R.nx - 1 : 0)) ||
    (ay > 1e-8 && j === (uy > 0 ? R.ny - 1 : 0));
  const e = R.extent;
  const projectedSpan = (e[2] - e[0]) * ax + (e[3] - e[1]) * ay;
  // Exclude corner shortcuts: sources/sinks must occupy outer projection thirds.
  let minQ = Infinity, maxQ = -Infinity;
  for (const p of [[e[0], e[1]], [e[2], e[1]], [e[2], e[3]], [e[0], e[3]]]) {
    const q = p[0] * ux + p[1] * uy;
    minQ = Math.min(minQ, q); maxQ = Math.max(maxQ, q);
  }
  for (let j = 0; j < R.ny; j++) for (let i = 0; i < R.nx; i++) {
    if (i && j && i < R.nx - 1 && j < R.ny - 1) continue;          // border cells only
    const k = j * R.nx + i;
    if (R.bld[k]) continue;
    const p = center(R, k), q = p[0] * ux + p[1] * uy;
    if (source(i, j) && q <= minQ + projectedSpan / 3) { distance[k] = 0; heap.push(k, 0); }
    if (sink(i, j) && q >= maxQ - projectedSpan / 3) sinks.push(k);
  }
  while (heap.a.length) {
    const [k, d0] = heap.pop();
    if (d0 !== distance[k]) continue;
    const i = k % R.nx, j = Math.floor(k / R.nx);
    for (const [di, dj] of MOVES) {
      if (di * ux + dj * uy < -1e-8) continue;
      const x = i + di, y = j + dj;
      if (x < 0 || y < 0 || x >= R.nx || y >= R.ny) continue;
      const next = y * R.nx + x;
      if (R.bld[next]) continue;
      if (di && dj && (R.bld[j * R.nx + x] || R.bld[y * R.nx + i])) continue;
      const length = R.step * (di && dj ? Math.SQRT2 : 1);
      const v = d0 + (cost[k] * pen[k] + cost[next] * pen[next]) / 2 * length;
      if (v < distance[next]) { distance[next] = v; previous[next] = k; heap.push(next, v); }
    }
  }
  let end = -1;
  for (const k of sinks) if (finite(distance[k]) && (end < 0 || distance[k] < distance[end])) end = k;
  if (end < 0) return null;
  const ids = [];
  for (let k = end; k >= 0; k = previous[k]) ids.push(k);
  ids.reverse();
  return ids.length > 1 ? { ids, cost: distance[end], points: ids.map(k => center(R, k)) } : null;
}

function frontal(S, G, ux, uy) {
  const n = G.nx * G.ny;
  const lambda = new Float32Array(n), hsum = new Float64Array(n);
  const count = new Uint32Array(n), z0 = new Float32Array(n);
  const height = k => k < 0 ? 0 : Math.max(0, S.top[k] - S.ground[k]);
  for (let j = 0; j < S.ny; j++) for (let i = 0; i < S.nx; i++) {
    const k = j * S.nx + i;
    if (!S.bld[k]) continue;
    const p = center(S, k), g = indexAt(G, ...p);
    if (g < 0) continue;
    const h = height(k);
    hsum[g] += h; count[g]++;
    const wi = i - Math.sign(ux), wj = j - Math.sign(uy);
    const west = wi >= 0 && wi < S.nx ? j * S.nx + wi : -1;
    const south = wj >= 0 && wj < S.ny ? wj * S.nx + i : -1;
    const r = cellRect(S, i, j);
    lambda[g] +=
      Math.max(0, h - height(west)) * (r[3][1] - r[0][1]) * Math.abs(ux) +
      Math.max(0, h - height(south)) * (r[1][0] - r[0][0]) * Math.abs(uy);
  }
  for (let k = 0; k < n; k++) {
    const r = cellRect(G, k % G.nx, Math.floor(k / G.nx));
    lambda[k] /= (r[1][0] - r[0][0]) * (r[3][1] - r[0][1]);
    const meanH = count[k] ? hsum[k] / count[k] : 0;
    z0[k] = .1 * meanH * (1 - Math.exp(-lambda[k]));
  }
  return { lambda, z0 };
}

function windPlate(env, opts, S, d, P) {
  const { ctx, data } = env;
  const season = opts.season || "annual";
  const period = { annual: 0, summer: 3, winter: 1 }[season];
  if (period === undefined) throw new Error("계절 값 오류");
  if (!data.climate?.stations?.length) throw new Error("EPW 관측소 없음");
  const found = nearestStation(data.climate, ctx.lat, ctx.lon);
  const st = found.station, rose = st.rose?.[period], total = st.total?.[period];
  if (!Array.isArray(rose) || rose.length !== 16 || !(total > 0)) {
    throw new Error("EPW 풍배열 없음");
  }
  const tops = rose.map((bins, direction) => ({
    direction,
    count: Array.from(bins).slice(1, 7).reduce((s, n) => s + (+n || 0), 0)
  })).filter(t => t.count > 0).sort((a, b) => b.count - a.count).slice(0, 2);
  if (!tops.length) throw new Error("유효한 비정온 풍향 없음");
  const G = grid(ctx.extent, 25), mean = new Float32Array(G.nx * G.ny);
  const sum = tops.reduce((a, b) => a + b.count, 0);
  const directions = tops.map(t => {
    // EPW direction is FROM; transport is the opposite direction.
    const az = (t.direction * 22.5 + (ctx.convergence || 0)) * R;
    const ux = -Math.sin(az), uy = -Math.cos(az);
    const f = frontal(S, G, ux, uy);
    for (let k = 0; k < mean.length; k++) {
      mean[k] += f.lambda[k] * t.count / sum;
    }
    return {
      from: DIRS[t.direction], degrees: t.direction * 22.5,
      pct: t.count / total * 100, ux, uy, ...f,
      paths: corridors(G, f.lambda, ux, uy, S)
    };
  });
  // Drawing only: the 25 m classes were painted as square cells (a staircase around every block).
  // The same values, resampled to 5 m and slightly blurred, are drawn as three smooth bands.
  const fine = refine(G, mean, 5, 1.6);
  const e = ctx.extent;
  d.poly([[[e[0], e[1]], [e[2], e[1]], [e[2], e[3]], [e[0], e[3]]].map(p => P(...p))], WIND_B1.low, "none", 0, "lambda_f", .9);
  contourRings(fine.values, fine.nx, fine.ny, fine.x0, fine.y0, fine.step, [.15, .4]).forEach((rings, i) => {
    const clipped = rings.map(r => clipRing(r, e)).filter(r => r.length >= 3);
    if (clipped.length) d.poly(clipped.map(r => r.map(p => P(...p))), [WIND_B1.mid, WIND_B1.high][i], "none", 0, "lambda_f", 1);
  });
  const hasWater = drawPlateWater(d, data, ctx.extent, P, env.pal);
  let alignedSegments = 0;
  for (const road of features(data.roads)) for (const line of roadLines(road)) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
      if (!length) continue;
      const cell = indexAt(G, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      if (cell >= 0 && mean[cell] <= .4 && directions.some(t =>
        Math.abs((dx * t.ux + dy * t.uy) / length) >= Math.cos(30 * R))) {
        drawWorldLine(d, [a, b], ctx.extent, P, WIND_B1.street, .3, "aligned_streets");
        alignedSegments++;
      }
    }
  }
  const e0 = ctx.extent, cc = ctx.center || [(e0[0] + e0[2]) / 2, (e0[1] + e0[3]) / 2], rr = (e0[2] - e0[0]) / 2;
  const inside = p => p[0] >= e0[0] + 6 && p[0] <= e0[2] - 6 && p[1] >= e0[1] + 6 && p[1] <= e0[3] - 6 &&
    (ctx.shape?.kind !== "circle" || Math.hypot(p[0] - cc[0], p[1] - cc[1]) <= rr - 6);
  // All corridor lines first, then the heads on top: candidates share trunks and run side by side, so one
  // head per path piled up into a blur. One head per ~12 mm of sheet, in the darker 3D corridor colour.
  const heads = [];
  directions.forEach((t, rank) => {
    for (const path of t.paths) {
      const world = smoothPath(path.points, 3), pts = world.map(p => P(...p));
      const main = path.primary && !rank;
      // head at the end of the line, at the last point inside the site (circle) or the extent;
      // the line itself stops at the base of the head
      let i = world.length - 1;
      while (i > 3 && !inside(world[i])) i--;
      i = Math.max(3, i - 1);
      const shown = pts.slice(0, Math.max(2, i - 1));
      d.line(shown, "#FFFFFF", main ? 2.6 : 1.5, "corridors", .9);          // casing: readable on water and on the classes
      d.line(shown, WIND_B1.corridor, main ? 1.8 : .8, "corridors", 1);
      if (heads.some(h => Math.hypot(h.b[0] - pts[i][0], h.b[1] - pts[i][1]) < 5)) continue;
      heads.push({ a: pts[i - 3], b: pts[i], size: main ? 3.2 : 2.3 });
    }
  });
  for (const h of heads) d.arrow(h.a, h.b, WIND_B1.corridor, h.size, "corridors");
  legend(d, [
    [WIND_B1.low, "λf < 0.15", .9],
    [WIND_B1.mid, "λf 0.15–0.40", .9],
    [WIND_B1.high, "λf > 0.40", .9],
    [WIND_B1.corridor, KO_B1.primary, 1, 1.8],
    [WIND_B1.corridor, KO_B1.secondary, 1, .8],
    [WIND_B1.street, KO_B1.street, 1, .3],
    ...(hasWater ? [[env.pal?.water || "#A8C8D8", "수면", .92]] : [])
  ]);
  d.text(322, 98, "격자 25 m · λf 무차원", 2.5);
  directions.forEach((t, i) => {
    d.text(322, 106 + i * 6, `유입 ${t.from} · ${t.pct.toFixed(1)} %`, 2.7);
  });
  d.text(322, 124, "화살표 = 바람 진행 방향", 2.4);
  d.text(322, 130, KO_B1.avoid, 2.4);
  return {
    stats: {
      season, station: st.name, km: found.km, grid: G, fine,
      lambda: mean, directions, alignedSegments,
      unknownHeight: S.unknownHeight,
      method: "Raster frontal exposure; top-two frequency-weighted map; penalised least-cost corridors"
    },
    source: `EPW ${String(st.name || st.wmo || "").slice(0, 30)} · ` +
      `${found.km.toFixed(1)} km · IGN BD TOPO · AVA / Gál–Unger 2009 / Wong 2010`,
    note: "λf=ΣA노출/셀면적; z0=0.1h̄(1−exp(−λf)) m, 경험식; 비용=(λf+0.02)×거리, 4 m 격자·건물 통과 불가; " +
      KO_B1.limit + " · " + DISCLAIMER
  };
}

function validTerrain(dem, x, y) {
  if (!dem || !finite(dem.dx) || dem.dx <= 0 || dem.nx < 2 || dem.ny < 2) return false;
  const fx = (x - dem.x0) / dem.dx, fy = (y - dem.y0) / dem.dx;
  if (fx < 0 || fy < 0 || fx > dem.nx - 1 || fy > dem.ny - 1) return false;
  const i = Math.min(dem.nx - 2, Math.floor(fx));
  const j = Math.min(dem.ny - 2, Math.floor(fy));
  return [j * dem.nx + i, j * dem.nx + i + 1,
    (j + 1) * dem.nx + i, (j + 1) * dem.nx + i + 1]
    .every(k => finite(dem.z?.[k]) &&
      dem.z[k] > -1000 && dem.z[k] !== dem.nodata && dem.z[k] !== dem.noData);
}

function coldPlate(env, S, d, P) {
  const { data, ctx, pal = {} } = env;
  if (!data.dem) throw new Error("RGE ALTI DEM 없음");
  const n = S.nx * S.ny;
  const valid = new Uint8Array(n);
  const green = rasterPolygons(S, data.vegetation || data.greens || data.green);
  const water = rasterPolygons(S, data.water || data.waters);
  const open = rasterPolygons(S, data.openGround || data.open);
  const road = new Uint8Array(n), source = new Uint8Array(n);
  const pool = new Uint8Array(n), slope = new Float32Array(n);
  const next = new Int32Array(n); next.fill(-1);
  let validCount = 0;
  for (let k = 0; k < n; k++) {
    valid[k] = validTerrain(data.dem, ...center(S, k)) ? 1 : 0;
    validCount += valid[k];
  }
  if (!validCount) throw new Error("분석 범위에 유효 DEM 없음");
  for (const feature of features(data.roads)) for (const line of roadLines(feature)) {
    const widthValue = Number(feature.width ?? feature.properties?.width);
    const radius = Math.max(S.step * .5, finite(widthValue) ? widthValue / 2 : 3);
    const cells = Math.ceil(radius / S.step);
    for (let i = 1; i < line.length; i++) {
      const seg = clipSegment(line[i - 1], line[i], ctx.extent);
      if (!seg) continue;
      const [a, b] = seg, length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(length / (S.step / 2)));
      for (let t = 0; t <= steps; t++) {
        const x = a[0] + (b[0] - a[0]) * t / steps;
        const y = a[1] + (b[1] - a[1]) * t / steps;
        const ci = Math.floor((x - S.x0) / S.step);
        const cj = Math.floor((y - S.y0) / S.step);
        for (let dj = -cells; dj <= cells; dj++) for (let di = -cells; di <= cells; di++) {
          const ii = ci + di, jj = cj + dj;
          if (ii < 0 || jj < 0 || ii >= S.nx || jj >= S.ny) continue;
          const k = jj * S.nx + ii, p = center(S, k);
          if (Math.hypot(p[0] - x, p[1] - y) <= radius) road[k] = 1;
        }
      }
    }
  }
  // Unmapped non-building ground is a declared open-ground assumption.
  let sourceCount = 0, poolCount = 0, blockedCount = 0;
  for (let j = 0; j < S.ny; j++) for (let i = 0; i < S.nx; i++) {
    const k = j * S.nx + i;
    if (!valid[k] || S.bld[k] || water[k]) continue;
    source[k] = !road[k] && (green[k] || open[k] || !S.bld[k]) ? 1 : 0;
    sourceCount += source[k];
    let steepest = 0, target = -1, blockedDrop = 0;
    let neighbours = 0, lower = 0;
    for (const [di, dj] of MOVES) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= S.nx || jj >= S.ny) continue;
      const q = jj * S.nx + ii;
      if (!valid[q]) continue;
      neighbours++;
      const drop = (S.ground[k] - S.ground[q]) / (S.step * Math.hypot(di, dj));
      if (drop > .005) lower++;
      // Stop at walls; prohibit diagonal leakage through wall corners.
      const cornerBlocked = di && dj &&
        (S.bld[j * S.nx + ii] || S.bld[jj * S.nx + i]);
      if (S.bld[q] || cornerBlocked) {
        blockedDrop = Math.max(blockedDrop, drop);
        continue;
      }
      if (!water[q] && drop > steepest) { steepest = drop; target = q; }
    }
    slope[k] = Math.atan(steepest) / R;
    if (steepest > .005) next[k] = target;
    const interior = i > 0 && j > 0 && i < S.nx - 1 && j < S.ny - 1;
    if (interior && neighbours === 8 && next[k] < 0 &&
        (lower === 0 || blockedDrop > .005)) {
      pool[k] = 1; poolCount++;
      if (blockedDrop > .005) blockedCount++;
    }
  }
  paintRuns(d, S, k => source[k] ? 0 : -1,
    [pal.green || "#B5CCA6"], P, "cold_sources", .45);
  paintRuns(d, S, k => pool[k] ? 0 : -1, [LILAC], P, "pooling", .55);
  const hasWater = drawPlateWater(d, data, ctx.extent, P, pal);

  // Bounded marching-squares contours on the analysis surface.
  let zmin = Infinity, zmax = -Infinity;
  for (let k = 0; k < n; k++) if (valid[k]) {
    zmin = Math.min(zmin, S.ground[k]); zmax = Math.max(zmax, S.ground[k]);
  }
  const baseInterval = zmax - zmin < 15 ? 1 : zmax - zmin < 40 ? 2 : 5;
  const interval = Math.max(baseInterval, Math.ceil((zmax - zmin) / 35));
  for (let j = 0; j < S.ny - 1; j++) for (let i = 0; i < S.nx - 1; i++) {
    const ids = [
      j * S.nx + i, j * S.nx + i + 1,
      (j + 1) * S.nx + i + 1, (j + 1) * S.nx + i
    ];
    if (!ids.every(k => valid[k])) continue;
    const zs = ids.map(k => S.ground[k]), ps = ids.map(k => center(S, k));
    const low = Math.min(...zs), high = Math.max(...zs);
    for (let z = Math.ceil(low / interval) * interval; z <= high; z += interval) {
      const hits = [];
      for (let a = 0; a < 4; a++) {
        const b = (a + 1) % 4;
        if ((zs[a] < z) !== (zs[b] < z)) {
          const t = (z - zs[a]) / (zs[b] - zs[a]);
          hits.push([
            ps[a][0] + t * (ps[b][0] - ps[a][0]),
            ps[a][1] + t * (ps[b][1] - ps[a][1])
          ]);
        }
      }
      for (let a = 0; a + 1 < hits.length; a += 2) {
        d.line([P(...hits[a]), P(...hits[a + 1])], "#BCC4BD", .09, "contours", .7);
      }
    }
  }
  const occupied = new Uint8Array(n), paths = [];
  let seedCount = 0;
  for (let y = S.y0 + 15; y < ctx.extent[3]; y += 30) {
    for (let x = S.x0 + 15; x < ctx.extent[2]; x += 30) {
      let k = indexAt(S, x, y);
      if (k < 0 || !source[k]) continue;
      seedCount++;
      const ids = [];
      // Strict descent prevents cycles; merge shared tails to bound total work.
      for (let count = 0; k >= 0 && count < n; count++) {
        ids.push(k);
        if (occupied[k] || next[k] < 0) break;
        occupied[k] = 1;
        k = next[k];
      }
      if (ids.length < 2) continue;
      const pts = ids.map(q => P(...center(S, q)));
      d.line(pts, TEAL, .32, "cold_flow", .7);
      const tip = Math.max(1, Math.floor(pts.length * .65));
      d.arrow(pts[tip - 1], pts[tip], TEAL, 1.3, "cold_flow");
      paths.push(ids);
    }
  }
  legend(d, [
    [pal.green || "#B5CCA6", "찬공기 생성지", .45],
    [TEAL, "흐름 방향", .8],
    [LILAC, "정체 구역", .55],
    ...(hasWater ? [[pal.water || "#A8C8D8", "수면", .92]] : [])
  ]);
  d.text(322, 80, `흐름 격자 ${S.step} m`, 2.5);
  d.text(322, 86, "생성지 시드 30 m", 2.5);
  d.text(322, 92, `등고선 ${interval} m`, 2.5);
  d.text(322, 104, "미분류 개방지 = 생성지 가정", 2.3);
  d.text(322, 110, "도로·수면·건물 제외", 2.3);
  d.text(322, 116, "온도·풍속·유량 산정 없음", 2.3);
  return {
    stats: {
      gridStep: S.step, next, slopeDegrees: slope, source, pool, valid,
      sourceCount, poolCount, blockedCount, seedCount, paths,
      validCoverage: validCount / n, contourInterval: interval,
      openGroundAssumed: true
    },
    source: "IGN RGE ALTI · BD TOPO · 식생·도로·수면 벡터 · " +
      `유효 DEM ${(100 * validCount / n).toFixed(1)} %`,
    note: "D8=max(Δz/거리), 경사≤0.5% 정지; 내부 저지·장애 정체 후보; 개방지 생성 가정; " +
      DISCLAIMER
  };
}

// Grid paths (25 m cells, eight neighbours) are stair-stepped. For drawing only: a running mean over
// +-`r` cells (twice, ends pinned) and a resample every `seg` metres. The mean is local, so candidates
// that share a trunk still lie exactly on top of each other.
export function smoothPath(pts, r = 2, seg = 8) {
  if (pts.length < 3) return pts;
  let line = pts;
  for (let pass = 0; pass < 2; pass++) line = line.map((_, i) => {
    const k = Math.min(r, i, line.length - 1 - i);
    let x = 0, y = 0;
    for (let j = i - k; j <= i + k; j++) { x += line[j][0]; y += line[j][1]; }
    return [x / (2 * k + 1), y / (2 * k + 1)];
  });
  const out = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const p = line[i - 1], q = line[i], k = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / seg));
    for (let j = 1; j <= k; j++) out.push([p[0] + (q[0] - p[0]) * j / k, p[1] + (q[1] - p[1]) * j / k]);
  }
  return out;
}

// Mapped water above the analysis raster and under the flow lines.
function drawPlateWater(d, data, e, P, pal) {
  let any = false;
  for (const f of data.waterS || []) for (const rings of f.polygons || []) {
    const rs = rings.map(r => clipRing(r, e)).filter(r => r.length >= 3).map(r => r.map(p => P(...p)));
    if (rs.length) { d.poly(rs, pal?.water || "#A8C8D8", "none", .08, "water", .92); any = true; }
  }
  return any;
}
function legend(d, rows) {
  d.text(322, 38, "범례", 3.2);
  rows.forEach(([color, label, op, lineWidth], i) => {
    const y = 46 + i * 7;
    if (lineWidth) d.line([[322, y - 1.2], [332, y - 1.2]], color, lineWidth, "legend", op);
    else d.rect(322, y - 3, 10, 3.5, color, "none", .1, "legend", op);
    d.text(336, y, label, 2.6);
    d.legend.push({ kind: "line", stroke: color, sw: .5, label });
  });
}

export function buildLbPlate(kind, env, opts = {}) {
  const spec = LB_KINDS.find(k => k.kind === kind);
  if (!spec) throw new Error(`지원하지 않는 분석: ${kind}`);
  if (!env?.ctx || !env?.data) throw new Error("분석 입력 없음");
  const { ctx, data } = env;
  const e = ctx.extent;
  if (!e || e.length !== 4 || !e.every(finite) ||
      e[2] <= e[0] || e[3] <= e[1]) throw new Error("분석 범위 오류");
  // Respect the current makeSurface contract: top-ground, not an assumed S.h.
  const buildings = features(data.buildings).map(b => ({
    ...b, holes: b.holes || []
  }));
  if (kind === "B2" && !data.dem) throw new Error("RGE ALTI DEM 없음");
  const started = globalThis.performance?.now?.() ?? Date.now();
  const S = makeSurface(e, buildings, kind === "B2" ? data.dem : null);
  const d = new Drawing(), { P, scale } = projection(ctx);
  const result = kind === "B1"
    ? windPlate(env, opts, S, d, P)
    : coldPlate(env, S, d, P);

  // Light building figures are drawn last so flow lines do not cover footprints.
  for (const building of buildings) {
    const rings = [building.polygon, ...building.holes]
      .map(r => clipRing(r, e)).filter(r => r.length >= 3)
      .map(r => r.map(p => P(...p)));
    d.poly(rings, "#EEF0F2", "#94A3B8", .1, "bld");
  }
  const site = ctx.site?.ring;
  if (kind === "B1" && ctx.shape?.kind === "circle" && site?.length > 8) {
    // the analysis runs on the square extent; what lies outside the circular site is context only
    const outer = [[e[0], e[1]], [e[2], e[1]], [e[2], e[3]], [e[0], e[3]]].map(p => P(...p));
    d.svg.push(`<path d="${pathD(outer, true)}${pathD(site.map(p => P(...p)), true)}" fill="#FFFFFF" fill-rule="evenodd" opacity=".72" stroke="none"/>`);
  }
  if (site?.length) {
    const ring = clipRing(site, e);
    if (ring.length >= 3) d.poly([ring.map(p => P(...p))],
      "none", "#B87D5B", .35, "site");
  }
  const c = ctx.center || [(e[0] + e[2]) / 2, (e[1] + e[3]) / 2];
  if (c[0] >= e[0] && c[0] <= e[2] && c[1] >= e[1] && c[1] <= e[3]) {
    d.dot(P(...c), 2.4, "#E6B89C", "#B87D5B", .5);
  }
  d.dot([326, 142], 2.1, "#E6B89C", "#B87D5B", .4);
  d.text(336, 143, "대지 중심", 2.5);
  d.rect(322, 150, 10, 3.5, "#EEF0F2", "#94A3B8");
  d.text(336, 153, "주변 건물", 2.5);

  const target = 50 / scale;
  const power = 10 ** Math.floor(Math.log10(target));
  const lengths = [1, 2, 5, 10].map(v => v * power);
  const length = lengths.reduce((a, b) =>
    Math.abs(b - target) < Math.abs(a - target) ? b : a);
  for (let i = 0; i < 4; i++) {
    d.rect(18 + i * length * scale / 4, 250,
      length * scale / 4, 1.5, i % 2 ? "#FFFFFF" : INK, INK, .15);
  }
  d.text(18, 257, "0", 2.4);
  d.text(18 + length * scale, 257, `${length} m`, 2.4, "end");
  d.text(18, 263, `A3 100% · 1:${Math.round(1000 / scale)}`, 2.2);
  d.line([[104, 260], [104, 247]], INK, .3);
  d.arrow([104, 260], [104, 247], INK, 3);
  d.text(104, 243, "N", 3.3, "middle");
  d.text(122, 256,
    ctx.convergence ? "진북 기준 평면" : "격자북 기준 평면", 2.3);

  d.rect(4, 4, 412, 289, "none", EDGE, .2, "frame");
  d.text(12, 17, spec.ko, 8);
  d.text(12, 24, spec.fr, 3.8, "start", SUB);
  d.text(408, 14, `${kind} · A3`, 3.6, "end");
  d.text(408, 20, `${Math.round(e[2] - e[0])} × ${Math.round(e[3] - e[1])} m`,
    2.4, "end", SUB);
  // Exactly two footer note lines; textLength bounds multilingual rendering.
  const noteStart = d.svg.length;
  d.text(12, 275, result.source, 2.1, "start", SUB);
  d.text(12, 282, result.note, 2.05);
  // squeeze a footer line only when it would overrun the 390 mm frame; forcing textLength on a short
  // line stretched its glyphs to several times their size (live review, Gemini)
  [[result.source, 2.1], [result.note, 2.05]].forEach(([t, size], k) => {
    const est = [...String(t)].reduce((w, ch) => w + (ch.charCodeAt(0) < 128 ? .52 : 1), 0) * size;
    if (est > 390) d.svg[noteStart + k] = d.svg[noteStart + k].replace("<text ",
      '<text textLength="390" lengthAdjust="spacingAndGlyphs" ');
  });
  const notes = [result.source, result.note];
  const sources = kind === "B1"
    ? ["BD TOPO® V3", "EPW TMYx", "Hong Kong AVA",
       "Gál & Unger 2009", "Wong et al. 2010",
       "Grimmond & Oke / Bottema: roughness concepts; custom proxy formula"]
    : ["BD TOPO® V3", "RGE ALTI", "Vegetation/open-ground proxy"];
  const sheet = {
    layers: [...d.groups.values()].filter(g => g.id !== "text"),
    legend: d.legend, notes, sources
  };
  if (d.groups.has("text")) sheet.layers.push(d.groups.get("text"));
  const ctx2 = {
    extent: [0, 0, W, H], center: [W / 2, H / 2],
    site: { ring: [] }, address: ctx.address,
    radiusLabel: "A3 가로 · 좌표 mm", date: ctx.date, paperMm: true
  };
  const def = { num: kind, ko: spec.ko + " (평면)", en: kind.toLowerCase() + "-plate" };
  const finished = globalThis.performance?.now?.() ?? Date.now();
  const stats = {
    ...result.stats, elapsedMs: finished - started,
    north: ctx.convergence ? "true" : "grid",
    warning: DISCLAIMER
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="0 0 ${W} ${H}" font-family="${esc(FONT)}">` +
    `<rect width="${W}" height="${H}" fill="#FFFFFF"/>` +
    d.svg.join("") + "</svg>";
  return { svg, sheet, ctx2, def, stats };
}
