/**
 * cc-rhwp 5단계 D3: studio 안에서 "공동편집 시작" — 지금 문서로 방을 만들고 공유 링크를 보여 준다
 * (docs/collab-stage5.md D3). 공동편집으로 열지 않은 평소 studio 에서 올라가는 가벼운 플러그인이다(엔진·분류표 없음).
 *
 * - 켤 때 같은 출처의 `GET /healthz` 로 공동편집 서버와 인증 방식(`auth`)을 확인한다. 서버가 없거나, 답이 아니거나,
 *   인증이 `url`(바깥 시스템이 방·토큰을 만든다)이면 **아무 흔적도 남기지 않는다**(메뉴도 콘솔도 없음).
 * - 명령(파일 메뉴 "공동편집 시작…"): 암호 문서면 막고(D5, `host.documentProtection()` — 첫 참여자 막기와 같은 판정),
 *   지금 문서를 원본 형식으로 내보내 `POST /rooms` 로 방을 만든 뒤 링크(편집·보기·양식 입력·메모, 복사)와
 *   "이 방으로 들어가기"를 보여 준다. 들어가기는 편집 링크로 이동한다(새로 열리며 초대 경로로 들어간다 — 문서는 방에
 *   올라가 있다). 링크 규칙은 업로드 페이지(server/public/upload.html)와 같다.
 * - 인증 `hs256`: 방 만들기(create) 권한 토큰이 필요하다. 주소 조각 `#create=<토큰>` 으로 받아 곧바로 주소에서 지우고 이
 *   탭의 sessionStorage 에 둔다(`#token` 은 초대 토큰 — "공동편집으로 열기" — 과 겹치므로 이름을 나눈다). 없으면 대화상자에
 *   입력 칸을 둔다. `none`(로컬): 토큰 없이 만든다.
 *
 * studio 를 import 하지 않는다 — 타입만(`plugin/types.ts`).
 */
import type { PluginHost, PluginSurface, StudioPlugin } from '@/plugin/types';
import { ROUNDTRIP_PENDING_TEXT, isRoundtripPending, roundtripBlockedText, roundtripText, type RoundtripPending, type RoundtripResult } from './session/roundtrip.ts';

/** studio 개발 서버(`COLLAB_DEV_SERVER`)의 공동편집 서버 ws 주소 — 빌드·시험에서는 비거나 없다(같은 출처). */
declare const __CC_RHWP_COLLAB_DEV_WS__: string | undefined;
const devWs = (): string => (typeof __CC_RHWP_COLLAB_DEV_WS__ === 'string' ? __CC_RHWP_COLLAB_DEV_WS__ : '');

export const LAUNCHER_COMMAND = 'ext:collab.start';
const CREATE_TOKEN_KEY = 'collab-create-token';
export const ENCRYPTED_TEXT = '암호 문서는 공동편집할 수 없습니다';
export const ENCRYPTED_ALLOWED_TEXT = '원래 암호가 걸린 문서입니다. 공동편집 중에는 암호가 풀린 상태로 서버에 저장됩니다';
/** 6단계: 서버가 문서를 여는 데 시간 제한을 넘겼다(`422 {error: 'too-slow'}`) */
export const TOO_SLOW_TEXT = '문서가 커서 여는 데 너무 오래 걸립니다. 공동편집으로 쓰기 어렵습니다';
/** 업로드 페이지와 같은 이름·설명 */
export const SCOPE_LABELS: Record<string, [string, string]> = {
  edit: ['편집', '문서를 고칠 수 있습니다'],
  view: ['보기', '문서와 다른 사람 커서만 봅니다'],
  form: ['양식 입력', '누름틀과 양식 칸만 채웁니다'],
  comment: ['메모', '메모만 달 수 있습니다'],
};

export type ServerAuth = 'none' | 'hs256' | 'url';
export interface ServerHealth { auth: ServerAuth; encryptedAllowed: boolean }

/** `/healthz` 답 → 서버 정보. 공동편집 서버의 답이 아니거나 모르는 인증 방식이면 `null`. */
export function parseHealth(body: unknown): ServerHealth | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { ok?: unknown; auth?: unknown; encryptedAllowed?: unknown; embedOnly?: unknown };
  if (b.ok !== true || (b.auth !== 'none' && b.auth !== 'hs256' && b.auth !== 'url')) return null;
  // 6단계 S3: 부품 전용 서버는 방을 바깥 시스템이 만든다 — 메뉴를 내지 않는다
  if (b.embedOnly === true) return null;
  return { auth: b.auth, encryptedAllowed: b.encryptedAllowed === true };
}

/** 같은 출처의 공동편집 서버를 조용히 확인한다(실패해도 던지지 않고 아무것도 남기지 않는다). */
export async function probeServer(fetchFn: typeof fetch, origin: string): Promise<ServerHealth | null> {
  try {
    const res = await fetchFn(`${origin}/healthz`, { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok || !/json/.test(res.headers.get('content-type') ?? '')) return null;
    return parseHealth(await res.json());
  } catch {
    return null;
  }
}

interface StoreLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

/**
 * 주소 조각의 `#create=` 를 이 탭에 옮기고 주소에서 지운다. 돌려주는 값은 쓸 만들기 토큰(조각 또는 저장한 값, 없으면 `null`).
 * `replace` 는 바뀐 조각으로 주소를 바꾸는 함수(새 기록을 남기지 않는다).
 */
export function takeCreateToken(hash: string, store: StoreLike | null, replace: (hash: string) => void): string | null {
  const frag = new URLSearchParams(hash.replace(/^#/, ''));
  const got = frag.get('create');
  if (got !== null) {
    frag.delete('create');
    const rest = frag.toString();
    replace(rest ? `#${rest}` : '');
    if (got) {
      try { store?.setItem(CREATE_TOKEN_KEY, got); } catch { /* 저장소를 쓸 수 없음 — 이번에만 쓴다 */ }
      return got;
    }
  }
  try { return store?.getItem(CREATE_TOKEN_KEY) || null; } catch { return null; }
}

/**
 * hs256 토큰(JWT)의 표시 이름(payload 의 `name`) — 서명은 확인하지 않는다(서버가 한다). 방을 만든 사람이 "이 방으로
 * 들어가기"로 들어갈 때 이름을 다시 묻지 않게 편집 링크에 싣는 데만 쓴다. 읽을 수 없거나 없으면 null.
 */
export function tokenName(token: string | null): string | null {
  const part = token?.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4);
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))) as { name?: unknown };
    return typeof payload?.name === 'string' && payload.name.trim() ? payload.name.trim() : null;
  } catch {
    return null;
  }
}

/** 링크의 주소 조각에 이름을 더한다(들어가기 전용 — 나눠 주는 링크에는 넣지 않는다) */
export function withName(url: string, name: string): string {
  const i = url.indexOf('#');
  const frag = new URLSearchParams(i < 0 ? '' : url.slice(i + 1));
  frag.set('name', name);
  return `${i < 0 ? url : url.slice(0, i)}#${frag}`;
}

export interface CreatedRoom { room: string; invite?: Record<string, string>; inviteExpiresAt?: string; roundtrip?: RoundtripResult | RoundtripPending }
export interface InviteLink { scope: string; label: string; hint: string; url: string }

/**
 * 링크들. 편집기는 이 studio 다. 공동편집 서버가 같은 출처면 `?collab`(빈 값 = 같은 출처 wss), 아니면(개발 서버)
 * `?collab=<ws 주소>`(업로드 페이지와 같은 규칙). 초대 토큰이 있으면 권한마다 하나, 없으면(인증을 끈 서버) 편집기 링크
 * 하나(`#room=` 만).
 */
export function inviteLinks(editor: string, created: CreatedRoom, wsUrl = ''): InviteLink[] {
  const collab = wsUrl ? `collab=${encodeURIComponent(wsUrl)}` : 'collab';
  const link = (token: string | null) => {
    const frag = new URLSearchParams();
    if (token) frag.set('token', token);
    frag.set('room', created.room);
    return `${editor}?${collab}#${frag}`;
  };
  const invite = created.invite ?? null;
  if (!invite || Object.keys(invite).length === 0) return [{ scope: 'edit', label: '편집기', hint: '', url: link(null) }];
  return Object.keys(SCOPE_LABELS)
    .filter((scope) => typeof invite[scope] === 'string')
    .map((scope) => ({ scope, label: SCOPE_LABELS[scope][0], hint: SCOPE_LABELS[scope][1], url: link(invite[scope]) }));
}

/** 방 만들기 실패를 사람이 읽는 말로(서버 답 `{error, reason, message}`). */
export function createErrorText(status: number, body: { error?: string; reason?: string; message?: string; roundtrip?: RoundtripResult } | null): string {
  if (status === 401) return '방을 만들 수 있는 토큰(create)이 필요합니다';
  if (status === 403) return '이 토큰으로는 방을 만들 수 없습니다(create 권한 없음)';
  if (body?.error === 'encrypted' || body?.reason === 'encrypted') return ENCRYPTED_TEXT;
  // 6단계 S2: COLLAB_ROUNDTRIP=block 서버는 rhwp 가 다 다루지 못하는 문서로 방을 만들지 않는다
  if (body?.error === 'roundtrip') return roundtripBlockedText(body.roundtrip);
  if (status === 413) return '문서가 너무 커서 방을 만들 수 없습니다';
  if (body?.error === 'too-slow' || body?.reason === 'too-slow') return TOO_SLOW_TEXT;
  if (status === 415 || status === 422) return '문서를 열지 못해 방을 만들 수 없습니다';
  return `방을 만들지 못했습니다(${status}${body?.message ? `: ${body.message}` : ''})`;
}

/** `POST /rooms` — 결과 또는 사람이 읽는 실패 사유. */
export async function createRoom(fetchFn: typeof fetch, origin: string, bytes: Uint8Array<ArrayBuffer>, token: string | null): Promise<{ ok: true; created: CreatedRoom } | { ok: false; text: string }> {
  let res: Response;
  try {
    res = await fetchFn(`${origin}/rooms`, {
      method: 'POST',
      body: bytes,
      headers: { 'content-type': 'application/octet-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
  } catch {
    return { ok: false, text: '서버에 닿지 못했습니다' };
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  if (res.status === 201 && body && typeof (body as CreatedRoom).room === 'string') return { ok: true, created: body as CreatedRoom };
  return { ok: false, text: createErrorText(res.status, body as { error?: string; reason?: string; message?: string } | null) };
}

/** 결과 전송 바이트(gzip) → 원본 형식 파일 바이트 */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ── 대화상자 (studio 를 모르는 작은 DOM) ───────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

const DIALOG_STYLE = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);font:14px/1.5 system-ui,sans-serif';
const PANEL_STYLE = 'background:#fff;color:#222;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.25);padding:20px 22px;min-width:360px;max-width:640px;max-height:80vh;overflow:auto';

let teardown: (() => void) | null = null;

export const collabLauncherPlugin = {
  id: 'collab-launcher',
  apiVersion: 1,

  async activate(host: PluginHost): Promise<PluginSurface> {
    const origin = window.location.origin;
    const editor = `${origin}${window.location.pathname}`;
    let store: StoreLike | null = null;
    try { store = window.sessionStorage; } catch { store = null; }
    const createToken = { value: takeCreateToken(window.location.hash, store, (hash) => {
      history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${hash}`);
    }) };
    const health = await probeServer(fetch.bind(window), origin);
    let dialog: HTMLElement | null = null;
    const close = () => { dialog?.remove(); dialog = null; };
    teardown = close;
    // 서버가 없거나 바깥 시스템이 방을 만드는 방식이면 아무것도 심지 않는다
    if (!health || health.auth === 'url') return { available: () => false };

    const open = async () => {
      close();
      const root = el('div', { 'data-collab': 'launcher', role: 'dialog', 'aria-label': '공동편집 시작', style: DIALOG_STYLE });
      const panel = el('div', { style: PANEL_STYLE });
      root.append(panel);
      root.addEventListener('click', (e) => { if (e.target === root) close(); });
      document.body.append(root);
      dialog = root;
      const title = el('h2', { style: 'margin:0 0 12px;font-size:18px' }, '공동편집 시작');
      const body = el('div');
      const status = el('p', { 'data-collab': 'launcher-status', style: 'margin:8px 0;color:#a33' });
      const actions = el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px' });
      const cancel = el('button', { type: 'button' }, '닫기');
      cancel.addEventListener('click', close);
      panel.append(title, body, status, actions);

      // D5: 암호 문서
      let protectedDoc = false;
      try { protectedDoc = host.documentProtection?.()?.requiresPasswordForSave === true; } catch { protectedDoc = false; }
      if (protectedDoc && !health.encryptedAllowed) {
        body.append(el('p', { 'data-collab': 'launcher-encrypted' }, ENCRYPTED_TEXT));
        actions.append(cancel);
        return;
      }
      body.append(el('p', {}, '지금 문서로 공동편집 방을 만듭니다. 링크를 받은 사람이 같은 문서를 함께 편집합니다.'));
      if (protectedDoc) body.append(el('p', { 'data-collab': 'launcher-encrypted', style: 'color:#a60' }, ENCRYPTED_ALLOWED_TEXT));
      let tokenInput: HTMLInputElement | null = null;
      if (health.auth === 'hs256' && !createToken.value) {
        tokenInput = el('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: '방 만들기(create) 토큰', 'data-collab': 'launcher-token', style: 'width:100%;box-sizing:border-box;padding:6px' });
        body.append(el('label', { style: 'display:block;margin:6px 0 4px' }, '방을 만들 수 있는 토큰'), tokenInput);
      }
      const create = el('button', { type: 'button', 'data-collab': 'launcher-create' }, '방 만들기');
      actions.append(cancel, create);
      create.addEventListener('click', async () => {
        status.textContent = '';
        const token = health.auth === 'hs256' ? (tokenInput?.value.trim() || createToken.value) : null;
        if (health.auth === 'hs256' && !token) { status.textContent = '방을 만들 수 있는 토큰(create)이 필요합니다'; return; }
        create.setAttribute('disabled', '');
        let bytes: Uint8Array<ArrayBuffer>;
        try {
          const lease = host.borrowDocument();
          if (!lease) throw new Error('문서 없음');
          bytes = await gunzip((lease.handle as unknown as { collabExportState(): Uint8Array }).collabExportState());
        } catch {
          status.textContent = '지금 문서를 내보내지 못했습니다';
          create.removeAttribute('disabled');
          return;
        }
        const res = await createRoom(fetch.bind(window), origin, bytes, token);
        if (!res.ok) { status.textContent = res.text; create.removeAttribute('disabled'); return; }
        if (token && tokenInput) { try { store?.setItem(CREATE_TOKEN_KEY, token); } catch { /* 없음 */ } createToken.value = token; }
        showLinks(res.created, tokenName(token));
      });

      /** creatorName: 만들기 토큰의 이름 — 있으면 "이 방으로 들어가기" 링크에만 실어 이름을 다시 묻지 않는다 */
      const showLinks = (created: CreatedRoom, creatorName: string | null) => {
        body.replaceChildren();
        actions.replaceChildren();
        const links = inviteLinks(editor, created, devWs());
        body.append(el('p', {}, '방을 만들었습니다. 링크를 나눠 주세요.'));
        for (const l of links) {
          const row = el('div', { 'data-collab': 'launcher-link', 'data-scope': l.scope, style: 'margin:8px 0' });
          const head = el('div');
          head.append(el('b', {}, `${l.label} 링크`), el('span', { style: 'color:#666;margin-left:6px' }, l.hint));
          const line = el('div', { style: 'display:flex;gap:6px;align-items:center' });
          const code = el('code', { style: 'flex:1;word-break:break-all;background:#f4f4f4;padding:4px 6px;border-radius:4px' }, l.url);
          const copy = el('button', { type: 'button' }, '복사');
          copy.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(l.url); copy.textContent = '복사함'; } catch { copy.textContent = '직접 복사하세요'; }
            setTimeout(() => { copy.textContent = '복사'; }, 1500);
          });
          line.append(code, copy);
          row.append(head, line);
          body.append(row);
        }
        if (created.inviteExpiresAt) body.append(el('p', { style: 'color:#666' }, `링크는 ${new Date(created.inviteExpiresAt).toLocaleString()}까지 쓸 수 있습니다.`));
        // 6단계 S2: 왕복 점검 결과(서버에 보조가 있을 때만 온다). warn 서버는 기다리지 않고 {pending} — 결과는 방에 들어가면 보인다.
        if (created.roundtrip) {
          const rt = created.roundtrip;
          const text = isRoundtripPending(rt) ? ROUNDTRIP_PENDING_TEXT : roundtripText(rt);
          body.append(el('p', { 'data-collab': 'launcher-roundtrip', style: isRoundtripPending(rt) || rt.ok ? 'color:#666' : 'color:#a60' }, text));
        }
        const enter = el('button', { type: 'button', 'data-collab': 'launcher-enter' }, '이 방으로 들어가기');
        const edit = links.find((l) => l.scope === 'edit') ?? links[0];
        enter.addEventListener('click', () => {
          // 문서는 방에 올라가 있다 — studio 의 "저장하지 않은 변경" 확인을 띄우지 않고 편집 링크로 간다
          host.guardUnload(() => false);
          window.location.assign(creatorName ? withName(edit.url, creatorName) : edit.url);
        });
        const done = el('button', { type: 'button' }, '닫기');
        done.addEventListener('click', close);
        actions.append(done, enter);
      };
    };

    host.automation.registerCommand({ id: LAUNCHER_COMMAND, label: '공동편집 시작…', opensDialog: true, canExecute: (ctx) => ctx.hasDocument, execute: () => { void open(); } });
    host.automation.addMenuItem({ menuId: 'file', commandId: LAUNCHER_COMMAND, position: 'bottom' });
    return {
      available: () => true,
      auth: () => health.auth,
      open: () => { void open(); },
      isOpen: () => dialog !== null,
    };
  },

  deactivate(): void {
    teardown?.();
    teardown = null;
  },
} satisfies StudioPlugin;
