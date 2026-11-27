// 5단계 D4 관문의 서버 단 우회 시험: 클라이언트 문을 거치지 않는 원시 WebSocket 클라이언트가 좁은 권한(view·form·
// comment) 토큰으로 편집을 보낸다. 서버 정본은 함수 이름·state 바이트를 믿지 않고 결과로 판정한다(collabCheckConfined).
//   거절: forbidden(그 권한 밖) — seq 그대로, 정본 digest 그대로, 다른 참여자에게 방송 없음
//   통과: 다른 참여자에게 방송되고, 그 참여자가 재생한 digest 가 정본과 같다
// 실제 rhwp WASM 과 엔진으로 돈다 — scripts/build-wasm.sh 가 먼저다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { startServer } from '../server.mjs';
import { DEFAULT_PKG } from '../canonical.mjs';
import { hs256Auth } from '../auth.mjs';
import { CollabEngine } from '../../collab-client/src/engine/engine.ts';
import { ENGINE_FINGERPRINT } from '../../collab-client/src/engine/catalog.ts';

const wasm = await import(pathToFileURL(`${DEFAULT_PKG}/rhwp.js`).href);
wasm.initSync({ module: readFileSync(`${DEFAULT_PKG}/rhwp_bg.wasm`) });

const auth = hs256Auth(randomBytes(32).toString('base64url')); // 시험 안에서만 쓰는 비밀키
const now = () => Math.floor(Date.now() / 1000);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/**
 * 양식 문서: 본문 "이름: [누름틀 abc] 끝". 누름틀 이름 name, 값 abc(본문 문단 0, 글자 4..7).
 * 반환: 원본 바이트와, 그 문서에서 누름틀 안(글자 5)에 캐럿을 둘 때의 activeField.
 */
function formDocument() {
  const d = wasm.HwpDocument.createEmpty();
  d.createBlankDocument();
  d.insertText(0, 0, 0, '이름:  끝');
  JSON.parse(d.insertClickHereField(0, 0, 4, '이름', '', 'name', true));
  JSON.parse(d.setFieldValueByName('name', 'abc'));
  const raw = gunzipSync(Buffer.from(d.collabExportState()));
  d.free();
  const r = new wasm.HwpDocument(raw);
  assert.equal(r.setActiveField(0, 0, 5), true, '누름틀 안에 캐럿');
  const activeField = JSON.parse(r.collabGetActiveField());
  r.free();
  return { raw, activeField };
}
const FORM = formDocument();

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
    method: 'POST', body: FORM.raw,
    headers: { authorization: `Bearer ${auth.issue({ sub: 'admin', room: '*', scope: 'create', exp: now() + 600 })}` },
  });
  assert.equal(res.status, 201);
  return res.json();
}

/** 원시 클라이언트. 문서 사본(replica)을 들고 받은 묶음을 엔진으로 재생한다(다른 참여자의 digest 확인용). */
async function client(room, name, scope) {
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
    ws, name, seq: 0, doc: null, engine: null, batch: 0,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (ms = 15_000) => {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${name}: 메시지 없음`)), ms);
        waiters.push((m) => { clearTimeout(timer); resolve(m); });
      });
    },
    silent: async (ms = 300) => {
      await new Promise((r) => setTimeout(r, ms));
      assert.deepEqual(queue.filter((m) => m.type !== 'cursor'), [], `${name}: 예상 밖 메시지`);
    },
    /** 묶음 보내기 → 답 하나 */
    ops: async (entries) => {
      const batchId = `${name}:${++c.batch}`;
      c.send({ type: 'ops', base: c.seq, entries, batchId });
      const res = await c.next();
      if (res.type === 'ops') { c.seq = res.seq; c.apply(res); }
      return { res, batchId };
    },
    /** 받은 묶음을 사본에 재생한다 */
    apply: (msg) => { c.engine.replayAll([{ seq: msg.seq, clientId: msg.clientId, entries: msg.entries }]); },
    digest: () => c.doc.collabDigest(),
    close: () => { c.engine?.detach(); c.doc?.free(); ws.close(); },
  };
  const token = auth.issue({ sub: `user-${name}`, name, room, ...(scope ? { scope } : {}), exp: now() + 600 });
  c.send({ type: 'hello', room, clientId: `${name}-${randomBytes(4).toString('hex')}`, name, engine: ENGINE_FINGERPRINT, token });
  const w = await c.next();
  assert.equal(w.type, 'welcome', `${name}: ${JSON.stringify(w)}`);
  c.seq = w.seq;
  c.user = w.user;
  c.doc = new wasm.HwpDocument(gunzipSync(Buffer.from(w.base, 'base64')));
  c.engine = new CollabEngine({ onLocal() {}, onWarn() {} });
  c.engine.attach(c.doc);
  if (w.log.length) c.engine.replayAll(w.log);
  return c;
}

/** 사본 문서에서 편집한 뒤 내보낸 state 기록(정상 클라이언트가 결과 전송으로 보내는 것과 같다) */
function stateAfter(c, edit) {
  const d = new wasm.HwpDocument(gunzipSync(Buffer.from(c.doc.collabExportState())));
  edit(d);
  const entry = { kind: 'state', data: b64(d.collabExportState()) };
  d.free();
  return entry;
}
const op = (m, a, extra = {}) => ({ kind: 'op', m, a, ...extra });

/**
 * 복합 파일(CFB) 안 스트림 하나의 바이트 위치들 — 길이가 같은 제자리 고치기용(원시 클라이언트가 보낼 수 있는 바이트를
 * 만든다). FAT·작은 FAT 사슬을 따라간다.
 */
function cfbStreamOffsets(buf, name) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (o) => dv.getUint32(o, true);
  const sectorSize = 1 << dv.getUint16(0x1e, true);
  const miniSize = 1 << dv.getUint16(0x20, true);
  const at = (sid) => (sid + 1) * sectorSize;
  const fatSectors = [];
  for (let i = 0; i < 109; i += 1) { const sid = u32(0x4c + i * 4); if (sid >= 0xfffffffa) break; fatSectors.push(sid); }
  const next = (table, sid) => u32(at(table[Math.floor((sid * 4) / sectorSize)]) + ((sid * 4) % sectorSize));
  const chain = (start, table = fatSectors) => { const out = []; for (let sid = start; sid < 0xfffffffa; sid = next(table, sid)) out.push(sid); return out; };
  const entries = chain(u32(0x30)).flatMap((sid) => Array.from({ length: sectorSize / 128 }, (_, k) => at(sid) + k * 128));
  const nameOf = (o) => Buffer.from(buf.subarray(o, o + Math.max(0, dv.getUint16(o + 0x40, true) - 2))).toString('utf16le');
  const entry = entries.find((o) => buf[o + 0x42] === 2 && nameOf(o) === name);
  assert.ok(entry !== undefined, `스트림 ${name} 없음`);
  const [start, size] = [u32(entry + 0x74), u32(entry + 0x78)];
  if (size >= u32(0x38)) {
    const sectors = chain(start);
    return Array.from({ length: size }, (_, i) => at(sectors[Math.floor(i / sectorSize)]) + (i % sectorSize));
  }
  const miniStream = chain(u32(entries[0] + 0x74));
  const minis = chain(start, chain(u32(0x3c)));
  return Array.from({ length: size }, (_, i) => {
    const pos = minis[Math.floor(i / miniSize)] * miniSize + (i % miniSize);
    return at(miniStream[Math.floor(pos / sectorSize)]) + (pos % sectorSize);
  });
}

/** 사본에서 고친 뒤 내보낸 바이트의 스트림 하나를 같은 길이로 바꿔 끼운 state 기록 */
function forgedState(c, edit, stream, text) {
  const d = new wasm.HwpDocument(gunzipSync(Buffer.from(c.doc.collabExportState())));
  edit(d);
  const bytes = Buffer.from(gunzipSync(Buffer.from(d.collabExportState())));
  d.free();
  const offsets = cfbStreamOffsets(bytes, stream);
  const fill = Buffer.from(text.padEnd(offsets.length, ' ')).subarray(0, offsets.length);
  offsets.forEach((o, i) => { bytes[o] = fill[i]; });
  return { kind: 'state', data: b64(gzipSync(bytes)) };
}

/** 정본의 지금 seq·digest(정본 워커에 직접 묻는다) */
async function canonical(room) {
  const r = server.rooms.get(room);
  await server.settle(room);
  return { seq: r.seq, digest: (await r.canonical.digest()).digest };
}

/** 거절 확인: forbidden(reason), seq·정본 digest 그대로, 지켜보는 참여자에게 방송 없음 */
async function rejected(room, sender, watcher, entries, reason, label) {
  const before = await canonical(room);
  const { res, batchId } = await sender.ops(entries);
  assert.deepEqual(res, { type: 'forbidden', what: 'ops', reason, batchId }, label);
  const afterState = await canonical(room);
  assert.equal(afterState.seq, before.seq, `${label}: seq 그대로`);
  assert.equal(afterState.digest, before.digest, `${label}: 정본 digest 그대로`);
  await watcher.silent();
}

/** 통과 확인: 보낸 쪽 확정, 지켜보는 참여자에게 방송, 그 참여자의 digest = 정본 digest */
async function accepted(room, sender, watcher, entries, label) {
  const { res } = await sender.ops(entries);
  assert.equal(res.type, 'ops', `${label}: ${JSON.stringify(res)}`);
  const got = await watcher.next();
  assert.equal(got.type, 'ops', label);
  assert.equal(got.seq, res.seq, label);
  watcher.seq = got.seq;
  watcher.apply(got);
  const canon = await canonical(room);
  assert.equal(canon.seq, got.seq, label);
  assert.equal(watcher.digest(), canon.digest, `${label}: 지켜보는 참여자 digest = 정본`);
  assert.equal(sender.digest(), canon.digest, `${label}: 보낸 쪽 사본 digest = 정본`);
}

test('form: 누름틀 값·누름틀 안 입력은 통과하고 다른 참여자와 정본이 같다', async () => {
  const { room } = await makeRoom();
  const W = await client(room, 'W');
  const F = await client(room, 'F', 'form');
  assert.deepEqual(F.user.scope, ['form']);
  await accepted(room, F, W, [op('setFieldValueByName', ['name', '홍길동'])], '누름틀 값(setFieldValueByName)');
  F.doc.setActiveField(0, 0, 5);
  const inside = JSON.parse(F.doc.collabGetActiveField());
  await accepted(room, F, W, [op('insertText', [0, 0, 5, '씨'], { meta: { len: 1 }, ctx: { activeField: inside } })], '누름틀 안 입력(insertText + activeField)');
  W.close(); F.close();
});

test('form: 우회(함수 이름·state 바이트 위조, 기존 글자 모양 고치기)는 forbidden(confined), seq·정본 그대로, 방송 없음', async () => {
  const { room } = await makeRoom();
  const W = await client(room, 'W');
  const F = await client(room, 'F', 'form');
  const fake = { activeField: FORM.activeField };
  // 함수 이름 위조 1: 누름틀 밖 본문 입력에 진짜 누름틀의 activeField 를 붙임
  await rejected(room, F, W, [op('insertText', [0, 0, 0, '위조'], { meta: { len: 2 }, ctx: fake })], 'confined', '누름틀 밖 insertText + 가짜 activeField');
  // 함수 이름 위조 2: 양식 함수(setFormValue)에 누름틀이 아닌 본문 개체·텍스트를 고치는 인자
  const ci = FORM.activeField.control;
  await rejected(room, F, W, [op('setFormValue', [0, 0, ci, JSON.stringify({ text: '본문을 고침' })]), op('insertText', [0, 0, 0, 'X'], { meta: { len: 1 } })], 'confined', 'setFormValue 뒤에 본문 입력을 섞은 묶음');
  // state 바이트 위조: 본문을 바꾼 문서를 state 로
  await rejected(room, F, W, [stateAfter(F, (d) => d.insertText(0, 0, 0, '위조 '))], 'confined', 'state 로 본문 바꾸기');
  // state 로 누름틀 값과 본문을 함께(값만 바꾼 척)
  await rejected(room, F, W, [stateAfter(F, (d) => { d.setFieldValueByName('name', '척'); d.insertText(0, 0, 0, '덤 '); })], 'confined', 'state 로 누름틀 값 + 본문');
  // 기존 글자 모양 고치기: 스타일의 글자 모양 정의를 바꿔 본문 모양을 바꾼다(op), 본문 글자를 다른 기존 모양으로(op)
  await rejected(room, F, W, [op('updateStyleShapes', [0, JSON.stringify({ bold: true, fontSize: 2000 }), '{}'])], 'confined', '스타일 글자 모양 정의 고치기(updateStyleShapes)');
  await rejected(room, F, W, [op('applyCharFormat', [0, 0, 0, 2, JSON.stringify({ bold: true })])], 'confined', '본문 글자 모양 바꾸기(applyCharFormat)');
  await rejected(room, F, W, [stateAfter(F, (d) => d.applyCharFormat(0, 0, 0, 2, JSON.stringify({ italic: true })))], 'confined', 'state 로 본문 글자 모양');
  // form 으로 메모
  await rejected(room, F, W, [stateAfter(F, (d) => d.insertMemo(0, 0, 0, 2, JSON.stringify({ author: 'F', text: '메모' })))], 'confined', 'form 으로 메모 넣기');
  await rejected(room, F, W, [memoOp(F, [0, 0, 0, 2], '메모')], 'confined', 'form 으로 메모 넣기(op)');
  // 거절 뒤에도 통과 사례는 그대로 된다
  await accepted(room, F, W, [op('setFieldValueByName', ['name', '거절 뒤'])], '거절 뒤 누름틀 값');
  W.close(); F.close();
});

// 메모 함수는 op 다(2026-11-27 승격 — 메모를 만드는 호출은 기록 쪽이 정한 작성 시각을 ctx.memoTime 으로 담는다).
// 정상 클라이언트는 작성자를 세션 이름으로 넣는다(D6). 아래 state 거절 사례는 결과 전송 판정(정규화 포함)을 본다.
const MEMO_TIME = '134000000000000000';
const memoOp = (c, a, text) => op('insertMemo', [...a, JSON.stringify({ author: c.name, text })], { ctx: { memoTime: MEMO_TIME } });

test('comment: 본문·누름틀·메모에 본문을 섞은 state 는 forbidden(confined)', async () => {
  const { room } = await makeRoom();
  const W = await client(room, 'W');
  const C = await client(room, 'C', 'comment');
  await rejected(room, C, W, [op('insertText', [0, 0, 0, '본문'], { meta: { len: 2 } })], 'confined', 'comment 로 본문 입력');
  await rejected(room, C, W, [op('setFieldValueByName', ['name', 'x'])], 'confined', 'comment 로 누름틀 값');
  await rejected(room, C, W, [stateAfter(C, (d) => { d.insertMemo(0, 0, 0, 2, JSON.stringify({ author: 'C', text: '메모' })); d.insertText(0, 0, 0, '덤 '); })], 'confined', 'state 로 메모 + 본문');
  W.close(); C.close();
});

test('comment: 메모 넣기·답글·자기 메모 고치기(op)는 통과하고 다른 참여자와 정본이 같다', async () => {
  const { room } = await makeRoom();
  const W = await client(room, 'W');
  const C = await client(room, 'C', 'comment');
  try {
    await accepted(room, C, W, [memoOp(C, [0, 0, 0, 2], '첫 메모')], '메모 넣기(op)');
    const id = JSON.parse(C.doc.getMemoList())[0].id;
    await accepted(room, C, W, [op('insertMemoReply', [id, JSON.stringify({ author: C.name, text: '답글' })], { ctx: { memoTime: MEMO_TIME } })], '답글(op)');
    await accepted(room, C, W, [op('setMemoText', [id, '고친 메모'])], '자기 메모 고치기(op)');
  } finally { W.close(); C.close(); }
});

test('comment: 메모가 든 문서에서 state 로 스크립트 스트림을 바꾸면 forbidden(confined)', async () => {
  const { room } = await makeRoom();
  const W = await client(room, 'W');
  const C = await client(room, 'C', 'comment');
  try {
    await accepted(room, C, W, [memoOp(C, [0, 0, 0, 2], '첫 메모')], '메모 넣기(op)');
    // 정상 메모 하나 + 기본 스크립트 스트림을 바꾼 바이트(부속 스트림 비교는 파생 스트림 하나만 뺀다)
    const memo = (d) => d.insertMemo(0, 0, 7, 9, JSON.stringify({ author: 'C', text: '둘째 메모' }));
    await rejected(room, C, W, [forgedState(C, memo, 'DefaultJScript', 'evil();')], 'confined', 'state 로 메모 + 스크립트 바꾸기');
    // 거절 뒤에도 같은 메모는 그대로 통과
    await accepted(room, C, W, [stateAfter(C, memo)], '거절 뒤 메모(state)');
  } finally { W.close(); C.close(); }
});

test('view: 모든 편집이 forbidden(scope) — 정본에 닿지 않는다', async () => {
  const { room } = await makeRoom();
  const W = await client(room, 'W');
  const V = await client(room, 'V', 'view');
  const fake = { activeField: FORM.activeField };
  for (const [label, entries] of [
    ['본문 입력', [op('insertText', [0, 0, 0, 'v'], { meta: { len: 1 } })]],
    ['누름틀 값', [op('setFieldValueByName', ['name', 'v'])]],
    ['누름틀 안 입력', [op('insertText', [0, 0, 5, 'v'], { meta: { len: 1 }, ctx: fake })]],
    ['메모(state)', [stateAfter(V, (d) => d.insertMemo(0, 0, 0, 2, JSON.stringify({ author: 'V', text: 'm' })))]],
  ]) await rejected(room, V, W, entries, 'scope', `view ${label}`);
  V.send({ type: 'base', data: b64(FORM.raw) });
  assert.deepEqual(await V.next(), { type: 'forbidden', what: 'base', reason: 'scope' });
  W.close(); V.close();
});

/** 정상 클라이언트의 섞인 묶음: 누름틀 값 다음 메모(둘 다 op) */
const mixed = (c) => [op('setFieldValueByName', ['name', '섞음']), memoOp(c, [0, 0, 0, 2], '섞음 메모')];

test('form comment 권한이어도 본문 입력이 끼면, form 만이면 메모가 끼면 forbidden(confined)', async () => {
  const { room } = await makeRoom();
  const W = await client(room, 'W');
  const FC = await client(room, 'FC', 'form comment');
  const F = await client(room, 'F', 'form');
  assert.deepEqual(FC.user.scope, ['form', 'comment']);
  await rejected(room, F, W, mixed(F), 'confined', 'form 만으로 누름틀 + 메모');
  await rejected(room, FC, W, [op('setFieldValueByName', ['name', '또']), op('insertText', [0, 0, 0, '덤'], { meta: { len: 1 } })], 'confined', 'form comment 묶음에 본문 입력이 끼면');
  await accepted(room, FC, W, [op('setFieldValueByName', ['name', '값만'])], 'form comment 로 누름틀 값만');
  W.close(); FC.close(); F.close();
});

test('form comment: 누름틀 입력 + 메모가 섞인 한 묶음은 통과', async () => {
  const { room } = await makeRoom();
  const W = await client(room, 'W');
  const FC = await client(room, 'FC', 'form comment');
  try {
    await accepted(room, FC, W, mixed(FC), 'form comment 로 누름틀 + 메모');
  } finally { W.close(); FC.close(); }
});
