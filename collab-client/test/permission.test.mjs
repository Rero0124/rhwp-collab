// 5단계 D4: 클라이언트 기록 프록시의 권한 문(docs/collab-protocol.md §4.8). 실제 WASM 문서·엔진·기록 훅(harness).
// 막힌 호출은 문서 코어에 닿지 않고(문서·미확정 그대로) PermissionDenied 로 던지며, onDenied 로 안내 문구가 간다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWasm, blankBytes, Client, Server, paragraphs } from './support/harness.mjs';
import { PermissionDenied, DENIED_TEXT } from '../src/engine/engine.ts';

await loadWasm();

/** 문단 0 "이름:  끝" 의 4 에 누름틀(값 abc). 권한 없이 만든 뒤 시작한다. */
function setup() {
  const base = blankBytes();
  const server = new Server(base);
  const c = new Client('A', base, server);
  c.denied = [];
  // harness 의 엔진은 onDenied 를 받지 않으므로 바꿔 끼운다(엔진 옵션은 생성 때만) — 같은 방식으로 감싸 기록한다
  c.engine.onDenied = (m) => c.denied.push(m);
  c.doc.insertText(0, 0, 0, '이름:  끝');
  c.doc.insertClickHereField(0, 0, 4, '이름', '', 'name', true);
  const fields = JSON.parse(c.doc.getFieldList());
  const field = fields.find((f) => f.name === 'name') ?? fields[0];
  c.doc.setFieldValue(field.fieldId ?? field.id, 'abc');
  server.drain([c]);
  return { c, server, fieldId: field.fieldId ?? field.id };
}
const denies = (c, fn, what) => {
  const before = { text: paragraphs(c.doc), pending: c.engine.pendingCount };
  assert.throws(fn, (e) => e instanceof PermissionDenied, `${what}: PermissionDenied`);
  assert.deepEqual(paragraphs(c.doc), before.text, `${what}: 문서 그대로`);
  assert.equal(c.engine.pendingCount, before.pending, `${what}: 기록 없음`);
};
const allows = (c, fn, what) => {
  const pending = c.engine.pendingCount;
  fn();
  assert.ok(c.engine.pendingCount > pending, `${what}: 기록됨`);
};

test('view: 편집 호출은 모두 코어에 닿기 전에 거절, 읽기는 통과', () => {
  const { c } = setup();
  c.engine.setScope('view');
  denies(c, () => c.doc.insertText(0, 0, 0, 'x'), '입력');
  denies(c, () => c.doc.splitParagraph(0, 0, 1), 'Enter');
  denies(c, () => c.doc.applyCharFormat(0, 0, 0, 2, '{"bold":true}'), '서식');
  denies(c, () => c.doc.insertMemo(0, 0, 0, 2, '{"author":"나","text":"메모"}'), '메모');
  assert.equal(c.doc.getParagraphCount(0), 1, '읽기는 통과');
  assert.deepEqual([...new Set(c.denied)], [DENIED_TEXT.view]);
});

test('form: 양식 값(perm form)과 활성 누름틀 안 글자만, 그 밖은 거절', () => {
  const { c, fieldId } = setup();
  c.engine.setScope('form');
  allows(c, () => c.doc.setFieldValue(fieldId, '홍길동'), '누름틀 값');
  // 활성 누름틀(캐럿이 누름틀 안) — studio 가 맞추는 세션 상태
  // 필드 컨트롤은 getControls 에서 ctrlId 가 빈 문자열로 보인다(구역 정의·단 정의 다음)
  const ci = JSON.parse(c.doc.getControls()).find((x) => x.list === 0 && x.para === 0 && x.ctrlId.trim() === '')?.controlIndex;
  assert.ok(Number.isInteger(ci), '누름틀 개체 번호');
  c.doc.collabSetActiveField(JSON.stringify({ section: 0, para: 0, control: ci, cellPath: null }));
  allows(c, () => c.doc.insertText(0, 0, 5, 'Z'), '누름틀 안 입력');
  denies(c, () => c.doc.insertText(0, 0, 0, 'x'), '누름틀 밖 입력');
  denies(c, () => c.doc.splitParagraph(0, 0, 5), '누름틀 안 Enter(구조)');
  denies(c, () => c.doc.applyCharFormat(0, 0, 4, 6, '{"bold":true}'), '서식');
  denies(c, () => c.doc.insertMemo(0, 0, 0, 2, '{"author":"나","text":"메모"}'), '메모');
  // 활성 누름틀이 없으면 글자 입력은 거절
  c.doc.collabSetActiveField('null');
  denies(c, () => c.doc.insertText(0, 0, 5, 'Z'), '활성 누름틀 없음');
  assert.deepEqual([...new Set(c.denied)], [DENIED_TEXT.form]);
});

test('comment: 메모(perm memo)만', () => {
  const { c } = setup();
  c.engine.setScope('comment');
  allows(c, () => c.doc.insertMemo(0, 0, 0, 2, '{"author":"나","text":"메모"}'), '메모 넣기');
  denies(c, () => c.doc.insertText(0, 0, 0, 'x'), '본문 입력');
  denies(c, () => c.doc.setFieldValue(1, 'x'), '누름틀 값');
  assert.deepEqual([...new Set(c.denied)], [DENIED_TEXT.comment]);
});

test('edit(또는 권한 정보 없음 = 인증을 끈 서버)이면 문이 없다', () => {
  const { c } = setup();
  c.engine.setScope('form edit');
  allows(c, () => c.doc.insertText(0, 0, 0, 'x'), 'edit 포함');
  c.engine.setScope(null);
  allows(c, () => c.doc.splitParagraph(0, 0, 1), 'null');
  assert.deepEqual(c.denied, []);
});
