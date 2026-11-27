#!/usr/bin/env node
// R1b 동작 동일성 검사 (docs/collab-stage2.md §3 "동작 동일성 검사", §8 R1b).
//
//   node scripts/check-behavior.mjs [--old <pkg 디렉터리>] [--new <pkg 디렉터리>] [--only a,b]
//                                   [--attempts 300] [--want 8] [--seed 1] [--dry] [--report <json>]
//
// `op` 로 분류된 기능마다 사례(샘플 문서 + 호출 인자)를 모으고 두 가지를 본다.
//
// 1. 차분 비교: 이전 엔진(--old, 기본 = .tools/engine-builds/ 에 보관된 다른 rev 의 가장 최근 빌드, 없으면 --new)과
//    새 엔진(--new, 기본 upstream/rhwp/pkg)에서 같은 문서·같은 호출을 한 뒤, 양쪽 결과를 새 엔진으로 다시
//    읽어 digest 를 비교한다. 성공/실패와 문단 수도 같아야 한다.
// 2. 재생 가능성: 새 엔진에서 문서 두 개 중 한쪽의 비문서 상태를 흐트러뜨리고(내부·전치 클립보드, 스냅샷
//    저장소, active_field, 조판 미룸) 같은 호출을 해 결과가 같은지 본다. `ctx` 로 담는 숨은 입력(메모 시각 포함)과 `layout`
//    기능의 조판 flush 는 재생 방식대로 맞춘 뒤 비교한다.
//
// 사례가 5개(문서를 바꾼 성공 호출) 미만이거나, 차분이 다르거나, 재생 가능성이 깨지면 `catalog-drift.json`
// 의 `downgraded` 에 이유와 함께 적는다(→ gen-catalog 가 `state` 로 내린다). 이어서 gen-catalog 를 돌린다.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { TEMPLATES, jsonCandidates } from './behavior-templates.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const flag = (name) => process.argv.includes(`--${name}`);

const rev = (readFileSync(join(root, 'upstream.lock'), 'utf8').match(/^rev=(\S+)/m) ?? [])[1] ?? 'unknown';
const NEW_DIR = resolve(root, arg('new', 'upstream/rhwp/pkg'));
/** 이전 엔진: 보관된 빌드(.tools/engine-builds/<rev>/) 중 지금 rev 가 아닌 가장 최근 것. 없으면 새 엔진과 같다. */
function previousBuild() {
  const dir = join(root, '.tools/engine-builds');
  if (!existsSync(dir)) return null;
  const builds = readdirSync(dir)
    .filter((d) => d !== rev && existsSync(join(dir, d, 'rhwp_bg.wasm')))
    .map((d) => ({ d: join(dir, d), t: statSync(join(dir, d, 'rhwp_bg.wasm')).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return builds[0]?.d ?? null;
}
const OLD_DIR = resolve(root, arg('old', previousBuild() ?? NEW_DIR));
const ATTEMPTS = Number(arg('attempts', 300));
const WANT = Number(arg('want', 8));
const NEED = 5;
const ONLY = arg('only', null)?.split(',');
const DRY = flag('dry');
const REPORT = arg('report', null);
const DRIFT = resolve(root, arg('out', 'collab-client/src/engine/catalog-drift.json'));
const SAMPLES = join(root, 'upstream/rhwp/samples');

// ── 엔진 ───────────────────────────────────────────────────────────────
// 기능이 잘못된 인자에 패닉하면(WASM trap) 그 인스턴스는 더 믿을 수 없다 → 새 인스턴스로 갈아 끼운다.
const compiled = new Map();
let generation = 0;
async function loadEngine(dir) {
  if (!compiled.has(dir)) compiled.set(dir, new WebAssembly.Module(readFileSync(join(dir, 'rhwp_bg.wasm'))));
  generation += 1;
  const m = await import(`${pathToFileURL(join(dir, 'rhwp.js')).href}?engine=${encodeURIComponent(dir)}&g=${generation}`);
  m.initSync({ module: compiled.get(dir) });
  return m;
}
let NEW = await loadEngine(NEW_DIR);
let OLD = OLD_DIR === NEW_DIR ? NEW : await loadEngine(OLD_DIR);
let trapped = false;
const TRAP = /memory access out of bounds|unreachable|RuntimeError|recursive use of an object|null pointer passed to rust/i;
async function reloadEngines() {
  NEW = await loadEngine(NEW_DIR);
  OLD = OLD_DIR === NEW_DIR ? NEW : await loadEngine(OLD_DIR);
  trapped = false;
}
const { CATALOG } = await import(pathToFileURL(join(root, 'collab-client/src/engine/catalog.ts')).href);

// ── 무작위 ─────────────────────────────────────────────────────────────
function prng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (n) => (n <= 0 ? 0 : Math.floor(next() * n)), pick: (xs) => xs[Math.floor(next() * xs.length)], chance: (p) => next() < p };
}
const r = prng(Number(arg('seed', 1)));

// ── 샘플 문서 (빈 문서·글 위주·표/그림/개체 포함) ─────────────────────────
const PNG_1PX = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
function blankBytes(m) {
  const d = m.HwpDocument.createEmpty();
  d.createBlankDocument();
  const b = d.exportHwp();
  d.free();
  return b;
}
/** 개체를 고루 넣은 합성 문서. 실패한 단계는 건너뛴다. */
function richBytes(m) {
  const d = m.HwpDocument.createEmpty();
  d.createBlankDocument();
  const steps = [
    () => d.insertText(0, 0, 0, '첫 문단 본문 글자입니다. 둘째 문장.'),
    () => d.splitParagraph(0, 0, 9),
    () => d.insertText(0, 1, 0, '둘째 문단 '),
    () => d.splitParagraph(0, 1, 6),
    () => d.createTable(0, 2, 0, 3, 3),
    () => { for (let c = 0; c < 9; c += 1) d.insertTextInCell(0, 2, 0, c, 0, 0, `칸${c} 글`); },
    () => d.insertText(0, 0, 3, '[각주자리]'),
    () => d.insertFootnote(0, 0, 4),
    () => d.insertEndnote(0, 1, 2),
    () => d.insertClickHereField(0, 0, 6, '안내', '', 'f1', true),
    () => d.insertPicture(0, 1, 1, '', PNG_1PX, 2000, 2000, 1, 1, 'png', 'img', 0, 0),
    () => d.insertEquation(0, 0, 2, 'a+b', 1000, 0),
    () => d.addBookmark(0, 1, 3, 'bm1'),
    () => d.createShapeControl(JSON.stringify({ sectionIdx: 0, paraIdx: 1, charOffset: 4, width: 3000, height: 2000 })),
    // 메모·답글(메모 id 로 고치는 기능의 사례 — 문서를 한 번 만들 때 넣으므로 작성 시각은 모든 사례에 같다)
    () => d.insertMemo(0, 1, 0, 2, JSON.stringify({ author: '갑', text: '있던 메모' })),
    () => d.insertMemoReply(JSON.parse(d.getMemoList())[0].id, JSON.stringify({ author: '을', text: '있던 답글' })),
    () => d.insertMemo(0, 0, 0, 1, JSON.stringify({ author: '병', text: '둘째 메모' })),
    () => d.insertMemo(0, 0, 2, 3, JSON.stringify({ author: '정', text: '셋째 메모' })),
    () => d.insertMemo(0, 0, 4, 5, JSON.stringify({ author: '무', text: '넷째 메모' })),
    () => d.insertMemo(0, 1, 3, 4, JSON.stringify({ author: '기', text: '다섯째 메모' })),
  ];
  for (const s of steps) { try { s(); } catch { /* 이 개체는 없이 */ } }
  const b = d.exportHwp();
  d.free();
  return b;
}
/** 칸 안 양식 개체(샘플에 없고 만드는 export 도 없다): form-01 의 양식 하나를 복사해 끝 문단 표(1×2) 칸 0 문단 0 에 붙인다. */
function formInCellBytes(m) {
  const path = join(SAMPLES, 'form-01.hwp');
  if (!existsSync(path)) return null;
  const d = new m.HwpDocument(readFileSync(path));
  try {
    const n = d.getParagraphCount(0);
    const forms = JSON.parse(d.getControls()).filter((c) => c.list === 0 && c.ctrlId.trim() === 'form');
    const typeOf = (c) => { try { return JSON.parse(d.getFormObjectInfo(0, c.para, c.controlIndex)).formType; } catch { return ''; } };
    const form = forms.find((c) => ['CheckBox', 'Edit'].includes(typeOf(c))) ?? forms[0];
    if (!form) return null;
    const t = JSON.parse(d.createTable(0, n - 1, 0, 1, 2));
    d.copyControl(0, form.para, '', form.controlIndex);
    d.pasteInternalInCell(0, t.paraIdx, t.controlIdx, 0, 0, 0);
    return d.exportHwp();
  } catch {
    return null;
  } finally {
    d.free();
  }
}
const formInCell = formInCellBytes(NEW);
const docs = [
  { name: 'blank', bytes: blankBytes(NEW) },
  { name: 'rich(합성)', bytes: richBytes(NEW) },
  ...(formInCell ? [{ name: 'form-in-cell(합성)', bytes: formInCell }] : []),
  ...['biz_plan.hwp', '143E433F503322BD33.hwp', 'exam_social-p1.hwp', 'footnote-01.hwp', 'form-01.hwp',
    // R14 후속: 업스트림 샘플(희소 경로에 추가 — 우리 저장소에 복사하지 않고 참조만)
    'chart/가로막대형/묶은가로막대형.hwp', 'issue6179/right_tab_footer_logo.hwpx', 'basic/BlogForm_BookReview.hwp', 'basic/BlogForm_MovieReview.hwp', 'basic/BlogForm_Recipe.hwp']
    .filter((f) => existsSync(join(SAMPLES, f)))
    .map((f) => ({ name: f, bytes: readFileSync(join(SAMPLES, f)) })),
];

// ── 문서 상태 요약 ─────────────────────────────────────────────────────
function survey(d) {
  const paras = d.getParagraphCount(0);
  const lens = Array.from({ length: paras }, (_, i) => d.getParagraphLength(0, i));
  let controls = [];
  try { controls = JSON.parse(d.getControls()).filter((c) => c.list === 0 && !['secd', 'cold'].includes(c.ctrlId.trim())); } catch { /* 없음 */ }
  const tables = [];
  for (const c of controls) {
    if (c.ctrlId.trim() !== 'tbl') continue;
    try {
      const dim = JSON.parse(d.getTableDimensions(0, c.para, c.controlIndex));
      const cells = [];
      for (let i = 0; i < Math.min(dim.cellCount, 12); i += 1) {
        const n = d.getCellParagraphCount(0, c.para, c.controlIndex, i);
        cells.push(Array.from({ length: n }, (_, k) => d.getCellParagraphLength(0, c.para, c.controlIndex, i, k)));
      }
      tables.push({ para: c.para, ci: c.controlIndex, rows: dim.rowCount, cols: dim.colCount, cells });
    } catch { /* 표 아님 */ }
  }
  let fields = [];
  try { fields = JSON.parse(d.getFieldList()); } catch { /* 없음 */ }
  return { paras, lens, controls, tables, fields };
}

// ── Ex 변형의 옵션 키 (Rust 소스의 json_*(options_json, "키")) ──────────────
const paramTypes = {};
const exKeys = (() => {
  const out = {};
  const files = [join(root, 'upstream/rhwp/src/wasm_api.rs'), ...readdirSync(join(root, 'upstream/rhwp/src/wasm_api')).filter((f) => f.endsWith('.rs')).map((f) => join(root, 'upstream/rhwp/src/wasm_api', f))];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const block of src.split(/#\[wasm_bindgen\(js_name\s*=\s*/).slice(1)) {
      const name = block.match(/^"?(\w+)"?\)/)?.[1];
      if (!name) continue;
      const body = block.slice(0, 4000);
      const sig = body.match(/pub fn \w+\s*\(\s*&(?:mut )?self\s*,?([^)]*)\)/);
      if (sig && !paramTypes[name]) {
        paramTypes[name] = Object.fromEntries(sig[1].split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [n, ...t] = x.split(':'); return [n.trim(), t.join(':').trim()]; }));
      }
      const keys = [...body.matchAll(/json_(\w+)\(\s*(?:options_json|&?opts?|json)\s*,\s*"(\w+)"\s*\)/g)].map((x) => [x[2], x[1]]);
      if (keys.length) out[name] = Object.fromEntries(keys);
    }
  }
  return out;
})();
const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// ── 인자 만들기 ─────────────────────────────────────────────────────────
const TEXTS = { text: '가나다', new_text: '새 글', name: 'f1', guide: '안내', memo: '메모', replacement_text: '바꿈', formula: '=SUM(A1:A2)', query: '가', html: '<p>붙인 <b>글</b></p>', script: 'x+1', description: 'img', lang: 'ko', basename: 'img', key: 'k', value: '값', bullet_char_str: '●', newname: 'f2', new_name: 'b2', oldname: 'f1', display_path: 'a', id: '1', extension: 'png' };
/** 문자열 인자인데 정해진 값만 받는 것 */
const CHOICES = { axis: ['width', 'height'], operation: ['front', 'back', 'forward', 'backward'], result_format: ['number', 'text'], format: ['number'] };
const BOOLS = /^(editable|is_header|is_textbox|case_sensitive|keep_main_text|write_result|paginate|attach|merge_first|equal_row_height|same_width|vertical|locked|right|below|hide_\w+|after_control)$/;

function makeArgs(name, params, s) {
  const tpl = TEMPLATES[name];
  if (tpl) return tpl(r, s);
  // 초점: 개체(표 우선 — 셀 인자가 있으면) 하나와 그 안의 칸·칸 문단
  const wantsCell = params.some((p) => /cell/.test(p) && !/path/.test(p)) || params.some((p) => /path_json/.test(p))
    || (/Table|Cell/.test(name) && params.some((p) => /control_idx|ctrl_idx|^ci$/.test(p)));
  const ctrl = wantsCell && s.tables.length ? null : (s.controls.length && r.chance(0.8) ? r.pick(s.controls) : null);
  const table = wantsCell && s.tables.length ? r.pick(s.tables) : (ctrl ? s.tables.find((t) => t.para === ctrl.para && t.ci === ctrl.controlIndex) : null);
  const focus = table ? { para: table.para, ci: table.ci } : ctrl ? { para: ctrl.para, ci: ctrl.controlIndex } : { para: r.int(s.paras), ci: 0 };
  const cell = table ? r.int(table.cells.length) : 0;
  const cps = table?.cells[cell] ?? [0];
  const cp = r.int(cps.length);
  const inCell = wantsCell && table;
  const para = r.chance(0.5) ? focus.para : r.int(s.paras);
  const lenOf = (p) => (inCell ? cps[cp] ?? 0 : s.lens[p] ?? 0);
  const out = [];
  let lastStart = 0;
  let lastPara = para;
  for (const p of params) {
    let v;
    if (/^(sec|section_idx|sec_idx|src_section|dst_section|list_id)$/.test(p)) v = 0;
    else if (/^(parent_para_idx|parent_para|table_para|outer_para_idx)$/.test(p)) v = focus.para;
    else if (/^(para_idx|para|para_in_list|src_para|dst_para|start_para_idx|start_para|hf_para_idx|start_hf_para_idx|fn_para_idx|fn_para|note_para_idx|inner_para_idx)$/.test(p)) { v = /^(hf|start_hf|fn|note|inner)/.test(p) ? r.int(2) : para; lastPara = v; }
    else if (/^(end_para_idx|end_para|end_hf_para_idx)$/.test(p)) v = Math.min(s.paras - 1, lastPara + r.int(2));
    else if (/^(control_idx|ci|ctrl_idx|control_index|table_ci|outer_control_idx|note_control_idx|src_control|form_ci)$/.test(p)) v = focus.ci;
    else if (p === 'inner_control_idx') v = r.int(2);
    else if (/^cell_idx$/.test(p) || p === 'edited_cell') v = cell;
    else if (/^(cell_para_idx|cell_para|start_cell_para_idx|end_cell_para_idx)$/.test(p)) v = cp;
    else if (/^(char_offset|offset|pos|start_offset|start_char_offset|start_char_idx|start_pos|start|start_logical|logical_offset|dst_char_offset)$/.test(p)) { v = r.int(lenOf(lastPara) + 1); lastStart = v; }
    else if (/^(end_offset|end_char_offset|end_char_idx|end_pos|end|end_logical)$/.test(p)) v = Math.min(lenOf(lastPara), lastStart + 1 + r.int(3));
    else if (/^(count|delete_count|length)$/.test(p)) v = 1 + r.int(2);
    else if (/^(row|row_idx|target_row|start_row|at_row)$/.test(p)) v = r.int(table?.rows ?? 2);
    else if (/^(col|col_idx|target_col|start_col)$/.test(p)) v = r.int(table?.cols ?? 2);
    else if (p === 'end_row') v = Math.min((table?.rows ?? 2) - 1, 1);
    else if (p === 'end_col') v = Math.min((table?.cols ?? 2) - 1, 1);
    else if (/^(row_count|col_count|n_rows|m_cols|column_count)$/.test(p)) v = 1 + r.int(2) + (p === 'column_count' ? 1 : 0);
    else if (BOOLS.test(p)) v = r.chance(0.5);
    else if (p in TEXTS) v = TEXTS[p];
    else if (p === 'image_data' || p === 'data') v = PNG_1PX;
    else if (/^(natural_width_px|natural_height_px)$/.test(p)) v = 1;
    else if (/^(width|height)$/.test(p)) v = 2000 + r.int(2000);
    else if (/^(d_width|d_height|dx|dy|delta_h|delta_v|horz_offset|vert_offset|offset_x_hu|offset_y_hu|paper_offset_x_hu|paper_offset_y_hu|sx|sy|ex|ey)$/.test(p)) v = r.pick([0, 100, 500]);
    else if (p === 'removed_para_meta') v = null;
    else if (/^(style_id|para_shape_id|char_shape_id|numbering_id|template_id|field_id|index|position|level|start_num|mode|kind|op|operation|axis|format|dash|result_format|apply_to|field_type|column_type|org_state|parent_id)$/.test(p)) v = r.int(3);
    else if (/^(font_size)$/.test(p)) v = 1000 + 100 * r.int(5);
    else if (p === 'color') v = 0xff0000;
    else if (p === 'spacing_hu') v = 500;
    else if (/^(path_json|cell_path_json|src_cell_path_json|dst_cell_path_json)$/.test(p)) v = table ? JSON.stringify([{ controlIndex: table.ci, cellIndex: cell, cellParaIndex: cp }]) : '[]';
    else if (p === 'options_json') v = exOptions(name, s);
    else if (/json$/.test(p)) v = r.pick(jsonCandidates(name, p, s, { table, cell, cp }));
    else v = 0;
    out.push(coerce(v, paramTypes[name]?.[p], p));
  }
  return out;
}
/** Rust 인자 형식에 맞춘다 — 형식이 틀린 값은 바인딩에서 메모리 오류(trap)를 낸다. */
function coerce(v, type, p) {
  if (!type) return v;
  if (/^Option</.test(type) && v === null) return null;
  if (/^&?str$|String/.test(type) && typeof v !== 'string' && p in CHOICES) return CHOICES[p][r.int(CHOICES[p].length)];
  if (/^&?str$|String/.test(type) && typeof v !== 'string') return v === null ? '' : String(TEXTS[p] ?? v);
  if (/^(u8|u16|u32|u64|usize|i32|i64|f64|f32)$/.test(type) && typeof v !== 'number') return typeof v === 'boolean' ? Number(v) : 0;
  if (type === 'bool' && typeof v !== 'boolean') return Boolean(v);
  if (/\[u8\]|Vec<u8>/.test(type) && !(v instanceof Uint8Array)) return new Uint8Array();
  return v;
}
function exOptions(name, s) {
  const keys = exKeys[name];
  if (!keys) return '{}';
  const params = Object.keys(keys).map(snake);
  const vals = makeArgs(`${name}#opts`, params, s);
  const o = {};
  Object.keys(keys).forEach((k, i) => { o[k] = vals[i]; });
  return JSON.stringify(o);
}

// ── 호출 ───────────────────────────────────────────────────────────────
const encode = (a) => a.map((v) => (v instanceof Uint8Array ? { $b64: Buffer.from(v).toString('base64') } : v));
const decode = (a) => a.map((v) => (v && typeof v === 'object' && '$b64' in v ? Uint8Array.from(Buffer.from(v.$b64, 'base64')) : v));
let lastError = '';
/** ctx.memoTime 으로 시각을 담는 기능(메모 만들기)은 재생 방식대로 같은 시각을 이 호출 하나 동안 고정한다. */
const MEMO_TIME = '134000000000000000';
const pinsMemoTime = (name) => (CATALOG[name]?.ctx ?? []).includes('memoTime');
function call(d, name, args) {
  const prev = pinsMemoTime(name) && typeof d.collabSetMemoTime === 'function' ? d.collabSetMemoTime(MEMO_TIME) : null;
  try { d[name](...decode(args)); return true; } catch (e) {
    lastError = String(e?.message ?? e).slice(0, 140);
    if (TRAP.test(lastError) || e instanceof WebAssembly.RuntimeError) trapped = true;
    return false;
  } finally {
    if (prev !== null) { try { d.collabSetMemoTime(prev); } catch { /* 멈춘 인스턴스 */ } }
  }
}
/** 사례 = { doc, prep: [[메서드, 인자]...], args }. 준비 단계는 두 엔진에서 똑같이 먼저 부른다. */
function run(d, name, c) {
  for (const [m, a] of c.prep ?? []) if (!call(d, m, a)) return false;
  return call(d, name, c.args);
}
const open = (m, bytes) => new m.HwpDocument(bytes);

// ── 사례 모으기 ─────────────────────────────────────────────────────────
async function collect(name, entry) {
  const params = entry.params ?? [];
  const cases = [];
  const docSurveys = docs.map((doc) => { const d = open(NEW, doc.bytes); const s = survey(d); d.free(); return s; });
  let successes = 0;
  if (trapped) await reloadEngines();
  const errors = {};
  for (let i = 0; i < ATTEMPTS && cases.length < WANT; i += 1) {
    const di = i % docs.length;
    const s = docSurveys[di];
    let made;
    try { made = makeArgs(name, params, s); } catch { continue; }
    if (made === null) continue;
    const c = Array.isArray(made) ? { doc: di, args: encode(made) } : { doc: di, prep: (made.prep ?? []).map(([m, a]) => [m, encode(a)]), args: made.args ? encode(made.args) : null };
    const d = open(NEW, docs[di].bytes);
    let ok = true;
    for (const [m, a] of c.prep ?? []) if (!call(d, m, a)) { ok = false; break; }
    if (ok && !c.args) {
      // 준비 뒤 문서를 보고 인자를 정한다(방금 만든 개체의 번호 등). { prep, args } 면 준비를 더 한다.
      let got = null;
      try { got = made.argsFrom(d, survey(d)); } catch { got = null; }
      if (got && !Array.isArray(got)) {
        const more = (got.prep ?? []).map(([m, a]) => [m, encode(a)]);
        for (const [m, a] of more) if (!call(d, m, a)) { ok = false; break; }
        c.prep = [...(c.prep ?? []), ...more];
        got = got.args;
      }
      if (ok && Array.isArray(got)) c.args = encode(got); else ok = false;
    }
    const before = ok ? d.collabDigest() : '';
    ok = ok && call(d, name, c.args);
    if (!ok) errors[lastError] = (errors[lastError] ?? 0) + 1;
    const changed = ok && d.collabDigest() !== before;
    d.free();
    if (ok) successes += 1;
    const key = JSON.stringify([c.prep, c.args]);
    if (changed && !cases.some((x) => x.doc === di && JSON.stringify([x.prep, x.args]) === key)) cases.push(c);
    if (trapped) { errors['(trap) ' + lastError] = (errors['(trap) ' + lastError] ?? 0) + 1; await reloadEngines(); }
  }
  const topError = Object.entries(errors).sort((a, b) => b[1] - a[1])[0]?.[0];
  return { cases, successes, topError };
}

// ── 차분 비교 ───────────────────────────────────────────────────────────
function exportOf(d) { return typeof d.collabExportState === 'function' ? d.collabExportState() : d.exportHwp(); }
function normalized(bytes) {
  const d = NEW.HwpDocument.createEmpty();
  d.collabLoadState(bytes);
  const g = d.collabDigest();
  d.free();
  return g;
}
function differential(name, c) {
  const a = open(OLD, docs[c.doc].bytes);
  const b = open(NEW, docs[c.doc].bytes);
  const okA = run(a, name, c);
  const okB = run(b, name, c);
  let why = null;
  if (okA !== okB) why = `성공 여부가 다름 (이전 ${okA}, 새 ${okB})`;
  else if (a.getParagraphCount(0) !== b.getParagraphCount(0)) why = `문단 수가 다름 (${a.getParagraphCount(0)} vs ${b.getParagraphCount(0)})`;
  else if (okA && normalized(exportOf(a)) !== normalized(exportOf(b))) why = '결과 문서가 다름';
  a.free();
  b.free();
  return why;
}

// ── 재생 가능성 ─────────────────────────────────────────────────────────
function firstText(s) { const p = s.lens.findIndex((l) => l > 0); return p < 0 ? null : { p, len: s.lens[p] }; }
const AXES = {
  /** 내부 클립보드·전치 클립보드를 채운다 (ctx.clipboard 로 담는 기능은 재생 때 맞추므로 제외) */
  clipboard(d, s, entry) {
    if ((entry.ctx ?? []).includes('clipboard')) return false;
    const t = firstText(s);
    if (!t) return false;
    d.copySelection(0, t.p, 0, t.p, Math.min(3, t.len));
    const tb = s.tables[0];
    if (tb) { try { d.copyTableCellsTransposed(0, tb.para, tb.ci, 0, 0, 0, 0); } catch { /* 없음 */ } }
    return true;
  },
  /** 스냅샷 저장소를 쓴다 */
  stores(d) { d.saveSnapshot(); return true; },
  /** active_field 를 다른 값으로 */
  activeField(d, s, entry) {
    if ((entry.ctx ?? []).includes('activeField')) return false; // ctx 로 담는 기능은 재생 때 맞춘다
    const f = s.fields.find((x) => x && Number.isInteger(x.para ?? x.paraIdx));
    if (!f) return false;
    try { d.setActiveField(0, f.para ?? f.paraIdx, (f.charOffset ?? f.offset ?? 0) + 1); } catch { return false; }
    return d.collabGetActiveField() !== 'null';
  },
  /** 조판을 미룬 상태 vs 끝낸 상태 (layout 기능은 재생 때 flush 하므로 맞춘다) */
  pagination(d, s, entry) {
    if (entry.layout) return false;
    d.beginDeferredPagination?.();
    return true;
  },
};
function replay(name, entry, c, s) {
  const fails = [];
  for (const [axis, disturb] of Object.entries(AXES)) {
    const a = open(NEW, docs[c.doc].bytes);
    const b = open(NEW, docs[c.doc].bytes);
    let applied = false;
    try { applied = disturb(b, s, entry); } catch { applied = false; }
    if (!applied) { a.free(); b.free(); continue; }
    if (entry.layout) { a.collabFlushLayout(); b.collabFlushLayout(); }
    const okA = run(a, name, c);
    const okB = run(b, name, c);
    // 미룬 조판은 언젠가 끝난다(화면 그리기·layout 연산 전 flush). 끝낸 뒤의 문서를 비교한다.
    for (const d of [a, b]) { try { d.flushDeferredPagination?.(); d.collabFlushLayout(); } catch { /* 없음 */ } }
    if (okA !== okB || (okA && a.collabDigest() !== b.collabDigest())) fails.push(axis);
    a.free();
    b.free();
  }
  return fails;
}

// ── 실행 ───────────────────────────────────────────────────────────────
const t0 = Date.now();
// 대상: op 기능 + 지난 검사가 내린 기능(분류표상 state 지만 감사 판정은 op — 다시 본다)
const features = Object.entries(CATALOG).filter(([n, e]) => (e.sync === 'op' || (e.sync === 'state' && /^동작 동일성 검사/.test(e.why ?? ''))) && (!ONLY || ONLY.includes(n)));
const report = {};
const downgraded = {};
for (const [name, entry] of features) {
  const { cases, successes, topError } = await collect(name, entry);
  const res = { cases: cases.length, successes, diff: null, replay: [], topError };
  if (cases.length < NEED) {
    res.verdict = 'nocase';
    downgraded[name] = `사례 부족 (문서를 바꾼 성공 호출 ${cases.length}개 < ${NEED}, 성공 ${successes}/${ATTEMPTS})`;
  } else {
    const surveys = docs.map((doc) => { const d = open(NEW, doc.bytes); const s = survey(d); d.free(); return s; });
    for (const c of cases) {
      const why = differential(name, c);
      if (trapped) { await reloadEngines(); continue; } // 사례가 엔진을 멈췄다 — 이 사례는 판단에서 뺀다
      if (why && !res.diff) res.diff = `${why} — 사례 ${docs[c.doc].name} ${JSON.stringify(c.args).slice(0, 160)}`;
      const fails = replay(name, entry, c, surveys[c.doc]);
      if (trapped) { await reloadEngines(); continue; }
      for (const axis of fails) {
        if (!res.replay.includes(axis)) res.replay.push(axis);
        if (!res.replayCase) res.replayCase = `${docs[c.doc].name} ${JSON.stringify(c.args).slice(0, 160)}`;
      }
    }
    if (res.diff) { res.verdict = 'differ'; downgraded[name] = `이전 엔진과 동작이 다름: ${res.diff}`; }
    else if (res.replay.length) { res.verdict = 'replay'; downgraded[name] = `재생 가능성 깨짐(${res.replay.join(', ')}): ${res.replayCase}`; }
    else res.verdict = 'same';
  }
  report[name] = res;
  if (process.stdout.isTTY || flag('verbose')) console.log(`${res.verdict.padEnd(7)} ${name} 사례 ${res.cases} 성공 ${successes}${res.replay.length ? ` 재생✗ ${res.replay}` : ''}${res.diff ? ` 차분✗` : ''}`);
}
const count = (v) => Object.values(report).filter((x) => x.verdict === v).length;
const summary = {
  old: OLD_DIR === NEW_DIR ? '(새 엔진과 같음)' : OLD_DIR.replace(root + '/', ''),
  new: NEW_DIR.replace(root + '/', ''),
  docs: docs.map((d) => d.name),
  features: features.length,
  same: count('same'), differ: count('differ'), replay: count('replay'), nocase: count('nocase'),
  seconds: Math.round((Date.now() - t0) / 1000),
};
console.log(`동작 같음 ${summary.same}, 다름 → 결과 전송 ${summary.differ}, 재생 가능성 깨짐 → 결과 전송 ${summary.replay}, 사례 없음 ${summary.nocase} (${summary.seconds}초)`);
for (const v of ['differ', 'replay']) {
  const names = Object.entries(report).filter(([, x]) => x.verdict === v).map(([n]) => n);
  if (names.length) console.log(`  ${v}: ${names.join(', ')}`);
}
if (REPORT) writeFileSync(REPORT, JSON.stringify({ summary, report }, null, 1));
if (!DRY && !ONLY) {
  writeFileSync(DRIFT, `${JSON.stringify({ generatedBy: 'scripts/check-behavior.mjs', summary, downgraded }, null, 1)}\n`);
  execFileSync(process.execPath, [join(root, 'scripts/gen-catalog.mjs')], { stdio: 'inherit' });
}
