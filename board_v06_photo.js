// Atelier 4·2 Board — Model Photo Cleanup (4-point homography deskew, auto WB/levels, contrast, sketch mode)
// 100% in-browser canvas processing, no external upload.

export function solveHomography(src, dst) {
  // Solve 8x8 linear system for H mapping dst(x,y) -> src(u,v) (inverse mapping for crisp warp)
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i], [u, v] = src[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const n = 8;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    [b[i], b[p]] = [b[p], b[i]];
    const piv = A[i][i] || 1e-12;
    for (let c = i; c < n; c++) A[i][c] /= piv;
    b[i] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = A[r][i];
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  return [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], 1];
}

export function warpPerspective(srcImgData, corners, outW, outH) {
  const sw = srcImgData.width, sh = srcImgData.height, sd = srcImgData.data;
  const H = solveHomography(corners, [[0, 0], [outW, 0], [outW, outH], [0, outH]]);
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const denom = H[6] * x + H[7] * y + 1;
      const u = (H[0] * x + H[1] * y + H[2]) / denom;
      const v = (H[3] * x + H[4] * y + H[5]) / denom;
      const oi = (y * outW + x) * 4;
      if (u < 0 || v < 0 || u >= sw - 1 || v >= sh - 1) {
        out[oi] = out[oi + 1] = out[oi + 2] = 255; out[oi + 3] = 255; continue;
      }
      const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      for (let c = 0; c < 3; c++) {
        out[oi + c] = sd[i00 + c] * w00 + sd[i10 + c] * w10 + sd[i01 + c] * w01 + sd[i11 + c] * w11;
      }
      out[oi + 3] = 255;
    }
  }
  return new ImageData(out, outW, outH);
}

export function adjustPixels(imgData, opts = {}) {
  const d = new Uint8ClampedArray(imgData.data), n = d.length / 4;
  if (opts.wb) {
    let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < d.length; i += 4) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; }
    const mr = sr / n || 1, mg = sg / n || 1, mb = sb / n || 1, avg = (mr + mg + mb) / 3;
    const kr = avg / mr, kg = avg / mg, kb = avg / mb;
    for (let i = 0; i < d.length; i += 4) { d[i] = Math.min(255, d[i] * kr); d[i + 1] = Math.min(255, d[i + 1] * kg); d[i + 2] = Math.min(255, d[i + 2] * kb); }
  }
  if (opts.levels) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) hist[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
    let lo = 0, hi = 255, acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.01) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.01) { hi = i; break; } }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, ((d[i + c] - lo) * 255) / span));
    }
  }
  const ct = opts.contrast == null ? 1 : opts.contrast;
  if (Math.abs(ct - 1) > 0.01) {
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, (d[i + c] - 128) * ct + 128));
    }
  }
  if (opts.sketch) {
    // High-contrast clean grayscale for tracing-paper sketches / white models
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const v = l > 188 ? 255 : Math.max(0, Math.min(255, (l - 40) * 1.45));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  return new ImageData(d, imgData.width, imgData.height);
}

export function openPhotoModal(ctx, initialDataUrl) {
  const bg = document.createElement("div");
  bg.className = "lw-dlg";
  bg.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.5);display:grid;place-items:center;padding:16px";
  const box = document.createElement("div");
  box.style.cssText = "background:#fff;color:#1d1d1f;border-radius:16px;width:min(880px,100%);max-height:90vh;overflow:auto;padding:18px;display:grid;gap:12px;box-shadow:0 16px 40px rgba(0,0,0,.25)";

  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h3 style="margin:0">모형 사진 · 스케치 정리</h3>
      <button type="button" class="bd-btn" data-close>✕</button>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <label class="bd-btn" style="cursor:pointer">사진 열기<input type="file" id="phFile" accept="image/*" hidden></label>
      <label style="font-size:13px"><input type="checkbox" id="phWb" checked> 자동 화이트밸런스</label>
      <label style="font-size:13px"><input type="checkbox" id="phLvl" checked> 자동 레벨</label>
      <label style="font-size:13px"><input type="checkbox" id="phSketch"> 스케치 흑백</label>
      <label style="font-size:13px;display:inline-flex;align-items:center;gap:4px">대비 <input type="range" id="phCt" min="0.6" max="2.0" step="0.05" value="1.1" style="width:90px"></label>
      <select id="phRatio" style="min-height:32px;border:1px solid #d2d2d7;border-radius:8px;padding:0 6px;font-size:13px">
        <option value="auto">자동 비율</option>
        <option value="a4l">A4 가로</option>
        <option value="a4p">A4 세로</option>
        <option value="sq">정사각 (1:1)</option>
      </select>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start">
      <div>
        <div style="font-size:12px;color:#6e6e73;margin-bottom:4px">1) 네 모서리를 끌어 반듯하게 펴세요</div>
        <canvas id="phSrc" style="width:100%;border:1px solid #e5e5ea;border-radius:10px;background:#f5f5f7;touch-action:none;cursor:crosshair"></canvas>
      </div>
      <div>
        <div style="font-size:12px;color:#6e6e73;margin-bottom:4px">2) 보정 결과 미리보기</div>
        <canvas id="phOut" style="width:100%;border:1px solid #e5e5ea;border-radius:10px;background:#f5f5f7"></canvas>
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;gap:8px">
      <button type="button" class="bd-btn" id="phDl" disabled>PNG 내려받기</button>
      <button type="button" class="bd-btn bd-strong" id="phAdd" disabled>보드에 카드로 넣기</button>
    </div>
  `;
  bg.append(box);
  document.body.append(bg);

  const $ = s => box.querySelector(s);
  $("[data-close]").onclick = () => bg.remove();
  bg.addEventListener("click", e => { if (e.target === bg) bg.remove(); });

  const cSrc = $("#phSrc"), cOut = $("#phOut");
  let srcImg = null, srcData = null, pts = null, dragIdx = -1;

  function loadImageUrl(url) {
    const im = new Image();
    im.onload = () => {
      const max = 1000, k = Math.min(1, max / im.naturalWidth, max / im.naturalHeight);
      const w = Math.max(1, Math.round(im.naturalWidth * k)), h = Math.max(1, Math.round(im.naturalHeight * k));
      cSrc.width = w; cSrc.height = h;
      const g = cSrc.getContext("2d"); g.drawImage(im, 0, 0, w, h);
      srcImg = im; srcData = g.getImageData(0, 0, w, h);
      const m = Math.round(Math.min(w, h) * 0.06);
      pts = [[m, m], [w - m, m], [w - m, h - m], [m, h - m]];
      $("#phAdd").disabled = false; $("#phDl").disabled = false;
      render();
    };
    im.src = url;
  }

  function render() {
    if (!srcData || !pts) return;
    const g = cSrc.getContext("2d");
    g.putImageData(srcData, 0, 0);
    g.strokeStyle = "#d70015"; g.lineWidth = Math.max(2, cSrc.width / 260);
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < 4; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath(); g.stroke();
    const rad = Math.max(8, cSrc.width / 45);
    pts.forEach((p, i) => {
      g.beginPath(); g.arc(p[0], p[1], rad, 0, Math.PI * 2);
      g.fillStyle = "#d70015"; g.fill(); g.strokeStyle = "#fff"; g.lineWidth = 2; g.stroke();
      g.fillStyle = "#fff"; g.font = `700 ${Math.round(rad * 1.1)}px sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(String(i + 1), p[0], p[1]);
    });

    const wTop = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    const wBot = Math.hypot(pts[2][0] - pts[3][0], pts[2][1] - pts[3][1]);
    const hL = Math.hypot(pts[3][0] - pts[0][0], pts[3][1] - pts[0][1]);
    const hR = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
    let ow = Math.max(100, Math.round((wTop + wBot) / 2));
    let oh = Math.max(100, Math.round((hL + hR) / 2));
    const ratio = $("#phRatio").value;
    if (ratio === "a4l") oh = Math.round(ow / 1.4142);
    else if (ratio === "a4p") ow = Math.round(oh / 1.4142);
    else if (ratio === "sq") ow = oh = Math.round((ow + oh) / 2);
    const lim = Math.min(1, 900 / Math.max(ow, oh));
    ow = Math.round(ow * lim); oh = Math.round(oh * lim);

    const warped = warpPerspective(srcData, pts, ow, oh);
    const clean = adjustPixels(warped, { wb: $("#phWb").checked, levels: $("#phLvl").checked, sketch: $("#phSketch").checked, contrast: +$("#phCt").value });
    cOut.width = ow; cOut.height = oh;
    cOut.getContext("2d").putImageData(clean, 0, 0);
  }

  function toCanvasPt(e) {
    const r = cSrc.getBoundingClientRect();
    return [(e.clientX - r.left) * cSrc.width / r.width, (e.clientY - r.top) * cSrc.height / r.height];
  }
  cSrc.addEventListener("pointerdown", e => {
    if (!pts) return;
    const [x, y] = toCanvasPt(e), lim = Math.max(24, cSrc.width / 16);
    dragIdx = pts.findIndex(p => Math.hypot(p[0] - x, p[1] - y) <= lim);
    if (dragIdx >= 0) try { cSrc.setPointerCapture(e.pointerId); } catch {}
  });
  cSrc.addEventListener("pointermove", e => {
    if (dragIdx < 0 || !pts) return;
    const [x, y] = toCanvasPt(e);
    pts[dragIdx] = [Math.max(0, Math.min(cSrc.width, x)), Math.max(0, Math.min(cSrc.height, y))];
    render();
  });
  cSrc.addEventListener("pointerup", () => { dragIdx = -1; });

  $("#phFile").onchange = e => { const f = e.target.files?.[0]; if (f) loadImageUrl(URL.createObjectURL(f)); };
  ["#phWb", "#phLvl", "#phSketch", "#phCt", "#phRatio"].forEach(s => $(s).addEventListener("input", render));

  $("#phDl").onclick = () => {
    const a = document.createElement("a"); a.href = cOut.toDataURL("image/png"); a.download = "model_cleaned.png"; a.click();
  };
  $("#phAdd").onclick = () => {
    ctx.addImageCard(cOut.toDataURL("image/png"), cOut.width, cOut.height, "사진 정리");
    bg.remove();
  };

  if (initialDataUrl) loadImageUrl(initialDataUrl);
}
