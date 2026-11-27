#!/usr/bin/env node
// collab 분류표 생성 (docs/collab-stage2.md §3).
//
//   node scripts/gen-catalog.mjs [--check]
//
// 입력
//   - studio 변경 메서드 목록  upstream/rhwp/rhwp-studio/src/core/mutation-method-registry.ts
//   - export 시그니처         upstream/rhwp/src/wasm_api.rs (+ src/wasm_api/*.rs)
//   - 사람이 감사한 판정       collab-client/src/engine/catalog-overrides.ts
//   - 동작 동일성 검사 결과     collab-client/src/engine/catalog-drift.json (있으면, R1b)
// 출력
//   - collab-client/src/engine/catalog.ts
//
// 원칙(사용자 결정): "기존 기능은 그대로 빠르게, 새 기능은 느리더라도 동작은 한다."
// 스크립트는 멈추지 않고 안전한 쪽(state/structural)으로 내리기만 한다.
//   - 덮어쓰기에 없는 새 이름        → state/structural + 경고 "분류 필요"
//   - 감사 때와 인자 목록이 다른 이름 → state/structural + 경고
//   - 사라진 이름                    → 분류표에서 빠짐 + 경고
//   - 동작 동일성 검사에서 다름/사례 없음 → state + 근거
// 덮어쓰기 파일 자체의 형식 오류(neutral 인데 roles 없음 등)만 오류로 멈춘다.
//
// --check: catalog.ts 를 쓰지 않고, 쓸 내용이 지금 파일과 다르면 종료 코드 1.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const paths = {
  registry: resolve(root, arg('registry', 'upstream/rhwp/rhwp-studio/src/core/mutation-method-registry.ts')),
  rustSrc: resolve(root, arg('rust-src', 'upstream/rhwp/src')),
  overrides: resolve(root, arg('overrides', 'collab-client/src/engine/catalog-overrides.ts')),
  drift: resolve(root, arg('drift', 'collab-client/src/engine/catalog-drift.json')),
  out: resolve(root, arg('out', 'collab-client/src/engine/catalog.ts')),
  lock: resolve(root, arg('lock', 'upstream.lock')),
  patches: resolve(root, arg('patches', 'patches/rhwp')),
  collabCore: resolve(root, arg('collab-core', 'collab-core/src')),
  engineSrc: resolve(root, arg('engine-src', 'collab-client/src/engine')),
  // studio 호출처(R14 reach)를 훑을 소스 뿌리. 기본은 레지스트리(src/core/…)의 한 단계 위(src/). 시험처럼 레지스트리가
  // 임시 디렉터리 바로 아래 있으면 그 위가 시스템 임시 디렉터리 전체가 되므로 명시한다.
  studioSrc: arg('studio-src', null),
};
const checkOnly = process.argv.includes('--check');

const warnings = [];
const warn = (msg) => warnings.push(msg);
const fail = (msg) => { console.error(`gen-catalog: 오류: ${msg}`); process.exit(2); };

// ── 1. studio 레지스트리 ───────────────────────────────────────────────
function parseList(src, name) {
  const m = src.match(new RegExp(`export const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!m) fail(`${relative(root, paths.registry)} 에서 ${name} 를 찾지 못했습니다`);
  return [...m[1].replace(/\/\/.*$/gm, '').matchAll(/'([A-Za-z0-9_]+)'/g)].map((x) => x[1]);
}
const registrySrc = readFileSync(paths.registry, 'utf8');
const MUTATING = parseList(registrySrc, 'MUTATING_METHODS');
const EXCLUDED = registrySrc.includes('EXCLUDED_NON_DOCUMENT') ? parseList(registrySrc, 'EXCLUDED_NON_DOCUMENT') : [];

// ── 2. export 시그니처 (Rust 소스) ─────────────────────────────────────
function rustFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...rustFiles(p));
    else if (entry.name.endsWith('.rs') && !/tests?\.rs$/.test(entry.name)) out.push(p);
  }
  return out;
}
function splitTopLevel(s) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if ('(<['.includes(ch)) depth += 1;
    if (')>]'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}
function parseExports() {
  const files = [join(paths.rustSrc, 'wasm_api.rs')];
  const sub = join(paths.rustSrc, 'wasm_api');
  if (existsSync(sub)) files.push(...rustFiles(sub));
  const exports = new Map();
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    // export 의 소속 구조체 = 바로 앞에 나온 impl 머리줄(impl 블록은 중첩되지 않는다). 중괄호 짝 맞추기는
    // 문자열·주석 속 중괄호에 깨지므로 쓰지 않는다.
    const impls = [...src.matchAll(/^\s*impl\s+(?:<[^>]*>\s*)?(?:[A-Za-z_]+::)*([A-Za-z0-9_]+)\s*\{/gm)].map((x) => [x.index, x[1]]);
    const re = /#\[wasm_bindgen\(js_name\s*=\s*([A-Za-z0-9_]+)\s*\)\]\s*(?:#\[[^\]]*\]\s*)*pub fn [a-z0-9_]+\s*(?:<[^>]*>)?\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      const owner = impls.filter(([pos]) => pos < m.index).at(-1)?.[1];
      if (owner !== 'HwpDocument') continue;
      let depth = 1, i = re.lastIndex;
      while (i < src.length && depth > 0) {
        if (src[i] === '(') depth += 1;
        else if (src[i] === ')') depth -= 1;
        i += 1;
      }
      const raw = src.slice(re.lastIndex, i - 1);
      const params = splitTopLevel(raw)
        .filter((p) => !/^&\s*(mut\s+)?self$/.test(p) && p !== 'self')
        .map((p) => p.split(':')[0].trim().replace(/^mut\s+/, ''));
      const isMut = /&\s*mut\s+self/.test(raw);
      if (!exports.has(m[1]) && !m[1].startsWith('collab')) exports.set(m[1], { params, isMut });
    }
  }
  return exports;
}
const EXPORTS = parseExports();

// ── 3. 분류 대상 ───────────────────────────────────────────────────────
// `HwpDocument` 의 `&mut self` export 전부(기록 훅이 이것들을 감싼다, R1 감사 결정 3) + 레지스트리의
// export. 우리 자신의 `collab*` export 는 뺀다. 레지스트리의 나머지(studio 합성 메서드)는 내부에서
// 분류표의 export(아래 EXTRA 등)를 부른다. `&self` export 는 문서를 바꾸지 않는다고 본다.
const EXTRA = [
  // studio 합성 메서드가 실제로 부르는 export
  'insertHyperlinkEx', 'updateHyperlinkEx', 'replaceHyperlinkTextEx', 'removeHyperlinkEx',
  // 레지스트리의 EXCLUDED_NON_DOCUMENT 에 있지만 IR 을 바꾸는 복원·교환 (로컬 저장소 id 사용)
  'restoreSnapshot', 'restoreDeleteFragment', 'restoreSectionRaw', 'swapPictureTransform',
  // 설계 §3 의 text 7종에 포함 (레지스트리에는 없음)
  'deleteRangeInCellEx',
];
const composed = MUTATING.filter((n) => !EXPORTS.has(n));
const mutExports = [...EXPORTS].filter(([, e]) => e.isMut).map(([n]) => n);
const targets = [...new Set([...MUTATING.filter((n) => EXPORTS.has(n)), ...EXTRA.filter((n) => EXPORTS.has(n)), ...mutExports])];
for (const n of EXTRA) if (!EXPORTS.has(n)) warn(`EXTRA 의 ${n} 가 export 에 없습니다 (빠짐)`);

// ── 4. 덮어쓰기 ────────────────────────────────────────────────────────
const { OVERRIDES } = await import(pathToFileURL(paths.overrides).href);
const SECTION_PARAMS = ['section_idx', 'sec_idx', 'sec'];
const sectionIndex = (params) => {
  const idx = params.findIndex((p) => SECTION_PARAMS.includes(p));
  const sectionLike = params.filter((p) => /(^|_)sec(tion)?(_|$)/.test(p));
  return idx >= 0 && sectionLike.length === 1 ? idx : null;
};

function validateOverride(name, o, params) {
  const where = `catalog-overrides.ts 의 ${name}`;
  if (o.sync && !['op', 'state', 'local', 'none'].includes(o.sync)) fail(`${where}: sync 값 ${o.sync}`);
  if (o.conc && !['text', 'neutral', 'structural'].includes(o.conc)) fail(`${where}: conc 값 ${o.conc}`);
  if ((['state', 'local', 'none'].includes(o.sync) || o.conc === 'neutral') && !o.why) fail(`${where}: state·local·none·neutral 은 why 가 필요합니다`);
  if (['local', 'none'].includes(o.sync) && (o.conc || o.roles || o.ctx || o.layout)) fail(`${where}: local·none 은 기록하지 않으므로 conc·roles·ctx·layout 을 쓰지 않습니다`);
  for (const c of o.ctx ?? []) if (!['activeField', 'clipboard'].includes(c)) fail(`${where}: ctx 값 ${c}`);
  if (o.perm !== undefined && !['form', 'memo'].includes(o.perm)) fail(`${where}: perm 값 ${o.perm}(form·memo, 없으면 edit)`);
  if (o.perm !== undefined && ['local', 'none'].includes(o.sync)) fail(`${where}: local·none 은 기록하지 않으므로 perm 을 쓰지 않습니다`);
  if (o.conc === 'neutral' && !Array.isArray(o.roles)) fail(`${where}: neutral 은 roles 가 필요합니다(위치 인자가 없으면 [])`);
  // R13: 구조 연산은 발자국의 기준(anchor: 문단 인자, 표 구조 연산은 + control: 개체 인자)만 쓴다.
  if (o.roles && o.conc !== 'neutral' && !(o.conc !== 'text' && o.roles.every((r) => r.kind === 'anchor'))) fail(`${where}: roles 는 neutral 과 구조 연산의 anchor 에만 씁니다`);
  for (const r of o.roles ?? []) {
    const idx = r.kind === 'range' ? [r.para, r.start, r.end] : [r.arg, ...(r.control === undefined ? [] : [r.control])];
    if (!['para', 'range', 'anchor'].includes(r.kind)) fail(`${where}: role kind ${r.kind}`);
    for (const i of idx) if (!Number.isInteger(i) || i < 0 || i >= params.length) fail(`${where}: role 인자 위치 ${i} 가 범위 밖`);
  }
}

let drift = {};
if (existsSync(paths.drift)) drift = JSON.parse(readFileSync(paths.drift, 'utf8')).downgraded ?? {};

const catalog = {};
const newNames = [], newWatched = [], changed = [];
const inRegistry = (name) => MUTATING.includes(name) || EXTRA.includes(name);
for (const name of targets.sort()) {
  const params = EXPORTS.get(name).params;
  const section = sectionIndex(params);
  const o = OVERRIDES[name];
  if (!o) {
    if (inRegistry(name)) {
      newNames.push(name);
      catalog[name] = { sync: 'state', conc: 'structural', params, section, why: '분류 필요(새 업스트림 기능) — 결과로 보낸다', reviewed: false };
    } else if (EXCLUDED.includes(name)) {
      // 업스트림이 직접 "문서 IR 비변경" 으로 분류한 이름. 기록하지 않는다.
      catalog[name] = { sync: 'none', conc: 'structural', params, section, why: 'studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)', reviewed: true };
    } else {
      // 레지스트리 밖 새 이름: 대부분 문서를 바꾸지 않으므로 digest 감시(바뀌면 결과 전송).
      newWatched.push(name);
      catalog[name] = { sync: 'watch', conc: 'structural', params, section, why: '분류 필요(레지스트리 밖 새 이름) — digest 감시', reviewed: false };
    }
    continue;
  }
  if (JSON.stringify(o.params) !== JSON.stringify(params)) {
    changed.push(`${name}(${o.params.join(',')} → ${params.join(',')})`);
    catalog[name] = { sync: 'state', conc: 'structural', params, section, why: '감사 이후 인자 목록이 바뀜 — 결과로 보낸다', reviewed: false };
    continue;
  }
  validateOverride(name, o, params);
  const entry = { sync: o.sync ?? 'op', conc: o.conc ?? 'structural', params, section };
  if (o.roles) entry.roles = o.roles;
  if (o.layout) entry.layout = true;
  if (o.ctx?.length) entry.ctx = o.ctx;
  if (o.perm) entry.perm = o.perm;
  if (o.why) entry.why = o.why;
  entry.reviewed = true;
  if (drift[name] && entry.sync === 'op') {
    entry.sync = 'state';
    entry.why = `동작 동일성 검사: ${drift[name]}`;
  }
  catalog[name] = entry;
}
const vanished = Object.keys(OVERRIDES).filter((n) => !targets.includes(n));
if (newNames.length) warn(`분류 필요: ${newNames.length}개 (결과로 보냄) — ${newNames.join(', ')}`);
if (newWatched.length) warn(`분류 필요(레지스트리 밖): ${newWatched.length}개 (digest 감시) — ${newWatched.join(', ')}`);
if (changed.length) warn(`인자 목록이 바뀜: ${changed.length}개 (결과로 보냄) — ${changed.join(', ')}`);
if (vanished.length) warn(`사라진 이름: ${vanished.length}개 (분류표에서 뺌) — ${vanished.join(', ')}`);

// ── 4b. studio 호출처 (R14 reach) ───────────────────────────────────────
// studio: 메뉴·도구·단축키 경로(command·engine·ui·view·core 등)에서 부른다 / plugin: 플러그인·hwpctl·AI·자동화
// 경로나 다리(wasm-bridge)에서만 / none: studio 가 부르지 않는다(레지스트리에만 있음).
{
  const studioSrc = paths.studioSrc ? resolve(root, paths.studioSrc) : resolve(dirname(paths.registry), '..');
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, f.name);
      if (f.isDirectory()) walk(full);
      else if (/\.(ts|mts|js)$/.test(f.name) && !/\.test\./.test(f.name)) files.push(full);
    }
  };
  if (existsSync(studioSrc)) walk(studioSrc);
  const PLUGIN_ONLY = /\/(ai|automation|document-agent|hwpctl|plugin|dev|i18n)\//;
  const texts = files
    .filter((f) => !f.endsWith('mutation-method-registry.ts'))
    // 주석 속 언급은 호출처가 아니다
    .map((f) => ({ rel: relative(studioSrc, f), src: readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1') }));
  for (const [name, entry] of Object.entries(catalog)) {
    const re = new RegExp(`\\b${name}\\b`);
    const hits = texts.filter((t) => re.test(t.src)).map((t) => t.rel);
    const studio = hits.some((h) => !PLUGIN_ONLY.test(`/${h}`) && !h.endsWith('wasm-bridge.ts'));
    entry.reach = studio ? 'studio' : hits.length ? 'plugin' : 'none';
  }
}

// ── 5. 엔진 지문 (§7: 한 방은 한 엔진 버전만) ──────────────────────────
const sha = (s) => createHash('sha256').update(s).digest('hex');
const catalogJson = JSON.stringify(catalog);
const catalogHash = sha(catalogJson).slice(0, 16);
const rev = (readFileSync(paths.lock, 'utf8').match(/^rev=(\S+)/m) ?? [])[1] ?? 'unknown';
const patchFiles = existsSync(paths.patches) ? readdirSync(paths.patches).filter((f) => f.endsWith('.patch')).sort() : [];
const patchHash = sha(patchFiles.map((f) => `${f}\n${readFileSync(join(paths.patches, f), 'utf8')}`).join('\n')).slice(0, 16);
// 보정·기록 코드도 지문에 넣는다 — 같은 업스트림·분류표라도 collab-core(보정 함수)나 엔진이 다르면 같은 기록을
// 다르게 보정·재생할 수 있다. 시험 파일과 생성 파일(catalog.ts — 분류표 해시가 따로 있다)은 뺀다.
const codeFiles = [
  ...(existsSync(paths.collabCore) ? readdirSync(paths.collabCore).filter((f) => f.endsWith('.rs') && !/tests\.rs$/.test(f)).map((f) => join(paths.collabCore, f)) : []),
  ...(existsSync(paths.engineSrc) ? readdirSync(paths.engineSrc).filter((f) => f.endsWith('.ts') && f !== 'catalog.ts').map((f) => join(paths.engineSrc, f)) : []),
].sort();
const codeHash = sha(codeFiles.map((f) => `${relative(root, f)}\n${readFileSync(f, 'utf8')}`).join('\n')).slice(0, 12);
const fingerprint = `${rev.slice(0, 12)}-${patchHash.slice(0, 12)}-${codeHash}-${catalogHash.slice(0, 12)}`;

// ── 6. 출력 ────────────────────────────────────────────────────────────
const counts = (pred) => Object.values(catalog).filter(pred).length;
const summary = {
  total: targets.length,
  op: counts((e) => e.sync === 'op'),
  state: counts((e) => e.sync === 'state'),
  local: counts((e) => e.sync === 'local'),
  none: counts((e) => e.sync === 'none'),
  watch: counts((e) => e.sync === 'watch'),
  text: counts((e) => e.sync === 'op' && e.conc === 'text'),
  neutral: counts((e) => e.sync === 'op' && e.conc === 'neutral'),
  structural: counts((e) => e.sync === 'op' && e.conc === 'structural'),
  ctx: counts((e) => e.ctx?.length > 0),
  layout: counts((e) => e.layout === true),
  permForm: counts((e) => e.perm === 'form'),
  permMemo: counts((e) => e.perm === 'memo'),
  unreviewed: counts((e) => !e.reviewed),
};
const out = `// 생성 파일 — 직접 고치지 않는다. scripts/gen-catalog.mjs 가 만든다.
// 판정은 catalog-overrides.ts, 동작 동일성 검사 결과는 catalog-drift.json 에서 온다.
import type { CatalogEntry } from './types.ts';

/** 엔진 지문: 업스트림 커밋-패치 해시-보정·기록 코드 해시-분류표 해시. 방의 참여자는 모두 같아야 한다. */
export const ENGINE_FINGERPRINT = ${JSON.stringify(fingerprint)};

/** studio 합성 메서드(레지스트리에 있으나 export 가 아님). 내부에서 분류표의 export 를 부른다. */
export const COMPOSED_METHODS: readonly string[] = ${JSON.stringify(composed)};

/** ${JSON.stringify(summary)} */
export const CATALOG: Readonly<Record<string, CatalogEntry>> = ${JSON.stringify(catalog, null, 2)};
`;

for (const w of warnings) console.warn(`gen-catalog: 경고: ${w}`);
console.log(`gen-catalog: ${JSON.stringify(summary)} 지문 ${fingerprint}`);
if (checkOnly) {
  const current = existsSync(paths.out) ? readFileSync(paths.out, 'utf8') : '';
  if (current !== out) { console.error('gen-catalog: catalog.ts 가 최신이 아닙니다'); process.exit(1); }
} else {
  writeFileSync(paths.out, out);
}
