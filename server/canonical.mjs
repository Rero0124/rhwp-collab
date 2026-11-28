// S3-2 서버 정본 — 방마다 워커 하나(`canonical-worker.mjs`)에 정본 문서를 둔다. 패닉 격리: rhwp 가 패닉하면
// (WASM trap) 그 인스턴스 메모리를 더 믿을 수 없으므로 워커를 버리고 기준점 + 기록으로 새로 만든다.
// 워커가 응답하지 않으면(무한 루프 등) 시간 제한 뒤 같은 취급을 한다.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../upstream/rhwp/pkg');

export class Canonical {
  constructor({ pkg = DEFAULT_PKG, timeoutMs = 30_000, log = () => {} } = {}) {
    this.pkg = pkg;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    /** 워커를 새로 만든 횟수(패닉·시간 초과 뒤 재생성 포함) */
    this.generation = 0;
  }

  start() {
    const worker = new Worker(new URL('./canonical-worker.mjs', import.meta.url), { workerData: { pkg: this.pkg } });
    this.worker = worker;
    this.generation += 1;
    worker.on('message', ({ id, ...res }) => {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(res);
    });
    const fail = (reason) => {
      if (this.worker !== worker) return;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, panic: true, reason });
        this.pending.delete(id);
      }
      this.worker = null;
    };
    worker.on('error', (e) => fail(`정본 워커 오류: ${e?.message ?? e}`));
    worker.on('exit', (code) => fail(`정본 워커 종료(${code})`));
  }

  call(op, payload = {}) {
    if (!this.worker) this.start();
    const id = this.nextId++;
    const worker = this.worker;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.log(`정본 워커가 ${this.timeoutMs}ms 안에 답하지 않음(${op}) — 버림`);
        if (this.worker === worker) { this.worker = null; worker.terminate(); }
        // timeout: 시간 제한을 넘겼다(패닉과 달리 문서가 커서 오래 걸리는 경우가 대부분 — 호출한 쪽이 안내를 고른다)
        resolve({ ok: false, panic: true, timeout: true, reason: `정본 워커 시간 초과(${op})` });
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      worker.postMessage({ id, op, ...payload });
    });
  }

  load(base) { return this.call('load', { base }); }
  /**
   * 기록 열을 적용해 본다. confine(['form'] | ['comment'] | 둘 다)이 있으면 바뀐 곳이 그 부분뿐인지 결과로 확인하고,
   * 벗어나면 되돌린 뒤 {ok: false, forbidden: true, reason} 을 준다(5단계 D4).
   */
  apply(entries, { confine, memoOwner } = {}) {
    return this.call('apply', { entries, ...(confine?.length ? { confine } : {}), ...(typeof memoOwner === 'string' ? { memoOwner } : {}) });
  }
  /** 6단계 S2: 왕복 점검(모든 부분을 모델에서 다시 쓴 결과 vs 원본) — {supported, result, ms} */
  roundtrip() { return this.call('roundtrip'); }
  /** 5단계 D5: 암호 문서(원본 바이트)를 암호로 열어 결과 전송 형식(암호 없음, gzip base64)으로. 정본은 그대로. */
  decrypt(raw, password) { return this.call('decrypt', { data: Buffer.from(raw).toString('base64'), password }); }
  digest() { return this.call('digest'); }
  export() { return this.call('export'); }
  /** 7단계 C: 원본 형식 계열로 암호를 걸어 내보낸다 — {data: 파일 바이트 base64, format} */
  exportEncrypted(password) { return this.call('exportEncrypted', { password }); }

  /** 워커를 버리고 기준점 + 기록으로 새로 만든다(기록은 한 번에 — 쪽 배치는 끝에 한 번). 반환: 마지막 digest 또는 실패 사유. */
  async rebuild(base, log) {
    await this.terminate();
    const loaded = await this.load(base);
    if (!loaded.ok || log.length === 0) return loaded;
    const res = await this.call('replayAll', { log });
    return res.ok ? res : { ok: false, reason: `재생성 중 기록 적용 실패: ${res.reason}`, panic: res.panic };
  }

  async terminate() {
    const worker = this.worker;
    this.worker = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, panic: true, reason: '정본 워커를 닫음' });
      this.pending.delete(id);
    }
    if (worker) await worker.terminate();
  }
}
