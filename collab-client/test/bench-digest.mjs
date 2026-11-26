#!/usr/bin/env node
// S3-0 측정: BinData 를 보는 digest 의 WASM 비용 — 처음(압축 해제), 두 번째((epoch, id) 캐시),
// 되감기(스냅샷 복원, epoch 올림) 직후, 다시 읽기(state 적재) 직후.
//
//   node collab-client/test/bench-digest.mjs <문서 경로> [--rounds 5]
//
// 되감기 직후가 20ms 를 넘으면 리졸버 Weak 키 메모((d), docs/collab-stage3.md S3-0)를 넣을지 다시 본다.
import { readFileSync } from 'node:fs';
import { loadWasm } from './support/harness.mjs';

const file = process.argv[2];
if (!file) throw new Error('문서 경로가 필요합니다');
const ri = process.argv.indexOf('--rounds');
const ROUNDS = ri >= 0 ? Number(process.argv[ri + 1]) : 5;

const wasm = await loadWasm();
const bytes = readFileSync(file);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const timed = (fn) => { const t = performance.now(); const v = fn(); return [v, performance.now() - t]; };
const rows = { first: [], second: [], rewind: [], reload: [] };
for (let r = 0; r < ROUNDS; r += 1) {
  const doc = new wasm.HwpDocument(bytes);
  const [d1, first] = timed(() => doc.collabDigest());
  const [d2, second] = timed(() => doc.collabDigest());
  if (d1 !== d2) throw new Error('같은 문서의 digest 가 다름');
  const id = doc.collabSnapshotSave();
  doc.insertText(0, 0, 0, '가');
  doc.collabSnapshotRestore(id);
  doc.collabSnapshotDiscard(id);
  const [d3, rewind] = timed(() => doc.collabDigest());
  if (d3 !== d1) throw new Error('되감기 뒤 digest 가 다름');
  doc.collabLoadState(doc.collabExportState());
  const [, reload] = timed(() => doc.collabDigest());
  rows.first.push(first); rows.second.push(second); rows.rewind.push(rewind); rows.reload.push(reload);
  doc.free();
}
const ms = (x) => Math.round(x * 10) / 10;
console.log(JSON.stringify({ file, rounds: ROUNDS, medianMs: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, ms(median(v))])) }, null, 1));
