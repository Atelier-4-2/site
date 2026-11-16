import { semanticPalette } from "./dgsemantic_v02.js?v=20261116p";
// Shared drawing core for the site-analysis diagrams (diagrams.html).
// Model coordinates are EPSG:2154 metres. Sheet units are millimetres (A3).

import { PALETTES } from "./dgpalettes.js?v=20261116p";

export const ACCENT = "#E6B89C";
export const INK = "#1d1d1f";
// customary drawing scales (denominators) for the A3 sheets, largest scale first
export const STD_SCALES = [100, 200, 250, 500, 1000, 2000, 2500, 4000, 5000, 10000, 20000, 25000, 50000];
// Scale of a full A3 sheet: `den` = customary scale denominator (null for card thumbnails, custom frames
// and extents too large for the list), `mpm` = metres per sheet millimetre. Used by renderSvg and by the
// DXF / 3dm sheet layout (dgexport_v03.js), so screen, PDF and CAD agree.
export function sheetScale(ctx, card = false) {
  const S = Math.max(ctx.extent[2] - ctx.extent[0], ctx.extent[3] - ctx.extent[1]);
  const den = !card && !ctx.custom && !ctx.paperMm ? STD_SCALES.find(d => S * 1000 / d <= SHEET.mapS + 1e-6) || null : null;
  return { den, mpm: den ? den / 1000 : S / SHEET.mapS };
}
export const SHEET = { w: 420, h: 297, margin: 12, mapX: 12, mapY: 30, mapS: 255, panelX: 283, panelW: 125 };
export const FONT = '"Noto Sans","Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo",sans-serif';

// ---- colour ---------------------------------------------------------------
export const hex2rgb = h => {
  let s = String(h).replace("#", "");
  if (s.length === 3) s = [...s].map(c => c + c).join("");
  return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16));
};
const rgb2hex = c => "#" + c.map(v => Math.round(Math.max(0, Math.min(255, v)))
  .toString(16).padStart(2, "0")).join("");
export const mix = (a, b, t) => {
  const x = hex2rgb(a), y = hex2rgb(b);
  return rgb2hex(x.map((v, i) => v + (y[i] - v) * t));
};
// n-step ramp, light to dark, ending at `base`.
export const ramp = (n, base, light = "#ececec") =>
  Array.from({ length: n }, (_, i) => mix(light, base, n === 1 ? 1 : i / (n - 1)));
// Preserve the approved ramp values exactly.
export const seqOf = pal => pal.seq5.slice();
export const GREYS5 = ["#ececec", "#c9c9c9", "#a2a2a2", "#707070", "#2c2c2c"];

// ---- geometry ---------------------------------------------------------------
export function ringArea(r) {
  let s = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const a = r[i], b = r[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

export function clipRingRect(ring, x0, y0, x1, y1) {
  const edges = [
    [p => p[0] >= x0, (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])]],
    [p => p[0] <= x1, (a, b) => [x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0])]],
    [p => p[1] >= y0, (a, b) => [a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0]],
    [p => p[1] <= y1, (a, b) => [a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1]]
  ];
  let out = ring;
  for (const [inside, cut] of edges) {
    const input = out; out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i], b = input[(i + 1) % input.length];
      const ai = inside(a), bi = inside(b);
      if (ai && bi) out.push(b);
      else if (ai && !bi) out.push(cut(a, b));
      else if (!ai && bi) { out.push(cut(a, b)); out.push(b); }
    }
    if (!out.length) return [];
  }
  return out;
}

export const circleRing = (cx, cy, r, n = 96) =>
  Array.from({ length: n }, (_, i) => {
    const t = i / n * Math.PI * 2;
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
  });

export const bboxOf = pts => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of pts) { a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1]); }
  return [a, b, c, d];
};

// ---- text -------------------------------------------------------------------
const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const charW = (ch, size) => (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.56) * size;

export function wrapText(text, size, width) {
  const lines = [];
  let line = "", w = 0;
  for (const ch of String(text)) {
    const cw = charW(ch, size);
    if (w + cw > width && line) { lines.push(line.trim()); line = ""; w = 0; }
    line += ch; w += cw;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

const num = v => (Math.round(v * 1000) / 1000).toString();

// ---- SVG --------------------------------------------------------------------
function pathOf(rings, tx, close) {
  return rings.map(r => {
    let d = "";
    for (let i = 0; i < r.length; i++) {
      const [x, y] = tx(r[i]);
      d += (i ? "L" : "M") + num(x) + " " + num(y);
    }
    return d + (close ? "Z" : "");
  }).join("");
}

function legendSwatch(e, x, y, pal, P = "") {
  const INK = pal.text;
  const w = 9, h = 4.6;
  const stroke = e.stroke || pal.edge;
  switch (e.kind) {
    case "compass":
      return `<g transform="translate(${x + w / 2} ${y + h / 2}) rotate(${e.angle || 0})"><path d="M0 -2.5L2 1H.6V2.5H-.6V1H-2Z" fill="${e.fill}" stroke="${stroke}" stroke-width=".2"/></g>`;
    case "line":
      return `<path d="M${x} ${y + h / 2}H${x + w}" stroke="${e.stroke}" stroke-width="${num(Math.max(e.sw || .3, .15))}" stroke-dasharray="${e.dash || "none"}" stroke-linecap="round" fill="none"/>`;
    case "dot":
      return `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="1.5" fill="${e.fill || "none"}" stroke="${stroke}" stroke-width="${num(e.sw ?? .2)}"/>`;
    case "dots":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${P}dots)" stroke="${stroke}" stroke-width=".2"/>`;
    case "sitePoint":   // point + radius site: the map shows a centre mark, not a boundary
      return `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="1.1" fill="${pal.siteLine}"/><circle cx="${x + w / 2}" cy="${y + h / 2}" r="2.3" fill="none" stroke="${pal.siteLine}" stroke-width=".35"/>`;
    case "site":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${pal.bg}" stroke-width="1.7"/><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${pal.siteLine}" stroke-width="1"/>`;
    default:
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${e.fill}" stroke="${stroke}" stroke-width="${num(e.sw ?? .2)}" stroke-dasharray="${e.dash || "none"}"/>`;
  }
}

function niceBar(metresPerMm) {
  for (const L of [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000]) {
    const mm = L / metresPerMm;
    if (mm >= 28 && mm <= 70) return { L, mm };
  }
  const L = 100;
  return { L, mm: L / metresPerMm };
}

// sheet: { layers:[{id,name,items}], legend:[], notes:[] }
// ctx:   { extent:[x0,y0,x1,y1], site:{ring}, address, date, convergence, radius }
// opts:  { prefix, card (circle map only), fontCss, absoluteSize }
export function renderSvg(def, sheet, ctx, opts = {}) {
  const P = opts.prefix || "";
  const pal = semanticPalette(opts.pal || PALETTES.atlas);
  const INK = pal.text;
  const MUTED = mix(pal.text, pal.bg, .42);
  const { mapS } = SHEET;
  const [x0, y0, x1, y1] = ctx.extent;
  const Wm = x1 - x0, Hm = y1 - y0;
  const S = Math.max(Wm, Hm);                   // longest side, metres
  // Full A3 sheets of a real site are drawn at a customary scale (owner 2026-11-14): the largest
  // standard scale at which the analysis extent still fits the 255 mm map box; the map frame shrinks
  // to that size and is centred in the box. Card thumbnails and custom frames (A5 / A8 / plates) keep
  // filling the box.
  const stdDen = sheetScale(ctx, opts.card).den;
  const sc = stdDen ? 1000 / stdDen : mapS / S; // mm per metre
  const mapW = Wm * sc, mapH = Hm * sc;         // map frame follows the site shape (square / W x H / circle)
  // centred on each axis separately, so a rectangular site is centred too (cross-review, Gemini)
  const mapX = SHEET.mapX + (stdDen ? (mapS - mapW) / 2 : 0);
  const mapY = SHEET.mapY + (stdDen ? (mapS - mapH) / 2 : 0);
  const shapeKind = ctx.shape?.kind || "circle";
  const isCircle = shapeKind === "circle";
  const tx = p => [mapX + (p[0] - x0) * sc, mapY + (y1 - p[1]) * sc];
  const mpm = 1 / sc; // metres per mm

  const layerSvg = layer => {
    let body = "";
    for (const it of layer.items) {
      if (it.k === "image") {
        const [a, b] = tx([it.bounds[0], it.bounds[3]]);
        const [c, d] = tx([it.bounds[2], it.bounds[1]]);
        body += `<image ${opts.pdf ? `xlink:href="${it.href}" ` : ""}href="${it.href}" x="${num(a)}" y="${num(b)}" width="${num(c - a)}" height="${num(d - b)}" preserveAspectRatio="none"/>`;
      } else if (it.k === "poly") {
        const fill = (it.fill || "none").replace("PFX", P);
        body += `<path d="${pathOf(it.paintRings || it.rings, tx, true)}" fill="${fill}" fill-rule="evenodd" stroke="${opts.card && it.context && !it.cardStroke ? "none" : it.stroke || "none"}" stroke-width="${num(it.sw ?? .15)}" stroke-linejoin="round"${it.dash ? ` stroke-dasharray="${it.dash}"` : ""}${it.op != null ? ` opacity="${it.op}"` : ""}/>`;
      } else if (it.k === "text") {
        const [cx, cy] = tx(it.p);
        if (opts.pdf) {   // svg2pdf has no paint-order / dominant-baseline: halo as its own text, baseline shifted by hand
          const at = `x="${num(cx)}" y="${num(cy + (it.size || 2.6) * .35)}" font-size="${it.size || 2.6}" font-weight="600" text-anchor="middle"`;
          if (it.halo) body += `<text ${at} fill="none" stroke="${it.halo}" stroke-width=".7" stroke-linejoin="round">${esc(it.text)}</text>`;
          body += `<text ${at} fill="${it.fill}">${esc(it.text)}</text>`;
        } else body += `<text x="${num(cx)}" y="${num(cy)}" font-size="${it.size || 2.6}" font-weight="600" text-anchor="middle" dominant-baseline="central" fill="${it.fill}" stroke="${it.halo || "none"}" stroke-width=".7" stroke-linejoin="round" paint-order="stroke">${esc(it.text)}</text>`;
      } else if (it.k === "dot") {
        const [cx, cy] = tx(it.p);
        body += `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(Math.max(it.r / mpm, .25))}" fill="${it.fill || "none"}" stroke="${it.stroke || "none"}" stroke-width="${num(it.sw ?? .1)}"${it.op != null ? ` opacity="${it.op}"` : ""}/>`;
      } else if (it.k === "line") {
        body += `<path d="${pathOf([it.pts], tx, false)}" fill="none" stroke="${it.stroke}" stroke-width="${num(it.sw)}" stroke-linecap="${it.cap || "round"}" stroke-linejoin="round"${it.dash ? ` stroke-dasharray="${it.dash}"` : ""}${it.op != null ? ` opacity="${it.op}"` : ""}/>`;
      }
    }
    return `<g id="${P}${layer.id}" data-name="${esc(layer.name || layer.id)}">${body}</g>`;
  };

  // A site that fills the sheet (point + radius) gets a thin ring and a centre dot only;
  // a real polygon site (< 1/3 of the sheet) gets a tint and a full outline.
  const sb = bboxOf(ctx.site.ring);
  const smallSite = Math.max(sb[2] - sb[0], sb[3] - sb[1]) < S / 3;
  const [dotX, dotY] = tx(ctx.center || [(sb[0] + sb[2]) / 2, (sb[1] + sb[3]) / 2]);
  const siteSvg = smallSite
    ? `<g id="${P}site" data-name="대지">` +
      `<path d="${pathOf([ctx.site.ring], tx, true)}" fill="${pal.site}" fill-opacity=".22" stroke="${pal.bg}" stroke-width="1.8" stroke-linejoin="round"/>` +
      `<path d="${pathOf([ctx.site.ring], tx, true)}" fill="none" stroke="${pal.siteLine}" stroke-width="1" stroke-linejoin="round"/></g>`
    : `<g id="${P}site" data-name="대지">` +
      `<path d="${pathOf([ctx.site.ring], tx, true)}" fill="none" stroke="${pal.siteLine}" stroke-width=".45" stroke-dasharray="2.4 1.6" stroke-linejoin="round"/>` +
      `<circle cx="${num(dotX)}" cy="${num(dotY)}" r="1.9" fill="${pal.bg}" fill-opacity=".85"/>` +
      `<circle cx="${num(dotX)}" cy="${num(dotY)}" r="1.1" fill="${pal.siteLine}"/>` +
      `<circle cx="${num(dotX)}" cy="${num(dotY)}" r="3.3" fill="none" stroke="${pal.siteLine}" stroke-width=".35"/></g>`;

  const defs = `<defs>
<pattern id="${P}dots" width="1.8" height="1.8" patternUnits="userSpaceOnUse"><rect width="1.8" height="1.8" fill="${pal.green}"/><circle cx=".9" cy=".9" r=".3" fill="${pal.greenLine}"/></pattern>
<clipPath id="${P}clip">${isCircle
    ? `<circle cx="${num(mapX + mapW / 2)}" cy="${num(mapY + mapH / 2)}" r="${num(Math.min(mapW, mapH) / 2)}"/>`
    : `<rect x="${mapX}" y="${mapY}" width="${num(mapW)}" height="${num(mapH)}"/>`}</clipPath>
${opts.fontCss ? `<style>${opts.fontCss}</style>` : ""}
</defs>`;

  const mapGroup = `<g id="${P}map" clip-path="url(#${P}clip)">` +
    `<rect x="${mapX}" y="${mapY}" width="${num(mapW)}" height="${num(mapH)}" fill="${pal.bg}"/>` +
    sheet.layers.map(layerSvg).join("") + siteSvg + `</g>` +
    // owner: zones clipped at the map edge left a dashed "box" — erase their clip edge and draw one solid hairline frame
    (isCircle
      ? `<circle cx="${num(mapX + mapW / 2)}" cy="${num(mapY + mapH / 2)}" r="${num(Math.min(mapW, mapH) / 2)}" fill="none" stroke="${pal.bg}" stroke-width="1.6"/>` +
        `<circle cx="${num(mapX + mapW / 2)}" cy="${num(mapY + mapH / 2)}" r="${num(Math.min(mapW, mapH) / 2)}" fill="none" stroke="${MUTED}" stroke-width=".25"/>`
      : `<rect x="${mapX}" y="${mapY}" width="${num(mapW)}" height="${num(mapH)}" fill="none" stroke="${pal.bg}" stroke-width="1.6"/>` +
        `<rect x="${mapX}" y="${mapY}" width="${num(mapW)}" height="${num(mapH)}" fill="none" stroke="${MUTED}" stroke-width=".25"/>`);

  const frameDash = def.num === "15" ? ' stroke-dasharray="1.8 1.2"' : "";
  if (opts.card) {
    const edge = isCircle
      ? `<circle cx="${num(mapX + mapW / 2)}" cy="${num(mapY + mapH / 2)}" r="${num(Math.min(mapW, mapH) / 2 - .3)}" fill="none" stroke="${MUTED}" stroke-width=".5"${frameDash}/>`
      : `<rect x="${mapX + .25}" y="${mapY + .25}" width="${num(mapW - .5)}" height="${num(mapH - .5)}" fill="none" stroke="${MUTED}" stroke-width=".5"${frameDash}/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mapX} ${mapY} ${num(mapW)} ${num(mapH)}" font-family='${FONT}'>${defs}${mapGroup}${edge}</svg>`;
  }

  // ---- full A3 sheet ----
  const { w, h, margin, panelX, panelW } = SHEET;
  const px = panelX, pw = panelW;
  let y = SHEET.mapY + 5;
  let panel = `<g id="${P}legend" data-name="범례"><text x="${px}" y="${y}" font-size="3.4" font-weight="600" fill="${INK}">범례</text>`;
  y += 6;
  // The panel between the title and the north arrow is ~170 mm tall: shrink the legend row
  // pitch for long legends and cut notes that would not fit instead of overlapping the arrow.
  const PANEL_END = 205;
  const noteBlocks = (sheet.notes || []).map(n => wrapText(n, 2.9, pw));
  let noteH = noteBlocks.reduce((a, b) => a + b.length * 4.3 + 1.2, 0);
  const rows = Math.max(1, sheet.legend.length);
  let pitch = Math.min(6.6, (PANEL_END - y - noteH - 3) / rows);
  while (pitch < 4.2 && noteBlocks.length > 1) {          // drop the last note first
    noteH -= noteBlocks.pop().length * 4.3 + 1.2;
    pitch = Math.min(6.6, (PANEL_END - y - noteH - 3) / rows);
  }
  pitch = Math.max(3.6, pitch);
  const fs = pitch < 5.2 ? 2.8 : 3.3;
  for (const e0 of sheet.legend) {
    // a site that fills the sheet is drawn as a centre mark only (its boundary lies under the map frame),
    // so the legend shows that mark instead of a red "boundary" box (live review, Gemini)
    const e = e0.kind === "site" && !smallSite ? { ...e0, kind: "sitePoint", label: "대지 중심" } : e0;
    panel += legendSwatch(e, px, y - 3.4 * (fs / 3.3), pal, P);
    const label = e.label + (e.count != null ? `  ${e.count}` : "");
    panel += `<text x="${px + 12}" y="${y}" font-size="${fs}" fill="${INK}">${esc(label)}</text>`;
    y += pitch;
  }
  panel += `</g>`;

  y += 3;
  let notes = `<g id="${P}notes" data-name="비고">`;
  for (const lines of noteBlocks) {
    for (const ln of lines) {
      if (y > 262) break;
      notes += `<text x="${px}" y="${y}" font-size="2.9" fill="${MUTED}">${esc(ln)}</text>`;
      y += 4.3;
    }
    y += 1.2;
  }
  notes += `</g>`;

  // north arrow (true north; map up = Lambert-93 grid north)
  const nx = px + 8, ny = 222;
  const north = `<g id="${P}north" data-name="방위" transform="rotate(${num(ctx.convergence || 0)} ${nx} ${ny})">` +
    `<path d="M${nx} ${ny - 12}L${nx + 4} ${ny + 4}L${nx} ${ny + 1.5}Z" fill="${INK}"/>` +
    `<path d="M${nx} ${ny - 12}L${nx - 4} ${ny + 4}L${nx} ${ny + 1.5}Z" fill="${pal.bg}" stroke="${INK}" stroke-width=".35"/>` +
    `<text x="${nx}" y="${ny - 14}" font-size="4" font-weight="600" text-anchor="middle" fill="${INK}">N</text></g>`;

  const bar = niceBar(mpm);
  const bx = px, by = 252, half = bar.mm / 2;
  const scale = `<g id="${P}scalebar" data-name="스케일 바">` +
    `<rect x="${bx}" y="${by}" width="${num(half)}" height="2" fill="${INK}" stroke="${INK}" stroke-width=".25"/>` +
    `<rect x="${num(bx + half)}" y="${by}" width="${num(half)}" height="2" fill="${pal.bg}" stroke="${INK}" stroke-width=".25"/>` +
    [0, bar.L / 2, bar.L].map((v, i) =>
      `<text x="${num(bx + i * half)}" y="${by + 6}" font-size="2.8" text-anchor="middle" fill="${INK}">${v}${i === 2 ? " m" : ""}</text>`).join("") +
    `<text x="${bx}" y="${by - 3}" font-size="3" fill="${INK}">Scale 1:${stdDen || Math.round(mpm * 1000 / 50) * 50} (A3 기준)</text></g>`;

  const src = [
    "© IGN — Géoplateforme (WFS / WMS-R), BD TOPO® V3",
    ...(sheet.sources || []),
    `조회일 ${ctx.date} · 좌표계 RGF93 / Lambert-93`,
    "참고용 도면 · 법적 효력 없음"
  ];
  let sy = 268;
  let source = `<g id="${P}source" data-name="출처">`;
  for (const s of src) {
    for (const ln of wrapText(s, 2.7, pw)) {
      source += `<text x="${px}" y="${sy}" font-size="2.7" fill="${MUTED}">${esc(ln)}</text>`;
      sy += 3.8;
    }
  }
  source += `</g>`;

  const title = `<g id="${P}title" data-name="제목">` +
    `<text x="${margin}" y="19" font-size="7" font-weight="600" fill="${INK}">${esc(def.num)}  ${esc(def.ko || def.fr)}</text>` +
    `<text x="${margin + 0}" y="25.5" font-size="3.6" fill="${MUTED}">${esc(ctx.address || "")}  ·  ${esc(ctx.radiusLabel || "")}</text></g>`;

  const frame = isCircle
    ? `<circle id="${P}frame" cx="${num(mapX + mapW / 2)}" cy="${num(mapY + mapH / 2)}" r="${num(Math.min(mapW, mapH) / 2)}" fill="none" stroke="${INK}" stroke-width=".35"${frameDash}/>`
    : `<rect id="${P}frame" x="${mapX}" y="${mapY}" width="${num(mapW)}" height="${num(mapH)}" fill="none" stroke="${INK}" stroke-width=".35"${frameDash}/>`;
  const foot = `<text x="${margin}" y="${h - 5}" font-size="2.6" fill="${MUTED}">Terrain · Atelier 4·2</text>`;

  const full = `<svg xmlns="http://www.w3.org/2000/svg"${opts.pdf ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : ""} viewBox="0 0 ${w} ${h}" ` +
    (opts.absoluteSize ? `width="${w}mm" height="${h}mm" ` : "") +
    (opts.pdf ? `font-family="Noto Sans KR"` : `font-family='${FONT}'`) + `><title>${esc(def.num + " " + (def.ko || def.fr))}</title>${defs}` +
    `<rect id="${P}paper" width="${w}" height="${h}" fill="${pal.bg}"/>` +
    title + mapGroup + frame + panel + notes + north + scale + source + foot + `</svg>`;
  return opts.pdf ? full.replace(/font-weight="600"/g, 'font-weight="bold"') : full;
}

// ---- PNG --------------------------------------------------------------------
// Cache the promise itself so concurrent PNG exports share one download
// (caching "" up front made simultaneous callers get no font).
let fontCssPromise = null;
export function loadFontCss() {
  if (!fontCssPromise) fontCssPromise = fetchFontCss();
  return fontCssPromise;
}
async function fetchFontCss() {
  let fontCssCache = "";
  try {
    const parts = [];
    for (const wt of [400, 600]) {
      const r = await fetch(`https://cdn.jsdelivr.net/fontsource/fonts/noto-sans@latest/latin-${wt}-normal.woff2`);
      if (!r.ok) throw new Error("font");
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = ""; for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
      parts.push(`@font-face{font-family:"Noto Sans";font-weight:${wt};src:url(data:font/woff2;base64,${btoa(bin)}) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215;}`);
    }
    // Hangul (Noto Sans KR). Optional: PNG falls back to a system Korean font if this fails.
    try {
      for (const wt of [400, 600]) {
        const r = await fetch(`https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-kr@latest/korean-${wt}-normal.woff2`);
        if (!r.ok) throw new Error("font");
        const buf = new Uint8Array(await r.arrayBuffer());
        let bin = ""; for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
        parts.push(`@font-face{font-family:"Noto Sans KR";font-weight:${wt};src:url(data:font/woff2;base64,${btoa(bin)}) format("woff2");unicode-range:U+1100-11FF,U+3000-303F,U+3130-318F,U+AC00-D7A3,U+FF00-FFEF;}`);
      }
    } catch { /* keep latin only */ }
    fontCssCache = parts.join("");
  } catch { fontCssCache = ""; }
  return fontCssCache;
}

export async function svgToPng(svg, scale = 2, bg = "#fff") {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const W = Math.round(SHEET.w / 25.4 * 96 * scale), H = Math.round(SHEET.h / 25.4 * 96 * scale);
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const c = canvas.getContext("2d");
    c.fillStyle = bg; c.fillRect(0, 0, W, H);
    c.drawImage(img, 0, 0, W, H);
    return await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error("PNG 변환 실패")), "image/png"));
  } finally { URL.revokeObjectURL(url); }
}
