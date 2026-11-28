// 7단계 A: 결과 전송(state)에 자동 범위 표시 (docs/collab-stage7.md A). 보내는 쪽이 state 가 될 호출 직전 스냅샷과 견주어
// 한 구역의 연속 문단 범위만 바뀌었고 DocInfo 가 그대로면 범위 표시를 단다 — 받는 쪽은 그 범위의 구조 편집으로 보고 보정하므로
// 왕복 중이던 남의 입력이 취소되지 않는다. 실패는 언제나 보통 state 로(편집은 막지 않음), 미리 뜬 스냅샷은 언제나 버린다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWasm, blankBytes, Client, Server, paragraphs } from './support/harness.mjs';

await loadWasm();

/** 빈 문서에 문단 n 개(`p{i}`), 정본 + S1 다시 쓰기 서버(범위 표시를 확인한다) */
function room(n = 5) {
  const base = blankBytes();
  const server = new Server(base, { canonical: true, rewriteState: true });
  const a = new Client('A', base, server);
  const b = new Client('B', base, server);
  for (let i = 0; i < n; i += 1) {
    if (i > 0) a.doc.splitParagraph(0, i - 1, a.doc.getParagraphLength(0, i - 1));
    a.doc.insertText(0, i, 0, `p${i}`);
  }
  server.drain([a, b]);
  return { server, a, b, all: [a, b] };
}
/** 덧말 넣기 — 분류표 state(사례 부족으로 op 로 못 올린 기능) */
const ruby = (doc, p) => doc.insertRuby(0, p, 0, JSON.stringify({ mainText: '漢', rubyText: '한', below: false, styleId: null }));
const states = (r) => r.server.log.flatMap((m) => m.entries).filter((e) => e.kind === 'state');
const converged = (r) => {
  r.server.drain(r.all);
  const ds = r.all.map((c) => c.digest());
  assert.ok(ds.every((d) => d === ds[0]), '수렴');
  assert.equal(r.server.replayDigest(), ds[0], '서버 기록 재생 = 참여자');
  assert.deepEqual(r.all.map((c) => c.errors), r.all.map(() => []));
};
const leftovers = (r) => r.all.map((c) => [c.doc.collabSnapshotCount(), c.engine.recipeCount()]);

test('7A ① 덧말 넣기(state)에 범위 표시 — 정본 확인을 지나 기록·방송에 남고, 남은 스냅샷·재료 0', () => {
  const r = room();
  ruby(r.a.doc, 2);
  converged(r);
  const st = states(r);
  assert.equal(st.length, 1);
  assert.deepEqual(st[0].range, { section: 0, lo: 2, before: 1, after: 1 }, '덧말을 넣은 문단 하나');
  assert.equal(r.a.engine.stateHints.hinted, 1);
  assert.equal(r.server.rangeChecks, 1);
  assert.equal(r.server.rangeRejects, 0);
  assert.deepEqual(leftovers(r), [[0, 0], [0, 0]], '미리 뜬 스냅샷·복원 재료가 남지 않는다');
});

test('7A ② B 가 계속 치는 중: A 의 state 가 먼저 가도, B 의 묶음이 먼저 가도 둘 다 취소되지 않는다', () => {
  for (const order of ['A 먼저', 'B 먼저']) {
    const r = room();
    ruby(r.a.doc, 2);
    if (order === 'A 먼저') {
      r.a.flush();
      r.b.doc.insertText(0, 4, 0, 'B');
      r.b.flush(); // A 의 state 뒤라 reject
      while (r.server.deliverOne(r.b)) { /* B: 미확정이 있는 채로 A 의 범위 표시 state */ }
    } else {
      r.b.doc.splitParagraph(0, 0, 1);
      r.b.flush();
      r.server.deliverOne(r.b);
      while (r.server.deliverOne(r.a)) { /* A: 미확정 state 가 있는 채로 B 의 Enter → 옮긴 자리에서 다시 만듦 */ }
    }
    converged(r);
    assert.deepEqual([r.a.dropped, r.b.dropped], [0, 0], order);
    assert.equal(r.server.rangeRejects, 0, order);
    assert.deepEqual(leftovers(r), [[0, 0], [0, 0]], order);
    const ps = paragraphs(r.a.doc);
    assert.equal(ps.length, order === 'A 먼저' ? 5 : 6, order);
    if (order === 'A 먼저') assert.equal(ps[4], 'Bp4');
  }
});

test('7A ③ 조건이 맞지 않는 state 는 보통 state — 대조군: 그러면 B 의 왕복 중 입력이 취소된다', () => {
  const r = room();
  // 보조가 "DocInfo 가 바뀜"이라 답하는 경우(덧붙이는 state 기능과 같다)
  r.a.doc.collabStateRangeHint = () => JSON.stringify({ reason: 'docinfo' });
  ruby(r.a.doc, 2);
  r.a.flush();
  r.b.doc.insertText(0, 4, 0, 'B');
  r.b.flush();
  while (r.server.deliverOne(r.b)) { /* 받기 */ }
  converged(r);
  assert.equal(states(r)[0].range, undefined, '표시 없음');
  assert.deepEqual(r.a.engine.stateHints.reasons, { docinfo: 1 });
  assert.ok(r.b.dropped > 0, '보통 state 는 모든 미확정과 충돌한다');
});

test('7A ④ 보조가 예외를 던져도 편집은 보통 state 로 나가고, 미리 뜬 스냅샷은 남지 않는다', () => {
  const r = room();
  r.a.doc.collabStateRangeHint = () => { throw new Error('보조 고장'); };
  ruby(r.a.doc, 2);
  converged(r);
  const st = states(r);
  assert.equal(st.length, 1, '편집은 나간다');
  assert.equal(st[0].range, undefined);
  assert.deepEqual(r.a.engine.stateHints.reasons, { error: 1 });
  assert.deepEqual(leftovers(r), [[0, 0], [0, 0]]);
  assert.match(paragraphs(r.b.doc)[2], /漢|p2/);
});

test('7A ⑤ 호출 자체가 실패해도 미리 뜬 스냅샷은 남지 않는다', () => {
  const r = room();
  assert.throws(() => ruby(r.a.doc, 99));
  assert.equal(r.a.engine.pendingCount, 0, '기록하지 않는다');
  assert.deepEqual(leftovers(r), [[0, 0], [0, 0]]);
  converged(r);
});

test('7A ⑥ 보내지 않은 범위 state 둘은 두 범위를 합친 하나로 — B 의 입력은 그대로, 재료도 하나만 남았다가 풀린다', () => {
  const r = room(6);
  r.b.doc.insertText(0, 5, 0, 'B');
  r.b.flush(); // B 의 묶음이 먼저 서버로 → A 가 보낸 것은 거절되고 다시 만든다
  ruby(r.a.doc, 1);
  r.a.flush(); // 보낸 state 하나(서버가 아직 읽지 않음)
  ruby(r.a.doc, 2);
  ruby(r.a.doc, 4);
  assert.equal(r.a.engine.pendingCount, 2, '보낸 것 1 + 보내지 않은 연속 범위 state 는 하나로');
  assert.equal(r.a.engine.recipeCount(), 2, '합친 것은 재료 하나');
  r.a.doc.splitParagraph(0, 0, 1);
  ruby(r.a.doc, 3);
  assert.equal(r.a.engine.pendingCount, 4, '사이에 op 가 있으면 합치지 않는다');
  converged(r);
  const st = states(r);
  assert.equal(st.length, 3);
  assert.deepEqual(st[1].range, { section: 0, lo: 2, before: 3, after: 3 }, '문단 2 와 4 를 덮는 한 범위');
  assert.deepEqual([r.a.dropped, r.b.dropped], [0, 0]);
  assert.equal(r.server.rangeRejects, 0);
  assert.equal(paragraphs(r.a.doc).at(-1), 'Bp5');
  assert.deepEqual(leftovers(r), [[0, 0], [0, 0]]);
});

test('7A ⑦ 앞선 내 서식 op 가 덧붙인 항목 번호가 남의 덧붙임으로 밀리면: 범위 state 는 다시 만들지 않고 충돌(표시 없는 때와 같은 결과), 수렴', () => {
  const r = room(4);
  r.b.doc.applyCharFormat(0, 3, 0, 2, JSON.stringify({ italic: true })); // B: 글자 모양 덧붙임(#k)
  r.b.flush();
  r.a.doc.applyCharFormat(0, 1, 0, 2, JSON.stringify({ bold: true })); // A: 덧붙임(#k — B 뒤로 가면 #k+1)
  ruby(r.a.doc, 1); // 그 번호를 쓰는 문단의 범위 state — 재료 문단은 #k 를 가리킨다
  assert.equal(r.a.engine.stateHints.hinted, 1);
  r.server.drain([r.b, r.a]);
  converged(r);
  assert.equal(r.a.dropped, 1, '범위 state 만 버림(앞의 서식 op 는 다시 적용됨)');
  assert.equal(r.b.dropped, 0);
  assert.equal(r.server.rangeRejects, 0);
  assert.deepEqual(leftovers(r), [[0, 0], [0, 0]]);
});
