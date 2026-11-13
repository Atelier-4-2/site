// Vector A3 PDF export (jsPDF + svg2pdf.js, loaded on first use from cdn.jsdelivr.net).
// Hangul: jsPDF needs TrueType. The Noto Sans KR "korean" subset (all 11,172 syllables + Basic Latin +
// Latin-1 punctuation) is fetched as WOFF from @fontsource and converted to TTF in the browser (WOFF tables are
// zlib streams; DecompressionStream inflates them) and embedded as Identity-H fonts.
const JSPDF = "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";
const SVG2PDF = "https://cdn.jsdelivr.net/npm/svg2pdf.js@2.2.4/dist/svg2pdf.umd.min.js";
const FONT = w => `https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-kr@5.3.1/files/noto-sans-kr-korean-${w}-normal.woff`;
export const PDF_FAMILY = "Noto Sans KR";

function script(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("PDF 도구를 불러오지 못했습니다. 네트워크를 확인하세요."));
    document.head.append(s);
  });
}
let libsP = null;
function loadLibs() {
  if (!libsP) {
    libsP = (async () => {
      if (!globalThis.jspdf) await script(JSPDF);
      if (!globalThis.svg2pdf) await script(SVG2PDF);
      return { jsPDF: globalThis.jspdf.jsPDF, svg2pdf: globalThis.svg2pdf.svg2pdf || globalThis.svg2pdf };
    })().catch(e => { libsP = null; throw e; });
  }
  return libsP;
}

// WOFF 1.0 -> sfnt (TrueType) bytes
async function woffToTtf(buf) {
  const v = new DataView(buf);
  if (v.getUint32(0) !== 0x774f4646) throw new Error("WOFF 형식이 아닙니다.");
  const flavor = v.getUint32(4), n = v.getUint16(12);
  const tables = [];
  for (let i = 0; i < n; i++) {
    const o = 44 + i * 20;
    const t = { tag: v.getUint32(o), off: v.getUint32(o + 4), comp: v.getUint32(o + 8), orig: v.getUint32(o + 12), sum: v.getUint32(o + 16) };
    const raw = new Uint8Array(buf, t.off, t.comp);
    t.data = t.comp === t.orig ? raw
      : new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
    tables.push(t);
  }
  tables.sort((a, b) => a.tag - b.tag);
  let off = 12 + n * 16;
  const out = [];
  for (const t of tables) { t.out = off; off += (t.orig + 3) & ~3; }
  const res = new Uint8Array(off), dv = new DataView(res.buffer);
  const pow = 2 ** Math.floor(Math.log2(n));
  dv.setUint32(0, flavor); dv.setUint16(4, n); dv.setUint16(6, pow * 16); dv.setUint16(8, Math.log2(pow)); dv.setUint16(10, n * 16 - pow * 16);
  tables.forEach((t, i) => {
    const o = 12 + i * 16;
    dv.setUint32(o, t.tag); dv.setUint32(o + 4, t.sum); dv.setUint32(o + 8, t.out); dv.setUint32(o + 12, t.orig);
    res.set(t.data, t.out);
  });
  void out;
  return res;
}
const b64 = u8 => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };

let fontsP = null;
function loadFonts() {
  if (!fontsP) {
    fontsP = Promise.all([[400, "normal"], [600, "bold"]].map(async ([w, style]) => {
      const r = await fetch(FONT(w));
      if (!r.ok) throw new Error("한글 글꼴을 불러오지 못했습니다.");
      return { w, style, file: `NotoSansKR-${w}.ttf`, b64: b64(await woffToTtf(await r.arrayBuffer())) };
    })).catch(e => { fontsP = null; throw e; });
  }
  return fontsP;
}

// pages: [{ svg:string, fit?:boolean }]; svg = full-sheet SVG (viewBox 420 x 297) made with renderSvg(..., {pdf:true}).
// fit pages (analysis tabs) keep their own aspect ratio, centred on an A3 landscape page.
export async function buildPdf(pages, { title = "Terrain", subject = "", onProgress = null, isCancelled = () => false } = {}) {
  const [{ jsPDF, svg2pdf }, fonts] = await Promise.all([loadLibs(), loadFonts()]);
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: [420, 297], compress: true });
  for (const f of fonts) {
    doc.addFileToVFS(f.file, f.b64);
    doc.addFont(f.file, PDF_FAMILY, "normal", f.style === "bold" ? 700 : 400, "Identity-H");
  }
  doc.setProperties({ title, subject, author: "", keywords: "", creator: "Terrain" });
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-99999px;top:0;width:1px;height:1px;overflow:hidden";
  document.body.append(holder);
  try {
    for (let i = 0; i < pages.length; i++) {
      if (isCancelled()) throw new Error("취소되었습니다.");
      onProgress?.(i + 1, pages.length);
      if (i) doc.addPage([420, 297], "landscape");
      const p = pages[i];
      const el = new DOMParser().parseFromString(p.svg, "image/svg+xml").documentElement;
      if (el.nodeName === "parsererror" || el.querySelector?.("parsererror")) throw new Error("PDF용 SVG를 읽지 못했습니다.");
      holder.replaceChildren(document.importNode(el, true));
      const svg = holder.firstElementChild;
      let x = 0, y = 0, w = 420, h = 297;
      if (p.fit) {
        const vb = (svg.getAttribute("viewBox") || "0 0 420 297").split(/\s+/).map(Number);
        const k = Math.min(396 / vb[2], 273 / vb[3]);
        w = vb[2] * k; h = vb[3] * k; x = (420 - w) / 2; y = (297 - h) / 2;
      }
      await svg2pdf(svg, doc, { x, y, width: w, height: h });
      holder.replaceChildren();
      await new Promise(r => setTimeout(r, 0));
    }
  } finally { holder.remove(); }
  return doc.output("blob");
}
