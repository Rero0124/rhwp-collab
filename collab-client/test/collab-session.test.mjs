// 6단계 N1: 플랫폼 중립 세션(CollabSession)을 가짜 Transport·Host·Clock 과 진짜 rhwp 문서로 Node 에서 돌린다.
// 지금까지 브라우저로만 보던 재접속·reject·replaced·unauthorized·세대 전환·재동기화 상한·조합 중 보류를 단위 시험으로 덮는다.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { loadWasm, blankBytes, paragraphs } from './support/harness.mjs';
import { CollabSession, randomClientId, noticeTexts, leftBanner, resyncCauseText } from '../src/session/index.ts';
import { bytesToBase64 } from '../src/engine/codec.ts';
import { ENGINE_FINGERPRINT } from '../src/engine/catalog.ts';

let wasm;
before(async () => { wasm = await loadWasm(); });

/** 마이크로태스크·즉시 작업을 여러 바퀴 돌린다(hello 토큰·메시지 줄·문서 열기가 비동기) */
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

class FakeClock {
  t = 1_000_000;
  seq = 0;
  timers = new Map();
  now() { return this.t; }
  /** 건 setTimeout 의 대기(ms) — 시험이 타이머가 얼마나 자주 걸리는지 본다 */
  waits = [];
  setTimeout(fn, ms) { const id = ++this.seq; this.waits.push(ms); this.timers.set(id, { at: this.t + ms, fn }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
  setInterval(fn, ms) { const id = ++this.seq; this.timers.set(id, { at: this.t + ms, fn, every: ms }); return id; }
  clearInterval(id) { this.timers.delete(id); }
  async advance(ms) {
    const end = this.t + ms;
    let fired = 0;
    for (;;) {
      if (++fired > 5000) throw new Error(`타이머가 멈추지 않습니다(${this.t})`);
      let next = null;
      for (const [id, tm] of this.timers) if (tm.at <= end && (!next || tm.at < next[1].at)) next = [id, tm];
      if (!next) break;
      const [id, tm] = next;
      this.t = tm.at;
      if (tm.every) tm.at += tm.every; else this.timers.delete(id);
      tm.fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
}

/** 가짜 연결들: 보낸 것을 기록하고, 시험이 서버 메시지를 넣고 연다·끊는다 */
class FakeNet {
  conns = [];
  factory = (events) => {
    const c = {
      events, sent: [], isOpen: false, closed: false,
      send(text) { if (this.isOpen) this.sent.push(JSON.parse(text)); },
      close() { if (this.closed) return; this.closed = true; this.isOpen = false; queueMicrotask(() => events.close()); },
    };
    this.conns.push(c);
    return c;
  };
  get last() { return this.conns.at(-1); }
  async open(c = this.last) { c.isOpen = true; c.events.open(); await settle(); }
  async deliver(msg, c = this.last) { c.events.message(JSON.stringify(msg)); await settle(); }
  /** 서버 쪽에서 끊김 */
  async drop(c = this.last) { c.isOpen = false; c.closed = true; c.events.close(); await settle(); }
  sentOf(type, c = this.last) { return c.sent.filter((m) => m.type === type); }
}

function fakeHost() {
  const h = {
    doc: null, events: [], external: [], composing: false, caret: null, encrypted: false, opened: [],
    notices: () => h.events.filter((e) => e.type === 'notice').map((e) => e.notice.code),
    of: (type) => h.events.filter((e) => e.type === type),
  };
  h.host = {
    doc: () => h.doc,
    ensureDoc: async () => { if (!h.doc) h.doc = new wasm.HwpDocument(blankBytes()); },
    isEncrypted: () => h.encrypted,
    exportState: () => h.doc.collabExportState(),
    openDoc: async (bytes, info) => { h.opened.push(info); h.doc = new wasm.HwpDocument(bytes[0] === 0x1f ? gunzipSync(bytes) : bytes); },
    layoutPolicyHolds: () => true,
    applyExternal: (kind, fn) => { h.external.push(kind); return fn(); },
    captureCaret: () => (h.caret ? { text: h.caret } : null),
    restoreCaret: (snap, moved) => { h.caret = moved ?? snap.text; },
    isComposing: () => h.composing,
    event: (e) => h.events.push(e),
    log: () => {},
  };
  return h;
}

/** 빈 문서에 글을 넣은 상태(gzip, base64) — welcome.base·state 기록의 data */
function stateWith(text = '') {
  const d = new wasm.HwpDocument(blankBytes());
  if (text) d.insertText(0, 0, 0, text);
  const s = bytesToBase64(d.collabExportState());
  d.free();
  return s;
}
const op = (text) => ({ kind: 'op', m: 'insertText', a: [0, 0, 0, text] });
/** 기록 비교는 이름·인자만(엔진이 meta·ctx 를 붙일 수 있다) */
const shape = (entries) => entries.map((e) => (e.kind === 'op' ? { kind: e.kind, m: e.m, a: e.a } : e));
const USER = { sub: 'u-a', name: 'A', scope: ['edit'] };

/** 세션을 띄우고 방에 들어간 상태까지 */
async function joined({ generation = 1, user = USER, getToken, maxMessageBytes = 1_000_000, base = stateWith() } = {}) {
  const clock = new FakeClock();
  const net = new FakeNet();
  const h = fakeHost();
  const tokens = [];
  const s = new CollabSession({
    room: 'r', name: 'anon', clientId: 'A', transport: net.factory, host: h.host, clock,
    getToken: getToken ?? (({ reason }) => { tokens.push(reason); return `t-${reason}`; }),
  });
  s.start();
  await net.open();
  await net.deliver({ type: 'welcome', seq: 0, base, log: [], generation, user, maxMessageBytes });
  return { s, clock, net, h, tokens };
}
/** 내 편집 하나(studio 의 문서 호출 가로채기와 같은 길) */
function edit(s, h, text) {
  return s.engine.intercept('insertText', [0, 0, 0, text], () => h.doc.insertText(0, 0, 0, text), h.doc);
}

test('들어오기: hello(토큰 connect) → welcome → 문서 열기·joined·권한·이름, digest 보고와 커서 보내기', async () => {
  const { s, clock, net, h } = await joined();
  const [hello] = net.sentOf('hello');
  assert.deepEqual(hello, { type: 'hello', room: 'r', clientId: 'A', name: 'anon', engine: ENGINE_FINGERPRINT, token: 't-connect' });
  const st = s.status();
  assert.equal(st.ready, true);
  assert.equal(s.phase, 'synced');
  assert.equal(s.name, 'A', 'welcome.user.name 으로 바뀜');
  assert.deepEqual(h.notices(), ['joined']);
  assert.deepEqual(h.of('admitted').map((e) => e.user?.sub), ['u-a']);
  assert.ok(h.doc, '문서를 열었다');
  await clock.advance(1000);
  const [digest] = net.sentOf('digest');
  assert.equal(digest.seq, 0);
  assert.equal(digest.digest, h.doc.collabDigest());
  h.caret = { section: 0, para: 0, offset: 0 };
  await clock.advance(150);
  assert.deepEqual(net.sentOf('cursor').at(-1), { type: 'cursor', seq: 0, caret: { section: 0, para: 0, offset: 0 } });
  // status 는 studio __collab.status() 의 필드를 그대로 갖는다
  for (const k of ['room', 'name', 'clientId', 'lastSeq', 'inflight', 'ready', 'resyncing', 'left', 'desynced', 'desyncReason', 'connection',
    'pending', 'unsent', 'sentEntries', 'droppedTotal', 'replacedAcks', 'lastDigest', 'digestSentSeq', 'resyncCount', 'engine', 'cursors',
    'reconnects', 'disconnectedAt', 'inflightBatch', 'user', 'fast']) assert.ok(k in st, k);
  s.dispose();
});

test('digest: 바쁜 동안은 한 간격마다만 다시 보고(0ms 로 다시 걸지 않음), 한가해지면(확정) 곧 보고한다', async () => {
  const { s, clock, net, h } = await joined();
  await clock.advance(1000);
  assert.equal(net.sentOf('digest').length, 1, '들어온 뒤 한 번');
  edit(s, h, 'a');
  await settle();
  // 내 묶음이 확정되기 전에 남의 묶음이 온다 → 보고를 잡지만 바쁘다(inflight). 예전에는 여기서 0ms 로 계속 다시 걸렸다.
  await net.deliver({ type: 'ops', seq: 1, clientId: 'B', entries: [op('X')] });
  let before = clock.waits.length;
  await clock.advance(10_000);
  let waits = clock.waits.slice(before);
  assert.ok(waits.length <= 12 && waits.filter((w) => w === 0).length === 0, `10초 동안 타이머 [${waits.join(',')}]`);
  assert.equal(net.sentOf('digest').length, 1, '바쁜 동안 보고하지 않음');
  await clock.advance(300);
  await net.deliver({ type: 'ops', seq: 2, clientId: 'A', entries: [op('a')], batchId: 'A:1' });
  await clock.advance(0);
  const reports = net.sentOf('digest');
  assert.equal(reports.length, 2, '확정되자 1초 뒤로 걸어 둔 타이머를 당겨 곧 보고');
  assert.deepEqual([reports[1].seq, reports[1].digest], [2, h.doc.collabDigest()]);
  // 끊긴 동안도 같다: 남의 묶음으로 보고를 잡은 뒤 끊김
  edit(s, h, 'b');
  await settle();
  await net.deliver({ type: 'ops', seq: 3, clientId: 'B', entries: [op('Y')] });
  await net.drop();
  before = clock.waits.length;
  await clock.advance(10_000);
  waits = clock.waits.slice(before);
  assert.ok(waits.length <= 14 && waits.filter((w) => w === 0).length === 0, `끊긴 10초 동안 타이머 [${waits.join(',')}]`);
  s.dispose();
});

test('내 편집: 묶음(batchId) 보내기 → reject 면 미확정 앞에 되돌려 다시 보냄, 늦은 옛 reject 는 무시, 확정(ops 메아리)', async () => {
  const { s, net, h } = await joined();
  edit(s, h, 'a');
  await settle();
  let ops = net.sentOf('ops');
  assert.equal(ops.length, 1);
  assert.deepEqual([ops[0].base, ops[0].batchId, shape(ops[0].entries)], [0, 'A:1', [op('a')]]);
  assert.equal(s.status().inflight, 1);
  assert.equal(s.hasUnconfirmedEdits(), true);
  await net.deliver({ type: 'reject', seq: 0, batchId: 'A:1' });
  ops = net.sentOf('ops');
  assert.equal(ops.length, 2);
  assert.deepEqual([ops[1].batchId, shape(ops[1].entries)], ['A:2', [op('a')]]);
  await net.deliver({ type: 'reject', seq: 0, batchId: 'A:1' }); // 늦게 온 옛 묶음의 reject
  assert.equal(net.sentOf('ops').length, 2);
  await net.deliver({ type: 'ops', seq: 1, clientId: 'A', entries: [op('a')], batchId: 'A:2' });
  assert.deepEqual([s.lastSeq, s.status().inflight, s.phase, s.hasUnconfirmedEdits()], [1, 0, 'synced', false]);
  assert.equal(paragraphs(h.doc)[0], 'a');
  s.dispose();
});

test('원격 묶음: 되감기·보정으로 반영하고 캐럿을 옮김 / seq 가 건너뛰면 재동기화 → welcome(resync) 로 제자리 맞춤', async () => {
  const { s, net, h } = await joined();
  h.caret = { section: 0, para: 0, offset: 0 };
  await net.deliver({ type: 'ops', seq: 1, clientId: 'B', entries: [op('XY')] });
  assert.equal(paragraphs(h.doc)[0], 'XY');
  assert.ok(h.external.includes('remote'));
  assert.equal(s.lastSeq, 1);
  await net.deliver({ type: 'ops', seq: 3, clientId: 'B', entries: [op('Q')] });
  assert.equal(net.sentOf('resync').length, 1);
  assert.equal(s.phase, 'resyncing');
  const docBefore = h.doc;
  await net.deliver({ type: 'welcome', seq: 3, base: stateWith('서버'), log: [], resync: true, generation: 1 });
  assert.equal(h.doc, docBefore, '문서 객체는 그대로(제자리)');
  assert.equal(paragraphs(h.doc)[0], '서버');
  assert.deepEqual([s.lastSeq, s.phase], [3, 'synced']);
  assert.ok(h.notices().includes('resynced'));
  s.dispose();
});

test('replaced: 서버가 내 묶음의 state 를 다시 쓴 바이트로 확정 → 확정 상태를 S 로 두고 뒤 미확정을 그대로 다시 얹음', async () => {
  const { s, net, h } = await joined();
  edit(s, h, 'a');
  await settle();
  edit(s, h, 'b'); // inflight 동안 쌓인 미확정
  await settle();
  assert.equal(net.sentOf('ops').length, 1);
  await net.deliver({ type: 'ops', seq: 1, clientId: 'A', entries: [{ kind: 'state', data: stateWith('a') }], batchId: 'A:1', replaced: true });
  assert.equal(s.status().replacedAcks, 1);
  assert.ok(h.external.includes('replaced'));
  assert.equal(paragraphs(h.doc)[0], 'ba', 'R(S) 위에 b 를 다시 얹음');
  const ops = net.sentOf('ops');
  assert.deepEqual([ops.length, ops[1].base, shape(ops[1].entries)], [2, 1, [op('b')]], '남은 미확정을 이어 보냄');
  s.dispose();
});

test('끊김: 지수 백오프로 다시 붙고 hello 에 lastSeq·generation, 따라잡기 안의 내 묶음(batchId)은 확정', async () => {
  const { s, clock, net, h, tokens } = await joined({ generation: 7 });
  edit(s, h, 'a');
  await settle();
  await net.drop();
  assert.equal(s.phase, 'closed');
  assert.equal(h.of('disconnected').length, 1);
  await clock.advance(499);
  assert.equal(net.conns.length, 1);
  await clock.advance(1);
  assert.equal(net.conns.length, 2, '500ms 뒤 다시 연결');
  await net.drop(); // 열리기 전에 또 끊김 → 1000ms
  await clock.advance(999);
  assert.equal(net.conns.length, 2);
  await clock.advance(1);
  assert.equal(net.conns.length, 3);
  edit(s, h, 'b'); // 끊긴 동안 쌓인 편집
  await settle();
  await net.open();
  const [hello] = net.sentOf('hello');
  assert.deepEqual([hello.lastSeq, hello.generation, hello.token], [0, 7, 't-reconnect']);
  assert.deepEqual(tokens, ['connect', 'reconnect']);
  assert.equal(net.sentOf('ops').length, 0, '서버 답 전에는 보내지 않음(resuming)');
  await net.deliver({ type: 'catchup', seq: 2, log: [
    { seq: 1, clientId: 'B', entries: [op('X')] },
    { seq: 2, clientId: 'A', batchId: 'A:1', entries: [op('a')] },
  ] });
  assert.deepEqual([s.lastSeq, s.status().reconnects], [2, 1]);
  assert.deepEqual(h.of('reconnected').length, 1);
  assert.ok(h.notices().includes('reconnected'));
  const ops = net.sentOf('ops');
  assert.deepEqual([ops.length, ops[0].base, ops[0].entries.length, ops[0].entries[0].a.at(-1)], [1, 2, 1, 'b'], '끊긴 동안의 편집만(남의 X 뒤로 보정) 이어 보냄');
  assert.equal(paragraphs(h.doc)[0].length, 3);
  s.dispose();
});

test('따라잡기에 내 묶음이 없으면(서버에 닿지 않음) 미확정 앞에 되돌려 다시 보낸다', async () => {
  const { s, clock, net, h } = await joined();
  edit(s, h, 'a');
  await settle();
  await net.drop();
  await clock.advance(500);
  await net.open();
  await net.deliver({ type: 'catchup', seq: 1, log: [{ seq: 1, clientId: 'B', entries: [op('X')] }] });
  const ops = net.sentOf('ops');
  assert.equal(ops.length, 1);
  assert.deepEqual([ops[0].base, ops[0].batchId], [1, 'A:2']);
  s.dispose();
});

test('세대가 바뀌어 welcome 이 오면 resume-fallback: 미확정을 버리고 서버 문서로, 다음 hello 는 새 세대', async () => {
  const { s, clock, net, h } = await joined({ generation: 1 });
  edit(s, h, 'zz');
  await settle();
  await net.drop();
  await clock.advance(500);
  await net.open();
  await net.deliver({ type: 'welcome', seq: 5, base: stateWith('새 세대'), log: [], generation: 2, user: USER });
  assert.ok(h.notices().includes('resume-fallback'));
  assert.equal(h.of('reconnected').length, 1);
  assert.equal(paragraphs(h.doc)[0], '새 세대');
  assert.deepEqual([s.lastSeq, s.status().inflight, s.status().pending], [5, 0, 0]);
  await net.drop();
  await clock.advance(500);
  await net.open();
  assert.equal(net.sentOf('hello')[0].generation, 2);
  s.dispose();
});

test('unauthorized: expired 는 한 번 새 토큰으로 다시 붙고, 또 오면 left{unauthorized, unsent} — 다시 붙지 않는다', async () => {
  const asked = [];
  const { s, clock, net, h } = await joined({ getToken: ({ reason }) => { asked.push(reason); return `t-${reason}-${asked.length}`; } });
  await net.deliver({ type: 'unauthorized', reason: 'expired' });
  assert.deepEqual(asked, ['connect', 'expired']);
  await net.drop();
  await clock.advance(500);
  await net.open();
  assert.equal(net.sentOf('hello')[0].token, 't-expired-2', '받아 둔 새 토큰');
  edit(s, h, 'q'); // resuming 이라 보내지 못한 편집
  await settle();
  await net.deliver({ type: 'unauthorized', reason: 'expired' });
  const [left] = h.of('left');
  assert.deepEqual(left.reason, { code: 'unauthorized', reason: 'expired', unsent: 1 });
  assert.equal(leftBanner(left.reason).kind, 'unauthorized');
  assert.match(leftBanner(left.reason).text, /보내지 못한 편집 1건/);
  assert.equal(s.phase, 'left');
  assert.equal(net.last.closed, true);
  const n = net.conns.length;
  await clock.advance(30_000);
  assert.equal(net.conns.length, n, '나간 뒤에는 다시 붙지 않음');
  assert.equal(s.hasUnconfirmedEdits(), false);
  s.dispose();
});

test('unauthorized: 고칠 수 없는 이유(missing)는 곧바로 left', async () => {
  const { s, net, h } = await joined();
  await net.deliver({ type: 'unauthorized', reason: 'missing' });
  assert.deepEqual(h.of('left')[0].reason, { code: 'unauthorized', reason: 'missing', unsent: 0 });
  s.dispose();
});

test('재동기화가 1분에 3회를 넘으면 desynced(멈춤), 1분이 지나면 다시 셈', async () => {
  const { s, clock, net, h } = await joined();
  for (let i = 1; i <= 3; i += 1) {
    await net.deliver({ type: 'diverged', seq: 0 });
    assert.equal(s.phase, 'resyncing');
    await net.deliver({ type: 'welcome', seq: 0, base: stateWith(), log: [], resync: true });
    assert.equal(s.phase, 'synced');
  }
  await net.deliver({ type: 'diverged', seq: 0 });
  assert.equal(s.phase, 'desynced');
  const [d] = h.of('desynced');
  assert.equal(d.cause.code, 'limit');
  assert.equal(d.cause.last.code, 'diverged');
  assert.match(s.status().desyncReason, /재동기화가 1분에 3회를 넘었습니다 \(참여자 간 문서 지문이 다릅니다/);
  assert.equal(s.engine.pendingCount, 0);
  s.dispose();

  const b = await joined();
  for (let i = 0; i < 3; i += 1) {
    await b.net.deliver({ type: 'diverged', seq: 0 });
    await b.net.deliver({ type: 'welcome', seq: 0, base: stateWith(), log: [], resync: true });
  }
  await b.clock.advance(61_000);
  await b.net.deliver({ type: 'diverged', seq: 0 });
  assert.equal(b.s.phase, 'resyncing', '창 밖의 재동기화는 세지 않음');
  b.s.dispose();
});

test('조합 중에는 원격을 보류했다가 조합이 끝나면 순서대로 처리하고 내 편집을 보냄', async () => {
  const { s, net, h } = await joined();
  h.composing = true;
  await net.deliver({ type: 'ops', seq: 1, clientId: 'B', entries: [op('X')] });
  assert.equal(s.lastSeq, 0, '보류');
  edit(s, h, 'a');
  await settle();
  assert.equal(net.sentOf('ops').length, 0, '조합 중에는 보내지 않음');
  h.composing = false;
  s.compositionEnded();
  await settle();
  assert.equal(s.lastSeq, 1);
  const ops = net.sentOf('ops');
  assert.deepEqual([ops.length, ops[0].base], [1, 1]);
  s.dispose();
});

test('too-large: 편집 메시지가 상한을 넘으면 보내지 않고 안내와 재동기화 / 서버의 too-large base 면 나감', async () => {
  const { s, net, h } = await joined({ maxMessageBytes: 200 });
  edit(s, h, '가'.repeat(200));
  await settle();
  assert.equal(net.sentOf('ops').length, 0);
  assert.ok(h.notices().includes('too-large'));
  assert.equal(net.sentOf('resync').length, 1);
  assert.equal(s.phase, 'resyncing');
  assert.equal(resyncCauseText({ code: 'too-large', limit: 200, side: 'local' }), '편집이 메시지 상한 200바이트를 넘음');
  await net.deliver({ type: 'welcome', seq: 0, base: stateWith(), log: [], resync: true });
  await net.deliver({ type: 'too-large', what: 'base', bytes: 1, limit: 1 });
  assert.equal(h.of('left')[0].reason.code, 'base-too-large');
  s.dispose();
});

test('첫 참여자: 빈 방(base null)이면 지금 문서를 base 로 올리고 같은 바이트로 다시 연다 / 암호 문서는 허용될 때만', async () => {
  const clock = new FakeClock();
  const net = new FakeNet();
  const h = fakeHost();
  const s = new CollabSession({ room: 'r', name: 'A', clientId: 'A', transport: net.factory, host: h.host, clock });
  s.start();
  await net.open();
  assert.equal(net.sentOf('hello')[0].token, undefined, '토큰 공급자가 없으면 토큰 없음');
  await net.deliver({ type: 'welcome', seq: 0, base: null, log: [] });
  const [base] = net.sentOf('base');
  assert.ok(base.data.length > 0);
  assert.equal(base.encryptedSource, undefined);
  assert.equal(s.status().ready, true);
  s.dispose();

  const h2 = fakeHost();
  h2.encrypted = true;
  const net2 = new FakeNet();
  const s2 = new CollabSession({ room: 'r', name: 'A', clientId: 'A2', transport: net2.factory, host: h2.host, clock: new FakeClock() });
  s2.start();
  await net2.open();
  await net2.deliver({ type: 'welcome', seq: 0, base: null, log: [] });
  assert.equal(h2.of('left')[0].reason.code, 'encrypted');
  assert.equal(net2.sentOf('base').length, 0);
  s2.dispose();
});

test('8단계 E4: 원래 암호 문서였던 방이면 문서를 열 때 encryptedSource 를 넘긴다 — welcome 의 표시, 또는 내가 암호 문서로 연 방', async () => {
  const enter = async (welcome, encrypted = false) => {
    const net = new FakeNet();
    const h = fakeHost();
    h.encrypted = encrypted;
    if (welcome.base === null) h.doc = new wasm.HwpDocument(blankBytes());
    const s = new CollabSession({ room: 'r', name: 'A', clientId: 'A', transport: net.factory, host: h.host, clock: new FakeClock() });
    s.start();
    await net.open();
    await net.deliver({ type: 'welcome', seq: 0, log: [], generation: 1, user: USER, ...welcome });
    return { s, net, h };
  };
  // welcome 에 표시가 있는 방: 열 때 넘기고, 상태에도 남고, 안내는 그대로 한 번
  const a = await enter({ base: stateWith('가'), encryptedSource: true });
  assert.deepEqual(a.h.opened, [{ encryptedSource: true }]);
  assert.equal(a.s.status().encryptedSource, true);
  assert.equal(a.h.notices().filter((c) => c === 'encrypted-source').length, 1);
  a.s.dispose();
  // 표시 없는 방
  const b = await enter({ base: stateWith('가') });
  assert.deepEqual(b.h.opened, [{ encryptedSource: false }]);
  assert.equal(b.s.status().encryptedSource, false);
  b.s.dispose();
  // 첫 참여자가 암호 문서로 연 방(서버가 허용): base 에 표시를 싣고, 같은 바이트로 다시 열 때도 넘긴다
  const c = await enter({ base: null, allowEncrypted: true }, true);
  assert.equal(c.net.sentOf('base')[0].encryptedSource, true);
  assert.deepEqual(c.h.opened, [{ encryptedSource: true }]);
  assert.equal(c.s.status().encryptedSource, true);
  c.s.dispose();
  // 첫 참여자가 평문 문서로 연 방
  const d = await enter({ base: null });
  assert.equal(d.net.sentOf('base')[0].encryptedSource, undefined);
  assert.deepEqual(d.h.opened, [{ encryptedSource: false }]);
  d.s.dispose();
});

test('편집기가 문서를 바꾸면(세션이 일으킨 것이 아니면) swapped 로 나감, 호스트가 나가게 할 수도 있음', async () => {
  const { s, h } = await joined();
  s.documentSwapped();
  assert.deepEqual(h.of('left').map((e) => e.reason), [{ code: 'swapped' }]);
  const b = await joined();
  b.s.leave({ code: 'host', detail: '바깥 시스템에서 접속 정보를 받지 못했습니다' });
  assert.equal(leftBanner(b.h.of('left')[0].reason).text, '공동편집에서 나왔습니다 (바깥 시스템에서 접속 정보를 받지 못했습니다)');
  s.dispose();
  b.s.dispose();
});

test('다른 사람 커서: 받으면 목록에, 원격 편집 지도로 옮기고, cursor-leave·끊김에 지움', async () => {
  const { s, net, h } = await joined({ base: stateWith('hello') });
  await net.deliver({ type: 'cursor', clientId: 'B', name: 'B', seq: 0, caret: { section: 0, para: 0, offset: 2 } });
  assert.deepEqual([...s.cursors.keys()], ['B']);
  await net.deliver({ type: 'ops', seq: 1, clientId: 'C', entries: [op('XYZ')] });
  assert.equal(s.cursors.get('B').caret.offset, 5, '앞에 넣은 글만큼 옮김');
  await net.deliver({ type: 'cursor-leave', clientId: 'B' });
  assert.equal(s.cursors.size, 0);
  await net.deliver({ type: 'cursor', clientId: 'D', name: 'D', seq: 1, caret: null });
  await net.drop();
  assert.equal(s.cursors.size, 0);
  assert.ok(h.of('cursors').length >= 4);
  s.dispose();
});

test('왕복 점검 알림: 방에 있는 동안 뒤에서 끝난 결과(경고·점검 못 함)를 roundtrip 메시지로 받아 한 번 알림, 통과면 무시', async () => {
  const { s, net, h } = await joined();
  await net.deliver({ type: 'roundtrip', roundtrip: { ok: true, lost: [], irDiff: 0 } });
  assert.equal(h.notices().filter((c) => c === 'roundtrip').length, 0);
  const timeout = { ok: null, reason: 'timeout', lost: [], irDiff: 0 };
  await net.deliver({ type: 'roundtrip', roundtrip: timeout });
  await net.deliver({ type: 'roundtrip', roundtrip: timeout });
  const notes = h.events.filter((e) => e.type === 'notice' && e.notice.code === 'roundtrip');
  assert.equal(notes.length, 1, '한 번만');
  assert.match(noticeTexts(notes[0].notice)[0].text, /^왕복 점검 못 함\(시간 초과\)/);
  s.dispose();
  // welcome 에서 이미 받았으면 알림 메시지로 다시 알리지 않는다
  const b = await joined({ });
  await b.net.deliver({ type: 'welcome', seq: 0, base: stateWith(), log: [], resync: true, roundtrip: timeout });
  await b.net.deliver({ type: 'roundtrip', roundtrip: timeout });
  assert.equal(b.h.notices().filter((c) => c === 'roundtrip').length, 1);
  b.s.dispose();
});

test('기본 문구: 안내 코드마다 줄이 있고(joined 는 두 줄), clientId 대체 생성기', () => {
  assert.deepEqual(noticeTexts({ code: 'joined' }).map((l) => l.kind), ['notice', 'font-policy']);
  assert.equal(noticeTexts({ code: 'forbidden', reason: '모름' })[0].text, noticeTexts({ code: 'forbidden', reason: 'scope' })[0].text);
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    const id = randomClientId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(id, randomClientId());
  } finally {
    Object.defineProperty(globalThis, 'crypto', saved);
  }
});

test('플랫폼 중립: session/ 아래에서 window·document·location·localStorage·sessionStorage·DecompressionStream 을 쓰지 않는다', () => {
  const dir = new URL('../src/session/', import.meta.url);
  const banned = /(?<![\w$.'"`-])(window|document|location|localStorage|sessionStorage|DecompressionStream)(?![\w$-])/;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const code = readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    const hit = code.split('\n').find((line) => banned.test(line));
    assert.equal(hit, undefined, `${f}: ${hit}`);
  }
});
