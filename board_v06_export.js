import { t as _t } from "./i18n.js?v=20261123d";
// Board v2 rendering for output: one page = frame content in frame-local mm (cards + cartouche), wrapped per output mode.
// Used by PDF / PNG export, presentation mode and (cartoucheSvg) the on-screen frame.
import { sanitizeSvgTree, safeImg, safeId, num, r2, frameSize, frameMargin, cartHeight, tilePlan, needsTiles, TILE_SLUG, TILE_OVERLAP, ROLES, DEFAULT_STYLES, LAYERS, defaultLayer, contentRect, stampSvg, cardDen } from "./board_v06_doc.js?v=20261123d";
import { arrowSegment as _arrowSeg, stackHidden as _stackHidden } from "./board_v06_record.js?v=20261123d";
import { itemsFor, expandFields, pageDen, effectiveStyle, resolveColor, partnerOf } from "./board_v06_parent.js?v=20261123d";

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
  if (root.localName !== "svg" || doc.querySelector("parsererror")) throw new Error(_t('board.export.001'));
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
  return S.cards.filter(c => c.kind !== "memo" && !hidden(c) && !_stackHidden(S, c) && c.page === f.id).sort((a, b) => lay(a) - lay(b) || a.z - b.z);   // membership is the stored card.page; the sheet clips what sticks out
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
// text block with fields, columns, inset, tracking (also used for parent items); x,y = frame-local top-left
function textBlock(S, c, x, y, cw, ch, pdf, fx) {
  const st = effectiveStyle(S, c), size = num(st.size, 5, 1, 200), cols = Math.round(num(c.cols, 1, 1, 3)), gut = num(c.gutter, 4, 0, 50), inset = num(c.inset, 0, 0, 50);
  const colW = Math.max(1, (cw - 2 * inset - (cols - 1) * gut) / cols), lines = wrapLines(expandFields(c.text, fx), size, st.weight, colW);
  const lh = size * 1.3, cap = Math.max(1, Math.floor((ch - 2 * inset) / lh));
  const wt = st.weight >= 600 ? (pdf ? "bold" : "700") : "normal";
  const al = c.align === "center" ? ["middle", colW / 2] : c.align === "right" ? ["end", colW] : ["start", 0];
  const tr = st.tracking ? ` letter-spacing="${num(st.tracking, 0, -5, 20)}"` : "";
  let o = "";
  for (let k = 0; k < cols; k++) {
    const part = lines.map((ln, i) => ({ ln, i })).filter(({ i }) => i < cols * cap && Math.floor(i / cap) === k);   // lines past the last column are cut (the screen flags the overset)
    if (!part.length) continue;
    o += `<text font-size="${size}" font-weight="${wt}" fill="${esc(st.color)}" text-anchor="${al[0]}"${tr}>` + part.map(({ ln, i }) =>
      `<tspan x="${r2(x + inset + k * (colW + gut) + al[1])}" y="${r2(y + inset + size * 0.98 + (i - k * cap) * lh)}">${esc(ln)}</tspan>`).join("") + `</text>`;
  }
  return o;
}
// parent items of a page (those without an override on that page), frame-local
export function parentItemsSvg(ctx, f, { pdf = true, pageNo = f.page, total = ctx.S.frames.length } = {}) {
  const { S } = ctx, den = pageDen(S, f, cardDen), fx = { S, pageNo, total, den };
  let out = "";
  for (const it of itemsFor(S, f)) {
    const cw = num(it.w, 1, 1, 2000), ch = num(it.h, 1, 1, 2000);
    if (it.kind === "cartouche") out += cartoucheSvg(S, f, pageNo, total, pdf);
    else if (it.kind === "text") out += textBlock(S, it, num(it.x, 0, -2000, 2000), num(it.y, 0, -2000, 2000), cw, ch, pdf, fx);
    else if (it.kind === "stamp") out += `<g transform="translate(${r2(num(it.x, 0, -2000, 2000))} ${r2(num(it.y, 0, -2000, 2000))})">${stampSvg({ ...it, w: cw, h: ch }, num(it.den, 100, 1, 1e6), { pdf })}</g>`;
  }
  return out;
}
const fstyleOf = (S, c) => { const k = c.fstyle && S.fstyles?.[c.fstyle]; return k ? { w: num(k.w, 0.25, 0, 5), color: resolveColor(S, k.color), fill: c.fstyle === "box" } : null; };
// Frame content in frame-local mm (0..W, 0..H): white page, parent items, cards in stacking order, legacy cartouche.
export function frameInner(ctx, f, { mode = "pdf", pageNo = f.page, total = ctx.S.frames.length } = {}) {
  const { S, payloads } = ctx;
  const [W, H] = frameSize(f), pdf = mode === "pdf", fx = { S, pageNo, total, den: pageDen(S, f, cardDen) };
  let out = `<rect x="-30" y="-30" width="${W + 60}" height="${H + 60}" fill="#ffffff"/>`;
  const parentSvg = parentItemsSvg(ctx, f, { pdf, pageNo, total });   // stacking: bg cards, parent items, art, text
  let pDone = false;
  for (const c of cardsOfFrame(S, f)) {
    if (!pDone && (c.layer || defaultLayer(c.kind)) !== "bg") { out += parentSvg; pDone = true; }
    const x = c.x - f.x, y = c.y - f.y;
    let node = "";
    const p = payloads.get(c.ref) || {};
    const cw = num(c.w, 1, 1, 5000), ch = num(c.h, 1, 1, 5000), rot = num(c.rot, 0, -360, 360);
    const cr = (c.kind === "diagram" || c.kind === "image") ? contentRect({ ...c, w: cw, h: ch }, S.assets[c.ref]) : null;   // content inside the frame (B8), clipped in mm: same on screen, PDF and PNG
    const clip = (inner) => { const id = "bdcc-" + safeId(c.id, "c"); return `<defs><clipPath id="${id}"><rect x="${r2(x)}" y="${r2(y)}" width="${r2(cw)}" height="${r2(ch)}"/></clipPath></defs><g clip-path="url(#${id})">${inner}</g>`; };
    const fs = cr ? fstyleOf(S, c) : null;
    if (c.kind === "diagram") {
      if (!p.svg) continue;
      node = clip(prefixSvg(p.svg, safeId(c.id, "c") + "-", x + cr.x, y + cr.y, cr.w, cr.h));
    } else if (c.kind === "image") {
      const img = safeImg(p.img);
      if (!img) continue;
      node = clip(`<image x="${r2(x + cr.x)}" y="${r2(y + cr.y)}" width="${r2(cr.w)}" height="${r2(cr.h)}" preserveAspectRatio="none" href="${esc(img)}" xlink:href="${esc(img)}"/>`);
    } else if (c.kind === "stamp") {
      node = `<g transform="translate(${r2(x)} ${r2(y)})">${stampSvg({ ...c, w: cw, h: ch }, num(c.den, 100, 1, 1e6), { pdf })}</g>`;
    } else if (c.kind === "link") {   // exported as text: title + URL
      node = `<text font-size="4.4" font-weight="${pdf ? "bold" : "700"}" fill="#1d1d1f"><tspan x="${r2(x + 3)}" y="${r2(y + 7)}">${esc(fitText(c.title || "", 4.4, 700, cw - 6))}</tspan></text><text font-size="3" fill="#6e6e73"><tspan x="${r2(x + 3)}" y="${r2(y + 12)}">${esc(fitText(c.url || "", 3, 400, cw - 6))}</tspan></text>`;
    } else if (c.kind === "text") {
      node = textBlock(S, c, x, y, cw, ch, pdf, fx);
    }
    if (fs) node = (fs.fill ? `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(cw)}" height="${r2(ch)}" fill="#ffffff"/>` : "") + node + (fs.w > 0 ? `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(cw)}" height="${r2(ch)}" fill="none" stroke="${esc(fs.color)}" stroke-width="${fs.w}"/>` : "");
    if (rot) node = `<g transform="rotate(${rot} ${r2(x + cw / 2)} ${r2(y + ch / 2)})">${node}</g>`;
    out += node;
  }
  if (!pDone) out += parentSvg;
  const onPage = new Map(cardsOfFrame(S, f).map(c => [c.id, c])), box = c => { const q = c.rot && Math.abs(c.rot) % 180 === 90, w = q ? c.h : c.w, h = q ? c.w : c.h, cx = c.x - f.x + c.w / 2, cy = c.y - f.y + c.h / 2; return { x: cx - w / 2, y: cy - h / 2, w, h }; };
  for (const a of S.arrows || []) {   // arrows whose two ends are both on this page
    const A = onPage.get(a.from), B = onPage.get(a.to), g = A && B ? _arrowSeg(box(A), box(B), 3) : null;
    if (g) out += `<line x1="${r2(g.x1)}" y1="${r2(g.y1)}" x2="${r2(g.x2)}" y2="${r2(g.y2)}" stroke="#1d1d1f" stroke-width="0.3"/><polygon points="${g.head.map(p => p.map(r2).join(",")).join(" ")}" fill="#1d1d1f"/>`;
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
  if (!opt.tiles) return frames.length - (opt.spreads && !opt.booklet ? frames.filter((f, i) => f.spread === "R" && i > 0 && frames[i - 1].spread === "L").length : 0);
  let n = 0;
  for (const f of frames) { const [W, H] = frameSize(f); const p = tilePlan(W, H); n += needsTiles(W, H) ? p.nx * p.ny : 1; }
  return n;
}

// PDF pages [{svg,size}] for the chosen frames in the given order. opt: { booklet, bleed, tiles }
export function planSheets(ctx, frames, opt = {}) {
  const total = ctx.S.frames.length, out = [];
  const done = new Set();
  for (const f of frames) {
    if (done.has(f.id)) continue;
    const [W, H] = frameSize(f);
    const inner = frameInner(ctx, f, { mode: "pdf", pageNo: f.page, total });
    const mate = opt.spreads && f.spread === "L" && !opt.booklet && !opt.tiles && !opt.bleed ? partnerOf(ctx.S, f) : null;
    if (mate && frames.includes(mate)) {   // one PDF page per spread: width doubled
      done.add(mate.id);
      const [mw, mh] = frameSize(mate);   // each page clipped to its own box: the white page background must not cover its neighbour
      out.push({ size: [W + mw, Math.max(H, mh)], svg: ROOT(W + mw, Math.max(H, mh), true, placed(inner, [0, 0, W, H], 0, 0) + placed(frameInner(ctx, mate, { mode: "pdf", pageNo: mate.page, total }), [W, 0, mw, mh], W, 0)) });
    } else if (opt.booklet) {
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
