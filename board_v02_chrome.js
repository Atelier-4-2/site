// Board v2 dialogs: export panel, command palette (⌘K), shortcut sheet, board info (cartouche meta), text styles,
// presentation mode. Created once by board_v02.js with a small api object; holds no document state of its own.
import { frameSize, parseRange, ROLES, ROLE_LABEL, PALETTE, WEIGHTS, needsTiles, pad2 } from "./board_v02_doc.js?v=20261121c";
import * as X from "./board_v02_export.js?v=20261121c";
import { icon } from "./board_v02_icons.js?v=20261121c";

const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const field = (label, input, hint) => { const l = mk("label", "bd-field"); l.append(mk("span", "bd-field-l", label), input); if (hint) l.append(mk("small", "bd-field-h", hint)); return l; };

export const SHORTCUTS = [
  ["도구", [["선택", "V"], ["손 (이동)", "H · Space 누르는 동안"], ["텍스트", "T"], ["프레임", "F"], ["메모", "N"], ["이미지", "I"]]],
  ["편집", [["실행 취소 / 다시 실행", "⌘Z / ⌘⇧Z"], ["복제", "⌘D"], ["묶기 / 풀기", "⌘G / ⌘⇧G"], ["앞으로 / 뒤로", "] / ["], ["삭제", "Delete"], ["이동 (10 mm)", "방향키 (Shift)"], ["전체 선택", "⌘A"], ["붙여넣기 (이미지·글)", "⌘V"], ["스냅 끄기", "Alt 누른 채 끌기"]]],
  ["보기", [["작업 ↔ 조판", "Shift+R"], ["확대 / 축소", "⌘ 휠 · 핀치"], ["전체 보기", "Shift+1"], ["발표", "P"], ["명령 팔레트", "⌘K"], ["단축키 보기", "?"]]]
];

export function createChrome(api) {
  let exporting = false, pres = null, dlgN = 0, presExit = null, fontCssP = null;
  const root = () => api.root();

  function dlg(title, cls = "") {
    document.querySelectorAll("#board dialog.bd-dlg").forEach(d => d.close());
    const d = mk("dialog", "bd-dlg " + cls);
    d.setAttribute("aria-label", title);
    const head = mk("header", "bd-dlg-h"); head.append(mk("h2", "", title));
    const x = mk("button", "bd-ib"); x.type = "button"; x.innerHTML = icon("close"); x.setAttribute("aria-label", "닫기"); x.onclick = () => d.close();
    head.append(x);
    const body = mk("div", "bd-dlg-b"), foot = mk("footer", "bd-dlg-f");
    d.append(head, body, foot);
    d.addEventListener("close", () => setTimeout(() => d.remove(), 0));
    d.addEventListener("click", e => { if (e.target === d) d.close(); });
    root().append(d);
    return { d, body, foot, show() { d.showModal(); return d; } };
  }
  const isBlocking = () => !!pres || !!root().querySelector("dialog[open]");

  // ---- export ---------------------------------------------------------------------------------------
  function download(blob, name) { api.download(blob, name); }
  async function pngOfFrame(f) {
    const ctx = api.ctx();
    const fontCss = await api.loadFontCss();
    const svg = X.frameSvg(ctx, f, "png", fontCss);
    const [W, H] = frameSize(f);
    let pw = W / 25.4 * 150, ph = H / 25.4 * 150;   // 150 dpi
    const k = Math.min(1, Math.sqrt(16000000 / (pw * ph)));   // iOS canvas limit
    pw = Math.floor(pw * k); ph = Math.floor(ph * k);
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const cv = document.createElement("canvas");
      cv.width = pw; cv.height = ph;
      const cx = cv.getContext("2d");
      cx.fillStyle = "#fff"; cx.fillRect(0, 0, pw, ph);
      cx.drawImage(img, 0, 0, pw, ph);
      return await new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error("PNG 변환 실패")), "image/png"));
    } finally { URL.revokeObjectURL(url); }
  }
  async function exportFrames(frames, kind, opt = {}) {
    if (exporting) return;
    if (!frames.length) { api.status("출력할 페이지가 없습니다."); return; }
    exporting = true;
    api.finishEdit();
    const ctx = api.ctx(), S = ctx.S;
    try {
      if (kind === "pdf") {
        api.status("PDF 만드는 중…");
        const pages = X.planSheets(ctx, frames, opt);
        const blob = await api.buildPdf(pages, { title: S.name || "Atelier 보드", subject: "Atelier 4·2 보드", onProgress: (i, n) => api.status(`PDF ${i}/${n}`) });
        const tag = opt.booklet ? "_A3소책자" : opt.tiles ? "_A3타일" : opt.bleed ? "_재단선" : "";
        download(blob, `${api.safeName()}${frames.length === 1 ? "_p" + pad2(frames[0].page) : ""}${tag}.pdf`);
        api.status(`PDF ${pages.length}쪽 저장`);
      } else {
        api.status("PNG 만드는 중…");
        for (const f of frames) download(await pngOfFrame(f), `${api.safeName()}_p${pad2(f.page)}.png`);
        api.status(`PNG ${frames.length}장 저장`);
      }
    } catch (e) { console.error(e); api.status(`출력 실패: ${e.message}`); }
    finally { exporting = false; }
  }

  function openExport() {
    const S = api.ctx().S;
    if (!S.frames.length) { api.status("출력할 페이지가 없습니다."); return; }
    const { d, body, foot, show } = dlg("출력", "bd-dlg-export");
    const uid = ++dlgN;   // radio groups are per document: keep them unique per dialog
    const radio = (name, val, label, checked) => {
      const l = mk("label", "bd-radio"), i = mk("input"); i.type = "radio"; i.name = name + uid; i.value = val; i.checked = !!checked;
      l.append(i, mk("span", "", label)); return l;
    };
    const check = (id, label, hint) => {
      const l = mk("label", "bd-check"), i = mk("input"); i.type = "checkbox"; i.id = id;
      const t = mk("span", "bd-check-t"); t.append(mk("b", "", label), mk("small", "", hint));
      l.append(i, t); return l;
    };
    const fs1 = mk("fieldset", "bd-fs"); fs1.append(mk("legend", "", "형식"));
    fs1.append(radio("fmt", "pdf", "PDF (벡터)", true), radio("fmt", "png", "PNG (150 dpi)"));
    const fs2 = mk("fieldset", "bd-fs"); fs2.append(mk("legend", "", "범위"));
    const rng = mk("input"); rng.type = "text"; rng.placeholder = "1-3,5"; rng.setAttribute("aria-label", "페이지 번호"); rng.className = "bd-range";
    const row = mk("div", "bd-range-row"); row.append(radio("rng", "nums", "페이지 번호"), rng);
    fs2.append(radio("rng", "all", `전체 페이지 (${S.frames.length}쪽)`, true), radio("rng", "sel", "선택한 페이지"), row);
    const fs3 = mk("fieldset", "bd-fs"); fs3.append(mk("legend", "", "옵션 (PDF)"));
    fs3.append(check("bd-x-book", "A3 소책자", "모든 쪽을 같은 방향의 A3 한 장에 맞춰 줄여서 한 쪽씩"), check("bd-x-bleed", "재단선", "3 mm 도련 + 모서리 재단선"), check("bd-x-tile", "A3 타일 분할", "A0·A1·A2 쪽을 A3 조각으로 나눔 (겹침 10 mm, 재단선·번호)"));
    const hint = mk("p", "bd-dlg-hint");
    body.append(fs1, fs2, fs3, hint);
    const go = mk("button", "bd-primary"); go.type = "button";
    const cancel = mk("button", "bd-btn", "닫기"); cancel.type = "button"; cancel.onclick = () => d.close();
    foot.append(cancel, go);
    const q = s => d.querySelector(s);
    const val = n => d.querySelector(`input[name=${n}${uid}]:checked`)?.value;
    const frames = () => {
      const list = api.ctx().S.frames;   // already in page order
      const r = val("rng");
      if (r === "all") return list;
      if (r === "sel") { const f = api.selectedFrame(); return f ? [f] : []; }
      const nums = parseRange(rng.value, list.length);
      return nums ? nums.map(n => list[n - 1]).filter(Boolean) : [];
    };
    const sync = () => {
      const pdf = val("fmt") === "pdf";
      const book = q("#bd-x-book"), bleed = q("#bd-x-bleed"), tile = q("#bd-x-tile");
      for (const c of [book, bleed, tile]) c.disabled = !pdf;
      if (!pdf) for (const c of [book, bleed, tile]) c.checked = false;
      bleed.disabled = !pdf || book.checked || tile.checked;
      if (bleed.disabled && (book.checked || tile.checked)) bleed.checked = false;
      const fl = frames();
      tile.disabled = !pdf || book.checked;
      book.disabled = !pdf || tile.checked;
      const big = fl.some(f => { const [W, H] = frameSize(f); return needsTiles(W, H); });
      const n = pdf ? X.sheetCount(fl, { tiles: tile.checked }) : fl.length;
      go.textContent = `내보내기 (${n}쪽)`; go.disabled = !fl.length || exporting;
      rng.disabled = val("rng") !== "nums";
      hint.textContent = !fl.length ? (val("rng") === "nums" ? "페이지 번호를 확인하세요. 예: 1-3,5" : "선택한 페이지가 없습니다. 보드에서 프레임이나 카드를 먼저 고르세요.")
        : tile.checked && !big ? "A3 이하 쪽만 있어 타일로 나눌 쪽이 없습니다 (그대로 한 쪽씩 출력)." : "";
    };
    d.addEventListener("change", sync); d.addEventListener("input", sync);
    rng.addEventListener("focus", () => { d.querySelector(`input[name=rng${uid}][value=nums]`).checked = true; sync(); });
    go.onclick = async () => {
      const fl = frames(), kind = val("fmt");
      d.close();
      await exportFrames(fl, kind, { booklet: q("#bd-x-book").checked, bleed: q("#bd-x-bleed").checked, tiles: q("#bd-x-tile").checked });
    };
    if (api.selectedFrame()) d.querySelector(`input[name=rng${uid}][value=sel]`).checked = true;
    sync();
    show();
    go.focus();
  }

  // ---- shortcut sheet ----------------------------------------------------------------------------------
  function openShortcuts() {
    const { body, show } = dlg("단축키", "bd-dlg-wide");
    for (const [g, rows] of SHORTCUTS) {
      const sec = mk("section", "bd-sc"); sec.append(mk("h3", "", g));
      const dl = mk("dl");
      for (const [a, k] of rows) { dl.append(mk("dt", "", a)); const dd = mk("dd"); dd.append(mk("kbd", "", k)); dl.append(dd); }
      sec.append(dl); body.append(sec);
    }
    show();
  }

  // ---- board info (cartouche meta) ------------------------------------------------------------------------
  function openInfo() {
    const S = api.ctx().S, m = S.meta;
    const { d, body, foot, show } = dlg("보드 정보 · 카르투슈");
    const mkIn = (key, label, ph, max) => { const i = mk("input"); i.type = "text"; i.value = m[key] || ""; i.maxLength = max; i.placeholder = ph; i.dataset.key = key; return field(label, i); };
    body.append(
      mkIn("project", "프로젝트", "예: Butte-Rouge", 120), mkIn("author", "이름", "", 80), mkIn("atelier", "아틀리에", "예: Atelier 4·2", 80),
      mkIn("teachers", "교수", "", 160), mkIn("scale", "축척", "예: 1/200", 24), mkIn("date", "날짜", new Date().toISOString().slice(0, 10), 24));
    body.append(mk("p", "bd-dlg-hint", "프레임을 고르고 ‘카르투슈’를 켜면 이 내용이 아래 띠에 들어갑니다. 화면·PDF·PNG가 같습니다."));
    const ok = mk("button", "bd-primary", "저장"); ok.type = "button";
    const cancel = mk("button", "bd-btn", "취소"); cancel.type = "button"; cancel.onclick = () => d.close();
    ok.onclick = () => { const v = {}; for (const i of d.querySelectorAll("input[data-key]")) v[i.dataset.key] = i.value.trim(); api.commitMeta(v); d.close(); };
    foot.append(cancel, ok);
    show();
    d.querySelector("input").focus();
  }

  // ---- text styles -----------------------------------------------------------------------------------------
  function openStyles() {
    const S = api.ctx().S;
    const cur = JSON.parse(JSON.stringify(S.styles));
    const { d, body, foot, show } = dlg("글 스타일", "bd-dlg-wide");
    const rows = mk("div", "bd-styles");
    for (const r of ROLES) {
      const row = mk("div", "bd-style-row");
      const sample = mk("span", "bd-style-sample", "가나다 Abc 12");
      const size = mk("input"); size.type = "number"; size.min = 1; size.max = 200; size.step = 0.5; size.value = cur[r].size; size.setAttribute("aria-label", `${ROLE_LABEL[r]} 크기 mm`);
      const wt = mk("select"); wt.setAttribute("aria-label", `${ROLE_LABEL[r]} 굵기`);
      for (const w of WEIGHTS) { const o = mk("option", "", String(w)); o.value = w; o.selected = w === cur[r].weight; wt.append(o); }
      const pal = mk("div", "bd-pal"); pal.setAttribute("role", "radiogroup"); pal.setAttribute("aria-label", `${ROLE_LABEL[r]} 색`);
      const paint = () => {
        sample.style.cssText = `font-size:${Math.min(36, Math.max(10, cur[r].size * 2.4))}px;font-weight:${cur[r].weight};color:${cur[r].color}`;
        for (const b of pal.children) b.setAttribute("aria-checked", String(b.dataset.c === cur[r].color));
      };
      for (const c of PALETTE) {
        const b = mk("button", "bd-sw"); b.type = "button"; b.dataset.c = c; b.style.background = c; b.setAttribute("role", "radio"); b.setAttribute("aria-label", c);
        b.onclick = () => { cur[r].color = c; paint(); };
        pal.append(b);
      }
      size.oninput = () => { const v = Number(size.value); if (v >= 1 && v <= 200) { cur[r].size = v; paint(); } };
      wt.onchange = () => { cur[r].weight = Number(wt.value); paint(); };
      row.append(mk("b", "bd-style-n", ROLE_LABEL[r]), sample, field("크기 (mm)", size), field("굵기", wt), pal);
      rows.append(row); paint();
    }
    body.append(rows, mk("p", "bd-dlg-hint", "바꾸면 이 역할의 글 카드 전부에 반영됩니다. 카드 하나만 크기를 바꾼 경우는 그 카드 값이 우선입니다."));
    const ok = mk("button", "bd-primary", "적용"); ok.type = "button";
    const cancel = mk("button", "bd-btn", "취소"); cancel.type = "button"; cancel.onclick = () => d.close();
    ok.onclick = () => { api.commitStyles(cur); d.close(); };
    foot.append(cancel, ok);
    show();
  }

  // ---- command palette ----------------------------------------------------------------------------------------
  const norm = s => String(s).toLowerCase().replace(/\s+/g, "");
  function score(q, text) {
    q = norm(q); text = norm(text);
    if (!q) return 1;
    const at = text.indexOf(q);
    if (at >= 0) return 100 - at;
    let i = 0, s = 0, last = -2;
    for (const ch of q) { const j = text.indexOf(ch, i); if (j < 0) return 0; s += j === last + 1 ? 3 : 1; last = j; i = j + 1; }
    return s;
  }
  function openPalette(commands) {
    const { d, body, show } = dlg("명령 팔레트", "bd-dlg-pal");
    d.classList.add("bd-pal-dlg");
    const inp = mk("input", "bd-pal-in"); inp.type = "text"; inp.placeholder = "명령 찾기… (예: 프레임, 정렬, 페이지 2)"; inp.setAttribute("aria-label", "명령 검색");
    inp.setAttribute("role", "combobox"); inp.setAttribute("aria-expanded", "true"); inp.setAttribute("aria-controls", "bd-pal-list");
    const ul = mk("ul", "bd-pal-list"); ul.id = "bd-pal-list"; ul.setAttribute("role", "listbox");
    body.append(inp, ul);
    let items = [], idx = 0;
    const draw = () => {
      ul.replaceChildren();
      items.forEach((c, i) => {
        const li = mk("li", "bd-pal-item" + (i === idx ? " is-on" : "")); li.setAttribute("role", "option"); li.setAttribute("aria-selected", String(i === idx)); li.id = "bd-pal-" + i;
        li.append(mk("span", "", c.label)); if (c.hint) li.append(mk("kbd", "", c.hint));
        li.onmousedown = e => { e.preventDefault(); run(c); };
        ul.append(li);
      });
      inp.setAttribute("aria-activedescendant", items.length ? "bd-pal-" + idx : "");
      ul.children[idx]?.scrollIntoView({ block: "nearest" });
      if (!items.length) ul.append(mk("li", "bd-pal-empty", "맞는 명령이 없습니다."));
    };
    const filter = () => {
      items = commands.map(c => ({ c, s: score(inp.value, c.label + " " + (c.keys || "")) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.c).slice(0, 40);
      idx = 0; draw();
    };
    const run = c => { d.close(); setTimeout(() => c.run(), 0); };
    inp.addEventListener("input", filter);
    inp.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); draw(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); idx = Math.max(0, idx - 1); draw(); }
      else if (e.key === "Enter") { e.preventDefault(); if (items[idx]) run(items[idx]); }
    });
    filter(); show(); inp.focus();
  }

  // ---- presentation --------------------------------------------------------------------------------------------
  function present(startIdx = 0) {
    const ctx = api.ctx(), frames = ctx.S.frames;
    if (!frames.length || pres) return;
    api.finishEdit();
    const ov = mk("div", "bd-pres"); ov.setAttribute("role", "dialog"); ov.setAttribute("aria-label", "발표"); ov.setAttribute("aria-modal", "true"); ov.tabIndex = -1;
    const stage = mk("div", "bd-pres-stage"), count = mk("div", "bd-pres-count"); count.setAttribute("aria-live", "polite");
    const hint = mk("div", "bd-pres-hint", "← → 이동 · Esc 나가기");
    ov.append(stage, count, hint);
    root().append(ov);
    let i = Math.max(0, Math.min(frames.length - 1, startIdx));
    pres = { ov }; presExit = () => exit();
    let url = "", token = 0;
    const draw = async () => {   // each page is an isolated Blob-URL <img>: nothing from a card SVG can touch the live DOM
      const f = frames[i], my = ++token;
      count.textContent = `${i + 1} / ${frames.length}`;
      try {
        fontCssP ||= Promise.resolve(api.loadFontCss()).catch(() => "");
        const css = await fontCssP;
        if (my !== token || !pres) return;
        const next = URL.createObjectURL(new Blob([X.frameSvg(ctx, f, "screen", css)], { type: "image/svg+xml" }));
        const img = new Image();
        img.alt = `${f.page}쪽`; img.draggable = false; img.src = next;
        await img.decode().catch(() => {});
        if (my !== token || !pres) { URL.revokeObjectURL(next); return; }
        stage.replaceChildren(img);
        if (url) URL.revokeObjectURL(url);
        url = next;
      } catch (e) { stage.textContent = "이 쪽을 그리지 못했습니다."; }
    };
    const go = n => { const j = Math.max(0, Math.min(frames.length - 1, n)); if (j !== i) { i = j; draw(); } };
    const exit = () => {
      if (!pres) return;
      pres = null; presExit = null; token++;
      if (url) URL.revokeObjectURL(url);
      removeEventListener("keydown", onKey, true);
      document.removeEventListener("fullscreenchange", onFs);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      ov.remove();
      api.focusStage();
    };
    const onKey = e => {
      if (!pres) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;   // leave browser / OS shortcuts alone
      const k = e.key;
      if (k === "Escape") exit();
      else if (k === "ArrowRight" || k === "ArrowDown" || k === "PageDown" || k === " " || k === "Enter") go(i + (k === " " && e.shiftKey ? -1 : 1));
      else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp" || k === "Backspace") go(i - 1);
      else if (k === "Home") go(0);
      else if (k === "End") go(frames.length - 1);
      else return;
      e.preventDefault(); e.stopPropagation();
    };
    const onFs = () => { if (!document.fullscreenElement && pres) exit(); };
    addEventListener("keydown", onKey, true);
    document.addEventListener("fullscreenchange", onFs);
    let sx = null;
    ov.addEventListener("pointerdown", e => { sx = e.clientX; });
    ov.addEventListener("pointerup", e => {
      if (sx == null) return;
      const dx = e.clientX - sx; sx = null;
      if (Math.abs(dx) > 50) go(i + (dx < 0 ? 1 : -1));
      else if (Math.abs(dx) < 10) go(e.clientX < innerWidth * 0.3 ? i - 1 : i + 1);
    });
    draw();
    try { const p = ov.requestFullscreen?.(); p?.catch?.(() => {}); } catch { /* overlay fallback */ }
    ov.focus();
  }

  return { openExport, openPalette, openShortcuts, openInfo, openStyles, present, exportFrames, isBlocking, closeAll: () => { presExit?.(); document.querySelectorAll("#board dialog.bd-dlg").forEach(d => d.close()); } };
}
