// 5단계 D3 브라우저 확인 (docs/collab-stage5.md D3): studio 안 "공동편집 시작" — 공동편집으로 열지 않은 studio(A)가
// 지금 문서로 방을 만들고 링크를 보여 준다. 다른 탭(B)이 편집 링크로 들어오면 같은 문서이고, A 가 "이 방으로 들어가기"로
// 들어가 편집하면 B 와 수렴한다. 암호를 풀고 연 HWPX(업스트림 샘플, 읽기만 — 문서 정보의 encrypted 는 false)는 D5 대로
// 막는다(host.documentProtection — 첫 참여자 막기와 같은 판정). 같은 실행에서 플러그인의 첫 참여자 확인(D5)도 본다: 암호
// HWPX 를 연 채 새 방에 처음 들어가면 base 를 올리지 않고 "암호 문서는 공동편집할 수 없습니다"로 나가며 서버에 문서가 없다.
//
// 준비: node server/server.mjs (8787) + (cd upstream/rhwp/rhwp-studio && COLLAB_DEV_SERVER=http://127.0.0.1:8787 npx vite) (7700)
// 실행: node collab-client/e2e/d3-launcher.mjs
// hs256 서버: D3_CREATE_TOKEN=<만들기(create) 토큰> D3_JOIN_TOKEN=<모든 방 edit 토큰> COLLAB_HTTP=http://127.0.0.1:<포트> 로
//       돌린다(studio 를 #create= 로 열고, 토큰이 없는 탭은 입력 칸으로 만든다). 토큰은 저장소 밖에서 만든다(server/token.mjs).
//       만들기 토큰에 name 이 있으면 "이 방으로 들어가기"는 이름을 묻지 않고 그 이름으로 들어간다. 초대 링크로 들어오는 탭(B)은
//       화면 안 이름 칸으로 묻는다(브라우저 대화상자 없음).
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
const CREATE_TOKEN = process.env.D3_CREATE_TOKEN ?? '';
const JOIN_TOKEN = process.env.D3_JOIN_TOKEN ?? '';
const HTTP = process.env.COLLAB_HTTP ?? 'http://127.0.0.1:8787';
const WS = HTTP.replace(/^http/, 'ws') + '/';
const MODE = CREATE_TOKEN ? 'hs256' : 'none';
/** 만들기 토큰의 표시 이름(서명은 서버가 확인) */
const CREATOR = (() => { try { return JSON.parse(Buffer.from(CREATE_TOKEN.split('.')[1] ?? '', 'base64url').toString()).name ?? null; } catch { return null; } })();
/** 이름 칸이 뜨면 이름을 넣어 들어간다. 칸이 떴는지 돌려준다 */
const answerName = async (page, name, ms = 15_000) => {
  const input = await page.waitForSelector('[data-collab="name-input"]', { timeout: ms }).catch(() => null);
  if (!input) return false;
  await input.type(name);
  await page.click('[data-collab="name-submit"]');
  return true;
};

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
  console.log(`  서버 ${HTTP} (인증 ${MODE})`);
  // A: 평소 studio — 메뉴가 뜨고 콘솔 오류가 없다(hs256 이면 #create= 로 연다)
  const A = await tab(browser, 'A', `${STUDIO}/${CREATE_TOKEN ? `#create=${encodeURIComponent(CREATE_TOKEN)}` : ''}`);
  const menu = await A.waitForSelector(MENU, { timeout: 30_000 }).catch(() => null);
  record('평소 studio 에 "공동편집 시작…" 메뉴', Boolean(menu), menu ? '' : '메뉴 없음(서버의 /healthz 가 auth 를 알려야 한다)');
  if (!menu) throw new Error('메뉴 없음');
  if (CREATE_TOKEN) record('만들기 토큰을 주소에서 지움', !(await A.evaluate(() => location.hash)).includes('create'), await A.evaluate(() => location.hash));
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
  const wantScopes = MODE === 'hs256' ? ['edit', 'view', 'form', 'comment'] : ['edit'];
  const scopesOk = JSON.stringify(links.map(([s]) => s)) === JSON.stringify(wantScopes) && (MODE === 'none' || links.every(([, u]) => /#token=/.test(u)));
  record('방을 만들고 링크를 보여 줌', Boolean(edit) && /\?collab(=[^#]*)?#.*room=/.test(edit) && scopesOk, JSON.stringify(links.map(([s, u]) => [s, u.replace(/token=[^&]+/, 'token=…')])));

  // B: 편집 링크로 들어온다 — 같은 문서
  const B = await tab(browser, 'B', edit);
  // 초대 토큰에는 이름이 없다 — hs256 이면 화면 안 칸으로 묻는다(인증을 끈 서버의 링크에는 토큰이 없어 묻지 않는다)
  const askedB = MODE === 'hs256' ? await answerName(B, 'B') : false;
  if (MODE === 'hs256') record('초대 링크로 들어오는 탭은 화면 안 칸으로 이름을 물음(브라우저 대화상자 없음)', askedB && B.dialogs.length === 0, `칸 ${askedB}, 대화상자 ${JSON.stringify(B.dialogs)}`);
  await joined(B);
  const bText = await text(B);
  record('다른 탭이 편집 링크로 들어오면 같은 문서', bText === original, JSON.stringify(bText));

  // A: "이 방으로 들어가기" — 새로 열리며 들어가고, 편집이 B 와 수렴
  const navigated = A.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).then(() => true, () => false);
  await A.evaluate(() => { document.querySelector('[data-collab="launcher-enter"]').click(); });
  record('"이 방으로 들어가기" 로 편집 링크로 이동', await navigated, `${A.url().replace(/token=[^&]+/, 'token=…')} 대화상자 ${JSON.stringify(A.dialogs)}`);
  await A.waitForFunction(() => window.__inputHandler, { timeout: 90_000, polling: 250 });
  await joined(A);
  if (MODE === 'hs256' && CREATOR) {
    const askedA = await A.evaluate(() => Boolean(document.querySelector('[data-collab="name-input"]')));
    const nameA = (await A.evaluate(() => window.__collab.status())).user?.name;
    record('만든 사람은 "이 방으로 들어가기"에서 이름을 다시 묻지 않고 만들기 토큰의 이름으로 들어감', !askedA && nameA === CREATOR && !A.dialogs.some((d) => d.startsWith('prompt')),
      `이름 칸 ${askedA}, 이름 ${nameA}(토큰 ${CREATOR}), 대화상자 ${JSON.stringify(A.dialogs)}`);
  }
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
  // 이탈 확인(beforeunload)이 뜨면 실패(이름은 화면 안 칸으로 묻는다 — 브라우저 대화상자가 아니다)
  const unload = A.dialogs.filter((d) => d.startsWith('beforeunload'));
  record('들어가기에서 "저장하지 않은 변경" 확인이 뜨지 않음', unload.length === 0, A.dialogs.join(' | '));
  record('평소 studio·방 만들기에서 콘솔 오류 없음', A.errors.length === 0, A.errors.join(' | '));

  // hs256: 만들기 토큰이 없는 탭은 대화상자의 입력 칸으로 만든다
  if (CREATE_TOKEN) {
    const D = await tab(browser, 'D', `${STUDIO}/`);
    await D.waitForSelector(MENU, { timeout: 30_000 });
    await openLauncher(D);
    const input = await D.waitForSelector('[data-collab="launcher-token"]', { timeout: 10_000 }).catch(() => null);
    if (input) {
      await input.type(CREATE_TOKEN);
      await D.click('[data-collab="launcher-create"]');
    }
    const made = await D.waitForSelector('[data-collab="launcher-link"]', { timeout: 30_000 }).then(() => true, () => false);
    record('만들기 토큰이 없는 탭은 입력 칸으로 방을 만든다', Boolean(input) && made);
  }

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

  // 첫 참여자 확인(D5, 플러그인): 암호 HWPX 를 연 채 새 방에 처음 들어간다 — 주소를 공동편집 주소로 바꾸고 플러그인을 올린다
  // (새로 열면 연 문서가 사라지므로). base 를 올리지 않고 나가며, 서버에 그 방의 문서가 없다.
  await C.evaluate(() => document.querySelector('[data-collab="launcher"]')?.remove());
  const room = `enc-${Date.now().toString(36)}`;
  if (MODE === 'hs256' && !JOIN_TOKEN) {
    record('첫 참여자 암호 확인', false, 'hs256 서버에는 D3_JOIN_TOKEN(모든 방 edit 토큰)이 필요하다');
  } else {
    await C.evaluate((ws, r, token) => {
      const frag = new URLSearchParams();
      if (token) frag.set('token', token);
      frag.set('room', r);
      history.replaceState(null, '', `/?collab=${encodeURIComponent(ws)}#${frag}`);
      return window.rhwpStudio.plugins.load('collab').then(() => true);
    }, WS, room, JOIN_TOKEN);
    const banner = await C.waitForFunction(() => document.querySelector('[data-collab="desynced"]')?.textContent ?? null, { timeout: 30_000, polling: 250 })
      .then((h) => h.jsonValue(), () => null);
    const left = await C.evaluate(() => window.__collab?.status().left ?? null);
    const doc = await fetch(`${HTTP}/rooms/${encodeURIComponent(room)}/document`, { headers: JOIN_TOKEN ? { authorization: `Bearer ${JOIN_TOKEN}` } : {} });
    if (MODE === 'none') {
      record('첫 참여자로 암호 HWPX — base 를 올리지 않고 나감, 서버에 문서 없음', typeof banner === 'string' && banner.includes(ENCRYPTED_TEXT) && left === true && doc.status === 404,
        `${JSON.stringify(banner)} left ${left}, GET 문서 ${doc.status}`);
    } else {
      // 인증을 켠 서버는 방을 파일로만 만든다(POST /rooms — 정본이 그 파일을 열어 본다). 없는 방에 들어가면 "방이 없습니다" —
      // 첫 참여자가 base 를 올리는 경로 자체가 없다(암호 파일은 POST /rooms 의 encrypted 거절이 막는다)
      const shown = await C.evaluate(() => [...document.querySelectorAll('[data-collab="unauthorized"]')].map((e) => e.textContent).join(' '));
      record('인증 서버: 없는 방에는 들어가지 못함(첫 참여자 경로 없음), 서버에 문서 없음', /방이 없습니다/.test(shown) && left === true && doc.status === 404, `${JSON.stringify(shown)} left ${left}, GET 문서 ${doc.status}`);
    }
  }
} catch (error) {
  record('시나리오 실행', false, error.stack ?? String(error));
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exitCode = failed.length ? 1 : 0;
