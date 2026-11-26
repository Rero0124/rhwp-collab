/**
 * cc-rhwp 공동편집 studio 플러그인 — 2단계 (docs/collab-stage2.md §7, 1단계 docs/collab-design.md §6 의
 * 연결·digest·초안 규칙을 잇는다).
 *
 * 통신과 studio 연결만 한다. 기록·되감기·보정은 엔진(`./engine`)이 하고, 엔진은 studio 를 모른다.
 * 기록은 studio 가 감싼 문서 메서드 호출(`host.interceptDocumentCalls`)에서 일어난다 — 공유 핸들의 호출만.
 *
 * studio 를 import 하지 않는다 — 타입만 `import type` 이다(플러그인 계약 `plugin/types.ts`).
 * 연결 설정은 URL 에서 읽는다: `?collab=ws://localhost:8787&room=demo&name=A` (`&collabFast=0` 이면 R11 빠른
 * 경로를 끄고 언제나 되감는다)
 */
import type { DocumentLease, PluginCaret, PluginHost, PluginSurface, StudioPlugin } from '@/plugin/types';
import { CollabEngine, type Entry, type EngineDoc, type TextCaret } from './engine/engine.ts';
import { CATALOG, ENGINE_FINGERPRINT } from './engine/catalog.ts';
import { base64ToBytes, bytesToBase64 } from './engine/codec.ts';
import { FONT_POLICY } from './engine/types.ts';

type LogItem = { seq: number; clientId: string; entries: Entry[]; batchId?: string };
type ServerMessage =
  | { type: 'welcome'; seq: number; base: string | null; log: LogItem[]; resync?: boolean; maxMessageBytes?: number; generation?: number }
  | { type: 'ops'; seq: number; clientId: string; entries: Entry[]; batchId?: string }
  | { type: 'catchup'; seq: number; log: LogItem[]; maxMessageBytes?: number; cont?: boolean }
  | { type: 'reject'; seq: number; batchId?: string }
  | { type: 'diverged'; seq: number }
  | { type: 'incompatible'; engine: string }
  | { type: 'too-large'; what: string; bytes: number; limit: number }
  | { type: 'invalid'; what: 'ops' | 'base'; reason: string; batchId?: string }
  | { type: 'cursor'; clientId: string; name: string; seq: number; caret: TextCaret | null }
  | { type: 'cursor-leave'; clientId: string }
  | { type: 'error'; error: string };

/** digest 보고 최소 간격 (1단계 §6.8) */
const DIGEST_INTERVAL_MS = 1000;
/** 재동기화 상한: 1분에 3회 (§7) */
const RESYNC_WINDOW_MS = 60_000;
const RESYNC_LIMIT = 3;
/** 공유 문서 열기는 확인 창 없이 (1단계 §6.2) */
const OPEN_OPTIONS = { suppressDialogs: true } as const;
const AUTOSAVE_NOTICE = '공동편집 중에는 로컬 자동 저장을 하지 않습니다 — 서버 문서가 기준입니다';
/** S3-1: 공동편집 중 조판은 엔진 내장 글꼴 규칙 — 문서 글꼴이 설치된 기기에서는 혼자 편집할 때와 배치가 다를 수 있다. */
const FONT_POLICY_NOTICE = '공동편집 중에는 모든 참여자가 같은 결과를 보도록 내장 글꼴 규칙으로 배치합니다 — 문서 글꼴이 설치된 기기에서는 혼자 편집할 때와 줄·쪽 나눔이 다를 수 있습니다';
const NOTICE_MS = 8000;
/** S3-4 재접속: 지수 백오프 상한, 오래 끊김 안내 기준 */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const LONG_DISCONNECT_MS = 10 * 60_000;
const LONG_DISCONNECT_PENDING = 2000;
const DISCONNECT_BANNER = '연결이 끊겼습니다. 편집은 다시 연결되면 보내집니다';
const LONG_DISCONNECT_NOTICE = '오래 끊겨 있습니다 — 다시 연결되면 동시 편집 충돌로 취소되는 편집이 많을 수 있습니다';
const RESUME_FALLBACK_NOTICE = '오래 끊겨 서버 문서로 다시 맞췄습니다. 끊긴 동안의 편집 일부가 취소됐을 수 있습니다';
/** S3-2: 서버 정본이 내 편집을 거절했다 — 재동기화로 그 편집을 버리고 서버 문서로 맞춘다. */
const INVALID_NOTICE = '서버가 편집 하나를 적용하지 못해 거절했습니다. 서버 문서로 다시 맞춥니다';
/** 내 캐럿을 보내는 간격(ms) — 바뀌었을 때만. 서버는 참여자마다 초당 20회까지 중계한다. */
const CURSOR_INTERVAL_MS = 150;
const CURSOR_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00897b', '#6d4c41', '#3949ab'];
const TOO_LARGE_NOTICE = '문서가 커서 이 편집은 공동편집으로 보낼 수 없습니다';

/**
 * S3-1: 글꼴 정책이 문서에 실제로 걸렸는지 — 선언 글꼴 환경이 없고(엔진 기본) Canvas 보충 측정이 꺼져 있다.
 * 패치가 빠진 studio 처럼 정책이 먹지 않으면 조판이 기기마다 달라지므로 방에 들어가지 않는다.
 */
function fontPolicyHolds(doc: EngineDoc): boolean {
  const d = doc as unknown as { getDocumentFontSelectionPlan?: () => string; canvasMetricsActive?: () => boolean };
  try {
    const plan = d.getDocumentFontSelectionPlan ? JSON.parse(d.getDocumentFontSelectionPlan()) as { environmentId: string | null } : null;
    return (plan?.environmentId ?? null) === null && !(d.canvasMetricsActive?.() ?? false);
  } catch {
    return false;
  }
}

/** R12: 결과·base 는 gzip 으로 감싸 온다(`collabExportState`). studio 열기에는 원본 바이트가 필요하다. */
const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isGzip(bytes)) return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** 원본 형식 계열(HWPX 는 zip)에 맞는 파일 이름 */
const fileNameFor = (room: string, raw: Uint8Array) => `collab-${room}.${raw[0] === 0x50 && raw[1] === 0x4b ? 'hwpx' : 'hwp'}`;

const PANEL_STYLE = [
  'position:fixed', 'right:12px', 'bottom:12px', 'z-index:2147483000',
  'font:12px/1.4 system-ui,sans-serif', 'padding:6px 10px', 'border-radius:6px',
  'background:rgba(30,30,30,.85)', 'color:#fff', 'pointer-events:none', 'max-width:60vw',
].join(';');
const BANNER_STYLE = [
  'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:2147483001',
  'font:600 14px/1.5 system-ui,sans-serif', 'padding:10px 16px', 'text-align:center',
  'background:#c53030', 'color:#fff',
].join(';');

/** 활성화한 연결의 정리 함수. `deactivate` 는 `activate` 의 클로저를 볼 수 없어 여기에 둔다. */
let teardown: (() => void) | null = null;

export const collabPlugin = {
  id: 'collab',
  apiVersion: 1,

  activate(host: PluginHost): PluginSurface {
    const params = new URLSearchParams(window.location.search);
    const url = params.get('collab');
    if (!url) throw new Error('collab URL 파라미터가 없습니다 (?collab=ws://…&room=…&name=…)');
    const room = params.get('room') || 'demo';
    const name = params.get('name') || 'anon';
    const fast = params.get('collabFast') !== '0';
    /** 오래 끊김 안내 기준(시험에서 줄일 수 있다) */
    const longDisconnectMs = Number(params.get('collabLongDisconnectMs') ?? LONG_DISCONNECT_MS);
    const clientId = crypto.randomUUID();

    // ── 상태 (§7) ─────────────────────────────────────────────────────
    let lastSeq = 0;
    let inflight = 0;
    /** S3-3: 방의 세대(welcome 이 알려 줌). 다시 붙을 때 실어 보낸다 — 세대가 바뀌었으면 따라잡기 대신 welcome. */
    let generation = 0;
    /** S3-4: 보낸 묶음의 이름(clientId:순번) — 끊긴 뒤 따라잡기에서 내 묶음이 받아졌는지 가린다 */
    let batchCounter = 0;
    let inflightBatch: string | null = null;
    /** S3-4 재접속 상태 */
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    /** 시험용: 이 시각까지 다시 붙지 않는다(끊긴 동안의 편집을 만들려고) */
    let reconnectHoldUntil = 0;
    let disconnectedAt = 0;
    let longDisconnectWarned = false;
    /** 다시 붙으며 lastSeq 를 실어 hello 를 보냈다 — 답(catchup 또는 welcome)을 기다리는 중 */
    let resuming = false;
    /** 나가거나 내릴 때 — 끊겨도 다시 붙지 않는다 */
    let closing = false;
    let reconnects = 0;
    /** 서버 메시지 상한(welcome 이 알려 줌, R12) */
    let maxMessageBytes = Number.POSITIVE_INFINITY;
    let ready = false;
    let resyncing = false;
    let left = false;
    let desynced = false;
    let desyncReason = '';
    /** 우리가 일으킨 문서 교체 중 — 그 밖의 교체는 사용자가 다른 문서를 연 것이다(→ 방을 나감) */
    let ownSwap = false;
    let connection: 'connecting' | 'open' | 'closed' = 'connecting';
    const resyncTimes: number[] = [];
    let sentEntries = 0;
    let droppedTotal = 0;
    let lastDigest = '';
    let digestSentSeq = -1;
    let digestSentAt = 0;
    let digestTimer: ReturnType<typeof setTimeout> | null = null;
    /** 조합 중 보류한 원격 메시지 */
    const held: ServerMessage[] = [];
    /** R10: 다른 사람 커서(텍스트 좌표). 받은 뒤의 원격·내 편집 지도로 계속 옮긴다. */
    const cursors = new Map<string, { name: string; caret: TextCaret | null; color: string; el?: HTMLElement }>();
    let lastSentCaret = '';

    const log = (...args: unknown[]) => console.info(`[collab ${name}]`, ...args);

    // ── 숨은 기능: 자동 저장·되돌리기 중지, 기록 훅 ─────────────────────
    const resumeAutosave = host.suspendAutosave();
    const resumeHistory = host.suspendHistory();
    // S3-1: 문서를 열기 전에 글꼴 정책을 건다 — 기기·브라우저가 달라도 같은 조판.
    const releaseFontPolicy = host.setFontPolicy(FONT_POLICY);
    let flushQueued = false;
    const engine = new CollabEngine({
      onLocal: () => {
        if (flushQueued) return;
        flushQueued = true;
        queueMicrotask(() => { flushQueued = false; flush(); });
      },
      onWarn: (m) => console.warn(`[collab ${name}] ${m}`),
      fast,
    });
    const releaseIntercept = host.interceptDocumentCalls({
      methods: Object.keys(CATALOG),
      includeMutatingRegistry: true,
      call: (method, args, invoke, target) => engine.intercept(method, args, invoke, target),
    });

    // ── 화면 ──────────────────────────────────────────────────────────
    const panel = document.createElement('div');
    panel.dataset.collab = 'status';
    panel.style.cssText = PANEL_STYLE;
    const panelLine = document.createElement('div');
    panel.appendChild(panelLine);
    document.body.appendChild(panel);
    let banner: HTMLDivElement | null = null;
    const noticeTimers = new Set<ReturnType<typeof setTimeout>>();

    const render = () => {
      const state = left ? '공동편집에서 나옴'
        : desynced ? '동기화 깨짐'
          : connection === 'connecting' ? '연결 중'
            : connection === 'closed' ? '연결 끊김'
              : resyncing ? '다시 맞추는 중'
                : !ready ? '문서 받는 중'
                  : inflight > 0 || engine.pendingCount > 0 ? '전송 중' : '동기화됨';
      panelLine.textContent = `공동편집 ${room} · ${name} · seq ${lastSeq} · ${state}`;
      panel.style.background = desynced || left || connection === 'closed' ? 'rgba(197,48,48,.9)' : 'rgba(30,30,30,.85)';
    };
    /** 상태 표시에 잠깐 보이는 안내 한 줄 */
    const notice = (text: string, kind = 'notice') => {
      const line = document.createElement('div');
      line.dataset.collab = kind;
      line.style.cssText = 'margin-top:4px;opacity:.85';
      line.textContent = text;
      panel.appendChild(line);
      const t = setTimeout(() => { line.remove(); noticeTimers.delete(t); }, NOTICE_MS);
      noticeTimers.add(t);
      log(text);
    };
    const showBanner = (text: string) => {
      banner?.remove();
      banner = document.createElement('div');
      banner.dataset.collab = 'desynced';
      banner.style.cssText = BANNER_STYLE;
      banner.textContent = text;
      document.body.appendChild(banner);
    };
    const hideBanner = () => { banner?.remove(); banner = null; };
    const markDesynced = (reason: string) => {
      if (desynced) return;
      desynced = true;
      desyncReason = reason;
      engine.setRecording(false);
      console.warn(`[collab ${name}] 동기화 깨짐: ${reason}`);
      showBanner(`동기화가 깨졌습니다. 새로고침하세요 (${reason})`);
      render();
    };

    // ── 서버 연결 ─────────────────────────────────────────────────────
    // S3-4: 끊기면 지수 백오프로 다시 붙는다(connect). 그동안 엔진 상태(미확정·lastSeq)는 그대로 두고 편집은 계속 쌓인다.
    let ws: WebSocket | null = null;
    const send = (msg: Record<string, unknown>) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    /** 방에서 나간다(예상치 못한 문서 교체 등). 기록 훅·중지를 모두 푼다. */
    const leave = (reason: string) => {
      if (left) return;
      left = true;
      closing = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      for (const c of cursors.values()) c.el?.remove();
      cursors.clear();
      ready = false;
      engine.detach();
      releaseIntercept();
      resumeHistory();
      resumeAutosave();
      releaseFontPolicy();
      if (digestTimer !== null) clearTimeout(digestTimer);
      try { ws?.close(); } catch { /* noop */ }
      showBanner(`공동편집에서 나왔습니다 (${reason})`);
      log(`방을 나감: ${reason}`);
      render();
    };

    /** 지금 빌린 공유 핸들 */
    const handle = (): EngineDoc | null => (host.borrowDocument()?.handle as unknown as EngineDoc | undefined) ?? null;

    // 문서 교체: 우리가 일으킨 것(welcome·base 재열기)이면 다음 단계가 새 핸들을 붙인다. 아니면 방을 나간다.
    host.onDocumentSwap((_lease: DocumentLease) => {
      if (ownSwap || left || !ready) return;
      leave('다른 문서로 바뀌었습니다');
    });

    // ── 캐럿 좌표: studio(논리) ↔ 엔진(텍스트) ──────────────────────────
    const toTextCaret = (doc: EngineDoc, c: PluginCaret | null): TextCaret | null => {
      if (!c) return null;
      try {
        if (c.cellPath.length === 0) {
          const t = JSON.parse(doc.collabLogicalToText(c.sectionIndex, c.parentParaIndex, c.charOffset)) as { offset: number };
          return { section: c.sectionIndex, para: c.parentParaIndex, offset: t.offset };
        }
        if (c.cellPath.length === 1) {
          const [cp] = c.cellPath;
          return { section: c.sectionIndex, para: c.parentParaIndex, offset: c.charOffset, cell: { control: cp.controlIndex, cell: cp.cellIndex, cellPara: cp.cellParaIndex } };
        }
      } catch { /* 위치가 이미 맞지 않음 */ }
      return null;
    };
    const toPluginCaret = (doc: EngineDoc, c: TextCaret | null, before: PluginCaret | null): PluginCaret | null => {
      if (!c) return before;
      try {
        if (!c.cell) {
          const logical = doc.collabTextToLogical(c.section, c.para, c.offset, false);
          return { sectionIndex: c.section, parentParaIndex: c.para, cellPath: [], charOffset: logical };
        }
        return {
          sectionIndex: c.section, parentParaIndex: c.para, charOffset: c.offset,
          cellPath: [{ controlIndex: c.cell.control, cellIndex: c.cell.cell, cellParaIndex: c.cell.cellPara }],
        };
      } catch {
        return { sectionIndex: c.section, parentParaIndex: c.para, cellPath: [], charOffset: c.offset };
      }
    };

    // ── 다른 사람 커서 그리기 (R10) ──────────────────────────────────────
    // 텍스트 좌표로 들고 있다가 그리기 직전에 studio 논리 좌표로 바꿔 studio 캐럿과 같은 계산(host.caretRect)으로
    // 겹침 층에 이름표 달린 색 막대를 놓는다. 줌·쪽 배치·조판 갱신(view-changed)과 편집 반영 뒤에 다시 계산한다.
    const renderCursors = () => {
      const layer = host.overlayLayer();
      const doc = handle();
      if (!layer || !doc) return;
      for (const c of cursors.values()) {
        const pc = c.caret ? toPluginCaret(doc, c.caret, null) : null;
        const rect = pc ? host.caretRect(pc) : null;
        if (!rect) { c.el?.remove(); c.el = undefined; continue; }
        if (!c.el) {
          c.el = document.createElement('div');
          c.el.dataset.collab = 'cursor';
          c.el.style.cssText = `position:absolute;width:2px;pointer-events:none;background:${c.color};z-index:5`;
          const tag = document.createElement('span');
          tag.style.cssText = `position:absolute;left:0;top:-14px;font:10px/12px system-ui,sans-serif;color:#fff;background:${c.color};padding:0 3px;border-radius:2px;white-space:nowrap`;
          c.el.appendChild(tag);
        }
        (c.el.firstChild as HTMLElement).textContent = c.name;
        c.el.style.left = `${rect.left}px`;
        c.el.style.top = `${rect.top}px`;
        c.el.style.height = `${rect.height}px`;
        if (c.el.parentElement !== layer) layer.appendChild(c.el);
      }
    };
    host.events.on('view-changed', renderCursors);
    host.events.on('document-changed', renderCursors);

    // ── 보내기 (§7 flush) ─────────────────────────────────────────────
    const flush = () => {
      // 다시 붙은 뒤 서버 답(catchup·welcome)을 받기 전에는 보내지 않는다(resuming) — 옛 base 묶음의 늦은 reject 가
      // 따라잡기 뒤의 새 묶음을 건드리지 않게.
      if (!ready || left || desynced || resyncing || resuming || inflight > 0 || connection !== 'open' || host.isComposing()) return;
      const entries = engine.takePending();
      if (entries.length === 0) return;
      const batchId = `${clientId}:${++batchCounter}`;
      const payload = JSON.stringify({ type: 'ops', base: lastSeq, entries, batchId });
      if (payload.length > maxMessageBytes) {
        // 보내지 않는다. 미확정을 버리고 서버 문서로 되돌린다(R12).
        notice(TOO_LARGE_NOTICE, 'too-large');
        requestResync(`편집이 메시지 상한 ${maxMessageBytes}바이트를 넘음`);
        return;
      }
      ws?.send(payload);
      inflight = entries.length;
      inflightBatch = batchId;
      sentEntries += entries.length;
      render();
    };
    host.events.on('document-mutated', flush);
    host.events.on('document-changed', flush);
    // 내 편집이 기록되면 다른 사람 커서를 그만큼 옮긴다
    let lastLocalSeen: Entry | null = null;
    host.events.on('document-mutated', () => {
      const e = engine.lastLocal;
      if (!e || e === lastLocalSeen) return;
      lastLocalSeen = e;
      for (const c of cursors.values()) c.caret = engine.mapCaret([e], c.caret);
      renderCursors();
    });
    const cursorTimer = setInterval(() => {
      if (ready && !left && connection !== 'open' && !longDisconnectWarned && disconnectedAt
        && (Date.now() - disconnectedAt > longDisconnectMs || engine.pendingCount > LONG_DISCONNECT_PENDING)) {
        longDisconnectWarned = true;
        notice(LONG_DISCONNECT_NOTICE, 'long-disconnect');
      }
      if (!ready || left || desynced || connection !== 'open') return;
      const doc = handle();
      if (!doc) return;
      // 머리말·꼬리말·각주 안(getCaret 이 null)은 위치를 보내지 않는다 — 숨김(null)만 알린다.
      const c = toTextCaret(doc, host.getCaret());
      const key = JSON.stringify(c);
      if (key === lastSentCaret) return;
      lastSentCaret = key;
      send({ type: 'cursor', seq: lastSeq, caret: c });
    }, CURSOR_INTERVAL_MS);

    // ── digest 보고 (1단계 §6.8) ──────────────────────────────────────
    const idle = () => ready && !left && !desynced && !resyncing && connection === 'open'
      && inflight === 0 && engine.pendingCount === 0 && !host.isComposing();
    const tryReportDigest = () => {
      if (!idle() || lastSeq === digestSentSeq) return;
      const doc = handle();
      if (!doc) return;
      const digest = doc.collabDigest();
      send({ type: 'digest', seq: lastSeq, digest });
      lastDigest = digest;
      digestSentSeq = lastSeq;
      digestSentAt = Date.now();
    };
    const scheduleDigest = () => {
      if (digestTimer !== null) return;
      const wait = Math.max(0, digestSentAt + DIGEST_INTERVAL_MS - Date.now());
      digestTimer = setTimeout(() => { digestTimer = null; tryReportDigest(); if (!idle()) scheduleDigest(); }, wait);
    };

    // ── 재동기화 (§7) ─────────────────────────────────────────────────
    const requestResync = (reason: string) => {
      if (left || desynced || resyncing) return;
      const now = Date.now();
      while (resyncTimes.length && now - resyncTimes[0] > RESYNC_WINDOW_MS) resyncTimes.shift();
      if (resyncTimes.length >= RESYNC_LIMIT) {
        markDesynced(`재동기화가 1분에 ${RESYNC_LIMIT}회를 넘었습니다 (${reason})`);
        return;
      }
      resyncTimes.push(now);
      resyncing = true;
      engine.setRecording(false);
      held.length = 0;
      log(`재동기화 요청: ${reason}`);
      send({ type: 'resync' });
      render();
    };

    /** 기준점 + 뒤 항목을 지금 문서 객체 안에서 적재·재생한다(studio 문서 교체 없이). */
    const applyWelcomeInPlace = (msg: Extract<ServerMessage, { type: 'welcome' }>) => {
      const doc = handle();
      if (!doc || msg.base === null) throw new Error('재동기화할 문서가 없습니다');
      engine.attach(doc);
      host.applyExternal('collab:resync', () => {
        doc.collabLoadState(base64ToBytes(msg.base as string));
        engine.replayAll(msg.log);
      });
      lastSeq = msg.seq;
      inflight = 0;
      inflightBatch = null;
    };

    // ── 메시지 처리 ────────────────────────────────────────────────────
    const onWelcome = async (msg: Extract<ServerMessage, { type: 'welcome' }>) => {
      if (typeof msg.maxMessageBytes === 'number') maxMessageBytes = msg.maxMessageBytes;
      if (typeof msg.generation === 'number') generation = msg.generation;
      // S3-4: 다시 붙었는데 서버가 따라잡기를 못 해 주면(기준점이 그 뒤로 옮겨 감) 재동기화와 같다 — 미확정을 버린다.
      const resumeFallback = resuming && ready && msg.base !== null;
      resuming = false;
      // 재동기화 요청 중에 끊겼다 다시 붙은 경우의 welcome 도 제자리 재동기화다.
      if (msg.resync || resumeFallback || (resyncing && ready && msg.base !== null)) {
        applyWelcomeInPlace(msg);
        resyncing = false;
        engine.setRecording(true);
        if (resumeFallback) { reconnected(); notice(RESUME_FALLBACK_NOTICE, 'resume-fallback'); }
        else notice('동기화를 다시 맞췄습니다. 일부 입력이 취소됐을 수 있습니다');
        render();
        scheduleDigest();
        return;
      }
      engine.detach();
      ownSwap = true;
      try {
        if (msg.base === null) {
          // 첫 참여자: 지금 문서를 base 로 올리고 같은 바이트로 다시 연다(모두 같은 파싱 결과에서 출발).
          if (!host.borrowDocument()) await host.createBlankDocument();
          const packed = host.read((d) => (d as unknown as EngineDoc).collabExportState());
          const data = bytesToBase64(packed);
          if (data.length + 64 > maxMessageBytes) {
            leave('문서가 커서 공동편집을 시작할 수 없습니다');
            return;
          }
          send({ type: 'base', data });
          const raw = await gunzip(packed);
          log(`base 전송 ${packed.length}B (원본 ${raw.length}B)`);
          await host.loadDocument(raw, fileNameFor(room, raw), OPEN_OPTIONS);
          const doc = handle();
          if (!doc) throw new Error('문서를 열지 못했습니다');
          if (!fontPolicyHolds(doc)) { leave('글꼴 환경을 고정하지 못했습니다'); return; }
          engine.attach(doc);
        } else {
          const raw = await gunzip(base64ToBytes(msg.base));
          await host.loadDocument(raw, fileNameFor(room, raw), OPEN_OPTIONS);
          const doc = handle();
          if (!doc) throw new Error('문서를 열지 못했습니다');
          if (!fontPolicyHolds(doc)) { leave('글꼴 환경을 고정하지 못했습니다'); return; }
          engine.attach(doc);
          if (msg.log.length > 0) {
            host.applyExternal('collab:replay', () => engine.replayAll(msg.log));
          }
          log(`welcome seq=${msg.seq}, 기준점 뒤 ${msg.log.length}건 재생`);
        }
        lastSeq = msg.seq;
      } finally {
        ownSwap = false;
      }
      ready = true;
      engine.setRecording(true);
      render();
      notice(AUTOSAVE_NOTICE, 'notice');
      notice(FONT_POLICY_NOTICE, 'font-policy');
      scheduleDigest();
    };

    const onOps = (msg: Extract<ServerMessage, { type: 'ops' }>) => {
      if (msg.seq !== lastSeq + 1) {
        requestResync(`seq 가 건너뛰었습니다 (기대 ${lastSeq + 1}, 받음 ${msg.seq})`);
        return;
      }
      if (msg.clientId === clientId) {
        engine.ack(inflight);
        inflight = 0;
        inflightBatch = null;
        lastSeq = msg.seq;
        render();
        flush();
        scheduleDigest();
        return;
      }
      if (!applyRemote(msg)) return;
      render();
      flush();
      scheduleDigest();
    };

    /** 남의 묶음 하나를 받는다(되감기·보정, 캐럿·다른 사람 커서 옮기기). 실패하면 재동기화를 걸고 false. */
    const applyRemote = (msg: { seq: number; entries: Entry[] }): boolean => {
      const doc = handle();
      if (!doc) return false;
      const before = host.getCaret();
      const result = host.applyExternal('collab:remote', () => engine.receiveRemote(msg.entries, toTextCaret(doc, before)));
      lastSeq = msg.seq;
      if (!result.ok) {
        requestResync(`원격 적용 실패: ${result.error}`);
        return false;
      }
      const caret = toPluginCaret(doc, result.caret, before);
      if (caret && before) host.setCaret(caret);
      for (const c of cursors.values()) c.caret = engine.mapCaret(msg.entries, c.caret);
      renderCursors();
      if (result.dropped > 0) {
        droppedTotal += result.dropped;
        notice(`동시 편집 충돌로 내 편집 ${result.dropped}건이 취소됐습니다`);
        const names = (es: readonly Entry[] | undefined) => (es ?? []).map((e) => (e.kind === 'state' ? 'state' : e.m)).join(',');
        console.warn(`[collab ${name}] 충돌: ${result.dropReason} — 취소 [${names(result.droppedEntries)}], 원격 [${names(msg.entries)}]`);
      }
      return true;
    };

    /** 다시 붙음: 끊김 표시를 걷는다. */
    const reconnected = () => {
      disconnectedAt = 0;
      longDisconnectWarned = false;
      reconnects += 1;
      hideBanner();
    };

    /**
     * S3-4 따라잡기: 끊긴 동안의 묶음을 원격 수신과 같이 받는다(되감기·보정). 끊기는 순간 보낸 묶음(inflightBatch)이
     * 그 안에 있으면 남의 편집이 아니라 확정(ack)이다 — 다시 적용하지 않는다. 없으면 받아지지 않은 것이라 다시 보낸다.
     */
    const onCatchup = (msg: Extract<ServerMessage, { type: 'catchup' }>) => {
      resuming = false;
      if (typeof msg.maxMessageBytes === 'number') maxMessageBytes = msg.maxMessageBytes;
      let acked = false;
      for (const item of msg.log) {
        if (item.seq !== lastSeq + 1) {
          requestResync(`따라잡기 seq 가 건너뛰었습니다 (기대 ${lastSeq + 1}, 받음 ${item.seq})`);
          return;
        }
        const mine = item.batchId !== undefined ? item.batchId === inflightBatch : item.clientId === clientId;
        if (mine && inflight > 0) {
          engine.ack(inflight);
          inflight = 0;
          inflightBatch = null;
          lastSeq = item.seq;
          acked = true;
          continue;
        }
        if (!applyRemote(item)) return;
      }
      if (inflight > 0) {
        // 끊기기 전에 보낸 묶음이 서버에 닿지 않았다 — 미확정 앞에 되돌려 다시 보낸다.
        engine.requeue();
        inflight = 0;
        inflightBatch = null;
      }
      if (msg.cont) {
        // 나눠 보낸 welcome 의 이어지는 조각(S3-3 — 기준점 + 긴 기록이 메시지 상한을 넘을 때)
        render();
        flush();
        scheduleDigest();
        return;
      }
      reconnected();
      log(`따라잡기 seq ${msg.seq}: ${msg.log.length}건${acked ? ' (끊길 때 보낸 내 묶음 확정)' : ''}`);
      notice(`다시 연결했습니다 — 끊긴 동안의 편집 ${msg.log.length}건을 받았습니다`, 'reconnected');
      render();
      flush();
      scheduleDigest();
    };

    const handle1 = async (msg: ServerMessage) => {
      if (left || desynced) return;
      if (resyncing && msg.type !== 'welcome') return; // 재동기화 welcome 이 이 사이 항목을 포함한다
      switch (msg.type) {
        case 'welcome': return onWelcome(msg);
        case 'ops': return onOps(msg);
        case 'catchup': return onCatchup(msg);
        case 'reject':
          if (msg.batchId !== undefined && msg.batchId !== inflightBatch) return; // 늦게 온 옛 묶음의 reject
          engine.requeue();
          inflight = 0;
          inflightBatch = null;
          flush();
          return;
        case 'diverged': return requestResync(`참여자 간 문서 지문이 다릅니다 (seq ${msg.seq})`);
        case 'incompatible':
          leave('엔진 버전이 방과 다릅니다. 새로고침하세요');
          return;
        case 'invalid':
          if (msg.what === 'base') {
            leave(`서버가 이 문서를 열지 못했습니다 (${msg.reason})`);
            return;
          }
          if (msg.batchId !== undefined && msg.batchId !== inflightBatch) return;
          notice(INVALID_NOTICE, 'invalid');
          requestResync(`서버 정본이 편집을 거절: ${msg.reason}`);
          return;
        case 'too-large':
          if (msg.what === 'base') {
            leave('문서가 커서 공동편집을 시작할 수 없습니다');
            return;
          }
          notice(TOO_LARGE_NOTICE, 'too-large');
          requestResync(`서버가 메시지 상한(${msg.limit}바이트)을 넘는 편집을 거절`);
          return;
        case 'cursor': {
          if (msg.clientId === clientId) return;
          const known = cursors.get(msg.clientId);
          const color = known?.color ?? CURSOR_COLORS[cursors.size % CURSOR_COLORS.length];
          // 보낸 쪽 seq 뒤로 내가 이미 받은 원격은 지도로 옮기지 않는다(근사 — 다음 커서 메시지가 곧 바로잡는다)
          cursors.set(msg.clientId, { ...known, name: msg.name, caret: msg.caret, color });
          renderCursors();
          return;
        }
        case 'cursor-leave':
          cursors.get(msg.clientId)?.el?.remove();
          cursors.delete(msg.clientId);
          return;
        case 'error': log('서버 오류:', msg.error); return;
      }
    };

    // 메시지는 줄을 세워 하나씩(welcome 의 비동기 문서 교체가 끝난 뒤 다음). 조합 중에는 보류한다.
    let queue: Promise<void> = Promise.resolve();
    const enqueue = (msg: ServerMessage) => {
      queue = queue.then(() => handle1(msg)).catch((error) => {
        requestResync(`처리 중 오류: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    const onSocketMessage = (event: MessageEvent) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        log('서버 메시지 해석 실패');
        return;
      }
      if (ready && host.isComposing() && msg.type !== 'incompatible' && msg.type !== 'too-large') {
        held.push(msg);
        return;
      }
      enqueue(msg);
    };
    host.events.on('composition-end', () => {
      // 조합 중 보류한 원격 메시지를 순서대로 처리하고, 조합 중 쌓인 내 편집을 보낸다.
      const pending = held.splice(0);
      for (const msg of pending) enqueue(msg);
      queue = queue.then(() => flush());
    });
    const connect = () => {
      reconnectTimer = null;
      if (closing || left) return;
      connection = 'connecting';
      render();
      const socket = new WebSocket(url);
      ws = socket;
      socket.addEventListener('message', (event) => { if (socket === ws) onSocketMessage(event); });
      socket.addEventListener('open', () => {
        if (socket !== ws) return;
        connection = 'open';
        reconnectAttempts = 0;
        // 이미 방에 들어와 있었으면(재접속) 마지막으로 받은 seq 를 싣는다 → 서버가 따라잡기(catchup) 또는 welcome.
        resuming = ready && !resyncing && !desynced;
        render();
        send({ type: 'hello', room, clientId, name, engine: ENGINE_FINGERPRINT, ...(resuming ? { lastSeq, generation } : {}) });
        log(`연결 ${url} room=${room} 엔진 ${ENGINE_FINGERPRINT}${resuming ? ` (다시 붙음, lastSeq ${lastSeq})` : ''}`);
      });
      socket.addEventListener('close', () => {
        if (socket !== ws) return;
        connection = 'closed';
        render();
        if (closing || left) return;
        if (!disconnectedAt) disconnectedAt = Date.now();
        // 재동기화 중에 끊겼으면 그 요청은 사라졌다 — resyncing 을 그대로 두면 다시 붙을 때 lastSeq 없이 hello 를 보내고,
        // 받은 welcome 을 제자리 재동기화로 처리한다(onWelcome).
        for (const c of cursors.values()) c.el?.remove();
        cursors.clear();
        if (ready) showBanner(DISCONNECT_BANNER);
        const delay = Math.max(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts), reconnectHoldUntil - Date.now());
        reconnectAttempts += 1;
        log(`연결 끊김 — ${Math.round(delay)}ms 뒤 다시 연결`);
        reconnectTimer = setTimeout(connect, delay);
      });
    };
    connect();
    render();

    // ── 표면: 콘솔 검증용 ──────────────────────────────────────────────
    const surface = {
      status: () => ({
        room, name, clientId, lastSeq, inflight, ready, resyncing, left, desynced, desyncReason, connection,
        pending: engine.pendingCount, unsent: engine.unsentCount, sentEntries, droppedTotal,
        lastDigest, digestSentSeq, resyncCount: resyncTimes.length, engine: ENGINE_FINGERPRINT,
        cursors: [...cursors.entries()].map(([id, c]) => ({ clientId: id, name: c.name, caret: c.caret })),
        reconnects, disconnectedAt, inflightBatch,
        fast: { enabled: fast, ...engine.fastStats, mismatches: engine.fastStats.mismatches.length },
      }),
      digest: () => handle()?.collabDigest() ?? '',
      /** 시험용(S3-4): 연결을 끊고 ms 동안 다시 붙지 않는다 — 그동안의 편집은 쌓였다가 다시 붙으면 보내진다. */
      simulateDisconnect: (ms = 0) => { reconnectHoldUntil = Date.now() + ms; ws?.close(); },
    };
    (window as unknown as { __collab?: typeof surface }).__collab = surface;
    teardown = () => {
      clearInterval(cursorTimer);
      for (const c of cursors.values()) c.el?.remove();
      if (digestTimer !== null) clearTimeout(digestTimer);
      for (const t of noticeTimers) clearTimeout(t);
      engine.detach();
      releaseIntercept();
      resumeHistory();
      resumeAutosave();
      releaseFontPolicy();
      closing = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch { /* noop */ }
      panel.remove();
      banner?.remove();
      delete (window as unknown as { __collab?: unknown }).__collab;
    };
    return surface;
  },

  deactivate() {
    teardown?.();
    teardown = null;
  },
} satisfies StudioPlugin;
