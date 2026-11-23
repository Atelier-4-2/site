// A9 line-drawing axonometric (선화 액소) for the Terrain site-analysis 3D view.
// Idea (own implementation): render normal / object-id / depth buffers, derive the drawing from them in one
// full-screen pass: outline (heavy) > crease (medium) > ground / water boundaries (hair), thinner with distance.
// Faces are white or flat tones (roof / wall / ground), sun shadows come from the three.js shadow map and are
// flattened to a light grey. Camera presets (isometric / plan oblique / perspective), exploded layers and a
// short intro move are driven from here. Data comes from dgtabs_v05.js (tabA9), which builds `parts`.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const RAD = Math.PI / 180;
const FR = () => document.documentElement.lang === "fr";
const TXT = {
  mode: ["표시", "Rendu"], mLine: ["선화", "Trait"], mFlat: ["선화 + 면색", "Trait + aplats"], mFill: ["면만", "Aplats"],
  cam: ["카메라", "Caméra"], cIso: ["등각 액소", "Axo isométrique"], cObl: ["평면 사선", "Plan oblique"], cPersp: ["원근", "Perspective"],
  sun: ["그림자", "Ombres"], on: ["켜기", "Activer"], hour: ["시각", "Heure"],
  explode: ["분해 보기", "Vue éclatée"], replay: ["▶ 다시 보기", "▶ Revoir"], intro: ["소개 동작", "Intro animée"],
  png: ["PNG", "PNG"], save: ["저장", "Enregistrer"],
  sunUp: ["고도 {alt}° · 방위 {az}°", "hauteur {alt}° · azimut {az}°"], sunDown: ["일몰 후 (그림자 없음)", "soleil couché (pas d’ombres)"],
  explodedNote: ["분해 보기에서는 그림자를 끕니다.", "Ombres désactivées en vue éclatée."],
  layers: ["위: 대상 대지 건물 · 중간: 기존 건물 · 아래: 땅", "Haut : bâti du site · milieu : bâti existant · bas : sol"],
  layers2: ["위: 건물 · 아래: 땅", "Haut : bâti · bas : sol"],
  est: ["높이 미상 건물 {n}동은 3 m로 추정해 연한 색으로 표시합니다.", "{n} bâtiment(s) sans hauteur connue : 3 m estimés, teinte claire."],
  src: ["건물 BD TOPO · 표고 RGE ALTI · © IGN", "Bâti BD TOPO · altitudes RGE ALTI · © IGN"],
  sim: ["참고용 시뮬레이션 · 법적 효력 없음", "Simulation indicative · sans valeur juridique"],
  hint: ["드래그로 회전, 휠·핀치로 확대. 화면을 만지면 소개 동작이 멈춥니다.", "Glisser pour tourner, molette ou pincer pour zoomer. Toucher l’écran arrête l’intro."],
  dates: { winter: ["동지 12/21", "Solstice d’hiver 21/12"], equinox: ["춘분 3/20", "Équinoxe 20/3"], autumn: ["추분 9/23", "Équinoxe 23/9"], summer: ["하지 6/21", "Solstice d’été 21/6"], today: ["오늘", "Aujourd’hui"] }
};
const tr = k => TXT[k][FR() ? 1 : 0];
const fmtHour = h => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const INTRO_KEY = "a42.axo.intro";
let introSeen = false;
const keep = { mode: 1, shadow: false, explode: false, preset: "iso" };   // survives the tab rebuild when late data layers arrive                       // the intro plays once per page load, the first time A9 opens
const readIntroPref = () => {
  try { const v = localStorage.getItem(INTRO_KEY); if (v === "on" || v === "off") return v === "on"; } catch { /* private mode */ }
  return !matchMedia("(prefers-reduced-motion: reduce)").matches;   // reduced motion: off by default
};
const writeIntroPref = on => { try { localStorage.setItem(INTRO_KEY, on ? "on" : "off"); } catch { /* ignore */ } };

const VERT_QUAD = "varying vec2 vUv; void main(){ vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, 0., 1.); }";
const NORMAL_FS = "varying vec3 vN; void main(){ vec3 n = normalize(vN); if(!gl_FrontFacing) n = -n; gl_FragColor = vec4(n * .5 + .5, 1.); }";
const NORMAL_VS = "varying vec3 vN; void main(){ vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }";
const ID_VS = "attribute float aid; attribute float acls; varying float vId; varying float vCls; void main(){ vId = aid; vCls = acls; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }";
const ID_FS = "varying float vId; varying float vCls; void main(){ float i = floor(vId + .5), c = floor(vCls + .5); gl_FragColor = vec4(mod(i, 256.) / 255., floor(i / 256.) / 255., c / 255., 1.); }";

const COMPOSITE_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tN, tI, tD, tS, tL;
uniform vec2 uPx;
uniform float uPxScale, uOrtho, uNear, uFar, uZn, uZf, uSunUp, uShadowOn, uMode, uLines;
uniform vec3 uSun;
uniform vec3 cInk, cHair, cGround, cWater, cRoof, cWall, cAccent, cWhite;

float lin(float d){
  if (uOrtho > .5) return uNear + d * (uFar - uNear);
  float z = d * 2. - 1.;
  return 2. * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}
vec2 key(vec2 uv){ vec4 c = texture2D(tI, uv); return vec2(floor(c.r * 255. + .5) + 256. * floor(c.g * 255. + .5), floor(c.b * 255. + .5)); }
bool isB(float c){ return (c > .5 && c < 1.5) || (c > 2.5 && c < 4.5); }
bool isBg(float c){ return c > 250.; }
vec3 nrm(vec2 uv){ return texture2D(tN, uv).xyz * 2. - 1.; }

// returns (contour, crease, hair) for one pair of samples
vec3 pairTest(vec2 a, vec2 b){
  vec2 ka = key(a), kb = key(b);
  if (ka != kb) {
    bool anyB = isB(ka.y) || isB(kb.y);
    bool oneBg = isBg(ka.y) != isBg(kb.y);
    if (anyB || oneBg) return vec3(1., 0., 0.);
    return vec3(0., 0., 1.);
  }
  if (isB(ka.y) && dot(nrm(a), nrm(b)) < .9) return vec3(0., 1., 0.);
  return vec3(0.);
}
vec3 edgeAt(vec2 uv, float r){
  vec2 dx = vec2(r * uPx.x, 0.), dy = vec2(0., r * uPx.y);
  return max(pairTest(uv + dx, uv - dx), pairTest(uv + dy, uv - dy));
}

void main(){
  vec2 uv = vUv;
  vec2 k0 = key(uv);
  float cls = k0.y;
  vec3 n = nrm(uv);
  float z = lin(texture2D(tD, uv).x);
  float fade = mix(1., .5, smoothstep(uZn, uZf, z));        // lines get thinner with distance

  // ---- faces
  vec3 col;
  bool bg = isBg(cls);
  if (bg) col = cWhite;
  else if (cls < .5) col = cGround;
  else if (cls < 1.5 && cls > .5) { col = n.y > .75 ? cRoof : cWall; }
  else if (cls > 1.5 && cls < 2.5) col = cWater;
  else if (cls > 2.5 && cls < 3.5) col = n.y > .75 ? cAccent : cAccent * .9;     // target buildings
  else col = n.y > .75 ? cWhite : mix(cWall, cWhite, .55);                         // unknown height: light
  if (uMode < .5) {                                         // white faces (pure line drawing)
    col = (cls > 2.5 && cls < 3.5) ? (n.y > .75 ? cAccent : cAccent * .9) : cWhite;     // the target keeps the one accent
  }
  if (!bg) {
    float ndl = dot(n, uSun);
    float sh = uShadowOn > .5 ? smoothstep(.3, .7, texture2D(tS, uv).a) : 0.;
    if (uSunUp > .5 && n.y < .75 && ndl <= .02) col *= (uMode < .5 ? .93 : .9);    // walls turned away
    col = mix(col, col * vec3(.82, .83, .86), sh);                                  // flat light grey shadow
  }

  // ---- lines
  if (uLines > .5) {
    float s = uPxScale * fade;
    float contour = edgeAt(uv, 1.2 * s).x;
    float crease = edgeAt(uv, .55 * s).y;
    float hair = edgeAt(uv, .4 * s).z;
    col = mix(col, cHair, hair);
    col = mix(col, cInk, max(contour, crease));
    // thin drawn lines (site / parcels / road edges): drawn in their own pass, dilated by ~1 px
    float r = .5 * uPxScale;
    vec4 l = texture2D(tL, uv);
    vec4 l1 = texture2D(tL, uv + vec2(r * uPx.x, 0.)), l2 = texture2D(tL, uv - vec2(r * uPx.x, 0.));
    vec4 l3 = texture2D(tL, uv + vec2(0., r * uPx.y)), l4 = texture2D(tL, uv - vec2(0., r * uPx.y));
    float a = max(max(max(l.a, l1.a), max(l2.a, l3.a)), l4.a);
    vec3 lc = l.a > .5 ? l.rgb : l1.a > .5 ? l1.rgb : l2.a > .5 ? l2.rgb : l3.a > .5 ? l3.rgb : l4.rgb;
    col = mix(col, lc, a);
  }
  gl_FragColor = vec4(col, 1.);
}`;
const BLIT_FS = "varying vec2 vUv; uniform sampler2D tO; void main(){ gl_FragColor = vec4(texture2D(tO, vUv).rgb, 1.); }";

const PRESETS = {
  iso:   { az: 45, el: 35.264, ortho: true,  shear: false },
  obl:   { az: 0,  el: 89.4,   ortho: true,  shear: true  },
  persp: { az: 32, el: 30,     ortho: false, shear: false }
};

/**
 * @param {object} o  { stage, controls, note, parts, side, dates, sunAt, state, download, sunCap }
 * parts: { ground: BufferGeometry, water: BufferGeometry|null, bldgs: [{geo, known, target}],
 *          lines: { site, parcels, roads: Float32Array (segment pairs) }, hasTarget }
 */
export function createAxoView(o) {
  const { stage, controls, note, parts, side, state } = o;
  const w0 = stage.clientWidth || 800, h0 = stage.clientHeight || 500;
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setClearColor(0xffffff, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  stage.append(renderer.domElement);

  // ---- layers: ground / existing buildings / target buildings ------------------------------------------------
  const scene = new THREE.Scene(), lineScene = new THREE.Scene();
  const layer = { ground: [], bld: [], tgt: [] };                       // objects that move with the layer (both scenes)
  const depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const mk = (geo, name, cast, recv) => {
    const m = new THREE.Mesh(geo, depthMat);                              // real materials come from overrideMaterial
    m.castShadow = cast; m.receiveShadow = recv; m.userData.layer = name;
    scene.add(m);
    const occ = new THREE.Mesh(geo, depthMat);                            // occluder for the line pass
    lineScene.add(occ);
    layer[name].push(m, occ);
    return m;
  };
  const setAttrs = (geo, id, cls) => {
    const n = geo.attributes.position.count;
    geo.setAttribute("aid", new THREE.Float32BufferAttribute(new Float32Array(n).fill(id), 1));
    geo.setAttribute("acls", new THREE.Float32BufferAttribute(new Float32Array(n).fill(cls), 1));
    for (const a of ["uv", "color"]) if (geo.attributes[a]) geo.deleteAttribute(a);
    if (!geo.attributes.normal) geo.computeVertexNormals();
  };
  const own = [];
  const addGeo = g => { own.push(g); return g; };
  {
    const g = parts.ground.clone(); setAttrs(g, 1, 0); addGeo(g); mk(g, "ground", false, true);
    if (parts.water) { const w = parts.water.clone(); setAttrs(w, 2, 2); addGeo(w); mk(w, "ground", false, true); }
    const ex = [], tg = [];
    parts.bldgs.forEach((b, i) => {
      const g2 = b.geo; setAttrs(g2, 3 + i, b.target ? 3 : b.known ? 1 : 4);
      (b.target ? tg : ex).push(g2);
    });
    if (ex.length) mk(addGeo(mergeGeometries(ex, false)), "bld", true, true);
    if (tg.length) mk(addGeo(mergeGeometries(tg, false)), "tgt", true, true);
    ex.concat(tg).forEach(g2 => g2.dispose());
  }
  // drawn lines (site / parcels / roads) live in the line scene only
  const lineObjs = [];
  const addLines = (arr, color, layerName) => {
    if (!arr || !arr.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: new THREE.Color().setRGB(...hex(color), THREE.LinearSRGBColorSpace) }));
    lineScene.add(l); layer[layerName].push(l); lineObjs.push(l);
  };
  addLines(parts.lines.parcels, "#8a8a84", "ground");
  addLines(parts.lines.roads, "#8a8a84", "ground");
  addLines(parts.lines.site, "#1e1e1c", "ground");

  // guide verticals for the exploded view (unit height, scaled with the lift)
  const half = side / 2;
  const guideGeo = new THREE.BufferGeometry();
  const gp = [];
  for (const [x, z] of [[-half, -half], [half, -half], [half, half], [-half, half]]) gp.push(x, 0, z, x, 1, z);
  guideGeo.setAttribute("position", new THREE.Float32BufferAttribute(gp, 3));
  const guides = new THREE.LineSegments(guideGeo, new THREE.LineBasicMaterial({ color: new THREE.Color().setRGB(...hex("#8a8a84"), THREE.LinearSRGBColorSpace) }));
  guides.visible = false; lineScene.add(guides);

  // ---- light (shadow map only; the drawing's own shading is computed in the composite pass) ------------------
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  scene.add(sun, sun.target);
  const sh = sun.shadow;
  sh.mapSize.set(innerWidth < 800 ? 2048 : 4096, innerWidth < 800 ? 2048 : 4096);
  sh.bias = -0.0004; sh.normalBias = .4;

  // ---- materials / targets ------------------------------------------------------------------------------------
  const matN = new THREE.ShaderMaterial({ vertexShader: NORMAL_VS, fragmentShader: NORMAL_FS, side: THREE.DoubleSide });
  const matI = new THREE.ShaderMaterial({ vertexShader: ID_VS, fragmentShader: ID_FS, side: THREE.DoubleSide });
  const matS = new THREE.ShadowMaterial(); matS.transparent = false; matS.blending = THREE.NoBlending; matS.opacity = 1; matS.side = THREE.DoubleSide;
  const mkRT = (w, h, depth) => {
    const rt = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    if (depth) { rt.depthTexture = new THREE.DepthTexture(w, h); rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.NearestFilter; }
    return rt;
  };
  let rtN, rtI, rtS, rtL, rtO, RW = 1, RH = 1, css = [1, 1], pxScale = 1;
  const disposeRT = () => { for (const r of [rtN, rtI, rtS, rtL, rtO]) { r?.depthTexture?.dispose(); r?.dispose(); } };
  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const col = k => new THREE.Vector3(...hex(k));
  const uni = {
    tN: { value: null }, tI: { value: null }, tD: { value: null }, tS: { value: null }, tL: { value: null },
    uPx: { value: new THREE.Vector2() }, uPxScale: { value: 1 }, uOrtho: { value: 1 }, uNear: { value: 1 }, uFar: { value: 100 },
    uZn: { value: 0 }, uZf: { value: 1 }, uSunUp: { value: 1 }, uShadowOn: { value: 0 }, uMode: { value: 1 }, uLines: { value: 1 },
    uSun: { value: new THREE.Vector3(0, 1, 0) },
    cInk: { value: col("#1e1e1c") }, cHair: { value: col("#8a8a84") }, cGround: { value: col("#ebe8df") },
    cWater: { value: col("#e3e8ea") }, cRoof: { value: col("#faf8f3") }, cWall: { value: col("#d2cdbf") },
    cAccent: { value: col("#E6B89C") }, cWhite: { value: col("#ffffff") }
  };
  const matC = new THREE.ShaderMaterial({ vertexShader: VERT_QUAD, fragmentShader: COMPOSITE_FS, uniforms: uni, depthTest: false, depthWrite: false });
  const blitU = { tO: { value: null } };
  const matB = new THREE.ShaderMaterial({ vertexShader: VERT_QUAD, fragmentShader: BLIT_FS, uniforms: blitU, depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(quadGeo, matC); quad.frustumCulled = false;
  const quadScene = new THREE.Scene(); quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // ---- cameras -----------------------------------------------------------------------------------------------
  const persp = new THREE.PerspectiveCamera(32, w0 / h0, .5, side * 40);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, .5, side * 40);
  const shearK = .42;
  ortho.userData.shear = false;
  const baseUpdate = THREE.OrthographicCamera.prototype.updateProjectionMatrix;
  ortho.updateProjectionMatrix = function () {                           // plan oblique = shear of the ortho projection
    baseUpdate.call(this);
    if (this.userData.shear) {
      const d = this.userData.dist || 1, k = shearK;
      const S = new THREE.Matrix4().set(1, 0, k, k * d, 0, 1, k, k * d, 0, 0, 1, 0, 0, 0, 0, 1);
      this.projectionMatrix.multiply(S);
      this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
    }
  };
  let cam = ortho;
  const target = new THREE.Vector3(), tweenDist = { v: 1 };
  const controlsO = new OrbitControls(cam, renderer.domElement);
  controlsO.enableDamping = false; controlsO.maxPolarAngle = Math.PI * .5;
  controlsO.addEventListener("change", () => request());

  let preset = keep.preset, R = side, aspect = w0 / h0, pose = { az: PRESETS[keep.preset].az, el: PRESETS[keep.preset].el };
  let lift = 0, shadowDirty = true, raf = 0, anim = null, disposed = false;
  function bounds() { return new THREE.Box3().setFromObject(scene); }
  function fitFrustum() {
    const box = bounds();
    const sph = box.getBoundingSphere(new THREE.Sphere());
    R = sph.radius; target.copy(sph.center);
    const pr = PRESETS[preset];
    const asp = Math.min(1, aspect);
    const dist = pr.ortho ? R * 3 : R * 1.1 / Math.sin(Math.atan(Math.tan(persp.fov * RAD / 2) * asp));
    tweenDist.v = dist;
    if (pr.ortho) {
      const halfH = R * (pr.shear ? 1.0 : 0.92) / asp;
      ortho.left = -halfH * aspect; ortho.right = halfH * aspect; ortho.top = halfH; ortho.bottom = -halfH;
      ortho.near = .5; ortho.far = dist + R * 6;
      ortho.userData.dist = dist; ortho.userData.shear = pr.shear;
      ortho.zoom = 1;
      ortho.updateProjectionMatrix();
    } else {
      persp.aspect = aspect; persp.near = Math.max(.5, dist - R * 1.2); persp.far = dist + R * 6;
      persp.updateProjectionMatrix();
    }
    uni.uZn.value = dist - R; uni.uZf.value = dist + R;
    // the shadow camera covers the whole model
    const sc = sh.camera;
    Object.assign(sc, { left: -R, right: R, top: R, bottom: -R, near: .5, far: R * 6 });
    sc.updateProjectionMatrix();
    shadowDirty = true;
  }
  function setPose(az, el, dist = tweenDist.v) {
    pose = { az, el };
    const a = az * RAD, e = el * RAD;
    cam.position.set(target.x + dist * Math.sin(a) * Math.cos(e), target.y + dist * Math.sin(e), target.z + dist * Math.cos(a) * Math.cos(e));
    cam.up.set(0, 1, 0);
    cam.lookAt(target);
    controlsO.target.copy(target);
    controlsO.update();
  }
  function usePreset(name, animate = true) {
    stopAnim();
    const from = { az: pose.az, el: pose.el }, fromOrtho = cam === ortho;
    preset = name;
    const pr = PRESETS[name];
    const newCam = pr.ortho ? ortho : persp;
    const sameKind = fromOrtho === pr.ortho;
    if (newCam !== cam) { cam = newCam; controlsO.object = cam; }
    fitFrustum();
    if (!animate || !sameKind) { setPose(pr.az, pr.el); request(); return; }
    // shear changes the projection: switch it at the start, the angle tween does the rest
    runAnim(650, t => {
      const e = t * t * (3 - 2 * t);
      setPose(from.az + (pr.az - from.az) * e, from.el + (pr.el - from.el) * e);
    });
  }

  // ---- render ------------------------------------------------------------------------------------------------
  function sizeTargets(scale = 1) {
    css = [Math.max(1, stage.clientWidth), Math.max(1, stage.clientHeight)];
    const pr = Math.min(devicePixelRatio || 1, 2) * scale;
    const ss = pr >= 2 ? 1 : (css[0] * pr * 2 <= 2600 ? 2 : 1.5);             // supersample to smooth the 1-pixel decisions
    RW = Math.round(css[0] * pr * ss); RH = Math.round(css[1] * pr * ss);
    pxScale = RW / css[0];
    renderer.setPixelRatio(pr); renderer.setSize(css[0], css[1], false);
    disposeRT();
    rtN = mkRT(RW, RH, true); rtI = mkRT(RW, RH, false); rtS = mkRT(RW, RH, false); rtL = mkRT(RW, RH, false);
    rtO = new THREE.WebGLRenderTarget(RW, RH, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    uni.uPx.value.set(1 / RW, 1 / RH); uni.uPxScale.value = pxScale;
    uni.tN.value = rtN.texture; uni.tD.value = rtN.depthTexture; uni.tI.value = rtI.texture; uni.tS.value = rtS.texture; uni.tL.value = rtL.texture;
    blitU.tO.value = rtO.texture;
    aspect = css[0] / css[1];
  }
  const renderPass = (rt, scn, over, clearRGBA) => {
    renderer.setRenderTarget(rt);
    renderer.setClearColor(new THREE.Color(clearRGBA[0], clearRGBA[1], clearRGBA[2]), clearRGBA[3]);
    renderer.clear(true, true, true);
    scn.overrideMaterial = over;
    renderer.render(scn, cam);
    scn.overrideMaterial = null;
  };

  const ui = { mode: keep.mode, shadow: keep.shadow, explode: keep.explode };
  function sunNow() {
    const s = o.sunAt(state.date, state.hour);
    return s;
  }
  function render() {
    raf = 0;
    if (disposed) return;
    cam.updateMatrixWorld();
    const shadowsOn = ui.shadow && lift < .01;
    const s = sunNow();
    uni.uOrtho.value = cam === ortho ? 1 : 0;
    uni.uNear.value = cam.near; uni.uFar.value = cam.far;
    uni.uSun.value.copy(s.dir); uni.uSunUp.value = s.up ? 1 : 0;
    uni.uShadowOn.value = shadowsOn && s.up ? 1 : 0;
    uni.uMode.value = ui.mode === 0 ? 0 : 1; uni.uLines.value = ui.mode === 2 ? 0 : 1;
    renderer.setRenderTarget(null);
    // G-buffers
    renderPass(rtN, scene, matN, [.5, .5, .5, 1]);
    renderPass(rtI, scene, matI, [1, 1, 1, 1]);
    if (uni.uShadowOn.value > .5) {
      if (shadowDirty) {
        sun.position.copy(target).addScaledVector(s.dir, R * 3); sun.target.position.copy(target); sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
        renderer.shadowMap.needsUpdate = true; shadowDirty = false;
      }
      renderPass(rtS, scene, matS, [0, 0, 0, 0]);
    }
    if (uni.uLines.value > .5) renderPass(rtL, lineScene, null, [0, 0, 0, 0]);
    // composite + downsample
    renderer.setRenderTarget(rtO); renderer.clear(true, false, false);
    quad.material = matC; renderer.render(quadScene, quadCam);
    renderer.setRenderTarget(null);
    quad.material = matB; renderer.render(quadScene, quadCam);
  }
  function request() { if (!raf && !disposed) raf = requestAnimationFrame(render); handle.raf = raf; }

  // ---- animation (intro, preset tween, explode) ---------------------------------------------------------------
  function runAnim(ms, step, done) {
    stopAnim();
    const t0 = performance.now();
    const a = { id: 0, done };
    anim = a;
    const tick = now => {
      if (anim !== a || disposed) return;
      const t = Math.min(1, (now - t0) / ms);
      step(t);
      render();
      if (t < 1) a.id = requestAnimationFrame(tick);
      else { anim = null; done?.(); }
    };
    a.id = requestAnimationFrame(tick);
  }
  function stopAnim() { if (anim) { cancelAnimationFrame(anim.id); anim = null; } stage.classList.remove("axo-intro"); }

  function setLift(t) {
    lift = t;
    const E = side * .2;
    for (const o2 of layer.bld) o2.position.y = E * t;
    for (const o2 of layer.tgt) o2.position.y = E * 2 * t;
    const top = (layer.tgt.length ? 2 : 1) * E * t;
    guides.visible = t > .01; guides.scale.y = Math.max(.001, top);
    shadowDirty = true;
  }
  function toggleExplode(on) {
    ui.explode = on;
    const from = lift, to = on ? 1 : 0;
    // frame the exploded stack first so nothing leaves the view while it rises
    const saved = lift; setLift(to); fitFrustum(); setLift(saved);
    setPose(pose.az, pose.el);
    runAnim(700, t => { const e = t * t * (3 - 2 * t); setLift(from + (to - from) * e); });
  }

  const introMotion = () => {
    if (preset !== "iso") usePreset("iso", false);
    const el0 = PRESETS.iso.el, az0 = PRESETS.iso.az;
    stage.classList.add("axo-intro");
    // plan -> tilt to the axonometric -> one full turn -> back to the start angle (about 4.4 s)
    const T1 = 1500, T2 = 2600, T3 = 400;
    const ease = t => t * t * (3 - 2 * t);
    runAnim(T1 + T2 + T3, tt => {
      const ms = tt * (T1 + T2 + T3);
      if (ms < T1) { const e = ease(ms / T1); setPose(az0, 89.4 + (el0 - 89.4) * e); }
      else if (ms < T1 + T2) { const e = ease((ms - T1) / T2); setPose(az0 + 360 * e, el0); }
      else setPose(az0, el0);
    }, () => { stage.classList.remove("axo-intro"); });
  };
  const userStop = () => { if (anim) stopAnim(); };
  for (const ev of ["pointerdown", "wheel", "touchstart", "keydown"]) renderer.domElement.addEventListener(ev, userStop, { passive: true });
  renderer.domElement.tabIndex = 0;

  // ---- UI ------------------------------------------------------------------------------------------------------
  const savedIntro = readIntroPref();
  const dateIds = o.dates.map(d => d.id);
  const dateLabel = id => (TXT.dates[id] ? TXT.dates[id][FR() ? 1 : 0] : (o.dates.find(d => d.id === id)?.label || id));
  const bt = (grp, id, label, pressed) => `<button type="button" data-${grp}="${id}" aria-pressed="${pressed}">${label}</button>`;
  controls.innerHTML = `
    <span role="group" aria-label="${tr("mode")}">${tr("mode")} ${[["0", tr("mLine")], ["1", tr("mFlat")], ["2", tr("mFill")]].map(([v, l]) => bt("axo-mode", v, l, ui.mode === Number(v))).join("")}</span>
    <span role="group" aria-label="${tr("cam")}">${tr("cam")} ${[["iso", tr("cIso")], ["obl", tr("cObl")], ["persp", tr("cPersp")]].map(([v, l]) => bt("axo-cam", v, l, preset === v)).join("")}</span>
    <span role="group" aria-label="${tr("sun")}">${tr("sun")} <button type="button" data-axo-shadow="1" aria-pressed="${ui.shadow}">${tr("on")}</button>
      <span id="axo-dates">${dateIds.map(id => bt("axo-date", id, dateLabel(id), state.date === id)).join("")}</span></span>
    <label>${tr("hour")} <input id="axo-hour" type="range" min="0" max="23.75" step="0.25" value="${state.hour}"> <output id="axo-hour-out">${fmtHour(state.hour)}</output></label>
    <button type="button" data-axo-explode="1" aria-pressed="${ui.explode}">${tr("explode")}</button>
    <span role="group" aria-label="${tr("intro")}"><button type="button" data-axo-replay="1">${tr("replay")}</button>
      <label><input id="axo-intro-on" type="checkbox" ${savedIntro ? "checked" : ""}> ${tr("intro")}</label></span>
    <span class="dg-save" role="group" aria-label="${tr("save")}"><span class="dg-save-label">${tr("save")}</span><button type="button" data-axo-png="1">PNG</button></span>
    <span id="axo-info" class="note"></span>`;
  const $c = id => controls.querySelector("#" + id);
  const press = (sel, val, attr) => controls.querySelectorAll(sel).forEach(b => b.setAttribute("aria-pressed", String(b.dataset[attr] === String(val))));
  function updateInfo() {
    const s = sunNow();
    const base = `${dateLabel(state.date)} ${fmtHour(state.hour)} · ` + (s.up ? tr("sunUp").replace("{alt}", s.altDeg.toFixed(1)).replace("{az}", s.azDeg.toFixed(0)) : tr("sunDown"));
    $c("axo-info").textContent = ui.shadow ? base + (lift > .01 ? " · " + tr("explodedNote") : "") : "";
  }
  controls.onclick = async e => {
    queueMicrotask(() => Object.assign(keep, { mode: ui.mode, shadow: ui.shadow, explode: ui.explode, preset }));
    const t = e.target.closest("button"); if (!t) return;
    const d = t.dataset;
    if (d.axoMode != null) { ui.mode = Number(d.axoMode); press("[data-axo-mode]", ui.mode, "axoMode"); request(); }
    else if (d.axoCam) { usePreset(d.axoCam); press("[data-axo-cam]", d.axoCam, "axoCam"); }
    else if (d.axoShadow) { ui.shadow = !ui.shadow; t.setAttribute("aria-pressed", String(ui.shadow)); shadowDirty = true; updateInfo(); request(); }
    else if (d.axoDate) { state.date = d.axoDate; press("[data-axo-date]", d.axoDate, "axoDate"); shadowDirty = true; updateInfo(); request(); }
    else if (d.axoExplode) { toggleExplode(!ui.explode); t.setAttribute("aria-pressed", String(ui.explode)); updateInfo(); }
    else if (d.axoReplay) introMotion();
    else if (d.axoPng) await exportPng();
  };
  $c("axo-hour").addEventListener("input", e => { state.hour = Number(e.target.value); $c("axo-hour-out").textContent = fmtHour(state.hour); shadowDirty = true; updateInfo(); request(); });
  $c("axo-intro-on").addEventListener("change", e => writeIntroPref(e.target.checked));

  const nUnknown = parts.bldgs.filter(b => !b.known).length;
  const badge = document.createElement("div"); badge.className = "dg-badge";
  badge.textContent = (nUnknown ? tr("est").replace("{n}", nUnknown) + " " : "") + tr("src");
  stage.append(badge);
  note.textContent = tr("hint") + " " + (layer.tgt.length ? tr("layers") : tr("layers2")) + ". " + tr("src") + ". " + tr("sim");

  async function exportPng() {
    const scale = Math.max(1, 2 / Math.min(devicePixelRatio || 1, 2));      // at least 2x the on-screen size
    sizeTargets(scale);
    render();
    const canvas = renderer.domElement;
    const out = document.createElement("canvas");
    const foot = Math.round(34 * scale);
    out.width = canvas.width; out.height = canvas.height + foot;
    const g = out.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, out.width, out.height);
    g.drawImage(canvas, 0, 0);
    const s = sunNow();
    g.fillStyle = "#555"; g.font = `${Math.round(12 * scale)}px "Noto Sans", "Pretendard", system-ui, sans-serif`; g.textBaseline = "middle";
    g.fillText(tr("src") + " · " + tr("sim"), 12 * scale, canvas.height + foot / 2);
    if (ui.shadow && s.up) { g.textAlign = "right"; g.fillText(`${dateLabel(state.date)} ${fmtHour(state.hour)}`, out.width - 12 * scale, canvas.height + foot / 2); }
    sizeTargets(); request();                                              // back to the on-screen resolution
    const blob = await new Promise(res => out.toBlob(res, "image/png"));
    o.download(blob, `terrain_axo_${["line", "line_flat", "flat"][ui.mode]}_${preset}.png`);
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------
  const handle = { renderer, scene, camera: cam, controls: controlsO, raf: 0, ui, usePreset, introMotion, toggleExplode, exportPng, render, request, get preset() { return preset; }, layer };
  handle.resize = () => {
    if (disposed || !stage.clientWidth || !stage.clientHeight) return;
    sizeTargets(); fitFrustum(); setPose(pose.az, pose.el); request();
  };
  handle.fit = () => {};
  handle.stopPlay = () => { disposed = true; stopAnim(); cancelAnimationFrame(raf); disposeRT(); for (const g of own) g.dispose(); for (const l of lineObjs) { l.geometry.dispose(); l.material.dispose(); } guideGeo.dispose(); matN.dispose(); matI.dispose(); matS.dispose(); matC.dispose(); matB.dispose(); depthMat.dispose(); quadGeo.dispose(); };
  let roFrame = 0;
  handle.ro = new ResizeObserver(() => { cancelAnimationFrame(roFrame); roFrame = requestAnimationFrame(() => handle.resize()); });   // deferred: no ResizeObserver loop warning
  handle.ro.observe(stage);

  if (!PRESETS[preset].ortho) { cam = persp; controlsO.object = cam; }
  if (ui.explode) setLift(1);
  sizeTargets(); fitFrustum(); setPose(PRESETS[preset].az, PRESETS[preset].el);
  updateInfo();
  render();
  if (!introSeen && savedIntro && !ui.explode && !new URLSearchParams(location.search).has("nointro")) { introSeen = true; introMotion(); }
  introSeen = true;
  return handle;
}
