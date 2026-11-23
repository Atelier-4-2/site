// Atelier 4·2 Board — Exploded Axonometric Builder (Plans -> Plan Oblique 45/45, 30/60, Isometric SSR)
// 100% client-side SVG composition.

export const PROJECTIONS = {
  oblique45: { label: "평면 사선 45°/45°", matrix: [0.7071, 0.7071, -0.7071, 0.7071] },
  oblique30: { label: "평면 사선 30°/60°", matrix: [0.866, 0.5, -0.5, 0.866] },
  iso:       { label: "아이소메트릭 (SSR)", matrix: [0.866, 0.5, -0.866, 0.5] },
};

export function buildExplodedSvg(layers, opts = {}) {
  const proj = PROJECTIONS[opts.proj] || PROJECTIONS.oblique45;
  const [a, b, c, d] = proj.matrix;
  const gap = opts.gap == null ? 90 : +opts.gap;
  const hideBelow = opts.hideBelow !== false;
  const showLines = opts.showLines !== false;
  const W = 240, H = 180;
  const visible = layers.filter(l => l.on);
  if (!visible.length) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"></svg>`;

  const xform = (x, y, dy) => [a * x + c * y, b * x + d * y + dy];
  const corners = [[0, 0], [W, 0], [W, H], [0, H]];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  visible.forEach((_, idx) => {
    const dy = -idx * gap;
    for (const [cx, cy] of corners) {
      const [px, py] = xform(cx, cy, dy);
      minX = Math.min(minX, px); minY = Math.min(minY, py);
      maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
    }
  });
  const pad = 28;
  const vbX = Math.round(minX - pad), vbY = Math.round(minY - pad);
  const vbW = Math.round(maxX - minX + pad * 2), vbH = Math.round(maxY - minY + pad * 2);

  const parts = [];
  if (showLines && visible.length >= 2) {
    const topDy = -(visible.length - 1) * gap;
    for (const [cx, cy] of corners) {
      const [x0, y0] = xform(cx, cy, 0);
      const [x1, y1] = xform(cx, cy, topDy);
      parts.push(`<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="#7D848D" stroke-width="0.6" stroke-dasharray="4 3"/>`);
    }
  }

  visible.forEach((L, idx) => {
    const dy = -idx * gap;
    const stroke = L.accent ? "#E6B89C" : "#1E2124";
    const fill = hideBelow ? (L.accent ? "#FDF5F0" : "#FFFFFF") : "none";
    parts.push(`<g transform="translate(0 ${dy.toFixed(1)}) matrix(${a} ${b} ${c} ${d} 0 0)">`);
    parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${fill}" stroke="${stroke}" stroke-width="${L.accent ? 1.6 : 0.9}"/>`);
    if (L.dataUrl) {
      parts.push(`<image href="${L.dataUrl}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet"/>`);
    }
    parts.push(`</g>`);
    const [lx, ly] = xform(W + 8, H / 2, dy);
    parts.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-family="Pretendard, sans-serif" font-size="11" font-weight="600" fill="${L.accent ? "#B25000" : "#1E2124"}">${String(L.name || `L${idx + 1}`).replace(/[<>&]/g, "")}</text>`);
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="${vbW}" height="${vbH}">${parts.join("")}</svg>`;
}

export function openAxoModal(ctx, initialLayers) {
  const bg = document.createElement("div");
  bg.className = "lw-dlg";
  bg.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.5);display:grid;place-items:center;padding:16px";
  const box = document.createElement("div");
  box.style.cssText = "background:#fff;color:#1d1d1f;border-radius:16px;width:min(880px,100%);max-height:90vh;overflow:auto;padding:18px;display:grid;gap:12px;box-shadow:0 16px 40px rgba(0,0,0,.25)";

  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="margin:0">평면 → 분해 액소 (Exploded Axo)</h3>
      <button type="button" class="bd-btn" data-close>✕</button>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <label class="bd-btn" style="cursor:pointer">+ 평면 추가 (SVG/PNG/JPG)<input type="file" id="axFiles" accept=".svg,image/svg+xml,image/png,image/jpeg" multiple hidden></label>
      <select id="axProj" style="min-height:32px;border:1px solid #d2d2d7;border-radius:8px;padding:0 8px;font-size:13px">
        <option value="oblique45">평면 사선 45°/45°</option>
        <option value="oblique30">평면 사선 30°/60°</option>
        <option value="iso">아이소메트릭 (SSR)</option>
      </select>
      <label style="font-size:13px;display:inline-flex;align-items:center;gap:4px">층 간격 <input type="range" id="axGap" min="30" max="180" value="85" style="width:100px"></label>
      <label style="font-size:13px"><input type="checkbox" id="axLines" checked> 수직 점선</label>
      <label style="font-size:13px"><input type="checkbox" id="axHide" checked> 아래층 가리기</label>
    </div>
    <div style="display:grid;grid-template-columns:240px 1fr;gap:12px;align-items:start">
      <div style="display:grid;gap:6px">
        <div style="font-size:12px;color:#6e6e73">층 순서 (아래가 1층 · RDC)</div>
        <ul id="axList" style="list-style:none;margin:0;padding:0;display:grid;gap:6px"></ul>
      </div>
      <div id="axPrev" style="min-height:300px;border:1px solid #e5e5ea;border-radius:12px;background:#f5f5f7;display:grid;place-items:center;padding:12px;overflow:auto"></div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px">
      <button type="button" class="bd-btn" id="axDl">SVG 내려받기</button>
      <button type="button" class="bd-btn bd-strong" id="axAdd">보드에 카드로 넣기</button>
    </div>
  `;
  bg.append(box);
  document.body.append(bg);
  const $ = s => box.querySelector(s);
  $("[data-close]").onclick = () => bg.remove();
  bg.addEventListener("click", e => { if (e.target === bg) bg.remove(); });

  const layers = (initialLayers && initialLayers.length)
    ? initialLayers.map((x, i) => ({ name: x.name || `R+${i}`, dataUrl: x.dataUrl, on: true, accent: false }))
    : [
        { name: "RDC", dataUrl: "", on: true, accent: false },
        { name: "R+1", dataUrl: "", on: true, accent: true },
        { name: "R+2", dataUrl: "", on: true, accent: false },
      ];

  function currentSvg() {
    return buildExplodedSvg(layers, {
      proj: $("#axProj").value,
      gap: +$("#axGap").value,
      showLines: $("#axLines").checked,
      hideBelow: $("#axHide").checked,
    });
  }
  function render() {
    const ul = $("#axList"); ul.textContent = "";
    layers.forEach((L, idx) => {
      const li = document.createElement("li");
      li.style.cssText = "display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid #e5e5ea;border-radius:8px;background:#fff;font-size:13px";
      const chk = document.createElement("input"); chk.type = "checkbox"; chk.checked = L.on;
      chk.onchange = () => { L.on = chk.checked; renderPreview(); };
      const nm = document.createElement("input"); nm.type = "text"; nm.value = L.name;
      nm.style.cssText = "flex:1;min-width:0;border:0;background:none;font:600 13px inherit";
      nm.oninput = () => { L.name = nm.value; renderPreview(); };
      const acc = document.createElement("button"); acc.type = "button"; acc.textContent = "강조"; acc.className = "bd-btn";
      acc.style.cssText = "padding:2px 6px;min-height:24px;font-size:11px" + (L.accent ? ";background:#E6B89C;border-color:#E6B89C" : "");
      acc.onclick = () => { L.accent = !L.accent; render(); };
      const up = document.createElement("button"); up.type = "button"; up.textContent = "↑"; up.className = "bd-btn"; up.style.cssText = "padding:2px 5px;min-height:24px;font-size:11px";
      up.disabled = idx >= layers.length - 1;
      up.onclick = () => { [layers[idx], layers[idx + 1]] = [layers[idx + 1], layers[idx]]; render(); };
      const del = document.createElement("button"); del.type = "button"; del.textContent = "✕"; del.className = "bd-btn"; del.style.cssText = "padding:2px 5px;min-height:24px;font-size:11px";
      del.onclick = () => { layers.splice(idx, 1); render(); };
      li.append(chk, nm, acc, up, del);
      ul.append(li);
    });
    renderPreview();
  }
  function renderPreview() {
    const svg = currentSvg();
    const prev = $("#axPrev");
    prev.innerHTML = svg;
    const s = prev.querySelector("svg");
    if (s) { s.style.maxWidth = "100%"; s.style.maxHeight = "380px"; s.style.height = "auto"; }
  }
  $("#axFiles").onchange = async e => {
    const files = [...(e.target.files || [])];
    for (const f of files) {
      const dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
      layers.push({ name: f.name.replace(/\.[^.]+$/, ""), dataUrl, on: true, accent: false });
    }
    e.target.value = "";
    render();
  };
  ["#axProj", "#axGap", "#axLines", "#axHide"].forEach(s => $(s).addEventListener("input", renderPreview));
  $("#axDl").onclick = () => {
    const blob = new Blob([currentSvg()], { type: "image/svg+xml" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "exploded_axo.svg"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  $("#axAdd").onclick = () => {
    const svg = currentSvg();
    const dataUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    ctx.addImageCard(dataUrl, 400, 320, "분해 액소");
    bg.remove();
  };
  render();
}
