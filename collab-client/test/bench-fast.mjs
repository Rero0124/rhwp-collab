#!/usr/bin/env node
// R11 측정: 같은 큰 문서에서 원격 수신 시간 — 빠른 경로(R' 바로 적용) vs 되감기(스냅샷 복원 + 재생).
//
//   node collab-client/test/bench-fast.mjs <문서 경로> [--rounds 10]
//
// 두 참여자가 서로 먼 문단에서 친다. B 가 미확정을 든 채 A 의 입력을 받을 때 receiveRemote 시간을 잰다.
import { readFileSync } from 'node:fs';
import { loadWasm, Client, Server } from './support/harness.mjs';

const file = process.argv[2];
if (!file) throw new Error('문서 경로가 필요합니다');
const ri = process.argv.indexOf('--rounds');
const ROUNDS = ri >= 0 ? Number(process.argv[ri + 1]) : 10;

await loadWasm();
const base = readFileSync(file);
const out = { file, rounds: ROUNDS };
for (const fast of [true, false]) {
  const server = new Server(base);
  const t0 = performance.now();
  const a = new Client('A', base, server, { fast });
  const b = new Client('B', base, server, { fast });
  out.openMs = Math.round((performance.now() - t0) / 2);
  const paras = a.doc.getParagraphCount(0);
  const pa = Math.min(3, paras - 1);
  const pb = Math.max(pa + 2, paras - 3);
  out.paragraphs = paras;
  const times = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    a.doc.insertText(0, pa, 0, 'a');
    a.flush(); // A 가 먼저 확정된다(서버 모형은 받는 즉시 순서를 정함)
    while (server.deliverOne(a));
    b.doc.insertText(0, pb, 0, 'b'); // B 의 미확정 — A 의 확정을 아직 받지 않았다
    b.flush(); // 낡은 base 라 거절된다(거절은 A 의 확정 뒤에 B 큐에 쌓임)
    const msg = server.queues.get(b).shift(); // B 가 받는 첫 메시지 = A 의 확정
    const t = performance.now();
    b.deliver(msg);
    times.push(performance.now() - t);
    server.drain([a, b]);
  }
  times.sort((x, y) => x - y);
  const st = b.engine.fastStats;
  out[fast ? 'fastPath' : 'rewind'] = {
    medianMs: +times[Math.floor(times.length / 2)].toFixed(2), maxMs: +times[times.length - 1].toFixed(2),
    fast: st.fast, slow: st.slow, slowReasons: st.blocks,
  };
  const same = a.digest() === b.digest();
  out[fast ? 'fastConverged' : 'rewindConverged'] = same && server.replayDigest() === a.digest();
  a.close();
  b.close();
}
console.log(JSON.stringify(out, null, 1));
