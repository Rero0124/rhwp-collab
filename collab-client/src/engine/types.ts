/**
 * collab 엔진 공용 타입 (docs/collab-stage2.md §3).
 *
 * 엔진은 studio 를 모른다. 이 파일도 studio·wasm 모듈을 import 하지 않는다.
 */

/**
 * - `op`: export 이름 + 인자로 재생
 * - `state`: 결과(문서 전체) 전송
 * - `local`: 문서가 아닌 보기 상태. 공유하지 않는다
 * - `none`: 문서를 바꾸지 않는다(글꼴 등록·렌더·세션 상태). 기록하지 않는다
 * - `watch`: 분류표에 없는 레지스트리 밖 이름(digest 감시). 호출 전후 digest 가 바뀌면 `state` 기록
 */
export type Sync = 'op' | 'state' | 'local' | 'none' | 'watch';

/** 결과에 영향을 주는 로컬 세션 상태 — 기록 때 실측해 담고 재생 때 그 값으로 맞춘다. */
/**
 * S3-1 글꼴 정책 — 공동편집 중 조판은 엔진 내장 규칙만, 표시는 내장 웹 글꼴만(studio `host.setFontPolicy`).
 * Node(서버 정본·시뮬레이션)와 같은 조판 환경이다. 이 값은 엔진 코드라 엔진 지문(코드 해시)에 들어간다 —
 * 정책이 다른 참여자는 같은 방에 들어오지 못한다.
 */
export const FONT_POLICY = 'bundled-only' as const;

export type CtxKey = 'activeField' | 'clipboard' | 'memoTime';

/** `text`: §4.4 정밀 보정 / `neutral`: 구조 불변(§4.5) / `structural`: 구조를 바꿈(§4.5) */
export type Conc = 'text' | 'neutral' | 'structural';

/**
 * `neutral` 연산의 위치 인자 의미. 텍스트 연산이 문단 번호·오프셋을 옮길 때 같이 옮긴다.
 * `arg` 는 인자 위치(0 부터).
 *
 * - `para`: 본문 문단 하나 전체에 적용(문단 서식 등). 문단 번호로 옮긴다.
 * - `range`: 한 본문 문단 안 텍스트 범위 `[start, end)`. 시작은 bias After, 끝은 bias Before 로
 *   옮기고, 비면 버린다. 두 문단으로 갈리면 충돌.
 * - `anchor`: 개체(표·그림·도형·수식·각주·양식·책갈피 등)가 든 본문 문단. 문단 번호로 옮기되
 *   그 문단을 구조적으로 건드리면(나눔·합침·걸친 삭제) 개체 번호가 바뀔 수 있어 충돌.
 */
export type Role =
  | { kind: 'para'; arg: number }
  | { kind: 'range'; para: number; start: number; end: number }
  /** R13: 구조 연산이면 발자국의 기준 문단(`arg`), 표 구조 연산은 + 개체(`control`). */
  | { kind: 'anchor'; arg: number; control?: number };

/** 분류표 항목 (생성물). */
export interface CatalogEntry {
  sync: Sync;
  conc: Conc;
  /** 인자 이름(업스트림 Rust export 의 매개변수 이름). 감사 시점과 다르면 생성 스크립트가 state 로 내린다. */
  params: readonly string[];
  /** 구역 인자 위치. `null` 이면 문서 전체. */
  section: number | null;
  /** `neutral` 의 위치 인자. 위치 인자가 없으면 빈 배열. */
  roles?: readonly Role[];
  /** 결과가 조판(쪽 나눔·렌더 위치)에 기댄다. 기록·재생·재적용 직전에 미뤄 둔 조판을 끝낸다. */
  layout?: boolean;
  /** 결과에 영향을 주는 로컬 세션 상태(숨은 입력). */
  ctx?: readonly CtxKey[];
  /** 근거(`state`·`neutral`·`local`·`none` 필수), 또는 미분류 표시. */
  why?: string;
  /** studio 호출처(R14): 메뉴·도구·단축키 경로 / 플러그인·hwpctl 경로나 다리에서만 / 부르지 않음. */
  reach?: 'studio' | 'plugin' | 'none';
  /**
   * 5단계 D4: 이 편집에 필요한 권한(좁은 권한). `form` = 양식 값(누름틀 값·양식 개체), `memo` = 메모. 없으면 `edit`
   * (새 함수도 `edit` — 좁은 권한에서는 막힌다). 글자 연산의 누름틀 안 입력은 `form` 권한에서 따로 판정한다.
   */
  perm?: Perm;
  /** 사람이 감사한 항목인가. `false` 면 새 업스트림 기능이라 보수적 기본값(레지스트리 안은 state, 밖은 watch)이다. */
  reviewed: boolean;
}

/** 덮어쓰기 파일의 항목 (사람이 쓴다). 기본값은 `op` / `structural`. */
export interface CatalogOverride {
  /** 감사 시점의 인자 이름. 업스트림이 바꾸면 생성 스크립트가 state 로 내린다. */
  params: readonly string[];
  sync?: Sync;
  conc?: Conc;
  roles?: readonly Role[];
  layout?: boolean;
  ctx?: readonly CtxKey[];
  why?: string;
  perm?: Perm;
}

/** 5단계 D4: 좁은 권한 표시(분류표 `perm`). */
export type Perm = 'form' | 'memo';

/** 분류표에 없는 레지스트리 이름의 처리(사용자 결정: 새 기능은 느려도 동작한다). */
export const UNCLASSIFIED: Omit<CatalogEntry, 'params' | 'section'> = {
  sync: 'state',
  conc: 'structural',
  why: '분류표에 없는 변경 메서드 — 결과(문서 전체)로 보낸다',
  reviewed: false,
};
