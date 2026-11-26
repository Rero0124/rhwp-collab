// S3-3 관문 측정 (docs/collab-stage3.md S3-3 결정 "대가와 확인"): 계보 보존이라 기록이 길어지면 늦은 참여자와
// 재시작한 정본의 재생 시간이 는다. 중간 크기 문서에서 기록 1,000 / 10,000 묶음일 때
//   - 정본 복원(Node): 기준점 적재 + 기록 재생 — 프로세스 안 재생과 실제 정본 워커(Canonical.rebuild) 둘 다
//   - 늦은 참여(브라우저): 연결 → welcome(기준점 + 기록) 받아 문서 열기·재생 끝까지(플러그인 로그 시각)
// 기준: 10,000 묶음 재생이 5초를 넘으면 다음 단계에서 (D) 정규화 연산.
//
// 준비: (cd upstream/rhwp/rhwp-studio && npx vite) (7700). 서버는 이 스크립트가 8793 에 저장소와 함께 띄운다.
// 실행: node collab-client/e2e/s33-replay-cost.mjs [문서 경로]   (기본 upstream samples/exam_kor.hwp, 20쪽)
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const puppeteer = createRequire(path.join(root, 'upstream/rhwp/rhwp-studio/package.json'))('puppeteer-core');
const { loadWasm, Client, Server } = await import(path.join(root, 'collab-client/test/support/harness.mjs'));
const { CollabEngine } = await import(path.join(root, 'collab-client/src/engine/engine.ts'));
const { startServer } = await import(path.join(root, 'server/server.mjs'));
const { Canonical } = await import(path.join(root, 'server/canonical.mjs'));
const { LocalDocStore } = await import(path.join(root, 'server/doc-store.mjs'));
const { ENGINE_FINGERPRINT } = await import(path.join(root, 'collab-client/src/engine/catalog.ts'));

const STUDIO = process.env.STUDIO_URL ?? 'http://127.0.0.1:7700';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DOC = process.argv[2] ?? path.join(root, 'upstream/rhwp/samples/exam_kor.hwp');
const SIZES = [1000, 10000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = (x) => Math.round(x);

// ── 기록 만들기: 한 사람이 치는 묶음(대부분 몇 글자 입력, 가끔 문단 나누기·서식·지우기) ──
const wasm = await loadWasm();
const base = (() => { const d = new wasm.HwpDocument(readFileSync(DOC)); const b = gunzipSync(d.collabExportState()); d.free(); return b; })();
let s = 12345;
const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 2 ** 32; };
// S33_LOG_CACHE=<파일>: 만든 기록을 저장해 두고 다음 실행에 다시 쓴다(만들기가 오래 걸린다).
const CACHE = process.env.S33_LOG_CACHE;
let log;
let finalDigest;
const t0 = performance.now();
if (CACHE && existsSync(CACHE)) {
  ({ log, finalDigest } = JSON.parse(readFileSync(CACHE, 'utf8')));
  console.log(`기록 ${log.length}묶음 캐시에서 읽음`);
} else {
const server = new Server(base);
const w = new Client('W', base, server);
for (let n = 0; n < SIZES[SIZES.length - 1]; n += 1) {
  const d = w.doc;
  const paras = d.getParagraphCount(0);
  const p = Math.floor(rnd() * paras);
  const len = d.getParagraphLength(0, p);
  const off = Math.floor(rnd() * (len + 1));
  const x = rnd();
  try {
    if (x < 0.85) d.insertText(0, p, off, ['가', '나다', 'abc', '1', ' '][Math.floor(rnd() * 5)]);
    else if (x < 0.9) d.splitParagraph(0, p, off);
    else if (x < 0.95 && len > 1) d.applyCharFormat(0, p, 0, Math.min(len, 3), JSON.stringify({ bold: rnd() < 0.5 }));
    else if (len > 0) d.deleteText(0, p, Math.min(off, len - 1), 1);
    else d.insertText(0, p, 0, '가');
  } catch { /* 편집 불가 위치 — 건너뜀 */ }
  w.flush();
  server.drain([w]);
}
log = server.log.map(({ type, ...item }) => item);
console.log(`기록 ${log.length}묶음 만듦 (${ms(performance.now() - t0)}ms), 문서 ${path.basename(DOC)} ${base.length}B, 문단 ${w.doc.getParagraphCount(0)}`);
finalDigest = w.digest();
w.close();
if (CACHE) writeFileSync(CACHE, JSON.stringify({ log, finalDigest }));
}

const result = { doc: path.basename(DOC), baseBytes: base.length, nodeReplayMs: {}, canonicalRebuildMs: {}, browserJoinMs: {}, welcomeBytes: {} };

// ── 정본 복원(Node) ──
for (const n of SIZES) {
  const times = [];
  for (let r = 0; r < (n >= 10000 ? 1 : 3); r += 1) {
    const t = performance.now();
    const d = new wasm.HwpDocument(base);
    const e = new CollabEngine();
    e.attach(d);
    e.replayAll(log.slice(0, n));
    times.push(performance.now() - t);
    if (n === log.length && r === 0 && d.collabDigest() !== finalDigest) throw new Error('재생 digest 가 다름');
    e.detach();
    d.free();
  }
  result.nodeReplayMs[n] = ms(median(times));
  const c = new Canonical();
  const t = performance.now();
  const res = await c.rebuild(Buffer.from(gzipBase()).toString('base64'), log.slice(0, n));
  result.canonicalRebuildMs[n] = ms(performance.now() - t);
  if (!res.ok) throw new Error(`정본 재생성 실패: ${res.reason}`);
  await c.terminate();
}
function gzipBase() { const d = new wasm.HwpDocument(base); const g = d.collabExportState(); d.free(); return g; }
console.log(`정본 복원(Node): 재생 ${JSON.stringify(result.nodeReplayMs)} ms, 정본 워커 ${JSON.stringify(result.canonicalRebuildMs)} ms`);

// ── 늦은 참여(브라우저) ──
const browser = await puppeteer.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu', '--lang=ko-KR'], protocolTimeout: 3_600_000 });
try {
  for (const n of [0, ...SIZES]) {
    const dir = mkdtempSync(path.join(tmpdir(), 'cc-rhwp-s33m-'));
    const store = new LocalDocStore(dir);
    const room = `s33m-${n}`;
    await store.setBase(room, { baseSeq: 0, data: base, engine: ENGINE_FINGERPRINT, generation: 0 });
    for (const item of log.slice(0, n)) await store.append(room, item);
    const lines = [];
    const srv = startServer({ port: 8793, log: (m) => lines.push(m), store });
    await srv.ready;
    try {
      const times = [];
      for (let r = 0; r < (n >= 10000 ? 1 : 2); r += 1) {
        const page = await browser.newPage();
        let tOpen = 0;
        let tDone = 0;
        page.on('console', (m) => {
          const text = m.text();
          if (/\] 연결 ws:/.test(text) && !tOpen) tOpen = Date.now();
          if (/welcome seq=\d+, 기준점 뒤 \d+건 재생/.test(text)) tDone = Date.now();
        });
        await page.goto(`${STUDIO}/?collab=${encodeURIComponent('ws://127.0.0.1:8793')}&room=${room}&name=J${r}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction((seq) => window.__collab?.status().ready && window.__collab.status().lastSeq === seq, { timeout: 600_000, polling: 200 }, n);
        if (n > 0 && tDone === 0) await sleep(200);
        times.push(tDone - tOpen);
        console.log(`  브라우저 늦은 참여 n=${n} 시도 ${r + 1}: ${tDone - tOpen}ms`);
        await page.close();
        await sleep(300);
      }
      result.browserJoinMs[n] = ms(median(times));
      const wl = lines.find((l) => / welcome J/.test(l)) ?? '';
      result.welcomeBytes[n] = Number(/base=(\d+)B64/.exec(wl)?.[1] ?? 0) + JSON.stringify(log.slice(0, n)).length;
    } finally {
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
}
result.browserReplayMs = Object.fromEntries(SIZES.map((n) => [n, result.browserJoinMs[n] - result.browserJoinMs[0]]));
result.verdict = result.browserReplayMs[10000] > 5000 || result.canonicalRebuildMs[10000] > 5000 ? '10,000 묶음 재생이 5초를 넘음 — 다음 단계에서 (D)' : '10,000 묶음 재생 5초 안 — (B) 유지';
console.log(JSON.stringify(result, null, 1));
