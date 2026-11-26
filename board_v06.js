import { t as _t, loadedPromise } from "./i18n.js?v=20261123g";
// Board mode of Atelier 4·2, v3 (InDesign-like layout): pin-up canvas + final panels (pages). Third mode of the site (body.dataset.mode = "board").
//   globalThis.atelierBoard = { add(item), open(), close(), count() }     event: atelierBoard:ready
// Screen = raster previews in an SVG world (mm units); export = vector SVG composed per page (board_v06_export.js).
// Document model, sanitizing and the v1 -> v2 migration (v1/v2 -> v3) live in board_v06_doc.js; dialogs in board_v06_chrome.js.
import { buildPdf } from "./dgpdf_v02.js?v=20261121a";
import { loadFontCss } from "./dgcore_v04.js?v=20261116p";
import {
  DOC_VERSION, PAPER, SIZES, ROLES, ROLE_LABEL, ROLE_BOX, MEMO_COLORS, GRID_DEFAULT, TEMPLATE_KEYS, TEMPLATE_LABEL, LAYERS, LAYER_LABEL, MAX_GUIDES,
  makeTemplate, templateKey, safeImg, num, r2, pad2, frameSize, orientLabel, pageLabel, pageTitle, gridCells as gridCells0, cartHeight, pageAt, assignPages, defaultLayer,
  FSTYLES, FSTYLE_LABEL,
  cardDen, widthForDen, realWidthM, niceLen, ppiOf, ppiClass, contentRect, coverScale, stampBox, stampSvg, STAMPS, STAMP_LABEL, stampLabel, isStampKey, STD_DENS, isNorthStamp, isBarStamp, isFigStamp, isPlanFig, clampHm,
  cleanSvgString, cleanPayload, sanitizeDoc, emptyDoc
} from "./board_v06_doc.js?v=20261123g";
import { FIGS, FIG_GROUPS, TREE_PRESETS, customKeys } from "./board_v06_figs.js?v=20261123g";
import * as X from "./board_v06_export.js?v=20261123g";
import { icon } from "./board_v06_icons.js?v=20261123g";
import { preflight, summarize, groupByPage, cardTitle, PRESET_KEYS } from "./board_v06_preflight.js?v=20261123g";
import { getLang, setLang, fmtDate, onLang } from "./i18n.js?v=20261123g";
import * as RC from "./board_v06_record.js?v=20261123g";
import * as PR from "./board_v06_parent.js?v=20261123g";
import { createChrome } from "./board_v06_chrome.js?v=20261123g";
await loadedPromise;   // the catalogs are ready before any module-level t() call

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
const tr = (ko, fr) => getLang() === "fr" ? fr : ko;

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
const ui = { tool: "v", panel: true, panelTab: "assets", filter: "all", q: "", minimap: false, stampPick: null, annoForce: null, dates: false, hideDrop: false, author: "나", penColor: "ink", layout: "work", emptyDismissed: false, preview: false, guidesHidden: false, guidesLocked: false, ref: 0, hint: false };
let contentEdit = null;          // card id in content mode (double-click an image)
let selGuide = null;             // selected user guide id (UI only)
let chrome = null;

const REC_today = () => RC.todayStr();
const parentHasCart = f => !!f.parent && !!PR.parentById(S, f.parent)?.items.some(i => i.kind === "cartouche");
const gridCells = f => gridCells0(f, f.cartouche || parentHasCart(f));   // the parent's cartouche strip stays out of the grid too
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
    if (b) {
      if (isFigStamp(st.stamp) && st.w > 0 && st.h > 0) {   // a figure keeps its feet (trees in plan: their centre) where they were when the scale or height changes
        st.x = r2(st.x + (st.w - b.w) / 2); st.y = r2(st.y + (isPlanFig(st.stamp) ? (st.h - b.h) / 2 : st.h - b.h));
      }
      st.w = b.w; st.h = b.h;
    }
  }
}
function commit() {
  if (cloudMod) cloudMod.pushCollabState(toolCtx());
  if (contentEdit) { const cc = cardById(contentEdit); if (!cc || quarter(cc)) contentEdit = null; }
  syncStamps();
  PR.pruneOverrides(S);
  if (!S.editParent) { const have = new Set(S.cards.map(z => z.id)); S.comments = S.comments.filter(m => have.has(m.card)); S.marks = S.marks.filter(m => !m.card || have.has(m.card)); S.arrows = S.arrows.filter(a => have.has(a.from) && have.has(a.to)); S.stacks = RC.cleanStacks(S.cards, S.stacks);
    for (const [sid, topId] of Object.entries(S.stacks)) { const t = cardById(topId); if (t) for (const c of S.cards) if (c.stack === sid && c !== t) { c.x = t.x; c.y = t.y; c.w = t.w; c.h = t.h; c.rot = t.rot || 0; } }   // members sit under the top card
  }
  const spreadMoved = S.spreadView && !S.editParent ? PR.layoutSpreads(S) : [];   // cards moved with their R page keep their membership
  for (const c of S.cards) {
    if (spreadMoved.includes(c.id)) continue;   // only cards whose own geometry changed are re-tested; moving/resizing/rotating a PAGE keeps its members
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
  contentEdit = null; gridIds = []; $("#bd-gridprompt").hidden = true; pinPopId = null; $("#bd-cpop").hidden = true; selArrow = null; selSection = null;
  syncGeom();
  sel = new Set([...sel].filter(id => cardById(id)));
  if (selFrame && !frameById(selFrame)) selFrame = null;
  if (selGuide && !S.guides.some(g => g.id === selGuide)) selGuide = null;
  dirty = true;
  scheduleSave();
  render();
}
const editFlag = i => hist[i] != null && hist[i].includes('"editParent":');
const crossesEdit = i => editFlag(i) !== !!S.editParent;   // entering / leaving a parent edit is not undoable (it would drop the stash)
const undo = () => { finishEdit(); if (hi > 0) { if (crossesEdit(hi - 1)) { status(_t('board.002')); return; } restore(hi - 1); } };
const redo = () => { finishEdit(); if (hi < hist.length - 1) { if (crossesEdit(hi + 1)) { status(_t('board.002')); return; } restore(hi + 1); } };

// ---- persistence: IndexedDB autosave -------------------------------------------------------------
const idb = {
  open: () => new Promise((res, rej) => {
    if (typeof indexedDB === "undefined") return rej(new Error(_t('board.003')));
    const r = indexedDB.open("atelier-board", 2);   // v2 adds the snapshots store; kv is kept
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv"); if (!d.objectStoreNames.contains("snapshots")) d.createObjectStore("snapshots", { keyPath: "id" }); };
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); status(_t('board.004')); }; res(d); };   // never fail silently when another tab wants the DB
    r.onerror = () => rej(r.error || new Error(_t('board.005')));
    r.onblocked = () => { status(_t('board.004')); rej(new Error(_t('board.006'))); };
  }),
  async get(key) {
    const db = await this.open();
    try { return await new Promise((res, rej) => { const q = db.transaction("kv").objectStore("kv").get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
    finally { db.close(); }
  },
  async allSnaps() { const db = await this.open(); try { return await new Promise((res, rej) => { const q = db.transaction("snapshots").objectStore("snapshots").getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); }); } finally { db.close(); } },
  async putSnap(rec) { const db = await this.open(); try { await new Promise((res, rej) => { const tx = db.transaction("snapshots", "readwrite"); tx.objectStore("snapshots").put(rec); tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error(_t('board.007'))); }); } finally { db.close(); } },
  async delSnap(id) { const db = await this.open(); try { await new Promise((res, rej) => { const tx = db.transaction("snapshots", "readwrite"); tx.objectStore("snapshots").delete(id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } finally { db.close(); } },
  async put(key, val) {
    const db = await this.open();
    try {
      await new Promise((res, rej) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(val, key);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error(_t('board.007')));
      });
    } finally { db.close(); }
  }
};
function renderSaveState() {
  const t = $("#bd-save-state");
  if (!t) return;
  const hh = d => pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  const full = saveState === "saving" ? _t('board.008') : saveState === "error" ? _t('board.009') : saveState === "saved" ? _t('board.010', { 0: hh(new Date(savedAt)) }) : "";
  const short = saveState === "saving" ? _t('board.011') : saveState === "error" ? _t('board.012') : saveState === "saved" ? _t('board.013') : "";
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
  const keep = RC.gcKeep(S, hist, snaps);   // current assets, undo history, snapshots
  for (const id of [...payloads.keys()]) if (!keep.has(id)) payloads.delete(id);
}
async function doSave() {
  savePending = false;
  saveState = "saving"; renderSaveState();
  try {
    gcPayloads();
    const pl = {};
    for (const id of new Set([...Object.keys(S.assets), ...RC.referencedAssetIds(snaps)])) if (payloads.has(id)) pl[id] = payloads.get(id);
    savedAt = Date.now();
    await idb.put("project", { S: PR.flattenEdit(S), payloads: pl, savedAt });
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
const flushSave = () => { syncEditText(); syncPin(); if (savePending) { clearTimeout(saveTimer); doSave(); } };
addEventListener("pagehide", flushSave);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSave(); });
addEventListener("beforeunload", e => {
  flushSave();
  if (!autosaveOK && dirty && (S.cards.length || Object.keys(S.assets).length)) { e.preventDefault(); e.returnValue = ""; }
});

// ---- model operations -----------------------------------------------------------------------------
let frameDefaults = { size: "A3", orientation: "landscape" };
function addFrame(opts = {}) {
  const f = { id: "f" + S.seq++, size: opts.size || frameDefaults.size, orientation: opts.orientation || frameDefaults.orientation, grid_mm: GRID_DEFAULT, x: 0, y: 0, n: 0, page: 0, parent: null, overrides: {}, spread: null, template: null, cartouche: false };
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
  const card = { kind: "text", x: 0, y: 0, w: 50, h: 20, rot: 0, crop: null, locked: false, group: null, page: null, created: REC_today(), status: "review", tags: [], ...c, id: "c" + S.seq++, z };
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
  if (S.editParent) { status(_t('board.014')); return null; }
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
  const c = addCard({ kind: "memo", role: "memo", text: _t('board.015'), color: MEMO_COLORS[S.cards.filter(k => k.kind === "memo").length % MEMO_COLORS.length], x: sp.x, y: sp.y, w: 60, h: 40 });
  sel = new Set([c.id]); selFrame = null;
  commit();
  startEdit(c.id);
}
function deleteSelection() {
  if (sel.size) {
    const del = new Set(selCards().filter(c => !isLocked(c)).map(c => c.id));
    if (!del.size) { status(_t('board.016')); return; }
    if (contentEdit && del.has(contentEdit)) contentEdit = null;
    S.cards = S.cards.filter(c => !del.has(c.id)); sel = new Set([...sel].filter(id => !del.has(id))); commit(); return;
  }
  if (selFrame) deleteFrame(selFrame);
}
function deleteFrame(id) {
  const f = frameById(id);
  if (!f) return;
  if (S.frames.length < 2) { status(_t('board.017')); return; }
  const n = S.cards.filter(c => frameOf(c) === f).length;
  if (n && !confirm(_t('board.018', { 0: n }))) return;
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
    const copy = addCard({ ...JSON.parse(JSON.stringify(c)), x: r2(c.x + 10), y: r2(c.y + 10), locked: false, stack: null, sg: undefined });
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
  g.template = f.template ? { ...f.template } : null; g.cartouche = f.cartouche; g.grid_mm = f.grid_mm; g.parent = f.parent || null;
  const dx = g.x - f.x, dy = g.y - f.y, gmap = new Map(), cmap = new Map(), smap = new Map();   // a copied page gets its own stacks
  for (const c of own) {
    const copy = addCard({ ...JSON.parse(JSON.stringify(c)), x: r2(c.x + dx), y: r2(c.y + dy), page: g.id, stack: c.stack ? (smap.get(c.stack) || (smap.set(c.stack, "st" + S.seq++), smap.get(c.stack))) : null });
    lastGeom.set(copy.id, geomKey(copy)); cmap.set(c.id, copy.id);
    if (c.group) { if (!gmap.has(c.group)) gmap.set(c.group, "g" + S.seq++); copy.group = gmap.get(c.group); }
  }
  for (const k of S.cards) if (k.kind === "stamp" && k.page === g.id && cmap.has(k.link)) k.link = cmap.get(k.link);
  for (const [old, nw] of smap) { const top = S.stacks[old]; if (cmap.has(top)) S.stacks[nw] = cmap.get(top); }
  g.overrides = {};   // the copies of override cards now belong to the new page
  for (const [item, cid] of Object.entries(f.overrides || {})) if (cmap.has(cid)) g.overrides[item] = cmap.get(cid);
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
  if (gs.size) for (const c of S.cards) if (gs.has(c.group) && !layerHidden(c) && !layerLocked(c) && !cardCollapsed(c)) ids.add(c.id);
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
  if (bs.length < 3) { status(_t('board.019')); return; }
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
  if (!cells) { status(_t('board.020')); return; }
  if (isLocked(c)) { status(_t('board.021')); return; }
  if (c.scale?.locked) { status(_t('board.022')); return; }
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
  const pdfs = [...files].filter(f => f.type === "application/pdf" || /\.pdf$/i.test(f.name || ""));
  if (pdfs.length) importPdf(pdfs[0]);
  const list = [...files].filter(f => f.type.startsWith("image/"));
  if (!list.length) { if (!pdfs.length) status(_t('board.023')); return; }
  let n = 0;
  const placed = [];
  for (const f of list) {
    try {
      const { dataUrl, w, h } = await downscale(f);
      const long = 120, mw = w >= h ? long : long * w / h, mh = w >= h ? long * h / w : long;
      const id = registerAsset("image", (f.name || _t('board.024')).replace(/\.[^.]+$/, ""), r2(mw), r2(mh), { img: dataUrl });
      const c = placeAsset(id, at ? [at[0] + n * 8, at[1] + n * 8] : null);
      if (c) { sel = new Set([c.id]); selFrame = null; placed.push(c.id); }
      n++;
    } catch (e) { console.error(e); status(_t('board.025', { 0: f.name })); }
  }
  if (n) commit();
  if (placed.length >= 4) offerGrid(placed);
}
// B13: 4+ images dropped at once onto a page with a template -> offer a grid
let gridIds = [];
function gridPlan(ids) {
  const cs = ids.map(cardById).filter(Boolean), f = cs.length ? frameOf(cs[0]) : null, cells = f && gridCells(f);
  if (!cells) return null;
  const n = cs.length, cols = n <= 4 ? 2 : 3, rows = Math.ceil(n / cols), gap = 4, aw = cells.x1 - cells.x0, ah = cells.y1 - cells.y0;
  return { f, cs, cols, rows, gap, cw: (aw - (cols - 1) * gap) / cols, ch: (ah - (rows - 1) * gap) / rows, x0: cells.x0, y0: cells.y0 };
}
function offerGrid(ids) {
  const pl = gridPlan(ids);
  if (!pl) return;
  gridIds = ids;
  $("#bd-gridtxt").textContent = _t('board.026', { 0: pl.cols, 1: pl.rows, 2: pl.gap });
  $("#bd-gridprompt").hidden = false;
}
function placeGrid() {
  const pl = gridPlan(gridIds);
  $("#bd-gridprompt").hidden = true;
  if (!pl) return;
  pl.cs.forEach((c, i) => {
    if (isLocked(c)) return;
    const col = i % pl.cols, row = Math.floor(i / pl.cols), a = c.w / c.h, w = Math.min(pl.cw, pl.ch * a), h = w / a;
    c.w = r2(w); c.h = r2(h);
    c.x = r2(pl.f.x + pl.x0 + col * (pl.cw + pl.gap) + (pl.cw - w) / 2); c.y = r2(pl.f.y + pl.y0 + row * (pl.ch + pl.gap) + (pl.ch - h) / 2);
    if (c.content) delete c.content;
  });
  commit();
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
  renderSel(); placeCtx(); scheduleMini(); scheduleRulers(); renderOverset(); renderSections(); renderAnnos(); renderArrows();
}
function zoomAt(factor, sx, sy) {
  const z = clamp(view.z * factor, 0.03, 20);
  const k = z / view.z;
  view.x = sx - (sx - view.x) * k; view.y = sy - (sy - view.y) * k; view.z = z;
  applyView();
}
function visibleInsets(r) {   // panels that float over the canvas (1024-1439 px, bottom sheet < 1024 px)
  const ins = { l: 0, r: 0, t: 0, b: 0 };
  for (const id of ["bd-panel", "bd-props"]) {
    const e = document.getElementById(id);
    if (!e || e.hidden || getComputedStyle(e).position !== "absolute") continue;
    const b = e.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) continue;
    if (b.width >= r.width * 0.9 && b.top > r.top + 20) ins.b = Math.max(ins.b, r.bottom - b.top);
    else if (b.left <= r.left + 2) ins.l = Math.max(ins.l, b.right - r.left);
    else if (b.right >= r.right - 2) ins.r = Math.max(ins.r, r.right - b.left);
  }
  return ins;
}
function fitBox(x0, y0, x1, y1, pad = 40) {
  const r = $("#bd-svg").getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const ins = visibleInsets(r), aw = Math.max(50, r.width - ins.l - ins.r), ah = Math.max(50, r.height - ins.t - ins.b);   // the part of the stage no panel covers
  const z = clamp(Math.min((aw - pad * 2) / (x1 - x0), (ah - pad * 2) / (y1 - y0)), 0.03, 20);
  view = { z, x: ins.l + (aw - (x1 - x0) * z) / 2 - x0 * z, y: ins.t + (ah - (y1 - y0) * z) / 2 - y0 * z };
  applyView();
  return true;
}
function fitAll() {
  const r = $("#bd-svg").getBoundingClientRect();
  if (!r.width || !r.height) return false;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of S.frames) { const [w, h] = frameSize(f); x0 = Math.min(x0, f.x); y0 = Math.min(y0, f.y - 12); x1 = Math.max(x1, f.x + w); y1 = Math.max(y1, f.y + h); }
  for (const c of S.cards) { const b = visBox(c); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  for (const z of S.sections) { x0 = Math.min(x0, z.x); y0 = Math.min(y0, z.y - 20); x1 = Math.max(x1, z.x + z.w); y1 = Math.max(y1, z.y + z.h); }
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
let layerArrows, layerSec, layerAnno, layerCardsBg, layerPI, layerOver, layerFrames, layerCards, layerUG, layerGuides, layerSel;
const showTpl = () => ui.layout === "print" && !ui.preview;
const showUG = () => ui.layout === "print" && !ui.preview && !ui.guidesHidden;

function renderFrames() {
  layerFrames.replaceChildren(); layerPI.replaceChildren();
  const fs = labelSize();
  for (const f of S.frames) {
    const [w, h] = frameSize(f);
    if (S.sections.some(z => z.collapsed && inSec(z, f.x + w / 2, f.y + h / 2))) continue;   // collapsed section: contents hidden, not deleted
    const g = el("g", { class: "bd-frame" + (f.id === selFrame ? " is-sel" : ""), "data-frame": f.id }, layerFrames);
    el("rect", { x: f.x, y: f.y, width: w, height: h, class: "bd-paper", filter: "url(#bd-shadow)" }, g);
    const cells = showTpl() ? gridCells(f) : null;
    if (cells && f.template) {   // margin rectangle + column / row boundaries as thin guide lines (no cell fills)
      const m = f.template.margin;
      let d = `M${m} ${m}H${w - m}V${h - m}H${m}Z`;
      for (const [a, b] of cells.xs) d += `M${r2(a)} ${r2(cells.y0)}V${r2(cells.y1)}M${r2(b)} ${r2(cells.y0)}V${r2(cells.y1)}`;
      let dr = "";
      for (const [a, b] of cells.ys) dr += `M${r2(cells.x0)} ${r2(a)}H${r2(cells.x1)}M${r2(cells.x0)} ${r2(b)}H${r2(cells.x1)}`;
      el("path", { class: "bd-tpl", d, transform: `translate(${f.x} ${f.y})`, "vector-effect": "non-scaling-stroke" }, g);
      el("path", { class: "bd-tpl bd-tpl-row", d: dr, transform: `translate(${f.x} ${f.y})`, "vector-effect": "non-scaling-stroke" }, g);   // row lines at 35 %: margins and columns stay the main guides
    }
    if (f.parent && !S.editParent) {   // parent items: not selectable here, drawn below the page's own cards
      const pg = el("g", { class: "bd-pitems", "font-family": "Pretendard, Noto Sans KR, sans-serif", transform: `translate(${f.x} ${f.y})` }, layerPI);
      pg.innerHTML = X.parentItemsSvg({ S, payloads }, f, { pdf: false, pageNo: f.page, total: S.frames.length });
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
    el("rect", { class: "bd-fsfill" }, g);
    const cs = el("svg", { class: "bd-clip", overflow: "hidden" }, g);   // frame = crop window for the content image
    const im = el("image", { preserveAspectRatio: "none", class: "bd-img" }, cs);
    el("rect", { class: "bd-fsline" }, g);
    const p = payloads.get(c.ref) || {};
    const href = c.kind === "diagram" ? p.preview : p.img;
    if (href) im.setAttribute("href", href);
  } else if (c.kind === "link") {
    el("rect", { class: "bd-hit bd-link-bg" }, g);
    el("text", { class: "bd-link-t" }, g); el("text", { class: "bd-link-h" }, g);
  } else if (c.kind === "stamp") {
    el("rect", { class: "bd-hit" }, g);
    el("g", { class: "bd-stamp", "font-family": "Pretendard, Noto Sans KR, sans-serif" }, g);
  } else {
    el("rect", { class: "bd-hit" }, g);
    el("rect", { class: "bd-ovl bd-ovlr" }, g);
    const fo = el("foreignObject", { class: "bd-fo" }, g);
    const d = document.createElement("div");
    d.className = "bd-text";
    fo.append(d);
    el("path", { class: "bd-lodbar" }, g);
  }
  el("circle", { class: "bd-sdot", cx: -8, cy: 8, r: 3.5 }, g);
  el("text", { class: "bd-stackbadge" }, g);
  el("text", { class: "bd-datetag" }, g);
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
  const stt = c.status || "review", dropHide = stt === "drop" && (ui.hideDrop || (ui.layout === "print" && !frameOf(c)));   // 버림: faded; hidden by the filter and, in 조판, outside pages
  g.style.opacity = stt === "drop" ? "0.35" : ui.layout === "print" && off ? "0.4" : "";   // 조판: dimmed
  g.style.display = layerHidden(c) || (ui.preview && off) || dropHide || cardCollapsed(c) || RC.stackHidden(S, c) ? "none" : "";
  const sb = g.querySelector(".bd-stackbadge"); if (sb) { const nst = c.stack ? S.cards.filter(k => k.stack === c.stack).length : 0; sb.textContent = nst > 1 ? String(nst) : ""; sb.style.transform = `translate(0px, 12px) scale(var(--inv, 1))`; }   // hidden layer / W preview / filters
  const dot = g.querySelector(".bd-sdot"), dt = g.querySelector(".bd-datetag");
  if (dot) { dot.style.transform = `translate(${c.w}px, 0px) scale(var(--inv, 1))`; dot.setAttribute("class", "bd-sdot is-" + stt); dot.style.display = ui.preview || ui.layout === "print" && !annoVisible() ? "none" : ""; }
  if (dt) { dt.style.transform = `translate(0px, -4px) scale(var(--inv, 1))`; dt.textContent = c.created ? fmtDate(c.created) : ""; dt.style.display = ui.dates && !ui.preview ? "" : "none"; }
  g.classList.toggle("is-layerlocked", layerLocked(c));
  g.querySelector(".bd-lockg").style.transform = `translate(${c.w}px, 0px) scale(var(--inv, 1))`;
  const hit = g.querySelector(".bd-hit");
  hit.setAttribute("width", c.w); hit.setAttribute("height", c.h);
  if (c.kind === "diagram" || c.kind === "image") {
    const im = g.querySelector(".bd-img"), cs = g.querySelector(".bd-clip"), cr = contentRect(c, S.assets[c.ref]);
    cs.setAttribute("width", c.w); cs.setAttribute("height", c.h);
    im.setAttribute("x", r2(cr.x)); im.setAttribute("y", r2(cr.y)); im.setAttribute("width", r2(cr.w)); im.setAttribute("height", r2(cr.h));
    const fsd = c.fstyle && S.fstyles?.[c.fstyle], fl = g.querySelector(".bd-fsfill");   // frame style (thin / box)
    if (fl) { fl.setAttribute("width", c.w); fl.setAttribute("height", c.h); fl.style.fill = fsd && c.fstyle === "box" ? "#fff" : "none"; const ln = g.querySelector(".bd-fsline"); ln.setAttribute("width", c.w); ln.setAttribute("height", c.h); ln.style.fill = "none"; ln.style.stroke = fsd && fsd.w > 0 ? PR.resolveColor(S, fsd.color) : "none"; ln.style.strokeWidth = fsd ? fsd.w : 0; }
    const p = payloads.get(c.ref) || {}, href = c.kind === "diagram" ? p.preview : p.img;   // also follows 내용 교체 and undo
    if (href && im.getAttribute("href") !== href) im.setAttribute("href", href);
  } else if (c.kind === "link") {
    const t = g.querySelector(".bd-link-t"), h = g.querySelector(".bd-link-h"), mc = Math.max(4, Math.floor((c.w - 6) / 2.2));
    t.setAttribute("x", 3); t.setAttribute("y", 7); t.setAttribute("font-size", 4.4); t.textContent = (c.title || "").slice(0, mc) + ((c.title || "").length > mc ? "…" : "");
    h.setAttribute("x", 3); h.setAttribute("y", c.h - 4); h.setAttribute("font-size", 3.2); h.textContent = RC.hostOf(c.url);
  } else if (c.kind === "stamp") {
    const sg = g.querySelector(".bd-stamp"), key = `${c.stamp}|${c.den}|${c.len_m}|${c.angle}|${c.w}|${c.h}|${c.unit}|${c.hm || ""}|${c.flip ? 1 : 0}|${c.tone || ""}|${c.fill ? 1 : 0}|${FIGS[c.stamp]?.v || 0}`;
    if (sg.dataset.k !== key) { sg.dataset.k = key; sg.innerHTML = stampSvg(c, c.den); }   // vector, numbers only
  } else {
    const ovl = g.querySelector(".bd-ovlr"); if (ovl) { ovl.setAttribute("width", c.w); ovl.setAttribute("height", c.h); ovl.style.display = c.from_parent && ui.layout === "print" ? "" : "none"; }
    const T = c.kind === "memo" ? { size: 5, weight: 400, color: "#1d1d1f", tracking: 0 } : PR.effectiveStyle(S, c), fo = g.querySelector(".bd-fo"), d = g.querySelector(".bd-text");
    fo.setAttribute("width", c.w); fo.setAttribute("height", c.h);
    if (c.kind === "memo") hit.style.fill = PR.resolveColor(S, c.color || MEMO_COLORS[0], MEMO_COLORS[0]);
    const size = num(T.size, 5, 1, 200), cols = c.cols > 1 ? c.cols : 1, inset = c.kind === "memo" ? 2 : num(c.inset, 0, 0, 50);
    d.style.cssText = `width:${c.w}px;height:${c.h}px;font-size:${size}px;font-weight:${T.weight};color:${T.color};text-align:${c.align || "left"};padding:${inset}px;letter-spacing:${num(T.tracking, 0, -5, 20)}px${cols > 1 ? `;column-count:${cols};column-gap:${num(c.gutter, 4, 0, 50)}px;column-fill:auto` : ""}`;
    const fr = frameOf(c), shown = editingId === c.id ? (c.text || "") : (fr ? PR.expandFields(c.text || "", { S, pageNo: fr.page, total: S.frames.length, den: PR.pageDen(S, fr, cardDen) }) : (c.text || ""));   // fields show raw while editing
    if (d.textContent !== shown && !(editingId === c.id)) d.textContent = shown;
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
  const sorted = sortedCards(), put = (box, list) => list.forEach((c, i) => {
    let g = els.get(c.id);
    if (!g) { g = makeCardEl(c); els.set(c.id, g); }
    updateCardEl(g, c);
    if (box.children[i] !== g) box.insertBefore(g, box.children[i] || null);
  });
  put(layerCardsBg, sorted.filter(c => layerOf(c) === "bg")); put(layerCards, sorted.filter(c => layerOf(c) !== "bg"));
  renderArrows();
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
const oversetCache = new Map();
const pfEnv = () => ({
  imgPx: c => srcPx(c),
  overset: c => { const d = els.get(c.id)?.querySelector(".bd-text"); if (d && d.clientHeight > 0) { const o = d.scrollHeight > d.clientHeight + 1 || d.scrollWidth > d.clientWidth + 1; oversetCache.set(c.id, o); return o; } return oversetCache.get(c.id) || false; }
});
function runPreflight() {
  pfList = isOpen && !S.editParent ? preflight(S, pfEnv()) : [];
  const sm = summarize(pfList), b = $("#bd-pf");
  if (!b) return;
  b.dataset.state = sm.errors ? "error" : sm.total ? "warn" : "ok";
  $("#bd-pf-t").textContent = sm.total ? String(sm.total) : _t('board.027');
  b.setAttribute("aria-label", _t('board.028', { 0: sm.text })); b.dataset.tip = sm.text;
  if (!$("#bd-pfpop").hidden) renderPfPop();
  renderOverset();
}
const schedulePreflight = () => { clearTimeout(pfTimer); pfTimer = setTimeout(runPreflight, 300); };
function renderPfPop() {
  const pop = $("#bd-pfpop");
  pop.replaceChildren();
  if (!pfList.length) { pop.append(mk("p", "bd-pf-ok", _t('board.029'))); return; }
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
  renderSections(); renderAnnos(); renderRecordSoon();
  renderFrames();
  renderArrows(); renderCards(); renderSel(); renderPanel(); renderProps(); renderCtx(); scheduleMini(); renderEmpty(); renderList(); renderChrome(); scheduleRulers();
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
  mm("minimap", ui.minimap ? _t('board.030') : _t('board.031'));
  mm("gh", ui.guidesHidden ? _t('board.032') : _t('board.033'));
  mm("gl", ui.guidesLocked ? _t('board.034') : _t('board.035'));
  mm("dates", ui.dates ? _t('board.036') : _t('board.037'));
  mm("annos", annoVisible() ? _t('board.038') : _t('board.039'));
  $("#bd-penbar").hidden = ui.tool !== "d";
  for (const b of document.querySelectorAll("#bd-penbar [data-pen]")) b.setAttribute("aria-pressed", String(b.dataset.pen === (ui.penColor || "ink")));
  $("#bd-stage").classList.toggle("has-rulers", rulersOn());
  const pb = $("#bd-pbanner"); pb.hidden = !S.editParent; if (S.editParent) $("#bd-pbanner-t").textContent = _t('board.040', { 0: S.editParent });
  $("#bd-pfwrap").hidden = ui.layout !== "print" || mobileMQ.matches;
  renderSaveState();
}
function setTool(t) {
  ui.tool = t;
  for (const b of document.querySelectorAll("#board [data-tool]")) b.setAttribute("aria-pressed", String(b.dataset.tool === t));
  $("#bd-svg").dataset.tool = t;
  const pb = $("#bd-penbar"); if (pb) pb.hidden = t !== "d";
}
function setLayout(m) {
  const was = ui.layout;
  ui.layout = m; ui.preview = false; ui.annoForce = null;
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
  if (PR.parentById(S, "A")) PR.applyParent(S, f, "A", true);   // start inside the parent-page system (the cartouche comes from the parent)
  selFrame = f.id; sel.clear();
  commit(); zoomToFrame(f);
}
function startPanelPreset(kind) {
  ui.emptyDismissed = true;
  const f = S.frames[0] || addFrame();
  if (kind === "a0jury") {
    f.parent = null;
    f.size = "A0"; f.orientation = "portrait"; f.template = makeTemplate("c3", "A0"); f.cartouche = true;
    selFrame = f.id; sel.clear(); commit(); zoomToFrame(f);
  } else if (kind === "a1mid") {
    f.parent = null;
    f.size = "A1"; f.orientation = "landscape"; f.template = makeTemplate("c4", "A1"); f.cartouche = true;
    selFrame = f.id; sel.clear(); commit(); zoomToFrame(f);
  } else if (kind === "a3pinup") {
    f.parent = null;
    f.size = "A3"; f.orientation = "landscape"; f.template = makeTemplate("c3", "A3"); f.cartouche = false;
    if (S.frames.length < 2) {
      const f2 = addFrame({ size: "A3", orientation: "landscape" });
      f2.parent = null;
      f2.template = makeTemplate("c3", "A3");
    }
    selFrame = f.id; sel.clear(); commit(); fitAll();
  }
}

// ---- left panel: 자료 / 페이지 ------------------------------------------------------------------------------
let assetSig = "", pageSig = "";
function renderPanel() {
  if (!ui.panel) return;
  for (const t of ["pages", "assets", "layers", "record"]) {
    $("#bd-tab-" + t).setAttribute("aria-selected", String(ui.panelTab === t));
    $("#bd-pane-" + t).hidden = ui.panelTab !== t;
  }
  if (ui.panelTab === "assets") renderAssets(); else if (ui.panelTab === "pages") { renderParents(); renderPages(); } else if (ui.panelTab === "layers") renderLayers(); else renderRecord();
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
    const name = mk("span", "bd-ly-n", LAYER_LABEL[L]); name.append(mk("small", "", _t('board.041', { 0: n[L] })));
    const eye = mk("button", "bd-ib"); eye.type = "button"; eye.dataset.ly = L; eye.dataset.what = "hidden"; eye.innerHTML = icon(st.hidden ? "eyeoff" : "eye");
    eye.setAttribute("aria-label", `${LAYER_LABEL[L]} ${st.hidden ? _t('board.042') : _t('board.043')}`); eye.setAttribute("aria-pressed", String(st.hidden)); eye.dataset.tip = st.hidden ? _t('board.042') : _t('board.043');
    const lk = mk("button", "bd-ib"); lk.type = "button"; lk.dataset.ly = L; lk.dataset.what = "locked"; lk.innerHTML = icon(st.locked ? "lock" : "unlock");
    lk.setAttribute("aria-label", `${LAYER_LABEL[L]} ${st.locked ? _t('board.044') : _t('board.045')}`); lk.setAttribute("aria-pressed", String(st.locked)); lk.dataset.tip = st.locked ? _t('board.044') : _t('board.045');
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
    if (nAll) box.append(mk("p", "bd-empty-note", _t('board.046')));
    return;
  }
  const order = ids;   // stable (insertion) order: only the badge changes when a card is placed
  for (const id of order) {
    const a = S.assets[id], p = payloads.get(id) || {}, n = used.get(id) || 0;
    const card = mk("div", "bd-asset"); card.draggable = true; card.dataset.asset = id;
    const th = mk("div", "bd-thumb");
    const pb = mk("button", "bd-thumbbtn"); pb.type = "button"; pb.dataset.place = id; pb.setAttribute("aria-label", _t('board.047', { 0: a.title }));
    const img = mk("img"); img.alt = ""; img.draggable = false; img.src = (a.kind === "diagram" ? p.preview : p.img) || "";
    pb.append(img); th.append(pb);
    if (n) th.append(mk("span", "bd-badge", _t('board.048', { 0: n })));
    const rm = mk("button", "bd-x"); rm.type = "button"; rm.dataset.removeAsset = id; rm.innerHTML = icon("close", 16);
    rm.setAttribute("aria-label", _t('board.049'));
    if (n) { rm.setAttribute("aria-disabled", "true"); rm.title = _t('board.050'); } else rm.title = _t('board.051');
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
  for (const c of sortedCards().filter(k => frameOf(k) === f && k.kind !== "memo" && !layerHidden(k) && !RC.stackHidden(S, k))) {
    const p = payloads.get(c.ref) || {}, href = c.kind === "diagram" ? p.preview : c.kind === "image" ? p.img : "";
    const b = visBox(c);
    if (href) { const im = el("image", { x: b.x - f.x, y: b.y - f.y, width: b.w, height: b.h, preserveAspectRatio: "none" }, s); im.setAttribute("href", href); }
    else el("rect", { x: c.x - f.x, y: c.y - f.y, width: c.w, height: Math.min(c.h, 6 + (c.size || 5)), fill: "#a1a1a6", opacity: ".7" }, s);
  }
  if (f.cartouche) { const m = f.template ? f.template.margin : 10, ch = cartHeight(f.size); el("rect", { x: m, y: H - m - ch, width: W - 2 * m, height: ch, fill: "none", stroke: "#1d1d1f", "stroke-width": Math.max(W, H) / 300 }, s); }
  return s;
}
function renderPages() {
  const sig = S.frames.map(f => [f.id, f.page, f.size, f.orientation, f.cartouche ? 1 : 0, f.parent || "", f.spread || "", f.template ? f.template.cols : 0, f.x, f.y, f.id === selFrame ? "s" : "",
    S.cards.filter(c => frameOf(c) === f).map(c => `${c.id},${c.x},${c.y},${c.w},${c.h},${c.rot},${layerOf(c)}`).join(";")].join(",")).join("|") + ui.layout + LAYERS.map(L => S.layers[L].hidden ? 1 : 0).join("");
  if (sig === pageSig) return;
  pageSig = sig;
  const box = $("#bd-page-list");
  box.replaceChildren();
  S.frames.forEach((f, i) => {
    const row = mk("div", "bd-pg" + (f.id === selFrame ? " is-sel" : "")); row.dataset.frame = f.id;
    const grip = mk("button", "bd-ib bd-grip"); grip.type = "button"; grip.innerHTML = icon("grip"); grip.setAttribute("aria-label", _t('board.052')); grip.title = _t('board.052');
    const main = mk("button", "bd-pg-main"); main.type = "button"; main.dataset.act = "pg-go";
    const th = mk("span", "bd-pg-thumb"); th.append(pageThumb(f));
    const t = mk("span", "bd-pg-t", `${pad2(f.page)} · ${f.size} ${orientLabel(f)}`);
    const n = S.cards.filter(c => frameOf(c) === f).length;
    t.append(mk("small", "", _t('board.057', { 0: n, 1: f.template ? _t('board.053', { 0: f.template.cols }) : "", 2: f.parent ? _t('board.054', { 0: f.parent }) : f.cartouche ? _t('board.055') : "", 3: f.spread ? _t('board.056', { 0: f.spread }) : "" })));
    main.append(th, t);
    const ud = mk("span", "bd-pg-ud");
    const up = mk("button", "bd-ib"); up.type = "button"; up.innerHTML = icon("up", 16); up.dataset.act = "pg-up"; up.setAttribute("aria-label", _t('board.058')); up.disabled = i === 0;
    const dn = mk("button", "bd-ib"); dn.type = "button"; dn.innerHTML = icon("down", 16); dn.dataset.act = "pg-down"; dn.setAttribute("aria-label", _t('board.059')); dn.disabled = i === S.frames.length - 1;
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
    if (layerHidden(c) || RC.stackHidden(S, c)) continue;
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
    acts.append(btn("▲", "frame-up", f.id, _t('board.060')), btn("▼", "frame-down", f.id, _t('board.061')), btn("PDF", "frame-pdf", f.id, _t('board.062')), btn("PNG", "frame-png", f.id, _t('board.063')));
    head.append(acts);
    sec.append(head);
    cards.forEach((c, ci) => sec.append(listRow(c, ci, cards.length, btn)));
    if (!cards.length) sec.append(mk("p", "bd-empty-note", _t('board.064')));
    box.append(sec);
  });
  if (loose.length) {
    const sec = mk("section", "bd-lframe");
    const h = mk("div", "bd-lhead"); h.append(mk("h3", "", _t('board.065'))); sec.append(h);
    loose.forEach((c, ci) => sec.append(listRow(c, ci, loose.length, btn)));
    box.append(sec);
  }
  const dr = mk("section", "bd-lframe");
  const dh = mk("div", "bd-lhead"); dh.append(mk("h3", "", _t('board.066')));
  dr.append(dh);
  const ids = Object.keys(S.assets);
  if (!ids.length) dr.append(mk("p", "bd-empty-note", _t('board.067')));
  for (const id of ids) {
    const a = S.assets[id], p = payloads.get(id) || {};
    const row = mk("div", "bd-lrow");
    const im = mk("img"); im.alt = ""; im.src = (a.kind === "diagram" ? p.preview : p.img) || "";
    row.append(im, mk("span", "bd-lt", a.title || id), btn(_t('board.068'), "place", id, _t('board.069')));
    dr.append(row);
  }
  box.append(dr);
}
function listRow(c, i, n, btn) {
  const row = mk("div", "bd-lrow");
  const label = c.kind === "memo" ? _t('board.015') : ROLE_LABEL[c.role] || _t('board.070');
  if (c.kind === "diagram" || c.kind === "image") {
    const p = payloads.get(c.ref) || {};
    const im = mk("img"); im.alt = ""; im.src = (c.kind === "diagram" ? p.preview : p.img) || "";
    row.append(im, mk("span", "bd-lt", S.assets[c.ref]?.title || c.kind));
  } else if (c.kind === "link") {
    row.append(mk("span", "bd-lk", _t('board.071')), mk("span", "bd-lt", c.title || c.url));
  } else if (c.kind === "stamp") {
    row.append(mk("span", "bd-lk", _t('board.072')), mk("span", "bd-lt", `${stampLabel(c.stamp)} · 1:${c.den}`));
  } else {
    const ta = mk("textarea", "bd-ltext");
    ta.value = c.text || ""; ta.dataset.lid = c.id; ta.rows = 2;
    ta.setAttribute("aria-label", label);
    if (c.locked || layerLocked(c)) { ta.readOnly = true; ta.title = _t('board.073'); }
    if (c.kind === "memo") ta.style.background = c.color || MEMO_COLORS[0];
    row.append(mk("span", "bd-lk", label), ta);
  }
  const b1 = btn("▲", "up", c.id, _t('board.074')), b2 = btn("▼", "down", c.id, _t('board.075')), b3 = btn("✕", "del", c.id, _t('board.076'));
  if (isLocked(c)) { b3.disabled = true; b3.title = _t('board.073'); }
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
  const lock = cb("lock", allLocked ? "lock" : "unlock", allLocked ? _t('board.044') : _t('board.077'), allLocked);
  if (cards.length === 1) {
    const c = cards[0];
    if (c.kind === "text") {
      const al = c.align || "left";
      return cs("t-style", _t('board.078'), ROLES.map(r => [r, ROLE_LABEL[r] + (PR.hasOverride(c) && r === c.role ? " +" : "")]), c.role) + cs("t-field", _t('board.079'), [["", _t('board.080')], ...PR.FIELDS.map(f => [f, PR.fieldToken(f)])], "") + cb("t-cycle", al === "left" ? "alignL" : al === "center" ? "alignC" : "alignR", _t('board.084', { 0: al === "left" ? _t('board.081') : al === "center" ? _t('board.082') : _t('board.083') })) + cb("del", "trash", _t('board.076'));
    }
    const media = c.kind === "image" || c.kind === "diagram";
    if (media) {   // 채우기 · 맞추기 · (칸 채우기) · PPI badge · 복제 · 삭제 · ⋯
      const pi = ppiInfo(c), badge = pi ? `<span class="bd-ppi is-${pi.cls}">${pi.text}</span>` : "";
      return cb("cover", "cover", _t('board.085')) + cb("contain", "contain", _t('board.086')) + (frameOf(c)?.template ? cb("fill", "fill", _t('board.087')) : "") + badge + cb("dup", "dup", _t('board.090')) + cb("del", "trash", _t('board.076')) + cb("more", "more", _t('board.088'));
    }
    return cb("more", "more", _t('board.089')) + cb("dup", "dup", _t('board.090')) + lock + cb("del", "trash", _t('board.076'));
  }
  const hasGroup = cards.some(c => c.group);
  const alignBtns = cb("al-l", "alignL", tr("왼쪽 정렬", "Aligner à gauche")) + cb("al-c", "alignC", tr("가로 가운데 정렬", "Centrer horizontalement")) + cb("al-r", "alignR", tr("오른쪽 정렬", "Aligner à droite"))
    + cb("al-t", "alignT", tr("위쪽 정렬", "Aligner en haut")) + cb("al-m", "alignM", tr("세로 가운데 정렬", "Centrer verticalement")) + cb("al-b", "alignB", tr("아래쪽 정렬", "Aligner en bas"));
  const distBtns = cards.length >= 3 ? cb("dist-h", "distH", tr("가로 균등 간격", "Répartir horizontalement")) + cb("dist-v", "distV", tr("세로 균등 간격", "Répartir verticalement")) : "";
  const grpBtn = hasGroup ? cb("ungrp", "ungroup", tr("그룹 해제", "Dissocier")) : cb("grp", "group", tr("그룹 묶기", "Grouper"));
  return alignBtns + distBtns + `<span class="bd-ctx-sep"></span>` + grpBtn + cb("dup", "dup", _t('board.090')) + lock + cb("del", "trash", _t('board.076'));
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
    case "more": { const m = $("#bd-ctxmenu"); m.hidden = !m.hidden; const lb = m.querySelector('[data-act="lw"]'); if (lb) { const c = selCards()[0]; lb.hidden = !(selCards().length === 1 && c?.kind === "diagram" && payloads.get(c.ref)?.svg); const eb = m.querySelector('[data-act="ent"]'); if (eb) eb.hidden = !(selCards().length === 1 && c?.kind === "image" && payloads.get(c.ref)?.img); } placeCtx(); break; }
    case "lw": { $("#bd-ctxmenu").hidden = true; const c = selCards()[0], sv = c && payloads.get(c.ref)?.svg; if (sv) openLineworkTool({ svgText: sv, name: S.assets[c.ref]?.title || "diagram" }); else status(_t("lw.err.nosvg")); break; }
    case "ent": { $("#bd-ctxmenu").hidden = true; const c = selCards()[0], im = c && payloads.get(c.ref)?.img; if (im) openEntourage({ tab: "sheet", imageUrl: im, name: S.assets[c.ref]?.title || "" }); break; }
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
    case "al-l": alignSel("l"); break;
    case "al-c": alignSel("c"); break;
    case "al-r": alignSel("r"); break;
    case "al-t": alignSel("t"); break;
    case "al-m": alignSel("m"); break;
    case "al-b": alignSel("b"); break;
    case "dist-h": distribute("h"); break;
    case "dist-v": distribute("v"); break;
    case "grp": groupSel(); break;
    case "ungrp": ungroupSel(); break;
  }
}
function ctxSelect(name, value) {
  if (name === "t-field") { insertField(value); return; }
  if (name === "t-style" && ROLES.includes(value)) { const c = selCards()[0]; if (c?.kind === "text") { c.role = value; commit(); } }
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
// Snap a moving page to the other pages: left / centre / right and top / middle / bottom lines,
// plus an equal gap to the nearest page on each side (like slide tools). Alt disables it.
function snapFrame(f, x, y, mate, tol) {
  const [w, h] = frameSize(f), others = [];
  for (const o of S.frames) if (o !== f && o !== mate) { const [ow, oh] = frameSize(o); others.push({ x: o.x, y: o.y, w: ow, h: oh }); }
  let bx = null, by = null;
  const pick = (cur, d, at, o) => (Math.abs(d) <= tol && (!cur || Math.abs(d) < Math.abs(cur.d))) ? { d, at, o } : cur;
  const ov = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > 0;
  for (const o of others) {
    for (const m of [x, x + w / 2, x + w]) for (const t of [o.x, o.x + o.w / 2, o.x + o.w]) bx = pick(bx, t - m, t, o);
    for (const m of [y, y + h / 2, y + h]) for (const t of [o.y, o.y + o.h / 2, o.y + o.h]) by = pick(by, t - m, t, o);
  }
  // equal gap: reuse the gap between two neighbouring pages in the same row / column
  const gapsX = [], gapsY = [];
  for (const a of others) for (const b of others) {
    if (a !== b && a.x + a.w <= b.x && ov(a.y, a.y + a.h, b.y, b.y + b.h)) gapsX.push(b.x - a.x - a.w);
    if (a !== b && a.y + a.h <= b.y && ov(a.x, a.x + a.w, b.x, b.x + b.w)) gapsY.push(b.y - a.y - a.h);
  }
  let gx = null, gy = null;
  for (const o of others) {
    if (ov(o.y, o.y + o.h, y, y + h)) for (const g of gapsX) {
      for (const want of [o.x + o.w + g, o.x - g - w]) { const d = want - x; if (Math.abs(d) <= tol && (!gx || Math.abs(d) < Math.abs(gx.d))) gx = { d, o, g, want }; }
    }
    if (ov(o.x, o.x + o.w, x, x + w)) for (const g of gapsY) {
      for (const want of [o.y + o.h + g, o.y - g - h]) { const d = want - y; if (Math.abs(d) <= tol && (!gy || Math.abs(d) < Math.abs(gy.d))) gy = { d, o, g, want }; }
    }
  }
  const guides = [];
  const dx = bx ? bx.d : gx ? gx.d : 0, dy = by ? by.d : gy ? gy.d : 0;
  const nx = x + dx, ny = y + dy;
  if (bx) guides.push({ x1: bx.at, x2: bx.at, y1: Math.min(ny, bx.o.y), y2: Math.max(ny + h, bx.o.y + bx.o.h) });
  else if (gx) { const o = gx.o, left = gx.want > o.x, a0 = left ? o.x + o.w : nx + w, a1 = left ? nx : o.x, mid = (Math.max(ny, o.y) + Math.min(ny + h, o.y + o.h)) / 2; guides.push({ x1: a0, x2: a1, y1: mid, y2: mid, label: `${Math.round(gx.g * 10) / 10}`, gap: true }); }
  if (by) guides.push({ y1: by.at, y2: by.at, x1: Math.min(nx, by.o.x), x2: Math.max(nx + w, by.o.x + by.o.w) });
  else if (gy) { const o = gy.o, below = gy.want > o.y, a0 = below ? o.y + o.h : ny + h, a1 = below ? ny : o.y, mid = (Math.max(nx, o.x) + Math.min(nx + w, o.x + o.w)) / 2; guides.push({ y1: a0, y2: a1, x1: mid, x2: mid, label: `${Math.round(gy.g * 10) / 10}`, gap: true }); }
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
function snapResize(o, h, px, py, movingId, tol, grid, gf, gl, aspect) {
  const west = h.includes("w"), north = h.includes("n");
  const hx = h.length === 2 || h === "e" || h === "w", hy = h.length === 2 || h === "n" || h === "s";
  const ax = west ? o.x + o.w : o.x, ay = north ? o.y + o.h : o.y;
  const others = [];
  for (const c of S.cards) if (c.id !== movingId && !layerHidden(c)) { const b = visBox(c); others.push({ x: b.x, y: b.y, w: b.w, h: b.h, card: true }); }
  const frames = S.frames.map(f => { const [w, hh] = frameSize(f); return { x: f.x, y: f.y, w, h: hh, card: false }; });

  // 1) Snap dragged edges to user guides, template cells, frame edges/centres, and other card edges/centres
  let bx = null, by = null;
  const better = (cur, d, t) => !cur || t < cur.t || (t === cur.t && Math.abs(d) < Math.abs(cur.d));
  if (hx) {
    if (gl) for (const gx of gl.xs) { const d = gx - px; if (Math.abs(d) <= tol && better(bx, d, 0)) bx = { d, at: gx, o: { x: gx, y: o.y - 8, w: 0, h: o.h + 16 }, t: 0 }; }
    const cells = gf && gridCells(gf);
    if (cells) for (const [a, b] of cells.xs) for (const e of [gf.x + a, gf.x + b]) { const d = e - px; if (Math.abs(d) <= tol && better(bx, d, 1)) bx = { d, at: e, o: { x: e, y: gf.y + cells.y0, w: 0, h: cells.y1 - cells.y0 }, t: 1 }; }
    for (const ob of [...others, ...frames]) for (const ox of [ob.x, ob.x + ob.w / 2, ob.x + ob.w]) { const d = ox - px; if (Math.abs(d) <= tol && better(bx, d, ob.card ? 2 : 3)) bx = { d, at: ox, o: ob, t: ob.card ? 2 : 3 }; }
  }
  if (hy) {
    if (gl) for (const gy of gl.ys) { const d = gy - py; if (Math.abs(d) <= tol && better(by, d, 0)) by = { d, at: gy, o: { x: o.x - 8, y: gy, w: o.w + 16, h: 0 }, t: 0 }; }
    const cells = gf && gridCells(gf);
    if (cells) for (const [a, b] of cells.ys) for (const e of [gf.y + a, gf.y + b]) { const d = e - py; if (Math.abs(d) <= tol && better(by, d, 1)) by = { d, at: e, o: { x: gf.x + cells.x0, y: e, w: cells.x1 - cells.x0, h: 0 }, t: 1 }; }
    for (const ob of [...others, ...frames]) for (const oy of [ob.y, ob.y + ob.h / 2, ob.y + ob.h]) { const d = oy - py; if (Math.abs(d) <= tol && better(by, d, ob.card ? 2 : 3)) by = { d, at: oy, o: ob, t: ob.card ? 2 : 3 }; }
  }

  // 2) Equal width / equal height snap against other cards (PPT / Canva style)
  let sw = null, sh = null;
  const rawW = hx ? Math.max(5, west ? ax - px : px - ax) : o.w;
  const rawH = hy ? Math.max(5, north ? ay - py : py - ay) : o.h;
  if (hx) for (const ob of others) { const d = ob.w - rawW; if (Math.abs(d) <= tol && (!sw || Math.abs(d) < Math.abs(sw.d))) sw = { d, val: ob.w, o: ob }; }
  if (hy) for (const ob of others) { const d = ob.h - rawH; if (Math.abs(d) <= tol && (!sh || Math.abs(d) < Math.abs(sh.d))) sh = { d, val: ob.h, o: ob }; }

  // Combine edge snap vs same-size snap (pick closer per axis; edge wins on tie)
  let sx = px, sy = py, usedX = null, usedY = null;
  if (hx) {
    if (bx && (!sw || Math.abs(bx.d) <= Math.abs(sw.d))) { sx = bx.at; usedX = { kind: "edge", hit: bx }; }
    else if (sw) { sx = west ? ax - sw.val : ax + sw.val; usedX = { kind: "same", hit: sw }; }
    else if (grid && gf && !gridCells(gf)) sx = gf.x + Math.round((px - gf.x) / grid) * grid;
  }
  if (hy) {
    if (by && (!sh || Math.abs(by.d) <= Math.abs(sh.d))) { sy = by.at; usedY = { kind: "edge", hit: by }; }
    else if (sh) { sy = north ? ay - sh.val : ay + sh.val; usedY = { kind: "same", hit: sh }; }
    else if (grid && gf && !gridCells(gf)) sy = gf.y + Math.round((py - gf.y) / grid) * grid;
  }

  let nw, nh;
  if (aspect) {
    const ar = o.w / o.h;
    const dxs = usedX ? Math.abs(sx - px) : Infinity, dys = usedY ? Math.abs(sy - py) : Infinity;
    const useX = hx && (!hy || dxs <= dys);
    if (useX) { nw = Math.max(5, west ? ax - sx : sx - ax); nh = nw / ar; usedY = null; }
    else { nh = Math.max(5, north ? ay - sy : sy - ay); nw = nh * ar; usedX = null; }
    if (nh < 5) { nh = 5; nw = nh * ar; }
    if (nw < 5) { nw = 5; nh = nw / ar; }
    // Even under aspect lock, if the derived dimension happens to match another card, show the equal-size guide
    if (!usedY) for (const ob of others) if (Math.abs(ob.h - nh) <= tol * 0.5) { usedY = { kind: "same", hit: { val: ob.h, o: ob } }; break; }
    if (!usedX) for (const ob of others) if (Math.abs(ob.w - nw) <= tol * 0.5) { usedX = { kind: "same", hit: { val: ob.w, o: ob } }; break; }
  } else {
    nw = hx ? Math.max(5, west ? ax - sx : sx - ax) : o.w;
    nh = hy ? Math.max(5, north ? ay - sy : sy - ay) : o.h;
  }

  const vx = west ? ax - nw : ax, vy = north ? ay - nh : ay;
  const guides = [];
  const off = 5 / view.z;
  if (usedX?.kind === "edge") {
    const ob = usedX.hit.o;
    guides.push({ x1: usedX.hit.at, x2: usedX.hit.at, y1: Math.min(vy, ob.y), y2: Math.max(vy + nh, ob.y + ob.h) });
  } else if (usedX?.kind === "same") {
    const ob = usedX.hit.o, lab = `= ${Math.round(nw * 10) / 10}`;
    guides.push({ x1: vx, x2: vx + nw, y1: vy - off, y2: vy - off, label: lab, same: true });
    guides.push({ x1: ob.x, x2: ob.x + ob.w, y1: ob.y - off, y2: ob.y - off, label: lab, same: true });
  }
  if (usedY?.kind === "edge") {
    const ob = usedY.hit.o;
    guides.push({ y1: usedY.hit.at, y2: usedY.hit.at, x1: Math.min(vx, ob.x), x2: Math.max(vx + nw, ob.x + ob.w) });
  } else if (usedY?.kind === "same") {
    const ob = usedY.hit.o, lab = `= ${Math.round(nh * 10) / 10}`;
    guides.push({ x1: vx + nw + off, x2: vx + nw + off, y1: vy, y2: vy + nh, label: lab, same: true });
    guides.push({ x1: ob.x + ob.w + off, x2: ob.x + ob.w + off, y1: ob.y, y2: ob.y + ob.h, label: lab, same: true });
  }
  return { vx, vy, nw, nh, guides };
}
function drawGuides(gs) {
  layerGuides.replaceChildren();
  const tick = 3.5 / view.z;
  for (const g of gs || []) {
    const cls = g.same ? "bd-smart is-same" : g.gap ? "bd-smart is-gap" : "bd-smart";
    el("line", { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, class: cls, "vector-effect": "non-scaling-stroke" }, layerGuides);
    if (g.same || g.gap) {
      const horiz = Math.abs(g.y1 - g.y2) < 1e-3;
      if (horiz) {
        el("line", { x1: g.x1, y1: g.y1 - tick, x2: g.x1, y2: g.y1 + tick, class: cls, "vector-effect": "non-scaling-stroke" }, layerGuides);
        el("line", { x1: g.x2, y1: g.y2 - tick, x2: g.x2, y2: g.y2 + tick, class: cls, "vector-effect": "non-scaling-stroke" }, layerGuides);
      } else {
        el("line", { x1: g.x1 - tick, y1: g.y1, x2: g.x1 + tick, y2: g.y1, class: cls, "vector-effect": "non-scaling-stroke" }, layerGuides);
        el("line", { x1: g.x2 - tick, y1: g.y2, x2: g.x2 + tick, y2: g.y2, class: cls, "vector-effect": "non-scaling-stroke" }, layerGuides);
      }
    }
    if (g.label) {
      const t = el("text", { x: (g.x1 + g.x2) / 2 + (g.x1 === g.x2 ? 4 / view.z : 0), y: (g.y1 + g.y2) / 2 - (g.y1 === g.y2 ? 3 / view.z : 0), "font-size": 11 / view.z, class: g.same ? "bd-gaplab is-same" : "bd-gaplab", "text-anchor": g.x1 === g.x2 ? "start" : "middle" }, layerGuides);
      t.textContent = g.label + " mm";
    }
  }
}

function placeByTool(at) {
  const t = ui.tool;
  setTool("v");
  if (t === "t") addText("body", at);
  else if (t === "n") addMemo(at);
  else if (t === "f") {
    if (S.editParent) { status(_t('board.091')); return; }
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
  { const lce = e.target.closest(".bd-card"), lc = lce && cardById(lce.dataset.id); if (lc && lc.kind === "link" && (e.metaKey || e.ctrlKey) && !e.shiftKey && ui.tool === "v") { e.preventDefault(); openLink(lc); return; } }
  if (ui.tool === "k" && e.button === 0) { e.preventDefault(); addLinkAt(wx, wy); return; }
  if (ui.tool === "l" && e.button === 0) {
    e.preventDefault();
    if (S.editParent) { status(_t('board.091')); return; }
    const ace = e.target.closest(".bd-card");
    if (ace && cardById(ace.dataset.id)) { cap(e.pointerId); const A = cardById(ace.dataset.id), cx = A.x + A.w / 2, cy = A.y + A.h / 2; drag = { type: "arrow", from: A.id, line: el("line", { x1: cx, y1: cy, x2: wx, y2: wy, class: "bd-arrow is-sel", "vector-effect": "non-scaling-stroke" }, layerGuides) }; }
    else status(_t('board.092'));
    return;
  }
  { const arEl = e.target.closest("[data-arrow]"); if (arEl) { e.preventDefault(); if (e.altKey) { S.arrows = S.arrows.filter(a => a.id !== arEl.dataset.arrow); commit(); } else { selArrow = arEl.dataset.arrow; sel.clear(); selFrame = null; renderArrows(); renderSel(); renderCtx(); renderProps(); renderChrome(); } return; } }
  if (ui.tool === "g" && e.button === 0 && !S.editParent) { e.preventDefault(); selSection = null; cap(e.pointerId); startSectionDrag(wx, wy); return; }
  if (ui.tool === "c" && e.button === 0) {
    e.preventDefault();
    const ce = e.target.closest(".bd-card"), cc = ce && cardById(ce.dataset.id);
    if (cc && (isLocked(cc) || S.editParent)) status(_t('board.093'));
    else if (cc) addComment(cc, wx, wy); else status(_t('board.094'));
    return;
  }
  if (ui.tool === "d" && e.pointerType === "touch") { startPan(e); return; }   // a finger pans, it does not move cards
  if (ui.tool === "d" && e.button === 0) {
    e.preventDefault();
    if (S.editParent) { status(_t('board.095')); return; }
    const pce = e.target.closest(".bd-card"), pcc = pce && cardById(pce.dataset.id);
    cap(e.pointerId); startPen(e, wx, wy, pcc && !isLocked(pcc) ? pce : null); return;
  }
  const pinEl = e.target.closest("[data-pin]"), markEl = e.target.closest("[data-mark]"), tabEl = e.target.closest("[data-sec-tab]"), rzEl = e.target.closest("[data-sec-rz]");
  if (pinEl) { e.preventDefault(); openPinPop(pinEl.dataset.pin); return; }
  if (markEl && e.altKey) { e.preventDefault(); S.marks = S.marks.filter(m => m.id !== markEl.dataset.mark); commit(); return; }
  if (rzEl) { const z = secById(rzEl.dataset.secRz); if (z) { selSection = z.id; sel.clear(); selFrame = null; drag = { type: "secresize", id: z.id, start: [wx, wy], o: { w: z.w, h: z.h } }; try { svg.setPointerCapture(e.pointerId); } catch { /* ignore */ } return; } }
  if (tabEl) { const z = secById(tabEl.dataset.secTab); if (z) { selSection = z.id; sel.clear(); selFrame = null; selGuide = null; drag = { type: "secmove", id: z.id, start: [wx, wy], last: [wx, wy], moved: false, cap: RC.captureSection(S, z.id) }; try { svg.setPointerCapture(e.pointerId); } catch { /* ignore */ } render(); return; } }
  if (e.metaKey && e.shiftKey && !S.editParent && ui.tool === "v") {   // override a parent item on this page
    const pf = frameAt(wx, wy);
    if (pf && pf.parent && (S.layers.text?.locked || S.layers.text?.hidden)) { status(_t('board.096')); return; }
    if (pf && pf.parent) { const lx = wx - pf.x, ly = wy - pf.y, hit = [...PR.itemsFor(S, pf)].reverse().find(i => (i.kind === "text" || i.kind === "stamp") && lx >= i.x && lx <= i.x + i.w && ly >= i.y && ly <= i.y + i.h); if (hit) { e.preventDefault(); makeOverride(pf, hit); return; } }
  }
  if (ui.tool === "s") { e.preventDefault(); placeStamp([wx, wy]); return; }
  if (ui.tool === "t" || ui.tool === "n" || ui.tool === "f") { e.preventDefault(); placeByTool([wx, wy]); return; }
  if (contentEdit && contentPointerDown(e, wx, wy)) return;
  const handle = e.target.closest("[data-handle]");
  const cardEl = e.target.closest(".bd-card");
  const guideEl = showUG() && !ui.guidesLocked ? e.target.closest("[data-guide]") : null;
  const flabel = e.target.closest("[data-frame-label]");
  const paperEl = ui.layout === "print" && !e.shiftKey && !guideEl && e.target.classList?.contains("bd-paper") ? e.target.closest("[data-frame]") : null;   // 조판: the page itself can be dragged
    selGuide = null; selSection = null; selArrow = null;
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
    if (e.altKey && !e.shiftKey) {
      // Alt + Drag: instant clone in place and drag the clones (Figma/Illustrator muscle memory)
      const src = selCards().filter(c => !isLocked(c));
      if (src.length) {
        const gmap = new Map(), cmap = new Map(), clones = [];
        for (const c of src) {
          const copy = addCard({ ...JSON.parse(JSON.stringify(c)), locked: false, stack: null, sg: undefined });
          if (c.group) { if (!gmap.has(c.group)) gmap.set(c.group, "g" + S.seq++); copy.group = gmap.get(c.group); }
          cmap.set(c.id, copy.id); clones.push(copy);
        }
        for (const k of clones) if (k.kind === "stamp" && cmap.has(k.link)) k.link = cmap.get(k.link);
        sel = new Set(clones.map(c => c.id));
        renderCards();
      }
    }
    const ids = new Set([...sel].filter(i => { const k = cardById(i); return k && !isLocked(k); }));   // locked cards stay put
    drag = { type: "move", start: [wx, wy], ids, orig: new Map([...ids].map(i => { const c = cardById(i); return [i, { x: c.x, y: c.y }]; })), moved: e.altKey && ids.size > 0 };
    renderSel(); renderCtx(); renderPanel(); renderProps(); renderChrome(); renderGuides();
  } else if (flabel || paperEl) {
    const f = frameById(flabel ? flabel.dataset.frameLabel : paperEl.dataset.frame);
    selFrame = f.id; sel.clear();
    const inside = S.cards.filter(c => frameOf(c) === f);   // members (centre inside the page) travel with the page
    const mate = PR.partnerOf(S, f), mf = mate ? { f: mate, o: { x: mate.x, y: mate.y }, cards: S.cards.filter(c => frameOf(c) === mate).map(c => ({ c, x: c.x, y: c.y })) } : null;   // a spread moves as a pair
    drag = { type: "frame", f, start: [wx, wy], o: { x: f.x, y: f.y }, cards: inside.map(c => ({ c, x: c.x, y: c.y })), mate: mf, moved: false };
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
  if (drag.type === "arrow") { const [wx, wy] = toWorld(e); drag.line.setAttribute("x2", wx); drag.line.setAttribute("y2", wy); return; }
  if (drag.type === "secnew") { const [wx, wy] = toWorld(e), d = drag; d.rect.setAttribute("x", Math.min(wx, d.start[0])); d.rect.setAttribute("y", Math.min(wy, d.start[1])); d.rect.setAttribute("width", Math.abs(wx - d.start[0])); d.rect.setAttribute("height", Math.abs(wy - d.start[1])); return; }
  if (drag.type === "secmove") { const [wx, wy] = toWorld(e), d = drag, dx = r2(wx - d.last[0]), dy = r2(wy - d.last[1]); if (!d.moved && Math.hypot(wx - d.start[0], wy - d.start[1]) * view.z < 3) return; d.moved = true; if (dx || dy) { RC.moveCaptured(S, d.cap, dx, dy); d.last = [d.last[0] + dx, d.last[1] + dy]; renderFrames(); renderCards(); renderSections(); renderAnnos(); renderSel(); scheduleMini(); } return; }
  if (drag.type === "secresize") { const [wx, wy] = toWorld(e), z = secById(drag.id); if (z) { z.w = r2(Math.max(40, drag.o.w + wx - drag.start[0])); z.h = r2(Math.max(40, drag.o.h + wy - drag.start[1])); renderSections(); } return; }
  if (drag.type === "pen") { const [wx, wy] = toWorld(e); penMove(wx, wy); return; }
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
    let vx, vy, nw, nh, rguides = [];
    if (!noSnap) {
      const s = snapResize(o, h, wx, wy, c.id, tol, gf?.grid_mm, gf, guideLines(gf), drag.aspect);
      vx = s.vx; vy = s.vy; nw = s.nw; nh = s.nh; rguides = s.guides;
    } else {
      const west = h.includes("w"), north = h.includes("n"), hx = h.length === 2 || h === "e" || h === "w", hy = h.length === 2 || h === "n" || h === "s";
      const ax = west ? o.x + o.w : o.x, ay = north ? o.y + o.h : o.y;
      if (drag.aspect) { const ar = o.w / o.h; nw = Math.max(5, west ? ax - wx : wx - ax); nh = nw / ar; if (nh < 5) { nh = 5; nw = nh * ar; } }
      else { nw = hx ? Math.max(5, west ? ax - wx : wx - ax) : o.w; nh = hy ? Math.max(5, north ? ay - wy : wy - ay) : o.h; }
      vx = west ? ax - nw : ax; vy = north ? ay - nh : ay;
    }
    drawGuides(rguides);
    if (quarter(c)) { c.w = r2(nh); c.h = r2(nw); c.x = r2(vx + nw / 2 - c.w / 2); c.y = r2(vy + nh / 2 - c.h / 2); }
    else { c.w = r2(nw); c.h = r2(nh); c.x = r2(vx); c.y = r2(vy); }
    renderCards(); renderSel(); scheduleMini(); scheduleProps();
  } else if (drag.type === "frame") {
    let dx = wx - drag.start[0], dy = wy - drag.start[1];
    drag.moved = true;
    let fg = [];
    if (!noSnap) { const s = snapFrame(drag.f, drag.o.x + dx, drag.o.y + dy, drag.mate?.f, tol); dx += s.dx; dy += s.dy; fg = s.guides; }
    drawGuides(fg);
    drag.f.x = r2(drag.o.x + dx); drag.f.y = r2(drag.o.y + dy);
    for (const k of drag.cards) { k.c.x = r2(k.x + dx); k.c.y = r2(k.y + dy); }
    if (drag.mate) { drag.mate.f.x = r2(drag.mate.o.x + dx); drag.mate.f.y = r2(drag.mate.o.y + dy); for (const k of drag.mate.cards) { k.c.x = r2(k.x + dx); k.c.y = r2(k.y + dy); } }
    renderFrames(); renderCards(); renderSel(); placeCtx(); scheduleMini(); scheduleProps(); scheduleRulers();
  } else if (drag.type === "marquee") {
    const x = Math.min(wx, drag.start[0]), y = Math.min(wy, drag.start[1]), w = Math.abs(wx - drag.start[0]), h = Math.abs(wy - drag.start[1]);
    drag.rect.setAttribute("x", x); drag.rect.setAttribute("y", y); drag.rect.setAttribute("width", w); drag.rect.setAttribute("height", h);
    sel = new Set(drag.base);
    for (const c of S.cards) { if (layerHidden(c) || layerLocked(c) || cardCollapsed(c) || dropGone(c)) continue; const b = visBox(c); if (b.x < x + w && b.x + b.w > x && b.y < y + h && b.y + b.h > y) sel.add(c.id); }
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
  if (d.type === "arrow") { d.line.remove(); const tgt = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".bd-card"); setTool("v"); if (tgt && tgt.dataset.id !== d.from && cardById(tgt.dataset.id)) addArrow(d.from, tgt.dataset.id); return; }
  if (d.type === "secnew") { d.rect.remove(); const x = parseFloat(d.rect.getAttribute("x")), y = parseFloat(d.rect.getAttribute("y")), w = parseFloat(d.rect.getAttribute("width")), h = parseFloat(d.rect.getAttribute("height")); setTool("v"); if (w >= 40 && h >= 40) { const z = addSection(x, y, w, h); if (z) { selSection = z.id; commit(); } } return; }
  if (d.type === "secmove") { if (d.moved) commit(); else render(); return; }
  if (d.type === "secresize") { commit(); return; }
  if (d.type === "pen") { finishPen(d); return; }
  if (d.type === "pan") { if (!d.moved && d.clear) { sel.clear(); selFrame = null; selGuide = null; renderFrames(); renderSel(); renderCtx(); renderPanel(); renderProps(); renderChrome(); } else placeCtx(); return; }
  if (d.type === "marquee") { d.rect.remove(); placeCtx(); renderProps(); renderChrome(); return; }
  if (d.type === "move" && !d.moved) { render(); return; }   // plain click: selection only
  if (d.type === "frame") for (const k of [...d.cards, ...(d.mate ? d.mate.cards : [])]) lastGeom.set(k.c.id, geomKey(k.c));   // members travelled with the page: no re-test
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
  d.textContent = c.text || "";   // raw text with field tokens while editing
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
    C(_t('board.097'), () => { if (S.editParent) { status(_t('board.091')); return; } const f = addFrame(); selFrame = f.id; sel.clear(); commit(); zoomToFrame(f); }, "F", _t('board.098')),
    C(_t('board.099'), () => addText("body"), "T", _t('board.100')),
    C(_t('board.101'), () => addText("title"), "", _t('board.102')),
    C(_t('board.103'), () => addMemo(), "N", _t('board.104')),
    C(_t('board.105'), () => $("#bd-file-img").click(), "I", _t('board.106')),
    C(_t('board.107'), () => chrome.openExport(), "", _t('board.108')),
    C(_t('board.109'), () => present(), "P", _t('board.110')),
    C(_t('board.111'), () => $("#bd-file-img").click(), "", _t('board.112')),
    C(_t('board.113'), () => promoteKept(secActive() ? selSection : null), "", _t('board.114')),
    C(_t('board.115'), () => setTool("k"), "K", _t('board.116')),
    C(_t('board.117'), () => setTool("l"), "L", _t('board.118')),
    C(_t('board.119'), makeStack, "", _t('board.120')),
    C(_t('board.121'), startSemester, "", _t('board.122')),
    C(_t('board.123'), addWeek, "", _t('board.124')),
    C(_t('board.125'), saveSnapshot, "", _t('board.126')),
    C(_t('board.127'), () => { ui.panel = true; ui.panelTab = "record"; renderChrome(); renderPanel(); $("#bd-rec-q").focus(); }, "", _t('board.128')),
    C(_t('board.129'), toggleAnno, "⇧C", _t('board.130')),
    C(_t('board.131'), () => { ui.dates = !ui.dates; render(); }, "", _t('board.132')),
    C(_t('board.133'), togglePreview, "W", _t('board.134')),
    C(_t('board.135'), () => { ui.guidesHidden = !ui.guidesHidden; render(); applyView(); }, "", _t('board.136')),
    C(_t('board.137'), () => { ui.guidesLocked = !ui.guidesLocked; render(); }, "", _t('board.138')),
    C(_t('board.139'), clearPageGuides, "", _t('board.140')),
    C(_t('board.141'), () => setLayout(ui.layout === "work" ? "print" : "work"), "⇧R", _t('board.142')),
    C(_t('board.143'), () => chrome.openInfo(), "", _t('board.144')),
    C(_t('board.078'), () => chrome.openStyles(), "", _t('board.145')),
    C(_t('board.146'), () => chrome.openShortcuts(), "?", _t('board.147')),
    C(_t('board.148'), () => { ui.panel = !ui.panel; render(); }, "", _t('board.149')),
    C(_t('board.150'), () => { ui.minimap = !ui.minimap; render(); scheduleMini(); }, "", _t('board.151')),
    C(_t('board.152'), fitAll, "⇧1", _t('board.153')),
    C(_t('board.154'), () => reorder(1, true), "", _t('board.155')), C(_t('board.156'), () => reorder(-1, true), "", _t('board.157')),
    C(_t('board.158'), undo, "⌘Z", "undo"), C(_t('board.159'), redo, "⌘⇧Z", "redo"),
    C(_t('board.160'), duplicate, "⌘D", _t('board.161')), C(_t('board.162'), deleteSelection, "Del", _t('board.163')),
    C(_t('board.164'), groupSel, "⌘G", _t('board.165')), C(_t('board.166'), ungroupSel, "⌘⇧G", _t('board.167')), C(_t('board.168'), toggleLock, "", _t('board.169')),
    C(_t('board.170'), rotate90, "", _t('board.171')), C(_t('board.087'), () => { const c = selCards()[0]; if (c) fillCells(c); }, "", _t('board.172')),
    C(_t("lw.menu"), () => $("#bd-file-lw").click(), "", "linework line weight hierarchy pen pdf svg trait 선 위계"),
        C(_t('board.173'), newBoard, "", _t('board.174')), C(_t('board.175'), saveFile, "", _t('board.176')), C(_t('board.177'), () => $("#bd-file-proj").click(), "", _t('board.178'))
  ];
  for (const [k, l] of [["l", _t('board.081')], ["c", _t('board.082')], ["r", _t('board.083')], ["t", _t('board.179')], ["m", _t('board.180')], ["b", _t('board.181')]]) list.push(C(_t('board.182', { 0: l }), () => alignSel(k), "", _t('board.183')));
  list.push(C(_t('board.184'), () => distribute("h"), "", _t('board.185')), C(_t('board.186'), () => distribute("v"), "", _t('board.185')));
  S.frames.forEach(f => list.push(C(_t('board.187', { 0: f.page, 1: f.size, 2: orientLabel(f) }), () => zoomToFrame(f), "", _t('board.188'))));
  return list;
}
function present() {
  const f = selectedFrame();
  chrome.present(f ? Math.max(0, S.frames.indexOf(f)) : 0);
}
function onKey(e) {
  if (!isOpen || chrome?.isBlocking() || document.querySelector(".lw-dlg")) return;   // the Linework dialog is modal: no board shortcuts behind it
  if (pdfClose) { if (e.key === "Escape") { e.preventDefault(); pdfClose(); } return; }   // the PDF picker is modal
  const t = e.target;
  const typing = t.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(t.tagName) && !/^(checkbox|radio|file|button)$/.test(t.type || ""));
  const onSelect = t.tagName === "SELECT", onButton = !!t.closest?.("button");
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (mod && k === "k") { e.preventDefault(); finishEdit(); chrome.openPalette(commands()); return; }
  if (e.key === " " && !typing && !onSelect && !onButton) { spaceDown = true; e.preventDefault(); return; }
  if (e.key === "Escape") {
    if (contentEdit && !typing) exitContent();
    else if (editingId) finishEdit();
    else if (pinPopId) closePinPop();
    else if (typing) t.blur();
    else if (!$("#bd-gpop").hidden) closeGuidePop();
    else if (closeMenus()) { /* closed a menu */ }
    else if (ui.preview) togglePreview();
    else if (ui.tool !== "v") setTool("v");
    else if (!$("#bd-gridprompt").hidden) { $("#bd-gridprompt").hidden = true; gridIds = []; }
    else if (S.editParent && !sel.size) exitEdit();
    else { selArrow = null; selSection = null; sel.clear(); selFrame = null; selGuide = null; renderSel(); renderArrows(); renderFrames(); renderCtx(); renderPanel(); renderProps(); renderChrome(); }
    return;
  }
  if (typing) return;
  if (onSelect && !mod) return;
  if (ui.preview && !(k === "w" || k === "p" || e.key === "?" || (mod && k === "k"))) return;   // W preview: no editing shortcuts
  if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === "y") { e.preventDefault(); redo(); return; }
  if (mod && k === "d") { e.preventDefault(); duplicate(); return; }
  if (mod && k === "g") { e.preventDefault(); e.shiftKey ? ungroupSel() : groupSel(); return; }
  if (mod && k === "a") { e.preventDefault(); sel = new Set(S.cards.filter(c => !layerHidden(c) && !layerLocked(c) && !cardCollapsed(c) && !dropGone(c)).map(c => c.id)); selFrame = null; selGuide = null; renderSel(); renderCtx(); renderProps(); renderChrome(); return; }
  if (mod) return;
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); if (selArrow && !sel.size) { S.arrows = S.arrows.filter(a => a.id !== selArrow); selArrow = null; commit(); } else if (secActive()) deleteSection(selSection); else if (selGuide) deleteGuide(selGuide); else deleteSelection(); return; }
  if (e.key === "Enter" && sel.size === 1 && !contentEdit) { const c = selCards()[0]; if (c && (c.kind === "image" || c.kind === "diagram")) { e.preventDefault(); enterContent(c.id); return; } }
  if (e.key === "]") { reorder(1); return; }
  if (e.key === "[") { reorder(-1); return; }
  if (e.key === "?") { chrome.openShortcuts(); return; }
  if (e.shiftKey && k === "c") { e.preventDefault(); toggleAnno(); return; }
  if (e.shiftKey && e.key === "R") { e.preventDefault(); setLayout(ui.layout === "work" ? "print" : "work"); return; }
  if (e.shiftKey && e.code === "Digit1") { e.preventDefault(); fitAll(); return; }
  if (!e.shiftKey && !e.altKey && !onButton || (onButton && /^[vhtfnipswgcdkl]$/.test(k))) {
    if (k === "v") { setTool("v"); return; }
    if (k === "h") { setTool("h"); return; }
    if (k === "t") { setTool("t"); return; }
    if (k === "f") { setTool("f"); return; }
    if (k === "n") { setTool("n"); return; }
    if (k === "i") { $("#bd-file-img").click(); return; }
    if (k === "s") { toggleStamps(); return; }
    if (k === "g") { setTool(ui.tool === "g" ? "v" : "g"); return; }
    if (k === "c") { setTool(ui.tool === "c" ? "v" : "c"); return; }
    if (k === "d") { setTool(ui.tool === "d" ? "v" : "d"); return; }
    if (k === "k") { setTool(ui.tool === "k" ? "v" : "k"); return; }
    if (k === "l") { setTool(ui.tool === "l" ? "v" : "l"); return; }
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
  if (!isOpen || chrome?.isBlocking() || ui.preview || pdfClose || document.querySelector(".lw-dlg")) return;
  const t = e.target;
  if (t.isContentEditable) return;   // text card editing has its own paste handler
  if (/^(INPUT|TEXTAREA)$/.test(t.tagName)) return;
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
  if (files.length) { e.preventDefault(); ui.emptyDismissed = true; addImageFiles(files, null); return; }
  const text = e.clipboardData?.getData("text/plain");
  if (text && text.trim() && !/\s/.test(text.trim()) && RC.cleanUrl(text.trim())) { e.preventDefault(); ui.emptyDismissed = true; addLink(text.trim(), null); return; }
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
    status(_t('board.189'));
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
    const FS = PR.flattenEdit(S);   // a parent being edited is written back first
    const project = {
      format: "atelier-project", version: DOC_VERSION, name: FS.name, seq: FS.seq,
      site: FS.site, meta: FS.meta, styles: FS.styles, layers: FS.layers, guides: FS.guides, export: FS.export, parents: FS.parents, sections: FS.sections, comments: FS.comments, marks: FS.marks, arrows: FS.arrows, stacks: FS.stacks, swatches: FS.swatches, fstyles: FS.fstyles, spreadView: FS.spreadView, diagrams, images, assets: S.assets,
      board: {
        frames: FS.frames.map(f => ({ id: f.id, size: f.size, orientation: f.orientation, grid_mm: f.grid_mm, x: f.x, y: f.y, n: f.n, page: f.page, template: f.template, cartouche: f.cartouche, parent: f.parent, overrides: f.overrides, spread: f.spread })),
        cards: FS.cards.map(c => ({ ...c }))
      }
    };
    files["project.json"] = [strToU8(JSON.stringify(project, null, 1)), { level: 6 }];
    const zip = zipSync(files);
    download(new Blob([zip], { type: "application/zip" }), `${safeName()}.atelier`);
    dirty = false;
    status(_t('board.190', { 0: (zip.length / 1048576).toFixed(1) }));
  } catch (e) { console.error(e); status(_t('board.191', { 0: e.message })); }
}
function resetCanvasState() {
  for (const [, g] of els) g.remove();
  els.clear();
  selArrow = null; selSection = null; pdfClose?.();
  sel.clear(); selFrame = null; selGuide = null; assetSig = ""; pageSig = ""; ctxSig = ""; ui.emptyDismissed = false; gridIds = []; $("#bd-gridprompt").hidden = true;
  $("#bd-layer-list").dataset.sig = ""; $("#bd-props").dataset.sig = "";
  hist = [snap()]; hi = 0; syncGeom();
}
async function openFile(file) {
  try {
    status(_t('board.192'));
    const { unzipSync, strFromU8 } = await import(FFLATE);
    const buf = await file.arrayBuffer();
    const z = unzipSync(new Uint8Array(buf));
    if (!z["project.json"]) throw new Error(_t('board.193'));
    const pj = JSON.parse(strFromU8(z["project.json"]));
    if (pj.format !== "atelier-project") throw new Error(_t('board.194'));
    if (!(num(pj.version, 1, 0, 1e6) <= DOC_VERSION)) throw new Error(_t('board.195'));
    if ((S.cards.length || Object.keys(S.assets).length) && !confirm(_t('board.196'))) { status(""); return; }
    const ver = Math.round(num(pj.version, 1, 0, 1e6));
    if (ver < DOC_VERSION) {   // old file: keep the untouched original bytes before migrating
      const base = (file.name || "atelier").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "-").trim() || "atelier";
      download(new Blob([buf], { type: "application/zip" }), `${base}.v${Math.max(1, ver)}.bak.atelier`);
    }
    const info = {};
    const next = sanitizeDoc({ ...pj, board: pj.board, assets: pj.assets, layers: pj.layers, guides: pj.guides ?? pj.board?.guides, parents: pj.parents, sections: pj.sections, comments: pj.comments, marks: pj.marks, arrows: pj.arrows, stacks: pj.stacks, swatches: pj.swatches, fstyles: pj.fstyles, spreadView: pj.spreadView, export: pj.export }, info);
    if (info.failed || info.dropped) console.warn(`board migration v${info.from} -> v${DOC_VERSION}: ${info.failed} card(s) kept on the pasteboard at default coordinates, ${info.dropped} card(s) dropped`);
    keepSnapPayloads();
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
    status(_t('board.198', { 0: S.cards.length, 1: ver < DOC_VERSION ? _t('board.197', { 0: Math.max(1, ver), 1: DOC_VERSION }) : "" }));
  } catch (e) { console.error(e); status(_t('board.199', { 0: e.message })); }
}
function newBoard() {
  if ((S.cards.length || Object.keys(S.assets).length) && !confirm(_t('board.200'))) return;
  S = emptyDoc(); keepSnapPayloads(); ensureFrame(); resetCanvasState();
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
const tools = () => [["v", "select", _t('board.201'), "V"], ["h", "hand", _t('board.202'), "H"], ["t", "text", _t('board.070'), "T"], ["f", "frame", _t('board.203'), "F"], ["n", "note", _t('board.015'), "N"], ["i", "image", _t('board.204'), "I"], ["s", "stampbar", _t('board.205'), "S"], ["g", "section", _t('board.206'), "G"], ["c", "comment", _t('board.207'), "C"], ["d", "pen", _t('board.208'), "D"], ["k", "link", _t('board.071'), "K"], ["l", "arrow", _t('board.209'), "L"]];

function build() {
  const sec = document.createElement("section");
  sec.id = "board"; sec.hidden = true;
  sec.setAttribute("aria-label", _t('board.210'));
  sec.innerHTML = `
    <header class="bd-bar">
      <div class="bd-bl">
        <button id="bd-panel-toggle" class="bd-ib" type="button" aria-pressed="true" data-tip="${_t("board.211")}" aria-label="${_t("board.148")}" data-i18n-attr="data-tip:board.211;aria-label:board.148">${icon("panel")}</button>
        <nav class="bd-tabs" aria-label="${_t("board.212")}" data-i18n-attr="aria-label:board.212">
          <button type="button" data-mode="terrain" data-i18n="board.213">${_t("board.213")}</button>
          <button type="button" data-mode="diagrams" data-i18n="board.214">${_t("board.214")}</button>
          <button type="button" data-mode="board" aria-current="page" data-i18n="board.210">${_t("board.210")}</button>
        </nav>
        <div class="bd-namewrap bd-menu-wrap">
          <input id="bd-name" class="bd-name" type="text" aria-label="${_t("board.215")}" maxlength="80" data-i18n-attr="aria-label:board.215">
          <button id="bd-name-menu" class="bd-ib" type="button" aria-haspopup="true" aria-expanded="false" aria-label="${_t("board.216")}" data-tip="${_t("board.216")}" data-i18n-attr="aria-label:board.216;data-tip:board.216">${icon("chevron")}</button>
          <div id="bd-name-pop" class="bd-menu" hidden>
            <button type="button" data-m="new" data-i18n="board.173">${_t("board.173")}</button>
            <button type="button" data-m="open" data-i18n="board.177">${_t("board.177")}</button>
            <button type="button" data-m="save" data-i18n="board.217">${_t("board.217")}</button>
            <button type="button" data-m="img" data-i18n="board.105">${_t("board.105")}</button>
            <button type="button" data-m="ent" data-i18n="ent.menu">${_t("ent.menu")}</button>
          </div>
        </div>
        <span id="bd-save-state" class="bd-savestate" role="status" aria-live="polite"></span>
      </div>
      <div class="bd-bc">
        <div class="bd-seg bd-hide-m" role="group" aria-label="${_t("board.218")}" data-i18n-attr="aria-label:board.218">
          <button type="button" data-layout="work" aria-pressed="true" data-tip="${_t("board.219")}" data-i18n="board.220" data-i18n-attr="data-tip:board.219">${_t("board.220")}</button>
          <button type="button" data-layout="print" aria-pressed="false" data-tip="${_t("board.221")}" data-i18n="board.222" data-i18n-attr="data-tip:board.221">${_t("board.222")}</button>
        </div>
      </div>
      <div class="bd-br">
        <div class="bd-menu-wrap bd-hide-m" id="bd-pfwrap" hidden>
          <button id="bd-pf" class="bd-btn bd-pf" type="button" aria-haspopup="true" aria-expanded="false" aria-label="${_t("board.223")}" data-i18n-attr="aria-label:board.223"><span class="bd-pf-ic"></span><span id="bd-pf-t" data-i18n="board.027">${_t("board.027")}</span></button>
          <div id="bd-pfpop" class="bd-menu bd-menu-r bd-pfpop" hidden></div>
        </div>
        <div class="bd-menu-wrap bd-hide-m">
          <button id="bd-tools" class="bd-btn" type="button" aria-haspopup="true" aria-expanded="false">${tr("도구 ▾", "Outils ▾")}</button>
          <div id="bd-tools-pop" class="bd-menu bd-menu-r" hidden>
            <button type="button" data-m="pdf" data-i18n="board.111">${_t("board.111")}</button>
            <button type="button" data-m="lw" data-i18n="lw.menu">${_t("lw.menu")}</button>
            <button type="button" data-m="ent" data-i18n="ent.menu">${_t("ent.menu")}</button>
            <button type="button" data-m="photo">${tr("모형 사진 정리", "Retouche photo maquette")}</button>
            <button type="button" data-m="axo">${tr("평면 → 분해 액소", "Plan → Axo éclatée")}</button>
            <span class="bd-msep" role="separator"></span>
            <button type="button" data-m="cloud">${tr("Drive 프로젝트 저장 · 열기", "Enregistrer / ouvrir sur Drive")}</button>
            <button type="button" data-m="collab">${tr("실시간 같이 편집 (Beta)", "Édition collaborative (Beta)")}</button>
          </div>
        </div>
        <button id="bd-undo" class="bd-ib bd-hide-m" type="button" aria-label="${_t("board.158")}" data-tip="${_t("board.224")}" data-i18n-attr="aria-label:board.158;data-tip:board.224">${icon("undo")}</button>
        <button id="bd-redo" class="bd-ib bd-hide-m" type="button" aria-label="${_t("board.159")}" data-tip="${_t("board.225")}" data-i18n-attr="aria-label:board.159;data-tip:board.225">${icon("redo")}</button>
        <button id="bd-export" class="bd-primary" type="button" data-i18n="board.226">${_t("board.226")}</button>
        <div class="bd-menu-wrap">
          <button id="bd-more" class="bd-ib" type="button" aria-haspopup="true" aria-expanded="false" aria-label="${_t("board.088")}" data-tip="${_t("board.088")}" data-i18n-attr="aria-label:board.088;data-tip:board.088">${icon("more")}</button>
          <div id="bd-more-pop" class="bd-menu bd-menu-r" hidden>
            <button type="button" data-m="present" data-i18n-html="board.227">${_t("board.227")}</button>
            <button type="button" data-m="minimap" data-i18n="board.031">${_t("board.031")}</button>
            <button type="button" data-m="shortcuts" data-i18n-html="board.228">${_t("board.228")}</button>
            <button type="button" data-m="info" data-i18n="board.229">${_t("board.229")}</button>
            <button type="button" data-m="styles" data-i18n="board.078">${_t("board.078")}</button>
            <button type="button" data-m="palette" data-i18n-html="board.230">${_t("board.230")}</button>
            <span class="bd-msep" role="separator"></span>
            <button type="button" data-m="lang">Langue / 언어<kbd>FR · KO</kbd></button>
            <button type="button" data-m="dates" data-i18n="board.037">${_t("board.037")}</button>
            <button type="button" data-m="annos" data-i18n-html="board.231">${_t("board.231")}</button>
            <button type="button" data-m="snap" data-i18n="board.125">${_t("board.125")}</button>
            <button type="button" data-m="week" data-i18n="board.123">${_t("board.123")}</button>
            <button type="button" data-m="promote" data-i18n="board.232">${_t("board.232")}</button>
            <span class="bd-msep" role="separator"></span>
            <button type="button" data-m="gh" data-i18n="board.033">${_t("board.033")}</button>
            <button type="button" data-m="gl" data-i18n="board.035">${_t("board.035")}</button>
            <button type="button" data-m="gc" data-i18n="board.139">${_t("board.139")}</button>
          </div>
        </div>
      </div>
    </header>
    <div id="bd-banner" class="bd-banner" role="alert" hidden data-i18n="board.233">${_t("board.233")}</div>
    <div class="bd-main">
      <nav class="bd-rail" aria-label="${_t("board.234")}" data-i18n-attr="aria-label:board.234">
        ${tools().map(([k, ic, name, key]) => `<button class="bd-ib" type="button" data-tool="${k}" data-tip="${name} (${key})" aria-label="${name} (${key})" aria-pressed="${k === "v"}">${icon(ic)}</button>`).join("")}
      </nav>
      <aside id="bd-panel" class="bd-panel" aria-label="${_t("board.235")}" data-i18n-attr="aria-label:board.235">
        <div class="bd-ptabs" role="tablist" aria-label="${_t("board.236")}" data-i18n-attr="aria-label:board.236">
          <button id="bd-tab-pages" type="button" role="tab" aria-selected="false" aria-controls="bd-pane-pages" data-i18n="board.237">${_t("board.237")}</button>
          <button id="bd-tab-assets" type="button" role="tab" aria-selected="true" aria-controls="bd-pane-assets" data-i18n="board.066">${_t("board.066")}</button>
          <button id="bd-tab-layers" type="button" role="tab" aria-selected="false" aria-controls="bd-pane-layers" data-i18n="board.238">${_t("board.238")}</button>
          <button id="bd-tab-record" type="button" role="tab" aria-selected="false" aria-controls="bd-pane-record" data-i18n="board.239">${_t("board.239")}</button>
        </div>
        <div id="bd-pane-pages" class="bd-pane" role="tabpanel" aria-labelledby="bd-tab-pages" hidden>
          <section class="bd-parents"><h3 class="bd-sec-h" data-i18n="board.240">${_t("board.240")}</h3><div id="bd-parent-list" class="bd-parent-list"></div>
            <button id="bd-add-parent" class="bd-btn" type="button" data-i18n="board.241">${_t("board.241")}</button></section>
          <label class="bd-cf bd-spread"><input id="bd-spread-toggle" type="checkbox" aria-pressed="false"><span data-i18n="board.242">${_t("board.242")}</span></label>
          <div id="bd-page-list" class="bd-page-list"></div>
          <div class="bd-addpage">
            <button id="bd-addpage" class="bd-btn" type="button" aria-expanded="false" data-i18n="board.243">${_t("board.243")}</button>
            <div id="bd-addpop" class="bd-addpop" hidden>
              <select id="bd-new-size" aria-label="${_t("board.244")}" data-i18n-attr="aria-label:board.244">${SIZES.map(s => `<option${s === "A3" ? " selected" : ""}>${s}</option>`).join("")}</select>
              <select id="bd-new-orient" aria-label="${_t("board.245")}" data-i18n-attr="aria-label:board.245"><option value="landscape" data-i18n="board.246">${_t("board.246")}</option><option value="portrait" data-i18n="board.247">${_t("board.247")}</option></select>
              <button id="bd-addpage-ok" class="bd-btn bd-strong" type="button" data-i18n="board.248">${_t("board.248")}</button>
              <button id="bd-lw-add" class="bd-btn" type="button" data-i18n="lw.menu">${_t("lw.menu")}</button>
            </div>
          </div>
        </div>
        <div id="bd-pane-assets" class="bd-pane" role="tabpanel" aria-labelledby="bd-tab-assets">
          <div id="bd-asset-tools" class="bd-asset-tools">
            <div class="bd-search">${icon("search")}<input id="bd-q" type="text" placeholder="${_t("board.249")}" aria-label="${_t("board.249")}" data-i18n-attr="placeholder:board.249;aria-label:board.249"></div>
            <div class="bd-chips" role="group" aria-label="${_t("board.250")}" data-i18n-attr="aria-label:board.250">
              <button type="button" class="bd-chip" data-filter="all" aria-pressed="true" data-i18n="board.251">${_t("board.251")}</button>
              <button type="button" class="bd-chip" data-filter="diagram" aria-pressed="false" data-i18n="board.214">${_t("board.214")}</button>
              <button type="button" class="bd-chip" data-filter="image" aria-pressed="false" data-i18n="board.204">${_t("board.204")}</button>
            </div>
          </div>
          <div id="bd-asset-grid" class="bd-asset-grid"></div>
          <div id="bd-dropzone" class="bd-dropzone" hidden>
            <p data-i18n="board.252">${_t("board.252")}</p>
            <button type="button" class="bd-btn" data-empty="diagrams" data-i18n="board.253">${_t("board.253")}</button>
            <button type="button" class="bd-btn" data-empty="image" data-i18n="board.105">${_t("board.105")}</button>
          </div>
        </div>
        <div id="bd-pane-record" class="bd-pane" role="tabpanel" aria-labelledby="bd-tab-record" hidden>
          <div class="bd-search">${icon("search")}<input id="bd-rec-q" type="text" placeholder="${_t("board.127")}" aria-label="${_t("board.127")}" data-i18n-attr="placeholder:board.127;aria-label:board.127"></div>
          <div class="bd-rec-filters">
            <select id="bd-rec-status" aria-label="${_t("board.254")}" data-i18n-attr="aria-label:board.254"><option value="" data-i18n="board.255">${_t("board.255")}</option>${RC.STATUSES.map(k => `<option value="${k}">${RC.STATUS_LABEL[k]}</option>`).join("")}</select>
            <select id="bd-rec-tag" aria-label="${_t("board.256")}" data-i18n-attr="aria-label:board.256"></select>
            <select id="bd-rec-author" aria-label="${_t("board.257")}" data-i18n-attr="aria-label:board.257"><option value="" data-i18n="board.258">${_t("board.258")}</option>${RC.AUTHORS.map(a => `<option value="${a}" data-i18n="${RC.AUTHOR_KEYS[a]}">${RC.authorLabel(a)}</option>`).join("")}</select>
          </div>
          <label class="bd-cf"><input id="bd-rec-hidedrop" type="checkbox"><span data-i18n="board.259">${_t("board.259")}</span></label>
          <button id="bd-snap-save" class="bd-btn" type="button" data-i18n="board.125">${_t("board.125")}</button>
          <div id="bd-record-list" class="bd-record-list"></div>
        </div>
        <div id="bd-pane-layers" class="bd-pane" role="tabpanel" aria-labelledby="bd-tab-layers" hidden>
          <div id="bd-layer-list" class="bd-layer-list"></div>
          <p class="bd-ps-note" data-i18n="board.260">${_t("board.260")}</p>
        </div>
      </aside>
      <div class="bd-stage" id="bd-stage">
        <div class="bd-rc" aria-hidden="true"></div>
        <svg id="bd-ruler-h" class="bd-rh" xmlns="${NS}" aria-hidden="true"></svg>
        <svg id="bd-ruler-v" class="bd-rv" xmlns="${NS}" aria-hidden="true"></svg>
        <svg id="bd-svg" xmlns="${NS}" aria-label="${_t("board.261")}" role="application" tabindex="0" data-tool="v" data-i18n-attr="aria-label:board.261">
          <defs><filter id="bd-shadow" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB"><feDropShadow id="bd-shadow-fx" dx="0" dy="1" stdDeviation="3" flood-color="#000" flood-opacity="0.14"/></filter></defs>
          <g id="bd-world"><g id="bd-sections"></g><g id="bd-frames"></g><g id="bd-cards-bg"></g><g id="bd-pitems-layer"></g><g id="bd-cards"></g><g id="bd-ug"></g><g id="bd-arrows"></g><g id="bd-annos"></g><g id="bd-guides"></g><g id="bd-selection"></g><g id="bd-over"></g></g>
        </svg>
        <div id="bd-cpop" class="bd-cpop" hidden role="dialog" aria-label="${_t("board.207")}" data-i18n-attr="aria-label:board.207"></div>
        <div id="bd-penbar" class="bd-penbar" hidden role="group" aria-label="${_t("board.263")}" data-i18n-attr="aria-label:board.263">${Object.keys(RC.PEN_COLORS).map(k => `<button type="button" class="bd-pencol" data-pen="${k}" style="background:${RC.PEN_COLORS[k]}" aria-label="${_t("board.262", { 0: k })}" aria-pressed="${k === "ink"}"></button>`).join("")}</div>
        <div id="bd-gridprompt" class="bd-hint bd-gridprompt" hidden><span id="bd-gridtxt"></span><button type="button" class="bd-btn bd-strong" id="bd-grid-ok" data-i18n="board.264">${_t("board.264")}</button><button type="button" class="bd-btn" id="bd-grid-no" data-i18n="board.265">${_t("board.265")}</button></div>
        <div id="bd-pbanner" class="bd-pbanner" hidden><span id="bd-pbanner-t"></span><button type="button" class="bd-btn bd-strong" id="bd-pbanner-ok" data-i18n="board.266">${_t("board.266")}</button></div>
        <div id="bd-ctx" class="bd-ctx" role="toolbar" aria-label="${_t("board.267")}" hidden data-i18n-attr="aria-label:board.267"></div>
        <div id="bd-ctxmenu" class="bd-menu bd-ctxmenu" hidden>
          <button type="button" data-act="front" data-i18n-html="board.268">${_t("board.268")}</button>
          <button type="button" data-act="back" data-i18n-html="board.269">${_t("board.269")}</button>
          <button type="button" data-act="tofront" data-i18n="board.270">${_t("board.270")}</button>
          <button type="button" data-act="toback" data-i18n="board.271">${_t("board.271")}</button>
          <span class="bd-msep" role="separator"></span>
          <button type="button" data-act="lw" data-i18n="lw.menu.card" hidden>${_t("lw.menu.card")}</button>
          <button type="button" data-act="ent" data-i18n="ent.menu.card" hidden>${_t("ent.menu.card")}</button>
          <button type="button" data-act="dup" data-i18n-html="board.272">${_t("board.272")}</button>
          <button type="button" data-act="lock" data-i18n="board.273">${_t("board.273")}</button>
          <button type="button" data-act="del" data-i18n="board.076">${_t("board.076")}</button>
        </div>
        <div id="bd-rcmenu" class="bd-menu bd-rcmenu" hidden></div>
        <div id="bd-stamps" class="bd-stamps" role="dialog" aria-label="${_t("board.274")}" hidden data-i18n-attr="aria-label:board.274"></div>
        <div id="bd-empty" class="bd-emptycard" hidden>
          <h2 data-i18n="board.275">${_t("board.275")}</h2>
          <p data-i18n="board.276">${_t("board.276")}</p>
          <button type="button" class="bd-btn bd-strong" data-empty="blank" data-i18n-html="board.blank">${_t("board.blank")}</button>
          <button type="button" class="bd-btn" data-empty="a0jury">${tr("A0 세로 3단 주리 패널", "Panneau jury A0 portrait 3 col.")}</button>
          <button type="button" class="bd-btn" data-empty="a1mid">${tr("A1 2×2 중간 발표 패널", "Panneau rendu A1 2×2")}</button>
          <button type="button" class="bd-btn" data-empty="a3pinup">${tr("A3 크리틱 핀업 2장", "2 planches A3 critique")}</button>
          <button type="button" class="bd-btn" data-empty="diagrams" data-i18n="board.253">${_t("board.253")}</button>
          <button type="button" class="bd-btn" data-empty="image" data-i18n-html="board.277">${_t("board.277")}</button>
          <button type="button" class="bd-btn" data-empty="semester" data-i18n-html="board.278">${_t("board.278")}</button>
          <button type="button" class="bd-btn" data-empty="final" data-i18n-html="board.279">${_t("board.279")}</button>
        </div>
        <div id="bd-minimap" class="bd-minimap" hidden><svg id="bd-mini" viewBox="0 0 176 116" aria-label="${_t("board.280")}" role="img" data-i18n-attr="aria-label:board.280"></svg></div>
        <div class="bd-zoombar" role="group" aria-label="${_t("board.281")}" data-i18n-attr="aria-label:board.281">
          <button id="bd-zoom-out" class="bd-ib" type="button" aria-label="${_t("board.282")}" data-tip="${_t("board.282")}" data-i18n-attr="aria-label:board.282;data-tip:board.282">${icon("minus")}</button>
          <button id="bd-zoom" class="bd-zoom" type="button" data-tip="${_t("board.283")}" aria-label="${_t("board.284")}" data-i18n-attr="data-tip:board.283;aria-label:board.284">100%</button>
          <button id="bd-zoom-in" class="bd-ib" type="button" aria-label="${_t("board.285")}" data-tip="${_t("board.285")}" data-i18n-attr="aria-label:board.285;data-tip:board.285">${icon("plus")}</button>
          <button id="bd-zoom-fit" class="bd-ib" type="button" aria-label="${tr("화면에 맞추기 (Fit)", "Ajuster à l’écran (Fit)")}" data-tip="${tr("화면에 맞추기 (0)", "Ajuster à l’écran (0)")}">${icon("fit")}</button>
        </div>
        <div id="bd-readout" class="bd-readout" hidden></div>
        <div id="bd-gpop" class="bd-gpop" hidden role="dialog" aria-label="${_t("board.286")}" data-i18n-attr="aria-label:board.286"><label><span id="bd-gpop-l">Y</span><input id="bd-gpop-in" type="text" inputmode="decimal" aria-label="${_t("board.287")}" autocomplete="off" data-i18n-attr="aria-label:board.287"><span class="bd-nf-u">mm</span></label></div>
        <div id="bd-hint" class="bd-hint" role="status" hidden><span data-i18n="board.288">${_t("board.288")}</span><button type="button" class="bd-btn" id="bd-hint-ok" data-i18n="board.289">${_t("board.289")}</button></div>
      </div>
      <aside id="bd-props" class="bd-props" aria-label="${_t("board.290")}" hidden data-i18n-attr="aria-label:board.290"></aside>
      <div id="bd-list" class="bd-list" aria-label="${_t("board.291")}" data-i18n-attr="aria-label:board.291"></div>
    </div>
    <p id="bd-status" class="bd-status" role="status" aria-live="polite"></p>
    <div id="bd-tip" class="bd-tip" role="tooltip" hidden></div>
    <input id="bd-file-img" type="file" accept="image/*,application/pdf,.pdf" multiple hidden>
    <input id="bd-file-lw" type="file" accept=".pdf,.svg,application/pdf,image/svg+xml" hidden>
    <input id="bd-file-repl" type="file" accept="image/*" hidden>
    <input id="bd-file-proj" type="file" accept=".atelier,.zip,application/zip" hidden>`;
  document.body.append(sec);
  layerFrames = $("#bd-frames"); layerCards = $("#bd-cards"); layerCardsBg = $("#bd-cards-bg"); layerSec = $("#bd-sections"); layerAnno = $("#bd-annos"); layerArrows = $("#bd-arrows"); layerPI = $("#bd-pitems-layer"); layerOver = $("#bd-over"); layerUG = $("#bd-ug"); layerGuides = $("#bd-guides"); layerSel = $("#bd-selection");
  chrome = createChrome({
    root: () => $("#board"), ctx: () => ({ S, payloads }), status, download, safeName, selectedFrame, finishEdit, loadFontCss, buildPdf,
    commitMeta: v => { S.meta = { ...S.meta, ...v }; commit(); },
    commitStyles: v => { S.styles = v; commit(); },
    focusStage: () => $("#bd-svg").focus({ preventScroll: true }),
    preflight: () => { runPreflight(); return { list: pfList, S }; }, setPreset: v => { if (PRESET_KEYS.includes(v) && S.export?.preset !== v) { S.export = { preset: v }; commit(); } }, getPreset: () => S.export?.preset || "print"
  });
  wire();
  initTips();
  const syncV07Labels = () => {
    const b = (s, ko, fr) => { const n = $(s); if (n) n.textContent = tr(ko, fr); };
    b("#bd-tools", "도구 ▾", "Outils ▾");
    b('#bd-tools-pop [data-m="photo"]', "모형 사진 정리", "Retouche photo maquette");
    b('#bd-tools-pop [data-m="axo"]', "평면 → 분해 액소", "Plan → Axo éclatée");
    b('#bd-tools-pop [data-m="cloud"]', "Drive 프로젝트 저장 · 열기", "Enregistrer / ouvrir sur Drive");
    b('#bd-tools-pop [data-m="collab"]', "실시간 같이 편집 (Beta)", "Édition collaborative (Beta)");
    b('#bd-empty [data-empty="a0jury"]', "A0 세로 3단 주리 패널", "Panneau jury A0 portrait 3 col.");
    b('#bd-empty [data-empty="a1mid"]', "A1 2×2 중간 발표 패널", "Panneau rendu A1 2×2");
    b('#bd-empty [data-empty="a3pinup"]', "A3 크리틱 핀업 2장", "2 planches A3 critique");
    const zf = $("#bd-zoom-fit");
    if (zf) {
      zf.setAttribute("aria-label", tr("화면에 맞추기 (Fit)", "Ajuster à l’écran (Fit)"));
      zf.dataset.tip = tr("화면에 맞추기 (0)", "Ajuster à l’écran (0)");
    }
  };
  onLang(() => {   // live language switch: static markup is re-applied by i18n.js; everything built by script is rebuilt here
    syncV07Labels();
    const rc = $("#bd-rcmenu"); if (rc) rc.hidden = true;
    const tl = tools();
    for (const b of document.querySelectorAll("#board .bd-rail [data-tool]")) { const d = tl.find(x => x[0] === b.dataset.tool); if (d) { b.dataset.tip = `${d[2]} (${d[3]})`; b.setAttribute("aria-label", `${d[2]} (${d[3]})`); } }
    assetSig = ""; pageSig = ""; parentSig = ""; ctxSig = ""; $("#bd-layer-list").dataset.sig = ""; $("#bd-props").dataset.sig = ""; closePinPop();
    if (!$("#bd-stamps").hidden) renderStampGallery();
    if (isOpen) render();
    for (const e of document.querySelectorAll("#board .bd-tip")) e.hidden = true;
  });
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
    const stab = e.target.closest("[data-sec-tab]");
    if (stab) { renameSection(stab.dataset.secTab); return; }
    const gd = e.target.closest("[data-guide]");
    if (gd) { openGuidePop(gd.dataset.guide); return; }
    const g = e.target.closest(".bd-card");
    if (g) { const c = cardById(g.dataset.id); if (c && (c.kind === "image" || c.kind === "diagram")) enterContent(c.id); else if (c && c.kind === "link") editLink(c.id); else startEdit(g.dataset.id); return; }
    if (!ui.preview && ui.tool === "v") {
      const [wx, wy] = toWorld(e);
      const B = ROLE_BOX.body || { w: 70, h: 16 };
      const c = addCard({ kind: "text", role: "body", text: "", align: "left", x: r2(wx - B.w / 2), y: r2(wy - B.h / 2), w: B.w, h: B.h });
      sel = new Set([c.id]); selFrame = null;
      commit(); startEdit(c.id);
    }
  });
  // Right-click context menu on cards or empty canvas
  let rcWorld = [0, 0];
  svg.addEventListener("contextmenu", e => {
    if (ui.preview) return;
    e.preventDefault();
    closeMenus();
    rcWorld = toWorld(e);
    const g = e.target.closest(".bd-card");
    const m = $("#bd-rcmenu");
    if (g) {
      const id = g.dataset.id;
      if (!sel.has(id)) { sel = expandGroups(new Set([id])); selFrame = null; renderSel(); renderCtx(); renderProps(); }
      const cards = selCards();
      const allLocked = cards.every(c => c.locked);
      const multi = cards.length >= 2;
      const hasGrp = cards.some(c => c.group);
      m.innerHTML =
        `<button type="button" data-rc="dup">${tr("복제", "Dupliquer")} <kbd>⌘D</kbd></button>` +
        `<button type="button" data-rc="del">${tr("삭제", "Supprimer")} <kbd>Del</kbd></button>` +
        `<span class="bd-msep" role="separator"></span>` +
        `<button type="button" data-rc="front">${tr("앞으로 가져오기", "Avancer")}</button>` +
        `<button type="button" data-rc="back">${tr("뒤로 보내기", "Reculer")}</button>` +
        `<button type="button" data-rc="tofront">${tr("맨 앞으로", "Premier plan")}</button>` +
        `<button type="button" data-rc="toback">${tr("맨 뒤로", "Arrière-plan")}</button>` +
        `<span class="bd-msep" role="separator"></span>` +
        `<button type="button" data-rc="lock">${allLocked ? tr("잠금 해제", "Déverrouiller") : tr("잠금", "Verrouiller")}</button>` +
        (multi ? `<button type="button" data-rc="${hasGrp ? "ungrp" : "grp"}">${hasGrp ? tr("그룹 해제", "Dissocier") : tr("그룹 묶기", "Grouper")}</button>` +
          `<span class="bd-msep" role="separator"></span>` +
          `<button type="button" data-rc="al-c">${tr("가로 가운데 정렬", "Centrer horizontalement")}</button>` +
          `<button type="button" data-rc="al-m">${tr("세로 가운데 정렬", "Centrer verticalement")}</button>` +
          (cards.length >= 3 ? `<button type="button" data-rc="dist-h">${tr("가로 균등 간격", "Répartir horizontalement")}</button><button type="button" data-rc="dist-v">${tr("세로 균등 간격", "Répartir verticalement")}</button>` : "") : "");
    } else {
      m.innerHTML =
        `<button type="button" data-rc="add-img">${tr("이미지 · PDF 추가", "Ajouter image · PDF")}</button>` +
        `<button type="button" data-rc="add-txt">${tr("여기에 텍스트 추가", "Ajouter du texte ici")}</button>` +
        `<button type="button" data-rc="add-page">${tr("새 페이지 추가", "Nouvelle page")}</button>` +
        `<span class="bd-msep" role="separator"></span>` +
        `<button type="button" data-rc="fit">${tr("화면에 맞추기", "Ajuster à l’écran")} <kbd>0</kbd></button>` +
        `<button type="button" data-rc="minimap">${tr("미니맵 켜기 / 끄기", "Afficher / masquer la minicarte")}</button>`;
    }
    const st = $("#bd-stage").getBoundingClientRect();
    m.hidden = false;
    const x = clamp(e.clientX - st.left, 8, Math.max(8, st.width - m.offsetWidth - 8));
    const y = clamp(e.clientY - st.top, 8, Math.max(8, st.height - m.offsetHeight - 8));
    m.style.left = Math.round(x) + "px";
    m.style.top = Math.round(y) + "px";
  });
  $("#bd-rcmenu").addEventListener("pointerdown", e => e.stopPropagation());
  $("#bd-rcmenu").addEventListener("click", e => {
    const b = e.target.closest("[data-rc]");
    if (!b) return;
    $("#bd-rcmenu").hidden = true;
    const a = b.dataset.rc;
    if (a === "add-img") $("#bd-file-img").click();
    else if (a === "add-txt") {
      const B = ROLE_BOX.body || { w: 70, h: 16 };
      const c = addCard({ kind: "text", role: "body", text: "", align: "left", x: r2(rcWorld[0] - B.w / 2), y: r2(rcWorld[1] - B.h / 2), w: B.w, h: B.h });
      sel = new Set([c.id]); selFrame = null; commit(); startEdit(c.id);
    } else if (a === "add-page") {
      const f = addFrame(); selFrame = f.id; sel.clear(); commit(); zoomToFrame(f);
    } else if (a === "fit") fitAll();
    else if (a === "minimap") { ui.minimap = !ui.minimap; renderChrome(); scheduleMini(); }
    else ctxAction(a);
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
    const pk0 = e.dataTransfer.getData("text/atelier-parent");
    if (pk0) { const pf = frameAt(...at); if (pf) applyParentTo(pf.id, pk0); return; }   // drop a parent onto a page
    const sk = e.dataTransfer.getData("text/atelier-stamp");
    if (isStampKey(sk)) { ui.stampPick = { k: sk, link: stampLinkCandidate() }; placeStamp(at); return; }
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
  $("#bd-file-lw").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) openLineworkTool({ file: f }); };
  $("#bd-lw-add").onclick = () => { closeMenus(); $("#bd-file-lw").click(); };
  $("#bd-file-img").onchange = e => { const fs = [...e.target.files]; e.target.value = ""; if (fs.length) { ui.emptyDismissed = true; addImageFiles(fs); } };
  $("#bd-undo").onclick = undo;
  $("#bd-redo").onclick = redo;
  $("#bd-export").onclick = () => chrome.openExport();
  $("#bd-name").onchange = e => { S.name = e.target.value.trim() || _t('board.292'); commit(); };
  $("#bd-name").onkeydown = e => { if (e.key === "Enter") e.target.blur(); };
  // menus
  const menu = (btnId, popId, on) => {
    const btn = $(btnId), pop = $(popId);
    btn.onclick = e => { e.stopPropagation(); const open = pop.hidden; closeMenus(); pop.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };
    pop.addEventListener("click", e => { const b = e.target.closest("[data-m]"); if (!b || b.disabled) return; closeMenus(); on(b.dataset.m); });
  };
  menu("#bd-name-menu", "#bd-name-pop", m => { if (m === "new") newBoard(); else if (m === "open") $("#bd-file-proj").click(); else if (m === "save") saveFile(); else if (m === "img") $("#bd-file-img").click(); else if (m === "ent") openEntourage(); });
  menu("#bd-tools", "#bd-tools-pop", m => {
    if (m === "pdf") $("#bd-file-img").click();
    else if (m === "lw") $("#bd-file-lw").click();
    else if (m === "ent") openEntourage();
    else if (m === "photo") openPhotoTool();
    else if (m === "axo") openAxoTool();
    else if (m === "cloud") openCloudTool();
    else if (m === "collab") openCollabTool();
  });
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
    else if (m === "lang") setLang(getLang() === "fr" ? "ko" : "fr");
    else if (m === "dates") { ui.dates = !ui.dates; render(); }
    else if (m === "annos") toggleAnno();
    else if (m === "snap") saveSnapshot();
    else if (m === "week") addWeek();
    else if (m === "pdf") $("#bd-file-img").click();
    else if (m === "lw") $("#bd-file-lw").click();
    else if (m === "ent") openEntourage();
    else if (m === "photo") openPhotoTool();
    else if (m === "axo") openAxoTool();
    else if (m === "cloud") openCloudTool();
    else if (m === "collab") openCollabTool();
    else if (m === "promote") promoteKept(secActive() ? selSection : null);
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
    else if (r) { if (r.getAttribute("aria-disabled") === "true") { status(r.dataset.tip || r.title || _t('board.293')); return; } delete S.assets[r.dataset.removeAsset]; commit(); }
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
    if (S.editParent) { status(_t('board.091')); return; }
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
  sgal.addEventListener("click", e => { if (e.target.closest("[data-ent]")) { sgal.hidden = true; openEntourage(); return; } const b = e.target.closest("[data-stamp]"); if (b) pickStamp(b.dataset.stamp); });
  sgal.addEventListener("dragstart", e => { const b = e.target.closest("[data-stamp]"); if (b) { e.dataTransfer.setData("text/atelier-stamp", b.dataset.stamp); e.dataTransfer.effectAllowed = "copy"; sgal.hidden = true; } });
  sgal.addEventListener("pointerdown", e => e.stopPropagation());
  $("#bd-file-repl").onchange = async e => {   // 내용 교체: new image for THIS card only, frame and content offsets stay
    const f = e.target.files[0]; e.target.value = "";
    const c = selCards()[0];
    if (!f || !c || c.kind !== "image" || isLocked(c)) return;
    try {
      const { dataUrl, w, h } = await downscale(f), long = 120, mw = w >= h ? long : long * w / h, mh = w >= h ? long * h / w : long;
      const id = registerAsset("image", (f.name || _t('board.204')).replace(/\.[^.]+$/, ""), r2(mw), r2(mh), { img: dataUrl });
      if (!c.content) c.content = { dx: 0, dy: 0, s: 1 };
      const old = c.ref; c.ref = id;
      if (c.content && c.fit === "fill") c.content = { dx: 0, dy: 0, s: coverScale(c, S.assets[id]) };   // other aspect: re-cover the frame
      if (!S.cards.some(k => k.ref === old)) delete S.assets[old];   // no orphan asset (the payload stays for undo)
      commit();
    } catch (err) { console.error(err); status(_t('board.294')); }
  };
  $("#bd-pf").onclick = e => { e.stopPropagation(); const pop = $("#bd-pfpop"), open = pop.hidden; closeMenus(); if (open) { runPreflight(); renderPfPop(); } pop.hidden = !open; $("#bd-pf").setAttribute("aria-expanded", String(open)); };
  $("#bd-pfpop").addEventListener("click", e => { const b = e.target.closest("[data-pf]"); if (b) gotoPf(b.dataset.pf); });
  $("#bd-rec-q").oninput = e => { recFilter.q = e.target.value; renderRecord(); };
  $("#bd-rec-status").onchange = e => { recFilter.status = e.target.value; renderRecord(); };
  $("#bd-rec-tag").onchange = e => { recFilter.tag = e.target.value; renderRecord(); };
  $("#bd-rec-author").onchange = e => { recFilter.author = e.target.value; renderRecord(); };
  $("#bd-rec-hidedrop").onchange = e => { ui.hideDrop = e.target.checked; render(); };
  $("#bd-snap-save").onclick = saveSnapshot;
  $("#bd-record-list").addEventListener("click", e => {
    const r = e.target.closest("[data-rec]"), a = e.target.closest("[data-snap-restore]"), d = e.target.closest("[data-snap-delete]");
    if (a) restoreSnapshot(a.dataset.snapRestore); else if (d) deleteSnapshot(d.dataset.snapDelete); else if (r) recClick(r.dataset.rec);
  });
  $("#bd-penbar").addEventListener("click", e => { const b = e.target.closest("[data-pen]"); if (b && RC.PEN_COLORS[b.dataset.pen]) { ui.penColor = b.dataset.pen; renderChrome(); } });
  $("#bd-penbar").addEventListener("pointerdown", e => e.stopPropagation());
  $("#bd-cpop").addEventListener("pointerdown", e => e.stopPropagation());
  $("#bd-grid-ok").onclick = placeGrid; $("#bd-grid-no").onclick = () => { $("#bd-gridprompt").hidden = true; };
  $("#bd-add-parent").onclick = addParent;
  $("#bd-spread-toggle").onchange = toggleSpreads;
  $("#bd-pbanner-ok").onclick = exitEdit;
  const pl2 = $("#bd-parent-list");
  pl2.addEventListener("dblclick", e => { const b = e.target.closest("[data-parent]"); if (b) enterEdit(b.dataset.parent); });
  pl2.addEventListener("dragstart", e => { const b = e.target.closest("[data-parent]"); if (b) { e.dataTransfer.setData("text/atelier-parent", b.dataset.parent); e.dataTransfer.effectAllowed = "copy"; } });
  const pgl = $("#bd-page-list");
  pgl.addEventListener("dragover", e => { if (e.dataTransfer.types.includes("text/atelier-parent")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  pgl.addEventListener("drop", e => { const pid = e.dataTransfer.getData("text/atelier-parent"), row = e.target.closest("[data-frame]"); if (pid && row) { e.preventDefault(); applyParentTo(row.dataset.frame, pid); } });
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
    if (b.dataset.empty === "blank") { renderEmpty(); if (S.frames[0]) zoomToFrame(S.frames[0]); }
    else if (b.dataset.empty === "a0jury" || b.dataset.empty === "a1mid" || b.dataset.empty === "a3pinup") startPanelPreset(b.dataset.empty);
    else if (b.dataset.empty === "diagrams") gotoMode("diagrams");
    else if (b.dataset.empty === "image") { $("#bd-file-img").click(); renderEmpty(); }
    else if (b.dataset.empty === "semester") startSemester();
    else startFinalPanel();
  }
  // zoom bar + minimap
  const mid = () => { const r = svg.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
  $("#bd-zoom-in").onclick = () => zoomAt(1.25, ...mid());
  $("#bd-zoom-out").onclick = () => zoomAt(0.8, ...mid());
  $("#bd-zoom").onclick = () => zoomAt(PX_PER_MM / view.z, ...mid());
  $("#bd-zoom-fit").onclick = () => fitAll();

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
    if (S.guides.length >= MAX_GUIDES) { status(_t('board.295', { 0: MAX_GUIDES })); return; }
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
  showReadout(e, `${d.axis === "x" ? "X" : "Y"} ${fmt(mm)} mm${f ? " · " + pad2(f.page) : _t('board.296')}`);
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
  if (ui.guidesHidden || ui.guidesLocked) { status(ui.guidesHidden ? _t('board.297') : _t('board.298')); return; }
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
  if (!n) { status(_t('board.299')); return; }
  S.guides = S.guides.filter(g => g.page !== f.id);
  selGuide = null; commit(); status(_t('board.300', { 0: pad2(f.page), 1: n }));
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
const REF_KEYS = ['board.301', 'board.302', 'board.303', 'board.304', 'board.305', 'board.306', 'board.307', 'board.308', 'board.309'];
const refName = i => _t(REF_KEYS[i]);
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
  if (!moved) status(_t('board.310'));
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
  if (!n) status(_t('board.311'));
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
    nodes.push(psec(_t('board.312'), pnote(_t('board.315', { 0: g.axis === "x" ? _t('board.247') : _t('board.246'), 1: f ? pad2(f.page) + _t('board.313') : _t('board.314') })),
      prow(numField("g", g.axis === "x" ? "X" : "Y", g.mm, v => { const q = S.guides.find(x => x.id === id); if (q) { q.mm = r1(clamp(v, -100000, 100000)); commit(); } })),
      prow(pbtn(_t('board.076'), "trash", () => deleteGuide(id)))));
    return { sig, nodes };
  }
  if (secActive()) {
    const z = secById(selSection), id = z.id, upd = fn => { const q = secById(id); if (q) { fn(q); commit(); } };
    sig = `sec|${id}|${z.color}|${z.collapsed}`;
    const cols = mk("div", "bd-sw-row");
    for (const k of RC.SECTION_COLORS) { const b = mk("button", "bd-swatch"); b.type = "button"; b.style.background = RC.SECTION_FILL[k].replace(/[\d.]+\)$/, "0.5)"); b.setAttribute("aria-label", _t('board.316') + k); b.setAttribute("aria-pressed", String(z.color === k)); b.addEventListener("click", () => upd(q => { q.color = k; })); cols.append(b); }
    nodes.push(psec(_t('board.206'), txtField("secname", _t('board.317'), z.name, 60, v => { if (v) upd(q => { q.name = v.slice(0, 60); }); }), cols, chkField("seccol", _t('board.318'), z.collapsed, on => upd(q => { q.collapsed = on; if (on) for (const id of [...sel]) { const k = cardById(id); if (k && cardCollapsed(k)) sel.delete(id); } })), prow(pbtn(_t('board.232'), null, () => promoteKept(id))), prow(pbtn(_t('board.076'), "trash", () => deleteSection(id))), pnote(_t('board.319'))));
    return { sig, nodes };
  }
  const cards = selCards();
  if (cards.length === 1) {
    const c = cards[0], f = frameOf(c), media = c.kind === "image" || c.kind === "diagram";
    const pxs = media && !work ? srcPx(c) : null;
    sig = `c|${ui.layout}|${c.id}|${c.kind}|${c.role || ""}|${c.align || ""}|${c.color || ""}|${c.locked}|${layerOf(c)}|${c.rot || 0}|${c.group || ""}|${f ? f.id : "-"}|${ui.ref}|${pxs ? pxs.join("x") : ""}|${c.scale ? c.scale.den + (c.scale.locked ? "L" : "") : ""}|${media ? cardDen(c, S.assets[c.ref]) : ""}|${c.stamp || ""}|${c.hm || ""}|${c.flip ? 1 : 0}|${c.tone || ""}|${c.link || ""}|${c.link && cardById(c.link) ? 1 : 0}|${c.fit || ""}|${ppiInfo(c)?.text || ""}|${c.status || ""}|${(c.tags || []).join(",")}|${c.url || ""}|${c.stack || ""}|${c.fstyle || ""}|${PR.hasOverride(c) ? 1 : 0}|${c.cols || 1}|${(PR.overrideOf(c).color) || ""}|${S.swatches.length}`;
    const [rx, ry] = relXY(c), b = visBox(c);
    const widget = mk("div", "bd-ref"); widget.setAttribute("role", "group"); widget.setAttribute("aria-label", _t('board.320'));
    REF.forEach((_, i) => { const t = mk("button", "bd-refp"); t.type = "button"; t.setAttribute("aria-pressed", String(ui.ref === i)); t.setAttribute("aria-label", refName(i)); t.dataset.tip = _t('board.321') + refName(i); t.addEventListener("click", () => { ui.ref = i; renderProps(); }); widget.append(t); });
    const rotSel = selField("rot", _t('board.322'), [[0, "0°"], [90, "90°"]], quarter(c) ? 90 : 0, v => { const cs = selCards().filter(k => (k.kind === "image" || k.kind === "diagram") && !isLocked(k)); for (const k of cs) k.rot = Number(v); if (cs.length) commit(); });
    rotSel.querySelector("select").disabled = !media || isLocked(c);
    nodes.push(psec(_t('board.323'), pnote(f ? _t('board.324', { 0: pad2(f.page) }) : _t('board.314')),
      prow(widget, mk("div", "bd-xy", "")), null));
    const sec = nodes[0], xy = sec.querySelector(".bd-xy");
    xy.append(numField("x", "X", rx, v => setCardPos("x", v)), numField("y", "Y", ry, v => setCardPos("y", v)));
    const sizeOff = isLocked(c) || !!c.scale?.locked || (c.kind === "stamp" && !isNorthStamp(c.stamp));
    sec.append(prow(numField("w", "W", b.w, v => setCardSize("w", v), { disabled: sizeOff }), numField("h", "H", b.h, v => setCardSize("h", v), { disabled: sizeOff })),
      prow(rotSel, chkField("lock", _t('board.077'), c.locked, on => { for (const k of selCards()) k.locked = on; commit(); })));
    if (c.kind === "link") nodes.push(psec(_t('board.071'), txtField("lkurl", _t('board.325'), c.url, 2000, v => { const u = RC.cleanUrl(v); const q = cardById(c.id); if (!u) { status(_t('board.326')); renderProps(); return; } if (q) { q.url = u; commit(); } }), txtField("lktitle", _t('board.327'), c.title, 200, v => { const q = cardById(c.id); if (q) { q.title = v || RC.hostOf(q.url); commit(); } }), prow(pbtn(_t('board.328'), null, () => openLink(c)))));
    if (c.stack) nodes.push(stackSection(c));
    if (c.kind === "memo") nodes.push(psec(_t('board.329'), (() => { const r = mk("div", "bd-sw-row"); for (const col of MEMO_COLORS) { const t = mk("button", "bd-swatch"); t.type = "button"; t.style.background = col; t.setAttribute("aria-label", _t('board.330') + col); t.setAttribute("aria-pressed", String(c.color === col)); t.addEventListener("click", () => { for (const k of selCards()) if (k.kind === "memo") k.color = col; commit(); }); r.append(t); } return r; })()));
    nodes.push(statusTagSection(c));
    if (media) nodes.push(scaleSection(c));
    if (c.kind === "stamp") nodes.push(stampSection(c));
    if (!work) {
      nodes.push(psec(_t('board.238'), selField("layer", _t('board.238'), LAYERS.map(L => [L, LAYER_LABEL[L]]), layerOf(c), v => { if (!LAYERS.includes(v)) return; for (const k of selCards()) k.layer = v; for (const id of [...sel]) { const k = cardById(id); if (k && (layerHidden(k) || layerLocked(k))) sel.delete(id); } commit(); })));
      if (media) { const px = pxs, pi = ppiInfo(c); nodes.push(psec(_t('board.204'), pnote(S.assets[c.ref]?.title || ""), px ? pnote(_t('board.331', { 0: px[0], 1: px[1] })) : null, pi ? pnote(pi.vector ? _t('board.332') : _t('board.333', { 0: pi.text })) : null,
        prow(pbtn(_t('board.334'), null, () => setContentMode("cover")), pbtn(_t('board.335'), null, () => setContentMode("contain")), c.kind === "image" ? pbtn("1:1", null, () => setContentMode("native")) : null),
        c.kind === "image" ? prow(pbtn(_t('board.336'), null, () => $("#bd-file-repl").click())) : null,
        selField("fstyle", _t('board.203'), FSTYLES.map(k => [k, FSTYLE_LABEL[k]]), c.fstyle || "none", v => { for (const k of selCards()) if (isMedia(k)) { if (v === "none") delete k.fstyle; else k.fstyle = v; } commit(); }))); }
      if (c.kind === "text") {
        const al = (a, ic, t) => pbtn(t, ic, () => { for (const k of selCards()) if (k.kind === "text") k.align = a; commit(); }, { icon: true, pressed: (c.align || "left") === a });
        const ov = PR.hasOverride(c);
        nodes.push(psec(_t('board.337'), selField("role", _t('board.338'), ROLES.map(r => [r, ROLE_LABEL[r] + (ov && r === c.role ? " +" : "")]), c.role, v => { if (!ROLES.includes(v)) return; for (const k of selCards()) if (k.kind === "text") { k.role = v; } commit(); }),
          ov ? prow(pbtn(_t('board.339'), null, () => { for (const k of selCards()) if (k.kind === "text") PR.updateStyleFromCard(S, k); commit(); }), pbtn(_t('board.340'), null, () => { for (const k of selCards()) if (k.kind === "text") PR.resetOverride(k); commit(); })) : null,
          prow(numField("tsize", _t('board.341'), PR.effectiveStyle(S, c).size, v => setTextOverride("size", clamp(v, 1, 200))), numField("track", _t('board.342'), PR.effectiveStyle(S, c).tracking || 0, v => setTextOverride("tracking", clamp(v, -5, 20)))),
          colorRow(c),
          prow(al("left", "alignL", _t('board.343')), al("center", "alignC", _t('board.344')), al("right", "alignR", _t('board.345'))),
          prow(selField("cols", _t('board.346'), [[1, "1"], [2, "2"], [3, "3"]], c.cols || 1, v => { for (const k of selCards()) if (k.kind === "text") { k.cols = Number(v); if (k.cols === 1) delete k.cols; else k.gutter = k.gutter ?? 4; } commit(); }), numField("inset", _t('board.347'), c.inset || 0, v => { for (const k of selCards()) if (k.kind === "text") { k.inset = clamp(v, 0, 50); if (!k.inset) delete k.inset; } commit(); })),
          (c.cols || 1) > 1 ? prow(numField("gutter", _t('board.348'), c.gutter ?? 4, v => { for (const k of selCards()) if (k.kind === "text") k.gutter = clamp(v, 0, 50); commit(); })) : null));
      }
      if (c.group) nodes.push(psec(_t('board.349'), prow(pbtn(_t('board.166'), "ungroup", ungroupSel))));
    }
    return { sig, nodes };
  }
  if (cards.length > 1) {
    const grouped = cards.some(c => c.group), bs = cards.map(visBox);
    const same = bs.every(b => Math.abs(b.w - bs[0].w) < 0.05 && Math.abs(b.h - bs[0].h) < 0.05);
    sig = `m|${ui.layout}|${cards.map(c => c.id).join(",")}|${grouped}|${same}`;
    const ab = (act, ic, t, fn) => pbtn(t, ic, fn, { icon: true });
    nodes.push(psec(_t('board.350', { 0: cards.length }),
      prow(ab("l", "alignL", _t('board.351'), () => alignSel("l")), ab("c", "alignC", _t('board.352'), () => alignSel("c")), ab("r", "alignR", _t('board.353'), () => alignSel("r")), ab("t", "alignT", _t('board.354'), () => alignSel("t")), ab("m", "alignM", _t('board.355'), () => alignSel("m")), ab("b", "alignB", _t('board.356'), () => alignSel("b"))),
      prow(ab("dh", "distH", _t('board.357'), () => distribute("h")), ab("dv", "distV", _t('board.358'), () => distribute("v"))),
      prow(pbtn(_t('board.164'), "group", groupSel), grouped ? pbtn(_t('board.359'), "ungroup", ungroupSel) : null),
      cards.filter(isMedia).length >= 2 ? prow(pbtn(_t('board.119'), null, makeStack)) : null));
    if (same) nodes.push(psec(_t('board.341'), prow(numField("w", "W", bs[0].w, v => setCardSize("w", v)), numField("h", "H", bs[0].h, v => setCardSize("h", v)))));
    return { sig, nodes };
  }
  const f = selFrame ? frameById(selFrame) : null;
  if (f) {
    const fid = f.id;
    sig = `p|${ui.layout}|${fid}|${f.size}|${f.orientation}|${f.cartouche}|${f.template ? 1 : 0}|${f.page}|${f.parent || ""}|${Object.keys(f.overrides || {}).length}|${S.editParent || ""}|${S.parents.length}`;
    const upd = fn => { const q = frameById(fid); if (q) { fn(q); commit(); } };
    nodes.push(psec(_t('board.237'), pnote(pageTitle(f)),
      prow(selField("size", _t('board.244'), SIZES.map(z => [z, z]), f.size, v => PAPER[v] && upd(q => setFrameSize(q, v))), selField("orient", _t('board.245'), [["portrait", _t('board.247')], ["landscape", _t('board.246')]], f.orientation, v => upd(q => { q.orientation = v === "portrait" ? "portrait" : "landscape"; })))));
    if (S.editParent) nodes.push(psec(_t('board.240'), pnote(_t('board.360', { 0: S.editParent })), prow(pbtn(_t('board.266'), null, exitEdit))));
    else nodes.push(psec(_t('board.240'), selField("parent", _t('board.361'), [["", _t('board.362')], ...S.parents.map(p => [p.id, `${p.id} ${p.name}`])], f.parent || "", v => applyParentTo(fid, v)),
      Object.keys(f.overrides || {}).length ? prow(pbtn(_t('board.363'), null, () => { const q = frameById(fid); if (q) { PR.clearOverrides(S, q); commit(); } })) : null));
    if (!work) {
      const t = f.template;
      nodes.push(psec(_t('board.364'),
        prow(numField("margin", _t('board.365'), t ? t.margin : null, v => upd(q => { if (q.template) q.template.margin = clamp(v, 0, 100); }), { disabled: !t, ph: "—" }), numField("cols", _t('board.366'), t ? t.cols : 0, v => upd(q => setPageCols(q, v)), { unit: _t('board.346') })),
        prow(numField("gutter", _t('board.367'), t ? t.gutter : null, v => upd(q => { if (q.template) q.template.gutter = clamp(v, 0, 50); }), { disabled: !t, ph: "—" })),
        prow(chkField("cart", _t('board.368'), f.cartouche, on => upd(q => { q.cartouche = on; })))));
    }
    if (!S.editParent) nodes.push(psec(_t('board.369'), prow(pbtn(_t('board.370'), "pageout", () => { const q = frameById(fid); if (q) chrome.exportFrames([q], "pdf"); })),
      prow(pbtn(_t('board.371'), "copyframe", () => duplicateFrame(fid)), pbtn(_t('board.076'), "trash", () => deleteFrame(fid)))));
    return { sig, nodes };
  }
  sig = `b|${ui.layout}|${S.swatches.map(w => w.id + w.hex + w.name).join(",")}|${swSel || ""}`;
  const m = (k, label, max) => txtField("meta-" + k, label, S.meta[k], max, v => { S.meta = { ...S.meta, [k]: v }; commit(); });
  nodes.push(psec(_t('board.229'), m("project", _t('board.372'), 120), m("author", _t('board.317'), 80), m("atelier", _t('board.373'), 80), m("teachers", _t('board.374'), 160), m("scale", _t('board.375'), 24), m("date", _t('board.376'), 24)));
  const st = mk("div", "bd-stylelist");
  for (const r of ROLES) { const b = mk("button", "bd-stylerow"); b.type = "button"; const T = S.styles[r]; b.append(mk("span", "", ROLE_LABEL[r]), mk("span", "bd-muted", `${T.size} mm · ${T.weight}`)); b.addEventListener("click", () => chrome.openStyles()); st.append(b); }
  nodes.push(psec(_t('board.078'), st), swatchSection());
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
  if (c.kind === "diagram") return { vector: true, cls: "vec", text: _t('board.377') };
  if (c.kind !== "image") return null;
  const px = srcPx(c);
  if (!px) return null;
  const w = contentRect(c, S.assets[c.ref]).w, p = Math.round(ppiOf(px[0], w)), cls = ppiClass(p);   // native px / (shown content width in inches)
  return { ppi: p, cls, text: cls === "low" ? _t('board.378', { 0: p }) : `${p} ppi` };
}
const isMedia = c => c && (c.kind === "image" || c.kind === "diagram");
function setContentMode(kind) {   // cover / contain / native (1:1 at 300 ppi)
  let n = 0;
  for (const c of selCards()) {
    if (!isMedia(c) || isLocked(c)) continue;
    if (c.scale?.locked) { status(_t('board.379')); continue; }
    const a = S.assets[c.ref], base = contentRect({ ...c, content: null }, a);
    let s = 1;
    if (kind === "cover") s = coverScale(c, a);
    else if (kind === "native") { const px = srcPx(c); if (!px) { status(_t('board.380')); continue; } s = clamp((px[0] / 300 * 25.4) / base.w, 0.05, 50); }
    c.content = { dx: 0, dy: 0, s: r2(s) }; c.fit = kind === "cover" ? "fill" : kind === "contain" ? "fit" : "free"; n++;
  }
  if (n) commit();
}
function enterContent(id) {
  const c = cardById(id);
  if (!isMedia(c) || isLocked(c)) return;
  if (quarter(c)) { status(_t('board.381')); return; }
  contentEdit = id; sel = new Set([id]); selFrame = null;
  render();
  status(_t('board.382'));
}
function exitContent() { if (!contentEdit) return; contentEdit = null; commit(); }
function contentPointerDown(e, wx, wy) {
  const c = cardById(contentEdit);
  if (!c) { contentEdit = null; return false; }
  const ch = e.target.closest("[data-chandle]"), ce = e.target.closest(".bd-card");
  try { $("#bd-svg").setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  if (ch) {
    if (c.scale?.locked) { status(_t('board.379')); return true; }
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
  if (c.scale?.locked) { status(_t('board.379')); return; }
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
    if (c.scale?.locked) { status(_t('board.383')); continue; }
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
    if (on && !d) { status(_t('board.384')); continue; }
    c.scale = { den: d || 100, locked: !!on }; if (!on && !d) delete c.scale; n++;
  }
  commit();
}
function stdDenOpts(cur) { const l = [...STD_DENS]; if (cur && !l.includes(cur)) l.push(cur); l.sort((a, b) => a - b); return l.map(d => [d, "1:" + d]); }
function scaleSection(c) {
  const den = cardDen(c, S.assets[c.ref]);
  const sel_ = selField("scaleden", _t('board.375'), [[0, _t('board.362')], ...stdDenOpts(den)], den || 0, v => setCardScale(Number(v)));
  return psec(_t('board.375'), pnote(den ? _t('board.385', { 0: den }) : _t('board.386')), sel_, chkField("scalelock", _t('board.387'), c.scale?.locked, on => toggleScaleLock(on)),
    den && c.kind === "diagram" ? pnote(_t('board.388', { 0: fmt(realWidthM(c.w, den)) })) : null);
}
function stampSection(c) {
  const L = c.link ? cardById(c.link) : null, north = isNorthStamp(c.stamp), bar = isBarStamp(c.stamp);
  const note = !c.link ? _t('board.389') : !L ? _t('board.390') : _t('board.392', { 0: S.assets[L.ref]?.title || _t('board.391'), 1: c.den });
  const upd = fn => { for (const k of selCards()) if (k.kind === "stamp") fn(k); commit(); };
  const parts = [pnote(stampLabel(c.stamp)), pnote(note)];
  if (!north) { const f = selField("stden", _t('board.375'), stdDenOpts(c.den), c.den, v => upd(k => { k.den = Math.round(clamp(Number(v), 1, 1e6)); })); f.querySelector("select").disabled = !!L; parts.push(f); }
  if (bar) parts.push(prow(numField("len", _t('board.393'), c.len_m, v => upd(k => { k.len_m = clamp(v, 0.001, 1e7); k.len_auto = false; }), { unit: "m" }), pbtn(_t('board.394'), null, () => upd(k => { k.len_auto = true; }))));
  if (north) parts.push(numField("angle", _t('board.395'), c.angle, v => upd(k => { k.angle = clamp(v, -360, 360); k.angleAuto = false; }), { unit: "°" }));
  if (isFigStamp(c.stamp)) {
    const plan = isPlanFig(c.stamp), hm = c.hm ?? FIGS[c.stamp].hm;
    const hf = numField("hm", plan ? _t("st.dia") : _t("st.height"), hm, v => upd(k => { k.hm = clampHm(v, hm); }), { unit: "m" });
    const hi = hf.querySelector("input"); hi.value = String(hm); hi.defaultValue = hi.value;   // numField rounds to 0.1; heights need 1.75
    parts.push(hf);
    if (FIGS[c.stamp].cat === "tree") parts.push(prow(...TREE_PRESETS.map(h => pbtn(h + " m", null, () => upd(k => { k.hm = h; }), { pressed: hm === h }))));
    parts.push(chkField("flip", _t("st.flip"), c.flip, on => upd(k => { k.flip = on; })));
    if (!isPlanFig(c.stamp)) parts.push(chkField("fill", _t("st.fill"), c.fill === true, on => upd(k => { k.fill = on; })));
    parts.push(selField("tone", _t("st.tone"), [["ink", _t("st.tone.ink")], ["soft", _t("st.tone.soft")]], c.tone || "ink", v => upd(k => { k.tone = v === "soft" ? "soft" : "ink"; })));
    parts.push(prow(pbtn(_t("st.refit"), null, () => refitFigs())));
  }
  if (c.link) parts.push(prow(pbtn(_t('board.396'), null, () => upd(k => { k.link = null; }))));
  return psec(isFigStamp(c.stamp) ? _t("st.sec") : _t('board.397'), ...parts);
}
// stamp gallery (rail tool S): 6 live vector templates; click then click the canvas, or drag one onto the canvas
const STAMP_BOX = { north_arrow: [12, 18], north_circle: [18, 18], north_cross: [22, 22] };
function stampSample(k) {
  if (isFigStamp(k)) { const hm = FIGS[k].hm, o = { stamp: k, den: hm * 1000 / 24, hm, len_m: 5, unit: "m", angle: 0 }, b = stampBox(o); o.w = b.w; o.h = b.h; return o; }   // gallery preview: 24 mm tall
  const o = { stamp: k, den: 100, len_m: 5, unit: "m", angle: 0, w: 12, h: 18 }, b = stampBox(o);
  if (b) { o.w = b.w; o.h = b.h; } else if (STAMP_BOX[k]) [o.w, o.h] = STAMP_BOX[k];
  return o;
}
const stampLinkCandidate = () => { const cs = selCards(); return cs.length === 1 && isMedia(cs[0]) && cardDen(cs[0], S.assets[cs[0].ref]) ? cs[0].id : null; };
function renderStampGallery() {
  const box = $("#bd-stamps");
  box.replaceChildren();
  const group = (title, keys, fig) => {
    box.append(mk("p", "bd-stamp-h", title));
    const row = mk("div", fig ? "bd-stamp-row bd-stamp-fig" : "bd-stamp-row");
    for (const k of keys) {
      const b = mk("button", "bd-stamp-it"); b.type = "button"; b.draggable = true; b.dataset.stamp = k; b.setAttribute("aria-label", stampLabel(k));
      const o = stampSample(k), sv = document.createElementNS(NS, "svg");
      sv.setAttribute("viewBox", `0 0 ${o.w} ${o.h}`); sv.setAttribute("class", "bd-stamp-prev"); sv.setAttribute("font-family", "Pretendard, Noto Sans KR, sans-serif");
      sv.style.aspectRatio = `${o.w} / ${o.h}`;
      sv.innerHTML = stampSvg(o, o.den, isFigStamp(k) ? { hair: 0.5 } : {});
      b.append(sv, mk("span", "", stampLabel(k)));
      row.append(b);
    }
    box.append(row);
  };
  group(_t('board.398'), ["bar_ticks", "bar_alt", "ratio"]);
  group(_t('board.399'), ["north_arrow", "north_circle", "north_cross"]);
  group(_t("st.g.people"), FIG_GROUPS.people, true);
  group(_t("st.g.trees"), FIG_GROUPS.trees, true);
  group(_t("st.g.plan"), FIG_GROUPS.plan, true);
  if (customKeys().length) group(_t("ent.g.title"), customKeys(), true);
  const mkb = tr_(mk("button", "bd-btn en-make", _t("ent.g.make")), "ent.g.make"); mkb.type = "button"; mkb.dataset.ent = "1"; box.append(mkb);
  box.append(mk("p", "bd-stamp-n", stampLinkCandidate() ? _t('board.400') : _t('board.401')));
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
  status(_t('board.402', { 0: stampLabel(k) }));
}
function placeStamp(at) {
  status("");
  const pk = ui.stampPick;
  ui.stampPick = null; setTool("v");
  if (!pk || !isStampKey(pk.k)) return;
  if (isFigStamp(pk.k)) { placeFig(pk, at); return; }
  const lc = pk.link ? cardById(pk.link) : null, d = lc ? cardDen(lc, S.assets[lc.ref]) : null, o = stampSample(pk.k);
  o.den = d || 100; o.len_m = niceLen(o.den);
  const na = lc ? S.assets[lc.ref]?.meta?.north_deg : null;
  if (isNorthStamp(pk.k) && na != null) o.angle = na;
  const b = stampBox(o); if (b) { o.w = b.w; o.h = b.h; }
  const c = addCard({ kind: "stamp", stamp: pk.k, den: o.den, link: d ? lc.id : null, angle: o.angle, len_m: o.len_m, unit: "m", len_auto: true, angleAuto: true, w: o.w, h: o.h, x: r2(at[0] - o.w / 2), y: r2(at[1] - o.h / 2), layer: "text" });
  sel = new Set([c.id]); selFrame = null;
  commit();
}

// scale figures: placed on the drawing card under the pointer (its scale sets the size); no card -> selected card -> 1:100
const mediaUnderPoint = (x, y) => S.cards.filter(c => isMedia(c) && x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h && cardDen(c, S.assets[c.ref])).sort((a, b) => b.z - a.z)[0] || null;
function placeFig(pk, at) {
  const g = FIGS[pk.k], lc = mediaUnderPoint(at[0], at[1]) || (pk.link ? cardById(pk.link) : null), d = lc ? cardDen(lc, S.assets[lc.ref]) : null;
  const o = { stamp: pk.k, den: d || 100, hm: g.hm }, b = stampBox(o);
  const c = addCard({ kind: "stamp", stamp: pk.k, den: o.den, hm: g.hm, flip: false, tone: "ink", link: d ? lc.id : null, angle: 0, len_m: 5, unit: "m", len_auto: true, angleAuto: false, w: b.w, h: b.h, x: r2(at[0] - b.w / 2), y: r2(at[1] - (g.plan ? b.h / 2 : b.h)), layer: "text" });
  sel = new Set([c.id]); selFrame = null;
  commit();
  if (!d) status(_t("st.den100"));
}
function refitFigs() {   // re-read the scale: link each selected figure to the drawing card under its centre
  let miss = 0;
  for (const k of selCards()) {
    if (k.kind !== "stamp" || !isFigStamp(k.stamp)) continue;
    const lc = mediaUnderPoint(k.x + k.w / 2, k.y + k.h / 2);
    if (lc) k.link = lc.id; else if (!k.link || !cardById(k.link)) miss++;
  }
  commit();
  if (miss) status(_t("st.refit.none"));
}

// ---- build 4b: parent pages, overrides, spreads, swatches --------------------------------------------------------------------------
const nextParentId = () => { for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") if (!S.parents.some(p => p.id === ch)) return ch; return null; };
function addParent() {
  if (S.editParent) return;
  const id = nextParentId();
  if (!id || S.parents.length >= 12) { status(_t('board.403')); return; }
  S.parents.push({ id, name: _t('board.404', { 0: id }), size: "A3", orientation: "landscape", margin: [10, 10, 10, 10], cols: 6, gutter: 5, items: [] });
  commit();
}
function applyParentTo(fid, pid) {
  const f = frameById(fid);
  if (!f || S.editParent) return;
  if (!pid) { f.parent = null; PR.clearOverrides(S, f); commit(); return; }
  const p = PR.parentById(S, pid);
  if (!p) return;
  let geom = true;
  if (f.size !== p.size || f.orientation !== p.orientation) geom = confirm(_t('board.405', { 0: f.size, 1: orientLabel(f), 2: p.id, 3: p.size, 4: p.orientation === "portrait" ? _t('board.247') : _t('board.246') }));
  if (f.parent && f.parent !== pid) PR.clearOverrides(S, f);
  PR.applyParent(S, f, pid, geom);
  commit();
}
function enterEdit(pid) {
  if (S.editParent || !PR.parentById(S, pid)) return;
  finishEdit(); contentEdit = null;
  S = PR.enterParentEdit(S, pid);
  sel.clear(); selFrame = "pe"; selGuide = null; syncGeom(); commit(); fitAll();
}
function exitEdit() {
  if (!S.editParent) return;
  finishEdit(); contentEdit = null;
  S = PR.exitParentEdit(S);
  sel.clear(); selFrame = null; syncGeom(); commit(); fitAll();
}
function makeOverride(f, item) {
  const c = PR.overrideCard(f, item);
  if (!c) return;
  const card = addCard(c);
  f.overrides = { ...(f.overrides || {}), [item.id]: card.id };
  sel = new Set([card.id]); selFrame = null;
  commit();
  status(_t('board.406'));
}
function toggleSpreads() {
  if (S.editParent) return;
  S.spreadView = !S.spreadView;
  if (S.spreadView) PR.layoutSpreads(S); else for (const f of S.frames) f.spread = null;
  syncGeom(); commit(); fitAll();
}
function parentThumb(p) {
  const [W, H] = PR.psize(p.size, p.orientation), sv = document.createElementNS(NS, "svg");
  sv.setAttribute("viewBox", `0 0 ${W} ${H}`); sv.setAttribute("class", "bd-pg-svg"); sv.setAttribute("aria-hidden", "true"); sv.style.aspectRatio = `${W} / ${H}`;
  el("rect", { width: W, height: H, fill: "#fff", stroke: "#c7c7cc", "stroke-width": Math.max(W, H) / 200 }, sv);
  for (const it of p.items) {
    if (it.kind === "cartouche") { const m = p.margin[0], ch = cartHeight(p.size); el("rect", { x: m, y: H - m - ch, width: W - 2 * m, height: ch, fill: "none", stroke: "#1d1d1f", "stroke-width": Math.max(W, H) / 300 }, sv); }
    else el("rect", { x: it.x, y: it.y, width: it.w, height: Math.min(it.h, 8), fill: "#a1a1a6", opacity: ".7" }, sv);
  }
  return sv;
}
let parentSig = "";
function renderParents() {
  const sig = JSON.stringify(S.parents.map(p => [p.id, p.name, p.size, p.orientation, p.items.length, p.cols])) + (S.editParent || "") + (S.spreadView ? 1 : 0);
  if (sig === parentSig) return;
  parentSig = sig;
  const box = $("#bd-parent-list");
  box.replaceChildren();
  for (const p of S.parents) {
    const b = mk("button", "bd-par" + (S.editParent === p.id ? " is-sel" : "")); b.type = "button"; b.draggable = !S.editParent; b.dataset.parent = p.id;
    b.setAttribute("aria-label", _t('board.407', { 0: p.id, 1: p.name })); b.dataset.tip = _t('board.408');
    const th = mk("span", "bd-par-th"); th.append(parentThumb(p));
    b.append(th, mk("span", "bd-par-t", `${p.id} ${p.name}`), mk("small", "", `${p.size}`));
    box.append(b);
  }
  $("#bd-spread-toggle").setAttribute("aria-pressed", String(!!S.spreadView));
}
// swatches (board properties, nothing selected)
let swSel = null;
const swFor = id => S.swatches.find(s => s.id === id);
function swatchSection() {
  const row = mk("div", "bd-sw-row bd-sw-wrap");
  for (const w of S.swatches) { const t = mk("button", "bd-swatch"); t.type = "button"; t.style.background = w.hex; t.dataset.tip = w.name; t.setAttribute("aria-label", w.name); t.setAttribute("aria-pressed", String(swSel === w.id)); t.addEventListener("click", () => { swSel = swSel === w.id ? null : w.id; renderProps(); }); row.append(t); }
  const parts = [row];
  const w = swSel && swFor(swSel);
  if (w) {
    const tints = mk("div", "bd-sw-row");
    for (const pc of [100, 80, 60, 40, 20]) { const t = mk("span", "bd-tint"); t.style.background = PR.tintHex(w.hex, pc); t.dataset.tip = `${w.name} ${pc}%`; tints.append(t); }
    parts.push(tints, txtField("swname", _t('board.317'), w.name, 40, v => { const q = swFor(swSel); if (q && v) { q.name = v; commit(); } }),
      prow(pbtn(_t('board.076'), "trash", () => { PR.deleteSwatch(S, swSel); swSel = null; commit(); })));
  }
  if (S.swatches.length < 24) {
    const col = mk("input"); col.type = "color"; col.value = "#7fa66a"; col.className = "bd-colorin"; col.setAttribute("aria-label", _t('board.409'));
    const nm = mk("input"); nm.type = "text"; nm.placeholder = _t('board.317'); nm.maxLength = 40; nm.className = "bd-swname"; nm.setAttribute("aria-label", _t('board.410'));
    parts.push(prow(col, nm, pbtn(_t('board.248'), null, () => { const hex = col.value; if (!/^#[0-9a-f]{6}$/i.test(hex)) return; PR.addSwatch(S, nm.value.trim() || _t('board.411'), hex, "s" + S.seq++); commit(); })));
  }
  return psec(_t('board.411'), ...parts);
}
const swOptions = () => S.swatches.map(w => [w.id, w.name]);
function colorRow(c) {   // text colour: swatch + tint (writes a style override)
  const cur = PR.overrideOf(c).color || S.styles[c.role]?.color || "", m = SW_RE_.exec(cur);
  const swId = m ? m[1] : "", tint = m && m[2] ? Number(m[2]) : 100;
  const apply = (id, t) => { for (const k of selCards()) if (k.kind === "text") { k.style_override = { ...(k.style_override || {}), color: id ? (t >= 100 ? `sw:${id}` : `sw:${id}@${t}`) : undefined }; if (!id) delete k.style_override.color; if (!Object.keys(k.style_override).length) delete k.style_override; } commit(); };
  return prow(selField("sw", _t('board.412'), [["", cur && !m ? _t('board.413') : _t('board.414')], ...swOptions()], swId, v => apply(v, tint)), selField("tint", _t('board.415'), [100, 80, 60, 40, 20].map(t => [t, t + "%"]), tint, v => { if (swId) apply(swId, Number(v)); else renderProps(); }));
}
const SW_RE_ = PR.SW_RE;
function statusTagSection(c) {
  const seg = mk("div", "bd-seg2");
  for (const k of RC.STATUSES) seg.append(pbtn(RC.STATUS_LABEL[k], null, () => { for (const q of selCards()) q.status = k; commit(); }, { pressed: (c.status || "review") === k }));
  const chips = mk("div", "bd-tagchips");
  for (const t of c.tags || []) { const b = mk("button", "bd-tagchip", `${t} ×`); b.type = "button"; b.setAttribute("aria-label", _t('board.416', { 0: t })); b.addEventListener("click", () => { for (const q of selCards()) q.tags = (q.tags || []).filter(x => x !== t); commit(); }); chips.append(b); }
  const inp = mk("input"); inp.type = "text"; inp.maxLength = 24; inp.placeholder = _t('board.417'); inp.dataset.k = "tagin"; inp.setAttribute("list", "bd-taglist"); inp.autocomplete = "off"; inp.setAttribute("aria-label", _t('board.418'));
  const dl = mk("datalist"); dl.id = "bd-taglist"; for (const t of new Set(S.cards.flatMap(q => q.tags || []))) { const o = mk("option"); o.value = t; dl.append(o); }
  inp.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); const v = inp.value; if (v.trim()) { for (const q of selCards()) q.tags = RC.cleanTags([...(q.tags || []), v]); commit(); } inp.value = ""; }
    else if (e.key === "Escape") { e.stopPropagation(); inp.blur(); }
  });
  return psec(_t('board.419'), seg, chips, inp, dl, pnote(_t('board.420', { 0: c.created ? fmtDate(c.created) : "" })));
}
function setTextOverride(key, v) {   // a value equal to the style's own value is no override
  for (const k of selCards()) if (k.kind === "text") {
    const base = S.styles[k.role]?.[key] ?? (key === "tracking" ? 0 : undefined), o = { ...(k.style_override || {}) };
    if (k.size != null && key === "size") delete k.size;
    if (v === base) delete o[key]; else o[key] = v;
    if (Object.keys(o).length) k.style_override = o; else delete k.style_override;
  }
  commit();
}
function insertField(name) {
  const c = selCards()[0];
  if (!c || c.kind !== "text" || !PR.FIELDS.includes(name)) return;
  if (editingId === c.id) { document.execCommand("insertText", false, PR.fieldToken(name)); return; }
  c.text = (c.text || "") + PR.fieldToken(name); commit();
}

// ---- build 5a: sections, annotations (comments, pen), snapshots, work record ------------------------------------------------------
let selSection = null, snaps = [], pinPopId = null;
const REC = RC;   // pure record helpers
const secActive = () => !!selSection && !sel.size && !selFrame && !selGuide && !!secById(selSection);   // a selected card or page wins over a stale section selection
const annoVisible = () => !ui.preview && (ui.annoForce ?? ui.layout === "work");
const secById = id => S.sections.find(z => z.id === id);
const inSec = (z, cx, cy) => cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h;
const dropGone = c => ((c.status || "review") === "drop" && (ui.hideDrop || (ui.layout === "print" && !frameOf(c)))) || RC.stackHidden(S, c);   // also: a stack member underneath
const cardHiddenNow = c => layerHidden(c) || cardCollapsed(c) || dropGone(c);
const cardCollapsed = c => S.sections.some(z => z.collapsed && inSec(z, c.x + c.w / 2, c.y + c.h / 2));
function renderSections() {
  if (!layerSec) return;
  layerSec.replaceChildren();
  if (ui.preview || S.editParent) return;
  const z = view.z, fs = 11 / z;
  for (const sec of S.sections) {
    const g = el("g", { class: "bd-sec" + (sec.id === selSection && secActive() ? " is-sel" : ""), "data-sec": sec.id }, layerSec);
    if (ui.layout === "print") g.style.opacity = "0.4";   // 조판: sections dim to the pasteboard
    const h = sec.collapsed ? 22 / z : sec.h;
    el("rect", { x: sec.x, y: sec.y, width: sec.w, height: h, class: "bd-sec-body", style: `fill:${REC.SECTION_FILL[sec.color]}` }, g);
    const tw = Math.min(sec.w, (sec.name.length * 7 + 16) / z * 1);
    el("rect", { x: sec.x, y: sec.y - 20 / z, width: tw, height: 20 / z, class: "bd-sec-tab", "data-sec-tab": sec.id }, g);
    const t = el("text", { x: sec.x + 8 / z, y: sec.y - 6 / z, "font-size": fs, class: "bd-sec-label", "data-sec-tab": sec.id }, g); t.textContent = sec.name;
    if (sec.id === selSection && secActive()) {
      el("rect", { x: sec.x, y: sec.y, width: sec.w, height: h, class: "bd-sec-out", "vector-effect": "non-scaling-stroke" }, g);
      if (!sec.collapsed) el("rect", { x: sec.x + sec.w - 3 / z, y: sec.y + sec.h - 3 / z, width: 6 / z, height: 6 / z, class: "bd-handle", "data-sec-rz": sec.id, "vector-effect": "non-scaling-stroke" }, g);
    }
  }
}
const cardPos = id => { const c = cardById(id); return c && !cardHiddenNow(c) ? c : null; };
const cardPt = (c, x, y) => {   // card-local point -> board, following the card rotation (90 degrees)
  const px = c.x + x, py = c.y + y;
  if (!c.rot) return [px, py];
  const cx = c.x + c.w / 2, cy = c.y + c.h / 2, a = c.rot * Math.PI / 180, dx = px - cx, dy = py - cy;
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
};
function renderAnnos() {
  if (!layerAnno) return;
  layerAnno.replaceChildren();
  if (!annoVisible() || S.editParent) return;
  const z = view.z;
  for (const m of S.marks) {
    const c0 = m.card ? cardPos(m.card) : null;
    if (m.card && !c0) continue;
    const pts = m.pts.map(p => (c0 ? cardPt(c0, p[0], p[1]) : p).map(r2).join(",")).join(" ");
    el("polyline", { points: pts, class: "bd-mark", stroke: REC.PEN_COLORS[m.color], "stroke-width": m.w, "vector-effect": "non-scaling-stroke" }, layerAnno);
    el("polyline", { points: pts, class: "bd-mark-hit", "data-mark": m.id, "vector-effect": "non-scaling-stroke" }, layerAnno);
  }
  S.comments.forEach((cm, i) => {
    const c0 = cardPos(cm.card);
    if (!c0) return;
    const o = cardPt(c0, cm.dx, cm.dy);
    const g = el("g", { class: "bd-pin" + (cm.resolved ? " is-done" : ""), "data-pin": cm.id, transform: `translate(${r2(o[0])} ${r2(o[1])})` }, layerAnno);
    el("circle", { r: 9 / z, fill: REC.AUTHOR_COLOR[cm.author], class: "bd-pin-c" }, g);
    const t = el("text", { "font-size": 11 / z, y: 4 / z, "text-anchor": "middle", class: "bd-pin-t" }, g); t.textContent = String(i + 1);
  });
}
function toggleAnno() { ui.annoForce = !annoVisible(); render(); status(annoVisible() ? _t('board.421') : _t('board.422')); }
// section tool: drag a rectangle
function startSectionDrag(wx, wy) { drag = { type: "secnew", start: [wx, wy], rect: el("rect", { class: "bd-marquee", "vector-effect": "non-scaling-stroke" }, layerGuides) }; }
function addSection(x, y, w, h, name) {
  if (S.sections.length >= REC.MAX_SECTIONS) { status(_t('board.423', { 0: REC.MAX_SECTIONS })); return null; }
  const sec = { id: "sec" + S.seq++, name: name || _t('board.424', { 0: S.sections.length + 1 }), x: r2(x), y: r2(y), w: r2(w), h: r2(h), color: REC.SECTION_COLORS[S.sections.length % 5], collapsed: false };
  S.sections.push(sec);
  return sec;
}
function deleteSection(id) { S.sections = S.sections.filter(z => z.id !== id); if (selSection === id) selSection = null; commit(); }   // contents stay
function renameSection(id) {
  const z = secById(id);
  if (!z) return;
  const v = prompt(_t('board.425'), z.name);
  if (v != null && v.trim()) { z.name = v.trim().slice(0, 60); commit(); }
}
function startSemester() {
  if (S.sections.length) { status(_t('board.426')); return; }
  const L = REC.semesterLayout(S.seq); S.seq += 5;
  S.sections = L.sections;
  const f = S.frames[0] || addFrame();
  f.size = "A1"; f.orientation = "portrait"; f.x = r2(L.pageAt.x); f.y = L.pageAt.y; f.template = makeTemplate("c6", "A1");
  if (PR.parentById(S, "A")) PR.applyParent(S, f, "A", true); else f.cartouche = true;
  ui.emptyDismissed = true; selFrame = null; sel.clear(); selSection = null;   // nothing selected: no panel covers the sections
  commit(); fitAll();
}
function addWeek() {
  const last = S.sections[S.sections.length - 1], x = last ? last.x + last.w + 40 : 0, y = last ? last.y : 0;
  const sec = addSection(x, y, 800, 1000, REC.nextSemaineName(S));
  if (!sec) return;
  selSection = sec.id; sel.clear(); selFrame = null; commit(); fitBox(sec.x - 40, sec.y - 40, sec.x + sec.w + 40, sec.y + sec.h + 40, 40);
}
// comments
const todayS = () => REC.todayStr();
function addComment(c, wx, wy) {
  if (S.comments.length >= REC.MAX_COMMENTS) { status(_t('board.427')); return; }
  const cm = { id: "m" + S.seq++, card: c.id, dx: r2(wx - c.x), dy: r2(wy - c.y), text: "", author: ui.author || "나", date: todayS(), resolved: false };
  S.comments.push(cm);
  commit();
  openPinPop(cm.id);
}
function syncPin() { const ta = $("#bd-cpop textarea"); if (ta && pinPopId) { const q = S.comments.find(m => m.id === pinPopId); if (q && q.text !== ta.value.slice(0, 2000)) { q.text = ta.value.slice(0, 2000); return true; } } return false; }
function openPinPop(id) {
  if (syncPin()) commit();   // a pin that was being edited keeps its text when another opens
  const cm = S.comments.find(m => m.id === id), c0 = cm && cardPos(cm.card), o = c0 && cardPt(c0, cm.dx, cm.dy);
  if (!cm || !o) return;
  pinPopId = id;
  const pop = $("#bd-cpop");
  pop.replaceChildren();
  const ta = mk("textarea"); ta.value = cm.text; ta.maxLength = 2000; ta.rows = 3; ta.setAttribute("aria-label", _t('board.207')); ta.placeholder = _t('board.207');
  ta.addEventListener("input", () => { const q = S.comments.find(m => m.id === id); if (q) { q.text = ta.value.slice(0, 2000); dirty = true; scheduleSave(); } });   // saved while typing
  ta.addEventListener("change", () => { const q = S.comments.find(m => m.id === id); if (q) { q.text = ta.value.slice(0, 2000); commit(); } });
  const au = mk("select"); au.setAttribute("aria-label", _t('board.257')); for (const a of REC.AUTHORS) { const op = mk("option", "", RC.authorLabel(a)); op.value = a; op.selected = a === cm.author; au.append(op); }
  au.addEventListener("change", () => { const q = S.comments.find(m => m.id === id); if (q && REC.AUTHORS.includes(au.value)) { q.author = au.value; ui.author = au.value; commit(); } });
  const done = mk("label", "bd-cf"), ck = mk("input"); ck.type = "checkbox"; ck.checked = cm.resolved; done.append(ck, mk("span", "", _t('board.428')));
  ck.addEventListener("change", () => { const q = S.comments.find(m => m.id === id); if (q) { q.resolved = ck.checked; commit(); } });
  const del = mk("button", "bd-btn", _t('board.076')); del.type = "button"; del.addEventListener("click", () => { S.comments = S.comments.filter(m => m.id !== id); closePinPop(); commit(); });
  const cl = mk("button", "bd-btn", _t('board.429')); cl.type = "button"; cl.addEventListener("click", closePinPop);
  const row = mk("div", "bd-pr"); row.append(au, done);
  const row2 = mk("div", "bd-pr"); row2.append(del, cl);
  pop.append(mk("p", "bd-ps-note", _t('board.430', { 0: S.comments.indexOf(cm) + 1, 1: fmtDate(cm.date) })), ta, row, row2);
  const r = $("#bd-svg").getBoundingClientRect(), st = $("#bd-stage").getBoundingClientRect();
  pop.hidden = false;
  pop.style.left = Math.round(clamp(o[0] * view.z + view.x + r.left - st.left + 14, 8, st.width - 250)) + "px";
  pop.style.top = Math.round(clamp(o[1] * view.z + view.y + r.top - st.top, 8, st.height - 190)) + "px";
  ta.focus();
}
function closePinPop() { const ch = syncPin(); $("#bd-cpop").hidden = true; pinPopId = null; if (ch) commit(); }
// pen
function startPen(e, wx, wy, cardEl) {
  const live = el("polyline", { class: "bd-mark", stroke: REC.PEN_COLORS[ui.penColor || "ink"], "stroke-width": 2, "vector-effect": "non-scaling-stroke" }, layerGuides);
  drag = { type: "pen", pts: [[wx, wy]], live, card: cardEl ? cardEl.dataset.id : null };
}
function penMove(wx, wy) {
  const d = drag, last = d.pts[d.pts.length - 1];
  if (Math.hypot(wx - last[0], wy - last[1]) * view.z < 1.5) return;
  d.pts.push([wx, wy]);
  d.live.setAttribute("points", d.pts.map(p => p.join(",")).join(" "));
}
function finishPen(d) {
  d.live.remove();
  if (d.pts.length < 2 || S.marks.length >= REC.MAX_MARKS) return;
  const c = d.card ? cardById(d.card) : null, o = c ? [c.x, c.y] : [0, 0];
  const pts = REC.capPoints(REC.rdp(d.pts, 0.5)).map(p => [r2(p[0] - o[0]), r2(p[1] - o[1])]);
  if (pts.length < 2) return;
  S.marks.push({ id: "k" + S.seq++, card: c ? c.id : null, pts, color: ui.penColor || "ink", w: 2 });
  commit();
}
// card -> view
function gotoCard(id) {
  const c = cardById(id);
  if (!c) return;
  if (c.stack && S.stacks[c.stack] !== c.id) { S.stacks[c.stack] = c.id; commit(); }   // bring a stack member to the top before selecting it
  sel = new Set([id]); selFrame = null; selGuide = null; selSection = null;
  const b = visBox(c), pad = Math.max(30, Math.max(b.w, b.h) * 0.4);
  fitBox(b.x - pad, b.y - pad, b.x + b.w + pad, b.y + b.h + pad, 40);
  render();
}
function gotoSection(id) { const z = secById(id); if (z) { selSection = id; sel.clear(); selFrame = null; fitBox(z.x - 40, z.y - 40, z.x + z.w + 40, z.y + z.h + 40, 40); render(); } }
// snapshots (IndexedDB store "snapshots")
const cleanSnap = r => {   // snapshot records come from an untrusted store
  if (!r || typeof r !== "object" || !/^[A-Za-z0-9_-]{1,40}$/.test(String(r.id)) || !r.S || typeof r.S !== "object") return null;
  return { id: String(r.id), name: String(r.name ?? _t('board.431')).slice(0, 60), date: RC.isDate(r.date) ? r.date : RC.todayStr(), S: r.S, assetIds: [...RC.referencedAssetIds([r])] };
};
function keepSnapPayloads() { const keep = RC.referencedAssetIds(snaps); for (const id of [...payloads.keys()]) if (!keep.has(id)) payloads.delete(id); }
async function loadSnaps() { try { snaps = (await idb.allSnaps()).map(cleanSnap).filter(Boolean).sort((a, b) => (a.id < b.id ? 1 : -1)); } catch (e) { console.warn("snapshots unavailable", e); snaps = []; } assetSig = ""; renderRecordSoon(); }
async function saveSnapshot() {
  finishEdit();
  const name = prompt(_t('board.432'), _t('board.433', { 0: snaps.length + 1 }));
  if (name == null) return;
  const FS = PR.flattenEdit(S), rec = { id: "n" + Date.now(), name: name.trim().slice(0, 60) || _t('board.431'), date: todayS(), S: JSON.parse(JSON.stringify(FS)), assetIds: Object.keys(FS.assets) };
  try { await idb.putSnap(rec); snaps.unshift(rec); status(_t('board.434', { 0: rec.name })); renderRecordSoon(); } catch (e) { console.warn(e); status(_t('board.435')); }
}
function restoreSnapshot(id) {
  const sn = snaps.find(x => x.id === id);
  if (!sn) return;
  if (S.editParent) exitEdit();   // leave a parent edit first so undo stays consistent
  finishEdit(); contentEdit = null; closePinPop();
  commit();   // the current state is the undo target
  S = sanitizeDoc(JSON.parse(JSON.stringify(sn.S)));
  sel.clear(); selFrame = null; selSection = null; selGuide = null; syncGeom(); commit(); fitAll();
  status(_t('board.436', { 0: sn.name }));
}
async function deleteSnapshot(id) {
  const sn = snaps.find(x => x.id === id);
  if (!sn || !confirm(_t('board.437', { 0: sn.name }))) return;
  try { await idb.delSnap(id); snaps = snaps.filter(x => x.id !== id); renderRecordSoon(); } catch (e) { console.warn(e); }
}
// 기록 panel
const recFilter = { q: "", status: "", tag: "", author: "" };
let recTimer = 0;
const renderRecordSoon = () => { clearTimeout(recTimer); recTimer = setTimeout(() => { if (ui.panel && ui.panelTab === "record") renderRecord(); }, 60); };
function recThumb(c) {
  const p = payloads.get(c.ref) || {}, href = c.kind === "diagram" ? p.preview : c.kind === "image" ? p.img : "";
  if (href && /^data:image\//.test(href)) { const im = mk("img", "bd-rec-th"); im.alt = ""; im.src = href; return im; }
  return mk("span", "bd-rec-th bd-rec-tx", c.kind === "stamp" ? "S" : "T");
}
function renderRecord() {
  const box = $("#bd-record-list");
  if (!box) return;
  const tags = [...new Set(S.cards.flatMap(c => c.tags || []))].sort();
  const ts = $("#bd-rec-tag"), cur = ts.value;
  ts.replaceChildren(...[["", _t('board.438')], ...tags.map(t => [t, t])].map(([v, t]) => { const o = mk("option", "", t); o.value = v; return o; })); ts.value = tags.includes(cur) ? cur : "";
  recFilter.tag = ts.value;
  box.replaceChildren();
  const row = (cls, ...kids) => { const r = mk("button", "bd-rec-row " + cls); r.type = "button"; r.append(...kids); box.append(r); return r; };
  if (recFilter.q.trim()) {
    const hits = REC.searchRecord(S, recFilter.q, { hideDrop: ui.hideDrop });
    box.append(mk("p", "bd-rec-h", _t('board.439', { 0: hits.length })));
    for (const h of hits) { const r = row("", mk("span", "bd-rec-k", h.type === "card" ? _t('board.391') : h.type === "comment" ? _t('board.207') : _t('board.206')), mk("span", "bd-rec-t", h.text)); r.dataset.rec = h.type + ":" + h.id + ":" + (h.card || ""); }
    if (!hits.length) box.append(mk("p", "bd-empty-note", _t('board.440')));
    return;
  }
  const groups = REC.groupByWeek(S, snaps, { ...recFilter, hideDrop: ui.hideDrop });
  if (!groups.length) box.append(mk("p", "bd-empty-note", _t('board.441')));
  for (const g of groups) {
    box.append(mk("p", "bd-rec-h", g.key));
    for (const sn of g.snaps) {
      const r = mk("div", "bd-rec-row bd-rec-snap"); r.append(mk("span", "bd-rec-k", _t('board.431')), mk("span", "bd-rec-t", sn.name));
      const rb = mk("button", "bd-btn", _t('board.442')); rb.type = "button"; rb.dataset.snapRestore = sn.id; const db = mk("button", "bd-btn", _t('board.076')); db.type = "button"; db.dataset.snapDelete = sn.id;
      r.append(rb, db); box.append(r);
    }
    for (const c of g.cards) { const r = row("", recThumb(c), mk("span", "bd-rec-t", REC.cardTitle(S, c)), mk("span", "bd-rec-st is-" + (c.status || "review"), REC.STATUS_LABEL[c.status || "review"])); r.dataset.rec = "card:" + c.id + ":"; }
    for (const m of g.comments) { const r = row("", mk("span", "bd-rec-k", RC.authorLabel(m.author)), mk("span", "bd-rec-t", (m.text || _t('board.443')).slice(0, 40))); r.dataset.rec = "comment:" + m.id + ":" + m.card; }
  }
}
function recClick(t) {
  const [type, id, card] = t.split(":");
  if (type === "card") gotoCard(id); else if (type === "comment") { gotoCard(card); openPinPop(id); } else if (type === "section") gotoSection(id);
}

// ---- build 5b: link cards, arrows, PDF import, promote kept cards, version stacks ---------------------------------------------------
let selArrow = null;
const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs", PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";
// link cards: http(s) only
function addLink(url, at) {
  if (S.editParent) { status(_t('board.091')); return null; }
  const u = RC.cleanUrl(url || "");
  if (!u) { status(_t('board.444')); return null; }
  const sp = at ? { x: r2(at[0] - 35), y: r2(at[1] - 9) } : spotFor(70, 18);
  const c = addCard({ kind: "link", url: u, title: RC.hostOf(u), x: sp.x, y: sp.y, w: 70, h: 18 });
  sel = new Set([c.id]); selFrame = null; selSection = null; commit();
  return c;
}
function addLinkAt(wx, wy) {
  setTool("v");
  const v = prompt(_t('board.445'), "https://");
  if (v != null) addLink(v, [wx, wy]);
}
function editLink(id) {
  const c = cardById(id);
  if (!c || c.kind !== "link" || isLocked(c)) return;
  const u = prompt(_t('board.446'), c.url);
  if (u == null) return;
  const nu = RC.cleanUrl(u);
  if (!nu) { status(_t('board.326')); return; }
  const t = prompt(_t('board.327'), c.title);
  c.url = nu; c.title = (t ?? c.title).trim().slice(0, 200) || RC.hostOf(nu); commit();
}
function openLink(c) { const u = RC.cleanUrl(c.url); if (u) window.open(u, "_blank", "noopener,noreferrer"); }
// arrows
function renderArrows() {
  if (!layerArrows) return;
  layerArrows.replaceChildren();
  if (ui.preview) return;
  const z = view.z;
  for (const a of S.arrows) {
    const A = cardById(a.from), B = cardById(a.to);
    if (!A || !B || cardHiddenNow(A) || cardHiddenNow(B)) continue;
    const g = RC.arrowSegment(visBox(A), visBox(B), 10 / z);
    if (!g) continue;
    const sl = a.id === selArrow;
    el("line", { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, class: "bd-arrow" + (sl ? " is-sel" : ""), "vector-effect": "non-scaling-stroke" }, layerArrows);
    el("polygon", { points: g.head.map(p => p.map(r2).join(",")).join(" "), class: "bd-arrow-h" }, layerArrows);
    el("line", { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, class: "bd-arrow-hit", "data-arrow": a.id, "vector-effect": "non-scaling-stroke" }, layerArrows);
  }
}
function addArrow(from, to) {
  if (from === to || S.arrows.some(a => a.from === from && a.to === to)) return;
  if (S.arrows.length >= RC.MAX_ARROWS) { status(_t('board.447')); return; }
  S.arrows.push({ id: "ar" + S.seq++, from, to });
  commit();
}
// stacks (version stacks)
function makeStack() {
  const cs = selCards().filter(c => isMedia(c) && !isLocked(c));
  if (cs.length < 2) { status(_t('board.448')); return; }
  const id = "st" + S.seq++, top = cs[0];
  for (const c of cs) { c.stack = id; if (c !== top) { c.sg = { w: c.w, h: c.h, rot: c.rot || 0 }; c.x = top.x; c.y = top.y; c.w = top.w; c.h = top.h; c.rot = top.rot || 0; } }
  S.stacks[id] = top.id; sel = new Set([top.id]); commit();
}
function unstack(id) { for (const c of S.cards) if (c.stack === id) { c.stack = null; if (c.sg) { c.w = c.sg.w; c.h = c.sg.h; c.rot = c.sg.rot; } delete c.sg; } delete S.stacks[id]; commit(); }   // members get their own size back
function cycleStackSel(id, dir) { const top = RC.cycleStack(S, id, dir); if (top) { sel = new Set([top]); commit(); } }
function stackSection(c) {
  const n = S.cards.filter(k => k.stack === c.stack).length, id = c.stack;
  return psec(_t('board.449'), pnote(_t('board.450', { 0: n })), prow(pbtn(_t('board.451'), null, () => cycleStackSel(id, -1)), pbtn(_t('board.452'), null, () => cycleStackSel(id, 1))), prow(pbtn(_t('board.359'), "ungroup", () => unstack(id))));
}
// promote kept images / diagrams to a new page of parent A (template cells), caption under each
function promoteKept(scopeSec) {
  const sec = scopeSec ? secById(scopeSec) : null, inside = c => !sec || (c.x + c.w / 2 >= sec.x && c.x + c.w / 2 <= sec.x + sec.w && c.y + c.h / 2 >= sec.y && c.y + c.h / 2 <= sec.y + sec.h);
  const src = sortedCards().filter(c => isMedia(c) && c.status === "keep" && !c.page && !RC.stackHidden(S, c) && !cardCollapsed(c) && inside(c));
  const pool = src.length ? src : sortedCards().filter(c => isMedia(c) && c.status === "keep" && !RC.stackHidden(S, c) && inside(c));
  if (!pool.length) { status(_t('board.453')); return; }
  if (S.editParent) { status(_t('board.091')); return; }
  const f = addFrame({ size: "A1", orientation: "portrait" });
  if (PR.parentById(S, "A")) PR.applyParent(S, f, "A", true); else f.template = makeTemplate("c6", "A1");
  const cells = gridCells(f);
  if (!cells) { status(_t('board.454')); return; }
  const cols = cells.xs.map(([a, b]) => ({ x: a, w: b - a })), plan = RC.shelfPack(pool.map(c => { const b = visBox(c); return { aspect: b.w / b.h }; }), cols, { x0: cells.x0, y0: cells.y0, x1: cells.x1, y1: cells.y1 }, 4, 8);
  for (const p of plan.placed) {
    const o = pool[p.i];
    const qt = quarter(o), cw = qt ? p.h : p.w, ch = qt ? p.w : p.h;   // a quarter-turned card keeps its turn: swap its frame so the visual box fits the cell
    addCard({ kind: o.kind, ref: o.ref, x: r2(f.x + p.x + p.w / 2 - cw / 2), y: r2(f.y + p.y + p.h / 2 - ch / 2), w: r2(cw), h: r2(ch), rot: qt ? o.rot : 0, status: "keep", tags: [...(o.tags || [])] });
    addCard({ kind: "text", role: "caption", text: S.assets[o.ref]?.title || "", align: "left", x: r2(f.x + p.x), y: r2(f.y + p.capY), w: r2(p.w), h: 8, status: "keep" });
  }
  selFrame = f.id; sel.clear(); selSection = null; commit(); zoomToFrame(f);
  status(_t('board.456', { 0: plan.placed.length, 1: plan.overflow.length ? _t('board.455', { 0: plan.overflow.length }) : "" }));
}
// PDF import (pdf.js loaded only when needed)
let pdfLib = null, pdfClose = null;
async function loadPdfJs() {
  if (pdfLib) return pdfLib;
  const lib = await import(PDFJS_URL);
  const res = await fetch(PDFJS_WORKER);
  if (!res.ok) throw new Error("pdf.js worker " + res.status);   // an error page is never run as a worker; nothing is cached on failure
  const w = await res.text();   // same-origin blob worker (no integrity hash: the pinned 4.4.168 URL is the only pin)
  lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([w], { type: "text/javascript" }));
  pdfLib = lib;
  return lib;
}
async function importPdf(file) {
  status(_t('board.457'));
  let doc;
  try { const lib = await loadPdfJs(); doc = await lib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false, enableXfa: false }).promise; }
  catch (e) { console.warn(e); status(_t('board.458')); return; }
  const base = (file.name || "PDF").replace(/\.pdf$/i, "").slice(0, 60), n = doc.numPages, MAXP = 40;
  const pick = mk("div", "bd-pdfpick"); pick.setAttribute("role", "dialog"); pick.setAttribute("aria-label", _t('board.459'));
  const head = mk("div", "bd-pdfh"), count = mk("span", "", ""), all = mk("button", "bd-btn", _t('board.460')), go = mk("button", "bd-btn bd-strong", _t('board.461')), cancel = mk("button", "bd-btn", _t('board.462'));
  for (const b of [all, go, cancel]) b.type = "button";
  head.append(mk("b", "", _t('board.463', { 0: file.name || "PDF", 1: n })), count, all, go, cancel);
  const grid = mk("div", "bd-pdfgrid"); pick.append(head, grid);
  if (n > MAXP) pick.append(mk("p", "bd-ps-note", _t('board.464', { 0: MAXP })));
  $("#board").append(pick);
  const checks = [];
  const upd = () => { const k = checks.filter(c => c.checked).length; count.textContent = _t('board.465', { 0: k }); go.disabled = !k; for (const c of checks) if (!c.checked) c.disabled = k >= MAXP; };
  let closed = false;
  const close = () => { if (closed) return; closed = true; pdfClose = null; pick.remove(); doc.destroy?.(); };
  pdfClose = close;
  cancel.onclick = close;
  all.onclick = () => { let k = 0; for (const c of checks) { c.checked = k < MAXP; k++; } upd(); };
  const shown = Math.min(n, RC.MAX_PDF_THUMBS);   // never build thousands of canvases
  if (n > shown) pick.append(mk("p", "bd-ps-note", _t('board.466', { 0: shown })));
  const io = typeof IntersectionObserver === "function" ? new IntersectionObserver(es => { for (const en of es) if (en.isIntersecting) { io.unobserve(en.target); en.target._draw?.(); } }, { root: grid }) : null;
  for (let i = 1; i <= shown; i++) {
    const cell = mk("label", "bd-pdfcell"), ck = mk("input"); ck.type = "checkbox"; ck.dataset.page = i; ck.checked = i <= Math.min(n, MAXP) && n <= MAXP; ck.addEventListener("change", upd);
    const cv = mk("canvas"); cell.append(ck, cv, mk("span", "", `p.${i}`)); grid.append(cell); checks.push(ck);
    cell._draw = () => doc.getPage(i).then(async pg => { if (closed) return; const v1 = pg.getViewport({ scale: 1 }), sc = RC.pdfThumbScale(v1.width, v1.height); if (!sc) return; const vp = pg.getViewport({ scale: sc }); cv.width = Math.max(1, Math.ceil(vp.width)); cv.height = Math.max(1, Math.ceil(vp.height)); const cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height); await pg.render({ canvasContext: cx, viewport: vp }).promise; }).catch(() => {});
    if (io) io.observe(cell); else cell._draw();
  }
  upd();
  go.onclick = async () => {
    const pages = checks.filter(c => c.checked).map(c => Number(c.dataset.page)).slice(0, MAXP);
    go.disabled = true; status(_t('board.467'));
    let done = 0;
    for (const p of pages) {
      try {
        const pg = await doc.getPage(p), v1 = pg.getViewport({ scale: 1 }), s = RC.pdfRenderScale(v1.width, v1.height);
        if (!s) continue;
        const vp = pg.getViewport({ scale: s });
        const cv = document.createElement("canvas"); cv.width = Math.max(1, Math.round(vp.width)); cv.height = Math.max(1, Math.round(vp.height));
        const cx = cv.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height);
        await pg.render({ canvasContext: cx, viewport: vp }).promise;
        const long = 120, mw = cv.width >= cv.height ? long : long * cv.width / cv.height, mh = cv.width >= cv.height ? long * cv.height / cv.width : long;
        const id = registerAsset("image", `${base} p.${p}`, r2(mw), r2(mh), { img: cv.toDataURL("image/jpeg", 0.9) });
        const c = placeAsset(id); if (c) { sel = new Set([c.id]); selFrame = null; }
        done++;
      } catch (e) { console.warn(e); }
    }
    close(); ui.emptyDismissed = true; commit(); status(_t('board.468', { 0: done }));
  };
}

// Entourage tool (점경 만들기): prompt templates, sheet cutter, photo silhouette, "내 점경" library. Loaded on demand; the library is registered at start-up (init) so saved cards render.
const tr_ = (e, key) => { e.dataset.i18n = key; return e; };
let entMod = null;
const entLoad = () => entMod ||= import("./board_v06_entourage.js?v=20261123h");
let cloudMod = null, photoMod = null, axoMod = null;
function toolCtx() {
  return {
    author: ui.author,
    status,
    exportSnapshot() {
      const FS = PR.flattenEdit(S);
      return { v: 1, doc: FS, payloads: Object.fromEntries([...payloads.entries()]) };
    },
    importSnapshot(snap, fromRemote) {
      if (!snap || !snap.doc) return;
      S = sanitizeDoc(snap.doc);
      payloads.clear();
      if (snap.payloads) for (const [k, v] of Object.entries(snap.payloads)) payloads.set(k, v);
      resetCanvasState();
      ui.emptyDismissed = true;
      render();
      if (!fromRemote && S.frames[0]) zoomToFrame(S.frames[0]);
    },
    addImageCard(dataUrl, w, h, title) {
      const id = "img_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      S.assets[id] = { id, kind: "image", title: title || "Image", w: w || 400, h: h || 300, meta: {} };
      payloads.set(id, { img: dataUrl });
      ui.emptyDismissed = true;
      const c = placeAsset(id);
      if (c) { sel = new Set([c.id]); selFrame = null; }
      commit();
      status(`${title || "이미지"} 카드를 보드에 넣었습니다.`);
    },
  };
}
async function openCloudTool() { try { cloudMod ||= await import("./board_v06_cloud.js?v=20261123h"); await cloudMod.openCloudModal(toolCtx()); } catch (e) { console.error(e); status("Drive 모듈을 열지 못했습니다."); } }
async function openCollabTool() { try { cloudMod ||= await import("./board_v06_cloud.js?v=20261123h"); cloudMod.openCollabModal(toolCtx()); } catch (e) { console.error(e); status("실시간 편집 모듈을 열지 못했습니다."); } }
async function openPhotoTool() {
  try {
    photoMod ||= await import("./board_v06_photo.js?v=20261123h");
    const first = [...sel].map(cardById).find(c => c && c.ref && payloads.get(c.ref)?.img);
    photoMod.openPhotoModal(toolCtx(), first ? payloads.get(first.ref).img : null);
  } catch (e) { console.error(e); status("사진 정리 도구를 열지 못했습니다."); }
}
async function openAxoTool() {
  try {
    axoMod ||= await import("./board_v06_axo.js?v=20261123h");
    const init = S.cards.filter(c => c.ref && (payloads.get(c.ref)?.img || payloads.get(c.ref)?.preview)).slice(0, 6).map(c => ({
      name: S.assets[c.ref]?.title || c.id,
      dataUrl: payloads.get(c.ref)?.img || payloads.get(c.ref)?.preview,
    }));
    axoMod.openAxoModal(toolCtx(), init);
  } catch (e) { console.error(e); status("분해 액소 도구를 열지 못했습니다."); }
}
if (/room=[^&]+&key=[^&]+/.test(location.hash || "")) {
  import("./board_v06_cloud.js?v=20261123h").then(m => { cloudMod = m; m.checkCollabHash(toolCtx()); }).catch(() => {});
}
const entCtx = () => ({
  status, download, FFLATE,
  onChange: () => { if (!$("#bd-stamps").hidden) renderStampGallery(); render(); },
  pickStamp: key => { pickStamp(key); }
});
async function openEntourage(o = {}) {
  status(_t("ent.loading"));
  try { const m = await entLoad(); await m.init(entCtx()); status(""); await m.open($("#board"), o); } catch (e) { console.warn(e); status(_t("ent.s.err")); }
}
async function entInit() { try { const m = await entLoad(); await m.init(entCtx()); } catch (e) { console.warn("entourage library", e); } }

// Linework tool (선 위계 정리): loaded on first use so the board's start-up is unchanged; the result comes back through add() as a new diagram card
async function openLineworkTool(src) {
  status(_t("lw.loading"));
  try {
    const mod = await import("./board_v06_linework.js?v=20261123g");
    status("");
    await mod.openLinework({ host: $("#board"), file: src.file, svgText: src.svgText, name: src.name, ctx: { loadPdfJs, add, status } });
  } catch (e) { console.warn(e); status(_t("lw.err.read")); }
}

// ---- public API ----------------------------------------------------------------------------------------------------------
let migrated = false;
const loaded = (async () => {
  build();
  await entInit();
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
      for (const [id, p] of Object.entries(rec.payloads || {})) payloads.set(id, cleanPayload(p));   // includes assets only snapshots use
      if (Number.isFinite(rec.savedAt)) { savedAt = rec.savedAt; saveState = "saved"; }
      setAutosave(true);
    } else { await idb.put("probe", 1); setAutosave(true); }
  } catch (e) { console.warn("IndexedDB unavailable", e); setAutosave(false); }
  hist = [snap()]; hi = 0; syncGeom();
  await loadSnaps();   // doSave needs the snapshot asset ids
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
  syncRoute(true);
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
  syncRoute(false);
}
// Board has its own address (/site/#board, linked from the hub as /board/): keep the hash,
// the tab title and the top-right site switch in step with the open state.
const TITLE_TERRAIN = document.title;
function syncRoute(on) {
  const want = on ? "#board" : "";
  if (location.hash !== want && (on || location.hash === "#board")) {
    try { history.replaceState(history.state, "", location.pathname + location.search + want); } catch { /* file:// or sandbox */ }
  }
  document.title = on ? "Board — 4·2" : TITLE_TERRAIN;
  for (const a of document.querySelectorAll(".site-switch a[data-site]")) {
    if (a.dataset.site === (on ? "board" : "terrain")) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
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
  if (!item || !item.kind) throw new Error(_t('board.469'));
  if (item.kind === "diagram") {
    const svgClean = cleanSvgString(item.svg), prev = safeImg(item.preview);
    if (!svgClean || !prev) throw new Error(_t('board.470'));
    if (item.meta?.address || item.meta?.radius) S.site = { address: item.meta.address || "", radius: item.meta.radius || "" };
    const id = registerAsset("diagram", item.title || _t('board.214'), item.w || 420, item.h || 297, { svg: svgClean, preview: prev }, cleanAssetMeta(item.meta));
    ui.emptyDismissed = true;
    commit();
    return id;
  }
  if (item.kind === "image") {
    if (!safeImg(item.img)) throw new Error(_t('board.471'));
    const id = registerAsset("image", item.title || _t('board.204'), item.w || 100, item.h || 70, { img: item.img }, item.meta || null);
    ui.emptyDismissed = true;
    commit();
    return id;
  }
  throw new Error(_t('board.472') + item.kind);
}
const count = () => Object.keys(S.assets).length;

globalThis.atelierBoard = { add, open, close, count };
dispatchEvent(new CustomEvent("atelierBoard:ready"));
document.addEventListener("click", e => { if (e.target.closest("#start-board")) open(); });
addEventListener("hashchange", () => { if (location.hash === "#board") open(); else close(); });
if (location.hash === "#board") open();
