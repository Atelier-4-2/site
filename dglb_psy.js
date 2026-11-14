// B6 psychrometric plate. Pure ES module; no DOM or external libraries.
// Supported annual station data:
//   st.hourly = { t: Array(8760|8784), rh: Array(...),
//                 month?: Array(...), pressure?: Array(...) }
//   st.hourly = [{ t, rh, month?, pressure? }, ...]
//   st.t / st.rh as flat annual arrays.
// month: 1..12; pressure: Pa. Records must be chronological from January 1
// if month is absent. Missing months are inferred from calendar position.
// st.t[12][24] / st.rh[12][24] are monthly means, NEVER annual samples.
// Comfort and strategy regions are illustrative screening assumptions,
// not ASHRAE 55 compliance calculations or predicted energy savings.

import { nearestStation } from "./dgenv.js?v=20261113u";

const W = 420, H = 297;
const FONT = "'Noto Sans','Noto Sans KR','Malgun Gothic',sans-serif";
const DISCLAIMER = "참고용 시뮬레이션 · CFD 아님 · 법적 효력 없음";
const C = {
  ink: "#1E293B", sub: "#475569", grid: "#CBD5E1",
  winter: "#0072B2", summer: "#009E73",
  vent: "#6B3FA0", shade: "#D55E00", solar: "#9A6700",
  bins: ["#E0F2FE", "#7DD3FC", "#38BDF8", "#0284C7", "#075985"]
};

export const LB_KINDS = [{
  kind: "B6",
  ko: "습공기선도",
  fr: "Diagramme psychrométrique",
  controls: [
    {
      key: "month", type: "select", ko: "기간", default: 0,
      options: [
        { value: 0, ko: "연간" },
        ...Array.from({ length: 12 }, (_, i) => ({
          value: i + 1, ko: `${i + 1}월`
        }))
      ]
    },
    {
      key: "clothing", type: "select", ko: "착의", default: "both",
      options: [
        { value: "both", ko: "여름·겨울" },
        { value: "summer", ko: "여름 약 0.5 clo" },
        { value: "winter", ko: "겨울 약 1.0 clo" }
      ]
    },
    {
      key: "pressureHpa", type: "number", ko: "기압 (hPa)",
      default: 1013.25, min: 500, max: 1100, step: 0.25
    }
  ]
}];

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;",
  '"': "&quot;", "'": "&apos;"
}[c]));
const f = n => String(Math.round(n * 1000) / 1000);
const numeric = v => typeof v === "number" && Number.isFinite(v);
const annual = a => a != null && (a.length === 8760 || a.length === 8784);
const ptsAttr = pts => pts.map(p => p.map(f).join(",")).join(" ");

// Single recorder for SVG and paper-mm CAD sheet, matching buildPlate.
class Drawing {
  constructor() {
    this.svgItems = [];
    this.groups = new Map();
    this.legend = [];
  }
  add(layer, item) {
    if (!this.groups.has(layer)) {
      this.groups.set(layer, { id: layer, name: layer, items: [] });
    }
    this.groups.get(layer).items.push(item);
  }
  line(pts, color = C.ink, sw = 0.2, layer = "line", dash = null) {
    this.svgItems.push(
      `<polyline points="${ptsAttr(pts)}" fill="none" ` +
      `stroke="${esc(color)}" stroke-width="${f(sw)}"` +
      `${dash ? ` stroke-dasharray="${esc(dash)}"` : ""}/>`
    );
    this.add(layer, {
      k: "line", pts: pts.map(([x, y]) => [x, H - y]),
      stroke: color, sw, dash
    });
  }
  poly(pts, fill = "none", stroke = C.ink, sw = 0.2, layer = "line") {
    this.svgItems.push(
      `<polygon points="${ptsAttr(pts)}" fill="${esc(fill)}" ` +
      `stroke="${esc(stroke)}" stroke-width="${f(sw)}"/>`
    );
    this.add(layer, {
      k: "poly", rings: [pts.map(([x, y]) => [x, H - y])],
      fill: "none", stroke: stroke === "none" ? fill : stroke, sw
    });
  }
  rect(x, y, w, h, fill, stroke = "none", sw = 0.15, layer = "line") {
    this.poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
      fill, stroke, sw, layer);
  }
  text(x, y, text, size = 2.6, color = C.ink, anchor = "start", weight = 400) {
    this.svgItems.push(
      `<text x="${f(x)}" y="${f(y)}" font-size="${f(size)}" ` +
      `font-weight="${weight}" text-anchor="${anchor}" ` +
      `fill="${esc(color)}">${esc(text)}</text>`
    );
    this.add("text", {
      k: "text", p: [x, H - y], text: String(text), fill: color, hm: size
    });
  }
  sheet(notes, sources) {
    const layers = [...this.groups.values()];
    layers.sort((a, b) => Number(a.id === "text") - Number(b.id === "text"));
    return { layers, legend: this.legend, notes, sources };
  }
  svg() {
    return `<svg xmlns="http://www.w3.org/2000/svg" ` +
      `viewBox="0 0 ${W} ${H}" font-family="${FONT}">` +
      `<rect width="${W}" height="${H}" fill="#fff"/>` +
      this.svgItems.join("") + "</svg>";
  }
}

// Magnus approximation over liquid water; consistent convention below 0 °C.
// p and saturation pressure in Pa; result in g water / kg dry air.
function saturation(t) {
  return 610.94 * Math.exp(17.625 * t / (t + 243.04));
}
function humidityRatio(t, rh, p) {
  const pv = saturation(t) * rh / 100;
  return pv < p ? 621.945 * pv / (p - pv) : NaN;
}
function rhAt(t, w, p) {
  return 100 * p * w / ((621.945 + w) * saturation(t));
}

function readAnnual(st) {
  if (!st) return null;
  const h = st.hourly;
  if (Array.isArray(h) && annual(h) && h[0] &&
      typeof h[0] === "object" && !Array.isArray(h[0])) {
    return {
      length: h.length,
      get: i => [h[i]?.t, h[i]?.rh, h[i]?.month, h[i]?.pressure]
    };
  }
  const source = h && annual(h.t) ? h : st;
  if (!annual(source.t) || source.rh?.length !== source.t.length) return null;
  return {
    length: source.t.length,
    get: i => [
      source.t[i], source.rh[i], source.month?.[i], source.pressure?.[i]
    ]
  };
}
function calendarMonths(n) {
  const days = [31, n === 8784 ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31];
  const months = new Uint8Array(n);
  let offset = 0;
  days.forEach((d, m) => {
    months.fill(m + 1, offset, offset + d * 24);
    offset += d * 24;
  });
  return months;
}
const inside = (t, w, r) =>
  t >= r[0] && t <= r[1] && w >= r[2] && w <= r[3];

const REGIONS = [
  { id: "winter", ko: "겨울 쾌적", color: C.winter, box: [20, 24, 4, 12] },
  { id: "summer", ko: "여름 쾌적", color: C.summer, box: [23, 27, 4, 12] },
  { id: "vent", ko: "자연환기", color: C.vent, box: [24, 32, 4, 16] },
  { id: "shade", ko: "일사 차양", color: C.shade, box: [24, 40, 2, 20] },
  { id: "solar", ko: "수동 태양열", color: C.solar, box: [10, 20, 2, 10] }
];

function collect(series, month, clothing, p) {
  const bins = new Uint32Array(100 * 50); // 0.5 °C × 0.5 g/kg
  const sumsT = new Float64Array(12);
  const sumsRh = new Float64Array(12);
  const monthlyN = new Uint32Array(12);
  const counts = { comfort: 0, winter: 0, summer: 0, vent: 0, shade: 0, solar: 0 };
  const calendar = series ? calendarMonths(series.length) : null;
  let valid = 0, selected = 0, outside = 0, invalid = 0;
  let pressureSamples = 0, maxBin = 0;
  for (let i = 0; i < (series?.length || 0); i++) {
    const [t, rh, rawMonth, rawPressure] = series.get(i);
    const m = rawMonth == null ? calendar[i] : rawMonth;
    const pp = rawPressure == null ? p : rawPressure;
    if (!numeric(t) || t < -90 || t > 70 ||
        !numeric(rh) || rh < 0 || rh > 100 ||
        !Number.isInteger(m) || m < 1 || m > 12 ||
        !numeric(pp) || pp < 50000 || pp > 110000) {
      invalid++;
      continue;
    }
    // Chart, curves, regions and counting use the same selected pressure.
    // Recorded hourly pressure is validated but not mixed into this plane.
    if (rawPressure != null) pressureSamples++;
    const w = humidityRatio(t, rh, p);
    if (!numeric(w)) { invalid++; continue; }
    valid++;
    sumsT[m - 1] += t;
    sumsRh[m - 1] += rh;
    monthlyN[m - 1]++;
    if (month && m !== month) continue;
    selected++;
    for (const r of REGIONS) if (inside(t, w, r.box)) counts[r.id]++;
    const winter = clothing !== "summer" && inside(t, w, REGIONS[0].box);
    const summer = clothing !== "winter" && inside(t, w, REGIONS[1].box);
    if (winter || summer) counts.comfort++;
    if (t < -10 || t > 40 || w < 0 || w > 25) {
      outside++;
      continue;
    }
    const ix = Math.min(99, Math.floor((t + 10) * 2));
    const iy = Math.min(49, Math.floor(w * 2));
    const n = ++bins[iy * 100 + ix];
    if (n > maxBin) maxBin = n;
  }
  const monthly = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1, hours: monthlyN[i],
    t: monthlyN[i] ? sumsT[i] / monthlyN[i] : null,
    rh: monthlyN[i] ? sumsRh[i] / monthlyN[i] : null
  }));
  const percentages = Object.fromEntries(Object.entries(counts).map(
    ([k, n]) => [k, selected ? n / selected * 100 : null]
  ));
  return {
    bins, maxBin, valid, selected, outside, invalid, pressureSamples,
    counts, percentages, monthly, inputHours: series?.length || 0
  };
}

export function buildLbPlate(kind, env, opts = {}) {
  if (kind !== "B6") throw new RangeError(`지원하지 않는 도판: ${kind}`);
  const ctx = env?.ctx || {};
  const stations = env?.data?.climate?.stations;
  const stationCandidates = Array.isArray(stations)
    ? stations.filter(s => numeric(s.lat) && numeric(s.lon)) : [];
  const near = numeric(ctx.lat) && numeric(ctx.lon) && stationCandidates.length
    ? nearestStation({ stations: stationCandidates }, ctx.lat, ctx.lon) : null;
  const st = near?.station;
  const series = readAnnual(st);
  const month = Number(opts.month ?? 0);
  const clothing = opts.clothing ?? "both";
  const pressureHpa = Number(opts.pressureHpa ?? 1013.25);
  if (!Number.isInteger(month) || month < 0 || month > 12) {
    throw new RangeError("기간은 0(연간) 또는 1–12월이어야 합니다.");
  }
  if (!["both", "winter", "summer"].includes(clothing)) {
    throw new RangeError("착의 설정이 잘못되었습니다.");
  }
  if (!Number.isFinite(pressureHpa) || pressureHpa < 500 || pressureHpa > 1100) {
    throw new RangeError("기압은 500–1100 hPa이어야 합니다.");
  }
  const p = pressureHpa * 100;
  const stats = collect(series, month, clothing, p);
  Object.assign(stats, {
    station: st?.name ?? null, wmo: st?.wmo ?? null,
    km: near?.km ?? null, month, clothing, pressureHpa,
    dataStatus: !st ? "no-station" : !series ? "no-annual-series"
      : !stats.selected ? "no-valid-hours" : "ok",
    binSize: { temperatureC: 0.5, humidityRatioGkg: 0.5 },
    method: "간이 쾌적 상자·경험적 전략 영역; 규정 적합성 평가 아님"
  });

  const d = new Drawing();
  d.rect(4, 4, 412, 289, "none", C.grid, 0.2);
  d.text(12, 17, "습공기선도 · 기후 전략", 8, C.ink, "start", 600);
  d.text(12, 24, "Diagramme psychrométrique", 3.8, C.sub);
  d.text(408, 14, "B6 · A3", 3.6, C.ink, "end", 600);
  d.text(408, 20, "간이 기후 전략 판독", 2.5, C.sub, "end");

  const short = (s, n = 42) => {
    const chars = Array.from(String(s ?? ""));
    return chars.length > n ? chars.slice(0, n - 1).join("") + "…" : chars.join("");
  };
  const period = month ? `${month}월` : "연간";
  d.text(12, 34,
    `${short(st?.name || "관측소 없음")} · ${period} · 유효 ${stats.selected} h · ${pressureHpa} hPa`,
    2.8);

  const plot = { x: 29, y: 47, w: 273, h: 185 };
  const X = t => plot.x + (t + 10) / 50 * plot.w;
  const Y = w => plot.y + plot.h - w / 25 * plot.h;
  const thresholds = [1, 5, 20, 100];
  const binClass = n => n >= 100 ? 4 : n >= 20 ? 3 : n >= 5 ? 2 : n >= 2 ? 1 : 0;

  for (let j = 0; j < 50; j++) for (let i = 0; i < 100; i++) {
    const n = stats.bins[j * 100 + i];
    if (!n) continue;
    d.rect(X(-10 + i * 0.5), Y((j + 1) * 0.5),
      plot.w / 100, plot.h / 50, C.bins[binClass(n)], "none", 0, "hours");
  }

  for (let t = -10; t <= 40; t += 5) {
    d.line([[X(t), Y(0)], [X(t), Y(25)]], C.grid, 0.12, "grid");
    d.text(X(t), Y(0) + 5, `${t}`, 2.6, C.sub, "middle");
  }
  for (let w = 0; w <= 25; w += 5) {
    d.line([[X(-10), Y(w)], [X(40), Y(w)]], C.grid, 0.12, "grid");
    d.text(X(-10) - 3, Y(w) + 0.9, `${w}`, 2.6, C.sub, "end");
  }

  for (let rh = 10; rh <= 100; rh += 10) {
    const pts = [];
    let last = null;
    for (let k = 0; k <= 400; k++) {
      const t = -10 + k * 0.125;
      const w = humidityRatio(t, rh, p);
      if (w > 25) {
        if (last) {
          const frac = (25 - last.w) / (w - last.w);
          pts.push([X(last.t + (t - last.t) * frac), Y(25)]);
        }
        break;
      }
      if (w >= 0 && Number.isFinite(w)) pts.push([X(t), Y(w)]);
      last = { t, w };
    }
    if (pts.length > 1) d.line(pts, rh === 100 ? C.ink : C.sub,
      rh === 100 ? 0.35 : 0.14, "rh");
    const tLabel = Math.min(38, (() => {
      let t = 38;
      while (t > -10 && humidityRatio(t, rh, p) > 23.7) t -= 0.25;
      return t;
    })());
    d.text(X(tLabel), Y(humidityRatio(tLabel, rh, p)) - 0.8,
      `${rh} %`, 2.1, C.sub, "end");
  }

  function regionPoints(box) {
    // Clip upper edge to saturation; same physical limit for all outlines.
    const [a, b, lo, hi] = box;
    const lower = [], upper = [];
    for (let i = 0; i <= 80; i++) {
      const t = a + (b - a) * i / 80;
      const top = Math.min(hi, humidityRatio(t, 100, p));
      if (top < lo) continue;
      lower.push([X(t), Y(lo)]);
      upper.push([X(t), Y(top)]);
    }
    return lower.concat(upper.reverse());
  }
  for (const r of REGIONS) {
    if (r.id === "summer" && clothing === "winter") continue;
    if (r.id === "winter" && clothing === "summer") continue;
    const pts = regionPoints(r.box);
    if (pts.length > 2) d.poly(pts, "none", r.color,
      r.id === "summer" || r.id === "winter" ? 0.55 : 0.3, "zones");
  }

  d.rect(plot.x, plot.y, plot.w, plot.h, "none", C.ink, 0.25);
  d.text(plot.x, plot.y - 5, "습공기비 (g/kg 건공기)", 2.8, C.ink);
  d.text(plot.x + plot.w / 2, 246, "건구온도 (°C)", 3, C.ink, "middle");
  d.text(plot.x, 253, "격자 0.5 °C × 0.5 g/kg · 곡선: 상대습도 (%)", 2.5, C.sub);
  d.text(plot.x, 260,
    `범위 밖 ${stats.outside} h · 무효 ${stats.invalid} h · 분모: 선택 기간 유효 시간`,
    2.4, C.sub);

  if (stats.dataStatus !== "ok") {
    d.rect(48, 126, 235, 21, "#FFFFFF", C.grid, 0.2, "status");
    d.text(165.5, 134,
      !st ? "최근접 EPW 관측소를 찾을 수 없습니다."
        : !series ? "실제 연간 시간별 기온·습도 배열이 필요합니다."
          : "선택 기간에 유효한 기온·습도 자료가 없습니다.",
      3, C.ink, "middle", 600);
    d.text(165.5, 141, "월별 24시간 평균을 8,760 h 자료로 복제하지 않습니다.",
      2.5, C.sub, "middle");
  }

  const rx = 318;
  d.line([[310, 34], [310, 265]], C.grid, 0.2);
  d.text(rx, 39, "빈도 · 시간/격자", 3, C.ink, "start", 600);
  const labels = ["1 h", "2–4 h", "5–19 h", "20–99 h", "100 h 이상"];
  C.bins.forEach((color, i) => {
    const y = 45 + i * 5;
    d.rect(rx, y - 2.8, 9, 3.3, color, C.grid, 0.1, "hours");
    d.text(rx + 12, y, labels[i], 2.5);
    d.legend.push({ kind: "line", stroke: color, sw: 0.5, label: labels[i] });
  });
  d.text(rx, 74, "쾌적·전략 비율", 3, C.ink, "start", 600);
  const pct = id => stats.percentages[id] == null
    ? "—" : `${stats.percentages[id].toFixed(1)} %`;
  d.text(rx, 81, `쾌적 합집합  ${pct("comfort")}`, 2.9, C.ink, "start", 600);

  let ry = 88;
  for (const r of REGIONS) {
    if (r.id === "summer" && clothing === "winter") continue;
    if (r.id === "winter" && clothing === "summer") continue;
    d.line([[rx, ry - 1], [rx + 8, ry - 1]], r.color, 0.55, "zones");
    d.text(rx + 11, ry, r.ko, 2.5);
    d.text(404, ry, pct(r.id), 2.5, C.ink, "end");
    d.legend.push({ kind: "line", stroke: r.color, sw: 0.4, label: r.ko });
    ry += 5.5;
  }
  d.text(rx, 122, "전략은 중복 집계 · 절감률 아님", 2.3, C.sub);
  d.text(rx, 127, "겨울 20–24 °C · 여름 23–27 °C", 2.2, C.sub);
  d.text(rx, 132, "쾌적 습공기비 4–12 g/kg", 2.3, C.sub);
  d.text(rx, 140, "월평균 · 기온 / 상대습도", 2.8, C.ink, "start", 600);
  d.text(rx + 19, 146, "−10       15       40 °C", 2.1, C.sub);
  d.text(rx + 55, 146, "0        100 %", 2.1, C.sub);

  stats.monthly.forEach((m, i) => {
    const y = 152 + i * 6.7;
    d.text(rx, y, `${m.month}월`, 2.2);
    d.line([[rx + 16, y - 1], [rx + 49, y - 1]], C.grid, 1.1, "monthly");
    d.line([[rx + 54, y - 1], [rx + 77, y - 1]], C.grid, 1.1, "monthly");
    if (!m.hours) {
      d.text(404, y, "—", 2.1, C.sub, "end");
      return;
    }
    const zero = rx + 16 + 10 / 50 * 33;
    const end = rx + 16 + Math.max(0, Math.min(1, (m.t + 10) / 50)) * 33;
    d.line([[zero, y - 1], [end, y - 1]], C.shade, 1.1, "monthly");
    d.line([[rx + 54, y - 1], [rx + 54 + m.rh / 100 * 23, y - 1]],
      C.winter, 1.1, "monthly");
    d.text(rx + 49, y + 2.3, `${m.t.toFixed(1)} °C`, 1.8, C.sub, "end");
    d.text(404, y + 2.3, `${m.rh.toFixed(0)} %`, 1.8, C.sub, "end");
  });
  d.text(rx, 237, "막대 범위 밖 기온은 끝에서 제한", 2.1, C.sub);
  d.text(rx, 244, `입력 ${stats.inputHours} h · 유효 ${stats.valid} h`, 2.3, C.sub);
  d.text(rx, 250, `기압 고정 ${pressureHpa} hPa`, 2.3, C.sub);
  d.text(rx, 256, "지도 아님 · 방위·거리척도 비적용", 2.2, C.sub);

  const stationLabel = st
    ? `EPW ${short(st.name, 32)} · WMO ${short(st.wmo || "미상", 12)} · 거리 ${near.km.toFixed(1)} km`
    : "EPW 관측소 없음";
  const sources = [
    stationLabel,
    "습공기비: Magnus 포화수증기압 근사 · 단일 고정 기압",
    "쾌적·전략: SiteLaser 간이 경험적 영역; ASHRAE 55 적합 판정 아님"
  ];
  const notes = [
    `${stationLabel} · 월평균은 유효 연간 자료에서 계산 · 전략 중복 가능`,
    `간이 쾌적 상자·경험적 전략 영역 · ${DISCLAIMER}`
  ];
  // Exactly two footer note lines, within the existing A3 frame.
  d.text(12, 274, notes[0], 2.1, C.sub);
  d.text(12, 281, notes[1], 2.3, C.ink);

  const def = { num: "B6", ko: "습공기선도", en: "b6-plate" };
  const ctx2 = {
    extent: [0, 0, W, H], center: [W / 2, H / 2],
    site: { ring: [] }, address: ctx.address,
    radiusLabel: "습공기선도 A3 가로 (좌표 단위 mm)",
    date: ctx.date, paperMm: true
  };
  return {
    svg: d.svg(),
    sheet: d.sheet(notes, sources),
    ctx2, def, stats
  };
}
