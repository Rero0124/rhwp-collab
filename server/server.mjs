// cc-rhwp 공동편집 중계 서버. 프로토콜은 docs/collab-design.md §5 + docs/collab-stage2.md §7.
//
// 서버는 순서만 정한다. 문서를 해석하지 않고, 방(room)은 메모리에만 둔다.
//
//   C→S hello    {type, room, clientId, name, engine, lastSeq?}   engine = 엔진 지문(방의 첫 참여자와 같아야 함)
//                                                      lastSeq = 다시 붙는 참여자가 마지막으로 받은 seq (S3-4)
//   S→C catchup  {type, seq, log: [{seq, clientId, entries, batchId?}]}   lastSeq 가 기준점 + 기록 범위 안이면 그 뒤
//                                                      묶음만(S3-4). 범위 밖이면 일반 welcome
//   S→C welcome  {type, seq, base: base64|null, log: [{seq, clientId, entries}], resync?: true}
//   S→C incompatible {type, engine}                    지문이 다르면 거절하고 연결을 닫는다
//   C→S base     {type, data: base64}                  welcome.base 가 null 이었던 참여자만
//   C→S ops      {type, base: lastSeq, entries, batchId?}   entries = 기록 열(op·state), batchId = clientId:순번(S3-4)
//   S→C ops      {type, seq, clientId, entries, batchId?}   모두에게 (보낸 사람에게는 ack). batchId 는 기록에도 남는다
//   S→C reject   {type, seq, batchId?}                 base !== room.seq 일 때 보낸 사람에게만(그 묶음의 batchId)
//   C→S resync   {type}                                → welcome (+resync: true)
//   C→S digest   {type, seq, digest}
//   S→C diverged {type, seq}                           같은 seq 에 다른 digest 가 오면 모두에게
//   C→S cursor   {type, seq, caret}                    내 캐럿(텍스트 좌표, seq 시점) — 저장하지 않고 다른 참여자에게만
//   S→C cursor   {type, clientId, name, seq, caret}    (참여자마다 초당 20회까지, 넘치면 버림) R10
//   S→C cursor-leave {type, clientId}                 참여자가 나가면
//   S→C too-large {type, what, bytes, limit}           메시지가 상한(COLLAB_MAX_MESSAGE_BYTES, 기본 64MB)을
//                                                      넘음 — 그 메시지는 버린다. base 였으면 연결을 닫는다
//   S→C invalid  {type, what, reason}                  S3-2 정본이 거절함(what = 'ops' | 'base'). ops 면 기록·방송하지
//                                                      않고 보낸 쪽에만 알린다(보낸 쪽은 재동기화). base 면 연결을 닫는다
//
// S3-2 서버 정본(docs/collab-stage3.md): 방마다 워커(`canonical.mjs`)에 같은 엔진으로 정본 문서를 두고, base·ops 를
// 기록하기 전에 정본에 먼저 적용해 본다. rhwp 가 오류를 내면 거절(invalid), 패닉(WASM trap)하면 거절하고 워커를
// 버린 뒤 기준점 + 기록으로 새로 만든다. 정본은 seq 마다 digest 를 가지므로 클라이언트 digest 는 정본 값과
// 비교하고, 다르면 **그 클라이언트에만** diverged 를 보낸다. 끄려면 COLLAB_CANONICAL=0 (또는 canonical: false).
//
// S3-3 영속 저장(COLLAB_DATA_DIR 또는 store, 결정 2026-11-26 "계보 보존"): 방마다 기준점 파일(base) + 그 뒤 기록 전부
// (`doc-store.mjs`). 묶음은 정본 적용 → 디스크에 덧붙이고 fsync → 방송 순서라, 방송했는데 디스크에 없는 기록이 생기지
// 않는다. welcome·재시작 복원은 **마지막 기준점 + 그 뒤 기록** — 기준점은 모두가 같은 바이트를 다시 읽은 지점(처음
// base, 기록 안의 state, 세대 전환 base)뿐이다(다시 읽지 않은 문서를 내보낸 파일은 기준점이 아니다: 편집된 문서는
// 내보내기→다시 읽기가 항등이 아니다). 기록은 세대 전환 때만 비운다 — 방이 10분 빈 뒤 정본을 내보내 새 base 로 쓰고
// 정본도 그 바이트를 다시 읽는다. 사용자 저장본(doc)은 5초 잠잠·마지막 참여자가 나갈 때·종료 때 정본을 내보내 쓴다.
// 엔진 업그레이드: 방의 지문이 다르면 세대 전환으로 시작한다(저장본이 마지막 seq 까지 덮으면 그것을, 아니면 남은
// 기록을 새 엔진으로 재생해 보고 경고).
import { WebSocketServer } from 'ws';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { LocalDocStore } from './doc-store.mjs';
import { Canonical, DEFAULT_PKG } from './canonical.mjs';
import { ENGINE_FINGERPRINT } from '../collab-client/src/engine/catalog.ts';

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
    /** S3-2 정본(없으면 순서만 정하는 중계) */
    canonical: null,
    /** 정본 적용을 방 안에서 차례로 — base·ops 처리 사슬 */
    queue: Promise.resolve(),
    /** 정본 digest (seq → digest), 최근 DIGEST_WINDOW 개 */
    canonDigests: new Map(),
    /** S3-3: 세대 — 세대 전환(기록 비움)마다 하나씩. 다른 세대에서 끊긴 참여자는 따라잡지 못한다 */
    generation: 0,
    /** S3-3: 사용자 저장본(doc)이 덮은 seq */
    docSeq: null,
    /** 저장본 쓰기·세대 전환 타이머 */
    docTimer: null,
    generationTimer: null,
    /** S3-4: base 가 나타내는 seq — 기록(log)은 이 seq 뒤의 묶음이다. 이 seq 이상에서 끊긴 참여자는 따라잡기 가능 */
    baseSeq: 0,
    /** 쓸 수 없는 방(복원 실패·업그레이드 절차 위반)의 사유 */
    broken: null,
  };
}

export const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export function startServer({
  port = 8787, host = '127.0.0.1', log = console.log,
  delayMs = Number(process.env.COLLAB_DELAY_MS ?? 0),
  maxMessageBytes = Number(process.env.COLLAB_MAX_MESSAGE_BYTES ?? DEFAULT_MAX_MESSAGE_BYTES),
  canonical = process.env.COLLAB_CANONICAL !== '0',
  pkg = process.env.COLLAB_PKG ?? DEFAULT_PKG,
  canonicalTimeoutMs = Number(process.env.COLLAB_CANONICAL_TIMEOUT_MS ?? 30_000),
  // 정본을 켜면 서버 자신의 엔진이 방의 엔진이다(정본이 그 엔진으로 재생한다). 시험용으로 바꿀 수 있다.
  engine: serverEngine = ENGINE_FINGERPRINT,
  // S3-3 영속 저장. 디렉터리를 주면 로컬 디스크 저장소를 쓴다. 정본이 있어야 한다(저장본·세대 전환 = 정본 내보내기).
  store = process.env.COLLAB_DATA_DIR ? new LocalDocStore(process.env.COLLAB_DATA_DIR) : null,
  docSaveIdleMs = Number(process.env.COLLAB_DOC_SAVE_IDLE_MS ?? 5000),
  generationIdleMs = Number(process.env.COLLAB_GENERATION_IDLE_MS ?? 600_000),
} = {}) {
  if (store && !canonical) throw new Error('영속 저장(store)에는 정본(canonical)이 필요하다');
  /** @type {Map<string, ReturnType<typeof createRoom>>} */
  const rooms = new Map();
  /** 닫는 중 — 그 뒤의 연결 끊김으로 저장본·세대 전환 타이머를 새로 만들지 않는다 */
  let closed = false;
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

  /** 기록을 메시지 상한 안에 들어가는 조각으로 나눈다(조각마다 최소 한 묶음). */
  const chunkLog = (items, budget) => {
    const chunks = [[]];
    let size = 0;
    for (const item of items) {
      const n = JSON.stringify(item).length + 1;
      if (size + n > budget && chunks[chunks.length - 1].length > 0) { chunks.push([]); size = 0; }
      chunks[chunks.length - 1].push(item);
      size += n;
    }
    return chunks;
  };

  /**
   * welcome = 마지막 기준점 + 그 뒤 기록. 합쳐 메시지 상한을 넘으면 기록을 나눠 — 첫 조각은 welcome 에, 나머지는
   * catchup 과 같은 형식(`cont: true`)으로 잇는다.
   */
  const welcome = (room, ws, base, extra = {}) => {
    room.clients.add(ws);
    const logItems = base === null ? [] : room.log;
    const budget = Math.max(64 * 1024, Math.floor((maxMessageBytes - (base?.length ?? 0)) / 2));
    const chunks = chunkLog(logItems, budget);
    const first = chunks[0];
    const firstSeq = first.length ? first[first.length - 1].seq : (base === null ? room.seq : room.baseSeq);
    const seqOf = (chunk) => chunk[chunk.length - 1].seq;
    send(ws, { type: 'welcome', seq: chunks.length > 1 ? firstSeq : room.seq, base, log: first, ...(room.generation ? { generation: room.generation } : {}), maxMessageBytes, ...extra });
    for (const chunk of chunks.slice(1)) send(ws, { type: 'catchup', seq: seqOf(chunk), log: chunk, cont: true, maxMessageBytes });
    log(`[${room.name}] welcome${extra.resync ? '(resync)' : ''} ${who(ws)} seq=${room.seq} base=${base === null ? 'null (담당)' : `${base.length}B64`} log=${logItems.length}${chunks.length > 1 ? ` (${chunks.length}조각)` : ''} 세대 ${room.generation} 참여자=${room.clients.size}`);
  };

  /** S3-4: 다시 붙은 참여자에게 끊긴 동안의 묶음만 보낸다(그 참여자의 문서·미확정은 그대로). */
  const catchup = (room, ws, from) => {
    room.clients.add(ws);
    const missing = room.log.filter((item) => item.seq > from);
    send(ws, { type: 'catchup', seq: room.seq, log: missing, maxMessageBytes });
    log(`[${room.name}] catchup ${who(ws)} ${from} → ${room.seq} (${missing.length}건) 참여자=${room.clients.size}`);
  };

  const handleHello = (ws, msg) => {
    if (ws.meta) return send(ws, { type: 'error', error: 'hello 는 한 번만 보낸다' });
    if (typeof msg.room !== 'string' || !msg.room || typeof msg.clientId !== 'string' || !msg.clientId) {
      return send(ws, { type: 'error', error: 'hello 에 room·clientId 가 필요하다' });
    }
    let room = rooms.get(msg.room);
    if (!room) {
      room = createRoom(msg.room);
      if (canonical) room.canonical = new Canonical({ pkg, timeoutMs: canonicalTimeoutMs, log: (m) => log(`[${msg.room}] ${m}`) });
      rooms.set(msg.room, room);
      log(`[${room.name}] 방 생성${canonical ? ' (정본)' : ''}${store ? ' (저장)' : ''}`);
      const created = room;
      if (store) enqueue(room, () => restoreRoom(created));
    }
    const engine = typeof msg.engine === 'string' ? msg.engine : '';
    if (room.engine === undefined) {
      room.engine = room.canonical ? serverEngine : engine;
    }
    if (room.engine !== engine) {
      log(`[${room.name}] incompatible ${msg.name ?? '?'} 엔진 ${engine || '(없음)'} ≠ 방 ${room.engine || '(없음)'}`);
      send(ws, { type: 'incompatible', engine: room.engine });
      setTimeout(() => ws.close(), delayMs + 50);
      return;
    }
    ws.meta = { room: msg.room, clientId: msg.clientId, name: typeof msg.name === 'string' ? msg.name : '' };
    ws.resumeFrom = Number.isInteger(msg.lastSeq) && msg.lastSeq >= 0 ? msg.lastSeq : null;
    ws.resumeGeneration = Number.isInteger(msg.generation) ? msg.generation : 0;
    // 저장소가 있으면 복원(앞선 처리)이 끝난 뒤에 들인다.
    if (store) { const target = room; enqueue(room, () => admit(ws, target)); return; }
    admit(ws, room);
  };

  const admit = (ws, room) => {
    if (ws.readyState !== ws.OPEN) return;
    clearTimeout(room.generationTimer);
    room.generationTimer = null;
    if (room.broken) {
      send(ws, { type: 'error', error: `이 방을 열 수 없습니다: ${room.broken}` });
      setTimeout(() => ws.close(), delayMs + 50);
      return;
    }
    if (room.base !== null) {
      const from = ws.resumeFrom;
      // 따라잡기는 같은 세대(같은 계보)이고 기준점 뒤에서 끊겼을 때만 — 아니면 welcome(재동기화).
      if (from !== null && ws.resumeGeneration === room.generation && from >= room.baseSeq && from <= room.seq) return catchup(room, ws, from);
      return welcome(room, ws, room.base);
    }
    if (room.baseOwner === null) {
      room.baseOwner = ws;
      return welcome(room, ws, null);
    }
    room.waiting.push(ws);
    log(`[${room.name}] ${who(ws)} base 대기 (담당 ${who(room.baseOwner)})`);
  };

  /** 정본 digest 를 seq 에 기록한다(최근 DIGEST_WINDOW 개). */
  const keepCanonDigest = (room, seq, digest) => {
    room.canonDigests.set(seq, digest);
    for (const key of room.canonDigests.keys()) if (key <= room.seq - DIGEST_WINDOW) room.canonDigests.delete(key);
  };

  /** 방 안에서 정본 처리를 차례로 잇는다(앞의 처리가 실패해도 사슬은 이어진다). */
  const enqueue = (room, job) => {
    room.queue = room.queue.then(job).catch((error) => log(`[${room.name}] 정본 처리 오류: ${error?.stack ?? error}`));
    return room.queue;
  };

  /** 메모리의 welcome 기준점: 기록 안의 마지막 state 묶음(그 state 를 기준점으로, 같은 묶음의 나머지와 뒤 묶음을 기록으로). */
  const pickBasePoint = (room, base, baseSeq, items) => {
    room.base = base;
    room.baseSeq = baseSeq;
    room.log = items;
    for (let k = items.length - 1; k >= 0; k -= 1) {
      const entries = items[k].entries;
      const last = entries.findLastIndex((e) => e?.kind === 'state' && typeof e.data === 'string');
      if (last < 0) continue;
      const rest = entries.slice(last + 1);
      room.base = entries[last].data;
      room.baseSeq = items[k].seq;
      room.log = [...(rest.length ? [{ ...items[k], entries: rest }] : []), ...items.slice(k + 1)];
      return;
    }
  };

  /** S3-3: 디스크에서 방을 복원한다(기준점 적재 → 기록 재생 → 정본 digest). 엔진이 다르면 세대 전환으로 시작. */
  const restoreRoom = async (room) => {
    let saved;
    try {
      saved = await store.load(room.name);
    } catch (error) {
      room.broken = `저장된 기록을 읽지 못함: ${error.message}`;
      log(`[${room.name}] 복원 실패: ${room.broken}`);
      return;
    }
    if (!saved) return;
    const lastSeq = saved.log.length ? saved.log[saved.log.length - 1].seq : saved.meta.baseSeq;
    if (saved.meta.engine !== serverEngine) {
      // 엔진 업그레이드: 기록은 옛 엔진으로만 재생할 수 있다 — 세대 전환으로 시작한다.
      let next = null;
      if (saved.doc && saved.meta.docSeq === lastSeq) {
        next = saved.doc;
        log(`[${room.name}] 엔진이 바뀜(${saved.meta.engine} → ${serverEngine}): 저장본(seq ${lastSeq})을 새 기준점으로`);
      } else {
        const res = await room.canonical.rebuild(gzipSync(saved.base).toString('base64'), saved.log);
        if (!res.ok) {
          room.broken = `엔진이 바뀌었고(${saved.meta.engine}) 저장본이 마지막 seq 를 덮지 못하며, 남은 기록을 새 엔진으로 재생하지 못함: ${res.reason}`;
          log(`[${room.name}] 복원 실패: ${room.broken}`);
          return;
        }
        const ex = await room.canonical.export();
        next = gunzipSync(Buffer.from(ex.data, 'base64'));
        log(`[${room.name}] 경고: 엔진이 바뀜(${saved.meta.engine} → ${serverEngine})인데 저장본이 seq ${saved.meta.docSeq ?? '-'} 까지만 덮음 — 남은 기록 ${saved.log.length}건을 새 엔진으로 재생해 새 기준점으로`);
      }
      const packed = gzipSync(next).toString('base64');
      const loaded = await room.canonical.load(packed);
      if (!loaded.ok) { room.broken = `새 기준점을 열지 못함: ${loaded.reason}`; return; }
      await store.setBase(room.name, { baseSeq: lastSeq, data: next, engine: serverEngine, generation: saved.meta.generation + 1 });
      room.generation = saved.meta.generation + 1;
      room.seq = lastSeq;
      room.docSeq = saved.meta.docSeq;
      pickBasePoint(room, packed, lastSeq, []);
      keepCanonDigest(room, room.seq, loaded.digest);
      return;
    }
    const base = gzipSync(saved.base).toString('base64');
    const res = await room.canonical.rebuild(base, saved.log);
    if (!res.ok) {
      room.broken = `복원 중 정본 적용 실패: ${res.reason}`;
      log(`[${room.name}] 복원 실패: ${room.broken}`);
      return;
    }
    room.generation = saved.meta.generation;
    room.seq = lastSeq;
    room.docSeq = saved.meta.docSeq;
    pickBasePoint(room, base, saved.meta.baseSeq, saved.log);
    keepCanonDigest(room, room.seq, res.digest);
    log(`[${room.name}] 복원: 세대 ${room.generation} 기준점 seq ${saved.meta.baseSeq} + 기록 ${saved.log.length} → seq ${room.seq} 정본 ${res.digest.slice(0, 12)}`);
  };

  /** S3-3 사용자 저장본: 정본을 내보내 doc.<ext> 로(재생 기준이 아니다). */
  const saveDoc = async (room, why) => {
    if (!store || !room.canonical || room.base === null || room.broken || room.docSeq === room.seq) return;
    clearTimeout(room.docTimer);
    room.docTimer = null;
    const ex = await room.canonical.export();
    if (!ex.ok) { log(`[${room.name}] 저장본 실패(내보내기): ${ex.reason}`); return; }
    const raw = gunzipSync(Buffer.from(ex.data, 'base64'));
    await store.saveDoc(room.name, { seq: room.seq, data: raw });
    room.docSeq = room.seq;
    log(`[${room.name}] 저장본 seq ${room.seq} (${why}, ${raw.length}B)`);
  };

  /** 편집 뒤 5초 잠잠하면 저장본을 쓴다. */
  const scheduleDocSave = (room) => {
    if (!store || closed) return;
    clearTimeout(room.docTimer);
    room.docTimer = setTimeout(() => enqueue(room, () => saveDoc(room, '잠잠함')), docSaveIdleMs);
    room.docTimer.unref?.();
  };

  /**
   * S3-3 세대 전환(기록을 비우는 유일한 길): ① 정본을 내보내고(E) ② 그 바이트를 새 base 로 원자적으로 쓰고 ③ 정본도
   * 그 바이트를 다시 읽고(R — 빠지면 정본만 옛 계보) ④ 기록을 비우고 meta 에 세대·기준 seq. 방이 빈 동안에만.
   */
  const changeGeneration = async (room, why) => {
    if (!store || !room.canonical || room.base === null || room.broken) return;
    const ex = await room.canonical.export();
    if (!ex.ok) { log(`[${room.name}] 세대 전환 실패(내보내기): ${ex.reason}`); return; }
    const raw = gunzipSync(Buffer.from(ex.data, 'base64'));
    const generation = room.generation + 1;
    await store.setBase(room.name, { baseSeq: room.seq, data: raw, engine: serverEngine, generation });
    const reread = await room.canonical.load(ex.data);
    if (!reread.ok) { room.broken = `세대 전환 base 를 다시 읽지 못함: ${reread.reason}`; return; }
    room.generation = generation;
    pickBasePoint(room, ex.data, room.seq, []);
    room.canonDigests.clear();
    keepCanonDigest(room, room.seq, reread.digest);
    log(`[${room.name}] 세대 전환 → ${generation} (${why}): 기준점 seq ${room.seq}, 정본 다시 읽음 ${reread.digest.slice(0, 12)}`);
  };

  /** 참여자가 모두 나간 방: 저장본을 쓰고, 10분 동안 아무도 오지 않으면 세대 전환 뒤 메모리에서 내린다. */
  const onRoomEmpty = (room) => {
    if (closed) return; // 서버를 닫는 중(close 가 저장본을 쓴다)
    enqueue(room, () => saveDoc(room, '마지막 참여자 나감'));
    clearTimeout(room.generationTimer);
    room.generationTimer = setTimeout(() => enqueue(room, async () => {
      room.generationTimer = null;
      if (room.clients.size > 0 || room.waiting.length > 0 || rooms.get(room.name) !== room) return;
      await changeGeneration(room, `방이 ${Math.round(generationIdleMs / 1000)}초 빔`);
      if (room.clients.size > 0 || room.waiting.length > 0) return;
      clearTimeout(room.docTimer);
      await room.canonical?.terminate();
      rooms.delete(room.name);
      log(`[${room.name}] 메모리에서 내림`);
    }), generationIdleMs);
    room.generationTimer.unref?.();
  };

  const handleBase = (ws, room, msg) => {
    if (room.base !== null || room.baseOwner !== ws) {
      log(`[${room.name}] base 무시: ${who(ws)} 는 담당이 아니거나 이미 정해짐`);
      return send(ws, { type: 'error', error: 'base 를 보낼 차례가 아니다' });
    }
    if (typeof msg.data !== 'string' || !msg.data) {
      return send(ws, { type: 'error', error: 'base.data 가 비었다' });
    }
    if (!room.canonical) return commitBase(ws, room, msg.data, null);
    enqueue(room, async () => {
      if (room.base !== null || room.baseOwner !== ws) return;
      const res = await room.canonical.load(msg.data);
      if (room.base !== null || room.baseOwner !== ws) return; // 적재하는 동안 담당이 나갔다
      if (!res.ok) {
        log(`[${room.name}] base 거절 ${who(ws)}: ${res.reason}`);
        send(ws, { type: 'invalid', what: 'base', reason: res.reason });
        setTimeout(() => ws.close(), delayMs + 50);
        return;
      }
      if (store) {
        // 첫 방 생성: 첫 참여자의 base 가 0세대 기준점(seq 0). 0세대는 welcome 에 싣지 않는다 — base 담당은 base 를
        // 정하기 전에 welcome 을 받으므로, 세대를 따로 알려 주지 않아도 0 으로 맞는다.
        await store.setBase(room.name, { baseSeq: room.seq, data: gunzipSync(Buffer.from(msg.data, 'base64')), engine: serverEngine, generation: 0 });
        room.generation = 0;
      }
      commitBase(ws, room, msg.data, res.digest);
    });
  };

  const commitBase = (ws, room, data, digest) => {
    room.base = data;
    room.baseSeq = room.seq;
    if (digest) keepCanonDigest(room, room.seq, digest);
    room.baseOwner = null;
    log(`[${room.name}] base 확정 by ${who(ws)} (${data.length}B64)${digest ? ` 정본 ${digest.slice(0, 12)}` : ''}`);
    const waiting = room.waiting.splice(0);
    for (const w of waiting) if (w.readyState === w.OPEN) welcome(room, w, room.base);
  };

  const handleOps = (ws, room, msg) => {
    if (!room.clients.has(ws)) return send(ws, { type: 'error', error: 'welcome 전에는 ops 를 보낼 수 없다' });
    if (!Array.isArray(msg.entries) || msg.entries.length === 0) {
      return send(ws, { type: 'error', error: 'entries 는 비어 있지 않은 배열이어야 한다' });
    }
    if (!room.canonical) return commitOps(ws, room, msg, null);
    enqueue(room, async () => {
      if (!room.clients.has(ws)) return;
      if (room.base === null || msg.base !== room.seq) return commitOps(ws, room, msg, null); // reject 경로
      const res = await room.canonical.apply(msg.entries);
      if (!res.ok) {
        log(`[${room.name}] invalid ${who(ws)} base=${msg.base}: ${res.reason}${res.panic ? ' (패닉 — 정본 재생성)' : ''}`);
        send(ws, { type: 'invalid', what: 'ops', reason: res.reason, ...(typeof msg.batchId === 'string' ? { batchId: msg.batchId } : {}) });
        if (res.panic) {
          const rebuilt = await room.canonical.rebuild(room.base, room.log);
          const expect = room.canonDigests.get(room.seq);
          log(`[${room.name}] 정본 재생성 (세대 ${room.canonical.generation}) ${rebuilt.ok ? `digest ${rebuilt.digest.slice(0, 12)}${expect && expect !== rebuilt.digest ? ` ≠ 기대 ${expect.slice(0, 12)}` : ''}` : `실패: ${rebuilt.reason}`}`);
        }
        return;
      }
      if (store) {
        // 디스크에 덧붙이고 fsync 한 뒤에 방송한다. 쓰기에 실패하면 거절하고 정본을 디스크와 같은 상태로 되돌린다.
        const item = { seq: room.seq + 1, clientId: ws.meta.clientId, entries: msg.entries, ...(typeof msg.batchId === 'string' ? { batchId: msg.batchId } : {}) };
        try {
          await store.append(room.name, item);
        } catch (error) {
          log(`[${room.name}] 기록 쓰기 실패 ${who(ws)}: ${error.message} — 거절, 정본 재생성`);
          send(ws, { type: 'invalid', what: 'ops', reason: '서버가 편집을 저장하지 못했습니다', ...(typeof msg.batchId === 'string' ? { batchId: msg.batchId } : {}) });
          await room.canonical.rebuild(room.base, room.log);
          return;
        }
      }
      commitOps(ws, room, msg, res.digest);
    });
  };

  const commitOps = (ws, room, msg, digest) => {
    if (room.base === null || msg.base !== room.seq) {
      log(`[${room.name}] reject ${who(ws)} base=${msg.base} room.seq=${room.seq}${room.base === null ? ' (base 없음)' : ''}`);
      return send(ws, { type: 'reject', seq: room.seq, ...(typeof msg.batchId === 'string' ? { batchId: msg.batchId } : {}) });
    }
    room.seq += 1;
    if (digest) keepCanonDigest(room, room.seq, digest);
    const entry = { seq: room.seq, clientId: ws.meta.clientId, entries: msg.entries, ...(typeof msg.batchId === 'string' ? { batchId: msg.batchId } : {}) };
    // state 기록은 새 기준점 — 그 앞의 로그는 늦은 참여·재동기화에 더 필요 없다.
    const lastState = msg.entries.findLastIndex((e) => e?.kind === 'state' && typeof e.data === 'string');
    if (lastState >= 0) {
      room.base = msg.entries[lastState].data;
      room.baseSeq = room.seq; // 이 묶음의 state 앞에서 끊긴 참여자는 따라잡지 못한다(state 가 기록에 없다)
      const rest = msg.entries.slice(lastState + 1);
      room.log = rest.length > 0 ? [{ seq: room.seq, clientId: ws.meta.clientId, entries: rest }] : [];
    } else {
      room.log.push(entry);
    }
    const kinds = msg.entries.map((e) => (e?.kind === 'state' ? 'STATE' : e?.m)).join(',');
    log(`[${room.name}] seq=${room.seq} ${who(ws)} entries=${msg.entries.length} [${kinds.length > 160 ? `${kinds.slice(0, 160)}…` : kinds}]${lastState >= 0 ? ' (새 기준점)' : ''}`);
    broadcast(room, { type: 'ops', ...entry });
    scheduleDocSave(room);
  };

  const handleDigest = (ws, room, msg) => {
    if (!room.clients.has(ws)) return;
    const { seq, digest } = msg;
    if (!Number.isInteger(seq) || typeof digest !== 'string' || !digest) {
      return send(ws, { type: 'error', error: 'digest 에 seq·digest 가 필요하다' });
    }
    // 보관 범위 밖(지나간 seq)이나 아직 없는 seq 는 무시한다.
    if (seq > room.seq || seq <= room.seq - DIGEST_WINDOW) return;
    // S3-2: 정본 digest 가 있으면 그것이 기준 — 다르면 그 클라이언트에만 알린다(그 클라이언트만 재동기화).
    const canon = room.canonDigests.get(seq);
    if (canon !== undefined) {
      if (canon === digest) {
        log(`[${room.name}] digest seq=${seq} ${who(ws)} 정본과 일치`);
        return;
      }
      log(`[${room.name}] DIVERGED seq=${seq} ${who(ws)} ${digest.slice(0, 12)} ≠ 정본 ${canon.slice(0, 12)}`);
      return send(ws, { type: 'diverged', seq });
    }
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
    if (store && room.clients.size === 0 && room.waiting.length === 0) onRoomEmpty(room);
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
    /** 서버를 닫는다. 저장소가 있으면 모든 방의 저장본을 쓴 뒤 닫는다(기록은 비우지 않는다 — 다시 붙는 참여자의 계보). */
    close: async () => {
      closed = true;
      for (const ws of wss.clients) ws.terminate();
      if (store) await Promise.all([...rooms.values()].map((room) => enqueue(room, () => saveDoc(room, '서버 종료'))));
      for (const room of rooms.values()) { clearTimeout(room.docTimer); clearTimeout(room.generationTimer); await room.canonical?.terminate(); }
      await new Promise((resolve) => wss.close(() => resolve()));
    },
    /** 시험용: 방의 처리 사슬이 빌 때까지 */
    settle: (name) => rooms.get(name)?.queue ?? Promise.resolve(),
    /** 시험용: 지금 세대를 바꾼다(원래는 방이 10분 빈 뒤에만). 그 앞 세대에서 끊긴 참여자는 welcome 을 받는다. */
    changeGeneration: (name) => { const room = rooms.get(name); return room ? enqueue(room, () => changeGeneration(room, '요청')) : Promise.resolve(); },
    /** 시험용: 지금 저장본을 쓴다 */
    saveDoc: (name) => { const room = rooms.get(name); return room ? enqueue(room, () => saveDoc(room, '요청')) : Promise.resolve(); },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 8787);
  const server = startServer({ port, host: process.env.HOST ?? '127.0.0.1' });
  server.ready.then(
    () => console.log(`cc-rhwp collab server: ws://${process.env.HOST ?? '127.0.0.1'}:${server.port}`),
    (error) => { console.error(error.message); process.exit(1); },
  );
  // 서버 종료 때 저장본(S3-3). kill -9 는 여기를 지나지 않는다 — 그때는 fsync 한 기록으로 복원한다.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { server.close().finally(() => process.exit(0)); });
  }
}
