// 4단계 U1 브라우저 확인 (docs/collab-stage4.md): 공동편집 중 되돌리기 — 내 편집만, 남이 같은 자리를 고쳤으면 막힘.
// 같은 headless Chrome 의 두 탭(A, B)이 지연 서버(300ms)에서 편집하고 A 가 studio 의 되돌리기 명령(edit:undo)을
// 누른다. 단계마다 두 탭의 digest 일치·desync·재동기화 0 과, 되돌린 결과(내 편집만 빠짐) 또는 막힘(알림·문서
// 그대로)을 본다. U3 의 전체 시나리오 중 기본형(①~④, ⑪·⑫)만.
//
// 준비: COLLAB_DELAY_MS=300 PORT=8788 node server/server.mjs + (cd upstream/rhwp/rhwp-studio && npx vite) (7700)
// 실행: node collab-client/e2e/u1-undo.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const studioDir = path.resolve(here, '../../upstream/rhwp/rhwp-studio');
const puppeteer = createRequire(path.join(studioDir, 'package.json'))('puppeteer-core');

const STUDIO = process.env.STUDIO_URL ?? 'http://127.0.0.1:7700';
const COLLAB = process.env.COLLAB_URL ?? 'ws://127.0.0.1:8788';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BLOCKED = '다른 사람이 이후에 고친 부분이라 되돌릴 수 없습니다';

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
  page.tabName = name;
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
const notices = (page) => page.evaluate(() => [...document.querySelectorAll('[data-collab="undo"]')].map((e) => e.textContent));
const bold = (page, para, off) => page.evaluate((p, o) => window.__wasm.getCharPropertiesAt(0, p, o).bold === true, para, off);

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
async function same(pages, { advance = true } = {}) {
  if (!advance) lastSeq -= 1; // 막힌 되돌리기는 아무것도 보내지 않는다 — 지금 seq 에서 대기 상태만 확인
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
async function selectRange(page, a, b) {
  await page.bringToFront();
  await page.evaluate((a, b) => {
    const ih = window.__inputHandler;
    const pos = ([p, o]) => ({ sectionIndex: 0, paragraphIndex: p, charOffset: o });
    if (!ih.cursor.selectRange(pos(a), pos(b))) throw new Error('선택 실패');
    ih.textarea.focus();
  }, a, b);
}
const exec = (page, id) => page.evaluate((id) => { window.rhwpStudio.automation.execute(id); window.__inputHandler.textarea.focus(); }, id);
const typeAtEnd = async (page, para, text) => {
  const len = await page.evaluate((p) => window.__wasm.getParagraphLength(0, p), para);
  await caretAt(page, para, len);
  await page.keyboard.type(text, { delay: 20 });
};

const browser = await puppeteer.launch({ headless: process.env.HEADFUL !== '1', executablePath: CHROME, args: ['--lang=ko-KR'] });
try {
  const room = `u1-${Date.now()}`;
  const A = await openTab(browser, room, 'A');
  const B = await openTab(browser, room, 'B');
  const pages = [A, B];
  // 준비(B 가 친다 — A 의 되돌리기 스택은 비어 있다): 네 문단
  await caretAt(B, 0, 0);
  await B.keyboard.type('first line', { delay: 10 });
  for (const t of ['second line', 'third line', 'fourth line']) { await B.keyboard.press('Enter'); await B.keyboard.type(t, { delay: 10 }); }
  let s = await same(pages);
  record('준비: 네 문단', s.ok, JSON.stringify(await paragraphs(A)));

  // ① A 문단 0 입력, B 문단 2 입력, A 되돌리기 → A 글자만 사라짐
  await typeAtEnd(A, 0, ' AAA');
  await same(pages);
  await typeAtEnd(B, 2, ' BBB');
  await same(pages);
  await A.bringToFront();
  await exec(A, 'edit:undo');
  s = await same(pages);
  let texts = await paragraphs(B);
  record('① 내 글자만 사라짐', s.ok && texts[0] === 'first line' && texts[2] === 'third line BBB', JSON.stringify(texts));

  // ② A 문단 1 입력 뒤 B 가 같은 문단 편집 → A 되돌리기 막힘·알림·문서 그대로
  await typeAtEnd(A, 1, ' XYZ');
  await same(pages);
  await caretAt(B, 1, 0);
  await B.keyboard.type('Q', { delay: 20 });
  await same(pages);
  const before = await paragraphs(A);
  await A.bringToFront();
  await exec(A, 'edit:undo');
  await sleep(300);
  const n2 = await notices(A);
  s = await same(pages, { advance: false });
  const after = await paragraphs(A);
  record('② 같은 문단 → 막힘·알림·문서 그대로', s.ok && JSON.stringify(after) === JSON.stringify(before) && n2.includes(BLOCKED), `알림 ${JSON.stringify(n2)} 문단 ${JSON.stringify(after)}`);

  // ③ A 굵게(문단 2 일부), B 다른 문단 입력 → A 되돌리기로 굵게 해제
  await selectRange(A, [2, 0], [2, 5]);
  await exec(A, 'format:bold');
  await same(pages);
  const boldOn = await bold(B, 2, 1);
  await typeAtEnd(B, 3, ' B3');
  await same(pages);
  await A.bringToFront();
  await exec(A, 'edit:undo');
  s = await same(pages);
  record('③ 굵게 되돌리기(남은 다른 문단 편집)', s.ok && boldOn && !(await bold(A, 2, 1)) && !(await bold(B, 2, 1)), `굵게였음 ${boldOn}`);

  // ④ A Enter(문단 0 가운데), B 다른 문단 편집 → A 되돌리기로 합쳐짐
  await caretAt(A, 0, 5);
  await A.keyboard.press('Enter');
  await same(pages);
  await typeAtEnd(B, 4, ' B4'); // A 의 Enter 로 문단 4 = 원래 문단 3
  await same(pages);
  await A.bringToFront();
  await exec(A, 'edit:undo');
  s = await same(pages);
  texts = await paragraphs(B);
  record('④ Enter 되돌리기로 합쳐짐', s.ok && texts.length === 4 && texts[0] === 'first line' && texts[3].endsWith(' B4'), JSON.stringify(texts));

  // ⑪ A 본문 선택 삭제(문단 1 끝 ~ 문단 2 가운데), B 같은 구역 다른 문단 입력 → A 되돌리기 허용, 원래 내용
  const beforeDel = await paragraphs(A);
  await selectRange(A, [1, 6], [2, 4]);
  await A.keyboard.press('Delete');
  await same(pages);
  await typeAtEnd(B, 0, ' B0');
  await same(pages);
  await A.bringToFront();
  await exec(A, 'edit:undo');
  s = await same(pages);
  texts = await paragraphs(B);
  record('⑪ 선택 삭제 되돌리기(같은 구역 다른 문단 편집 뒤)', s.ok && texts[1] === beforeDel[1] && texts[2] === beforeDel[2] && texts[0].endsWith(' B0'), JSON.stringify(texts));

  // ⑫ ⑪에서 B 가 A 보다 앞 문단에서 Enter → A 되돌리기 막힘
  await selectRange(A, [2, 2], [3, 3]);
  await A.keyboard.press('Delete');
  await same(pages);
  await caretAt(B, 0, 2);
  await B.keyboard.press('Enter');
  await same(pages);
  const before12 = await paragraphs(A);
  await A.bringToFront();
  await exec(A, 'edit:undo');
  await sleep(300);
  const n12 = await notices(A);
  s = await same(pages, { advance: false });
  const after12 = await paragraphs(A);
  record('⑫ 앞 문단 Enter 뒤 선택 삭제 되돌리기 막힘', s.ok && JSON.stringify(after12) === JSON.stringify(before12) && n12.includes(BLOCKED), `알림 ${JSON.stringify(n12)} 문단 ${JSON.stringify(after12)}`);

  const final = await Promise.all(pages.map(status));
  record('끝까지 어긋남·재동기화 없음', final.every((st) => !st.desynced && !st.left && st.resyncCount === 0), final.map((st) => `${st.name}: resync ${st.resyncCount}`).join(', '));
} catch (error) {
  record('시나리오 실행', false, error.stack ?? String(error));
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exitCode = failed.length ? 1 : 0;
