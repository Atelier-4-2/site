// Site-analysis diagram mode of SiteLaser. Runs inside index.html: same header,
// stepper pattern, buttons, tokens and the same site picker (app.js's ignMap).
import {
  fetchBuildingsDetailed, fetchVegetation, fetchWaterSurfaces, fetchWaterLines,
  fetchRoads, fetchParcels, fetchOrthophoto, toWGS84,
  fetchPluZones, fetchSup, fetchReservedSites, fetchIsochrones, fetchElevationGrid
} from "./ign.js?v=20261113p";
import { zipSync, strToU8 } from "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";
import { DIAGRAMS, isReady } from "./dgdefs_v05.js?v=20261114r2";
import { PALETTES, PALETTE_ORDER } from "./dgpalettes.js?v=20261114t1";
import { STYLES } from "./dgsemantic_v02.js?v=20261114r1";
import { fetchTrees } from "./dgtrees.js?v=20261113p";
import { fetchTransit } from "./dgtransit.js?v=20261113p";
import { KO } from "./dgstrings.js?v=20261114t1";
import { createTabs, panZoom } from "./dgtabs_v05.js?v=20261114r2";
const DETAIL_ZOOM_HINT = "더블클릭하면 그 지점을 확대하고, 다시 더블클릭하면 원래 크기로 돌아갑니다. 확대한 상태에서는 드래그로 이동할 수 있습니다.";
import { renderSvg, svgToPng, loadFontCss, circleRing, SHEET } from "./dgcore_v04.js?v=20261114r2";
import { toDxf } from "./dgdxf_v03.js?v=20261114r2";
import { buildPdf } from "./dgpdf.js?v=20261114t1";
import { build3dm } from "./dg3dm_v03.js?v=20261114r2";

const $ = s => document.querySelector(s);
const body = document.body;

// ---- wait for the shared site picker ----------------------------------------
const shared = await new Promise(resolve => {
  if (globalThis.siteLaser) return resolve(globalThis.siteLaser);
  addEventListener("siteLaser:ready", () => resolve(globalThis.siteLaser), { once: true });
});
const { ignMap } = shared;

// ---- state ------------------------------------------------------------------
let step = 1;
let results = null;          // { ctx, data, status:{key:error|null} }
let busy = false;
let tabs = null;
let controller = null;
let palId = "swiss";
let baseLw = 1;
const cardOpts = new Map();  // num -> { lw }

const pal = () => PALETTES[palId];
const optsFor = (num, pId = palId) => {
  const o = cardOpts.get(num) || {};
  const def = DIAGRAMS.find(d => d.num === num);
  return { pal: PALETTES[pId], lw: baseLw * (o.lw || 1), param: o.param ?? def?.param?.def };
};
let generation = 0;   // bumped whenever a run is replaced or the mode is left; stale work checks it

// ---- mode / steps -----------------------------------------------------------
function inMode() { return body.dataset.mode === "diagrams"; }

function showDgStep(n, focus = false) {
  if (!inMode()) return;   // never re-show a diagram screen after the user left the mode
  const changed = n !== step;
  if (changed && step === 4) tabs?.stop();
  step = n;
  body.dataset.page = String(n);
  for (const b of document.querySelectorAll("[data-dgstep]")) {
    const s = Number(b.dataset.dgstep);
    const cur = s === n;
    if (cur) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
    b.querySelector(".step-state").textContent = cur ? "현재" : (s < n || (s >= 3 && results)) ? "완료" : "대기";
    b.disabled = busy || (s >= 2 && !ignMap.bounds) || (s >= 3 && !results);
  }
  const idx = { 1: 1, 3: 2, 4: 3 }[n];
  $("#step-count").textContent = `단계 ${idx}/3`;
  if (changed || focus) window.scrollTo({ top: 0, behavior: "auto" });
  if (n === 1) setTimeout(() => ignMap.resize(), 50);
  if (n === 3) summarizeSite();
  if (n === 4 && changed) tabs?.show();
  if (focus) $(n === 1 ? "#dg-step-title-1" : `#dg-step-title-${n}`)?.focus({ preventScroll: true });
}

function enterMode() {
  body.dataset.mode = "diagrams";
  $("#laser-stepper").hidden = true;
  $("#dg-stepper").hidden = false;
  if ($("#tab-ign")?.getAttribute("aria-selected") !== "true") $("#tab-ign").click();
  if (!ignMap.bounds) {
    $("#radius").value = 400;
    try { ignMap.setRadius(400); } catch { /* ignore */ }
  }
  showDgStep(1, true);
}

function leaveMode() {
  generation++;
  controller?.abort();
  controller = new AbortController();      // callbacks of the aborted run see a different signal and stop
  for (const k of Object.keys(layers.status)) if (layers.status[k] === "loading") delete layers.status[k];
  busy = false;
  tabs?.stop();
  delete body.dataset.mode;
  $("#laser-stepper").hidden = false;
  $("#dg-stepper").hidden = true;
  $("#step-count").textContent = "단계 1/4";
}

$("#start-diagrams").addEventListener("click", enterMode);
$("#start").addEventListener("click", leaveMode);
$("#brand-home")?.addEventListener("click", leaveMode);
for (const b of document.querySelectorAll("[data-dgstep]")) {
  b.addEventListener("click", () => { if (!b.disabled) showDgStep(Number(b.dataset.dgstep), true); });
}

// ---- site -------------------------------------------------------------------
const shapeSel = $("#dg-shape");
shapeSel.addEventListener("change", () => { $("#dg-rect-field").hidden = shapeSel.value !== "rect"; });

function readSite() {
  const b = ignMap.bounds;
  if (!b) return null;
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, half = (b[2] - b[0]) / 2;
  const shape = shapeSel.value;
  let ring, w, h, label;
  if (shape === "circle") {
    ring = circleRing(cx, cy, half, 128); w = h = half * 2; label = `원 반경 ${Math.round(half)} m`;
  } else if (shape === "rect") {
    w = Math.max(20, Number($("#dg-w").value) || 400); h = Math.max(20, Number($("#dg-h").value) || 300);
    ring = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
    label = `${Math.round(w)} × ${Math.round(h)} m`;
  } else {
    w = h = half * 2; ring = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
    label = `반경 ${Math.round(half)} m`;
  }
  // The analysis extent IS the chosen site shape (no circumscribed square): circle -> its bounding
  // square cropped to a circle, square -> square, rectangle -> W x H.
  const kind = shape === "circle" ? "circle" : shape === "rect" ? "rect" : "square";
  const extent = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2].map(v => Math.round(v * 100) / 100);
  const [lon, lat] = toWGS84(cx, cy);
  const addr = $("#search").value.trim() || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  // Lambert-93 grid convergence: true north is rotated by -n*(lon-3 deg) from map-up.
  const convergence = -0.7256077650532670 * (lon - 3);
  return {
    center: [cx, cy], lat, lon, extent, shape: { kind, w, h }, site: { ring }, address: addr, radiusLabel: label,
    date: new Date().toISOString().slice(0, 10), convergence, radius: half
  };
}

function summarizeSite() {
  const c = readSite();
  $("#dg-site-summary").textContent = c
    ? `대지: ${c.address} · ${c.radiusLabel} · 분석 범위 ${Math.round(c.extent[2] - c.extent[0])} m`
    : "지도에서 대상 대지를 먼저 선택해 주세요.";
}

$("#dg-site-next").addEventListener("click", () => {
  const err = $("#site-error");
  if (!ignMap.bounds) {
    err.textContent = "지도에서 분석 대지 범위를 먼저 지정해 주세요."; err.hidden = false; return;
  }
  err.textContent = ""; err.hidden = true;
  generate();
});

// ---- settings -----------------------------------------------------------------
function previewPalette() {
  if (!$("#dg-mini")) return;
  const def = DIAGRAMS.find(d => d.num === "03");
  const ring = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const ctx = { extent: [0, 0, 100, 100], center: [50, 50], site: { ring }, shape: { kind: "square" } };
  const buildings = ["Residentiel", "Commercial et services", "Industriel"].map((usage, i) => ({
    usage, holes: [], polygon: [[10+i*28, 20], [30+i*28, 20], [30+i*28, 80], [10+i*28, 80]]
  }));
  const sheet = def.build(ctx, { buildings }, { pal: pal(), lw: baseLw });
  $("#dg-mini").innerHTML = renderSvg(def, sheet, ctx, { card: true, prefix: "mini-", pal: pal() });
}

for (const b of document.querySelectorAll("[data-dg-pal]")) {
  const p = PALETTES[b.dataset.dgPal];
  const strip = document.createElement("span");
  strip.className = "dg-palette-strip";
  strip.setAttribute("aria-hidden", "true");
  const st = STYLES[b.dataset.dgPal] || {};
  strip.innerHTML = [...(st.use6 || []).slice(0, 4), st.green, st.water].filter(Boolean)
    .map(c => `<i style="background:${c}"></i>`).join("");
  b.append(strip);
  b.addEventListener("click", () => {
    palId = b.dataset.dgPal;
    previewPalette();
    document.querySelectorAll("[data-dg-pal]").forEach(x => x.setAttribute("aria-checked", String(x === b)));
    if (step === 4) tabs?.refresh();
    if (results) renderCards();
  });
}
$("#dg-lw").addEventListener("input", e => {
  baseLw = Number(e.target.value);
  previewPalette();
  $("#dg-lw-out").textContent = baseLw.toFixed(1) + "×";
});
$("#dg-lw").addEventListener("change", () => { if (results) renderCards(); });

// ---- data ---------------------------------------------------------------------
const FETCHERS = {
  buildings: (b, s, p) => fetchBuildingsDetailed(b, s, p),
  roads: (b, s, p) => fetchRoads(b, s, p),
  veg: (b, s, p) => fetchVegetation(b, s, p),
  waterS: (b, s, p) => fetchWaterSurfaces(b, s, p),
  waterL: (b, s, p) => fetchWaterLines(b, s, p),
  parcels: (b, s, p) => fetchParcels(b, s, p),
  // roads with a 500 m buffer around the sheet (blocks, Space Syntax choice)
  roadsWide: (b, s, p) => fetchRoads([b[0] - 500, b[1] - 500, b[2] + 500, b[3] + 500], s, p),
  plu: (b, s, p) => fetchPluZones(b, s, p),
  sup: (b, s, p) => fetchSup(b, s, p),
  er: (b, s, p) => fetchReservedSites(b, s, p),
  trees: (b, s, p, ctx) => fetchTrees(b, ctx.center, s, p),
  transit: (b, s, p, ctx) => fetchTransit(b, ctx.center, s, p),
  iso: (b, s, p, ctx) => fetchIsochrones(ctx.center, s, p),
  dem: (b, s, p) => fetchElevationGrid(b, s, p),
  climate: async (b, s) => {
    const r = await fetch(new URL("./dgclimate.json?v=20261113p", import.meta.url), { signal: s });
    if (!r.ok) throw new Error("기후 데이터(EPW 요약)를 불러오지 못했습니다.");
    return await r.json();
  },
  ortho: async (b, s) => {
    const blob = await fetchOrthophoto(b, 1600, s);
    return await new Promise((res, rej) => {
      const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob);
    });
  }
};
const FETCH_ORDER = ["buildings", "roads", "roadsWide", "veg", "waterS", "waterL", "parcels", "plu", "sup", "er", "iso", "climate", "trees", "transit", "ortho", "dem"];
const DATA_LABEL = { buildings: "건물", roads: "도로", veg: "녹지", waterS: "수면", waterL: "하천선", parcels: "필지", ortho: "항공사진",
  roadsWide: "도로(완충 구간)", plu: "PLU 구역", sup: "SUP 보호구역", er: "예정부지", iso: "도보 등시간권", trees: "수목", transit: "대중교통", dem: "표고 격자", climate: "기후(EPW)" };

// Each layer loads independently; a card draws as soon as its own layers arrive.
const layers = { key: "", status: {}, data: {}, errors: {} };   // status: loading | ok | error

function startLayers(ctx, signal, only = null) {
  const key = ctx.extent.join(",");
  if (layers.key !== key) {
    layers.key = key;
    for (const o of [layers.status, layers.data, layers.errors]) for (const x of Object.keys(o)) delete o[x];
  }
  const need = new Set(DIAGRAMS.filter(isReady).flatMap(d => [...d.needs, ...(d.wants || [])]));
  for (const k of FETCH_ORDER) {
    if (!need.has(k) || (only && !only.includes(k))) continue;
    if (layers.status[k] === "ok" || layers.status[k] === "loading") continue;
    layers.status[k] = "loading"; delete layers.errors[k];
    FETCHERS[k](ctx.extent, signal, () => {}, ctx).then(d => {
      if (signal !== controller.signal) return;
      layers.data[k] = d; layers.status[k] = "ok";
    }).catch(e => {
      if (signal !== controller.signal) return;
      layers.status[k] = "error"; layers.errors[k] = e.name === "AbortError" ? "취소되었습니다." : e.message;
    }).finally(() => { if (signal === controller.signal) onLayer(k); });
  }
}

const layerWaiting = () => Object.values(layers.status).some(v => v === "loading");
const completion = statuses => statuses.length
  ? Math.floor(100 * statuses.filter(s => s === "ok" || s === "error").length / statuses.length) : 0;

function onLayer(k) {
  for (const def of DIAGRAMS) {
    if (!isReady(def) || ![...def.needs, ...(def.wants || [])].includes(k)) continue;
    dropSheets(def.num);
    const el = $(`#dg-grid .dg-card[data-num="${def.num}"]`);
    if (!el) continue;
    cardObserver?.unobserve(el);
    fillCard(el, def, !cardObserver);
    if (el._lazy) cardObserver.observe(el);
  }
  scheduleBackgroundFill();
  if (step === 4 && ["dem", "climate", "buildings", "trees", "roads", "ortho", "veg", "waterS", "parcels"].includes(k)) tabs?.refresh();
  updateProgress();
}

function updateProgress() {
  if (!results) return;
  const keys = Object.keys(layers.status);
  const failed = keys.filter(x => layers.status[x] === "error");
  const c = results.ctx;
  if (layerWaiting()) {
    $("#dg-progress").textContent = `${c.address} · 데이터 조회 ${completion(keys.map(k => layers.status[k]))}%${failed.length ? ` · 실패 ${failed.length}` : ""}`;
  } else {
    $("#dg-progress").textContent = failed.length
      ? `일부 레이어를 불러오지 못했습니다: ${failed.map(x => DATA_LABEL[x]).join(", ")} — 카드의 '다시 시도'를 눌러 다시 조회해 주세요.`
      : `${c.address} · ${c.radiusLabel} · 데이터 조회 100% · ${c.date}`;
    setBusy(false);
    if (!exporting) setExportButtons(false);
  }
}

function retryCard(def) {
  if (controller.signal.aborted) controller = new AbortController();
  const bad = def.needs.filter(k => layers.status[k] === "error");
  startLayers(results.ctx, controller.signal, bad);
  for (const k of bad) onLayer(k);
  setBusy(true);
}

// ---- generation -----------------------------------------------------------------
function setBusy(v) { busy = v; $("#dg-radius-apply").disabled = v; if (inMode()) showDgStep(step); }

function generate() {
  const ctx = readSite();
  const err = $("#dg-error");
  err.hidden = true;
  if (!ctx) { err.textContent = "지도에서 대상 대지를 먼저 선택해 주세요."; err.hidden = false; return; }
  generation++;
  controller?.abort();
  for (const k of Object.keys(layers.status)) if (layers.status[k] === "loading") delete layers.status[k];
  controller = new AbortController();
  dropSheets();
  results = { ctx, data: layers.data, errors: layers.errors };
  setBusy(true);
  setExportButtons(true);
  $("#dg-card-radius").value = Math.round(ctx.radius);
  // failed layers are retried on every run; layers already loaded for this extent are reused
  for (const k of Object.keys(layers.status)) if (layers.status[k] === "error" && layers.key === ctx.extent.join(",")) delete layers.status[k];
  startLayers(ctx, controller.signal);
  renderCards();
  showDgStep(3, true);
  updateProgress();
}


$("#dg-radius-apply").addEventListener("click", () => {
  const r = Number($("#dg-card-radius").value);
  if (!(r >= 20 && r <= 2500)) { $("#dg-progress").textContent = "반경은 20~2,500 m 범위로 입력해 주세요."; return; }
  $("#radius").value = r;
  ignMap.setRadius(r);
  generate();
});

// ---- cards ------------------------------------------------------------------------
function build(def, pId = palId) {
  const { ctx, data, errors } = results;
  const missing = def.needs.find(k => errors[k] || !(k in data));
  if (missing) return { error: `${DATA_LABEL[missing]} 데이터를 불러오지 못했습니다${errors[missing] ? ": " + errors[missing] : ""}` };
  try {
    const opt = optsFor(def.num, pId);
    // heavy sheets (sun hours, sky view, viewshed, choice ...) are computed once per
    // (card, parameter, line weight, palette) and reused by card redraws, A7 and the ZIP
    const key = `${def.num}|${opt.param ?? ""}|${opt.lw}|${pId}`;
    let sheet = sheetCache.get(key);
    if (!sheet) { sheet = def.build(ctx, data, opt); sheetCache.set(key, sheet); }
    return { sheet };
  } catch (e) { return { error: e.message }; }
}
const sheetCache = new Map();
const dropSheets = num => { for (const k of [...sheetCache.keys()]) if (!num || k.startsWith(num + "|")) sheetCache.delete(k); };

const slug = def => `${def.num}_${def.en.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

// Cards are drawn lazily: the heavy analyses (blocks, choice, D/H) only run for
// cards that scroll near the viewport. A card element is created once and only its
// preview is swapped afterwards, so keyboard focus survives updates.
let cardObserver = null;
let themeFilter = "all";

function renderCards() {
  const grid = $("#dg-grid");
  cardObserver?.disconnect();
  cardObserver = "IntersectionObserver" in window
    ? new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        cardObserver.unobserve(en.target);
        const def = DIAGRAMS.find(d => d.num === en.target.dataset.num);
        if (en.target.isConnected && en.target._lazy) fillCard(en.target, def, true);
      }
    }, { rootMargin: "400px" })
    : null;
  grid.replaceChildren();
  for (const def of DIAGRAMS) {
    const el = makeCard(def);
    grid.append(el);
    fillCard(el, def, !cardObserver);
    if (el._lazy) cardObserver.observe(el);
  }
  buildFilters();
  applyFilter();
  scheduleBackgroundFill();
}

// Cards far from the viewport are filled one at a time in the background, so a hidden or
// never-scrolled page still ends up complete (ZIP, A7 and tabs never wait for scrolling),
// while the heavy analyses are not all run in one blocking burst.
let bgTimer = 0;
function scheduleBackgroundFill() {
  clearTimeout(bgTimer);
  const gen = generation;
  const step = () => {
    if (gen !== generation || !results) return;
    const next = [...document.querySelectorAll("#dg-grid .dg-card")].find(c => c._lazy);
    if (!next) return;
    const def = DIAGRAMS.find(d => d.num === next.dataset.num);
    cardObserver?.unobserve(next);
    fillCard(next, def, true);
    bgTimer = setTimeout(step, 150);
  };
  bgTimer = setTimeout(step, 800);
}

function buildFilters() {
  const box = $("#dg-filters");
  if (!box) return;
  box.innerHTML = KO.themes.map(([id, label]) => {
    const n = id === "all" ? DIAGRAMS.length : DIAGRAMS.filter(d => d.theme === id).length;
    return `<button type="button" data-theme="${id}" aria-pressed="${themeFilter === id}">${label} (${n})</button>`;
  }).join("");
}
function applyFilter() {
  document.querySelectorAll("#dg-grid .dg-card").forEach(c => { c.hidden = themeFilter !== "all" && c.dataset.theme !== themeFilter; });
  document.querySelectorAll("#dg-filters [data-theme]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.theme === themeFilter)));
}
$("#dg-filters")?.addEventListener("click", e => {
  const b = e.target.closest("[data-theme]");
  if (b) { themeFilter = b.dataset.theme; applyFilter(); }
});

function makeCard(def) {
  const el = document.createElement("article");
  el.className = "dg-card";
  el.dataset.num = def.num;
  el.dataset.theme = def.theme || "";
  el.innerHTML = `
    <div class="dg-disc is-empty"></div>
    <h4 class="dg-title"><span class="dg-num">${def.num}</span> ${def.ko}</h4>
    <div class="dg-actions">
      <button type="button" data-act="png" disabled>PNG</button>
      <button type="button" data-act="pdf" disabled>PDF</button>
      <button type="button" data-act="detail" disabled>${KO.ui.detail}</button>
    </div>`;
  el.querySelector('[data-act="png"]').onclick = e => el._built && exportOne(def, el._built.sheet, "png", e.currentTarget);
  el.querySelector('[data-act="pdf"]').onclick = e => el._built && exportOne(def, el._built.sheet, "pdf", e.currentTarget);
  el.querySelector('[data-act="detail"]').onclick = () => el._built && openDetail(def);
  const disc = el.querySelector(".dg-disc");
  disc.addEventListener("click", e => { if (el._built && !e.target.closest("button")) openDetail(def); });
  disc.addEventListener("keydown", e => { if (el._built && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openDetail(def); } });
  return el;
}

// Card crop follows the site shape: circle, square or W x H rectangle.
function discStyle() {
  const sh = results?.ctx?.shape;
  if (!sh || sh.kind === "circle") return "";
  const r = sh.w / sh.h;
  return `aspect-ratio:${sh.w}/${sh.h};border-radius:12px;` + (r >= 1 ? "" : `width:${Math.round(240 * r)}px;max-width:100%;`);
}

function fillCard(el, def, eager) {
  const ready = isReady(def);
  let disc = "", state = "", retry = false;
  el._lazy = false; el._built = null; el.title = "";
  const sts = ready && results ? [...def.needs.map(k => layers.status[k]), ...(def.wants || []).map(k => layers.status[k] === "loading" ? "loading" : "ok")] : [];
  if (!ready) state = KO.ui.pending;
  else if (!results) state = "0%";
  else if (sts.includes("error")) {
    state = KO.ui.failed; retry = true;
    el.title = def.needs.filter(k => layers.status[k] === "error").map(k => `${DATA_LABEL[k]}: ${layers.errors[k]}`).join(" / ");
  } else if (sts.some(v => v !== "ok")) state = `${completion(sts)}%`;
  else if (!eager) { state = "100%"; el._lazy = true; }
  else {
    const r = build(def);
    if (r.error) { state = KO.ui.failed; el.title = r.error; }
    else {
      disc = renderSvg(def, r.sheet, results.ctx, { prefix: `c${def.num}-`, card: true, pal: pal() });
      el._built = r;
    }
  }
  const box = el.querySelector(".dg-disc");
  box.className = "dg-disc" + (disc ? "" : " is-empty");
  box.dataset.shape = results?.ctx?.shape?.kind || "circle";
  box.style.cssText = discStyle();
  box.innerHTML = disc || `<span>${state}${retry ? ` · <button type="button" class="dg-retry" data-retry>${KO.ui.retry}</button>` : ""}</span>`;
  if (el._built) { box.setAttribute("role", "button"); box.tabIndex = 0; box.setAttribute("aria-label", `${def.num} ${def.ko} ${KO.ui.openCard}`); }
  else { box.removeAttribute("role"); box.removeAttribute("tabindex"); box.removeAttribute("aria-label"); }
  box.setAttribute("aria-busy", String(state.endsWith("%")));
  box.querySelector("[data-retry]")?.addEventListener("click", () => retryCard(def));
  el.querySelectorAll(".dg-actions button").forEach(b => { b.disabled = !el._built; });
}

// ---- export -----------------------------------------------------------------------------
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const currentSnap = () => ({ ctx: results.ctx, pal: pal(), pId: palId, data: results.data });

const svgText = (def, sheet, extra = {}, snap = currentSnap()) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' + renderSvg(def, sheet, snap.ctx, { absoluteSize: true, pal: snap.pal, ...extra });

// SVG for the PDF writer (svg2pdf): same drawing, halo text and baselines adjusted (renderSvg opts.pdf)
const pdfSvg = (def, sheet, snap) => renderSvg(def, sheet, snap.ctx, { pdf: true, pal: snap.pal });
const pdfMeta = (def, snap) => ({ title: `${def.num} ${def.ko || def.fr}`, subject: `${snap.ctx.address} · ${snap.ctx.radiusLabel}` });
// 3dm of one diagram; the 3D volume layers only go into the all-in-one file and the A1 / A8 tabs
const to3dm = async (jobs, title) => new Blob([await build3dm(jobs, { title })], { type: "application/octet-stream" });
const job3dm = (def, sheet, snap, volumes = false) => ({ def, sheet, ctx: snap.ctx, pal: snap.pal, data: snap.data, volumes });

async function fileFor(def, sheet, kind, snap = currentSnap()) {
  if (kind === "svg") return new Blob([svgText(def, sheet, {}, snap)], { type: "image/svg+xml" });
  if (kind === "dxf") return new Blob([toDxf(sheet, snap.ctx, snap.pal, def)], { type: "application/dxf" });
  if (kind === "pdf") return buildPdf([{ svg: pdfSvg(def, sheet, snap) }], pdfMeta(def, snap));
  if (kind === "3dm") return to3dm([job3dm(def, sheet, snap)], `${def.num} ${def.ko}`);
  const fontCss = await loadFontCss();
  return svgToPng(svgText(def, sheet, { fontCss }, snap), 2, snap.pal.bg);
}

async function exportOne(def, sheet, kind, button) {
  const label = button?.textContent;
  if (button) { button.disabled = true; button.textContent = "…"; }
  try {
    download(await fileFor(def, sheet, kind), `${slug(def)}.${kind}`);
  } catch (e) {
    $("#dg-progress").textContent = `${kind.toUpperCase()} 내보내기 실패: ${e.message}`;
    console.error(e);
  } finally {
    if (button) { button.disabled = false; button.textContent = label; }
  }
}

// ---- batch exports: ZIP / all-in-one PDF / all-in-one 3dm --------------------------------------------------
// Everything a batch needs is frozen when it starts; a new run / mode change cancels it, and the controls
// that would change the result stay locked while it runs.
let exporting = false;
const EXPORT_BTNS = ["#dg-zip", "#dg-pdf-all", "#dg-3dm-all"];
function setExportButtons(off) { for (const id of EXPORT_BTNS) { const b = $(id); if (b) b.disabled = off; } }

async function batchExport(label, work) {
  if (!results || exporting) return;
  exporting = true;
  setExportButtons(true);
  const gen0 = generation, snap = currentSnap(), res0 = results;
  const cancelled = () => gen0 !== generation || res0 !== results;
  $("#dg-radius-apply").disabled = true;
  const stop = () => { if (cancelled()) throw new Error(`대지나 반경이 바뀌어 ${label} 생성을 취소했습니다.`); };
  try {
    await work(snap, stop, cancelled);
  } catch (err) {
    console.error(err);
    $("#dg-progress").textContent = `${label} 실패: ${err.message}`;
  } finally {
    exporting = false;
    if (!layerWaiting()) { setExportButtons(false); $("#dg-radius-apply").disabled = false; }
  }
}
const readyBuilds = (snap, skipped) => {
  const out = [];
  for (const def of DIAGRAMS.filter(isReady)) {
    const r = build(def, snap.pId);
    if (r.error) skipped.push(`${def.num} ${def.ko}: ${r.error}`); else out.push({ def, sheet: r.sheet });
  }
  return out;
};
const yieldUi = () => new Promise(r => setTimeout(r, 0));
const u8 = async blob => new Uint8Array(await blob.arrayBuffer());

async function allPdf(builds, snap, tag, cancelled) {
  return buildPdf(builds.map(b => ({ svg: pdfSvg(b.def, b.sheet, snap) })), {
    title: `Terrain ${snap.ctx.address}`, subject: `${snap.ctx.radiusLabel} · ${builds.length}장`,
    isCancelled: cancelled,
    onProgress: (i, n) => { $("#dg-progress").textContent = `${tag} ${i}/${n} · ${builds[i - 1].def.num} ${builds[i - 1].def.ko}`; }
  });
}
async function all3dm(builds, snap, tag, stop) {
  const jobs = builds.map((b, i) => job3dm(b.def, b.sheet, snap, i === 0));   // the 3D layers are written once
  $("#dg-progress").textContent = `${tag} · ${builds.length}장`;
  await yieldUi(); stop();
  return to3dm(jobs, `Terrain ${snap.ctx.address}`);
}

$("#dg-pdf-all").addEventListener("click", () => batchExport("PDF", async (snap, stop, cancelled) => {
  const skipped = [], builds = readyBuilds(snap, skipped);
  if (!builds.length) throw new Error("저장할 수 있는 다이어그램이 없습니다.");
  const blob = await allPdf(builds, snap, "PDF", cancelled);
  stop();
  download(blob, "terrain_all.pdf");
  $("#dg-progress").textContent = `${snap.ctx.address} · ${snap.ctx.radiusLabel} · 전체 PDF ${builds.length}쪽 저장` + (skipped.length ? ` · 제외 ${skipped.length}장` : "");
}));

$("#dg-3dm-all").addEventListener("click", () => batchExport("3dm", async (snap, stop) => {
  const skipped = [], builds = readyBuilds(snap, skipped);
  if (!builds.length) throw new Error("저장할 수 있는 다이어그램이 없습니다.");
  const blob = await all3dm(builds, snap, "3dm", stop);
  stop();
  download(blob, "terrain_all.3dm");
  $("#dg-progress").textContent = `${snap.ctx.address} · ${snap.ctx.radiusLabel} · 전체 3dm ${builds.length}장 저장` + (skipped.length ? ` · 제외 ${skipped.length}장` : "");
}));

$("#dg-zip").addEventListener("click", () => batchExport("ZIP", async (snap, stop, cancelled) => {
  const files = {}, skipped = [];
  const builds = readyBuilds(snap, skipped);
  const n = builds.length;
  if (!n) throw new Error("저장할 수 있는 다이어그램이 없습니다.");
  let i = 0;
  for (const { def, sheet } of builds) {
    stop();
    i++;
    const s2 = slug(def);
    for (const kind of ["svg", "dxf", "png", "pdf", "3dm"]) {
      $("#dg-progress").textContent = `ZIP ${i}/${n} · ${def.num} ${def.ko} (${kind.toUpperCase()})`;
      const blob = await fileFor(def, sheet, kind, snap);
      files[`${s2}.${kind}`] = kind === "svg" || kind === "dxf" ? strToU8(await blob.text()) : await u8(blob);
      await yieldUi();
    }
  }
  stop();
  files["terrain_all.pdf"] = await u8(await allPdf(builds, snap, "ZIP 전체 PDF", cancelled));
  stop();
  files["terrain_all.3dm"] = await u8(await all3dm(builds, snap, "ZIP 전체 3dm", stop));
  stop();
  files["README.txt"] = strToU8(readme(snap, skipped));
  $("#dg-progress").textContent = "ZIP 묶는 중…";
  await yieldUi();
  const zip = zipSync(files, { level: 6 });
  download(new Blob([zip], { type: "application/zip" }), "terrain_diagrams.zip");
  $("#dg-progress").textContent = `${snap.ctx.address} · ${snap.ctx.radiusLabel} · ZIP ${n}/${DIAGRAMS.filter(isReady).length}장 저장 (${(zip.length / 1048576).toFixed(1)} MB)` +
    (skipped.length ? ` · 제외 ${skipped.length}장 (README 참조)` : "");
}));

function readme(snap, skipped) {
  const c = snap.ctx, off = c.center.map(v => Math.round(v * 1000) / 1000);
  return `Terrain 대지 다이어그램\n${c.address} · ${c.radiusLabel}\n조회일 ${c.date}\n\n` +
    "파일 형식\n" +
    "- *.pdf : A3 가로 벡터 PDF(글자 포함). terrain_all.pdf = 전체 다이어그램을 한 파일에 묶은 쪽 모음\n" +
    "- *.png : 3175 x 2245 px 래스터\n- *.svg : A3 벡터(Illustrator·Inkscape 등)\n" +
    "- *.dxf : AutoCAD DXF R2000. 다이어그램 레이어 1개 = DXF 레이어 1개, 닫힌 폴리선(해치 없음), 글자는 TEXT/TITLE/LEGEND 레이어. DWG가 필요하면 AutoCAD에서 열어 '다른 이름으로 저장'\n" +
    "- *.3dm / terrain_all.3dm : Rhino 파일(rhino3dm). 다이어그램마다 부모 레이어 'NN 제목', 아래에 다이어그램 레이어. terrain_all.3dm에는 3D_건물·3D_지형 레이어(3D 볼륨)가 함께 들어 있음\n\n" +
    "좌표\n" +
    "- DXF: 좌표계 RGF93 / Lambert-93 (EPSG:2154) 실좌표 그대로, 단위 m (다른 IGN 자료와 겹쳐 쓸 수 있음)\n" +
    `- 3dm: 단위 m, 모델 원점 = 대지 중심. 원래 좌표(Lambert-93) = 모델 좌표 + (E ${off[0]}, N ${off[1]}). 이동량은 문서 UserText와 각 객체 UserText(L93_offset_E / L93_offset_N)에도 기록. 3D 높이는 대지 중심 지면(IGN RGE ALTI)을 0으로 한 상대 높이\n` +
    "- 데이터 © IGN 등(각 다이어그램의 출처 참조). 참고용 시뮬레이션이며 법적 효력이 없습니다.\n" +
    (skipped.length ? `\n포함되지 않은 다이어그램 ${skipped.length}장:\n${skipped.join("\n")}\n` : "");
}

// ---- detail dialog ------------------------------------------------------------------------
let detail = null;
function openDetail(def) {
  let dlg = $("#dg-detail");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "dg-detail"; dlg.className = "dg-detail";
    dlg.setAttribute("aria-labelledby", "dg-detail-title");
    document.body.append(dlg);
    dlg.addEventListener("close", () => { detail = null; });
  }
  detail = { def };
  const o = cardOpts.get(def.num) || {};
  const p = def.param;
  dlg.innerHTML = `<div class="dg-detail-head"><h3 id="dg-detail-title">${def.num} · ${def.ko} <small>${KO.ui.detailTitle}</small></h3>
    <div class="dg-detail-ctl">
      <label>${KO.ui.lineWeight} <input type="range" data-ctl="lw" min="0.5" max="2" step="0.1" value="${o.lw || 1}"> <output>${(o.lw || 1).toFixed(1)}×</output></label>
      ${p ? `<label>${p.label} ${p.options
        ? `<select data-ctl="param">${p.options.map(([v, t]) => `<option value="${v}"${Number(o.param ?? p.def) === v ? " selected" : ""}>${t}</option>`).join("")}</select>`
        : `<input type="number" data-ctl="param" min="${p.min}" max="${p.max}" step="${p.step}" value="${o.param ?? p.def}">`}</label>` : ""}
    </div>
    <div class="dg-actions"><button data-k="pdf">PDF</button><button data-k="png">PNG</button><button data-k="svg">SVG</button><button data-k="dxf">DXF (AutoCAD)</button><button data-k="3dm">3dm (Rhino)</button><button data-k="x">${KO.ui.close}</button></div></div>
    <div class="dg-sheet" id="dg-detail-sheet"></div>
    <p class="note" style="margin:8px 0 0">${DETAIL_ZOOM_HINT}</p>`;
  renderDetailSheet();
  panZoom($("#dg-detail-sheet"), { wheel: false });   // double-click zoom; the wheel keeps scrolling the dialog
  dlg.querySelectorAll(".dg-actions button").forEach(b => b.onclick = () => {
    if (b.dataset.k === "x") dlg.close();
    else { const r = build(def); if (r.sheet) exportOne(def, r.sheet, b.dataset.k, b); }
  });
  dlg.querySelector('[data-ctl="lw"]')?.addEventListener("change", e => {
    cardOpts.set(def.num, { ...(cardOpts.get(def.num) || {}), lw: Number(e.target.value) });
    e.target.nextElementSibling.textContent = Number(e.target.value).toFixed(1) + "×";
    afterDetailChange(def);
  });
  dlg.querySelector('[data-ctl="param"]')?.addEventListener("change", e => {
    const v = p.options ? Number(e.target.value) : Math.min(p.max, Math.max(p.min, Number(e.target.value) || p.def));
    cardOpts.set(def.num, { ...(cardOpts.get(def.num) || {}), param: v });
    afterDetailChange(def);
  });
  dlg.showModal();
}
function renderDetailSheet() {
  if (!detail) return;
  const r = build(detail.def);
  $("#dg-detail-sheet").innerHTML = r.sheet ? renderSvg(detail.def, r.sheet, results.ctx, { prefix: "dt-", pal: pal() }) : `<p class="note">${r.error}</p>`;
}
function afterDetailChange(def) {
  renderDetailSheet();
  const el = $(`#dg-grid .dg-card[data-num="${def.num}"]`);
  if (el) fillCard(el, def, true);     // only the preview changes; the card keeps its focus
}

// Keep the card radius field in step with the shared site radius.
$("#radius")?.addEventListener("input", () => { $("#dg-card-radius").value = $("#radius").value; });
void SHEET;


// ---- analysis tabs (step 4) ------------------------------------------------------------------
async function pngFromSvg(svg) {
  const m = /viewBox="([\d.\-e ]+)"/.exec(svg);
  const [, , vw, vh] = m[1].split(/\s+/).map(Number);
  const W = 2400, H = Math.round(W * vh / vw);
  const fontCss = await loadFontCss();
  const withSize = svg.replace("<svg ", `<svg width="${W}" height="${H}" `).replace(/(<svg[^>]*>)/, `$1<style>${fontCss}</style>`);
  const url = URL.createObjectURL(new Blob([withSize], { type: "image/svg+xml" }));
  try {
    const img = new Image(); img.src = url; await img.decode();
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d"); g.fillStyle = pal().bg; g.fillRect(0, 0, W, H); g.drawImage(img, 0, 0, W, H);
    return await new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error("PNG 변환 실패")), "image/png"));
  } finally { URL.revokeObjectURL(url); }
}

// Analysis tabs: PDF / DXF / 3dm of a tab result. spec = { def, sheet, name, ctx?, svg?, volumes?, origin?, docOrigin?, custom? }
// ctx is the drawing's own frame for A5 / A8 (local coordinates, m); without it the site ctx (Lambert-93) is used.
async function tabExport(kind, spec, button) {
  if (!results || !spec) return;
  const label = button?.textContent;
  if (button) { button.disabled = true; button.textContent = "…"; }
  try {
    const snap = currentSnap(), ctx = spec.ctx || snap.ctx, meta = { title: `${spec.def.num} ${spec.def.ko}`, subject: `${snap.ctx.address} · ${snap.ctx.radiusLabel}` };
    let blob;
    if (kind === "pdf") {
      const svg = spec.svg ? spec.svg.replace(/font-weight="600"/g, 'font-weight="bold"') : pdfSvg(spec.def, spec.sheet, { ...snap, ctx });
      blob = await buildPdf([{ svg, fit: !!spec.svg && !ctx.paperMm }], meta);
    } else if (kind === "dxf") blob = new Blob([toDxf(spec.sheet, ctx, snap.pal, spec.def)], { type: "application/dxf" });
    else {
      blob = new Blob([await build3dm([{ def: spec.def, sheet: spec.sheet, ctx, pal: snap.pal, data: snap.data, volumes: !!spec.volumes, volCtx: snap.ctx, origin: spec.origin || null }],
        { title: meta.title, origin: spec.docOrigin || (spec.custom ? ctx.center : null), custom: !!spec.custom })], { type: "application/octet-stream" });
    }
    download(blob, `${spec.name}.${kind}`);
  } catch (e) {
    console.error(e);
    $("#dg-tabnote").textContent = `${kind.toUpperCase()} 저장 실패: ${e.message}`;
  } finally {
    if (button) { button.disabled = false; button.textContent = label; }
  }
}

tabs = createTabs({
  exportTab: tabExport,
  ctx: () => results?.ctx, data: () => results?.data, pal, status: k => layers.status[k],
  defs: () => DIAGRAMS.filter(isReady),
  sheetOk: def => results && def.needs.every(k => layers.status[k] === "ok"),
  sheetFor: def => { const r = build(def); return r.sheet || null; },
  png: (def, sheet) => fileFor(def, sheet, "png"),
  pngFromSvg, download
});
$("#dg-to-analysis").addEventListener("click", () => showDgStep(4, true));
for (const b of document.querySelectorAll("[data-dgstep-go]")) {
  b.addEventListener("click", () => { if (results || Number(b.dataset.dgstepGo) <= 2) showDgStep(Number(b.dataset.dgstepGo), true); });
}

// Arrow-key navigation for the palette radio group (roving tabindex).
{
  const radios = [...document.querySelectorAll("[data-dg-pal]")];
  const sync = () => radios.forEach(r => { r.tabIndex = r.getAttribute("aria-checked") === "true" ? 0 : -1; });
  sync();
  radios.forEach(r => r.addEventListener("click", sync));
  radios.forEach((r, i) => r.addEventListener("keydown", e => {
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next = radios[e.key === "Home" ? 0 : e.key === "End" ? radios.length - 1 : (i + d + radios.length) % radios.length];
    next.click(); next.focus();
  }));
}
$("#dg-back-to-sheets").addEventListener("click", () => showDgStep(3, true));
