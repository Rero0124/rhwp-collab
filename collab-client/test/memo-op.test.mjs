// 5단계 D4 후속: 메모 함수를 op 로 — 메모를 만드는 호출은 지금 시각을 메모에 박으므로 기록 쪽이 시각을 정해
// 호출 하나 동안 고정하고 ctx.memoTime 으로 보낸다(재생 쪽은 같은 시각으로 고정). 메모 id 는 field_id(새 메모는 최대 + 1)
// 라 동시에 둘이 메모를 넣으면 같은 id 가 되지만, 발자국 없는 구조 연산끼리 겹쳐 한쪽 미확정이 버려진다 — 남의 메모를
// 잘못 고치지 않는다. 실제 WASM·엔진·프로세스 안 서버(harness).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWasm, blankBytes, Client, Server } from './support/harness.mjs';

await loadWasm();

const memos = (c) => JSON.parse(c.doc.getMemoList());
function room() {
  const base = blankBytes();
  const server = new Server(base);
  const a = new Client('A', base, server);
  const b = new Client('B', base, server);
  a.doc.insertText(0, 0, 0, '메모를 달 본문 글자입니다');
  server.drain([a, b]);
  return { server, a, b, all: [a, b] };
}
const converged = (r) => {
  r.server.drain(r.all);
  const [da, db] = r.all.map((c) => c.digest());
  assert.equal(da, db, '수렴');
  assert.deepEqual(r.all.map((c) => c.errors), [[], []]);
};

test('메모 넣기·답글은 op 로 기록되고(ctx.memoTime) 받는 쪽이 같은 시각으로 재생해 같은 문서가 된다', () => {
  const r = room();
  r.a.doc.insertMemo(0, 0, 0, 2, JSON.stringify({ author: '갑', text: '첫 메모' }));
  const entry = r.a.engine.lastLocal;
  assert.equal(entry.kind, 'op');
  assert.equal(entry.m, 'insertMemo');
  assert.match(entry.ctx?.memoTime ?? '', /^\d+$/, '기록 쪽이 정한 시각(FILETIME 틱, 10진 문자열)');
  r.a.doc.insertMemoReply(memos(r.a)[0].id, JSON.stringify({ author: '갑', text: '답글' }));
  assert.equal(r.a.engine.lastLocal.kind, 'op');
  converged(r);
  assert.deepEqual(memos(r.b).map((m) => [m.author, m.text, m.date]), memos(r.a).map((m) => [m.author, m.text, m.date]), '작성 시각까지 같다');
  // 고치기·모양·지우기도 op
  const id = memos(r.a)[0].id;
  r.a.doc.setMemoText(id, '고친 메모');
  assert.equal(r.a.engine.lastLocal.kind, 'op');
  const shape = JSON.parse(r.a.doc.getMemoShape(0));
  r.a.doc.setMemoShape(0, JSON.stringify({ ...shape, lineColor: '#ff0000' }));
  r.a.doc.removeMemo(id);
  assert.equal(r.a.engine.lastLocal.kind, 'op');
  converged(r);
  assert.deepEqual(memos(r.b), memos(r.a));
});

test('동시에 둘이 메모를 넣으면(같은 새 id) 한쪽 미확정이 버려지고, 그 뒤의 id 기반 편집도 함께 버려져 남의 메모를 고치지 않는다', () => {
  const r = room();
  r.a.doc.insertMemo(0, 0, 0, 2, JSON.stringify({ author: '갑', text: 'A 의 메모' }));
  r.b.doc.insertMemo(0, 0, 3, 5, JSON.stringify({ author: '을', text: 'B 의 메모' }));
  const bId = memos(r.b)[0].id;
  assert.equal(bId, memos(r.a)[0].id, '같은 새 id(최대 field_id + 1)');
  r.b.doc.setMemoText(bId, 'B 가 자기 메모를 고침');
  converged(r);
  assert.ok(r.b.dropped >= 2, `B 의 메모 넣기와 고치기가 버려짐(${r.b.dropped})`);
  const final = memos(r.a);
  assert.deepEqual(final.map((m) => [m.author, m.text]), [['갑', 'A 의 메모']], 'A 의 메모는 그대로');
});
