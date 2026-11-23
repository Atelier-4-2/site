// atelier-realtime.js — Atelier 4·2 실시간 방 클라이언트 (독립 ES 모듈)
//
//   import { connect, generateRoomKey } from './atelier-realtime.js';
//   const doc = new Y.Doc();                       // 같은 yjs URL에서 import 할 것
//   const rt = connect({ url: 'wss://atelier-realtime.<계정>.workers.dev', roomId, roomKey, doc, awareness });
//   rt.on('status', (s, info) => { ... });         // 'live' | 'connecting' | 'fallback-quota' | 'offline'
//   rt.destroy();
//
// 'fallback-quota' 가 오면 호출자는 Drive 자동 저장 + 20초 변경 감지로 전환해야 한다.
// 이 모듈은 그동안 낮은 빈도로 재연결을 시도하고, 성공하면 'live' 를 다시 내보낸다.
//
// awareness: y-protocols 의 Awareness 인스턴스(덕 타이핑) 또는 createAwareness(doc) 결과.
// yjs 와 y-protocols 를 같은 CDN 버전으로 맞춰 쓰면 인스턴스 중복 문제가 없다.
import * as Y from 'https://cdn.jsdelivr.net/npm/yjs@13.6.33/+esm';

export const CLOSE = { BAD_KEY: 4001, QUOTA_ROOM: 4002, QUOTA_CONN: 4003, BAD_REQUEST: 4400, ORIGIN: 4403, DELETED: 4410, RATE: 4429, TOO_BIG: 1009 };
const MSG_SYNC = 0, MSG_AWARENESS = 1;
const SYNC_STEP1 = 0, SYNC_STEP2 = 1, SYNC_UPDATE = 2;
const MAX_MESSAGE = 1048576;
const MIN_BATCH_MS = 300;
const OUTDATED_MS = 30000;

// ---------- 최소 varint 코덱 (lib0 호환 와이어 포맷) ----------
class Enc {
  constructor() { this.a = []; }
  uint(n) { while (n > 127) { this.a.push((n & 127) | 128); n = Math.floor(n / 128); } this.a.push(n & 127); return this; }
  bytes(u8) { this.uint(u8.length); for (let i = 0; i < u8.length; i++) this.a.push(u8[i]); return this; }
  str(s) { return this.bytes(new TextEncoder().encode(s)); }
  out() { return Uint8Array.from(this.a); }
}
class Dec {
  constructor(u8) { this.u = u8; this.p = 0; }
  uint() { let n = 0, m = 1, b; do { b = this.u[this.p++]; n += (b & 127) * m; m *= 128; } while (b & 128); return n; }
  bytes() { const l = this.uint(); const r = this.u.subarray(this.p, this.p + l); this.p += l; return r; }
  str() { return new TextDecoder().decode(this.bytes()); }
  get done() { return this.p >= this.u.length; }
}
function frame(type, sub, payload) {
  // 큰 payload 도 안전하게: 배열 push 대신 직접 조립
  const head = new Enc().uint(type);
  if (sub !== null) head.uint(sub);
  const lenEnc = new Enc().uint(payload.length).out();
  const h = head.out();
  const out = new Uint8Array(h.length + lenEnc.length + payload.length);
  out.set(h, 0); out.set(lenEnc, h.length); out.set(payload, h.length + lenEnc.length);
  return out;
}

// ---------- awareness 와이어 포맷 ----------
function encodeAwareness(aw, ids) {
  const e = new Enc().uint(ids.length);
  for (const id of ids) {
    const st = aw.states.get(id) ?? null;
    const meta = aw.meta.get(id);
    e.uint(id).uint(meta ? meta.clock : 0).str(JSON.stringify(st));
  }
  return e.out();
}
function applyAwareness(aw, u8, origin) {
  const d = new Dec(u8);
  const n = d.uint();
  const now = Date.now();
  const added = [], updated = [], removed = [], filtered = [];
  for (let i = 0; i < n; i++) {
    const id = d.uint(), clock = d.uint(), state = JSON.parse(d.str());
    if (id === aw.clientID) continue; // 내 상태는 서버가 되돌려도 무시
    const prev = aw.meta.get(id);
    const prevState = aw.states.get(id);
    const curClock = prev === undefined ? 0 : prev.clock;
    if (prev === undefined || curClock < clock || (curClock === clock && state === null && aw.states.has(id))) {
      if (state === null) aw.states.delete(id); else aw.states.set(id, state);
      aw.meta.set(id, { clock, lastUpdated: now });
      if (prev === undefined && state !== null) added.push(id);
      else if (prev !== undefined && state === null) removed.push(id);
      else if (state !== null) {
        if (JSON.stringify(state) !== JSON.stringify(prevState)) filtered.push(id);
        updated.push(id);
      }
    }
  }
  if (added.length || filtered.length || removed.length) aw.emit('change', [{ added, updated: filtered, removed }, origin]);
  if (added.length || updated.length || removed.length) aw.emit('update', [{ added, updated, removed }, origin]);
}

// 단순 Awareness (y-protocols 없이 쓰고 싶을 때). 필드 이름은 y-protocols 와 동일.
export function createAwareness(doc) {
  const handlers = new Map();
  const aw = {
    doc, clientID: doc.clientID, states: new Map(), meta: new Map(),
    on(ev, f) { (handlers.get(ev) || handlers.set(ev, new Set()).get(ev)).add(f); },
    off(ev, f) { handlers.get(ev)?.delete(f); },
    emit(ev, args) { handlers.get(ev)?.forEach((f) => f(...args)); },
    getStates() { return aw.states; },
    getLocalState() { return aw.states.get(aw.clientID) ?? null; },
    setLocalState(state) {
      const id = aw.clientID, prev = aw.states.get(id), m = aw.meta.get(id);
      const clock = m === undefined ? 1 : m.clock + 1; // y-protocols 와 같이 0 은 쓰지 않음(서버가 무시함)
      if (state === null) aw.states.delete(id); else aw.states.set(id, state);
      aw.meta.set(id, { clock, lastUpdated: Date.now() });
      const added = [], updated = [], removed = [];
      if (state === null) removed.push(id); else if (prev == null) added.push(id); else updated.push(id);
      aw.emit('update', [{ added, updated, removed }, 'local']);
      if (JSON.stringify(prev) !== JSON.stringify(state)) aw.emit('change', [{ added, updated, removed }, 'local']);
    },
    setLocalStateField(k, v) { const s = aw.getLocalState(); if (s !== null) aw.setLocalState({ ...s, [k]: v }); },
    destroy() { aw.setLocalState(null); handlers.clear(); },
  };
  return aw;
}

export function generateRoomKey() {
  const b = crypto.getRandomValues(new Uint8Array(16)); // 128비트
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function httpBase(url) {
  return url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
}

/**
 * 방에 연결한다.
 * @param {object} o
 * @param {string} o.url        서버 주소 (wss://… 또는 https://…)
 * @param {string} o.roomId
 * @param {string} o.roomKey    128비트 base64url
 * @param {Y.Doc}  o.doc
 * @param {object} [o.awareness]
 * @param {number} [o.batchMs=300]  송신 묶음 간격 (300 미만으로는 내려가지 않음)
 * @param {function} [o.WebSocket]  테스트/Node 용 WebSocket 구현
 */
export function connect(o) {
  const { url, roomId, roomKey, doc, awareness } = o;
  const WS = o.WebSocket || globalThis.WebSocket;
  const batchMs = Math.max(MIN_BATCH_MS, o.batchMs || MIN_BATCH_MS);
  const wsUrl = httpBase(url).replace(/^http/, 'ws') + '/room/' + encodeURIComponent(roomId) + '?k=' + encodeURIComponent(roomKey);

  const listeners = { status: new Set(), error: new Set() };
  const emit = (ev, ...a) => listeners[ev].forEach((f) => { try { f(...a); } catch (e) { console.error(e); } });

  let ws = null, status = null, destroyed = false, retryTimer = null, flushTimer = null;
  let attempts = 0, failsWithoutOpen = 0, gotServerMsg = false;
  let pendingUpdates = [], awarenessDirty = false;
  const ORIGIN = Symbol('atelier-realtime');

  function setStatus(s, info) {
    if (s === status && !info) return;
    status = s;
    emit('status', s, info || {});
  }

  function send(u8) {
    if (ws && ws.readyState === 1) {
      if (u8.length > MAX_MESSAGE) {
        emit('error', { code: 'message-too-large', message: 'update exceeds 1 MB; large assets must go to Drive' });
        setStatus('fallback-quota', { reason: 'message-too-large' });
        stopRetry(); scheduleRetry(300000);
        try { ws.close(1000); } catch {}
        return false;
      }
      ws.send(u8);
      return true;
    }
    return false;
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, batchMs);
  }
  function flush() {
    flushTimer = null;
    if (!ws || ws.readyState !== 1 || !gotServerMsg) { pendingUpdates = []; return; } // 재접속 시 sync 가 따라잡음
    if (pendingUpdates.length) {
      const merged = pendingUpdates.length === 1 ? pendingUpdates[0] : Y.mergeUpdates(pendingUpdates);
      pendingUpdates = [];
      send(frame(MSG_SYNC, SYNC_UPDATE, merged));
    }
    if (awarenessDirty && awareness) {
      awarenessDirty = false;
      send(frame(MSG_AWARENESS, null, encodeAwareness(awareness, [doc.clientID])));
    }
  }

  const onDocUpdate = (update, origin) => {
    if (origin === ORIGIN) return;
    pendingUpdates.push(update);
    scheduleFlush();
  };
  doc.on('update', onDocUpdate);

  const onAwarenessUpdate = ({ added, updated, removed }, origin) => {
    if (origin === ORIGIN) return;
    if ([...added, ...updated, ...removed].includes(doc.clientID)) {
      awarenessDirty = true;
      scheduleFlush();
    }
  };
  if (awareness) awareness.on('update', onAwarenessUpdate);

  // 오래된(응답 없는) 원격 awareness 정리
  const gcTimer = awareness ? setInterval(() => {
    const now = Date.now(), gone = [];
    awareness.meta.forEach((m, id) => {
      if (id !== doc.clientID && now - m.lastUpdated >= OUTDATED_MS && awareness.states.has(id)) gone.push(id);
    });
    if (gone.length) {
      gone.forEach((id) => awareness.states.delete(id));
      const ev = { added: [], updated: [], removed: gone };
      awareness.emit('change', [ev, ORIGIN]);
      awareness.emit('update', [ev, ORIGIN]);
    }
  }, 10000) : null;

  function stopRetry() { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } }
  function scheduleRetry(ms) {
    stopRetry();
    if (destroyed) return;
    retryTimer = setTimeout(open, ms);
  }
  const backoff = () => Math.min(30000, 1000 * 2 ** Math.min(attempts, 5)) * (0.75 + Math.random() * 0.5);

  function open() {
    retryTimer = null;
    if (destroyed) return;
    if (status !== 'fallback-quota') setStatus('connecting');
    gotServerMsg = false;
    let sock;
    try { sock = new WS(wsUrl); } catch (e) { onFailure(); return; }
    sock.binaryType = 'arraybuffer';
    ws = sock;
    attempts++;

    sock.onmessage = (ev) => {
      if (sock !== ws) return;
      if (typeof ev.data === 'string') {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'error') emit('error', { code: m.error, message: m.message || m.error });
        } catch {}
        return;
      }
      const first = !gotServerMsg;
      gotServerMsg = true;
      if (first) {
        failsWithoutOpen = 0; attempts = 0;
        setStatus('live');
        // 우리 쪽 sync step1 전송 + 로컬 awareness 알림
        send(frame(MSG_SYNC, SYNC_STEP1, Y.encodeStateVector(doc)));
        if (awareness && awareness.getLocalState() !== null) { awarenessDirty = true; scheduleFlush(); }
      }
      handle(new Uint8Array(ev.data));
    };
    sock.onclose = (ev) => {
      if (sock !== ws) return;
      ws = null;
      pendingUpdates = [];
      if (destroyed) return;
      const code = ev.code;
      if (code === CLOSE.BAD_KEY || code === CLOSE.DELETED || code === CLOSE.ORIGIN || code === CLOSE.BAD_REQUEST) {
        const reason = { [CLOSE.BAD_KEY]: 'bad-key', [CLOSE.DELETED]: 'room-deleted', [CLOSE.ORIGIN]: 'origin-not-allowed', [CLOSE.BAD_REQUEST]: 'bad-request' }[code];
        emit('error', { code: reason, message: ev.reason || reason });
        setStatus('offline', { reason, retry: false }); // 재시도 안 함
        return;
      }
      if (code === CLOSE.QUOTA_ROOM || code === CLOSE.QUOTA_CONN || code === CLOSE.RATE || code === CLOSE.TOO_BIG) {
        const reason = { [CLOSE.QUOTA_ROOM]: 'quota-room-size', [CLOSE.QUOTA_CONN]: 'quota-connections', [CLOSE.RATE]: 'rate-limited', [CLOSE.TOO_BIG]: 'message-too-large' }[code];
        setStatus('fallback-quota', { reason });
        scheduleRetry(code === CLOSE.RATE ? 30000 : 300000 * (0.8 + Math.random() * 0.4));
        return;
      }
      if (!gotServerMsg) onFailure(); else { setStatus('connecting'); scheduleRetry(backoff()); }
    };
    sock.onerror = () => {}; // close 에서 처리
  }

  // 연결을 한 번도 못 맺고 실패: 오프라인인지, 플랫폼 한도(일일 요청 초과 등)인지 구분
  async function onFailure() {
    failsWithoutOpen++;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (offline) { setStatus('offline', { reason: 'network', retry: true }); scheduleRetry(backoff()); return; }
    if (failsWithoutOpen >= 3) {
      let reason = 'unreachable';
      try {
        const r = await fetch(httpBase(url) + '/health', { cache: 'no-store' });
        reason = r.ok ? 'unreachable' : 'platform-quota';
      } catch { reason = 'unreachable'; }
      if (destroyed) return;
      setStatus('fallback-quota', { reason }); // 서버 불가/일일 한도 → 호출자는 Drive 저장으로 전환
      scheduleRetry(300000 * (0.8 + Math.random() * 0.4));
      return;
    }
    setStatus('connecting');
    scheduleRetry(backoff());
  }

  function handle(u8) {
    const d = new Dec(u8);
    const type = d.uint();
    if (type === MSG_SYNC) {
      const sub = d.uint();
      const payload = d.bytes();
      if (sub === SYNC_STEP1) {
        send(frame(MSG_SYNC, SYNC_STEP2, Y.encodeStateAsUpdate(doc, payload)));
      } else if (sub === SYNC_STEP2 || sub === SYNC_UPDATE) {
        Y.applyUpdate(doc, payload, ORIGIN);
      }
    } else if (type === MSG_AWARENESS && awareness) {
      applyAwareness(awareness, d.bytes(), ORIGIN);
    }
  }

  const onOnline = () => { if (!destroyed && (!ws) && status !== 'live') { stopRetry(); failsWithoutOpen = 0; open(); } };
  if (typeof addEventListener === 'function') addEventListener('online', onOnline);

  setTimeout(open, 0); // 호출자가 status 리스너를 먼저 붙일 수 있게 한 틱 미룸

  return {
    get status() { return status; },
    on(ev, f) { listeners[ev]?.add(f); return () => listeners[ev]?.delete(f); },
    /** 방을 서버에서 완전히 삭제 (roomKey 필요) */
    async deleteRoom() {
      const r = await fetch(httpBase(url) + '/room/' + encodeURIComponent(roomId), { method: 'DELETE', headers: { 'X-Room-Key': roomKey } });
      return r.json().catch(() => ({ ok: r.ok }));
    },
    /** 지금 즉시 재연결 시도 (fallback 상태에서 사용자가 "다시 시도" 누를 때) */
    retryNow() { if (!ws) { stopRetry(); failsWithoutOpen = 0; open(); } },
    destroy() {
      destroyed = true;
      stopRetry();
      if (flushTimer) clearTimeout(flushTimer);
      if (gcTimer) clearInterval(gcTimer);
      doc.off('update', onDocUpdate);
      if (awareness) awareness.off('update', onAwarenessUpdate);
      if (typeof removeEventListener === 'function') removeEventListener('online', onOnline);
      if (awareness && ws && ws.readyState === 1) {
        // 떠난다고 알림 (로컬 awareness 제거)
        try { awareness.setLocalState(null); awarenessDirty = true; flushNow(); } catch {}
      }
      try { ws && ws.close(1000); } catch {}
      ws = null;
    },
  };

  function flushNow() {
    if (awarenessDirty && awareness) { awarenessDirty = false; send(frame(MSG_AWARENESS, null, encodeAwareness(awareness, [doc.clientID]))); }
  }
}
