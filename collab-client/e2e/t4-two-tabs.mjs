// T4 브라우저 검증 (docs/collab-design.md §7 T4, 2단계 회귀는 docs/collab-stage2.md §8 R8). 같은 headless Chrome 의 두 탭이 한 방에서 번갈아
// 편집하고, 단계마다 두 탭의 모델 digest(1차 기준)와 캐럿을 맞춘 exportHwp 바이트(보조)를 비교한다.
//
// 준비: node server/server.mjs (8787) + (cd upstream/rhwp/rhwp-studio && npx vite) (7700)
// 실행: node collab-client/e2e/t4-two-tabs.mjs [--phase=before|after|t8]
//   before: 저장 시점 캐럿 기록이 digest 를 흔드는지(수정 전 재현)만 본다
//   after : 전체 시나리오 (기본)
//   t8    : 로컬 초안·복구 (§6.9) — 같은 프로필에서 공동편집·일반 탭을 오가며 확인
// 환경 변수: STUDIO_URL, COLLAB_URL, CHROME_PATH, HEADFUL=1
//
// 편집은 실제 키 입력·IME(CDP Input.imeSetComposition)으로 보낸다. 커서 위치 지정만 studio 의
// 개발용 전역(window.__inputHandler.cursor)을 쓴다 — upstream e2e 와 같은 방식이다.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const studioDir = path.resolve(here, '../../upstream/rhwp/rhwp-studio');
const puppeteer = createRequire(path.join(studioDir, 'package.json'))('puppeteer-core');

const STUDIO = process.env.STUDIO_URL ?? 'http://127.0.0.1:7700';
const COLLAB = process.env.COLLAB_URL ?? 'ws://127.0.0.1:8787';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PHASE = (process.argv.find((a) => a.startsWith('--phase=')) ?? '--phase=after').split('=')[1];
/** studio 자동 저장의 idle 지연(10초) + 여유 */
const AUTOSAVE_WAIT_MS = 13_000;

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 상태 표시줄 문구 변화와 플러그인 안내 삽입 횟수를 기록하는 관찰자 (페이지 시작 전에 심는다) */
async function installMonitors(page) {
  await page.evaluateOnNewDocument(() => {
    window.__t8 = { sb: [], notices: 0 };
    const start = () => new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && n.matches('[data-collab="notice"]')) window.__t8.notices += 1;
        }
      }
      const text = document.getElementById('sb-message')?.textContent ?? '';
      if (text && window.__t8.sb.at(-1) !== text) window.__t8.sb.push(text);
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
  });
}

/** studio 자신의 저장소 모듈로 자동 저장 초안 목록을 읽는다(개발 서버가 같은 모듈 인스턴스를 준다). */
const listDrafts = (page) => page.evaluate(async () => {
  const store = await import('/src/recovery/autosave-store.ts');
  return (await store.listAutosaveDrafts()).map((d) => ({ id: d.id, fileName: d.fileName, byteLength: d.byteLength }));
});
const recoveryModal = (page) => page.evaluate(() => [...document.querySelectorAll('.modal-overlay')]
  .map((e) => e.textContent.replace(/\s+/g, ' ').trim())
  .find((t) => t.includes('문서 복구')) ?? null);

/** `host` 는 브라우저 또는 브라우저 컨텍스트(newPage 가 있는 것) */
async function openTab(host, room, name) {
  const page = await host.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await installMonitors(page);
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[collab') || msg.type() === 'error') console.log(`    [${name} console.${msg.type()}] ${text}`);
  });
  page.on('pageerror', (error) => console.log(`    [${name} pageerror] ${error.message}`));
  const url = `${STUDIO}/?collab=${encodeURIComponent(COLLAB)}&room=${encodeURIComponent(room)}&name=${name}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // 공유 문서 열기는 suppressDialogs 로 "로컬 글꼴 감지" 확인 창을 띄우지 않아야 한다(§6.2).
  // 뜨면 FAIL 로 기록하고, 시나리오가 멈추지 않게 감지를 허용하지 않는 쪽("대체 글꼴로 보기")으로 닫는다.
  const deadline = Date.now() + 90_000;
  let dialogSeen = false;
  for (;;) {
    const state = await page.evaluate(() => {
      const fallback = [...document.querySelectorAll('.modal-overlay button')]
        .find((b) => b.textContent.trim() === '대체 글꼴로 보기');
      if (fallback) { fallback.click(); return 'dialog'; }
      return window.__collab?.status().ready && window.__inputHandler ? 'ready' : 'wait';
    });
    if (state === 'dialog') dialogSeen = true;
    if (state === 'ready') break;
    if (Date.now() > deadline) throw new Error(`${name}: 90초 안에 준비되지 않음`);
    await sleep(200);
  }
  record(`${name} 입장: 로컬 글꼴 확인 창 없이 문서 열림`, !dialogSeen, dialogSeen ? '창이 떠서 닫음' : '');
  const recovery = await page.evaluate(() => [...document.querySelectorAll('.modal-overlay')]
    .some((e) => e.textContent.includes('문서 복구')));
  if (recovery) console.log(`    [${name}] 주의: "문서 복구" 모달이 떠 있음 (같은 프로필의 자동 저장 초안)`);
  page.cdp = await page.createCDPSession();
  page.tabName = name;
  page.room = room;
  return page;
}

const status = (page) => page.evaluate(() => window.__collab.status());

/** 방마다 마지막으로 확인한 seq. 편집 단계는 이보다 seq 가 커져야 반영된 것으로 본다. */
const settledSeq = new Map();

/**
 * 모든 탭이 같은 seq 에서 대기 상태가 되고 그 seq 의 digest 를 보고할 때까지 기다린다.
 * `minSeq` 를 주면 그보다 큰 seq 까지 기다린다 — 키 입력이 문서에 반영되기 전의 대기 상태를
 * 수렴으로 오인하지 않게 한다.
 */
async function settle(pages, timeoutMs = 20_000, minSeq = -1) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await Promise.all(pages.map(status));
    if (last.some((s) => s.desynced)) return last;
    const seqs = new Set(last.map((s) => s.lastSeq));
    if (seqs.size === 1 && last[0].lastSeq > minSeq
      && last.every((s) => !s.inflight && s.digestSentSeq === s.lastSeq)) {
      await sleep(300); // diverged 방송이 도착할 시간
      return Promise.all(pages.map(status));
    }
    await sleep(100);
  }
  const diag = await Promise.all(pages.map((p) => p.evaluate(() => ({
    hasFocus: document.hasFocus(), visibility: document.visibilityState,
    active: document.activeElement?.tagName,
    pos: window.__inputHandler.getCursorPosition(),
    text: window.__wasm.getTextRange(0, 0, 0, window.__wasm.getParagraphLength(0, 0)),
  }))));
  throw new Error(`settle 시간 초과: ${JSON.stringify(last.map((s) => ({ name: s.name, lastSeq: s.lastSeq, sent: s.sentEntries })))} 진단 ${JSON.stringify(diag)}`);
}

/**
 * 1차 기준: 두 탭의 지금 digest, 그리고 desynced/diverged 없음.
 * `advance` 면 직전 확인보다 seq 가 커질 때까지 기다린다(편집 단계).
 */
async function checkConverged(pages, label, { advance = true } = {}) {
  const room = pages[0].room;
  const minSeq = advance ? (settledSeq.get(room) ?? -1) : -1;
  const states = await settle(pages, 20_000, minSeq);
  settledSeq.set(room, states[0].lastSeq);
  const desynced = states.filter((s) => s.desynced);
  const digests = await Promise.all(pages.map((p) => p.evaluate(() => window.__collab.digest())));
  const texts = await Promise.all(pages.map(paragraphs));
  const same = digests.every((d) => d === digests[0]) && !desynced.length;
  record(`${label}: digest 일치`, same,
    `seq ${states[0].lastSeq}, ${digests.map((d, i) => `${pages[i].tabName}=${d.slice(0, 12)}`).join(' ')}`
    + (desynced.length ? `, desynced: ${desynced.map((s) => `${s.name}(${s.desyncReason})`).join('; ')}` : '')
    + `, 문단 ${JSON.stringify(texts[0])}`);
  if (texts.some((t) => JSON.stringify(t) !== JSON.stringify(texts[0]))) {
    record(`${label}: 문단 텍스트 일치`, false, JSON.stringify(texts));
  }
  return same;
}

/** 보조 기준: raw 핸들에서 캐럿을 같은 값으로 맞춘 뒤 exportHwp 바이트의 SHA-256 (검증용 콘솔 조작) */
async function checkBytes(pages, label) {
  const hashes = await Promise.all(pages.map((p) => p.evaluate(async () => {
    const d = window.__wasm.doc;
    d.setCaretPosition(0, 0, 0);
    const bytes = d.exportHwp();
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  })));
  record(`${label}: 캐럿 맞춘 exportHwp SHA-256 일치`, hashes.every((h) => h === hashes[0]),
    hashes.map((h, i) => `${pages[i].tabName}=${h.slice(0, 12)}`).join(' '));
}

const paragraphs = (page) => page.evaluate(() => {
  const w = window.__wasm;
  const n = w.getParagraphCount(0);
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(w.getTextRange(0, i, 0, w.getParagraphLength(0, i)));
  return out;
});

/** 탭을 앞으로 가져오고(사용자의 탭 클릭) 커서를 옮겨 입력 textarea 에 포커스 (문서는 바꾸지 않는다) */
async function caretAt(page, para, offset) {
  await page.bringToFront();
  await page.evaluate((para, offset) => {
    const ih = window.__inputHandler;
    ih.cursor.moveTo({ sectionIndex: 0, paragraphIndex: para, charOffset: offset });
    ih.textarea.focus();
  }, para, offset);
}
async function caretAtEnd(page) {
  const [para, offset] = await page.evaluate(() => {
    const w = window.__wasm;
    const last = w.getParagraphCount(0) - 1;
    return [last, w.getParagraphLength(0, last)];
  });
  await caretAt(page, para, offset);
  return [para, offset];
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

/** 한글 IME 조합: 자모 단계별로 조합 문자열을 바꾸고 마지막에 확정한다. */
async function imeType(page, steps) {
  for (const syllable of steps) {
    for (const comp of syllable) {
      await page.cdp.send('Input.imeSetComposition', { text: comp, selectionStart: comp.length, selectionEnd: comp.length });
      await sleep(30);
    }
    await page.cdp.send('Input.insertText', { text: syllable.at(-1) });
    await sleep(50);
  }
}

async function lastOpsOf(page) {
  return page.evaluate(() => window.__collab.status().sentEntries);
}

async function runBefore(browser) {
  const room = `t4-before-${Date.now()}`;
  const A = await openTab(browser, room, 'A');
  const B = await openTab(browser, room, 'B');
  await checkConverged([A, B], '수정 전: 입장 직후', { advance: false });

  await caretAt(A, 0, 0);
  await A.keyboard.type('caret');
  await checkConverged([A, B], '수정 전: A 입력');

  const before = await Promise.all([A, B].map((p) => p.evaluate(() => window.__collab.digest())));
  console.log(`  자동 저장 대기 ${AUTOSAVE_WAIT_MS / 1000}s (편집 없음)…`);
  await sleep(AUTOSAVE_WAIT_MS);
  const after = await Promise.all([A, B].map((p) => p.evaluate(() => window.__collab.digest())));
  const carets = await Promise.all([A, B].map((p) => p.evaluate(() => JSON.parse(window.__wasm.doc.getCaretPosition()))));
  // 편집이 기록한 캐럿과 화면 캐럿이 같은 탭(A)은 그대로이고, 다른 탭(B)만 바뀔 수 있다.
  record('수정 전: 편집 없이 어느 탭이든 digest 가 바뀌는가', before.some((d, i) => d !== after[i]),
    `A ${before[0].slice(0, 12)}→${after[0].slice(0, 12)}, B ${before[1].slice(0, 12)}→${after[1].slice(0, 12)}, `
    + `저장된 캐럿 A=${JSON.stringify(carets[0])} B=${JSON.stringify(carets[1])}`);

  await caretAtEnd(A);
  await A.keyboard.press('Enter');
  const ok = await checkConverged([A, B], '수정 전: 자동 저장 뒤 A Enter');
  record('수정 전: 캐럿 기록이 diverged 를 일으키는가 (재현)', !ok, ok ? '재현 안 됨' : '재현됨');
  await A.close(); await B.close();
}

async function runAfter(browser) {
  const room = `t4-${Date.now()}`;
  const A = await openTab(browser, room, 'A');
  const B = await openTab(browser, room, 'B');
  const pages = [A, B];
  await checkConverged(pages, '입장 직후 (base 재열기 vs base 열기)', { advance: false });

  // 1. 번갈아 일반 입력
  await caretAt(A, 0, 0);
  await A.keyboard.type('Hello');
  await checkConverged(pages, 'A 영문 입력');
  await caretAtEnd(B);
  await B.keyboard.type(' world');
  await checkConverged(pages, 'B 이어 입력');

  // 2. Enter (splitParagraph)
  await caretAt(A, 0, 5);
  await A.keyboard.press('Enter');
  await checkConverged(pages, 'A Enter (문단 나눔)');

  // 3. 한글 IME (B)
  await caretAtEnd(B);
  await imeType(B, [['ㅎ', '하', '한'], ['ㄱ', '그', '글']]);
  await B.keyboard.type(' ');
  await imeType(B, [['ㅇ', '이', '입'], ['ㄹ', '려', '력']]);
  await checkConverged(pages, 'B 한글 IME 입력');

  // 4. Backspace (글자 삭제, A)
  await caretAtEnd(A);
  await A.keyboard.press('Backspace');
  await checkConverged(pages, 'A Backspace (글자 삭제)');

  // 5. 문단 처음 Backspace (mergeParagraph, B)
  await caretAt(B, 1, 0);
  await B.keyboard.press('Backspace');
  await checkConverged(pages, 'B 문단 처음 Backspace (문단 합침)');

  // 6. 여러 문단에 걸친 선택 삭제 (deleteRange, A)
  await caretAtEnd(A);
  await A.keyboard.press('Enter');
  await A.keyboard.type('third line');
  await A.keyboard.press('Enter');
  await A.keyboard.type('fourth line');
  await checkConverged(pages, 'A 문단 두 개 추가');
  await selectRange(A, [0, 3], [2, 6]);
  const sentBefore = await lastOpsOf(A);
  await A.keyboard.press('Delete');
  await checkConverged(pages, 'A 여러 문단 선택 삭제');
  record('선택 삭제가 연산으로 전송됨', (await lastOpsOf(A)) > sentBefore);

  // 7. 선택 위에 입력 (deleteRange + 삽입, B) — 영문과 한글 IME 둘 다
  await selectRange(B, [0, 0], [0, 3]);
  await B.keyboard.type('XY');
  await checkConverged(pages, 'B 선택 위 영문 입력');
  await selectRange(B, [0, 0], [0, 2]);
  await imeType(B, [['ㄱ', '가']]);
  await checkConverged(pages, 'B 선택 위 한글 IME 입력');

  // 8. 가만히 두기: digest 가 편집 없이 바뀌지 않는가 (자동 저장 포함)
  const idleBefore = await Promise.all(pages.map((p) => p.evaluate(() => window.__collab.digest())));
  console.log(`  편집 없이 ${AUTOSAVE_WAIT_MS / 1000}s 대기 (자동 저장)…`);
  await sleep(AUTOSAVE_WAIT_MS);
  const idleAfter = await Promise.all(pages.map((p) => p.evaluate(() => window.__collab.digest())));
  const carets = await Promise.all(pages.map((p) => p.evaluate(() => JSON.parse(window.__wasm.doc.getCaretPosition()))));
  record('편집 없이 대기해도 digest 불변', idleBefore.every((d, i) => d === idleAfter[i]),
    `A ${idleBefore[0].slice(0, 12)}→${idleAfter[0].slice(0, 12)}, B ${idleBefore[1].slice(0, 12)}→${idleAfter[1].slice(0, 12)}, `
    + `저장된 캐럿 A=${JSON.stringify(carets[0])} B=${JSON.stringify(carets[1])}`);

  // 9. 자동 저장 뒤 Enter·문단 처음 Backspace (캐럿 제외 확인)
  await caretAt(A, 0, 2);
  await A.keyboard.press('Enter');
  await checkConverged(pages, '자동 저장 뒤 A Enter');
  await caretAt(B, 1, 0);
  await B.keyboard.press('Backspace');
  await checkConverged(pages, '자동 저장 뒤 B 문단 처음 Backspace');
  await checkBytes(pages, '보조');

  // 10. 늦게 들어온 탭 (로그 재생)
  const C = await openTab(browser, room, 'C');
  await checkConverged([A, B, C], '늦게 들어온 C (로그 재생)', { advance: false });
  await checkBytes([A, C], '보조 (A·C)');
  await C.close();

  // 11. 굵게 — 1단계에서는 미지원 편집(diverged)이었고 2단계에서는 동기화된다(R8)
  await selectRange(A, [0, 0], [0, 2]);
  await A.evaluate(() => {
    // 메뉴·단축키와 같은 디스패처로 굵게를 실행한다.
    window.rhwpStudio.automation.execute('format:bold');
    window.__inputHandler.textarea.focus();
  });
  await checkConverged(pages, '굵게 (2단계: 동기화)');
  const boldB = await B.evaluate(() => JSON.parse(window.__wasm.doc.getCharPropertiesAt(0, 0, 1)).bold);
  record('굵게가 B 에 반영', boldB === true, `B bold=${boldB}`);
  await A.close(); await B.close();

  // 12. 되돌리기 — 1단계 T5 는 복원 → desynced 였다. 2단계는 공동편집 중 되돌리기를 멈췄다(§6 suspendHistory).
  // 4단계(docs/collab-stage4.md)부터는 내 편집만 되돌린다 — 남이 그 뒤 같은 자리를 고치지 않았으면 혼자일 때처럼.
  // 앞 탭들이 남긴 자동 저장 초안이 "문서 복구" 모달을 띄우지 않게 격리된 컨텍스트에서 연다.
  const room2 = `t4-undo-${Date.now()}`;
  const ctx = await browser.createBrowserContext();
  const D = await openTab(ctx, room2, 'D');
  const E = await openTab(ctx, room2, 'E');
  await checkConverged([D, E], '되돌리기 방 입장 직후', { advance: false });
  await caretAt(D, 0, 0);
  await D.keyboard.type('undo target');
  await checkConverged([D, E], '되돌리기 준비');
  await selectRange(D, [0, 0], [0, 5]);
  await D.keyboard.press('Delete');
  await checkConverged([D, E], '되돌리기 대상 선택 삭제');
  await D.evaluate(() => window.rhwpStudio.automation.execute('edit:undo'));
  await checkConverged([D, E], '되돌리기 뒤');
  const ds = await status(D);
  const restored = await E.evaluate(() => window.__wasm.getTextRange(0, 0, 0, window.__wasm.getParagraphLength(0, 0)));
  record('공동편집 중 되돌리기(4단계): 내 선택 삭제가 되돌려져 상대에도 반영, desync 없음', !ds.desynced && restored === 'undo target',
    ds.desynced ? ds.desyncReason : `E 문단 0 = ${JSON.stringify(restored)}`);
  await ctx.close();
}

/** 일반 모드(공동편집 아님) 탭. 시작 시 빈 문서가 열리거나 복구 모달이 뜰 때까지 기다린다. */
async function openNormalTab(host, name) {
  const page = await host.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await installMonitors(page);
  page.on('pageerror', (error) => console.log(`    [${name} pageerror] ${error.message}`));
  await page.goto(`${STUDIO}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__inputHandler && (window.__wasm?.pageCount > 0
    || [...document.querySelectorAll('.modal-overlay')].some((e) => e.textContent.includes('문서 복구'))),
  { timeout: 90_000 });
  await sleep(1500); // 시작 시 복구 확인(비동기)이 끝날 시간
  page.tabName = name;
  return page;
}

async function runT8(browser) {
  // 같은 프로필 = 같은 브라우저 컨텍스트. 앞 실행의 초안과 섞이지 않게 새 컨텍스트에서 시작한다.
  const ctx = await browser.createBrowserContext();
  const PASSWORD_MSG = '보호 문서는 복구용 자동 저장을 하지 않습니다';
  const isCollab = (d) => d.fileName.startsWith('collab-');
  const stamp = Date.now();

  // (1) 공동편집 중 편집 → 10초 idle: 초안 없음, 암호 문구 없음, 안내 한 번
  const X1 = await openTab(ctx, `t8-a-${stamp}`, 'X1');
  await checkConverged([X1], 'X1 입장', { advance: false });
  await caretAt(X1, 0, 0);
  await X1.keyboard.type('collab edit');
  await checkConverged([X1], 'X1 입력 반영', { advance: true });
  console.log(`  편집 없이 ${AUTOSAVE_WAIT_MS / 1000}s 대기 (자동 저장 시점)…`);
  await sleep(AUTOSAVE_WAIT_MS);
  const x1 = await X1.evaluate(() => window.__t8);
  record('공동편집 중 10초 idle 뒤 상태 표시줄에 암호 문구 없음', !x1.sb.some((t) => t.includes(PASSWORD_MSG)),
    `상태 표시줄 기록 ${JSON.stringify(x1.sb.slice(-4))}`);
  record('공동편집 중 자동 저장 완료 문구 없음', !x1.sb.some((t) => t.includes('자동 저장 완료')));
  record('플러그인 안내가 한 번만 뜸', x1.notices === 1, `${x1.notices}회`);
  let drafts = await listDrafts(X1);
  record('공동편집 중 초안 0개', drafts.filter(isCollab).length === 0, JSON.stringify(drafts));
  await X1.close();

  // (1) 저장 없이 닫고 다시 공동편집으로: 모달 없음, 공동편집 초안 0개
  const X2 = await openTab(ctx, `t8-b-${stamp}`, 'X2');
  record('(1) 공동편집 탭을 닫고 다시 공동편집으로 열어도 복구 모달 없음', !(await recoveryModal(X2)));
  drafts = await listDrafts(X2);
  record('(1) 공동편집 초안 0개', drafts.filter(isCollab).length === 0, JSON.stringify(drafts));
  await X2.close();

  // (2) 일반 문서를 편집하다 닫고 공동편집으로: 모달 없음, 그 초안은 남음
  const N1 = await openNormalTab(ctx, 'N1');
  record('일반 탭 시작: 복구 모달 없음(남은 초안 없음)', !(await recoveryModal(N1)));
  await caretAt(N1, 0, 0);
  await N1.keyboard.type('normal draft');
  console.log(`  일반 탭 자동 저장 대기 ${AUTOSAVE_WAIT_MS / 1000}s…`);
  await sleep(AUTOSAVE_WAIT_MS);
  const normalDrafts = (await listDrafts(N1)).filter((d) => !isCollab(d));
  record('일반 탭은 평소처럼 초안을 씀', normalDrafts.length === 1, JSON.stringify(normalDrafts));
  await N1.close();

  const X3 = await openTab(ctx, `t8-c-${stamp}`, 'X3');
  await checkConverged([X3], 'X3 입장', { advance: false });
  record('(2) 일반 초안이 있어도 공동편집 시작 시 복구 모달 없음', !(await recoveryModal(X3)));
  await caretAt(X3, 0, 0);
  await X3.keyboard.type('x3');
  await checkConverged([X3], 'X3 입력 반영', { advance: true });
  await sleep(AUTOSAVE_WAIT_MS);
  drafts = await listDrafts(X3);
  record('(2) 일반 초안은 남아 있음 (공동편집이 지우지 않음)',
    normalDrafts.every((n) => drafts.some((d) => d.id === n.id)) && drafts.filter(isCollab).length === 0,
    JSON.stringify(drafts));
  await X3.close();

  // (3) 그 뒤 일반 모드로 열면 그 초안 복구가 평소처럼 뜸
  const N2 = await openNormalTab(ctx, 'N2');
  const modal = await recoveryModal(N2);
  record('(3) 일반 모드로 열면 복구 모달이 뜸', Boolean(modal) && normalDrafts.every((n) => modal.includes(n.fileName)),
    modal ? modal.slice(0, 120) : '모달 없음');
  await N2.close();

  // (4) 플러그인 unload 뒤 자동 저장 재개 — 일반 초안을 지우고 깨끗한 상태에서 본다
  const X4 = await openTab(ctx, `t8-d-${stamp}`, 'X4');
  await X4.evaluate(async (ids) => {
    const store = await import('/src/recovery/autosave-store.ts');
    for (const id of ids) await store.deleteAutosaveDraft(id);
  }, normalDrafts.map((d) => d.id));
  const blockedBefore = await X4.evaluate(() => window.__autosaveManager.isRecoveryBlocked());
  await X4.evaluate(() => window.rhwpStudio.plugins.unload('collab'));
  const blockedAfter = await X4.evaluate(() => window.__autosaveManager.isRecoveryBlocked());
  record('unload 전 중지, unload 뒤 해제', blockedBefore === true && blockedAfter === false,
    `isRecoveryBlocked ${blockedBefore} → ${blockedAfter}`);
  await caretAt(X4, 0, 0);
  await X4.keyboard.type('after unload');
  console.log(`  unload 뒤 자동 저장 대기 ${AUTOSAVE_WAIT_MS / 1000}s…`);
  await sleep(AUTOSAVE_WAIT_MS);
  drafts = await listDrafts(X4);
  const x4 = await X4.evaluate(() => window.__t8);
  record('(4) 플러그인 unload 뒤 자동 저장 재개 (초안 생김)', drafts.length === 1,
    `${JSON.stringify(drafts)}, 상태 표시줄 ${JSON.stringify(x4.sb.filter((t) => t.includes('자동 저장')))}`);
  await ctx.close();
}

const browser = await puppeteer.launch({
  headless: process.env.HEADFUL !== '1',
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-gpu', '--lang=ko-KR'],
});
try {
  if (PHASE === 'before') await runBefore(browser);
  else if (PHASE === 't8') await runT8(browser);
  else await runAfter(browser);
} catch (error) {
  record('시나리오 실행', false, error.stack ?? String(error));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과 (phase=${PHASE})`);
process.exitCode = failed.length ? 1 : 0;
