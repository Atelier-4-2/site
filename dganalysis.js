// Pure geometry / graph analysis for the vector-data diagrams (16 blocks,
// 25 Space Syntax choice, 27 street D/H). Coordinates: EPSG:2154 metres.
import { ringArea } from "./dgcore.js?v=20261113p";

// Roads that carry traffic or pedestrians on the ground (bridges/tunnels and
// "fictif" links do not split blocks or add paths).
const ON_GROUND = f => (f.props.position_par_rapport_au_sol == null || String(f.props.position_par_rapport_au_sol) === "0") &&
  f.props.fictif !== true;
const FOOT_ONLY = /Sentier|Escalier|Piste cyclable/i;

const key = p => `${Math.round(p[0] * 100)}_${Math.round(p[1] * 100)}`;

// Build a node/edge graph from road features. opts.streetsOnly drops footpaths,
// stairs and cycle tracks (used for blocks, where a path should not split a block).
export function roadGraph(roads, { streetsOnly = false } = {}) {
  const nodes = new Map(); // key -> index
  const pts = [];
  const edges = [];
  const node = p => {
    const k = key(p);
    let i = nodes.get(k);
    if (i === undefined) { i = pts.length; nodes.set(k, i); pts.push(p); }
    return i;
  };
  for (const f of roads) {
    if (!ON_GROUND(f)) continue;
    if (streetsOnly && FOOT_ONLY.test(f.props.nature || "")) continue;
    for (const line of f.lines) {
      if (line.length < 2) continue;
      const a = node(line[0]), b = node(line[line.length - 1]);
      let len = 0;
      for (let i = 1; i < line.length; i++) len += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
      if (len < 0.01) continue;
      edges.push({ a, b, pts: line, len, f });
    }
  }
  return { pts, edges };
}

// ---- 16 blocks: bounded faces of the planar road graph ----------------------------
export function blocksFromRoads(roads, minArea = 80) {
  let { pts, edges } = roadGraph(roads, { streetsOnly: true });
  // prune dead ends repeatedly
  for (;;) {
    const deg = new Int32Array(pts.length);
    for (const e of edges) { deg[e.a]++; deg[e.b]++; }
    const keep = edges.filter(e => deg[e.a] > 1 && deg[e.b] > 1);
    if (keep.length === edges.length) break;
    edges = keep;
  }
  // half-edges: 2i forward (a->b), 2i+1 reverse (b->a)
  const out = pts.map(() => []);
  const ang = (e, rev) => {
    const q = e.pts;
    let p0, p1;
    if (!rev) { p0 = q[0]; p1 = q[1]; } else { p0 = q[q.length - 1]; p1 = q[q.length - 2]; }
    return Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  };
  edges.forEach((e, i) => {
    out[e.a].push({ h: 2 * i, a: ang(e, false) });
    out[e.b].push({ h: 2 * i + 1, a: ang(e, true) });
  });
  const pos = new Map();
  for (const list of out) {
    list.sort((x, y) => x.a - y.a);
    list.forEach((o, i) => pos.set(o.h, i));
  }
  const origin = h => (h & 1 ? edges[h >> 1].b : edges[h >> 1].a);
  const dest = h => (h & 1 ? edges[h >> 1].a : edges[h >> 1].b);
  const seen = new Uint8Array(edges.length * 2);
  const faces = [];
  for (let h0 = 0; h0 < edges.length * 2; h0++) {
    if (seen[h0]) continue;
    const ring = [];
    let h = h0, guard = 0;
    while (!seen[h] && guard++ < 100000) {
      seen[h] = 1;
      const e = edges[h >> 1];
      const seq = h & 1 ? e.pts.slice().reverse() : e.pts;
      for (let i = 0; i < seq.length - 1; i++) ring.push(seq[i]);
      const v = dest(h);
      const list = out[v];
      const twin = h ^ 1;
      const i = pos.get(twin);
      h = list[(i - 1 + list.length) % list.length].h; // next clockwise from the twin
    }
    if (h !== h0 || ring.length < 3) continue;
    let s = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      s += a[0] * b[1] - b[0] * a[1];
    }
    if (s > 0 && s / 2 >= minArea) faces.push(ring); // CCW = bounded face, CW = outer
  }
  void origin; void ringArea;
  return faces;
}

// ---- 25 Space Syntax choice: edge betweenness with a metric cutoff -------------------
// Brandes' algorithm; paths longer than `cutoff` metres are ignored (local radius).
export function choiceBetweenness(roads, cutoff = 500, sourceRect = null) {
  const { pts, edges } = roadGraph(roads);
  const n = pts.length;
  const adj = Array.from({ length: n }, () => []);
  edges.forEach((e, i) => { adj[e.a].push({ to: e.b, w: e.len, e: i }); adj[e.b].push({ to: e.a, w: e.len, e: i }); });
  const score = new Float64Array(edges.length);

  // tiny binary heap on [dist, node]
  const heapPush = (hp, d, v) => {
    hp.push([d, v]);
    let i = hp.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hp[p][0] <= hp[i][0]) break;
      [hp[p], hp[i]] = [hp[i], hp[p]]; i = p;
    }
  };
  const heapPop = hp => {
    const top = hp[0], last = hp.pop();
    if (hp.length) {
      hp[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < hp.length && hp[l][0] < hp[m][0]) m = l;
        if (r < hp.length && hp[r][0] < hp[m][0]) m = r;
        if (m === i) break;
        [hp[m], hp[i]] = [hp[i], hp[m]]; i = m;
      }
    }
    return top;
  };

  const dist = new Float64Array(n), sigma = new Float64Array(n), delta = new Float64Array(n);
  const done = new Uint8Array(n);
  const pred = new Array(n).fill(null);
  for (let s = 0; s < n; s++) {
    // only paths that start inside the sheet (plus margin) are counted: the buffer
    // road network supplies the routes, not the origins
    if (sourceRect && (pts[s][0] < sourceRect[0] || pts[s][0] > sourceRect[2] || pts[s][1] < sourceRect[1] || pts[s][1] > sourceRect[3])) continue;
    dist.fill(Infinity); sigma.fill(0); delta.fill(0); done.fill(0);
    const order = [];
    const hp = [];
    dist[s] = 0; sigma[s] = 1; heapPush(hp, 0, s);
    while (hp.length) {
      const [d, v] = heapPop(hp);
      if (done[v] || d > dist[v]) continue;
      done[v] = 1; order.push(v);
      for (const { to, w, e } of adj[v]) {
        const nd = d + w;
        if (nd > cutoff) continue;
        if (nd < dist[to] - 1e-9) {
          dist[to] = nd; sigma[to] = sigma[v]; pred[to] = [[v, e]]; heapPush(hp, nd, to);
        } else if (Math.abs(nd - dist[to]) <= 1e-9 && !done[to]) {
          sigma[to] += sigma[v]; pred[to].push([v, e]);
        }
      }
    }
    for (let i = order.length - 1; i > 0; i--) {
      const w = order[i];
      const ps = pred[w] || [];
      for (const [v, e] of ps) {
        const c = sigma[v] / sigma[w] * (1 + delta[w]);
        score[e] += c; delta[v] += c;
      }
    }
    for (const v of order) pred[v] = null;
  }
  return edges.map((e, i) => ({ edge: e, score: score[i] / 2 })); // undirected
}

// ---- 27 street D/H ---------------------------------------------------------------------
// For each carriageway segment: D = largeur_de_chaussee (m, BD TOPO), H = median
// height of the nearest facade on each side along the segment (ray cast, <= 40 m).
export function streetDH(roads, buildings, hOf) {
  const CELL = 50;
  const grid = new Map();
  const bb = buildings.map((b, i) => {
    let a = Infinity, c = Infinity, d = -Infinity, e = -Infinity;
    for (const p of b.polygon) { a = Math.min(a, p[0]); c = Math.min(c, p[1]); d = Math.max(d, p[0]); e = Math.max(e, p[1]); }
    for (let gx = Math.floor(a / CELL); gx <= Math.floor(d / CELL); gx++)
      for (let gy = Math.floor(c / CELL); gy <= Math.floor(e / CELL); gy++) {
        const k = gx + "_" + gy;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    return [a, c, d, e];
  });
  const cast = (ox, oy, dx, dy, maxD) => {
    let best = Infinity, who = -1;
    const x1 = ox + dx * maxD, y1 = oy + dy * maxD;
    const cand = new Set();
    for (let gx = Math.floor(Math.min(ox, x1) / CELL); gx <= Math.floor(Math.max(ox, x1) / CELL); gx++)
      for (let gy = Math.floor(Math.min(oy, y1) / CELL); gy <= Math.floor(Math.max(oy, y1) / CELL); gy++)
        for (const i of grid.get(gx + "_" + gy) || []) cand.add(i);
    for (const i of cand) {
      const r = buildings[i].polygon;
      for (let k = 0, m = r.length; k < m; k++) {
        const a = r[k], b = r[(k + 1) % m];
        const ex = b[0] - a[0], ey = b[1] - a[1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((a[0] - ox) * ey - (a[1] - oy) * ex) / den;
        const u = ((a[0] - ox) * dy - (a[1] - oy) * dx) / den;
        if (t > 0.3 && t <= maxD && t < best && u >= 0 && u <= 1) { best = t; who = i; }
      }
    }
    return who >= 0 ? { d: best, i: who } : null;
  };
  const median = a => {
    if (!a.length) return null;
    a = a.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length & 1 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  const out = [];
  for (const f of roads) {
    if (!ON_GROUND(f)) continue;
    const width = f.props.largeur_de_chaussee != null ? Number(f.props.largeur_de_chaussee) : null;
    for (const line of f.lines) {
      const hs = [];
      for (let s = 0; s < line.length - 1; s++) {
        const a = line[s], b = line[s + 1];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 0.5) continue;
        const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
        const steps = Math.max(1, Math.round(L / 12));
        for (let k = 0; k < steps; k++) {
          const t = (k + .5) / steps;
          const ox = a[0] + (b[0] - a[0]) * t, oy = a[1] + (b[1] - a[1]) * t;
          for (const sgn of [1, -1]) {
            const hit = cast(ox, oy, -uy * sgn, ux * sgn, 40);
            if (!hit) continue;
            const h = hOf(buildings[hit.i]);
            if (h != null) hs.push(h);
          }
        }
      }
      const H = median(hs);
      out.push({ pts: line, f, D: width, H, ratio: width != null && H != null && H > 0 ? width / H : null });
    }
  }
  return out;
}

// Visual label point of a polygon ring: grid sample, inside the ring, farthest from its edges.
export function labelPoint(ring) {
  let a = Infinity, c = Infinity, d = -Infinity, e = -Infinity;
  for (const p of ring) { a = Math.min(a, p[0]); c = Math.min(c, p[1]); d = Math.max(d, p[0]); e = Math.max(e, p[1]); }
  const inside = (x, y) => {
    let r = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const pi = ring[i], pj = ring[j];
      if ((pi[1] > y) !== (pj[1] > y) && x < (pj[0] - pi[0]) * (y - pi[1]) / (pj[1] - pi[1]) + pi[0]) r = !r;
    }
    return r;
  };
  const edgeDist = (x, y) => {
    let m = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const p = ring[j], q = ring[i];
      const dx = q[0] - p[0], dy = q[1] - p[1];
      const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / (dx * dx + dy * dy || 1)));
      m = Math.min(m, Math.hypot(x - (p[0] + t * dx), y - (p[1] + t * dy)));
    }
    return m;
  };
  let best = null, bd = -1;
  const N = 14;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const x = a + (d - a) * (i + .5) / (N + 1), y = c + (e - c) * (j + .5) / (N + 1);
    if (!inside(x, y)) continue;
    const dd = edgeDist(x, y);
    if (dd > bd) { bd = dd; best = [x, y]; }
  }
  return best ? { p: best, r: bd } : null;
}

// Building height in metres: BD TOPO `hauteur`, else estimated from `nombre_d_etages`
// (stories above the ground floor, so 0 = ground floor only) at 3 m per level.
export const heightOf = b => b.h != null ? b.h : b.floors != null ? (b.floors + 1) * 3 : null;
export const heightEstimated = b => b.h == null && b.floors != null;


// Clip a polyline to an axis-aligned rectangle [x0,y0,x1,y1]; returns the pieces inside.
export function clipLineRect(pts, r) {
  const [x0, y0, x1, y1] = r;
  const inside = p => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  const out = [];
  let cur = [];
  const cut = (a, b) => { // Liang-Barsky for one segment; returns [t0,t1] or null
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]]) {
      if (p === 0) { if (q < 0) return null; continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
    return [t0, t1];
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (inside(a) && inside(b)) { if (!cur.length) cur.push(a); cur.push(b); continue; }
    const c = cut(a, b);
    if (!c) { if (cur.length > 1) out.push(cur); cur = []; continue; }
    const p0 = [a[0] + (b[0] - a[0]) * c[0], a[1] + (b[1] - a[1]) * c[0]];
    const p1 = [a[0] + (b[0] - a[0]) * c[1], a[1] + (b[1] - a[1]) * c[1]];
    if (cur.length) cur.push(p0); else cur = [p0];
    cur.push(p1);
    if (c[1] < 1) { out.push(cur); cur = []; }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}
