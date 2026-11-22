import { t as _t, getLang as _lang } from "./i18n.js?v=20261122i";
// Build 4b: parent pages, spreads, style overrides, swatches, fields. Pure (no DOM, no imports) so node can test it.
const PAPER = { A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297] };
export const psize = (size, orient) => { const [a, b] = PAPER[size] || PAPER.A3; return orient === "portrait" ? [a, b] : [b, a]; };
const r2 = n => Math.round(n * 100) / 100;
const clone = o => JSON.parse(JSON.stringify(o));

// ---- swatches / colours -------------------------------------------------------------------------------------------
export const MAX_SWATCHES = 24;
export const SW_RE = /^sw:([A-Za-z0-9_-]{1,40})(?:@(\d{1,3}))?$/;
export const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
export const isColorRef = v => typeof v === "string" && (HEX_RE.test(v) || SW_RE.test(v));
export const DEFAULT_SWATCHES = () => [
  ["ink", _t('board.parent.001'), "#1d1d1f"], ["white", _t('board.parent.002'), "#ffffff"], ["muted", _t('board.parent.003'), "#6e6e73"], ["grey2", _t('board.parent.004'), "#a1a1a6"], ["accent", _t('board.parent.005'), "#e6b89c"],
  ["green", _t('board.parent.006'), "#7fa66a"], ["blue", _t('board.parent.007'), "#3b6ea5"], ["red", _t('board.parent.008'), "#c0392b"]
].map(([id, name, hex]) => ({ id, name, hex }));
export function tintHex(hex, pct) {   // pct % of the colour on white
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m || pct >= 100) return hex;
  const t = Math.max(0, pct) / 100, v = parseInt(m[1], 16), ch = [v >> 16 & 255, v >> 8 & 255, v & 255].map(c => Math.round(255 - (255 - c) * t));
  return "#" + ch.map(c => c.toString(16).padStart(2, "0")).join("");
}
// "#hex" | "sw:id" | "sw:id@60" -> "#rrggbb"; a deleted swatch falls back to ink
export function resolveColor(S, v, fb = "#1d1d1f") {
  if (typeof v !== "string") return fb;
  if (HEX_RE.test(v)) return v;
  const m = SW_RE.exec(v);
  if (!m) return fb;
  const sw = (S.swatches || []).find(s => s.id === m[1]);
  return sw ? tintHex(sw.hex, m[2] == null ? 100 : Number(m[2])) : fb;
}
export function addSwatch(S, name, hex, id) {
  if ((S.swatches || []).length >= MAX_SWATCHES || !HEX_RE.test(hex)) return null;
  const sw = { id, name: String(name || _t('board.parent.009')).slice(0, 40), hex };
  (S.swatches ||= []).push(sw);
  return sw;
}
// deleting a swatch: every use falls back to its resolved hex
export function deleteSwatch(S, id) {
  const sw = (S.swatches || []).find(s => s.id === id);
  if (!sw) return false;
  const fix = v => (typeof v === "string" && SW_RE.test(v) && SW_RE.exec(v)[1] === id) ? resolveColor(S, v) : v;
  for (const st of Object.values(S.styles || {})) if (st && typeof st === "object" && "color" in st) st.color = fix(st.color);
  for (const k of Object.values(S.fstyles || {})) if (k) k.color = fix(k.color);
  const cards = [...S.cards, ...(S.parents || []).flatMap(p => p.items), ...(S.stash?.cards || [])];
  for (const c of cards) { if (c.color) c.color = fix(c.color); if (c.style_override?.color) c.style_override.color = fix(c.style_override.color); }
  S.swatches = S.swatches.filter(s => s.id !== id);
  return true;
}

// ---- parents ----------------------------------------------------------------------------------------------------------
export function makeParents() {
  const A = { id: "A", name: _t('board.parent.010'), size: "A1", orientation: "portrait", margin: [15, 15, 15, 15], cols: 6, gutter: 5, items: [] };
  const B = { id: "B", name: _t('board.parent.011'), size: "A3", orientation: "landscape", margin: [10, 10, 10, 10], cols: 12, gutter: 4, items: [] };
  const [aw] = psize(A.size, A.orientation), [bw, bh] = psize(B.size, B.orientation);
  A.items = [{ id: "pA_cart", kind: "cartouche", x: 0, y: 0, w: 1, h: 1 }, { id: "pA_no", kind: "text", role: "caption", text: _t('board.parent.012'), align: "right", x: aw - 15 - 20, y: 6, w: 20, h: 6 }];
  B.items = [{ id: "pB_foot", kind: "text", role: "caption", text: _t('board.parent.013'), align: "left", x: 10, y: bh - 10 + 2, w: bw - 20, h: 6 }];
  return [A, B];
}
export const parentById = (S, id) => (S.parents || []).find(p => p.id === id) || null;
export const itemsFor = (S, f) => { const p = f.parent ? parentById(S, f.parent) : null; return p ? p.items.filter(it => !(f.overrides && f.overrides[it.id])) : []; };
const rowsFor = cols => (cols <= 3 ? 4 : cols === 4 ? 6 : cols === 12 || cols === 6 ? 8 : 6);
// make a page follow its parent: size / orientation (if geometry) + margin / columns / gutter
export function applyParent(S, f, pid, geometry = true) {
  const p = parentById(S, pid);
  if (!p) { f.parent = null; return f; }
  f.parent = pid;
  if (geometry) { f.size = p.size; f.orientation = p.orientation; }
  f.template = { margin: p.margin[0], cols: p.cols, rows: f.template?.rows || rowsFor(p.cols), gutter: p.gutter };
  f.cartouche = false;   // the cartouche is now a parent item
  return f;
}
export function clearOverrides(S, f) {   // only copies that still sit on this page and whose parent item exists are removed; others become ordinary cards
  const p = f.parent ? parentById(S, f.parent) : null;
  let n = 0;
  for (const [itemId, cid] of Object.entries(f.overrides || {})) {
    const c = S.cards.find(k => k.id === cid);
    if (!c) continue;
    if (c.page === f.id && p && p.items.some(i => i.id === itemId)) { S.cards = S.cards.filter(k => k !== c); n++; } else delete c.from_parent;
  }
  f.overrides = {};
  return n;
}
export function pruneOverrides(S) {   // an override whose card was deleted shows the parent item again
  for (const f of S.frames) for (const k of Object.keys(f.overrides || {})) if (!S.cards.some(c => c.id === f.overrides[k])) delete f.overrides[k];
}
// local copy of a parent item as a page card (text / stamp only); caller assigns id, z and pushes it
export function overrideCard(f, item) {
  if (!item || (item.kind !== "text" && item.kind !== "stamp")) return null;
  const c = clone(item);
  delete c.id;
  Object.assign(c, { x: r2(f.x + item.x), y: r2(f.y + item.y), page: f.id, layer: "text", locked: false, group: null, rot: 0, crop: null, from_parent: item.id });
  return c;
}
// ---- parent edit mode: the board is stashed inside S, the parent is shown as the only page ---------------------------------
export function enterParentEdit(S, pid) {
  const p = parentById(S, pid);
  if (!p || S.editParent) return S;
  const N = clone(S), pp = parentById(N, pid), cart = pp.items.some(i => i.kind === "cartouche");
  N.stash = { frames: N.frames, cards: N.cards, guides: N.guides };
  N.editParent = pid;
  N.frames = [{ id: "pe", size: pp.size, orientation: pp.orientation, grid_mm: 5, x: 0, y: 0, n: 1, page: 1, template: { margin: pp.margin[0], cols: pp.cols, rows: rowsFor(pp.cols), gutter: pp.gutter }, cartouche: cart, parent: null, overrides: {}, spread: null }];
  N.cards = pp.items.filter(i => i.kind !== "cartouche").map((i, k) => ({ crop: null, locked: false, group: null, rot: 0, layer: "text", ...clone(i), z: k + 1, page: "pe" }));
  N.guides = [];
  return N;
}
export function exitParentEdit(S) {
  if (!S.editParent) return S;
  const N = clone(S), pp = parentById(N, N.editParent), f = N.frames[0];
  pp.size = f.size; pp.orientation = f.orientation;
  if (f.template) { pp.margin = [f.template.margin, f.template.margin, f.template.margin, f.template.margin]; pp.cols = f.template.cols; pp.gutter = f.template.gutter; }
  const strip = ({ page, z, layer, locked, group, crop, rot, ...rest }) => ({ ...rest, x: r2(rest.x - f.x), y: r2(rest.y - f.y) });   // page-local, even if the edit page was dragged
  pp.items = [...(f.cartouche ? [{ id: "p" + pp.id + "_cart", kind: "cartouche", x: 0, y: 0, w: 1, h: 1 }] : []), ...N.cards.filter(c => c.kind === "text" || c.kind === "stamp").map(strip)];
  const keep = pp.id;
  N.frames = N.stash.frames; N.cards = N.stash.cards; N.guides = N.stash.guides;
  delete N.stash; delete N.editParent;
  for (const g of N.frames) if (g.parent === keep && f.template) g.template = { margin: f.template.margin, cols: f.template.cols, rows: g.template?.rows || f.template.rows, gutter: f.template.gutter };   // pages follow the parent's grid
  return N;
}
export const flattenEdit = S => (S.editParent ? exitParentEdit(S) : S);   // what gets saved / exported

// ---- spreads ------------------------------------------------------------------------------------------------------------
// page 1 (cover) alone, then consecutive pages of the same carnet size/orientation are paired L,R
export function pairSpreads(frames) {
  const out = new Map(frames.map(f => [f.id, null]));
  for (let i = 1; i + 1 < frames.length; ) {
    const a = frames[i], b = frames[i + 1];
    if (a.size === b.size && a.orientation === b.orientation && (a.size === "A3" || a.size === "A4")) { out.set(a.id, "L"); out.set(b.id, "R"); i += 2; } else i += 1;
  }
  return out;
}
// R page edge to edge with its L page; the R page's cards travel with it
export function layoutSpreads(S) {   // returns the ids of the cards it moved
  const moved = [], m = pairSpreads(S.frames);
  for (const f of S.frames) f.spread = m.get(f.id);
  for (let i = 0; i < S.frames.length; i++) {
    const R = S.frames[i];
    if (R.spread !== "R") continue;
    const L = S.frames[i - 1], [lw] = psize(L.size, L.orientation), nx = r2(L.x + lw), ny = L.y, dx = nx - R.x, dy = ny - R.y;
    if (!dx && !dy) continue;
    R.x = nx; R.y = ny;
    for (const c of S.cards) if (c.page === R.id) { c.x = r2(c.x + dx); c.y = r2(c.y + dy); moved.push(c.id); }
  }
  return moved;
}
export const partnerOf = (S, f) => { const i = S.frames.indexOf(f); return f.spread === "L" ? S.frames[i + 1] : f.spread === "R" ? S.frames[i - 1] : null; };

// ---- fields ---------------------------------------------------------------------------------------------------------------
// Field tokens are stored in the text of boards: the Korean tokens work forever; French aliases are accepted too.
export const FIELDS = ["쪽", "전체", "축척", "날짜", "프로젝트", "이름", "아틀리에", "교수"];
export const FIELD_ALIASES = { page: "쪽", total: "전체", echelle: "축척", date: "날짜", projet: "프로젝트", nom: "이름", atelier: "아틀리에", enseignants: "교수" };
const ALIAS_OF = Object.fromEntries(Object.entries(FIELD_ALIASES).map(([a, k]) => [k, a]));
export const fieldToken = (name, lang = _lang()) => `{${lang === "fr" ? ALIAS_OF[name] || name : name}}`;   // the token of the current language
// den: the page's scale denominator (caller computes it from the first scaled card) or null
export function expandFields(text, { S, pageNo, total, den }) {
  const meta = S.meta || {};
  const map = { 쪽: pageNo, 전체: total, 축척: den ? `1:${den}` : "", 날짜: meta.date || "", 프로젝트: meta.project || S.name || "", 이름: meta.author || "", 아틀리에: meta.atelier || "", 교수: meta.teachers || "" };
  return String(text ?? "").replace(/\{(쪽|전체|축척|날짜|프로젝트|이름|아틀리에|교수|page|total|echelle|date|projet|nom|atelier|enseignants)\}/g, (_, k) => String(map[FIELD_ALIASES[k] || k] ?? ""));
}
export function pageDen(S, f, denOf) {
  const cs = S.cards.filter(c => c.page === f.id && (c.kind === "diagram" || c.kind === "image")).sort((a, b) => a.z - b.z);
  for (const c of cs) { const d = denOf(c, S.assets[c.ref]); if (d) return d; }
  return null;
}

// ---- styles with override ---------------------------------------------------------------------------------------------
export const OVERRIDE_KEYS = ["size", "weight", "color", "tracking"];
export const overrideOf = c => { const o = { ...(c.style_override || {}) }; if (c.size != null && o.size == null) o.size = c.size; return o; };
export const hasOverride = c => Object.keys(overrideOf(c)).length > 0;
export function effectiveStyle(S, c, fb = "body") {
  const base = S.styles?.[c.role] || S.styles?.[fb] || { size: 5, weight: 400, color: "#1d1d1f" }, o = overrideOf(c);
  return { size: o.size ?? base.size, weight: o.weight ?? base.weight, color: resolveColor(S, o.color ?? base.color), tracking: o.tracking ?? base.tracking ?? 0 };
}
export function updateStyleFromCard(S, c) {
  const o = overrideOf(c), st = S.styles[c.role];
  if (!st || !Object.keys(o).length) return false;
  Object.assign(st, o);
  delete c.style_override; delete c.size;
  return true;
}
export const resetOverride = c => { delete c.style_override; delete c.size; };
// multi-column text: lines flow column by column (capacity = lines per column)
export function columnLayout(lines, cols, capacity) {
  const out = [];
  lines.forEach((ln, i) => { const col = Math.floor(i / Math.max(1, capacity)); out.push({ ln, col: Math.min(col, cols), row: i % Math.max(1, capacity), over: col >= cols }); });
  return out;
}
