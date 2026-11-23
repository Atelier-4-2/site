// Entourage ("점경 만들기"): prompt templates, sheet cutter, photo silhouette, "내 점경" library (IndexedDB) -> board stamps.
// Loaded with a dynamic import from board_v06.js; the pixel work lives in board_v06_cut.js, the prompt text in board_v06_entprompt.js (both pure, node-tested).
// Cut figures become ordinary figure stamps (board_v06_figs.js registerCustom), so scale-fit (card scale -> size), flip, tone and export work unchanged.
import { t as _t } from "./i18n.js?v=20261123f";
import { registerCustom, unregisterCustom, customKeys, FIGS, isCustomKey } from "./board_v06_figs.js?v=20261123f";
import * as C from "./board_v06_cut.js?v=20261123f";
import * as P from "./board_v06_entprompt.js?v=20261123f";

const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const tr = (e, key) => { e.dataset.i18n = key; return e; };
const MAX_SHEET = 1600, MAX_PHOTO = 1280, MAX_FIG = 900;   // working sizes (px, long side)

let ctx = null, lib = new Map(), dbOk = true, current = null;

// ---- library storage -------------------------------------------------------------------------------------------------------------
const dbOpen = () => new Promise((res, rej) => {
  if (typeof indexedDB === "undefined") return rej(new Error("no idb"));
  const r = indexedDB.open("atelier-entourage", 1);
  r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("figs")) r.result.createObjectStore("figs", { keyPath: "id" }); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error("blocked"));
});
const dbTx = async (mode, fn) => { const db = await dbOpen(); try { return await new Promise((res, rej) => { const tx = db.transaction("figs", mode), out = fn(tx.objectStore("figs")); tx.oncomplete = () => res(out?.result); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); } finally { db.close(); } };
async function dbSave(rec) { if (!dbOk) return; try { await dbTx("readwrite", s => s.put(rec)); } catch (e) { console.warn(e); dbOk = false; ctx?.status(_t("ent.l.nostore")); } }
async function dbRemove(id) { if (!dbOk) return; try { await dbTx("readwrite", s => s.delete(id)); } catch (e) { console.warn(e); } }
const newId = () => "my_" + Array.from(crypto.getRandomValues(new Uint8Array(6)), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");

function applyRec(rec) {
  const ok = registerCustom(rec.id, { name: rec.name, hm: rec.hm, w: rec.w, h: rec.h, png: rec.png, kind: rec.kind, tree: C.isTreeKind(rec.kind) });
  if (ok) lib.set(rec.id, rec); return ok;
}
/** load the saved figures into the stamp registry; call once after the board is built */
let inited = false;
export async function init(c) {
  ctx = c;
  if (inited) return customKeys().length;
  inited = true;
  try {
    const all = await dbTx("readonly", s => s.getAll());
    for (const rec of all || []) if (rec && isCustomKey(rec.id)) applyRec(rec);
  } catch (e) { dbOk = false; console.warn("entourage library unavailable", e); }
  return customKeys().length;
}
export const list = () => [...lib.values()].sort((a, b) => (a.created || 0) - (b.created || 0));
const changed = () => { try { ctx?.onChange?.(); } catch (e) { console.warn(e); } };

// ---- image helpers ---------------------------------------------------------------------------------------------------------------
const readFileUrl = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
const loadImg = url => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("load")); i.src = url; });
const canvasOf = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
/** image -> ImageData no larger than max px on the long side (white behind transparent pixels is NOT added: transparency counts as background) */
function toImageData(img, max) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height, k = Math.min(1, max / Math.max(iw, ih)), w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
  const c = canvasOf(w, h), x = c.getContext("2d", { willReadFrequently: true }); x.imageSmoothingQuality = "high"; x.drawImage(img, 0, 0, w, h);
  return { img: x.getImageData(0, 0, w, h), scaled: k < 1, iw, ih };
}
function putCanvas(id) { const c = canvasOf(id.width, id.height); c.getContext("2d").putImageData(id, 0, 0); return c; }
function cropToPng(crop) {   // {width,height,data} -> { png, w, h } with the long side capped at MAX_FIG
  const src = putCanvas(new ImageData(new Uint8ClampedArray(crop.data), crop.width, crop.height)), k = Math.min(1, MAX_FIG / Math.max(crop.width, crop.height));
  if (k >= 1) return { png: src.toDataURL("image/png"), w: crop.width, h: crop.height };
  const w = Math.max(1, Math.round(crop.width * k)), h = Math.max(1, Math.round(crop.height * k)), c = canvasOf(w, h), x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(src, 0, 0, w, h);
  return { png: c.toDataURL("image/png"), w, h };
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = mk("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;left:-9999px;top:0"; document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch { /* denied */ } ta.remove(); return ok;
}
const kindLabel = k => _t("ent.kind." + k);
const kindSelect = (value, onChange) => { const s = mk("select", "en-sel"); for (const k of C.KINDS) { const o = mk("option", "", kindLabel(k)); o.value = k; s.append(o); } s.value = value; s.onchange = () => onChange(s.value); return s; };
const numField = (value, min, max, step, onInput, label) => { const i = mk("input", "en-num"); i.type = "number"; i.min = min; i.max = max; i.step = step; i.value = value; i.inputMode = "decimal"; if (label) i.setAttribute("aria-label", label); i.oninput = () => { const v = Number(i.value); if (Number.isFinite(v) && v >= min && v <= max) onInput(v); }; return i; };
function slider(labelKey, min, max, value, onInput, unit = "") {
  const w = mk("label", "en-sl"), t = tr(mk("span", "en-sl-t", _t(labelKey)), labelKey), r = mk("input"), o = mk("output", "en-sl-v", value + unit);
  r.type = "range"; r.min = min; r.max = max; r.value = value; r.oninput = () => { o.textContent = r.value + unit; onInput(Number(r.value)); };
  w.append(t, r, o); return { el: w, input: r, set: v => { r.value = v; o.textContent = v + unit; } };
}
const dropZone = (el, onFile) => {
  el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("is-over"); });
  el.addEventListener("dragleave", () => el.classList.remove("is-over"));
  el.addEventListener("drop", e => { e.preventDefault(); el.classList.remove("is-over"); const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith("image/")); if (f) onFile(f); });
};

// ---- the dialog ------------------------------------------------------------------------------------------------------------------
/** open the tool. opts: { tab: "prompt"|"sheet"|"photo"|"lib", imageUrl, name } (imageUrl = a data URL taken from an image card) */
export async function open(host, opts = {}) {
  if (current) current.close();
  const TABS = ["prompt", "sheet", "photo", "lib"];
  let tab = TABS.includes(opts.tab) ? opts.tab : (opts.imageUrl ? "sheet" : (lib.size ? "lib" : "prompt")), closed = false;
  const dlg = mk("div", "lw-dlg en-dlg"); dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true"); dlg.setAttribute("aria-label", _t("ent.title")); dlg.tabIndex = -1;
  const top = mk("div", "lw-top en-top"), h2 = tr(mk("b", "lw-title", _t("ent.title")), "ent.title"), nav = mk("div", "en-tabs"); nav.setAttribute("role", "tablist");
  const sp = mk("span", "lw-sp"), bClose = tr(mk("button", "bd-btn", _t("ent.close")), "ent.close"); bClose.type = "button";
  const tabBtns = {};
  for (const k of TABS) { const b = tr(mk("button", "en-tab", _t("ent.tab." + k)), "ent.tab." + k); b.type = "button"; b.setAttribute("role", "tab"); b.onclick = () => setTab(k); tabBtns[k] = b; nav.append(b); }
  top.append(h2, nav, sp, bClose);
  const body = mk("div", "en-body"); dlg.append(top, body); host.append(dlg);
  const prevFocus = document.activeElement;
  const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); } else e.stopPropagation(); };
  dlg.addEventListener("keydown", onKey);
  let langOff = null, state = { sheet: null, photo: null }, cleanup = () => {};
  function close() { if (closed) return; closed = true; current = null; langOff?.(); cleanup(); dlg.remove(); try { prevFocus?.focus?.(); } catch { /* gone */ } }
  current = { close };
  bClose.onclick = close;
  { const h = () => { dlg.setAttribute("aria-label", _t("ent.title")); render(); }; document.addEventListener("a42:lang", h); langOff = () => document.removeEventListener("a42:lang", h); }

  function setTab(k) { tab = k; render(); }
  function render() {
    cleanup(); cleanup = () => {}; body.replaceChildren();
    for (const k of TABS) { tabBtns[k].setAttribute("aria-selected", String(k === tab)); tabBtns[k].classList.toggle("is-on", k === tab); }
    if (tab === "prompt") renderPrompt(); else if (tab === "sheet") renderSheet(); else if (tab === "photo") renderPhoto(); else renderLib();
  }
  const note = (key, vars, cls = "en-note") => { const p = tr(mk("p", cls, _t(key, vars)), key); if (vars) { delete p.dataset.i18n; } return p; };
  const field = (labelKey, control) => { const l = mk("label", "en-f"), s = tr(mk("span", "en-f-t", _t(labelKey)), labelKey); l.append(s, control); return l; };
  const seg = (items, value, onPick, labelFn) => { const g = mk("span", "lw-seg en-seg"); for (const it of items) { const b = mk("button", "bd-btn", labelFn(it)); b.type = "button"; b.setAttribute("aria-pressed", String(it === value)); b.onclick = () => onPick(it); g.append(b); } return g; };

  // ---- tab 1: prompt templates ----
  function renderPrompt() {
    const st = state.prompt ||= { kind: "people", style: "pen", lang: P.PROMPT_LANGS.includes(document.documentElement.lang) ? document.documentElement.lang : "ko", n: 0 };
    if (!st.n) st.n = P.defaultCount(st.kind);
    const col = mk("div", "en-col");
    const kindSel = mk("select", "en-sel"); for (const k of P.PROMPT_KINDS) { const o = mk("option", "", _t("ent.pk." + k)); o.value = k; kindSel.append(o); } kindSel.value = st.kind;
    kindSel.onchange = () => { st.kind = kindSel.value; st.n = P.defaultCount(st.kind); render(); };
    const styleSeg = seg(P.PROMPT_STYLES, st.style, v => { st.style = v; render(); }, v => _t("ent.ps." + v));
    const langSeg = seg(P.PROMPT_LANGS, st.lang, v => { st.lang = v; render(); }, v => v.toUpperCase());
    const nIn = numField(st.n, 1, 24, 1, v => { st.n = Math.round(v); refresh(); }, _t("ent.p.n"));
    const row = mk("div", "en-row"); row.append(field("ent.p.kind", kindSel), field("ent.p.n", nIn));
    const row2 = mk("div", "en-row"); row2.append(field("ent.p.style", styleSeg), field("ent.p.lang", langSeg));
    const ta = mk("textarea", "en-prompt"); ta.readOnly = true; ta.rows = 12; ta.setAttribute("aria-label", _t("ent.p.text")); ta.lang = st.lang;
    const copy = tr(mk("button", "bd-btn bd-strong", _t("ent.p.copy")), "ent.p.copy"); copy.type = "button";
    const msg = mk("span", "en-msg"); msg.setAttribute("role", "status");
    const refresh = () => { ta.value = P.buildPrompt(st); };
    copy.onclick = async () => { const ok = await copyText(ta.value); msg.textContent = _t(ok ? "ent.p.copied" : "ent.p.copyfail"); };
    refresh();
    const how = mk("p", "en-note", P.geminiNote(st.lang)); how.lang = st.lang;
    const acts = mk("div", "en-row"); acts.append(copy, msg);
    col.append(row, row2, ta, acts, how, note("ent.p.tip"));
    body.append(col);
  }

  // ---- tab 2: sheet cutter ----
  function renderSheet() {
    const S = state.sheet ||= { id: null, cut: null, groups: [], tol: 40, speck: 30, gap: 6, kind: "person", pick: new Set(), name: "" };
    const wrap = mk("div", "en-two");
    const left = mk("div", "en-pane"), right = mk("div", "en-pane");
    const zone = mk("label", "en-drop"), zt = tr(mk("span", "", _t("ent.s.drop")), "ent.s.drop"), fi = mk("input"); fi.type = "file"; fi.accept = "image/png,image/jpeg,image/webp"; fi.className = "en-file"; fi.setAttribute("aria-label", _t("ent.s.file"));
    zone.append(zt, fi);
    const stage = mk("div", "en-stage"); const cv = mk("canvas", "en-cv"); cv.setAttribute("role", "img"); cv.setAttribute("aria-label", _t("ent.s.preview")); stage.append(cv);
    const info = mk("p", "en-note"); info.setAttribute("role", "status");
    const sTol = slider("ent.s.tol", 0, 120, S.tol, v => { S.tol = v; later(); });
    const sSpeck = slider("ent.s.speck", 0, 1500, S.speck, v => { S.speck = v; later(); }, " px²");
    const sGap = slider("ent.s.gap", 0, 60, S.gap, v => { S.gap = v; later(); }, " px");
    const kSel = kindSelect(S.kind, v => { S.kind = v; later(); });   // new default kind -> names and heights restart
    left.append(zone, field("ent.s.kind", kSel), sTol.el, sSpeck.el, sGap.el, stage, info, note("ent.s.hint"));
    const bar = mk("div", "en-row"), bMerge = tr(mk("button", "bd-btn", _t("ent.s.merge")), "ent.s.merge"), bReg = mk("button", "bd-btn bd-strong"), mrg = tr(mk("span", "en-msg", _t("ent.s.mergehint")), "ent.s.mergehint");
    bMerge.type = bReg.type = "button"; bar.append(bMerge, bReg);
    const grid = mk("div", "en-grid"); right.append(bar, mrg, grid);
    wrap.append(left, right); body.append(wrap);

    let timer = 0, dispose = false; cleanup = () => { dispose = true; clearTimeout(timer); };
    const later = () => { clearTimeout(timer); timer = setTimeout(run, 120); };
    const regLabel = () => { const n = S.groups.filter(g => g.on).length; bReg.textContent = _t("ent.s.reg", { n }); bReg.disabled = !n; bMerge.disabled = S.pick.size < 2; };

    function run() {
      if (dispose || !S.id) return;
      const cut = C.cutSheet(S.id, { tol: S.tol, gap: S.gap, minArea: S.speck });
      S.cut = cut; S.pick.clear();
      S.groups = cut.groups.slice(0, 80).map((g, i) => ({ ...g, on: true, name: `${kindLabel(S.kind)} ${i + 1}`, kind: S.kind, hm: C.kindHm(S.kind), hmEdited: false, thumb: null }));
      info.textContent = cut.groups.length ? _t("ent.s.found", { n: cut.groups.length }) + (cut.groups.length > 80 ? " · 80" : "") : _t("ent.s.none");
      paint(); drawGrid();
    }
    function paint() {
      const img = S.id; if (!img) return;
      cv.width = img.width; cv.height = img.height;
      const x = cv.getContext("2d"), out = x.createImageData(img.width, img.height), d = img.data, m = S.cut.mask;
      for (let i = 0; i < m.length; i++) { const o = i * 4; if (m[i]) { out.data[o + 3] = 0; } else { out.data[o] = d[o]; out.data[o + 1] = d[o + 1]; out.data[o + 2] = d[o + 2]; out.data[o + 3] = 255; } }
      x.putImageData(out, 0, 0);
      const lw = Math.max(1.5, img.width / 500);
      S.groups.forEach((g, i) => {
        x.lineWidth = lw; x.strokeStyle = g.on ? "#E6B89C" : "#9AA0A6"; x.setLineDash(g.on ? [] : [lw * 3, lw * 2]); x.strokeRect(g.x0 - 1, g.y0 - 1, g.x1 - g.x0 + 3, g.y1 - g.y0 + 3);
        x.setLineDash([]); x.fillStyle = g.on ? "#E6B89C" : "#9AA0A6"; const fs = Math.max(11, img.width / 55); x.font = `600 ${fs}px sans-serif`; x.fillText(String(i + 1), g.x0, Math.max(fs, g.y0 - 3));
      });
    }
    cv.onclick = e => {
      if (!S.id) return; const r = cv.getBoundingClientRect(), px = (e.clientX - r.left) * cv.width / r.width, py = (e.clientY - r.top) * cv.height / r.height;
      const g = [...S.groups].reverse().find(g => px >= g.x0 && px <= g.x1 + 1 && py >= g.y0 && py <= g.y1 + 1); if (!g) return;
      g.on = !g.on; paint(); drawGrid();
    };
    function thumbOf(g) {
      if (!g.thumb) { const c = C.cropGroup(S.id, S.cut.lab, S.cut.mask, g, { tol: S.tol, bg: S.cut.bg }); g.thumb = putCanvas(new ImageData(c.data, c.width, c.height)).toDataURL("image/png"); g.tw = c.width; g.th = c.height; }
      return g.thumb;
    }
    function drawGrid() {
      grid.replaceChildren();
      S.groups.forEach((g, i) => {
        const card = mk("div", "en-item" + (g.on ? "" : " is-off") + (S.pick.has(g) ? " is-pick" : ""));
        const th = mk("button", "en-th"); th.type = "button"; th.setAttribute("aria-pressed", String(S.pick.has(g))); th.setAttribute("aria-label", _t("ent.s.pick", { n: i + 1 }));
        const im = mk("img"); im.alt = ""; im.src = thumbOf(g); th.append(im);
        th.onclick = () => { S.pick.has(g) ? S.pick.delete(g) : S.pick.add(g); drawGrid(); };
        const use = mk("input"); use.type = "checkbox"; use.checked = g.on; use.setAttribute("aria-label", _t("ent.s.use")); use.onchange = () => { g.on = use.checked; paint(); card.classList.toggle("is-off", !g.on); regLabel(); };
        const nm = mk("input", "en-name"); nm.type = "text"; nm.value = g.name; nm.maxLength = 60; nm.setAttribute("aria-label", _t("ent.s.name")); nm.oninput = () => { g.name = nm.value; };
        const ks = kindSelect(g.kind, v => { g.kind = v; if (!g.hmEdited) { g.hm = C.kindHm(v); hmIn.value = g.hm; } });
        const hmIn = numField(g.hm, 0.1, 60, 0.05, v => { g.hm = v; g.hmEdited = true; }, _t("ent.s.hm"));
        const hl = mk("label", "en-hm"); hl.append(tr(mk("span", "", _t("ent.s.hm")), "ent.s.hm"), hmIn);
        const top = mk("div", "en-item-top"); top.append(mk("b", "", String(i + 1)), use);
        card.append(top, th, nm, ks, hl); grid.append(card);
      });
      regLabel();
    }
    bMerge.onclick = () => {
      const gs = S.groups.filter(g => S.pick.has(g)); if (gs.length < 2) return;
      const m = C.mergeGroups(gs); const first = S.groups.indexOf(gs[0]);
      const g0 = gs[0]; const merged = { ...m, on: true, name: g0.name, kind: g0.kind, hm: g0.hm, hmEdited: g0.hmEdited, thumb: null };
      S.groups = S.groups.filter(g => !S.pick.has(g)); S.groups.splice(Math.min(first, S.groups.length), 0, merged); S.pick.clear(); paint(); drawGrid();
    };
    bReg.onclick = async () => {
      const gs = S.groups.filter(g => g.on); if (!gs.length) return; bReg.disabled = true;
      let n = 0;
      for (const g of gs) {
        const crop = C.cropGroup(S.id, S.cut.lab, S.cut.mask, g, { tol: S.tol, bg: S.cut.bg }), { png, w, h } = cropToPng(crop);
        const rec = { id: newId(), name: (g.name || "").trim().slice(0, 60) || kindLabel(g.kind), kind: g.kind, hm: Math.min(60, Math.max(0.1, g.hm)), w, h, png, style: "sheet", created: Date.now() + n };
        if (applyRec(rec)) { await dbSave(rec); n++; }
      }
      changed(); ctx.status(_t("ent.l.saved", { n })); tab = "lib"; render();
    };
    async function loadFile(f) {
      try { await loadUrl(await readFileUrl(f), f.name); } catch (e) { console.warn(e); info.textContent = _t("ent.s.err"); }
    }
    async function loadUrl(url, name) {
      const im = await loadImg(url), r = toImageData(im, MAX_SHEET);
      S.id = r.img; S.name = name || ""; S.pick.clear();
      run();
      if (r.scaled) info.textContent += " · " + _t("ent.s.big", { w: r.img.width, h: r.img.height });
    }
    fi.onchange = () => { const f = fi.files[0]; fi.value = ""; if (f) loadFile(f); };
    dropZone(zone, loadFile);
    if (opts.imageUrl && !S.fromCard) { S.fromCard = true; loadUrl(opts.imageUrl, opts.name).then(() => { info.textContent = _t("ent.s.fromcard") + " · " + info.textContent; }); }
    else if (S.id) { run(); } else { info.textContent = ""; regLabel(); }
  }

  // ---- tab 3: photo -> silhouette ----
  function renderPhoto() {
    const S = state.photo ||= { px: null, w: 0, h: 0, mode: "colour", T: 40, dk: 100, ground: 0, tex: 60, kind: "tree_m", hm: C.kindHm("tree_m"), name: "", result: null };
    const wrap = mk("div", "en-two"), left = mk("div", "en-pane"), right = mk("div", "en-pane");
    const zone = mk("label", "en-drop"), zt = tr(mk("span", "", _t("ent.f.drop")), "ent.f.drop"), fi = mk("input"); fi.type = "file"; fi.accept = "image/png,image/jpeg,image/webp"; fi.className = "en-file"; fi.setAttribute("aria-label", _t("ent.f.file")); zone.append(zt, fi);
    const stage = mk("div", "en-stage en-pstage"), src = mk("canvas", "en-cv"), line = mk("div", "en-gline"), lt = mk("span", "", ""); line.append(lt); line.hidden = true; src.setAttribute("role", "img"); src.setAttribute("aria-label", _t("ent.f.src")); stage.append(src, line);
    const modeSeg = seg(["colour", "dark"], S.mode, v => { S.mode = v; render(); }, v => _t(v === "colour" ? "ent.f.colour" : "ent.f.dark"));
    const sT = slider("ent.f.T", 8, 120, S.T, v => { S.T = v; }), sDk = slider("ent.f.dk", 60, 140, S.dk, v => { S.dk = v; }, " %");
    const sG = slider("ent.f.ground", 0, 95, S.ground, v => { S.ground = v; place(); }, " %"), sTex = slider("ent.f.tex", 0, 100, S.tex, v => { S.tex = v; }, " %");
    const info = mk("p", "en-note"); info.setAttribute("role", "status");
    left.append(zone, field("ent.f.mode", modeSeg), S.mode === "colour" ? sT.el : sDk.el, sG.el, note("ent.f.groundhint"), stage, info);
    const make = tr(mk("button", "bd-btn bd-strong", _t("ent.f.make")), "ent.f.make"), reg = tr(mk("button", "bd-btn bd-strong", _t("ent.f.reg")), "ent.f.reg"); make.type = reg.type = "button"; make.disabled = !S.px; reg.disabled = !S.result;
    const prev = mk("div", "en-stage en-res"), rc = mk("canvas", "en-cv"); rc.setAttribute("role", "img"); rc.setAttribute("aria-label", _t("ent.f.res")); prev.append(rc);
    const nameIn = mk("input", "en-name"); nameIn.type = "text"; nameIn.maxLength = 60; nameIn.value = S.name; nameIn.oninput = () => { S.name = nameIn.value; };
    const hmIn = numField(S.hm, 0.1, 60, 0.05, v => { S.hm = v; }, _t("ent.s.hm"));
    const ks = kindSelect(S.kind, v => { S.kind = v; S.hm = C.kindHm(v); hmIn.value = S.hm; });
    const r1 = mk("div", "en-row"); r1.append(field("ent.s.name", nameIn), field("ent.s.kind", ks), field("ent.s.hm", hmIn));
    right.append(sTex.el, make, prev, r1, reg, note("ent.f.note"));
    wrap.append(left, right); body.append(wrap);

    cleanup = () => {};
    const place = () => { line.style.top = S.ground + "%"; lt.textContent = S.ground + " %"; sG.set(S.ground); };
    function drawSrc() {
      if (!S.px) { src.width = src.height = 0; line.hidden = true; return; }
      src.width = S.w; src.height = S.h; src.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(S.px), S.w, S.h), 0, 0); line.hidden = false; place();
    }
    let dragging = false;
    const setFromY = e => { const r = stage.getBoundingClientRect(), cr = src.getBoundingClientRect(); S.ground = Math.max(0, Math.min(95, Math.round((e.clientY - cr.top) / cr.height * 100))); place(); };
    line.onpointerdown = e => { dragging = true; line.setPointerCapture(e.pointerId); e.preventDefault(); };
    line.onpointermove = e => { if (dragging) setFromY(e); };
    line.onpointerup = line.onpointercancel = () => { dragging = false; };
    drawSrc();
    if (S.result) { rc.width = S.result.width; rc.height = S.result.height; rc.getContext("2d").putImageData(S.result, 0, 0); }

    async function loadFile(f) {
      try {
        const im = await loadImg(await readFileUrl(f)), r = toImageData(im, MAX_PHOTO);
        S.px = r.img.data; S.w = r.img.width; S.h = r.img.height; S.result = null; S.name = (f.name || "").replace(/\.[^.]+$/, "").slice(0, 60); nameIn.value = S.name; make.disabled = false; reg.disabled = true; rc.width = rc.height = 0; drawSrc(); info.textContent = "";
      } catch (e) { console.warn(e); info.textContent = _t("ent.s.err"); }
    }
    fi.onchange = () => { const f = fi.files[0]; fi.value = ""; if (f) loadFile(f); };
    dropZone(zone, loadFile);
    make.onclick = () => {
      if (!S.px) return; info.textContent = _t("ent.f.working"); make.disabled = true;
      setTimeout(() => {   // let the message paint before the heavy loop
        try { S.result = makeSilhouette(S); rc.width = S.result.width; rc.height = S.result.height; rc.getContext("2d").putImageData(S.result, 0, 0); reg.disabled = false; info.textContent = ""; }
        catch (e) { S.result = null; rc.width = rc.height = 0; reg.disabled = true; info.textContent = _t(e.message === "empty" ? "ent.f.empty" : "ent.s.err"); if (e.message !== "empty") console.warn(e); }
        make.disabled = false;
      }, 30);
    };
    reg.onclick = async () => {
      if (!S.result) return; reg.disabled = true;
      const { png, w, h } = cropToPng(S.result), rec = { id: newId(), name: (S.name || "").trim().slice(0, 60) || kindLabel(S.kind), kind: S.kind, hm: Math.min(60, Math.max(0.1, S.hm)), w, h, png, style: "photo", created: Date.now() };
      if (applyRec(rec)) await dbSave(rec);
      changed(); ctx.status(_t("ent.l.saved", { n: 1 })); tab = "lib"; render();
    };
  }

  // ---- tab 4: library ----
  function renderLib() {
    const col = mk("div", "en-col"), items = list(), sel = state.libSel ||= new Set();
    if (!items.length) { col.append(note("ent.l.empty")); const go = tr(mk("button", "bd-btn bd-strong", _t("ent.tab.sheet")), "ent.tab.sheet"); go.type = "button"; go.onclick = () => setTab("sheet"); col.append(go); body.append(col); return; }
    const bar = mk("div", "en-row"), all = mk("label", "en-chk"), ac = mk("input"); ac.type = "checkbox"; ac.checked = items.every(r => sel.has(r.id)); all.append(ac, tr(mk("span", "", _t("ent.l.all")), "ent.l.all"));
    const zip = mk("button", "bd-btn bd-strong"); zip.type = "button"; zip.disabled = !sel.size; zip.textContent = _t("ent.l.zip") + (sel.size ? ` (${sel.size})` : "");
    bar.append(all, zip, tr(mk("span", "en-msg", _t("ent.l.zipnote")), "ent.l.zipnote"));
    const grid = mk("div", "en-grid");
    for (const r of items) {
      const card = mk("div", "en-item");
      const top = mk("div", "en-item-top"), ck = mk("input"); ck.type = "checkbox"; ck.checked = sel.has(r.id); ck.setAttribute("aria-label", _t("ent.l.sel", { name: r.name }));
      ck.onchange = () => { ck.checked ? sel.add(r.id) : sel.delete(r.id); zip.disabled = !sel.size; zip.textContent = _t("ent.l.zip") + (sel.size ? ` (${sel.size})` : ""); };
      top.append(ck, mk("span", "en-kind", kindLabel(r.kind)));
      const th = mk("div", "en-th is-static"), im = mk("img"); im.alt = r.name; im.src = r.png; th.append(im);
      const nm = mk("input", "en-name"); nm.type = "text"; nm.value = r.name; nm.maxLength = 60; nm.setAttribute("aria-label", _t("ent.s.name")); nm.onchange = () => { r.name = nm.value.trim().slice(0, 60) || r.name; applyRec(r); dbSave(r); changed(); };
      const hm = numField(r.hm, 0.1, 60, 0.05, v => { r.hm = v; }, _t("ent.s.hm")); hm.onchange = () => { applyRec(r); dbSave(r); changed(); };
      const hl = mk("label", "en-hm"); hl.append(tr(mk("span", "", _t("ent.s.hm")), "ent.s.hm"), hm);
      const acts = mk("div", "en-row"), place = tr(mk("button", "bd-btn bd-strong", _t("ent.l.place")), "ent.l.place"), del = tr(mk("button", "bd-btn", _t("ent.l.del")), "ent.l.del"); place.type = del.type = "button";
      place.onclick = () => { close(); ctx.pickStamp(r.id); };
      del.onclick = async () => { if (!confirm(_t("ent.l.confirmdel", { name: r.name }))) return; lib.delete(r.id); unregisterCustom(r.id); sel.delete(r.id); await dbRemove(r.id); changed(); render(); };
      acts.append(place, del); card.append(top, th, nm, hl, acts); grid.append(card);
    }
    ac.onchange = () => { for (const r of items) ac.checked ? sel.add(r.id) : sel.delete(r.id); render(); };
    zip.onclick = async () => {
      const chosen = items.filter(r => sel.has(r.id)); if (!chosen.length) return; zip.disabled = true;
      try {
        const { zipSync, strToU8 } = await import(ctx.FFLATE), files = {}, index = [], used = new Set();
        for (const r of chosen) {
          let base = r.name.replace(/[\\/:*?"<>|]+/g, "-").trim().slice(0, 40) || r.id, k = base, i = 2; while (used.has(k)) k = `${base}-${i++}`; used.add(k);
          const b64 = r.png.slice(r.png.indexOf(",") + 1), bin = atob(b64), u8 = new Uint8Array(bin.length); for (let j = 0; j < bin.length; j++) u8[j] = bin.charCodeAt(j);
          files[`${k}.png`] = [u8, { level: 0 }]; index.push({ file: `${k}.png`, name: r.name, kind: r.kind, height_m: r.hm, px: [r.w, r.h] });
        }
        files["entourage.json"] = [strToU8(JSON.stringify({ format: "atelier-entourage", version: 1, figures: index }, null, 1)), { level: 6 }];
        ctx.download(new Blob([zipSync(files)], { type: "application/zip" }), "entourage.zip");
        ctx.status(_t("ent.l.zipdone", { n: chosen.length }));
      } catch (e) { console.warn(e); ctx.status(_t("ent.s.err")); }
      zip.disabled = !sel.size;
    };
    col.append(bar, grid); body.append(col);
  }

  render();
  bClose.focus();
  return { close };
}

/** photo -> flat silhouette ImageData (long side <= 1000 px), colour or Otsu background separation */
function makeSilhouette(S) {
  const { fg, bbox } = C.photoMask(S.px, S.w, S.h, { mode: S.mode, T: S.T, dk: S.dk / 100, ground: S.ground });
  const pad = Math.round(0.02 * (bbox.y1 - bbox.y0)), x0 = Math.max(0, bbox.x0 - pad), y0 = Math.max(0, bbox.y0 - pad), x1 = Math.min(S.w - 1, bbox.x1 + pad), y1 = Math.min(S.h - 1, bbox.y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, k = Math.min(1000 / ch, 1000 / cw, 2), ow = Math.max(8, Math.round(cw * k)), oh = Math.max(8, Math.round(ch * k));
  const sc = putCanvas(new ImageData(new Uint8ClampedArray(S.px), S.w, S.h)), mi = new ImageData(S.w, S.h);
  for (let i = 0; i < fg.length; i++) { const v = fg[i] ? 255 : 0; mi.data[i * 4] = mi.data[i * 4 + 1] = mi.data[i * 4 + 2] = v; mi.data[i * 4 + 3] = 255; }
  const mc = putCanvas(mi), oc = canvasOf(ow, oh), ox = oc.getContext("2d", { willReadFrequently: true }), om = canvasOf(ow, oh), omx = om.getContext("2d", { willReadFrequently: true });
  ox.imageSmoothingQuality = omx.imageSmoothingQuality = "high"; ox.drawImage(sc, x0, y0, cw, ch, 0, 0, ow, oh); omx.drawImage(mc, x0, y0, cw, ch, 0, 0, ow, oh);
  const od = ox.getImageData(0, 0, ow, oh).data, md = omx.getImageData(0, 0, ow, oh).data, mask = new Uint8Array(ow * oh);
  for (let i = 0; i < mask.length; i++) mask[i] = md[i * 4] > 127 ? 1 : 0;
  return new ImageData(C.silhouetteRGBA(od, mask, ow, oh, { tex: S.tex / 100 }), ow, oh);
}
