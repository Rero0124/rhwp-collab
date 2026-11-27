// S3-2 서버 정본 워커 (docs/collab-stage3.md S3-2). 방 하나의 정본 문서를 들고, 클라이언트와 같은 엔진
// (TS CollabEngine + rhwp WASM)으로 기록을 먼저 적용해 본다. 조판 환경은 엔진 기본(글꼴 정책 bundled-only 와
// 같다, S3-1) — 브라우저 참여자의 digest 와 구성상 같다.
//
// 메시지(주 스레드 ↔ 워커): {id, op, ...} → {id, ok, ...}
//   load   {base}     base = gzip 으로 감싼 문서(base64). 정본을 새로 연다 → {digest}
//   apply  {entries, confine?}  기록 열을 적용한다. 실패하면 적용 전으로 되돌린다 → {digest} | {reason}
//                     rhwp 가 오류 대신 패닉(WASM trap)하면 {panic: true} — 이 인스턴스는 더 믿을 수 없다(주 스레드가 버림)
//                     confine(5단계 D4, form·comment 연결)이 있으면 적용 뒤 checkConfined 로 결과를 판정하고, 벗어나면
//                     되돌리고 {forbidden: true, reason: 'confined' | 'unsupported'}
//                     memoOwner(5단계 D6, comment 연결의 이름)가 있으면 setMemoText·removeMemo 의 대상 메모가
//                     그 이름의 것인지 정본의 메모 목록으로 본다(묶음 안에서 먼저 만든 메모도 차례대로). 아니면 되돌리고
//                     {forbidden: true, reason: 'author'}
//   decrypt {data, password}  암호 문서(원본 바이트, base64)를 암호로 열어 결과 전송 형식(암호 없음, gzip)으로 → {data}.
//                     정본은 건드리지 않는다(5단계 D5, COLLAB_ALLOW_ENCRYPTED 일 때만 부른다). 틀리면 {wrongPassword: true}
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

/**
 * 5단계 D4 판정 자리: 스냅샷(snap) 뒤 적용한 결과가 허용된 부분(kinds = ['form'] | ['comment'] | 둘 다)만 바꿨는지.
 * 판정은 Rust 보조 `collabCheckConfined(snapshotId, kind)` 가 한다(함수 이름·state 바이트를 믿지 않고 결과로 — 우회 불가).
 * 그 보조가 합쳐지기 전에는 판정할 수 없으므로 언제나 unsupported 다.
 * @returns {{ ok: true } | { ok: false, reason: 'confined' | 'unsupported', detail?: string }}
 */
function checkConfined(snap, kinds) {
  if (typeof doc.collabCheckConfined !== 'function') return { ok: false, reason: 'unsupported', detail: 'collabCheckConfined 가 없다' };
  // 권한 목록을 한 번에 넘긴다(`"form comment"`) — 보조가 두 권한의 허용 부분을 함께 가리고 비교하므로, 한 묶음이
  // 양식과 메모를 함께 바꿔도 판정된다. 반환은 {"ok":true} | {"ok":false,"reason":"confined","detail":".."}(JSON 문자열).
  const res = JSON.parse(doc.collabCheckConfined(snap, kinds.join(' ')));
  return res.ok === true ? { ok: true } : { ok: false, reason: res.reason ?? 'confined', detail: String(res.detail ?? '') };
}

/** rhwp 의 "암호 필요"·"암호 틀림" 오류(일반 오류와 구분한다 — 5단계 D5) */
const NEEDS_PASSWORD = /비밀번호가 필요한 암호 문서/;
const WRONG_PASSWORD = /비밀번호가 일치하지 않/;

/**
 * 5단계 D6: comment 연결은 자기 메모만 고치고 지운다. 대상 메모(id)의 작성자가 owner(그 연결의 입장 이름)인지.
 * 반환: 어긋난 까닭(문자열) 또는 null. 이 묶음에서 아직 없는 메모(id)는 `pending` 으로 돌려 차례대로 다시 본다.
 * (메모 모양 setMemoShape 는 구역 전체의 문서 설정이라 edit 전용이다 — 분류표·결과 판정이 막는다.)
 */
const OWNED_MEMO_OPS = new Set(['setMemoText', 'removeMemo']);
function memoOwnerViolation(e, owner, { allowMissing = false } = {}) {
  if (e?.kind !== 'op' || !OWNED_MEMO_OPS.has(e.m)) return null;
  const memos = JSON.parse(doc.getMemoList());
  const target = memos.find((m) => m.id === e.a[0]);
  if (!target) return allowMissing ? 'pending' : `메모 ${e.a[0]} 없음`;
  return target.author === owner ? null : `메모 ${e.a[0]} 의 작성자가 다름`;
}

/** 판정 보조가 있는지 — 없으면 적용해 보지도 않고 거절한다. */
const confinedSupported = () => typeof doc?.collabCheckConfined === 'function';

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
        try {
          open(p.base);
        } catch (e) {
          if (isTrap(e)) throw e;
          const reason = reasonOf(e);
          return reply({ ok: false, reason, ...(NEEDS_PASSWORD.test(reason) ? { encrypted: true } : {}) });
        }
        return reply({ ok: true, digest: doc.collabDigest() });
      case 'decrypt': {
        let plain;
        try {
          plain = wasm.HwpDocument.openWithPassword(Buffer.from(p.data, 'base64'), String(p.password ?? ''));
        } catch (e) {
          if (isTrap(e)) throw e;
          const reason = reasonOf(e);
          return reply({ ok: false, reason, ...(WRONG_PASSWORD.test(reason) ? { wrongPassword: true } : {}) });
        }
        try {
          return reply({ ok: true, data: Buffer.from(plain.collabExportState()).toString('base64') });
        } finally {
          plain.free();
        }
      }
      case 'apply': {
        if (!doc) return reply({ ok: false, reason: '정본 문서가 없다' });
        // D6: 다른 사람의 메모를 고치거나 지우려는 묶음은 형식 검사보다 먼저 거절한다(이미 있는 메모만 여기서 본다)
        const owner = typeof p.memoOwner === 'string' ? p.memoOwner : null;
        if (owner !== null) {
          for (const e of p.entries) {
            const why = memoOwnerViolation(e, owner, { allowMissing: true });
            if (why && why !== 'pending') return reply({ ok: false, forbidden: true, reason: 'author', detail: why });
          }
        }
        const bad = validate(p.entries);
        if (bad) return reply({ ok: false, reason: bad });
        const confine = Array.isArray(p.confine) && p.confine.length ? p.confine : null;
        if (confine && !confinedSupported()) return reply({ ok: false, forbidden: true, reason: 'unsupported', detail: 'collabCheckConfined 가 없다' });
        // D4: 스냅샷 → 적용 → 판정 → 벗어나면 복원. 복원 뒤 정본 digest 가 적용 전과 같은지 확인한다.
        const before = confine ? doc.collabDigest() : null;
        const snap = doc.collabSnapshotSave();
        let ownerWhy = null;
        try {
          if (owner !== null && p.entries.some((e) => OWNED_MEMO_OPS.has(e?.m))) {
            // 묶음 안에서 만든 메모를 바로 고치는 경우도 보려고 하나씩 적용하며 확인한다
            for (const e of p.entries) {
              ownerWhy = memoOwnerViolation(e, owner);
              if (ownerWhy) break;
              engine.replay([e]);
            }
          } else {
            engine.replay(p.entries);
          }
        } catch (e) {
          if (isTrap(e)) return reply({ ok: false, panic: true, reason: reasonOf(e) });
          doc.collabSnapshotRestore(snap);
          doc.collabSnapshotDiscard(snap);
          return reply({ ok: false, reason: reasonOf(e) });
        }
        if (ownerWhy) {
          doc.collabSnapshotRestore(snap);
          doc.collabSnapshotDiscard(snap);
          return reply({ ok: false, forbidden: true, reason: 'author', detail: ownerWhy });
        }
        if (confine) {
          let verdict;
          try {
            verdict = checkConfined(snap, confine);
          } catch (e) {
            if (isTrap(e)) return reply({ ok: false, panic: true, reason: reasonOf(e) });
            verdict = { ok: false, reason: 'confined', detail: `판정 오류: ${reasonOf(e)}` };
          }
          if (!verdict.ok) {
            doc.collabSnapshotRestore(snap);
            doc.collabSnapshotDiscard(snap);
            const after = doc.collabDigest();
            // 되돌린 정본이 적용 전과 다르면 이 인스턴스를 더 믿을 수 없다 — 패닉처럼 버리고 다시 만든다.
            if (after !== before) return reply({ ok: false, panic: true, reason: `판정 뒤 복원한 정본 digest 가 다름 (${before} → ${after})` });
            return reply({ ok: false, forbidden: true, reason: verdict.reason, detail: verdict.detail });
          }
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
