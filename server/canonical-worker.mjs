// S3-2 서버 정본 워커 (docs/collab-stage3.md S3-2). 방 하나의 정본 문서를 들고, 클라이언트와 같은 엔진
// (TS CollabEngine + rhwp WASM)으로 기록을 먼저 적용해 본다. 조판 환경은 엔진 기본(글꼴 정책 bundled-only 와
// 같다, S3-1) — 브라우저 참여자의 digest 와 구성상 같다.
//
// 메시지(주 스레드 ↔ 워커): {id, op, ...} → {id, ok, ...}
//   load   {base}     base = gzip 으로 감싼 문서(base64). 정본을 새로 연다 → {digest}
//   apply  {entries}  기록 열을 적용한다. 실패하면 적용 전으로 되돌린다 → {digest} | {reason}
//                     rhwp 가 오류 대신 패닉(WASM trap)하면 {panic: true} — 이 인스턴스는 더 믿을 수 없다(주 스레드가 버림)
//   replayAll {log}   기록 여러 묶음을 한 번에(복원·재생성 — 이미 받아 둔 기록이라 되돌림 없음, 쪽 배치는 끝에 한 번) → {digest}
//   export {}         정본을 결과 전송 형식으로 → {data}
//   digest {}         → {digest}
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const wasm = await import(pathToFileURL(`${workerData.pkg}/rhwp.js`).href);
wasm.initSync({ module: readFileSync(`${workerData.pkg}/rhwp_bg.wasm`) });
const { CollabEngine } = await import(new URL('../collab-client/src/engine/engine.ts', import.meta.url).href);
const { CATALOG } = await import(new URL('../collab-client/src/engine/catalog.ts', import.meta.url).href);

let doc = null;
let engine = null;

const reasonOf = (e) => (typeof e === 'string' ? e : e?.message ?? String(e));
const TRAP = /memory access out of bounds|unreachable|recursive use of an object|null pointer passed to rust/i;
const isTrap = (e) => e instanceof WebAssembly.RuntimeError || TRAP.test(reasonOf(e));

/** 기록 형식 검사 — 분류표에서 `op` 인 기능만 정본에 부를 수 있다(그 밖의 메서드 이름은 거절). */
function validate(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 'entries 는 비어 있지 않은 배열이어야 한다';
  for (const e of entries) {
    if (e?.kind === 'state') {
      if (typeof e.data !== 'string' || !e.data) return 'state 기록에 data 가 없다';
      continue;
    }
    if (e?.kind !== 'op' || typeof e.m !== 'string' || !Array.isArray(e.a)) return '기록 형식이 아니다';
    if (!Object.hasOwn(CATALOG, e.m) || CATALOG[e.m].sync !== 'op') return `기록할 수 없는 기능: ${e.m}`;
  }
  return null;
}

function open(base) {
  const raw = gunzipSync(Buffer.from(base, 'base64'));
  const next = new wasm.HwpDocument(raw);
  engine?.detach();
  doc?.free();
  doc = next;
  engine = new CollabEngine({ onLocal() {}, onWarn() {} });
  engine.attach(doc);
}

parentPort.on('message', ({ id, op, ...p }) => {
  const reply = (r) => parentPort.postMessage({ id, ...r });
  try {
    switch (op) {
      case 'load':
        open(p.base);
        return reply({ ok: true, digest: doc.collabDigest() });
      case 'apply': {
        if (!doc) return reply({ ok: false, reason: '정본 문서가 없다' });
        const bad = validate(p.entries);
        if (bad) return reply({ ok: false, reason: bad });
        const snap = doc.collabSnapshotSave();
        try {
          engine.replay(p.entries);
        } catch (e) {
          if (isTrap(e)) return reply({ ok: false, panic: true, reason: reasonOf(e) });
          doc.collabSnapshotRestore(snap);
          doc.collabSnapshotDiscard(snap);
          return reply({ ok: false, reason: reasonOf(e) });
        }
        doc.collabSnapshotDiscard(snap);
        return reply({ ok: true, digest: doc.collabDigest() });
      }
      case 'replayAll': {
        if (!doc) return reply({ ok: false, reason: '정본 문서가 없다' });
        for (const item of p.log) {
          const bad = validate(item.entries);
          if (bad) return reply({ ok: false, reason: `seq ${item.seq}: ${bad}` });
        }
        engine.replayAll(p.log);
        return reply({ ok: true, digest: doc.collabDigest() });
      }
      case 'export':
        return reply({ ok: true, data: Buffer.from(doc.collabExportState()).toString('base64') });
      case 'digest':
        return reply({ ok: true, digest: doc.collabDigest() });
      default:
        return reply({ ok: false, reason: `모르는 op: ${op}` });
    }
  } catch (e) {
    reply({ ok: false, panic: isTrap(e), reason: reasonOf(e) });
  }
});
