// Scale figures ("점경"): people, trees, car as plain silhouettes drawn for this tool (original path data, nothing copied).
// Pure module (no DOM, no imports) so the board, the export and the node tests share one source.
// Every figure is drawn in its own unit box: height = 100 units = the real height `hm`, y down, feet / trunk base on y = 100.
// parts: { d, k: "f" } solid fill (evenodd) | { d, k: "s", w } stroke, w in units (proportional) or { abs } mm (print-safe line)
// Default look is OUTLINE (drawing style v02: line only): `outline` parts when a figure has its own, else every filled part stroked at OUT_MM.
// Solid silhouettes (`parts`) stay available as the optional "fill" (st.fill).
export const FIG_INK = "#1E2124", FIG_SOFT = "#7D848D", FIG_ACCENT = "#E6B89C";
export const FIG_TONES = ["ink", "soft"];

const circ = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 1 ${2 * r} 0a${r} ${r} 0 1 1 ${-2 * r} 0Z`;   // clockwise
const head = (cx, cy, r) => circ(cx, cy, r);

// ---- people (elevation) ------------------------------------------------------------------------------------------------
const STAND_1 = head(15, 7, 6.2) + "M9.5 16H20.5Q26 16 26 21.5V48H23.5V50.5L22.6 100H16.4L15 57L13.6 100H7.4L6.5 50.5V48H4V21.5Q4 16 9.5 16Z";
const STAND_2 = head(15, 7, 6.2) + "M10 16H20Q24.5 16 24.5 21L27 62H3L5.5 21Q5.5 16 10 16Z" + "M10.2 62H14V100H10.2Z" + "M16 62H19.8V100H16Z";
const WALK_1 = head(19, 7, 6.2) + "M14.5 16H23Q25 16 25.2 19L26 50H13.5L13.2 19Q13.4 16 14.5 16Z" +
  "M13.6 49H20.4L12.8 100H5.2Z" + "M16.4 49H23.2L32.6 100H25Z" +
  "M14.2 18.5L17.6 18.5L13.2 44L10.2 43Z" + "M21 18.5L24.2 18.5L29 42L26.2 43.4Z";
const WALK_2 = head(18, 7, 6.2) + "M13 16H22.5Q25.5 16 25.5 20L28.5 66H9.5L10.5 20Q10.5 16 13 16Z" +
  "M12.2 65H18L13.5 100H8Z" + "M17 65H22.8L29 100H23.4Z";
const SIT_1 = head(14, 7, 6.2) + "M8.5 16H19.5Q23 16 23.6 20L25 56H7.5L6.5 21Q6.5 16 8.5 16Z" +
  "M7.5 54H46V100H37.6V66H7.5Z" + "M16 19.5L20.4 19.5L33 50L28.6 53Z";
const CHILD = head(13, 9.5, 8.2) + "M8 19.5H18Q22 19.5 22 24V52H19.8V54L18.6 100H14L13 63L12 100H7.4L6.2 54V52H4V24Q4 19.5 8 19.5Z";

// ---- bicycle, wheelchair, car (side views, facing right) ---------------------------------------------------------------
const BIKE = [
  { k: "s", w: 2.6, d: circ(30, 69, 29) + circ(130, 69, 29) },
  { k: "s", w: 2.4, d: "M30 69L62 40L112 38L130 69M70 70L62 40M70 70L112 38M30 69L70 70M112 38L111 6M104 4H119M61 40V32M53 31H69M70 70L76 82M72 82H80" }
];
const WHEELCHAIR = [
  { k: "f", d: head(28, 8, 6.5) + "M21 17H34Q37.5 17 38 21L40 56H19L19.5 21Q19.5 17 21 17Z" + "M19 52H64V63H19Z" + "M53 52H64L67 82H59Z" + "M58 80H73V86H58Z" },
  { k: "s", w: 2.2, d: circ(28, 76, 24) + circ(74, 93, 7) + "M15 24L16 56L62 58M15 24H6M64 66L69 88" }
];
const CAR = [
  { k: "f", eo: true, d: "M3 88V70Q3 62 12 60L56 54Q70 30 84 10Q88 2 98 2H176Q188 2 196 12L222 50L274 58Q290 62 290 72V88Z" +
      "M92 14Q94 10 99 10H128V46H72Z" + "M134 10H174Q180 10 184 16L204 46H134Z" },
  { k: "f", d: circ(62, 79, 21) + circ(228, 79, 21) }
];

// ---- trees (elevation) -------------------------------------------------------------------------------------------------
const ell = (cx, cy, rx, ry) => `M${cx - rx} ${cy}a${rx} ${ry} 0 1 1 ${2 * rx} 0a${rx} ${ry} 0 1 1 ${-2 * rx} 0Z`;
const TREE_BIG = ell(45, 35, 45, 35) + "M42.2 66H47.8V100H42.2Z";   // solid (fill option)
const TREE_SMALL = ell(35, 36, 33, 36) + "M32.6 68H37.4V100H32.6Z";
const TREE_CONIFER = "M20 0L33 40H29L40 78H23.2V100H16.8V78H0L11 40H7Z";
const TREE_STREET = ell(25, 34, 22, 34) + "M22.6 66H27.4V100H22.6Z";

// ---- trees (plan view): hm = crown diameter ----------------------------------------------------------------------------
const PLAN_ABS = 0.18;   // mm, constant line weight whatever the scale
const PLAN_CIRCLE = [{ k: "s", abs: PLAN_ABS, d: circ(50, 50, 49.5) }];
const PLAN_DASH = [{ k: "s", abs: PLAN_ABS, dash: [1.4, 1], d: circ(50, 50, 49.5) }];
const branches = () => {   // three limbs 120 deg apart, each forking once; ends stay inside the crown line
  const pt = (ang, r) => [50 + r * Math.cos(ang * Math.PI / 180), 50 + r * Math.sin(ang * Math.PI / 180)].map(v => Math.round(v * 10) / 10).join(" ");
  let d = "";
  for (const a of [-90, 30, 150]) d += `M50 50L${pt(a, 40)}M${pt(a, 22)}L${pt(a - 30, 38)}M${pt(a, 22)}L${pt(a + 30, 38)}`;
  return d;
};
const PLAN_BRANCH = [
  { k: "s", abs: PLAN_ABS, d: circ(50, 50, 49.5) },
  { k: "s", abs: 0.13, d: branches() }
];

const P = (d) => [{ k: "f", d }];

// ---- outline versions ----------------------------------------------------------------------------------------------------
export const OUT_MM = 0.13;   // paper line weight of figure outlines, constant at every scale (like the plan trees)
const rd = v => Math.round(v * 10) / 10;
/** closed, slightly irregular crown outline (smooth Catmull-Rom through lobed radii); deterministic per seed */
function crown(cx, cy, rx, ry, seed, n = 14) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * 2 * Math.PI, m = 1 + 0.07 * Math.sin(3 * a + seed) + 0.05 * Math.sin(5 * a + 2 * seed);
    pts.push([cx + rx * m * Math.cos(a), cy + ry * m * Math.sin(a)]);
  }
  let d = `M${rd(pts[0][0])} ${rd(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i + n - 1) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    d += `C${rd(p1[0] + (p2[0] - p0[0]) / 6)} ${rd(p1[1] + (p2[1] - p0[1]) / 6)} ${rd(p2[0] - (p3[0] - p1[0]) / 6)} ${rd(p2[1] - (p3[1] - p1[1]) / 6)} ${rd(p2[0])} ${rd(p2[1])}`;
  }
  return d + "Z";
}
const trunk = (x0, x1, y0) => `M${x0} 100V${y0}M${x1} 100V${y0 - 0.5}`;   // two lines from the ground up into the crown
const OS = d => ({ k: "s", abs: OUT_MM, d });
const O_TREE_BIG = [OS(crown(45, 35, 43, 33, 0.6)), OS(trunk(42.2, 47.8, 66.5))];
const O_TREE_SMALL = [OS(crown(35, 36, 31, 34, 2.1)), OS(trunk(32.6, 37.4, 67))];
const O_TREE_STREET = [OS(crown(25, 34, 21, 32, 4.0)), OS(trunk(22.6, 27.4, 65))];
const O_CAR = [
  OS("M41 88H3V70Q3 62 12 60L56 54Q70 30 84 10Q88 2 98 2H176Q188 2 196 12L222 50L274 58Q290 62 290 72V88H249M207 88H83"),   // wheel arches left open
  OS("M92 14Q94 10 99 10H128V46H72ZM134 10H174Q180 10 184 16L204 46H134Z"),
  OS(circ(62, 79, 20) + circ(228, 79, 20) + circ(62, 79, 7) + circ(228, 79, 7))
];
// key -> { cat, hm default (m), W unit width at height 100, parts, plan?, tip: short description for the sheet }
export const FIGS = {
  fig_stand_1: { cat: "person", hm: 1.75, W: 30, parts: P(STAND_1) },
  fig_stand_2: { cat: "person", hm: 1.75, W: 30, parts: P(STAND_2) },
  fig_walk_1: { cat: "person", hm: 1.75, W: 38, parts: P(WALK_1) },
  fig_walk_2: { cat: "person", hm: 1.75, W: 38, parts: P(WALK_2) },
  fig_sit_1: { cat: "person", hm: 1.30, W: 48, parts: P(SIT_1) },
  fig_child: { cat: "person", hm: 1.20, W: 26, parts: P(CHILD) },
  fig_bike: { cat: "person", hm: 1.10, W: 160, parts: BIKE },
  fig_wheelchair: { cat: "person", hm: 1.25, W: 82, parts: WHEELCHAIR },
  fig_car: { cat: "car", hm: 1.50, W: 293.33, parts: CAR, outline: O_CAR },
  fig_tree_big: { cat: "tree", hm: 14, W: 90, parts: P(TREE_BIG), outline: O_TREE_BIG },
  fig_tree_small: { cat: "tree", hm: 6, W: 66, parts: P(TREE_SMALL), outline: O_TREE_SMALL },
  fig_tree_conifer: { cat: "tree", hm: 10, W: 40, parts: P(TREE_CONIFER) },
  fig_tree_street: { cat: "tree", hm: 10, W: 44, parts: P(TREE_STREET), outline: O_TREE_STREET },
  fig_plan_circle: { cat: "plan", hm: 6, W: 100, plan: true, parts: PLAN_CIRCLE },
  fig_plan_dash: { cat: "plan", hm: 6, W: 100, plan: true, parts: PLAN_DASH },
  fig_plan_branch: { cat: "plan", hm: 6, W: 100, plan: true, parts: PLAN_BRANCH }
};
export const FIG_KEYS = Object.keys(FIGS);
export const FIG_GROUPS = { people: FIG_KEYS.filter(k => FIGS[k].cat === "person"), trees: FIG_KEYS.filter(k => FIGS[k].cat === "tree" || FIGS[k].cat === "car"), plan: FIG_KEYS.filter(k => FIGS[k].cat === "plan") };
export const TREE_PRESETS = [6, 10, 14];
export const isFigStamp = k => Object.prototype.hasOwnProperty.call(FIGS, k);
export const isPlanFig = k => !!FIGS[k]?.plan;
export const HM_MIN = 0.1, HM_MAX = 60;
export const clampHm = (v, d = 1.75) => { v = Number(v); return Number.isFinite(v) ? Math.min(HM_MAX, Math.max(HM_MIN, v)) : d; };

const f2 = n => String(Math.round(n * 1000) / 1000);
/** card size in mm of a figure of real height hm drawn at 1:den (width follows the figure's own proportion) */
export function figBox(key, hm, den) {
  const g = FIGS[key]; if (!g) return null;
  const h = clampHm(hm, g.hm) * 1000 / Math.max(1, den);
  return { w: Math.round(h * g.W) / 100 || 0, h: Math.round(h * 1000) / 1000 };
}
export const figH = (hm, den) => clampHm(hm) * 1000 / Math.max(1, den);   // mm
/** vector drawing in card-local mm: figure fitted to st.h (width centred in st.w), optional mirror */
export function figSvg(st, opt = {}) {
  const g = FIGS[st.stamp]; if (!g) return "";
  const col = st.tone === "soft" ? FIG_SOFT : FIG_INK, h = st.h, s = h / 100, w = st.w, x0 = (w - g.W * s) / 2;
  const hair = opt.hair || 0, solid = st.fill === true || g.plan;   // outline unless the "fill" option is on
  const parts = solid ? g.parts : (g.outline || g.parts.map(p => ({ k: "s", abs: OUT_MM, d: p.d })));
  let o = "";
  for (const p of parts) {
    if (p.k === "f") o += `<path d="${p.d}" fill="${col}" fill-rule="${p.eo ? "evenodd" : "nonzero"}"/>`;
    else {
      const wmm = p.abs != null ? Math.max(p.abs, hair) : Math.max(p.w * s, hair || 0.12);
      const dash = p.dash ? ` stroke-dasharray="${f2(p.dash[0] / s)} ${f2(p.dash[1] / s)}"` : "";
      o += `<path d="${p.d}" fill="none" stroke="${col}" stroke-width="${f2(wmm / s)}" stroke-linejoin="round" stroke-linecap="round"${dash}/>`;
    }
  }
  const flip = st.flip ? `translate(${f2(w)} 0) scale(-1 1) ` : "";
  return `<g transform="${flip}translate(${f2(x0)} 0) scale(${Math.round(s * 1e6) / 1e6})">${o}</g>`;
}
