// 4단계 U1: 공동편집 되돌리기(docs/collab-stage4.md) — CollabUndo 의 위치 옮기기·막힘·버려진 편집.
// 실제 WASM·엔진·프로세스 안 서버(harness)를 쓰고, studio 히스토리는 같은 훅 호출을 하는 작은 히스토리로,
// 명령은 studio 명령과 같은 필드 모양의 객체로 흉내 낸다. 위치 표는 studio 의 collab-undo.ts 를 그대로 쓴다.
// 합격 기준: 막히지 않은 되돌리기 = 내 편집만 빠진 문서(남의 편집은 그대로), 막히면 문서 그대로, 모두 수렴.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWasm, blankBytes, Client, Server, paragraphs } from './support/harness.mjs';
import { CollabUndo, UNDO_BLOCKED_NOTICE, REDO_BLOCKED_NOTICE } from '../src/undo.ts';
import { describeCollabUndo } from '../../upstream/rhwp/rhwp-studio/src/engine/collab-undo.ts';

await loadWasm();

// ── 흉내 명령 (studio command.ts 와 같은 필드 이름) ───────────────────

const pos = (para, off, sec = 0) => ({ sectionIndex: sec, paragraphIndex: para, charOffset: off });
const insertText = (para, off, text) => ({
  type: 'insertText', position: pos(para, off), text, fragmentIds: [],
  execute(doc) { doc.insertText(this.position.sectionIndex, this.position.paragraphIndex, this.position.charOffset, this.text); },
  undo(doc) { doc.deleteText(this.position.sectionIndex, this.position.paragraphIndex, this.position.charOffset, [...this.text].length); },
});
const splitParagraph = (para, off) => ({
  type: 'splitParagraph', position: pos(para, off),
  execute(doc) { doc.splitParagraph(this.position.sectionIndex, this.position.paragraphIndex, this.position.charOffset); },
  undo(doc) { doc.mergeParagraph(this.position.sectionIndex, this.position.paragraphIndex + 1); },
});
/** 표에 없는 종류(스냅샷 명령처럼 3.2-3) — 문서를 바꾸는 것은 글자 입력으로 흉내 */
const opaque = (para, off, text) => ({ ...insertText(para, off, text), type: 'snapshot:fake' });

/** 작은 히스토리: CommandHistory 의 훅 호출과 같은 순서(실행 → 기록 → recorded, 막힘 → 버림 → rejected) */
class MiniHistory {
  constructor(doc) { this.doc = doc; this.undoStack = []; this.redoStack = []; this.hook = null; }
  execute(cmd) {
    cmd.execute(this.doc);
    this.undoStack.push(cmd);
    this.redoStack = [];
    this.hook?.recorded(cmd, null);
  }
  undo() {
    const cmd = this.undoStack.at(-1);
    if (!cmd) return 'empty';
    const why = this.hook?.blocked(cmd, 'undo') ?? null;
    if (why !== null) { this.undoStack.pop(); this.hook.rejected(cmd, 'undo', why); return why; }
    cmd.undo(this.doc);
    this.undoStack.pop();
    this.redoStack.push(cmd);
    this.hook?.undone(cmd);
    return 'ok';
  }
  redo() {
    const cmd = this.redoStack.at(-1);
    if (!cmd) return 'empty';
    const why = this.hook?.blocked(cmd, 'redo') ?? null;
    if (why !== null) { this.redoStack.pop(); this.hook.rejected(cmd, 'redo', why); return why; }
    cmd.execute(this.doc);
    this.redoStack.pop();
    this.undoStack.push(cmd);
    this.hook?.redone(cmd);
    return 'ok';
  }
  controller() {
    return {
      stacks: () => ({ undo: [...this.undoStack], redo: [...this.redoStack] }),
      remove: (set) => { this.undoStack = this.undoStack.filter((c) => !set.has(c)); this.redoStack = this.redoStack.filter((c) => !set.has(c)); },
      clear: () => { this.undoStack = []; this.redoStack = []; },
      describe: (cmd) => describeCollabUndo(cmd),
    };
  }
}

/** 되돌리기를 켠 참여자: 원격 수신마다 CollabUndo 가 스택을 옮긴다(플러그인 applyRemote 와 같다). */
function joinWithUndo(id, server, base) {
  const c = new Client(id, base, server);
  c.notices = [];
  c.history = new MiniHistory(c.doc);
  c.undo = new CollabUndo(c.engine, (t) => c.notices.push(t));
  c.undo.attach(c.history.controller());
  c.history.hook = c.undo.hook;
  const receive = c.engine.receiveRemote.bind(c.engine);
  c.engine.receiveRemote = (entries, caret) => {
    const res = receive(entries, caret);
    if (res.ok) c.undo.onRemote(res);
    return res;
  };
  return c;
}

/** 빈 문서에 문단 n 개(문단 i 의 글자는 `p{i}`) — A 가 만들고 모두 받은 뒤 시작한다(스택은 비움). */
function room(n = 4) {
  const base = blankBytes();
  const server = new Server(base);
  const a = joinWithUndo('A', server, base);
  const b = joinWithUndo('B', server, base);
  for (let i = 0; i < n; i += 1) {
    if (i > 0) a.doc.splitParagraph(0, i - 1, a.doc.getParagraphLength(0, i - 1));
    a.doc.insertText(0, i, 0, `p${i}`);
  }
  server.drain([a, b]);
  a.history.hook.settled();
  a.history.controller().clear();
  b.history.controller().clear();
  return { server, a, b, all: [a, b] };
}

const converged = (r) => {
  r.server.drain(r.all);
  const ds = r.all.map((c) => c.digest());
  assert.ok(ds.every((d) => d === ds[0]), '수렴');
  assert.deepEqual(r.all.map((c) => c.errors), r.all.map(() => []));
};

test('① 내 글자만 사라진다: A 문단 0 입력, B 문단 2 입력, A 되돌리기', () => {
  const r = room();
  r.a.history.execute(insertText(0, 2, 'AAA'));
  r.server.drain(r.all);
  r.b.history.execute(insertText(2, 2, 'BBB'));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  converged(r);
  assert.deepEqual(paragraphs(r.a.doc), ['p0', 'p1', 'p2BBB', 'p3']);
});

test('② 같은 문단을 남이 고쳤으면 막힘·알림·문서 그대로', () => {
  const r = room();
  r.a.history.execute(insertText(1, 2, 'AAA'));
  r.server.drain(r.all);
  r.b.history.execute(insertText(1, 0, 'B'));
  r.server.drain(r.all);
  const before = paragraphs(r.a.doc);
  assert.equal(r.a.history.undo(), UNDO_BLOCKED_NOTICE);
  assert.deepEqual(r.a.notices, [UNDO_BLOCKED_NOTICE]);
  assert.deepEqual(paragraphs(r.a.doc), before);
  assert.equal(r.a.history.undoStack.length, 0, '막힌 단계는 버림');
  converged(r);
});

test('③ 앞 문단에서 남이 Enter → 문단 번호만 옮겨 내 글자를 지운다(3.1)', () => {
  const r = room();
  r.a.history.execute(insertText(3, 2, 'AAA'));
  r.server.drain(r.all);
  r.b.history.execute(splitParagraph(0, 1));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  converged(r);
  assert.deepEqual(paragraphs(r.a.doc), ['p', '0', 'p1', 'p2', 'p3']);
});

test('④ A Enter, B 다른 문단 편집 → A 되돌리기로 합쳐짐', () => {
  const r = room();
  r.a.history.execute(splitParagraph(1, 1));
  r.server.drain(r.all);
  r.b.history.execute(insertText(4, 0, 'B'));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  converged(r);
  assert.deepEqual(paragraphs(r.a.doc), ['p0', 'p1', 'p2', 'Bp3']);
});

test('⑤ 표에 없는 명령(스냅샷형)은 뒤에 남의 편집이 하나라도 있으면 막힘, 없으면 되돌려짐', () => {
  const r = room();
  r.a.history.execute(opaque(0, 0, 'X'));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  r.a.history.execute(opaque(0, 0, 'Y'));
  r.server.drain(r.all);
  r.b.history.execute(insertText(3, 0, 'B'));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), UNDO_BLOCKED_NOTICE);
  converged(r);
});

test('⑥ 내 편집이 충돌로 버려지면 그 명령이 스택에서 빠진다(3.3)', () => {
  const r = room();
  // 확실한 충돌: 같은 문단에 둘이 표를 넣음(구조 발자국이 겹침). B 가 먼저 확정 → A 의 표 만들기는 버려짐
  r.a.history.execute({ type: 'fakeTable', execute(doc) { doc.createTable(0, 1, 0, 1, 1); }, undo() {} });
  r.a.history.execute(insertText(1, 0, 'A')); // 같은 문단의 뒤 입력 — 발자국이 겹쳐 함께 빠져야 한다
  r.b.doc.createTable(0, 1, 0, 1, 1);
  r.b.flush();
  r.server.deliverOne(r.b);
  while (r.server.deliverOne(r.a)) { /* B 의 표를 받음 → A 의 미확정 충돌 */ }
  assert.ok(r.a.dropped > 0, '충돌로 버려짐');
  assert.equal(r.a.history.undoStack.length, 0, '버려진 편집의 명령은 스택에서 빠짐');
  converged(r);
});

test('⑦ redo: B 가 같은 문단을 고친 뒤 다시 하기는 막힘, 아니면 다시 됨', () => {
  const r = room();
  r.a.history.execute(insertText(2, 2, 'AAA'));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  r.server.drain(r.all);
  assert.equal(r.a.history.redo(), 'ok');
  r.server.drain(r.all);
  assert.deepEqual(paragraphs(r.b.doc)[2], 'p2AAA');
  assert.equal(r.a.history.undo(), 'ok');
  r.server.drain(r.all);
  r.b.history.execute(insertText(2, 0, 'B'));
  r.server.drain(r.all);
  assert.equal(r.a.history.redo(), REDO_BLOCKED_NOTICE);
  converged(r);
});

test('내 편집끼리도 위치를 옮긴다: A 문단 3 입력 → A 문단 0 Enter → B 문단 5 입력 → A 두 번 되돌리기', () => {
  const r = room();
  r.a.history.execute(insertText(3, 2, 'AAA'));
  r.a.history.execute(splitParagraph(0, 1));
  r.server.drain(r.all);
  r.b.history.execute(insertText(4, 0, 'B')); // 지금 문서의 문단 4 = 원래 p3 + AAA
  r.server.drain(r.all);
  // Enter 되돌리기는 허용(발자국 0·1 은 아무도 안 건드림), 입력 되돌리기는 B 가 같은 문단을 고쳐 막힘
  assert.equal(r.a.history.undo(), 'ok');
  assert.equal(r.a.history.undo(), UNDO_BLOCKED_NOTICE);
  converged(r);
  assert.deepEqual(paragraphs(r.a.doc), ['p0', 'p1', 'p2', 'Bp3AAA']);
});

test('미확정 중 되돌리기와 원격 수신: 보내기 전에 남의 앞 문단 Enter 가 와도 맞는 자리를 지운다', () => {
  const r = room();
  r.a.history.execute(insertText(2, 2, 'AAA')); // 아직 보내지 않음(미확정)
  r.b.history.execute(splitParagraph(0, 1));
  r.b.flush();
  r.server.deliverOne(r.b);
  while (r.server.deliverOne(r.a)) { /* 미확정이 있는 상태로 B 의 Enter 를 받음(되감기·보정) */ }
  assert.equal(r.a.history.undo(), 'ok');
  converged(r);
  assert.deepEqual(paragraphs(r.a.doc), ['p', '0', 'p1', 'p2', 'p3']);
});
