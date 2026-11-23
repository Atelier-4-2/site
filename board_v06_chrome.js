import { t as _t } from "./i18n.js?v=20261123f";
// Board v2 dialogs: export panel, command palette (⌘K), shortcut sheet, board info (cartouche meta), text styles,
// presentation mode. Created once by board_v06.js with a small api object; holds no document state of its own.
import { contentRect, frameSize, parseRange, ROLES, ROLE_LABEL, PALETTE, WEIGHTS, needsTiles, pad2 } from "./board_v06_doc.js?v=20261123f";
import * as X from "./board_v06_export.js?v=20261123f";
import { PRESETS, PRESET_KEYS, presetOptions, downsampleTarget, todayStamp, summarize } from "./board_v06_preflight.js?v=20261123f";
import { resolveColor } from "./board_v06_parent.js?v=20261123f";
import { icon } from "./board_v06_icons.js?v=20261123f";

const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const field = (label, input, hint) => { const l = mk("label", "bd-field"); l.append(mk("span", "bd-field-l", label), input); if (hint) l.append(mk("small", "bd-field-h", hint)); return l; };

export const shortcuts = () => [
  [_t('board.chrome.001'), [[_t('board.chrome.002'), "V"], [_t('board.chrome.003'), _t('board.chrome.004')], [_t('board.chrome.005'), "T"], [_t('board.chrome.006'), "F"], [_t('board.chrome.007'), "N"], [_t('board.chrome.008'), "I"]]],
  [_t('board.chrome.009'), [[_t('board.chrome.010'), "⌘Z / ⌘⇧Z"], [_t('board.chrome.011'), "⌘D"], [_t('board.chrome.012'), "⌘G / ⌘⇧G"], [_t('board.chrome.013'), "] / ["], [_t('board.chrome.014'), "Delete"], [_t('board.chrome.015'), _t('board.chrome.016')], [_t('board.chrome.017'), "⌘A"], [_t('board.chrome.018'), "⌘V"], [_t('board.chrome.019'), _t('board.chrome.020')]]],
  [_t('board.chrome.021'), [[_t('board.chrome.022'), "Shift+R"], [_t('board.chrome.023'), _t('board.chrome.024')], [_t('board.chrome.025'), "Shift+1"], [_t('board.chrome.026'), "W · Esc"], [_t('board.chrome.027'), "P"], [_t('board.chrome.028'), "⌘K"], [_t('board.chrome.029'), "?"]]],
  [_t('board.chrome.030'), [[_t('board.chrome.031'), _t('board.chrome.032')], [_t('board.chrome.033'), _t('board.chrome.034')], [_t('board.chrome.035'), _t('board.chrome.036')], [_t('board.chrome.037'), _t('board.chrome.038')]]]
];

export function createChrome(api) {
  let exporting = false, pres = null, dlgN = 0, presExit = null, fontCssP = null;
  const root = () => api.root();

  function dlg(title, cls = "") {
    document.querySelectorAll("#board dialog.bd-dlg").forEach(d => d.close());
    const d = mk("dialog", "bd-dlg " + cls);
    d.setAttribute("aria-label", title);
    const head = mk("header", "bd-dlg-h"); head.append(mk("h2", "", title));
    const x = mk("button", "bd-ib"); x.type = "button"; x.innerHTML = icon("close"); x.setAttribute("aria-label", _t('board.chrome.039')); x.onclick = () => d.close();
    head.append(x);
    const body = mk("div", "bd-dlg-b"), foot = mk("footer", "bd-dlg-f");
    d.append(head, body, foot);
    d.addEventListener("close", () => setTimeout(() => d.remove(), 0));
    d.addEventListener("click", e => { if (e.target === d) d.close(); });
    root().append(d);
    return { d, body, foot, show() { d.showModal(); return d; } };
  }
  const isBlocking = () => !!pres || !!root().querySelector("dialog[open]");

  // ---- export ---------------------------------------------------------------------------------------
  function download(blob, name) { api.download(blob, name); }
  async function pngOfFrame(f) {
    const ctx = api.ctx();
    const fontCss = await api.loadFontCss();
    const svg = X.frameSvg(ctx, f, "png", fontCss);
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
      return await new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error(_t('board.chrome.040'))), "image/png"));
    } finally { URL.revokeObjectURL(url); }
  }
  // image downsampling for the preset's max ppi: never upsample; JPEG q 0.9, PNG when the image has alpha; diagrams stay vector
  async function downsampleCtx(ctx, frames, maxPpi) {
    const { S } = ctx, need = new Map();
    for (const f of frames) for (const c of X.cardsOfFrame(S, f)) if (c.kind === "image") { const w = c.content ? contentRect(c, S.assets[c.ref]).w : c.w; need.set(c.ref, Math.max(need.get(c.ref) || 0, w)); }
    const pl = new Map(ctx.payloads);
    for (const [ref, wmm] of need) {
      const p = pl.get(ref);
      if (!p?.img) continue;
      const im = new Image(); im.src = p.img;
      try { await im.decode(); } catch { continue; }
      const tw = downsampleTarget(im.naturalWidth, wmm, maxPpi);
      if (tw >= im.naturalWidth) continue;
      const th = Math.max(1, Math.round(im.naturalHeight * tw / im.naturalWidth)), cv = document.createElement("canvas");
      cv.width = tw; cv.height = th;
      const cx = cv.getContext("2d"); cx.imageSmoothingQuality = "high"; cx.drawImage(im, 0, 0, tw, th);
      let alpha = false;
      if (!p.img.startsWith("data:image/jpeg")) { const data = cx.getImageData(0, 0, tw, th).data; for (let i = 3; i < data.length; i += 4) if (data[i] < 255) { alpha = true; break; } }
      pl.set(ref, { ...p, img: cv.toDataURL(alpha ? "image/png" : "image/jpeg", 0.9) });
    }
    return { ...ctx, payloads: pl };
  }
  async function exportFrames(frames, kind, opt = {}) {
    if (api.ctx().S.editParent) { api.status(_t('board.chrome.041')); return; }
    if (exporting) return;
    if (!frames.length) { api.status(_t('board.chrome.042')); return; }
    if (opt.preset == null) { const pk = api.getPreset(), po = presetOptions(pk); opt = { ...opt, preset: pk, bleed: po ? po.bleed : !!opt.bleed, maxPpi: po ? po.maxPpi : PRESETS.print.maxPpi }; }   // saved preset applies to every export
    exporting = true;
    api.finishEdit();
    let ctx = api.ctx();
    const S = ctx.S;
    try {
      if (kind === "pdf") {
        api.status(_t('board.chrome.043'));
        if (opt.maxPpi) { api.status(_t('board.chrome.044', { 0: opt.maxPpi })); ctx = await downsampleCtx(ctx, frames, opt.maxPpi); }
        const pages = X.planSheets(ctx, frames, opt);
        const blob = await api.buildPdf(pages, { title: S.name || _t('board.chrome.045'), subject: _t('board.chrome.046'), onProgress: (i, n) => api.status(`PDF ${i}/${n}`) });
        const tag = opt.booklet ? _t('board.chrome.047') : opt.tiles ? _t('board.chrome.048') : "";
        download(blob, `${api.safeName()}${frames.length === 1 ? "_p" + pad2(frames[0].page) : ""}${tag}_${PRESETS[opt.preset || "custom"].label}_${todayStamp()}.pdf`);
        api.status(_t('board.chrome.049', { 0: pages.length }));
      } else {
        api.status(_t('board.chrome.050'));
        for (const f of frames) download(await pngOfFrame(f), `${api.safeName()}_p${pad2(f.page)}.png`);
        api.status(_t('board.chrome.051', { 0: frames.length }));
      }
    } catch (e) { console.error(e); api.status(_t('board.chrome.052', { 0: e.message })); }
    finally { exporting = false; }
  }

  function openExport() {
    api.finishEdit();
    if (api.ctx().S.editParent) { api.status(_t('board.chrome.041')); return; }
    const S = api.ctx().S;
    if (!S.frames.length) { api.status(_t('board.chrome.042')); return; }
    const { d, body, foot, show } = dlg(_t('board.chrome.053'), "bd-dlg-export");
    const uid = ++dlgN;   // radio groups are per document: keep them unique per dialog
    const radio = (name, val, label, checked) => {
      const l = mk("label", "bd-radio"), i = mk("input"); i.type = "radio"; i.name = name + uid; i.value = val; i.checked = !!checked;
      l.append(i, mk("span", "", label)); return l;
    };
    const check = (id, label, hint) => {
      const l = mk("label", "bd-check"), i = mk("input"); i.type = "checkbox"; i.id = id;
      const t = mk("span", "bd-check-t"); t.append(mk("b", "", label), mk("small", "", hint));
      l.append(i, t); return l;
    };
    const fs1 = mk("fieldset", "bd-fs"); fs1.append(mk("legend", "", _t('board.chrome.054')));
    fs1.append(radio("fmt", "pdf", _t('board.chrome.055'), true), radio("fmt", "png", "PNG (150 dpi)"));
    const fs2 = mk("fieldset", "bd-fs"); fs2.append(mk("legend", "", _t('board.chrome.056')));
    const rng = mk("input"); rng.type = "text"; rng.placeholder = "1-3,5"; rng.setAttribute("aria-label", _t('board.chrome.057')); rng.className = "bd-range";
    const row = mk("div", "bd-range-row"); row.append(radio("rng", "nums", _t('board.chrome.057')), rng);
    fs2.append(radio("rng", "all", _t('board.chrome.058', { 0: S.frames.length }), true), radio("rng", "sel", _t('board.chrome.059')), row);
    const fs3 = mk("fieldset", "bd-fs"); fs3.append(mk("legend", "", _t('board.chrome.060')));
    fs3.append(check("bd-x-book", _t('board.chrome.061'), _t('board.chrome.062')), check("bd-x-bleed", _t('board.chrome.063'), _t('board.chrome.064')), check("bd-x-tile", _t('board.chrome.065'), _t('board.chrome.066')));
    fs3.append(check("bd-x-spread", _t('board.chrome.067'), _t('board.chrome.068')));
    const hint = mk("p", "bd-dlg-hint");
    const sm = summarize(api.preflight().list);
    const pfLine = mk("p", "bd-dlg-hint bd-pfline" + (sm.errors ? " is-err" : ""), sm.total ? _t('board.chrome.069', { 0: sm.text }) : _t('board.chrome.070'));
    const presetSel = mk("select", "bd-preset"); presetSel.setAttribute("aria-label", _t('board.chrome.071'));
    for (const k of PRESET_KEYS) { const o = mk("option", "", PRESETS[k].label); o.value = k; presetSel.append(o); }
    presetSel.value = api.getPreset();
    const presetRow = field(_t('board.chrome.071'), presetSel, _t('board.chrome.072'));
    body.append(pfLine, presetRow, fs1, fs2, fs3, hint);
    const go = mk("button", "bd-btn bd-strong"); go.type = "button";
    const cancel = mk("button", "bd-btn", _t('board.chrome.039')); cancel.type = "button"; cancel.onclick = () => d.close();
    foot.append(cancel, go);
    const q = s => d.querySelector(s);
    const val = n => d.querySelector(`input[name=${n}${uid}]:checked`)?.value;
    const frames = () => {
      const list = api.ctx().S.frames;   // already in page order
      const r = val("rng");
      if (r === "all") return list;
      if (r === "sel") { const f = api.selectedFrame(); return f ? [f] : []; }
      const nums = parseRange(rng.value, list.length);
      return nums ? nums.map(n => list[n - 1]).filter(Boolean) : [];
    };
    const sync = () => {
      const pdf = val("fmt") === "pdf";
      const book = q("#bd-x-book"), bleed = q("#bd-x-bleed"), tile = q("#bd-x-tile");
      for (const c of [book, bleed, tile]) c.disabled = !pdf;
      if (!pdf) for (const c of [book, bleed, tile]) c.checked = false;
      bleed.disabled = !pdf || book.checked || tile.checked;
      if (bleed.disabled && (book.checked || tile.checked)) bleed.checked = false;
      const fl = frames();
      tile.disabled = !pdf || book.checked;
      book.disabled = !pdf || tile.checked;
      const big = fl.some(f => { const [W, H] = frameSize(f); return needsTiles(W, H); });
      const n = pdf ? X.sheetCount(fl, { tiles: tile.checked, spreads: q("#bd-x-spread").checked, booklet: book.checked }) : fl.length;
      go.textContent = _t('board.chrome.073', { 0: n }); go.disabled = !fl.length || exporting;
      rng.disabled = val("rng") !== "nums";
      hint.textContent = !fl.length ? (val("rng") === "nums" ? _t('board.chrome.074') : _t('board.chrome.075'))
        : tile.checked && !big ? _t('board.chrome.076') : "";
    };
    const applyPreset = () => {
      const o = presetOptions(presetSel.value);
      if (!o) return;
      d.querySelector(`input[name=fmt${uid}][value=pdf]`).checked = true;
      q("#bd-x-book").checked = o.booklet; q("#bd-x-tile").checked = o.tiles; q("#bd-x-bleed").checked = o.bleed;
    };
    let lastPpi = presetOptions(presetSel.value)?.maxPpi || PRESETS.print.maxPpi;
    presetSel.addEventListener("change", () => { applyPreset(); const o = presetOptions(presetSel.value); if (o) lastPpi = o.maxPpi; sync(); });
    d.addEventListener("change", e => { if (e.target !== presetSel && (fs1.contains(e.target) || fs3.contains(e.target)) && presetSel.value !== "custom") presetSel.value = "custom"; });   // a manual option change = 사용자
    d.addEventListener("change", sync); d.addEventListener("input", sync);
    rng.addEventListener("focus", () => { d.querySelector(`input[name=rng${uid}][value=nums]`).checked = true; sync(); });
    go.onclick = async () => {
      const fl = frames(), kind = val("fmt");
      d.close();
      const pr = presetSel.value, po = presetOptions(pr);
      api.setPreset(pr);   // remembered in the doc only when something is really exported
      await exportFrames(fl, kind, { booklet: q("#bd-x-book").checked, spreads: q("#bd-x-spread").checked, bleed: q("#bd-x-bleed").checked, tiles: q("#bd-x-tile").checked, preset: pr, maxPpi: kind === "pdf" ? (po ? po.maxPpi : lastPpi) : 0 });
    };
    if (api.selectedFrame()) d.querySelector(`input[name=rng${uid}][value=sel]`).checked = true;
    applyPreset();
    sync();
    show();
    go.focus();
  }

  // ---- shortcut sheet ----------------------------------------------------------------------------------
  function openShortcuts() {
    const { body, show } = dlg(_t('board.chrome.077'), "bd-dlg-wide");
    for (const [g, rows] of shortcuts()) {
      const sec = mk("section", "bd-sc"); sec.append(mk("h3", "", g));
      const dl = mk("dl");
      for (const [a, k] of rows) { dl.append(mk("dt", "", a)); const dd = mk("dd"); dd.append(mk("kbd", "", k)); dl.append(dd); }
      sec.append(dl); body.append(sec);
    }
    show();
  }

  // ---- board info (cartouche meta) ------------------------------------------------------------------------
  function openInfo() {
    const S = api.ctx().S, m = S.meta;
    const { d, body, foot, show } = dlg(_t('board.chrome.078'));
    const mkIn = (key, label, ph, max) => { const i = mk("input"); i.type = "text"; i.value = m[key] || ""; i.maxLength = max; i.placeholder = ph; i.dataset.key = key; return field(label, i); };
    body.append(
      mkIn("project", _t('board.chrome.079'), _t('board.chrome.080'), 120), mkIn("author", _t('board.chrome.081'), "", 80), mkIn("atelier", _t('board.chrome.082'), _t('board.chrome.083'), 80),
      mkIn("teachers", _t('board.chrome.084'), "", 160), mkIn("scale", _t('board.chrome.085'), _t('board.chrome.086'), 24), mkIn("date", _t('board.chrome.087'), new Date().toISOString().slice(0, 10), 24));
    body.append(mk("p", "bd-dlg-hint", _t('board.chrome.088')));
    const ok = mk("button", "bd-btn bd-strong", _t('board.chrome.089')); ok.type = "button";
    const cancel = mk("button", "bd-btn", _t('board.chrome.090')); cancel.type = "button"; cancel.onclick = () => d.close();
    ok.onclick = () => { const v = {}; for (const i of d.querySelectorAll("input[data-key]")) v[i.dataset.key] = i.value.trim(); api.commitMeta(v); d.close(); };
    foot.append(cancel, ok);
    show();
    d.querySelector("input").focus();
  }

  // ---- text styles -----------------------------------------------------------------------------------------
  function openStyles() {
    const S = api.ctx().S;
    const cur = JSON.parse(JSON.stringify(S.styles));
    const { d, body, foot, show } = dlg(_t('board.chrome.091'), "bd-dlg-wide");
    const rows = mk("div", "bd-styles");
    for (const r of ROLES) {
      const row = mk("div", "bd-style-row");
      const sample = mk("span", "bd-style-sample", _t('board.chrome.092'));
      const size = mk("input"); size.type = "number"; size.min = 1; size.max = 200; size.step = 0.5; size.value = cur[r].size; size.setAttribute("aria-label", _t('board.chrome.093', { 0: ROLE_LABEL[r] }));
      const wt = mk("select"); wt.setAttribute("aria-label", _t('board.chrome.094', { 0: ROLE_LABEL[r] }));
      for (const w of WEIGHTS) { const o = mk("option", "", String(w)); o.value = w; o.selected = w === cur[r].weight; wt.append(o); }
      const pal = mk("div", "bd-pal"); pal.setAttribute("role", "radiogroup"); pal.setAttribute("aria-label", _t('board.chrome.095', { 0: ROLE_LABEL[r] }));
      const paint = () => {
        sample.style.cssText = `font-size:${Math.min(36, Math.max(10, cur[r].size * 2.4))}px;font-weight:${cur[r].weight};color:${resolveColor(S, cur[r].color)}`;
        for (const b of pal.children) b.setAttribute("aria-checked", String(b.dataset.c === cur[r].color));
      };
      for (const w of S.swatches) {   // style colours are swatch references: a swatch change updates every use
        const c = "sw:" + w.id, b = mk("button", "bd-sw"); b.type = "button"; b.dataset.c = c; b.style.background = w.hex; b.setAttribute("role", "radio"); b.setAttribute("aria-label", w.name); b.dataset.tip = w.name;
        b.onclick = () => { cur[r].color = c; paint(); };
        pal.append(b);
      }
      size.oninput = () => { const v = Number(size.value); if (v >= 1 && v <= 200) { cur[r].size = v; paint(); } };
      wt.onchange = () => { cur[r].weight = Number(wt.value); paint(); };
      row.append(mk("b", "bd-style-n", ROLE_LABEL[r]), sample, field(_t('board.chrome.096'), size), field(_t('board.chrome.097'), wt), pal);
      rows.append(row); paint();
    }
    body.append(rows, mk("p", "bd-dlg-hint", _t('board.chrome.098')));
    const ok = mk("button", "bd-btn bd-strong", _t('board.chrome.099')); ok.type = "button";
    const cancel = mk("button", "bd-btn", _t('board.chrome.090')); cancel.type = "button"; cancel.onclick = () => d.close();
    ok.onclick = () => { api.commitStyles(cur); d.close(); };
    foot.append(cancel, ok);
    show();
  }

  // ---- command palette ----------------------------------------------------------------------------------------
  const norm = s => String(s).toLowerCase().replace(/\s+/g, "");
  function score(q, text) {
    q = norm(q); text = norm(text);
    if (!q) return 1;
    const at = text.indexOf(q);
    if (at >= 0) return 100 - at;
    let i = 0, s = 0, last = -2;
    for (const ch of q) { const j = text.indexOf(ch, i); if (j < 0) return 0; s += j === last + 1 ? 3 : 1; last = j; i = j + 1; }
    return s;
  }
  function openPalette(commands) {
    const { d, body, show } = dlg(_t('board.chrome.028'), "bd-dlg-pal");
    d.classList.add("bd-pal-dlg");
    const inp = mk("input", "bd-pal-in"); inp.type = "text"; inp.placeholder = _t('board.chrome.100'); inp.setAttribute("aria-label", _t('board.chrome.101'));
    inp.setAttribute("role", "combobox"); inp.setAttribute("aria-expanded", "true"); inp.setAttribute("aria-controls", "bd-pal-list");
    const ul = mk("ul", "bd-pal-list"); ul.id = "bd-pal-list"; ul.setAttribute("role", "listbox");
    body.append(inp, ul);
    let items = [], idx = 0;
    const draw = () => {
      ul.replaceChildren();
      items.forEach((c, i) => {
        const li = mk("li", "bd-pal-item" + (i === idx ? " is-on" : "")); li.setAttribute("role", "option"); li.setAttribute("aria-selected", String(i === idx)); li.id = "bd-pal-" + i;
        li.append(mk("span", "", c.label)); if (c.hint) li.append(mk("kbd", "", c.hint));
        li.onmousedown = e => { e.preventDefault(); run(c); };
        ul.append(li);
      });
      inp.setAttribute("aria-activedescendant", items.length ? "bd-pal-" + idx : "");
      ul.children[idx]?.scrollIntoView({ block: "nearest" });
      if (!items.length) ul.append(mk("li", "bd-pal-empty", _t('board.chrome.102')));
    };
    const filter = () => {
      items = commands.map(c => ({ c, s: score(inp.value, c.label + " " + (c.keys || "")) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.c).slice(0, 40);
      idx = 0; draw();
    };
    const run = c => { d.close(); setTimeout(() => c.run(), 0); };
    inp.addEventListener("input", filter);
    inp.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); draw(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); idx = Math.max(0, idx - 1); draw(); }
      else if (e.key === "Enter") { e.preventDefault(); if (items[idx]) run(items[idx]); }
    });
    filter(); show(); inp.focus();
  }

  // ---- presentation --------------------------------------------------------------------------------------------
  function present(startIdx = 0) {
    const ctx = api.ctx(), frames = ctx.S.frames;
    if (!frames.length || pres) return;
    api.finishEdit();
    const ov = mk("div", "bd-pres"); ov.setAttribute("role", "dialog"); ov.setAttribute("aria-label", _t('board.chrome.027')); ov.setAttribute("aria-modal", "true"); ov.tabIndex = -1;
    const stage = mk("div", "bd-pres-stage"), count = mk("div", "bd-pres-count"); count.setAttribute("aria-live", "polite");
    const hint = mk("div", "bd-pres-hint", _t('board.chrome.103'));
    ov.append(stage, count, hint);
    root().append(ov);
    let i = Math.max(0, Math.min(frames.length - 1, startIdx));
    pres = { ov }; presExit = () => exit();
    let url = "", token = 0;
    const draw = async () => {   // each page is an isolated Blob-URL <img>: nothing from a card SVG can touch the live DOM
      const f = frames[i], my = ++token;
      count.textContent = `${i + 1} / ${frames.length}`;
      try {
        fontCssP ||= Promise.resolve(api.loadFontCss()).catch(() => "");
        const css = await fontCssP;
        if (my !== token || !pres) return;
        const next = URL.createObjectURL(new Blob([X.frameSvg(ctx, f, "screen", css)], { type: "image/svg+xml" }));
        const img = new Image();
        img.alt = _t('board.chrome.104', { 0: f.page }); img.draggable = false; img.src = next;
        await img.decode().catch(() => {});
        if (my !== token || !pres) { URL.revokeObjectURL(next); return; }
        stage.replaceChildren(img);
        if (url) URL.revokeObjectURL(url);
        url = next;
      } catch (e) { stage.textContent = _t('board.chrome.105'); }
    };
    const go = n => { const j = Math.max(0, Math.min(frames.length - 1, n)); if (j !== i) { i = j; draw(); } };
    const exit = () => {
      if (!pres) return;
      pres = null; presExit = null; token++;
      if (url) URL.revokeObjectURL(url);
      removeEventListener("keydown", onKey, true);
      document.removeEventListener("fullscreenchange", onFs);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      ov.remove();
      api.focusStage();
    };
    const onKey = e => {
      if (!pres) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;   // leave browser / OS shortcuts alone
      const k = e.key;
      if (k === "Escape") exit();
      else if (k === "ArrowRight" || k === "ArrowDown" || k === "PageDown" || k === " " || k === "Enter") go(i + (k === " " && e.shiftKey ? -1 : 1));
      else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp" || k === "Backspace") go(i - 1);
      else if (k === "Home") go(0);
      else if (k === "End") go(frames.length - 1);
      else return;
      e.preventDefault(); e.stopPropagation();
    };
    const onFs = () => { if (!document.fullscreenElement && pres) exit(); };
    addEventListener("keydown", onKey, true);
    document.addEventListener("fullscreenchange", onFs);
    let sx = null;
    ov.addEventListener("pointerdown", e => { sx = e.clientX; });
    ov.addEventListener("pointerup", e => {
      if (sx == null) return;
      const dx = e.clientX - sx; sx = null;
      if (Math.abs(dx) > 50) go(i + (dx < 0 ? 1 : -1));
      else if (Math.abs(dx) < 10) go(e.clientX < innerWidth * 0.3 ? i - 1 : i + 1);
    });
    draw();
    try { const p = ov.requestFullscreen?.(); p?.catch?.(() => {}); } catch { /* overlay fallback */ }
    ov.focus();
  }

  return { openExport, openPalette, openShortcuts, openInfo, openStyles, present, exportFrames, isBlocking, closeAll: () => { presExit?.(); document.querySelectorAll("#board dialog.bd-dlg").forEach(d => d.close()); } };
}
