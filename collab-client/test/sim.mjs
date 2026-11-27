#!/usr/bin/env node
// R5 무작위 다중 클라이언트 시뮬레이션 (docs/collab-stage2.md §8). Node + 실제 WASM + 엔진 그대로.
//
//   node collab-client/test/sim.mjs [--seeds 500] [--ops 200] [--clients 3] [--from 1] [--verbose]
//                                   [--mix all|tn] [--verify-fast] [--no-fast] [--realistic] [--rewrite-state]
//
// --mix tn       R11 관문: text·neutral 만(표가 든 base 에서 셀 삭제·셀 서식 포함). 구조·state 없음.
// --rewrite-state 6단계 S1: 서버(정본)가 받은 state 를 바뀐 부분만 모델에서 다시 쓴 바이트로 바꿔 기록·방송하고(보낸
//                사람에게는 `replaced` 확정), 섞기에 state 편집(덧말 넣기 — 분류표 state)을 넣는다. 붙여넣기 몫의 일부를 쓴다.
// --verify-fast  빠른 경로를 쓸 때마다 되감기 결과와 digest 비교(불일치 수를 요약에 낸다 — 관문은 0).
// --no-fast      빠른 경로를 끈다(언제나 되감기).
// --realistic    R9 현실 조건: 시간 축 위에서 사람 속도(클라이언트마다 초당 약 5타, 서식·구조 드물게),
//                편도 50ms(왕복 100ms), 입력 묶음 전송. 분류별 충돌률을 낸다.
//
// 클라이언트마다 자기 현재 문서에서 유효한 무작위 편집을 만든다: text 7종(한글·영문, 빈 문단·문단 경계
// 가중), neutral(글자·문단 서식), structural(표 만들기·행 추가), state(복사 후 내부 붙여넣기),
// runInBatch(배치 괄호 안 편집 — none 분류 검증). 전송·전달 순서와 지연을 무작위로 섞는다(연결마다 FIFO).
// 끝에서 모두 조용해지면: 모든 클라이언트 digest 동일 + 서버 로그를 새 문서에 재생한 digest 와 동일.
// 실패하면 시드를 출력하고 종료 코드 1.
import { gunzipSync } from 'node:zlib';
import { loadWasm, blankBytes, paragraphs, Client, Server } from './support/harness.mjs';
import { classify } from '../src/engine/classify.ts';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const SEEDS = arg('seeds', 500);
const OPS = arg('ops', 200);
const CLIENTS = arg('clients', 3);
const FROM = arg('from', 1);
const VERBOSE = process.argv.includes('--verbose');
const flag = (name) => process.argv.includes(`--${name}`);
const MIX = (() => { const i = process.argv.indexOf('--mix'); return i >= 0 ? process.argv[i + 1] : 'all'; })();
const VERIFY_FAST = flag('verify-fast');
const FAST = !flag('no-fast');
const REALISTIC = flag('realistic');
/** --realistic 에서 표 만들기·붙여넣기를 빼려면 --no-struct (그 자리는 글자 입력) */
const NO_STRUCT = flag('no-struct');
/** 6단계 S1: 서버가 다시 쓴 state(`replaced`) + 섞기에 state 편집 */
const REWRITE_STATE = flag('rewrite-state');
/**
 * --s3: 3단계 조건(docs/collab-stage3.md 관문 "R5 시뮬레이션 확장") — 서버 정본(S3-2), 무작위 연결 끊김·다시 붙기
 * (S3-4 catchup/welcome), 체크포인트(기준점 이동, S3-3), 서버 재시작(모든 연결 끊김 + 정본을 체크포인트 + 기록으로
 * 다시 만듦)을 섞는다. 끝에서 모두 다시 붙고 조용해지면: 모든 클라이언트 = 정본 = 처음 base + 모든 기록 재생.
 */
const S3 = flag('s3');
/** --s3 사건 끄기(원인 가르기): --no-generation, --no-restart */
const S3_GENERATION = !flag('no-generation');
const S3_RESTART = !flag('no-restart');
/** --s3 에서 늦은 참여자 상한 */
const S3_MAX_CLIENTS = 6;

/** mulberry32 — 시드 고정 PRNG (새 의존성 없음) */
function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    chance: (p) => next() < p,
  };
}

const HANGUL = ['가', '나', '다', '한', '글', '입', '력', '동', '시', '편', '집'];
const LATIN = ['a', 'b', 'c', 'x', 'y', 'z', ' ', 'Q'];

function word(r, max = 4) {
  const n = 1 + r.int(max);
  const pool = r.chance(0.5) ? HANGUL : LATIN;
  let s = '';
  for (let i = 0; i < n; i += 1) s += r.pick(pool);
  return s;
}

/** 문서 상태 요약(읽기 전용 조회만 — 훅에 걸리지 않는다). */
function survey(doc) {
  const paras = doc.getParagraphCount(0);
  const lens = [];
  const tables = [];
  for (let p = 0; p < paras; p += 1) {
    lens.push(doc.getParagraphLength(0, p));
    for (let ci = 0; ci < 4; ci += 1) {
      try {
        const dim = JSON.parse(doc.getTableDimensions(0, p, ci));
        const rows = dim?.rowCount ?? dim?.rows;
        if (rows) tables.push({ p, ci, rows, cells: dim.cellCount ?? rows * (dim.colCount ?? dim.cols ?? 1) });
      } catch { /* 표 아님 */ }
    }
  }
  return { paras, lens, tables };
}

/** 셀 하나의 문단 길이들(셀 공간). */
function cellParas(doc, t, cell) {
  const n = doc.getCellParagraphCount(0, t.p, t.ci, cell);
  const lens = [];
  for (let i = 0; i < n; i += 1) lens.push(doc.getCellParagraphLength(0, t.p, t.ci, cell, i));
  return lens;
}

/** R11 관문용 base: 본문 몇 문단 + 글이 든 2×2 표. */
function tableBaseBytes(m) {
  const d = m.HwpDocument.createEmpty();
  d.createBlankDocument();
  d.insertText(0, 0, 0, '첫 문단 abc');
  d.splitParagraph(0, 0, 5);
  d.createTable(0, 1, 0, 2, 2);
  const s = survey(d);
  const t = s.tables[0];
  if (!t) throw new Error('표를 만들지 못했습니다');
  for (let c = 0; c < t.cells; c += 1) d.insertTextInCell(0, t.p, t.ci, c, 0, 0, `셀${c} 내용 xyz`);
  const n = d.getParagraphCount(0);
  d.insertText(0, n - 1, d.getParagraphLength(0, n - 1), '표 뒤 문단 하나');
  const bytes = d.exportHwp();
  d.free();
  return bytes;
}

/** 경계 가중 오프셋: 30% 처음, 30% 끝, 나머지 가운데 */
function offsetIn(r, len) {
  const x = r.next();
  if (x < 0.3) return 0;
  if (x < 0.6) return len;
  return r.int(len + 1);
}

/** 무작위 편집 하나를 문서에 가한다(기록 훅이 기록한다). 반환: 분류 이름. 유효하지 않으면 null. */
function randomEdit(r, doc) {
  const s = survey(doc);
  const p = r.int(s.paras);
  const len = s.lens[p];
  const kind = r.next();
  try {
    if (kind < 0.27 || (kind < 0.30 && s.tables.length === 0)) {
      doc.insertText(0, p, offsetIn(r, len), word(r));
      return 'insertText';
    }
    if (kind < 0.30) {
      // R13: 셀 텍스트(text)
      const t = r.pick(s.tables);
      const cell = r.int(Math.min(4, t.rows * 2));
      const lens = cellParas(doc, t, cell);
      const cp = r.int(lens.length);
      doc.insertTextInCell(0, t.p, t.ci, cell, cp, offsetIn(r, lens[cp]), word(r, 3));
      return 'insertTextInCell';
    }
    if (kind < 0.36) {
      doc.insertTextLogical(0, p, offsetIn(r, doc.getLogicalLength ? doc.getLogicalLength(0, p) : len), word(r));
      return 'insertTextLogical';
    }
    if (kind < 0.46) {
      if (len === 0) return null;
      const o = r.int(len);
      doc.deleteText(0, p, o, 1 + r.int(Math.min(4, len - o) + 2)); // 가끔 범위를 넘김(잘림)
      return 'deleteText';
    }
    if (kind < 0.58) {
      const o = offsetIn(r, len);
      const dc = Math.min(len - o, r.int(3));
      doc.replaceBodyTextLocal(0, p, o, dc, word(r, 3));
      return 'replaceBodyTextLocal';
    }
    if (kind < 0.66) {
      doc.splitParagraph(0, p, offsetIn(r, len));
      return 'splitParagraph';
    }
    if (kind < 0.73) {
      if (p === 0) return null;
      doc.mergeParagraph(0, p);
      return 'mergeParagraph';
    }
    if (kind < 0.78) {
      if (s.paras < 2) return null;
      const sp = r.int(s.paras - 1);
      const ep = sp + 1 + r.int(Math.min(2, s.paras - 1 - sp));
      doc.deleteRange(0, sp, r.int(s.lens[sp] + 1), ep, r.int(s.lens[ep] + 1));
      return 'deleteRange';
    }
    if (kind < 0.82) {
      if (len === 0) return null;
      const a = r.int(len), b = a + 1 + r.int(len - a);
      doc.applyCharFormat(0, p, a, b, JSON.stringify(r.pick([{ bold: true }, { italic: true }, { underline: true }, { bold: false }])));
      return 'applyCharFormat';
    }
    if (kind < 0.85) {
      // 4단계: 글자 서식 되돌리기가 쓰는 연산(문단 발자국 구조) — 무작위 구간을 문서에 있는 글자 모양 id 둘로 다시 칠한다
      if (len === 0) return null;
      const a = r.int(len), b = a + 1 + r.int(len - a);
      const q = r.int(s.paras);
      const ids = [...new Set(JSON.parse(doc.getCharShapeRuns(0, q, 0, Math.max(1, s.lens[q]))).map((x) => x.charShapeId)), 0];
      const m = a + 1 + r.int(b - a);
      const runs = [{ startOffset: a, endOffset: m, charShapeId: r.pick(ids) }, { startOffset: m, endOffset: b, charShapeId: r.pick(ids) }].filter((x) => x.endOffset > x.startOffset);
      doc.setCharShapeRuns(0, p, a, b, JSON.stringify(runs));
      return 'setCharShapeRuns';
    }
    if (kind < 0.89) {
      doc.applyParaFormat(0, p, JSON.stringify({ alignment: r.pick(['left', 'center', 'right', 'justify']) }));
      return 'applyParaFormat';
    }
    if (kind < 0.92) {
      doc.createTable(0, p, offsetIn(r, len), 2, 2);
      return 'createTable';
    }
    if (kind < 0.94) {
      if (s.tables.length === 0) return null;
      const t = r.pick(s.tables);
      doc.insertTableRow(0, t.p, t.ci, r.int(t.rows), r.chance(0.5));
      return 'insertTableRow';
    }
    if (REWRITE_STATE && kind >= 0.95 && kind < 0.97) {
      // 6단계 S1: 결과 전송(state) 편집 — 덧말 넣기(분류표 state). 서버가 다시 쓴 바이트로 확정된다
      doc.insertRuby(0, p, offsetIn(r, len), JSON.stringify({ mainText: word(r, 2), rubyText: 'ㄱ', below: r.chance(0.5), styleId: null }));
      return 'insertRuby';
    }
    if (kind < 0.97) {
      if (len === 0) return null;
      const a = r.int(len);
      doc.copySelection(0, p, a, p, a + 1 + r.int(len - a));
      const q = r.int(s.paras);
      doc.pasteInternal(0, q, offsetIn(r, s.lens[q]));
      return 'pasteInternal';
    }
    // 배치 괄호(studio 의 runInBatch) 안에서 지우고 넣기 — beginBatch/endBatch 는 none
    const o = offsetIn(r, len);
    doc.beginBatch();
    try {
      if (o < len) doc.deleteText(0, p, o, 1);
      doc.insertTextLogical(0, p, o, word(r, 2));
    } finally {
      doc.endBatch();
    }
    return 'runInBatch';
  } catch {
    return null; // 코어가 거절한 편집(기록되지 않음)
  }
}

/** R11 관문용: text·neutral 만(셀 삭제·셀 서식 포함). `--only a,b` 로 종류를 좁힐 수 있다(원인 분리용). */
const TN_KINDS = [
  [25, 'insertText', (r, doc, s, p, len) => { doc.insertText(0, p, offsetIn(r, len), word(r)); }],
  [6, 'insertTextLogical', (r, doc, s, p, len) => { doc.insertTextLogical(0, p, offsetIn(r, len), word(r)); }],
  [9, 'deleteText', (r, doc, s, p, len) => {
    if (len === 0) return false;
    const o = r.int(len);
    doc.deleteText(0, p, o, 1 + r.int(Math.min(4, len - o) + 2));
  }],
  [8, 'replaceBodyTextLocal', (r, doc, s, p, len) => { const o = offsetIn(r, len); doc.replaceBodyTextLocal(0, p, o, Math.min(len - o, r.int(3)), word(r, 3)); }],
  [6, 'splitParagraph', (r, doc, s, p, len) => { doc.splitParagraph(0, p, offsetIn(r, len)); }],
  [5, 'mergeParagraph', (r, doc, s, p) => { if (p === 0) return false; doc.mergeParagraph(0, p); }],
  [3, 'deleteRange', (r, doc, s) => {
    if (s.paras < 2) return false;
    const sp = r.int(s.paras - 1);
    const ep = sp + 1 + r.int(Math.min(2, s.paras - 1 - sp));
    doc.deleteRange(0, sp, r.int(s.lens[sp] + 1), ep, r.int(s.lens[ep] + 1));
  }],
  [12, 'applyCharFormat', (r, doc, s, p, len) => {
    if (len === 0) return false;
    const a = r.int(len), b = a + 1 + r.int(len - a);
    doc.applyCharFormat(0, p, a, b, JSON.stringify(r.pick([{ bold: true }, { italic: true }, { underline: true }, { bold: false }])));
  }],
  [6, 'applyParaFormat', (r, doc, s, p) => { doc.applyParaFormat(0, p, JSON.stringify({ alignment: r.pick(['left', 'center', 'right', 'justify']) })); }],
  [5, 'deleteRangeInCell', (r, doc, s) => {
    const c = pickCell(r, doc, s); if (!c || c.len === 0) return false;
    const a = r.int(c.len);
    doc.deleteRangeInCell(0, c.t.p, c.t.ci, c.cell, c.cp, a, c.cp, a + 1 + r.int(Math.min(3, c.len - a)));
  }],
  [4, 'applyCharFormatInCell', (r, doc, s) => {
    const c = pickCell(r, doc, s); if (!c || c.len === 0) return false;
    const a = r.int(c.len), b = a + 1 + r.int(c.len - a);
    doc.applyCharFormatInCell(0, c.t.p, c.t.ci, c.cell, c.cp, a, b, JSON.stringify(r.pick([{ bold: true }, { italic: true }])));
  }],
  [3, 'applyParaFormatInCell', (r, doc, s) => {
    const c = pickCell(r, doc, s); if (!c) return false;
    doc.applyParaFormatInCell(0, c.t.p, c.t.ci, c.cell, c.cp, JSON.stringify({ alignment: r.pick(['left', 'center', 'right']) }));
  }],
  [6, 'insertTextInCell', (r, doc, s) => {
    const c = pickCell(r, doc, s); if (!c) return false;
    doc.insertTextInCell(0, c.t.p, c.t.ci, c.cell, c.cp, r.int(c.len + 1), word(r, 3));
  }],
  [2, 'splitParagraphInCell', (r, doc, s) => {
    const c = pickCell(r, doc, s); if (!c) return false;
    doc.splitParagraphInCell(0, c.t.p, c.t.ci, c.cell, c.cp, r.int(c.len + 1), null);
  }],
  [2, 'mergeParagraphInCell', (r, doc, s) => {
    const c = pickCell(r, doc, s); if (!c || c.cp === 0) return false;
    doc.mergeParagraphInCell(0, c.t.p, c.t.ci, c.cell, c.cp);
  }],
  [8, 'runInBatch', (r, doc, s, p, len) => {
    const o = offsetIn(r, len);
    doc.beginBatch();
    try {
      if (o < len) doc.deleteText(0, p, o, 1);
      doc.insertTextLogical(0, p, o, word(r, 2));
    } finally {
      doc.endBatch();
    }
  }],
];
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? new Set(process.argv[i + 1].split(',')) : null; })();
const TN_ACTIVE = ONLY ? TN_KINDS.filter(([, n]) => ONLY.has(n)) : TN_KINDS;
const TN_TOTAL = TN_ACTIVE.reduce((n, [w]) => n + w, 0);

function pickCell(r, doc, s) {
  if (s.tables.length === 0) return null;
  const t = r.pick(s.tables);
  const cell = r.int(t.cells);
  const lens = cellParas(doc, t, cell);
  const cp = r.int(lens.length);
  return { t, cell, cp, len: lens[cp] };
}

function randomTextNeutralEdit(r, doc) {
  const s = survey(doc);
  const p = r.int(s.paras);
  const len = s.lens[p];
  let x = r.next() * TN_TOTAL;
  let chosen = TN_ACTIVE[TN_ACTIVE.length - 1];
  for (const k of TN_ACTIVE) { if (x < k[0]) { chosen = k; break; } x -= k[0]; }
  try {
    return chosen[2](r, doc, s, p, len) === false ? null : chosen[1];
  } catch {
    return null;
  }
}

/** --realistic 에서 표 칸 안 입력 비율(R13 관문: 0.3) */
const CELL_RATIO = (() => { const i = process.argv.indexOf('--cell-ratio'); return i >= 0 ? Number(process.argv[i + 1]) : 0.3; })();

/** R13: 공유 3×3 표의 자기 칸(가끔 남의 칸)에서 친다. */
function realisticCellEdit(r, doc, s, caret) {
  const t = s.tables.find((x) => x.rows === 3 && x.cells >= 9);
  if (!t) return null;
  const cell = r.chance(0.9) ? caret.cell : r.int(9);
  const lens = cellParas(doc, t, cell);
  const cp = Math.min(caret.cp, lens.length - 1);
  const o = Math.min(caret.co, lens[cp]);
  const kind = r.next();
  try {
    if (kind < 0.85) { doc.insertTextInCell(0, t.p, t.ci, cell, cp, o, r.pick(r.chance(0.5) ? HANGUL : LATIN)); if (cell === caret.cell) { caret.cp = cp; caret.co = o + 1; } return 'insertTextInCell'; }
    if (kind < 0.95) { if (o === 0) return null; doc.deleteTextInCell(0, t.p, t.ci, cell, cp, o - 1, 1); if (cell === caret.cell) caret.co = o - 1; return 'deleteTextInCell'; }
    doc.splitParagraphInCell(0, t.p, t.ci, cell, cp, o, null);
    if (cell === caret.cell) { caret.cp = cp + 1; caret.co = 0; }
    return 'splitParagraphInCell';
  } catch {
    return null;
  }
}

/** R9 현실 조건용: 사람 속도의 편집 하나. 대부분 한두 글자 입력·지우기, 가끔 Enter·서식, 드물게 구조·붙여넣기. */
function realisticEdit(r, doc, caret, client) {
  const s = survey(doc);
  if (r.chance(CELL_RATIO)) return realisticCellEdit(r, doc, s, caret);
  // 각자 자기 캐럿에서 친다. 캐럿은 원격을 받을 때 엔진 지도로 옮겨진다(플러그인과 같다).
  if (client.caret) { caret.p = client.caret.para; caret.o = client.caret.offset; }
  let p = Math.min(caret.p, s.paras - 1);
  let len = s.lens[p];
  let o = Math.min(caret.o, len);
  const done = (k) => { client.caret = { section: 0, para: caret.p, offset: caret.o }; return k; };
  const kind = r.next();
  try {
    if (kind < 0.80) { const w = r.pick(r.chance(0.5) ? HANGUL : LATIN); doc.insertText(0, p, o, w); caret.p = p; caret.o = o + 1; return done('insertText'); }
    if (kind < 0.88) { if (o === 0) return null; doc.deleteText(0, p, o - 1, 1); caret.o = o - 1; return done('deleteText'); }
    if (kind < 0.92) { doc.splitParagraph(0, p, o); caret.p = p + 1; caret.o = 0; return done('splitParagraph'); }
    if (kind < 0.93) { if (p === 0 || o !== 0) return null; const prev = s.lens[p - 1]; doc.mergeParagraph(0, p); caret.p = p - 1; caret.o = prev; return done('mergeParagraph'); }
    if (kind < 0.965) {
      if (len === 0) return null;
      const a = r.int(len), b = a + 1 + r.int(len - a);
      doc.applyCharFormat(0, p, a, b, JSON.stringify(r.pick([{ bold: true }, { italic: true }])));
      return 'applyCharFormat';
    }
    if (kind < 0.98) { doc.applyParaFormat(0, p, JSON.stringify({ alignment: r.pick(['left', 'center', 'right']) })); return 'applyParaFormat'; }
    if (NO_STRUCT) { doc.insertText(0, p, o, r.pick(LATIN)); caret.p = p; caret.o = o + 1; return done('insertText'); }
    if (kind < 0.99) { doc.createTable(0, p, o, 2, 2); return 'createTable'; }
    if (len === 0) return null;
    const a = r.int(len);
    doc.copySelection(0, p, a, p, a + 1 + r.int(len - a));
    doc.pasteInternal(0, p, o);
    return 'pasteInternal';
  } catch {
    return null;
  }
}

/** R9: 시간 축 시뮬레이션. 클라이언트마다 다음 입력 시각(평균 200ms), 메시지는 편도 50ms 뒤 도착. */
async function runRealisticSeed(seed, base) {
  const r = prng(seed);
  const server = new Server(base);
  const clients = Array.from({ length: CLIENTS }, (_, i) => new Client(String.fromCharCode(65 + i), base, server, { fast: FAST, verifyFast: VERIFY_FAST }));
  const ONE_WAY = 50;
  // 각자 다른 문단에서 시작하도록 미리 문단을 만들고 맞춘다.
  for (let i = 0; i < CLIENTS; i += 1) { clients[0].doc.insertText(0, i, 0, `참여자${i} `); if (i < CLIENTS - 1) clients[0].doc.splitParagraph(0, i, 5); }
  // R13: 공문서 양식처럼 모두가 채우는 3×3 표(끝 문단 뒤)
  if (CELL_RATIO > 0) {
    const d0 = clients[0].doc;
    const last = d0.getParagraphCount(0) - 1;
    d0.splitParagraph(0, last, d0.getParagraphLength(0, last));
    d0.createTable(0, last + 1, 0, 3, 3);
  }
  server.drain(clients);
  const carets = clients.map((_, i) => ({ p: i, o: 0, cell: i % 9, cp: 0, co: 0 }));
  clients.forEach((c, i) => { c.caret = { section: 0, para: i, offset: 0 }; });
  // 서버 큐를 시간 지연 큐로 감싼다: submit 은 ONE_WAY 뒤 서버 도착, 방송은 다시 ONE_WAY 뒤 클라이언트 도착.
  const inbox = []; // {t, kind: 'toServer'|'toClient', ...}
  let now = 0;
  const realSubmit = server.submit.bind(server);
  server.submit = (client, b, entries) => inbox.push({ t: now + ONE_WAY, kind: 'toServer', client, b, entries: structuredClone(entries) });
  const nextType = clients.map(() => r.next() * 200);
  const made = {};
  let edits = 0;
  const pump = () => {
    inbox.sort((a, b) => a.t - b.t);
    while (inbox.length && inbox[0].t <= now) {
      const ev = inbox.shift();
      if (ev.kind === 'toServer') {
        const before = new Map([...server.queues].map(([c, q]) => [c, q.length]));
        realSubmit(ev.client, ev.b, ev.entries);
        for (const [c, q] of server.queues) {
          const fresh = q.splice(before.get(c));
          for (const msg of fresh) inbox.push({ t: now + ONE_WAY, kind: 'toClient', client: c, msg });
        }
        inbox.sort((a, b) => a.t - b.t);
      } else {
        ev.client.deliver(ev.msg);
        ev.client.flush();
      }
    }
  };
  try {
    while (edits < OPS) {
      const i = nextType.indexOf(Math.min(...nextType));
      now = nextType[i];
      pump();
      const c = clients[i];
      const k = realisticEdit(r, c.doc, carets[i], c);
      if (k) { made[k] = (made[k] ?? 0) + 1; edits += 1; }
      c.flush();
      nextType[i] = now + 80 + r.next() * 240; // 초당 약 5타
    }
    // 조용해질 때까지
    for (let guard = 0; guard < 10000 && (inbox.length || clients.some((c) => c.engine.pendingCount)); guard += 1) {
      now += 10;
      pump();
      for (const c of clients) c.flush();
    }
    return finish(seed, server, clients, made, edits);
  } finally {
    clients.forEach((c) => c.close());
  }
}

function finish(seed, server, clients, made, edits) {
  const digests = clients.map((c) => c.digest());
  const replay = server.replayDigest();
  const canon = server.canonicalDigest();
  const errors = clients.flatMap((c) => c.errors.map((e) => `${c.id}: ${e}`));
  const ok = digests.every((d) => d === digests[0]) && replay === digests[0] && (canon === null || canon === digests[0]) && errors.length === 0;
  const droppedByClass = {};
  for (const c of clients) for (const e of c.droppedEntries) {
    const cls = e.kind === 'state' ? 'state' : classify(e.m).conc;
    droppedByClass[cls] = (droppedByClass[cls] ?? 0) + 1;
  }
  const fast = { fast: 0, slow: 0, fallback: 0, mismatches: [], blocks: {}, fastMs: 0, slowMs: 0 };
  for (const c of clients) {
    const st = c.engine.fastStats;
    fast.fast += st.fast; fast.slow += st.slow; fast.fallback += st.fallback; fast.fastMs += st.fastMs; fast.slowMs += st.slowMs;
    fast.mismatches.push(...st.mismatches);
    for (const [k, v] of Object.entries(st.blocks)) fast.blocks[k] = (fast.blocks[k] ?? 0) + v;
  }
  const dropPairs = {};
  for (const c of clients) for (const [k, v] of Object.entries(c.dropPairs ?? {})) dropPairs[k] = (dropPairs[k] ?? 0) + v;
  const result = {
    seed, ok, edits, made, seq: server.seq, dropPairs,
    dropped: clients.reduce((n, c) => n + c.dropped, 0), droppedByClass,
    reasons: clients.flatMap((c) => c.drops), fast,
    digests: digests.map((d) => d.slice(0, 10)), replay: replay.slice(0, 10), errors,
    ...(REWRITE_STATE ? { rewrite: { rewrites: server.rewrites, replacedAcks: clients.reduce((n, c) => n + (c.replacedAcks ?? 0), 0) } } : {}),
    ...(S3 ? { s3: { canon: canon?.slice(0, 10), generations: server.generations, newcomers: clients.length - CLIENTS, restarts: server.restarts, invalids: server.invalids,
      catchups: clients.reduce((n, c) => n + c.catchups, 0), welcomes: clients.reduce((n, c) => n + c.resyncs, 0) } } : {}),
  };
  if (!ok && VERBOSE) result.paragraphs = clients.map((c) => paragraphs(c.doc));
  return result;
}

/** 플러그인처럼: 첫 참여자가 자기 문서를 내보내 그 바이트로 다시 연다(모두 같은 파싱 결과에서 출발). */
const normalized = (m, bytes) => {
  const d = new m.HwpDocument(bytes);
  const out = gunzipSync(d.collabExportState());
  d.free();
  return out;
};

async function runSeed(seed, base) {
  const r = prng(seed);
  const server = new Server(base, { canonical: S3, rewriteState: REWRITE_STATE });
  const clients = Array.from({ length: CLIENTS }, (_, i) => new Client(String.fromCharCode(65 + i), base, server, { fast: FAST, verifyFast: VERIFY_FAST }));
  const made = {};
  let edits = 0;
  const gen = MIX === 'tn' ? randomTextNeutralEdit : randomEdit;
  try {
    for (let step = 0; edits < OPS && step < OPS * 20; step += 1) {
      const c = r.pick(clients);
      const x = r.next();
      if (x < 0.5) {
        const k = gen(r, c.doc);
        if (k) { made[k] = (made[k] ?? 0) + 1; edits += 1; }
      } else if (x < 0.7) {
        c.flush();
      } else if (S3 && x < 0.73) {
        // 3단계 사건: 끊김 1% · 다시 붙기 1.5% · 빈 방 세대 전환 + 늦은 참여자 0.3% · 서버 재시작 0.2% (이 3% 구간 안 비율)
        const y = r.next();
        const off = clients.filter((k) => !k.online);
        if (y < 0.33) c.disconnect();
        else if (y < 0.83) { if (off.length) r.pick(off).reconnect(); }
        else if (y < 0.93) {
          // 모두 나가 방이 비고(오래) → 세대 전환 → 새 참여자가 새 세대에서 시작. 나갔던 사람은 나중에 다시 붙으며
          // welcome(재동기화 — 끊긴 동안의 편집은 취소)을 받는다.
          if (S3_GENERATION) {
            for (const k of clients) k.disconnect();
            if (server.changeGeneration(clients) && clients.length < S3_MAX_CLIENTS) {
              clients.push(server.newcomer(String.fromCharCode(65 + clients.length), { fast: FAST, verifyFast: VERIFY_FAST }));
            }
          }
        } else if (S3_RESTART) server.restart(clients);
      } else {
        // 연결마다 순서는 지키되, 어느 연결을 얼마나 받을지는 무작위(지연)
        const n = 1 + r.int(3);
        for (let i = 0; i < n; i += 1) server.deliverOne(c);
      }
    }
    for (const c of clients) c.reconnect();
    server.drain(clients);
    return finish(seed, server, clients, made, edits);
  } finally {
    clients.forEach((c) => c.close());
    server.closeCanonical();
  }
}

const t0 = Date.now();
const m = await loadWasm();
const base = (() => { const b = MIX === 'tn' ? tableBaseBytes(m) : blankBytes(); return S3 ? normalized(m, b) : b; })();
const total = { seeds: 0, failed: [], edits: 0, made: {}, dropped: 0, droppedByClass: {}, reasons: {}, dropPairs: {},
  fast: { fast: 0, slow: 0, fallback: 0, blocks: {}, fastMs: 0, slowMs: 0 }, mismatches: [], mismatchSeeds: [],
  s3: { generations: 0, newcomers: 0, restarts: 0, invalids: 0, catchups: 0, welcomes: 0 }, rewrite: { rewrites: 0, replacedAcks: 0 } };
for (let seed = FROM; seed < FROM + SEEDS; seed += 1) {
  const res = REALISTIC ? await runRealisticSeed(seed, base) : await runSeed(seed, base);
  for (const k of ['fast', 'slow', 'fallback', 'fastMs', 'slowMs']) total.fast[k] += res.fast[k];
  for (const [k, v] of Object.entries(res.dropPairs ?? {})) total.dropPairs[k] = (total.dropPairs[k] ?? 0) + v;
  for (const [k, v] of Object.entries(res.fast.blocks)) total.fast.blocks[k] = (total.fast.blocks[k] ?? 0) + v;
  if (res.fast.mismatches.length) {
    total.mismatchSeeds.push(seed);
    if (total.mismatches.length < 5) total.mismatches.push(...res.fast.mismatches.slice(0, 5 - total.mismatches.length).map((x) => ({ seed, ...x })));
  }
  total.seeds += 1;
  if (res.s3) for (const k of Object.keys(total.s3)) total.s3[k] += res.s3[k];
  if (res.rewrite) for (const k of Object.keys(total.rewrite)) total.rewrite[k] += res.rewrite[k];
  total.edits += res.edits;
  total.dropped += res.dropped;
  for (const [k, v] of Object.entries(res.made)) total.made[k] = (total.made[k] ?? 0) + v;
  for (const [k, v] of Object.entries(res.droppedByClass)) total.droppedByClass[k] = (total.droppedByClass[k] ?? 0) + v;
  for (const r of res.reasons) { const k = r.replace(/: .*$/s, (m) => m.slice(0, 60)); total.reasons[k] = (total.reasons[k] ?? 0) + 1; }
  if (!res.ok) {
    total.failed.push(seed);
    console.log(`FAIL seed ${seed}: ${JSON.stringify(res)}`);
  } else if (VERBOSE) {
    console.log(`ok seed ${seed}: edits ${res.edits}, seq ${res.seq}, dropped ${res.dropped}`);
  }
  if (seed % 50 === 0) console.log(`… ${seed - FROM + 1}/${SEEDS} 시드, 실패 ${total.failed.length}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
const classOf = (k) => (k === 'runInBatch' ? 'text' : classify(k).sync === 'state' ? 'state' : classify(k).conc);
const fastTotal = total.fast.fast + total.fast.slow;
const madeByClass = {};
for (const [k, v] of Object.entries(total.made)) madeByClass[classOf(k)] = (madeByClass[classOf(k)] ?? 0) + v;
const rate = Object.fromEntries(Object.entries(madeByClass).map(([k, v]) => [k, `${(((total.droppedByClass[k] ?? 0) / v) * 100).toFixed(2)}%`]));
console.log(JSON.stringify({
  seeds: total.seeds, ops: OPS, clients: CLIENTS, failed: total.failed.length, failedSeeds: total.failed.slice(0, 20),
  edits: total.edits, made: total.made, madeByClass, dropped: total.dropped, droppedByClass: total.droppedByClass,
  conflictRateByClass: rate, dropReasons: total.reasons,
  mix: MIX, realistic: REALISTIC, noStruct: NO_STRUCT, ...(S3 ? { s3: total.s3 } : {}), ...(REWRITE_STATE ? { rewrite: total.rewrite } : {}), cellRatio: REALISTIC ? CELL_RATIO : undefined, fastEnabled: FAST, verifyFast: VERIFY_FAST,
  dropRate: total.edits ? `${((total.dropped / total.edits) * 100).toFixed(2)}%` : '-',
  dropPairs: Object.fromEntries(Object.entries(total.dropPairs).sort((a, b) => b[1] - a[1])),
  dropEvents: Object.values(total.reasons).reduce((n, v) => n + v, 0),
  fastPath: {
    withPending: fastTotal, fast: total.fast.fast, slow: total.fast.slow, fallback: total.fast.fallback,
    fastShare: fastTotal ? `${((total.fast.fast / fastTotal) * 100).toFixed(2)}%` : '-',
    avgFastMs: total.fast.fast ? +(total.fast.fastMs / total.fast.fast).toFixed(3) : null,
    avgSlowMs: total.fast.slow ? +(total.fast.slowMs / total.fast.slow).toFixed(3) : null,
    slowReasons: total.fast.blocks,
  },
  fastMismatches: VERIFY_FAST ? total.mismatchSeeds.length : undefined,
  fastMismatchSeeds: VERIFY_FAST ? total.mismatchSeeds.slice(0, 20) : undefined,
  seconds: Math.round((Date.now() - t0) / 1000),
}, null, 1));
if (VERIFY_FAST && total.mismatches.length) {
  const dump = process.env.SIM_MISMATCH_DUMP;
  if (dump) (await import('node:fs')).writeFileSync(dump, JSON.stringify(total.mismatches, null, 1));
  console.log(`MISMATCH 첫 사례: 시드 ${total.mismatches[0].seed}, 앞 단계에서 이미 어긋남 ${total.mismatches.filter((x) => x.invariantBroken).length}/${total.mismatches.length}${dump ? ` → ${dump}` : ''}`);
}
process.exitCode = total.failed.length || (VERIFY_FAST && total.mismatchSeeds.length) ? 1 : 0;
