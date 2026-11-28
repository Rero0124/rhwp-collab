// 6단계 사용성: 정본 워커가 문서를 여는 데 시간 제한(COLLAB_CANONICAL_TIMEOUT_MS)을 넘기면 POST /rooms 는 사람이 알아들을
// 까닭(422 {error: 'too-slow'})으로 답한다 — 전에는 "문서를 열지 못했다: 정본 워커 시간 초과(load)". 시간 제한 값은 그대로다.
// 여는 데 오래 걸리는 문서는 대역(진짜 rhwp 의 HwpDocument 를 감싸 만들 때 잠근다)으로 흉내 낸다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { startServer } from '../server.mjs';
import { DEFAULT_PKG } from '../canonical.mjs';
import { hs256Auth } from '../auth.mjs';

const wasm = await import(pathToFileURL(`${DEFAULT_PKG}/rhwp.js`).href);
wasm.initSync({ module: readFileSync(`${DEFAULT_PKG}/rhwp_bg.wasm`) });
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const auth = hs256Auth(randomBytes(32).toString('base64url'));
const now = () => Math.floor(Date.now() / 1000);
const DOC = (() => { const d = wasm.HwpDocument.createEmpty(); d.createBlankDocument(); d.insertText(0, 0, 0, '느린 문서'); const raw = gunzipSync(Buffer.from(d.collabExportState())); d.free(); return raw; })();

/** 진짜 rhwp 의 HwpDocument 를 감싸, 만들 때 CC_RHWP_FAKE_OPEN_SLEEP_MS 동안 그 워커 스레드를 잠그는 pkg */
function slowPkg() {
  const pkg = mkdtempSync(path.join(tmpdir(), 'cc-rhwp-slow-'));
  dirs.push(pkg);
  const real = pathToFileURL(path.join(DEFAULT_PKG, 'rhwp.js')).href;
  symlinkSync(path.join(DEFAULT_PKG, 'rhwp_bg.wasm'), path.join(pkg, 'rhwp_bg.wasm'));
  writeFileSync(path.join(pkg, 'rhwp.js'), [
    `import * as real from ${JSON.stringify(real)};`,
    `export * from ${JSON.stringify(real)};`,
    'export default real.default;',
    'export class HwpDocument extends real.HwpDocument {',
    '  constructor(...args) {',
    '    const ms = Number(process.env.CC_RHWP_FAKE_OPEN_SLEEP_MS ?? 0);',
    '    if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
    '    super(...args);',
    '  }',
    '}',
  ].join('\n'));
  return pkg;
}

test('여는 데 정본 워커 시간 제한을 넘기면 422 too-slow(사람이 알아들을 까닭), 방은 생기지 않는다 / 제때 열리면 그대로 만든다', async () => {
  const pkg = slowPkg();
  const server = startServer({ port: 0, log: () => {}, auth, pkg, canonicalTimeoutMs: 400, roundtripMode: 'off' });
  await server.ready;
  const create = () => fetch(`http://127.0.0.1:${server.port}/rooms`, { method: 'POST', body: DOC, headers: { authorization: `Bearer ${auth.issue({ sub: 'a', room: '*', scope: 'create', exp: now() + 600 })}` } });
  try {
    process.env.CC_RHWP_FAKE_OPEN_SLEEP_MS = '1500';
    const res = await create();
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.deepEqual([body.error, body.reason], ['too-slow', 'too-slow']);
    assert.match(body.message, /오래 걸|넘겼다/);
    assert.equal(server.rooms.size, 0);
    delete process.env.CC_RHWP_FAKE_OPEN_SLEEP_MS;
    assert.equal((await create()).status, 201, '제때 열리면 만든다');
  } finally {
    delete process.env.CC_RHWP_FAKE_OPEN_SLEEP_MS;
    await server.close();
  }
});
