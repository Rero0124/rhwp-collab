// 6단계 S2 방을 열 때 왕복 점검: POST /rooms(업로드 페이지·launcher 도 이 길)에서 정본 워커가 collabRoundtripCheck 를 한 번
// 부르고, 결과를 응답·방 메타에 남기며, 경고가 있을 때만 welcome 에 요약을 싣는다. COLLAB_ROUNDTRIP=warn|block|off.
// 진짜 보조는 기존 코드 세션이 만든다 — 여기서는 보조가 없을 때의 흐름과, 대역 보조(결과를 환경 변수로 정함)로 서버 흐름을 본다.
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

const wasm = await import(pathToFileURL(`${DEFAULT_PKG}/rhwp.js`).href);
wasm.initSync({ module: readFileSync(`${DEFAULT_PKG}/rhwp_bg.wasm`) });
const HAS_CHECK = typeof wasm.HwpDocument.prototype.collabRoundtripCheck === 'function';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'cc-rhwp-s2-')); dirs.push(d); return d; };
const auth = hs256Auth(randomBytes(32).toString('base64url'));
const now = () => Math.floor(Date.now() / 1000);
const DOC = (() => { const d = wasm.HwpDocument.createEmpty(); d.createBlankDocument(); d.insertText(0, 0, 0, '왕복 점검'); const raw = gunzipSync(Buffer.from(d.collabExportState())); d.free(); return raw; })();

/** 진짜 rhwp 에 대역 collabRoundtripCheck(답 = 환경 변수 CC_RHWP_FAKE_ROUNDTRIP)를 붙인 pkg */
function fakePkg() {
  const pkg = tempDir();
  const real = pathToFileURL(path.join(DEFAULT_PKG, 'rhwp.js')).href;
  symlinkSync(path.join(DEFAULT_PKG, 'rhwp_bg.wasm'), path.join(pkg, 'rhwp_bg.wasm'));
  writeFileSync(path.join(pkg, 'rhwp.js'), [
    `import * as real from ${JSON.stringify(real)};`,
    `export * from ${JSON.stringify(real)};`,
    'export default real.default;',
    "real.HwpDocument.prototype.collabRoundtripCheck = function collabRoundtripCheck() { return process.env.CC_RHWP_FAKE_ROUNDTRIP ?? '{\"ok\":true,\"lost\":[],\"irDiff\":0}'; };",
  ].join('\n'));
  return pkg;
}
const WARN = JSON.stringify({ ok: false, lost: [{ kind: 'ole-clsid', count: 2, detail: '중첩 OLE CLSID 가 사라짐' }, { kind: 'record', count: 5, detail: 'HWPTAG 0x5f' }], irDiff: 3 });

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

test('warn(기본): 통과면 응답에 {ok:true}, welcome 에는 싣지 않음 / 경고면 응답·welcome·방 메타에 요약, 재시작 뒤에도', async () => {
  const pkg = fakePkg();
  const store = new LocalDocStore(tempDir());
  delete process.env.CC_RHWP_FAKE_ROUNDTRIP;
  let warned;
  await withServer({ pkg, store }, async (server) => {
    let res = await create(server);
    assert.equal(res.status, 201);
    const ok = await res.json();
    assert.deepEqual(ok.roundtrip, { ok: true, lost: [], irDiff: 0 });
    assert.equal((await welcome(server, ok.room, ok.invite.edit)).roundtrip, undefined, '통과면 welcome 에 없음');
    process.env.CC_RHWP_FAKE_ROUNDTRIP = WARN;
    res = await create(server);
    assert.equal(res.status, 201, 'warn 은 방을 만든다');
    warned = await res.json();
    assert.equal(warned.roundtrip.ok, false);
    assert.deepEqual(warned.roundtrip.lost.map((l) => [l.kind, l.count]), [['ole-clsid', 2], ['record', 5]]);
    assert.equal(warned.roundtrip.irDiff, 3);
    const w = await welcome(server, warned.room, warned.invite.edit);
    assert.deepEqual(w.roundtrip, warned.roundtrip, 'welcome 에 요약');
    assert.deepEqual((await store.load(warned.room)).meta.roundtrip, warned.roundtrip, '방 메타');
  });
  delete process.env.CC_RHWP_FAKE_ROUNDTRIP;
  await withServer({ store }, async (server) => {
    const w = await welcome(server, warned.room, warned.invite.edit);
    assert.deepEqual(w.roundtrip, warned.roundtrip, '재시작 뒤 저장소에서 복원한 방');
  });
});

test('block: 통과하지 못하면 422 roundtrip(방을 만들지 않음), 통과면 그대로 / off: 점검하지 않음 / 모르는 값이면 시작 거부', async () => {
  const pkg = fakePkg();
  process.env.CC_RHWP_FAKE_ROUNDTRIP = WARN;
  try {
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
    delete process.env.CC_RHWP_FAKE_ROUNDTRIP;
    await withServer({ pkg, roundtripMode: 'block' }, async (server) => {
      assert.equal((await create(server)).status, 201, 'block 이어도 통과면 만든다');
    });
  } finally {
    delete process.env.CC_RHWP_FAKE_ROUNDTRIP;
  }
  assert.throws(() => startServer({ port: 0, log: () => {}, roundtripMode: 'strict' }), /COLLAB_ROUNDTRIP/);
});
