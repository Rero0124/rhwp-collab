/**
 * 분류표 조회 (docs/collab-stage2.md §3).
 *
 * 기록 훅은 분류표가 아니라 실행 중인 studio 의 변경 메서드 목록 전체를 감싼다. 분류표에 없는 이름은
 * 새 업스트림 기능이므로 결과(문서 전체)로 보낸다 — "새 기능은 느리더라도 동작은 한다".
 */
import { CATALOG } from './catalog.ts';
import { UNCLASSIFIED, type CatalogEntry } from './types.ts';

/** 메서드 하나의 분류. 분류표에 없으면 `state`/`structural`. */
export function classify(name: string, catalog: Readonly<Record<string, CatalogEntry>> = CATALOG): CatalogEntry {
  return catalog[name] ?? { ...UNCLASSIFIED, params: [], section: null };
}

/**
 * 기록 훅이 감쌀 메서드 이름.
 *
 * 실행 중인 studio 의 변경 메서드 목록(`MUTATING_METHODS`) 가운데 문서 객체에 실제로 있는 것과, 분류표의
 * 모든 이름(레지스트리 밖의 복원·Ex export 포함)의 합집합. 문서 객체에 없는 이름(studio 합성 메서드)은
 * 감쌀 수 없고, 그 안에서 부르는 export 가 분류표에 있다.
 */
export function methodsToIntercept(
  runtimeMutating: readonly string[],
  hasMethod: (name: string) => boolean,
  catalog: Readonly<Record<string, CatalogEntry>> = CATALOG,
): string[] {
  const names = new Set<string>();
  for (const name of runtimeMutating) if (hasMethod(name)) names.add(name);
  for (const name of Object.keys(catalog)) if (hasMethod(name)) names.add(name);
  return [...names].sort();
}
