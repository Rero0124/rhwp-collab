// 5단계 배포 시험 (docs/collab-stage5.md 관문): 서버 한 개가 편집기(빌드한 studio)·업로드 API·공동편집을 같은 출처로
// 내주고, 인증(HS256)을 켠 채 POST /rooms 로 만든 방에 브라우저들이 초대 링크로 들어와 함께 편집한다.
//
// 준비: scripts/build-wasm.sh, scripts/build-studio.sh (target/studio). 서버는 이 스크립트가 띄운다.
// 실행: node collab-client/e2e/s5-deploy.mjs
// 환경 변수:
//   HOST          서버가 받을 주소(기본 127.0.0.1). 다른 기기 시험은 0.0.0.0
//   PUBLIC_HOST   브라우저가 여는 주소의 호스트(기본 HOST, 0.0.0.0 이면 localhost). 다른 기기 시험은 이 기기의 LAN IP
//   PORT          기본 8797
//   S5_TLS=1      자체 서명 인증서를 임시 디렉터리에 만들어 HTTPS/wss 로 띄운다(PUBLIC_HOST 를 SAN 에 넣음)
//   S5_BROWSERS   참여자(쉼표): local(이 기기 Chrome) | cdp:<url>(이미 떠 있는 원격 Chrome). 기본 local,local
//                 첫 참여자가 A, 둘째가 B. 인증 실패·보기 전용·재접속 만료 시험은 B 의 브라우저로 한다.
//   S5_HTTP_PORT  주면 같은 서버를 http 로도 이 포트에 띄워, B 가 http://PUBLIC_HOST:포트 로 열었을 때를 기록한다
//                 (PUBLIC_HOST 가 루프백이 아니면 보안 컨텍스트가 아니다)
//   CHROME_PATH, HEADFUL=1
// 비밀키·토큰·인증서는 이 프로세스 메모리와 임시 디렉터리에만 둔다(저장소에 남기지 않는다).
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const studioDir = path.join(root, 'upstream/rhwp/rhwp-studio');
const puppeteer = createRequire(path.join(studioDir, 'package.json'))('puppeteer-core');
const { WebSocket } = createRequire(path.join(root, 'server/package.json'))('ws');
const { startServer } = await import(path.join(root, 'server/server.mjs'));
const { hs256Auth, signHs256 } = await import(path.join(root, 'server/auth.mjs'));
const { LocalDocStore } = await import(path.join(root, 'server/doc-store.mjs'));
const { loadWasm } = await import(path.join(root, 'collab-client/test/support/harness.mjs'));
const { CollabEngine } = await import(path.join(root, 'collab-client/src/engine/engine.ts'));
const { ENGINE_FINGERPRINT } = await import(path.join(root, 'collab-client/src/engine/catalog.ts'));

const HOST = process.env.HOST ?? '127.0.0.1';
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? (HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST);
const PORT = Number(process.env.PORT ?? 8797);
const TLS = process.env.S5_TLS === '1';
const HTTP_PORT = process.env.S5_HTTP_PORT ? Number(process.env.S5_HTTP_PORT) : null;
const SPECS = (process.env.S5_BROWSERS ?? 'local,local').split(',').map((s) => s.trim()).filter(Boolean);
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const STATIC = path.join(root, 'target/studio');
const VERBOSE = process.env.S5_VERBOSE === '1';
const DOC = path.join(root, 'upstream/rhwp/samples/biz_plan.hwp');
if (!existsSync(path.join(STATIC, 'index.html'))) throw new Error('target/studio 가 없습니다 — scripts/build-studio.sh');

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

// ── 서버 ──────────────────────────────────────────────────────────────
const temp = mkdtempSync(path.join(tmpdir(), 'cc-rhwp-s5-'));
const SECRET = randomBytes(32).toString('base64url');
let tls = null;
if (TLS) {
  const key = path.join(temp, 'key.pem');
  const cert = path.join(temp, 'cert.pem');
  const san = /^[\d.]+$/.test(PUBLIC_HOST) ? `IP:${PUBLIC_HOST},DNS:localhost` : `DNS:${PUBLIC_HOST},DNS:localhost,IP:127.0.0.1`;
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=cc-rhwp-s5-test', '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
  tls = { cert: readFileSync(cert), key: readFileSync(key) };
}
const serverLog = [];
const store = new LocalDocStore(path.join(temp, 'data'));
const common = { host: HOST, log: (m) => serverLog.push(m), auth: hs256Auth(SECRET), store, staticDir: STATIC, delayMs: 0 };
const server = startServer({ ...common, port: PORT, tls });
await server.ready;
// http 로 같은 방을 여는 시험용(같은 저장소는 쓰지 않는다 — 들어오지 못하는 것만 본다)
const httpServer = HTTP_PORT ? startServer({ ...common, store: null, port: HTTP_PORT, tls: null }) : null;
if (httpServer) await httpServer.ready;
const ORIGIN = `${TLS ? 'https' : 'http'}://${PUBLIC_HOST}:${PORT}`;
console.log(`서버 ${ORIGIN} (HOST=${HOST}${TLS ? ', 자체 서명 TLS' : ''}${httpServer ? `, http 시험 ${HTTP_PORT}` : ''})`);

const tok = (claims) => signHs256({ sub: 'tester', room: '*', exp: now() + 600, ...claims }, SECRET);
const fetchApi = async (pathname, init = {}) => {
  // 자체 서명 인증서: 시험 프로세스 안에서만 확인을 끈다
  if (TLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try { return await fetch(`${TLS ? 'https' : 'http'}://127.0.0.1:${PORT}${pathname}`, init); } finally { if (TLS) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; }
};

// ── 브라우저 ──────────────────────────────────────────────────────────
const browsers = [];
async function openBrowser(spec) {
  if (spec === 'local') {
    const b = await puppeteer.launch({
      headless: process.env.HEADFUL !== '1', executablePath: CHROME,
      args: ['--no-sandbox', '--disable-gpu', '--lang=ko-KR', ...(TLS ? ['--ignore-certificate-errors'] : [])],
      acceptInsecureCerts: true,
    });
    browsers.push({ b, remote: false });
    return { b, label: 'Mac Chrome' };
  }
  if (spec.startsWith('cdp:')) {
    const b = await puppeteer.connect({ browserURL: spec.slice(4), acceptInsecureCerts: true, defaultViewport: null });
    browsers.push({ b, remote: true });
    return { b, label: 'Remote Chrome' };
  }
  throw new Error(`모르는 참여자: ${spec}`);
}

const contexts = [];
async function openPage(browser, url, name) {
  const ctx = await browser.createBrowserContext();
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('console', (msg) => {
    const t = msg.text();
    if (VERBOSE ? msg.type() !== 'debug' : /^\[collab/.test(t) && /인증|나감|재동기화|forbidden|HTTPS|권한/.test(t)) console.log(`    [${name}] ${t.slice(0, 200)}`);
  });
  page.on('pageerror', (e) => console.log(`    [${name} pageerror] ${e.message.slice(0, 200)}`));
  // 새로고침의 "저장하지 않은 변경" 확인(studio 의 beforeunload)은 받아들이고, 그 밖은 닫는다(이름은 화면 안 칸으로 묻는다 —
  // 브라우저 대화상자는 뜨지 않아야 한다, 7b).
  page.dialogs = [];
  page.on('dialog', (d) => { page.dialogs.push(d.type()); (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  page.tabName = name;
  return page;
}
const link = (token, room, name, origin = ORIGIN) => `${origin}/?collab#token=${encodeURIComponent(token)}&room=${encodeURIComponent(room)}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
// 배포 빌드에는 개발용 전역(__inputHandler·__wasm)이 없다 — 실제 화면을 눌러 캐럿을 놓고 키보드로 친다.
// 상태·digest 는 플러그인 표면(window.__collab)으로 본다.
const waitReady = (page, ms = 120_000) => page.waitForFunction(() => window.__collab?.status().ready && document.querySelector('#scroll-content canvas'), { timeout: ms });
const status = (page) => page.evaluate(() => window.__collab?.status() ?? null);
const digest = (page) => page.evaluate(() => window.__collab.digest());
const bannerText = (page) => page.evaluate(() => [...document.querySelectorAll('[data-collab="desynced"],[data-collab="unauthorized"],[data-collab="insecure"]')].map((e) => e.textContent).join(' | '));
const noticeTexts = (page) => page.evaluate(() => [...document.querySelectorAll('[data-collab="status"] > div')].map((e) => e.textContent));
/** 첫 쪽의 (가로, 세로) 비율 위치를 누른다 — 그 자리에 캐럿이 놓인다. */
const clickAt = async (page, fx, fy) => {
  await page.bringToFront();
  const r = await page.evaluate(() => {
    const c = document.querySelector('#scroll-content canvas');
    c.scrollIntoView({ block: 'start' });
    const b = c.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
  await page.mouse.click(r.x + r.w * fx, r.y + Math.min(r.h, 860) * fy);
  await sleep(200);
};
const typeText = async (page, text) => { await page.keyboard.sendCharacter(text); await sleep(150); };

let lastSeq = -1;
async function settle(pages, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  await sleep(400);
  let last;
  while (Date.now() < deadline) {
    last = await Promise.all(pages.map(status));
    if (last.some((s) => s.desynced || s.left)) return last;
    const seqs = new Set(last.map((s) => s.lastSeq));
    if (seqs.size === 1 && last[0].lastSeq > lastSeq && last.every((s) => !s.inflight && !s.pending && !s.resyncing && s.digestSentSeq === s.lastSeq)) {
      await sleep(700);
      last = await Promise.all(pages.map(status));
      lastSeq = last[0].lastSeq;
      return last;
    }
    await sleep(100);
  }
  throw new Error(`settle 시간 초과: ${JSON.stringify(last?.map((s) => ({ n: s.name, seq: s.lastSeq, p: s.pending, i: s.inflight })))}`);
}

/** Node: 서버 기록(welcome)을 엔진 기본 환경에서 재생 — 서버 정본과 같은 환경 */
const wasm = await loadWasm();
async function nodeReplay(room, token) {
  if (TLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const ws = new WebSocket(`${TLS ? 'wss' : 'ws'}://127.0.0.1:${PORT}/`);
  const w = await new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', room, clientId: `node-${Date.now()}`, name: 'node', engine: ENGINE_FINGERPRINT, token })));
    ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'welcome') resolve(m); if (m.type === 'unauthorized') reject(new Error(m.reason)); });
  });
  ws.close();
  if (TLS) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const doc = new wasm.HwpDocument(gunzipSync(Buffer.from(w.base, 'base64')));
  const engine = new CollabEngine({ onLocal() {}, onWarn() {} });
  engine.attach(doc);
  engine.replayAll(w.log);
  const out = { seq: w.seq, digest: doc.collabDigest(), exported: gunzipSync(Buffer.from(doc.collabExportState())) };
  engine.detach();
  doc.free();
  return out;
}
const digestOfFile = (bytes) => { const d = new wasm.HwpDocument(bytes); const x = d.collabDigest(); d.free(); return x; };

try {
  const [pa, pb] = [SPECS[0], SPECS[1] ?? SPECS[0]];
  const A0 = await openBrowser(pa);
  const B0 = pb === pa && pa === 'local' ? A0 : await openBrowser(pb);
  record('0. 브라우저', true, `A=${A0.label} ${await A0.b.version()}, B=${B0.label} ${await B0.b.version()}`);

  // ── 1. 파일로 방 만들기 ──
  const raw = readFileSync(DOC);
  const made = await fetchApi('/rooms', { method: 'POST', headers: { authorization: `Bearer ${tok({ scope: 'create' })}` }, body: raw });
  const created = await made.json();
  record('1. POST /rooms(create 토큰) → 방과 권한별 초대 토큰', made.status === 201 && Object.keys(created.invite ?? {}).length === 4,
    `방 ${created.room}, 초대 ${Object.keys(created.invite ?? {}).join('·')}, 만료 ${created.inviteExpiresAt}`);
  const { room, invite } = created;

  // ── 2. 두 브라우저가 편집 초대 링크로 들어옴 ──
  const A = await openPage(A0.b, link(invite.edit, room, 'A'), 'A');
  const B = await openPage(B0.b, link(invite.edit, room, 'B'), 'B');
  await Promise.all([waitReady(A), waitReady(B)]);
  const facts = await Promise.all([A, B].map((p) => p.evaluate(() => ({
    secure: window.isSecureContext, hash: location.hash, href: location.href.replace(/#.*/, ''),
    user: window.__collab.status().user, ua: navigator.userAgent.match(/\(([^;)]+)/)?.[1] ?? '',
    stored: Object.keys(sessionStorage).filter((k) => k.startsWith('collab-token:')).length,
  }))));
  record('2. 초대 링크로 입장: 보안 컨텍스트, 주소에서 토큰이 지워짐, 서버가 확인한 이름·권한',
    facts.every((f) => f.secure && !f.hash.includes('token=') && f.user?.scope?.includes('edit') && f.stored === 1)
      && facts[0].user.name === 'A' && facts[1].user.name === 'B' && /^invite~/.test(facts[0].user.sub),
    facts.map((f, i) => `${i ? 'B' : 'A'}[${f.ua}] ${f.href} hash="${f.hash}" sub=${f.user?.sub} scope=${f.user?.scope}`).join('; '));

  // ── 3. 함께 편집 ──
  await settle([A, B]).catch(() => {});
  lastSeq = (await status(A)).lastSeq;
  await clickAt(A, 0.3, 0.12);
  await typeText(A, '맥에서 친 글 ');
  await clickAt(B, 0.4, 0.3);
  await typeText(B, ' 다른 기기에서 친 글');
  await clickAt(A, 0.3, 0.12);
  await typeText(A, '동시에 ');
  await clickAt(B, 0.3, 0.12);
  await typeText(B, '같이 ');
  let st = await settle([A, B]);
  let ds = await Promise.all([A, B].map(digest));
  let node = await nodeReplay(room, invite.view);
  const canon = server.rooms.get(room).canonDigests.get(st[0].lastSeq);
  record('3. 함께 편집: digest 일치(두 브라우저·정본·Node 재생), 재동기화 0',
    ds[0] === ds[1] && ds[0] === canon && node.digest === ds[0] && st.every((s) => s.resyncCount === 0 && !s.desynced),
    `seq ${st[0].lastSeq}, A=${ds[0].slice(0, 12)} B=${ds[1].slice(0, 12)} 정본=${canon?.slice(0, 12)} node=${node.digest.slice(0, 12)}, resync ${st.map((s) => s.resyncCount)}`);

  // ── 4. 문서 내려받기 ──
  const dl = await fetchApi(`/rooms/${room}/document`, { headers: { authorization: `Bearer ${invite.view}` } });
  const file = Buffer.from(await dl.arrayBuffer());
  record('4. GET …/document: 편집이 반영된 파일, 다시 열면 digest = 정본 기록을 재생해 내보내고 다시 읽은 것',
    dl.status === 200 && dl.headers.get('x-collab-seq') === String(st[0].lastSeq) && digestOfFile(file) === digestOfFile(node.exported) && digestOfFile(file) !== digestOfFile(raw),
    `${dl.status}, ${file.length}B, seq ${dl.headers.get('x-collab-seq')}`);
  const noCreate = await fetchApi(`/rooms/${room}/document`, { headers: { authorization: `Bearer ${tok({ scope: 'create' })}` } });
  record('4b. create 만 있는 토큰으로는 내려받지 못함', noCreate.status === 403, String(noCreate.status));

  // ── 5. 새로고침: 같은 탭의 sessionStorage 토큰으로 다시 들어옴 ──
  await B.reload({ waitUntil: 'domcontentloaded' });
  await waitReady(B);
  const rb = await status(B);
  record('5. 새로고침해도 다시 들어옴(토큰은 탭의 sessionStorage)', rb.ready && rb.user?.scope?.includes('edit'), `seq ${rb.lastSeq}, 대화상자 ${JSON.stringify(B.dialogs)}`);
  lastSeq = -1;
  await settle([A, B]);

  // ── 6. 인증 실패는 안내만 띄우고 들어가지 않는다 ──
  const otherSecret = randomBytes(32).toString('base64url');
  const bad = [
    ['missing', `${ORIGIN}/?collab#room=${room}&name=X`, '토큰이 없습니다'],
    ['invalid', link(signHs256({ sub: 'x', room, exp: now() + 600 }, otherSecret), room, 'X'), '올바르지 않습니다'],
    ['expired', link(tok({ room, exp: now() - 120 }), room, 'X'), '인증이 만료되었습니다'],
    ['room', link(tok({ room: 'another-room' }), room, 'X'), '이 방에 들어갈 수 없습니다'],
    ['no-room', link(tok({}), 'no-such-room', 'X'), '방이 없습니다'],
  ];
  for (const [reason, url, expect] of bad) {
    const p = await openPage(B0.b, url, `X-${reason}`);
    await p.waitForFunction(() => window.__collab?.status().left, { timeout: 60_000 }).catch(() => {});
    const s = await status(p);
    const text = await bannerText(p);
    record(`6. 인증 실패 ${reason}: 들어가지 않고 안내`, Boolean(s?.left) && text.includes(expect) && s.reconnects === 0, text);
    await p.close();
  }

  // ── 7. 보기 전용 ──
  const V = await openPage(B0.b, link(invite.view, room, 'V'), 'V');
  await waitReady(V);
  const seqBefore = (await status(A)).lastSeq;
  await clickAt(V, 0.3, 0.12);
  await typeText(V, '보기 전용이 친 글');
  await sleep(2500);
  const [sv, sa] = await Promise.all([status(V), status(A)]);
  const vNotices = await noticeTexts(V);
  const [dv, da] = await Promise.all([digest(V), digest(A)]);
  // 클라이언트 문(4단계 뒤 기존 코드 세션)이 있으면 입력이 core 에 닿기 전에 막히고(재동기화 0, 서버 forbidden 0), 없으면
  // 서버가 forbidden(scope) → 제자리 재동기화로 되돌린다. 어느 쪽이든 문서·seq 는 그대로여야 한다.
  const forbiddenCount = serverLog.filter((l) => l.includes('forbidden')).length;
  const path7 = sv.resyncCount === 0 && forbiddenCount === 0 ? '클라이언트 문에서 막힘' : '서버 forbidden → 재동기화';
  record(`7. view: 편집이 문서에 남지 않음(${path7}), 다른 참여자·seq 그대로`,
    sa.lastSeq === seqBefore && dv === da && vNotices.some((t) => t.includes('보기')) && (path7 === '클라이언트 문에서 막힘' || sv.resyncCount >= 1),
    `seq ${seqBefore}→${sa.lastSeq}, V resync ${sv.resyncCount}, 안내 ${JSON.stringify(vNotices.filter((t) => /보기|권한/.test(t)))}, 서버 forbidden ${forbiddenCount}`);
  await V.close();

  // ── 7b. 이름 없는 초대 링크: 화면 안 이름 칸(브라우저 대화상자 없음) → 그 이름으로 들어감, 새로고침하면 다시 묻지 않음 ──
  const N = await openPage(B0.b, link(invite.edit, room, ''), 'N');
  const askedN = await N.waitForSelector('[data-collab="name-input"]', { timeout: 120_000 }).then(() => true, () => false);
  const beforeN = await status(N);
  if (askedN) {
    await N.click('[data-collab="name-input"]');
    await N.type('[data-collab="name-input"]', '이름칸');
    await N.click('[data-collab="name-submit"]');
  }
  await waitReady(N);
  const stN = await status(N);
  await N.reload({ waitUntil: 'domcontentloaded' });
  await waitReady(N);
  const reaskedN = await N.evaluate(() => Boolean(document.querySelector('[data-collab="name-input"]')));
  const stN2 = await status(N);
  record('7b. 이름 없는 초대 링크: 화면 안 이름 칸으로 묻고(브라우저 대화상자 없음, 묻는 동안 연결하지 않음) 그 이름으로 들어감, 새로고침하면 기억한 이름',
    askedN && beforeN?.connection === 'connecting' && !beforeN?.ready && stN.user?.name === '이름칸' && !reaskedN && stN2.user?.name === '이름칸'
      && N.dialogs.filter((d) => d !== 'beforeunload').length === 0,
    `칸 ${askedN}, 묻는 동안 ${beforeN?.connection}/${beforeN?.ready}, 이름 ${stN.user?.name} → 새로고침 ${stN2.user?.name}(다시 물음 ${reaskedN}), 대화상자 ${JSON.stringify(N.dialogs)}`);
  await N.close();

  // ── 8. 다시 붙을 때 만료 → 다시 붙기를 멈추고 안내, 보내지 못한 편집 수 ──
  // 시계 오차 30초를 두므로 exp = 지금 - 5 → 약 25초 동안만 유효. 들어온 뒤 만료될 때까지 끊어 둔다.
  const shortExp = now() - 5;
  const E = await openPage(B0.b, link(tok({ room, sub: 'short', name: 'E', exp: shortExp }), room, 'E'), 'E');
  await waitReady(E);
  const hold = (shortExp + 30 + 2) * 1000 - Date.now();
  await E.evaluate((ms) => window.__collab.simulateDisconnect(ms), hold);
  await sleep(300);
  await clickAt(E, 0.3, 0.12);
  await typeText(E, '끊긴 동안');
  await E.waitForFunction(() => window.__collab.status().left, { timeout: 40_000 }).catch(() => {});
  const se = await status(E);
  const eb = await bannerText(E);
  record('8. 재접속 중 만료: 다시 붙기를 멈추고 "인증이 만료되었습니다" + 보내지 못한 편집 수',
    se.left && eb.includes('인증이 만료되었습니다') && /보내지 못한 편집 \d+건/.test(eb), eb);
  await E.close();

  // ── 9. http 로 열면 ──
  if (httpServer) {
    const before = serverLog.filter((l) => l.includes('인증 ')).length;
    const H = await openPage(B0.b, link(invite.edit, room, 'H', `http://${PUBLIC_HOST}:${HTTP_PORT}`), 'H');
    await H.waitForFunction(() => window.__collab !== undefined, { timeout: 60_000 }).catch(() => {});
    await sleep(1500);
    const info = await H.evaluate(() => ({
      secure: window.isSecureContext, randomUUID: typeof crypto.randomUUID, subtle: typeof crypto.subtle,
      clipboard: typeof navigator.clipboard, sw: 'serviceWorker' in navigator, status: window.__collab?.status() ?? null,
    }));
    const hb = await bannerText(H);
    record(`9. http://${PUBLIC_HOST}:${HTTP_PORT} 로 열면: 보안 컨텍스트 ${info.secure ? '맞음' : '아님'} → ${info.secure ? '들어감' : '들어가지 않고 안내'}`,
      info.secure ? Boolean(info.status?.ready || info.status) : (hb.includes('HTTPS 에서만') && serverLog.filter((l) => l.includes('인증 ')).length === before),
      `isSecureContext=${info.secure} randomUUID=${info.randomUUID} subtle=${info.subtle} clipboard=${info.clipboard} serviceWorker=${info.sw}; 안내 "${hb}"`);
    await H.close();
  }

  // ── 10. 마무리: 최종 digest ──
  await clickAt(A, 0.3, 0.12);
  await typeText(A, '끝 ');
  st = await settle([A, B]);
  ds = await Promise.all([A, B].map(digest));
  node = await nodeReplay(room, invite.view);
  record('10. 마지막: 두 브라우저·Node 재생 digest 일치, 재동기화 0(A·B)',
    ds[0] === ds[1] && node.digest === ds[0] && st.every((s) => s.resyncCount === 0 && !s.desynced && !s.left),
    `seq ${st[0].lastSeq}, ${ds[0].slice(0, 12)}, resync ${st.map((s) => s.resyncCount)}`);
} catch (error) {
  record('시나리오 실행', false, error.stack ?? String(error));
} finally {
  for (const ctx of contexts) await ctx.close().catch(() => {});
  for (const { b, remote } of browsers) await (remote ? b.disconnect() : b.close()).catch(() => {});
  await server.close();
  await httpServer?.close();
  rmSync(temp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
const counts = { unauthorized: serverLog.filter((l) => l.includes('unauthorized')).length, forbidden: serverLog.filter((l) => l.includes('forbidden')).length, diverged: serverLog.filter((l) => l.includes('DIVERGED')).length, invalid: serverLog.filter((l) => /\] invalid /.test(l)).length };
console.log(`서버 로그: ${JSON.stringify(counts)}`);
process.exitCode = failed.length ? 1 : 0;
