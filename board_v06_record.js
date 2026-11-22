// Build 5a: semester work record (sections, dates, status, tags, comments, marks, snapshots, search). Pure (no DOM, no imports).
const r2 = n => Math.round(n * 100) / 100;
const num = (v, d, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const idOk = v => /^[A-Za-z0-9_-]{1,40}$/.test(String(v));
const strCap = (v, max, d = "") => (typeof v === "string" || typeof v === "number") ? String(v).slice(0, max) : d;
export const STATUSES = ["keep", "review", "drop"];
export const STATUS_LABEL = { keep: "유지", review: "검토", drop: "버림" };
export const AUTHORS = ["나", "교수", "동료"];
export const AUTHOR_COLOR = { 나: "#1d1d1f", 교수: "#d63af9", 동료: "#00a3bf" };   // red is reserved for errors
export const PEN_COLORS = { ink: "#1d1d1f", cyan: "#00a3bf", magenta: "#d63af9" };
export const SECTION_COLORS = ["s1", "s2", "s3", "s4", "s5"];
export const SECTION_FILL = { s1: "rgba(29,29,31,0.05)", s2: "rgba(230,184,156,0.22)", s3: "rgba(214,58,249,0.07)", s4: "rgba(0,163,191,0.08)", s5: "rgba(110,110,115,0.12)" };
export const MAX_SECTIONS = 60, MAX_COMMENTS = 500, MAX_MARKS = 500, MAX_PTS = 2000, MAX_TAGS = 8;
export const todayStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
// ISO 8601 week of a YYYY-MM-DD date: 2026-11-22 -> { year: 2026, week: 47 }
export function isoWeek(str) {
  const [y, m, d] = String(str).split("-").map(Number), t = new Date(Date.UTC(y, m - 1, d)), dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { year: t.getUTCFullYear(), week: Math.ceil(((t - y0) / 86400000 + 1) / 7) };
}
export const weekLabel = str => { const w = isoWeek(str); return `${w.year} · S${String(w.week).padStart(2, "0")}`; };
export function cleanTags(v) {
  const out = [];
  for (const t of Array.isArray(v) ? v : []) {
    const s = String(t ?? "").replace(/^#+/, "").trim().toLowerCase().slice(0, 24);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
export function cleanSections(list) {
  const out = [], seen = new Set();
  for (const s of (Array.isArray(list) ? list : []).slice(0, MAX_SECTIONS)) {
    if (!s || !idOk(s.id) || seen.has(String(s.id))) continue;
    seen.add(String(s.id));
    out.push({ id: String(s.id), name: strCap(s.name, 60, "구역"), x: num(s.x, 0, -1e6, 1e6), y: num(s.y, 0, -1e6, 1e6), w: num(s.w, 400, 20, 1e5), h: num(s.h, 300, 20, 1e5), color: SECTION_COLORS.includes(s.color) ? s.color : "s1", collapsed: s.collapsed === true });
  }
  return out;
}
export function cleanComments(list, cardIds) {
  const out = [], seen = new Set();
  for (const c of (Array.isArray(list) ? list : []).slice(0, MAX_COMMENTS)) {
    if (!c || !idOk(c.id) || seen.has(String(c.id)) || !cardIds.has(String(c.card))) continue;   // a pin whose card is gone is dropped
    seen.add(String(c.id));
    out.push({ id: String(c.id), card: String(c.card), dx: num(c.dx, 0, -1e5, 1e5), dy: num(c.dy, 0, -1e5, 1e5), text: strCap(c.text, 2000), author: AUTHORS.includes(c.author) ? c.author : "나", date: isDate(c.date) ? c.date : todayStr(), resolved: c.resolved === true });
  }
  return out;
}
// Ramer-Douglas-Peucker simplification (tolerance in mm)
export function rdp(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let dmax = 0, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b], L = Math.hypot(bx - ax, by - ay) || 1e-9;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L; if (d > dmax) { dmax = d; idx = i; } }
    if (dmax > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
export function capPoints(pts, max = MAX_PTS) {
  if (pts.length <= max) return pts;
  const out = [], k = (pts.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(pts[Math.round(i * k)]);
  return out;
}
export function cleanMarks(list, cardIds) {
  const out = [], seen = new Set();
  for (const m of (Array.isArray(list) ? list : []).slice(0, MAX_MARKS)) {
    if (!m || !idOk(m.id) || seen.has(String(m.id)) || !Array.isArray(m.pts)) continue;
    const card = m.card == null ? null : String(m.card);
    if (card && !cardIds.has(card)) continue;
    const pts = [];
    for (const p of m.pts.slice(0, 100000)) { if (Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]))) pts.push([r2(num(p[0], 0, -1e6, 1e6)), r2(num(p[1], 0, -1e6, 1e6))]); }
    if (pts.length < 2) continue;
    seen.add(String(m.id));
    out.push({ id: String(m.id), card, pts: capPoints(pts), color: PEN_COLORS[m.color] ? m.color : "ink", w: num(m.w, 2, 0.5, 12) });
  }
  return out;
}
// what a section owns: frames whose centre is inside it, and cards (any) whose centre is inside it
export function sectionMembers(S, sec) {
  const inside = (cx, cy) => cx >= sec.x && cx <= sec.x + sec.w && cy >= sec.y && cy <= sec.y + sec.h;
  const sz = f => { const P = { A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297] }[f.size] || [297, 420]; return f.orientation === "portrait" ? P : [P[1], P[0]]; };
  const frames = S.frames.filter(f => { const [w, h] = sz(f); return inside(f.x + w / 2, f.y + h / 2); });
  const fids = new Set(frames.map(f => f.id));
  const cards = S.cards.filter(c => inside(c.x + c.w / 2, c.y + c.h / 2) || (c.page && fids.has(c.page)));
  return { frames, cards };
}
// what a section moves is fixed when the drag starts (frames and cards by centre, free marks by bounding-box centre)
export function captureSection(S, id) {
  const sec = (S.sections || []).find(s => s.id === id);
  if (!sec) return null;
  const m = sectionMembers(S, sec), inside = (x, y) => x >= sec.x && x <= sec.x + sec.w && y >= sec.y && y <= sec.y + sec.h;
  const marks = (S.marks || []).filter(mk => { if (mk.card || !mk.pts.length) return false; const xs = mk.pts.map(p => p[0]), ys = mk.pts.map(p => p[1]); return inside((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2); }).map(mk => mk.id);
  return { id, frames: m.frames.map(f => f.id), cards: m.cards.map(c => c.id), marks };
}
export function moveCaptured(S, cap, dx, dy) {
  const sec = (S.sections || []).find(s => s.id === cap.id);
  if (!sec) return 0;
  sec.x = r2(sec.x + dx); sec.y = r2(sec.y + dy);
  let n = 0;
  for (const f of S.frames) if (cap.frames.includes(f.id)) { f.x = r2(f.x + dx); f.y = r2(f.y + dy); n++; }
  for (const c of S.cards) if (cap.cards.includes(c.id)) { c.x = r2(c.x + dx); c.y = r2(c.y + dy); n++; }
  for (const mk of S.marks || []) if (cap.marks.includes(mk.id)) for (const p of mk.pts) { p[0] = r2(p[0] + dx); p[1] = r2(p[1] + dy); }
  return n;
}
export function moveSection(S, id, dx, dy) { const cap = captureSection(S, id); return cap ? moveCaptured(S, cap, dx, dy) : 0; }
export const SEMESTER_NAMES = ["01 리서치", "02 대지", "03 콘셉트", "04 진행", "05 최종 판넬"];
// semester board: 5 sections in a row; the A1 page goes into section 05
export function semesterLayout(seq0) {
  const W = 800, H = 1000, G = 40, sections = SEMESTER_NAMES.map((name, i) => ({ id: "sec" + (seq0 + i), name, x: i * (W + G), y: 0, w: W, h: H, color: SECTION_COLORS[i % 5], collapsed: false }));
  return { sections, pageAt: { x: sections[4].x + (W - 594) / 2, y: 80 } };
}
export function nextSemaineName(S, today = todayStr()) {
  let max = 0;
  for (const s of S.sections || []) { const m = /^Semaine (\d+)$/.exec(s.name); if (m) max = Math.max(max, Number(m[1])); }
  return `Semaine ${String(max ? max + 1 : isoWeek(today).week).padStart(2, "0")}`;
}
export const cardTitle = (S, c) => c.kind === "link" ? String(c.title || c.url || "링크").slice(0, 30) : c.kind === "image" || c.kind === "diagram" ? (S.assets?.[c.ref]?.title || c.kind) : c.kind === "stamp" ? "스탬프" : (String(c.text || "").split("\n")[0].slice(0, 30) || "글");
// work record grouped by ISO week: cards by creation date, comments by date, snapshots by date
export function groupByWeek(S, snaps = [], f = {}) {
  const dropIds = new Set(f.hideDrop ? S.cards.filter(c => c.status === "drop").map(c => c.id) : []);
  const wk = new Map(), get = d => { const k = weekLabel(isDate(d) ? d : todayStr()); if (!wk.has(k)) wk.set(k, { key: k, cards: [], comments: [], snaps: [] }); return wk.get(k); };
  const tagOk = c => !f.tag || (c.tags || []).includes(f.tag), stOk = c => !f.status || (c.status || "review") === f.status;
  for (const c of S.cards) { if (dropIds.has(c.id)) continue; if (tagOk(c) && stOk(c)) get(c.created).cards.push(c); }
  for (const m of S.comments || []) if ((!f.author || m.author === f.author) && !dropIds.has(m.card)) get(m.date).comments.push(m);
  if (!f.tag && !f.status && !f.author) for (const s of snaps) get(s.date).snaps.push(s);
  return [...wk.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
}
// search: text cards, asset titles, tags, comments, section names
export function searchRecord(S, q, opt = {}) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return [];
  const out = [], has = t => String(t || "").toLowerCase().includes(needle);
  const drop = id => opt.hideDrop && S.cards.some(c => c.id === id && c.status === "drop");
  for (const c of S.cards) {
    if (drop(c.id)) continue;
    const hit = (c.kind === "text" || c.kind === "memo") && has(c.text) ? "text" : c.kind === "link" && (has(c.title) || has(c.url)) ? "link" : (c.kind === "image" || c.kind === "diagram") && has(S.assets?.[c.ref]?.title) ? "title" : (c.tags || []).some(has) ? "tag" : null;
    if (hit) out.push({ type: "card", id: c.id, why: hit, text: cardTitle(S, c) });
  }
  for (const m of S.comments || []) if (has(m.text) && !drop(m.card)) out.push({ type: "comment", id: m.id, card: m.card, why: "comment", text: m.text.slice(0, 40) });
  for (const s of S.sections || []) if (has(s.name)) out.push({ type: "section", id: s.id, why: "section", text: s.name });
  return out;
}
// payload ids that snapshots still need (so gc keeps them and autosave stores them)
export const referencedAssetIds = snaps => { const ids = new Set(); for (const s of snaps || []) { const l = Array.isArray(s?.assetIds) ? s.assetIds : (s?.S && typeof s.S.assets === "object" && s.S.assets ? Object.keys(s.S.assets) : []); for (const id of l) if (idOk(id)) ids.add(String(id)); } return ids; };   // untrusted store: arrays only
export function gcKeep(S, hist, snaps) {
  const keep = new Set(Object.keys(S.assets || {}));
  for (const h of hist) { try { for (const id of Object.keys((typeof h === "string" ? JSON.parse(h) : h).assets || {})) keep.add(id); } catch { /* ignore */ } }
  for (const id of referencedAssetIds(snaps)) keep.add(id);
  return keep;
}

// ---- build 5b: link cards, arrows, stacks, shelf packing ---------------------------------------------------------------
export const MAX_ARROWS = 500;
// only plain http(s) URLs (<= 2000 chars) are accepted; anything else (javascript:, data:, relative, credentials-free check) is refused
export function cleanUrl(v) {
  if (typeof v !== "string" || v.length > 2000) return null;
  const t = v.trim();
  if (!/^https?:\/\//i.test(t)) return null;
  try { const u = new URL(t); return (u.protocol === "http:" || u.protocol === "https:") && u.hostname ? u.href : null; } catch { return null; }
}
export const hostOf = url => { try { return new URL(url).hostname; } catch { return ""; } };
export function cleanArrows(list, cardIds) {
  const out = [], seen = new Set(), pair = new Set();
  for (const a of (Array.isArray(list) ? list : []).slice(0, MAX_ARROWS * 2)) {
    if (out.length >= MAX_ARROWS) break;
    if (!a || !idOk(a.id) || seen.has(String(a.id)) || !cardIds.has(String(a.from)) || !cardIds.has(String(a.to)) || String(a.from) === String(a.to)) continue;   // dangling or self arrows are dropped
    const k = `${a.from}>${a.to}`;
    if (pair.has(k)) continue;
    seen.add(String(a.id)); pair.add(k);
    out.push({ id: String(a.id), from: String(a.from), to: String(a.to) });
  }
  return out;
}
// stack = cards sharing `stack`; `stacks[id]` is the member shown on top. A stack needs 2+ members.
export function cleanStacks(cards, rawStacks) {
  const members = new Map();
  for (const c of cards) if (c.stack) { if (!members.has(c.stack)) members.set(c.stack, []); members.get(c.stack).push(c); }
  const stacks = {};
  for (const [id, list] of members) {
    if (list.length < 2) { for (const c of list) c.stack = null; continue; }
    const top = rawStacks && typeof rawStacks === "object" ? rawStacks[id] : null;
    stacks[id] = list.some(c => c.id === top) ? top : list[0].id;
  }
  return stacks;
}
export const stackHidden = (S, c) => !!c.stack && !!S.stacks && S.stacks[c.stack] !== c.id;
export function cycleStack(S, id, dir = 1) {
  const list = S.cards.filter(c => c.stack === id);
  if (list.length < 2) return null;
  const i = list.findIndex(c => c.id === S.stacks[id]);
  S.stacks[id] = list[(i + dir + list.length) % list.length].id;
  return S.stacks[id];
}
// straight arrow between two card boxes ({x,y,w,h}): from the edge of A to the edge of B, with the head triangle at B
export function arrowSegment(a, b, head = 3) {
  const ac = [a.x + a.w / 2, a.y + a.h / 2], bc = [b.x + b.w / 2, b.y + b.h / 2], dx = bc[0] - ac[0], dy = bc[1] - ac[1];
  const edge = (box, c, sx, sy) => {   // where the ray c + t*(sx,sy) leaves the box
    const tx = sx ? (box.w / 2) / Math.abs(sx) : Infinity, ty = sy ? (box.h / 2) / Math.abs(sy) : Infinity, t = Math.min(tx, ty);
    return [c[0] + sx * t, c[1] + sy * t];
  };
  if (!dx && !dy) return null;
  const p1 = edge(a, ac, dx, dy), p2 = edge(b, bc, -dx, -dy), len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  if (len < 0.5 || (p2[0] - p1[0]) * dx + (p2[1] - p1[1]) * dy <= 0) return null;   // overlapping boxes: no arrow rather than one pointing backwards
  const ux = (p2[0] - p1[0]) / len, uy = (p2[1] - p1[1]) / len, h = Math.min(head, len / 2);
  return { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], head: [[p2[0], p2[1]], [p2[0] - ux * h - uy * h * 0.5, p2[1] - uy * h + ux * h * 0.5], [p2[0] - ux * h + uy * h * 0.5, p2[1] - uy * h - ux * h * 0.5]] };
}
// shelf packing into template columns: items [{aspect}] -> placements {i, x, y, w, h, capY}; each item gets a caption strip of capH below it
export function shelfPack(items, cols, area, gap, capH) {
  const n = Math.max(1, cols.length), out = [], over = [];
  let y = area.y0, row = [], rowH = 0;
  const flush = () => { y += rowH + gap; row = []; rowH = 0; };
  items.forEach((it, i) => {
    if (row.length === n) flush();
    const col = cols[row.length], w = col.w, h = w / (it.aspect || 1.4);
    if (y + h + capH > area.y1 + 1e-6) { over.push(i); return; }
    row.push(i); rowH = Math.max(rowH, h + capH);
    out.push({ i, x: col.x, y, w, h, capY: y + h });
  });
  return { placed: out, overflow: over };
}

// PDF page scales: always from the page's width/height (never a viewBox origin), with sane limits
export const pdfThumbScale = (w, h, max = 110) => { const m = Math.max(Number(w) || 0, Number(h) || 0); return m > 0 && Number.isFinite(m) ? Math.min(2, max / m) : 0; };
export const pdfRenderScale = (w, h) => { const m = Math.max(Number(w) || 0, Number(h) || 0); return m > 0 && Number.isFinite(m) ? Math.min(200 / 72, 2500 / m) : 0; };
export const MAX_PDF_THUMBS = 200;
