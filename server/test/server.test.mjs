// 중계 서버 프로토콜 검증 (docs/collab-design.md §5, docs/collab-stage2.md §7).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer, DEFAULT_MAX_MESSAGE_BYTES as MAX } from '../server.mjs';

let server;
let url;
before(async () => {
  server = startServer({ port: 0, log: () => {}, delayMs: 0 });
  await server.ready;
  url = `ws://127.0.0.1:${server.port}`;
});
after(() => server.close());

/** 받은 메시지를 큐에 쌓고 `next()` 로 하나씩 꺼내는 테스트 클라이언트. */
async function client(room, clientId, engine = 'E1', target = url) {
  const ws = new WebSocket(target);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const w = waiters.shift();
    if (w) w(msg); else queue.push(msg);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const c = {
    ws,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: (ms = 1000) => {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${clientId}: 메시지 없음`)), ms);
        waiters.push((m) => { clearTimeout(timer); resolve(m); });
      });
    },
    /** ms 동안 아무 메시지도 오지 않음을 확인한다 */
    silent: async (ms = 100) => {
      await new Promise((r) => setTimeout(r, ms));
      assert.deepEqual(queue, [], `${clientId}: 예상 밖 메시지`);
    },
    close: () => new Promise((r) => { ws.once('close', r); ws.close(); }),
  };
  c.send({ type: 'hello', room, clientId, name: clientId, engine });
  return c;
}

const op = (text) => ({ kind: 'op', m: 'insertText', a: [0, 0, 0, text], meta: { len: text.length } });

test('첫 참여자가 base 담당, 이후 ops 순서·ack·늦은 참여자 로그', async () => {
  const a = await client('r1', 'A');
  assert.deepEqual(await a.next(), { type: 'welcome', seq: 0, base: null, log: [], maxMessageBytes: MAX });
  a.send({ type: 'base', data: 'QkFTRQ==' });

  const b = await client('r1', 'B');
  assert.deepEqual(await b.next(), { type: 'welcome', seq: 0, base: 'QkFTRQ==', log: [], maxMessageBytes: MAX });

  a.send({ type: 'ops', base: 0, entries: [op('a')] });
  const ackA = await a.next();
  assert.deepEqual(ackA, { type: 'ops', seq: 1, clientId: 'A', entries: [op('a')] });
  assert.deepEqual(await b.next(), ackA);

  // B 가 낡은 base 로 보내면 B 에게만 reject
  b.send({ type: 'ops', base: 0, entries: [op('b')] });
  assert.deepEqual(await b.next(), { type: 'reject', seq: 1 });
  await a.silent();

  b.send({ type: 'ops', base: 1, entries: [op('b')] });
  assert.equal((await a.next()).seq, 2);
  assert.equal((await b.next()).seq, 2);

  const c = await client('r1', 'C');
  const w = await c.next();
  assert.equal(w.seq, 2);
  assert.equal(w.base, 'QkFTRQ==');
  assert.deepEqual(w.log.map((e) => [e.seq, e.clientId]), [[1, 'A'], [2, 'B']]);

  await Promise.all([a.close(), b.close(), c.close()]);
});

test('base 를 기다리는 동안 들어온 참여자는 base 확정 뒤 welcome 을 받는다', async () => {
  const a = await client('r2', 'A');
  assert.equal((await a.next()).base, null);
  const b = await client('r2', 'B');
  await b.silent();
  // 담당이 아닌 B 의 base 는 거절
  b.send({ type: 'base', data: 'WFhY' });
  assert.equal((await b.next()).type, 'error');
  a.send({ type: 'base', data: 'QUFB' });
  assert.deepEqual(await b.next(), { type: 'welcome', seq: 0, base: 'QUFB', log: [], maxMessageBytes: MAX });
  await Promise.all([a.close(), b.close()]);
});

test('base 담당이 base 전에 나가면 다음 대기자가 담당이 된다', async () => {
  const a = await client('r3', 'A');
  assert.equal((await a.next()).base, null);
  const b = await client('r3', 'B');
  await b.silent();
  await a.close();
  assert.deepEqual(await b.next(), { type: 'welcome', seq: 0, base: null, log: [], maxMessageBytes: MAX });
  b.send({ type: 'base', data: 'QkI=' });
  const c = await client('r3', 'C');
  assert.equal((await c.next()).base, 'QkI=');
  await Promise.all([b.close(), c.close()]);
});

test('base 전 ops 는 reject', async () => {
  const a = await client('r4', 'A');
  await a.next();
  a.send({ type: 'ops', base: 0, entries: [op('x')] });
  assert.deepEqual(await a.next(), { type: 'reject', seq: 0 });
  await a.close();
});

test('digest: 같은 값은 조용, 다른 값은 diverged 방송(seq 당 한 번), 범위 밖은 무시', async () => {
  const a = await client('r5', 'A');
  await a.next();
  a.send({ type: 'base', data: 'QQ==' });
  const b = await client('r5', 'B');
  await b.next();
  a.send({ type: 'ops', base: 0, entries: [op('1')] });
  await a.next(); await b.next();

  a.send({ type: 'digest', seq: 1, digest: 'aaa' });
  b.send({ type: 'digest', seq: 1, digest: 'aaa' });
  await a.silent(); await b.silent();

  // 아직 없는 seq 는 무시
  b.send({ type: 'digest', seq: 9, digest: 'zzz' });
  await b.silent();

  a.send({ type: 'ops', base: 1, entries: [op('2')] });
  await a.next(); await b.next();
  a.send({ type: 'digest', seq: 2, digest: 'p' });
  b.send({ type: 'digest', seq: 2, digest: 'q' });
  assert.deepEqual(await a.next(), { type: 'diverged', seq: 2 });
  assert.deepEqual(await b.next(), { type: 'diverged', seq: 2 });
  b.send({ type: 'digest', seq: 2, digest: 'r' });
  await a.silent(); await b.silent();

  // 보관 범위(64) 밖으로 밀어낸 뒤 옛 seq 보고는 무시
  for (let s = 2; s < 2 + 64; s += 1) {
    a.send({ type: 'ops', base: s, entries: [op('.')] });
    await a.next(); await b.next();
  }
  b.send({ type: 'digest', seq: 1, digest: 'different' });
  await a.silent(); await b.silent();

  await Promise.all([a.close(), b.close()]);
});

test('잘못된 메시지는 error 로 답하고 연결은 유지', async () => {
  const a = await client('r6', 'A');
  await a.next();
  a.ws.send('not json');
  assert.equal((await a.next()).type, 'error');
  a.send({ type: 'ops', base: 0, entries: [] });
  assert.equal((await a.next()).type, 'error');
  a.send({ type: 'nope' });
  assert.equal((await a.next()).type, 'error');
  await a.close();
});

test('state 기록은 새 기준점: 늦게 온 참여자는 마지막 state 와 그 뒤 항목만 받는다', async () => {
  const a = await client('r7', 'A');
  await a.next();
  a.send({ type: 'base', data: 'QkFTRQ==' });
  a.send({ type: 'ops', base: 0, entries: [op('1')] });
  await a.next();
  a.send({ type: 'ops', base: 1, entries: [op('2'), { kind: 'state', data: 'U1RBVEU=' }, op('3')] });
  await a.next();
  a.send({ type: 'ops', base: 2, entries: [op('4')] });
  await a.next();
  const c = await client('r7', 'C');
  const w = await c.next();
  assert.equal(w.seq, 3);
  assert.equal(w.base, 'U1RBVEU=', '기준점은 마지막 state');
  assert.deepEqual(w.log.map((e) => [e.seq, e.entries.map((x) => x.a[3])]), [[2, ['3']], [3, ['4']]], 'state 뒤 항목만');
  await Promise.all([a.close(), c.close()]);
});

test('resync 는 welcome(resync:true) 로 답한다', async () => {
  const a = await client('r8', 'A');
  await a.next();
  a.send({ type: 'base', data: 'QkFTRQ==' });
  a.send({ type: 'ops', base: 0, entries: [op('x')] });
  await a.next();
  a.send({ type: 'resync' });
  const w = await a.next();
  assert.equal(w.type, 'welcome');
  assert.equal(w.resync, true);
  assert.equal(w.seq, 1);
  assert.equal(w.log.length, 1);
  await a.close();
});

test('엔진 지문이 방의 첫 참여자와 다르면 incompatible 로 거절하고 닫는다', async () => {
  const a = await client('r9', 'A', 'ENGINE-1');
  assert.equal((await a.next()).type, 'welcome');
  a.send({ type: 'base', data: 'QQ==' });
  const b = await client('r9', 'B', 'ENGINE-2');
  assert.deepEqual(await b.next(), { type: 'incompatible', engine: 'ENGINE-1' });
  await new Promise((r) => b.ws.once('close', r));
  const c = await client('r9', 'C', 'ENGINE-1');
  assert.equal((await c.next()).type, 'welcome', '같은 지문은 들어온다');
  await Promise.all([a.close(), c.close()]);
});

test('COLLAB_DELAY_MS: 모든 송신을 늦추되 연결마다 순서를 지킨다', async () => {
  const slow = startServer({ port: 0, log: () => {}, delayMs: 60 });
  await slow.ready;
  const surl = `ws://127.0.0.1:${slow.port}`;
  const a = await client('d1', 'A', 'E1', surl);
  const t0 = Date.now();
  assert.equal((await a.next(1000)).type, 'welcome');
  assert.ok(Date.now() - t0 >= 50, '지연됨');
  a.send({ type: 'base', data: 'QQ==' });
  a.send({ type: 'ops', base: 0, entries: [op('1')] });
  a.send({ type: 'ops', base: 0, entries: [op('stale')] }); // 거절
  a.send({ type: 'ops', base: 1, entries: [op('2')] });
  const got = [await a.next(1000), await a.next(1000), await a.next(1000)];
  assert.deepEqual(got.map((m) => [m.type, m.seq]), [['ops', 1], ['reject', 1], ['ops', 2]], '보낸 순서대로');
  await a.close();
  await slow.close();
});

test('메시지 상한: 넘는 ops 는 버리고 too-large 로 알린다, 넘는 base 는 연결을 닫는다', async () => {
  const small = startServer({ port: 0, log: () => {}, delayMs: 0, maxMessageBytes: 2000 });
  await small.ready;
  const surl = `ws://127.0.0.1:${small.port}`;
  const a = await client('m1', 'A', 'E1', surl);
  assert.equal((await a.next()).maxMessageBytes, 2000, 'welcome 에 상한');
  a.send({ type: 'base', data: 'QQ==' });
  a.send({ type: 'ops', base: 0, entries: [{ kind: 'state', data: 'x'.repeat(3000) }] });
  const tl = await a.next();
  assert.equal(tl.type, 'too-large');
  assert.equal(tl.what, 'ops');
  assert.equal(tl.limit, 2000);
  a.send({ type: 'ops', base: 0, entries: [op('ok')] });
  assert.equal((await a.next()).seq, 1, '버린 메시지는 seq 를 쓰지 않는다');

  const b = await client('m2', 'B', 'E1', surl);
  assert.equal((await b.next()).base, null);
  b.send({ type: 'base', data: 'y'.repeat(3000) });
  assert.equal((await b.next()).what, 'base');
  await new Promise((r) => b.ws.once('close', r));
  await a.close();
  await small.close();
});

test('cursor: 다른 참여자에게만 중계(초당 20회까지), 나가면 cursor-leave', async () => {
  const a = await client('c1', 'A');
  await a.next();
  a.send({ type: 'base', data: 'QQ==' });
  const b = await client('c1', 'B');
  await b.next();
  a.send({ type: 'cursor', seq: 0, caret: { section: 0, para: 0, offset: 3 } });
  assert.deepEqual(await b.next(), { type: 'cursor', clientId: 'A', name: 'A', seq: 0, caret: { section: 0, para: 0, offset: 3 } });
  await a.silent();
  let got = 0;
  let left = null;
  b.ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'cursor') got += 1; if (m.type === 'cursor-leave') left = m; });
  for (let i = 0; i < 30; i += 1) a.send({ type: 'cursor', seq: 0, caret: { section: 0, para: 0, offset: i } });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(got >= 18 && got <= 20, `초당 20회까지 (${got})`);
  await a.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(left, { type: 'cursor-leave', clientId: 'A' });
  await b.close();
});
