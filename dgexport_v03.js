// Shared preparation for the CAD exports (DXF, 3dm): turns a diagram sheet into plain,
// colour-resolved layers + text lists in model coordinates (EPSG:2154 metres).
// No hatches or fills are exported (owner rule v02): closed outlines only.
import { SHEET, hex2rgb, wrapText, sheetScale } from "./dgcore_v04.js?v=20261115f";

export const WEIGHTS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
// sheet stroke width (mm) -> nearest standard CAD lineweight, in 1/100 mm
export const stdWeight = mm => {
  const v = Math.max(0, mm) * 100;
  return WEIGHTS.reduce((b, w) => Math.abs(w - v) < Math.abs(b - v) ? w : b, 0);
};

const valid = c => typeof c === "string" && /^#[0-9a-f]{3,6}$/i.test(c);
export const norm = c => { const [r, g, b] = hex2rgb(c); return "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join(""); };
export const itemColor = (it, pal) => valid(it.stroke) ? norm(it.stroke) : valid(it.fill) ? norm(it.fill) : norm(pal.text);

// CAD layer name: upper case, CAD-forbidden characters replaced, unique within one file
export function cadName(id, used) {
  let n = String(id).toUpperCase().replace(/[^A-Z0-9_$-]/g, "_").slice(0, 80) || "L";
  let k = n, i = 2;
  while (used.has(k)) k = `${n}_${i++}`;
  used.add(k);
  return k;
}

// v03: exact customary scale when the sheet has one (same rule as renderSvg), else the old rounded label
export const scaleLabel = (mpm, den = null) => den ? `축척 1:${den} (A3 인쇄 시)` : `축척 약 1:${Math.round(mpm * 1000 / 50) * 50} (A3 인쇄 시)`;

// -> { mpm, layers:[{id,cad,name,color,sw,items}], texts:[{role,layer,p,h,text,color}] }
// layers include the sheet layers (poly/line/dot only), SITE, EXTENT and LEGEND swatches.
export function prepareSheet(def, sheet, ctx, pal) {
  const [x0, y0, x1, y1] = ctx.extent;
  const { den, mpm } = sheetScale(ctx);                      // metres per sheet millimetre
  const used = new Set(["TEXT", "TITLE", "LEGEND", "SITE", "EXTENT", "0"]);
  const layers = [], texts = [];
  for (const l of sheet.layers) {
    const items = [];
    for (const it of l.items) {
      if (it.k === "poly") {
        items.push({ k: "poly", rings: it.rings.filter(r => r.length >= 3), color: itemColor(it, pal), sw: it.stroke && it.stroke !== "none" ? it.sw ?? .15 : 0.1, dash: it.dash || null, bld: it.bld || null });
      } else if (it.k === "line") {
        if (it.pts.length >= 2) items.push({ k: "line", pts: it.pts, color: itemColor(it, pal), sw: it.sw ?? .2, dash: it.dash || null });
      } else if (it.k === "dot") {
        items.push({ k: "dot", p: it.p, r: it.r, color: itemColor(it, pal), sw: it.sw ?? .1 });
      } else if (it.k === "text") {
        texts.push({ role: "label", layer: "TEXT", p: it.p, h: it.hm || 4, text: String(it.text), color: valid(it.fill) ? norm(it.fill) : norm(pal.text) });
      }
    }
    if (!items.length) continue;
    const first = items[0];
    layers.push({ id: l.id, cad: cadName(l.id, used), name: l.name || l.id, color: first.color, sw: first.sw, dash: first.dash, items });
  }
  // A complete plate already contains its border, scale, title and legend.
  if (ctx.paperMm) return { mpm: 1, layers, texts, ext: ctx.extent };
  const ink = norm(pal.text), edge = norm(pal.siteLine);
  const ring = ctx.site.ring;
  if (ring && ring.length >= 3) layers.push({ id: "site", cad: "SITE", name: "대지 경계", color: edge, sw: 0.45, items: [{ k: "poly", rings: [ring], color: edge, sw: 0.45, dash: null }] });
  layers.push({ id: "extent", cad: "EXTENT", name: "분석 범위", color: ink, sw: 0.25, items: [{ k: "poly", rings: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]], color: ink, sw: 0.25, dash: null }] });

  // title block below the extent, legend + notes to the right of it (real coordinates)
  const T = (role, layer, x, y, h, text, color = ink) => texts.push({ role, layer, p: [x, y], h: h * mpm, text, color });
  let y = y0 - 8 * mpm;
  T("title", "TITLE", x0, y, 7, `${def.num}  ${def.ko || def.fr}`); y -= 8 * mpm;
  T("title", "TITLE", x0, y, 3.6, `${ctx.address || ""}  ·  ${ctx.radiusLabel || ""}`); y -= 6 * mpm;
  T("title", "TITLE", x0, y, 3, `${scaleLabel(mpm, den)} · 좌표계 RGF93 / Lambert-93 (EPSG:2154) · 단위 m`); y -= 5.5 * mpm;
  const src = ["© IGN — Géoplateforme (WFS / WMS-R), BD TOPO® V3", ...(sheet.sources || []), `조회일 ${ctx.date}`, "참고용 도면이며 법적 효력이 없습니다."];
  for (const s of src) { T("title", "TITLE", x0, y, 2.7, s); y -= 4.2 * mpm; }

  const lx = x1 + 10 * mpm;
  let ly = y1 - 4 * mpm;
  T("legend", "LEGEND", lx, ly, 3.4, "범례"); ly -= 7 * mpm;
  const swatches = [];
  for (const e of sheet.legend || []) {
    const col = e.kind === "site" ? edge : valid(e.stroke) ? norm(e.stroke) : valid(e.fill) ? norm(e.fill) : ink;
    const a = 9 * mpm, b = 4.6 * mpm;
    if (e.kind === "line") swatches.push({ k: "line", pts: [[lx, ly + b / 2], [lx + a, ly + b / 2]], color: col, sw: Math.max(e.sw || .3, .15), dash: e.dash || null });
    else if (e.kind === "dot") swatches.push({ k: "dot", p: [lx + a / 2, ly + b / 2], r: 1.5 * mpm, color: col, sw: .2 });
    else if (e.stroke !== "none" || valid(e.fill)) swatches.push({ k: "poly", rings: [[[lx, ly], [lx + a, ly], [lx + a, ly + b], [lx, ly + b]]], color: col, sw: .2, dash: e.dash || null });
    T("legend", "LEGEND", lx + 12 * mpm, ly + 1 * mpm, 3.3, e.label + (e.count != null ? `  ${e.count}` : ""));
    ly -= 6.4 * mpm;
  }
  layers.push({ id: "legend", cad: "LEGEND", name: "범례", color: ink, sw: 0.2, items: swatches });
  ly -= 3 * mpm;
  for (const n of sheet.notes || []) {
    for (const ln of wrapText(n, 2.9, SHEET.panelW)) { T("legend", "LEGEND", lx, ly, 2.9, ln); ly -= 4.3 * mpm; }
    ly -= 1.2 * mpm;
  }
  // bounds of everything written (extent, title block, legend)
  const ext = [x0, y0 - 9 * mpm - 20 * mpm, lx + (SHEET.panelW + 2) * mpm, y1 + 2 * mpm];
  ext[1] = Math.min(ext[1], y - 2 * mpm, ly - 2 * mpm);
  return { mpm, layers, texts, ext };
}
