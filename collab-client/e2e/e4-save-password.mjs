// 8단계 E4 브라우저 확인 (docs/collab-stage8.md E4): 원래 암호 문서였던 방(encryptedSource)에서 studio 로 "저장"하면
// 암호를 묻는다(studio 의 암호 저장 경로 — 0002 `requirePasswordForSave`). 한글 암호도 된다. 두 칸을 비워 두고 확인하면
// 경고를 보이고, 동의하면 암호 없이 저장한다(취소하면 저장하지 않는다). 원래 암호 문서가 아니던 방은 지금처럼 묻지 않는다.
//
// 내려받은 파일은 저장소 밖 임시 폴더에 받아 rhwp(node)로 연다: 암호 없이·원래 암호로는 안 열리고 넣은 암호로만 열리며,
// 방에서 넣은 글이 들어 있다.
//
// 준비: COLLAB_ALLOW_ENCRYPTED=1 PORT=8797 node server/server.mjs
//       + (cd upstream/rhwp/rhwp-studio && COLLAB_DEV_SERVER=http://127.0.0.1:8797 npx vite --port 7710 --strictPort)
// 실행: COLLAB_HTTP=http://127.0.0.1:8797 STUDIO_URL=http://127.0.0.1:7710 node collab-client/e2e/e4-save-password.mjs
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const studioDir = path.resolve(here, '../../upstream/rhwp/rhwp-studio');
const puppeteer = createRequire(path.join(studioDir, 'package.json'))('puppeteer-core');
const pkgDir = path.resolve(here, '../../upstream/rhwp/pkg');
const wasm = await import(pathToFileURL(path.join(pkgDir, 'rhwp.js')).href);
wasm.initSync({ module: readFileSync(path.join(pkgDir, 'rhwp_bg.wasm')) });

const STUDIO = process.env.STUDIO_URL ?? 'http://127.0.0.1:7700';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HTTP = process.env.COLLAB_HTTP ?? 'http://127.0.0.1:8787';
const WS = HTTP.replace(/^http/, 'ws') + '/';
/** 업스트림 샘플(읽기만 — 저장소에 복사하지 않는다)과 그 시험 암호 */
const sample = (name) => readFileSync(path.resolve(here, '../../upstream/rhwp/samples', name));
const SOURCE_PASSWORD = '123456';
const KOREAN_PASSWORD = '비밀번호123';
const ASCII_PASSWORD = 'pass-12345';

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createRoom(bytes, password) {
  const headers = { 'content-type': 'application/octet-stream' };
  if (password) Object.assign(headers, { 'x-collab-document-password': encodeURIComponent(password), 'x-collab-document-password-encoding': 'uri' });
  const res = await fetch(`${HTTP}/rooms`, { method: 'POST', headers, body: bytes });
  const body = await res.json();
  if (res.status !== 201) throw new Error(`방 만들기 ${res.status} ${JSON.stringify(body)}`);
  return body;
}

/** 내려받은 파일을 여는지(암호 없이·주어진 암호로). 열면 글 전체, 못 열면 null */
function openText(bytes, password) {
  try {
    const d = password === undefined ? new wasm.HwpDocument(bytes) : wasm.HwpDocument.openWithPassword(bytes, password);
    try { return d.getTextFileText(); } finally { d.free(); }
  } catch {
    return null;
  }
}
const kind = (bytes) => (bytes[0] === 0x50 && bytes[1] === 0x4b ? 'zip' : bytes[0] === 0xd0 && bytes[1] === 0xcf ? 'cfb' : 'other');

async function openTab(browser, room, name, downloads) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.errors = [];
  page.on('pageerror', (error) => { page.errors.push(error.message); console.log(`    [${name} pageerror] ${error.message}`); });
  page.on('console', (msg) => { if (msg.type() === 'error') { page.errors.push(msg.text()); console.log(`    [${name} console.error] ${msg.text()}`); } });
  page.on('dialog', async (d) => { page.errors.push(`dialog ${d.type()}: ${d.message()}`); await d.dismiss().catch(() => {}); });
  // 저장 위치 고르기 창 대신 내려받기로(studio 의 대체 경로) — 시험이 파일을 받을 수 있게
  await page.evaluateOnNewDocument(() => { window.showSaveFilePicker = undefined; });
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  await page.goto(`${STUDIO}/?collab=${encodeURIComponent(WS)}&room=${encodeURIComponent(room)}&name=${name}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__collab?.status().ready && window.__inputHandler, { timeout: 90_000 });
  return page;
}

const files = (dir) => readdirSync(dir).filter((f) => !f.endsWith('.crdownload'));
/** fn 뒤 새로 받은 파일 하나(없으면 null) */
async function download(dir, fn, ms = 15_000) {
  for (const f of readdirSync(dir)) rmSync(path.join(dir, f), { force: true });
  await fn();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const got = files(dir);
    if (got.length > 0) { await sleep(300); return { name: got[0], bytes: readFileSync(path.join(dir, got[0])) }; }
    await sleep(100);
  }
  return null;
}

const save = async (page) => {
  await page.evaluate(() => document.querySelector('#scroll-container, .canvas-container, body')?.dispatchEvent(new Event('focus')));
  await page.keyboard.down('Control');
  await page.keyboard.press('s');
  await page.keyboard.up('Control');
};
const passwordDialog = (page, ms = 5_000) => page.waitForSelector('#hwp-save-password-input', { visible: true, timeout: ms }).then(() => true).catch(() => false);
const typePassword = async (page, password, confirmation = password) => {
  await page.click('#hwp-save-password-input');
  if (password) await page.keyboard.sendCharacter(password);
  await page.click('#hwp-save-password-confirmation');
  if (confirmation) await page.keyboard.sendCharacter(confirmation);
  await page.keyboard.press('Enter');
};
/** 맨 위 대화상자의 제목·본문 */
const topDialog = (page) => page.evaluate(() => {
  const wraps = [...document.querySelectorAll('.dialog-wrap')].filter((w) => w.offsetParent !== null);
  const w = wraps.at(-1);
  return w ? { title: w.querySelector('.dialog-title')?.textContent ?? '', text: w.textContent ?? '' } : null;
});
const clickTop = (page, primary) => page.evaluate((p) => {
  const wraps = [...document.querySelectorAll('.dialog-wrap')].filter((w) => w.offsetParent !== null);
  const w = wraps.at(-1);
  const buttons = [...(w?.querySelectorAll('.dialog-footer .dialog-btn') ?? [])];
  const b = p ? buttons.find((x) => x.classList.contains('dialog-btn-primary')) : buttons.find((x) => !x.classList.contains('dialog-btn-primary'));
  b?.click();
  return Boolean(b);
}, primary);
const noDialog = (page) => page.evaluate(() => [...document.querySelectorAll('.dialog-wrap')].every((w) => w.offsetParent === null));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
const dl = mkdtempSync(path.join(tmpdir(), 'e4-dl-'));
try {
  // ── 1. 원래 암호 HWPX 방 ──────────────────────────────────────────────
  const hx = await createRoom(sample('HWP5-password-123456.hwpx'), SOURCE_PASSWORD);
  record('1 원래 암호 HWPX 로 방을 만들면 응답에 encryptedSource', hx.encryptedSource === true);
  const a = await openTab(browser, hx.room, 'A', dl);
  const sa = await a.evaluate(() => ({ enc: window.__collab.status().encryptedSource, req: window.__wasm.requiresPasswordForSave, empty: window.__wasm.emptySavePassword !== null }));
  record('2 방 문서를 열면 저장 암호 필요로 표시(세션 encryptedSource·studio 표시·빈 암호 문구)', sa.enc && sa.req && sa.empty, JSON.stringify(sa));
  const marker = `E4표지${Date.now() % 100000}`;
  await a.evaluate((m) => window.__wasm.insertText(0, 0, 0, m), marker);
  await a.waitForFunction(() => window.__collab.status().inflight === 0 && window.__collab.status().pending === 0, { timeout: 15_000 });

  // 한글 암호로 저장
  let shown = false;
  let hint = false;
  const kr = await download(dl, async () => {
    await save(a);
    shown = await passwordDialog(a);
    hint = await a.$('[data-cc-rhwp="save-password-empty-hint"]').then((h) => Boolean(h));
    if (shown) await typePassword(a, KOREAN_PASSWORD);
  });
  record('3 저장(Ctrl+S)하면 암호를 묻는다 — 빈 암호 안내가 보임', shown && hint, `대화상자 ${shown}, 안내 ${hint}`);
  const krOk = kr && kind(kr.bytes) === 'zip' && openText(kr.bytes) === null && openText(kr.bytes, SOURCE_PASSWORD) === null
    && (openText(kr.bytes, KOREAN_PASSWORD) ?? '').includes(marker);
  record('4 한글 암호로 저장한 HWPX: 암호 없이·원래 암호로는 안 열리고 그 암호로만 열리며, 방에서 넣은 글이 있다', Boolean(krOk),
    kr ? `${kr.name} ${kr.bytes.length}B ${kind(kr.bytes)}` : '받은 파일 없음');

  // 다음 저장도 다시 묻는다(암호는 기억하지 않음) — 비워 두고 확인 → 경고 → 취소하면 저장하지 않는다
  let warn = null;
  const cancelled = await download(dl, async () => {
    await save(a);
    if (await passwordDialog(a)) await typePassword(a, '', '');
    await sleep(500);
    warn = await topDialog(a);
    await clickTop(a, false);
  }, 2_500);
  record('5 다시 저장하면 또 묻고, 비워 두면 경고 — 취소하면 저장하지 않음', Boolean(warn && warn.title.includes('암호 없이 저장') && warn.text.includes('누구나 열 수')) && cancelled === null && await noDialog(a),
    warn ? `경고 "${warn.title}"` : '경고 없음');
  const stillProtected = await a.evaluate(() => window.__wasm.requiresPasswordForSave);
  record('6 경고를 취소하면 보호 표시는 그대로', stillProtected === true);

  // 비워 두고 경고에 동의 → 암호 없이 저장
  const plain = await download(dl, async () => {
    await save(a);
    if (await passwordDialog(a)) await typePassword(a, '', '');
    await sleep(500);
    await clickTop(a, true);
  });
  record('7 비워 두고 경고에 동의하면 암호 없이 저장(누구나 열림, 글 있음)', Boolean(plain && (openText(plain.bytes) ?? '').includes(marker)),
    plain ? `${plain.name} ${plain.bytes.length}B` : '받은 파일 없음');
  // 암호 없이 저장한 뒤는 studio 규칙대로 그 문서는 보호가 풀린다(다시 묻지 않음)
  let askedAgain = true;
  const after = await download(dl, async () => { await save(a); askedAgain = await passwordDialog(a, 1_500); });
  record('8 암호 없이 저장한 뒤의 저장은 묻지 않는다(studio 의 보호 해제 규칙)', !askedAgain && Boolean(after && openText(after.bytes) !== null));

  // 같은 방의 다른 참여자도 묻는다
  const b = await openTab(browser, hx.room, 'B', dl);
  let bShown = false;
  await download(dl, async () => {
    await save(b);
    bShown = await passwordDialog(b);
    await clickTop(b, false);
  }, 1_500);
  record('9 같은 방의 다른 참여자(B)도 저장할 때 암호를 묻는다', bShown);
  // 짧은 암호는 studio 규칙(5자 이상) 그대로
  await save(b);
  await passwordDialog(b);
  await typePassword(b, 'abc');
  const err = await b.evaluate(() => document.querySelector('.dialog-wrap [role="alert"]')?.textContent ?? '');
  record('10 짧은 암호는 지금처럼 막는다(5자 이상)', err.includes('5자'), err);
  await clickTop(b, false);
  await b.close();
  await a.close();

  // ── 2. 원래 암호 HWP5 방: ASCII 암호, 형식은 HWP ──────────────────────────
  const h5 = await createRoom(sample('hwp3-sample16-hwp5-2024-password-123456.hwp'), SOURCE_PASSWORD);
  const c = await openTab(browser, h5.room, 'C', dl);
  const h5save = await download(dl, async () => { await save(c); if (await passwordDialog(c)) await typePassword(c, ASCII_PASSWORD); }, 30_000);
  record('11 원래 암호 HWP 방: 저장한 HWP 는 넣은 암호로만 열린다', Boolean(h5save && kind(h5save.bytes) === 'cfb' && openText(h5save.bytes) === null && openText(h5save.bytes, ASCII_PASSWORD) !== null),
    h5save ? `${h5save.name} ${h5save.bytes.length}B ${kind(h5save.bytes)}` : '받은 파일 없음');
  await c.close();

  // ── 3. 원래 암호 문서가 아닌 방: 지금처럼 묻지 않는다 ─────────────────────
  const pl = await createRoom(sample('HWP5-nopassword-123456.hwp'));
  const d = await openTab(browser, pl.room, 'D', dl);
  const sd = await d.evaluate(() => ({ enc: window.__collab.status().encryptedSource, req: window.__wasm.requiresPasswordForSave }));
  let dAsked = true;
  const dSave = await download(dl, async () => { await save(d); dAsked = await passwordDialog(d, 1_500); });
  record('12 원래 암호 문서가 아닌 방은 표시 없음, 저장은 묻지 않고 암호 없는 파일', !sd.enc && !sd.req && !dAsked && Boolean(dSave && openText(dSave.bytes) !== null),
    JSON.stringify(sd));
  await d.close();

  const errors = [a, b, c, d].flatMap((p) => p.errors);
  record('13 콘솔 오류·브라우저 대화상자 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (error) {
  record('시험 중 예외', false, error.stack ?? String(error));
} finally {
  await browser.close();
  rmSync(dl, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exit(failed.length ? 1 : 0);
