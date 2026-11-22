// Card 14 transit data. Inside Île-de-France: official Île-de-France Mobilités open data
// (Opendatasoft v2.1, CORS enabled). Elsewhere (or if IDFM is unreachable): OpenStreetMap via Overpass.
// Verified 2026-11-13:
//   traces-des-lignes-de-transport-en-commun-idfm  (licence ODbL, version française)
//     fields route_short_name, route_type (Bus/Tram/Subway/Rail/CableWay/Funicular), route_color (hex, no #), id_ilico, shape (geo_shape, WGS84)
//   arrets                                          (Licence Ouverte v2.0 Etalab)
//     fields arrname, arrtype (bus/tram/metro/rail/cableway), arrxepsg2154, arryepsg2154, arrgeopoint
//   referentiel-des-lignes                          (ODbL) id_line, colourweb_hexa (colour fallback)
import { toL93, toWGS84, fetchOsmTransit } from "./ign.js?v=20261122i";
import { clipLineRect } from "./dganalysis.js?v=20261113p";

const IDFM = "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/";
export const IDFM_SOURCE = "© Île-de-France Mobilités — tracés et référentiel des lignes (Licence ODbL), arrêts (Licence Ouverte v2.0 Etalab)";

// Rough Île-de-France bounding box (WGS84).
export const inIdf = (lon, lat) => lon > 1.4 && lon < 3.6 && lat > 48.1 && lat < 49.3;

const abortError = () => new DOMException("취소되었습니다.", "AbortError");

async function getJson(path, params, signal) {
  const ctl = new AbortController();
  const cancel = () => ctl.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const url = new URL(IDFM + path);
    url.search = new URLSearchParams(params).toString();
    const r = await fetch(url, { mode: "cors", signal: ctl.signal });
    if (!r.ok) throw new Error(`IDFM 요청 실패: HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (signal?.aborted) throw abortError();
    throw e.name === "AbortError" ? new Error("IDFM 응답 시간이 초과되었습니다.") : e;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}

async function paged(path, params, signal) {
  const out = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const r = await getJson(path, { ...params, limit: 100, offset }, signal);
    out.push(...(r.results || []));
    if (out.length >= r.total_count || !(r.results || []).length) break;
  }
  return out;
}

const MODE = { Bus: "bus", Tram: "tram", Subway: "subway", Rail: "train", CableWay: "monorail", Funicular: "monorail" };
const STOP = { bus: "bus", tram: "tram", metro: "subway", rail: "rail", cableway: "rail" };

export async function fetchTransit(extent, center, signal, progress = () => {}) {
  const [lon, lat] = toWGS84(center[0], center[1]);
  if (!inIdf(lon, lat)) {
    const d = await fetchOsmTransit(extent, signal, progress);
    return { ...d, source: "osm" };
  }
  try {
    progress("IDFM 대중교통 조회 중");
    const half = Math.max(extent[2] - extent[0], extent[3] - extent[1]) / 2;
    const R = Math.ceil(half * 1.42 + 20);
    const geo = `geom'POINT(${lon.toFixed(6)} ${lat.toFixed(6)})', ${R}m`;
    const [lines, stops] = await Promise.all([
      paged("traces-des-lignes-de-transport-en-commun-idfm/records",
        { where: `within_distance(shape, ${geo})`, select: "route_id,route_short_name,route_type,route_color,id_ilico,shape" }, signal),
      paged("arrets/records",
        { where: `within_distance(arrgeopoint, ${geo})`, select: "arrname,arrtype,arrxepsg2154,arryepsg2154" }, signal)
    ]);
    // colour fallback from the official line referential
    const missing = lines.filter(l => !l.route_color && l.id_ilico).map(l => l.id_ilico);
    const refColour = {};
    if (missing.length) {
      try {
        const ref = await paged("referentiel-des-lignes/records",
          { where: `id_line in (${[...new Set(missing)].map(x => `"${x}"`).join(",")})`, select: "id_line,colourweb_hexa" }, signal);
        for (const r of ref) if (r.colourweb_hexa) refColour[r.id_line] = r.colourweb_hexa;
      } catch (e) { if (signal?.aborted) throw e; }
    }
    const routes = lines.map(l => {
      const g = l.shape?.geometry;
      const raw = g ? (g.type === "MultiLineString" ? g.coordinates : g.type === "LineString" ? [g.coordinates] : []) : [];
      const pieces = raw.flatMap(ln => clipLineRect(ln.map(([x, y]) => toL93(x, y)), extent));
      const hex = l.route_color || refColour[l.id_ilico] || null;
      return {
        ref: l.route_short_name || null, mode: MODE[l.route_type] || "bus",
        colour: hex ? "#" + String(hex).replace("#", "") : null, name: l.route_short_name || null, lines: pieces
      };
    }).filter(r => r.lines.length);
    const pts = stops.filter(s => s.arrxepsg2154 != null && s.arryepsg2154 != null)
      .map(s => ({ p: [s.arrxepsg2154, s.arryepsg2154], kind: STOP[s.arrtype] || "bus", name: s.arrname || null }))
      .filter(s => s.p[0] >= extent[0] && s.p[0] <= extent[2] && s.p[1] >= extent[1] && s.p[1] <= extent[3]);
    return { stops: pts, routes, source: "idfm" };
  } catch (e) {
    if (e.name === "AbortError" && signal?.aborted) throw e;
    progress("IDFM 조회 실패 · OSM 데이터로 대체");
    const d = await fetchOsmTransit(extent, signal, progress);
    return { ...d, source: "osm", fallbackReason: e.message };
  }
}
