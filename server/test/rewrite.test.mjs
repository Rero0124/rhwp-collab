// 6단계 S1 서버가 다시 쓴 state: edit 권한의 state 바이트 C 를 정본이 판정한 뒤, 바뀐 부분만 모델에서 다시 쓴 바이트 S 로
// 바꿔 기록·방송한다(보낸 쪽 ack 에는 replaced: true). 파서가 모델에 남기지 않는 레코드를 끼운 C 가 원본 바이트 캐시를 타고
// 저장본·다른 참여자에게 가는 길을 막는다.
// 원시 클라이언트가 HWP 구역 스트림(Section0)에 모르는 태그의 레코드를 끼운다 — 복합 파일의 그 스트림 마지막 섹터의 남는
// 자리를 쓰고 디렉터리 항목의 크기만 고친다(파일 구조를 다시 쓰지 않는다).
// 다시 쓰기 보조(collabRewriteState)가 합쳐지기 전에는 그 시험을 건너뛰고, 지금 흐름(받은 바이트 그대로)을 확인한다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { startServer } from '../server.mjs';
import { DEFAULT_PKG } from '../canonical.mjs';
import { LocalDocStore } from '../doc-store.mjs';
import { hs256Auth } from '../auth.mjs';
import { CollabEngine } from '../../collab-client/src/engine/engine.ts';
import { ENGINE_FINGERPRINT } from '../../collab-client/src/engine/catalog.ts';
import { hasEvil, injectEvil } from './support/hwp-forge.mjs';

const wasm = await import(pathToFileURL(`${DEFAULT_PKG}/rhwp.js`).href);
wasm.initSync({ module: readFileSync(`${DEFAULT_PKG}/rhwp_bg.wasm`) });
const REWRITE = typeof wasm.HwpDocument.prototype.collabRewriteState === 'function';
const NEEDS_REWRITE = !REWRITE && 'state 다시 쓰기 보조(collabRewriteState)가 아직 없다(기존 코드 세션이 합친 뒤에 돈다)';

/** 정상 편집을 한 문서에 레코드를 끼운 HWP 바이트 — 남는 자리가 생길 때까지 글 길이를 바꿔 본다 */
function forgedAfter(baseRaw, edit, stream = 'Section0') {
  for (let n = 0; n < 64; n += 1) {
    const d = new wasm.HwpDocument(baseRaw);
    edit(d, '가'.repeat(n));
    const bytes = Buffer.from(gunzipSync(Buffer.from(d.collabExportState())));
    d.free();
    const out = injectEvil(bytes, stream);
    if (out) return { clean: bytes, forged: out };
  }
  throw new Error('레코드를 끼울 자리를 찾지 못함');
}

// ── 서버·클라이언트 ───────────────────────────────────────────────────

const auth = hs256Auth(randomBytes(32).toString('base64url'));
const now = () => Math.floor(Date.now() / 1000);
function blankDocument() {
  const d = wasm.HwpDocument.createEmpty();
  d.createBlankDocument();
  d.insertText(0, 0, 0, '서버가 다시 쓴 state 시험 문서');
  const raw = gunzipSync(Buffer.from(d.collabExportState()));
  d.free();
  return raw;
}
const DOC = blankDocument();
const dirs = [];
const tempDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'cc-rhwp-s1-')); dirs.push(d); return d; };

let server;
let store;
let lines;
before(async () => {
  lines = [];
  store = new LocalDocStore(tempDir());
  server = startServer({ port: 0, log: (m) => lines.push(m), delayMs: 0, auth, store });
  await server.ready;
});
after(async () => { await server?.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function makeRoom() {
  const res = await fetch(`http://127.0.0.1:${server.port}/rooms`, {
    method: 'POST', body: DOC, headers: { authorization: `Bearer ${auth.issue({ sub: 'admin', room: '*', scope: 'create', exp: now() + 600 })}` },
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function client(room, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => { const m = JSON.parse(String(data)); const w = waiters.shift(); if (w) w(m); else queue.push(m); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const c = {
    seq: 0, batch: 0,
    next: (ms = 15_000) => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name}: 메시지 없음`)), ms);
      waiters.push((m) => { clearTimeout(timer); resolve(m); });
    })),
    ops: async (entries) => {
      const batchId = `${name}:${++c.batch}`;
      ws.send(JSON.stringify({ type: 'ops', base: c.seq, entries, batchId }));
      const res = await c.next();
      if (res.type === 'ops') { c.seq = res.seq; c.apply(res); }
      return res;
    },
    apply: (msg) => c.engine.replayAll([{ seq: msg.seq, clientId: msg.clientId, entries: msg.entries }]),
    exported: () => Buffer.from(gunzipSync(Buffer.from(c.doc.collabExportState()))),
    close: () => { c.engine.detach(); c.doc.free(); ws.close(); },
  };
  ws.send(JSON.stringify({ type: 'hello', room, clientId: `${name}-${randomBytes(3).toString('hex')}`, name, engine: ENGINE_FINGERPRINT, token: auth.issue({ sub: `u-${name}`, name, room, exp: now() + 600 }) }));
  const w = await c.next();
  assert.equal(w.type, 'welcome');
  c.seq = w.seq;
  c.doc = new wasm.HwpDocument(gunzipSync(Buffer.from(w.base, 'base64')));
  c.engine = new CollabEngine({ onLocal() {}, onWarn() {} });
  c.engine.attach(c.doc);
  if (w.log.length) c.engine.replayAll(w.log);
  return c;
}
const stateEntry = (hwp) => ({ kind: 'state', data: gzipSync(hwp).toString('base64') });
const stateBytes = (entry) => gunzipSync(Buffer.from(entry.data, 'base64'));
async function canonicalDigest(room) { await server.settle(room); return (await server.rooms.get(room).canonical.digest()).digest; }
const savedDoc = (room) => { const dir = store.dir(room); const f = readdirSync(dir).find((n) => /^doc\.hwpx?$/.test(n)); return readFileSync(path.join(dir, f)); };
const typed = (d, extra) => d.insertText(0, 0, 0, `고친 글 ${extra} `);

test('위조가 실제로 rhwp 를 지난다: 다시 읽은 모델은 같고(digest 같음) 내보내면 레코드가 남는다 — 시험이 헛돌지 않는다는 확인', () => {
  const { clean, forged } = forgedAfter(DOC, typed);
  assert.equal(hasEvil(clean), false);
  assert.equal(hasEvil(forged), true);
  const a = new wasm.HwpDocument(clean);
  const b = new wasm.HwpDocument(forged);
  assert.equal(b.collabDigest(), a.collabDigest(), '모델로는 가려지지 않는다');
  assert.equal(hasEvil(Buffer.from(gunzipSync(Buffer.from(b.collabExportState())))), true, '원본 바이트 캐시를 타고 내보내기에 남는다');
  a.free(); b.free();
});

test('S1 전 흐름: 보조가 없으면 받은 state 를 그대로 쓰고(replaced 없음) 서버가 한 번 경고한다', { skip: REWRITE && '다시 쓰기 보조가 있다' }, async () => {
  const { room } = await makeRoom();
  const W = await client(room, 'W');
  const E = await client(room, 'E');
  const { forged } = forgedAfter(DOC, typed);
  const ack = await E.ops([stateEntry(forged)]);
  assert.equal(ack.type, 'ops');
  assert.equal(ack.replaced, undefined);
  assert.equal(hasEvil(stateBytes(ack.entries[0])), true, '지금은 레코드가 그대로 방송된다(S1 이 막을 길)');
  assert.ok(lines.some((l) => l.includes('collabRewriteState')), '경고');
  W.close(); E.close();
});

test('S1: 끼운 레코드는 방송·다른 참여자·서버 저장본·내려받은 파일 어디에도 없다, 보낸 쪽 ack 는 replaced 와 S', { skip: NEEDS_REWRITE }, async () => {
  const { room, invite } = await makeRoom();
  const W = await client(room, 'W');
  const E = await client(room, 'E');
  const { forged } = forgedAfter(DOC, typed);
  const ack = await E.ops([stateEntry(forged)]);
  assert.equal(ack.type, 'ops', JSON.stringify(ack).slice(0, 200));
  assert.equal(ack.replaced, true, '보낸 쪽 ack 에 replaced');
  assert.equal(hasEvil(stateBytes(ack.entries[0])), false, '보낸 쪽이 받은 S');
  const got = await W.next();
  assert.equal(got.replaced, true);
  assert.equal(hasEvil(stateBytes(got.entries[0])), false, '방송된 바이트');
  W.apply(got);
  W.seq = got.seq;
  assert.equal(hasEvil(W.exported()), false, '다른 참여자가 내보낸 파일');
  assert.equal(W.doc.collabDigest(), await canonicalDigest(room), '다른 참여자 digest = 정본');
  assert.equal(E.doc.collabDigest(), await canonicalDigest(room), '보낸 쪽(S 로 바꿔 읽음) digest = 정본');
  await server.saveDoc(room);
  assert.equal(hasEvil(savedDoc(room)), false, '서버 저장본(doc.*)');
  const dl = await fetch(`http://127.0.0.1:${server.port}/rooms/${room}/document`, { headers: { authorization: `Bearer ${invite.view}` } });
  assert.equal(hasEvil(Buffer.from(await dl.arrayBuffer())), false, '내려받은 파일');
  // 디스크 기록에도 S 만
  const saved = await store.load(room);
  assert.ok(saved.log.every((item) => item.entries.every((e) => e.kind !== 'state' || !hasEvil(stateBytes(e)))), '기록(log.jsonl)');
  W.close(); E.close();
});

test('S1: 정상 state 와 op 가 섞인 묶음([op, state, op])도 S 로 바뀌고 모든 참여자·정본의 digest 가 같다', { skip: NEEDS_REWRITE }, async () => {
  const { room } = await makeRoom();
  const W = await client(room, 'W');
  const E = await client(room, 'E');
  const d = new wasm.HwpDocument(E.exported());
  d.insertText(0, 0, 0, '앞 ');
  d.applyCharFormat(0, 0, 0, 2, JSON.stringify({ bold: true }));
  const legit = Buffer.from(gunzipSync(Buffer.from(d.collabExportState())));
  d.free();
  const entries = [
    { kind: 'op', m: 'insertText', a: [0, 0, 0, '첫 '] },
    stateEntry(legit),
    { kind: 'op', m: 'insertText', a: [0, 0, 0, '뒤 '] },
  ];
  const ack = await E.ops(entries);
  assert.equal(ack.replaced, true);
  assert.deepEqual(ack.entries.map((e) => e.kind), ['op', 'state', 'op']);
  const got = await W.next();
  W.apply(got);
  const canon = await canonicalDigest(room);
  assert.equal(W.doc.collabDigest(), canon);
  assert.equal(E.doc.collabDigest(), canon);
  W.close(); E.close();
});

/**
 * 대역 보조로 서버 흐름만 확인한다(보조가 합쳐지기 전에도 돈다): 진짜 rhwp 를 다시 내보내는 모듈에 받은 바이트를 그대로
 * 돌려주는 collabRewriteState 를 붙인 pkg 를 임시 디렉터리에 만들고, 그 pkg 로 띄운 서버에서 replaced·자리 바꿈·기록을 본다.
 * (레코드가 빠지는지는 진짜 보조로만 확인할 수 있다 — 위 시험.)
 */
test('S1 서버 흐름(대역 보조 S = C): ack·방송에 replaced, 묶음 안 state 자리만 바뀜, digest 같음', async () => {
  const pkg = tempDir();
  symlinkSync(path.join(DEFAULT_PKG, 'rhwp_bg.wasm'), path.join(pkg, 'rhwp_bg.wasm'));
  writeFileSync(path.join(pkg, 'rhwp.js'), [
    `import * as real from ${JSON.stringify(pathToFileURL(path.join(DEFAULT_PKG, 'rhwp.js')).href)};`,
    `export * from ${JSON.stringify(pathToFileURL(path.join(DEFAULT_PKG, 'rhwp.js')).href)};`,
    'export default real.default;',
    "if (typeof real.HwpDocument.prototype.collabRewriteState !== 'function') {",
    '  real.HwpDocument.prototype.collabRewriteState = function collabRewriteState(bytes) { globalThis.__rewrites = (globalThis.__rewrites ?? 0) + 1; return bytes; };',
    '}',
  ].join('\n'));
  const stub = startServer({ port: 0, log: () => {}, delayMs: 0, auth, store: new LocalDocStore(tempDir()), pkg });
  await stub.ready;
  try {
    const res = await fetch(`http://127.0.0.1:${stub.port}/rooms`, { method: 'POST', body: DOC, headers: { authorization: `Bearer ${auth.issue({ sub: 'a', room: '*', scope: 'create', exp: now() + 600 })}` } });
    const { room } = await res.json();
    const saved = server;
    server = stub; // client() 가 쓰는 서버
    try {
      const W = await client(room, 'W');
      const E = await client(room, 'E');
      const d = new wasm.HwpDocument(E.exported());
      d.insertText(0, 0, 0, '정상 state ');
      const legit = Buffer.from(gunzipSync(Buffer.from(d.collabExportState())));
      d.free();
      const ack = await E.ops([{ kind: 'op', m: 'insertText', a: [0, 0, 0, '첫 '] }, stateEntry(legit), { kind: 'op', m: 'insertText', a: [0, 0, 0, '뒤 '] }]);
      assert.equal(ack.type, 'ops');
      assert.equal(ack.replaced, true, '보낸 쪽 ack 에 replaced');
      assert.deepEqual(ack.entries.map((e) => e.kind), ['op', 'state', 'op']);
      const got = await W.next();
      assert.equal(got.replaced, true, '방송에도');
      W.apply(got);
      const canon = (await stub.settle(room), (await stub.rooms.get(room).canonical.digest()).digest);
      assert.equal(W.doc.collabDigest(), canon);
      assert.equal(E.doc.collabDigest(), canon);
      // op 만 있는 묶음은 replaced 가 없다
      const plain = await E.ops([{ kind: 'op', m: 'insertText', a: [0, 0, 0, 'op '] }]);
      assert.equal(plain.replaced, undefined);
      W.close(); E.close();
    } finally {
      server = saved;
    }
  } finally {
    await stub.close();
  }
});

// ── DocInfo 에 끼운 모르는 레코드(기존 코드 세션의 결정 (C) — 파서가 모델 안에 날 바이트로 보존하는 자리) ──
test('DocInfo 위조가 실제로 rhwp 를 지난다: 다시 읽은 모델은 같고 내보내면 레코드가 남는다', () => {
  const { clean, forged } = forgedAfter(DOC, typed, 'DocInfo');
  assert.equal(hasEvil(clean, 'DocInfo'), false);
  assert.equal(hasEvil(forged, 'DocInfo'), true);
  const b = new wasm.HwpDocument(forged);
  assert.equal(hasEvil(Buffer.from(gunzipSync(Buffer.from(b.collabExportState()))), 'DocInfo'), true, '원본 바이트 캐시 또는 extra_records 를 타고 남는다');
  b.free();
});

test('S1(C): DocInfo 에 끼운 모르는 레코드도 방송·다른 참여자·서버 저장본 어디에도 없다', { skip: NEEDS_REWRITE }, async () => {
  const { room } = await makeRoom();
  const W = await client(room, 'W');
  const E = await client(room, 'E');
  try {
    const { forged } = forgedAfter(DOC, typed, 'DocInfo');
    const ack = await E.ops([stateEntry(forged)]);
    assert.equal(ack.replaced, true);
    assert.equal(hasEvil(stateBytes(ack.entries[0]), 'DocInfo'), false, '보낸 쪽이 받은 S');
    const got = await W.next();
    W.apply(got);
    assert.equal(hasEvil(W.exported(), 'DocInfo'), false, '다른 참여자가 내보낸 파일');
    await server.saveDoc(room);
    assert.equal(hasEvil(savedDoc(room), 'DocInfo'), false, '서버 저장본');
  } finally { W.close(); E.close(); }
});

test('S1: 다시 쓴 묶음은 기록 항목에 replaced 가 남아 디스크·welcome 기록도 같은 모양', { skip: NEEDS_REWRITE }, async () => {
  const { room, invite } = await makeRoom();
  const E = await client(room, 'E');
  const { clean } = forgedAfter(DOC, typed);
  // [state, op]: state 는 새 기준점이 되고, 그 뒤의 op 가 같은 묶음의 나머지로 기록에 남는다
  const ack = await E.ops([stateEntry(clean), { kind: 'op', m: 'insertText', a: [0, 0, 0, '뒤 '] }]);
  assert.equal(ack.replaced, true);
  await server.settle(room);
  const saved = await store.load(room);
  assert.equal(saved.log.at(-1).replaced, true, '디스크 기록 항목');
  const late = new WebSocket(`ws://127.0.0.1:${server.port}/`);
  const w = await new Promise((resolve) => {
    late.once('open', () => late.send(JSON.stringify({ type: 'hello', room, clientId: 'late', name: 'L', engine: ENGINE_FINGERPRINT, token: invite.view })));
    late.once('message', (d) => resolve(JSON.parse(String(d))));
  });
  late.close();
  assert.equal(w.type, 'welcome');
  assert.equal(hasEvil(Buffer.from(gunzipSync(Buffer.from(w.base, 'base64')))), false);
  assert.deepEqual(w.log.map((i) => [i.seq, i.replaced, i.entries.map((e) => e.kind)]), [[ack.seq, true, ['op']]], 'welcome 기록: 같은 묶음의 나머지에도 replaced');
  E.close();
});
