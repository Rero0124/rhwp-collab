// 6단계 S2 방을 열 때 왕복 점검: POST /rooms(업로드 페이지·launcher 도 이 길)에서 따로 둔 점검 워커가 collabRoundtripCheck 를
// 한 번 부른다(정본 워커를 붙잡지 않는다, 상한 COLLAB_ROUNDTRIP_TIMEOUT_MS). warn 은 방을 먼저 만들고({pending:true}) 뒤에서
// 점검해 방 메타에 남기고, 통과가 아니면 이미 들어온 참여자에게 roundtrip 알림·그 뒤의 welcome 에 결과를 싣는다. block 은
// 상한까지 기다려 통과가 아니면 422. COLLAB_ROUNDTRIP=warn|block|off.
// 보조가 없을 때의 흐름, 대역 보조(결과를 환경 변수로 정함)로 본 서버 흐름, 그리고 진짜 보조(collab-core roundtrip_check)로
// 깨끗한 문서와 rhwp 가 모르는 레코드를 끼운 문서가 서버를 지나는 길을 본다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { startServer } from '../server.mjs';
import { DEFAULT_PKG } from '../canonical.mjs';
import { LocalDocStore } from '../doc-store.mjs';
import { hs256Auth } from '../auth.mjs';
import { ENGINE_FINGERPRINT } from '../../collab-client/src/engine/catalog.ts';
import { injectEvil } from './support/hwp-forge.mjs';

const wasm = await import(pathToFileURL(`${DEFAULT_PKG}/rhwp.js`).href);
wasm.initSync({ module: readFileSync(`${DEFAULT_PKG}/rhwp_bg.wasm`) });
const HAS_CHECK = typeof wasm.HwpDocument.prototype.collabRoundtripCheck === 'function';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'cc-rhwp-s2-')); dirs.push(d); return d; };
const auth = hs256Auth(randomBytes(32).toString('base64url'));
const now = () => Math.floor(Date.now() / 1000);
const DOC = (() => { const d = wasm.HwpDocument.createEmpty(); d.createBlankDocument(); d.insertText(0, 0, 0, '왕복 점검'); const raw = gunzipSync(Buffer.from(d.collabExportState())); d.free(); return raw; })();

/**
 * 진짜 rhwp 에 대역 collabRoundtripCheck 를 붙인 pkg: 답 = 환경 변수 CC_RHWP_FAKE_ROUNDTRIP, 걸리는 시간 =
 * CC_RHWP_FAKE_ROUNDTRIP_SLEEP_MS(점검 워커 스레드만 잠근다). 점검 워커는 만들 때의 환경을 받는다.
 */
function fakePkg() {
  const pkg = tempDir();
  const real = pathToFileURL(path.join(DEFAULT_PKG, 'rhwp.js')).href;
  symlinkSync(path.join(DEFAULT_PKG, 'rhwp_bg.wasm'), path.join(pkg, 'rhwp_bg.wasm'));
  writeFileSync(path.join(pkg, 'rhwp.js'), [
    `import * as real from ${JSON.stringify(real)};`,
    `export * from ${JSON.stringify(real)};`,
    'export default real.default;',
    'real.HwpDocument.prototype.collabRoundtripCheck = function collabRoundtripCheck() {',
    '  const ms = Number(process.env.CC_RHWP_FAKE_ROUNDTRIP_SLEEP_MS ?? 0);',
    '  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
    "  return process.env.CC_RHWP_FAKE_ROUNDTRIP ?? '{\"ok\":true,\"lost\":[],\"irDiff\":0}';",
    '};',
  ].join('\n'));
  return pkg;
}
const WARN = JSON.stringify({ ok: false, lost: [{ kind: 'ole-clsid', count: 2, detail: '중첩 OLE CLSID 가 사라짐' }, { kind: 'record', count: 5, detail: 'HWPTAG 0x5f' }], irDiff: 3 });
const TIMEOUT = { ok: null, reason: 'timeout', lost: [], irDiff: 0 };
/** 대역 보조의 답·시간을 정하고 fn 을 돌린 뒤 되돌린다 */
async function withFake({ result, sleepMs } = {}, fn) {
  const set = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = String(v); };
  set('CC_RHWP_FAKE_ROUNDTRIP', result);
  set('CC_RHWP_FAKE_ROUNDTRIP_SLEEP_MS', sleepMs);
  try { return await fn(); } finally { set('CC_RHWP_FAKE_ROUNDTRIP', undefined); set('CC_RHWP_FAKE_ROUNDTRIP_SLEEP_MS', undefined); }
}

async function create(server, body = DOC) {
  return fetch(`http://127.0.0.1:${server.port}/rooms`, { method: 'POST', body, headers: { authorization: `Bearer ${auth.issue({ sub: 'a', room: '*', scope: 'create', exp: now() + 600 })}` } });
}
function welcome(server, room, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    ws.once('error', reject);
    ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', room, clientId: `c-${randomBytes(3).toString('hex')}`, name: 'P', engine: ENGINE_FINGERPRINT, token })));
    ws.once('message', (d) => { ws.close(); resolve(JSON.parse(String(d))); });
  });
}
/** 방에 남아 있는 참여자: 받은 메시지를 모으고, 종류별로 기다린다 */
async function participant(server, room, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
  const msgs = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    msgs.push(m);
    for (const w of [...waiters]) if (w.type === m.type) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const next = (type) => {
    const seen = msgs.find((m) => m.type === type && !m.taken);
    if (seen) { seen.taken = true; return Promise.resolve(seen); }
    return new Promise((resolve) => waiters.push({ type, resolve: (m) => { m.taken = true; resolve(m); } }));
  };
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'hello', room, clientId: `p-${randomBytes(3).toString('hex')}`, name: 'P', engine: ENGINE_FINGERPRINT, token }));
  const w = await next('welcome');
  return { ws, msgs, next, welcome: w, close: () => ws.close() };
}
async function withServer(opts, fn) {
  const server = startServer({ port: 0, log: () => {}, auth, ...opts });
  await server.ready;
  try { return await fn(server); } finally { await server.close(); }
}

test('보조가 없으면 점검을 건너뛴다: 응답·welcome 에 roundtrip 없음, 방은 만든다', { skip: HAS_CHECK && '보조가 있다' }, async () => {
  await withServer({}, async (server) => {
    const res = await create(server);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.roundtrip, undefined);
    const w = await welcome(server, body.room, body.invite.edit);
    assert.equal(w.roundtrip, undefined);
  });
});

test('warn(기본): 응답은 기다리지 않고 {pending:true} — 뒤에서 점검해 방 메타에 남기고, 경고면 welcome 에 요약, 재시작 뒤에도', async () => {
  const pkg = fakePkg();
  const store = new LocalDocStore(tempDir());
  let warned;
  await withServer({ pkg, store }, async (server) => {
    const ok = await withFake({}, async () => {
      const res = await create(server);
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.deepEqual(body.roundtrip, { pending: true });
      await server.settle(body.room);
      return body;
    });
    assert.deepEqual(server.rooms.get(ok.room).roundtrip, { ok: true, lost: [], irDiff: 0 });
    assert.deepEqual((await store.load(ok.room)).meta.roundtrip, { ok: true, lost: [], irDiff: 0 }, '통과도 방 메타에');
    assert.equal((await welcome(server, ok.room, ok.invite.edit)).roundtrip, undefined, '통과면 welcome 에 없음');
    warned = await withFake({ result: WARN }, async () => {
      const res = await create(server);
      assert.equal(res.status, 201, 'warn 은 방을 만든다');
      const body = await res.json();
      assert.deepEqual(body.roundtrip, { pending: true });
      await server.settle(body.room);
      return body;
    });
    const rt = server.rooms.get(warned.room).roundtrip;
    assert.equal(rt.ok, false);
    assert.deepEqual(rt.lost.map((l) => [l.kind, l.count]), [['ole-clsid', 2], ['record', 5]]);
    assert.equal(rt.irDiff, 3);
    warned.rt = rt;
    assert.deepEqual((await welcome(server, warned.room, warned.invite.edit)).roundtrip, rt, 'welcome 에 요약');
    assert.deepEqual((await store.load(warned.room)).meta.roundtrip, rt, '방 메타');
  });
  await withServer({ store }, async (server) => {
    assert.deepEqual((await welcome(server, warned.room, warned.invite.edit)).roundtrip, warned.rt, '재시작 뒤 저장소에서 복원한 방');
  });
});

test('warn: 점검이 도는 동안에도 정본 편집은 멈추지 않고, 이미 들어온 참여자는 결과를 roundtrip 알림으로 한 번 받는다', async () => {
  const pkg = fakePkg();
  await withFake({ result: WARN, sleepMs: 1500 }, () => withServer({ pkg, roundtripTimeoutMs: 10_000 }, async (server) => {
    const body = await (await create(server)).json();
    assert.deepEqual(body.roundtrip, { pending: true });
    const p = await participant(server, body.room, body.invite.edit);
    assert.equal(p.welcome.roundtrip, undefined, '점검 중에는 welcome 에 없음');
    const t0 = Date.now();
    p.ws.send(JSON.stringify({ type: 'ops', base: p.welcome.seq, entries: [{ kind: 'op', m: 'insertText', a: [0, 0, 0, '가'] }], batchId: 'b1' }));
    const ack = await p.next('ops');
    assert.equal(ack.batchId, 'b1');
    assert.ok(Date.now() - t0 < 1000, `점검(1.5초) 중 편집 확정 ${Date.now() - t0}ms`);
    const note = await p.next('roundtrip');
    assert.equal(note.roundtrip.ok, false);
    assert.deepEqual(note.roundtrip.lost.map((l) => l.kind), ['ole-clsid', 'record']);
    await server.settle(body.room);
    assert.equal(p.msgs.filter((m) => m.type === 'roundtrip').length, 1, '한 번만');
    assert.deepEqual((await welcome(server, body.room, body.invite.view)).roundtrip, note.roundtrip, '그 뒤 들어온 참여자는 welcome 에서');
    p.close();
  }));
});

test('시간 상한: warn 은 상한을 넘기면 점검 워커를 버리고 {ok:null, reason:"timeout"} 을 남기고 알림 / block 은 422 roundtrip-timeout', async () => {
  const pkg = fakePkg();
  const store = new LocalDocStore(tempDir());
  await withFake({ sleepMs: 5000 }, async () => {
    await withServer({ pkg, store, roundtripTimeoutMs: 300 }, async (server) => {
      const body = await (await create(server)).json();
      assert.deepEqual(body.roundtrip, { pending: true });
      const p = await participant(server, body.room, body.invite.edit);
      const t0 = Date.now();
      await server.settle(body.room);
      assert.ok(Date.now() - t0 < 2500, `점검 워커를 버리고 곧 끝남(${Date.now() - t0}ms)`);
      assert.deepEqual(server.rooms.get(body.room).roundtrip, TIMEOUT);
      assert.deepEqual((await p.next('roundtrip')).roundtrip, TIMEOUT);
      assert.deepEqual((await store.load(body.room)).meta.roundtrip, TIMEOUT);
      assert.deepEqual((await welcome(server, body.room, body.invite.view)).roundtrip, TIMEOUT, '점검 못 함도 welcome 에');
      p.close();
    });
    await withServer({ pkg, roundtripMode: 'block', roundtripTimeoutMs: 300 }, async (server) => {
      const t0 = Date.now();
      const res = await create(server);
      assert.equal(res.status, 422);
      const err = await res.json();
      assert.deepEqual([err.error, err.reason, err.roundtrip], ['roundtrip', 'roundtrip-timeout', TIMEOUT]);
      assert.ok(Date.now() - t0 < 2500, `상한까지만 기다림(${Date.now() - t0}ms)`);
      assert.equal(server.rooms.size, 0, '방이 생기지 않음');
    });
  });
  assert.throws(() => startServer({ port: 0, log: () => {}, roundtripTimeoutMs: 0 }), /COLLAB_ROUNDTRIP_TIMEOUT_MS/);
});

test('block: 상한까지 기다려 통과하지 못하면 422 roundtrip(방을 만들지 않음), 통과면 응답에 결과 / off: 점검하지 않음 / 모르는 값이면 시작 거부', async () => {
  const pkg = fakePkg();
  await withFake({ result: WARN }, async () => {
    await withServer({ pkg, roundtripMode: 'block' }, async (server) => {
      const res = await create(server);
      assert.equal(res.status, 422);
      const body = await res.json();
      assert.equal(body.error, 'roundtrip');
      assert.equal(body.reason, 'roundtrip');
      assert.equal(body.roundtrip.ok, false);
      assert.equal(server.rooms.size, 0, '방이 생기지 않음');
    });
    await withServer({ pkg, roundtripMode: 'off' }, async (server) => {
      const res = await create(server);
      assert.equal(res.status, 201);
      assert.equal((await res.json()).roundtrip, undefined, 'off 는 점검하지 않음');
    });
  });
  await withFake({}, () => withServer({ pkg, roundtripMode: 'block' }, async (server) => {
    const res = await create(server);
    assert.equal(res.status, 201, 'block 이어도 통과면 만든다');
    assert.deepEqual((await res.json()).roundtrip, { ok: true, lost: [], irDiff: 0 }, 'block 은 기다린 결과를 응답에');
  }));
  assert.throws(() => startServer({ port: 0, log: () => {}, roundtripMode: 'strict' }), /COLLAB_ROUNDTRIP/);
});

/** 구역 0 에 모르는 태그의 레코드를 끼운 HWP — 남는 자리가 생길 때까지 글 길이를 바꿔 본다 */
function withUnknownRecord() {
  for (let n = 0; n < 64; n += 1) {
    const d = wasm.HwpDocument.createEmpty();
    d.createBlankDocument();
    d.insertText(0, 0, 0, `왕복 점검${'가'.repeat(n)}`);
    const raw = gunzipSync(Buffer.from(d.collabExportState()));
    d.free();
    const out = injectEvil(raw);
    if (out) return out;
  }
  throw new Error('남는 자리가 있는 문서를 만들지 못함');
}

test('진짜 보조: 깨끗한 문서는 통과, 모르는 레코드를 끼운 문서는 record 경고(warn 은 만들고 뒤에서 요약, block 은 422)', { skip: !HAS_CHECK && '보조가 없다' }, async () => {
  const forged = withUnknownRecord();
  const direct = new wasm.HwpDocument(forged);
  const rt = JSON.parse(direct.collabRoundtripCheck());
  direct.free();
  assert.equal(rt.ok, false);
  assert.ok(rt.lost.some((l) => l.kind === 'record' && l.count >= 1), JSON.stringify(rt));
  await withServer({}, async (server) => {
    const clean = await (await create(server)).json();
    await server.settle(clean.room);
    assert.deepEqual(server.rooms.get(clean.room).roundtrip, { ok: true, lost: [], irDiff: 0 });
    const res = await create(server, forged);
    assert.equal(res.status, 201);
    const warned = await res.json();
    await server.settle(warned.room);
    assert.deepEqual(server.rooms.get(warned.room).roundtrip, rt, '서버가 부른 결과 = 직접 부른 결과');
    assert.deepEqual((await welcome(server, warned.room, warned.invite.edit)).roundtrip, rt);
  });
  await withServer({ roundtripMode: 'block' }, async (server) => {
    const res = await create(server, forged);
    assert.equal(res.status, 422);
    assert.equal((await res.json()).roundtrip.ok, false);
    const clean = await create(server);
    assert.equal(clean.status, 201, '깨끗한 문서는 block 이어도 만든다');
    assert.deepEqual((await clean.json()).roundtrip, { ok: true, lost: [], irDiff: 0 });
  });
});
