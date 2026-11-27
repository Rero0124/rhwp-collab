// 5단계 D1·D3·D4 서버 검증: JWT HS256 확인, hello 인증과 unauthorized 이유 코드, 권한(view·form)별 거절,
// 서버가 찍는 sub, 방 만들기·내려받기 API, Origin, url 방식. 정본(실제 rhwp WASM)을 켠다 — build-wasm.sh 가 먼저다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { startServer } from '../server.mjs';
import { DEFAULT_PKG } from '../canonical.mjs';
import { LocalDocStore } from '../doc-store.mjs';
import {
  AuthError, authFromEnv, hs256Auth, isLoopback, normalizeUser, parseDuration, roomAllowed, signHs256, urlAuth, verifyHs256,
} from '../auth.mjs';
import { ENGINE_FINGERPRINT } from '../../collab-client/src/engine/catalog.ts';

const wasm = await import(pathToFileURL(`${DEFAULT_PKG}/rhwp.js`).href);
wasm.initSync({ module: readFileSync(`${DEFAULT_PKG}/rhwp_bg.wasm`) });
const RAW = readFileSync(new URL('../../upstream/rhwp/samples/biz_plan.hwp', import.meta.url));

// 시험 안에서만 쓰는 무작위 비밀키(저장소에 남지 않는다)
const SECRET = randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const tok = (claims = {}, secret = SECRET) => signHs256({ sub: 'u1', name: '가나', room: '*', exp: now() + 600, ...claims }, secret);
const payloadOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'cc-rhwp-d1-')); dirs.push(d); return d; };

// ── JWT HS256 단위 ──────────────────────────────────────────────────────

test('verifyHs256: 올바른 토큰은 클레임을, 형식·서명·alg 가 틀리면 invalid', () => {
  const good = tok({ room: 'r1' });
  assert.equal(verifyHs256(good, Buffer.from(SECRET)).room, 'r1');
  const [h, p, s] = good.split('.');
  const reason = (t) => { try { verifyHs256(t, Buffer.from(SECRET)); return 'ok'; } catch (e) { assert.ok(e instanceof AuthError); return e.reason; } };
  assert.equal(reason(''), 'missing');
  assert.equal(reason('abc'), 'invalid');
  assert.equal(reason(`${h}.${p}`), 'invalid');
  assert.equal(reason(`${h}.${p}.${s}x`), 'invalid', '서명 길이가 다름');
  assert.equal(reason(`${h}.${p}.${s.slice(0, -2)}AA`), 'invalid', '서명이 다름');
  assert.equal(reason(tok({}, randomBytes(32).toString('hex'))), 'invalid', '다른 비밀키');
  // alg none, HS512, crit
  assert.equal(reason(`${b64({ alg: 'none', typ: 'JWT' })}.${p}.`), 'invalid');
  assert.equal(reason(signWithHeader(b64({ alg: 'none' }), p)), 'invalid');
  assert.equal(reason(signWithHeader(b64({ alg: 'HS512' }), p)), 'invalid');
  assert.equal(reason(signWithHeader(b64({ alg: 'HS256' }), p)), 'ok', '같은 방법으로 서명한 정상 헤더는 통과');
  const critHead = b64({ alg: 'HS256', crit: ['x'] });
  assert.equal(reason(signWithHeader(critHead, p)), 'invalid');
  // 엄격한 base64url: 채움(=), 표준 base64 문자(+ /), 정규형이 아닌 끝 비트
  assert.equal(reason(`${h}.${p}=.${s}`), 'invalid');
  assert.equal(reason(`${h}.+${p.slice(1)}.${s}`), 'invalid', '표준 base64 문자');
  const nonCanonical = `${s.slice(0, -1)}${s.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(reason(`${h}.${p}.${nonCanonical}`), 'invalid');
});

/** 헤더를 바꾼 토큰에 올바르게 서명한다(서명 뒤 헤더 검사를 확인하려고). */
const signWithHeader = (head, body) => `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;

test('verifyHs256: exp 는 필수, 30초까지 시계 오차 허용, nbf 확인, sub·room 필수', () => {
  const key = Buffer.from(SECRET);
  const reason = (claims, opts) => {
    try { verifyHs256(signHs256(claims, SECRET), key, opts); return 'ok'; } catch (e) { return e.reason; }
  };
  const t = now();
  assert.equal(reason({ sub: 'a', room: '*' }), 'invalid', 'exp 없음');
  assert.equal(reason({ sub: 'a', room: '*', exp: 'x' }), 'invalid');
  assert.equal(reason({ sub: 'a', room: '*', exp: t - 10 }), 'ok', '오차 안');
  assert.equal(reason({ sub: 'a', room: '*', exp: t - 31 }), 'expired');
  assert.equal(reason({ sub: 'a', room: '*', exp: t + 60, nbf: t + 20 }), 'ok', 'nbf 오차 안');
  assert.equal(reason({ sub: 'a', room: '*', exp: t + 60, nbf: t + 60 }), 'invalid', '아직 쓸 수 없음');
  assert.equal(reason({ room: '*', exp: t + 60 }), 'invalid', 'sub 없음');
  assert.equal(reason({ sub: 'a', exp: t + 60 }), 'invalid', 'room 없음');
});

test('권한·방 클레임 정리, 기간, 루프백 판정', () => {
  assert.deepEqual(normalizeUser({ sub: 's' }).scope, ['edit'], 'scope 없으면 edit');
  assert.deepEqual(normalizeUser({ sub: 's', scope: 'form  comment' }).scope, ['form', 'comment']);
  assert.deepEqual(normalizeUser({ sub: 's', scope: ['view', 'admin', 'view'] }).scope, ['view'], '모르는 권한은 버린다');
  assert.deepEqual(normalizeUser({ sub: 's', scope: '' }).scope, [], '빈 scope 는 권한 없음');
  assert.equal(roomAllowed('*', 'x'), true);
  assert.equal(roomAllowed('x', 'x'), true);
  assert.equal(roomAllowed('x', 'y'), false);
  assert.equal(roomAllowed('x', null), true, '방 만들기는 방을 보지 않는다');
  assert.equal(parseDuration('24h', 1), 86_400);
  assert.equal(parseDuration('90', 1), 90);
  assert.equal(parseDuration(undefined, 7), 7);
  assert.throws(() => parseDuration('1w', 1));
  for (const h of ['127.0.0.1', '127.9.9.9', 'localhost', '::1', '[::1]']) assert.equal(isLoopback(h), true, h);
  for (const h of ['0.0.0.0', '192.168.0.5', '::', 'example.com']) assert.equal(isLoopback(h), false, h);
});

test('authFromEnv: 루프백 기본 none, 루프백이 아니면 설정 없이 거부, 명시한 none 은 경고, hs256 비밀키 규칙', () => {
  assert.equal(authFromEnv({}, { host: '127.0.0.1' }).mode, 'none');
  assert.throws(() => authFromEnv({}, { host: '0.0.0.0' }), /루프백이 아니다/);
  const warnings = [];
  assert.equal(authFromEnv({ COLLAB_AUTH: 'none' }, { host: '0.0.0.0', warn: (m) => warnings.push(m) }).mode, 'none');
  assert.equal(warnings.length, 1);
  assert.throws(() => authFromEnv({ COLLAB_AUTH: 'hs256' }), /COLLAB_AUTH_SECRET/);
  assert.throws(() => authFromEnv({ COLLAB_AUTH: 'hs256', COLLAB_AUTH_SECRET: 'short' }), /32바이트/);
  const file = path.join(tempDir(), 'secret');
  writeFileSync(file, `${SECRET}\n`);
  const a = authFromEnv({ COLLAB_AUTH: 'hs256', COLLAB_AUTH_SECRET_FILE: file }, { host: '0.0.0.0' });
  assert.equal(a.mode, 'hs256');
  assert.ok(typeof a.issue === 'function');
  assert.throws(() => authFromEnv({ COLLAB_AUTH: 'url' }), /COLLAB_AUTH_URL/);
  assert.throws(() => authFromEnv({ COLLAB_AUTH: 'ldap' }), /모르는/);
  assert.throws(() => startServer({ port: 0, host: '0.0.0.0', log: () => {} }), /루프백이 아니다/, 'startServer 도 시작을 거부');
});

// ── 서버(hs256) ────────────────────────────────────────────────────────

let server;
let port;
let store;
before(async () => {
  store = new LocalDocStore(tempDir());
  server = startServer({ port: 0, log: () => {}, delayMs: 0, auth: hs256Auth(SECRET), store, allowedOrigins: ['https://ok.example'], inviteTtlSec: 3600 });
  await server.ready;
  port = server.port;
});
after(() => server?.close());

const api = (pathname, { method = 'GET', token, body, headers = {} } = {}) => fetch(`http://127.0.0.1:${port}${pathname}`, {
  method, body, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
});

async function client(room, clientId, { token, name = clientId, origin, extra = {} } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, origin ? { origin } : {});
  const queue = [];
  const waiters = [];
  let closeCode = null;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const w = waiters.shift();
    if (w) w(msg); else queue.push(msg);
  });
  const closed = new Promise((r) => ws.once('close', (code) => { closeCode = code; r(code); }));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const c = {
    ws,
    closed,
    get closeCode() { return closeCode; },
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (ms = 15_000) => {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${clientId}: 메시지 없음`)), ms);
        waiters.push((m) => { clearTimeout(timer); resolve(m); });
      });
    },
    silent: async (ms = 300) => {
      await new Promise((r) => setTimeout(r, ms));
      assert.deepEqual(queue, [], `${clientId}: 예상 밖 메시지`);
    },
    close: () => new Promise((r) => { if (ws.readyState === ws.CLOSED) return r(); ws.once('close', r); ws.close(); }),
  };
  c.send({ type: 'hello', room, clientId, name, engine: ENGINE_FINGERPRINT, ...(token ? { token } : {}), ...extra });
  return c;
}

/** create 토큰으로 방을 만든다 → {room, invite} */
async function makeRoom(raw = RAW) {
  const res = await api('/rooms', { method: 'POST', token: tok({ scope: 'create' }), body: raw });
  assert.equal(res.status, 201, await res.clone().text());
  return res.json();
}

test('POST /rooms: 토큰 없음 401, create 없으면 403, HWP 가 아니면 415, 만들면 방 이름과 권한별 초대 토큰', async () => {
  let res = await api('/rooms', { method: 'POST', body: RAW });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized', reason: 'missing' });
  res = await api('/rooms', { method: 'POST', token: tok({ scope: 'edit view' }), body: RAW });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reason, 'scope');
  res = await api('/rooms', { method: 'POST', token: tok({ scope: 'create' }), body: Buffer.from('hello') });
  assert.equal(res.status, 415);
  res = await api('/rooms', { method: 'POST', token: 'x.y.z', body: RAW });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).reason, 'invalid');
  res = await api('/rooms', { token: tok({ scope: 'create' }) });
  assert.equal(res.status, 405);

  const out = await makeRoom();
  assert.match(out.room, /^[A-Za-z0-9_-]{22}$/, '128비트 base64url');
  assert.deepEqual(Object.keys(out.invite).sort(), ['comment', 'edit', 'form', 'view']);
  for (const [scope, t] of Object.entries(out.invite)) {
    const p = payloadOf(t);
    assert.equal(p.room, out.room);
    assert.equal(p.scope, scope);
    assert.equal(p.sub, 'invite');
    assert.equal(p.name, undefined, '초대 토큰에는 이름이 없다');
    assert.ok(Math.abs(p.exp - (now() + 3600)) < 5, 'inviteTtlSec');
  }
  assert.ok(Date.parse(out.inviteExpiresAt) > Date.now());
  // 저장소에 0세대 기준점 = 올린 바이트 그대로
  const saved = await store.load(out.room);
  assert.equal(saved.meta.generation, 0);
  assert.equal(saved.meta.baseSeq, 0);
  assert.deepEqual(saved.base, RAW);
});

test('hello 인증: 토큰 없음·서명·만료·다른 방·권한 없음·없는 방은 unauthorized 후 4401 로 닫는다', async () => {
  const { room } = await makeRoom();
  const cases = [
    ['missing', undefined],
    ['invalid', tok({}, randomBytes(32).toString('hex'))],
    ['expired', tok({ exp: now() - 120 })],
    ['room', tok({ room: 'other-room' })],
    ['scope', tok({ scope: 'create' })],
  ];
  for (const [reason, token] of cases) {
    const c = await client(room, `C-${reason}`, { token });
    assert.deepEqual(await c.next(), { type: 'unauthorized', reason }, reason);
    assert.equal(await c.closed, 4401, reason);
  }
  // 인증을 켜면 hello 로 방을 만들 수 없다(토큰이 맞아도)
  const c = await client('made-up-room', 'C-noroom', { token: tok() });
  assert.deepEqual(await c.next(), { type: 'unauthorized', reason: 'no-room' });
  assert.equal(await c.closed, 4401);
  assert.equal(server.rooms.has('made-up-room'), false);
});

test('hello 통과: welcome 에 확인된 사용자, 커서 이름은 토큰의 name, 기록 항목의 sub 는 서버가 찍는다', async () => {
  const { room } = await makeRoom();
  const a = await client(room, 'A', { token: tok({ sub: 'user-a', name: '에이', room }), name: '주소의 이름' });
  const wa = await a.next();
  assert.equal(wa.type, 'welcome');
  assert.ok(wa.base, '방 만들기로 정한 base');
  assert.deepEqual(wa.user, { sub: 'user-a', name: '에이', scope: ['edit'] });
  const b = await client(room, 'B', { token: tok({ sub: 'user-b', name: '비' }) });
  assert.equal((await b.next()).type, 'welcome');

  a.send({ type: 'cursor', seq: 0, caret: { section: 0, para: 0, offset: 0 } });
  const cur = await b.next();
  assert.equal(cur.type, 'cursor');
  assert.equal(cur.name, '에이', 'hello.name 이 아니라 토큰의 name');

  // 클라이언트가 sub 를 실어 보내도 쓰지 않는다
  a.send({ type: 'ops', base: 0, entries: [{ kind: 'op', m: 'insertText', a: [0, 0, 0, '인증'] }], batchId: 'A:1', sub: 'forged' });
  const ack = await a.next();
  assert.equal(ack.type, 'ops');
  assert.equal(ack.sub, 'user-a');
  assert.equal(ack.batchId, 'A:1');
  assert.equal((await b.next()).sub, 'user-a');
  await server.settle(room);
  const saved = await store.load(room);
  assert.equal(saved.log.at(-1).sub, 'user-a', '디스크 기록에도');
  // 다시 붙은 참여자의 catchup 에도 사용자와 sub
  const a2 = await client(room, 'A', { token: tok({ sub: 'user-a', name: '에이', room }), extra: { lastSeq: 0, generation: 0 } });
  const cu = await a2.next();
  assert.equal(cu.type, 'catchup');
  assert.equal(cu.log[0].sub, 'user-a');
  assert.deepEqual(cu.user, { sub: 'user-a', name: '에이', scope: ['edit'] });
  await Promise.all([a.close(), b.close(), a2.close()]);
});

test('초대 토큰(이름 없음): 표시 이름은 hello.name, sub 는 연결마다 다른 꼬리', async () => {
  const { room, invite } = await makeRoom();
  const a = await client(room, 'A', { token: invite.edit, name: '철수' });
  const b = await client(room, 'B', { token: invite.edit, name: '' });
  const [wa, wb] = [await a.next(), await b.next()];
  assert.equal(wa.user.name, '철수');
  assert.equal(wb.user.name, '손님', '빈 이름은 손님');
  assert.match(wa.user.sub, /^invite~[0-9a-f]{8}$/);
  assert.notEqual(wa.user.sub, wb.user.sub);
  await Promise.all([a.close(), b.close()]);
});

test('view: 편집·base 는 forbidden(연결 유지, seq 그대로, 방송 없음), 커서·resync 는 된다', async () => {
  const { room, invite } = await makeRoom();
  const e = await client(room, 'E', { token: invite.edit });
  const v = await client(room, 'V', { token: invite.view });
  assert.equal((await e.next()).type, 'welcome');
  const wv = await v.next();
  assert.deepEqual(wv.user.scope, ['view']);
  v.send({ type: 'ops', base: 0, entries: [{ kind: 'op', m: 'insertText', a: [0, 0, 0, 'x'] }], batchId: 'V:1' });
  assert.deepEqual(await v.next(), { type: 'forbidden', what: 'ops', reason: 'scope', batchId: 'V:1' });
  v.send({ type: 'ops', base: 0, entries: [{ kind: 'state', data: wv.base }] });
  assert.deepEqual(await v.next(), { type: 'forbidden', what: 'ops', reason: 'scope' });
  v.send({ type: 'base', data: wv.base });
  assert.deepEqual(await v.next(), { type: 'forbidden', what: 'base', reason: 'scope' });
  await e.silent();
  assert.equal(server.rooms.get(room).seq, 0);
  v.send({ type: 'cursor', seq: 0, caret: null });
  assert.equal((await e.next()).type, 'cursor');
  v.send({ type: 'resync' });
  const rs = await v.next();
  assert.equal(rs.type, 'welcome');
  assert.equal(rs.resync, true);
  assert.equal(v.ws.readyState, WebSocket.OPEN);
  await Promise.all([e.close(), v.close()]);
});

test('form·comment: 정본이 결과로 판정 — 허용 밖 편집(본문 입력)은 forbidden(confined), seq 그대로', async () => {
  // collabCheckConfined(5단계 D4 보조)가 합쳐진 뒤의 동작. 허용 부분의 편집·우회 사례 전체는 따로 시험한다.
  const { room, invite } = await makeRoom();
  for (const scope of ['form', 'comment']) {
    const c = await client(room, scope, { token: invite[scope] });
    const w = await c.next();
    assert.deepEqual(w.user.scope, [scope]);
    c.send({ type: 'ops', base: 0, entries: [{ kind: 'op', m: 'insertText', a: [0, 0, 0, '본문'], meta: { len: 2 } }], batchId: `${scope}:1` });
    assert.deepEqual(await c.next(), { type: 'forbidden', what: 'ops', reason: 'confined', batchId: `${scope}:1` });
    await c.close();
  }
  await server.settle(room);
  assert.equal(server.rooms.get(room).seq, 0);
});

test('GET /rooms/{room}/document: 참여 권한 토큰만(create 만으로는 403), 편집이 반영된 파일, 다시 열면 세대 전환한 정본과 digest 같음', async () => {
  const { room, invite } = await makeRoom();
  let res = await api(`/rooms/${room}/document`);
  assert.equal(res.status, 401);
  res = await api(`/rooms/${room}/document`, { token: tok({ scope: 'create' }) });
  assert.equal(res.status, 403, 'create 는 방 만들기만');
  res = await api(`/rooms/${room}/document`, { token: tok({ room: 'other' }) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reason, 'room');
  res = await api('/rooms/no-such-room/document', { token: tok() });
  assert.equal(res.status, 404);

  // 편집 전: 올린 파일과 같은 문서
  res = await api(`/rooms/${room}/document`, { token: invite.view });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-collab-seq'), '0');
  assert.match(res.headers.get('content-disposition'), /document\.hwp/);
  const before = Buffer.from(await res.arrayBuffer());

  const a = await client(room, 'A', { token: invite.edit, name: 'A' });
  await a.next();
  a.send({ type: 'ops', base: 0, entries: [{ kind: 'op', m: 'insertText', a: [0, 0, 0, '내려받기'] }] });
  assert.equal((await a.next()).seq, 1);
  await a.close();
  await server.settle(room);

  res = await api(`/rooms/${room}/document`, { token: invite.edit });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-collab-seq'), '1');
  const file = Buffer.from(await res.arrayBuffer());
  const digestOf = (bytes) => { const d = new wasm.HwpDocument(bytes); const x = d.collabDigest(); d.free(); return x; };
  assert.notEqual(digestOf(file), digestOf(before), '편집이 반영됨');
  // 참조: 처음 파일에 같은 편집 → 내보내기 → 다시 읽기
  const ref = new wasm.HwpDocument(RAW);
  ref.insertText(0, 0, 0, '내려받기');
  const refFile = gunzipSync(Buffer.from(ref.collabExportState()));
  ref.free();
  assert.equal(digestOf(file), digestOf(refFile));
  // 세대 전환(정본 내보내기 → 정본도 다시 읽음)한 정본 digest = 받은 파일을 다시 연 digest
  await server.changeGeneration(room);
  const r = server.rooms.get(room);
  assert.equal(r.canonDigests.get(r.seq), digestOf(file));
});

test('메모리에서 내린 방도 저장소에서 열어 내려받는다', async () => {
  const { room, invite } = await makeRoom();
  const r = server.rooms.get(room);
  clearTimeout(r.generationTimer);
  await r.canonical.terminate();
  server.rooms.delete(room);
  const res = await api(`/rooms/${encodeURIComponent(room)}/document`, { token: invite.view });
  assert.equal(res.status, 200);
  assert.ok(server.rooms.has(room));
  const c = await client(room, 'late', { token: invite.edit });
  assert.equal((await c.next()).type, 'welcome', '저장소의 방에는 hello 로 들어간다');
  await c.close();
});

test('Origin: 목록 밖은 업그레이드 403, 목록 안·같은 출처·Origin 없음은 통과', async () => {
  const { room, invite } = await makeRoom();
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { origin: 'https://evil.example' });
    ws.once('open', resolve);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  }), /403/);
  for (const origin of ['https://ok.example', `http://127.0.0.1:${port}`, undefined]) {
    const c = await client(room, `O-${origin ?? 'none'}`, { token: invite.view, origin });
    assert.equal((await c.next()).type, 'welcome', String(origin));
    await c.close();
  }
  const res = await api('/rooms', { method: 'POST', token: tok({ scope: 'create' }), body: RAW, headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

test('url 방식: 바깥 시스템이 {ok, sub, name, scope} 를 주면 통과, 거절 이유를 전하고, 닿지 못하면 unavailable', async () => {
  const seen = [];
  const external = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { token, room } = JSON.parse(body);
      seen.push({ token, room });
      res.setHeader('content-type', 'application/json');
      if (token === 'good') return res.end(JSON.stringify({ ok: true, sub: 'ext-1', name: '바깥', scope: 'view' }));
      if (token === 'old') return res.end(JSON.stringify({ ok: false, reason: 'expired' }));
      if (token === 'boom') { res.statusCode = 500; return res.end('{}'); }
      res.end(JSON.stringify({ ok: false, reason: 'whatever' }));
    });
  });
  await new Promise((r) => external.listen(0, '127.0.0.1', r));
  const auth = urlAuth(`http://127.0.0.1:${external.address().port}/verify`, { timeoutMs: 2000 });
  assert.deepEqual(await auth.verify('good', 'r1'), { sub: 'ext-1', name: '바깥', scope: ['view'] });
  assert.deepEqual(seen.at(-1), { token: 'good', room: 'r1' });
  const reason = (p) => p.then(() => 'ok', (e) => e.reason);
  assert.equal(await reason(auth.verify('old', 'r1')), 'expired');
  assert.equal(await reason(auth.verify('other', 'r1')), 'invalid', '모르는 이유는 invalid');
  assert.equal(await reason(auth.verify('boom', 'r1')), 'unavailable');
  assert.equal(await reason(auth.verify('', 'r1')), 'missing');
  await new Promise((r) => external.close(r));
  assert.equal(await reason(auth.verify('good', 'r1')), 'unavailable', '닿지 못함');
});

test('검증 함수를 끼울 수 있다: startServer({ auth: { mode, verify } })', async () => {
  const custom = startServer({
    port: 0, log: () => {}, canonical: false,
    auth: { mode: 'custom', verify: async (token) => { if (token !== 'let-me-in') throw new AuthError('invalid'); return { sub: 'c1', name: '끼움' }; } },
  });
  await custom.ready;
  assert.equal(custom.authMode, 'custom');
  const ws = new WebSocket(`ws://127.0.0.1:${custom.port}/`);
  await new Promise((r) => ws.once('open', r));
  const msg = new Promise((r) => ws.once('message', (d) => r(JSON.parse(d.toString()))));
  ws.send(JSON.stringify({ type: 'hello', room: 'r', clientId: 'x', name: 'x', engine: ENGINE_FINGERPRINT, token: 'nope' }));
  assert.deepEqual(await msg, { type: 'unauthorized', reason: 'invalid' });
  ws.close();
  // 끼운 함수가 create 를 주지 않았으므로 방을 만들 수 없다
  const res = await fetch(`http://127.0.0.1:${custom.port}/rooms`, { method: 'POST', headers: { authorization: 'Bearer let-me-in' }, body: RAW });
  assert.equal(res.status, 403, '끼운 함수가 create 를 주지 않음');
  await custom.close();
});

// ── 6단계 S3 권한 매핑(COLLAB_ROLE_MAP) ───────────────────────────────

test('권한 매핑: 역할 → 권한, 여러 역할은 합침, scope 와도 합침, 표에 없는 역할은 아무 권한도 없음, 표 오타는 시작 거부', async () => {
  const { parseRoleMap } = await import('../auth.mjs');
  const map = parseRoleMap({ 작성자: 'edit', 검토자: 'comment', 열람자: ['view'], 양식담당: 'form view' });
  assert.deepEqual(normalizeUser({ sub: 's', roles: ['검토자'] }, map).scope, ['comment']);
  assert.deepEqual(normalizeUser({ sub: 's', roles: ['검토자', '양식담당'] }, map).scope, ['comment', 'form', 'view']);
  assert.deepEqual(normalizeUser({ sub: 's', roles: ['열람자'], scope: 'create' }, map).scope, ['create', 'view'], 'scope 와 합침');
  assert.deepEqual(normalizeUser({ sub: 's', roles: ['관리자'] }, map).scope, [], '표에 없는 역할 → 기본 거부');
  assert.deepEqual(normalizeUser({ sub: 's', roles: '작성자' }, map).scope, ['edit'], '문자열 하나도 역할 하나');
  assert.deepEqual(normalizeUser({ sub: 's', roles: ['작성자'] }, null).scope, [], '표가 없으면 역할은 권한을 주지 않음(edit 로 넓히지 않음)');
  assert.deepEqual(normalizeUser({ sub: 's' }, map).scope, ['edit'], '둘 다 없으면 지금처럼 edit');
  assert.equal(JSON.stringify(normalizeUser({ sub: 's', roles: ['검토자'] }, map)).includes('검토자'), false, '역할 이름은 결과에 남기지 않음');
  assert.throws(() => parseRoleMap({ 작성자: 'edti' }), /모르는 권한 edti/);
  assert.throws(() => parseRoleMap(['edit']), /JSON 객체/);
  const file = path.join(tempDir(), 'roles.json');
  writeFileSync(file, JSON.stringify({ 작성자: 'edit', 검토자: 'commnet' }));
  assert.throws(() => authFromEnv({ COLLAB_AUTH: 'hs256', COLLAB_AUTH_SECRET: SECRET, COLLAB_ROLE_MAP: file }), /commnet/, '표 오타로 시작 거부');
  writeFileSync(file, JSON.stringify({ 작성자: 'edit' }));
  assert.equal(authFromEnv({ COLLAB_AUTH: 'hs256', COLLAB_AUTH_SECRET: SECRET, COLLAB_ROLE_MAP: file }).roleMap.get('작성자')[0], 'edit');
});

test('권한 매핑: hs256 토큰의 roles 로 들어오고(welcome.user.scope = 바꾼 권한), 표에 없는 역할만이면 unauthorized scope, 로그에 역할 이름 없음', async () => {
  const { parseRoleMap } = await import('../auth.mjs');
  const lines = [];
  const mapped = startServer({ port: 0, log: (m) => lines.push(m), auth: hs256Auth(SECRET, { roleMap: parseRoleMap({ 작성자: 'edit', 검토자: 'comment', 열람자: 'view' }) }) });
  await mapped.ready;
  try {
    const res = await fetch(`http://127.0.0.1:${mapped.port}/rooms`, { method: 'POST', body: RAW, headers: { authorization: `Bearer ${tok({ roles: ['작성자'], scope: 'create' })}` } });
    assert.equal(res.status, 201);
    const { room } = await res.json();
    const hello = (claims) => new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${mapped.port}/`);
      ws.once('error', reject);
      ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', room, clientId: `r-${randomBytes(3).toString('hex')}`, name: 'R', engine: ENGINE_FINGERPRINT, token: tok({ room, ...claims }) })));
      ws.once('message', (d) => { ws.close(); resolve(JSON.parse(String(d))); });
    });
    const w = await hello({ roles: ['검토자', '열람자'] });
    assert.equal(w.type, 'welcome');
    assert.deepEqual(w.user.scope, ['comment', 'view'], '역할을 바꿔 합친 권한');
    assert.deepEqual(await hello({ roles: ['관리자'] }), { type: 'unauthorized', reason: 'scope' }, '표에 없는 역할만 → 권한 없음');
    assert.ok(!lines.some((l) => /관리자|검토자|열람자|작성자/.test(l)), '로그에 역할 이름이 없음');
  } finally {
    await mapped.close();
  }
});

test('권한 매핑: url 방식 확인 서버가 roles 를 답하면 바꾸고 합치며, 표에 없는 역할은 거부', async () => {
  const { parseRoleMap } = await import('../auth.mjs');
  const external = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { token } = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      const answers = {
        one: { ok: true, sub: 'u1', roles: ['검토자'] },
        two: { ok: true, sub: 'u2', roles: ['검토자', '열람자'], scope: 'create' },
        stranger: { ok: true, sub: 'u3', roles: ['청소부'] },
      };
      res.end(JSON.stringify(answers[token] ?? { ok: false, reason: 'invalid' }));
    });
  });
  await new Promise((r) => external.listen(0, '127.0.0.1', r));
  try {
    const auth = urlAuth(`http://127.0.0.1:${external.address().port}/`, { roleMap: parseRoleMap({ 검토자: 'comment', 열람자: 'view' }) });
    assert.deepEqual((await auth.verify('one', 'r')).scope, ['comment']);
    assert.deepEqual((await auth.verify('two', 'r')).scope, ['create', 'comment', 'view'], '여러 역할과 scope 를 합침');
    assert.deepEqual((await auth.verify('stranger', 'r')).scope, [], '표에 없는 역할 → 아무 권한도 없음');
    assert.equal(Object.hasOwn(await auth.verify('one', 'r'), 'roles'), false, '역할 이름을 넘기지 않음');
  } finally {
    await new Promise((r) => external.close(r));
  }
});
