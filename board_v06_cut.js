// Entourage sheet cutter: pure pixel functions (no DOM) so the board and the node tests share one source.
// Image = { data: Uint8ClampedArray|Uint8Array (RGBA), width, height }.
// Sheet cutting: contiguous background fill from the border (like a "contiguous" magic wand: white INSIDE a figure stays) ->
// connected parts -> merge near parts / drop specks -> one transparent crop per figure. All code written for this tool.
// Photo silhouette (step 5): background separation (border colour model or Otsu on luma) + a flat tone silhouette.

const clamp = (x, a = 0, b = 1) => x < a ? a : x > b ? b : x;

/** background colour = per-channel median of the 1-px border (transparent pixels count as white) */
export function estimateBg(img) {
  const { data, width: w, height: h } = img, rs = [], gs = [], bs = [];
  const add = (x, y) => { const i = (y * w + x) * 4, a = data[i + 3] / 255; rs.push(data[i] * a + 255 * (1 - a)); gs.push(data[i + 1] * a + 255 * (1 - a)); bs.push(data[i + 2] * a + 255 * (1 - a)); };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { add(0, y); add(w - 1, y); }
  const med = a => { a.sort((p, q) => p - q); return a[a.length >> 1] ?? 255; };
  return [med(rs), med(gs), med(bs)];
}

/** RGB distance of pixel i to the background colour (transparent -> 0 = background) */
function dist(data, i, bg) {
  const a = data[i + 3];
  if (a < 16) return 0;
  const k = a / 255, dr = data[i] * k + 255 * (1 - k) - bg[0], dg = data[i + 1] * k + 255 * (1 - k) - bg[1], db = data[i + 2] * k + 255 * (1 - k) - bg[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Contiguous fill from every border pixel that is within `tol` of the background colour (4-connected, so a diagonal
 * 1-px gap in a pen line does not leak). Returns Uint8Array: 1 = background, 0 = figure (including enclosed white).
 */
export function floodBackground(img, bg, tol) {
  const { data, width: w, height: h } = img, N = w * h, mask = new Uint8Array(N), stack = new Int32Array(N);
  let sp = 0;
  const ok = p => !mask[p] && dist(data, p * 4, bg) <= tol;
  const push = p => { mask[p] = 1; stack[sp++] = p; };
  for (let x = 0; x < w; x++) { if (ok(x)) push(x); const q = (h - 1) * w + x; if (ok(q)) push(q); }
  for (let y = 0; y < h; y++) { const a = y * w; if (ok(a)) push(a); const b = a + w - 1; if (ok(b)) push(b); }
  while (sp) {
    const p = stack[--sp], x = p % w;
    if (x > 0 && ok(p - 1)) push(p - 1);
    if (x < w - 1 && ok(p + 1)) push(p + 1);
    if (p >= w && ok(p - w)) push(p - w);
    if (p < N - w && ok(p + w)) push(p + w);
  }
  return mask;
}

/** 8-connected parts of the figure pixels (mask 0). -> { lab: Int32Array (0 = background, 1..n), boxes: [{x0,y0,x1,y1,area}] index = label-1 } */
export function labelParts(bgMask, w, h) {
  const N = w * h, lab = new Int32Array(N), boxes = [], stack = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (bgMask[s] || lab[s]) continue;
    const id = boxes.length + 1, b = { x0: w, y0: h, x1: -1, y1: -1, area: 0 };
    let sp = 0; stack[sp++] = s; lab[s] = id;
    while (sp) {
      const p = stack[--sp], x = p % w, y = (p / w) | 0;
      b.area++; if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx; if (!bgMask[q] && !lab[q]) { lab[q] = id; stack[sp++] = q; }
        }
      }
    }
    boxes.push(b);
  }
  return { lab, boxes };
}

/**
 * Merge parts whose boxes lie within `gap` px of each other (union-find), then drop groups smaller than `minArea` px.
 * -> groups [{ ids: [label...], x0,y0,x1,y1, area }] sorted left-to-right in rows (reading order).
 */
export function groupParts(boxes, { gap = 0, minArea = 0 } = {}) {
  const n = boxes.length, par = Array.from({ length: n }, (_, i) => i);
  const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].x0 - boxes[b].x0);
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi], a = boxes[i];
    for (let oj = oi + 1; oj < n; oj++) {
      const j = order[oj], b = boxes[j];
      if (b.x0 > a.x1 + gap) break;   // sorted by x0: nothing further can touch
      // x overlap is guaranteed here; check y within gap
      if (b.y0 <= a.y1 + gap && a.y0 <= b.y1 + gap) par[find(j)] = find(i);
    }
  }
  const map = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i), b = boxes[i]; let g = map.get(r);
    if (!g) { g = { ids: [], x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, area: 0 }; map.set(r, g); }
    g.ids.push(i + 1); g.area += b.area; g.x0 = Math.min(g.x0, b.x0); g.y0 = Math.min(g.y0, b.y0); g.x1 = Math.max(g.x1, b.x1); g.y1 = Math.max(g.y1, b.y1);
  }
  return sortReading([...map.values()].filter(g => g.area >= minArea));
}

/** reading order: rows by vertical centre (tolerance = half the median height), then left to right */
export function sortReading(groups) {
  if (groups.length < 2) return groups;
  const hs = groups.map(g => g.y1 - g.y0 + 1).sort((a, b) => a - b), tol = hs[hs.length >> 1] / 2;
  const gs = [...groups].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1)), rows = [];
  for (const g of gs) {
    const cy = (g.y0 + g.y1) / 2, r = rows.find(r => Math.abs(r.cy - cy) <= tol);
    if (r) { r.items.push(g); r.cy = (r.cy * (r.items.length - 1) + cy) / r.items.length; } else rows.push({ cy, items: [g] });
  }
  rows.sort((a, b) => a.cy - b.cy);
  return rows.flatMap(r => r.items.sort((a, b) => a.x0 - b.x0));
}

/** merge several groups into one (manual "합치기") */
export function mergeGroups(gs) {
  const o = { ids: [], x0: Infinity, y0: Infinity, x1: -1, y1: -1, area: 0 };
  for (const g of gs) { o.ids.push(...g.ids); o.area += g.area; o.x0 = Math.min(o.x0, g.x0); o.y0 = Math.min(o.y0, g.y0); o.x1 = Math.max(o.x1, g.x1); o.y1 = Math.max(o.y1, g.y1); }
  return o;
}

/**
 * Transparent crop of one group. Pixels of other figures that fall inside this box stay transparent; the soft edge ramps alpha
 * for figure pixels that touch the background and are only a little different from it (anti-aliased pen lines, blob fringes).
 * -> { width, height, data (RGBA), x, y } ; the figure's feet are the bottom row of the crop.
 */
export function cropGroup(img, lab, bgMask, group, { tol = 40, bg } = {}) {
  const { data, width: w, height: h } = img, bgc = bg || estimateBg(img), ids = new Set(group.ids);
  const x0 = group.x0, y0 = group.y0, cw = group.x1 - x0 + 1, ch = group.y1 - y0 + 1, out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const sx = x + x0, sy = y + y0, p = sy * w + sx;
    if (bgMask[p] || !ids.has(lab[p])) continue;
    const i = p * 4, o = (y * cw + x) * 4;
    let a = 255;
    const edge = (sx > 0 && bgMask[p - 1]) || (sx < w - 1 && bgMask[p + 1]) || (sy > 0 && bgMask[p - w]) || (sy < h - 1 && bgMask[p + w]);
    if (edge) { const d = dist(data, i, bgc); a = Math.round(255 * clamp((d - tol * 0.5) / (tol * 1.5))); }
    out[o] = data[i]; out[o + 1] = data[i + 1]; out[o + 2] = data[i + 2]; out[o + 3] = Math.min(a, data[i + 3] || 255);
  }
  return { width: cw, height: ch, data: out, x: x0, y: y0 };
}

/** one call: sheet -> groups (+ the label/mask the crops need) */
export function cutSheet(img, { tol = 40, gap = 6, minArea = 30, bg } = {}) {
  const bgc = bg || estimateBg(img), mask = floodBackground(img, bgc, tol), { lab, boxes } = labelParts(mask, img.width, img.height);
  return { bg: bgc, mask, lab, boxes, groups: groupParts(boxes, { gap, minArea }) };
}

/** card size of a cut figure of real height hm at 1:den, in mm (matches figBox in board_v06_figs.js: width = height * W / 100) */
export const cutW = (w, h) => Math.round(w / h * 10000) / 100;   // unit width at height 100

// ---- default real heights (m) per kind -----------------------------------------------------------------------------------------
export const KIND_HM = {
  person: 1.75, sit: 1.3, child: 1.2, bike: 1.1, wheelchair: 1.25,
  tree_s: 6, tree_m: 10, tree_l: 14, car: 1.5, bench: 0.9, lamp: 5, rack: 0.9,
  sofa: 0.85, table: 0.75, shelf: 2, bldg: 21, other: 1.75
};
export const KINDS = Object.keys(KIND_HM);
export const kindHm = k => KIND_HM[k] ?? 1.75;
export const isTreeKind = k => k === "tree_s" || k === "tree_m" || k === "tree_l";

// ============================================================================================================================
// Photo -> silhouette (step 5). Float helpers, border colour model, Otsu path, flat tone silhouette.
// ============================================================================================================================
function boxPass(src, dst, w, h, r, horiz) {
  const n = horiz ? w : h, m = horiz ? h : w, sz = 2 * r + 1;
  for (let j = 0; j < m; j++) {
    const base = horiz ? j * w : j, step = horiz ? 1 : w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[base + Math.min(n - 1, Math.max(0, k)) * step];
    for (let i = 0; i < n; i++) {
      dst[base + i * step] = acc / sz;
      acc += src[base + Math.min(n - 1, i + r + 1) * step] - src[base + Math.max(0, i - r) * step];
    }
  }
}
/** gaussian blur approximated by three box passes */
export function gauss(src, w, h, sigma) {
  if (sigma < 0.3) return Float32Array.from(src);
  const nP = 3, wi = Math.sqrt(12 * sigma * sigma / nP + 1);
  let wl = Math.floor(wi); if (wl % 2 === 0) wl--;
  const wu = wl + 2, mi = Math.round((12 * sigma * sigma - nP * wl * wl - 4 * nP * wl - 3 * nP) / (-4 * wl - 4));
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  for (let p = 0; p < nP; p++) { const r = ((p < mi ? wl : wu) - 1) / 2; boxPass(a, b, w, h, r, true); boxPass(b, a, w, h, r, false); }
  return a;
}
const toF = u8 => { const f = new Float32Array(u8.length); for (let i = 0; i < f.length; i++) f[i] = u8[i] ? 1 : 0; return f; };
export function dilate(u8, w, h, r) { const g = gauss(toF(u8), w, h, r / 2.2), o = new Uint8Array(u8.length); for (let i = 0; i < o.length; i++) o[i] = g[i] > 0.08 ? 1 : 0; return o; }
export function erode(u8, w, h, r) { const g = gauss(toF(u8), w, h, r / 2.2), o = new Uint8Array(u8.length); for (let i = 0; i < o.length; i++) o[i] = g[i] > 0.92 ? 1 : 0; return o; }
/** remove parts smaller than minArea px (and, with keepRel, smaller than that share of the largest part) */
export function dropSmall(u8, w, h, minArea, keepRel = 0) {
  const inv = new Uint8Array(u8.length); for (let i = 0; i < inv.length; i++) inv[i] = u8[i] ? 0 : 1;
  const { lab, boxes } = labelParts(inv, w, h);
  let big = 0; for (const b of boxes) big = Math.max(big, b.area);
  const th = Math.max(minArea, keepRel ? big * keepRel : 0), o = new Uint8Array(u8.length);
  for (let i = 0; i < o.length; i++) if (lab[i] && boxes[lab[i] - 1].area >= th) o[i] = 1;
  return o;
}
/** fill background holes smaller than maxArea px */
export function holesSmall(u8, w, h, maxArea) {
  const { lab, boxes } = labelParts(u8, w, h);   // parts of the BACKGROUND (u8 = 1 for figure -> labelParts treats 1 as "no part")
  const o = Uint8Array.from(u8);
  for (let i = 0; i < o.length; i++) if (!u8[i] && lab[i] && boxes[lab[i] - 1].area < maxArea) o[i] = 1;
  return o;
}

function bgPalette(px, w, h) {
  const bins = new Map(); let total = 0;
  const add = (x, y) => {
    const i = (y * w + x) * 4, r = px[i], g = px[i + 1], b = px[i + 2], k = (r >> 5) * 64 + (g >> 5) * 8 + (b >> 5);
    let e = bins.get(k); if (!e) { e = [0, 0, 0, 0]; bins.set(k, e); }
    e[0] += r; e[1] += g; e[2] += b; e[3]++; total++;
  };
  const top = Math.max(2, Math.round(h * 0.04)), side = Math.max(2, Math.round(w * 0.03));
  for (let y = 0; y < top; y++) for (let x = 0; x < w; x += 2) add(x, y);
  for (let y = 0; y < h * 0.8; y += 2) { for (let x = 0; x < side; x++) add(x, y); for (let x = w - side; x < w; x++) add(x, y); }
  const pal = []; for (const e of bins.values()) if (e[3] >= total * 0.012) pal.push([e[0] / e[3], e[1] / e[3], e[2] / e[3]]);
  return pal;
}
function rowModel(px, w, h) {   // per-row background colour from the left / right strips (handles vertical sky gradients)
  const sw = Math.max(3, Math.round(w * 0.03)), L = [], R = [], med = a => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  for (let y = 0; y < h; y++) {
    const l = [[], [], []], r = [[], [], []];
    for (let x = 0; x < sw; x++) { const i = (y * w + x) * 4, j = (y * w + w - 1 - x) * 4; for (let c = 0; c < 3; c++) { l[c].push(px[i + c]); r[c].push(px[j + c]); } }
    L.push(l.map(med)); R.push(r.map(med));
  }
  return { L, R };
}
/** foreground = pixels far (colour) from the border background model; T = colour distance */
export function colourFg(px, w, h, T) {
  const pal = bgPalette(px, w, h), fg = new Uint8Array(w * h), T2 = T * T, rm = rowModel(px, w, h);
  for (let y = 0; y < h; y++) {
    const L = rm.L[y], R = rm.R[y];
    for (let x = 0; x < w; x++) {
      const p = y * w + x, r = px[p * 4], g = px[p * 4 + 1], b = px[p * 4 + 2], t = x / w; let best = 1e9;
      for (const q of [L, R, [L[0] * (1 - t) + R[0] * t, L[1] * (1 - t) + R[1] * t, L[2] * (1 - t) + R[2] * t]]) { const dr = r - q[0], dg = g - q[1], db = b - q[2], d = dr * dr * 0.9 + dg * dg * 1.2 + db * db * 0.9; if (d < best) best = d; }
      for (let k = 0; k < pal.length; k++) { const q = pal[k], dr = r - q[0], dg = g - q[1], db = b - q[2], d = dr * dr * 0.9 + dg * dg * 1.2 + db * db * 0.9; if (d < best) best = d; }
      fg[p] = best > T2 ? 1 : 0;
    }
  }
  return fg;
}
/** foreground = darker than an Otsu threshold on luma (bare / silhouette photos against a bright sky); k scales the threshold */
export function darkFg(px, w, h, k = 1) {
  const g = new Uint8Array(w * h), hist = new Float64Array(256);
  for (let i = 0; i < w * h; i++) { g[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) | 0; hist[g[i]]++; }
  const tot = w * h; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wb = 0, sb = 0, best = -1, th = 128;
  for (let t = 0; t < 256; t++) {
    wb += hist[t]; if (!wb) continue; const wf = tot - wb; if (!wf) break;
    sb += t * hist[t]; const mb = sb / wb, mf = (sum - sb) / wf, v = wb * wf * (mb - mf) * (mb - mf); if (v > best) { best = v; th = t; }
  }
  th *= k; const fg = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) fg[i] = g[i] <= th ? 1 : 0; return fg;
}

/**
 * Photo (RGBA at working size) -> clean figure mask + bbox. opt: { mode: "colour"|"dark", T, dk, ground (% of height from the top where the
 * figure is cut off = the floor line), xmin (% from the left to ignore) }.
 * -> { fg, bbox:{x0,y0,x1,y1} } ; throws "empty" when nothing is left.
 */
export function photoMask(px, w, h, opt = {}) {
  const o = { mode: "colour", T: 40, dk: 1, ground: 0, xmin: 0, ...opt };
  let fg = o.mode === "dark" ? darkFg(px, w, h, o.dk) : colourFg(px, w, h, o.T);
  if (o.ground > 0) fg.fill(0, Math.round(h * o.ground / 100) * w);
  if (o.xmin > 0) { const x1 = Math.round(w * o.xmin / 100); for (let y = 0; y < h; y++) fg.fill(0, y * w, y * w + x1); }
  fg = dilate(fg, w, h, 2); fg = erode(fg, w, h, 2);                                   // close small gaps
  fg = holesSmall(fg, w, h, Math.round(w * h * 0.00005));
  fg = dropSmall(fg, w, h, Math.round(w * h * 0.0002), 0.02);                          // the largest part and comparable ones only
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fg[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 <= x0 || y1 <= y0) throw new Error("empty");
  return { fg, bbox: { x0, y0, x1, y1 } };
}

const mix = (a, b, u) => a + (b - a) * u;
/**
 * Flat tone silhouette (S3 recipe): od = RGBA of the photo crop at output size, md = figure mask at that size (0/255 in .r or Uint8 0/1 array).
 * tex 0..1: how much of the photo's local light/dark shows as a quiet tone change inside the flat shape (0 = perfectly flat).
 * -> RGBA Uint8ClampedArray (soft anti-aliased alpha).
 */
export function silhouetteRGBA(od, mask, W, H, { tex = 1, light = [0xB7, 0xBD, 0xC4], dark = [0x78, 0x7F, 0x88] } = {}) {
  const N = W * H;
  let M = new Float32Array(N); for (let i = 0; i < N; i++) M[i] = mask[i] ? 1 : 0;
  M = gauss(M, W, H, 1.6);
  let Mb = new Uint8Array(N); for (let i = 0; i < N; i++) Mb[i] = M[i] > 0.5 ? 1 : 0;
  Mb = erode(Mb, W, H, 1.5); Mb = dropSmall(Mb, W, H, 60, 0);
  const Mf = gauss(toF(Mb), W, H, 0.9);                                                // soft AA alpha
  const g = new Float32Array(N); for (let i = 0; i < N; i++) g[i] = (0.299 * od[i * 4] + 0.587 * od[i * 4 + 1] + 0.114 * od[i * 4 + 2]) / 255;
  // local normalisation: luma / blurred luma inside the figure only
  const a = new Float32Array(N), mm = new Float32Array(N); for (let i = 0; i < N; i++) { a[i] = g[i] * Mb[i]; mm[i] = Mb[i]; }
  const A = gauss(a, W, H, H / 16), Mw = gauss(mm, W, H, H / 16);
  const gn = new Float32Array(N); for (let i = 0; i < N; i++) gn[i] = Mb[i] ? clamp(g[i] / Math.max(A[i] / Math.max(Mw[i], 1e-3), 0.08), 0, 2.5) : 2.5;
  const t3 = gauss(gn, W, H, 2.4), t3b = gauss(gn, W, H, 9), out = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) {
    const u = tex * clamp(0.5 - 0.55 * (t3[i] - 1) - 0.35 * (t3b[i] - 1), 0, 1) + (1 - tex) * 0.35;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = mix(light[c], dark[c], u);
    out[i * 4 + 3] = Math.round(255 * 0.92 * Mf[i]);
  }
  return out;
}
