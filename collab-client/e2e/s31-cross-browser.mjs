// S3-1 브라우저 간 시험 (docs/collab-stage3.md S3-1): 서로 다른 브라우저 엔진(Chromium·WebKit)이 같은 방에서
// 같은 문서를 편집하고, 매 묶음의 digest 가 서로 같고 Node(엔진 기본 글꼴 환경 — 서버 정본과 같은 환경)와도
// 같은지 본다. 글꼴 정책 bundled-only 가 걸려 있어야 한다(플러그인이 연결 때 건다).
//
// 준비: node server/server.mjs (8787) + (cd upstream/rhwp/rhwp-studio && npx vite) (7700) + WASM 빌드(pkg/)
// 실행: PLAYWRIGHT_CORE=<playwright-core 경로> node collab-client/e2e/s31-cross-browser.mjs [문서 경로]
//   - playwright-core 와 그 버전의 브라우저(webkit·chromium)가 로컬에 있어야 한다(내려받지 않는다).
//   - Chromium 은 기본으로 설치된 Google Chrome(CHROME_PATH)을 쓴다.
//   - 문서를 주지 않으면 업스트림 samples/biz_plan.hwp.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const { WebSocket } = createRequire(path.join(root, 'server/package.json'))('ws');
const { loadWasm } = await import(path.join(root, 'collab-client/test/support/harness.mjs'));
const { CollabEngine } = await import(path.join(root, 'collab-client/src/engine/engine.ts'));
const { ENGINE_FINGERPRINT } = await import(path.join(root, 'collab-client/src/engine/catalog.ts'));

const STUDIO = process.env.STUDIO_URL ?? 'http://127.0.0.1:7700';
const COLLAB = process.env.COLLAB_URL ?? 'ws://127.0.0.1:8787';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DOC = process.argv[2] ?? path.join(root, 'upstream/rhwp/samples/biz_plan.hwp');

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 방 준비: Node 에서 문서를 base 로 올린다(두 브라우저 모두 늦은 참여자로 같은 바이트를 연다) ──
const wasm = await loadWasm();
const room = `s31-${Date.now()}`;
const seedDoc = new wasm.HwpDocument(readFileSync(DOC));
const base = Buffer.from(seedDoc.collabExportState()).toString('base64');
seedDoc.free();
const rawClient = (name) => new Promise((resolve, reject) => {
  const ws = new WebSocket(COLLAB);
  const inbox = [];
  ws.on('message', (data) => inbox.push(JSON.parse(String(data))));
  ws.once('error', reject);
  ws.once('open', () => {
    ws.send(JSON.stringify({ type: 'hello', room, clientId: `${name}-${Date.now()}`, name, engine: ENGINE_FINGERPRINT }));
    resolve({ ws, inbox, next: async (type, ms = 10_000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return inbox.splice(i, 1)[0];
        if (Date.now() > deadline) throw new Error(`${name}: ${type} 를 받지 못함`);
        await sleep(50);
      }
    } });
  });
});
const seed = await rawClient('seed');
const w0 = await seed.next('welcome');
if (w0.base !== null) throw new Error('새 방이어야 한다');
seed.ws.send(JSON.stringify({ type: 'base', data: base }));

// ── 브라우저 ──
async function openTab(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`    [${name} pageerror] ${e.message}`));
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('[collab') && /나감|어긋|diverged|재동기화/.test(t)) console.log(`    [${name}] ${t.slice(0, 200)}`); });
  await page.goto(`${STUDIO}/?collab=${encodeURIComponent(COLLAB)}&room=${room}&name=${name}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__collab?.status().ready && window.__inputHandler, null, { timeout: 120_000 });
  page.tabName = name;
  return page;
}
const status = (page) => page.evaluate(() => window.__collab.status());
let lastSeq = 0;
async function settle(pages, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  await sleep(400);
  let last;
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
const caretAt = async (page, para, offset) => {
  await page.bringToFront();
  await page.evaluate(([p, o]) => {
    const ih = window.__inputHandler;
    ih.cursor.clearSelection();
    ih.cursor.moveTo({ sectionIndex: 0, paragraphIndex: p, charOffset: o });
    ih.textarea.focus();
  }, [para, offset]);
};
const exec = (page, id) => page.evaluate((id) => { window.rhwpStudio.automation.execute(id); window.__inputHandler.textarea.focus(); }, id);
const paraLen = (page, p) => page.evaluate((p) => window.__wasm.getParagraphLength(0, p), p);
const digest = (page) => page.evaluate(() => window.__collab.digest());
const fontPolicy = (page) => page.evaluate(() => {
  const d = window.__wasm.doc;
  return { environmentId: JSON.parse(d.getDocumentFontSelectionPlan()).environmentId, canvasMetrics: d.canvasMetricsActive?.() ?? null };
});

/** Node: 서버 기록(welcome)을 받아 엔진 기본 환경에서 재생한 digest — 서버 정본(S3-2)과 같은 환경 */
async function nodeDigest() {
  const late = await rawClient('node');
  const w = await late.next('welcome');
  late.ws.close();
  const doc = new wasm.HwpDocument(gunzipSync(Buffer.from(w.base, 'base64')));
  const engine = new CollabEngine({ onLocal() {}, onWarn() {} });
  engine.attach(doc);
  engine.replayAll(w.log);
  const d = doc.collabDigest();
  engine.detach();
  doc.free();
  return { seq: w.seq, digest: d };
}

const LONG_KO = '공동편집 기기 간 시험: 줄나눔이 브라우저마다 같아야 한다. 한글과 English, 숫자 1234567890, 기호 ※·「」·— 가 섞인 긴 문장으로 여러 줄을 만든다. ';
const browsers = [];
try {
  const chromium = await pw.chromium.launch({ executablePath: CHROME, headless: process.env.HEADFUL !== '1', args: ['--lang=ko-KR'] });
  browsers.push(chromium);
  const webkit = await pw.webkit.launch({ headless: process.env.HEADFUL !== '1' });
  browsers.push(webkit);
  const C = await openTab(chromium, 'Chromium');
  const W = await openTab(webkit, 'WebKit');
  const pages = [C, W];
  const engines = { Chromium: chromium.version(), WebKit: webkit.version() };
  const policies = await Promise.all(pages.map(fontPolicy));
  record('0. 두 엔진이 방에 들어옴, 글꼴 정책이 걸림(선언 환경 없음·Canvas 보충 측정 끔)',
    policies.every((p) => p.environmentId === null && p.canvasMetrics === false), `${JSON.stringify(engines)} ${JSON.stringify(policies)}`);
  const d0 = await Promise.all(pages.map(digest));
  const n0 = await nodeDigest();
  record('0. 열자마자 digest 가 두 엔진·Node 에서 같음', d0[0] === d0[1] && d0[0] === n0.digest, `${d0.map((d) => d.slice(0, 10)).join(' ')} node ${n0.digest.slice(0, 10)}`);

  const steps = [
    ['1. Chromium: 문단 0 앞에 긴 글(여러 줄)', async () => { await caretAt(C, 0, 0); await C.keyboard.insertText(LONG_KO + LONG_KO); }],
    ['2. WebKit: 문단 1 끝에 글 + Enter + 글', async () => { await caretAt(W, 1, await paraLen(W, 1)); await W.keyboard.insertText(LONG_KO); await W.keyboard.press('Enter'); await W.keyboard.insertText('WebKit 이 친 새 문단 '.repeat(6)); }],
    ['3. Chromium: 문단 0 가운데 정렬(조판 의존 applyParaFormat)', async () => { await caretAt(C, 0, 3); await exec(C, 'format:align-center'); }],
    ['4. WebKit: 문단 1 오른쪽 정렬 + 줄 간격 늘림', async () => { await caretAt(W, 1, 2); await exec(W, 'format:align-right'); await exec(W, 'format:line-spacing-increase'); }],
    ['5. Chromium: 각주 넣기(조판 의존 insertFootnote)', async () => { await caretAt(C, 0, 10); await exec(C, 'insert:footnote'); await C.keyboard.insertText('각주 안의 글 Chromium'); }],
    ['6. 동시에: 두 엔진이 서로 다른 문단에 입력', async () => {
      await Promise.all([
        (async () => { await caretAt(C, 2, 0); await C.keyboard.insertText('동시 Chromium '.repeat(8)); })(),
        (async () => { await caretAt(W, 3, 0); await W.keyboard.insertText('동시 WebKit '.repeat(8)); })(),
      ]);
    }],
    ['7. WebKit: 굵게(범위) + 양쪽 정렬', async () => {
      await caretAt(W, 0, 0);
      await W.evaluate(() => { const ih = window.__inputHandler; ih.cursor.setAnchor?.(); });
      for (let i = 0; i < 12; i += 1) await W.keyboard.press('Shift+ArrowRight');
      await exec(W, 'format:bold');
      await exec(W, 'format:align-justify');
    }],
  ];
  for (const [label, run] of steps) {
    await run();
    const st = await settle(pages);
    const ds = await Promise.all(pages.map(digest));
    const n = await nodeDigest();
    const ok = st.every((s) => !s.desynced && !s.left) && ds[0] === ds[1] && n.seq === st[0].lastSeq && ds[0] === n.digest;
    record(label, ok, `seq ${st.map((s) => s.lastSeq).join('/')} node ${n.seq}, digest ${ds.map((d) => d.slice(0, 10)).join(' ')} node ${n.digest.slice(0, 10)}${st.some((s) => s.desynced) ? ' DESYNCED' : ''}`);
  }
  const final = await Promise.all(pages.map(status));
  record('8. 끝까지 어긋남·재동기화 없음', final.every((s) => !s.desynced && !s.left && s.resyncCount === 0), final.map((s) => `${s.name}: resync ${s.resyncCount}`).join(', '));
} catch (error) {
  record('시나리오 실행', false, error.stack ?? String(error));
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  seed.ws.close();
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exitCode = failed.length ? 1 : 0;
