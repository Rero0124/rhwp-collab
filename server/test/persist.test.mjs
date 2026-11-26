// S3-3 영속 저장 검증 (docs/collab-stage3.md S3-3, 결정 2026-11-26 "계보 보존"): fsync 뒤 방송, 저장본(doc)과
// 기준점(base) 구분, 빈 방의 세대 전환(정본도 다시 읽음), 세대가 다르면 따라잡기 대신 welcome, kill -9 뒤 손실 없음,
// 쓰다 만 마지막 줄, 엔진 업그레이드, 긴 기록 welcome 나눠 보내기. 실제 rhwp WASM(upstream/rhwp/pkg) 필요.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startServer } from '../server.mjs';
import { DEFAULT_PKG } from '../canonical.mjs';
import { LocalDocStore, roomDirName } from '../doc-store.mjs';
import { ENGINE_FINGERPRINT } from '../../collab-client/src/engine/catalog.ts';

const wasm = await import(pathToFileURL(`${DEFAULT_PKG}/rhwp.js`).href);
wasm.initSync({ module: readFileSync(`${DEFAULT_PKG}/rhwp_bg.wasm`) });
const seed = new wasm.HwpDocument(readFileSync(new URL('../../upstream/rhwp/samples/biz_plan.hwp', import.meta.url)));
const BASE = Buffer.from(seed.collabExportState()).toString('base64');
seed.free();
const RAW = gunzipSync(Buffer.from(BASE, 'base64'));
/** 처음 base 에 같은 편집을 적용한 참조 digest(다시 읽지 않은 계보) */
const reference = (texts) => {
  const d = new wasm.HwpDocument(RAW);
  texts.forEach((t, i) => d.insertText(0, 0, 0, `${t}${i}`));
  const digest = d.collabDigest();
  d.free();
  return digest;
};
const digestOf = (packedB64) => { const d = new wasm.HwpDocument(gunzipSync(Buffer.from(packedB64, 'base64'))); const x = d.collabDigest(); d.free(); return x; };
const dirs = [];
const tempDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'cc-rhwp-s33-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function client(url, room, clientId, { engine = ENGINE_FINGERPRINT, lastSeq, generation } = {}) {
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
    next: (ms = 20_000) => {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${clientId}: 메시지 없음`)), ms);
        waiters.push((m) => { clearTimeout(timer); resolve(m); });
      });
    },
    silent: async (ms = 400) => { await new Promise((r) => setTimeout(r, ms)); assert.deepEqual(queue, [], `${clientId}: 예상 밖 메시지`); },
    close: () => new Promise((r) => { if (ws.readyState === ws.CLOSED) return r(); ws.once('close', r); ws.close(); }),
  };
  c.send({ type: 'hello', room, clientId, name: clientId, engine, ...(lastSeq !== undefined ? { lastSeq, generation } : {}) });
  return c;
}
const op = (t, i) => ({ kind: 'op', m: 'insertText', a: [0, 0, 0, `${t}${i}`] });
async function roomWithEdits(server, url, name, texts) {
  const a = await client(url, name, 'A');
  assert.equal((await a.next()).base, null);
  a.send({ type: 'base', data: BASE });
  await server.settle(name);
  for (let i = 0; i < texts.length; i += 1) {
    a.send({ type: 'ops', base: i, entries: [op(texts[i], i)] });
    assert.equal((await a.next()).seq, i + 1);
  }
  return a;
}

test('fsync 한 뒤 방송, 잠잠하면 저장본(doc)만 쓰고 기준점·기록은 그대로 — welcome = 처음 base + 기록 전부', async () => {
  const dir = tempDir();
  const store = new LocalDocStore(dir);
  const server = startServer({ port: 0, log: () => {}, store, docSaveIdleMs: 200, generationIdleMs: 600_000 });
  await server.ready;
  const url = `ws://127.0.0.1:${server.port}`;
  const a = await client(url, 'p1', 'A');
  await a.next();
  a.send({ type: 'base', data: BASE });
  await server.settle('p1');
  const texts = ['가', '나', '다'];
  for (let i = 0; i < texts.length; i += 1) {
    a.send({ type: 'ops', base: i, entries: [op(texts[i], i)] });
    assert.equal((await a.next()).seq, i + 1);
    const lines = readFileSync(path.join(dir, roomDirName('p1'), 'log.jsonl'), 'utf8').trim().split('\n');
    assert.equal(JSON.parse(lines[lines.length - 1]).seq, i + 1, '방송 받기 전에 디스크에 있다');
  }
  await new Promise((r) => setTimeout(r, 600));
  await server.settle('p1');
  const saved = await store.load('p1');
  assert.equal(saved.meta.docSeq, 3, '저장본이 seq 3 까지 덮음');
  assert.ok(saved.doc);
  assert.equal(saved.meta.baseSeq, 0, '기준점은 처음 base 그대로');
  assert.equal(saved.log.length, 3, '기록은 비우지 않음');
  const b = await client(url, 'p1', 'B');
  const w = await b.next();
  assert.equal(w.base, BASE);
  assert.deepEqual(w.log.map((x) => x.seq), [1, 2, 3]);
  assert.equal(w.generation ?? 0, 0, '0세대(welcome 에 싣지 않음)');
  await a.close();
  await b.close();
  await server.close();
});

test('빈 방의 세대 전환: 정본을 내보내 새 base 로, 정본도 그 바이트를 다시 읽고 기록을 비운다. 앞 세대에서 끊긴 참여자는 welcome', async () => {
  const dir = tempDir();
  const store = new LocalDocStore(dir);
  let server = startServer({ port: 0, log: () => {}, store, generationIdleMs: 300 });
  await server.ready;
  let url = `ws://127.0.0.1:${server.port}`;
  const texts = ['세', '대'];
  const a = await roomWithEdits(server, url, 'g1', texts);
  await a.close();
  await new Promise((r) => setTimeout(r, 900));
  await server.settle('g1');
  assert.equal(server.rooms.has('g1'), false, '세대 전환 뒤 메모리에서 내림');
  const saved = await store.load('g1');
  assert.equal(saved.meta.generation, 1);
  assert.equal(saved.meta.baseSeq, 2);
  assert.equal(saved.log.length, 0);
  await server.close();

  server = startServer({ port: 0, log: () => {}, store, generationIdleMs: 600_000 });
  await server.ready;
  url = `ws://127.0.0.1:${server.port}`;
  // 앞 세대에서 seq 2 에 끊긴 참여자: lastSeq 는 범위 안이지만 세대가 달라 따라잡기 대신 welcome
  const old = await client(url, 'g1', 'OLD', { lastSeq: 2, generation: 0 });
  const w = await old.next();
  assert.equal(w.type, 'welcome');
  assert.equal(w.generation, 1);
  assert.equal(w.seq, 2);
  assert.equal(w.log.length, 0);
  // 정본 = 새 base 를 다시 읽은 문서 = 새로 들어온 사람이 여는 문서
  assert.equal(server.rooms.get('g1').canonDigests.get(2), digestOf(w.base));
  // 같은 세대에서 끊긴 참여자는 따라잡기
  const same = await client(url, 'g1', 'SAME', { lastSeq: 2, generation: 1 });
  const cu = await same.next();
  assert.equal(cu.type, 'catchup');
  assert.deepEqual(cu.log, []);
  await old.close();
  await same.close();
  await server.close();
});

/** 자식 프로세스로 서버를 띄운다(kill -9 시험용). */
function spawnServer(dir) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: '0', COLLAB_DATA_DIR: dir, COLLAB_DOC_SAVE_IDLE_MS: '600000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /ws:\/\/[\d.]+:(\d+)/.exec(out);
      if (m) resolve({ child, url: `ws://127.0.0.1:${m[1]}` });
    });
    child.once('exit', (code) => reject(new Error(`서버가 일찍 끝남(${code}): ${out}`)));
  });
}

test('kill -9: fsync 된 마지막 묶음까지 손실 없음, 복원 digest 가 종료 직전과 같음, 끊겼던 참여자는 따라잡기', async () => {
  const dir = tempDir();
  let { child, url } = await spawnServer(dir);
  const a = await client(url, 'k1', 'A');
  await a.next();
  a.send({ type: 'base', data: BASE });
  const texts = [];
  for (let i = 0; i < 12; i += 1) {
    texts.push(`k${i}-`);
    a.send({ type: 'ops', base: i, entries: [op(texts[i], i)] });
    assert.equal((await a.next()).seq, i + 1);
  }
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  ({ child, url } = await spawnServer(dir));
  try {
    const b = await client(url, 'k1', 'B');
    const w = await b.next();
    assert.equal(w.seq, 12, '확인받은 묶음이 모두 남음');
    assert.equal(w.log.length, 12);
    const expect = reference(texts);
    b.send({ type: 'digest', seq: 12, digest: expect });
    await b.silent(600);
    b.send({ type: 'digest', seq: 12, digest: '0'.repeat(64) });
    assert.deepEqual(await b.next(), { type: 'diverged', seq: 12 }, '정본 비교가 살아 있다');
    // 죽기 전 seq 10 에서 끊겼던 참여자(같은 세대)는 따라잡기
    const r = await client(url, 'k1', 'A', { lastSeq: 10, generation: 0 });
    const cu = await r.next();
    assert.equal(cu.type, 'catchup');
    assert.deepEqual(cu.log.map((x) => x.seq), [11, 12]);
    await b.close();
    await r.close();
  } finally {
    child.kill('SIGKILL');
  }
});

test('쓰다 만 마지막 줄(fsync 전 죽음)은 버리고, 중간 줄이 깨지면 방을 열지 않는다', async () => {
  const dir = tempDir();
  const store = new LocalDocStore(dir);
  await store.setBase('t1', { baseSeq: 0, data: RAW, engine: ENGINE_FINGERPRINT, generation: 0 });
  await store.append('t1', { seq: 1, clientId: 'A', entries: [op('a', 0)] });
  appendFileSync(path.join(dir, roomDirName('t1'), 'log.jsonl'), '{"seq":2,"clientId":"A","entr');
  const saved = await store.load('t1');
  assert.deepEqual(saved.log.map((x) => x.seq), [1]);
  appendFileSync(path.join(dir, roomDirName('t1'), 'log.jsonl'), '\n{"seq":3}\n');
  await assert.rejects(store.load('t1'), /깨졌다/);
});

test('엔진 업그레이드: 저장본이 마지막 seq 를 덮으면 그것을, 아니면 남은 기록을 새 엔진으로 재생해 새 세대 기준점으로', async () => {
  const dir = tempDir();
  const store = new LocalDocStore(dir);
  // (1) 저장본이 덮음
  await store.setBase('u1', { baseSeq: 0, data: RAW, engine: 'engine-v1', generation: 0 });
  await store.append('u1', { seq: 1, clientId: 'A', entries: [op('업', 0)] });
  const covered = new wasm.HwpDocument(RAW);
  covered.insertText(0, 0, 0, '저장본');
  await store.saveDoc('u1', { seq: 1, data: gunzipSync(covered.collabExportState()) });
  covered.free();
  // (2) 덮지 못함
  await store.setBase('u2', { baseSeq: 0, data: RAW, engine: 'engine-v1', generation: 0 });
  await store.append('u2', { seq: 1, clientId: 'A', entries: [op('재생', 0)] });
  const lines = [];
  const server = startServer({ port: 0, log: (m) => lines.push(m), store, engine: 'engine-v2' });
  await server.ready;
  const url = `ws://127.0.0.1:${server.port}`;
  for (const [room, text] of [['u1', '저장본'], ['u2', '재생0']]) {
    const c = await client(url, room, 'C', { engine: 'engine-v2' });
    const w = await c.next();
    assert.equal(w.type, 'welcome', room);
    assert.equal(w.seq, 1);
    assert.equal(w.generation, 1);
    assert.equal(w.log.length, 0);
    const d = new wasm.HwpDocument(gunzipSync(Buffer.from(w.base, 'base64')));
    assert.ok(d.getTextRange(0, 0, 0, text.length) === text, `${room}: 새 기준점에 ${text}`);
    d.free();
    const saved = await store.load(room);
    assert.equal(saved.meta.engine, 'engine-v2');
    assert.equal(saved.meta.generation, 1);
    await c.close();
  }
  assert.ok(lines.some((l) => /\[u2\] 경고: 엔진이 바뀜/.test(l)), '덮지 못한 경우 경고');
  assert.ok(!lines.some((l) => /\[u1\] 경고/.test(l)));
  await server.close();
  assert.ok(existsSync(path.join(dir, roomDirName('u1'), 'base.hwp')));
});

test('긴 기록 welcome 은 나눠 보낸다: welcome(첫 조각) + catchup(cont) 조각들, 이어 붙이면 전부', async () => {
  const store = new LocalDocStore(tempDir());
  // 상한: base + 40KB — 묶음 하나(30KB)는 들어가지만 기록 넷(120KB)은 welcome 하나에 다 못 든다(조각 예산 64KB).
  const server = startServer({ port: 0, log: () => {}, store, maxMessageBytes: BASE.length + 40_000 });
  await server.ready;
  try {
    const url = `ws://127.0.0.1:${server.port}`;
    const long = 'x'.repeat(30_000);
    const a = await client(url, 'w1', 'A');
    await a.next();
    a.send({ type: 'base', data: BASE });
    await server.settle('w1');
    for (let i = 0; i < 4; i += 1) {
      a.send({ type: 'ops', base: i, entries: [op(long, i)] });
      assert.equal((await a.next()).seq, i + 1);
    }
    const b = await client(url, 'w1', 'B');
    const w = await b.next();
    assert.equal(w.type, 'welcome');
    const got = [...w.log];
    let seq = w.seq;
    while (seq < 4) {
      const m = await b.next();
      assert.equal(m.type, 'catchup');
      assert.equal(m.cont, true);
      got.push(...m.log);
      seq = m.seq;
    }
    assert.ok(w.log.length < 4, '나뉘었다');
    assert.deepEqual(got.map((x) => x.seq), [1, 2, 3, 4]);
    await a.close();
    await b.close();
  } finally {
    await server.close();
  }
});
