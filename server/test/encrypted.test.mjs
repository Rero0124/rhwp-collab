// 5단계 D5 암호 문서: 기본은 막는다(POST /rooms 400 encrypted, base 의 encryptedSource 거절). COLLAB_ALLOW_ENCRYPTED 이면
// 문서 암호(X-Collab-Document-Password)로 열어 암호 없는 바이트로 방을 만들고, 방 메타·welcome 에 encryptedSource 를 남긴다.
// 암호 샘플은 업스트림 samples 에서 읽기만 한다(복사하지 않음). 실제 rhwp WASM — build-wasm.sh 가 먼저다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
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
const sample = (name) => readFileSync(new URL(`../../upstream/rhwp/samples/${name}`, import.meta.url));
const PASSWORD = '123456';
// 업스트림 암호 샘플(암호 123456) — HWP5(HWPX AES), HWP5 2024, 압축 HWP3
const ENCRYPTED_SAMPLES = ['HWP5-password-123456.hwpx', 'hwp3-sample16-hwp5-2024-password-123456.hwp', 'HWP3-password-123456.hwp'];
const PLAIN = sample('HWP5-nopassword-123456.hwp');
/** 시험 중에 만든 HWP5 암호 문서 */
function generated() {
  const d = wasm.HwpDocument.createEmpty();
  d.createBlankDocument();
  d.insertText(0, 0, 0, '시험용 암호 문서');
  const bytes = Buffer.from(d.exportHwpWithPassword('gen-pw'));
  d.free();
  return bytes;
}
const GENERATED = generated();

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'cc-rhwp-d5-')); dirs.push(d); return d; };
const auth = hs256Auth(randomBytes(32).toString('base64url'));
const now = () => Math.floor(Date.now() / 1000);
const createToken = () => auth.issue({ sub: 'admin', room: '*', scope: 'create', exp: now() + 600 });

const post = (port, body, headers = {}) => fetch(`http://127.0.0.1:${port}/rooms`, { method: 'POST', body, headers: { authorization: `Bearer ${createToken()}`, ...headers } });

function join(port, room, token, { name = 'P' } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    ws.once('error', reject);
    ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', room, clientId: `${name}-${randomBytes(3).toString('hex')}`, name, engine: ENGINE_FINGERPRINT, ...(token ? { token } : {}) })));
    ws.once('message', (d) => resolve({ ws, msg: JSON.parse(String(d)) }));
  });
}
const opensPlain = (packedB64) => { const d = new wasm.HwpDocument(gunzipSync(Buffer.from(packedB64, 'base64'))); d.free(); return true; };

test('기본: 암호 문서로 방 만들기는 400 encrypted(일반 오류 422 와 구분), 암호 없는 문서는 그대로', async () => {
  const server = startServer({ port: 0, log: () => {}, auth });
  await server.ready;
  try {
    for (const name of ENCRYPTED_SAMPLES) {
      const res = await post(server.port, sample(name));
      assert.equal(res.status, 400, name);
      const body = await res.json();
      assert.equal(body.reason, 'encrypted', name);
      assert.equal(body.allowed, false, name);
    }
    let res = await post(server.port, GENERATED);
    assert.equal(res.status, 400, '시험 중에 만든 암호 문서');
    assert.equal((await res.json()).reason, 'encrypted');
    // 문서 암호를 실어 보내도 허용하지 않는 서버는 받지 않는다
    res = await post(server.port, GENERATED, { 'x-collab-document-password': 'gen-pw' });
    assert.equal(res.status, 400);
    res = await post(server.port, PLAIN);
    assert.equal(res.status, 201, '암호 없는 문서');
    // 깨진 문서(CFB 머리만)는 암호 문서가 아니라 일반 오류
    res = await post(server.port, PLAIN.subarray(0, 1024));
    assert.equal(res.status, 422);
  } finally {
    await server.close();
  }
});

test('허용(COLLAB_ALLOW_ENCRYPTED): 시작 경고, 암호 없으면·틀리면 400, 맞으면 암호 없는 바이트로 방 — welcome·저장소·재시작 뒤에도 encryptedSource', async () => {
  const lines = [];
  const store = new LocalDocStore(tempDir());
  let server = startServer({ port: 0, log: (m) => lines.push(m), auth, store, allowEncrypted: true });
  await server.ready;
  const made = [];
  try {
    assert.ok(lines.some((l) => l.includes('경고: COLLAB_ALLOW_ENCRYPTED')), '시작 로그 경고');
    let res = await post(server.port, GENERATED);
    assert.equal(res.status, 400);
    assert.deepEqual([(await res.clone().json()).reason, (await res.json()).allowed], ['encrypted', true]);
    res = await post(server.port, GENERATED, { 'x-collab-document-password': 'nope' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, 'wrong-password');
    assert.ok(!lines.some((l) => l.includes('nope')), '암호는 로그에 남지 않음');

    for (const [name, bytes, pw] of [['generated', GENERATED, 'gen-pw'], ...ENCRYPTED_SAMPLES.map((n) => [n, sample(n), PASSWORD])]) {
      res = await post(server.port, bytes, { 'x-collab-document-password': pw });
      assert.equal(res.status, 201, `${name}: ${await res.clone().text()}`);
      made.push([name, await res.json()]);
    }
    for (const [name, { room, invite }] of made) {
      const { ws, msg } = await join(server.port, room, invite.edit);
      assert.equal(msg.type, 'welcome', name);
      assert.equal(msg.encryptedSource, true, `${name}: welcome 에 encryptedSource`);
      assert.ok(opensPlain(msg.base), `${name}: base 는 암호 없이 열린다`);
      ws.close();
      const dl = await fetch(`http://127.0.0.1:${server.port}/rooms/${room}/document`, { headers: { authorization: `Bearer ${invite.view}` } });
      assert.equal(dl.status, 200);
      const file = Buffer.from(await dl.arrayBuffer());
      const reopened = new wasm.HwpDocument(file); // 내려받은 파일도 암호 없음(다음 후보: 다시 암호 걸기)
      reopened.free();
      assert.equal((await store.load(room)).meta.encryptedSource, true, `${name}: 방 메타`);
    }
    // 암호 없는 방에는 encryptedSource 가 없다
    res = await post(server.port, PLAIN);
    const plain = await res.json();
    const p = await join(server.port, plain.room, plain.invite.edit);
    assert.equal(p.msg.encryptedSource, undefined);
    p.ws.close();
  } finally {
    await server.close();
  }
  // 재시작 뒤 저장소에서 복원해도 그대로
  server = startServer({ port: 0, log: () => {}, auth, store, allowEncrypted: true });
  await server.ready;
  try {
    const [, first] = made[0];
    const again = await join(server.port, first.room, first.invite.edit);
    assert.equal(again.msg.encryptedSource, true, '복원한 방');
    again.ws.close();
    await server.changeGeneration(first.room);
    assert.equal((await store.load(first.room)).meta.encryptedSource, true, '세대 전환 뒤에도');
  } finally {
    await server.close();
  }
});

test('첫 참여자의 base: encryptedSource 를 실으면 기본 서버는 거절(invalid encrypted), 허용 서버는 받아 다음 참여자에게 알린다', async () => {
  const d = new wasm.HwpDocument(PLAIN);
  const base = Buffer.from(d.collabExportState()).toString('base64');
  d.free();
  for (const allowEncrypted of [false, true]) {
    const server = startServer({ port: 0, log: () => {}, allowEncrypted });
    await server.ready;
    try {
      const room = `enc-${allowEncrypted}`;
      const owner = await join(server.port, room, null, { name: 'O' });
      assert.equal(owner.msg.base, null);
      assert.equal(owner.msg.allowEncrypted, allowEncrypted ? true : undefined, 'base 담당에게 허용 여부');
      const reply = new Promise((resolve) => owner.ws.once('message', (m) => resolve(JSON.parse(String(m)))));
      const closed = new Promise((resolve) => owner.ws.once('close', resolve));
      owner.ws.send(JSON.stringify({ type: 'base', data: base, encryptedSource: true }));
      if (!allowEncrypted) {
        assert.deepEqual(await reply, { type: 'invalid', what: 'base', reason: 'encrypted' });
        await closed;
        assert.equal(server.rooms.get(room).base, null);
        continue;
      }
      await server.settle(room);
      const late = await join(server.port, room, null, { name: 'L' });
      assert.equal(late.msg.encryptedSource, true);
      assert.equal(late.msg.allowEncrypted, undefined, 'base 가 있으면 허용 여부는 싣지 않음');
      owner.ws.close(); late.ws.close();
    } finally {
      await server.close();
    }
  }
});
