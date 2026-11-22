// node tests/linework/linework.test.mjs   (run from tools/atelier-site-board)
// Pure parts of board_v06_linework.js: colours, matrices, path data, SVG walking (with a tiny DOM + style shim standing in for
// the browser's getComputedStyle), pdf.js operator list translation, pen grouping, classification, hit test, output SVG.
import assert from "node:assert/strict";
import fs from "node:fs";
import * as L from "../../board_v06_linework.js";

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("ok  " + name); };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} !~ ${b}`);

// ---- tiny XML -> DOM-like tree + style shim ----------------------------------------------------------------------------------
function parseXml(src) {
  const root = { localName: "#doc", children: [], attrs: {}, getAttribute() { return null; }, text: "" };
  const stack = [root], re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[5] != null) { stack[stack.length - 1].text += m[5]; continue; }
    if (!m[2]) continue;
    if (m[1]) { stack.pop(); continue; }
    const attrs = {};
    for (const a of m[3].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = a[2] ?? a[3];
    const el = { localName: m[2], attrs, children: [], parent: stack[stack.length - 1], text: "", getAttribute(k) { return this.attrs[k] ?? null; } };
    Object.defineProperty(el, "textContent", { get() { return this.text + this.children.map(c => c.textContent).join(""); } });
    el.parent.children.push(el);
    if (!m[4]) stack.push(el);
  }
  return root.children[0];
}
function makeStyler(root) {
  const rules = {};
  (function find(e) { if (e.localName === "style") for (const r of e.text.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) rules[r[1]] = Object.fromEntries(r[2].split(";").map(x => x.split(":").map(s => s.trim())).filter(x => x[1]));
    e.children.forEach(find); })(root);
  const INH = ["stroke", "stroke-width", "fill", "stroke-dasharray", "font-size", "text-anchor"];
  const own = e => {
    const o = { ...e.attrs };
    for (const c of String(e.attrs.class || "").split(/\s+/)) Object.assign(o, rules[c] || {});
    for (const d of String(e.attrs.style || "").split(";")) { const [k, v] = d.split(":").map(s => s?.trim()); if (k && v) o[k] = v; }
    return o;
  };
  return el => {
    const chain = []; for (let e = el; e && e.localName !== "#doc"; e = e.parent) chain.unshift(e);
    const cs = { stroke: "none", "stroke-width": "1", fill: "black", "stroke-dasharray": "none", "font-size": "16", "text-anchor": "start" };
    for (const e of chain) { const o = own(e); for (const k of INH) if (o[k] != null) cs[k] = o[k]; }
    const u = own(el);
    return { stroke: cs.stroke, strokeWidth: parseFloat(cs["stroke-width"]), fill: cs.fill, dash: cs["stroke-dasharray"], display: u.display || "inline", fillOpacity: "1", strokeOpacity: "1", fontSize: parseFloat(cs["font-size"]), textAnchor: cs["text-anchor"] };
  };
}

// ---- colours / matrices / paths --------------------------------------------------------------------------------------------------
ok("parseColor", () => {
  assert.equal(L.parseColor("#abc"), "#AABBCC"); assert.equal(L.parseColor("rgb(30, 33, 36)"), "#1E2124"); assert.equal(L.parseColor("none"), null);
  assert.equal(L.parseColor("rgba(0,0,0,0.2)"), null); assert.equal(L.parseColor("url(#g)"), null); assert.equal(L.parseColor("black"), "#000000");
  assert.ok(L.lightness("#000000") < 0.01 && L.lightness("#FFFFFF") > 0.99 && L.lightness("#1E2124") < 0.35 && L.lightness("#EEEEEE") > 0.35);
});
ok("transform parsing", () => {
  const m = L.parseTransform("translate(10 20) scale(2) rotate(90)");
  const p = L.apply(m, 1, 0); near(p[0], 10); near(p[1], 22);
  const r = L.parseTransform("rotate(90 5 5)"); const q = L.apply(r, 10, 5); near(q[0], 5); near(q[1], 10);
  assert.deepEqual(L.parseTransform(""), L.IDENT);
});
ok("path data: relative, H/V, arc, compact flags", () => {
  const s = L.parsePathData("m10 10 h20 v20 h-20 z");
  assert.deepEqual(s.map(x => x.c), ["M", "L", "L", "L", "Z"]); assert.deepEqual(s[2].a, [30, 30]);
  const a = L.parsePathData("M0 0 a10 10 0 0110 10");   // flags without separators
  assert.ok(a.length >= 2 && a.every(x => x.c === "M" || x.c === "C")); near(a.at(-1).a[4], 10); near(a.at(-1).a[5], 10);
  assert.deepEqual(L.parsePathData("M 1 2 L x"), []);
  const g = L.segsToGeom(L.parsePathData("M0 0 L3 4"), L.IDENT); near(g.len, 5); assert.deepEqual(g.bbox, [0, 0, 3, 4]);
});

// ---- SVG walk ---------------------------------------------------------------------------------------------------------------------
const svgText = fs.readFileSync(new URL("./plan_sample.svg", import.meta.url), "utf8");
const root = parseXml(svgText);
const model = L.svgDomToElements(root, makeStyler(root));
ok("svg paper and units (mm root, viewBox 1:1)", () => { assert.deepEqual(model.paper, { w: 420, h: 297 }); });
ok("svg px root unit conversion", () => {
  const r2 = parseXml('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="500"><path d="M0 0 L100 0" stroke="#000" stroke-width="2" fill="none"/></svg>');
  const m = L.svgDomToElements(r2, makeStyler(r2));
  near(m.paper.w, 264.58, 0.01); near(m.elements[0].w_mm, 2 * 25.4 / 96, 0.001); near(m.elements[0].len_mm, 100 * 25.4 / 96, 0.001);
});
const pens = L.buildPens(model.elements, model.paper), res = L.classifyPens(pens, {});
const byKey = k => pens.find(p => p.key.startsWith(k));
ok("sample svg: 4 widths + dashed + text + poche + light tint are all found", () => {
  const widths = [...new Set(pens.filter(p => !p.text && !p.fillOnly && !p.dash).map(p => p.w_mm))].sort((a, b) => b - a);
  assert.deepEqual(widths, [0.7, 0.35, 0.18, 0.09]);
  assert.ok(pens.some(p => p.dash && p.w_mm === 0.18)); assert.ok(pens.some(p => p.text && p.count === 3));
  assert.ok(pens.some(p => p.fillOnly && p.fill === "#000000")); assert.ok(pens.some(p => p.fillOnly && p.fill === "#EEEEEE"));
  assert.ok(model.elements.every(e => e.text || e.d.startsWith("M")));
});
ok("sample svg: transform applied (group translate 20 10)", () => {
  const e = model.elements.find(e => e.w_mm === 0.7 && e.len_mm > 800);   // the outer wall rectangle 300 x 200
  assert.deepEqual(e.bbox, [40, 40, 340, 240]); near(e.len_mm, 1000, 0.01); assert.ok(e.closed);
});
ok("sample svg: classes follow spec section 4", () => {
  const cls = k => res.assign[byKey(k).key].cls;
  assert.equal(cls("0.70|#000000|0|"), "cut"); assert.equal(cls("0.35|#000000|0|"), "part"); assert.equal(cls("0.18|#333333|0|"), "vis"); assert.equal(cls("0.09|#777777|0|"), "thin");
  assert.equal(cls("0.18|#555555|1|"), "hidden"); assert.equal(res.assign.TEXT.cls, "text");
  assert.equal(cls("0.00||0|F:#000000"), "cut"); assert.equal(cls("0.00||0|F:#EEEEEE"), "hide"); assert.equal(res.notice, null);
  assert.equal(res.assign[byKey("0.70|#000000|0|").key].reason.k, "lw.r.top");
});

// ---- classification edge cases ----------------------------------------------------------------------------------------------------
const lp = (w, o = {}) => ({ key: `${w}|#000|0|`, text: false, w_mm: w, stroke: "#000000", fill: null, dash: false, fillOnly: false, count: 10, avgSize: 50, longHoriz: 0, ...o });
ok("classify: n=3, n=2, n=1, within-15%-merge", () => {
  const c3 = L.classifyPens([lp(0.5), lp(0.25), lp(0.1)]).assign; assert.deepEqual(Object.values(c3).map(a => a.cls), ["cut", "vis", "thin"]);
  const c2 = L.classifyPens([lp(0.5), lp(0.1)]).assign; assert.deepEqual(Object.values(c2).map(a => a.cls), ["cut", "thin"]);
  const c1 = L.classifyPens([lp(0.3)]); assert.equal(Object.values(c1.assign)[0].cls, "vis"); assert.equal(c1.notice, "single");
  const cm = L.classifyPens([lp(0.50), lp(0.45), lp(0.2)]).assign; assert.equal(cm["0.5|#000|0|"].cls, "cut"); assert.equal(cm["0.45|#000|0|"].cls, "cut");   // 0.45 >= 0.85 * 0.5
  const c6 = L.classifyPens([lp(0.8), lp(0.5), lp(0.3), lp(0.2), lp(0.12)]).assign; assert.deepEqual(Object.values(c6).map(a => a.cls), ["cut", "part", "vis", "thin", "thin"]);
});
ok("classify: ground exception, hatch fills, white lines", () => {
  const g = L.classifyPens([lp(0.9, { count: 2, longHoriz: 2 }), lp(0.3), lp(0.1)]).assign; assert.equal(g["0.9|#000|0|"].cls, "ground"); assert.equal(g["0.3|#000|0|"].cls, "cut");
  const notG = L.classifyPens([lp(0.9, { count: 2, longHoriz: 1 }), lp(0.3)]).assign; assert.equal(notG["0.9|#000|0|"].cls, "cut");
  const f = L.classifyPens([lp(0, { key: "h", fillOnly: true, fill: "#000000", stroke: null, count: 600, avgSize: 1 }), lp(0, { key: "p", fillOnly: true, fill: "#111111", stroke: null, count: 3, avgSize: 30 }), lp(0, { key: "b", fillOnly: true, fill: "#FFFFFF", stroke: null })]).assign;
  assert.equal(f.h.cls, "hide"); assert.equal(f.p.cls, "cut"); assert.equal(f.b.cls, "hide");
  assert.equal(L.classifyPens([lp(0.2, { key: "w", stroke: "#FFFFFF" })]).assign.w.cls, "hide");
});

// ---- pdf.js operator list ---------------------------------------------------------------------------------------------------------
ok("pdfOpsToElements: ctm, line width scale, dash, colour, fill, rectangle, restore", () => {
  const OPS = Object.fromEntries(["save", "restore", "transform", "constructPath", "setLineWidth", "setDash", "setStrokeRGBColor", "setFillRGBColor", "stroke", "fill", "fillStroke", "endPath", "moveTo", "lineTo", "curveTo", "curveTo2", "curveTo3", "closePath", "rectangle", "paintImageXObject"].map((k, i) => [k, i + 1]));
  const fn = [], ar = [], op = (k, a) => { fn.push(OPS[k]); ar.push(a); };
  op("save"); op("transform", [2, 0, 0, 2, 10, 0]); op("setLineWidth", [1]); op("setStrokeRGBColor", [30, 33, 36]);
  op("constructPath", [[OPS.moveTo, OPS.lineTo], [0, 0, 100, 0]]); op("stroke");
  op("setDash", [[3, 2], 0]); op("constructPath", [[OPS.rectangle], [0, 0, 10, 10]]); op("stroke");
  op("setFillRGBColor", [0, 0, 0]); op("constructPath", [[OPS.rectangle], [0, 0, 10, 10]]); op("fill"); op("restore");
  op("setLineWidth", [0.5]); op("setStrokeRGBColor", [255, 0, 0]); op("constructPath", [[OPS.moveTo, OPS.curveTo, OPS.closePath], [0, 0, 1, 1, 2, 2, 3, 0]]); op("fillStroke"); op("paintImageXObject", ["x"]);
  // page 200x100 pt, viewport flips y: [1 0 0 -1 0 100]
  const r = L.pdfOpsToElements({ fnArray: fn, argsArray: ar }, OPS, [1, 0, 0, -1, 0, 100]);
  assert.equal(r.imageCount, 1); const e = r.elements; assert.equal(e.length, 5);
  near(e[0].w_mm, 2 * L.MM_PER_PT, 0.001); assert.equal(e[0].stroke, "#1E2124"); near(e[0].len_mm, 200 * L.MM_PER_PT, 0.001);
  near(e[0].bbox[0], 10 * L.MM_PER_PT, 0.001); near(e[0].bbox[1], 100 * L.MM_PER_PT, 0.001);   // y flipped
  assert.equal(e[1].dash, true); assert.equal(e[1].closed, true); assert.equal(e[2].stroke, null); assert.equal(e[2].fill, "#000000");
  assert.equal(e[3].stroke, "#FF0000"); assert.equal(e[3].dash, false); near(e[3].w_mm, 0.5 * L.MM_PER_PT, 0.001);   // restore dropped the dash
  assert.equal(e[4].fill, "#000000");   // fill colour set inside the saved block was restored to the default black
});
ok("pdfTextToElements", () => {
  const t = L.pdfTextToElements([{ str: "Hello", transform: [10, 0, 0, 10, 50, 40], width: 30 }, { str: "  ", transform: [1, 0, 0, 1, 0, 0] }], [1, 0, 0, -1, 0, 100]);
  assert.equal(t.length, 1); near(t[0].text.size, 10 * L.MM_PER_PT, 0.001); near(t[0].text.y, 60 * L.MM_PER_PT, 0.001); near(t[0].text.rot, 0);
});

// ---- hit test / output -----------------------------------------------------------------------------------------------------------
ok("hitTest: nearest line, text bbox, filled poche area, hidden skipped", () => {
  const els = model.elements, wall = els.find(e => e.w_mm === 0.7 && e.len_mm > 800);
  assert.equal(L.hitTest(els, 40.3, 100, 1), wall);
  assert.equal(L.hitTest(els, 41, 100, 1, e => e !== wall)?.id !== wall.id, true);
  const txt = els.find(e => e.text?.str === "Séjour"); assert.equal(L.hitTest(els, txt.text.x + 3, txt.text.y - 1, 1), txt);
  const poche = els.find(e => !e.stroke && e.fill === "#000000"); assert.equal(L.hitTest(els, 193.5, 140, 0.5), poche);
  assert.equal(L.hitTest(els, 5, 5, 1), null);
});
const table = L.defaultTable(100);
const clsOf = e => res.assign[e.pen].cls;
const out = L.renderLineworkSvg(model.elements, clsOf, table, model.paper);
ok("output svg: size, class order, widths, colours, dash, font, hide dropped, poche as outline", () => {
  assert.match(out, /^<svg [^>]*width="420mm" height="297mm" viewBox="0 0 420 297">/);
  const order = [...out.matchAll(/data-cls="(\w+)"/g)].map(m => m[1]); assert.deepEqual(order, ["thin", "hidden", "vis", "part", "cut", "text"]);
  assert.match(out, /data-cls="cut" fill="none" stroke="#1E2124" stroke-width="0.25" stroke-linecap="butt" stroke-linejoin="miter"/);
  assert.match(out, /data-cls="vis"[^>]*stroke="#5A6068" stroke-width="0.13"/); assert.match(out, /data-cls="hidden"[^>]*stroke-dasharray="1.5 1"/);
  assert.match(out, /font-family="Noto Sans, Noto Sans KR, sans-serif"/); assert.ok(!out.includes("#EEEEEE"));
  const cutPaths = out.split('data-cls="cut"')[1].split("</g>")[0].match(/<path /g).length; assert.equal(cutPaths, 3);   // outer wall + middle wall + poche outline
});
ok("output svg 1/200 table", () => { assert.match(L.renderLineworkSvg(model.elements, clsOf, L.defaultTable(200), model.paper), /data-cls="cut"[^>]*stroke-width="0.2"/); });
ok("output svg survives well-formed XML + override per element", () => {
  const e0 = model.elements.find(e => e.text); const o = L.renderLineworkSvg(model.elements, e => e === e0 ? "hide" : clsOf(e), table, model.paper);
  assert.ok(!o.includes("Séjour") || e0.text.str !== "Séjour"); assert.ok(L.renderOriginalSvg(model.elements, model.paper).includes("stroke-width=\"0.7\""));
});
fs.writeFileSync(new URL("./out_sample_linework.svg", import.meta.url), out);
console.log(`\n${n} test groups passed; wrote tests/linework/out_sample_linework.svg (${out.length} bytes)`);
