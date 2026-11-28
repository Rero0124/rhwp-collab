# 공동편집 6단계: 보안 강화와 부품화

5단계(`docs/collab-stage5.md`)로 배포 준비는 끝났다. 이 단계는 사용자가 정한 순서대로 아래를 한다(2026-11-27).

1. S1 서버가 다시 쓴 state: 편집 권한의 state 로 rhwp 가 해석하지 않는 레코드를 끼워 넣는 길을 막는다.
2. S2 방을 열 때 왕복 점검: rhwp 가 다 다루지 못하는 문서를 방을 만들 때 알린다.
3. S3 부품 전용 모드: 바깥 시스템의 iframe 안에서만 쓰이게 하고, 단독으로 오는 요청은 거절한다.
4. 그 뒤: 표 만들기·붙여넣기 되돌리기(4단계 §5 U3), 네이티브 준비(연결 상태 기계 분리), 사용성 다듬기.

## S1 서버가 다시 쓴 state

**문제.** state 항목은 클라이언트가 만든 문서 바이트다. 정본은 그 바이트를 읽고(collabLoadState) 판정하지만, 판정은
파싱한 모델만 본다. 구역·DocInfo 의 원본 바이트 캐시는 보낸 바이트 그대로 남는다. 그래서 파서가 모델에 남기지 않는
레코드를 끼우면 판정을 지나 저장본과 다른 참여자의 문서에 남는다. 한글 문서에 끼운 악성 레코드는 실제로 쓰이는 공격
경로다. 좁은 권한은 이미 state 를 보낼 수 없고(5단계), 남은 것은 edit 권한이다.

**결정: 방에 들어가는 바이트는 서버가 만든다.**
- 정본은 받은 바이트 C 를 읽어 판정한 뒤, **바뀐 부분은 모델에서 다시 쓴** 바이트 S 를 만든다.
  - 구역·DocInfo 마다, C 의 원본 바이트가 정본의 지금 원본 바이트와 같으면 지금 것을 그대로 쓴다. 다르면 캐시를 버리고
    모델에서 다시 쓴다.
  - 부속 스트림은 정본의 지금 것을 쓴다. rhwp 가 모델에서 다시 만드는 것(/RhwpLineSegTags 등)만 새로 쓴다.
    state 로 부속 스트림을 바꾸는 정상 기능이 있으면 조사해서 목록으로 허용한다.
  - BinData 는 모델이 참조하는 것만 남긴다.
- 정본은 S 를 다시 읽는다(R(S)). 기록에는 C 대신 S 를 남기고, 모두에게 S 를 보낸다. **보낸 사람에게도** ack 와 함께 S 를
  보낸다(`replaced: true`). 보낸 사람은 자기 state 를 S 로 바꿔 다시 읽는다. 모두가 같은 바이트를 읽는다는 계보 원칙
  (3단계 S3-3)을 지킨다.
- 보낸 사람의 엔진: 자기 state 항목의 ack 에 S 가 오면, 확정 상태를 R(S) 로 두고, 그 뒤의 미확정은 원격 state 를 받은
  것처럼 다시 얹는다(지금의 되감기·재적용). 같은 모델이므로 보통은 그대로 얹힌다.
- 비용: state 항목마다 서버의 내보내기·읽기가 한 번씩 더 들고, 보낸 사람에게 문서 크기만큼 더 보낸다. 5단계 뒤로
  state 는 드물다(op 191).
- 원래 업로드한 파일(처음 base, POST /rooms)은 방을 만든 사람(create 권한, 바깥 시스템)이 준 것이라 그대로 쓴다.
  S2 의 왕복 점검 결과는 함께 남긴다.
- 시험:
  - 원시 클라이언트가 edit 토큰으로, 모르는 태그의 레코드를 구역 바이트에 끼운 state 를 보낸다. 방송된 바이트·서버
    저장본·다른 참여자가 내보낸 파일 어디에도 그 레코드가 없어야 한다.
  - 정상 state(붙여넣기 등)는 그대로 동작하고, 모든 참여자와 정본의 digest 가 같아야 한다.
  - 보낸 사람이 state 직후 계속 입력해도 수렴한다(R5 에 state 섞기, 지연 서버 브라우저 시험).
- README 한계의 "편집 권한자는 … 신뢰하는 사람에게만" 문장은 이 단계가 끝나면 지운다.

## S2 방을 열 때 왕복 점검

- rhwp 는 저장할 때 손대지 않은 부분의 원본 바이트를 그대로 쓴다. 그래서 "다른 이름으로 저장 후 비교"는 rhwp 가
  모르는 기능이 있어도 통과한다. 문제는 그 부분을 편집해 모델에서 다시 쓸 때 생긴다. 그러므로 **모든 부분을 모델에서
  다시 쓴 결과**를 원본과 비교한다.
- rhwp 의 진단을 쓴다: `diagnostics::hwp5_roundtrip_batch`(`baseline_check`: IR 차이, BinData·중첩 OLE CLSID 소실, CFB
  구조), `hwp5_inventory_diff`(레코드 목록 차이), HWPX 는 `hwpx_roundtrip_batch`. 원본 바이트 캐시를 버린 직렬화로
  돌리는 자리를 collab-core 보조 `collabRoundtripCheck()` 로 만든다. 결과는 JSON 이다:
  `{ok, lost: [{kind, count, detail}], irDiff: n}`.
- 서버: POST /rooms 와 studio 메뉴로 방을 만들 때 정본 워커가 한 번 돌린다. 결과는 방 메타에 남기고 응답에 싣는다.
  - 업로드 페이지와 launcher 는 방을 만든 사람에게 보여 준다. 통과면 "rhwp 가 이 문서를 그대로 다룰 수 있습니다",
    아니면 무엇이 있는지와 "이 부분이 있는 쪽을 편집하면 사라질 수 있습니다".
  - welcome 에도 요약을 실어, 참여자가 처음 들어올 때 한 번 알린다(경고가 있을 때만).
  - `COLLAB_ROUNDTRIP=warn`(기본) | `block`(통과하지 못하면 방을 만들지 않음, 422 `roundtrip`) | `off`.
- 화면 배치 비교(`render-diff`)는 더 무거워서 후보로 둔다.
- 시험: 업스트림 샘플 전수(읽기만)로 통과·경고 분포와 걸린 시간을 기록한다. 경고 사례 몇 개는 실제로 그 부분을
  편집한 뒤 내보내 정말 사라지는지 확인한다(점검이 맞는지).

## S3 부품 전용 모드

목표: 바깥 시스템의 페이지가 iframe 으로 편집기를 넣어 쓰는 배포에서, 편집기 주소를 직접 열거나 링크를 복사해 단독으로
쓰는 것을 막는다.

- 서버 설정: `COLLAB_EMBED_ONLY=1` + `COLLAB_EMBED_ORIGINS=https://host.example[,…]`.
- **iframe 밖에서 열기 거절:** 편집기 문서 요청에 `Content-Security-Policy: frame-ancestors <허용 출처>` 를 붙인다(허용
  출처만 넣을 수 있음). 그리고 최상위 탐색(`Sec-Fetch-Dest: document`)이면 편집기 대신 "이 편집기는 <시스템> 안에서만
  열 수 있습니다" 페이지를 403 으로 준다. `Sec-Fetch-*` 를 보내지 않는 오래된 브라우저는 플러그인이 `window.top ===
  window.self` 로 한 번 더 막는다.
- **토큰은 부모 페이지에서만:** 이 모드에서는 주소의 `#token`·`#create` 를 받지 않는다. 플러그인의 토큰 공급자
  (`getToken`, 5단계 D0)가 부모 창에 postMessage 로 토큰을 요청하고, 허용 출처에서 온 답만 받는다. 링크를 복사해도
  토큰이 없으므로 들어올 수 없다. 만료되면 같은 길로 다시 받는다.
  - studio 에는 이미 embed 프로파일과 부모 창과의 MessagePort 통로(`embed/runtime.ts`, 처음 묶인 출처 고정)가 있다.
    가능하면 그 통로를 쓰고, 0002 를 크게 늘려야 하면 플러그인의 별도 메시지로 한다(조사 후 결정).
- **방 만들기:** 이 모드에서는 업로드 페이지와 launcher 메뉴를 끈다. 방은 바깥 시스템이 서버 API 로 만든다.
- **권한 매핑 (사용자 제안, 2026-11-27):** 바깥 시스템은 자기 역할 이름을 그대로 쓰고, 서버가 우리 권한으로 바꾼다.
  - `COLLAB_ROLE_MAP`(JSON 파일 경로): `{"작성자": "edit", "검토자": "comment", "신청자": "form", "열람자": "view"}`
    처럼 역할 → scope 목록.
  - url 방식의 확인 응답이나 hs256 토큰에 `roles`(역할 이름 목록)가 있으면 매핑표로 바꾸고, 여러 역할이면 합친다.
    `scope` 가 있으면 지금처럼 그대로 쓴다. 둘 다 있으면 합친다.
  - 매핑표에 없는 역할은 아무 권한도 주지 않는다(기본 거부). 매핑표에 우리가 모르는 scope 이름이 있으면 서버 시작을
    거부한다(오타로 권한이 조용히 빠지거나 넓어지지 않게).
  - 최종 권한은 서버만 정하고 welcome 의 `user.scope` 로 알린다. 역할 이름은 기록에 남기지 않는다(바깥 시스템의
    조직 정보일 수 있으므로).
  - url 방식에서는 바깥 시스템의 기존 로그인 토큰을 그대로 넘기면 된다. 바깥 시스템이 문서별 권한을 알고 있으므로
    방마다 다른 역할을 답할 수 있다.
  - 이 매핑은 부품 전용 모드가 아니어도 쓸 수 있다.
- **한계(문서에 적는다):** 이것은 단독 사용과 링크 돌려쓰기를 막는 장치다. 권한 있는 사용자가 개발자 도구로 iframe 안의
  토큰을 꺼내 WebSocket 을 직접 여는 것까지는 막지 못한다. 그 사용자는 원래 권한이 있다.
- 시험: 허용 출처의 페이지 안 iframe 은 동작한다. 최상위로 열면 403 페이지가 뜬다. 허용되지 않은 출처의 iframe 은
  브라우저가 막는다. 주소에 토큰을 붙여 열어도 들어오지 않는다. 부모가 토큰을 갱신해 준다.

## N1 네이티브 준비: 연결 상태 기계를 플랫폼 중립 세션으로 (사용자 결정, 2026-11-27)

지금 `collab-client/src/plugin.ts`(약 1,100줄)에 studio 연결과 공동편집 연결 처리가 섞여 있다. 나중에 네이티브
클라이언트로 넓힐 때 다시 쓸 수 있도록, 연결 처리를 DOM·studio 에 의존하지 않는 세션 계층으로 옮긴다(5단계 D0 에서
미뤄 둔 일).

- **옮길 것 → `collab-client/src/session/` 의 `CollabSession`:**
  - 연결, hello, welcome·catchup 처리, 재접속·백오프, 세대·lastSeq
  - 보내기 묶음과 inflight·batchId, reject·invalid·forbidden·unauthorized·too-large 처리, 재동기화
  - digest 보고, 커서 주고받기, replaced 확정, 권한·이름(welcome.user)
- **세션이 바깥에서 받는 것(인터페이스):**
  - `Transport`: 열기·보내기·닫기·받기. 브라우저는 WebSocket 구현이다.
  - `Host`: base 바이트로 문서 열기, 원격 state 반영, 캐럿 읽기·쓰기, 조합 중 여부, 이탈 확인, 되돌리기 훅, 안내 표시
    (문구는 세션이 이유 코드로 넘기고 문구는 호스트가 정함).
  - `TokenProvider`(5단계 D0 그대로), 시계·타이머(시험에서 바꿔 끼움).
  - 편집 기록 엔진(`CollabEngine`)은 지금처럼 TS 에 있다. 네이티브에서는 이 엔진을 옮기거나 같은 규약을 따로 구현해야
    한다. 엔진의 조율 부분을 Rust(`collab-core`)로 옮기는 일은 네이티브 계획이 구체화되면 정한다(범위 밖).
- **`plugin.ts` 는 studio 어댑터로 남는다:** WebSocket Transport, studio Host(문서 열기·applyExternal·캐럿·overlay·
  안내 DOM), studio 쪽 접속 정보(주소·#token·부품 전용 토큰 통로), launcher 와의 공용 부분.
- **조건: 동작이 바뀌지 않는다.** 기존 브라우저 시험(R7·R8·R10·T4·S3-4·s5-deploy·s6-embed·u1-undo·d3-launcher·
  s1-rewrite)이 고치지 않고 통과해야 한다. 엔진 지문은 바뀌지 않아야 한다(plugin·session 은 코드 해시 대상이 아님).
- **새 시험:** `CollabSession` 을 가짜 Transport·Host 로 Node 에서 돌린다. 지금까지 브라우저로만 보던 재접속·reject·
  replaced·unauthorized·세대 전환 경로를 단위 시험으로 덮는다.
- **문서:** 규약 문서에 "다른 플랫폼에서 클라이언트 만들기" 절을 둔다. 세션이 요구하는 Host·Transport 목록과, 엔진이
  TS 에 있다는 현재 한계를 적는다.
- 순서: 먼저 인터페이스 초안(타입 선언)을 설계 세션에 보내고, 승인 뒤 옮긴다.

## 분담

| 일 | 기존 코드 세션(3b) | 배포 세션(68) |
|---|---|---|
| S1 | collab-core 보조(바뀐 부분만 모델에서 다시 쓰는 내보내기), 엔진의 `replaced` ack 처리, R5·브라우저 시험 | 정본의 다시 쓰기·기록·방송, 규약, 원시 클라이언트 시험 |
| S2 | collab-core 보조 `collabRoundtripCheck` | 서버·업로드 페이지·launcher 문구, 설정, 샘플 전수 측정 |
| S3 | (0002 가 필요하면) embed 통로 | 서버 머리(CSP·Sec-Fetch), 플러그인 토큰 공급자, 시험 |

## 기록

| 날짜 | 항목 | 결과 |
|---|---|---|
| 2026-11-27 | **S1 보조·엔진** (기존 코드 세션) | **보조 `doc.collabRewriteState(C) → S`**(68 제안 모양, C·S 모두 결과 전송 gzip, 정본은 바꾸지 않음 — 부른 쪽이 S 를 `collabLoadState`): C 를 따로 읽어 구역·DocInfo 마다 원본 바이트가 정본의 지금 원본 바이트와 같으면 그대로, 다르면 캐시를 버려 C 의 모델에서 다시 쓴다. 정본 바이트는 **봉인이 지금 모델과 맞을 때만** 기준으로 삼는다(저장기가 다시 쓰는 조건과 같다 — 연산으로 바뀐 구역의 낡은 바이트와 같다고 보지 않는다). 어느 쪽이든 S 의 내용은 C 의 모델이다. 부속 스트림·HWPX 부속 항목·미리보기·파일 머리·출처 표지는 정본 것(저장기가 다시 만드는 `/RhwpLineSegTags`·테두리 칠 표지는 새로), BinData 는 모델이 참조하는 것만(업스트림 `prune_unreferenced_bin_data` — 0001 에 보이기만 바꾸는 한 줄 `pub(crate) use`), 형식은 정본의 형식 계열. **조사**: 편집 기능 중 문서 객체의 부속 스트림을 바꾸는 것은 없다 — 쓰는 곳은 내보낼 때 사본에 붙이는 계보 표지(`hwpx_to_hwp`, HWPX 계보)와 저장기가 다시 만드는 스트림뿐(허용 목록 불필요). **남은 구멍(결정 필요)**: 모델 다시 쓰기는 파서가 모델에 **남기지 않는** 레코드만 없앤다. 파서가 모르는 레코드를 모델 안에 날 바이트로 보존하는 자리(DocInfo `extra_records` — 확인: 모르는 태그 레코드가 C 에도 S 에도 남음, 그 밖에 개체별 `ctrl_data_records`, 스타일 `raw_data`, 도형·표·그림의 `raw_*`, 구역 꼬리 레코드 등)에 끼운 것은 S 에 남는다. 구역 끝에 끼운 모르는 태그(0x3f0) 레코드는 사라진다(시험). **엔진 `ackReplaced(confirmed, caret)`**: 내 묶음의 echo 가 `replaced: true` 와 서버가 바꾼 기록을 실어 오면, 확정 상태를 그 기록(R(S) 포함)으로 두고 뒤의 미확정은 **그대로** 다시 얹는다(원격 state 처럼 보정하면 state 와 겹친 미확정이 모두 버려진다 — S 는 C 와 같은 모델이라 그대로 얹힌다). 다시 얹다 실패하면 거기부터 버림. 플러그인은 echo(실시간·따라잡기)에서 `replaced` 면 `host.applyExternal` 로 반영(원격 state 와 같은 studio 경로), 되돌리기 위치·캐럿은 그대로. 상태에 `replacedAcks`. **시험**: Rust collab **78/78**(+4: 정본 그대로·R(S)=R(C) 모델·편집 없는 state 는 같은 바이트, 구역에 끼운 모르는 레코드 사라짐, 봉인이 맞는 정본 바이트만 재사용(연산 뒤에는 다시 씀 — 같은 바이트여도), 정본 부속 스트림·참조 없는 BinData 버림), collab-client 62/62. R5 `--rewrite-state`(harness 서버가 정본과 같이 state 를 다시 쓰고 `replaced` 로 확정, 섞기에 덧말 넣기 state): **200×200 `--verify-fast` 실패 0**(다시 쓰기 221, replaced 확정 218, 빠른 경로 불일치 0), `--s3` 100×200 실패 0(다시 쓰기 71, 세대 전환·재시작·따라잡기 포함). 브라우저 `e2e/s1-rewrite.mjs`(지연 서버, state 직후 계속 입력)는 서버 쪽 다시 쓰기가 합쳐진 뒤 돌린다 — 지금 서버로 돌리면 수렴·취소 0 이고 replaced 만 0 |
| 2026-11-27 | S1 서버 흐름과 시험 뼈대 (배포 세션) | 정본 워커: 묶음에 state 가 있고 보조(`collabRewriteState(C) → S`, gzip 감싸기, 정본은 바꾸지 않음 — 설계 세션 승인)가 있으면 하나씩 적용하며 state 는 `collabLoadState(S)` 로 다시 읽고 뒤의 op 는 R(S) 위에 얹는다 → `{replaced: [{index, data}]}`. 서버: 그 자리의 state 를 S 로 바꾼 묶음으로 디스크 기록·메모리 기록(기준점)·방송, 방송에 `replaced: true`(보낸 사람의 ack 도 같은 메시지라 S 가 실려 감). 보조가 없으면 받은 바이트 그대로 + 한 번 경고. 규약 §3.2·§3.3·§4.2·§6. 시험 `server/test/rewrite.test.mjs`: 위조 = HWP Section0 을 풀어 모르는 태그(0x3f0) 레코드를 덧붙이고 다시 압축해 복합 파일 그 스트림 마지막 섹터의 남는 자리에 쓰고 디렉터리 크기만 고침(원시 클라이언트가 보낼 수 있는 바이트). ① 위조 확인 — 다시 읽은 모델의 digest 는 원래와 같고 내보내면 레코드가 남는다(취약점이 실제로 있음, 시험이 헛돌지 않음) ② 보조 없는 흐름 — 레코드가 그대로 방송, 경고 ③ 대역 보조(S = C, 임시 pkg)로 서버 흐름 — replaced·자리 바꿈·digest 일치 / 보조가 합쳐지면 ④ 레코드가 방송·다른 참여자 내보내기·저장본·내려받은 파일·log.jsonl 어디에도 없음 ⑤ [op, state, op] 수렴 — 지금은 건너뜀 |
| 2026-11-27 | S2 서버 흐름·문구·측정 스크립트 (배포 세션) | 워커 `roundtrip` → `collabRoundtripCheck()`(없으면 `supported:false`). `POST /rooms`(업로드 페이지·launcher 도 이 길): 결과를 `{ok, lost: [{kind, count, detail?}], irDiff}` 로 다듬어 응답·방 메타(세대 전환·재시작 뒤에도)에 싣고, 경고면 welcome 에 요약. `COLLAB_ROUNDTRIP=warn`(기본)\|`block`(422 `roundtrip`, 방 만들지 않음)\|`off`, 모르는 값이면 시작 거부. 문구는 `collab-client/src/session/roundtrip.ts`(launcher·플러그인이 같이 씀, 업로드 페이지는 같은 규칙을 따로): 통과 "rhwp 가 이 문서를 그대로 다룰 수 있습니다", 경고 "…다 다루지 못하는 부분이 있습니다: OLE 개체 2개, … 이 부분이 있는 쪽을 편집하면 사라질 수 있습니다", block 거절. 플러그인은 welcome.roundtrip 이면 한 번 안내. 시험 `server/test/roundtrip.test.mjs` **3/3**(보조 없음 건너뜀 / 대역 보조로 warn·welcome·메타·재시작, block 422·통과면 만듦, off, 모르는 값 거부), session 문구 시험. 전수 측정 `scripts/roundtrip-survey.mjs`(샘플 읽기만, 통과·경고·시간·종류) — 보조가 합쳐진 뒤에 돌린다 |
| 2026-11-27 | S3 조사 결론 (설계 세션 결정) | studio 의 embed 통로(`embed/runtime.ts`, 처음 묶인 출처로 고정되는 MessagePort)에 이미 `plugin.list/load/unload/invoke` 가 있다(`plugin.invoke` 는 플러그인 표면의 메서드를 부름, 따로 막는 capability 없음). 그래서 토큰은 부모가 `plugin.invoke({id:'collab', method:'setToken', args:[토큰]})` 로 넣고, 플러그인은 토큰이 필요할 때 부모에게 비밀 없는 알림만 보낸다 — 0002 를 늘리지 않는다. 부모가 plugin.load 를 직접 부르지 않게 한다(URL 로 올라가는 것과 겹치면 두 번 activate 될 수 있음). legacy 통로(port 없는 window.postMessage)는 port 가 묶이기 전 출처 고정 없이 plugin.invoke 를 부를 수 있으므로 부모 출처 제한은 CSP frame-ancestors 가 맡는다 |
| 2026-11-27 | **S3 구현** (배포 세션) | 서버: `COLLAB_EMBED_ONLY=1` + `COLLAB_EMBED_ORIGINS`(출처 형식 검사, 없거나 틀리면 시작 거부) → 편집기 HTML 에 `Content-Security-Policy: frame-ancestors <허용 출처>`, 최상위 탐색(`Sec-Fetch-Dest: document`)은 403 안내 페이지, `/upload` 끔, `/healthz` 에 `embedOnly·embedOrigins`(launcher 는 embedOnly 면 메뉴를 내지 않음). `/healthz` 는 비밀이 없으므로 다른 출처에서도 읽게 함(개발용 분리 구성에서 플러그인이 읽음). 플러그인(부품 전용일 때): 주소의 `#token` 을 쓰지 않음, 최상위 창이면 안내만, 알림 `{type:'rhwp-collab-token-request', room, reason}` 의 대상은 ancestorOrigins[0](허용 목록에 있을 때) → 허용 출처가 하나면 그것 → 그 밖에만 `*`, 표면은 `setToken` 하나(status·digest 등 읽기 메서드는 막음 — `window.__collab` 시험 고리는 다른 출처에서 닿지 않으므로 그대로), 제한 시간(기본 30초) 뒤 "바깥 시스템에서 접속 정보를 받지 못했습니다". 권한 매핑 `COLLAB_ROLE_MAP`: 토큰·url 답의 `roles` 를 표로 바꿔 scope 와 합침, 표에 없는 역할은 권한 없음, roles 만 있고 맞는 게 없으면 권한 없음(edit 로 넓히지 않음), 표에 모르는 권한이면 시작 거부, 역할 이름은 결과·기록·로그에 남기지 않음. 규약 §2.2·§2.3·§7(부모 쪽 예시 코드, 신뢰 전제, 한계), README 설정·"다른 시스템에 붙이기". 시험: 서버 단위(부품 전용 머리·403·업로드 끔·healthz·시작 거부, 권한 매핑 3개 — 매핑·합치기·기본 거부·표 오타 거부·hs256 roles 로 입장·url roles·로그에 역할 이름 없음), **브라우저 `collab-client/e2e/s6-embed.mjs` 7/7**: 허용 출처 부모 안에서 알림 → setToken → 입장, 알림에는 room·reason 만, plugin.invoke 로 status·digest 막힘, 최상위로 열면 403, 허용되지 않은 출처(localhost)의 iframe 은 frame-ancestors 로 브라우저가 막음, 주소에 #token 을 붙여도 무시·제한 시간 뒤 안내·서버 인증 기록 없음, 다시 붙을 때 만료 → expired 알림 → 부모가 새 토큰 → 다시 들어옴 |
| 2026-11-27 | 회귀 (worktree 작업 트리, collab/poc `ee7ef2a` 위) | 서버 **75 통과 + 2 건너뜀**(S1 보조 ④⑤), collab-client **63/63**, studio tsc, R8 **22/22**, R7 **10/10**, S3-4 **4/4**, s5-deploy **15/15**, s6-embed **7/7** |
| 2026-11-27 | **S1 서버 쪽 확인** (진짜 보조 `3301630` 위, 배포 세션) | 기록 항목 자체에 `replaced: true`(디스크 log.jsonl·메모리 기록·state 뒤 나머지 묶음 모두 — 방송 `{type:'ops', ...entry}` 가 보낸 사람에게도 그대로 가므로 실시간·catchup·welcome 기록이 같은 모양). `rewrite.test.mjs` **6 통과 + 1 건너뜀(보조 없는 흐름) + todo 1**: ④ 구역에 끼운 모르는 레코드가 방송·보낸 쪽이 받은 S·다른 참여자 내보내기·저장본(doc.*)·내려받은 파일·log.jsonl 어디에도 없음, ack·방송에 replaced, 보낸 쪽·다른 참여자 digest = 정본 ⑤ [op, state, op] 수렴 / 기록 모양: 디스크 항목과 welcome 기록(같은 묶음의 나머지)에 replaced / DocInfo 위조 확인(rhwp 를 지남) / **todo**: DocInfo 에 끼운 모르는 레코드는 아직 S 에 남음 — 기존 코드 세션의 결정 (C)(extra_records 등) 가 합쳐지면 todo 를 푼다. 3b 의 브라우저 `s1-rewrite.mjs`(지연 서버 300ms, 이 서버 흐름) **5/5**: replacedAcks 3, 취소 0, 재동기화 0. 서버 78 통과 + 1 건너뜀 + todo 1, collab-client 63/63, studio tsc |
| 2026-11-27 | **S1 결정 (C)** (기존 코드 세션) | 모델 안 날 바이트 자리 두 곳은 **정본 문서에 같은 내용으로 없던 것을 버린다**(버림 — 거절하지 않음, S 의 내용은 C 와 달라지지만 모두가 S 를 읽는다). **조사(정상 기능이 이 두 곳에 새 내용을 만드는 길)**: DocInfo `extra_records` — 메모 모양(`setMemoShape` → `set_memo_shapes`, 분류표 **op** — 정본이 state 보다 먼저 적용해 같은 내용이 있다)뿐, 배포용 문서 풀기(`convertToEditable`)는 DISTRIBUTE_DOC_DATA 를 빼기만 한다. 구역 끝 목록 `trailing_lists`(마지막 문단 뒤 수준 1 MEMO_LIST·LIST_HEADER 로 시작하는 묶음 — 메모 목록·확장 바탕쪽 목록) — 편집 기능은 빼기만 하고(바탕쪽 만들기·지우기가 원본 바탕쪽 묶음을 버림), 새 내용은 **저장기**가 만든다: 메모를 고치면 메모 목록을, 원본 바탕쪽 묶음이 없는 구역은 확장 바탕쪽 목록을 모델에서 써서 그 바이트를 다시 읽으면 끝 목록이 된다. 그래서 끝 목록은 묶음 단위로 문서 전체에서 같은 내용을 찾고(구역을 합치거나 나눠도), 버린 것은 모델에서 다시 쓰게 한다 — 메모 묶음을 버리면 메모 봉인을 풀어 저장기가 메모 본문에서 다시 쓰고, 바탕쪽 묶음을 하나라도 버리면 그 구역의 원본 바탕쪽 묶음을 모두 버려 모델이 확장 바탕쪽을 쓴다(일부만 남기면 저장기가 남은 원본만 쓰고 나머지를 잃는다; 업스트림 바탕쪽 편집처럼 봉인이 맞았으면 다시 봉인). DocInfo 는 레코드 단위, 메모 모양을 버리면 ID_MAPPINGS 의 메모 모양 수를 맞춘다. 패치 변경 없음(`pub(crate)` 로 닿음). **시험** Rust collab **83/83**(+5): DocInfo 에 끼운 모르는 레코드 사라짐·정본 것 그대로, 앞선 연산이 만든 메모 모양 남음, 메모를 고친 결과의 메모 목록은 모델에서 다시 써 메모를 잃지 않음, 끝 목록에 끼운 것(메모 묶음 안·따로 선 0×0 목록) 사라짐·메모 그대로·끼운 것 없으면 끝 목록은 정본 것 그대로, 확장 바탕쪽 만들기(state)는 모델에서 다시 써 남고 다음 번에는 그 목록이 그대로 재사용. 서버 `rewrite.test.mjs` 의 DocInfo todo 를 풂 → **7 통과 + 1 건너뜀(보조 없는 흐름)**, 서버 **79 + 1 건너뜀**, collab-client **63/63**, 지문 `981ce66b4183-8ab67845cf3a-c21f060b979a-d0e76ac479bb`, 브라우저 `s1-rewrite.mjs`(이 세션, 합친 서버 흐름 + (C)) **5/5**(replacedAcks 3, 취소 0, 재동기화 0). 남는 날 바이트 자리 목록은 규약 문서 "알려진 한계"로(배포 세션이 반영) |
| 2026-11-27 | **N1 연결 상태 기계를 플랫폼 중립 세션으로** (배포 세션) | `collab-client/src/session/collab-session.ts`(`CollabSession`)·`protocol.ts`(서버 메시지 형)·`texts.ts`(기본 문구). 연결·hello·welcome/catchup·재접속(백오프)·세대·lastSeq·보내기 묶음·reject/invalid/forbidden/unauthorized/too-large·재동기화(1분 3회)·digest·커서·replaced·welcome.user 를 옮김. 바깥에서 Transport(연결 하나)·CollabHost(문서·캐럿 스냅숏·조합·applyExternal·사건)·TokenProvider·Clock 을 받고, 문구는 이유 코드(안내 13·재동기화 까닭 8·나온 까닭 9)로 넘긴다. 엔진은 세션이 만들어 `engine` 으로 내놓고, 권한 문·메모 작성자는 세션이 입장 때 건다. 되돌리기는 `setUndo`(start 전). `plugin.ts` 는 studio 어댑터(1,085 → 513줄): WebSocket Transport, studio Host, 주소·#token·부품 전용 통로, 패널·배너·커서 DOM, 양식 모드·자동 저장·글꼴 정책·되돌리기 컨트롤러·이탈 확인·가로채기. 새 시험 `collab-session.test.mjs` 17(가짜 Transport·Host·Clock + 진짜 rhwp 문서: 들어오기·reject/requeue·원격·seq 건너뜀 재동기화·replaced·백오프 재접속과 catchup 확정·안 닿은 묶음 다시 보내기·세대 전환 resume-fallback·unauthorized 갱신/포기·재동기화 상한·조합 중 보류·too-large·첫 참여자/암호·swapped·커서·문구·**session/ 소스 가드**). 기존 브라우저 시험 10종 고치지 않고 통과: R7 10/10, R8 22/22, R10 6/6, T4 30/30, S3-4 4/4, s5-deploy 15/15, s6-embed 7/7, u1-undo 10/10, d3-launcher 9/9, s1-rewrite 5/5. collab-client 80/80, 서버 79 + 건너뜀 1, studio tsc, gen-catalog --check(엔진 지문 그대로). 규약 §9 "다른 플랫폼에서 클라이언트 만들기". 남은 것(동작 변경이라 N1 밖): 바쁜 동안 digest 타이머가 0ms 로 다시 걸려 브라우저에서 약 4ms 마다 도는 것(plugin.ts 때부터) |
| 2026-11-27 | **N1 뒤: digest 타이머가 바쁜 동안 0ms 로 다시 걸리던 것 고침** (배포 세션) | `CollabSession.scheduleDigest`: 울렸는데 아직 바쁘면(보내는 중·끊김·조합·재동기화) 한 간격(1초) 뒤에 다시 본다 — 예전에는 마지막 보고에서 1초가 지났으면 0ms 로 다시 걸려 브라우저에서 약 4ms 마다 idle 검사가 돌았다(plugin.ts 때부터). 바쁜 동안 걸어 둔 늦은 타이머는 한가해진 자리(확정·따라잡기·welcome 이 부름)에서 당겨, 보고는 지금처럼 곧 나간다. 시험: 가짜 시계의 최소 4ms 맞춤을 걷고, 한 번 진행에 타이머 5,000번이 넘으면 실패하게 함. 새 시험 1(내 묶음 확정 전 남의 묶음 → 10초 동안 0ms 타이머 0·1초 간격, 확정되자 곧 보고 seq·digest 일치, 끊긴 동안도 같음) — 예전 동작으로 되돌리면 이 시험이 "타이머가 멈추지 않습니다"로 실패함을 확인. collab-client 81/81, studio tsc. 브라우저: T4 30/30, R8 22/22(빠른 경로), u1-undo 10/10 — digest 보고가 늦어져 시간에 걸리는 시험 없음 |
| 2026-11-27 | **S2 보조** (기존 코드 세션) | **`doc.collabRoundtripCheck() → JSON 문자열 {ok, lost:[{kind,count,detail?}], irDiff}`**(이 문서는 바꾸지 않음): 지금 문서의 저장본(원본)을 다시 읽어 **원본 바이트 캐시를 모두 버린 뒤**(구역·DocInfo 원본 바이트와 봉인, DocInfo 항목별 `raw_data`, 문서 속성 원본) 모델에서만 쓰고, 다시 읽어 견준다. 모델 안 날 바이트 자리(편집해도 남는다)는 모델의 일부로 둔다. HWPX 저장기는 원본 캐시 없이 늘 모델(과 원문 조각)에서 쓰므로 그대로. **kind**: `ir`(업스트림 저장 자기검증 `diff_exported_hwp(x)_documents` — 줄 캐시는 빼고 견줌, count=irDiff, detail=앞 3건) · `record`(HWP: 스트림마다 레코드 태그 멀티셋에서 사라진 레코드 — 파서가 모델에 남기지 않는 것, detail=태그별) · `bindata`(그림·첨부 내용 멀티셋) · `ole-clsid`(HWP: BinData 안 OLE 루트 CLSID) · `cfb`(HWP: 필수 스트림·구역 수) · `package`(HWPX: `check_package`). HWP 쪽 검사는 업스트림 `hwp5_roundtrip_batch` 의 것을 그대로 쓴다 — 0001 에 보이기만 바꾸는 `pub(crate)` 4곳(`cfb_structure_ok`·`bindata_fingerprint`·`nested_ole_clsid_fingerprint`·`multiset_lost`, 0001 은 6 파일). 배치 도구 자체(`run`·`build_inventory`)는 파일을 읽고 써서 WASM 에서 못 쓰므로 그 안의 메모리 검사만 부른다. 쪽수 비교(C3)는 조판이 무거워 넣지 않음. 문구 이름표 `collab-client/src/session/roundtrip.ts` 를 이 kind 로 맞춤(ir 은 "곳"). **업스트림 샘플 측정**(3MB 미만 396건, Rust release, 읽기만): **통과 386 · 경고 7 · 열 수 없음 3(암호 문서)**, 대개 수십 ms. 경고: `record` CTRL_DATA×1 (hongbo 계열 2건·월간 수출입 현황 1건), `record` 1902(변경 추적 문서 issue5169 — 숨은 변경 기록은 원본 바이트에만 있다), `ir` 4(hongbo_saved·honbo-save — 그림 `imgDim` 이 원본 (0,0) 인데 다시 쓰면 채워짐; 업스트림은 같은 형식 왕복에서는 이것도 계약 위반으로 본다), `bindata` 1/1(hwp3-sample10, 원인 미확인). **점검이 맞는지**: hongbo 의 구역 0 에 한 글자 넣고 저장하면 CTRL_DATA 가 2 → 1 로 실제로 사라짐(그대로 저장은 2). **시험** Rust collab **85/85**(+2: 모델에서 다 쓰는 문서는 HWP·HWPX 모두 통과·문서 그대로, 캐시 덕에만 남는 레코드를 `record` 로 알림), WASM 직접 호출(hongbo 경고 32ms, aift.hwpx 통과 718ms), 서버 8787 POST /rooms 응답·로그에 결과(경고/통과), 서버 **78 + 2 건너뜀(보조 없는 흐름 둘)**, collab-client **81/81**, 지문 `981ce66b4183-18edfad9d341-cfbc7c54095d-d0e76ac479bb` |
| 2026-11-28 | **결과 다시 쓰기 강화 1단계**(HWP 자리 + 본 바이트 기록, 기존 코드 세션) | 규약 §8.1 의 남는 자리 (가)(나)를 막는다. 새 파일 `collab-core/src/rewrite_raw.rs`: 모델 안 날 바이트 자리를 모두 한 번에 걷는 걷기 + 자리별 방식, `rewrite_state` 가 **원본 바이트를 버린 구역·DocInfo 에만** 적용(정본의 봉인된 바이트를 그대로 쓰는 구역은 그 날 바이트도 정본 것). 방식: (B) 사양 모양 — 문단 머리 꼬리 길이 0·10·12(더 길면 자름), 렌더링 행렬 길이 = 50 + 96N(N = 앞 u16), 문서 속성 26바이트 / (C) 그 밖 HWP 자리 전부(CTRL_DATA·묶음 자식 CTRL_DATA·개체 공통 꼬리·표 머리·표 레코드 꼬리·셀 꼬리·그림 꼬리·글상자 꼬리·연결선·다각형 꼬리·차트·OLE 태그·머리말/꼬리말 꼬리·바탕쪽 목록 머리·구역 정의 꼬리·구역 정의 자식 레코드·DocInfo 항목 원본) — **종류마다 문서 전체에서 같은 내용**(개수는 보지 않음, 종류는 넘나들지 않음, SHA-256), 아니면 비워 저장기가 모델에서 다시 만들거나 기본값. 봉인은 건드리지 않는다. 견줄 때 가리는 숫자 바이트: 그림 꼬리 1..5(개체 번호), 구역 정의 꼬리 2..4(바탕쪽 목록 수)·6..8(메모 모양 번호), 바탕쪽 목록 머리 18..20, 셀 꼬리 0..4(글 영역 너비) — 저장기나 정상 편집이 고쳐 쓰는 자리. 표·수식 머리는 계획의 "늘 다시 만듦" 대신 본 것이면 두고 아니면 비워 `common` 으로 다시 만든다(늘 다시 만들면 깨끗한 문서도 빈 설명 필드 4바이트만큼 바뀐다). 구역 정의 자식 레코드는 원본 바탕쪽 목록에 모르는 것이 있으면 그 범위를 모두 버려 모델이 쓰고 끝 목록 투영을 다시 봉인. **본 바이트 기록(결정 2)**: `CollabCore.raw_seen` — `track_raw_seen()`(WASM `collabTrackRawSeen`, 정본 워커가 열자마자 부를 자리)이 켜고, 결과를 읽을 때마다 읽기 전·후 문서, 다시 쓰기 직전의 정본을 더 모은다(켜지지 않은 클라이언트는 비용 없음). `rewrite_state` 는 `&mut self`(+ 바꾼 자리 수를 주는 `rewrite_state_report`). **회귀 원인**(메모 모양 시험): 구역 정의 꼬리 6..8 은 메모 모양 번호라 저장기가 모델(`section_def.memo_shape_id`)에서 고쳐 쓴다 — 메모 모양 op 는 모델만 바꾸므로 정본의 날 바이트는 옛 값(0), C 는 새 값(1) → 모르는 것으로 버려져 저장기가 10바이트 기본값으로 써 19바이트 사양 길이·언어를 잃었다 → 그 자리를 가림. **시험** Rust collab **88/88**(+3: 아홉 종류 자리에 끼운 것 모두 사라지고 내용 그대로 / 끼운 것 없는 결과는 하나도 바꾸지 않음·digest 같음 / 열 때부터 모은 정본은 표를 지운 op 뒤에도 되살린 CTRL_DATA 를 남김, 모으기 전에 지워졌으면 버림, 결과를 읽은 경우도), 서버 **78 + 2 건너뜀**, collab-client **81/81**, R5 `--rewrite-state` 200×200 `--verify-fast` 실패 0·`--s3` 100×200 실패 0(harness 정본도 열자마자 기록을 켬), 지문 `981ce66b4183-18edfad9d341-80b024d074aa-d0e76ac479bb`, 패치 변경 없음. 남은 것: 2단계 HWPX 원문 조각, 3단계 op 인자 문, 워커 두 줄 |
| 2026-11-28 | **S2 서버 쪽: 실제 보조 확인·전수 측정·시간 상한** (배포 세션) | **전수 측정**(업스트림 샘플 485개, `scripts/roundtrip-survey.mjs` — 산출물은 저장소 밖): 통과 474 · 경고 8 · 암호 3 · 점검 오류 0. 경고 kind(문서 수/개수 합): record 5/1917(CTRL_DATA 문서 4개 — 1·1·1·12개, issue5169_viewtext_changetracking 1902개는 배포용 ViewText 문서로 보여 따로 볼 일), ir 2/8(hongbo 저장본 둘 — 표 셀 안 그림), bindata 1/1(hwp3-sample10). 점검 시간 중앙값 7.3ms · p95 2.3초 · 최대 64.1초(issue2063_huge_cellbreak_table, 0.7MB — 여는 것만 32초), 13MB 문서 열기 0.43 + 점검 1.31초. **편집 뒤 실제로 잃는지**(편집 없이 저장 vs 구역마다 한 글자 넣고 지운 뒤 저장, 스트림별 레코드·BinData 내용·다시 연 digest): sungeo CTRL_DATA×12·수출입 현황 ×1·hongbo ×1 모두 실제로 사라짐(sungeo 는 다시 연 digest 도 달라짐), hongbo_saved 는 레코드 손실 없이 다시 연 모델이 달라짐(점검의 ir: 그림 원본 크기 imgDim 0 → 실제 값 — 잃음이 아니라 값이 채워짐). **hwp3-sample10 bindata**: 유일한 BinData 가 이름 `BIN0000.`(id 0·확장자 없음 — HWP5 는 1부터)이고 내용이 비어 있다(2바이트 = 빈 deflate). 편집 여부·저장 경로와 무관하게 저장본에 남고, HWP5 저장본을 다시 열어 점검하면 통과 — 점검이 HWP3 원본을 HWP5 로 처음 옮기는 단계에서만 걸린다(잃는 내용 없음, 거짓 경고에 가깝다). **시간 상한**(결정): `COLLAB_ROUNDTRIP_TIMEOUT_MS`(기본 15초). 점검은 따로 둔 워커에서(정본 워커를 붙잡지 않음), 열기 + 점검이 상한을 넘으면 그 워커를 버리고 `{ok: null, reason: 'timeout'}`(워커 실패는 `'error'`). warn: 응답 `roundtrip: {pending: true}`, 끝나면 방 메타(`setRoundtrip`)에 남기고 통과가 아니면 방에 있는 참여자에게 새 메시지 `roundtrip` 을 한 번, 그 뒤는 welcome. block: 상한까지 기다려 통과가 아니면 422(`reason` roundtrip · roundtrip-timeout · roundtrip-error). 클라이언트: 세션이 `roundtrip` 메시지를 안내로(welcome 과 합쳐 한 번), launcher·업로드 페이지는 pending 이면 "결과는 방에 들어가면 보입니다", 점검 못 함·시간 초과 거절 문구. 업로드 페이지 이름표를 3b 의 kind 로. 시험: roundtrip.test 6(대역 보조의 답·시간을 정함 — 점검 1.5초 동안 편집 확정 1초 안, 상한 300ms 면 곧 timeout·알림·메타·welcome, block 422 roundtrip-timeout, 진짜 보조로 깨끗한 문서·모르는 레코드 문서), 위조 도우미를 `server/test/support/hwp-forge.mjs` 로. 서버 81 + 건너뜀 2, collab-client 82, studio tsc, 브라우저 s5-deploy 15/15·d3-launcher 9/9. 남은 것: issue2063 은 여는 것만 32초라 정본 워커 시간 제한(30초)을 넘어 방을 만들 수 없다(제한을 120초로 늘려도 방 생성 66초 — 점검과 별개인 rhwp 성능 문제) |
| 2026-11-28 | **사용성 다듬기: 이름 묻기·오래 걸리는 문서 안내** (배포 세션) | ① launcher "이 방으로 들어가기": hs256 만들기 토큰(JWT payload)에 `name` 이 있으면 편집 링크의 주소 조각에 `#name=` 을 실어 다시 묻지 않는다(나눠 주는 링크에는 싣지 않음, 서명 확인은 서버 몫 — `tokenName`·`withName`). ② 이름 묻기를 `window.prompt` 대신 화면 안 입력 칸으로(`data-collab="name-prompt"`·`name-input`·`name-submit`, studio 단축키가 그 칸의 키를 가져가지 않게, 빈칸이면 anon, 기억은 그대로 localStorage). 묻는 동안은 연결하지 않고(세션 `setName` 뒤 `start`), 주소에 이름이 있거나 기억한 이름이 있거나 토큰이 없으면 지금처럼 곧바로 연결. 부품 전용 서버(healthz embedOnly)면 묻지 않는다(바깥 시스템의 토큰이 사용자를 안다). ③ 정본 워커가 여는 데 시간 제한(`COLLAB_CANONICAL_TIMEOUT_MS`, 값은 그대로)을 넘기면 `POST /rooms` 는 `422 {error: 'too-slow'}`(Canonical 시간 초과 결과에 `timeout: true`), 업로드 페이지·launcher 는 "문서가 커서 여는 데 너무 오래 걸립니다. 공동편집으로 쓰기 어렵습니다". 시험: 서버 `too-slow.test.mjs`(대역 pkg 가 HwpDocument 를 만들 때 잠금 — 제한 400ms·여는 데 1.5초면 422 too-slow, 방 없음, 제때면 201), launcher 시험(too-slow 문구, `tokenName` 패딩·이름 없는 토큰·JWT 아님, `withName`). 브라우저: d3-launcher 인증 없음 9/9·**hs256 13/13**(B 는 화면 안 칸으로 물음·대화상자 없음, 만든 사람은 묻지 않고 토큰의 이름 — 같은 브라우저에 B 의 이름이 기억돼 있어도 주소의 이름이 이김), s5-deploy **16/16**(7b: 이름 없는 초대 링크 → 칸, 묻는 동안 연결 안 함, 그 이름으로 입장, 새로고침하면 기억한 이름), s6-embed **8/8**(6: 부품 전용은 이름 없는 링크여도 칸·대화상자 없음), R7 10/10, R8 22/22, R10 6/6, T4 30/30, S3-4 4/4, u1-undo 10/10, s1-rewrite 5/5. 서버 82 + 건너뜀 2, collab-client 83, studio tsc |
| 2026-11-28 | **결과 다시 쓰기 강화 2·3단계 + 워커**(기존 코드 세션) | **HWPX 원문 조각**을 "정본이 본 내용일 때만"에 더함: `memo_properties_xml`(비우면 메모 모양 레코드로 다시 쓴다)·`hwpx_head_tail`(비우면 기본 문서 설정)·`Numbering.raw_para_heads`·`Bullet.raw_para_head`(비울 때 `Bullet::image_reference` 가 읽는 그림 번호를 `image_bullet` 에서 `image_data[3]` 으로 옮긴다 — 255 초과면 잃음)·`Field.raw_parameters_xml`. HWPX 파서가 만드는 렌더링 행렬도 50 + 96N 모양이라 사양 모양을 통과(확인). **op 인자 문**(결정 3): collab-core `check_op_args` / WASM `collabCheckOpArgs(method, argsJson)` → `{ok}`·`{ok:false, reason}` — 문단 나누기 다섯 함수의 `removedParaMeta.raw_header_extra` 길이가 0·10·12 가 아니면 거절. **pasteHwpJson 은 결정 (2)**: 조각의 XML 은 한컴 원문이 아니라 `hwpjson_to_hwpx_parts` 가 JSON 모델에서 rhwp 틀로 만든 것이고 값은 숫자·`esc_attr`/`esc_text`(`attrs` 도우미 포함)로만 들어가 원문 통로가 아니다 — 한때 넣은 (ii)(모든 참여자가 조각 원문을 비우는 표지·0001 두 줄)는 "모두가 표지를 켜야 수렴" 조건을 늘 지게 되어 걷어 냄(0001 은 강화 전과 같음, 지문 `…6a0c408f0a11…`). JSON 에서 XML 을 거치지 않고 문서로 가는 것은 그림 바이트(`bins`)뿐(HWPX 파서가 스스로 만드는 문단 머리 꼬리 10바이트·바탕쪽 목록 머리는 숫자). 대신 회귀 방어 시험: 악의적인 값(`"><x/>`·`</hh:paraHead><evil/>`·`&`·제어 문자)을 담은 조각을 붙여도 원문 조각 자리에 rhwp 가 만든 요소(paraHead·img·memoProperties·memoPr)만 있고 값은 글자 그대로(번호 형식·본문), 제어 문자는 받아도 글자로만 남거나 붙여넣기 전체가 실패. 발견: 업스트림 HWPX 파서가 글머리표 `char` 속성을 풀지 않고 읽어 `&quot;` 가 '&' 가 된다(통로 아님, 충실도 결함 — 시험은 고쳐지면 '"' 도 받는다). **워커 두 줄**(`server/canonical-worker.mjs`): `open()` 에서 문서를 만든 직후 `collabTrackRawSeen`(재시작 복원도 기록 재생 전), `apply` 에서 `validate` 바로 뒤 `opArgsViolation`(→ `invalid`). **시험** Rust collab **94/94**(+6: HWPX 원문 조각 끼움 사라짐·끼운 것 없으면 그대로·HWPX 메모 모양 op 유지·그림 글머리표 그림 번호 유지·op 인자 문·한컴 조각 이스케이프), 새 서버 시험 `server/test/op-args.test.mjs` 2(실제 서버: 꼬리 64바이트는 invalid·정본 그대로, 10바이트와 메타 없는 Enter 는 받음, 정본 경로), 서버 **84 + 2 건너뜀**, collab-client **83/83**, 지문 `981ce66b4183-18edfad9d341-6a0c408f0a11-d0e76ac479bb`, 패치 둘 다 그대로. 규약 §8.1 을 "다시 쓸 때의 날 바이트 자리"로 고쳐 씀(방식·자리·op 인자·pasteHwpJson·한계 — 결정 2 의 논리 포함) |
| 2026-11-28 | **S2 보충: 빈 BinData 는 비교에서 뺀다**(기존 코드 세션) | hwp3-sample10 의 `bindata 1/1` 경고는 거짓 경고였다 — HWP3 파서가 그림 번호마다 채워 두는 빈 자리(id 0, 확장자 없음)를 연결(Link) 그림은 덮어쓰지 않고, HWP5 저장기가 그 자리를 빈 deflate `BIN0000.` 스트림(2바이트)으로 쓴다. 그 저장본을 다시 읽으면 아무 BinData 레코드도 가리키지 않아 모델에 남지 않는다(1세대 저장본에는 있고 2세대에는 없음 — pkg 로 직접 확인). 규칙: **내용(압축을 푼 뒤)이 빈 BinData 는 잃을 것이 없어 원본 쪽 지문에서 뺀다**(HWP3 갈래가 아닌 일반 규칙) — 업스트림 `bindata_fingerprint` 결과에서 빈 내용의 열쇠만 지운다(같은 해시 방식; 업스트림이 바꾸면 경고로 드러난다). 시험 +2(hwp3-sample10 은 bindata 를 보고하지 않음·저장본에 빈 항목 하나 있음을 전제로 확인 / 빈 열쇠만 빠지고 내용 있는 항목이 사라진 것은 그대로 셈). Rust collab **110/110**(U3 합친 판), 서버 **88 + 2 건너뜀**, 지문 `981ce66b4183-501584aa365e-d48f923e886b-d0e76ac479bb`. 업스트림 보고 후보: HWP5 저장기가 HWP3 연결 그림 빈 자리를 사양 밖 이름의 빈 스트림으로 쓴다 |
