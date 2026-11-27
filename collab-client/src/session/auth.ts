/**
 * 공동편집 세션의 인증 계층 (docs/collab-stage5.md D0, 규약 docs/collab-protocol.md §2·§4.7).
 *
 * 플랫폼 중립이다 — DOM·studio·WebSocket 에 의존하지 않는다. 웹 플러그인과 네이티브 클라이언트가 같은 규칙을 쓴다.
 * 클라이언트는 토큰을 해석하지 않고(불투명 문자열) 들고 가기만 한다. 검증은 서버만 한다.
 *
 * - 토큰 공급자(`TokenProvider`)는 호스트(studio, 네이티브 앱, 바깥 시스템)가 자기 방식으로 만든다.
 * - `AuthSession` 이 연결마다 토큰을 받아 hello 에 싣고, `unauthorized` 를 받으면 다음 동작을 정한다.
 *   만료(expired)면 새 토큰을 한 번 더 받아 다시 시도하고, 그래도 안 되면 포기한다.
 */

/** 토큰을 달라는 까닭: 처음 연결 / 끊겨서 다시 연결 / 서버가 만료라고 함 */
export type TokenReason = 'connect' | 'reconnect' | 'expired';
export interface TokenRequest { room: string; reason: TokenReason }
/**
 * 토큰 공급자. 줄 토큰이 없으면 null(인증을 끈 서버는 토큰 없이 받는다). 'expired' 에 null 을 주면 갱신할 수 없다는
 * 뜻이라 세션은 포기한다. 던진 오류는 null 과 같게 다룬다.
 */
export type TokenProvider = (req: TokenRequest) => Promise<string | null> | string | null;

/** 규약 §2.4 `unauthorized.reason` */
export const UNAUTHORIZED_REASONS = ['missing', 'invalid', 'expired', 'room', 'scope', 'no-room', 'unavailable'] as const;
export type UnauthorizedReason = (typeof UNAUTHORIZED_REASONS)[number];

/** 규약 §2.5 `forbidden.reason` */
export const FORBIDDEN_REASONS = ['scope', 'unsupported', 'confined'] as const;
export type ForbiddenReason = (typeof FORBIDDEN_REASONS)[number];

/** 권한(scope) — 규약 §2.2 */
export const SCOPES = ['view', 'form', 'comment', 'edit', 'create'] as const;
export type Scope = (typeof SCOPES)[number];

/** welcome·catchup 이 알려 주는 확인된 사용자(인증을 켠 서버만) */
export interface SessionUser { sub: string | null; name: string | null; scope: string[] }

export type UnauthorizedMessage = { type: 'unauthorized'; reason: string };
export type ForbiddenMessage = { type: 'forbidden'; what: 'ops' | 'base'; reason: string; batchId?: string };

/** 이유 코드의 처리 분류: 새 토큰으로 곧바로 / 연결 끊김처럼 백오프로 / 포기 */
export type UnauthorizedClass = 'refresh' | 'retry' | 'fatal';

export function classifyUnauthorized(reason: string): UnauthorizedClass {
  if (reason === 'expired') return 'refresh';
  if (reason === 'unavailable') return 'retry';
  return 'fatal';
}

/** 모르는 이유 코드(새 서버)는 invalid 로 본다 — 포기한다. */
export function knownUnauthorized(reason: string): UnauthorizedReason {
  return (UNAUTHORIZED_REASONS as readonly string[]).includes(reason) ? reason as UnauthorizedReason : 'invalid';
}

export type AuthDecision =
  /** 새 토큰을 받았다 — 곧바로 다시 붙는다(백오프 없이) */
  | { action: 'reconnect' }
  /** 인증 서버에 닿지 못함 — 연결 끊김과 같이 백오프로 다시 붙는다 */
  | { action: 'backoff' }
  /** 다시 붙지 않는다. reason 으로 안내한다 */
  | { action: 'give-up'; reason: UnauthorizedReason };

/** 편집 권한: edit(모든 편집) / confined(form·comment — 서버가 결과로 확인) / none(view) */
export function editLevel(scope: readonly string[]): 'edit' | 'confined' | 'none' {
  if (scope.includes('edit')) return 'edit';
  return scope.includes('form') || scope.includes('comment') ? 'confined' : 'none';
}

export class AuthSession {
  private readonly room: string;
  private readonly getToken: TokenProvider;
  /** 'expired' 로 받아 둔 새 토큰 — 다음 hello 에 쓴다 */
  private refreshed: string | null = null;
  /** 이번 만료에 이미 한 번 갱신했다(방에 들어가면 되돌린다) */
  private refreshedOnce = false;
  private connects = 0;
  /** 진행 중인 unauthorized 판단(새 토큰 받기) — 그 사이에 다시 붙어도 hello 는 판단이 끝난 뒤에 */
  private deciding: Promise<unknown> | null = null;
  /** 서버가 알려 준 확인된 사용자 */
  user: SessionUser | null = null;

  constructor({ room, getToken }: { room: string; getToken?: TokenProvider }) {
    this.room = room;
    this.getToken = getToken ?? (() => null);
  }

  /** 다음 hello 에 실을 토큰. 첫 연결은 'connect', 그 뒤는 'reconnect'(만료로 받아 둔 토큰이 있으면 그것). */
  async helloToken(): Promise<string | null> {
    if (this.deciding) await this.deciding;
    const reason: TokenReason = this.connects++ === 0 ? 'connect' : 'reconnect';
    if (this.refreshed !== null) {
      const token = this.refreshed;
      this.refreshed = null;
      return token;
    }
    return this.ask(reason);
  }

  /** `unauthorized` 를 받았다. 서버는 곧 연결을 닫는다 — 결과에 따라 다시 붙거나 멈춘다. */
  onUnauthorized(reason: string): Promise<AuthDecision> {
    const decision = this.decide(reason);
    const pending = decision.then(() => undefined, () => undefined);
    this.deciding = pending;
    void pending.then(() => { if (this.deciding === pending) this.deciding = null; });
    return decision;
  }

  private async decide(reason: string): Promise<AuthDecision> {
    const kind = classifyUnauthorized(reason);
    if (kind === 'retry') return { action: 'backoff' };
    if (kind === 'refresh' && !this.refreshedOnce) {
      this.refreshedOnce = true;
      const token = await this.ask('expired');
      if (token) {
        this.refreshed = token;
        return { action: 'reconnect' };
      }
    }
    return { action: 'give-up', reason: knownUnauthorized(reason) };
  }

  /** 방에 들어갔다(welcome·catchup). 만료 갱신 횟수를 되돌리고 확인된 사용자를 기억한다. */
  admitted(user?: SessionUser | null): void {
    this.refreshedOnce = false;
    if (user) this.user = user;
  }

  private async ask(reason: TokenReason): Promise<string | null> {
    try {
      const token = await this.getToken({ room: this.room, reason });
      return typeof token === 'string' && token ? token : null;
    } catch {
      return null;
    }
  }
}

export interface HelloInput {
  room: string;
  clientId: string;
  /** 표시 이름. 토큰에 name 이 있으면 서버는 그것을 쓴다(이 값은 확인되지 않은 표시용) */
  name: string;
  /** 엔진 지문 — 방과 같아야 한다 */
  engine: string;
  token?: string | null;
  /** 다시 붙음(규약 §4.6): 마지막으로 받은 seq 와 그 세대 */
  resume?: { lastSeq: number; generation: number } | null;
}

/** 규약 §3.1 hello 메시지 */
export function buildHello(h: HelloInput): Record<string, unknown> {
  return {
    type: 'hello',
    room: h.room,
    clientId: h.clientId,
    name: h.name,
    engine: h.engine,
    ...(h.resume ? { lastSeq: h.resume.lastSeq, generation: h.resume.generation } : {}),
    ...(h.token ? { token: h.token } : {}),
  };
}
