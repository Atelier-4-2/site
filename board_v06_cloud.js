// Atelier 4·2 Board — Google Drive project sync + Cloudflare Workers Yjs real-time collaboration
const CLIENT_ID = "333501036096-o6m50cvb01b4t49kcedi4jq4a7kv42i3.apps.googleusercontent.com";
const RT_URL = "wss://atelier-realtime.ljae-archi.workers.dev";
const YJS_URL = "https://cdn.jsdelivr.net/npm/yjs@13.6.33/+esm";

let cloud = null, projId = new URLSearchParams(location.search).get("project") || localStorage.getItem("board-cloud-proj") || null;
let rt = null, ydoc = null, ymap = null, rtRoom = null, rtKey = null, applyingRemote = false;

async function ensureCloud() {
  if (cloud) return cloud;
  const m = await import("./atelier-cloud.js");
  cloud = m.createCloud({ googleClientId: CLIENT_ID, rootFolderName: "Atelier 4·2 Share" });
  try { await cloud.restore(); } catch {}
  return cloud;
}

function mkModal(title, bodyEl) {
  const bg = document.createElement("div");
  bg.className = "lw-dlg";
  bg.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);display:grid;place-items:center;padding:16px";
  const box = document.createElement("div");
  box.style.cssText = "background:#fff;color:#1d1d1f;border-radius:16px;width:min(480px,100%);max-height:85vh;overflow:auto;padding:20px;box-shadow:0 12px 36px rgba(0,0,0,.22);font-family:inherit";
  const hd = document.createElement("div");
  hd.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:12px";
  const h3 = document.createElement("h3"); h3.textContent = title; h3.style.margin = "0";
  const x = document.createElement("button"); x.type = "button"; x.textContent = "✕"; x.className = "bd-btn";
  x.onclick = () => bg.remove();
  hd.append(h3, x);
  box.append(hd, bodyEl);
  bg.append(box);
  bg.addEventListener("click", e => { if (e.target === bg) bg.remove(); });
  document.body.append(bg);
  return { close: () => bg.remove(), box };
}

export async function openCloudModal(ctx) {
  const c = await ensureCloud();
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:grid;gap:10px";
  const st = document.createElement("p"); st.style.cssText = "margin:0;font-size:13px;color:#6e6e73";
  wrap.append(st);

  const render = async () => {
    while (wrap.children.length > 1) wrap.lastChild.remove();
    const s = c.signedIn ? (c.user || {}) : null;
    if (!s) {
      st.textContent = "Google 로그인하면 본인 Drive 프로젝트 폴더(board/main.atelier.json)에 보드를 저장하고 다른 기기에서 이어서 작업할 수 있습니다.";
      const b = document.createElement("button"); b.type = "button"; b.className = "bd-btn bd-strong"; b.textContent = "Google 로그인";
      b.onclick = async () => { try { await c.signIn("google"); await render(); } catch { st.textContent = "로그인을 완료하지 못했습니다."; } };
      wrap.append(b);
      return;
    }
    st.textContent = `${s.emailAddress || s.displayName || "Google Drive"} 연결됨`;
    const list = await c.listProjects();
    const sel = document.createElement("select");
    sel.style.cssText = "min-height:38px;border:1px solid #d2d2d7;border-radius:10px;padding:0 10px";
    for (const p of list) {
      const o = document.createElement("option"); o.value = p.id; o.textContent = p.name;
      if (p.id === projId) o.selected = true;
      sel.append(o);
    }
    if (!projId && list.length) { projId = list[0].id; try { localStorage.setItem("board-cloud-proj", projId); } catch {} }
    sel.onchange = () => { projId = sel.value; try { localStorage.setItem("board-cloud-proj", projId); } catch {} };

    const row = document.createElement("div"); row.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";
    const bSave = document.createElement("button"); bSave.type = "button"; bSave.className = "bd-btn bd-strong"; bSave.textContent = "Drive 프로젝트에 저장";
    const bLoad = document.createElement("button"); bLoad.type = "button"; bLoad.className = "bd-btn"; bLoad.textContent = "Drive에서 열기";
    const bOut = document.createElement("button"); bOut.type = "button"; bOut.className = "bd-btn"; bOut.textContent = "로그아웃";

    bSave.onclick = async () => {
      if (!projId) { st.textContent = "먼저 Hub 또는 Share에서 프로젝트를 만들어 주세요."; return; }
      st.textContent = "Drive에 저장하는 중…";
      try {
        const p = await c.openProject(projId);
        const snap = ctx.exportSnapshot();
        await p.writeJson("board/main.atelier.json", snap, {});
        st.textContent = "Drive 프로젝트에 저장했습니다.";
        ctx.status("Drive에 보드를 저장했습니다.");
      } catch (e) { st.textContent = "저장 실패: " + (e.message || e); }
    };
    bLoad.onclick = async () => {
      if (!projId) return;
      st.textContent = "Drive에서 보드를 불러오는 중…";
      try {
        const p = await c.openProject(projId);
        const r = await p.readJson("board/main.atelier.json");
        if (!r || !r.data) throw new Error("저장된 보드가 없습니다.");
        ctx.importSnapshot(r.data);
        st.textContent = "Drive에서 보드를 불러왔습니다.";
        ctx.status("Drive 보드를 열었습니다.");
      } catch (e) { st.textContent = "불러오기 실패: " + (e.message || e); }
    };
    bOut.onclick = async () => { await c.signOut(); await render(); };
    row.append(bSave, bLoad, bOut);
    wrap.append(sel, row);
  };
  const modal = mkModal("Drive 프로젝트 (Board)", wrap);
  await render();
  return modal;
}

export async function startCollab(ctx, roomId, roomKey) {
  if (rt) { try { rt.destroy(); } catch {} rt = null; }
  const [Y, rtMod] = await Promise.all([import(YJS_URL), import("./atelier-realtime.js")]);
  rtRoom = roomId || ("b" + Math.random().toString(36).slice(2, 10));
  rtKey = roomKey || rtMod.generateRoomKey();
  ydoc = new Y.Doc();
  ymap = ydoc.getMap("board");
  const awareness = rtMod.createAwareness(ydoc);
  awareness.setLocalState({ name: ctx.author || "학생", ts: Date.now() });

  ymap.observe(() => {
    if (applyingRemote) return;
    const raw = ymap.get("doc");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      applyingRemote = true;
      ctx.importSnapshot(parsed, true);
    } catch {} finally { applyingRemote = false; }
  });

  rt = rtMod.connect({ url: RT_URL, roomId: rtRoom, roomKey: rtKey, doc: ydoc, awareness });
  rt.on("status", (s) => {
    if (s === "live") {
      ctx.status("실시간 공동 편집 연결됨");
      if (!ymap.get("doc") && !roomId) {
        applyingRemote = true;
        try { ymap.set("doc", JSON.stringify(ctx.exportSnapshot())); } finally { applyingRemote = false; }
      }
    } else if (s === "fallback-quota") {
      ctx.status("실시간 무료 한도 도달 — Drive 저장 모드로 전환하세요.");
    } else if (s === "offline") {
      ctx.status("실시간 연결 끊김");
    }
  });
  const shareUrl = `${location.origin}${location.pathname}#board&room=${encodeURIComponent(rtRoom)}&key=${encodeURIComponent(rtKey)}`;
  return { roomId: rtRoom, roomKey: rtKey, shareUrl };
}

export function pushCollabState(ctx) {
  if (!rt || !ymap || applyingRemote) return;
  try {
    applyingRemote = true;
    ymap.set("doc", JSON.stringify(ctx.exportSnapshot()));
  } catch {} finally { applyingRemote = false; }
}

export function openCollabModal(ctx) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:grid;gap:10px";
  const info = document.createElement("p");
  info.style.cssText = "margin:0;font-size:13px;color:#6e6e73";
  info.textContent = rt
    ? `실시간 방 연결 중 (${rtRoom}). 아래 링크를 팀원에게 공유하면 같은 보드를 동시에 편집할 수 있습니다.`
    : "팀원들과 같은 보드 위에서 실시간으로 함께 배치·메모합니다. (Cloudflare 무료 서버 · 카드 등록 없음)";
  const urlIn = document.createElement("input");
  urlIn.readOnly = true;
  urlIn.style.cssText = "min-height:36px;border:1px solid #d2d2d7;border-radius:10px;padding:0 10px;font-size:12.5px;background:#f5f5f7";
  urlIn.value = rt ? `${location.origin}${location.pathname}#board&room=${encodeURIComponent(rtRoom)}&key=${encodeURIComponent(rtKey)}` : "";
  urlIn.hidden = !rt;

  const row = document.createElement("div"); row.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";
  const bStart = document.createElement("button"); bStart.type = "button"; bStart.className = "bd-btn bd-strong";
  bStart.textContent = rt ? "링크 복사" : "실시간 방 만들고 링크 복사";
  const bStop = document.createElement("button"); bStop.type = "button"; bStop.className = "bd-btn"; bStop.textContent = "연결 끊기"; bStop.hidden = !rt;

  bStart.onclick = async () => {
    if (!rt) {
      info.textContent = "실시간 방을 여는 중…";
      const r = await startCollab(ctx);
      urlIn.value = r.shareUrl; urlIn.hidden = false; bStop.hidden = false; bStart.textContent = "링크 복사";
      info.textContent = `실시간 방 열림 (${r.roomId}). 링크가 복사되었습니다.`;
    }
    try { await navigator.clipboard.writeText(urlIn.value); ctx.status("실시간 편집 링크를 복사했습니다."); } catch {}
  };
  bStop.onclick = () => {
    if (rt) { try { rt.destroy(); } catch {} rt = null; ydoc = null; ymap = null; }
    urlIn.hidden = true; bStop.hidden = true; bStart.textContent = "실시간 방 만들고 링크 복사";
    info.textContent = "실시간 연결을 종료했습니다.";
  };
  row.append(bStart, bStop);
  wrap.append(info, urlIn, row);
  return mkModal("실시간 공동 편집 (Beta)", wrap);
}

export function checkCollabHash(ctx) {
  const m = /room=([^&]+)&key=([^&]+)/.exec(location.hash || "");
  if (m) startCollab(ctx, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
}
