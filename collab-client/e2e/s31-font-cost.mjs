// S3-1 대가 측정 (docs/collab-stage3.md S3-1 결정의 조건): 혼자 편집(기본 모드 — 선언 글꼴 환경 + Canvas 보충
// 측정)과 공동편집(bundled-only — 엔진 내장 규칙)의 조판 차이.
//
// 문서를 열 때는 파일에 저장된 줄 나눔(한컴이 계산한 LineSeg)을 그대로 쓰므로 글꼴 환경과 무관하다. 환경은
// **다시 조판되는 문단**(편집한 문단)에만 쓰인다. 그래서 모든 문단을 다시 조판(`reflowLinesegs`)해 비교한다:
//   S = 저장된 줄 나눔(한컴), D = 기본 모드로 다시 조판, B = bundled-only 로 다시 조판
//   - D 와 B 의 차이 = 공동편집을 켜고 끔에 따라 달라지는 정도(편집한 문단에서)
//   - S 와의 일치율 = 각 모드가 한컴 줄 나눔을 얼마나 재현하는가(정확도)
// 기본 모드: 문서를 열면 studio 가 "로컬 글꼴 감지" 안내를 띄우고 초기화를 멈춘다 — 사용자가 "대체 글꼴로 보기" 를
// 고른 것처럼 눌러 초기화를 끝낸 뒤(로컬 글꼴 없음), 선언 환경·Canvas 측정을 한 번 더 준비해 확실히 켠다.
// 이 브라우저 프로필에는 로컬 글꼴 접근 권한이 없다 — 문서 글꼴이 설치돼 있고 권한을 준 사용자는 다를 수 있다.
// S31_LOCAL_FONTS=1: 그런 사용자를 만든다 — 로컬 글꼴 권한을 주고, 안내에서 "로컬 글꼴 감지"를 고른다. studio 는 감지
// 결과 중 그 문서에 필요한 face 만 저장하고 다음 문서부터는 안내 없이 그 저장분을 쓰므로, 문서마다 저장분을 지워
// 각 문서가 자기 글꼴을 감지하게 한다(로컬 글꼴에 가장 유리한 조건). 기본 모드 = 로컬 글꼴 + 선언 환경 + Canvas 보충 측정.
//
// 준비: (cd upstream/rhwp/rhwp-studio && npx vite) (7700). 서버는 필요 없다.
// 실행: node collab-client/e2e/s31-font-cost.mjs [--out <디렉터리>] [문서 경로...]
//   S31_CDP=<url>: 이미 떠 있는 원격 Chrome 에 붙는다(예: SSH 로 띄운 Windows Chrome, `-R 7700:127.0.0.1:7700` 으로
//     원격의 localhost 가 이 기기의 studio 를 연다). 문서 파일은 원격 기기에 복사하지 않고 페이지 안에서 File 로
//     만들어 넣는다. 실행마다 새 브라우저 컨텍스트를 만들고 끝나면 닫는다(원격 브라우저 프로세스는 띄운 쪽이 끈다).
//   문서를 주지 않으면 아래 SAMPLES(업스트림 samples/, 우리 저장소에 복사하지 않음).
//   --out: D 와 B 의 줄 나눔이 처음 갈리는 문단 화면을 두 모드로 PNG 저장(업스트림 문서 내용이 담기므로 저장소 밖).
//   S31_JSON=<파일>: 문서별 결과를 JSON 으로.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const studioDir = path.join(root, 'upstream/rhwp/rhwp-studio');
const puppeteer = createRequire(path.join(studioDir, 'package.json'))('puppeteer-core');
const STUDIO = process.env.STUDIO_URL ?? 'http://127.0.0.1:7700';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP = process.env.S31_CDP ?? null;
const LOCAL_FONTS = process.env.S31_LOCAL_FONTS === '1';

const S = (p) => path.join(root, 'upstream/rhwp/samples', p);
const SAMPLES = [
  ['글', S('biz_plan.hwp')], ['글', S('basic/treatise sample.hwp')], ['글', S('basic/english.hwp')], ['글', S('basic/Textmail.hwp')],
  ['글', S('정책연구용역사업 중간진도보고서(살아있는 간장 기증자의 의학적 선별기준 연구).hwp')],
  ['글', S('2025 행정업무운영 편람(최종).hwpx')],
  ['시험', S('exam_kor.hwp')], ['시험', S('exam_eng.hwp')], ['시험', S('exam_social-p1.hwp')], ['각주', S('footnote-01.hwp')],
  ['표', S('basic/calendar_monthly.hwp')], ['표', S('basic/KTX.hwp')], ['표', S('hwpx/ref/ref_table.hwpx')],
  ['양식', S('form-01.hwp')], ['양식', S('basic/BlogForm_BookReview.hwp')], ['양식', S('basic/request.hwp')], ['양식', S('basic/interview.hwp')],
  ['글꼴', S('basic/BookReview.hwp')], ['글꼴', S('basic/NewYear_s_Day.hwp')], ['글꼴', S('basic/sungeo.hwp')],
  ['대체 글꼴', S('hwp3-sample11-hwp5.hwp')],
];

const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const OUT = oi >= 0 ? args.splice(oi, 2)[1] : null;
const docs = args.length ? args.map((f) => ['지정', path.resolve(f)]) : SAMPLES;
if (OUT) mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 페이지 안에서: 쪽 수 + 문단별 줄 시작 열(본문 문단 + 본문 최상위 표의 셀 문단) */
const MEASURE = () => {
  const w = window.__wasm;
  const d = w.doc;
  const starts = (info) => {
    const out = [];
    let offset = 0;
    for (let guard = 0; guard < 10_000; guard += 1) {
      const li = JSON.parse(info(offset));
      out.push(li.charStart);
      if (li.lineIndex >= li.lineCount - 1) break;
      offset = li.charEnd > offset ? li.charEnd : offset + 1;
    }
    return out.join(',');
  };
  const lines = {};
  const secs = d.getSectionCount();
  for (let s = 0; s < secs; s += 1) {
    const n = d.getParagraphCount(s);
    for (let p = 0; p < n; p += 1) {
      try { lines[`${s}:${p}`] = starts((o) => d.getLineInfo(s, p, o)); } catch { /* 줄 없음 */ }
    }
  }
  let controls = [];
  try { controls = JSON.parse(d.getControls()); } catch { /* 없음 */ }
  for (const c of controls) {
    if (c.ctrlId.trim() !== 'tbl' || c.list !== 0) continue;
    const s = c.section ?? 0;
    let dim;
    try { dim = JSON.parse(d.getTableDimensions(s, c.para, c.controlIndex)); } catch { continue; }
    for (let cell = 0; cell < dim.cellCount; cell += 1) {
      let cpn = 0;
      try { cpn = d.getCellParagraphCount(s, c.para, c.controlIndex, cell); } catch { continue; }
      for (let cp = 0; cp < cpn; cp += 1) {
        try { lines[`${s}:${c.para}:${c.controlIndex}:${cell}:${cp}`] = starts((o) => d.getLineInfoInCell(s, c.para, c.controlIndex, cell, cp, o)); } catch { /* 줄 없음 */ }
      }
    }
  }
  return {
    pages: w.pageCount,
    lines,
    environmentId: JSON.parse(d.getDocumentFontSelectionPlan()).environmentId,
    canvasMetrics: d.canvasMetricsActive?.() ?? null,
  };
};

async function stable(page, pred, ms = 30_000) {
  const deadline = Date.now() + ms;
  let prev = null;
  let same = 0;
  for (;;) {
    const v = await page.evaluate(() => ({ pages: window.__wasm?.pageCount ?? 0, env: window.__wasm?.doc ? JSON.parse(window.__wasm.doc.getDocumentFontSelectionPlan()).environmentId : null, cm: window.__wasm?.doc?.canvasMetricsActive?.() ?? null }));
    const key = JSON.stringify(v);
    same = key === prev && pred(v) ? same + 1 : 0;
    prev = key;
    if (same >= 6 || Date.now() > deadline) return v;
    await sleep(250);
  }
}
/**
 * 모든 문단(본문 + 본문 최상위 표의 셀 문단)을 지금 글꼴 환경으로 다시 조판한다. 다시 조판하는 API 가 없어
 * (`reflowLinesegs` 는 검증에 걸린 문단만) 맨 앞에 한 글자를 넣었다 지운다 — 글은 그대로, 줄 나눔만 새로 계산된다.
 */
const reflow = (page) => page.evaluate(() => {
  const d = window.__wasm.doc;
  let n = 0;
  d.beginBatch?.();
  try {
    const secs = d.getSectionCount();
    for (let s = 0; s < secs; s += 1) {
      const count = d.getParagraphCount(s);
      for (let p = 0; p < count; p += 1) {
        try { d.insertText(s, p, 0, '가'); d.deleteText(s, p, 0, 1); n += 1; } catch { /* 편집 불가 문단 */ }
      }
    }
    let controls = [];
    try { controls = JSON.parse(d.getControls()); } catch { /* 없음 */ }
    for (const c of controls) {
      if (c.ctrlId.trim() !== 'tbl' || c.list !== 0) continue;
      const s = c.section ?? 0;
      let dim;
      try { dim = JSON.parse(d.getTableDimensions(s, c.para, c.controlIndex)); } catch { continue; }
      for (let cell = 0; cell < dim.cellCount; cell += 1) {
        let cpn = 0;
        try { cpn = d.getCellParagraphCount(s, c.para, c.controlIndex, cell); } catch { continue; }
        for (let cp = 0; cp < cpn; cp += 1) {
          try { d.insertTextInCell(s, c.para, c.controlIndex, cell, cp, 0, '가'); d.deleteTextInCell(s, c.para, c.controlIndex, cell, cp, 0, 1); n += 1; } catch { /* 편집 불가 */ }
        }
      }
    }
  } finally {
    d.endBatch?.();
  }
  window.__inputHandler?.triggerAfterEdit?.();
  return n;
});
const useDefault = (page) => page.evaluate(async () => {
  window.__s31Release?.();
  window.__s31Release = null;
  await window.__wasm.prepareDeclaredFontEnvironment('canvas2d');
  await window.__wasm.prepareCanvasMetrics('canvas2d');
});
const useBundled = (page) => page.evaluate(async () => {
  window.__s31Release = (await import('/src/core/font-policy.ts')).acquireBundledFontPolicy('s31-font-cost');
});
async function shot(page, key, file) {
  const [s, p] = key.split(':').map(Number);
  await page.evaluate(([s, p]) => window.__inputHandler.placeCaret({ sectionIndex: s, paragraphIndex: p, charOffset: 0 }), [s, p]);
  await sleep(1500);
  await page.screenshot({ path: file });
}
/**
 * "로컬 글꼴 감지" 안내가 뜨면 답한다(초기화가 이 선택을 기다린다): 기본은 "대체 글꼴로 보기",
 * S31_LOCAL_FONTS=1 이면 "로컬 글꼴 감지 (권장)" — 실제 마우스 클릭(사용자 활성화)으로 누른다.
 */
async function answerLocalFontPrompt(page, ms = 8000) {
  const label = LOCAL_FONTS ? '로컬 글꼴 감지 (권장)' : '대체 글꼴로 보기';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const handle = await page.evaluateHandle((label) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) ?? null, label);
    const button = handle.asElement();
    if (button) {
      await button.click();
      return label;
    }
    await handle.dispose();
    await sleep(200);
  }
  return null;
}
/** 문서를 연다. 원격 브라우저에는 이 기기의 경로가 없으므로 페이지 안에서 File 을 만들어 넣는다. */
async function openFile(page, file) {
  if (!CDP) {
    await (await page.$('#file-input')).uploadFile(file);
    return;
  }
  await page.evaluate((name, b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const input = document.querySelector('#file-input');
    const dt = new DataTransfer();
    dt.items.add(new File([bin], name));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, path.basename(file), readFileSync(file).toString('base64'));
}
const same = (x, y, keys) => keys.filter((k) => x.lines[k] === y.lines[k]).length;
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

const browser = CDP
  ? await puppeteer.connect({ browserURL: CDP, protocolTimeout: 900_000, defaultViewport: null })
  : await puppeteer.launch({ headless: process.env.HEADFUL !== '1', executablePath: CHROME, args: ['--no-sandbox', '--lang=ko-KR'], protocolTimeout: 900_000 });
// 실행마다 새 컨텍스트(저장된 로컬 글꼴 감지 결과·권한이 이전 실행에서 넘어오지 않게)
const context = await browser.createBrowserContext();
if (LOCAL_FONTS) {
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.grantPermissions', { permissions: ['localFonts'], origin: STUDIO, browserContextId: context.id });
  await cdp.detach();
}
const userAgent = await browser.userAgent();
console.log(`브라우저 ${await browser.version()} (${userAgent.match(/\(([^;)]+)/)?.[1] ?? '?'})${CDP ? ` 원격 ${CDP}` : ''}, 기본 모드 로컬 글꼴 ${LOCAL_FONTS ? '허락·감지' : '없음(대체 글꼴로 보기)'}`);
const rows = [];
try {
  for (const [kind, file] of docs) {
    const page = await context.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    // 문서 초기화 완료 횟수. studio 는 시작하자마자 빈 문서를 한 번 초기화하므로(1번째), 올린 문서는 2번째다 —
    // 빈 문서의 완료를 올린 문서의 완료로 잘못 읽으면 저장 줄 나눔(S)을 빈 문서에서 재게 된다.
    let inits = 0;
    page.on('console', (m) => { if (m.text().startsWith('[initDoc] 9.')) inits += 1; });
    const initCount = async (n, ms = 300_000) => {
      const deadline = Date.now() + ms;
      while (inits < n) {
        if (Date.now() > deadline) throw new Error(`문서 초기화 ${n}번째가 끝나지 않음`);
        await sleep(100);
      }
    };
    try {
      await page.goto(STUDIO, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__wasm && window.__inputHandler, { timeout: 60_000 });
      await initCount(1);
      if (LOCAL_FONTS) await page.evaluate(() => window.__localFonts.clearStoredLocalFonts());
      // 올린 문서의 초기화가 끝날 때까지(안내 답 → 로컬 글꼴 감지 → 선언 환경·뷰 준비) 기다린 뒤 잰다.
      const initDone = initCount(2);
      await openFile(page, file);
      await page.waitForFunction(() => window.__wasm?.pageCount > 0 && window.__wasm.doc, { timeout: 120_000 });
      const answered = await answerLocalFontPrompt(page);
      await initDone;
      await stable(page, (v) => v.pages > 0);
      const s0 = await page.evaluate(MEASURE);
      await useDefault(page);
      await stable(page, (v) => v.pages > 0);
      await reflow(page);
      await stable(page, (v) => v.pages > 0);
      const d = await page.evaluate(MEASURE);
      const localFonts = await page.evaluate(() => { const s = window.__localFonts?.getLocalFontState?.(); return s ? { stored: s.stored, count: s.count, method: s.method, source: s.source } : null; });
      await useBundled(page);
      await stable(page, (v) => v.env === null && v.cm !== true);
      await reflow(page);
      await stable(page, (v) => v.pages > 0);
      const b = await page.evaluate(MEASURE);
      const keys = Object.keys(s0.lines).filter((k) => k in d.lines && k in b.lines);
      const multi = keys.filter((k) => s0.lines[k].includes(',') || d.lines[k].includes(',') || b.lines[k].includes(','));
      const differ = keys.filter((k) => d.lines[k] !== b.lines[k]);
      const row = {
        kind, doc: path.basename(file),
        pages: { stored: s0.pages, default: d.pages, bundled: b.pages },
        prompt: answered, localFonts, openedEnv: { environmentId: s0.environmentId, canvasMetrics: s0.canvasMetrics },
        defaultEnv: { environmentId: d.environmentId, canvasMetrics: d.canvasMetrics },
        paragraphs: keys.length, multiLine: multi.length,
        differ: differ.length, differPct: pct(differ.length, keys.length), differPctOfMultiLine: pct(differ.length, multi.length),
        matchStored: { default: pct(same(s0, d, keys), keys.length), bundled: pct(same(s0, b, keys), keys.length) },
        matchStoredMultiLine: { default: pct(same(s0, d, multi), multi.length), bundled: pct(same(s0, b, multi), multi.length) },
        sample: differ.slice(0, 3).map((k) => ({ key: k, stored: s0.lines[k], default: d.lines[k], bundled: b.lines[k] })),
      };
      rows.push(row);
      console.log(`${kind}\t${row.doc}\t쪽 저장 ${s0.pages} / 기본 ${d.pages} / bundled ${b.pages}\t문단 ${keys.length}(여러 줄 ${multi.length})\tD≠B ${differ.length} (${row.differPct}%, 여러 줄 중 ${row.differPctOfMultiLine}%)\t한컴 일치(여러 줄) 기본 ${row.matchStoredMultiLine.default}% bundled ${row.matchStoredMultiLine.bundled}%\t열기 env=${s0.environmentId ? 'set' : 'null'} canvas=${s0.canvasMetrics}${answered ? `(안내: ${answered})` : ''} 로컬 글꼴 ${localFonts?.stored ? `${localFonts.count}개` : '없음'} → 기본 env=${d.environmentId ? 'set' : 'null'} canvas=${d.canvasMetrics}`);
      if (OUT && differ.length) {
        const name = path.basename(file).replace(/[^\w가-힣.-]+/g, '_');
        await shot(page, differ[0], path.join(OUT, `${name}.bundled.png`));
        await useDefault(page);
        await stable(page, (v) => v.pages > 0);
        await reflow(page);
        await stable(page, (v) => v.pages > 0);
        await shot(page, differ[0], path.join(OUT, `${name}.default.png`));
      }
    } catch (error) {
      rows.push({ kind, doc: path.basename(file), error: String(error).slice(0, 200) });
      console.log(`${kind}\t${path.basename(file)}\t오류 ${String(error).slice(0, 160)}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await context.close().catch(() => {});
  if (CDP) await browser.disconnect();
  else await browser.close();
}
const ok = rows.filter((r) => !r.error);
const sum = (f) => ok.reduce((s, r) => s + f(r), 0);
const total = sum((r) => r.paragraphs);
const multiTotal = sum((r) => r.multiLine);
const diffTotal = sum((r) => r.differ);
console.log(JSON.stringify({
  browser: userAgent, localFonts: LOCAL_FONTS,
  matchStoredMultiLine: { default: pct(sum((r) => (r.matchStoredMultiLine.default / 100) * r.multiLine), multiTotal), bundled: pct(sum((r) => (r.matchStoredMultiLine.bundled / 100) * r.multiLine), multiTotal) },
  documents: ok.length, errors: rows.length - ok.length,
  defaultEnvironmentApplied: ok.filter((r) => r.defaultEnv.environmentId !== null || r.defaultEnv.canvasMetrics).map((r) => `${r.doc} env=${r.defaultEnv.environmentId ? 'set' : 'null'} canvas=${r.defaultEnv.canvasMetrics}`),
  pageCountDefaultVsBundled: ok.filter((r) => r.pages.default !== r.pages.bundled).map((r) => `${r.doc} ${r.pages.default}→${r.pages.bundled}`),
  paragraphs: total, multiLine: multiTotal, differ: diffTotal, differPct: pct(diffTotal, total), differPctOfMultiLine: pct(diffTotal, multiTotal),
  over5pct: ok.filter((r) => r.differPct > 5).map((r) => `${r.doc} ${r.differPct}%`),
}, null, 1));
if (process.env.S31_JSON) writeFileSync(process.env.S31_JSON, JSON.stringify(rows, null, 1));
