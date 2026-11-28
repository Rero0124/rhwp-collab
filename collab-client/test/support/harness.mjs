// collab 엔진 시험 도우미: 실제 WASM 문서 + studio 와 같은 prototype 기록 훅 + 프로세스 안 서버 모형.
// R4 엔진 시험과 R5 무작위 시뮬레이션이 같이 쓴다. 서버 모형은 server/server.mjs 와 같은 규칙이다:
// base === seq 일 때만 seq+1·방송, 아니면 보낸 쪽에만 reject. 연결마다 순서는 지킨다(FIFO).
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CollabEngine } from '../../src/engine/engine.ts';
import { base64ToBytes, bytesToBase64 } from '../../src/engine/codec.ts';
import { methodsToIntercept, classify } from '../../src/engine/classify.ts';
import { interceptPrototype } from '../../../upstream/rhwp/rhwp-studio/src/plugin/document-intercept.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const PKG = resolve(process.env.COLLAB_PKG ?? resolve(here, '../../../upstream/rhwp/pkg'));

let wasm = null;
/** 문서 객체 → 그 문서를 공유 문서로 쥔 엔진. 훅은 prototype 하나에 한 번만 건다. */
const engines = new Map();

export async function loadWasm(pkg = PKG) {
  if (wasm) return wasm;
  wasm = await import(`${pkg}/rhwp.js`);
  wasm.initSync({ module: readFileSync(`${pkg}/rhwp_bg.wasm`) });
  if (typeof wasm.HwpDocument.prototype.collabTransform !== 'function') {
    throw new Error(`${pkg} 는 2단계 collab 표면이 없는 빌드입니다`);
  }
  const names = methodsToIntercept([], (n) => typeof wasm.HwpDocument.prototype[n] === 'function');
  interceptPrototype(wasm.HwpDocument.prototype, names, (name, args, invoke, target) => {
    const engine = engines.get(target);
    return engine ? engine.intercept(name, args, invoke, target) : invoke();
  });
  return wasm;
}

export function blankBytes() {
  const d = wasm.HwpDocument.createEmpty();
  d.createBlankDocument();
  const bytes = d.exportHwp();
  d.free();
  return bytes;
}

export const paragraphs = (doc, sec = 0) => {
  const out = [];
  for (let i = 0; i < doc.getParagraphCount(sec); i += 1) out.push(doc.getTextRange(sec, i, 0, doc.getParagraphLength(sec, i)));
  return out;
};

/** 클라이언트 하나: 문서 + 엔진 + 프로토콜 상태(§7). */
export class Client {
  constructor(id, base, server, options = {}) {
    this.id = id;
    this.server = server;
    this.doc = new wasm.HwpDocument(base);
    this.lastSeq = 0;
    this.inflight = 0;
    this.dropped = 0;
    this.drops = [];
    this.droppedEntries = [];
    /** 버린 기록의 분류 ← 그때 받은 원격 분류 (R13 분해) */
    this.dropPairs = {};
    this.errors = [];
    /** 캐럿(텍스트 좌표). 있으면 원격을 받을 때 플러그인처럼 엔진 지도로 옮긴다(R9 현실 조건). */
    this.caret = null;
    this.engine = new CollabEngine({
      onWarn: (m) => (options.onWarn ?? (() => {}))(`${id}: ${m}`),
      fast: options.fast ?? true,
      verifyFast: options.verifyFast ?? false,
    });
    this.engine.attach(this.doc);
    this.engine.setRecording(true);
    engines.set(this.doc, this.engine);
    /** S3-4: 연결 상태·보낸 묶음 이름 */
    this.online = true;
    this.batches = 0;
    this.inflightBatch = null;
    this.resyncs = 0;
    this.catchups = 0;
    /** S3-3: 내 문서의 세대(계보). 처음 참여는 서버의 지금 세대에서 시작 */
    this.generation = server.generation ?? 0;
    server.join(this);
  }

  flush() {
    // 다시 붙은 뒤 서버 답(catchup·welcome)을 받기 전에는 보내지 않는다 — 옛 base 로 보낸 묶음의 늦은 reject 가
    // 따라잡기로 이미 되돌린 뒤의 새 묶음을 건드리지 않게.
    if (!this.online || this.resuming || this.inflight > 0) return false;
    const entries = this.engine.takePending();
    if (entries.length === 0) return false;
    this.inflight = entries.length;
    this.inflightBatch = `${this.id}:${++this.batches}`;
    this.server.submit(this, this.lastSeq, entries, this.inflightBatch);
    return true;
  }

  /** S3-4: 끊긴다(그 사이 서버가 보낸 메시지는 잃는다). 편집은 계속 미확정에 쌓인다. */
  disconnect() {
    if (!this.online) return;
    if (process.env.SIM_S3_TRACE) console.log(`TRACE ${this.id} disconnect lastSeq ${this.lastSeq} inflight ${this.inflight} ${this.inflightBatch} queued ${this.server.queues.get(this)?.map((m) => m.type + ':' + (m.seq ?? '')).join(',')}`);
    this.online = false;
    this.server.disconnect(this);
  }

  /** S3-4: 다시 붙는다 — 서버가 lastSeq 로 따라잡기(catchup) 또는 welcome 을 보낸다. */
  reconnect() {
    if (this.online) return;
    this.online = true;
    this.resuming = true;
    this.server.resume(this);
  }

  /** welcome: 지금 문서 객체 안에서 기준점 + 기록으로 다시 맞춘다(플러그인 applyWelcomeInPlace 와 같다). 미확정은 버린다. */
  applyWelcome(msg) {
    this.resuming = false;
    this.engine.attach(this.doc);
    this.doc.collabLoadState(msg.base);
    this.engine.replayAll(msg.log);
    this.engine.setRecording(true);
    this.lastSeq = msg.seq;
    this.inflight = 0;
    this.inflightBatch = null;
    this.generation = msg.generation;
    this.resyncs += 1;
  }

  deliver(msg) {
    if (msg.type === 'reject') {
      if (msg.batchId !== undefined && msg.batchId !== this.inflightBatch) return; // 늦게 온 옛 묶음의 reject
      this.engine.requeue();
      this.inflight = 0;
      this.inflightBatch = null;
      return;
    }
    if (msg.type === 'welcome') return this.applyWelcome(msg);
    if (msg.type === 'invalid') { this.server.resync(this); return; }
    if (msg.type === 'catchup') {
      this.resuming = false;
      // 끊긴 동안의 묶음: 내 묶음(inflightBatch)이면 확정, 아니면 원격 수신. 내 묶음이 없으면 다시 보낸다.
      this.catchups += 1;
      if (process.env.SIM_S3_TRACE) console.log(`TRACE ${this.id} catchup lastSeq ${this.lastSeq} items ${msg.log.map((i) => `${i.seq}:${i.clientId}:${i.batchId}`).join(',')} inflight ${this.inflight} ${this.inflightBatch} pending ${this.engine.pendingCount} unsent ${this.engine.unsentCount}`);
      for (const item of msg.log) {
        if (item.batchId === this.inflightBatch && this.inflight > 0) {
          if (item.seq !== this.lastSeq + 1) this.errors.push(`catchup seq 건너뜀 ${this.lastSeq} → ${item.seq}`);
          this.ackOwn(item);
          this.inflight = 0;
          this.inflightBatch = null;
          this.lastSeq = item.seq;
        } else if (item.clientId === this.id) {
          this.errors.push(`catchup 에 보낸 적 없는 내 묶음 seq ${item.seq} (${item.batchId})`);
          this.lastSeq = item.seq;
        } else {
          this.deliver({ type: 'ops', ...item });
        }
      }
      if (this.inflight > 0) {
        this.engine.requeue();
        this.inflight = 0;
        this.inflightBatch = null;
      }
      return;
    }
    if (msg.seq !== this.lastSeq + 1) this.errors.push(`seq 건너뜀 ${this.lastSeq} → ${msg.seq}`);
    if (msg.clientId === this.id) {
      this.ackOwn(msg);
      this.inflight = 0;
      this.inflightBatch = null;
    } else {
      const res = this.engine.receiveRemote(msg.entries, this.caret);
      if (res.ok && this.caret && res.caret) this.caret = res.caret;
      if (!res.ok) this.errors.push(`원격 적용 실패 seq ${msg.seq}: ${res.error}`);
      if (res.dropped > 0) {
        this.dropped += res.dropped;
        this.drops.push(res.dropReason ?? '');
        this.droppedEntries.push(...(res.droppedEntries ?? []));
        const cls = (e) => (e.kind === 'state' ? 'state' : classify(e.m).conc);
        const rc = [...new Set(msg.entries.map(cls))].sort().join('+');
        for (const e of res.droppedEntries ?? []) { const k = `${cls(e)} ← ${rc}`; this.dropPairs[k] = (this.dropPairs[k] ?? 0) + 1; }
        if (process.env.SIM_DROP_LOG && (!process.env.SIM_DROP_MATCH || String(res.dropReason).includes(process.env.SIM_DROP_MATCH)) && (globalThis.__dropLogs = (globalThis.__dropLogs ?? 0) + 1) <= Number(process.env.SIM_DROP_LOG)) {
          const short = (e) => (e.kind === 'state' ? 'STATE' : `${e.m}${JSON.stringify(e.a).slice(0, 60)}${e.meta?.pd !== undefined ? ` pd=${e.meta.pd}` : ''}`);
          console.log(`DROP ${this.id}: ${res.dropReason}\n  버림 ${(res.droppedEntries ?? []).map(short).join(' | ')}\n  원격 ${msg.entries.map(short).join(' | ')}`);
        }
      }
    }
    this.lastSeq = msg.seq;
  }

  /** 내 묶음의 확정. 6단계 S1: 서버가 state 를 다시 쓴 바이트로 바꿨으면(`replaced`) 확정 상태를 그 기록으로 두고 미확정을 다시 얹는다. */
  ackOwn(msg) {
    if (msg.replaced !== true) {
      this.engine.ack(this.inflight);
      return;
    }
    this.replacedAcks = (this.replacedAcks ?? 0) + 1;
    const res = this.engine.ackReplaced(msg.entries, this.caret);
    if (!res.ok) this.errors.push(`다시 쓴 결과 적용 실패 seq ${msg.seq}: ${res.error}`);
    if (res.dropped > 0) {
      this.dropped += res.dropped;
      this.drops.push(res.dropReason ?? '');
      this.droppedEntries.push(...(res.droppedEntries ?? []));
    }
  }

  digest() {
    return this.doc.collabDigest();
  }

  close() {
    engines.delete(this.doc);
    this.engine.detach();
    this.doc.free();
  }
}

export class Server {
  /**
   * @param base 문서 바이트
   * @param options.canonical S3-2 정본: 같은 엔진으로 기록 전에 먼저 적용(실패하면 invalid), seq 마다 정본 digest
   */
  constructor(base, options = {}) {
    this.base = base;
    this.seq = 0;
    /** S3-3: 세대 — 세대 전환(빈 방에서만)마다 하나씩. 새 방은 0세대(서버와 같다) */
    this.generation = 0;
    /** S3-3·S3-4: base 가 나타내는 seq. log 는 그 뒤 묶음 */
    this.baseSeq = 0;
    this.log = [];
    this.queues = new Map();
    this.offline = new Set();
    this.canonical = options.canonical || options.rewriteState ? this.openCanonical() : null;
    /** 6단계 S1: 정본이 받은 state 를 바뀐 부분만 모델에서 다시 쓴 바이트로 바꿔 기록·방송한다(보낸 사람에게도, `replaced`) */
    this.rewriteState = Boolean(options.rewriteState);
    this.rewrites = 0;
    this.invalids = 0;
    /** 4단계 U3: 정본이 확인해 거절한 범위 표시 / 확인을 거친 범위 표시 state 수 */
    this.rangeRejects = 0;
    this.rangeChecks = 0;
    this.generations = 0;
    this.restarts = 0;
  }
  /** 정본 문서: 기준점 + 기록 재생(S3-3 복원과 같다) */
  openCanonical() {
    const doc = new wasm.HwpDocument(this.base);
    // 결과 다시 쓰기 강화(결정 2): 정본은 열자마자(기록 재생 전) 본 날 바이트를 모은다 — 서버 정본 워커와 같다
    doc.collabTrackRawSeen?.();
    const engine = new CollabEngine();
    engine.attach(doc);
    engine.replayAll(this.log);
    return { doc, engine };
  }
  closeCanonical() {
    if (!this.canonical) return;
    this.canonical.engine.detach();
    this.canonical.doc.free();
  }
  canonicalDigest() { return this.canonical?.doc.collabDigest() ?? null; }
  join(client) { this.queues.set(client, []); }
  submit(client, base, entries, batchId) {
    let replaced = false;
    if (this.offline.has(client)) return; // 끊긴 연결로는 닿지 않는다
    if (base !== this.seq) {
      this.queues.get(client).push({ type: 'reject', seq: this.seq, ...(batchId ? { batchId } : {}) });
      return;
    }
    // U3(server.mjs 와 같다): state 는 형식 필드만, 정본이 없으면 범위 표시를 뗀다(확인할 수 없다)
    entries = entries.map((e) => (e.kind === 'state' ? { kind: 'state', data: e.data, ...(this.canonical && e.range ? { range: e.range } : {}) } : e));
    if (this.canonical) {
      const { doc, engine } = this.canonical;
      const snap = doc.collabSnapshotSave();
      try {
        const hinted = entries.some((e) => e.kind === 'state' && e.range);
        if ((this.rewriteState || hinted) && entries.some((e) => e.kind === 'state')) {
          // 묶음의 앞 연산까지 적용한 정본과 비교해야 하므로 하나씩 적용하며 state 를 바꾼다(canonical-worker 와 같은 순서:
          // 적용 전 정본으로 S 를 만들고 → 범위 표시면 C 를 읽어 범위 밖 확인 → S 를 읽음)
          entries = structuredClone(entries);
          for (const e of entries) {
            if (e.kind === 'state') {
              const S = this.rewriteState ? doc.collabRewriteState(base64ToBytes(e.data)) : null;
              if (e.range) {
                this.rangeChecks += 1;
                const pre = doc.collabSnapshotSave();
                try {
                  doc.collabLoadState(base64ToBytes(e.data));
                  const v = JSON.parse(doc.collabCheckRangeHint(pre, JSON.stringify(e.range)));
                  if (v.ok !== true) {
                    this.rangeRejects += 1;
                    throw new Error(`range: ${v.detail}`);
                  }
                } finally {
                  doc.collabSnapshotDiscard(pre);
                }
              }
              if (S) {
                e.data = bytesToBase64(S);
                this.rewrites += 1;
              }
            }
            engine.replay([e]);
          }
          replaced = this.rewriteState;
        } else {
          engine.replay(entries);
        }
      } catch {
        doc.collabSnapshotRestore(snap);
        doc.collabSnapshotDiscard(snap);
        this.invalids += 1;
        this.queues.get(client).push({ type: 'invalid', ...(batchId ? { batchId } : {}) });
        return;
      }
      doc.collabSnapshotDiscard(snap);
    }
    this.seq += 1;
    const msg = { type: 'ops', seq: this.seq, clientId: client.id, entries: structuredClone(entries), ...(batchId ? { batchId } : {}), ...(replaced ? { replaced: true } : {}) };
    this.log.push(msg);
    for (const [c, q] of this.queues) if (!this.offline.has(c)) q.push(structuredClone(msg));
  }
  /** S3-4: 연결이 끊긴다 — 그 연결로 가던 메시지는 잃는다. */
  disconnect(client) {
    this.offline.add(client);
    this.queues.set(client, []);
  }
  /** S3-4: 다시 붙는다 — lastSeq 가 기준점 + 기록 범위 안이면 catchup, 아니면 welcome. */
  resume(client) {
    this.offline.delete(client);
    const q = [];
    this.queues.set(client, q);
    if (client.generation === this.generation && client.lastSeq >= this.baseSeq && client.lastSeq <= this.seq) {
      q.push({ type: 'catchup', seq: this.seq, log: structuredClone(this.log.filter((m) => m.seq > client.lastSeq)) });
    } else {
      q.push(this.welcome());
    }
  }
  resync(client) { this.queues.get(client).push(this.welcome()); }
  welcome() { return { type: 'welcome', seq: this.seq, base: this.base, log: structuredClone(this.log), generation: this.generation }; }
  /**
   * S3-3 세대 전환(결정 "계보 보존" — 방이 빈 동안에만): 정본을 내보내 새 base 로, **정본도 그 바이트를 다시 읽고**,
   * 기록을 비운다. 그 뒤 들어오는 사람은 새 세대, 앞 세대에서 끊긴 사람은 welcome(재동기화).
   */
  changeGeneration(clients) {
    if (!this.canonical || clients.some((c) => c.online)) return false;
    this.base = gunzipSync(this.canonical.doc.collabExportState());
    this.baseSeq = this.seq;
    this.log = [];
    this.closeCanonical();
    this.canonical = this.openCanonical();
    this.generation += 1;
    this.generations += 1;
    return true;
  }
  /** 늦은 참여자: welcome(지금 기준점 + 기록)으로 시작한 새 클라이언트 */
  newcomer(id, options = {}) {
    const c = new Client(id, this.base, this, options);
    c.engine.attach(c.doc);
    c.engine.replayAll(this.log);
    c.engine.setRecording(true);
    c.lastSeq = this.seq;
    c.generation = this.generation;
    return c;
  }
  /** S3-3: 서버 재시작 — 모든 연결이 끊기고 정본은 체크포인트 + 기록으로 다시 만든다. */
  restart(clients) {
    for (const c of clients) c.disconnect();
    this.closeCanonical();
    if (this.canonical) this.canonical = this.openCanonical();
    this.restarts += 1;
  }
  pending(client) { return this.queues.get(client).length; }
  deliverOne(client) {
    const msg = this.queues.get(client).shift();
    if (msg) client.deliver(msg);
    return Boolean(msg);
  }
  /** 모두 보내고 모두 받을 때까지 돌린다. */
  drain(clients) {
    for (let guard = 0; guard < 100000; guard += 1) {
      let moved = false;
      for (const c of clients) moved = c.flush() || moved;
      for (const c of clients) while (this.deliverOne(c)) moved = true;
      if (!moved) return;
    }
    throw new Error('drain 이 끝나지 않음');
  }
  /** 서버 로그를 새 문서에 재생한 digest (기록하지 않는 엔진으로). 지금 기준점 + 그 뒤 기록(재시작한 서버가 만드는 문서). */
  replayDigest() {
    const doc = new wasm.HwpDocument(this.base);
    const engine = new CollabEngine();
    engine.attach(doc);
    engine.replayAll(this.log);
    const d = doc.collabDigest();
    engine.detach();
    doc.free();
    return d;
  }
}
