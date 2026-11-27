// 5단계 D2 서버 검증: 한 출처로 편집기(정적 파일)·업로드 페이지·WebSocket 을 함께 내주기, 경로 탈출 막기, MIME·캐시,
// TLS(자체 서명 인증서 — openssl 이 없으면 건너뛴다).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { startServer } from '../server.mjs';
import { resolveStatic } from '../http.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'cc-rhwp-d2-')); dirs.push(d); return d; };

/** 빌드한 studio 를 흉내 낸 정적 디렉터리 + 그 밖의 비밀 파일 */
function fakeStudio() {
  const root = tempDir();
  const site = path.join(root, 'site');
  mkdirSync(path.join(site, 'assets'), { recursive: true });
  writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>studio</title>');
  writeFileSync(path.join(site, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(path.join(site, 'assets', 'rhwp_bg-abc123.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
  writeFileSync(path.join(root, 'secret.txt'), 'nope');
  symlinkSync(path.join(root, 'secret.txt'), path.join(site, 'link.txt'));
  return { root, site };
}

test('정적 파일: index.html·assets 캐시·wasm MIME·ETag, 경로 탈출과 밖을 가리키는 링크는 404, 업로드 페이지', async () => {
  const { site } = fakeStudio();
  const server = startServer({ port: 0, log: () => {}, canonical: false, staticDir: site });
  await server.ready;
  const base = `http://127.0.0.1:${server.port}`;
  try {
    let res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.match(await res.text(), /studio/);
    // 편집기 주소에 붙는 조각·쿼리는 그대로 index.html
    res = await fetch(`${base}/?collab`);
    assert.equal(res.status, 200);

    res = await fetch(`${base}/assets/rhwp_bg-abc123.wasm`);
    assert.equal(res.headers.get('content-type'), 'application/wasm');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const etag = res.headers.get('etag');
    res = await fetch(`${base}/assets/rhwp_bg-abc123.wasm`, { headers: { 'if-none-match': etag } });
    assert.equal(res.status, 304);
    res = await fetch(`${base}/assets/index-abc123.js`, { method: 'HEAD' });
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');

    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/link.txt', '/%00', '/nothing.js']) {
      res = await fetch(`${base}${p}`);
      assert.equal(res.status, 404, p);
    }
    // fetch 는 경로를 정규화하므로 날것의 요청으로도 본다
    for (const p of ['/../secret.txt', '/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '//etc/passwd']) {
      const status = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.port, path: p }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
      });
      assert.equal(status, 404, `날것 ${p}`);
    }
    assert.equal(await resolveStatic(site, '/../secret.txt'), null);
    assert.equal(await resolveStatic(site, '/%E0%A4%A'), null, '깨진 퍼센트 인코딩');

    res = await fetch(`${base}/upload`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /공동편집 방 만들기/);
    res = await fetch(`${base}/healthz`);
    assert.deepEqual(await res.json(), { ok: true, auth: 'none', encryptedAllowed: false });
    res = await fetch(`${base}/`, { method: 'DELETE' });
    assert.equal(res.status, 405);

    // 같은 포트에서 WebSocket
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    await new Promise((r) => ws.once('open', r));
    ws.close();
  } finally {
    await server.close();
  }
});

test('정적 디렉터리가 없으면 업로드 페이지와 API 만 — 그 밖은 404', async () => {
  const server = startServer({ port: 0, log: () => {}, canonical: false });
  await server.ready;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/upload`)).status, 200);
  } finally {
    await server.close();
  }
});

let openssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { openssl = false; }

test('TLS: COLLAB_TLS_CERT·KEY 를 주면 HTTPS/wss 로 뜬다', { skip: !openssl && 'openssl 없음' }, async () => {
  const dir = tempDir();
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const server = startServer({ port: 0, log: () => {}, canonical: false, tls: { cert: readFileSync(cert), key: readFileSync(key) } });
  await server.ready;
  try {
    assert.equal(server.secure, true);
    const ca = readFileSync(cert);
    const body = await new Promise((resolve, reject) => {
      https.get({ host: '127.0.0.1', port: server.port, path: '/healthz', ca }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    assert.deepEqual(JSON.parse(body).ok, true);
    const ws = new WebSocket(`wss://127.0.0.1:${server.port}/`, { ca });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const msg = new Promise((r) => ws.once('message', (d) => r(JSON.parse(d.toString()))));
    ws.send(JSON.stringify({ type: 'hello', room: 'tls', clientId: 'T', name: 'T', engine: 'E' }));
    assert.equal((await msg).type, 'welcome');
    ws.close();
    // 평문 http 로는 붙지 않는다
    await assert.rejects(fetch(`http://127.0.0.1:${server.port}/healthz`));
  } finally {
    await server.close();
  }
  // 인증서·키는 함께 — 하나만 주면 시작을 거부한다
  process.env.COLLAB_TLS_CERT = cert;
  try {
    assert.throws(() => startServer({ port: 0, log: () => {}, canonical: false }), /함께/);
  } finally {
    delete process.env.COLLAB_TLS_CERT;
  }
});

test('/healthz: 확인 방식과 암호 문서 허용 여부(비밀이 아닌 설정 요약)', async () => {
  const { hs256Auth } = await import('../auth.mjs');
  const server = startServer({ port: 0, log: () => {}, canonical: false, auth: hs256Auth('k'.repeat(40)), allowEncrypted: true });
  await server.ready;
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assert.deepEqual(await res.json(), { ok: true, auth: 'hs256', encryptedAllowed: true });
  } finally {
    await server.close();
  }
});

test('부품 전용 모드(6단계 S3): 편집기 HTML 에 frame-ancestors, 최상위 탐색은 403 안내, iframe 은 통과, 업로드 페이지 끔, healthz 에 embedOnly', async () => {
  const { site } = fakeStudio();
  const origins = ['https://host.example', 'http://127.0.0.1:7710'];
  const server = startServer({ port: 0, log: () => {}, canonical: false, staticDir: site, embedOnly: true, embedOrigins: origins });
  await server.ready;
  const base = `http://127.0.0.1:${server.port}`;
  try {
    let res = await fetch(`${base}/`, { headers: { 'sec-fetch-dest': 'document' } });
    assert.equal(res.status, 403, '최상위로 열면');
    assert.match(await res.text(), /연결된 시스템 안에서만 열 수 있습니다/);
    res = await fetch(`${base}/?collab`, { headers: { 'sec-fetch-dest': 'iframe' } });
    assert.equal(res.status, 200, 'iframe 안');
    assert.equal(res.headers.get('content-security-policy'), `frame-ancestors ${origins.join(' ')}`);
    res = await fetch(`${base}/`); // Sec-Fetch 를 보내지 않는 브라우저 — frame-ancestors 와 플러그인이 막는다
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-security-policy'));
    res = await fetch(`${base}/assets/index-abc123.js`, { headers: { 'sec-fetch-dest': 'script' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-security-policy'), null, 'HTML 이 아닌 파일에는 싣지 않음');
    assert.equal((await fetch(`${base}/upload`)).status, 404, '업로드 페이지 끔');
    assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true, auth: 'none', encryptedAllowed: false, embedOnly: true, embedOrigins: origins });
  } finally {
    await server.close();
  }
  // 부품 전용이 아니면 아무것도 붙이지 않는다
  const plain = startServer({ port: 0, log: () => {}, canonical: false, staticDir: site });
  await plain.ready;
  try {
    const res = await fetch(`http://127.0.0.1:${plain.port}/`, { headers: { 'sec-fetch-dest': 'document' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-security-policy'), null);
  } finally {
    await plain.close();
  }
  assert.throws(() => startServer({ port: 0, log: () => {}, canonical: false, embedOnly: true }), /COLLAB_EMBED_ORIGINS/);
  assert.throws(() => startServer({ port: 0, log: () => {}, canonical: false, embedOnly: true, embedOrigins: ['https://host.example/path'] }), /출처/);
});
