// S3-2 브라우저 검증 (docs/collab-stage3.md S3-2 관문): 서버 정본이 잘못된 묶음을 거절하고 방은 계속된다.
//  - 다른 참여자(원시 WebSocket)가 범위 초과·기록할 수 없는 기능·패닉 유발(WASM trap) 묶음을 넣어도 거절되고,
//    두 탭은 영향 없이 편집을 이어 간다(재동기화 없음, digest 가 정본과 같음). 패닉 뒤 정본 워커는 다시 만들어진다.
//  - 기록 밖에서 문서가 바뀐 탭이 "자기 문서에서는 맞지만 정본에서는 틀린" 편집을 보내면 그 탭만 거절·재동기화된다.
//
// 준비: (cd upstream/rhwp/rhwp-studio && npx vite) (7700). 서버는 이 스크립트가 8790 에 정본 모드로 띄운다.
// 실행: node collab-client/e2e/s32-canonical.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const puppeteer = createRequire(path.join(root, 'upstream/rhwp/rhwp-studio/package.json'))('puppeteer-core');
const { WebSocket } = createRequire(path.join(root, 'server/package.json'))('ws');
const { startServer } = await import(path.join(root, 'server/server.mjs'));
const { ENGINE_FINGERPRINT } = await import(path.join(root, 'collab-client/src/engine/catalog.ts'));

const STUDIO = process.env.STUDIO_URL ?? 'http://127.0.0.1:7700';
const PORT = 8790;
const COLLAB = `ws://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serverLog = [];
const server = startServer({ port: PORT, log: (m) => serverLog.push(m) });
await server.ready;
const room = `s32-${Date.now()}`;

async function openTab(ctx, name) {
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => console.log(`    [${name} pageerror] ${e.message}`));
  await page.goto(`${STUDIO}/?collab=${encodeURIComponent(COLLAB)}&room=${room}&name=${name}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__collab?.status().ready && window.__inputHandler, { timeout: 90_000 });
  return page;
}
const status = (page) => page.evaluate(() => window.__collab.status());
const waitFor = async (page, pred, ms = 20_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await status(page);
    if (pred(s) || Date.now() > deadline) return s;
    await sleep(150);
  }
};
const settled = (pages) => Promise.all(pages.map((p) => waitFor(p, (s) => !s.inflight && !s.pending && !s.resyncing && s.digestSentSeq === s.lastSeq)));
async function type(page, para, offset, text) {
  await page.bringToFront();
  await page.evaluate(([p, o]) => {
    const ih = window.__inputHandler;
    ih.cursor.clearSelection();
    ih.cursor.moveTo({ sectionIndex: 0, paragraphIndex: p, charOffset: o });
    ih.textarea.focus();
  }, [para, offset]);
  await page.keyboard.type(text);
}
const canonOf = () => server.rooms.get(room);
const matchesCanon = async (pages) => {
  const r = canonOf();
  await r.queue;
  const canon = (await r.canonical.digest()).digest;
  const ds = await Promise.all(pages.map((p) => p.evaluate(() => window.__collab.digest())));
  return { ok: ds.every((d) => d === canon), detail: `seq ${r.seq} 정본 ${canon.slice(0, 10)} 탭 ${ds.map((d) => d.slice(0, 10)).join(' ')}` };
};

const browser = await puppeteer.launch({ headless: process.env.HEADFUL !== '1', executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu', '--lang=ko-KR'] });
try {
  const ctx = await browser.createBrowserContext();
  const A = await openTab(ctx, 'A');
  const B = await openTab(ctx, 'B');
  await type(A, 0, 0, 'canonical room ');
  await type(B, 0, 0, 'B joins ');
  await settled([A, B]);
  let m = await matchesCanon([A, B]);
  record('1. 두 탭의 편집이 정본에 먼저 적용되고 digest 가 정본과 같음', m.ok, m.detail);

  // 원시 참여자 X 가 잘못된 묶음을 넣는다
  const x = new WebSocket(COLLAB);
  const inbox = [];
  x.on('message', (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r) => x.once('open', r));
  x.send(JSON.stringify({ type: 'hello', room, clientId: 'X', name: 'X', engine: ENGINE_FINGERPRINT }));
  await sleep(300);
  const gen = canonOf().canonical.generation;
  const bad = [
    ['범위 초과', [{ kind: 'op', m: 'insertText', a: [0, 99_999, 0, 'x'] }]],
    ['기록할 수 없는 기능', [{ kind: 'op', m: 'exportHwp', a: [] }]],
    ['패닉 유발(&str 자리에 숫자)', [{ kind: 'op', m: 'insertText', a: [0, 0, 0, 7] }]],
  ];
  for (const [label, entries] of bad) {
    const seq = canonOf().seq;
    x.send(JSON.stringify({ type: 'ops', base: seq, entries }));
    const deadline = Date.now() + 15_000;
    while (!inbox.some((msg) => msg.type === 'invalid') && Date.now() < deadline) await sleep(50);
    const inv = inbox.findIndex((msg) => msg.type === 'invalid');
    const got = inv >= 0 ? inbox.splice(inv, 1)[0] : null;
    record(`2. X 의 ${label} 묶음은 invalid 로 거절, seq 그대로`, got !== null && canonOf().seq === seq, got ? got.reason.slice(0, 80) : '응답 없음');
  }
  await canonOf().queue;
  record('3. 패닉 뒤 정본 워커를 다시 만듦', canonOf().canonical.generation === gen + 1, `세대 ${gen} → ${canonOf().canonical.generation}`);
  await type(A, 0, 3, ' after ');
  await type(B, 0, 0, 'still ');
  const st = await settled([A, B]);
  m = await matchesCanon([A, B]);
  record('4. 방은 계속: 두 탭이 이어서 편집, 재동기화 없음, digest 가 (재생성한) 정본과 같음', m.ok && st.every((s) => s.resyncCount === 0 && !s.desynced), `${m.detail}, resync ${st.map((s) => s.resyncCount).join('/')}`);

  // B 의 문서를 기록 밖에서 바꿔(문단 하나 더) 그 문단에 친다 — B 에서는 맞지만 정본에는 없는 문단
  await B.evaluate(() => {
    const d = window.__wasm.doc;
    const bytes = d.collabExportState();
    d.splitParagraph(0, 0, 0); // 기록되는 편집(보냄)
    const extra = d.collabExportState();
    d.collabLoadState(bytes); // 되돌림(기록 밖)
    d.collabLoadState(extra); // 다시 문단을 늘림(기록 밖) — B 만 문단이 하나 더
  });
  await settled([A, B]);
  const paras = await B.evaluate(() => window.__wasm.doc.getParagraphCount(0));
  await B.evaluate((p) => { window.__wasm.doc.insertText(0, p - 1, 0, 'ghost'); window.__inputHandler.triggerAfterEdit?.(); }, paras + 0);
  const bAfter = await waitFor(B, (s) => s.resyncCount > 0 && !s.resyncing && !s.inflight && !s.pending, 20_000);
  const aAfter = await status(A);
  await settled([A, B]);
  m = await matchesCanon([A, B]);
  record('5. 정본에 없는 문단에 친 B 는 거절·재동기화되어 정본으로 돌아옴, A 는 그대로', bAfter.resyncCount > 0 && aAfter.resyncCount === 0 && m.ok,
    `B resync ${bAfter.resyncCount}, A resync ${aAfter.resyncCount}, ${m.detail}`);
  x.close();
  await ctx.close();
} catch (error) {
  record('시나리오 실행', false, error.stack ?? String(error));
} finally {
  await browser.close();
  await server.close();
}
const failed = results.filter((r) => !r.ok);
if (failed.length) for (const line of serverLog.filter((l) => /invalid|DIVERGED|재생성|reject/.test(l)).slice(-12)) console.log(`    [server] ${line.slice(0, 200)}`);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exitCode = failed.length ? 1 : 0;
