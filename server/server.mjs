// cc-rhwp 공동편집 서버. **규약(메시지 형식·토큰·이유 코드·재접속 절차)은 docs/collab-protocol.md 가 정본이다.**
// 메시지를 바꾸면 그 문서를 함께 고친다.
//
// 서버는 순서를 정하고(seq), 정본으로 먼저 검사하고(S3-2), 기록을 디스크에 남긴다(S3-3).
// 한 포트에서 HTTP(S) 와 WebSocket 을 함께 받는다(5단계 D2·D3):
//   WebSocket          공동편집 규약(아무 경로나)
//   POST /rooms        파일로 방 만들기 (scope create)
//   GET  /rooms/{room}/document   방의 최신 문서 파일 (room 이 맞는 토큰)
//   GET  /upload       업로드 페이지(server/public/upload.html)
//   GET  /healthz      {ok, auth: 확인 방식, encryptedAllowed}
//   GET  그 밖          COLLAB_STATIC_DIR 의 정적 파일(빌드한 studio)
// 접속 인증(5단계 D1)은 hello 에서 `auth.verify(token, room)`(server/auth.mjs)로 하고, 실패하면 unauthorized 후 닫는다.
// 권한(scope)이 view 인 연결은 편집(ops·base)을 보낼 수 없다 — forbidden 으로 거절하고 연결은 둔다. form·comment 연결은
// base 와 결과 전송(state 가 든 묶음)을 보낼 수 없고(forbidden scope), op 묶음은 정본이 결과로 판정한다(D4).
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
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { LocalDocStore, formatOf } from './doc-store.mjs';
import { Canonical, DEFAULT_PKG } from './canonical.mjs';
import { AuthError, JOIN_SCOPES, authFromEnv, editPermission, noneAuth, normalizeUser, parseDuration } from './auth.mjs';
import { createHttpHandler, HttpError } from './http.mjs';
import { CATALOG, ENGINE_FINGERPRINT } from '../collab-client/src/engine/catalog.ts';

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
    /** 이 세대의 기준점(저장소 base)이 덮는 seq — 그 뒤로 편집이 없으면 빈 방이 되어도 세대를 바꾸지 않는다 */
    generationSeq: 0,
    /** 쓸 수 없는 방(복원 실패·업그레이드 절차 위반)의 사유 */
    broken: null,
    /** 5단계 D5: 원래 암호 문서였다(COLLAB_ALLOW_ENCRYPTED 로 받음) — 방의 문서는 암호 없이 오가고 저장된다 */
    encryptedSource: false,
    /** 6단계 S2: 방을 열 때의 왕복 점검 결과 {ok, lost, irDiff} — 못 했으면 {ok: null, reason}(시간 초과·오류). 점검하지 않았거나 도는 중이면 null */
    roundtrip: null,
    /** 6단계 S2: 뒤에서 도는 왕복 점검(warn) — 끝나면 풀린다 */
    roundtripCheck: null,
  };
}

export const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/**
 * 6단계 S2: 왕복 점검 결과를 방 메타·응답·welcome 에 실을 모양으로 — {ok, lost: [{kind, count, detail}], irDiff}.
 * 보조의 결과를 믿되 모양만 다듬는다(detail 은 짧게, 목록은 32개까지).
 */
function summarizeRoundtrip(r) {
  const lost = Array.isArray(r?.lost) ? r.lost.slice(0, 32).map((l) => ({
    kind: String(l?.kind ?? '?'), count: Number.isFinite(l?.count) ? l.count : 1, ...(l?.detail ? { detail: String(l.detail).slice(0, 200) } : {}),
  })) : [];
  const irDiff = Number.isFinite(r?.irDiff) ? r.irDiff : 0;
  return { ok: r?.ok === true && lost.length === 0, lost, irDiff };
}
/** 6단계 S2: 점검을 끝내지 못했다(시간 초과·워커 오류) — 결과를 모르므로 통과가 아니다 */
const roundtripUnknown = (reason) => ({ ok: null, reason, lost: [], irDiff: 0 });

/** 5단계 D6: 메모를 만드는 함수와 그 작성자 인자(`json` = {author, text}) */
const MEMO_CREATE = ['insertMemo', 'insertMemoByPath', 'insertMemoReply'];
const memoJsonIndex = (m) => { const i = CATALOG[m]?.params?.indexOf('json') ?? -1; return i >= 0 ? i : { insertMemo: 4, insertMemoByPath: 5, insertMemoReply: 1 }[m]; };
/** 묶음의 메모 만들기 op 중 작성자가 name 과 다른 것이 있으면 그 까닭. 작성자를 읽을 수 없어도 거절한다. */
function memoAuthorViolation(entries, name) {
  for (const e of entries) {
    if (e?.kind !== 'op' || !MEMO_CREATE.includes(e.m) || !Array.isArray(e.a)) continue;
    let author;
    try { author = JSON.parse(e.a[memoJsonIndex(e.m)])?.author; } catch { author = undefined; }
    if (author !== name) return `${e.m} 의 작성자 ${JSON.stringify(author ?? null)} ≠ 연결의 이름 ${JSON.stringify(name)}`;
  }
  return null;
}

/**
 * 5단계 입장 이름: hello 때 한 번 정한다(토큰의 name, 없으면 hello 의 이름). rhwp 가 메모 작성자를 저장할 때 쓰는 규칙
 * (`sanitize_author`: 앞뒤 공백 자르기 → `/`·`\`·`;`·제어 문자(Cc) 빼기, 64 UTF-16 단위가 넘으면 실패)과 같게 다듬고
 * 64 단위로 자른다(서로게이트 쌍은 가르지 않는다). 자르기 뒤 앞뒤 공백이 다시 생길 수 있어 바뀌지 않을 때까지 되풀이한다 —
 * 그래서 이 이름은 rhwp 규칙의 고정점이고, 메모 작성자로 넣으면 그대로 저장된다. 비면 "손님".
 * 이 이름을 welcome.user.name 으로 알려 주고, 메모 작성자 비교·자기 메모 확인·커서 이름에 쓴다.
 */
export const ENTRY_NAME_MAX_UNITS = 64;
const RUST_WHITESPACE = /^[\s\u0085]+|[\s\u0085]+$/g;
const NOT_IN_AUTHOR = /[\/\\;\u0000-\u001f\u007f-\u009f]/g;
export function entryName(raw) {
  let name = typeof raw === 'string' ? raw : '';
  for (;;) {
    let next = name.replace(RUST_WHITESPACE, '').replace(NOT_IN_AUTHOR, '');
    if (next.length > ENTRY_NAME_MAX_UNITS) {
      next = next.slice(0, ENTRY_NAME_MAX_UNITS);
      const last = next.charCodeAt(next.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) next = next.slice(0, -1);
    }
    if (next === name) break;
    name = next;
  }
  return name || '손님';
}

/** COLLAB_TLS_CERT·COLLAB_TLS_KEY(PEM 파일 경로) → { cert, key } | null. 하나만 있으면 시작을 거부한다. */
function tlsFromEnv(env) {
  const { COLLAB_TLS_CERT: cert, COLLAB_TLS_KEY: key } = env;
  if (!cert && !key) return null;
  if (!cert || !key) throw new Error('COLLAB_TLS_CERT 와 COLLAB_TLS_KEY 는 함께 정해야 한다');
  return { cert: readFileSync(cert), key: readFileSync(key) };
}

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
  // 5단계 D1 접속 인증: { mode, verify(token, room), issue? } (server/auth.mjs). 기본은 환경 변수(COLLAB_AUTH 등) —
  // HOST 가 루프백이면 none, 아니면 설정이 없을 때 시작을 거부한다. 'none' 문자열도 받는다.
  auth = authFromEnv(process.env, { host, warn: log }),
  // WebSocket 업그레이드(와 POST /rooms)의 Origin 허용 목록. 같은 출처(Origin 의 호스트 = Host 헤더)는 언제나 허용.
  allowedOrigins = process.env.COLLAB_ALLOWED_ORIGINS ? process.env.COLLAB_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : null,
  // 5단계 D2: 빌드한 studio 를 같은 출처로 내준다
  staticDir = process.env.COLLAB_STATIC_DIR || null,
  // 5단계 D2: { cert, key } (PEM 바이트 또는 문자열) 이면 HTTPS/wss 로 뜬다
  tls = tlsFromEnv(process.env),
  // 5단계 D3: POST /rooms 가 만드는 초대 토큰의 수명(초)
  inviteTtlSec = parseDuration(process.env.COLLAB_INVITE_TTL, 86_400),
  // 5단계 D5: 암호 문서를 받을지. 기본은 막는다(POST /rooms 400 encrypted, 플러그인은 base 를 올리지 않음)
  allowEncrypted = process.env.COLLAB_ALLOW_ENCRYPTED === '1',
  // 6단계 S2: 파일로 방을 만들 때 왕복 점검 — warn(결과를 알림) | block(통과하지 못하면 422) | off
  roundtripMode = process.env.COLLAB_ROUNDTRIP || 'warn',
  /** 6단계 S2: 왕복 점검 시간 상한(ms). 넘으면 점검 워커를 버리고 {ok: null, reason: 'timeout'} */
  roundtripTimeoutMs = Number(process.env.COLLAB_ROUNDTRIP_TIMEOUT_MS ?? 15_000),
  // 6단계 S3 부품 전용 모드: 바깥 시스템의 iframe 안에서만 쓰인다(허용 출처 목록이 필요하다)
  embedOnly = process.env.COLLAB_EMBED_ONLY === '1',
  embedOrigins = process.env.COLLAB_EMBED_ORIGINS ? process.env.COLLAB_EMBED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : [],
} = {}) {
  if (store && !canonical) throw new Error('영속 저장(store)에는 정본(canonical)이 필요하다');
  if (auth === 'none') auth = noneAuth();
  if (!auth || typeof auth.verify !== 'function') throw new Error('auth 에는 verify(token, room) 가 있어야 한다');
  const authOn = auth.mode !== 'none';
  if (embedOnly) {
    if (embedOrigins.length === 0) throw new Error('COLLAB_EMBED_ONLY=1 에는 COLLAB_EMBED_ORIGINS(허용할 부모 페이지 출처, 쉼표로 구분)가 필요하다');
    for (const o of embedOrigins) {
      let u;
      try { u = new URL(o); } catch { u = null; }
      if (!u || !/^https?:$/.test(u.protocol) || u.origin !== o) throw new Error(`COLLAB_EMBED_ORIGINS 의 값이 출처(scheme://host[:port])가 아니다: ${o}`);
    }
  }
  if (!['warn', 'block', 'off'].includes(roundtripMode)) throw new Error(`COLLAB_ROUNDTRIP 은 warn | block | off 중 하나다 (지금 ${roundtripMode})`);
  if (!(Number.isFinite(roundtripTimeoutMs) && roundtripTimeoutMs > 0)) throw new Error(`COLLAB_ROUNDTRIP_TIMEOUT_MS 는 양수(ms)다 (지금 ${roundtripTimeoutMs})`);
  if (allowEncrypted) log('경고: COLLAB_ALLOW_ENCRYPTED=1 — 암호 문서로 방을 열면 암호가 풀린 상태로 서버 디스크·모든 참여자·내려받은 파일에 남는다');
  /** @type {Map<string, ReturnType<typeof createRoom>>} */
  const rooms = new Map();
  /** 닫는 중 — 그 뒤의 연결 끊김으로 저장본·세대 전환 타이머를 새로 만들지 않는다 */
  let closed = false;
  /** S1 보조가 없다는 경고를 한 번만 */
  let rewriteWarned = false;
  // ws 의 하드 상한은 넉넉히 두고(넘으면 ws 가 1009 로 끊는다) 상한 판정은 메시지 처리에서 한다 — 보낸 쪽에
  // 이유를 알려 주기 위해서다. HTTP(S) 서버 하나에 붙인다(업그레이드에서 Origin 확인).
  const wss = new WebSocketServer({ noServer: true, maxPayload: Math.max(maxMessageBytes * 2, 1024 * 1024) });

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
    send(ws, { type: 'welcome', seq: chunks.length > 1 ? firstSeq : room.seq, base, log: first, ...(room.generation ? { generation: room.generation } : {}), maxMessageBytes, ...userOf(ws),
      // D5: 원래 암호 문서였으면 알린다(참여자가 경고를 한 번 띄운다). base 담당(base null)에게는 암호 문서를 받는지 알린다.
      ...(room.encryptedSource ? { encryptedSource: true } : {}),
      // S2: 왕복 점검에 경고가 있거나 점검을 끝내지 못한 방이면 결과를 싣는다(참여자가 처음 들어올 때 한 번 알린다)
      ...(room.roundtrip && room.roundtrip.ok !== true ? { roundtrip: room.roundtrip } : {}), ...(base === null && allowEncrypted ? { allowEncrypted: true } : {}), ...extra });
    for (const chunk of chunks.slice(1)) send(ws, { type: 'catchup', seq: seqOf(chunk), log: chunk, cont: true, maxMessageBytes });
    log(`[${room.name}] welcome${extra.resync ? '(resync)' : ''} ${who(ws)} seq=${room.seq} base=${base === null ? 'null (담당)' : `${base.length}B64`} log=${logItems.length}${chunks.length > 1 ? ` (${chunks.length}조각)` : ''} 세대 ${room.generation} 참여자=${room.clients.size}`);
  };

  /** S3-4: 다시 붙은 참여자에게 끊긴 동안의 묶음만 보낸다(그 참여자의 문서·미확정은 그대로). */
  const catchup = (room, ws, from) => {
    room.clients.add(ws);
    const missing = room.log.filter((item) => item.seq > from);
    send(ws, { type: 'catchup', seq: room.seq, log: missing, maxMessageBytes, ...userOf(ws) });
    log(`[${room.name}] catchup ${who(ws)} ${from} → ${room.seq} (${missing.length}건) 참여자=${room.clients.size}`);
  };

  /** 인증을 켠 서버는 welcome·catchup 에 확인된 사용자(sub·표시 이름·권한)를 싣는다. */
  const userOf = (ws) => ((authOn || ws.meta?.announce) && ws.meta?.user ? { user: ws.meta.user } : {});

  /** 방을 메모리에 연다(저장소가 있으면 복원을 사슬에 건다). */
  const openRoom = (name) => {
    const room = createRoom(name);
    if (canonical) room.canonical = new Canonical({ pkg, timeoutMs: canonicalTimeoutMs, log: (m) => log(`[${name}] ${m}`) });
    rooms.set(name, room);
    log(`[${room.name}] 방 생성${canonical ? ' (정본)' : ''}${store ? ' (저장)' : ''}`);
    if (store) enqueue(room, () => restoreRoom(room));
    return room;
  };

  /** 저장소에 방이 있는지(인증을 켜면 hello 로 방을 새로 만들 수 없다). */
  const storeHas = async (name) => {
    if (!store) return false;
    if (typeof store.has === 'function') return store.has(name);
    return (await store.load(name)) !== null;
  };

  /** D1: unauthorized 를 보내고 닫는다(닫는 코드 4401). */
  const unauthorized = (ws, reason, detail = '') => {
    log(`[${ws.helloRoom ?? '-'}] unauthorized ${reason}${detail ? ` (${detail})` : ''}`);
    send(ws, { type: 'unauthorized', reason });
    setTimeout(() => { if (ws.readyState === ws.OPEN) ws.close(4401, reason); }, delayMs + 50);
  };

  /**
   * D1: hello 의 토큰을 확인한다 → {sub, name, scope}. 토큰에 name 이 없으면(초대 토큰처럼 여럿이 나눠 쓰는 토큰)
   * 표시 이름은 hello.name(확인하지 않은 값)이고, sub 에는 연결마다 다른 꼬리를 붙여 구분한다.
   */
  const authorizeHello = async (msg) => {
    const token = typeof msg.token === 'string' ? msg.token : '';
    if (!token) throw new AuthError('missing', '토큰이 없다');
    const user = normalizeUser(await auth.verify(token, msg.room), auth.roleMap ?? null);
    if (!JOIN_SCOPES.some((s) => user.scope.includes(s))) throw new AuthError('scope', `방에 들어갈 권한이 없다 (${user.scope.join(' ') || '없음'})`);
    // 방은 서버가 만든다(D3) — 인증을 켜면 없는 방에 hello 로 들어갈 수 없다. 토큰을 확인한 뒤에 본다(방이 있는지 떠보지 못하게).
    if (!rooms.has(msg.room) && !(await storeHas(msg.room))) throw new AuthError('no-room', '없는 방');
    if (!user.name) {
      // 여럿이 나눠 쓰는 토큰(초대 토큰): 표시 이름은 hello 의 이름(확인되지 않은 값), sub 에는 연결마다 다른 꼬리
      user.name = typeof msg.name === 'string' ? msg.name : '';
      user.sub = `${user.sub ?? 'anonymous'}~${randomBytes(4).toString('hex')}`;
    }
    user.name = entryName(user.name);
    return user;
  };

  const handleHello = (ws, msg) => {
    if (ws.meta || ws.helloRoom) return send(ws, { type: 'error', error: 'hello 는 한 번만 보낸다' });
    if (typeof msg.room !== 'string' || !msg.room || typeof msg.clientId !== 'string' || !msg.clientId) {
      return send(ws, { type: 'error', error: 'hello 에 room·clientId 가 필요하다' });
    }
    ws.helloRoom = msg.room;
    if (!authOn) {
      const raw = typeof msg.name === 'string' ? msg.name : '';
      const name = entryName(raw);
      // 인증을 끈 서버는 welcome.user 를 싣지 않는다 — 다만 입장 이름이 hello 의 이름과 다르면 알려 준다
      return joinRoom(ws, msg, { sub: null, name, scope: ['edit'], announce: name !== raw });
    }
    authorizeHello(msg).then(
      (user) => { if (ws.readyState === ws.OPEN && !closed) joinRoom(ws, msg, user); },
      (error) => {
        if (error instanceof AuthError) return unauthorized(ws, error.reason, error.message);
        unauthorized(ws, 'unavailable', `검증 함수 오류: ${error?.message ?? error}`);
      },
    );
  };

  const joinRoom = (ws, msg, user) => {
    const room = rooms.get(msg.room) ?? openRoom(msg.room);
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
    ws.meta = {
      room: msg.room, clientId: msg.clientId, name: user.name ?? '',
      /** 기록 항목에 서버가 찍는 사용자 식별자(인증을 끄면 없음) — 클라이언트가 보낸 값은 쓰지 않는다 */
      sub: user.sub,
      perm: editPermission(user.scope),
      user: { sub: user.sub, name: user.name, scope: user.scope },
      announce: user.announce === true,
    };
    if (authOn) log(`[${room.name}] 인증 ${who(ws)} sub=${user.sub} scope=${user.scope.join(' ')}`);
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
    // base 담당은 편집 권한(edit)이 있는 참여자만 — 보기·양식·메모 권한은 기다린다.
    if (room.baseOwner === null && ws.meta.perm.level === 'edit') {
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
      room.generationSeq = lastSeq;
      room.encryptedSource = Boolean(saved.meta.encryptedSource);
      room.roundtrip = saved.meta.roundtrip ?? null;
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
    room.generationSeq = saved.meta.baseSeq;
    room.encryptedSource = Boolean(saved.meta.encryptedSource);
    room.roundtrip = saved.meta.roundtrip ?? null;
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
    room.generationSeq = room.seq;
    pickBasePoint(room, ex.data, room.seq, []);
    room.canonDigests.clear();
    keepCanonDigest(room, room.seq, reread.digest);
    log(`[${room.name}] 세대 전환 → ${generation} (${why}): 기준점 seq ${room.seq}, 정본 다시 읽음 ${reread.digest.slice(0, 12)}`);
  };

  /** 참여자가 모두 나간 방: 저장본을 쓰고, 10분 동안 아무도 오지 않으면 세대 전환 뒤 메모리에서 내린다. */
  const onRoomEmpty = (room) => {
    if (closed) return; // 서버를 닫는 중(close 가 저장본을 쓴다)
    enqueue(room, () => saveDoc(room, '마지막 참여자 나감'));
    scheduleUnload(room);
  };

  /** 빈 방을 10분 뒤 세대 전환하고 메모리에서 내린다(참여자가 오면 admit 이 타이머를 지운다). */
  const scheduleUnload = (room) => {
    if (!store || closed) return;
    clearTimeout(room.generationTimer);
    room.generationTimer = setTimeout(() => enqueue(room, async () => {
      room.generationTimer = null;
      if (room.clients.size > 0 || room.waiting.length > 0 || rooms.get(room.name) !== room) return;
      // 이 세대의 기준점 뒤로 편집이 없으면(내려받기만 했거나 방을 만들기만 함) 세대를 바꾸지 않는다.
      if (room.seq !== room.generationSeq) await changeGeneration(room, `방이 ${Math.round(generationIdleMs / 1000)}초 빔`);
      if (room.clients.size > 0 || room.waiting.length > 0) return;
      clearTimeout(room.docTimer);
      await room.canonical?.terminate();
      rooms.delete(room.name);
      log(`[${room.name}] 메모리에서 내림`);
    }), generationIdleMs);
    room.generationTimer.unref?.();
  };

  /** 권한이 모자란 메시지: 연결은 두고 그 메시지만 거절한다(D0·D4). reason = scope | unsupported | confined */
  const forbidden = (ws, room, what, reason, msg = {}, detail = '') => {
    log(`[${room.name}] forbidden ${who(ws)} ${what} ${reason}${detail ? ` (${detail})` : ''}`);
    send(ws, { type: 'forbidden', what, reason, ...(typeof msg.batchId === 'string' ? { batchId: msg.batchId } : {}) });
  };

  const handleBase = (ws, room, msg) => {
    if (ws.meta.perm.level !== 'edit') return forbidden(ws, room, 'base', 'scope');
    if (room.base !== null || room.baseOwner !== ws) {
      log(`[${room.name}] base 무시: ${who(ws)} 는 담당이 아니거나 이미 정해짐`);
      return send(ws, { type: 'error', error: 'base 를 보낼 차례가 아니다' });
    }
    if (typeof msg.data !== 'string' || !msg.data) {
      return send(ws, { type: 'error', error: 'base.data 가 비었다' });
    }
    // D5: 플러그인이 "원래 암호 문서"라고 알린 base. 서버는 바이트만으로는 알 수 없다(암호 없는 바이트) — 플러그인 확인은
    // 실수로 공유하는 것을 막는 장치다.
    if (msg.encryptedSource === true && !allowEncrypted) {
      log(`[${room.name}] base 거절 ${who(ws)}: 암호 문서(서버가 받지 않음)`);
      send(ws, { type: 'invalid', what: 'base', reason: 'encrypted' });
      setTimeout(() => ws.close(), delayMs + 50);
      return;
    }
    if (!room.canonical) return commitBase(ws, room, msg.data, null, msg.encryptedSource === true);
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
        await store.setBase(room.name, { baseSeq: room.seq, data: gunzipSync(Buffer.from(msg.data, 'base64')), engine: serverEngine, generation: 0, encryptedSource: msg.encryptedSource === true });
        room.generation = 0;
        room.generationSeq = room.seq;
      }
      commitBase(ws, room, msg.data, res.digest, msg.encryptedSource === true);
    });
  };

  const commitBase = (ws, room, data, digest, encryptedSource = false) => {
    room.base = data;
    room.encryptedSource = encryptedSource;
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
    // D0·D4 권한: view 는 편집을 보낼 수 없다. form·comment 는 정본이 결과로 확인한다(정본이 없으면 판정할 수 없다).
    const { perm } = ws.meta;
    if (perm.level === 'none') return forbidden(ws, room, 'ops', 'scope', msg);
    // 좁은 권한(form·comment)은 결과 전송(state)을 보낼 수 없다 — 정본에 닿기 전에 거절한다. 판정은 파싱한 모델만 보므로,
    // rhwp 가 모델에 남기지 않는 레코드를 끼운 바이트가 판정을 지나 다른 참여자에게 그대로 갈 수 있기 때문이다.
    if (perm.level === 'confined' && msg.entries.some((e) => e?.kind === 'state')) return forbidden(ws, room, 'ops', 'scope', msg, '좁은 권한의 state');
    // D6: 메모 작성자는 그 연결의 이름(토큰의 name, 없으면 hello 의 표시 이름)이어야 한다 — 모든 권한
    const authorWhy = memoAuthorViolation(msg.entries, ws.meta.name);
    if (authorWhy) return forbidden(ws, room, 'ops', 'author', msg, authorWhy);
    if (perm.level === 'confined' && !room.canonical) return forbidden(ws, room, 'ops', 'unsupported', msg, '정본이 꺼져 있음');
    if (!room.canonical) return commitOps(ws, room, msg, null);
    enqueue(room, async () => {
      if (!room.clients.has(ws)) return;
      if (room.base === null || msg.base !== room.seq) return commitOps(ws, room, msg, null); // reject 경로
      // D6: comment 권한(편집 권한 없음)은 자기 메모만 고치고 지운다 — 정본의 메모 목록으로 확인
      const res = await room.canonical.apply(msg.entries, perm.level === 'confined'
        ? { confine: perm.kinds, ...(perm.kinds.includes('comment') ? { memoOwner: ws.meta.name } : {}) } : {});
      if (!res.ok && res.forbidden) return forbidden(ws, room, 'ops', res.reason, msg, res.detail ?? '');
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
      // 6단계 S1: 정본이 state 를 다시 쓴 바이트 S 로 바꿨으면, 기록·방송·보낸 쪽 ack 모두 C 대신 S 를 쓴다.
      if (res.replaced?.length) {
        const byIndex = new Map(res.replaced.map((r) => [r.index, r.data]));
        msg = { ...msg, entries: msg.entries.map((e, i) => (byIndex.has(i) ? { kind: 'state', data: byIndex.get(i) } : e)), replaced: true };
      } else if (msg.entries.some((e) => e?.kind === 'state') && !rewriteWarned) {
        rewriteWarned = true;
        log('경고: 정본에 state 다시 쓰기 보조(collabRewriteState)가 없다 — 받은 state 바이트를 그대로 기록·방송한다(6단계 S1 전)');
      }
      if (store) {
        // 디스크에 덧붙이고 fsync 한 뒤에 방송한다. 쓰기에 실패하면 거절하고 정본을 디스크와 같은 상태로 되돌린다.
        const item = { seq: room.seq + 1, clientId: ws.meta.clientId, entries: msg.entries, ...stampOf(ws, msg) };
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

  /** 기록 항목의 덧붙임: 묶음 이름(클라이언트 값)과 sub(서버가 찍는 값 — 클라이언트가 보낸 sub 는 쓰지 않는다). */
  const stampOf = (ws, msg) => ({
    ...(typeof msg.batchId === 'string' ? { batchId: msg.batchId } : {}),
    ...(ws.meta.sub ? { sub: ws.meta.sub } : {}),
    // 6단계 S1: 정본이 state 를 다시 쓴 묶음 — 기록 항목 자체에 남겨 실시간·catchup·welcome 기록이 모두 같은 모양이 되게
    ...(msg.replaced ? { replaced: true } : {}),
  });

  const commitOps = (ws, room, msg, digest) => {
    if (room.base === null || msg.base !== room.seq) {
      log(`[${room.name}] reject ${who(ws)} base=${msg.base} room.seq=${room.seq}${room.base === null ? ' (base 없음)' : ''}`);
      return send(ws, { type: 'reject', seq: room.seq, ...(typeof msg.batchId === 'string' ? { batchId: msg.batchId } : {}) });
    }
    room.seq += 1;
    if (digest) keepCanonDigest(room, room.seq, digest);
    const entry = { seq: room.seq, clientId: ws.meta.clientId, entries: msg.entries, ...stampOf(ws, msg) };
    // state 기록은 새 기준점 — 그 앞의 로그는 늦은 참여·재동기화에 더 필요 없다.
    const lastState = msg.entries.findLastIndex((e) => e?.kind === 'state' && typeof e.data === 'string');
    if (lastState >= 0) {
      room.base = msg.entries[lastState].data;
      room.baseSeq = room.seq; // 이 묶음의 state 앞에서 끊긴 참여자는 따라잡지 못한다(state 가 기록에 없다)
      const rest = msg.entries.slice(lastState + 1);
      room.log = rest.length > 0 ? [{ seq: room.seq, clientId: ws.meta.clientId, entries: rest, ...stampOf(ws, msg) }] : [];
    } else {
      room.log.push(entry);
    }
    const kinds = msg.entries.map((e) => (e?.kind === 'state' ? 'STATE' : e?.m)).join(',');
    log(`[${room.name}] seq=${room.seq} ${who(ws)} entries=${msg.entries.length} [${kinds.length > 160 ? `${kinds.slice(0, 160)}…` : kinds}]${lastState >= 0 ? ' (새 기준점)' : ''}`);
    // replaced(기록 항목에 있음): 정본이 state 를 다시 쓴 묶음(6단계 S1) — 보낸 쪽은 자기 state 를 이 바이트로 바꿔 다시 읽는다
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
    // 정본이 없으면 처음 보고가 기준이 되어 방 전체를 재동기화시킬 수 있다 — 편집 권한(edit)이 없는 연결의 보고는 쓰지 않는다.
    if (ws.meta.perm.level !== 'edit') return;
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
      const k = room.waiting.findIndex((w) => w.meta.perm.level === 'edit');
      if (k >= 0) {
        const [next] = room.waiting.splice(k, 1);
        room.baseOwner = next;
        welcome(room, next, null);
      }
    }
    if (store && room.clients.size === 0 && room.waiting.length === 0) onRoomEmpty(room);
  };

  // ── 5단계 D3: 파일로 방 열기 (HTTP API, server/http.mjs) ───────────────

  /** HTTP 요청의 `Authorization: Bearer` 토큰을 확인한다. scopes 중 하나가 있어야 한다. 인증을 끄면 누구나. */
  const authorizeHttp = async (req, room, scopes) => {
    if (!authOn) return { sub: null, name: null, scope: ['edit', 'create'] };
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
    if (!m) throw new AuthError('missing', '토큰이 없다');
    const user = normalizeUser(await auth.verify(m[1], room), auth.roleMap ?? null);
    if (!scopes.some((s) => user.scope.includes(s))) throw new AuthError('scope', `권한이 없다 (${scopes.join('·')} 필요)`);
    return user;
  };

  /** hs256 처럼 서버가 토큰을 만들 수 있으면 새 방의 초대 토큰(권한마다 하나, name 없음)을 만든다. */
  const makeInvites = (room) => {
    if (typeof auth.issue !== 'function') return {};
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + inviteTtlSec;
    const invite = {};
    for (const scope of JOIN_SCOPES) invite[scope] = auth.issue({ sub: 'invite', room, scope, iat, exp });
    return { invite, inviteExpiresAt: new Date(exp * 1000).toISOString() };
  };

  // ── 6단계 S2 왕복 점검 ──
  /** 빌드에 점검 보조가 있는가(한 번 묻고 기억한다) */
  let roundtripSupported = null;
  const roundtripAvailable = async (room) => {
    if (roundtripSupported === null) {
      const caps = await room.canonical.call('capabilities');
      if (!caps.ok) return false;
      roundtripSupported = caps.roundtripCheck === true;
    }
    return roundtripSupported;
  };
  /** 돌고 있는 점검 워커(서버를 닫을 때 버린다) */
  const roundtripCheckers = new Set();
  /**
   * 왕복 점검을 따로 둔 워커에서 돌린다 — 방의 정본 워커는 붙잡지 않는다(큰 표 문서는 수십 초 걸린다). 열기 + 점검이 상한
   * (roundtripTimeoutMs)을 넘으면 그 워커를 버리고 {ok: null, reason: 'timeout'}, 워커가 실패하면 {ok: null, reason: 'error'}.
   */
  const checkRoundtrip = async (name, packed) => {
    const t0 = Date.now();
    // 워커 자체의 호출 시간 제한은 상한보다 길게 — 상한은 아래 deadline 이 지킨다
    const checker = new Canonical({ pkg, timeoutMs: roundtripTimeoutMs + 60_000, log: (m) => log(`[${name}] 점검 워커: ${m}`) });
    roundtripCheckers.add(checker);
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), roundtripTimeoutMs); });
    const work = (async () => {
      const loaded = await checker.load(packed);
      return loaded.ok ? checker.roundtrip() : loaded;
    })();
    try {
      const rt = await Promise.race([work, deadline]);
      if (rt.timeout) {
        log(`[${name}] 왕복 점검 시간 초과(${roundtripTimeoutMs}ms) — 점검 워커를 버림`);
        return roundtripUnknown('timeout');
      }
      if (!rt.ok) {
        log(`[${name}] 왕복 점검 실패: ${rt.reason}`);
        return roundtripUnknown('error');
      }
      if (!rt.supported) return null;
      const result = summarizeRoundtrip(rt.result);
      log(`[${name}] 왕복 점검 ${result.ok ? '통과' : `경고 ${result.lost.map((l) => `${l.kind}×${l.count}`).join(', ') || `IR 차이 ${result.irDiff}`}`} (점검 ${rt.ms}ms, 열기 포함 ${Date.now() - t0}ms)`);
      return result;
    } finally {
      clearTimeout(timer);
      roundtripCheckers.delete(checker);
      await checker.terminate();
    }
  };
  /**
   * warn: 방을 만든 뒤 뒤에서 점검한다. 결과는 방 메타에 남기고, 통과가 아니면(경고·점검 못 함) 지금 방에 있는 참여자에게
   * `roundtrip` 알림을 한 번 보낸다 — 그 뒤 들어오는 참여자는 welcome 에서 받는다. 그 사이 방을 메모리에서 내렸다 다시
   * 올렸어도 지금 방에 반영한다.
   */
  const roundtripInBackground = (room, packed) => checkRoundtrip(room.name, packed).then((result) => enqueue(room, async () => {
    room.roundtripCheck = null;
    if (!result || closed) return;
    const targets = new Set([room, rooms.get(room.name)].filter(Boolean));
    for (const r of targets) r.roundtrip = result;
    if (store) {
      try { await store.setRoundtrip(room.name, result); } catch (error) { log(`[${room.name}] 왕복 점검 결과를 저장하지 못함: ${error?.message ?? error}`); }
    }
    if (result.ok !== true) for (const r of targets) broadcast(r, { type: 'roundtrip', roundtrip: result });
  }));

  /** POST /rooms: 정본으로 열어 검사한 뒤 새 방(0세대 기준점 = 올린 바이트 그대로)을 만든다. */
  const createRoomFromFile = async (req, raw) => {
    const user = await authorizeHttp(req, null, ['create']);
    if (!canonical) throw new HttpError(501, 'no-canonical', '정본(COLLAB_CANONICAL)이 꺼져 있어 파일을 검사할 수 없다');
    if (closed) throw new HttpError(503, 'closing', '서버를 닫는 중이다');
    try { formatOf(raw); } catch { throw new HttpError(415, 'not-hwp', 'HWP·HWPX 파일이 아니다'); }
    let packed = gzipSync(raw).toString('base64');
    // WebSocket base 와 같은 규칙: welcome 에 실을 수 있어야 한다.
    const fits = (b64) => b64.length + 64 <= maxMessageBytes;
    if (!fits(packed)) throw new HttpError(413, 'too-large', `문서가 메시지 상한 ${maxMessageBytes}바이트를 넘는다`, { limit: maxMessageBytes });
    const name = randomBytes(16).toString('base64url');
    const room = createRoom(name);
    room.canonical = new Canonical({ pkg, timeoutMs: canonicalTimeoutMs, log: (m) => log(`[${name}] ${m}`) });
    room.engine = serverEngine;
    let res = await room.canonical.load(packed);
    if (!res.ok && res.encrypted) {
      // 5단계 D5: 암호 문서는 기본으로 막는다. 허용(COLLAB_ALLOW_ENCRYPTED=1)이면 X-Collab-Document-Password 로 받은 암호로
      // 열어 암호 없는 바이트를 기준점으로 쓴다(방의 문서는 암호 없이 오간다 — encryptedSource 로 알린다).
      const fail = async (status, reason, message, extra = {}) => {
        await room.canonical.terminate();
        return new HttpError(status, reason, message, { reason, ...extra });
      };
      if (!allowEncrypted) throw await fail(400, 'encrypted', '암호가 걸린 문서는 공동편집할 수 없다(서버 설정 COLLAB_ALLOW_ENCRYPTED)', { allowed: false });
      const password = req.headers['x-collab-document-password'];
      if (typeof password !== 'string' || !password) throw await fail(400, 'encrypted', '암호가 걸린 문서다 — X-Collab-Document-Password 로 문서 암호를 준다', { allowed: true });
      const dec = await room.canonical.decrypt(raw, password);
      if (!dec.ok) throw await fail(400, dec.wrongPassword ? 'wrong-password' : 'encrypted', dec.wrongPassword ? '문서 암호가 맞지 않다' : `암호 문서를 열지 못했다: ${dec.reason}`, { allowed: true });
      packed = dec.data;
      raw = gunzipSync(Buffer.from(packed, 'base64'));
      if (!fits(packed)) throw await fail(413, 'too-large', `문서가 메시지 상한 ${maxMessageBytes}바이트를 넘는다`, { limit: maxMessageBytes });
      room.encryptedSource = true;
      res = await room.canonical.load(packed);
    }
    if (!res.ok) {
      await room.canonical.terminate();
      throw new HttpError(422, 'invalid-document', `문서를 열지 못했다: ${res.reason}`);
    }
    // S2 왕복 점검: rhwp 가 모든 부분을 모델에서 다시 쓴 결과를 원본과 견준다. 손대지 않은 부분은 원본 바이트를 그대로 쓰므로
    // "저장 후 비교"로는 드러나지 않는 것(그 부분을 편집하면 사라질 것)을 방을 만들 때 알린다. 보조가 없으면 건너뛴다.
    // 점검은 따로 둔 워커에서(정본 워커를 붙잡지 않는다), 상한 COLLAB_ROUNDTRIP_TIMEOUT_MS. warn 은 방을 먼저 만들고 뒤에서,
    // block 은 상한까지 기다리고 통과가 아니면(경고·시간 초과·오류) 만들지 않는다.
    const roundtripLater = roundtripMode === 'warn' && await roundtripAvailable(room);
    if (roundtripMode === 'block' && await roundtripAvailable(room)) {
      room.roundtrip = await checkRoundtrip(name, packed);
      if (room.roundtrip && room.roundtrip.ok !== true) {
        await room.canonical.terminate();
        const reason = room.roundtrip.ok === null ? `roundtrip-${room.roundtrip.reason}` : 'roundtrip';
        const why = room.roundtrip.ok === null ? `왕복 점검을 끝내지 못해(${room.roundtrip.reason})` : 'rhwp 가 이 문서의 일부를 다루지 못해';
        throw new HttpError(422, 'roundtrip', `${why} 방을 만들지 않았다(COLLAB_ROUNDTRIP=block)`, { reason, roundtrip: room.roundtrip });
      }
    }
    try {
      if (store) await store.setBase(name, { baseSeq: 0, data: raw, engine: serverEngine, generation: 0, encryptedSource: room.encryptedSource, roundtrip: room.roundtrip });
    } catch (error) {
      await room.canonical.terminate();
      throw error;
    }
    room.base = packed;
    room.baseSeq = 0;
    room.generationSeq = 0;
    keepCanonDigest(room, 0, res.digest);
    rooms.set(name, room);
    scheduleUnload(room);
    log(`[${name}] 방 생성(파일 ${raw.length}B, ${formatOf(raw)})${user.sub ? ` by ${user.sub}` : ''} 정본 ${res.digest.slice(0, 12)}${store ? ' (저장)' : ''}${room.encryptedSource ? ' — 경고: 원래 암호 문서, 암호 없이 보관' : ''}`);
    if (roundtripLater) room.roundtripCheck = roundtripInBackground(room, packed);
    return { room: name, ...makeInvites(name), ...(roundtripLater ? { roundtrip: { pending: true } } : room.roundtrip ? { roundtrip: room.roundtrip } : {}) };
  };

  /** GET /rooms/{room}/document: 정본을 내보낸 최신 문서(원본 형식). 메모리에 없으면 저장소에서 연다. */
  const downloadDocument = async (req, name) => {
    await authorizeHttp(req, name, JOIN_SCOPES);
    let room = rooms.get(name);
    if (!room) {
      if (!(await storeHas(name))) throw new HttpError(404, 'no-room', '없는 방');
      room = rooms.get(name) ?? openRoom(name);
    }
    if (!room.canonical) throw new HttpError(501, 'no-canonical', '정본(COLLAB_CANONICAL)이 꺼져 있어 내보낼 수 없다');
    let out = null;
    await enqueue(room, async () => {
      if (room.broken) { out = new HttpError(409, 'broken', `이 방을 열 수 없다: ${room.broken}`); return; }
      if (room.base === null) { out = new HttpError(404, 'no-document', '아직 문서가 없다'); return; }
      const ex = await room.canonical.export();
      if (!ex.ok) { out = new HttpError(500, 'export-failed', `내보내지 못했다: ${ex.reason}`); return; }
      out = { raw: gunzipSync(Buffer.from(ex.data, 'base64')), seq: room.seq };
    });
    if (room.clients.size === 0 && room.waiting.length === 0) scheduleUnload(room);
    if (out === null) throw new HttpError(500, 'export-failed', '내보내지 못했다');
    if (out instanceof HttpError) throw out;
    log(`[${name}] 문서 내려받기 seq ${out.seq} (${out.raw.length}B)`);
    return { ...out, format: formatOf(out.raw) };
  };

  /** Origin 확인: 목록이 없으면 통과. 같은 출처(Origin 의 호스트 = Host 헤더)와 Origin 이 없는 요청(브라우저 밖)도 통과. */
  const originAllowed = (req) => {
    const origin = req.headers.origin;
    if (!allowedOrigins || !origin) return true;
    if (allowedOrigins.includes(origin)) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  };

  const onRequest = createHttpHandler({
    api: { createRoom: createRoomFromFile, download: downloadDocument },
    staticDir, maxBodyBytes: maxMessageBytes, originAllowed, log,
    health: () => ({ auth: auth.mode, encryptedAllowed: allowEncrypted, ...(embedOnly ? { embedOnly: true, embedOrigins } : {}) }),
    embedOnly: embedOnly ? { origins: embedOrigins } : null,
  });
  const httpServer = tls ? https.createServer({ cert: tls.cert, key: tls.key }, onRequest) : http.createServer(onRequest);
  httpServer.on('upgrade', (req, socket, head) => {
    if (closed || !originAllowed(req)) {
      log(`업그레이드 거절: Origin ${req.headers.origin ?? '-'}${closed ? ' (닫는 중)' : ''}`);
      socket.end(`HTTP/1.1 ${closed ? '503 Service Unavailable' : '403 Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  const ready = new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  ready.catch(() => {}); // 실패는 ready 를 기다리는 쪽이 받는다
  httpServer.listen(port, host);

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
    httpServer,
    rooms,
    /** 확인 방식 이름(none | hs256 | url | 끼운 함수의 이름) */
    authMode: auth.mode,
    /** HTTPS/wss 로 떴는지 */
    secure: Boolean(tls),
    /** 실제로 열린 포트 (port: 0 으로 띄웠을 때) */
    get port() { return httpServer.address().port; },
    ready,
    /** 서버를 닫는다. 저장소가 있으면 모든 방의 저장본을 쓴 뒤 닫는다(기록은 비우지 않는다 — 다시 붙는 참여자의 계보). */
    close: async () => {
      closed = true;
      for (const ws of wss.clients) ws.terminate();
      if (store) await Promise.all([...rooms.values()].map((room) => enqueue(room, () => saveDoc(room, '서버 종료'))));
      for (const room of rooms.values()) { clearTimeout(room.docTimer); clearTimeout(room.generationTimer); await room.canonical?.terminate(); }
      await Promise.all([...roundtripCheckers].map((c) => c.terminate()));
      await new Promise((resolve) => wss.close(() => resolve()));
      if (httpServer.listening) {
        const done = new Promise((resolve) => httpServer.close(() => resolve()));
        httpServer.closeAllConnections?.();
        await done;
      }
    },
    /** 시험용: 방의 처리 사슬이 빌 때까지 */
    settle: async (name) => {
      const room = rooms.get(name);
      if (!room) return;
      await room.roundtripCheck; // 6단계 S2: 뒤에서 도는 왕복 점검까지
      await room.queue;
    },
    /** 시험용: 지금 세대를 바꾼다(원래는 방이 10분 빈 뒤에만). 그 앞 세대에서 끊긴 참여자는 welcome 을 받는다. */
    changeGeneration: (name) => { const room = rooms.get(name); return room ? enqueue(room, () => changeGeneration(room, '요청')) : Promise.resolve(); },
    /** 시험용: 지금 저장본을 쓴다 */
    saveDoc: (name) => { const room = rooms.get(name); return room ? enqueue(room, () => saveDoc(room, '요청')) : Promise.resolve(); },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  let server;
  try {
    server = startServer({ port, host });
  } catch (error) {
    // 설정 오류(루프백이 아닌데 인증 설정이 없음 등)는 시작을 거부한다.
    console.error(`시작하지 않음: ${error.message}`);
    process.exit(1);
  }
  server.ready.then(
    () => {
      const shown = host.includes(':') ? `[${host}]` : host;
      const [h, w] = server.secure ? ['https', 'wss'] : ['http', 'ws'];
      console.log(`cc-rhwp collab server: ${w}://${shown}:${server.port} (인증 ${server.authMode}${process.env.COLLAB_STATIC_DIR ? `, 편집기 ${h}://${shown}:${server.port}/` : ''}, 업로드 ${h}://${shown}:${server.port}/upload)`);
    },
    (error) => { console.error(error.message); process.exit(1); },
  );
  // 서버 종료 때 저장본(S3-3). kill -9 는 여기를 지나지 않는다 — 그때는 fsync 한 기록으로 복원한다.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { server.close().finally(() => process.exit(0)); });
  }
}
