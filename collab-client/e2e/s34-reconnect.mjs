// S3-4 브라우저 검증 (docs/collab-stage3.md S3-4 관문 + S3-3 재시작): 끊김·재접속·서버 재시작에도 수렴한다.
//  1. 끊긴 동안 양쪽이 편집 → 다시 붙으면 따라잡기(catchup)로 수렴, 끊긴 동안의 편집은 한 번씩만
//  2. 끊기기 직전 보낸 묶음이 서버에 받아졌는데 ack 를 못 받은 경우 → 따라잡기에서 내 묶음으로 확정(중복 없음)
//  3. 서버 재시작(같은 저장소로 다시 띄움 — 기준점 + 기록으로 복원) 동안 편집 → 다시 붙어 따라잡기로 수렴,
//     복원한 정본과 digest 같음
//  4. 오래 끊김: 그동안 방이 비어 세대가 바뀜(S3-3 결정 — 빈 방에서만) → 다시 붙으면 welcome 으로 재동기화 + 안내,
//     끊긴 동안 오래 끊김 안내. 새 세대에 새로 들어온 탭과 수렴
//
// 준비: (cd upstream/rhwp/rhwp-studio && npx vite) (7700). 서버는 이 스크립트가 8792 에 정본 + 저장소로 띄운다
//       (모든 송신 300ms 지연 — ack 를 잃는 순간을 만들려고).
// 실행: node collab-client/e2e/s34-reconnect.mjs
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const puppeteer = createRequire(path.join(root, 'upstream/rhwp/rhwp-studio/package.json'))('puppeteer-core');
const { startServer } = await import(path.join(root, 'server/server.mjs'));
const { LocalDocStore } = await import(path.join(root, 'server/doc-store.mjs'));

const STUDIO = process.env.STUDIO_URL ?? 'http://127.0.0.1:7700';
const PORT = 8792;
const COLLAB = `ws://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DATA = mkdtempSync(path.join(tmpdir(), 'cc-rhwp-s34-'));

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serverLog = [];
const store = new LocalDocStore(DATA);
const launch = () => startServer({ port: PORT, log: (m) => serverLog.push(m), delayMs: 300, store });
let server = launch();
await server.ready;
const room = `s34-${Date.now()}`;

async function openTab(ctx, name, extra = '') {
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => console.log(`    [${name} pageerror] ${e.message}`));
  await page.goto(`${STUDIO}/?collab=${encodeURIComponent(COLLAB)}&room=${room}&name=${name}${extra}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__collab?.status().ready && window.__inputHandler, { timeout: 90_000 });
  return page;
}
const status = (page) => page.evaluate(() => window.__collab.status());
const waitFor = async (page, pred, ms = 30_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await status(page);
    if (pred(s) || Date.now() > deadline) return s;
    await sleep(150);
  }
};
const settled = async (pages) => {
  await sleep(400);
  const st = await Promise.all(pages.map((p) => waitFor(p, (s) => s.connection === 'open' && !s.inflight && !s.pending && !s.resyncing && s.digestSentSeq === s.lastSeq)));
  const seq = Math.max(...st.map((s) => s.lastSeq));
  return Promise.all(pages.map((p) => waitFor(p, (s) => s.lastSeq === seq && !s.inflight && !s.pending && s.digestSentSeq === s.lastSeq)));
};
async function type(page, para, offset, text) {
  await page.bringToFront();
  await page.evaluate(([p, o]) => {
    const ih = window.__inputHandler;
    ih.cursor.clearSelection();
    ih.cursor.moveTo({ sectionIndex: 0, paragraphIndex: p, charOffset: o });
    ih.textarea.focus();
  }, [para, offset]);
  await page.keyboard.type(text);
}
const text0 = (page) => page.evaluate(() => {
  const d = window.__wasm.doc;
  const n = d.getParagraphCount(0);
  const out = [];
  for (let p = 0; p < n; p += 1) out.push(d.getTextRange(0, p, 0, d.getParagraphLength(0, p)));
  return out.join('\n');
});
const count = (hay, needle) => hay.split(needle).length - 1;
const canonMatch = async (pages) => {
  const r = server.rooms.get(room);
  await r.queue;
  const canon = (await r.canonical.digest()).digest;
  const ds = await Promise.all(pages.map((p) => p.evaluate(() => window.__collab.digest())));
  return { ok: ds.every((d) => d === canon), detail: `seq ${r.seq} 정본 ${canon.slice(0, 10)} 탭 ${ds.map((d) => d.slice(0, 10)).join(' ')}` };
};

const browser = await puppeteer.launch({ headless: process.env.HEADFUL !== '1', executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu', '--lang=ko-KR'] });
try {
  const ctx = await browser.createBrowserContext();
  const A = await openTab(ctx, 'A');
  const B = await openTab(ctx, 'B', '&collabLongDisconnectMs=1500');
  await type(A, 0, 0, 'first line');
  await A.keyboard.press('Enter');
  await type(A, 1, 0, 'second line');
  await settled([A, B]);

  // 1. B 가 3초 끊긴 동안 양쪽이 편집
  await B.evaluate(() => window.__collab.simulateDisconnect(3000));
  await waitFor(B, (s) => s.connection !== 'open', 5000);
  await type(B, 1, 0, 'OFFLINE-B ');
  await type(A, 0, 0, 'ONLINE-A ');
  const mid = await status(B);
  const st1 = await settled([A, B]);
  const t1 = await text0(B);
  let m = await canonMatch([A, B]);
  record('1. 끊긴 동안 양쪽 편집 → 따라잡기로 수렴, 끊긴 동안 편집은 한 번씩', mid.connection !== 'open' && mid.pending > 0 && st1[1].reconnects >= 1 && st1.every((s) => s.resyncCount === 0)
    && count(t1, 'OFFLINE-B') === 1 && count(t1, 'ONLINE-A') === 1 && m.ok,
    `끊긴 동안 B 미확정 ${mid.pending}, 재접속 ${st1[1].reconnects}, resync ${st1.map((s) => s.resyncCount).join('/')}, ${m.detail}`);

  // 2. ack 를 잃는다: B 가 보낸 직후(서버는 받아 기록·확정했지만 ack 는 300ms 지연 중) 끊는다
  const before2 = serverLog.length;
  await type(B, 0, 0, 'ACKLOST ');
  await B.waitForFunction(() => window.__collab.status().inflightBatch !== null, { timeout: 3000 });
  await sleep(80);
  await B.evaluate(() => window.__collab.simulateDisconnect(800));
  const st2 = await settled([A, B]);
  const t2 = await text0(B);
  m = await canonMatch([A, B]);
  const caughtUp = serverLog.slice(before2).find((l) => / catchup B/.test(l)) ?? '';
  record('2. 끊기기 직전 보낸 묶음이 서버에 받아졌으면 따라잡기에서 확정 — 중복 없음', count(t2, 'ACKLOST') === 1 && m.ok && /\(\d+건\)/.test(caughtUp) && !/\(0건\)/.test(caughtUp),
    `ACKLOST ${count(t2, 'ACKLOST')}회, ${caughtUp.replace(/^\[[^\]]+\] /, '')}, ${m.detail}, resync ${st2.map((s) => s.resyncCount).join('/')}`);

  // 3. 서버 재시작: 닫았다가(저장본만 쓰고 기록은 그대로) 같은 저장소로 다시 띄운다. 그동안 양쪽이 편집한다.
  await server.close();
  await Promise.all([A, B].map((p) => waitFor(p, (s) => s.connection !== 'open', 5000)));
  await type(A, 0, 0, 'DOWN-A ');
  await type(B, 1, 0, 'DOWN-B ');
  await sleep(500);
  server = launch();
  await server.ready;
  const st3 = await settled([A, B]);
  const t3 = await text0(A);
  m = await canonMatch([A, B]);
  record('3. 서버 재시작 동안 편집 → 다시 붙어 따라잡기로 수렴(재동기화 없음), 복원한 정본과 digest 같음', count(t3, 'DOWN-A') === 1 && count(t3, 'DOWN-B') === 1 && m.ok && st3.every((s) => s.resyncCount === 0),
    `재접속 ${st3.map((s) => s.reconnects).join('/')}, resync ${st3.map((s) => s.resyncCount).join('/')}, ${m.detail}`);

  // 4. 오래 끊김: B 가 끊긴 동안 A 가 편집하고 나간다 → 방이 빔 → 세대 전환(원래는 10분 빈 뒤, 시험이라 바로) →
  //    새 탭 C 가 새 세대로 들어온다 → B 가 다시 붙으면 세대가 달라 welcome → 재동기화 + 안내(끊긴 동안 편집은 취소)
  await B.evaluate(() => window.__collab.simulateDisconnect(6000));
  await waitFor(B, (s) => s.connection !== 'open', 5000);
  await type(B, 0, 0, 'LOST-B ');
  await type(A, 1, 0, 'MOVED ');
  await settled([A]);
  await A.close();
  await sleep(500);
  await server.changeGeneration(room);
  const C = await openTab(ctx, 'C');
  await sleep(1500);
  const warned = await B.evaluate(() => Boolean(document.querySelector('[data-collab="long-disconnect"]')));
  await waitFor(B, (s) => s.connection === 'open' && s.reconnects >= 3, 15_000);
  const st4 = await settled([B, C]);
  const notified = await B.evaluate(() => Boolean(document.querySelector('[data-collab="resume-fallback"]')));
  const t4 = await text0(B);
  m = await canonMatch([B, C]);
  record('4. 오래 끊김(그동안 빈 방이 세대 전환) → 서버 문서로 다시 맞춤 + 안내, 끊긴 동안 오래 끊김 안내, 새 세대 참여자와 수렴',
    notified && warned && m.ok && count(t4, 'MOVED') === 1 && count(t4, 'LOST-B') === 0,
    `오래 끊김 안내 ${warned}, 다시 맞춤 안내 ${notified}, LOST-B ${count(t4, 'LOST-B')}회(취소), ${m.detail}, resync ${st4.map((s) => s.resyncCount).join('/')}`);
  await ctx.close();
} catch (error) {
  record('시나리오 실행', false, error.stack ?? String(error));
} finally {
  await browser.close();
  await server.close();
  rmSync(DATA, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
if (failed.length) for (const line of serverLog.filter((l) => /catchup|welcome|invalid|DIVERGED|복원|세대|reject/.test(l)).slice(-16)) console.log(`    [server] ${line.slice(0, 200)}`);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exitCode = failed.length ? 1 : 0;
