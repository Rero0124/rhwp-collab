// 4단계 U3 브라우저 확인 (docs/collab-stage4.md §6): snapshot 경로(표 만들기·붙여넣기·표 지우기)의 되돌리기를 문단 범위로.
// 같은 headless Chrome 의 두 탭(A, B)이 지연 서버(300ms)에서 편집하고 A 가 studio 의 되돌리기 명령(edit:undo)을 누른다.
// 스냅샷 명령은 studio 의 실제 경로(InputHandler.executeOperation → SnapshotCommand → CommandHistory → 플러그인 훅)로
// 만든다 — 표 만들기는 표 만들기 격자(createTable)와 같은 호출, 붙여넣기는 edit:copy·edit:paste 명령.
// 단계마다 두 탭의 digest 일치·desync·재동기화 0 과, 되돌린 결과(내 변경만 빠짐) 또는 막힘(알림·문서 그대로)을 본다.
//
// 준비: COLLAB_DELAY_MS=300 PORT=8807 node server/server.mjs + (cd upstream/rhwp/rhwp-studio && npx vite --port 7720 --strictPort)
// 실행: STUDIO_URL=http://127.0.0.1:7720 COLLAB_URL=ws://127.0.0.1:8807 node collab-client/e2e/u3-undo-range.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const studioDir = path.resolve(here, '../../upstream/rhwp/rhwp-studio');
const puppeteer = createRequire(path.join(studioDir, 'package.json'))('puppeteer-core');

const STUDIO = process.env.STUDIO_URL ?? 'http://127.0.0.1:7720';
const COLLAB = process.env.COLLAB_URL ?? 'ws://127.0.0.1:8807';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BLOCKED = '다른 사람이 이후에 고친 부분이라 되돌릴 수 없습니다';
const DROPPED = '되돌리기가 다른 사람 편집과 겹쳐 취소됐습니다';

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ⑧ 의 비교용 — 같은 빌드의 WASM 으로 내보낸 문서를 한 번 다시 읽어 맞춘 digest(내보내기→다시 읽기는 항등이 아니다)
const PKG = path.resolve(here, '../../upstream/rhwp/pkg');
const wasm = await import(pathToFileURL(`${PKG}/rhwp.js`).href);
wasm.initSync({ module: readFileSync(`${PKG}/rhwp_bg.wasm`) });
const normalizedDigest = (b64) => {
  const a = new wasm.HwpDocument(gunzipSync(Buffer.from(b64, 'base64')));
  const b = new wasm.HwpDocument(gunzipSync(Buffer.from(a.collabExportState())));
  const d = b.collabDigest();
  a.free();
  b.free();
  return d;
};
const exportOf = (page) => page.evaluate(() => {
  const bytes = window.__wasm.borrowDocumentHandle().collabExportState();
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
});
/** 본문 표 하나의 (문단, 개체 번호) */
const firstTable = (page) => page.evaluate(() => {
  const w = window.__wasm;
  for (let p = 0; p < w.getParagraphCount(0); p += 1) {
    for (let ci = 0; ci < 4; ci += 1) {
      try { w.getTableProperties(0, p, ci); return [p, ci]; } catch { /* 표 아님 */ }
    }
  }
  return null;
});

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
/** 표를 품은 본문 문단들 */
const tableParas = (page) => page.evaluate(() => {
  const w = window.__wasm;
  const out = [];
  for (let p = 0; p < w.getParagraphCount(0); p += 1) {
    try { w.getTableProperties(0, p, 0); out.push(p); } catch { /* 표 없음 */ }
  }
  return out;
});
const words = async (page) => (await paragraphs(page)).filter((t) => t !== '');
const notices = (page) => page.evaluate(() => [...document.querySelectorAll('[data-collab="undo"]')].map((e) => e.textContent));

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
  if (!advance) lastSeq -= 1;
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
const typeAtEnd = async (page, para, text, delay = 20) => {
  const len = await page.evaluate((p) => window.__wasm.getParagraphLength(0, p), para);
  await caretAt(page, para, len);
  await page.keyboard.type(text, { delay });
};
const lastPara = async (page) => (await page.evaluate(() => window.__wasm.getParagraphCount(0))) - 1;
/** studio 표 만들기(격자 선택과 같은 호출): 문단 끝에 2×2 표 — SnapshotCommand 로 기록된다 */
const createTable = (page, para) => page.evaluate((p) => {
  const ih = window.__inputHandler;
  const len = window.__wasm.getParagraphLength(0, p);
  ih.executeOperation({
    kind: 'snapshot',
    operationType: 'createTable',
    operation: (wasm) => {
      const r = wasm.createTable(0, p, len, 2, 2);
      return r.ok ? { sectionIndex: 0, paragraphIndex: 0, charOffset: 0, parentParaIndex: r.paraIdx, controlIndex: r.controlIdx, cellIndex: 0, cellParaIndex: 0 } : null;
    },
  });
}, para);
/** studio 표 지우기(입력기의 deleteTable 과 같은 호출) */
const deleteTable = (page, para) => page.evaluate((p) => {
  window.__inputHandler.executeOperation({
    kind: 'snapshot',
    operationType: 'deleteTable',
    operation: (wasm) => { wasm.deleteTableControl(0, p, 0); return { sectionIndex: 0, paragraphIndex: p, charOffset: 0 }; },
  });
}, para);
/**
 * studio 복사·붙여넣기(입력기의 copy·paste 처리기 — Ctrl+C·Ctrl+V 와 같은 경로). headless 에서는 `document.execCommand('paste')`
 * (edit:paste 명령)가 막히므로, 같은 DataTransfer 를 실은 ClipboardEvent 를 입력기의 textarea 로 보낸다.
 */
const copyPaste = async (page, from, to, atPara) => {
  await page.bringToFront();
  await page.evaluate(async (a, b, p) => {
    const ih = window.__inputHandler;
    const pos = ([q, o]) => ({ sectionIndex: 0, paragraphIndex: q, charOffset: o });
    const dt = new DataTransfer();
    if (!ih.cursor.selectRange(pos(a), pos(b))) throw new Error('선택 실패');
    ih.textarea.focus();
    ih.textarea.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 100));
    ih.cursor.clearSelection();
    ih.cursor.moveTo(pos([p, window.__wasm.getParagraphLength(0, p)]));
    ih.textarea.focus();
    ih.textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, from, to, atPara);
};
const undo = async (page) => { await page.bringToFront(); await exec(page, 'edit:undo'); };
const redo = async (page) => { await page.bringToFront(); await exec(page, 'edit:redo'); };
const stack = (page) => page.evaluate(() => window.__collab.undo());

const browser = await puppeteer.launch({ headless: process.env.HEADFUL !== '1', executablePath: CHROME, args: ['--lang=ko-KR'] });
try {
  await browser.defaultBrowserContext().overridePermissions(new URL(STUDIO).origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const room = `u3-${Date.now()}`;
  const A = await openTab(browser, room, 'A');
  const B = await openTab(browser, room, 'B');
  const pages = [A, B];
  // 준비(B 가 친다 — A 의 되돌리기 스택은 비어 있다): 다섯 문단
  await caretAt(B, 0, 0);
  await B.keyboard.type('line zero', { delay: 10 });
  for (const t of ['line one', 'line two', 'line three', 'line four']) { await B.keyboard.press('Enter'); await B.keyboard.type(t, { delay: 10 }); }
  let s = await same(pages);
  const base = await paragraphs(A);
  record('준비: 다섯 문단', s.ok && base.length === 5, JSON.stringify(base));

  // ① A 표 만들기(문단 1 끝), B 마지막 문단 입력 → A 되돌리기 허용, A 의 표만 사라지고 B 의 글자는 남음
  await createTable(A, 1);
  await same(pages);
  const t1 = await tableParas(B);
  const st1 = await stack(A);
  await typeAtEnd(B, await lastPara(B), ' B1');
  await same(pages);
  await undo(A);
  s = await same(pages);
  let w = await words(B);
  record('① 표 만들기 되돌리기(남의 다른 문단 입력 뒤)', s.ok && t1.length === 1 && (await tableParas(A)).length === 0 && w.at(-1) === 'line four B1' && w.length === 5,
    `표 ${JSON.stringify(t1)} 범위 ${JSON.stringify(st1.undo.at(-1)?.range)} 문단 ${JSON.stringify(w)}`);

  // ② A 표 만들기 뒤 B 가 A 의 범위(표를 넣은 문단 1)를 고침 → 막힘·알림·문서 그대로
  await createTable(A, 1);
  await same(pages);
  await caretAt(B, 1, 0);
  await B.keyboard.type('Q', { delay: 20 });
  await same(pages);
  const before2 = await paragraphs(A);
  await undo(A);
  await sleep(300);
  const n2 = await notices(A);
  s = await same(pages, { advance: false });
  record('② 범위를 남이 고친 뒤 → 막힘·알림·문서 그대로', s.ok && JSON.stringify(await paragraphs(A)) === JSON.stringify(before2) && n2.at(-1) === BLOCKED, `알림 ${JSON.stringify(n2.slice(-1))}`);

  // ③ A 표 만들기(문단 3 끝), B 가 범위 앞(문단 0)에서 Enter → 지도로 옮겨 허용
  const tablesBefore3 = (await tableParas(A)).length;
  await createTable(A, 3);
  await same(pages);
  await caretAt(B, 0, 4);
  await B.keyboard.press('Enter');
  await same(pages);
  await undo(A);
  s = await same(pages);
  record('③ 범위 앞 Enter 뒤 표 만들기 되돌리기', s.ok && (await tableParas(A)).length === tablesBefore3 && (await words(B))[0] === 'line', JSON.stringify(await words(B)));

  // ④ redo: ③ 을 다시 하기 → 표가 돌아옴(남의 편집 유지), 다시 되돌리기
  await redo(A);
  s = await same(pages);
  const t4 = (await tableParas(B)).length;
  await undo(A);
  const s4 = await same(pages);
  record('④ 다시 하기로 표가 돌아오고 다시 되돌려짐', s.ok && s4.ok && t4 === tablesBefore3 + 1 && (await tableParas(A)).length === tablesBefore3, `표 ${t4}`);

  // ⑤ 붙여넣기: A 가 두 문단에 걸친 글을 복사해 마지막 문단 끝에 붙여넣음, B 가 문단 0 입력 → A 되돌리기로 붙여넣기만 빠짐
  const before5 = await words(A);
  const lp = await lastPara(A);
  await copyPaste(A, [lp - 2, 0], [lp - 1, 4], lp);
  await sleep(500);
  await same(pages);
  const pasted = await words(B);
  const st5 = await stack(A);
  await typeAtEnd(B, 0, ' B5');
  await same(pages);
  await undo(A);
  s = await same(pages);
  w = await words(B);
  record('⑤ 붙여넣기 되돌리기(남의 다른 문단 입력 뒤)', s.ok && pasted.length > before5.length && w.length === before5.length && w[0].endsWith(' B5') && w.at(-1) === before5.at(-1),
    `붙임 ${JSON.stringify(pasted.slice(-3))} 종류 ${st5.undo.at(-1)?.type} 범위 ${JSON.stringify(st5.undo.at(-1)?.range)} 뒤 ${JSON.stringify(w)}`);

  // ⑥ 표 지우기(개체 삭제)를 되돌리면 표가 제자리로, B 의 편집은 남음
  const [tp] = await tableParas(A);
  const tablesBefore6 = (await tableParas(A)).length;
  await deleteTable(A, tp);
  await same(pages);
  const t6 = (await tableParas(B)).length;
  await typeAtEnd(B, await lastPara(B), ' B6');
  await same(pages);
  await undo(A);
  s = await same(pages);
  record('⑥ 표 지우기 되돌리기(남의 다른 문단 입력 뒤)', s.ok && t6 === tablesBefore6 - 1 && (await tableParas(A)).length === tablesBefore6 && (await words(B)).at(-1).endsWith(' B6'), `지운 뒤 ${t6}`);

  // ⑦ B 가 계속 치는 중에 A 가 표 만들기를 되돌림 → B 의 글자가 하나도 취소되지 않고, A 의 되돌리기도 취소되지 않음
  await createTable(A, 1);
  await same(pages);
  const dropsBefore = await Promise.all(pages.map(async (p) => (await status(p)).droppedTotal));
  const nA = (await notices(A)).length;
  const lp7 = await lastPara(B);
  const len7 = await B.evaluate((p) => window.__wasm.getParagraphLength(0, p), lp7);
  await caretAt(B, lp7, len7);
  const typing = B.keyboard.type(' continuous typing by B while A undoes', { delay: 45 });
  await sleep(600);
  await A.evaluate(() => window.__inputHandler && window.rhwpStudio.automation.execute('edit:undo')); // 탭을 앞으로 가져오지 않는다(B 가 계속 친다)
  await typing;
  s = await same(pages);
  const dropsAfter = await Promise.all(pages.map(async (p) => (await status(p)).droppedTotal));
  w = await words(B);
  const nA7 = (await notices(A)).slice(nA);
  record('⑦ B 가 계속 치는 중 되돌리기: B 입력·A 되돌리기 모두 산다', s.ok && dropsAfter[0] === dropsBefore[0] && dropsAfter[1] === dropsBefore[1]
    && w.at(-1).endsWith(' continuous typing by B while A undoes') && (await tableParas(A)).length === tablesBefore6 && !nA7.includes(DROPPED),
    `취소 ${JSON.stringify(dropsBefore)} → ${JSON.stringify(dropsAfter)}, A 알림 ${JSON.stringify(nA7)}, 끝 문단 ${JSON.stringify(w.at(-1))}`);

  const final = await Promise.all(pages.map(status));
  record('끝까지 어긋남·재동기화 없음', final.every((st) => !st.desynced && !st.left && st.resyncCount === 0), final.map((st) => `${st.name}: resync ${st.resyncCount}, replaced ${st.replacedAcks}`).join(', '));

  // ⑧ 파일에서 온 표(표 머리·표 레코드 꼬리·셀 목록 꼬리 같은 날 바이트가 있는 표)를 지웠다가 되돌림 → 서버의 결과 다시
  // 쓰기(정본이 본 날 바이트만 남김)를 지나도 잃는 것이 없다: 되돌린 문서 = 지우기 전 문서(맞춘 digest)
  const sample = readFileSync(path.resolve(studioDir, '../samples/hwp_table_test-m.hwp'));
  const made = await fetch(`${COLLAB.replace(/^ws/, 'http')}/rooms`, { method: 'POST', body: sample });
  const fileRoom = (await made.json()).room;
  const A2 = await openTab(browser, fileRoom, 'A2');
  const B2 = await openTab(browser, fileRoom, 'B2');
  const files = [A2, B2];
  lastSeq = -1;
  const pre = normalizedDigest(await exportOf(A2));
  const at = await firstTable(A2);
  await A2.evaluate(([p, ci]) => {
    window.__inputHandler.executeOperation({
      kind: 'snapshot',
      operationType: 'deleteTable',
      operation: (w) => { w.deleteTableControl(0, p, ci); return { sectionIndex: 0, paragraphIndex: p, charOffset: 0 }; },
    });
  }, at);
  await same(files);
  const gone = await firstTable(B2);
  await undo(A2);
  s = await same(files);
  const post = normalizedDigest(await exportOf(B2));
  record('⑧ 파일 표 지우기 되돌리기: 결과 다시 쓰기를 지나도 날 바이트를 잃지 않음(지우기 전 문서와 같음)', s.ok && at !== null && JSON.stringify(gone) !== JSON.stringify(at) && post === pre && JSON.stringify(await firstTable(A2)) === JSON.stringify(at),
    `표 ${JSON.stringify(at)} 지운 뒤 ${JSON.stringify(gone)} digest ${pre.slice(0, 12)} → ${post.slice(0, 12)}`);
} catch (error) {
  record('시나리오 실행', false, error.stack ?? String(error));
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exitCode = failed.length ? 1 : 0;
