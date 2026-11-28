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
//                     state 항목(6단계 S1)은 받은 바이트 C 를 그대로 두지 않고, 바뀐 부분만 모델에서 다시 쓴 바이트 S 로
//                     바꿔 정본도 S 를 다시 읽는다 → {replaced: [{index, data}]}(묶음 안 위치와 S, base64(gzip))
//                     범위 표시가 붙은 state(4단계 U3, `range: {section, lo, before, after}`)는 C 를 읽은 뒤 그 범위 밖이
//                     적용 전과 같은지 확인한다(collabCheckRangeHint). 아니면 되돌리고 {reason: 'range', detail}
//   roundtrip {}      6단계 S2: 모든 부분을 모델에서 다시 쓴 결과를 원본과 견준다(collabRoundtripCheck) →
//                     {supported, result: {ok, lost: [{kind, count, detail}], irDiff}, ms}. 보조가 없으면 {supported: false}
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
      if (e.range !== undefined && !validRange(e.range)) return 'state 기록의 range 형식이 아니다';
      continue;
    }
    if (e?.kind !== 'op' || typeof e.m !== 'string' || !Array.isArray(e.a)) return '기록 형식이 아니다';
    if (!Object.hasOwn(CATALOG, e.m) || CATALOG[e.m].sync !== 'op') return `기록할 수 없는 기능: ${e.m}`;
  }
  return null;
}

/** 4단계 U3 범위 표시 `{section, lo, before, after}`(문단 수, before·after ≥ 1)의 모양. 다른 키는 받지 않는다. */
function validRange(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  const keys = Object.keys(r);
  if (keys.length !== 4 || !['section', 'lo', 'before', 'after'].every((k) => keys.includes(k))) return false;
  const n = (v, min) => Number.isSafeInteger(v) && v >= min;
  return n(r.section, 0) && n(r.lo, 0) && n(r.before, 1) && n(r.after, 1);
}

/** 4단계 U3: 범위 표시가 거짓이다(범위 밖이 바뀜) — 묶음을 거절한다(`invalid {reason: 'range'}`). */
class RangeHintError extends Error {
  constructor(detail) {
    super(`범위 표시가 맞지 않음: ${detail}`);
    this.detail = detail;
  }
}

/**
 * 4단계 U3: 범위 표시가 붙은 state 바이트 C 를 지금 정본에 읽고, 적용 전 스냅샷과 견주어 그 범위 밖이 그대로인지 확인한다.
 * 범위 표시가 거짓이면 다른 참여자의 미확정을 잘못 보정하게 된다(받는 쪽은 그 state 를 그 범위의 구조 편집으로 보고 범위
 * 밖 미확정을 번호만 옮겨 살린다). 확인 뒤 정본은 C 를 읽은 상태다 — 부른 쪽이 이어서 S 를 읽는다.
 */
function checkRangeHint(e) {
  if (typeof doc.collabCheckRangeHint !== 'function') throw new RangeHintError('collabCheckRangeHint 가 없다');
  const pre = doc.collabSnapshotSave();
  try {
    doc.collabLoadState(b64ToBytes(e.data));
    const res = JSON.parse(doc.collabCheckRangeHint(pre, JSON.stringify(e.range)));
    if (res.ok !== true) throw new RangeHintError(String(res.detail ?? res.reason ?? ''));
  } finally {
    doc.collabSnapshotDiscard(pre);
  }
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

/**
 * 6단계 S1: 받은 state 바이트 C 를 정본의 지금 문서와 견주어, 바뀐 부분(구역·DocInfo)만 모델에서 다시 쓴 바이트 S 를 만든다.
 * 파서가 모델에 남기지 않는 레코드를 끼운 C 가 원본 바이트 캐시를 타고 저장본·다른 참여자에게 가는 길을 막는다.
 * 보조(collab-core)의 이름·인자는 기존 코드 세션이 정한다 — 이 두 함수만 맞추면 된다.
 *   기대하는 모양: doc.collabRewriteState(C: Uint8Array /* collabExportState 와 같은 gzip 감싸기 *\/) → S(같은 감싸기).
 *   정본 문서는 바꾸지 않고(지금 문서와 비교만), 정본은 그 뒤 S 를 collabLoadState 로 다시 읽는다(R(S)).
 * 보조가 없으면 null — 예전처럼 C 를 그대로 쓴다(서버가 한 번 경고).
 */
const REWRITE_STATE = 'collabRewriteState';
const rewriteSupported = () => typeof doc?.[REWRITE_STATE] === 'function';
const b64ToBytes = (s) => new Uint8Array(Buffer.from(s, 'base64'));
function rewriteState(dataB64) {
  if (!rewriteSupported()) return null;
  return doc[REWRITE_STATE](b64ToBytes(dataB64));
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
        const replaced = [];
        try {
          const hinted = p.entries.some((e) => e?.kind === 'state' && e.range);
          if ((rewriteSupported() || hinted) && p.entries.some((e) => e?.kind === 'state')) {
            // S1: 하나씩 적용하며 state 는 다시 쓴 S 로 읽는다 — 뒤의 op 는 R(S) 위에 얹힌다(다른 참여자도 S 위에 얹는다).
            // U3: 범위 표시가 있으면 S 를 만든 뒤(적용 전 정본 기준) C 를 읽어 범위 밖이 그대로인지 확인하고 S 를 읽는다.
            p.entries.forEach((e, index) => {
              if (e?.kind !== 'state') return engine.replay([e]);
              const S = rewriteState(e.data);
              if (e.range) checkRangeHint(e);
              doc.collabLoadState(S ?? b64ToBytes(e.data));
              if (S) replaced.push({ index, data: Buffer.from(S).toString('base64') });
            });
          } else if (owner !== null && p.entries.some((e) => OWNED_MEMO_OPS.has(e?.m))) {
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
          if (e instanceof RangeHintError) return reply({ ok: false, reason: 'range', detail: e.detail });
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
        return reply({ ok: true, digest: doc.collabDigest(), ...(replaced.length ? { replaced } : {}) });
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
      case 'roundtrip': {
        if (!doc) return reply({ ok: false, reason: '정본 문서가 없다' });
        if (typeof doc.collabRoundtripCheck !== 'function') return reply({ ok: true, supported: false });
        const t0 = performance.now();
        const raw = doc.collabRoundtripCheck();
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return reply({ ok: true, supported: true, result, ms: Math.round(performance.now() - t0) });
      }
      case 'capabilities':
        // 서버가 시작 로그·경고에 쓴다: 다시 쓰기 보조가 있는지(6단계 S1)
        return reply({ ok: true, rewriteState: typeof wasm.HwpDocument.prototype[REWRITE_STATE] === 'function', roundtripCheck: typeof wasm.HwpDocument.prototype.collabRoundtripCheck === 'function' });
      default:
        return reply({ ok: false, reason: `모르는 op: ${op}` });
    }
  } catch (e) {
    reply({ ok: false, panic: isTrap(e), reason: reasonOf(e) });
  }
});
