/**
 * 공동편집 세션 계층 — 플랫폼 중립(DOM·studio 의존 없음). 규약 docs/collab-protocol.md §9.
 *
 * 인증(토큰 공급·hello·이유 코드 분류), 연결 상태 기계(CollabSession — 6단계 N1), 서버 메시지 모양, 기본 문구,
 * 왕복 점검 결과 문구(6단계 S2). studio 어댑터는 `../plugin.ts` 다.
 */
export * from './auth.ts';
export * from './roundtrip.ts';
export * from './protocol.ts';
export * from './collab-session.ts';
export * from './texts.ts';
