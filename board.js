// Board mode of Atelier 4·2: pin-up canvas with A3/A1 frames, vector PDF / PNG export, .atelier project file.
// Third mode of the site (body.dataset.mode = "board"). Plain ES module, no framework.
//   globalThis.atelierBoard = { add(item), open(), close(), count() }
// Screen = raster previews in an SVG world (mm units); export = vector SVG composed per frame.
import { buildPdf } from "./dgpdf_v02.js?v=20261121a";
import { loadFontCss } from "./dgcore_v04.js?v=20261116p";

const FFLATE = "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";
const NS = "http://www.w3.org/2000/svg";
const FRAME_MM = { A3: [420, 297], A1: [841, 594] };
const TYPE = {   // text type scale (mm)
  title: { size: 9, weight: 700, w: 220, h: 14, color: "#1d1d1f", label: "제목" },
  caption: { size: 4, weight: 400, w: 160, h: 8, color: "#6e6e73", label: "캡션" },
  body: { size: 5, weight: 400, w: 140, h: 40, color: "#1d1d1f", label: "본문" }
};
const MEMO_COLORS = ["#fff3a8", "#ffd6d6", "#d6ecff", "#dff5d8"];
const MAX_HIST = 100;
const GRID_DEFAULT = 5;

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  parent?.append(e);
  return e;
};
const esc = s => String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// ---- untrusted input (opened .atelier files, IndexedDB records) ----
const IMG_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const safeImg = u => (typeof u === "string" && IMG_RE.test(u)) ? u : "";
const num = (v, d, lo = -1e6, hi = 1e6) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const safeId = (v, fb) => /^[A-Za-z0-9_-]{1,40}$/.test(String(v)) ? String(v) : fb;
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
// Remove everything executable / external from an SVG tree.
function sanitizeSvgTree(root) {
  for (const e of [...root.querySelectorAll("script,foreignObject,iframe,object,embed,set,animate,animateMotion,animateTransform,audio,video,link,meta")]) e.remove();
  for (const e of [root, ...root.querySelectorAll("*")]) {
    for (const a of [...e.attributes]) {
      const n = a.name.toLowerCase(), v = a.value.trim();
      let bad = n.startsWith("on") || /javascript:|vbscript:/i.test(v) || /url\(\s*['"]?(?!#)/i.test(v);
      if (!bad && (n === "href" || n === "xlink:href") && !(v.startsWith("#") || /^data:image\/(png|jpeg|webp|gif);/i.test(v))) bad = true;
      if (bad) e.removeAttribute(a.name);
    }
    if (e.localName === "style") e.textContent = e.textContent.replace(/@import[^;]*;?/gi, "").replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, "none");
  }
}
function cleanSvgString(text) {
  if (typeof text !== "string") return "";
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || doc.querySelector("parsererror") || root.localName !== "svg") return "";
  sanitizeSvgTree(root);
  return new XMLSerializer().serializeToString(root);
}
// Normalise a document read from outside: whitelisted kinds, numbers coerced, ids restricted.
function sanitizeDoc(raw) {
  const out = { name: String(raw?.name || "Atelier 보드").slice(0, 80), seq: 1, frames: [], cards: [], assets: {}, site: null };
  if (raw?.site && typeof raw.site === "object") out.site = { address: String(raw.site.address || "").slice(0, 200), radius: String(raw.site.radius || "").slice(0, 40) };
  for (const [k, a] of Object.entries(raw?.assets || {})) {
    const id = safeId(k, null);
    if (!id || !a || (a.kind !== "diagram" && a.kind !== "image")) continue;
    const m = a.meta && typeof a.meta === "object" ? { address: String(a.meta.address || "").slice(0, 200), radius: String(a.meta.radius || "").slice(0, 40), palette: String(a.meta.palette || "").slice(0, 40) } : null;
    out.assets[id] = { kind: a.kind, title: String(a.title || id).slice(0, 200), w: num(a.w, 100, 1, 5000), h: num(a.h, 70, 1, 5000), meta: m };
  }
  const fid = new Set();
  for (const f of raw?.board?.frames || raw?.frames || []) {
    const id = safeId(f?.id, null);
    if (!id || fid.has(id)) continue;
    fid.add(id);
    out.frames.push({ id, size: FRAME_MM[f.size] ? f.size : "A3", orientation: f.orientation === "portrait" ? "portrait" : "landscape", grid_mm: num(f.grid_mm, GRID_DEFAULT, 0.5, 100), x: num(f.x, 0), y: num(f.y, 0), n: Math.round(num(f.n, out.frames.length + 1, 1, 9999)) });
  }
  const cid = new Set();
  let z = 0;
  for (const c of raw?.board?.cards || raw?.cards || []) {
    const id = safeId(c?.id, null);
    if (!id || cid.has(id) || !["diagram", "image", "text", "memo"].includes(c.kind)) continue;
    const card = { id, kind: c.kind, x: num(c.x, 0), y: num(c.y, 0), w: num(c.w, 50, 1, 5000), h: num(c.h, 20, 1, 5000), z: ++z, rot: num(c.rot, 0, -360, 360), crop: null };
    if (c.kind === "diagram" || c.kind === "image") {
      card.ref = safeId(c.ref, "");
      if (!out.assets[card.ref] || out.assets[card.ref].kind !== c.kind) continue;
    } else {
      card.role = c.kind === "memo" ? "memo" : (TYPE[c.role] ? c.role : "body");
      card.text = String(c.text ?? "").slice(0, 20000);
      if (c.size != null) card.size = num(c.size, TYPE[card.role]?.size || 5, 1, 200);
      if (c.kind === "memo") card.color = COLOR_RE.test(c.color) ? c.color : MEMO_COLORS[0];
    }
    cid.add(id);
    out.cards.push(card);
  }
  // keep stacking order of the file
  const order = new Map((raw?.board?.cards || raw?.cards || []).map((c, i) => [c?.id, num(c?.z, i)]));
  out.cards.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).forEach((c, i) => { c.z = i + 1; });
  out.seq = nextSeq(out, raw?.seq);
  return out;
}
function nextSeq(doc, hint) {
  let m = num(hint, 1, 1, 1e9);
  const scan = id => { const g = /(\d+)$/.exec(id); if (g) m = Math.max(m, Number(g[1]) + 1); };
  for (const f of doc.frames) scan(f.id);
  for (const c of doc.cards) scan(c.id);
  for (const id of Object.keys(doc.assets)) scan(id);
  return m;
}
function cleanPayload(p) {
  const o = {};
  if (p?.svg) { const v = cleanSvgString(p.svg); if (v) o.svg = v; }
  if (p?.preview) { const v = safeImg(p.preview); if (v) o.preview = v; }
  if (p?.img) { const v = safeImg(p.img); if (v) o.img = v; }
  return o;
}
const r2 = n => Math.round(n * 100) / 100;
const pad2 = n => String(n).padStart(2, "0");

// ---- state -------------------------------------------------------------------------------------
// S is the document (snapshotted for undo). payloads hold the heavy strings, keyed by asset id.
let S = { name: "Atelier 보드", seq: 1, frames: [], cards: [], assets: {}, site: null };
const payloads = new Map();       // assetId -> { svg?, preview?, img? }
let sel = new Set();              // selected card ids (UI only)
let selFrame = null;              // selected frame id (UI only)
let view = { x: 40, y: 40, z: 1 };
let hist = [], hi = -1;
let dirty = false, autosaveOK = true, saveTimer = 0, editingId = null, spaceDown = false;
let fitted = false, prevMode = null, isOpen = false;
let frameDefaults = { size: "A3", orientation: "landscape", grid_mm: GRID_DEFAULT };
let drawerSig = "";

const frameSize = f => { const [a, b] = FRAME_MM[f.size] || FRAME_MM.A3; return f.orientation === "portrait" ? [b, a] : [a, b]; };
const frameLabel = f => `${f.size} ${f.orientation === "portrait" ? "세로" : "가로"} ${pad2(f.n)}`;
const cardById = id => S.cards.find(c => c.id === id);
const center = c => [c.x + c.w / 2, c.y + c.h / 2];
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
  if (selFrame && !S.frames.some(f => f.id === selFrame)) selFrame = null;
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
function setAutosave(ok) {
  autosaveOK = ok;
  const b = $("#bd-banner");
  if (b) b.hidden = ok;
}
let savePending = false;
async function doSave() {
  savePending = false;
  try {
    const pl = {};
    for (const id of Object.keys(S.assets)) if (payloads.has(id)) pl[id] = payloads.get(id);
    await idb.put("project", { S, payloads: pl, savedAt: Date.now() });
    setAutosave(true);
  } catch (e) { console.warn("autosave failed", e); setAutosave(false); }
}
function scheduleSave() { clearTimeout(saveTimer); savePending = true; saveTimer = setTimeout(doSave, 800); }
const flushSave = () => { if (savePending) { clearTimeout(saveTimer); doSave(); } };
addEventListener("pagehide", flushSave);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSave(); });
addEventListener("beforeunload", e => {
  flushSave();
  if (!autosaveOK && dirty && (S.cards.length || Object.keys(S.assets).length)) { e.preventDefault(); e.returnValue = ""; }
});

// ---- model operations -----------------------------------------------------------------------------
function addFrame(opts = {}) {
  const f = { id: "f" + S.seq++, size: opts.size || frameDefaults.size, orientation: opts.orientation || frameDefaults.orientation, grid_mm: opts.grid_mm || frameDefaults.grid_mm, x: 0, y: 0, n: 0 };
  f.n = S.frames.reduce((m, o) => Math.max(m, o.n), 0) + 1;
  let right = null;
  for (const o of S.frames) { const [w] = frameSize(o); right = Math.max(right ?? -Infinity, o.x + w); }
  if (right !== null) { f.x = right + 40; f.y = S.frames[0].y; }
  S.frames.push(f);
  return f;
}
function addCard(c) {
  const z = S.cards.reduce((m, o) => Math.max(m, o.z), 0) + 1;
  const card = { kind: "text", x: 0, y: 0, w: 50, h: 20, rot: 0, crop: null, ...c, id: "c" + S.seq++, z };
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
  if (f && !frameAt(vx, vy)) { const [fw, fh] = frameSize(f); cx = f.x + fw / 2; cy = f.y + fh / 2; }
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
function addText(role) {
  const T = TYPE[role];
  const sp = spotFor(T.w, T.h);
  const c = addCard({ kind: "text", role, text: T.label, x: sp.x, y: sp.y, w: T.w, h: T.h });
  sel = new Set([c.id]); selFrame = null;
  commit();
  startEdit(c.id);
}
function addMemo() {
  const sp = spotFor(60, 40);
  const c = addCard({ kind: "memo", role: "memo", text: "메모", color: MEMO_COLORS[S.cards.filter(k => k.kind === "memo").length % MEMO_COLORS.length], x: sp.x, y: sp.y, w: 60, h: 40 });
  sel = new Set([c.id]); selFrame = null;
  commit();
  startEdit(c.id);
}
function deleteSelection() {
  if (sel.size) { S.cards = S.cards.filter(c => !sel.has(c.id)); sel.clear(); commit(); return; }
  if (selFrame) { S.frames = S.frames.filter(f => f.id !== selFrame); selFrame = null; commit(); }
}
function duplicate() {
  if (!sel.size) return;
  const out = [];
  for (const id of sel) {
    const c = cardById(id);
    if (!c) continue;
    const copy = addCard({ ...JSON.parse(JSON.stringify(c)), x: r2(c.x + 10), y: r2(c.y + 10) });
    out.push(copy);
  }
  sel = new Set(out.map(c => c.id));
  commit();
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
  for (const id of sel) { const c = cardById(id); if (c) { c.x = r2(c.x + dx); c.y = r2(c.y + dy); } }
  commit();
}

// ---- assets (drawer) --------------------------------------------------------------------------------
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
      const id = registerAsset("image", f.name.replace(/\.[^.]+$/, ""), r2(mw), r2(mh), { img: dataUrl });
      const c = placeAsset(id, at ? [at[0] + n * 8, at[1] + n * 8] : null);
      if (c) { sel = new Set([c.id]); selFrame = null; }
      n++;
    } catch (e) { console.error(e); status(`이미지를 읽지 못했습니다: ${f.name}`); }
  }
  if (n) commit();
}

// ---- view ------------------------------------------------------------------------------------------
function applyView() {
  $("#bd-world").setAttribute("transform", `translate(${r2(view.x)} ${r2(view.y)}) scale(${view.z})`);
  $("#bd-zoom").textContent = Math.round(view.z / 3.7795 * 100) + "%";   // 100% = true size at 96 dpi
  renderFrames(); renderSel();
}
function zoomAt(factor, sx, sy) {
  const z = Math.min(20, Math.max(0.03, view.z * factor));
  const k = z / view.z;
  view.x = sx - (sx - view.x) * k; view.y = sy - (sy - view.y) * k; view.z = z;
  applyView();
}
function fitAll() {
  const r = $("#bd-svg").getBoundingClientRect();
  if (!r.width || !r.height) return false;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of S.frames) { const [w, h] = frameSize(f); x0 = Math.min(x0, f.x); y0 = Math.min(y0, f.y - 12); x1 = Math.max(x1, f.x + w); y1 = Math.max(y1, f.y + h); }
  for (const c of S.cards) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h); }
  if (!isFinite(x0)) { view = { x: 40, y: 40, z: 1 }; applyView(); return true; }
  const pad = 40, z = Math.min(20, Math.max(0.03, Math.min((r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0))));
  view = { z, x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z };
  applyView();
  return true;
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
  const fs = Math.min(60, Math.max(3, 12 / view.z));
  for (const f of S.frames) {
    const [w, h] = frameSize(f);
    const g = el("g", { class: "bd-frame" + (f.id === selFrame ? " is-sel" : ""), "data-frame": f.id }, layerFrames);
    el("rect", { x: f.x, y: f.y, width: w, height: h, class: "bd-paper" }, g);
    if (f.id === selFrame) el("rect", { x: f.x, y: f.y, width: w, height: h, class: "bd-frame-out", "vector-effect": "non-scaling-stroke" }, g);
    const t = el("text", { x: f.x, y: f.y - fs * 0.45, "font-size": fs, class: "bd-frame-label", "data-frame-label": f.id }, g);
    t.textContent = frameLabel(f);
  }
}
function typeOf(c) { return TYPE[c.role] || TYPE.body; }
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
  }
  return g;
}
function updateCardEl(g, c) {
  g.setAttribute("transform", `translate(${c.x} ${c.y})` + (c.rot ? ` rotate(${c.rot} ${c.w / 2} ${c.h / 2})` : ""));
  g.classList.toggle("is-memo", c.kind === "memo");
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
    const T = typeOf(c), fo = g.querySelector(".bd-fo"), d = g.querySelector(".bd-text");
    fo.setAttribute("width", c.w); fo.setAttribute("height", c.h);
    if (c.kind === "memo") hit.style.fill = c.color || MEMO_COLORS[0];
    const size = num(c.size, T.size, 1, 200);
    d.style.cssText = `width:${c.w}px;height:${c.h}px;font-size:${size}px;font-weight:${c.kind === "memo" ? 400 : T.weight};color:${c.kind === "memo" ? "#1d1d1f" : T.color};padding:${c.kind === "memo" ? 2 : 0}px`;
    if (editingId !== c.id && d.textContent !== (c.text || "")) d.textContent = c.text || "";
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
    if (sel.size === 1 && editingId !== id) {
      for (const [n, hx, hy] of [["nw", 0, 0], ["ne", c.w, 0], ["sw", 0, c.h], ["se", c.w, c.h]]) {
        el("rect", { x: hx - hs / 2, y: hy - hs / 2, width: hs, height: hs, class: "bd-handle", "data-handle": n, "vector-effect": "non-scaling-stroke" }, g);
      }
    }
  }
}
function render() {
  renderFrames(); renderCards(); renderSel(); renderDrawer(); renderToolbar(); renderList();
  const nm = $("#bd-name");
  if (nm && document.activeElement !== nm) nm.value = S.name;
}

// toolbar reflects the selected frame (or the defaults for new frames)
function renderToolbar() {
  const f = S.frames.find(x => x.id === selFrame);
  const src = f || frameDefaults;
  $("#bd-size").value = src.size; $("#bd-orient").value = src.orientation; $("#bd-grid").value = String(src.grid_mm);
  $("#bd-undo").disabled = hi <= 0; $("#bd-redo").disabled = hi >= hist.length - 1;
  const has = sel.size > 0;
  for (const id of ["bd-fwd", "bd-back", "bd-dup"]) $("#" + id).disabled = !has;
  $("#bd-del").disabled = !has && !selFrame;
}

// ---- drawer ------------------------------------------------------------------------------------------
function renderDrawer() {
  const ids = Object.keys(S.assets);
  const used = new Map();
  for (const c of S.cards) if (c.ref) used.set(c.ref, (used.get(c.ref) || 0) + 1);
  const sig = ids.map(i => i + ":" + (used.get(i) || 0)).join("|");
  if (sig === drawerSig) return;
  drawerSig = sig;
  const box = $("#bd-drawer-list");
  box.replaceChildren();
  if (!ids.length) { const p = document.createElement("p"); p.className = "bd-empty"; p.textContent = "다이어그램 화면의 ‘보드’ 버튼이나 이미지 올리기로 카드를 담아 보세요."; box.append(p); return; }
  const order = ids.sort((a, b) => (used.get(a) ? 1 : 0) - (used.get(b) ? 1 : 0));   // unplaced first
  for (const id of order) {
    const a = S.assets[id], p = payloads.get(id) || {}, n = used.get(id) || 0;
    const row = document.createElement("div");
    row.className = "bd-item" + (n ? " is-placed" : "");
    row.draggable = true;
    row.dataset.asset = id;
    const img = document.createElement("img");
    img.alt = ""; img.draggable = false; img.src = (a.kind === "diagram" ? p.preview : p.img) || "";
    const t = document.createElement("span");
    t.className = "bd-item-t"; t.textContent = a.title || id;
    const sub = document.createElement("small");
    sub.textContent = n ? `${n}곳에 배치` : "미배치";
    t.append(sub);
    const add = document.createElement("button");
    add.type = "button"; add.textContent = "배치"; add.dataset.place = id;
    const rm = document.createElement("button");
    rm.type = "button"; rm.textContent = "✕"; rm.dataset.removeAsset = id; rm.title = "서랍에서 지우기"; rm.disabled = n > 0;
    rm.setAttribute("aria-label", "서랍에서 지우기");
    row.append(img, t, add, rm);
    box.append(row);
  }
}

// ---- mobile list view ------------------------------------------------------------------------------------
const mobileMQ = matchMedia("(max-width: 767px)");
function renderList() {
  const box = $("#bd-list");
  if (!box || !mobileMQ.matches || !isOpen) return;
  // do not rebuild while the user types into a textarea
  if (box.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA") return;
  box.replaceChildren();
  const groups = S.frames.map(f => ({ f, cards: [] }));
  const loose = [];
  for (const c of [...S.cards].sort((a, b) => a.z - b.z)) {
    const f = frameOf(c), g = groups.find(x => x.f === f);
    (g ? g.cards : loose).push(c);
  }
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const btn = (txt, act, id, label) => { const b = mk("button", "bd-mini", txt); b.type = "button"; b.dataset.lact = act; b.dataset.lid = id; b.setAttribute("aria-label", label); return b; };
  groups.forEach(({ f, cards }, gi) => {
    const sec = mk("section", "bd-lframe");
    const head = mk("div", "bd-lhead");
    head.append(mk("h3", "", frameLabel(f)));
    const acts = mk("div", "bd-lacts");
    acts.append(btn("▲", "frame-up", f.id, "프레임 위로"), btn("▼", "frame-down", f.id, "프레임 아래로"), btn("PDF", "frame-pdf", f.id, "이 프레임 PDF"), btn("PNG", "frame-png", f.id, "이 프레임 PNG"));
    if (gi >= 0) head.append(acts);
    sec.append(head);
    cards.forEach((c, ci) => sec.append(listRow(c, ci, cards.length, mk, btn)));
    if (!cards.length) sec.append(mk("p", "bd-empty", "카드 없음"));
    box.append(sec);
  });
  if (loose.length) {
    const sec = mk("section", "bd-lframe");
    sec.append(mk("div", "bd-lhead")).firstChild.append(mk("h3", "", "프레임 밖"));
    loose.forEach((c, ci) => sec.append(listRow(c, ci, loose.length, mk, btn)));
    box.append(sec);
  }
  const dr = mk("section", "bd-lframe");
  const dh = mk("div", "bd-lhead"); dh.append(mk("h3", "", "서랍"));
  dr.append(dh);
  const ids = Object.keys(S.assets);
  if (!ids.length) dr.append(mk("p", "bd-empty", "서랍이 비어 있습니다."));
  for (const id of ids) {
    const a = S.assets[id], p = payloads.get(id) || {};
    const row = mk("div", "bd-lrow");
    const im = mk("img"); im.alt = ""; im.src = (a.kind === "diagram" ? p.preview : p.img) || "";
    row.append(im, mk("span", "bd-lt", a.title || id), btn("넣기", "place", id, "프레임에 넣기"));
    dr.append(row);
  }
  box.append(dr);
}
function listRow(c, i, n, mk, btn) {
  const row = mk("div", "bd-lrow");
  if (c.kind === "diagram" || c.kind === "image") {
    const p = payloads.get(c.ref) || {};
    const im = mk("img"); im.alt = ""; im.src = (c.kind === "diagram" ? p.preview : p.img) || "";
    row.append(im, mk("span", "bd-lt", S.assets[c.ref]?.title || c.kind));
  } else {
    const ta = mk("textarea", "bd-ltext");
    ta.value = c.text || ""; ta.dataset.lid = c.id; ta.rows = 2;
    ta.setAttribute("aria-label", c.kind === "memo" ? "메모" : TYPE[c.role]?.label || "텍스트");
    if (c.kind === "memo") ta.style.background = c.color || MEMO_COLORS[0];
    row.append(mk("span", "bd-lk", c.kind === "memo" ? "메모" : TYPE[c.role]?.label || "텍스트"), ta);
  }
  const b1 = btn("▲", "up", c.id, "앞뒤 순서 위로"), b2 = btn("▼", "down", c.id, "앞뒤 순서 아래로"), b3 = btn("✕", "del", c.id, "삭제");
  b1.disabled = i === 0; b2.disabled = i === n - 1;
  row.append(b1, b2, b3);
  return row;
}
function listAction(act, id) {
  if (act === "frame-up" || act === "frame-down") {
    const i = S.frames.findIndex(f => f.id === id), j = i + (act === "frame-up" ? -1 : 1);
    if (i < 0 || j < 0 || j >= S.frames.length) return;
    const A = S.frames[i], B = S.frames[j];
    const ownA = S.cards.filter(c => frameOf(c) === A), ownB = S.cards.filter(c => frameOf(c) === B);
    const dx = B.x - A.x, dy = B.y - A.y;
    for (const c of ownA) { c.x = r2(c.x + dx); c.y = r2(c.y + dy); }
    for (const c of ownB) { c.x = r2(c.x - dx); c.y = r2(c.y - dy); }
    [A.x, B.x] = [B.x, A.x]; [A.y, B.y] = [B.y, A.y];
    S.frames[i] = B; S.frames[j] = A;
    commit(); return;
  }
  if (act === "frame-pdf") { const f = S.frames.find(x => x.id === id); if (f) exportFrames([f], "pdf"); return; }
  if (act === "frame-png") { const f = S.frames.find(x => x.id === id); if (f) exportFrames([f], "png"); return; }
  if (act === "place") { placeAsset(id); commit(); return; }
  const c = cardById(id);
  if (!c) return;
  if (act === "del") { S.cards = S.cards.filter(x => x.id !== id); sel.delete(id); commit(); return; }
  // up / down: swap z with the neighbour inside the same frame
  const f = frameOf(c);
  const sibs = S.cards.filter(x => frameOf(x) === f).sort((a, b) => a.z - b.z);
  const i = sibs.indexOf(c), j = i + (act === "up" ? -1 : 1);
  if (j < 0 || j >= sibs.length) return;
  [c.z, sibs[j].z] = [sibs[j].z, c.z];
  commit();
}

// ---- interaction -----------------------------------------------------------------------------------------
let drag = null;
const pointers = new Map();   // active touch pointers (pinch)
let pinch = null;

function snapMove(box, movingIds, tol, grid, gf) {
  const others = [];
  for (const c of S.cards) if (!movingIds.has(c.id)) others.push({ x: c.x, y: c.y, w: c.w, h: c.h });
  for (const f of S.frames) { const [w, h] = frameSize(f); others.push({ x: f.x, y: f.y, w, h }); }
  let bx = null, by = null;
  const xs = [box.x, box.x + box.w / 2, box.x + box.w], ys = [box.y, box.y + box.h / 2, box.y + box.h];
  for (const o of others) {
    for (const ox of [o.x, o.x + o.w / 2, o.x + o.w]) for (const mx of xs) { const d = ox - mx; if (Math.abs(d) <= tol && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, at: ox, o }; }
    for (const oy of [o.y, o.y + o.h / 2, o.y + o.h]) for (const my of ys) { const d = oy - my; if (Math.abs(d) <= tol && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, at: oy, o }; }
  }
  let dx = bx ? bx.d : 0, dy = by ? by.d : 0;
  if (!bx && grid && gf) { dx = gf.x + Math.round((box.x - gf.x) / grid) * grid - box.x; }
  if (!by && grid && gf) { dy = gf.y + Math.round((box.y - gf.y) / grid) * grid - box.y; }
  const guides = [];
  const nb = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
  if (bx) guides.push({ x1: bx.at, x2: bx.at, y1: Math.min(nb.y, bx.o.y), y2: Math.max(nb.y + nb.h, bx.o.y + bx.o.h) });
  if (by) guides.push({ y1: by.at, y2: by.at, x1: Math.min(nb.x, by.o.x), x2: Math.max(nb.x + nb.w, by.o.x + by.o.w) });
  return { dx, dy, guides };
}
function drawGuides(gs) {
  layerGuides.replaceChildren();
  for (const g of gs || []) el("line", { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, class: "bd-guide", "vector-effect": "non-scaling-stroke" }, layerGuides);
}
const groupBox = ids => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of ids) { const c = cardById(id); if (c) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h); } }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

function onPointerDown(e) {
  if (e.target.closest(".bd-text[contenteditable=true]")) return;
  finishEdit();
  const svg = $("#bd-svg");
  const cap = id => { try { svg.setPointerCapture(id); } catch { /* synthetic or lost pointer */ } };
  if (e.pointerType === "touch") {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { drag = null; startPinch(); cap(e.pointerId); return; }
  }
  if (e.button === 1 || (e.button === 0 && spaceDown)) { startPan(e); return; }
  if (e.button !== 0) return;
  const handle = e.target.closest("[data-handle]");
  const cardEl = e.target.closest(".bd-card");
  const flabel = e.target.closest("[data-frame-label]");
  const [wx, wy] = toWorld(e);
  cap(e.pointerId);
  if (handle) {
    const c = cardById([...sel][0]);
    drag = { type: "resize", h: handle.dataset.handle, c, o: { x: c.x, y: c.y, w: c.w, h: c.h }, aspect: c.kind === "diagram" || c.kind === "image" };
  } else if (cardEl) {
    const id = cardEl.dataset.id;
    if (e.shiftKey) { if (sel.has(id)) sel.delete(id); else sel.add(id); }
    else if (!sel.has(id)) sel = new Set([id]);
    selFrame = null;
    const ids = new Set(sel);
    drag = { type: "move", start: [wx, wy], ids, orig: new Map([...ids].map(i => { const c = cardById(i); return [i, { x: c.x, y: c.y }]; })), moved: false };
    renderSel(); renderToolbar();
  } else if (flabel) {
    const f = S.frames.find(x => x.id === flabel.dataset.frameLabel);
    selFrame = f.id; sel.clear();
    const [w, h] = frameSize(f);
    const inside = S.cards.filter(c => { const [cx, cy] = center(c); return cx >= f.x && cx <= f.x + w && cy >= f.y && cy <= f.y + h; });
    drag = { type: "frame", f, start: [wx, wy], o: { x: f.x, y: f.y }, cards: inside.map(c => ({ c, x: c.x, y: c.y })) };
    renderFrames(); renderSel(); renderToolbar();
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
    let dx = wx - drag.start[0], dy = wy - drag.start[1];
    if (!drag.moved && Math.hypot(dx, dy) * view.z < 3) return;
    drag.moved = true;
    const first = cardById([...drag.ids][0]);
    const o0 = drag.orig.get(first.id);
    const gb = (() => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const id of drag.ids) { const c = cardById(id), o = drag.orig.get(id); x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y); x1 = Math.max(x1, o.x + c.w); y1 = Math.max(y1, o.y + c.h); } return { x: x0 + dx, y: y0 + dy, w: x1 - x0, h: y1 - y0 }; })();
    void o0;
    let guides = [];
    if (!noSnap) {
      const gf = frameAt(gb.x + gb.w / 2, gb.y + gb.h / 2);
      const s = snapMove(gb, drag.ids, tol, gf?.grid_mm, gf);
      dx += s.dx; dy += s.dy; guides = s.guides;
    }
    for (const id of drag.ids) { const c = cardById(id), o = drag.orig.get(id); c.x = r2(o.x + dx); c.y = r2(o.y + dy); }
    drawGuides(guides);
    renderCards(); renderSel();
  } else if (drag.type === "resize") {
    const { c, o, h } = drag;
    const gf = frameOf(c);
    const g = gf?.grid_mm;
    let px = wx, py = wy;
    if (!noSnap && g && gf) { px = gf.x + Math.round((px - gf.x) / g) * g; py = gf.y + Math.round((py - gf.y) / g) * g; }
    const west = h.includes("w"), north = h.includes("n");
    const ax = west ? o.x + o.w : o.x, ay = north ? o.y + o.h : o.y;   // anchored opposite corner
    let nw = Math.max(5, west ? ax - px : px - ax), nh = Math.max(5, north ? ay - py : py - ay);
    if (drag.aspect) { const ar = o.w / o.h; nh = nw / ar; if (nh < 5) { nh = 5; nw = nh * ar; } }
    c.w = r2(nw); c.h = r2(nh);
    c.x = r2(west ? ax - nw : ax); c.y = r2(north ? ay - nh : ay);
    renderCards(); renderSel();
  } else if (drag.type === "frame") {
    const dx = wx - drag.start[0], dy = wy - drag.start[1];
    drag.f.x = r2(drag.o.x + dx); drag.f.y = r2(drag.o.y + dy);
    for (const k of drag.cards) { k.c.x = r2(k.x + dx); k.c.y = r2(k.y + dy); }
    renderFrames(); renderCards(); renderSel();
  } else if (drag.type === "marquee") {
    const x = Math.min(wx, drag.start[0]), y = Math.min(wy, drag.start[1]), w = Math.abs(wx - drag.start[0]), h = Math.abs(wy - drag.start[1]);
    drag.rect.setAttribute("x", x); drag.rect.setAttribute("y", y); drag.rect.setAttribute("width", w); drag.rect.setAttribute("height", h);
    sel = new Set(drag.base);
    for (const c of S.cards) if (c.x < x + w && c.x + c.w > x && c.y < y + h && c.y + c.h > y) sel.add(c.id);
    renderSel(); renderToolbar();
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
  if (d.type === "pan") { if (!d.moved && d.clear) { sel.clear(); selFrame = null; renderFrames(); renderSel(); renderToolbar(); } return; }
  if (d.type === "marquee") { d.rect.remove(); return; }
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
  if (!c || !g || (c.kind !== "text" && c.kind !== "memo")) return;
  finishEdit();
  editingId = id;
  const d = g.querySelector(".bd-text");
  d.contentEditable = "true";
  d.classList.add("is-editing");
  renderSel();
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

function onKey(e) {
  if (!isOpen) return;
  const t = e.target;
  const typing = t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName);
  const onSelect = t.tagName === "SELECT", onButton = !!t.closest?.("button");
  if (e.key === " " && !typing && !onSelect && !onButton) { spaceDown = true; e.preventDefault(); return; }
  if (e.key === "Escape") { if (editingId) { finishEdit(); } else if (!$("#bd-out-menu").hidden) $("#bd-out-menu").hidden = true; else { sel.clear(); selFrame = null; renderSel(); renderFrames(); renderToolbar(); } return; }
  if (typing) return;
  const mod = e.metaKey || e.ctrlKey;
  if (onSelect && !mod) return;
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicate(); return; }
  if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); sel = new Set(S.cards.map(c => c.id)); renderSel(); renderToolbar(); return; }
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); return; }
  if (e.key === "]") { reorder(1); return; }
  if (e.key === "[") { reorder(-1); return; }
  const step = e.shiftKey ? 10 : 1;
  if (e.key === "ArrowLeft") { e.preventDefault(); nudge(-step, 0); }
  else if (e.key === "ArrowRight") { e.preventDefault(); nudge(step, 0); }
  else if (e.key === "ArrowUp") { e.preventDefault(); nudge(0, -step); }
  else if (e.key === "ArrowDown") { e.preventDefault(); nudge(0, step); }
}
addEventListener("keydown", onKey);
addEventListener("keyup", e => { if (e.key === " ") spaceDown = false; });
addEventListener("blur", () => { spaceDown = false; });

// ---- export ------------------------------------------------------------------------------------------------
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const safeName = () => (S.name || "atelier").replace(/[\\/:*?"<>|]+/g, "-").trim() || "atelier";

let measureCtx = null;
function wrapLines(text, size, weight, width) {
  measureCtx ||= document.createElement("canvas").getContext("2d");
  measureCtx.font = `${weight} 100px "Noto Sans KR", "Noto Sans", sans-serif`;
  const m = s => measureCtx.measureText(s).width / 100 * size;
  const lines = [];
  for (const para of String(text || "").split("\n")) {
    let line = "";
    for (const ch of para) {
      const test = line + ch;
      if (m(test) > width * 0.97 && line) {
        const sp = line.lastIndexOf(" ");
        if (sp > 0 && ch !== " ") { lines.push(line.slice(0, sp)); line = line.slice(sp + 1) + ch; }
        else { lines.push(line); line = ch === " " ? "" : ch; }
      } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

// Namespace a diagram SVG: ids, url(#..), href="#..", class names get the card id as a prefix; CSS variables become colours.
function prefixSvg(svgText, pre, x, y, w, h) {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName === "parsererror" || doc.querySelector("parsererror")) throw new Error("카드 SVG를 읽지 못했습니다.");
  sanitizeSvgTree(root);
  const cs = getComputedStyle(document.documentElement);
  const cssVars = s => s.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]+|\([^()]*\))+))?\)/g, (_, n, fb) => cs.getPropertyValue(n).trim() || (fb || "").trim() || "#000");
  const ids = new Map(), classes = new Set();
  for (const e of root.querySelectorAll("[id]")) ids.set(e.getAttribute("id"), pre + e.getAttribute("id"));
  for (const e of root.querySelectorAll("[class]")) for (const k of e.getAttribute("class").split(/\s+/).filter(Boolean)) classes.add(k);
  const fixCss = s => {
    s = cssVars(s);
    s = s.replace(/url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/g, (m, id) => ids.has(id) ? `url(#${ids.get(id)})` : m);
    s = s.replace(/#([\w-]+)(?=[\s{,.:>\[+~)])/g, (m, id) => ids.has(id) ? "#" + ids.get(id) : m);
    for (const k of classes) s = s.replace(new RegExp(`\\.${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g"), "." + pre + k);
    return s;
  };
  for (const e of [root, ...root.querySelectorAll("*")]) {
    for (const a of [...e.attributes]) {
      let v = a.value;
      if (a.name === "id") v = ids.get(v) || v;
      else if (a.name === "class") v = v.split(/\s+/).filter(Boolean).map(k => pre + k).join(" ");
      else if ((a.name === "href" || a.name === "xlink:href") && v.startsWith("#")) v = ids.has(v.slice(1)) ? "#" + ids.get(v.slice(1)) : v;
      else if (/var\(|url\(\s*['"]?#/i.test(v)) v = fixCss(v);
      if (v !== a.value) a.value = v;
    }
    if (e.nodeName === "style") e.textContent = fixCss(e.textContent);
  }
  const vb = root.getAttribute("viewBox") || "0 0 420 297";
  for (const k of ["width", "height", "x", "y"]) root.removeAttribute(k);
  root.setAttribute("x", r2(x)); root.setAttribute("y", r2(y)); root.setAttribute("width", r2(w)); root.setAttribute("height", r2(h));
  root.setAttribute("viewBox", vb);
  return new XMLSerializer().serializeToString(root);
}

function frameSvg(f, mode, fontCss = "") {
  const [W, H] = frameSize(f);
  const pdf = mode === "pdf";
  let out = `<svg xmlns="${NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${pdf ? "Noto Sans KR" : "Noto Sans KR, Noto Sans, sans-serif"}">`;
  if (fontCss) out += `<style>${fontCss}</style>`;
  out += `<rect width="${W}" height="${H}" fill="#ffffff"/>`;
  const cards = S.cards.filter(c => frameOf(c) === f && c.kind !== "memo").sort((a, b) => a.z - b.z);
  for (const c of cards) {
    const x = c.x - f.x, y = c.y - f.y;
    let node = "";
    const p = payloads.get(c.ref) || {};
    const cw = num(c.w, 1, 1, 5000), ch = num(c.h, 1, 1, 5000), rot = num(c.rot, 0, -360, 360);
    if (c.kind === "diagram") {
      if (!p.svg) continue;
      node = prefixSvg(p.svg, safeId(c.id, "c") + "-", x, y, cw, ch);
    } else if (c.kind === "image") {
      const img = safeImg(p.img);
      if (!img) continue;
      node = `<image x="${r2(x)}" y="${r2(y)}" width="${r2(cw)}" height="${r2(ch)}" preserveAspectRatio="none" href="${esc(img)}" xlink:href="${esc(img)}"/>`;
    } else if (c.kind === "text") {
      const T = typeOf(c), size = num(c.size, T.size, 1, 200);
      const lines = wrapLines(c.text, size, T.weight, cw);
      const wt = T.weight >= 600 ? (pdf ? "bold" : "700") : "normal";
      node = `<text font-size="${size}" font-weight="${wt}" fill="${T.color}">` + lines.map((ln, i) =>
        `<tspan x="${r2(x)}" y="${r2(y + size * 0.98 + i * size * 1.3)}">${esc(ln)}</tspan>`).join("") + `</text>`;
    }
    if (rot) node = `<g transform="rotate(${rot} ${r2(x + cw / 2)} ${r2(y + ch / 2)})">${node}</g>`;
    out += node;
  }
  return out + `</svg>`;
}

async function pngOfFrame(f) {
  const fontCss = await loadFontCss();
  const svg = frameSvg(f, "png", fontCss);
  const [W, H] = frameSize(f);
  let pw = W / 25.4 * 150, ph = H / 25.4 * 150;   // 150 dpi
  const k = Math.min(1, Math.sqrt(16000000 / (pw * ph)));   // iOS canvas limit
  pw = Math.floor(pw * k); ph = Math.floor(ph * k);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = pw; cv.height = ph;
    const cx = cv.getContext("2d");
    cx.fillStyle = "#fff"; cx.fillRect(0, 0, pw, ph);
    cx.drawImage(img, 0, 0, pw, ph);
    return await new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error("PNG 변환 실패")), "image/png"));
  } finally { URL.revokeObjectURL(url); }
}

let exporting = false;
async function exportFrames(frames, kind) {
  if (exporting) return;
  if (!frames.length) { status("출력할 프레임이 없습니다."); return; }
  exporting = true;
  finishEdit();
  try {
    if (kind === "pdf") {
      status("PDF 만드는 중…");
      const blob = await buildPdf(frames.map(f => ({ svg: frameSvg(f, "pdf"), size: frameSize(f) })), {
        title: S.name || "Atelier 보드", subject: "Atelier 4·2 보드",
        onProgress: (i, n) => status(`PDF ${i}/${n}`)
      });
      download(blob, `${safeName()}${frames.length === 1 ? "_" + pad2(frames[0].n) : ""}.pdf`);
      status(`PDF ${frames.length}쪽 저장`);
    } else {
      status("PNG 만드는 중…");
      for (const f of frames) download(await pngOfFrame(f), `${safeName()}_${pad2(f.n)}.png`);
      status(`PNG ${frames.length}장 저장`);
    }
  } catch (e) { console.error(e); status(`출력 실패: ${e.message}`); }
  finally { exporting = false; }
}
function exportTarget() {
  let f = S.frames.find(x => x.id === selFrame);
  if (!f && sel.size) f = frameOf(cardById([...sel][0]));
  if (!f) f = nearestFrame(...viewCentre());
  return f || S.frames[0];
}

// ---- .atelier project file ----------------------------------------------------------------------------------------
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
      format: "atelier-project", version: 1, name: S.name, seq: S.seq,
      site: S.site, diagrams, images, assets: S.assets,
      board: {
        frames: S.frames.map(f => ({ id: f.id, size: f.size, orientation: f.orientation, grid_mm: f.grid_mm, x: f.x, y: f.y, n: f.n })),
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
async function openFile(file) {
  try {
    status("파일 여는 중…");
    const { unzipSync, strFromU8 } = await import(FFLATE);
    const z = unzipSync(new Uint8Array(await file.arrayBuffer()));
    if (!z["project.json"]) throw new Error("project.json이 없습니다.");
    const pj = JSON.parse(strFromU8(z["project.json"]));
    if (pj.format !== "atelier-project") throw new Error("Atelier 프로젝트 파일이 아닙니다.");
    if (pj.version > 1) throw new Error("더 새로운 버전의 파일입니다.");
    if ((S.cards.length || S.frames.length) && !confirm("지금 보드를 이 파일로 바꿀까요? 저장하지 않은 내용은 사라집니다.")) { status(""); return; }
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
    for (const [, g] of els) g.remove();
    els.clear();
    S = next; sel.clear(); selFrame = null; drawerSig = "";
    hist = []; hi = -1;
    hist.push(snap()); hi = 0;
    scheduleSave(); render(); fitAll();
    dirty = false;
    status(`열림 · 카드 ${S.cards.length}장`);
  } catch (e) { console.error(e); status(`열기 실패: ${e.message}`); }
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

function build() {
  const sec = document.createElement("section");
  sec.id = "board"; sec.hidden = true;
  sec.setAttribute("aria-label", "보드");
  sec.innerHTML = `
    <header class="bd-bar">
      <strong class="bd-brand">보드</strong>
      <input id="bd-name" class="bd-name" type="text" aria-label="프로젝트 이름" maxlength="80">
      <div class="bd-bar-actions">
        <button id="bd-save" type="button">저장</button>
        <button id="bd-open" type="button">열기</button>
        <div class="bd-menu-wrap">
          <button id="bd-out" type="button" aria-haspopup="true" aria-expanded="false">출력 ▾</button>
          <div id="bd-out-menu" class="bd-menu" hidden>
            <button type="button" data-out="pdf-all">PDF · 전체 프레임</button>
            <button type="button" data-out="pdf-one">PDF · 선택한 프레임</button>
            <button type="button" data-out="png-one">PNG · 선택한 프레임</button>
            <button type="button" data-out="png-all">PNG · 전체 프레임</button>
          </div>
        </div>
        <button id="bd-close" type="button">닫기</button>
      </div>
    </header>
    <div id="bd-banner" class="bd-banner" role="alert" hidden>자동저장 안 됨 — 파일로 저장하세요</div>
    <div class="bd-tools" role="toolbar" aria-label="보드 도구">
      <button id="bd-add-frame" type="button">+ 프레임</button>
      <select id="bd-size" aria-label="용지"><option value="A3">A3</option><option value="A1">A1</option></select>
      <select id="bd-orient" aria-label="방향"><option value="landscape">가로</option><option value="portrait">세로</option></select>
      <select id="bd-grid" aria-label="그리드"><option value="1">1 mm</option><option value="5">5 mm</option><option value="10">10 mm</option><option value="20">20 mm</option></select>
      <span class="bd-sep"></span>
      <button id="bd-t-title" type="button">제목</button>
      <button id="bd-t-caption" type="button">캡션</button>
      <button id="bd-t-body" type="button">본문</button>
      <button id="bd-memo" type="button">메모</button>
      <button id="bd-img" type="button">이미지</button>
      <span class="bd-sep"></span>
      <button id="bd-fwd" type="button" title="앞으로 ( ] )">앞으로</button>
      <button id="bd-back" type="button" title="뒤로 ( [ )">뒤로</button>
      <button id="bd-dup" type="button" title="복제">복제</button>
      <button id="bd-del" type="button" title="삭제">삭제</button>
      <span class="bd-sep"></span>
      <button id="bd-undo" type="button" aria-label="실행 취소" title="실행 취소">↶</button>
      <button id="bd-redo" type="button" aria-label="다시 실행" title="다시 실행">↷</button>
      <span class="bd-sep bd-hide-m"></span>
      <button id="bd-zoom-out" class="bd-hide-m" type="button" aria-label="축소">−</button>
      <button id="bd-zoom" class="bd-hide-m" type="button" title="100%로" aria-label="확대 비율">100%</button>
      <button id="bd-zoom-in" class="bd-hide-m" type="button" aria-label="확대">+</button>
      <button id="bd-fit" class="bd-hide-m" type="button">전체 보기</button>
    </div>
    <div class="bd-main">
      <aside id="bd-drawer" class="bd-drawer" aria-label="카드 서랍">
        <div class="bd-drawer-head"><strong>서랍</strong><button id="bd-drawer-toggle" type="button" aria-expanded="true" aria-label="서랍 접기">‹</button></div>
        <div id="bd-drawer-list" class="bd-drawer-list"></div>
      </aside>
      <div class="bd-stage">
        <svg id="bd-svg" xmlns="${NS}" aria-label="보드 캔버스" role="application" tabindex="0">
          <g id="bd-world"><g id="bd-frames"></g><g id="bd-cards"></g><g id="bd-guides"></g><g id="bd-selection"></g></g>
        </svg>
        <p class="bd-hint">빈 곳을 끌면 이동, 휠로 확대·축소, Shift+끌기로 영역 선택, 글 카드는 더블클릭으로 편집</p>
      </div>
      <div id="bd-list" class="bd-list" aria-label="프레임별 카드 목록"></div>
    </div>
    <p id="bd-status" class="bd-status" role="status" aria-live="polite"></p>
    <input id="bd-file-img" type="file" accept="image/*" multiple hidden>
    <input id="bd-file-proj" type="file" accept=".atelier,.zip,application/zip" hidden>`;
  document.body.append(sec);
  layerFrames = $("#bd-frames"); layerCards = $("#bd-cards"); layerGuides = $("#bd-guides"); layerSel = $("#bd-selection");
  wire();
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
  svg.addEventListener("focusout", e => { if (e.target.classList?.contains("bd-text")) finishEdit(); });
  svg.addEventListener("paste", e => {
    if (!e.target.classList?.contains("bd-text")) return;
    e.preventDefault();
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
  });
  // drag & drop: drawer items and image files
  svg.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  svg.addEventListener("drop", e => {
    e.preventDefault();
    const at = toWorld(e);
    if (e.dataTransfer.files?.length) { addImageFiles(e.dataTransfer.files, at); return; }
    const id = e.dataTransfer.getData("text/atelier-asset");
    if (id && S.assets[id]) { const c = placeAsset(id, at); if (c) { sel = new Set([c.id]); selFrame = null; } commit(); }
  });
  $("#bd-drawer-list").addEventListener("dragstart", e => {
    const row = e.target.closest("[data-asset]");
    if (row) { e.dataTransfer.setData("text/atelier-asset", row.dataset.asset); e.dataTransfer.effectAllowed = "copy"; }
  });
  $("#bd-drawer-list").addEventListener("click", e => {
    const p = e.target.closest("[data-place]"), r = e.target.closest("[data-remove-asset]");
    if (p) { const c = placeAsset(p.dataset.place); if (c) { sel = new Set([c.id]); selFrame = null; } commit(); }
    else if (r && !r.disabled) { const id = r.dataset.removeAsset; delete S.assets[id]; commit(); }
  });
  $("#bd-drawer-toggle").addEventListener("click", e => {
    const d = $("#bd-drawer"), c = d.classList.toggle("is-collapsed");
    e.currentTarget.setAttribute("aria-expanded", String(!c)); e.currentTarget.textContent = c ? "›" : "‹";
    e.currentTarget.setAttribute("aria-label", c ? "서랍 펼치기" : "서랍 접기");
  });
  // toolbar
  $("#bd-close").onclick = close;
  $("#bd-save").onclick = saveFile;
  $("#bd-open").onclick = () => $("#bd-file-proj").click();
  $("#bd-file-proj").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) openFile(f); };
  $("#bd-img").onclick = () => $("#bd-file-img").click();
  $("#bd-file-img").onchange = e => { const fs = [...e.target.files]; e.target.value = ""; if (fs.length) addImageFiles(fs); };
  $("#bd-add-frame").onclick = () => { const f = addFrame(); selFrame = f.id; sel.clear(); commit(); fitAll(); };
  const onFrameProp = () => {
    const v = { size: $("#bd-size").value, orientation: $("#bd-orient").value, grid_mm: Number($("#bd-grid").value) };
    const f = S.frames.find(x => x.id === selFrame);
    if (f) { Object.assign(f, v); commit(); } else { frameDefaults = v; }
  };
  for (const id of ["#bd-size", "#bd-orient", "#bd-grid"]) $(id).onchange = onFrameProp;
  $("#bd-t-title").onclick = () => addText("title");
  $("#bd-t-caption").onclick = () => addText("caption");
  $("#bd-t-body").onclick = () => addText("body");
  $("#bd-memo").onclick = addMemo;
  $("#bd-fwd").onclick = () => reorder(1);
  $("#bd-back").onclick = () => reorder(-1);
  $("#bd-dup").onclick = duplicate;
  $("#bd-del").onclick = deleteSelection;
  $("#bd-undo").onclick = undo;
  $("#bd-redo").onclick = redo;
  const mid = () => { const r = svg.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
  $("#bd-zoom-in").onclick = () => zoomAt(1.25, ...mid());
  $("#bd-zoom-out").onclick = () => zoomAt(0.8, ...mid());
  $("#bd-zoom").onclick = () => zoomAt(3.7795 / view.z, ...mid());
  $("#bd-fit").onclick = fitAll;
  $("#bd-name").onchange = e => { S.name = e.target.value.trim() || "Atelier 보드"; commit(); };
  // export menu
  const menu = $("#bd-out-menu"), outBtn = $("#bd-out");
  const setMenu = open => { menu.hidden = !open; outBtn.setAttribute("aria-expanded", String(open)); };
  outBtn.onclick = e => { e.stopPropagation(); setMenu(menu.hidden); };
  menu.addEventListener("click", e => {
    const b = e.target.closest("[data-out]");
    if (!b) return;
    setMenu(false);
    const k = b.dataset.out;
    if (k === "pdf-all") exportFrames(S.frames, "pdf");
    else if (k === "png-all") exportFrames(S.frames, "png");
    else { const f = exportTarget(); exportFrames(f ? [f] : [], k === "pdf-one" ? "pdf" : "png"); }
  });
  document.addEventListener("click", e => { if (!menu.hidden && !e.target.closest(".bd-menu-wrap")) setMenu(false); });
  // mobile list
  const list = $("#bd-list");
  list.addEventListener("click", e => { const b = e.target.closest("[data-lact]"); if (b && !b.disabled) listAction(b.dataset.lact, b.dataset.lid); });
  list.addEventListener("change", e => {
    const t = e.target.closest("textarea[data-lid]");
    if (t) { const c = cardById(t.dataset.lid); if (c) { c.text = t.value; commit(); } }
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
      S = sanitizeDoc(rec.S);
      for (const [id, p] of Object.entries(rec.payloads || {})) if (S.assets[id]) payloads.set(id, cleanPayload(p));
      setAutosave(true);
    } else { await idb.put("probe", 1); setAutosave(true); }
  } catch (e) { console.warn("IndexedDB unavailable", e); setAutosave(false); }
  hist = [snap()]; hi = 0;
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
    if (!item.svg || !safeImg(item.preview)) throw new Error("다이어그램 데이터가 없습니다.");
    if (item.meta?.address || item.meta?.radius) S.site = { address: item.meta.address || "", radius: item.meta.radius || "" };
    const id = registerAsset("diagram", item.title || "다이어그램", item.w || 420, item.h || 297, { svg: item.svg, preview: item.preview }, item.meta || null);
    commit();
    return id;
  }
  if (item.kind === "image") {
    if (!safeImg(item.img)) throw new Error("이미지 데이터가 없습니다.");
    const id = registerAsset("image", item.title || "이미지", item.w || 100, item.h || 70, { img: item.img }, item.meta || null);
    commit();
    return id;
  }
  throw new Error("지원하지 않는 항목 종류입니다: " + item.kind);
}
const count = () => Object.keys(S.assets).length;

globalThis.atelierBoard = { add, open, close, count };
dispatchEvent(new CustomEvent("atelierBoard:ready"));
document.addEventListener("click", e => { if (e.target.closest("#start-board")) open(); });
