// R4: collab 엔진 (docs/collab-stage2.md §5) — 실제 WASM 문서 위에서.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { loadWasm, blankBytes, paragraphs, Client, Server } from './support/harness.mjs';
import { CollabEngine } from '../src/engine/engine.ts';
import { classify } from '../src/engine/classify.ts';

let m;
let base;
before(async () => {
  m = await loadWasm();
  base = blankBytes();
});

function pair() {
  const server = new Server(base);
  const a = new Client('A', base, server);
  const b = new Client('B', base, server);
  return { server, a, b, all: [a, b] };
}

function assertConverged(server, clients, label = '') {
  const digests = clients.map((c) => c.digest());
  assert.ok(digests.every((d) => d === digests[0]), `${label} digest 불일치: ${digests.map((d) => d.slice(0, 8))} ${clients.map((c) => JSON.stringify(paragraphs(c.doc)))}`);
  assert.equal(server.replayDigest(), digests[0], `${label} 서버 로그 재생과 다름`);
  for (const c of clients) assert.deepEqual(c.errors, [], `${c.id} 오류`);
}

test('기록: 공유 문서·녹화 중일 때만, 텍스트 연산은 meta 를 실측해 붙인다', () => {
  const { a } = pair();
  const other = new m.HwpDocument(base);
  other.insertText(0, 0, 0, '다른 문서');
  assert.equal(a.engine.pendingCount, 0, '공유 문서가 아닌 객체의 호출은 기록하지 않는다');

  a.engine.setRecording(false);
  a.doc.insertText(0, 0, 0, 'x');
  assert.equal(a.engine.pendingCount, 0, '녹화 중이 아니면 기록하지 않는다');
  a.engine.setRecording(true);

  a.doc.insertText(0, 0, 1, 'abc😀');
  a.doc.deleteText(0, 0, 3, 100);
  a.doc.splitParagraph(0, 0, 1);
  a.doc.mergeParagraph(0, 1);
  const got = a.engine.takePending();
  assert.deepEqual(got.map((e) => [e.m, e.meta]), [
    ['insertText', { len: 4 }],
    ['deleteText', { count: 2 }],
    ['splitParagraph', {}],
    ['mergeParagraph', { prevLen: 1 }],
  ]);
  assert.equal(got[0].ctx?.activeField, null, 'ctx.activeField 를 담는다(없으면 null)');
  assert.ok(a.engine.hasSnapshot, '미확정이 있으면 확정 상태 스냅샷이 있다');
  a.close();
  other.free();
});

test('기록: none·local 은 기록하지 않고, 붙여넣기는 ctx.clipboard op, state 는 결과를 담으며 보내지 않은 state 는 마지막 것만 남긴다', () => {
  const { a } = pair();
  a.doc.setFileName('x.hwp');
  a.doc.toggleHideHeaderFooter(0, true);
  assert.equal(a.engine.pendingCount, 0, 'none(setFileName)·local(toggleHideHeaderFooter)');

  a.doc.insertText(0, 0, 0, '복사할 글');
  a.doc.copySelection(0, 0, 0, 0, 3);
  assert.equal(a.engine.pendingCount, 1, 'copySelection 은 none');
  // R13: 내부 클립보드 붙여넣기는 ctx.clipboard 를 담은 op
  a.doc.pasteInternal(0, 0, 5);
  let got = a.engine.takePending();
  assert.deepEqual(got.map((e) => [e.kind, e.m]), [['op', 'insertText'], ['op', 'pasteInternal']]);
  assert.equal(typeof got[1].ctx.clipboard.paras, 'string', '클립보드 문단을 담는다');
  assert.equal(typeof got[1].meta.pd, 'number', '구조 연산은 문단 수 변화를 잰다');
  // state(메모 넣기 — 지금 시각을 쓴다)는 결과를 담고, 보내지 않은 연속 state 는 마지막 것만
  a.doc.insertMemo(0, 0, 0, 3, JSON.stringify({ author: 'a', text: '첫 메모' }));
  a.doc.insertMemo(0, 0, 4, 6, JSON.stringify({ author: 'a', text: '둘째 메모' }));
  got = a.engine.takePending();
  assert.deepEqual(got.map((e) => e.kind), ['state'], '연속된 보내지 않은 state 는 하나로');
  const check = new m.HwpDocument(base);
  check.collabLoadState(Uint8Array.from(atob(got[0].data), (c) => c.charCodeAt(0)));
  assert.equal(check.collabDigest(), a.digest(), 'state 는 결과(문서 전체)');
  check.free();
  a.close();
});

test('기록: watch 는 digest 가 바뀔 때만 state, 기록할 수 없는 인자는 state', () => {
  const server = new Server(base);
  const doc = new m.HwpDocument(base);
  const fake = (name) => (name === 'setFileName' || name === 'insertText' ? { ...classify(name), sync: 'watch' } : classify(name));
  const engine = new CollabEngine({ classify: fake });
  engine.attach(doc);
  engine.setRecording(true);
  engine.intercept('setFileName', ['y.hwp'], () => doc.setFileName('y.hwp'), doc);
  assert.equal(engine.pendingCount, 0, '문서를 안 바꾸면 무시');
  assert.equal(engine.hasSnapshot, false, '만든 스냅샷도 버린다');
  engine.intercept('insertText', [0, 0, 0, 'z'], () => doc.insertText(0, 0, 0, 'z'), doc);
  assert.deepEqual(engine.takePending().map((e) => e.kind), ['state']);
  engine.intercept('updateStyle', [{ not: 'encodable' }], () => undefined, doc);
  assert.deepEqual(engine.takePending().map((e) => e.kind), ['state'], '객체 인자 → state');
  engine.detach();
  doc.free();
  void server;
});

test('동시 편집: 같은 지점 입력 — 먼저 확정된 쪽이 앞, 모두 같은 문서', () => {
  const { server, a, b, all } = pair();
  a.doc.insertText(0, 0, 0, 'ab');
  server.drain(all);
  a.doc.insertText(0, 0, 1, 'A');
  b.doc.insertText(0, 0, 1, 'B');
  a.flush();
  b.flush();
  server.drain(all);
  assertConverged(server, all);
  assert.deepEqual(paragraphs(a.doc), ['aABb']);
  all.forEach((c) => c.close());
});

test('동시 편집: 내 삭제 범위 안 남의 입력은 살아남고, Enter vs Backspace 도 수렴', () => {
  const { server, a, b, all } = pair();
  a.doc.insertText(0, 0, 0, '0123456789');
  server.drain(all);
  a.doc.insertText(0, 0, 5, 'XY');
  b.doc.deleteText(0, 0, 2, 6);
  a.flush(); b.flush();
  server.drain(all);
  assertConverged(server, all, '삭제 vs 입력');
  assert.deepEqual(paragraphs(a.doc), ['01XY89']);

  b.doc.splitParagraph(0, 0, 2);
  a.doc.splitParagraph(0, 0, 6);
  server.drain(all);
  a.doc.mergeParagraph(0, 1);
  b.doc.mergeParagraph(0, 1);
  b.flush(); a.flush();
  server.drain(all);
  assertConverged(server, all, 'Enter vs Backspace');
  all.forEach((c) => c.close());
});

test('동시 편집: 응답을 기다리며 계속 친 글자(여러 묶음)와 거절·재전송', () => {
  const { server, a, b, all } = pair();
  a.doc.insertText(0, 0, 0, 'hello');
  server.drain(all);
  // A 가 한 묶음을 보낸 뒤 확정 전에 더 친다. B 도 그사이 친다. B 가 먼저 확정된다.
  b.doc.insertText(0, 0, 0, '>>');
  b.flush();
  a.doc.insertText(0, 0, 5, ' w');
  a.flush();
  a.doc.insertText(0, 0, 7, 'or');
  a.doc.insertText(0, 0, 9, 'ld');
  server.drain(all);
  assertConverged(server, all);
  assert.deepEqual(paragraphs(a.doc), ['>>hello world'], '각자 친 글자가 이어져 있다');
  all.forEach((c) => c.close());
});

test('동시 편집: 서식(neutral) 범위가 남의 입력만큼 옮겨지고, 굵게가 상대에게 반영된다', () => {
  const { server, a, b, all } = pair();
  a.doc.insertText(0, 0, 0, 'abcdef');
  server.drain(all);
  b.doc.applyCharFormat(0, 0, 2, 4, '{"bold":true}');
  a.doc.insertText(0, 0, 0, '__');
  a.flush(); b.flush();
  server.drain(all);
  assertConverged(server, all);
  const props = JSON.parse(a.doc.getCharPropertiesAt(0, 0, 4));
  assert.equal(props.bold, true, 'cd(이제 4..6)가 굵게');
  all.forEach((c) => c.close());
});

test('동시 편집: 같은 구역 구조 변경이 겹치면 늦은 쪽 편집과 그 뒤가 취소되고 알린다', () => {
  const { server, a, b, all } = pair();
  a.doc.insertText(0, 0, 0, '표 앞');
  server.drain(all);
  a.doc.insertText(0, 0, 0, 'A');
  b.doc.createTable(0, 0, 3, 2, 2);
  b.doc.insertText(0, 0, 0, 'B');
  a.flush(); b.flush();
  server.drain(all);
  assertConverged(server, all);
  assert.equal(b.dropped, 2, 'B 의 표 만들기와 그 뒤 입력이 취소');
  assert.match(b.drops[0], /구조/);
  all.forEach((c) => c.close());
});

test('ctx.activeField: 기록 때 값을 담고 재생 때 그 값으로 맞춘 뒤 되돌린다', () => {
  const { server, a, b, all } = pair();
  a.doc.insertText(0, 0, 0, 'field here');
  server.drain(all);
  // 누름틀 넣기는 structural op — 동기화된다
  a.doc.insertClickHereField(0, 0, 5, '안내', '', 'f1', true);
  server.drain(all);
  const field = JSON.parse(a.doc.getFieldList()).find((f) => f.name === 'f1');
  assert.ok(field, '누름틀이 생겼다');
  a.doc.setActiveField(0, 0, 6);
  const af = a.doc.collabGetActiveField();
  a.doc.insertText(0, 0, 6, '값');
  const entry = a.engine.takePending()[0];
  assert.deepEqual(entry.ctx.activeField, JSON.parse(af));
  a.engine.requeue();
  b.doc.collabSetActiveField('null');
  server.drain(all);
  assertConverged(server, all);
  assert.equal(b.doc.collabGetActiveField(), 'null', '재생 뒤 B 의 활성 필드는 원래대로');
  all.forEach((c) => c.close());
});

test('layout 연산은 기록 직전과 재생 직전에 미룬 조판을 끝낸다', () => {
  const { server, a, b, all } = pair();
  let flushes = { A: 0, B: 0 };
  for (const c of all) {
    const original = c.doc.collabFlushLayout.bind(c.doc);
    c.doc.collabFlushLayout = () => { flushes[c.id] += 1; original(); };
  }
  a.doc.insertText(0, 0, 0, '각주 자리');
  a.doc.insertFootnote(0, 0, 2);
  assert.equal(flushes.A, 1, '기록 쪽 원래 호출 직전');
  server.drain(all);
  assert.equal(flushes.B, 1, '재생 직전');
  assertConverged(server, all);
  all.forEach((c) => c.close());
});

test('캐럿: 미확정이 없을 때와 있을 때 모두 원격 지도로 옮긴다', () => {
  const { server, a, b, all } = pair();
  a.doc.insertText(0, 0, 0, 'abcdef');
  server.drain(all);
  // 미확정이 없을 때: B 의 "XY" 가 앞에 들어오면 A 의 캐럿(3)은 5
  b.doc.insertText(0, 0, 0, 'XY');
  b.flush();
  while (server.deliverOne(b)); // B 는 자기 확정을 받는다
  let msg = server.queues.get(a).shift();
  let res = a.engine.receiveRemote(msg.entries, { section: 0, para: 0, offset: 3 });
  assert.equal(res.rebased, false);
  assert.equal(res.caret.offset, 5);
  a.lastSeq = msg.seq;
  // 미확정이 있을 때: A 가 끝(8)에 "!" 를 친 뒤 캐럿 9, B 의 "<" 가 앞에 들어오면 10
  a.doc.insertText(0, 0, 8, '!');
  b.doc.insertText(0, 0, 0, '<');
  b.flush();
  while (server.deliverOne(b));
  msg = server.queues.get(a).shift();
  res = a.engine.receiveRemote(msg.entries, { section: 0, para: 0, offset: 9 });
  assert.equal(res.rebased, true);
  assert.equal(res.caret.offset, 10);
  a.lastSeq = msg.seq;
  server.drain(all);
  assertConverged(server, all);
  all.forEach((c) => c.close());
});
