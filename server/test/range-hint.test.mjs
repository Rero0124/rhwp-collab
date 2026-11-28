// 4단계 U3 범위 표시가 붙은 state(docs/collab-stage4.md §6): 보낸 쪽이 "구역 section 의 [lo, lo+before) 를 after 개 문단으로
// 바꿨다"고 표시한 state 를 정본이 확인한다 — 범위 밖이 적용 전과 같아야 기록·방송한다(S1 다시 쓰기 뒤에도 표시는 남는다).
// 거짓 표시는 invalid {reason: 'range'}, seq 그대로. 받는 쪽은 그 state 를 범위의 구조 편집으로 보고 보정하므로, 거짓 표시가
// 지나가면 다른 참여자의 미확정을 잘못 옮기게 된다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { startServer } from '../server.mjs';
import { DEFAULT_PKG } from '../canonical.mjs';
import { LocalDocStore } from '../doc-store.mjs';
import { hs256Auth } from '../auth.mjs';
import { CollabEngine } from '../../collab-client/src/engine/engine.ts';
import { ENGINE_FINGERPRINT } from '../../collab-client/src/engine/catalog.ts';

const wasm = await import(pathToFileURL(`${DEFAULT_PKG}/rhwp.js`).href);
wasm.initSync({ module: readFileSync(`${DEFAULT_PKG}/rhwp_bg.wasm`) });
const SUPPORTED = typeof wasm.HwpDocument.prototype.collabCheckRangeHint === 'function';

const auth = hs256Auth(randomBytes(32).toString('base64url'));
const now = () => Math.floor(Date.now() / 1000);
/** 문단 5개(p0…p4) */
function fiveParagraphs() {
  const d = wasm.HwpDocument.createEmpty();
  d.createBlankDocument();
  for (let i = 0; i < 5; i += 1) {
    if (i > 0) d.splitParagraph(0, i - 1, d.getParagraphLength(0, i - 1));
    d.insertText(0, i, 0, `p${i}`);
  }
  const raw = gunzipSync(Buffer.from(d.collabExportState()));
  d.free();
  return raw;
}
const DOC = fiveParagraphs();
const dirs = [];
let server;
let lines;
before(async () => {
  lines = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'cc-rhwp-u3-'));
  dirs.push(dir);
  server = startServer({ port: 0, log: (m) => lines.push(m), delayMs: 0, auth, store: new LocalDocStore(dir) });
  await server.ready;
});
after(async () => { await server?.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function makeRoom() {
  const res = await fetch(`http://127.0.0.1:${server.port}/rooms`, {
    method: 'POST', body: DOC, headers: { authorization: `Bearer ${auth.issue({ sub: 'admin', room: '*', scope: 'create', exp: now() + 600 })}` },
  });
  assert.equal(res.status, 201);
  return res.json();
}

/** 원시 클라이언트: 받은 묶음을 기록하지 않는 엔진으로 자기 문서에 재생한다(보내는 것은 손으로 만든 기록). */
async function client(room, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => { const m = JSON.parse(String(data)); const w = waiters.shift(); if (w) w(m); else queue.push(m); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const c = {
    seq: 0, batch: 0,
    next: (ms = 15_000) => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name}: 메시지 없음`)), ms);
      waiters.push((m) => { clearTimeout(timer); resolve(m); });
    })),
    silent: async (ms = 200) => { await new Promise((r) => setTimeout(r, ms)); assert.deepEqual(queue, [], `${name}: 예상 밖 메시지`); },
    ops: async (entries) => {
      ws.send(JSON.stringify({ type: 'ops', base: c.seq, entries, batchId: `${name}:${++c.batch}` }));
      const res = await c.next();
      if (res.type === 'ops') { c.seq = res.seq; c.apply(res); }
      return res;
    },
    apply: (msg) => c.engine.replayAll([{ seq: msg.seq, clientId: msg.clientId, entries: msg.entries }]),
    close: () => { c.engine.detach(); c.doc.free(); ws.close(); },
  };
  ws.send(JSON.stringify({ type: 'hello', room, clientId: `${name}-${randomBytes(3).toString('hex')}`, name, engine: ENGINE_FINGERPRINT, token: auth.issue({ sub: `u-${name}`, name, room, exp: now() + 600 }) }));
  const w = await c.next();
  assert.equal(w.type, 'welcome');
  c.seq = w.seq;
  c.doc = new wasm.HwpDocument(gunzipSync(Buffer.from(w.base, 'base64')));
  c.engine = new CollabEngine({ onLocal() {}, onWarn() {} });
  c.engine.attach(c.doc);
  if (w.log.length) c.engine.replayAll(w.log);
  return c;
}
async function canonicalDigest(room) { await server.settle(room); return (await server.rooms.get(room).canonical.digest()).digest; }

/** E 가 문단 1 끝에 표를 만들고(op), 그 뒤 범위 복원으로 표를 없앤 state 와 그 범위 표시 */
async function tableThenRangeRestore(E) {
  const snap = E.doc.saveSnapshot();
  const n0 = E.doc.getParagraphCount(0);
  const off = E.doc.getParagraphLength(0, 1);
  const ack = await E.ops([{ kind: 'op', m: 'createTable', a: [0, 1, off, 2, 2] }]);
  assert.equal(ack.type, 'ops');
  const pd = E.doc.getParagraphCount(0) - n0;
  const spec = { section: 0, src: { lo: 1, n: 1 }, dst: { lo: 1, n: 1 + pd } };
  E.doc.collabUndoRecipeDiscard(E.doc.collabUndoRestoreRange(snap, JSON.stringify(spec)));
  E.doc.discardSnapshot(snap);
  return { data: Buffer.from(E.doc.collabExportState()).toString('base64'), range: { section: 0, lo: 1, before: 1 + pd, after: 1 } };
}

test('참인 범위 표시: 기록·방송되고 S1 다시 쓰기 뒤에도 range 가 남는다, 모든 참여자·정본 digest 같음', { skip: !SUPPORTED && '범위 확인 보조가 없는 빌드' }, async () => {
  const { room } = await makeRoom();
  const W = await client(room, 'W');
  const E = await client(room, 'E');
  const { data, range } = await tableThenRangeRestore(E);
  const table = await W.next();
  W.apply(table);
  W.seq = table.seq;
  const ack = await E.ops([{ kind: 'state', data, range }]);
  assert.equal(ack.type, 'ops', JSON.stringify(ack).slice(0, 200));
  assert.equal(ack.replaced, true);
  assert.deepEqual(ack.entries[0].range, range, '보낸 쪽 ack 에 범위 표시');
  const got = await W.next();
  assert.deepEqual(got.entries[0].range, range, '방송에 범위 표시');
  W.apply(got);
  const canon = await canonicalDigest(room);
  assert.equal(W.doc.collabDigest(), canon);
  assert.equal(E.doc.collabDigest(), canon);
  const texts = Array.from({ length: W.doc.getParagraphCount(0) }, (_, i) => W.doc.getTextRange(0, i, 0, W.doc.getParagraphLength(0, i)));
  assert.deepEqual(texts, ['p0', 'p1', 'p2', 'p3', 'p4'], '표만 빠짐');
  W.close(); E.close();
});

test('거짓 범위 표시를 단 원시 클라이언트: invalid range, seq 그대로, 방송 없음', { skip: !SUPPORTED && '범위 확인 보조가 없는 빌드' }, async () => {
  const { room } = await makeRoom();
  const W = await client(room, 'W');
  const X = await client(room, 'X');
  const seq = server.rooms.get(room).seq;
  // 문단 0 을 고친 문서를 "문단 3 만 바꿨다"고 주장
  const d = new wasm.HwpDocument(gunzipSync(Buffer.from(X.doc.collabExportState())));
  d.insertText(0, 0, 0, '몰래 ');
  const data = Buffer.from(d.collabExportState()).toString('base64');
  d.free();
  const res = await X.ops([{ kind: 'state', data, range: { section: 0, lo: 3, before: 1, after: 1 } }]);
  assert.equal(res.type, 'invalid');
  assert.equal(res.reason, 'range');
  assert.equal(server.rooms.get(room).seq, seq, 'seq 그대로');
  await W.silent();
  assert.ok(lines.some((l) => l.includes('invalid') && l.includes('range')), '서버 기록');
  // 같은 바이트를 범위 표시 없이 보내면(보통 state) 받아들인다 — 확인은 표시가 있을 때만
  const ok = await X.ops([{ kind: 'state', data }]);
  assert.equal(ok.type, 'ops');
  W.close(); X.close();
});

test('범위 표시 모양이 틀리면(다른 키·0 문단) 형식 오류로 거절', async () => {
  const { room } = await makeRoom();
  const X = await client(room, 'X');
  const data = Buffer.from(X.doc.collabExportState()).toString('base64');
  for (const range of [{ section: 0, lo: 0, before: 1, after: 1, extra: 1 }, { section: 0, lo: 0, before: 0, after: 1 }, { section: -1, lo: 0, before: 1, after: 1 }, 'x']) {
    const res = await X.ops([{ kind: 'state', data, range }]);
    assert.equal(res.type, 'invalid', JSON.stringify(range));
    assert.match(res.reason, /range 형식/);
  }
  X.close();
});
