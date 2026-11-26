// R8 브라우저 검증 (docs/collab-stage2.md §8 R8). 같은 headless Chrome 의 두 탭이 지연 서버
// (COLLAB_DELAY_MS=300) 에서 응답을 기다리지 않고 번갈아 편집한다. 단계마다 두 탭의 digest 일치,
// desync·재동기화 0, 각자 친 글자가 이어져 있고 캐럿이 자기 글자 뒤인지 본다. 굵게·문단 정렬·표 만들기·
// 붙여넣기가 상대에게 반영되는지도 본다.
//
// 준비: COLLAB_DELAY_MS=300 PORT=8788 node server/server.mjs + (cd upstream/rhwp/rhwp-studio && npx vite) (7700)
// 실행: node collab-client/e2e/r8-concurrent.mjs [--fast=0]
// 환경 변수: STUDIO_URL, COLLAB_URL(기본 ws://127.0.0.1:8788), CHROME_PATH, HEADFUL=1
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const studioDir = path.resolve(here, '../../upstream/rhwp/rhwp-studio');
const puppeteer = createRequire(path.join(studioDir, 'package.json'))('puppeteer-core');

const STUDIO = process.env.STUDIO_URL ?? 'http://127.0.0.1:7700';
const COLLAB = process.env.COLLAB_URL ?? 'ws://127.0.0.1:8788';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FAST = !process.argv.includes('--fast=0');

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openTab(host, room, name) {
  const page = await host.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[collab') || msg.type() === 'error') console.log(`    [${name} console.${msg.type()}] ${text}`);
  });
  page.on('pageerror', (error) => console.log(`    [${name} pageerror] ${error.message}`));
  const url = `${STUDIO}/?collab=${encodeURIComponent(COLLAB)}&room=${encodeURIComponent(room)}&name=${name}${FAST ? '' : '&collabFast=0'}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__collab?.status().ready && window.__inputHandler, { timeout: 90_000 });
  page.cdp = await page.createCDPSession();
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
const caret = (page) => page.evaluate(() => {
  const p = window.__inputHandler.getCursorPosition();
  return { para: p.paragraphIndex, offset: p.charOffset };
});

/** 모든 탭이 같은 seq·대기 상태가 되고 그 seq 의 digest 를 보고할 때까지. `minSeq` 보다 seq 가 커져야 한다. */
let lastSettledSeq = -1;
async function settle(pages, timeoutMs = 30_000, minSeq = lastSettledSeq) {
  const deadline = Date.now() + timeoutMs;
  let last;
  await sleep(400); // 방금 보낸 키 입력이 처리될 시간
  while (Date.now() < deadline) {
    last = await Promise.all(pages.map(status));
    if (last.some((s) => s.desynced || s.left)) return last;
    const seqs = new Set(last.map((s) => s.lastSeq));
    if (seqs.size === 1 && last[0].lastSeq > minSeq && last.every((s) => !s.inflight && !s.pending && !s.resyncing && s.digestSentSeq === s.lastSeq)) {
      await sleep(700); // diverged 방송(지연 300ms)이 도착할 시간
      return Promise.all(pages.map(status));
    }
    await sleep(100);
  }
  throw new Error(`settle 시간 초과: ${JSON.stringify(last.map((s) => ({ n: s.name, seq: s.lastSeq, inflight: s.inflight, pending: s.pending, d: s.digestSentSeq })))}`);
}

/** 단계 판정: digest 일치, desync·재동기화 없음. 문단을 돌려준다. */
async function check(pages, label, { advance = true } = {}) {
  const states = await settle(pages, 30_000, advance ? lastSettledSeq : -1);
  lastSettledSeq = states[0].lastSeq;
  const digests = await Promise.all(pages.map(digest));
  const texts = await Promise.all(pages.map(paragraphs));
  const bad = states.filter((s) => s.desynced || s.left || s.resyncCount > 0);
  const ok = digests.every((d) => d === digests[0]) && bad.length === 0;
  record(`${label}: digest 일치·desync 0`, ok,
    `seq ${states[0].lastSeq}, ${digests.map((d, i) => `${pages[i].tabName}=${d.slice(0, 10)}`).join(' ')}`
    + (bad.length ? `, 문제: ${bad.map((s) => `${s.name}(${s.desyncReason || `resync ${s.resyncCount}`})`).join('; ')}` : '')
    + `, 문단 ${JSON.stringify(texts[0])}`);
  return { texts: texts[0], states, digest: digests[0] };
}

async function caretAt(page, para, offset) {
  await page.bringToFront();
  await page.evaluate((para, offset) => {
    const ih = window.__inputHandler;
    ih.cursor.clearSelection();
    ih.cursor.moveTo({ sectionIndex: 0, paragraphIndex: para, charOffset: offset });
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
/** 탭을 앞으로 가져오되 커서는 그대로(각 탭은 자기 커서를 갖고 있다) */
async function front(page) {
  await page.bringToFront();
  await page.evaluate(() => window.__inputHandler.textarea.focus());
}
async function imeSyllable(page, steps) {
  for (const comp of steps) {
    await page.cdp.send('Input.imeSetComposition', { text: comp, selectionStart: comp.length, selectionEnd: comp.length });
    await sleep(20);
  }
  await page.cdp.send('Input.insertText', { text: steps.at(-1) });
}
const exec = (page, id) => page.evaluate((id) => { window.rhwpStudio.automation.execute(id); window.__inputHandler.textarea.focus(); }, id);
const lenOf = (page, para) => page.evaluate((p) => window.__wasm.getParagraphLength(0, p), para);

async function run(browser) {
  const ctx = await browser.createBrowserContext(); // 자동 저장 초안이 섞이지 않는 새 프로필
  const room = `r8-${FAST ? 'fast' : 'slow'}-${Date.now()}`;
  const A = await openTab(ctx, room, 'A');
  const B = await openTab(ctx, room, 'B');
  const pages = [A, B];
  await check(pages, '입장 직후', { advance: false });

  // 준비: 세 문단
  await caretAt(A, 0, 0);
  await A.keyboard.type('0123456789');
  await A.keyboard.press('Enter');
  await A.keyboard.type('second line');
  await A.keyboard.press('Enter');
  await A.keyboard.type('third line');
  await check(pages, '준비(세 문단)');

  // 1. 같은 문단 영문(A, 앞)·한글 IME(B, 끝) 동시 입력 — 응답을 기다리지 않고 번갈아
  await caretAt(A, 0, 0);
  await caretAt(B, 0, await lenOf(B, 0));
  for (let i = 0; i < 6; i += 1) {
    await front(A);
    await A.keyboard.type('a');
    await front(B);
    await imeSyllable(B, ['ㄱ', '가']);
  }
  let { texts } = await check(pages, '1. 같은 문단 영문·한글 IME 동시 입력');
  let ca = await caret(A);
  let cb = await caret(B);
  record('1. 각자 친 글자가 이어져 있음', texts[0].includes('aaaaaa') && texts[0].includes('가가가가가가'), JSON.stringify(texts[0]));
  record('1. 캐럿이 자기 글자 뒤', ca.para === 0 && ca.offset === texts[0].indexOf('aaaaaa') + 6
    && cb.para === 0 && cb.offset === texts[0].indexOf('가가가가가가') + 6, `A ${JSON.stringify(ca)} B ${JSON.stringify(cb)}`);

  // 2. 한쪽 Enter(A, 문단 1 가운데)와 다른 쪽 입력(B, 문단 1 끝)
  await caretAt(A, 1, 3);
  await caretAt(B, 1, await lenOf(B, 1));
  await front(A);
  await A.keyboard.press('Enter');
  await front(B);
  await B.keyboard.type('xyz');
  ({ texts } = await check(pages, '2. Enter vs 입력'));
  cb = await caret(B);
  record('2. Enter 로 나뉘고 B 의 글자는 뒤 문단 끝에 이어짐', texts[1] === 'sec' && texts[2] === 'ond linexyz', JSON.stringify(texts));
  record('2. B 캐럿이 자기 글자 뒤', cb.para === 2 && cb.offset === texts[2].length, JSON.stringify(cb));

  // 3. 같은 경계 동시 Backspace (둘 다 문단 3 처음)
  const parasBefore = texts.length;
  await caretAt(A, 3, 0);
  await caretAt(B, 3, 0);
  await front(A);
  await A.keyboard.press('Backspace');
  await front(B);
  await B.keyboard.press('Backspace');
  let r = await check(pages, '3. 같은 경계 동시 Backspace');
  record('3. 문단은 한 번만 합쳐짐', r.texts.length === parasBefore - 1, `${parasBefore} → ${r.texts.length}`);
  // 같은 경계의 두 Backspace 는 보정이 한쪽을 흡수한다(§4.4 — 충돌이 아니라 이미 지워진 경계라 취소 알림도 없다)
  record('3. 흡수라서 취소 알림 없음', r.states.every((s) => s.droppedTotal === 0), `droppedTotal ${r.states.map((s) => `${s.name}=${s.droppedTotal}`).join(' ')}`);

  // 4. 한쪽 선택 삭제(A, 문단 0 의 [2,12))와 다른 쪽 그 안 입력(B, 7)
  await selectRange(A, [0, 2], [0, 12]);
  await caretAt(B, 0, 7);
  await front(A);
  await A.keyboard.press('Delete');
  await front(B);
  await B.keyboard.type('IN');
  ({ texts } = await check(pages, '4. 선택 삭제 vs 그 안 입력'));
  record('4. 그 안에 친 글자는 살아남음', texts[0].includes('IN'), JSON.stringify(texts[0]));

  // 5. 굵게·문단 정렬·표 만들기·붙여넣기가 상대에게 반영
  let before = await digest(B);
  await selectRange(A, [1, 0], [1, 2]);
  await exec(A, 'format:bold');
  r = await check(pages, '5a. 굵게');
  const boldB = await B.evaluate(() => JSON.parse(window.__wasm.doc.getCharPropertiesAt(0, 1, 1)).bold);
  record('5a. 굵게가 B 에 반영', boldB === true && r.digest !== before, `B bold=${boldB}`);

  before = r.digest;
  await caretAt(A, 2, 0);
  await exec(A, 'format:align-center');
  r = await check(pages, '5b. 문단 가운데 정렬');
  const alignB = await B.evaluate(() => JSON.parse(window.__wasm.doc.getParaPropertiesAt(0, 2)).alignment);
  record('5b. 정렬이 B 에 반영', r.digest !== before && String(alignB).toLowerCase().includes('center'), `B alignment=${alignB}`);

  before = r.digest;
  await caretAt(A, 0, await lenOf(A, 0));
  await A.evaluate(() => window.rhwpStudio.automation.execute('table:create', undefined, { allowDialog: true }));
  await sleep(300);
  // 표 만들기는 칸 고르기 격자를 띄운다 — 실제 마우스로 2×2 칸을 누른다
  const cellAt = await A.evaluate(() => {
    const c = document.querySelector('[data-row="1"][data-col="1"]');
    if (!c) return null;
    const rect = c.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  const clicked = Boolean(cellAt);
  if (cellAt) {
    await A.mouse.move(cellAt.x, cellAt.y);
    await A.mouse.click(cellAt.x, cellAt.y);
  }
  r = await check(pages, '5c. 표 만들기');
  const tableB = await B.evaluate(() => {
    const d = window.__wasm.doc;
    for (let p = 0; p < d.getParagraphCount(0); p += 1) {
      for (let ci = 0; ci < 3; ci += 1) {
        try { const t = JSON.parse(d.getTableDimensions(0, p, ci)); if (t) return t; } catch { /* 표 아님 */ }
      }
    }
    return null;
  });
  record('5c. 표가 B 에 반영', clicked && r.digest !== before && Boolean(tableB), JSON.stringify(tableB));

  before = r.digest;
  const lastPara = r.texts.length - 1;
  const lastText = r.texts[lastPara];
  await selectRange(A, [lastPara, 0], [lastPara, 3]);
  await A.evaluate(() => window.__inputHandler.textarea.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() })));
  await caretAt(A, lastPara, await lenOf(A, lastPara));
  // clipboardData 없는 paste → studio 내부 클립보드 붙여넣기(pasteInternal, state 기록)
  await A.evaluate(() => window.__inputHandler.textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true })));
  r = await check(pages, '5d. 붙여넣기');
  const pastedB = (await paragraphs(B))[lastPara];
  const expected = lastText + lastText.slice(0, 3);
  record('5d. 붙여넣기가 B 에 반영', r.digest !== before && pastedB === expected, `B ${JSON.stringify(pastedB)}, 기대 ${JSON.stringify(expected)}`);

  const fin = await Promise.all(pages.map(status));
  record('전체: desync·재동기화 0', fin.every((s) => !s.desynced && !s.left && s.resyncCount === 0),
    fin.map((s) => `${s.name}: desync ${s.desynced} resync ${s.resyncCount} 빠른 ${s.fast.fast}/되감기 ${s.fast.slow}`).join('; '));
  await ctx.close();
}

const browser = await puppeteer.launch({
  headless: process.env.HEADFUL !== '1',
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-gpu', '--lang=ko-KR'],
});
try {
  await run(browser);
} catch (error) {
  record('시나리오 실행', false, error.stack ?? String(error));
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과 (빠른 경로 ${FAST ? '켬' : '끔'})`);
process.exitCode = failed.length ? 1 : 0;
