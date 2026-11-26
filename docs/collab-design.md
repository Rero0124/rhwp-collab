# cc-rhwp 공동편집 설계 (PoC 1단계)

rhwp(업스트림 `edwardkim/rhwp`)를 부품으로 써서 HWP 공동편집을 만든다. 이 문서는 설계 기준이자
코드 세션 인계 문서다. **설계 변경은 이 문서를 먼저 고친다.**

## 1. 목표와 범위

PoC 1단계의 목표는 **결정성 검증**이다. 같은 연산을 같은 순서로 적용하면 두 클라이언트 문서가
같아지는지 확인한다.

| 포함 | 제외 (다음 단계) |
|---|---|
| 웹(studio) 클라이언트 | 네이티브 앱, 서버 정본(Rust) |
| 본문 텍스트 편집 6종 (아래 §4) | 표·개체·서식·붙여넣기 등 나머지 편집 |
| **번갈아 편집**(turn-taking) | 동시 편집 보정(OT·rebase) |
| 충돌 **감지**와 경고 | 충돌 **해결** |
| 중계 서버(Node) | 권한·인증·영속 저장 |

## 2. 구조

```
studio(TS) ─▶ WasmBridge ─▶ HwpDocument (업스트림 WASM export)
                                │ Deref
                                ▼
                    ┌─ CollabCore (우리 코드) ─────────────┐
                    │ ① 실제 코어에 적용 → 결과            │
                    │ ② 성공한 편집만 outbox 에 기록        │
                    │ ③ 원격 연산은 실제 코어에 직접 적용   │
                    └──────┬───────────────────▲──────────┘
                           │ Deref             │ collabApplyRemoteOps
                           ▼                   │ collabTakePendingOps
                     DocumentCore        studio 플러그인 (JS, 통신 담당)
                     (업스트림)                │ WebSocket
                                               ▼
                                         중계 서버 (Node)
```

결정 사항과 이유:

- **CRDT(Yjs 등) 미사용.** HWP IR 을 CRDT 로 미러링하면 진실 원천이 둘이 되고 비용이 크다.
  서버가 순서를 정하는 연산 로그 방식으로 간다.
- **프록시는 코어 바로 위(`CollabCore`).** 업스트림 `HwpDocument` 가 이미 `Deref<Target=DocumentCore>`
  구조라, 필드 타입만 바꾸면 끼워 넣을 수 있다. 같은 코드를 나중에 네이티브(`NativeEditor`)와
  서버가 공유한다.
- **통신은 코어 밖.** WASM 안에서 통신하면 비동기가 엉키고 코어가 브라우저에 묶인다. 코어는
  outbox 에 쌓기만 하고 호스트가 보낸다.
- **연산 = 코어 메서드 이름 + 인자.** 연산 층 위치를 옮겨도 프로토콜은 그대로다.

## 3. 저장소 구성

```
cc-rhwp/
  upstream.lock                  업스트림 repo·커밋·희소 경로 고정 (key=value)
  upstream/rhwp/                 업스트림 체크아웃 (gitignore, 부분·희소·얕은 클론)
  patches/rhwp/0001-collab-core-hook.patch     업스트림 최소 패치 (Rust)
  patches/rhwp/0002-studio-collab-plugin.patch studio 플러그인 등록·API 확장 (main.ts·vite.config.ts·tsconfig.json·
                                 plugin/types.ts·plugin/host.ts·tests/plugin-autosave-suspend.test.ts)
  collab-core/src/lib.rs         CollabCore, Op
  collab-core/src/wasm.rs        JS 표면 (HwpDocument 에 메서드 추가)
  collab-core/src/tests.rs       라우팅·결정성·감지 테스트
  collab-client/src/plugin.ts    studio 플러그인 (§6)
  collab-client/e2e/t4-two-tabs.mjs  T4 브라우저 검증 드라이버 (headless Chrome 두 탭, studio 의 puppeteer-core 사용)
  server/                        중계 서버 (Node + ws, §5). `npm test` 로 프로토콜 테스트
  scripts/bootstrap.sh           upstream.lock 대로 클론·checkout·패치 적용 (멱등)
  scripts/build-wasm.sh          WASM 빌드 → upstream/rhwp/pkg/
  scripts/update-patch.sh        업스트림 작업 트리 diff → 패치 파일 (패치가 만드는 새 파일은 intent-to-add 로 포함)
  .tools/bin/wasm-pack           0.15.0, 프로젝트 로컬 설치 (gitignore)
  target/                        공용 CARGO_TARGET_DIR (gitignore)
  docs/collab-design.md          이 문서
```

처음 받는 순서: `scripts/bootstrap.sh` → `scripts/build-wasm.sh` → `(cd upstream/rhwp/rhwp-studio && npm ci)`
→ `(cd server && npm ci)`. 실행: `node server/server.mjs` (8787) + `(cd upstream/rhwp/rhwp-studio && npx vite)`
(7700) → `http://127.0.0.1:7700/?collab=ws://127.0.0.1:8787&room=demo&name=A`.

### 업스트림 관리

- 업스트림 전체는 4GB+ 이므로 `--filter=blob:none --sparse --depth 1` 부분 클론(받는 양 약 430MB).
  희소 경로의 정본은 `upstream.lock` 의 `sparse=` 줄이다. 현재:
  `src crates tools bindings rhwp-studio rhwp-shared npm scripts typescript ttfs data vendor saved
  assets mydocs/manual mydocs/tech/agent_roadmap mydocs/tech/agent_runtime samples/hml
  samples/hwpx/ref tests/fixtures tests/common tests/support`
  (`tests/*` 는 lib 단위 테스트가 `include!`/`include_bytes!` 로 읽는다. 업스트림을 올리면
  `src` 의 컴파일 타임 include 대상이 모두 있는지 다시 확인한다.) `bootstrap.sh` 는 빠진 경로만
  `sparse-checkout add` 로 더하고, 손으로 더한 경로는 지우지 않는다.
- 패치 갱신: 업스트림 작업 트리를 고친 뒤 `scripts/update-patch.sh`. 각 패치는 자기가 다루는 파일의
  현재 diff 로 다시 쓰인다. 새 파일을 패치에 넣으려면 `scripts/update-patch.sh <패치 이름> <경로>...`.
  어느 패치에도 속하지 않은 변경이 있으면 실패한다. `rhwp-studio/public/rhwp.js` 는 업스트림이
  추적하는 빌드 산출물이라(빌드 때마다 바뀜) 제외한다.
- 업스트림 수정은 **패치 파일로만** 관리한다. `collab-core/` 는 패치가 `src/lib.rs` 에 넣은
  `#[path = "../../../collab-core/src/lib.rs"] pub mod collab;` 로 크레이트 안에 포함된다
  (크레이트 내부라서 `pub(crate)` 메서드도 가로챌 수 있다).
- 패치 내용(117줄 diff, 실질 16줄): `src/lib.rs` 모듈 선언, `src/wasm_api.rs` 의
  `core: DocumentCore` → `core: crate::collab::CollabCore`, `Deref` Target 교체,
  `HwpDocument { core }` → `{ core: core.into() }` (wasm_api.rs 5곳, pdf_request.rs 2곳).
- 툴체인: 업스트림 `rust-toolchain.toml` 이 1.93.1 고정 (rustup 자동 설치됨).

## 4. CollabCore 와 연산 (구현 완료)

가로채는 메서드 — studio 가 본문 입력 때 실제로 부르는 경로를 추적해서 골랐다:

| Op (`op` 태그) | DocumentCore 메서드 | WASM export | studio 사용처 |
|---|---|---|---|
| `insertText` | `insert_text_native` | `insertText` | 일반 삽입 |
| `insertTextAtCaret` | `insert_text_at_caret_native` (pub(crate)) | `insertTextLogical` | 개체 옆 삽입 |
| `deleteText` | `delete_text_native` | `deleteText` | 일반 삭제 |
| `replaceBodyText` | `replace_body_text_local_native` | `replaceBodyTextLocal` | **본문 입력·삭제·IME 빠른 경로 (가장 흔함)** |
| `splitParagraph` | `split_paragraph_native` | `splitParagraph` | Enter |
| `mergeParagraph` | `merge_paragraph_native` | `mergeParagraph` | 문단 처음 Backspace |
| `deleteRange` | `delete_range_native` | `deleteRange`, `deleteRangeInCell`, `deleteRangeInCellEx` | **선택 영역 삭제, 선택 위에 입력** (T7) |

JSON 예: `{"op":"replaceBodyText","section":0,"para":1,"offset":3,"deleteCount":0,"text":"가"}`

`deleteRange` 의 셀 문맥은 `cellCtx: {parentPara, control, cell} | null` 로 직렬화한다(코어 인자
`Option<(usize, usize, usize)>` 순서 그대로). 세 export 가 모두 이 메서드 한 번 호출로 끝나므로
코어에서 가로채면 본문과 평면 셀 선택 삭제가 같이 잡힌다. 중첩 셀(`deleteRangeInCellByPath`)과
`deleteRangeLogical` 은 다른 경로라 미지원이다.

**사용자별 메타데이터는 공유 상태가 아니다.** `doc_properties.caret_list_id / caret_para_id /
caret_char_pos` 는 "저장 시점 UI 캐럿"(#4180)이다. `setCaretPosition`(studio 의 `onBeforeExport`, 즉
자동 저장·저장·비교·히스토리)과 일부 편집(`replace_body_text_local_native`,
`insert_text_at_caret_native`)이 쓴다. 참여자마다 다른 값이 들어가는 게 정상이고, 연산으로 퍼뜨리지
않으며, digest(T6)에서도 뺀다. 같은 성격의 필드를 새로 찾으면 이 목록에 추가한다.

JS 표면 (`HwpDocument` 메서드):

- `collabSetRecording(on: boolean)` — 끄면 outbox 를 비운다
- `collabIsRecording(): boolean`
- `collabTakePendingOps(): string` — JSON 배열, 없으면 `"[]"`
- `collabApplyRemoteOps(json: string): string` — `{"ok":true,"applied":N}` 또는
  `{"ok":false,"applied":N,"error":"..."}`. 첫 실패에서 멈춘다. 적용 뒤 `flush_deferred_pagination()`.
- `collabTakeDesync(): boolean` — 기록 중 복원 경로가 있었는지 읽고 비운다 (T5)
- `collabDigest(): string` — 모델 지문, blake3 hex 64자 (T6)

주의:

- 위 연산 메서드는 각각 표의 export 에서만 호출된다(확인함: 6개는 export 하나씩,
  `delete_range_native` 는 `deleteRange`·`deleteRangeInCell`·`deleteRangeInCellEx` 에서 한 번씩).
  T5 의 복원 메서드 3개도 export 하나씩이다. 다른 export 가 내부에서 부르면 부분 기록 위험이
  있으니, 업스트림을 올릴 때 다시 확인한다:
  `grep -rnE 'self\.(insert_text_native|insert_text_at_caret_native|delete_text_native|replace_body_text_local_native|split_paragraph_native|merge_paragraph_native|delete_range_native|restore_snapshot_native|restore_delete_fragment_native|restore_section_raw_native)\(' src/wasm_api.rs src/wasm_api/`
- `DocumentCore` 내부에서 서로 부르는 호출은 가로채지 않는다(의도된 동작. 바깥 호출만 연산이다).

## 5. 프로토콜 (설계 확정, 미구현)

모든 메시지는 JSON. 문서는 모두 **같은 base 바이트를 파싱한 상태**에서 시작해야 한다.

```
C→S  hello   {type:"hello", room, clientId, name}
S→C  welcome {type:"welcome", seq, base: <base64>|null, log: [{seq, clientId, ops}]}
C→S  base    {type:"base", data: <base64>}          // welcome.base 가 null 인 첫 참여자만
C→S  ops     {type:"ops", base: <lastSeq>, ops: Op[]}
S→C  ops     {type:"ops", seq, clientId, ops}       // 모두에게(보낸 사람 포함 = ack)
S→C  reject  {type:"reject", seq}                   // base !== room.seq 이면 보낸 사람에게만
C→S  digest  {type:"digest", seq, digest}           // 대기 상태에서만 (§6.8)
S→C  diverged {type:"diverged", seq}                // 같은 seq 에 다른 digest 가 오면 모두에게
```

서버 규칙: `ops.base === room.seq` 일 때만 `seq += 1`, 로그에 추가, 전체 방송. 아니면 `reject`.
방(room)은 메모리에만 둔다.

digest 규칙: 방마다 `seq → 처음 보고된 digest` 를 최근 64개까지 보관한다. 같은 seq 에 다른 값이
오면 `diverged` 를 방 전체에 방송한다. 이미 지나간(보관 범위 밖) seq 보고는 무시한다.

## 6. 클라이언트(studio 플러그인) 동작 (설계 확정, 미구현)

플러그인 API(`rhwp-studio/src/plugin/types.ts`)로 붙인다. studio 패치는 허용 목록 등록만 한다.

연결: URL `?collab=ws://localhost:8787&room=demo&name=A` 이면 자동 로드.

상태: `lastSeq`, `inflight: boolean`, `desynced: boolean`, `applyingRemote: boolean`

1. **시작.** `hello` 전송.
2. **welcome.**
   - `base === null` (첫 참여자): 현재 문서가 없으면 `host.createBlankDocument()`.
     `host.read(d => d.exportHwp())` 로 바이트를 얻어 `base` 전송. 그다음 **자기도 같은 바이트로
     `host.loadDocument(bytes)` 를 다시 연다** (내보내기→다시 읽기가 항등이라는 보장이 없으므로,
     모두가 같은 파싱 결과에서 출발하게 한다).
   - `base` 있음: `host.loadDocument(base)` 후 `log` 의 연산을 한 번의 트랜잭션으로 적용,
     `lastSeq = welcome.seq`.
   - **공동편집용 열기는 대화상자 없이.** 위 두 `loadDocument` 는 `{ suppressDialogs: true }` 로
     부른다. 기본 열기 경로(`loadBytes`)는 "로컬 글꼴 감지" 모달을 띄우고 닫힐 때까지 끝나지 않으며,
     참여자마다 다른 선택을 하면 글꼴 → 줄 배치 → digest 가 갈린다. 플러그인 API 에는 이 옵션이
     없으므로 0002 패치로 넓힌다: `PluginHost.loadDocument(bytes, fileName?, options?: { suppressDialogs?: boolean })`
     (`plugin/types.ts`), facade 전달(`plugin/host.ts`), `main.ts` deps 에서
     `loadBytes(bytes, name, null, undefined, { suppressDialogs })`. 기본값은 지금과 같다(다른
     플러그인 동작 불변).
3. **기록 켜기.** `host.onDocumentSwap(lease => lease.handle.collabSetRecording(true))` 와 현재
   문서에도 켠다. 문서가 바뀌면(swap) 새 핸들은 기록이 꺼진 상태이기 때문이다.
4. **로컬 편집 → 전송.** `document-mutated` 와 `document-changed` **둘 다**에 `flush` 를 건다.
   - 이유: `afterPageLocalEdit`(`input-handler.ts:3572`)는 미뤄 둔 조판이 있는 상태의 본문 빠른
     경로 편집에서 `document-mutated` 만 내고 `document-changed` 는 idle 조판 flush 때 낸다.
     `document-changed` 만 구독하면 타이핑 연산이 조판이 끝날 때까지 묶인다.
   - `flush` 는 멱등이다(outbox 가 비면 아무것도 안 함). 중복 호출은 허용한다.
   - `flush`: `applyingRemote` 거나 `inflight` 거나 `desynced` 면 건너뜀. 아니면 먼저
     `collabTakeDesync()` 를 확인해 참이면 `desynced = true` 후 종료(§7 T5). 이어서
     `ops = JSON.parse(host.read(d => d.collabTakePendingOps()))`, 비어 있지 않으면
     `{type:"ops", base:lastSeq, ops}` 전송, `inflight = true`.
5. **ops 수신.**
   - 내 `clientId`: `lastSeq = seq`, `inflight = false`, 다시 `flush()`.
   - 남의 것: 먼저 `collabTakePendingOps()` 로 outbox 를 꺼내 본다. `inflight` 거나 꺼낸 연산이
     있으면 → 순서가 이미 갈렸다 → `desynced = true` (PoC 는 감지만). 아니면
     `applyingRemote = true` 를 세우고 `host.transaction('collab:remote', tx => tx.doc().collabApplyRemoteOps(json))`,
     **`finally` 에서 `applyingRemote = false`**. 트랜잭션 안에서 동기로 나오는 `document-mutated`
     는 이 가드로 걸러진다. 결과 `ok:false` 면 `desynced = true`. `lastSeq = seq`.
6. **reject / diverged 수신.** `desynced = true`.
7. **desynced.** 화면에 "동기화가 깨졌습니다. 새로고침하세요" 배너(플러그인 사이드 패널이나 고정
   div). 이후 전송 중단.
8. **digest 보고.** `lastSeq` 가 바뀐 뒤 대기 상태(`inflight` 아님, outbox 비었음, `desynced` 아님)가
   되면 `{type:"digest", seq:lastSeq, digest: collabDigest()}` 를 보낸다. 최소 1초 간격으로 묶고
   마지막 변경 뒤 한 번은 반드시 보낸다(trailing). 같은 seq 는 한 번만 보낸다.
9. **로컬 초안과 복구.** 공동편집 문서의 정본은 공유 로그(서버)다. 로컬 자동 저장 초안은 복구하면
   공유 로그 밖의 갈래가 되므로 만들지 않는다. 두 가지를 함께 한다.
   - **(a) 초안 쓰기 중지.** 플러그인은 활성화 직후(첫 `loadDocument` 전) `host.suspendAutosave()`
     를 불러 공동편집 동안 초안을 쓰지 않는다. 반환된 해제 함수는 원장에 담겨 unload 때 회수된다.
   - **(b) 시작 시 복구 확인 생략.** URL 에 `collab` 이 있으면 studio 시작 시 "문서 복구" 모달을
     띄우지 않는다. 업스트림이 `?url=` 로 열 때 이미 같은 이유로 건너뛰는 것과 같은 규칙이다
     (`shouldSkipInitialAutosaveRecovery`). 일반 편집에서 남은 초안은 지우지 않고 그대로 둔다 —
     다음에 일반 모드로 열면 평소처럼 복구할 수 있다.
   - (a)만으로는 부족하다: 일반 문서 편집에서 남은 초안도 공동편집 시작을 막는다. (b)만으로도
     부족하다: 공동편집 사본이 초안으로 계속 쌓이고, 일반 모드에서 복구하면 혼란스러운 갈래가 된다.

원격 적용에 `transaction` 을 쓰는 이유: studio 의 화면 갱신·조판 경로를 그대로 타기 위해서다.
부작용으로 undo 항목이 생긴다(§8).

## 7. 남은 작업 (코드 세션)

순서대로. 각 항목의 완료 기준을 지킨다.

- **T0. 테스트 통과 확인.**
  `cd upstream/rhwp && CARGO_TARGET_DIR=../../target cargo test -p rhwp --lib --locked collab::`
  5개 테스트 통과가 기준. 직전 실행은 희소 체크아웃에 `tests/fixtures`, `tests/common` 이 없어
  컴파일 단계에서 실패했고, 지금은 추가해 둠. **테스트는 아직 한 번도 통과 확인되지 않았다.**
  특히 `replaying_ops_converges_to_identical_document` 의 HWP 바이트 비교가 핵심. 내보내기에
  시각 등 비결정 요소가 있어 실패하면, 원인을 확인하고 이 문서 §9 에 기록한 뒤 비교 기준을
  조정한다(무작정 텍스트 비교로 낮추지 말 것).
- **T1. 스크립트.**
  - `scripts/bootstrap.sh`: `upstream.lock` 을 읽어 §3 희소 경로로 부분 클론 → 해당 커밋
    checkout → `patches/rhwp/*.patch` 적용(이미 적용됐으면 건너뜀: `git apply --reverse --check`).
    작업 트리가 더러우면 checkout 하지 말고 멈춘다.
  - `scripts/build-wasm.sh`: `PATH=.tools/bin:$PATH` 로 업스트림 `scripts/wasm-pack-locked.sh --target web`
    실행. 산출물은 업스트림 `pkg/` (studio vite 가 `../pkg/rhwp.js` 를 읽음).
  - `scripts/update-patch.sh`: 업스트림 작업 트리의 `git diff` 를 패치 파일로 다시 쓴다.
- **T2. 중계 서버** `server/` (Node + `ws`). §5 그대로. 포트 8787. 로그에 방·seq·연산 수 출력.
- **T3. studio 플러그인** `collab-client/src/plugin.ts` 에 §6 구현. studio 쪽 변경은 패치
  `patches/rhwp/0002-studio-collab-plugin.patch` 로:
  - `rhwp-studio/src/main.ts` 의 `resolvePlugin` 에 `id === 'collab'` 분기
    (`await import('@cc-rhwp/collab-plugin')`)
  - URL 에 `collab` 파라미터가 있으면 초기화 뒤 `plugins.load('collab')`
  - `rhwp-studio/vite.config.ts`: alias `@cc-rhwp/collab-plugin` → `../../../collab-client/src/plugin.ts`,
    `server.fs.allow` 에 `collab-client` 경로 추가
  - 플러그인은 studio 를 import 하지 않는다(타입만 `import type`). 계약은 `plugin/types.ts` 참고.
- **T4. 브라우저 검증.** 서버 + studio dev 서버, 탭 두 개(`name=A`, `name=B`, 같은 `room`).
  번갈아 입력·Enter·Backspace·선택 삭제·선택 위 입력·한글 IME 입력 후 비교한다. 늦게 들어온
  탭(로그 재생)도 확인. 결과를 §9 에 기록.
  - **1차 기준은 digest(T6)** 다. 서버 로그의 `diverged` 유무와 콘솔 `collabDigest()` 로 본다.
  - 바이트 비교는 보조. `WasmBridge.exportHwp()` 는 `onBeforeExport` 로 UI 캐럿을 먼저 써 넣으므로
    쓰지 않는다. 플러그인 문서 핸들로 두 탭 모두 캐럿을 같은 값으로 맞춘 뒤 내보낸다:
    `d.setCaretPosition(0, 0, 0); d.exportHwp()` (raw 핸들의 `exportHwp` 는 `onBeforeExport` 를 타지
    않는다). 검증용 조작이므로 콘솔에서만 쓴다.
  - **자동 저장(편집 뒤 10초 idle)이 돈 뒤**에 Enter·문단 처음 Backspace 를 하고 digest 가 여전히
    같은지 꼭 확인한다(캐럿 제외가 제대로 됐는지 보는 항목).
- **T5. 복원 경로 감지.** 기록되지 않는 복원 export 가 세 개 있다. `CollabCore` 에서 셋 다
  같은 이름으로 가로채 실제 코어로 넘기고, 기록 중이고 성공했으면 `desync` 플래그를 세운다.
  - `restore_snapshot_native` (`restoreSnapshot`: 스냅샷 undo/redo, 원격 트랜잭션 undo)
  - `restore_delete_fragment_native` (`restoreDeleteFragment`: 선택 삭제·덮어쓰기 입력의 undo)
  - `restore_section_raw_native` (`restoreSectionRaw`: 구역 속성 undo)
  - JS 표면 `collabTakeDesync(): boolean` (읽으면 비움). 단위 테스트로 세 경로 모두 확인.
  - ~~플러그인 쪽 "변경 이벤트는 있는데 기록 없음" 경고~~ → **폐기.** `document-changed` 는
    조판 flush·셀 넘침·document-agent 렌더에서도, `document-mutated` 는 재개형 조판 완료에서도
    나와 편집 신호로 쓸 수 없다(`input-handler.ts:3490/3609/3688/3725`). 일반 감지는 T6 이 맡는다.
- **T6. digest 수렴 검사 (일반 안전망).** 원인과 상관없이 어긋남 자체를 잡는다. 미지원 편집,
  비결정성, 우리 버그 모두 여기서 걸린다.
  - `CollabCore::digest() -> String`: `doc_info_model_digest(&doc.doc_info, &props)` 와
    구역마다 `section_model_digest(section)` 를 이어 붙여 `bytes_digest` 로 한 번 더 해시, hex.
    (둘 다 `src/model/raw_provenance.rs` 에 있다. raw 캐시 필드는 이미 빠져 있다.)
    여기서 `props` 는 `doc.doc_properties` 를 복제해 **캐럿 세 필드를 0 으로 둔 것**이다(§4
    사용자별 메타데이터). JS 표면 `collabDigest(): string`.
  - 단위 테스트 추가: 한쪽에서만 `setCaretPosition` 에 해당하는 캐럿 기록을 바꿔도 digest 가 같다.
  - 점검 추가: `onBeforeExport`·자동 저장·저장·비교·히스토리 경로가 캐럿 말고도 모델(문서 속성,
    요약 정보, 저장 시각·작성자 등)을 쓰는지 확인한다. 있으면 §4 사용자별 메타데이터 목록에 올리고
    같은 방식으로 digest 에서 뺄지 설계 세션과 정한다.
  - 단위 테스트: 수렴 테스트 끝에 두 쪽 digest 가 같다. 한쪽에만 가로채지 않은 편집을
    `inner` 에 직접 가하면 digest 가 달라진다.
  - 서버·플러그인은 §5 digest 규칙, §6.8 대로.
  - T4 에서 확인: 편집 후 두 탭 digest 가 같고, 한 탭에서 굵게 같은 미지원 편집을 하면
    `diverged` 가 방송된다. **편집 없이 가만히 둬도 digest 가 바뀌면**(idle 조판이 모델을 고치는
    경우) 비교 기준이 흔들린다는 뜻이니 우회하지 말고 설계 세션에 보고한다.
  - 한계: 모델에 `line_segs`(글꼴 측정 기반 줄 배치)가 들어 있어 같은 글꼴 환경끼리만 유효하다.
    기기 간 비교용 조판 독립 지문은 2단계.
- **T7. 선택 삭제 가로채기.** §4 표의 `deleteRange` 를 `CollabCore` 에 추가한다
  (`delete_range_native`, 셀 문맥 포함). 단위 테스트: 본문 여러 문단 걸친 삭제와 평면 셀 안 삭제가
  재생 후 수렴한다. §4 의 호출처 점검 grep 에 `delete_range_native` 를 추가한다. T4 전에 넣는다.
- **플러그인: 예상하지 않은 문서 교체 → desynced.** welcome 처리 이후 우리가 일으키지 않은
  `onDocumentSwap`(다른 파일 열기·새 문서·복구)은 공유 로그 밖 문서로 바뀐 것이므로 desynced 로
  처리한다. welcome 처리 중 우리가 부르는 `loadDocument`·`createBlankDocument` 는 플래그로 구분한다.
- **T8. 로컬 초안·복구 (§6.9).** 0002 패치로:
  - `PluginHost.suspendAutosave(): () => void` 추가(`plugin/types.ts`). facade 는 해제 함수를
    원장(`PluginLedger`)에 담아 unload 때 회수한다(`plugin/host.ts`). `main.ts` deps 는 플러그인별
    중지 집합을 들고, `AutosaveManager` 의 `isRecoveryBlocked` 에 "중지 집합이 비지 않음"을 OR 로
    더한다. 이 경로는 차단되면 현재 초안을 버리므로(`autosave-manager.ts` 의 `recovery-blocked`),
    중지 전에 써진 초안도 정리된다.
  - **상태 문구 (결정).** 확인 결과 차단 시 `handleAutosaveStatus`(`main.ts:487`)가 암호 문서용
    "보호 문서는 복구용 자동 저장을 하지 않습니다"를 10초 idle 마다 띄운다. 처리:
    - `main.ts` 만 고친다(`autosave-manager.ts` 는 그대로). `blocked` 이면서 중지 집합이 비어 있지
      않고 **암호 차단은 아닐 때**는 아무것도 띄우지 않는다. 암호 차단이면 지금 문구 그대로(우선).
    - 사용자 안내는 맥락을 아는 **플러그인**이 맡는다: 연결되면 플러그인 상태 표시에 "공동편집 중에는
      로컬 자동 저장을 하지 않습니다 — 서버 문서가 기준입니다"를 한 번 보여 준다.
    - `AutosaveStatus` 에 사유(cause)를 더하는 안은 채택하지 않는다(패치 범위만 넓어진다).
  - 부수 효과(기록): 차단 경로는 `exportBytes` 를 부르지 않으므로, 공동편집 중에는 자동 저장의
    `onBeforeExport` 캐럿 기록 자체가 사라진다. 수동 저장·비교·히스토리는 여전히 캐럿을 쓴다(§4).
  - `shouldSkipInitialAutosaveRecovery()` 에 `params.has('collab')` 추가.
  - 검증: 같은 프로필에서 (1) 공동편집 탭을 저장 없이 닫고 다시 공동편집으로 열어도 모달 없음,
    공동편집 초안 0개. (2) 일반 문서를 편집하다 닫고 공동편집으로 열어도 모달 없음, 그 초안은 남아
    있음. (3) 그 뒤 일반 모드로 열면 그 초안의 복구가 평소처럼 뜬다. (4) 플러그인 unload 뒤 자동
    저장 재개.

막히거나 설계와 다르게 가야 하면 구현을 우회하지 말고 설계 세션(`cc-rhwp-2a`)에 묻는다.

## 8. 알려진 한계 (PoC 1단계에서 수용)

- **동시 편집 미지원.** 문단 번호·글자 위치가 인덱스라 동시 편집은 보정(OT)이 필요하다. 2단계.
- **영속성 없음.** 서버는 방을 메모리에만 두고, 공동편집 중에는 로컬 초안도 쓰지 않는다(§6.9).
  서버가 내려가면 그 방의 편집은 사라진다. 각자 "저장"으로 파일을 받을 수는 있다. 서버 정본의
  영속 저장은 2단계.
- **undo.** 텍스트 명령의 undo 는 같은 export 를 다시 부르므로 기록·전송된다(정상 동작).
  스냅샷 기반 undo(붙여넣기·표 등), 선택 삭제 undo(`restoreDeleteFragment`), 구역 속성 undo,
  **원격 연산 트랜잭션의 undo** 는 기록되지 않는 복원 경로라 어긋난다. T5 로 감지만 한다.
- **커서 보정 없음.** 원격 편집이 내 커서 앞에 들어가도 커서 위치(인덱스)는 그대로다.
- **예약 글자 모양.** 서식을 미리 고르고 입력하면 `applyCharFormat` 이 따로 불려 기록되지 않는다.
- **표 셀 안 편집 미지원.** 셀 경로 메서드(`insertTextInCell*` 등)는 가로채지 않았다. 평면 셀의
  선택 삭제(`deleteRangeInCell`)만 T7 로 잡힌다. 중첩 셀은 전부 미지원.
- **선택 삭제 undo.** 선택 삭제 자체는 연산으로 퍼지지만(T7), 그 undo 는 `restoreDeleteFragment`
  라 어긋난다(T5 가 감지).
- **저장할 때 캐럿 기록.** 저장·자동 저장마다 각자의 UI 캐럿이 문서 속성에 들어간다. 사용자별
  메타데이터로 보고 공유하지 않는다(§4). 서버 정본에 어떤 캐럿을 남길지는 2단계에서 정한다.
- **폰트 차이.** 조판은 각자 브라우저에서 하므로 쪽 나뉨은 다를 수 있다. 문단 텍스트 같은 내용은
  같지만, `exportHwp()` 바이트와 모델 digest(T6)는 조판 결과(줄 배치·쪽 시작·표 높이)를 포함해
  **글꼴이 다른 기기끼리는 달라질 수 있다.** PoC 검증(같은 브라우저 두 탭)에는 영향 없음.
  기기 간 수렴 판정과 저장 정본은 2단계(조판 독립 지문, 서버 정본)에서 다룬다.
  - 대화상자를 끄더라도 studio 는 열 때 `loadStoredLocalFonts()` 로 그 브라우저 프로필에서 예전에
    승인한 로컬 글꼴을 불러온다. 따라서 **같은 기기라도 브라우저 프로필이 다르면** 글꼴 환경이 다를
    수 있다. 2단계 후보: 공동편집 중에는 번들 웹 글꼴만 쓰는 "공동편집 글꼴 정책".

## 9. 검증 기록

| 날짜 | 항목 | 결과 |
|---|---|---|
| 2026-11-26 | 업스트림 무수정 wasm32 `cargo check --lib` | 통과 (1m19s) |
| 2026-11-26 | 패치 + collab-core wasm32 `cargo check --lib` | 통과, 경고 없음 |
| 2026-11-26 | collab-core 단위 테스트 (1차) | 컴파일 실패: `tests/fixtures`·`tests/common` 누락 → 경로 추가 |
| 2026-11-26 | collab-core 단위 테스트 (2차) | 컴파일 실패: `tests/support` 누락(`src/wasm_api/tests.rs`·`cfb_writer/tests.rs` 의 `include!`) → 경로 추가. `src` 전체 컴파일 타임 include 대상 점검, 남은 누락 없음 |
| 2026-11-26 | T0 `cargo test -p rhwp --lib --locked collab::` | **통과 5/5** (빌드 46s). `replaying_ops_converges_to_identical_document` 의 HWP 바이트 비교 포함 |
| 2026-11-26 | 내보내기 결정성 확인 | 시각 요소 고정됨: `serializer/mini_cfb.rs` FILETIME 상수, HWPX `fixed_mtime()`. 바이트 비교 기준 유지. 단 `export_hwp_native` 는 조판 산출(줄 캐시·쪽 시작·표 높이)을 써 넣으므로 **글꼴이 다른 기기 간에는 내용이 같아도 바이트가 다를 수 있다** (같은 브라우저 두 탭은 무관) |
| 2026-11-26 | T1 `bootstrap.sh` 새 클론 (scratchpad 사본) | 1차 실패: `--no-checkout` 클론은 HEAD 가 이미 rev 라 checkout 을 건너뛰어 인덱스가 빈 채 남음 → `--no-checkout` 제거. 2차 **통과** (38s): 클론·희소 경로·패치 적용, 재실행은 "이미 적용됨"으로 멱등, 패치·diff 가 기존 트리와 동일 |
| 2026-11-26 | T1 `bootstrap.sh` 더러운 트리 | rev 를 바꾸고 패치가 적용된 트리에서 실행 → checkout 하지 않고 종료 코드 1 로 멈춤 **통과** |
| 2026-11-26 | T1 `update-patch.sh` | 기존 트리에서 0001 을 다시 쓰면 바이트 동일 **통과**. 0002 생성에 사용 |
| 2026-11-26 | T2 서버 프로토콜 테스트 `server/ npm test` | **통과 6/6**: base 담당·순서·ack·reject·늦은 참여자 로그, base 대기 중 참여자 welcome 지연, 담당 이탈 시 인계, base 전 ops reject, digest 일치·diverged 방송(seq 당 1회)·범위 밖 무시, 잘못된 메시지 |
| 2026-11-26 | T5·T6 단위 테스트 `cargo test … collab::` | **통과 8/8** (기존 5 + 3). 세 복원 export(`restoreSnapshot`·`restoreDeleteFragment`·`restoreSectionRaw`)가 `CollabCore` 를 거쳐 desync 를 세우고 연산은 기록하지 않음, 실패한 복원·기록 꺼짐은 세우지 않음. 수렴 테스트에 digest 비교 추가. 가로채지 않은 편집은 digest 차이로 드러나고 같은 편집을 상대에 가하면 다시 같아짐. 네이티브에서 미룬 조판 flush·SVG 렌더링 전후 digest 불변 |
| 2026-11-26 | T6 점검: 저장 경로의 모델 쓰기 | `WasmBridge` 의 export 7종은 모두 `onBeforeExport` → `setCaretPosition`(main.ts:804) 을 거쳐 `doc_properties.caret_*` 를 쓴다. 자동 저장(main.ts:145, 편집 뒤 10초 idle)·저장(`save-document-format.ts`)·비교(`compare-dialog.ts:186`)·히스토리(`history-dialog.ts:248`)·embed RPC 가 이 경로다. 그 밖의 모델 쓰기는 **없음**: Rust export 는 모두 `&self` 이고 모델은 `RefCell` 밖, 저장 흐름의 `fileName` 설정은 `DocumentCore.file_name` 만 바꿈(모델 아님), `ensureParagraphStableIds` 는 이 rev 의 WASM 에 없어 무동작. 편집 중에는 `replace_body_text_local_native`·`insert_text_at_caret_native` 만 캐럿을 쓴다(인자로 정해져 재생 시 같음) |
| 2026-11-26 | T6 캐럿 제외 + T7 `deleteRange` 단위 테스트 | **통과 11/11** (+3): 캐럿 기록만 다르면 digest 같음(캐럿 외 문서 속성이 다르면 달라짐), 본문 3문단 걸친 선택 삭제 재생 수렴(`cellCtx:null` 직렬화 확인), 평면 셀 선택 삭제를 `deleteRangeInCell` export 로 기록 → 재생 수렴. 라우팅 테스트에 `deleteRange` export 추가 |
| 2026-11-26 | T3 studio `tsc --noEmit` (0002 패치 + 플러그인) | **통과**, 오류 없음. `--listFiles` 로 `collab-client/src/plugin.ts`·새 `pkg/rhwp.d.ts` 가 검사 대상임을 확인 |
| 2026-11-26 | WASM 빌드 `scripts/build-wasm.sh` (T5·T6, 캐럿 포함 digest, T7 전) | **통과** 11m19s, rhwp 경고 없음(외부 crate future-incompat 알림만). `pkg/` 와 `rhwp-studio/public/` 의 SHA-256 일치 |
| 2026-11-26 | T4 환경 | Chrome 확장 미연결 → 프로젝트의 `puppeteer-core`(studio devDependency) + 시스템 Chrome headless 로 같은 브라우저의 두 탭을 구동(`collab-client/e2e/t4-two-tabs.mjs`). 편집은 실제 키 입력·CDP IME, 커서 위치만 studio 개발 전역(`__inputHandler.cursor`) |
| 2026-11-26 | T4 발견: 문서 열 때 로컬 글꼴 확인 창 | `host.loadDocument` → `loadBytes` 는 "로컬 글꼴 감지" 모달을 띄우고 닫힐 때까지 끝나지 않는다(`createNewDocument` 는 `suppressLocalFontPrompt` 로 건너뜀). base 담당의 재열기와 참여자의 base 열기 모두 해당. 드라이버는 "대체 글꼴로 보기"로 닫는다. 참여자마다 선택이 다르면 글꼴→줄 배치→digest 가 달라질 수 있음 |
| 2026-11-26 | T4 **수정 전** 재현 (캐럿 포함 digest), `--phase=before` | **재현됨.** A 가 `caret` 입력(seq 2, 두 탭 digest `2d4eb1d82309` 일치) → 편집 없이 13초 대기 후 B 만 `7f5c7b56e5a0` 로 바뀜(저장된 캐럿 A=(0,0,5) 편집 기록값, B=(0,0,0) B 의 UI 캐럿: 자동 저장의 `onBeforeExport`) → A Enter(`splitParagraph`, 캐럿 안 씀) seq 3 에서 서버 `DIVERGED seq=3 d266bc632fee ≠ f3dd5f716259`, 두 탭 desynced |
| 2026-11-26 | 공유 문서 열기의 확인 창 끄기 (0002 확장) | `PluginHost.loadDocument(bytes, fileName?, options?: { suppressDialogs? })` (`plugin/types.ts` 의 `PluginLoadOptions`), facade 전달(`plugin/host.ts`), main.ts deps 가 `loadBytes(…, null, undefined, { suppressDialogs })`. 생략 시 종전과 같음. 플러그인은 base 재열기·base 열기 모두 `{ suppressDialogs: true }`. studio `tsc` 통과, studio 플러그인 단위 테스트 `node --test tests/plugin*.test.ts` **12/12** |
| 2026-11-26 | `suppressDialogs` 가 끄는 것 (점검) | `loadBytes` 는 이 옵션을 `initializeDocument` 로만 넘기고(main.ts:1903), 거기서는 `promptLocalFontsIfNeeded` 한 곳만 건너뛴다(main.ts:1546). **끄지 않는 것**: 암호 대화상자(`loadDocumentForOpen` → `showHwpPasswordDialog`, 옵션을 받지 않음), HML 가져오기 경고(`showHmlImportWarning`), PDF 가져오기 경로. 우리 base 는 rhwp 가 내보낸 암호 없는 HWP 라 셋 다 해당 없음. HWPX 검증 경고는 원래 로그만. `loadStoredLocalFonts()` 는 그대로 돈다(§8). 공동편집 base 열기에 부적절한 것 없음 |
| 2026-11-26 | WASM 재빌드 (T7 + 캐럿 제외 digest) | **통과** 10m26s, 경고 없음. `cellCtx` 포함 확인. `pkg/`·`rhwp-studio/public/` SHA-256 일치 (`rhwp_bg.wasm` fdcb704b…, `rhwp.js` 글루는 이전과 동일) |
| 2026-11-26 | T4 **수정 후** `--phase=after` (headless Chrome 두 탭, 같은 프로필) | **통과 29/29.** 모든 입장에서 로컬 글꼴 확인 창 없음. 단계마다 두 탭 digest 일치: 입장 직후 seq 0(base 재열기 vs base 열기) → A 영문 → B 이어 입력 → A Enter → B 한글 IME(CDP `imeSetComposition`, "한글 입력") → A 글자 Backspace → B 문단 처음 Backspace(합침) → A 문단 2개 추가 → A 3문단 걸친 선택 삭제(`deleteRange` 전송) → B 선택 위 영문 입력 → B 선택 위 한글 IME. **편집 없이 13초 대기(자동 저장) 후 digest 불변**(저장된 캐럿은 A=(0,0,3)·B=(0,0,1) 로 서로 다름) → 자동 저장 뒤 A Enter·B 문단 처음 Backspace 도 일치. 보조: raw 핸들 `setCaretPosition(0,0,0)` 후 `exportHwp` SHA-256 A=B(a5e17b2c…). 늦게 들어온 C(로그 47 seq 재생) digest·바이트 일치. A 에서 굵게(미지원) 후 입력 → 서버 `DIVERGED seq=49`, 두 탭 desynced·배너 표시. 별도 방: 선택 삭제 후 되돌리기(`restoreDeleteFragment`) → D desynced("연산으로 옮길 수 없는 복원") (T5). 서버 로그: 이 방 diverged 는 seq 49 한 번뿐, reject 없음. 연산 구성 `replaceBodyText` 56·`deleteRange` 4·`splitParagraph` 4·`mergeParagraph` 2 (일반 입력·IME·글자 Backspace 모두 빠른 경로) |
| 2026-11-26 | T4 발견: 자동 저장 초안의 "문서 복구" 모달 | 공동편집 탭을 저장하지 않고 닫으면 자동 저장 초안(`collab-<room>.hwp`)이 그 프로필에 남는다. 같은 프로필에서 새 공동편집 탭을 열면 시작 시 "문서 복구" 모달이 떠 **입력을 막는다**(드라이버의 D 탭이 키 입력을 못 받음, 재현 스크립트로 확인). "복구"를 누르면 공유 로그 밖 문서로 교체된다(플러그인은 예상하지 않은 교체로 desynced 처리). 드라이버는 시나리오마다 격리된 브라우저 컨텍스트를 써서 피했다. 늦게 들어온 C 탭에서도 모달이 떠 있었음(입력은 안 해서 결과 무관) |
| 2026-11-26 | T8 점검: 차단 시 상태 표시 | `flushNow` 는 차단되면 `discardCurrentDraft('recovery-blocked')` 뒤 `onStatus({state:'blocked'})`, `handleAutosaveStatus` 는 "보호 문서는 복구용 자동 저장을 하지 않습니다" 를 4초 표시 → 설계 결정대로 중지 집합이 있고 암호 차단이 아니면 표시하지 않음(main.ts 만 수정), 안내는 플러그인이 연결 직후 한 번. 부수 효과: 차단 경로는 `exportBytes` 를 부르지 않아 공동편집 중 자동 저장의 캐럿 기록이 사라짐(T4 회귀에서 두 탭의 저장된 캐럿이 같은 편집 기록값으로 확인) |
| 2026-11-26 | T8 구현 (0002 확장) | `PluginHost.suspendAutosave(): () => void` + `PluginLedger.autosaveResumes`(unload 때 회수, 재개 함수 멱등), main.ts deps 의 토큰 집합 → `isRecoveryBlocked` 에 OR, `shouldSkipInitialAutosaveRecovery` 에 `collab`. 플러그인은 활성화 직후(첫 `loadDocument` 전) 중지, teardown 에서 재개, welcome 처리 뒤 안내 8초. studio `tsc` 통과, studio 플러그인 단위 테스트 **16/16** (+4: 중지·멱등 재개·unload 회수·활성화 중 호출·호스트 미지원) |
| 2026-11-26 | T1 스크립트 보강 | 패치가 새 파일을 만들면 새 클론에서 그 파일이 추적되지 않아 `git diff` 에 안 나오고 `update-patch.sh` 가 패치에서 빠뜨릴 수 있었다 → bootstrap 은 `git apply --intent-to-add`, update-patch 는 추적 안 된 패치 대상에 `git add -N`. 새 클론에서 확인: 새 파일이 `A`(intent-to-add), 패치 재생성 바이트 동일, 일부러 추적을 풀어도 동일, 재실행 멱등 |
| 2026-11-26 | T8 브라우저 검증 `--phase=t8` (격리 컨텍스트 하나 = 같은 프로필) | **통과 21/21.** 공동편집 중 편집 뒤 13초 idle: 상태 표시줄에 암호 문구·자동 저장 문구 없음, 플러그인 안내 1회, 초안 0개. (1) 공동편집 탭을 저장 없이 닫고 다시 공동편집 → 복구 모달 없음, 공동편집 초안 0개. (2) 일반 탭 편집(초안 1개 `새 문서.hwp`) 후 닫고 공동편집 → 모달 없음, 공동편집 편집·idle 뒤에도 그 초안 남음. (3) 일반 모드로 열면 그 초안 복구 모달이 평소처럼 뜸. (4) 공동편집 탭에서 `rhwpStudio.plugins.unload('collab')` → `isRecoveryBlocked` true→false, 편집 뒤 초안 생김("복구용 자동 저장 완료") |
| 2026-11-26 | T4 회귀 (T8 반영 후) `--phase=after` | **통과 29/29.** 늦게 들어온 C 에도 복구 모달 없음. 굵게 → `diverged`(seq 47) 그대로 |

## 10. 다음 단계

1단계 완료(2026-11-26). 2단계 동시 편집 설계는 `docs/collab-stage2.md`. 2단계가 이 문서의
§4(연산 JSON), §6.4~§6.7(플러그인 상태 기계)를 대체한다. 나머지는 2단계에서도 유효하다.
