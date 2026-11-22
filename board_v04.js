// Board mode of Atelier 4·2, v3 (InDesign-like layout): pin-up canvas + final panels (pages). Third mode of the site (body.dataset.mode = "board").
//   globalThis.atelierBoard = { add(item), open(), close(), count() }     event: atelierBoard:ready
// Screen = raster previews in an SVG world (mm units); export = vector SVG composed per page (board_v04_export.js).
// Document model, sanitizing and the v1 -> v2 migration (v1/v2 -> v3) live in board_v04_doc.js; dialogs in board_v04_chrome.js.
import { buildPdf } from "./dgpdf_v02.js?v=20261121a";
import { loadFontCss } from "./dgcore_v04.js?v=20261116p";
import {
  DOC_VERSION, PAPER, SIZES, ROLES, ROLE_LABEL, ROLE_BOX, MEMO_COLORS, GRID_DEFAULT, TEMPLATE_KEYS, TEMPLATE_LABEL, LAYERS, LAYER_LABEL, MAX_GUIDES,
  makeTemplate, templateKey, safeImg, num, r2, pad2, frameSize, orientLabel, pageLabel, pageTitle, gridCells, cartHeight, pageAt, assignPages, defaultLayer,
  cardDen, widthForDen, realWidthM, niceLen, ppiOf, ppiClass, contentRect, coverScale, stampBox, stampSvg, STAMPS, STAMP_LABEL, STD_DENS, isNorthStamp, isBarStamp,
  cleanSvgString, cleanPayload, sanitizeDoc, emptyDoc
} from "./board_v04_doc.js?v=20261122b";
import * as X from "./board_v04_export.js?v=20261122b";
import { icon } from "./board_v04_icons.js?v=20261122b";
import { preflight, summarize, groupByPage, cardTitle, PRESET_KEYS } from "./board_v04_preflight.js?v=20261122b";
import { createChrome } from "./board_v04_chrome.js?v=20261122b";

const FFLATE = "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";
const NS = "http://www.w3.org/2000/svg";
const MAX_HIST = 100;
const PX_PER_MM = 3.7795;   // 100 % = true size at 96 dpi
const LOD_Z = 0.25 * PX_PER_MM;
const RULER = 20;                 // ruler thickness (screen px)
const HINT_KEY = "atelier-board-print-hint";   // below 25 % zoom body/caption text is drawn as grey bars

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  parent?.append(e);
  return e;
};
const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- state -------------------------------------------------------------------------------------
// S is the document (snapshotted for undo). payloads hold the heavy strings, keyed by asset id. ui is not undoable.
let S = emptyDoc();
const payloads = new Map();       // assetId -> { svg?, preview?, img? }
let sel = new Set();              // selected card ids (UI only)
let selFrame = null;              // selected frame id (UI only)
let view = { x: 40, y: 40, z: 1 };
let hist = [], hi = -1;
let dirty = false, autosaveOK = true, saveTimer = 0, editingId = null, spaceDown = false;
let fitted = false, prevMode = null, isOpen = false, lastLod = false;
let savedAt = 0, saveState = "idle";
const ui = { tool: "v", panel: true, panelTab: "assets", filter: "all", q: "", minimap: false, stampPick: null, layout: "work", emptyDismissed: false, preview: false, guidesHidden: false, guidesLocked: false, ref: 0, hint: false };
let contentEdit = null;          // card id in content mode (double-click an image)
let selGuide = null;             // selected user guide id (UI only)
let chrome = null;

const frameLabel = f => pageLabel(f);
const cardById = id => S.cards.find(c => c.id === id);
const frameById = id => S.frames.find(f => f.id === id);
const center = c => [c.x + c.w / 2, c.y + c.h / 2];
const quarter = c => Math.abs(c.rot || 0) % 180 === 90;
const layerOf = c => (LAYERS.includes(c.layer) ? c.layer : defaultLayer(c.kind));
const layerIdx = c => LAYERS.indexOf(layerOf(c));
const layerLocked = c => !!S.layers?.[layerOf(c)]?.locked;
const isLocked = c => !!c.locked || layerLocked(c);
const layerHidden = c => !!S.layers?.[layerOf(c)]?.hidden;
const sortedCards = () => [...S.cards].sort((a, b) => layerIdx(a) - layerIdx(b) || a.z - b.z);   // bg < art < text, z inside a layer
const r1 = n => Math.round(n * 10) / 10;
// visual bounding box (rot 90 swaps the box around the centre)
const visBox = c => { const [cx, cy] = center(c), w = quarter(c) ? c.h : c.w, h = quarter(c) ? c.w : c.h; return { x: cx - w / 2, y: cy - h / 2, w, h }; };
const frameAt = (px, py) => pageAt(S.frames, px, py);
const frameOf = c => (c.page ? frameById(c.page) || null : null);   // membership = stored card.page (centre test happens at card drop/move/resize end)
const geomKey = c => `${c.x},${c.y},${c.w},${c.h},${c.rot || 0}`;
let lastGeom = new Map();
const syncGeom = () => { lastGeom = new Map(S.cards.map(c => [c.id, geomKey(c)])); };
function nearestFrame(px, py) {
  let best = null, bd = Infinity;
  for (const f of S.frames) {
    const [w, h] = frameSize(f);
    const d = Math.hypot(px - (f.x + w / 2), py - (f.y + h / 2));
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}
const normalizePages = () => S.frames.forEach((f, i) => { f.page = i + 1; });
const selectedFrame = () => (selFrame && frameById(selFrame)) || (sel.size ? frameOf(cardById([...sel][0]) || { x: 0, y: 0, w: 0, h: 0 }) : null);
const isLod = () => view.z < LOD_Z;

// ---- history -----------------------------------------------------------------------------------
const snap = () => JSON.stringify(S);
// Stamps follow the scale (and north) of the card they are linked to; bars re-pick a nice length and resize themselves.
function syncStamps() {
  for (const st of S.cards) {
    if (st.kind !== "stamp") continue;
    const L = st.link ? cardById(st.link) : null;
    if (L && (L.kind === "diagram" || L.kind === "image")) {
      const d = cardDen(L, S.assets[L.ref]);
      if (d) st.den = d;
      const na = S.assets[L.ref]?.meta?.north_deg;
      if (isNorthStamp(st.stamp) && st.angleAuto !== false && na != null) st.angle = na;
    }
    if (isBarStamp(st.stamp) && st.len_auto !== false) st.len_m = niceLen(st.den);
    let b = stampBox(st);
    const pf = st.page ? frameById(st.page) : null;
    if (b && isBarStamp(st.stamp) && pf) {   // a long length override cannot outgrow the page minus its margins
      const maxW = frameSize(pf)[0] - 2 * (pf.template ? pf.template.margin : (frameSize(pf)[0] >= 500 ? 15 : 10));
      if (b.w > maxW && maxW > 20) { st.len_m = Math.max(0.001, (maxW - 14) * st.den / 1000); b = stampBox(st); }
    }
    if (b) { st.w = b.w; st.h = b.h; }
  }
}
function commit() {
  if (contentEdit) { const cc = cardById(contentEdit); if (!cc || quarter(cc)) contentEdit = null; }
  syncStamps();
  for (const c of S.cards) {   // only cards whose own geometry changed are re-tested; moving/resizing/rotating a PAGE keeps its members
    const k = geomKey(c);
    if (lastGeom.get(c.id) !== k) { const f = pageAt(S.frames, c.x + c.w / 2, c.y + c.h / 2); c.page = f ? f.id : null; }
  }
  syncGeom();
  const s = snap();
  if (s === hist[hi]) { render(); return; }
  hist = hist.slice(0, hi + 1);
  hist.push(s);
  if (hist.length > MAX_HIST) hist.shift();
  hi = hist.length - 1;
  dirty = true;
  scheduleSave();
  render();
}
function restore(i) {
  hi = i;
  S = JSON.parse(hist[hi]);
  contentEdit = null;
  syncGeom();
  sel = new Set([...sel].filter(id => cardById(id)));
  if (selFrame && !frameById(selFrame)) selFrame = null;
  if (selGuide && !S.guides.some(g => g.id === selGuide)) selGuide = null;
  dirty = true;
  scheduleSave();
  render();
}
const undo = () => { finishEdit(); if (hi > 0) restore(hi - 1); };
const redo = () => { finishEdit(); if (hi < hist.length - 1) restore(hi + 1); };

// ---- persistence: IndexedDB autosave -------------------------------------------------------------
const idb = {
  open: () => new Promise((res, rej) => {
    if (typeof indexedDB === "undefined") return rej(new Error("IndexedDB 없음"));
    const r = indexedDB.open("atelier-board", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error("IndexedDB 열기 실패"));
    r.onblocked = () => rej(new Error("IndexedDB 차단됨"));
  }),
  async get(key) {
    const db = await this.open();
    try { return await new Promise((res, rej) => { const q = db.transaction("kv").objectStore("kv").get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
    finally { db.close(); }
  },
  async put(key, val) {
    const db = await this.open();
    try {
      await new Promise((res, rej) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(val, key);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error("저장 중단"));
      });
    } finally { db.close(); }
  }
};
function renderSaveState() {
  const t = $("#bd-save-state");
  if (!t) return;
  const hh = d => pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  const full = saveState === "saving" ? "저장 중…" : saveState === "error" ? "자동저장 안 됨" : saveState === "saved" ? `자동저장됨 ${hh(new Date(savedAt))}` : "";
  const short = saveState === "saving" ? "저장 중" : saveState === "error" ? "저장 안 됨" : saveState === "saved" ? "저장됨" : "";
  t.dataset.state = saveState;
  const compact = !wideMQ.matches;   // below 1280 px: dot + short text, full text in the tooltip
  t.replaceChildren();
  if (full) { const dot = document.createElement("i"); dot.className = "bd-dot"; const tx = document.createElement("span"); tx.className = "bd-savetx"; tx.textContent = compact ? short : full; t.append(dot, tx); t.dataset.tip = full; t.setAttribute("aria-label", full); }
  else { delete t.dataset.tip; t.removeAttribute("aria-label"); }
}
function setAutosave(ok) {
  autosaveOK = ok;
  const b = $("#bd-banner");
  if (b) b.hidden = ok;
  if (!ok) saveState = "error";
  renderSaveState();
}
let savePending = false;
// payloads of removed assets stay until no undo snapshot can bring the asset back
function gcPayloads() {
  const keep = new Set(Object.keys(S.assets));
  for (const h of hist) { try { for (const id of Object.keys(JSON.parse(h).assets || {})) keep.add(id); } catch { /* ignore */ } }
  for (const id of [...payloads.keys()]) if (!keep.has(id)) payloads.delete(id);
}
async function doSave() {
  savePending = false;
  saveState = "saving"; renderSaveState();
  try {
    gcPayloads();
    const pl = {};
    for (const id of Object.keys(S.assets)) if (payloads.has(id)) pl[id] = payloads.get(id);
    savedAt = Date.now();
    await idb.put("project", { S, payloads: pl, savedAt });
    saveState = "saved";
    setAutosave(true);
  } catch (e) { console.warn("autosave failed", e); setAutosave(false); }
}
function scheduleSave() { clearTimeout(saveTimer); savePending = true; saveTimer = setTimeout(doSave, 800); }
const syncEditText = () => {
  if (!editingId) return;
  const c = cardById(editingId), d = els.get(editingId)?.querySelector(".bd-text");
  if (c && d) { c.text = d.innerText.replace(/\n+$/, ""); savePending = true; }
};
const flushSave = () => { syncEditText(); if (savePending) { clearTimeout(saveTimer); doSave(); } };
addEventListener("pagehide", flushSave);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSave(); });
addEventListener("beforeunload", e => {
  flushSave();
  if (!autosaveOK && dirty && (S.cards.length || Object.keys(S.assets).length)) { e.preventDefault(); e.returnValue = ""; }
});

// ---- model operations -----------------------------------------------------------------------------
let frameDefaults = { size: "A3", orientation: "landscape" };
function addFrame(opts = {}) {
  const f = { id: "f" + S.seq++, size: opts.size || frameDefaults.size, orientation: opts.orientation || frameDefaults.orientation, grid_mm: GRID_DEFAULT, x: 0, y: 0, n: 0, page: 0, template: null, cartouche: false };
  f.n = S.frames.reduce((m, o) => Math.max(m, o.n), 0) + 1;
  if (opts.x != null) { f.x = r2(opts.x); f.y = r2(opts.y); }
  else {
    let right = null;
    for (const o of S.frames) { const [w] = frameSize(o); right = Math.max(right ?? -Infinity, o.x + w); }
    if (right !== null) { f.x = right + 40; f.y = S.frames[0].y; }
  }
  const at = opts.after ? S.frames.findIndex(o => o.id === opts.after) : -1;
  if (at >= 0) S.frames.splice(at + 1, 0, f); else S.frames.push(f);
  normalizePages();
  return f;
}
function addCard(c) {
  const z = S.cards.reduce((m, o) => Math.max(m, o.z), 0) + 1;
  const card = { kind: "text", x: 0, y: 0, w: 50, h: 20, rot: 0, crop: null, locked: false, group: null, page: null, ...c, id: "c" + S.seq++, z };
  if (!LAYERS.includes(card.layer)) card.layer = defaultLayer(card.kind);
  S.cards.push(card);
  return card;
}
function viewCentre() {
  const r = $("#bd-svg").getBoundingClientRect();
  return [(r.width / 2 - view.x) / view.z, (r.height / 2 - view.y) / view.z];
}
function spotFor(w, h, at) {
  const [vx, vy] = at || viewCentre();
  const f = frameAt(vx, vy) || nearestFrame(vx, vy);
  let cx = vx, cy = vy;
  if (f && !at && !frameAt(vx, vy)) { const [fw, fh] = frameSize(f); cx = f.x + fw / 2; cy = f.y + fh / 2; }
  return { x: r2(cx - w / 2), y: r2(cy - h / 2), frame: f };
}
// First free spot for a w x h card on page f: next empty template cell, else first free place inside the margins
// (row by row, left to right), else on the pasteboard right of the page.
function freeSpot(f, w, h) {
  const [fw, fh] = frameSize(f);
  const mine = S.cards.filter(c => c.kind !== "memo" && c.page === f.id).map(visBox);
  const hit = (x, y, ww, hh, list) => list.some(b => x < b.x + b.w - 0.5 && x + ww > b.x + 0.5 && y < b.y + b.h - 0.5 && y + hh > b.y + 0.5);
  const cells = gridCells(f);
  if (cells) {
    for (let j = 0; j < cells.ys.length; j++) for (let i = 0; i < cells.xs.length; i++) {
      const [x0, x1] = cells.xs[i], [y0, y1] = cells.ys[j], cw = x1 - x0, ch = y1 - y0;
      const used = mine.some(b => { const ox = Math.min(b.x + b.w, f.x + x1) - Math.max(b.x, f.x + x0), oy = Math.min(b.y + b.h, f.y + y1) - Math.max(b.y, f.y + y0); return ox > 0 && oy > 0 && ox * oy > 0.3 * cw * ch; });
      if (used) continue;
      const k = Math.min(cw / w, ch / h);   // contain, centred in the cell
      const nw = r2(w * k), nh = r2(h * k);
      return { x: r2(f.x + x0 + (cw - nw) / 2), y: r2(f.y + y0 + (ch - nh) / 2), w: nw, h: nh };
    }
  }
  const m = f.template ? f.template.margin : (fw >= 500 ? 15 : 10);
  for (let y = m; y + h <= fh - m + 0.01; y += 5) for (let x = m; x + w <= fw - m + 0.01; x += 5) if (!hit(f.x + x, f.y + y, w, h, mine)) return { x: r2(f.x + x), y: r2(f.y + y), w, h };
  const side = S.cards.filter(c => c.kind !== "memo" && !c.page).map(visBox), ox = f.x + fw + 40;
  for (let y = 0; y + h <= fh + 0.01; y += 5) for (let x = 0; x + w <= fw; x += 5) if (!hit(ox + x, f.y + y, w, h, side)) return { x: r2(ox + x), y: r2(f.y + y), w, h };
  return { x: r2(ox), y: r2(f.y + side.length * 10), w, h };
}
function placeAsset(id, at) {
  const a = S.assets[id];
  if (!a) return null;
  let w = a.w, h = a.h;
  const f0 = (at ? frameAt(...at) : null) || (at ? nearestFrame(...at) : null) || frameAt(...viewCentre()) || nearestFrame(...viewCentre());
  if (f0) {
    const [fw, fh] = frameSize(f0);
    // default size: about a quarter of the page, so 2 x 2 placements fit inside the margins
    const k = Math.min(fw * 0.44 / w, fh * 0.44 / h);
    w = r2(w * k); h = r2(h * k);
  }
  if (!at && f0) {
    const sp = freeSpot(f0, w, h); const c = addCard({ kind: a.kind, ref: id, x: sp.x, y: sp.y, w: sp.w, h: sp.h });
    const pf = pageAt(S.frames, c.x + c.w / 2, c.y + c.h / 2); c.page = pf ? pf.id : null;
    revealCard(c);
    return c;
  }
  const sp = spotFor(w, h, at);
  // dropped at a point: cascade so repeated drops at the same spot do not hide each other
  for (let i = 0; i < 20 && S.cards.some(o => Math.abs(o.x - sp.x) < 1 && Math.abs(o.y - sp.y) < 1); i++) { sp.x = r2(sp.x + 10); sp.y = r2(sp.y + 10); }
  return addCard({ kind: a.kind, ref: id, x: sp.x, y: sp.y, w, h });
}
function addText(role, at, text) {
  const B = ROLE_BOX[role] || ROLE_BOX.body;
  const sp = at ? { x: r2(at[0]), y: r2(at[1]) } : spotFor(B.w, B.h);
  const c = addCard({ kind: "text", role, text: text ?? ROLE_LABEL[role], align: "left", x: sp.x, y: sp.y, w: B.w, h: B.h });
  sel = new Set([c.id]); selFrame = null;
  commit();
  if (text == null) startEdit(c.id);
  return c;
}
function addMemo(at) {
  const sp = at ? { x: r2(at[0]), y: r2(at[1]) } : spotFor(60, 40);
  const c = addCard({ kind: "memo", role: "memo", text: "메모", color: MEMO_COLORS[S.cards.filter(k => k.kind === "memo").length % MEMO_COLORS.length], x: sp.x, y: sp.y, w: 60, h: 40 });
  sel = new Set([c.id]); selFrame = null;
  commit();
  startEdit(c.id);
}
function deleteSelection() {
  if (sel.size) {
    const del = new Set(selCards().filter(c => !isLocked(c)).map(c => c.id));
    if (!del.size) { status("잠긴 카드는 지울 수 없습니다. 잠금을 먼저 푸세요."); return; }
    if (contentEdit && del.has(contentEdit)) contentEdit = null;
    S.cards = S.cards.filter(c => !del.has(c.id)); sel = new Set([...sel].filter(id => !del.has(id))); commit(); return;
  }
  if (selFrame) deleteFrame(selFrame);
}
function deleteFrame(id) {
  const f = frameById(id);
  if (!f) return;
  if (S.frames.length < 2) { status("마지막 페이지는 지울 수 없습니다."); return; }
  const n = S.cards.filter(c => frameOf(c) === f).length;
  if (n && !confirm(`이 페이지를 지울까요? 안의 카드 ${n}장은 그대로 남습니다 (프레임 밖).`)) return;
  S.frames = S.frames.filter(o => o.id !== id); normalizePages();
  for (const c of S.cards) if (c.page === id) c.page = null;   // cards stay, on the pasteboard
  S.guides = S.guides.filter(g => g.page !== id);               // page guides go with their page
  if (selGuide && !S.guides.some(g => g.id === selGuide)) selGuide = null;
  selFrame = null; commit();
}
function duplicate() {
  if (selFrame && !sel.size) { duplicateFrame(selFrame); return; }
  if (!sel.size) return;
  const out = [], gmap = new Map(), cmap = new Map();
  for (const id of sel) {
    const c = cardById(id);
    if (!c) continue;
    const copy = addCard({ ...JSON.parse(JSON.stringify(c)), x: r2(c.x + 10), y: r2(c.y + 10), locked: false });
    cmap.set(c.id, copy.id);
    if (c.group) { if (!gmap.has(c.group)) gmap.set(c.group, "g" + S.seq++); copy.group = gmap.get(c.group); }
    out.push(copy);
  }
  for (const k of out) if (k.kind === "stamp" && cmap.has(k.link)) k.link = cmap.get(k.link);   // a duplicated stamp follows the duplicated drawing
  sel = new Set(out.map(c => c.id));
  commit();
}
// Frame duplicate = alternative layout: copy of the page and its cards, placed to the right, next page in order.
function duplicateFrame(id) {
  const f = frameById(id);
  if (!f) return;
  const own = S.cards.filter(c => frameOf(c) === f);
  const g = addFrame({ size: f.size, orientation: f.orientation, after: f.id });
  g.template = f.template ? { ...f.template } : null; g.cartouche = f.cartouche; g.grid_mm = f.grid_mm;
  const dx = g.x - f.x, dy = g.y - f.y, gmap = new Map(), cmap = new Map();
  for (const c of own) {
    const copy = addCard({ ...JSON.parse(JSON.stringify(c)), x: r2(c.x + dx), y: r2(c.y + dy), page: g.id });
    lastGeom.set(copy.id, geomKey(copy)); cmap.set(c.id, copy.id);
    if (c.group) { if (!gmap.has(c.group)) gmap.set(c.group, "g" + S.seq++); copy.group = gmap.get(c.group); }
  }
  for (const k of S.cards) if (k.kind === "stamp" && k.page === g.id && cmap.has(k.link)) k.link = cmap.get(k.link);
  selFrame = g.id; sel.clear();
  commit();
  zoomToFrame(g);
}
function reorder(dir, edge) {
  if (!sel.size) return;
  let arr = sortedCards();
  if (edge) {   // to front / back inside each layer
    const out = [];
    for (const L of LAYERS) {
      const items = arr.filter(c => layerOf(c) === L), a = items.filter(c => sel.has(c.id)), b = items.filter(c => !sel.has(c.id));
      out.push(...(dir > 0 ? [...b, ...a] : [...a, ...b]));
    }
    arr = out;
  } else if (dir > 0) { for (let i = arr.length - 2; i >= 0; i--) if (sel.has(arr[i].id) && !sel.has(arr[i + 1].id) && layerIdx(arr[i]) === layerIdx(arr[i + 1])) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]; }
  else { for (let i = 1; i < arr.length; i++) if (sel.has(arr[i].id) && !sel.has(arr[i - 1].id) && layerIdx(arr[i]) === layerIdx(arr[i - 1])) [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]]; }
  arr.forEach((c, i) => { c.z = i + 1; });
  commit();
}
function nudge(dx, dy) {
  if (contentEdit) { const c = cardById(contentEdit); if (c) { if (!c.content) c.content = { dx: 0, dy: 0, s: 1 }; c.content.dx = r2(c.content.dx + dx); c.content.dy = r2(c.content.dy + dy); commit(); } return; }   // content mode: arrows move the content
  if (!sel.size) return;
  for (const id of sel) { const c = cardById(id); if (c && !isLocked(c)) { c.x = r2(c.x + dx); c.y = r2(c.y + dy); } }
  commit();
}
const selCards = () => [...sel].map(cardById).filter(Boolean);
function toggleLock() {
  const cs = selCards();
  if (!cs.length) return;
  const to = !cs.every(c => c.locked);
  for (const c of cs) c.locked = to;
  commit();
}
function rotate90() {
  const cs = selCards().filter(c => (c.kind === "image" || c.kind === "diagram") && !isLocked(c));
  for (const c of cs) c.rot = quarter(c) ? 0 : 90;
  if (cs.length) commit();
}
function groupSel() {
  const cs = selCards();
  if (cs.length < 2) return;
  const gid = "g" + S.seq++;
  for (const c of cs) c.group = gid;
  commit();
}
function ungroupSel() {
  const gs = new Set(selCards().map(c => c.group).filter(Boolean));
  if (!gs.size) return;
  for (const c of S.cards) if (gs.has(c.group)) c.group = null;
  commit();
}
const expandGroups = ids => {
  const gs = new Set([...ids].map(i => cardById(i)?.group).filter(Boolean));
  if (gs.size) for (const c of S.cards) if (gs.has(c.group) && !layerHidden(c) && !layerLocked(c)) ids.add(c.id);
  return ids;
};
// align / distribute (visual boxes; locked cards stay)
function alignSel(how) {
  const cs = selCards();
  if (cs.length < 2) return;
  const bs = cs.map(c => ({ c, b: visBox(c) }));
  const x0 = Math.min(...bs.map(o => o.b.x)), x1 = Math.max(...bs.map(o => o.b.x + o.b.w)), y0 = Math.min(...bs.map(o => o.b.y)), y1 = Math.max(...bs.map(o => o.b.y + o.b.h));
  for (const { c, b } of bs) {
    if (isLocked(c)) continue;
    let dx = 0, dy = 0;
    if (how === "l") dx = x0 - b.x; else if (how === "c") dx = (x0 + x1) / 2 - (b.x + b.w / 2); else if (how === "r") dx = x1 - (b.x + b.w);
    else if (how === "t") dy = y0 - b.y; else if (how === "m") dy = (y0 + y1) / 2 - (b.y + b.h / 2); else if (how === "b") dy = y1 - (b.y + b.h);
    c.x = r2(c.x + dx); c.y = r2(c.y + dy);
  }
  commit();
}
function distribute(axis) {
  const bs = selCards().map(c => ({ c, b: visBox(c) }));
  if (bs.length < 3) { status("간격을 같게 하려면 3개 이상 고르세요."); return; }
  const k = axis === "h" ? "x" : "y", s = axis === "h" ? "w" : "h";
  bs.sort((a, b) => a.b[k] - b.b[k]);
  const first = bs[0].b[k], last = bs[bs.length - 1].b[k] + bs[bs.length - 1].b[s];
  const gap = (last - first - bs.reduce((t, o) => t + o.b[s], 0)) / (bs.length - 1);
  let pos = first;
  for (const { c, b } of bs) { const d = pos - b[k]; if (!isLocked(c)) c[k] = r2(c[k] + d); pos += b[s] + gap; }
  commit();
}
// fit an image / diagram into the template cells its box covers (contain, centred)
function fillCells(c) {
  const f = frameOf(c), cells = f && gridCells(f);
  if (!cells) { status("이 페이지에는 템플릿이 없습니다."); return; }
  if (isLocked(c)) { status("잠긴 카드입니다."); return; }
  if (c.scale?.locked) { status("축척이 고정된 카드는 칸에 맞춰 크기를 바꿀 수 없습니다."); return; }
  const b = visBox(c), lx0 = b.x - f.x, lx1 = lx0 + b.w, ly0 = b.y - f.y, ly1 = ly0 + b.h;
  const pick = (cellsArr, a0, a1) => {
    const hit = [];
    cellsArr.forEach(([c0, c1], i) => { if (Math.min(a1, c1) - Math.max(a0, c0) > 0.3 * (c1 - c0)) hit.push(i); });
    if (hit.length) return [hit[0], hit[hit.length - 1]];
    const mid = (a0 + a1) / 2;
    let best = 0, bd = Infinity;
    cellsArr.forEach(([c0, c1], i) => { const d = Math.abs((c0 + c1) / 2 - mid); if (d < bd) { bd = d; best = i; } });
    return [best, best];
  };
  const [ca, cb] = pick(cells.xs, lx0, lx1), [ra, rb] = pick(cells.ys, ly0, ly1);
  const R = { x: cells.xs[ca][0], y: cells.ys[ra][0], w: cells.xs[cb][1] - cells.xs[ca][0], h: cells.ys[rb][1] - cells.ys[ra][0] };
  const ar = quarter(c) ? c.h / c.w : c.w / c.h;   // visual aspect
  const vw = Math.min(R.w, R.h * ar), vh = vw / ar;
  const cx = f.x + R.x + R.w / 2, cy = f.y + R.y + R.h / 2;
  if (quarter(c)) { c.w = r2(vh); c.h = r2(vw); } else { c.w = r2(vw); c.h = r2(vh); }
  c.x = r2(cx - c.w / 2); c.y = r2(cy - c.h / 2);
  commit();
}
function setFrameSize(f, size) { f.size = size; }   // margin / columns / gutter set by the user are kept
function setTemplate(f, key) { f.template = makeTemplate(key, f.size); }
function movePage(id, to) {
  const i = S.frames.findIndex(f => f.id === id);
  if (i < 0) return;
  to = clamp(to, 0, S.frames.length - 1);
  if (to === i) return;
  const [f] = S.frames.splice(i, 1);
  S.frames.splice(to, 0, f);
  normalizePages();
  commit();
}

// ---- assets (panel) ---------------------------------------------------------------------------------
function registerAsset(kind, title, w, h, data, meta = null) {
  const id = "a" + S.seq++;
  S.assets[id] = { kind, title, w, h, meta };
  payloads.set(id, data);
  return id;
}
async function downscale(file) {
  let bmp = null, w, h, src;
  try { bmp = await createImageBitmap(file); w = bmp.width; h = bmp.height; src = bmp; }
  catch {
    const url = URL.createObjectURL(file);
    try { const im = new Image(); im.src = url; await im.decode(); w = im.naturalWidth; h = im.naturalHeight; src = im; }
    finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
  }
  const k = Math.min(1, 2500 / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
  const cv = document.createElement("canvas");
  cv.width = cw; cv.height = ch;
  const cx = cv.getContext("2d");
  cx.fillStyle = "#fff"; cx.fillRect(0, 0, cw, ch);
  cx.drawImage(src, 0, 0, cw, ch);
  bmp?.close?.();
  return { dataUrl: cv.toDataURL("image/jpeg", 0.88), w: cw, h: ch };
}
async function addImageFiles(files, at) {
  const list = [...files].filter(f => f.type.startsWith("image/"));
  if (!list.length) { status("이미지 파일이 아닙니다."); return; }
  let n = 0;
  for (const f of list) {
    try {
      const { dataUrl, w, h } = await downscale(f);
      const long = 120, mw = w >= h ? long : long * w / h, mh = w >= h ? long * h / w : long;
      const id = registerAsset("image", (f.name || "붙여넣은 이미지").replace(/\.[^.]+$/, ""), r2(mw), r2(mh), { img: dataUrl });
      const c = placeAsset(id, at ? [at[0] + n * 8, at[1] + n * 8] : null);
      if (c) { sel = new Set([c.id]); selFrame = null; }
      n++;
    } catch (e) { console.error(e); status(`이미지를 읽지 못했습니다: ${f.name}`); }
  }
  if (n) commit();
}

// ---- view ------------------------------------------------------------------------------------------
const labelSize = () => 11 / view.z;   // page label: constant 11 screen px
function applyView() {
  $("#bd-world").setAttribute("transform", `translate(${r2(view.x)} ${r2(view.y)}) scale(${view.z})`);
  $("#bd-world").style.setProperty("--inv", String(1 / view.z));
  $("#bd-zoom").textContent = Math.round(view.z / PX_PER_MM * 100) + "%";
  const sh = $("#bd-shadow-fx");   // paper shadow 0 1px 4px / 10 %: constant on screen, so scaled by the zoom
  if (sh) { sh.setAttribute("dy", String(1 / view.z)); sh.setAttribute("stdDeviation", String(3 / view.z)); }
  const fs = labelSize();
  for (const t of layerFrames.querySelectorAll("[data-frame-label]")) { const f = frameById(t.dataset.frameLabel); if (f) { t.setAttribute("font-size", fs); t.setAttribute("y", f.y - 6 / view.z); } }
  if (isLod() !== lastLod) { lastLod = isLod(); renderCards(); }
  renderSel(); placeCtx(); scheduleMini(); scheduleRulers(); renderOverset();
}
function zoomAt(factor, sx, sy) {
  const z = clamp(view.z * factor, 0.03, 20);
  const k = z / view.z;
  view.x = sx - (sx - view.x) * k; view.y = sy - (sy - view.y) * k; view.z = z;
  applyView();
}
function fitBox(x0, y0, x1, y1, pad = 40) {
  const r = $("#bd-svg").getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const z = clamp(Math.min((r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0)), 0.03, 20);
  view = { z, x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z };
  applyView();
  return true;
}
function fitAll() {
  const r = $("#bd-svg").getBoundingClientRect();
  if (!r.width || !r.height) return false;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of S.frames) { const [w, h] = frameSize(f); x0 = Math.min(x0, f.x); y0 = Math.min(y0, f.y - 12); x1 = Math.max(x1, f.x + w); y1 = Math.max(y1, f.y + h); }
  for (const c of S.cards) { const b = visBox(c); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  if (!isFinite(x0)) { view = { x: 40, y: 40, z: 1 }; applyView(); return true; }
  return fitBox(x0, y0, x1, y1);
}
// A placed card that lands outside the visible stage (page full -> pasteboard) would look lost: zoom out to show it.
function revealCard(c) {
  const r = $("#bd-svg").getBoundingClientRect();
  if (!r.width || !r.height) return;
  const b = visBox(c), sx0 = b.x * view.z + view.x, sy0 = b.y * view.z + view.y, sx1 = (b.x + b.w) * view.z + view.x, sy1 = (b.y + b.h) * view.z + view.y;
  if (sx0 >= 0 && sy0 >= 0 && sx1 <= r.width && sy1 <= r.height) return;
  fitAll();
}
function zoomToFrame(f) {
  const [w, h] = frameSize(f);
  selFrame = f.id; sel.clear();
  fitBox(f.x, f.y - 12, f.x + w, f.y + h, 60);
  render();
}
const toWorld = e => {
  const r = $("#bd-svg").getBoundingClientRect();
  return [(e.clientX - r.left - view.x) / view.z, (e.clientY - r.top - view.y) / view.z];
};

// ---- rendering: frames, cards, selection ----------------------------------------------------------------
const els = new Map();
let layerOver, layerFrames, layerCards, layerUG, layerGuides, layerSel;
const showTpl = () => ui.layout === "print" && !ui.preview;
const showUG = () => ui.layout === "print" && !ui.preview && !ui.guidesHidden;

function renderFrames() {
  layerFrames.replaceChildren();
  const fs = labelSize();
  for (const f of S.frames) {
    const [w, h] = frameSize(f);
    const g = el("g", { class: "bd-frame" + (f.id === selFrame ? " is-sel" : ""), "data-frame": f.id }, layerFrames);
    el("rect", { x: f.x, y: f.y, width: w, height: h, class: "bd-paper", filter: "url(#bd-shadow)" }, g);
    const cells = showTpl() ? gridCells(f) : null;
    if (cells && f.template) {   // margin rectangle + column / row boundaries as thin guide lines (no cell fills)
      const m = f.template.margin;
      let d = `M${m} ${m}H${w - m}V${h - m}H${m}Z`;
      for (const [a, b] of cells.xs) d += `M${r2(a)} ${r2(cells.y0)}V${r2(cells.y1)}M${r2(b)} ${r2(cells.y0)}V${r2(cells.y1)}`;
      for (const [a, b] of cells.ys) d += `M${r2(cells.x0)} ${r2(a)}H${r2(cells.x1)}M${r2(cells.x0)} ${r2(b)}H${r2(cells.x1)}`;
      el("path", { class: "bd-tpl", d, transform: `translate(${f.x} ${f.y})`, "vector-effect": "non-scaling-stroke" }, g);
    }
    if (f.cartouche) {
      const cg = el("g", { class: "bd-cart", transform: `translate(${f.x} ${f.y})`, "font-family": "Pretendard, Noto Sans KR, sans-serif" }, g);
      cg.innerHTML = X.cartoucheSvg(S, f, f.page, S.frames.length, false);
    }
    if (f.id === selFrame && !ui.preview) el("rect", { x: f.x, y: f.y, width: w, height: h, class: "bd-page-sel", "vector-effect": "non-scaling-stroke" }, g);
    const t = el("text", { x: f.x, y: f.y - 6 / view.z, "font-size": fs, class: "bd-frame-label", "data-frame-label": f.id }, g);
    t.textContent = pageTitle(f);
  }
  renderGuides();
}
const styleOf = c => X.styleOf(S, ROLES.includes(c.role) ? c.role : "body");
function makeCardEl(c) {
  const g = el("g", { class: "bd-card", "data-id": c.id });
  if (c.kind === "diagram" || c.kind === "image") {
    el("rect", { class: "bd-hit bd-paper-rect" }, g);
    const cs = el("svg", { class: "bd-clip", overflow: "hidden" }, g);   // frame = crop window for the content image
    const im = el("image", { preserveAspectRatio: "none", class: "bd-img" }, cs);
    const p = payloads.get(c.ref) || {};
    const href = c.kind === "diagram" ? p.preview : p.img;
    if (href) im.setAttribute("href", href);
  } else if (c.kind === "stamp") {
    el("rect", { class: "bd-hit" }, g);
    el("g", { class: "bd-stamp", "font-family": "Pretendard, Noto Sans KR, sans-serif" }, g);
  } else {
    el("rect", { class: "bd-hit" }, g);
    const fo = el("foreignObject", { class: "bd-fo" }, g);
    const d = document.createElement("div");
    d.className = "bd-text";
    fo.append(d);
    el("path", { class: "bd-lodbar" }, g);
  }
  const lk = el("g", { class: "bd-lockg" }, g);
  el("rect", { x: -12, y: 2, width: 10, height: 8, rx: 1.5 }, lk);
  el("path", { d: "M-10 2V.8a3 3 0 016 0V2", fill: "none" }, lk);
  return g;
}
function updateCardEl(g, c) {
  g.setAttribute("transform", `translate(${c.x} ${c.y})` + (c.rot ? ` rotate(${c.rot} ${c.w / 2} ${c.h / 2})` : ""));
  g.classList.toggle("is-memo", c.kind === "memo");
  g.classList.toggle("is-locked", !!c.locked);
  const off = !frameOf(c) || c.kind === "memo";   // pin-up material: outside any page, and memos
  g.style.opacity = ui.layout === "print" && off ? "0.4" : "";   // 조판: dimmed
  g.style.display = layerHidden(c) || (ui.preview && off) ? "none" : "";   // hidden layer / W preview
  g.classList.toggle("is-layerlocked", layerLocked(c));
  g.querySelector(".bd-lockg").style.transform = `translate(${c.w}px, 0px) scale(var(--inv, 1))`;
  const hit = g.querySelector(".bd-hit");
  hit.setAttribute("width", c.w); hit.setAttribute("height", c.h);
  if (c.kind === "diagram" || c.kind === "image") {
    const im = g.querySelector(".bd-img"), cs = g.querySelector(".bd-clip"), cr = contentRect(c, S.assets[c.ref]);
    cs.setAttribute("width", c.w); cs.setAttribute("height", c.h);
    im.setAttribute("x", r2(cr.x)); im.setAttribute("y", r2(cr.y)); im.setAttribute("width", r2(cr.w)); im.setAttribute("height", r2(cr.h));
    const p = payloads.get(c.ref) || {}, href = c.kind === "diagram" ? p.preview : p.img;   // also follows 내용 교체 and undo
    if (href && im.getAttribute("href") !== href) im.setAttribute("href", href);
  } else if (c.kind === "stamp") {
    const sg = g.querySelector(".bd-stamp"), key = `${c.stamp}|${c.den}|${c.len_m}|${c.angle}|${c.w}|${c.h}|${c.unit}`;
    if (sg.dataset.k !== key) { sg.dataset.k = key; sg.innerHTML = stampSvg(c, c.den); }   // vector, numbers only
  } else {
    const T = c.kind === "memo" ? { size: 5, weight: 400, color: "#1d1d1f" } : styleOf(c), fo = g.querySelector(".bd-fo"), d = g.querySelector(".bd-text");
    fo.setAttribute("width", c.w); fo.setAttribute("height", c.h);
    if (c.kind === "memo") hit.style.fill = c.color || MEMO_COLORS[0];
    const size = num(c.size, T.size, 1, 200);
    d.style.cssText = `width:${c.w}px;height:${c.h}px;font-size:${size}px;font-weight:${T.weight};color:${T.color};text-align:${c.align || "left"};padding:${c.kind === "memo" ? 2 : 0}px`;
    if (editingId !== c.id && d.textContent !== (c.text || "")) d.textContent = c.text || "";
    const lod = lastLod && (c.kind === "memo" || c.role === "body" || c.role === "caption") && editingId !== c.id;
    g.classList.toggle("is-lod", lod);
    if (lod) {   // semantic zoom: grey bars instead of live text
      const lh = size * 1.3, n = clamp(Math.floor(c.h / lh), 1, 8);
      let dpath = "";
      for (let i = 0; i < n; i++) dpath += `M0 ${r2(i * lh + size * 0.25)}h${r2(c.w * (i === n - 1 && n > 1 ? 0.6 : 0.95))}v${r2(size * 0.5)}h${-r2(c.w * (i === n - 1 && n > 1 ? 0.6 : 0.95))}z`;
      g.querySelector(".bd-lodbar").setAttribute("d", dpath);
    }
  }
}
function renderCards() {
  const ids = new Set(S.cards.map(c => c.id));
  for (const [id, g] of els) if (!ids.has(id)) { g.remove(); els.delete(id); }
  const sorted = sortedCards();
  sorted.forEach((c, i) => {
    let g = els.get(c.id);
    if (!g) { g = makeCardEl(c); els.set(c.id, g); }
    updateCardEl(g, c);
    if (layerCards.children[i] !== g) layerCards.insertBefore(g, layerCards.children[i] || null);
  });
}
function renderSel() {
  layerSel.replaceChildren();
  if (ui.preview) return;
  const hs = 6 / view.z;   // handles: 6 x 6 screen px
  for (const id of sel) {
    const c = cardById(id);
    if (!c || layerHidden(c)) continue;
    const g = el("g", { transform: `translate(${c.x} ${c.y})` + (c.rot ? ` rotate(${c.rot} ${c.w / 2} ${c.h / 2})` : "") }, layerSel);
    el("rect", { width: c.w, height: c.h, class: "bd-sel", "vector-effect": "non-scaling-stroke" }, g);
    const inContent = contentEdit === id;
    if (inContent) {   // content mode: orange box = the whole image, corner handles scale it
      const cr = contentRect(c, S.assets[c.ref]);
      el("rect", { x: cr.x, y: cr.y, width: cr.w, height: cr.h, class: "bd-cbox", "vector-effect": "non-scaling-stroke" }, g);
      if (!c.scale?.locked) for (const [n, hx, hy] of [["nw", cr.x, cr.y], ["ne", cr.x + cr.w, cr.y], ["sw", cr.x, cr.y + cr.h], ["se", cr.x + cr.w, cr.y + cr.h]]) el("rect", { x: hx - hs / 2, y: hy - hs / 2, width: hs, height: hs, class: "bd-chandle", "data-chandle": n, "vector-effect": "non-scaling-stroke" }, g);
      continue;
    }
    if (sel.size === 1 && editingId !== id && !isLocked(c) && !c.scale?.locked && !(c.kind === "stamp" && !isNorthStamp(c.stamp))) {
      const small = Math.min(c.w, c.h) * view.z < 24, media = c.kind === "image" || c.kind === "diagram" || c.kind === "stamp";
      const pts = [["nw", 0, 0], ["ne", c.w, 0], ["sw", 0, c.h], ["se", c.w, c.h]];
      if (!small && !media) pts.push(["n", c.w / 2, 0], ["s", c.w / 2, c.h], ["w", 0, c.h / 2], ["e", c.w, c.h / 2]);   // short side < 24 px: corners only
      for (const [n, hx, hy] of pts) el("rect", { x: hx - hs / 2, y: hy - hs / 2, width: hs, height: hs, class: "bd-handle", "data-handle": n, "vector-effect": "non-scaling-stroke" }, g);
    }
  }
}
// ---- preflight badge (조판) + overset marks ------------------------------------------------------------------------------------
let pfList = [], pfTimer = 0;
const pfEnv = () => ({
  imgPx: c => srcPx(c),
  overset: c => { const d = els.get(c.id)?.querySelector(".bd-text"); return !!d && d.clientHeight > 0 && d.scrollHeight > d.clientHeight + 1; }
});
function runPreflight() {
  pfList = isOpen ? preflight(S, pfEnv()) : [];
  const sm = summarize(pfList), b = $("#bd-pf");
  if (!b) return;
  b.dataset.state = sm.errors ? "error" : sm.total ? "warn" : "ok";
  $("#bd-pf-t").textContent = sm.total ? String(sm.total) : "점검 OK";
  b.setAttribute("aria-label", `출력 점검: ${sm.text}`); b.dataset.tip = sm.text;
  if (!$("#bd-pfpop").hidden) renderPfPop();
  renderOverset();
}
const schedulePreflight = () => { clearTimeout(pfTimer); pfTimer = setTimeout(runPreflight, 300); };
function renderPfPop() {
  const pop = $("#bd-pfpop");
  pop.replaceChildren();
  if (!pfList.length) { pop.append(mk("p", "bd-pf-ok", "점검할 문제가 없습니다.")); return; }
  for (const g of groupByPage(S, pfList)) {
    pop.append(mk("p", "bd-pf-h", g.title));
    for (const it of g.items) {
      const b = mk("button", "bd-pf-row"); b.type = "button"; b.dataset.pf = it.id; b.dataset.level = it.level;
      b.append(mk("span", "bd-pf-lv " + it.level), mk("span", "bd-pf-tx", it.text), mk("span", "bd-pf-ti", it.title || ""));
      pop.append(b);
    }
  }
}
function gotoPf(id) {
  const it = pfList.find(x => x.id === id);
  if (!it) return;
  $("#bd-pfpop").hidden = true; $("#bd-pf").setAttribute("aria-expanded", "false");
  const c = it.card ? cardById(it.card) : null;
  if (c) { sel = new Set([c.id]); selFrame = null; selGuide = null; const b = visBox(c); fitBox(b.x - 40, b.y - 40, b.x + b.w + 40, b.y + b.h + 40, 40); render(); }
  else { const f = frameById(it.page); if (f) zoomToFrame(f); }
}
// red "+" (10 screen px) at the bottom-right of a text box that overflows
function renderOverset() {
  if (!layerOver) return;
  layerOver.replaceChildren();
  if (ui.preview) return;
  const z = view.z, k = 10 / z;
  for (const c of S.cards) {
    if (c.kind !== "text") continue;
    if (layerHidden(c) || !pfEnv().overset(c)) continue;
    const g = el("g", { class: "bd-ovmark", transform: `translate(${c.x + c.w - k} ${c.y + c.h - k})` }, layerOver);
    el("rect", { width: k, height: k, fill: "#ff3b30" }, g);
    el("path", { d: `M${k * 0.5} ${k * 0.2}V${k * 0.8}M${k * 0.2} ${k * 0.5}H${k * 0.8}`, stroke: "#ffffff", "stroke-width": k * 0.14, fill: "none" }, g);
  }
}
function render() {
  schedulePreflight();
  renderFrames(); renderCards(); renderSel(); renderPanel(); renderProps(); renderCtx(); scheduleMini(); renderEmpty(); renderList(); renderChrome(); scheduleRulers();
}
const hasSelection = () => !!(sel.size || selFrame || selGuide);
function renderChrome() {
  const nm = $("#bd-name");
  if (nm && document.activeElement !== nm) nm.value = S.name;
  $("#bd-undo").disabled = hi <= 0; $("#bd-redo").disabled = hi >= hist.length - 1;
  const b = $("#board");
  b.classList.toggle("is-print", ui.layout === "print");
  b.classList.toggle("is-preview", ui.preview);
  for (const t of document.querySelectorAll("#board [data-layout]")) t.setAttribute("aria-pressed", String(t.dataset.layout === ui.layout));
  for (const t of document.querySelectorAll("#board [data-tool]")) t.setAttribute("aria-pressed", String(t.dataset.tool === ui.tool));
  $("#bd-svg").dataset.tool = ui.tool;
  $("#bd-panel").hidden = !ui.panel;
  $("#bd-panel-toggle").setAttribute("aria-pressed", String(ui.panel));
  $("#bd-props").hidden = mobileMQ.matches || !(dockMQ.matches || hasSelection());
  $("#bd-minimap").hidden = !ui.minimap;
  const mm = (k, t) => { const e = document.querySelector(`#bd-more-pop [data-m="${k}"]`); if (e) e.firstChild.textContent = t; };
  mm("minimap", ui.minimap ? "미니맵 숨기기" : "미니맵 보기");
  mm("gh", ui.guidesHidden ? "가이드 보기" : "가이드 숨기기");
  mm("gl", ui.guidesLocked ? "가이드 잠금 풀기" : "가이드 잠금");
  $("#bd-stage").classList.toggle("has-rulers", rulersOn());
  $("#bd-pfwrap").hidden = ui.layout !== "print" || mobileMQ.matches;
  renderSaveState();
}
function setTool(t) {
  ui.tool = t;
  for (const b of document.querySelectorAll("#board [data-tool]")) b.setAttribute("aria-pressed", String(b.dataset.tool === t));
  $("#bd-svg").dataset.tool = t;
}
function setLayout(m) {
  const was = ui.layout;
  ui.layout = m; ui.preview = false;
  if (m !== was) { ui.panelTab = m === "print" ? "pages" : "assets"; assetSig = ""; pageSig = ""; }   // spec 3.1: 조판 opens 페이지, 작업 opens 자료
  if (m !== "print") selGuide = null;
  render();
  requestAnimationFrame(() => applyView());
  if (m === "print") showHintOnce();
}
function togglePreview() { ui.preview = !ui.preview; if (ui.preview) { finishEdit(); } render(); requestAnimationFrame(() => applyView()); }
function showHintOnce() {
  let seen = ui.hint;
  try { if (!seen) seen = localStorage.getItem(HINT_KEY) === "1"; } catch { /* storage blocked: show once per session */ }
  if (seen) return;
  ui.hint = true;
  try { localStorage.setItem(HINT_KEY, "1"); } catch { /* ignore */ }
  const h = $("#bd-hint");
  if (h) h.hidden = false;
}

// ---- empty state ----------------------------------------------------------------------------------------
function renderEmpty() {
  const f = S.frames[0];
  const empty = S.frames.length === 1 && !S.cards.length && !Object.keys(S.assets).length && !f.template && !f.cartouche && !ui.emptyDismissed;
  $("#bd-empty").hidden = !empty || mobileMQ.matches;
}
function startFinalPanel() {
  ui.emptyDismissed = true;
  const f = S.frames[0] || addFrame();
  f.size = "A1"; f.orientation = "portrait"; f.template = makeTemplate("c6", "A1"); f.cartouche = true;
  selFrame = f.id; sel.clear();
  commit(); zoomToFrame(f);
}

// ---- left panel: 자료 / 페이지 ------------------------------------------------------------------------------
let assetSig = "", pageSig = "";
function renderPanel() {
  if (!ui.panel) return;
  for (const t of ["pages", "assets", "layers"]) {
    $("#bd-tab-" + t).setAttribute("aria-selected", String(ui.panelTab === t));
    $("#bd-pane-" + t).hidden = ui.panelTab !== t;
  }
  if (ui.panelTab === "assets") renderAssets(); else if (ui.panelTab === "pages") renderPages(); else renderLayers();
}
function renderLayers() {
  const box = $("#bd-layer-list");
  const n = Object.fromEntries(LAYERS.map(L => [L, S.cards.filter(c => layerOf(c) === L).length]));
  const sig = LAYERS.map(L => L + n[L] + S.layers[L].hidden + S.layers[L].locked).join("|");
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.replaceChildren();
  for (const L of [...LAYERS].reverse()) {   // top of the stack first
    const st = S.layers[L], row = mk("div", "bd-ly" + (st.hidden ? " is-off" : ""));
    const name = mk("span", "bd-ly-n", LAYER_LABEL[L]); name.append(mk("small", "", `카드 ${n[L]}`));
    const eye = mk("button", "bd-ib"); eye.type = "button"; eye.dataset.ly = L; eye.dataset.what = "hidden"; eye.innerHTML = icon(st.hidden ? "eyeoff" : "eye");
    eye.setAttribute("aria-label", `${LAYER_LABEL[L]} ${st.hidden ? "보이기" : "숨기기"}`); eye.setAttribute("aria-pressed", String(st.hidden)); eye.dataset.tip = st.hidden ? "보이기" : "숨기기";
    const lk = mk("button", "bd-ib"); lk.type = "button"; lk.dataset.ly = L; lk.dataset.what = "locked"; lk.innerHTML = icon(st.locked ? "lock" : "unlock");
    lk.setAttribute("aria-label", `${LAYER_LABEL[L]} ${st.locked ? "잠금 풀기" : "잠그기"}`); lk.setAttribute("aria-pressed", String(st.locked)); lk.dataset.tip = st.locked ? "잠금 풀기" : "잠그기";
    row.append(name, eye, lk);
    box.append(row);
  }
}
function toggleLayer(L, what) {
  if (!S.layers[L]) return;
  S.layers[L][what] = !S.layers[L][what];
  for (const id of [...sel]) { const c = cardById(id); if (c && layerOf(c) === L && (S.layers[L].hidden || S.layers[L].locked)) sel.delete(id); }   // hidden / locked layer cards cannot stay selected
  commit();
}
function renderAssets() {
  const used = new Map();
  for (const c of S.cards) if (c.ref) used.set(c.ref, (used.get(c.ref) || 0) + 1);
  const nAll = Object.keys(S.assets).length;
  $("#bd-asset-tools").hidden = !nAll;
  $("#bd-dropzone").hidden = !!nAll;
  const ids = Object.keys(S.assets).filter(id => (ui.filter === "all" || S.assets[id].kind === ui.filter) && (!ui.q || S.assets[id].title.toLowerCase().includes(ui.q.toLowerCase())));
  const sig = ids.map(i => i + ":" + (used.get(i) || 0) + (payloads.has(i) ? "p" : "")).join("|") + "#" + ui.q + ui.filter + Object.keys(S.assets).length;
  if (sig === assetSig) return;
  assetSig = sig;
  for (const ch of document.querySelectorAll("#board [data-filter]")) ch.setAttribute("aria-pressed", String(ch.dataset.filter === ui.filter));
  const box = $("#bd-asset-grid");
  box.replaceChildren();
  if (!ids.length) {
    if (nAll) box.append(mk("p", "bd-empty-note", "맞는 자료가 없습니다."));
    return;
  }
  const order = ids;   // stable (insertion) order: only the badge changes when a card is placed
  for (const id of order) {
    const a = S.assets[id], p = payloads.get(id) || {}, n = used.get(id) || 0;
    const card = mk("div", "bd-asset"); card.draggable = true; card.dataset.asset = id;
    const th = mk("div", "bd-thumb");
    const pb = mk("button", "bd-thumbbtn"); pb.type = "button"; pb.dataset.place = id; pb.setAttribute("aria-label", `${a.title} 배치`);
    const img = mk("img"); img.alt = ""; img.draggable = false; img.src = (a.kind === "diagram" ? p.preview : p.img) || "";
    pb.append(img); th.append(pb);
    if (n) th.append(mk("span", "bd-badge", `배치됨 ${n}`));
    const rm = mk("button", "bd-x"); rm.type = "button"; rm.dataset.removeAsset = id; rm.innerHTML = icon("close", 16);
    rm.setAttribute("aria-label", "자료 지우기");
    if (n) { rm.setAttribute("aria-disabled", "true"); rm.title = "보드에 배치된 카드가 있어 지울 수 없습니다. 카드를 먼저 지우세요."; } else rm.title = "자료에서 지우기";
    th.append(rm);
    card.append(th, mk("span", "bd-asset-t", a.title || id));
    box.append(card);
  }
}
function pageThumb(f) {
  const [W, H] = frameSize(f);
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", `0 0 ${W} ${H}`); s.setAttribute("class", "bd-pg-svg"); s.setAttribute("aria-hidden", "true");
  s.style.aspectRatio = `${W} / ${H}`;
  el("rect", { width: W, height: H, fill: "#fff", stroke: "#c7c7cc", "stroke-width": Math.max(W, H) / 200 }, s);
  const cells = gridCells(f);
  if (cells && ui.layout === "print") for (const [a, b] of cells.xs) el("rect", { x: a, y: cells.y0, width: b - a, height: cells.y1 - cells.y0, fill: "none", stroke: "#d63af9", "stroke-width": Math.max(W, H) / 700 }, s);
  for (const c of sortedCards().filter(k => frameOf(k) === f && k.kind !== "memo" && !layerHidden(k))) {
    const p = payloads.get(c.ref) || {}, href = c.kind === "diagram" ? p.preview : c.kind === "image" ? p.img : "";
    const b = visBox(c);
    if (href) { const im = el("image", { x: b.x - f.x, y: b.y - f.y, width: b.w, height: b.h, preserveAspectRatio: "none" }, s); im.setAttribute("href", href); }
    else el("rect", { x: c.x - f.x, y: c.y - f.y, width: c.w, height: Math.min(c.h, 6 + (c.size || 5)), fill: "#a1a1a6", opacity: ".7" }, s);
  }
  if (f.cartouche) { const m = f.template ? f.template.margin : 10, ch = cartHeight(f.size); el("rect", { x: m, y: H - m - ch, width: W - 2 * m, height: ch, fill: "none", stroke: "#1d1d1f", "stroke-width": Math.max(W, H) / 300 }, s); }
  return s;
}
function renderPages() {
  const sig = S.frames.map(f => [f.id, f.page, f.size, f.orientation, f.cartouche ? 1 : 0, f.template ? f.template.cols : 0, f.x, f.y, f.id === selFrame ? "s" : "",
    S.cards.filter(c => frameOf(c) === f).map(c => `${c.id},${c.x},${c.y},${c.w},${c.h},${c.rot},${layerOf(c)}`).join(";")].join(",")).join("|") + ui.layout + LAYERS.map(L => S.layers[L].hidden ? 1 : 0).join("");
  if (sig === pageSig) return;
  pageSig = sig;
  const box = $("#bd-page-list");
  box.replaceChildren();
  S.frames.forEach((f, i) => {
    const row = mk("div", "bd-pg" + (f.id === selFrame ? " is-sel" : "")); row.dataset.frame = f.id;
    const grip = mk("button", "bd-ib bd-grip"); grip.type = "button"; grip.innerHTML = icon("grip"); grip.setAttribute("aria-label", "끌어서 순서 바꾸기"); grip.title = "끌어서 순서 바꾸기";
    const main = mk("button", "bd-pg-main"); main.type = "button"; main.dataset.act = "pg-go";
    const th = mk("span", "bd-pg-thumb"); th.append(pageThumb(f));
    const t = mk("span", "bd-pg-t", `${pad2(f.page)} · ${f.size} ${orientLabel(f)}`);
    const n = S.cards.filter(c => frameOf(c) === f).length;
    t.append(mk("small", "", `카드 ${n}${f.template ? ` · ${f.template.cols}단` : ""}${f.cartouche ? " · 카르투슈" : ""}`));
    main.append(th, t);
    const ud = mk("span", "bd-pg-ud");
    const up = mk("button", "bd-ib"); up.type = "button"; up.innerHTML = icon("up", 16); up.dataset.act = "pg-up"; up.setAttribute("aria-label", "한 쪽 앞으로"); up.disabled = i === 0;
    const dn = mk("button", "bd-ib"); dn.type = "button"; dn.innerHTML = icon("down", 16); dn.dataset.act = "pg-down"; dn.setAttribute("aria-label", "한 쪽 뒤로"); dn.disabled = i === S.frames.length - 1;
    ud.append(up, dn);
    row.append(grip, main, ud);
    box.append(row);
  });
}

// ---- mobile list view ------------------------------------------------------------------------------------
const mobileMQ = matchMedia("(max-width: 767px)");
const wideMQ = matchMedia("(min-width: 1280px)");      // left panel docked
const dockMQ = matchMedia("(min-width: 1440px)");      // properties panel docked
const desktopMQ = matchMedia("(min-width: 1024px)");   // rulers
function renderList() {
  const box = $("#bd-list");
  if (!box || !mobileMQ.matches || !isOpen) return;
  if (box.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA") return;   // do not rebuild while typing
  box.replaceChildren();
  const groups = S.frames.map(f => ({ f, cards: [] }));
  const loose = [];
  for (const c of sortedCards()) {
    if (layerHidden(c)) continue;
    const f = frameOf(c), g = groups.find(x => x.f === f);
    (g ? g.cards : loose).push(c);
  }
  const GL = { "▲": "up", "▼": "down", "✕": "close" };
  const btn = (txt, act, id, label) => { const b = mk("button", "bd-mini"); if (GL[txt]) b.innerHTML = icon(GL[txt], 16); else b.textContent = txt; b.type = "button"; b.dataset.lact = act; b.dataset.lid = id; b.setAttribute("aria-label", label); return b; };
  groups.forEach(({ f, cards }) => {
    const sec = mk("section", "bd-lframe");
    const head = mk("div", "bd-lhead");
    head.append(mk("h3", "", frameLabel(f)));
    const acts = mk("div", "bd-lacts");
    acts.append(btn("▲", "frame-up", f.id, "페이지 앞으로"), btn("▼", "frame-down", f.id, "페이지 뒤로"), btn("PDF", "frame-pdf", f.id, "이 페이지 PDF"), btn("PNG", "frame-png", f.id, "이 페이지 PNG"));
    head.append(acts);
    sec.append(head);
    cards.forEach((c, ci) => sec.append(listRow(c, ci, cards.length, btn)));
    if (!cards.length) sec.append(mk("p", "bd-empty-note", "카드 없음"));
    box.append(sec);
  });
  if (loose.length) {
    const sec = mk("section", "bd-lframe");
    const h = mk("div", "bd-lhead"); h.append(mk("h3", "", "프레임 밖")); sec.append(h);
    loose.forEach((c, ci) => sec.append(listRow(c, ci, loose.length, btn)));
    box.append(sec);
  }
  const dr = mk("section", "bd-lframe");
  const dh = mk("div", "bd-lhead"); dh.append(mk("h3", "", "자료"));
  dr.append(dh);
  const ids = Object.keys(S.assets);
  if (!ids.length) dr.append(mk("p", "bd-empty-note", "자료가 비어 있습니다."));
  for (const id of ids) {
    const a = S.assets[id], p = payloads.get(id) || {};
    const row = mk("div", "bd-lrow");
    const im = mk("img"); im.alt = ""; im.src = (a.kind === "diagram" ? p.preview : p.img) || "";
    row.append(im, mk("span", "bd-lt", a.title || id), btn("넣기", "place", id, "프레임에 넣기"));
    dr.append(row);
  }
  box.append(dr);
}
function listRow(c, i, n, btn) {
  const row = mk("div", "bd-lrow");
  const label = c.kind === "memo" ? "메모" : ROLE_LABEL[c.role] || "텍스트";
  if (c.kind === "diagram" || c.kind === "image") {
    const p = payloads.get(c.ref) || {};
    const im = mk("img"); im.alt = ""; im.src = (c.kind === "diagram" ? p.preview : p.img) || "";
    row.append(im, mk("span", "bd-lt", S.assets[c.ref]?.title || c.kind));
  } else if (c.kind === "stamp") {
    row.append(mk("span", "bd-lk", "스탬프"), mk("span", "bd-lt", `${STAMP_LABEL[c.stamp] || c.stamp} · 1:${c.den}`));
  } else {
    const ta = mk("textarea", "bd-ltext");
    ta.value = c.text || ""; ta.dataset.lid = c.id; ta.rows = 2;
    ta.setAttribute("aria-label", label);
    if (c.locked || layerLocked(c)) { ta.readOnly = true; ta.title = "잠긴 카드"; }
    if (c.kind === "memo") ta.style.background = c.color || MEMO_COLORS[0];
    row.append(mk("span", "bd-lk", label), ta);
  }
  const b1 = btn("▲", "up", c.id, "앞뒤 순서 위로"), b2 = btn("▼", "down", c.id, "앞뒤 순서 아래로"), b3 = btn("✕", "del", c.id, "삭제");
  if (isLocked(c)) { b3.disabled = true; b3.title = "잠긴 카드"; }
  b1.disabled = i === 0; b2.disabled = i === n - 1;
  row.append(b1, b2, b3);
  return row;
}
function listAction(act, id) {
  if (act === "frame-up" || act === "frame-down") { const i = S.frames.findIndex(f => f.id === id); movePage(id, i + (act === "frame-up" ? -1 : 1)); return; }
  if (act === "frame-pdf") { const f = frameById(id); if (f) chrome.exportFrames([f], "pdf"); return; }
  if (act === "frame-png") { const f = frameById(id); if (f) chrome.exportFrames([f], "png"); return; }
  if (act === "place") { placeAsset(id); commit(); return; }
  const c = cardById(id);
  if (!c) return;
  if (act === "del") { if (isLocked(c)) return; S.cards = S.cards.filter(x => x.id !== id); sel.delete(id); commit(); return; }
  const f = frameOf(c);   // up / down: swap z with the neighbour inside the same frame and layer
  const sibs = S.cards.filter(x => frameOf(x) === f && layerOf(x) === layerOf(c)).sort((a, b) => a.z - b.z);
  const i = sibs.indexOf(c), j = i + (act === "up" ? -1 : 1);
  if (j < 0 || j >= sibs.length) return;
  [c.z, sibs[j].z] = [sibs[j].z, c.z];
  commit();
}

// ---- contextual toolbar (max 5 buttons, no numbers: those live in the properties panel) -----------------------------
let ctxSig = "";
const cb = (act, ic, label, on) => `<button type="button" class="bd-ib" data-act="${act}" data-tip="${label}" aria-label="${label}"${on == null ? "" : ` aria-pressed="${on}"`}>${icon(ic)}</button>`;
const cs = (sel_, label, opts, val) => `<select class="bd-sel-s" data-sel="${sel_}" aria-label="${label}">${opts.map(([v, t]) => `<option value="${v}"${String(v) === String(val) ? " selected" : ""}>${t}</option>`).join("")}</select>`;
function ctxHtml() {
  if (selFrame && !sel.size) return "";   // a page is edited in the properties panel
  const cards = selCards();
  if (!cards.length) return "";
  const allLocked = cards.every(c => c.locked);
  const lock = cb("lock", allLocked ? "lock" : "unlock", allLocked ? "잠금 풀기" : "잠금", allLocked);
  if (cards.length === 1) {
    const c = cards[0];
    if (c.kind === "text") {
      const al = c.align || "left";
      return cs("t-style", "글 스타일", ROLES.map(r => [r, ROLE_LABEL[r]]), c.role) + cb("t-cycle", al === "left" ? "alignL" : al === "center" ? "alignC" : "alignR", `정렬: ${al === "left" ? "왼쪽" : al === "center" ? "가운데" : "오른쪽"} (눌러서 바꾸기)`) + cb("del", "trash", "삭제");
    }
    const media = c.kind === "image" || c.kind === "diagram";
    if (media) {   // 채우기 · 맞추기 · (칸 채우기) · PPI badge · ⋯
      const pi = ppiInfo(c), badge = pi ? `<span class="bd-ppi is-${pi.cls}">${pi.text}</span>` : "";
      return cb("cover", "cover", "채우기 (틀을 덮음)") + cb("contain", "contain", "맞추기 (틀 안에 전체)") + (frameOf(c)?.template ? cb("fill", "fill", "칸 채우기") : "") + badge + cb("more", "more", "더보기");
    }
    return cb("more", "more", "앞뒤 순서") + cb("dup", "dup", "복제 (⌘D)") + lock + cb("del", "trash", "삭제");
  }
  return cb("dup", "dup", "복제 (⌘D)") + lock + cb("del", "trash", "삭제");
}
function ctxSignature() {
  if (editingId || ui.preview) return "";
  if (selFrame && !sel.size) return "";
  return "C" + selCards().map(c => `${c.id}${c.kind}${c.role || ""}${c.align || ""}${c.locked}${frameOf(c)?.template ? 1 : 0}${ppiInfo(c)?.text || ""}`).join(",");
}
function renderCtx() {
  const bar = $("#bd-ctx");
  const sg = ctxSignature();
  if (sg !== ctxSig) { ctxSig = sg; bar.innerHTML = sg ? ctxHtml() : ""; $("#bd-ctxmenu").hidden = true; }
  bar.hidden = !sg || !bar.innerHTML;
  if (bar.hidden) $("#bd-ctxmenu").hidden = true;
  placeCtx();
}
function selScreenBox() {
  let b = null;
  const f = selFrame && !sel.size ? frameById(selFrame) : null;
  if (f) { const [w, h] = frameSize(f); b = { x0: f.x, y0: f.y - 24 / view.z, x1: f.x + w, y1: f.y + h }; }
  else {
    const cs_ = selCards();
    if (!cs_.length) return null;
    const bs = cs_.map(visBox);
    b = { x0: Math.min(...bs.map(o => o.x)), y0: Math.min(...bs.map(o => o.y)), x1: Math.max(...bs.map(o => o.x + o.w)), y1: Math.max(...bs.map(o => o.y + o.h)) };
  }
  return { x0: b.x0 * view.z + view.x, y0: b.y0 * view.z + view.y, x1: b.x1 * view.z + view.x, y1: b.y1 * view.z + view.y };
}
function placeCtx() {
  const bar = $("#bd-ctx");
  if (!bar || bar.hidden) return;
  const box = selScreenBox();
  if (!box || (drag && (drag.type === "move" || drag.type === "resize" || drag.type === "frame" || drag.type === "marquee"))) { bar.style.visibility = "hidden"; $("#bd-ctxmenu").hidden = true; return; }
  const r = $("#bd-svg").getBoundingClientRect(), st = $("#bd-stage").getBoundingClientRect(), bw = bar.offsetWidth, bh = bar.offsetHeight;
  const ox = r.left - st.left, oy = r.top - st.top;
  let x = clamp((box.x0 + box.x1) / 2 - bw / 2, 8, Math.max(8, r.width - bw - 8));
  let y = box.y0 - bh - 10;
  if (y < 8) y = box.y1 + 10;
  if (y + bh > r.height - 8) y = clamp(box.y0 + 10, 8, Math.max(8, r.height - bh - 8));   // no room above or below: sit inside the selection
  bar.style.left = Math.round(x + ox) + "px"; bar.style.top = Math.round(y + oy) + "px"; bar.style.visibility = "visible";
  const m = $("#bd-ctxmenu");
  if (!m.hidden) { m.style.left = bar.style.left; m.style.top = Math.round(y + oy + bh + 4) + "px"; }
}
function ctxAction(act) {
  switch (act) {
    case "more": { const m = $("#bd-ctxmenu"); m.hidden = !m.hidden; placeCtx(); break; }
    case "front": $("#bd-ctxmenu").hidden = true; reorder(1); break;
    case "back": $("#bd-ctxmenu").hidden = true; reorder(-1); break;
    case "tofront": $("#bd-ctxmenu").hidden = true; reorder(1, true); break;
    case "toback": $("#bd-ctxmenu").hidden = true; reorder(-1, true); break;
    case "dup": duplicate(); break;
    case "lock": toggleLock(); break;
    case "del": deleteSelection(); break;
    case "cover": setContentMode("cover"); break;
    case "contain": setContentMode("contain"); break;
    case "fill": { const c = selCards()[0]; if (c) fillCells(c); break; }
    case "t-cycle": { const c = selCards()[0]; if (c) { c.align = c.align === "left" || !c.align ? "center" : c.align === "center" ? "right" : "left"; commit(); } break; }
  }
}
function ctxSelect(name, value) {
  if (name === "t-style" && ROLES.includes(value)) { const c = selCards()[0]; if (c?.kind === "text") { c.role = value; delete c.size; commit(); } }
}

// ---- minimap -----------------------------------------------------------------------------------------------------
let miniRaf = 0, miniMap = null;
function scheduleMini() { if (!miniRaf) miniRaf = requestAnimationFrame(() => { miniRaf = 0; renderMini(); }); }
function renderMini() {
  const box = $("#bd-minimap");
  if (!box || box.hidden || !isOpen) return;
  const svg = $("#bd-mini"), W = 176, H = 116;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of S.frames) { const [w, h] = frameSize(f); x0 = Math.min(x0, f.x); y0 = Math.min(y0, f.y); x1 = Math.max(x1, f.x + w); y1 = Math.max(y1, f.y + h); }
  for (const c of S.cards) { const b = visBox(c); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  const r = $("#bd-svg").getBoundingClientRect();
  const vx0 = -view.x / view.z, vy0 = -view.y / view.z, vx1 = (r.width - view.x) / view.z, vy1 = (r.height - view.y) / view.z;
  if (!isFinite(x0)) { x0 = vx0; y0 = vy0; x1 = vx1; y1 = vy1; }
  x0 = Math.min(x0, vx0); y0 = Math.min(y0, vy0); x1 = Math.max(x1, vx1); y1 = Math.max(y1, vy1);
  const k = Math.min((W - 8) / (x1 - x0), (H - 8) / (y1 - y0));
  const ox = (W - (x1 - x0) * k) / 2 - x0 * k, oy = (H - (y1 - y0) * k) / 2 - y0 * k;
  miniMap = { k, ox, oy };
  svg.replaceChildren();
  for (const f of S.frames) { const [w, h] = frameSize(f); el("rect", { x: f.x * k + ox, y: f.y * k + oy, width: w * k, height: h * k, class: "bd-m-frame" + (f.id === selFrame ? " is-sel" : "") }, svg); }
  for (const c of S.cards) { const b = visBox(c); el("rect", { x: b.x * k + ox, y: b.y * k + oy, width: Math.max(1, b.w * k), height: Math.max(1, b.h * k), class: "bd-m-card" + (sel.has(c.id) ? " is-sel" : "") }, svg); }
  el("rect", { x: vx0 * k + ox, y: vy0 * k + oy, width: (vx1 - vx0) * k, height: (vy1 - vy0) * k, class: "bd-m-view" }, svg);
}
function miniMove(e) {
  if (!miniMap) return;
  const r = $("#bd-mini").getBoundingClientRect();
  const wx = ((e.clientX - r.left) * (176 / r.width) - miniMap.ox) / miniMap.k, wy = ((e.clientY - r.top) * (116 / r.height) - miniMap.oy) / miniMap.k;
  const sr = $("#bd-svg").getBoundingClientRect();
  view.x = sr.width / 2 - wx * view.z; view.y = sr.height / 2 - wy * view.z;
  applyView();
}

// ---- interaction -----------------------------------------------------------------------------------------
let drag = null;
const pointers = new Map();   // active touch pointers (pinch)
let pinch = null;

// Snap a moving box to other cards, frames and the template cells of the frame it is over (columns / rows), else to the grid.
function snapMove(box, movingIds, tol, grid, gf, gl) {
  // priority: user guides (0) > template cells (1) > smart spacing / page centre (2) > other card and page edges (3); Alt disables all
  const others = [], cardsB = [];
  for (const c of S.cards) if (!movingIds.has(c.id) && !layerHidden(c)) { const b = visBox(c); others.push({ x: b.x, y: b.y, w: b.w, h: b.h, t: 3 }); if (c.page && c.page === gf?.id && c.kind !== "memo" && !layerHidden(c)) cardsB.push(b); }
  for (const f of S.frames) { const [w, h] = frameSize(f); others.push({ x: f.x, y: f.y, w, h, t: 3 }); }
  const cells = gf && gridCells(gf);
  if (cells) {   // cell snap: one pseudo box per column / row, so edges and centres are candidates
    for (const [a, b] of cells.xs) others.push({ x: gf.x + a, y: gf.y + cells.y0, w: b - a, h: cells.y1 - cells.y0, t: 1 });
    for (const [a, b] of cells.ys) others.push({ x: gf.x + cells.x0, y: gf.y + a, w: cells.x1 - cells.x0, h: b - a, t: 1 });
  }
  let bx = null, by = null;
  const xs = [box.x, box.x + box.w / 2, box.x + box.w], ys = [box.y, box.y + box.h / 2, box.y + box.h];
  const better = (cur, d, t) => !cur || t < cur.t || (t === cur.t && Math.abs(d) < Math.abs(cur.d));
  for (const o of others) {
    for (const ox of [o.x, o.x + o.w / 2, o.x + o.w]) for (const mx of xs) { const d = ox - mx; if (Math.abs(d) <= tol && better(bx, d, o.t)) bx = { d, at: ox, o, t: o.t }; }
    for (const oy of [o.y, o.y + o.h / 2, o.y + o.h]) for (const my of ys) { const d = oy - my; if (Math.abs(d) <= tol && better(by, d, o.t)) by = { d, at: oy, o, t: o.t }; }
  }
  if (gl) {   // user ruler guides: same threshold, one line each
    for (const gx of gl.xs) for (const mx of xs) { const d = gx - mx; if (Math.abs(d) <= tol && better(bx, d, 0)) bx = { d, at: gx, o: { x: gx, y: box.y - 8, w: 0, h: box.h + 16 }, t: 0 }; }
    for (const gy of gl.ys) for (const my of ys) { const d = gy - my; if (Math.abs(d) <= tol && better(by, d, 0)) by = { d, at: gy, o: { x: box.x - 8, y: gy, w: box.w + 16, h: 0 }, t: 0 }; }
  }
  const gaps = [];   // smart spacing: equal gaps and page centre lines (tier 2)
  if (gf) {
    const [fw, fh] = frameSize(gf), ccx = gf.x + fw / 2, ccy = gf.y + fh / 2;
    let d = ccx - (box.x + box.w / 2); if (Math.abs(d) <= tol && better(bx, d, 2)) bx = { d, at: ccx, o: { x: ccx, y: gf.y, w: 0, h: fh }, t: 2 };
    d = ccy - (box.y + box.h / 2); if (Math.abs(d) <= tol && better(by, d, 2)) by = { d, at: ccy, o: { x: gf.x, y: ccy, w: fw, h: 0 }, t: 2 };
    const ov = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > 0.5;
    const tolS = Math.max(0.5 * PX_PER_MM / view.z, 4 / view.z);   // 0.5 mm at 100 %, never under 4 screen px
    for (const axis of ["x", "y"]) {
      const P = axis === "x" ? "x" : "y", Q = axis === "x" ? "y" : "x", Sz = axis === "x" ? "w" : "h", Sq = axis === "x" ? "h" : "w";
      const blocked = (a, b) => cardsB.some(m => m !== a && m !== b && ov(m[Q], m[Q] + m[Sq], Math.max(a[Q], b[Q]), Math.min(a[Q] + a[Sq], b[Q] + b[Sq])) && m[P] < b[P] + 1e-6 && m[P] + m[Sz] > a[P] + a[Sz] - 1e-6);
      const refs = [];   // gaps between two ADJACENT cards sharing a row (x) / column (y)
      for (const a of cardsB) for (const b of cardsB) if (a !== b && a[P] + a[Sz] <= b[P] + 1e-6 && ov(a[Q], a[Q] + a[Sq], b[Q], b[Q] + b[Sq]) && !blocked(a, b)) { const g = b[P] - (a[P] + a[Sz]); if (g >= 0.5) refs.push({ g, a, b }); }
      const free = pos => !cardsB.some(m => ov(m[P], m[P] + m[Sz], pos, pos + box[Sz]) && ov(m[Q], m[Q] + m[Sq], box[Q], box[Q] + box[Sq]));   // the snapped box must not land on a card
      const put = (dd, want, smart) => { const cur = axis === "x" ? bx : by; if (Math.abs(dd) <= tolS && free(want) && better(cur, dd, 2)) { const c = { d: dd, at: want, o: null, t: 2, smart }; if (axis === "x") bx = c; else by = c; } };
      for (const n of cardsB) {
        if (!ov(n[Q], n[Q] + n[Sq], box[Q], box[Q] + box[Sq])) continue;
        for (const r of refs) {
          if (n !== r.a && n[P] + n[Sz] <= box[P] + tolS) { const want = n[P] + n[Sz] + r.g; put(want - box[P], want, { n, r, side: "after" }); }
          if (n !== r.b && n[P] >= box[P] + box[Sz] - tolS) { const want = n[P] - r.g - box[Sz]; put(want - box[P], want, { n, r, side: "before" }); }
        }
      }
      for (const a of cardsB) for (const b of cardsB) {   // centred between two cards: equal gaps on both sides
        if (a === b || a[P] + a[Sz] > b[P] + 1e-6 || !ov(a[Q], a[Q] + a[Sq], box[Q], box[Q] + box[Sq]) || !ov(b[Q], b[Q] + b[Sq], box[Q], box[Q] + box[Sq]) || blocked(a, b)) continue;
        const g = (b[P] - (a[P] + a[Sz]) - box[Sz]) / 2;
        if (g >= 0.5) { const want = a[P] + a[Sz] + g; put(want - box[P], want, { n: a, r: { a, b, g }, side: "between" }); }
      }
    }
  }
  let dx = bx ? bx.d : 0, dy = by ? by.d : 0;
  if (!bx && grid && gf && !cells) { dx = gf.x + Math.round((box.x - gf.x) / grid) * grid - box.x; }
  if (!by && grid && gf && !cells) { dy = gf.y + Math.round((box.y - gf.y) / grid) * grid - box.y; }
  const guides = [];
  const nb = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
  const gapMark = (axis, a0, a1, other0, other1, label) => { const mid = (Math.max(other0[0], other1[0]) + Math.min(other0[1], other1[1])) / 2; guides.push(axis === "x" ? { x1: a0, x2: a1, y1: mid, y2: mid, label, gap: true } : { y1: a0, y2: a1, x1: mid, x2: mid, label, gap: true }); };
  for (const [axis, h] of [["x", bx], ["y", by]]) {
    if (!h) continue;
    if (h.smart) {
      const { n, r, side } = h.smart, P = axis === "x" ? "x" : "y", Sz = axis === "x" ? "w" : "h", Q = axis === "x" ? "y" : "x", Sq = axis === "x" ? "h" : "w", lab = `${Math.round(r.g * 10) / 10}`;
      if (side === "between") {
        gapMark(axis, r.a[P] + r.a[Sz], r.a[P] + r.a[Sz] + r.g, [nb[Q], nb[Q] + nb[Sq]], [r.a[Q], r.a[Q] + r.a[Sq]], lab);
        gapMark(axis, r.b[P] - r.g, r.b[P], [nb[Q], nb[Q] + nb[Sq]], [r.b[Q], r.b[Q] + r.b[Sq]], lab);
      } else {
        const [m0, m1] = side === "after" ? [n[P] + n[Sz], n[P] + n[Sz] + r.g] : [n[P] - r.g, n[P]];
        gapMark(axis, m0, m1, [nb[Q], nb[Q] + nb[Sq]], [n[Q], n[Q] + n[Sq]], lab);
        gapMark(axis, r.a[P] + r.a[Sz], r.b[P], [r.a[Q], r.a[Q] + r.a[Sq]], [r.b[Q], r.b[Q] + r.b[Sq]], lab);
      }
    } else if (axis === "x") guides.push({ x1: h.at, x2: h.at, y1: Math.min(nb.y, h.o.y), y2: Math.max(nb.y + nb.h, h.o.y + h.o.h) });
    else guides.push({ y1: h.at, y2: h.at, x1: Math.min(nb.x, h.o.x), x2: Math.max(nb.x + nb.w, h.o.x + h.o.w) });
  }
  return { dx, dy, guides };
}
// resize: snap the dragged corner to column / row edges, else to the grid
// handles are drawn in the card's rotated frame: map a handle to the side of the VISUAL box it sits on (rot 90 = clockwise)
function visHandle(h, c) {
  if (!quarter(c)) return h;
  const cw = ((c.rot % 360) + 360) % 360 === 90;
  const m = cw ? { nw: "ne", ne: "se", se: "sw", sw: "nw", n: "e", e: "s", s: "w", w: "n" } : { nw: "sw", sw: "se", se: "ne", ne: "nw", n: "w", w: "s", s: "e", e: "n" };
  return m[h];
}
function snapPoint(px, py, gf, tol, grid, gl) {
  const [qx, qy] = gf ? snapCells(px, py, gf, tol, grid) : [px, py];
  let sx = qx, sy = qy;
  if (gl) {
    let bd = tol; for (const gx of gl.xs) if (Math.abs(gx - px) <= bd) { bd = Math.abs(gx - px); sx = gx; }
    bd = tol; for (const gy of gl.ys) if (Math.abs(gy - py) <= bd) { bd = Math.abs(gy - py); sy = gy; }
  }
  return [sx, sy];
}
function snapCells(px, py, gf, tol, grid) {
  const cells = gridCells(gf);
  if (!cells) return grid ? [gf.x + Math.round((px - gf.x) / grid) * grid, gf.y + Math.round((py - gf.y) / grid) * grid] : [px, py];
  const near = (v, list, off) => { let best = v, bd = tol; for (const [a, b] of list) for (const e of [a + off, b + off]) if (Math.abs(e - v) <= bd) { bd = Math.abs(e - v); best = e; } return best; };
  return [near(px, cells.xs, gf.x), near(py, cells.ys, gf.y)];
}
function drawGuides(gs) {
  layerGuides.replaceChildren();
  for (const g of gs || []) {
    el("line", { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, class: "bd-smart", "vector-effect": "non-scaling-stroke" }, layerGuides);
    if (g.label) { const t = el("text", { x: (g.x1 + g.x2) / 2 + (g.x1 === g.x2 ? 4 / view.z : 0), y: (g.y1 + g.y2) / 2 - (g.y1 === g.y2 ? 3 / view.z : 0), "font-size": 11 / view.z, class: "bd-gaplab", "text-anchor": g.x1 === g.x2 ? "start" : "middle" }, layerGuides); t.textContent = g.label + " mm"; }
  }
}

function placeByTool(at) {
  const t = ui.tool;
  setTool("v");
  if (t === "t") addText("body", at);
  else if (t === "n") addMemo(at);
  else if (t === "f") {
    const [w, h] = frameSize(frameDefaults.orientation === "portrait" ? { size: frameDefaults.size, orientation: "portrait" } : { size: frameDefaults.size, orientation: "landscape" });
    const f = addFrame({ x: at[0] - w / 2, y: at[1] - h / 2 });
    selFrame = f.id; sel.clear(); commit();
  }
}
function onPointerDown(e) {
  if (e.target.closest(".bd-text[contenteditable=true]")) return;
  finishEdit();
  const svg = $("#bd-svg");
  const cap = id => { try { svg.setPointerCapture(id); } catch { /* synthetic or lost pointer */ } };
  if (e.pointerType === "touch") {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { drag = null; startPinch(); cap(e.pointerId); return; }
  }
  if (e.button === 1 || (e.button === 0 && (spaceDown || ui.tool === "h" || ui.preview))) { startPan(e); return; }   // W preview: pan only
  if (e.button !== 0) return;
  const [wx, wy] = toWorld(e);
  if (ui.tool === "s") { e.preventDefault(); placeStamp([wx, wy]); return; }
  if (ui.tool === "t" || ui.tool === "n" || ui.tool === "f") { e.preventDefault(); placeByTool([wx, wy]); return; }
  if (contentEdit && contentPointerDown(e, wx, wy)) return;
  const handle = e.target.closest("[data-handle]");
  const cardEl = e.target.closest(".bd-card");
  const guideEl = showUG() && !ui.guidesLocked ? e.target.closest("[data-guide]") : null;
  const flabel = e.target.closest("[data-frame-label]");
  const paperEl = ui.layout === "print" && !e.shiftKey && !guideEl && e.target.classList?.contains("bd-paper") ? e.target.closest("[data-frame]") : null;   // 조판: the page itself can be dragged
    selGuide = null;
  cap(e.pointerId);
  if (guideEl) {
    const g = S.guides.find(x => x.id === guideEl.dataset.guide);
    if (g) {
      sel.clear(); selFrame = null; selGuide = g.id;
      drag = { type: "guide", g, axis: g.axis, o: { page: g.page, mm: g.mm }, moved: false, cancel: false, isNew: false };
      markGuideSel(); renderSel(); renderCtx(); renderProps(); renderChrome();
      for (const n of layerFrames.querySelectorAll(".bd-page-sel")) n.remove();
    }
  } else if (handle) {
    const c = cardById([...sel][0]);
    drag = { type: "resize", h: handle.dataset.handle, vh: visHandle(handle.dataset.handle, c), c, o: visBox(c), aspect: c.kind === "diagram" || c.kind === "image" || c.kind === "stamp" };
  } else if (cardEl) {
    const id = cardEl.dataset.id;
    const grp = expandGroups(new Set([id]));
    if (e.shiftKey) { if (sel.has(id)) for (const g of grp) sel.delete(g); else for (const g of grp) sel.add(g); }
    else if (!sel.has(id)) sel = grp;
    selFrame = null;
    const ids = new Set([...sel].filter(i => { const k = cardById(i); return k && !isLocked(k); }));   // locked cards stay put
    drag = { type: "move", start: [wx, wy], ids, orig: new Map([...ids].map(i => { const c = cardById(i); return [i, { x: c.x, y: c.y }]; })), moved: false };
    renderSel(); renderCtx(); renderPanel(); renderProps(); renderChrome(); renderGuides();
  } else if (flabel || paperEl) {
    const f = frameById(flabel ? flabel.dataset.frameLabel : paperEl.dataset.frame);
    selFrame = f.id; sel.clear();
    const inside = S.cards.filter(c => frameOf(c) === f);   // members (centre inside the page) travel with the page
    drag = { type: "frame", f, start: [wx, wy], o: { x: f.x, y: f.y }, cards: inside.map(c => ({ c, x: c.x, y: c.y })), moved: false };
    renderFrames(); renderSel(); renderCtx(); renderPanel(); renderProps(); renderChrome();
  } else if (e.shiftKey) {
    drag = { type: "marquee", start: [wx, wy], rect: el("rect", { class: "bd-marquee", "vector-effect": "non-scaling-stroke" }, layerGuides), base: new Set(sel) };
  } else {
    startPan(e, true);
  }
}
function startPan(e, clearOnClick) {
  try { $("#bd-svg").setPointerCapture(e.pointerId); } catch { /* ignore */ }
  drag = { type: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false, clear: !!clearOnClick };
  $("#bd-svg").classList.add("is-panning");
}
function startPinch() {
  const [a, b] = [...pointers.values()];
  pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
}
function onPointerMove(e) {
  if (pointers.has(e.pointerId)) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const r = $("#bd-svg").getBoundingClientRect();
      view.x += cx - pinch.cx; view.y += cy - pinch.cy;
      zoomAt(d / pinch.d, cx - r.left, cy - r.top);
      pinch = { d, cx, cy };
      return;
    }
  }
  if (!drag) return;
  if (drag.type === "pan") {
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    view.x = drag.vx + dx; view.y = drag.vy + dy; applyView();
    return;
  }
  if (drag.type === "guide") { guideFromPointer(e, drag); return; }
  if (drag.type === "cmove" || drag.type === "cscale") { contentDrag(e); return; }
  const [wx, wy] = toWorld(e);
  const noSnap = e.altKey;
  const tol = 6 / view.z;
  if (drag.type === "move") {
    if (!drag.ids.size) return;
    let dx = wx - drag.start[0], dy = wy - drag.start[1];
    if (!drag.moved && Math.hypot(dx, dy) * view.z < 3) return;
    drag.moved = true;
    const gb = (() => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const id of drag.ids) { const c = cardById(id), o = drag.orig.get(id), b = visBox({ x: o.x, y: o.y, w: c.w, h: c.h, rot: c.rot }); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); } return { x: x0 + dx, y: y0 + dy, w: x1 - x0, h: y1 - y0 }; })();
    let guides = [];
    if (!noSnap) {
      const gf = frameAt(gb.x + gb.w / 2, gb.y + gb.h / 2);
      const s = snapMove(gb, drag.ids, tol, gf?.grid_mm, gf, guideLines(gf));
      dx += s.dx; dy += s.dy; guides = s.guides;
    }
    for (const id of drag.ids) { const c = cardById(id), o = drag.orig.get(id); c.x = r2(o.x + dx); c.y = r2(o.y + dy); }
    drawGuides(guides);
    renderCards(); renderSel(); placeCtx(); scheduleMini(); scheduleProps();
  } else if (drag.type === "resize") {
    const { c, o } = drag, h = drag.vh;   // o and h are in the visual box (rotation aware)
    const gf = frameOf(c);
    let px = wx, py = wy, sx = wx, sy = wy;
    if (!noSnap) [sx, sy] = snapPoint(px, py, gf, tol, gf?.grid_mm, guideLines(gf));
    const west = h.includes("w"), north = h.includes("n"), hx = h.length === 2 || h === "e" || h === "w", hy = h.length === 2 || h === "n" || h === "s";
    const ax = west ? o.x + o.w : o.x, ay = north ? o.y + o.h : o.y;   // anchored opposite corner
    let nw, nh;
    if (drag.aspect) {   // snap on whichever axis is closer to a snap line, derive the other from the aspect
      const ar = o.w / o.h, dxs = sx !== px ? Math.abs(sx - px) : Infinity, dys = sy !== py ? Math.abs(sy - py) : Infinity, useX = dxs <= dys;   // compare only axes that really snapped
      if (useX) { nw = Math.max(5, west ? ax - sx : sx - ax); nh = nw / ar; } else { nh = Math.max(5, north ? ay - sy : sy - ay); nw = nh * ar; }
      if (nh < 5) { nh = 5; nw = nh * ar; } if (nw < 5) { nw = 5; nh = nw / ar; }
    } else { nw = hx ? Math.max(5, west ? ax - sx : sx - ax) : o.w; nh = hy ? Math.max(5, north ? ay - sy : sy - ay) : o.h; }
    const vx = west ? ax - nw : ax, vy = north ? ay - nh : ay;
    if (quarter(c)) { c.w = r2(nh); c.h = r2(nw); c.x = r2(vx + nw / 2 - c.w / 2); c.y = r2(vy + nh / 2 - c.h / 2); }
    else { c.w = r2(nw); c.h = r2(nh); c.x = r2(vx); c.y = r2(vy); }
    renderCards(); renderSel(); scheduleMini(); scheduleProps();
  } else if (drag.type === "frame") {
    const dx = wx - drag.start[0], dy = wy - drag.start[1];
    drag.moved = true;
    drag.f.x = r2(drag.o.x + dx); drag.f.y = r2(drag.o.y + dy);
    for (const k of drag.cards) { k.c.x = r2(k.x + dx); k.c.y = r2(k.y + dy); }
    renderFrames(); renderCards(); renderSel(); placeCtx(); scheduleMini(); scheduleProps(); scheduleRulers();
  } else if (drag.type === "marquee") {
    const x = Math.min(wx, drag.start[0]), y = Math.min(wy, drag.start[1]), w = Math.abs(wx - drag.start[0]), h = Math.abs(wy - drag.start[1]);
    drag.rect.setAttribute("x", x); drag.rect.setAttribute("y", y); drag.rect.setAttribute("width", w); drag.rect.setAttribute("height", h);
    sel = new Set(drag.base);
    for (const c of S.cards) { if (layerHidden(c) || layerLocked(c)) continue; const b = visBox(c); if (b.x < x + w && b.x + b.w > x && b.y < y + h && b.y + b.h > y) sel.add(c.id); }
    expandGroups(sel);
    renderSel(); renderCtx();
  }
}
function onPointerUp(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  const d = drag;
  if (!d) return;
  drag = null;
  $("#bd-svg").classList.remove("is-panning");
  layerGuides.replaceChildren();
  if (d.type === "guide") { finishGuideDrag(d); return; }
  if (d.type === "cmove" || d.type === "cscale") { commit(); return; }
  if (d.type === "pan") { if (!d.moved && d.clear) { sel.clear(); selFrame = null; selGuide = null; renderFrames(); renderSel(); renderCtx(); renderPanel(); renderProps(); renderChrome(); } else placeCtx(); return; }
  if (d.type === "marquee") { d.rect.remove(); placeCtx(); renderProps(); renderChrome(); return; }
  if (d.type === "move" && !d.moved) { render(); return; }   // plain click: selection only
  if (d.type === "frame") for (const k of d.cards) lastGeom.set(k.c.id, geomKey(k.c));   // members travelled with the page: no re-test
  commit();
}
function onWheel(e) {
  e.preventDefault();
  const r = $("#bd-svg").getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const notch = e.deltaMode === 1 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
  if ((e.ctrlKey || e.metaKey) && contentEdit) { contentWheel(e, Math.exp(-e.deltaY * 0.01)); return; }
  if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), sx, sy);
  else if (notch) zoomAt(Math.exp(-(e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY) * 0.0016), sx, sy);
  else { view.x -= e.deltaX; view.y -= e.deltaY; applyView(); }
}

// text editing
function startEdit(id) {
  const c = cardById(id), g = els.get(id);
  if (!c || !g || isLocked(c) || (c.kind !== "text" && c.kind !== "memo")) return;
  finishEdit();
  editingId = id;
  g.classList.remove("is-lod");
  const d = g.querySelector(".bd-text");
  d.contentEditable = "true";
  d.classList.add("is-editing");
  renderSel(); renderCtx();
  d.focus();
  const range = document.createRange(); range.selectNodeContents(d);
  const s = getSelection(); s.removeAllRanges(); s.addRange(range);
}
function finishEdit() {
  if (!editingId) return;
  const id = editingId; editingId = null;
  const c = cardById(id), g = els.get(id);
  const d = g?.querySelector(".bd-text");
  if (d) { d.contentEditable = "false"; d.classList.remove("is-editing"); if (c) c.text = d.innerText.replace(/\n+$/, ""); }
  commit();
}

// ---- keyboard / paste ---------------------------------------------------------------------------------------------
function commands() {
  const C = (label, run, hint, keys) => ({ label, run, hint, keys });
  const list = [
    C("프레임 추가 (페이지)", () => { const f = addFrame(); selFrame = f.id; sel.clear(); commit(); zoomToFrame(f); }, "F", "page frame 페이지"),
    C("텍스트 추가", () => addText("body"), "T", "text 글"),
    C("제목 추가", () => addText("title"), "", "title 제목"),
    C("메모 추가", () => addMemo(), "N", "memo note 메모"),
    C("이미지 추가", () => $("#bd-file-img").click(), "I", "image 이미지 사진"),
    C("출력…", () => chrome.openExport(), "", "export pdf png 출력 내보내기"),
    C("발표", () => present(), "P", "present slide 발표"),
    C("미리보기 켜기·끄기", togglePreview, "W", "preview 미리보기"),
    C("가이드 숨기기·보기", () => { ui.guidesHidden = !ui.guidesHidden; render(); applyView(); }, "", "guides hide show 가이드 숨기기 보기"),
    C("가이드 잠금·풀기", () => { ui.guidesLocked = !ui.guidesLocked; render(); }, "", "guides lock 가이드 잠금"),
    C("이 페이지 가이드 모두 지우기", clearPageGuides, "", "guides clear 가이드 지우기"),
    C("작업 ↔ 조판 전환", () => setLayout(ui.layout === "work" ? "print" : "work"), "⇧R", "layout 조판 작업"),
    C("보드 정보 · 카르투슈", () => chrome.openInfo(), "", "cartouche info meta 카르투슈 정보"),
    C("글 스타일", () => chrome.openStyles(), "", "styles text 글 스타일"),
    C("단축키 보기", () => chrome.openShortcuts(), "?", "shortcuts 단축키"),
    C("왼쪽 패널 접기·펼치기", () => { ui.panel = !ui.panel; render(); }, "", "panel 패널"),
    C("미니맵 켜기·끄기", () => { ui.minimap = !ui.minimap; render(); scheduleMini(); }, "", "minimap 미니맵"),
    C("전체 보기", fitAll, "⇧1", "fit zoom 전체"),
    C("앞으로 가져오기", () => reorder(1, true), "", "front 맨 앞"), C("맨 뒤로 보내기", () => reorder(-1, true), "", "back 맨 뒤"),
    C("실행 취소", undo, "⌘Z", "undo"), C("다시 실행", redo, "⌘⇧Z", "redo"),
    C("선택 복제", duplicate, "⌘D", "duplicate 복제"), C("선택 삭제", deleteSelection, "Del", "delete 삭제"),
    C("묶기", groupSel, "⌘G", "group 묶기"), C("묶음 풀기", ungroupSel, "⌘⇧G", "ungroup 풀기"), C("잠금·풀기", toggleLock, "", "lock 잠금"),
    C("90° 회전", rotate90, "", "rotate 회전"), C("칸 채우기", () => { const c = selCards()[0]; if (c) fillCells(c); }, "", "fill cell 칸 채우기"),
    C("새 보드", newBoard, "", "new 새 보드"), C("파일로 저장 (.atelier)", saveFile, "", "save 저장"), C("파일 열기", () => $("#bd-file-proj").click(), "", "open 열기")
  ];
  for (const [k, l] of [["l", "왼쪽"], ["c", "가운데"], ["r", "오른쪽"], ["t", "위"], ["m", "중간"], ["b", "아래"]]) list.push(C(`정렬 · ${l}`, () => alignSel(k), "", "align 정렬"));
  list.push(C("간격 같게 · 가로", () => distribute("h"), "", "distribute 간격"), C("간격 같게 · 세로", () => distribute("v"), "", "distribute 간격"));
  S.frames.forEach(f => list.push(C(`페이지 ${f.page}로 이동 · ${f.size} ${orientLabel(f)}`, () => zoomToFrame(f), "", "page go zoom 페이지 이동")));
  return list;
}
function present() {
  const f = selectedFrame();
  chrome.present(f ? Math.max(0, S.frames.indexOf(f)) : 0);
}
function onKey(e) {
  if (!isOpen || chrome?.isBlocking()) return;
  const t = e.target;
  const typing = t.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(t.tagName) && !/^(checkbox|radio|file|button)$/.test(t.type || ""));
  const onSelect = t.tagName === "SELECT", onButton = !!t.closest?.("button");
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (mod && k === "k") { e.preventDefault(); finishEdit(); chrome.openPalette(commands()); return; }
  if (e.key === " " && !typing && !onSelect && !onButton) { spaceDown = true; e.preventDefault(); return; }
  if (e.key === "Escape") {
    if (contentEdit && !typing) exitContent();
    else if (editingId) finishEdit();
    else if (typing) t.blur();
    else if (!$("#bd-gpop").hidden) closeGuidePop();
    else if (closeMenus()) { /* closed a menu */ }
    else if (ui.preview) togglePreview();
    else if (ui.tool !== "v") setTool("v");
    else { sel.clear(); selFrame = null; selGuide = null; renderSel(); renderFrames(); renderCtx(); renderPanel(); renderProps(); renderChrome(); }
    return;
  }
  if (typing) return;
  if (onSelect && !mod) return;
  if (ui.preview && !(k === "w" || k === "p" || e.key === "?" || (mod && k === "k"))) return;   // W preview: no editing shortcuts
  if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === "y") { e.preventDefault(); redo(); return; }
  if (mod && k === "d") { e.preventDefault(); duplicate(); return; }
  if (mod && k === "g") { e.preventDefault(); e.shiftKey ? ungroupSel() : groupSel(); return; }
  if (mod && k === "a") { e.preventDefault(); sel = new Set(S.cards.filter(c => !layerHidden(c) && !layerLocked(c)).map(c => c.id)); selFrame = null; selGuide = null; renderSel(); renderCtx(); renderProps(); renderChrome(); return; }
  if (mod) return;
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); if (selGuide) deleteGuide(selGuide); else deleteSelection(); return; }
  if (e.key === "Enter" && sel.size === 1 && !contentEdit) { const c = selCards()[0]; if (c && (c.kind === "image" || c.kind === "diagram")) { e.preventDefault(); enterContent(c.id); return; } }
  if (e.key === "]") { reorder(1); return; }
  if (e.key === "[") { reorder(-1); return; }
  if (e.key === "?") { chrome.openShortcuts(); return; }
  if (e.shiftKey && e.key === "R") { e.preventDefault(); setLayout(ui.layout === "work" ? "print" : "work"); return; }
  if (e.shiftKey && e.code === "Digit1") { e.preventDefault(); fitAll(); return; }
  if (!e.shiftKey && !e.altKey && !onButton || (onButton && /^[vhtfnipsw]$/.test(k))) {
    if (k === "v") { setTool("v"); return; }
    if (k === "h") { setTool("h"); return; }
    if (k === "t") { setTool("t"); return; }
    if (k === "f") { setTool("f"); return; }
    if (k === "n") { setTool("n"); return; }
    if (k === "i") { $("#bd-file-img").click(); return; }
    if (k === "s") { toggleStamps(); return; }
    if (k === "p") { present(); return; }
    if (k === "w") { togglePreview(); return; }
  }
  const step = e.shiftKey ? 10 : 1;
  if (e.key === "ArrowLeft") { e.preventDefault(); nudge(-step, 0); }
  else if (e.key === "ArrowRight") { e.preventDefault(); nudge(step, 0); }
  else if (e.key === "ArrowUp") { e.preventDefault(); nudge(0, -step); }
  else if (e.key === "ArrowDown") { e.preventDefault(); nudge(0, step); }
}
addEventListener("keydown", onKey);
addEventListener("keyup", e => { if (e.key === " ") spaceDown = false; });
addEventListener("blur", () => { spaceDown = false; });
document.addEventListener("paste", e => {
  if (!isOpen || chrome?.isBlocking() || ui.preview) return;
  const t = e.target;
  if (t.isContentEditable) return;   // text card editing has its own paste handler
  if (/^(INPUT|TEXTAREA)$/.test(t.tagName)) return;
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
  if (files.length) { e.preventDefault(); ui.emptyDismissed = true; addImageFiles(files, null); return; }
  const text = e.clipboardData?.getData("text/plain");
  if (text && text.trim()) { e.preventDefault(); ui.emptyDismissed = true; addText("body", null, text.slice(0, 20000)); }
});

// ---- files: save / open / new ---------------------------------------------------------------------------------------------
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const safeName = () => (S.name || "atelier").replace(/[\\/:*?"<>|]+/g, "-").trim() || "atelier";
const dataUrlToU8 = u => { const i = u.indexOf(","), bin = atob(u.slice(i + 1)), a = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) a[k] = bin.charCodeAt(k); return a; };
const u8ToDataUrl = (a, mime) => { let s = ""; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return `data:${mime};base64,${btoa(s)}`; };

async function saveFile() {
  finishEdit();
  try {
    status("파일 만드는 중…");
    const { zipSync, strToU8 } = await import(FFLATE);
    const files = {};
    const diagrams = [], images = [];
    for (const [id, a] of Object.entries(S.assets)) {
      const p = payloads.get(id) || {};
      if (a.kind === "diagram") {
        if (p.svg) files[`svg/${id}.svg`] = [strToU8(p.svg), { level: 6 }];
        if (p.preview) files[`preview/${id}.png`] = [dataUrlToU8(p.preview), { level: 0 }];
        diagrams.push({ id, palette: a.meta?.palette || null, svg: `svg/${id}.svg`, preview: `preview/${id}.png` });
      } else if (p.img) {
        const ext = (/^data:image\/(png|jpeg|webp|gif)/.exec(p.img) || [, "jpeg"])[1].replace("jpeg", "jpg");
        files[`img/${id}.${ext}`] = [dataUrlToU8(p.img), { level: 0 }];
        images.push({ id, img: `img/${id}.${ext}` });
      }
    }
    const project = {
      format: "atelier-project", version: DOC_VERSION, name: S.name, seq: S.seq,
      site: S.site, meta: S.meta, styles: S.styles, layers: S.layers, guides: S.guides, export: S.export, diagrams, images, assets: S.assets,
      board: {
        frames: S.frames.map(f => ({ id: f.id, size: f.size, orientation: f.orientation, grid_mm: f.grid_mm, x: f.x, y: f.y, n: f.n, page: f.page, template: f.template, cartouche: f.cartouche })),
        cards: S.cards.map(c => ({ ...c }))
      }
    };
    files["project.json"] = [strToU8(JSON.stringify(project, null, 1)), { level: 6 }];
    const zip = zipSync(files);
    download(new Blob([zip], { type: "application/zip" }), `${safeName()}.atelier`);
    dirty = false;
    status(`저장됨 · ${(zip.length / 1048576).toFixed(1)} MB`);
  } catch (e) { console.error(e); status(`저장 실패: ${e.message}`); }
}
function resetCanvasState() {
  for (const [, g] of els) g.remove();
  els.clear();
  sel.clear(); selFrame = null; selGuide = null; assetSig = ""; pageSig = ""; ctxSig = ""; ui.emptyDismissed = false;
  $("#bd-layer-list").dataset.sig = ""; $("#bd-props").dataset.sig = "";
  hist = [snap()]; hi = 0; syncGeom();
}
async function openFile(file) {
  try {
    status("파일 여는 중…");
    const { unzipSync, strFromU8 } = await import(FFLATE);
    const buf = await file.arrayBuffer();
    const z = unzipSync(new Uint8Array(buf));
    if (!z["project.json"]) throw new Error("project.json이 없습니다.");
    const pj = JSON.parse(strFromU8(z["project.json"]));
    if (pj.format !== "atelier-project") throw new Error("Atelier 프로젝트 파일이 아닙니다.");
    if (!(num(pj.version, 1, 0, 1e6) <= DOC_VERSION)) throw new Error("더 새로운 버전의 파일입니다.");
    if ((S.cards.length || Object.keys(S.assets).length) && !confirm("지금 보드를 이 파일로 바꿀까요? 저장하지 않은 내용은 사라집니다.")) { status(""); return; }
    const ver = Math.round(num(pj.version, 1, 0, 1e6));
    if (ver < DOC_VERSION) {   // old file: keep the untouched original bytes before migrating
      const base = (file.name || "atelier").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "-").trim() || "atelier";
      download(new Blob([buf], { type: "application/zip" }), `${base}.v${Math.max(1, ver)}.bak.atelier`);
    }
    const info = {};
    const next = sanitizeDoc({ ...pj, board: pj.board, assets: pj.assets, layers: pj.layers, guides: pj.guides ?? pj.board?.guides }, info);
    if (info.failed || info.dropped) console.warn(`board migration v${info.from} -> v${DOC_VERSION}: ${info.failed} card(s) kept on the pasteboard at default coordinates, ${info.dropped} card(s) dropped`);
    payloads.clear();
    const MIME = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
    for (const id of Object.keys(next.assets)) {
      const a = next.assets[id], p = {};
      if (a.kind === "diagram") {
        if (z[`svg/${id}.svg`]) { const v = cleanSvgString(strFromU8(z[`svg/${id}.svg`])); if (v) p.svg = v; }
        if (z[`preview/${id}.png`]) p.preview = safeImg(u8ToDataUrl(z[`preview/${id}.png`], "image/png"));
      } else {
        const ext = Object.keys(MIME).find(x => z[`img/${id}.${x}`]);
        if (ext) p.img = safeImg(u8ToDataUrl(z[`img/${id}.${ext}`], MIME[ext]));
      }
      payloads.set(id, p);
    }
    S = next; ensureFrame(); resetCanvasState();
    scheduleSave(); render(); fitAll();
    dirty = false;
    status(`열림 · 카드 ${S.cards.length}장${ver < DOC_VERSION ? ` · v${Math.max(1, ver)} → v${DOC_VERSION} 변환 (원본은 .bak.atelier로 내려받음)` : ""}`);
  } catch (e) { console.error(e); status(`열기 실패: ${e.message}`); }
}
function newBoard() {
  if ((S.cards.length || Object.keys(S.assets).length) && !confirm("새 보드를 만들까요? 지금 보드는 파일로 저장하지 않았다면 사라집니다.")) return;
  S = emptyDoc(); payloads.clear(); ensureFrame(); resetCanvasState();
  dirty = true; scheduleSave(); render(); fitAll();
}
function ensureFrame() {
  if (S.frames.length) return;
  addFrame();
}

// ---- UI shell ------------------------------------------------------------------------------------------------------
let statusTimer = 0;
function status(msg) {
  const s = $("#bd-status");
  if (!s) return;
  s.textContent = msg;
  clearTimeout(statusTimer);
  if (msg) statusTimer = setTimeout(() => { if (s.textContent === msg) s.textContent = ""; }, 6000);
}
function closeMenus() {
  let any = false;
  for (const m of document.querySelectorAll("#board .bd-menu")) if (!m.hidden) { m.hidden = true; any = true; }
  const ap = $("#bd-addpop"); if (ap && !ap.hidden) { ap.hidden = true; any = true; }
  const sg = $("#bd-stamps"); if (sg && !sg.hidden) { sg.hidden = true; any = true; }
  for (const b of document.querySelectorAll("#board [aria-haspopup]")) b.setAttribute("aria-expanded", "false");
  return any;
}
const TOOLS = [["v", "select", "선택", "V"], ["h", "hand", "손", "H"], ["t", "text", "텍스트", "T"], ["f", "frame", "프레임", "F"], ["n", "note", "메모", "N"], ["i", "image", "이미지", "I"], ["s", "stampbar", "축척·방위", "S"]];

function build() {
  const sec = document.createElement("section");
  sec.id = "board"; sec.hidden = true;
  sec.setAttribute("aria-label", "보드");
  sec.innerHTML = `
    <header class="bd-bar">
      <div class="bd-bl">
        <button id="bd-panel-toggle" class="bd-ib" type="button" aria-pressed="true" data-tip="왼쪽 패널" aria-label="왼쪽 패널 접기·펼치기">${icon("panel")}</button>
        <nav class="bd-tabs" aria-label="모드">
          <button type="button" data-mode="terrain">대지</button>
          <button type="button" data-mode="diagrams">다이어그램</button>
          <button type="button" data-mode="board" aria-current="page">보드</button>
        </nav>
        <div class="bd-namewrap bd-menu-wrap">
          <input id="bd-name" class="bd-name" type="text" aria-label="보드 이름" maxlength="80">
          <button id="bd-name-menu" class="bd-ib" type="button" aria-haspopup="true" aria-expanded="false" aria-label="보드 메뉴" data-tip="보드 메뉴">${icon("chevron")}</button>
          <div id="bd-name-pop" class="bd-menu" hidden>
            <button type="button" data-m="new">새 보드</button>
            <button type="button" data-m="open">파일 열기</button>
            <button type="button" data-m="save">파일로 저장</button>
            <button type="button" data-m="img">이미지 추가</button>
          </div>
        </div>
        <span id="bd-save-state" class="bd-savestate" role="status" aria-live="polite"></span>
      </div>
      <div class="bd-bc">
        <div class="bd-seg bd-hide-m" role="group" aria-label="보기 모드">
          <button type="button" data-layout="work" aria-pressed="true" data-tip="작업 (Shift+R)">작업</button>
          <button type="button" data-layout="print" aria-pressed="false" data-tip="조판 (Shift+R)">조판</button>
        </div>
      </div>
      <div class="bd-br">
        <div class="bd-menu-wrap bd-hide-m" id="bd-pfwrap" hidden>
          <button id="bd-pf" class="bd-btn bd-pf" type="button" aria-haspopup="true" aria-expanded="false" aria-label="출력 점검"><span class="bd-pf-ic"></span><span id="bd-pf-t">점검 OK</span></button>
          <div id="bd-pfpop" class="bd-menu bd-menu-r bd-pfpop" hidden></div>
        </div>
        <button id="bd-undo" class="bd-ib bd-hide-m" type="button" aria-label="실행 취소" data-tip="실행 취소 (⌘Z)">${icon("undo")}</button>
        <button id="bd-redo" class="bd-ib bd-hide-m" type="button" aria-label="다시 실행" data-tip="다시 실행 (⌘⇧Z)">${icon("redo")}</button>
        <button id="bd-export" class="bd-primary" type="button">출력</button>
        <div class="bd-menu-wrap">
          <button id="bd-more" class="bd-ib" type="button" aria-haspopup="true" aria-expanded="false" aria-label="더보기" data-tip="더보기">${icon("more")}</button>
          <div id="bd-more-pop" class="bd-menu bd-menu-r" hidden>
            <button type="button" data-m="present">발표<kbd>P</kbd></button>
            <button type="button" data-m="minimap">미니맵 보기</button>
            <button type="button" data-m="shortcuts">단축키<kbd>?</kbd></button>
            <button type="button" data-m="info">보드 정보</button>
            <button type="button" data-m="styles">글 스타일</button>
            <button type="button" data-m="palette">명령 팔레트<kbd>⌘K</kbd></button>
            <span class="bd-msep" role="separator"></span>
            <button type="button" data-m="gh">가이드 숨기기</button>
            <button type="button" data-m="gl">가이드 잠금</button>
            <button type="button" data-m="gc">이 페이지 가이드 모두 지우기</button>
          </div>
        </div>
      </div>
    </header>
    <div id="bd-banner" class="bd-banner" role="alert" hidden>자동저장 안 됨 — 파일로 저장하세요</div>
    <div class="bd-main">
      <nav class="bd-rail" aria-label="도구">
        ${TOOLS.map(([k, ic, name, key]) => `<button class="bd-ib" type="button" data-tool="${k}" data-tip="${name} (${key})" aria-label="${name} (${key})" aria-pressed="${k === "v"}">${icon(ic)}</button>`).join("")}
      </nav>
      <aside id="bd-panel" class="bd-panel" aria-label="페이지·자료·레이어">
        <div class="bd-ptabs" role="tablist" aria-label="패널">
          <button id="bd-tab-pages" type="button" role="tab" aria-selected="false" aria-controls="bd-pane-pages">페이지</button>
          <button id="bd-tab-assets" type="button" role="tab" aria-selected="true" aria-controls="bd-pane-assets">자료</button>
          <button id="bd-tab-layers" type="button" role="tab" aria-selected="false" aria-controls="bd-pane-layers">레이어</button>
        </div>
        <div id="bd-pane-pages" class="bd-pane" role="tabpanel" aria-labelledby="bd-tab-pages" hidden>
          <div id="bd-page-list" class="bd-page-list"></div>
          <div class="bd-addpage">
            <button id="bd-addpage" class="bd-btn" type="button" aria-expanded="false">+ 페이지</button>
            <div id="bd-addpop" class="bd-addpop" hidden>
              <select id="bd-new-size" aria-label="용지">${SIZES.map(s => `<option${s === "A3" ? " selected" : ""}>${s}</option>`).join("")}</select>
              <select id="bd-new-orient" aria-label="방향"><option value="landscape">가로</option><option value="portrait">세로</option></select>
              <button id="bd-addpage-ok" class="bd-btn bd-strong" type="button">추가</button>
            </div>
          </div>
        </div>
        <div id="bd-pane-assets" class="bd-pane" role="tabpanel" aria-labelledby="bd-tab-assets">
          <div id="bd-asset-tools" class="bd-asset-tools">
            <div class="bd-search">${icon("search")}<input id="bd-q" type="text" placeholder="자료 검색" aria-label="자료 검색"></div>
            <div class="bd-chips" role="group" aria-label="종류">
              <button type="button" class="bd-chip" data-filter="all" aria-pressed="true">전체</button>
              <button type="button" class="bd-chip" data-filter="diagram" aria-pressed="false">다이어그램</button>
              <button type="button" class="bd-chip" data-filter="image" aria-pressed="false">이미지</button>
            </div>
          </div>
          <div id="bd-asset-grid" class="bd-asset-grid"></div>
          <div id="bd-dropzone" class="bd-dropzone" hidden>
            <p>이미지를 여기에 끌어 놓으세요</p>
            <button type="button" class="bd-btn" data-empty="diagrams">다이어그램 가져오기</button>
            <button type="button" class="bd-btn" data-empty="image">이미지 추가</button>
          </div>
        </div>
        <div id="bd-pane-layers" class="bd-pane" role="tabpanel" aria-labelledby="bd-tab-layers" hidden>
          <div id="bd-layer-list" class="bd-layer-list"></div>
          <p class="bd-ps-note">숨긴 레이어는 화면과 출력에서 빠지고, 잠근 레이어의 카드는 고르거나 옮길 수 없습니다.</p>
        </div>
      </aside>
      <div class="bd-stage" id="bd-stage">
        <div class="bd-rc" aria-hidden="true"></div>
        <svg id="bd-ruler-h" class="bd-rh" xmlns="${NS}" aria-hidden="true"></svg>
        <svg id="bd-ruler-v" class="bd-rv" xmlns="${NS}" aria-hidden="true"></svg>
        <svg id="bd-svg" xmlns="${NS}" aria-label="보드 캔버스" role="application" tabindex="0" data-tool="v">
          <defs><filter id="bd-shadow" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB"><feDropShadow id="bd-shadow-fx" dx="0" dy="1" stdDeviation="3" flood-color="#000" flood-opacity="0.14"/></filter></defs>
          <g id="bd-world"><g id="bd-frames"></g><g id="bd-cards"></g><g id="bd-ug"></g><g id="bd-guides"></g><g id="bd-selection"></g><g id="bd-over"></g></g>
        </svg>
        <div id="bd-ctx" class="bd-ctx" role="toolbar" aria-label="선택 도구" hidden></div>
        <div id="bd-ctxmenu" class="bd-menu bd-ctxmenu" hidden>
          <button type="button" data-act="front">앞으로<kbd>]</kbd></button>
          <button type="button" data-act="back">뒤로<kbd>[</kbd></button>
          <button type="button" data-act="tofront">맨 앞으로</button>
          <button type="button" data-act="toback">맨 뒤로</button>
          <span class="bd-msep" role="separator"></span>
          <button type="button" data-act="dup">복제<kbd>⌘D</kbd></button>
          <button type="button" data-act="lock">잠금 · 풀기</button>
          <button type="button" data-act="del">삭제</button>
        </div>
        <div id="bd-stamps" class="bd-stamps" role="dialog" aria-label="축척·방위 템플릿" hidden></div>
        <div id="bd-empty" class="bd-emptycard" hidden>
          <h2>보드를 시작하세요</h2>
          <p>다이어그램, 사진, 글을 한 판 위에 모으고 최종 판넬로 출력합니다.</p>
          <button type="button" class="bd-btn" data-empty="diagrams">다이어그램 가져오기</button>
          <button type="button" class="bd-btn" data-empty="image">이미지 추가<small>끌어 놓거나 ⌘V로 붙여넣기</small></button>
          <button type="button" class="bd-btn bd-strong" data-empty="final">최종 판넬로 시작<small>A1 세로 · 6단 · 카르투슈</small></button>
        </div>
        <div id="bd-minimap" class="bd-minimap" hidden><svg id="bd-mini" viewBox="0 0 176 116" aria-label="미니맵" role="img"></svg></div>
        <div class="bd-zoombar" role="group" aria-label="확대·축소">
          <button id="bd-zoom-out" class="bd-ib" type="button" aria-label="축소" data-tip="축소">${icon("minus")}</button>
          <button id="bd-zoom" class="bd-zoom" type="button" data-tip="100%로" aria-label="확대 비율, 누르면 100%">100%</button>
          <button id="bd-zoom-in" class="bd-ib" type="button" aria-label="확대" data-tip="확대">${icon("plus")}</button>
        </div>
        <div id="bd-readout" class="bd-readout" hidden></div>
        <div id="bd-gpop" class="bd-gpop" hidden role="dialog" aria-label="가이드 위치"><label><span id="bd-gpop-l">Y</span><input id="bd-gpop-in" type="text" inputmode="decimal" aria-label="가이드 위치 (mm)" autocomplete="off"><span class="bd-nf-u">mm</span></label></div>
        <div id="bd-hint" class="bd-hint" role="status" hidden><span>조판 모드: 눈금자·여백·단이 보이고 핀업 카드는 흐려집니다</span><button type="button" class="bd-btn" id="bd-hint-ok">확인</button></div>
      </div>
      <aside id="bd-props" class="bd-props" aria-label="속성" hidden></aside>
      <div id="bd-list" class="bd-list" aria-label="페이지별 카드 목록"></div>
    </div>
    <p id="bd-status" class="bd-status" role="status" aria-live="polite"></p>
    <div id="bd-tip" class="bd-tip" role="tooltip" hidden></div>
    <input id="bd-file-img" type="file" accept="image/*" multiple hidden>
    <input id="bd-file-repl" type="file" accept="image/*" hidden>
    <input id="bd-file-proj" type="file" accept=".atelier,.zip,application/zip" hidden>`;
  document.body.append(sec);
  layerFrames = $("#bd-frames"); layerCards = $("#bd-cards"); layerOver = $("#bd-over"); layerUG = $("#bd-ug"); layerGuides = $("#bd-guides"); layerSel = $("#bd-selection");
  chrome = createChrome({
    root: () => $("#board"), ctx: () => ({ S, payloads }), status, download, safeName, selectedFrame, finishEdit, loadFontCss, buildPdf,
    commitMeta: v => { S.meta = { ...S.meta, ...v }; commit(); },
    commitStyles: v => { S.styles = v; commit(); },
    focusStage: () => $("#bd-svg").focus({ preventScroll: true }),
    preflight: () => { runPreflight(); return { list: pfList, S }; }, setPreset: v => { if (PRESET_KEYS.includes(v) && S.export?.preset !== v) { S.export = { preset: v }; commit(); } }, getPreset: () => S.export?.preset || "print"
  });
  wire();
  initTips();
  document.fonts?.ready?.then(() => schedulePreflight());   // text metrics change once the web font is in
}

function gotoMode(m) {
  const pm = prevMode;
  close();
  if (m === "diagrams") { if (pm !== "diagrams") document.getElementById("start-diagrams")?.click(); }
  else if (m === "terrain") document.getElementById("start")?.click();
}

function wire() {
  const svg = $("#bd-svg");
  svg.addEventListener("pointerdown", onPointerDown);
  svg.addEventListener("pointermove", onPointerMove);
  svg.addEventListener("pointerup", onPointerUp);
  svg.addEventListener("pointercancel", onPointerUp);
  svg.addEventListener("wheel", onWheel, { passive: false });
  svg.addEventListener("dblclick", e => {
    const gd = e.target.closest("[data-guide]");
    if (gd) { openGuidePop(gd.dataset.guide); return; }
    const g = e.target.closest(".bd-card");
    if (g) { const c = cardById(g.dataset.id); if (c && (c.kind === "image" || c.kind === "diagram")) enterContent(c.id); else startEdit(g.dataset.id); }
  });
  svg.addEventListener("input", e => { if (e.target.classList?.contains("bd-text") && editingId) { syncEditText(); scheduleSave(); } });
  svg.addEventListener("focusout", e => { if (e.target.classList?.contains("bd-text")) finishEdit(); });
  svg.addEventListener("paste", e => {
    if (!e.target.classList?.contains("bd-text")) return;
    e.preventDefault();
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
  });
  // drag & drop: panel items and files (dashed highlight on the stage while dragging over)
  const stage = $("#bd-stage");
  svg.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; stage.classList.add("is-drop"); });
  svg.addEventListener("dragleave", e => { if (!stage.contains(e.relatedTarget)) stage.classList.remove("is-drop"); });
  svg.addEventListener("drop", e => {
    e.preventDefault(); stage.classList.remove("is-drop");
    if (ui.preview) return;
    const at = toWorld(e);
    const sk = e.dataTransfer.getData("text/atelier-stamp");
    if (STAMPS.includes(sk)) { ui.stampPick = { k: sk, link: stampLinkCandidate() }; placeStamp(at); return; }
    ui.emptyDismissed = true;
    if (e.dataTransfer.files?.length) { addImageFiles(e.dataTransfer.files, at); return; }
    const id = e.dataTransfer.getData("text/atelier-asset");
    if (id && S.assets[id]) { const c = placeAsset(id, at); if (c) { sel = new Set([c.id]); selFrame = null; } commit(); }
  });
  // rail + top bar
  for (const b of document.querySelectorAll("#board [data-tool]")) b.onclick = () => { if (b.dataset.tool === "i") { $("#bd-file-img").click(); return; } if (b.dataset.tool === "s") { toggleStamps(); return; } setTool(b.dataset.tool); };
  $("#bd-panel-toggle").onclick = () => { ui.panel = !ui.panel; assetSig = ""; pageSig = ""; renderChrome(); renderPanel(); requestAnimationFrame(() => applyView()); };
  for (const b of document.querySelectorAll("#board [data-mode]")) b.onclick = () => { if (b.dataset.mode !== "board") gotoMode(b.dataset.mode); };
  for (const b of document.querySelectorAll("#board [data-layout]")) b.onclick = () => setLayout(b.dataset.layout);
  $("#bd-file-proj").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) openFile(f); };
  $("#bd-file-img").onchange = e => { const fs = [...e.target.files]; e.target.value = ""; if (fs.length) { ui.emptyDismissed = true; addImageFiles(fs); } };
  $("#bd-undo").onclick = undo;
  $("#bd-redo").onclick = redo;
  $("#bd-export").onclick = () => chrome.openExport();
  $("#bd-name").onchange = e => { S.name = e.target.value.trim() || "Atelier 보드"; commit(); };
  $("#bd-name").onkeydown = e => { if (e.key === "Enter") e.target.blur(); };
  // menus
  const menu = (btnId, popId, on) => {
    const btn = $(btnId), pop = $(popId);
    btn.onclick = e => { e.stopPropagation(); const open = pop.hidden; closeMenus(); pop.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };
    pop.addEventListener("click", e => { const b = e.target.closest("[data-m]"); if (!b || b.disabled) return; closeMenus(); on(b.dataset.m); });
  };
  menu("#bd-name-menu", "#bd-name-pop", m => { if (m === "new") newBoard(); else if (m === "open") $("#bd-file-proj").click(); else if (m === "save") saveFile(); else if (m === "img") $("#bd-file-img").click(); });
  menu("#bd-more", "#bd-more-pop", m => {
    if (m === "present") present();
    else if (m === "minimap") { ui.minimap = !ui.minimap; renderChrome(); scheduleMini(); }
    else if (m === "shortcuts") chrome.openShortcuts();
    else if (m === "palette") chrome.openPalette(commands());
    else if (m === "info") chrome.openInfo();
    else if (m === "styles") chrome.openStyles();
    else if (m === "gh") { ui.guidesHidden = !ui.guidesHidden; render(); }
    else if (m === "gl") { ui.guidesLocked = !ui.guidesLocked; render(); }
    else if (m === "gc") clearPageGuides();
  });
  // the stamp gallery is opened from the tool rail (S): clicks on that button or inside the gallery must not close it
  document.addEventListener("click", e => { if (!e.target.closest("#board .bd-menu-wrap, #bd-stamps, #board [data-tool='s']")) closeMenus(); });
  // panel
  for (const b of document.querySelectorAll("#board [role=tab]")) b.onclick = () => { ui.panelTab = b.id.replace("bd-tab-", ""); assetSig = ""; pageSig = ""; $("#bd-layer-list").dataset.sig = ""; renderPanel(); };
  $("#bd-layer-list").addEventListener("click", e => { const b = e.target.closest("[data-ly]"); if (b) toggleLayer(b.dataset.ly, b.dataset.what); });
  $("#bd-q").oninput = e => { ui.q = e.target.value; renderAssets(); };
  for (const b of document.querySelectorAll("#board [data-filter]")) b.onclick = () => { ui.filter = b.dataset.filter; assetSig = ""; renderAssets(); };
  const grid = $("#bd-asset-grid");
  grid.addEventListener("dragstart", e => {
    const row = e.target.closest("[data-asset]");
    if (row) { e.dataTransfer.setData("text/atelier-asset", row.dataset.asset); e.dataTransfer.effectAllowed = "copy"; }
  });
  grid.addEventListener("click", e => {
    const p = e.target.closest("[data-place]"), r = e.target.closest("[data-remove-asset]");
    if (p) { ui.emptyDismissed = true; const c = placeAsset(p.dataset.place); if (c) { sel = new Set([c.id]); selFrame = null; } commit(); }
    else if (r) { if (r.getAttribute("aria-disabled") === "true") { status(r.dataset.tip || r.title || "배치된 카드가 있어 지울 수 없습니다."); return; } delete S.assets[r.dataset.removeAsset]; commit(); }
  });
  const pl = $("#bd-page-list");
  pl.addEventListener("click", e => {
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    const row = b.closest("[data-frame]"), f = frameById(row.dataset.frame);
    if (!f) return;
    const i = S.frames.indexOf(f);
    if (b.dataset.act === "pg-go") { if (mobileMQ.matches) return; if (!wideMQ.matches) { ui.panel = false; renderChrome(); } requestAnimationFrame(() => zoomToFrame(f)); }
    else if (b.dataset.act === "pg-up") movePage(f.id, i - 1);
    else if (b.dataset.act === "pg-down") movePage(f.id, i + 1);
  });
  // pointer-based page reorder (grip handle)
  pl.addEventListener("pointerdown", e => {
    const grip = e.target.closest(".bd-grip");
    if (!grip || e.button !== 0) return;
    e.preventDefault();
    const row = grip.closest(".bd-pg"), id = row.dataset.frame;
    row.classList.add("is-drag");
    let to = S.frames.findIndex(f => f.id === id);
    const mark = () => {
      for (const r of pl.children) r.classList.remove("is-over-b", "is-over-a");
      const others = [...pl.children].filter(r => r !== row), t = others[to];
      if (t) t.classList.add("is-over-b"); else if (others.length) others[others.length - 1].classList.add("is-over-a");
    };
    const move = ev => {   // final index = number of other rows whose midline is above the pointer
      let n = 0;
      for (const r of pl.children) { if (r === row) continue; const b = r.getBoundingClientRect(); if (ev.clientY > b.top + b.height / 2) n++; }
      to = n; mark();
    };
    const up = () => {
      removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up);
      row.classList.remove("is-drag"); for (const r of pl.children) r.classList.remove("is-over-b", "is-over-a");
      movePage(id, to);
    };
    addEventListener("pointermove", move); addEventListener("pointerup", up); addEventListener("pointercancel", up);
  });
  $("#bd-addpage").onclick = () => { const pop = $("#bd-addpop"); pop.hidden = !pop.hidden; $("#bd-addpage").setAttribute("aria-expanded", String(!pop.hidden)); };
  $("#bd-addpage-ok").onclick = () => {
    const f = addFrame({ size: $("#bd-new-size").value, orientation: $("#bd-new-orient").value });
    frameDefaults = { size: f.size, orientation: f.orientation };
    $("#bd-addpop").hidden = true; ui.emptyDismissed = true;
    selFrame = f.id; sel.clear(); commit(); zoomToFrame(f);
  };
  // contextual bar
  const ctx = $("#bd-ctx");
  ctx.addEventListener("click", e => { const b = e.target.closest("[data-act]"); if (b) ctxAction(b.dataset.act); });
  $("#bd-ctxmenu").addEventListener("click", e => { const b = e.target.closest("[data-act]"); if (b) ctxAction(b.dataset.act); });
  $("#bd-ctxmenu").addEventListener("pointerdown", e => e.stopPropagation());
  ctx.addEventListener("change", e => { const s = e.target.closest("[data-sel]"); if (s) ctxSelect(s.dataset.sel, s.value); });
  ctx.addEventListener("pointerdown", e => e.stopPropagation());
  // empty state
  const dz = $("#bd-dropzone");
  dz.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "copy"; dz.classList.add("is-over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("is-over"));
  dz.addEventListener("drop", e => { e.preventDefault(); e.stopPropagation(); dz.classList.remove("is-over"); if (e.dataTransfer.files?.length) { ui.emptyDismissed = true; addImageFiles(e.dataTransfer.files, null); } });
  const sgal = $("#bd-stamps");
  sgal.addEventListener("click", e => { const b = e.target.closest("[data-stamp]"); if (b) pickStamp(b.dataset.stamp); });
  sgal.addEventListener("dragstart", e => { const b = e.target.closest("[data-stamp]"); if (b) { e.dataTransfer.setData("text/atelier-stamp", b.dataset.stamp); e.dataTransfer.effectAllowed = "copy"; sgal.hidden = true; } });
  sgal.addEventListener("pointerdown", e => e.stopPropagation());
  $("#bd-file-repl").onchange = async e => {   // 내용 교체: new image for THIS card only, frame and content offsets stay
    const f = e.target.files[0]; e.target.value = "";
    const c = selCards()[0];
    if (!f || !c || c.kind !== "image" || isLocked(c)) return;
    try {
      const { dataUrl, w, h } = await downscale(f), long = 120, mw = w >= h ? long : long * w / h, mh = w >= h ? long * h / w : long;
      const id = registerAsset("image", (f.name || "이미지").replace(/\.[^.]+$/, ""), r2(mw), r2(mh), { img: dataUrl });
      if (!c.content) c.content = { dx: 0, dy: 0, s: 1 };
      const old = c.ref; c.ref = id;
      if (c.content && c.fit === "fill") c.content = { dx: 0, dy: 0, s: coverScale(c, S.assets[id]) };   // other aspect: re-cover the frame
      if (!S.cards.some(k => k.ref === old)) delete S.assets[old];   // no orphan asset (the payload stays for undo)
      commit();
    } catch (err) { console.error(err); status("이미지를 읽지 못했습니다."); }
  };
  $("#bd-pf").onclick = e => { e.stopPropagation(); const pop = $("#bd-pfpop"), open = pop.hidden; closeMenus(); if (open) { runPreflight(); renderPfPop(); } pop.hidden = !open; $("#bd-pf").setAttribute("aria-expanded", String(open)); };
  $("#bd-pfpop").addEventListener("click", e => { const b = e.target.closest("[data-pf]"); if (b) gotoPf(b.dataset.pf); });
  $("#bd-hint-ok").onclick = () => { $("#bd-hint").hidden = true; };
  $("#bd-ruler-h").addEventListener("pointerdown", e => onRulerDown(e, "y"));   // top ruler -> horizontal guide
  $("#bd-ruler-v").addEventListener("pointerdown", e => onRulerDown(e, "x"));   // left ruler -> vertical guide
  svg.addEventListener("pointermove", moveRulerMark);
  const gin = $("#bd-gpop-in");
  gin.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); commitGuidePop(); } else if (e.key === "Escape") { e.stopPropagation(); closeGuidePop(); } });
  gin.addEventListener("blur", () => { if (!$("#bd-gpop").hidden) setTimeout(() => { if (!$("#bd-gpop").hidden && document.activeElement !== gin) $("#bd-gpop").hidden = true; }, 0); });
  mobileMQ.addEventListener?.("change", () => render());
  for (const q of [wideMQ, dockMQ, desktopMQ]) q.addEventListener?.("change", () => { if (q === wideMQ) ui.panel = wideMQ.matches; render(); requestAnimationFrame(() => applyView()); });
  $("#bd-empty").addEventListener("click", emptyAction);
  dz.addEventListener("click", emptyAction);
  function emptyAction(e) {
    const b = e.target.closest("[data-empty]");
    if (!b) return;
    ui.emptyDismissed = true;
    if (b.dataset.empty === "diagrams") gotoMode("diagrams");
    else if (b.dataset.empty === "image") { $("#bd-file-img").click(); renderEmpty(); }
    else startFinalPanel();
  }
  // zoom bar + minimap
  const mid = () => { const r = svg.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
  $("#bd-zoom-in").onclick = () => zoomAt(1.25, ...mid());
  $("#bd-zoom-out").onclick = () => zoomAt(0.8, ...mid());
  $("#bd-zoom").onclick = () => zoomAt(PX_PER_MM / view.z, ...mid());

  const mini = $("#bd-mini");
  mini.addEventListener("pointerdown", e => { try { mini.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } mini.dataset.drag = "1"; miniMove(e); });
  mini.addEventListener("pointermove", e => { if (mini.dataset.drag) miniMove(e); });
  mini.addEventListener("pointerup", () => { delete mini.dataset.drag; });
  mini.addEventListener("pointercancel", () => { delete mini.dataset.drag; });
  // mobile list
  const list = $("#bd-list");
  list.addEventListener("click", e => { const b = e.target.closest("[data-lact]"); if (b && !b.disabled) listAction(b.dataset.lact, b.dataset.lid); });
  list.addEventListener("change", e => {
    const t = e.target.closest("textarea[data-lid]");
    if (t) { const c = cardById(t.dataset.lid); if (c && !isLocked(c)) { c.text = t.value; commit(); } }
  });
  mobileMQ.addEventListener?.("change", () => { if (isOpen && !mobileMQ.matches && !fitted) requestAnimationFrame(() => { if (fitAll()) fitted = true; }); });
  addEventListener("resize", () => { if (isOpen && !mobileMQ.matches) applyView(); });
}

// ---- ruler guides (user guides dragged out of the rulers; 조판 only, never exported) -----------------------------------------
// Doc field S.guides = [{ id, page: frameId | null, axis: "x" | "y", mm }]; page guides are page-relative mm (they travel with the page).
const guideBase = g => { const f = g.page ? frameById(g.page) : null; return g.page && !f ? null : (f ? (g.axis === "x" ? f.x : f.y) : 0); };
function guideLines(gf) {   // board guides + guides of the page the card is on (never another page's guides)
  const xs = [], ys = [];
  if (!showUG()) return { xs, ys };
  for (const g of S.guides) { if (g.page && g.page !== gf?.id) continue; const b = guideBase(g); if (b == null) continue; (g.axis === "x" ? xs : ys).push(b + g.mm); }
  return { xs, ys };
}
function renderGuides() {
  if (!layerUG) return;
  layerUG.replaceChildren();
  if (!showUG()) return;
  const FAR = 50000;
  for (const g of S.guides) {
    const b = guideBase(g);
    if (b == null) continue;
    const f = g.page ? frameById(g.page) : null, [w, h] = f ? frameSize(f) : [0, 0], at = b + g.mm;
    const [x1, y1, x2, y2] = g.axis === "x" ? [at, f ? f.y : -FAR, at, f ? f.y + h : FAR] : [f ? f.x : -FAR, at, f ? f.x + w : FAR, at];
    el("line", { x1, y1, x2, y2, class: "bd-ug" + (g.id === selGuide ? " is-sel" : ""), "data-gv": g.id, "vector-effect": "non-scaling-stroke" }, layerUG);
    if (!ui.guidesLocked) el("line", { x1, y1, x2, y2, class: "bd-ug-hit", "data-guide": g.id, "vector-effect": "non-scaling-stroke" }, layerUG);   // +-4 px hit area
  }
}
// selection highlight without rebuilding the guide DOM (a rebuild between mousedown and mouseup would swallow the double click)
function markGuideSel() { for (const l of layerUG.querySelectorAll("[data-gv]")) l.classList.toggle("is-sel", l.dataset.gv === selGuide); }
function showReadout(e, text) {
  const r = $("#bd-readout"), st = $("#bd-stage").getBoundingClientRect();
  r.textContent = text; r.hidden = false;
  r.style.left = Math.round(e.clientX - st.left + 14) + "px"; r.style.top = Math.round(e.clientY - st.top + 14) + "px";
}
const hideReadout = () => { $("#bd-readout").hidden = true; };
// shared by "drag from ruler" (new) and "drag an existing guide": the pointer decides page vs board guide; outside the canvas = cancel
function guideFromPointer(e, d) {
  const sr = $("#bd-svg").getBoundingClientRect();
  const inside = e.clientX >= sr.left && e.clientX <= sr.right && e.clientY >= sr.top && e.clientY <= sr.bottom;
  if (!inside) {   // back over a ruler (or off the canvas): cancel
    d.cancel = true;
    if (d.isNew) S.guides = S.guides.filter(x => x.id !== d.newId); else if (d.g) { d.g.page = d.o.page; d.g.mm = d.o.mm; }
    hideReadout(); renderGuides();
    return;
  }
  if (d.isNew && !S.guides.some(x => x.id === d.newId)) {
    if (S.guides.length >= MAX_GUIDES) { status(`가이드는 최대 ${MAX_GUIDES}개입니다.`); return; }
    d.g = { id: d.newId, page: null, axis: d.axis, mm: 0 }; S.guides.push(d.g);
  }
  if (!d.g) return;
  d.cancel = false; d.moved = true;
  const wx = (e.clientX - sr.left - view.x) / view.z, wy = (e.clientY - sr.top - view.y) / view.z;
  const f = pageAt(S.frames, wx, wy);
  let mm = d.axis === "x" ? wx - (f ? f.x : 0) : wy - (f ? f.y : 0);
  mm = e.shiftKey ? Math.round(mm / 5) * 5 : r1(mm);   // Shift = whole 5 mm
  d.g.page = f ? f.id : null; d.g.mm = mm; selGuide = d.g.id;
  renderGuides();
  showReadout(e, `${d.axis === "x" ? "X" : "Y"} ${fmt(mm)} mm${f ? " · " + pad2(f.page) : " · 대지"}`);
}
function finishGuideDrag(d) {
  hideReadout();
  if (d.cancel || (d.isNew && !d.moved)) {
    if (d.isNew) { S.guides = S.guides.filter(x => x.id !== d.newId); selGuide = null; }
    else if (d.g) { d.g.page = d.o.page; d.g.mm = d.o.mm; }
    render();
    return;
  }
  if (!d.moved) return;   // plain click: selection was already updated on pointer down
  commit();
}
function onRulerDown(e, axis) {
  if (e.button !== 0) return;
  e.preventDefault();
  if (ui.guidesHidden || ui.guidesLocked) { status(ui.guidesHidden ? "가이드가 숨겨져 있습니다. ⋯ 메뉴에서 ‘가이드 보기’를 누르세요." : "가이드가 잠겨 있습니다. ⋯ 메뉴에서 풀 수 있습니다."); return; }
  finishEdit();
  try { $("#bd-svg").setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  drag = { type: "guide", axis, g: null, isNew: true, o: null, moved: false, cancel: true, newId: "gd" + S.seq++ };
}
function deleteGuide(id) {
  if (!S.guides.some(g => g.id === id)) return;
  S.guides = S.guides.filter(g => g.id !== id);
  if (selGuide === id) selGuide = null;
  commit();
}
function clearPageGuides() {
  const f = selectedFrame() || frameAt(...viewCentre()) || nearestFrame(...viewCentre());
  if (!f) return;
  const n = S.guides.filter(g => g.page === f.id).length;
  if (!n) { status("이 페이지에는 가이드가 없습니다."); return; }
  S.guides = S.guides.filter(g => g.page !== f.id);
  selGuide = null; commit(); status(`${pad2(f.page)} 페이지 가이드 ${n}개를 지웠습니다.`);
}
let gpopId = null;
function openGuidePop(id) {
  const g = S.guides.find(x => x.id === id);
  if (!g) return;
  gpopId = id;
  const pop = $("#bd-gpop"), inp = $("#bd-gpop-in"), b = guideBase(g);
  if (b == null) return;
  $("#bd-gpop-l").textContent = g.axis === "x" ? "X" : "Y";
  inp.value = fmt(g.mm);
  const sr = $("#bd-svg").getBoundingClientRect(), st = $("#bd-stage").getBoundingClientRect();
  const sx = g.axis === "x" ? (b + g.mm) * view.z + view.x : sr.width / 2, sy = g.axis === "y" ? (b + g.mm) * view.z + view.y : sr.height / 2;
  pop.hidden = false;
  pop.style.left = Math.round(clamp(sx + sr.left - st.left + 8, 8, st.width - 150)) + "px";
  pop.style.top = Math.round(clamp(sy + sr.top - st.top + 8, 8, st.height - 48)) + "px";
  inp.focus(); inp.select();
}
function closeGuidePop() { $("#bd-gpop").hidden = true; gpopId = null; $("#bd-svg").focus({ preventScroll: true }); }
function commitGuidePop() {
  const g = S.guides.find(x => x.id === gpopId), v = parseNum($("#bd-gpop-in").value);
  if (g && v != null) { g.mm = r1(clamp(v, -100000, 100000)); closeGuidePop(); commit(); } else closeGuidePop();
}

// ---- rulers (20 px, mm; 조판 only) --------------------------------------------------------------------------------------
const rulersOn = () => ui.layout === "print" && !ui.preview && desktopMQ.matches && !mobileMQ.matches;
let rulerRaf = 0, rulerMark = null;
const scheduleRulers = () => { if (!rulerRaf) rulerRaf = requestAnimationFrame(() => { rulerRaf = 0; renderRulers(); }); };
function rulerOrigin() {   // reference = page of the selection, else the page under the view centre; none = world 0,0 ("대지 기준", same as props and board guides)
  let f = null;
  if (selGuide) { const g = S.guides.find(x => x.id === selGuide); f = g && g.page ? frameById(g.page) : null; }
  else if (sel.size) f = frameOf(selCards()[0] || {});
  else if (selFrame) f = frameById(selFrame);
  else { const c = viewCentre(); f = frameAt(c[0], c[1]); }
  return f ? [f.x, f.y] : [0, 0];
}
function renderRulers() {
  if (!isOpen || !$("#bd-stage")) return;
  const on = rulersOn();
  $("#bd-stage").classList.toggle("has-rulers", on);
  if (!on) return;
  const r = $("#bd-svg").getBoundingClientRect();
  if (!r.width || !r.height) return;
  const [ox, oy] = rulerOrigin(), z = view.z;
  const major = [1, 5, 10, 50, 100, 500, 1000, 5000].find(v => v * z >= 56) || 5000;   // label step (mm)
  let minor = major <= 5 ? 1 : major / 10;
  if (minor * z < 5) minor = major;
  const per = Math.round(major / minor);
  const make = horiz => {
    const len = horiz ? r.width : r.height, off = horiz ? view.x : view.y, org = horiz ? ox : oy;
    const a = (0 - off) / z - org, b = (len - off) / z - org;
    let d = "", t = "";
    for (let k = Math.floor(a / minor) - 1, k1 = Math.ceil(b / minor) + 1; k <= k1; k++) {
      const mm = k * minor, p = Math.round((org + mm) * z + off) + 0.5, maj = ((k % per) + per) % per === 0, tl = maj ? 9 : 4;
      d += horiz ? `M${p} ${RULER}V${RULER - tl}` : `M${RULER} ${p}H${RULER - tl}`;
      if (maj) { const lab = String(Math.round(mm * 1000) / 1000); t += horiz ? `<text x="${p + 3}" y="10">${lab}</text>` : `<text transform="translate(10 ${p - 3}) rotate(-90)">${lab}</text>`; }
    }
    return `<path class="bd-rtick" d="${d}"/>${t}`;
  };
  const h = $("#bd-ruler-h"), v = $("#bd-ruler-v");
  h.setAttribute("width", r.width); h.setAttribute("height", RULER); v.setAttribute("width", RULER); v.setAttribute("height", r.height);
  h.innerHTML = make(true) + `<line id="bd-rm-h" class="bd-rmark" x1="${rulerMark ? rulerMark.x : -9}" x2="${rulerMark ? rulerMark.x : -9}" y1="0" y2="${RULER}"/>`;
  v.innerHTML = make(false) + `<line id="bd-rm-v" class="bd-rmark" y1="${rulerMark ? rulerMark.y : -9}" y2="${rulerMark ? rulerMark.y : -9}" x1="0" x2="${RULER}"/>`;
}
function moveRulerMark(e) {   // cursor position marker
  if (!rulersOn()) return;
  const r = $("#bd-svg").getBoundingClientRect();
  rulerMark = { x: e.clientX - r.left, y: e.clientY - r.top };
  const mh = $("#bd-rm-h"), mv = $("#bd-rm-v");
  if (mh) { mh.setAttribute("x1", rulerMark.x); mh.setAttribute("x2", rulerMark.x); }
  if (mv) { mv.setAttribute("y1", rulerMark.y); mv.setAttribute("y2", rulerMark.y); }
}

// ---- properties panel (right, 260 px) ------------------------------------------------------------------------------------------
// Rebuilt as a detached tree on every render; when its structure signature is unchanged only the values are copied into the
// live inputs (focused input untouched), so typing, arrow keys and button clicks never lose their element.
let propsRaf = 0;
const scheduleProps = () => { if (!propsRaf) propsRaf = requestAnimationFrame(() => { propsRaf = 0; renderProps(); }); };
const fmt = v => String(Math.round(v * 10) / 10);
const parseNum = t => { const v = parseFloat(String(t).replace(",", ".").trim()); return Number.isFinite(v) ? v : null; };
const REF = [[0, 0], [.5, 0], [1, 0], [0, .5], [.5, .5], [1, .5], [0, 1], [.5, 1], [1, 1]];
const REF_NAME = ["왼쪽 위", "위 가운데", "오른쪽 위", "왼쪽 가운데", "중앙", "오른쪽 가운데", "왼쪽 아래", "아래 가운데", "오른쪽 아래"];
const psec = (title, ...kids) => { const s = mk("section", "bd-ps"); s.append(mk("h3", "", title)); for (const k of kids) if (k) s.append(k); return s; };
const prow = (...kids) => { const r = mk("div", "bd-pr"); for (const k of kids) if (k) r.append(k); return r; };
const pnote = t => mk("p", "bd-ps-note", t);
function numField(key, label, value, onSet, { unit = "mm", disabled = false, ph = "" } = {}) {
  const w = mk("label", "bd-nf");
  const i = mk("input"); i.type = "text"; i.inputMode = "decimal"; i.autocomplete = "off"; i.spellcheck = false;
  i.value = value == null ? "" : fmt(value); i.defaultValue = i.value; i.dataset.k = key; i.disabled = disabled; i.placeholder = ph;
  i.setAttribute("aria-label", `${label} (${unit})`);
  w.append(mk("span", "bd-nf-l", label), i, mk("span", "bd-nf-u", unit));
  i.addEventListener("keydown", ev => {
    if (ev.key === "Enter") { ev.preventDefault(); i.blur(); }
    else if (ev.key === "Escape") { ev.stopPropagation(); i.value = i.defaultValue; i.blur(); }
    else if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {   // +-1 mm, Shift +-10
      ev.preventDefault();
      const v = parseNum(i.value);
      if (v == null) return;
      i.value = fmt(v + (ev.shiftKey ? 10 : 1) * (ev.key === "ArrowUp" ? 1 : -1));
      i.defaultValue = i.value;
      onSet(parseNum(i.value));
    }
  });
  i.addEventListener("change", () => { const v = parseNum(i.value); if (v == null) { renderProps(); return; } i.defaultValue = i.value; onSet(v); });
  return w;
}
function txtField(key, label, value, max, onSet) {
  const w = mk("label", "bd-tf"), i = mk("input"); i.type = "text"; i.maxLength = max; i.value = value || ""; i.defaultValue = i.value; i.dataset.k = key; i.autocomplete = "off";
  i.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); i.blur(); } else if (ev.key === "Escape") { ev.stopPropagation(); i.value = i.defaultValue; i.blur(); } });
  i.addEventListener("change", () => { i.defaultValue = i.value; onSet(i.value.trim()); });
  w.append(mk("span", "bd-nf-l", label), i);
  return w;
}
function selField(key, label, opts, val, onSet) {
  const w = mk("label", "bd-sf"), s = mk("select"); s.dataset.k = key; s.setAttribute("aria-label", label);
  for (const [v, t] of opts) { const o = mk("option", "", t); o.value = v; o.selected = String(v) === String(val); s.append(o); }
  s.addEventListener("change", () => onSet(s.value));
  w.append(mk("span", "bd-nf-l", label), s);
  return w;
}
function chkField(key, label, on, onSet) {
  const w = mk("label", "bd-cf"), i = mk("input"); i.type = "checkbox"; i.checked = !!on; i.dataset.k = key;
  i.addEventListener("change", () => onSet(i.checked));
  w.append(i, mk("span", "", label));
  return w;
}
function pbtn(label, ic, onClick, opts = {}) {
  const b = mk("button", opts.icon ? "bd-ib" : "bd-btn"); b.type = "button";
  if (ic) b.innerHTML = icon(ic);
  if (!opts.icon) b.append(document.createTextNode(label)); else { b.setAttribute("aria-label", label); b.dataset.tip = label; }
  if (opts.pressed != null) b.setAttribute("aria-pressed", String(opts.pressed));
  if (opts.disabled) b.disabled = true;
  b.addEventListener("click", onClick);
  return b;
}
// geometry in the card's page (visual box, rot 90 aware); locked cards are not moved
const boxPoint = c => { const b = visBox(c), [rx, ry] = REF[ui.ref]; return [b.x + b.w * rx, b.y + b.h * ry]; };
function relXY(c) { const f = frameOf(c), [px, py] = boxPoint(c); return [px - (f ? f.x : 0), py - (f ? f.y : 0)]; }
function setCardPos(key, v) {
  let moved = 0;
  for (const c of selCards()) {
    if (isLocked(c)) continue;
    const f = frameOf(c), [px, py] = boxPoint(c);
    if (key === "x") c.x = r2(c.x + ((f ? f.x : 0) + r1(v) - px)); else c.y = r2(c.y + ((f ? f.y : 0) + r1(v) - py));
    moved++;
  }
  if (!moved) status("잠긴 카드는 옮길 수 없습니다.");
  commit();
}
function setCardSize(key, v) {
  v = clamp(v, 1, 5000);
  let n = 0;
  for (const c of selCards()) {
    if (isLocked(c) || c.scale?.locked || (c.kind === "stamp" && !isNorthStamp(c.stamp))) continue;   // scale-locked drawings and auto-sized bars keep their size
    const p0 = boxPoint(c);
    if (c.kind === "stamp") { const k = v / (key === "w" ? c.w : c.h); c.w = r2(c.w * k); c.h = r2(c.h * k); const p1 = boxPoint(c); c.x = r2(c.x + p0[0] - p1[0]); c.y = r2(c.y + p0[1] - p1[1]); n++; continue; }
    if (isMedia(c)) { const b = visBox(c), k = v / (key === "w" ? b.w : b.h); c.w = r2(c.w * k); c.h = r2(c.h * k); if (c.content) { c.content.dx = r2(c.content.dx * k); c.content.dy = r2(c.content.dy * k); } }   // drawings keep their aspect
    else if ((key === "w") !== quarter(c)) c.w = r2(v); else c.h = r2(v);
    const p1 = boxPoint(c);
    c.x = r2(c.x + p0[0] - p1[0]); c.y = r2(c.y + p0[1] - p1[1]);
    n++;
  }
  if (!n) status("잠긴 카드는 크기를 바꿀 수 없습니다.");
  commit();
}
const imgPx = new Map();
function srcPx(c) {
  if (imgPx.has(c.ref)) return imgPx.get(c.ref);
  imgPx.set(c.ref, null);
  const p = payloads.get(c.ref) || {}, href = c.kind === "diagram" ? p.preview : p.img;
  if (href) { const im = new Image(); im.onload = () => { imgPx.set(c.ref, [im.naturalWidth, im.naturalHeight]); scheduleProps(); ctxSig = ""; renderCtx(); schedulePreflight(); }; im.src = href; }
  return null;
}
const rowsFor = cols => (cols <= 3 ? 4 : cols === 4 ? 6 : cols === 12 ? 8 : cols === 6 ? 8 : 6);
function setPageCols(f, n) {
  n = Math.round(clamp(n, 0, 24));
  if (n < 1) { f.template = null; return; }
  if (f.template) f.template.cols = n;
  else { const b = makeTemplate("c6", f.size); f.template = { margin: b.margin, cols: n, rows: rowsFor(n), gutter: b.gutter }; }
}
function buildProps() {
  const work = ui.layout !== "print";
  const nodes = []; let sig = "";
  if (selGuide && S.guides.some(g => g.id === selGuide)) {
    const g = S.guides.find(x => x.id === selGuide), id = g.id, f = g.page ? frameById(g.page) : null;
    sig = `g|${id}|${g.axis}|${g.page || ""}`;
    nodes.push(psec("가이드", pnote(`${g.axis === "x" ? "세로" : "가로"} 가이드 · ${f ? pad2(f.page) + " 페이지 기준" : "대지 기준"}`),
      prow(numField("g", g.axis === "x" ? "X" : "Y", g.mm, v => { const q = S.guides.find(x => x.id === id); if (q) { q.mm = r1(clamp(v, -100000, 100000)); commit(); } })),
      prow(pbtn("삭제", "trash", () => deleteGuide(id)))));
    return { sig, nodes };
  }
  const cards = selCards();
  if (cards.length === 1) {
    const c = cards[0], f = frameOf(c), media = c.kind === "image" || c.kind === "diagram";
    const pxs = media && !work ? srcPx(c) : null;
    sig = `c|${ui.layout}|${c.id}|${c.kind}|${c.role || ""}|${c.align || ""}|${c.color || ""}|${c.locked}|${layerOf(c)}|${c.rot || 0}|${c.group || ""}|${f ? f.id : "-"}|${ui.ref}|${pxs ? pxs.join("x") : ""}|${c.scale ? c.scale.den + (c.scale.locked ? "L" : "") : ""}|${media ? cardDen(c, S.assets[c.ref]) : ""}|${c.stamp || ""}|${c.link || ""}|${c.link && cardById(c.link) ? 1 : 0}|${c.fit || ""}|${ppiInfo(c)?.text || ""}`;
    const [rx, ry] = relXY(c), b = visBox(c);
    const widget = mk("div", "bd-ref"); widget.setAttribute("role", "group"); widget.setAttribute("aria-label", "기준점");
    REF.forEach((_, i) => { const t = mk("button", "bd-refp"); t.type = "button"; t.setAttribute("aria-pressed", String(ui.ref === i)); t.setAttribute("aria-label", REF_NAME[i]); t.dataset.tip = "기준점: " + REF_NAME[i]; t.addEventListener("click", () => { ui.ref = i; renderProps(); }); widget.append(t); });
    const rotSel = selField("rot", "회전", [[0, "0°"], [90, "90°"]], quarter(c) ? 90 : 0, v => { const cs = selCards().filter(k => (k.kind === "image" || k.kind === "diagram") && !isLocked(k)); for (const k of cs) k.rot = Number(v); if (cs.length) commit(); });
    rotSel.querySelector("select").disabled = !media || isLocked(c);
    nodes.push(psec("위치·크기", pnote(f ? `${pad2(f.page)} 페이지 기준` : "대지 기준"),
      prow(widget, mk("div", "bd-xy", "")), null));
    const sec = nodes[0], xy = sec.querySelector(".bd-xy");
    xy.append(numField("x", "X", rx, v => setCardPos("x", v)), numField("y", "Y", ry, v => setCardPos("y", v)));
    const sizeOff = isLocked(c) || !!c.scale?.locked || (c.kind === "stamp" && !isNorthStamp(c.stamp));
    sec.append(prow(numField("w", "W", b.w, v => setCardSize("w", v), { disabled: sizeOff }), numField("h", "H", b.h, v => setCardSize("h", v), { disabled: sizeOff })),
      prow(rotSel, chkField("lock", "잠금", c.locked, on => { for (const k of selCards()) k.locked = on; commit(); })));
    if (c.kind === "memo") nodes.push(psec("메모 색", (() => { const r = mk("div", "bd-sw-row"); for (const col of MEMO_COLORS) { const t = mk("button", "bd-swatch"); t.type = "button"; t.style.background = col; t.setAttribute("aria-label", "메모 색 " + col); t.setAttribute("aria-pressed", String(c.color === col)); t.addEventListener("click", () => { for (const k of selCards()) if (k.kind === "memo") k.color = col; commit(); }); r.append(t); } return r; })()));
    if (media) nodes.push(scaleSection(c));
    if (c.kind === "stamp") nodes.push(stampSection(c));
    if (!work) {
      nodes.push(psec("레이어", selField("layer", "레이어", LAYERS.map(L => [L, LAYER_LABEL[L]]), layerOf(c), v => { if (!LAYERS.includes(v)) return; for (const k of selCards()) k.layer = v; for (const id of [...sel]) { const k = cardById(id); if (k && (layerHidden(k) || layerLocked(k))) sel.delete(id); } commit(); })));
      if (media) { const px = pxs, pi = ppiInfo(c); nodes.push(psec("이미지", pnote(S.assets[c.ref]?.title || ""), px ? pnote(`원본 ${px[0]} × ${px[1]} px`) : null, pi ? pnote(pi.vector ? "벡터 (해상도 무관)" : `유효 ${pi.text}`) : null,
        prow(pbtn("채우기", null, () => setContentMode("cover")), pbtn("맞추기", null, () => setContentMode("contain")), c.kind === "image" ? pbtn("1:1", null, () => setContentMode("native")) : null),
        c.kind === "image" ? prow(pbtn("내용 교체…", null, () => $("#bd-file-repl").click())) : null)); }
      if (c.kind === "text") {
        const al = (a, ic, t) => pbtn(t, ic, () => { for (const k of selCards()) if (k.kind === "text") k.align = a; commit(); }, { icon: true, pressed: (c.align || "left") === a });
        nodes.push(psec("글", selField("role", "스타일", ROLES.map(r => [r, ROLE_LABEL[r]]), c.role, v => { if (!ROLES.includes(v)) return; for (const k of selCards()) if (k.kind === "text") { k.role = v; delete k.size; } commit(); }),
          prow(al("left", "alignL", "왼쪽 맞춤"), al("center", "alignC", "가운데 맞춤"), al("right", "alignR", "오른쪽 맞춤"))));
      }
      if (c.group) nodes.push(psec("묶음", prow(pbtn("묶음 풀기", "ungroup", ungroupSel))));
    }
    return { sig, nodes };
  }
  if (cards.length > 1) {
    const grouped = cards.some(c => c.group), bs = cards.map(visBox);
    const same = bs.every(b => Math.abs(b.w - bs[0].w) < 0.05 && Math.abs(b.h - bs[0].h) < 0.05);
    sig = `m|${ui.layout}|${cards.map(c => c.id).join(",")}|${grouped}|${same}`;
    const ab = (act, ic, t, fn) => pbtn(t, ic, fn, { icon: true });
    nodes.push(psec(`${cards.length}개 선택`,
      prow(ab("l", "alignL", "왼쪽 정렬", () => alignSel("l")), ab("c", "alignC", "가운데 정렬", () => alignSel("c")), ab("r", "alignR", "오른쪽 정렬", () => alignSel("r")), ab("t", "alignT", "위 정렬", () => alignSel("t")), ab("m", "alignM", "중간 정렬", () => alignSel("m")), ab("b", "alignB", "아래 정렬", () => alignSel("b"))),
      prow(ab("dh", "distH", "가로 간격 같게", () => distribute("h")), ab("dv", "distV", "세로 간격 같게", () => distribute("v"))),
      prow(pbtn("묶기", "group", groupSel), grouped ? pbtn("풀기", "ungroup", ungroupSel) : null)));
    if (same) nodes.push(psec("크기", prow(numField("w", "W", bs[0].w, v => setCardSize("w", v)), numField("h", "H", bs[0].h, v => setCardSize("h", v)))));
    return { sig, nodes };
  }
  const f = selFrame ? frameById(selFrame) : null;
  if (f) {
    const fid = f.id;
    sig = `p|${ui.layout}|${fid}|${f.size}|${f.orientation}|${f.cartouche}|${f.template ? 1 : 0}|${f.page}`;
    const upd = fn => { const q = frameById(fid); if (q) { fn(q); commit(); } };
    nodes.push(psec("페이지", pnote(pageTitle(f)),
      prow(selField("size", "용지", SIZES.map(z => [z, z]), f.size, v => PAPER[v] && upd(q => setFrameSize(q, v))), selField("orient", "방향", [["portrait", "세로"], ["landscape", "가로"]], f.orientation, v => upd(q => { q.orientation = v === "portrait" ? "portrait" : "landscape"; })))));
    if (!work) {
      const t = f.template;
      nodes.push(psec("여백·단",
        prow(numField("margin", "여백", t ? t.margin : null, v => upd(q => { if (q.template) q.template.margin = clamp(v, 0, 100); }), { disabled: !t, ph: "—" }), numField("cols", "단 수", t ? t.cols : 0, v => upd(q => setPageCols(q, v)), { unit: "단" })),
        prow(numField("gutter", "간격", t ? t.gutter : null, v => upd(q => { if (q.template) q.template.gutter = clamp(v, 0, 50); }), { disabled: !t, ph: "—" })),
        prow(chkField("cart", "카르투슈", f.cartouche, on => upd(q => { q.cartouche = on; })))));
    }
    nodes.push(psec("페이지 작업", prow(pbtn("이 페이지 출력", "pageout", () => { const q = frameById(fid); if (q) chrome.exportFrames([q], "pdf"); })),
      prow(pbtn("복제", "copyframe", () => duplicateFrame(fid)), pbtn("삭제", "trash", () => deleteFrame(fid)))));
    return { sig, nodes };
  }
  sig = `b|${ui.layout}`;
  const m = (k, label, max) => txtField("meta-" + k, label, S.meta[k], max, v => { S.meta = { ...S.meta, [k]: v }; commit(); });
  nodes.push(psec("보드 정보", m("project", "프로젝트", 120), m("author", "이름", 80), m("atelier", "아틀리에", 80), m("teachers", "교수", 160), m("scale", "축척", 24), m("date", "날짜", 24)));
  const st = mk("div", "bd-stylelist");
  for (const r of ROLES) { const b = mk("button", "bd-stylerow"); b.type = "button"; const T = S.styles[r]; b.append(mk("span", "", ROLE_LABEL[r]), mk("span", "bd-muted", `${T.size} mm · ${T.weight}`)); b.addEventListener("click", () => chrome.openStyles()); st.append(b); }
  nodes.push(psec("글 스타일", st));
  return { sig, nodes };
}
function renderProps() {
  const box = $("#bd-props");
  if (!box) return;
  const { sig, nodes } = buildProps();
  if (box.dataset.sig === sig) {   // same structure: copy values into the live controls
    const live = new Map([...box.querySelectorAll("[data-k]")].map(n => [n.dataset.k, n]));
    for (const wrap of nodes) for (const n of wrap.querySelectorAll("[data-k]")) {
      const o = live.get(n.dataset.k);
      if (!o || o === document.activeElement) continue;
      if (o.type === "checkbox") o.checked = n.checked; else { o.value = n.value; o.defaultValue = n.value; }
      o.disabled = n.disabled;
    }
    return;
  }
  const fk = box.contains(document.activeElement) ? document.activeElement.dataset?.k : null;
  box.dataset.sig = sig;
  box.replaceChildren(...nodes);
  if (fk) { const n = box.querySelector(`[data-k="${fk}"]`); if (n) { n.focus(); n.select?.(); } }
}

// ---- custom tooltips: "이름 (키)" after 300 ms ----------------------------------------------------------------------------------------
function initTips() {
  const root = $("#board"), tip = $("#bd-tip");
  let timer = 0, cur = null;
  const hide = () => { clearTimeout(timer); cur = null; tip.hidden = true; };
  const show = t => {
    const txt = t.dataset.tip;
    if (!txt) return;
    tip.textContent = txt; tip.hidden = false;
    const r = t.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2, y = r.bottom + 6;
    if (t.closest(".bd-rail")) { x = r.right + 8; y = r.top + r.height / 2 - th / 2; }
    else if (y + th > innerHeight - 6) y = r.top - th - 6;
    tip.style.left = Math.round(clamp(x, 6, innerWidth - tw - 6)) + "px"; tip.style.top = Math.round(clamp(y, 6, innerHeight - th - 6)) + "px";
  };
  root.addEventListener("mouseover", e => {
    const t = e.target.closest?.("[data-tip],[title]");
    if (!t || t === cur) return;
    if (t.hasAttribute("title")) { if (!t.dataset.tip) t.dataset.tip = t.getAttribute("title"); t.removeAttribute("title"); }   // no native tooltip next to ours
    if (!t.dataset.tip) return;
    hide(); cur = t; timer = setTimeout(() => show(t), 300);
  });
  root.addEventListener("mouseout", e => { if (cur && !cur.contains(e.relatedTarget)) hide(); });
  root.addEventListener("pointerdown", hide, true);
  addEventListener("keydown", hide, true);
}

// ---- build 4a-1: scale lock (B17), content mode (B8), stamps (B15) ------------------------------------------------------------
function ppiInfo(c) {
  if (c.kind === "diagram") return { vector: true, cls: "vec", text: "벡터" };
  if (c.kind !== "image") return null;
  const px = srcPx(c);
  if (!px) return null;
  const w = contentRect(c, S.assets[c.ref]).w, p = Math.round(ppiOf(px[0], w)), cls = ppiClass(p);   // native px / (shown content width in inches)
  return { ppi: p, cls, text: cls === "low" ? `저해상도 ${p} ppi` : `${p} ppi` };
}
const isMedia = c => c && (c.kind === "image" || c.kind === "diagram");
function setContentMode(kind) {   // cover / contain / native (1:1 at 300 ppi)
  let n = 0;
  for (const c of selCards()) {
    if (!isMedia(c) || isLocked(c)) continue;
    if (c.scale?.locked) { status("축척이 고정된 카드는 내용 크기를 바꿀 수 없습니다."); continue; }
    const a = S.assets[c.ref], base = contentRect({ ...c, content: null }, a);
    let s = 1;
    if (kind === "cover") s = coverScale(c, a);
    else if (kind === "native") { const px = srcPx(c); if (!px) { status("원본 크기를 읽는 중입니다."); continue; } s = clamp((px[0] / 300 * 25.4) / base.w, 0.05, 50); }
    c.content = { dx: 0, dy: 0, s: r2(s) }; c.fit = kind === "cover" ? "fill" : kind === "contain" ? "fit" : "free"; n++;
  }
  if (n) commit();
}
function enterContent(id) {
  const c = cardById(id);
  if (!isMedia(c) || isLocked(c)) return;
  if (quarter(c)) { status("90° 회전한 카드는 내용 모드를 쓸 수 없습니다. 회전을 0°로 바꾸세요."); return; }
  contentEdit = id; sel = new Set([id]); selFrame = null;
  render();
  status("내용 모드 · 끌어서 이동, 모서리로 크기, ⌘+휠 확대, Esc로 나가기");
}
function exitContent() { if (!contentEdit) return; contentEdit = null; commit(); }
function contentPointerDown(e, wx, wy) {
  const c = cardById(contentEdit);
  if (!c) { contentEdit = null; return false; }
  const ch = e.target.closest("[data-chandle]"), ce = e.target.closest(".bd-card");
  try { $("#bd-svg").setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  if (ch) {
    if (c.scale?.locked) { status("축척이 고정된 카드는 내용 크기를 바꿀 수 없습니다."); return true; }
    drag = { type: "cscale", id: c.id, h: ch.dataset.chandle, cr: contentRect(c, S.assets[c.ref]), moved: false };
    return true;
  }
  if (ce && ce.dataset.id === c.id) { drag = { type: "cmove", id: c.id, start: [wx, wy], o: { ...(c.content || { dx: 0, dy: 0, s: 1 }) }, moved: false }; return true; }
  exitContent();   // click outside leaves content mode
  return false;
}
function contentDrag(e) {
  const d = drag, c = cardById(d.id);
  if (!c) return;
  if (!c.content) c.content = { dx: 0, dy: 0, s: 1 };   // created on the first real edit, so entering and leaving leaves no empty undo step
  const [wx, wy] = toWorld(e);
  d.moved = true;
  if (d.type === "cmove") { c.content.dx = clamp(r2(d.o.dx + wx - d.start[0]), -5000, 5000); c.content.dy = clamp(r2(d.o.dy + wy - d.start[1]), -5000, 5000); }
  else {   // corner: scale keeping the opposite corner and the aspect
    const cr = d.cr, west = d.h.includes("w"), north = d.h.includes("n"), px = wx - c.x, py = wy - c.y;
    const ax = west ? cr.x + cr.w : cr.x, ay = north ? cr.y + cr.h : cr.y;
    const s = clamp(Math.abs(px - ax) / cr.containW, 0.05, 50), w = cr.containW * s, h = w / cr.aspect;
    c.content = { s: r2(s), dx: r2((west ? ax - w : ax) - (c.w - w) / 2), dy: r2((north ? ay - h : ay) - (c.h - h) / 2) };
  }
  renderCards(); renderSel(); scheduleProps();
}
function contentWheel(e, f) {
  const c = cardById(contentEdit);
  if (!c) return;
  if (c.scale?.locked) { status("축척이 고정된 카드는 내용 크기를 바꿀 수 없습니다."); return; }
  if (!c.content) c.content = { dx: 0, dy: 0, s: 1 };
  const [wx, wy] = toWorld(e), px = wx - c.x, py = wy - c.y, a = S.assets[c.ref], r = contentRect(c, a);
  const s = clamp(c.content.s * f, 0.05, 50), w = r.containW * s, h = w / r.aspect, rx = (px - r.x) / r.w, ry = (py - r.y) / r.h;   // keep the point under the cursor fixed
  c.content = { s: r2(s), dx: r2(px - rx * w - (c.w - w) / 2), dy: r2(py - ry * h - (c.h - h) / 2) };
  renderCards(); renderSel(); scheduleProps();
  clearTimeout(wheelT); wheelT = setTimeout(() => commit(), 400);   // one undo step + autosave for a wheel gesture
}
let wheelT = 0;
function setCardScale(den) {
  den = Math.round(den);
  let n = 0;
  for (const c of selCards()) {
    if (!isMedia(c)) continue;
    if (c.scale?.locked) { status("축척 고정을 먼저 푸세요."); continue; }
    if (!(den >= 1)) { delete c.scale; n++; continue; }
    const a = S.assets[c.ref], mpm = Number(a?.meta?.mpm);
    if (c.kind === "diagram" && mpm > 0) {
      const target = widthForDen(mpm, den), cr = contentRect(c, a);
      const s = c.content ? target / cr.containW : 0;
      if (c.content && s >= 0.05 && s <= 50) {   // content mode in use: the frame stays, the content scale makes the printed scale exact
        const k = s / c.content.s;
        c.content = { s, dx: r2(c.content.dx * k), dy: r2(c.content.dy * k) };
      } else {   // resize the frame so the shown sheet width is exact, keeping the reference point
        const p0 = boxPoint(c), k = target / cr.containW;
        c.w = r2(c.w * k); c.h = r2(c.h * k);
        if (c.content) c.content = { s: 1, dx: 0, dy: 0 };
        const p1 = boxPoint(c); c.x = r2(c.x + p0[0] - p1[0]); c.y = r2(c.y + p0[1] - p1[1]);
      }
    }
    c.scale = { den, locked: false }; n++;
  }
  if (n) commit();
}
function toggleScaleLock(on) {
  let n = 0;
  for (const c of selCards()) {
    if (!isMedia(c)) continue;
    const d = cardDen(c, S.assets[c.ref]);
    if (on && !d) { status("축척을 먼저 고르세요."); continue; }
    c.scale = { den: d || 100, locked: !!on }; if (!on && !d) delete c.scale; n++;
  }
  commit();
}
function stdDenOpts(cur) { const l = [...STD_DENS]; if (cur && !l.includes(cur)) l.push(cur); l.sort((a, b) => a - b); return l.map(d => [d, "1:" + d]); }
function scaleSection(c) {
  const den = cardDen(c, S.assets[c.ref]);
  const sel_ = selField("scaleden", "축척", [[0, "없음"], ...stdDenOpts(den)], den || 0, v => setCardScale(Number(v)));
  return psec("축척", pnote(den ? `축척 1:${den}` : "축척 없음"), sel_, chkField("scalelock", "축척 고정", c.scale?.locked, on => toggleScaleLock(on)),
    den && c.kind === "diagram" ? pnote(`실제 폭 = ${fmt(realWidthM(c.w, den))} m`) : null);
}
function stampSection(c) {
  const L = c.link ? cardById(c.link) : null, north = isNorthStamp(c.stamp), bar = isBarStamp(c.stamp);
  const note = !c.link ? "자유 스탬프 · 축척을 직접 고릅니다" : !L ? "연결 끊김 · 마지막 축척 유지" : `연결: ${S.assets[L.ref]?.title || "카드"} (1:${c.den})`;
  const upd = fn => { for (const k of selCards()) if (k.kind === "stamp") fn(k); commit(); };
  const parts = [pnote(STAMP_LABEL[c.stamp]), pnote(note)];
  if (!north) { const f = selField("stden", "축척", stdDenOpts(c.den), c.den, v => upd(k => { k.den = Math.round(clamp(Number(v), 1, 1e6)); })); f.querySelector("select").disabled = !!L; parts.push(f); }
  if (bar) parts.push(prow(numField("len", "길이", c.len_m, v => upd(k => { k.len_m = clamp(v, 0.001, 1e7); k.len_auto = false; }), { unit: "m" }), pbtn("자동", null, () => upd(k => { k.len_auto = true; }))));
  if (north) parts.push(numField("angle", "각도", c.angle, v => upd(k => { k.angle = clamp(v, -360, 360); k.angleAuto = false; }), { unit: "°" }));
  if (c.link) parts.push(prow(pbtn("연결 해제", null, () => upd(k => { k.link = null; }))));
  return psec("축척·방위 스탬프", ...parts);
}
// stamp gallery (rail tool S): 6 live vector templates; click then click the canvas, or drag one onto the canvas
const STAMP_BOX = { north_arrow: [12, 18], north_circle: [18, 18], north_cross: [22, 22] };
function stampSample(k) {
  const o = { stamp: k, den: 100, len_m: 5, unit: "m", angle: 0, w: 12, h: 18 }, b = stampBox(o);
  if (b) { o.w = b.w; o.h = b.h; } else if (STAMP_BOX[k]) [o.w, o.h] = STAMP_BOX[k];
  return o;
}
const stampLinkCandidate = () => { const cs = selCards(); return cs.length === 1 && isMedia(cs[0]) && cardDen(cs[0], S.assets[cs[0].ref]) ? cs[0].id : null; };
function renderStampGallery() {
  const box = $("#bd-stamps");
  box.replaceChildren();
  const group = (title, keys) => {
    box.append(mk("p", "bd-stamp-h", title));
    const row = mk("div", "bd-stamp-row");
    for (const k of keys) {
      const b = mk("button", "bd-stamp-it"); b.type = "button"; b.draggable = true; b.dataset.stamp = k; b.setAttribute("aria-label", STAMP_LABEL[k]);
      const o = stampSample(k), sv = document.createElementNS(NS, "svg");
      sv.setAttribute("viewBox", `0 0 ${o.w} ${o.h}`); sv.setAttribute("class", "bd-stamp-prev"); sv.setAttribute("font-family", "Pretendard, Noto Sans KR, sans-serif");
      sv.style.aspectRatio = `${o.w} / ${o.h}`;
      sv.innerHTML = stampSvg(o, o.den);
      b.append(sv, mk("span", "", STAMP_LABEL[k]));
      row.append(b);
    }
    box.append(row);
  };
  group("축척 막대", ["bar_ticks", "bar_alt", "ratio"]);
  group("방위표", ["north_arrow", "north_circle", "north_cross"]);
  box.append(mk("p", "bd-stamp-n", stampLinkCandidate() ? "선택한 카드의 축척에 연결됩니다." : "도면 카드를 먼저 고르면 그 축척에 연결됩니다."));
}
function toggleStamps() {
  const box = $("#bd-stamps");
  if (!box.hidden) { box.hidden = true; return; }
  closeMenus(); renderStampGallery(); box.hidden = false;
}
function pickStamp(k) {
  ui.stampPick = { k, link: stampLinkCandidate() };
  $("#bd-stamps").hidden = true;
  setTool("s");
  status(`${STAMP_LABEL[k]}: 캔버스를 눌러 놓으세요 (Esc 취소)`);
}
function placeStamp(at) {
  const pk = ui.stampPick;
  ui.stampPick = null; setTool("v");
  if (!pk || !STAMPS.includes(pk.k)) return;
  const lc = pk.link ? cardById(pk.link) : null, d = lc ? cardDen(lc, S.assets[lc.ref]) : null, o = stampSample(pk.k);
  o.den = d || 100; o.len_m = niceLen(o.den);
  const na = lc ? S.assets[lc.ref]?.meta?.north_deg : null;
  if (isNorthStamp(pk.k) && na != null) o.angle = na;
  const b = stampBox(o); if (b) { o.w = b.w; o.h = b.h; }
  const c = addCard({ kind: "stamp", stamp: pk.k, den: o.den, link: d ? lc.id : null, angle: o.angle, len_m: o.len_m, unit: "m", len_auto: true, angleAuto: true, w: o.w, h: o.h, x: r2(at[0] - o.w / 2), y: r2(at[1] - o.h / 2), layer: "text" });
  sel = new Set([c.id]); selFrame = null;
  commit();
}

// ---- public API ----------------------------------------------------------------------------------------------------------
let migrated = false;
const loaded = (async () => {
  build();
  try {
    const rec = await idb.get("project");
    if (rec?.S) {
      const old = !(Number(rec.S.version) >= DOC_VERSION), info = {};
      if (old) {   // v1 / v2 autosave: keep a copy of the untouched record once, then migrate
        try { if (!(await idb.get("board-v2-backup"))) await idb.put("board-v2-backup", rec); } catch (e) { console.warn("board-v2-backup failed", e); }
      }
      S = sanitizeDoc(rec.S, info);   // v1 / v2 records are migrated here
      if (info.failed || info.dropped) console.warn(`board migration v${info.from} -> v${DOC_VERSION}: ${info.failed} card(s) kept on the pasteboard at default coordinates, ${info.dropped} card(s) dropped`);
      if (old) { dirty = true; migrated = true; }
      for (const [id, p] of Object.entries(rec.payloads || {})) if (S.assets[id]) payloads.set(id, cleanPayload(p));
      if (Number.isFinite(rec.savedAt)) { savedAt = rec.savedAt; saveState = "saved"; }
      setAutosave(true);
    } else { await idb.put("probe", 1); setAutosave(true); }
  } catch (e) { console.warn("IndexedDB unavailable", e); setAutosave(false); }
  hist = [snap()]; hi = 0; syncGeom();
  ui.panel = wideMQ.matches;
  if (migrated) scheduleSave();   // writes v3
  render();
})();

async function open() {
  await loaded;
  if (!isOpen) { prevMode = document.body.dataset.mode ?? null; isOpen = true; }
  if (!S.frames.length) {
    // the first frame is the baseline: put it into every history entry so undo can never remove it
    const f = addFrame();
    hist = hist.slice(0, hi + 1).map(h => { const o = JSON.parse(h); if (!o.frames.length) { o.frames = [{ ...f }]; o.seq = Math.max(o.seq, S.seq); } return JSON.stringify(o); });
    hist[hi] = snap();
    dirty = true; scheduleSave();
  }
  document.body.dataset.mode = "board";
  document.documentElement.classList.add("bd-open");
  $("#board").hidden = false;
  render();
  if (!fitted) requestAnimationFrame(() => { if (fitAll()) fitted = true; }); else applyView();
  $("#bd-svg").focus({ preventScroll: true });
}
function close() {
  if (!isOpen) return;
  finishEdit();
  chrome?.closeAll();
  closeMenus();
  isOpen = false; spaceDown = false;
  $("#board").hidden = true;
  document.documentElement.classList.remove("bd-open");
  if (prevMode) document.body.dataset.mode = prevMode; else delete document.body.dataset.mode;
  prevMode = null;
}
const cleanAssetMeta = m => {
  if (!m || typeof m !== "object") return null;
  const o = { address: String(m.address || "").slice(0, 200), radius: String(m.radius || "").slice(0, 40), palette: String(m.palette || "").slice(0, 40) };
  if (Number(m.mpm) > 0) o.mpm = num(m.mpm, 1, 0.0001, 1000);
  if (m.north_deg != null) o.north_deg = num(m.north_deg, 0, -360, 360);
  return o;
};
async function add(item) {
  await loaded;
  if (!item || !item.kind) throw new Error("보드에 넣을 항목이 올바르지 않습니다.");
  if (item.kind === "diagram") {
    const svgClean = cleanSvgString(item.svg), prev = safeImg(item.preview);
    if (!svgClean || !prev) throw new Error("다이어그램 데이터가 없습니다.");
    if (item.meta?.address || item.meta?.radius) S.site = { address: item.meta.address || "", radius: item.meta.radius || "" };
    const id = registerAsset("diagram", item.title || "다이어그램", item.w || 420, item.h || 297, { svg: svgClean, preview: prev }, cleanAssetMeta(item.meta));
    ui.emptyDismissed = true;
    commit();
    return id;
  }
  if (item.kind === "image") {
    if (!safeImg(item.img)) throw new Error("이미지 데이터가 없습니다.");
    const id = registerAsset("image", item.title || "이미지", item.w || 100, item.h || 70, { img: item.img }, item.meta || null);
    ui.emptyDismissed = true;
    commit();
    return id;
  }
  throw new Error("지원하지 않는 항목 종류입니다: " + item.kind);
}
const count = () => Object.keys(S.assets).length;

globalThis.atelierBoard = { add, open, close, count };
dispatchEvent(new CustomEvent("atelierBoard:ready"));
document.addEventListener("click", e => { if (e.target.closest("#start-board")) open(); });
