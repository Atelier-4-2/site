import { semanticPalette } from "./dgsemantic_v02.js?v=20261116p";
// Diagram cards 18, 19, 22, 23, 24, 26, 28 (computed from terrain / buildings / climate).
// Every result is a reference simulation: "참고용 시뮬레이션, 법적 효력 없음".
import { heightOf } from "./dganalysis.js?v=20261113p";
import {
  contours, slopeAspect, makeSurface, sunHours, skyViewFactor, viewshed,
  nearestStation, KEY_DAYS
} from "./dgenv_v02.js?v=20261116n";
import { bands, contourRings, extendGround, gaussian } from "./dgcontour_v03.js?v=20261113cards2";
import { toWGS84 } from "./ign.js?v=20261122i";

const SIM = "참고용 시뮬레이션 · 법적 효력 없음";
const UNK = "정보 없음";
const lw = (opt, v) => v * (opt.lw || 1);
const P = opt => semanticPalette(opt.pal);
const SITE = { kind: "site", label: "대지 경계" };
const polyItems = (bs, style) => bs.map(b => ({ k: "poly", rings: [b.polygon, ...b.holes], ...style(b), bld: b }));
const ctxLayer = (opt, data) => ({
  id: "context", name: "건물",
  items: polyItems(data.buildings || [], () => ({ fill: P(opt).building, stroke: P(opt).buildingLine, sw: lw(opt, .06), context: true }))
});
// Ground-analysis sheets (22, 23, 28): buildings drawn solid so they read apart from shade bands.
const solidCtx = (opt, data) => ({
  id: "context", name: "건물",
  items: polyItems(data.buildings || [], () => ({ fill: P(opt).buildingLine, stroke: P(opt).buildingLine, sw: lw(opt, .06), context: true, cardStroke: true }))
});
// Mapped water above the ground bands of the sun / sky-view / aspect cards: a river is not ground
// to be scored (live review, GPT + Gemini).
const waterTop = (opt, data) => ({
  id: "water_top", name: "수면",
  items: (data.waterS || []).flatMap(f => f.polygons.map(rings => ({ k: "poly", rings, fill: P(opt).water, stroke: P(opt).waterLine, sw: lw(opt, .12), context: true, cardStroke: true })))
});
const waterLegend = (opt, data) => data.waterS?.length ? [{ kind: "fill", fill: P(opt).water, stroke: P(opt).waterLine, sw: .12, label: "수면" }] : [];
const solidLegend = opt => ({ kind: "fill", fill: P(opt).buildingLine, stroke: P(opt).buildingLine, sw: .06, label: "건물" });
const ctxLegend = opt => ({ kind: "fill", fill: P(opt).building, stroke: P(opt).buildingLine, sw: .06, label: "건물" });

// ---- shared surface (memoised per data set) ---------------------------------------------------
const memo = new WeakMap();
export function surfaceOf(ctx, data) {
  const hit = memo.get(data.buildings);
  if (hit && hit.dem === (data.dem || null)) return hit.S;
  const S = makeSurface(ctx.extent, data.buildings, data.dem || null);
  memo.set(data.buildings, { dem: data.dem || null, S });
  return S;
}
const surfNote = (S, data) => [
  `해석 격자 ${S.step} m, 건물 높이는 BD TOPO hauteur(미기재 시 (층수+1)×3 m, 정보 없음은 3 m 기본값${S.unknownHeight ? ` · ${S.unknownHeight}동` : ""}). 수목 차폐는 반영되지 않습니다.`,
  data.dem ? "지형: IGN RGE ALTI 수치표고모델(DEM)을 반영했습니다." : "지형 표고 데이터를 불러오지 못해 평지로 간주하고 계산했습니다.",
  SIM
];

function gridLayers(S, values, thresholds, classes, cols, name) {
  const rings = bands(values, S.nx, S.ny, S.x0, S.y0, S.step, thresholds);
  return classes.map((c, i) => ({
    id: `${name}_${i + 1}`, name: c,
    items: rings[i].length ? [{ k: "poly", rings: rings[i], fill: cols[i], stroke: "none" }] : []
  }));
}

function groundLayers(S, values, thresholds, classes, cols, name) {
  const field = gaussian(extendGround(values, S.nx, S.ny), S.nx, S.ny, 1);
  const levels = contourRings(field, S.nx, S.ny, S.x0, S.y0, S.step, thresholds);
  return classes.map((label, i) => ({
    id: `${name}_${i + 1}`, name: label,
    items: levels[i].length ? [{
      k: "poly", rings: levels[i].concat(levels[i + 1] || []),
      paintRings: levels[i], fill: cols[i], stroke: "none"
    }] : []
  }));
}

function maskLayers(S, classOf, classes, cols, name) {
  const labels = Array.from({ length: S.nx * S.ny }, (_, k) => classOf(k));
  return classes.flatMap((c, i) => gridLayers(S,
    labels.map(k => Number(k === i)), [.5], [c], [cols[i]], `${name}_${i + 1}`));
}

// DEM node grid treated as cells centred on the nodes.
const demCells = dem => ({ x0: dem.x0 - dem.dx / 2, y0: dem.y0 - dem.dx / 2, step: dem.dx, nx: dem.nx, ny: dem.ny });

// ---- 18 relief ---------------------------------------------------------------------------------
function relief(ctx, data, opt) {
  const pal = P(opt);
  const c = contours(data.dem);
  const idx = c.lines.filter(l => Math.round(l.level / c.interval) % 5 === 0);
  const std = c.lines.filter(l => Math.round(l.level / c.interval) % 5 !== 0);
  const line = pal.terrain[2];
  const step = (c.max - c.min || 1) / 5;
  const thresholds = Array.from({ length: 5 }, (_, i) => c.min + i * step);
  const classes = thresholds.map((v, i) => `${v.toFixed(1)}–${(c.min + (i + 1) * step).toFixed(1)} m`);
  const terrain = gridLayers(demCells(data.dem), data.dem.z, thresholds, classes, pal.terrain, "elevation");
  return {
    layers: [...terrain, ctxLayer(opt, data),
      { id: "contour", name: `주곡선 ${c.interval} m`, items: std.map(l => ({ k: "line", pts: l.pts, stroke: line, sw: lw(opt, .12) })) },
      { id: "contour_index", name: `계곡선 ${c.interval * 5} m`, items: idx.map(l => ({ k: "line", pts: l.pts, stroke: pal.terrain[4], sw: lw(opt, .32) })) },
      { id: "contour_labels", name: "계곡선 표고", items: idx.flatMap(l => {
        if (l.pts.length < 6) return [];
        const p = l.pts[Math.floor(l.pts.length / 2)];
        return [{ k: "text", p, text: `${Math.round(l.level * 10) / 10}`, size: 2.4, fill: pal.text, halo: pal.bg, hm: 3 }];
      }) }],
    legend: [...classes.map((label, i) => ({ kind: "fill", fill: pal.terrain[i], stroke: "none", label })),
      { kind: "line", stroke: line, sw: .12, label: `주곡선 ${c.interval} m`, count: std.length },
      { kind: "line", stroke: pal.terrain[4], sw: .32, label: `계곡선 ${c.interval * 5} m (표고 표기)`, count: idx.length },
      ctxLegend(opt), SITE],
    notes: [`표고 ${c.min.toFixed(1)}~${c.max.toFixed(1)} m (IGN RGE ALTI, ${data.dem.dx.toFixed(0)} m 격자 보간 등고선). 건물 하부는 자연 지표면 표고 기준입니다.`, SIM],
    sources: ["IGN RGE ALTI® — Géoplateforme altimetrie"]
  };
}

// ---- 19 slope / 28 aspect ------------------------------------------------------------------------
const SLOPES = [["2° 미만", 2], ["2–5°", 5], ["5–10°", 10], ["10–20°", 20], ["20° 이상", 90]];
function slopeSheet(ctx, data, opt) {
  const pal = P(opt), dem = data.dem, G = demCells(dem), { slope } = slopeAspect(dem);
  const layers = gridLayers(G, slope, [0, 2, 5, 10, 20], SLOPES.map(s => s[0]), pal.slope, "slope");
  return {
    layers: [...layers, ctxLayer(opt, data)],
    legend: [...SLOPES.map((s, i) => ({ kind: "fill", fill: pal.slope[i], stroke: pal.edge, sw: .1, label: s[0] })), ctxLegend(opt), SITE],
    notes: [`경사도: 수치표고모델(${dem.dx.toFixed(0)} m 격자) 중심차분법 산출 기준입니다 (옹벽·석축·계단 등 미세 지형 제외).`, SIM],
    sources: ["IGN RGE ALTI® — Géoplateforme altimetrie"]
  };
}

const DIRS8 = ["북 N", "북동 NE", "동 E", "남동 SE", "남 S", "남서 SW", "서 W", "북서 NW"];
function aspectSheet(ctx, data, opt) {
  const pal = P(opt), dem = data.dem, G = demCells(dem);
  const z = dem.z.map((value, k) => {
    if (!Number.isFinite(value)) return NaN;
    const x = k % dem.nx, y = Math.floor(k / dem.nx);
    let sum = 0, count = 0;
    for (let j = Math.max(0, y - 1); j <= Math.min(dem.ny - 1, y + 1); j++) {
      for (let i = Math.max(0, x - 1); i <= Math.min(dem.nx - 1, x + 1); i++) {
        const v = dem.z[j * dem.nx + i];
        if (Number.isFinite(v)) { sum += v; count++; }
      }
    }
    return sum / count;
  });
  const { aspect, slope } = slopeAspect({ ...dem, z });
  const cols = pal.aspect;
  const cls = k => Number.isFinite(aspect[k]) && slope[k] >= Math.atan(.03) * 180 / Math.PI
    ? Math.floor(((aspect[k] + 22.5) % 360) / 45) : -1;
  const layers = maskLayers(G, cls, DIRS8, cols, "aspect");
  let flat = 0, all = 0;
  for (let k = 0; k < slope.length; k++) if (Number.isFinite(z[k])) { all++; if (cls(k) < 0) flat++; }
  const flatPct = all ? Math.round(100 * flat / all) : 0;
  return {
    layers: [...layers, waterTop(opt, data), solidCtx(opt, data)],
    legend: [...DIRS8.map((n, i) => ({ kind: "compass", angle: i * 45, fill: cols[i], stroke: pal.edge, label: `${n} 향` })),
      { kind: "fill", fill: pal.bg, stroke: pal.edge, sw: .1, label: "평탄지(경사 3% 미만)" }, solidLegend(opt), ...waterLegend(opt, data), SITE],
    notes: ["경사향(Aspect) · DEM 3×3 평균 · 경사 3% 이상",
      ...(flatPct >= 70 ? [`분석 범위의 ${flatPct}%가 경사 3% 미만 평탄지라 향이 거의 표시되지 않습니다.`] : []), SIM],
    sources: ["IGN RGE ALTI® — Géoplateforme altimetrie"]
  };
}

// ---- 22 sun hours ----------------------------------------------------------------------------------
const SUN_DAYS = [KEY_DAYS[0], KEY_DAYS[1], KEY_DAYS[3]];
const SUN_CLASSES = ["20 % 미만", "20–40 %", "40–60 %", "60–80 %", "80 % 이상"];
function sunSheet(ctx, data, opt) {
  const pal = P(opt);
  const S = surfaceOf(ctx, data);
  const day = SUN_DAYS[Math.max(0, Math.min(2, Math.round(Number(opt.param ?? 1))))];
  const res = sunHours(S, ctx.lat, ctx.lon, 2026, day.m, day.d, 30);
  const values = res.hours.map(h => res.daylight > 0 ? h / res.daylight : NaN);
  const layers = groundLayers(S, values, [0, .2, .4, .6, .8], SUN_CLASSES, pal.sun, "sun");
  return {
    layers: [...layers, waterTop(opt, data), solidCtx(opt, data)],
    legend: [...SUN_CLASSES.map((c, i) => ({ kind: "fill", fill: pal.sun[i], stroke: pal.edge, sw: .1, label: `일조율 ${c}` })), solidLegend(opt), ...waterLegend(opt, data), SITE],
    notes: [`${day.label} 일조 시뮬레이션: 가조시간(${res.daylight.toFixed(1)}시간) 중 지표면(지상 0.5 m) 직사일조 도달 비율 (30분 간격 ${res.samples}회 표본).`,
      ...surfNote(S, data)],
    sources: ["태양 위치: Meeus/SunCalc 알고리즘 계산 (Europe/Paris 현지시 기준)"]
  };
}

// ---- 23 sky view factor -----------------------------------------------------------------------------
// Outdoor ground in French suburbs/towns mostly sits between 0.5 and 1; equal 0.2 bins put
// almost every cell in the top class, so the classes are tightened to that range.
const SVF_CLASSES = ["0.6 미만", "0.6–0.7", "0.7–0.8", "0.8–0.9", "0.9 이상"];
function svfSheet(ctx, data, opt) {
  const pal = P(opt);
  const S = surfaceOf(ctx, data);
  const svf = skyViewFactor(S, 32, 150);
  const layers = groundLayers(S, svf, [0, .6, .7, .8, .9], SVF_CLASSES, pal.svf, "svf");
  return {
    layers: [...layers, waterTop(opt, data), solidCtx(opt, data)],
    legend: [...SVF_CLASSES.map((c, i) => ({ kind: "fill", fill: pal.svf[i], stroke: pal.edge, sw: .1, label: `SVF ${c}` })), solidLegend(opt), ...waterLegend(opt, data), SITE],
    notes: ["천공률(Sky View Factor, SVF): 지상 1.5 m 높이에서 32방향 수평 차폐각(반경 150 m 이내)으로 산출한 비율 (1 = 완전 개방). 다이어그램 가장자리 150 m 안쪽은 바깥 건물이 빠져 실제보다 높게 나올 수 있습니다.", ...surfNote(S, data)],
    sources: ["IGN BD TOPO® V3 batiment, RGE ALTI®"]
  };
}

// ---- 24 wind rose -------------------------------------------------------------------------------------
const PERIODS = ["연간", "겨울 (12–2월)", "봄 (3–5월)", "여름 (6–8월)", "가을 (9–11월)"];
const SPEED_LABEL = ["0.5–2 m/s", "2–4 m/s", "4–6 m/s", "6–8 m/s", "8 m/s 이상"];

function roseLayers(ctx, st, pal, opt) {
  const S = Math.min(ctx.extent[2] - ctx.extent[0], ctx.extent[3] - ctx.extent[1]);
  const [cx, cy] = ctx.center;
  const layers = [];
  const centres = [[cx, cy, S * .2, 0],
    [cx - S * .28, cy + S * .28, S * .085, 1], [cx + S * .28, cy + S * .28, S * .085, 2],
    [cx - S * .28, cy - S * .28, S * .085, 3], [cx + S * .28, cy - S * .28, S * .085, 4]];
  const speedCols = pal.wind;
  centres.forEach(([x, y, R, p], pi) => {
    const total = st.total[p];
    const cells = st.rose[p];
    let maxPct = 0;
    const dirTot = cells.map(c => c.slice(1).reduce((a, b) => a + b, 0) / total * 100);
    maxPct = Math.max(...dirTot);
    const scale = R / (maxPct || 1);
    const items = [];
    for (let d = 0; d < 16; d++) {
      // 5 speed classes: merge the last two of the six stored bins (8-11, 11+)
      const bins = [cells[d][1], cells[d][2], cells[d][3], cells[d][4], cells[d][5] + cells[d][6]];
      let r0 = 0;
      bins.forEach((n, b) => {
        const r1 = r0 + n / total * 100 * scale;
        if (r1 > r0) {
          const a0 = (d * 22.5 - 9) * Math.PI / 180, a1 = (d * 22.5 + 9) * Math.PI / 180;
          const ring = [];
          for (let t = 0; t <= 6; t++) { const a = a0 + (a1 - a0) * t / 6; ring.push([x + r1 * Math.sin(a), y + r1 * Math.cos(a)]); }
          for (let t = 6; t >= 0; t--) { const a = a0 + (a1 - a0) * t / 6; ring.push([x + r0 * Math.sin(a), y + r0 * Math.cos(a)]); }
          items.push({ k: "poly", rings: [ring], fill: p ? pal.windSeason[b] : speedCols[b], stroke: pal.edge, sw: lw(opt, .08) });
        }
        r0 = r1;
      });
    }
    const guides = [.5, 1].map(f => ({ k: "poly", rings: [Array.from({ length: 64 }, (_, i) => [x + R * f * Math.sin(i / 64 * 2 * Math.PI), y + R * f * Math.cos(i / 64 * 2 * Math.PI)])], fill: "none", stroke: pal.edge, sw: lw(opt, .08), dash: "0.5 0.8" }));
    const labels = [["N", 0, 1], ["E", 90, 1], ["S", 180, 1], ["W", 270, 1]].map(([t, a]) => ({
      k: "text", p: [x + (R * 1.12 + (p ? 3 : 6)) * Math.sin(a * Math.PI / 180), y + (R * 1.12 + (p ? 3 : 6)) * Math.cos(a * Math.PI / 180)], text: t, size: p ? 2.2 : 3, fill: pal.text, halo: pal.bg, hm: 4
    }));
    labels.push({ k: "text", p: [x, y - R * 1.35 - (p ? 3 : 8)], text: `${PERIODS[p]} · 주풍향 빈도 ${maxPct.toFixed(0)} %`, size: p ? 2.3 : 3, fill: pal.text, halo: pal.bg, hm: 4 });
    layers.push({ id: `rose_${p}`, name: PERIODS[p], items: [...guides, ...items, ...labels] });
    void pi;
  });
  return layers;
}

function windSheet(ctx, data, opt) {
  const pal = P(opt);
  const { station: st, km } = nearestStation(data.climate, ctx.lat, ctx.lon);
  return {
    layers: roseLayers(ctx, st, pal, opt),
    legend: [...SPEED_LABEL.map((l, i) => ({ kind: "fill", fill: pal.wind[i], stroke: pal.edge, sw: .08, label: l })), SITE],
    notes: [`기상 데이터: EPW(TMYx 2011–2025) ${st.name} 관측소(WMO ${st.wmo}, 대지 이격 약 ${km.toFixed(0)} km). 풍향은 바람이 불어오는 방위 기준입니다.`,
      km > 60 ? "대지와 기상 관측소 간 거리가 60 km 이상으로 원거리 관측 데이터입니다 (Île-de-France 수록 관측소 기준)." : "",
      "표준기상년(TMY) 통계 데이터이므로 특정 연도 실측치와 다를 수 있습니다. 풍속 0.5 m/s 미만은 정온(무풍) 상태로 제외했습니다.", SIM].filter(Boolean),
    sources: ["climate.onebuilding.org — EPW (Météo-France 관측 기반, TMYx 2011–2025)"]
  };
}

// ---- 26 viewshed -------------------------------------------------------------------------------------------
function viewSheet(ctx, data, opt) {
  const pal = P(opt);
  const S = surfaceOf(ctx, data);
  const hi = Math.max(3, Number(opt.param) || 12);
  const levels = [1.6, hi, hi * 3];
  const [ox0, oy0] = ctx.center;
  const vis = levels.map(h => viewshed(S, ox0, oy0, h, 2000));
  const [ox, oy] = vis[0].observer, snapped = vis[0].snapped;
  const cls = k => vis[0][k] ? 0 : vis[1][k] ? 1 : vis[2][k] ? 2 : -1;
  const cols = pal.visibility;
  const names = [`${levels[0]} m 시점 가시 (보행자 눈높이)`, `${levels[1]} m 시점 추가 가시`, `${levels[2]} m 시점 추가 가시`];
  const layers = maskLayers(S, cls, names, cols, "view");
  const cx = ox, cy = oy;
  return {
    layers: [...layers, ctxLayer(opt, data),
      { id: "observer", name: "시점", items: [{ k: "dot", p: [cx, cy], r: 5, fill: pal.text, stroke: pal.bg, sw: .3 }] }],
    legend: [...names.map((n, i) => ({ kind: "fill", fill: cols[i], stroke: pal.edge, sw: .1, label: n })),
      { kind: "dot", fill: pal.text, stroke: pal.bg, label: "시점 (대지 중심)" }, ctxLegend(opt), SITE],
    notes: [snapped ? `대지 중심점이 건물 내부에 위치하여 인접 외부공간(약 ${snapped.toFixed(0)} m 이격)을 기준으로 계산했습니다.` : "",
      `대지 중심 지상 ${levels.join(" / ")} m 높이에서 바라본 가시 영역(지형 및 건물 차폐 반영, 분석 범위 ${Math.round(S.extent[2] - S.extent[0])} m). 바닥은 지상 1.6 m 높이의 사람이 보이는지, 건물은 지붕이 보이는지로 판정했습니다.`,
      ...surfNote(S, data)].filter(Boolean),
    sources: ["IGN BD TOPO® V3 batiment, RGE ALTI®"]
  };
}

export const IMPL3 = {
  "18": { needs: ["dem", "buildings"], build: relief },
  "19": { needs: ["dem", "buildings"], build: slopeSheet },
  "22": {
    needs: ["buildings"], wants: ["dem"], build: sunSheet,
    param: { label: "날짜", def: 1, options: SUN_DAYS.map((d, i) => [i, d.label]) }
  },
  "23": { needs: ["buildings"], wants: ["dem"], build: svfSheet },
  "24": { needs: ["climate"], build: windSheet },
  "26": {
    needs: ["buildings"], wants: ["dem"], build: viewSheet,
    param: { label: "시점 높이 (m)", def: 12, min: 3, max: 100, step: 1 }
  },
  "28": { needs: ["dem", "buildings"], build: aspectSheet }
};
void heightOf; void toWGS84; void UNK;
