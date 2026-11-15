import { semanticPalette } from "./dgsemantic_v02.js?v=20261115a";
// Rhino .3dm export for the site diagrams (rhino3dm 8.35.0, already loaded by index.html).
// Units m. The model origin is the SITE CENTRE (Lambert-93 coordinates are ~6.8e6 m north and Rhino loses
// precision that far from the origin); the shift is stored in the document UserText and on every object.
// One parent layer per diagram ("NN 제목"), the diagram layers below it; no hatches or fills.
import { ExtrudeGeometry, Shape, Path, Vector2 } from "three";
import { prepareSheet, stdWeight } from "./dgexport_v03.js?v=20261115a";
import { demAt } from "./dgenv_v02.js?v=20261115a";
import { heightOf } from "./dganalysis.js?v=20261113p";

const RHINO_BASE = "https://cdn.jsdelivr.net/npm/rhino3dm@8.35.0/";
let rhinoP = null;
export function loadRhino() {
  if (!rhinoP) {
    if (typeof globalThis.rhino3dm !== "function") return Promise.reject(new Error("3DM 파일 도구를 불러오지 못했습니다. 네트워크를 확인하세요."));
    rhinoP = globalThis.rhino3dm({ locateFile: f => RHINO_BASE + f }).catch(e => { rhinoP = null; throw e; });
  }
  return rhinoP;
}

// ---- 3D volumes (same geometry as the A1 tab: extruded footprints + DEM terrain), z up ---------------
const volCache = new WeakMap();
export function volumeData(ctx, data) {
  const hit = volCache.get(data.buildings);
  if (hit && hit.ctx === ctx) return hit.v;
  const [cx, cy] = ctx.center;
  const baseZ = demAt(data.dem, cx, cy);
  const buildings = [];
  for (const b of data.buildings) {
    try {
    const shape = new Shape(b.polygon.map(p => new Vector2(p[0] - cx, p[1] - cy)));
    for (const hole of b.holes) shape.holes.push(new Path(hole.map(p => new Vector2(p[0] - cx, p[1] - cy))));
    let gmin = Infinity, gmax = -Infinity;
    for (const p of b.polygon) { const z = demAt(data.dem, p[0], p[1]); gmin = Math.min(gmin, z); gmax = Math.max(gmax, z); }
    const hk = heightOf(b), h = hk == null ? 3 : hk;
    const geo = new ExtrudeGeometry(shape, { depth: h + (gmax - gmin), bevelEnabled: false });
    const pos = geo.attributes.position.array.slice();
    for (let i = 2; i < pos.length; i += 3) pos[i] += gmin - baseZ;
    buildings.push({ pos, b, h, known: hk != null });
    geo.dispose();
    } catch { /* skip a footprint three.js cannot triangulate */ }
  }
  const [x0, y0, x1, y1] = ctx.extent;
  const nx = data.dem ? data.dem.nx : 2, ny = data.dem ? data.dem.ny : 2;
  const tpos = new Float32Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = x0 + (x1 - x0) * i / (nx - 1), y = y0 + (y1 - y0) * j / (ny - 1), k = (j * nx + i) * 3;
    tpos[k] = x - cx; tpos[k + 1] = y - cy; tpos[k + 2] = demAt(data.dem, x, y) - baseZ - 0.05;
  }
  const v = { buildings, terrain: { nx, ny, pos: tpos }, baseZ };
  volCache.set(data.buildings, { ctx, v });
  return v;
}

// ---- Rhino helpers ----------------------------------------------------------------------------------------
const rgb = hex => { const s = hex.replace("#", ""); return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16), a: 255 }; };

// jobs: [{ def, sheet, ctx, pal, data, volumes:boolean, origin?:[x,y], volCtx?, extra? }] -> Uint8Array (.3dm)
// opts.origin = model origin in source coordinates (default: centre of the first ctx = site centre).
// A job with its own `origin` is a drawing in local coordinates (A5 section / A8 projection), not Lambert-93.
export async function build3dm(jobs, { title = "Terrain", origin = null, custom = false } = {}) {
  const rh = await loadRhino();
  const doc = new rh.File3dm();
  const del = [];
  try {
    const ctx0 = jobs[0].ctx;
    const unit = ctx0.paperMm ? "mm" : "m";
    const [offE, offN] = (origin || ctx0.center).map(v => Math.round(v * 1000) / 1000);
    const [x0, y0, x1, y1] = ctx0.extent;
    const mpm = ctx0.paperMm ? 1 : Math.max(x1 - x0, y1 - y0) / 255;
    doc.settings().modelUnitSystem = ctx0.paperMm ? rh.UnitSystem.Millimeters : rh.UnitSystem.Meters;
    doc.applicationName = "Terrain";
    const note = `Terrain 대지 다이어그램 · ${ctx0.address} · ${ctx0.radiusLabel} · 조회일 ${ctx0.date}\n` +
      (custom
        ? `도면 좌표(${unit}). 모델 원점 = 도면 범위 중심: 원래 좌표 = 모델 좌표 + (x ${offE}, y ${offN}).\n`
        : `좌표계 RGF93 / Lambert-93 (EPSG:2154), 단위 m. 모델 원점 = 대지 중심: 원래 좌표 = 모델 좌표 + (E ${offE}, N ${offN}).\n`) +
      "데이터 © IGN 등. 참고용 도면이며 법적 효력이 없습니다.";
    doc.startSectionComments = note;
    const S = doc.strings();
    S.set("title", title); S.set("units", unit);
    if (custom) { S.set("crs", "drawing coordinates"); S.set("drawing_offset_x", String(offE)); S.set("drawing_offset_y", String(offN)); }
    else { S.set("crs", "EPSG:2154"); S.set("L93_offset_E", String(offE)); S.set("L93_offset_N", String(offN)); }
    S.set("address", ctx0.address || ""); S.set("date", ctx0.date); S.set("notes", note);

    // one dashed linetype (document level); layers that are dashed in the sheet use it
    const dash = new rh.Linetype(); dash.name = "Terrain Dashed";
    dash.appendSegment(1.2 * mpm, true); dash.appendSegment(0.8 * mpm, false);
    doc.linetypes().add(dash); del.push(dash);
    const dashIdx = doc.linetypes().count - 1;

    const layers = doc.layers();
    const addLayer = (name, color, { parent = null, sw = 0, dashed = false } = {}) => {
      const L = new rh.Layer();
      L.name = name; L.color = rgb(color);
      if (parent) L.parentLayerId = parent.id;
      if (sw) L.plotWeight = sw;
      if (dashed) L.linetypeIndex = dashIdx;
      layers.add(L); del.push(L);
      const idx = layers.count - 1;
      return { idx, id: layers.get(idx).id };
    };
    const mkAttr = (layerIdx, name, kv) => {
      const a = new rh.ObjectAttributes();
      a.layerIndex = layerIdx;
      if (name) a.name = String(name).slice(0, 200);
      for (const [k, v] of Object.entries(kv)) if (v != null && v !== "") a.setUserString(k, String(v));
      del.push(a);
      return a;
    };
    const objs = doc.objects();
    const addPoly = (pts, closed, attr, shift) => {
      const pl = new rh.Polyline(pts.length + (closed ? 1 : 0));
      for (const p of pts) { const [a, b] = shift(p); pl.add(a, b, 0); }
      if (closed) { const [a, b] = shift(pts[0]); pl.add(a, b, 0); }
      const pc = pl.toPolylineCurve();
      objs.addCurve(pc, attr);
      pc.delete(); pl.delete();
    };

    // the shared 3D layers (3D_건물, 3D_지형) come first in the layer list
    const vj = jobs.find(j => j.volumes && j.data);
    if (vj) addVolumes(rh, doc, vj, { addLayer, mkAttr, offE, offN, pal: vj.pal });
    for (const job of jobs) {
      const { def, sheet, ctx, pal } = job;
      const P = prepareSheet(def, sheet, ctx, pal);
      const parentName = `${def.num} ${def.ko || def.fr}`;
      const parent = addLayer(parentName, pal.text);
      const jo = (job.origin || origin || ctx.center).map(v => Math.round(v * 1000) / 1000);
      const shift = ([x, y]) => [x - jo[0], y - jo[1]];
      const local = custom || !!job.origin;
      const common = { sheet: def.num, ...(local ? { drawing_offset_x: jo[0], drawing_offset_y: jo[1] } : { L93_offset_E: jo[0], L93_offset_N: jo[1] }) };
      const byCad = new Map();
      for (const L of P.layers) {
        const lay = addLayer(L.name, L.color, { parent, sw: L.sw, dashed: !!L.dash });
        byCad.set(L.cad, lay);
        for (const it of L.items) {
          const kv = { ...common, layer: L.id };
          if (it.k === "poly") {
            if (it.bld) Object.assign(kv, { building_id: it.bld.id, height_m: it.bld.h, floors: it.bld.floors, usage: it.bld.usage, usage2: it.bld.usage2, nature: it.bld.nature, year: it.bld.year });
            const a = mkAttr(lay.idx, L.name, kv);
            for (const r of it.rings) {
              const pts = r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r;
              if (pts.length >= 3) addPoly(pts, true, a, shift);
            }
          } else if (it.k === "line") {
            addPoly(it.pts, false, mkAttr(lay.idx, L.name, kv), shift);
          } else if (it.k === "dot") {
            const [a, b] = shift(it.p);
            const size = { [`radius_${unit}`]: Math.round(it.r * 100) / 100 };
            objs.addPointXYZ(a, b, 0, mkAttr(lay.idx, L.name, { ...kv, ...size }));
          }
        }
      }
      // labels / title block / legend text as text dots
      const textLayer = {};
      const need = (key, name) => (textLayer[key] ||= addLayer(name, pal.text, { parent }));
      for (const t of P.texts) {
        const lay = t.layer === "LEGEND" ? byCad.get("LEGEND") : t.layer === "TITLE" ? need("TITLE", "제목·출처") : need("TEXT", "라벨");
        const [a, b] = shift(t.p);
        const size = { [`height_${unit}`]: Math.round(t.h * 100) / 100 };
        objs.addTextDot(t.text, [a, b, 0], mkAttr(lay.idx, t.role, { ...common, role: t.role, ...size }));
      }
      // 3D volumes (A1 / A8 / all-in-one file): same meshes as the A1 tab
    }
    const bytes = doc.toByteArray();
    return new Uint8Array(bytes);   // copy out of the wasm heap
  } finally {
    for (const o of del) { try { o.delete(); } catch { /* ignore */ } }
    doc.delete();
  }
}

// ---- 3D layers: 3D_건물, 3D_지형 (top level, shared by all sheets of one file) ---------------------------------
const volumeLayers = new WeakMap();
function addVolumes(rh, doc, job, { addLayer, mkAttr, offE, offN, pal }) {
  if (volumeLayers.has(doc)) return;
  volumeLayers.set(doc, true);
  const V = volumeData(job.volCtx || job.ctx, job.data);
  const bl = addLayer("3D_건물", pal.building);
  const tl = addLayer("3D_지형", semanticPalette(pal).green);
  const common = { L93_offset_E: offE, L93_offset_N: offN, NGF_ground_z_at_centre: Math.round(V.baseZ * 100) / 100 };
  for (const { pos, b, h, known } of V.buildings) {
    const m = new rh.Mesh();
    const vs = m.vertices();
    for (let i = 0; i < pos.length; i += 3) vs.add(pos[i], pos[i + 1], pos[i + 2]);
    const f = m.faces();
    for (let i = 0; i < pos.length / 3; i += 3) f.addTriFace(i, i + 1, i + 2);
    vs.combineIdentical(true, true);
    m.normals().computeNormals(); m.compact();
    const a = mkAttr(bl.idx, "건물", { ...common, building_id: b.id, height_m: h, height_known: known ? "yes" : "no (3 m assumed)", floors: b.floors, usage: b.usage, usage2: b.usage2, nature: b.nature, year: b.year });
    doc.objects().addMesh(m, a);
    m.delete();
  }
  const T = V.terrain, tm = new rh.Mesh();
  for (let i = 0; i < T.pos.length; i += 3) tm.vertices().add(T.pos[i], T.pos[i + 1], T.pos[i + 2]);
  for (let j = 0; j < T.ny - 1; j++) for (let i = 0; i < T.nx - 1; i++) {
    const a = j * T.nx + i;
    tm.faces().addQuadFace(a, a + 1, a + T.nx + 1, a + T.nx);
  }
  tm.normals().computeNormals(); tm.compact();
  doc.objects().addMesh(tm, mkAttr(tl.idx, "지형", { ...common, source: "IGN RGE ALTI" }));
  tm.delete();
}
