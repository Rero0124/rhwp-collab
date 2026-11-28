/**
 * 6단계 N1: 공동편집 연결 상태 기계 — 플랫폼 중립(DOM·studio 를 모른다). docs/collab-stage6.md N1, 규약
 * docs/collab-protocol.md §4·§9.
 *
 * 연결·hello·welcome/catchup·재접속(지수 백오프)·세대·lastSeq, 보내기 묶음(inflight·batchId), reject·invalid·forbidden·
 * unauthorized·too-large, 재동기화(1분 3회), digest 보고, 커서 주고받기, replaced 확정, 확인된 사용자(welcome.user)를 맡는다.
 * 바깥에서는 Transport(연결 하나)·CollabHost(편집기)·TokenProvider·Clock 을 받는다. 문구는 정하지 않고 이유 코드로
 * 넘긴다(기본 문구는 ./texts.ts). 편집 기록 엔진(CollabEngine)은 세션이 만들어 `engine` 으로 내놓는다 — 호스트는 그것으로
 * 문서 호출을 가로채고 되돌리기를 붙인다.
 */
import { CollabEngine, type EngineDoc, type FastStats, type ReceiveResult, type TextCaret, type Entry } from '../engine/engine.ts';
import { ENGINE_FINGERPRINT } from '../engine/catalog.ts';
import { base64ToBytes, bytesToBase64 } from '../engine/codec.ts';
import { AuthSession, buildHello, editLevel, type SessionUser, type TokenProvider, type UnauthorizedReason } from './auth.ts';
import type { RoundtripResult } from './roundtrip.ts';
import type { LogItem, ServerMessage, WelcomeMessage } from './protocol.ts';
import { leaveText, resyncCauseText } from './texts.ts';

// ── 바깥에서 받는 것 ─────────────────────────────────────────────────────

/** 연결의 사건. 연결을 만든 함수가 돌아온 뒤에 부른다(WebSocket 과 같이). */
export interface TransportEvents {
  open(): void;
  /** 서버 메시지 하나(JSON 문자열) — 해석은 세션이 한다 */
  message(text: string): void;
  /** 닫힘·오류 모두, 한 번 */
  close(): void;
}
/** 서버와의 연결 하나. 끊기면 세션이 새로 만든다(재접속마다 하나). */
export interface Transport {
  readonly isOpen: boolean;
  /** 열려 있지 않으면 버린다 */
  send(text: string): void;
  close(): void;
}
export type TransportFactory = (events: TransportEvents) => Transport;

/** 시계·타이머(시험에서 바꿔 끼운다). 기본은 globalThis. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

/** 캐럿 스냅숏. text 는 엔진 좌표(바꿀 수 없으면 null). 호스트는 자기 좌표를 함께 넣어 두고, 세션은 그대로 돌려준다. */
export interface CaretSnapshot { readonly text: TextCaret | null }

/** 되돌리기 훅 — CollabUndo 를 그대로 넘길 수 있다 */
export interface UndoHooks {
  onRemote(result: ReceiveResult): void;
  clear(): void;
}

/** 편집기 쪽 */
export interface CollabHost {
  /** 지금 문서(공유 핸들). 없으면 null */
  doc(): EngineDoc | null;
  /** 첫 참여자: 열린 문서가 없으면 빈 문서를 만든다 */
  ensureDoc(): Promise<void>;
  /** 지금 문서가 암호 문서인가(모르면 false) */
  isEncrypted(): boolean;
  /** base 로 올릴 바이트(gzip 감싼 collabExportState) */
  exportState(): Uint8Array;
  /** 받은 바이트로 문서를 연다(gzip 이면 풀어서, 확인 창 없이). 끝나면 doc() 가 새 핸들 */
  openDoc(bytes: Uint8Array): Promise<void>;
  /** 같은 조판 규칙(글꼴 정책)이 걸렸나 — 아니면 세션이 방을 나간다 */
  layoutPolicyHolds(doc: EngineDoc): boolean;
  /** 원격 반영 구역: fn 안의 문서 변경은 사용자 편집이 아니다(기록·되돌리기·자동 저장 밖). 끝나면 화면 갱신 */
  applyExternal<T>(kind: 'resync' | 'replay' | 'remote' | 'replaced', fn: () => T): T;
  /** null = 캐럿 없음 */
  captureCaret(): CaretSnapshot | null;
  /** 원격 반영 뒤 캐럿을 놓는다. moved 가 null 이면 snap 자리로 */
  restoreCaret(snap: CaretSnapshot, moved: TextCaret | null): void;
  isComposing(): boolean;
  event(e: SessionEvent): void;
  /** 개발자 진단(문구 아님) */
  log?(level: 'info' | 'warn', message: string): void;
}

// ── 세션이 알리는 것(문구는 호스트가) ───────────────────────────────────────

export type SessionEvent =
  /** 상태 표시를 다시 그린다(phase·lastSeq·name) */
  | { type: 'status' }
  /** 다른 사람 커서가 바뀌었다(session.cursors) */
  | { type: 'cursors' }
  | { type: 'notice'; notice: Notice }
  /** 방에 들어간 뒤 끊겼다(배너) */
  | { type: 'disconnected' }
  /** 다시 붙었다(배너 걷기) */
  | { type: 'reconnected' }
  /** 확인된 사용자·권한(화면 일 — 양식 모드 등. 권한 문·메모 작성자는 세션이 이미 걸었다) */
  | { type: 'admitted'; user: SessionUser | null }
  /** 동기화가 깨져 멈췄다 */
  | { type: 'desynced'; cause: ResyncCause }
  /** 방에서 나왔다 — 호스트는 빌린 자원을 푼다 */
  | { type: 'left'; reason: LeaveReason };

export type Notice =
  /** 방에 들어왔다(studio: 자동 저장·글꼴 안내 두 줄) */
  | { code: 'joined' }
  | { code: 'resynced' }
  | { code: 'resume-fallback' }
  | { code: 'reconnected'; received: number }
  | { code: 'long-disconnect' }
  | { code: 'dropped'; count: number }
  | { code: 'too-large' }
  | { code: 'invalid' }
  | { code: 'forbidden'; reason: string }
  /** 엔진 권한 문(문구는 엔진 DENIED_TEXT) */
  | { code: 'denied'; message: string }
  | { code: 'view-only' }
  | { code: 'encrypted-source' }
  | { code: 'roundtrip'; result: RoundtripResult };

export type ResyncCause =
  | { code: 'seq-gap'; expected: number; got: number; during: 'ops' | 'catchup' }
  | { code: 'apply-failed'; error: string; during: 'remote' | 'replaced' }
  | { code: 'diverged'; seq: number }
  | { code: 'invalid'; reason: string }
  | { code: 'forbidden'; reason: string }
  | { code: 'too-large'; limit: number; side: 'local' | 'server' }
  | { code: 'error'; error: string }
  /** 재동기화가 상한(1분에 limit 회)을 넘었다 — desynced 에서만 */
  | { code: 'limit'; limit: number; last: ResyncCause };

export type LeaveReason =
  | { code: 'swapped' }
  | { code: 'incompatible' }
  | { code: 'encrypted' }
  | { code: 'base-too-large' }
  | { code: 'base-invalid'; reason: string }
  | { code: 'base-forbidden' }
  | { code: 'font-policy' }
  | { code: 'unauthorized'; reason: UnauthorizedReason; unsent: number }
  /** 호스트가 나가게 함(부품 전용 토큰 시간 초과 등) */
  | { code: 'host'; detail: string };

export type SessionPhase = 'left' | 'desynced' | 'connecting' | 'closed' | 'resyncing' | 'loading' | 'sending' | 'synced';
export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface RemoteCursor { name: string; caret: TextCaret | null }

/** 지금 상태(시험·진단). studio 의 `__collab.status()` 가 이것이다. */
export interface SessionStatus {
  room: string;
  name: string;
  clientId: string;
  lastSeq: number;
  inflight: number;
  ready: boolean;
  resyncing: boolean;
  left: boolean;
  desynced: boolean;
  desyncReason: string;
  connection: ConnectionState;
  pending: number;
  unsent: number;
  sentEntries: number;
  droppedTotal: number;
  replacedAcks: number;
  lastDigest: string;
  digestSentSeq: number;
  resyncCount: number;
  engine: string;
  cursors: { clientId: string; name: string; caret: TextCaret | null }[];
  reconnects: number;
  disconnectedAt: number;
  inflightBatch: string | null;
  user: SessionUser | null;
  fast: Omit<FastStats, 'mismatches'> & { enabled: boolean; mismatches: number };
  /** 7단계 A: 내 state 기록에 범위 표시를 단 수·못 단 수(사유별) */
  stateHints: { hinted: number; plain: number; reasons: Record<string, number> };
}

export interface CollabSessionOptions {
  room: string;
  /** 표시 이름(서버가 welcome.user.name 으로 바꿀 수 있다) */
  name: string;
  /** 진단용(연결은 transport 가 한다) */
  url?: string;
  /** 기본: crypto.randomUUID(없으면 대체 생성기) */
  clientId?: string;
  transport: TransportFactory;
  host: CollabHost;
  getToken?: TokenProvider;
  clock?: Clock;
  /** 엔진 R11 빠른 경로(기본 켬) */
  fast?: boolean;
  /** 오래 끊김 안내 기준(ms, 기본 10분) */
  longDisconnectMs?: number;
}

// ── 상수 ─────────────────────────────────────────────────────────────────
/** digest 보고 최소 간격 (1단계 §6.8) */
const DIGEST_INTERVAL_MS = 1000;
/** 재동기화 상한: 1분에 3회 (§7) */
const RESYNC_WINDOW_MS = 60_000;
const RESYNC_LIMIT = 3;
/** S3-4 재접속: 지수 백오프 상한, 오래 끊김 안내 기준 */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const LONG_DISCONNECT_MS = 10 * 60_000;
const LONG_DISCONNECT_PENDING = 2000;
/** 내 캐럿을 보내는 간격(ms) — 바뀌었을 때만. 서버는 참여자마다 초당 20회까지 중계한다. */
const CURSOR_INTERVAL_MS = 150;
/** 5단계 D4: 권한 문 안내를 다시 띄우기까지(같은 문구) */
const DENIED_NOTICE_MS = 3000;

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
};

/** crypto.randomUUID 가 없는 환경(오래된 런타임·비보안 컨텍스트)의 대체 — 방 안에서만 겹치지 않으면 된다 */
export function randomClientId(): string {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID;
  if (typeof uuid === 'function') return uuid.call((globalThis as { crypto?: unknown }).crypto);
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`;
}

const defer = (fn: () => void) => (typeof queueMicrotask === 'function' ? queueMicrotask(fn) : void Promise.resolve().then(fn));

export class CollabSession {
  readonly engine: CollabEngine;
  readonly clientId: string;
  readonly room: string;
  private _name: string;
  private readonly url: string;
  private readonly host: CollabHost;
  private readonly openTransport: TransportFactory;
  private readonly clock: Clock;
  private readonly auth: AuthSession;
  private readonly fast: boolean;
  private readonly longDisconnectMs: number;
  private undo: UndoHooks | null = null;

  // ── 상태 (§7) ──
  private _lastSeq = 0;
  private inflight = 0;
  /** S3-3: 방의 세대(welcome 이 알려 줌). 다시 붙을 때 실어 보낸다 — 세대가 바뀌었으면 따라잡기 대신 welcome. */
  private generation = 0;
  /** S3-4: 보낸 묶음의 이름(clientId:순번) — 끊긴 뒤 따라잡기에서 내 묶음이 받아졌는지 가린다 */
  private batchCounter = 0;
  private inflightBatch: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: unknown = null;
  /** 시험용: 이 시각까지 다시 붙지 않는다(끊긴 동안의 편집을 만들려고) */
  private reconnectHoldUntil = 0;
  private disconnectedAt = 0;
  private longDisconnectWarned = false;
  /** 다시 붙으며 lastSeq 를 실어 hello 를 보냈다 — 답(catchup 또는 welcome)을 기다리는 중 */
  private resuming = false;
  /** 나가거나 내릴 때 — 끊겨도 다시 붙지 않는다 */
  private closing = false;
  private disposed = false;
  private reconnects = 0;
  /** 서버 메시지 상한(welcome 이 알려 줌, R12) */
  private maxMessageBytes = Number.POSITIVE_INFINITY;
  private ready = false;
  private resyncing = false;
  private left = false;
  private desynced = false;
  private _desyncCause: ResyncCause | null = null;
  /** 우리가 일으킨 문서 교체 중 — 그 밖의 교체는 사용자가 다른 문서를 연 것이다(→ 방을 나감) */
  private ownSwap = false;
  private connection: ConnectionState = 'connecting';
  private readonly resyncTimes: number[] = [];
  private sentEntries = 0;
  private droppedTotal = 0;
  /** 6단계 S1: 서버가 다시 쓴 state 로 확정한 내 묶음 수(시험·진단용) */
  private replacedAcks = 0;
  private lastDigest = '';
  private digestSentSeq = -1;
  private digestSentAt = 0;
  private digestTimer: unknown = null;
  /** digestTimer 가 울릴 시각 */
  private digestDueAt = 0;
  private cursorTimer: unknown = null;
  /** 조합 중 보류한 원격 메시지 */
  private readonly held: ServerMessage[] = [];
  /** R10: 다른 사람 커서(텍스트 좌표). 받은 뒤의 원격·내 편집 지도로 계속 옮긴다. */
  private readonly _cursors = new Map<string, RemoteCursor>();
  private lastSentCaret = '';
  private lastLocalSeen: Entry | null = null;
  private flushQueued = false;
  private lastDenied = '';
  private lastDeniedAt = 0;
  private viewOnlyNoticed = false;
  private encryptedNoticed = false;
  private roundtripNoticed = false;
  private transport: Transport | null = null;
  /** 메시지는 줄을 세워 하나씩(welcome 의 비동기 문서 교체가 끝난 뒤 다음) */
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: CollabSessionOptions) {
    this.room = opts.room;
    this._name = opts.name;
    this.url = opts.url ?? '';
    this.clientId = opts.clientId ?? randomClientId();
    this.host = opts.host;
    this.openTransport = opts.transport;
    this.clock = opts.clock ?? systemClock;
    this.fast = opts.fast ?? true;
    this.longDisconnectMs = opts.longDisconnectMs ?? LONG_DISCONNECT_MS;
    this.auth = new AuthSession({ room: opts.room, getToken: opts.getToken });
    this.engine = new CollabEngine({
      onLocal: () => {
        if (this.flushQueued) return;
        this.flushQueued = true;
        defer(() => { this.flushQueued = false; this.flush(); });
      },
      onWarn: (m) => this.log('warn', m),
      // 5단계 D4: 권한 문이 막았다 — 문서는 그대로, 안내만(같은 안내는 잠깐 동안 한 번)
      onDenied: (message) => {
        const now = this.clock.now();
        if (message === this.lastDenied && now - this.lastDeniedAt < DENIED_NOTICE_MS) return;
        this.lastDenied = message;
        this.lastDeniedAt = now;
        this.notice({ code: 'denied', message });
      },
      fast: this.fast,
    });
  }

  // ── 읽기 ──
  get name(): string { return this._name; }
  get lastSeq(): number { return this._lastSeq; }
  get user(): SessionUser | null { return this.auth.user; }
  get cursors(): ReadonlyMap<string, RemoteCursor> { return this._cursors; }
  get desyncCause(): ResyncCause | null { return this._desyncCause; }
  get phase(): SessionPhase {
    if (this.left) return 'left';
    if (this.desynced) return 'desynced';
    if (this.connection === 'connecting') return 'connecting';
    if (this.connection === 'closed') return 'closed';
    if (this.resyncing) return 'resyncing';
    if (!this.ready) return 'loading';
    return this.inflight > 0 || this.engine.pendingCount > 0 ? 'sending' : 'synced';
  }

  /** 되돌리기 훅을 끼운다(start 전에). CollabUndo 는 engine 이 있어야 만들 수 있어 생성자 뒤에 받는다. */
  setUndo(undo: UndoHooks | null): void { this.undo = undo; }

  /** 표시 이름을 정한다(호스트가 이름을 물어본 뒤, start 전에). 다음 hello 부터 쓰이고, 서버가 welcome.user.name 으로 바꿀 수 있다. */
  setName(name: string): void {
    this._name = name;
    this.emit({ type: 'status' });
  }

  /** 첫 연결 */
  start(): void {
    this.cursorTimer = this.clock.setInterval(() => this.cursorTick(), CURSOR_INTERVAL_MS);
    this.connect();
    this.emit({ type: 'status' });
  }

  // ── 호스트가 알리는 편집기 일 ──
  /** 내 편집이 기록됐다(studio document-mutated): 보내고, 다른 사람 커서를 그만큼 옮긴다 */
  edited(): void {
    this.flush();
    const e = this.engine.lastLocal;
    if (!e || e === this.lastLocalSeen) return;
    this.lastLocalSeen = e;
    for (const c of this._cursors.values()) c.caret = this.engine.mapCaret([e], c.caret);
    this.emit({ type: 'cursors' });
  }
  /** 문서 표시가 바뀌었다(studio document-changed): 보낸다 */
  changed(): void { this.flush(); }
  /** 조합이 끝났다: 조합 중 보류한 원격 메시지를 순서대로 처리하고, 조합 중 쌓인 내 편집을 보낸다 */
  compositionEnded(): void {
    const pending = this.held.splice(0);
    for (const msg of pending) this.enqueue(msg);
    this.queue = this.queue.then(() => this.flush());
  }
  /** 편집기가 문서를 바꿨다: 세션이 일으킨 것(welcome·base 재열기)이 아니면 방을 나간다 */
  documentSwapped(): void {
    if (this.ownSwap || this.left || !this.ready) return;
    this.leave({ code: 'swapped' });
  }

  /** 이탈 확인: 아직 서버에 확정되지 않은 내 편집(보내는 중·끊긴 동안 쌓인 것)이 있나 */
  hasUnconfirmedEdits(): boolean {
    return !this.left && (this.engine.pendingCount > 0 || this.inflight > 0);
  }

  /** 방에서 나간다(예상치 못한 문서 교체 등). 엔진의 문서·권한을 풀고 호스트에 'left' 를 알린다. */
  leave(reason: LeaveReason): void {
    if (this.left) return;
    this.left = true;
    this.closing = true;
    if (this.reconnectTimer !== null) this.clock.clearTimeout(this.reconnectTimer);
    if (this._cursors.size > 0) { this._cursors.clear(); this.emit({ type: 'cursors' }); }
    this.ready = false;
    this.engine.detach();
    this.engine.setScope(null);
    this.engine.setMemoAuthor(null);
    if (this.digestTimer !== null) this.clock.clearTimeout(this.digestTimer);
    if (this.cursorTimer !== null) this.clock.clearInterval(this.cursorTimer);
    try { this.transport?.close(); } catch { /* noop */ }
    this.emit({ type: 'left', reason });
    this.log('info', `방을 나감: ${leaveText(reason)}`);
    this.emit({ type: 'status' });
  }

  /** 내린다(안내 없이). 그 뒤로는 호스트에 아무것도 알리지 않는다. */
  dispose(): void {
    if (this.cursorTimer !== null) this.clock.clearInterval(this.cursorTimer);
    if (this.digestTimer !== null) this.clock.clearTimeout(this.digestTimer);
    this.engine.detach();
    this.engine.setScope(null);
    this.engine.setMemoAuthor(null);
    this.closing = true;
    this.disposed = true;
    if (this.reconnectTimer !== null) this.clock.clearTimeout(this.reconnectTimer);
    try { this.transport?.close(); } catch { /* noop */ }
  }

  status(): SessionStatus {
    const { mismatches, ...fastStats } = this.engine.fastStats;
    return {
      room: this.room, name: this._name, clientId: this.clientId, lastSeq: this._lastSeq, inflight: this.inflight,
      ready: this.ready, resyncing: this.resyncing, left: this.left, desynced: this.desynced,
      desyncReason: this._desyncCause ? resyncCauseText(this._desyncCause) : '', connection: this.connection,
      pending: this.engine.pendingCount, unsent: this.engine.unsentCount, sentEntries: this.sentEntries,
      droppedTotal: this.droppedTotal, replacedAcks: this.replacedAcks,
      lastDigest: this.lastDigest, digestSentSeq: this.digestSentSeq, resyncCount: this.resyncTimes.length, engine: ENGINE_FINGERPRINT,
      cursors: [...this._cursors.entries()].map(([id, c]) => ({ clientId: id, name: c.name, caret: c.caret })),
      reconnects: this.reconnects, disconnectedAt: this.disconnectedAt, inflightBatch: this.inflightBatch, user: this.auth.user,
      fast: { enabled: this.fast, ...fastStats, mismatches: mismatches.length },
      stateHints: { ...this.engine.stateHints, reasons: { ...this.engine.stateHints.reasons } },
    };
  }

  /** 시험용(S3-4): 연결을 끊고 ms 동안 다시 붙지 않는다 — 그동안의 편집은 쌓였다가 다시 붙으면 보내진다. */
  simulateDisconnect(holdMs = 0): void {
    this.reconnectHoldUntil = this.clock.now() + holdMs;
    this.transport?.close();
  }

  // ── 안쪽 ─────────────────────────────────────────────────────────────

  private emit(e: SessionEvent): void { if (!this.disposed) this.host.event(e); }
  private notice(notice: Notice): void { this.emit({ type: 'notice', notice }); }
  private log(level: 'info' | 'warn', message: string): void { this.host.log?.(level, message); }

  private send(msg: Record<string, unknown>): void {
    if (this.transport?.isOpen) this.transport.send(JSON.stringify(msg));
  }

  private markDesynced(cause: ResyncCause): void {
    if (this.desynced) return;
    this.desynced = true;
    this._desyncCause = cause;
    this.engine.setRecording(false);
    this.log('warn', `동기화 깨짐: ${resyncCauseText(cause)}`);
    this.emit({ type: 'desynced', cause });
    this.emit({ type: 'status' });
  }

  // ── 보내기 (§7 flush) ──
  private flush(): void {
    // 다시 붙은 뒤 서버 답(catchup·welcome)을 받기 전에는 보내지 않는다(resuming) — 옛 base 묶음의 늦은 reject 가
    // 따라잡기 뒤의 새 묶음을 건드리지 않게.
    if (!this.ready || this.left || this.desynced || this.resyncing || this.resuming || this.inflight > 0
      || this.connection !== 'open' || this.host.isComposing()) return;
    const entries = this.engine.takePending();
    if (entries.length === 0) return;
    const batchId = `${this.clientId}:${++this.batchCounter}`;
    const payload = JSON.stringify({ type: 'ops', base: this._lastSeq, entries, batchId });
    if (payload.length > this.maxMessageBytes) {
      // 보내지 않는다. 미확정을 버리고 서버 문서로 되돌린다(R12).
      this.notice({ code: 'too-large' });
      this.requestResync({ code: 'too-large', limit: this.maxMessageBytes, side: 'local' });
      return;
    }
    this.transport?.send(payload);
    this.inflight = entries.length;
    this.inflightBatch = batchId;
    this.sentEntries += entries.length;
    this.emit({ type: 'status' });
  }

  /** 오래 끊김 안내와 내 캐럿 보내기(바뀌었을 때만) */
  private cursorTick(): void {
    if (this.ready && !this.left && this.connection !== 'open' && !this.longDisconnectWarned && this.disconnectedAt
      && (this.clock.now() - this.disconnectedAt > this.longDisconnectMs || this.engine.pendingCount > LONG_DISCONNECT_PENDING)) {
      this.longDisconnectWarned = true;
      this.notice({ code: 'long-disconnect' });
    }
    if (!this.ready || this.left || this.desynced || this.connection !== 'open') return;
    if (!this.host.doc()) return;
    // 머리말·꼬리말·각주 안(엔진 좌표로 못 바꿈)은 위치를 보내지 않는다 — 숨김(null)만 알린다.
    const c = this.host.captureCaret()?.text ?? null;
    const key = JSON.stringify(c);
    if (key === this.lastSentCaret) return;
    this.lastSentCaret = key;
    this.send({ type: 'cursor', seq: this._lastSeq, caret: c });
  }

  // ── digest 보고 (1단계 §6.8) ──
  private idle(): boolean {
    return this.ready && !this.left && !this.desynced && !this.resyncing && this.connection === 'open'
      && this.inflight === 0 && this.engine.pendingCount === 0 && !this.host.isComposing();
  }
  private tryReportDigest(): void {
    if (!this.idle() || this._lastSeq === this.digestSentSeq) return;
    const doc = this.host.doc();
    if (!doc) return;
    const digest = doc.collabDigest();
    this.send({ type: 'digest', seq: this._lastSeq, digest });
    this.lastDigest = digest;
    this.digestSentSeq = this._lastSeq;
    this.digestSentAt = this.clock.now();
  }
  /**
   * 보고할 때를 잡는다: 마지막 보고에서 간격(DIGEST_INTERVAL_MS)이 지난 뒤. 울렸는데 아직 바쁘면(보내는 중·끊김·조합·
   * 재동기화) 한 간격 뒤에 다시 본다 — 바로 다시 걸면 브라우저에서 약 4ms 마다 돈다. 바쁜 동안 걸어 둔 늦은 타이머는,
   * 일이 끝나 한가해진 자리(확정·따라잡기·welcome 이 이것을 부른다)에서 당겨 지금처럼 곧 보고하게 한다.
   */
  private scheduleDigest(wait = Math.max(0, this.digestSentAt + DIGEST_INTERVAL_MS - this.clock.now())): void {
    const due = this.clock.now() + wait;
    if (this.digestTimer !== null) {
      if (due >= this.digestDueAt || !this.idle()) return;
      this.clock.clearTimeout(this.digestTimer);
    }
    this.digestDueAt = due;
    this.digestTimer = this.clock.setTimeout(() => {
      this.digestTimer = null;
      this.tryReportDigest();
      if (!this.idle()) this.scheduleDigest(DIGEST_INTERVAL_MS);
    }, wait);
  }

  // ── 재동기화 (§7) ──
  private requestResync(cause: ResyncCause): void {
    if (this.left || this.desynced || this.resyncing) return;
    const now = this.clock.now();
    while (this.resyncTimes.length && now - this.resyncTimes[0] > RESYNC_WINDOW_MS) this.resyncTimes.shift();
    if (this.resyncTimes.length >= RESYNC_LIMIT) {
      this.markDesynced({ code: 'limit', limit: RESYNC_LIMIT, last: cause });
      return;
    }
    this.resyncTimes.push(now);
    this.resyncing = true;
    this.engine.setRecording(false);
    this.held.length = 0;
    this.log('info', `재동기화 요청: ${resyncCauseText(cause)}`);
    this.send({ type: 'resync' });
    this.emit({ type: 'status' });
  }

  /** 기준점 + 뒤 항목을 지금 문서 객체 안에서 적재·재생한다(편집기 문서 교체 없이). */
  private applyWelcomeInPlace(msg: WelcomeMessage): void {
    const doc = this.host.doc();
    if (!doc || msg.base === null) throw new Error('재동기화할 문서가 없습니다');
    const base = msg.base;
    this.engine.attach(doc);
    this.host.applyExternal('resync', () => {
      doc.collabLoadState(base64ToBytes(base));
      this.engine.replayAll(msg.log);
    });
    // 3.4: 문서가 통째로 바뀌었으니 되돌리기 위치는 의미가 없다
    this.undo?.clear();
    this._lastSeq = msg.seq;
    this.inflight = 0;
    this.inflightBatch = null;
  }

  // ── 메시지 처리 ──
  private async onWelcome(msg: WelcomeMessage): Promise<void> {
    this.onAdmitted(msg.user);
    if (msg.encryptedSource) this.noticeEncrypted();
    if (msg.roundtrip && msg.roundtrip.ok !== true) this.noticeRoundtrip(msg.roundtrip);
    if (typeof msg.maxMessageBytes === 'number') this.maxMessageBytes = msg.maxMessageBytes;
    if (typeof msg.generation === 'number') this.generation = msg.generation;
    // S3-4: 다시 붙었는데 서버가 따라잡기를 못 해 주면(기준점이 그 뒤로 옮겨 감) 재동기화와 같다 — 미확정을 버린다.
    const resumeFallback = this.resuming && this.ready && msg.base !== null;
    this.resuming = false;
    // 재동기화 요청 중에 끊겼다 다시 붙은 경우의 welcome 도 제자리 재동기화다.
    if (msg.resync || resumeFallback || (this.resyncing && this.ready && msg.base !== null)) {
      this.applyWelcomeInPlace(msg);
      this.resyncing = false;
      this.engine.setRecording(true);
      if (resumeFallback) { this.reconnected(); this.notice({ code: 'resume-fallback' }); } else this.notice({ code: 'resynced' });
      this.emit({ type: 'status' });
      this.scheduleDigest();
      return;
    }
    this.engine.detach();
    this.ownSwap = true;
    try {
      if (msg.base === null) {
        // 첫 참여자: 지금 문서를 base 로 올리고 같은 바이트로 다시 연다(모두 같은 파싱 결과에서 출발).
        await this.host.ensureDoc();
        // 5단계 D5: 암호 문서는 서버가 허용할 때만 올린다
        const encrypted = this.host.isEncrypted();
        if (encrypted && !msg.allowEncrypted) { this.leave({ code: 'encrypted' }); return; }
        const packed = this.host.exportState();
        const data = bytesToBase64(packed);
        if (data.length + 64 > this.maxMessageBytes) { this.leave({ code: 'base-too-large' }); return; }
        this.send({ type: 'base', data, ...(encrypted ? { encryptedSource: true } : {}) });
        if (encrypted) this.noticeEncrypted();
        this.log('info', `base 전송 ${packed.length}B`);
        await this.host.openDoc(packed);
        const doc = this.host.doc();
        if (!doc) throw new Error('문서를 열지 못했습니다');
        if (!this.host.layoutPolicyHolds(doc)) { this.leave({ code: 'font-policy' }); return; }
        this.engine.attach(doc);
      } else {
        await this.host.openDoc(base64ToBytes(msg.base));
        const doc = this.host.doc();
        if (!doc) throw new Error('문서를 열지 못했습니다');
        if (!this.host.layoutPolicyHolds(doc)) { this.leave({ code: 'font-policy' }); return; }
        this.engine.attach(doc);
        if (msg.log.length > 0) this.host.applyExternal('replay', () => this.engine.replayAll(msg.log));
        this.log('info', `welcome seq=${msg.seq}, 기준점 뒤 ${msg.log.length}건 재생`);
      }
      this._lastSeq = msg.seq;
    } finally {
      this.ownSwap = false;
    }
    this.ready = true;
    this.engine.setRecording(true);
    this.emit({ type: 'status' });
    this.notice({ code: 'joined' });
    this.scheduleDigest();
  }

  private onOps(msg: Extract<ServerMessage, { type: 'ops' }>): void {
    if (msg.seq !== this._lastSeq + 1) {
      this.requestResync({ code: 'seq-gap', expected: this._lastSeq + 1, got: msg.seq, during: 'ops' });
      return;
    }
    if (msg.clientId === this.clientId) {
      if (msg.replaced === true) {
        if (!this.applyReplaced(msg)) return;
      } else {
        this.engine.ack(this.inflight);
      }
      this.inflight = 0;
      this.inflightBatch = null;
      this._lastSeq = msg.seq;
      this.emit({ type: 'status' });
      this.flush();
      this.scheduleDigest();
      return;
    }
    if (!this.applyRemote(msg)) return;
    this.emit({ type: 'status' });
    this.flush();
    this.scheduleDigest();
  }

  /** 남의 묶음 하나를 받는다(되감기·보정, 캐럿·다른 사람 커서 옮기기). 실패하면 재동기화를 걸고 false. */
  private applyRemote(msg: { seq: number; entries: Entry[] }): boolean {
    if (!this.host.doc()) return false;
    const snap = this.host.captureCaret();
    const result = this.host.applyExternal('remote', () => this.engine.receiveRemote(msg.entries, snap?.text ?? null));
    this._lastSeq = msg.seq;
    if (!result.ok) {
      this.requestResync({ code: 'apply-failed', error: String(result.error), during: 'remote' });
      return false;
    }
    // 4단계: 되돌리기 스택의 위치를 같은 지도로 옮기고 막힘을 판정, 버려진 편집의 명령을 뺀다
    this.undo?.onRemote(result);
    if (snap) this.host.restoreCaret(snap, result.caret);
    for (const c of this._cursors.values()) c.caret = this.engine.mapCaret(msg.entries, c.caret);
    this.emit({ type: 'cursors' });
    if (result.dropped > 0) {
      this.droppedTotal += result.dropped;
      this.notice({ code: 'dropped', count: result.dropped });
      const names = (es: readonly Entry[] | undefined) => (es ?? []).map((e) => (e.kind === 'state' ? 'state' : e.m)).join(',');
      this.log('warn', `충돌: ${result.dropReason} — 취소 [${names(result.droppedEntries)}], 원격 [${names(msg.entries)}]`);
    }
    return true;
  }

  /**
   * 6단계 S1: 내 묶음의 state 를 서버가 모델에서 다시 쓴 바이트(S)로 바꿔 확정했다. 원격 state 와 같은 경로로 편집기에
   * 반영한다 — 확정 상태를 R(S) 로 두고 뒤의 미확정을 그대로 다시 얹는다(엔진 `ackReplaced`). 같은 모델이라 캐럿·되돌리기
   * 위치는 그대로이고, 다시 얹다 버린 편집만 알린다.
   */
  private applyReplaced(msg: { seq: number; entries: Entry[] }): boolean {
    if (!this.host.doc()) return false;
    const snap = this.host.captureCaret();
    const result = this.host.applyExternal('replaced', () => this.engine.ackReplaced(msg.entries, snap?.text ?? null));
    this.replacedAcks += 1;
    if (!result.ok) {
      this.requestResync({ code: 'apply-failed', error: String(result.error), during: 'replaced' });
      return false;
    }
    this.undo?.onRemote(result);
    if (snap) this.host.restoreCaret(snap, result.caret);
    if (result.dropped > 0) {
      this.droppedTotal += result.dropped;
      this.notice({ code: 'dropped', count: result.dropped });
      this.log('warn', `서버가 다시 쓴 결과 위에 다시 얹기 실패: ${result.dropReason}`);
    }
    return true;
  }

  /** 다시 붙음: 끊김 표시를 걷는다. */
  private reconnected(): void {
    this.disconnectedAt = 0;
    this.longDisconnectWarned = false;
    this.reconnects += 1;
    this.emit({ type: 'reconnected' });
  }

  /**
   * S3-4 따라잡기: 끊긴 동안의 묶음을 원격 수신과 같이 받는다(되감기·보정). 끊기는 순간 보낸 묶음(inflightBatch)이
   * 그 안에 있으면 남의 편집이 아니라 확정(ack)이다 — 다시 적용하지 않는다. 없으면 받아지지 않은 것이라 다시 보낸다.
   */
  private onCatchup(msg: Extract<ServerMessage, { type: 'catchup' }>): void {
    this.onAdmitted(msg.user);
    this.resuming = false;
    if (typeof msg.maxMessageBytes === 'number') this.maxMessageBytes = msg.maxMessageBytes;
    let acked = false;
    for (const item of msg.log) {
      if (item.seq !== this._lastSeq + 1) {
        this.requestResync({ code: 'seq-gap', expected: this._lastSeq + 1, got: item.seq, during: 'catchup' });
        return;
      }
      const mine = item.batchId !== undefined ? item.batchId === this.inflightBatch : item.clientId === this.clientId;
      if (mine && this.inflight > 0) {
        if (item.replaced === true) {
          if (!this.applyReplaced(item)) return;
        } else {
          this.engine.ack(this.inflight);
        }
        this.inflight = 0;
        this.inflightBatch = null;
        this._lastSeq = item.seq;
        acked = true;
        continue;
      }
      if (!this.applyRemote(item)) return;
    }
    if (this.inflight > 0) {
      // 끊기기 전에 보낸 묶음이 서버에 닿지 않았다 — 미확정 앞에 되돌려 다시 보낸다.
      this.engine.requeue();
      this.inflight = 0;
      this.inflightBatch = null;
    }
    if (msg.cont) {
      // 나눠 보낸 welcome 의 이어지는 조각(S3-3 — 기준점 + 긴 기록이 메시지 상한을 넘을 때)
      this.emit({ type: 'status' });
      this.flush();
      this.scheduleDigest();
      return;
    }
    this.reconnected();
    this.log('info', `따라잡기 seq ${msg.seq}: ${msg.log.length}건${acked ? ' (끊길 때 보낸 내 묶음 확정)' : ''}`);
    this.notice({ code: 'reconnected', received: msg.log.length });
    this.emit({ type: 'status' });
    this.flush();
    this.scheduleDigest();
  }

  // ── 5단계 D1: 인증 결과 ──
  /** D5: 원래 암호 문서였다는 경고를 한 번 */
  private noticeEncrypted(): void {
    if (this.encryptedNoticed) return;
    this.encryptedNoticed = true;
    this.notice({ code: 'encrypted-source' });
  }
  /** 6단계 S2: 방을 열 때의 왕복 점검에 경고가 있던 문서 — 처음 들어올 때 한 번 */
  private noticeRoundtrip(result: RoundtripResult): void {
    if (this.roundtripNoticed) return;
    this.roundtripNoticed = true;
    this.notice({ code: 'roundtrip', result });
  }
  /** 방에 들어갔다: 서버가 확인한 이름·권한을 받는다(인증을 끈 서버는 user 가 없다 = edit). */
  private onAdmitted(user: SessionUser | undefined): void {
    this.auth.admitted(user ?? null);
    // 5단계 D4: 권한 문(엔진 — 모든 호출 경로가 지나는 자리)은 세션이 건다. 화면 일(양식 모드)은 호스트가.
    this.engine.setScope(user?.scope ?? null);
    this.emit({ type: 'admitted', user: user ?? null });
    if (!user) { this.engine.setMemoAuthor(null); return; }
    if (user.name && user.name !== this._name) { this._name = user.name; this.emit({ type: 'status' }); }
    // D6: 메모 작성자 = 서버가 아는 이 연결의 이름(토큰의 name, 없으면 hello 에 보낸 이름). 편집기의 로컬 이름이 아니다.
    this.engine.setMemoAuthor(this._name);
    if (editLevel(user.scope) === 'none' && !this.viewOnlyNoticed) { this.viewOnlyNoticed = true; this.notice({ code: 'view-only' }); }
  }
  /** unauthorized: 만료면 한 번 새 토큰으로 다시 붙고(닫힘 처리의 재접속이 새 토큰을 쓴다), 아니면 멈춘다. */
  private async onUnauthorized(reason: string): Promise<void> {
    const decision = await this.auth.onUnauthorized(reason);
    if (this.left) return; // 토큰을 기다리다 이미 나갔다(부품 전용 모드의 시간 제한) — 그 안내를 덮지 않는다
    if (decision.action !== 'give-up') {
      this.log('info', `인증 ${reason} → ${decision.action === 'reconnect' ? '새 토큰으로 다시 붙음' : '다시 붙음(백오프)'}`);
      return;
    }
    this.leave({ code: 'unauthorized', reason: decision.reason, unsent: this.engine.pendingCount });
  }

  private async handle(msg: ServerMessage): Promise<void> {
    if (this.left || this.desynced) return;
    if (msg.type === 'unauthorized') return this.onUnauthorized(msg.reason); // 5단계 D1 — 재동기화 중이어도
    if (this.resyncing && msg.type !== 'welcome') return; // 재동기화 welcome 이 이 사이 항목을 포함한다
    switch (msg.type) {
      case 'welcome': return this.onWelcome(msg);
      case 'ops': return this.onOps(msg);
      case 'catchup': return this.onCatchup(msg);
      case 'reject':
        if (msg.batchId !== undefined && msg.batchId !== this.inflightBatch) return; // 늦게 온 옛 묶음의 reject
        this.engine.requeue();
        this.inflight = 0;
        this.inflightBatch = null;
        this.flush();
        return;
      case 'diverged': return this.requestResync({ code: 'diverged', seq: msg.seq });
      case 'incompatible':
        this.leave({ code: 'incompatible' });
        return;
      case 'invalid':
        if (msg.what === 'base') { this.leave({ code: 'base-invalid', reason: msg.reason }); return; }
        if (msg.batchId !== undefined && msg.batchId !== this.inflightBatch) return;
        this.notice({ code: 'invalid' });
        this.requestResync({ code: 'invalid', reason: msg.reason });
        return;
      case 'forbidden':
        // 5단계 D0·D4: 권한 밖 편집 — invalid 와 같이 그 묶음과 뒤를 버리고 서버 문서로(정상 클라이언트는 문에서 먼저 막혀 드물다).
        if (msg.what === 'base') { this.leave({ code: 'base-forbidden' }); return; }
        if (msg.batchId !== undefined && msg.batchId !== this.inflightBatch) return;
        this.notice({ code: 'forbidden', reason: msg.reason });
        this.requestResync({ code: 'forbidden', reason: msg.reason });
        return;
      case 'too-large':
        if (msg.what === 'base') { this.leave({ code: 'base-too-large' }); return; }
        this.notice({ code: 'too-large' });
        this.requestResync({ code: 'too-large', limit: msg.limit, side: 'server' });
        return;
      case 'cursor': {
        if (msg.clientId === this.clientId) return;
        const known = this._cursors.get(msg.clientId);
        // 보낸 쪽 seq 뒤로 내가 이미 받은 원격은 지도로 옮기지 않는다(근사 — 다음 커서 메시지가 곧 바로잡는다)
        this._cursors.set(msg.clientId, { ...known, name: msg.name, caret: msg.caret });
        this.emit({ type: 'cursors' });
        return;
      }
      case 'cursor-leave':
        if (this._cursors.delete(msg.clientId)) this.emit({ type: 'cursors' });
        return;
      case 'roundtrip':
        // 6단계 S2: 방을 연 뒤 뒤에서 끝난 왕복 점검(경고·점검 못 함). welcome 에서 이미 받았으면 다시 알리지 않는다.
        if (msg.roundtrip && msg.roundtrip.ok !== true) this.noticeRoundtrip(msg.roundtrip);
        return;
      case 'error': this.log('info', `서버 오류: ${msg.error}`); return;
    }
  }

  private enqueue(msg: ServerMessage): void {
    this.queue = this.queue.then(() => this.handle(msg)).catch((error) => {
      this.requestResync({ code: 'error', error: error instanceof Error ? error.message : String(error) });
    });
  }

  /** 조합 중에는 보류한다(조합이 끝나면 compositionEnded) */
  private onTransportMessage(text: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(text) as ServerMessage;
    } catch {
      this.log('info', '서버 메시지 해석 실패');
      return;
    }
    if (this.ready && this.host.isComposing() && msg.type !== 'incompatible' && msg.type !== 'too-large' && msg.type !== 'unauthorized') {
      this.held.push(msg);
      return;
    }
    this.enqueue(msg);
  }

  // ── 서버 연결 ──
  // S3-4: 끊기면 지수 백오프로 다시 붙는다. 그동안 엔진 상태(미확정·lastSeq)는 그대로 두고 편집은 계속 쌓인다.
  private connect(): void {
    this.reconnectTimer = null;
    if (this.closing || this.left) return;
    this.connection = 'connecting';
    this.emit({ type: 'status' });
    const conn: Transport = this.openTransport({
      message: (text) => { if (conn === this.transport) this.onTransportMessage(text); },
      open: () => {
        if (conn !== this.transport) return;
        // 5단계 D1: 토큰을 받은 뒤 hello(공급자는 비동기일 수 있다 — 그동안은 아직 열리지 않은 것으로 둔다).
        void this.auth.helloToken().then((token) => {
          if (conn !== this.transport || !conn.isOpen || this.closing || this.left) return;
          this.connection = 'open';
          this.reconnectAttempts = 0;
          // 이미 방에 들어와 있었으면(재접속) 마지막으로 받은 seq 를 싣는다 → 서버가 따라잡기(catchup) 또는 welcome.
          this.resuming = this.ready && !this.resyncing && !this.desynced;
          this.emit({ type: 'status' });
          this.send(buildHello({
            room: this.room, clientId: this.clientId, name: this._name, engine: ENGINE_FINGERPRINT, token,
            resume: this.resuming ? { lastSeq: this._lastSeq, generation: this.generation } : null,
          }));
          this.log('info', `연결 ${this.url} room=${this.room} 엔진 ${ENGINE_FINGERPRINT}${token ? ' (토큰)' : ''}${this.resuming ? ` (다시 붙음, lastSeq ${this._lastSeq})` : ''}`);
        });
      },
      close: () => {
        if (conn !== this.transport) return;
        this.connection = 'closed';
        this.emit({ type: 'status' });
        if (this.closing || this.left) return;
        if (!this.disconnectedAt) this.disconnectedAt = this.clock.now();
        // 재동기화 중에 끊겼으면 그 요청은 사라졌다 — resyncing 을 그대로 두면 다시 붙을 때 lastSeq 없이 hello 를 보내고,
        // 받은 welcome 을 제자리 재동기화로 처리한다(onWelcome).
        if (this._cursors.size > 0) { this._cursors.clear(); this.emit({ type: 'cursors' }); }
        if (this.ready) this.emit({ type: 'disconnected' });
        const delay = Math.max(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts), this.reconnectHoldUntil - this.clock.now());
        this.reconnectAttempts += 1;
        this.log('info', `연결 끊김 — ${Math.round(delay)}ms 뒤 다시 연결`);
        this.reconnectTimer = this.clock.setTimeout(() => this.connect(), delay);
      },
    });
    this.transport = conn;
  }
}

export type { LogItem };
