// 6단계 결과 다시 쓰기 강화(결정 3, docs/collab-stage6.md): op 인자로 들어오는 날 바이트 문 — 서버 정본 워커가 op 를 적용하기
// 전에 collab-core `collabCheckOpArgs` 로 본다. 문단 나누기의 removedParaMeta.raw_header_extra 는 문단 머리 꼬리라 사양
// 길이(0·10·12)만 받는다. 결과(state) 다시 쓰기로는 막지 못한다 — op 는 모든 참여자가 그대로 적용한다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { startServer } from '../server.mjs';
import { DEFAULT_PKG } from '../canonical.mjs';
import { CollabEngine } from '../../collab-client/src/engine/engine.ts';
import { ENGINE_FINGERPRINT } from '../../collab-client/src/engine/catalog.ts';

const wasm = await import(pathToFileURL(`${DEFAULT_PKG}/rhwp.js`).href);
wasm.initSync({ module: readFileSync(`${DEFAULT_PKG}/rhwp_bg.wasm`) });
const HAS_GATE = typeof wasm.HwpDocument.prototype.collabCheckOpArgs === 'function';

function blankDocument() {
  const d = wasm.HwpDocument.createEmpty();
  d.createBlankDocument();
  d.insertText(0, 0, 0, '문단을 나눌 시험 문서');
  const raw = gunzipSync(Buffer.from(d.collabExportState()));
  d.free();
  return raw;
}
const DOC = blankDocument();

let server;
before(async () => {
  server = startServer({ port: 0, log: () => {}, delayMs: 0 });
  await server.ready;
});
after(async () => { await server?.close(); });

async function makeRoom() {
  const res = await fetch(`http://127.0.0.1:${server.port}/rooms`, { method: 'POST', body: DOC });
  assert.equal(res.status, 201);
  return (await res.json()).room;
}

async function client(room, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => { const m = JSON.parse(String(data)); const w = waiters.shift(); if (w) w(m); else queue.push(m); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const next = (ms = 15_000) => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: 메시지 없음`)), ms);
    waiters.push((m) => { clearTimeout(timer); resolve(m); });
  }));
  const c = { seq: 0, batch: 0, next, close: () => ws.close() };
  c.ops = async (entries) => {
    const batchId = `${name}:${++c.batch}`;
    ws.send(JSON.stringify({ type: 'ops', base: c.seq, entries, batchId }));
    const res = await next();
    if (res.type === 'ops') c.seq = res.seq;
    return res;
  };
  ws.send(JSON.stringify({ type: 'hello', room, clientId: `${name}-${randomBytes(3).toString('hex')}`, name, engine: ENGINE_FINGERPRINT }));
  const w = await next();
  assert.equal(w.type, 'welcome');
  c.seq = w.seq;
  return c;
}

/** 병합 되돌리기가 싣는 문단 메타(removedParaMeta) — 문단 머리 꼬리 길이만 바꾼다 */
const meta = (n) => JSON.stringify({ para_shape_id: 0, style_id: 0, column_type: 'None', raw_break_type: 0, numbering_restart: null, raw_header_extra: Array(n).fill(0), tab_extended: [] });
const split = (n) => ({ kind: 'op', m: 'splitParagraph', a: [0, 0, 2, meta(n)] });

test('op 인자 문: 문단 머리 꼬리가 사양 길이가 아닌 removedParaMeta 는 invalid, 정본은 그대로 / 사양 길이는 받는다', { skip: !HAS_GATE && 'collabCheckOpArgs 가 아직 없다' }, async () => {
  const room = await makeRoom();
  const A = await client(room, 'A');
  const before = (await server.rooms.get(room).canonical.digest()).digest;
  const bad = await A.ops([split(64)]);
  assert.equal(bad.type, 'invalid');
  assert.match(bad.reason, /raw_header_extra 길이 64/);
  assert.equal((await server.rooms.get(room).canonical.digest()).digest, before, '정본은 적용하지 않았다');
  // 사양 길이(10)는 그대로 받는다 — 같은 묶음을 다시 보내도 된다(앞의 invalid 는 seq 를 바꾸지 않았다)
  const ok = await A.ops([split(10)]);
  assert.equal(ok.type, 'ops');
  const plain = await A.ops([{ kind: 'op', m: 'splitParagraph', a: [0, 1, 1] }]);
  assert.equal(plain.type, 'ops', '메타 없는 보통 Enter');
  A.close();
});

test('정본 워커는 문서를 열자마자 본 바이트 기록을 켠다(collabTrackRawSeen) — 엔진이 붙은 정본과 같은 경로', { skip: !HAS_GATE && '보조가 없다' }, () => {
  const d = new wasm.HwpDocument(DOC);
  const engine = new CollabEngine({ onLocal() {}, onWarn() {} });
  engine.attach(d);
  d.collabTrackRawSeen();
  assert.equal(JSON.parse(d.collabCheckOpArgs('splitParagraph', JSON.stringify([0, 0, 1, meta(12)]))).ok, true);
  assert.equal(JSON.parse(d.collabCheckOpArgs('splitParagraph', JSON.stringify([0, 0, 1, meta(13)]))).ok, false);
  engine.detach();
  d.free();
});
