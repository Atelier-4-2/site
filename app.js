import { t as _t, loadedPromise } from "./i18n.js?v=20261122M";
import { IGNMap, searchPlaces, fetchBuildings, fetchTerrain, toWGS84 } from "./ign.js?v=20261122M";
import { Viewer3D } from "./viewer3d.js?v=20261122M";
import {
  zipSync,
  strToU8
} from "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";
await loadedPromise;   // the catalogs are ready before any module-level t() call

const $ = selector => document.querySelector(selector);
const PAPER_MM = {
  A0: [841, 1189],
  A1: [594, 841],
  A2: [420, 594],
  A3: [297, 420],
  A4: [210, 297]
};
const RHINO_BASE = "https://cdn.jsdelivr.net/npm/rhino3dm@8.35.0/";

let source = "ign";
let project = null;
let sheetFiles = null;
let previewURL = null;
let buildingsReady = false;
let busy = false;
let operationNumber = 0;
let operationController = null;
let searchController = null;
let searchNumber = 0;
let searchTimer = null;
let rhinoPromise = null;
let viewer = null;
let currentStep = 1;
const completedSteps = new Set();
let operationKind = "generate";
let elapsedTimer = null;
let startedAt = 0;

// Progress: messages like "지형 높이 850 / 1681점" give a real percentage and an
// ETA from the measured rate; other stages show the moving (indeterminate) bar.
let measured = null;
let loadingOverlay = null;
const engineStateSink = { textContent: "" };  // engine state is internal; users see the step  // full-screen progress, created at the end of this file
function updateProgress(message) {
  const bar = $("#operation-progress"), fill = bar.querySelector("span");
  const m = /([\d,]+)\s*\/\s*([\d,]+)/.exec(message);
  if (!busy || !m) {
    measured = null;
    bar.classList.remove("determinate");
    fill.style.width = "";
    bar.removeAttribute("aria-valuenow");
    return;
  }
  const done = Number(m[1].replace(/,/g, "")), total = Number(m[2].replace(/,/g, ""));
  if (!(total > 0)) return;
  const now = performance.now();
  if (!measured || measured.total !== total || done < measured.done) {
    measured = { total, done, t0: now, d0: done };
  }
  measured.done = done;
  const pct = Math.min(100, Math.round(done / total * 100));
  bar.classList.add("determinate");
  fill.style.width = pct + "%";
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(pct));
  const rate = (done - measured.d0) / ((now - measured.t0) / 1000);
  const left = rate > 0 ? Math.ceil((total - done) / rate) : null;
  measured.label = `${pct}%` + (left !== null && done < total
    ? _t('terrain.002', { 0: left >= 60 ? Math.floor(left / 60) + _t('terrain.001') : "", 1: left % 60 }) : "");
}

function status(message, error = false) {
  $("#status").textContent = message;
  $("#status").dataset.error = String(error);
  updateProgress(message);
  loadingOverlay?.message(message);
  showLocalError(
    operationKind === "buildings" ? "site-error" :
      operationKind === "export" ? "export-error" : "generation-error",
    error ? message : ""
  );
}

class PythonClient {
  constructor() {
    this.worker = null;
    this.pending = null;
  }

  createWorker() {
    if (this.worker) return;
    const worker = new Worker(new URL("./worker.js?v=20261109zr", import.meta.url));
    this.worker = worker;

    worker.onmessage = event => {
      if (this.worker !== worker) return;
      const message = event.data;
      if (message?.type === "progress") {
        if (this.pending) status(message.message);
        return;
      }
      if (!this.pending) return;
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timeout);

      if (message?.ok === true) {
        engineStateSink.textContent = _t('terrain.003');
        pending.resolve(message.result);
      }
      else pending.reject(new Error(message?.error || _t('terrain.004')));
    };

    worker.onerror = event => {
      event.preventDefault();
      this.reset(new Error(event.message || _t('terrain.005')));
    };
    worker.onmessageerror = () => {
      this.reset(new Error(_t('terrain.006')));
    };
  }

  call(cmd, args = {}, transfer = []) {
    if (this.pending) {
      return Promise.reject(new Error(_t('terrain.007')));
    }
    this.createWorker();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.reset(new Error(_t('terrain.008')));
      }, 300000);
      this.pending = { resolve, reject, timeout };
      try {
        this.worker.postMessage({ cmd, args }, transfer);
      } catch (error) {
        clearTimeout(timeout);
        this.pending = null;
        reject(error);
      }
    });
  }

  reset(error = new DOMException(_t('terrain.009'), "AbortError")) {
    this.worker?.terminate();
    this.worker = null;
    engineStateSink.textContent = _t('terrain.010');
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.reject(error);
      this.pending = null;
    }
  }
}

const python = new PythonClient();
let skippedNote = "";

async function rhinoEngine() {
  if (!rhinoPromise) {
    if (typeof globalThis.rhino3dm !== "function") {
      throw new Error(_t('terrain.011'));
    }
    rhinoPromise = globalThis.rhino3dm({
      locateFile: filename => RHINO_BASE + filename
    }).catch(error => {
      rhinoPromise = null;
      throw error;
    });
  }
  return rhinoPromise;
}

function settings() {
  for (const id of ["scale", "thickness", "interval"]) {
    if (!$("#" + id).reportValidity()) {
      throw new Error(_t('terrain.012'));
    }
  }
  return {
    scale: Number($("#scale").value),
    thickness_mm: Number($("#thickness").value),
    interval_m: Number($("#interval").value),
    paper: $("#paper").value,
    orientation: $("#orientation").value,
    paper_footer: $("#paper-footer").checked,
    ...($("#paper").value === "custom" ? {
      paper_width_mm: Number($("#paper-width").value),
      paper_height_mm: Number($("#paper-height").value)
    } : {}),
    building_mode: $("#building-mode").value,
    building_thickness_mm: Number($("#building-thickness").value),
    floor_height_m: Number($("#floor-height").value)
  };
}

// Building board thickness only matters for laser-cut buildings.
// Show only the fields that apply: board thickness for "laser",
// floor height for the two per-floor modes.
function syncBuildingFields() {
  const mode = $("#building-mode").value;
  const board = mode === "laser", perFloor = mode.endsWith("_floor");
  $("#building-thickness-field").hidden = !board;
  $("#building-thickness").disabled = !board;
  $("#floor-height-field").hidden = !perFloor;
  $("#floor-height").disabled = !perFloor;
}
$("#building-mode").addEventListener("change", () => { syncBuildingFields(); invalidate(); });
syncBuildingFields();

// True-scale link: interval (m) = plate thickness (mm) × scale / 1000.
function linkFrom(source) {
  if (!$("#link-scale").checked) return;
  const scale = Number($("#scale").value), t = Number($("#thickness").value);
  const iv = Number($("#interval").value);
  if (!(scale > 0)) return;
  if (source === "interval" && iv > 0) {
    $("#thickness").value = +(iv * 1000 / scale).toFixed(4);
  } else if (t > 0) {
    $("#interval").value = +(t * scale / 1000).toFixed(4);
  }
  updateSettingsNotes();
}
$("#thickness").addEventListener("input", () => linkFrom("thickness"));
$("#scale").addEventListener("input", () => linkFrom("scale"));
$("#interval").addEventListener("input", () => linkFrom("interval"));
$("#link-scale").addEventListener("change", () => { linkFrom("thickness"); invalidate(); });
queueMicrotask(() => linkFrom("thickness"));  // after module init
$("#building-thickness").addEventListener("change", () => invalidate());
$("#floor-height").addEventListener("change", () => {
  // typed floor counts on buildings without a measured height follow 층고
  for (const b of ignMap.buildings) {
    if (b.manualFloors && b.measuredH == null) b.h = b.manualFloors * floorHeight();
  }
  if (buildingsReady) renderBuildingList();
  invalidate();
});

function paperSize(config) {
  if (config.paper === "custom") {
    return [config.paper_width_mm, config.paper_height_mm];
  }
  const dimensions = PAPER_MM[config.paper];
  if (!dimensions) throw new Error(_t('terrain.013'));
  return config.orientation === "landscape" ? [dimensions[1], dimensions[0]] : dimensions;
}

function checkFit(bounds, config) {
  const factor = 1000 / config.scale;
  const x = (bounds[2] - bounds[0]) * factor;
  const y = (bounds[3] - bounds[1]) * factor;
  const model = _t('terrain.014', { 0: x.toFixed(1), 1: y.toFixed(1) });
  if (config.paper === "site") {
    const footer = config.paper_footer && x >= 50 ? 12 : 0;
    const height = y + footer;
    const fits = x <= 5000 && height <= 5000;
    const format = value => Number(value.toFixed(3)).toLocaleString("ko-KR");
    const detail = footer ? _t('terrain.015')
      : config.paper_footer ? _t('terrain.016') : _t('terrain.017');
    const text = _t('terrain.018', { 0: format(x), 1: format(height), 2: detail });
    return { fits, text: text + (fits ? "" : _t('terrain.019')) };
  }
  // Matches the horizontal margins and the vertical margins + footer in sheets.py.
  const horizontal = 24, vertical = 48;
  const [width, height] = paperSize(config);
  const fits = x <= width - horizontal + 1e-6 && y <= height - vertical + 1e-6;
  const text = _t('terrain.020', { 0: model, 1: width, 2: height });
  return { fits, text: text + (fits ? "" : _t('terrain.021')) };
}

function updateSettingsNotes() {
  const scale = Number($("#scale").value);
  const thickness = Number($("#thickness").value);
  const interval = Number($("#interval").value);
  const physicalHeight = thickness * scale / 1000;
  $("#stack-note").textContent =
    _t('terrain.022', { 0: +physicalHeight.toFixed(2) }) +
    (Math.abs(physicalHeight - interval) > 1e-6
      ? _t('terrain.023')
      : "");

  const bounds = project?.bounds || (source === "ign" ? ignMap.bounds : null);
  const summary = $("#model-summary");
  if (bounds && Number.isFinite(scale) && scale > 0) {
    const width = (bounds[2] - bounds[0]) * 1000 / scale;
    const height = (bounds[3] - bounds[1]) * 1000 / scale;
    const format = value => Number(value.toFixed(1)).toLocaleString("ko-KR");
    summary.textContent =
      _t('terrain.024', { 0: format(width), 1: format(height) }) +
      (project ? _t('terrain.025', { 0: project.layers.length }) : _t('terrain.026'));
  } else {
    summary.textContent =
      _t('terrain.027');
  }

  const note = $("#sheet-fit");
  if (!bounds || !(scale > 0)) {
    note.textContent = $("#paper").value === "site"
      ? _t('terrain.028')
      : _t('terrain.029');
    note.classList.remove("error");
    return;
  }
  const config = {
    scale, paper: $("#paper").value,
    orientation: $("#orientation").value,
    paper_footer: $("#paper-footer").checked,
    paper_width_mm: Number($("#paper-width").value),
    paper_height_mm: Number($("#paper-height").value)
  };
  const fit = checkFit(bounds, config);
  note.textContent = fit.text;
  note.classList.toggle("error", !fit.fits);
}

function clearPreview() {
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = null;
  $("#plate-preview").removeAttribute("src");
  $("#plate-preview").hidden = true;
  $("#plate-empty").hidden = false;
}

function invalidate() {
  project = null;
  sheetFiles = null;
  $("#model-summary").textContent =
    _t('terrain.030');
  clearPreview();
  $("#plate-select").replaceChildren();
  $("#plate-select").disabled = true;
  $("#export").disabled = true;
  $("#reset-view").disabled = true;
  $("#layer-slider").disabled = true;
  $("#layer-slider").max = "0";
  $("#layer-slider").value = "0";
  $("#layer-count").textContent = "0 / 0";
  viewer?.clear();
  for (const step of [2, 3, 4]) completedSteps.delete(step);
  if (currentStep > 2) showStep(2);
  else syncSteps();
}

function cancelSearch() {
  clearTimeout(searchTimer);
  searchController?.abort();
  searchController = null;
  searchNumber++;
}

function setBusy(value) {
  busy = value;
  loadingOverlay?.busy(value);
  $("#input-controls").disabled = value;
  $("#cancel").disabled = !value;
  $("#export").disabled = value || !project;
  ignMap.setEnabled(!value);
  $("#operation-progress").hidden = !value;
  $("#elapsed").hidden = !value;
  clearInterval(elapsedTimer);
  if (value) {
    startedAt = performance.now();
    $("#elapsed").textContent = _t('terrain.031');
    elapsedTimer = setInterval(() => {
      const secs = Math.floor((performance.now() - startedAt) / 1000);
      $("#elapsed").textContent = measured?.label
        ? _t('terrain.032', { 0: measured.label, 1: secs }) : _t('terrain.033', { 0: secs });
    }, 1000);
  }
  syncSteps();
}

async function operation(task, kind = "generate") {
  if (busy) return;
  operationKind = kind;
  showLocalError("generation-error", "");
  cancelSearch();
  const number = ++operationNumber;
  const controller = new AbortController();
  operationController = controller;
  setBusy(true);
  try {
    await task(controller.signal, () => {
      if (number !== operationNumber || controller.signal.aborted) {
        throw new DOMException(_t('terrain.009'), "AbortError");
      }
    });
  } catch (error) {
    if (number === operationNumber) {
      status(
        error.name === "AbortError" ? _t('terrain.009') : error.message,
        error.name !== "AbortError"
      );
    }
  } finally {
    if (number === operationNumber) {
      operationController = null;
      setBusy(false);
    }
  }
}

const ignMap = new IGNMap($("#map"), {
  onRange(bounds) {
    buildingsReady = false;
    completedSteps.delete(1);  // new range: step 1 is not done any more
    $("#building-list").replaceChildren();
    $("#building-note").textContent = _t('terrain.034');
    $("#radius").value = Math.round((bounds[2] - bounds[0]) / 2);
    $("#range-note").textContent =
      _t('terrain.035', { 0: Math.round(bounds[2] - bounds[0]), 1: Math.round(bounds[3] - bounds[1]) });
    invalidate();
    updateSettingsNotes();
  },
  onSelection(selected) {
    $("#building-note").textContent =
      ignMap.buildings.length
        ? _t('terrain.036', { 0: ignMap.buildings.length, 1: selected.length })
        : _t('terrain.037');
    for (const checkbox of $("#building-list").querySelectorAll('input[type="checkbox"]')) {
      checkbox.checked = ignMap.selected.has(Number(checkbox.dataset.index));
    }
    invalidate();
  },
  onNotice(message) {
    $("#map-note").textContent = message;
  }
});

// Shared with the site-diagram mode (diagrams.js): same map, same site.
globalThis.siteLaser = { ignMap, searchPlaces };
globalThis.dispatchEvent(new Event("siteLaser:ready"));

try {
  viewer = new Viewer3D($("#viewer"));
} catch (error) {
  $("#viewer").textContent = _t('terrain.038') + error.message;
  $("#run").disabled = true;
  throw error;
}

function setMapMode(mode) {
  ignMap.setMode(mode);
  document.querySelectorAll("[data-map-mode]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.mapMode === mode));
  });
}

for (const button of document.querySelectorAll("[data-map-mode]")) {
  button.onclick = () => setMapMode(button.dataset.mapMode);
}

function selectSource(next) {
  if (busy) return;
  cancelSearch();
  source = next;
  for (const button of document.querySelectorAll("[data-source]")) {
    const selected = button.dataset.source === source;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  $("#panel-ign").hidden = source !== "ign";
  $("#panel-file").hidden = source !== "file";
  invalidate();
  updateSettingsNotes();
  if (source === "ign") requestAnimationFrame(() => ignMap.resize());
}

for (const button of document.querySelectorAll("[data-source]")) {
  button.onclick = () => selectSource(button.dataset.source);
  button.onkeydown = event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "ign" :
      event.key === "End" ? "file" : source === "ign" ? "file" : "ign";
    selectSource(next);
    $("#tab-" + next).focus();
  };
}

async function performSearch() {
  cancelSearch();
  const query = $("#search").value.trim();
  $("#suggestions").replaceChildren();
  if (query.length < 3) {
    $("#search-note").textContent = _t('terrain.039');
    return;
  }

  const request = searchNumber;
  const controller = new AbortController();
  searchController = controller;
  $("#search-note").textContent = _t('terrain.040');

  try {
    const places = await searchPlaces(query, controller.signal);
    if (request !== searchNumber || busy) return;

    $("#search-note").textContent =
      places.length ? _t('terrain.041') : _t('terrain.042');

    for (const place of places) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = place.label;
      button.onclick = () => {
        if (busy) return;
        cancelSearch();
        $("#search").value = place.label;
        $("#suggestions").replaceChildren();
        $("#search-note").textContent = _t('terrain.043');
        ignMap.setCenter(...place.l93);
        ignMap.fitRange();
      };
      $("#suggestions").append(button);
    }
  } catch (error) {
    if (request === searchNumber && error.name !== "AbortError") {
      $("#search-note").textContent = _t('terrain.044') + error.message;
    }
  }
}

$("#search").addEventListener("input", () => {
  cancelSearch();
  $("#suggestions").replaceChildren();
  searchTimer = setTimeout(performSearch, 450);
});
$("#search").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    performSearch();
  }
});
$("#search-button").onclick = performSearch;

$("#radius").addEventListener("change", () => {
  try {
    if (!$("#radius").reportValidity()) return;
    ignMap.setRadius(Number($("#radius").value));
  } catch (error) { status(error.message, true); }
});

$("#range-view").onclick = () => ignMap.fitRange();

function updateMapStyle() {
  ignMap.setStyle(
    $("#map-style").value,
    Number($("#photo-opacity").value) / 100
  );
}
// The photo ratio only means something when map and photo are overlaid.
$("#map-style").onchange = () => {
  // slider keeps its place (no layout jump); it is just inactive outside 겹쳐보기
  const overlay = $("#map-style").value === "overlay";
  $("#photo-opacity-field").classList.toggle("is-inactive", !overlay);
  $("#photo-opacity").disabled = !overlay;
  updateMapStyle();
};
$("#photo-opacity-field").hidden = false;
$("#photo-opacity-field").classList.add("is-inactive");
$("#photo-opacity").disabled = true;
$("#photo-opacity").oninput = updateMapStyle;

const floorHeight = () => Number($("#floor-height").value) || 3;

// "높이 23.6 m · 8층" — IGN floor count when known, otherwise estimated (약).
// IGN BD TOPO "usage" -> short Korean
const USAGE_KO = {
  get "Résidentiel"() { return _t('terrain.045'); }, get "Commercial et services"() { return _t('terrain.046'); }, get "Indifférencié"() { return _t('terrain.047'); },
  get "Industriel"() { return _t('terrain.048'); }, get "Agricole"() { return _t('terrain.049'); }, get "Religieux"() { return _t('terrain.050'); }, get "Sportif"() { return _t('terrain.051'); },
  get "Annexe"() { return _t('terrain.052'); }, get "Administratif"() { return _t('terrain.053'); }
};

// One line: "건물 1 · 상업 · 20.0 m · 약 7층"
function buildingText(building, index) {
  const usage = USAGE_KO[building.usage] || building.usage || "";
  const name = _t('terrain.054', { 0: index + 1, 1: usage ? " · " + usage : "" });
  if (building.h === null) return _t('terrain.055', { 0: name });
  const floors = building.floors
    ? _t('terrain.056', { 0: building.floors })
    : _t('terrain.057', { 0: Math.max(1, Math.round(building.h / floorHeight())) });
  const manual = building.manualFloors ? _t('terrain.058') : "";
  return `${name} · ${building.h.toFixed(1)} m · ${floors}${manual}`;
}

// Second line, only when the storey count needs checking
function buildingDoubt(building) {
  if (building.manualFloors) return "";
  if (building.h === null) return _t('terrain.059');
  if (!building.floors && building.ignFloors) return _t('terrain.060', { 0: building.ignFloors });
  return "";
}

// A point that is really inside the footprint (for the Google Maps pin):
// area centroid if it lies inside, otherwise the midpoint of the widest
// horizontal chord through the middle of the shape.
function pointInside(building) {
  const ring = building.polygon;
  const inside = (x, y, r) => {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const inShape = (x, y) => inside(x, y, ring) && !(building.holes || []).some(h => inside(x, y, h));
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) > 1e-9) {
    cx /= 3 * a; cy /= 3 * a;
    if (inShape(cx, cy)) return [cx, cy];
  }
  const ys = ring.map(p => p[1]);
  const y = (Math.min(...ys) + Math.max(...ys)) / 2;
  const xs = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    if ((y0 > y) !== (y1 > y)) xs.push(x0 + (y - y0) * (x1 - x0) / (y1 - y0));
  }
  xs.sort((p, q) => p - q);
  let best = null;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (!best || xs[i + 1] - xs[i] > best[1] - best[0]) best = [xs[i], xs[i + 1]];
  }
  return best ? [(best[0] + best[1]) / 2, y] : ring[0];
}

function renderBuildingList() {
  const fragment = document.createDocumentFragment();
  ignMap.buildings.forEach((building, index) => {
    const row = document.createElement("div");
    row.className = "building-row";
    row.dataset.index = String(index);

    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.index = String(index);
    input.checked = ignMap.selected.has(index);
    input.setAttribute("aria-label", _t('terrain.061', { 0: index + 1 }));
    input.onchange = () => ignMap.toggle(index);
    const text = document.createElement("span");
    text.textContent = buildingText(building, index);
    label.append(input, text);

    // Locate: highlight on the map and zoom to it.
    const locate = document.createElement("button");
    locate.type = "button";
    locate.className = "building-locate";
    locate.textContent = _t('terrain.062');
    locate.onclick = () => focusBuilding(index, true);
    row.append(label, locate);
    const extra = document.createElement("div");
    extra.className = "building-extra";

    // Unknown or doubtful height: open the spot in Google Maps (satellite)
    // so the user can count the storeys themselves.
    if (building.h === null || (building.ignFloors && !building.floors)) {
      const [cx, cy] = pointInside(building);
      const [lon, lat] = toWGS84(cx, cy);
      const maps = document.createElement("a");
      maps.className = "building-locate";
      // q = pin on the building, t=k = satellite, z = zoom
      maps.href = `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}&t=k&z=20`;
      maps.target = "_blank";
      maps.rel = "noopener noreferrer";
      maps.textContent = _t('terrain.063');
      extra.append(maps);
    }

    // Missing height: let the user type the floor count; h = floors × 층고.
    if (building.h === null || building.manualFloors || (building.ignFloors && !building.floors)) {
      const wrap = document.createElement("span");
      wrap.className = "building-floors";
      const floorsInput = document.createElement("input");
      floorsInput.type = "number";
      floorsInput.min = "1"; floorsInput.max = "200"; floorsInput.step = "1";
      floorsInput.placeholder = _t('terrain.064');
      floorsInput.value = building.manualFloors || "";
      floorsInput.setAttribute("aria-label", _t('terrain.065', { 0: index + 1 }));
      floorsInput.onchange = () => {
        const n = Math.round(Number(floorsInput.value));
        if (building.measuredH === undefined) building.measuredH = building.h;
        if (n >= 1) {
          building.manualFloors = n;
          building.floors = n;
          // keep IGN's measured height when there is one; else floors × 층고
          building.h = building.measuredH ?? n * floorHeight();
        } else {
          building.manualFloors = null;
          building.floors = null;
          building.h = building.measuredH;
        }
        text.textContent = buildingText(building, index);
        const why = row.querySelector(".building-doubt");
        if (why) why.textContent = buildingDoubt(building) || _t('terrain.066');
        invalidate();
      };
      const unit = document.createElement("span");
      unit.textContent = _t('terrain.067');
      wrap.append(floorsInput, unit);
      extra.prepend(wrap);
    }
    if (extra.childElementCount) {
      const why = document.createElement("span");
      why.className = "building-doubt";
      why.textContent = buildingDoubt(building);
      extra.prepend(why);
      row.append(extra);
    }
    fragment.append(row);
  });
  $("#building-list").replaceChildren(fragment);
  // desktop: open the third column when there is a list to show
  const panel = $("#panel-ign");
  const count = ignMap.buildings.length;
  if (count && count !== panel.dataset.listCount) {
    // stagger the rows in only when a new list arrives, not on every re-render
    panel.classList.add("list-entering");
    clearTimeout(panel._enterTimer);
    panel._enterTimer = setTimeout(() => panel.classList.remove("list-entering"), 1200);
  }
  panel.dataset.listCount = String(count);
  panel.classList.toggle("has-buildings", count > 0);
}

function focusBuilding(index, zoom) {
  ignMap.focus(index, { zoom });
  for (const row of $("#building-list").querySelectorAll(".building-row")) {
    row.classList.toggle("is-focused", row.dataset.index === String(index));
  }
  const row = $("#building-list").querySelector(`.building-row[data-index="${index}"]`);
  row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
// Clicking a building on the map shows its row in the list.
ignMap.onFocus = index => focusBuilding(index, false);

async function loadBuildings(signal) {
  if (!ignMap.bounds) throw new Error(_t('terrain.068'));
  const buildings = await fetchBuildings([...ignMap.bounds], signal, status);
  if (signal.aborted) throw new DOMException(_t('terrain.009'), "AbortError");
  ignMap.setBuildings(buildings);
  buildingsReady = true;
  renderBuildingList();
}

$("#load-buildings").onclick = () => operation(async signal => {
  await loadBuildings(signal);
  setMapMode("building");
  status(ignMap.buildings.length
    ? _t('terrain.069')
    : _t('terrain.070'));
}, "buildings");
$("#select-all").onclick = () => ignMap.selectAll(true);
$("#select-none").onclick = () => ignMap.selectAll(false);

// Custom paper: show width/height fields only when chosen.
const syncPaper = () => {
  const paper = $("#paper").value;
  const custom = paper === "custom";
  const fixed = Object.hasOwn(PAPER_MM, paper);
  $("#paper-custom").hidden = !custom;
  $("#paper-width").disabled = $("#paper-height").disabled = !custom;
  $("#orientation").disabled = !fixed;
  $("#orientation").closest("div").hidden = !fixed;
};
$("#paper").addEventListener("change", syncPaper);
syncPaper();
for (const id of ["scale", "thickness", "interval", "paper", "orientation", "grid-step", "paper-width", "paper-height", "paper-footer"]) {
  $("#" + id).addEventListener("input", () => {
    invalidate();
    updateSettingsNotes();
  });
}
$("#file").onchange = () => {
  invalidate();
  const file = $("#file").files[0];
  $("#file-note").textContent = file
    ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`
    : "";
  updateSettingsNotes();
};

function finitePoint(point, dimensions, name) {
  if (!Array.isArray(point) || point.length < dimensions ||
      !point.slice(0, dimensions).every(Number.isFinite)) {
    throw new Error(_t('terrain.071', { 0: name }));
  }
}

function validateProject(value, expectedSettings) {
  if (!value || typeof value !== "object") throw new Error(_t('terrain.072'));
  if (!Array.isArray(value.bounds) || value.bounds.length !== 4 ||
      !value.bounds.every(Number.isFinite) ||
      value.bounds[2] <= value.bounds[0] || value.bounds[3] <= value.bounds[1]) {
    throw new Error(_t('terrain.073'));
  }
  if (!Array.isArray(value.layers) || !value.layers.length ||
      !Array.isArray(value.buildings)) {
    throw new Error(_t('terrain.074'));
  }
  if (value.layers.length > 2000) {
    throw new Error(_t('terrain.075'));
  }
  for (const key of Object.keys(expectedSettings)) {
    if (value.settings?.[key] !== expectedSettings[key]) {
      throw new Error(_t('terrain.076', { 0: key }));
    }
  }

  const indices = new Set();
  const elevations = new Set();
  function line(points, minimum, name) {
    if (!Array.isArray(points) || points.length < minimum) {
      throw new Error(_t('terrain.077', { 0: name }));
    }
    points.forEach(point => finitePoint(point, 2, name));
  }

  for (const layer of value.layers) {
    if (!Number.isInteger(layer.index) || !Number.isFinite(layer.z) ||
        indices.has(layer.index) || elevations.has(layer.z) ||
        !Array.isArray(layer.cut) || !Array.isArray(layer.engrave)) {
      throw new Error(_t('terrain.078'));
    }
    indices.add(layer.index);
    elevations.add(layer.z);
    layer.cut.forEach(points => line(points, 3, _t('terrain.079')));
    layer.engrave.forEach(points => line(points, 2, _t('terrain.080')));
  }

  for (const building of value.buildings) {
    line(building.polygon, 3, _t('terrain.081'));
    if (!Array.isArray(building.holes) ||
        !(Number.isFinite(building.h) && building.h > 0) ||
        !Number.isFinite(building.base)) {
      throw new Error(_t('terrain.082'));
    }
    building.holes.forEach(points => line(points, 3, _t('terrain.083')));
  }
  return value;
}

function enumNumber(value) {
  return value && typeof value === "object" && "value" in value
    ? value.value : value;
}

function point3(value, factor) {
  const point = Array.isArray(value)
    ? value : [value.x, value.y, value.z];
  finitePoint(point, 3, "3DM");
  return point.slice(0, 3).map(number => number * factor);
}

function polylinePoints(polyline, factor) {
  if (Array.isArray(polyline)) return polyline.map(point => point3(point, factor));
  if (polyline && typeof polyline.get === "function" &&
      Number.isInteger(polyline.count)) {
    const result = [];
    for (let i = 0; i < polyline.count; i++) {
      result.push(point3(polyline.get(i), factor));
    }
    return result;
  }
  return null;
}

async function read3DM(buffer) {
  const rhino = await rhinoEngine();
  const file = rhino.File3dm.fromByteArray(new Uint8Array(buffer));
  if (!file) throw new Error(_t('terrain.084'));

  try {
    const unit = enumNumber(file.settings().modelUnitSystem);
    const units = [
      ["Meters", 1], ["Millimeters", 0.001], ["Centimeters", 0.01],
      ["Kilometers", 1000], ["Inches", 0.0254], ["Feet", 0.3048]
    ];
    const match = units.find(([name]) =>
      enumNumber(rhino.UnitSystem[name]) === unit);
    if (!match) throw new Error(_t('terrain.085'));

    const factor = match[1];
    const geometry = { units: "m", curves: [], meshes: [] };
    const objects = file.objects();
    const unsupported = [];
    // Layer index -> layer NAME (BOUNDARY / CONTOUR / ROAD …). The Python
    // side recognises roles by name; passing the number broke every 3DM.
    const layerNames = new Map();
    const table = file.layers();
    for (let i = 0; i < table.count; i++) {
      const layer = table.get(i);
      try {
        const full = String(layer.fullPath || layer.name || "");
        layerNames.set(i, full.split("::").pop());
      } finally {
        layer.delete?.();
      }
    }

    for (let i = 0; i < objects.count; i++) {
      const object = objects.get(i);
      const item = object.geometry();
      const attributes = object.attributes();
      const layerIndex = layerNames.get(attributes.layerIndex) ?? String(attributes.layerIndex);

      try {
        if (item instanceof rhino.Mesh) {
          const vertices = [];
          const faces = [];
          const sourceVertices = item.vertices();
          const sourceFaces = item.faces();

          for (let j = 0; j < sourceVertices.count; j++) {
            vertices.push(point3(sourceVertices.get(j), factor));
          }
          for (let j = 0; j < sourceFaces.count; j++) {
            const face = Array.from(sourceFaces.get(j));
            if (face.length === 4 && face[2] === face[3]) face.pop();
            if (![3, 4].includes(face.length) ||
                face.some(index => !Number.isInteger(index) ||
                  index < 0 || index >= vertices.length)) {
              throw new Error(_t('terrain.086', { 0: i + 1 }));
            }
            faces.push(face);
          }
          geometry.meshes.push({ vertices, faces, layer: layerIndex });
        } else if (item instanceof rhino.Curve) {
          let points = null;
          let polyline = null;
          try {
            polyline = item.tryGetPolyline();
            points = polylinePoints(polyline, factor);
          } finally {
            polyline?.delete?.();
          }

          if (!points && item instanceof rhino.LineCurve) {
            points = [
              point3(item.pointAtStart, factor),
              point3(item.pointAtEnd, factor)
            ];
          }
          if (!points || points.length < 2) {
            unsupported.push(i + 1);
            continue;
          }

          geometry.curves.push({
            points,
            closed: Boolean(item.isClosed),
            layer: layerIndex
          });
        } else {
          unsupported.push(i + 1);
        }
      } finally {
        attributes.delete?.();
        item.delete?.();
        object.delete?.();
      }
    }

    if (unsupported.length) {
      throw new Error(
        _t('terrain.087') +
        unsupported.slice(0, 20).join(", ") +
        (unsupported.length > 20 ? _t('terrain.088', { 0: unsupported.length - 20 }) : "") +
        _t('terrain.089')
      );
    }
    if (!geometry.curves.length && !geometry.meshes.length) {
      throw new Error(_t('terrain.090'));
    }
    return geometry;
  } finally {
    file.delete();
  }
}

function validateSheets(files) {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error(_t('terrain.091'));
  }
  const names = Object.keys(files);
  if (!names.length) throw new Error(_t('terrain.092'));

  for (const name of names) {
    if (!/^(plate|building|support)_\d+\.(svg|dxf)$/.test(name) || typeof files[name] !== "string") {
      throw new Error(_t('terrain.093', { 0: name }));
    }
  }
  const svgNames = names.filter(name => name.endsWith(".svg"));
  if (svgNames.filter(n => n.startsWith("plate_")).length !== project.layers.length) {
    throw new Error(_t('terrain.094'));
  }
  for (const name of svgNames) {
    if (!(name.replace(/\.svg$/, ".dxf") in files)) {
      throw new Error(_t('terrain.095', { 0: name }));
    }
  }
  if (names.filter(name => name.endsWith(".dxf")).length !== svgNames.length) {
    throw new Error(_t('terrain.096'));
  }
  const order = ["plate", "building", "support"];
  const type = name => order.indexOf(name.split("_")[0]);
  const number = name => Number(name.match(/\d+/)[0]);
  return svgNames.sort((a, b) => type(a) - type(b) || number(a) - number(b));
}

function showPlate() {
  clearPreview();
  const name = $("#plate-select").value;
  if (!sheetFiles || !name) return;
  // SVG is an image resource, never injected as active inline markup.
  previewURL = URL.createObjectURL(new Blob(
    [sheetFiles[name]], { type: "image/svg+xml;charset=utf-8" }
  ));
  $("#plate-preview").src = previewURL;
  $("#plate-preview").hidden = false;
  $("#plate-empty").hidden = true;
}

$("#plate-preview").onerror = () => {
  $("#plate-preview").hidden = true;
  $("#plate-empty").hidden = false;
  $("#plate-empty").textContent = _t('terrain.097');
};
$("#plate-select").onchange = showPlate;

function updateViewerOptions() {
  const count = Number($("#layer-slider").value);
  $("#layer-count").textContent = `${count} / ${project?.layers.length || 0}`;
  viewer.setOptions({
    plates: $("#show-plates").checked,
    buildings: $("#show-buildings").checked,
    edges: $("#show-edges").checked,
    count
  });
}
for (const id of ["show-plates", "show-buildings", "show-edges", "layer-slider"]) {
  $("#" + id).oninput = updateViewerOptions;
}
$("#reset-view").onclick = () => viewer.fit();

$("#run").onclick = () => operation(async (signal, ensureCurrent) => {
  invalidate();
  const config = settings();
  let result;

  try {
    if (source === "ign") {
      if (!ignMap.bounds) throw new Error(_t('terrain.098'));
      if (!buildingsReady) {
        throw new Error(_t('terrain.099'));
      }
      if (!$("#grid-step").reportValidity()) {
        throw new Error(_t('terrain.100'));
      }

      const fit = checkFit(ignMap.bounds, config);
      if (!fit.fits) throw new Error(fit.text);

      status(_t('terrain.101'));
      const terrain = await fetchTerrain(
        [...ignMap.bounds],
        Number($("#grid-step").value),
        ignMap.getSelected(),
        signal,
        status
      );
      ensureCurrent();
      skippedNote = terrain.skippedNoHeight
        ? _t('terrain.102', { 0: terrain.skippedNoHeight })
        : "";
      result = await python.call("from_terrain", {
        dem: terrain.dem, buildings: terrain.buildings, settings: config
      });
    } else {
      skippedNote = "";
      const file = $("#file").files[0];
      if (!file) throw new Error(_t('terrain.103'));
      if (file.size === 0 || file.size > 100 * 1024 * 1024) {
        throw new Error(_t('terrain.104'));
      }

      const extension = file.name.split(".").pop().toLowerCase();
      if (!["dxf", "3dm"].includes(extension)) {
        throw new Error(_t('terrain.103'));
      }

      status(_t('terrain.105'));
      const buffer = await file.arrayBuffer();
      ensureCurrent();

      if (extension === "dxf") {
        result = await python.call(
          "from_dxf",
          { data: buffer, settings: config },
          [buffer]
        );
      } else {
        const geom_json = await read3DM(buffer);
        ensureCurrent();
        result = await python.call("from_geometry", { geom_json, settings: config });
      }
    }

    ensureCurrent();
    project = validateProject(result, config);
    const fit = checkFit(project.bounds, config);
    if (!fit.fits) throw new Error(fit.text);

    status(_t('terrain.106'));
    sheetFiles = await python.call("sheets");
    ensureCurrent();
    const supportSolids = await python.call("sheet_supports");
    ensureCurrent();
    const names = validateSheets(sheetFiles);
    const layers = [...project.layers].sort((a, b) => a.z - b.z);

    $("#plate-select").replaceChildren(...names.map(name => {
      const option = document.createElement("option");
      option.value = name;
      const number = Number(name.match(/\d+/)[0]);
      if (name.startsWith("support_")) option.textContent = _t('terrain.107', { 0: number });
      else if (name.startsWith("building_")) option.textContent = _t('terrain.108', { 0: number });
      else option.textContent = _t('terrain.109', { 0: number, 1: layers[number - 1].z.toFixed(1) });
      return option;
    }));
    $("#plate-select").disabled = false;

    viewer.setProject(project, supportSolids);
    $("#layer-slider").max = String(project.layers.length);
    $("#layer-slider").value = String(project.layers.length);
    $("#layer-slider").disabled = false;
    $("#reset-view").disabled = false;

    $("#plate-empty").textContent = _t('terrain.110');
    updateViewerOptions();
    showPlate();
    updateSettingsNotes();
    const supports = names.filter(name => name.startsWith("support_")).length;
    const supportNote = supports ? _t('terrain.111', { 0: supports }) : "";
    status(_t('terrain.112', { 0: project.layers.length, 1: project.buildings.length, 2: supportNote, 3: skippedNote }));
    completedSteps.add(1);
    completedSteps.add(2);
    showStep(3, true);
  } catch (error) {
    // Do not clear a newer operation's result after cancellation.
    if (!signal.aborted) invalidate();
    throw error;
  }
});

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

$("#export").onclick = () => operation(async (_signal, ensureCurrent) => {
  if (!project || !sheetFiles) throw new Error(_t('terrain.113'));
  const formats = new Set([...document.querySelectorAll('[name="sheet-format"]:checked')].map(input => input.value));
  // Re-render the sheets with the chosen cut/engrave colours and line width.
  status(_t('terrain.114'));
  // send the project too: a restarted worker no longer holds it
  sheetFiles = await python.call("sheets", { project, style: {
    cut_color: $("#cut-color").value,
    engrave_color: $("#engrave-color").value,
    line_width_mm: Number($("#line-width").value)
  } });
  ensureCurrent();
  const drawings = await python.call("sheet_drawings");
  ensureCurrent();
  const supports = drawings.filter(drawing => drawing.name.startsWith("support_"));
  status(_t('terrain.115'));
  const rhino = await rhinoEngine();
  ensureCurrent();

  // Let the pending status update reach the screen before synchronous exports.
  // setTimeout, not requestAnimationFrame: rAF never fires in a background tab.
  await new Promise(resolve => setTimeout(resolve, 30));
  ensureCurrent();

  const files = {};
  for (const drawing of drawings) {
    for (const format of ["svg", "dxf"]) {
      if (formats.has(format)) {
        files[`${drawingName(drawing)}.${format}`] = strToU8(sheetFiles[`${drawing.name}.${format}`]);
      }
    }
  }
  if (formats.has("pdf")) await addSheetPdfs(files, drawings);
  if (formats.has("3dm")) {
    const response = await fetch(new URL("./rhino-text.3dm?v=20261109zr", import.meta.url));
    if (!response.ok) throw new Error(_t('terrain.116'));
    const template = new Uint8Array(await response.arrayBuffer());
    files["sheets_2d.3dm"] = sheets2D3dm(rhino, drawings.filter(drawing => !supports.includes(drawing)), template);
    if (supports.length) files["supports_2d.3dm"] = sheets2D3dm(rhino, supports, template);
  }
  ensureCurrent();

  const mode = project.settings.building_mode || "print";
  if (mode === "print_floor") {
    Object.assign(files, viewer.exportBuildingsSTLByFloor(project.settings.floor_height_m || 3));
  } else {
    const stl = viewer.exportBuildingsSTL();
    if (stl) files["buildings.stl"] = stl;
  }
  files["model.3dm"] = viewer.export3DM(rhino);
  files["project.json"] = strToU8(JSON.stringify(project, null, 2));
  files["model-coordinates.json"] = strToU8(
    JSON.stringify(viewer.exportMetadata(), null, 2)
  );
  files["README.txt"] = strToU8([
    "Terrain",
    "",
    _t('terrain.117'),
    _t('terrain.118'),
    _t('terrain.119'),
    drawings.some(drawing => drawing.support_count)
      ? _t('terrain.120')
      : _t('terrain.121'),
    _t('terrain.122'),
    _t('terrain.123'),
    _t('terrain.124'),
    _t('terrain.125'),
    _t('terrain.126'),
    _t('terrain.127'),
    "",
    _t('terrain.128'),
    _t('terrain.129'),
    _t('terrain.130'),
    _t('terrain.131'),
    ...drawings.flatMap(drawing => drawing.placement_checks.map(note => `${drawingName(drawing)} · ${note}`)),
    _t('terrain.132'),
    _t('terrain.133'),
    "",
    source === "ign"
      ? _t('terrain.134')
      : _t('terrain.135'),
    _t('terrain.136'),
    _t('terrain.137'),
    _t('terrain.138'),
    _t('terrain.139'),
    "",
    _t('terrain.140')
  ].join("\n"));

  const archive = zipSync(files, { level: 6 });
  ensureCurrent();
  download(archive, "terrain.zip");
  status(_t('terrain.141'));
  completedSteps.add(4);
  syncSteps();
  // finished: show what to do with the files
  $("#done-cut-swatch").style.background = $("#cut-color").value;
  $("#done-engrave-swatch").style.background = $("#engrave-color").value;
  showStep(5, true);
}, "export");

$("#cancel").onclick = () => {
  operationNumber++;
  operationController?.abort();
  operationController = null;
  python.reset();
  // cancelling an export keeps the finished model
  if (operationKind !== "export") invalidate();
  setBusy(false);
  status(_t('terrain.142'));
};

window.addEventListener("beforeunload", () => {
  clearInterval(elapsedTimer);
  operationController?.abort();
  searchController?.abort();
  python.reset();
  if (previewURL) URL.revokeObjectURL(previewURL);
  viewer.dispose();
});

updateSettingsNotes();
status(_t('terrain.143'));
setupInterface();

function showLocalError(id, message) {
  for (const name of ["site-error", "generation-error", "export-error"]) {
    const note = $("#" + name);
    note.textContent = name === id ? message : "";
    note.hidden = !note.textContent;
  }
}

function syncSteps() {
  $("#step-count").textContent = _t('terrain.144', { 0: Math.min(currentStep, 4) });
  $("#settings-controls").disabled = busy || !completedSteps.has(1);
  $("#settings-help").textContent = completedSteps.has(1)
    ? _t('terrain.145')
    : _t('terrain.146');
  $("#review-controls").disabled = busy || !project || !sheetFiles;
  $("#export").disabled =
    busy || !project || !sheetFiles || !completedSteps.has(3);

  for (const button of document.querySelectorAll("[data-step]")) {
    const step = Number(button.dataset.step);
    const current = step === currentStep;
    const done = completedSteps.has(step);
    button.dataset.done = String(done && !current);
    if (current) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
    button.querySelector(".step-state").textContent =
      current ? _t('terrain.147') : done ? _t('terrain.148') : _t('terrain.149');
    button.disabled = busy ||
      (step === 2 && !completedSteps.has(1)) ||
      (step === 3 && (!project || !sheetFiles)) ||
      (step === 4 && (!project || !sheetFiles || !completedSteps.has(3)));
  }
}

// One screen at a time: page 0 = intro, 1-4 = steps (no long scroll).
function showPage(page) {
  document.body.dataset.page = String(page);
  if (page === 0) $("#step-button-1")?.removeAttribute("aria-current");
  window.scrollTo({ top: 0, behavior: "auto" });
}

const stepNames = () => ["", _t('terrain.150'), _t('terrain.151'), _t('terrain.152'), _t('terrain.153'), _t('terrain.148')];
function showStep(step, focus = false) {
  currentStep = step;
  showPage(step);
  $("#engine-state").textContent = step > 4 ? _t('terrain.148') : _t('terrain.154', { 0: step, 1: stepNames()[step] });
  syncSteps();
  // The scroll-reveal fade never fires for a panel that was display:none.
  $("#step-panel-" + step).classList.remove("reveal-pending");
  if (step === 1 && source === "ign") {
    // map container just became visible: let Leaflet re-measure it
    setTimeout(() => ignMap.resize(), 50);
  }
  if (step === 3) setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
  if (focus) {
    $("#step-title-" + step).focus({ preventScroll: true });
  }
}

function continueFromSite() {
  if (busy) return;
  let message = "";
  if (source === "ign") {
    if (!ignMap.bounds) message = _t('terrain.068');
    else if (!buildingsReady) {
      message = _t('terrain.099');
    } else if (!$("#grid-step").reportValidity()) return;
  } else {
    const file = $("#file").files[0];
    if (!file || !/\.(dxf|3dm)$/i.test(file.name)) {
      message = _t('terrain.103');
    } else if (file.size === 0 || file.size > 100 * 1024 * 1024) {
      message = _t('terrain.104');
    }
  }
  showLocalError("site-error", message);
  if (message) return;
  completedSteps.add(1);
  showStep(2, true);
}

function selectView(next, focus = false) {
  for (const button of document.querySelectorAll("[data-view]")) {
    const selected = button.dataset.view === next;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    const panel = $("#view-panel-" + button.dataset.view);
    panel.setAttribute("aria-hidden", String(!selected));
    panel.inert = !selected;
  }
  if (focus) $("#view-tab-" + next).focus();
}

function setupInterface() {
  for (const button of document.querySelectorAll("[data-step]")) {
    button.onclick = () => {
      if (busy || button.disabled) return;
      const step = Number(button.dataset.step);
      if (step === 2 && currentStep === 1) continueFromSite();
      else showStep(step, true);
    };
  }
  for (const button of document.querySelectorAll("[data-go-step]")) {
    button.onclick = () => {
      if (!busy) showStep(Number(button.dataset.goStep), true);
    };
  }
  $("#site-next").onclick = continueFromSite;
  $("#new-site").onclick = () => { if (!busy) location.reload(); };
  $("#review-next").onclick = () => {
    if (busy || !project || !sheetFiles) return;
    completedSteps.add(3);
    showStep(4, true);
  };
  $("#inspect-viewer").onclick = () => {
    $('.viewer-tabs [aria-selected="true"]').focus();
  };
  for (const button of document.querySelectorAll("[data-view]")) {
    button.onclick = () => selectView(button.dataset.view);
    button.onkeydown = event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "3d" :
        event.key === "End" ? "2d" : button.dataset.view === "3d" ? "2d" : "3d";
      selectView(next, true);
    };
  }
  // Invalidate only step completion; the existing listeners own project data.
  for (const id of ["file", "radius", "grid-step"]) {
    $("#" + id).addEventListener("input", () => {
      completedSteps.delete(1);
      showLocalError("site-error", "");
      syncSteps();
    });
  }
  for (const button of document.querySelectorAll("[data-source]")) {
    button.addEventListener("click", () => {
      if (!busy) {
        completedSteps.delete(1);
        showLocalError("site-error", "");
        syncSteps();
      }
    });
  }
  if ("IntersectionObserver" in window &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.remove("reveal-pending");
        observer.unobserve(entry.target);
      }
    }, { threshold: 0, rootMargin: "0px 0px -24px 0px" });

    for (const panel of document.querySelectorAll(".step-panel")) {
      observer.observe(panel);
      panel.classList.add("reveal-pending");
    }
    document.addEventListener("focusin", event => {
      const panel = event.target.closest(".step-panel");
      if (panel) {
        panel.classList.remove("reveal-pending");
        observer.unobserve(panel);
      }
    });
  }

  syncSteps();
  selectView("2d");  // 2D cut sheets first: that is what gets made
  // No worker init command is exposed by the supplied PythonClient.
  // Start the worker early without sending an undocumented command.
  try {
    python.createWorker();
    engineStateSink.textContent = _t('terrain.155');
  } catch (error) {
    engineStateSink.textContent =
      _t('terrain.156') + error.message;
  }
}

// 2D plate preview: wheel/pinch zoom around the cursor, drag to pan,
// +/−/맞춤 buttons. Purely visual; the exported SVG is unchanged.
(() => {
  const stage = document.querySelector(".plate-stage");
  const img = $("#plate-preview");
  if (!stage || !img) return;
  let s = 1, x = 0, y = 0, drag = null;
  const pointers = new Map();
  let pinch = null;
  const apply = () => {
    // Resize instead of CSS scale() so the SVG is re-rasterised crisply.
    // Fit = the whole drawing inside the stage, whichever side is the tighter one.
    const ratio = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 0;
    const fitW = ratio ? Math.min(stage.clientWidth - 24, (stage.clientHeight - 24) * ratio) : stage.clientWidth - 24;
    img.style.width = `${s * fitW}px`;
    img.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
    if (zoomLabel) zoomLabel.textContent = `${Math.round(s * 100)}%`;
  };
  const zoomAt = (factor, cx, cy) => {
    const next = Math.min(40, Math.max(1, s * factor));
    const r = stage.getBoundingClientRect();
    const px = cx - r.left - r.width / 2, py = cy - r.top - r.height / 2;
    x = px - (px - x) * (next / s);
    y = py - (py - y) * (next / s);
    s = next;
    if (s === 1) { x = 0; y = 0; }
    apply();
  };
  const reset = () => { s = 1; x = 0; y = 0; apply(); };

  const bar = document.createElement("div");
  bar.className = "zoom-bar";
  bar.innerHTML =
    '<button type="button" data-z="out" aria-label="' + _t("terrain.157") + '" data-i18n-attr="aria-label:terrain.157">−</button>' +
    '<span class="zoom-label" aria-live="polite">100%</span>' +
    '<button type="button" data-z="in" aria-label="' + _t("terrain.158") + '" data-i18n-attr="aria-label:terrain.158">+</button>' +
    '<button type="button" data-z="fit" data-i18n="terrain.159">' + _t("terrain.159") + '</button>';
  stage.after(bar);
  // the plate picker lives next to the zoom controls, below the drawing
  const picker = $("#plate-select");
  picker.setAttribute("aria-label", _t('terrain.160'));
  bar.prepend(picker);
  const zoomLabel = bar.querySelector(".zoom-label");
  bar.addEventListener("click", e => {
    const z = e.target.closest("button")?.dataset.z;
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (z === "in") zoomAt(1.5, cx, cy);
    if (z === "out") zoomAt(1 / 1.5, cx, cy);
    if (z === "fit") reset();
  });

  stage.addEventListener("wheel", e => {
    if (img.hidden) return;
    e.preventDefault();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  }, { passive: false });

  stage.addEventListener("pointerdown", e => {
    if (img.hidden) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    stage.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
      drag = null;
    } else {
      drag = { sx: e.clientX - x, sy: e.clientY - y };
    }
  });
  stage.addEventListener("pointermove", e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt(d / pinch.d, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      pinch.d = d;
    } else if (drag && s > 1) {
      x = e.clientX - drag.sx; y = e.clientY - drag.sy; apply();
    }
  });
  const end = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) drag = null;
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("dblclick", reset);
  // New plate selected or regenerated → back to fit.
  img.addEventListener("load", reset);
  window.addEventListener("resize", () => { if (!img.hidden) apply(); });
})();


// Intro screen first; "시작하기" opens step 1.
showPage(0);
$("#start").addEventListener("click", () => showStep(1, true));
$("#brand-home")?.addEventListener("click", event => { if (event.target.closest(".brand-mark")) return; event.preventDefault(); showPage(0); });


// ---------------------------------------------------------------------
// Full-screen loading: one big overall percentage and a plain-language
// stage name instead of engine messages. Each stage owns a slice of
// 0-100 %; measured messages ("850 / 1681") fill their slice exactly,
// the others creep toward the end of their slice so it never looks frozen.
loadingOverlay = (() => {
  const el = document.createElement("div");
  el.className = "loading-overlay";
  el.hidden = true;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", _t('terrain.161'));
  el.innerHTML =
    '<div class="loading-box">' +
    '<p class="loading-percent" aria-live="polite">0%</p>' +
    '<div class="loading-track"><span></span></div>' +
    '<p class="loading-stage" data-i18n="terrain.162">' + _t("terrain.162") + '</p>' +
    '<p class="loading-eta"></p>' +
    '<button type="button" class="loading-cancel" data-i18n="terrain.163">' + _t("terrain.163") + '</button>' +
    '</div>';
  document.body.append(el);
  const pctEl = el.querySelector(".loading-percent");
  const fill = el.querySelector(".loading-track span");
  const stageEl = el.querySelector(".loading-stage");
  const etaEl = el.querySelector(".loading-eta");
  el.querySelector(".loading-cancel").onclick = () => $("#cancel").click();

  // [test, label, from %, to %] per operation kind
  const STAGES = {
    generate: [
      [/표고|DEM|높이를? 조회|지형 높이|지형 데이터/, _t('terrain.164'), 3, 65],
      [/Python|numpy|DXF 라이브러리|모듈|엔진|실행 환경/, _t('terrain.165'), 65, 78],
      [/파일을? 읽|해석|불러온 파일/, _t('terrain.105'), 65, 80],
      [/SVG|DXF를|도면/, _t('terrain.166'), 90, 99],
      [/지형판|계산|생성/, _t('terrain.167'), 78, 90]
    ],
    buildings: [[/./, _t('terrain.168'), 5, 95]],
    export: [
      [/선 색상|굵기/, _t('terrain.169'), 5, 45],
      [/3DM|ZIP|압축/, _t('terrain.170'), 45, 98]
    ]
  };
  let shown = 0, target = 0, cap = 0, timer = null, active = false;
  const render = () => {
    pctEl.textContent = Math.floor(shown) + "%";
    fill.style.width = shown + "%";
  };
  const tick = () => {
    // ease toward the measured target, and creep toward the stage cap
    if (target > shown) shown += Math.max(0.4, (target - shown) * 0.25);
    else if (shown < cap - 0.5) shown += (cap - shown) * 0.02;
    shown = Math.min(shown, 99);
    render();
  };
  return {
    busy(value) {
      active = value;
      clearInterval(timer);
      if (value) {
        shown = 0; target = 0; cap = 8; etaEl.textContent = "";
        stageEl.textContent = _t('terrain.162');
        render();
        el.hidden = false;
        document.body.classList.add("is-loading");
        for (const node of document.querySelectorAll("body > header, body > main")) node.inert = true;
        el.querySelector(".loading-cancel").focus();
        timer = setInterval(tick, 200);
      } else {
        shown = 100; render();
        setTimeout(() => {
          if (active) return;
          el.hidden = true;
          document.body.classList.remove("is-loading");
          for (const node of document.querySelectorAll("body > header, body > main")) node.inert = false;
        }, 250);
      }
    },
    message(message) {
      if (!active) return;
      const list = STAGES[operationKind] || STAGES.generate;
      const stage = list.find(([test]) => test.test(message));
      if (!stage) return;
      const [, label, from, to] = stage;
      stageEl.textContent = label;
      const m = /([\d,]+)\s*\/\s*([\d,]+)/.exec(message);
      if (m) {
        const done = Number(m[1].replace(/,/g, "")), total = Number(m[2].replace(/,/g, ""));
        if (total > 0) target = Math.max(target, from + (to - from) * Math.min(1, done / total));
        etaEl.textContent = measured?.label?.split(" · ").slice(1).join(" · ") || "";
      } else {
        target = Math.max(target, from);
        etaEl.textContent = "";
      }
      cap = Math.max(cap, to);
    }
  };
})();


// One Rhino file with every 2D drawing laid out side by side (mm):
function boardThickness(drawing) {
  return Number(drawing.thickness_mm.toPrecision(6));
}

function drawingName(drawing) {
  return `${drawing.name.replace(/^plate_/, "terrain_")}_${boardThickness(drawing)}mm`;
}

async function addSheetPdfs(files, drawings) {
  const { jsPDF } = await import("https://cdn.jsdelivr.net/npm/jspdf@4.2.0/+esm");
  for (const [prefix, kind] of [["plate_", "terrain"], ["building_", "building"], ["support_", "support"]]) {
    const sheets = drawings.filter(drawing => drawing.name.startsWith(prefix));
    if (!sheets.length) continue;
    const pageSettings = ({ width, height }) => ({
      format: [width, height],
      orientation: width > height ? "landscape" : "portrait"
    });
    const pdf = new jsPDF({
      unit: "mm",
      compress: true,
      putOnlyUsedFonts: true,
      ...pageSettings(sheets[0])
    });
    pdf.setFont("helvetica");
    for (const [index, drawing] of sheets.entries()) {
      if (index) {
        const { format, orientation } = pageSettings(drawing);
        pdf.addPage(format, orientation);
      }
      const { cut, engrave, height, style, texts, cap_height_ratio } = drawing;
      pdf.setLineWidth(style.line_width_mm);
      for (const [paths, color] of [[cut, style.cut_color], [engrave, style.engrave_color]]) {
        pdf.setDrawColor(color);
        for (const points of paths) {
          const [x, y] = points[0];
          const segments = points.slice(1).map(([px, py], i) => [px - points[i][0], points[i][1] - py]);
          pdf.lines(segments, x, height - y);
        }
      }
      for (const [x, y, text, size, align, layer] of texts) {
        pdf.setFontSize(size * 72 / (25.4 * cap_height_ratio));
        pdf.setTextColor(layer === "ENGRAVE" ? style.engrave_color : "#25333b");
        pdf.text(text, x, height - y, { align });
      }
    }
    files[`${kind}_${boardThickness(sheets[0])}mm.pdf`] = new Uint8Array(pdf.output("arraybuffer"));
  }
}

// The Rhino template supplies native Text entities for each alignment.
function sheets2D3dm(rhino, drawings, template) {
  const file = rhino.File3dm.fromByteArray(template);
  if (!file) throw new Error(_t('terrain.171'));
  const textTemplates = {};
  const hex = h => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16), a: 255 });
  const addLayer = (name, color, parentId) => {
    const layer = new rhino.Layer();
    layer.name = name;
    layer.color = color;
    if (parentId) layer.parentLayerId = parentId;
    const index = file.layers().add(layer);
    const added = file.layers().get(index);
    const id = added.id;
    added.delete?.();
    layer.delete?.();
    return { index, id };
  };
  const polyline = (points, dx, dy) => {
    const pl = new rhino.Polyline(points.length);
    try {
      for (const [x, y] of points) pl.add(x + dx, y + dy, 0);
      return pl.toPolylineCurve();
    } finally {
      pl.delete?.();
    }
  };
  const GAP = 50, PER_ROW = 4;
  let x = 0, y = 0, rowHeight = 0;
  try {
    const objects = file.objects();
    const templateIds = [];
    for (let i = 0; i < objects.count; i++) {
      const item = objects.get(i);
      const attributes = item.attributes();
      const geometry = item.geometry();
      const text = geometry.duplicate();
      textTemplates[attributes.name] = { text, style: file.dimstyles().findId(text.dimensionStyleId) };
      templateIds.push(attributes.id);
      geometry.delete();
      attributes.delete();
      item.delete();
    }
    for (const id of templateIds) objects.delete(id);
    if (objects.count !== 0 || !textTemplates.left || !textTemplates.center || !textTemplates.right) {
      throw new Error(_t('terrain.172'));
    }
    for (const [i, drawing] of drawings.entries()) {
      if (i && i % PER_ROW === 0) {
        x = 0;
        y -= rowHeight + GAP;
        rowHeight = 0;
      }
      const { cut, engrave, width, height, style, texts } = drawing;
      const parent = addLayer(drawingName(drawing), { r: 0, g: 0, b: 0, a: 255 });
      const layers = {
        CUT: addLayer("CUT", hex(style.cut_color), parent.id),
        ENGRAVE: addLayer("ENGRAVE", hex(style.engrave_color), parent.id),
        BORDER: addLayer("BORDER", { r: 160, g: 160, b: 160, a: 255 }, parent.id),
        LABELS_NO_CUT: addLayer("LABELS_NO_CUT", hex("#25333b"), parent.id)
      };
      const add = (geometry, layer) => {
        const attributes = new rhino.ObjectAttributes();
        try {
          attributes.layerIndex = layer.index;
          file.objects().add(geometry, attributes);
        } finally {
          attributes.delete();
          geometry.delete();
        }
      };
      for (const path of cut) add(polyline(path, x, y), layers.CUT);
      for (const path of engrave) add(polyline(path, x, y), layers.ENGRAVE);
      const border = [[0, 0], [width, 0], [width, height], [0, height], [0, 0]];
      add(polyline(border, x, y), layers.BORDER);
      for (const [tx, ty, value, size, align, layer] of texts) {
        const source = textTemplates[align];
        const text = source.text.duplicate();
        text.setRichText(rhino.AnnotationBase.plainTextToRtf(value), source.style);
        text.setTextHeight(source.style, size);
        text.translate([x + tx, y + ty, 0]);
        add(text, layers[layer]);
      }
      x += width + GAP;
      rowHeight = Math.max(rowHeight, height);
    }
    return file.toByteArray();
  } finally {
    for (const { text, style } of Object.values(textTemplates)) {
      text.delete();
      style.delete();
    }
    file.delete?.();  // free the WASM document after writing
  }
}

// Desktop layout: keep the map on the left and put every other IGN control
// in one side column that scrolls on its own (ids unchanged).
(() => {
  const panel = $("#panel-ign"), map = $("#map");
  if (!panel || !map) return;
  const side = document.createElement("div");
  side.className = "ign-side";
  for (const child of [...panel.children]) if (child !== map) side.append(child);
  panel.append(side);
  // 건물 불러오기 right after 반경/정밀도, as the main action of this column
  const load = $("#load-buildings");
  const fields = side.querySelector(".grid.two");
  if (load && fields) {
    load.classList.add("primary", "load-primary");
    fields.after(load);
  }
  // Third column: header (대지 크기 · 건물 수 · 모두 선택/해제) + list
  const list = document.createElement("div");
  list.className = "ign-list";
  const head = document.createElement("div");
  head.className = "list-head";
  const headText = document.createElement("div");
  headText.className = "list-head-text";
  for (const id of ["range-note", "building-note"]) { const el = $("#" + id); if (el) headText.append(el); }
  const headActions = document.createElement("div");
  headActions.className = "list-head-actions";
  for (const id of ["select-all", "select-none"]) { const el = $("#" + id); if (el) headActions.append(el); }
  head.append(headText, headActions);
  list.append(head);
  const listEl = $("#building-list");
  if (listEl) list.append(listEl);
  panel.append(list);
  side.querySelector(".building-tools")?.remove();
  // Keep map navigation separate from clicks and drawing on the map.
  const rangeView = $("#range-view");
  if (rangeView) {
    rangeView.classList.add("map-corner-btn", "leaflet-control");
    L.DomEvent.disableClickPropagation(rangeView);
    map.append(rangeView);
  }
  // the long "지도를 눌러…" hint is shown only for notices
  const mapNote = $("#map-note");
  if (mapNote) mapNote.textContent = "";
})();

// One navigation row per step, same place on every screen:
// "‹ 이전 · …" (text) on the left, the main "다음 / 만들기 / 받기" pill on the right.
(() => {
  const NEXT = { 1: "#site-next", 2: "#run", 3: "#review-next", 4: "#export" };
  for (const step of [1, 2, 3, 4]) {
    const panel = $("#step-panel-" + step);
    const next = $(NEXT[step]);
    if (!panel || !next) continue;
    const back = panel.querySelector(`button[data-go-step="${step - 1}"]`);
    const nav = document.createElement("div");
    nav.className = "step-nav";
    if (back) { back.classList.add("back"); nav.append(back); }
    next.classList.add("next");
    next.classList.remove("full-width", "secondary-action");
    nav.append(next);
    panel.append(nav);
    // drop the now-empty old action rows
    for (const row of panel.querySelectorAll(".section-actions")) {
      if (!row.querySelector("button")) row.remove();
    }
  }
})();


// Step 4: show the chosen colours/width as hex codes and in a small preview.
(() => {
  const sync = () => {
    const cut = $("#cut-color").value, eng = $("#engrave-color").value;
    const w = Math.max(0.5, Math.min(6, Number($("#line-width").value) * 10 || 1));
    $("#cut-color-value").textContent = cut;
    $("#engrave-color-value").textContent = eng;
    $("#preview-cut").setAttribute("stroke", cut);
    $("#preview-engrave").setAttribute("stroke", eng);
    for (const id of ["#preview-cut", "#preview-engrave"]) $(id).setAttribute("stroke-width", w);
  };
  for (const id of ["#cut-color", "#engrave-color", "#line-width"]) $(id).addEventListener("input", sync);
  sync();
})();


// Skip link: from the intro it opens step 1 instead of jumping to a hidden panel.
document.querySelector(".skip-link")?.addEventListener("click", event => {
  if (document.body.dataset.page === "0") { event.preventDefault(); showStep(1, true); }
});

// Short choices (≤ 3 options) as segmented controls instead of OS dropdowns.
// The <select> stays (hidden) as the source of truth, so all logic is unchanged.
for (const id of ["map-style", "orientation"]) {
  const select = $("#" + id);
  if (!select) continue;
  const group = document.createElement("div");
  group.className = "segmented";
  group.setAttribute("role", "radiogroup");
  const label = document.querySelector(`label[for="${id}"]`);
  if (label) group.setAttribute("aria-label", label.textContent.trim());
  const buttons = [...select.options].map(option => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.textContent = option.textContent;
    b.onclick = () => {
      if (select.disabled) return;
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      sync();
    };
    group.append(b);
    return [b, option];
  });
  const sync = () => {
    for (const [b, option] of buttons) {
      const on = select.value === option.value;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
      b.disabled = select.disabled;
    }
  };
  select.addEventListener("change", sync);
  new MutationObserver(sync).observe(select, { attributes: true, attributeFilter: ["disabled"] });
  select.classList.add("visually-hidden-select");
  select.after(group);
  sync();
}


// Laser · one storey per board: tell which board thickness to buy.
// board (mm) = storey height (m) × 1000 / scale
function updateBoardHint() {
  const hint = $("#board-hint");
  if (!hint) return;
  const on = $("#building-mode").value === "laser_floor";
  hint.hidden = !on;
  if (!on) return;
  const h = Number($("#floor-height").value), scale = Number($("#scale").value);
  if (!(h > 0 && scale > 0)) { hint.textContent = ""; return; }
  const t = h * 1000 / scale;
  hint.textContent = _t('terrain.173', { 0: +h.toFixed(2), 1: scale, 2: +t.toFixed(2) });
}
for (const id of ["#building-mode", "#floor-height", "#scale"]) {
  $(id).addEventListener("input", updateBoardHint);
  $(id).addEventListener("change", updateBoardHint);
}
updateBoardHint();
