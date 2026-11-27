// 5단계 D6 메모 작성자(서버 쪽): 메모를 만드는 op(insertMemo·insertMemoByPath·insertMemoReply)의 author 는 그 연결의
// 이름(토큰의 name, 없으면 hello 의 표시 이름)이어야 한다 — 모든 권한, 정본 전에 판정. comment 권한은 자기 메모만
// 고치고 지운다(setMemoText·removeMemo — 정본의 메모 목록으로 확인). 어긋나면 forbidden(author). 메모 모양(setMemoShape)은
// edit 전용이다. 이름은 hello 때 정한 입장 이름(rhwp 의 작성자 규칙으로 다듬은 것)이다.
// 거절 쪽은 정본 전에 판정하므로 승격 전에도 돈다. 통과 쪽은 메모 함수가 분류표에서 op 로 올라간 뒤에 돈다(그 전에는 건너뜀).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { startServer } from '../server.mjs';
import { DEFAULT_PKG } from '../canonical.mjs';
import { hs256Auth } from '../auth.mjs';
import { CollabEngine } from '../../collab-client/src/engine/engine.ts';
import { CATALOG, ENGINE_FINGERPRINT } from '../../collab-client/src/engine/catalog.ts';

const wasm = await import(pathToFileURL(`${DEFAULT_PKG}/rhwp.js`).href);
wasm.initSync({ module: readFileSync(`${DEFAULT_PKG}/rhwp_bg.wasm`) });

/** 메모 함수가 op 로 올라갔는가(3b 의 승격) — 아니면 통과 시험은 건너뛴다 */
const PROMOTED = ['insertMemo', 'insertMemoReply', 'setMemoText', 'removeMemo', 'setMemoShape'].every((m) => CATALOG[m]?.sync === 'op');
const NEEDS_PROMOTION = !PROMOTED && '메모 함수가 아직 분류표에서 op 가 아니다(3b 의 승격 뒤에 돈다)';
/** 메모 모양이 edit 전용으로 바뀌었는가(분류표 perm 이 memo 가 아님) */
const SHAPE_EDIT_ONLY = CATALOG.setMemoShape?.perm !== 'memo';
/** 메모를 만드는 op 는 시각을 ctx.memoTime 에 싣는다(재생이 같은 결과가 되게) */
const MEMO_TIME = '134000000000000000';

const auth = hs256Auth(randomBytes(32).toString('base64url'));
const now = () => Math.floor(Date.now() / 1000);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const memoJson = (author, text = '메모') => JSON.stringify({ author, text });
const SHAPE = JSON.stringify({ width: 12000, lineType: 1, lineWidth: 2, lineColor: '#112233', fillColor: '#FFFFCC', activeColor: '#FFCC00' });

function documentBytes() {
  const d = wasm.HwpDocument.createEmpty();
  d.createBlankDocument();
  d.insertText(0, 0, 0, '메모를 달 본문 문단입니다. 앞과 뒤에 메모를 단다.');
  const raw = gunzipSync(Buffer.from(d.collabExportState()));
  d.free();
  return raw;
}
const DOC = documentBytes();

let server;
let port;
before(async () => {
  server = startServer({ port: 0, log: () => {}, delayMs: 0, auth });
  await server.ready;
  port = server.port;
});
after(() => server?.close());

async function makeRoom() {
  const res = await fetch(`http://127.0.0.1:${port}/rooms`, {
    method: 'POST', body: DOC,
    headers: { authorization: `Bearer ${auth.issue({ sub: 'admin', room: '*', scope: 'create', exp: now() + 600 })}` },
  });
  assert.equal(res.status, 201);
  return res.json();
}

/** 원시 클라이언트 + 받은 묶음을 재생하는 사본. token 이 문자열이면 그 토큰(초대 토큰), 아니면 {name, scope} 로 만든다. */
async function client(room, label, { token, name = label, scope, helloName = name } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const w = waiters.shift();
    if (w) w(msg); else queue.push(msg);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const c = {
    label, seq: 0, batch: 0,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (ms = 15_000) => {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label}: 메시지 없음`)), ms);
        waiters.push((m) => { clearTimeout(timer); resolve(m); });
      });
    },
    silent: async (ms = 300) => {
      await new Promise((r) => setTimeout(r, ms));
      assert.deepEqual(queue.filter((m) => m.type !== 'cursor'), [], `${label}: 예상 밖 메시지`);
    },
    ops: async (entries) => {
      const batchId = `${label}:${++c.batch}`;
      ws.send(JSON.stringify({ type: 'ops', base: c.seq, entries, batchId }));
      const res = await c.next();
      if (res.type === 'ops') { c.seq = res.seq; c.apply(res); }
      return { res, batchId };
    },
    apply: (msg) => c.engine.replayAll([{ seq: msg.seq, clientId: msg.clientId, entries: msg.entries }]),
    memos: () => JSON.parse(c.doc.getMemoList()),
    close: () => { c.engine?.detach(); c.doc?.free(); ws.close(); },
  };
  const t = token ?? auth.issue({ sub: `user-${label}`, ...(name ? { name } : {}), room, ...(scope ? { scope } : {}), exp: now() + 600 });
  ws.send(JSON.stringify({ type: 'hello', room, clientId: `${label}-${randomBytes(4).toString('hex')}`, name: helloName, engine: ENGINE_FINGERPRINT, token: t }));
  const w = await c.next();
  assert.equal(w.type, 'welcome', `${label}: ${JSON.stringify(w)}`);
  c.seq = w.seq;
  c.name = w.user.name;
  c.doc = new wasm.HwpDocument(gunzipSync(Buffer.from(w.base, 'base64')));
  c.engine = new CollabEngine({ onLocal() {}, onWarn() {} });
  c.engine.attach(c.doc);
  if (w.log.length) c.engine.replayAll(w.log);
  return c;
}
const op = (m, a) => ({ kind: 'op', m, a, ...(['insertMemo', 'insertMemoByPath', 'insertMemoReply'].includes(m) ? { ctx: { memoTime: MEMO_TIME } } : {}) });
function stateAfter(c, edit) {
  const d = new wasm.HwpDocument(gunzipSync(Buffer.from(c.doc.collabExportState())));
  edit(d);
  const entry = { kind: 'state', data: b64(d.collabExportState()) };
  d.free();
  return entry;
}
async function canonical(room) {
  const r = server.rooms.get(room);
  await server.settle(room);
  return { seq: r.seq, digest: (await r.canonical.digest()).digest };
}
async function rejected(room, sender, watcher, entries, label) {
  const before = await canonical(room);
  const { res, batchId } = await sender.ops(entries);
  assert.deepEqual(res, { type: 'forbidden', what: 'ops', reason: 'author', batchId }, label);
  const after = await canonical(room);
  assert.deepEqual(after, before, `${label}: seq·정본 그대로`);
  await watcher.silent();
}
async function accepted(room, sender, watcher, entries, label) {
  const { res } = await sender.ops(entries);
  assert.equal(res.type, 'ops', `${label}: ${JSON.stringify(res)}`);
  const got = await watcher.next();
  assert.equal(got.seq, res.seq, label);
  watcher.seq = got.seq;
  watcher.apply(got);
  const canon = await canonical(room);
  assert.equal(watcher.doc.collabDigest(), canon.digest, `${label}: 지켜보는 참여자 digest = 정본`);
}

/** W(edit)가 결과 전송으로 메모 둘을 만든다 — 작성자 W 와 C(편집 권한자의 state 는 작성자를 확인할 수 없다, D6) */
async function seedMemos(room, W, others) {
  await accepted(room, W, others[0], [stateAfter(W, (d) => {
    d.insertMemo(0, 0, 0, 3, memoJson('W', 'W 의 메모'));
    d.insertMemo(0, 0, 10, 13, memoJson('C', 'C 의 메모'));
  })], 'W 가 state 로 메모 둘');
  for (const o of others.slice(1)) { const got = await o.next(); o.seq = got.seq; o.apply(got); }
  const memos = W.memos();
  return { mineOfW: memos.find((m) => m.author === 'W').id, mineOfC: memos.find((m) => m.author === 'C').id };
}

test('메모 만들기 op 의 작성자 = 연결의 이름 — 다르면 모든 권한에서 forbidden(author), 정본 전에', async () => {
  const { room, invite } = await makeRoom();
  const W = await client(room, 'W');
  const E = await client(room, 'E');
  const C = await client(room, 'C', { scope: 'comment' });
  const G = await client(room, 'G', { token: invite.comment, helloName: '손님가' });
  assert.equal(G.name, '손님가', '초대 토큰은 hello 의 이름');
  await rejected(room, E, W, [op('insertMemo', [0, 0, 0, 2, memoJson('X')])], 'edit: 다른 작성자');
  await rejected(room, E, W, [op('insertMemo', [0, 0, 0, 2, '{not json'])], 'edit: 작성자를 읽을 수 없음');
  await rejected(room, E, W, [op('insertMemo', [0, 0, 0, 2, JSON.stringify({ text: '작성자 없음' })])], 'edit: 작성자 없음');
  await rejected(room, E, W, [op('insertMemoReply', [1, memoJson('W')])], 'edit: 답글의 다른 작성자');
  await rejected(room, E, W, [op('insertMemoByPath', [0, 0, '[]', 0, 2, memoJson('W')])], 'edit: 경로 메모의 다른 작성자');
  await rejected(room, C, W, [op('insertMemo', [0, 0, 0, 2, memoJson('E')])], 'comment: 다른 작성자');
  await rejected(room, G, W, [op('insertMemo', [0, 0, 0, 2, memoJson('C')])], '초대 comment: 다른 작성자');
  await rejected(room, E, W, [op('insertText', [0, 0, 0, '앞 ']), op('insertMemo', [0, 0, 0, 2, memoJson('W')])], 'edit: 다른 편집과 섞여도 묶음 전체');
  for (const c of [W, E, C, G]) c.close();
});

test('메모 만들기 op 의 작성자가 맞으면 통과(edit·comment·초대 토큰)', { skip: NEEDS_PROMOTION }, async () => {
  const { room, invite } = await makeRoom();
  const W = await client(room, 'W');
  const E = await client(room, 'E');
  const C = await client(room, 'C', { scope: 'comment' });
  const G = await client(room, 'G', { token: invite.comment, helloName: '손님가' });
  const sync = async (sender, entries, label) => {
    await accepted(room, sender, W, entries, label);
    for (const o of [E, C, G].filter((x) => x !== sender)) { const got = await o.next(); o.seq = got.seq; o.apply(got); }
  };
  await sync(E, [op('insertMemo', [0, 0, 0, 2, memoJson('E', 'E 의 메모')])], 'edit');
  await sync(C, [op('insertMemo', [0, 0, 5, 7, memoJson('C', 'C 의 메모')])], 'comment');
  await sync(G, [op('insertMemo', [0, 0, 10, 12, memoJson('손님가', '손님 메모')])], '초대 comment');
  const first = W.memos().find((m) => m.author === 'E').id;
  await sync(C, [op('insertMemoReply', [first, memoJson('C', '답글')])], 'comment 는 누구의 메모에나 답글');
  assert.deepEqual(W.memos().map((m) => m.author).sort(), ['C', 'C', 'E', '손님가']);
  for (const c of [W, E, C, G]) c.close();
});

test('comment 는 남의 메모를 고치거나 지울 수 없다 — forbidden(author)', async () => {
  const { room } = await makeRoom();
  const W = await client(room, 'W');
  const C = await client(room, 'C', { scope: 'comment' });
  const { mineOfW, mineOfC } = await seedMemos(room, W, [C]);
  await rejected(room, C, W, [op('setMemoText', [mineOfW, '남의 메모 고치기'])], 'comment: 남의 메모 본문');
  await rejected(room, C, W, [op('removeMemo', [mineOfW])], 'comment: 남의 메모 지우기');
  await rejected(room, C, W, [op('setMemoText', [mineOfC, '자기 것']), op('removeMemo', [mineOfW])], 'comment: 자기 메모와 남의 메모를 섞은 묶음');
  W.close(); C.close();
});

test('메모 모양(setMemoShape)은 edit 전용 — comment 는 막힌다', { skip: !SHAPE_EDIT_ONLY && '분류표에서 setMemoShape 가 아직 perm memo(edit 전용 정정이 합쳐진 뒤에 돈다)' }, async () => {
  const { room } = await makeRoom();
  const W = await client(room, 'W');
  const C = await client(room, 'C', { scope: 'comment' });
  const before = await canonical(room);
  const { res } = await C.ops([op('setMemoShape', [0, SHAPE])]);
  assert.equal(res.type, 'forbidden', JSON.stringify(res));
  assert.deepEqual(await canonical(room), before);
  await W.silent();
  W.close(); C.close();
});

test('comment 는 자기 메모를 고치고 지운다, edit 는 모든 메모를', { skip: NEEDS_PROMOTION }, async () => {
  const { room } = await makeRoom();
  const W = await client(room, 'W');
  const C = await client(room, 'C', { scope: 'comment' });
  const E = await client(room, 'E');
  const { mineOfW, mineOfC } = await seedMemos(room, W, [C, E]);
  const sync = async (sender, entries, label) => {
    await accepted(room, sender, W, entries, label);
    for (const o of [C, E].filter((x) => x !== sender)) { const got = await o.next(); o.seq = got.seq; o.apply(got); }
  };
  await sync(C, [op('setMemoText', [mineOfC, '자기 메모 고침'])], 'comment: 자기 메모 본문');
  await sync(E, [op('setMemoText', [mineOfW, 'edit 가 고침'])], 'edit: 남의 메모 본문');
  await sync(C, [op('removeMemo', [mineOfC])], 'comment: 자기 메모 지우기');
  await sync(E, [op('removeMemo', [mineOfW])], 'edit: 남의 메모 지우기');
  await sync(E, [op('setMemoShape', [0, SHAPE])], 'edit: 메모 모양');
  W.close(); C.close(); E.close();
});

test('입장 이름: hello 때 rhwp 작성자 규칙으로 다듬은 이름 — 그 이름으로 메모 넣기·자기 메모 고치기 통과, 다듬기 전 이름은 거절', { skip: NEEDS_PROMOTION }, async () => {
  const { room, invite } = await makeRoom();
  const W = await client(room, 'W');
  // 토큰의 name 에 / · ; 와 앞뒤 공백
  const S = await client(room, 'S', { name: '  김/철;수 ', scope: 'comment' });
  assert.equal(S.name, '김철수', 'welcome.user.name = 입장 이름');
  // 초대 토큰(이름 없음) + hello 이름 65 UTF-16 단위(마지막 글자가 서로게이트 쌍 — 가르지 않고 뺀다)
  const long = `${'가'.repeat(63)}😀`;
  assert.equal(long.length, 65);
  const L = await client(room, 'L', { token: invite.comment, helloName: long });
  assert.equal(L.name, '가'.repeat(63), '64 단위 안으로, 서로게이트를 가르지 않음');
  const sync = async (sender, entries, label) => {
    await accepted(room, sender, W, entries, label);
    for (const o of [S, L].filter((x) => x !== sender)) { const got = await o.next(); o.seq = got.seq; o.apply(got); }
  };
  await rejected(room, S, W, [op('insertMemo', [0, 0, 0, 2, memoJson('  김/철;수 ')])], '다듬기 전 토큰 이름');
  await rejected(room, L, W, [op('insertMemo', [0, 0, 0, 2, memoJson(long)])], '다듬기 전 hello 이름');
  await sync(S, [op('insertMemo', [0, 0, 0, 2, memoJson('김철수', 'S 메모')])], '입장 이름으로 메모');
  await sync(L, [op('insertMemo', [0, 0, 5, 7, memoJson(L.name, 'L 메모')])], '긴 이름(다듬은 것)으로 메모');
  const memos = W.memos();
  assert.deepEqual(memos.map((m) => m.author).sort(), ['가'.repeat(63), '김철수'], 'rhwp 가 저장한 작성자 = 입장 이름');
  await sync(S, [op('setMemoText', [memos.find((m) => m.author === '김철수').id, '고침'])], '입장 이름으로 자기 메모 고치기');
  await sync(L, [op('removeMemo', [memos.find((m) => m.author === L.name).id])], '긴 이름으로 자기 메모 지우기');
  // 커서 이름도 입장 이름
  S.send({ type: 'cursor', seq: S.seq, caret: null });
  const cur = await W.next();
  assert.deepEqual([cur.type, cur.name], ['cursor', '김철수']);
  for (const c of [W, S, L]) c.close();
});
