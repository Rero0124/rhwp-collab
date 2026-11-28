/**
 * 6단계 S2 방을 열 때 왕복 점검 결과의 모양과 안내 문구 — 플랫폼 중립(문자열만). 규약 docs/collab-protocol.md §5.
 * 서버는 `POST /rooms` 응답·방 메타에 결과를, welcome 에는 경고가 있을 때만 요약을 싣는다.
 * (서버의 업로드 페이지 server/public/upload.html 은 같은 규칙을 따로 쓴다 — 문구를 바꾸면 함께 바꾼다.)
 */

/**
 * 잃는 것 하나. 7단계 B 배치 점검(kind 'layout')은 숫자를 더 싣는다: pages = [원본 쪽 수, 다시 쓴 것의 쪽 수],
 * maxDisp = 가장 많이 움직인 노드의 변위(px), worstPage = 그 쪽(1부터).
 */
export interface RoundtripLost { kind: string; count: number; detail?: string; pages?: [number, number]; maxDisp?: number; worstPage?: number }
/**
 * ok: true 통과 · false 경고 · null 점검 못 함(reason: 'timeout' 시간 상한을 넘음 · 'error' 점검 워커 실패).
 * layoutUnknown: 배치 점검(COLLAB_ROUNDTRIP_LAYOUT=on)만 끝내지 못했다 — 왕복 점검 결과는 그대로다.
 */
export interface RoundtripResult { ok: boolean | null; lost: RoundtripLost[]; irDiff: number; reason?: string; layoutUnknown?: 'timeout' | 'error' }
/** POST /rooms 응답(warn): 점검이 뒤에서 도는 중 — 결과는 방에 들어가면 welcome·roundtrip 알림으로 온다 */
export interface RoundtripPending { pending: true }
export const isRoundtripPending = (rt: unknown): rt is RoundtripPending => (rt as { pending?: unknown } | null)?.pending === true;

export const ROUNDTRIP_OK_TEXT = 'rhwp 가 이 문서를 그대로 다룰 수 있습니다';
export const ROUNDTRIP_EDIT_WARNING = '이 부분이 있는 쪽을 편집하면 사라질 수 있습니다';
export const ROUNDTRIP_PENDING_TEXT = 'rhwp 가 이 문서를 다룰 수 있는지 점검하고 있습니다. 결과는 방에 들어가면 보입니다';
const UNKNOWN_REASON: Record<string, string> = { timeout: '시간 초과', error: '오류' };
const unknownReason = (rt: RoundtripResult) => UNKNOWN_REASON[rt.reason ?? ''] ?? rt.reason ?? '알 수 없음';

/**
 * 점검이 알려 주는 종류(collab-core `roundtrip_check`)의 이름. 모르는 종류는 그대로 보인다.
 * - ir: 모델에서 다시 쓴 결과를 다시 읽은 모델의 차이 · record(HWP): 파서가 모델에 남기지 않는 레코드
 * - bindata: 그림·첨부 데이터 · ole-clsid(HWP): OLE 개체의 정체(CLSID) · cfb(HWP)·package(HWPX): 파일 구조
 * - layout(7단계 B): 모델에서 다시 쓴 뒤 쪽 수·문단·개체 위치가 달라지는 쪽(count 는 쪽 수)
 */
const KIND_LABELS: Record<string, string> = {
  ir: '내용 차이',
  record: 'rhwp 가 모르는 레코드',
  bindata: '그림·첨부 데이터',
  'ole-clsid': 'OLE 개체',
  cfb: '파일 구조',
  package: '파일 구조',
  layout: '조판(쪽·위치)',
};
const UNIT: Record<string, string> = { ir: '곳', layout: '쪽' };

/** 잃는 것 목록을 한 줄로: "OLE 개체 2개, rhwp 가 모르는 레코드 5개" (없으면 내용 차이 수). ir 의 count 는 차이 수(곳). */
export function roundtripLostText(rt: RoundtripResult): string {
  const parts = (rt.lost ?? []).map((l) => `${KIND_LABELS[l.kind] ?? l.kind} ${l.count}${UNIT[l.kind] ?? '개'}`);
  if (parts.length === 0 && rt.irDiff > 0) parts.push(`내용 차이 ${rt.irDiff}곳`);
  return parts.join(', ');
}

/** 배치 점검만 끝내지 못했을 때 덧붙이는 말 */
const layoutUnknownNote = (rt: RoundtripResult) => (rt.layoutUnknown ? ` (조판 점검 못 함: ${UNKNOWN_REASON[rt.layoutUnknown] ?? rt.layoutUnknown})` : '');

/** 방을 만든 사람에게 보이는 결과 문구 */
export function roundtripText(rt: RoundtripResult): string {
  if (rt.ok) return `${ROUNDTRIP_OK_TEXT}${layoutUnknownNote(rt)}`;
  if (rt.ok === null) return `왕복 점검 못 함(${unknownReason(rt)}) — rhwp 가 이 문서의 모든 부분을 다룰 수 있는지 확인하지 못했습니다. ${ROUNDTRIP_EDIT_WARNING}`;
  const lost = roundtripLostText(rt);
  return `이 문서에는 rhwp 가 다 다루지 못하는 부분이 있습니다${lost ? `: ${lost}` : ''}. ${ROUNDTRIP_EDIT_WARNING}${layoutUnknownNote(rt)}`;
}

/** COLLAB_ROUNDTRIP=block 서버가 방을 만들지 않았을 때 */
export function roundtripBlockedText(rt: RoundtripResult | null | undefined): string {
  if (rt?.ok === null) return `왕복 점검을 끝내지 못해(${unknownReason(rt)}) 방을 만들지 않았습니다`;
  const lost = rt ? roundtripLostText(rt) : '';
  return `rhwp 가 이 문서의 일부를 다루지 못해 방을 만들지 않았습니다${lost ? `: ${lost}` : ''}`;
}
