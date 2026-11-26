# cc-rhwp 공동편집 설계 — 2단계 (개정판): 전 기능 동기화 + 동시 편집

1단계(`docs/collab-design.md`)는 본문 텍스트 7종을 **번갈아 편집**해서 결정성을 검증했다. 2단계는 두
가지를 한다.

1. **rhwp 가 지원하는 모든 편집 기능을 동기화한다.** 재생할 수 있는 기능은 **동작**으로, 재생할 수
   없는 기능은 **결과**(문서 전체)로 보낸다. 기능별 코드는 쓰지 않는다.
2. **동시 편집.** 경고 대신 위치를 보정해서 모두 같은 문서가 되게 한다.

> 개정 이력: 초판(2026-11-26)은 텍스트 7종의 동시 편집만 다뤘다. 사용자 결정("지원 기능은 동작,
> 미지원은 결과, 현재 구현된 기능은 모두")에 따라 기록 위치와 범위를 바꿨다(§2). 초판의 §4 보정 규칙과
> S2-T1 오프셋 확인 결과는 그대로 살렸다.

이 문서는 1단계 문서에 덧붙는다. 1단계 문서를 대체하는 곳은 "대체: §x" 로 표시한다. 설계 변경은 이
문서를 먼저 고친다. 막히면 우회하지 말고 설계 세션(`cc-rhwp-2a`)에 묻는다.

## 1. 목표와 범위

| 포함 | 제외 (3단계 이후) |
|---|---|
| 업스트림 변경 메서드 목록 전체의 동기화(동작 또는 결과) | 서버 정본·영속 저장·로그 압축 |
| 텍스트 7종의 정밀한 동시 편집 보정 | 텍스트 외 연산의 정밀 보정(지금은 보수적 규칙) |
| 그 밖의 연산은 보수적 동시성 규칙(§4.5) | 내 편집만 되돌리기(undo) |
| 원격 편집 뒤 내 캐럿 보정 | 선택 영역 보정(캐럿으로 접는다) |
| 한글 IME 조합 중 원격 편집 보류 | 기기 간 조판 독립 지문 |
| 어긋남 → 자동 재동기화 | |
| 다른 사람 커서 표시 (정확성 작업 뒤) | |

완료 기준: 무작위 다중 클라이언트 시뮬레이션(실제 WASM)에서 **수렴 실패 0**, 브라우저 두 탭 동시
편집(서버 지연 주입)에서 digest 일치·desync 없음, 서식·표·붙여넣기도 동기화됨, 1단계 회귀 통과.

## 2. 구조 (대체: 1단계 §2 의 기록 위치)

```
studio UI · 다른 플러그인(AI 도우미 등) · hwpctl 자동화
      │  HwpDocument 메서드 호출 (WASM export)
      ▼
[기록 훅]  studio 가 플러그인 요청으로 HwpDocument.prototype 의 변경 메서드를 감싼다 (§6)
      │  분류표(§3)로 판정: op(동작) | state(결과)
      ▼
collab 엔진 (TS, collab-client/src/engine/)  — 미확정 열, 되감기·재적용, 전송 큐, 캐럿 보정
      │  Rust 보조 (WASM, collab-core): 자체 스냅샷, 결과 적재, digest, 측정, 보정 함수(ot.rs)
      ▼
transport (WebSocket) ──▶ 중계 서버
```

### 기록 위치를 코어에서 WASM export 경계로 옮긴 이유

- **기능 명세가 이미 있다.** studio `src/core/mutation-method-registry.ts` 의 `MUTATING_METHODS` 는
  "문서 IR 을 바꾸는 메서드 전수"이고, 새 메서드가 분류 없이 들어오면 업스트림 테스트
  (`tests/mutation-routing-guard.test.ts`)가 막는다. 156개 중 **151개가 같은 이름의 `HwpDocument`
  export** 이고, 인자는 `number`·`string`·`boolean`·`Uint8Array`·`null` 뿐이다. 나머지 5개는 studio 쪽
  합성으로, 실제로는 `setPageDef` 와 `insertHyperlinkEx`·`updateHyperlinkEx`·`replaceHyperlinkTextEx`·
  `removeHyperlinkEx` export 를 부른다. 따라서 **export 이름 + 인자를 기록하고 같은 export 를 다시
  부르면** 기능별 코드 없이 전부 재생된다. 같은 Rust 코드 경로를 타므로 결정적이다.
- **코어 경계로는 다 잡을 수 없다.** 코어 메서드를 같은 시그니처로 하나씩 가려야 하고(150여 개),
  `wasm_api.rs` 안에서 모델을 직접 고치는 기능(예: 스타일 편집, `wasm_api.rs` 8338~8553행 부근)은
  아예 코어 메서드를 거치지 않는다.
- **export 경계는 studio 밖의 편집도 잡는다.** hwpctl 의 원시 문서 직접 호출(업스트림이 동결한 23곳)과
  다른 플러그인의 `tx.doc()` 편집도 결국 같은 export 를 부른다.
- **잃는 것:** 기록기가 JS 에 있어 네이티브 앱이 그대로 공유하지 못한다. 네이티브 편집기
  (`native_host::NativeEditor`)는 아직 본문 텍스트 전용이고, 필요하면 앱 안 WebView 로 studio 를 띄우거나
  그 시점에 같은 분류표로 네이티브 경계에 기록기를 단다. 3단계 서버 정본은 Node + 같은 WASM + 같은 엔진
  모듈로 돌릴 수 있다.

### Rust `CollabCore` 의 역할 변경

- **은퇴:** 1단계의 7개 가로채기 기록, outbox, 복원 경로 desync(T5), `deleteRange` 가로채기(T7).
  JS 기록기가 같은 일을 전부 하므로 남겨 두면 **이중 기록**이 된다. 코드와 그 테스트를 제거하고
  새 테스트로 대체한다.
- **유지·추가:** 자체 스냅샷(§5), 결과 적재 `collabLoadState(bytes)`(§5), digest(1단계 T6, 캐럿 제외),
  측정(문단 길이, 논리↔텍스트 오프셋), 보정 함수 `ot.rs`(§4).
- 0001 패치(`HwpDocument.core` 를 `CollabCore` 로)는 유지한다. 문서마다 스냅샷 저장소를 둘 자리다.

## 3. 분류표 (대체: 1단계 §4 의 연산 형태)

파일 `collab-client/src/engine/catalog.ts`. **스크립트가 업스트림 목록에서 생성**하고(`scripts/gen-catalog.mjs`),
사람이 고친 값은 별도 덮어쓰기 파일(`catalog-overrides.ts`)에 둔다. 생성 대상:
`MUTATING_METHODS` 중 export 인 151개 + 위 `*Ex` 4개 + 레지스트리 밖이지만 문서를 바꾸는 복원류
(`restoreSnapshot`, `restoreDeleteFragment`, `restoreSectionRaw`).

항목마다:

| 필드 | 값 | 기본값 |
|---|---|---|
| `sync` | `op`: 이름+인자로 재생 / `state`: 결과(문서 전체) 전송 / `local`: 문서가 아닌 보기 상태, 공유 안 함 / `none`: 문서를 바꾸지 않음(글꼴 등록·렌더·보기 설정), 기록 안 함 | `op` |
| `ctx` | 결과에 영향을 주는 **로컬 세션 상태** 목록(지금은 `activeField`). 기록 때 실측해 담고 재생 때 그 값으로 맞춘다 | 없음 |
| `layout` | 결과가 조판 결과(쪽 번호·렌더 위치 등)를 읽음. 기록·재생 직전에 미룬 조판을 끝낸다 | `false` |
| `conc` | `text`(§4 정밀 보정) / `neutral`(구조 불변, §4.5) / `structural`(§4.5) | `structural` |
| `section` | 구역 인자 위치. `rhwp.d.ts` 의 인자 이름(`sec`, `section_idx`)으로 자동 탐지 | 없으면 문서 전체 |
| `roles` | 위치 인자의 의미(`neutral` 의 범위·문단 등) | 없음 |
| `why` | `state`·`neutral` 로 바꾼 근거 한 줄 | — |

판정 규칙:

- **`state` 로 둘 것 — "인자와 문서만으로 결과가 정해지지 않는" 기능.** 로컬 비문서 상태에 기대는 것:
  내부 클립보드(`pasteInternal*`, `pasteControl`), 전치 클립보드(`pasteTableCellsTransposed*`), 로컬
  저장소 id(조각·스냅샷·구역 raw 복원), 시각·난수·파일 핸들. **각 기능을 열어 보고 판정**한다. 확실치
  않으면 `state` (느리지만 항상 맞다).
- **`neutral` 로 둘 것 — 문단 수, 텍스트 오프셋, 개체 번호, 표 행·열 구조를 바꾸지 않는 것.** 글자·문단
  서식 적용, 개체·표·셀·쪽 속성, 스타일 정의, 필드·양식 값 등. `neutral` 은 `roles` 가 있어야 한다
  (텍스트 연산이 문단 번호를 옮길 때 같이 옮겨야 하므로). `roles` 를 못 적으면 `structural`.
- **`text`** 는 아래 7종(초판의 연산)만: `insertText`, `insertTextLogical`, `deleteText`,
  `replaceBodyTextLocal`, `splitParagraph`, `mergeParagraph`, `deleteRange`(+`deleteRangeInCell`,
  `deleteRangeInCellEx`).
- 환경(글꼴) 의존 연산(`reflowLinesegs` 등)은 `op` 로 둔다. 같은 브라우저에서는 결정적이다. 기기 간
  차이는 1단계 §8 의 알려진 한계와 같다.
- **숨은 입력은 기록에 담는다 (원칙).** 인자 말고도 결과에 영향을 주는 로컬 상태가 있으면, `state` 로
  내리기 전에 먼저 "그 상태를 기록에 담아 재생 때 똑같이 맞출 수 있는가"를 본다. 맞출 수 있으면 `op` 를
  유지한다.
  - **`ctx.activeField`** (R1 감사 결정 1): `insertText`, `insertTextLogical`, `replaceBodyTextLocal`, 셀 입력
    3종, `evaluateTableFormula`, `pasteHtml` 은 studio 가 캐럿에 맞춰 넣는 `active_field` 를 읽는다(누름틀
    경계에서 안/밖 결정). 기록 때 `collabMeasure` 가 그 값(구역·문단·컨트롤·셀 경로 또는 없음)을 실측해
    `ctx` 에 담는다. 재생 때 Rust 보조 함수로 그 값으로 잠시 맞추고 호출한 뒤 원래 값으로 돌린다. 되감기
    재적용 때는 `activeField` 의 문단 위치도 원격 연산의 지도로 옮긴다(`anchor` 규칙: 그 문단을 구조적으로
    건드렸으면 충돌).
  - **`layout: true`** (R1 감사 결정 4): `insertFootnote`, `deleteFootnote`, `groupShapes`, `insertPicture`
    (+`InCell`), `applyParaFormat`, `reflowLinesegs` 는 조판 결과를 읽는다. **기록 쪽의 원래 호출 직전과
    재생·재적용 직전 모두** `flushDeferredPagination` 을 부른다. 한쪽만 끝내면 기록 쪽과 재생 쪽이 다른 조판
    상태에서 계산한다.
- **보기 상태는 공유하지 않는다:** `toggleHideHeaderFooter` 는 `sync: local` (R1 감사 결정 2). 단, 그
  보기 상태가 조판(쪽 나눔·본문 영역)에 영향을 주면 `layout` 연산의 결과가 사람마다 달라진다. 영향이
  없는지 확인하고, 있으면 `op` 로 공유한다.
- **기록 훅은 레지스트리 밖도 감싼다** (R1 감사 결정 3). `&mut self` 인 모든 `HwpDocument` export(Rust
  소스 스캔)가 대상이다. 레지스트리 밖 146개도 감사해서 `none`(문서를 안 바꿈: 글꼴 등록·렌더·보기 설정)과
  `op`/`state`(문서를 바꿈: `insertMemo`, `insertRuby`, `setPageHide`, `insertParagraph`, `deleteParagraph`,
  `splitSection`, `setControlLock`, `moveControlAt`, `setTableCellFormula` 등)로 나눈다. AI 도우미 플러그인의
  `tx.doc()` 와 hwpctl 이 이것들을 부를 수 있어서, 빠뜨리면 그 편집이 재동기화로 되돌려진다.
  - **분류표에 없는 레지스트리 밖 새 이름은 "digest 감시"로 처리한다.** 호출 전후 digest 를 재서 바뀌었으면
    `state` 기록을 만들고, 그대로면 아무것도 안 한다. 레지스트리 밖 이름은 대부분 문서를 안 바꾸므로
    무조건 `state` 로 두면 글꼴 등록 같은 잦은 호출마다 문서 전체를 보내게 된다. digest 비용은 문서 크기에
    비례하지만, 분류되지 않은 이름에만 쓰므로 드물다. 경고로 알리고 감사하면 `none`/`op` 로 올린다.
  - `&self` export 는 문서를 바꾸지 않는다고 본다(R1 감사에서 확인: export 경로의 모델은 `RefCell` 밖).
- **업스트림이 새 기능을 추가해도 멈추지 않는다 (사용자 결정).** 원칙: "기존 기능은 그대로 빠르게, 새
  기능은 느리더라도 동작은 한다."
  - **분류표에 없는 새 이름은 자동으로 `sync: state`, `conc: structural`** 로 둔다(결과 전송 — 느리지만 항상
    맞다). 기록 훅은 분류표가 아니라 **실행 중인 studio 의 `MUTATING_METHODS` 전체**를 감싸고, 분류표에
    없는 이름은 이 기본값으로 처리한다. 그래서 분류표를 다시 만들지 않은 상태로 업스트림을 올려도 새 기능이
    동기화된다.
  - 생성 스크립트는 새 이름을 **경고**("분류 필요: N개")로만 알린다. 사람이 감사해서 `op` 로 올리면
    그때부터 빨라진다.
  - **인자 목록이 바뀐 이름**도 새 기능처럼 `state` 로 내린다(기존 분류·`roles` 가 더는 맞지 않을 수
    있으므로). **사라진 이름**은 분류표에서 빠진다. 둘 다 경고로 알린다. 업스트림을 올릴 때(`bootstrap.sh`)
    같이 돌린다.
  - 이름과 인자가 같아도 **동작이 바뀌었을 수 있다** → 아래 "동작 동일성 검사".

### 동작 동일성 검사 (사용자 결정)

업스트림을 올릴 때 `op` 로 분류된 기능마다 **이전 엔진과 새 엔진의 동작이 같은지** 자동으로 확인한다.
같으면 기존 분류 그대로, 다르면 새 기능처럼 `state` 로 내린다. 사람이 다시 감사해서 받아들이면 `op` 로
되돌린다.

- **검증 사례.** `op` 기능마다 사례 묶음을 둔다. 사례 = (샘플 문서, 준비 단계, 호출 인자).
  - 생성기가 `rhwp.d.ts` 인자 이름(`sec`, `para`, `char_offset`, `control_idx`, `cell_idx`, `*_json` …)과
    현재 문서 상태로 유효한 인자를 자동으로 만든다(R5 무작위 편집 생성기를 같이 쓴다).
  - 자동으로 못 만드는 기능(그림 삽입, 차트 데이터, 도형 만들기 등)은 R1 감사 때 사례 틀을 손으로 쓴다.
  - **사례가 없는 기능은 `op` 가 될 수 없다**(검증할 수 없으므로 `state`). 기능당 최소 5개, 샘플 문서는
    빈 문서·글 위주·표/그림 포함 문서 3종 이상.
- **차분 비교 (저장된 정답값 대신).** 이전 엔진 빌드(지금 배포 중인 WASM)와 새 빌드를 같은 Node 프로세스에
  둘 다 올린다. 사례마다 양쪽에서 같은 문서를 열고 같은 호출을 한 뒤, 결과를 각각 내보내 **새 엔진으로
  다시 읽어** digest(캐럿 제외)를 비교한다. 성공/실패 여부와 문단 수 변화도 같아야 한다. 반환값은 비교하지
  않는다(재생은 반환값을 쓰지 않는다).
  - 저장된 digest 와 비교하지 않는 이유: 업스트림이 모델에 필드를 하나만 더해도 digest 체계가 바뀌어 모든
    기능이 "다름"으로 나온다. 양쪽 결과를 같은 새 엔진으로 정규화해야 동작 차이만 남는다.
  - 이전 빌드는 `.tools/engine-builds/<rev>/` 에 보관한다(빌드 산출물 캐시, git 추적 안 함).
- **재생 가능성 검사(같이 돈다).** 같은 엔진에서 문서 객체 두 개를 만들고, 한쪽의 비문서 상태를 일부러
  흐트러뜨린 뒤 같은 호출을 해서 결과가 같은지 본다. 흐트러뜨리는 축: 내부·전치 클립보드 채우기, 스냅샷·조각
  저장소 사용, **`active_field` 를 다른 값으로**(단 `ctx` 로 담는 기능은 재생 방식대로 맞춘 뒤 비교),
  **조판을 미룬 상태 vs 끝낸 상태**(단 `layout` 기능은 flush 를 거친 뒤 비교). 다르면 로컬 상태에 기대는
  기능이므로 `state`. 새 숨은 입력이나 새 조판 의존이 생기면 여기서 자동으로 걸린다. `op` 분류의 핵심 전제("인자와 문서만으로 결과가 정해진다")를 직접
  확인하는 검사이고, 업스트림 변경으로 그 전제가 깨지는 경우도 잡는다.
- **결과 반영.** 스크립트 `scripts/check-behavior.mjs` 가 `catalog-drift.json` 에 내린 기능과 이유를
  쓴다. 분류표 해시(엔진 지문, §7)에 포함되므로 방마다 같은 판정을 쓴다. 보고서 요약: "동작 같음 N, 다름 →
  결과 전송 M(목록), 사례 없음 K".
- 같은 브라우저 결정성과 마찬가지로 이 검사도 **고정된 환경(Node, 같은 글꼴 조건)** 에서 돌린다. 글꼴 의존
  기능이 환경 차이로 "다름"이 되지 않게 하기 위해서다.
  - 레지스트리를 거치지 않는 새 변경 export(예: hwpctl 만 쓰는 원시 호출)는 훅이 모른다. 이 경우는
    digest 가 잡아 재동기화한다(그 편집은 되돌려진다). 업스트림 가드 테스트 덕분에 studio 경로의 새 변경
    메서드는 레지스트리에 반드시 들어간다.

### 기록 형태

```json
{"kind":"op","m":"applyCharFormat","a":[0,3,0,3,5,"{\"bold\":true}"],"meta":{...}}
{"kind":"state","data":"<base64 HWP>"}
```

- `a` 의 `Uint8Array` 는 `{"$b64":"..."}` 로 감싼다.
- `meta` 는 `text` 연산에만 붙는다. 보정에 필요한 값을 **기록 시점에 실측**한다(재계산·정규화 추측 금지).
  `collabMeasure` 를 호출 전후로 불러 얻는다(§5).

| `text` 연산 | `meta` |
|---|---|
| `insertText` | `len` (전후 문단 길이 차) |
| `insertTextLogical` | 텍스트 좌표로 바꾼 `offset`·`afterControl`, `len` |
| `deleteText` | `count` **실측값** (범위를 넘으면 잘리므로) |
| `replaceBodyTextLocal` | 실측 삭제 수, `insLen` |
| `splitParagraph` | — |
| `mergeParagraph` | `prevLen` (적용 전 `para-1` 길이) |
| `deleteRange*` | — |

- **기록 시 불변식 검사.** 문단 수 변화가 연산 종류의 기대값(텍스트 0, split +1, merge −1,
  deleteRange −(ep−sp))과 다르면 보정할 수 없다 → 그 기록을 `state` 로 바꿔 보낸다.
- **오프셋 단위 (S2-T1 확인, 테스트 `offsets_are_text_scalar_indices_excluding_inline_controls`):**
  - 텍스트 연산의 오프셋·개수는 모두 **`para.text` 의 유니코드 스칼라 인덱스**다(😀 도 1).
    문단 길이 = `get_paragraph_length_native` = `para.text.chars().count()`.
  - **개체는 종류와 상관없이 이 좌표에 자리를 차지하지 않는다.** 파서가 제어문자(UTF-16 8 유닛)를
    `text` 에서 빼고 개체 위치는 `char_offsets` 의 틈으로 복원한다. 같은 텍스트 오프셋에서 개체 앞/뒤는
    `after_inline_control` 로만 갈린다. 글자 삭제는 텍스트 글자만 지우고 그 사이 개체는 남는다.
  - **studio 캐럿과 `insertTextLogical` 은 "논리 오프셋"** 을 쓴다. 논리 인라인 개체
    (`Control::is_logical_inline`: 글자처럼 취급 개체 + 각주·미주·글자 겹침·덧말)를 한 칸으로 센다.
    그런 개체가 없으면 두 좌표가 같다. 보정은 텍스트 좌표로 하고, 캐럿과 `insertTextLogical` 의 재적용
    인자는 `logical_to_text_offset` / `text_to_logical_offset` 로 변환한다(재적용하는 쪽의 그 시점 문서
    기준. 그 문서가 곧 서버 순서 상태이므로 보낸 인자가 모두에게 맞다).
  - 경계 사례: 같은 텍스트 오프셋에 한쪽은 개체 앞, 다른 쪽은 개체 뒤로 동시에 넣으면 개체에 대한 앞뒤가
    바뀔 수 있다. 의도만 어긋나고 수렴은 깨지지 않는다.

## 4. 동시성: 되감고 다시 적용 + 보정

### 4.1 방식 (초판 유지)

ProseMirror collab 과 같은 구조다. 서버는 순서만 정하고 낡은 요청은 거절한다. 남의 연산 R 이 도착하면
엔진은 확정 상태로 **되감고**, R 을 적용하고, 내 미확정 P 를 R 에 맞춰 **보정**해 다시 적용한다. 서버가 내
낡은 요청을 거절하면 보정된 P' 를 새 seq 로 다시 보낸다.

- 이 방식을 고른 이유: **수렴이 구조적으로 보장된다.** 모든 문서는 언제나 "서버 순서로 확정된 연산 +
  내 미확정 연산"이다. 보정이 다소 틀려도 그 P' 가 그대로 서버에 가서 모두가 같은 순서로 적용하므로,
  의도만 어긋날 뿐 문서는 갈리지 않는다.
- 대안(R 을 보정해 지금 화면에 바로 적용)은 보정이 TP1 성질을 완벽히 만족해야 수렴한다. 3단계에서
  성능이 문제 되면 검토한다.

### 4.2 위치

본문 위치 `Pos { section, para, offset }` (텍스트 좌표). 셀 위치는 셀 `deleteRange` 에서만 쓴다:
`CellPos { section, parent_para, control, cell, cell_para, offset }`. 구역이 다르면 서로 영향 없음.

### 4.3 텍스트 연산의 위치 지도 `map(pos, op, bias)`

`bias` 는 연산 지점과 정확히 같은 위치일 때 앞(`Before`)에 남을지 뒤(`After`)로 밀릴지다.

| 연산 | 같은 문단 안 | 다른 문단 |
|---|---|---|
| Ins(p,o,len) | x<o 그대로, x>o → x+len, x=o → Before 그대로 / After x+len | 그대로 |
| Del(p,o,n) | x≤o 그대로, o<x<o+n → o (삭제됨 표시), x≥o+n → x−n | 그대로 |
| Replace(p,o,d,insLen) | Del(p,o,d) 다음 Ins(p,o,insLen) 의 합성 | 그대로 |
| Split(p,o) | x<o 그대로, x>o → (p+1, x−o), x=o → Before (p,o) / After (p+1,0) | q>p → q+1 |
| Merge(p,prevLen) | (p,x) → (p−1, prevLen+x) | q>p → q−1 |
| DeleteRange(s→e) | 시작 앞 그대로, 범위 안 → s (삭제됨), (e.para, x≥e.off) → (s.para, s.off+x−e.off) | q>e.para → q−(e.para−s.para) |

셀 위치는 같은 셀의 셀 `deleteRange` 에만 위 규칙으로 움직인다. 본문 연산은 `parent_para` 를 문단
번호처럼 옮긴다. 단 본문 연산이 `parent_para` 문단을 **구조적으로 건드리면**(그 문단의 split, 그 문단이
합쳐지는 merge, 그 문단에 걸친 deleteRange) 개체 번호가 바뀔 수 있으므로 **충돌**이다.

### 4.4 텍스트 연산끼리의 보정 `transform(op, against, side)`

`side` 는 누가 먼저냐다. 미확정 P 를 원격 R 에 맞출 때 P 는 `Second`(R 이 먼저), R 을 P 에 맞출 때
R 은 `First`.

- **삽입:** 위치를 옮긴다. 같은 지점 삽입은 `First` 가 앞, `Second` 가 뒤.
- **삭제 범위(Del, DeleteRange, Replace 의 삭제 부분):** 시작은 bias After, 끝은 bias Before.
  - 범위가 사라지면 연산을 버린다.
  - **상대가 범위 안에 끼워 넣은 글자는 살린다.** 범위를 그 삽입 구간 앞뒤로 쪼개 여러 삭제로 낸다.
  - 상대의 split 으로 범위가 두 문단에 걸치면 `deleteRange` 로 바꿔 낸다.
- **Replace:** 삭제 부분은 위 규칙, 삽입은 옮겨진 시작 위치. 한 덩어리면 `replaceBodyTextLocal`,
  아니면 삭제들 + `insertText`.
- **Split:** 위치만 옮긴다. 삭제된 범위 안이었으면 삭제 시작점에서 나눈다.
- **Merge:** 문단 경계 삭제로 본다. B=(p−1, prevLen) 는 bias After, E=(p,0) 은 bias Before.
  B'=E' 면 버린다. E'=(B'.para+1, 0) 이면 `mergeParagraph(E'.para)` (`prevLen=B'.offset`). 그 밖이면
  `deleteRange(B', E')`. 이 bias 때문에 상대가 p−1 끝에 덧붙인 글자는 지워지지 않는다.
- **셀 deleteRange:** §4.3 의 셀 규칙. 충돌 조건이면 `Conflict`.

반드시 이름 붙은 테스트로 둘 것: 같은 지점 동시 삽입(양쪽 순서), 내 삭제 범위 안의 남의 삽입(살아남음),
겹치는 두 삭제, 남의 Enter 가 내 삭제 범위를 나눔(→ deleteRange), 문단 끝 Enter vs 다음 문단 처음
Backspace, 같은 경계 동시 Backspace(한쪽 버림), 남이 merge 한 문단 안의 내 삽입, 남의 deleteRange 안의
내 split, 셀 삭제 vs 부모 문단 split(충돌).

### 4.5 텍스트 외 연산의 보수적 규칙

정밀 보정 대신 분류(`conc`)와 구역으로 판정한다. "같은 구역" 은 `section` 이 같거나 어느 한쪽이 문서
전체인 경우다.

| 내 미확정 P \ 원격 R | R `text` | R `neutral` | R `structural` (같은 구역) | R `state` |
|---|---|---|---|---|
| P `text` | §4.4 | 그대로 | 충돌 | 충돌 |
| P `neutral` | `roles` 위치를 R 의 지도로 옮김(범위는 삭제 범위 규칙, 사라지면 버림) | 그대로 (같은 속성이면 나중 것이 이김) | 충돌 | 충돌 |
| P `structural` | 같은 구역이면 충돌 | 같은 구역이면 충돌 | 충돌 | 충돌 |
| P `state` | 충돌 | 충돌 | 충돌 | 충돌 |

- 구역이 다르면(문서 전체 아님) 언제나 그대로 통과.
- 충돌은 §5 규칙(그 연산과 뒤 꼬리를 버리고 알림)으로 처리한다. 버리는 것은 아직 확정되지 않은 내
  연산뿐이라 수렴에는 영향이 없다.
- 이 표가 거칠어도 되는 이유: 충돌 창은 내 편집이 서버에 확정되기까지의 왕복 시간(수십~수백 ms)뿐이고,
  텍스트 외 편집은 타이핑보다 훨씬 드물다. 자주 겹치는 연산이 확인되면 그 연산만 정밀 보정으로 올린다.
- 캐럿 보정: R 이 `text` 면 지도로 옮긴다(논리↔텍스트 변환 포함). `neutral` 이면 그대로. `structural`·
  `state` 면 같은 인덱스로 두되 문서 범위로 자른다.

### 4.6 정밀화 (R13, R9 현실 조건 결과로 추가 — §4.5 를 아래처럼 바꾼다)

R9 현실 조건(3명, 초당 5타, 왕복 100ms)에서 손실은 거의 전부 §4.5 의 "같은 구역 구조·state 편집은 모든
동시 편집과 충돌 + 꼬리 전부 버림"에서 나왔다(버림 사건 822건이 5,626건을 버림, 사건당 6.8건). 표 만들기·
붙여넣기를 빼면 text 0.26%·neutral 0.92% 로 떨어진다. HWP 문서는 대부분 구역이 하나라 "같은 구역" 이 곧 문서
전체이고, 셀 입력까지 `structural` 이라 **표 안에서 치는 것만으로 모든 동시 편집과 충돌한다**(공문서 양식에서
치명적). 네 가지로 바꾼다.

1. **셀 텍스트 연산을 `text` 로 올린다.** `insertTextInCell*`, `deleteTextInCell*`, `replaceTextInCell*`,
   `splitParagraphInCell*`, `mergeParagraphInCell*`, `deleteRangeInCell*`(평면·`ByPath`) 은 본문 텍스트 연산과
   같은 규칙을 **셀 좌표계**(`CellPos`, 셀 경로가 같을 때만 상호작용)에서 쓴다. 다른 셀끼리는 서로 영향
   없음. 본문 연산이 부모 문단을 구조적으로 건드리면 충돌(§4.3 셀 규칙 그대로). `meta` 실측·`ctx` 는 본문과
   같다.
2. **구조 편집은 "발자국" 으로 충돌을 판정한다.** 구역 단위 대신:
   - 분류표에 구조 연산의 `anchor` 역할(기준 문단 인자, 표 구조 연산은 문단+개체)을 감사해 적는다. 기록 때
     **그 구역의 문단 수 변화 `pd`** 를 실측해 `meta` 에 담는다(연산 종류와 무관한 범용 값).
   - 범용 지도: 기준 문단 뒤 문단은 `pd` 만큼 밀린다. 발자국 = 기준 문단 ~ 기준+max(pd,0)(적용 뒤 기준).
   - 판정: 상대 연산의 위치·기준이 **발자국 안이면 충돌**, 밖이면 범용 지도로 옮겨 다시 적용한다. 내 구조
     연산의 기준 문단이 상대 연산으로 구조적으로 바뀌었으면(합쳐짐·삭제됨) 충돌, 아니면 옮긴 기준으로 다시
     적용한다.
   - `anchor` 를 적을 수 없는 구조 연산은 지금처럼 구역 단위로 남긴다(감사에서 근거를 단다).
   - 빠른 경로(R11)는 그대로 둔다(구조 연산이 끼면 되감기). 되감기 경로라 수렴은 보장된다.
3. **꼬리를 통째로 버리지 않는다.** P_i 를 버리면 뒤의 P_j 를 **P_i 의 역지도**(텍스트 연산의 역 — 삽입↔삭제,
   구조 연산의 역 — `pd` 반대로 밀기)로 옮긴다. P_i 발자국 안에 있었거나 역지도로 옮길 수 없는 것만 버린다.
4. **붙여넣기를 `op` 로 올린다 ("숨은 입력은 기록에 담는다").** 내부 클립보드는 복사한 문단 목록 + 평문
   (`ClipboardData`, `document_core/mod.rs:124`)이다. `ctx.clipboard` 로 직렬화해 담고 재생 때 그 값으로 맞춘
   뒤 `pasteInternal*` 을 부른다. `pasteControl` 의 `paste_cascade_count`, 전치 붙여넣기의
   `TableTransposeClipboard` 도 같은 방식. 직렬화가 막히면(역직렬화 불가 타입 등) 그 기능만 `state` 로 남기고
   이유를 적는다. R1b 재생 가능성 검사의 클립보드 축으로 확인한다. `pasteInternal` 은 구조 연산이므로 2번
   규칙(발자국)을 같이 쓴다.

관문: R5(수렴 실패 0)·R11(빠른 경로 불일치 0) 재통과, 그리고 **R9 현실 조건을 셀 입력 포함으로 다시 돌려
(입력의 30% 를 표 셀 안에서, 표 만들기·붙여넣기 포함) 전체 버림 비율 1% 미만.** 못 미치면 어느 쌍에서 나는지
분해해서 설계 세션에 보고한다.

## 5. 엔진 (TS) 상태와 흐름 (대체: 1단계 outbox 모델, 초판 §5)

엔진 모듈 `collab-client/src/engine/` 은 studio 를 모른다(문서 핸들과 몇 개의 콜백만 받는다). 3단계에서
Node 서버가 같은 모듈을 쓰기 위해서다.

상태:

- `unconfirmed: Entry[]` — 로컬에 적용됐지만 서버가 확정하지 않은 기록(`op`·`state`)
- `sent: number` — 그중 앞에서부터 보낸 개수
- `snapshot: id | null` — `unconfirmed` 가 비어 있지 않을 때만. Rust 자체 저장소의 id

Rust 보조 (`collab-core`, WASM 표면):

| 함수 | 계약 |
|---|---|
| `collabSnapshotSave(): id`, `collabSnapshotRestore(id)`, `collabSnapshotDiscard(id)` | **업스트림 `snapshot_store` 를 쓰지 않는 자체 저장소.** 업스트림 저장소는 studio undo 가 예산을 계산해 쓰므로(상한 `MAX_SNAPSHOTS`, studio 예산 = 상한−2) 끼어들면 studio 의 오래된 스냅샷이 몰래 밀려난다(업스트림 #2328). 저장·복원 순서는 `save_snapshot_native` / `restore_snapshot_native`(`document.rs:4024,4062`)와 같게 한다. "자체 복원 = 업스트림 복원과 digest·내보내기 동일" 테스트로 묶는다. |
| `collabLoadState(bytes)` | 바이트를 파싱해 **지금 문서 객체 안에서** 문서를 교체한다(스냅샷 복원과 같은 설치 순서). studio 문서 교체(재열기·글꼴 확인·문서 세대 증가)를 거치지 않는다. |
| `collabExportState(): bytes` | 결과 전송용. 캐럿을 쓰지 않는 원시 export. **형식은 원본 계열을 따른다:** HWPX 로 연 문서는 HWPX, HWP 로 연 문서는 HWP(R9 선측정: HWPX 원본 7.9MB 문서를 HWP 로 내보내면 174MB). base(1단계 §6.2)도 같은 규칙. `collabLoadState` 는 두 형식을 모두 받는다. |
| `collabMeasure(phase, m, argsJson)` | `text` 연산의 `meta` 실측(§3). `before` 결과를 `after` 에 넘긴다. |
| `collabTransform(pendingJson, remoteJson, catalogInfoJson, caretJson)` | §4 의 순서 있는 열 보정. 결과 `{pending', dropFrom, caret'}`. 순수 함수. |
| `collabDigest()` | 1단계 그대로. |

흐름:

- **로컬 기록** (기록 훅): 녹화 중이고 재생 중이 아닐 때만. `unconfirmed` 가 비었으면 호출 **전에**
  스냅샷. `text` 면 `collabMeasure(before)`. 원래 export 호출. 예외면 기록하지 않음. 성공하면 `text` 는
  `collabMeasure(after)` 로 `meta`, `state` 는 `collabExportState()` 로 결과. 불변식 위반이면 `state` 로
  바꿈. `unconfirmed` 에 추가.
  - 한 사용자 동작이 export 를 여러 번 부르면 각각 기록된다(순서 유지). 재생도 같은 순서다.
  - 연속된 `state` 기록은 마지막 하나만 남긴다(앞의 결과는 뒤 결과에 포함된다).
  - **비용 주의:** 타이핑 중에는 묶음마다 확정이 빨리 와서 `unconfirmed` 가 자주 비므로, 스냅샷이 거의
    입력 묶음마다 떠진다. `Document` 복제 비용은 문서 크기에 비례한다. 파일에서 읽은 그림은
    `BinDataBytes::Lazy`(Arc 공유)라 싸지만, 붙여 넣은 그림(`Loaded(Vec)`)·`extra_streams`·
    `hwpx_aux_entries` 는 깊은 복사다. R9 에서 재고, 비싸면 그 경우만 설계 세션에 올린다. 후보: 바뀌지
    않는(append-only) 바이너리를 스냅샷에서 공유, 텍스트 연산만 미확정일 때는 역연산으로 되감기(3단계).
- **보내기** `takePending()`: `unconfirmed[sent..]`, `sent = len`.
- **확정** `ack(n)`: 앞의 `n` 개 제거, `sent -= n`. 비면 스냅샷 버림.
- **거절** `requeue()`: `sent = 0`.
- **원격 수신** `receiveRemote(entries, caret)`:
  1. `unconfirmed` 가 비었으면 그대로 적용(재생 중 표시로 기록 끔). `op` 는 같은 export 호출, `state` 는
     `collabLoadState`. 캐럿은 원격 열의 지도로 옮긴다.
  2. 아니면: 스냅샷 복원 → 원격 적용 → 새 스냅샷 → `collabTransform` 으로 P' 계산 → P' 를 차례로 재적용
     (`insertTextLogical` 은 그 시점 문서로 논리 오프셋 변환) → `unconfirmed = P'`, `sent = 0`.
  3. **충돌·재적용 실패:** P_i 가 `Conflict` 거나 재적용이 예외면 **P_i 와 그 뒤 전부를 버린다.** 이미
     재적용한 P'_1..P'_{i−1} 은 둔다. 버린 수를 돌려주고 호스트가 알린다.
  4. 원격 적용 자체가 실패하면 문서가 이미 어긋난 것 → 재동기화(§7).
- **기록 재생** `replayAll(batches)`(늦은 참여·재동기화·정본 복원, 3단계 S3-3): 여러 묶음을 rhwp 배치 괄호
  (beginBatch/endBatch)로 묶어 쪽 배치를 끝에 한 번만 하고, `layout` 연산과 `state` 앞에서는 괄호를 닫는다. 근거는
  R1b 재생 가능성의 deferred pagination 축이다(쪽 배치를 미루면 결과가 달라지는 함수는 `layout` 표시를 받는다).
  **R1b 의 그 축이나 `layout` 판정 규칙을 바꾸면 `replayAll` 도 함께 본다.**

## 6. studio 연결 (0002 패치 확장)

| 플러그인 API | 계약 |
|---|---|
| `host.interceptDocumentCalls({ methods, call })` → 해제 함수 | studio 가 `HwpDocument.prototype` 의 지정 메서드를 감싼다. 감싼 메서드는 `call(name, args, invoke, target)` 를 부르고, 플러그인이 `invoke()` 로 원래 메서드를 실행한다(전후 처리를 플러그인이 쥔다). `target` 은 호출된 문서 객체다. 모든 문서 인스턴스에 적용되고, 해제 함수는 원장으로 회수한다. 플러그인에 wasm 모듈을 주지 않는다는 기존 계약을 지키면서 기록 훅을 다는 공식 자리다. |
| `host.applyExternal(label, fn)` | `fn(doc)` 을 실행하고 **undo 기록·스냅샷 없이** 편집 뒤와 같은 전체 갱신(조판·렌더)을 한다. 트랜잭션 중첩 규칙은 `transaction` 과 같다. 원격 적용·되감기·재동기화에 쓴다(1단계의 `transaction` 사용을 대체). |
| `host.suspendHistory()` → 해제 함수 | 중지 동안 undo/redo 는 아무것도 하지 않고 "공동편집 중에는 되돌리기를 지원하지 않습니다"를 띄운다. 히스토리·스냅샷이 쌓이지 않아야 한다. |
| `host.setCaret(caret)` | `PluginCaret`(논리 오프셋) 형태로 캐럿을 옮긴다. 선택은 접고, 범위 밖이면 가장 가까운 유효 위치로. |
| `host.isComposing()` + 이벤트 `composition-end` | IME 조합 중인지, 끝났는지. |
| `host.caretRect(caret)` → `{left, top, height} \| null` | (R10) `PluginCaret`(논리 좌표, 본문·셀 경로)의 화면 위치. **studio 캐럿과 같은 계산**(`caret-renderer.ts`: `getCursorRect` + 쪽 오프셋·`calcPageLeft`·줌, 셀·머리말 경로·클램프 포함)을 그대로 쓰고, 기준은 스크롤 내용 요소다. 그 위치를 표시할 수 없으면 `null`. |
| `host.overlayLayer()` → `HTMLElement` | (R10) 스크롤 내용 안에 있어 문서와 함께 스크롤되는 표시 층. `pointer-events: none`(편집을 가로채지 않음), 캐럿보다 위·대화상자보다 아래. 플러그인이 넣은 자식은 unload 때 원장으로 걷는다. |
| 이벤트 `view-changed` | (R10) 줌, 쪽 배치, 조판 갱신(`document-layout-refreshed` 등)처럼 화면 위치가 바뀌는 때. 플러그인은 이때와 편집 반영(`document-mutated`/`document-changed`, `applyExternal` 뒤) 때 다른 사람 캐럿 위치를 다시 계산한다. 스크롤은 표시 층이 같이 움직이므로 필요 없다. |

- R10 의 위치 계산을 studio 쪽에 두는 이유: 플러그인이 `getCursorRect` 로 쪽 좌표를 받아 화면 좌표로 바꾸면
  studio 캐럿 계산(셀·머리말 경로, 회전, 클램프)을 다시 쓰게 되고 둘이 어긋나기 쉽다.
- 다른 사람 캐럿은 엔진이 **텍스트 좌표**로 들고 연산 지도로 옮긴다. `caretRect` 를 부르기 직전에 그 시점 문서로
  논리 좌표로 바꾼다(`setCaret` 과 같은 변환). 머리말·꼬리말·각주 안 캐럿(`getCaret` 이 `null` 인 곳)은 보내지도
  그리지도 않는다.

- **기록은 공유 문서 객체에서 일어난 호출만.** 훅은 prototype 에 걸리므로 모든 문서 객체의 호출이 온다.
  studio 는 문서를 열 때마다 새 객체를 만들고(`wasm-bridge.ts:631,686`, 교체가 끝나기 전 그 객체에 호출이
  간다), hwpctl 독립 실행은 자기 객체를 따로 만든다(`hwpctl/index.ts:440`). 플러그인은 `target` 이 지금 빌린
  공유 문서 핸들(같은 세대)일 때만 기록하고, 그 밖은 그대로 `invoke()` 만 한다. 재동기화·`welcome` 처리 중
  여는 문서도 교체가 끝나 공유 핸들이 되기 전에는 기록하지 않는다. 시험: 다른 객체에 대한 변경 호출이
  기록되지 않음, 교체 직후 첫 호출부터 기록됨.
- undo 를 끄는 이유: 원격 편집이 끼어든 뒤 내 undo 항목의 위치가 낡는다. 내 편집만 되돌리기는 3단계.
- 각 API 는 studio 단위 테스트를 둔다. 플러그인이 안 부르면 지금과 같아야 한다.

## 7. 서버와 플러그인 (대체: 1단계 §5 일부, §6.4~§6.7)

서버:

- 로그 항목은 `op` 묶음 또는 `state`. `state` 는 새 기준점이다. `welcome` 은 **마지막 `state`(없으면
  처음 base) + 그 뒤 항목들**을 준다(늦은 참여·재동기화가 처음부터 재생하지 않게 된다).
- `C→S {type:"resync"}` → `welcome` (+ `resync:true`).
- 시험용 지연: `COLLAB_DELAY_MS` 가 있으면 방송을 그만큼 늦춘다(순서 유지).
- 낡은 base 거절, digest 비교는 1단계 그대로.
- **한 방은 한 엔진 버전만.** 재생은 "같은 함수 = 같은 결과"를 전제로 하므로, 업스트림 버전이 다른
  클라이언트가 섞이면 같은 기록이 다르게 적용될 수 있다. `hello` 에 `engine` 지문(업스트림 커밋 +
  패치 해시 + 분류표 해시, 빌드 때 생성)을 넣고, 서버는 방의 첫 참여자 지문과 다르면 `{type:"incompatible"}`
  로 거절한다. 플러그인은 "다른 버전의 편집기가 이 문서를 편집 중입니다. 새로고침하세요"를 띄운다.

플러그인 상태: `lastSeq`, `inflight`(보낸 묶음 수, 0=없음), `queue`(보류된 원격), `resyncing`.

- 연결 직후 `suspendAutosave()`(1단계 §6.9), `suspendHistory()`, `interceptDocumentCalls(분류표 전체)`.
- **flush** (`document-mutated`/`document-changed`): `inflight>0`·조합 중·`resyncing` 이면 건너뜀.
  `takePending()` 이 있으면 `{entries, base:lastSeq}` 전송, `inflight = entries.length`.
- **수신:** 조합 중이면 `queue` 에 넣고 `composition-end` 에 처리(조합 중에는 보내지도 않는다).
  내 것이면 `ack(inflight)`, `inflight = 0`, flush. 남의 것이면 `caret = host.getCaret()` →
  `applyExternal('collab:remote', d => engine.receiveRemote(entries, caret))` → `host.setCaret(결과)`,
  버린 것이 있으면 "동시 편집 충돌로 내 편집 N건이 취소됐습니다". `lastSeq = seq`.
- **reject:** `requeue()`, `inflight = 0`, flush.
- **예상치 못한 문서 교체 → 방에서 나간다** (재동기화 아님). 사용자가 다른 파일을 열거나 새 문서를
  만든 것이므로, 공유 문서로 다시 끌어오면 사용자 의도를 거스른다. 연결을 끊고 기록 훅·히스토리 중지·자동
  저장 중지를 해제한 뒤 "공동편집에서 나왔습니다"를 띄운다. (1단계의 "교체 → desynced" 를 대체.)
- **재동기화** (diverged, 원격 적용 실패): `resync` → welcome 으로 기준점
  `collabLoadState` + 뒤 항목 재생(`applyExternal`) → 상태 초기화 → "동기화를 다시 맞췄습니다. 일부 입력이
  취소됐을 수 있습니다". 1분에 3회를 넘으면 멈추고 1단계의 desynced 배너.
- digest 보고(1단계 §6.8)는 그대로. 이제 굵게 같은 편집도 동기화되므로 **diverged 는 기록 훅 밖의 변경
  (분류표 누락, 업스트림 버그)을 뜻한다.**

## 8. 작업 목록 (코드 세션)

순서대로. 결과는 §10 에 기록한다. 초판 작업 목록(S2-T1~T10)은 이것으로 대체한다(S2-T1 오프셋 확인은
완료되어 §3 에 반영됨).

- **R1 분류표.** `gen-catalog.mjs` + 덮어쓰기 + 모든 항목 감사(§3 판정 규칙, `why` 필수). 분류 누락·사라진
  이름에서 실패하는지 테스트. `bootstrap.sh` 에 연결. 감사 결과 요약(`state` 목록과 근거, `neutral` 목록)을
  §10 에 남긴다.
- **R1b 동작 동일성 검사** (§3). 사례 생성기·손으로 쓴 사례 틀, `check-behavior.mjs`(이전/새 엔진 차분
  비교 + 재생 가능성 검사), `catalog-drift.json`, `bootstrap.sh` 연결. 시험: (1) 같은 빌드끼리 돌리면 전부
  "같음", (2) 업스트림 함수 하나의 동작을 일부러 바꾼 빌드와 비교하면 그 기능만 `state` 로 내려감, (3) 한
  기능이 내부 클립보드를 쓰게 만든 경우 재생 가능성 검사가 잡음. (2)(3)은 시험용 패치로 만들고 끝나면 되돌린다.
  R5 생성기와 같이 쓰므로 R4 뒤, R5 와 함께 진행해도 된다.
- **R2 studio API** (0002 확장, §6). 단위 테스트.
- **R3 Rust 보조** (§5 표). 1단계 기록 코드 은퇴와 테스트 정리. 자체 스냅샷 동일성 테스트, `collabLoadState`
  왕복 테스트, `ot.rs` 의 §4.4 이름 붙은 테스트와 §4.5 표 테스트.
- **R4 엔진** (TS, §5).
- **R5 무작위 시뮬레이션** (Node + 실제 WASM, 엔진을 그대로 사용). 클라이언트 3개 + 프로세스 안 서버
  모형(seq·거절·ack 를 실제 프로토콜대로). 각 클라이언트는 자기 현재 문서에서 유효한 무작위 편집을 만든다:
  `text` 7종(한글·영문, 빈 문단, 문단 경계 근처 가중), `neutral` 몇 종(글자·문단 서식), `structural` 몇 종
  (표 만들기·행 추가), `state` 1종(복사 후 내부 붙여넣기). 메시지 순서·지연을 무작위로 섞는다. 끝에서 모두
  조용해지면 모든 digest 동일, 그리고 서버 로그를 새 문서에 재생한 digest 와 동일. **합격: 시드 500 × 연산
  200 에서 수렴 실패 0.** 분류별 충돌률을 기록한다. 실패하면 시드를 출력한다.
- **R6 서버** (§7). 테스트 추가.
- **R7 플러그인** (§7).
- **R8 브라우저.** `COLLAB_DELAY_MS=300` 으로 두 탭이 응답을 기다리지 않고 번갈아 친다: 같은 문단 영문·한글
  IME 동시 입력, 한쪽 Enter 와 다른 쪽 입력, 같은 경계 동시 Backspace, 한쪽 선택 삭제와 다른 쪽 그 안 입력,
  **굵게·문단 정렬·표 만들기·붙여넣기가 상대에게 반영됨**. 합격: 매 단계 digest 일치, desync 0, 각자 친
  글자가 이어져 있고 캐럿이 자기 글자 뒤. 1단계 T4·T8 회귀(T4 의 "굵게 → diverged" 기대값은 "굵게 동기화"로
  바뀐다).
- **R9 성능 측정.** 업스트림 샘플 중 큰 문서(그림 포함)로 스냅샷 복제, 되감기, `state` 내보내기 크기·적재
  시간. 관문이 아니라 3단계 판단 자료. 단 **입력 묶음당 스냅샷 비용이 16ms(한 프레임)를 넘으면** 바로
  설계 세션에 알린다(타이핑 체감에 걸린다). 추가: **현실 조건 충돌률** — R5 시뮬레이션을 사람 속도
  (초당 5타 안팎, 서식·구조 편집은 드물게)와 왕복 100ms 로 돌려 분류별 충돌률을 기록한다. R5 의 고밀도
  수치(구조 73.7%)로는 §4.5 규칙이 실사용에서 너무 거친지 판단할 수 없다.
- **R10 다른 사람 커서** (정확성 작업 뒤). `cursor` 메시지 방송, 받은 캐럿을 이후 연산의 지도로 계속 옮김,
  studio 커서 좌표 조회로 이름표 달린 색 막대를 겹침. 필요한 studio API 가 없으면 설계 세션에 묻는다.
- **R11 빠른 경로: 되감기 없이 바로 적용** (R9 선측정 결과로 추가). 되감기는 스냅샷 복원의
  `rebuild_derived_state`(전체 재조판) 때문에 큰 문서에서 비싸다(204쪽 318ms, 무거운 23쪽 문서 2.3s).
  동시 타이핑 중에는 원격이 올 때마다 이 비용이 들어 입력이 멈춘다.
  - **조건:** 내 미확정 열과 받은 원격 열이 **모두 `text` 또는 `neutral`** 일 때만. 그때는 보정 열 계산에서
    이미 나오는 R'(원격을 내 미확정 뒤로 옮긴 것)를 **지금 문서에 바로 적용**하고, P'(재전송용)는 지금처럼
    만든다. 스냅샷은 건드리지 않는다(확정분 목록에 R 을 더해 둘 뿐, 다음 느린 경로 때 쓰인다). 그 밖의
    조합, R' 적용 예외, 보정 충돌은 지금의 되감기 경로로 간다.
  - **왜 지금은 되나:** 초판에서 이 방식을 미룬 이유는 TP1(두 순서의 결과가 같음)을 보장할 수 없어서였다.
    이제 R5 시뮬레이션이 있으므로 **직접 검증**한다: 시뮬레이션의 매 원격 수신에서 빠른 경로 결과와 되감기
    결과의 digest 를 비교한다. **관문: text/neutral 만 쓰는 시드 500 × 200 에서 불일치 0.** 불일치 쌍이
    나오면 그 쌍을 고치거나, 그 쌍만 빠른 경로에서 빼서 되감기로 보낸다(쌍 단위 차단표).
  - **안전망:** 실제 사용에서 TP1 이 어긋나면 내 문서가 서버 순서 문서와 달라진다. digest 보고가 잡고 재동기화
    한다(그때 내 미확정은 취소). 빠른 경로를 끄는 설정(`?collabFast=0`)을 둔다.
  - 측정: 같은 큰 문서에서 빠른 경로의 원격 수신 시간(R' 적용 + 부분 조판)을 되감기와 나란히 기록.
- **R12 결과 전송 크기.** `collabExportState`·base 를 원본 형식 계열로 내보낸다(§5 표). 전송은 압축한다
  (브라우저 `CompressionStream('gzip')`, Node `zlib`). 서버의 메시지 크기 상한을 정하고(예: 64MB, ws 기본
  상한 100MiB 보다 낮게), 넘으면 보낸 쪽에 "문서가 커서 이 편집은 공동편집으로 보낼 수 없습니다"를 띄우고 그
  기록은 버린다(재동기화로 되돌려짐). **HWP 내보내기가 왜 22배로 커지는지 원인을 조사해 §10 에 남긴다**
  (예: 그림 바이너리를 압축하지 않고 넣는지). 업스트림 결함으로 보이면 재현 정보만 정리하고, 이슈 등록은
  사용자 결정에 맡긴다.
- **R13 정밀화** (§4.6). R1b 다음, R10 보다 먼저.
- **R14 사례 틀 보강** (R13 다음). R1b 첫 실행에서 사례가 없어 `state` 로 내려간 75개를 줄인다. 사용자 목표는
  "구현된 기능은 전부 동작 전송"이다.
  - 우선순위: (1) **studio 메뉴·도구·단축키로 닿는 기능**(사용자가 실제로 누르는 것) → (2) 플러그인·hwpctl 로만
    닿는 기능. 각 기능이 어디서 불리는지(studio 호출처 유무)를 분류표에 `reach` 로 적어 순서를 정한다.
  - 합격: (1)에 해당하는 기능은 모두 사례를 갖추고 `op` 로 올라간다(숨은 입력·조판 의존으로 `state` 가
    맞는 것은 근거를 단다). (2)는 남은 수와 목록을 보고한다.
  - `insertMemo`·`insertMemoByPath` 는 메모 생성 시각(`memo_time::now`)을 쓰므로 `state` 로 둔다. 시각을
    `ctx` 로 담으려면 업스트림 `memo_time` 에 시계 주입을 패치해야 하는데, 메모 삽입은 드물어 패치 범위를 늘릴
    가치가 없다.
  - **후속(R10 다음, 2단계 커밋 전):** "사례를 만들 문서가 없다"던 studio 기능 12개는 업스트림 `samples/` 에서
    찾는다. 우리 희소 체크아웃에는 일부만 있지만 업스트림에는 2,233개가 있고 차트(`samples/chart/…`)·수식·
    양식 샘플이 들어 있다. `git ls-tree -r --name-only HEAD samples` 로 찾아(내려받지 않고 목록만), 필요한
    하위 디렉터리만 희소 경로에 더한다(`bootstrap.sh` 의 목록도 갱신). **업스트림 샘플 파일을 우리 저장소에
    복사·커밋하지 않는다**(제3자 문서가 섞여 있을 수 있음 — 업스트림 체크아웃에서 참조만). 찾지 못한 것만 남기고
    목록을 보고한다.

## 9. 알려진 한계 (2단계)

- 텍스트 외 연산의 동시 편집은 보수적이다: 같은 구역에서 구조를 바꾸는 편집이 겹치면 늦은 쪽(미확정
  쪽)의 편집이 취소되고 알림이 뜬다.
- `state`(결과 전송) 편집은 문서 전체를 보낸다. 큰 문서에서 느리고, 겹치면 늦은 쪽이 취소된다. 그 편집을
  "바뀐 구역만" 보내도록 줄이는 것은 3단계.
- 내보내기→다시 읽기가 완전 무손실이 아니면 `state` 편집 때 손실이 생길 수 있다. 세션 시작 때 이미 한 번
  같은 왕복을 하므로(1단계 §6.2) 추가 손실 가능성은 낮지만, `exportHwpWithReport` 의 손실 보고가 있으면
  알린다.
- 선택 영역은 원격 편집 때 캐럿으로 접힌다. 공동편집 중 undo/redo 없음. 충돌로 취소된 편집은 되살리지
  않는다(알림만).
- 기록기가 JS 에 있어 네이티브 앱은 그대로 쓰지 못한다(§2).
- 공동편집 중에는 엔진 내장 글꼴 규칙으로 배치하므로, 문서 글꼴이 설치된 기기에서는 혼자 편집할 때와 줄·쪽
  나눔이 다를 수 있다(3단계 S3-1 글꼴 정책 bundled-only — 그 대신 기기·브라우저가 달라도 결과가 같다,
  `docs/collab-stage3.md` 기록).
- 영속성 없음(1단계 §8). 다만 `state` 기준점 덕분에 늦은 참여 재생 길이는 줄어든다.

## 10. 검증 기록

| 날짜 | 항목 | 결과 |
|---|---|---|
| 2026-11-26 | S2-T1 오프셋 단위 확인 | 업스트림 샘플 `samples/hml/exambank_math_equations_min.hwp` 의 수식 개체가 든 문단(p2 "다항식 [수식]을 전개하시오.")으로 확인. 길이 12(개체 제외), 개체 텍스트 위치 4, `char_offsets` 3→12(8 유닛 틈). 같은 오프셋 4 삽입이 `after_inline_control` 로 개체 앞/뒤 갈림, 개체를 사이에 둔 삭제는 글자만 지움, 😀 는 1 글자, 범위 넘는 삭제는 잘림. 이 수식은 글자처럼 취급이 아니라 논리 오프셋 = 텍스트 오프셋이고, 글자처럼 취급으로 바꾸면 논리 4→(4,앞)·5→(4,뒤)·6→(5,앞). 결론은 §3. collab 테스트 **12/12** (기존 11 + 1) |
| 2026-11-26 | 중단 | 설계 세션 요청으로 S2-T1 의 오프셋 단위 확인까지 하고 멈춤(메타데이터·불변식 미착수). 변경은 `collab-core/src/tests.rs` 의 테스트 하나뿐 |
| 2026-11-26 | 설계 개정 | 사용자 결정으로 전 기능 동기화(동작/결과 혼합)로 개정. 기록 위치를 WASM export 경계로 이동(§2). 근거 조사: 레지스트리 156개 중 151개가 같은 이름 export, 인자 형식은 number 530·string 110·boolean 22·Uint8Array 3·null 허용 9회 |
| 2026-11-26 | R1 분류표 생성·감사 | `scripts/gen-catalog.mjs` → `collab-client/src/engine/catalog.ts`, 판정 `catalog-overrides.ts`(항목마다 감사 시점 `params`). 시그니처는 업스트림 `pkg/` 가 없는 bootstrap 시점에도 돌도록 Rust 소스(`wasm_api.rs`)에서 읽는다. 대상 **160**: 레지스트리 export 151 + `*HyperlinkEx` 4 + 복원 3 + `swapPictureTransform` + `deleteRangeInCellEx`. 결과 `op 150 / state 10`, `text 9 / neutral 48 / structural 103`, 미감사 0. 엔진 지문 `981ce66b4183-087deb13e9891d17-ab11b7a713fe333e`(업스트림 커밋-패치 해시-분류표 해시). `bootstrap.sh`·`update-patch.sh` 에 연결 |
| 2026-11-26 | R1 감사 방법 | export 마다 Rust 함수 본문을 4단계까지 따라가며 비문서 상태(클립보드 2종·`paste_cascade_count`·`active_field`·저장소 5종·`hidden_header_footer`·`pagination`/쪽 번호·`file_name`·시각·난수) 참조를 찾는 스캔 + 걸린 것과 애매한 것은 직접 열어 판정. 개체 id 는 모두 문서·인자로 정해짐(`next_instance_id(&document)`, 도형은 위치·크기 해시, 수식은 문서 전체 순서) — 시각·난수 없음 |
| 2026-11-26 | R1 `state` 10 | 내부 클립보드: `pasteInternal`·`pasteInternalInCell`·`pasteInternalInCellByPath`, `pasteControl`(+ `paste_cascade_count` 로 위치를 민다). 전치 클립보드: `pasteTableCellsTransposed`·`pasteTableCellsTransposedAsTable`. 로컬 저장소 id: `restoreSnapshot`·`restoreDeleteFragment`·`restoreSectionRaw`·`swapPictureTransform`(레지스트리 제외 목록에 있지만 그림 크기 조절 실행·취소에서 IR 을 바꿈) |
| 2026-11-26 | R1 `neutral` 48 (roles) | 위치 없음 `[]`: `setPageDef`·`setSectionDef`·`setSectionDefAll`·`setPageBorderFill`·`applyEndnoteShape`·`updateConnectorsInSection`·`updateStyle`·`updateStyleShapes`·`updateClickHereProps`·`applyCharFormatInHeaderFooter`·`applyParaFormatInHf`·`reflowLinesegs`. 범위 `range(1,2,3)`: `applyCharFormat`·`setCharShapeId`. 문단 `para(1)`: `applyParaFormat`·`setParaShapeId`·`applyStyle`·`setNumberingRestart`. 개체 문단 `anchor(1)`: 표·셀 속성 7(`setTableProperties`·`setCellProperties`·`setCellZoneProperties`·`applyCellBorderFillIds`·`resizeTableCells`·`resizeTableCellsByPath`·`moveTableOffset`), `evaluateTableFormula`, 셀 서식 10(`applyCharFormatInCell(ByPath)`·`setCharShapeIdInCell(ByPath)`·`setCharShapeRunsInCellByPath`·`applyParaFormatInCell(ByPath)`·`setCellParaShapeId(ByPath)`·`applyCellStyle`), 개체 속성(`setHeaderFooterPictureProperties`·`setCellPicturePropertiesByPath`·`setCellShapePropertiesByPath`·`changeShapeZOrder`·`moveLineEndpoint`·`setEquationProperties`·`setChartData`·`applyParaFormatInFootnote`), 양식·책갈피(`setFormValue`·`setFormValueInCell`·`renameBookmark`); `anchor(2)`: `setNoteEquationProperties` |
| 2026-11-26 | R1 근거를 단 `structural` | 위치가 JSON 안: `setCharShapeRuns`·`applyShapeZOrderPairs`. 문서 전체 순번: `setChartDataByIndex`. 개체를 새로 넣을 수 있음: `setColumnDef`. 구역 재구성(`commit_picture_band_edit`): `setPictureProperties`·`setShapeProperties`. 그 밖은 기본값 |
| 2026-11-26 | R1 `layout` 7 | 결과가 조판에 기댐 → 재생 전에 미뤄 둔 조판을 끝내야 함: `insertFootnote`·`deleteFootnote`(쪽별 번호를 문서에 씀), `groupShapes`(렌더 위치로 원점), `insertPicture`·`insertPictureInCell`(쪽 기준 셀 위치), `applyParaFormat`(미주 가상 문단 주소), `reflowLinesegs` |
| 2026-11-26 | R1 설계 확인 요청 | (1) 입력 계열(`insertText`·`insertTextLogical`·`replaceBodyTextLocal`·셀 입력·`pasteHtml` 등)이 누름틀 문단에서 로컬 `active_field` 를 읽음. (2) `toggleHideHeaderFooter` 는 IR 을 바꾸지 않는 보기 상태(임시 `structural`). (3) 레지스트리·제외 목록 밖 `&mut self` export 146개(글꼴 등록·렌더 외에 `insertMemo`·`insertRuby`·`setPageHide`·`insertParagraph`·`splitSection`·`setControlLock` 등 문서 변경 포함) — 플러그인 `tx.doc()`·hwpctl 경로. (4) `layout` 연산의 지연 조판. 답에 따라 갱신 |
| 2026-11-26 | R1 테스트 `collab-client/ node --test test/` | **통과 7/7**: 실제 분류표 최신·미감사 0, state·text 목록과 neutral roles·why, 구역 자동 탐지, 가짜 이름 → state/structural 이고 훅 대상에 포함(문서 객체에 없는 합성 이름 제외, 레지스트리 밖 분류표 이름 포함), 새 이름 경고, 인자 변경 → state·사라진 이름 제외·경고, 동작 검사 결과 반영·지문 변화, 형식 오류만 멈춤 |
| 2026-11-26 | R2 studio API (0002 확장) | `PluginHost` 에 `interceptDocumentCalls`(studio 가 `HwpDocument.prototype` 을 감쌈, `includeMutatingRegistry` 로 `MUTATING_METHODS` 포함, 여러 겹·해제 안전 — `src/plugin/document-intercept.ts`), `applyExternal`(undo 경로 없이 실행 → `triggerAfterEdit()`, 던져도 갱신, 편집 모드 게이트 없음, 중첩은 `NESTED_TX`), `suspendHistory`(`CommandHistory.setSuspended`: 멈출 때 비우고 이후 명령은 쌓지 않고 바로 `discard` — 축출과 같은 경로라 스냅샷이 쌓이지 않음. undo/redo 는 "공동편집 중에는 되돌리기를 지원하지 않습니다" 안내만, 안내가 뜨도록 그동안 `canUndo/canRedo` 는 참), `setCaret`(논리 좌표, 범위 밖은 자름, 선택 접음, 조합 중이면 거절), `isComposing` + 이벤트 `composition-end`. 해제·재개 함수는 원장(`interceptReleases`·`historyResumes`)이 unload 때 회수. 훅을 주지 않으면 기본 동작 불변 |
| 2026-11-26 | R2 테스트 | studio `tsc` 통과. 플러그인 테스트 **29/29** (+13: 가로채기 실행·this·반환값·안쪽 호출·두 겹 해제, 호스트 facade 의 intercept·applyExternal·suspendHistory·setCaret 자름·isComposing·훅 없음 기본값, CommandHistory·InputHandler·main.ts 배선 소스 가드). studio 단위 테스트 전체 2717 중 실패 32 — **0002 를 되돌린 원래 업스트림에서도 같은 32개**(자식 프로세스·실제 WASM·희소 체크아웃 환경), 패치로 새로 생긴 실패 0, 통과 2663→2680 |
| 2026-11-26 | R1 보강 (설계 답변 반영) | 생성 대상 = `HwpDocument` 의 `&mut self` export 전부 **314**(소속은 바로 앞 `impl` 머리줄로 판별 — 중괄호 짝 맞추기는 문자열 속 중괄호에 깨짐, `collab*` 제외, PDF 가져오기·뷰어 등 다른 구조체 메서드 제외). 결과 `op 232 / state 12 / local 1 / none 69 / watch 0`, `ctx 20`, `layout 11`, 미감사 0. 기본값: 레지스트리 안 새 이름 → state, 업스트림 제외 목록(`EXCLUDED_NON_DOCUMENT`) → none, 레지스트리 밖 새 이름 → watch(digest 감시). 지문 `981ce66b4183-692d331257a50f37-0f2452d41ee451ae` |
| 2026-11-26 | R1 레지스트리 밖 125 감사 | `none` 40: 글꼴·측정 환경 25, 렌더·조판 설정·파생 상태 5(`setDpi`·`setHangul2024Compat`·`rebuildDerivedState` 등), `setFileName`, 클립보드 채우기·비우기 3, `setActiveField*` 3(ctx 로 기록), `beginBatch`/`endBatch`(쪽 소속 확정만 미룸 — R5 `runInBatch` 사례로 검증 예정), `createBlankDocument`(문서 교체 수명주기 → 교체 감지가 맡음). `state` 2: `pasteInternalTextLogical`(클립보드), `importParagraphBlock`(인자가 다른 문서 객체). `neutral` 12: `applyFootnoteShape`(+layout), `equalizeTableCellSizes`·`recalculateTableFormulas`·`removeTableCellFormulas`·`setTableCellFormula`·`setComposeControl*` 3(anchor), `renameField`·`setMemoShape`·`setMemoText`·`setNumberingCharShape`([]). 나머지 71 은 op/structural — `*At`/`*AtCursor` 계열은 `list_id` 를 문서에서 찾고 `para_in_list` 는 구역을 가로지르는 전역 번호라 결정적(roles 로는 못 옮김), `convertToEditable` 은 모델 변경(결정적) |
| 2026-11-26 | R1 `ctx.activeField` 20 | 레지스트리: `insertText`·`insertTextLogical`·`replaceBodyTextLocal`·`insertTextInCell`·`insertTextInCellDeferredPagination`·`replaceTextInCellDeferredPagination`·`insertTextInCellByPath`·`evaluateTableFormula`·`pasteHtml`. 밖: `insertTextAtCursor`·`insertTextInCellEx`·`pasteHtmlTextLogical`·`pasteHtmlInCellEx`·`evaluateTableFormulaEx`·`recalculateTableFormulas`·`removeTableCellFormulas`·`setTableCellFormula`·`deleteComposeControl*` 3(본말을 남길 때 입력 경로를 탐). `layout` 11: 기존 7 + `applyFootnoteShape`·`applyParaFormatAtCursor`·`insertPictureEx`·`splitSection` |
| 2026-11-26 | R1 `toggleHideHeaderFooter` 조판 영향 확인 | **영향 없음 → `local`.** 숨김 집합은 `renderer/layout.rs` 의 머리말·꼬리말 렌더 노드 두 곳에서만 쓰이고, 이미 계산된 `header_area`/`footer_area` 안의 내용을 그리지 않을 뿐이다. 영역 크기·쪽 나눔·본문 영역은 바뀌지 않으며 `renderer/pagination` 은 이 값을 읽지 않는다 |
| 2026-11-26 | R1 테스트 (보강 후) | **통과 9/9** (+2): 레지스트리 밖 새 `&mut` → watch·제외 목록 → none·`&self`·다른 구조체·`collab*` 는 대상 아님, `local`·`none` 에 conc·ctx 를 쓰면 형식 오류. 실제 분류표: 314·state 12 목록·local/none 예시·watch 0·ctx·layout 표시 |
| 2026-11-26 | R2 보정: 호출 대상 전달 | `interceptDocumentCalls` 콜백에 `target`(호출된 문서 객체)을 넘긴다(`call(name, args, invoke, target)`). 플러그인이 공유 핸들인지 가린다. 테스트에 target 확인 추가, 플러그인 테스트 29/29 |
| 2026-11-26 | R3 Rust 보조 | 1단계 기록 코드 은퇴(7개 가로채기·outbox·복원 desync·deleteRange 가로채기·`Op`·`collabApplyRemoteOps` 등 JS 표면 5개). 새 표면: `collabSnapshotSave/Restore/Discard`(자체 저장소, 업스트림 순서 그대로), `collabLoadState`(새 코어로 파싱 → 문서만 같은 설치 순서로, studio 환경 유지, `active_field` 비움), `collabExportState`(캐럿 안 쓰는 원시 export), `collabMeasure`(before/after, 불변식 위반 시 `ok:false`), `collabGetActiveField`/`collabSetActiveField`(이전 값 반환), `collabLogicalToText`/`collabTextToLogical`(개체 뒤 여부 포함), `collabTransform`/`collabMapCaret`(순수), `collabDigest`, `collabFlushLayout`. `ot.rs`: 위치 공간(본문 구역/셀), 위치 지도·문단 운명(Kept/Touched/Gone), 구간 삭제(상대 삽입은 살려 쪼갬, 뒤부터), Replace·Merge 경계 규칙, §4.5 표, 순서 있는 열끼리 보정(`xform`, 어느 방향이든 못 하면 미확정 쪽 충돌), `ctx.activeField` 를 anchor 로 옮김, 캐럿은 Before. `insertTextLogical` 은 텍스트 좌표(meta)로 보정하고 바뀌면 `relogical` 표시(재적용 때 논리 오프셋 재계산) |
| 2026-11-26 | R3 테스트 `cargo test … collab::` | **통과 33/33.** 문서 테스트 13: 오프셋 단위, 같은 호출 두 문서 수렴(바이트·digest), digest(캐럿·조판·렌더 무관, 편집·문서 속성 반영), **자체 스냅샷 복원 = 업스트림 복원**(빈 문서·수식 샘플, digest·내보내기·문단 동일, 업스트림 저장소 불변), 결과 적재(새 파싱과 동일·세션 상태 비움·잘못된 바이트 거절 시 문서 유지), meta 실측 7종(잘린 삭제 실측 포함), insertTextLogical 텍스트 좌표 변환, 불변식 위반 감지, activeField 왕복, 실제 문서 동시 편집 4(같은 지점 삽입, 삭제 vs 범위 안 삽입, Enter vs Backspace 양쪽, 서식 범위 이동). 순수 보정 20: §4.4 이름 붙은 9 사례 + merge 경계·replace·insertTextLogical·§4.5 표 3·꼬리 버림·순서 열·activeField·캐럿·위치 지도. wasm32 `cargo check` 경고 없음 |
| 2026-11-26 | R4 엔진 (`collab-client/src/engine/`) | `engine.ts`(CollabEngine: 공유 핸들의 호출만 기록, none·local 통과, watch 는 digest 가 바뀌면 state, text 는 `collabMeasure` before/after 로 meta·불변식 위반 시 state, `ctx.activeField` 실측, layout 은 원래 호출 직전 `collabFlushLayout`, 기록할 수 없는 인자 → state, 보내지 않은 연속 state 는 마지막 것만, 확정분은 다음 되감기 때 스냅샷 위에 다시 얹음(확정마다 스냅샷을 다시 뜨지 않음), 원격 수신: 미확정 없음 → 적용 + 캐럿 지도 / 있음 → 되감기·확정분·원격·새 스냅샷·`collabTransform`·재적용(`insertTextLogical` relogical 재계산, ctx 로 activeField 잠시 맞춤, layout flush), 충돌·재적용 실패는 그 연산과 꼬리를 버리고 `droppedEntries` 로 알림), `codec.ts`(인자 인코딩·base64), `classify.ts`, `index.ts` |
| 2026-11-26 | R4 발견: state 기록의 자기 적재 | 시험에서 내보낸 바이트를 다시 읽은 문서의 digest 가 원래 문서와 달랐다(내보내기→다시 읽기는 항등이 아님). 보낸 쪽만 원래 문서를 들고 있으면 갈리므로, **state 를 기록할 때 보낸 바이트를 내 문서에도 `collabLoadState` 로 다시 적재**한다(1단계 base 담당 재열기와 같은 이유) |
| 2026-11-26 | R4 시험 (실제 WASM, Node) | **통과 11/11**: 공유 문서·녹화 중만 기록(다른 객체·녹화 꺼짐 제외)·meta 4종·ctx·스냅샷, none/local 비기록·state 결과·연속 state 하나로, watch(바뀔 때만)·객체 인자 → state, 같은 지점 입력(먼저 확정된 쪽 앞), 삭제 범위 안 입력 생존·Enter vs Backspace, 응답 기다리며 친 여러 묶음·거절·재전송(각자 글자 이어짐), 서식 범위 이동·굵게 반영, 같은 구역 구조 충돌 → 늦은 쪽과 꼬리 취소·알림, ctx.activeField 재생 후 원래대로, layout flush(기록·재생 직전), 캐럿(미확정 없음·있음). 모든 사례에서 digest = 서버 로그 재생 digest |
| 2026-11-26 | R5 발견: 삭제 범위 안 Enter 의 TP1 위반 | 시뮬레이션에서 보정한 연산의 재적용 실패("문단 인덱스 범위 초과")가 몇 시드에서 나왔다(수렴은 유지). 원인: 미확정 삭제는 원격 Enter 경계를 흡수(§4.4 deleteRange)하는데, 원격 Enter 를 미확정 삭제 뒤로 옮길 때는 삭제 시작점에서 살려 두어 두 방향 판정이 달랐다 → 뒤 미확정 연산이 없어진 문단을 가리킴. 수정: 쌍마다 판정을 하나로 — 미확정 삭제 vs 원격 Enter 는 흡수(원격 Enter 는 반대 방향에서 사라짐), 미확정 Enter vs 원격 삭제는 Enter 생존(원격 삭제는 새 경계를 넘지 않게 둘로 쪼갬). 시험 `split_inside_delete_range_has_one_fate_in_both_directions` 추가, Rust **34/34**. 다른 쌍(같은 지점 삽입·삽입 vs Enter·Enter 끼리·합침 vs 합침/Enter/삭제·바꾸기 vs Enter/삽입)은 손으로 두 방향 판정을 대조해 일관됨을 확인. 수정 뒤 개발 빌드로 시드 40: 재적용 실패 0 |
| 2026-11-26 | R6 서버 | 기록 필드 `entries`, hello 의 `engine` 지문(방의 첫 참여자와 다르면 `incompatible` 후 닫음 — 방은 그 엔진 버전에 묶임), state 기록은 새 기준점(welcome = 마지막 state + 그 뒤 항목, 묶음 안 state 뒤 항목도 보존), `resync` → welcome(`resync:true`), `COLLAB_DELAY_MS`(모든 송신을 같은 지연으로 — 연결마다 순서 유지). 시험 **10/10** (+4: state 기준점·resync·incompatible·지연 순서) |
| 2026-11-26 | **R5 관문** `node collab-client/test/sim.mjs --seeds 500 --ops 200 --clients 3` | **통과: 수렴 실패 0** (편집 100,000건, 73초, 릴리스 WASM). 끝에서 모든 클라이언트 digest 동일 + 서버 로그를 새 문서에 재생한 digest 와 동일. 편집 구성: insertText 32,815·replaceBodyTextLocal 13,153·deleteText 8,993·splitParagraph 8,750·insertTextLogical 6,613·applyCharFormat 6,454·mergeParagraph 4,432·deleteRange 4,354·applyParaFormat 4,337·runInBatch 3,320·createTable 3,243·pasteInternal 2,748·insertTableRow 788. **분류별 충돌률**(꼬리 포함 버림/만든 수): text 32.19%, neutral 30.90%, structural 73.65%, state 72.45%. 버린 사유(되감기 사건 수): 같은 구역 구조 겹침 2,005+2,475, state 겹침 2,780, 서식 범위가 두 문단으로 갈림 118, 재적용 실패 2(코어가 deleteRange 를 "필드나 같은 자리의 여러 개체를 포함한 경계" 로 거절 — 위치 오류 아님). 텍스트끼리의 보정 실패는 없음. 시뮬레이션은 전달 없이 편집을 오래 쌓는 고밀도 설정이라 실제 왕복 시간 대비 충돌이 많다. `runInBatch` 3,320건(배치 안 deleteText+insertTextLogical)이 섞여도 수렴 → `beginBatch`/`endBatch` none 판정 조건 충족. 작은 정규 시험 `sim.test.mjs`(시드 3 × 100) 추가, collab-client 시험 21/21 |
| 2026-11-26 | R9 선측정 (Node, 릴리스 WASM) | **입력 묶음당 스냅샷 저장 0.01~1.06ms(중앙값), 최대 1.67ms → 16ms 기준 아래.** 3단계 판단 자료: 되감기(스냅샷 복원 = 전체 재조판) blank 0.2ms · 시험지 10MB(20쪽) 48ms · 12MB 204쪽 318ms · 교육 통합 5.6MB(23쪽) 2.3s(이 문서는 Node 에서 insertText 한 번도 2.4s). 결과 내보내기 17~65ms(HWP 원본은 원본 크기 수준), **HWPX 로 연 문서의 내보내기 174MB**(원본 hwpx 7.9MB, 같은 내용 hwp 9.9MB) — base·state 크기 문제. 결과 적재 130ms~4.9s, digest 5~20ms |
| 2026-11-26 | R12 원인 조사: HWPX 출처 문서의 HWP 내보내기 22배 | **업스트림 결함 아님 — 우리 내보내기 경로 선택의 문제.** 샘플 `samples/hwpx/exam_kor.hwpx` 의 zip 안 그림 47개가 **비압축 BMP**(풀면 합 182MB, zip 이 deflate 해 7.9MB). HWPX 파서는 HWPX 에 파일 헤더가 없으므로 `FileHeader.compressed=false` 로 만든다(`src/parser/hwpx/mod.rs` 의 `model_header`). collab 의 `collabExportState` 는 캐럿을 쓰지 않으려고 원시 직렬화 `export_hwp_native` 를 썼는데, 이 경로는 HWPX→HWP 어댑터(`prepare_hwp_export_snapshot` → `hwpx_to_hwp::normalize_file_header_for_hwp` 가 `compressed=true` 로 바꿈)를 타지 않는다. 그래서 cfb_writer 가 문서 압축 플래그를 따라 BinData 스트림을 압축 없이 썼다(CFB 덤프: BinData 172.95MB, 가장 큰 `BIN001A.bmp` 27.8MB; 같은 내용의 HWP 원본은 BinData 9.63MB). 압축 플래그가 꺼진 HWP 는 사양상 유효하다. studio 의 일반 저장(`exportHwp`)은 어댑터를 타서 6.66MB. 크기 비교(같은 HWPX 문서): 원시 HWP 174.73MB(gzip 6.88MB) · 어댑터 HWP 6.66MB · HWPX 7.89MB(gzip 7.44MB). HWP 원본 문서는 원시 HWP 9.89MB(gzip 9.17MB) |
| 2026-11-26 | R12 구현 | `collabExportState` = 원본 형식 계열(HWPX 출처 → `export_hwpx_native`, 그 밖 → `export_hwp_native`) + gzip(빠른 수준). `collabLoadState` 는 gzip·HWP·HWPX 를 모두 받고 문서의 `source_format` 도 읽은 형식으로 바꾼다(다음 내보내기가 같은 계열로). 풀기 상한 512MB(압축 폭탄). 플러그인: base 를 `DecompressionStream` 으로 풀어 studio 로 열고 파일 이름 확장자를 바이트로 정함(zip → .hwpx). 서버: `COLLAB_MAX_MESSAGE_BYTES`(기본 64MB, ws 하드 상한은 그 두 배), 넘으면 `too-large` 로 알리고 버림(base 면 연결 닫음), welcome 에 `maxMessageBytes`. 플러그인은 보내기 전 크기를 미리 걸러 "문서가 커서 이 편집은 공동편집으로 보낼 수 없습니다" 안내 후 재동기화, base 가 넘으면 "문서가 커서 공동편집을 시작할 수 없습니다" 로 방을 나감. gzip 은 Rust(flate2)에서 동기로 한다 — 엔진의 state 기록이 동기라서(설계의 `CompressionStream` 은 base 풀기에만 씀). 시험: Rust `state_keeps_source_format_family_and_is_gzipped`, 서버 +1(상한), 브라우저 상한(R7 생애 시험) |
| 2026-11-26 | R7 플러그인 (`collab-client/src/plugin.ts` 재작성) | 연결 시 자동 저장·되돌리기 기록 중지와 기록 훅(레지스트리 포함, 공유 핸들의 호출만 엔진이 기록), 보내기는 한 번에 한 묶음(inflight)·조합 중 보류, 원격은 `applyExternal` 안에서 엔진 `receiveRemote`, 캐럿은 studio 논리 좌표 ↔ 엔진 텍스트 좌표 변환 후 옮김, 충돌 취소 알림, seq 건너뜀·적용 실패·diverged → 재동기화(1분 3회 넘으면 desynced), 우리가 일으키지 않은 문서 교체 → 방을 나감(훅·중지 모두 해제), hello 에 엔진 지문, `incompatible` → 안내 후 나감, `?collabFast=0`. 브라우저 생애 시험 `collab-client/e2e/r7-lifecycle.mjs` **9/9**: 교체 → 나감·자동 저장 재개·나간 뒤 기록/수신 없음·되돌리기 재개, 지문 불일치 안내, base 상한 초과 안내, 기록 밖 변경으로 어긋난 문서가 재동기화로 다시 같아짐(재동기화 1회) |
| 2026-11-26 | 엔진 지문에 보정·기록 코드 포함 | 지문이 업스트림 커밋·패치·분류표만 담아, collab-core(보정 함수)나 엔진이 다른 클라이언트가 같은 방에 들어올 수 있었다. 형식을 `업스트림12-패치12-코드12-분류표12` 로 바꾸고 코드 해시에 `collab-core/src/*.rs`(시험 제외)와 `collab-client/src/engine/*.ts`(생성 파일 제외)를 넣음. `build-wasm.sh` 끝에서 다시 생성, 분류표 시험이 `--check` 로 최신인지 확인(코드만 바꾸고 다시 만들지 않으면 실패) |
| 2026-11-26 | R11 빠른 경로 구현 | Rust `rebase` 가 `Fast` 방식 보정을 함께 계산해 `fastRemote`(지금 문서에 바로 적용할 R′)·`fastBlock` 을 돌려준다. 엔진은 `fastRemote` 가 있으면 되감지 않고 적용, 원격을 확정분에 더하고 스냅샷은 그대로(다음 되감기 때 S 위에 서버 순서로 얹힘), 적용 예외면 되감기로. 보정된 미확정의 `insertTextLogical` 은 적용하지 않고 들고 있으므로 `relogical` 표시를 받는 쪽이 재계산하고, 다시 보정해도 표시를 잇는다. 시험용 `verifyFast`(빠른 경로마다 되감기 결과 digest 비교, 불일치 시 S·기록 덤프), `fastStats`. **쌍 단위 차단표(되감기로 보냄)**: ① 같은 문단을 고치는 쌍 ② 서식끼리(구역이 달라도) ③ 문단을 특정할 수 없는 neutral ④ 문단 수를 바꾸는 편집(나눔·합침·여러 문단 삭제)·셀 편집은 그 문단부터 구역 끝까지 고치는 것으로 봄 ⑤ 구조·state 가 낀 쌍. 아래 두 발견의 결과다 |
| 2026-11-26 | R11 발견 1: 같은 문단은 두 순서의 모델이 다르다 | 첫 관문 시도에서 모든 시드가 불일치. 실제 문서 무작위 대조(`fast_path_two_orders_agree_on_real_documents`, 네이티브)와 필드 차분으로 원인 확인: rhwp 편집 기능은 문단 모델에 편집 이력의 흔적을 남긴다 — 글자 끝을 넘는 글자 모양 구간(`char_shapes[].start_pos` 18 vs 17), 비운 문단이 지닌 글자 모양(id 7 vs 0), `has_para_text`, `raw_header_extra`. 글자가 같아도 digest 가 다르고, 이 흔적은 뒤 입력의 모양을 바꾸므로 digest 에서 뺄 수 없다 → 같은 문단 쌍은 되감기. 함께 고친 것: 같은 자리 바꾸기(replaceBodyTextLocal)끼리 First 쪽 삽입이 상대 글자 뒤로 가던 TP1 위반(삽입 위치를 `map_pos(at, b, bias)` 로 따로 정함, 시험 `replace_vs_replace_at_same_point_keeps_first_in_front_both_ways`) |
| 2026-11-26 | R11 발견 2: 뒤 문단 줄 세로 위치 캐시 | 차단표 ① 뒤 R5 재검증(빠른 경로 켬 + 검증)에서 10만 건 중 1건 불일치. 필드 차분: 뒤 문단들의 `line_segs[0].vertical_pos`(3200 vs 4800 …). 편집마다 자기 문단부터 구역 끝까지 세로 위치를 다시 계산하는데(`recalculate_section_vpos`) 이 계산은 저장된 값을 보고 원본 쪽 경계 등을 보존하므로 문단 모델만의 함수가 아니다 — 여러 문단 삭제가 뒤 문단 편집과 순서를 바꾸면 뒤 문단 세로 위치가 갈린다 → 차단표 ④ |
| 2026-11-26 | R8 에서 발견: 분류표 조각에 없는 이름 = 구조 | 엔진은 입력 기록의 이름만 분류표 조각으로 넘기는데, 보정은 입력에 없던 이름을 낸다(원격 deleteRange 가 내 삽입 둘레로 쪼개지면 deleteText). 그 이름이 구조로 분류돼 다음 미확정이 "구조 변경 연산과 겹침" 으로 버려졌다(브라우저에서 선택 삭제 안에 친 두 번째 글자가 사라짐). 수정: 조각에 없는 이름은 텍스트 연산으로 읽히면 텍스트. 시험 `emitted_text_names_missing_from_catalog_slice_stay_text`. R5 수치도 이 오분류만큼 부풀어 있었다(아래 재측정) |
| 2026-11-26 | **R11 관문** `sim.mjs --mix tn --verify-fast --seeds 500 --ops 200` | **통과: 빠른 경로·되감기 불일치 0, 수렴 실패 0** (편집 100,000건 — 표가 든 base 에서 본문 텍스트 9종·글자/문단 서식·셀 삭제·셀 서식·runInBatch 8,939건, 146초). 미확정 중 원격 수신 30,712번 중 빠른 경로 1,430(4.7% — 문단이 몇 개뿐인 문서에 3명이 몰아 쓰는 고밀도 설정), 되감기 이유: 같은 문단 대부분. 충돌률 text 11.99%·neutral 15.06%. 재적용 실패 16건(셀 서식·셀 삭제가 표 위치를 잘못 가리킴 — 되감기 경로의 기존 한계, 취소·알림으로 처리되고 수렴은 유지, 아래 남은 일) |
| 2026-11-26 | R5 재측정 (수정 후, 빠른 경로 켬 + `--verify-fast`) | **수렴 실패 0, 빠른 경로 불일치 0** (편집 100,000건). 충돌률 text 30.60%·neutral 29.47%·structural 73.73%·state 72.68%(이전 32.19/30.90/73.65/72.45 — 분류 오류 수정분). 빠른 경로 4.9% |
| 2026-11-26 | R11 측정: 큰 문서 원격 수신 시간 (`collab-client/test/bench-fast.mjs`, Node·릴리스 WASM) | 두 사람이 먼 문단에서 칠 때, 미확정을 든 쪽의 원격 수신(중앙값): **시험지 10MB·492문단: 빠른 경로 10.7ms / 되감기 70.7ms**, **12MB·204쪽·1,192문단: 45.4ms / 404.0ms**. 둘 다 수렴. 빠른 경로 시간은 R′ 적용(그 문단 재조판 + 뒤 문단 세로 위치 재계산)이다 |
| 2026-11-26 | R9 현실 조건 충돌률 (`sim.mjs --realistic`, 시드 100 × 편집 300, 3명) | 시간 축 모의: 참여자마다 초당 약 5타(80~320ms 간격), 편도 50ms(왕복 100ms), 각자 자기 문단에서 시작. 편집 구성: 글자 입력 80%·지우기 8%·Enter 4%·문단 합침 1%·글자 서식 3.5%·문단 서식 1.5%·표 만들기 1%·복사 붙여넣기 1%. **충돌률 text 17.59%, neutral 19.11%, structural 68.54%, state 69.91%** (버림 사건 822건이 기록 5,626건을 버림 — 사건당 평균 6.8건, 대부분 꼬리). **표 만들기·붙여넣기를 빼면(`--no-struct`) text 0.26%, neutral 0.92%** (버림 사건 10건, 모두 "서식 범위가 두 문단으로 갈림"). 즉 실사용 손실은 거의 전부 §4.5 의 "같은 구역 구조·state 편집은 모든 동시 편집과 충돌 + 꼬리까지 버림" 에서 온다(한 구역 문서에서는 문서 전체). 빠른 경로 비율 58%(각자 다른 문단), 검증 불일치 0 |
| 2026-11-26 | **R8 브라우저** `collab-client/e2e/r8-concurrent.mjs` (지연 서버 `COLLAB_DELAY_MS=300`) | **22/22 통과 — 빠른 경로 켬·끔 둘 다.** 같은 문단 영문(A 앞)·한글 IME(B 끝) 6자씩 번갈아 → 각자 글자 이어짐·캐럿이 자기 글자 뒤, A Enter vs B 입력 → B 글자가 뒤 문단 끝에, 같은 경계 동시 Backspace → 한 번만 합쳐지고(보정이 흡수 — 충돌이 아니라 취소 알림 없음), A 선택 삭제 vs B 그 안 "IN" → 살아남음, 굵게·가운데 정렬·표 만들기(2×2)·붙여넣기(내부 클립보드, state) 가 B 에 반영(값까지 확인). 매 단계 digest 일치, desync·재동기화 0. studio 입력은 `replaceBodyTextLocal`, 선택 삭제는 `deleteRange` 로 기록된다 |
| 2026-11-26 | 1단계 T4·T8 회귀 | **T4 29/29**(굵게: 1단계 "diverged" → 2단계 **동기화·B 에 반영**, 선택 삭제 되돌리기: 1단계 desynced → 2단계 **공동편집 중 되돌리기 중지로 문서 불변·desync 없음**), **T8 21/21**(자동 저장 중지·복구 모달·unload 뒤 재개). 시험 갱신은 2단계 필드(`sentEntries`)와 위 두 기대값뿐 |
| 2026-11-26 | 시험 현황 | Rust collab **41/41**(빠른 경로 실제 문서 무작위 대조 포함, 7 묶음 × 500), 서버 **11/11**, collab-client **22/22**(R5·R11 작은 시뮬레이션 포함), 브라우저 R8 22/22 ×2, R7 생애 9/9, T4 29/29, T8 21/21. wasm32 릴리스 빌드 경고 없음 |
| 2026-11-26 | R1b 동작 동일성 검사 구현 | `scripts/check-behavior.mjs` + 사례 틀 `scripts/behavior-templates.mjs`. 샘플 문서 6종: 빈 문서, 합성 문서(API 로 글·표·각주·미주·누름틀·그림·수식·책갈피·도형을 넣음), `biz_plan.hwp`(글 위주 93문단·표), `143E433F503322BD33.hwp`(도형·책갈피·각주·표·머리말), `exam_social-p1.hwp`(표 18·도형 7), `footnote-01.hwp`(각주 9). 사례 생성: 인자 이름 + Rust 시그니처의 인자 형식(형식이 틀린 값은 바인딩에서 메모리 오류를 냄) + 문서 상태(`getControls`·표 칸·누름틀)로 무작위 인자를 만들어 **문서를 바꾼 성공 호출**만 사례로 둔다. Ex 변형의 옵션 키는 Rust 소스의 `json_*(options_json, "키")` 에서 읽는다. 손으로 쓴 틀 24종(준비 단계로 개체를 만들고 그 번호로 부르는 삭제·속성 바꾸기, 머리말·꼬리말, 누름틀, 하이퍼링크, 각주 문단 합치기 등). 잘못된 인자에 기능이 패닉하면(WASM trap) 엔진 인스턴스를 새로 만든다. 차분 비교는 양쪽 결과를 새 엔진으로 다시 읽은 digest·성공 여부·문단 수. 재생 가능성 축: 내부·전치 클립보드, 스냅샷 저장소, active_field(ctx 기능 제외), 조판 미룸(layout 기능 제외, 비교 전 양쪽 flush). 결과는 `catalog-drift.json` 의 `downgraded` → gen-catalog. `build-wasm.sh` 가 기본 빌드를 `.tools/engine-builds/<rev>/` 에 보관하고, 다른 rev 의 보관 빌드가 있으면(업스트림을 올린 뒤 첫 빌드) 검사를 자동으로 돌린다. 정규 시험 `behavior.test.mjs`(고른 8기능, 같은 빌드 → 같음) |
| 2026-11-26 | **R1b 시험 (1)(2)(3)** | (1) 같은 빌드끼리(`op` 232): **같음 155**, 다름 2(`insertMemo`·`insertMemoByPath`), 재생 가능성 깨짐 0, 사례 없음 75. 같은 빌드인데 다른 메모 넣기는 실제 숨은 입력이다 — 메모 필드를 만들 때 지금 시각(`crate::model::memo_time::now()`)을 쓴다(R1 감사의 "시각 없음"이 틀렸음, 검사가 잡음). (2) 시험용 패치로 `renameBookmark` 가 이름 끝에 `_v2` 를 붙이게 바꾼 빌드와 비교 → **그 기능만 새로 "다름"**. (3) 같은 시험 빌드에서 `addBookmark` 가 내부 클립보드 글자를 이름에 붙이게 함 → 차분 비교는 "같음"(양쪽 클립보드가 비어 있음), **재생 가능성 클립보드 축이 잡음**. 시험 빌드는 `pkg-r1btest` 로 따로 만들었고, 업스트림 파일은 원본 사본으로 되돌린 뒤 SHA-256 일치 확인, 시험 빌드는 지움 |
| 2026-11-26 | R1b 반영 (분류표 갱신) | `op` 232 → **155**, `state` 12 → **89**(+77: 메모 2 + 사례 없음 75). 사례 없음은 대부분 특수 개체·커서 기반 기능: 차트 데이터, 메모(답글·삭제·글·모양), 양식 개체 값, 덧말·글자 겹치기·조합 개체, 바탕쪽, OLE 수식, 연결선, 서식 틀 연산, 외부 그림 주입, `*AtCursor`·목록 기반(`breakAtCursor`·`setControlZOrderAt` 등), 각주·미주 모양, 셀 안 그림·도형, 표 계산식 등. 손으로 틀을 쓰면 `op` 로 올라간다. 엔진 지문(분류표 해시)이 바뀜. collab-client 시험 23/23 |
| 2026-11-26 | R13-1 셀 텍스트 연산 → text | 셀 입력·삭제·바꾸기·나눔·합침·범위 삭제(평면·`ByPath`·`Ex`·조판 미룸) 14종을 `text` 로. 셀 공간을 중첩 가능하게 일반화(`Space::Cell { hosts, chain }` — `hosts[0]` 바깥 표를 품은 본문 문단, `hosts[k]` k 단계 표를 품은 바깥 칸 문단). 같은 칸끼리는 §4.4 규칙, 다른 칸·다른 표는 무관, 바깥 공간의 연산은 안쪽 공간의 `hosts` 자리를 문단 번호처럼 옮기고 구조적으로 건드리면 충돌. 경로 형식 해석·내보내기(중첩이면 `*ByPath`, 원래 기록이 조판 미룸 변형이면 그대로). Rust `measure` 가 셀 문단 길이·수로 meta(len·count·deleted/insLen·prevLen)를 실측. 시험: 같은 칸 보정·다른 칸 독립·앞 Enter 로 부모 문단 밀림·중첩 경로 왕복·바깥 칸 나눔이 안쪽 표 문단을 밂·셀 meta 실측 |
| 2026-11-26 | R13-2 구조 편집의 발자국 | 분류표에 구조 연산 60종의 `anchor` 를 감사해 적음: 개체 단위(문단+개체) 16 — 표 행·열 넣기/지우기, 칸 합치기/나누기, 행렬 바꿈, 그림·도형 속성, 칸 안 HTML·누름틀, 각주 안 글 편집; 문단 단위 30 — 표·그림·수식·각주·미주·누름틀·책갈피 넣기, 쪽·단 나누기, 문단 넣기/지우기, HTML 붙여넣기, 개체 지우기(뒤 개체 번호가 밀림), 표 나누기/다음 표와 합치기, 범위 지우기 등. 발자국 없음(구역 단위로 남김, 근거): 기준이 옵션 JSON 안(`*Ex`·`createShapeControl`), 커서·목록 좌표(`*AtCursor`·`*ControlAt`), 머리말·꼬리말, 스타일·번호·글꼴, 모두 바꾸기, 구역 나누기. 엔진이 기록 때 그 구역의 문단 수 변화 `pd` 를 잰다. 판정: 상대가 발자국 안이면 충돌, 밖이면 범용 지도(기준 뒤 문단을 `pd` 만큼 밈). 개체 단위 발자국은 그 개체(그 표의 칸 편집)와 그 문단을 나누거나 합치는 편집만 겹친다 |
| 2026-11-26 | R13-3 꼬리 살리기 | 버린 미확정의 되돌림 열(텍스트 연산의 역 — 삽입↔삭제·나눔↔합침·바꾸기 역, 구조 연산은 `pd` 반대로 미는 발자국)을 원래 좌표에서 유지하고 뒤 미확정을 그 뒤로 옮긴다. 되돌린 연산이 만든 자리(넣은 글자·만든 문단) 안이면 함께 버린다. 되돌릴 수 없는 것(state·발자국 없는 구조·여러 문단 삭제)을 버리면 그 뒤는 모두 버린다. 결과에 버린 인덱스 목록(`dropped`) |
| 2026-11-26 | R13-4 붙여넣기 → op (`ctx.clipboard`) | `pasteInternal`·`pasteInternalInCell`·`pasteInternalInCellByPath`·`pasteInternalTextLogical`·`pasteControl` 을 op 로(발자국 포함). 내부 클립보드(`ClipboardData`: 문단 목록·평문·표 재조판 표시)와 `paste_cascade_count` 를 `ctx.clipboard` 로 담는다 — 모델 타입은 역직렬화가 없으므로 문단 목록을 HWP 문단 레코드로 직렬화(`serialize_paragraph_list` ↔ `parse_paragraph_list`). 기록하는 쪽은 클립보드를 직렬화→다시 읽은 값으로 바꾼 뒤 붙인다(받는 쪽과 같은 값, state 자기 적재와 같은 이유). 재생은 기록의 클립보드로 잠시 바꾸고(`collabPushClipboard`) 되돌린다(`collabPopClipboard`). 전치 붙여넣기 2종은 `TableTransposeData` 직렬화 경로가 없어 state 로 남김(근거 기재). 시험: 보낸 쪽·받는 쪽 붙여넣기 결과 digest 동일, 받는 쪽 클립보드 원래대로 |
| 2026-11-26 | R13 중 발견·수정 | ① 현실 시뮬레이션이 캐럿을 원격 지도로 옮기지 않아 참여자가 남의 문단으로 떠밀려 충돌이 부풀었다 — 플러그인처럼 `receiveRemote` 에 캐럿을 넘기고 옮긴 값을 쓰게 고침. ② 셀 안 편집으로 구조 연산의 본문 기준 문단을 옮기던 오류(셀 공간 연산에 본문 `map_para` 를 씀). ③ **한 문단 안 `deleteRange` 는 그 범위의 표 같은 개체도 지운다**(실제 WASM 으로 확인 — `deleteText` 는 글자만). `TOp::Del` 에 `objects` 표시를 더해 그 문단을 구조적으로 건드린 것으로 보고(칸 편집·개체 기준·발자국과 충돌), 옮겨도 deleteRange 로 내보내며, 빠른 경로에서는 뒤 문단 끝까지로 본다 |
| 2026-11-26 | **R13 관문** | **R9 현실 조건 + 셀 입력**(`sim.mjs --realistic --verify-fast`, 시드 100 × 편집 300, 3명, 입력의 30% 를 공유 3×3 표의 칸 안에서, 표 만들기 225·붙여넣기 211 포함): **전체 버림 비율 0.01%**(편집 30,000 중 4건, 버림 사건 1건 — 발자국 겹침), 수렴 실패 0, 빠른 경로 불일치 0, 재적용 실패 0, 빠른 경로 41%. (R13 전 같은 조건은 셀 입력 없이도 text 17.6%.) **R5 재통과**(시드 500 × 200, 빠른 경로 켬 + 검증): 수렴 실패 0, 빠른 경로 불일치 0. 고밀도 충돌률 text 17.93%·neutral 15.12%·structural 62.36%(R13 전 30.60/29.47/73.73), 버림 사건 6,371. **R11 재통과**(text·neutral, 셀 입력·나눔·합침 포함): 불일치 0, 수렴 실패 0, 충돌률 text 2.78%·neutral 6.76%(R13 전 11.99/15.06) |
| 2026-11-26 | R13 뒤 셀 연산 재적용 실패 다시 셈 | R11 고밀도: **45건**(R13 전 16건 — 꼬리가 살아 다시 적용되는 연산이 늘어난 몫), R5: 10건(전 2건), 현실 조건: **0건**. 남은 것은 셀 서식·셀 범위 삭제·셀 입력이 그 사이 다른 편집으로 바뀐 개체 번호·칸 위치를 가리키는 경우(대부분 같은 표에 몰아 쓰는 고밀도 설정). 취소·알림으로 처리되고 수렴은 유지. 알려진 한계로 둔다 |
| 2026-11-26 | R14 사례 없는 기능 줄이기 | 분류표에 `reach` 를 더함(gen-catalog 가 studio 소스를 훑어 정함, 주석 속 언급 제외): **studio** 197 — 메뉴·도구·단축키 경로(command·engine·ui·view·core 등)에서 부름 / **plugin** 26 — 플러그인·hwpctl·AI·자동화 경로나 다리에서만 / **none** 91 — studio 가 부르지 않음. 사례 틀 15종 추가: 각주·미주 모양, 도형 겹침 순서, 도형 묶기·풀기(준비: 도형 둘), 선 끝점 옮기기(준비: 선), 글자 모양 구간(본문·셀), 수식 속성, 칸 나누기(준비: 칸 합치기), 셀 안 그림 지우기·속성(준비: 셀 안 그림), 그림 바꾸기, 떠 있는 그림 옮기기, 양식 개체 값(샘플 `form-01.hwp` 추가) + R13 붙여넣기 5종(준비: 복사). check-behavior 는 지난 검사가 내린 기능도 다시 본다. **결과: op 160 → 175, 사례 없음 75 → 60.** studio 로 닿는 사례 없음 28 → **13** |
| 2026-11-26 | R14 남은 studio 기능 13 (근거) | state 가 맞음 1: `removeBorderFillTails` — 되돌리기 전용, 공동편집 중에는 되돌리기가 멈춰 불리지 않음(덮어쓰기에 근거 기재). 사례를 만들 문서·API 가 없음 12(동작 동일성 검사의 "사례 부족" 으로 state, 샘플이 생기면 검사가 다시 본다): `setChartData`·`setChartDataByIndex`(차트가 든 샘플 없음), `promoteOleEquation`(OLE 수식 샘플 없음 — 143E 의 OLE 는 수식이 아님), `pasteHwpJson`(한컴 클립보드 문서모델 표본 없음 — rhwp 에 만드는 쪽이 없음), `setHeaderFooterPictureProperties`(머리말 안 그림을 넣는 API·샘플 없음), `setNoteEquationProperties`(각주 안 수식을 넣는 API 없음), `deleteCellShapeControlByPath`·`setCellShapePropertiesByPath`(셀 안 도형을 만드는 API·샘플 없음), `setFormValueInCell`(셀 안 양식 개체 샘플 없음), `updateConnectorsInSection`(연결선 샘플 없음), `ensureDefaultNumbering`(멱등 — 샘플마다 기본 번호가 이미 있어 문서를 바꾸지 않음, 처음 한 번만 바뀜), `applyFormActionUpdates`(양식 단추 동작 계획 JSON 을 studio 양식 상태에서 만들어 자동 생성 불가) |
| 2026-11-26 | R14 나머지 (plugin 3 · none 43) | plugin: `convertToEditable`·`injectExternalImage`·`removeFieldAtInCell`. none: 덧말·글자 겹치기·조합 개체 계열 12, 메모 부속 4, 바탕쪽 2, `*AtCursor`·목록 기반 9(`breakAtCursor`·`tableEditAtCursor` 등), 캡션 붙이기/떼기, 셀 안 표 지우기, 표 계산식 3, 구역 합치기, 개체 옮기기, `*Ex` 4 등 — 목록은 `catalog-drift.json` 의 `downgraded`. collab-client 시험 23/23 |
| 2026-11-26 | R10 다른 사람 커서 | 서버: `cursor {seq, caret}` 를 다른 참여자에게만 중계(저장 없음, 참여자마다 초당 20회), 나가면 `cursor-leave` — 시험 12/12. studio API(0002 패치, 설계 결정대로): `host.caretRect(PluginCaret)` — 스크롤 내용 기준 `{left, top, height}`, studio 캐럿과 같은 계산(입력 처리기 `caretRectFor`: 본문 `getCursorRect`·셀 `getCursorRectInCell`·중첩 `getCursorRectByPath` + 캐럿 배치기 `toContentRect` — 쪽 위치·쪽 왼쪽·줌·자르기), `host.overlayLayer()` — 스크롤 내용 안 겹침 층(포인터 없음, 캐럿 z 10 위·대화상자 아래), 플러그인마다 자기 층이고 unload 때 원장이 걷음, 이벤트 `view-changed` = 줌·쪽 보기 설정·창 크기·조판 갱신(스크롤 제외). studio 시험 +4(21/21). 플러그인: 150ms 마다 내 캐럿이 바뀌었으면 텍스트 좌표로 보냄(머리말·꼬리말·각주 안은 숨김만), 받은 캐럿은 엔진 `mapCaret` 으로 이후 원격·내 편집 지도만큼 옮기고, 그리기 직전에 논리 좌표로 바꿔 `caretRect` 로 이름표 달린 색 막대를 그림(편집 반영·`view-changed` 때 다시 계산) |
| 2026-11-26 | R10 브라우저 `collab-client/e2e/r10-cursors.mjs` | **6/6**: A 의 캐럿이 B 에 전달, B 의 막대가 B 의 studio 캐럿을 같은 위치에 놓았을 때와 **같은 좌표**(left·top·height 일치), B 가 그 앞에 친 만큼 A 의 커서가 밀림(5 → 8)·막대도 그 자리, 줌 뒤 다시 계산해 같은 자리, 다른 문단으로 옮긴 캐럿도 같은 자리, A 가 나가면 사라짐. 회귀: R8 22/22, T4 29/29, collab-client 23/23 |
| 2026-11-26 | R14 후속: 업스트림 샘플 | 업스트림 `samples/`(2,233개) 목록을 이름으로만 보고(`git ls-tree --name-only`, 내려받지 않음) 필요한 디렉터리 8개를 희소 경로에 더함(`upstream.lock` 의 `sparse=` → `bootstrap.sh` 가 읽음): `samples/chart/가로막대형`, `samples/hwpjson`, `samples/issue5725`(OLE 수식), `samples/issue6179`(꼬리말 그림), `samples/issue7235`(머리말 로고), `samples/basic`(BlogForm — 칸 안 도형), `samples/issue5721`·`samples/issue6173`(글상자). 업스트림 샘플은 우리 저장소에 복사·커밋하지 않고 업스트림 체크아웃에서 참조만 한다. 사례 틀 7종 추가(`pasteHwpJson` — `samples/hwpjson/clipboard-model.json`, 칸 안 도형 속성·지우기 — 읽기 API 로 칸을 훑어 찾음, 차트 데이터 2, 머리말·꼬리말 그림 속성, 각주 문단 나누기 — 문서가 늘어 일반 생성이 덜 닿게 된 것). **결과: op 175 → 180, 사례 없음 60 → 54, studio 로 닿는 사례 없음 13 → 8(+ state 근거 1)** |
| 2026-11-26 | R14 남은 studio 기능 8 | 찾지 못한 것: `setNoteEquationProperties`(각주 안 수식 — 샘플·넣는 API 없음), `updateConnectorsInSection`(연결선 샘플 없음), `setFormValueInCell`(칸 안 양식 개체 샘플 없음). 샘플은 찾았으나 사례가 안 되는 것: `promoteOleEquation`(issue5725 의 OLE 수식은 표 칸 안 — 이 API 는 본문 개체만 받음), `setHeaderFooterPictureProperties`(issue6179 꼬리말 그림이 머리말·꼬리말 문단의 다른 목록 안에 있어 번호가 맞지 않음), `setChartDataByIndex`(아래 발견). 사례를 자동으로 만들 수 없는 것: `ensureDefaultNumbering`(멱등 — 모든 샘플에 기본 번호가 이미 있음), `applyFormActionUpdates`(양식 단추 동작 계획 JSON 을 studio 양식 상태에서 만듦). state 근거 1: `removeBorderFillTails` |
| 2026-11-26 | **발견: digest 가 BinData 내용을 보지 않는다** | 차트 데이터 바꾸기(`setChartDataByIndex`)는 성공하지만 digest 가 그대로였다 — 차트 값은 BinData(OLE 안 차트 부분)에 있고, digest(`doc_info_model_digest` + 구역 모델)는 BinData 목록 메타만 담고 내용(그림·OLE·차트 바이트)은 담지 않는다. 그래서 동작 동일성 검사가 "문서를 바꾼 호출" 로 세지 못했고, 실사용에서도 BinData 만 갈리면 digest 보고가 잡지 못한다(같은 기록을 같은 순서로 재생하므로 보통은 갈리지 않음). 설계 결정 대상으로 올림(마무리 요약) |
