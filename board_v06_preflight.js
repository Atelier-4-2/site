// Build 4a-2: output preflight (B11) and PDF presets (B12). Pure (no DOM) so node can test it.
import { frameSize, pageLabel, pageTitle, contentRect, ppiOf, ROLE_LABEL, STAMP_LABEL, defaultLayer, LAYERS, pad2 } from "./board_v06_doc.js?v=20261122f";

export const PRESETS = {
  print: { label: "인쇄", fmt: "pdf", bleed: true, booklet: false, tiles: false, maxPpi: 300 },
  web: { label: "웹", fmt: "pdf", bleed: false, booklet: false, tiles: false, maxPpi: 150 },
  custom: { label: "사용자" }
};
export const PRESET_KEYS = Object.keys(PRESETS);
export const presetOptions = key => (PRESETS[key] && key !== "custom" ? { ...PRESETS[key] } : null);
// pixel width an image needs for its printed width: never upsample
export const downsampleTarget = (nativePx, printedWmm, ppi) => Math.min(nativePx, Math.max(1, Math.ceil(printedWmm / 25.4 * ppi)));
export const todayStamp = (d = new Date()) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

const BLEED = 3, TRIM_TOL = 0.5;
const META_NAMES = { project: "프로젝트", author: "이름", atelier: "아틀리에", teachers: "교수" };
const hiddenLayer = (S, c) => !!S.layers?.[LAYERS.includes(c.layer) ? c.layer : defaultLayer(c.kind)]?.hidden;
export function cardTitle(S, c) {
  if (c.kind === "diagram" || c.kind === "image") return S.assets?.[c.ref]?.title || (c.kind === "image" ? "이미지" : "다이어그램");
  if (c.kind === "stamp") return STAMP_LABEL[c.stamp] || "스탬프";
  return (c.text || ROLE_LABEL[c.role] || "글").split("\n")[0].slice(0, 24);
}
// env: { imgPx(card) -> [w,h]|null, overset(card) -> bool }  (injected: the browser measures, node fakes)
export function preflight(S, env = {}) {
  const out = [];
  const add = o => out.push({ id: `${o.kind}:${o.card || o.page}`, ...o });
  const frames = new Map(S.frames.map(f => [f.id, f]));
  for (const f of S.frames) {
    const parentCart = f.parent && (S.parents || []).find(p => p.id === f.parent)?.items.some(i => i.kind === "cartouche");
    if (!f.cartouche && !parentCart) continue;   // the cartouche may come from the page or from its parent
    const miss = Object.keys(META_NAMES).filter(k => !String(S.meta?.[k] || "").trim());
    if (miss.length) add({ level: "warn", kind: "cartouche", page: f.id, card: null, text: `카르투슈 비어 있음: ${miss.map(k => META_NAMES[k]).join(", ")}` });
  }
  for (const c of S.cards) {
    if (c.kind === "memo" || hiddenLayer(S, c) || (c.stack && S.stacks && S.stacks[c.stack] !== c.id)) continue;   // a stack member underneath is not output
    const f = c.page ? frames.get(c.page) : null;
    if (!f) continue;   // pasteboard cards are not output
    const title = cardTitle(S, c), base = { page: f.id, card: c.id, title };
    if (c.kind === "diagram" || c.kind === "image") {
      const a = S.assets?.[c.ref];
      if (!a) { add({ ...base, level: "error", kind: "broken", text: "자료 없음" }); continue; }
      if (c.kind === "image") {
        const px = env.imgPx?.(c);
        if (px) {
          const w = c.content ? contentRect(c, a).w : c.w, ppi = Math.round(ppiOf(px[0], w));
          if (ppi < 150) add({ ...base, level: "error", kind: "lowres", text: `저해상도 ${ppi} ppi` });
          else if (ppi < 250) add({ ...base, level: "warn", kind: "lowres", text: `해상도 낮음 ${ppi} ppi` });
        }
      }
    } else if (c.kind === "text") {
      if (env.overset?.(c)) add({ ...base, level: "error", kind: "overset", text: "글이 상자를 넘침" });
    } else if (c.kind === "stamp") {
      if (c.link && !S.cards.some(k => k.id === c.link)) add({ ...base, level: "warn", kind: "stamp_unlinked", text: "스탬프 연결 끊김" });
    }
    const [W, H] = frameSize(f), r = c.rot && Math.abs(c.rot) % 180 === 90, w = r ? c.h : c.w, h = r ? c.w : c.h, cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    const x0 = cx - w / 2, y0 = cy - h / 2;
    const sides = [f.x - x0, x0 + w - (f.x + W), f.y - y0, y0 + h - (f.y + H)];   // how far each side sticks out past the trim
    if (sides.some(d => d > BLEED + TRIM_TOL)) add({ ...base, level: "warn", kind: "straddle", text: "도련 밖으로 나감" });
    else if (sides.some(d => d > TRIM_TOL && d < BLEED - TRIM_TOL)) add({ ...base, level: "warn", kind: "straddle", text: "재단선에 걸침" });   // 2.5-3.5 mm = a proper bleed, silent
  }
  return out;
}
export function summarize(list) {
  const errors = list.filter(i => i.level === "error").length, warns = list.length - errors;
  return { errors, warns, total: list.length, text: list.length ? `오류 ${errors} · 경고 ${warns}` : "점검 OK" };
}
export function groupByPage(S, list) {
  const g = new Map();
  for (const it of list) { const k = it.page || ""; if (!g.has(k)) g.set(k, []); g.get(k).push(it); }
  return [...g].map(([id, items]) => { const f = S.frames.find(x => x.id === id); return { id, title: f ? pageTitle(f) : "대지", items }; });
}
