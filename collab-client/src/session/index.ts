/**
 * 공동편집 세션 계층 — 플랫폼 중립(DOM·studio 의존 없음). 규약 docs/collab-protocol.md.
 *
 * 지금은 인증(토큰 공급·hello·이유 코드 분류)과 왕복 점검 결과 문구(6단계 S2)가 있다. 연결·재접속 상태 기계는 아직 `plugin.ts` 에 있고,
 * 4단계를 합친 뒤 이리로 옮긴다(docs/collab-stage5.md D0 "이번에 하지 않는 것").
 */
export * from './auth.ts';
export * from './roundtrip.ts';
