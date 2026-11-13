// Terrain, sun, sky-view and viewshed computations for the site diagrams (18, 19,
// 22, 23, 24, 26, 28) and the analysis tabs. All results are reference simulations
// ("참고용 시뮬레이션"), not legal or engineering values. Coordinates: EPSG:2154 m.
import { heightOf } from "./dganalysis.js?v=20261113p";

const RAD = Math.PI / 180;

// ---- solar position (SunCalc / Meeus formulas) ---------------------------------------------
const J1970 = 2440588, J2000 = 2451545, DAY = 86400000;
const toDays = d => d.valueOf() / DAY - 0.5 + J1970 - J2000;
const E = RAD * 23.4397;
const solarMeanAnomaly = d => RAD * (357.5291 + 0.98560028 * d);
const eclipticLongitude = M => {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  return M + C + RAD * 102.9372 + Math.PI;
};

// Returns azimuth (radians clockwise from north) and altitude (radians). `date` is a JS Date (UTC based).
export function sunPosition(date, lat, lon) {
  const d = toDays(date);
  const M = solarMeanAnomaly(d), L = eclipticLongitude(M);
  const dec = Math.asin(Math.sin(E) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(E), Math.cos(L));
  const lw = -lon * RAD, phi = lat * RAD;
  const H = RAD * (280.16 + 360.9856235 * d) - lw - ra;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const azSouth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return { az: (azSouth + Math.PI) % (2 * Math.PI), alt };
}

// Europe/Paris offset (hours) for a date, from the browser's tz database.
export function parisOffset(date) {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", timeZoneName: "shortOffset" })
      .formatToParts(date).find(x => x.type === "timeZoneName").value;
    const m = /GMT([+-]\d+)/.exec(p);
    return m ? Number(m[1]) : 1;
  } catch { return 1; }
}

// Local (Paris) civil date + decimal hour -> UTC Date.
export function parisDate(y, m, d, hour) {
  const guess = new Date(Date.UTC(y, m - 1, d, 12));
  const off = parisOffset(guess);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) + (hour - off) * 3600000);
}

export const KEY_DAYS = [
  { id: "winter", label: "동지 12/21", m: 12, d: 21 },
  { id: "equinox", label: "춘분 3/20", m: 3, d: 20 },
  { id: "autumn", label: "추분 9/22", m: 9, d: 22 },
  { id: "summer", label: "하지 6/21", m: 6, d: 21 }
];

// Sun samples (every `stepMin`) while the sun is above 2 degrees. Returns [{hour, az, alt}] (local hours).
export function daySun(y, m, d, lat, lon, stepMin = 30) {
  const out = [];
  for (let h = 0; h < 24; h += stepMin / 60) {
    const p = sunPosition(parisDate(y, m, d, h), lat, lon);
    if (p.alt > 2 * RAD) out.push({ hour: h, az: p.az, alt: p.alt });
  }
  return out;
}

// ---- elevation grid helpers -----------------------------------------------------------------------
// dem = { x0, y0, dx, nx, ny, z } (row-major, rows south -> north)
export function demAt(dem, x, y) {
  if (!dem) return 0;
  const fx = (x - dem.x0) / dem.dx, fy = (y - dem.y0) / dem.dx;
  const i = Math.max(0, Math.min(dem.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(dem.ny - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - i)), ty = Math.max(0, Math.min(1, fy - j));
  const z = (a, b) => dem.z[(j + b) * dem.nx + i + a];
  return (z(0, 0) * (1 - tx) + z(1, 0) * tx) * (1 - ty) + (z(0, 1) * (1 - tx) + z(1, 1) * tx) * ty;
}

// Contour lines by marching squares. Returns { interval, lines:[{level, pts}] , min, max }.
export function contours(dem, interval = null) {
  let min = Infinity, max = -Infinity;
  for (const v of dem.z) { if (v < min) min = v; if (v > max) max = v; }
  const range = max - min;
  if (!interval) interval = range < 6 ? 0.5 : range < 15 ? 1 : range < 40 ? 2 : range < 100 ? 5 : 10;
  const lines = [];
  const { nx, ny, dx, x0, y0, z } = dem;
  for (let level = Math.ceil(min / interval) * interval; level <= max; level += interval) {
    const segs = [];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const v = [z[j * nx + i], z[j * nx + i + 1], z[(j + 1) * nx + i + 1], z[(j + 1) * nx + i]];
      const px = [[0, 0], [1, 0], [1, 1], [0, 1]];
      const pts = [];
      for (let k = 0; k < 4; k++) {
        const a = v[k], b = v[(k + 1) % 4];
        if ((a < level) !== (b < level)) {
          const t = (level - a) / (b - a);
          const p = px[k], q = px[(k + 1) % 4];
          pts.push([x0 + (i + p[0] + (q[0] - p[0]) * t) * dx, y0 + (j + p[1] + (q[1] - p[1]) * t) * dx]);
        }
      }
      if (pts.length === 2) segs.push(pts);
      else if (pts.length === 4) { segs.push([pts[0], pts[1]]); segs.push([pts[2], pts[3]]); }
    }
    // join segments into polylines
    const key = p => Math.round(p[0] * 20) + "_" + Math.round(p[1] * 20);
    const ends = new Map();
    segs.forEach((s, idx) => { for (const p of s) { const k = key(p); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(idx); } });
    const used = new Uint8Array(segs.length);
    for (let s = 0; s < segs.length; s++) {
      if (used[s]) continue;
      used[s] = 1;
      let line = [segs[s][0], segs[s][1]];
      for (const dir of [1, 0]) {
        for (;;) {
          const tip = dir ? line[line.length - 1] : line[0];
          const next = (ends.get(key(tip)) || []).find(i => !used[i]);
          if (next === undefined) break;
          used[next] = 1;
          const o = segs[next];
          const other = key(o[0]) === key(tip) ? o[1] : o[0];
          if (dir) line.push(other); else line.unshift(other);
        }
      }
      lines.push({ level, pts: line });
    }
  }
  return { interval, lines, min, max };
}

// Slope (degrees) and aspect (degrees clockwise from north the slope faces; NaN = flat) per grid node.
export function slopeAspect(dem) {
  const { nx, ny, dx, z } = dem;
  const slope = new Float32Array(nx * ny), aspect = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(nx - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(ny - 1, j + 1);
    const dzdx = (z[j * nx + i1] - z[j * nx + i0]) / ((i1 - i0) * dx);
    const dzdy = (z[j1 * nx + i] - z[j0 * nx + i]) / ((j1 - j0) * dx);
    const s = Math.atan(Math.hypot(dzdx, dzdy)) / RAD;
    slope[j * nx + i] = s;
    // downhill direction = (-dzdx, -dzdy) in (east, north)
    aspect[j * nx + i] = s < 1 ? NaN : (Math.atan2(-dzdx, -dzdy) / RAD + 360) % 360;
  }
  return { slope, aspect };
}

// ---- height surface raster (ground + buildings) -------------------------------------------------------
function inRing(ring, x, y) {
  let r = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) r = !r;
  }
  return r;
}

export function gridStepFor(extent) {
  const side = Math.max(extent[2] - extent[0], extent[3] - extent[1]);
  return side <= 1300 ? 4 : Math.ceil(side / 325);
}

// surface = { x0, y0, step, nx, ny, ground, top, bld }, row-major, rows south -> north.
// Buildings without any height are given 3 m (flagged in `unknownHeight`).
export function makeSurface(extent, buildings, dem) {
  const step = gridStepFor(extent);
  const nx = Math.ceil((extent[2] - extent[0]) / step), ny = Math.ceil((extent[3] - extent[1]) / step);
  const x0 = extent[0], y0 = extent[1];
  const ground = new Float32Array(nx * ny), top = new Float32Array(nx * ny), bld = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    ground[j * nx + i] = demAt(dem, x0 + (i + .5) * step, y0 + (j + .5) * step);
  }
  top.set(ground);
  let unknownHeight = 0;
  for (const b of buildings) {
    const hh = heightOf(b);
    if (hh == null) unknownHeight++;
    const h = hh == null ? 3 : hh;
    let a = Infinity, c = Infinity, d = -Infinity, e = -Infinity;
    for (const p of b.polygon) { a = Math.min(a, p[0]); c = Math.min(c, p[1]); d = Math.max(d, p[0]); e = Math.max(e, p[1]); }
    const ia = Math.max(0, Math.floor((a - x0) / step)), ib = Math.min(nx - 1, Math.floor((d - x0) / step));
    const ja = Math.max(0, Math.floor((c - y0) / step)), jb = Math.min(ny - 1, Math.floor((e - y0) / step));
    if (ia > ib || ja > jb) continue;
    // building base: lowest ground under footprint centre cell
    for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) {
      const x = x0 + (i + .5) * step, y = y0 + (j + .5) * step;
      if (!inRing(b.polygon, x, y)) continue;
      if (b.holes.some(r => inRing(r, x, y))) continue;
      const k = j * nx + i;
      bld[k] = 1;
      top[k] = Math.max(top[k], ground[k] + h);
    }
  }
  return { x0, y0, step, nx, ny, ground, top, bld, unknownHeight, extent };
}

// ---- sun hours ------------------------------------------------------------------------------------------
// Fraction of the daylight samples in which each ground cell sees the sun; returns
// { hours:Float32Array(hours of direct sun), daylight (h), samples }. Building cells = NaN.
export function sunHours(S, lat, lon, y, m, d, stepMin = 30) {
  const sun = daySun(y, m, d, lat, lon, stepMin);
  const hours = new Float32Array(S.nx * S.ny);
  const maxDist = 400;
  for (let j = 0; j < S.ny; j++) for (let i = 0; i < S.nx; i++) {
    const k = j * S.nx + i;
    if (S.bld[k]) { hours[k] = NaN; continue; }
    const z0 = S.top[k] + 0.5; // eye-level 0.5 m above ground
    let lit = 0;
    for (const s of sun) {
      const dx = Math.sin(s.az), dy = Math.cos(s.az), tan = Math.tan(s.alt);
      let blocked = false;
      for (let t = S.step; t <= maxDist; t += S.step) {
        const x = i + .5 + dx * t / S.step, y2 = j + .5 + dy * t / S.step;
        const xi = Math.floor(x), yj = Math.floor(y2);
        if (xi < 0 || yj < 0 || xi >= S.nx || yj >= S.ny) break;
        if (S.top[yj * S.nx + xi] > z0 + t * tan) { blocked = true; break; }
      }
      if (!blocked) lit++;
    }
    hours[k] = lit * stepMin / 60;
  }
  const daylight = sun.length * stepMin / 60;
  return { hours, daylight, samples: sun.length };
}

// ---- sky view factor ----------------------------------------------------------------------------------------
// SVF = 1 - mean(sin^2(horizon elevation)) over `rays` azimuths (cosine-weighted approximation). NaN on buildings.
export function skyViewFactor(S, rays = 16, maxDist = 150) {
  const svf = new Float32Array(S.nx * S.ny);
  const dirs = Array.from({ length: rays }, (_, r) => [Math.sin(r / rays * 2 * Math.PI), Math.cos(r / rays * 2 * Math.PI)]);
  for (let j = 0; j < S.ny; j++) for (let i = 0; i < S.nx; i++) {
    const k = j * S.nx + i;
    if (S.bld[k]) { svf[k] = NaN; continue; }
    const z0 = S.top[k] + 1.5;
    let acc = 0;
    for (const [dx, dy] of dirs) {
      let best = 0;
      // half-cell steps: whole-cell steps skipped thin buildings and slipped through
      // diagonal gaps between corner-touching building cells
      for (let t = S.step * .75; t <= maxDist; t += S.step / 2) {
        const xi = Math.floor(i + .5 + dx * t / S.step), yj = Math.floor(j + .5 + dy * t / S.step);
        if (xi < 0 || yj < 0 || xi >= S.nx || yj >= S.ny) break;
        const dz = S.top[yj * S.nx + xi] - z0;
        if (dz > 0) { const tn = dz / t; if (tn > best) best = tn; }
      }
      const s = Math.sin(Math.atan(best));
      acc += s * s;
    }
    svf[k] = 1 - acc / rays;
  }
  return svf;
}

// ---- viewshed -------------------------------------------------------------------------------------------------
// Visible (1) / hidden (0) per cell from an observer at (ox, oy) with eye height `eye` above the local ground.
// Cells inside buildings test the roof. Returns Uint8Array.
// Ground cells are tested at `targetH` above the ground (default 1.6 m = "can I see a person
// standing there"); testing the bare ground made the result break into speckles on
// slightly uneven terrain.
export function viewshed(S, ox, oy, eye, maxDist = 2000, targetH = 1.6) {
  const out = new Uint8Array(S.nx * S.ny);
  let oi = Math.max(0, Math.min(S.nx - 1, Math.floor((ox - S.x0) / S.step)));
  let oj = Math.max(0, Math.min(S.ny - 1, Math.floor((oy - S.y0) / S.step)));
  let snapped = 0;
  if (S.bld[oj * S.nx + oi]) {
    // observer inside a building: move to the nearest open (non-building) cell
    let best = null;
    for (let r = 1; r < Math.max(S.nx, S.ny) && !best; r++) {
      let bd = Infinity;
      for (let j = Math.max(0, oj - r); j <= Math.min(S.ny - 1, oj + r); j++) for (let i = Math.max(0, oi - r); i <= Math.min(S.nx - 1, oi + r); i++) {
        if (Math.max(Math.abs(i - oi), Math.abs(j - oj)) !== r || S.bld[j * S.nx + i]) continue;
        const d = (i - oi) ** 2 + (j - oj) ** 2;
        if (d < bd) { bd = d; best = [i, j]; }
      }
    }
    if (best) { snapped = Math.hypot(best[0] - oi, best[1] - oj) * S.step; [oi, oj] = best; }
  }
  const ok = oj * S.nx + oi;
  const zo = S.ground[ok] + eye;
  out.observer = [S.x0 + (oi + .5) * S.step, S.y0 + (oj + .5) * S.step];
  out.snapped = snapped;
  for (let j = 0; j < S.ny; j++) for (let i = 0; i < S.nx; i++) {
    const dxm = (i - oi) * S.step, dym = (j - oj) * S.step, dist = Math.hypot(dxm, dym);
    if (dist > maxDist) continue;
    if (dist < S.step * 1.5) { out[j * S.nx + i] = 1; continue; }
    // sample every third of a cell along the ray (whole-cell sampling let rays leak through
    // diagonal gaps, drawing long straight lines across the sheet); skip the observer's and
    // the target's own cells
    const n = Math.ceil(dist / S.step * 3);
    const tk = j * S.nx + i;
    const target = S.bld[tk] ? S.top[tk] : S.ground[tk] + targetH;
    let visible = true;
    // "thick" ray (0.6 cell): a 1-cell ray on an exact diagonal passed between the cells of
    // staircase-rasterised walls and drew a corner-to-corner line through the observer
    outer: for (let s = 1; s < n; s++) {
      const f = s / n;
      const fx = oi + .5 + (i - oi) * f, fy = oj + .5 + (j - oj) * f;
      const zRay = zo + (target - zo) * f;
      for (const [ex, ey] of [[-.3, -.3], [.3, -.3], [-.3, .3], [.3, .3]]) {
        const xi = Math.floor(fx + ex), yj = Math.floor(fy + ey);
        if (xi < 0 || yj < 0 || xi >= S.nx || yj >= S.ny) continue;
        if ((xi === i && yj === j) || (xi === oi && yj === oj)) continue;
        if (S.top[yj * S.nx + xi] > zRay + 0.05) { visible = false; break outer; }
      }
    }
    out[j * S.nx + i] = visible ? 1 : 0;
  }
  return out;
}

// ---- grid -> merged run rectangles (one ring per horizontal run of equal class) ----------------------------
export function runRects(S, classOf, nClasses) {
  const out = Array.from({ length: nClasses }, () => []);
  for (let j = 0; j < S.ny; j++) {
    let i = 0;
    while (i < S.nx) {
      const c = classOf(j * S.nx + i);
      let e = i + 1;
      while (e < S.nx && classOf(j * S.nx + e) === c) e++;
      if (c >= 0) {
        const xa = S.x0 + i * S.step, xb = S.x0 + e * S.step, ya = S.y0 + j * S.step, yb = ya + S.step;
        out[c].push([[xa, ya], [xb, ya], [xb, yb], [xa, yb]]);
      }
      i = e;
    }
  }
  return out;
}

// ---- climate ----------------------------------------------------------------------------------------------------
export function nearestStation(climate, lat, lon) {
  let best = null;
  for (const s of climate.stations) {
    const dLat = (s.lat - lat) * RAD, dLon = (s.lon - lon) * RAD;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * RAD) * Math.cos(s.lat * RAD) * Math.sin(dLon / 2) ** 2;
    const km = 6371 * 2 * Math.asin(Math.sqrt(a));
    if (!best || km < best.km) best = { station: s, km };
  }
  return best;
}

// Single-time shadow mask: 1 = ground cell in shadow, 0 = sunlit, 2 = building cell (not evaluated).
export function shadowMask(S, az, alt) {
  const out = new Uint8Array(S.nx * S.ny);
  const dx = Math.sin(az), dy = Math.cos(az), tan = Math.tan(alt);
  for (let j = 0; j < S.ny; j++) for (let i = 0; i < S.nx; i++) {
    const k = j * S.nx + i;
    if (S.bld[k]) { out[k] = 2; continue; }
    const z0 = S.top[k] + 0.5;
    for (let t = S.step; t <= 400; t += S.step) {
      const xi = Math.floor(i + .5 + dx * t / S.step), yj = Math.floor(j + .5 + dy * t / S.step);
      if (xi < 0 || yj < 0 || xi >= S.nx || yj >= S.ny) break;
      if (S.top[yj * S.nx + xi] > z0 + t * tan) { out[k] = 1; break; }
    }
  }
  return out;
}
