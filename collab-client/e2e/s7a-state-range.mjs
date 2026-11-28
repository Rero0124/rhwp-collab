// 7단계 A 브라우저 확인 (docs/collab-stage7.md A): 결과 전송(state)에 자동 범위 표시. 같은 headless Chrome 의 두 탭(A, B)이
// 지연 서버(300ms)에서 편집한다. B 가 키보드로 계속 치는 동안 A 가 덧말 넣기(분류표 state — studio 에는 메뉴가 없어 문서
// 핸들로 부른다, 공동편집 엔진이 기록한다)를 한다. A 의 state 가 먼저 가는 경우와 B 의 묶음이 먼저 가는 경우 모두 두 탭의
// digest 일치, 취소·재동기화 0, B 가 친 글자가 모두 남음, A 의 state 에 범위 표시가 붙었음을 본다.
//
// 준비: COLLAB_DELAY_MS=300 PORT=8807 node server/server.mjs + (cd upstream/rhwp/rhwp-studio && npx vite --port 7720 --strictPort)
// 실행: STUDIO_URL=http://127.0.0.1:7720 COLLAB_URL=ws://127.0.0.1:8807 node collab-client/e2e/s7a-state-range.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const studioDir = path.resolve(here, '../../upstream/rhwp/rhwp-studio');
const puppeteer = createRequire(path.join(studioDir, 'package.json'))('puppeteer-core');

const STUDIO = process.env.STUDIO_URL ?? 'http://127.0.0.1:7720';
const COLLAB = process.env.COLLAB_URL ?? 'ws://127.0.0.1:8807';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openTab(host, room, name) {
  const page = await host.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (error) => console.log(`    [${name} pageerror] ${error.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') console.log(`    [${name} console.error] ${msg.text()}`); });
  await page.goto(`${STUDIO}/?collab=${encodeURIComponent(COLLAB)}&room=${encodeURIComponent(room)}&name=${name}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__collab?.status().ready && window.__inputHandler, { timeout: 90_000 });
  return page;
}
const status = (page) => page.evaluate(() => window.__collab.status());
const digest = (page) => page.evaluate(() => window.__collab.digest());
const paragraphs = (page) => page.evaluate(() => {
  const w = window.__wasm;
  const out = [];
  for (let i = 0; i < w.getParagraphCount(0); i += 1) out.push(w.getTextRange(0, i, 0, w.getParagraphLength(0, i)));
  return out;
});

let lastSeq = -1;
async function settle(pages, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  await sleep(400);
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
  return last;
}
async function same(pages) {
  const st = await settle(pages);
  const ds = await Promise.all(pages.map(digest));
  return { ok: st.every((s) => !s.desynced && !s.left && s.resyncCount === 0) && ds.every((d) => d === ds[0]), st, ds };
}
async function caretAt(page, para, offset) {
  await page.bringToFront();
  await page.evaluate((p, o) => {
    const ih = window.__inputHandler;
    ih.cursor.clearSelection();
    ih.cursor.moveTo({ sectionIndex: 0, paragraphIndex: p, charOffset: o });
    ih.textarea.focus();
  }, para, offset);
}
const typeAtEnd = async (page, para, text, delay = 20) => {
  const len = await page.evaluate((p) => window.__wasm.getParagraphLength(0, p), para);
  await caretAt(page, para, len);
  await page.keyboard.type(text, { delay });
};
/** 덧말 넣기(문단 맨 앞) — 문서 핸들로 부르면 공동편집 엔진이 state 로 기록한다 */
const ruby = (page, para) => page.evaluate((p) => {
  window.__wasm.borrowDocumentHandle().insertRuby(0, p, 0, JSON.stringify({ mainText: '漢', rubyText: '한', below: false, styleId: null }));
}, para);
const counts = (page) => page.evaluate(() => {
  const h = window.__wasm.borrowDocumentHandle();
  return [h.collabSnapshotCount(), h.collabUndoRecipeCount()];
});

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
try {
  const room = `s7a-${Date.now().toString(36)}`;
  const A = await openTab(browser, room, 'A');
  const B = await openTab(browser, room, 'B');
  const tabs = [A, B];
  for (let i = 0; i < 6; i += 1) {
    await typeAtEnd(A, i, `문단${i}`);
    if (i < 5) await A.keyboard.press('Enter');
  }
  let s = await same(tabs);
  record('준비: 문단 6 개', s.ok && (await paragraphs(B)).length === 6, `${(await paragraphs(B)).length} 문단`);

  // ① A 의 state 가 먼저: B 가 문단 4 끝에서 치기 시작한 뒤 A 가 문단 1 에 덧말 → B 는 미확정 입력을 든 채 범위 표시 state 를 받는다
  const typed1 = 'BBBBBBBBBBBBBBBBBBBBBBBB';
  const h0 = (await status(A)).stateHints.hinted;
  const typing1 = typeAtEnd(B, 4, typed1, 40);
  await sleep(300);
  await ruby(A, 1);
  await typing1;
  s = await same(tabs);
  let ps = await paragraphs(B);
  let st = await Promise.all(tabs.map(status));
  record('① B 가 치는 중 A 덧말(A 먼저): 수렴, B 의 글자가 모두 남고 취소·재동기화 0, A 의 state 에 범위 표시',
    s.ok && ps[4] === `문단4${typed1}` && st.every((x) => x.droppedTotal === 0) && st[0].stateHints.hinted === h0 + 1,
    `문단4 ${JSON.stringify(ps[4])}, 취소 ${st.map((x) => x.droppedTotal)}, 표시 ${st[0].stateHints.hinted - h0} ${JSON.stringify(st[0].stateHints.reasons)}`);

  // ② B 의 묶음이 먼저: B 가 문단 0 에서 Enter + 글자를 치고 곧바로(서버 지연 안) A 가 문단 3 에 덧말 → A 의 state 는 B 의
  // Enter 만큼 옮긴 자리에서 다시 만들어진다
  const h1 = (await status(A)).stateHints.hinted;
  await caretAt(B, 0, 2);
  await B.keyboard.press('Enter');
  await B.keyboard.type('CC', { delay: 20 });
  await ruby(A, 3);
  s = await same(tabs);
  ps = await paragraphs(A);
  st = await Promise.all(tabs.map(status));
  record('② B 의 Enter 가 먼저, 그 사이 A 덧말: 수렴, 취소·재동기화 0, 문단 7 개, B 의 글자 남음',
    s.ok && ps.length === 7 && ps[1].startsWith('CC') && st.every((x) => x.droppedTotal === 0) && st[0].stateHints.hinted === h1 + 1,
    `${ps.length} 문단 ${JSON.stringify(ps.slice(0, 2))}, 취소 ${st.map((x) => x.droppedTotal)}, 표시 ${st[0].stateHints.hinted - h1}`);

  // ③ 연달아: B 가 문단 6 에서 치는 동안 A 가 덧말을 두 번(문단 2, 문단 4) — 보내지 않은 범위 state 가 하나로 합쳐질 수 있다
  const typed3 = 'DDDDDDDDDDDDDDDD';
  const typing3 = typeAtEnd(B, 6, typed3, 40);
  await sleep(200);
  await ruby(A, 2);
  await ruby(A, 4);
  await typing3;
  s = await same(tabs);
  ps = await paragraphs(B);
  st = await Promise.all(tabs.map(status));
  const left = await Promise.all(tabs.map(counts));
  record('③ B 가 치는 중 A 덧말 두 번: 수렴, B 의 글자 남음, 취소·재동기화 0, 남은 스냅샷·재료 0',
    s.ok && ps[6] === `문단5${typed3}` && st.every((x) => x.droppedTotal === 0) && left.every(([snap, rec]) => snap === 0 && rec === 0),
    `문단6 ${JSON.stringify(ps[6])}, 취소 ${st.map((x) => x.droppedTotal)}, 남은 [스냅샷, 재료] ${JSON.stringify(left)}, A 표시 ${JSON.stringify(st[0].stateHints)}`);
} catch (error) {
  record('시나리오 실행', false, error.stack ?? String(error));
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exit(failed.length ? 1 : 0);
