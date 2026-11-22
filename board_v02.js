// Board mode of Atelier 4·2, v2: pin-up canvas + final panels (pages). Third mode of the site (body.dataset.mode = "board").
//   globalThis.atelierBoard = { add(item), open(), close(), count() }     event: atelierBoard:ready
// Screen = raster previews in an SVG world (mm units); export = vector SVG composed per page (board_v02_export.js).
// Document model, sanitizing and the v1 -> v2 migration live in board_v02_doc.js; dialogs in board_v02_chrome.js.
import { buildPdf } from "./dgpdf_v02.js?v=20261121a";
import { loadFontCss } from "./dgcore_v04.js?v=20261116p";
import {
  DOC_VERSION, PAPER, SIZES, ROLES, ROLE_LABEL, ROLE_BOX, MEMO_COLORS, GRID_DEFAULT, TEMPLATE_KEYS, TEMPLATE_LABEL,
  makeTemplate, templateKey, safeImg, num, r2, pad2, frameSize, orientLabel, pageLabel, gridCells, cartHeight,
  cleanSvgString, cleanPayload, sanitizeDoc, emptyDoc
} from "./board_v02_doc.js?v=20261121c";
import * as X from "./board_v02_export.js?v=20261121c";
import { icon } from "./board_v02_icons.js?v=20261121c";
import { createChrome } from "./board_v02_chrome.js?v=20261121c";

const FFLATE = "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";
const NS = "http://www.w3.org/2000/svg";
const MAX_HIST = 100;
const PX_PER_MM = 3.7795;   // 100 % = true size at 96 dpi
const LOD_Z = 0.25 * PX_PER_MM;   // below 25 % zoom body/caption text is drawn as grey bars

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
const ui = { tool: "v", panel: true, panelTab: "assets", filter: "all", q: "", minimap: true, layout: "work", emptyDismissed: false };
let chrome = null;

const frameLabel = f => pageLabel(f);
const cardById = id => S.cards.find(c => c.id === id);
const frameById = id => S.frames.find(f => f.id === id);
const center = c => [c.x + c.w / 2, c.y + c.h / 2];
const quarter = c => Math.abs(c.rot || 0) % 180 === 90;
// visual bounding box (rot 90 swaps the box around the centre)
const visBox = c => { const [cx, cy] = center(c), w = quarter(c) ? c.h : c.w, h = quarter(c) ? c.w : c.h; return { x: cx - w / 2, y: cy - h / 2, w, h }; };
function frameAt(px, py) {
  for (const f of S.frames) { const [w, h] = frameSize(f); if (px >= f.x && px <= f.x + w && py >= f.y && py <= f.y + h) return f; }
  return null;
}
const frameOf = c => frameAt(...center(c));
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
function commit() {
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
  sel = new Set([...sel].filter(id => cardById(id)));
  if (selFrame && !frameById(selFrame)) selFrame = null;
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
  t.dataset.state = saveState;
  t.textContent = saveState === "saving" ? "저장 중…" : saveState === "error" ? "자동저장 안 됨" : saveState === "saved" ? `자동저장됨 ${hh(new Date(savedAt))}` : "";
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
  const card = { kind: "text", x: 0, y: 0, w: 50, h: 20, rot: 0, crop: null, locked: false, group: null, ...c, id: "c" + S.seq++, z };
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
function placeAsset(id, at) {
  const a = S.assets[id];
  if (!a) return null;
  let w = a.w, h = a.h;
  const f0 = (at ? frameAt(...at) : null) || (at ? nearestFrame(...at) : null) || frameAt(...viewCentre()) || nearestFrame(...viewCentre());
  if (f0) {
    const [fw, fh] = frameSize(f0);
    const k = Math.min(fw * 0.5 / w, fh * 0.8 / h);
    w = r2(w * k); h = r2(h * k);
  }
  const sp = spotFor(w, h, at);
  // Cascade so repeated placements at the same spot do not hide each other.
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
    const del = new Set(selCards().filter(c => !c.locked).map(c => c.id));
    if (!del.size) { status("잠긴 카드는 지울 수 없습니다. 잠금을 먼저 푸세요."); return; }
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
  selFrame = null; commit();
}
function duplicate() {
  if (selFrame && !sel.size) { duplicateFrame(selFrame); return; }
  if (!sel.size) return;
  const out = [], gmap = new Map();
  for (const id of sel) {
    const c = cardById(id);
    if (!c) continue;
    const copy = addCard({ ...JSON.parse(JSON.stringify(c)), x: r2(c.x + 10), y: r2(c.y + 10), locked: false });
    if (c.group) { if (!gmap.has(c.group)) gmap.set(c.group, "g" + S.seq++); copy.group = gmap.get(c.group); }
    out.push(copy);
  }
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
  const dx = g.x - f.x, dy = g.y - f.y, gmap = new Map();
  for (const c of own) {
    const copy = addCard({ ...JSON.parse(JSON.stringify(c)), x: r2(c.x + dx), y: r2(c.y + dy) });
    if (c.group) { if (!gmap.has(c.group)) gmap.set(c.group, "g" + S.seq++); copy.group = gmap.get(c.group); }
  }
  selFrame = g.id; sel.clear();
  commit();
  zoomToFrame(g);
}
function reorder(dir) {
  if (!sel.size) return;
  const arr = [...S.cards].sort((a, b) => a.z - b.z);
  if (dir > 0) { for (let i = arr.length - 2; i >= 0; i--) if (sel.has(arr[i].id) && !sel.has(arr[i + 1].id)) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]; }
  else { for (let i = 1; i < arr.length; i++) if (sel.has(arr[i].id) && !sel.has(arr[i - 1].id)) [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]]; }
  arr.forEach((c, i) => { c.z = i + 1; });
  commit();
}
function nudge(dx, dy) {
  if (!sel.size) return;
  for (const id of sel) { const c = cardById(id); if (c && !c.locked) { c.x = r2(c.x + dx); c.y = r2(c.y + dy); } }
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
  const cs = selCards().filter(c => (c.kind === "image" || c.kind === "diagram") && !c.locked);
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
  if (gs.size) for (const c of S.cards) if (gs.has(c.group)) ids.add(c.id);
  return ids;
};
// align / distribute (visual boxes; locked cards stay)
function alignSel(how) {
  const cs = selCards();
  if (cs.length < 2) return;
  const bs = cs.map(c => ({ c, b: visBox(c) }));
  const x0 = Math.min(...bs.map(o => o.b.x)), x1 = Math.max(...bs.map(o => o.b.x + o.b.w)), y0 = Math.min(...bs.map(o => o.b.y)), y1 = Math.max(...bs.map(o => o.b.y + o.b.h));
  for (const { c, b } of bs) {
    if (c.locked) continue;
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
  for (const { c, b } of bs) { const d = pos - b[k]; if (!c.locked) c[k] = r2(c[k] + d); pos += b[s] + gap; }
  commit();
}
// fit an image / diagram into the template cells its box covers (contain, centred)
function fillCells(c) {
  const f = frameOf(c), cells = f && gridCells(f);
  if (!cells) { status("이 페이지에는 템플릿이 없습니다."); return; }
  if (c.locked) { status("잠긴 카드입니다."); return; }
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
function setFrameSize(f, size) {
  const key = templateKey(f.template);
  f.size = size;
  if (f.template) f.template = makeTemplate(key, size);
}
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
const labelSize = () => Math.min(60, Math.max(3, 12 / view.z));
function applyView() {
  $("#bd-world").setAttribute("transform", `translate(${r2(view.x)} ${r2(view.y)}) scale(${view.z})`);
  $("#bd-world").style.setProperty("--inv", String(1 / view.z));
  $("#bd-zoom").textContent = Math.round(view.z / PX_PER_MM * 100) + "%";
  const fs = labelSize();
  for (const t of layerFrames.querySelectorAll("[data-frame-label]")) { const f = frameById(t.dataset.frameLabel); if (f) { t.setAttribute("font-size", fs); t.setAttribute("y", f.y - fs * 0.45); } }
  if (isLod() !== lastLod) { lastLod = isLod(); renderCards(); }
  renderSel(); placeCtx(); scheduleMini();
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
let layerFrames, layerCards, layerGuides, layerSel;

function renderFrames() {
  layerFrames.replaceChildren();
  const fs = labelSize(), print = ui.layout === "print";
  for (const f of S.frames) {
    const [w, h] = frameSize(f);
    const g = el("g", { class: "bd-frame" + (f.id === selFrame ? " is-sel" : ""), "data-frame": f.id }, layerFrames);
    el("rect", { x: f.x, y: f.y, width: w, height: h, class: "bd-paper" }, g);
    const cells = print ? gridCells(f) : null;
    if (cells) {   // template grid: faint fills, screen only
      const gg = el("g", { class: "bd-tpl", transform: `translate(${f.x} ${f.y})` }, g);
      for (const [a, b] of cells.xs) el("rect", { x: a, y: cells.y0, width: b - a, height: cells.y1 - cells.y0 }, gg);
      for (const [a, b] of cells.ys) el("rect", { x: cells.x0, y: a, width: cells.x1 - cells.x0, height: b - a }, gg);
    }
    if (f.cartouche) {
      const cg = el("g", { class: "bd-cart", transform: `translate(${f.x} ${f.y})`, "font-family": "Pretendard, Noto Sans KR, sans-serif" }, g);
      cg.innerHTML = X.cartoucheSvg(S, f, f.page, S.frames.length, false);
    }
    if (f.id === selFrame) el("rect", { x: f.x, y: f.y, width: w, height: h, class: "bd-frame-out", "vector-effect": "non-scaling-stroke" }, g);
    const t = el("text", { x: f.x, y: f.y - fs * 0.45, "font-size": fs, class: "bd-frame-label", "data-frame-label": f.id }, g);
    t.textContent = frameLabel(f);
  }
}
const styleOf = c => X.styleOf(S, ROLES.includes(c.role) ? c.role : "body");
function makeCardEl(c) {
  const g = el("g", { class: "bd-card", "data-id": c.id });
  if (c.kind === "diagram" || c.kind === "image") {
    el("rect", { class: "bd-hit bd-paper-rect" }, g);
    const im = el("image", { preserveAspectRatio: "none", class: "bd-img" }, g);
    const p = payloads.get(c.ref) || {};
    const href = c.kind === "diagram" ? p.preview : p.img;
    if (href) im.setAttribute("href", href);
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
  const out = ui.layout === "print" && !frameOf(c);   // 조판: everything outside a page is dimmed
  g.style.opacity = out ? "0.4" : "";
  g.querySelector(".bd-lockg").style.transform = `translate(${c.w}px, 0px) scale(var(--inv, 1))`;
  const hit = g.querySelector(".bd-hit");
  hit.setAttribute("width", c.w); hit.setAttribute("height", c.h);
  if (c.kind === "diagram" || c.kind === "image") {
    const im = g.querySelector(".bd-img");
    im.setAttribute("width", c.w); im.setAttribute("height", c.h);
    if (!im.getAttribute("href")) {   // payload may arrive after the card (file open)
      const p = payloads.get(c.ref) || {};
      const href = c.kind === "diagram" ? p.preview : p.img;
      if (href) im.setAttribute("href", href);
    }
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
  const sorted = [...S.cards].sort((a, b) => a.z - b.z);
  sorted.forEach((c, i) => {
    let g = els.get(c.id);
    if (!g) { g = makeCardEl(c); els.set(c.id, g); }
    updateCardEl(g, c);
    if (layerCards.children[i] !== g) layerCards.insertBefore(g, layerCards.children[i] || null);
  });
}
function renderSel() {
  layerSel.replaceChildren();
  const hs = 9 / view.z;
  for (const id of sel) {
    const c = cardById(id);
    if (!c) continue;
    const g = el("g", { transform: `translate(${c.x} ${c.y})` + (c.rot ? ` rotate(${c.rot} ${c.w / 2} ${c.h / 2})` : "") }, layerSel);
    el("rect", { width: c.w, height: c.h, class: "bd-sel", "vector-effect": "non-scaling-stroke" }, g);
    if (sel.size === 1 && editingId !== id && !c.locked) {
      for (const [n, hx, hy] of [["nw", 0, 0], ["ne", c.w, 0], ["sw", 0, c.h], ["se", c.w, c.h]]) {
        el("rect", { x: hx - hs / 2, y: hy - hs / 2, width: hs, height: hs, class: "bd-handle", "data-handle": n, "vector-effect": "non-scaling-stroke" }, g);
      }
    }
  }
}
function render() {
  renderFrames(); renderCards(); renderSel(); renderPanel(); renderCtx(); scheduleMini(); renderEmpty(); renderList(); renderChrome();
}
function renderChrome() {
  const nm = $("#bd-name");
  if (nm && document.activeElement !== nm) nm.value = S.name;
  $("#bd-undo").disabled = hi <= 0; $("#bd-redo").disabled = hi >= hist.length - 1;
  const b = $("#board");
  b.classList.toggle("is-print", ui.layout === "print");
  for (const t of document.querySelectorAll("#board [data-layout]")) t.setAttribute("aria-pressed", String(t.dataset.layout === ui.layout));
  for (const t of document.querySelectorAll("#board [data-tool]")) t.setAttribute("aria-pressed", String(t.dataset.tool === ui.tool));
  $("#bd-svg").dataset.tool = ui.tool;
  $("#bd-panel").hidden = !ui.panel;
  $("#bd-panel-toggle").setAttribute("aria-pressed", String(ui.panel));
  $("#bd-minimap").hidden = !ui.minimap;
  $("#bd-mini-toggle").setAttribute("aria-pressed", String(ui.minimap));
}
function setTool(t) {
  ui.tool = t;
  for (const b of document.querySelectorAll("#board [data-tool]")) b.setAttribute("aria-pressed", String(b.dataset.tool === t));
  $("#bd-svg").dataset.tool = t;
}
function setLayout(m) { ui.layout = m; render(); }

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
  for (const t of ["assets", "pages"]) {
    $("#bd-tab-" + t).setAttribute("aria-selected", String(ui.panelTab === t));
    $("#bd-pane-" + t).hidden = ui.panelTab !== t;
  }
  if (ui.panelTab === "assets") renderAssets(); else renderPages();
}
function renderAssets() {
  const used = new Map();
  for (const c of S.cards) if (c.ref) used.set(c.ref, (used.get(c.ref) || 0) + 1);
  const ids = Object.keys(S.assets).filter(id => (ui.filter === "all" || S.assets[id].kind === ui.filter) && (!ui.q || S.assets[id].title.toLowerCase().includes(ui.q.toLowerCase())));
  const sig = ids.map(i => i + ":" + (used.get(i) || 0) + (payloads.has(i) ? "p" : "")).join("|") + "#" + ui.q + ui.filter + Object.keys(S.assets).length;
  if (sig === assetSig) return;
  assetSig = sig;
  for (const ch of document.querySelectorAll("#board [data-filter]")) ch.setAttribute("aria-pressed", String(ch.dataset.filter === ui.filter));
  const box = $("#bd-asset-grid");
  box.replaceChildren();
  if (!ids.length) {
    box.append(mk("p", "bd-empty-note", Object.keys(S.assets).length ? "맞는 자료가 없습니다." : "다이어그램 화면의 ‘보드’ 버튼이나 이미지 추가로 자료를 담아 보세요."));
    return;
  }
  const order = ids.sort((a, b) => (used.get(a) ? 1 : 0) - (used.get(b) ? 1 : 0));   // unplaced first
  for (const id of order) {
    const a = S.assets[id], p = payloads.get(id) || {}, n = used.get(id) || 0;
    const card = mk("div", "bd-asset"); card.draggable = true; card.dataset.asset = id;
    const th = mk("div", "bd-thumb");
    const pb = mk("button", "bd-thumbbtn"); pb.type = "button"; pb.dataset.place = id; pb.setAttribute("aria-label", `${a.title} 배치`);
    const img = mk("img"); img.alt = ""; img.draggable = false; img.src = (a.kind === "diagram" ? p.preview : p.img) || "";
    pb.append(img); th.append(pb);
    if (n) th.append(mk("span", "bd-badge", `배치됨 ${n}`));
    const rm = mk("button", "bd-x"); rm.type = "button"; rm.dataset.removeAsset = id; rm.innerHTML = icon("close", 14);
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
  if (cells && ui.layout === "print") for (const [a, b] of cells.xs) el("rect", { x: a, y: cells.y0, width: b - a, height: cells.y1 - cells.y0, fill: "rgba(47,111,237,.08)" }, s);
  for (const c of S.cards.filter(k => frameOf(k) === f && k.kind !== "memo").sort((a, b) => a.z - b.z)) {
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
    S.cards.filter(c => frameOf(c) === f).map(c => `${c.id},${c.x},${c.y},${c.w},${c.h},${c.rot}`).join(";")].join(",")).join("|") + ui.layout;
  if (sig === pageSig) return;
  pageSig = sig;
  const box = $("#bd-page-list");
  box.replaceChildren();
  S.frames.forEach((f, i) => {
    const row = mk("div", "bd-pg" + (f.id === selFrame ? " is-sel" : "")); row.dataset.frame = f.id;
    const grip = mk("button", "bd-ib bd-grip"); grip.type = "button"; grip.innerHTML = icon("grip"); grip.setAttribute("aria-label", "끌어서 순서 바꾸기"); grip.title = "끌어서 순서 바꾸기";
    const main = mk("button", "bd-pg-main"); main.type = "button"; main.dataset.act = "pg-go";
    const th = mk("span", "bd-pg-thumb"); th.append(pageThumb(f));
    const t = mk("span", "bd-pg-t", `p.${f.page} ${f.size} ${orientLabel(f)}`);
    const n = S.cards.filter(c => frameOf(c) === f).length;
    t.append(mk("small", "", `카드 ${n}${f.template ? ` · ${TEMPLATE_LABEL[templateKey(f.template)]}` : ""}${f.cartouche ? " · 카르투슈" : ""}`));
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
const wideMQ = matchMedia("(min-width: 1024px)");
function renderList() {
  const box = $("#bd-list");
  if (!box || !mobileMQ.matches || !isOpen) return;
  if (box.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA") return;   // do not rebuild while typing
  box.replaceChildren();
  const groups = S.frames.map(f => ({ f, cards: [] }));
  const loose = [];
  for (const c of [...S.cards].sort((a, b) => a.z - b.z)) {
    const f = frameOf(c), g = groups.find(x => x.f === f);
    (g ? g.cards : loose).push(c);
  }
  const btn = (txt, act, id, label) => { const b = mk("button", "bd-mini", txt); b.type = "button"; b.dataset.lact = act; b.dataset.lid = id; b.setAttribute("aria-label", label); return b; };
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
  } else {
    const ta = mk("textarea", "bd-ltext");
    ta.value = c.text || ""; ta.dataset.lid = c.id; ta.rows = 2;
    ta.setAttribute("aria-label", label);
    if (c.locked) { ta.readOnly = true; ta.title = "잠긴 카드"; }
    if (c.kind === "memo") ta.style.background = c.color || MEMO_COLORS[0];
    row.append(mk("span", "bd-lk", label), ta);
  }
  const b1 = btn("▲", "up", c.id, "앞뒤 순서 위로"), b2 = btn("▼", "down", c.id, "앞뒤 순서 아래로"), b3 = btn("✕", "del", c.id, "삭제");
  if (c.locked) { b3.disabled = true; b3.title = "잠긴 카드"; }
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
  if (act === "del") { if (c.locked) return; S.cards = S.cards.filter(x => x.id !== id); sel.delete(id); commit(); return; }
  const f = frameOf(c);   // up / down: swap z with the neighbour inside the same frame
  const sibs = S.cards.filter(x => frameOf(x) === f).sort((a, b) => a.z - b.z);
  const i = sibs.indexOf(c), j = i + (act === "up" ? -1 : 1);
  if (j < 0 || j >= sibs.length) return;
  [c.z, sibs[j].z] = [sibs[j].z, c.z];
  commit();
}

// ---- contextual toolbar ------------------------------------------------------------------------------------
let ctxSig = "";
const cb = (act, ic, label, on) => `<button type="button" class="bd-ib" data-act="${act}" title="${label}" aria-label="${label}"${on == null ? "" : ` aria-pressed="${on}"`}>${icon(ic)}</button>`;
const cs = (sel_, label, opts, val) => `<select class="bd-sel-s" data-sel="${sel_}" aria-label="${label}">${opts.map(([v, t]) => `<option value="${v}"${String(v) === String(val) ? " selected" : ""}>${t}</option>`).join("")}</select>`;
const sepH = '<span class="bd-csep" aria-hidden="true"></span>';
function ctxHtml() {
  const f = selFrame && !sel.size ? frameById(selFrame) : null;
  if (f) {
    return cs("f-size", "용지", SIZES.map(s => [s, s]), f.size) + cb("f-orient", "orient", `방향: ${orientLabel(f)} (눌러서 바꾸기)`) + `<span class="bd-ctxt">${orientLabel(f)}</span>` +
      cs("f-tpl", "템플릿", TEMPLATE_KEYS.map(k => [k, k === "none" ? "템플릿 없음" : TEMPLATE_LABEL[k]]), templateKey(f.template)) + sepH +
      cb("f-cart", "cartouche", "카르투슈", !!f.cartouche) + cb("f-info", "info", "보드 정보") + sepH +
      cb("f-export", "pageout", "이 페이지 출력") + cb("f-dup", "copyframe", "프레임 복제 (대안)") + cb("f-del", "trash", "프레임 삭제");
  }
  const cards = selCards();
  if (!cards.length) return "";
  const allLocked = cards.every(c => c.locked);
  if (cards.length === 1) {
    const c = cards[0];
    let h = "";
    if (c.kind === "text") {
      h += cs("t-style", "글 스타일", ROLES.map(r => [r, ROLE_LABEL[r]]), c.role) +
        cb("t-l", "alignL", "왼쪽 맞춤", (c.align || "left") === "left") + cb("t-c", "alignC", "가운데 맞춤", c.align === "center") + cb("t-r", "alignR", "오른쪽 맞춤", c.align === "right") + sepH;
    }
    h += cb("front", "front", "앞으로 ( ] )") + cb("back", "back", "뒤로 ( [ )") + cb("dup", "dup", "복제 (⌘D)") + cb("lock", allLocked ? "lock" : "unlock", allLocked ? "잠금 풀기" : "잠금", allLocked);
    if ((c.kind === "image" || c.kind === "diagram")) {
      h += cb("rot", "rotate", "90° 회전");
      const fr = frameOf(c);
      if (fr?.template) h += cb("fill", "fill", "칸 채우기");
    }
    if (c.group) h += cb("ungroup", "ungroup", "묶음 풀기 (⌘⇧G)");
    return h + sepH + cb("del", "trash", "삭제");
  }
  const grouped = cards.some(c => c.group);
  return cb("al-l", "alignL", "왼쪽 정렬") + cb("al-c", "alignC", "가운데 정렬") + cb("al-r", "alignR", "오른쪽 정렬") + cb("al-t", "alignT", "위 정렬") + cb("al-m", "alignM", "중간 정렬") + cb("al-b", "alignB", "아래 정렬") + sepH +
    cb("dist-h", "distH", "가로 간격 같게") + cb("dist-v", "distV", "세로 간격 같게") + sepH +
    cb("group", "group", "묶기 (⌘G)") + (grouped ? cb("ungroup", "ungroup", "풀기 (⌘⇧G)") : "") + cb("lock", allLocked ? "lock" : "unlock", allLocked ? "잠금 풀기" : "잠금", allLocked) + sepH + cb("del", "trash", "삭제");
}
function ctxSignature() {
  if (editingId) return "";
  const f = selFrame && !sel.size ? frameById(selFrame) : null;
  if (f) return `F${f.id}${f.size}${f.orientation}${f.template ? f.template.cols : 0}${f.cartouche}`;
  return "C" + selCards().map(c => `${c.id}${c.kind}${c.role || ""}${c.align || ""}${c.locked}${c.group || ""}${frameOf(c)?.template ? 1 : 0}`).join(",");
}
function renderCtx() {
  const bar = $("#bd-ctx");
  const sg = ctxSignature();
  if (sg !== ctxSig) { ctxSig = sg; bar.innerHTML = sg ? ctxHtml() : ""; }
  bar.hidden = !sg || !bar.innerHTML;
  placeCtx();
}
function selScreenBox() {
  let b = null;
  const f = selFrame && !sel.size ? frameById(selFrame) : null;
  if (f) { const [w, h] = frameSize(f); b = { x0: f.x, y0: f.y - labelSize() * 1.6, x1: f.x + w, y1: f.y + h }; }
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
  if (!box || (drag && (drag.type === "move" || drag.type === "resize" || drag.type === "frame" || drag.type === "marquee"))) { bar.style.visibility = "hidden"; return; }
  const r = $("#bd-svg").getBoundingClientRect(), bw = bar.offsetWidth, bh = bar.offsetHeight;
  let x = clamp((box.x0 + box.x1) / 2 - bw / 2, 8, Math.max(8, r.width - bw - 8));
  let y = box.y0 - bh - 10;
  if (y < 8) y = box.y1 + 10;
  if (y + bh > r.height - 8) y = clamp(box.y0 + 10, 8, Math.max(8, r.height - bh - 8));   // no room above or below: sit inside the selection
  bar.style.left = Math.round(x) + "px"; bar.style.top = Math.round(y) + "px"; bar.style.visibility = "visible";
}
function ctxAction(act) {
  const f = selFrame && !sel.size ? frameById(selFrame) : null;
  switch (act) {
    case "front": reorder(1); break;
    case "back": reorder(-1); break;
    case "dup": duplicate(); break;
    case "lock": toggleLock(); break;
    case "del": deleteSelection(); break;
    case "rot": rotate90(); break;
    case "fill": { const c = selCards()[0]; if (c) fillCells(c); break; }
    case "group": groupSel(); break;
    case "ungroup": ungroupSel(); break;
    case "t-l": case "t-c": case "t-r": { const c = selCards()[0]; if (c) { c.align = act === "t-l" ? "left" : act === "t-c" ? "center" : "right"; commit(); } break; }
    case "f-orient": if (f) { f.orientation = f.orientation === "portrait" ? "landscape" : "portrait"; commit(); } break;
    case "f-cart": if (f) { f.cartouche = !f.cartouche; commit(); } break;
    case "f-info": chrome.openInfo(); break;
    case "f-export": if (f) chrome.exportFrames([f], "pdf"); break;
    case "f-dup": if (f) duplicateFrame(f.id); break;
    case "f-del": if (f) deleteFrame(f.id); break;
    default: if (act.startsWith("al-")) alignSel(act.slice(3)); else if (act.startsWith("dist-")) distribute(act.slice(5));
  }
}
function ctxSelect(name, value) {
  const f = selFrame && !sel.size ? frameById(selFrame) : null;
  if (name === "f-size" && f && PAPER[value]) { setFrameSize(f, value); commit(); }
  else if (name === "f-tpl" && f && TEMPLATE_KEYS.includes(value)) { setTemplate(f, value); commit(); }
  else if (name === "t-style" && ROLES.includes(value)) { const c = selCards()[0]; if (c?.kind === "text") { c.role = value; delete c.size; commit(); } }
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
function snapMove(box, movingIds, tol, grid, gf) {
  const others = [];
  for (const c of S.cards) if (!movingIds.has(c.id)) { const b = visBox(c); others.push({ x: b.x, y: b.y, w: b.w, h: b.h }); }
  for (const f of S.frames) { const [w, h] = frameSize(f); others.push({ x: f.x, y: f.y, w, h }); }
  const cells = gf && gridCells(gf);
  if (cells) {   // cell snap: one pseudo box per column / row, so edges and centres are candidates
    for (const [a, b] of cells.xs) others.push({ x: gf.x + a, y: gf.y + cells.y0, w: b - a, h: cells.y1 - cells.y0 });
    for (const [a, b] of cells.ys) others.push({ x: gf.x + cells.x0, y: gf.y + a, w: cells.x1 - cells.x0, h: b - a });
  }
  let bx = null, by = null;
  const xs = [box.x, box.x + box.w / 2, box.x + box.w], ys = [box.y, box.y + box.h / 2, box.y + box.h];
  for (const o of others) {
    for (const ox of [o.x, o.x + o.w / 2, o.x + o.w]) for (const mx of xs) { const d = ox - mx; if (Math.abs(d) <= tol && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, at: ox, o }; }
    for (const oy of [o.y, o.y + o.h / 2, o.y + o.h]) for (const my of ys) { const d = oy - my; if (Math.abs(d) <= tol && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, at: oy, o }; }
  }
  let dx = bx ? bx.d : 0, dy = by ? by.d : 0;
  if (!bx && grid && gf && !cells) { dx = gf.x + Math.round((box.x - gf.x) / grid) * grid - box.x; }
  if (!by && grid && gf && !cells) { dy = gf.y + Math.round((box.y - gf.y) / grid) * grid - box.y; }
  const guides = [];
  const nb = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
  if (bx) guides.push({ x1: bx.at, x2: bx.at, y1: Math.min(nb.y, bx.o.y), y2: Math.max(nb.y + nb.h, bx.o.y + bx.o.h) });
  if (by) guides.push({ y1: by.at, y2: by.at, x1: Math.min(nb.x, by.o.x), x2: Math.max(nb.x + nb.w, by.o.x + by.o.w) });
  return { dx, dy, guides };
}
// resize: snap the dragged corner to column / row edges, else to the grid
function snapPoint(px, py, gf, tol, grid) {
  const cells = gridCells(gf);
  if (!cells) return grid ? [gf.x + Math.round((px - gf.x) / grid) * grid, gf.y + Math.round((py - gf.y) / grid) * grid] : [px, py];
  const near = (v, list, off) => { let best = v, bd = tol; for (const [a, b] of list) for (const e of [a + off, b + off]) if (Math.abs(e - v) <= bd) { bd = Math.abs(e - v); best = e; } return best; };
  return [near(px, cells.xs, gf.x), near(py, cells.ys, gf.y)];
}
function drawGuides(gs) {
  layerGuides.replaceChildren();
  for (const g of gs || []) el("line", { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, class: "bd-guide", "vector-effect": "non-scaling-stroke" }, layerGuides);
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
  if (e.button === 1 || (e.button === 0 && (spaceDown || ui.tool === "h"))) { startPan(e); return; }
  if (e.button !== 0) return;
  const [wx, wy] = toWorld(e);
  if (ui.tool === "t" || ui.tool === "n" || ui.tool === "f") { e.preventDefault(); placeByTool([wx, wy]); return; }
  const handle = e.target.closest("[data-handle]");
  const cardEl = e.target.closest(".bd-card");
  const flabel = e.target.closest("[data-frame-label]");
  cap(e.pointerId);
  if (handle) {
    const c = cardById([...sel][0]);
    drag = { type: "resize", h: handle.dataset.handle, c, o: { x: c.x, y: c.y, w: c.w, h: c.h }, aspect: c.kind === "diagram" || c.kind === "image" };
  } else if (cardEl) {
    const id = cardEl.dataset.id;
    const grp = expandGroups(new Set([id]));
    if (e.shiftKey) { if (sel.has(id)) for (const g of grp) sel.delete(g); else for (const g of grp) sel.add(g); }
    else if (!sel.has(id)) sel = grp;
    selFrame = null;
    const ids = new Set([...sel].filter(i => !cardById(i)?.locked));   // locked cards stay put
    drag = { type: "move", start: [wx, wy], ids, orig: new Map([...ids].map(i => { const c = cardById(i); return [i, { x: c.x, y: c.y }]; })), moved: false };
    renderSel(); renderCtx(); renderPanel();
  } else if (flabel) {
    const f = frameById(flabel.dataset.frameLabel);
    selFrame = f.id; sel.clear();
    const [w, h] = frameSize(f);
    const inside = S.cards.filter(c => { const [cx, cy] = center(c); return cx >= f.x && cx <= f.x + w && cy >= f.y && cy <= f.y + h; });
    drag = { type: "frame", f, start: [wx, wy], o: { x: f.x, y: f.y }, cards: inside.map(c => ({ c, x: c.x, y: c.y })), moved: false };
    renderFrames(); renderSel(); renderCtx(); renderPanel();
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
      const s = snapMove(gb, drag.ids, tol, gf?.grid_mm, gf);
      dx += s.dx; dy += s.dy; guides = s.guides;
    }
    for (const id of drag.ids) { const c = cardById(id), o = drag.orig.get(id); c.x = r2(o.x + dx); c.y = r2(o.y + dy); }
    drawGuides(guides);
    renderCards(); renderSel(); placeCtx(); scheduleMini();
  } else if (drag.type === "resize") {
    const { c, o, h } = drag;
    const gf = frameOf(c);
    let px = wx, py = wy, sx = wx, sy = wy;
    if (!noSnap && gf) [sx, sy] = snapPoint(px, py, gf, tol, gf.grid_mm);
    const west = h.includes("w"), north = h.includes("n");
    const ax = west ? o.x + o.w : o.x, ay = north ? o.y + o.h : o.y;   // anchored opposite corner
    let nw, nh;
    if (drag.aspect) {   // snap on whichever axis is closer to a snap line, derive the other from the aspect
      const ar = o.w / o.h, useX = Math.abs(sx - px) <= Math.abs(sy - py);
      if (useX) { nw = Math.max(5, west ? ax - sx : sx - ax); nh = nw / ar; } else { nh = Math.max(5, north ? ay - sy : sy - ay); nw = nh * ar; }
      if (nh < 5) { nh = 5; nw = nh * ar; } if (nw < 5) { nw = 5; nh = nw / ar; }
    } else { nw = Math.max(5, west ? ax - sx : sx - ax); nh = Math.max(5, north ? ay - sy : sy - ay); }
    c.w = r2(nw); c.h = r2(nh);
    c.x = r2(west ? ax - nw : ax); c.y = r2(north ? ay - nh : ay);
    renderCards(); renderSel(); scheduleMini();
  } else if (drag.type === "frame") {
    const dx = wx - drag.start[0], dy = wy - drag.start[1];
    drag.moved = true;
    drag.f.x = r2(drag.o.x + dx); drag.f.y = r2(drag.o.y + dy);
    for (const k of drag.cards) { k.c.x = r2(k.x + dx); k.c.y = r2(k.y + dy); }
    renderFrames(); renderCards(); renderSel(); placeCtx(); scheduleMini();
  } else if (drag.type === "marquee") {
    const x = Math.min(wx, drag.start[0]), y = Math.min(wy, drag.start[1]), w = Math.abs(wx - drag.start[0]), h = Math.abs(wy - drag.start[1]);
    drag.rect.setAttribute("x", x); drag.rect.setAttribute("y", y); drag.rect.setAttribute("width", w); drag.rect.setAttribute("height", h);
    sel = new Set(drag.base);
    for (const c of S.cards) { const b = visBox(c); if (b.x < x + w && b.x + b.w > x && b.y < y + h && b.y + b.h > y) sel.add(c.id); }
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
  if (d.type === "pan") { if (!d.moved && d.clear) { sel.clear(); selFrame = null; renderFrames(); renderSel(); renderCtx(); renderPanel(); } else placeCtx(); return; }
  if (d.type === "marquee") { d.rect.remove(); placeCtx(); return; }
  if (d.type === "move" && !d.moved) { render(); return; }   // plain click: selection only
  commit();
}
function onWheel(e) {
  e.preventDefault();
  const r = $("#bd-svg").getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const notch = e.deltaMode === 1 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
  if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), sx, sy);
  else if (notch) zoomAt(Math.exp(-(e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY) * 0.0016), sx, sy);
  else { view.x -= e.deltaX; view.y -= e.deltaY; applyView(); }
}

// text editing
function startEdit(id) {
  const c = cardById(id), g = els.get(id);
  if (!c || !g || c.locked || (c.kind !== "text" && c.kind !== "memo")) return;
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
    C("작업 ↔ 조판 전환", () => setLayout(ui.layout === "work" ? "print" : "work"), "⇧R", "layout 조판 작업"),
    C("보드 정보 · 카르투슈", () => chrome.openInfo(), "", "cartouche info meta 카르투슈 정보"),
    C("글 스타일", () => chrome.openStyles(), "", "styles text 글 스타일"),
    C("단축키 보기", () => chrome.openShortcuts(), "?", "shortcuts 단축키"),
    C("왼쪽 패널 접기·펼치기", () => { ui.panel = !ui.panel; render(); }, "", "panel 패널"),
    C("미니맵 켜기·끄기", () => { ui.minimap = !ui.minimap; render(); }, "", "minimap 미니맵"),
    C("전체 보기", fitAll, "⇧1", "fit zoom 전체"),
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
  const typing = t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName);
  const onSelect = t.tagName === "SELECT", onButton = !!t.closest?.("button");
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (mod && k === "k") { e.preventDefault(); finishEdit(); chrome.openPalette(commands()); return; }
  if (e.key === " " && !typing && !onSelect && !onButton) { spaceDown = true; e.preventDefault(); return; }
  if (e.key === "Escape") {
    if (editingId) finishEdit();
    else if (closeMenus()) { /* closed a menu */ }
    else if (ui.tool !== "v") setTool("v");
    else { sel.clear(); selFrame = null; renderSel(); renderFrames(); renderCtx(); renderPanel(); }
    return;
  }
  if (typing) return;
  if (onSelect && !mod) return;
  if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === "y") { e.preventDefault(); redo(); return; }
  if (mod && k === "d") { e.preventDefault(); duplicate(); return; }
  if (mod && k === "g") { e.preventDefault(); e.shiftKey ? ungroupSel() : groupSel(); return; }
  if (mod && k === "a") { e.preventDefault(); sel = new Set(S.cards.map(c => c.id)); selFrame = null; renderSel(); renderCtx(); return; }
  if (mod) return;
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); return; }
  if (e.key === "]") { reorder(1); return; }
  if (e.key === "[") { reorder(-1); return; }
  if (e.key === "?") { chrome.openShortcuts(); return; }
  if (e.shiftKey && e.key === "R") { e.preventDefault(); setLayout(ui.layout === "work" ? "print" : "work"); return; }
  if (e.shiftKey && e.code === "Digit1") { e.preventDefault(); fitAll(); return; }
  if (!e.shiftKey && !e.altKey && !onButton || (onButton && /^[vhtfnip]$/.test(k))) {
    if (k === "v") { setTool("v"); return; }
    if (k === "h") { setTool("h"); return; }
    if (k === "t") { setTool("t"); return; }
    if (k === "f") { setTool("f"); return; }
    if (k === "n") { setTool("n"); return; }
    if (k === "i") { $("#bd-file-img").click(); return; }
    if (k === "p") { present(); return; }
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
  if (!isOpen || chrome?.isBlocking()) return;
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
      site: S.site, meta: S.meta, styles: S.styles, diagrams, images, assets: S.assets,
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
  sel.clear(); selFrame = null; assetSig = ""; pageSig = ""; ctxSig = ""; ui.emptyDismissed = false;
  hist = [snap()]; hi = 0;
}
async function openFile(file) {
  try {
    status("파일 여는 중…");
    const { unzipSync, strFromU8 } = await import(FFLATE);
    const z = unzipSync(new Uint8Array(await file.arrayBuffer()));
    if (!z["project.json"]) throw new Error("project.json이 없습니다.");
    const pj = JSON.parse(strFromU8(z["project.json"]));
    if (pj.format !== "atelier-project") throw new Error("Atelier 프로젝트 파일이 아닙니다.");
    if (!(num(pj.version, 1, 0, 1e6) <= DOC_VERSION)) throw new Error("더 새로운 버전의 파일입니다.");
    if ((S.cards.length || Object.keys(S.assets).length) && !confirm("지금 보드를 이 파일로 바꿀까요? 저장하지 않은 내용은 사라집니다.")) { status(""); return; }
    const next = sanitizeDoc({ ...pj, board: pj.board, assets: pj.assets });
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
    status(`열림 · 카드 ${S.cards.length}장`);
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
  selFrame = S.frames[0].id;
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
  for (const b of document.querySelectorAll("#board [aria-haspopup]")) b.setAttribute("aria-expanded", "false");
  return any;
}
const TOOLS = [["v", "select", "선택", "V"], ["h", "hand", "손", "H"], ["t", "text", "텍스트", "T"], ["f", "frame", "프레임", "F"], ["n", "note", "메모", "N"], ["i", "image", "이미지", "I"]];

function build() {
  const sec = document.createElement("section");
  sec.id = "board"; sec.hidden = true;
  sec.setAttribute("aria-label", "보드");
  sec.innerHTML = `
    <header class="bd-bar">
      <nav class="bd-tabs" aria-label="모드">
        <button type="button" data-mode="terrain">대지</button>
        <button type="button" data-mode="diagrams">다이어그램</button>
        <button type="button" data-mode="board" aria-current="page">보드</button>
      </nav>
      <div class="bd-namewrap bd-menu-wrap">
        <input id="bd-name" class="bd-name" type="text" aria-label="보드 이름" maxlength="80">
        <button id="bd-name-menu" class="bd-ib" type="button" aria-haspopup="true" aria-expanded="false" aria-label="보드 메뉴" title="보드 메뉴">${icon("chevron")}</button>
        <div id="bd-name-pop" class="bd-menu" hidden>
          <button type="button" data-m="new">새 보드</button>
          <button type="button" data-m="open">파일 열기</button>
          <button type="button" data-m="save">파일로 저장</button>
          <button type="button" data-m="img">이미지 추가</button>
        </div>
      </div>
      <span id="bd-save-state" class="bd-savestate" role="status" aria-live="polite"></span>
      <span class="bd-grow"></span>
      <button id="bd-undo" class="bd-ib" type="button" aria-label="실행 취소" title="실행 취소 (⌘Z)">${icon("undo")}</button>
      <button id="bd-redo" class="bd-ib" type="button" aria-label="다시 실행" title="다시 실행 (⌘⇧Z)">${icon("redo")}</button>
      <div class="bd-seg bd-hide-m" role="group" aria-label="보기 모드">
        <button type="button" data-layout="work" aria-pressed="true" title="작업 (Shift+R)">작업</button>
        <button type="button" data-layout="print" aria-pressed="false" title="조판 (Shift+R)">조판</button>
      </div>
      <button id="bd-present" class="bd-btn bd-hide-m" type="button" title="발표 (P)">${icon("play", 18)}<span>발표</span></button>
      <button id="bd-export" class="bd-primary" type="button">출력</button>
      <div class="bd-menu-wrap">
        <button id="bd-more" class="bd-ib" type="button" aria-haspopup="true" aria-expanded="false" aria-label="더보기" title="더보기">${icon("more")}</button>
        <div id="bd-more-pop" class="bd-menu bd-menu-r" hidden>
          <button type="button" data-m="shortcuts">단축키 보기<kbd>?</kbd></button>
          <button type="button" data-m="palette">명령 팔레트<kbd>⌘K</kbd></button>
          <button type="button" data-m="info">보드 정보</button>
          <button type="button" data-m="styles">글 스타일</button>
          <button type="button" data-m="dates" disabled title="준비 중 (빌드 4)">날짜 보기 · 준비 중</button>
        </div>
      </div>
    </header>
    <div id="bd-banner" class="bd-banner" role="alert" hidden>자동저장 안 됨 — 파일로 저장하세요</div>
    <div class="bd-main">
      <nav class="bd-rail" aria-label="도구">
        <button id="bd-panel-toggle" class="bd-ib" type="button" aria-pressed="true" data-tip="패널" aria-label="왼쪽 패널 접기·펼치기">${icon("panel")}</button>
        <span class="bd-rail-sep"></span>
        ${TOOLS.map(([k, ic, name, key]) => `<button class="bd-ib" type="button" data-tool="${k}" data-tip="${name} ${key}" aria-label="${name} (${key})" aria-pressed="${k === "v"}">${icon(ic)}</button>`).join("")}
      </nav>
      <aside id="bd-panel" class="bd-panel" aria-label="자료와 페이지">
        <div class="bd-ptabs" role="tablist" aria-label="패널">
          <button id="bd-tab-assets" type="button" role="tab" aria-selected="true" aria-controls="bd-pane-assets">자료</button>
          <button id="bd-tab-pages" type="button" role="tab" aria-selected="false" aria-controls="bd-pane-pages">페이지</button>
        </div>
        <div id="bd-pane-assets" class="bd-pane" role="tabpanel" aria-labelledby="bd-tab-assets">
          <div class="bd-search">${icon("search", 16)}<input id="bd-q" type="text" placeholder="자료 검색" aria-label="자료 검색"></div>
          <div class="bd-chips" role="group" aria-label="종류">
            <button type="button" class="bd-chip" data-filter="all" aria-pressed="true">전체</button>
            <button type="button" class="bd-chip" data-filter="diagram" aria-pressed="false">다이어그램</button>
            <button type="button" class="bd-chip" data-filter="image" aria-pressed="false">이미지</button>
          </div>
          <div id="bd-asset-grid" class="bd-asset-grid"></div>
        </div>
        <div id="bd-pane-pages" class="bd-pane" role="tabpanel" aria-labelledby="bd-tab-pages" hidden>
          <div id="bd-page-list" class="bd-page-list"></div>
          <div class="bd-addpage">
            <button id="bd-addpage" class="bd-btn" type="button" aria-expanded="false">+ 페이지</button>
            <div id="bd-addpop" class="bd-addpop" hidden>
              <select id="bd-new-size" aria-label="용지">${SIZES.map(s => `<option${s === "A3" ? " selected" : ""}>${s}</option>`).join("")}</select>
              <select id="bd-new-orient" aria-label="방향"><option value="landscape">가로</option><option value="portrait">세로</option></select>
              <button id="bd-addpage-ok" class="bd-primary" type="button">추가</button>
            </div>
          </div>
        </div>
      </aside>
      <div class="bd-stage" id="bd-stage">
        <svg id="bd-svg" xmlns="${NS}" aria-label="보드 캔버스" role="application" tabindex="0" data-tool="v">
          <g id="bd-world"><g id="bd-frames"></g><g id="bd-cards"></g><g id="bd-guides"></g><g id="bd-selection"></g></g>
        </svg>
        <div id="bd-ctx" class="bd-ctx" role="toolbar" aria-label="선택 도구" hidden></div>
        <div id="bd-empty" class="bd-emptycard" hidden>
          <h2>보드를 시작하세요</h2>
          <p>다이어그램, 사진, 글을 한 판 위에 모으고 최종 판넬로 출력합니다.</p>
          <button type="button" class="bd-btn" data-empty="diagrams">다이어그램 가져오기</button>
          <button type="button" class="bd-btn" data-empty="image">이미지 추가<small>끌어 놓거나 ⌘V로 붙여넣기</small></button>
          <button type="button" class="bd-primary" data-empty="final">최종 판넬로 시작<small>A1 세로 · 6단 · 카르투슈</small></button>
        </div>
        <div id="bd-minimap" class="bd-minimap"><svg id="bd-mini" viewBox="0 0 176 116" aria-label="미니맵" role="img"></svg></div>
        <div class="bd-zoombar" role="group" aria-label="확대·축소">
          <button id="bd-zoom-out" class="bd-ib" type="button" aria-label="축소" title="축소">${icon("minus", 18)}</button>
          <button id="bd-zoom" class="bd-zoom" type="button" title="100%로" aria-label="확대 비율, 누르면 100%">100%</button>
          <button id="bd-zoom-in" class="bd-ib" type="button" aria-label="확대" title="확대">${icon("plus", 18)}</button>
          <button id="bd-fit" class="bd-ib" type="button" aria-label="전체 보기" title="전체 보기 (⇧1)">${icon("fit", 18)}</button>
          <button id="bd-mini-toggle" class="bd-ib" type="button" aria-pressed="true" aria-label="미니맵" title="미니맵">${icon("map", 18)}</button>
        </div>
      </div>
      <div id="bd-list" class="bd-list" aria-label="페이지별 카드 목록"></div>
    </div>
    <p id="bd-status" class="bd-status" role="status" aria-live="polite"></p>
    <input id="bd-file-img" type="file" accept="image/*" multiple hidden>
    <input id="bd-file-proj" type="file" accept=".atelier,.zip,application/zip" hidden>`;
  document.body.append(sec);
  layerFrames = $("#bd-frames"); layerCards = $("#bd-cards"); layerGuides = $("#bd-guides"); layerSel = $("#bd-selection");
  chrome = createChrome({
    root: () => $("#board"), ctx: () => ({ S, payloads }), status, download, safeName, selectedFrame, finishEdit, loadFontCss, buildPdf,
    commitMeta: v => { S.meta = { ...S.meta, ...v }; commit(); },
    commitStyles: v => { S.styles = v; commit(); },
    focusStage: () => $("#bd-svg").focus({ preventScroll: true })
  });
  wire();
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
    const g = e.target.closest(".bd-card");
    if (g) startEdit(g.dataset.id);
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
    const at = toWorld(e);
    ui.emptyDismissed = true;
    if (e.dataTransfer.files?.length) { addImageFiles(e.dataTransfer.files, at); return; }
    const id = e.dataTransfer.getData("text/atelier-asset");
    if (id && S.assets[id]) { const c = placeAsset(id, at); if (c) { sel = new Set([c.id]); selFrame = null; } commit(); }
  });
  // rail + top bar
  for (const b of document.querySelectorAll("#board [data-tool]")) b.onclick = () => { if (b.dataset.tool === "i") { $("#bd-file-img").click(); return; } setTool(b.dataset.tool); };
  $("#bd-panel-toggle").onclick = () => { ui.panel = !ui.panel; renderChrome(); renderPanel(); requestAnimationFrame(() => applyView()); };
  for (const b of document.querySelectorAll("#board [data-mode]")) b.onclick = () => { if (b.dataset.mode !== "board") gotoMode(b.dataset.mode); };
  for (const b of document.querySelectorAll("#board [data-layout]")) b.onclick = () => setLayout(b.dataset.layout);
  $("#bd-file-proj").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) openFile(f); };
  $("#bd-file-img").onchange = e => { const fs = [...e.target.files]; e.target.value = ""; if (fs.length) { ui.emptyDismissed = true; addImageFiles(fs); } };
  $("#bd-undo").onclick = undo;
  $("#bd-redo").onclick = redo;
  $("#bd-present").onclick = present;
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
  menu("#bd-more", "#bd-more-pop", m => { if (m === "shortcuts") chrome.openShortcuts(); else if (m === "palette") chrome.openPalette(commands()); else if (m === "info") chrome.openInfo(); else if (m === "styles") chrome.openStyles(); });
  document.addEventListener("click", e => { if (!e.target.closest("#board .bd-menu-wrap")) closeMenus(); });
  // panel
  for (const b of document.querySelectorAll("#board [role=tab]")) b.onclick = () => { ui.panelTab = b.id === "bd-tab-pages" ? "pages" : "assets"; assetSig = ""; pageSig = ""; renderPanel(); };
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
    else if (r) { if (r.getAttribute("aria-disabled") === "true") { status(r.title); return; } delete S.assets[r.dataset.removeAsset]; commit(); }
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
  ctx.addEventListener("change", e => { const s = e.target.closest("[data-sel]"); if (s) ctxSelect(s.dataset.sel, s.value); });
  ctx.addEventListener("pointerdown", e => e.stopPropagation());
  // empty state
  $("#bd-empty").addEventListener("click", e => {
    const b = e.target.closest("[data-empty]");
    if (!b) return;
    ui.emptyDismissed = true;
    if (b.dataset.empty === "diagrams") gotoMode("diagrams");
    else if (b.dataset.empty === "image") { $("#bd-file-img").click(); renderEmpty(); }
    else startFinalPanel();
  });
  // zoom bar + minimap
  const mid = () => { const r = svg.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
  $("#bd-zoom-in").onclick = () => zoomAt(1.25, ...mid());
  $("#bd-zoom-out").onclick = () => zoomAt(0.8, ...mid());
  $("#bd-zoom").onclick = () => zoomAt(PX_PER_MM / view.z, ...mid());
  $("#bd-fit").onclick = fitAll;
  $("#bd-mini-toggle").onclick = () => { ui.minimap = !ui.minimap; renderChrome(); scheduleMini(); };
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
    if (t) { const c = cardById(t.dataset.lid); if (c && !c.locked) { c.text = t.value; commit(); } }
  });
  mobileMQ.addEventListener?.("change", () => { render(); if (isOpen && !mobileMQ.matches && !fitted) requestAnimationFrame(() => { if (fitAll()) fitted = true; }); });
  addEventListener("resize", () => { if (isOpen && !mobileMQ.matches) applyView(); });
}

// ---- public API ----------------------------------------------------------------------------------------------------------
const loaded = (async () => {
  build();
  try {
    const rec = await idb.get("project");
    if (rec?.S) {
      S = sanitizeDoc(rec.S);   // v1 records are migrated here
      for (const [id, p] of Object.entries(rec.payloads || {})) if (S.assets[id]) payloads.set(id, cleanPayload(p));
      if (Number.isFinite(rec.savedAt)) { savedAt = rec.savedAt; saveState = "saved"; }
      setAutosave(true);
    } else { await idb.put("probe", 1); setAutosave(true); }
  } catch (e) { console.warn("IndexedDB unavailable", e); setAutosave(false); }
  hist = [snap()]; hi = 0;
  ui.panel = wideMQ.matches;
  render();
})();

async function open() {
  await loaded;
  if (!isOpen) { prevMode = document.body.dataset.mode ?? null; isOpen = true; }
  if (!S.frames.length) {
    // the first frame is the baseline: put it into every history entry so undo can never remove it
    const f = addFrame(); selFrame = f.id;
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
async function add(item) {
  await loaded;
  if (!item || !item.kind) throw new Error("보드에 넣을 항목이 올바르지 않습니다.");
  if (item.kind === "diagram") {
    const svgClean = cleanSvgString(item.svg), prev = safeImg(item.preview);
    if (!svgClean || !prev) throw new Error("다이어그램 데이터가 없습니다.");
    if (item.meta?.address || item.meta?.radius) S.site = { address: item.meta.address || "", radius: item.meta.radius || "" };
    const id = registerAsset("diagram", item.title || "다이어그램", item.w || 420, item.h || 297, { svg: svgClean, preview: prev }, item.meta || null);
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
