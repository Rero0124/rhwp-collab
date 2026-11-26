// cc-rhwp 공동편집 중계 서버. 프로토콜은 docs/collab-design.md §5 + docs/collab-stage2.md §7.
//
// 서버는 순서만 정한다. 문서를 해석하지 않고, 방(room)은 메모리에만 둔다.
//
//   C→S hello    {type, room, clientId, name, engine}   engine = 엔진 지문(방의 첫 참여자와 같아야 함)
//   S→C welcome  {type, seq, base: base64|null, log: [{seq, clientId, entries}], resync?: true}
//   S→C incompatible {type, engine}                    지문이 다르면 거절하고 연결을 닫는다
//   C→S base     {type, data: base64}                  welcome.base 가 null 이었던 참여자만
//   C→S ops      {type, base: lastSeq, entries}        entries = 기록 열(op·state)
//   S→C ops      {type, seq, clientId, entries}        모두에게 (보낸 사람에게는 ack)
//   S→C reject   {type, seq}                           base !== room.seq 일 때 보낸 사람에게만
//   C→S resync   {type}                                → welcome (+resync: true)
//   C→S digest   {type, seq, digest}
//   S→C diverged {type, seq}                           같은 seq 에 다른 digest 가 오면 모두에게
//   C→S cursor   {type, seq, caret}                    내 캐럿(텍스트 좌표, seq 시점) — 저장하지 않고 다른 참여자에게만
//   S→C cursor   {type, clientId, name, seq, caret}    (참여자마다 초당 20회까지, 넘치면 버림) R10
//   S→C cursor-leave {type, clientId}                 참여자가 나가면
//   S→C too-large {type, what, bytes, limit}           메시지가 상한(COLLAB_MAX_MESSAGE_BYTES, 기본 64MB)을
//                                                      넘음 — 그 메시지는 버린다. base 였으면 연결을 닫는다
//
// welcome 에는 `maxMessageBytes` 가 실린다(클라이언트가 보내기 전에 미리 거른다, R12).
// state 기록(문서 전체)은 새 기준점이다: welcome 은 마지막 state(없으면 처음 base)와 그 뒤 항목만 준다.
// 시험용: 환경 변수 COLLAB_DELAY_MS 가 있으면 모든 송신을 그만큼 늦춘다(연결마다 순서 유지).
//
// base 경쟁: 빈 방에 처음 들어온 참여자 하나만 `base: null` welcome 을 받는다(base 담당).
// base 가 올 때까지 들어온 다른 참여자의 welcome 은 미뤘다가 base 를 받은 뒤 보낸다. 담당이
// base 를 보내기 전에 나가면 기다리던 다음 참여자에게 담당을 넘긴다. 이렇게 해야 모두가 같은
// base 바이트에서 출발한다.
import { WebSocketServer } from 'ws';
import { pathToFileURL } from 'node:url';

/** digest 를 보관하는 최근 seq 수 (§5 digest 규칙) */
const DIGEST_WINDOW = 64;

function createRoom(name) {
  return {
    name,
    /** 엔진 지문 — 방의 첫 참여자가 정한다. 버전이 다른 클라이언트는 같은 기록을 다르게 재생할 수 있다. */
    engine: undefined,
    seq: 0,
    /** @type {string|null} base64 */
    base: null,
    /** base 를 보내기로 한 참여자. base 가 정해지면 null */
    baseOwner: null,
    /** welcome 을 기다리는 참여자 (base 대기) */
    waiting: [],
    /** 기준점(base 또는 마지막 state) 이후의 항목. @type {Array<{seq:number, clientId:string, entries:unknown[]}>} */
    log: [],
    clients: new Set(),
    /** @type {Map<number, {digest:string, clientId:string}>} */
    digests: new Map(),
    /** diverged 를 이미 방송한 seq */
    diverged: new Set(),
  };
}

export const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export function startServer({
  port = 8787, host = '127.0.0.1', log = console.log,
  delayMs = Number(process.env.COLLAB_DELAY_MS ?? 0),
  maxMessageBytes = Number(process.env.COLLAB_MAX_MESSAGE_BYTES ?? DEFAULT_MAX_MESSAGE_BYTES),
} = {}) {
  /** @type {Map<string, ReturnType<typeof createRoom>>} */
  const rooms = new Map();
  // ws 의 하드 상한은 넉넉히 두고(넘으면 ws 가 1009 로 끊는다) 상한 판정은 메시지 처리에서 한다 — 보낸 쪽에
  // 이유를 알려 주기 위해서다.
  const wss = new WebSocketServer({ port, host, maxPayload: Math.max(maxMessageBytes * 2, 1024 * 1024) });

  // 연결마다 모든 송신이 같은 경로(같은 지연)를 지나므로 순서가 지켜진다.
  const sendRaw = (ws, data) => {
    const go = () => { if (ws.readyState === ws.OPEN) ws.send(data); };
    if (delayMs > 0) setTimeout(go, delayMs); else go();
  };
  const send = (ws, msg) => sendRaw(ws, JSON.stringify(msg));
  const broadcast = (room, msg) => {
    const data = JSON.stringify(msg);
    for (const ws of room.clients) sendRaw(ws, data);
  };
  const who = (ws) => `${ws.meta?.name ?? '?'}(${(ws.meta?.clientId ?? '?').slice(0, 8)})`;

  const welcome = (room, ws, base, extra = {}) => {
    room.clients.add(ws);
    send(ws, { type: 'welcome', seq: room.seq, base, log: base === null ? [] : room.log, maxMessageBytes, ...extra });
    log(`[${room.name}] welcome${extra.resync ? '(resync)' : ''} ${who(ws)} seq=${room.seq} base=${base === null ? 'null (담당)' : `${base.length}B64`} log=${base === null ? 0 : room.log.length} 참여자=${room.clients.size}`);
  };

  const handleHello = (ws, msg) => {
    if (ws.meta) return send(ws, { type: 'error', error: 'hello 는 한 번만 보낸다' });
    if (typeof msg.room !== 'string' || !msg.room || typeof msg.clientId !== 'string' || !msg.clientId) {
      return send(ws, { type: 'error', error: 'hello 에 room·clientId 가 필요하다' });
    }
    let room = rooms.get(msg.room);
    if (!room) {
      room = createRoom(msg.room);
      rooms.set(msg.room, room);
      log(`[${room.name}] 방 생성`);
    }
    const engine = typeof msg.engine === 'string' ? msg.engine : '';
    if (room.engine === undefined) {
      room.engine = engine;
    } else if (room.engine !== engine) {
      log(`[${room.name}] incompatible ${msg.name ?? '?'} 엔진 ${engine || '(없음)'} ≠ 방 ${room.engine || '(없음)'}`);
      send(ws, { type: 'incompatible', engine: room.engine });
      setTimeout(() => ws.close(), delayMs + 50);
      return;
    }
    ws.meta = { room: msg.room, clientId: msg.clientId, name: typeof msg.name === 'string' ? msg.name : '' };
    if (room.base !== null) return welcome(room, ws, room.base);
    if (room.baseOwner === null) {
      room.baseOwner = ws;
      return welcome(room, ws, null);
    }
    room.waiting.push(ws);
    log(`[${room.name}] ${who(ws)} base 대기 (담당 ${who(room.baseOwner)})`);
  };

  const handleBase = (ws, room, msg) => {
    if (room.base !== null || room.baseOwner !== ws) {
      log(`[${room.name}] base 무시: ${who(ws)} 는 담당이 아니거나 이미 정해짐`);
      return send(ws, { type: 'error', error: 'base 를 보낼 차례가 아니다' });
    }
    if (typeof msg.data !== 'string' || !msg.data) {
      return send(ws, { type: 'error', error: 'base.data 가 비었다' });
    }
    room.base = msg.data;
    room.baseOwner = null;
    log(`[${room.name}] base 확정 by ${who(ws)} (${msg.data.length}B64)`);
    const waiting = room.waiting.splice(0);
    for (const w of waiting) if (w.readyState === w.OPEN) welcome(room, w, room.base);
  };

  const handleOps = (ws, room, msg) => {
    if (!room.clients.has(ws)) return send(ws, { type: 'error', error: 'welcome 전에는 ops 를 보낼 수 없다' });
    if (!Array.isArray(msg.entries) || msg.entries.length === 0) {
      return send(ws, { type: 'error', error: 'entries 는 비어 있지 않은 배열이어야 한다' });
    }
    if (room.base === null || msg.base !== room.seq) {
      log(`[${room.name}] reject ${who(ws)} base=${msg.base} room.seq=${room.seq}${room.base === null ? ' (base 없음)' : ''}`);
      return send(ws, { type: 'reject', seq: room.seq });
    }
    room.seq += 1;
    const entry = { seq: room.seq, clientId: ws.meta.clientId, entries: msg.entries };
    // state 기록은 새 기준점 — 그 앞의 로그는 늦은 참여·재동기화에 더 필요 없다.
    const lastState = msg.entries.findLastIndex((e) => e?.kind === 'state' && typeof e.data === 'string');
    if (lastState >= 0) {
      room.base = msg.entries[lastState].data;
      const rest = msg.entries.slice(lastState + 1);
      room.log = rest.length > 0 ? [{ seq: room.seq, clientId: ws.meta.clientId, entries: rest }] : [];
    } else {
      room.log.push(entry);
    }
    const kinds = msg.entries.map((e) => (e?.kind === 'state' ? 'STATE' : e?.m)).join(',');
    log(`[${room.name}] seq=${room.seq} ${who(ws)} entries=${msg.entries.length} [${kinds.length > 160 ? `${kinds.slice(0, 160)}…` : kinds}]${lastState >= 0 ? ' (새 기준점)' : ''}`);
    broadcast(room, { type: 'ops', ...entry });
  };

  const handleDigest = (ws, room, msg) => {
    if (!room.clients.has(ws)) return;
    const { seq, digest } = msg;
    if (!Number.isInteger(seq) || typeof digest !== 'string' || !digest) {
      return send(ws, { type: 'error', error: 'digest 에 seq·digest 가 필요하다' });
    }
    // 보관 범위 밖(지나간 seq)이나 아직 없는 seq 는 무시한다.
    if (seq > room.seq || seq <= room.seq - DIGEST_WINDOW) return;
    const first = room.digests.get(seq);
    if (!first) {
      room.digests.set(seq, { digest, clientId: ws.meta.clientId });
      for (const key of room.digests.keys()) if (key <= room.seq - DIGEST_WINDOW) room.digests.delete(key);
      log(`[${room.name}] digest seq=${seq} ${who(ws)} ${digest.slice(0, 12)}`);
      return;
    }
    if (first.digest === digest) {
      log(`[${room.name}] digest seq=${seq} ${who(ws)} 일치`);
      return;
    }
    log(`[${room.name}] DIVERGED seq=${seq} ${who(ws)} ${digest.slice(0, 12)} ≠ ${first.digest.slice(0, 12)} (${first.clientId.slice(0, 8)})`);
    if (!room.diverged.has(seq)) {
      room.diverged.add(seq);
      broadcast(room, { type: 'diverged', seq });
    }
  };

  const handleClose = (ws) => {
    const room = ws.meta && rooms.get(ws.meta.room);
    if (!room) return;
    room.clients.delete(ws);
    room.waiting = room.waiting.filter((w) => w !== ws);
    log(`[${room.name}] 나감 ${who(ws)} 참여자=${room.clients.size}`);
    broadcast(room, { type: 'cursor-leave', clientId: ws.meta.clientId });
    if (room.baseOwner === ws) {
      // base 를 보내기 전에 나갔다. 기다리던 다음 참여자에게 담당을 넘긴다.
      room.baseOwner = null;
      const next = room.waiting.shift();
      if (next) {
        room.baseOwner = next;
        welcome(room, next, null);
      }
    }
  };

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      if (data.length > maxMessageBytes) {
        // 본문을 해석하지 않고 종류만 본다(앞부분에 type 이 있다).
        const what = /"type"\s*:\s*"([a-z-]+)"/.exec(data.subarray(0, 64).toString())?.[1] ?? '?';
        log(`[${ws.meta?.room ?? '-'}] too-large ${who(ws)} ${what} ${data.length}B > ${maxMessageBytes}B`);
        send(ws, { type: 'too-large', what, bytes: data.length, limit: maxMessageBytes });
        if (what === 'base') setTimeout(() => ws.close(), delayMs + 50);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return send(ws, { type: 'error', error: 'JSON 이 아니다' });
      }
      if (msg?.type === 'hello') return handleHello(ws, msg);
      const room = ws.meta && rooms.get(ws.meta.room);
      if (!room) return send(ws, { type: 'error', error: 'hello 를 먼저 보낸다' });
      switch (msg.type) {
        case 'base': return handleBase(ws, room, msg);
        case 'ops': return handleOps(ws, room, msg);
        case 'digest': return handleDigest(ws, room, msg);
        case 'cursor': {
          // R10: 캐럿 중계. 순서·저장 없음, 참여자마다 초당 20회까지.
          const now = Date.now();
          const t = ws.cursorTimes ?? (ws.cursorTimes = []);
          while (t.length && now - t[0] > 1000) t.shift();
          if (t.length >= 20) return;
          t.push(now);
          const out = JSON.stringify({ type: 'cursor', clientId: ws.meta.clientId, name: ws.meta.name, seq: msg.seq, caret: msg.caret ?? null });
          for (const other of room.clients) if (other !== ws) sendRaw(other, out);
          return;
        }
        case 'resync':
          if (room.base === null) return send(ws, { type: 'error', error: '아직 base 가 없다' });
          return welcome(room, ws, room.base, { resync: true });
        default: return send(ws, { type: 'error', error: `모르는 type: ${msg.type}` });
      }
    });
    ws.on('close', () => handleClose(ws));
    ws.on('error', (error) => log(`ws 오류 ${who(ws)}: ${error.message}`));
  });

  return {
    wss,
    rooms,
    /** 실제로 열린 포트 (port: 0 으로 띄웠을 때) */
    get port() { return wss.address().port; },
    ready: new Promise((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    }),
    close: () => new Promise((resolve) => {
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => resolve());
    }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 8787);
  const server = startServer({ port, host: process.env.HOST ?? '127.0.0.1' });
  server.ready.then(
    () => console.log(`cc-rhwp collab server: ws://${process.env.HOST ?? '127.0.0.1'}:${server.port}`),
    (error) => { console.error(error.message); process.exit(1); },
  );
}
