// R7 플러그인 생애 검증 (docs/collab-stage2.md §7, 설계 정정): 예상치 못한 문서 교체 → 방을 나감,
// 엔진 지문 불일치 → incompatible 안내, base 가 메시지 상한을 넘음 → 시작 거절, digest 어긋남 → 재동기화로 회복.
//
// 준비: node server/server.mjs (8787) + (cd upstream/rhwp/rhwp-studio && npx vite) (7700)
//       상한 시험용으로 COLLAB_MAX_MESSAGE_BYTES=2000 서버를 8789 에, 지문 시험용으로 다른 엔진 서버를 8791 에 직접 띄운다.
// 실행: node collab-client/e2e/r7-lifecycle.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const studioDir = path.resolve(here, '../../upstream/rhwp/rhwp-studio');
const puppeteer = createRequire(path.join(studioDir, 'package.json'))('puppeteer-core');
const { startServer } = await import(path.resolve(here, '../../server/server.mjs'));

const STUDIO = process.env.STUDIO_URL ?? 'http://127.0.0.1:7700';
const COLLAB = process.env.COLLAB_URL ?? 'ws://127.0.0.1:8787';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openTab(host, url, name, { waitReady = true } = {}) {
  const page = await host.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[collab') || msg.type() === 'error') console.log(`    [${name} console.${msg.type()}] ${text.slice(0, 200)}`);
  });
  page.on('pageerror', (error) => console.log(`    [${name} pageerror] ${error.message}`));
  await page.goto(`${STUDIO}/?collab=${encodeURIComponent(url.collab)}&room=${encodeURIComponent(url.room)}&name=${name}`, { waitUntil: 'domcontentloaded' });
  if (waitReady) await page.waitForFunction(() => window.__collab?.status().ready && window.__inputHandler, { timeout: 90_000 });
  else await page.waitForFunction(() => window.__collab && window.__inputHandler, { timeout: 90_000 });
  page.tabName = name;
  return page;
}
const status = (page) => page.evaluate(() => window.__collab.status());
const banner = (page) => page.evaluate(() => document.querySelector('[data-collab="desynced"]')?.textContent ?? null);
const waitFor = async (page, pred, ms = 20_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await status(page);
    if (pred(s)) return s;
    if (Date.now() > deadline) return s;
    await sleep(150);
  }
};
async function type(page, para, offset, text) {
  await page.bringToFront();
  await page.evaluate((p, o) => {
    const ih = window.__inputHandler;
    ih.cursor.clearSelection();
    ih.cursor.moveTo({ sectionIndex: 0, paragraphIndex: p, charOffset: o });
    ih.textarea.focus();
  }, para, offset);
  await page.keyboard.type(text);
}
const settled = (pages) => Promise.all(pages.map((p) => waitFor(p, (s) => !s.inflight && !s.pending && !s.resyncing && s.digestSentSeq === s.lastSeq)));

async function swapLeavesRoom(browser) {
  const ctx = await browser.createBrowserContext();
  const room = `r7-swap-${Date.now()}`;
  const A = await openTab(ctx, { collab: COLLAB, room }, 'A');
  const B = await openTab(ctx, { collab: COLLAB, room }, 'B');
  await type(A, 0, 0, 'shared');
  await settled([A, B]);
  // B 사용자가 새 문서를 연다(공동편집 문서가 아닌 다른 문서로 교체). '저장 안 함'을 고른 것과 같게
  // 저장 확인 창은 건너뛴다(file:new-doc 이 내는 이벤트와 같다).
  await B.evaluate(() => window.__eventBus.emit('create-new-document', { skipUnsavedGuard: true }));
  const sb = await waitFor(B, (s) => s.left, 15_000);
  const text = await banner(B);
  record('교체: 다른 문서를 열면 방을 나감', sb.left && /공동편집에서 나왔습니다/.test(text ?? ''), text ?? '배너 없음');
  const resumed = await B.evaluate(() => ({ blocked: window.__autosaveManager?.isRecoveryBlocked?.() }));
  record('교체: 자동 저장 중지가 풀림', resumed.blocked === false, JSON.stringify(resumed));
  // 나간 뒤 B 의 편집은 보내지 않고, A 의 편집도 받지 않는다
  const sentBefore = sb.sentEntries;
  // 교체 알림은 새 문서 열기 도중에 온다. 열기(글꼴·화면 준비)가 끝난 뒤에 친다 — 열기 끝에서 입력기가
  // 초기화되며 되돌리기 기록도 비우기 때문이다(studio 동작).
  // 입력기가 꺼졌다가(열기 중) 다시 켜질 때까지 — 못 보면 넉넉히 기다린다
  await B.waitForFunction(() => window.__inputHandler.active === false, { timeout: 5_000 }).catch(() => {});
  await B.waitForFunction(() => window.__inputHandler.active === true && window.__wasm?.pageCount > 0, { timeout: 30_000 });
  await sleep(1000);
  await type(B, 0, 0, 'local only');
  await type(A, 0, 0, 'A again ');
  await sleep(1500);
  const sa = await status(A);
  const sb2 = await status(B);
  const bText = await B.evaluate(() => window.__wasm.getTextRange(0, 0, 0, window.__wasm.getParagraphLength(0, 0)));
  record('교체: 나간 뒤 기록·전송 없음, 남의 편집도 안 받음', sb2.sentEntries === sentBefore && !bText.includes('A again') && bText.includes('local only'),
    `B sent ${sentBefore}→${sb2.sentEntries}, B 문단0 ${JSON.stringify(bText)}`);
  record('교체: 남은 A 는 정상', !sa.desynced && !sa.left, `A seq ${sa.lastSeq}`);
  // 되돌리기도 다시 동작한다(기록 중지 해제) — B 에서 undo 가 막힘 안내 없이 동작하는지
  const undo = await B.evaluate(() => {
    const before = window.__wasm.getTextRange(0, 0, 0, window.__wasm.getParagraphLength(0, 0));
    window.rhwpStudio.automation.execute('edit:undo');
    return before;
  });
  await sleep(500);
  const afterUndo = await B.evaluate(() => window.__wasm.getTextRange(0, 0, 0, window.__wasm.getParagraphLength(0, 0)));
  record('교체: 되돌리기 중지가 풀림', afterUndo !== undo, `${JSON.stringify(undo)} → ${JSON.stringify(afterUndo)}`);
  await ctx.close();
}

async function incompatibleNotice(browser) {
  const room = `r7-incompat-${Date.now()}`;
  // 다른 엔진으로 도는 서버(S3-2: 정본을 켜면 서버 자신의 엔진이 방의 엔진이다)
  const old = startServer({ port: 8791, log: () => {}, engine: 'old-engine-fingerprint' });
  await old.ready;
  const ctx = await browser.createBrowserContext();
  const C = await openTab(ctx, { collab: 'ws://127.0.0.1:8791', room }, 'C', { waitReady: false });
  const sc = await waitFor(C, (s) => s.left, 15_000);
  const text = await banner(C);
  record('지문 불일치: incompatible 안내 후 방을 나감', sc.left && /엔진 버전이 방과 다릅니다/.test(text ?? ''), text ?? '배너 없음');
  await ctx.close();
  await old.close();
}

async function tooLargeBase(browser) {
  const small = startServer({ port: 8789, log: () => {}, maxMessageBytes: 2000 });
  await small.ready;
  const ctx = await browser.createBrowserContext();
  const room = `r7-large-${Date.now()}`;
  const D = await openTab(ctx, { collab: 'ws://127.0.0.1:8789', room }, 'D', { waitReady: false });
  const sd = await waitFor(D, (s) => s.left, 20_000);
  const text = await banner(D);
  record('상한: base 가 메시지 상한을 넘으면 시작하지 않고 안내', sd.left && /문서가 커서 공동편집을 시작할 수 없습니다/.test(text ?? ''), text ?? '배너 없음');
  await ctx.close();
  await small.close();
}

async function resyncRecovers(browser) {
  const ctx = await browser.createBrowserContext();
  const room = `r7-resync-${Date.now()}`;
  const E = await openTab(ctx, { collab: COLLAB, room }, 'E');
  const F = await openTab(ctx, { collab: COLLAB, room }, 'F');
  await type(E, 0, 0, 'base text');
  await settled([E, F]);
  // F 의 문서를 기록 밖에서 바꾼다(collab 보조 export 는 기록 훅 밖) → 다음 digest 보고에서 어긋남
  await F.evaluate(() => {
    const d = window.__wasm.doc;
    const other = d.collabExportState();
    d.insertText(0, 0, 0, '!'); // 기록되는 편집(보낼 것)
    d.collabLoadState(other); // 기록되지 않는 되돌림 → F 문서만 '!' 가 빠진다
  });
  await type(E, 0, 0, 'x');
  // S3-2: 서버 정본이 digest 기준 — 어긋난 F 에만 diverged 가 가고 F 만 재동기화한다(E 는 그대로).
  const fState = await waitFor(F, (s) => s.resyncCount > 0 && !s.resyncing && !s.inflight && !s.pending && s.digestSentSeq === s.lastSeq, 25_000);
  await settled([E, F]);
  await sleep(1500);
  const digests = await Promise.all([E, F].map((p) => p.evaluate(() => window.__collab.digest())));
  const after = await Promise.all([E, F].map(status));
  record('재동기화: 어긋남 → 재동기화로 같은 문서', digests[0] === digests[1] && after.every((s) => !s.desynced),
    after.map((s) => `${s.name}: resync ${s.resyncCount} desync ${s.desynced}`).join('; ') + `, digest ${digests.map((d) => d.slice(0, 10)).join(' ')}`);
  record('재동기화: 어긋난 F 만 재동기화, E 는 그대로 (S3-2 정본 기준)', after[1].resyncCount > 0 && after[0].resyncCount === 0,
    after.map((s) => `${s.name}: resync ${s.resyncCount}`).join(', '));
  record('재동기화: 한도(1분 3회) 안', [fState, ...after].every((s) => s.resyncCount <= 3), after.map((s) => s.resyncCount).join(','));
  await ctx.close();
}

const browser = await puppeteer.launch({
  headless: process.env.HEADFUL !== '1',
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-gpu', '--lang=ko-KR'],
});
try {
  for (const step of [swapLeavesRoom, incompatibleNotice, tooLargeBase, resyncRecovers]) {
    try {
      await step(browser);
    } catch (error) {
      record(`${step.name} 실행`, false, error.stack ?? String(error));
    }
  }
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exitCode = failed.length ? 1 : 0;
