/**
 * 6단계 N1: 세션이 이유 코드로 넘기는 일의 기본 한국어 문구 — 플랫폼 중립(문자열만). studio 어댑터(plugin.ts)가 이것을
 * 쓰고, 다른 호스트는 그대로 쓰거나 덮어쓴다. `kind` 는 안내 줄의 종류 이름이다(studio 는 `data-collab` 값으로 쓴다).
 */
import type { LeaveReason, Notice, ResyncCause, SessionPhase } from './collab-session.ts';
import type { UnauthorizedReason } from './auth.ts';
import { roundtripText } from './roundtrip.ts';

export const AUTOSAVE_NOTICE = '공동편집 중에는 로컬 자동 저장을 하지 않습니다 — 서버 문서가 기준입니다';
/** S3-1: 공동편집 중 조판은 엔진 내장 글꼴 규칙 — 혼자 편집할 때(선언 환경·Canvas 보충 측정)와 배치가 다를 수 있다. */
export const FONT_POLICY_NOTICE = '공동편집 중에는 모두 같은 배치를 쓰므로 혼자 편집할 때와 줄·쪽 나눔이 다를 수 있습니다';
export const RESYNCED_NOTICE = '동기화를 다시 맞췄습니다. 일부 입력이 취소됐을 수 있습니다';
export const DISCONNECT_BANNER = '연결이 끊겼습니다. 편집은 다시 연결되면 보내집니다';
export const LONG_DISCONNECT_NOTICE = '오래 끊겨 있습니다 — 다시 연결되면 동시 편집 충돌로 취소되는 편집이 많을 수 있습니다';
export const RESUME_FALLBACK_NOTICE = '오래 끊겨 서버 문서로 다시 맞췄습니다. 끊긴 동안의 편집 일부가 취소됐을 수 있습니다';
/** S3-2: 서버 정본이 내 편집을 거절했다 — 재동기화로 그 편집을 버리고 서버 문서로 맞춘다. */
export const INVALID_NOTICE = '서버가 편집 하나를 적용하지 못해 거절했습니다. 서버 문서로 다시 맞춥니다';
export const TOO_LARGE_NOTICE = '문서가 커서 이 편집은 공동편집으로 보낼 수 없습니다';
export const VIEW_ONLY_NOTICE = '보기 전용으로 들어왔습니다. 문서를 고칠 수 없습니다';
/** 5단계 D5: 암호 문서. 기본은 막고, 서버가 허용하면(welcome.allowEncrypted) 원래 암호 문서였다고 알리며 올린다. */
export const ENCRYPTED_REFUSED = '암호 문서는 공동편집할 수 없습니다';
export const ENCRYPTED_NOTICE = '원래 암호가 걸린 문서입니다. 공동편집 중에는 암호가 풀린 상태로 서버에 저장됩니다';
export const UNAUTHORIZED_TEXT: Record<UnauthorizedReason, string> = {
  missing: '공동편집 토큰이 없습니다. 받은 링크로 다시 열어 주세요',
  invalid: '공동편집 토큰이 올바르지 않습니다. 받은 링크로 다시 열어 주세요',
  expired: '인증이 만료되었습니다. 다시 열어 주세요',
  room: '이 링크로는 이 방에 들어갈 수 없습니다',
  scope: '이 링크에는 방에 들어갈 권한이 없습니다',
  'no-room': '방이 없습니다. 링크를 확인해 주세요',
  unavailable: '인증 서버에 닿지 못했습니다',
};
export const FORBIDDEN_NOTICE: Record<string, string> = {
  scope: '보기 전용 링크라 편집이 반영되지 않습니다. 서버 문서로 되돌립니다',
  confined: '이 링크로 바꿀 수 있는 부분이 아니라 서버가 거절했습니다. 서버 문서로 되돌립니다',
  unsupported: '이 서버는 양식·메모 권한의 편집을 아직 받지 않습니다. 서버 문서로 되돌립니다',
};

export interface NoticeLine { text: string; kind: string }

/** 안내 하나의 줄들(방에 들어올 때만 두 줄) */
export function noticeTexts(n: Notice): NoticeLine[] {
  switch (n.code) {
    case 'joined': return [{ text: AUTOSAVE_NOTICE, kind: 'notice' }, { text: FONT_POLICY_NOTICE, kind: 'font-policy' }];
    case 'resynced': return [{ text: RESYNCED_NOTICE, kind: 'notice' }];
    case 'resume-fallback': return [{ text: RESUME_FALLBACK_NOTICE, kind: 'resume-fallback' }];
    case 'reconnected': return [{ text: `다시 연결했습니다 — 끊긴 동안의 편집 ${n.received}건을 받았습니다`, kind: 'reconnected' }];
    case 'long-disconnect': return [{ text: LONG_DISCONNECT_NOTICE, kind: 'long-disconnect' }];
    case 'dropped': return [{ text: `동시 편집 충돌로 내 편집 ${n.count}건이 취소됐습니다`, kind: 'notice' }];
    case 'too-large': return [{ text: TOO_LARGE_NOTICE, kind: 'too-large' }];
    case 'invalid': return [{ text: INVALID_NOTICE, kind: 'invalid' }];
    case 'forbidden': return [{ text: FORBIDDEN_NOTICE[n.reason] ?? FORBIDDEN_NOTICE.scope, kind: 'forbidden' }];
    case 'denied': return [{ text: n.message, kind: 'denied' }];
    case 'view-only': return [{ text: VIEW_ONLY_NOTICE, kind: 'view-only' }];
    case 'encrypted-source': return [{ text: ENCRYPTED_NOTICE, kind: 'encrypted-source' }];
    case 'roundtrip': return [{ text: roundtripText(n.result), kind: 'roundtrip' }];
  }
}

/** 재동기화·동기화 깨짐의 까닭(진단 겸 배너) */
export function resyncCauseText(c: ResyncCause): string {
  switch (c.code) {
    case 'seq-gap': return `${c.during === 'catchup' ? '따라잡기 ' : ''}seq 가 건너뛰었습니다 (기대 ${c.expected}, 받음 ${c.got})`;
    case 'apply-failed': return `${c.during === 'replaced' ? '서버가 다시 쓴 결과 적용 실패' : '원격 적용 실패'}: ${c.error}`;
    case 'diverged': return `참여자 간 문서 지문이 다릅니다 (seq ${c.seq})`;
    case 'invalid': return `서버 정본이 편집을 거절: ${c.reason}`;
    case 'forbidden': return `서버가 권한 밖 편집을 거절: ${c.reason}`;
    case 'too-large': return c.side === 'local' ? `편집이 메시지 상한 ${c.limit}바이트를 넘음` : `서버가 메시지 상한(${c.limit}바이트)을 넘는 편집을 거절`;
    case 'error': return `처리 중 오류: ${c.error}`;
    case 'limit': return `재동기화가 1분에 ${c.limit}회를 넘었습니다 (${resyncCauseText(c.last)})`;
  }
}

export const desyncedBannerText = (c: ResyncCause) => `동기화가 깨졌습니다. 새로고침하세요 (${resyncCauseText(c)})`;

/** 방에서 나온 까닭 */
export function leaveText(r: LeaveReason): string {
  switch (r.code) {
    case 'swapped': return '다른 문서로 바뀌었습니다';
    case 'incompatible': return '엔진 버전이 방과 다릅니다. 새로고침하세요';
    case 'encrypted': return ENCRYPTED_REFUSED;
    case 'base-too-large': return '문서가 커서 공동편집을 시작할 수 없습니다';
    case 'base-invalid': return `서버가 이 문서를 열지 못했습니다 (${r.reason})`;
    case 'base-forbidden': return '이 링크로는 문서를 올릴 수 없습니다';
    case 'font-policy': return '글꼴 환경을 고정하지 못했습니다';
    case 'unauthorized': return UNAUTHORIZED_TEXT[r.reason];
    case 'host': return r.detail;
  }
}

/** 나온 뒤 배너: 인증으로 멈춘 경우는 까닭과 보내지 못한 편집 수를 따로(kind 'unauthorized') */
export function leftBanner(r: LeaveReason): NoticeLine {
  if (r.code === 'unauthorized') {
    return { text: `${leaveText(r)}${r.unsent > 0 ? ` — 보내지 못한 편집 ${r.unsent}건은 이 화면에만 있습니다` : ''}`, kind: 'unauthorized' };
  }
  return { text: `공동편집에서 나왔습니다 (${leaveText(r)})`, kind: 'desynced' };
}

export const PHASE_TEXT: Record<SessionPhase, string> = {
  left: '공동편집에서 나옴',
  desynced: '동기화 깨짐',
  connecting: '연결 중',
  closed: '연결 끊김',
  resyncing: '다시 맞추는 중',
  loading: '문서 받는 중',
  sending: '전송 중',
  synced: '동기화됨',
};
