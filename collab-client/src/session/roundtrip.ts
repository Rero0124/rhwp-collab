/**
 * 6단계 S2 방을 열 때 왕복 점검 결과의 모양과 안내 문구 — 플랫폼 중립(문자열만). 규약 docs/collab-protocol.md §5.
 * 서버는 `POST /rooms` 응답·방 메타에 결과를, welcome 에는 경고가 있을 때만 요약을 싣는다.
 * (서버의 업로드 페이지 server/public/upload.html 은 같은 규칙을 따로 쓴다 — 문구를 바꾸면 함께 바꾼다.)
 */

export interface RoundtripLost { kind: string; count: number; detail?: string }
export interface RoundtripResult { ok: boolean; lost: RoundtripLost[]; irDiff: number }

export const ROUNDTRIP_OK_TEXT = 'rhwp 가 이 문서를 그대로 다룰 수 있습니다';
export const ROUNDTRIP_EDIT_WARNING = '이 부분이 있는 쪽을 편집하면 사라질 수 있습니다';

/** 점검이 알려 주는 종류의 이름. 모르는 종류는 그대로 보인다. */
const KIND_LABELS: Record<string, string> = {
  bindata: '그림·첨부 데이터',
  ole: 'OLE 개체',
  'ole-clsid': 'OLE 개체',
  record: 'rhwp 가 모르는 레코드',
  ir: '내용',
  cfb: '파일 구조',
};

/** 잃는 것 목록을 한 줄로: "OLE 개체 2개, rhwp 가 모르는 레코드 5개" (없으면 내용 차이 수) */
export function roundtripLostText(rt: RoundtripResult): string {
  const parts = (rt.lost ?? []).map((l) => `${KIND_LABELS[l.kind] ?? l.kind} ${l.count}개`);
  if (parts.length === 0 && rt.irDiff > 0) parts.push(`내용 차이 ${rt.irDiff}곳`);
  return parts.join(', ');
}

/** 방을 만든 사람에게 보이는 결과 문구 */
export function roundtripText(rt: RoundtripResult): string {
  if (rt.ok) return ROUNDTRIP_OK_TEXT;
  const lost = roundtripLostText(rt);
  return `이 문서에는 rhwp 가 다 다루지 못하는 부분이 있습니다${lost ? `: ${lost}` : ''}. ${ROUNDTRIP_EDIT_WARNING}`;
}

/** COLLAB_ROUNDTRIP=block 서버가 방을 만들지 않았을 때 */
export function roundtripBlockedText(rt: RoundtripResult | null | undefined): string {
  const lost = rt ? roundtripLostText(rt) : '';
  return `rhwp 가 이 문서의 일부를 다루지 못해 방을 만들지 않았습니다${lost ? `: ${lost}` : ''}`;
}
