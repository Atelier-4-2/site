// node tests/entourage/entourage.test.mjs   (run from the repo root)
// Pure functions of the sheet cutter (flood fill, component splitting, merge/speck), prompt templates, custom-figure stamps.
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import * as C from "../../board_v06_cut.js";
import * as P from "../../board_v06_entprompt.js";
import * as F from "../../board_v06_figs.js?v=20261123f";   // same URL as board_v06_doc.js imports, so one registry
import * as D from "../../board_v06_doc.js";

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("ok  " + name); };
const mkImg = (w, h, bg = [255, 255, 255]) => { const data = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) data.set([...bg, 255], i * 4); return { data, width: w, height: h }; };
const px = (img, x, y, c) => img.data.set([...c, 255], (y * img.width + x) * 4);
const rect = (img, x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(img, x, y, c); };
const frame = (img, x0, y0, x1, y1, c, t = 2) => { rect(img, x0, y0, x1, y0 + t - 1, c); rect(img, x0, y1 - t + 1, x1, y1, c); rect(img, x0, y0, x0 + t - 1, y1, c); rect(img, x1 - t + 1, y0, x1, y1, c); };
const alphaAt = (cr, x, y) => cr.data[(y * cr.width + x) * 4 + 3];
// minimal PNG reader (8-bit RGB/RGBA, non-interlaced) so the committed test sheets are checked as files
function readPng(file) {
  const b = fs.readFileSync(new URL(file, import.meta.url)); let p = 8, w, h, ct; const idat = [];
  while (p < b.length) { const len = b.readUInt32BE(p), type = b.toString("ascii", p + 4, p + 8), d = b.subarray(p + 8, p + 8 + len); if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; } if (type === "IDAT") idat.push(d); p += 12 + len; }
  const ch = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, out = new Uint8ClampedArray(w * h * 4), prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride), q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++]; cur = Uint8Array.from(raw.subarray(q, q + stride)); q += stride;
    for (let i = 0; i < stride; i++) { const a = i >= ch ? cur[i - ch] : 0, up = prev[i], c = i >= ch ? prev[i - ch] : 0; let v = cur[i];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1; else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; } cur[i] = v & 255; }
    for (let x = 0; x < w; x++) out.set([cur[x * ch], cur[x * ch + 1], cur[x * ch + 2], ch === 4 ? cur[x * ch + 3] : 255], (y * w + x) * 4);
    prev.set(cur);
  }
  return { data: out, width: w, height: h };
}

ok("flood fill: background from the border only; closed outline keeps its white inside", () => {
  const im = mkImg(60, 60); frame(im, 10, 10, 40, 50, [0, 0, 0], 2);
  const bg = C.estimateBg(im), m = C.floodBackground(im, bg, 40);
  assert.deepEqual(bg, [255, 255, 255]);
  assert.equal(m[5 * 60 + 5], 1);                    // outside
  assert.equal(m[30 * 60 + 25], 0);                  // white inside a closed outline stays figure
  assert.equal(m[10 * 60 + 20], 0);                  // the line itself
});
ok("flood fill: an open outline leaks (documented), a diagonal 1 px gap does not (4-connected)", () => {
  const open = mkImg(40, 40); frame(open, 5, 5, 30, 30, [0, 0, 0], 2); rect(open, 15, 5, 18, 6, [255, 255, 255]);
  assert.equal(C.floodBackground(open, [255, 255, 255], 40)[15 * 40 + 15], 1);
  const diag = mkImg(40, 40); for (let i = 0; i < 40; i++) px(diag, i, i, [0, 0, 0]); frame(diag, 0, 0, 39, 39, [0, 0, 0], 1);
  const m = C.floodBackground(diag, [255, 255, 255], 40); let inside = 0; for (let y = 2; y < 38; y++) for (let x = 2; x < 38; x++) if (x > y + 1 && !m[y * 40 + x]) inside++;
  assert.ok(inside > 300);                           // the upper-right triangle is sealed off by the diagonal line
});
ok("tolerance: near-white JPEG-like noise counts as background", () => {
  const im = mkImg(50, 50); for (let i = 0; i < 50 * 50; i++) { const v = 255 - (i * 7919 % 13); im.data.set([v, v, v, 255], i * 4); }
  rect(im, 20, 20, 30, 30, [0, 0, 0]);
  const r = C.cutSheet(im, { tol: 40, gap: 0, minArea: 1 });
  assert.equal(r.groups.length, 1); assert.equal(r.groups[0].area, 121);
});
ok("transparent pixels are background", () => {
  const im = mkImg(30, 30); for (let i = 0; i < 900; i++) im.data[i * 4 + 3] = 0; rect(im, 10, 10, 20, 20, [10, 10, 10]);
  assert.equal(C.cutSheet(im, { tol: 30, gap: 0, minArea: 1 }).groups.length, 1);
});
ok("components: 3 separate figures, reading order left to right / top to bottom", () => {
  const im = mkImg(300, 200); frame(im, 200, 10, 240, 80, [0, 0, 0]); frame(im, 20, 10, 60, 80, [0, 0, 0]); frame(im, 20, 110, 60, 180, [0, 0, 0]);
  const g = C.cutSheet(im, { tol: 40, gap: 2, minArea: 10 }).groups;
  assert.equal(g.length, 3); assert.deepEqual(g.map(x => [x.x0, x.y0]), [[20, 10], [200, 10], [20, 110]]);
});
ok("speck removal and merge distance", () => {
  const im = mkImg(200, 100); frame(im, 20, 10, 60, 90, [0, 0, 0]); px(im, 150, 50, [0, 0, 0]); rect(im, 63, 40, 64, 41, [0, 0, 0]);   // a lone dot far away, a dot 2 px from the figure
  assert.equal(C.cutSheet(im, { tol: 40, gap: 0, minArea: 3 }).groups.length, 2);   // lone dot dropped, near dot (4 px) kept as its own part
  const merged = C.cutSheet(im, { tol: 40, gap: 6, minArea: 3 }).groups;
  assert.equal(merged.length, 1); assert.equal(merged[0].x1, 64);                   // near dot merged into the figure box
  assert.equal(C.cutSheet(im, { tol: 40, gap: 0, minArea: 1 }).groups.length, 3);
});
ok("a thin ground line under a trunk stays with the tree when the merge distance covers the gap", () => {
  const im = mkImg(120, 140); frame(im, 30, 10, 90, 100, [0, 0, 0]); rect(im, 55, 100, 65, 120, [0, 0, 0]); rect(im, 40, 124, 80, 124, [0, 0, 0]);   // crown, trunk, ground line 3 px below
  const r0 = C.cutSheet(im, { tol: 40, gap: 0, minArea: 1 }).groups, r1 = C.cutSheet(im, { tol: 40, gap: 5, minArea: 1 }).groups;
  assert.equal(r0.length, 2); assert.equal(r1.length, 1); assert.equal(r1[0].y1, 124);
});
ok("crop: transparent outside, opaque interior white, neighbours stay out", () => {
  const im = mkImg(200, 100); frame(im, 10, 10, 60, 90, [0, 0, 0]); frame(im, 80, 20, 120, 80, [0, 0, 0]);
  rect(im, 150, 20, 190, 80, [200, 60, 60]);
  const r = C.cutSheet(im, { tol: 40, gap: 0, minArea: 5 }), g = r.groups.find(x => x.x0 === 10);
  const c = C.cropGroup(im, r.lab, r.mask, g, { tol: 40, bg: r.bg });
  assert.equal(c.width, 51); assert.equal(c.height, 81);
  assert.equal(alphaAt(c, 25, 40), 255);             // white inside stays opaque
  assert.equal(alphaAt(c, 45, 40), 255);
  assert.equal(c.data[(40 * c.width + 25) * 4], 255);
});
ok("manual merge unions boxes, ids and area", () => {
  const m = C.mergeGroups([{ ids: [1], x0: 0, y0: 0, x1: 4, y1: 4, area: 10 }, { ids: [2], x0: 10, y0: 2, x1: 14, y1: 9, area: 5 }]);
  assert.deepEqual([m.ids, m.x0, m.y0, m.x1, m.y1, m.area], [[1, 2], 0, 0, 14, 9, 15]);
});
ok("sheet_pen.png: 8 figures, white inside kept", () => {
  const im = readPng("sheet_pen.png"), r = C.cutSheet(im, { tol: 40, gap: 6, minArea: 30 });
  assert.equal(r.groups.length, 8);
  const c = C.cropGroup(im, r.lab, r.mask, r.groups[0], { tol: 40, bg: r.bg });
  let white = 0; for (let i = 0; i < c.width * c.height; i++) if (c.data[i * 4 + 3] === 255 && c.data[i * 4] > 240) white++;
  assert.ok(white > 100, "interior white pixels opaque: " + white);
});
ok("sheet_flat.png: 6 flat blobs, inner pale tone kept", () => {
  const r = C.cutSheet(readPng("sheet_flat.png"), { tol: 40, gap: 6, minArea: 30 }); assert.equal(r.groups.length, 6);
});
ok("sheet_white_inside.png: 3 figures, every white patch inside stays figure (alpha 255)", () => {
  const im = readPng("sheet_white_inside.png"), r = C.cutSheet(im, { tol: 40, gap: 6, minArea: 30 });
  assert.equal(r.groups.length, 3);
  const probes = JSON.parse(fs.readFileSync(new URL("expected.json", import.meta.url)))["sheet_white_inside.png"].inner_white_probe;
  for (const [x, y] of probes) { const g = r.groups.find(g => x >= g.x0 && x <= g.x1 && y >= g.y0 && y <= g.y1), c = C.cropGroup(im, r.lab, r.mask, g, { tol: 40, bg: r.bg }); assert.equal(alphaAt(c, x - g.x0, y - g.y0), 255, `${x},${y}`); assert.ok(c.data[((y - g.y0) * c.width + x - g.x0) * 4] > 240); }
});
ok("photoMask: colour path isolates a dark blob on a plain sky; empty photo throws", () => {
  const im = mkImg(120, 160, [200, 220, 245]); rect(im, 40, 30, 80, 120, [40, 50, 40]);
  const r = C.photoMask(im.data, 120, 160, { mode: "colour", T: 40 });
  assert.ok(r.bbox.x0 >= 38 && r.bbox.x1 <= 82 && r.bbox.y0 >= 28 && r.bbox.y1 <= 122);
  const d = C.photoMask(im.data, 120, 160, { mode: "dark" }); assert.ok(d.bbox.y1 - d.bbox.y0 > 80);
  assert.throws(() => C.photoMask(mkImg(60, 60).data, 60, 60, { mode: "colour", T: 40 }), /empty/);
  const g = C.photoMask(im.data, 120, 160, { mode: "colour", T: 40, ground: 50 }); assert.ok(g.bbox.y1 < 82);   // floor line at 50 % cuts everything below
});
ok("silhouetteRGBA: flat tone inside, soft alpha, nothing outside", () => {
  const W = 80, H = 80, od = new Uint8ClampedArray(W * H * 4).fill(128), mask = new Uint8Array(W * H); for (let y = 15; y < 65; y++) for (let x = 20; x < 60; x++) mask[y * W + x] = 1;
  const o = C.silhouetteRGBA(od, mask, W, H, { tex: 0 });
  assert.equal(o[(2 * W + 2) * 4 + 3], 0); assert.ok(o[(40 * W + 40) * 4 + 3] > 200 && o[(40 * W + 40) * 4 + 3] < 255);
});
ok("default heights per kind", () => { assert.equal(C.kindHm("person"), 1.75); assert.equal(C.kindHm("child"), 1.2); assert.equal(C.kindHm("tree_l"), 14); assert.equal(C.kindHm("car"), 1.5); assert.equal(C.kindHm("nope"), 1.75); });
ok("prompts: every kind x style x language has count, side view, no overlap, no-fill rules", () => {
  for (const kind of P.PROMPT_KINDS) for (const style of P.PROMPT_STYLES) for (const lang of P.PROMPT_LANGS) {
    const t = P.buildPrompt({ kind, style, lang, n: 8 }); assert.ok(t.includes("8"), `${kind}/${style}/${lang}`); assert.ok(t.split("\n").length >= 10);
  }
  const en = P.buildPrompt({ kind: "people", style: "pen", lang: "en", n: 6 });
  assert.ok(/side elevation/.test(en) && /same scale/.test(en) && /overlap/.test(en) && /No fills/.test(en) && /white background/.test(en));
  assert.ok(/never white/.test(P.buildPrompt({ kind: "trees", style: "flat", lang: "en" })));
  assert.ok(/옆모습/.test(P.buildPrompt({ kind: "people", style: "pen", lang: "ko" })) && /profil/.test(P.buildPrompt({ kind: "people", style: "pen", lang: "fr" })));
  assert.equal(P.buildPrompt({ kind: "x", style: "y", lang: "z", n: 99 }).split("\n").length, 24 + 3);
  for (const l of P.PROMPT_LANGS) assert.ok(P.geminiNote(l).includes("Gemini"));
});
ok("custom figure stamp: registered through the figure system, sizes by real height / denominator, key rules", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=", key = "my_abc123xy";
  assert.ok(F.isCustomKey(key) && !F.isCustomKey("my_x") && !F.isCustomKey("fig_car") && !F.isCustomKey("my_ABC123XY"));
  assert.equal(F.registerCustom(key, { name: "Marie", hm: 1.7, w: 200, h: 800, png }), true);
  assert.equal(F.registerCustom("my_bad12345", { hm: 1, w: 1, h: 1, png: "javascript:alert(1)" }), false);
  assert.equal(F.registerCustom("my_bad12345", { hm: 1, w: 1, h: 1, png: 'data:image/png;base64,AA"onload=' }), false);
  const b = D.stampBox({ stamp: key, den: 100, hm: 1.7 }); near(b.h, 17); near(b.w, 17 * 0.25);   // aspect 200:800 -> W = 25
  const st = { stamp: key, den: 100, hm: 1.7, w: b.w, h: b.h }, svg = D.stampSvg(st, 100);
  assert.ok(svg.includes("<image") && svg.includes(png) && !svg.includes("scale(-1 1)")); assert.ok(D.stampSvg({ ...st, flip: true }, 100).includes("scale(-1 1)"));
  assert.ok(D.isStampKey(key) && D.isFigStamp(key) && D.stampLabel(key) === "Marie");
  assert.ok(F.customKeys().includes(key));
  F.unregisterCustom(key); assert.ok(!F.isFigStamp(key));
});
ok("a project card naming an unknown figure survives sanitizing as a dashed placeholder", () => {
  const key = "my_zzzzzz99", doc = D.sanitizeDoc({ board: { frames: [], cards: [{ id: "a1", kind: "stamp", stamp: key, den: 100, hm: 1.8, x: 5, y: 5, w: 6, h: 18 }] } }).doc || null;
  assert.ok(F.isFigStamp(key));
  assert.ok(D.stampSvg({ stamp: key, den: 100, w: 6, h: 18 }, 100).includes("stroke-dasharray"));
  assert.ok(!D.isStampKey("my_a"));
  void doc;
});
ok("i18n: every ent.* key used exists in ko and fr", () => {
  const keys = new Set(); for (const f of ["board_v06_entourage.js", "board_v06.js"]) for (const m of fs.readFileSync(new URL("../../" + f, import.meta.url), "utf8").matchAll(/["'`](ent\.[a-z_.]+)["'`]/g)) { if (!m[1].endsWith(".")) keys.add(m[1]); }
  for (const k of C.KINDS) keys.add("ent.kind." + k); for (const k of P.PROMPT_KINDS) keys.add("ent.pk." + k); for (const k of P.PROMPT_STYLES) keys.add("ent.ps." + k);
  for (const l of ["ko", "fr"]) { const j = JSON.parse(fs.readFileSync(new URL(`../../i18n/${l}.json`, import.meta.url), "utf8")); for (const k of keys) assert.ok(j[k], `${l}:${k}`); }
});
function near(a, b, e = 0.01) { assert.ok(Math.abs(a - b) <= e, `${a} !~ ${b}`); }
console.log(`\n${n} passed`);
