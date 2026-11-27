// 접속 인증 (docs/collab-stage5.md D0·D1, 규약 docs/collab-protocol.md §2).
//
// 서버의 인증은 `verify(token, room) → {sub, name, scope}` 하나로 모은다. 확인 방식(COLLAB_AUTH)은 이것의 구현이다.
//   none   확인하지 않는다(루프백 기본값). 모두 edit 권한, sub 없음
//   hs256  JWT HS256 을 공유 비밀키로 확인한다(COLLAB_AUTH_SECRET 또는 COLLAB_AUTH_SECRET_FILE)
//   url    바깥 시스템(COLLAB_AUTH_URL)에 {token, room} 을 POST 하고 {ok, sub, name, scope} 를 받는다
// 바깥 시스템이 자기 검증 함수를 끼우려면 `startServer({ auth: { mode: '이름', verify } })` 로 넘긴다.
//
// 실패는 `AuthError(reason)` 로 던진다. reason 은 규약의 이유 코드(UNAUTHORIZED_REASONS)다.
// room 이 null 이면 방을 확인하지 않는다(방 만들기 API — 방 이름은 서버가 정한다).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

/** 규약의 `unauthorized.reason` (docs/collab-protocol.md §2.4) */
export const UNAUTHORIZED_REASONS = ['missing', 'invalid', 'expired', 'room', 'scope', 'no-room', 'unavailable'];
/**
 * 권한(scope, 공백으로 구분한 목록 — 함께 줄 수 있다). 클레임이 없으면 edit. docs/collab-protocol.md §2.2
 *   view     문서·다른 사람 커서를 받고 자기 커서를 보낸다. 편집은 못 한다
 *   form     view + 양식만 채운다(누름틀 안 글자, 양식 개체 값) — 서버 정본이 결과로 확인한다(D4)
 *   comment  view + 메모만 단다 — 서버 정본이 결과로 확인한다(D4)
 *   edit     모든 편집
 *   create   방 만들기 API(POST /rooms)
 */
export const SCOPES = ['view', 'form', 'comment', 'edit', 'create'];
/** 방에 들어갈 수 있는 권한(하나라도 있어야 hello 가 통과한다) */
export const JOIN_SCOPES = ['view', 'form', 'comment', 'edit'];
/** 편집을 허용된 부분으로만 좁히는 권한 — 정본이 결과로 확인한다 */
export const CONFINED_SCOPES = ['form', 'comment'];

/**
 * 연결의 편집 권한: 'edit'(모든 편집) | 'confined'(form·comment — kinds 만) | 'none'(view).
 * @param {string[]} scope
 */
export function editPermission(scope) {
  if (scope.includes('edit')) return { level: 'edit', kinds: [] };
  const kinds = CONFINED_SCOPES.filter((s) => scope.includes(s));
  return kinds.length ? { level: 'confined', kinds } : { level: 'none', kinds: [] };
}
/** exp·nbf 의 시계 오차 허용(초) */
export const CLOCK_TOLERANCE_SEC = 30;
/** HS256 비밀키 최소 길이(바이트) — 짧은 키는 시작을 거부한다 */
export const MIN_SECRET_BYTES = 32;

export class AuthError extends Error {
  constructor(reason, message = reason) {
    super(message);
    this.reason = UNAUTHORIZED_REASONS.includes(reason) ? reason : 'invalid';
  }
}

/**
 * 확인 결과를 규약 모양으로 맞춘다. scope 는 공백으로 구분한 문자열 또는 배열, 없으면 edit.
 * 모르는 권한 이름은 버린다(앞으로 생길 권한을 옛 서버가 넓게 해석하지 않게).
 */
export function normalizeUser({ sub, name, scope } = {}) {
  const list = scope === undefined || scope === null ? ['edit']
    : (Array.isArray(scope) ? scope : String(scope).split(/\s+/)).filter((s) => SCOPES.includes(s));
  return {
    sub: typeof sub === 'string' && sub ? sub : null,
    name: typeof name === 'string' && name ? name : null,
    scope: [...new Set(list)],
  };
}

/** 토큰의 room 클레임이 요청한 방을 덮는지. room 이 null 이면 확인하지 않는다. */
export function roomAllowed(claim, room) {
  if (room === null || room === undefined) return true;
  return claim === '*' || claim === room;
}

// ── JWT HS256 ─────────────────────────────────────────────────────────
// 직접 구현한다(설계 결정 Q2): alg 는 정확히 HS256, base64url 은 엄격히, 서명 비교는 길이를 먼저 맞춘 뒤
// timingSafeEqual, exp 필수, nbf 는 있으면, 시계 오차 30초.

const B64URL = /^[A-Za-z0-9_-]*$/;

/** 엄격한 base64url: 알파벳 밖 문자·채움(=)·길이 나머지 1 은 거절, 다시 인코딩해 같아야 한다. */
function b64urlDecode(part) {
  if (typeof part !== 'string' || !B64URL.test(part) || part.length % 4 === 1) throw new AuthError('invalid', 'base64url 이 아니다');
  const buf = Buffer.from(part, 'base64url');
  if (buf.toString('base64url') !== part) throw new AuthError('invalid', 'base64url 이 정규형이 아니다');
  return buf;
}

function jsonPart(part) {
  let value;
  try { value = JSON.parse(b64urlDecode(part).toString('utf8')); } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('invalid', 'JSON 이 아니다');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthError('invalid', '객체가 아니다');
  return value;
}

const hmac = (secret, data) => createHmac('sha256', secret).update(data).digest();

/** 시험·발급 도구용 서명. 서버는 초대 토큰(POST /rooms)을 만들 때만 쓴다. */
export function signHs256(claims, secret) {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${head}.${body}.${hmac(secret, `${head}.${body}`).toString('base64url')}`;
}

/** HS256 토큰을 확인하고 클레임을 돌려준다(방·권한은 보지 않는다). */
export function verifyHs256(token, secret, { now = Date.now() / 1000, tolerance = CLOCK_TOLERANCE_SEC } = {}) {
  if (typeof token !== 'string' || !token) throw new AuthError('missing', '토큰이 없다');
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('invalid', 'JWT 형식이 아니다');
  const [h, p, s] = parts;
  const header = jsonPart(h);
  if (header.alg !== 'HS256') throw new AuthError('invalid', `alg 가 HS256 이 아니다 (${String(header.alg)})`);
  if (header.crit !== undefined) throw new AuthError('invalid', 'crit 헤더는 받지 않는다');
  const given = b64urlDecode(s);
  const expected = hmac(secret, `${h}.${p}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new AuthError('invalid', '서명이 맞지 않다');
  const claims = jsonPart(p);
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) throw new AuthError('invalid', 'exp 가 없다');
  if (now >= claims.exp + tolerance) throw new AuthError('expired', '토큰이 만료되었다');
  if (claims.nbf !== undefined) {
    if (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf)) throw new AuthError('invalid', 'nbf 가 숫자가 아니다');
    if (now < claims.nbf - tolerance) throw new AuthError('invalid', '아직 쓸 수 없는 토큰이다(nbf)');
  }
  if (typeof claims.sub !== 'string' || !claims.sub) throw new AuthError('invalid', 'sub 가 없다');
  if (typeof claims.room !== 'string' || !claims.room) throw new AuthError('invalid', 'room 이 없다');
  return claims;
}

// ── 확인 방식 ──────────────────────────────────────────────────────────

/** 확인하지 않는다. 누구나 edit·create. 토큰을 실어 와도 보지 않는다. */
export function noneAuth() {
  return { mode: 'none', verify: async () => ({ sub: null, name: null, scope: ['edit', 'create'] }) };
}

/** HS256 공유 비밀키. `issue` 로 초대 토큰을 만들 수 있다. */
export function hs256Auth(secret, { tolerance = CLOCK_TOLERANCE_SEC } = {}) {
  const key = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret ?? ''), 'utf8');
  if (key.length < MIN_SECRET_BYTES) throw new Error(`COLLAB_AUTH_SECRET 는 ${MIN_SECRET_BYTES}바이트 이상이어야 한다 (지금 ${key.length})`);
  return {
    mode: 'hs256',
    verify: async (token, room) => {
      const claims = verifyHs256(token, key, { tolerance });
      if (!roomAllowed(claims.room, room)) throw new AuthError('room', '토큰의 방이 다르다');
      return normalizeUser(claims);
    },
    /** 서명한 토큰을 만든다(초대 토큰·시험). */
    issue: (claims) => signHs256(claims, key),
  };
}

/**
 * 바깥 시스템에 묻는다: POST url {token, room} → {ok: true, sub, name?, scope?} | {ok: false, reason}.
 * 닿지 못하거나(네트워크·시간 초과·5xx) 답이 형식에 맞지 않으면 unavailable — 클라이언트는 다시 붙는다.
 */
export function urlAuth(url, { timeoutMs = 5000, fetchImpl = globalThis.fetch } = {}) {
  if (!/^https?:\/\//.test(String(url ?? ''))) throw new Error(`COLLAB_AUTH_URL 이 http(s) 주소가 아니다: ${url}`);
  return {
    mode: 'url',
    verify: async (token, room) => {
      if (typeof token !== 'string' || !token) throw new AuthError('missing', '토큰이 없다');
      let res;
      let body;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, room: room ?? null }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        body = await res.json();
      } catch (error) {
        throw new AuthError('unavailable', `인증 서버에 닿지 못함: ${error?.message ?? error}`);
      }
      if (res.status >= 500) throw new AuthError('unavailable', `인증 서버 오류 ${res.status}`);
      if (!body || typeof body !== 'object') throw new AuthError('unavailable', '인증 서버 답이 객체가 아니다');
      if (body.ok !== true) throw new AuthError(typeof body.reason === 'string' ? body.reason : 'invalid', '인증 서버가 거절함');
      const user = normalizeUser(body);
      if (!user.sub) throw new AuthError('unavailable', '인증 서버 답에 sub 가 없다');
      return user;
    },
  };
}

/** HOST 가 루프백인지(127.0.0.0/8, ::1, localhost). */
export function isLoopback(host) {
  const h = String(host ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost') return true;
  if (isIP(h) === 4) return h.startsWith('127.');
  if (isIP(h) === 6) return h === '::1' || h === '0:0:0:0:0:0:0:1' || /^::ffff:127\./.test(h);
  return false;
}

/**
 * 환경 변수로 확인 방식을 정한다. 기본값: HOST 가 루프백이면 none, 아니면 설정이 없을 때 시작을 거부한다.
 * 루프백이 아닌데 COLLAB_AUTH=none 을 명시하면 허용하고 경고를 남긴다.
 */
export function authFromEnv(env = process.env, { host = '127.0.0.1', warn = console.warn } = {}) {
  const mode = env.COLLAB_AUTH ?? '';
  if (mode === '') {
    if (!isLoopback(host)) throw new Error(`HOST=${host} 는 루프백이 아니다 — COLLAB_AUTH(hs256 | url | none)를 정해야 한다`);
    return noneAuth();
  }
  if (mode === 'none') {
    if (!isLoopback(host)) warn(`경고: HOST=${host} 에서 인증 없이(COLLAB_AUTH=none) 받는다 — 주소를 아는 누구나 들어올 수 있다`);
    return noneAuth();
  }
  if (mode === 'hs256') {
    let secret = env.COLLAB_AUTH_SECRET;
    if (!secret && env.COLLAB_AUTH_SECRET_FILE) secret = readFileSync(env.COLLAB_AUTH_SECRET_FILE, 'utf8').replace(/\r?\n$/, '');
    if (!secret) throw new Error('COLLAB_AUTH=hs256 에는 COLLAB_AUTH_SECRET 또는 COLLAB_AUTH_SECRET_FILE 이 필요하다');
    return hs256Auth(secret);
  }
  if (mode === 'url') {
    if (!env.COLLAB_AUTH_URL) throw new Error('COLLAB_AUTH=url 에는 COLLAB_AUTH_URL 이 필요하다');
    return urlAuth(env.COLLAB_AUTH_URL);
  }
  throw new Error(`모르는 COLLAB_AUTH: ${mode} (none | hs256 | url)`);
}

/** "24h"·"30m"·"86400" 같은 기간 → 초. */
export function parseDuration(value, fallbackSec) {
  if (value === undefined || value === null || value === '') return fallbackSec;
  const m = /^(\d+)\s*([smhd]?)$/.exec(String(value).trim());
  if (!m) throw new Error(`기간 형식이 아니다: ${value} (예: 86400, 30m, 24h, 7d)`);
  return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}
