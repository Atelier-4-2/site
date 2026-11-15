// AutoCAD-valid DXF writer (R2000 / AC1015) for the site diagrams. Hand written, modelled on the
// structure ezdxf writes for R2000: HEADER, CLASSES, TABLES (with BLOCK_RECORD), BLOCKS, ENTITIES,
// OBJECTS (root dictionary, layouts); every object has a unique handle and an owner (330).
// One DXF layer per sheet layer, closed LWPOLYLINEs only (no hatches), TEXT for labels.
import { hex2rgb } from "./dgcore.js?v=20261113s";
import { prepareSheet, stdWeight } from "./dgexport_v03.js?v=20261115m";

// ---- AutoCAD colour index (nearest match of a true colour) ---------------------------------
const ACI = (() => {
  const t = new Map([[1, [255, 0, 0]], [2, [255, 255, 0]], [3, [0, 255, 0]], [4, [0, 255, 255]], [5, [0, 0, 255]], [6, [255, 0, 255]], [8, [128, 128, 128]], [9, [192, 192, 192]]]);
  const hsv = (h, s, v) => {
    const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return [f(5), f(3), f(1)].map(x => Math.round(x * 255));
  };
  for (let n = 10; n <= 249; n++) {
    const hue = Math.floor((n - 10) / 10) * 15, k = (n - 10) % 10;
    t.set(n, hsv(hue, k & 1 ? .5 : 1, [1, .8, .6, .5, .3][k >> 1]));
  }
  [51, 91, 132, 173, 214, 255].forEach((v, i) => t.set(250 + i, [v, v, v]));
  return t;
})();
export function aci(hex) {
  const [r, g, b] = hex2rgb(hex);
  if (r + g + b < 120 || r + g + b > 735) return 7;           // ink / paper: ACI 7 follows the CAD background
  let best = 7, bd = 1e9;
  for (const [k, v] of ACI) {
    const d = (v[0] - r) ** 2 + (v[1] - g) ** 2 + (v[2] - b) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}
const trueColor = hex => { const [r, g, b] = hex2rgb(hex); return (r << 16) | (g << 8) | b; };

// DXF R2000 text is ANSI: non-ASCII characters are written as \U+XXXX
const enc = s => String(s).replace(/[^\x20-\x7e]/g, c => "\\U+" + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")).replace(/[\r\n]+/g, " ");
const n3 = v => (Math.round(v * 1000) / 1000).toFixed(3);

export function toDxf(sheet, ctx, pal, def = { num: "", ko: "" }) {
  const P = prepareSheet(def, sheet, ctx, pal);
  let seed = 0x1;
  const nh = () => (seed++).toString(16).toUpperCase();
  const H = {};
  for (const k of ["tVport", "tLtype", "tLayer", "tStyle", "tView", "tUcs", "tAppid", "tDim", "tBr", "vport", "ltByBlock", "ltByLayer", "ltCont", "ltDash",
    "layer0", "styleStd", "styleNoto", "appid", "dimStd", "brModel", "brPaper", "bModelB", "bModelE", "bPaperB", "bPaperE", "root", "dGroup", "dLayout", "dMline", "dPlotSet",
    "dPlotStyle", "plotNormal", "layoutModel", "layoutPaper", "mlStd"]) H[k] = nh();
  const layerH = P.layers.map(() => nh());
  const extraLayers = ["TEXT", "TITLE"].map(() => nh());

  const lines = [];
  const g = (c, v) => lines.push(String(c), String(v));
  const hdr = [];
  const gh = (c, v) => hdr.push(String(c), String(v));
  let ex0 = Infinity, ey0 = Infinity, ex1 = -Infinity, ey1 = -Infinity;
  const grow = (x, y) => { ex0 = Math.min(ex0, x); ey0 = Math.min(ey0, y); ex1 = Math.max(ex1, x); ey1 = Math.max(ey1, y); };
  const [bx0, by0, bx1, by1] = P.ext;
  grow(bx0, by0); grow(bx1, by1);
  const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
  const viewH = Math.max(by1 - by0, (bx1 - bx0) / 1.6) * 1.08;

  // ---- HEADER (written last: extents come from the entities) ----
  const buildHeader = () => {
  gh(0, "SECTION"); gh(2, "HEADER");
  gh(9, "$ACADVER"); gh(1, "AC1015");
  gh(9, "$DWGCODEPAGE"); gh(3, "ANSI_1252");
  gh(9, "$INSBASE"); gh(10, 0); gh(20, 0); gh(30, 0);
  gh(9, "$EXTMIN"); gh(10, n3(ex0)); gh(20, n3(ey0)); gh(30, 0);
  gh(9, "$EXTMAX"); gh(10, n3(ex1)); gh(20, n3(ey1)); gh(30, 0);
  gh(9, "$LIMMIN"); gh(10, n3(ex0)); gh(20, n3(ey0));
  gh(9, "$LIMMAX"); gh(10, n3(ex1)); gh(20, n3(ey1));
  gh(9, "$LTSCALE"); gh(40, n3(P.mpm * 2));
  gh(9, "$TEXTSTYLE"); gh(7, "NotoSans");
  gh(9, "$CLAYER"); gh(8, "0");
  gh(9, "$CELTYPE"); gh(6, "ByLayer");
  gh(9, "$CECOLOR"); gh(62, 256);
  gh(9, "$CELWEIGHT"); gh(370, -1);
  gh(9, "$LWDISPLAY"); gh(290, 1);
  gh(9, "$DIMSTYLE"); gh(2, "Standard");
  gh(9, "$LUNITS"); gh(70, 2);
  gh(9, "$LUPREC"); gh(70, 4);
  gh(9, "$MEASUREMENT"); gh(70, 1);
  gh(9, "$INSUNITS"); gh(70, ctx.paperMm ? 4 : 6);
  gh(9, "$HANDSEED"); gh(5, "@@SEED@@");
  gh(0, "ENDSEC");
  };

  // ---- CLASSES ----
  g(0, "SECTION"); g(2, "CLASSES");
  for (const [a, b] of [["ACDBDICTIONARYWDFLT", "AcDbDictionaryWithDefault"], ["ACDBPLACEHOLDER", "AcDbPlaceHolder"], ["LAYOUT", "AcDbLayout"]]) {
    g(0, "CLASS"); g(1, a); g(2, b); g(3, "ObjectDBX Classes"); g(90, 0); g(280, 0); g(281, 0);
  }
  g(0, "ENDSEC");

  // ---- TABLES ----
  g(0, "SECTION"); g(2, "TABLES");
  // DIMSTYLE's table head needs its own subclass marker after 70 (AutoCAD 2026 rejects the
  // file otherwise: "class separator expected for AcDbDimStyleTable").
  const table = (name, h, count, body) => {
    g(0, "TABLE"); g(2, name); g(5, h); g(330, 0); g(100, "AcDbSymbolTable"); g(70, count);
    if (name === "DIMSTYLE") { g(100, "AcDbDimStyleTable"); g(71, 0); }
    body(); g(0, "ENDTAB");
  };
  const rec = (type, h, owner, sub) => { g(0, type); g(5, h); g(330, owner); g(100, "AcDbSymbolTableRecord"); g(100, sub); };
  table("VPORT", H.tVport, 1, () => {
    rec("VPORT", H.vport, H.tVport, "AcDbViewportTableRecord");
    g(2, "*Active"); g(70, 0); g(10, 0); g(20, 0); g(11, 1); g(21, 1); g(12, n3(cx)); g(22, n3(cy)); g(13, 0); g(23, 0); g(14, 10); g(24, 10); g(15, 10); g(25, 10);
    g(16, 0); g(26, 0); g(36, 1); g(17, 0); g(27, 0); g(37, 0); g(40, n3(viewH)); g(41, 1.6); g(42, 50); g(43, 0); g(44, 0); g(50, 0); g(51, 0);
    g(71, 0); g(72, 100); g(73, 1); g(74, 3); g(75, 0); g(76, 0); g(77, 0); g(78, 0); g(281, 0); g(65, 1); g(110, 0); g(120, 0); g(130, 0); g(111, 1); g(121, 0); g(131, 0); g(112, 0); g(122, 1); g(132, 0); g(79, 0); g(146, 0);
  });
  table("LTYPE", H.tLtype, 4, () => {
    for (const [k, nm] of [["ltByBlock", "ByBlock"], ["ltByLayer", "ByLayer"], ["ltCont", "Continuous"]]) {
      rec("LTYPE", H[k], H.tLtype, "AcDbLinetypeTableRecord"); g(2, nm); g(70, 0); g(3, nm === "Continuous" ? "Solid line" : ""); g(72, 65); g(73, 0); g(40, 0);
    }
    rec("LTYPE", H.ltDash, H.tLtype, "AcDbLinetypeTableRecord"); g(2, "DASHED"); g(70, 0); g(3, "Dashed __ __ __"); g(72, 65); g(73, 2); g(40, 1);
    g(49, 0.6); g(74, 0); g(49, -0.4); g(74, 0);
  });
  const lwOf = mm => stdWeight(mm);
  table("LAYER", H.tLayer, P.layers.length + 3, () => {
    const lay = (h, name, color, sw, dash) => {
      rec("LAYER", h, H.tLayer, "AcDbLayerTableRecord"); g(2, name); g(70, 0); g(62, aci(color)); g(420, trueColor(color)); g(6, dash ? "DASHED" : "Continuous"); g(370, lwOf(sw)); g(390, H.plotNormal);
    };
    rec("LAYER", H.layer0, H.tLayer, "AcDbLayerTableRecord"); g(2, "0"); g(70, 0); g(62, 7); g(6, "Continuous"); g(370, -3); g(390, H.plotNormal);
    P.layers.forEach((l, i) => lay(layerH[i], l.cad, l.color, l.sw, !!l.dash));
    lay(extraLayers[0], "TEXT", pal.text, 0.18, false);
    lay(extraLayers[1], "TITLE", pal.text, 0.18, false);
  });
  table("STYLE", H.tStyle, 2, () => {
    rec("STYLE", H.styleStd, H.tStyle, "AcDbTextStyleTableRecord"); g(2, "Standard"); g(70, 0); g(40, 0); g(41, 1); g(50, 0); g(71, 0); g(42, 2.5); g(3, "txt"); g(4, "");
    rec("STYLE", H.styleNoto, H.tStyle, "AcDbTextStyleTableRecord"); g(2, "NotoSans"); g(70, 0); g(40, 0); g(41, 1); g(50, 0); g(71, 0); g(42, 2.5); g(3, "NotoSansKR-Regular.ttf"); g(4, "");
  });
  table("VIEW", H.tView, 0, () => {});
  table("UCS", H.tUcs, 0, () => {});
  table("APPID", H.tAppid, 1, () => { rec("APPID", H.appid, H.tAppid, "AcDbRegAppTableRecord"); g(2, "ACAD"); g(70, 0); });
  table("DIMSTYLE", H.tDim, 1, () => {
    g(0, "DIMSTYLE"); g(105, H.dimStd); g(330, H.tDim); g(100, "AcDbSymbolTableRecord"); g(100, "AcDbDimStyleTableRecord");
    g(2, "Standard"); g(70, 0); g(40, 1); g(41, 2.5); g(42, 0.625); g(43, 3.75); g(44, 1.25); g(45, 0); g(46, 0); g(47, 0); g(48, 0);
    g(140, 2.5); g(141, 2.5); g(142, 0); g(143, 0.03937007874); g(144, 1); g(145, 0); g(146, 1); g(147, 0.625); g(71, 0); g(72, 0); g(73, 0); g(74, 0); g(75, 0); g(76, 0); g(77, 1); g(78, 8); g(170, 0); g(171, 3); g(172, 1);
    g(173, 0); g(174, 0); g(175, 0); g(176, 0); g(177, 0); g(178, 0); g(270, 2); g(271, 2); g(272, 2); g(273, 2); g(274, 3); g(340, H.styleStd); g(275, 0); g(280, 0); g(281, 0); g(282, 0); g(283, 0); g(284, 0); g(285, 0); g(286, 0); g(287, 3); g(288, 0);
  });
  table("BLOCK_RECORD", H.tBr, 2, () => {
    rec("BLOCK_RECORD", H.brModel, H.tBr, "AcDbBlockTableRecord"); g(2, "*Model_Space"); g(340, H.layoutModel);
    rec("BLOCK_RECORD", H.brPaper, H.tBr, "AcDbBlockTableRecord"); g(2, "*Paper_Space"); g(340, H.layoutPaper);
  });
  g(0, "ENDSEC");

  // ---- BLOCKS ----
  g(0, "SECTION"); g(2, "BLOCKS");
  for (const [b, e, br, nm] of [[H.bModelB, H.bModelE, H.brModel, "*Model_Space"], [H.bPaperB, H.bPaperE, H.brPaper, "*Paper_Space"]]) {
    g(0, "BLOCK"); g(5, b); g(330, br); g(100, "AcDbEntity"); g(8, "0"); g(100, "AcDbBlockBegin"); g(2, nm); g(70, 0); g(10, 0); g(20, 0); g(30, 0); g(3, nm); g(1, "");
    g(0, "ENDBLK"); g(5, e); g(330, br); g(100, "AcDbEntity"); g(8, "0"); g(100, "AcDbBlockEnd");
  }
  g(0, "ENDSEC");

  // ---- ENTITIES ----
  g(0, "SECTION"); g(2, "ENTITIES");
  const head = (type, layer, color, layerColor, sw, layerSw, dash, layerDash) => {
    g(0, type); g(5, nh()); g(330, H.brModel); g(100, "AcDbEntity"); g(8, layer);
    if (dash && !layerDash) g(6, "DASHED");
    if (color !== layerColor) { g(62, aci(color)); g(420, trueColor(color)); }
    if (lwOf(sw) !== lwOf(layerSw)) g(370, lwOf(sw));
  };
  const poly = (L, pts, closed, color, sw, dash) => {
    if (pts.length < 2) return;
    head("LWPOLYLINE", L.cad, color, L.color, sw, L.sw, dash, !!L.dash);
    g(100, "AcDbPolyline"); g(90, pts.length); g(70, closed ? 1 : 0);
    for (const p of pts) { g(10, n3(p[0])); g(20, n3(p[1])); grow(p[0], p[1]); }
  };
  for (const L of P.layers) {
    for (const it of L.items) {
      if (it.k === "poly") {
        for (const r of it.rings) {
          const pts = r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r;
          if (pts.length >= 3) poly(L, pts, true, it.color, it.sw, it.dash);
        }
      } else if (it.k === "line") poly(L, it.pts, false, it.color, it.sw, it.dash);
      else if (it.k === "dot") {
        head("CIRCLE", L.cad, it.color, L.color, it.sw, L.sw, null, false);
        g(100, "AcDbCircle"); g(10, n3(it.p[0])); g(20, n3(it.p[1])); g(30, 0); g(40, n3(Math.max(it.r, 0.05)));
        grow(it.p[0] - it.r, it.p[1] - it.r); grow(it.p[0] + it.r, it.p[1] + it.r);
      }
    }
  }
  const textLayers = { TEXT: { cad: "TEXT", color: pal.text, sw: 0.18 }, TITLE: { cad: "TITLE", color: pal.text, sw: 0.18 }, LEGEND: P.layers.find(l => l.cad === "LEGEND") || { cad: "LEGEND", color: pal.text, sw: 0.2 } };
  for (const t of P.texts) {
    const L = textLayers[t.layer];
    const center = t.role === "label";
    head("TEXT", L.cad, t.color, "#" + hex2rgb(L.color).map(v => v.toString(16).padStart(2, "0")).join(""), 0.2, 0.2, null, false);
    g(100, "AcDbText"); g(10, n3(t.p[0])); g(20, n3(t.p[1])); g(30, 0); g(40, n3(t.h)); g(1, enc(t.text)); g(7, "NotoSans");
    if (center) { g(72, 1); g(11, n3(t.p[0])); g(21, n3(t.p[1])); g(31, 0); }
    g(100, "AcDbText"); if (center) g(73, 2);
    grow(t.p[0], t.p[1]);
  }
  g(0, "ENDSEC");

  // ---- OBJECTS ----
  g(0, "SECTION"); g(2, "OBJECTS");
  const dict = (h, owner, entries) => {
    g(0, "DICTIONARY"); g(5, h); g(330, owner); g(100, "AcDbDictionary"); g(281, 1);
    for (const [k, v] of entries) { g(3, k); g(350, v); }
  };
  dict(H.root, 0, [["ACAD_GROUP", H.dGroup], ["ACAD_LAYOUT", H.dLayout], ["ACAD_MLINESTYLE", H.dMline], ["ACAD_PLOTSETTINGS", H.dPlotSet], ["ACAD_PLOTSTYLENAME", H.dPlotStyle]]);
  dict(H.dGroup, H.root, []);
  dict(H.dLayout, H.root, [["Model", H.layoutModel], ["Layout1", H.layoutPaper]]);
  dict(H.dMline, H.root, [["Standard", H.mlStd]]);
  dict(H.dPlotSet, H.root, []);
  g(0, "ACDBDICTIONARYWDFLT"); g(5, H.dPlotStyle); g(330, H.root); g(100, "AcDbDictionary"); g(281, 1); g(3, "Normal"); g(350, H.plotNormal); g(100, "AcDbDictionaryWithDefault"); g(340, H.plotNormal);
  g(0, "ACDBPLACEHOLDER"); g(5, H.plotNormal); g(330, H.dPlotStyle);
  g(0, "MLINESTYLE"); g(5, H.mlStd); g(102, "{ACAD_REACTORS"); g(330, H.dMline); g(102, "}"); g(330, H.dMline); g(100, "AcDbMlineStyle");
  g(2, "Standard"); g(70, 0); g(3, ""); g(62, 256); g(51, 90); g(52, 90); g(71, 2); g(49, 0.5); g(62, 256); g(6, "BYLAYER"); g(49, -0.5); g(62, 256); g(6, "BYLAYER");
  const layout = (h, name, order, br, flags) => {
    g(0, "LAYOUT"); g(5, h); g(330, H.dLayout); g(100, "AcDbPlotSettings"); g(1, ""); g(2, "none_device"); g(4, ""); g(6, "");
    g(40, 0); g(41, 0); g(42, 0); g(43, 0); g(44, 420); g(45, 297); g(46, 0); g(47, 0); g(48, 0); g(49, 0); g(140, 0); g(141, 0); g(142, 1); g(143, 1);
    g(70, flags); g(72, 1); g(73, 0); g(74, 5); g(7, ""); g(75, 16); g(76, 0); g(77, 2); g(78, 300); g(147, 1); g(148, 0); g(149, 0);
    g(100, "AcDbLayout"); g(1, name); g(70, 1); g(71, order); g(10, 0); g(20, 0); g(11, 420); g(21, 297); g(12, 0); g(22, 0); g(32, 0);
    g(14, "1.0E+20"); g(24, "1.0E+20"); g(34, "1.0E+20"); g(15, "-1.0E+20"); g(25, "-1.0E+20"); g(35, "-1.0E+20"); g(146, 0);
    g(13, 0); g(23, 0); g(33, 0); g(16, 1); g(26, 0); g(36, 0); g(17, 0); g(27, 1); g(37, 0); g(76, 1); g(330, br);
  };
  layout(H.layoutModel, "Model", 0, H.brModel, 1024);
  layout(H.layoutPaper, "Layout1", 1, H.brPaper, 0);
  g(0, "ENDSEC"); g(0, "EOF");

  // real extents (TEXT anchors and geometry) replace the provisional bounds
  buildHeader();
  const body = hdr.concat(lines).join("\r\n") + "\r\n";
  return body.replace("@@SEED@@", seed.toString(16).toUpperCase());
}
