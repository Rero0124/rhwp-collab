// R10 브라우저 검증 (docs/collab-stage2.md §8 R10): 다른 사람 커서.
// 두 탭에서 A 의 캐럿이 B 의 겹침 층에 이름표 달린 막대로 보이는지, 그 자리가 B 의 studio 캐럿을 같은 위치에
// 놓았을 때와 같은지, B 의 편집·줌 뒤에도 따라오는지, A 가 나가면 사라지는지 본다.
//
// 준비: node server/server.mjs (8787) + (cd upstream/rhwp/rhwp-studio && npx vite) (7700)
// 실행: node collab-client/e2e/r10-cursors.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const studioDir = path.resolve(here, '../../upstream/rhwp/rhwp-studio');
const puppeteer = createRequire(path.join(studioDir, 'package.json'))('puppeteer-core');
const STUDIO = process.env.STUDIO_URL ?? 'http://127.0.0.1:7700';
const COLLAB = process.env.COLLAB_URL ?? 'ws://127.0.0.1:8787';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openTab(ctx, room, name) {
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => console.log(`    [${name} pageerror] ${e.message}`));
  await page.goto(`${STUDIO}/?collab=${encodeURIComponent(COLLAB)}&room=${room}&name=${name}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__collab?.status().ready && window.__inputHandler, { timeout: 90_000 });
  return page;
}
const caretAt = async (page, para, offset) => {
  await page.bringToFront();
  await page.evaluate((p, o) => {
    const ih = window.__inputHandler;
    ih.cursor.clearSelection();
    ih.cursor.moveTo({ sectionIndex: 0, paragraphIndex: p, charOffset: o });
    ih.textarea.focus();
  }, para, offset);
};
/** 겹침 층의 다른 사람 커서 막대 */
const cursorEl = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-plugin-overlay] [data-plugin-id="collab"] [data-collab="cursor"]');
  if (!el) return null;
  return { name: el.textContent, left: parseFloat(el.style.left), top: parseFloat(el.style.top), height: parseFloat(el.style.height) };
});
/** 이 탭의 studio 캐럿 막대 (캐럿은 다음 그리기 때 옮겨지므로 잠깐 기다린 뒤 읽는다) */
const ownCaret = async (page) => { await sleep(250); return page.evaluate(() => {
  const el = document.querySelector('#scroll-content > .caret');
  return el ? { left: parseFloat(el.style.left), top: parseFloat(el.style.top), height: parseFloat(el.style.height) } : null;
}); };
/** 비교용: B 의 studio 캐럿을 화면 갱신까지 하는 경로(placeCaret — host.setCaret 이 쓰는 것)로 놓는다 */
const placeOwn = async (page, para, offset) => {
  await page.bringToFront();
  await page.evaluate((p, o) => window.__inputHandler.placeCaret({ sectionIndex: 0, paragraphIndex: p, charOffset: o }), para, offset);
};
const near = (a, b) => a && b && Math.abs(a.left - b.left) < 0.6 && Math.abs(a.top - b.top) < 0.6 && Math.abs(a.height - b.height) < 0.6;
const waitFor = async (page, fn, ms = 5000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > deadline) return v;
    await sleep(100);
  }
};

const browser = await puppeteer.launch({ headless: process.env.HEADFUL !== '1', executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu', '--lang=ko-KR'] });
try {
  const ctx = await browser.createBrowserContext();
  const room = `r10-${Date.now()}`;
  const A = await openTab(ctx, room, 'A');
  const B = await openTab(ctx, room, 'B');
  await caretAt(A, 0, 0);
  await A.keyboard.type('Hello world');
  await A.keyboard.press('Enter');
  await A.keyboard.type('second line');
  await sleep(800);

  // 1. A 의 캐럿이 B 에 보이고, B 가 같은 자리에 자기 캐럿을 놓았을 때와 같은 위치
  await caretAt(A, 0, 5);
  const seen = await waitFor(B, async () => { const s = await B.evaluate(() => window.__collab.status().cursors); return s.find((c) => c.name === 'A' && c.caret?.offset === 5) ? s : null; });
  record('1. A 의 캐럿(텍스트 좌표)이 B 에 전달', Boolean(seen), JSON.stringify(seen));
  let el = await waitFor(B, () => cursorEl(B));
  await placeOwn(B, 0, 5);
  let own = await ownCaret(B);
  record('1. B 의 겹침 층에 이름표 달린 막대, studio 캐럿과 같은 자리', el?.name === 'A' && near(el, own), `막대 ${JSON.stringify(el)} 캐럿 ${JSON.stringify(own)}`);

  // 2. B 가 그 앞에 글자를 넣으면 A 의 막대가 따라 밀린다(지도로 옮김)
  await caretAt(B, 0, 0);
  await B.keyboard.type('XYZ');
  await sleep(500);
  const moved = await B.evaluate(() => window.__collab.status().cursors.find((c) => c.name === 'A')?.caret);
  el = await cursorEl(B);
  await placeOwn(B, 0, 8);
  own = await ownCaret(B);
  record('2. B 의 앞쪽 입력만큼 A 의 커서가 밀림(5 → 8), 막대도 그 자리', moved?.offset === 8 && near(el, own), `caret ${JSON.stringify(moved)} 막대 ${JSON.stringify(el)} 캐럿 ${JSON.stringify(own)}`);

  // 3. 줌을 바꾸면(view-changed) 다시 계산
  const before = await cursorEl(B);
  await B.evaluate(() => window.rhwpStudio.automation.execute('view:zoom-in'));
  await sleep(600);
  el = await cursorEl(B);
  await placeOwn(B, 0, 8);
  own = await ownCaret(B);
  record('3. 줌 뒤 위치를 다시 계산(studio 캐럿과 같은 자리)', before && el && (el.left !== before.left || el.height !== before.height) && near(el, own), `줌 전 ${JSON.stringify(before)} 뒤 ${JSON.stringify(el)} 캐럿 ${JSON.stringify(own)}`);

  // 4. 둘째 문단으로 옮기면 따라간다
  await caretAt(A, 1, 3);
  const second = await waitFor(B, async () => { const c = await B.evaluate(() => window.__collab.status().cursors.find((x) => x.name === 'A')?.caret); return c?.para === 1 ? c : null; });
  el = await cursorEl(B);
  await placeOwn(B, 1, 3);
  own = await ownCaret(B);
  record('4. 다른 문단으로 옮긴 캐럿도 같은 자리', Boolean(second) && near(el, own), `caret ${JSON.stringify(second)} 막대 ${JSON.stringify(el)} 캐럿 ${JSON.stringify(own)}`);

  // 5. A 가 나가면 사라진다
  await A.close();
  const gone = await waitFor(B, async () => (await cursorEl(B)) === null && (await B.evaluate(() => window.__collab.status().cursors.length)) === 0);
  record('5. A 가 나가면 막대·커서 정보가 사라짐', Boolean(gone));
  await ctx.close();
} catch (error) {
  record('시나리오 실행', false, error.stack ?? String(error));
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exitCode = failed.length ? 1 : 0;
