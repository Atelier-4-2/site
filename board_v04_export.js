// Board v2 rendering for output: one page = frame content in frame-local mm (cards + cartouche), wrapped per output mode.
// Used by PDF / PNG export, presentation mode and (cartoucheSvg) the on-screen frame.
import { sanitizeSvgTree, safeImg, safeId, num, r2, frameSize, frameMargin, cartHeight, tilePlan, needsTiles, TILE_SLUG, TILE_OVERLAP, ROLES, DEFAULT_STYLES, LAYERS, defaultLayer, contentRect, stampSvg } from "./board_v04_doc.js?v=20261122b";

const NS = "http://www.w3.org/2000/svg";
export const esc = s => String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let measureCtx = null;
export function textWidth(text, size, weight) {
  measureCtx ||= document.createElement("canvas").getContext("2d");
  measureCtx.font = `${weight} 100px "Noto Sans KR", "Noto Sans", sans-serif`;
  return measureCtx.measureText(text).width / 100 * size;
}
export function wrapLines(text, size, weight, width) {
  const m = s => textWidth(s, size, weight);
  const lines = [];
  for (const para of String(text || "").split("\n")) {
    let line = "";
    for (const ch of para) {
      const test = line + ch;
      if (m(test) > width * 0.97 && line) {
        const sp = line.lastIndexOf(" ");
        if (sp > 0 && ch !== " ") { lines.push(line.slice(0, sp)); line = line.slice(sp + 1) + ch; }
        else { lines.push(line); line = ch === " " ? "" : ch; }
      } else line = test;
    }
    lines.push(line);
  }
  return lines;
}
function fitText(text, size, weight, maxW) {
  if (!text || maxW <= 0) return "";
  if (textWidth(text, size, weight) <= maxW) return text;
  let t = text;
  while (t.length > 1 && textWidth(t + "…", size, weight) > maxW) t = t.slice(0, -1);
  return t + "…";
}

// Namespace a diagram SVG: ids, url(#..), href="#..", class names get the card id as a prefix; CSS variables become colours.
export function prefixSvg(svgText, pre, x, y, w, h) {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = doc.documentElement;
  if (root.localName !== "svg" || doc.querySelector("parsererror")) throw new Error("카드 SVG를 읽지 못했습니다.");
  sanitizeSvgTree(root);
  const cs = getComputedStyle(document.documentElement);
  const cssVars = s => s.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]+|\([^()]*\))+))?\)/g, (_, n, fb) => cs.getPropertyValue(n).trim() || (fb || "").trim() || "#000");
  const ids = new Map(), classes = new Set();
  for (const e of root.querySelectorAll("[id]")) ids.set(e.getAttribute("id"), pre + e.getAttribute("id"));
  for (const e of root.querySelectorAll("[class]")) for (const k of e.getAttribute("class").split(/\s+/).filter(Boolean)) classes.add(k);
  const fixCss = s => {
    s = cssVars(s);
    s = s.replace(/url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/g, (m, id) => ids.has(id) ? `url(#${ids.get(id)})` : m);
    s = s.replace(/#([\w-]+)(?=[\s{,.:>\[+~)])/g, (m, id) => ids.has(id) ? "#" + ids.get(id) : m);
    for (const k of classes) s = s.replace(new RegExp(`\\.${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g"), "." + pre + k);
    return s;
  };
  for (const e of [root, ...root.querySelectorAll("*")]) {
    for (const a of [...e.attributes]) {
      let v = a.value;
      if (a.name === "id") v = ids.get(v) || v;
      else if (a.name === "class") v = v.split(/\s+/).filter(Boolean).map(k => pre + k).join(" ");
      else if ((a.name === "href" || a.name === "xlink:href") && v.startsWith("#")) v = ids.has(v.slice(1)) ? "#" + ids.get(v.slice(1)) : v;
      else if (/var\(|url\(\s*['"]?#/i.test(v)) v = fixCss(v);
      if (v !== a.value) a.value = v;
    }
    if (e.nodeName === "style") e.textContent = fixCss(e.textContent);
  }
  const vb = root.getAttribute("viewBox") || "0 0 420 297";
  for (const k of ["width", "height", "x", "y"]) root.removeAttribute(k);
  root.setAttribute("x", r2(x)); root.setAttribute("y", r2(y)); root.setAttribute("width", r2(w)); root.setAttribute("height", r2(h));
  root.setAttribute("viewBox", vb);
  return new XMLSerializer().serializeToString(root);
}

export const styleOf = (S, role) => S.styles?.[role] || S.styles?.body || DEFAULT_STYLES.body;
export const cardsOfFrame = (S, f) => {
  const [W, H] = frameSize(f);
  const lay = c => LAYERS.indexOf(c.layer || defaultLayer(c.kind)), hidden = c => !!S.layers?.[c.layer || defaultLayer(c.kind)]?.hidden;
  return S.cards.filter(c => c.kind !== "memo" && !hidden(c) && c.page === f.id)   // membership is the stored card.page; the sheet clips what sticks out.sort((a, b) => lay(a) - lay(b) || a.z - b.z);   // hidden layers are not exported; bg < art < text
};

// Cartouche (title block), frame-local mm. Same output on screen, in PDF and in PNG.
export function cartoucheSvg(S, f, pageNo, total, pdf = false) {
  const [W, H] = frameSize(f), m = frameMargin(f), ch = cartHeight(f.size);
  const x0 = m, x1 = W - m, y1 = H - m, y0 = y1 - ch, meta = S.meta || {};
  const s = ch <= 12 ? 3.2 : ch <= 18 ? 4.6 : 6.2, s2 = s * 0.85;
  const bold = pdf ? "bold" : "700", norm = pdf ? "normal" : "400";
  const project = meta.project || S.name || "";
  const l2 = [meta.author, meta.atelier, meta.teachers].filter(Boolean).join(" · ");
  const r1 = `p. ${pageNo} / ${total}`, r2t = [meta.scale, meta.date].filter(Boolean).join(" · ");
  const rw = Math.max(textWidth(r1, s, 700), textWidth(r2t, s2, 400)) + 2;
  const maxL = x1 - x0 - rw - 6;
  let o = `<g class="cartouche"><line x1="${r2(x0)}" y1="${r2(y0)}" x2="${r2(x1)}" y2="${r2(y0)}" stroke="#1d1d1f" stroke-width="${r2(ch / 12 * 0.3)}"/>`;
  o += `<text x="${r2(x0)}" y="${r2(y0 + ch * 0.46)}" font-size="${s * 1.15}" font-weight="${bold}" fill="#1d1d1f">${esc(fitText(project, s * 1.15, 700, maxL))}</text>`;
  if (l2) o += `<text x="${r2(x0)}" y="${r2(y0 + ch * 0.84)}" font-size="${s2}" font-weight="${norm}" fill="#6e6e73">${esc(fitText(l2, s2, 400, maxL))}</text>`;
  o += `<text x="${r2(x1)}" y="${r2(y0 + ch * 0.46)}" font-size="${s}" font-weight="${bold}" fill="#1d1d1f" text-anchor="end">${esc(r1)}</text>`;
  if (r2t) o += `<text x="${r2(x1)}" y="${r2(y0 + ch * 0.84)}" font-size="${s2}" font-weight="${norm}" fill="#6e6e73" text-anchor="end">${esc(r2t)}</text>`;
  return o + "</g>";
}

// Frame content in frame-local mm (0..W, 0..H): white page, cards in stacking order, cartouche.
export function frameInner(ctx, f, { mode = "pdf", pageNo = f.page, total = ctx.S.frames.length } = {}) {
  const { S, payloads } = ctx;
  const [W, H] = frameSize(f), pdf = mode === "pdf";
  let out = `<rect x="-30" y="-30" width="${W + 60}" height="${H + 60}" fill="#ffffff"/>`;
  for (const c of cardsOfFrame(S, f)) {
    const x = c.x - f.x, y = c.y - f.y;
    let node = "";
    const p = payloads.get(c.ref) || {};
    const cw = num(c.w, 1, 1, 5000), ch = num(c.h, 1, 1, 5000), rot = num(c.rot, 0, -360, 360);
    const cr = (c.kind === "diagram" || c.kind === "image") ? contentRect({ ...c, w: cw, h: ch }, S.assets[c.ref]) : null;   // content inside the frame (B8), clipped in mm: same on screen, PDF and PNG
    const clip = (inner) => { const id = "bdcc-" + safeId(c.id, "c"); return `<defs><clipPath id="${id}"><rect x="${r2(x)}" y="${r2(y)}" width="${r2(cw)}" height="${r2(ch)}"/></clipPath></defs><g clip-path="url(#${id})">${inner}</g>`; };
    if (c.kind === "diagram") {
      if (!p.svg) continue;
      node = cr ? clip(prefixSvg(p.svg, safeId(c.id, "c") + "-", x + cr.x, y + cr.y, cr.w, cr.h)) : prefixSvg(p.svg, safeId(c.id, "c") + "-", x, y, cw, ch);
    } else if (c.kind === "image") {
      const img = safeImg(p.img);
      if (!img) continue;
      const ix = cr ? x + cr.x : x, iy = cr ? y + cr.y : y, iw = cr ? cr.w : cw, ih = cr ? cr.h : ch;
      node = `<image x="${r2(ix)}" y="${r2(iy)}" width="${r2(iw)}" height="${r2(ih)}" preserveAspectRatio="none" href="${esc(img)}" xlink:href="${esc(img)}"/>`;
      if (cr) node = clip(node);
    } else if (c.kind === "stamp") {
      node = `<g transform="translate(${r2(x)} ${r2(y)})">${stampSvg({ ...c, w: cw, h: ch }, num(c.den, 100, 1, 1e6), { pdf })}</g>`;
    } else if (c.kind === "text") {
      const T = styleOf(S, ROLES.includes(c.role) ? c.role : "body"), size = num(c.size, T.size, 1, 200);
      const lines = wrapLines(c.text, size, T.weight, cw);
      const wt = T.weight >= 600 ? (pdf ? "bold" : "700") : "normal";
      const al = c.align === "center" ? ["middle", cw / 2] : c.align === "right" ? ["end", cw] : ["start", 0];
      node = `<text font-size="${size}" font-weight="${wt}" fill="${esc(T.color)}" text-anchor="${al[0]}">` + lines.map((ln, i) =>
        `<tspan x="${r2(x + al[1])}" y="${r2(y + size * 0.98 + i * size * 1.3)}">${esc(ln)}</tspan>`).join("") + `</text>`;
    }
    if (rot) node = `<g transform="rotate(${rot} ${r2(x + cw / 2)} ${r2(y + ch / 2)})">${node}</g>`;
    out += node;
  }
  if (f.cartouche) out += cartoucheSvg(S, f, pageNo, total, pdf);
  return out;
}

const ROOT = (w, h, pdf, inner, fontCss = "", family = "") =>
  `<svg xmlns="${NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${r2(w)}" height="${r2(h)}" viewBox="0 0 ${r2(w)} ${r2(h)}" font-family="${pdf ? "Noto Sans KR" : (family || "Noto Sans KR, Noto Sans, sans-serif")}">` +
  (fontCss ? `<style>${fontCss}</style>` : "") + inner + `</svg>`;

// Whole-page SVG (PNG export, presentation).
export function frameSvg(ctx, f, mode, fontCss = "", family = "") {
  const [W, H] = frameSize(f);
  return ROOT(W, H, mode === "pdf", frameInner(ctx, f, { mode }), fontCss, family);
}

// A sheet that places a rectangle of the page (frame-local region) at a position on the sheet, clipped.
let clipN = 0;
function placed(inner, clip, tx, ty, k = 1) {
  const id = "bdclip" + (++clipN);
  return `<defs><clipPath id="${id}"><rect x="${r2(clip[0])}" y="${r2(clip[1])}" width="${r2(clip[2])}" height="${r2(clip[3])}"/></clipPath></defs>` +
    `<g clip-path="url(#${id})"><g transform="translate(${r2(tx)} ${r2(ty)})${k === 1 ? "" : ` scale(${k})`}">${inner}</g></g>`;
}
function cropMarks(x0, y0, x1, y1, gap, len) {
  const L = (a, b, c, d) => `<line x1="${r2(a)}" y1="${r2(b)}" x2="${r2(c)}" y2="${r2(d)}"/>`;
  return `<g stroke="#000000" stroke-width="0.25" fill="none">` +
    L(x0 - gap - len, y0, x0 - gap, y0) + L(x0, y0 - gap - len, x0, y0 - gap) +
    L(x1 + gap, y0, x1 + gap + len, y0) + L(x1, y0 - gap - len, x1, y0 - gap) +
    L(x0 - gap - len, y1, x0 - gap, y1) + L(x0, y1 + gap, x0, y1 + gap + len) +
    L(x1 + gap, y1, x1 + gap + len, y1) + L(x1, y1 + gap, x1, y1 + gap + len) + `</g>`;
}

// Number of PDF sheets a page list produces (used by the export panel button).
export function sheetCount(frames, opt) {
  if (!opt.tiles) return frames.length;
  let n = 0;
  for (const f of frames) { const [W, H] = frameSize(f); const p = tilePlan(W, H); n += needsTiles(W, H) ? p.nx * p.ny : 1; }
  return n;
}

// PDF pages [{svg,size}] for the chosen frames in the given order. opt: { booklet, bleed, tiles }
export function planSheets(ctx, frames, opt = {}) {
  const total = ctx.S.frames.length, out = [];
  for (const f of frames) {
    const [W, H] = frameSize(f);
    const inner = frameInner(ctx, f, { mode: "pdf", pageNo: f.page, total });
    if (opt.booklet) {
      const [sw, sh] = W >= H ? [420, 297] : [297, 420];
      const k = Math.min(1, sw / W, sh / H), tx = (sw - W * k) / 2, ty = (sh - H * k) / 2;
      out.push({ size: [sw, sh], svg: ROOT(sw, sh, true, `<rect width="${sw}" height="${sh}" fill="#ffffff"/>` + placed(inner, [tx, ty, W * k, H * k], tx, ty, k), "", "") });
    } else if (opt.tiles && needsTiles(W, H)) {
      const p = tilePlan(W, H), n = p.nx * p.ny;
      for (let j = 0; j < p.ny; j++) for (let i = 0; i < p.nx; i++) {
        const x0 = i * (p.tw - TILE_OVERLAP);
        const y0 = j * (p.th - TILE_OVERLAP);
        const vis = [Math.max(x0, 0), Math.max(y0, 0), Math.min(x0 + p.tw, W), Math.min(y0 + p.th, H)];
        const clip = [TILE_SLUG + vis[0] - x0, TILE_SLUG + vis[1] - y0, vis[2] - vis[0], vis[3] - vis[1]];
        const idx = j * p.nx + i + 1;
        const cx = clip[0], cy = clip[1], cx1 = clip[0] + clip[2], cy1 = clip[1] + clip[3];
        out.push({
          size: [p.sw, p.sh],
          svg: ROOT(p.sw, p.sh, true, `<rect width="${p.sw}" height="${p.sh}" fill="#ffffff"/>` + placed(inner, clip, TILE_SLUG - x0, TILE_SLUG - y0) +
            cropMarks(cx, cy, cx1, cy1, 1, 5) +
            `<text x="${TILE_SLUG}" y="${p.sh - 2.6}" font-size="3.2" fill="#000000">${esc(`p.${f.page} · ${idx}/${n}`)}</text>`)
        });
      }
    } else if (opt.bleed) {
      const B = 3, SL = 10;   // 3 mm bleed, 10 mm sheet border for the crop marks
      out.push({ size: [W + SL * 2, H + SL * 2], svg: ROOT(W + SL * 2, H + SL * 2, true, `<rect width="${W + SL * 2}" height="${H + SL * 2}" fill="#ffffff"/>` +
        placed(inner, [SL - B, SL - B, W + B * 2, H + B * 2], SL, SL) + cropMarks(SL, SL, SL + W, SL + H, B, 5)) });
    } else {
      out.push({ size: [W, H], svg: ROOT(W, H, true, inner) });
    }
  }
  return out;
}
