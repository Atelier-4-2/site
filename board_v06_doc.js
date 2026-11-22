import { t as _t } from "./i18n.js?v=20261122i";
// Board v3 document model: constants, geometry, sanitizing and v1/v2 -> v3 migration (page membership, layers, guides).
// Pure (no DOM at import time) so it can be tested in node. Everything read from outside (opened .atelier files,
// IndexedDB records) goes through sanitizeDoc(): strings capped, numbers clamped, enums whitelisted.
import { makeParents, DEFAULT_SWATCHES, isColorRef, SW_RE, HEX_RE, MAX_SWATCHES, pairSpreads } from "./board_v06_parent.js?v=20261122i";
import { cleanUrl, hostOf, cleanArrows, cleanStacks, STATUSES, cleanTags, cleanSections, cleanComments, cleanMarks, isDate, todayStr } from "./board_v06_record.js?v=20261122i";
export const DOC_VERSION = 5;
export const LAYERS = ["bg", "art", "text"];   // stacking order, bottom to top
export const LAYER_LABEL = { get bg() { return _t('board.doc.001'); }, get art() { return _t('board.doc.002'); }, get text() { return _t('board.doc.003'); } };
export const defaultLayer = kind => (kind === "text" || kind === "memo" || kind === "stamp") ? "text" : "art";
export const defaultLayers = () => ({ bg: { hidden: false, locked: false }, art: { hidden: false, locked: false }, text: { hidden: false, locked: false } });
export const MAX_GUIDES = 200;

// ---- build 4a-1: drawing scale (B17), scale-bar / north stamps (B15), image frame vs content (B8) -------------------------------
export const SHEET_W = 420;   // native width (mm) of a diagram sheet; diagram meta.mpm = metres per sheet mm
export const STD_DENS = [20, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
export const STAMPS = ["bar_ticks", "bar_alt", "ratio", "north_arrow", "north_circle", "north_cross"];
export const STAMP_LABEL = { get bar_ticks() { return _t('board.doc.004'); }, get bar_alt() { return _t('board.doc.005'); }, get ratio() { return _t('board.doc.006'); }, get north_arrow() { return _t('board.doc.007'); }, get north_circle() { return _t('board.doc.008'); }, get north_cross() { return _t('board.doc.009'); } };
export const isNorthStamp = k => k === "north_arrow" || k === "north_circle" || k === "north_cross";
export const isBarStamp = k => k === "bar_ticks" || k === "bar_alt";
// printed scale denominator of a card: diagrams follow their width (or the locked value), images carry a manual label
export function cardDen(c, asset) {
  if (!c || (c.kind !== "diagram" && c.kind !== "image")) return null;
  const mpm = Number(asset?.meta?.mpm);
  if (c.kind === "diagram" && mpm > 0) {
    if (c.scale?.locked && c.scale.den) return c.scale.den;
    const shown = contentRect(c, asset).w;   // the width the sheet is really drawn at (content, not the frame)
    if (c.scale?.den) { const w = widthForDen(mpm, c.scale.den); if (Math.abs(shown - w) <= Math.max(0.011, w * 0.0003)) return c.scale.den; }   // stored-width rounding must not move the denominator
    return Math.max(1, Math.round(mpm * 1000 * SHEET_W / shown));
  }
  return c.scale?.den || null;
}
export const widthForDen = (mpm, den) => SHEET_W * mpm * 1000 / den;   // card width (mm) at which a diagram prints exactly 1:den
export const realWidthM = (cw, den) => cw * den / 1000;
// bar length in metres as 1/2/5 x 10^n so that the bar is 20-60 mm at 1:den (closest to 40 mm)
export function niceLen(den) {
  let best = 1, bd = Infinity;
  for (let e = -3; e <= 7; e++) for (const m of [1, 2, 5]) { const L = m * 10 ** e, mm = L * 1000 / den, d = mm >= 20 && mm <= 60 ? Math.abs(mm - 40) : 1e9 + Math.abs(mm - 40); if (d < bd) { bd = d; best = L; } }
  return best;
}
export const ppiOf = (nativePx, contentWmm) => (nativePx > 0 && contentWmm > 0) ? nativePx / (contentWmm / 25.4) : 0;
export const ppiClass = ppi => ppi >= 250 ? "ok" : ppi >= 150 ? "mid" : "low";
// image content inside its frame, frame-local mm: s >= 1 is the shown width as a multiple of the "contain" width
export function contentRect(c, asset) {
  const a = (asset?.w > 0 && asset?.h > 0) ? asset.w / asset.h : c.w / c.h;
  const fh = c.h > 0 ? c.h : c.w / a, cwid = Math.min(c.w, fh * a), chei = cwid / a;
  const k = c.content || { dx: 0, dy: 0, s: 1 }, w = cwid * k.s, h = chei * k.s;
  return { x: (c.w - w) / 2 + k.dx, y: (c.h - h) / 2 + k.dy, w, h, containW: cwid, aspect: a };
}
export const coverScale = (c, asset) => { const r = contentRect({ ...c, content: null }, asset); return Math.max(c.w / r.w, c.h / r.h); };
const fnum = n => String(Math.round(n * 100) / 100);
// size (mm) of an auto-sized stamp; north stamps keep the card's own box
export function stampBox(st) {
  if (st.stamp === "ratio") return { w: 30, h: 8 };
  if (isBarStamp(st.stamp)) { const L = st.len_m * 1000 / Math.max(1, st.den); return st.stamp === "bar_ticks" ? { w: Math.max(12, r2(L + 14)), h: 10 } : { w: Math.max(12, r2(L + 14)), h: 9 }; }
  return null;
}
// pure vector drawing in card-local mm (0..w, 0..h); ink + white only. Reused by the board screen, export and (later) parent pages.
export function stampSvg(st, den = st.den, opt = {}) {
  const INK = "#1d1d1f", wt = opt.pdf ? "bold" : "600", w = st.w, h = st.h, k = st.stamp;
  const T = (x, y, t, size, anchor = "middle", bold = false) => `<text x="${fnum(x)}" y="${fnum(y)}" font-size="${size}" text-anchor="${anchor}" fill="${INK}"${bold ? ` font-weight="${wt}"` : ""}>${t}</text>`;
  if (k === "ratio") return T(w / 2, h * 0.72, `1:${Math.round(den)}`, 5, "middle", true);
  if (isBarStamp(k)) {
    const L = st.len_m * 1000 / Math.max(1, den), x0 = (w - L) / 2, km = st.unit === "km", unit = km ? "km" : "m", half = fnum(km ? st.len_m / 2000 : st.len_m / 2), full = fnum(km ? st.len_m / 1000 : st.len_m);
    if (k === "bar_ticks") {
      return `<path d="M${fnum(x0)} 6.5H${fnum(x0 + L)}M${fnum(x0)} 3.5V6.5M${fnum(x0 + L / 2)} 4.5V6.5M${fnum(x0 + L)} 3.5V6.5" stroke="${INK}" stroke-width="0.3" fill="none"/>` +
        T(x0, 9.4, "0", 2.8) + T(x0 + L / 2, 9.4, half, 2.8) + T(x0 + L, 9.4, `${full} ${unit}`, 2.8);
    }
    let seg = "";
    for (let i = 0; i < 4; i++) seg += `<rect x="${fnum(x0 + i * L / 4)}" y="2.5" width="${fnum(L / 4)}" height="2.2" fill="${i % 2 ? "#ffffff" : INK}" stroke="${INK}" stroke-width="0.2"/>`;
    return seg + T(x0, 8.6, "0", 2.8) + T(x0 + L / 2, 8.6, half, 2.8) + T(x0 + L, 8.6, `${full} ${unit}`, 2.8);
  }
  const rot = `rotate(${fnum(st.angle || 0)} ${fnum(w / 2)} ${fnum(h / 2)})`;
  const arrow = (x, y, aw, ah) => `<polygon points="${fnum(x + aw / 2)},${fnum(y)} ${fnum(x)},${fnum(y + ah)} ${fnum(x + aw / 2)},${fnum(y + ah * 0.72)}" fill="${INK}"/><polygon points="${fnum(x + aw / 2)},${fnum(y)} ${fnum(x + aw)},${fnum(y + ah)} ${fnum(x + aw / 2)},${fnum(y + ah * 0.72)}" fill="#ffffff" stroke="${INK}" stroke-width="0.25"/>`;
  if (k === "north_arrow") { const fs = Math.min(w, h) * 0.3; return `<g transform="${rot}">${T(w / 2, fs * 0.9, "N", fs, "middle", true)}${arrow(w * 0.2, fs * 1.15, w * 0.6, h - fs * 1.15)}</g>`; }
  if (k === "north_circle") { const r = Math.min(w, h) / 2 - 0.3, fs = r * 0.55; return `<g transform="${rot}"><circle cx="${fnum(w / 2)}" cy="${fnum(h / 2)}" r="${fnum(r)}" fill="#ffffff" stroke="${INK}" stroke-width="0.35"/>${arrow(w / 2 - r * 0.32, h / 2 - r * 0.52, r * 0.64, r * 1.3)}${T(w / 2, h / 2 - r - 0.8, "N", fs, "middle", true)}</g>`; }
  const r = Math.min(w, h) / 2 - 3, fs = Math.min(w, h) * 0.17, cx = w / 2, cy = h / 2;   // north_cross
  return `<g transform="${rot}"><path d="M${fnum(cx)} ${fnum(cy - r)}V${fnum(cy + r)}M${fnum(cx - r)} ${fnum(cy)}H${fnum(cx + r)}" stroke="${INK}" stroke-width="0.35"/><polygon points="${fnum(cx)},${fnum(cy - r)} ${fnum(cx - r * 0.18)},${fnum(cy - r * 0.35)} ${fnum(cx + r * 0.18)},${fnum(cy - r * 0.35)}" fill="${INK}"/>` +
    T(cx, cy - r - 0.6, "N", fs, "middle", true) + T(cx, cy + r + fs * 0.85, "S", fs) + T(cx + r + 0.6, cy + fs * 0.35, "E", fs, "start") + T(cx - r - 0.6, cy + fs * 0.35, "W", fs, "end") + `</g>`;
}

export const PAPER = { A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297] };   // portrait w x h (mm)
export const SIZES = Object.keys(PAPER);
export const ROLES = ["title", "h1", "h2", "subtitle", "body", "caption", "scale", "number"];
export const ROLE_LABEL = { get title() { return _t('board.doc.010'); }, h1: "H1", h2: "H2", get subtitle() { return _t('board.doc.011'); }, get body() { return _t('board.doc.012'); }, get caption() { return _t('board.doc.013'); }, get scale() { return _t('board.doc.014'); }, get number() { return _t('board.doc.015'); } };
export const PALETTE = ["#1d1d1f", "#6e6e73", "#a1a1a6", "#3b6ea5", "#c0392b"];
export const DEFAULT_STYLES = {
  title: { size: 9, weight: 700, color: "#1d1d1f", tracking: 0 },
  h1: { size: 7, weight: 700, color: "#1d1d1f", tracking: 0 },
  h2: { size: 5.5, weight: 600, color: "#1d1d1f", tracking: 0 },
  subtitle: { size: 6, weight: 600, color: "#1d1d1f", tracking: 0 },
  body: { size: 5, weight: 400, color: "#1d1d1f", tracking: 0 },
  caption: { size: 4, weight: 400, color: "#6e6e73", tracking: 0 },
  scale: { size: 3.2, weight: 400, color: "#6e6e73", tracking: 0 },
  number: { size: 12, weight: 700, color: "#1d1d1f", tracking: 0 }
};
export const FSTYLES = ["none", "thin", "box"];
export const FSTYLE_LABEL = { get none() { return _t('board.doc.016'); }, get thin() { return _t('board.doc.017'); }, get box() { return _t('board.doc.018'); } };
export const defaultFstyles = () => ({ thin: { w: 0.25, color: "#1d1d1f" }, box: { w: 0.25, color: "#1d1d1f" } });
export const ROLE_BOX = {   // default card size when a text card is created (mm)
  title: { w: 220, h: 14 }, subtitle: { w: 180, h: 10 }, body: { w: 140, h: 40 }, caption: { w: 160, h: 8 }, number: { w: 30, h: 16 }, h1: { w: 200, h: 12 }, h2: { w: 160, h: 10 }, scale: { w: 40, h: 6 }
};
export const MEMO_COLORS = ["#fff3a8", "#ffd6d6", "#d6ecff", "#dff5d8"];
export const WEIGHTS = [300, 400, 500, 600, 700];
export const GRID_DEFAULT = 5;
export const TEMPLATE_KEYS = ["none", "c3", "c4", "c6", "c12"];
export const TEMPLATE_LABEL = { get none() { return _t('board.doc.016'); }, get c3() { return _t('board.doc.019'); }, get c4() { return _t('board.doc.020'); }, get c6() { return _t('board.doc.021'); }, get c12() { return _t('board.doc.022'); } };
const TPL_BASE = { c3: { margin: 15, cols: 3, rows: 4, gutter: 5 }, c4: { margin: 15, cols: 4, rows: 6, gutter: 5 }, c6: { margin: 15, cols: 6, rows: 8, gutter: 5 }, c12: { margin: 15, cols: 12, rows: 8, gutter: 5 } };
export const bigPaper = size => size === "A0" || size === "A1";
export function makeTemplate(key, size) {
  const b = TPL_BASE[key];
  if (!b) return null;
  const k = bigPaper(size) ? 1.5 : 1;
  return { margin: b.margin * k, cols: b.cols, rows: b.rows, gutter: b.gutter * k };
}
export function templateKey(t) {
  if (!t) return "none";
  for (const k of Object.keys(TPL_BASE)) if (t.cols === TPL_BASE[k].cols) return k;
  return "none";
}

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const IMG_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
export const safeImg = u => (typeof u === "string" && IMG_RE.test(u)) ? u : "";
export const num = (v, d, lo = -1e6, hi = 1e6) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
export const safeId = (v, fb) => /^[A-Za-z0-9_-]{1,40}$/.test(String(v)) ? String(v) : fb;
export const str = (v, max, d = "") => (typeof v === "string" || typeof v === "number") ? String(v).slice(0, max) : d;
export const r2 = n => Math.round(n * 100) / 100;
export const pad2 = n => String(n).padStart(2, "0");

// ---- geometry -----------------------------------------------------------------------------------
export const frameSize = f => { const [a, b] = PAPER[f.size] || PAPER.A3; return f.orientation === "portrait" ? [a, b] : [b, a]; };
// Topmost page (last in the list is drawn last) that contains a world point, or null for the pasteboard.
export function pageAt(frames, px, py) {
  for (let i = frames.length - 1; i >= 0; i--) { const f = frames[i], [w, h] = frameSize(f); if (px >= f.x && px <= f.x + w && py >= f.y && py <= f.y + h) return f; }
  return null;
}
// Page membership = which page rect holds the card CENTRE (rotation keeps the centre). Stored as card.page (frame id | null).
export function assignPages(doc) {
  for (const c of doc.cards) { const f = pageAt(doc.frames, c.x + c.w / 2, c.y + c.h / 2); c.page = f ? f.id : null; }
}
export const orientLabel = f => (f.orientation === "portrait" ? _t('board.doc.023') : _t('board.doc.024'));
export const pageLabel = f => `${pad2(f.page)} · ${f.size} ${orientLabel(f)}`;
export const pageKind = size => (size === "A3" || size === "A4") ? "Carnet" : "Planche";
export const pageTitle = f => { const [w, h] = frameSize(f); return `${pad2(f.page)} · ${pageKind(f.size)} — ${f.size} ${w}×${h}`; };
export const cartHeight = size => (size === "A0" || size === "A1") ? 24 : size === "A2" ? 18 : 12;
export const frameMargin = f => f.template ? f.template.margin : (bigPaper(f.size) ? 15 : 10);
// Column / row cells in frame-local mm, or null without a template. The cartouche strip is kept out of the grid.
export function gridCells(f, cart = f.cartouche) {   // cart: a cartouche strip (own or from the parent) is kept out of the grid
  const t = f.template;
  if (!t) return null;
  const [W, H] = frameSize(f);
  const x0 = t.margin, x1 = W - t.margin, y0 = t.margin, y1 = H - t.margin - (cart ? cartHeight(f.size) + t.gutter : 0);
  const cw = (x1 - x0 - (t.cols - 1) * t.gutter) / t.cols, rh = (y1 - y0 - (t.rows - 1) * t.gutter) / t.rows;
  if (!(cw > 0) || !(rh > 0)) return null;
  const xs = [], ys = [];
  for (let i = 0; i < t.cols; i++) xs.push([x0 + i * (cw + t.gutter), x0 + i * (cw + t.gutter) + cw]);
  for (let j = 0; j < t.rows; j++) ys.push([y0 + j * (rh + t.gutter), y0 + j * (rh + t.gutter) + rh]);
  return { xs, ys, x0, x1, y0, y1 };
}
// "1-3,5" -> [1,2,3,5] within 1..n, or null when the text is not a valid range list
export function parseRange(text, n) {
  const out = new Set();
  const parts = String(text || "").split(/[,\s]+/).filter(Boolean);
  if (!parts.length) return null;
  for (const p of parts) {
    const m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(p);
    if (!m) return null;
    let a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    if (a > b) [a, b] = [b, a];
    for (let i = Math.max(1, a); i <= Math.min(n, b); i++) out.add(i);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}
// A3 tiles of a page larger than a sheet: 8 mm slug on every side for marks and the label, 10 mm overlap.
export const TILE_SLUG = 8, TILE_OVERLAP = 10;
export function tilePlan(W, H) {
  const best = [];
  for (const [sw, sh] of [[420, 297], [297, 420]]) {
    const tw = sw - TILE_SLUG * 2, th = sh - TILE_SLUG * 2;
    const cnt = (len, t) => len <= t ? 1 : Math.ceil((len - TILE_OVERLAP) / (t - TILE_OVERLAP));
    best.push({ sw, sh, tw, th, nx: cnt(W, tw), ny: cnt(H, th) });
  }
  best.sort((a, b) => a.nx * a.ny - b.nx * b.ny || (W >= H ? b.sw - a.sw : a.sw - b.sw));
  return best[0];
}
// A3 and A4 pages already fit one sheet and are output as they are; A2 and larger are split.
export const needsTiles = (W, H) => !((W <= 420.5 && H <= 297.5) || (W <= 297.5 && H <= 420.5));

// ---- sanitizing -----------------------------------------------------------------------------------
export function sanitizeSvgTree(root) {
  for (const e of [...root.querySelectorAll("script,foreignObject,iframe,object,embed,set,animate,animateMotion,animateTransform,audio,video,link,meta")]) e.remove();
  const strip = v => v.replace(/[\x00-\x20\u00a0\u2028\u2029]/g, "");   // control chars / spaces hide schemes ("java\tscript:")
  for (const e of [root, ...root.querySelectorAll("*")]) {
    for (const a of [...e.attributes]) {
      const ln = (a.localName || a.name).toLowerCase(), v = a.value, vc = strip(v);   // localName: any prefix (xlink:href, x:href, plain href)
      let bad = ln.startsWith("on") || a.name.toLowerCase().startsWith("on") || /javascript:|vbscript:/i.test(vc) || /url\(\s*['"]?(?!#)/i.test(v);
      if (!bad && ln === "href" && !(vc.startsWith("#") || /^data:image\/(png|jpeg|webp|gif)[;,]/i.test(vc))) bad = true;
      if (bad) e.removeAttribute(a.name);
    }
    if (e.localName === "style") {
      let t = e.textContent, prev;
      do { prev = t; t = t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import[^;]*;?/gi, "").replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, "none"); } while (t !== prev);
      e.textContent = t;
    }
  }
}
export function cleanSvgString(text) {
  if (typeof text !== "string") return "";
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || doc.querySelector("parsererror") || root.localName !== "svg") return "";
  sanitizeSvgTree(root);
  return new XMLSerializer().serializeToString(root);
}
export function cleanPayload(p) {
  const o = {};
  if (p?.svg) { const v = cleanSvgString(p.svg); if (v) o.svg = v; }
  if (p?.preview) { const v = safeImg(p.preview); if (v) o.preview = v; }
  if (p?.img) { const v = safeImg(p.img); if (v) o.img = v; }
  return o;
}

export const defaultMeta = () => ({ project: "", author: "", atelier: "", teachers: "", date: "", scale: "" });
export const defaultStyles = () => JSON.parse(JSON.stringify(DEFAULT_STYLES));
export const EXPORT_PRESETS = ["print", "web", "custom"];
export const emptyDoc = () => ({ version: DOC_VERSION, sections: [], comments: [], marks: [], arrows: [], stacks: {}, parents: makeParents(), swatches: DEFAULT_SWATCHES(), fstyles: defaultFstyles(), spreadView: false, export: { preset: "print" }, layers: defaultLayers(), guides: [], name: _t('board.doc.025'), seq: 1, meta: defaultMeta(), styles: defaultStyles(), frames: [], cards: [], assets: {}, site: null });

function cleanMeta(m) {
  const o = defaultMeta();
  if (m && typeof m === "object") {
    o.project = str(m.project, 120); o.author = str(m.author, 80); o.atelier = str(m.atelier, 80);
    o.teachers = str(m.teachers, 160); o.date = str(m.date, 24); o.scale = str(m.scale, 24);
  }
  return o;
}
function cleanStyles(s) {
  const o = defaultStyles();
  if (s && typeof s === "object") for (const r of ROLES) {
    const v = s[r];
    if (!v || typeof v !== "object") continue;
    o[r].size = num(v.size, o[r].size, 1, 200);
    o[r].weight = WEIGHTS.includes(Number(v.weight)) ? Number(v.weight) : o[r].weight;
    o[r].color = isColorRef(v.color) ? v.color : o[r].color;
    o[r].tracking = num(v.tracking, o[r].tracking || 0, -5, 20);
  }
  return o;
}
function cleanTemplate(t) {
  if (!t || typeof t !== "object") return null;
  const cols = Math.round(num(t.cols, 0, 0, 24)), rows = Math.round(num(t.rows, 0, 0, 24));
  if (cols < 1 || rows < 1) return null;
  return { margin: num(t.margin, 15, 0, 100), cols, rows, gutter: num(t.gutter, 5, 0, 50) };
}

const WEIGHTS_OK = w => WEIGHTS.includes(Number(w));
// style override / columns / inset of a text card (also used for parent items)
function cleanTextExtras(c) {
  const o = {}, so = c.style_override;
  if (so && typeof so === "object") {
    const v = {};
    if (so.size != null) v.size = num(so.size, 5, 1, 200);
    if (WEIGHTS_OK(so.weight)) v.weight = Number(so.weight);
    if (isColorRef(so.color)) v.color = so.color;
    if (so.tracking != null) v.tracking = num(so.tracking, 0, -5, 20);
    if (Object.keys(v).length) o.style_override = v;
  }
  const cols = Math.round(num(c.cols, 1, 1, 3));
  if (cols > 1) { o.cols = cols; o.gutter = num(c.gutter, 4, 0, 50); }
  if (c.inset != null && num(c.inset, 0, 0, 50) > 0) o.inset = num(c.inset, 0, 0, 50);
  return o;
}
const ITEM_KINDS = ["text", "stamp", "cartouche"];
function cleanParents(list) {
  const out = [], seen = new Set();
  for (const p of (Array.isArray(list) ? list : []).slice(0, 12)) {
    const id = safeId(p?.id, null);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const m = Array.isArray(p.margin) ? p.margin : [15, 15, 15, 15];
    const items = [], iid = new Set();
    for (const it of (Array.isArray(p.items) ? p.items : []).slice(0, 80)) {
      const k = safeId(it?.id, null);
      if (!k || iid.has(k) || !ITEM_KINDS.includes(it.kind)) continue;
      iid.add(k);
      const o = { id: k, kind: it.kind, x: num(it.x, 0, -2000, 2000), y: num(it.y, 0, -2000, 2000), w: num(it.w, 20, 1, 2000), h: num(it.h, 6, 1, 2000) };
      if (it.kind === "text") Object.assign(o, { role: ROLES.includes(it.role) ? it.role : "body", text: String(it.text ?? "").slice(0, 2000), align: ["left", "center", "right"].includes(it.align) ? it.align : "left" }, cleanTextExtras(it));
      if (it.kind === "stamp" && STAMPS.includes(it.stamp)) Object.assign(o, { stamp: it.stamp, den: Math.round(num(it.den, 100, 1, 1000000)), angle: num(it.angle, 0, -360, 360), len_m: num(it.len_m, 5, 0.001, 1e7), unit: it.unit === "km" ? "km" : "m", len_auto: it.len_auto !== false, angleAuto: false, link: null });
      else if (it.kind === "stamp") continue;
      items.push(o);
    }
    out.push({ id, name: str(p.name, 40, id), size: PAPER[p.size] ? p.size : "A3", orientation: p.orientation === "portrait" ? "portrait" : "landscape", margin: [0, 1, 2, 3].map(i => num(m[i], 15, 0, 100)), cols: Math.round(num(p.cols, 6, 1, 24)), gutter: num(p.gutter, 5, 0, 50), items });
  }
  return out;
}
function cleanSwatches(list) {
  const out = [], seen = new Set();
  for (const w of (Array.isArray(list) ? list : []).slice(0, MAX_SWATCHES)) {
    const id = safeId(w?.id, null);
    if (!id || seen.has(id) || !HEX_RE.test(String(w.hex))) continue;
    seen.add(id); out.push({ id, name: str(w.name, 40, id), hex: w.hex });
  }
  return out;
}
// Normalise a document read from outside (v1 or v2) into a v2 document.
export function sanitizeDoc(raw, info = {}) {
  const out = emptyDoc();
  info.from = Math.round(num(raw?.version, 1, 0, 1e6)); info.failed = 0; info.dropped = 0;
  const isBoolObj = v => v && typeof v === "object";
  if (Array.isArray(raw?.swatches)) out.swatches = cleanSwatches(raw.swatches);
  if (raw?.fstyles && typeof raw.fstyles === 'object') for (const k of ['thin', 'box']) { const v = raw.fstyles[k]; if (v && typeof v === 'object') out.fstyles[k] = { w: num(v.w, 0.25, 0, 5), color: isColorRef(v.color) ? v.color : '#1d1d1f' }; }
  out.spreadView = raw?.spreadView === true;
  if (raw?.export && EXPORT_PRESETS.includes(raw.export.preset)) out.export = { preset: raw.export.preset };
  if (isBoolObj(raw?.layers)) for (const k of LAYERS) { const v = raw.layers[k]; if (isBoolObj(v)) out.layers[k] = { hidden: v.hidden === true, locked: v.locked === true }; }
  out.name = String(raw?.name || _t('board.doc.025')).slice(0, 80);
  out.meta = cleanMeta(raw?.meta);
  out.styles = cleanStyles(raw?.styles);
  if (raw?.site && typeof raw.site === "object") out.site = { address: str(raw.site.address, 200), radius: str(raw.site.radius, 40) };
  for (const [k, a] of Object.entries(raw?.assets || {})) {
    const id = safeId(k, null);
    if (!id || !a || (a.kind !== "diagram" && a.kind !== "image")) continue;
    const m = a.meta && typeof a.meta === "object" ? { address: str(a.meta.address, 200), radius: str(a.meta.radius, 40), palette: str(a.meta.palette, 40) } : null;
    if (m && a.meta.mpm != null && Number(a.meta.mpm) > 0) m.mpm = num(a.meta.mpm, 1, 0.0001, 1000);
    if (m && a.meta.north_deg != null) m.north_deg = num(a.meta.north_deg, 0, -360, 360);
    out.assets[id] = { kind: a.kind, title: String(a.title || id).slice(0, 200), w: num(a.w, 100, 1, 5000), h: num(a.h, 70, 1, 5000), meta: m };
  }
  const fid = new Set(), frames = [];
  (raw?.board?.frames || raw?.frames || []).forEach((f, idx) => {
    const id = safeId(f?.id, null);
    if (!id || fid.has(id)) return;
    fid.add(id);
    frames.push({
      id, size: PAPER[f.size] ? f.size : "A3", orientation: f.orientation === "portrait" ? "portrait" : "landscape",
      grid_mm: num(f.grid_mm, GRID_DEFAULT, 0.5, 100), x: num(f.x, 0), y: num(f.y, 0),
      n: Math.round(num(f.n, frames.length + 1, 1, 9999)),
      page: Math.round(num(f.page, idx + 1, 1, 9999)),
      template: cleanTemplate(f.template), cartouche: f.cartouche === true, parent: f.parent ? safeId(f.parent, null) : null, overrides: {}, spread: f.spread === "L" || f.spread === "R" ? f.spread : null, _i: idx, _ov: f.overrides
    });
  });
  frames.sort((a, b) => a.page - b.page || a._i - b._i);
  frames.forEach((f, i) => { f.page = i + 1; delete f._i; });
  out.frames = frames;
  const cid = new Set(), failedIds = new Set();
  let z = 0;
  const rawCards = raw?.board?.cards || raw?.cards || [];
  for (const c of rawCards) {
    const id = safeId(c?.id, null);
    if (!id || cid.has(id) || !["diagram", "image", "text", "memo", "stamp", "link"].includes(c.kind)) { info.dropped++; continue; }
    if (![c?.x, c?.y, c?.w, c?.h].every(v => Number.isFinite(Number(v)) && v !== null && v !== "")) failedIds.add(id);   // kept on the pasteboard (moved clear of every page below)
    const rot = num(c.rot, 0, -360, 360);
    const card = { id, kind: c.kind, x: num(c.x, 0), y: num(c.y, 0), w: num(c.w, 50, 1, 5000), h: num(c.h, 20, 1, 5000), z: ++z, rot, crop: null, locked: c.locked === true, group: c.group ? safeId(c.group, null) : null, layer: LAYERS.includes(c.layer) ? c.layer : defaultLayer(c.kind), page: null };
    if (c.kind === "diagram" || c.kind === "image") {
      card.ref = safeId(c.ref, "");
      if (!out.assets[card.ref] || out.assets[card.ref].kind !== c.kind) { info.dropped++; continue; }
      if (c.scale && typeof c.scale === "object" && Number(c.scale.den) >= 1) card.scale = { den: Math.round(num(c.scale.den, 100, 1, 1000000)), locked: c.scale.locked === true };
      if (c.content && typeof c.content === "object") card.content = { dx: num(c.content.dx, 0, -5000, 5000), dy: num(c.content.dy, 0, -5000, 5000), s: num(c.content.s, 1, 0.05, 50) };
      if (["fill", "fit", "free"].includes(c.fit)) card.fit = c.fit;
    } else if (c.kind === "link") {
      const u = cleanUrl(c.url);
      if (!u) { info.dropped++; continue; }   // javascript:, data:, relative and overlong URLs never become cards
      card.url = u; card.title = str(c.title, 200, hostOf(u)); card.w = num(c.w, 70, 10, 600); card.h = num(c.h, 18, 6, 300);
    } else if (c.kind === "stamp") {
      if (!STAMPS.includes(c.stamp)) { info.dropped++; continue; }
      Object.assign(card, { stamp: c.stamp, den: Math.round(num(c.den, 100, 1, 1000000)), link: c.link ? safeId(c.link, null) : null, angle: num(c.angle, 0, -360, 360), len_m: num(c.len_m, 5, 0.001, 1e7), unit: c.unit === "km" ? "km" : "m", len_auto: c.len_auto !== false, angleAuto: c.angleAuto !== false });
      card.w = num(c.w, 20, 1, 500); card.h = num(c.h, 10, 1, 500); card.layer = LAYERS.includes(c.layer) ? c.layer : "text";
    } else {
      card.role = c.kind === "memo" ? "memo" : (ROLES.includes(c.role) ? c.role : "body");
      card.text = String(c.text ?? "").slice(0, 20000);
      if (c.size != null) card.size = num(c.size, DEFAULT_STYLES[card.role]?.size || 5, 1, 200);
      if (c.kind === "text") card.align = ["left", "center", "right"].includes(c.align) ? c.align : "left";
      if (c.kind === "memo") card.color = isColorRef(c.color) ? c.color : MEMO_COLORS[0];
      if (c.kind === "text") Object.assign(card, cleanTextExtras(c));
    }
    if (c.kind === "diagram" || c.kind === "image") { if (FSTYLES.includes(c.fstyle) && c.fstyle !== "none") card.fstyle = c.fstyle; }
    if (c.from_parent) card.from_parent = safeId(c.from_parent, null);
    card.stack = c.stack ? safeId(c.stack, null) : null;
    if (card.stack && c.sg && typeof c.sg === "object") card.sg = { w: num(c.sg.w, card.w, 1, 5000), h: num(c.sg.h, card.h, 1, 5000), rot: num(c.sg.rot, 0, -360, 360) };   // geometry before stacking, restored on 풀기
    card.created = isDate(c.created) ? c.created : todayStr();   // v1-v4 cards: migration day
    card.status = STATUSES.includes(c.status) ? c.status : "review";
    card.tags = cleanTags(c.tags);
    cid.add(id);
    out.cards.push(card);
  }
  // keep stacking order of the file
  const order = new Map(rawCards.map((c, i) => [c?.id, num(c?.z, i)]));
  out.cards.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).forEach((c, i) => { c.z = i + 1; });
  // a group needs two members
  const gc = new Map();
  for (const c of out.cards) if (c.group) gc.set(c.group, (gc.get(c.group) || 0) + 1);
  for (const c of out.cards) if (c.group && gc.get(c.group) < 2) c.group = null;
  // cards with unreadable geometry stay on the pasteboard: clear of every page, in a row to the right of all pages
  if (failedIds.size) {
    let right = 0, i = 0;
    for (const f of out.frames) right = Math.max(right, f.x + frameSize(f)[0]);
    for (const c of out.cards) {
      if (!failedIds.has(c.id)) continue;
      info.failed++;
      if (pageAt(out.frames, c.x + c.w / 2, c.y + c.h / 2)) {   // only when the repaired box would land inside a page
        c.x = right + 40 + i * 20; c.y = 0; i++; }
    }
  }
  // parents (v4); a v1-v3 document gets the default parents, and every page with a cartouche follows a parent that has one
  if (Array.isArray(raw?.parents)) out.parents = cleanParents(raw.parents);
  else {
    const [A, B] = out.parents; let extra = 0;
    for (const f of out.frames) if (f.cartouche) {
      let q = out.parents.find(z => z.size === f.size && z.orientation === f.orientation && z.items.some(i => i.kind === "cartouche"));
      if (!q) {
        if (B.size === f.size && B.orientation === f.orientation) { B.items.unshift({ id: "pB_cart", kind: "cartouche", x: 0, y: 0, w: 1, h: 1 }); q = B; }
        else { const id = "P" + (++extra); q = { ...JSON.parse(JSON.stringify(A)), id, name: _t('board.doc.026') + id, size: f.size, orientation: f.orientation }; q.items = [{ id: "p" + id + "_cart", kind: "cartouche", x: 0, y: 0, w: 1, h: 1 }]; out.parents.push(q); }
      }
      f.parent = q.id; f.cartouche = false;
    }
  }
  const pids = new Set(out.parents.map(q => q.id));
  for (const f of out.frames) { if (f.parent && !pids.has(f.parent)) f.parent = null; }
  assignPages(out);
  for (const f of out.frames) {   // overrides: itemId -> id of the page card that replaces it
    if (f._ov && typeof f._ov === "object") for (const [k, v] of Object.entries(f._ov)) { const cc = out.cards.find(z => z.id === v && z.from_parent === k); if (cc && f.parent) f.overrides[safeId(k, "x")] = cc.id; }
    delete f._ov;
  }
  out.sections = cleanSections(raw?.sections);
  const cardIds = new Set(out.cards.map(z => z.id));
  out.comments = cleanComments(raw?.comments, cardIds);
  out.marks = cleanMarks(raw?.marks, cardIds);
  out.arrows = cleanArrows(raw?.arrows, cardIds);
  out.stacks = cleanStacks(out.cards, raw?.stacks);
  const gid = new Set();
  const rawGuides = Array.isArray(raw?.guides) ? raw.guides : (Array.isArray(raw?.board?.guides) ? raw.board.guides : []);
  for (const g of rawGuides) {
    if (out.guides.length >= MAX_GUIDES) break;
    if (!g || (g.axis !== "x" && g.axis !== "y")) continue;
    let id = safeId(g.id, null);
    if (!id || gid.has(id)) id = "gd" + (out.guides.length + 1) + "_" + gid.size;
    const page = g.page == null ? null : (fid.has(safeId(g.page, "")) ? safeId(g.page, "") : undefined);
    if (page === undefined) continue;   // page guide of a page that is gone
    gid.add(id);
    out.guides.push({ id, page, axis: g.axis, mm: Math.round(num(g.mm, 0, -100000, 100000) * 10) / 10 });
  }
  out.seq = nextSeq(out, raw?.seq);
  return out;
}
function nextSeq(doc, hint) {
  let m = num(hint, 1, 1, 1e9);
  const scan = id => { const g = /(\d+)$/.exec(id); if (g) m = Math.max(m, Number(g[1]) + 1); };
  for (const f of doc.frames) scan(f.id);
  for (const c of doc.cards) { scan(c.id); if (c.group) scan(c.group); if (c.stack) scan(c.stack); }
  for (const id of Object.keys(doc.assets)) scan(id);
  for (const g of doc.guides) scan(g.id);
  for (const z of [...(doc.sections || []), ...(doc.comments || []), ...(doc.marks || []), ...(doc.arrows || [])]) scan(z.id);
  return m;
}
