// collab 엔진 시험 도우미: 실제 WASM 문서 + studio 와 같은 prototype 기록 훅 + 프로세스 안 서버 모형.
// R4 엔진 시험과 R5 무작위 시뮬레이션이 같이 쓴다. 서버 모형은 server/server.mjs 와 같은 규칙이다:
// base === seq 일 때만 seq+1·방송, 아니면 보낸 쪽에만 reject. 연결마다 순서는 지킨다(FIFO).
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CollabEngine } from '../../src/engine/engine.ts';
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
    server.join(this);
  }

  flush() {
    if (this.inflight > 0) return false;
    const entries = this.engine.takePending();
    if (entries.length === 0) return false;
    this.inflight = entries.length;
    this.server.submit(this, this.lastSeq, entries);
    return true;
  }

  deliver(msg) {
    if (msg.type === 'reject') {
      this.engine.requeue();
      this.inflight = 0;
      return;
    }
    if (msg.seq !== this.lastSeq + 1) this.errors.push(`seq 건너뜀 ${this.lastSeq} → ${msg.seq}`);
    if (msg.clientId === this.id) {
      this.engine.ack(this.inflight);
      this.inflight = 0;
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
  constructor(base) {
    this.base = base;
    this.seq = 0;
    this.log = [];
    this.queues = new Map();
  }
  join(client) { this.queues.set(client, []); }
  submit(client, base, entries) {
    if (base !== this.seq) {
      this.queues.get(client).push({ type: 'reject', seq: this.seq });
      return;
    }
    this.seq += 1;
    const msg = { type: 'ops', seq: this.seq, clientId: client.id, entries: structuredClone(entries) };
    this.log.push(msg);
    for (const q of this.queues.values()) q.push(structuredClone(msg));
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
  /** 서버 로그를 새 문서에 재생한 digest (기록하지 않는 엔진으로). */
  replayDigest() {
    const doc = new wasm.HwpDocument(this.base);
    const engine = new CollabEngine();
    engine.attach(doc);
    for (const msg of this.log) engine.replay(msg.entries);
    const d = doc.collabDigest();
    engine.detach();
    doc.free();
    return d;
  }
}
