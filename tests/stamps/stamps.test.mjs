// node tests/stamps/stamps.test.mjs   (run from tools/atelier-site-board)
// Scale figures: size maths (real height / denominator), stamp box + svg through board_v06_doc.js, sanitizing, i18n coverage.
import assert from "node:assert/strict";
import fs from "node:fs";
import * as F from "../../board_v06_figs.js";
import * as D from "../../board_v06_doc.js";

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("ok  " + name); };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} !~ ${b}`);

ok("person 1.75 m: 17.5 mm at 1:100, 8.75 mm at 1:200", () => {
  near(F.figBox("fig_stand_1", 1.75, 100).h, 17.5);
  near(F.figBox("fig_stand_1", 1.75, 200).h, 8.75);
  near(F.figBox("fig_stand_1", 1.75, 50).h, 35);
});
ok("width follows the figure proportion (30 : 100)", () => near(F.figBox("fig_stand_1", 1.75, 100).w, 5.25, 0.006));
ok("real sizes per spec: child 1.20, seated 1.30, bike 1.10, wheelchair 1.25, car 1.50 x 4.40, trees 6/10/14", () => {
  const hm = k => F.FIGS[k].hm;
  assert.equal(hm("fig_child"), 1.2); assert.equal(hm("fig_sit_1"), 1.3); assert.equal(hm("fig_bike"), 1.1); assert.equal(hm("fig_wheelchair"), 1.25);
  assert.equal(hm("fig_car"), 1.5); near(F.figBox("fig_car", 1.5, 1000).w / F.figBox("fig_car", 1.5, 1000).h, 4.4 / 1.5, 0.01);
  assert.deepEqual([hm("fig_tree_small"), hm("fig_tree_conifer"), hm("fig_tree_big")], [6, 10, 14]); assert.deepEqual(F.TREE_PRESETS, [6, 10, 14]);
});
ok("counts: 8 people-class, 4 elevation trees, 9 plan trees (+3 legacy ids), 1 car", () => {
  assert.equal(F.FIG_GROUPS.people.length, 8); assert.equal(F.FIG_GROUPS.plan.length, 9);
  assert.equal(F.FIG_GROUPS.trees.filter(k => F.FIGS[k].cat === "tree").length, 4); assert.equal(F.FIG_GROUPS.trees.filter(k => F.FIGS[k].cat === "car").length, 1);
});
ok("every figure has at most 3 path parts and sane unit width", () => {
  for (const k of F.FIG_KEYS) { assert.ok(F.FIGS[k].parts.length <= 3, k); assert.ok(F.FIGS[k].W > 0, k); }
});
ok("height is clamped 0.1 - 60 m", () => { assert.equal(F.clampHm(0), 0.1); assert.equal(F.clampHm(999), 60); assert.equal(F.clampHm("x", 1.75), 1.75); });
ok("stampBox (doc) delegates to figures and keeps bars/ratio", () => {
  near(D.stampBox({ stamp: "fig_walk_1", den: 100, hm: 1.75 }).h, 17.5);
  near(D.stampBox({ stamp: "fig_walk_1", den: 200 }).h, 8.75);   // hm missing -> default
  near(D.stampBox({ stamp: "fig_stand_1", den: 100, hm: 2 }).h, 20);
  assert.deepEqual(D.stampBox({ stamp: "ratio" }), { w: 30, h: 8 });
  assert.equal(D.stampBox({ stamp: "north_arrow" }), null);
});
ok("stamps list contains the figures and labels resolve", () => {
  for (const k of F.FIG_KEYS) { assert.ok(D.STAMPS.includes(k)); assert.ok(!D.STAMP_LABEL[k].startsWith("st.fig"), k + " -> " + D.STAMP_LABEL[k]); }
  assert.ok(D.isFigStamp("fig_car") && !D.isFigStamp("ratio"));
});
ok("stampSvg draws colours #1E2124 / #7D848D, mirror flips", () => {
  const b = D.stampBox({ stamp: "fig_stand_1", den: 100, hm: 1.75 }), st = { stamp: "fig_stand_1", den: 100, hm: 1.75, w: b.w, h: b.h };
  const a = D.stampSvg(st, 100); assert.ok(a.includes("#1E2124") && !a.includes("scale(-1 1)"));
  assert.ok(D.stampSvg({ ...st, tone: "soft" }, 100).includes("#7D848D"));
  assert.ok(D.stampSvg({ ...st, flip: true }, 100).includes("scale(-1 1)"));
  for (const k of F.FIG_KEYS) { const bb = D.stampBox({ stamp: k, den: 100 }); assert.ok(D.stampSvg({ stamp: k, w: bb.w, h: bb.h }, 100).startsWith("<g"), k); }
});
ok("outline is the default look: no solid fill, constant 0.13 mm lines; fill option brings the silhouette back", () => {
  for (const k of F.FIG_KEYS) {
    const b = F.figBox(k, F.FIGS[k].hm, 100), svg = F.figSvg({ stamp: k, w: b.w, h: b.h }), s = b.h / 100;
    assert.ok(!/fill="#1E2124"/.test(svg), k + " has a solid fill"); assert.ok(svg.includes('stroke="#1E2124"'), k);
    for (const m of svg.matchAll(/stroke-width="([\d.]+)"/g)) assert.ok(Number(m[1]) * s >= 0.12 && Number(m[1]) * s <= 0.19, k + " line " + Number(m[1]) * s);
  }
  const b = F.figBox("fig_tree_big", 14, 100), st = { stamp: "fig_tree_big", w: b.w, h: b.h };
  assert.ok(F.figSvg({ ...st, fill: true }).includes('fill="#1E2124"')); assert.ok(F.figSvg({ ...st, tone: "soft" }).includes("#7D848D"));
  for (const den of [50, 100, 500]) { const bb = F.figBox("fig_stand_1", 1.75, den), sv = F.figSvg({ stamp: "fig_stand_1", w: bb.w, h: bb.h }); near(Number(/stroke-width="([\d.]+)"/.exec(sv)[1]) * bb.h / 100, 0.13, 0.005); }
});
ok("broadleaf crown is one closed irregular outline + two trunk lines; conifer outline; car wheels are circles", () => {
  const o = F.FIGS.fig_tree_big.outline; assert.equal(o.length, 2); assert.ok(/Z$/.test(o[0].d) && o[0].d.split("C").length > 10); assert.equal((o[1].d.match(/M/g) || []).length, 2);
  assert.ok(!F.FIGS.fig_tree_conifer.outline);   // auto outline of the triangle-tier silhouette
  assert.ok(F.figSvg({ stamp: "fig_car", w: 10, h: 5 }).split("<path").length > 3);
  assert.equal(D.cleanFig({ stamp: "fig_car", fill: true }).fill, true); assert.equal(D.cleanFig({ stamp: "fig_car", fill: "yes" }).fill, false);
});
ok("plan trees: default crown 4/6/9 m by row, 6 m at 1:200 = 30 mm, legacy ids still draw", () => {
  const dia = k => F.FIGS[k].hm;
  assert.deepEqual(["s1", "s2", "s3", "m1", "m2", "m3", "l1", "l2", "l3"].map(r => dia("fig_plan_a_" + r)), [4, 4, 4, 6, 6, 6, 9, 9, 9]);
  const b = F.figBox("fig_plan_a_m1", 6, 200); near(b.w, 30, 0.01); near(b.h, 30, 0.01);
  for (const k of ["fig_plan_circle", "fig_plan_dash", "fig_plan_branch"]) { assert.ok(F.FIGS[k].legacy && !F.FIG_GROUPS.plan.includes(k)); assert.ok(F.figSvg({ stamp: k, w: 30, h: 30 }).includes("<path")); }
  for (const k of F.FIG_GROUPS.plan) { const sv = F.figSvg({ stamp: k, w: 30, h: 30, tone: "soft" }); assert.ok(sv.includes("#7D848D")); assert.ok(F.FIGS[k].parts.every(p => p.d.length < 3500), k); }
  assert.ok(F.FIGS.fig_plan_a_m2.parts.length === 2 && F.FIGS.fig_plan_a_s1.parts.length === 1);   // dashed crowns carry a separate dash part
});
ok("plan tree lines stay 0.18 mm whatever the scale", () => {
  for (const den of [20, 100, 500]) {
    const b = F.figBox("fig_plan_a_m2", 6, den), svg = F.figSvg({ stamp: "fig_plan_a_m2", w: b.w, h: b.h }), s = b.h / 100;
    const sw = Number(/stroke-width="([\d.]+)"/.exec(svg)[1]) * s;
    near(sw, 0.18, 0.005);
  }
});
ok("sanitizeDoc keeps/cleans figure fields", () => {
  const doc = D.emptyDoc();
  doc.cards.push({ id: "c1", kind: "stamp", stamp: "fig_child", den: 100, hm: 99, flip: 1, tone: "pink", x: 10, y: 10, w: 0.4, h: 12 });
  doc.cards.push({ id: "c2", kind: "stamp", stamp: "fig_bike", den: 100, hm: 1.1, flip: true, tone: "soft", x: 30, y: 10, w: 17.6, h: 11 });
  const out = D.sanitizeDoc(doc), c1 = out.cards.find(c => c.id === "c1"), c2 = out.cards.find(c => c.id === "c2");
  assert.equal(c1.hm, 60); assert.equal(c1.flip, false); assert.equal(c1.tone, "ink"); near(c1.w, 0.4);
  assert.equal(c2.flip, true); assert.equal(c2.tone, "soft"); assert.equal(c2.hm, 1.1);
});
ok("i18n: every figure + panel key exists in ko and fr", () => {
  const keys = ["st.sec", "st.g.people", "st.g.trees", "st.g.plan", "st.height", "st.dia", "st.flip", "st.tone", "st.tone.ink", "st.tone.soft", "st.fill", "st.refit", "st.refit.none", "st.den100", ...F.FIG_KEYS.map(k => "st.fig." + k.slice(4))];
  for (const l of ["ko", "fr"]) { const j = JSON.parse(fs.readFileSync(new URL(`../../i18n/${l}.json`, import.meta.url), "utf8")); for (const k of keys) assert.ok(j[k], `${l}:${k}`); }
});
console.log(`\n${n} tests passed`);
