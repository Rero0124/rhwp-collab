# 공동편집 5단계: 배포 준비 (인증, HTTPS, 파일로 방 열기)

순서 (사용자 결정, 2026-11-27): 4단계와 **병렬로** 진행한다.
- 4단계(되돌리기)는 기존 코드 세션이 맡는다.
- 이 단계는 별도 코드 세션이 별도 worktree(`collab/deploy` 브랜치)에서 맡는다.

**분담과 경계:**
- 이 단계에서 건드리지 않는 것: `patches/rhwp/*`, `collab-core/`, `collab-client/src/engine/`, 분류표·지문 스크립트.
  패치 파일은 두 세션이 동시에 고치면 합치기 어렵고, 엔진이 바뀌면 지문이 바뀌기 때문이다.
- `collab-client/src/plugin.ts` 는 이 단계에 필요한 최소한만 고친다. 토큰 읽기, `unauthorized` 처리, 보안 컨텍스트
  확인, 같은 출처 기본 주소가 그것이다. 한곳에 모아 둔다. 두 브랜치를 합치는 일은 설계 세션이 한다.
- D3 의 "studio 에서 시작"(0002 패치가 필요함)은 4단계가 끝난 뒤 기존 코드 세션이 한다. 이 단계의 D3 는 서버 API 와
  업로드 페이지까지다.

지금 상태로는 이 컴퓨터에서만 쓸 수 있다.
- 서버는 기본값으로 `127.0.0.1`에서만 받는다.
- 플러그인이 쓰는 `crypto.randomUUID`는 보안 컨텍스트(HTTPS 또는 localhost)에서만 있다. 그래서 다른 기기에서
  http 주소로 열면 동작하지 않을 가능성이 높다(미확인, D2 에서 확인한다).
- 방 문서는 첫 참여자가 그때 열어 둔 문서(없으면 빈 문서)로만 정해진다.

이 단계의 목표는 **다른 기기의 다른 사람이 링크로 들어와 정해진 파일을 함께 편집하는 것**이다.

## 원칙

rhwp-collab 은 부품이다. 실제로 쓰는 곳(회사 문서 시스템 등)에는 이미 로그인과 파일 보관이 있다. 그래서 사용자
계정이나 파일 목록을 직접 만들지 않는다. 대신 **바깥 시스템이 끼워 넣을 수 있는 자리**를 만들고, 혼자 시험할 수
있는 간단한 기본 구현을 하나 둔다.

## D0 인증은 studio 가 아니라 규약과 세션 계층에 둔다 (사용자 지적, 2026-11-27)

나중에 네이티브 클라이언트로 넓힐 예정이다. 그래서 인증이 studio 플러그인에 묶이면 안 된다.

- **문서 코어에는 넣지 않는다.** rhwp 와 `CollabCore` 는 문서를 편집하는 계층이고, 인증은 누가 접속하는지를 다룬다.
  토큰을 검증하는 곳은 서버뿐이고, 클라이언트는 토큰을 들고 가기만 한다.
- **규약 문서:** `docs/collab-protocol.md` 를 만든다. 메시지 형식(hello·welcome·ops·catchup·reject·invalid·
  unauthorized 등), 토큰 클레임, 오류 이유 코드, 재접속 절차를 플랫폼과 무관하게 적는다. 웹이든 네이티브든 이
  문서만 보고 클라이언트를 만들 수 있어야 한다. `server.mjs` 첫머리 주석은 이 문서를 가리키게 한다.
- **클라이언트 인증 계층:** `collab-client/src/session/` 에 플랫폼 중립 모듈을 둔다. DOM·studio 에 의존하지 않는다.
  - 토큰 공급자 인터페이스: `getToken({room, reason: 'connect' | 'reconnect' | 'expired'}) → Promise<string>`.
    `unauthorized{reason:"expired"}` 를 받으면 한 번 더 받아 다시 시도하고, 그래도 안 되면 포기한다. 토큰 갱신은
    호스트(studio, 네이티브 앱, 바깥 시스템)가 각자 방식으로 한다.
  - hello 만들기와 인증 오류 분류도 여기에 둔다.
  - studio 쪽 구현(`#token` 조각 읽기, 안내 문구)만 `plugin.ts` 에 남긴다.
- **서버 인증 계층:** `server/auth.mjs` 의 `verify(token, room) → {sub, name, scope}` 하나로 모은다. `hs256`·`url` 은
  이것의 구현이다. 바깥 시스템이 자기 검증 함수를 끼울 수 있게 한다.
- **프록시 계층마다 맡는 자리 (사용자 보충):** 공동편집은 처음부터 "core 와 호출자 사이의 프록시"로 짰다. 인증과
  권한도 그 프록시들에 적재적소로 넣는다. core 는 바꾸지 않는다.

  | 자리 | 맡는 일 | 네이티브에서 |
  |---|---|---|
  | 세션(연결) | 토큰 받기·갱신, hello 에 싣기, `unauthorized` 처리 | 같은 규약을 구현 |
  | 클라이언트 기록 프록시(export 경계, `CollabEngine`) | **권한 문(門):** 편집 권한이 없으면 편집 호출(분류표 op·state·watch)을 core 에 닿기 전에 거절한다. none·local 은 통과. UI·hwpctl·플러그인·document-agent 등 **모든 호출 경로**가 이 한곳을 지난다. | `self.core` 자리의 `CollabCore` 가 같은 판정을 한다 |
  | 서버 중계 | 접속 인증(hello), 메시지 종류별 권한(ops·base·resync·cursor·digest), 기록 항목에 `sub` 를 **서버가** 찍음(클라이언트가 보낸 값은 믿지 않음) | 그대로 |
  | 서버 정본 | 권한 없는 묶음은 정본에 적용하기 전에 거절(보안상 최종 판정. 클라이언트 문은 사용성용) | 그대로 |
  | HTTP API | 범위(`scope`)별로 방 만들기·문서 내려받기 허용 | 그대로 |

- **권한(`scope`):** `edit`(기본)와 `view` 를 둔다. 위 표 때문에 보기 전용은 작은 일이 되었으므로 이번에 넣는다.
  `view` 는 문서와 다른 사람 커서를 받고 자기 커서는 보내지만, 편집·base·state 는 보낼 수 없다. studio 화면을
  읽기 전용으로 바꾸는 일(편집 UI 비활성화)은 studio 에 그런 모드가 있는지 조사해서, 있으면 쓰고 없으면 후보로 둔다.
  클라이언트 문이 있으므로 UI 를 막지 못해도 문서는 바뀌지 않는다.
  - 클라이언트 기록 프록시의 문은 `collab-client/src/engine/` 을 고쳐야 하므로, 4단계 U1 을 합친 뒤 기존 코드 세션이
    한다. 서버 쪽(중계·정본·API)과 규약은 이 단계의 세션이 한다.
- **이번에 하지 않는 것:** `plugin.ts` 의 연결·재접속 상태 기계 전체를 `session/` 으로 옮기는 일. 4단계가 같은 파일을
  고치고 있어서 지금 옮기면 충돌이 크다. 4단계를 합친 뒤 따로 한다.
- **네이티브를 위한 메모(이번 범위 밖):** 지금 편집 기록 엔진(되감기·재적용 조율)은 TypeScript 에 있다. 보정 계산은
  이미 Rust(`collab-core`)에 있다. 네이티브에서도 같은 동작을 쓰려면 엔진의 조율 부분도 Rust 로 옮기거나, 네이티브가
  같은 규약을 따로 구현해야 한다. 네이티브 계획이 구체화되면 정한다.

## D1 인증

- **토큰:** JWT HS256 을 쓴다(어느 언어에서나 라이브러리로 만들 수 있게). 클레임은 다음과 같다.
  - `sub`: 사용자 식별자
  - `name`: 커서에 보일 이름
  - `room`: 들어갈 수 있는 방. 방 이름 하나 또는 `*`
  - `exp`: 만료 시각
  - (선택) `scope`: `create` 면 방 만들기 API 도 쓸 수 있다(D3)
- **전달:** 토큰은 주소의 조각 `#token=…` 으로 받는다. 조각은 정적 파일 서버로 가지 않는다. 플러그인은 토큰을
  읽은 뒤 `history.replaceState` 로 주소에서 지운다. 토큰은 서버에 `hello` 로 보낸다(주소 쿼리 문자열에 싣지
  않는다).
- **서버 확인:** `hello` 를 받으면 welcome 전에 확인한다. 실패하면 `{type:"unauthorized", reason}` 을 보내고 닫는다.
  커서 이름은 주소의 `name` 대신 토큰의 `name` 을 쓴다. 기록 항목에 `sub` 를 남긴다(나중의 작성자 표시·감사용).
- **확인 방식 (`COLLAB_AUTH`):**
  - `none`: 지금처럼 확인하지 않는다. `HOST` 가 루프백이 아니면 시작을 거부한다. 단, 명시적으로 `COLLAB_AUTH=none`
    을 준 경우는 허용하고 경고를 남긴다.
  - `hs256`: `COLLAB_AUTH_SECRET`(또는 `COLLAB_AUTH_SECRET_FILE`)로 서명을 확인한다.
  - `url`: `COLLAB_AUTH_URL` 로 `{token, room}` 을 POST 하고 `{ok, sub, name}` 을 받는다. 바깥 시스템의 기존 세션을
    쓰는 경우다.
  - 기본값: `HOST` 가 루프백이면 `none`, 아니면 설정이 없을 때 시작을 거부한다.
- **재접속:** 다시 붙을 때도 `hello` 에서 확인한다. 만료되었으면 `unauthorized` 를 받는다. 이때 플러그인은 다시 붙기를
  멈추고 "인증이 만료되었습니다. 다시 열어 주세요"를 띄운다. 보내지 못한 편집이 있다는 것도 알린다.
- **Origin:** `COLLAB_ALLOWED_ORIGINS` 가 있으면 WebSocket 업그레이드의 Origin 을 확인한다.
- 권한(`scope`: edit·view)은 D0 의 "프록시 계층마다 맡는 자리"를 따른다.

## D2 HTTPS / wss

- **한 출처로 띄우기:** 서버가 빌드한 studio 정적 파일도 내준다(`COLLAB_STATIC_DIR`). 그러면 `https://호스트/`
  가 편집기이고 `wss://호스트/` 가 공동편집 서버다. 인증서는 한 번만 설정하면 되고, Origin 확인도 단순해진다.
  - studio 빌드: `scripts/build-studio.sh`(vite build, 플러그인 alias 포함)를 만든다. dev 서버(`npx vite`)는 개발용으로
    남긴다.
  - 같은 출처일 때는 플러그인이 `collab` 매개변수가 없어도 `wss://<현재 호스트>` 를 기본값으로 쓴다.
- **TLS:** `COLLAB_TLS_CERT`·`COLLAB_TLS_KEY` 가 있으면 서버가 직접 HTTPS/wss 로 뜬다. 없으면 http 로 뜨고, 앞단
  역방향 프록시(nginx, Caddy 등)가 TLS 를 맡는 경우를 README 에 적는다.
- **보안 컨텍스트 확인:** 플러그인이 `window.isSecureContext` 가 아니면 "공동편집은 HTTPS 에서만 쓸 수 있습니다"
  를 띄우고 들어가지 않는다(지금은 오류로 멈출 것으로 보인다). 보안 컨텍스트가 필요한 다른 API 가 있는지도 확인한다.
- **시험:** 실제 다른 기기로 한다. Mac 에서 서버를 `HOST=0.0.0.0` + 자체 서명 인증서로 띄우고, Windows 기기(사용자가 허락한 시험 기기)의 Chrome 이 LAN 주소의 https 로 접속한다. 인증서 오류는 시험 프로필에서만 무시한다. 시험이
  끝나면 서버를 내리고 Windows 의 임시 프로필을 지운다. http 로 열었을 때의 실제 동작도 이때 확인해 기록한다.

## D3 파일로 방 열기

- **서버 API (바깥 시스템용, 주 경로):**
  - `POST /rooms` (본문 = HWP/HWPX 바이트, `Authorization: Bearer <scope=create 토큰>`): 정본으로 열어 검사한
    뒤 새 방을 만들고 `{room}` 을 돌려준다. 저장소(S3-3)의 처음 base 가 된다. 크기 상한은 기존 상한을 따른다.
  - `GET /rooms/{room}/document` (`room` 이 맞는 토큰): 최신 문서 파일(정본 내보내기, 원본 형식)을 내려준다.
  - 이 API 가 있으면, 바깥 시스템은 자기 파일로 방을 만들고 사용자에게 `https://호스트/#token=…&room=…` 링크만 주면 된다.
- **studio 에서 시작 (혼자 시험·소규모 사용):** 혼자 쓰던 문서를 그 자리에서 공동편집으로 돌리는 명령이다.
  - 흐름: "공동편집 시작" → 지금 문서로 방 만들기 → 공유 링크 복사.
  - 플러그인이 메뉴나 명령을 등록할 수 있는지, 페이지를 연 뒤에 플러그인을 올릴 수 있는지를 먼저 조사한다.
  - 0002 패치를 많이 늘려야 하면 이번에는 서버 API 와 간단한 업로드 페이지(서버가 내주는 정적 페이지 하나)로
    대신하고, studio 메뉴는 후보로 둔다.
- 방 이름은 서버가 만든다(추측하기 어려운 무작위 값). `room` 을 주소에서 임의로 만들어 들어가는 지금 방식은
  `COLLAB_AUTH=none` 일 때만 허용한다.

## D4 양식 입력·메모 권한 (사용자 결정, 2026-11-27)

`scope` 에 두 가지를 더한다. 목록이라 함께 줄 수 있다(예: `form comment`).
- `form`: 양식만 채운다. 누름틀 안의 글자와 양식 개체(체크박스·라디오·콤보·입력란)의 값만 바꿀 수 있다.
  누름틀을 만들거나 지우거나 이름·속성을 바꾸는 것은 양식의 구조를 바꾸는 일이므로 `edit` 이다.
- `comment`: 메모만 단다. 메모 넣기·답글·고치기·지우기와 메모 모양을 바꿀 수 있고, 본문은 못 고친다.
- 둘 다 보기는 `view` 와 같다.

관련 export(분류표 기준):
- 양식: `setFormValue`(op), `setFormValueInCell(Ex)`(state), `applyFormActionUpdates`(state), `setFieldValue`·
  `setFieldValueByName`(op). 누름틀 안 입력은 일반 글자 연산에 `ctx.activeField` 가 붙은 형태다.
- 메모: `insertMemo`·`insertMemoByPath`·`insertMemoReply`·`removeMemo`·`setMemoShape`·`setMemoText`(모두 state).

### 판정은 두 겹이다

1. **클라이언트 기록 프록시의 문 (사용성, 빠름).**
   - 분류표에 `perm` 표시를 더한다. 값은 `form`·`memo`이고, 표시가 없으면 `edit` 이다. 새 함수는 `edit` 가 되어
     좁은 권한에서는 막힌다.
   - 글자 연산은 `form` 권한일 때만 판정이 더 필요하다. `ctx.activeField` 가 있고, 연산 범위가 그 누름틀 안에
     완전히 들 때만 통과시킨다(Rust 보조 `collabFieldContains`).
   - 문에서 막히면 core 에 닿지 않고 안내만 뜬다("양식 칸에만 입력할 수 있습니다", "메모만 달 수 있습니다").
2. **서버 정본의 확인 (보안상 최종 판정).**
   - 클라이언트가 보낸 함수 이름이나 state 바이트는 믿지 않는다. 그래서 `form`·`comment` 연결의 묶음은 정본이
     스냅샷을 뜬 뒤 적용해 보고, **바뀐 곳이 허용된 부분뿐인지**를 Rust 보조 `collabCheckConfined(snapshotId, kind)`
     로 비교한다. 벗어나면 되돌리고 `forbidden` 을 보낸다.
   - 비교 규칙(조사 후 확정):
     - 구역은 허용 부분을 가린 채 같아야 한다. `form` 은 누름틀 안 글자와 양식 개체 값을 가리고, `comment` 는 메모
       개체와 그 내용을 가린다.
     - 줄 배치(`line_segs`)는 비교하지 않는다. 앞 문단이 늘면 뒤 문단 위치가 바뀌는 조판 결과라서다.
     - DocInfo 는 **앞부분이 같아야 한다**(기존 항목은 그대로, 새 글자 모양 등은 뒤에 덧붙는 것만 허용). 기존 글자
       모양을 고쳐 본문 모양을 바꾸는 우회를 막기 위해서다.
   - 이 확인은 op 와 state 모두에 쓴다. 함수 이름과 무관하게 결과로 판정하므로 우회할 수 없다.

### 분담
- 기존 코드 세션(4단계 U1 뒤, U2 전): 분류표 `perm`, 클라이언트 문(view·form·comment), Rust 보조
  `collabFieldContains`·`collabCheckConfined`.
- 이 단계의 세션: 규약의 scope 목록, 서버 중계·정본의 판정 연결. `collabCheckConfined` 가 합쳐지기 전에는 `form`·
  `comment` 연결의 편집 묶음을 `forbidden`(reason `unsupported`)으로 거절한다. 초대 토큰은 `form`·`comment` 도 만든다.

## 관문

- 다른 기기(Windows Chrome)가 LAN https 로 들어와 Mac 과 함께 편집한다. digest 가 일치하고 재동기화가 0 이다.
- 인증: 잘못된 서명, 만료, 다른 방 토큰, 토큰 없음이 모두 `unauthorized` 로 거절된다. 재접속 중 만료되면 안내가 뜬다.
- 권한: `view` 는 편집이 막힌다. `form` 은 누름틀 안 입력과 양식 값만, `comment` 는 메모만 된다. 그 밖의 편집은 클라이언트 문에서 막히고, 문을 우회한 원시 클라이언트가 보낸 묶음은 서버 정본이 `forbidden` 으로 거절하며 seq 는 그대로다. 우회 사례: 함수 이름 위조, state 바이트 위조, 기존 글자 모양 고치기.
- `POST /rooms` 로 만든 방에 두 브라우저가 들어오고, `GET …/document` 가 편집이 반영된 파일을 준다. 그 파일을
  다시 열면 digest 가 같다(내보내기 후 다시 읽기 규칙에 따름).
- 기존 회귀: 서버, collab-client, R8, R7, S3-4.
- README 의 실행·설정 절을 이 단계에 맞게 고친다.

## 기록

| 날짜 | 항목 | 결과 |
|---|---|---|
| 2026-11-27 | 결정(설계 세션 답 Q1~Q7) | Q1 링크는 `?collab#token=…&room=…`(값이 빈 `collab` = 같은 출처 wss). studio 는 `location.search` 에 `collab` 이 있을 때만 플러그인을 올리므로(0002 `main.ts`) `#token` 만으로는 뜨지 않는다 → 0002 에서 `#token` 으로도 올리기는 3b 후보. Q2 JWT HS256 직접 구현(alg 정확히 HS256, 엄격한 base64url, 길이 확인 뒤 timingSafeEqual, exp 필수·nbf 확인·시계 오차 30초, 서명은 시험·발급 도구용). Q3 Node 내장 http/https 하나에 ws(noServer)·HTTP API·정적 파일. Q4 만들기 토큰을 링크에 싣지 않고 POST /rooms 가 방 전용 초대 토큰(권한마다, name 없음, `COLLAB_INVITE_TTL` 기본 24시간)을 만든다(hs256 만). Q5 토큰은 sessionStorage 에 방별로. Q6 이유 코드 + 권한 밖 메시지는 `forbidden`(연결 유지). Q7 sub 는 서버가 찍고 같은 방에 보인다(비밀·개인 식별 정보 금지). 추가: unauthorized `scope`(들어갈 권한이 없음), 내려받기는 참여 권한만(create 제외) |
| 2026-11-27 | D0 구현 | `docs/collab-protocol.md`(메시지 전체·클레임·권한·이유 코드·재접속·클라이언트 권한 문 규칙·HTTP API·보안 메모). `server.mjs` 첫머리 주석은 이 문서를 가리킨다. `collab-client/src/session/`(DOM·studio 의존 없음): `AuthSession`(연결마다 `getToken({room, reason})`, expired 면 한 번 갱신 뒤 곧바로 다시 붙고 또 만료면 포기, unavailable 은 백오프, 갱신 판단 중에 다시 붙으면 hello 는 판단 뒤 새 토큰), `buildHello`, 이유 코드 분류, `editLevel`. `server/auth.mjs`: `verify(token, room) → {sub, name, scope}` 하나로 — `noneAuth`·`hs256Auth`(+`issue`)·`urlAuth`, 끼운 함수는 `startServer({auth: {mode, verify}})`, `authFromEnv`(루프백이면 none, 아니면 설정 없이 시작 거부, 명시한 none 은 경고, 비밀키 32바이트 미만 거부). 연결·재접속 상태 기계는 옮기지 않음(D0) |
| 2026-11-27 | D1 구현 | 서버: hello 를 welcome 전에 확인 — 토큰 없음 → 서명·만료(auth) → 권한(view·form·comment·edit 중 하나) → 방 있음(메모리 또는 저장소, 토큰 확인 뒤에 봄) 순서, 실패하면 `unauthorized{reason}` 후 4401 로 닫음. 이름 없는 토큰은 표시 이름 = hello.name(확인 안 된 값, 없으면 "손님"), sub = 토큰 sub + `~` + 연결마다 무작위 꼬리. welcome·catchup 에 `user{sub, name, scope}`(인증을 켰을 때만 — 기존 시험의 welcome 모양 그대로). 기록 항목(ops 방송·메모리 기록·log.jsonl·catchup)에 서버가 찍은 `sub`(클라이언트가 보낸 sub 무시). 권한: view 의 ops·base → `forbidden{what, reason:'scope', batchId}`(연결 유지·seq 그대로·방송 없음), base 담당은 edit 만, 정본이 없는 방에서 edit 가 아닌 연결의 digest 는 처음 보고로 쓰지 않음. Origin: `COLLAB_ALLOWED_ORIGINS` 밖이면 업그레이드 403(같은 출처·Origin 없음은 통과). 발급 도구 `server/token.mjs`(`--new-secret`, `--room --scope --name --sub --ttl`). 플러그인(한 블록 "studio 쪽 접속 정보" + 연결 열림·메시지 처리의 작은 고리): `#token` 읽고 주소에서 지움·sessionStorage, 값이 빈 `collab` 은 같은 출처 wss, 이름 없는 초대 링크면 이름을 한 번 묻고 기억(localStorage), unauthorized → `AuthSession` 판단 → 포기면 방을 나가고 안내 + "보내지 못한 편집 N건은 이 화면에만", forbidden → 안내 + 제자리 재동기화, view 면 "보기 전용" 안내, 서버가 확인한 이름을 패널에 |
| 2026-11-27 | D4 서버 자리 | form·comment 연결의 묶음은 정본에 `apply(entries, {confine: kinds})`. `canonical-worker.mjs` 의 `checkConfined(snap, kinds)` 한 곳이 판정 자리 — `doc.collabCheckConfined` 가 없으면 적용하기 전에 `forbidden(unsupported)`. 있으면 스냅샷 → 적용 → 판정 → 벗어나면 복원, 복원 뒤 digest 가 적용 전과 다르면 패닉 취급(정본 재생성). 정본이 꺼진 서버도 unsupported. 초대 토큰은 edit·view·form·comment 네 개. 보조의 반환 형식(`{ok, detail}` 또는 boolean)과 form·comment 를 함께 가진 연결의 합친 판정은 보조를 합칠 때 정한다(코드에 TODO) |
| 2026-11-27 | D2 구현 | 서버는 `http`/`https`(COLLAB_TLS_CERT·KEY 둘 다 — 하나만이면 시작 거부) 하나에 WebSocket·API·정적 파일(`server/http.mjs`): COLLAB_STATIC_DIR 안으로만(경로 정규화 + 실제 경로 확인으로 밖을 가리키는 심볼릭 링크도 거절), MIME(wasm = application/wasm), `/assets/` 는 1년 immutable·그 밖 no-cache, 약한 ETag·304, nosniff. `scripts/build-studio.sh`(tsc + vite build → `target/studio`). **발견: 업스트림 PWA 서비스 워커**가 모든 탐색을 index.html 로 돌려(NavigationRoute) 같은 출처의 `/upload` 를 가리고, 루트 `.wasm` 을 30일 CacheFirst 한다 → 빌드 스크립트가 `sw.js`·workbox 를 빼고 `registerSW.js` 를 예전 워커를 걷어 내는 것으로 바꾼다(0002 를 고치지 않음). 보안 컨텍스트: 플러그인이 `isSecureContext` 가 아니면 아무것도 중지·가로채지 않고 "공동편집은 HTTPS 에서만 쓸 수 있습니다"만 띄운다. studio 의 다른 보안 컨텍스트 API 조사: `crypto.subtle`(선언 글꼴 환경·복구 암호·AI 키 보관), `navigator.clipboard`(복사·붙여넣기), `queryLocalFonts`, File System Access(저장 대화상자), `crypto.randomUUID`(command-error 는 대체 있음) — 공동편집 중에는 글꼴 정책·자동 저장 중지로 앞의 셋이 꺼지고, 남는 것은 플러그인의 randomUUID 와 클립보드라 들어가지 않는 쪽이 맞다 |
| 2026-11-27 | D3 구현 | `POST /rooms`(create, 본문 = HWP/HWPX): 형식 확인(415) → gzip·base64 크기 + 64 ≤ maxMessageBytes(413, WebSocket base 와 같은 규칙) → 새 정본 워커에 적재(422) → 저장소 0세대 base = 올린 바이트 그대로 → 방 이름 128비트 base64url → `201 {room, invite?, inviteExpiresAt?}`. 방은 적재가 끝난 뒤에야 방 목록에 넣는다(그 사이 hello 가 base 담당이 되지 않게). `GET /rooms/{room}/document`(room 이 맞는 view·form·comment·edit): 메모리에 없으면 저장소에서 열어 정본 내보내기, `X-Collab-Seq`. 인증 실패 HTTP 상태: missing·invalid·expired 401, room·scope 403, no-room 404, unavailable 503. 업로드 페이지 `server/public/upload.html`(`/upload#token=<create>` — 만들기 토큰은 그 탭에만, 권한별 링크·복사·편집기 주소 바꾸기·초대 토큰으로 내려받기). 빈 방 세대 전환은 그 세대 기준점 뒤로 편집이 있을 때만(`generationSeq` — 내려받기·방 만들기만 한 방이 10분마다 세대를 올리지 않게) |
| 2026-11-27 | 시험(단위) | 서버 **46/46**(기존 28 + `auth.test.mjs` 15: JWT 형식·alg none/HS512·crit·엄격 base64url·서명 길이·exp 오차·nbf·sub/room 필수, 권한 정리, authFromEnv 시작 거부·경고·비밀키 규칙, POST /rooms 401·403·415·405·201 + 초대 토큰 클레임 + 저장소 0세대 = 올린 바이트, hello 이유 코드 6종 + 4401, welcome.user·커서 이름 = 토큰 name·sub 는 서버가 찍음(위조 무시)·디스크·catchup 에도, 초대 토큰 이름·sub 꼬리, view forbidden·커서·resync, form·comment unsupported·seq 그대로, 내려받기 401·create 403·room 403·404·편집 반영·참조(같은 편집 → 내보내기 → 다시 읽기)와 digest 같음·세대 전환한 정본 digest = 받은 파일, 메모리에서 내린 방 내려받기, Origin 403·통과 3종, url 방식 통과·이유 전달·5xx·닿지 못함, 끼운 검증 함수 + `http.test.mjs` 3: 정적 파일 MIME·캐시·ETag·날것 경로 탈출·심볼릭 링크·업로드 페이지·healthz, 정적 디렉터리 없음, TLS wss·https·평문 거절·CERT 만 주면 거부). collab-client **30/30**(기존 23 + `session.test.mjs` 7). studio `tsc --noEmit`(플러그인·session 포함) 통과 |
| 2026-11-27 | 시험 `collab-client/e2e/s5-deploy.mjs` (Mac, 127.0.0.1 TLS) | **15/15.** 배포 빌드에는 개발용 전역(`__inputHandler`·`__wasm`)이 없으므로 화면을 눌러 캐럿을 놓고 키보드로 친다(배포하는 산출물 그대로 시험). 새로고침하면 studio 의 "저장하지 않은 변경" 확인(beforeunload)이 뜬다 — 시험은 받아들인다 |
| 2026-11-27 | **D2 관문: 다른 기기** (`s5-deploy.mjs`, Mac 서버 `HOST=0.0.0.0` + 자체 서명 인증서 + hs256, Windows 11 Chrome 157 headless `--ignore-certificate-errors`, CDP 만 SSH -L) | **16/16.** Mac Chrome 158(A)과 Windows Chrome(B)이 `https://<Mac LAN IP>:8797/?collab#token=<편집 초대>&room=…` 로 들어옴(둘 다 보안 컨텍스트, 주소에서 토큰 지워짐, sub `invite~…`) → 번갈아·동시 입력 후 **digest 일치(두 브라우저·정본·Node 재생), 재동기화 0** → GET document 가 편집을 반영하고 다시 열면 digest = 기록 재생·내보내기·다시 읽기, create 토큰은 403 → B 새로고침 → sessionStorage 토큰으로 다시 들어옴 → 인증 실패 missing·invalid(다른 비밀키)·expired·room·no-room 이 모두 들어가지 않고 안내(재접속 0) → 보기 링크: 입력이 forbidden(scope) → 제자리 재동기화로 되돌림, A·seq 그대로, "보기 전용" 안내 → 약 25초짜리 토큰으로 들어와 끊긴 동안 만료 → 다시 붙기를 멈추고 "인증이 만료되었습니다. 다시 열어 주세요 — 보내지 못한 편집 1건은 이 화면에만 있습니다" → 마지막 편집 뒤 digest 일치·재동기화 0. 서버 로그 unauthorized 6, forbidden 1, DIVERGED 0, invalid 0. 끝난 뒤 Mac 서버 내림, Windows 는 명령줄에 `cc-rhwp-deploy-chrome` 이 있는 Chrome 7개만 끄고(사용자 Chrome 32개 그대로) 임시 프로필 지움, Windows 에 파일 복사 없음 |
| 2026-11-27 | **http 로 열었을 때 (실측, Windows Chrome → `http://<Mac LAN IP>:7710`)** | **5단계 전 플러그인:** 콘솔에만 `[main] 공동편집 로드 실패 Error: crypto.randomUUID is not a function` 이 찍히고, 화면에는 아무 안내 없이 studio 가 빈 새 문서(혼자 편집)로 열린다. 서버에는 연결이 오지 않는다 — 사용자는 혼자 편집하면서 공동편집 중이라고 여길 수 있다. **지금:** "공동편집은 HTTPS 에서만 쓸 수 있습니다 (지금 주소: http://<Mac LAN IP>:7710)" 배너, 들어가지 않음(서버 인증 기록 없음). 그 페이지에서 `isSecureContext=false`, `crypto.randomUUID`·`crypto.subtle`·`navigator.clipboard` 없음, `serviceWorker` 없음 |
| 2026-11-27 | 회귀 (이 worktree, studio dev 7710·서버 8797) | R8 **22/22**(지연 300ms), R7 **10/10**, S3-4 **4/4**. 서버 46/46, collab-client 30/30 |
| 2026-11-27 | 작업 중 실수와 정리 | 디버그 스크립트를 worktree 를 현재 디렉터리로 두고 돌려 시험용 자체 서명 키·인증서(`k.pem`·`c.pem`, 그 자리에서 만든 일회용)가 worktree 뿌리에 생겼다 — 커밋 전 발견해 지움. 비밀키·토큰·인증서는 그 밖에는 프로세스 메모리와 OS 임시 디렉터리에만 두었다 |
| 2026-11-27 | 합친 뒤 회귀 (collab/poc `fb3fda5` = 4단계 U1 + 5단계, worktree 를 ff 로 맞춤) | 패치(0002)와 collab-core 가 바뀌었으므로 worktree 의 upstream 을 rev 로 되돌리고(`git reset --hard`, 남는 파일 없음) bootstrap → build-wasm → build-studio. 엔진 지문 `981ce66b4183-0c8fdd5bebd6-d2e4f81e5486-1825141ec2aa`. 서버 **46/46**, collab-client **41/41**, s5-deploy(이 기기, TLS) **15/15**, R8 **22/22**, R7 **10/10**, S3-4 **4/4** |
| 2026-11-27 | **u1-undo 를 인증을 켠 서버에서** | **8/8.** 시험 파일은 그대로 두고 감싸는 스크립트(저장소 밖)가 서버를 hs256·지연 300ms·정본으로 띄우고, 시험이 여는 방마다 `POST /rooms`(빈 문서 — studio 첫 참여자가 올리는 것과 같은 `createBlankDocument` → `collabExportState`)로 방을 만든 뒤, 탭마다 이름이 든 개인 편집 토큰을 `#token` 으로 실어 연다(puppeteer `Page.prototype.goto` 감싸기). ① 내 글자만 사라짐 ② 같은 문단 막힘·알림 ③ 굵게 되돌리기 ④ Enter 되돌리기 ⑪ 선택 삭제 되돌리기 ⑫ 막힘, 끝까지 어긋남·재동기화 0. 서버: 인증 통과 2, unauthorized·forbidden·DIVERGED·invalid 0, 메모리 기록의 묶음 모두 서버가 찍은 sub. 되돌리기 묶음도 일반 편집과 같은 경로(권한 확인 → 정본 → sub)를 지난다 |
| 2026-11-27 | **D4 조사: 메모·누름틀·양식 구조** (기존 코드 세션) | 메모 = 문단 `controls` 의 `Control::Field`(command `MEMO/…`) + `field_ranges` 의 범위(글자 좌표). 본문 `text` 는 그대로이고 흐름 좌표(`char_offsets`, 같은 좌표의 글자 모양·영역 태그·줄 시작·형광펜)가 표지마다 8씩 밀리며 뒤 개체 번호도 밀린다. 내용은 `Field.memo_paragraphs`. `setMemoShape` 는 DocInfo `extra_records` 의 메모 모양(`HWPTAG_MEMO_SHAPE`, 공유하지 않으면 고쳐 쓰기)과 `section_def.memo_shape_id`(+ 첫 문단의 SectionDef 개체). 누름틀 = 같은 Field(ClickHere) + 범위, 값은 그 사이 본문 글자, 채우면 속성 비트 15. 양식 개체 = `Control::Form`(value·text 만 바뀜). studio 에는 양식 모드(`EditorEditMode 'form'`, `view:form-mode`)가 있고 읽기 전용 모드는 없다 |
| 2026-11-27 | **D4 클라이언트 문·Rust 보조** (기존 코드 세션) | **분류표 `perm`**: 양식 6(setFormValue·setFormValueInCell(Ex)·applyFormActionUpdates·setFieldValue·setFieldValueByName), 메모 6(insertMemo·insertMemoByPath·insertMemoReply·removeMemo·setMemoShape·setMemoText). 표시가 없으면 edit(새 함수 포함). `gen-catalog` 이 값 검사·통계. **엔진 권한 문**(`CollabEngine.setScope`, 모든 호출 경로가 지나는 export 경계): edit 가 없으면 기록하는 호출(op·state·watch)을 코어에 닿기 전에 판정 — view 모두 거절, form 은 `perm: form` 과 활성 누름틀 안에 완전히 드는 글자 연산(`collabFieldContains`, 나눔·합침·여러 문단·개체 지움은 아님), comment 는 `perm: memo`. 막히면 `PermissionDenied` 를 던지고 `onDenied` 로 안내(기록 여부와 상관없이 — 재동기화 중에도). **플러그인**: `welcome.user.scope` 로 문을 걸고, form 이면 studio 양식 모드를 켠다(우리가 켰으면 나갈 때 끔), 같은 안내는 3초에 한 번. 보기 전용 안내 문구를 "문서를 고칠 수 없습니다"로(문이 있으므로). **Rust `collabCheckConfined(snap, kind)`**(`collab-core/src/confine.rs`): 앞뒤 문서 사본에 가리기 변환을 한 뒤 **기존 구역 모델 다이제스트**로 비교 — 다이제스트가 모든 그릇을 직렬화하므로 덮는 범위가 같고, 가리기가 그릇을 놓치면 거절로 떨어진다(안전 쪽). comment: 메모 필드 제거(개체 위치를 메모가 있는 채로 재고 뺀 뒤 흐름 좌표를 다시 짠다 — 업스트림 `drop_memo_fields` 는 컨트롤을 뺀 뒤 옛 좌표로 위치를 재서 같은 틈의 다른 개체가 자리를 옮긴다, 그래서 쓰지 않음), 메모 모양 번호 가림, 꼬리의 메모 기록 묶음 제외. form: ClickHere 안 글자 지움(`delete_text_at`), 채움 비트·양식 값 가림. 둘 다: `line_segs`·`layout_*`·`char_count`·`control_mask` 제외, 흐름 좌표는 개체 위치로 다시 짠 정규형. DocInfo 목록은 앞부분이 같아야 함(덧붙이기만), comment 만 메모 모양 고쳐 쓰기·덧붙이기 허용(줄면 거절), 그 밖의 DocInfo·문서 속성(캐럿 제외)·BinData(풀지 않고 같은 저장 값)·부속 스트림은 같아야 함. 문서 필드·DocInfo 필드는 `..` 없이 나열(업스트림이 필드를 더하면 컴파일 오류). `kind` 는 `form`·`comment`·`form comment`(두 권한을 함께 가리고 한 번에 비교 — 섞인 묶음도 판정). 서버 정본 `checkConfined` 는 권한 목록을 한 번에 넘기게 고침 |
| 2026-11-27 | D4 시험 (기존 코드 세션) | Rust collab **65/65**(+4): **form 통과** — 누름틀 값, 누름틀 안 입력(본문·칸), 양식 개체 값(`samples/form-01.hwp`); **form 거절(전부 confined)** — 누름틀 밖 본문, 누름틀 밖 칸 문단, 다른 칸, 머리말, 각주, 글상자 안 문단, 누름틀 안에 표 넣기, 누름틀 이름 바꾸기, 기존 글자 모양 항목 고치기, state 바이트로 본문 바꾸기, form 으로 메모; **comment 통과** — 메모 넣기·답글·고치기·지우기·모양; **comment 거절** — 본문, 누름틀 값, 기존 글자 모양; **form comment** 로 양식+메모가 섞인 묶음 통과(form 만으로는 거절); `collabFieldContains` 범위(본문 [4,7) 안·끝 지점 허용, 밖·걸침·나눔·다른 문단·활성 누름틀 없음 거절, 칸 누름틀). collab-client **45/45**(+4 `test/permission.test.mjs`: view·form·comment·edit 문 — 막히면 문서·미확정 그대로). 서버 **46/46**(`auth.test.mjs` 의 "보조 합치기 전 unsupported" 시험을 "허용 밖 본문 입력은 forbidden(confined), seq 그대로"로 바꿈). studio collab **39/39**. 합친 plugin.ts 로 브라우저 u1-undo 8/8, R8 22/22, T4 30/30, R7 10/10, S3-4 4/4. 분류표 `--check`, 패치 역적용 확인. 엔진 지문 `981ce66b4183-1d91c09cd650-15da6fe27e0d-792b6226269d` |
| 2026-11-27 | 0002 추가 (기존 코드 세션) | **여는 주소**: studio 가 `?collab` 말고도 조각의 `token`(초대·인증 링크)·`room`(플러그인이 토큰을 읽어 지운 뒤의 새로고침)으로 공동편집 플러그인을 올리고 자동 저장 복구를 건너뛴다(`isCollabLaunch`). **이탈 확인**: `DocumentDirtyState.guardUnload(check)` + `host.guardUnload` — 걸려 있으면 저장 안 한 변경 대신 그 판정으로 묻는다. 플러그인은 "아직 서버에 확정되지 않은 내 편집(보내는 중·끊긴 동안 쌓인 것)이 있을 때"만 묻는다(나갈 때 해제). `forbidden` → `requestResync` → 제자리 재동기화 → 되돌리기 스택 비움 경로 확인 |
