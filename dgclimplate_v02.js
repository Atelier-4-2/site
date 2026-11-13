// Climate plates (다이어그램 보기) for the analysis tabs A2 sun / A3 wind / A4 thermal comfort.
// Vector SVG, orthographic axonometric from the south-east (azimuth 135 deg, elevation 35 deg), A3 landscape (420 x 297 mm).
// Ported from SiteLaser/web/drafts/climate (common.js, draft-a2/a3/a4.js), re-targeted at the real site (ctx, buildings, DEM
// surface, EPW station) with the climate-only colour set (briefs/sitelaser_climate_build_v01.md).
// Owner graphic rules: white background, line based, no hatch, Noto Sans, no area labels. #E6B89C / #B87D5B only on the site.
import { sunPosition, parisDate, daySun, shadowMask, nearestStation } from "./dgenv.js?v=20261113u";
import { heightOf } from "./dganalysis.js?v=20261113p";
import { UTCI_CATS, UTCI_RANGE, utciCat, utciShade, utciSun, deltaMrtSun, clearSkyDni } from "./dgutci.js?v=20261113x";

const RAD = Math.PI / 180, PT = 0.3528;                 // 1 pt in mm
const FONT = "'Noto Sans','Noto Sans KR','Malgun Gothic',sans-serif";
const H = 297, W = 420;

// ---- climate colour set (fixed science-convention colours; same values as the 3D views use) -------------------------------
export const CLIMATE = {
  sun: { summer: "#D55E00", equinox: "#E69F00", winter: "#0072B2", h9: "#3B7EA1", h12: "#1E293B", h15: "#6B3FA0",
    hours: ["#FDE74C", "#F9A620", "#E34A33", "#B30059", "#5E0035"], hoursEdge: "#1E293B" },
  wind: { calm: "#E2E8F0", bins: ["#7FBC8C", "#41B6C4", "#1D91C0", "#225EA8", "#081D58"], arrow1: "#081D58", arrow2: "#1D91C0",
    season: { 2: "#009E73", 3: "#E69F00", 4: "#6B3FA0", 1: "#0072B2" } },
  ink: "#1E293B", sub: "#475569", ring: "#CBD5E1", bld: "#94A3B8", site: "#E6B89C", siteLine: "#B87D5B"
};
export const SPEED_LABELS = ["0.5–2", "2–4", "4–6", "6–8", "8 이상"];
const SEASONS = [{ ko: "연간", fr: "Annuel" }, { ko: "겨울", fr: "Hiver" }, { ko: "봄", fr: "Printemps" }, { ko: "여름", fr: "Été" }, { ko: "가을", fr: "Automne" }];
const DIRS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

// ---- Korean strings (temporary, listed in briefs/sitelaser_ko_strings.md section "기후 다이어그램") ------------------------------
export const KO_PLATE = {
  "plate.view3d": "3D 보기", "plate.viewPlate": "다이어그램",
  "plate.sun.title": "태양 경로와 그림자 — 하지·춘분·동지", "plate.sun.fr": "Trajectoires solaires et ombres portées",
  "plate.wind.title": "바람장미 — 연간 주풍향", "plate.wind.fr": "Rose des vents annuelle · vents dominants",
  "plate.utci.title": "미기후 점 격자", "plate.utci.fr": "Grille de points : UTCI estimé",
  "plate.utci.note": "UTCI(Bröde 2012 다항식) · 월평균 기상 + 맑은 날 일사 가정 · 그늘 여부만 반영, 바람 차폐·반사 미반영 · 초기 설계용 추정치",
  "plate.utci.src": "구간 Bröde et al. 2012, 색 Terrain",
  "plate.sunhours": "일조시간 (h)", "plate.calm": "정온 < 0.5 m/s",
  "plate.pin.sun": "양지", "plate.pin.shade": "그늘", "plate.pin.night": "일사 없음"
};

// ---- primitive recorder: one list drives both the SVG and the CAD sheet ---------------------------------------------------
const f2 = n => String(Math.round(n * 100) / 100);
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dOf = (pts, close) => "M" + pts.map(p => f2(p[0]) + " " + f2(p[1])).join("L") + (close ? "Z" : "");
const dash = a => (a ? a.map(v => f2(v * PT)).join(" ") : "");           // dash patterns are given in pt

class Dwg {
  constructor() { this.items = []; this.legend = []; }
  path(pts, o = {}) { if (pts.length > 1) this.items.push({ t: "p", pts, layer: "line", ...o }); return this; }
  poly(pts, o = {}) { return this.path(pts, { ...o, close: true }); }
  area(shapes, fill, clip = null) { this.items.push({ t: "area", shapes, fill, clip, skipCad: true }); return this; }
  circ(x, y, r, o = {}) { this.items.push({ t: "c", x, y, r, layer: "line", ...o }); return this; }
  ell(x, y, rx, ry, o = {}) { this.items.push({ t: "e", x, y, rx, ry, layer: "line", ...o }); return this; }
  rect(x, y, w, h, o = {}) { return this.poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], o); }
  text(x, y, s, o = {}) { this.items.push({ t: "t", x, y, s, layer: "text", size: 2.6, weight: 400, fill: CLIMATE.ink, anchor: "start", ...o }); return this; }
  line(a, b, o = {}) { return this.path([a, b], o); }
  arrow(a, b, len, wid, fill, layer) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    return this.poly([b, [b[0] - ux * len - uy * wid, b[1] - uy * len + ux * wid], [b[0] - ux * len + uy * wid, b[1] - uy * len - ux * wid]], { fill, stroke: fill, w: .1, layer: layer || "line" });
  }
  wrap(x, y, s, maxW, o = {}) {
    const size = o.size || 2.3, lh = o.lh || size * 1.45, lines = wrapText(s, maxW, size);
    lines.forEach((l, i) => this.text(x, y + i * lh, l, o));
    return lines.length * lh;
  }
  svg() {
    return this.items.map(it => {
      const site = it.layer === "site" ? ' data-l="site"' : "";
      if (it.t === "area") {
        const paths = it.shapes.map(rings => `<path d="${rings.map(ring => dOf(ring, true)).join("")}" fill="${it.fill}" fill-rule="evenodd" stroke="none"/>`).join("");
        return it.clip ? `<defs><clipPath id="a2-shadow-clip"><path d="${dOf(it.clip, true)}"/></clipPath></defs><g clip-path="url(#a2-shadow-clip)">${paths}</g>` : paths;
      }
      if (it.t === "p") {
        const da = it.dash ? ` stroke-dasharray="${dash(it.dash)}"` : "";
        return `<path d="${dOf(it.pts, it.close)}" fill="${it.fill || "none"}" stroke="${it.stroke || CLIMATE.ink}" stroke-width="${f2(it.w ?? .2)}"${da} stroke-linejoin="round" stroke-linecap="${it.cap || "butt"}"${it.op ? ` opacity="${it.op}"` : ""}${site}/>`;
      }
      if (it.t === "c") return `<circle cx="${f2(it.x)}" cy="${f2(it.y)}" r="${f2(it.r)}" fill="${it.fill || "none"}" stroke="${it.stroke || "none"}" stroke-width="${f2(it.w ?? .2)}"${site}/>`;
      if (it.t === "e") return `<ellipse cx="${f2(it.x)}" cy="${f2(it.y)}" rx="${f2(it.rx)}" ry="${f2(it.ry)}" fill="${it.fill || "none"}" stroke="${it.stroke || "none"}" stroke-width="${f2(it.w ?? .1)}"${it.op == null ? "" : ` opacity="${it.op}"`}/>`;
      const attrs = `x="${f2(it.x)}" y="${f2(it.y)}" font-size="${it.size}" font-weight="${it.weight}" text-anchor="${it.anchor}"`;
      const rot = it.rot ? ` transform="rotate(${f2(it.rot)} ${f2(it.x)} ${f2(it.y)})"` : "";
      const halo = it.halo ? `<text ${attrs} fill="#fff" stroke="#fff" stroke-width="${f2(it.size * .4)}" stroke-linejoin="round"${rot}>${esc(it.s)}</text>` : "";
      return halo + `<text ${attrs} fill="${it.fill}"${rot}>${esc(it.s)}</text>`;
    }).join("");
  }
  // CAD sheet in paper millimetres (y up). Outlines only, no fills.
  sheet(def, notes, sources) {
    const LAYERS = { site: "대지", bld: "맥락 건물", ring: "방위 링", sun: "태양 경로", shadow: "그림자 외곽선", rose: "풍배도", arrow: "주풍향", utci: "UTCI 점", line: "도면 보조선", text: "문자" };
    const groups = new Map();
    const g = id => { if (!groups.has(id)) groups.set(id, { id, name: LAYERS[id] || id, items: [] }); return groups.get(id).items; };
    const cad = p => [p[0], H - p[1]];
    for (const it of this.items) {
      if (it.skipCad) continue;
      if (it.t === "p") {
        const col = it.stroke || (it.fill && it.fill !== "none" ? it.fill : CLIMATE.ink);
        if (it.close) g(it.layer).push({ k: "poly", rings: [it.pts.map(cad)], fill: "none", stroke: col, sw: it.w ?? .2, dash: it.dash ? it.dash.map(v => v * PT) .join(" ") : null });
        else g(it.layer).push({ k: "line", pts: it.pts.map(cad), stroke: col, sw: it.w ?? .2, dash: it.dash ? it.dash.map(v => v * PT).join(" ") : null });
      } else if (it.t === "c" || it.t === "e") {
        g(it.layer).push({ k: "dot", p: cad([it.x, it.y]), r: it.r ?? (it.rx + it.ry) / 2, fill: it.fill && it.fill !== "none" ? it.fill : null, stroke: it.stroke && it.stroke !== "none" ? it.stroke : it.fill, sw: it.w ?? .1 });
      } else if (it.t === "t") g("text").push({ k: "text", p: cad([it.x, it.y]), text: it.s, fill: it.fill, hm: it.size });
    }
    const layers = [...groups.values()].filter(l => l.items.length && l.id !== "text");
    layers.push(...(groups.has("text") ? [groups.get("text")] : []));
    return { layers, legend: this.legend, notes, sources };
  }
}

// text width estimate (mm) for wrapping / boxes
const cw = ch => ch.charCodeAt(0) > 0x2E7F ? 1 : ch === " " ? .3 : /[A-Z0-9]/.test(ch) ? .62 : .52;
const textWidth = (s, size) => [...s].reduce((a, c) => a + cw(c), 0) * size;
function wrapText(s, maxW, size) {
  const words = s.split(/(?<=[ ·,;)\]])/); const lines = []; let cur = "";
  for (const w of words) { if (cur && textWidth(cur + w, size) > maxW) { lines.push(cur.trim()); cur = w; } else cur += w; }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}

// ---- site data ------------------------------------------------------------------------------------------------------
const ringArea = r => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
function inRing(ring, x, y) {
  let r = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) r = !r;
  }
  return r;
}
const openRing = r => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) ? r.slice(0, -1) : r;
const prepMemo = new WeakMap();
function prepBuildings(ctx, data) {
  const key = data.buildings, hit = prepMemo.get(key);
  if (hit && hit.ring === ctx.site.ring) return hit.list;
  const list = [];
  let unk = 0;
  for (const b of data.buildings) {
    const outer = openRing(b.polygon);
    let sx = 0, sy = 0; for (const q of outer) { sx += q[0]; sy += q[1]; }
    const mx = sx / outer.length, my = sy / outer.length;
    if (!inRing(ctx.site.ring, mx, my)) continue;
    const hh = heightOf(b);
    if (hh == null) unk++;
    list.push({ outer, holes: b.holes.map(openRing), h: hh == null ? 3 : hh, mx, my });
  }
  list.unknown = unk;
  prepMemo.set(key, { ring: ctx.site.ring, list });
  return list;
}

// ---- orthographic axonometric ---------------------------------------------------------------------------------------
class Axo {
  constructor(ctx, az = 135, el = 35) {
    this.c = ctx.center; this.az = az; this.el = el * RAD; const a = az * RAD;
    this.r = [-Math.cos(a), Math.sin(a)]; this.f = [-Math.sin(a), -Math.cos(a)]; this.cam = [Math.sin(a), Math.cos(a)];
    this.s = 1; this.ox = 0; this.oy = 0;
  }
  raw(x, y, z = 0) {
    const X = x - this.c[0], Y = y - this.c[1];
    return [X * this.r[0] + Y * this.r[1], -(z * Math.cos(this.el) + (X * this.f[0] + Y * this.f[1]) * Math.sin(this.el))];
  }
  depth(x, y) { return (x - this.c[0]) * this.f[0] + (y - this.c[1]) * this.f[1]; }
  fit(pts, vp) {
    let a = 1e12, b = 1e12, c = -1e12, d = -1e12;
    for (const p of pts) { const r = this.raw(p[0], p[1], p[2] || 0); a = Math.min(a, r[0]); c = Math.max(c, r[0]); b = Math.min(b, r[1]); d = Math.max(d, r[1]); }
    this.s = Math.min(vp.w / (c - a), vp.h / (d - b));
    this.ox = vp.x + (vp.w - (c - a) * this.s) / 2 - a * this.s; this.oy = vp.y + (vp.h - (d - b) * this.s) / 2 - b * this.s;
    return this;
  }
  P(x, y, z = 0) { const r = this.raw(x, y, z); return [this.ox + r[0] * this.s, this.oy + r[1] * this.s]; }
  G(pts, z = 0) { return pts.map(p => this.P(p[0], p[1], z)); }
  circle(cx, cy, r, z = 0, n = 180) { return Array.from({ length: n + 1 }, (_, i) => { const a = i / n * 2 * Math.PI; return this.P(cx + r * Math.sin(a), cy + r * Math.cos(a), z); }); }
  north() { const a = this.raw(this.c[0], this.c[1]), b = this.raw(this.c[0], this.c[1] + 1); const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy); return [dx / L, dy / L]; }
}

function drawBuildings(d, ax, list) {
  const sorted = list.slice().sort((a, b) => ax.depth(b.mx, b.my) - ax.depth(a.mx, a.my));
  for (const b of sorted) {
    const addWalls = (ring, hole) => {
      const sg = (ringArea(ring) > 0 ? 1 : -1) * (hole ? -1 : 1);
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        const nx = (q[1] - p[1]) * sg, ny = -(q[0] - p[0]) * sg;
        if (nx * ax.cam[0] + ny * ax.cam[1] <= 0) continue;
        d.poly([ax.P(p[0], p[1], 0), ax.P(q[0], q[1], 0), ax.P(q[0], q[1], b.h), ax.P(p[0], p[1], b.h)], { fill: "#fff", stroke: CLIMATE.bld, w: .09, layer: "bld" });
      }
    };
    addWalls(b.outer, false); b.holes.forEach(r => addWalls(r, true));
    const roof = [b.outer, ...b.holes].map(ring => ax.G(ring, b.h));
    if (b.holes.length) d.area([roof], "#fff");
    for (const ring of roof) {
      d.poly(ring, { fill: b.holes.length ? "none" : "#fff", stroke: CLIMATE.bld, w: .09, layer: "bld" });
    }
  }
}

function drawExtent(d, ax, ctx) {
  d.poly(ax.G(ctx.site.ring), { stroke: CLIMATE.ring, w: .3, layer: "ring" });
}

function siteMarker(d, x, y) {
  d.circ(x, y, 3.1, { fill: "#fff", skipCad: true });
  d.circ(x, y, 2.4, { fill: CLIMATE.site, stroke: CLIMATE.siteLine, w: .55, layer: "site" });
}

function siteKey(d, x, y) {
  siteMarker(d, x + 4, y - 1);
  d.text(x + 11, y, "대지 중심점", { size: 2.5 });
}

function drawRing(d, ax, ctx, R) {
  const [cx, cy] = ctx.center;
  d.path(ax.circle(cx, cy, R), { stroke: CLIMATE.ring, w: .3, layer: "ring" });
  for (let a = 0; a < 360; a += 15) {
    const major = a % 90 === 0, mid = a % 45 === 0, l = major ? 7 : mid ? 5 : 3;
    d.line(ax.P(cx + R * Math.sin(a * RAD), cy + R * Math.cos(a * RAD)), ax.P(cx + (R - l) * Math.sin(a * RAD), cy + (R - l) * Math.cos(a * RAD)), { stroke: CLIMATE.ring, w: major ? .35 : .2, layer: "ring" });
  }
  [["N", 0], ["E", 90], ["S", 180], ["W", 270]].forEach(([t, a]) => {
    const p = ax.P(cx + (R - 16) * Math.sin(a * RAD), cy + (R - 16) * Math.cos(a * RAD));
    d.text(p[0], p[1] + 1.4, t, { size: 4, weight: 600, anchor: "middle", halo: true });
  });
}

function scaleBar(d, x, y, s) {
  const target = 55 / s;
  const L = [10, 20, 25, 50, 100, 200, 250, 500].reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a);
  const mm = L * s, n = L === 25 || L === 250 ? 5 : L === 10 ? 5 : 4;
  for (let i = 0; i < n; i++) { const a = x + mm * i / n; d.rect(a, y - 1.4, mm / n, 1.4, { stroke: CLIMATE.ink, w: .18, fill: i % 2 ? "#fff" : CLIMATE.ink, layer: "line" }); }
  d.text(x, y + 3.4, "0", { size: 2.4, anchor: "middle" }).text(x + mm, y + 3.4, L + " m", { size: 2.4, anchor: "middle" });
  d.text(x, y + 7, `A3 출력 시 약 1:${Math.round(1000 / s / 100) * 100} (수평 방향 기준)`, { size: 2.1, fill: CLIMATE.sub });
}
function northArrow(d, x, y, dir, len = 13) {
  const a = [x - dir[0] * len / 2, y - dir[1] * len / 2], b = [x + dir[0] * len / 2, y + dir[1] * len / 2];
  d.circ(x, y, len * .62, { stroke: CLIMATE.ring, w: .15 }).line(a, b, { w: .3 }).arrow(a, b, 3.4, 1.2, CLIMATE.ink);
  d.text(b[0] + dir[0] * 3.6, b[1] + dir[1] * 3.6 + 1.2, "N", { size: 3.4, weight: 600, anchor: "middle" });
}

// sheet frame + footer; returns the svg string (no width/height so PNG export can size it)
function frame(d, ctx, o) {
  const head = new Dwg();
  head.rect(0, 0, W, H, { fill: "#fff", stroke: "none", layer: "line", w: 0, skipCad: true });
  head.rect(4, 4, W - 8, H - 8, { stroke: CLIMATE.ring, w: .2 });
  head.text(12, 17, o.ko, { size: 8, weight: 600 }).text(12, 24, o.fr, { size: 3.8, fill: CLIMATE.sub });
  head.text(W - 12, 14, o.id, { size: 3.6, weight: 600, anchor: "end" });
  if (o.ref) head.text(W - 12, 19.5, "참고 · " + o.ref, { size: 2.1, fill: CLIMATE.sub, anchor: "end" });
  let y = 274;
  y += head.wrap(12, y, o.src, 396, { size: 2.1, fill: CLIMATE.sub }) + .6;
  head.wrap(12, y, o.honest, 396, { size: 2.3, fill: CLIMATE.ink });
  // head goes first so its white background is below the drawing
  d.items.unshift(...head.items);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="${FONT}">${d.svg()}</svg>`;
}
const srcLine = (ctx, list, extra = "", terrain = "") => {
  const side = Math.round(ctx.extent[2] - ctx.extent[0]);
  return `건물: © IGN BD TOPO V3 ${list.length}동 표시, 높이 미기재 ${list.unknown}동은 3 m 가정${terrain} · 대지: ${ctx.address}, ${ctx.radiusLabel}(분석 범위 ${side} m) · 카메라: 정투영 축측, 남동쪽(방위 135°) 고도 35°${extra} · 참고용 시뮬레이션, 법적 효력 없음`;
};
const stationLine = (st, km) => `${st.name} · WMO ${st.wmo} · 대지에서 약 ${km.toFixed(1)} km · EPW TMYx 2011–2025 (지상 10 m 풍속)`;

function fitPoints(ctx, maxH, extra = []) {
  const pts = [];
  for (const p of ctx.site.ring) { pts.push([p[0], p[1], 0], [p[0], p[1], maxH]); }
  return pts.concat(extra);
}
const extentHalf = ctx => Math.min(ctx.extent[2] - ctx.extent[0], ctx.extent[3] - ctx.extent[1]) / 2;

// Project the actual roof and walls of each extruded footprint onto z=0.
// The opaque, same-colour faces form the union without darkening overlaps.
export function projectedShadowFaces(building, az, alt) {
  const { outer, holes, h } = building;
  const distance = h / Math.tan(alt);
  const dx = -distance * Math.sin(az), dy = -distance * Math.cos(az);
  const roof = ([x, y]) => [x + dx, y + dy];
  const rings = [outer, ...holes];
  const faces = [rings.map(ring => ring.map(roof))];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      faces.push([[a, b, roof(b), roof(a)]]);
    }
  }
  return faces;
}
const gridAzimuth = (ctx, az) => az + (ctx.convergence || 0) * RAD;
const sunAt = (ctx, m, d, hour) => { const p = sunPosition(parisDate(2026, m, d, hour), ctx.lat, ctx.lon); return { az: gridAzimuth(ctx, p.az), alt: p.alt, up: p.alt > 2 * RAD }; };

// =============================================================================================================================
// A2 sun
// =============================================================================================================================
const DAYS = [
  { id: "summer", m: 6, d: 21, ko: "하지 6/21", color: CLIMATE.sun.summer, w: 1.8, dash: null },
  { id: "equinox", m: 3, d: 20, ko: "춘분 3/20", color: CLIMATE.sun.equinox, w: 1.5, dash: [6, 3] },
  { id: "winter", m: 12, d: 21, ko: "동지 12/21", color: CLIMATE.sun.winter, w: 1.5, dash: [3, 3] }
];
const HOURS = [{ h: 9, color: CLIMATE.sun.h9, w: .85, dash: [5, 3] }, { h: 12, color: CLIMATE.sun.h12, w: .95, dash: null }, { h: 15, color: CLIMATE.sun.h15, w: .85, dash: [7, 3, 2, 3] }];
export const SHADOW_DAYS = DAYS.map(({ id, ko }) => ({ id, label: ko }));
export const SHADOW_HOURS = HOURS.map(({ h }) => h);

function plateA2(env) {
  const { ctx, data } = env, list = prepBuildings(ctx, data);
  const d = new Dwg(), ax = new Axo(ctx), half = extentHalf(ctx), R = half * .9, maxH = Math.max(10, ...list.map(b => b.h));
  const [cx, cy] = ctx.center;
  const sunPt = (s, r = R) => [cx + r * Math.cos(s.alt) * Math.sin(s.az), cy + r * Math.cos(s.alt) * Math.cos(s.az), r * Math.sin(s.alt)];
  const track = (dy, step) => daySun(2026, dy.m, dy.d, ctx.lat, ctx.lon, step).map(s => ({ ...s, az: gridAzimuth(ctx, s.az) }));
  const ext = fitPoints(ctx, maxH, track(DAYS[0], 30).map(s => sunPt(s)));
  ext.push([cx, cy + R + 14, 0], [cx, cy - R - 14, 0], [cx + R + 14, cy, 0], [cx - R - 14, cy, 0]);
  ax.fit(ext, { x: 100, y: 28, w: 312, h: 242 });
  drawExtent(d, ax, ctx);
  // Draw the selected time slice on the same flat plane as the building bases.
  const shadowDay = DAYS.find(day => day.id === env.shadowDay) || DAYS[0];
  const shadowHour = HOURS.find(hour => hour.h === env.shadowHour) || HOURS[1];
  const shadowSun = sunAt(ctx, shadowDay.m, shadowDay.d, shadowHour.h);
  const shadowFill = "#CCDCE7";
  if (shadowSun.up) {
    const faces = list.flatMap(b => projectedShadowFaces(b, shadowSun.az, shadowSun.alt));
    if (faces.length) d.area(faces.map(rings => rings.map(ring => ax.G(ring))), shadowFill, ax.G(ctx.site.ring));
  }
  drawBuildings(d, ax, list);
  drawRing(d, ax, ctx, R);
  const maxAlt = {};
  for (const dy of DAYS) {
    const samples = track(dy, 10);
    maxAlt[dy.id] = Math.max(...samples.map(s => s.alt)) / RAD;
    d.path(samples.map(s => { const p = sunPt(s); return ax.P(p[0], p[1], p[2]); }), { stroke: dy.color, w: dy.w * PT, dash: dy.dash, layer: "sun" });
    for (const hr of HOURS) {
      const s = sunAt(ctx, dy.m, dy.d, hr.h); if (!s.up) continue;
      const p = sunPt(s), q = ax.P(p[0], p[1], p[2]);
      d.circ(q[0], q[1], 2, { fill: "#fff", layer: "sun" }).circ(q[0], q[1], 1.25, { fill: dy.color, stroke: dy.color, w: .1, layer: "sun" });
      d.text(q[0] + 2.6, q[1] - 1.4, hr.h + "시", { size: 2.2, halo: true });
    }
  }
  siteMarker(d, ...ax.P(cx, cy));
  // legend column
  let y = 38; const X = 12;
  d.text(X, y, `태양 궤적 (반경 ${Math.round(R)} m 천구)`, { size: 2.9, weight: 600 }); y += 5;
  for (const dy of DAYS) {
    d.line([X, y - .8], [X + 14, y - .8], { stroke: dy.color, w: dy.w * PT, dash: dy.dash, layer: "sun" });
    d.text(X + 17, y, `${dy.ko}  최대 고도 ${maxAlt[dy.id].toFixed(1)}°`, { size: 2.5 }); y += 4.4;
    d.legend.push({ kind: "line", stroke: dy.color, sw: dy.w * PT, dash: dy.dash ? dy.dash.map(v => v * PT).join(" ") : null, label: `${dy.ko} 태양 궤적` });
  }
  d.circ(X + 4, y - .8, 2, { fill: "#fff" }).circ(X + 4, y - .8, 1.25, { fill: CLIMATE.sun.summer, stroke: CLIMATE.sun.summer, w: .1 });
  d.text(X + 17, y, "9 · 12 · 15시 태양 (파리 시간, 흰 후광)", { size: 2.5 }); y += 8;
  d.text(X, y, "지면 그림자", { size: 2.9, weight: 600 }); y += 5;
  const shadowLabel = `${shadowDay.ko} · ${shadowHour.h}시 (파리 시간)`;
  if (shadowSun.up) {
    d.area([[[[X, y - 3], [X + 14, y - 3], [X + 14, y], [X, y]]]], shadowFill);
    d.text(X + 17, y, shadowLabel, { size: 2.5 });
    y += 4.5;
    d.text(X, y, "건물 외곽과 높이를 평평한 지면에 투영", { size: 2.2, fill: CLIMATE.sub });
  } else {
    d.text(X, y, shadowLabel, { size: 2.5 });
    y += 4.5;
    d.text(X, y, "태양 고도 2° 이하 · 그림자 표시 없음", { size: 2.2, fill: CLIMATE.sub });
  }
  y += 8;
  d.text(X, y, "도면 기호", { size: 2.9, weight: 600 }); y += 5;
  siteKey(d, X, y); y += 6;
  d.line([X, y - 1], [X + 8, y - 1], { stroke: CLIMATE.ring, w: .3, layer: "ring" });
  d.text(X + 11, y, "분석 범위", { size: 2.5 }); y += 4.6;
  d.rect(X, y - 2.6, 8, 3.2, { stroke: CLIMATE.bld, w: .12, fill: "#fff", layer: "bld" }); d.text(X + 11, y, "맥락 건물 (BD TOPO, 높이 반영)", { size: 2.5 }); y += 4.6;
  d.line([X, y - 1], [X + 8, y - 1], { stroke: CLIMATE.ring, w: .3, layer: "ring" }); d.text(X + 11, y, `방위 링 · 15° 눈금 · 반경 ${Math.round(R)} m`, { size: 2.5 });
  scaleBar(d, X + 4, 252, ax.s); northArrow(d, X + 74, 250, ax.north());
  const out = frame(d, ctx, {
    id: "A2 · 다이어그램", ko: KO_PLATE["plate.sun.title"], fr: KO_PLATE["plate.sun.fr"], ref: "Andrew Marsh 3D Sun-Path · Ladybug Sunpath",
    src: srcLine(ctx, list, " · 태양: Meeus/SunCalc 식(dgenv.js), 파리 시간"),
    honest: "그림자는 표시된 건물의 외곽과 높이를 평평한 지면에 투영한 결과. 실제 지형의 고저차와 수목은 제외. 태양 궤적은 대지 중심에서 본 천구 투영. 방위는 Lambert-93 격자 북 기준."
  });
  return { svg: out, d, list, stats: { maxAlt, shadowDay: shadowDay.id, shadowHour: shadowHour.h, shadowVisible: shadowSun.up } };
}

// =============================================================================================================================
// A3 wind
// =============================================================================================================================
function roseOf(st, p) {
  const cells = st.rose[p], total = st.total[p];
  const dirs = cells.map((c, di) => { const bins = [c[1], c[2], c[3], c[4], c[5] + c[6]].map(n => n / total * 100); return { d: di, bins, tot: bins.reduce((a, b) => a + b, 0) }; });
  return { dirs, calm: st.calm[p] / total * 100, max: Math.max(...dirs.map(x => x.tot)), total };
}
const topDirs = (rose, n = 2) => [...rose.dirs].sort((a, b) => b.tot - a.tot).slice(0, n);
function petal(map, r0, r1, a0, a1) {
  const pts = [];
  for (let t = 0; t <= 4; t++) pts.push(map(r1, a0 + (a1 - a0) * t / 4));
  for (let t = 4; t >= 0; t--) pts.push(map(r0, a0 + (a1 - a0) * t / 4));
  return pts;
}
function drawRose(d, map, rose, r0, len, sw = .1) {
  for (const dr of rose.dirs) {
    let acc = r0; const a = dr.d * 22.5;
    dr.bins.forEach((pct, b) => {
      if (pct <= 0) return;
      const r1 = acc + pct * len;
      d.poly(petal(map, acc, r1, a - 8, a + 8), { fill: CLIMATE.wind.bins[b], stroke: CLIMATE.sub, w: sw, layer: "rose" });
      acc = r1;
    });
  }
}
function miniRose(d, cxp, cyp, R, rose, pctMax, title, sub, dotColor) {
  const k = R / pctMax, map = (r, a) => [cxp + r * Math.sin(a * RAD), cyp - r * Math.cos(a * RAD)];
  [5, 10, 15].forEach(p => { if (p <= pctMax * 1.0001) d.circ(cxp, cyp, p * k, { stroke: CLIMATE.ring, w: .12 }); });
  d.line([cxp, cyp - R - 1], [cxp, cyp + R + 1], { stroke: CLIMATE.ring, w: .1 }).line([cxp - R - 1, cyp], [cxp + R + 1, cyp], { stroke: CLIMATE.ring, w: .1 });
  drawRose(d, map, rose, 0, k, .08);
  d.text(cxp, cyp - R - 2.4, "N", { size: 2.4, weight: 600, anchor: "middle" });
  const tw = textWidth(title, 2.8);
  if (dotColor) d.circ(cxp - tw / 2 - 2, cyp + R + 4.2, 1.1, { fill: dotColor, stroke: CLIMATE.sub, w: .1 });
  d.text(cxp + (dotColor ? 1.2 : 0), cyp + R + 5, title, { size: 2.8, weight: 600, anchor: "middle" });
  d.text(cxp, cyp + R + 8.3, sub, { size: 2.1, fill: CLIMATE.sub, anchor: "middle" });
}

function plateA3(env) {
  const { ctx, data } = env, list = prepBuildings(ctx, data);
  const { station: st, km } = nearestStation(data.climate, ctx.lat, ctx.lon);
  const d = new Dwg(), ax = new Axo(ctx), half = extentHalf(ctx), R = half * .9, maxH = Math.max(10, ...list.map(b => b.h));
  const [cx, cy] = ctx.center;
  const roses = Object.fromEntries([0, 1, 2, 3, 4].map(p => [p, roseOf(st, p)])), ann = roses[0];
  const box = { x: 18, y: 40, w: 286, h: 196 };
  const [xmin, ymin, xmax, ymax] = ctx.extent;
  ax.s = Math.min(box.w / (xmax - xmin), box.h / (ymax - ymin));
  ax.P = (x, y) => [
    box.x + box.w / 2 + (x - cx) * ax.s,
    box.y + box.h / 2 - (y - cy) * ax.s
  ];
  ax.north = () => [0, -1];
  const clip = ring => {
    let points = openRing(ring);
    const edges = [
      [0, xmin, 1], [0, xmax, -1],
      [1, ymin, 1], [1, ymax, -1]
    ];
    for (const [axis, bound, sign] of edges) {
      const input = points;
      points = [];
      input.forEach((b, i) => {
        const a = input[(i + input.length - 1) % input.length];
        const insideA = sign * (a[axis] - bound) >= 0;
        const insideB = sign * (b[axis] - bound) >= 0;
        if (insideA !== insideB) {
          const t = (bound - a[axis]) / (b[axis] - a[axis]);
          points.push([
            a[0] + t * (b[0] - a[0]),
            a[1] + t * (b[1] - a[1])
          ]);
        }
        if (insideB) points.push(b);
      });
    }
    return points.map(p => ax.P(...p));
  };
  for (const building of data.buildings) {
    const outer = clip(building.polygon);
    if (outer.length < 3) continue;
    const holes = (building.holes || []).map(clip).filter(r => r.length >= 3);
    d.area([[outer, ...holes]], "#EEF0F2");
    for (const ring of [outer, ...holes]) {
      d.poly(ring, {
        stroke: CLIMATE.bld, w: .08, layer: "bld"
      });
    }
  }
  const radius = box.h * .35;
  const pctMax = Math.max(20, Math.ceil(ann.max / 20) * 20);
  const len = radius / pctMax;
  const centre = ax.P(cx, cy);
  const map = (r, a) => [
    centre[0] + r * Math.sin(a * RAD),
    centre[1] - r * Math.cos(a * RAD)
  ];
  const firstPetal = d.items.length;
  drawRose(d, map, ann, 0, len, .08);
  d.items.slice(firstPetal).forEach(item => { item.op = .72; });
  for (let i = 1; i <= 4; i++) {
    const pct = pctMax * i / 4;
    d.circ(...centre, pct * len, {
      stroke: CLIMATE.ring, w: .15, layer: "rose"
    });
    const label = map(pct * len, 45);
    d.text(...label, `${pct} %`, { size: 2.3, halo: true });
  }
  ["N", "E", "S", "W"].forEach((label, i) => {
    const p = map(radius + 7, i * 90);
    d.text(p[0], p[1] + 1, label, {
      size: 3.2, weight: 600, anchor: "middle", halo: true
    });
  });
  const tops = topDirs(ann, 2);
  const dominant = tops[0];
  const tip = map(dominant.tot * len + 6, dominant.d * 22.5);
  d.text(tip[0], tip[1], `주풍 ${DIRS16[dominant.d]} ${dominant.tot.toFixed(1)} %`, {
    size: 3, weight: 600, anchor: "middle", halo: true
  });
  siteMarker(d, ...ax.P(cx, cy));
  // right column: seasonal mini roses (same scale), label dots in the season colours
  const pm = Math.max(5, Math.ceil(Math.max(...[1, 2, 3, 4].map(p => roses[p].max)) / 5) * 5), RM = 15;
  d.text(322, 36, "계절 풍배도 (평면, 같은 눈금)", { size: 2.7, weight: 600 });
  [2, 3, 4, 1].forEach((p, i) => {
    const dominant = topDirs(roses[p], 1)[0];
    miniRose(d, 340 + (i % 2) * 46, 62 + Math.floor(i / 2) * 47, RM, roses[p], pm, `${SEASONS[p].ko} · ${DIRS16[dominant.d]} ${dominant.tot.toFixed(0)} %`, "", null);
  });
  let y = 150; const X = 322;
  d.text(X, y, "풍속 구간 (m/s)", { size: 2.5, weight: 600 });
  const rows = [[CLIMATE.wind.calm, KO_PLATE["plate.calm"]], ...CLIMATE.wind.bins.map((c, i) => [c, SPEED_LABELS[i] + " m/s"])];
  rows.forEach(([c, t], i) => { const yy = y + 4 + i * 4.2; d.rect(X, yy - 2.6, 9, 3.2, { fill: c, stroke: CLIMATE.sub, w: .1, layer: "rose" }); d.text(X + 12, yy, t, { size: 2.4 }); d.legend.push({ kind: "line", stroke: c, sw: .3, label: "풍속 " + t }); });
  y += 4 + rows.length * 4.2 + 2;
  d.text(X, y, "꽃잎 = 바람이 불어오는 방향 · 길이 = 빈도(%)", { size: 2.1 }); y += 3.6;

  d.text(X, y, `연간 정온(< 0.5 m/s) ${ann.calm.toFixed(1)} %`, { size: 2.3 }); y += 5;



  siteKey(d, X, y); y += 5.5;

  scaleBar(d, 14, 252, ax.s); northArrow(d, 90, 250, ax.north());
  const out = frame(d, ctx, {
    id: "A3 · 다이어그램", ko: KO_PLATE["plate.wind.title"], fr: KO_PLATE["plate.wind.fr"], ref: "Eddy3D 원형 도메인 · Ladybug Wind Rose",
    src: `건물: © IGN BD TOPO V3 · 기상: ${stationLine(st, km)}`,
    honest: "참고용 · 국소 CFD 아님"
  });
  return { svg: out, d, list, stats: { tops: tops.map(t => ({ dir: DIRS16[t.d], pct: t.tot })), calm: ann.calm, station: st.name, km } };
}

// =============================================================================================================================
// A4 thermal comfort (UTCI, Brode 2012 polynomial)
// =============================================================================================================================
export function utciEnv(env, month, hour) {
  const { ctx, data } = env;
  const { station: st, km } = nearestStation(data.climate, ctx.lat, ctx.lon);
  const m = month - 1, hr = Math.min(23, Math.max(0, Math.round(hour)));
  const ta = st.t[m][hr], rh = st.rh[m][hr], ws = st.ws[m][hr];
  const sp = sunPosition(parisDate(2026, month, 15, hr + .5), ctx.lat, ctx.lon);
  const up = sp.alt > 3 * RAD;
  const shade = utciShade(ta, rh, ws);
  const sol = up ? deltaMrtSun(sp.alt) : { dMrt: 0, dni: 0 };
  const sun = up ? utciSun(ta, rh, ws, sp.alt) : shade;
  return { st, km, month, hr, ta, rh, ws, sp, up, shade, sun, dMrt: sol.dMrt, dni: sol.dni, wsClamped: ws < .5 || ws > 17 };
}
export const utciInfoText = e =>
  `${e.month}월 ${String(e.hr).padStart(2, "0")}:00 평균 · 기온 ${e.ta.toFixed(1)} °C · 습도 ${e.rh.toFixed(0)} % · 풍속 ${e.ws.toFixed(1)} m/s${e.wsClamped ? "(0.5–17로 제한)" : ""} · ${e.up ? `일사 있음(15일 ${String(e.hr).padStart(2, "0")}:30 고도 ${(e.sp.alt / RAD).toFixed(0)}° · 맑은 날 직달 ${e.dni.toFixed(0)} W/m² · ΔMRT +${e.dMrt.toFixed(1)} K)` : "야간·저고도 (일사 없음)"} · 그늘 ${e.shade.toFixed(1)} °C · 양지 ${e.sun.toFixed(1)} °C`;

function plateA4(env) {
  const { ctx, data, S } = env, list = prepBuildings(ctx, data);
  const month = env.month || 7, e = utciEnv(env, month, env.hour ?? 14);
  const d = new Dwg(), ax = new Axo(ctx), maxH = Math.max(10, ...list.map(b => b.h));
  ax.fit(fitPoints(ctx, maxH), { x: 12, y: 40, w: 396, h: 194 });
  drawExtent(d, ax, ctx);
  const mask = e.up ? shadowMask(S, e.sp.az, e.sp.alt) : null;
  const catSun = utciCat(e.sun), catShade = utciCat(e.shade);
  const [cx, cy] = ctx.center;
  const focusRadius = Math.min(200, extentHalf(ctx));
  const inFocus = (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= focusRadius ** 2;
  const stride = Math.max(1, Math.round(8 / S.step)), rM = S.step * stride * .23;
  const counts = new Array(10).fill(0), cells = [];
  for (let j = Math.floor(stride / 2); j < S.ny; j += stride) for (let i = Math.floor(stride / 2); i < S.nx; i += stride) {
    const k = j * S.nx + i; if (S.bld[k]) continue;
    const x = S.x0 + (i + .5) * S.step, y = S.y0 + (j + .5) * S.step;
    if (!inFocus(x, y) || !inRing(ctx.site.ring, x, y)) continue;
    const lit = !!mask && mask[k] === 0, cat = lit ? catSun : catShade;
    counts[cat]++; cells.push({ x, y, lit, cat, v: lit ? e.sun : e.shade });
    const p = ax.P(x, y, 0), c = UTCI_CATS[cat], rx = rM * ax.s;
    const r = lit ? rx * .78 : rx;
    d.ell(p[0], p[1], r, r * Math.sin(ax.el), { fill: c.hex, stroke: c.edge || "none", w: .4 * PT, op: lit ? .7 : 1, layer: "utci" });
  }
  const total = cells.length;
  drawBuildings(d, ax, list);
  siteMarker(d, ...ax.P(cx, cy));
  const pick = lit => {
    let best = null;
    for (const c of cells) {
      if (c.lit !== lit) continue;
      const dd = Math.hypot(c.x - cx, c.y - cy);
      if (!best || dd < best.dd) best = { ...c, dd };
    }
    return best;
  };
  const pins = [true, false].flatMap(sun => {
    const c = pick(sun);
    return c ? [{ c, sun, g: ax.P(c.x, c.y) }] : [];
  }).sort((a, b) => a.g[0] - b.g[0]);
  const pinY = pins.length ? Math.min(...pins.map(({ g }) => g[1])) - 19 : 0;
  pins.forEach(({ c, sun, g }, i) => {
    const t = KO_PLATE[sun ? "plate.pin.sun" : e.up ? "plate.pin.shade" : "plate.pin.night"];
    const dx = pins.length === 1 || i === 1 ? 1 : -1;
    const top = [g[0] + dx * 9, pinY];
    d.line(g, top, { stroke: CLIMATE.ink, w: .3 });
    const l1 = `${t} ${c.v.toFixed(1)} °C`, l2 = UTCI_CATS[c.cat].ko, bw = Math.max(textWidth(l1, 3.2), textWidth(l2, 2.3)) + 9, bx = dx > 0 ? top[0] : top[0] - bw;
    d.rect(bx, top[1] - 8, bw, 8, { fill: sun ? CLIMATE.ink : "#fff", stroke: CLIMATE.ink, w: .3, layer: "line" });
    d.circ(bx + 3.2, top[1] - 4, 1.4, { fill: UTCI_CATS[c.cat].hex, stroke: sun ? "#fff" : CLIMATE.ink, w: .2, layer: "utci" });
    d.text(bx + 6, top[1] - 4.4, l1, { size: 3.2, weight: 600, fill: sun ? "#fff" : CLIMATE.ink });
    d.text(bx + 6, top[1] - 1.4, l2, { size: 2.2, fill: sun ? "#fff" : CLIMATE.sub });
    d.circ(g[0], g[1], 1.1, { fill: UTCI_CATS[c.cat].hex, stroke: CLIMATE.ink, w: .25, layer: "utci" });
  });
  d.wrap(12, 34, utciInfoText(e), 396, { size: 2.4, fill: CLIMATE.ink });
  // legend bar: all 10 categories, % of dots where present
  const bx = 12, bw = 39.6, by = 244;
  d.text(bx, by - 3.5, "추정 UTCI 범주 (°C) — 10칸 전부 표시, 숫자 = 점 중 비율", { size: 2.5, weight: 600 });
  UTCI_CATS.forEach((c, i) => {
    const x = bx + i * bw, pct = total ? counts[i] / total * 100 : 0;
    const legendStyle = { fill: c.hex, stroke: c.edge || CLIMATE.sub, w: c.edge ? .4 * PT : .1, layer: "utci" };
    d.rect(x, by, bw - 1.2, counts[i] ? 5 : 2, legendStyle);
    d.text(x, by + 9, c.ko, { size: 2.4, weight: counts[i] ? 600 : 400 });
    d.text(x, by + 12.6, UTCI_RANGE[i] + " °C", { size: 2.1, fill: CLIMATE.sub });
    if (counts[i]) d.text(x, by + 16.2, (pct < 1 ? "<1" : pct.toFixed(0)) + " %", { size: 2.4, weight: 600 });
    d.legend.push({ kind: "line", stroke: c.hex, sw: .5, label: `UTCI ${UTCI_RANGE[i]} °C ${c.ko}` });
  });
  d.text(bx, by + 21, KO_PLATE["plate.utci.src"], { size: 2.1, fill: CLIMATE.sub });
  siteKey(d, 12, 224.8);
  scaleBar(d, 300, 220, ax.s); northArrow(d, 396, 214, ax.north(), 11);
  d.text(300, 233, `중심 반경 ${Math.round(focusRadius)} m · 점 간격 ${S.step * stride} m`, { size: 2.2, fill: CLIMATE.sub });
  const out = frame(d, ctx, {
    id: "A4 · 다이어그램", ko: `${KO_PLATE["plate.utci.title"]} — ${month}월 ${e.hr}시 추정 UTCI`, fr: KO_PLATE["plate.utci.fr"], ref: "Infrared.city · Buro Happold UTCI",
    src: srcLine(ctx, list, " · 태양: Meeus/SunCalc 식(dgenv.js)", " · 지형: IGN RGE ALTI(그늘 계산)"),
    honest: KO_PLATE["plate.utci.note"] + ". 점 색은 EPW 월·시간 평균과 해당 월 15일 그늘로 계산한 값이며 실제 날씨의 하루가 아님. 기상: " + stationLine(e.st, e.km)
  });
  return { svg: out, d, list, stats: { e, counts, total, catSun, catShade, focusRadius } };
}

// =============================================================================================================================
// public entry: build a plate and the CAD sheet spec that goes with it
// =============================================================================================================================
export function buildPlate(kind, env) {
  const r = ({ A2: plateA2, A3: plateA3, A4: plateA4 })[kind](env);
  const ko = { A2: KO_PLATE["plate.sun.title"], A3: KO_PLATE["plate.wind.title"], A4: KO_PLATE["plate.utci.title"] }[kind];
  const ctx2 = { extent: [0, 0, W, H], center: [W / 2, H / 2], site: { ring: [] }, address: env.ctx.address, radiusLabel: "다이어그램 A3 가로 (좌표 단위 mm)", date: env.ctx.date, paperMm: true };
  const def = { num: kind, ko: ko + " (다이어그램)", en: kind.toLowerCase() + "-plate" };
  const notes = ["정투영 축측 · 남동 135° · 고도 35° · 좌표 단위 mm(A3 용지)"];
  const sheet = r.d.sheet(def, notes, ["BD TOPO® V3", "RGE ALTI", "EPW TMYx (climate.onebuilding.org)"]);
  return { svg: r.svg, sheet, ctx2, def, stats: r.stats };
}
export { clearSkyDni };
