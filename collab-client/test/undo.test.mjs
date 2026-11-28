// 4단계 U1: 공동편집 되돌리기(docs/collab-stage4.md) — CollabUndo 의 위치 옮기기·막힘·버려진 편집.
// 실제 WASM·엔진·프로세스 안 서버(harness)를 쓰고, studio 히스토리는 같은 훅 호출을 하는 작은 히스토리로,
// 명령은 studio 명령과 같은 필드 모양의 객체로 흉내 낸다. 위치 표는 studio 의 collab-undo.ts 를 그대로 쓴다.
// 합격 기준: 막히지 않은 되돌리기 = 내 편집만 빠진 문서(남의 편집은 그대로), 막히면 문서 그대로, 모두 수렴.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWasm, blankBytes, Client, Server, paragraphs } from './support/harness.mjs';
import { bytesToBase64 } from '../src/engine/codec.ts';
import { CollabUndo, UNDO_BLOCKED_NOTICE, REDO_BLOCKED_NOTICE, UNDO_DOCINFO_NOTICE, UNDO_DROPPED_NOTICE } from '../src/undo.ts';
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

/**
 * 작은 히스토리: CommandHistory 의 훅 호출과 같은 순서(실행 → 기록 → recorded, 막힘 → 버림 → rejected). undo/redo 때 명령에
 * 넘기는 문서는 studio 의 다리와 같다(U3·U3-b: `restoreSnapshot`·`restoreDeleteFragment` 만 훅에 먼저 묻는다).
 */
class MiniHistory {
  constructor(doc) { this.doc = doc; this.undoStack = []; this.redoStack = []; this.hook = null; }
  bridge(cmd, dir) {
    const hook = this.hook;
    if (!hook?.restoreSnapshot) return this.doc;
    const doc = this.doc;
    return new Proxy(doc, {
      get(target, key) {
        if (key === 'restoreSnapshot') return (id) => { if (!hook.restoreSnapshot(cmd, dir, id)) target.restoreSnapshot(id); };
        if (key === 'restoreDeleteFragment') return (id) => (hook.restoreDeleteFragment(cmd, dir, id) ? '{"ok":true}' : target.restoreDeleteFragment(id));
        const v = Reflect.get(target, key, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }
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
    cmd.undo(this.bridge(cmd, 'undo'));
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
    cmd.execute(this.bridge(cmd, 'redo'));
    this.redoStack.pop();
    this.undoStack.push(cmd);
    this.hook?.redone(cmd);
    return 'ok';
  }
  /** studio 의 병합(300ms 연속 입력): 실행 → 앞 명령과 합친 명령으로 맨 위를 바꾸고 recorded(merged, last) */
  executeMerged(cmd, merge) {
    cmd.execute(this.doc);
    const last = this.undoStack.pop();
    const merged = merge(last, cmd);
    this.undoStack.push(merged);
    this.redoStack = [];
    this.hook?.recorded(merged, last);
  }
  controller() {
    return {
      stacks: () => ({ undo: [...this.undoStack], redo: [...this.redoStack] }),
      remove: (set) => {
        for (const c of set) c.discard?.(this.doc);
        this.undoStack = this.undoStack.filter((c) => !set.has(c));
        this.redoStack = this.redoStack.filter((c) => !set.has(c));
      },
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
function room(n = 4, serverOptions = {}) {
  const base = blankBytes();
  const server = new Server(base, serverOptions);
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

// ── 버려진 편집의 정밀 지도 (설계 세션 결정: rebase 되돌림 열을 지도 앞에) ─────────────────

test('버려진 표 넣기(문단 수 +) 뒤: 같은 문단 명령만 함께 빠지고, 뒤 문단의 오래된 명령은 정확한 문단을 되돌린다', () => {
  const r = room(6);
  const c0 = insertText(1, 2, 'SAME');
  const c1 = insertText(5, 2, 'OLD');
  r.a.history.execute(c0);
  r.a.history.execute(c1);
  r.server.drain(r.all);
  // A 가 문단 1 에 표를 넣는다(미확정, 아직 보내지 않음) — 구조 발자국, 그 뒤 문단 번호가 밀림
  const table = { type: 'snapshot:createTable', execute(doc) { doc.createTable(0, 1, 0, 1, 1); }, undo() {} };
  r.a.history.execute(table);
  assert.ok(c1.position.paragraphIndex > 5, '표 넣기로 오래된 명령의 문단 번호가 밀렸다');
  // 그사이 B 가 같은 문단에 입력하고 먼저 확정 → A 의 표 넣기는 발자국 충돌로 버려진다(남의 편집은 글자라 3.2-2 아님)
  r.b.doc.insertText(0, 1, 0, 'B');
  r.b.flush();
  r.server.deliverOne(r.b);
  while (r.server.deliverOne(r.a)) { /* 받기 */ }
  assert.ok(r.a.dropped > 0, '표 넣기가 버려짐');
  assert.deepEqual(r.a.history.undoStack, [c1], '버려진 명령과 같은 문단 명령(c0)만 빠지고 c1 은 남는다');
  assert.equal(c1.position.paragraphIndex, 5, '되돌림 열로 원래 문단 번호로 돌아왔다');
  assert.equal(r.a.history.undo(), 'ok');
  converged(r);
  const texts = paragraphs(r.a.doc);
  assert.equal(texts[5], 'p5', '정확한 문단에서 내 글자가 사라짐');
  assert.equal(texts[1], 'Bp1SAME', '같은 문단의 c0 글자는 문서에 남는다(스택에서만 빠짐)');
});

test('버려진 합침(문단 수 −) 뒤: 뒤 문단의 오래된 명령 위치가 원래 번호 + 남의 편집으로 옮겨진다', () => {
  const r = room(7);
  const c1 = insertText(5, 2, 'OLD');
  r.a.history.execute(c1);
  r.server.drain(r.all);
  // A 가 문단 3 처음에서 Backspace(합침) — 미확정
  const merge = { type: 'mergeParagraph', position: pos(3, 0), execute(doc) { doc.mergeParagraph(0, 3); }, undo() {} };
  r.a.history.execute(merge);
  assert.equal(c1.position.paragraphIndex, 4, '합침으로 당겨짐');
  // B 가 합침이 닿는 문단 2 에 표를 넣고 먼저 확정 → A 의 합침은 버려진다
  const before = r.b.doc.getParagraphCount(0);
  r.b.doc.createTable(0, 2, 0, 1, 1);
  const pd = r.b.doc.getParagraphCount(0) - before;
  r.b.flush();
  r.server.deliverOne(r.b);
  while (r.server.deliverOne(r.a)) { /* 받기 */ }
  assert.ok(r.a.dropped > 0, '합침이 버려짐');
  assert.ok(r.a.history.undoStack.includes(c1), '다른 문단의 오래된 명령은 남는다');
  assert.equal(c1.position.paragraphIndex, 5 + pd, `되돌림 열(합침 취소) + 남의 표(문단 ${pd}) — 지금 문서의 그 문단`);
  assert.equal(paragraphs(r.a.doc)[5 + pd], 'p5OLD');
  converged(r);
});

// ── 4단계 U2: 중첩 셀·머리말·각주·개체·구역 ─────────────────────────────

const steps = (list) => list.map(([c, l, p]) => ({ controlIndex: c, cellIndex: l, cellParaIndex: p }));
/** 셀 안 위치(DocumentPosition 모양, 중첩이면 cellPath 깊이 2 이상) */
const cellPos = (pp, list, off) => {
  const path = steps(list);
  return { sectionIndex: 0, paragraphIndex: path.at(-1).cellParaIndex, charOffset: off, parentParaIndex: pp, controlIndex: path[0].controlIndex, cellIndex: path[0].cellIndex, cellParaIndex: path.at(-1).cellParaIndex, cellPath: path };
};
const insertInCell = (position, text) => ({
  type: 'insertText', position, text, fragmentIds: [],
  execute(doc) { const p = this.position; doc.insertTextInCellByPath(0, p.parentParaIndex, JSON.stringify(p.cellPath), p.charOffset, this.text); },
  undo(doc) { const p = this.position; doc.deleteTextInCellByPath(0, p.parentParaIndex, JSON.stringify(p.cellPath), p.charOffset, [...this.text].length); },
});
const cellText = (doc, pp, list) => doc.getTextInCellByPath(0, pp, JSON.stringify(steps(list)), 0, 100);

/** 문단 0 "p0", 문단 1 에 표(1×2), 그 칸 0 의 문단 0 "x"·문단 1 에 안쪽 표(1×2). 모두 받은 뒤 시작한다. */
function nestedRoom() {
  const r = room(1);
  const d = r.a.doc;
  d.createTable(0, 0, 2, 1, 2);
  d.insertTextInCell(0, 1, 0, 0, 0, 0, 'x');
  d.splitParagraphInCell(0, 1, 0, 0, 0, 1);
  d.createTableInCellByPath(0, 1, JSON.stringify(steps([[0, 0, 1]])), 0, JSON.stringify({ rows: 1, cols: 2 }));
  d.insertTextInCellByPath(0, 1, JSON.stringify(steps([[0, 0, 1], [0, 1, 0]])), 0, 'q');
  r.server.drain(r.all);
  r.a.history.hook.settled();
  r.a.history.controller().clear();
  r.b.history.controller().clear();
  return r;
}

test('U2 중첩 셀: 바깥 칸의 앞 문단에서 남이 Enter → 바깥 단계 칸 문단만 옮겨 내 글자를 지운다', () => {
  const r = nestedRoom();
  r.a.history.execute(insertInCell(cellPos(1, [[0, 0, 1], [0, 0, 0]], 0), 'AAA'));
  r.server.drain(r.all);
  // B: 바깥 칸 0 의 문단 0("x") 끝에서 Enter → 안쪽 표를 품은 문단이 1 → 2
  r.b.doc.splitParagraphInCell(0, 1, 0, 0, 0, 1);
  r.server.drain(r.all);
  assert.equal(cellText(r.a.doc, 1, [[0, 0, 2], [0, 0, 0]]), 'AAA', '옮겨진 자리에 내 글자');
  assert.equal(r.a.history.undo(), 'ok');
  converged(r);
  assert.equal(cellText(r.a.doc, 1, [[0, 0, 2], [0, 0, 0]]), '');
  assert.equal(cellText(r.a.doc, 1, [[0, 0, 2], [0, 1, 0]]), 'q', '남의 칸 글자는 그대로');
  assert.deepEqual(r.a.history.undoStack, []);
});

test('U2 중첩 셀: 같은 안쪽 칸 문단을 남이 고치면 막힘, 다른 안쪽 칸이면 되돌려짐', () => {
  const r = nestedRoom();
  r.a.history.execute(insertInCell(cellPos(1, [[0, 0, 1], [0, 0, 0]], 0), 'A'));
  r.server.drain(r.all);
  r.b.doc.insertTextInCellByPath(0, 1, JSON.stringify(steps([[0, 0, 1], [0, 0, 0]])), 1, 'B');
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), UNDO_BLOCKED_NOTICE);
  converged(r);
  const s = nestedRoom();
  s.a.history.execute(insertInCell(cellPos(1, [[0, 0, 1], [0, 0, 0]], 0), 'A'));
  s.server.drain(s.all);
  s.b.doc.insertTextInCellByPath(0, 1, JSON.stringify(steps([[0, 0, 1], [0, 1, 0]])), 0, 'B');
  s.server.drain(s.all);
  assert.equal(s.a.history.undo(), 'ok');
  converged(s);
  assert.deepEqual([cellText(s.a.doc, 1, [[0, 0, 1], [0, 0, 0]]), cellText(s.a.doc, 1, [[0, 0, 1], [0, 1, 0]])], ['', 'Bq']);
});

/** 머리말 글자 입력(studio InsertTextInHeaderFooterCommand 모양) */
const hfInsert = (paraIdx, charOffset, text) => ({
  type: 'insertTextInHeaderFooter', target: { sectionIdx: 0, isHeader: true, applyTo: 0, previewPage: 0 }, paraIdx, charOffset, text,
  execute(doc) { doc.insertTextInHeaderFooter(0, true, 0, this.paraIdx, this.charOffset, this.text); },
  undo(doc) { doc.deleteTextInHeaderFooter(0, true, 0, this.paraIdx, this.charOffset, [...this.text].length); },
});
const headerText = (doc) => JSON.parse(doc.getHeaderFooter(0, true, 0)).text;

test('U2 머리말: 남의 본문 편집(Enter 포함)은 막지 않고, 남의 머리말 편집은 막는다', () => {
  const r = room();
  r.a.doc.createHeaderFooter(0, true, 0);
  r.server.drain(r.all);
  r.a.history.hook.settled();
  r.a.history.execute(hfInsert(0, 0, 'AH'));
  r.server.drain(r.all);
  r.b.history.execute(splitParagraph(0, 1));
  r.b.history.execute(insertText(3, 0, 'B'));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  converged(r);
  assert.equal(headerText(r.a.doc), '');
  assert.deepEqual(paragraphs(r.a.doc), ['p', '0', 'p1', 'Bp2', 'p3']);
  // 남이 머리말을 고친 뒤 → 막힘
  r.a.history.execute(hfInsert(0, 0, 'A'));
  r.server.drain(r.all);
  r.b.doc.insertTextInHeaderFooter(0, true, 0, 0, 1, 'b');
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), UNDO_BLOCKED_NOTICE);
  converged(r);
  assert.equal(headerText(r.a.doc), 'Ab');
});

/** 각주 글자 입력(studio InsertTextInFootnoteCommand 모양) — 대상은 각주를 품은 본문 문단 */
const fnInsert = (target, innerParaIdx, charOffset, text) => ({
  type: 'insertTextInFootnote', target, innerParaIdx, charOffset, text,
  execute(doc) { doc.insertTextInFootnote(0, this.target.paraIdx, this.target.controlIdx, this.innerParaIdx, this.charOffset, this.text); },
  undo(doc) { doc.deleteTextInFootnote(0, this.target.paraIdx, this.target.controlIdx, this.innerParaIdx, this.charOffset, [...this.text].length); },
});

test('U2 각주: 앞 문단에서 남이 Enter → 각주를 품은 문단을 옮겨 되돌린다, 같은 문단을 고치면 막힘', () => {
  const r = room();
  const fn = JSON.parse(r.a.doc.insertFootnote(0, 2, 2));
  r.server.drain(r.all);
  r.a.history.hook.settled();
  const target = { sectionIdx: 0, paraIdx: fn.paraIdx, controlIdx: fn.controlIdx, footnoteIndex: 0, pageNum: 0 };
  const fnText = (doc) => JSON.parse(doc.getFootnoteInfo(0, 3, fn.controlIdx)).texts.join('');
  r.a.history.execute(fnInsert(target, 0, 0, 'AF'));
  r.server.drain(r.all);
  r.b.history.execute(splitParagraph(0, 1));
  r.server.drain(r.all);
  assert.equal(target.paraIdx, 3, '각주 문단이 옮겨짐');
  assert.match(fnText(r.b.doc), /^AF/);
  assert.equal(r.a.history.undo(), 'ok');
  converged(r);
  for (const c of r.all) assert.doesNotMatch(fnText(c.doc), /AF/, `${c.id}: 내 각주 글자만 빠짐`);
  assert.deepEqual(paragraphs(r.a.doc).slice(0, 2), ['p', '0'], 'B 의 Enter 는 남음');
  // 같은 문단을 남이 고치면 막힘
  r.a.history.execute(fnInsert(target, 0, 0, 'Z'));
  r.server.drain(r.all);
  r.b.history.execute(insertText(3, 0, 'B'));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), UNDO_BLOCKED_NOTICE);
  converged(r);
});

/** 표 이동(studio MoveTableCommand 모양) */
const moveTable = (ppi, ci, dH, dV) => ({
  type: 'moveTable', sec: 0, ppi, ci, deltaH: dH, deltaV: dV, resultPpi: ppi, resultCi: ci,
  execute(doc) { const r = JSON.parse(doc.moveTableOffset(0, this.ppi, this.ci, this.deltaH, this.deltaV)); this.resultPpi = r.ppi; this.resultCi = r.ci; },
  undo(doc) { const r = JSON.parse(doc.moveTableOffset(0, this.resultPpi, this.resultCi, -this.deltaH, -this.deltaV)); this.ppi = r.ppi; this.ci = r.ci; },
});

const tableOffset = (doc, ppi) => {
  const t = JSON.parse(doc.getTableProperties(0, ppi, 0));
  return [t.horzOffset, t.vertOffset];
};

test('U2 개체: 표 이동 뒤 남이 앞 문단에서 Enter → 옮겨진 표를 되돌린다(내 이동만 빠짐)', () => {
  const r = room(2);
  r.a.doc.createTable(0, 1, 2, 1, 1);
  r.server.drain(r.all);
  r.a.history.hook.settled();
  const count = r.a.doc.getParagraphCount(0);
  r.a.history.execute(moveTable(2, 0, 300, 400));
  r.server.drain(r.all);
  assert.deepEqual(tableOffset(r.b.doc, 2), [300, 400]);
  r.b.history.execute(splitParagraph(0, 1));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  converged(r);
  // 표는 문단 3 으로 옮겨졌고 오프셋은 원래대로, B 의 Enter 는 남음
  for (const c of r.all) assert.deepEqual(tableOffset(c.doc, 3), [0, 0], `${c.id}: 내 이동만 빠짐`);
  assert.equal(r.a.doc.getParagraphCount(0), count + 1);
  // 표를 품은 문단을 남이 고치면 막힘
  r.a.history.execute(moveTable(3, 0, 100, 0));
  r.server.drain(r.all);
  r.b.history.execute(insertText(3, 0, 'B'));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), UNDO_BLOCKED_NOTICE);
  converged(r);
});

/** 구역 설정(studio SetSectionPropsCommand 모양 — 구역 원본 저널) */
const sectionProps = (doc, change) => {
  const before = JSON.parse(doc.getSectionDef(0));
  return {
    type: 'setSectionProps', sectionIdx: 0, before, after: { ...before, ...change }, cursorPos: pos(0, 0), captureId: null,
    execute(d) { this.captureId = d.captureSectionRaw(0); d.setSectionDef(0, JSON.stringify(this.after)); },
    undo(d) { d.setSectionDef(0, JSON.stringify(this.before)); d.restoreSectionRaw(this.captureId); this.captureId = null; },
  };
};

test('U2 구역 설정: 같은 구역에 남의 기록이 하나라도 오면 막힘(저널 계약), 없으면 되돌려짐', () => {
  // 저널 복원(restoreSectionRaw)은 구역 원본 바이트를 되살린다 — 사이에 남의 편집이 끼면 저장 때 그 편집이 사라진다
  const r = room();
  const before = r.a.doc.getSectionDef(0);
  r.a.history.execute(sectionProps(r.a.doc, { columnSpacing: 2000 }));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  converged(r);
  for (const c of r.all) assert.equal(c.doc.getSectionDef(0), before, `${c.id}: 구역 정의가 원래대로`);
  // 다른 문단의 글자 입력이어도 같은 구역이면 막는다
  r.a.history.execute(sectionProps(r.a.doc, { columnSpacing: 3000 }));
  r.server.drain(r.all);
  r.b.history.execute(insertText(3, 0, 'B'));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), UNDO_BLOCKED_NOTICE);
  converged(r);
  assert.equal(JSON.parse(r.a.doc.getSectionDef(0)).columnSpacing, 3000);
});


// ── 4단계 U3: snapshot 경로의 문단 범위 복원 (stage4 §6) ─────────────────────────

/**
 * studio SnapshotCommand 와 같은 모양·순서: 최초 실행은 before 스냅샷 → 작업, 되돌리기는 after 스냅샷(되돌리기 직전) →
 * before 로 복원, 다시 하기는 after 로 복원 → after 해제. 복원은 히스토리 다리의 `restoreSnapshot` 을 거친다.
 */
const snapshotCmd = (op, operation) => ({
  type: `snapshot:${op}`, beforeId: null, afterId: null, executed: false, cursorBefore: pos(0, 0), cursorAfter: pos(0, 0),
  execute(doc) {
    if (this.executed) {
      doc.restoreSnapshot(this.afterId);
      doc.discardSnapshot(this.afterId);
      this.afterId = null;
      return;
    }
    this.executed = true;
    this.beforeId = doc.saveSnapshot();
    operation(doc);
  },
  undo(doc) {
    if (this.afterId === null) this.afterId = doc.saveSnapshot();
    doc.restoreSnapshot(this.beforeId);
  },
  discard(doc) {
    for (const k of ['beforeId', 'afterId']) if (this[k] !== null) { doc.discardSnapshot(this[k]); this[k] = null; }
  },
});
/** 문단 끝에 2×2 표(studio 표 만들기와 같은 export) */
const makeTable = (para) => snapshotCmd('createTable', (doc) => doc.createTable(0, para, doc.getParagraphLength(0, para), 2, 2));
/** 표를 품은 본문 문단들 */
const tableParas = (doc) => {
  const out = [];
  for (let p = 0; p < doc.getParagraphCount(0); p += 1) {
    try { doc.getTableProperties(0, p, 0); out.push(p); } catch { /* 표 없음 */ }
  }
  return out;
};
/** 범위 표시를 확인하는 정본(S1 다시 쓰기 포함)이 있는 방 */
const rangeRoom = (n = 5) => room(n, { canonical: true, rewriteState: true });
const lastEntry = (r) => r.server.log.at(-1).entries.at(-1);
/** 텍스트 문단만(표 문단의 빈 글자는 뺀다) */
const words = (doc) => paragraphs(doc).filter((t) => t !== '');

test('U3 ① 표 만들기 뒤 B 가 같은 구역 다른 문단에 입력 → A 되돌리기 허용, A 의 표만 사라지고 B 의 글자는 남는다', () => {
  const r = rangeRoom();
  r.a.history.execute(makeTable(1));
  r.server.drain(r.all);
  assert.equal(tableParas(r.b.doc).length, 1);
  const n = r.a.doc.getParagraphCount(0);
  r.b.history.execute(insertText(n - 1, 0, 'B'));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  converged(r);
  assert.deepEqual(paragraphs(r.a.doc), ['p0', 'p1', 'p2', 'p3', 'Bp4']);
  assert.deepEqual(tableParas(r.a.doc), []);
  const st = lastEntry(r);
  assert.equal(st.kind, 'state');
  assert.deepEqual(st.range, { section: 0, lo: 1, before: n - 4, after: 1 }, '복원 state 에 범위 표시(서버를 거쳐도 남음)');
  assert.equal(r.server.rangeChecks, 1);
  assert.equal(r.server.rangeRejects, 0);
  assert.equal(r.a.engine.recipeCount(), 0, '확정되면 복원 재료를 푼다');
  assert.deepEqual([r.a.dropped, r.b.dropped], [0, 0]);
});

test('U3 ② B 가 A 의 범위(표를 넣은 문단)를 고쳤으면 막힘·알림·문서 그대로', () => {
  const r = rangeRoom();
  r.a.history.execute(makeTable(1));
  r.server.drain(r.all);
  r.b.history.execute(insertText(1, 0, 'B'));
  r.server.drain(r.all);
  const before = paragraphs(r.a.doc);
  assert.equal(r.a.history.undo(), UNDO_BLOCKED_NOTICE);
  assert.deepEqual(paragraphs(r.a.doc), before);
  assert.equal(r.a.history.undoStack.length, 0);
  converged(r);
});

test('U3 ③ 범위 앞에서 B 가 Enter → 지도로 옮겨 허용', () => {
  const r = rangeRoom();
  r.a.history.execute(makeTable(2));
  r.server.drain(r.all);
  r.b.history.execute(splitParagraph(0, 1));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  converged(r);
  assert.deepEqual(paragraphs(r.a.doc), ['p', '0', 'p1', 'p2', 'p3', 'p4']);
});

test('U3 ④ 같은 구역 다른 곳에 B 가 표 만들기(구조) → 막지 않고(3.2-2 를 이 경우만 풂) A 의 표만 사라짐', () => {
  const r = rangeRoom();
  r.a.history.execute(makeTable(1));
  r.server.drain(r.all);
  const n = r.a.doc.getParagraphCount(0);
  r.b.doc.createTable(0, n - 1, 2, 1, 1);
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  converged(r);
  assert.deepEqual(words(r.a.doc), ['p0', 'p1', 'p2', 'p3', 'p4']);
  const t = tableParas(r.a.doc);
  assert.equal(t.length, 1, 'B 의 표는 남는다');
  assert.ok(t[0] >= 4, 'B 의 표는 p4 자리');
});

test('U3 ⑤ redo: 되돌린 뒤 다시 하기로 표가 돌아오고(남의 편집 유지), 남이 되살린 범위를 고치면 다시 하기 막힘', () => {
  const r = rangeRoom();
  r.a.history.execute(makeTable(1));
  r.server.drain(r.all);
  const withTable = r.a.doc.getParagraphCount(0);
  r.b.history.execute(insertText(withTable - 1, 0, 'B'));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  r.server.drain(r.all);
  r.b.history.execute(splitParagraph(0, 1)); // 범위 앞 Enter
  r.server.drain(r.all);
  assert.equal(r.a.history.redo(), 'ok');
  converged(r);
  assert.equal(tableParas(r.a.doc).length, 1, '표가 돌아옴');
  assert.deepEqual(words(r.a.doc), ['p', '0', 'p1', 'p2', 'p3', 'Bp4']);
  // 다시 되돌리기(남의 기록 없음 — 언제나 범위 복원) → 표가 빠짐
  assert.equal(r.a.history.undo(), 'ok');
  r.server.drain(r.all);
  assert.equal(tableParas(r.a.doc).length, 0);
  // 되살린 범위(p1)를 남이 고치면 다시 하기 막힘
  r.b.history.execute(insertText(2, 0, 'Z'));
  r.server.drain(r.all);
  assert.equal(r.a.history.redo(), REDO_BLOCKED_NOTICE);
  converged(r);
  assert.equal(r.a.engine.recipeCount(), 0);
});

test('U3 ⑥ 범위 문단이 참조할 수 있는 DocInfo 의 기존 항목을 남이 바꾸면 따로 안내하고 막힘', () => {
  const r = rangeRoom();
  r.a.history.execute(makeTable(1));
  r.server.drain(r.all);
  r.b.doc.updateStyle(0, JSON.stringify({ name: '바뀐 바탕글' }));
  r.server.drain(r.all);
  const before = paragraphs(r.a.doc);
  assert.equal(r.a.history.undo(), UNDO_DOCINFO_NOTICE);
  assert.deepEqual(paragraphs(r.a.doc), before);
  converged(r);
});

test('U3 ⑦ 표 지우기(개체 삭제)를 되돌리면 표가 돌아오고 B 의 편집은 남는다', () => {
  const r = rangeRoom();
  r.a.doc.createTable(0, 2, 2, 1, 1);
  r.server.drain(r.all);
  r.a.history.hook.settled();
  r.a.history.controller().clear();
  const [tp] = tableParas(r.a.doc);
  const words0 = words(r.a.doc);
  r.a.history.execute(snapshotCmd('deleteTable', (doc) => doc.deleteTableControl(0, tp, 0)));
  r.server.drain(r.all);
  assert.deepEqual(tableParas(r.b.doc), []);
  r.b.history.execute(insertText(0, 0, 'B'));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  converged(r);
  assert.deepEqual(tableParas(r.a.doc), [tp], '표가 제자리로');
  assert.deepEqual(words(r.a.doc), ['Bp0', ...words0.slice(1)]);
});

test('U3 ⑧ B 가 계속 치는 중: B 의 묶음이 먼저 서버에 가도 A 의 복원 state 를 새 문서 위에서 다시 만들어 둘 다 산다', () => {
  const r = rangeRoom();
  r.a.history.execute(makeTable(1));
  r.server.drain(r.all);
  const n = r.a.doc.getParagraphCount(0);
  r.b.history.execute(insertText(n - 1, 0, 'B1'));
  r.server.drain(r.all);
  // A 되돌리기(미확정, 아직 안 보냄) — 그사이 B 가 범위 앞에 Enter 를 치고 먼저 확정
  assert.equal(r.a.history.undo(), 'ok');
  assert.equal(r.a.engine.recipeCount(), 1);
  r.b.history.execute(splitParagraph(0, 1));
  r.b.flush();
  r.server.deliverOne(r.b);
  while (r.server.deliverOne(r.a)) { /* A: 미확정 복원 state 가 있는 채로 B 의 Enter 를 받음 → 다시 만듦 */ }
  assert.equal(r.a.dropped, 0, 'A 의 되돌리기가 취소되지 않음');
  r.server.drain(r.all);
  converged(r);
  assert.deepEqual(paragraphs(r.a.doc), ['p', '0', 'p1', 'p2', 'p3', 'B1p4']);
  assert.equal(r.server.rangeRejects, 0, '다시 만든 state 의 범위 표시도 맞다');
  assert.equal(r.a.engine.recipeCount(), 0);
});

test('U3 ⑨ B 가 계속 치는 중: A 의 복원 state 가 먼저 서버에 가면 B 의 왕복 중 입력이 취소되지 않는다(범위 표시가 없으면 취소된다)', () => {
  for (const hinted of [true, false]) {
    // 정본이 없는 서버는 범위 표시를 확인할 수 없어 뗀다 → 보통 state(예전 동작) — 대조군
    const r = hinted ? rangeRoom() : room(5);
    r.a.history.execute(makeTable(1));
    r.server.drain(r.all);
    const n = r.a.doc.getParagraphCount(0);
    assert.equal(r.a.history.undo(), 'ok');
    r.a.flush();
    r.b.history.execute(insertText(n - 1, 0, 'B'));
    r.b.flush(); // 보냈지만 A 의 state 뒤라 reject 된다
    while (r.server.deliverOne(r.b)) { /* B: 미확정이 있는 채로 A 의 복원 state 를 받음 */ }
    r.server.drain(r.all);
    converged(r);
    if (hinted) {
      assert.equal(r.b.dropped, 0, 'B 의 입력이 살아남음');
      assert.deepEqual(paragraphs(r.a.doc), ['p0', 'p1', 'p2', 'p3', 'Bp4']);
    } else {
      assert.ok(r.b.dropped > 0, '범위 표시가 없으면 state 와 충돌해 B 의 입력이 취소된다');
    }
  }
});

test('U3 ⑩ 복원 재료는 확정·버림·리셋 때 풀린다', () => {
  // 버림: A 의 복원 state 가 미확정인 동안 B 가 A 의 범위를 고치고 먼저 확정 → 충돌로 버려짐 → 재료 해제, 명령도 스택에서
  const r = rangeRoom();
  r.a.history.execute(makeTable(1));
  r.server.drain(r.all);
  r.b.history.execute(insertText(r.b.doc.getParagraphCount(0) - 1, 0, 'x')); // 범위 밖(마지막 문단) — 남의 기록이 있어도 범위 복원
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  assert.equal(r.a.engine.recipeCount(), 1);
  r.b.history.execute(insertText(1, 0, 'B')); // A 가 되살린 범위(p1)
  r.b.flush();
  r.server.deliverOne(r.b);
  while (r.server.deliverOne(r.a)) { /* 받기 */ }
  assert.ok(r.a.dropped > 0);
  assert.equal(r.a.engine.recipeCount(), 0, '버리면 재료를 푼다');
  assert.ok(r.a.notices.includes(UNDO_DROPPED_NOTICE));
  assert.equal(r.a.history.redoStack.length, 0, '되돌리기가 취소된 명령은 스택에서 빠짐');
  converged(r);
  // 리셋(제자리 재동기화·문서 교체): 미확정 복원 state 의 재료를 푼다
  r.a.history.execute(makeTable(0));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  assert.equal(r.a.engine.recipeCount(), 1);
  r.a.engine.reset();
  assert.equal(r.a.engine.recipeCount(), 0, '리셋하면 재료를 푼다');
});

test('U3 ⑪ 거짓 범위 표시를 단 원시 클라이언트의 state 는 정본이 거절한다(seq 그대로)', () => {
  const r = rangeRoom();
  const x = { id: 'X', deliver(msg) { this.got.push(msg); }, got: [] };
  r.server.join(x);
  // 문단 0 을 고친 문서를 "문단 3 만 바꿨다"고 주장
  const d = r.b.doc;
  r.b.engine.setRecording(false);
  const snap = d.collabSnapshotSave();
  d.insertText(0, 0, 0, '몰래');
  const data = bytesToBase64(d.collabExportState());
  d.collabSnapshotRestore(snap);
  d.collabSnapshotDiscard(snap);
  r.b.engine.setRecording(true);
  const seq = r.server.seq;
  r.server.submit(x, seq, [{ kind: 'state', data, range: { section: 0, lo: 3, before: 1, after: 1 } }], 'X:1');
  while (r.server.deliverOne(x)) { /* 받기 */ }
  assert.equal(r.server.seq, seq, 'seq 그대로');
  assert.equal(r.server.rangeRejects, 1);
  assert.equal(x.got.at(-1).type, 'invalid');
  converged(r);
});

test('U3 ⑫ 되돌리기·다시 하기를 연달아(한 묶음이 왕복 중): 복원 state 들을 합치지 않아 범위 표시가 남고 B 의 입력이 산다', () => {
  const r = rangeRoom();
  r.a.history.execute(makeTable(1));
  r.server.drain(r.all);
  // A 가 먼저 글자 하나를 보내 왕복 중으로 만든 뒤 되돌리기·다시 하기·되돌리기 — 셋 다 보내지 않은 채 쌓인다
  const n = r.a.doc.getParagraphCount(0);
  r.a.history.execute(insertText(0, 0, 'a'));
  r.a.flush();
  assert.equal(r.a.history.undo(), 'ok'); // 'a' 입력 되돌리기(글자)
  assert.equal(r.a.history.undo(), 'ok'); // 표 되돌리기(범위)
  assert.equal(r.a.history.redo(), 'ok'); // 표 다시 하기(범위)
  assert.equal(r.a.history.undo(), 'ok'); // 다시 되돌리기(범위)
  const states = r.a.engine.unconfirmed.filter((e) => e.kind === 'state');
  assert.equal(states.length, 3, '복원 state 셋이 따로 남는다');
  assert.ok(states.every((e) => e.range && typeof e.recipe === 'number'), '모두 범위 표시와 재료');
  r.b.history.execute(insertText(n - 1, 0, 'B'));
  r.b.flush();
  r.server.drain(r.all);
  converged(r);
  assert.equal(r.b.dropped, 0);
  assert.equal(r.a.dropped, 0);
  assert.deepEqual(paragraphs(r.a.doc), ['p0', 'p1', 'p2', 'p3', 'Bp4']);
  assert.equal(r.a.engine.recipeCount(), 0);
  const sent = r.server.log.flatMap((m) => m.entries).filter((e) => e.kind === 'state');
  assert.ok(sent.length >= 3 && sent.every((e) => e.range && !('recipe' in e)), '서버에 간 복원 state 에는 범위 표시만(재료 번호 없음)');
});


// ── 4단계 U3-b: 삭제 조각의 범위 복원 ────────────────────────────────────────

/** studio FragmentDeleteCommand(본문 선택 삭제): 조각 캡처 [start..end] → deleteRange, 되돌리기는 조각 복원(소비) */
const fragmentDelete = (s, so, e, eo) => ({
  type: 'deleteSelection', sectionIdx: 0, startPara: s, endPara: e, cursorBefore: pos(s, so), cursorAfter: pos(s, so), fragmentId: null,
  execute(doc) { this.fragmentId = doc.captureDeleteRange(0, this.startPara, this.endPara); doc.deleteRange(0, this.startPara, so, this.endPara, eo); },
  undo(doc) { doc.restoreDeleteFragment(this.fragmentId); this.fragmentId = null; },
  discard(doc) { if (this.fragmentId !== null) { doc.discardDeleteFragment(this.fragmentId); this.fragmentId = null; } },
});
/** studio InsertTextCommand 수정(덮어쓰기) 모드: 캐럿 문단 조각 → 덮어쓴 글자 지우고 입력, 되돌리기는 첫 조각 복원 + 나머지 해제 */
const overwrite = (para, off, text, replaced) => ({
  type: 'insertText', position: pos(para, off), text, replacedText: replaced, fragmentIds: [],
  execute(doc) {
    const p = this.position;
    this.fragmentIds = [doc.captureDeleteRange(0, p.paragraphIndex, p.paragraphIndex)];
    doc.deleteText(0, p.paragraphIndex, p.charOffset, [...this.replacedText].length);
    doc.insertText(0, p.paragraphIndex, p.charOffset, this.text);
  },
  undo(doc) {
    const [id, ...rest] = this.fragmentIds;
    doc.restoreDeleteFragment(id);
    this.fragmentIds = rest;
    this.discard(doc);
  },
  discard(doc) { for (const id of this.fragmentIds) doc.discardDeleteFragment(id); this.fragmentIds = []; },
});
/** studio InsertTextCommand.mergeWith 의 덮어쓰기 병합: 글자 이어 붙이고 조각은 [앞 조각들, 뒤 조각들] */
const mergeOverwrite = (a, b) => ({ ...overwrite(a.position.paragraphIndex, a.position.charOffset, a.text + b.text, a.replacedText + b.replacedText), position: a.position, fragmentIds: [...a.fragmentIds, ...b.fragmentIds] });
/** studio DeleteTextCommand 의 링크·메모 앵커를 걸친 삭제: 문단 조각 → 글자 지움, 되돌리기는 조각 복원 */
const anchoredDelete = (para, off, count) => ({
  type: 'deleteText', position: pos(para, off), count, fragmentId: null,
  execute(doc) { const p = this.position; this.fragmentId = doc.captureDeleteRange(0, p.paragraphIndex, p.paragraphIndex); doc.deleteText(0, p.paragraphIndex, p.charOffset, this.count); },
  undo(doc) { doc.restoreDeleteFragment(this.fragmentId); this.fragmentId = null; },
  discard(doc) { if (this.fragmentId !== null) { doc.discardDeleteFragment(this.fragmentId); this.fragmentId = null; } },
});

test('U3-b ① 선택 삭제 뒤 B 가 범위 앞에서 Enter → 허용(U1 의 "조각이 옮겨지면 막음"을 풂), 원래 내용·B 의 Enter 유지, 범위 표시', () => {
  const r = rangeRoom(6);
  r.a.history.execute(fragmentDelete(1, 1, 3, 1));
  r.server.drain(r.all);
  assert.deepEqual(paragraphs(r.b.doc), ['p0', 'p3', 'p4', 'p5']);
  r.b.history.execute(splitParagraph(0, 1));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  converged(r);
  assert.deepEqual(paragraphs(r.a.doc), ['p', '0', 'p1', 'p2', 'p3', 'p4', 'p5']);
  assert.deepEqual(lastEntry(r).range, { section: 0, lo: 2, before: 1, after: 3 });
  assert.equal(r.server.rangeRejects, 0);
  assert.equal(r.a.engine.recipeCount(), 0);
});

test('U3-b ② 선택 삭제 뒤 B 가 범위 뒤에서 Enter → 허용(업스트림 조각 복원은 문단 수 전제에 걸려 실패하던 경우)', () => {
  const r = rangeRoom(6);
  r.a.history.execute(fragmentDelete(1, 1, 3, 1));
  r.server.drain(r.all);
  r.b.history.execute(splitParagraph(3, 1)); // 'p5' → 'p', '5'
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  converged(r);
  assert.deepEqual(paragraphs(r.a.doc), ['p0', 'p1', 'p2', 'p3', 'p4', 'p', '5']);
});

test('U3-b ③ B 가 합쳐진 문단(범위)을 고쳤으면 막힘·알림·문서 그대로', () => {
  const r = rangeRoom(6);
  r.a.history.execute(fragmentDelete(1, 1, 3, 1));
  r.server.drain(r.all);
  r.b.history.execute(insertText(1, 0, 'B'));
  r.server.drain(r.all);
  const before = paragraphs(r.a.doc);
  assert.equal(r.a.history.undo(), UNDO_BLOCKED_NOTICE);
  assert.deepEqual(paragraphs(r.a.doc), before);
  converged(r);
});

test('U3-b ④ B 가 계속 치는 중: A 의 복원 state 가 먼저 가도, B 의 묶음이 먼저 가도 둘 다 취소되지 않는다', () => {
  for (const order of ['A 먼저', 'B 먼저']) {
    const r = rangeRoom(6);
    r.a.history.execute(fragmentDelete(1, 1, 3, 1));
    r.server.drain(r.all);
    assert.equal(r.a.history.undo(), 'ok');
    if (order === 'A 먼저') {
      r.a.flush();
      r.b.history.execute(insertText(3, 0, 'B')); // 범위 밖(합쳐진 뒤 마지막 문단)
      r.b.flush();
      while (r.server.deliverOne(r.b)) { /* B: 미확정이 있는 채로 A 의 복원 state */ }
    } else {
      r.b.history.execute(splitParagraph(0, 1));
      r.b.flush();
      r.server.deliverOne(r.b);
      while (r.server.deliverOne(r.a)) { /* A: 미확정 복원 state 가 있는 채로 B 의 Enter → 다시 만듦 */ }
    }
    r.server.drain(r.all);
    converged(r);
    assert.deepEqual([r.a.dropped, r.b.dropped], [0, 0], order);
    assert.equal(r.server.rangeRejects, 0, order);
    assert.equal(r.a.engine.recipeCount(), 0, order);
  }
});

test('U3-b ⑤ 덮어쓰기 입력(병합 포함): B 가 다른 문단에 입력·Enter 해도 문단이 덮어쓰기 전으로', () => {
  const r = rangeRoom(5);
  r.a.history.execute(overwrite(2, 0, 'X', 'p'));
  r.a.history.executeMerged(overwrite(2, 1, 'Y', '2'), mergeOverwrite);
  r.server.drain(r.all);
  assert.equal(paragraphs(r.b.doc)[2], 'XY');
  assert.equal(r.a.history.undoStack.length, 1, '병합해 한 단계');
  r.b.history.execute(insertText(4, 0, 'B'));
  r.b.history.execute(splitParagraph(0, 1));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  converged(r);
  assert.deepEqual(paragraphs(r.a.doc), ['p', '0', 'p1', 'p2', 'p3', 'Bp4']);
  assert.ok(lastEntry(r).range, '범위 표시');
  assert.equal(r.a.engine.recipeCount(), 0);
});

test('U3-b ⑥ 링크·메모 앵커를 걸친 삭제(조각): 앞 문단 Enter 뒤 되돌리기 허용, 다시 하기·다시 되돌리기', () => {
  const r = rangeRoom(5);
  r.a.history.execute(anchoredDelete(3, 0, 1));
  r.server.drain(r.all);
  r.b.history.execute(splitParagraph(0, 1));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok');
  r.server.drain(r.all);
  assert.deepEqual(paragraphs(r.a.doc), ['p', '0', 'p1', 'p2', 'p3', 'p4']);
  // 다시 하기는 조각을 새로 잡아 지운다(op) — 옮겨진 자리에서
  assert.equal(r.a.history.redo(), 'ok');
  r.server.drain(r.all);
  assert.deepEqual(paragraphs(r.a.doc), ['p', '0', 'p1', 'p2', '3', 'p4']);
  r.b.history.execute(insertText(5, 0, 'B'));
  r.server.drain(r.all);
  assert.equal(r.a.history.undo(), 'ok', '다시 한 뒤에도 새 조각으로 범위 복원');
  converged(r);
  assert.deepEqual(paragraphs(r.a.doc), ['p', '0', 'p1', 'p2', 'p3', 'Bp4']);
  assert.equal(r.a.engine.recipeCount(), 0);
});
