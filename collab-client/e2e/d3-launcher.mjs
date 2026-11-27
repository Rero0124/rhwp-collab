// 5단계 D3 브라우저 확인 (docs/collab-stage5.md D3): studio 안 "공동편집 시작" — 공동편집으로 열지 않은 studio(A)가
// 지금 문서로 방을 만들고 링크를 보여 준다. 다른 탭(B)이 편집 링크로 들어오면 같은 문서이고, A 가 "이 방으로 들어가기"로
// 들어가 편집하면 B 와 수렴한다. 암호를 풀고 연 HWPX(업스트림 샘플, 읽기만 — 문서 정보의 encrypted 는 false)는 D5 대로
// 막는다(host.documentProtection — 첫 참여자 막기와 같은 판정).
//
// 준비: node server/server.mjs (8787) + (cd upstream/rhwp/rhwp-studio && COLLAB_DEV_SERVER=http://127.0.0.1:8787 npx vite) (7700)
//       — 서버의 /healthz 가 인증 방식(auth)을 알려야 메뉴가 뜬다.
// 실행: node collab-client/e2e/d3-launcher.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const studioDir = path.resolve(here, '../../upstream/rhwp/rhwp-studio');
const puppeteer = createRequire(path.join(studioDir, 'package.json'))('puppeteer-core');

const STUDIO = process.env.STUDIO_URL ?? 'http://127.0.0.1:7700';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** 업스트림 암호 샘플(읽기만 — 저장소에 복사하지 않는다)과 그 시험 암호 */
const ENCRYPTED_HWPX = path.resolve(here, '../../upstream/rhwp/samples/HWP5-password-123456.hwpx');
const ENCRYPTED_PASSWORD = '123456';
const ENCRYPTED_TEXT = '암호 문서는 공동편집할 수 없습니다';
const MENU = '[data-cmd="ext:collab.start"]';

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tab(browser, name, url) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.errors = [];
  page.dialogs = [];
  // 대화상자(이탈 확인 등)가 뜨면 기록하고 닫는다 — 뜨면 안 되는 자리에서는 실패로 본다
  page.on('dialog', async (d) => { page.dialogs.push(`${d.type()}: ${d.message()}`); await d.accept().catch(() => {}); });
  page.on('pageerror', (error) => { page.errors.push(error.message); console.log(`    [${name} pageerror] ${error.message}`); });
  page.on('console', (msg) => { if (msg.type() === 'error') { page.errors.push(msg.text()); console.log(`    [${name} console.error] ${msg.text()}`); } });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__inputHandler, { timeout: 90_000, polling: 250 });
  return page;
}
// 뒤쪽 탭은 requestAnimationFrame 이 멈추므로 시간 간격으로 살핀다
const joined = (page) => page.waitForFunction(() => window.__collab?.status().ready, { timeout: 90_000, polling: 250 });
const text = (page) => page.evaluate(() => {
  const w = window.__wasm;
  return Array.from({ length: w.getParagraphCount(0) }, (_, i) => w.getTextRange(0, i, 0, w.getParagraphLength(0, i))).join('\n');
});
async function settle(pages) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const st = await Promise.all(pages.map((p) => p.evaluate(() => window.__collab.status())));
    if (new Set(st.map((s) => s.lastSeq)).size === 1 && st.every((s) => !s.inflight && !s.pending && !s.resyncing)) return st;
    await sleep(150);
  }
  return Promise.all(pages.map((p) => p.evaluate(() => window.__collab.status())));
}
const openLauncher = (page) => page.evaluate((sel) => { document.querySelector(sel).click(); }, MENU);

const browser = await puppeteer.launch({ headless: process.env.HEADFUL !== '1', executablePath: CHROME, args: ['--lang=ko-KR'] });
try {
  // A: 평소 studio — 메뉴가 뜨고 콘솔 오류가 없다
  const A = await tab(browser, 'A', `${STUDIO}/`);
  const menu = await A.waitForSelector(MENU, { timeout: 30_000 }).catch(() => null);
  record('평소 studio 에 "공동편집 시작…" 메뉴', Boolean(menu), menu ? '' : '메뉴 없음(서버의 /healthz 가 auth 를 알려야 한다)');
  if (!menu) throw new Error('메뉴 없음');
  await A.evaluate(() => window.__inputHandler.textarea.focus());
  await sleep(800);
  // 영문으로 친다(헤드리스 크롬의 한글 입력은 새 문서 첫 글자를 흘린다 — 이 시험의 대상이 아니다)
  await A.keyboard.type('launcher test document', { delay: 15 });
  await sleep(300);
  const original = await text(A);

  // 방 만들기 → 링크
  await openLauncher(A);
  await A.waitForSelector('[data-collab="launcher-create"]', { timeout: 10_000 });
  await A.click('[data-collab="launcher-create"]');
  await A.waitForSelector('[data-collab="launcher-link"][data-scope="edit"] code', { timeout: 30_000 });
  const links = await A.$$eval('[data-collab="launcher-link"]', (rows) => rows.map((r) => [r.dataset.scope, r.querySelector('code').textContent]));
  const edit = links.find(([s]) => s === 'edit')?.[1];
  record('방을 만들고 링크를 보여 줌', Boolean(edit) && /\?collab(=[^#]*)?#.*room=/.test(edit), JSON.stringify(links.map(([s, u]) => [s, u.replace(/token=[^&]+/, 'token=…')])));

  // B: 편집 링크로 들어온다 — 같은 문서
  const B = await tab(browser, 'B', edit);
  await joined(B);
  const bText = await text(B);
  record('다른 탭이 편집 링크로 들어오면 같은 문서', bText === original, JSON.stringify(bText));

  // A: "이 방으로 들어가기" — 새로 열리며 들어가고, 편집이 B 와 수렴
  const navigated = A.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).then(() => true, () => false);
  await A.evaluate(() => { document.querySelector('[data-collab="launcher-enter"]').click(); });
  record('"이 방으로 들어가기" 로 편집 링크로 이동', await navigated, `${A.url().replace(/token=[^&]+/, 'token=…')} 대화상자 ${JSON.stringify(A.dialogs)}`);
  await A.waitForFunction(() => window.__inputHandler, { timeout: 90_000, polling: 250 });
  await joined(A);
  await A.evaluate(() => {
    const ih = window.__inputHandler;
    const w = window.__wasm;
    ih.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: w.getParagraphLength(0, 0) });
    ih.textarea.focus();
  });
  await A.keyboard.type(' added', { delay: 20 });
  const st = await settle([A, B]);
  const [da, db] = await Promise.all([A, B].map((p) => p.evaluate(() => window.__collab.digest())));
  const [ta, tb] = await Promise.all([text(A), text(B)]);
  record('만든 탭도 들어가 편집 — 두 탭 수렴, 재동기화 0', da === db && ta === tb && ta.endsWith(' added') && ta.startsWith(original) && st.every((s) => s.resyncCount === 0), `A ${JSON.stringify(ta)} B ${JSON.stringify(tb)}`);
  record('들어가기에서 "저장하지 않은 변경" 확인이 뜨지 않음', A.dialogs.length === 0, A.dialogs.join(' | '));
  record('평소 studio·방 만들기에서 콘솔 오류 없음', A.errors.length === 0, A.errors.join(' | '));

  // C: 암호를 풀고 연 HWPX — 막힘(문서 정보의 encrypted 는 false 라 그것으로는 못 가린다)
  const C = await tab(browser, 'C', `${STUDIO}/`);
  await C.waitForSelector(MENU, { timeout: 30_000 });
  await (await C.$('#file-input')).uploadFile(ENCRYPTED_HWPX);
  await C.waitForSelector('#hwp-password-input', { timeout: 30_000 });
  await C.type('#hwp-password-input', ENCRYPTED_PASSWORD);
  await C.keyboard.press('Enter');
  // 빈 문서도 문단이 하나 있으므로 연 파일 이름으로 기다린다
  await C.waitForFunction((name) => !document.querySelector('#hwp-password-input') && window.__wasm.fileName === name, { timeout: 60_000, polling: 250 }, path.basename(ENCRYPTED_HWPX));
  const info = await C.evaluate(() => { const d = window.__wasm.getDocumentInfo(); return (typeof d === 'string' ? JSON.parse(d) : d).encrypted === true; });
  const studioFlag = await C.evaluate(() => window.__wasm.requiresPasswordForSave);
  await openLauncher(C);
  await C.waitForSelector('[data-collab="launcher"]', { timeout: 10_000 });
  const blocked = await C.evaluate(() => ({
    text: document.querySelector('[data-collab="launcher-encrypted"]')?.textContent ?? null,
    create: Boolean(document.querySelector('[data-collab="launcher-create"]')),
  }));
  record('암호를 풀고 연 HWPX 는 막힘(방 만들기 단추 없음)', blocked.text === ENCRYPTED_TEXT && !blocked.create, `${JSON.stringify(blocked)} (문서 정보 encrypted ${info}, studio requiresPasswordForSave ${studioFlag})`);
} catch (error) {
  record('시나리오 실행', false, error.stack ?? String(error));
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exitCode = failed.length ? 1 : 0;
