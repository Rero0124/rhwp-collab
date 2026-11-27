/**
 * cc-rhwp 공동편집 studio 플러그인 — studio 어댑터 (6단계 N1, docs/collab-stage6.md).
 *
 * 연결 상태 기계(연결·hello·welcome/catchup·재접속·보내기·재동기화·digest·커서·권한)는 플랫폼 중립 세션
 * `./session` 의 `CollabSession` 이 한다. 여기에는 studio 에서만 하는 일 — WebSocket 연결, studio Host(문서 열기·
 * applyExternal·캐럿 좌표·overlay·안내 DOM), 주소의 접속 정보(#token·부품 전용 토큰 통로) — 만 둔다.
 * 기록·되감기·보정은 엔진(`./engine`)이 하고, 엔진은 studio 를 모른다.
 * 기록은 studio 가 감싼 문서 메서드 호출(`host.interceptDocumentCalls`)에서 일어난다 — 공유 핸들의 호출만.
 *
 * studio 를 import 하지 않는다 — 타입만 `import type` 이다(플러그인 계약 `plugin/types.ts`).
 * 연결 설정은 URL 에서 읽는다: `?collab=ws://localhost:8787&room=demo&name=A` (`&collabFast=0` 이면 R11 빠른
 * 경로를 끄고 언제나 되감는다). 5단계: `?collab#token=…&room=…` — 값이 빈 collab 은 같은 출처 wss, 토큰은 주소의
 * 조각으로 받는다(아래 "studio 쪽 접속 정보", 규약 docs/collab-protocol.md).
 */
import type { DocumentLease, PluginCaret, PluginHost, PluginSurface, StudioPlugin } from '@/plugin/types';
import type { EngineDoc, TextCaret } from './engine/engine.ts';
import { CATALOG } from './engine/catalog.ts';
import { FONT_POLICY } from './engine/types.ts';
import { CollabUndo } from './undo.ts';
import {
  CollabSession, DISCONNECT_BANNER, PHASE_TEXT, desyncedBannerText, leftBanner, noticeTexts,
  type CaretSnapshot, type CollabHost, type SessionEvent, type TokenProvider, type Transport, type TransportFactory,
} from './session/index.ts';

/** 공유 문서 열기는 확인 창 없이 (1단계 §6.2) */
const OPEN_OPTIONS = { suppressDialogs: true } as const;
const NOTICE_MS = 8000;
const CURSOR_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00897b', '#6d4c41', '#3949ab'];

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

// ── 5단계: studio 쪽 접속 정보 (docs/collab-stage5.md D0·D1·D2) ─────────────────────────────
// 플랫폼 중립 규칙(토큰 공급자 호출, 만료 때 한 번 갱신, 이유 코드 분류, hello)은 `./session` 에 있다. 여기에는
// studio 에서만 하는 일 — 주소에서 서버·방·토큰 읽기, 보안 컨텍스트 확인 — 만 둔다.

/** D2: crypto.randomUUID·Clipboard·File System Access 등은 보안 컨텍스트(https·localhost)에서만 있다. */
const INSECURE_NOTICE = '공동편집은 HTTPS 에서만 쓸 수 있습니다';
/** 토큰은 탭마다(sessionStorage) 방별로 둔다 — 새로고침해도 다시 들어오고, 탭을 닫으면 사라진다(Q5). */
const TOKEN_KEY = (room: string) => `collab-token:${room}`;
/** 이름이 없는 초대 토큰으로 들어올 때 물어본 표시 이름(기기에 남김) */
const NAME_KEY = 'collab-display-name';
/**
 * D5: 지금 열린 문서가 암호 문서(암호로 열어 저장할 때 암호가 필요한 문서)인가. studio 가 `host.documentProtection()` 으로
 * 알려 준다(0002). 그 API 가 없는 studio 에서는 가릴 수 없으므로 막지 않는다.
 * 실수로 공유하는 것을 막는 장치다. 서버는 받은 바이트(암호 없음)로 원래 암호 문서였는지 알 수 없다.
 */
function documentIsEncrypted(host: PluginHost): boolean {
  const studio = host as unknown as { documentProtection?: () => { requiresPasswordForSave?: boolean } | null | undefined };
  try {
    return studio.documentProtection?.()?.requiresPasswordForSave === true;
  } catch {
    return false;
  }
}
const safeStorage = (kind: 'sessionStorage' | 'localStorage') => {
  try { return window[kind]; } catch { return null; }
};

/**
 * 주소에서 접속 정보를 읽는다. 쿼리 `collab`(값이 비면 같은 출처 wss), 조각 또는 쿼리의 `room`·`name`, 조각의 `token`.
 * 토큰은 읽은 뒤 주소에서 지운다(조각은 서버로 가지 않지만 주소창·기록·화면 공유에 남지 않게).
 */
function readStudioEntry(): { url: string; room: string; name: string; token: string | null } {
  const query = new URLSearchParams(window.location.search);
  const frag = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const url = query.get('collab') || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/`;
  const room = frag.get('room') || query.get('room') || 'demo';
  let token = frag.get('token');
  const store = safeStorage('sessionStorage');
  if (token) {
    try { store?.setItem(TOKEN_KEY(room), token); } catch { /* 저장소를 쓸 수 없음 — 이번 탭 메모리에만 */ }
    frag.delete('token');
    const rest = frag.toString();
    history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`);
  } else {
    try { token = store?.getItem(TOKEN_KEY(room)) ?? null; } catch { token = null; }
  }
  let name = frag.get('name') || query.get('name') || '';
  if (!name && token) name = askDisplayName();
  return { url, room, name: name || 'anon', token };
}

/** 이름이 없는 초대 링크: 다른 사람에게 보일 이름을 한 번 묻고 기억한다(확인된 값이 아닌 표시용). */
function askDisplayName(): string {
  const local = safeStorage('localStorage');
  let saved = '';
  try { saved = local?.getItem(NAME_KEY) ?? ''; } catch { /* 없음 */ }
  if (saved) return saved;
  const answer = (typeof window.prompt === 'function' ? window.prompt('다른 사람에게 보일 이름을 입력하세요', '') : null)?.trim() ?? '';
  if (answer) { try { local?.setItem(NAME_KEY, answer); } catch { /* 저장 못 함 */ } }
  return answer;
}

/** studio 의 토큰 공급자: 링크로 받은 토큰을 그대로. 링크 하나로는 새 토큰을 받을 길이 없다(만료면 다시 열어야 함). */
const studioTokenProvider = (token: string | null): TokenProvider => ({ reason }) => (reason === 'expired' ? null : token);

// ── 6단계 S3: 부품 전용 모드 (docs/collab-protocol.md §7) ───────────────────────────────────
// 서버가 부품 전용(COLLAB_EMBED_ONLY)이면 편집기는 허용된 부모 페이지의 iframe 안에서만 쓰인다. 토큰은 주소에서 받지 않고,
// 부모가 studio 의 embed 통로(출처가 고정된 MessagePort)로 `plugin.invoke({id:'collab', method:'setToken', args:[토큰]})` 를
// 불러 넣는다. 토큰이 필요할 때 플러그인은 부모에게 비밀 없는 알림만 보낸다.
const EMBED_TOKEN_TIMEOUT_TEXT = '바깥 시스템에서 접속 정보를 받지 못했습니다';
const EMBED_TOP_LEVEL_TEXT = '이 편집기는 연결된 시스템 안에서만 열 수 있습니다';
const EMBED_TOKEN_WAIT_MS = 30_000;
interface EmbedInfo { embedOnly: boolean; origins: string[] }

/** 공동편집 서버의 /healthz(ws 주소의 http 짝)로 부품 전용 모드와 허용 출처를 본다. 답을 못 받으면 부품 전용이 아닌 것으로 본다. */
async function fetchEmbedInfo(wsUrl: string): Promise<EmbedInfo> {
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/healthz';
    u.search = '';
    u.hash = '';
    const body = await (await fetch(u.href, { cache: 'no-store' })).json() as { embedOnly?: unknown; embedOrigins?: unknown };
    return {
      embedOnly: body?.embedOnly === true,
      origins: Array.isArray(body?.embedOrigins) ? body.embedOrigins.filter((o): o is string => typeof o === 'string') : [],
    };
  } catch {
    return { embedOnly: false, origins: [] };
  }
}

/**
 * 부모가 넣는 토큰을 기다리는 통로. 알림(`rhwp-collab-token-request`)에는 room·reason 말고는 싣지 않는다. 대상 출처는
 * ① location.ancestorOrigins[0] 이 허용 목록에 있으면 그것 ② 그 기능이 없고 허용 출처가 하나면 그것 ③ 그 밖에만 '*'.
 */
function embedTokenChannel(room: string, waitMs: number, onTimeout: () => void) {
  let origins: string[] = [];
  let latest: string | null = null;
  const waiters = new Set<(token: string) => void>();
  const target = (): string => {
    const ancestors = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
    const first = ancestors && ancestors.length > 0 ? ancestors[0] : null;
    if (first && origins.includes(first)) return first;
    if (!ancestors && origins.length === 1) return origins[0];
    return '*';
  };
  return {
    setOrigins(list: string[]) { origins = list; },
    provide(token: string) { latest = token; for (const w of [...waiters]) w(token); },
    get(reason: 'connect' | 'reconnect' | 'expired'): Promise<string | null> {
      if (reason !== 'expired' && latest) return Promise.resolve(latest);
      if (reason === 'expired') latest = null;
      try { window.parent.postMessage({ type: 'rhwp-collab-token-request', room, reason }, target()); } catch { /* 부모가 없음 */ }
      return new Promise((resolve) => {
        const done = (token: string) => { clearTimeout(timer); waiters.delete(done); resolve(token); };
        const timer = setTimeout(() => { waiters.delete(done); onTimeout(); resolve(null); }, waitMs);
        waiters.add(done);
      });
    },
  };
}

/** 보안 컨텍스트가 아니면 들어가지 않고 안내만 띄운다(아무것도 중지·가로채지 않는다). */
function insecureSurface(): PluginSurface {
  const banner = document.createElement('div');
  banner.dataset.collab = 'insecure';
  banner.style.cssText = BANNER_STYLE;
  banner.textContent = `${INSECURE_NOTICE} (지금 주소: ${window.location.protocol}//${window.location.host})`;
  document.body.appendChild(banner);
  console.warn(`[collab] ${INSECURE_NOTICE} — isSecureContext=false`);
  teardown = () => banner.remove();
  const surface = { status: () => ({ ready: false, left: true, insecure: true }), digest: () => '' };
  (window as unknown as { __collab?: typeof surface }).__collab = surface;
  return surface;
}

/** 활성화한 연결의 정리 함수. `deactivate` 는 `activate` 의 클로저를 볼 수 없어 여기에 둔다. */
let teardown: (() => void) | null = null;

/** 브라우저 WebSocket 연결(세션의 Transport) */
const webSocketTransport = (url: string): TransportFactory => (events) => {
  const socket = new WebSocket(url);
  socket.addEventListener('open', () => events.open());
  socket.addEventListener('message', (event) => events.message(String(event.data)));
  socket.addEventListener('close', () => events.close());
  const transport: Transport = {
    get isOpen() { return socket.readyState === WebSocket.OPEN; },
    send: (text) => { if (socket.readyState === WebSocket.OPEN) socket.send(text); },
    close: () => socket.close(),
  };
  return transport;
};

/** studio 캐럿 스냅숏: 엔진 좌표와 함께 studio 논리 좌표(before)를 들고 있다 — 엔진 좌표로 못 바꾸는 자리도 되돌려 놓으려고 */
interface StudioCaretSnapshot extends CaretSnapshot { readonly before: PluginCaret }

export const collabPlugin = {
  id: 'collab',
  apiVersion: 1,

  activate(host: PluginHost): PluginSurface {
    // 5단계 D2: 보안 컨텍스트가 아니면 들어가지 않는다(crypto.randomUUID 등이 없다).
    if (!window.isSecureContext) return insecureSurface();
    const params = new URLSearchParams(window.location.search);
    // 5단계 D1: 서버·방·이름·토큰 (studio 쪽 접속 정보). 이름은 인증한 서버가 welcome 에서 알려 주면 세션이 바꾼다.
    const entry = readStudioEntry();
    const { url, room } = entry;
    // eslint-disable-next-line prefer-const -- 토큰 공급자가 세션을 늦게 본다
    let session: CollabSession;
    // 6단계 S3: 부품 전용 서버면 주소의 #token 은 쓰지 않고 부모 페이지가 setToken 으로 넣는 토큰만 쓴다.
    let embedOnly: boolean | null = null; // 서버 답을 받기 전에는 모름
    const embedChannel = embedTokenChannel(room, Number(params.get('collabTokenWaitMs') ?? EMBED_TOKEN_WAIT_MS),
      () => session.leave({ code: 'host', detail: EMBED_TOKEN_TIMEOUT_TEXT }));
    const embedInfo = fetchEmbedInfo(url).then((info) => { embedOnly = info.embedOnly; embedChannel.setOrigins(info.origins); return info; });
    const linkProvider = studioTokenProvider(entry.token);
    const getToken: TokenProvider = async (req) => {
      const info = await embedInfo;
      if (!info.embedOnly) return linkProvider(req);
      // Sec-Fetch 를 보내지 않는 브라우저를 위한 두 번째 장치(서버의 403 안내가 먼저 막는다)
      if (window.top === window.self) { session.leave({ code: 'host', detail: EMBED_TOP_LEVEL_TEXT }); return null; }
      return embedChannel.get(req.reason);
    };
    const fast = params.get('collabFast') !== '0';
    // 4단계: 공동편집 되돌리기(`&collabUndo=0` 이면 예전처럼 되돌리기를 멈춘다)
    const undoEnabled = params.get('collabUndo') !== '0';
    /** 오래 끊김 안내 기준(시험에서 줄일 수 있다) */
    const longDisconnectMs = params.has('collabLongDisconnectMs') ? Number(params.get('collabLongDisconnectMs')) : undefined;

    /** 지금 빌린 공유 핸들 */
    const handle = (): EngineDoc | null => (host.borrowDocument()?.handle as unknown as EngineDoc | undefined) ?? null;

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

    // ── studio Host (세션이 부르는 편집기 일) ──────────────────────────────
    const studioHost: CollabHost = {
      doc: handle,
      ensureDoc: async () => { if (!host.borrowDocument()) await host.createBlankDocument(); },
      isEncrypted: () => documentIsEncrypted(host),
      exportState: () => host.read((d) => (d as unknown as EngineDoc).collabExportState()),
      openDoc: async (bytes) => {
        // R12: 결과·base 는 gzip 으로 감싸 온다(`collabExportState`). studio 열기에는 원본 바이트가 필요하다.
        const raw = await gunzip(bytes);
        await host.loadDocument(raw, fileNameFor(room, raw), OPEN_OPTIONS);
      },
      layoutPolicyHolds: fontPolicyHolds,
      applyExternal: (kind, fn) => host.applyExternal(`collab:${kind}`, fn),
      captureCaret: () => {
        const before = host.getCaret();
        if (!before) return null;
        const doc = handle();
        const snap: StudioCaretSnapshot = { text: doc ? toTextCaret(doc, before) : null, before };
        return snap;
      },
      restoreCaret: (snap, moved) => {
        const doc = handle();
        if (!doc) return;
        const caret = toPluginCaret(doc, moved, (snap as StudioCaretSnapshot).before);
        if (caret) host.setCaret(caret);
      },
      isComposing: () => host.isComposing(),
      event: (e) => onSessionEvent(e),
      log: (level, message) => {
        if (level === 'warn') console.warn(`[collab ${session.name}] ${message}`);
        else console.info(`[collab ${session.name}] ${message}`);
      },
    };

    // ── 숨은 기능: 자동 저장·되돌리기 중지, 기록 훅 ─────────────────────
    const resumeAutosave = host.suspendAutosave();
    // S3-1: 문서를 열기 전에 글꼴 정책을 건다 — 기기·브라우저가 달라도 같은 조판.
    const releaseFontPolicy = host.setFontPolicy(FONT_POLICY);
    session = new CollabSession({
      room, name: entry.name, url, transport: webSocketTransport(url), host: studioHost, getToken, fast, longDisconnectMs,
    });
    const engine = session.engine;
    /** 5단계 D4: form 권한이면 studio 를 양식 모드로(누름틀·양식 개체만 고치는 화면). 우리가 켰으면 나갈 때 끈다. */
    let formModeByUs = false;
    const applyFormMode = (scope: readonly string[] | null) => {
      const want = !!scope && !scope.includes('edit') && scope.includes('form');
      const isForm = document.documentElement.dataset.editMode === 'form';
      if (want && !isForm) {
        try { host.automation.execute('view:form-mode'); formModeByUs = true; } catch (error) { console.warn(`[collab ${session.name}] 양식 모드 전환 실패`, error); }
      } else if (!want && isForm && formModeByUs) {
        try { host.automation.execute('view:form-mode'); } catch { /* noop */ }
        formModeByUs = false;
      }
    };
    // 4단계: 되돌리기는 내 편집만, 남이 같은 자리를 고쳤으면 막는다(docs/collab-stage4.md). studio 가 훅을 모르면
    // (또는 꺼 두면) 예전처럼 되돌리기 기록을 멈춘다.
    const undo = new CollabUndo(engine, (text) => notice(text, 'undo'));
    const undoController = undoEnabled && typeof host.enableCollabUndo === 'function' ? host.enableCollabUndo(undo.hook) : null;
    undo.attach(undoController);
    session.setUndo(undo);
    const resumeHistory = undoController ? undoController.release : host.suspendHistory();
    // 새로고침·닫기 확인: studio 의 "저장하지 않은 변경" 대신, 아직 서버에 확정되지 않은 내 편집(보내는 중·끊긴 동안 쌓인
    // 것)이 있을 때만 묻는다 — 문서는 서버가 들고 있다.
    const releaseUnloadGuard = typeof host.guardUnload === 'function'
      ? host.guardUnload(() => session.hasUnconfirmedEdits())
      : () => {};
    const releaseIntercept = host.interceptDocumentCalls({
      methods: Object.keys(CATALOG),
      includeMutatingRegistry: true,
      call: (method, args, invoke, target) => engine.intercept(method, args, invoke, target),
    });
    /** 방에서 나오거나 내릴 때 studio 에 걸어 둔 것을 푼다 */
    const releaseStudio = () => {
      applyFormMode(null);
      releaseIntercept();
      resumeHistory();
      releaseUnloadGuard();
      resumeAutosave();
      releaseFontPolicy();
    };

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
      const phase = session.phase;
      panelLine.textContent = `공동편집 ${room} · ${session.name} · seq ${session.lastSeq} · ${PHASE_TEXT[phase]}`;
      panel.style.background = phase === 'desynced' || phase === 'left' || phase === 'closed' ? 'rgba(197,48,48,.9)' : 'rgba(30,30,30,.85)';
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
      console.info(`[collab ${session.name}] ${text}`);
    };
    const showBanner = (text: string, kind = 'desynced') => {
      banner?.remove();
      banner = document.createElement('div');
      banner.dataset.collab = kind;
      banner.style.cssText = BANNER_STYLE;
      banner.textContent = text;
      document.body.appendChild(banner);
    };
    const hideBanner = () => { banner?.remove(); banner = null; };

    // ── 다른 사람 커서 그리기 (R10) ──────────────────────────────────────
    // 세션이 텍스트 좌표로 들고 있다가 그리기 직전에 studio 논리 좌표로 바꿔 studio 캐럿과 같은 계산(host.caretRect)으로
    // 겹침 층에 이름표 달린 색 막대를 놓는다. 줌·쪽 배치·조판 갱신(view-changed)과 편집 반영 뒤에 다시 계산한다.
    // 색은 처음 본 순서로 정한다(세션 커서 목록을 그대로 따라가는 지도).
    const cursorViews = new Map<string, { color: string; el?: HTMLElement }>();
    const renderCursors = () => {
      for (const [id, v] of cursorViews) if (!session.cursors.has(id)) { v.el?.remove(); cursorViews.delete(id); }
      for (const id of session.cursors.keys()) {
        if (!cursorViews.has(id)) cursorViews.set(id, { color: CURSOR_COLORS[cursorViews.size % CURSOR_COLORS.length] });
      }
      const layer = host.overlayLayer();
      const doc = handle();
      if (!layer || !doc) return;
      for (const [id, c] of session.cursors) {
        const v = cursorViews.get(id)!;
        const pc = c.caret ? toPluginCaret(doc, c.caret, null) : null;
        const rect = pc ? host.caretRect(pc) : null;
        if (!rect) { v.el?.remove(); v.el = undefined; continue; }
        if (!v.el) {
          v.el = document.createElement('div');
          v.el.dataset.collab = 'cursor';
          v.el.style.cssText = `position:absolute;width:2px;pointer-events:none;background:${v.color};z-index:5`;
          const tag = document.createElement('span');
          tag.style.cssText = `position:absolute;left:0;top:-14px;font:10px/12px system-ui,sans-serif;color:#fff;background:${v.color};padding:0 3px;border-radius:2px;white-space:nowrap`;
          v.el.appendChild(tag);
        }
        (v.el.firstChild as HTMLElement).textContent = c.name;
        v.el.style.left = `${rect.left}px`;
        v.el.style.top = `${rect.top}px`;
        v.el.style.height = `${rect.height}px`;
        if (v.el.parentElement !== layer) layer.appendChild(v.el);
      }
    };

    // ── 세션 사건 → studio 화면 ────────────────────────────────────────
    function onSessionEvent(e: SessionEvent): void {
      switch (e.type) {
        case 'status': render(); return;
        case 'cursors': renderCursors(); return;
        case 'notice': for (const line of noticeTexts(e.notice)) notice(line.text, line.kind); return;
        case 'disconnected': showBanner(DISCONNECT_BANNER); return;
        case 'reconnected': hideBanner(); return;
        case 'admitted': applyFormMode(e.user?.scope ?? null); return;
        case 'desynced': showBanner(desyncedBannerText(e.cause)); return;
        case 'left': {
          releaseStudio();
          const b = leftBanner(e.reason);
          showBanner(b.text, b.kind);
          return;
        }
      }
    }

    // 문서 교체: 세션이 일으킨 것(welcome·base 재열기)이면 다음 단계가 새 핸들을 붙인다. 아니면 방을 나간다.
    host.onDocumentSwap((_lease: DocumentLease) => session.documentSwapped());
    host.events.on('view-changed', renderCursors);
    host.events.on('document-changed', renderCursors);
    host.events.on('document-mutated', () => session.edited());
    host.events.on('document-changed', () => session.changed());
    host.events.on('composition-end', () => session.compositionEnded());
    session.start();
    render();

    // ── 표면: 콘솔 검증용 ──────────────────────────────────────────────
    const surface = {
      status: () => session.status(),
      digest: () => handle()?.collabDigest() ?? '',
      /** 4단계: 되돌리기 스택 상태(시험·진단용) */
      undo: () => undo.debug(),
      /** 시험용(S3-4): 연결을 끊고 ms 동안 다시 붙지 않는다 — 그동안의 편집은 쌓였다가 다시 붙으면 보내진다. */
      simulateDisconnect: (ms = 0) => session.simulateDisconnect(ms),
      /** 6단계 S3: 부모 페이지가 embed 통로로 토큰을 넣는다(부품 전용 모드에서만 쓰인다). 넣는 방향만 있다. */
      setToken: (token: unknown) => {
        if (embedOnly === false || typeof token !== 'string' || !token) return false;
        embedChannel.provide(token);
        return true;
      },
    };
    (window as unknown as { __collab?: typeof surface }).__collab = surface;
    // plugin.invoke 로 부를 수 있는 표면: 부품 전용 모드에서는 setToken 만 — 토큰·사용자 정보·문서를 읽어 가는 메서드를 두지
    // 않는다(port 가 묶이기 전의 legacy 통로는 출처 고정이 없다). 서버 답을 받기 전에도 막는다.
    const notInEmbed = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => {
      if (embedOnly !== false) throw new Error('부품 전용 모드에서는 쓸 수 없는 메서드입니다');
      return fn(...a);
    };
    const invokable = {
      setToken: surface.setToken,
      status: notInEmbed(surface.status),
      digest: notInEmbed(surface.digest),
      undo: notInEmbed(surface.undo),
      simulateDisconnect: notInEmbed(surface.simulateDisconnect),
    };
    teardown = () => {
      session.dispose();
      for (const v of cursorViews.values()) v.el?.remove();
      for (const t of noticeTimers) clearTimeout(t);
      releaseStudio();
      panel.remove();
      banner?.remove();
      delete (window as unknown as { __collab?: unknown }).__collab;
    };
    return invokable;
  },

  deactivate() {
    teardown?.();
    teardown = null;
  },
} satisfies StudioPlugin;
