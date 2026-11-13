import { semanticPalette } from "./dgsemantic.js?v=20261113s";
// Analysis tabs A1-A8 of the site-diagram mode (step 4). three.js for the 3D tabs
// (same three build / importmap as viewer3d.js), plain SVG for section, context,
// merge and axonometric export. All computed results are reference simulations.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { mix, renderSvg, ringArea, seqOf } from "./dgcore.js?v=20261113s";
import { heightOf } from "./dganalysis.js?v=20261113p";
import {
  sunPosition, parisDate, parisOffset, KEY_DAYS, demAt, sunHours, shadowMask, nearestStation
} from "./dgenv.js?v=20261113u";
import { surfaceOf } from "./dgdefs3.js?v=20261113t";
import { UTCI_CATS, UTCI_RANGE, utciCat } from "./dgutci.js?v=20261113x";
import { buildPlate, utciEnv, utciInfoText, CLIMATE, KO_PLATE, SPEED_LABELS, SHADOW_DAYS, SHADOW_HOURS } from "./dgclimplate_v02.js?v=20261113zb";

const SIM = "참고용 시뮬레이션 · 법적 효력 없음";
const TABS = [
  ["A1", "3D 볼륨"], ["A2", "일조·그림자"], ["A3", "바람"], ["A4", "열쾌적성"],
  ["A5", "단면"], ["A6", "컨텍스트 맵"], ["A7", "도판 오버레이"], ["A8", "3D 액소노메트릭"]
];
const RAD = Math.PI / 180;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hOf = b => { const h = heightOf(b); return h == null ? 3 : h; };

export function createTabs(api) {
  const $ = id => document.getElementById(id);
  const bar = $("dg-tabbar"), controls = $("dg-controls"), stage = $("dg-stage"), note = $("dg-tabnote");
  let active = "A1";
  const basePalette = api.pal;
  api = { ...api, pal: () => {
    const p = semanticPalette(basePalette());
    const ramps = { A2: p.sun, A3: p.wind, A4: p.sun, A8: p.height };
    return { ...p, seq5: ramps[active] || p.height };
  } };
  let gl = null;          // { renderer, scene, camera, controls, raf, sun, ... }
  const state = { date: "equinox", hour: 13, overlay: "none", season: 0, month: 7, utciHour: 14, axoAz: 45, axoEl: 30, axoMode: "height", ctxOrtho: false, view: { A2: "3d", A3: "3d", A4: "3d" } };
  const section = { a: null, b: null };

  // ---- shell -------------------------------------------------------------------------------
  bar.innerHTML = TABS.map(([id, label]) =>
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
  const viewToggle = id => `<span role="group" aria-label="보기">${[["3d", KO_PLATE["plate.view3d"]], ["plate", KO_PLATE["plate.viewPlate"]]].map(([v, t]) => `<button type="button" data-view="${v}" aria-pressed="${state.view[id] === v}">${t}</button>`).join("")}</span>`;
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

  function clearStage() { disposeGl(); stage.replaceChildren(); controls.replaceChildren(); note.textContent = ""; }

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
    const controlsO = new OrbitControls(camera, renderer.domElement);
    controlsO.target.set(0, 0, 0); controlsO.maxPolarAngle = Math.PI * .495; controlsO.update();
    const g = { renderer, scene, camera, controls: controlsO, side, raf: 0 };
    const loop = () => { g.raf = requestAnimationFrame(loop); controlsO.update(); g.tick?.(); renderer.render(scene, camera); };
    loop();
    g.ro = new ResizeObserver(() => {
      const W = stage.clientWidth, H = stage.clientHeight;
      if (!W || !H) return;
      renderer.setSize(W, H); camera.aspect = W / H; camera.updateProjectionMatrix();
    });
    g.ro.observe(stage);
    gl = g;
    return g;
  }

  // free geometry/materials of everything in a group before clearing it
  function disposeGroup(grp) {
    grp.traverse(o => { o.geometry?.dispose(); const m = o.material; if (m) (Array.isArray(m) ? m : [m]).forEach(x => { x.map?.dispose(); x.dispose(); }); });
    grp.clear();
  }

  const baseZ = () => demAt(api.data().dem, api.ctx().center[0], api.ctx().center[1]);
  // map (x,y,z) -> scene (x, z, -y) around the site centre
  const P3 = (x, y, z = 0) => new THREE.Vector3(x - api.ctx().center[0], z - baseZ(), -(y - api.ctx().center[1]));

  function terrain(pal) {
    const ctx = api.ctx(), dem = api.data().dem;
    const [x0, y0, x1, y1] = ctx.extent;
    const nx = dem ? dem.nx : 2, ny = dem ? dem.ny : 2;
    const pos = [], idx = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = x0 + (x1 - x0) * i / (nx - 1), y = y0 + (y1 - y0) * j / (ny - 1);
      const p = P3(x, y, demAt(dem, x, y) - 0.05);
      pos.push(p.x, p.y, p.z);
    }
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: mix(pal.bg, pal.green, pal.dark ? .5 : .25), roughness: 1, side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    return mesh;
  }

  // All buildings become ONE mesh and ONE line-segment object (vertex colours carry the per-building tint).
  function buildings(pal, colourOf = null) {
    const data = api.data(), c0 = api.ctx().center;
    const grp = new THREE.Group();
    const solids = [], edges = [];
    const tint = new THREE.Color();
    for (const b of data.buildings) {
      const shape = new THREE.Shape(b.polygon.map(p => new THREE.Vector2(p[0] - c0[0], p[1] - c0[1])));
      for (const hole of b.holes) shape.holes.push(new THREE.Path(hole.map(p => new THREE.Vector2(p[0] - c0[0], p[1] - c0[1]))));
      let gmin = Infinity, gmax = -Infinity;
      for (const p of b.polygon) { const z = demAt(data.dem, p[0], p[1]); gmin = Math.min(gmin, z); gmax = Math.max(gmax, z); }
      const h = hOf(b);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: h + (gmax - gmin), bevelEnabled: false });
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

  // A texture draped over the terrain grid (vertices follow the DEM, lifted `lift` m).
  function draped(tex, S, lift, opacity = 1) {
    const ctx = api.ctx(), dem = api.data().dem;
    const [x0, y0, x1, y1] = ctx.extent;
    const nx = Math.max(2, dem ? dem.nx : 2), ny = Math.max(2, dem ? dem.ny : 2);
    const pos = [], uv = [], idx = [];
    const W = S.nx * S.step, H = S.ny * S.step;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = x0 + (x1 - x0) * i / (nx - 1), y = y0 + (y1 - y0) * j / (ny - 1);
      const p = P3(x, y, demAt(dem, x, y) + lift);
      pos.push(p.x, p.y, p.z);
      uv.push((x - S.x0) / W, (y - S.y0) / H);
    }
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, b, b, c, d);
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
  function fieldTexture(S, val, col, up = 4) {
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
    const crowns = api.data().trees?.crowns || [];
    if (!crowns.length) return null;
    const geo = new THREE.IcosahedronGeometry(.5, 1);
    const mat = new THREE.MeshStandardMaterial({ color: mix(pal.green, pal.text, pal.dark ? .1 : .25), roughness: 1, flatShading: true });
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
    controls.innerHTML = `<button type="button" data-a1="png">PNG 저장</button><button type="button" data-a1="3dm">3dm 저장</button>`;
    controls.onclick = e => {
      if (e.target.dataset.a1 === "png") savePng();
      else if (e.target.dataset.a1 === "3dm") {   // extruded buildings + terrain mesh (3D_건물 / 3D_지형) with the site outline
        api.exportTab("3dm", { def: { num: "A1", ko: "3D 볼륨", en: "3d-volume" }, sheet: { layers: [], legend: [], notes: ["3D 볼륨: 건물 압출 메시 + 지형 메시. 높이 미상 건물은 3 m."], sources: ["RGE ALTI"] }, volumes: true, name: "a1_volume" }, e.target);
      }
    };
    note.textContent = "BD TOPO 건물 높이 및 IGN 표고(RGE ALTI) 기반 3D 매스 모델입니다. 마우스 드래그로 회전·확대할 수 있습니다. " + SIM;
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
    const k = KEY_DAYS.find(x => x.id === id); return { y: 2026, m: k.m, d: k.d, label: k.label };
  };
  const sunBySurface = new WeakMap();   // Surface -> Map(date -> result): never shared between sites

  function tabA2() {
    const pal = api.pal(), ctx = api.ctx(), data = api.data();
    const g = frame3d(true);
    buildBase(g, pal);
    const R = g.side * .62;
    const sunMarker = new THREE.Mesh(new THREE.SphereGeometry(g.side * .018, 16, 16), new THREE.MeshBasicMaterial({ color: CLIMATE.sun.summer }));
    const pathGroup = new THREE.Group(), overlayGroup = new THREE.Group();
    g.scene.add(sunMarker, pathGroup, overlayGroup);

    const dirOf = s => new THREE.Vector3(Math.sin(s.az) * Math.cos(s.alt), Math.sin(s.alt), -Math.cos(s.az) * Math.cos(s.alt));

    function drawPaths() {
      disposeGroup(pathGroup);
      const cur = dateOf(state.date);
      const days = [...KEY_DAYS.map(k => ({ y: 2026, m: k.m, d: k.d, id: k.id })), ...(state.date === "today" ? [{ ...cur, id: "today" }] : [])];
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
      g.sun.intensity = up ? (pal.dark ? 1.6 : 1.2) * Math.min(1, s.alt / (12 * RAD) + .25) : 0;
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
        if (!res) { res = sunHours(S, ctx.lat, ctx.lon, d.y, d.m, d.d, 30); perSurface.set(key, res); }
        // absolute direct-sun hours, climate colours: 0-2 / 2-4 / 4-6 / 6-8 / 8+ h
        const cols = CLIMATE.sun.hours.map(rgbOf);
        const tex = fieldTexture(S, k => res.hours[k], h => cols[h < 2 ? 0 : h < 4 ? 1 : h < 6 ? 2 : h < 8 ? 3 : 4]);
        overlayGroup.add(draped(tex, S, .25));
        $("a2-overlay-note").textContent = `일조 분석도(${d.label}): 가조시간 ${res.daylight.toFixed(1)}시간 중 직사일조 시간 (5단계 구분, 건물 안 제외).`;
        $("a2-legend").innerHTML = ["0–2", "2–4", "4–6", "6–8", "8 이상"].map((t, i) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px"><i style="width:12px;height:12px;background:${CLIMATE.sun.hours[i]};border:1px solid ${i ? "transparent" : CLIMATE.hoursEdge || CLIMATE.ink};display:inline-block"></i>${t} h</span>`).join("");
      } else {
        // shadows at 09 / 12 / 15 h: one ray-cast mask per hour, drawn as three stacked translucent textures
        [9, 12, 15].forEach((hr, idx) => {
          const s = sunPosition(parisDate(d.y, d.m, d.d, hr), ctx.lat, ctx.lon);
          if (s.alt <= 1 * RAD) return;
          const mask = shadowMask(S, s.az, s.alt);
          const c = rgbOf([CLIMATE.sun.h9, CLIMATE.sun.h12, CLIMATE.sun.h15][idx]);
          const tex = fieldTexture(S, k => S.bld[k] ? NaN : (mask[k] === 1 ? 1 : 0), m => m >= .5 ? [c[0], c[1], c[2], 150] : null);
          const m = draped(tex, S, .25 + idx * .05);
          m.renderOrder = 3 + idx;
          overlayGroup.add(m);
        });
        $("a2-overlay-note").textContent = "시간대별 음영 분석: 09시(청록)·12시(남색)·15시(보라) 지표면 그림자 중첩 (레이트레이싱 연산, 높이 미상 건물은 3 m 기준).";
        $("a2-legend").innerHTML = [["09시", CLIMATE.sun.h9], ["12시", CLIMATE.sun.h12], ["15시", CLIMATE.sun.h15]].map(([t, c]) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px"><i style="width:12px;height:12px;background:${c};opacity:.6;display:inline-block"></i>${t}</span>`).join("");
      }
    }

    controls.innerHTML = `${viewToggle("A2")}
      <span id="a2-dates">${[...KEY_DAYS, { id: "today", label: "오늘" }].map(k => `<button type="button" data-date="${k.id}" aria-pressed="${state.date === k.id}">${k.label}</button>`).join("")}</span>
      <label>시각 <input id="a2-hour" type="range" min="0" max="24" step="0.25" value="${state.hour}"> <output id="a2-hour-out">${fmtHour(state.hour)}</output></label>
      <span id="a2-overlays">${[["none", "음영 단일"], ["hours", "일조 분석"], ["shadows", "시간대별 음영 (9·12·15시)"]].map(([v, t]) => `<button type="button" data-ov="${v}" aria-pressed="${state.overlay === v}">${t}</button>`).join("")}</span>
      <button type="button" data-a2="play">▶ 시뮬레이션 재생</button>
      <button type="button" data-a2="png">PNG 저장</button>
      <span id="a2-info" class="note"></span> <span id="a2-overlay-note" class="note"></span> <div id="a2-legend" class="note"></div>`;
    let playing = null;
    g.stopPlay = () => { if (playing) { clearInterval(playing); playing = null; } };
    controls.onclick = e => {
      const t = e.target;
      if (t.dataset.date) { state.date = t.dataset.date; controls.querySelectorAll("[data-date]").forEach(b => b.setAttribute("aria-pressed", String(b === t))); drawPaths(); setSun(); drawOverlay(); }
      else if (t.dataset.ov) { state.overlay = t.dataset.ov; controls.querySelectorAll("[data-ov]").forEach(b => b.setAttribute("aria-pressed", String(b === t))); drawOverlay(); if (state.overlay === "none") $("a2-overlay-note").textContent = ""; }
      else if (t.dataset.a2 === "png") savePng();
      else if (t.dataset.a2 === "play") {
        if (playing) { clearInterval(playing); playing = null; t.textContent = "▶ 하루 재생"; return; }
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
  function tabA3() {
    const pal = api.pal(), ctx = api.ctx();
    const climate = api.data().climate;
    if (!climate) return missing(api.status("climate") === "loading" ? "기후(EPW) 데이터를 불러오는 중…" : "기후(EPW) 데이터를 불러오지 못했습니다.");
    const { station: st, km } = nearestStation(climate, ctx.lat, ctx.lon);
    const g = frame3d(false);
    g.scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 1.0));
    const dl = new THREE.DirectionalLight(0xffffff, .7); dl.position.set(1, 2, 1); g.scene.add(dl);
    g.scene.add(terrain(pal), buildings(pal), siteOutline(pal));
    const roseGroup = new THREE.Group(); g.scene.add(roseGroup);
    const draw = () => {
      disposeGroup(roseGroup);
      const p = state.season, cells = st.rose[p], total = st.total[p];
      const R = g.side * .3, y = 45;
      const dirTot = cells.map(c => c.slice(1).reduce((a, b) => a + b, 0) / total * 100);
      const scale = R / Math.max(...dirTot);
      for (let d = 0; d < 16; d++) {
        const bins = [cells[d][1], cells[d][2], cells[d][3], cells[d][4], cells[d][5] + cells[d][6]];
        let r0 = 0;
        bins.forEach((n, b) => {
          const r1 = r0 + n / total * 100 * scale;
          if (r1 > r0) {
            const a0 = (d * 22.5 - 9) * RAD, a1 = (d * 22.5 + 9) * RAD, pts = [];
            for (let t = 0; t <= 6; t++) { const a = a0 + (a1 - a0) * t / 6; pts.push(new THREE.Vector2(r1 * Math.sin(a), r1 * Math.cos(a))); }
            for (let t = 6; t >= 0; t--) { const a = a0 + (a1 - a0) * t / 6; pts.push(new THREE.Vector2(r0 * Math.sin(a), r0 * Math.cos(a))); }
            const geo = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: 2, bevelEnabled: false }); geo.rotateX(-Math.PI / 2);
            const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: CLIMATE.wind.bins[b], transparent: true, opacity: .92 }));
            m.position.y = y; roseGroup.add(m);
          }
          r0 = r1;
        });
      }
      const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 65 }, (_, i) => new THREE.Vector3(R * Math.sin(i / 64 * 2 * Math.PI), y, -R * Math.cos(i / 64 * 2 * Math.PI)))), new THREE.LineBasicMaterial({ color: pal.edge }));
      roseGroup.add(ring);
    };
    controls.innerHTML = viewToggle("A3") + PERIODS.map((t, i) => `<button type="button" data-s="${i}" aria-pressed="${state.season === i}">${t}</button>`).join("") + `<button type="button" data-a3="png">PNG 저장</button>` +
      `<div class="note">${CLIMATE.wind.bins.map((c, i) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px"><i style="width:12px;height:12px;background:${c};border:1px solid ${CLIMATE.sub};display:inline-block"></i>${SPEED_LABELS[i]} m/s</span>`).join("")}<span>· 정온(&lt; 0.5 m/s)은 3D 꽃잎에서 제외</span></div>`;
    controls.onclick = e => {
      if (e.target.dataset.s) { state.season = Number(e.target.dataset.s); controls.querySelectorAll("[data-s]").forEach(b => b.setAttribute("aria-pressed", String(b === e.target))); draw(); }
      else if (e.target.dataset.a3) savePng();
    };
    draw();
    badge(`${st.name} · ${km.toFixed(0)} km`);
    note.textContent = (km > 60 ? `⚠ 기상 관측소가 대지에서 약 ${km.toFixed(0)} km 떨어져 있어 신뢰도가 낮을 수 있습니다 (Île-de-France 수록 관측소 기준). ` : "") + `풍배도(바람이 불어오는 방향, 화면 상단 = 북쪽): EPW TMYx 2011–2025, ${st.name} 관측소 데이터 기준입니다. 표준기상년 통계이며 도심 내 기류(건물 풍 효과 등)는 반영되지 않습니다. ${SIM}`;
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
    const ov = new THREE.Group(); g.scene.add(ov);
    function draw() {
      ov.children.forEach(m => { m.material.map?.dispose(); m.geometry.dispose(); m.material.dispose(); });
      ov.clear();
      const S = surfaceOf(ctx, data);
      // UTCI (Brode 2012 polynomial, dgutci.js): shade -> MRT = air temperature; sun -> MRT + SolarCal delta (clear-sky assumption)
      const e = utciEnv({ ctx, data }, state.month, state.utciHour);
      const mask = e.up ? shadowMask(S, e.sp.az, e.sp.alt) : null;
      const catSun = utciCat(e.sun), catShade = utciCat(e.shade);
      const cSun = rgbOf(UTCI_CATS[catSun].hex), cShade = rgbOf(UTCI_CATS[catShade].hex);
      const counts = new Array(10).fill(0); let tot = 0, sunny = 0;
      for (let k = 0; k < S.nx * S.ny; k++) {
        if (S.bld[k]) continue;
        const lit = e.up && mask[k] === 0;
        counts[lit ? catSun : catShade]++; tot++; if (lit) sunny++;
      }
      // `litF` = share of direct sun (0..1), interpolated between cells for drawing only (smooth shade boundary)
      const tex = fieldTexture(S, k => S.bld[k] ? NaN : (e.up && mask[k] === 0 ? 1 : 0), litF => litF >= .5 ? cSun : cShade);
      ov.add(draped(tex, S, .3));
      $("a4-info").textContent = `${utciInfoText(e)} · 양지 ${(sunny / Math.max(1, tot) * 100).toFixed(0)} %`;
      $("a4-legend").innerHTML = UTCI_CATS.map((c, i) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px"><i style="width:12px;height:12px;background:${c.hex};border:1px solid ${c.edge || CLIMATE.sub};display:inline-block"></i>${c.ko} (${UTCI_RANGE[i]} °C)${counts[i] ? ` ${(counts[i] / Math.max(1, tot) * 100).toFixed(0)}%` : ""}</span>`).join("") + `<br>${KO_PLATE["plate.utci.src"]}`;
    }
    controls.innerHTML = `${viewToggle("A4")}<label>월 <select id="a4-month">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}"${state.month === i + 1 ? " selected" : ""}>${i + 1}월</option>`).join("")}</select></label>
      <label>시각 <input id="a4-hour" type="range" min="0" max="23" step="1" value="${state.utciHour}"> <output id="a4-hour-out">${state.utciHour}:00</output></label>
      <button type="button" data-a4="png">PNG 저장</button><span id="a4-info" class="note"></span><div id="a4-legend" class="note"></div>`;
    $("a4-month").addEventListener("change", e => { state.month = Number(e.target.value); draw(); });
    $("a4-hour").addEventListener("input", e => { state.utciHour = Number(e.target.value); $("a4-hour-out").textContent = `${state.utciHour}:00`; draw(); });
    controls.onclick = e => { if (e.target.dataset.a4) savePng(); };
    draw();
    badge("체감 열쾌적성 지표 (UTCI)");
    note.textContent = utciNote(st, stKm);
  }
  const utciNote = (st, stKm) => (stKm > 60 ? `⚠ 기상 관측소 이격 거리 약 ${stKm.toFixed(0)} km (원거리 관측 데이터). ` : "") + `${KO_PLATE["plate.utci.note"]}. 기상: EPW(${st.name}). ${SIM}`;

  // ---- climate plates (A2 / A3 / A4 "도판" view): vector SVG axonometric, see dgclimplate.js ------------------------------
  let shadowDay = SHADOW_DAYS[0].id, shadowHour = 12;
  function plateTab(id) {
    const ctx = api.ctx(), data = api.data();
    if (id !== "A2" && !data.climate) return missing(api.status("climate") === "loading" ? "기후(EPW) 데이터를 불러오는 중…" : "기후(EPW) 데이터를 불러오지 못했습니다.");
    const S = surfaceOf(ctx, data), name = `${id.toLowerCase()}_plate`;
    let cur = null;
    const draw = () => {
      cur = buildPlate(id, { ctx, data, S, month: state.month, hour: state.utciHour, shadowDay, shadowHour });
      stage.innerHTML = `<div class="dg-2d" style="padding:8px">${cur.svg}</div>`;
      if (id === "A4") $("a4-info").textContent = utciInfoText(cur.stats.e);
    };
    const month = id === "A4" ? `<label>월 <select id="a4-month">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}"${state.month === i + 1 ? " selected" : ""}>${i + 1}월</option>`).join("")}</select></label>
      <label>시각 <input id="a4-hour" type="range" min="0" max="23" step="1" value="${state.utciHour}"> <output id="a4-hour-out">${state.utciHour}:00</output></label>` : "";
    const shadow = id === "A2" ? `<label>그림자 날짜 <select id="a2-shadow-day">${SHADOW_DAYS.map(day => `<option value="${day.id}"${day.id === shadowDay ? " selected" : ""}>${day.label}</option>`).join("")}</select></label>
      <label>그림자 시각 <select id="a2-shadow-hour">${SHADOW_HOURS.map(hour => `<option value="${hour}"${hour === shadowHour ? " selected" : ""}>${hour}시</option>`).join("")}</select></label>` : "";
    controls.innerHTML = `${viewToggle(id)}${shadow}${month}<button type="button" data-pl="svg">SVG 저장</button><button type="button" data-pl="png">PNG 저장</button><button type="button" data-pl="pdf">PDF 저장</button><button type="button" data-pl="dxf">DXF 저장</button><button type="button" data-pl="3dm">3dm 저장</button><span id="a4-info" class="note"></span>`;
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
      A2: "도판: 청회색 면은 선택한 날짜와 시각에 건물 그림자를 평평한 지면에 투영한 결과입니다. 실제 지형의 고저차와 수목은 제외합니다. ",
      A3: "도판: 연간 풍배도(대지 바깥 링)와 계절 풍배도. 풍속 색은 구간 값(m/s)이며 광역 통계로 국소 CFD가 아닙니다. ",
      A4: `도판: ${KO_PLATE["plate.utci.note"]}. `
    };
    note.textContent = notes[id] + SIM;
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
    const ctx = api.ctx(), data = api.data(), pal = api.pal();
    profile = null;
    const [x0, y0, x1, y1] = ctx.extent, S = Math.max(x1 - x0, y1 - y0);
    const VW = (x1 - x0) / S * 1000, VH = (y1 - y0) / S * 1000;
    // map above, profile full width below: a site section is a long flat strip and was
    // squeezed into a ~200 px column beside the map
    stage.innerHTML = `<div class="dg-2d" style="display:grid;grid-template-columns:1fr;gap:8px;padding:8px;justify-items:center"><div id="a5-map" style="cursor:crosshair;width:min(100%,520px)"></div><div id="a5-profile" style="width:100%"></div></div>`;
    const mapDiv = $("a5-map"), profDiv = $("a5-profile");
    const tx = x => (x - x0) / S * 1000, ty = y => (y1 - y) / S * 1000;
    const path = (rings, close = true) => rings.map(r => r.map((p, i) => (i ? "L" : "M") + tx(p[0]).toFixed(1) + " " + ty(p[1]).toFixed(1)).join("") + (close ? "Z" : "")).join("");
    const base = `<rect width="${VW}" height="${VH}" fill="${pal.bg}"/><path d="${data.buildings.map(b => path([b.polygon, ...b.holes])).join("")}" fill="${pal.building}" stroke="${pal.buildingLine}" stroke-width=".6" fill-rule="evenodd"/>` +
      `<path d="${path([ctx.site.ring])}" fill="none" stroke="${pal.siteLine}" stroke-width="3"/>`;
    function drawMap() {
      let ov = "";
      if (section.a) ov += `<circle cx="${tx(section.a[0])}" cy="${ty(section.a[1])}" r="8" fill="${pal.siteLine}"/>`;
      if (section.a && section.b) ov += `<line x1="${tx(section.a[0])}" y1="${ty(section.a[1])}" x2="${tx(section.b[0])}" y2="${ty(section.b[1])}" stroke="${pal.siteLine}" stroke-width="4"/><circle cx="${tx(section.b[0])}" cy="${ty(section.b[1])}" r="8" fill="${pal.siteLine}"/>`;
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
          const roofZ = gz((t0 + t1) / 2) + h;
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
      profDiv.innerHTML = `<svg id="a5-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;background:#fff" font-family="Noto Sans, Noto Sans KR, sans-serif">
        <rect width="${W}" height="${H}" fill="${pal.bg}"/>
        <path d="${blds.map(r => pl(r, true)).join("")}" fill="${pal.building}" stroke="${pal.buildingLine}" stroke-width="1" stroke-linejoin="round"/>
        <path d="${pl(ground)}" fill="none" stroke="${pal.text}" stroke-width="2"/>
        <text x="40" y="26" font-size="16" fill="${pal.text}">단면 A–B · 길이 ${L.toFixed(0)} m · 표고 ${Math.min(...gzs).toFixed(1)}–${(zmax - 3).toFixed(1)} m · 건물 ${blds.length}</text>
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
      `<button type="button" data-a5="svg">단면 SVG 저장</button>` +
      ["pdf", "dxf", "3dm"].map(k => `<button type="button" data-a5="${k}">${k === "pdf" ? "PDF" : k === "dxf" ? "DXF" : "3dm"} 저장</button>`).join("");
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
      return `<svg id="a6-svg" xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(" ")}" style="width:100%;height:100%;touch-action:none;cursor:grab">${s}</svg>`;
    }
    stage.innerHTML = `<div class="dg-2d" id="a6-wrap" style="padding:0;overflow:hidden">${svg()}</div>`;
    const wrap = $("a6-wrap");
    const apply = () => { wrap.querySelector("svg").setAttribute("viewBox", vb.join(" ")); };
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
      `<button type="button" data-a6="fit">전체 보기</button><button type="button" data-a6="svg">SVG 저장</button>`;
    controls.onchange = e => { if (e.target.dataset.l) { on[e.target.dataset.l] = e.target.checked; wrap.innerHTML = svg(); } };
    controls.onclick = e => {
      if (e.target.dataset.a6 === "fit") { vb = [0, 0, VW, VH]; apply(); }
      if (e.target.dataset.a6 === "svg") api.download(new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + wrap.innerHTML], { type: "image/svg+xml" }), "a6_context.svg");
    };
    note.textContent = "마우스 휠로 확대/축소, 드래그로 이동할 수 있습니다. 활성화된 레이어는 앞서 조회된 IGN·OSM 데이터입니다.";
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
        preview.innerHTML = `<p class="note" style="padding:24px">중첩할 도판 레이어를 선택해 주세요.</p>`; return;
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
      const def = { num: "A7", ko: "도판 오버레이", fr: "도판 합치기", en: "merged " + chosen.map(d => d.num).join("+") };
      preview.innerHTML = renderSvg(def, merged, api.ctx(), { prefix: "a7-", pal: api.pal() });
      state.mergedDef = def;
    };
    stage.innerHTML = `<div class="dg-2d" id="a7-preview" style="padding:8px"></div>`;
    controls.innerHTML = defs.map(d => `<label><input type="checkbox" data-m="${d.num}" ${state.merge.has(d.num) ? "checked" : ""}> ${d.num} ${d.ko}</label>`).join("") +
      `<button type="button" data-a7="svg">SVG 저장</button><button type="button" data-a7="png">PNG 저장</button><button type="button" data-a7="pdf">PDF 저장</button><button type="button" data-a7="dxf">DXF 저장</button><button type="button" data-a7="3dm">3dm 저장</button>`;
    controls.onchange = e => { if (e.target.dataset.m) { e.target.checked ? state.merge.add(e.target.dataset.m) : state.merge.delete(e.target.dataset.m); draw(); } };
    controls.onclick = async e => {
      const k = e.target.dataset.a7;
      if (!k || !state.mergedSheet) return;
      if (k === "pdf" || k === "dxf" || k === "3dm") api.exportTab(k, { def: state.mergedDef, sheet: state.mergedSheet, name: "a7_merged" }, e.target);
      else if (k === "svg") api.download(new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + renderSvg(state.mergedDef, state.mergedSheet, api.ctx(), { absoluteSize: true, pal: api.pal() })], { type: "image/svg+xml" }), "a7_merged.svg");
      else api.download(await api.png(state.mergedDef, state.mergedSheet), "a7_merged.png");
    };
    draw();
    note.textContent = "선택한 도판 레이어들을 한 도면에 중첩합니다 (주변 건물 레이어는 1회만 반영). 레이어명은 [도판 번호_원래 레이어명]으로 구분되며 범례는 최대 26행까지 표시됩니다.";
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
      const col = state.axoMode === "height" ? seqOf(pal)[hcls(h)] : state.axoMode === "site" ? (inSite(b) ? pal.site : pal.building) : pal.building;
      const ring = b.polygon;
      const roof = ring.map(p => proj(p[0], p[1], base + h));
      const walls = [];
      const addWalls = (r, inward) => {
        const sg = (signedArea(r) > 0 ? 1 : -1) * (inward ? -1 : 1);
        for (let i = 0; i < r.length; i++) {
          const p = r[i], c = r[(i + 1) % r.length];
          const A = proj(p[0], p[1], base), B = proj(c[0], c[1], base), C = proj(c[0], c[1], base + h), D = proj(p[0], p[1], base + h);
          const nx = (c[1] - p[1]) * sg, ny = -(c[0] - p[0]) * sg; // solid-outward normal
          const nu = nx * Math.cos(th) - ny * Math.sin(th), nv = nx * Math.sin(th) + ny * Math.cos(th);
          if (nv > 0) continue; // faces away from the viewer
          walls.push({ pts: [A, B, C, D], shade: .1 + .25 * (nu < 0 ? 1 : 0) + .1 * Math.abs(nv) / (Math.hypot(nu, nv) || 1) });
        }
      };
      addWalls(ring, false);
      for (const hole of b.holes) addWalls(hole, true); // courtyard walls
      const holeRoofs = b.holes.map(hr => hr.map(p => proj(p[0], p[1], base + h)));
      const vc = roof.reduce((a, p) => a + p[2], 0) / roof.length;
      items.push({ roof, holeRoofs, walls, col, depth: vc, base });
    }
    items.sort((a, b) => b.depth - a.depth);
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    const grow = p => { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); };
    const [x0, y0, x1, y1] = ctx.extent;
    const plate = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(p => proj(p[0], p[1], 0));
    plate.forEach(grow);
    items.forEach(i => { i.roof.forEach(grow); i.walls.forEach(w => w.pts.forEach(grow)); });
    axoGeom = { items, plate, site: ctx.site.ring.map(p => proj(p[0], p[1], 0)), mode: state.axoMode, az: state.axoAz, el: state.axoEl };
    const pad = (maxx - minx) * .04, W = maxx - minx + pad * 2, H = maxy - miny + pad * 2 + 60;
    const f = n => n.toFixed(1);
    const P = p => `${f(p[0] - minx + pad)} ${f(p[1] - miny + pad + 40)}`;
    const poly = pts => "M" + pts.map(P).join("L") + "Z";
    const lw = Math.max(.35, W / 1600);
    let out = `<rect width="${f(W)}" height="${f(H)}" fill="${pal.bg}"/>`;
    out += `<path d="${poly(plate)}" fill="none" stroke="${pal.edge}" stroke-width="${f(lw)}" stroke-dasharray="${f(lw * 4)} ${f(lw * 3)}"/>`;
    const sitePts = ctx.site.ring.map(p => proj(p[0], p[1], 0));
    const sxs = ctx.site.ring.map(p => p[0]), sys = ctx.site.ring.map(p => p[1]);
    const smallSite = Math.max(Math.max(...sxs) - Math.min(...sxs), Math.max(...sys) - Math.min(...sys)) < (x1 - x0) / 3;
    out += `<path d="${poly(sitePts)}" fill="${smallSite ? pal.site : "none"}" fill-opacity=".25" stroke="${pal.siteLine}" stroke-width="${f(lw * (smallSite ? 2.2 : 1.2))}" stroke-linejoin="round"${smallSite ? "" : ` stroke-dasharray="${f(lw * 5)} ${f(lw * 3)}"`}/>`;
    for (const it of items) {
      for (const w of it.walls) out += `<path d="${poly(w.pts)}" fill="${mix(it.col, pal.dark ? "#ffffff" : "#000000", pal.dark ? w.shade * .5 : w.shade)}" stroke="${pal.buildingLine}" stroke-width="${f(lw * .6)}" stroke-linejoin="round"/>`;
      out += `<path d="${[it.roof, ...it.holeRoofs].map(poly).join("")}" fill-rule="evenodd" fill="${mix(it.col, pal.dark ? "#000000" : "#ffffff", .25)}" stroke="${pal.buildingLine}" stroke-width="${f(lw * .6)}" stroke-linejoin="round"/>`;
    }
    const titleSize = Math.max(14, W / 55);
    const mode = { site: "대지 건물 강조", height: "높이 5단계", plain: "단색" }[state.axoMode];
    out += `<text x="${f(pad)}" y="${f(pad + titleSize)}" font-size="${f(titleSize)}" font-weight="600" fill="${pal.text}">액소노메트릭 도면 · ${esc(ctx.address)}</text>` +
      `<text x="${f(pad)}" y="${f(pad + titleSize * 2)}" font-size="${f(titleSize * .62)}" fill="${pal.text}">${mode} · 방위각 ${state.axoAz}° · 고도각 ${state.axoEl}° · Not to Scale(축측 투영) · 참고용 시뮬레이션 · © IGN BD TOPO, RGE ALTI</text>`;
    if (state.axoMode === "height") {
      ["6 m 미만", "6–12", "12–18", "18–30", "30 m 이상"].forEach((t, i) => {
        out += `<rect x="${f(pad + i * titleSize * 4.2)}" y="${f(H - titleSize * 1.4)}" width="${f(titleSize * .9)}" height="${f(titleSize * .9)}" fill="${pal.seq5[i]}" stroke="${pal.buildingLine}" stroke-width="${f(lw * .6)}"/><text x="${f(pad + i * titleSize * 4.2 + titleSize * 1.1)}" y="${f(H - titleSize * .65)}" font-size="${f(titleSize * .62)}" fill="${pal.text}">${t}</text>`;
      });
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
    const draw = () => { stage.innerHTML = `<div class="dg-2d" style="padding:8px">${axoSvg()}</div>`; };
    controls.innerHTML = `<span>방위 ${[45, 135, 225, 315].map(a => `<button type="button" data-az="${a}" aria-pressed="${state.axoAz === a}">${a}°</button>`).join("")}</span>
      <span>고도 ${[30, 45, 60].map(a => `<button type="button" data-el="${a}" aria-pressed="${state.axoEl === a}">${a}°</button>`).join("")}</span>
      <span>표현 ${[["site", "대지 강조"], ["height", "높이 단계"], ["plain", "단색"]].filter(([v]) => v !== "site" || siteIsSmallNow()).map(([v, t]) => `<button type="button" data-mode="${v}" aria-pressed="${state.axoMode === v}">${t}</button>`).join("")}</span>
      <button type="button" data-a8="svg">SVG 저장</button><button type="button" data-a8="png">PNG 저장</button><button type="button" data-a8="pdf">PDF 저장</button><button type="button" data-a8="dxf">DXF 저장</button><button type="button" data-a8="3dm">3dm 저장</button>`;
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
    note.textContent = "벡터 기반 액소노메트릭(축측 투영) 도면입니다. [대지 강조 / 높이 5단계 / 단색 매스] 중 프리젠테이션 목적에 맞는 표현 방식을 선택해 주세요. " + SIM;
  }

  function missing(msg) { stage.innerHTML = `<div class="dg-2d"><p class="note">${msg}</p></div>`; }

  // ---- routing ---------------------------------------------------------------------------------------------------
  function show(id) {
    active = id;
    bar.querySelectorAll("[data-tab]").forEach(b => { b.setAttribute("aria-selected", String(b.dataset.tab === id)); b.tabIndex = b.dataset.tab === id ? 0 : -1; });
    stage.setAttribute("aria-label", TABS.find(t => t[0] === id)?.[1] || id);
    clearStage();
    if (!ready()) return missing("도판 생성 단계에서 건물 데이터를 먼저 조회해 주세요.");
    try {
      if (state.view[id] === "plate") plateTab(id);
      else ({ A1: tabA1, A2: tabA2, A3: tabA3, A4: tabA4, A5: tabA5, A6: tabA6, A7: tabA7, A8: tabA8 })[id]();
    } catch (e) { console.error(e); missing("분석 다이어그램을 생성하지 못했습니다: " + e.message); }
  }

  return { show: () => show(active), refresh: () => show(active), stop: () => { gl?.stopPlay?.(); clearStage(); } };
}
