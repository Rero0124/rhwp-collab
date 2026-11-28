// 7단계 B 방을 열 때 배치 점검(docs/collab-stage7.md B): COLLAB_ROUNDTRIP_LAYOUT=on 이면 왕복 점검(S2) 다음에 같은 점검
// 워커·같은 시간 상한에서 collabLayoutCheck 를 부르고 경고를 lost 에 더한다(쪽 수·변위 필드를 남긴다). 배치 점검만 시간을
// 넘거나 실패하면 왕복 점검 결과는 그대로 두고 layoutUnknown 만 단다. 끄면(기본) 부르지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { startServer } from '../server.mjs';
import { DEFAULT_PKG } from '../canonical.mjs';

const wasm = await import(pathToFileURL(`${DEFAULT_PKG}/rhwp.js`).href);
wasm.initSync({ module: readFileSync(`${DEFAULT_PKG}/rhwp_bg.wasm`) });
const HAS_LAYOUT = typeof wasm.HwpDocument.prototype.collabLayoutCheck === 'function';
const DOC = (() => { const d = wasm.HwpDocument.createEmpty(); d.createBlankDocument(); d.insertText(0, 0, 0, '배치 점검'); const raw = gunzipSync(Buffer.from(d.collabExportState())); d.free(); return raw; })();

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** 진짜 rhwp 에 대역 왕복·배치 점검을 붙인 pkg — 답과 걸리는 시간은 환경 변수(점검 워커는 만들 때의 환경을 받는다) */
function fakePkg() {
  const pkg = mkdtempSync(path.join(tmpdir(), 'cc-rhwp-layout-'));
  dirs.push(pkg);
  const real = pathToFileURL(path.join(DEFAULT_PKG, 'rhwp.js')).href;
  symlinkSync(path.join(DEFAULT_PKG, 'rhwp_bg.wasm'), path.join(pkg, 'rhwp_bg.wasm'));
  writeFileSync(path.join(pkg, 'rhwp.js'), [
    `import * as real from ${JSON.stringify(real)};`,
    `export * from ${JSON.stringify(real)};`,
    'export default real.default;',
    'const sleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };',
    'real.HwpDocument.prototype.collabRoundtripCheck = function collabRoundtripCheck() {',
    "  return process.env.CC_RHWP_FAKE_ROUNDTRIP ?? '{\"ok\":true,\"lost\":[],\"irDiff\":0}';",
    '};',
    'real.HwpDocument.prototype.collabLayoutCheck = function collabLayoutCheck() {',
    '  sleep(Number(process.env.CC_RHWP_FAKE_LAYOUT_SLEEP_MS ?? 0));',
    "  if (process.env.CC_RHWP_FAKE_LAYOUT_THROW) throw new Error('배치 점검 실패(대역)');",
    "  return process.env.CC_RHWP_FAKE_LAYOUT ?? 'null';",
    '};',
  ].join('\n'));
  return pkg;
}
const LAYOUT = { kind: 'layout', count: 2, detail: '최대 3.5px(5쪽, Page/Body/Column0/TextLine2)', pages: [12, 12], maxDisp: 3.5, worstPage: 5 };
const S2_WARN = { ok: false, lost: [{ kind: 'record', count: 1, detail: 'CTRL_DATA×1' }], irDiff: 0 };

async function roundtripOf(opts, env) {
  const keys = ['CC_RHWP_FAKE_ROUNDTRIP', 'CC_RHWP_FAKE_LAYOUT', 'CC_RHWP_FAKE_LAYOUT_SLEEP_MS', 'CC_RHWP_FAKE_LAYOUT_THROW'];
  for (const k of keys) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = String(env[k]); }
  const server = startServer({ port: 0, log: () => {}, pkg: fakePkg(), ...opts });
  await server.ready;
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/rooms`, { method: 'POST', body: DOC });
    assert.equal(res.status, 201);
    const { room } = await res.json();
    await server.settle(room);
    return server.rooms.get(room).roundtrip;
  } finally {
    for (const k of keys) delete process.env[k];
    await server.close();
  }
}

test('배치 점검 on: 경고를 lost 에 더하고 쪽 수·변위·쪽 번호를 남긴다', async () => {
  const rt = await roundtripOf({ roundtripLayout: 'on' }, { CC_RHWP_FAKE_LAYOUT: JSON.stringify(LAYOUT) });
  assert.deepEqual(rt, { ok: false, lost: [LAYOUT], irDiff: 0 });
});

test('배치 점검 on: 왕복 점검 경고 + 배치 통과면 왕복 점검 결과 그대로', async () => {
  const rt = await roundtripOf({ roundtripLayout: 'on' }, { CC_RHWP_FAKE_ROUNDTRIP: JSON.stringify(S2_WARN) });
  assert.deepEqual(rt, S2_WARN);
});

test('배치 점검만 시간 상한을 넘거나 실패하면 왕복 점검 결과는 살리고 layoutUnknown 을 단다', async () => {
  const slow = await roundtripOf({ roundtripLayout: 'on', roundtripTimeoutMs: 1500 }, { CC_RHWP_FAKE_ROUNDTRIP: JSON.stringify(S2_WARN), CC_RHWP_FAKE_LAYOUT: JSON.stringify(LAYOUT), CC_RHWP_FAKE_LAYOUT_SLEEP_MS: 4000 });
  assert.deepEqual(slow, { ...S2_WARN, layoutUnknown: 'timeout' });
  const broken = await roundtripOf({ roundtripLayout: 'on' }, { CC_RHWP_FAKE_LAYOUT_THROW: '1' });
  assert.deepEqual(broken, { ok: true, lost: [], irDiff: 0, layoutUnknown: 'error' });
});

test('배치 점검 off(기본): 부르지 않는다 / 모르는 값이면 시작 거부', async () => {
  const rt = await roundtripOf({}, { CC_RHWP_FAKE_LAYOUT: JSON.stringify(LAYOUT) });
  assert.deepEqual(rt, { ok: true, lost: [], irDiff: 0 });
  assert.throws(() => startServer({ port: 0, log: () => {}, roundtripLayout: 'yes' }), /COLLAB_ROUNDTRIP_LAYOUT/);
});

test('진짜 보조: 모델에서 다 쓰는 문서는 배치 점검도 통과(점검 워커 = 정본과 같은 조판 환경)', { skip: !HAS_LAYOUT && 'collabLayoutCheck 가 아직 없다' }, async () => {
  const server = startServer({ port: 0, log: () => {}, roundtripLayout: 'on' });
  await server.ready;
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/rooms`, { method: 'POST', body: DOC });
    const { room } = await res.json();
    await server.settle(room);
    assert.deepEqual(server.rooms.get(room).roundtrip, { ok: true, lost: [], irDiff: 0 });
  } finally {
    await server.close();
  }
});
