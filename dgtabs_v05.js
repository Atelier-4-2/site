import { semanticPalette } from "./dgsemantic_v02.js?v=20261116n";
// Analysis tabs A1-A8 of the site-diagram mode (step 4). three.js for the 3D tabs
// (same three build / importmap as viewer3d.js), plain SVG for section, context,
// merge and axonometric export. All computed results are reference simulations.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { mix, renderSvg, ringArea, seqOf, clipRingRect } from "./dgcore_v04.js?v=20261116n";
import { heightOf } from "./dganalysis.js?v=20261113p";
import {
  sunPosition, parisDate, parisOffset, KEY_DAYS, demAt, sunHours, shadowMask, nearestStation
} from "./dgenv_v02.js?v=20261116n";
import { surfaceOf } from "./dgdefs3_v05.js?v=20261116n";
import { extendGround, gaussian } from "./dgcontour_v03.js?v=20261113cards2";
import { UTCI_CATS, UTCI_RANGE, utciCat } from "./dgutci.js?v=20261113x";
import { buildPlate, utciEnv, utciInfoText, CLIMATE, KO_PLATE, SPEED_LABELS, SHADOW_DAYS, SHADOW_HOURS } from "./dgclimplate_v03.js?v=20261116n";

const SIM = "참고용 시뮬레이션 · 법적 효력 없음";
import { LB_KINDS as WIND_KINDS, buildLbPlate as windPlate, smoothPath, WIND_B1, KO_B1 } from "./dglb_wind_v02.js?v=20261116n";
import { LB_KINDS as SUN_KINDS, buildLbPlate as sunPlate } from "./dglb_sun_v02.js?v=20261116n";
import { LB_KINDS as PSY_KINDS, buildLbPlate as psyPlate } from "./dglb_psy_v02.js?v=20261116n";

const LB_KINDS = [...WIND_KINDS, ...SUN_KINDS, ...PSY_KINDS];
const LB_BUILD = Object.fromEntries([
  ...WIND_KINDS.map(d => [d.kind, windPlate]),
  ...SUN_KINDS.map(d => [d.kind, sunPlate]),
  ...PSY_KINDS.map(d => [d.kind, psyPlate])
]);
const TABS = [
  ["A1", "3D 볼륨"], ["A2", "일조·그림자"], ["A3", "바람"], ["A4", "열쾌적성"],
  ["A5", "단면"], ["A6", "컨텍스트 맵"], ["A7", "다이어그램 오버레이"], ["A8", "3D 액소노메트릭"]
];
TABS.push(...LB_KINDS.map(d => [d.kind, d.ko]));
const RAD = Math.PI / 180;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hOf = b => { const h = heightOf(b); return h == null ? 3 : h; };
// sequential ramps always run light (low) -> dark (high); some themes list `cool` dark-first
const lumOf = c => parseInt(c.slice(1, 3), 16) * .2126 + parseInt(c.slice(3, 5), 16) * .7152 + parseInt(c.slice(5, 7), 16) * .0722;
// 2026 autumn equinox is 23 September (dgenv.js KEY_DAYS and the B3 plate say 9/22)
const KEYS = KEY_DAYS.map(k => k.id === "autumn" ? { ...k, d: 23, label: "추분 9/23" } : k);
const lbOpts = (kind, opts) => kind === "B3" && opts.day === "autumn" ? { ...opts, day: "custom", month: 9, date: 23 } : { ...opts };
const COMPASS8 =["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const lightToDark = r => lumOf(r[0]) < lumOf(r[r.length - 1]) ? [...r].reverse() : r;

// phones (touch): plates zoom on double tap and pan only while zoomed, so a finger on a plate still scrolls the page
const PHONE = () => window.matchMedia("(max-width: 799px)").matches;
const ZOOM_HINT = PHONE() ? "두 번 탭하면 그 지점을 확대하고, 다시 두 번 탭하면 원래 크기로 돌아갑니다. 확대한 상태에서는 드래그로 이동할 수 있습니다. " : "마우스 휠로 확대/축소, 드래그로 이동할 수 있습니다. ";
// Wheel zoom (towards the cursor), drag pan and double-click reset for an SVG sheet inside `wrap`.
// A3 sheets are far smaller than life on screen (3-5 px text); this only changes the on-screen viewBox,
// exports are built from their own SVG strings.
// opts.wheel === false: no wheel zoom (for a scrolling container such as the card detail dialog, where
// the wheel must keep scrolling); double-click then toggles a 2.5x zoom at the clicked point.
export function panZoom(wrap, opts = {}) {
  if (!wrap || wrap.dataset.pz) return;
  wrap.dataset.pz = "1";
  const wheel = opts.wheel !== false && !PHONE();
  wrap.style.cursor = wheel ? "grab" : "zoom-in";
  if (wheel) wrap.style.touchAction = "none";
  const svgOf = () => wrap.querySelector("svg");
  const homeOf = s => {
    if (!s.dataset.home) { const b = s.viewBox.baseVal; s.dataset.home = [b.x, b.y, b.width, b.height].join(" "); }
    return s.dataset.home.split(" ").map(Number);
  };
  const cur = s => { const b = s.viewBox.baseVal; return [b.x, b.y, b.width, b.height]; };
  const put = (s, v) => {
    const h = homeOf(s);
    v[2] = Math.max(h[2] / 12, Math.min(h[2], v[2])); v[3] = v[2] * h[3] / h[2];
    v[0] = Math.max(h[0], Math.min(h[0] + h[2] - v[2], v[0]));
    v[1] = Math.max(h[1], Math.min(h[1] + h[3] - v[3], v[1]));
    s.setAttribute("viewBox", v.join(" "));
  };
  if (wheel) wrap.addEventListener("wheel", e => {
    const s = svgOf(); if (!s?.viewBox?.baseVal?.width) return;
    const h = homeOf(s), vb = cur(s);
    if (e.deltaY > 0 && vb[2] >= h[2] - 1e-6) return;          // fully zoomed out: let the page scroll
    e.preventDefault();
    const pt = s.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const u = pt.matrixTransform(s.getScreenCTM().inverse());
    const nw = vb[2] * (e.deltaY > 0 ? 1.15 : 1 / 1.15), nh = nw * h[3] / h[2];
    put(s, [u.x - (u.x - vb[0]) / vb[2] * nw, u.y - (u.y - vb[1]) / vb[3] * nh, nw, nh]);
  }, { passive: false });
  let drag = null;
  wrap.addEventListener("pointerdown", e => {
    const s = svgOf(); if (!s) return;
    const h = homeOf(s), vb = cur(s);
    if (!wheel && vb[2] >= h[2] - 1e-6) return;                 // dialog, not zoomed: leave touch / scroll alone
    drag = { x: e.clientX, y: e.clientY, vb }; wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener("pointermove", e => {
    const s = svgOf(); if (!drag || !s) return;
    const k = s.getScreenCTM().a || 1;                           // screen px per sheet unit
    put(s, [drag.vb[0] - (e.clientX - drag.x) / k, drag.vb[1] - (e.clientY - drag.y) / k, drag.vb[2], drag.vb[3]]);
  });
  wrap.addEventListener("pointerup", () => { drag = null; });
  wrap.addEventListener("pointercancel", () => { drag = null; });
  wrap.addEventListener("dblclick", e => {
    const s = svgOf(); if (!s?.viewBox?.baseVal?.width) return;
    const h = homeOf(s), vb = cur(s);
    if (wheel || vb[2] < h[2] - 1e-6) { s.setAttribute("viewBox", s.dataset.home); if (!wheel) wrap.style.cursor = "zoom-in"; return; }
    const pt = s.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const u = pt.matrixTransform(s.getScreenCTM().inverse());
    const nw = h[2] / 2.5, nh = h[3] / 2.5;
    put(s, [u.x - nw / 2, u.y - nh / 2, nw, nh]);
    wrap.style.cursor = "grab";
  });
}

export function createTabs(api) {
  const $ = id => document.getElementById(id);
  const bar = $("dg-tabbar"), controls = $("dg-controls"), stage = $("dg-stage"), note = $("dg-tabnote");
  // Legends of the 3D tabs sit inside the stage (top-left) instead of between the controls and the
  // stage, where every legend row pushed the 3D view down and made it shorter.
  if (!document.getElementById("dg-legend-ov-css")) {
    const st = document.createElement("style"); st.id = "dg-legend-ov-css";
    st.textContent = ".dg-legend-ov{position:absolute;left:12px;top:12px;width:min(440px,60%);z-index:2;pointer-events:none;text-align:left;font-size:12px;line-height:1.5}" +
      ".dg-legend-ov>*{display:block;box-sizing:border-box;width:fit-content;max-width:100%;margin:0 0 4px;padding:6px 10px;border-radius:10px;background:rgb(255 255 255 / 88%)}" +
      ".dg-legend-ov>*:empty,.dg-legend-ov>[hidden]{display:none}" +
      ".dg-legend-ov.dg-legend-below{position:static;width:100%;margin:8px 0 0;pointer-events:auto}.dg-legend-below>*{padding:4px 0;background:none}";
    document.head.append(st);
  }
  const stageLegend = (...ids) => {
    const box = document.createElement("div"); box.className = "dg-legend-ov";
    for (const id of ids) { const el = $(id); if (el) box.append(el); }
    // phones: under the stage, not over the model (the box covered up to half of a 370 px wide view)
    if (window.matchMedia("(max-width: 799px)").matches) { box.classList.add("dg-legend-below"); stage.after(box); }
    else stage.append(box);
  };
  let active = "A1";
  function fitStage() {
    const r = stage.getBoundingClientRect();
    if (!r.width) return;
    const scale = r.width / stage.offsetWidth;
    stage.style.boxSizing = "border-box";
    const above = r.top - bar.getBoundingClientRect().top;   // tab bar + controls height, scroll-independent
    // phones (real single-column layout, no zoom): a near-square 3D stage; plates size themselves in CSS
    const cap = window.matchMedia("(max-width: 799px)").matches ? stage.offsetWidth * 1.1 : Infinity;
    stage.style.height =
      Math.min(cap, Math.max(420, (window.innerHeight / scale) - 64 - above / scale - 24)) + "px";
    gl?.resize?.();
  }
  window.addEventListener("resize", fitStage);
  new ResizeObserver(fitStage).observe(controls);
  const basePalette = api.pal;
  api = { ...api, pal: () => {
    const p = semanticPalette(basePalette());
    const ramps = { A2: p.sun, A3: p.wind, A4: p.sun, A8: lightToDark(p.height) };
    return { ...p, seq5: ramps[active] || p.height };
  } };
  let gl = null;          // { renderer, scene, camera, controls, raf, sun, ... }
  const state = { date: "equinox", hour: 13, overlay: "none", season: 0, month: 7, utciHour: 14, axoAz: 45, axoEl: 30, axoMode: "height", ctxOrtho: false, view: { A2: "3d", A3: "3d", A4: "3d", B1: "plate", B2: "plate", B3: "plate", B4: "plate" } };
  const section = { a: null, b: null };

  // ---- shell -------------------------------------------------------------------------------
  // two rows by group (A = 3D / drawing tabs, B = climate plates): a forced line break after the last A tab,
  // instead of letting the flex row wrap wherever it runs out and leave one orphan tab on a second line
  bar.innerHTML = TABS.map(([id, label], i) =>
    (i && id[0] !== TABS[i - 1][0][0] ? `<span role="presentation" style="flex-basis:100%;height:0"></span>` : "") +
    `<button type="button" role="tab" data-tab="${id}" aria-selected="${id === active}">${id} · ${label}</button>`).join("");
  bar.addEventListener("click", e => {
    const b = e.target.closest("[data-tab]");
    if (b) show(b.dataset.tab);
  });
  // WAI-ARIA tabs: roving tabindex + arrow keys, stage is the tabpanel
  stage.setAttribute("role", "tabpanel");
  bar.addEventListener("keydown", e => {
    const tabsEl = [...bar.querySelectorAll("[data-tab]")];
    const i = tabsEl.findIndex(b => b === document.activeElement);
    if (i < 0) return;
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next = tabsEl[e.key === "Home" ? 0 : e.key === "End" ? tabsEl.length - 1 : (i + d + tabsEl.length) % tabsEl.length];
    show(next.dataset.tab);
    bar.querySelector(`[data-tab="${next.dataset.tab}"]`).focus();
  });

  // 3D view | plate (vector SVG axonometric) switch for the climate tabs A2 / A3 / A4
  const saveGroup = html => `<span class="dg-save" role="group" aria-label="저장"><span class="dg-save-label">저장</span>${html}</span>`;
  const viewToggle = id => `<span class="dg-view segmented" role="group" aria-label="보기">${[["3d", KO_PLATE["plate.view3d"]], ["plate", KO_PLATE["plate.viewPlate"]]].map(([v, t]) => `<button type="button" data-view="${v}" aria-pressed="${state.view[id] === v}">${t}</button>`).join("")}</span>`;
  controls.addEventListener("click", e => {
    const b = e.target.closest("[data-view]");
    if (b && state.view[active]) { state.view[active] = b.dataset.view; show(active); }
  });

  function disposeGl() {
    if (!gl) return;
    cancelAnimationFrame(gl.raf);
    gl.stopPlay?.();                         // A2 "play" timer must not survive a tab switch
    gl.controls?.dispose();
    gl.scene.traverse(o => { o.shadow?.map?.dispose(); o.geometry?.dispose(); const m = o.material; if (m) (Array.isArray(m) ? m : [m]).forEach(x => { x.map?.dispose(); x.dispose(); }); });
    gl.renderer.dispose();
    gl.ro?.disconnect();
    gl = null;
  }

  function clearStage() { disposeGl(); stage.parentElement?.querySelectorAll(".dg-legend-below").forEach(el => el.remove()); stage.replaceChildren(); controls.replaceChildren(); note.textContent = ""; }

  // ---- shared 3D scene -------------------------------------------------------------------------
  function ready() { return api.ctx() && api.data().buildings; }

  function frame3d(withShadow) {
    const ctx = api.ctx(), pal = api.pal();
    const w = stage.clientWidth || 800, h = stage.clientHeight || 500;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    renderer.setSize(w, h);
    if (withShadow) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; }
    stage.append(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(pal.bg);
    const side = Math.max(ctx.extent[2] - ctx.extent[0], ctx.extent[3] - ctx.extent[1]);
    const camera = new THREE.PerspectiveCamera(40, w / h, 5, side * 20);
    camera.position.set(side * .7, side * .65, side * .85);
    camera.position.multiplyScalar(Math.max(1, 1.45 / (w / h)));   // portrait stage (phone): step back so the model is not cropped left and right
    const controlsO = new OrbitControls(camera, renderer.domElement);
    controlsO.target.set(0, 0, 0); controlsO.maxPolarAngle = Math.PI * .495; controlsO.update();
    const g = { renderer, scene, camera, controls: controlsO, side, raf: 0 };
    const loop = () => { g.raf = requestAnimationFrame(loop); controlsO.update(); g.tick?.(); renderer.render(scene, camera); };
    loop();
    g.resize = () => {
      const W = stage.clientWidth, H = stage.clientHeight;
      if (!W || !H) return;
      renderer.setSize(W, H); camera.aspect = W / H; camera.updateProjectionMatrix();
      g.fit?.();
    };
    g.ro = new ResizeObserver(g.resize);
    g.ro.observe(stage);
    gl = g;
    return g;
  }

  // Exact camera fit: the smallest distance (along the current view direction) at which all eight
  // corners of `box` are inside the frustum; the look-at point slides along the view's up axis so the
  // box is centred vertically (in perspective the far half is smaller than the near half).
  function makeFit(g, box) {
    return () => {
      const dir = g.camera.position.clone().sub(g.controls.target).normalize();
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
      const up = new THREE.Vector3().crossVectors(dir, right);
      const tanV = Math.tan(g.camera.fov * RAD / 2), tanH = tanV * g.camera.aspect;
      const cs = [];
      const c = new THREE.Vector3();
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        c.set(x, y, z);
        cs.push([c.dot(dir), c.dot(up), c.dot(right)]);
      }
      const kV = tanV * .96, kH = tanH * .96;
      const range = d => {
        let lo = -Infinity, hi = Infinity;
        for (const [a, u] of cs) { lo = Math.max(lo, u - kV * (d - a)); hi = Math.min(hi, u + kV * (d - a)); }
        return [lo, hi];
      };
      let dMin = Math.max(...cs.map(([a, , r]) => a + Math.abs(r) / kH)), dMax = dMin + g.side * 20;
      if (range(dMin)[0] > range(dMin)[1]) {
        for (let i = 0; i < 40; i++) { const m = (dMin + dMax) / 2; const [lo, hi] = range(m); if (lo > hi) dMin = m; else dMax = m; }
        dMin = dMax;
      }
      const dist = dMin, [lo, hi] = range(dist);
      const target = up.clone().multiplyScalar((lo + hi) / 2);
      g.controls.target.copy(target);
      g.camera.position.copy(target).addScaledVector(dir, dist);
      g.camera.far = Math.max(g.side * 20, dist * 3);
      g.camera.updateProjectionMatrix();
      g.controls.update();
    };
  }

  // free geometry/materials of everything in a group before clearing it
  function disposeGroup(grp) {
    grp.traverse(o => { o.geometry?.dispose(); const m = o.material; if (m) (Array.isArray(m) ? m : [m]).forEach(x => { x.map?.dispose(); x.dispose(); }); });
    grp.clear();
  }

  // Lambert-93 grid convergence (rad): true azimuth + CONV() = azimuth on the map grid, as in the plates
  const CONV = () => (api.ctx().convergence || 0) * RAD;
  const baseZ = () => demAt(api.data().dem, api.ctx().center[0], api.ctx().center[1]);
  // map (x,y,z) -> scene (x, z, -y) around the site centre
  const P3 = (x, y, z = 0) => new THREE.Vector3(x - api.ctx().center[0], z - baseZ(), -(y - api.ctx().center[1]));

  // Circular site: everything in the 3D model is cut to the circle (owner 2026-11-15), like the cards.
  const circleSite = () => api.ctx().shape?.kind === "circle";
  const inShape = (x, y) => {
    if (!circleSite()) return true;
    const c = api.ctx(), r = (c.extent[2] - c.extent[0]) / 2;
    return Math.hypot(x - c.center[0], y - c.center[1]) <= r + .01;
  };
  // Sutherland-Hodgman against a convex ring (the 128-gon of a circular site)
  function clipRingConvex(ring, conv) {
    const sgn = signedArea(conv) > 0 ? 1 : -1;
    let res = ring;
    for (let i = 0; i < conv.length && res.length; i++) {
      const p0 = conv[i], p1 = conv[(i + 1) % conv.length], ex = p1[0] - p0[0], ey = p1[1] - p0[1];
      if (Math.abs(ex) + Math.abs(ey) < 1e-9) continue;
      const side = p => sgn * (ex * (p[1] - p0[1]) - ey * (p[0] - p0[0]));     // >= 0: inside
      const inp = res; res = [];
      for (let j = 0; j < inp.length; j++) {
        const p = inp[j], q = inp[(j + 1) % inp.length], sp = side(p), sq = side(q);
        if (sp >= 0) res.push(p);
        if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); res.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
      }
    }
    return res;
  }
  const clipToSite = ring => {
    const [x0, y0, x1, y1] = api.ctx().extent;
    const r = clipRingRect(ring, x0, y0, x1, y1);
    return circleSite() && r.length >= 3 ? clipRingConvex(r, api.ctx().site.ring) : r;
  };
  // Ground vertices [x, y] (map coordinates) and triangle indices: the DEM grid over the extent, or,
  // for a circular site, a disc on a polar grid so the edge of the ground is a clean circle.
  function groundPts() {
    const ctx = api.ctx(), dem = api.data().dem, [x0, y0, x1, y1] = ctx.extent;
    const pts = [], idx = [];
    if (circleSite()) {
      const R = (x1 - x0) / 2, K = Math.max(12, Math.min(48, Math.round(R / 12))), M = 96;
      pts.push([ctx.center[0], ctx.center[1]]);
      for (let k = 1; k <= K; k++) for (let m = 0; m < M; m++) {
        const t = m / M * Math.PI * 2, r = R * k / K;
        pts.push([ctx.center[0] + Math.sin(t) * r, ctx.center[1] + Math.cos(t) * r]);
      }
      for (let m = 0; m < M; m++) idx.push(0, 1 + m, 1 + (m + 1) % M);
      for (let k = 1; k < K; k++) for (let m = 0; m < M; m++) {
        const a0 = 1 + (k - 1) * M + m, a1 = 1 + (k - 1) * M + (m + 1) % M, b0 = a0 + M, b1 = a1 + M;
        idx.push(a0, b0, a1, a1, b0, b1);
      }
      return { pts, idx };
    }
    const nx = Math.max(2, dem ? dem.nx : 2), ny = Math.max(2, dem ? dem.ny : 2);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pts.push([x0 + (x1 - x0) * i / (nx - 1), y0 + (y1 - y0) * j / (ny - 1)]);
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const p = j * nx + i, q = p + 1, r = p + nx, t = r + 1;
      idx.push(p, r, q, q, r, t);
    }
    return { pts, idx };
  }

  function terrain(pal) {
    const dem = api.data().dem, { pts, idx } = groundPts();
    const pos = [];
    for (const [x, y] of pts) { const p = P3(x, y, demAt(dem, x, y) - 0.05); pos.push(p.x, p.y, p.z); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: pal.dark ? mix(mix(pal.bg, pal.green, .5), "#ffffff", .14) : mix(pal.bg, pal.green, .25), roughness: 1, side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    return mesh;
  }

  // Water surfaces (BD TOPO surface_hydrographique) clipped to the sheet and draped just above the terrain,
  // so a river reads as water instead of bare ground.
  function water(pal) {
    const feats = api.data().waterS;
    if (!feats?.length) return null;
    const ctx = api.ctx(), dem = api.data().dem, [x0, y0, x1, y1] = ctx.extent;
    const v2 = r => r.map(p => new THREE.Vector2(p[0] - ctx.center[0], -(p[1] - ctx.center[1])));
    const geos = [];
    for (const f of feats) for (const rings of f.polygons) {
      const [outer, ...holes] = rings.map(clipToSite);
      if (!outer || outer.length < 3) continue;
      const sh = new THREE.Shape(v2(outer));
      for (const h of holes) if (h.length >= 3) sh.holes.push(new THREE.Path(v2(h)));
      const g = new THREE.ShapeGeometry(sh);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) + ctx.center[0], y = -pos.getY(i) + ctx.center[1];
        pos.setXYZ(i, pos.getX(i), demAt(dem, x, y) - baseZ() + .2, pos.getY(i));
      }
      g.deleteAttribute("uv"); g.deleteAttribute("normal");
      geos.push(g);
    }
    if (!geos.length) return null;
    const merged = mergeGeometries(geos, false);
    geos.forEach(g => g.dispose());
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: pal.water, roughness: .55, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    // drawn after terrain and buildings without writing depth, so ground overlays (sun hours, UTCI ...)
    // always cover the water even where the sparse water triangles sit above the DEM grid
    mesh.renderOrder = 1;
    mesh.receiveShadow = true;
    return mesh;
  }

  // A building reduced to its part inside the analysis extent (owner 2026-11-15: buildings that
  // cross the edge are cut there instead of sticking out of the base plate). null = entirely outside.
  function clipBld(b) {
    const polygon = clipToSite(b.polygon);
    if (polygon.length < 3 || ringArea(polygon) < 1) return null;
    const holes = (b.holes || []).map(clipToSite).filter(h => h.length >= 3 && ringArea(h) >= .5);
    return { polygon, holes };
  }

  // All buildings become ONE mesh and ONE line-segment object (vertex colours carry the per-building tint).
  function buildings(pal, colourOf = null) {
    const data = api.data(), c0 = api.ctx().center;
    const grp = new THREE.Group();
    const solids = [], edges = [];
    const tint = new THREE.Color();
    for (const b of data.buildings) {
      const cb = clipBld(b);                       // only the part inside the analysis extent
      if (!cb) continue;
      const shape = new THREE.Shape(cb.polygon.map(p => new THREE.Vector2(p[0] - c0[0], p[1] - c0[1])));
      for (const hole of cb.holes) shape.holes.push(new THREE.Path(hole.map(p => new THREE.Vector2(p[0] - c0[0], p[1] - c0[1]))));
      let gmin = Infinity, gmax = -Infinity;
      for (const p of b.polygon) { const z = demAt(data.dem, p[0], p[1]); gmin = Math.min(gmin, z); gmax = Math.max(gmax, z); }
      const h = hOf(b);
      // roof = lowest ground under the footprint + height: the same datum as the A5 section and the A8
      // axonometric (BD TOPO hauteur is measured from the lowest ground point)
      const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, gmin - baseZ(), 0);
      const known = heightOf(b) != null;
      tint.set(colourOf ? colourOf(b, h) : (known ? pal.building : mix(pal.building, pal.bg, .5)));
      const n = geo.attributes.position.count, colors = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { colors[i * 3] = tint.r; colors[i * 3 + 1] = tint.g; colors[i * 3 + 2] = tint.b; }
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      solids.push(geo);
      const eg = new THREE.EdgesGeometry(geo, 30);
      eg.deleteAttribute("normal"); eg.deleteAttribute("uv");
      edges.push(eg);
    }
    if (solids.length) {
      const merged = mergeGeometries(solids.map(g => { g.deleteAttribute("uv"); return g; }), false);
      const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .9, flatShading: true }));
      mesh.castShadow = true; mesh.receiveShadow = true;
      grp.add(mesh);
      grp.add(new THREE.LineSegments(mergeGeometries(edges, false), new THREE.LineBasicMaterial({ color: pal.buildingLine })));
      solids.forEach(g => g.dispose()); edges.forEach(g => g.dispose());
    }
    return grp;
  }

  // A texture draped over the ground mesh (vertices follow the DEM, lifted `lift` m).
  function draped(tex, S, lift, opacity = 1) {
    const dem = api.data().dem, { pts, idx } = groundPts();
    const pos = [], uv = [];
    const W = S.width ?? S.nx * S.step, H = S.height ?? S.ny * S.step;
    for (const [x, y] of pts) {
      const p = P3(x, y, demAt(dem, x, y) + lift);
      pos.push(p.x, p.y, p.z);
      uv.push((x - S.x0) / W, (y - S.y0) / H);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
    m.renderOrder = 3;
    return m;
  }

  // Canvas texture from a per-cell RGBA function (row 0 = south, flipped for the canvas).
  function gridTexture(S, rgba) {
    const cv = document.createElement("canvas"); cv.width = S.nx; cv.height = S.ny;
    const c2 = cv.getContext("2d"), img = c2.createImageData(S.nx, S.ny);
    for (let j = 0; j < S.ny; j++) for (let i = 0; i < S.nx; i++) {
      const c = rgba(j * S.nx + i), o = ((S.ny - 1 - j) * S.nx + i) * 4;
      if (!c) { img.data[o + 3] = 0; continue; }
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = c[3] ?? 235;
    }
    c2.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  // Smooth version of gridTexture: the per-cell scalar `val(k)` (NaN = no data, e.g. inside a
  // building) is bilinearly interpolated on an `up`× finer canvas and only then classified by
  // `col(v)`, so class boundaries follow smooth curves instead of the 4 m cell staircase that
  // showed as saw-teeth in the 3D views.
  function fieldTexture(S, val, col, up = 4, hide = null) {
    const v = new Float32Array(S.nx * S.ny);
    for (let k = 0; k < v.length; k++) v[k] = val(k);
    const W = S.nx * up, H = S.ny * up;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const c2 = cv.getContext("2d"), img = c2.createImageData(W, H);
    const at = (i, j) => v[Math.max(0, Math.min(S.ny - 1, j)) * S.nx + Math.max(0, Math.min(S.nx - 1, i))];
    for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
      const gx = (px + .5) / up - .5, gy = (py + .5) / up - .5;   // grid coords, cell centres at integers
      const i0 = Math.floor(gx), j0 = Math.floor(gy), fx = gx - i0, fy = gy - j0;
      const q = [[at(i0, j0), (1 - fx) * (1 - fy)], [at(i0 + 1, j0), fx * (1 - fy)], [at(i0, j0 + 1), (1 - fx) * fy], [at(i0 + 1, j0 + 1), fx * fy]];
      let s = 0, w = 0;
      for (const [a, b] of q) if (!Number.isNaN(a)) { s += a * b; w += b; }
      const own = at(Math.round(gx), Math.round(gy));
      const o = ((H - 1 - py) * W + px) * 4;
      if (hide) {                                             // e.g. water cells: no overlay colour there
        const hv = (i, j) => hide[Math.max(0, Math.min(S.ny - 1, j)) * S.nx + Math.max(0, Math.min(S.nx - 1, i))];
        if (hv(i0, j0) * (1 - fx) * (1 - fy) + hv(i0 + 1, j0) * fx * (1 - fy) + hv(i0, j0 + 1) * (1 - fx) * fy + hv(i0 + 1, j0 + 1) * fx * fy > .5) { img.data[o + 3] = 0; continue; }
      }
      if (Number.isNaN(own) || w === 0) { img.data[o + 3] = 0; continue; }
      const c = col(s / w);
      if (!c) { img.data[o + 3] = 0; continue; }
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = c[3] ?? 235;
    }
    c2.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.LinearFilter; tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  // A ground value grid prepared for draping: building cells (NaN) take the value of the nearest ground
  // cell, so the colour runs under the building footprints instead of stopping at the 4 m cell staircase
  // (which showed as saw-teeth along every wall), and a light blur (`sigma` cells) removes the blotches of
  // values quantised to 30-minute or 1-hour steps. Drawing only; the numbers themselves are unchanged.
  const groundField = (S, val, sigma = 0) => {
    const f = extendGround(Float32Array.from({ length: S.nx * S.ny }, (_, k) => val(k)), S.nx, S.ny);
    return sigma && Number.isFinite(f[0]) ? gaussian(f, S.nx, S.ny, sigma) : f;
  };
  // Ground cells under a mapped water surface (cell centre inside a BD TOPO water polygon). The ground
  // overlays (sun hours, shadows, UTCI, B3 / B4) stay transparent there, so a river reads as water
  // instead of sunny or hot ground (live review, GPT + Gemini).
  const waterMasks = new WeakMap();
  function waterMaskOf(S) {
    const feats = api.data().waterS;
    if (!feats) return null;                                  // not loaded yet: do not cache an empty mask
    let m = waterMasks.get(S);
    if (m) return m;
    m = new Uint8Array(S.nx * S.ny);
    for (const f of feats) for (const rings of f.polygons) {
      const outer = rings[0];
      if (!outer || outer.length < 3) continue;
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const p of outer) { a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1]); }
      const i0 = Math.max(0, Math.floor((a - S.x0) / S.step)), i1 = Math.min(S.nx - 1, Math.floor((c - S.x0) / S.step));
      const j0 = Math.max(0, Math.floor((b - S.y0) / S.step)), j1 = Math.min(S.ny - 1, Math.floor((d - S.y0) / S.step));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = S.x0 + (i + .5) * S.step, y = S.y0 + (j + .5) * S.step;
        if (inRing(outer, x, y) && !rings.slice(1).some(h => inRing(h, x, y))) m[j * S.nx + i] = 1;
      }
    }
    waterMasks.set(S, m);
    return m;
  }
  const rgbOf = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

  function siteOutline(pal) {
    const ctx = api.ctx();
    const pts = ctx.site.ring.map(p => P3(p[0], p[1], demAt(api.data().dem, p[0], p[1]) + 0.3));
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: pal.siteLine }));
    const grp = new THREE.Group(); grp.add(line);
    // site tint only for a small polygon site; a point+radius site is just the outline and a centre pin
    const xs = ctx.site.ring.map(p => p[0]), ys = ctx.site.ring.map(p => p[1]);
    const sideSite = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    if (sideSite < Math.min(ctx.extent[2] - ctx.extent[0], ctx.extent[3] - ctx.extent[1]) / 3) {
      const sh = new THREE.Shape(ctx.site.ring.map(p => new THREE.Vector2(p[0] - ctx.center[0], -(p[1] - ctx.center[1]))));
      const fg = new THREE.ShapeGeometry(sh);
      const pos = fg.attributes.position;
      for (let i = 0; i < pos.count; i++) { // drape every vertex on the terrain
        const x = pos.getX(i) + ctx.center[0], y = -pos.getY(i) + ctx.center[1];
        pos.setXYZ(i, pos.getX(i), demAt(api.data().dem, x, y) - baseZ() + .4, pos.getY(i));
      }
      grp.add(new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: pal.site, transparent: true, opacity: .28, side: THREE.DoubleSide, depthWrite: false })));
    } else {
      const pin = new THREE.Mesh(new THREE.SphereGeometry(Math.max(ctx.extent[2] - ctx.extent[0], ctx.extent[3] - ctx.extent[1]) * .006, 12, 12), new THREE.MeshBasicMaterial({ color: pal.siteLine }));
      pin.position.copy(P3(ctx.center[0], ctx.center[1], demAt(api.data().dem, ctx.center[0], ctx.center[1]) + 2));
      grp.add(pin);
    }
    return grp;
  }

  function lights(g, pal) {
    g.scene.add(new THREE.HemisphereLight(0xffffff, pal.dark ? 0x222233 : 0xcfcfcf, pal.dark ? .5 : .75));
    const sun = new THREE.DirectionalLight(0xffffff, pal.dark ? 1.4 : 1.15);
    sun.castShadow = true;
    const s = g.side * .75;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: g.side * 6 });
    sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0004; sun.shadow.normalBias = .4;
    g.scene.add(sun, sun.target);
    g.sun = sun;
    return sun;
  }

  // Official-data trees as cheap instanced crowns (one draw call): a low-poly ball on a trunk height.
  function treeCrowns(pal) {
    const crowns = (api.data().trees?.crowns || []).filter(c => inShape(c.p[0], c.p[1]));
    if (!crowns.length) return null;
    const geo = new THREE.IcosahedronGeometry(.5, 1);
    const mat = new THREE.MeshStandardMaterial({ color: pal.dark ? mix(pal.green, "#ffffff", .4) : mix(pal.green, pal.text, .25), roughness: 1, flatShading: true });
    const mesh = new THREE.InstancedMesh(geo, mat, crowns.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
    crowns.forEach((c, i) => {
      const d = Math.max(2, c.d), hTree = c.h || Math.max(5, d * 1.6);
      const cy = Math.max(d / 2, hTree - d / 2 * .8);
      const gz = demAt(api.data().dem, c.p[0], c.p[1]);
      pos.copy(P3(c.p[0], c.p[1], gz + cy)); sc.set(d, d * .85, d);
      mesh.setMatrixAt(i, m4.compose(pos, q, sc));
    });
    mesh.castShadow = true; mesh.receiveShadow = false;
    return mesh;
  }

  function buildBase(g, pal, opts = {}) {
    lights(g, pal);
    g.scene.add(terrain(pal), buildings(pal, opts.colourOf), siteOutline(pal));
    const wtr = water(pal);
    if (wtr) g.scene.add(wtr);
    const t = treeCrowns(pal);
    if (t) g.scene.add(t);
    return g;
  }

  // ---- A1 3D volume ---------------------------------------------------------------------------
  function tabA1() {
    const pal = api.pal();
    const g = frame3d(true);
    buildBase(g, pal);
    const dir = new THREE.Vector3(.5, 1, .6).normalize();
    g.sun.position.copy(dir.multiplyScalar(g.side * 2)); g.sun.intensity = .8;
    badge("건물 " + api.data().buildings.length + "동 · 높이 미상 건물은 3 m 기본값(연한 색상)으로 표시됩니다.");
    controls.innerHTML = saveGroup(`<button type="button" data-a1="png">PNG</button><button type="button" data-a1="3dm">3dm</button>`);
    controls.onclick = e => {
      if (e.target.dataset.a1 === "png") savePng();
      else if (e.target.dataset.a1 === "3dm") {   // extruded buildings + terrain mesh (3D_건물 / 3D_지형) with the site outline
        api.exportTab("3dm", { def: { num: "A1", ko: "3D 볼륨", en: "3d-volume" }, sheet: { layers: [], legend: [], notes: ["3D 볼륨: 건물 압출 메시 + 지형 메시. 높이 미상 건물은 3 m."], sources: ["RGE ALTI"] }, volumes: true, name: "a1_volume" }, e.target);
      }
    };
    note.textContent = "BD TOPO 건물 높이 및 IGN 표고(RGE ALTI) 기반 3D 매스 모델입니다. " + (PHONE() ? "한 손가락으로 회전, 두 손가락으로 확대/축소할 수 있습니다. " : "마우스 드래그로 회전·확대할 수 있습니다. ") + SIM;
  }

  function badge(t) { const b = document.createElement("div"); b.className = "dg-badge"; b.textContent = t; stage.append(b); }

  function savePng() {
    if (!gl) return;
    gl.renderer.render(gl.scene, gl.camera);
    gl.renderer.domElement.toBlob(b => api.download(b, `analysis_${active.toLowerCase()}.png`), "image/png");
  }

  // ---- A2 sun & shadows ---------------------------------------------------------------------------
  const dateOf = id => {
    if (id === "today") { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate(), label: "오늘" }; }
    const k = KEYS.find(x => x.id === id); return { y: 2026, m: k.m, d: k.d, label: k.label };
  };
  const sunBySurface = new WeakMap();   // Surface -> Map(date -> result): never shared between sites

  function tabA2() {
    const pal = api.pal(), ctx = api.ctx(), data = api.data();
    const g = frame3d(true);
    buildBase(g, pal);
    // less fill light than in A1, so cast shadows stand out and their change over the day is easy to see
    g.scene.traverse(o => { if (o.isHemisphereLight) o.intensity *= .62; });
    // dome radius > half diagonal of the sheet (0.707 x side), so the sun paths never cut through the
    // model, and the camera is fitted to model + dome so the paths are not cropped by the stage
    const R = g.side * .75;
    {
      const box = new THREE.Box3().setFromObject(g.scene);
      // model plus a moderate margin: fitting the whole dome made the model too small to read the shadows
      // (live review, GPT + Gemini); the low ends of the paths may leave the frame, orbit / zoom shows them
      const F = g.side * .5;
      box.expandByPoint(new THREE.Vector3(-F, 0, -F)).expandByPoint(new THREE.Vector3(F, g.side * .4, F));
      g.fit = makeFit(g, box);
      g.fit();
    }
    const sunMarker = new THREE.Mesh(new THREE.SphereGeometry(g.side * .018, 16, 16), new THREE.MeshBasicMaterial({ color: CLIMATE.sun.summer }));
    const pathGroup = new THREE.Group(), overlayGroup = new THREE.Group();
    g.scene.add(sunMarker, pathGroup, overlayGroup);

    const conv = CONV();   // the model is drawn on the Lambert grid: rotate true azimuths onto it
    const dirOf = s => new THREE.Vector3(Math.sin(s.az + conv) * Math.cos(s.alt), Math.sin(s.alt), -Math.cos(s.az + conv) * Math.cos(s.alt));
    // direct-sun hours on the grid; sunHours() has no convergence parameter, so when grid north differs
    // from true north the same 30-minute samples are re-evaluated with shadowMask (as the B3 plate does)
    const sunHoursGrid = (S, d) => {
      const res = sunHours(S, ctx.lat, ctx.lon, d.y, d.m, d.d, 30);
      if (Math.abs(conv) < 1e-6) return res;
      res.hours.fill(0);
      for (let h = 0; h < 24; h += .5) {
        const p = sunPosition(parisDate(d.y, d.m, d.d, h), ctx.lat, ctx.lon);
        if (p.alt <= 2 * RAD) continue;
        const mask = shadowMask(S, p.az + conv, p.alt);
        for (let k = 0; k < res.hours.length; k++) if (mask[k] === 0) res.hours[k] += .5;
      }
      for (let k = 0; k < res.hours.length; k++) if (S.bld[k]) res.hours[k] = NaN;
      return res;
    };

    function drawPaths() {
      disposeGroup(pathGroup);
      const cur = dateOf(state.date);
      const days = [...KEYS.map(k => ({ y: 2026, m: k.m, d: k.d, id: k.id })), ...(state.date === "today" ? [{ ...cur, id: "today" }] : [])];
      for (const day of days) {
        const pts = [];
        for (let h = 0; h < 24; h += .25) {
          const s = sunPosition(parisDate(day.y, day.m, day.d, h), ctx.lat, ctx.lon);
          if (s.alt > 0) pts.push(dirOf(s).multiplyScalar(R));
        }
        if (pts.length < 2) continue;
        const on = day.id === state.date;
        // climate colours: summer solstice #D55E00 solid, equinox #E69F00 long dash, winter solstice #0072B2 short dash, today = ink
        const dc = { summer: [CLIMATE.sun.summer, 0, 0], equinox: [CLIMATE.sun.equinox, 6, 3], autumn: [CLIMATE.sun.equinox, 6, 3], winter: [CLIMATE.sun.winter, 3, 3], today: [CLIMATE.ink, 0, 0] }[day.id] || [CLIMATE.ink, 0, 0];
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = dc[1] ? new THREE.LineDashedMaterial({ color: dc[0], dashSize: g.side * dc[1] * .006, gapSize: g.side * dc[2] * .006, transparent: true, opacity: on ? 1 : .6 })
          : new THREE.LineBasicMaterial({ color: dc[0], transparent: true, opacity: on ? 1 : .6 });
        const line = new THREE.Line(geo, mat);
        if (dc[1]) line.computeLineDistances();
        pathGroup.add(line);
        if (on) for (let h = 6; h <= 20; h++) {
          const s = sunPosition(parisDate(day.y, day.m, day.d, h), ctx.lat, ctx.lon);
          if (s.alt > 0) { const m = new THREE.Mesh(new THREE.SphereGeometry(g.side * .007, 8, 8), new THREE.MeshBasicMaterial({ color: dc[0] })); m.position.copy(dirOf(s).multiplyScalar(R)); pathGroup.add(m); }
        }
      }
    }

    function setSun() {
      const d = dateOf(state.date);
      const s = sunPosition(parisDate(d.y, d.m, d.d, state.hour), ctx.lat, ctx.lon);
      const up = s.alt > 0;
      const v = dirOf(s);
      g.sun.position.copy(v.clone().multiplyScalar(g.side * 2.5));
      g.sun.intensity = up ? (pal.dark ? 1.9 : 1.55) * Math.min(1, s.alt / (12 * RAD) + .25) : 0;
      sunMarker.visible = up; sunMarker.position.copy(v.clone().multiplyScalar(R));
      $("a2-info").textContent = up
        ? `${d.label} ${fmtHour(state.hour)} · 고도 ${(s.alt / RAD).toFixed(1)}° · 방위 ${(s.az / RAD).toFixed(0)}°`
        : `${d.label} ${fmtHour(state.hour)} · 일몰 후 (지평선 아래)`;
    }

    // ground overlays: sun-hours map or 09/12/15 shadow overlap
    // Ground overlays are canvas textures on the sampling grid, draped over the terrain mesh
    // (courtyards and terrain relief are handled by the raster).
    function drawOverlay() {
      overlayGroup.children.forEach(m => { m.material.map?.dispose(); m.geometry.dispose(); m.material.dispose(); });
      overlayGroup.clear();
      $("a2-legend").innerHTML = "";
      if (state.overlay === "none") return;
      const d = dateOf(state.date);
      const S = surfaceOf(ctx, data);
      if (state.overlay === "hours") {
        const key = `${d.y}-${d.m}-${d.d}`;
        let perSurface = sunBySurface.get(S);
        if (!perSurface) { perSurface = new Map(); sunBySurface.set(S, perSurface); }
        let res = perSurface.get(key);
        if (!res) { res = sunHoursGrid(S, d); perSurface.set(key, res); }
        // absolute direct-sun hours: 0-2 / 2-4 / 4-6 / 6-8 / 8+ h. Climate colours reversed so that
        // little sun is dark and much sun is bright, the same reading as the B3 plate.
        const hourCols = [...CLIMATE.sun.hours].reverse();
        const cols = hourCols.map(rgbOf);
        const hf = groundField(S, k => res.hours[k], .8);
        const tex = fieldTexture(S, k => hf[k], h => cols[h < 2 ? 0 : h < 4 ? 1 : h < 6 ? 2 : h < 8 ? 3 : 4], 6, waterMaskOf(S));
        overlayGroup.add(draped(tex, S, .25));
        $("a2-overlay-note").textContent = `일조 분석도(${d.label}): 가조시간 ${res.daylight.toFixed(1)}시간 중 직사일조 시간 (5단계 구분, 건물 안 제외).`;
        $("a2-legend").innerHTML = ["0–2", "2–4", "4–6", "6–8", "8 이상"].map((t, i) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px"><i style="width:12px;height:12px;background:${hourCols[i]};border:1px solid ${i < 4 ? "transparent" : CLIMATE.sun.hoursEdge || CLIMATE.ink};display:inline-block"></i>${t} h</span>`).join("");
      } else {
        // shadows at 09 / 12 / 15 h: one ray-cast mask per hour, drawn as three stacked translucent textures
        [9, 12, 15].forEach((hr, idx) => {
          const s = sunPosition(parisDate(d.y, d.m, d.d, hr), ctx.lat, ctx.lon);
          if (s.alt <= 1 * RAD) return;
          const mask = shadowMask(S, s.az + conv, s.alt);
          const c = rgbOf([CLIMATE.sun.h9, CLIMATE.sun.h12, CLIMATE.sun.h15][idx]);
          const mf = groundField(S, k => S.bld[k] ? NaN : (mask[k] === 1 ? 1 : 0));
          const tex = fieldTexture(S, k => mf[k], m => m >= .5 ? [c[0], c[1], c[2], 150] : null, 6, waterMaskOf(S));
          const m = draped(tex, S, .25 + idx * .05);
          m.renderOrder = 3 + idx;
          overlayGroup.add(m);
        });
        $("a2-overlay-note").textContent = "시간대별 음영 분석: 09시(청록)·12시(남색)·15시(보라) 지표면 그림자 중첩 (레이트레이싱 연산, 높이 미상 건물은 3 m 기준).";
        $("a2-legend").innerHTML = [["09시", CLIMATE.sun.h9], ["12시", CLIMATE.sun.h12], ["15시", CLIMATE.sun.h15]].map(([t, c]) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px"><i style="width:12px;height:12px;background:${c};opacity:.6;display:inline-block"></i>${t}</span>`).join("");
      }
    }

    controls.innerHTML = `${viewToggle("A2")}
      <span id="a2-dates">${[...KEYS,{ id: "today", label: "오늘" }].map(k => `<button type="button" data-date="${k.id}" aria-pressed="${state.date === k.id}">${k.label}</button>`).join("")}</span>
      <label>시각 <input id="a2-hour" type="range" min="0" max="23.75" step="0.25" value="${state.hour}"> <output id="a2-hour-out">${fmtHour(state.hour)}</output></label>
      <span id="a2-overlays">${[["none", "음영 단일"], ["hours", "일조 분석"], ["shadows", "시간대별 음영 (9·12·15시)"]].map(([v, t]) => `<button type="button" data-ov="${v}" aria-pressed="${state.overlay === v}">${t}</button>`).join("")}</span>
      <button type="button" data-a2="play">▶ 시뮬레이션 재생</button>
      ${saveGroup(`<button type="button" data-a2="png">PNG</button>`)}
      <span id="a2-info" class="note"></span> <span id="a2-overlay-note" class="note"></span> <div id="a2-legend" class="note"></div>`;
    stageLegend("a2-overlay-note", "a2-legend");
    let playing = null;
    g.stopPlay =() => { if (playing) { clearInterval(playing); playing = null; } };
    controls.onclick = e => {
      const t = e.target;
      if (t.dataset.date) { state.date = t.dataset.date; controls.querySelectorAll("[data-date]").forEach(b => b.setAttribute("aria-pressed", String(b === t))); drawPaths(); setSun(); drawOverlay(); }
      else if (t.dataset.ov) { state.overlay = t.dataset.ov; controls.querySelectorAll("[data-ov]").forEach(b => b.setAttribute("aria-pressed", String(b === t))); drawOverlay(); if (state.overlay === "none") $("a2-overlay-note").textContent = ""; }
      else if (t.dataset.a2 === "png") savePng();
      else if (t.dataset.a2 === "play") {
        if (playing) { clearInterval(playing); playing = null; t.textContent = "▶ 시뮬레이션 재생"; return; }
        t.textContent = "■ 정지";
        playing = setInterval(() => { state.hour = state.hour >= 23.75 ? 0 : state.hour + .25; $("a2-hour").value = state.hour; $("a2-hour-out").textContent = fmtHour(state.hour); setSun(); }, 120);
      }
    };
    $("a2-hour").addEventListener("input", e => { state.hour = Number(e.target.value); $("a2-hour-out").textContent = fmtHour(state.hour); setSun(); });
    drawPaths(); setSun(); drawOverlay();
    const off = parisOffset(new Date(Date.UTC(dateOf(state.date).y, dateOf(state.date).m - 1, dateOf(state.date).d, 12)));
    note.textContent = `태양 궤적: Meeus/SunCalc 알고리즘 계산 (Europe/Paris 현지시 UTC${off >= 0 ? "+" : ""}${off}). 음영: three.js 섀도우 맵. 궤적 색: 하지 주황 실선 · 춘·추분 황색 긴 파선 · 동지 청색 짧은 파선(선택일은 점 표시). ${SIM}`;
  }
  const fmtHour = h => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

  // ---- A3 wind --------------------------------------------------------------------------------------
  const PERIODS = ["연간", "겨울", "봄", "여름", "가을"];
  const WIND_DIRECTIONS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  let windView = "rose";

  function groundWindRose(ctx, cells, total, calm, maxPct) {
    const [x0, y0, x1, y1] = ctx.extent, w = x1 - x0, h = y1 - y0;
    const side = Math.max(w, h), R = Math.min(w, h) * .37;
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(w / side * 1536));
    cv.height = Math.max(1, Math.round(h / side * 1536));
    const c = cv.getContext("2d");
    c.setTransform(cv.width / w, 0, 0, cv.height / h, cv.width / 2, cv.height / 2);
    const calmShare = 100 * calm / Math.max(1, total) / cells.length;
    const scale = R / (maxPct + calmShare);
    const zero = calmShare * scale;
    c.strokeStyle = "#526B79";
    c.lineWidth = side * .0016;
    c.setLineDash([side * .004, side * .004]);
    for (let pct = 5; pct <= maxPct; pct += 5) {
      c.beginPath(); c.arc(0, 0, zero + pct * scale, 0, Math.PI * 2); c.stroke();
    }
    c.setLineDash([]);
    if (zero > 0) {
      c.beginPath(); c.arc(0, 0, zero, 0, Math.PI * 2);
      c.fillStyle = CLIMATE.wind.calm; c.fill();
    }
    cells.forEach((bin, dir) => {
      const a = (dir * 22.5 + (ctx.convergence || 0) - 90) * RAD;
      let inner = zero;
      [bin[1], bin[2], bin[3], bin[4], bin[5] + bin[6]].forEach((n, i) => {
        if (!n || !total) return;
        const outer = inner + 100 * n / total * scale;
        c.beginPath();
        c.arc(0, 0, outer, a - 8 * RAD, a + 8 * RAD);
        if (inner > 0) c.arc(0, 0, inner, a + 8 * RAD, a - 8 * RAD, true);
        else c.lineTo(0, 0);
        c.closePath();
        c.fillStyle = CLIMATE.wind.bins[i]; c.fill();
        inner = outer;
      });
    });
    // compass letters on white discs: the rose is drawn over the buildings, where bare dark letters vanished
    c.font = `bold ${side * .03}px sans-serif`;
    c.textAlign = "center"; c.textBaseline = "middle";
    for (const [label, d] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
      const a = (d + (ctx.convergence || 0) - 90) * RAD, r = R + side * .04;
      const lx = r * Math.cos(a), ly = r * Math.sin(a);
      c.beginPath(); c.arc(lx, ly, side * .026, 0, Math.PI * 2);
      c.fillStyle = "#FFFFFF"; c.fill();
      c.lineWidth = side * .0016; c.strokeStyle = "#526B79"; c.stroke();
      c.fillStyle = "#1E293B";
      c.fillText(label, lx, ly + side * .002);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = draped(tex, { nx: 1, ny: 1, step: 1, x0, y0, width: w, height: h }, 0);
    // owner: the rose on the ground was hidden by the buildings — render it on top of everything
    mesh.traverse(o => {
      o.renderOrder = 999;
      if (o.material) { o.material.depthTest = false; o.material.depthWrite = false; o.material.transparent = true; o.material.opacity = .92; }
    });
    return mesh;
  }

  function tabA3() {
    const pal = api.pal(), ctx = api.ctx();
    const climate = api.data().climate;
    if (!climate) return missing(api.status("climate") === "loading" ? "기후(EPW) 데이터를 불러오는 중…" : "기후(EPW) 데이터를 불러오지 못했습니다.");
    const { station: st, km } = nearestStation(climate, ctx.lat, ctx.lon);
    const g = frame3d(false);
    g.scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 1.0));
    const dl = new THREE.DirectionalLight(0xffffff, .7); dl.position.set(1, 2, 1); g.scene.add(dl);
    g.scene.add(terrain(pal), buildings(pal), siteOutline(pal));
    { const wtr = water(pal); if (wtr) g.scene.add(wtr); }
    const winds = new THREE.Group(); g.scene.add(winds);
    const [cx, cy] = ctx.center;
    const [x0, y0, x1, y1] = ctx.extent;
    const side = Math.min(x1 - x0, y1 - y0);
    const ground = (x, y) => demAt(api.data().dem, x, y);
    const draw = () => {
      disposeGroup(winds);
      const p = state.season, cells = st.rose[p], total = st.total[p];
      const top = cells.map((c, dir) => ({ dir, count: c.slice(1).reduce((a, b) => a + b, 0) }))
        .filter(item => item.count > 0).sort((a, b) => b.count - a.count).slice(0, 2);
      if (windView === "rose") {
        const maxPct = 5 * Math.max(1, Math.ceil(Math.max(...st.rose.flatMap((period, i) => period.map(bin =>
          100 * bin.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, st.total[i])))) / 5));
        winds.add(groundWindRose(ctx, cells, total, st.calm[p], maxPct));
      } else top.forEach(({ dir }, rank) => {
        const az = (dir * 22.5 + (ctx.convergence || 0)) * RAD;
        const dx = Math.sin(az), dy = Math.cos(az);
        const edge = ctx.shape?.kind === "circle" ? side / 2
          : Math.min((x1 - x0) / (2 * Math.abs(dx)), (y1 - y0) / (2 * Math.abs(dy)));
        const x = cx + dx * edge, y = cy + dy * edge;
        const z = ground(x, y) + Math.max(1, side * .012);
        const length = side * (rank ? .13 : .19), gap = side * .025;
        const start = P3(x + dx * (length + gap), y + dy * (length + gap), z);
        const end = P3(x + dx * gap, y + dy * gap, z);
        const heading = end.clone().sub(start).normalize();
        const colour = rank ? CLIMATE.wind.arrow2 : CLIMATE.wind.arrow1;
        const radius = side * (rank ? .0028 : .004);
        const head = side * (rank ? .035 : .047);
        const material = new THREE.MeshBasicMaterial({ color: colour });
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length - head, 12), material);
        shaft.position.copy(start).addScaledVector(heading, (length - head) / 2);
        const tip = new THREE.Mesh(new THREE.ConeGeometry(radius * 2.8, head, 16), material);
        tip.position.copy(end).addScaledVector(heading, -head / 2);
        for (const part of [shaft, tip]) part.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), heading);
        winds.add(shaft, tip);
      });
      // in the arrow view each rank carries the colour of its arrow (live review, Gemini)
      const chip = i => windView === "arrows" ? `<i style="display:inline-block;width:18px;height:6px;border-radius:3px;vertical-align:middle;margin-right:4px;background:${i ? CLIMATE.wind.arrow2 : CLIMATE.wind.arrow1}"></i>` : "";
      $("a3-directions").innerHTML = [
        ...top.map(({ dir, count }, i) => `${chip(i)}${i + 1}순위 ${WIND_DIRECTIONS[dir]} ${(100 * count / total).toFixed(1)}%`),
        `정온 ${(100 * st.calm[p] / Math.max(1, total)).toFixed(1)}%`
      ].join(" · ");
    };
    controls.innerHTML = viewToggle("A3") + `<button type="button" data-wind="rose" aria-pressed="${windView === "rose"}">지면 바람장미</button><button type="button" data-wind="arrows" aria-pressed="${windView === "arrows"}">주풍향</button>` +
      PERIODS.map((t, i) => `<button type="button" data-s="${i}" aria-pressed="${state.season === i}">${t}</button>`).join("") +
      `${saveGroup(`<button type="button" data-a3="png">PNG</button>`)}<span id="a3-directions" class="note"></span><div id="a3-speeds" class="note"${windView === "rose" ? "" : " hidden"}>${CLIMATE.wind.bins.map((c, i) =>
        `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px"><i style="width:12px;height:12px;background:${c};display:inline-block"></i>${SPEED_LABELS[i]} m/s</span>`).join("")} · 동심원 간격 5% · 중앙 원은 정온(&lt; 0.5 m/s)</div>`;
    stageLegend("a3-speeds");
    controls.onclick = e => {
      if (e.target.dataset.s) { state.season = Number(e.target.dataset.s); controls.querySelectorAll("[data-s]").forEach(b => b.setAttribute("aria-pressed", String(b === e.target))); draw(); }
      else if (e.target.dataset.wind) {
        windView = e.target.dataset.wind;
        controls.querySelectorAll("[data-wind]").forEach(b => b.setAttribute("aria-pressed", String(b === e.target)));
        $("a3-speeds").hidden = windView !== "rose";
        draw();
      } else if (e.target.dataset.a3) savePng();
    };
    draw();
    badge(`${st.name} · ${km.toFixed(0)} km`);
    note.textContent = `${st.name} 관측소(EPW TMYx 2011–2025) 기준. 바람장미 꽃잎은 바람이 불어오는 방향, 화살표는 대지로 들어오는 주풍향을 나타냅니다. 건물 사이 기류는 별도 유동 해석이 필요합니다. ${SIM}`;
  }

  // ---- A4 thermal comfort ---------------------------------------------------------------------------------
  function tabA4() {
    const pal = api.pal(), ctx = api.ctx(), data = api.data();
    const climate = data.climate;
    if (!climate) return missing(api.status("climate") === "loading" ? "기후(EPW) 데이터를 불러오는 중…" : "기후(EPW) 데이터를 불러오지 못했습니다.");
    const { station: st, km: stKm } = nearestStation(climate, ctx.lat, ctx.lon);
    const g = frame3d(false);
    g.scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 1.0));
    g.scene.add(terrain(pal), buildings(pal), siteOutline(pal));
    { const wtr = water(pal); if (wtr) g.scene.add(wtr); }
    g.fit = makeFit(g, new THREE.Box3().setFromObject(g.scene));
    g.fit();
    const ov = new THREE.Group(); g.scene.add(ov);
    function draw() {
      ov.children.forEach(m => { m.material.map?.dispose(); m.geometry.dispose(); m.material.dispose(); });
      ov.clear();
      const S = surfaceOf(ctx, data);
      // UTCI (Brode 2012 polynomial, dgutci.js): shade -> MRT = air temperature; sun -> MRT + SolarCal delta (clear-sky assumption)
      const e = utciEnv({ ctx, data }, state.month, state.utciHour);
      const mask = e.up ? shadowMask(S, e.sp.az + CONV(), e.sp.alt) : null;   // true azimuth -> grid azimuth
      const catSun = utciCat(e.sun), catShade = utciCat(e.shade);
      const cSun = rgbOf(UTCI_CATS[catSun].hex), cShade = rgbOf(UTCI_CATS[catShade].hex);
      const counts = new Array(10).fill(0); let tot = 0, sunny = 0;
      for (let k = 0; k < S.nx * S.ny; k++) {
        if (S.bld[k]) continue;
        const lit = e.up && mask[k] === 0;
        counts[lit ? catSun : catShade]++; tot++; if (lit) sunny++;
      }
      const field = extendGround(Float32Array.from(S.bld, (b, k) => b ? NaN : Number(e.up && mask[k] === 0)), S.nx, S.ny);
      // Interpolate colour only in a narrow band at the grid boundary.
      const tex = fieldTexture(S, k => field[k], litF => {
        const t = Math.max(0, Math.min(1, (litF - .38) / .24));
        return cShade.map((shade, i) => shade + (cSun[i] - shade) * t);
      }, 6, waterMaskOf(S));
      ov.add(draped(tex, S, .12));
      $("a4-info").textContent = `${utciInfoText(e)} · 양지 ${(sunny / Math.max(1, tot) * 100).toFixed(0)} %`;
      const legend = $("a4-legend");
      legend.style.cssText =
        "display:flex;flex-wrap:wrap;gap:4px;text-align:left;white-space:normal;width:100%;max-width:100%;min-width:0";
      const rows = [["양지", e.sun, catSun, sunny],
                    ["그늘", e.shade, catShade, tot - sunny]];
      legend.innerHTML = rows.map(([label, value, cat, count]) =>
        `<div style="flex-basis:100%"><i style="display:inline-block;width:12px;height:12px;background:${UTCI_CATS[cat].hex}"></i> ${label} ${value.toFixed(1)} °C · ${UTCI_CATS[cat].ko} · ${(100 * count / Math.max(1, tot)).toFixed(0)}%</div>`
      ).join("") +
        (catSun === catShade ? "<div>양지와 그늘이 같은 구간입니다</div>" : "") +
        // true temperature axis (-50 .. 56 °C): each class is as wide as its UTCI range and the two
        // markers sit at the actual values (the former 10 equal cells read as a linear -40..46 scale)
        `<div style="flex-basis:100%;min-width:0"><div style="width:100%;max-width:520px">
        <div style="display:flex;height:8px">${UTCI_CATS.map((c, i) =>
          `<i style="flex:${utciBounds[i + 1] - utciBounds[i]};background:${c.hex}"></i>`).join("")}</div>
        ${rows.map(([label, value]) =>
          `<div style="position:relative;height:13px;font-size:10px"><span style="position:absolute;left:${utciPos(value)}%;transform:translateX(-50%);white-space:nowrap">▲ ${label}</span></div>`).join("")}
        <div style="position:relative;height:13px;font-size:9px">${[-40, -13, 0, 9, 26, 32, 38, 46].map(v =>
          `<span style="position:absolute;left:${utciPos(v)}%;transform:translateX(-50%)">${v}</span>`).join("")}<span style="position:absolute;right:0">°C</span></div>
        </div></div><div>${KO_PLATE["plate.utci.src"]}</div>`;
    }
    controls.innerHTML = `${viewToggle("A4")}<label>월 <select id="a4-month">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}"${state.month === i + 1 ? " selected" : ""}>${i + 1}월</option>`).join("")}</select></label>
      <label>시각 <input id="a4-hour" type="range" min="0" max="23" step="1" value="${state.utciHour}"> <output id="a4-hour-out">${state.utciHour}:00</output></label>
      ${saveGroup(`<button type="button" data-a4="png">PNG</button>`)}<span id="a4-info" class="note"></span><div id="a4-legend" class="note"></div>`;
    $("a4-month").addEventListener("change", e => { state.month = Number(e.target.value); draw(); });
    $("a4-hour").addEventListener("input", e => { state.utciHour = Number(e.target.value); $("a4-hour-out").textContent = `${state.utciHour}:00`; draw(); });
    controls.onclick = e => { if (e.target.dataset.a4) savePng(); };
    stageLegend("a4-legend");
    draw();
    badge("체감 열쾌적성 지표 (UTCI)");
    note.textContent = utciNote(st, stKm);
  }
  const utciBounds = [-50, ...UTCI_CATS.slice(0, 9).map(c => c.max), 56];
  const utciPos = v => (Math.max(-50, Math.min(56, v)) + 50) / 106 * 100;
  const utciNote = (st, stKm) => (stKm > 60 ? `⚠ 기상 관측소 이격 거리 약 ${stKm.toFixed(0)} km (원거리 관측 데이터). ` : "") + `${KO_PLATE["plate.utci.note"]}. 기상: EPW(${st.name}). ${SIM}`;

  // ---- climate plates (A2 / A3 / A4 "다이어그램" view): vector SVG axonometric, see dgclimplate.js ------------------------------
  let shadowDay = SHADOW_DAYS[0].id, shadowHour = 12;
  const lbOptions = {};
  // option fields of a B-plate definition (shared by the plate view and the 3D view)
  const lbFields = (def, opts) => def.controls.map(c => {
    const label = esc(c.label ?? c.ko ?? c.key);
    const key = esc(c.key);
    const field = c.type === "select"
      ? `<select data-lb="${key}">${c.options.map(o =>
        `<option value="${esc(o.value)}"${String(opts[c.key]) === String(o.value) ? " selected" : ""}>${esc(o.label ?? o.ko ?? o.value)}</option>`
      ).join("")}</select>`
      : `<input data-lb="${key}" type="${esc(c.type)}"
        ${c.type === "checkbox" ? (opts[c.key] ? "checked" : "") : `value="${esc(opts[c.key])}"`}
        ${["min", "max", "step"].filter(k => c[k] != null).map(k => `${k}="${esc(c[k])}"`).join(" ")}>`;
    return `<label data-lb-label="${key}">${label} ${field}</label>`;
  }).join("");
  const bindLb = (def, opts, draw) => controls.querySelectorAll("[data-lb]").forEach(el => {
    el.addEventListener(el.type === "range" ? "input" : "change", () => {
      if (!el.reportValidity()) return;
      const c = def.controls.find(c => c.key === el.dataset.lb);
      opts[c.key] = c.type === "checkbox" ? el.checked
        : c.type === "select"
          ? c.options.find(o => String(o.value) === el.value).value
          : Number(el.value);
      draw();
    });
  });

  // ---- B3 / B4 in 3D: the plate's own grid result draped over the terrain of the 3D model ----------------
  // Colour stops are those of SUN / COMFORT in dglb_sun.js (keep in sync); the values come from the same
  // buildLbPlate() call as the plate, so both views always show identical numbers.
  const LB3D = {
    B1: { render: (r, ov) => renderB1(r, ov) },
    B2: { render: (r, ov, env) => renderB2(r, ov, env) },
    B3: { stops: ["#101B42", "#673A91", "#E87935", "#FFF3AE"], t: v => v / 8, max: 8, ticks: [[0, "0"], [2, "2"], [4, "4"], [6, "6"], [8, "≥8"]], unit: "h/day",
      title: s => s.shade ? "그늘 시간" : "직달 일조 시간", info: s => `${s.month}월 ${s.day}일 · 주간 ${s.daylight.toFixed(1)} h/day` },
    B4: { stops: ["#C83E3A", "#F5CE62", "#258F89"], t: v => (v - 20) / 60, max: 100, ticks: [[0, "0"], [20, "20"], [50, "50"], [80, "80"], [100, "100"]], unit: "%",
      title: () => "주간 쾌적 비율", info: s => `${s.month}월 대표일 · UTCI 9–26 °C · 주간 ${s.daylight} h/day` }
  };
  // dglb_wind.js (B1 / B2) reads GeoJSON-like roads, vegetation and water, but the app's WFS features are
  // { props, polygons, lines }. Without this adapter B1 found no aligned streets and B2 excluded neither
  // roads nor water from the cold-air sources.
  const lbData = (kind, data) => !WIND_KINDS.some(d => d.kind === kind) ? data : {
    ...data,
    roads: (data.roads || []).map(f => ({ type: "MultiLineString", coordinates: f.lines, width: Number(f.props?.largeur_de_chaussee) || undefined })),
    vegetation: (data.veg || []).map(f => ({ type: "MultiPolygon", coordinates: f.polygons })),
    water: (data.waterS || []).map(f => ({ type: "MultiPolygon", coordinates: f.polygons }))
  };
  // flat ribbons / arrow heads following the terrain, collected into one mesh per style
  const ribbonSet = () => ({ pos: [], idx: [] });
  const zAt = (x, y, lift) => demAt(api.data().dem, x, y) + lift;
  function addRibbon(set, pts, width, lift) {
    if (pts.length < 2) return;
    const base = set.pos.length / 3;
    pts.forEach((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l * width / 2, ny = dx / l * width / 2;
      for (const s of [1, -1]) { const v = P3(p[0] + nx * s, p[1] + ny * s, zAt(p[0], p[1], lift)); set.pos.push(v.x, v.y, v.z); }
      if (i) { const k = base + i * 2; set.idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    });
  }
  function addArrow(set, a, b, size, lift) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
    if (l < .01) return;
    const ux = dx / l, uy = dy / l, base = set.pos.length / 3;
    for (const [x, y] of [[b[0] + ux * size * .5, b[1] + uy * size * .5],
      [b[0] - ux * size * .5 - uy * size * .45, b[1] - uy * size * .5 + ux * size * .45],
      [b[0] - ux * size * .5 + uy * size * .45, b[1] - uy * size * .5 - ux * size * .45]]) {
      const v = P3(x, y, zAt(b[0], b[1], lift)); set.pos.push(v.x, v.y, v.z);
    }
    set.idx.push(base, base + 1, base + 2);
  }
  function ribbonMesh(set, color, opacity, onTop, order = 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(set.pos, 3));
    geo.setIndex(set.idx);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, depthTest: !onTop }));
    m.renderOrder = (onTop ? 990 : 5) + order;
    return m;
  }
  const swatch = (c, t, op = 1) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px"><i style="width:12px;height:12px;background:${c};opacity:${op};display:inline-block"></i>${t}</span>`;
  // teal / yellow / brown / lilac as in dglb_wind.js; `flow` is a darker teal used only in 3D so corridor
  // and flow lines stay readable on the teal λf ground and against the grey building mass
  const WIND3D = { teal: "#168F89", yellow: "#E8CB68", brown: "#946044", lilac: "#B69BCB", flow: "#0B4F4C" };
  // B1: frontal-area classes on the ground + corridor candidates (drawn over the buildings, like the
  // ground wind rose) + streets aligned with the two main wind directions.
  function renderB1(r, ov) {
    const s = r.stats, G = s.grid, ext = api.ctx().extent;
    // same colours as the plate: neutral-to-warm resistance classes, blue corridors only
    const cls = [WIND_B1.low, WIND_B1.mid, WIND_B1.high].map(rgbOf);
    // the 5 m resampled field of the plate, not the 25 m cells (square steps around every block)
    const F = s.fine;
    ov.add(draped(gridTexture(F, k => [...cls[F.values[k] < .15 ? 0 : F.values[k] <= .4 ? 1 : 2], 205]), F, .25));
    const lambdaAt = (x, y) => { const i = Math.floor((x - G.x0) / G.step), j = Math.floor((y - G.y0) / G.step); return i < 0 || j < 0 || i >= G.nx || j >= G.ny ? 1 : s.lambda[j * G.nx + i]; };
    // Corridors are drawn at pedestrian height (1.5 m, owner decision 2026-11-16: the wind people feel).
    // The plate note still says this is not a pedestrian-level wind speed.
    const WIND_Z = 1.5;
    const streets = ribbonSet(), paths = ribbonSet(), casing = ribbonSet(), tips = ribbonSet(), tipCasing = ribbonSet(), heads = [];
    const inExt = p => p[0] >= ext[0] && p[0] <= ext[2] && p[1] >= ext[1] && p[1] <= ext[3] && inShape(p[0], p[1]);   // also inside a circular site
    for (const f of api.data().roads || []) for (const line of f.lines) for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
      if (!l || !inExt(a) || !inExt(b) || lambdaAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) > .4) continue;
      if (s.directions.some(t => Math.abs((dx * t.ux + dy * t.uy) / l) >= Math.cos(30 * RAD))) addRibbon(streets, [a, b], 2.5, .6);
    }
    s.directions.forEach((t, rank) => {
      for (const path of t.paths) {
        const main = path.primary && !rank;                       // 1st corridor of the prevailing wind
        const w = main ? 9 : 4.5, a = main ? 34 : 22;
        const line = smoothPath(path.points, 3);
        // only the stretches inside the site (a circular site cuts the 25 m grid paths at its edge)
        let run = [], last = null;
        const runs = [];
        const flush = () => { if (run.length > 1) { runs.push(run); last = run; } run = []; };
        for (const pt of line) { if (inExt(pt)) run.push(pt); else flush(); }
        flush();
        // the line stops at its arrow head (it used to run on past the head to the edge)
        const cut = last ? last.length - 1 - Math.ceil((a / 2 + 4) / 8) : -1;
        runs.forEach(r => { const pts = r === last && cut >= 3 ? r.slice(0, cut + 1) : r; addRibbon(casing, pts, w + 3, WIND_Z - .2); addRibbon(paths, pts, w, WIND_Z); });
        // the head sits at the downwind end of the last visible stretch, just inside the site edge
        const i = !last ? -1 : last.length - 1 - Math.ceil((a / 2 + 4) / 8);   // every head at the end of its line, wholly inside the site edge (owner, 2026-11-16)
        if (i < 3) continue;
        // candidates share trunks and run side by side: one arrow head per ~90 m, not one per path
        const tip = last[i];
        if (heads.some(h => Math.hypot(h[0] - tip[0], h[1] - tip[1]) < 45)) continue;
        heads.push(tip);
        addArrow(tips, last[i - 3], tip, a, WIND_Z + .4);
      }
    });
    if (streets.idx.length) ov.add(ribbonMesh(streets, WIND_B1.street, 1, false));
    // depth-tested: where a 25 m-grid path crosses a building it disappears behind it, exactly as the
    // plate draws building figures over the corridors (it used to run across the roofs)
    if (casing.idx.length) ov.add(ribbonMesh(casing, "#FFFFFF", .85, false, 0));
    if (paths.idx.length) ov.add(ribbonMesh(paths, WIND_B1.corridor, .95, false, 1));
    // heads in their own layers above every ribbon: where candidates run side by side or cross, a head used
    // to merge into the neighbouring ribbon of the same colour and disappear
    if (tips.idx.length) ov.add(ribbonMesh(tips, WIND_B1.corridor, 1, false, 3));
    return {
      info: s.directions.map(t => `유입 ${t.from} · ${t.pct.toFixed(1)} %`).join(" · ") + " · 격자 25 m · 화살표 높이 1.5 m(보행자 높이)",
      legend: swatch(WIND_B1.low, "λf &lt; 0.15") + swatch(WIND_B1.mid, "λf 0.15–0.40") + swatch(WIND_B1.high, "λf &gt; 0.40") +
        swatch(WIND_B1.corridor, `${KO_B1.primary}(굵게) · ${KO_B1.secondary}`) + swatch(WIND_B1.street, KO_B1.street.replace("≤", "&le;")) + " 화살표 = 바람 진행 방향"
    };
  }
  // B2: cold-air source cells and pooling cells on the ground + D8 flow lines with direction arrows.
  function renderB2(r, ov, env) {
    const s = r.stats, e = api.ctx().extent, step = s.gridStep;
    const G = { x0: e[0], y0: e[1], step, nx: Math.ceil((e[2] - e[0]) / step), ny: Math.ceil((e[3] - e[1]) / step) };
    const green = rgbOf(env.pal.green || "#B5CCA6"), lilac = rgbOf(WIND3D.lilac);
    ov.add(draped(gridTexture(G, k => s.pool[k] ? [...lilac, 165] : s.source[k] ? [...green, 120] : null), G, .25));
    const cc = k => [G.x0 + (k % G.nx + .5) * step, G.y0 + (Math.floor(k / G.nx) + .5) * step];
    const flow = ribbonSet();
    for (const ids of s.paths) {
      const pts = smoothPath(ids.map(cc), 2, 6);
      let run = [];
      const flush = () => { if (run.length > 1) addRibbon(flow, run, 2.4, .7); run = []; };
      for (const pt of pts) { if (inShape(pt[0], pt[1])) run.push(pt); else flush(); }   // cut at the edge of a circular site
      flush();
      if (pts.length < 2) continue;
      const tip = Math.max(1, Math.floor(pts.length * .65));
      if (inShape(pts[tip][0], pts[tip][1]) && inShape(pts[tip - 1][0], pts[tip - 1][1])) addArrow(flow, pts[tip - 1], pts[tip], 11, .7);
    }
    if (flow.idx.length) ov.add(ribbonMesh(flow, WIND3D.flow, 1, false));
    return {
      info: `흐름 격자 ${step} m · 생성지 시드 30 m`,
      legend: swatch(`rgb(${green})`, "찬공기 생성지", .6) + swatch(WIND3D.flow, "흐름 방향") + swatch(WIND3D.lilac, "정체 구역", .8)
    };
  }
  const rampRgb = (stops, t) => {
    const v = Math.max(0, Math.min(1, t)) * (stops.length - 1), a = Math.min(stops.length - 2, Math.floor(v)), u = v - a;
    const p = rgbOf(stops[a]), q = rgbOf(stops[a + 1]);
    return p.map((c, i) => Math.round(c + (q[i] - c) * u));
  };
  function tabLb3d(kind) {
    const def = LB_KINDS.find(d => d.kind === kind), spec = LB3D[kind];
    const opts = lbOptions[kind] ??= Object.fromEntries(def.controls.map(c => [c.key, c.default]));
    const ctx = api.ctx(), data = api.data(), pal = api.pal();
    if ((kind === "B1" || kind === "B4") && !data.climate)
      return missing(api.status("climate") === "loading" ? "기후(EPW) 데이터를 불러오는 중…" : "기후(EPW) 데이터를 불러오지 못했습니다.");
    const g = frame3d(false);
    g.scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 1.0));
    const dl = new THREE.DirectionalLight(0xffffff, .7); dl.position.set(1, 2, 1); g.scene.add(dl);
    g.scene.add(terrain(pal), buildings(pal), siteOutline(pal));
    // B1 paints opaque resistance classes on the ground: lift the water above them so the river stays a river
    { const wtr = water(pal); if (wtr) { if (kind === "B1") { wtr.position.y += .35; wtr.material.transparent = true; wtr.renderOrder = 4; /* transparent pass, after the class overlay (order 3) */ } g.scene.add(wtr); } }
    const ov = new THREE.Group(); g.scene.add(ov);
    const S = surfaceOf(ctx, data);
    controls.innerHTML = viewToggle(kind) + lbFields(def, opts) + saveGroup(`<button type="button" data-lb3="png">PNG</button>`) +
      `<span id="lb3-info" class="note"></span><div id="lb3-legend" class="note"></div>`;
    const draw = () => {
      def.controls.forEach(c => {
        const v = c.visibleWhen;
        controls.querySelector(`[data-lb-label="${c.key}"]`).hidden = !!v && opts[v.key] !== v.value;
      });
      $("lb3-info").textContent = "계산 중…";
      setTimeout(() => {
        if (gl !== g) return;                    // tab changed while waiting
        try {
          const r = LB_BUILD[kind](kind, { ctx, data: lbData(kind, data), pal: api.pal(), S, month: state.month, hour: state.utciHour, shadowDay, shadowHour }, lbOpts(kind, opts));
          disposeGroup(ov);
          if (spec.render) {
            const o = spec.render(r, ov, { pal: api.pal() });
            $("lb3-info").textContent = o.info;
            $("lb3-legend").innerHTML = o.legend;
            note.textContent = r.sheet.notes.join(" · ");
            return;
          }
          const values = r.stats.values;
          const vf = groundField(S, k => S.bld[k] ? NaN : values[k], .8);
          ov.add(draped(fieldTexture(S, k => vf[k], v => rampRgb(spec.stops, spec.t(v)), 6, waterMaskOf(S)), S, .25));
          $("lb3-info").textContent = spec.info(r.stats);
          const hex = c => "#" + c.map(x => x.toString(16).padStart(2, "0")).join("");
          $("lb3-legend").innerHTML = `<div style="width:260px;max-width:100%;text-align:left">${esc(spec.title(r.stats))} (${spec.unit})
            <div style="display:flex;height:8px;margin-top:4px">${Array.from({ length: 32 }, (_, i) => `<i style="flex:1;background:${hex(rampRgb(spec.stops, spec.t(i / 31 * spec.max)))}"></i>`).join("")}</div>
            <div style="position:relative;height:14px;font-size:10px">${spec.ticks.map(([v, t]) => `<span style="position:absolute;left:${v / spec.max * 100}%;transform:translateX(${v === 0 ? "0" : v === spec.max ? "-100%" : "-50%"})">${t}</span>`).join("")}</div></div>`;
          note.textContent = r.stats.notes[0];
        } catch (e) { $("lb3-info").textContent = String(e.message ?? e); }
      }, 0);
    };
    bindLb(def, opts, draw);
    stageLegend("lb3-legend");
    controls.onclick = e => { if (e.target.dataset.lb3) savePng(); };
    draw();
    badge(def.ko);
  }
  function tabLb(kind) {
    const def = LB_KINDS.find(d => d.kind === kind);
    const opts = lbOptions[kind] ??= Object.fromEntries(
      def.controls.map(c => [c.key, c.default])
    );
    const ctx = api.ctx(), data = api.data();
    if (["B3", "B4", "B5", "B6"].includes(kind) && !data.climate)
      return missing(api.status("climate") === "loading"
        ? "기후(EPW) 데이터를 불러오는 중…"
        : "기후(EPW) 데이터를 불러오지 못했습니다.");
    const name = `${kind.toLowerCase()}_plate`;
    let cur = null;
    controls.innerHTML = (state.view[kind] ? viewToggle(kind) : "") + lbFields(def, opts) + saveGroup(
      ["svg", "png", "pdf", "dxf", "3dm"].map(k =>
        `<button type="button" data-lb-save="${k}">${k === "3dm" ? k : k.toUpperCase()}</button>`
      ).join("")
    );
    const draw = () => {
      cur = null;
      def.controls.forEach(c => {
        const v = c.visibleWhen;
        controls.querySelector(`[data-lb-label="${c.key}"]`).hidden =
          !!v && opts[v.key] !== v.value;
      });
      const marker = document.createElement("p");
      marker.className = "note";
      marker.textContent = "계산 중…";
      stage.replaceChildren(marker);
      controls.querySelectorAll("[data-lb-save]").forEach(b => b.disabled = true);
      setTimeout(() => {
        if (!stage.contains(marker)) return;
        try {
          const env = {
            ctx, data: lbData(kind, data), pal: api.pal(), S: surfaceOf(ctx, data),
            month: state.month, hour: state.utciHour, shadowDay, shadowHour
          };
          cur = LB_BUILD[kind](kind, env, lbOpts(kind, opts));
          stage.innerHTML = `<div class="dg-2d" style="padding:8px;width:100%;height:100%;box-sizing:border-box;overflow:hidden">${cur.svg}</div>`;
          const svg = stage.querySelector("svg");
          svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
          Object.assign(svg.style, { width: "100%", height: "100%", display: "block" });
          panZoom(stage.firstElementChild);
          note.textContent = ZOOM_HINT;
          controls.querySelectorAll("[data-lb-save]").forEach(b => b.disabled = false);
          fitStage();
        } catch (e) { cur = null; missing(esc(e.message ?? e)); }
      }, 0);
    };
    bindLb(def, opts, draw);
    controls.onclick = async e => {
      const k = e.target.dataset.lbSave;
      if (!k || !cur) return;
      try {
        const p = cur;
        const spec = { def: p.def, sheet: p.sheet, ctx: p.ctx2, name };
        if (k === "pdf")
          await api.exportTab(k, {
            ...spec, svg: p.svg.replace(/font-family="[^"]*"/, 'font-family="Noto Sans KR"')
          }, e.target);
        else if (k === "dxf" || k === "3dm")
          await api.exportTab(k, { ...spec, custom: true }, e.target);
        else if (k === "svg")
          api.download(new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + p.svg],
            { type: "image/svg+xml" }), `${name}.svg`);
        else api.download(await api.pngFromSvg(p.svg), `${name}.png`);
      } catch (e) { missing(esc(e.message ?? e)); }
    };
    draw();
  }
  function plateTab(id) {
    const ctx = api.ctx(), data = api.data();
    if (id !== "A2" && !data.climate) return missing(api.status("climate") === "loading" ? "기후(EPW) 데이터를 불러오는 중…" : "기후(EPW) 데이터를 불러오지 못했습니다.");
    const S = surfaceOf(ctx, data), name = `${id.toLowerCase()}_plate`;
    let cur = null;
    const draw = () => {
      cur = buildPlate(id, { ctx, data, S, month: state.month, hour: state.utciHour, shadowDay, shadowHour });
      stage.innerHTML = `<div class="dg-2d" style="padding:8px">${cur.svg}</div>`;
      panZoom(stage.firstElementChild);
      if (id === "A4") $("a4-info").textContent = utciInfoText(cur.stats.e);
    };
    const month = id === "A4" ? `<label>월 <select id="a4-month">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}"${state.month === i + 1 ? " selected" : ""}>${i + 1}월</option>`).join("")}</select></label>
      <label>시각 <input id="a4-hour" type="range" min="0" max="23" step="1" value="${state.utciHour}"> <output id="a4-hour-out">${state.utciHour}:00</output></label>` : "";
    const shadow = id === "A2" ? `<label>그림자 날짜 <select id="a2-shadow-day">${SHADOW_DAYS.map(day => `<option value="${day.id}"${day.id === shadowDay ? " selected" : ""}>${day.label}</option>`).join("")}</select></label>
      <label>그림자 시각 <select id="a2-shadow-hour">${SHADOW_HOURS.map(hour => `<option value="${hour}"${hour === shadowHour ? " selected" : ""}>${hour}시</option>`).join("")}</select></label>` : "";
    controls.innerHTML = `${viewToggle(id)}${shadow}${month}${saveGroup(`<button type="button" data-pl="svg">SVG</button><button type="button" data-pl="png">PNG</button><button type="button" data-pl="pdf">PDF</button><button type="button" data-pl="dxf">DXF</button><button type="button" data-pl="3dm">3dm</button>`)}<span id="a4-info" class="note"></span>`;
    if (id === "A2") {
      $("a2-shadow-day").addEventListener("change", e => { shadowDay = e.target.value; draw(); });
      $("a2-shadow-hour").addEventListener("change", e => { shadowHour = Number(e.target.value); draw(); });
    }
    if (id === "A4") {
      $("a4-month").addEventListener("change", e => { state.month = Number(e.target.value); draw(); });
      $("a4-hour").addEventListener("input", e => { state.utciHour = Number(e.target.value); $("a4-hour-out").textContent = `${state.utciHour}:00`; draw(); });
    }
    controls.onclick = async e => {
      const k = e.target.dataset.pl;
      if (!k || !cur) return;
      if (k === "pdf") {
        const svg = cur.svg.replace(/font-family="[^"]*"/, 'font-family="Noto Sans KR"');
        api.exportTab("pdf", { def: cur.def, sheet: cur.sheet, ctx: cur.ctx2, svg, name }, e.target);
      }
      else if (k === "dxf" || k === "3dm") api.exportTab(k, { def: cur.def, sheet: cur.sheet, ctx: cur.ctx2, custom: true, name }, e.target);
      else if (k === "svg") api.download(new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + cur.svg], { type: "image/svg+xml" }), `${name}.svg`);
      else api.download(await api.pngFromSvg(cur.svg), `${name}.png`);
    };
    draw();
    const notes = {
      A2: "다이어그램: 청회색 면은 선택한 날짜와 시각에 건물 그림자를 평평한 지면에 투영한 결과입니다. 실제 지형의 고저차와 수목은 제외합니다. ",
      A3: "다이어그램: 연간 풍배도(대지 바깥 링)와 계절 풍배도. 풍속 색은 구간 값(m/s)이며 광역 통계로 국소 CFD가 아닙니다. ",
      A4: `다이어그램: ${KO_PLATE["plate.utci.note"]}. `
    };
    note.textContent = ZOOM_HINT + notes[id] + SIM;
  }

  // ---- A5 section -----------------------------------------------------------------------------------------
  const svgMap = (inner, vb) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" style="width:100%;height:100%;background:#fff">${inner}</svg>`;

  // true only for a real polygon site clearly smaller than the sheet (never for point+radius / full-extent sites)
  function siteIsSmallNow() {
    const c = api.ctx();
    const xs = c.site.ring.map(p => p[0]), ys = c.site.ring.map(p => p[1]);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < Math.min(c.extent[2] - c.extent[0], c.extent[3] - c.extent[1]) / 3;
  }
  let boxCache = null;
  function boxes() {
    const data = api.data();
    if (boxCache && boxCache.src === data.buildings) return boxCache.list;
    const list = data.buildings.map(b => {
      let a = Infinity, c = Infinity, d = -Infinity, e = -Infinity;
      for (const p of b.polygon) { a = Math.min(a, p[0]); c = Math.min(c, p[1]); d = Math.max(d, p[0]); e = Math.max(e, p[1]); }
      return { b, box: [a, c, d, e] };
    });
    boxCache = { src: data.buildings, list };
    return list;
  }

  // The A5 profile as a CAD sheet: x = distance along the section, y = elevation (both m, true 1:1).
  function sectionSpec(kind) {
    const p = profile;
    if (!p) { note.textContent = "먼저 왼쪽 지도에서 단면선을 그으세요."; return null; }
    const pal = api.pal(), ctx = api.ctx();
    const { L, ground, blds, zmin, zmax, ve } = p;
    // export uses the same vertical exaggeration as the screen; y is scaled about zmin
    const Y = z => zmin + (z - zmin) * ve, Z1 = Y(zmax), hm = Math.max(L, Z1 - zmin) / 70;
    const yy = pts => pts.map(([d, z]) => [d, Y(z)]);
    const sheet = {
      layers: [
        { id: "buildings", name: "건물 단면", items: blds.map(r => ({ k: "poly", rings: [yy(r)], fill: pal.building, stroke: pal.buildingLine, sw: .14 })) },
        { id: "terrain", name: "지형선", items: [{ k: "line", pts: yy(ground), stroke: pal.text, sw: .35 }] },
        { id: "labels", name: "라벨", items: [{ k: "text", p: [0, zmin - hm * 1.3], text: "A", fill: pal.text, hm }, { k: "text", p: [L, zmin - hm * 1.3], text: "B", fill: pal.text, hm }] }],
      legend: [{ kind: "fill", fill: pal.building, stroke: pal.buildingLine, label: "건물" }, { kind: "line", stroke: pal.text, sw: .35, label: "지형" }],
      notes: [`단면 A–B · 길이 ${L.toFixed(0)} m · ${ve === 1 ? "수직·수평 같은 축척(과장 없음)" : `수직 과장 ×${ve} (높이만 ${ve}배)`}`, "IGN 표고(RGE ALTI)와 BD TOPO 건물 높이. 건물 높이 미상은 3 m."], sources: ["RGE ALTI", "BD TOPO® V3"]
    };
    const c2 = { extent: [0, zmin, L, Z1], center: [L / 2, (zmin + Z1) / 2], site: { ring: [] }, address: ctx.address, radiusLabel: `단면 A–B 길이 ${L.toFixed(0)} m`, date: ctx.date, custom: true };
    const def = { num: "A5", ko: "단면", en: "section" };
    if (kind === "pdf") return { def, sheet, ctx: c2, svg: $("a5-svg").outerHTML, name: "a5_section" };
    return { def, sheet, ctx: c2, custom: true, name: "a5_section" };
  }
  let profile = null;
  function tabA5() {
    fitStage();
    const ctx = api.ctx(), data = api.data(), pal = api.pal();
    profile = null;
    const [x0, y0, x1, y1] = ctx.extent, S = Math.max(x1 - x0, y1 - y0);
    const VW = (x1 - x0) / S * 1000, VH = (y1 - y0) / S * 1000;
    // map above, profile full width below: a site section is a long flat strip and was
    // squeezed into a ~200 px column beside the map
    stage.innerHTML = `<div class="dg-2d" style="box-sizing:border-box;display:grid;grid-template-rows:38% minmax(0,1fr);gap:8px;padding:0 8px 8px;overflow:hidden;justify-items:center">
      <div id="a5-map" style="cursor:crosshair;height:100%;aspect-ratio:1;max-width:100%;min-height:0"></div>
      <div id="a5-profile" style="width:100%;min-height:0;display:grid;grid-auto-rows:minmax(0,1fr);overflow:hidden"></div></div>`;
    const mapDiv = $("a5-map"), profDiv = $("a5-profile");
    const tx = x => (x - x0) / S * 1000, ty = y => (y1 - y) / S * 1000;
    const path = (rings, close = true) => rings.map(r => r.map((p, i) => (i ? "L" : "M") + tx(p[0]).toFixed(1) + " " + ty(p[1]).toFixed(1)).join("") + (close ? "Z" : "")).join("");
    const waterD = (data.waterS || []).flatMap(f => f.polygons).map(r => path(r)).join("");   // the river, so the section line can be placed against it
    const base = `<rect width="${VW}" height="${VH}" fill="${pal.bg}"/>${waterD ? `<path d="${waterD}" fill="${pal.water}" fill-rule="evenodd"/>` : ""}<path d="${data.buildings.map(b => path([b.polygon, ...b.holes])).join("")}" fill="${pal.building}" stroke="${pal.buildingLine}" stroke-width=".6" fill-rule="evenodd"/>` +
      `<path d="${path([ctx.site.ring])}" fill="none" stroke="${pal.siteLine}" stroke-width="3"/>`;
    function drawMap() {
      let ov = "";
      if (section.a) ov += `<circle cx="${tx(section.a[0])}" cy="${ty(section.a[1])}" r="8" fill="${pal.siteLine}"/>`;
      if (section.a && section.b) ov += `<line x1="${tx(section.a[0])}" y1="${ty(section.a[1])}" x2="${tx(section.b[0])}" y2="${ty(section.b[1])}" stroke="${pal.siteLine}" stroke-width="4"/><circle cx="${tx(section.b[0])}" cy="${ty(section.b[1])}" r="8" fill="${pal.siteLine}"/>`;
      for (const [pt, name] of [[section.a, "A"], [section.b, "B"]]) if (pt) ov += `<text x="${tx(pt[0]) + 14}" y="${ty(pt[1]) - 12}" font-size="34" font-weight="700" fill="${pal.siteLine}" stroke="${pal.bg}" stroke-width="6" paint-order="stroke">${name}</text>`;
      mapDiv.innerHTML = svgMap(base + ov, `0 0 ${VW} ${VH}`);
    }
    function drawProfile() {
      profile = null;
      if (!(section.a && section.b)) { profDiv.innerHTML = `<p class="note" style="padding:24px;text-align:center">지도에서 두 점을 클릭해 단면선을 지정해 주세요.</p>`; return; }
      const [a, b] = [section.a, section.b];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const at = t => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const gz = t => { const [x, y] = at(t); return demAt(data.dem, x, y); };
      const n = Math.max(50, Math.round(L / 2));
      const ground = [];
      for (let i = 0; i <= n; i++) ground.push([i / n * L, gz(i / n)]);
      // buildings: exact crossings of the section line with each footprint edge, so every
      // building is its own closed polygon with vertical walls (sampled roofs made
      // trapezoids, and the roof line closed to zmin merged buildings with the ground)
      const lx0 = Math.min(a[0], b[0]), lx1 = Math.max(a[0], b[0]), ly0 = Math.min(a[1], b[1]), ly1 = Math.max(a[1], b[1]);
      const near = boxes().filter(q => q.box[2] >= lx0 && q.box[0] <= lx1 && q.box[3] >= ly0 && q.box[1] <= ly1).map(q => q.b);
      const cross = ring => {
        const ts = [];
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i], q = ring[(i + 1) % ring.length];
          const ex = q[0] - p[0], ey = q[1] - p[1], dx = b[0] - a[0], dy = b[1] - a[1];
          const den = dx * ey - dy * ex;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / den, u = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / den;
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1) ts.push(t);
        }
        return ts;
      };
      const blds = [];
      let ztop = -Infinity;
      for (const bd of near) {
        const ts = [0, 1, ...cross(bd.polygon), ...bd.holes.flatMap(cross)].sort((p, q) => p - q);
        const h = hOf(bd);
        for (let i = 0; i + 1 < ts.length; i++) {
          const t0 = ts[i], t1 = ts[i + 1];
          if (t1 - t0 < 1e-6) continue;
          const [mx, my] = at((t0 + t1) / 2);
          if (!inRing(bd.polygon, mx, my) || bd.holes.some(r => inRing(r, mx, my))) continue;
          // roof datum = lowest ground under the whole footprint + height (same as A1 / A8)
          const roofZ = Math.max(Math.min(...bd.polygon.map(p => demAt(data.dem, p[0], p[1]))) + h, gz(t0), gz(t1));
          ztop = Math.max(ztop, roofZ);
          const base = [[t0 * L, gz(t0)], ...ground.filter(([d]) => d > t0 * L && d < t1 * L), [t1 * L, gz(t1)]];
          blds.push([...base, [t1 * L, roofZ], [t0 * L, roofZ]]);
        }
      }
      const gzs = ground.map(p => p[1]);
      const zmin = Math.min(...gzs) - 3, zmax = Math.max(ztop, ...gzs) + 3;
      const ve = section.ve || 1;
      // screen: same true horizontal/vertical ratio as the export (× ve), height clamped
      const W = 1000, H = Math.max(200, Math.min(560, (zmax - zmin) * ve / L * (W - 80) + 80));
      const k = Math.min((W - 80) / L, (H - 80) / ((zmax - zmin) * ve));
      const sx = d => 40 + d * k, sy = z => H - 40 - (z - zmin) * ve * k;
      const pl = (pts, close) => pts.map((p, i) => (i ? "L" : "M") + sx(p[0]).toFixed(1) + " " + sy(p[1]).toFixed(1)).join("") + (close ? "Z" : "");
      profile = { L, ground, blds, zmin, zmax, ve };
      // elevation ticks on the left and distance ticks along the bottom (live review, Gemini)
      const zStep = (zmax - zmin) > 60 ? 20 : (zmax - zmin) > 25 ? 10 : 5, dStep = L > 600 ? 200 : L > 250 ? 100 : 50;
      let axisTicks = "";
      for (let z = Math.ceil(zmin / zStep) * zStep; z <= zmax; z += zStep) axisTicks += `<path d="M${sx(0).toFixed(1)} ${sy(z).toFixed(1)}H${sx(L).toFixed(1)}" stroke="${pal.edge}" stroke-width=".6" stroke-dasharray="3 4"/><text x="${(sx(0) - 5).toFixed(1)}" y="${(sy(z) + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="${pal.text}">${z}</text>`;
      for (let dd = dStep; dd < L; dd += dStep) axisTicks += `<path d="M${sx(dd).toFixed(1)} ${(H - 40).toFixed(1)}v5" stroke="${pal.text}" stroke-width="1"/><text x="${sx(dd).toFixed(1)}" y="${(H - 24).toFixed(1)}" font-size="11" text-anchor="middle" fill="${pal.text}">${dd} m</text>`;
      axisTicks += `<text x="${(sx(0) - 5).toFixed(1)}" y="${(sy(zmax) - 6).toFixed(1)}" font-size="10" text-anchor="end" fill="${pal.text}">m</text>`;
      profDiv.innerHTML = `<svg id="a5-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="display:block;width:100%;height:100%;min-height:0;background:#fff" font-family="Noto Sans, Noto Sans KR, sans-serif">
        <rect width="${W}" height="${H}" fill="${pal.bg}"/>
        <path d="${blds.map(r => pl(r, true)).join("")}" fill="${pal.building}" stroke="${pal.buildingLine}" stroke-width="1" stroke-linejoin="round"/>
        <path d="${pl(ground)}" fill="none" stroke="${pal.text}" stroke-width="2"/>
        ${axisTicks}
        <text x="40" y="26" font-size="16" fill="${pal.text}">단면 A–B · 길이 ${L.toFixed(0)} m · 지형 표고 ${Math.min(...gzs).toFixed(1)}–${Math.max(...gzs).toFixed(1)} m${blds.length ? ` · 건물 최고 ${ztop.toFixed(1)} m` : ""} · 건물 ${blds.length}</text>
        <text x="${sx(0)}" y="${H - 14}" font-size="13" fill="${pal.text}">A</text><text x="${sx(L) - 8}" y="${H - 14}" font-size="13" fill="${pal.text}">B</text>
        <text x="${W - 40}" y="26" font-size="12" text-anchor="end" fill="${pal.text}">${ve === 1 ? "수직·수평 같은 축척" : `수직 과장 ×${ve}`} · 굵은 선 = 지형, 면 = 건물</text></svg>`;
    }
    drawMap(); drawProfile();
    mapDiv.addEventListener("click", e => {
      const svg = mapDiv.querySelector("svg");
      const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const u = pt.matrixTransform(svg.getScreenCTM().inverse());       // map units (0..VW, 0..VH)
      if (u.x < 0 || u.x > VW || u.y < 0 || u.y > VH) return;
      const p = [x0 + u.x / 1000 * S, y1 - u.y / 1000 * S];
      if (!section.a || (section.a && section.b)) { section.a = p; section.b = null; } else section.b = p;
      drawMap(); drawProfile();
    });
    controls.innerHTML = `<button type="button" data-a5="reset">단면선 초기화</button>` +
      [1, 2, 3].map(v => `<button type="button" data-a5ve="${v}" aria-pressed="${(section.ve || 1) === v}">수직 ×${v}</button>`).join("") +
      saveGroup(`<button type="button" data-a5="svg">단면 SVG</button>` +
      ["pdf", "dxf", "3dm"].map(k => `<button type="button" data-a5="${k}">${k === "pdf" ? "PDF" : k === "dxf" ? "DXF" : "3dm"}</button>`).join(""));
    controls.onclick = e => {
      if (e.target.dataset.a5ve) {
        section.ve = Number(e.target.dataset.a5ve);
        controls.querySelectorAll("[data-a5ve]").forEach(btn => btn.setAttribute("aria-pressed", String(btn === e.target)));
        drawProfile(); return;
      }
      if (["pdf", "dxf", "3dm"].includes(e.target.dataset.a5)) { const sp = sectionSpec(e.target.dataset.a5); if (sp) api.exportTab(e.target.dataset.a5, sp, e.target); return; }
      if (e.target.dataset.a5 === "reset") { section.a = section.b = null; drawMap(); drawProfile(); }
      if (e.target.dataset.a5 === "svg") { const s = $("a5-svg"); if (s) api.download(new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + s.outerHTML], { type: "image/svg+xml" }), "a5_section.svg"); }
    };
    note.textContent = "대지 단면: IGN 표고(RGE ALTI) 및 BD TOPO 건물 높이 기준 (높이 미상 건물은 3 m 기본값). " + SIM;
  }
  function inRing(ring, x, y) {
    let r = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) r = !r;
    }
    return r;
  }

  // ---- A6 context map -----------------------------------------------------------------------------------------
  function tabA6() {
    const ctx = api.ctx(), data = api.data(), pal = api.pal();
    const layers = [["ortho", "항공사진", !!data.ortho], ["bldg", "건물", true], ["roads", "도로", !!data.roads], ["veg", "녹지", !!data.veg], ["water", "수면", !!data.waterS], ["parcels", "필지", !!data.parcels], ["trees", "수목", !!data.trees]];
    const on = state.ctxLayers || (state.ctxLayers = { ortho: false, bldg: true, roads: true, veg: true, water: true, parcels: false, trees: false });
    const [x0, y0, x1, y1] = ctx.extent, S = Math.max(x1 - x0, y1 - y0);
    const VW = (x1 - x0) / S * 1000, VH = (y1 - y0) / S * 1000;
    const tx = x => (x - x0) / S * 1000, ty = y => (y1 - y) / S * 1000;
    const path = (rings, close = true) => rings.map(r => r.map((p, i) => (i ? "L" : "M") + tx(p[0]).toFixed(1) + " " + ty(p[1]).toFixed(1)).join("") + (close ? "Z" : "")).join("");
    let vb = [0, 0, VW, VH];
    const circle = ctx.shape?.kind === "circle";
    // North arrow (true north) and a scale bar drawn in the current view, so they keep their size on
    // screen and stay correct while zooming; they are part of the SVG and are saved with it.
    function fur() {
      const u = vb[2] / 1000, mPerUnit = S / 1000;
      const target = vb[2] * mPerUnit * .2, pw = 10 ** Math.floor(Math.log10(target));
      const len = [1, 2, 5, 10].map(v => v * pw).reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a);
      const bx = vb[0] + 36 * u, by = vb[1] + vb[3] - 34 * u, bw = len / mPerUnit;
      const nx = vb[0] + vb[2] - 48 * u, ny = vb[1] + 70 * u;
      const halo = `stroke="${pal.bg}" stroke-width="${5 * u}" paint-order="stroke"`;
      return `<path d="M${bx} ${by - 7 * u}V${by}H${bx + bw}V${by - 7 * u}" fill="none" stroke="${pal.text}" stroke-width="${2 * u}"/>` +
        `<text x="${bx + bw / 2}" y="${by - 10 * u}" font-size="${17 * u}" text-anchor="middle" fill="${pal.text}" ${halo}>${len} m</text>` +
        `<g transform="rotate(${ctx.convergence || 0} ${nx} ${ny})"><path d="M${nx} ${ny + 22 * u}V${ny - 22 * u}M${nx - 8 * u} ${ny - 8 * u}L${nx} ${ny - 24 * u}L${nx + 8 * u} ${ny - 8 * u}" fill="none" stroke="${pal.text}" stroke-width="${2.2 * u}" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<text x="${nx}" y="${ny - 32 * u}" font-size="${20 * u}" font-weight="700" text-anchor="middle" fill="${pal.text}" ${halo}>N</text></g>`;
    }
    function svg() {
      // the map keeps the site shape: circle -> circular crop, square / rectangle -> W x H
      let s = (circle ? `<defs><clipPath id="a6clip"><circle cx="${VW / 2}" cy="${VH / 2}" r="${Math.min(VW, VH) / 2}"/></clipPath></defs><g clip-path="url(#a6clip)">` : "<g>") +
        `<rect width="${VW}" height="${VH}" fill="${pal.bg}"/>`;
      if (on.ortho && data.ortho) s += `<image href="${data.ortho}" x="0" y="0" width="${VW}" height="${VH}" preserveAspectRatio="none"/>`;
      if (on.veg && data.veg) s += `<path d="${data.veg.flatMap(f => f.polygons).map(r => path(r)).join("")}" fill="${pal.green}" fill-rule="evenodd" opacity=".9"/>`;
      if (on.water && data.waterS) s += `<path d="${data.waterS.flatMap(f => f.polygons).map(r => path(r)).join("")}" fill="${pal.water}" fill-rule="evenodd"/>`;
      if (on.parcels && data.parcels) s += `<path d="${data.parcels.flatMap(f => f.polygons).map(r => path(r)).join("")}" fill="none" stroke="${pal.edge}" stroke-width=".7"/>`;
      if (on.roads && data.roads) s += `<path d="${data.roads.flatMap(f => f.lines).map(l => path([l], false)).join("")}" fill="none" stroke="${pal.roadLine}" stroke-width="1.6" stroke-linecap="round"/>`;
      if (on.bldg) s += `<path d="${data.buildings.map(b => path([b.polygon, ...b.holes])).join("")}" fill="${on.ortho ? "none" : pal.building}" stroke="${pal.buildingLine}" stroke-width=".8" fill-rule="evenodd"/>`;
      if (on.trees && data.trees) {
        const tcol = mix(pal.green, pal.text, .3);
        s += data.trees.points.map(p => `<circle cx="${tx(p[0]).toFixed(1)}" cy="${ty(p[1]).toFixed(1)}" r="3.2" fill="${tcol}"/>`).join("");
        s += (data.trees.crowns || []).map(c => `<circle cx="${tx(c.p[0]).toFixed(1)}" cy="${ty(c.p[1]).toFixed(1)}" r="${Math.max(1.6, c.d / 2 / S * 1000).toFixed(1)}" fill="${tcol}" fill-opacity="${c.kind === "A" ? .75 : .45}"/>`).join("");
      }
      s += `<path d="${path([ctx.site.ring])}" fill="none" stroke="${pal.siteLine}" stroke-width="3.5" stroke-dasharray="14 9"/></g>`;
      return `<svg id="a6-svg" xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(" ")}" style="width:100%;height:100%;touch-action:none;cursor:grab">${s}<g id="a6-fur">${fur()}</g></svg>`;
    }
    stage.innerHTML = `<div class="dg-2d" id="a6-wrap" style="padding:0;overflow:hidden">${svg()}</div>`;
    const wrap = $("a6-wrap");
    const apply = () => { wrap.querySelector("svg").setAttribute("viewBox", vb.join(" ")); wrap.querySelector("#a6-fur").innerHTML = fur(); };
    wrap.addEventListener("wheel", e => {
      e.preventDefault();
      const svgEl = wrap.querySelector("svg"), pt = svgEl.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const u = pt.matrixTransform(svgEl.getScreenCTM().inverse());     // cursor in map units
      const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const nw = Math.max(60, Math.min(VW, vb[2] * k)), nh = nw * VH / VW;
      const fx = (u.x - vb[0]) / vb[2], fy = (u.y - vb[1]) / vb[3];
      vb = [Math.max(0, Math.min(VW - nw, u.x - fx * nw)), Math.max(0, Math.min(VH - nh, u.y - fy * nh)), nw, nh];
      apply();
    }, { passive: false });
    let drag = null;
    wrap.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY, vb: [...vb] }; wrap.setPointerCapture(e.pointerId); });
    wrap.addEventListener("pointermove", e => {
      if (!drag) return;
      const r = wrap.getBoundingClientRect(), s = vb[2] / Math.min(r.width, r.height * vb[2] / vb[3]);
      vb = [Math.max(0, Math.min(VW - vb[2], drag.vb[0] - (e.clientX - drag.x) * s)), Math.max(0, Math.min(VH - vb[3], drag.vb[1] - (e.clientY - drag.y) * s)), vb[2], vb[3]]; apply();
    });
    wrap.addEventListener("pointerup", () => { drag = null; });
    controls.innerHTML = layers.map(([k, t, ok]) => `<label><input type="checkbox" data-l="${k}" ${on[k] ? "checked" : ""} ${ok ? "" : "disabled"}> ${t}${ok ? "" : " (없음)"}</label>`).join("") +
      `<button type="button" data-a6="fit">전체 보기</button>${saveGroup(`<button type="button" data-a6="svg">SVG</button>`)}`;
    controls.onchange = e => { if (e.target.dataset.l) { on[e.target.dataset.l] = e.target.checked; wrap.innerHTML = svg(); } };
    controls.onclick = e => {
      if (e.target.dataset.a6 === "fit") { vb = [0, 0, VW, VH]; apply(); }
      if (e.target.dataset.a6 === "svg") api.download(new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + wrap.innerHTML], { type: "image/svg+xml" }), "a6_context.svg");
    };
    note.textContent = (PHONE() ? "드래그로 이동할 수 있습니다." : "마우스 휠로 확대/축소, 드래그로 이동할 수 있습니다.") + " 활성화된 레이어는 앞서 조회된 IGN·OSM 데이터입니다.";
  }

  // ---- A7 merge sheets ----------------------------------------------------------------------------------------
  function tabA7() {
    const defs = api.defs().filter(d => api.sheetOk(d));
    state.merge = state.merge || new Set(["02"]);
    const draw = () => {
      const chosen = defs.filter(d => state.merge.has(d.num));
      const preview = $("a7-preview");
      if (!chosen.length) {
        state.mergedSheet = null; state.mergedDef = null;
        controls.querySelectorAll("[data-a7]").forEach(b => { b.disabled = true; });
        preview.innerHTML = `<p class="note" style="padding:24px">중첩할 다이어그램 레이어를 선택해 주세요.</p>`; return;
      }
      controls.querySelectorAll("[data-a7]").forEach(b => { b.disabled = false; });
      const sheets = chosen.map(d => ({ d, s: api.sheetFor(d) })).filter(x => x.s);
      const layers = [], legend = [], notes = [], sources = [];
      const seenContext = new Set();
      for (const { d, s } of sheets) {
        for (const l of s.layers) {
          if ((l.id === "context" || l.id === "bati_line") && seenContext.has(l.id)) continue;
          seenContext.add(l.id);
          layers.push({ ...l, id: `d${d.num}_${l.id}`, name: `${d.num} ${l.name}` });
        }
        legend.push({ kind: "fill", fill: "none", stroke: "none", label: `[${d.num} ${d.ko}]` });
        legend.push(...s.legend.filter(e => e.kind !== "site"));
        notes.push(...(s.notes || []).slice(0, 1));
        sources.push(...(s.sources || []));
      }
      legend.push({ kind: "site", label: "대지 경계" });
      const merged = { layers, legend: legend.slice(0, 26), notes: notes.slice(0, 4), sources: [...new Set(sources)] };
      state.mergedSheet = merged;
      const def = { num: "A7", ko: "다이어그램 오버레이", fr: "다이어그램 합치기", en: "merged " + chosen.map(d => d.num).join("+") };
      preview.innerHTML = renderSvg(def, merged, api.ctx(), { prefix: "a7-", pal: api.pal() });
      state.mergedDef = def;
    };
    stage.innerHTML = `<div class="dg-2d" id="a7-preview" style="padding:8px"></div>`;
    panZoom($("a7-preview"));
    // phones only (CSS): the 28 layers fold behind one button; the layers that are on stay visible as chips
    // with a × each, and the open list scrolls inside ~35 % of the screen so the sheet below stays in view
    controls.innerHTML = `<button type="button" class="dg-fold" id="dg-a7-fold" aria-expanded="false" aria-controls="dg-a7-list"></button><div class="dg-a7-chips" id="dg-a7-chips"></div>` +
      `<div class="dg-a7-list is-folded" id="dg-a7-list">` + defs.map(d => `<label><input type="checkbox" data-m="${d.num}" ${state.merge.has(d.num) ? "checked" : ""}> ${d.num} ${d.ko}</label>`).join("") + `</div>` +
      `${saveGroup(`<button type="button" data-a7="svg">SVG</button><button type="button" data-a7="png">PNG</button><button type="button" data-a7="pdf">PDF</button><button type="button" data-a7="dxf">DXF</button><button type="button" data-a7="3dm">3dm</button>`)}`;
    const syncFold = () => {
      const fold = $("dg-a7-fold"), open = fold.getAttribute("aria-expanded") === "true", n = state.merge.size;
      fold.innerHTML = `<span>${open ? `레이어 목록 접기 (${n}개 선택)` : `레이어 선택 (${n}/${defs.length})`}</span><i aria-hidden="true">${open ? "▲" : "▼"}</i>`;
      $("dg-a7-list").classList.toggle("is-folded", !open);
      $("dg-a7-chips").innerHTML = defs.filter(d => state.merge.has(d.num)).map(d =>
        `<span class="dg-chip">${d.num} ${d.ko}<button type="button" data-chip="${d.num}" aria-label="${d.ko} 레이어 끄기">×</button></span>`).join("");
    };
    syncFold();
    controls.onchange = e => { if (e.target.dataset.m) { e.target.checked ? state.merge.add(e.target.dataset.m) : state.merge.delete(e.target.dataset.m); draw(); syncFold(); } };
    controls.onclick = async e => {
      const fold = e.target.closest("#dg-a7-fold");
      if (fold) { fold.setAttribute("aria-expanded", String(fold.getAttribute("aria-expanded") !== "true")); syncFold(); return; }
      const chip = e.target.dataset.chip;
      if (chip) { state.merge.delete(chip); const box = controls.querySelector(`[data-m="${chip}"]`); if (box) box.checked = false; draw(); syncFold(); $("dg-a7-fold").focus(); return; }
      const k = e.target.dataset.a7;
      if (!k || !state.mergedSheet) return;
      if (k === "pdf" || k === "dxf" || k === "3dm") api.exportTab(k, { def: state.mergedDef, sheet: state.mergedSheet, name: "a7_merged" }, e.target);
      else if (k === "svg") api.download(new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + renderSvg(state.mergedDef, state.mergedSheet, api.ctx(), { absoluteSize: true, pal: api.pal() })], { type: "image/svg+xml" }), "a7_merged.svg");
      else api.download(await api.png(state.mergedDef, state.mergedSheet), "a7_merged.png");
    };
    draw();
    note.textContent = ZOOM_HINT + "선택한 다이어그램 레이어들을 한 도면에 중첩합니다 (주변 건물 레이어는 1회만 반영). 레이어명은 [다이어그램 번호_원래 레이어명]으로 구분되며 범례는 최대 26행까지 표시됩니다.";
  }

  // ---- A8 axonometric diagram ----------------------------------------------------------------------------------
  function axoSvg() {
    const ctx = api.ctx(), data = api.data(), pal = api.pal();
    const th = state.axoAz * RAD, el = state.axoEl * RAD;
    const cx = ctx.center[0], cy = ctx.center[1];
    // view: horizontal rotation then tilt. screen x = u, screen up = z*cos(el) + v*sin(el)
    const proj = (x, y, z) => {
      const X = x - cx, Y = y - cy;
      const u = X * Math.cos(th) - Y * Math.sin(th);
      const v = X * Math.sin(th) + Y * Math.cos(th); // away from the viewer
      return [u, -(z * Math.cos(el) + v * Math.sin(el)), v];
    };
    const zOf = (x, y) => demAt(data.dem, x, y) - baseZ();
    const hcls = h => h < 6 ? 0 : h < 12 ? 1 : h < 18 ? 2 : h < 30 ? 3 : 4;
    const unkCol = mix(pal.building, pal.bg, .5);
    const hasUnknown = data.buildings.some(b => heightOf(b) == null);
    const siteIsSmall = (() => {
      const xs = ctx.site.ring.map(p => p[0]), ys = ctx.site.ring.map(p => p[1]);
      return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < Math.min(ctx.extent[2] - ctx.extent[0], ctx.extent[3] - ctx.extent[1]) / 3;
    })();
    // a point+radius site covers every building: highlighting it would tint the whole sheet
    const inSite = b => siteIsSmall && inRing(ctx.site.ring, b.polygon[0][0], b.polygon[0][1]);
    const items = [];
    const toward = [-Math.sin(th), -Math.cos(th)]; // not used for culling, painter's order only
    void toward;
    for (const b of data.buildings) {
      const h = hOf(b), base = Math.min(...b.polygon.map(p => zOf(p[0], p[1])));
      // unknown height (drawn at 3 m) gets its own neutral tint, never a height class
      const col = state.axoMode === "height" ? (heightOf(b) == null ? unkCol : seqOf(pal)[hcls(h)]) : state.axoMode === "site" ? (inSite(b) ? pal.site : pal.building) : pal.building;
      const cb = clipBld(b);
      if (!cb) continue;
      const ring = cb.polygon;
      const roof = ring.map(p => proj(p[0], p[1], base + h));
      const walls = [], corners = [], feet = [];
      const addWalls = (r, inward) => {
        const sg = (signedArea(r) > 0 ? 1 : -1) * (inward ? -1 : 1);
        const n = r.length, front = new Array(n).fill(false), dir = new Array(n).fill(null), wallAt = new Array(n).fill(null);
        for (let i = 0; i < n; i++) {
          const p = r[i], c = r[(i + 1) % n];
          const len = Math.hypot(c[0] - p[0], c[1] - p[1]);
          if (len < 1e-6) continue;
          dir[i] = [(c[0] - p[0]) / len, (c[1] - p[1]) / len];
          const A = proj(p[0], p[1], base), B = proj(c[0], c[1], base), C = proj(c[0], c[1], base + h), D = proj(p[0], p[1], base + h);
          const nx = (c[1] - p[1]) * sg, ny = -(c[0] - p[0]) * sg; // solid-outward normal
          const nu = nx * Math.cos(th) - ny * Math.sin(th), nv = nx * Math.sin(th) + ny * Math.cos(th);
          if (nv > 0) continue; // faces away from the viewer
          front[i] = true;
          // each wall carries its own ground line and corner edges, so they are painted with the wall in
          // depth order and never show through a nearer wall of the same building (cross-review, Gemini)
          wallAt[i] = { pts: [A, B, C, D], v: (A[2] + B[2]) / 2, foot: [A, B], edges: [], shade: .1 + .25 * (nu < 0 ? 1 : 0) + .1 * Math.abs(nv) / (Math.hypot(nu, nv) || 1) };
          walls.push(wallAt[i]);
        }
        // vertical edges only where the facade really turns (> 20 deg) or at a silhouette; a curved or
        // finely segmented facade no longer gets one black line per footprint vertex
        for (let i = 0; i < n; i++) {
          if (!dir[i]) continue;
          let j = (i + n - 1) % n;
          for (let k = 0; k < n && !dir[j]; k++) j = (j + n - 1) % n;
          if (!dir[j] || !(front[i] || front[j])) continue;
          const dot = dir[i][0] * dir[j][0] + dir[i][1] * dir[j][1];
          if (front[i] !== front[j] || dot < Math.cos(20 * RAD)) (front[i] ? wallAt[i] : wallAt[j]).edges.push([proj(r[i][0], r[i][1], base), proj(r[i][0], r[i][1], base + h)]);
        }
      };
      addWalls(ring, false);
      for (const hole of cb.holes) addWalls(hole, true); // courtyard walls
      const holeRoofs = cb.holes.map(hr => hr.map(p => proj(p[0], p[1], base + h)));
      const vc = roof.reduce((a, p) => a + p[2], 0) / roof.length;
      items.push({ roof, holeRoofs, walls, corners, feet, col, depth: vc, base });
    }
    items.sort((a, b) => b.depth - a.depth);
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    const grow = p => { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); };
    const [x0, y0, x1, y1] = ctx.extent;
    const plate = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(p => proj(p[0], p[1], 0));
    plate.forEach(grow);
    items.forEach(i => { i.roof.forEach(grow); i.walls.forEach(w => w.pts.forEach(grow)); });
    axoGeom = { items, plate, site: ctx.site.ring.map(p => proj(p[0], p[1], 0)), mode: state.axoMode, az: state.axoAz, el: state.axoEl };
    // the title block (two lines) gets its own band above the drawing and the legend one below it, both
    // sized from the title type, so neither overlaps the model (the fixed 40 / 20 px did at large sizes)
    const pad = (maxx - minx) * .04, W = maxx - minx + pad * 2;
    const titleSize = Math.max(14, W / 55), top = titleSize * 2.7;
    const H = maxy - miny + pad * 2 + top + titleSize * 2.2;
    const f = n => n.toFixed(1);
    const P = p => `${f(p[0] - minx + pad)} ${f(p[1] - miny + pad + top)}`;
    const poly = pts => "M" + pts.map(P).join("L") + "Z";
    const lw = Math.max(.35, W / 1600);
    let out = `<rect width="${f(W)}" height="${f(H)}" fill="${pal.bg}"/>`;
    out += `<path d="${poly(plate)}" fill="none" stroke="${pal.edge}" stroke-width="${f(lw)}" stroke-dasharray="${f(lw * 4)} ${f(lw * 3)}"/>`;
    // water surfaces on the ground (clipped to the sheet), under the buildings: without them a river
    // read as an empty gap in the model
    {
      let wd = "";
      for (const ft of data.waterS || []) for (const rings of ft.polygons) {
        const [outer, ...holes] = rings.map(clipToSite);
        if (!outer || outer.length < 3) continue;
        wd += [outer, ...holes.filter(h => h.length >= 3)].map(r => poly(r.map(p => proj(p[0], p[1], zOf(p[0], p[1]))))).join("");
      }
      if (wd) out += `<path d="${wd}" fill="${pal.water}" fill-rule="evenodd" stroke="${pal.waterLine || pal.edge}" stroke-width="${f(lw * .5)}" stroke-linejoin="round"/>`;
    }
    const sitePts = ctx.site.ring.map(p => proj(p[0], p[1], zOf(p[0], p[1])));   // on the terrain, like the building bases
    const sxs = ctx.site.ring.map(p => p[0]), sys = ctx.site.ring.map(p => p[1]);
    const smallSite = Math.max(Math.max(...sxs) - Math.min(...sxs), Math.max(...sys) - Math.min(...sys)) < (x1 - x0) / 3;
    out += `<path d="${poly(sitePts)}" fill="${smallSite ? pal.site : "none"}" fill-opacity=".25" stroke="${pal.siteLine}" stroke-width="${f(lw * (smallSite ? 2.2 : 1.2))}" stroke-linejoin="round"${smallSite ? "" : ` stroke-dasharray="${f(lw * 5)} ${f(lw * 3)}"`}/>`;
    for (const it of items) {
      // line hierarchy: wall faces carry no outline of their own (stroked in their fill colour to close
      // hairline gaps), then thin ground lines, medium corner edges, and the roof outline heaviest
      const seg0 = l => "M" + l.map(P).join("L");
      for (const w of [...it.walls].sort((a, b) => b.v - a.v)) {          // far walls first
        const wf = mix(it.col, pal.dark ? "#ffffff" : "#000000", pal.dark ? w.shade * .5 : w.shade);
        out += `<path d="${poly(w.pts)}" fill="${wf}" stroke="${wf}" stroke-width="${f(lw * .3)}" stroke-linejoin="round"/>` +
          `<path d="${seg0(w.foot)}" fill="none" stroke="${pal.buildingLine}" stroke-width="${f(lw * .45)}" stroke-linecap="round"/>`;
        if (w.edges.length) out += `<path d="${w.edges.map(seg0).join("")}" fill="none" stroke="${pal.buildingLine}" stroke-width="${f(lw * .6)}" stroke-linecap="round"/>`;
      }
      const seg = l => "M" + l.map(P).join("L");
      out += `<path d="${[it.roof, ...it.holeRoofs].map(poly).join("")}" fill-rule="evenodd" fill="${mix(it.col, pal.dark ? "#000000" : "#ffffff", .25)}" stroke="${pal.buildingLine}" stroke-width="${f(lw * .95)}" stroke-linejoin="round"/>`;
    }
    const mode = { site: "대지 건물 강조", height: "높이 5단계", plain: "단색" }[state.axoMode];
    out += `<text x="${f(pad)}" y="${f(pad + titleSize)}" font-size="${f(titleSize)}" font-weight="600" fill="${pal.text}">액소노메트릭 도면 · ${esc(ctx.address)}</text>` +
      `<text x="${f(pad)}" y="${f(pad + titleSize * 2)}" font-size="${f(titleSize * .62)}" fill="${pal.text}">${mode} · 방위각 ${state.axoAz}° (${COMPASS8[((state.axoAz + 180) % 360) / 45]} → ${COMPASS8[(state.axoAz % 360) / 45]}) · 고도각 ${state.axoEl}° · Not to Scale(축측 투영) · 참고용 시뮬레이션 · © IGN BD TOPO, RGE ALTI</text>`;
    if (state.axoMode === "height") {
      ["6 m 미만", "6–12", "12–18", "18–30", "30 m 이상"].forEach((t, i) => {
        out += `<rect x="${f(pad + i * titleSize * 4.2)}" y="${f(H - titleSize * 1.4)}" width="${f(titleSize * .9)}" height="${f(titleSize * .9)}" fill="${pal.seq5[i]}" stroke="${pal.buildingLine}" stroke-width="${f(lw * .6)}"/><text x="${f(pad + i * titleSize * 4.2 + titleSize * 1.1)}" y="${f(H - titleSize * .65)}" font-size="${f(titleSize * .62)}" fill="${pal.text}">${t}</text>`;
      });
      if (hasUnknown) out += `<rect x="${f(pad + 5 * titleSize * 4.2)}" y="${f(H - titleSize * 1.4)}" width="${f(titleSize * .9)}" height="${f(titleSize * .9)}" fill="${unkCol}" stroke="${pal.buildingLine}" stroke-width="${f(lw * .6)}"/><text x="${f(pad + 5 * titleSize * 4.2 + titleSize * 1.1)}" y="${f(H - titleSize * .65)}" font-size="${f(titleSize * .62)}" fill="${pal.text}">정보 없음 (3 m 가정)</text>`;
    }
    // North arrow + scale reference: a ground circle seen in the same projection. Its horizontal
    // diameter is parallel to the picture plane, so that one length is true; the arrow points to grid north.
    {
      const R0 = Math.max(10, Math.round((x1 - x0) / 16 / 10) * 10);          // ground radius, m
      const rx = R0, ry = R0 * Math.sin(el);
      const ox = W - pad - rx - titleSize * .6, oy = H - pad - ry - titleSize * 1.5;
      const nx = -Math.sin(th) * R0, ny = -Math.cos(th) * Math.sin(el) * R0;   // projected north radius
      const len = Math.hypot(nx, ny) || 1, ux = nx / len, uy = ny / len, hd = titleSize * .55;
      const tipx = ox + nx, tipy = oy + ny;
      out += `<g fill="none" stroke="${pal.text}" stroke-width="${f(lw * 1.2)}" stroke-linecap="round" stroke-linejoin="round">` +
        `<ellipse cx="${f(ox)}" cy="${f(oy)}" rx="${f(rx)}" ry="${f(ry)}"/>` +
        `<path d="M${f(ox - rx)} ${f(oy)}L${f(ox + rx)} ${f(oy)}" stroke-dasharray="${f(lw * 4)} ${f(lw * 3)}"/>` +
        `<path d="M${f(ox - nx)} ${f(oy - ny)}L${f(tipx)} ${f(tipy)}"/>` +
        `<path d="M${f(tipx)} ${f(tipy)}L${f(tipx - ux * hd - uy * hd * .45)} ${f(tipy - uy * hd + ux * hd * .45)}L${f(tipx - ux * hd + uy * hd * .45)} ${f(tipy - uy * hd - ux * hd * .45)}Z" fill="${pal.text}"/></g>` +
        `<text x="${f(tipx + ux * titleSize * .7)}" y="${f(tipy + uy * titleSize * .7 + titleSize * .25)}" font-size="${f(titleSize * .7)}" font-weight="600" text-anchor="middle" fill="${pal.text}">N</text>` +
        `<text x="${f(ox)}" y="${f(ny > 0 ? oy - ry - titleSize * .45 : oy + ry + titleSize * .95)}" font-size="${f(titleSize * .62)}" text-anchor="middle" fill="${pal.text}">${2 * R0} m</text>`;   // away from the "N" letter when north points down-screen
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(W)} ${f(H)}" font-family="Noto Sans, Noto Sans KR, sans-serif">${out}</svg>`;
  }
  let axoGeom = null;
  // The A8 result as a CAD sheet in projected metres (x = screen right, y = screen up); built from the same
  // projected polygons as the SVG. Outlines only (no fills).
  function axoSpec(kind) {
    axoSvg();
    const g = axoGeom, pal = api.pal(), ctx = api.ctx();
    const cad = p => [p[0], -p[1]];
    const pts = [...g.plate, ...g.items.flatMap(i => [...i.roof, ...i.walls.flatMap(w => w.pts)])].map(cad);
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const ext = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const ln = pal.buildingLine;
    const sheet = {
      layers: [
        { id: "plate", name: "분석 범위(투영)", items: [{ k: "poly", rings: [g.plate.map(cad)], fill: "none", stroke: pal.edge, sw: .25, dash: "3 2" }] },
        { id: "site", name: "대지(투영)", items: [{ k: "poly", rings: [g.site.map(cad)], fill: "none", stroke: pal.siteLine, sw: .45 }] },
        { id: "walls", name: "벽", items: g.items.flatMap(i => i.walls.map(w => ({ k: "poly", rings: [w.pts.map(cad)], fill: "none", stroke: ln, sw: .1 }))) },
        { id: "roofs", name: "지붕", items: g.items.map(i => ({ k: "poly", rings: [i.roof, ...i.holeRoofs].map(r => r.map(cad)), fill: "none", stroke: ln, sw: .12 })) }],
      legend: [{ kind: "fill", fill: "none", stroke: ln, label: "건물(축측 투영)" }, { kind: "site", label: "대지 경계" }],
      notes: [`액소노메트릭 · 방위 ${g.az}° · 고도 ${g.el}° · 축척 없음(투영 좌표, 단위 m)`], sources: ["BD TOPO® V3", "RGE ALTI"]
    };
    const c2 = { extent: ext, center: [(ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2], site: { ring: [] }, address: ctx.address, radiusLabel: `액소노메트릭 ${g.az}° / ${g.el}°`, date: ctx.date, custom: true };
    const def = { num: "A8", ko: "3D 다이어그램", en: "axonometric" };
    if (kind === "pdf") return { def, sheet, ctx: c2, svg: axoSvg(), name: "a8_axonometric" };
    // the 3dm also carries the 3D meshes; the 2D result is placed beside the model
    const side = Math.max(ctx.extent[2] - ctx.extent[0], ctx.extent[3] - ctx.extent[1]);
    return { def, sheet, ctx: c2, custom: kind === "dxf", volumes: kind === "3dm", origin: kind === "3dm" ? [-(side * 1.7), 0] : null, docOrigin: kind === "3dm" ? ctx.center : null, name: "a8_axonometric" };
  }
  const signedArea = r => { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };

  function tabA8() {
    if (state.axoMode === "site" && !siteIsSmallNow()) state.axoMode = "height";
    const draw = () => { stage.innerHTML = `<div class="dg-2d" style="padding:8px">${axoSvg()}</div>`; panZoom(stage.firstElementChild); };
    controls.innerHTML = `<span>방위 ${[45, 135, 225, 315].map(a => `<button type="button" data-az="${a}" aria-pressed="${state.axoAz === a}">${a}°</button>`).join("")}</span>
      <span>고도 ${[30, 45, 60].map(a => `<button type="button" data-el="${a}" aria-pressed="${state.axoEl === a}">${a}°</button>`).join("")}</span>
      <span>표현 ${[["site", "대지 강조"], ["height", "높이 단계"], ["plain", "단색"]].filter(([v]) => v !== "site" || siteIsSmallNow()).map(([v, t]) => `<button type="button" data-mode="${v}" aria-pressed="${state.axoMode === v}">${t}</button>`).join("")}</span>
      ${saveGroup(`<button type="button" data-a8="svg">SVG</button><button type="button" data-a8="png">PNG</button><button type="button" data-a8="pdf">PDF</button><button type="button" data-a8="dxf">DXF</button><button type="button" data-a8="3dm">3dm</button>`)}`;
    controls.onclick = async e => {
      const t = e.target;
      if (t.dataset.az) { state.axoAz = Number(t.dataset.az); }
      else if (t.dataset.el) { state.axoEl = Number(t.dataset.el); }
      else if (t.dataset.mode) { state.axoMode = t.dataset.mode; }
      else if (["pdf", "dxf", "3dm"].includes(t.dataset.a8)) { api.exportTab(t.dataset.a8, axoSpec(t.dataset.a8), t); return; }
      else if (t.dataset.a8) {
        const svg = axoSvg();
        if (t.dataset.a8 === "svg") api.download(new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + svg], { type: "image/svg+xml" }), "a8_axonometric.svg");
        else api.download(await api.pngFromSvg(svg), "a8_axonometric.png");
        return;
      } else return;
      controls.querySelectorAll("button[aria-pressed]").forEach(b => {
        const k = b.dataset.az ? ["az", state.axoAz] : b.dataset.el ? ["el", state.axoEl] : ["mode", state.axoMode];
        b.setAttribute("aria-pressed", String(String(b.dataset[k[0]]) === String(k[1])));
      });
      draw();
    };
    draw();
    note.textContent = ZOOM_HINT + "벡터 기반 액소노메트릭(축측 투영) 도면입니다. [대지 강조 / 높이 5단계 / 단색 매스] 중 프리젠테이션 목적에 맞는 표현 방식을 선택해 주세요. " + SIM;
  }

  function missing(msg) { stage.innerHTML = `<div class="dg-2d"><p class="note">${msg}</p></div>`; }

  // ---- routing ---------------------------------------------------------------------------------------------------
  function show(id) {
    active = id;
    bar.querySelectorAll("[data-tab]").forEach(b => { b.setAttribute("aria-selected", String(b.dataset.tab === id)); b.tabIndex = b.dataset.tab === id ? 0 : -1; });
    { const cur = bar.querySelector(`[data-tab="${id}"]`); if (cur && bar.scrollWidth > bar.clientWidth) bar.scrollTo({ left: cur.offsetLeft - bar.clientWidth / 2 + cur.offsetWidth / 2 }); }   // phones: the bar scrolls sideways
    stage.setAttribute("aria-label", TABS.find(t => t[0] === id)?.[1] || id);
    clearStage();
    fitStage();
    // bring the tab bar under the sticky header so tabs + controls + the whole stage fit without scrolling
    { const t = bar.getBoundingClientRect().top; if (Math.abs(t - 64) > 8) window.scrollTo({ top: window.scrollY + t - 64, behavior: "auto" }); }
    if (!ready()) return missing("다이어그램 생성 단계에서 건물 데이터를 먼저 조회해 주세요.");
    try {
      if (LB_BUILD[id]) (state.view[id] === "3d" ? tabLb3d(id) : tabLb(id));
      else if (state.view[id] === "plate") plateTab(id);
      else ({ A1: tabA1, A2: tabA2, A3: tabA3, A4: tabA4, A5: tabA5, A6: tabA6, A7: tabA7, A8: tabA8 })[id]();
      fitStage();
    } catch (e) { console.error(e); missing("분석 다이어그램을 생성하지 못했습니다: " + e.message); }
  }

  return { show: () => show(active), refresh: () => show(active), stop: () => { gl?.stopPlay?.(); clearStage(); } };
}
