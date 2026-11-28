/**
 * 6단계 N1: 서버 메시지 모양(규약 docs/collab-protocol.md §3.2) — 플랫폼 중립(타입만).
 */
import type { Entry, TextCaret } from '../engine/engine.ts';
import type { ForbiddenMessage, SessionUser, UnauthorizedMessage } from './auth.ts';
import type { RoundtripResult } from './roundtrip.ts';

export type LogItem = { seq: number; clientId: string; entries: Entry[]; batchId?: string; replaced?: boolean };
export type WelcomeMessage = {
  type: 'welcome'; seq: number; base: string | null; log: LogItem[]; resync?: boolean; maxMessageBytes?: number;
  generation?: number; user?: SessionUser; allowEncrypted?: boolean; encryptedSource?: boolean; roundtrip?: RoundtripResult;
};
export type ServerMessage =
  | WelcomeMessage
  // 6단계 S1: `replaced` 면 서버가 그 묶음의 state 를 모델에서 다시 쓴 바이트로 바꿔 기록했다(entries 가 바뀐 것)
  | { type: 'ops'; seq: number; clientId: string; entries: Entry[]; batchId?: string; replaced?: boolean }
  | { type: 'catchup'; seq: number; log: LogItem[]; maxMessageBytes?: number; cont?: boolean; user?: SessionUser }
  | { type: 'reject'; seq: number; batchId?: string }
  | { type: 'diverged'; seq: number }
  | { type: 'incompatible'; engine: string }
  | { type: 'too-large'; what: string; bytes: number; limit: number }
  | { type: 'invalid'; what: 'ops' | 'base'; reason: string; batchId?: string }
  | { type: 'cursor'; clientId: string; name: string; seq: number; caret: TextCaret | null }
  | { type: 'cursor-leave'; clientId: string }
  // 6단계 S2: 방을 연 뒤 뒤에서 끝난 왕복 점검이 통과가 아니다(경고 또는 점검 못 함) — 그때 방에 있던 참여자에게 한 번
  | { type: 'roundtrip'; roundtrip: RoundtripResult }
  | UnauthorizedMessage
  | ForbiddenMessage
  | { type: 'error'; error: string };
