// Board v2 document model: constants, geometry, sanitizing and v1 -> v2 migration.
// Pure (no DOM at import time) so it can be tested in node. Everything read from outside (opened .atelier files,
// IndexedDB records) goes through sanitizeDoc(): strings capped, numbers clamped, enums whitelisted.
export const DOC_VERSION = 2;
export const PAPER = { A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297] };   // portrait w x h (mm)
export const SIZES = Object.keys(PAPER);
export const ROLES = ["title", "subtitle", "body", "caption", "number"];
export const ROLE_LABEL = { title: "제목", subtitle: "부제", body: "본문", caption: "캡션", number: "번호" };
export const PALETTE = ["#1d1d1f", "#6e6e73", "#a1a1a6", "#2f6fed", "#c0392b"];
export const DEFAULT_STYLES = {
  title: { size: 9, weight: 700, color: "#1d1d1f" },
  subtitle: { size: 6, weight: 600, color: "#1d1d1f" },
  body: { size: 5, weight: 400, color: "#1d1d1f" },
  caption: { size: 4, weight: 400, color: "#6e6e73" },
  number: { size: 12, weight: 700, color: "#1d1d1f" }
};
export const ROLE_BOX = {   // default card size when a text card is created (mm)
  title: { w: 220, h: 14 }, subtitle: { w: 180, h: 10 }, body: { w: 140, h: 40 }, caption: { w: 160, h: 8 }, number: { w: 30, h: 16 }
};
export const MEMO_COLORS = ["#fff3a8", "#ffd6d6", "#d6ecff", "#dff5d8"];
export const WEIGHTS = [300, 400, 500, 600, 700];
export const GRID_DEFAULT = 5;
export const TEMPLATE_KEYS = ["none", "c3", "c4", "c6", "c12"];
export const TEMPLATE_LABEL = { none: "없음", c3: "3단", c4: "4단", c6: "6단", c12: "12단" };
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
export const orientLabel = f => (f.orientation === "portrait" ? "세로" : "가로");
export const pageLabel = f => `p.${f.page} · ${f.size} ${orientLabel(f)}`;
export const cartHeight = size => (size === "A0" || size === "A1") ? 24 : size === "A2" ? 18 : 12;
export const frameMargin = f => f.template ? f.template.margin : (bigPaper(f.size) ? 15 : 10);
// Column / row cells in frame-local mm, or null without a template. The cartouche strip is kept out of the grid.
export function gridCells(f) {
  const t = f.template;
  if (!t) return null;
  const [W, H] = frameSize(f);
  const x0 = t.margin, x1 = W - t.margin, y0 = t.margin, y1 = H - t.margin - (f.cartouche ? cartHeight(f.size) + t.gutter : 0);
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
export const emptyDoc = () => ({ name: "Atelier 보드", seq: 1, meta: defaultMeta(), styles: defaultStyles(), frames: [], cards: [], assets: {}, site: null });

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
    o[r].color = typeof v.color === "string" && COLOR_RE.test(v.color) ? v.color : o[r].color;
  }
  return o;
}
function cleanTemplate(t) {
  if (!t || typeof t !== "object") return null;
  const cols = Math.round(num(t.cols, 0, 0, 24)), rows = Math.round(num(t.rows, 0, 0, 24));
  if (cols < 1 || rows < 1) return null;
  return { margin: num(t.margin, 15, 0, 100), cols, rows, gutter: num(t.gutter, 5, 0, 50) };
}

// Normalise a document read from outside (v1 or v2) into a v2 document.
export function sanitizeDoc(raw) {
  const out = emptyDoc();
  out.name = String(raw?.name || "Atelier 보드").slice(0, 80);
  out.meta = cleanMeta(raw?.meta);
  out.styles = cleanStyles(raw?.styles);
  if (raw?.site && typeof raw.site === "object") out.site = { address: str(raw.site.address, 200), radius: str(raw.site.radius, 40) };
  for (const [k, a] of Object.entries(raw?.assets || {})) {
    const id = safeId(k, null);
    if (!id || !a || (a.kind !== "diagram" && a.kind !== "image")) continue;
    const m = a.meta && typeof a.meta === "object" ? { address: str(a.meta.address, 200), radius: str(a.meta.radius, 40), palette: str(a.meta.palette, 40) } : null;
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
      template: cleanTemplate(f.template), cartouche: f.cartouche === true, _i: idx
    });
  });
  frames.sort((a, b) => a.page - b.page || a._i - b._i);
  frames.forEach((f, i) => { f.page = i + 1; delete f._i; });
  out.frames = frames;
  const cid = new Set();
  let z = 0;
  const rawCards = raw?.board?.cards || raw?.cards || [];
  for (const c of rawCards) {
    const id = safeId(c?.id, null);
    if (!id || cid.has(id) || !["diagram", "image", "text", "memo"].includes(c.kind)) continue;
    const rot = num(c.rot, 0, -360, 360);
    const card = { id, kind: c.kind, x: num(c.x, 0), y: num(c.y, 0), w: num(c.w, 50, 1, 5000), h: num(c.h, 20, 1, 5000), z: ++z, rot, crop: null, locked: c.locked === true, group: c.group ? safeId(c.group, null) : null };
    if (c.kind === "diagram" || c.kind === "image") {
      card.ref = safeId(c.ref, "");
      if (!out.assets[card.ref] || out.assets[card.ref].kind !== c.kind) continue;
    } else {
      card.role = c.kind === "memo" ? "memo" : (ROLES.includes(c.role) ? c.role : "body");
      card.text = String(c.text ?? "").slice(0, 20000);
      if (c.size != null) card.size = num(c.size, DEFAULT_STYLES[card.role]?.size || 5, 1, 200);
      if (c.kind === "text") card.align = ["left", "center", "right"].includes(c.align) ? c.align : "left";
      if (c.kind === "memo") card.color = COLOR_RE.test(c.color) ? c.color : MEMO_COLORS[0];
    }
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
  out.seq = nextSeq(out, raw?.seq);
  return out;
}
function nextSeq(doc, hint) {
  let m = num(hint, 1, 1, 1e9);
  const scan = id => { const g = /(\d+)$/.exec(id); if (g) m = Math.max(m, Number(g[1]) + 1); };
  for (const f of doc.frames) scan(f.id);
  for (const c of doc.cards) { scan(c.id); if (c.group) scan(c.group); }
  for (const id of Object.keys(doc.assets)) scan(id);
  return m;
}
