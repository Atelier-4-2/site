// Card 10 tree data. Official Opendatasoft v2.1 open data (exports endpoint: one request, no 10 000-row
// paging cap, CORS enabled) where it exists, OpenStreetMap (Overpass) only as the last fallback.
// Verified 2026-11-13:
//   opendata.hauts-de-seine.fr  cadastre-vert-les-arbres  (Licence Ouverte / Etalab)
//       diametre (crown m, 0 = unknown), circonference (cm), type (I isolated / A alignment), geo_point_2d
//   opendata.hauts-de-seine.fr  arbres-dalignement-sur-la-voirie-departementale  (Licence Ouverte / Etalab)
//       genre, hauteur (m), circonference (cm), geo_point_2d
//   opendata.paris.fr           les-arbres  (ODbL)
//       genre, libellefrancais, circonferenceencm, hauteurenm, domanialite, geo_point_2d
import { toL93, toWGS84, fetchOsmTrees } from "./ign.js?v=20261123f";

const H92 = "https://opendata.hauts-de-seine.fr/api/explore/v2.1/catalog/datasets/";
const PARIS = "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/";
// coverage boxes (lon0, lat0, lon1, lat1), generous
const BOX92 = [2.13, 48.72, 2.35, 48.995];
const BOXPARIS = [2.22, 48.81, 2.47, 48.91];

const hits = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

async function exportJson(base, ds, params, signal) {
  const ctl = new AbortController();
  const cancel = () => ctl.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const url = new URL(`${base}${ds}/exports/json`);
    url.search = new URLSearchParams(params).toString();
    const r = await fetch(url, { mode: "cors", signal: ctl.signal });
    if (!r.ok) throw new Error(`수목 데이터 요청 실패: HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error("수목 데이터 응답 형식이 올바르지 않습니다.");
    return j;
  } catch (e) {
    if (signal?.aborted) throw new DOMException("취소되었습니다.", "AbortError");
    throw e.name === "AbortError" ? new Error("수목 데이터 응답 시간이 초과되었습니다.") : e;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}

// crown diameter (m) from a trunk circumference (cm) when the dataset has no crown width
const crownFromCirc = c => c > 0 ? Math.max(3, Math.min(14, 2 + 12 * (c / Math.PI / 100))) : 4;

export async function fetchTrees(extent, center, signal, progress = () => {}) {
  const [lon, lat] = toWGS84(center[0], center[1]);
  const corners = [[extent[0], extent[1]], [extent[2], extent[3]]].map(p => toWGS84(p[0], p[1]));
  const wb = [Math.min(corners[0][0], corners[1][0]), Math.min(corners[0][1], corners[1][1]), Math.max(corners[0][0], corners[1][0]), Math.max(corners[0][1], corners[1][1])];
  const use92 = hits(wb, BOX92), usePar = hits(wb, BOXPARIS);
  if (!use92 && !usePar) {
    const d = await fetchOsmTrees(extent, signal, progress);
    return { points: d.points, rows: d.rows, crowns: [], src: "osm", sources: ["© OpenStreetMap contributors (ODbL), Overpass API"] };
  }
  progress("수목 데이터 조회 중");
  const R = Math.ceil(Math.max(extent[2] - extent[0], extent[3] - extent[1]) / 2 * 1.42 + 20);
  const where = `within_distance(geo_point_2d, geom'POINT(${lon.toFixed(6)} ${lat.toFixed(6)})', ${R}m)`;
  const jobs = [];
  if (use92) {
    jobs.push(["cv", exportJson(H92, "cadastre-vert-les-arbres", { where, select: "diametre,circonference,type,geo_point_2d" }, signal)]);
    jobs.push(["al", exportJson(H92, "arbres-dalignement-sur-la-voirie-departementale", { where, select: "genre,hauteur,circonference,geo_point_2d" }, signal)]);
  }
  if (usePar) jobs.push(["pa", exportJson(PARIS, "les-arbres", { where, select: "genre,libellefrancais,circonferenceencm,hauteurenm,domanialite,geo_point_2d" }, signal)]);
  const settled = await Promise.allSettled(jobs.map(j => j[1]));
  const got = {}, failed = [];
  settled.forEach((s, i) => { if (s.status === "fulfilled") got[jobs[i][0]] = s.value; else if (signal?.aborted) throw s.reason; else failed.push(s.reason.message); });
  if (!Object.keys(got).length) {
    progress("수목 데이터 조회 실패 · OSM 데이터로 대체");
    const d = await fetchOsmTrees(extent, signal, progress);
    return { points: d.points, rows: d.rows, crowns: [], src: "osm", fallbackReason: failed[0], sources: ["© OpenStreetMap contributors (ODbL), Overpass API"] };
  }

  const crowns = [];
  const inside = p => p[0] >= extent[0] && p[0] <= extent[2] && p[1] >= extent[1] && p[1] <= extent[3];
  const add = (g, o) => { if (!g) return; const p = toL93(g.lon, g.lat); if (inside(p)) crowns.push({ p, ...o }); };
  let estimated = 0;
  for (const t of got.cv || []) {
    const known = t.diametre > 0;
    if (!known) estimated++;
    add(t.geo_point_2d, { d: known ? t.diametre : crownFromCirc(t.circonference), kind: t.type === "A" ? "A" : "I", h: null, est: !known, src: "cv" });
  }
  // dedupe the departmental alignment trees against the cadastre vert (~1 m): keep one tree, merge the height
  const cell = new Map();
  const key = p => Math.floor(p[0]) + "_" + Math.floor(p[1]);
  crowns.forEach((c, i) => { const k = key(c.p); if (!cell.has(k)) cell.set(k, []); cell.get(k).push(i); });
  const near = p => {
    const x = Math.floor(p[0]), y = Math.floor(p[1]);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
      for (const i of cell.get((x + dx) + "_" + (y + dy)) || []) if (Math.hypot(crowns[i].p[0] - p[0], crowns[i].p[1] - p[1]) <= 1) return i;
    return -1;
  };
  let merged = 0;
  for (const t of got.al || []) {
    if (!t.geo_point_2d) continue;
    const p = toL93(t.geo_point_2d.lon, t.geo_point_2d.lat);
    if (!inside(p)) continue;
    const i = near(p);
    if (i >= 0) { crowns[i].kind = "A"; if (t.hauteur > 0) crowns[i].h = t.hauteur; merged++; continue; }
    estimated++;
    crowns.push({ p, d: crownFromCirc(t.circonference), kind: "A", h: t.hauteur > 0 ? t.hauteur : null, est: true, src: "al" });
  }
  for (const t of got.pa || []) {
    estimated++;
    add(t.geo_point_2d, { d: crownFromCirc(t.circonferenceencm), kind: /align/i.test(t.domanialite || "") ? "A" : "I", h: t.hauteurenm > 0 ? t.hauteurenm : null, est: true, src: "pa" });
  }
  const sources = [];
  if (got.cv || got.al) sources.push("Département des Hauts-de-Seine — Cadastre vert (arbres) et arbres d'alignement des routes départementales (Licence Ouverte / Etalab)");
  if (got.pa) sources.push("Ville de Paris — Les arbres (Licence ODbL)");
  return { points: [], rows: [], crowns, src: "od", estimated, merged, failed, sources };
}
