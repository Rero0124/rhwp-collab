// 6단계 S1 브라우저 확인 (docs/collab-stage6.md): 서버가 다시 쓴 state — 지연 서버(300ms)에서 A 가 결과 전송(state)
// 편집(덧말 넣기 — 분류표 state)을 한 직후 계속 입력해도, 서버가 state 를 모델에서 다시 쓴 바이트로 바꿔 돌려준 확정
// (`replaced`) 위에 A 의 미확정 입력이 그대로 다시 얹혀 두 탭이 수렴한다. 매 단계 digest 일치·재동기화 0.
//
// 준비: COLLAB_DELAY_MS=300 PORT=8788 node server/server.mjs (서버가 state 를 다시 쓰는 판) + (cd upstream/rhwp/rhwp-studio && npx vite) (7700)
// 실행: node collab-client/e2e/s1-rewrite.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const studioDir = path.resolve(here, '../../upstream/rhwp/rhwp-studio');
const puppeteer = createRequire(path.join(studioDir, 'package.json'))('puppeteer-core');

const STUDIO = process.env.STUDIO_URL ?? 'http://127.0.0.1:7700';
const COLLAB = process.env.COLLAB_URL ?? 'ws://127.0.0.1:8788';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openTab(browser, room, name) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (error) => console.log(`    [${name} pageerror] ${error.message}`));
  await page.goto(`${STUDIO}/?collab=${encodeURIComponent(COLLAB)}&room=${encodeURIComponent(room)}&name=${name}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__collab?.status().ready && window.__inputHandler, { timeout: 90_000, polling: 250 });
  return page;
}
const status = (page) => page.evaluate(() => window.__collab.status());
const text = (page) => page.evaluate(() => {
  const w = window.__wasm;
  return Array.from({ length: w.getParagraphCount(0) }, (_, i) => w.getTextRange(0, i, 0, w.getParagraphLength(0, i))).join('\n');
});
async function settle(pages) {
  const deadline = Date.now() + 30_000;
  await sleep(400);
  while (Date.now() < deadline) {
    const st = await Promise.all(pages.map(status));
    if (new Set(st.map((s) => s.lastSeq)).size === 1 && st.every((s) => !s.inflight && !s.pending && !s.resyncing)) { await sleep(500); return Promise.all(pages.map(status)); }
    await sleep(150);
  }
  return Promise.all(pages.map(status));
}
async function same(pages) {
  const st = await settle(pages);
  const ds = await Promise.all(pages.map((p) => p.evaluate(() => window.__collab.digest())));
  return { ok: st.every((s) => !s.desynced && !s.left && s.resyncCount === 0) && ds.every((d) => d === ds[0]), st };
}
async function typeAtEnd(page, s) {
  await page.bringToFront();
  await page.evaluate(() => {
    const ih = window.__inputHandler;
    const w = window.__wasm;
    const last = w.getParagraphCount(0) - 1;
    ih.cursor.moveTo({ sectionIndex: 0, paragraphIndex: last, charOffset: w.getParagraphLength(0, last) });
    ih.textarea.focus();
  });
  await page.keyboard.type(s, { delay: 25 });
}

const browser = await puppeteer.launch({ headless: process.env.HEADFUL !== '1', executablePath: CHROME, args: ['--lang=ko-KR'] });
try {
  const room = `s1-${Date.now().toString(36)}`;
  const A = await openTab(browser, room, 'A');
  const B = await openTab(browser, room, 'B');
  await typeAtEnd(A, 'state rewrite test');
  let s = await same([A, B]);
  record('준비: 두 탭 같은 문서', s.ok, JSON.stringify(await text(B)));

  // A: 결과 전송 편집(덧말 넣기 — 공유 문서 객체의 기록 훅을 지난다) 직후, 서버 답(300ms 지연)을 기다리지 않고 계속 입력
  for (let round = 0; round < 3; round += 1) {
    await A.evaluate((r) => {
      window.__wasm.doc.insertRuby(0, 0, 2 + r, JSON.stringify({ mainText: `R${r}`, rubyText: 'ㄱ', below: false, styleId: null }));
    }, round);
    await typeAtEnd(A, ` typed${round}`);
  }
  s = await same([A, B]);
  const [ta, tb] = await Promise.all([text(A), text(B)]);
  const [sa] = s.st;
  record('state 직후 계속 입력해도 수렴(서버가 다시 쓴 확정 위에 미확정이 그대로 얹힘)', s.ok && ta === tb && /typed0.*typed1.*typed2/s.test(ta),
    `replacedAcks ${sa.replacedAcks}, 취소 ${sa.droppedTotal}, A ${JSON.stringify(ta)}`);
  record('서버가 state 를 다시 쓴 확정을 받음(replaced)', sa.replacedAcks >= 1, `replacedAcks ${sa.replacedAcks}`);
  record('A 의 입력이 취소되지 않음', sa.droppedTotal === 0, `취소 ${sa.droppedTotal}`);

  // B 도 state 뒤 계속 입력(다른 쪽에서 같은 경로)
  await B.evaluate(() => { window.__wasm.doc.insertRuby(0, 0, 1, JSON.stringify({ mainText: 'BB', rubyText: 'ㄴ', below: true, styleId: null })); });
  await typeAtEnd(B, ' fromB');
  s = await same([A, B]);
  const final = await text(A);
  record('반대쪽도 수렴, 끝까지 재동기화 0', s.ok && final.endsWith(' fromB'), `A ${JSON.stringify(final)}`);
} catch (error) {
  record('시나리오 실행', false, error.stack ?? String(error));
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exitCode = failed.length ? 1 : 0;
