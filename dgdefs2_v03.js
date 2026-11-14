import { semanticPalette, STOP_COLOUR, ISO_ALPHA } from "./dgsemantic.js?v=20261114t1";
// Diagram cards 06-08, 10-12, 14-16, 21, 25, 27 (vector data only). Merged into
// the registry by dgdefs.js. Data colours are resolved by dgsemantic.js.
import { ringArea, clipRingRect, circleRing, mix } from "./dgcore.js?v=20261113s";
import { IDFM_SOURCE } from "./dgtransit.js?v=20261113p";
import { blocksFromRoads, choiceBetweenness, streetDH, labelPoint, heightOf, heightEstimated, clipLineRect } from "./dganalysis.js?v=20261113p";

const UNK = "정보 없음";
const lw = (opt, v) => v * (opt.lw || 1);
const P = opt => semanticPalette(opt.pal);
const polyItems = (bs, style) => bs.map(b => ({ k: "poly", rings: [b.polygon, ...b.holes], ...style(b), bld: b }));
// With `ext` the rings are clipped to the sheet extent (+2 % so the cut edge stays outside
// the visible frame). GPU SUP/PLU polygons can span a whole region (one sheet-11 DXF was
// 24 MB of vertices hundreds of km away); polygons already inside the extent are untouched.
function clipRings(rings, ext) {
  const [x0, y0, x1, y1] = ext, m = Math.max(x1 - x0, y1 - y0) * .02;
  const X0 = x0 - m, Y0 = y0 - m, X1 = x1 + m, Y1 = y1 + m;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const [x, y] of rings[0]) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
  if (bx1 < X0 || bx0 > X1 || by1 < Y0 || by0 > Y1) return null;            // entirely outside
  if (bx0 >= X0 && bx1 <= X1 && by0 >= Y0 && by1 <= Y1) return rings;         // entirely inside
  const outer = clipRingRect(rings[0], X0, Y0, X1, Y1);
  if (outer.length < 3) return null;
  return [outer, ...rings.slice(1).map(h => clipRingRect(h, X0, Y0, X1, Y1)).filter(h => h.length > 2)];
}
const featPolys = (fs, style, ext) => fs.flatMap(f => f.polygons.flatMap(r0 => {
  const rings = ext ? clipRings(r0, ext) : r0;
  return rings ? [{ k: "poly", rings, ...style(f) }] : [];
}));
const featLines = (fs, style) => fs.flatMap(f => f.lines.map(pts => ({ k: "line", pts, ...style(f) })));
const SITE = { kind: "site", label: "대지 경계" };
const ctxBuildings = (opt, data) => ({
  id: "context", name: "주변 건물",
  items: polyItems(data.buildings || [], () => ({ fill: P(opt).building, stroke: P(opt).buildingLine, sw: lw(opt, .06), context: true }))
});
const ctxLegend = opt => ({ kind: "fill", fill: P(opt).building, stroke: P(opt).buildingLine, sw: .06, label: "주변 건물" });
const unknownStyle = (opt, w = .18) =>
  ({ fill: P(opt).bg, stroke: P(opt).edge, sw: lw(opt, w), dash: "0.9 0.7" });
const lvl = m => Math.round(m / 3);
const SIM = "참고용 시뮬레이션 · 법적 효력 없음";

// ---- 06 / 07 high-rise, low-rise ---------------------------------------------------
function heightThreshold(high) {
  return {
    param: high
      ? { label: "고층 기준 높이 (m)", def: 28, min: 6, max: 300, step: 1 }
      : { label: "저층 기준 높이 (m)", def: 9, min: 3, max: 100, step: 1 },
    needs: ["buildings"],
    build(ctx, data, opt) {
      const pal = P(opt);
      const T = Number(opt.param) > 0 ? Number(opt.param) : (high ? 28 : 9);
      const hit = [], rest = [], unk = [];
      let est = 0;
      for (const b of data.buildings) {
        const h = heightOf(b);
        if (h == null) { unk.push(b); continue; }
        if (heightEstimated(b)) est++;
        (high ? h >= T : h < T) ? hit.push(b) : rest.push(b);
      }
      const hi = high ? pal.high : pal.low;
      const word = high ? `${T} m 이상 (≈ ${lvl(T)}층 이상)` : `${T} m 미만 (≈ ${lvl(T)}층 미만)`;
      const other = high ? `${T} m 미만` : `${T} m 이상`;
      return {
        layers: [
          { id: "other", name: other, items: polyItems(rest, () => ({ fill: pal.building, stroke: pal.buildingLine, sw: lw(opt, .08), context: true })) },
          { id: "unknown", name: UNK, items: polyItems(unk, () => unknownStyle(opt)) },
          { id: high ? "high" : "low", name: word, items: polyItems(hit, () => ({ fill: hi, stroke: pal.buildingLine, sw: lw(opt, .12) })) }
        ],
        legend: [
          { kind: "fill", fill: hi, stroke: pal.buildingLine, sw: .12, label: word, count: hit.length },
          { kind: "fill", fill: pal.building, stroke: pal.buildingLine, sw: .08, label: other, count: rest.length },
          { kind: "fill", fill: pal.bg, stroke: pal.edge, dash: "0.9 0.7", label: UNK, count: unk.length }, SITE],
        notes: [`기준 높이 ${T} m는 층고 3 m 기준 약 ${lvl(T)}층에 해당합니다. 높이: BD TOPO hauteur(m).`,
          est ? `높이 정보가 없는 ${est}개 동은 (층수+1) × 3 m로 추정 산정했습니다.` : "", `높이 정보가 없는 ${unk.length}개 동은 ${UNK}으로 표기했습니다.`].filter(Boolean)
      };
    }
  };
}

// ---- 08 PLU zoning --------------------------------------------------------------------
const ZONE_TYPES = [
  { code: "U", label: "U · 시가화구역" }, { code: "AU", label: "AU · 개발예정구역" },
  { code: "A", label: "A · 농업구역" }, { code: "N", label: "N · 자연·보전구역" }
];

function pluSheet(ctx, data, opt) {
  const pal = P(opt);
  const [x0, y0, x1, y1] = ctx.extent;
  // CNIG typezone values carry sub-types (AUc, AUs, Nh, Ah, Ua ...): reduce to U / AU / A / N
  const norm = t => /^AU/.test(t) ? "AU" : t.slice(0, 1);
  const colOf = t => { const i = ZONE_TYPES.findIndex(z => z.code === norm(t)); return i < 0 ? 4 : i; };
  const layers = [], legend = [];
  const classes = [...ZONE_TYPES, { code: "?", label: `${UNK} (구역 미분류)` }];
  const labels = [];
  classes.forEach((c, ci) => {
    const fs = data.plu.filter(f => colOf(String(f.props.typezone || "").toUpperCase()) === ci);
    const col = ci === 4 ? null : pal.zoning[ci];
    layers.push({
      id: `plu_${c.code === "?" ? "unk" : c.code.toLowerCase()}`, name: c.label,
      items: featPolys(fs, () => col
        ? { fill: col + "59", stroke: col, sw: lw(opt, .3) }
        : { ...unknownStyle(opt) }, ctx.extent)
    });
    legend.push({ kind: "fill", fill: col ? col + "59" : pal.bg, stroke: col || pal.edge, dash: col ? null : "0.9 0.7", label: c.label, count: fs.length });
    for (const f of fs) for (const rings of f.polygons) {
      const clipped = clipRingRect(rings[0], x0, y0, x1, y1);
      if (clipped.length < 3 || ringArea(clipped) < (x1 - x0) * (y1 - y0) * 0.004) continue;
      const lp = labelPoint(clipped);
      if (lp && f.props.libelle) labels.push({ k: "text", p: lp.p, text: String(f.props.libelle), size: 2.6, fill: pal.text, halo: pal.bg, hm: 4 });
    }
  });
  layers.push({ id: "plu_code", name: "구역 코드", items: labels });
  legend.push(SITE);
  const docs = [...new Set(data.plu.map(f => f.props.idurba).filter(Boolean))];
  return {
    layers: [ctxBuildings(opt, data), ...layers], legend,
    notes: [data.plu.length
      ? `GPU(Géoportail de l'Urbanisme) zone_urba 기준으로 표시됩니다. 관련 문서: ${docs.slice(0, 2).join(", ")}. 구역 코드(libelle)는 다이어그램에 표기되어 있으며, 상세 규정은 관할 PLU 조례를 확인하세요. ${SIM}`
      : "해당 범위에 GPU 등록 PLU 구역이 없습니다 (RNU 적용 또는 미등록 지역). " + SIM],
    sources: ["GPU — Géoportail de l'Urbanisme, wfs_du:zone_urba"]
  };
}

// ---- 11 SUP / protected perimeters -------------------------------------------------------
const SUP_CLASSES = [
  { id: "ac1_abords", code: "ac1", test: f => f.props.typeass !== "Monument historique", label: "AC1 · 역사기념물 주변 보호구역 (abords)", ci: 0, outline: true },
  { id: "ac1_mh", code: "ac1", test: f => f.props.typeass === "Monument historique", label: "AC1 · 역사기념물 (monument)", ci: 0 },
  { id: "ac2", code: "ac2", label: "AC2 · 지정 경관지 (sites)", ci: 1 },
  { id: "ac4", code: "ac4", label: "AC4 · 문화유산 보호지구 (SPR/AVAP)", ci: 2 },
  { id: "i4", code: "i4", label: "I4 · 전력 시설 보호구역", ci: 3 },
  { id: "pm1", code: "pm1", label: "PM1 · 위험예방계획 (PPR)", ci: 4 },
  { id: "other", code: "*", label: "기타 SUP (EL3·T1 등)", ci: 5 }
];

function supSheet(ctx, data, opt) {
  const pal = P(opt);
  const known = new Set(SUP_CLASSES.map(c => c.code));
  const layers = [], legend = [], labels = [], inside = new Set();
  const labeled = new Set();
  const [x0, y0, x1, y1] = ctx.extent;
  const [cx, cy] = ctx.center;
  const inRingPt = (r, x, y) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  for (const c of SUP_CLASSES) {
    const fs = data.sup.filter(f => {
      const t = String(f.props.suptype || "").toLowerCase().replace(/^spr$/, "ac4");
      if (c.code === "*") return !known.has(t);
      return t === c.code && (!c.test || c.test(f));
    });
    if (!fs.length) continue;
    const col = pal.protection[c.ci];
    const dash = c.outline ? "2 1.4" : c.code === "ac2" ? "0.6 0.8" : null;
    layers.push({
      id: `sup_${c.id}`, name: c.label,
      items: featPolys(fs, () => ({
        fill: col + "59", stroke: col, sw: lw(opt, .38), dash
      }), ctx.extent)
    });
    const code = c.label.split(" · ")[0];
    let largest = null;
    for (const f of fs) for (const rings of f.polygons) {
      if (inRingPt(rings[0], cx, cy) && !rings.slice(1).some(h => inRingPt(h, cx, cy))) inside.add(code);
      const r = clipRingRect(rings[0], x0, y0, x1, y1);
      const area = Math.abs(ringArea(r));
      if (r.length >= 3 && area >= (x1 - x0) * (y1 - y0) * .015 && (!largest || area > largest.area)) {
        largest = { r, area, holes: rings.slice(1) };
      }
    }
    if (largest && !labeled.has(code)) {
      const lp = labelPoint(largest.r);
      const gap = Math.min(x1 - x0, y1 - y0) * .075;
      if (lp && Math.hypot(lp.p[0] - cx, lp.p[1] - cy) > gap &&
          !largest.holes.some(h => inRingPt(h, ...lp.p)) &&
          labels.every(l => Math.hypot(lp.p[0] - l.p[0], lp.p[1] - l.p[1]) > gap)) {
        labels.push({ k: "text", p: lp.p, text: code, size: 3.4, fill: col, halo: pal.bg, hm: 4 });
        labeled.add(code);
      }
    }
    legend.push({ kind: "fill", fill: col + "59", stroke: col,
      sw: .35, dash, label: c.label, count: fs.length });
  }
  legend.push(ctxLegend(opt), SITE);
  const mh = data.sup.filter(f => String(f.props.suptype).toLowerCase() === "ac1").length;
  const context = ctxBuildings(opt, data);
  for (const item of context.items) { item.cardStroke = true; item.sw = lw(opt, .1); }
  return {
    layers: [...layers, context, { id: "sup_code", name: "지구 코드", items: labels }], legend,
    notes: [inside.size ? `대지 중심이 ${[...inside].join(" · ")} 구역 안에 있습니다.` : "",
      data.sup.length
      ? "GPU에 등록된 SUP 면형입니다. 분석 범위보다 넓은 구역은 경계 일부가 다이어그램 밖에 있습니다."
      : "해당 범위에 GPU 등록 SUP(공공유용지역지구) 면형 데이터가 없습니다 (점·선형 SUP 및 미등록 지구 제외).",
      mh ? `AC1 ${mh}건` : ""].filter(Boolean),
    sources: ["GPU — Géoportail de l'Urbanisme, wfs_sup:assiette_sup_s"]
  };
}

// ---- 14 transit --------------------------------------------------------------------------
const NAMED = { red: "#e32119", blue: "#0055c8", green: "#2e8b2e", yellow: "#f2c400", orange: "#f08a00", purple: "#7b2e8e", brown: "#8b5a2b", black: "#222222", grey: "#808080", gray: "#808080", pink: "#e75b9b", darkblue: "#00008b", lightblue: "#5bb8e8", darkgreen: "#006400", cyan: "#00b5c8", magenta: "#c8008f" };
function osmColour(c) {
  if (!c) return null;
  let s = String(c).trim().toLowerCase();
  if (NAMED[s]) return NAMED[s];
  if (/^#[0-9a-f]{3}$/.test(s)) s = "#" + [...s.slice(1)].map(ch => ch + ch).join("");
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}
const MODES = [
  ["bus", "버스", .3], ["trolleybus", "트롤리버스", .3], ["tram", "트램", .6],
  ["light_rail", "경전철", .7], ["subway", "지하철", .8], ["train", "철도·RER", .9], ["monorail", "케이블카·푸니쿨라", .7]
];

function transitSheet(ctx, data, opt) {
  const pal = P(opt);
  const fallback = { bus: pal.cat6[2], trolleybus: pal.cat6[2], tram: pal.cat6[1], light_rail: pal.cat6[1], subway: pal.cat6[0], train: pal.cat6[3], monorail: pal.cat6[4] };
  const routeLayers = [], legend = [];
  let unknownColour = 0;
  for (const [mode, label, w] of MODES) {
    const rs = data.transit.routes.filter(r => r.mode === mode && r.lines.length);
    if (!rs.length) continue;
    const items = [];
    for (const r of rs) {
      const c = osmColour(r.colour);
      if (!c) unknownColour++;
      for (const pts of r.lines) items.push({ k: "line", pts, stroke: c || fallback[mode], sw: lw(opt, w) });
    }
    routeLayers.push({ id: `route_${mode}`, name: label, items });
    legend.push({ kind: "line", stroke: fallback[mode], sw: Math.max(w, .3), label: `${label} 노선`, count: rs.length });
  }
  const stopKind = [["bus", "버스 정류장"], ["tram", "트램 정류장"], ["rail", "철도·RER 역"], ["subway", data.transit.source === "idfm" ? "지하철역" : "지하철 출입구"]];
  const stopItems = [];
  for (const [k, label] of stopKind) {
    const ss = data.transit.stops.filter(s => s.kind === k);
    if (!ss.length) continue;
    const col = STOP_COLOUR;
    stopItems.push({
      id: `stop_${k}`, name: label,
      items: ss.map(s => ({ k: "dot", p: s.p, r: k === "bus" ? 4 : 7, fill: pal.bg, stroke: col, sw: lw(opt, .3) }))
    });
    legend.push({ kind: "dot", fill: pal.bg, stroke: col, sw: .3, label, count: ss.length });
  }
  const [cx, cy] = ctx.center;
  const rings = {
    id: "walk_rings", name: "도보권 300·500 m",
    items: [300, 500].map(r => ({ k: "poly", rings: [circleRing(cx, cy, r, 128)], fill: "none", stroke: pal.edge, sw: lw(opt, .2), dash: "1.6 1.1" }))
  };
  legend.push({ kind: "line", stroke: pal.edge, sw: .2, dash: "1.6 1.1", label: "대지 중심 300 m / 500 m" }, ctxLegend(opt), SITE);
  const nRoutes = data.transit.routes.length;
  const idfm = data.transit.source === "idfm";
  return {
    layers: [ctxBuildings(opt, data), rings, ...routeLayers, ...stopItems], legend,
    notes: (idfm
      ? ["Île-de-France Mobilités(IDFM) 공식 개방 데이터의 노선 경로 및 정류장입니다. 노선 색상은 공식 route_color를 따르며, 미지정 노선은 교통수단별 기본 색상으로 표시됩니다."]
      : ["OpenStreetMap(Overpass) 대중교통 노선 및 정류장입니다. 노선 색상은 OSM colour 태그를 따르며, 미지정 노선은 교통수단별 기본 색상으로 표시됩니다.",
        data.transit.fallbackReason ? `IDFM 조회 실패(${data.transit.fallbackReason})로 OSM 데이터로 대체했습니다.` : ""]).concat([
      unknownColour ? `색상 정보가 없는 노선 ${unknownColour}개 (기본 색상 적용)` : "",
      nRoutes ? "" : (idfm ? "해당 범위에서 IDFM 대중교통 노선이 확인되지 않았습니다." : "해당 범위에서 OSM 대중교통 노선이 확인되지 않았습니다."),
      idfm ? "" : "OSM은 오픈 협업 지도 데이터이므로 일부 누락이 있을 수 있습니다.", SIM]).filter(Boolean),
    sources: [idfm ? IDFM_SOURCE : "© OpenStreetMap contributors (ODbL), Overpass API"]
  };
}

// Display-only Chaikin smoothing. Source rings and building geometry stay immutable.
function smoothRing(ring) {
  let points = ring.map(p => p.slice());
  if (points.length > 1 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]) points.pop();
  if (points.length < 3) return ring.map(p => p.slice());
  for (let pass = 0; pass < 2; pass++) {
    points = points.flatMap((a, i) => {
      const b = points[(i + 1) % points.length];
      return [[.75 * a[0] + .25 * b[0], .75 * a[1] + .25 * b[1]],
        [.25 * a[0] + .75 * b[0], .25 * a[1] + .75 * b[1]]];
    });
  }
  return points;
}

// ---- 21 plot size --------------------------------------------------------------------------
const PLOTS = [
  { id: "p1", label: "200 m² 미만", test: a => a < 200 }, { id: "p2", label: "200–500 m²", test: a => a < 500 },
  { id: "p3", label: "500–1,000 m²", test: a => a < 1000 }, { id: "p4", label: "1,000–5,000 m²", test: a => a < 5000 },
  { id: "p5", label: "5,000 m² 이상", test: () => true }
];

// ---- 25 / 27 helpers ---------------------------------------------------------------------------
function quantileClasses(vals, n) {
  const s = vals.filter(v => v > 0).sort((a, b) => a - b);
  const cuts = [];
  for (let i = 1; i < n; i++) cuts.push(s.length ? s[Math.min(s.length - 1, Math.floor(s.length * i / n))] : 0);
  return cuts;
}

export const IMPL2 = {
  "06": heightThreshold(true),
  "07": heightThreshold(false),
  "08": { needs: ["plu", "buildings"], build: pluSheet },
  "10": {
    needs: ["trees", "buildings"],
    build(ctx, data, opt) {
      const pal = P(opt);
      const T = data.trees, od = T.src === "od";
      const isoFill = pal.tree, isoLine = pal.treeRow;
      const alFill = pal.treeRow, alLine = pal.treeRow;
      const iso = (T.crowns || []).filter(c => c.kind !== "A"), ali = (T.crowns || []).filter(c => c.kind === "A");
      const dots = (cs, fill, line) => cs.flatMap(c => [
        { k: "dot", p: c.p, r: Math.max(1.2, c.d / 2), fill, stroke: line, sw: lw(opt, .1), op: .75 },
        { k: "dot", p: c.p, r: .5, fill: line, stroke: "none", op: .75 }]);
      const osmFill = pal.tree, osmLine = pal.treeRow;
      const layers = [ctxBuildings(opt, data)], legend = [];
      if (od) {
        layers.push({ id: "trees_isolated", name: "독립수 (수관)", items: dots(iso, isoFill, isoLine) },
          { id: "trees_alignment", name: "가로수 (수관)", items: dots(ali, alFill, alLine) });
        legend.push({ kind: "dot", fill: isoFill, stroke: isoLine, sw: .1, label: "독립수 · 수관 폭 비례 표시", count: iso.length },
          { kind: "dot", fill: alFill, stroke: alLine, sw: .1, label: "가로수", count: ali.length });
      } else {
        layers.push({ id: "tree_rows", name: "가로수 열", items: T.rows.map(pts => ({ k: "line", pts, stroke: osmLine, sw: lw(opt, .3), dash: "0.8 0.8", op: .75 })) },
          { id: "trees", name: "수목", items: T.points.map(p => ({ k: "dot", p, r: 2.6, fill: osmFill, stroke: osmLine, sw: lw(opt, .1), op: .75 })) });
        legend.push({ kind: "dot", fill: osmFill, stroke: osmLine, sw: .1, label: "수목 (OSM natural=tree, 수관 폭 4 m 기준)", count: T.points.length },
          { kind: "line", stroke: osmLine, sw: .3, dash: "0.8 0.8", label: "가로수 열 (tree_row)", count: T.rows.length });
      }
      legend.push(ctxLegend(opt), SITE);
      const n = od ? T.crowns.length : T.points.length;
      return {
        layers, legend,
        notes: [od
          ? `공식 개방 데이터의 개별 수목 ${n}주입니다. 수관 폭은 데이터의 diametre(미기재 시 줄기 둘레로 추정, ${T.estimated}주 추정, 기본값 4 m) 기준이며, 가로수와 독립수를 색상으로 구분했습니다.`
          : "해당 지역은 공식 수목 데이터가 제공되지 않아(IGN BD TOPO는 식생 면만 제공) OpenStreetMap natural=tree 데이터를 활용했습니다. 등록된 수목만 표시되므로 실제 식생 현황과 다를 수 있습니다.",
          T.merged ? `도로 가로수 데이터와 중복되는 ${T.merged}주는 1주로 통합했습니다.` : "",
          T.fallbackReason ? `공식 데이터 조회 실패(${T.fallbackReason})로 OSM 데이터로 대체했습니다.` : "",
          T.failed?.length ? `일부 데이터 조회 실패: ${T.failed.join(" / ")}` : "",
          n ? "" : "해당 범위에 등록된 수목 데이터가 없습니다.", SIM].filter(Boolean),
        sources: T.sources
      };
    }
  },
  "11": { needs: ["sup", "buildings"], build: supSheet },
  "12": {
    needs: ["er", "buildings"],
    build(ctx, data, opt) {
      const pal = P(opt);
      const col = pal.planned;
      const surf = data.er.filter(f => f.kind === "surf"), lin = data.er.filter(f => f.kind === "lin"), pct = data.er.filter(f => f.kind === "pct");
      return {
        layers: [ctxBuildings(opt, data),
          { id: "er_surface", name: "예정부지 (면)", items: featPolys(surf, () => ({ fill: col, stroke: col, sw: lw(opt, .3), op: .55 }), ctx.extent) },
          { id: "er_line", name: "예정부지 (선)", items: featLines(lin, () => ({ stroke: col, sw: lw(opt, .9) })) },
          { id: "er_point", name: "예정부지 (점)", items: pct.flatMap(f => (f.points || []).map(p => ({ k: "dot", p, r: 5, fill: col, stroke: pal.bg, sw: lw(opt, .2) }))) }],
        legend: [{ kind: "fill", fill: col, stroke: col, sw: .3, label: "도시계획 예정부지 (면)", count: surf.length },
          { kind: "line", stroke: col, sw: .9, label: "도시계획 예정부지 (선)", count: lin.length },
          { kind: "dot", fill: col, stroke: pal.bg, label: "도시계획 예정부지 (점)", count: pct.length },
          ctxLegend(opt), SITE],
        notes: [data.er.length
          ? "GPU PLU 지정사항 중 공공시설 예정부지(typepsc=05, emplacements réservés)입니다. 사업 주체 및 목적은 PLU 부속 문서를 확인하세요."
          : "해당 범위에 GPU 등록 공공시설 예정부지(emplacement réservé)가 없습니다 (PLU 미등록 포함)."],
        sources: ["GPU — Géoportail de l'Urbanisme, wfs_du:prescription_surf/lin/pct (typepsc 05)"]
      };
    }
  },
  "14": { needs: ["transit", "buildings"], build: transitSheet },
  "15": {
    needs: ["iso", "buildings"],
    build(ctx, data, opt) {
      const pal = P(opt);
      const order = [...data.iso].sort((a, b) => b.min - a.min); // largest first (painted underneath)
      const fills = Object.fromEntries([5, 10, 15].map(m => [m, pal.isochrone + ISO_ALPHA[m]]));
      const line = pal.isochrone;
      return {
        layers: [...order.map(z => ({
          id: `iso_${z.min}`, name: `도보 ${z.min}분`,
          items: z.polygons.map(rings => ({ k: "poly", rings: rings.map(smoothRing), fill: fills[z.min] || fills[15], stroke: line, sw: lw(opt, .4), dash: "1.8 1.2" }))
        })), ctxBuildings(opt, data)],
        legend: [...[5, 10, 15].map(m => ({ kind: "fill", fill: fills[m], stroke: line, sw: .4, dash: "1.8 1.2", label: `도보 ${m}분 (약 ${Math.round(m * 80)} m 보행)` })),
          ctxLegend(opt), SITE],
        notes: ["IGN 경로 서비스(isochrone, bdtopo-valhalla, 보행)로 대지 중심에서 산출한 보행 등시간권입니다. 다이어그램 범위를 벗어나는 영역은 생략될 수 있습니다.",
          "보행 속도 및 도로망 모델은 기본값 기준이며, 지형 경사나 횡단 대기 시간은 반영되지 않습니다. " + SIM],
        sources: ["IGN Géoplateforme — navigation/isochrone (bdtopo-valhalla)"]
      };
    }
  },
  "16": {
    needs: ["roadsWide", "buildings"],
    build(ctx, data, opt) {
      const pal = P(opt);
      const [ex0, ey0, ex1, ey1] = ctx.extent;
      // computed on the buffered road network, then cut to the sheet so legend / DXF only hold what is drawn
      const faces = blocksFromRoads(data.roadsWide, 80)
        .map(r => clipRingRect(r, ex0, ey0, ex1, ey1)).filter(r => r.length > 2);
      const fill = pal.blocks + "D9";
      return {
        layers: [{ id: "blocks", name: "블록", items: faces.map(r => ({ k: "poly", rings: [r], fill, stroke: "#FFFFFF", sw: lw(opt, 1) })) },
          { id: "bati_line", name: "건물", items: polyItems(data.buildings, () => ({ fill: pal.building, stroke: pal.buildingLine, sw: lw(opt, .06), context: true })) }],
        legend: [{ kind: "fill", fill, stroke: "#FFFFFF", sw: 1, label: "도시 가구 (블록)", count: faces.length },
          { kind: "fill", fill: pal.building, stroke: pal.buildingLine, sw: .06, label: "건물" }, SITE],
        notes: ["도로 중심선으로 구획된 가구(블록) 영역입니다 (보행로·계단·자전거도로 및 미소 블록 제외). 도로 폭은 반영되지 않습니다. " + SIM],
        sources: ["IGN BD TOPO® V3 troncon_de_route"]
      };
    }
  },
  "21": {
    needs: ["parcels", "buildings"],
    build(ctx, data, opt) {
      const pal = P(opt);
      const cols = pal.plot;
      const area = f => f.polygons.reduce((s, rings) => s + ringArea(rings[0]) - rings.slice(1).reduce((t, h) => t + ringArea(h), 0), 0);
      const buckets = PLOTS.map(() => []);
      for (const f of data.parcels) buckets[PLOTS.findIndex(c => c.test(area(f)))].push(f);
      return {
        layers: [ctxBuildings(opt, data), ...PLOTS.map((c, i) => ({
          id: c.id, name: c.label,
          items: featPolys(buckets[i], () => ({ fill: cols[i], stroke: pal.edge, sw: lw(opt, .12), op: .9 }), ctx.extent)
        })), { id: "bati_line", name: "건물 윤곽", items: polyItems(data.buildings, () => ({ fill: "none", stroke: pal.buildingLine, sw: lw(opt, .06) })) }],
        legend: [...PLOTS.map((c, i) => ({ kind: "fill", fill: cols[i], stroke: pal.edge, sw: .12, label: c.label, count: buckets[i].length })), ctxLegend(opt), SITE],
        notes: ["필지 규모별 단계 구분입니다 (다이어그램 내 면적 수치 생략). 필지: IGN Parcellaire Express (PCI) · 참고용 도면 · 법적 효력 없음"],
        sources: ["CADASTRALPARCELS.PARCELLAIRE_EXPRESS"]
      };
    }
  },
  "25": {
    needs: ["roadsWide", "buildings"],
    build(ctx, data, opt) {
      const pal = P(opt);
      const CUT = 500;
      const ext = ctx.extent;
      const m = 100; // origins: sheet + 100 m margin; routes may use the whole 500 m buffer network
      const all = choiceBetweenness(data.roadsWide, CUT, [ext[0] - m, ext[1] - m, ext[2] + m, ext[3] + m]);
      // keep only the parts of segments that fall inside the sheet, then take quantiles on those
      const scores = all.map(s => ({ ...s, pieces: clipLineRect(s.edge.pts, ext) })).filter(s => s.pieces.length);
      const cuts = quantileClasses(scores.map(s => s.score), 5);
      const cls = v => v <= 0 ? -1 : cuts.findIndex(c => v < c) < 0 ? 4 : Math.max(0, cuts.findIndex(c => v < c));
      const W = [.25, .4, .65, 1, 2.5];
      const buckets = [[], [], [], [], []], zero = [];
      for (const s of scores) {
        const c = cls(s.score);
        if (c < 0) zero.push(s); else buckets[c].push(s);
      }
      const lines = es => es.flatMap(s => s.pieces.map(pts => ({ k: "line", pts })));
      return {
        layers: [ctxBuildings(opt, data),
          { id: "choice_0", name: "통과 경로 없음", items: lines(zero).map(i => ({ ...i, stroke: pal.roadLine, sw: lw(opt, .15) })) },
          ...buckets.map((es, i) => ({
            id: `choice_${i + 1}`, name: `선택도 ${i + 1}단계`,
            items: lines(es).map(it => ({ ...it, stroke: pal.syntax[i], sw: lw(opt, W[i]) }))
          }))],
        legend: [...[0, 1, 2, 3, 4].map(i => ({
          kind: "line", stroke: pal.syntax[i], sw: W[i], label: i === 0 ? "선택도 낮음" : i === 4 ? "선택도 높음" : `선택도 ${i + 1}단계`, count: buckets[i].length
        })), { kind: "line", stroke: pal.roadLine, sw: .15, label: "통과 경로 없음", count: zero.length }, ctxLegend(opt), SITE],
        notes: [`가로 선택도(Space Syntax Choice): 도로망 네트워크 내 최단 경로 통과 빈도(반경 ${CUT} m 기준 매개중심성)입니다. 다이어그램 외곽 ${CUT} m 완충 구역 도로도 계산에 반영했습니다.`,
          "5단계 구분은 분위수 기준이며, 각도(angular) 기준이 아닌 최단 거리 기준 분석값입니다. " + SIM],
        sources: ["IGN BD TOPO® V3 troncon_de_route"]
      };
    }
  },
  "27": {
    needs: ["roads", "buildings"],
    build(ctx, data, opt) {
      const pal = P(opt);
      const segs = streetDH(data.roads, data.buildings, heightOf);
      const CL = [
        { id: "r1", label: "D/H 0.5 미만 (협소·고층)", test: r => r < .5 }, { id: "r2", label: "0.5–1", test: r => r < 1 },
        { id: "r3", label: "1–1.5", test: r => r < 1.5 }, { id: "r4", label: "1.5–2.5", test: r => r < 2.5 },
        { id: "r5", label: "2.5 이상 (광폭·저층)", test: () => true }];
      const cols = [...pal.dh].reverse();
      const W = [1.3, 1.1, .9, .7, .5];
      const b = CL.map(() => []), unk = [];
      for (const s of segs) (s.ratio == null ? unk : b[CL.findIndex(c => c.test(s.ratio))]).push(s);
      return {
        layers: [ctxBuildings(opt, data),
          { id: "dh_unknown", name: UNK, items: unk.map(s => ({ k: "line", pts: s.pts, stroke: pal.edge, sw: lw(opt, .2), dash: "0.9 0.7" })) },
          ...CL.map((c, i) => ({ id: c.id, name: c.label, items: b[i].map(s => ({ k: "line", pts: s.pts, stroke: cols[i], sw: lw(opt, W[i]), cap: "butt" })) }))],
        legend: [...CL.map((c, i) => ({ kind: "line", stroke: cols[i], sw: W[i], label: c.label, count: b[i].length })),
          { kind: "line", stroke: pal.edge, sw: .2, dash: "0.9 0.7", label: `${UNK} (도로 폭 또는 인접 건물 높이 정보 없음)`, count: unk.length },
          ctxLegend(opt), SITE],
        notes: ["D = BD TOPO largeur_de_chaussee(차도 폭, 보도 제외), H = 양측 최근접 건물(40 m 이내) 높이의 중앙값입니다. 보도·식재대를 포함한 건축선 간 거리보다 D/H 수치가 낮게 산출될 수 있습니다.",
          "건물 높이는 hauteur(미기재 시 (층수+1) × 3 m 추정) 기준이며, 폭 또는 높이 정보가 없으면 " + UNK + "입니다. " + SIM],
        sources: ["IGN BD TOPO® V3 troncon_de_route, batiment"]
      };
    }
  }
};
