import { t as _t } from "./i18n.js?v=20261122L";
// Board tool "선 위계 정리" (Linework): a vector drawing (PDF or SVG) goes in, strokes are grouped into "pens" (same width, colour,
// dash, fill-only), every pen is given an architectural hierarchy class and redrawn with the owner's v02 line weights
// (docs/drawing-graphic-standard.md, section 2). Semi-automatic: automatic classification, then a few clicks to correct it.
// The pure part (matrix / path / pens / classification / hit test / output SVG) has no DOM and is unit-tested in node
// (tests/linework/linework.test.mjs). The dialog at the bottom is the only DOM part.

export const MM_PER_PT = 25.4 / 72;
export const MAX_ELEMENTS = 80000;
export const SCALES = [100, 200, 500];
export const ACCENT = "#E6B89C";
export const LINE_CLASSES = ["cut", "part", "vis", "thin", "hidden", "ground"];
export const CLASS_KEYS = [...LINE_CLASSES, "text", "accent", "hide"];
export const DRAW_ORDER = ["thin", "hidden", "vis", "part", "ground", "cut"];   // output order: heavy lines on top
export const DASH_MM = [1.5, 1.0];
const WIDTHS = { cut: [0.25, 0.20, 0.18], part: [0.18, 0.13, 0.13], vis: [0.13, 0.10, 0.10], thin: [0.09, 0.08, 0.08], hidden: [0.10, 0.10, 0.08], ground: [0.50, 0.40, 0.35] };
const COLORS = { cut: "#1E2124", part: "#1E2124", vis: "#5A6068", thin: "#7D848D", hidden: "#7D848D", ground: "#1E2124", text: "#1E2124" };
export const FONT = "Noto Sans, Noto Sans KR, sans-serif";
/** class table for a scale: { cut: {w, color}, ..., text: {color} } */
export function defaultTable(scale) {
  const i = scale === 200 ? 1 : scale === 500 ? 2 : 0, o = {};
  for (const k of LINE_CLASSES) o[k] = { w: WIDTHS[k][i], color: COLORS[k] };
  o.text = { color: COLORS.text };
  return o;
}

// ---- small helpers ----------------------------------------------------------------------------------------------------------
const r3 = v => +(+v).toFixed(3);
const r2 = v => +(+v).toFixed(2);
const esc = s => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hex2 = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
const rgbHex = (r, g, b) => ("#" + hex2(r) + hex2(g) + hex2(b)).toUpperCase();
const NAMED = { black: "#000000", white: "#FFFFFF", red: "#FF0000", blue: "#0000FF", green: "#008000", gray: "#808080", grey: "#808080", yellow: "#FFFF00", orange: "#FFA500" };
/** "#rgb" | "#rrggbb" | "rgb(...)" | "rgba(...)" | name -> "#RRGGBB"; null for none / transparent / url(...) / unknown / alpha < 0.5 */
export function parseColor(s) {
  if (s == null) return null;
  s = String(s).trim().toLowerCase();
  if (!s || s === "none" || s === "transparent" || s === "currentcolor" || s.startsWith("url(")) return null;
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return ("#" + [...m[1]].map(c => c + c).join("")).toUpperCase();
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) return m[2] && parseInt(m[2], 16) < 128 ? null : ("#" + m[1]).toUpperCase();
  m = /^rgba?\(\s*([\d.]+)(%?)[\s,]+([\d.]+)(%?)[\s,]+([\d.]+)(%?)(?:[\s,/]+([\d.]+)(%?))?\s*\)$/.exec(s);
  if (m) {
    const f = (v, p) => p ? Number(v) * 2.55 : Number(v), a = m[7] == null ? 1 : (m[8] ? Number(m[7]) / 100 : Number(m[7]));
    return a < 0.5 ? null : rgbHex(f(m[1], m[2]), f(m[3], m[4]), f(m[5], m[6]));
  }
  return NAMED[s] || null;
}
/** perceptual lightness 0..1 of "#RRGGBB" */
export function lightness(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255;
}

// ---- matrices [a b c d e f] (SVG order): apply(m, x, y) = (a x + c y + e, b x + d y + f) ---------------------------------------
export const IDENT = [1, 0, 0, 1, 0, 0];
export const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const scaleOf = m => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
export function parseTransform(str) {
  let m = IDENT;
  if (!str) return m;
  for (const [, name, args] of String(str).matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const a = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (a.some(v => !Number.isFinite(v))) continue;
    let t = null;
    if (name === "matrix" && a.length === 6) t = a;
    else if (name === "translate") t = [1, 0, 0, 1, a[0] || 0, a[1] || 0];
    else if (name === "scale") t = [a[0], 0, 0, a.length > 1 ? a[1] : a[0], 0, 0];
    else if (name === "rotate") { const r = (a[0] || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); t = [c, s, -s, c, 0, 0]; if (a.length >= 3) t = mul(mul([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]); }
    else if (name === "skewX") t = [1, 0, Math.tan((a[0] || 0) * Math.PI / 180), 1, 0, 0];
    else if (name === "skewY") t = [1, Math.tan((a[0] || 0) * Math.PI / 180), 0, 1, 0, 0];
    if (t) m = mul(m, t);
  }
  return m;
}

// ---- path data -> absolute segments { c: "M"|"L"|"C"|"Q"|"Z", a: [...] } ----------------------------------------------------
function arcToCubics(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (!rx || !ry) return [[x1, y1, x2, y2, x2, y2]];
  const phi = phiDeg * Math.PI / 180, cp = Math.cos(phi), sp = Math.sin(phi), dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy, lam = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p, den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = (fa === fs ? -1 : 1) * Math.sqrt(Math.max(0, num / den)), cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dth > 0) dth -= 2 * Math.PI; else if (fs && dth < 0) dth += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9)), dl = dth / n, k = 4 / 3 * Math.tan(dl / 4), out = [];
  const P = a => [cx + rx * Math.cos(a) * cp - ry * Math.sin(a) * sp, cy + rx * Math.cos(a) * sp + ry * Math.sin(a) * cp];
  const D = a => [-rx * Math.sin(a) * cp - ry * Math.cos(a) * sp, -rx * Math.sin(a) * sp + ry * Math.cos(a) * cp];
  for (let i = 0; i < n; i++) {
    const a1 = th1 + i * dl, a2 = a1 + dl, p1 = P(a1), p2 = P(a2), d1 = D(a1), d2 = D(a2);
    out.push([p1[0] + k * d1[0], p1[1] + k * d1[1], p2[0] - k * d2[0], p2[1] - k * d2[1], i === n - 1 ? x2 : p2[0], i === n - 1 ? y2 : p2[1]]);
  }
  return out;
}
/** SVG path "d" -> absolute M/L/C/Q/Z segments (H V S T A relative forms resolved; arcs become cubics). Returns [] on garbage. */
export function parsePathData(d) {
  const s = String(d || ""), segs = [];
  let i = 0, cmd = "", cx = 0, cy = 0, sx = 0, sy = 0, lcx = 0, lcy = 0, lastC = "";
  const ws = () => { while (i < s.length && /[\s,]/.test(s[i])) i++; };
  const num = () => { ws(); const m = /^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/.exec(s.slice(i, i + 40)); if (!m) return NaN; i += m[0].length; return parseFloat(m[0]); };
  const flag = () => { ws(); const c = s[i]; if (c === "0" || c === "1") { i++; return +c; } return NaN; };
  const bad = v => v.some(x => !Number.isFinite(x));
  while (true) {
    ws();
    if (i >= s.length) break;
    if (/[A-Za-z]/.test(s[i])) { cmd = s[i++]; if (!/[MmLlHhVvCcSsQqTtAaZz]/.test(cmd)) return []; }
    else if (!cmd || /[Zz]/.test(cmd)) return [];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), ox = rel ? cx : 0, oy = rel ? cy : 0;
    if (C === "Z") { segs.push({ c: "Z", a: [] }); cx = sx; cy = sy; lastC = "Z"; cmd = ""; continue; }
    if (C === "M") { const v = [num(), num()]; if (bad(v)) return []; cx = ox + v[0]; cy = oy + v[1]; sx = cx; sy = cy; segs.push({ c: "M", a: [cx, cy] }); cmd = rel ? "l" : "L"; lastC = "M"; continue; }
    if (C === "L") { const v = [num(), num()]; if (bad(v)) return []; cx = ox + v[0]; cy = oy + v[1]; segs.push({ c: "L", a: [cx, cy] }); }
    else if (C === "H") { const v = num(); if (!Number.isFinite(v)) return []; cx = ox + v; segs.push({ c: "L", a: [cx, cy] }); }
    else if (C === "V") { const v = num(); if (!Number.isFinite(v)) return []; cy = oy + v; segs.push({ c: "L", a: [cx, cy] }); }
    else if (C === "C") { const v = [num(), num(), num(), num(), num(), num()]; if (bad(v)) return []; const a = [ox + v[0], oy + v[1], ox + v[2], oy + v[3], ox + v[4], oy + v[5]]; segs.push({ c: "C", a }); lcx = a[2]; lcy = a[3]; cx = a[4]; cy = a[5]; }
    else if (C === "S") { const v = [num(), num(), num(), num()]; if (bad(v)) return []; const f = lastC === "C" ? [2 * cx - lcx, 2 * cy - lcy] : [cx, cy], a = [f[0], f[1], ox + v[0], oy + v[1], ox + v[2], oy + v[3]]; segs.push({ c: "C", a }); lcx = a[2]; lcy = a[3]; cx = a[4]; cy = a[5]; }
    else if (C === "Q") { const v = [num(), num(), num(), num()]; if (bad(v)) return []; const a = [ox + v[0], oy + v[1], ox + v[2], oy + v[3]]; segs.push({ c: "Q", a }); lcx = a[0]; lcy = a[1]; cx = a[2]; cy = a[3]; }
    else if (C === "T") { const v = [num(), num()]; if (bad(v)) return []; const f = lastC === "Q" ? [2 * cx - lcx, 2 * cy - lcy] : [cx, cy], a = [f[0], f[1], ox + v[0], oy + v[1]]; segs.push({ c: "Q", a }); lcx = a[0]; lcy = a[1]; cx = a[2]; cy = a[3]; }
    else if (C === "A") {
      const rx = num(), ry = num(), ph = num(), fa = flag(), fs = flag(), x = num(), y = num();
      if (bad([rx, ry, ph, fa, fs, x, y])) return [];
      const ex = ox + x, ey = oy + y;
      for (const c of arcToCubics(cx, cy, rx, ry, ph, fa, fs, ex, ey)) segs.push({ c: "C", a: c });
      if (cx === ex && cy === ey) { /* zero-length arc: omitted by spec */ }
      cx = ex; cy = ey;
    }
    lastC = C === "S" ? "C" : C === "T" ? "Q" : C;
    if (segs.length > 2e6) return [];
  }
  return segs;
}
const rectSegs = (x, y, w, h) => [{ c: "M", a: [x, y] }, { c: "L", a: [x + w, y] }, { c: "L", a: [x + w, y + h] }, { c: "L", a: [x, y + h] }, { c: "Z", a: [] }];
const ellipseSegs = (cx, cy, rx, ry) => [{ c: "M", a: [cx + rx, cy] }, ...arcToCubics(cx + rx, cy, rx, ry, 0, 0, 1, cx, cy + ry).map(a => ({ c: "C", a })), ...arcToCubics(cx, cy + ry, rx, ry, 0, 0, 1, cx - rx, cy).map(a => ({ c: "C", a })), ...arcToCubics(cx - rx, cy, rx, ry, 0, 0, 1, cx, cy - ry).map(a => ({ c: "C", a })), ...arcToCubics(cx, cy - ry, rx, ry, 0, 0, 1, cx + rx, cy).map(a => ({ c: "C", a })), { c: "Z", a: [] }];
/** transform segments by m (in place of coordinates) and measure: { d, sub, closed, len, bbox } ; null when empty / not finite */
export function segsToGeom(segs, m) {
  let d = "", cx = 0, cy = 0, sx = 0, sy = 0, len = 0, closed = false, cur = null, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  const sub = [], P = (x, y) => { const p = apply(m, x, y); if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null; x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); cur?.push(p[0], p[1]); return p; };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let last = null, start = null;
  for (const sg of segs) {
    if (sg.c === "M") { cur = []; sub.push(cur); const p = P(sg.a[0], sg.a[1]); if (!p) return null; d += `M${r3(p[0])} ${r3(p[1])}`; last = start = p; n++; }
    else if (sg.c === "Z") { if (!last) continue; d += "Z"; len += dist(last, start); cur?.push(start[0], start[1]); last = start; closed = true; }
    else {
      if (!last) { cur = []; sub.push(cur); const p = P(0, 0); last = start = p; d += `M${r3(p[0])} ${r3(p[1])}`; }
      const pts = [];
      for (let k = 0; k < sg.a.length; k += 2) { const p = P(sg.a[k], sg.a[k + 1]); if (!p) return null; pts.push(p); }
      d += sg.c + pts.map(p => `${r3(p[0])} ${r3(p[1])}`).join(" ");
      let poly = dist(last, pts[0]); for (let k = 1; k < pts.length; k++) poly += dist(pts[k - 1], pts[k]);
      len += sg.c === "L" ? poly : (poly + dist(last, pts[pts.length - 1])) / 2;
      last = pts[pts.length - 1]; n++;
    }
  }
  if (!n || !Number.isFinite(x0)) return null;
  return { d, sub, closed, len, bbox: [x0, y0, x1, y1] };
}

// ---- elements / pens ----------------------------------------------------------------------------------------------------------
/** element: { id, d, w_mm, stroke, fill, dash, closed, len_mm, bbox, sub, text? } (mm, y down) */
function mkEl(id, g, w_mm, stroke, fill, dash) {
  return { id, d: g.d, w_mm: stroke ? r3(w_mm) : 0, stroke, fill, dash: !!dash, closed: g.closed, len_mm: r3(g.len), bbox: g.bbox.map(r3), sub: g.sub };
}
const dashOn = a => Array.isArray(a) && a.length > 0 && a.some(v => v > 0);
export const penKeyOf = e => e.text ? "TEXT" : `${(Math.round(e.w_mm / 0.01) * 0.01).toFixed(2)}|${e.stroke || ""}|${e.dash ? 1 : 0}|${!e.stroke && e.fill ? "F:" + e.fill : ""}`;
/** group elements into pens (sets el.pen = key and el.pi = pen index). paper = {w, h} mm. Sorted by element count, TEXT pen included. */
export function buildPens(elements, paper) {
  const map = new Map(), pw = paper?.w || 0;
  for (const e of elements) {
    const k = penKeyOf(e);
    let p = map.get(k);
    if (!p) { p = { key: k, text: !!e.text, w_mm: e.text ? 0 : e.w_mm, stroke: e.stroke, fill: e.fill, dash: e.dash, fillOnly: !e.text && !e.stroke && !!e.fill, count: 0, sumSize: 0, longHoriz: 0, len_mm: 0 }; map.set(k, p); }
    p.count++; e.pen = k;
    if (e.text) continue;
    const bw = e.bbox[2] - e.bbox[0], bh = e.bbox[3] - e.bbox[1];
    p.sumSize += Math.max(bw, bh); p.len_mm += e.len_mm;
    if (pw && !p.fillOnly && bw > 0.4 * pw && bh <= 0.05 * bw) p.longHoriz++;
  }
  const pens = [...map.values()].sort((a, b) => b.count - a.count);
  pens.forEach((p, i) => { p.i = i; p.avgSize = p.count ? p.sumSize / p.count : 0; });
  const idx = new Map(pens.map(p => [p.key, p.i]));
  for (const e of elements) e.pi = idx.get(e.pen);
  return pens;
}

/** automatic classification (spec section 4). Returns { assign: { [penKey]: { cls, reason: {k, v} } }, notice: null | "single" } */
export function classifyPens(pens, opts = {}) {
  const assign = {}, set = (p, cls, k, v) => { assign[p.key] = { cls, reason: { k, v: v || {} } }; };
  const lines = [];
  for (const p of pens) {
    if (p.text) { set(p, "text", "lw.r.text"); continue; }                                       // 1
    if (p.fillOnly) {                                                                              // 2
      if (p.count > 500 && p.avgSize < 2) set(p, "hide", "lw.r.hatch");
      else if (lightness(p.fill) < 0.35) set(p, "cut", "lw.r.darkfill");
      else set(p, "hide", "lw.r.lightfill");
      continue;
    }
    if (p.stroke && lightness(p.stroke) > 0.96) { set(p, "hide", "lw.r.white"); continue; }
    if (p.dash) { set(p, "hidden", "lw.r.dash"); continue; }                                       // 3
    lines.push(p);
  }
  // 4: width steps (a width within 15 % of the step's heaviest belongs to that step)
  const tiers = [];
  for (const p of [...lines].sort((a, b) => b.w_mm - a.w_mm)) {
    const t = tiers[tiers.length - 1];
    if (t && p.w_mm >= t.w * 0.85) t.pens.push(p); else tiers.push({ w: p.w_mm, pens: [p] });
  }
  const total = tiers.length;
  if (tiers.length > 1) {                                                                          // exception: a few long horizontal heavy lines = section ground line
    const top = tiers[0], cnt = top.pens.reduce((a, p) => a + p.count, 0);
    if (cnt <= 5 && top.pens.every(p => p.longHoriz === p.count)) { for (const p of top.pens) set(p, "ground", "lw.r.ground", { w: r2(p.w_mm) }); tiers.shift(); }
  }
  const n = tiers.length;
  tiers.forEach((t, r) => {
    const cls = n >= 4 ? ["cut", "part", "vis"][r] || "thin" : n === 3 ? ["cut", "vis", "thin"][r] : n === 2 ? ["cut", "thin"][r] : "vis";
    for (const p of t.pens) {
      const w = r2(p.w_mm);
      if (n === 1) set(p, cls, "lw.r.only", { w });
      else if (r === 0) set(p, cls, "lw.r.top", { w });
      else if (cls === "thin" && r > 1 && n >= 4) set(p, cls, "lw.r.rest", { w });
      else set(p, cls, "lw.r.rank", { n: r + 1, w });
    }
  });
  return { assign, notice: total === 1 ? "single" : null };
}

// ---- hit test (preview click) ---------------------------------------------------------------------------------------------
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function inPoly(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    if ((pts[i + 1] > y) !== (pts[j + 1] > y) && x < (pts[j] - pts[i]) * (y - pts[i + 1]) / (pts[j + 1] - pts[i + 1]) + pts[i]) c = !c;
  }
  return c;
}
/** nearest visible element within tol (mm) of (x, y); text by bounding box; filled-only shapes also by their area */
export function hitTest(els, x, y, tol, isVisible = () => true) {
  let best = null, bd = Infinity;
  for (const e of els) {
    const b = e.bbox;
    if (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol || !isVisible(e)) continue;
    let d = Infinity;
    if (e.text) { if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) d = tol * 0.9; }
    else {
      for (const s of e.sub || []) {
        for (let i = 0; i + 3 < s.length; i += 2) { const q = segDist(x, y, s[i], s[i + 1], s[i + 2], s[i + 3]); if (q < d) d = q; }
        if (s.length === 2) d = Math.min(d, Math.hypot(x - s[0], y - s[1]));
      }
      if (d > tol && !e.stroke && e.fill && (e.sub || []).some(s => s.length >= 6 && inPoly(s, x, y))) { const ar = (b[2] - b[0]) * (b[3] - b[1]); d = tol * (0.85 + 0.09 * ar / (ar + 1000)); }   // among overlapping areas the smaller one wins
      if (!e.stroke) d += tol * 0.05;   // on a tie a drawn line wins over an area behind it
    }
    if (d <= tol && d < bd) { bd = d; best = e; }
  }
  return best;
}

// ---- SVG input --------------------------------------------------------------------------------------------------------------
const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, q: 0.25 };
const parseLen = v => { const m = /^\s*([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(String(v ?? "")); if (!m) return null; const u = m[2].toLowerCase(); if (u === "%" || (u && !(u in UNIT_MM))) return null; return { v: parseFloat(m[1]), mm: parseFloat(m[1]) * (UNIT_MM[u || "px"]), unit: u }; };
const SKIP = new Set(["defs", "clippath", "mask", "pattern", "symbol", "marker", "style", "title", "desc", "metadata", "lineargradient", "radialgradient", "filter", "script", "foreignobject", "image", "use"]);
class LimitError extends Error { constructor(code) { super(code); this.code = code; } }
const attrNum = (el, n, d = 0) => { const v = parseFloat(el.getAttribute(n)); return Number.isFinite(v) ? v : d; };
function shapeSegs(el, tag) {
  if (tag === "path") return parsePathData(el.getAttribute("d"));
  if (tag === "line") return [{ c: "M", a: [attrNum(el, "x1"), attrNum(el, "y1")] }, { c: "L", a: [attrNum(el, "x2"), attrNum(el, "y2")] }];
  if (tag === "polyline" || tag === "polygon") {
    const v = String(el.getAttribute("points") || "").trim().split(/[\s,]+/).map(Number);
    if (v.length < 4 || v.some(x => !Number.isFinite(x))) return [];
    const s = []; for (let i = 0; i + 1 < v.length; i += 2) s.push({ c: i ? "L" : "M", a: [v[i], v[i + 1]] });
    if (tag === "polygon") s.push({ c: "Z", a: [] });
    return s;
  }
  if (tag === "rect") {
    const x = attrNum(el, "x"), y = attrNum(el, "y"), w = attrNum(el, "width"), h = attrNum(el, "height");
    if (!(w > 0 && h > 0)) return [];
    let rx = attrNum(el, "rx", NaN), ry = attrNum(el, "ry", NaN);
    if (!(rx > 0) && !(ry > 0)) return rectSegs(x, y, w, h);
    if (!(rx > 0)) rx = ry; if (!(ry > 0)) ry = rx;
    rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
    const A = (x1, y1, x2, y2) => arcToCubics(x1, y1, rx, ry, 0, 0, 1, x2, y2).map(a => ({ c: "C", a }));
    return [{ c: "M", a: [x + rx, y] }, { c: "L", a: [x + w - rx, y] }, ...A(x + w - rx, y, x + w, y + ry), { c: "L", a: [x + w, y + h - ry] }, ...A(x + w, y + h - ry, x + w - rx, y + h), { c: "L", a: [x + rx, y + h] }, ...A(x + rx, y + h, x, y + h - ry), { c: "L", a: [x, y + ry] }, ...A(x, y + ry, x + rx, y), { c: "Z", a: [] }];
  }
  if (tag === "circle") { const r = attrNum(el, "r"); return r > 0 ? ellipseSegs(attrNum(el, "cx"), attrNum(el, "cy"), r, r) : []; }
  if (tag === "ellipse") { const rx = attrNum(el, "rx"), ry = attrNum(el, "ry"); return rx > 0 && ry > 0 ? ellipseSegs(attrNum(el, "cx"), attrNum(el, "cy"), rx, ry) : []; }
  return [];
}
/** base matrix (user units -> mm) and paper size of an <svg> root: width/height in mm or any CSS unit (unitless = px at 96 dpi), viewBox maps onto it */
export function svgPaper(root) {
  const vbs = String(root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number), vb = vbs.length === 4 && vbs.every(Number.isFinite) && vbs[2] > 0 && vbs[3] > 0 ? vbs : null;
  const w = parseLen(root.getAttribute("width")), h = parseLen(root.getAttribute("height"));
  let W, H, sx, sy;
  if (w && h && w.v > 0 && h.v > 0) { W = w.mm; H = h.mm; sx = vb ? W / vb[2] : w.mm / w.v; sy = vb ? H / vb[3] : h.mm / h.v; }
  else if (vb) { sx = sy = UNIT_MM.px; W = vb[2] * sx; H = vb[3] * sy; if (w && w.v > 0 && !h) { sx = sy = w.mm / vb[2]; W = w.mm; H = vb[3] * sy; } else if (h && h.v > 0 && !w) { sx = sy = h.mm / vb[3]; H = h.mm; W = vb[2] * sx; } }
  else return null;
  const m = mul([sx, 0, 0, sy, 0, 0], [1, 0, 0, 1, vb ? -vb[0] : 0, vb ? -vb[1] : 0]);
  return { paper: { w: r2(W), h: r2(H) }, m };
}
/**
 * Walk an <svg> element (any DOM-like: localName, getAttribute, children, textContent) into elements.
 * getStyle(el) -> computed { stroke, strokeWidth (user units), fill, dash (string|number[]), display, fillOpacity, strokeOpacity, fontSize, textAnchor }.
 * Returns { elements, paper, warnings }. Throws LimitError("too_many") above MAX_ELEMENTS.
 */
export function svgDomToElements(root, getStyle, opts = {}) {
  const sp = svgPaper(root);
  if (!sp) throw new LimitError("no_size");
  const elements = [], warnings = new Set(), max = opts.max || MAX_ELEMENTS;
  const push = e => { if (elements.length >= max) throw new LimitError("too_many"); e.id = elements.length; elements.push(e); };
  const dashArr = v => Array.isArray(v) ? v : String(v || "none") === "none" ? [] : String(v).split(/[\s,]+/).map(s => parseFloat(s)).filter(Number.isFinite);
  const visit = (el, m, top) => {
    const tag = (el.localName || el.tagName || "").toLowerCase();
    if (!top && SKIP.has(tag)) { if (tag === "use" || tag === "image") warnings.add(tag); return; }
    const st = getStyle(el) || {};
    if (st.display === "none") return;
    const mm = top ? m : mul(m, parseTransform(el.getAttribute("transform")));
    if (tag === "svg" || tag === "g" || tag === "a" || tag === "switch") {
      let mm2 = mm;
      if (!top && tag === "svg") mm2 = mul(mm, [1, 0, 0, 1, attrNum(el, "x"), attrNum(el, "y")]);
      for (const c of el.children || []) visit(c, mm2, false);
      return;
    }
    if (tag === "text") {
      const str = String(el.textContent || "").replace(/\s+/g, " ").trim();
      if (!str) return;
      const first = String(el.getAttribute("x") || "").trim().split(/[\s,]+/)[0], fy = String(el.getAttribute("y") || "").trim().split(/[\s,]+/)[0];
      const x = parseFloat(first) || 0, y = parseFloat(fy) || 0, p = apply(mm, x, y), sc = scaleOf(mm), fs = (Number.isFinite(st.fontSize) ? st.fontSize : 12) * sc;
      const rot = Math.atan2(mm[1], mm[0]) * 180 / Math.PI, wEst = str.length * fs * 0.55, anchor = st.textAnchor === "middle" || st.textAnchor === "end" ? st.textAnchor : "start";
      const x0 = anchor === "middle" ? p[0] - wEst / 2 : anchor === "end" ? p[0] - wEst : p[0];
      push({ text: { str, x: r3(p[0]), y: r3(p[1]), size: r3(fs), rot: r2(rot), anchor }, d: "", w_mm: 0, stroke: null, fill: parseColor(st.fill) || "#000000", dash: false, closed: false, len_mm: 0, bbox: [x0, p[1] - fs, x0 + wEst, p[1] + fs * 0.25].map(r3), sub: [] });
      return;
    }
    if (!["path", "line", "polyline", "polygon", "rect", "circle", "ellipse"].includes(tag)) return;
    const segs = shapeSegs(el, tag);
    if (!segs.length) return;
    const g = segsToGeom(segs, mm);
    if (!g) return;
    const sw = Number.isFinite(st.strokeWidth) ? st.strokeWidth : 1;
    let stroke = parseColor(st.stroke), fill = parseColor(st.fill);
    if (stroke && Number(st.strokeOpacity) === 0) stroke = null;
    if (fill && Number(st.fillOpacity) < 0.05) fill = null;
    if (tag === "line") fill = null;
    if (stroke && !(sw > 0)) stroke = null;
    const dash = dashOn(dashArr(st.dash));
    if (fill && g.len < 1e-6 && !stroke) return;
    if (stroke) push(mkEl(0, g, Math.max(sw * scaleOf(mm), 0.01), stroke, null, dash));
    if (fill) push(mkEl(0, g, 0, null, fill, false));
  };
  visit(root, sp.m, true);
  return { elements, paper: sp.paper, warnings: [...warnings] };
}

// ---- PDF input -------------------------------------------------------------------------------------------------------------
const colorFromArgs = (args, names) => {
  if (!args) return null;
  if (typeof args[0] === "string") return parseColor(args[0]);
  const v = Array.from(args);
  if (names === "gray") { const g = v[0] <= 1 ? v[0] * 255 : v[0]; return rgbHex(g, g, g); }
  if (names === "cmyk") { const [c, m, y, k] = v.map(x => x > 1 ? x / 100 : x); return rgbHex(255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)); }
  return v.length >= 3 && v.every(Number.isFinite) ? rgbHex(v[0], v[1], v[2]) : null;
};
/**
 * pdf.js operator list -> elements in mm (paper space, y down). OPS = pdfjs.OPS, vpTransform = page.getViewport({scale: 1}).transform.
 * Returns { elements, imageCount }. Throws LimitError("too_many").
 */
export function pdfOpsToElements(opList, OPS, vpTransform, opts = {}) {
  const { fnArray, argsArray } = opList, max = opts.max || MAX_ELEMENTS, elements = [];
  const base = mul([MM_PER_PT, 0, 0, MM_PER_PT, 0, 0], vpTransform || [1, 0, 0, -1, 0, 0]);
  let ctm = IDENT, lw = 1, dash = [], stroke = "#000000", fill = "#000000", stack = [], segs = [], imageCount = 0, cx = 0, cy = 0;
  const op = name => OPS[name];
  const paint = (doFill, doStroke, close) => {
    if (close && segs.length) segs.push({ c: "Z", a: [] });
    if (segs.length) {
      const m = mul(base, ctm), g = segsToGeom(segs, m);
      if (g) {
        if (elements.length + 2 > max) throw new LimitError("too_many");
        const sc = scaleOf(m);
        if (doStroke && stroke) elements.push(mkEl(elements.length, g, Math.max(lw * sc, 0.02), stroke, null, dashOn(dash)));
        if (doFill && fill) elements.push(mkEl(elements.length, g, 0, null, fill, false));
      }
    }
    segs = [];
  };
  const tbl = {};
  for (const [name, f] of [["stroke", [0, 1, 0]], ["closeStroke", [0, 1, 1]], ["fill", [1, 0, 0]], ["eoFill", [1, 0, 0]], ["fillStroke", [1, 1, 0]], ["eoFillStroke", [1, 1, 0]], ["closeFillStroke", [1, 1, 1]], ["closeEOFillStroke", [1, 1, 1]]]) if (op(name) != null) tbl[op(name)] = f;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], a = argsArray[i];
    if (fn === op("constructPath")) {
      const ops = a[0], co = a[1];
      let k = 0;
      for (const o of ops) {
        if (o === op("moveTo")) { cx = co[k]; cy = co[k + 1]; segs.push({ c: "M", a: [cx, cy] }); k += 2; }
        else if (o === op("lineTo")) { cx = co[k]; cy = co[k + 1]; segs.push({ c: "L", a: [cx, cy] }); k += 2; }
        else if (o === op("curveTo")) { segs.push({ c: "C", a: [co[k], co[k + 1], co[k + 2], co[k + 3], co[k + 4], co[k + 5]] }); cx = co[k + 4]; cy = co[k + 5]; k += 6; }
        else if (o === op("curveTo2")) { segs.push({ c: "C", a: [cx, cy, co[k], co[k + 1], co[k + 2], co[k + 3]] }); cx = co[k + 2]; cy = co[k + 3]; k += 4; }
        else if (o === op("curveTo3")) { segs.push({ c: "C", a: [co[k], co[k + 1], co[k + 2], co[k + 3], co[k + 2], co[k + 3]] }); cx = co[k + 2]; cy = co[k + 3]; k += 4; }
        else if (o === op("closePath")) segs.push({ c: "Z", a: [] });
        else if (o === op("rectangle")) { const x = co[k], y = co[k + 1], w = co[k + 2], h = co[k + 3]; segs.push(...rectSegs(x, y, w, h)); cx = x; cy = y; k += 4; }
      }
    }
    else if (tbl[fn]) paint(...tbl[fn].map(Boolean));
    else if (fn === op("endPath")) segs = [];
    else if (fn === op("save")) stack.push({ ctm, lw, dash, stroke, fill });
    else if (fn === op("restore")) { const s = stack.pop(); if (s) ({ ctm, lw, dash, stroke, fill } = s); }
    else if (fn === op("transform")) ctm = mul(ctm, a);
    else if (fn === op("setLineWidth")) lw = a[0];
    else if (fn === op("setDash")) dash = a[0] || [];
    else if (fn === op("setStrokeRGBColor")) stroke = colorFromArgs(a) || stroke;
    else if (fn === op("setFillRGBColor")) fill = colorFromArgs(a) || fill;
    else if (fn === op("setStrokeGray")) stroke = colorFromArgs(a, "gray") || stroke;
    else if (fn === op("setFillGray")) fill = colorFromArgs(a, "gray") || fill;
    else if (fn === op("setStrokeCMYKColor")) stroke = colorFromArgs(a, "cmyk") || stroke;
    else if (fn === op("setFillCMYKColor")) fill = colorFromArgs(a, "cmyk") || fill;
    else if (fn === op("setGState")) { for (const [key, v] of a[0] || []) { if (key === "LW") lw = v; else if (key === "D") dash = v?.[0] || []; } }
    else if (fn === op("paintFormXObjectBegin")) { stack.push({ ctm, lw, dash, stroke, fill }); if (a?.[0]) ctm = mul(ctm, a[0]); }
    else if (fn === op("paintFormXObjectEnd")) { const s = stack.pop(); if (s) ({ ctm, lw, dash, stroke, fill } = s); }
    else if (fn === op("paintImageXObject") || fn === op("paintInlineImageXObject") || fn === op("paintImageMaskXObject") || fn === op("paintJpegXObject")) imageCount++;
  }
  return { elements, imageCount };
}
/** pdf.js text items -> text elements (mm). items from page.getTextContent(). */
export function pdfTextToElements(items, vpTransform) {
  const out = [], vp = vpTransform || [1, 0, 0, -1, 0, 0];
  for (const it of items || []) {
    if (typeof it.str !== "string" || !it.str.trim() || !Array.isArray(it.transform)) continue;
    const tm = mul(vp, it.transform), size = Math.hypot(tm[2], tm[3]) * MM_PER_PT, rot = Math.atan2(tm[1], tm[0]) * 180 / Math.PI, x = tm[4] * MM_PER_PT, y = tm[5] * MM_PER_PT;
    const w = (it.width || it.str.length * size * 0.55 / MM_PER_PT) * MM_PER_PT, rr = rot * Math.PI / 180, ex = x + Math.cos(rr) * w, ey = y + Math.sin(rr) * w;
    out.push({ text: { str: it.str, x: r3(x), y: r3(y), size: r3(size), rot: r2(rot), anchor: "start", w: r3(w) }, d: "", w_mm: 0, stroke: null, fill: "#000000", dash: false, closed: false, len_mm: 0, bbox: [Math.min(x, ex), Math.min(y, ey) - size, Math.max(x, ex), Math.max(y, ey) + size * 0.25].map(r3), sub: [] });
  }
  return out;
}

// ---- output ----------------------------------------------------------------------------------------------------------------
const textMarkup = (e, color) => {
  const t = e.text, tf = t.rot ? ` transform="rotate(${r2(t.rot)} ${r3(t.x)} ${r3(t.y)})"` : "", ta = t.anchor && t.anchor !== "start" ? ` text-anchor="${t.anchor}"` : "", tl = t.w && t.str.length > 1 ? ` textLength="${r3(t.w)}" lengthAdjust="spacingAndGlyphs"` : "";
  return `<text x="${r3(t.x)}" y="${r3(t.y)}" font-size="${r3(t.size)}"${ta}${tf}${tl}>${esc(t.str)}</text>`;
};
/** result SVG string: paper size in mm, user unit = 1 mm. clsOf(el) -> class key. Order: accent, thin, hidden, vis, part, ground, cut, text. */
export function renderLineworkSvg(elements, clsOf, table, paper) {
  const by = {};
  for (const e of elements) { const c = clsOf(e); (by[c] ||= []).push(e); }
  const W = r2(paper.w), H = r2(paper.h);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">`;
  const acc = (by.accent || []).filter(e => !e.text);
  if (acc.length) s += `<g data-cls="accent" fill="${ACCENT}" stroke="none">${acc.map(e => `<path d="${e.d}"/>`).join("")}</g>`;
  for (const k of DRAW_ORDER) {
    const list = (by[k] || []).filter(e => !e.text);
    if (!list.length) continue;
    const c = table[k] || defaultTable(100)[k];
    s += `<g data-cls="${k}" fill="none" stroke="${c.color}" stroke-width="${r3(c.w)}" stroke-linecap="butt" stroke-linejoin="miter"${k === "hidden" ? ` stroke-dasharray="${DASH_MM[0]} ${DASH_MM[1]}"` : ""}>${list.map(e => `<path d="${e.d}"/>`).join("")}</g>`;
  }
  const tx = (by.text || []).filter(e => e.text);
  if (tx.length) s += `<g data-cls="text" fill="${(table.text || defaultTable(100).text).color}" stroke="none" font-family="${FONT}">${tx.map(e => textMarkup(e)).join("")}</g>`;
  return s + "</svg>";
}
/** the original drawing as drawn in the source (for the original/cleaned toggle), same coordinates */
export function renderOriginalSvg(elements, paper) {
  const W = r2(paper.w), H = r2(paper.h);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">`;
  for (const e of elements) {
    if (e.text) { s += `<g fill="${e.fill || "#000000"}" font-family="${FONT}">${textMarkup(e)}</g>`; continue; }
    s += `<path d="${e.d}" fill="${e.stroke ? "none" : (e.fill || "none")}"${e.stroke ? ` stroke="${e.stroke}" stroke-width="${r3(e.w_mm)}"${e.dash ? ` stroke-dasharray="${DASH_MM[0]} ${DASH_MM[1]}"` : ""}` : ""}/>`;
  }
  return s + "</svg>";
}

// =============================================================================================================================
// DOM part: parsing in a sandboxed iframe, the dialog, board hand-over
// =============================================================================================================================
const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
let current = null;   // only one dialog at a time

/** SVG text -> { elements, paper, warnings } (browser): styles resolved by getComputedStyle inside a script-less sandboxed iframe */
export async function parseSvgElements(svgText, opts = {}) {
  const dp = new DOMParser().parseFromString(svgText, "image/svg+xml"), root0 = dp.documentElement;
  if (!root0 || dp.querySelector("parsererror") || root0.localName !== "svg") throw new LimitError("bad_svg");
  const { sanitizeSvgTree } = await import("./board_v06_doc.js?v=20261122i");
  sanitizeSvgTree(root0);
  const fr = document.createElement("iframe");
  fr.setAttribute("sandbox", "allow-same-origin");   // no scripts; its CSS cannot touch the board page
  fr.setAttribute("aria-hidden", "true"); fr.tabIndex = -1;
  fr.style.cssText = "position:fixed;left:-20000px;top:0;width:1200px;height:900px;border:0;opacity:0;pointer-events:none";
  document.body.append(fr);
  try {
    await new Promise((res, rej) => { fr.onload = res; fr.onerror = rej; fr.srcdoc = `<!doctype html><html><body style="margin:0">${new XMLSerializer().serializeToString(root0)}</body></html>`; });
    const doc = fr.contentDocument, win = fr.contentWindow, root = doc.querySelector("svg");
    if (!root) throw new LimitError("bad_svg");
    const px = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; };
    return svgDomToElements(root, el => {
      const cs = win.getComputedStyle(el);
      return { stroke: cs.stroke, strokeWidth: px(cs.strokeWidth), fill: cs.fill, dash: cs.strokeDasharray, display: cs.display, fillOpacity: cs.fillOpacity, strokeOpacity: cs.strokeOpacity, fontSize: px(cs.fontSize), textAnchor: cs.textAnchor };
    }, opts);
  } finally { fr.remove(); }
}
async function pdfPageToModel(pg, lib, opts = {}) {
  const vp = pg.getViewport({ scale: 1 }), [ol, tc] = await Promise.all([pg.getOperatorList(), pg.getTextContent()]);
  const { elements, imageCount } = pdfOpsToElements(ol, lib.OPS, vp.transform, opts), texts = pdfTextToElements(tc.items, vp.transform);
  if (elements.length + texts.length > (opts.max || MAX_ELEMENTS)) throw new LimitError("too_many");
  const all = elements.concat(texts); all.forEach((e, i) => { e.id = i; });
  return { elements: all, paper: { w: r2(vp.width * MM_PER_PT), h: r2(vp.height * MM_PER_PT) }, imageCount, vectorCount: elements.length };
}

function svgToPng(svg, w, h, long = 1600) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" })), img = new Image();
    img.onload = () => {
      const k = long / Math.max(w, h), cv = document.createElement("canvas"); cv.width = Math.max(1, Math.round(w * k)); cv.height = Math.max(1, Math.round(h * k));
      const cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url); res(cv.toDataURL("image/png"));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("svg render")); };
    img.src = url;
  });
}

const tr = (e, key) => { e.dataset.i18n = key; return e; };   // static dialog text: re-translated by i18n apply() on a language switch
const CLS_LABEL = k => _t("lw.cls." + k);
const reasonText = r => r ? _t(r.k, r.v) : "";

/**
 * Open the dialog. host: element to append to (#board). Source: file (.pdf / .svg) or svgText.
 * ctx: { loadPdfJs(), add(item), status(msg) }
 */
export async function openLinework({ host, file, svgText, name, ctx }) {
  if (current) current.close();
  const status = ctx?.status || (() => {});
  let closed = false, langOff = null;
  const dlg = mk("div", "lw-dlg"); dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true"); dlg.setAttribute("aria-label", _t("lw.title")); dlg.tabIndex = -1;
  const top = mk("div", "lw-top"), h2 = tr(mk("b", "lw-title", _t("lw.title")), "lw.title"), fileEl = mk("span", "lw-file"), spacer = mk("span", "lw-sp");
  const scaleLbl = mk("label", "lw-scale"), scaleTxt = tr(mk("span", "", _t("lw.scale")), "lw.scale"), scaleSel = mk("select"); for (const s of SCALES) { const o = mk("option", "", "1/" + s); o.value = s; scaleSel.append(o); }
  scaleLbl.append(scaleTxt, scaleSel);
  const viewGrp = mk("span", "lw-seg"), bClean = tr(mk("button", "bd-btn", _t("lw.view.clean")), "lw.view.clean"), bOrig = tr(mk("button", "bd-btn", _t("lw.view.orig")), "lw.view.orig");
  viewGrp.append(bClean, bOrig);
  const bAdd = tr(mk("button", "bd-btn bd-strong", _t("lw.add")), "lw.add"), bDl = tr(mk("button", "bd-btn", _t("lw.download")), "lw.download"), bClose = tr(mk("button", "bd-btn", _t("lw.close")), "lw.close");
  for (const b of [bClean, bOrig, bAdd, bDl, bClose]) b.type = "button";
  bAdd.disabled = bDl.disabled = true;
  top.append(h2, fileEl, spacer, scaleLbl, viewGrp, bAdd, bDl, bClose);
  const main = mk("div", "lw-main"), view = mk("div", "lw-view"), side = mk("aside", "lw-side");
  const msg = tr(mk("div", "lw-msg", _t("lw.loading")), "lw.loading"); msg.setAttribute("role", "status");
  const notice = mk("div", "lw-notice"); notice.hidden = true;
  view.append(msg, notice); main.append(view, side); dlg.append(top, main);
  host.append(dlg);
  const hl = mk("style"); dlg.append(hl);
  const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); } else e.stopPropagation(); };
  dlg.addEventListener("keydown", onKey);
  const prevFocus = document.activeElement;
  function close() { if (closed) return; closed = true; current = null; langOff?.(); dlg.remove(); try { prevFocus?.focus?.(); } catch { /* gone */ } }
  current = { close };
  bClose.onclick = close; bClose.focus();
  const fail = key => { delete msg.dataset.i18n; msg.textContent = _t(key, { max: MAX_ELEMENTS }); msg.classList.add("is-err"); status(_t(key, { max: MAX_ELEMENTS })); };

  // ---- load ------------------------------------------------------------------------------------------------------------------
  let model;
  try {
    const fname = name || file?.name || "drawing";
    fileEl.textContent = fname;
    if (svgText == null && file && /\.dxf$|\.dwg$/i.test(file.name || "")) { fail("lw.err.cad"); return; }
    const isPdf = !svgText && file && (/pdf/i.test(file.type || "") || /\.pdf$/i.test(file.name || ""));
    if (isPdf) {
      const lib = await ctx.loadPdfJs();
      if (closed) return;
      const pdf = await lib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false, enableXfa: false }).promise;
      let pageNo = 1;
      if (pdf.numPages > 1) { pageNo = await pickPage(dlg, pdf, () => closed); if (!pageNo) { pdf.destroy?.(); close(); return; } }
      msg.textContent = _t("lw.loading");
      model = await pdfPageToModel(await pdf.getPage(pageNo), lib);
      pdf.destroy?.();
      if (model.vectorCount < 5 && model.imageCount > 0) { fail("lw.err.scan"); return; }
      if (!model.vectorCount && !model.elements.length) { fail("lw.err.empty"); return; }
    } else {
      if (svgText == null) { if (!file) { fail("lw.err.read"); return; } svgText = await file.text(); }
      model = await parseSvgElements(svgText);
      if (!model.elements.length) { fail("lw.err.empty"); return; }
    }
  } catch (e) {
    if (closed) return;
    console.warn(e);
    fail(e?.code === "too_many" ? "lw.err.many" : "lw.err.read"); return;
  }
  if (closed) return;
  const { elements, paper } = model;
  const baseName = String(name || file?.name || "drawing").replace(/\.(pdf|svg)$/i, "").slice(0, 60);

  // ---- state -----------------------------------------------------------------------------------------------------------------
  const pens = buildPens(elements, paper), auto = classifyPens(pens, {});
  const penCls = {}, penReason = {}, elCls = new Map();
  for (const p of pens) { penCls[p.key] = auto.assign[p.key].cls; penReason[p.key] = auto.assign[p.key].reason; }
  let scale = 100, table = defaultTable(scale), mode = "clean", selPen = -1;
  const clsOf = e => elCls.get(e.id) ?? penCls[e.pen];

  msg.remove();
  if (auto.notice === "single") { notice.textContent = _t("lw.notice.single"); notice.dataset.i18n = "lw.notice.single"; notice.hidden = false; }
  const hint = tr(mk("div", "lw-hint", _t("lw.hint")), "lw.hint"); view.append(hint);

  // ---- preview svg ---------------------------------------------------------------------------------------------------------
  const NS = "http://www.w3.org/2000/svg", se = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
  const svg = se("svg", { class: "lw-svg", viewBox: `0 0 ${paper.w} ${paper.h}`, preserveAspectRatio: "xMidYMid meet", role: "img", "aria-label": _t("lw.title") });
  svg.append(se("rect", { x: 0, y: 0, width: paper.w, height: paper.h, fill: "#fff", class: "lw-paper" }));
  const gClean = se("g", {}), gOrig = se("g", { class: "lw-orig" }), groups = {}, nodeOf = new Map();
  gOrig.style.display = "none";
  for (const k of ["accent", ...DRAW_ORDER, "text"]) { groups[k] = se("g", { "data-cls": k }); gClean.append(groups[k]); }
  groups.hide = se("g", {});   // detached: hidden elements stay in the model
  for (const e of elements) {
    const n = e.text ? se("text", { x: e.text.x, y: e.text.y, "font-size": e.text.size }) : se("path", { d: e.d });
    if (e.text) { n.textContent = e.text.str; if (e.text.rot) n.setAttribute("transform", `rotate(${e.text.rot} ${e.text.x} ${e.text.y})`); if (e.text.anchor && e.text.anchor !== "start") n.setAttribute("text-anchor", e.text.anchor); }
    n.setAttribute("data-p", e.pi); nodeOf.set(e.id, n); groups[clsOf(e)].append(n);
  }
  svg.append(gClean, gOrig);
  let origBuilt = false;
  const buildOrig = () => {
    if (origBuilt) return; origBuilt = true;
    const tmp = new DOMParser().parseFromString(renderOriginalSvg(elements, paper), "image/svg+xml").documentElement;
    for (const c of [...tmp.children]) gOrig.append(document.importNode(c, true));
  };
  function paintGroups() {
    for (const k of LINE_CLASSES) {
      const g = groups[k], c = table[k]; g.setAttribute("fill", "none"); g.setAttribute("stroke", c.color); g.setAttribute("stroke-width", c.w); g.setAttribute("stroke-linecap", "butt"); g.setAttribute("stroke-linejoin", "miter");
      if (k === "hidden") g.setAttribute("stroke-dasharray", DASH_MM.join(" "));
    }
    groups.accent.setAttribute("fill", ACCENT); groups.accent.setAttribute("stroke", "none");
    groups.text.setAttribute("fill", table.text.color); groups.text.setAttribute("stroke", "none"); groups.text.setAttribute("font-family", FONT);
  }
  paintGroups();
  const moveEl = (e, cls) => { const n = nodeOf.get(e.id); if (n) groups[cls].append(n); };
  const movePen = (p, cls) => { for (const e of elements) if (e.pen === p.key && !elCls.has(e.id)) moveEl(e, cls); };
  const wrap = mk("div", "lw-stage"); wrap.append(svg); view.append(wrap);
  const fitBtn = tr(mk("button", "bd-btn lw-fit", _t("lw.fit")), "lw.fit"); fitBtn.type = "button"; view.append(fitBtn);
  const vb = { x: 0, y: 0, w: paper.w, h: paper.h };
  const setVb = () => svg.setAttribute("viewBox", `${r3(vb.x)} ${r3(vb.y)} ${r3(vb.w)} ${r3(vb.h)}`);
  const fit = () => { const m = Math.max(paper.w, paper.h) * 0.02; vb.x = -m; vb.y = -m; vb.w = paper.w + 2 * m; vb.h = paper.h + 2 * m; setVb(); };
  fit(); fitBtn.onclick = fit;
  const toUser = (cx, cy) => { const m = svg.getScreenCTM(); if (!m) return null; const p = new DOMPoint(cx, cy).matrixTransform(m.inverse()); return [p.x, p.y]; };
  wrap.addEventListener("wheel", e => {
    e.preventDefault();
    const p = toUser(e.clientX, e.clientY); if (!p) return;
    const k = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0015);
    const nw = Math.min(Math.max(vb.w * k, paper.w * 0.002), paper.w * 20), f = nw / vb.w;
    vb.x = p[0] - (p[0] - vb.x) * f; vb.y = p[1] - (p[1] - vb.y) * f; vb.w = nw; vb.h *= f; setVb();
  }, { passive: false });
  let drag = null;
  wrap.addEventListener("pointerdown", e => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, moved: false, id: e.pointerId }; });
  wrap.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) { drag.moved = true; wrap.setPointerCapture?.(e.pointerId); wrap.classList.add("is-pan"); }
    if (drag.moved) { const r = svg.getBoundingClientRect(), k = Math.max(vb.w / r.width, vb.h / r.height); vb.x = drag.vx - (e.clientX - drag.x) * k; vb.y = drag.vy - (e.clientY - drag.y) * k; setVb(); }
  });
  const endDrag = e => { wrap.classList.remove("is-pan"); const d = drag; drag = null; if (d && !d.moved && e.type === "pointerup") onClick(e); };
  wrap.addEventListener("pointerup", endDrag); wrap.addEventListener("pointercancel", endDrag);
  function onClick(e) {
    const p = toUser(e.clientX, e.clientY); if (!p) return;
    const r = svg.getBoundingClientRect(), tol = 6 * Math.max(vb.w / r.width, vb.h / r.height);
    const hit = hitTest(elements, p[0], p[1], tol, mode === "orig" ? () => true : el => clsOf(el) !== "hide");
    if (!hit) { select(-1); return; }
    if (e.altKey) { pickElement(hit); return; }
    select(hit.pi, true);
  }
  // ---- highlight -------------------------------------------------------------------------------------------------------------
  const setHl = pi => {
    if (pi < 0) { hl.textContent = ""; svg.classList.remove("lw-dim"); return; }
    svg.classList.add("lw-dim");
    hl.textContent = `.lw-svg.lw-dim [data-p]:not([data-p="${pi}"]){opacity:.14}.lw-svg [data-p="${pi}"]{stroke:#E5471F;animation:lw-pulse .9s ease-in-out 2}.lw-svg text[data-p="${pi}"]{fill:#E5471F;stroke:none}`;
  };
  let hover = -1;
  const refreshHl = () => setHl(hover >= 0 ? hover : selPen);

  // ---- side panel ------------------------------------------------------------------------------------------------------------
  const tblBox = mk("details", "lw-tbl"), tsum = tr(mk("summary", "", _t("lw.table")), "lw.table"), tbody = mk("div", "lw-tbody");
  tblBox.append(tsum, tbody);
  const ovBar = mk("div", "lw-ov"); ovBar.hidden = true;
  const list = mk("ul", "lw-pens"); list.setAttribute("aria-label", _t("lw.pens"));
  const penHead = tr(mk("div", "lw-penhead", _t("lw.pens")), "lw.pens");
  side.append(tblBox, ovBar, penHead, list);
  const inputs = {};
  const buildTable = () => {
    tbody.textContent = "";
    const head = mk("div", "lw-trow lw-thead"); head.append(mk("span", "", _t("lw.col.cls")), mk("span", "", _t("lw.col.w")), mk("span", "", _t("lw.col.color"))); tbody.append(head);
    for (const k of [...LINE_CLASSES, "text"]) {
      const row = mk("div", "lw-trow"), w = mk("input"), c = mk("input");
      w.type = "number"; w.min = "0.02"; w.max = "2"; w.step = "0.01"; c.type = "color";
      if (k === "text") { w.disabled = true; w.value = ""; w.placeholder = "–"; } else w.value = table[k].w;
      c.value = table[k].color.toLowerCase();
      w.setAttribute("aria-label", CLS_LABEL(k) + " " + _t("lw.col.w")); c.setAttribute("aria-label", CLS_LABEL(k) + " " + _t("lw.col.color"));
      w.oninput = () => { const v = parseFloat(w.value); if (v > 0 && v <= 5) { table[k].w = v; paintGroups(); } };
      c.oninput = () => { table[k].color = c.value.toUpperCase(); paintGroups(); };
      row.append(mk("span", "", CLS_LABEL(k)), w, c); tbody.append(row); inputs[k] = { w, c };
    }
  };
  const rows = [];
  const swatch = p => {
    const s = se("svg", { class: "lw-sw", viewBox: "0 0 40 12", width: 40, height: 12, "aria-hidden": "true" });
    if (p.text) { const t = se("text", { x: 2, y: 10, "font-size": 11, fill: "#111" }); t.textContent = "Aa"; s.append(t); }
    else if (p.fillOnly) s.append(se("rect", { x: 3, y: 1, width: 34, height: 10, fill: p.fill, stroke: "#ccc", "stroke-width": 0.5 }));
    else s.append(se("line", { x1: 2, y1: 6, x2: 38, y2: 6, stroke: p.stroke, "stroke-width": Math.max(0.6, Math.min(5, p.w_mm * 6)), ...(p.dash ? { "stroke-dasharray": "5 3" } : {}) }));
    return s;
  };
  const buildList = () => {
    list.textContent = ""; rows.length = 0;
    for (const p of pens) {
      const li = mk("li", "lw-pen"), sel = mk("select"), info = mk("div", "lw-peninfo"), why = mk("div", "lw-why"), cnt = mk("span", "lw-cnt");
      li.tabIndex = 0; li.dataset.i = p.i;
      const sw = swatch(p);
      cnt.textContent = _t("lw.count", { n: p.count });
      const opts = p.text ? ["text", "hide"] : [...LINE_CLASSES, "accent", "hide"];
      for (const k of opts) { const o = mk("option", "", CLS_LABEL(k)); o.value = k; sel.append(o); }
      sel.value = penCls[p.key]; sel.setAttribute("aria-label", _t("lw.cls.of", { pen: p.text ? _t("lw.text") : (p.fillOnly ? _t("lw.fill") : p.w_mm.toFixed(2) + " mm") }));
      why.textContent = reasonText(penReason[p.key]);
      info.append(cnt, why);
      const top = mk("div", "lw-pentop"); top.append(sw, mk("span", "lw-penname", p.text ? _t("lw.text") : p.fillOnly ? _t("lw.fill") : `${p.w_mm.toFixed(2)} mm${p.dash ? " · " + _t("lw.dashed") : ""}`), sel);
      li.append(top, info);
      sel.onchange = () => { penCls[p.key] = sel.value; penReason[p.key] = { k: "lw.r.manual", v: {} }; why.textContent = reasonText(penReason[p.key]); movePen(p, sel.value); select(p.i); };
      li.addEventListener("mouseenter", () => { hover = p.i; refreshHl(); }); li.addEventListener("mouseleave", () => { hover = -1; refreshHl(); });
      li.addEventListener("focus", () => { hover = p.i; refreshHl(); }); li.addEventListener("blur", () => { hover = -1; refreshHl(); });
      li.addEventListener("click", e => { if (e.target !== sel) select(p.i); });
      list.append(li); rows[p.i] = { li, sel, why };
    }
  };
  function select(pi, scroll) {
    selPen = pi;
    rows.forEach((r, i) => r.li.classList.toggle("is-sel", i === pi));
    refreshHl();
    if (pi >= 0 && scroll) rows[pi].li.scrollIntoView({ block: "nearest" });
  }
  function pickElement(e) {   // Alt+click: this one line only
    const cur = clsOf(e), opts = e.text ? ["text", "hide"] : [...LINE_CLASSES, "accent", "hide"];
    const pop = mk("div", "lw-pick"); pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", _t("lw.one"));
    const s = mk("select"); for (const k of opts) { const o = mk("option", "", CLS_LABEL(k)); o.value = k; s.append(o); } s.value = cur;
    const ok = mk("button", "bd-btn bd-strong", _t("lw.ok")), no = mk("button", "bd-btn", _t("lw.cancel")); ok.type = no.type = "button";
    pop.append(mk("span", "", _t("lw.one")), s, ok, no); view.append(pop); s.focus();
    const done = () => pop.remove();
    ok.onclick = () => { if (s.value === penCls[e.pen]) elCls.delete(e.id); else elCls.set(e.id, s.value); moveEl(e, s.value); updOv(); done(); };
    no.onclick = done;
    pop.addEventListener("keydown", ev => { if (ev.key === "Escape") { ev.stopPropagation(); done(); } else if (ev.key === "Enter" && ev.target === s) { ev.preventDefault(); ok.click(); } });
  }
  const updOv = () => {
    ovBar.hidden = !elCls.size; ovBar.textContent = "";
    if (!elCls.size) return;
    const b = mk("button", "bd-btn", _t("lw.ov.clear")); b.type = "button";
    b.onclick = () => { const ids = [...elCls.keys()]; elCls.clear(); for (const id of ids) moveEl(elements[id], penCls[elements[id].pen]); updOv(); };
    ovBar.append(mk("span", "", _t("lw.ov", { n: elCls.size })), b);
  };
  buildTable(); buildList();
  const onLang = () => { dlg.setAttribute("aria-label", _t("lw.title")); buildTable(); buildList(); updOv(); select(selPen); };
  document.addEventListener("a42:lang", onLang); langOff = () => document.removeEventListener("a42:lang", onLang);
  scaleSel.value = String(scale);
  scaleSel.onchange = () => { scale = Number(scaleSel.value); table = defaultTable(scale); paintGroups(); buildTable(); };
  const setMode = m => { mode = m; gClean.style.display = m === "clean" ? "" : "none"; if (m === "orig") buildOrig(); gOrig.style.display = m === "orig" ? "" : "none"; bClean.setAttribute("aria-pressed", String(m === "clean")); bOrig.setAttribute("aria-pressed", String(m === "orig")); };
  bClean.onclick = () => setMode("clean"); bOrig.onclick = () => setMode("orig"); setMode("clean");
  bAdd.disabled = bDl.disabled = false;

  // ---- output ----------------------------------------------------------------------------------------------------------------
  const out = () => renderLineworkSvg(elements, clsOf, table, paper);
  bDl.onclick = () => {
    const a = document.createElement("a"), url = URL.createObjectURL(new Blob([out()], { type: "image/svg+xml" }));
    a.href = url; a.download = baseName + "_linework.svg"; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  bAdd.onclick = async () => {
    bAdd.disabled = true;
    try {
      const s = out(), png = await svgToPng(s, paper.w, paper.h), k = Math.min(1, 841 / Math.max(paper.w, paper.h));
      await ctx.add({ kind: "diagram", title: baseName + _t("lw.suffix"), svg: s, preview: png, w: r2(paper.w * k), h: r2(paper.h * k) });
      close(); status(_t("lw.added"));
    } catch (e) { console.warn(e); bAdd.disabled = false; status(_t("lw.err.add")); }
  };
  if (pens.length) select(-1);
  if (!closed) dlg.focus({ preventScroll: true });
  return { close };
}

/** page chooser for a multi-page PDF: resolves to a page number or 0 (cancel) */
function pickPage(dlg, pdf, isClosed) {
  return new Promise(res => {
    const n = pdf.numPages, box = mk("div", "lw-pages"), head = mk("div", "lw-pageshead"), grid = mk("div", "lw-pagegrid"), num = mk("input"), go = mk("button", "bd-btn bd-strong", _t("lw.pick.go")), cancel = mk("button", "bd-btn", _t("lw.cancel"));
    num.type = "number"; num.min = "1"; num.max = String(n); num.value = "1"; num.setAttribute("aria-label", _t("lw.pick.n")); go.type = cancel.type = "button";
    head.append(mk("b", "", _t("lw.pick", { n })), num, go, cancel); box.append(head, grid); dlg.append(box);
    const finish = v => { box.remove(); res(v); };
    go.onclick = () => { const v = Math.round(Number(num.value)); if (v >= 1 && v <= n) finish(v); };
    cancel.onclick = () => finish(0);
    num.addEventListener("keydown", e => { if (e.key === "Enter") go.click(); });
    const shown = Math.min(n, 24);
    for (let i = 1; i <= shown; i++) {
      const b = mk("button", "lw-pagecell"), cv = mk("canvas"); b.type = "button"; b.append(cv, mk("span", "", `p.${i}`)); grid.append(b);
      b.onclick = () => finish(i);
      pdf.getPage(i).then(async pg => { if (isClosed()) return; const v1 = pg.getViewport({ scale: 1 }), sc = 120 / Math.max(v1.width, v1.height), vp = pg.getViewport({ scale: sc }); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height); const cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height); await pg.render({ canvasContext: cx, viewport: vp }).promise; }).catch(() => {});
    }
    num.focus();
  });
}
