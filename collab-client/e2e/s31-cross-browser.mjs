// S3-1 브라우저 간 시험 (docs/collab-stage3.md S3-1, W1): 서로 다른 브라우저 엔진·운영체제가 같은 방에서 같은
// 문서를 편집하고, 매 묶음의 digest 가 서로 같고 Node(엔진 기본 글꼴 환경 — 서버 정본과 같은 환경)와도 같은지 본다.
// 글꼴 정책 bundled-only 가 걸려 있어야 한다(플러그인이 연결 때 건다).
//
// 준비: node server/server.mjs (8787, 정본 켬) + (cd upstream/rhwp/rhwp-studio && npx vite) (7700) + WASM 빌드(pkg/)
// 실행: PLAYWRIGHT_CORE=<playwright-core 경로> [S31_BROWSERS=...] node collab-client/e2e/s31-cross-browser.mjs [문서 경로]
//   - S31_BROWSERS: 참여 브라우저(쉼표). 기본 `chromium,webkit`.
//       chromium        이 기기의 Google Chrome(CHROME_PATH)
//       webkit, firefox Playwright 가 받아 둔 브라우저(이 스크립트는 내려받지 않는다)
//       cdp:<url>       이미 떠 있는 원격 Chrome 에 CDP 로 붙는다(예: SSH 로 띄운 Windows Chrome —
//                       `ssh -L 9222:127.0.0.1:9222 -R 7700:… -R 8787:… <host> "chrome --headless=new
//                       --remote-debugging-port=9222 --user-data-dir=…"` 뒤 `cdp:http://127.0.0.1:9222`).
//                       원격 Chrome 은 자기 localhost 로 이 기기의 studio·서버를 연다(STUDIO_URL·COLLAB_URL 이 같아야 한다).
//   - Chromium 계열(chromium·cdp)은 방에 들어가기 전에 로컬 글꼴 권한을 주고, studio 의 로컬 글꼴 감지를 한 번
//     돌려 저장해 둔다(S31_PRIME_LOCAL_FONTS=0 이면 생략). "글꼴이 설치돼 있고 혼자 쓸 때 감지까지 허락한 사용자"가
//     방에 들어와도 조판이 엔진 기본 환경(environmentId null, Canvas 보충 측정 끔)이고 digest 가 같은지가 요점이다.
//   - 표시 경로(기록용, 실패 조건 아님): 업스트림 FontLoader 는 OS 에 설치된 문서 글꼴이면 웹 face 를 등록하지 않아
//     화면을 OS 글꼴로 그리고, 메타파일 글꼴 세션은 저장된 로컬 글꼴을 읽는다. 둘 다 조판과 무관하다(S3-1 정정).
//     어떤 문서 글꼴을 OS 글꼴로 그렸는지 0단계에 적는다.
//   - 편집 단계는 라운드마다 맡는 참여자를 한 칸씩 돌린다(S31_ROUNDS, 기본 참여자 수) — 모든 참여자가 모든 종류의
//     편집(긴 글·문단 나눔·정렬·줄 간격·각주·범위 서식)을 한 번씩 하고, 매 라운드 끝에 모두가 동시에 입력한다.
//   - S31_SHOTS=<디렉터리>: 들어온 직후와 끝에 참여자별 화면을 PNG 로(업스트림 문서 내용이 담기므로 저장소 밖).
//   - 문서를 주지 않으면 업스트림 samples/biz_plan.hwp.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
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
const HEADLESS = process.env.HEADFUL !== '1';
const SPECS = (process.env.S31_BROWSERS ?? 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);
const PRIME = process.env.S31_PRIME_LOCAL_FONTS !== '0';
const SHOTS = process.env.S31_SHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shoot = async (pages, tag) => {
  if (!SHOTS) return;
  for (const p of pages) await p.screenshot({ path: path.join(SHOTS, `${tag}-${p.tabName}.png`) });
};

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 방 준비: Node 에서 문서를 base 로 올린다(모든 브라우저가 늦은 참여자로 같은 바이트를 연다) ──
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
/** 참여자 정의: {name, chromiumLike, open() → Browser} */
function participant(spec) {
  if (spec === 'chromium') return { name: 'Chromium', chromiumLike: true, open: () => pw.chromium.launch({ executablePath: CHROME, headless: HEADLESS, args: ['--lang=ko-KR'] }) };
  if (spec === 'webkit') return { name: 'WebKit', chromiumLike: false, open: () => pw.webkit.launch({ headless: HEADLESS }) };
  if (spec === 'firefox') return { name: 'Firefox', chromiumLike: false, open: () => pw.firefox.launch({ headless: HEADLESS }) };
  if (spec.startsWith('cdp:')) {
    const url = spec.slice(4);
    return { name: 'RemoteChrome', chromiumLike: true, remote: url, open: () => pw.chromium.connectOverCDP(url) };
  }
  throw new Error(`모르는 브라우저: ${spec}`);
}

/**
 * 혼자 쓸 때 로컬 글꼴 감지를 허락해 둔 사용자를 만든다: 권한을 주고, studio 를 문서 없이 열어 감지 결과를
 * 이 브라우저 컨텍스트 저장소에 남긴다. 반환: 감지된 face 수.
 */
async function primeLocalFonts(ctx) {
  await ctx.grantPermissions(['local-fonts'], { origin: STUDIO });
  const page = await ctx.newPage();
  try {
    await page.goto(STUDIO, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__localFonts && window.__wasm, null, { timeout: 120_000 });
    return await page.evaluate(async () => {
      await window.__localFonts.detectLocalFonts({ force: true });
      const s = window.__localFonts.getLocalFontState();
      return { stored: s.stored, count: s.count, method: s.method };
    });
  } finally {
    await page.close();
  }
}

async function openTab(browser, p) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
  let primed = null;
  if (p.chromiumLike && PRIME) primed = await primeLocalFonts(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`    [${p.name} pageerror] ${e.message}`));
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('[collab') && /나감|어긋|diverged|재동기화/.test(t)) console.log(`    [${p.name}] ${t.slice(0, 200)}`); });
  await page.goto(`${STUDIO}/?collab=${encodeURIComponent(COLLAB)}&room=${room}&name=${p.name}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__collab?.status().ready && window.__inputHandler, null, { timeout: 120_000 });
  page.tabName = p.name;
  page.primed = primed;
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
/** 조판 쪽 정책 확인 + 표시 경로(렌더 백엔드·로드된 웹 글꼴·로컬 글꼴 상태) */
const probe = (page) => page.evaluate(() => {
  const d = window.__wasm.doc;
  const faces = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/^["']|["']$/g, ''));
  const families = new Set(faces);
  const used = window.__wasm.getDocumentInfo?.().fontsUsed ?? [];
  const lf = window.__localFonts?.getLocalFontState?.() ?? {};
  // 업스트림 FontLoader.isSystemFontAvailable 과 같은 방식(폭 비교) — 웹 face 가 없는 문서 글꼴을 OS 가 갖고 있는가
  const systemHas = (name) => {
    const probe = document.createElement('span');
    probe.textContent = 'mmmmmmmmmwwwwwwwWMWMWM한글글꼴측정0123456789';
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'nowrap', fontSize: '72px' });
    document.body.appendChild(probe);
    try {
      return ['monospace', 'serif', 'sans-serif'].some((g) => {
        probe.style.fontFamily = g;
        const w = probe.offsetWidth;
        probe.style.fontFamily = `"${name.replace(/(["\\])/g, '\\$1')}", ${g}`;
        return probe.offsetWidth !== w;
      });
    } finally {
      probe.remove();
    }
  };
  const withoutWebFace = used.filter((f) => !families.has(f));
  return {
    environmentId: JSON.parse(d.getDocumentFontSelectionPlan()).environmentId,
    canvasMetrics: d.canvasMetricsActive?.() ?? null,
    backend: window.__canvasView?.getRenderBackend?.() ?? null,
    backendFallback: window.__renderBackendFallbackReason ?? null,
    loadedFaces: faces.length,
    docFontsWithoutWebFace: withoutWebFace,
    osGlyphFonts: withoutWebFace.filter(systemHas),
    localFonts: { loaded: lf.loaded ?? null, stored: lf.stored ?? null, count: lf.count ?? null },
    platform: navigator.userAgent.match(/\(([^;)]+)/)?.[1] ?? navigator.platform,
  };
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
/** 편집 종류 — 라운드마다 맡는 참여자가 한 칸씩 돈다 */
const KINDS = [
  ['문단 0 앞에 긴 글(여러 줄)', async (p) => { await caretAt(p, 0, 0); await p.keyboard.insertText(LONG_KO + LONG_KO); }],
  ['문단 1 끝에 글 + Enter + 글', async (p) => { await caretAt(p, 1, await paraLen(p, 1)); await p.keyboard.insertText(LONG_KO); await p.keyboard.press('Enter'); await p.keyboard.insertText(`${p.tabName} 이 친 새 문단 `.repeat(6)); }],
  ['문단 0 가운데 정렬(조판 의존 applyParaFormat)', async (p) => { await caretAt(p, 0, 3); await exec(p, 'format:align-center'); }],
  ['문단 1 오른쪽 정렬 + 줄 간격 늘림', async (p) => { await caretAt(p, 1, 2); await exec(p, 'format:align-right'); await exec(p, 'format:line-spacing-increase'); }],
  ['각주 넣기(조판 의존 insertFootnote)', async (p) => { await caretAt(p, 0, 10); await exec(p, 'insert:footnote'); await p.keyboard.insertText(`각주 안의 글 ${p.tabName}`); }],
  ['굵게(범위) + 양쪽 정렬', async (p) => {
    await caretAt(p, 0, 0);
    await p.evaluate(() => { const ih = window.__inputHandler; ih.cursor.setAnchor?.(); });
    for (let i = 0; i < 12; i += 1) await p.keyboard.press('Shift+ArrowRight');
    await exec(p, 'format:bold');
    await exec(p, 'format:align-justify');
  }],
];

const browsers = [];
try {
  const parts = SPECS.map(participant);
  const names = new Set();
  for (const p of parts) {
    const stem = p.name;
    for (let i = 2; names.has(p.name); i += 1) p.name = `${stem}${i}`;
    names.add(p.name);
  }
  const pages = [];
  const versions = {};
  for (const p of parts) {
    const browser = await p.open();
    browsers.push({ browser, remote: Boolean(p.remote) });
    versions[p.name] = browser.version();
    pages.push(await openTab(browser, p));
  }
  const N = pages.length;
  const probes = await Promise.all(pages.map(probe));
  const policyLine = pages.map((pg, i) => `${pg.tabName}[${probes[i].platform}] env=${probes[i].environmentId} canvas=${probes[i].canvasMetrics}${pg.primed ? ` 로컬 글꼴 권한·감지 저장 ${pg.primed.count}개(${pg.primed.method})` : ''}`).join('\n      ');
  record(`0. ${N}개 브라우저가 방에 들어옴, 조판은 엔진 기본 환경(선언 환경 없음·Canvas 보충 측정 끔)${PRIME ? ' — Chromium 계열은 로컬 글꼴을 감지·저장한 뒤 들어옴' : ''}`,
    probes.every((p) => p.environmentId === null && p.canvasMetrics === false) && pages.every((pg) => !pg.primed || pg.primed.stored),
    `${JSON.stringify(versions)}\n      ${policyLine}`);
  // 기록용(실패 조건 아님): 표시 경로
  for (const [i, pg] of pages.entries()) {
    const p = probes[i];
    console.log(`INFO  표시 ${pg.tabName}: backend=${p.backend}${p.backendFallback ? `(${p.backendFallback})` : ''} 웹 face ${p.loadedFaces}개, OS 글꼴로 그린 문서 글꼴 ${JSON.stringify(p.osGlyphFonts)}, 웹 face·OS 글꼴 모두 없음(CSS 대체) ${JSON.stringify(p.docFontsWithoutWebFace.filter((f) => !p.osGlyphFonts.includes(f)))}, 로컬 글꼴 상태(방) ${JSON.stringify(p.localFonts)}`);
  }
  await shoot(pages, 'start');
  const d0 = await Promise.all(pages.map(digest));
  const n0 = await nodeDigest();
  record('0. 열자마자 digest 가 모든 브라우저·Node 에서 같음', d0.every((d) => d === n0.digest), `${d0.map((d) => d.slice(0, 10)).join(' ')} node ${n0.digest.slice(0, 10)}`);

  const ROUNDS = Number(process.env.S31_ROUNDS ?? N);
  const check = async (label) => {
    const st = await settle(pages);
    const ds = await Promise.all(pages.map(digest));
    const n = await nodeDigest();
    const ok = st.every((s) => !s.desynced && !s.left) && ds.every((d) => d === n.digest) && st.every((s) => s.lastSeq === n.seq);
    record(label, ok, `seq ${st.map((s) => s.lastSeq).join('/')} node ${n.seq}, digest ${[...new Set(ds.map((d) => d.slice(0, 10)))].join(' ')} node ${n.digest.slice(0, 10)}${st.some((s) => s.desynced) ? ' DESYNCED' : ''}`);
  };
  for (let r = 0; r < ROUNDS; r += 1) {
    for (let k = 0; k < KINDS.length; k += 1) {
      const p = pages[(k + r) % N];
      await KINDS[k][1](p);
      await check(`${r + 1}-${k + 1}. ${p.tabName}: ${KINDS[k][0]}`);
    }
    await Promise.all(pages.map(async (p, i) => { await caretAt(p, 4 + i, 0); await p.keyboard.insertText(`동시 ${p.tabName} `.repeat(8)); }));
    await check(`${r + 1}-${KINDS.length + 1}. 동시에: ${N}개 브라우저가 서로 다른 문단에 입력`);
  }
  await shoot(pages, 'end');
  const final = await Promise.all(pages.map(status));
  record('끝까지 어긋남·재동기화 없음', final.every((s) => !s.desynced && !s.left && s.resyncCount === 0), final.map((s) => `${s.name}: resync ${s.resyncCount}`).join(', '));
} catch (error) {
  record('시나리오 실행', false, error.stack ?? String(error));
} finally {
  // 원격(CDP)은 이 스크립트가 만든 컨텍스트만 닫고 연결을 끊는다(브라우저 프로세스는 띄운 쪽이 끈다).
  for (const { browser } of browsers) await browser.close().catch(() => {});
  seed.ws.close();
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exitCode = failed.length ? 1 : 0;
