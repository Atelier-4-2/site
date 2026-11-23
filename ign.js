import { t as _t, loadedPromise } from "./i18n.js?v=20261123f";
await loadedPromise;   // the catalogs are ready before any module-level t() call
const L = globalThis.L;
const proj4 = globalThis.proj4;

if (!L || !proj4) {
  throw new Error(_t('ign.001'));
}

proj4.defs(
  "EPSG:2154",
  "+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 " +
  "+x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs"
);

const GEOCODE = "https://data.geopf.fr/geocodage/search";
const WFS = "https://data.geopf.fr/wfs";
const ELEVATION =
  "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json";

export const toL93 = (lon, lat) =>
  proj4("EPSG:4326", "EPSG:2154", [lon, lat]);

export const toWGS84 = (x, y) =>
  proj4("EPSG:2154", "EPSG:4326", [x, y]);

const abortError = () => new DOMException(_t('ign.002'), "AbortError");

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    const cancel = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

// Geocoding, WFS and elevation requests share a serial throttle.
// The map's WMTS requests remain managed by Leaflet.
let requestQueue = Promise.resolve();
let lastRequest = 0;

function requestJSON(endpoint, params, signal) {
  const task = async () => {
    // A non-JSON body (the WFS sometimes answers 200 with metrics text that the
    // browser then caches for weeks) is retried bypassing the HTTP cache.
    let bust = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      checkAbort(signal);
      await sleep(Math.max(0, 1100 - (Date.now() - lastRequest)), signal);

      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      const timeout = setTimeout(() => controller.abort(), 30000);
      lastRequest = Date.now();

      try {
        const url = new URL(endpoint);
        url.search = new URLSearchParams(params).toString();
        const response = await fetch(url, {
          mode: "cors",
          signal: controller.signal,
          ...(bust ? { cache: "reload" } : {})
        });

        if (!response.ok) {
          const error = new Error(_t('ign.003', { 0: response.status }));
          error.retryable = response.status === 429 || response.status >= 500;
          throw error;
        }
        return await response.json();
      } catch (error) {
        checkAbort(signal);
        if (error instanceof SyntaxError) { bust = true; error.retryable = true; }
        const retryable =
          error.retryable || error.name === "AbortError" ||
          error instanceof TypeError;
        if (!retryable || attempt === 2) {
          throw new Error(
            error.name === "AbortError"
              ? _t('ign.004')
              : error.message
          );
        }
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancel);
      }
      await sleep(2000 * (attempt + 1), signal);
    }
  };

  const result = requestQueue.then(task);
  requestQueue = result.catch(() => {});
  return result;
}

function mainland(lon, lat) {
  return Number.isFinite(lon) && Number.isFinite(lat) &&
    lon >= -6 && lon <= 10 && lat >= 41 && lat <= 52;
}

export async function searchPlaces(query, signal) {
  const q = query.trim();
  if (q.length < 3) return [];
  // index=address,poi: addresses AND named places (schools, buildings, sites).
  const data = await requestJSON(
    GEOCODE, { q, index: "address,poi", limit: 8 }, signal
  );
  if (!Array.isArray(data.features)) {
    throw new Error(_t('ign.005'));
  }
  return data.features.flatMap(feature => {
    const coordinates = feature.geometry?.coordinates;
    if (feature.geometry?.type !== "Point" || !coordinates) return [];
    const [lon, lat] = coordinates;
    if (!mainland(lon, lat)) return [];
    const p = feature.properties || {};
    const city = [p.postcode, p.city].flat().filter(Boolean)[0];
    const label = p._type === "poi"
      ? _t('ign.006', { 0: [p.toponym, p.name].flat().filter(Boolean)[0] || p.label, 1: city ? " · " + city : "" })
      : (p.label || `${lat}, ${lon}`);
    return [{
      label,
      lon,
      lat,
      l93: toL93(lon, lat)
    }];
  });
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ring2D(ring) {
  if (!Array.isArray(ring) || ring.length < 4) {
    throw new Error(_t('ign.007'));
  }
  return ring.map(point => {
    if (!Array.isArray(point) ||
        !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
      throw new Error(_t('ign.008'));
    }
    return [point[0], point[1]];
  });
}

export async function fetchBuildings(bounds, signal, progress = () => {}) {
  const result = [];
  const seen = new Set();
  let previousPage = null;

  for (let start = 0; start < 20000; start += 1000) {
    const data = await requestJSON(WFS, {
      SERVICE: "WFS",
      VERSION: "2.0.0",
      REQUEST: "GetFeature",
      TYPENAMES: "BDTOPO_V3:batiment",
      SRSNAME: "EPSG:2154",
      OUTPUTFORMAT: "application/json",
      BBOX: `${bounds.join(",")},urn:ogc:def:crs:EPSG::2154`,
      COUNT: 1000,
      STARTINDEX: start
    }, signal);

    if (!Array.isArray(data.features)) {
      throw new Error(_t('ign.009'));
    }

    const signature = JSON.stringify(
      data.features.map(feature => feature.id || feature.geometry)
    );
    if (data.features.length && signature === previousPage) {
      throw new Error(_t('ign.010'));
    }
    previousPage = signature;

    for (const feature of data.features) {
      const geometry = feature.geometry;
      if (!geometry) continue;
      if (!["Polygon", "MultiPolygon"].includes(geometry.type)) {
        throw new Error(_t('ign.011', { 0: geometry.type }));
      }

      const properties = feature.properties || {};
      const polygons = geometry.type === "Polygon"
        ? [geometry.coordinates] : geometry.coordinates;

      const id = String(feature.id || properties.cleabs ||
        JSON.stringify(geometry.coordinates));

      for (let part = 0; part < polygons.length; part++) {
        const key = `${id}:${part}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const rings = polygons[part];
        const h = numeric(properties.hauteur);
        const base = numeric(properties.altitude_minimale_sol);
        const floors = numeric(properties.nombre_d_etages);
        result.push({
          id: key,
          polygon: ring2D(rings[0]),
          holes: rings.slice(1).map(ring2D),
          h: h !== null && h > 0 ? h : null,
          base: base !== null && base > -999 ? base : null,
          // BD TOPO: floor count (often missing) and main use, for the list
          // Trust the IGN storey count only if it gives a plausible
          // 2.2-6 m storey; otherwise keep it as ignFloors (flagged) and
          // let the 층고 estimate / user input decide.
          floors: floors > 0 && h > 0 && h / floors >= 2.2 && h / floors <= 6
            ? Math.round(floors) : null,
          ignFloors: floors > 0 ? Math.round(floors) : null,
          usage: properties.usage_1 || properties.nature || ""
        });
      }
    }

    progress(_t('ign.012', { 0: result.length }));
    const matched = numeric(data.numberMatched);
    if (data.features.length < 1000 ||
        (matched !== null && start + data.features.length >= matched)) {
      return result;
    }
  }
  throw new Error(_t('ign.013'));
}

async function sampleElevations(points, signal, progress = () => {}) {
  const result = [];

  for (let offset = 0; offset < points.length; offset += 50) {
    checkAbort(signal);
    const chunk = points.slice(offset, offset + 50);
    const coordinates = chunk.map(([x, y]) => toWGS84(x, y));

    if (coordinates.some(([lon, lat]) => !mainland(lon, lat))) {
      throw new Error(_t('ign.014'));
    }

    const data = await requestJSON(ELEVATION, {
      resource: "ign_rge_alti_wld",
      lon: coordinates.map(p => p[0].toFixed(8)).join("|"),
      lat: coordinates.map(p => p[1].toFixed(8)).join("|"),
      zonly: "true"
    }, signal);

    if (!Array.isArray(data.elevations) ||
        data.elevations.length !== chunk.length) {
      throw new Error(_t('ign.015'));
    }

    for (const item of data.elevations) {
      const z = numeric(typeof item === "object" && item !== null ? item.z : item);
      if (z === null || z <= -999) {
        throw new Error(_t('ign.016'));
      }
      result.push(z);
    }
    progress(_t('ign.017', { 0: result.length, 1: points.length }));
  }
  return result;
}

export async function fetchTerrain(
  bounds, requestedStep, buildings, signal, progress = () => {}
) {
  const [xmin, ymin, xmax, ymax] = bounds;
  const width = xmax - xmin;
  if (!(width > 0) || Math.abs(width - (ymax - ymin)) > 0.001) {
    throw new Error(_t('ign.018'));
  }
  if (!(requestedStep >= 1 && requestedStep <= 100)) {
    throw new Error(_t('ign.019'));
  }
  const n = Math.ceil(width / requestedStep) + 1;
  if (n * n > 10000) {
    throw new Error(
      _t('ign.020', { 0: n * n })
    );
  }
  // IGN BD TOPO often lacks a height for small structures: skip them, don't block.
  const skippedNoHeight = buildings.filter(building => !(building.h > 0)).length;
  buildings = buildings.filter(building => building.h > 0);
  if (skippedNoHeight) {
    progress(_t('ign.021', { 0: skippedNoHeight }));
  }

  const dx = width / (n - 1);
  const points = [];
  // Contract: node samples; flat row-major z; rows increase south -> north.
  for (let row = 0; row < n; row++) {
    for (let column = 0; column < n; column++) {
      points.push([xmin + column * dx, ymin + row * dx]);
    }
  }

  const z = await sampleElevations(points, signal, progress);
  const outputBuildings = buildings.map(building => ({
    polygon: building.polygon,
    holes: building.holes,
    h: building.h,
    base: building.base,
    // IGN (or user-typed) storey count; null = estimate from 층고
    ...(building.floors ? { floors: building.floors } : {})
  }));

  const missing = outputBuildings
    .map((building, index) => building.base === null ? index : -1)
    .filter(index => index >= 0);

  if (missing.length) {
    progress(_t('ign.022', { 0: missing.length }));
    const bases = await sampleElevations(
      missing.map(index => outputBuildings[index].polygon[0]),
      signal,
      progress
    );
    missing.forEach((index, i) => { outputBuildings[index].base = bases[i]; });
  }

  return {
    dem: { x0: xmin, y0: ymin, dx, nx: n, ny: n, z },
    buildings: outputBuildings,
    skippedNoHeight
  };
}

function leafletPoint(point) {
  const [lon, lat] = toWGS84(point[0], point[1]);
  return [lat, lon];
}

function squareRing(bounds) {
  const [a, b, c, d] = bounds;
  return [[a, b], [c, b], [c, d], [a, d]];
}

export class IGNMap {
  constructor(element, { onRange, onSelection, onNotice }) {
    this.element = element;
    this.onRange = onRange;
    this.onSelection = onSelection;
    this.onNotice = onNotice;
    this.mode = "pan";
    this.enabled = true;
    this.bounds = null;
    this.radius = 200;
    this.buildings = [];
    this.selected = new Set();

    this.map = L.map(element, { preferCanvas: true })
      .setView([48.8566, 2.3522], 15);

    const wmts = (layer, format) =>
      "https://data.geopf.fr/wmts?" +
      "SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0" +
      `&LAYER=${layer}&STYLE=normal&FORMAT=${encodeURIComponent(format)}` +
      "&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}";

    const options = {
      maxZoom: 20,
      maxNativeZoom: 19,
      attribution: "© IGN"
    };
    this.plan = L.tileLayer(
      wmts("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", "image/png"), options
    ).addTo(this.map);
    this.photo = L.tileLayer(
      wmts("ORTHOIMAGERY.ORTHOPHOTOS", "image/jpeg"), options
    );

    for (const layer of [this.plan, this.photo]) {
      // A few missing tiles at the edge of a layer are normal. Warn only
      // when a whole view finished loading with no tile at all.
      let loaded = 0, failed = 0;
      layer.on("loading", () => { loaded = 0; failed = 0; });
      layer.on("tileload", () => { loaded += 1; });
      layer.on("tileerror", () => { failed += 1; });
      layer.on("load", () => {
        this.onNotice(failed > 0 && loaded === 0
          ? _t('ign.023') : "");
      });
    }

    this.buildingGroup = L.layerGroup().addTo(this.map);
    this.range = L.polygon([], {
      color: "#cc3a2e",
      weight: 2,
      fillOpacity: 0.06,
      interactive: false
    }).addTo(this.map);

    this.map.on("click", event => {
      if (!this.enabled || this.mode !== "point") return;
      this.setCenter(...toL93(event.latlng.lng, event.latlng.lat));
    });

    const pointFromEvent = event => {
      const box = element.getBoundingClientRect();
      const p = this.map.containerPointToLatLng([
        event.clientX - box.left,
        event.clientY - box.top
      ]);
      return toL93(p.lng, p.lat);
    };

    element.addEventListener("pointerdown", event => {
      if (!this.enabled || this.mode !== "draw" ||
          event.button !== 0 || event.target.closest(".leaflet-control")) return;
      event.preventDefault();
      this.drag = { id: event.pointerId, start: pointFromEvent(event) };
      element.setPointerCapture(event.pointerId);
    });

    element.addEventListener("pointermove", event => {
      if (!this.drag || event.pointerId !== this.drag.id) return;
      this.drag.bounds = this.drawBounds(this.drag.start, pointFromEvent(event));
      this.range.setLatLngs(squareRing(this.drag.bounds).map(leafletPoint));
    });

    element.addEventListener("pointerup", event => {
      if (!this.drag || event.pointerId !== this.drag.id) return;
      const bounds = this.drawBounds(this.drag.start, pointFromEvent(event));
      this.drag = null;
      if (element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
      const side = bounds[2] - bounds[0];
      if (side < 40 || side > 5000) {
        this.renderRange();
        this.onNotice(_t('ign.024'));
        return;
      }
      this.setBounds(bounds);
    });

    element.addEventListener("pointercancel", () => {
      this.drag = null;
      this.renderRange();
    });
    element.addEventListener("lostpointercapture", () => {
      if (!this.drag) return;
      this.drag = null;
      this.renderRange();
    });
    this.setMode("pan");
  }

  drawBounds(start, end) {
    const side = Math.max(Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]));
    const x = start[0] + (end[0] < start[0] ? -side : 0);
    const y = start[1] + (end[1] < start[1] ? -side : 0);
    return [x, y, x + side, y + side];
  }

  setEnabled(value) {
    this.enabled = value;
    this.drag = null;
    this.renderRange();
    this.updateInteractions();
  }

  updateInteractions() {
    const navigation = this.enabled && this.mode !== "draw";
    for (const name of [
      "dragging", "touchZoom", "doubleClickZoom",
      "scrollWheelZoom", "boxZoom", "keyboard"
    ]) {
      this.map[name]?.[navigation ? "enable" : "disable"]();
    }
  }

  setMode(mode) {
    this.mode = mode;
    this.element.dataset.mode = mode;
    this.updateInteractions();
  }

  setStyle(style, opacity) {
    // Keep both layers on the map and fade the photo layer's opacity, so
    // switching 지도 / 항공사진 / 겹쳐보기 cross-fades instead of popping.
    if (!this.map.hasLayer(this.plan)) this.plan.addTo(this.map);
    if (!this.map.hasLayer(this.photo)) this.photo.setOpacity(0).addTo(this.map);
    this.photo.setOpacity(style === "plan" ? 0 : style === "photo" ? 1 : opacity);
  }

  setRadius(radius) {
    if (!(radius >= 20 && radius <= 2500)) {
      throw new Error(_t('ign.025'));
    }
    this.radius = radius;
    if (this.bounds) {
      const [a, b, c, d] = this.bounds;
      this.setBounds([
        (a + c) / 2 - radius, (b + d) / 2 - radius,
        (a + c) / 2 + radius, (b + d) / 2 + radius
      ]);
    }
  }

  setCenter(x, y) {
    const [lon, lat] = toWGS84(x, y);
    if (!mainland(lon, lat)) {
      this.onNotice(_t('ign.026'));
      return;
    }
    if (this.marker) this.map.removeLayer(this.marker);
    this.marker = L.circleMarker([lat, lon], {
      radius: 6, color: "#fff", weight: 2,
      fillColor: "#d52e2e", fillOpacity: 1
    }).addTo(this.map);
    const r = this.radius;
    this.setBounds([x - r, y - r, x + r, y + r]);
  }

  setBounds(bounds) {
    if (squareRing(bounds).some(point => !mainland(...toWGS84(...point)))) {
      this.renderRange();
      this.onNotice(_t('ign.027'));
      return;
    }
    this.bounds = bounds;
    this.radius = (bounds[2] - bounds[0]) / 2;
    this.clearBuildings();
    this.renderRange();
    this.onRange([...bounds]);
  }

  renderRange() {
    this.range.setLatLngs(
      this.bounds ? squareRing(this.bounds).map(leafletPoint) : []
    );
  }

  fitRange() {
    if (this.bounds) this.map.fitBounds(this.range.getBounds(), { padding: [20, 20] });
  }

  resize() { this.map.invalidateSize(); }

  clearBuildings() {
    this.focused = null;
    this.buildingGroup.clearLayers();
    this.buildings = [];
    this.polygons = [];
    this.selected.clear();
  }

  setBuildings(buildings) {
    this.clearBuildings();
    this.buildings = buildings;
    this.selected = new Set(buildings.map((_, index) => index));
    this.polygons = buildings.map((building, index) => {
      const polygon = L.polygon(
        [building.polygon, ...building.holes]
          .map(ring => ring.map(leafletPoint)),
        { weight: 1, bubblingMouseEvents: false }
      ).addTo(this.buildingGroup);
      polygon.on("click", () => {
        this.onFocus?.(index);  // show which list row this is, in any mode
        if (!this.enabled || this.mode !== "building") return;
        this.toggle(index);
      });
      return polygon;
    });
    this.refreshSelection();
  }

  toggle(index) {
    if (this.selected.has(index)) this.selected.delete(index);
    else this.selected.add(index);
    this.refreshSelection();
  }

  selectAll(value) {
    this.selected = new Set(value ? this.buildings.map((_, index) => index) : []);
    this.refreshSelection();
  }

  refreshSelection() {
    this.polygons?.forEach((polygon, index) => polygon.setStyle({
      color: index === this.focused ? "#1d1d1f"
        : this.selected.has(index) ? "#b52727" : "#62737a",
      weight: index === this.focused ? 4 : 1,
      fillColor: this.selected.has(index) ? "#e04a3a" : "#9faeb3",
      fillOpacity: this.selected.has(index) ? 0.45 : 0.15
    }));
    this.onSelection(this.getSelected());
  }

  // Highlight one building (thick dark outline) and bring it into view.
  focus(index, { zoom = true } = {}) {
    const polygon = this.polygons?.[index];
    if (!polygon) return;
    this.focused = index;
    this.refreshSelection();
    polygon.bringToFront();
    if (zoom) {
      this.map.flyToBounds(polygon.getBounds(), {
        maxZoom: 19, padding: [60, 60], duration: 0.4
      });
    }
  }

  getSelected() {
    return this.buildings.filter((_, index) => this.selected.has(index));
  }
}

// ---------------------------------------------------------------------------
// Site-analysis diagrams (diagrams.html). Additive: nothing above is changed.
// ---------------------------------------------------------------------------

const WMS_R = "https://data.geopf.fr/wms-r/wms";

function yearOf(value) {
  const m = /^(-?\d{4})/.exec(String(value ?? ""));
  return m ? Number(m[1]) : null;
}

function xy(point) { return [point[0], point[1]]; }

// Generic paged WFS reader (EPSG:2154). Returns
//   [{ id, props, polygons: [[outer, ...holes], ...], lines: [[pt, ...], ...] }]
// Coordinates are flattened to [x, y]; IGN returns a Z for some layers.
export async function fetchWfsFeatures(
  typeName, bounds, signal, progress = () => {}, label = typeName, cql = null
) {
  const result = [];
  let previousPage = null;
  for (let start = 0; start < 20000; start += 1000) {
    const params = {
      SERVICE: "WFS",
      VERSION: "2.0.0",
      REQUEST: "GetFeature",
      TYPENAMES: typeName,
      SRSNAME: "EPSG:2154",
      OUTPUTFORMAT: "application/json",
      BBOX: `${bounds.join(",")},urn:ogc:def:crs:EPSG::2154`,
      COUNT: 1000,
      STARTINDEX: start
    };
    if (cql) {
      // GeoServer rejects BBOX together with CQL_FILTER: fold the box into the filter.
      delete params.BBOX;
      params.CQL_FILTER = `${cql} AND BBOX(the_geom,${bounds.join(",")},'EPSG:2154')`;
    }
    const data = await requestJSON(WFS, params, signal);
    if (!Array.isArray(data.features)) {
      throw new Error(_t('ign.028', { 0: label }));
    }
    const signature = JSON.stringify(data.features.map(f => f.id || f.geometry));
    if (data.features.length && signature === previousPage) {
      throw new Error(_t('ign.029', { 0: label }));
    }
    previousPage = signature;

    for (const feature of data.features) {
      const g = feature.geometry;
      if (!g) continue;
      const item = {
        id: String(feature.id || feature.properties?.cleabs || result.length),
        props: feature.properties || {},
        polygons: [],
        lines: [],
        points: []
      };
      switch (g.type) {
        case "Polygon":
          item.polygons.push(g.coordinates.map(r => r.map(xy)));
          break;
        case "MultiPolygon":
          for (const p of g.coordinates) item.polygons.push(p.map(r => r.map(xy)));
          break;
        case "LineString":
          item.lines.push(g.coordinates.map(xy));
          break;
        case "MultiLineString":
          for (const l of g.coordinates) item.lines.push(l.map(xy));
          break;
        case "Point":
          item.points.push(xy(g.coordinates));
          break;
        case "MultiPoint":
          for (const p of g.coordinates) item.points.push(xy(p));
          break;
        default: continue;
      }
      result.push(item);
    }
    progress(_t('ign.030', { 0: label, 1: result.length }));
    const matched = numeric(data.numberMatched);
    if (data.features.length < 1000 ||
        (matched !== null && start + data.features.length >= matched)) {
      return result;
    }
  }
  throw new Error(_t('ign.031', { 0: label }));
}

// Buildings with every attribute the diagrams need. Missing values stay null
// (shown as "미상" by the diagrams, never silently dropped).
export async function fetchBuildingsDetailed(bounds, signal, progress = () => {}) {
  const features = await fetchWfsFeatures(
    "BDTOPO_V3:batiment", bounds, signal, progress, _t('ign.032')
  );
  const out = [];
  for (const f of features) {
    const p = f.props;
    const h = numeric(p.hauteur);
    const floors = numeric(p.nombre_d_etages);
    f.polygons.forEach((rings, part) => out.push({
      id: `${f.id}:${part}`,
      polygon: rings[0],
      holes: rings.slice(1),
      h: h !== null && h > 0 ? h : null,
      floors: floors !== null && floors >= 0 ? Math.round(floors) : null,
      usage: p.usage_1 || null,
      usage2: p.usage_2 || null,
      nature: p.nature || null,
      year: yearOf(p.date_d_apparition),
      light: p.construction_legere === true
    }));
  }
  return out;
}

export const fetchVegetation = (bounds, signal, progress) =>
  fetchWfsFeatures("BDTOPO_V3:zone_de_vegetation", bounds, signal, progress, _t('ign.033'));

export const fetchWaterSurfaces = (bounds, signal, progress) =>
  fetchWfsFeatures("BDTOPO_V3:surface_hydrographique", bounds, signal, progress, _t('ign.034'));

export const fetchWaterLines = (bounds, signal, progress) =>
  fetchWfsFeatures("BDTOPO_V3:troncon_hydrographique", bounds, signal, progress, _t('ign.035'));

export const fetchRoads = (bounds, signal, progress) =>
  fetchWfsFeatures("BDTOPO_V3:troncon_de_route", bounds, signal, progress, _t('ign.036'));

export const fetchParcels = (bounds, signal, progress) =>
  fetchWfsFeatures(
    "CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle", bounds, signal, progress, _t('ign.037')
  );

// Fetching CORS-approved blobs keeps every bitmap origin-clean for canvas export.
async function photoTile(url, signal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(cancel, 20000);
  try {
    checkAbort(signal);
    const r = await fetch(url, { mode: "cors", signal: controller.signal });
    if (!r.ok) throw new Error(_t('ign.038', { 0: r.status }));
    const image = await createImageBitmap(await r.blob());
    if (signal.aborted || image.width !== 256 || image.height !== 256) {
      image.close();
      checkAbort(signal);
      throw new Error(_t('ign.039'));
    }
    return image;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
  }
}

async function wmtsOrthophoto(bounds, width, height, signal) {
  const [x0, y0, x1, y1] = bounds;
  const world = 40075016.68557849;
  const corners = [[x0, y1], [x1, y1], [x0, y0], [x1, y0]]
    .map(p => proj4("EPSG:2154", "EPSG:3857", p));
  const resolution = Math.max(
    Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]) / width,
    Math.hypot(corners[2][0] - corners[0][0], corners[2][1] - corners[0][1]) / height);
  const zoom = Math.max(0, Math.min(19, Math.floor(Math.log2(world / (256 * resolution)))));
  const unit = world / (256 * 2 ** zoom);
  const points = corners.map(([x, y]) => [(x + world / 2) / unit, (world / 2 - y) / unit]);
  const cols = points.map(p => Math.floor(p[0] / 256)), rows = points.map(p => Math.floor(p[1] / 256));
  const left = Math.min(...cols), top = Math.min(...rows);
  const canvas = document.createElement("canvas");
  canvas.width = (Math.max(...cols) - left + 1) * 256;
  canvas.height = (Math.max(...rows) - top + 1) * 256;
  const g = canvas.getContext("2d"), jobs = [];
  for (let y = top; y <= Math.max(...rows); y++) for (let x = left; x <= Math.max(...cols); x++) jobs.push([x, y]);
  const controller = new AbortController(), cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  let next = 0;
  try {
    checkAbort(signal);
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < jobs.length) {
        const [x, y] = jobs[next++];
        const url = "https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile" +
          "&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image%2Fjpeg&TILEMATRIXSET=PM" +
          `&TILEMATRIX=${zoom}&TILEROW=${y}&TILECOL=${x}`;
        const image = await photoTile(url, controller.signal);
        try { g.drawImage(image, (x - left) * 256, (y - top) * 256); }
        finally { image.close(); }
      }
    }));
    const source = g.getImageData(0, 0, canvas.width, canvas.height);
    const output = document.createElement("canvas");
    output.width = width; output.height = height;
    const target = output.getContext("2d"), pixels = target.createImageData(width, height);
    // Bilinear corner reprojection approximates L93 -> PM over this local extent.
    for (let y = 0; y < height; y++) {
      checkAbort(signal);
      const v = (y + .5) / height;
      const a = points[0].map((n, i) => n + v * (points[2][i] - n));
      const b = points[1].map((n, i) => n + v * (points[3][i] - n));
      for (let x = 0; x < width; x++) {
        const u = (x + .5) / width;
        const sx = Math.floor(a[0] + u * (b[0] - a[0])) - left * 256;
        const sy = Math.floor(a[1] + u * (b[1] - a[1])) - top * 256;
        const from = (sy * canvas.width + sx) * 4, to = (y * width + x) * 4;
        pixels.data.set(source.data.subarray(from, from + 4), to);
      }
    }
    target.putImageData(pixels, 0, 0);
    const blob = await new Promise((resolve, reject) => output.toBlob(
      b => b ? resolve(b) : reject(new Error(_t('ign.040'))), "image/jpeg", .92));
    checkAbort(signal);
    return blob;
  } finally {
    controller.abort();
    signal?.removeEventListener("abort", cancel);
  }
}

// Orthophoto as a square JPEG in EPSG:2154 (same layer as the WMTS photo
// tiles, but delivered already in the project CRS so it overlays exactly).
export function fetchOrthophoto(bounds, pixels, signal) {
  const dx = bounds[2] - bounds[0], dy = bounds[3] - bounds[1];
  if (!bounds.every(Number.isFinite) || !(dx > 0 && dy > 0 && pixels > 0 && Number.isFinite(pixels))) {
    return Promise.reject(new Error(_t('ign.040')));
  }
  const scale = Math.min(pixels / dx, 4096 / dx, 4096 / dy);
  const width = Math.max(1, Math.round(dx * scale)), height = Math.max(1, Math.round(dy * scale));
  const task = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      checkAbort(signal);
      await sleep(Math.max(0, 1100 - (Date.now() - lastRequest)), signal);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      const timeout = setTimeout(() => controller.abort(), 60000);
      lastRequest = Date.now();
      try {
        const url = new URL(WMS_R);
        url.search = new URLSearchParams({
          SERVICE: "WMS", VERSION: "1.3.0", REQUEST: "GetMap",
          LAYERS: "ORTHOIMAGERY.ORTHOPHOTOS", STYLES: "", CRS: "EPSG:2154",
          BBOX: bounds.join(","), WIDTH: width, HEIGHT: height,
          FORMAT: "image/jpeg"
        }).toString();
        const response = await fetch(url, { mode: "cors", signal: controller.signal });
        if (!response.ok) {
          const error = new Error(_t('ign.038', { 0: response.status }));
          error.retryable = response.status === 429 || response.status >= 500;
          throw error;
        }
        const blob = await response.blob();
        if (!/^image\//.test(blob.type)) {
          throw new Error(_t('ign.039'));
        }
        const image = await createImageBitmap(blob);
        const valid = image.width === width && image.height === height;
        image.close();
        if (!valid) throw new Error(_t('ign.039'));
        checkAbort(signal);
        return blob;
      } catch (error) {
        checkAbort(signal);
        const retryable = error.retryable || error.name === "AbortError" ||
          error instanceof TypeError;
        if (!retryable || attempt === 2) {
          throw new Error(error.name === "AbortError"
            ? _t('ign.041') : error.message);
        }
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancel);
      }
      await sleep(2000 * (attempt + 1), signal);
    }
  };
  const result = requestQueue.then(task).catch(async error => {
    checkAbort(signal);
    try { return await wmtsOrthophoto(bounds, width, height, signal); }
    catch (fallback) {
      checkAbort(signal);
      throw new Error(`${error.message} / WMTS: ${fallback.message}`);
    }
  });
  requestQueue = result.catch(() => {});
  return result;
}


// ---------------------------------------------------------------------------
// Phase 2 fetchers (vector data only). Endpoints/fields verified live 2026-11-13.
// ---------------------------------------------------------------------------

// Géoportail de l'Urbanisme (Géoplateforme WFS): wfs_du:zone_urba
// props: libelle (zone code, e.g. "UV"), libelong, typezone (U/AU/A/N), idurba.
export const fetchPluZones = (bounds, signal, progress) =>
  fetchWfsFeatures("wfs_du:zone_urba", bounds, signal, progress, _t('ign.042'));

// Servitudes d'utilité publique, polygon assiettes: wfs_sup:assiette_sup_s
// props: suptype (ac1, ac2, ac4, i4, pm1, t1, el3 ...), typeass, nomsuplitt.
export const fetchSup = (bounds, signal, progress) =>
  fetchWfsFeatures("wfs_sup:assiette_sup_s", bounds, signal, progress, _t('ign.043'));

// Emplacements réservés = GPU prescriptions with typepsc = '05' (surface, line
// and point tables). Same feature shape as fetchWfsFeatures, plus `kind`.
export async function fetchReservedSites(bounds, signal, progress) {
  const out = [];
  for (const t of ["surf", "lin", "pct"]) {
    let fs = [];
    try {
      fs = await fetchWfsFeatures(
        `wfs_du:prescription_${t}`, bounds, signal, progress, _t('ign.044'), "typepsc='05'");
    } catch (error) {
      if (t === "surf") throw error; // line/point tables are optional extras
      if (error.name === "AbortError") throw error;
    }
    for (const f of fs) out.push({ ...f, kind: t });
  }
  return out;
}

// Walking isochrones (data.geopf.fr/navigation/isochrone, resource
// bdtopo-valhalla, profile pedestrian). `center` is [x, y] in EPSG:2154.
// Returns [{ min, polygons:[[outer,...holes]] }] in EPSG:2154.
export async function fetchIsochrones(center, signal, progress = () => {}, minutes = [5, 10, 15]) {
  const [lon, lat] = toWGS84(center[0], center[1]);
  const out = [];
  for (const m of minutes) {
    progress(_t('ign.045', { 0: m }));
    const data = await requestJSON("https://data.geopf.fr/navigation/isochrone", {
      point: `${lon.toFixed(6)},${lat.toFixed(6)}`,
      resource: "bdtopo-valhalla", profile: "pedestrian", costType: "time",
      costValue: m * 60, timeUnit: "second", direction: "departure",
      geometryFormat: "geojson", crs: "EPSG:4326"
    }, signal);
    const g = data.geometry;
    if (!g || !g.coordinates) throw new Error(_t('ign.046'));
    const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
    out.push({ min: m, polygons: polys.map(p => p.map(r => r.map(([x, y]) => toL93(x, y)))) });
  }
  return out;
}

// ---- OpenStreetMap through Overpass ------------------------------------------
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

// Overpass allows few concurrent queries per client: run them one after another.
let overpassQueue = Promise.resolve();
function overpass(query, signal, label) {
  const run = overpassOnce(query, signal, label);
  const task = overpassQueue.then(() => run());
  overpassQueue = task.catch(() => {});
  return task;
}

function overpassOnce(query, signal, label) {
  return () => overpassTry(query, signal, label);
}

async function overpassTry(query, signal, label) {
  let lastError = null;
  for (let round = 0; round < 1; round++) {
    for (const endpoint of OVERPASS) {
      checkAbort(signal);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      const timeout = setTimeout(() => controller.abort(), 25000); // fail fast: OSM must not hold up the sheet
      try {
        const url = new URL(endpoint);
        url.search = new URLSearchParams({ data: query }).toString();
        const response = await fetch(url, { mode: "cors", signal: controller.signal });
        if (!response.ok) throw new Error(_t('ign.047', { 0: response.status }));
        const json = await response.json();
        if (!Array.isArray(json.elements)) throw new Error(_t('ign.048', { 0: label }));
        return json.elements;
      } catch (error) {
        checkAbort(signal);
        lastError = error.name === "AbortError" ? new Error(_t('ign.049')) : error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", cancel);
      }
    }
  }
  throw lastError || new Error(_t('ign.050'));
}

// WGS84 bbox "south,west,north,east" enclosing an EPSG:2154 extent.
function wgsBox(b) {
  const pts = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(p => toWGS84(p[0], p[1]));
  const lons = pts.map(p => p[0]), lats = pts.map(p => p[1]);
  return [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)]
    .map(v => v.toFixed(6)).join(",");
}

// Overpass `out geom(bbox)` yields null for vertices outside the box: split there.
function splitNull(geometry) {
  const parts = [];
  let cur = [];
  for (const g of geometry) {
    if (g) cur.push(g);
    else { if (cur.length > 1) parts.push(cur); cur = []; }
  }
  if (cur.length > 1) parts.push(cur);
  return parts;
}

// OSM natural=tree nodes (+ tree_row ways). Returns { points:[[x,y]], rows:[[pt,...]] }.
export async function fetchOsmTrees(bounds, signal, progress = () => {}) {
  progress(_t('ign.051'));
  const bb = wgsBox(bounds);
  const els = await overpass(
    `[out:json][timeout:25];(node["natural"="tree"](${bb});way["natural"="tree_row"](${bb}););out geom(${bb});`,
    signal, _t('ign.052'));
  const points = [], rows = [];
  for (const e of els) {
    if (e.type === "node") points.push(toL93(e.lon, e.lat));
    else if (e.type === "way" && e.geometry) {
      for (const part of splitNull(e.geometry)) rows.push(part.map(g => toL93(g.lon, g.lat)));
    }
  }
  return { points, rows };
}

// OSM public transport: stops and route relations (member geometry clipped to bbox).
// Returns { stops:[{p, kind, name}], routes:[{ref, mode, colour, name, lines:[[pt,..]]}] }.
export async function fetchOsmTransit(bounds, signal, progress = () => {}) {
  progress(_t('ign.053'));
  const bb = wgsBox(bounds);
  const els = await overpass(
    `[out:json][timeout:25];(` +
    `node["highway"="bus_stop"](${bb});` +
    `node["railway"~"^(station|halt|tram_stop|subway_entrance)$"](${bb});` +
    `rel["route"~"^(bus|trolleybus|tram|subway|light_rail|train|monorail)$"](${bb});` +
    `);out geom(${bb});`, signal, _t('ign.054'));
  const stops = [], routes = [];
  for (const e of els) {
    const t = e.tags || {};
    if (e.type === "node") {
      const kind = t.highway === "bus_stop" ? "bus"
        : t.railway === "tram_stop" ? "tram"
        : t.railway === "subway_entrance" ? "subway" : "rail";
      stops.push({ p: toL93(e.lon, e.lat), kind, name: t.name || null });
    } else if (e.type === "relation") {
      const lines = [];
      for (const m of e.members || []) {
        if (m.type === "way" && m.geometry && !/^(stop|platform)/.test(m.role || "")) {
          for (const part of splitNull(m.geometry)) lines.push(part.map(g => toL93(g.lon, g.lat)));
        }
      }
      routes.push({ ref: t.ref || null, mode: t.route, colour: t.colour || t.color || null, name: t.name || null, lines });
    }
  }
  return { stops, routes };
}

// Elevation grid over a square EPSG:2154 extent (IGN RGE ALTI via the Géoplateforme
// altimetry service). Row-major z, rows south -> north; node samples, n x n points.
export async function fetchElevationGrid(bounds, signal, progress = () => {}, n = null) {
  const [xmin, ymin, xmax, ymax] = bounds;
  const width = xmax - xmin, height = ymax - ymin, long = Math.max(width, height);
  if (!n) n = Math.max(11, Math.min(41, Math.ceil(long / 20) + 1));
  const dx = long / (n - 1);                      // same cell size in both directions
  const nx = Math.ceil(width / dx - 1e-9) + 1, ny = Math.ceil(height / dx - 1e-9) + 1;
  const points = [];
  for (let row = 0; row < ny; row++) for (let col = 0; col < nx; col++) points.push([xmin + col * dx, ymin + row * dx]);
  const z = await sampleElevations(points, signal, progress);
  return { x0: xmin, y0: ymin, dx, nx, ny, z };
}
