// SiteLaser Ladybug-style north-up analysis plates.
// Pure ES module. No DOM, canvas, network, or file-system access.
//
// Options:
// B3: { day:"winter"|"equinox"|"autumn"|"summer"|"custom",
//       month:1..12, date:1..31, shade:false, year:2026 }
// B4: { month:1..12, year:2026 }
// B5: { month:0..12, year:2026, hourly?:normalizedHourly }
//
// Supported irradiation sources, in priority order:
// 1. opts.hourly
// 2. nearestStation.hourly
// 3. nearestStation.dni / .dhi
//
// normalizedHourly:
// { dni: Array(8760|8784), dhi: Array(8760|8784),
//   timeZone:1, units:"Wh/m²"|"W/m²" }
// Arrays are chronological hourly EPW intervals from January 1, 00:00.
// timeZone is a fixed UTC offset, never daylight-saving time.
// Alternatively dni/dhi may each be 12 arrays of 24 monthly mean hours.
// Monthly means are explicitly identified in the plate notes.
// Irradiation is horizontal incident energy, not PV electricity production.

import {
  makeSurface, sunHours, shadowMask, skyViewFactor,
  nearestStation, sunPosition, parisDate, runRects, contours
} from "./dgenv_v02.js?v=20261116n";
import { utciEnv, CLIMATE } from "./dgclimplate_v03.js?v=20261116n";
import { STYLES } from "./dgsemantic_v02.js?v=20261116p";
import { contourRings, gaussian } from "./dgcontour_v03.js?v=20261113cards2";

const W = 420;
const H = 297;
const RAD = Math.PI / 180;
const FONT = "'Noto Sans','Noto Sans KR','Malgun Gothic',sans-serif";
const DISCLAIMER = "참고용 시뮬레이션 · CFD 아님 · 법적 효력 없음";
const SUN = ["#101B42", "#673A91", "#E87935", "#FFF3AE"];
const COMFORT = ["#C83E3A", "#F5CE62", "#258F89"];
const INFERNO = ["#090720", "#4A1764", "#A52C60", "#E66B2E", "#F9C74A", "#FCFFA4"];
const NODATA = "#E5E7EB";

const monthOptions = annual => [
  ...(annual ? [{ value: 0, label: "연간" }] : []),
  ...Array.from({ length: 12 }, (_, i) => ({
    value: i + 1, label: `${i + 1}월`
  }))
];

export const LB_KINDS = [
  {
    kind: "B3", ko: "일조 시간", fr: "Heures d’ensoleillement",
    controls: [
      {
        key: "day", type: "select", label: "기준일", default: "winter",
        options: [
          { value: "winter", label: "동지" },
          { value: "equinox", label: "춘분" },
          { value: "autumn", label: "추분" },
          { value: "summer", label: "하지" },
          { value: "custom", label: "직접 선택" }
        ]
      },
      {
        key: "month", type: "select", label: "월", default: 6,
        options: monthOptions(false),
        visibleWhen: { key: "day", value: "custom" }
      },
      {
        key: "date", type: "number", label: "일", default: 15,
        min: 1, max: 31, step: 1,
        visibleWhen: { key: "day", value: "custom" }
      },
      {
        key: "shade", type: "checkbox", label: "그림자 중첩",
        default: false
      }
    ]
  },
  {
    kind: "B4", ko: "야외 쾌적 시간", fr: "Confort thermique extérieur",
    controls: [
      {
        key: "month", type: "select", label: "월", default: 7,
        options: monthOptions(false)
      }
    ]
  },
  {
    kind: "B5", ko: "누적 일사량", fr: "Irradiation solaire cumulée",
    controls: [
      {
        key: "month", type: "select", label: "기간", default: 0,
        options: monthOptions(true)
      }
    ]
  }
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = v => typeof v === "number" && Number.isFinite(v);
const f = n => String(Math.round(n * 1000) / 1000);
const xml = v => String(v ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
}[c]));
const pathData = (points, close) =>
  "M" + points.map(p => `${f(p[0])} ${f(p[1])}`).join("L") +
  (close ? "Z" : "");

function integer(value, fallback, min, max, name) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name}: ${min}–${max} 범위의 정수가 필요합니다.`);
  }
  return n;
}

function ramp(colors, t) {
  const v = clamp(t, 0, 1) * (colors.length - 1);
  const a = Math.min(colors.length - 2, Math.floor(v));
  const u = v - a;
  return "#" + [1, 3, 5].map(i =>
    Math.round(
      parseInt(colors[a].slice(i, i + 2), 16) * (1 - u) +
      parseInt(colors[a + 1].slice(i, i + 2), 16) * u
    ).toString(16).padStart(2, "0")
  ).join("");
}

// Each primitive records both SVG and the existing paper-mm CAD schema.
// Unlike area-only SVG fills, analysis runs remain available in CAD exports.
class Drawing {
  constructor() {
    this.parts = [];
    this.groups = new Map();
    this.legend = [];
  }
  record(layer, item) {
    if (!this.groups.has(layer)) this.groups.set(layer, []);
    this.groups.get(layer).push(item);
  }
  polygon(rings, fill, stroke = "none", sw = 0.1, layer = "line") {
    const valid = rings.filter(r => r.length >= 3);
    if (!valid.length) return;
    this.parts.push(
      `<path d="${valid.map(r => pathData(r, true)).join("")}" ` +
      `fill="${xml(fill)}" fill-rule="evenodd" stroke="${xml(stroke)}" ` +
      `stroke-width="${f(sw)}" stroke-linejoin="round"/>`
    );
    this.record(layer, {
      k: "poly",
      rings: valid.map(r => r.map(p => [p[0], H - p[1]])),
      fill, stroke, sw
    });
  }
  rect(x, y, w, h, fill, stroke = "none", sw = 0.1, layer = "line") {
    this.polygon([[
      [x, y], [x + w, y], [x + w, y + h], [x, y + h]
    ]], fill, stroke, sw, layer);
  }
  line(points, stroke = CLIMATE.ink, sw = 0.2, layer = "line") {
    if (points.length < 2) return;
    this.parts.push(
      `<path d="${pathData(points, false)}" fill="none" ` +
      `stroke="${xml(stroke)}" stroke-width="${f(sw)}" ` +
      `stroke-linecap="round" stroke-linejoin="round"/>`
    );
    this.record(layer, {
      k: "line", pts: points.map(p => [p[0], H - p[1]]), stroke, sw
    });
  }
  text(x, y, text, size = 2.6, fill = CLIMATE.ink, anchor = "start") {
    this.parts.push(
      `<text x="${f(x)}" y="${f(y)}" font-size="${f(size)}" ` +
      `fill="${xml(fill)}" text-anchor="${anchor}">${xml(text)}</text>`
    );
    this.record("text", {
      k: "text", p: [x, H - y], text: String(text), fill, hm: size
    });
  }
  circle(x, y, r, fill, stroke = "none", sw = 0.2, layer = "line") {
    this.parts.push(
      `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" ` +
      `fill="${xml(fill)}" stroke="${xml(stroke)}" stroke-width="${f(sw)}"/>`
    );
    this.record(layer, {
      k: "dot", p: [x, H - y], r, fill,
      stroke: stroke === "none" ? null : stroke, sw
    });
  }
  svg() {
    return `<svg xmlns="http://www.w3.org/2000/svg" ` +
      `viewBox="0 0 ${W} ${H}" font-family="${FONT}">` +
      this.parts.join("") + "</svg>";
  }
  sheet(notes, sources) {
    const layers = [...this.groups].map(([id, items]) => ({
      id, name: id, items
    }));
    layers.sort((a, b) => Number(a.id === "text") - Number(b.id === "text"));
    return { layers, legend: this.legend, notes, sources };
  }
}

function clipRing(ring, extent) {
  let points = (ring || []).map(p => [p[0], p[1]]);
  if (points.length > 1 &&
      points[0][0] === points[points.length - 1][0] &&
      points[0][1] === points[points.length - 1][1]) points.pop();
  for (const [axis, bound, sign] of [
    [0, extent[0], 1], [0, extent[2], -1],
    [1, extent[1], 1], [1, extent[3], -1]
  ]) {
    const input = points;
    points = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[(i + input.length - 1) % input.length];
      const b = input[i];
      const ia = sign * (a[axis] - bound) >= 0;
      const ib = sign * (b[axis] - bound) >= 0;
      if (ia !== ib) {
        const t = (bound - a[axis]) / (b[axis] - a[axis]);
        points.push([
          a[0] + t * (b[0] - a[0]),
          a[1] + t * (b[1] - a[1])
        ]);
      }
      if (ib) points.push(b);
    }
  }
  return points;
}

function projection(ctx) {
  const [xmin, ymin, xmax, ymax] = ctx.extent;
  const s = Math.min(286 / (xmax - xmin), 196 / (ymax - ymin));
  const ox = 18 + (286 - (xmax - xmin) * s) / 2;
  const oy = 40 + (196 - (ymax - ymin) * s) / 2;
  return {
    s,
    P: (x, y) => [ox + (x - xmin) * s, oy + (ymax - y) * s]
  };
}

function surface(env) {
  const buildings = (env.data.buildings || []).map(b => ({
    ...b, holes: b.holes || []
  }));
  const S = env.S || makeSurface(
    env.ctx.extent, buildings, env.data.dem || env.dem || null
  );
  const n = S.nx * S.ny;
  if (!S.ground || !S.top || !S.bld ||
      S.ground.length !== n || S.top.length !== n ||
      S.bld.length !== n || !finite(S.step) || S.step <= 0) {
    throw new Error("분석 표면의 격자·지형·건물 자료를 확인하세요.");
  }
  for (let k = 0; k < n; k++) {
    if (!finite(S.ground[k]) || !finite(S.top[k])) {
      throw new Error("지형 또는 건물 높이에 결측값이 있습니다.");
    }
  }
  return { S, buildings };
}

function station(env) {
  const stations = env.data.climate?.stations;
  if (!Array.isArray(stations) || !stations.length) {
    throw new Error("EPW 관측소 자료가 없습니다.");
  }
  const result = nearestStation(env.data.climate, env.ctx.lat, env.ctx.lon);
  if (!result || !finite(result.km)) {
    throw new Error("EPW 관측소 좌표를 확인하세요.");
  }
  return result;
}

function sampleSun(ctx, year, month, day, hour, fixedOffset = null) {
  const date = fixedOffset == null
    ? parisDate(year, month, day, hour)
    : new Date(Date.UTC(year, month - 1, day) +
        (hour - fixedOffset) * 3600000);
  const p = sunPosition(date, ctx.lat, ctx.lon);
  return {
    az: p.az + (Number(ctx.convergence) || 0) * RAD,
    alt: p.alt
  };
}

function b3(env, S, opts, year) {
  const keyDays = {
    winter: [12, 21], equinox: [3, 20],
    autumn: [9, 22], summer: [6, 21]
  };
  const choice = opts.day || "winter";
  if (choice !== "custom" && !keyDays[choice]) {
    throw new Error("지원하지 않는 기준일입니다.");
  }
  const month = choice === "custom"
    ? integer(opts.month, 6, 1, 12, "월") : keyDays[choice][0];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = choice === "custom"
    ? integer(opts.date, 15, 1, last, "일") : keyDays[choice][1];
  const r = sunHours(S, env.ctx.lat, env.ctx.lon, year, month, day, 30);

  // sunHours itself has no grid-convergence parameter. Correct its result
  // with the same samples and shadowMask when Lambert grid north differs.
  if (Math.abs(Number(env.ctx.convergence) || 0) > 0.000001) {
    r.hours.fill(0);
    for (let hour = 0; hour < 24; hour += 0.5) {
      const p = sampleSun(env.ctx, year, month, day, hour);
      if (p.alt <= 2 * RAD) continue;
      const mask = shadowMask(S, p.az, p.alt);
      for (let k = 0; k < r.hours.length; k++) {
        if (!S.bld[k] && mask[k] === 0) r.hours[k] += 0.5;
      }
    }
    for (let k = 0; k < r.hours.length; k++) {
      if (S.bld[k]) r.hours[k] = NaN;
    }
  }

  const values = new Float32Array(r.hours);
  const shade = opts.shade === true;
  if (shade) {
    for (let k = 0; k < values.length; k++) {
      if (!S.bld[k]) values[k] = Math.max(0, r.daylight - values[k]);
    }
  }
  return {
    values, colors: SUN, max: 8, unit: "h/day",
    labels: [0, 2, 4, 6, 8],
    subtitle: `${month}월 ${day}일 · ${shade ? "그늘 시간" : "직달 일조"}`,
    legendTitle: shade ? "그늘 시간" : "직달 일조 시간",
    extra: [`주간 ${r.daylight.toFixed(1)} h/day`, "등치선 2 h · 4 h"],
    contour: true,
    note: "30분 간격 · 태양 고도 >2° · 주간 그늘 누적",
    stats: {
      daylight: r.daylight, samples: r.samples, month, day, shade,
      directHours: r.hours, values
    }
  };
}

function b4(env, S, opts) {
  const month = integer(opts.month, 7, 1, 12, "월");
  const { station: st, km } = station(env);
  const n = S.nx * S.ny;
  const comfortable = new Float32Array(n);
  const heat = new Float32Array(n);
  const valid = new Uint16Array(n);
  let daylight = 0;
  let invalidHours = 0;
  let clampedHours = 0;

  for (let hour = 0; hour < 24; hour++) {
    const ta = st.t?.[month - 1]?.[hour];
    const rh = st.rh?.[month - 1]?.[hour];
    const ws = st.ws?.[month - 1]?.[hour];
    if (!finite(ta) || !finite(rh) || !finite(ws) ||
        rh < 0 || rh > 100 || ws < 0) {
      throw new Error(`${month}월 ${hour}시 기상 자료가 없거나 잘못되었습니다.`);
    }
    // Existing utciEnv uses 2026, month 15, Paris civil hh:30.
    const e = utciEnv(env, month, hour);
    if (e.sp.alt <= 0) continue;
    daylight++;
    if (!finite(e.sun) || !finite(e.shade)) {
      invalidHours++;
      continue;
    }
    if (e.wsClamped) clampedHours++;
    const az = e.sp.az + (Number(env.ctx.convergence) || 0) * RAD;
    const mask = shadowMask(S, az, e.sp.alt);
    for (let k = 0; k < n; k++) {
      if (S.bld[k]) continue;
      const u = mask[k] === 0 ? e.sun : e.shade;
      valid[k]++;
      if (u >= 9 && u <= 26) comfortable[k]++;
      if (u > 32) heat[k]++;
    }
  }

  if (!daylight) throw new Error("대표일의 주간 시간이 없습니다.");
  const values = new Float32Array(n);
  let heatSum = 0;
  let groundCount = 0;
  for (let k = 0; k < n; k++) {
    // No silent renormalisation when UTCI is outside its validity limits.
    values[k] = !S.bld[k] && valid[k] === daylight
      ? comfortable[k] / daylight * 100 : NaN;
    if (finite(values[k])) {
      heatSum += heat[k];
      groundCount++;
    }
    if (S.bld[k] || valid[k] !== daylight) heat[k] = NaN;
  }
  return {
    values, colors: COMFORT, max: 100, unit: "%",
    // Break positions explicitly give red below 20%, yellow at 50%,
    // teal above 80%, rather than stretching a linear three-stop ramp.
    colorAt: t => ramp(COMFORT, clamp((t * 100 - 20) / 60, 0, 1)),
    labels: [0, 20, 50, 80, 100],
    subtitle: `${month}월 대표일 · UTCI 9–26 °C`,
    legendTitle: "주간 쾌적 비율",
    extra: [
      `UTCI >32 °C: ${groundCount ? (heatSum / groundCount).toFixed(1) : "—"} h/day`,
      "열스트레스 시간: 지상 셀 평균",
      `주간 ${daylight} h/day · 풍속 제한 ${clampedHours} h`
    ],
    note: `EPW 월·시 평균 · 2026년 ${month}월 15일 · 맑은 하늘 SolarCal · UTCI 결측 ${invalidHours} h`,
    station: st, km,
    stats: {
      month, representativeYear: 2026, representativeDay: 15,
      daylight, invalidHours, clampedHours, heatHours: heat, values,
      station: st.name, km
    }
  };
}

function irradiationSource(st, opts, year) {
  const src = opts.hourly || st.hourly || st;
  const dni = src.dni;
  const dhi = src.dhi;
  if (!dni || !dhi) {
    throw new Error(
      "EPW DNI/DHI 자료가 없습니다. hourly.dni/dhi 또는 월별 12×24 배열이 필요합니다."
    );
  }
  if (src.units && !["W/m²", "Wh/m²"].includes(src.units)) {
    throw new Error("DNI/DHI 단위는 W/m² 또는 시간별 Wh/m²여야 합니다.");
  }
  const monthly = dni.length === 12 && dhi.length === 12 &&
    dni[0]?.length === 24 && dhi[0]?.length === 24;
  const daysInYear =
    (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
  if (!monthly && (
    dni.length !== daysInYear * 24 || dhi.length !== daysInYear * 24
  )) {
    throw new Error(`${year}년 DNI/DHI는 ${daysInYear * 24}개가 필요합니다.`);
  }
  const offset = src.timeZone ?? st.timeZone ?? st.timezone ?? st.tz ?? 1;
  if (!finite(offset) || offset < -12 || offset > 14) {
    throw new Error("EPW 고정 UTC 시차를 확인하세요.");
  }
  function read(month, day, hour) {
    const index = (
      (Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) /
      86400000
    ) * 24 + hour;
    const a = monthly ? dni[month - 1]?.[hour] : dni[index];
    const b = monthly ? dhi[month - 1]?.[hour] : dhi[index];
    // EPW solar missing-value sentinel is 9999.
    if (!finite(a) || !finite(b) || a < 0 || b < 0 || a >= 9999 || b >= 9999) {
      throw new Error(`${month}/${day} ${hour}시 DNI/DHI 결측 또는 오류입니다.`);
    }
    return [a, b];
  }
  return {
    read, monthly, offset,
    assumedOffset: src.timeZone == null && st.timeZone == null &&
      st.timezone == null && st.tz == null
  };
}

function b5(env, S, opts, year) {
  const month = integer(opts.month, 0, 0, 12, "기간");
  const { station: st, km } = station(env);
  const source = irradiationSource(st, opts, year);
  const n = S.nx * S.ny;

  // A zero building mask evaluates receivers on S.top for both ground and
  // roofs; the unchanged top raster still obstructs rays at taller neighbours.
  // Only a new mask is allocated. The caller's surface is never modified.
  const receivers = { ...S, bld: new Uint8Array(n) };
  const svf = skyViewFactor(receivers, 16, 150);
  const values = new Float32Array(n);
  const months = month ? [month] :
    Array.from({ length: 12 }, (_, i) => i + 1);
  let directSamples = 0;
  let radiationHours = 0;
  let representedHours = 0;
  let sampleDays = 0;

  for (const m of months) {
    const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
    // One midpoint day per non-overlapping seven-day block.
    // Final short blocks retain their actual weight, never a full week.
    for (let start = 1; start <= last; start += 7) {
      const weightDays = Math.min(7, last - start + 1);
      const day = start + Math.floor((weightDays - 1) / 2);
      sampleDays++;
      for (let hour = 0; hour < 24; hour += 2) {
        // Read both original hourly energies, not one value multiplied by 2.
        // One shadow geometry at the two-hour interval midpoint represents
        // those two hours. DNI*cos(altitude) is evaluated at each hour centre.
        const a = source.read(m, day, hour);
        const b = source.read(m, day, hour + 1);
        const p0 = sampleSun(env.ctx, year, m, day, hour + 0.5, source.offset);
        const p1 = sampleSun(env.ctx, year, m, day, hour + 1.5, source.offset);
        const direct = weightDays * (
          a[0] * Math.max(0, Math.sin(p0.alt)) +
          b[0] * Math.max(0, Math.sin(p1.alt))
        ) / 1000;
        const diffuse = weightDays * (a[1] + b[1]) / 1000;
        representedHours += weightDays * 2;
        if (direct === 0 && diffuse === 0) continue;
        radiationHours += 2;

        let mask = null;
        if (direct > 0) {
          let p = sampleSun(
            env.ctx, year, m, day, hour + 1, source.offset
          );
          // A sunrise/sunset-straddling interval uses its daylight hour
          // rather than a below-horizon midpoint.
          if (p.alt <= 0) p = p0.alt > p1.alt ? p0 : p1;
          mask = shadowMask(receivers, p.az, p.alt);
          directSamples++;
        }
        for (let k = 0; k < n; k++) {
          values[k] += diffuse * svf[k] +
            (mask && mask[k] === 0 ? direct : 0);
        }
      }
    }
  }

  let maximum = 0;
  let roofCount = 0;
  let pvCount = 0;
  for (let k = 0; k < n; k++) {
    maximum = Math.max(maximum, values[k]);
    if (S.bld[k]) {
      roofCount++;
      if (!month && values[k] > 1100) pvCount++;
    }
  }
  const max = Math.max(100, Math.ceil(maximum / 100) * 100);
  return {
    values, colors: INFERNO, max, unit: "kWh/m²",
    labels: [0, max * 0.25, max * 0.5, max * 0.75, max],
    subtitle: `${month ? `${month}월` : "연간"} · 지상 + 수평 지붕`,
    legendTitle: "누적 수평 일사",
    roofs: true,
    extra: month ? [
      "PV 기준은 연간 분석에서 표시",
      "경사·발전 효율·반사 미반영"
    ] : [
      "PV 검토 기준 >1 100 kWh/m²·yr",
      `해당 지붕 셀 ${roofCount ? (pvCount / roofCount * 100).toFixed(0) : "0"} %`,
      "발전량이 아닌 입사 에너지"
    ],
    note: `주 1일·2시간 그림자 표본, 실제 일수 가중 · ${
      source.monthly ? "월별 24시간 평균" : "EPW 시간별 자료"
    } · SVF 16방향${source.assumedOffset ? " · UTC+1 가정" : ""}`,
    station: st, km,
    stats: {
      month, year, directSamples, radiationHours, representedHours,
      sampleDays, monthlyMeanInput: source.monthly,
      timeZone: source.offset, assumedOffset: source.assumedOffset,
      roofCount, pvCount, skyViewFactor: svf, values,
      station: st.name, km
    }
  };
}

function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const p = ring[i], q = ring[j];
    if ((p[1] > y) !== (q[1] > y) &&
        x < (q[0] - p[0]) * (y - p[1]) / (q[1] - p[1]) + p[0]) inside = !inside;
  }
  return inside;
}

// The analysis values live on a 4 m grid. Drawing one rectangle per cell made the plates look
// pixelated (owner, 2026-11-15), so the ground is now drawn as smooth iso-bands:
//  - building cells take the nearest ground value, the field gets a light blur (0.7 cell) and
//    d3-contour traces the area above each of 24 thresholds; the areas are painted from the lowest
//    threshold up, each covering the previous one, so there are no seams between bands;
//  - on plates that also colour roofs (B5) every building is filled with the mean of its own roof
//    cells, inside its true vector outline.
// The numbers behind the plate (legend statistics, 3D view) are the unsmoothed cell values.
function drawRaster(d, ax, S, result, extent, buildings = []) {
  const N = 24;
  const colorOf = t => result.colorAt ? result.colorAt(t) : ramp(result.colors, t);
  const ground = new Float32Array(S.nx * S.ny);
  let any = false;
  for (let k = 0; k < ground.length; k++) {
    const v = result.values[k];
    ground[k] = !S.bld[k] && finite(v) ? v : NaN;
    if (!S.bld[k] && finite(v)) any = true;
  }
  if (any) {
    const field = gaussian(fillGaps(ground, S.nx, S.ny), S.nx, S.ny, .7);
    const thresholds = Array.from({ length: N }, (_, i) => i ? result.max * i / N : -1e9);
    contourRings(field, S.nx, S.ny, S.x0, S.y0, S.step, thresholds).forEach((rings, i) => {
      const clipped = rings.map(r => clipRing(r, extent)).filter(r => r.length >= 3);
      if (clipped.length) {
        d.polygon(clipped.map(r => r.map(p => ax.P(...p))), colorOf((i + .5) / N), "none", 0, "analysis");
      }
    });
  }
  if (!result.roofs) return;
  for (const b of buildings) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of b.polygon) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    const ia = Math.max(0, Math.floor((x0 - S.x0) / S.step)), ib = Math.min(S.nx - 1, Math.floor((x1 - S.x0) / S.step));
    const ja = Math.max(0, Math.floor((y0 - S.y0) / S.step)), jb = Math.min(S.ny - 1, Math.floor((y1 - S.y0) / S.step));
    let sum = 0, n = 0;
    for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) {
      const k = j * S.nx + i, v = result.values[k];
      if (!S.bld[k] || !finite(v)) continue;
      const x = S.x0 + (i + .5) * S.step, y = S.y0 + (j + .5) * S.step;
      if (!inRing(b.polygon, x, y) || (b.holes || []).some(h => inRing(h, x, y))) continue;
      sum += v; n++;
    }
    if (!n) continue;                                  // smaller than one cell: left to the ground colour
    const outer = clipRing(b.polygon, extent);
    if (outer.length < 3) continue;
    const holes = (b.holes || []).map(r => clipRing(r, extent)).filter(r => r.length >= 3);
    d.polygon([outer, ...holes].map(r => r.map(p => ax.P(...p))),
      colorOf(clamp(sum / n / result.max, 0, 1)), "none", 0, "analysis");
  }
}

// Nearest-ground fill for building cells (NaN), so contour lines pass under the footprints
// instead of wrapping every building or breaking at them.
function fillGaps(values, nx, ny) {
  const v = Float32Array.from(values), queue = new Int32Array(v.length);
  let head = 0, tail = 0;
  for (let i = 0; i < v.length; i++) if (Number.isFinite(v[i])) queue[tail++] = i;
  while (head < tail) {
    const i = queue[head++], x = i % nx;
    for (const j of [x > 0 ? i - 1 : -1, x + 1 < nx ? i + 1 : -1, i - nx, i + nx]) {
      if (j < 0 || j >= v.length || Number.isFinite(v[j])) continue;
      v[j] = v[i]; queue[tail++] = j;
    }
  }
  return v;
}

function drawContours(d, ax, S, values, extent) {
  // contours() samples grid nodes; analysis values live at cell centres.
  const result = contours({
    x0: S.x0 + S.step / 2,
    y0: S.y0 + S.step / 2,
    dx: S.step, nx: S.nx, ny: S.ny, z: fillGaps(values, S.nx, S.ny)
  }, 2);
  for (const line of result.lines) {
    if (line.level !== 2 && line.level !== 4) continue;
    // one polyline per unbroken run: joining the points left after filtering drew long straight
    // lines across the sheet (live review, GPT)
    let run = [];
    const flush = () => {
      if (run.length > 1) d.line(run.map(p => ax.P(...p)), CLIMATE.ink, line.level === 4 ? 0.3 : 0.18, "contour");
      run = [];
    };
    for (const p of line.pts) {
      const inside = p[0] >= extent[0] && p[0] <= extent[2] && p[1] >= extent[1] && p[1] <= extent[3];
      const last = run[run.length - 1];
      if (!inside || (last && Math.hypot(p[0] - last[0], p[1] - last[1]) > S.step * 2.5)) flush();
      if (inside) run.push(p);
    }
    flush();
  }
}

function drawBuildings(d, ax, buildings, extent, roofs) {
  for (const b of buildings) {
    const outer = clipRing(b.polygon, extent);
    if (outer.length < 3) continue;
    const holes = (b.holes || []).map(r => clipRing(r, extent))
      .filter(r => r.length >= 3);
    d.polygon([outer, ...holes].map(r => r.map(p => ax.P(...p))),
      roofs ? "none" : "#EEF0F2", CLIMATE.bld, 0.1, "bld");
  }
}

function scaleBar(d, s) {
  const target = 55 / s;
  const choices = [10, 20, 25, 50, 100, 200, 250, 500, 1000];
  const length = choices.reduce((a, b) =>
    Math.abs(b - target) < Math.abs(a - target) ? b : a
  );
  const width = length * s;
  for (let i = 0; i < 4; i++) {
    d.rect(18 + i * width / 4, 250, width / 4, 1.4,
      i % 2 ? "#FFFFFF" : CLIMATE.ink, CLIMATE.ink, 0.18);
  }
  d.text(18, 255, "0", 2.4, CLIMATE.ink, "middle");
  d.text(18 + width, 255, `${length} m`, 2.4, CLIMATE.ink, "middle");
  d.text(18, 260, `A3 원본 1:${Math.round(1000 / s)}`, 2.1, CLIMATE.sub);
}

function northArrow(d, ctx) {
  // Projection is Lambert grid north-up. True north is corrected by
  // the same convergence convention as existing climate plates.
  const a = (Number(ctx.convergence) || 0) * RAD;
  const ux = Math.sin(a);
  const uy = -Math.cos(a);
  const x = 99;
  const y = 251;
  const tip = [x + ux * 6.5, y + uy * 6.5];
  d.circle(x, y, 8, "none", CLIMATE.ring, 0.15);
  d.line([[x - ux * 6.5, y - uy * 6.5], tip]);
  d.polygon([[
    tip,
    [tip[0] - ux * 3.4 - uy * 1.2, tip[1] - uy * 3.4 + ux * 1.2],
    [tip[0] - ux * 3.4 + uy * 1.2, tip[1] - uy * 3.4 - ux * 1.2]
  ]], CLIMATE.ink);
  d.text(tip[0] + ux * 4, tip[1] + uy * 4 + 1,
    "N", 3.4, CLIMATE.ink, "middle");
}

function legend(d, result, S) {
  const x = 322;
  d.text(x, 40, result.legendTitle, 3.2);
  d.text(x, 46, result.unit, 2.6, CLIMATE.sub);
  const width = 76;
  for (let i = 0; i < 32; i++) {
    const t = i / 31;
    const color = result.colorAt
      ? result.colorAt(t) : ramp(result.colors, t);
    d.rect(x + i * width / 32, 51, width / 32, 6, color);
  }
  result.labels.forEach(v => {
    const px = x + v / result.max * width;
    const label = v === result.max && result.max === 8
      ? "≥8" : String(Math.round(v));
    d.text(px, 62, label, 2.3, CLIMATE.ink, "middle");
  });
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const stroke = result.colorAt
      ? result.colorAt(t) : ramp(result.colors, t);
    d.legend.push({
      kind: "line", stroke, sw: 0.5,
      label: `${Math.round(t * result.max)} ${result.unit}`
    });
  }
  let y = 73;
  for (const line of result.extra) {
    d.text(x, y, line, 2.45);
    y += 5;
  }
  y += 7;
  d.rect(x, y - 3, 7, 3.2, "#EEF0F2", CLIMATE.bld);
  d.text(x + 10, y, result.roofs ? "건물 윤곽 · 지붕 채색" : "건물", 2.4);
  y += 6;
  d.rect(x, y - 3, 7, 3.2, NODATA);
  d.text(x + 10, y, "결측 / 계산 범위 밖", 2.4);
  if (result.water) {
    y += 6;
    d.rect(x, y - 3, 7, 3.2, result.water);
    d.text(x + 10, y, "수면", 2.4);
  }
  y += 8;
  d.circle(x + 3, y - 1, 2.4, CLIMATE.site, CLIMATE.siteLine, 0.55, "site");
  d.text(x + 10, y, "대지 중심", 2.4);
  y += 8;
  d.text(x, y, `격자 ${S.step} m`, 2.4, CLIMATE.sub);
  if (result.station) {
    y += 8;
    // Fixed-size, bounded station text keeps the right column intact.
    const name = String(result.station.name || "EPW");
    const short = [...name].slice(0, 24).join("");
    d.text(x, y, short, 2.25, CLIMATE.sub);
    d.text(x, y + 5, `관측소 거리 ${result.km.toFixed(1)} km`, 2.25, CLIMATE.sub);
  }
}

export function buildLbPlate(kind, env, opts = {}) {
  const definition = LB_KINDS.find(item => item.kind === kind);
  if (!definition) throw new Error(`지원하지 않는 분석: ${kind}`);
  if (!env?.ctx || !env?.data) {
    throw new Error("ctx와 data가 필요합니다.");
  }
  const ctx = env.ctx;
  if (!Array.isArray(ctx.extent) || ctx.extent.length !== 4 ||
      !ctx.extent.every(finite) ||
      ctx.extent[2] <= ctx.extent[0] || ctx.extent[3] <= ctx.extent[1] ||
      !finite(ctx.lat) || !finite(ctx.lon)) {
    throw new Error("분석 범위와 위·경도를 확인하세요.");
  }
  const year = integer(opts.year, 2026, 1900, 2200, "연도");
  const started = Date.now();
  const { S, buildings } = surface(env);
  const result = kind === "B3"
    ? b3(env, S, opts, year)
    : kind === "B4"
      ? b4(env, S, opts)
      : b5(env, S, opts, year);

  const d = new Drawing();
  const ax = projection(ctx);
  const palette = env.pal || {};
  const tokens = STYLES[palette.id] || STYLES.atlas;

  d.rect(0, 0, W, H, "#FFFFFF");
  d.rect(4, 4, W - 8, H - 8, "none", CLIMATE.ring, 0.2);
  d.text(12, 17, definition.ko, 8);
  d.text(12, 24, definition.fr, 3.8, CLIMATE.sub);
  d.text(408, 14, `${kind} · A3`, 3.6, CLIMATE.ink, "end");
  d.text(12, 34, result.subtitle, 2.8);

  drawRaster(d, ax, S, result, ctx.extent, buildings);
  if (result.contour) drawContours(d, ax, S, result.values, ctx.extent);
  // mapped water surfaces above the raster: a river is not ground to be scored (live review, GPT + Gemini)
  for (const ft of env.data.waterS || []) for (const rings of ft.polygons || []) {
    const clippedRings = rings.map(r => clipRing(r, ctx.extent)).filter(r => r.length >= 3);
    if (clippedRings.length && clippedRings[0].length >= 3) {
      d.polygon(clippedRings.map(r => r.map(p => ax.P(...p))), tokens.water, "none", 0, "water");
      result.water = tokens.water;
    }
  }
  drawBuildings(d, ax, buildings, ctx.extent, result.roofs);

  const site = clipRing(ctx.site?.ring, ctx.extent);
  if (site.length >= 3) {
    d.polygon([site.map(p => ax.P(...p))],
      "none", CLIMATE.siteLine, 0.35, "site");
  }
  const center = ctx.center || [
    (ctx.extent[0] + ctx.extent[2]) / 2,
    (ctx.extent[1] + ctx.extent[3]) / 2
  ];
  if (center.every(finite) &&
      center[0] >= ctx.extent[0] && center[0] <= ctx.extent[2] &&
      center[1] >= ctx.extent[1] && center[1] <= ctx.extent[3]) {
    const p = ax.P(...center);
    d.circle(...p, 3.1, "#FFFFFF");
    d.circle(...p, 2.4, CLIMATE.site, CLIMATE.siteLine, 0.55, "site");
  }

  scaleBar(d, ax.s);
  northArrow(d, ctx);
  legend(d, result, S);

  // Exactly two footer note lines; both end in the required disclaimer.
  const notes = [
    `${result.note} · ${DISCLAIMER}`,
    `북측 평면 · 지형·건물 높이 기반 · 미상 높이 ${
      S.unknownHeight || 0
    }동 3 m · 차폐 탐색 400 m · ${DISCLAIMER}`
  ];
  d.text(12, 277, notes[0], 2.05, CLIMATE.sub);
  d.text(12, 284, notes[1], 2.05, CLIMATE.sub);

  const sources = [
    "IGN BD TOPO® V3",
    "IGN RGE ALTI",
    ...(kind === "B3" ? [] : ["EPW TMYx (climate.onebuilding.org)"]),
    ...(kind === "B4" ? ["UTCI: Bröde et al. 2012; SolarCal"] : [])
  ];
  const def = {
    num: kind, ko: `${definition.ko} (평면)`,
    en: `${kind.toLowerCase()}-plate`
  };
  const ctx2 = {
    extent: [0, 0, W, H],
    center: [W / 2, H / 2],
    site: { ring: [] },
    address: ctx.address,
    radiusLabel: "분석 A3 가로 (좌표 단위 mm)",
    date: ctx.date,
    paperMm: true
  };
  return {
    svg: d.svg(),
    sheet: d.sheet(notes, sources),
    ctx2, def,
    stats: {
      ...result.stats,
      gridStep: S.step,
      nx: S.nx, ny: S.ny,
      elapsedMs: Date.now() - started,
      northUp: true,
      palette: palette.id || "atlas",
      semanticSiteColor: tokens.site,
      notes
    }
  };
}
