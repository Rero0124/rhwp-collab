// R1: 분류표 생성 스크립트와 조회 (docs/collab-stage2.md §3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOG, ENGINE_FINGERPRINT, COMPOSED_METHODS } from '../src/engine/catalog.ts';
import { classify, methodsToIntercept } from '../src/engine/classify.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gen = join(repo, 'scripts/gen-catalog.mjs');

/** 작은 가짜 업스트림으로 생성 스크립트를 돌린다. */
function fixture({ registry, rust, overrides, drift, excluded = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'gen-catalog-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'patches'));
  mkdirSync(join(dir, 'studio'));
  const list = (xs) => xs.map((n) => `'${n}'`).join(', ');
  writeFileSync(join(dir, 'registry.ts'), `export const MUTATING_METHODS: readonly string[] = [${list(registry)}];\nexport const EXCLUDED_NON_DOCUMENT: readonly string[] = [${list(excluded)}];\n`);
  writeFileSync(join(dir, 'src/wasm_api.rs'), `impl HwpDocument {\n${rust}}\n\nimpl HwpViewer {\n${rustExport('setZoom', 'set_zoom', ['zoom'])}}\n`);
  // 덮어쓰기는 types.ts 를 import type 하므로 같은 자리에 둔다.
  cpSync(join(repo, 'collab-client/src/engine/types.ts'), join(dir, 'types.ts'));
  writeFileSync(join(dir, 'overrides.ts'), `import type { CatalogOverride } from './types.ts';\nexport const OVERRIDES: Record<string, CatalogOverride> = ${JSON.stringify(overrides)};\n`);
  if (drift) writeFileSync(join(dir, 'drift.json'), JSON.stringify({ downgraded: drift }));
  writeFileSync(join(dir, 'upstream.lock'), 'rev=0123456789abcdef\n');
  writeFileSync(join(dir, 'patches/0001.patch'), 'diff\n');
  const run = (extra = []) => spawnSync(process.execPath, [gen,
    '--registry', join(dir, 'registry.ts'), '--rust-src', join(dir, 'src'),
    '--overrides', join(dir, 'overrides.ts'), '--drift', join(dir, 'drift.json'),
    '--out', join(dir, 'catalog.ts'), '--lock', join(dir, 'upstream.lock'), '--patches', join(dir, 'patches'),
    // studio 호출처 훑기를 fixture 안으로 — 기본(레지스트리의 한 단계 위)은 여기서 시스템 임시 디렉터리 전체다
    '--studio-src', join(dir, 'studio'), ...extra,
  ], { encoding: 'utf8' });
  const read = async () => import(`${join(dir, 'catalog.ts')}?t=${Date.now()}${Math.random()}`);
  return { dir, run, read };
}
function rustExport(js, rust, params, recv = '&mut self') {
  return `    #[wasm_bindgen(js_name = ${js})]\n    pub fn ${rust}(${[recv, ...params.map((p) => `${p}: u32`)].join(', ')}) -> Result<String, JsValue> { todo!() }\n`;
}

const RUST = rustExport('insertText', 'insert_text', ['section_idx', 'para_idx', 'char_offset'])
  + rustExport('applyCharFormat', 'apply_char_format', ['sec_idx', 'para_idx', 'start_offset', 'end_offset'])
  + rustExport('brandNewFeature', 'brand_new_feature', ['section_idx', 'para_idx']);

test('실제 업스트림: 모든 항목이 감사됐고 catalog.ts 가 최신이다', () => {
  const out = execFileSync(process.execPath, [gen, '--check'], { cwd: repo, encoding: 'utf8' });
  assert.match(out, /"unreviewed":0/);
  assert.ok(Object.values(CATALOG).every((e) => e.reviewed));
  assert.equal(Object.keys(CATALOG).length, 314, 'HwpDocument 의 &mut self export 전부');
  assert.ok(!Object.keys(CATALOG).some((n) => n.startsWith('collab')), '우리 collab* export 는 감싸지 않는다');
  assert.deepEqual([...COMPOSED_METHODS].sort(), ['insertHyperlink', 'removeHyperlink', 'replaceHyperlinkText', 'setPageMargin', 'updateHyperlink']);
  assert.match(ENGINE_FINGERPRINT, /^[0-9a-f]{12}-[0-9a-f]{12}-[0-9a-f]{12}-[0-9a-f]{12}$/);
});

test('실제 분류: state 는 로컬 상태 의존 기능, text 는 7종, neutral 은 roles 가 있다', () => {
  const state = Object.entries(CATALOG).filter(([, e]) => e.sync === 'state').map(([n]) => n).sort();
  // R1 감사의 state + R1b 동작 동일성 검사가 내린 기능(catalog-drift.json)
  // R13: 내부 클립보드 붙여넣기는 ctx.clipboard 를 담는 op 로 올렸다(전치 붙여넣기만 state).
  const audited = ['importParagraphBlock', 'pasteTableCellsTransposed', 'pasteTableCellsTransposedAsTable', 'removeBorderFillTails',
    'restoreDeleteFragment', 'restoreSectionRaw', 'restoreSnapshot', 'swapPictureTransform'];
  for (const n of ['pasteInternal', 'pasteInternalInCell', 'pasteInternalInCellByPath', 'pasteInternalTextLogical', 'pasteControl']) {
    assert.equal(CATALOG[n].sync, 'op', n);
    assert.deepEqual(CATALOG[n].ctx, ['clipboard'], `${n}: ctx.clipboard`);
    assert.ok(CATALOG[n].roles?.some((r) => r.kind === 'anchor'), `${n}: 발자국 기준`);
  }
  const driftPath = new URL('../src/engine/catalog-drift.json', import.meta.url);
  const downgraded = existsSync(driftPath) ? Object.keys(JSON.parse(readFileSync(driftPath, 'utf8')).downgraded ?? {}) : [];
  assert.deepEqual(state, [...new Set([...audited, ...downgraded])].sort());
  for (const n of downgraded) if (!audited.includes(n)) assert.match(CATALOG[n].why, /동작 동일성 검사/, `${n}: 내린 이유`);
  // R14: studio 호출처
  assert.equal(CATALOG.insertText.reach, 'studio');
  assert.equal(CATALOG.insertMemo.reach, 'none', 'studio 에 메모 UI 가 없다');
  assert.equal(CATALOG.toggleHideHeaderFooter.sync, 'local');
  assert.equal(CATALOG.registerHftOutlineFont.sync, 'none');
  assert.equal(CATALOG.setActiveField.sync, 'none', '업스트림 제외 목록은 none');
  assert.equal(CATALOG.setCaretPosition.sync, 'none');
  // 메모 넣기는 지금 시각을 쓴다(memo_time::now) — R1b 가 같은 빌드끼리도 결과가 달라 내렸다
  assert.equal(CATALOG.insertMemo.sync, 'state');
  assert.ok(!Object.values(CATALOG).some((e) => e.sync === 'watch'), '감사하지 않은 레지스트리 밖 이름 없음');
  for (const n of ['insertText', 'insertTextLogical', 'replaceBodyTextLocal', 'insertTextInCell', 'pasteHtml', 'evaluateTableFormula']) {
    assert.deepEqual(CATALOG[n].ctx, ['activeField'], `${n}: ctx.activeField`);
  }
  for (const n of ['insertFootnote', 'deleteFootnote', 'groupShapes', 'insertPicture', 'insertPictureInCell', 'applyParaFormat', 'reflowLinesegs']) {
    assert.equal(CATALOG[n].layout, true, `${n}: layout`);
  }
  const text = Object.entries(CATALOG).filter(([, e]) => e.conc === 'text').map(([n]) => n).sort();
  assert.deepEqual(text, ['deleteRange', 'deleteRangeInCell', 'deleteRangeInCellByPath', 'deleteRangeInCellEx', 'deleteText',
    'deleteTextInCell', 'deleteTextInCellByPath', 'deleteTextInCellDeferredPagination', 'deleteTextInCellEx', 'insertText',
    'insertTextInCell', 'insertTextInCellByPath', 'insertTextInCellDeferredPagination', 'insertTextInCellEx', 'insertTextLogical',
    'mergeParagraph', 'mergeParagraphInCell', 'mergeParagraphInCellByPath', 'replaceBodyTextLocal', 'replaceTextInCellDeferredPagination',
    'splitParagraph', 'splitParagraphInCell', 'splitParagraphInCellByPath'], 'R13: 셀 텍스트 연산 포함');
  // R13: 구조 연산의 발자국 기준
  assert.deepEqual(CATALOG.insertTableRow.roles, [{ kind: 'anchor', arg: 1, control: 2 }], '표 구조는 문단+개체');
  assert.deepEqual(CATALOG.createTable.roles, [{ kind: 'anchor', arg: 1 }], '개체 만들기는 문단');
  for (const [name, e] of Object.entries(CATALOG)) {
    if (e.sync === 'op' && e.conc === 'neutral') assert.ok(Array.isArray(e.roles) && e.why, `${name}: neutral 은 roles·why`);
    if (['state', 'local', 'none'].includes(e.sync)) assert.ok(e.why, `${name}: ${e.sync} 는 why`);
  }
  // 구역 인자 자동 탐지
  assert.equal(CATALOG.insertText.section, 0);
  assert.equal(CATALOG.setNoteEquationProperties.section, 1);
  assert.equal(CATALOG.relocateFloatingPicture.section, null, '구역 인자가 둘이면 문서 전체');
  assert.equal(CATALOG.updateStyle.section, null);
});

test('분류표에 없는 가짜 이름은 state/structural 로 동기화된다', () => {
  const e = classify('totallyNewUpstreamFeature');
  assert.equal(e.sync, 'state');
  assert.equal(e.conc, 'structural');
  assert.equal(e.reviewed, false);
  // 훅은 실행 중인 레지스트리의 이름도 감싼다(분류표에 없어도). 문서 객체에 없는 합성 이름은 뺀다.
  const has = (n) => n !== 'setPageMargin';
  const names = methodsToIntercept(['totallyNewUpstreamFeature', 'setPageMargin', 'insertText'], has);
  assert.ok(names.includes('totallyNewUpstreamFeature'));
  assert.ok(!names.includes('setPageMargin'));
  assert.ok(names.includes('restoreSnapshot'), '레지스트리 밖 분류표 이름도 감싼다');
  assert.ok(names.includes('swapPictureTransform'));
});

test('생성: 새 이름은 경고하고 state 로 둔다', async () => {
  const f = fixture({
    registry: ['insertText', 'applyCharFormat', 'brandNewFeature'],
    rust: RUST,
    overrides: {
      insertText: { params: ['section_idx', 'para_idx', 'char_offset'], conc: 'text' },
      applyCharFormat: { params: ['sec_idx', 'para_idx', 'start_offset', 'end_offset'], conc: 'neutral', roles: [{ kind: 'range', para: 1, start: 2, end: 3 }], why: '서식' },
    },
  });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /분류 필요: 1개.*brandNewFeature/);
  const { CATALOG: c } = await f.read();
  assert.equal(c.brandNewFeature.sync, 'state');
  assert.equal(c.brandNewFeature.reviewed, false);
  assert.equal(c.insertText.conc, 'text');
  assert.equal(c.applyCharFormat.conc, 'neutral');
});

test('생성: 인자 목록이 바뀐 이름은 state 로 내리고, 사라진 이름은 빼고, 둘 다 경고한다', async () => {
  const f = fixture({
    registry: ['insertText', 'applyCharFormat'],
    rust: RUST,
    overrides: {
      insertText: { params: ['section_idx', 'para_idx', 'char_offset'], conc: 'text' },
      applyCharFormat: { params: ['sec_idx', 'para_idx', 'start', 'end'], conc: 'neutral', roles: [], why: '서식' },
      removedFeature: { params: ['a'] },
    },
  });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /인자 목록이 바뀜: 1개.*applyCharFormat/);
  assert.match(r.stderr, /사라진 이름: 1개.*removedFeature/);
  const { CATALOG: c } = await f.read();
  assert.equal(c.applyCharFormat.sync, 'state');
  assert.equal(c.applyCharFormat.conc, 'structural');
  assert.equal(c.removedFeature, undefined);
});

test('생성: 동작 동일성 검사에서 내린 기능은 state, 지문이 바뀐다', async () => {
  const base = {
    registry: ['insertText', 'applyCharFormat'],
    rust: RUST,
    overrides: {
      insertText: { params: ['section_idx', 'para_idx', 'char_offset'], conc: 'text' },
      applyCharFormat: { params: ['sec_idx', 'para_idx', 'start_offset', 'end_offset'], conc: 'neutral', roles: [], why: '서식' },
    },
  };
  const a = fixture(base);
  assert.equal(a.run().status, 0);
  const b = fixture({ ...base, drift: { applyCharFormat: '이전·새 엔진 결과 digest 다름' } });
  assert.equal(b.run().status, 0);
  const ca = await a.read(), cb = await b.read();
  assert.equal(cb.CATALOG.applyCharFormat.sync, 'state');
  assert.match(cb.CATALOG.applyCharFormat.why, /동작 동일성 검사/);
  assert.notEqual(ca.ENGINE_FINGERPRINT, cb.ENGINE_FINGERPRINT);
});

test('생성: 덮어쓰기 형식 오류(neutral 인데 roles 없음)는 멈춘다', () => {
  const f = fixture({
    registry: ['applyCharFormat'],
    rust: RUST,
    overrides: { applyCharFormat: { params: ['sec_idx', 'para_idx', 'start_offset', 'end_offset'], conc: 'neutral', why: 'x' } },
  });
  const r = f.run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /roles 가 필요/);
});

test('생성: 레지스트리 밖 새 &mut 이름은 digest 감시, 제외 목록은 none, 다른 구조체·&self 는 대상 아님', async () => {
  const f = fixture({
    registry: ['insertText'],
    excluded: ['setActiveField'],
    rust: RUST
      + rustExport('setActiveField', 'set_active_field', ['section_idx'])
      + rustExport('outsideNewThing', 'outside_new_thing', ['sec'])
      + rustExport('readOnlyThing', 'read_only_thing', ['sec'], '&self')
      + rustExport('collabInternal', 'collab_internal', []),
    overrides: { insertText: { params: ['section_idx', 'para_idx', 'char_offset'], conc: 'text', ctx: ['activeField'] } },
  });
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /분류 필요\(레지스트리 밖\): \d+개 \(digest 감시\).*outsideNewThing/);
  const { CATALOG: c } = await f.read();
  assert.equal(c.outsideNewThing.sync, 'watch');
  assert.equal(c.setActiveField.sync, 'none');
  assert.equal(c.readOnlyThing, undefined, '&self 는 대상 아님');
  assert.equal(c.setZoom, undefined, '다른 구조체(HwpViewer)는 대상 아님');
  assert.equal(c.collabInternal, undefined);
  assert.deepEqual(c.insertText.ctx, ['activeField']);
});

test('생성: local·none 에 conc·ctx 를 쓰면 형식 오류', () => {
  const f = fixture({
    registry: ['insertText'],
    rust: RUST,
    overrides: { insertText: { params: ['section_idx', 'para_idx', 'char_offset'], sync: 'none', why: 'x', ctx: ['activeField'] } },
  });
  const r = f.run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /local·none 은 기록하지 않으므로/);
});
