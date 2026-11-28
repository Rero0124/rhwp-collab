# 공동편집 7단계: 결과 전송 충돌 줄이기, 배치 점검, 암호 다시 걸기

6단계(`docs/collab-stage6.md`) 다음으로 남은 후보를 필요한 순서대로 한다(사용자 결정, 2026-11-28, Linux 시험은 제외).

1. **A 결과 전송에 자동 범위 표시** — 사용감에 가장 크게 닿는다. rhwp 가 아직 op 로 못 보내는 기능(state 53종)을 쓸 때마다
   다른 참여자의 왕복 중 입력이 취소되는 문제를 줄인다.
2. **B 방을 열 때 배치 점검** — 6단계 S2 왕복 점검에 "다시 쓰면 화면 배치가 달라지는가"를 더한다.
3. **C 내려받을 때 암호 다시 걸기** — 5단계 D5 의 다음 후보.

B·C 는 A 와 겹치지 않아 동시에 한다. A 는 4단계 U3-b 를 마친 뒤 시작한다.

## A 결과 전송에 자동 범위 표시

U3(4단계 §6)의 범위 표시 장치(`range: {section, lo, before, after}`, 받는 쪽 보정, 서버 확인, 미확정 다시 만들기)를 되돌리기
밖의 일반 state 에도 쓴다.

- **보내는 쪽:** state 가 될 호출 직전의 문서와 직후의 문서를 견준다. 다음이 모두 맞을 때만 범위 표시를 단다.
  - 바뀐 구역이 하나이고, 그 구역에서 바뀐 부분이 연속 문단 범위다(앞뒤 공통 문단을 깎아 구함, vpos 는 빼고 비교 — 서버의
    `para_same` 을 다시 쓴다).
  - **DocInfo 가 바뀌지 않았다.** 덧붙인 항목이 있으면 다시 만들 때 남이 그사이 덧붙인 항목과 번호가 겹칠 수 있으므로 이번에는
    표시를 달지 않는다(보통 state 로 보낸다). 덧붙인 항목을 다시 번호 매기는 일은 다음 후보다.
  - 그 밖의 문서 부분(구역 정의, 바탕쪽, 머리말 등 범위 밖)이 그대로다.
- **미확정 다시 만들기:** 보정에서 범위가 남과 겹치지 않으면 "after 문단을 옮긴 lo 에 다시 끼우기"로 다시 만든다(재료는 after
  문단). 겹치면 지금처럼 충돌이다.
- **받는 쪽·서버:** U3 와 같다(구조 발자국처럼 보정, `check_range_hint` 로 확인, 거짓이면 invalid range).
- **측정:** R1b 사례 문서로 state 53종을 한 번씩 돌려, 몇 종이 범위 표시를 얻는지(구역·DocInfo 조건별) 표로 남긴다.
- **시험:** R5 에 state 기능 섞기 + 범위 표시, 브라우저에서 B 가 계속 치는 중 A 가 state 기능(예: 덧말 넣기)을 써도 B 의 입력이
  취소되지 않음, 조건이 안 맞는 state 는 지금처럼 보통 state.

## B 방을 열 때 배치 점검

- 6단계 S2 의 왕복 점검은 모델·레코드·첨부만 본다. rhwp 가 모델에서 다시 쓴 뒤 **조판 결과**(쪽 수, 문단·개체 위치)가 달라지는지도
  본다. rhwp 의 `render-diff`(라운드트립 시각 정합성 게이트) 핵심을 쓴다.
- 결과는 왕복 점검의 `lost` 에 `kind: 'layout'` 으로 더한다: `{pages: [원본, 다시 쓴 것], maxDisp(px), worstPage}`.
  쪽 수가 다르거나 변위가 정한 값(예: 1px)을 넘으면 경고다.
- 무겁다. 점검 워커의 시간 상한(`COLLAB_ROUNDTRIP_TIMEOUT_MS`) 안에서 돌고, 설정 `COLLAB_ROUNDTRIP_LAYOUT=on|off` 로 켜고 끈다.
  기본값은 샘플 측정(걸린 시간, 경고 수) 뒤 정한다.
- 정본 엔진(글꼴 정책 bundled-only, 3단계 S3-1)과 같은 조판 환경에서 잰다.

## C 내려받을 때 암호 다시 걸기

- `GET /rooms/{room}/document` 가 요청 머리 `X-Collab-Document-Password` 를 받으면 정본을 암호를 걸어 내보낸다
  (`exportHwpWithPassword`·`exportHwpxWithPassword`, 원본 형식 계열). 암호는 저장하지도 기록하지도 않는다.
- 원래 암호 문서였던 방(`encryptedSource`)은 설정 `COLLAB_ENCRYPTED_DOWNLOAD=require|optional`(기본 `require`)을 따른다.
  `require` 면 암호 없이 내려받기를 거절한다(403 `password-required`). 작성자가 건 보호를 내려받을 때라도 되살리게 한다.
- 업로드 페이지의 내려받기는 그런 방이면 암호 칸을 보인다.
- 한계: 공동편집 중 각자 브라우저에서 studio 로 "저장"하는 파일은 이 경로를 거치지 않는다(암호 없음). studio 의 저장 경로에
  "저장할 때 암호 묻기"를 거는 일(0002)은 다음 후보로 둔다.

## 분담

| 일 | 세션 |
|---|---|
| A | cc-rhwp-f6 (U3-b 뒤, 범위 표시 장치를 만든 세션) |
| B | cc-rhwp-3b (collab-core 왕복 점검 보조를 만든 세션) |
| C | cc-rhwp-68 (서버·업로드 페이지, 6단계 마무리 회귀 뒤) |

## 기록

| 날짜 | 항목 | 결과 |
|---|---|---|
| 2026-11-28 | **A 구현: 결과 전송에 자동 범위 표시** (코드 세션 cc-rhwp-f6, worktree `collab/undo3`, `9b87685` 위) | **Rust(`collab-core/src/undo_restore.rs`)**: `state_range`(호출 직전 문서 → 지금 문서. DocInfo 표시(U3-b 의 목록 개수·항목 저장 바이트)와 BinData(번호·확장자·내용 — 메모리 바이트는 그대로 견주고 지연 항목은 같은 원본·같은 키면 같다, 그 밖은 다이제스트)가 같고, 문서 속성·메모 관계·구역 수가 같고, 바뀐 구역이 하나이며 그 구역의 구역 정의·꼬리가 같을 때 앞 공통 문단(줄 정보까지)·뒤 공통 문단(줄 세로 위치 뺌)을 깎아 [lo, lo+before) → [lo, lo+after). 한쪽이 0 개면 이웃 공통 문단 하나를 넣는다. 못 달면 사유 `nochange`·`docinfo`·`props`·`sections`·`section-def`), `CollabCore::state_range_hint(pre)`(구한 범위를 서버와 같은 규칙으로 한 번 더 확인 — DocInfo `check_doc_info`, 그 구역 `compare_section`. 다른 구역은 `state_range` 가 같은 `section_model_digest` 로 이미 견줬으므로 다시 해시하지 않는다(큰 문서에서 비용의 대부분이 구역 해시라 처음 판의 164ms 를 88ms 로). 맞으면 after 문단과 DocInfo 표시로 복원 재료), `state_recipe(section, lo, n)`(지금 문서의 범위로 재료 — 합칠 때). U3 `compare_hint` 를 `check_bins`·`compare_section` 으로 나눴다(서버 판단은 그대로). JS `collabStateRangeHint`·`collabStateRecipe`·`collabSnapshotCount`(시험용). `lib.rs`·`wasm.rs`·`ot.rs` 무변경. **엔진(`engine.ts`)**: state·watch 호출 직전에 자체 스냅샷을 뜨고, 호출 뒤 **내보내기→다시 읽기 전에** 범위 표시를 구해 state 기록에 `range`·`recipe` 를 단다(U3 와 같은 필드 — 받는 쪽 보정, 미확정 다시 만들기, 재료 해제가 그대로 쓰인다). 미리 뜬 스냅샷은 성공·호출 실패·보조 예외 모두에서 그 호출 안에서 버린다. 보조가 없거나 예외를 던지거나 조건이 맞지 않으면 표시 없이 보통 state(편집은 막지 않음, `stateHints` 에 사유 — 예외는 `error`). 보내지 않은 연속 state 합치기: 둘 다 범위 표시가 있고 같은 구역이면 두 범위를 덮는 한 범위(재료는 지금 문서에서 새로)로 합친다 — U3 의 "범위 표시 state 는 합치지 않음"을 바꿈(시험 U3 ⑫ 기대를 고침). 표시 있는 것과 없는 것, 다른 구역, 재료를 못 만듦은 지금처럼 따로 둔다(보통 state 와 합치면 그것이 버려질 때 범위 편집도 함께 버려진다). op 가 기록 중 결과로 바뀌는 경우(인자 인코딩 실패·실측 불변식 위반)는 미리 뜬 스냅샷이 없어 보통 state. **세션**: `status().stateHints`(진단). **규약 문서** §3.3·§4.2 에 일반 state 의 범위 표시와 합치기. 서버 무변경(U3 의 `range` 통과·`check_range_hint` 그대로). U3 범위 복원을 못 해 원래 경로로 가는 `restoreSnapshot`·`restoreDeleteFragment`(보통 state)도 이제 실제 차이가 한 범위면 표시를 단다 |
| 2026-11-28 | A 시험 | Rust collab **119/119**(+5: 한 문단·나누기·합치기·떨어진 두 문단의 범위, 바뀐 것 없음·DocInfo 덧붙임·구역 정의·두 구역·스냅샷 없음, 재료로 남의 앞 Enter 뒤 다시 만들기 + 정본 확인, 지금 문서로 재료, BinData 내용이 바뀌거나 덧붙으면 표시 없음), collab-client **108/108**(새 `test/state-range.test.mjs` ①–⑦: 덧말 넣기 state 에 범위 표시·정본 확인·남은 스냅샷 0·재료 0, B 가 계속 치는 중 A 먼저·B 먼저 모두 취소 0, 조건이 안 맞는 state 는 보통 state 이고 그러면 B 의 입력이 취소됨(대조군), **보조가 예외를 던져도 편집은 보통 state 로 나감·남은 스냅샷 0**, 호출이 실패해도 남은 스냅샷 0, 보내지 않은 범위 state 둘은 한 범위로, 아래 한계의 번호 밀림), studio 27/27·tsc, 서버 88 통과 + 2 건너뜀, 분류표 `--check`(지문 `981ce66b4183-da6b3d6051f6-54b7092dc7d6-d0e76ac479bb`). R5 500×200: `--rewrite-state --verify-fast` 실패 0·불일치 0, 덧말 2103 전부 표시(못 단 것 0), 정본 범위 확인 738·거절 0. **표시를 끈 같은 섞기(`--no-state-hint`)와 견주면 취소된 편집 29,900 → 26,096(−12.7%), 글자 입력 충돌률 26.47% → 22.47%, 사유 "결과 전송(state) 기록과 겹침" 2,100 → 0, 서버까지 간 state 510 → 738.** `--rewrite-state --range-undo --verify-fast` 실패 0·표시 1,950·확인 1,063·거절 0·재료 0, `--s3 --rewrite-state --range-undo` 실패 0·표시 2,001·확인 806·거절 0·재료 0(세대 704·새 참여자 666·재시작 521), `--realistic --rewrite-state --verify-fast` 실패 0. 브라우저(지연 300ms) 새 `e2e/s7a-state-range.mjs` **4/4**(B 가 키보드로 치는 중 A 덧말 — A 먼저, B 의 Enter 먼저, 덧말 두 번 연달아: 두 탭 일치·취소 0·재동기화 0·B 의 글자 모두 남음·남은 스냅샷·재료 0), u3-undo-range 14/14, u1-undo 10/10, R8 22/22, s1-rewrite 5/5, T4 30/30 |
| 2026-11-28 | A 측정 | 아래 "A 측정표". `node scripts/check-behavior.mjs --state-range` — state 53종마다 R1b 사례 생성기로 문서를 바꾼 호출을 모으고, 생성기가 못 만들면 손으로 쓴 사례(이 측정 전용 — R1b 감사·분류표에는 쓰지 않는다)로 문서마다 한 번씩. 사례가 있는 26종 195건 중 **157건(22종)이 언제나 범위 표시**, 4종은 언제나 못 단다(설계의 조건대로: 글머리표 만들기 `docinfo`, 바탕쪽 만들기·지우기 `section-def`, 구역 합치기 `sections`). 한 기능 안에서 갈리는 것은 없었다. **비용(보내는 쪽, 스냅샷 + 비교)**: R1b 문서에서 기능별 중앙값 0.1~5.7ms·최대 8.2ms. 가장 큰 샘플(10.7MB·14구역·383쪽)에서 중앙값 90ms(스냅샷 2ms + 비교 88ms) — state 기록이 원래 하는 내보내기→다시 읽기(1,099ms)의 약 8%. **비용(정본)**: 범위 표시 state 마다 범위 확인(스냅샷 → C 읽기 → 적용 전 정본을 내보내 다시 읽어 견줌)이 더해진다. 같은 큰 샘플에서 C 읽기 ≈1.0s + 확인 1.7~3.0s — 보통 state 의 다시 쓰기(≈1.0s)·S 읽기(≈1.0s)에 더해져 정본 처리가 약 2배가 된다(작은 문서는 수 ms) |
| 2026-11-28 | A 한계·남은 것 | (1) DocInfo 를 덧붙이는 state(글머리표 만들기 등), 구역 정의를 바꾸는 state(바탕쪽), 여러 구역을 바꾸는 state(구역 합치기)는 보통 state — 설계대로. (2) **번호 밀림**: 미확정에 DocInfo 를 덧붙이는 내 op(서식 등)가 범위 state 보다 앞에 있고 남도 그사이 덧붙이면, 되감기 재적용에서 내 항목 번호가 밀려 재료 문단이 가리키는 번호가 달라진다 — DocInfo 표시가 맞지 않아 다시 만들지 않고 충돌로 버린다(표시가 없을 때와 같은 결과, 수렴). R5 `--rewrite-state` 500×200 에서 범위 state 약 2,100 건 중 4~13 건. 덧붙인 항목 번호 다시 매기기(다음 후보)가 이것도 푼다. (3) **큰 문서의 정본 비용**(위 측정) — 줄이는 후보: 확인을 C 대신 S(같은 모델)로 해 C 읽기 한 번을 덜기(`canonical-worker.mjs`), 적용 전 정본의 "다시 읽은 모양"을 두고 쓰기. 이번에는 서버를 바꾸지 않았다. (4) 측정에서 사례를 못 만든 27종(커서 목록 기반 표 편집·나누기·자동 번호, OLE 수식·연결선·그림 변환 보관·행/열 바꿈 복사처럼 준비가 필요한 것, 샘플에서 문서를 바꾸지 않는 것 — `ensureDefaultNumbering`·`reflowLinesegs`·`restoreSectionRaw` 등)은 실제 호출에서 조건이 맞으면 표시를 단다 — 측정으로는 확인하지 못했다. (5) 덧말 넣기는 studio 메뉴가 없어 브라우저 시험은 문서 핸들로 불렀다(공동편집 엔진이 기록하는 경로는 같다). (6) 보내는 쪽은 state 호출마다 문서 한 벌을 잠시 더 들고 있다(미리 뜬 스냅샷). watch(분류표 밖 이름, 지금 0 종)도 같다. (7) 시험 위생: 복원 재료 저장소가 WASM 인스턴스 전체에 하나라, 한 시험이 정리 전에 실패하면 뒤 시험의 "재료 0" 이 함께 실패한다(U3 ⑫ 를 고치는 중에 봄) |

### A 측정표 (2026-11-28, `check-behavior.mjs --state-range`)

사례가 있는 기능만 싣는다. "(손)" 은 손으로 쓴 사례, 닿는 곳은 분류표의 `reach`. 시간은 사례마다 스냅샷 + 비교(호출 자체는 뺌).

| 기능 | 닿는 곳 | 사례 | 표시 | 못 단 사유 | 스냅샷+비교 ms (중앙값/최대) |
|---|---|---|---|---|---|
| `applyCharFormatInCellEx` | none | 1 | 1 | - | 2.95 / 2.95 |
| `attachCaptionAt` | none | 4 | 4 | - | 2.07 / 5.51 |
| `createBullet` | none | 13 (손) | 0 | docinfo 13 | 0.11 / 0.88 |
| `createMasterPage` | none | 12 (손) | 0 | section-def 12 | 0.43 / 1.32 |
| `deleteCellTableControlByPath` | none | 5 | 5 | - | 1.35 / 5.10 |
| `deleteComposeControl` | none | 5 (손) | 5 | - | 1.83 / 5.08 |
| `deleteComposeControlByPath` | none | 13 (손) | 13 | - | 1.36 / 4.45 |
| `deleteComposeControlInFootnote` | none | 5 (손) | 5 | - | 1.53 / 4.67 |
| `deleteMasterPage` | none | 12 (손) | 0 | section-def 12 | 0.38 / 1.23 |
| `insertCharOverlap` | none | 5 (손) | 5 | - | 5.74 / 8.24 |
| `insertCharOverlapByPath` | none | 13 (손) | 13 | - | 1.48 / 7.29 |
| `insertCharOverlapInFootnote` | none | 5 (손) | 5 | - | 1.79 / 5.12 |
| `insertRuby` | none | 5 (손) | 5 | - | 1.70 / 4.71 |
| `insertRubyByPath` | none | 13 (손) | 13 | - | 1.31 / 4.86 |
| `insertRubyInFootnote` | none | 5 (손) | 5 | - | 1.81 / 4.49 |
| `mergeSection` | none | 1 (손) | 0 | sections 1 | 0.19 / 0.19 |
| `recalculateTableFormulas` | none | 13 (손) | 13 | - | 1.71 / 4.91 |
| `removeFieldAtInCellEx` | none | 5 | 5 | - | 1.43 / 1.50 |
| `removeTableCellFormulas` | none | 13 (손) | 13 | - | 1.35 / 4.95 |
| `restoreDeleteFragment` | studio | 4 (손) | 4 | - | 3.99 / 5.36 |
| `restoreSnapshot` | studio | 5 (손) | 5 | - | 1.73 / 6.03 |
| `setComposeControl` | none | 5 (손) | 5 | - | 1.82 / 4.71 |
| `setComposeControlByPath` | none | 13 (손) | 13 | - | 1.30 / 4.67 |
| `setComposeControlInFootnote` | none | 5 (손) | 5 | - | 1.79 / 5.01 |
| `setTableCellFormula` | none | 13 (손) | 13 | - | 1.02 / 3.77 |
| `setTextBoxAt` | none | 2 | 2 | - | 1.39 / 1.39 |

사례가 없는 27종: 커서 목록 기반(`breakAtCursor`·`clearTableCellsAtCursor`·`insertAutoNumberAtCursor`·`tableEditAtCursor`·`tableMergeAtCursor`), 준비할 개체·자료가 필요(`applyTemplateOperation`·`importParagraphBlock`·`insertClickHereFieldByPathEx`·`moveInlineControl`·`moveLineEndpointEx`·`pasteTableCellsTransposed`·`pasteTableCellsTransposedAsTable`·`promoteOleEquation`·`removeBorderFillTails`·`setHeaderFooterPictureProperties`·`setNoteEquationProperties`·`setNoteEquationPropertiesEx`·`swapPictureTransform`), 샘플에서 문서를 바꾸지 않음(`convertToEditable`·`detachCaptionAt`·`ensureDefaultNumbering`·`injectExternalImage`·`injectExternalImageByKey`·`reflowLinesegs`·`restoreSectionRaw`·`setControlZOrderAt`·`updateConnectorsInSection`).

가장 큰 샘플(10.7MB, 14구역, 383쪽, 구역 0 의 문단 97 에 덧말): 스냅샷+비교 중앙값 90ms·최대 126ms(스냅샷 2ms, 비교 88ms), 내보내기→다시 읽기 1,099ms. 정본의 범위 확인은 C 읽기 ≈1.0s + 확인 1.7~3.0s.
