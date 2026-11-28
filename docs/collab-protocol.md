# 공동편집 규약

이 문서는 공동편집 클라이언트와 서버 사이의 규약이다. 웹(studio 플러그인)이든 네이티브든 이 문서만 보고 클라이언트를
만들 수 있게 쓴다. 왜 이렇게 정했는지는 단계별 설계 문서(`collab-design.md`, `collab-stage2.md`~`collab-stage5.md`)에
있다. 서버 구현은 `server/server.mjs`·`server/auth.mjs`·`server/http.mjs`, 클라이언트 쪽 플랫폼 중립 구현은
`collab-client/src/session/` 이다. **메시지를 바꾸면 이 문서를 함께 고친다.**

## 1. 전제

- **같은 엔진.** 문서를 읽고 편집하는 일은 rhwp 가 한다. 편집 기록은 "rhwp 의 이 함수를 이 인자로 불렀다"이므로, 같은
  방의 모든 참여자와 서버 정본은 같은 rhwp 빌드와 같은 분류표를 써야 한다. 그 지문이 `engine` 이다(업스트림 커밋 +
  패치 해시 + 분류표 해시 + 보정 코드 해시, `collab-client/src/engine/catalog.ts` 의 `ENGINE_FINGERPRINT`). 지문이 방과
  다르면 들어갈 수 없다.
- **같은 조판.** 조판은 rhwp 내장 글꼴 규칙(`bundled-only`)으로만 한다. 기기 글꼴·Canvas 측정을 조판에 쓰면 기기마다 줄
  나눔이 달라져 같은 기록이 다른 문서를 만든다(`collab-stage3.md` S3-1).
- **같은 출발점.** 모든 문서는 모두가 같은 바이트를 다시 읽은 지점(기준점)에서 출발해 같은 기록을 재생한다. 내보낸 뒤
  다시 읽지 않은 문서는 기준점이 아니다(`collab-stage3.md` S3-3 "계보 보존").
- **순서는 서버가 정한다.** 서버가 받은 묶음마다 `seq` 를 하나씩 올린다. 클라이언트는 확정되지 않은 자기 편집을 되감고
  서버 순서대로 다시 적용한다(`collab-stage2.md` §4·§5).

## 2. 인증과 권한

클라이언트는 토큰을 **해석하지 않는다**. 불투명한 문자열로 들고 가서 `hello` 에 싣기만 한다. 토큰을 확인하는 곳은 서버뿐이다.
문서 코어(rhwp·`CollabCore`)는 인증을 모른다.

### 2.1 토큰 받기

- 토큰은 호스트(웹 페이지, 네이티브 앱, 바깥 시스템)가 각자 방식으로 준다. 클라이언트는 토큰 공급자
  `getToken({room, reason}) → 토큰 | null` 를 부른다. `reason` 은 `connect`(처음 연결), `reconnect`(끊겨서 다시 연결),
  `expired`(서버가 만료라고 함) 중 하나다.
- 웹 링크로 줄 때는 주소의 조각에 싣는다: `https://호스트/?collab#token=…&room=…`. 조각은 서버로 가지 않는다.
  클라이언트는 읽은 뒤 주소에서 지운다. 토큰을 쿼리 문자열에 싣지 않는다(서버 기록·Referer 에 남는다).
- 인증을 끈 서버(`COLLAB_AUTH=none`)는 토큰이 없어도 받는다. 실어 보내도 보지 않는다.

### 2.2 클레임

서버가 HS256 으로 확인하는 경우(`COLLAB_AUTH=hs256`)의 JWT 클레임이다. 헤더의 `alg` 는 정확히 `HS256` 이어야 한다
(`none` 등은 거절). 시계 오차는 30초까지 허용한다.

| 클레임 | 필수 | 뜻 |
|---|---|---|
| `sub` | 예 | 사용자 식별자. 기록 항목에 남고 **같은 방 참여자에게 보인다**(§3.3) — 비밀이나 개인 식별 정보를 넣지 않는다 |
| `room` | 예 | 들어갈 수 있는 방. 방 이름 하나 또는 `*`(모든 방) |
| `exp` | 예 | 만료 시각(초 단위 NumericDate) |
| `name` | 아니요 | 다른 사람 커서 옆에 보일 이름. 없으면 여럿이 나눠 쓰는 토큰으로 본다(아래) |
| `scope` | 아니요 | 권한. 공백으로 구분한 목록(예: `"form comment"`). 없으면 `edit` |
| `nbf` | 아니요 | 이 시각 전에는 쓸 수 없다 |
| `iat` | 아니요 | 발급 시각(서버는 보지 않는다) |

`name` 이 없는 토큰(예: 서버가 만든 초대 토큰)은 여러 사람이 나눠 쓴다. 그래서 표시 이름은 `hello.name`(사용자가 입력한
값, **확인되지 않은 표시용**)을 쓰고, `sub` 에는 서버가 연결마다 다른 꼬리를 붙인다(`invite~1a2b3c4d`).
studio 는 이름이 없는 초대 링크로 들어올 때 화면 안 입력 칸으로 이름을 한 번 묻고 그 기기에 기억한다(묻는 동안은 연결하지
않는다, 부품 전용 서버에서는 묻지 않는다). launcher 의 "이 방으로 들어가기"는 만들기 토큰에 `name` 이 있으면 그 이름을 편집
링크의 주소 조각(`#name=`)에 실어 다시 묻지 않는다 — 나눠 주는 링크에는 싣지 않는다.

**입장 이름.** 서버는 `hello` 때 이름(토큰의 `name`, 없으면 `hello.name`)을 한 번 다듬어 그 연결의 이름으로 정한다. 규칙은
rhwp 가 메모 작성자를 저장하는 규칙과 같다: 앞뒤 공백을 자르고, `/`·`\`·`;`·제어 문자를 빼고, 64 UTF-16 단위로 자른다
(서로게이트 쌍은 가르지 않는다). 자른 뒤 앞뒤 공백이 다시 생기면 되풀이하고, 비면 `손님` 이다. 이 이름을 `welcome.user.name`
으로 알려 준다(인증을 끈 서버는 다듬은 이름이 `hello.name` 과 다를 때만 `welcome.user` 를 싣는다). 메모 작성자 비교, 자기
메모 확인, 다른 사람에게 보이는 커서 이름은 모두 이 입장 이름을 쓴다.

권한(`scope`):

| 권한 | 할 수 있는 일 |
|---|---|
| `view` | 문서와 다른 사람 커서를 받고, 자기 커서를 보낸다. 편집·`base` 는 보낼 수 없다 |
| `form` | `view` + 양식만 채운다: 누름틀 안의 글자, 양식 개체(체크박스·라디오·콤보·입력란)의 값 |
| `comment` | `view` + 메모만 단다: 메모 넣기·답글, 자기 메모 고치기·지우기(§4.9). 메모 모양은 `edit` |
| `edit` | 모든 편집 |
| `create` | 방 만들기 API(`POST /rooms`). 방에 들어가거나 문서를 내려받는 권한은 아니다 |

방에 들어가려면 `view`·`form`·`comment`·`edit` 중 하나가 있어야 한다. `form`·`comment` 의 편집은 서버 정본이 **결과로**
확인한다(§4.8). 판정 보조가 없는 서버는 그 편집을 받지 않는다(`forbidden`, `unsupported`).

**좁은 권한(`form`·`comment`)은 결과 전송(`state`)을 보낼 수 없다.** `state` 가 하나라도 든 묶음과 `base` 는 서버가 정본에
닿기 전에 `forbidden`(`scope`)으로 거절한다. 판정은 rhwp 가 파싱한 모델만 보므로, rhwp 가 모델에 남기지 않는 레코드를 문서
바이트에 끼워 보내면 판정을 지나 다른 참여자가 그 바이트를 그대로 읽게 되기 때문이다(한글 문서에 끼운 악성 레코드는 실제로
쓰이는 공격 경로다). 좁은 권한의 편집은 모두 `op` 로 보낸다. 클라이언트 문(§4.8)이 `state` 가 될 호출을 막는다.

**역할 매핑(`COLLAB_ROLE_MAP`, 6단계 S3).** 바깥 시스템이 자기 역할 이름을 그대로 주면 서버가 매핑표(JSON 파일,
`{"작성자": "edit", "검토자": "comment", "열람자": "view"}` — 값은 공백 구분 문자열 또는 배열)로 권한으로 바꾼다. 토큰의
`roles` 클레임(배열, 또는 역할 하나의 문자열)이나 url 확인 답의 `roles` 가 그 자리다. 여러 역할이면 합치고, `scope` 도 있으면
함께 합친다. **표에 없는 역할은 아무 권한도 주지 않는다**(기본 거부). `roles` 만 있고 표가 없거나 하나도 맞지 않으면 권한이
없다(`edit` 로 넓히지 않는다 — `scope` 도 `roles` 도 없을 때만 `edit`). 표에 모르는 권한 이름이 있으면 서버가 시작하지 않는다.
역할 이름은 기록·로그에 남기지 않고, 최종 권한만 `welcome.user.scope` 로 알린다.

### 2.3 바깥 시스템에 맡기기 (`COLLAB_AUTH=url`)

서버는 `COLLAB_AUTH_URL` 에 `POST {token, room}` 을 보낸다(방 만들기 API 는 `room: null`). 답은 다음 중 하나다.

- `{ok: true, sub, name?, scope?, roles?}` — 통과. `scope` 는 위와 같은 형식이다. `roles` 는 역할 매핑표로 바꾼다(§2.2).
- `{ok: false, reason}` — 거절. `reason` 은 §2.4 의 코드다(모르는 코드는 `invalid` 로 본다).

닿지 못하거나, 5초 안에 답하지 않거나, 5xx 를 주거나, 답이 형식에 맞지 않으면 `unavailable` 이다. 서버를 직접 띄우는
바깥 시스템은 검증 함수를 끼울 수도 있다: `startServer({ auth: { mode: '이름', verify: async (token, room) => ({sub, name, scope}) } })`.
실패는 `AuthError(reason)`(`server/auth.mjs`)로 던진다.

### 2.4 `unauthorized` 이유 코드

서버는 `hello` 를 받으면 welcome 전에 토큰을 확인한다. 실패하면 `{type: "unauthorized", reason}` 을 보내고 닫는다(닫는
코드 4401). 다시 붙을 때도 매번 확인한다. 연결된 뒤에 만료 시각이 지나도 그 연결은 끊지 않는다.

| `reason` | 뜻 | 클라이언트 |
|---|---|---|
| `missing` | 토큰이 없다 | 포기, 안내 |
| `invalid` | 형식·서명·alg 가 틀렸거나 바깥 시스템이 거절했다 | 포기, 안내 |
| `expired` | 만료됐다 | `getToken({reason: "expired"})` 로 **한 번** 새 토큰을 받아 곧바로 다시 붙는다. 새 토큰이 없거나 또 만료면 포기 |
| `room` | 토큰의 방이 다르다 | 포기, 안내 |
| `scope` | 방에 들어갈 권한(view·form·comment·edit)이 없다 | 포기, 안내 |
| `no-room` | 없는 방이다. 인증을 켜면 방은 서버가 만든다(§5) | 포기, 안내 |
| `unavailable` | 바깥 인증 서버에 닿지 못했다 | 연결 끊김과 같이 백오프로 다시 붙는다 |

토큰을 확인한 뒤에 방이 있는지 본다(토큰 없이 방 이름을 떠보지 못하게). 포기할 때는 보내지 못한 편집이 있으면 그
수를 함께 알린다. 방에 들어가면(`welcome`·`catchup`) 만료 갱신 횟수를 되돌린다.

### 2.5 `forbidden` 이유 코드

권한이 모자란 메시지는 연결을 끊지 않고 그 메시지만 `{type: "forbidden", what, reason, batchId?}` 로 거절한다. `seq` 는
그대로이고 아무에게도 방송하지 않는다. `what` 은 `ops` 또는 `base` 다.

| `reason` | 뜻 |
|---|---|
| `scope` | 이 연결의 권한으로는 보낼 수 없는 메시지(`view` 의 편집, `form`·`comment` 의 `state` 가 든 묶음, `edit` 가 아닌 연결의 `base`) |
| `unsupported` | 서버가 이 권한의 편집을 판정할 수 없다(`form`·`comment` 판정 보조가 없음, 또는 정본이 꺼짐) |
| `confined` | 묶음을 적용해 보니 허용된 부분 밖을 바꿨다(§4.8) |
| `author` | 메모 작성자가 그 연결의 이름이 아니다, 또는 `comment` 권한이 남의 메모를 고치거나 지우려 했다(§4.9) |

클라이언트는 `invalid` 와 같게 처리한다: 그 묶음과 그 뒤 미확정을 버리고 제자리 재동기화(§4.5)한 뒤 안내한다.
클라이언트 권한 문(§4.8)이 먼저 막으므로 정상 클라이언트에게는 드문 경우다.

## 3. 메시지

전송은 WebSocket 이다. 텍스트 프레임 하나에 JSON 객체 하나다. 서버는 아무 경로에서나 업그레이드를 받는다
(`wss://호스트/`). 서버는 Origin 허용 목록(`COLLAB_ALLOWED_ORIGINS`)이 있으면 업그레이드의 Origin 을 확인한다. 같은
출처(Origin 의 호스트 = Host 헤더)와 Origin 이 없는 연결(브라우저 밖)은 통과한다. 목록 밖이면 HTTP 403 으로 업그레이드를
거절한다(메시지 없음).

메시지 상한은 `maxMessageBytes`(기본 64MB, `welcome` 이 알려 준다)다. 바이너리는 base64 로 싣는다.

### 3.1 클라이언트 → 서버

| `type` | 필드 | 설명 |
|---|---|---|
| `hello` | `room`, `clientId`, `name`, `engine`, `token?`, `lastSeq?`, `generation?` | 처음 보내는 메시지. 연결마다 한 번. `clientId` 는 페이지(앱 세션)마다 새 UUID, 다시 붙어도 같은 값. `lastSeq`·`generation` 은 다시 붙을 때만(§4.6) |
| `base` | `data`, `encryptedSource?` | `welcome.base` 가 `null` 이었던 참여자(첫 참여자)만. `data` = 지금 문서를 gzip 으로 감싼 바이트(`collabExportState`)의 base64. 원래 암호 문서였으면 `encryptedSource: true`(§4.1 — `welcome.allowEncrypted` 일 때만 보낼 수 있다) |
| `ops` | `base`, `entries`, `batchId` | 편집 묶음. `base` = 마지막으로 받은 seq. `entries` = 기록 열(§3.3). `batchId` = `clientId:순번` |
| `resync` | — | 문서를 다시 받는다 → `welcome`(`resync: true`) |
| `digest` | `seq`, `digest` | 그 seq 에서의 문서 지문(`collabDigest`) |
| `cursor` | `seq`, `caret` | 내 캐럿(텍스트 좌표, seq 시점). 저장하지 않고 다른 참여자에게만 중계한다. 초당 20회까지 |

`caret` 은 `null`(보이지 않음 — 머리말·각주 안 등) 또는 `{section, para, offset, cell?: {control, cell, cellPara}}` 다.
`offset` 은 `para.text` 의 유니코드 스칼라 인덱스다(개체는 자리를 차지하지 않는다, `collab-stage2.md` §3).

### 3.2 서버 → 클라이언트

| `type` | 필드 | 설명 |
|---|---|---|
| `welcome` | `seq`, `base`, `log`, `maxMessageBytes`, `generation?`, `user?`, `resync?`, `encryptedSource?`, `allowEncrypted?`, `roundtrip?` | 방에 들어옴. `base` = 기준점(gzip 바이트의 base64) 또는 `null`(첫 참여자 — `base` 를 보내야 함). `log` = 기준점 뒤 묶음들. `generation` 은 0 이면 없다. `user` 는 인증을 켠 서버만 `{sub, name, scope}`. `encryptedSource: true` 는 원래 암호 문서였던 방(참여자에게 한 번 알린다), `roundtrip` 은 방을 열 때의 왕복 점검이 통과가 아니던(경고 또는 점검 못 함) 방의 결과(§5 — 참여자에게 한 번 알린다), `allowEncrypted: true` 는 `base: null` 일 때 서버가 암호 문서를 받는다는 뜻(§4.1). 기록이 길면 나눠 보낸다(아래) |
| `catchup` | `seq`, `log`, `maxMessageBytes`, `user?`, `cont?` | 다시 붙은 참여자에게 끊긴 동안의 묶음만(§4.6). `cont: true` 는 나눠 보낸 `welcome` 의 이어지는 조각 |
| `ops` | `seq`, `clientId`, `entries`, `batchId?`, `sub?`, `replaced?` | 확정된 묶음. 모두에게 보낸다. 보낸 사람에게는 확정(ack)이다. `replaced: true` 면 서버가 묶음 안의 `state` 를 다시 쓴 바이트로 바꿨다(§4.2) |
| `reject` | `seq`, `batchId?` | 묶음의 `base` 가 서버 seq 와 다르다. 보낸 사람에게만 |
| `invalid` | `what`, `reason`, `batchId?` | 서버 정본이 적용하지 못했다. `ops` 면 보낸 쪽만(재동기화), `base` 면 연결을 닫는다 |
| `forbidden` | `what`, `reason`, `batchId?` | 권한 밖(§2.5). 연결은 둔다 |
| `unauthorized` | `reason` | 인증 실패(§2.4). 서버가 곧 닫는다(4401) |
| `incompatible` | `engine` | 엔진 지문이 방과 다르다. 서버가 곧 닫는다 |
| `too-large` | `what`, `bytes`, `limit` | 메시지가 상한을 넘었다. 그 메시지는 버린다. `base` 였으면 닫는다 |
| `diverged` | `seq` | 그 seq 의 digest 가 정본과 다르다(정본이 없는 서버는 처음 보고와 다르면 방 전체에) |
| `cursor` | `clientId`, `name`, `seq`, `caret` | 다른 참여자의 캐럿. `name` 은 서버가 정한 표시 이름 |
| `cursor-leave` | `clientId` | 참여자가 나감 |
| `roundtrip` | `roundtrip` | 방을 연 뒤 뒤에서 끝난 왕복 점검이 통과가 아니다(경고 `ok: false` 또는 점검 못 함 `ok: null`, §5). 그때 방에 있던 참여자에게 한 번. 그 뒤 들어오는 참여자는 `welcome.roundtrip` 으로 받는다 |
| `error` | `error` | 규약 위반(형식이 틀림, hello 전 메시지 등). 연결은 둔다 |

**`welcome` 나눠 보내기:** 기준점 + 기록이 상한을 넘으면 첫 조각은 `welcome`(그 `seq` 는 첫 조각의 마지막 seq), 나머지는
`catchup`(`cont: true`)으로 잇는다. 클라이언트는 이어 붙여 차례로 재생한다.

### 3.3 기록 항목

`log` 의 한 항목은 `{seq, clientId, entries, batchId?, sub?}` 다. `sub` 는 **서버가 찍는다**(인증한 사용자). 클라이언트가
보낸 값은 쓰지 않는다. 같은 방 참여자에게 보이므로 비밀이나 개인 식별 정보를 넣지 않는다(§2.2).

`entries` 의 원소(기록)는 두 가지다.

```json
{"kind": "op", "m": "insertText", "a": [0, 3, 0, "안녕"], "meta": {"len": 2}}
{"kind": "state", "data": "<gzip 으로 감싼 문서 바이트의 base64>"}
{"kind": "state", "data": "…", "range": {"section": 0, "lo": 3, "before": 4, "after": 1}}
```

- `op` 는 rhwp 함수 `m` 을 인자 `a` 로 부른 것이다. 분류표에서 `sync: op` 인 함수만 쓸 수 있다(서버가 그 밖은 거절).
  `a` 안의 바이너리(`Uint8Array`)는 `{"$b64": "…"}` 로 감싼다. `meta` 는 글자 연산의 보정 정보(기록 시점 실측),
  `ctx` 는 그 호출이 기대는 맥락(활성 누름틀 등)이다. 형식과 의미는 `collab-stage2.md` §3 "기록 형태"가 정본이다.
- `state` 는 결과 전송이다. 그 시점 문서 전체(원본 형식, gzip)다. `state` 는 새 기준점이다 — 모두가 같은 바이트를 다시
  읽는다. 방에 들어가는 `state` 바이트는 **서버가 만든다**(§4.2): 기록과 방송에 남는 것은 클라이언트가 보낸 바이트가 아니라
  서버가 다시 쓴 바이트다.
- `state` 의 `range`(4단계 U3, 선택)는 범위 표시다: 이 `state` 는 구역 `section` 의 문단 `[lo, lo+before)` 를 `after` 개
  문단으로 바꾼 것뿐이다(문단 수, `before`·`after` ≥ 1, 다른 키 없음). 표 만들기·붙여넣기 같은 스냅샷 명령의 되돌리기가
  싣고(`collab-stage4.md` §6), 7단계 A 부터는 일반 `state` 도 보낸 쪽이 호출 직전 문서와 견주어 한 구역의 연속 문단만 바뀌었고
  DocInfo·구역 정의가 그대로면 싣는다(`collab-stage7.md` A). 받는 쪽은 이 `state` 를 문서 전체가 아니라 그 범위의 구조 편집으로 보고 보정한다(§4.3) —
  범위 밖 미확정은 번호만 옮겨 살리고, 되돌리기 스택도 같은 지도로 옮긴다. 서버 정본은 적용 뒤 범위 밖이 적용 전과 같은지
  확인하고, 아니면 `invalid {reason: "range"}` 로 거절한다(§4.2). 정본을 끈 서버는 확인할 수 없으므로 `range` 를 떼고
  기록·방송한다(받는 쪽은 보통 `state` 로 다룬다). 보낸 쪽이 자기만 쓰는 필드(복원 재료 번호 등)는 보내지 않고, 서버는
  `state` 항목의 `kind`·`data`·`range` 밖의 필드를 버린다.

## 4. 클라이언트 동작

### 4.1 들어가기

1. 연결 → 토큰 받기(`connect`) → `hello`.
2. `welcome.base` 가 `null` 이면 첫 참여자다(인증을 끈 서버에서만 생긴다). 지금 문서를 `collabExportState` 로 내보내
   `base` 로 보내고, **자기도 그 바이트로 문서를 다시 연다.**
3. `base` 가 있으면 그 바이트(gzip 을 푼 원본)로 문서를 열고 `log` 를 차례로 재생한다(`replayAll` — 쪽 배치는 끝에 한 번).
4. `lastSeq = welcome.seq`. 이제부터 편집을 기록하고 보낸다.

문서를 열 때는 같은 조판 규칙(§1)을 걸어야 한다. 걸리지 않으면 들어가지 않는다.

**암호 문서(첫 참여자):** 방의 문서는 암호 없는 바이트로 오가므로, 암호 문서를 올리면 작성자가 건 보호가 서버 디스크·모든
참여자·내려받은 파일에서 사라진다. 그래서 지금 문서가 암호 문서(암호로 연 문서)이면 `welcome.allowEncrypted` 가 없을 때
`base` 를 올리지 않고 "암호 문서는 공동편집할 수 없습니다"를 띄운 뒤 나간다. 있으면 `base` 에 `encryptedSource: true` 를
실어 올리고, 서버는 방 메타에 남겨 들어오는 모든 참여자의 `welcome` 에 싣는다(참여자는 "원래 암호가 걸린 문서입니다. 공동편집
중에는 암호가 풀린 상태로 서버에 저장됩니다"를 한 번 띄운다). **서버는 받은 바이트로 원래 암호 문서였는지 알 수 없다.**
클라이언트의 이 확인은 실수로 공유하는 것을 막는 장치이고, 원문을 가진 사람이 일부러 내보내는 것은 막을 수 없다.

### 4.2 보내기

- 보낸 묶음이 확정되기 전에는 다음 묶음을 보내지 않는다(한 번에 하나, inflight).
- `ops.base = lastSeq`. 서버가 그 사이 다른 묶음을 확정했으면 `reject` 가 온다 → 그 묶음을 미확정 앞으로 되돌리고, 원격
  묶음을 받은 뒤 새 `base` 로 다시 보낸다.
- 내 `clientId` 의 `ops` 가 오면 확정이다. 다음 묶음을 보낸다.
- **서버가 다시 쓴 state (`replaced: true`).** 묶음에 `state` 가 있으면 서버 정본은 받은 바이트 C 를 읽어 판정한 뒤, 바뀐
  부분(구역·DocInfo)만 모델에서 다시 쓴 바이트 S 를 만들어 자기도 S 를 다시 읽는다. 기록과 방송에는 C 대신 S 를 쓰고, 그
  묶음에 `replaced: true` 를 붙인다. 보낸 사람이 받는 확정(ack)도 같은 메시지이므로 S 가 실려 온다. 보낸 사람은 자기 `state`
  를 S 로 바꿔 다시 읽고(확정 상태 = S 를 읽은 문서), 그 뒤의 미확정은 원격 `state` 를 받은 것처럼 다시 얹는다(§4.3 의
  되감기·재적용). 같은 모델이므로 보통은 그대로 얹힌다. 묶음 안에서 `state` 뒤의 `op` 는 모두 S 를 읽은 문서 위에 얹힌다.
  - 이유: 판정은 rhwp 가 파싱한 모델만 본다. 그런데 rhwp 는 구역·DocInfo 의 원본 바이트를 캐시해 두었다가 저장할 때 그대로
    쓴다. 그래서 파서가 모델에 남기지 않는 레코드를 끼운 바이트는 판정을 지나 저장본과 다른 참여자의 문서에 남는다(한글
    문서에 끼운 악성 레코드는 실제로 쓰이는 공격 경로다). 서버가 다시 쓴 바이트에는 모델에 있는 것만 남는다(다만 rhwp 가 해석하지 않은 바이트를 모델에 그대로 들고 있는 일부 자리는 남는다 — §8.1). 모두가 같은
    S 를 읽으므로 기준점 규칙(§1)도 지켜진다.
  - 원래 업로드한 파일(`POST /rooms` 의 처음 base)과 첫 참여자의 `base` 는 방을 만든 사람이 준 것이라 그대로 쓴다.
  - 정본을 끈 서버(`COLLAB_CANONICAL=0`)와 다시 쓰기 보조가 없는 서버는 받은 바이트를 그대로 쓰고 `replaced` 를 붙이지 않는다.
- **범위 표시 확인 (`range`, 4단계 U3).** 정본은 범위 표시가 붙은 `state` 를 적용하기 전 스냅샷을 뜨고, 다시 쓴 S 를 만들어
  읽은 뒤, 그 문서를 스냅샷과 견준다: 다른 구역 전체, 그 구역의 구역 정의·꼬리 기록·범위 앞 문단·범위 뒤 문단(번호만
  밀림), 문서 속성(캐럿 제외), 메모 답글 관계가 같고, DocInfo 목록과 BinData 는 덧붙이기만 있어야 한다. 범위 뒤 문단은 줄
  정보의 세로 위치를 빼고 본다(범위 높이가 바뀌면 보낸 쪽이 다시 이어 계산한다). 맞지 않으면 그 묶음을 되돌리고
  `invalid {what: "ops", reason: "range"}` 를 보낸 쪽에만 보낸다(seq 그대로, 방송 없음 — 정상 클라이언트는 언제나 맞다).
  맞으면 `range` 를 그대로 실어 기록·방송한다. 확인을 받은 바이트 C 가 아니라 S 로 하는 것은(7단계 A) 받는 쪽이 모두 읽는
  것이 S 라서다 — 표시는 S 위에서 참이어야 하고, 정상 클라이언트는 S 와 C 의 모델이 같으며, 끼운 날 바이트가 있는 C 는 S
  에서 이미 걸러진다. 다시 쓰기 보조가 없는 정본은 C 를 읽어 확인한다. 범위 표시 모양이 틀리면 형식 오류로 거절한다.
- **보낸 쪽의 범위 표시 `state` 가 미확정일 때 원격이 오면** 보정에서 범위가 원격과 겹치지 않는 한 버리지 않는다. 그 `state`
  의 바이트에는 원격이 없으므로, 옮긴 범위(`lo`)에서 같은 원본 문단으로 다시 복원해 바이트를 새로 만들고 다시 보낸다.
  보내지 않은 범위 표시 `state` 둘이 연달아 있고 같은 구역이면 두 범위를 덮는 한 범위 표시 `state` 로 합친다.
- 보내려는 메시지가 상한을 넘으면 보내지 않고 재동기화한다.
- IME 조합 중에는 보내지도, 원격을 적용하지도 않는다(조합이 끝나면 처리).

### 4.3 원격 받기

남의 `ops` 는 `seq === lastSeq + 1` 이어야 한다(건너뛰면 재동기화). 미확정이 없으면 그대로 적용한다. 있으면 미확정을
되감고, 원격을 적용하고, 미확정을 원격에 맞춰 보정해 다시 적용한다. 보정할 수 없는 미확정(충돌)은 그것과 그 뒤를 버리고
알린다(`collab-stage2.md` §4·§5). 원격 적용이 실패하면 재동기화한다. `state` 는 모든 미확정과 충돌한다 — 다만 범위 표시가
붙은 `state` 는 그 범위의 구조 편집(발자국 `[lo, lo+before)`, 문단 수 변화 `after - before`)으로 보고, 범위와 겹치는
미확정만 충돌이다(§3.3).

### 4.4 digest 보고

대기 상태(보낸 묶음 없음, 미확정 없음, 조합 중 아님)가 되면 `{type: "digest", seq: lastSeq, digest}` 를 보낸다. 같은 seq 는
한 번, 최소 1초 간격으로 묶되 마지막 변경 뒤에는 꼭 보낸다. 서버는 최근 64개 seq 만 비교한다. `diverged` 를 받으면
재동기화한다.

### 4.5 재동기화

`{type: "resync"}` → `welcome`(`resync: true`). 기준점을 지금 문서 객체 안에서 다시 읽고(`collabLoadState`) `log` 를
재생한다. 미확정은 버리고 안내한다("동기화를 다시 맞췄습니다. 일부 입력이 취소됐을 수 있습니다"). 재동기화가 1분에
3번을 넘으면 멈추고 새로고침을 안내한다.

### 4.6 재접속

1. 끊기면 지수 백오프(0.5초에서 시작해 두 배씩, 최대 10초)로 다시 붙는다. 그동안 엔진 상태(미확정·`lastSeq`)는 그대로
   두고 편집은 계속 쌓는다. 화면에 "연결이 끊겼습니다. 편집은 다시 연결되면 보내집니다"를 띄운다.
2. 다시 붙으면 토큰을 받아(`reconnect`) `hello` 에 `lastSeq`·`generation` 을 싣는다. **서버 답을 받기 전에는 보내지 않는다**
   (옛 base 로 보낸 묶음의 늦은 `reject` 가 새 묶음을 건드리지 않게).
3. 서버는 같은 세대이고 `lastSeq` 가 기준점 이상이면 `catchup`(그 뒤 묶음만)을, 아니면 `welcome` 을 준다.
4. `catchup` 은 원격 수신과 같이 받는다. 단, 끊기는 순간 보낸 묶음의 `batchId` 가 그 안에 있으면 남의 편집이 아니라
   **확정**이다(다시 적용하지 않는다). 없으면 서버에 닿지 않은 것이므로 미확정 앞으로 되돌려 다시 보낸다.
5. `welcome` 이면 제자리 재동기화(§4.5)와 같다. 끊긴 동안의 편집 일부가 취소됐을 수 있다고 알린다.
6. 오래 끊기면(10분, 또는 미확정 2,000건) 다시 붙을 때 충돌로 취소되는 편집이 많을 수 있다고 미리 알린다.
7. `reject`·`invalid`·`forbidden` 의 `batchId` 가 지금 보낸 묶음이 아니면(늦게 온 옛 묶음의 답) 무시한다.

### 4.7 인증 오류

`unauthorized` 는 재동기화 중이든 조합 중이든 곧바로 처리한다. §2.4 의 표대로 한다. 갱신 판단(새 토큰 받기)이 끝나기 전에
다시 붙으면 `hello` 는 판단이 끝난 뒤 새 토큰으로 보낸다. 포기하면 다시 붙지 않고, 안내와 함께 보내지 못한 편집 수를
알린다. 보내지 못한 편집은 그 화면에만 있으므로 필요하면 파일로 저장할 수 있게 둔다. 이 규칙의 플랫폼 중립 구현이
`collab-client/src/session/auth.ts` 의 `AuthSession` 이다.

### 4.8 권한 문 (클라이언트가 지킬 규칙)

서버가 최종 판정을 하지만, 클라이언트도 권한 밖 편집을 문서 코어에 닿기 전에 막는다(사용성 — 서버가 거절한 뒤 되돌리면
입력이 깜박인다). 막는 자리는 기록 프록시(export 경계)다. UI·자동화·플러그인 등 **모든 호출 경로**가 이 한곳을 지나야 한다.

- `welcome.user.scope` 로 권한을 안다(인증을 끈 서버는 `user` 가 없다 = `edit`).
- `view`: 편집 호출(분류표 `sync` 가 `op`·`state`·`watch` 인 함수)을 모두 거절한다. `none`·`local` 은 통과한다.
- `form`: 분류표 `perm` 이 `form` 인 함수(양식 값)와, `ctx.activeField` 가 있고 범위가 그 누름틀 안에 완전히 드는 글자 연산만
  통과한다. 누름틀을 만들거나 지우거나 이름·속성을 바꾸는 것은 `edit` 다.
- `comment`: 분류표 `perm` 이 `memo` 인 함수만 통과한다.
- `form`·`comment`: 결과 전송(`state`)이 될 호출은 `perm` 과 상관없이 막는다(§2.2 — 서버가 `state` 를 받지 않는다).
- 막히면 문서를 바꾸지 않고 안내만 한다("양식 칸에만 입력할 수 있습니다", "메모만 달 수 있습니다").
- 분류표에 새로 생긴 함수는 `perm` 이 없으므로 `edit` 다(좁은 권한에서는 막힌다).

서버 정본은 `form`·`comment` 연결의 묶음을 스냅샷을 뜬 뒤 적용해 보고, 바뀐 곳이 허용된 부분뿐인지 결과로 확인한다
(`collabCheckConfined`). 벗어나면 되돌리고(되돌린 정본의 digest 가 적용 전과 같은지도 본다) `forbidden`(`confined`)을
보낸다. 함수 이름을 믿지 않고 결과로 판정하므로 클라이언트 문을 우회해도 문서는 바뀌지 않는다. 좁은 권한은 `state` 를 아예
보낼 수 없다(§2.2 — 판정이 모델만 보므로 모델에 남지 않는 레코드는 결과로 가릴 수 없다).

### 4.9 메모 작성자

rhwp 는 메모 작성자를 부르는 쪽이 넘긴 `{author}` 그대로 저장한다. 인증을 켰으므로 작성자는 서버가 확인한 이름이어야 한다.

- **작성자 = 입장 이름(§2.2).** 클라이언트는 `welcome.user.name` 을 그대로 쓴다(인증을 끈 서버에서 `welcome.user` 가 없으면
  자기 `hello.name` — 그때는 서버도 그 값을 쓴다). 클라이언트 기록 프록시는 `insertMemo`·`insertMemoByPath`·
  `insertMemoReply` 의 `author` 를 이 이름으로 바꿔 넣은 뒤 core 에 넘기고 기록한다. 입장 이름은 rhwp 작성자 규칙의
  고정점이므로 rhwp 는 그대로 저장한다. 메모를 만드는 op 는 메모 시각을 `ctx.memoTime` 에 싣는다(모든 참여자가 같은 값으로
  재생한다).
- **서버:** 메모를 만드는 op 의 `author` 가 연결의 이름과 다르면(읽을 수 없거나 없어도) 묶음 전체를 정본 전에
  `forbidden`(`author`)으로 거절한다. 모든 권한에 적용한다.
- **`comment` 는 자기 메모만 고치고 지운다.** `setMemoText`·`removeMemo` 의 대상 메모의 작성자가 그 연결의 입장 이름이어야
  한다. 서버는 정본의 메모 목록으로 확인하고, 묶음 안에서 먼저 만든 메모도 차례대로 본다. 아니면 `forbidden`(`author`).
  답글은 누구의 메모에나 달 수 있다. `edit` 는 모든 메모를 고치고 지울 수 있다. 클라이언트 문도 같은 판정으로 미리 막는다
  ("자기 메모만 고칠 수 있습니다").
- **메모 모양(`setMemoShape`)은 `edit` 전용이다.** 구역 전체(`-1` 이면 모든 구역)의 메모 겉모습을 바꾸는 문서 설정이기 때문이다.
- `edit` 권한의 `state` 로 들어오는 메모는 작성자를 확인할 수 없다(편집 권한자는 신뢰한다, §6).

## 5. HTTP API

공동편집 서버는 같은 포트에서 HTTP(S) 도 받는다. 인증을 켠 서버는 `Authorization: Bearer <토큰>` 으로 확인한다(§2 와 같은
토큰). 오류 응답은 `{error, reason?, message?}` 이고, 인증 실패는 `{error: "unauthorized", reason}` 이다(상태: `missing`·
`invalid`·`expired` 401, `room`·`scope` 403, `no-room` 404, `unavailable` 503).

### `POST /rooms` — 파일로 방 만들기

- 권한: `create`(토큰의 `room` 은 보지 않는다). 인증을 끈 서버는 누구나.
- 본문: HWP 또는 HWPX 파일 바이트 그대로.
- 서버는 정본으로 열어 검사한 뒤 새 방을 만든다. 올린 바이트가 그 방의 처음 기준점(0세대 base)이다. 방 이름은 서버가
  정한다(128비트 무작위, base64url 22자).
- `201 {room, invite?, inviteExpiresAt?}`. 서버가 토큰을 만들 수 있으면(`hs256`) `invite` 에 그 방 전용 초대 토큰을 권한마다
  하나씩 준다: `{edit, view, form, comment}`. 초대 토큰은 `room` = 새 방, `scope` = 그 권한, `sub: "invite"`, `name` 없음,
  수명 `COLLAB_INVITE_TTL`(기본 24시간)이다. `url` 방식은 `{room}` 만 주고, 토큰은 바깥 시스템이 발급한다.
- 실패: 415(HWP·HWPX 가 아님), 422(정본이 열지 못함 — `invalid-document`; 여는 데 정본 워커 시간 제한 `COLLAB_CANONICAL_TIMEOUT_MS` 를 넘기면 `{error: "too-slow", reason: "too-slow"}` — 대개 문서가 커서다, 업로드 페이지·launcher 는 "문서가 커서 여는 데 너무 오래 걸립니다"로 알린다), 413(메시지 상한을 넘음 — `welcome` 에 실을 수 있어야 한다), 501(정본이 꺼짐).
- **암호 문서:** 기본으로 받지 않는다 — `400 {error: "encrypted", reason: "encrypted", allowed: false}`(rhwp 의 "암호 필요"
  오류를 일반 오류 422 와 구분한다). 서버가 `COLLAB_ALLOW_ENCRYPTED=1` 이면 `allowed: true` 로 답하고, 요청 머리
  `X-Collab-Document-Password` 로 문서 암호를 주면 그 암호로 열어 **암호 없는 바이트**를 방의 처음 기준점으로 쓴다(틀리면
  `400 {reason: "wrong-password"}`). 그 방은 `encryptedSource` 를 방 메타·`welcome` 에 남긴다. 서버는 암호를 저장하거나
  기록하지 않는다. 암호를 싣는 방법은 아래 "문서 암호 머리"와 같다.
- **문서 암호 머리(방 만들기·내려받기 공통):** `X-Collab-Document-Password`. HTTP 머리에는 한글 등 Latin-1 밖 문자를 그대로
  실을 수 없으므로, 그런 암호는 **UTF-8 퍼센트 인코딩**(`encodeURIComponent`)으로 보내고 `X-Collab-Document-Password-Encoding:
  uri` 를 함께 보낸다. 서버는 그 머리가 있을 때만 값을 푼다. 없으면 날 값 그대로 쓴다(옛 클라이언트, `%` 가 든 ASCII 암호와
  헷갈리지 않게). 업로드 페이지는 늘 인코딩해서 보낸다. 잘못된 퍼센트 인코딩·`uri` 가 아닌 인코딩 이름·푼 뒤 256자를 넘는 암호는
  `400 {error: "bad-password"}`(방 만들기는 `reason: "bad-password"`). 빈 값은 없는 것으로 본다.
  - **한계:** rhwp 가 암호 문자열을 바이트로 바꾸는 방식(HWP5·HWPX)이 한컴과 같은지는, 한컴에서 한글 암호로 저장한 실물이 없어
    확인하지 못했다. 확인한 것은 rhwp 가 건 한글 암호 저장본을 rhwp 가 그 암호로 다시 여는 왕복(시험)과, ASCII 암호의 한컴
    샘플(업스트림 `samples/*-password-123456.*`)을 여는 것이다. 한컴이 건 한글 암호 문서가 열리지 않거나, rhwp 가 한글 암호를
    건 파일이 한컴에서 열리지 않을 수 있다.
- **왕복 점검(6단계 S2):** rhwp 는 저장할 때 손대지 않은 부분의 원본 바이트를 그대로 쓴다. 그래서 "저장 후 비교"는 rhwp 가
  모르는 기능이 있어도 통과하고, 문제는 그 부분을 편집해 모델에서 다시 쓸 때 생긴다. 서버는 방을 만들 때 정본으로 **모든
  부분을 모델에서 다시 쓴 결과**를 원본과 한 번 견준다(`collabRoundtripCheck`). 결과는 `roundtrip: {ok, lost: [{kind, count,
  detail?}], irDiff, reason?}` — `ok: true` 통과, `false` 경고, `null` 점검 못 함(`reason: "timeout"` 시간 상한을 넘음,
  `"error"` 점검 워커 실패). 통과가 아니면 그 방의 `welcome` 에 결과를 실어 참여자가 처음 들어올 때 한 번 알린다("이 부분이
  있는 쪽을 편집하면 사라질 수 있습니다").
  - 점검은 방의 정본 워커가 아닌 **따로 둔 워커**에서 돈다(큰 표 문서는 수십 초 걸린다 — 그동안 정본 편집이 멈추지 않게).
    열기 + 점검에 시간 상한 `COLLAB_ROUNDTRIP_TIMEOUT_MS`(기본 15000)를 두고, 넘으면 그 워커를 버린다.
  - `COLLAB_ROUNDTRIP=warn`(기본): 응답을 점검 때문에 붙잡지 않는다. 방을 먼저 만들고 응답에는 `roundtrip: {pending: true}`
    를 싣는다. 점검이 끝나면 결과를 방 메타에 남기고, 통과가 아니면 그때 방에 있는 참여자에게 `roundtrip` 메시지(§3.2)를 한
    번 보낸다.
  - `block`: 상한까지 기다린다. 통과면 응답에 결과를 싣고, 아니면 방을 만들지 않는다 — 경고는 `422 {error: "roundtrip",
    reason: "roundtrip", roundtrip}`, 점검 못 함은 `reason: "roundtrip-timeout"`·`"roundtrip-error"`(모르는 위험은 막는다).
    **block 은 내용 손실(`ir`·`record`·`bindata`·`ole-clsid`·`cfb`·`package`)과 왕복 점검의 시간 초과·오류만 막는다** — 배치 경고
    (`layout`)만 있거나 배치 점검만 끝내지 못했으면(`layoutUnknown`) 방을 만들고 경고를 응답·`welcome` 에 싣는다(내용은 그대로이고
    모양만 달라진다).
  - `off`: 점검하지 않는다. 점검 보조가 없는 서버도 점검하지 않고 `roundtrip` 을 싣지 않는다.
  - **배치 점검(7단계 B, `COLLAB_ROUNDTRIP_LAYOUT=on|off`, 기본 `on` — 업스트림 샘플 441개에서 더하는 시간 p90 0.65초, 새 시간
    초과 0, 경고 2.3% 모두 실제 차이):** 왕복 점검 다음에 같은 워커·같은 시간 상한(남은 시간)
    안에서, 모델에서만 다시 쓴 결과의 **조판**(쪽 수, 문단·개체 위치)이 원본과 같은지 본다(`collabLayoutCheck` — 업스트림
    render-diff 의 핵심. 판정도 같다: 쪽 수 다름, TextRun ±1 이 아닌 구조 어긋남, 1px 를 넘는 변위). 경고는 `lost` 에
    `{kind: "layout", count: 문제 쪽 수, detail, pages: [원본, 다시 쓴 것], maxDisp(px), worstPage(1부터)}` 로 더한다.
    배치 점검만 시간 상한을 넘거나 실패하면 왕복 점검 결과는 그대로 두고 `layoutUnknown: "timeout" | "error"` 를 단다.
    조판 환경은 정본과 같다(엔진 기본 = 글꼴 정책 `bundled-only`). 안내 문구는 내용 손실과 나눈다: 배치 경고는 "rhwp 가 이
    문서를 다시 쓰면 일부 쪽의 배치(줄 높이·위치)가 달라질 수 있습니다(5쪽 등)"(쪽 수가 달라지면 "(쪽 수 12 → 13)"), 둘 다
    있으면 두 문장을 보인다(`collab-client/src/session/roundtrip.ts`, 업로드 페이지가 같은 규칙).
- 같은 출처가 아닌 브라우저 요청은 Origin 허용 목록을 따른다. CORS 는 열지 않는다(바깥 시스템은 서버끼리 부른다).

### `GET /rooms/{room}/document` — 최신 문서 파일

- 권한: `room` 이 맞고 `view`·`form`·`comment`·`edit` 중 하나. `create` 만으로는 내려받을 수 없다.
- 정본을 내보낸 원본 형식(HWP 또는 HWPX) 파일. 헤더 `X-Collab-Seq` 가 그 문서가 덮는 seq 다.
- 이 파일은 정본을 **내보낸** 것이다. 다시 열면 같은 기록을 재생해 내보낸 뒤 다시 읽은 문서와 digest 가 같다(내보내기 후
  다시 읽기는 항등이 아니다 — §1 기준점). 그래서 이 파일로 방을 다시 만들면 새 계보가 된다.
- **암호를 걸어 내려받기(7단계 C):** 요청 머리 `X-Collab-Document-Password` 가 있으면 정본을 원본 형식 계열로 그 암호를 걸어
  내보낸다(HWPX 는 `exportHwpxWithPassword`, HWP·HWP3 는 `exportHwpWithPassword` — HWP3 는 HWP5 로 나간다). 응답 머리
  `X-Collab-Encrypted: 1`. 그 암호로 열면 위와 같은 digest 이고, 틀린 암호로는 열리지 않는다. 서버는 암호를 저장하지도 기록하지도
  않는다(역방향 프록시도 요청 머리를 기록하지 않게 둔다). 한글 암호는 위 "문서 암호 머리"대로 인코딩해서 보낸다.
  - 원래 암호 문서였던 방(`encryptedSource`, §4.1)은 서버 설정 `COLLAB_ENCRYPTED_DOWNLOAD` 를 따른다. `require`(기본)면 암호 없이
    내려받기를 `403 {error: "password-required"}` 로 거절한다 — 작성자가 건 보호를 내려받을 때라도 되살린다. `optional` 이면 암호
    없이도 내준다(암호 없는 파일). 원래 암호 문서가 아니었던 방은 암호를 주면 걸고, 안 주면 지금처럼 암호 없이 내준다.
  - `POST /rooms` 응답은 그런 방이면 `encryptedSource: true` 를 싣는다(업로드 페이지가 내려받기에 암호 칸을 보인다).

### 그 밖

- `GET /upload`: 업로드 페이지(`#token=<create 토큰>` 으로 연다). 방을 만들고 권한별 링크를 보여 준다.
- `GET /healthz`: `{ok: true, auth, encryptedAllowed}`. `auth` 는 확인 방식(`none`·`hs256`·`url`, 끼운 검증 함수면 그 이름), `encryptedAllowed` 는
  암호 문서를 받는지(`COLLAB_ALLOW_ENCRYPTED`). 인증 없이 누구나 볼 수 있으므로 비밀이 아닌 설정만 싣는다. 편집기는 이것으로
  "공동편집 시작" 메뉴를 보일지, 토큰이 필요한지 정한다.
- 그 밖의 `GET`: `COLLAB_STATIC_DIR` 의 정적 파일(빌드한 편집기). 같은 출처로 띄우면 편집기 주소는
  `https://호스트/?collab#token=…&room=…` 이다(값이 빈 `collab` = 같은 출처 `wss://호스트/`).

## 6. 보안 메모

- 웹 클라이언트는 보안 컨텍스트(https 또는 localhost)에서만 들어간다. LAN 주소의 http 에서는 `crypto.randomUUID` 등이
  없으므로, 들어가지 않고 "공동편집은 HTTPS 에서만 쓸 수 있습니다"를 띄운다.
- 토큰은 주소 조각으로만 받고 읽은 뒤 지운다. 웹 클라이언트는 새로고침에 대비해 탭 저장소(sessionStorage)에 방별로 둔다.
- `hello.name` 은 토큰에 `name` 이 없을 때만 쓰이고, 확인되지 않은 표시용이다.
- `sub` 는 같은 방 참여자에게 보인다. 비밀이나 개인 식별 정보를 넣지 않는다.
- **결과 전송으로 넣는 레코드:** 서버는 `edit` 연결의 `state` 를 바뀐 부분만 모델에서 다시 써서 기록·방송한다(§4.2, 6단계 S1).
  그래서 rhwp 가 해석하지 않는 레코드를 끼운 바이트는 대부분 방에 남지 않는다. 다만 rhwp 가 한컴 원본을 보존하려고 해석하지
  않은 바이트를 모델에 그대로 들고 있다가 저장할 때 다시 쓰는 자리가 있고, 편집 권한자가 그 자리에 넣은 바이트는 서버가 다시
  쓴 바이트에도 남는다(목록: §8). 그러므로 편집 권한은 신뢰하는 사람에게만 준다. 대가는 그 `state` 가 바꾼 구역의 원본 한/글
  바이트 보존이 깨지는 것과, 보낸 사람도 서버가 다시 쓴 바이트를 다시 읽는 것이다. 좁은 권한은 `state` 를 아예 보낼 수 없다
  (§2.2). 다시 쓰기 보조가 없는 서버에서는 이 막기가 없다.
- HS256 비밀키는 32바이트 이상이어야 한다(서버가 짧은 키로는 시작하지 않는다). 저장소 밖에 둔다.
- 암호 문서는 기본으로 막는다(§4.1, §5). `COLLAB_ALLOW_ENCRYPTED=1` 로 허용하면 그런 방의 문서는 암호가 풀린 상태로 서버 디스크·
  참여자에게 남는다(서버는 시작할 때 경고를 남긴다). 서버에서 내려받는 파일은 암호를 걸어서만 나간다(§5, 7단계 C —
  `COLLAB_ENCRYPTED_DOWNLOAD=require` 가 기본). 걸 암호는 내려받는 사람이 그때 준다(저장하지 않는다 — 어디에 둘지는 바깥 시스템이
  정한다).
- 공동편집 중 각자 브라우저에서 studio 로 "저장"하는 파일은 서버의 내려받기를 거치지 않는다. 그래서 원래 암호 문서였던 방
  (welcome 의 `encryptedSource`)에서는 플러그인이 방 문서를 "저장할 때 암호가 필요한 문서"로 연다(8단계 E4, 0002
  `loadDocument` 의 `requirePasswordForSave` — 암호를 풀고 연 문서와 같은 studio 저장 경로). 저장하면 암호를 묻고(한글 암호도
  된다, studio 규칙대로 5자 이상), 두 칸을 비워 두고 확인하면 경고를 보인 뒤 동의할 때만 암호 없이 저장한다. 암호 없이 저장한
  뒤의 저장은 묻지 않는다(studio 의 보호 해제 규칙 — 방에 다시 들어가거나 문서를 다시 열면 다시 묻는다). 다른 이름으로 저장은
  studio 의 「암호 없이 저장」 단추가 따로 있다. 화면 쪽 장치이므로, 수정한 클라이언트가 암호 없이 저장하는 것은 막지 못한다.

## 7. 부품 전용 모드 (6단계 S3)

바깥 시스템의 페이지가 iframe 으로 편집기를 넣어 쓰는 배포에서, 편집기 주소를 직접 열거나 링크를 복사해 단독으로 쓰는 것을
막는다. 서버 설정 `COLLAB_EMBED_ONLY=1` + `COLLAB_EMBED_ORIGINS=https://host.example[,…]`(부모 페이지 출처).

- **iframe 밖에서 열기 거절:** 편집기 HTML 에 `Content-Security-Policy: frame-ancestors <허용 출처>` 를 붙인다 — 브라우저가 허용
  출처의 iframe 에서만 띄운다. 최상위 탐색(`Sec-Fetch-Dest: document`)이면 편집기 대신 "이 편집기는 연결된 시스템 안에서만 열 수
  있습니다" 페이지를 403 으로 준다. `Sec-Fetch-*` 를 보내지 않는 브라우저는 플러그인이 `window.top === window.self` 로 한 번 더
  막는다. `GET /healthz` 가 `embedOnly: true, embedOrigins` 를 알린다.
- **토큰은 부모 페이지에서만:** 이 모드에서 플러그인은 주소의 `#token` 을 쓰지 않는다. 토큰이 필요할 때(처음 `connect`, 다시
  붙을 때 `reconnect`, 만료 `expired`) 부모에게 알림 `{type: "rhwp-collab-token-request", room, reason}` 만 보낸다(비밀 없음).
  알림의 대상 출처는 ① `location.ancestorOrigins[0]` 이 허용 목록에 있으면 그것 ② 그 기능이 없고(Firefox) 허용 출처가 하나면
  그것 ③ 그 밖에만 `*` 이다. 부모는 studio 의 embed 통로(출처가 고정된 MessagePort)로 `plugin.invoke` 를 불러 토큰을 넣는다.
  제한 시간(기본 30초) 안에 토큰이 오지 않으면 "바깥 시스템에서 접속 정보를 받지 못했습니다"를 띄우고 들어가지 않는다.
- **플러그인 표면:** 이 모드에서 `plugin.invoke` 로 부를 수 있는 메서드는 `setToken(token)` 하나다(넣는 방향만). 토큰·사용자
  정보·문서를 읽어 가는 메서드는 두지 않는다 — port 가 묶이기 전의 legacy 통로(`window.postMessage` 의 `rhwp-request`)는 출처
  고정이 없고, 그 경우는 `frame-ancestors` 가 부모를 허용 출처로 제한한다는 전제다.
- **방 만들기:** 업로드 페이지(`/upload`)와 studio 의 "공동편집 시작" 메뉴는 끈다. 방은 바깥 시스템이 `POST /rooms` 로 만든다.
- **신뢰 전제:** 허용된 부모는 embed RPC 로 편집기의 문서를 읽고(`exportHwp`·`getDocumentState` 등) 바꾸고(`loadFile`·
  `applyTextCommand` 등) 플러그인 메서드를 부를 수 있다. 부모 페이지는 신뢰하는 바깥 시스템이어야 한다.
- **한계:** 단독 사용과 링크 돌려쓰기를 막는 장치다. 권한 있는 사용자가 개발자 도구로 iframe 안의 토큰을 꺼내 WebSocket 을 직접
  여는 것까지는 막지 못한다. 그 사용자는 원래 권한이 있다.

부모 페이지 예시(편집기 출처 `https://editor.example`, 토큰은 바깥 시스템의 `/collab-token` 이 만들어 준다고 가정):

```html
<iframe id="editor" src="https://editor.example/?chrome=embed&collab#room=ROOM&name=%ED%99%8D%EA%B8%B8%EB%8F%99"></iframe>
<script>
const EDITOR = 'https://editor.example';
const frame = document.getElementById('editor');
const channel = new MessageChannel();
const sessionId = crypto.randomUUID();
let nextId = 1;
const pending = new Map();
channel.port1.onmessage = ({ data }) => {
  if (data?.type === 'rhwp-response') { pending.get(data.id)?.(data); pending.delete(data.id); }
};
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  channel.port1.postMessage({ type: 'rhwp-request', version: 1, sessionId, id, method, params });
});
// 1. 편집기가 뜨면 embed 통로를 묶는다(처음 묶은 출처로 고정된다)
frame.addEventListener('load', () => {
  frame.contentWindow.postMessage(
    { type: 'rhwp-connect', version: 1, sessionId, capabilities: ['transferable-array-buffer', 'plugin-loader-v1'] },
    EDITOR, [channel.port2]);
}, { once: true });
// 2. 플러그인이 토큰을 달라고 하면(처음·다시 붙음·만료) 새 토큰을 만들어 setToken 으로 넣는다
window.addEventListener('message', async (event) => {
  if (event.origin !== EDITOR || event.source !== frame.contentWindow) return;
  if (event.data?.type !== 'rhwp-collab-token-request') return;
  const { token } = await (await fetch(`/collab-token?room=${encodeURIComponent(event.data.room)}`)).json();
  await request('plugin.invoke', { id: 'collab', method: 'setToken', args: [token] });
});
</script>
```

## 8. 알려진 한계

### 8.1 서버가 결과(`state`)를 다시 쓸 때의 날 바이트 자리

서버는 `edit` 연결이 보낸 `state` 를 바뀐 부분만 모델에서 다시 쓴다(§4.2). rhwp 는 한컴 원본을 잃지 않으려고 **해석하지 않은
바이트를 모델에 그대로 들고 있다가 저장기가 다시 쓰는 자리**를 많이 갖고 있다. 다시 쓸 때 이 자리를 아래처럼 다룬다(6단계 결과
다시 쓰기 강화, `collab-core/src/rewrite_raw.rs`). 원본 바이트를 그대로 쓰는 구역·DocInfo(정본의 봉인된 바이트와 같다)는
그 날 바이트도 정본 것이라 건드리지 않는다. 봉인은 기준이 되지 못한다 — 읽을 때 그 바이트로 다시 계산되어 보낸 사람의 바이트를
보증해 버린다.

**방식**

- **사양 모양(숫자 필드만 남긴다):** 문단 머리 꼬리 `Paragraph.raw_header_extra` 는 길이 0·10·12(더 길면 자른다), 렌더링 행렬
  `ShapeComponentAttr.raw_rendering` 은 길이가 정확히 50 + 96N(N = 앞 u16)일 때만, 문서 속성 `raw_data` 는 26바이트면 그대로.
- **정본이 본 내용일 때만 둔다:** 그 밖의 자리. 자리 종류마다 **문서 전체에서 같은 내용**을 찾는다(개수는 보지 않는다 — 이미
  문서에 있는 바이트를 같은 종류의 다른 자리로 옮기는 것은 새 내용이 아니다. 종류를 넘나들지는 않는다). 없으면 비워 저장기가
  모델에서 다시 만들거나 기본값을 쓴다. 저장기·정상 편집이 고쳐 쓰는 숫자 바이트는 가리고 견준다: 그림 꼬리 1..5(개체 번호),
  구역 정의 꼬리 2..4(바탕쪽 목록 수)·6..8(메모 모양 번호), 바탕쪽 목록 머리 18..20, 셀 꼬리 0..4(글 영역 너비).
- **정본이 본 내용**은 방이 살아 있는 동안 모은다: 정본을 열 때(재시작 복원 포함, 기록 재생 전 — `collabTrackRawSeen`), 결과를
  읽을 때마다(읽기 전·후 문서), 다시 쓰기 직전의 정본. 되돌리기 계열 `state`(`restoreSnapshot` 등)가 지금 정본에 없는 옛 내용을
  되살려도 잃지 않는다.

**자리**

(가) HWP, 구역 스트림 — 정본이 본 내용일 때만

- 문단 `Paragraph.ctrl_data_records`, 묶음 자식 `ShapeComponentAttr.ctrl_data`
- 구역 정의 `SectionDef.raw_ctrl_extra`, `SectionDef.extra_child_records`(레코드 단위 — 원본 바탕쪽 목록에 모르는 것이 있으면
  그 범위를 모두 버려 모델이 바탕쪽을 쓴다)
- 머리말·꼬리말 `Header`/`Footer.raw_ctrl_extra`, 바탕쪽 `MasterPage.raw_list_header`
- 표 머리 `Table.raw_ctrl_data`·수식 머리 `Equation.raw_ctrl_data`(비우면 `common` 으로 다시 쓴다 — 잃는 것이 없다),
  `Table.raw_table_record_extra`, 셀 `Cell.raw_list_extra`
- 그림 `Picture.raw_picture_extra`, 개체 공통 `CommonObjAttr.raw_extra`
- 글상자 `TextBox.raw_list_header_extra`, 연결선 `ConnectorData.raw_trailing`, 다각형 `PolygonShape.raw_trailing`
- 차트 `ChartShape.raw_chart_data`, OLE `OleShape.raw_tag_data`

(나) HWP, DocInfo 항목 — 정본이 본 내용일 때만

- 글꼴, 글자 모양, 문단 모양, 번호, 글머리표, 탭, 스타일, 테두리·배경, BinData 항목의 `raw_data`(문서 속성은 위 사양 모양)
- DocInfo 의 모르는 레코드 `extra_records`(레코드 단위, 개수까지)와 구역 끝 목록 `trailing_lists`(묶음 단위 — 메모·확장
  바탕쪽 목록은 버리면 모델에서 다시 쓴다)는 6단계 S1 결정 (C)대로

(다) HWPX, 원문 그대로 다시 넣는 XML 조각 — 정본이 본 내용일 때만

- `DocInfo.memo_properties_xml`(비우면 메모 모양 레코드로 다시 쓴다), `DocInfo.hwpx_head_tail`(비우면 기본 문서 설정),
  `Numbering.raw_para_heads`, `Bullet.raw_para_head`(비울 때 그림 번호를 모델 필드로 옮긴다), `Field.raw_parameters_xml`

(라) 성격상 불투명한 내용 — 그대로

- 참조되는 BinData 바이트(그림·OLE). 참조되지 않는 것은 버린다. 받는 쪽 프로그램이 그 내용을 다루는 방식의 문제다.
- 한컴 조각 붙여넣기(`pasteHwpJson`)의 그림은 확장자를 클라이언트가 보낸 MIME 의 뒤쪽(`image/png` → `png`)에서 그대로 가져온다.
  저장할 때 BinData 이름에 들어간다(내용과 같은 성격 — 받는 쪽이 이름을 다루는 방식의 문제).

**op 인자로 들어오는 날 바이트**(다시 쓰기로는 막지 못한다 — op 는 모든 참여자가 그대로 적용한다): 정본 워커가 적용하기 전에
`collabCheckOpArgs` 로 본다. 문단 나누기 다섯 함수(`splitParagraph`·`…InCell`·`…InCellByPath`·`…InFootnote`·
`…InHeaderFooter`)의 `removedParaMeta.raw_header_extra` 는 길이 0·10·12 만 받고 아니면 `invalid`.

**한컴 조각 붙여넣기(`pasteHwpJson`, op):** 한컴 조각은 rhwp가 JSON에서 이스케이프해 만든 XML이라 원문·날 바이트 통로가
아니다. 남는 위험은 변환기 이스케이프 결함이고, 시험으로 지킨다(`collab-core` `hancom_paste_fragments_are_escaped_xml_rhwp_builds_not_a_raw_channel`).
JSON 모델에서 XML 을 거치지 않고 문서로 가는 것은 그림 바이트(`bins`, (라)와 같다)뿐이다.

**한계**

- 정본이 본 내용의 기록은 방 메타에 남기지 않는다. 재시작 복원은 "기준점 + 그 뒤 기록 재생"이라 재생 중에 `state` 를 읽을
  때마다 모으면 그 세대 동안 정본이 가졌던 것이 다시 모인다. 세대 전환은 방이 비었을 때만 일어나고, 그 뒤 들어오는 사람은
  welcome 으로 되돌리기 스택이 비워지므로 앞 세대의 내용으로 되돌릴 사람이 없다.
- op 로 생겼다가 결과를 읽기 전에 지워진 날 바이트는 기록에 없을 수 있다. op 가 만드는 날 바이트(책갈피·누름틀 CTRL_DATA,
  표 머리 등)는 비워도 모델에서 다시 만들어진다.
- 정본이 본 적 없는 날 바이트는 비우므로, 모델이 다 표현하지 못하는 자리(그림 효과, OLE 속성, 차트, 그림 링크·누름틀 이름의
  CTRL_DATA 등)에 그런 바이트가 오면 그 내용은 사라진다. 정상 편집은 이런 바이트를 새로 만들지 않는다(조사, 2026-11-27).
  `importParagraphBlock`(state)이 다른 문서에서 가져온 번호·글머리표 원문 조각은 버려지고 모델에서 다시 쓴다(`checkable` 같은
  모델 밖 속성을 잃는다). 그림 글머리표의 BinData 번호가 255 를 넘으면 원문 조각을 비울 때 그림을 잃는다.
- 숫자 비트 자리(`raw_attr`, `raw_break_type` 등)는 내용을 싣지 못해 다루지 않는다.
- (참고) 업스트림 HWPX 파서는 글머리표 `char` 속성을 이스케이프를 풀지 않고 읽는다 — `"`·`&`·`<` 글머리표 글자가 `&` 로
  읽힌다(통로는 아니다, 충실도 결함).

## 9. 다른 플랫폼에서 클라이언트 만들기 (6단계 N1)

§4 의 클라이언트 동작(연결·hello·welcome/catchup·재접속·보내기·재동기화·digest·커서·권한)은 플랫폼 중립 세션
`collab-client/src/session/` 의 `CollabSession` 이 한다. DOM·studio 를 쓰지 않는다(시험이 `window`·`document`·`location`·
`localStorage`·`sessionStorage`·`DecompressionStream` 이 없는지 본다). 다른 편집기·플랫폼은 아래 넷을 넘겨 같은 세션을 쓴다.
studio 어댑터 `collab-client/src/plugin.ts` 가 예다.

**현재 한계:** 편집 기록 엔진(`CollabEngine`, `collab-client/src/engine/`)이 TypeScript 다. 세션은 그 엔진을 만들어 쓰므로,
JS 런타임이 없는 네이티브 클라이언트는 엔진을 옮기거나 같은 규약(§3·§4, 기록 형태와 되감기·보정 규칙)을 따로 구현해야
한다. 엔진의 조율 부분을 Rust(`collab-core`)로 옮기는 일은 아직 정하지 않았다. 문서 자체는 rhwp(WASM 또는 네이티브)다.

### 9.1 넘기는 것

- **`Transport`(연결 하나):** `TransportFactory(events) → { isOpen, send(text), close() }`. 사건은 `open()`, `message(text)`
  (서버 메시지 하나, JSON 문자열), `close()`(닫힘·오류 모두, 한 번)이고, 만든 함수가 돌아온 뒤에 부른다. 세션은 재접속마다
  새로 만들고 옛 연결의 사건은 버린다. `send` 는 열려 있지 않으면 버린다. 브라우저는 WebSocket 을 그대로 감싼다.
- **`CollabHost`(편집기):**

  | 메서드 | 하는 일 |
  |---|---|
  | `doc()` | 지금 문서(rhwp 문서 핸들). 없으면 null |
  | `ensureDoc()` | 첫 참여자: 열린 문서가 없으면 빈 문서를 만든다 |
  | `isEncrypted()` | 지금 문서가 암호 문서인가(§4.1, 모르면 false) |
  | `exportState()` | `base` 로 올릴 바이트(`collabExportState`, gzip) |
  | `openDoc(bytes)` | 받은 바이트로 문서를 연다(gzip 이면 풀어서, 확인 창 없이) |
  | `layoutPolicyHolds(doc)` | 모두 같은 조판 규칙(글꼴 정책)이 걸렸나 — 아니면 세션이 나간다 |
  | `applyExternal(kind, fn)` | 원격 반영 구역(`resync`·`replay`·`remote`·`replaced`). 그 안의 변경은 사용자 편집이 아니다(기록·되돌리기·자동 저장 밖), 끝나면 화면을 갱신한다 |
  | `captureCaret()` / `restoreCaret(snap, moved)` | 캐럿 스냅숏. `text` 는 엔진 좌표(못 바꾸면 null), 나머지는 편집기 좌표. 원격 반영 뒤 `moved`(없으면 원래 자리)에 놓는다. 스냅숏이 null 이면 캐럿 없음 |
  | `isComposing()` | 입력기 조합 중인가(조합 중에는 원격을 보류하고 보내지 않는다) |
  | `event(e)` | 세션이 알리는 일(§9.2) |
  | `log(level, msg)` | 개발자 진단(선택) |

- **`TokenProvider`:** §2.1 그대로(`connect`·`reconnect`·`expired`). 세션 안의 `AuthSession` 이 부른다.
- **`Clock`:** `now`·`setTimeout`·`clearTimeout`·`setInterval`·`clearInterval`(기본 globalThis — 시험에서 바꿔 끼운다).

편집기는 세션에 이런 일을 알린다: 문서 호출을 `session.engine.intercept(...)` 로 가로채 기록, 내 편집이 기록됨
`edited()`, 문서 표시가 바뀜 `changed()`, 조합 끝 `compositionEnded()`, 편집기가 문서를 바꿈 `documentSwapped()`(세션이 일으킨
것이 아니면 방을 나간다). 되돌리기를 붙이면 `setUndo({ onRemote, clear })`(start 전). 이탈 확인은 `hasUnconfirmedEdits()`.
권한 문(`engine.setScope`)과 메모 작성자(`engine.setMemoAuthor`)는 세션이 입장 때 건다 — 편집기가 하지 않는다.

### 9.2 세션이 알리는 것

문구는 정하지 않고 이유 코드로 넘긴다. 기본 한국어 문구는 `session/texts.ts`(`noticeTexts`·`leaveText`·`leftBanner`·
`resyncCauseText`·`PHASE_TEXT`)에 있고, 편집기는 그대로 쓰거나 덮어쓴다.

| 사건 | 뜻 | 편집기가 할 일(studio 예) |
|---|---|---|
| `status` | 상태가 바뀜(`session.phase`·`lastSeq`·`name`) | 상태 표시 |
| `cursors` | 다른 사람 커서가 바뀜(`session.cursors`, 엔진 좌표) | 커서 그리기 |
| `notice` | 안내 하나(아래 코드) | 잠깐 보이는 안내 |
| `disconnected` / `reconnected` | 방에 들어간 뒤 끊김 / 다시 붙음 | 배너 / 걷기 |
| `admitted` | 확인된 사용자·권한(`welcome.user`) | 화면 일(양식 모드 등) |
| `desynced` | 동기화가 깨져 멈춤(까닭 코드) | 새로고침 안내 |
| `left` | 방에서 나옴(까닭 코드) | 빌린 자원을 풀고 안내 |

- **안내(`notice.code`):** `joined`, `resynced`, `resume-fallback`, `reconnected{received}`, `long-disconnect`,
  `dropped{count}`, `too-large`, `invalid`, `forbidden{reason}`, `denied{message}`(엔진 권한 문), `view-only`,
  `encrypted-source`, `roundtrip{result}`.
- **재동기화 까닭(`ResyncCause`):** `seq-gap{expected, got, during}`, `apply-failed{error, during}`, `diverged{seq}`,
  `invalid{reason}`, `forbidden{reason}`, `too-large{limit, side}`, `error{error}`, `limit{limit, last}`(1분 3회를 넘음 —
  `desynced` 에서만).
- **나온 까닭(`LeaveReason`):** `swapped`, `incompatible`, `encrypted`, `base-too-large`, `base-invalid{reason}`,
  `base-forbidden`, `font-policy`, `unauthorized{reason, unsent}`, `host{detail}`(편집기가 `leave` 로 나가게 함).
- **상태(`session.phase`):** `left` > `desynced` > `connecting` > `closed` > `resyncing` > `loading` > `sending` > `synced`
  (앞의 것이 이긴다). `session.status()` 는 진단용 전체 상태다(studio 의 `__collab.status()`).

```ts
const session = new CollabSession({ room, name, transport, host, getToken });
editor.onCall((method, args, invoke, target) => session.engine.intercept(method, args, invoke, target));
editor.on('mutated', () => session.edited());
editor.on('changed', () => session.changed());
editor.on('composition-end', () => session.compositionEnded());
editor.on('document-swapped', () => session.documentSwapped());
session.start();
// 내릴 때: session.dispose()
```
