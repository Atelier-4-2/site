import { semanticPalette, ROAD_COLOURS, ROAD_WIDTHS } from "./dgsemantic.js?v=20261113s";
// Diagram registry. One entry per plate; the 28 reference slots are all listed,
// those without `build` are shown as "준비 중" cards and plug in later:
//   { num, fr, en, needs:[dataKeys], color, build(ctx, data, opt) -> sheet }
// sheet = { layers:[{id,name,items}], legend:[], notes:[], sources:[] }
// opt   = { mono:boolean, color:hex|null, lw:number (line-weight multiplier) }
import { ringArea, clipRingRect } from "./dgcore.js?v=20261113s";
import { bands, gaussian } from "./dgcontour.js?v=20261113b";
import { IMPL2 } from "./dgdefs2_v03.js?v=20261114m1";
import { IMPL3 } from "./dgdefs3_v03.js?v=20261113cards2";
import { KO } from "./dgstrings.js?v=20261114m1";
import { heightOf, heightEstimated } from "./dganalysis.js?v=20261113p";

const UNK = "정보 없음";

// ---- helpers ----------------------------------------------------------------
// Base tokens and diagram-specific semantic colours are resolved separately.
const lw = (opt, v) => v * (opt.lw || 1);
const P = opt => semanticPalette(opt.pal);

function polyItems(buildings, style) {
  return buildings.map(b => ({ k: "poly", rings: [b.polygon, ...b.holes], ...style(b), bld: b }));
}

function featPolys(features, style) {
  const out = [];
  for (const f of features) for (const rings of f.polygons) out.push({ k: "poly", rings, ...style(f) });
  return out;
}

function featLines(features, style) {
  const out = [];
  for (const f of features) for (const pts of f.lines) out.push({ k: "line", pts, ...style(f) });
  return out;
}

const context = (opt, data) => ({
  id: "context", name: "주변 건물",
  items: polyItems(data.buildings || [], () => ({ fill: P(opt).building, stroke: P(opt).buildingLine, sw: lw(opt, .06), context: true }))
});

const unknownStyle = (opt, w = .18) =>
  ({ fill: P(opt).bg, stroke: P(opt).edge, sw: lw(opt, w), dash: "0.9 0.7" });

function classLayers(buildings, classify, classes, opt) {
  // classes: [{id,label,fill,unknown?}] ; classify(b) -> index into classes
  const buckets = classes.map(() => []);
  for (const b of buildings) buckets[classify(b)].push(b);
  const pal = P(opt);
  const layers = classes.map((c, i) => ({
    id: c.id, name: c.label,
    items: polyItems(buckets[i], () => c.unknown
      ? unknownStyle(opt)
      : { fill: c.fill, stroke: pal.edge, sw: lw(opt, .12) })
  }));
  const legend = classes.map((c, i) => ({
    kind: "fill", fill: c.unknown ? pal.bg : c.fill, stroke: pal.edge,
    dash: c.unknown ? "0.9 0.7" : null, label: c.label, count: buckets[i].length
  }));
  return { layers, legend };
}

// ---- 03 Usage ---------------------------------------------------------------
const USAGE = [
  { id: "res", label: "주거", match: ["Résidentiel", "Residentiel"] },
  { id: "com", label: "상업·서비스", match: ["Commercial et services"] },
  { id: "off", label: "업무", match: ["Bureau", "Bureaux", "Bureaux et services"] },
  { id: "pub", label: "공공·교육", match: ["Religieux", "Sportif", "Administratif", "Enseignement", "Sanitaire", "Culture"] },
  { id: "ind", label: "산업·농업", match: ["Industriel", "Agricole"] },
  { id: "other", label: "기타", match: ["Annexe", "Autre"] },
  { id: "unk", label: UNK + " (용도 미분류)", unknown: true }
];
const NATURE_PUBLIC = /eglise|chapelle|cathedrale|temple|mosquee|synagogue|monument|arc de triomphe|tribune|chateau|mairie|gare|musee|prefecture|palais|hotel de ville|gendarmerie|caserne|piscine|stade|hopital|ecole|lycee|college|universite|bibliotheque|theatre|cinema|tribunal|prison/i;
const plain = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const NATURE_INDUSTRIAL = /silo|serre|reservoir|agricole|industriel|hangar|usine|eolienne|centrale|chateau d'eau|batiment technique/i;

function usageClass(b) {
  // Public/religious natures win over a generic usage such as "Commercial et services".
  if (b.nature && NATURE_PUBLIC.test(plain(b.nature))) return 3;
  const u = b.usage;
  if (u) {
    const i = USAGE.findIndex(c => c.match && c.match.includes(u));
    if (i >= 0) return i;
  }
  if (b.usage2) {      // usage_1 missing or generic: fall back to the secondary usage
    const j = USAGE.findIndex(c => c.match && c.match.includes(b.usage2));
    if (j >= 0) return j;
  }
  if (b.nature && NATURE_INDUSTRIAL.test(plain(b.nature))) return 4;
  return 6;
}

// ---- 04 Year ----------------------------------------------------------------
const ERAS = [
  { id: "y1914", label: "~1914", test: y => y <= 1914 },
  { id: "y1945", label: "1915–1945", test: y => y <= 1945 },
  { id: "y1975", label: "1946–1975", test: y => y <= 1975 },
  { id: "y2000", label: "1976–2000", test: y => y <= 2000 },
  { id: "y2001", label: "2001~", test: () => true }
];

// ---- 05 Height --------------------------------------------------------------
const HEIGHTS = [
  { id: "h1", label: "6 m 미만", test: h => h < 6 },
  { id: "h2", label: "6–12 m", test: h => h < 12 },
  { id: "h3", label: "12–18 m", test: h => h < 18 },
  { id: "h4", label: "18–30 m", test: h => h < 30 },
  { id: "h5", label: "30 m 이상", test: () => true }
];

// ---- 13 Roads ---------------------------------------------------------------
const ROAD = {
  1: "1 · 광역 간선", 2: "2 · 주요 간선", 3: "3 · 간선",
  4: "4 · 집산 도로", 5: "5 · 국지 도로", 6: "6 · 이면·보행로"
};

// ---- registry -----------------------------------------------------------------
const SLOTS = [
  [1, "Orthophoto", "Aerial photo"], [2, "Bâti", "Buildings"], [3, "Usage", "Building use"],
  [4, "Date d'apparition", "Construction year (BD TOPO DB date)"], [5, "Hauteur", "Building height"],
  [6, "Bâtiments hauts", "High-rise"], [7, "Bâtiments bas", "Low-rise"],
  [8, "Zonage PLU", "PLU zoning"], [9, "Végétation et eau", "Green and water"],
  [10, "Arbres", "Trees"], [11, "Servitudes et protections", "Protected zones"],
  [12, "Emplacements réservés", "Planned sites"], [13, "Voirie", "Roads"],
  [14, "Transports en commun", "Public transport"], [15, "Isochrones piétons", "Walk isochrones"],
  [16, "Îlots", "Blocks"], [17, "Densité bâtie", "Built density"],
  [18, "Relief", "Terrain contours"], [19, "Pente", "Slope"], [20, "Cadastre", "Cadastre"],
  [21, "Taille des parcelles", "Plot size"], [22, "Ensoleillement", "Sun hours"],
  [23, "Ciel visible", "Sky view factor"], [24, "Rose des vents", "Wind rose"],
  [25, "Choix (Space Syntax)", "Syntactic choice"], [26, "Visibilité", "Viewshed"],
  [27, "Rapport D/H", "Street D/H"], [28, "Exposition", "Aspect"]
].map(([n, fr, en]) => {
  const num = String(n).padStart(2, "0");
  // `ko` is the displayed name; `fr`/`en` stay only as internal file-name slugs.
  return { num, fr, en, ko: KO.titles[num], theme: KO.themeOf[num], needs: [] };
});

const IMPL = {
  "01": {
    needs: ["ortho"],
    build(ctx, data, opt) {
      const [x0, y0, x1, y1] = ctx.extent;
      return {
        layers: [{ id: "ortho", name: "항공사진", items: [{ k: "image", href: data.ortho, bounds: [x0, y0, x1, y1] }] }],
        legend: [{ kind: "site", label: "대지 경계" }],
        notes: ["항공사진: IGN ORTHOIMAGERY.ORTHOPHOTOS (촬영 연도는 지역별로 상이합니다)."],
        sources: ["ORTHOIMAGERY.ORTHOPHOTOS"]
      };
    }
  },
  "02": {
    needs: ["buildings"],
    build(ctx, data, opt) {
      const pal = P(opt);
      return {
        layers: [{ id: "bati", name: "건물", items: polyItems(data.buildings, () => ({ fill: pal.figure, stroke: pal.figure, sw: lw(opt, .08) })) }],
        legend: [{ kind: "fill", fill: pal.figure, stroke: pal.figure, sw: .08, label: "건물 (피겨)", count: data.buildings.length },
          { kind: "fill", fill: pal.bg, stroke: pal.edge, sw: .15, label: "외부공간 (그라운드)" }, { kind: "site", label: "대지 경계" }],
        notes: ["놀리(Nolli)식 피겨-그라운드 도판입니다. 건물 외곽선은 IGN BD TOPO 데이터를 바탕으로 제작했습니다."]
      };
    }
  },
  "03": {
    needs: ["buildings"],
    build(ctx, data, opt) {
      const pal = P(opt);
      const classes = USAGE.map((c, i) => c.unknown ? c : { ...c, fill: pal.cat6[i] });
      const { layers, legend } = classLayers(data.buildings, usageClass, classes, opt);
      const unk = data.buildings.filter(b => usageClass(b) === 6).length;
      legend.push({ kind: "site", label: "대지 경계" });
      return {
        layers, legend,
        notes: [`건물 용도: BD TOPO usage_1(미기재 시 nature 항목으로 보완) 기준입니다. 판별 불가 ${unk}개 동은 ${UNK}으로 표기했습니다.`]
      };
    }
  },
  "04": {
    needs: ["buildings"],
    build(ctx, data, opt) {
      const cols = P(opt).year;
      const classes = [...ERAS.map((e, i) => ({ id: e.id, label: e.label, fill: cols[i] })),
        { id: "unk", label: UNK, unknown: true }];
      const { layers, legend } = classLayers(data.buildings,
        b => b.year == null ? 5 : ERAS.findIndex(e => e.test(b.year)), classes, opt);
      legend.push({ kind: "site", label: "대지 경계" });
      return {
        layers, legend,
        notes: ["건축 시기: BD TOPO DB 등록일(date_d_apparition) 기준이며 실제 준공 연도가 아닙니다. 1800·1900년 등 일괄 입력값이 포함되어 오래된 건축물은 신뢰도가 낮습니다."]
      };
    }
  },
  "05": {
    needs: ["buildings"],
    build(ctx, data, opt) {
      const cols = P(opt).height;
      let estimated = 0;
      const hOf = heightOf;
      for (const b of data.buildings) if (heightEstimated(b)) estimated++;
      const classes = [...HEIGHTS.map((e, i) => ({ id: e.id, label: e.label, fill: cols[i] })),
        { id: "unk", label: UNK, unknown: true }];
      const { layers, legend } = classLayers(data.buildings, b => {
        const h = hOf(b);
        return h == null ? 5 : HEIGHTS.findIndex(e => e.test(h));
      }, classes, opt);
      legend.push({ kind: "site", label: "대지 경계" });
      return {
        layers, legend,
        notes: ["높이: BD TOPO hauteur(m).", estimated ? `높이 정보가 없는 ${estimated}개 동은 (층수+1) × 3 m로 추정 산정했습니다.` : ""].filter(Boolean)
      };
    }
  },
  "09": {
    needs: ["veg", "waterS", "waterL", "buildings"],
    build(ctx, data, opt) {
      const pal = P(opt);
      const waterLine = pal.waterLine;
      const greenLine = pal.greenLine;
      const veg = featPolys(data.veg, () => ({ fill: "url(#PFXdots)", stroke: greenLine, sw: lw(opt, .12) }));
      const ws = featPolys(data.waterS, () => ({ fill: pal.water, stroke: waterLine, sw: lw(opt, .25) }));
      const wl = featLines(data.waterL, () => ({ stroke: waterLine, sw: lw(opt, .45) }));
      return {
        layers: [context(opt, data), { id: "vegetation", name: "녹지", items: veg },
          { id: "water_surface", name: "수면", items: ws }, { id: "water_line", name: "하천선", items: wl }],
        legend: [{ kind: "dots", stroke: greenLine, label: "녹지 (도트 패턴)", count: data.veg.length },
          { kind: "fill", fill: pal.water, stroke: waterLine, sw: .25, label: "수면", count: data.waterS.length },
          { kind: "line", stroke: waterLine, sw: .45, label: "하천·수로 선", count: data.waterL.length },
          { kind: "fill", fill: pal.building, stroke: pal.buildingLine, sw: .06, label: "주변 건물" }, { kind: "site", label: "대지 경계" }],
        notes: ["녹지: BD TOPO zone_de_vegetation, 수계: surface_hydrographique, troncon_hydrographique 기준입니다 (개별 가로수·수목 제외)."]
      };
    }
  },
  "13": {
    needs: ["roads"],
    build(ctx, data, opt) {
      const pal = P(opt);
      const layers = [], legend = [];
      for (const k of [1, 2, 3, 4, 5, 6]) {
        const fs = data.roads.filter(f => String(f.props.importance) === String(k));
        const label = ROAD[k];
        const col = ROAD_COLOURS[k - 1], w = ROAD_WIDTHS[k - 1];
        const walk = f => /Sentier|Escalier|Chemin/i.test(f.props.nature || "");
        layers.push({
          id: `road_${k}`, name: label,
          items: featLines(fs, f => ({ stroke: col, sw: lw(opt, w), dash: walk(f) && k >= 5 ? "1.2 0.9" : null }))
        });
        legend.push({ kind: "line", stroke: col, sw: lw(opt, w), label, count: fs.length });
      }
      const other = data.roads.filter(f => !ROAD[f.props.importance]);
      if (other.length) {
        layers.push({ id: "road_unk", name: UNK, items: featLines(other, () => ({ stroke: pal.edge, sw: lw(opt, .2), dash: "0.9 0.7" })) });
        legend.push({ kind: "line", stroke: pal.edge, sw: .2, dash: "0.9 0.7", label: UNK, count: other.length });
      }
      legend.push({ kind: "site", label: "대지 경계" });
      return {
        layers, legend,
        notes: ["도로 위계: BD TOPO troncon_de_route.importance(1 최고 – 6 최저) 기준입니다. 보행로와 계단은 점선으로 표시했습니다."]
      };
    }
  },
  "17": {
    needs: ["buildings"],
    build(ctx, data, opt) {
      const pal = P(opt);
      const CELL = 10;
      const [x0, y0, x1, y1] = ctx.extent;
      const nx = Math.ceil((x1 - x0) / CELL), ny = Math.ceil((y1 - y0) / CELL);
      const cover = new Float64Array(nx * ny);
      for (const b of data.buildings) {
        const all = [b.polygon, ...b.holes];
        const xs = b.polygon.map(p => p[0]), ys = b.polygon.map(p => p[1]);
        const ia = Math.max(0, Math.floor((Math.min(...xs) - x0) / CELL)), ib = Math.min(nx - 1, Math.floor((Math.max(...xs) - x0) / CELL));
        const ja = Math.max(0, Math.floor((Math.min(...ys) - y0) / CELL)), jb = Math.min(ny - 1, Math.floor((Math.max(...ys) - y0) / CELL));
        for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) {
          const cx0 = x0 + i * CELL, cy0 = y0 + j * CELL;
          let a = 0;
          all.forEach((r, k) => {
            const c = clipRingRect(r, cx0, cy0, cx0 + CELL, cy0 + CELL);
            if (c.length > 2) a += (k === 0 ? 1 : -1) * ringArea(c);
          });
          cover[j * nx + i] += Math.max(0, a);
        }
      }
      const BANDS = [
        { id: "d0", label: "0–10 %", max: .10 }, { id: "d1", label: "10–25 %", max: .25 },
        { id: "d2", label: "25–40 %", max: .40 }, { id: "d3", label: "40–60 %", max: .60 },
        { id: "d4", label: "60 % 이상", max: 9 }];
      const cols = pal.density;
      const density = gaussian(cover.map(a => Math.min(1, a / CELL ** 2)), nx, ny, 40 / CELL);
      const buckets = bands(density, nx, ny, x0, y0, CELL, [0, .10, .25, .40, .60]);
      return {
        layers: [...BANDS.map((b, k) => ({
          id: b.id, name: b.label,
          items: buckets[k].length ? [{ k: "poly", rings: buckets[k], fill: cols[k], stroke: "none" }] : []
        })), { id: "bati_line", name: "건물 외곽선", items: polyItems(data.buildings, () => ({ fill: "none", stroke: pal.edge, sw: lw(opt, .08) })) }],
        legend: [...BANDS.map((b, k) => ({ kind: "fill", fill: cols[k], stroke: pal.edge, sw: .1, label: `건폐율 ${b.label}` })),
          { kind: "site", label: "대지 경계" }],
        notes: ["건폐율 근사치 · 10 m 격자 · Gaussian σ 40 m"]
      };
    }
  },
  "20": {
    needs: ["parcels", "buildings"],
    build(ctx, data, opt) {
      const pal = P(opt);
      return {
        layers: [context(opt, data),
          { id: "parcels", name: "필지", items: featPolys(data.parcels, () => ({ fill: pal.parcel + "A6", stroke: "#FFFFFF", sw: lw(opt, .6) })) }],
        legend: [{ kind: "fill", fill: pal.parcel + "A6", stroke: "#FFFFFF", sw: .6, label: "필지 경계", count: data.parcels.length },
          { kind: "fill", fill: pal.building, stroke: pal.buildingLine, sw: .06, label: "주변 건물" }, { kind: "site", label: "대지 경계" }],
        notes: ["필지: IGN Parcellaire Express (PCI) 기준입니다. 지적 경계는 설계 참고용 도면이며 법적 측량 성과가 아닙니다."],
        sources: ["CADASTRALPARCELS.PARCELLAIRE_EXPRESS"]
      };
    }
  }
};

export const DIAGRAMS = SLOTS.map(s => ({ ...s, ...(IMPL[s.num] || IMPL2[s.num] || IMPL3[s.num] || {}) }));
export const isReady = d => typeof d.build === "function";
