// 6단계 S3 부품 전용 모드 브라우저 시험: 편집기 서버(COLLAB_EMBED_ONLY, 허용 출처 = 부모 페이지 서버)와 다른 출처의 부모 페이지
// 서버를 띄운다. 부모는 studio 의 embed 통로(rhwp-connect 로 묶은 MessagePort)로 plugin.invoke('collab','setToken') 을 불러 토큰을
// 넣고, 플러그인은 토큰이 필요할 때 부모에게 비밀 없는 알림(rhwp-collab-token-request)만 보낸다.
//
// 준비: scripts/build-wasm.sh, scripts/build-studio.sh (target/studio)
// 실행: node collab-client/e2e/s6-embed.mjs        환경 변수: PORT(편집기, 기본 8797), PARENT_PORT(부모, 기본 7710), CHROME_PATH, HEADFUL=1
// 허용 출처는 http://127.0.0.1:<PARENT_PORT>. 같은 부모 서버를 http://localhost:<PARENT_PORT> 로 열면 허용되지 않은 출처다.
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const puppeteer = createRequire(path.join(root, 'upstream/rhwp/rhwp-studio/package.json'))('puppeteer-core');
const { startServer } = await import(path.join(root, 'server/server.mjs'));
const { hs256Auth } = await import(path.join(root, 'server/auth.mjs'));
const PORT = Number(process.env.PORT ?? 8797);
const PARENT_PORT = Number(process.env.PARENT_PORT ?? 7710);
const EDITOR = `http://127.0.0.1:${PORT}`;
const PARENT = `http://127.0.0.1:${PARENT_PORT}`;
const STRANGER = `http://localhost:${PARENT_PORT}`;
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(path.join(root, 'target/studio/index.html'))) throw new Error('target/studio 가 없습니다 — scripts/build-studio.sh');

const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

// ── 편집기 서버(부품 전용) ──
const auth = hs256Auth(randomBytes(32).toString('base64url'));
const serverLog = [];
const server = startServer({ port: PORT, host: '127.0.0.1', log: (m) => serverLog.push(m), auth, staticDir: path.join(root, 'target/studio'), embedOnly: true, embedOrigins: [PARENT], delayMs: 0 });
await server.ready;
const wasm = await import(pathToFileURL(path.join(root, 'upstream/rhwp/pkg/rhwp.js')).href);
wasm.initSync({ module: readFileSync(path.join(root, 'upstream/rhwp/pkg/rhwp_bg.wasm')) });
const blank = wasm.HwpDocument.createEmpty();
blank.createBlankDocument();
blank.insertText(0, 0, 0, '부품 전용 모드 시험');
const DOC = gunzipSync(Buffer.from(blank.collabExportState()));
blank.free();
const made = await (await fetch(`${EDITOR}/rooms`, { method: 'POST', body: DOC, headers: { authorization: `Bearer ${auth.issue({ sub: 'host', room: '*', scope: 'create', exp: now() + 600 })}` } })).json();
const ROOM = made.room;

// ── 부모 페이지 서버(바깥 시스템 흉내) ──
// /token: 바깥 시스템이 자기 사용자에게 토큰을 만들어 주는 자리. short=1 이면 첫 토큰만 몇 초 짜리(만료 시험).
const PARENT_HTML = `<!doctype html><meta charset="utf-8"><title>부모</title><body style="margin:0">
<script>
const qs = new URLSearchParams(location.search);
const EDITOR = ${JSON.stringify(EDITOR)};
const room = qs.get('room'), name = qs.get('name'), mode = qs.get('mode') || 'ok';
const state = window.__parent = { requests: [], invokeResults: [], connected: false };
const frame = document.createElement('iframe');
const extra = qs.get('wait') ? '&collabTokenWaitMs=' + qs.get('wait') : '';
const hashToken = qs.get('hashToken') ? '&token=' + encodeURIComponent(qs.get('hashToken')) : '';
frame.src = EDITOR + '/?chrome=embed&collab' + extra + '#room=' + encodeURIComponent(room) + '&name=' + encodeURIComponent(name) + hashToken;
frame.style.cssText = 'width:1200px;height:820px;border:0';
document.body.append(frame);
const channel = new MessageChannel();
const sessionId = 'parent-' + Math.random().toString(36).slice(2);
let nextId = 1;
const pending = new Map();
channel.port1.onmessage = ({ data }) => {
  if (data?.type === 'rhwp-connected') state.connected = true;
  if (data?.type === 'rhwp-response') { const p = pending.get(data.id); pending.delete(data.id); p?.(data); }
};
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  channel.port1.postMessage({ type: 'rhwp-request', version: 1, sessionId, id, method, params });
});
state.request = request;
frame.addEventListener('load', () => {
  frame.contentWindow.postMessage({ type: 'rhwp-connect', version: 1, sessionId, capabilities: ['transferable-array-buffer', 'plugin-loader-v1'] }, EDITOR, [channel.port2]);
}, { once: true });
window.addEventListener('message', async (e) => {
  if (e.origin !== EDITOR || e.source !== frame.contentWindow || e.data?.type !== 'rhwp-collab-token-request') return;
  state.requests.push(e.data);
  if (mode === 'silent') return;
  const res = await fetch('/token?room=' + encodeURIComponent(room) + '&name=' + encodeURIComponent(name) + '&n=' + state.requests.length + (qs.get('short') ? '&short=1' : ''));
  const { token } = await res.json();
  state.invokeResults.push(await request('plugin.invoke', { id: 'collab', method: 'setToken', args: [token] }));
});
</script></body>`;
const parentServer = http.createServer((req, res) => {
  const u = new URL(req.url, PARENT);
  if (u.pathname === '/parent.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PARENT_HTML); }
  if (u.pathname === '/token') {
    const short = u.searchParams.get('short') === '1' && u.searchParams.get('n') === '1';
    // 시계 오차 허용(30초) 때문에 exp = 지금 - 25 → 약 5초 동안만 유효
    const token = auth.issue({ sub: `host-user-${u.searchParams.get('name')}`, name: u.searchParams.get('name'), room: u.searchParams.get('room'), exp: short ? now() - 25 : now() + 600 });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ token }));
  }
  res.writeHead(404).end();
});
await new Promise((r) => parentServer.listen(PARENT_PORT, '127.0.0.1', r));
console.log(`편집기 ${EDITOR} (부품 전용, 허용 ${PARENT}) · 부모 ${PARENT} · 방 ${ROOM}`);

const browser = await puppeteer.launch({ headless: process.env.HEADFUL !== '1', executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu', '--lang=ko-KR', '--host-resolver-rules=MAP localhost 127.0.0.1'] });
const contexts = [];
async function openParent(origin, query) {
  const ctx = await browser.createBrowserContext();
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.consoleLines = [];
  page.on('console', (m) => page.consoleLines.push(m.text()));
  page.dialogCount = 0;
  page.on('dialog', (d) => { page.dialogCount += 1; d.dismiss().catch(() => {}); });
  await page.goto(`${origin}/parent.html?${new URLSearchParams({ room: ROOM, ...query })}`, { waitUntil: 'domcontentloaded' });
  return page;
}
const editorFrame = (page) => page.frames().find((f) => f.url().startsWith(EDITOR));
async function waitFor(fn, ms = 60_000, step = 200) {
  const deadline = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* 아직 */ }
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}
const collabStatus = (frame) => frame.evaluate(() => window.__collab?.status() ?? null);
const bannerText = (frame) => frame.evaluate(() => [...document.querySelectorAll('[data-collab="desynced"],[data-collab="unauthorized"]')].map((e) => e.textContent).join(' | '));

try {
  // 1. 허용 출처의 부모 안에서 동작
  const A = await openParent(PARENT, { name: 'A' });
  const fa = await waitFor(() => editorFrame(A), 30_000);
  const readyA = fa && await waitFor(async () => (await collabStatus(fa))?.ready, 90_000);
  const stA = await A.evaluate(() => ({ requests: window.__parent.requests, results: window.__parent.invokeResults, connected: window.__parent.connected }));
  record('1. 허용된 부모의 iframe 안에서: 플러그인이 알림 → 부모가 embed 통로로 setToken → 방에 들어감',
    Boolean(readyA) && stA.connected && stA.requests.length >= 1 && stA.results.some((r) => r.result === true),
    `알림 ${JSON.stringify(stA.requests)}, setToken 결과 ${JSON.stringify(stA.results.map((r) => r.result ?? r.error))}`);
  record('1b. 알림에는 room·reason 만', stA.requests.every((r) => Object.keys(r).sort().join(',') === 'reason,room,type'), JSON.stringify(stA.requests[0]));
  // plugin.invoke 로 읽는 메서드는 막힘
  const inv = await A.evaluate(async () => {
    const r = window.__parent.request;
    return { status: await r('plugin.invoke', { id: 'collab', method: 'status', args: [] }), digest: await r('plugin.invoke', { id: 'collab', method: 'digest', args: [] }) };
  });
  record('1c. 부품 전용 모드의 표면: status·digest 같은 읽기 메서드는 plugin.invoke 로 부를 수 없음',
    Boolean(inv.status.error) && Boolean(inv.digest.error), `${inv.status.error?.message ?? JSON.stringify(inv.status.result)?.slice(0, 80)}`);

  // 2. 최상위로 열면 403
  const ctx = await browser.createBrowserContext();
  contexts.push(ctx);
  const top = await ctx.newPage();
  const resp = await top.goto(`${EDITOR}/?chrome=embed&collab#room=${ROOM}&name=T`, { waitUntil: 'domcontentloaded' });
  const topText = await top.evaluate(() => document.body.innerText);
  record('2. 편집기 주소를 최상위로 열면 403 안내', resp.status() === 403 && topText.includes('연결된 시스템 안에서만'), `${resp.status()} ${topText.slice(0, 40)}`);

  // 3. 허용되지 않은 출처의 iframe 은 브라우저가 막음
  const S = await openParent(STRANGER, { name: 'S' });
  await sleep(6000);
  const fs = editorFrame(S);
  const strangerRequests = await S.evaluate(() => window.__parent.requests.length);
  const blocked = !fs || !(await fs.evaluate(() => Boolean(window.__collab)).catch(() => false));
  record('3. 허용되지 않은 출처(localhost)의 iframe: frame-ancestors 로 브라우저가 막음', blocked && strangerRequests === 0,
    `편집기 프레임 ${fs ? fs.url().slice(0, 40) : '없음'}, 알림 ${strangerRequests}, 콘솔 ${S.consoleLines.find((l) => /frame-ancestors/.test(l))?.slice(0, 80) ?? '-'}`);

  // 4. 주소에 #token 을 붙여도 무시(부모가 답하지 않으면 시간 제한 뒤 안내)
  const valid = auth.issue({ sub: 'leak', name: 'H', room: ROOM, exp: now() + 600 });
  const before = serverLog.filter((l) => l.includes('인증 ')).length;
  const H = await openParent(PARENT, { name: 'H', mode: 'silent', wait: '4000', hashToken: valid });
  const fh = await waitFor(() => editorFrame(H), 30_000);
  const leftH = fh && await waitFor(async () => (await collabStatus(fh))?.left, 30_000);
  const hText = fh ? await bannerText(fh) : '';
  record('4. 주소의 #token 은 쓰지 않음 — 부모가 토큰을 주지 않으면 시간 제한 뒤 "바깥 시스템에서 접속 정보를 받지 못했습니다", 서버에 인증 기록 없음',
    Boolean(leftH) && hText.includes('바깥 시스템에서 접속 정보를 받지 못했습니다') && serverLog.filter((l) => l.includes('인증 ')).length === before, hText);

  // 5. 만료 → 알림(expired) → 부모가 setToken → 다시 들어옴
  const E = await openParent(PARENT, { name: 'E', short: '1' });
  const fe = await waitFor(() => editorFrame(E), 30_000);
  const readyE = fe && await waitFor(async () => (await collabStatus(fe))?.ready, 90_000);
  await sleep(6000); // 첫 토큰이 만료되도록
  await fe.evaluate(() => window.__collab.simulateDisconnect(500));
  const back = readyE && await waitFor(async () => { const s = await collabStatus(fe); return s && s.connection === 'open' && s.reconnects >= 1 && !s.left; }, 40_000);
  const stE = await E.evaluate(() => window.__parent.requests.map((r) => r.reason));
  record('5. 다시 붙을 때 만료 → 알림(expired) → 부모가 새 토큰 → 다시 들어옴', Boolean(back) && stE.includes('expired'),
    `알림 ${JSON.stringify(stE)}, 서버 unauthorized ${serverLog.filter((l) => l.includes('unauthorized expired')).length}`);

  // 6. 부품 전용: 주소에 이름이 없고 #token 이 붙어 있어도 이름 칸을 띄우지 않는다(바깥 시스템의 토큰이 사용자를 안다)
  const P = await openParent(PARENT, { name: '', hashToken: valid });
  const fp = await waitFor(() => editorFrame(P), 30_000);
  const readyP = fp && await waitFor(async () => (await collabStatus(fp))?.ready, 90_000);
  const promptP = fp ? await fp.evaluate(() => Boolean(document.querySelector('[data-collab="name-prompt"]'))) : true;
  record('6. 부품 전용: 이름 없는 링크여도 이름 칸·대화상자 없이 부모의 토큰으로 들어감', Boolean(readyP) && !promptP && P.dialogCount === 0,
    `ready ${Boolean(readyP)}, 이름 칸 ${promptP}, 대화상자 ${P.dialogCount}`);
} catch (error) {
  record('시나리오 실행', false, error.stack ?? String(error));
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close();
  await server.close();
  await new Promise((r) => parentServer.close(r));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exitCode = failed.length ? 1 : 0;
