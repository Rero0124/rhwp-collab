// S3-2 서버 정본 검증 (docs/collab-stage3.md S3-2): 기록 전 검증, 패닉 격리·재생성, 정본 기준 digest 비교.
// 실제 rhwp WASM(upstream/rhwp/pkg)과 TS 엔진으로 돈다 — scripts/build-wasm.sh 를 먼저 실행해야 한다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { startServer } from '../server.mjs';
import { DEFAULT_PKG } from '../canonical.mjs';
import { ENGINE_FINGERPRINT } from '../../collab-client/src/engine/catalog.ts';

const wasm = await import(pathToFileURL(`${DEFAULT_PKG}/rhwp.js`).href);
wasm.initSync({ module: readFileSync(`${DEFAULT_PKG}/rhwp_bg.wasm`) });
const SAMPLE = new URL('../../upstream/rhwp/samples/biz_plan.hwp', import.meta.url);

let server;
let url;
let base;
before(async () => {
  server = startServer({ port: 0, log: () => {}, delayMs: 0 });
  await server.ready;
  url = `ws://127.0.0.1:${server.port}`;
  const d = new wasm.HwpDocument(readFileSync(SAMPLE));
  base = Buffer.from(d.collabExportState()).toString('base64');
  d.free();
});
after(() => server.close());

/** 정본과 같은 방식으로 연 참조 문서 — 기대 digest 계산용 */
const reference = () => new wasm.HwpDocument(gunzipSync(Buffer.from(base, 'base64')));

async function client(room, clientId, engine = ENGINE_FINGERPRINT) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const w = waiters.shift();
    if (w) w(msg); else queue.push(msg);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const c = {
    ws,
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
  };
  c.send({ type: 'hello', room, clientId, name: clientId, engine });
  return c;
}

/** base 를 올린 방에 A(담당)·B 두 참여자 */
async function roomWithBase(name) {
  const a = await client(name, 'A');
  assert.equal((await a.next()).base, null);
  a.send({ type: 'base', data: base });
  const b = await client(name, 'B');
  const wb = await b.next();
  assert.equal(wb.type, 'welcome');
  assert.equal(wb.base, base);
  return { a, b, room: server.rooms.get(name) };
}

const op = (m, a) => ({ kind: 'op', m, a });

test('정본: 유효한 ops 는 기록·방송, 정본 digest 와 같은 보고는 조용', async () => {
  const { a, b, room } = await roomWithBase('c1');
  a.send({ type: 'ops', base: 0, entries: [op('insertText', [0, 0, 0, '정본'])] });
  assert.equal((await a.next()).seq, 1);
  assert.equal((await b.next()).seq, 1);
  const ref = reference();
  ref.insertText(0, 0, 0, '정본');
  const expect = ref.collabDigest();
  ref.free();
  assert.equal(room.canonDigests.get(1), expect, '정본 digest 가 같은 엔진으로 적용한 값');
  a.send({ type: 'digest', seq: 1, digest: expect });
  b.send({ type: 'digest', seq: 1, digest: expect });
  await a.silent();
  await b.silent();
});

test('잘못된 인자(범위 초과)는 invalid — 기록·방송 없음, seq 그대로, 방은 계속', async () => {
  const { a, b, room } = await roomWithBase('c2');
  a.send({ type: 'ops', base: 0, entries: [op('insertText', [0, 99_999, 0, 'x'])] });
  const inv = await a.next();
  assert.equal(inv.type, 'invalid');
  assert.equal(inv.what, 'ops');
  await b.silent();
  assert.equal(room.seq, 0);
  assert.equal(room.log.length, 0);
  a.send({ type: 'ops', base: 0, entries: [op('insertText', [0, 0, 0, 'ok'])] });
  assert.equal((await a.next()).seq, 1);
  assert.equal((await b.next()).seq, 1);
});

test('기록할 수 없는 기능·형식은 invalid (분류표 op 만 정본에 부른다)', async () => {
  const { a, b } = await roomWithBase('c3');
  for (const entries of [[op('exportHwp', [])], [op('free', [])], [op('constructor', [])], [{ kind: 'bogus' }], [op('insertText', 'x')]]) {
    a.send({ type: 'ops', base: 0, entries });
    const inv = await a.next();
    assert.equal(inv.type, 'invalid', JSON.stringify(entries));
  }
  await b.silent();
});

test('묶음 중간이 실패하면 통째로 거절하고 정본을 적용 전으로 되돌린다', async () => {
  const { a, b, room } = await roomWithBase('c4');
  const before = room.canonDigests.get(0);
  a.send({ type: 'ops', base: 0, entries: [op('insertText', [0, 0, 0, '앞']), op('insertText', [0, 99_999, 0, 'x'])] });
  assert.equal((await a.next()).type, 'invalid');
  await b.silent();
  assert.equal((await room.canonical.digest()).digest, before, '앞 기록도 정본에 남지 않음');
});

test('패닉(WASM trap): invalid, 워커를 버리고 기준점 + 기록으로 다시 만든 뒤 방은 계속', async () => {
  const { a, b, room } = await roomWithBase('c5');
  a.send({ type: 'ops', base: 0, entries: [op('insertText', [0, 0, 0, '먼저'])] });
  assert.equal((await a.next()).seq, 1);
  await b.next();
  const gen = room.canonical.generation;
  // &str 자리에 숫자 — 바인딩에서 메모리 접근 오류(trap)
  a.send({ type: 'ops', base: 1, entries: [op('insertText', [0, 0, 0, 123])] });
  const inv = await a.next();
  assert.equal(inv.type, 'invalid');
  await b.silent();
  await room.queue;
  assert.equal(room.canonical.generation, gen + 1, '워커 재생성');
  assert.equal((await room.canonical.digest()).digest, room.canonDigests.get(1), '재생성한 정본이 seq 1 의 정본과 같음');
  b.send({ type: 'ops', base: 1, entries: [op('insertText', [0, 0, 2, '뒤'])] });
  assert.equal((await b.next()).seq, 2);
  assert.equal((await a.next()).seq, 2);
  const ref = reference();
  ref.insertText(0, 0, 0, '먼저');
  ref.insertText(0, 0, 2, '뒤');
  assert.equal(room.canonDigests.get(2), ref.collabDigest());
  ref.free();
});

test('digest 가 정본과 다르면 그 클라이언트에만 diverged', async () => {
  const { a, b, room } = await roomWithBase('c6');
  a.send({ type: 'ops', base: 0, entries: [op('insertText', [0, 0, 0, 'x'])] });
  await a.next();
  await b.next();
  a.send({ type: 'digest', seq: 1, digest: room.canonDigests.get(1) });
  b.send({ type: 'digest', seq: 1, digest: 'f'.repeat(64) });
  assert.deepEqual(await b.next(), { type: 'diverged', seq: 1 });
  await a.silent();
});

test('state 기록도 정본에 먼저 적재: 깨진 state 는 invalid, 올바른 state 는 새 기준점', async () => {
  const { a, b, room } = await roomWithBase('c7');
  a.send({ type: 'ops', base: 0, entries: [{ kind: 'state', data: Buffer.from('not a document').toString('base64') }] });
  assert.equal((await a.next()).type, 'invalid');
  await b.silent();
  const ref = reference();
  ref.insertText(0, 0, 0, '상태');
  const state = Buffer.from(ref.collabExportState()).toString('base64');
  ref.collabLoadState(Buffer.from(state, 'base64'));
  const expect = ref.collabDigest();
  ref.free();
  a.send({ type: 'ops', base: 0, entries: [{ kind: 'state', data: state }] });
  assert.equal((await a.next()).seq, 1);
  await b.next();
  assert.equal(room.base, state);
  assert.equal(room.canonDigests.get(1), expect);
});

test('문서가 아닌 base 는 invalid 로 거절하고 연결을 닫는다', async () => {
  const a = await client('c8', 'A');
  await a.next();
  a.send({ type: 'base', data: Buffer.from('garbage').toString('base64') });
  const inv = await a.next();
  assert.equal(inv.type, 'invalid');
  assert.equal(inv.what, 'base');
  await new Promise((r) => a.ws.once('close', r));
  assert.equal(server.rooms.get('c8').base, null);
});

test('정본 방의 엔진은 서버 자신의 엔진: 첫 참여자라도 다른 지문이면 incompatible', async () => {
  const old = await client('c9', 'OLD', 'old-engine');
  assert.deepEqual(await old.next(), { type: 'incompatible', engine: ENGINE_FINGERPRINT });
  const a = await client('c9', 'A');
  assert.equal((await a.next()).base, null, '서버 엔진과 같은 참여자가 base 담당');
});
