// 7단계 C 내려받을 때 암호 다시 걸기: GET /rooms/{room}/document 가 X-Collab-Document-Password 를 받으면 정본을 원본 형식
// 계열로 암호를 걸어 내보낸다(exportHwpWithPassword·exportHwpxWithPassword). 원래 암호 문서였던 방(encryptedSource)은
// COLLAB_ENCRYPTED_DOWNLOAD=require(기본)면 암호 없이 내려받기를 403 password-required 로 거절한다. 암호는 저장하지도
// 기록하지도 않는다. 암호 샘플은 업스트림 samples 에서 읽기만 한다. 실제 rhwp WASM — build-wasm.sh 가 먼저다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { startServer } from '../server.mjs';
import { DEFAULT_PKG } from '../canonical.mjs';
import { LocalDocStore } from '../doc-store.mjs';
import { hs256Auth } from '../auth.mjs';

const wasm = await import(pathToFileURL(`${DEFAULT_PKG}/rhwp.js`).href);
wasm.initSync({ module: readFileSync(`${DEFAULT_PKG}/rhwp_bg.wasm`) });
const sample = (name) => readFileSync(new URL(`../../upstream/rhwp/samples/${name}`, import.meta.url));
/** 업스트림 암호 샘플(HWPX, 암호 123456) — 읽기만 */
const ENCRYPTED_HWPX = sample('HWP5-password-123456.hwpx');
const SOURCE_PASSWORD = '123456';
/** 내려받을 때 걸 새 암호 — 기록·메타에 남지 않는지 찾을 수 있게 남다른 값(ASCII — 인코딩 머리 없이 날 값으로 보낸다) */
const NEW_PASSWORD = `c7-rewrap-${randomBytes(6).toString('hex')}`;
const PLAIN_HWP = (() => { const d = wasm.HwpDocument.createEmpty(); d.createBlankDocument(); d.insertText(0, 0, 0, '암호 다시 걸기 시험'); const raw = gunzipSync(Buffer.from(d.collabExportState())); d.free(); return raw; })();

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'cc-rhwp-c7-')); dirs.push(d); return d; };
const auth = hs256Auth(randomBytes(32).toString('base64url'));
const now = () => Math.floor(Date.now() / 1000);
const createToken = () => auth.issue({ sub: 'admin', room: '*', scope: 'create', exp: now() + 600 });

async function withServer(opts, fn) {
  const logs = [];
  const server = startServer({ port: 0, log: (m) => logs.push(String(m)), auth, allowEncrypted: true, ...opts });
  await server.ready;
  try { return await fn(server, logs); } finally { await server.close(); }
}
const create = (server, body, headers = {}) => fetch(`http://127.0.0.1:${server.port}/rooms`, { method: 'POST', body, headers: { authorization: `Bearer ${createToken()}`, ...headers } });
/** 한글 등은 HTTP 머리에 그대로 실을 수 없어 UTF-8 퍼센트 인코딩 + `X-Collab-Document-Password-Encoding: uri` 로 보낸다(규약 §5) */
const encodedPassword = (password) => ({ 'x-collab-document-password': encodeURIComponent(password), 'x-collab-document-password-encoding': 'uri' });
const download = (server, room, token, password, { encode = false, headers = {} } = {}) => fetch(`http://127.0.0.1:${server.port}/rooms/${encodeURIComponent(room)}/document`, {
  headers: {
    authorization: `Bearer ${token}`,
    ...(password !== undefined ? (encode ? encodedPassword(password) : { 'x-collab-document-password': password }) : {}),
    ...headers,
  },
});
const KOREAN_PASSWORD = '비밀번호123';
/** 시험 중에 만든 암호 문서(rhwp 가 건 한글 암호) — 한컴이 한글 암호를 바이트로 바꾸는 방식과 같은지는 확인할 수 없다(규약 §5 한계) */
function encryptedWith(password, format) {
  const d = wasm.HwpDocument.createEmpty();
  d.createBlankDocument();
  d.insertText(0, 0, 0, `${format} 한글 암호 문서`);
  const bytes = Buffer.from(format === 'hwpx' ? d.exportHwpxWithPassword(password) : d.exportHwpWithPassword(password));
  d.free();
  return bytes;
}

/** 바이트를 (암호로) 연 문서의 digest. 열지 못하면 던진다. */
function digestOf(bytes, password) {
  const d = password === undefined ? new wasm.HwpDocument(bytes) : wasm.HwpDocument.openWithPassword(bytes, password);
  try { return d.collabDigest(); } finally { d.free(); }
}
/** 정본을 그대로 내보내 다시 연 digest — "내보내기 후 다시 읽기" 기준(정본 메모리의 digest 와 다를 수 있는 것을 맞춘다) */
async function exportedDigest(server, room) {
  const ex = await server.rooms.get(room).canonical.export();
  assert.equal(ex.ok, true);
  return digestOf(gunzipSync(Buffer.from(ex.data, 'base64')));
}
/** 디렉터리 아래 모든 파일에서 문자열을 찾는다 */
function filesContaining(dir, needle) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (readFileSync(p).includes(Buffer.from(needle))) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

test('원래 암호 문서(HWPX)였던 방: 암호 없이는 403 password-required, 암호를 주면 HWPX 로 암호를 걸어 내려받음 — 그 암호로 열면 정본과 같고 틀린 암호로는 안 열림', async () => {
  const dataDir = tempDir();
  const store = new LocalDocStore(dataDir);
  let room;
  let invite;
  await withServer({ store }, async (server, logs) => {
    const res = await create(server, ENCRYPTED_HWPX, { 'x-collab-document-password': SOURCE_PASSWORD });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.encryptedSource, true, '응답이 원래 암호 문서였다고 알림(업로드 페이지가 암호 칸을 보인다)');
    ({ room, invite } = body);

    const refused = await download(server, room, invite.edit);
    assert.equal(refused.status, 403);
    assert.deepEqual([(await refused.json()).error], ['password-required']);

    const ok = await download(server, room, invite.view, NEW_PASSWORD);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('x-collab-encrypted'), '1');
    assert.match(ok.headers.get('content-disposition'), /document\.hwpx/, '원본 형식 계열(HWPX)');
    const bytes = Buffer.from(await ok.arrayBuffer());
    assert.equal(bytes[0] === 0x50 && bytes[1] === 0x4b, true, 'zip(HWPX) 컨테이너');
    assert.throws(() => digestOf(bytes), '암호 없이는 열리지 않음');
    assert.throws(() => digestOf(bytes, 'wrong-password'), '틀린 암호로는 열리지 않음');
    assert.throws(() => digestOf(bytes, SOURCE_PASSWORD), '원래 암호가 아니라 새 암호가 걸림');
    const reopened = digestOf(bytes, NEW_PASSWORD);
    assert.equal(reopened, await exportedDigest(server, room), '그 암호로 열면 정본(내보내 다시 연 것)과 같음');
    const canon = await server.rooms.get(room).canonical.digest();
    assert.equal(reopened, canon.digest, '이 문서는 정본 메모리의 digest 와도 같다');

    await server.saveDoc(room);
    assert.equal(logs.some((l) => l.includes(NEW_PASSWORD) || l.includes(SOURCE_PASSWORD)), false, '기록(로그)에 암호 없음');
    assert.ok(logs.some((l) => /문서 내려받기 .*암호를 걸어/.test(l)), '로그에는 암호를 걸었다는 사실만');
  });
  assert.deepEqual(filesContaining(dataDir, NEW_PASSWORD), [], '저장소(메타·기록·저장본)에 새 암호 없음');
  assert.deepEqual(filesContaining(dataDir, `"${SOURCE_PASSWORD}"`), [], '저장소에 원래 암호 없음');
  assert.equal((await store.load(room)).meta.encryptedSource, true);
  // 다시 시작해도(저장소에서 복원한 방) 같은 규칙
  await withServer({ store }, async (server) => {
    assert.equal((await download(server, room, invite.edit)).status, 403, '복원한 방도 암호 없이는 거절');
    assert.equal((await download(server, room, invite.edit, NEW_PASSWORD)).status, 200);
  });
});

test('COLLAB_ENCRYPTED_DOWNLOAD=optional: 원래 암호 문서였던 방도 암호 없이 내려받을 수 있다(암호 없는 파일)', async () => {
  await withServer({ encryptedDownload: 'optional' }, async (server) => {
    const { room, invite } = await (await create(server, ENCRYPTED_HWPX, { 'x-collab-document-password': SOURCE_PASSWORD })).json();
    const res = await download(server, room, invite.edit);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-collab-encrypted'), null);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(digestOf(bytes), await exportedDigest(server, room), '암호 없이 열림');
  });
});

test('암호 문서가 아니었던 방(HWP): 암호를 주면 HWP 로 암호를 걸어 내려받고, 안 주면 지금처럼 암호 없음', async () => {
  await withServer({}, async (server, logs) => {
    const body = await (await create(server, PLAIN_HWP)).json();
    assert.equal(body.encryptedSource, undefined);
    const { room, invite } = body;
    const plain = await download(server, room, invite.edit);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get('x-collab-encrypted'), null);
    const want = await exportedDigest(server, room);
    assert.equal(digestOf(Buffer.from(await plain.arrayBuffer())), want);
    const enc = await download(server, room, invite.edit, NEW_PASSWORD);
    assert.equal(enc.status, 200);
    assert.equal(enc.headers.get('x-collab-encrypted'), '1');
    assert.match(enc.headers.get('content-disposition'), /document\.hwp"/, '원본 형식 계열(HWP)');
    const bytes = Buffer.from(await enc.arrayBuffer());
    assert.throws(() => digestOf(bytes), '암호 없이는 열리지 않음');
    assert.throws(() => digestOf(bytes, 'wrong-password'), '틀린 암호로는 열리지 않음');
    assert.equal(digestOf(bytes, NEW_PASSWORD), want, '그 암호로 열면 정본과 같음');
    assert.equal(logs.some((l) => l.includes(NEW_PASSWORD)), false, '로그에 암호 없음');
  });
});

test('문서 암호가 너무 길면 400 bad-password, 빈 머리는 없는 것으로, 모르는 COLLAB_ENCRYPTED_DOWNLOAD 는 시작 거부', async () => {
  await withServer({}, async (server) => {
    const { room, invite } = await (await create(server, PLAIN_HWP)).json();
    const long = await download(server, room, invite.edit, 'x'.repeat(257));
    assert.equal(long.status, 400);
    assert.equal((await long.json()).error, 'bad-password');
    const empty = await download(server, room, invite.edit, '');
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('x-collab-encrypted'), null, '빈 암호는 걸지 않음');
  });
  assert.throws(() => startServer({ port: 0, log: () => {}, encryptedDownload: 'always' }), /COLLAB_ENCRYPTED_DOWNLOAD/);
});

test('한글 암호: 인코딩 머리(uri)로 보내면 한글 암호를 걸어 내려받고 그 암호로 열린다(HWP·HWPX), 기록·저장소에 암호 없음', async () => {
  const dataDir = tempDir();
  await withServer({ store: new LocalDocStore(dataDir) }, async (server, logs) => {
    for (const [label, body, headers] of [['HWP', PLAIN_HWP, {}], ['HWPX(원래 암호 문서)', ENCRYPTED_HWPX, { 'x-collab-document-password': SOURCE_PASSWORD }]]) {
      const { room, invite } = await (await create(server, body, headers)).json();
      const res = await download(server, room, invite.edit, KOREAN_PASSWORD, { encode: true });
      assert.equal(res.status, 200, label);
      assert.equal(res.headers.get('x-collab-encrypted'), '1');
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.throws(() => digestOf(bytes, '비밀번호124'), `${label}: 틀린 한글 암호로는 안 열림`);
      assert.throws(() => digestOf(bytes, encodeURIComponent(KOREAN_PASSWORD)), `${label}: 인코딩된 문자열이 아니라 푼 암호가 걸림`);
      assert.equal(digestOf(bytes, KOREAN_PASSWORD), await exportedDigest(server, room), `${label}: 그 한글 암호로 열면 정본과 같음`);
    }
    for (const needle of [KOREAN_PASSWORD, encodeURIComponent(KOREAN_PASSWORD)]) {
      assert.equal(logs.some((l) => l.includes(needle)), false, `로그에 암호 없음(${needle === KOREAN_PASSWORD ? '날 값' : '인코딩한 값'})`);
    }
  });
  for (const needle of [KOREAN_PASSWORD, encodeURIComponent(KOREAN_PASSWORD)]) assert.deepEqual(filesContaining(dataDir, needle), []);
});

test('한글 암호 문서로 방 만들기: 인코딩 머리로 암호를 주면 열어 방을 만들고(HWP·HWPX), 틀린 한글 암호는 400 wrong-password', async () => {
  await withServer({}, async (server) => {
    for (const format of ['hwp', 'hwpx']) {
      const doc = encryptedWith(KOREAN_PASSWORD, format);
      const wrong = await create(server, doc, encodedPassword('비밀번호124'));
      assert.equal(wrong.status, 400, format);
      assert.equal((await wrong.json()).reason, 'wrong-password');
      const res = await create(server, doc, encodedPassword(KOREAN_PASSWORD));
      assert.equal(res.status, 201, `${format}: 한글 암호로 열어 방을 만듦`);
      const body = await res.json();
      assert.equal(body.encryptedSource, true);
      // 그 방을 같은 한글 암호로 다시 걸어 내려받으면 열린다(rhwp 의 자기 암호 저장본 왕복)
      const dl = await download(server, body.room, body.invite.view, KOREAN_PASSWORD, { encode: true });
      assert.equal(dl.status, 200);
      assert.match(dl.headers.get('content-disposition'), new RegExp(`document\\.${format}"`));
      assert.equal(digestOf(Buffer.from(await dl.arrayBuffer()), KOREAN_PASSWORD), await exportedDigest(server, body.room));
    }
  });
});

test('인코딩 머리가 없으면 날 값 그대로: "%" 가 든 ASCII 암호도 지금처럼 / 잘못된 인코딩·모르는 인코딩은 400 / 글자 수 상한은 푼 뒤로', async () => {
  await withServer({}, async (server) => {
    const { room, invite } = await (await create(server, PLAIN_HWP)).json();
    const percent = 'p%41ss%zz';
    const raw = await download(server, room, invite.edit, percent);
    assert.equal(raw.status, 200);
    const bytes = Buffer.from(await raw.arrayBuffer());
    assert.equal(digestOf(bytes, percent), await exportedDigest(server, room), '"%" 를 풀지 않은 날 값이 걸림');
    assert.throws(() => digestOf(bytes, 'pAss%zz'), '퍼센트를 풀어 걸지 않음');
    const bad = await download(server, room, invite.edit, undefined, { headers: { 'x-collab-document-password': '%E0%A4%A', 'x-collab-document-password-encoding': 'uri' } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'bad-password', '잘못된 퍼센트 인코딩');
    const unknown = await download(server, room, invite.edit, 'abc', { headers: { 'x-collab-document-password-encoding': 'base64' } });
    assert.equal(unknown.status, 400, '모르는 인코딩 이름');
    assert.equal((await download(server, room, invite.edit, '가'.repeat(256), { encode: true })).status, 200, '푼 뒤 256자(인코딩하면 2304자)는 됨');
    assert.equal((await download(server, room, invite.edit, '가'.repeat(257), { encode: true })).status, 400, '푼 뒤 257자는 400');
    // 방 만들기 쪽도 같은 규칙(잘못된 인코딩은 400 bad-password)
    const made = await create(server, encryptedWith('x', 'hwp'), { 'x-collab-document-password': '%E0%A4%A', 'x-collab-document-password-encoding': 'uri' });
    assert.equal(made.status, 400);
    assert.equal((await made.json()).reason, 'bad-password');
  });
});
