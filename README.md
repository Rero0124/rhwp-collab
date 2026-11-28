# rhwp-collab

rhwp-collab은 한글(HWP/HWPX) 문서를 여러 사람이 웹 브라우저에서 동시에 편집할 수 있게 해 주는 공동편집
프로젝트입니다.

문서를 읽고, 편집하고, 화면에 그리는 일은 [rhwp](https://github.com/edwardkim/rhwp)가 합니다. rhwp-collab은
그 위에서 각자의 편집을 주고받고, 순서를 맞추고, 서버에 저장하는 일을 맡습니다. rhwp를 포크하지 않고 고정한
버전에 작은 패치 두 개만 적용하기 때문에, rhwp가 업데이트되어도 따라가기 쉽습니다.

> 실험 단계의 프로젝트입니다. 다른 기기에서 쓰려면 HTTPS 와 접속 인증을 켜야 합니다([다른 기기에서 쓰기](#다른-기기에서-쓰기)).

## 주요 기능

- 같은 방에 들어온 사람들이 하나의 문서를 실시간으로 함께 편집하고, 서로의 커서 위치를 봅니다.
- 같은 문단에 동시에 입력해도 서로의 글자가 사라지지 않고 이어집니다.
- rhwp-studio의 편집 기능을 모두 동기화합니다. 자주 쓰는 기능은 편집 동작만 보내서 빠르고, 그 밖의 기능은
  편집 결과를 보내서 느리지만 빠짐없이 맞춰집니다.
- Ctrl+Z 로 내 편집만 되돌립니다. 다른 사람이 그 뒤에 같은 자리를 고쳤으면 되돌리지 않고 알려 줍니다.
- 연결이 끊겨도 계속 편집할 수 있고, 다시 연결되면 밀린 편집을 자동으로 주고받습니다.
- 서버가 편집을 받는 즉시 디스크에 기록하므로, 서버가 갑자기 꺼져도 편집이 사라지지 않습니다.
- Chrome, Firefox, Safari 엔진(WebKit)과 macOS, Windows에서 같은 문서가 같은 배치로 보입니다.
- 파일을 올려 방을 만들고 링크로 나눠 줄 수 있습니다. 편집기의 파일 메뉴에서 지금 문서로 바로 시작할 수도 있습니다. 링크마다 편집, 보기, 양식 입력, 메모 권한을 줍니다.
- 회사 문서 시스템처럼 이미 로그인과 파일 보관이 있는 곳에 붙일 수 있습니다. 토큰(JWT)이나 바깥 인증 서버로 접속을
  확인하고, API 로 방을 만들고 최신 문서를 받습니다.

## 빠른 시작

### 필요한 것

- [rustup](https://rustup.rs). Rust 버전과 WebAssembly 타깃은 rhwp가 지정한 것을 자동으로 씁니다.
- Node.js 23.6 이상
- git

### 설치

```sh
git clone https://github.com/Rero0124/rhwp-collab.git
cd rhwp-collab

scripts/bootstrap.sh                                             # rhwp를 받고 패치를 적용합니다
cargo install wasm-pack --version 0.15.0 --locked --root .tools  # 빌드 도구를 프로젝트 안에 설치합니다
scripts/build-wasm.sh                                            # rhwp를 WebAssembly로 빌드합니다
(cd upstream/rhwp/rhwp-studio && npm ci)
(cd server && npm ci)
```

`bootstrap.sh`는 rhwp 저장소에서 필요한 부분만 받아 `upstream/rhwp`에 둡니다. 처음 받을 때 430MB 정도
내려받습니다.

패치(`patches/`)나 `upstream.lock`이 바뀐 커밋을 받았으면 `scripts/bootstrap.sh`를 다시 실행하고 WASM 을 다시
빌드합니다. `bootstrap.sh`는 적용한 패치의 사본을 `upstream/rhwp/.git/cc-applied/`에 남겨 두었다가, 패치가 바뀌면
옛 패치를 되돌리고 새 패치를 적용합니다. `upstream/rhwp`에 패치가 아닌 변경이 섞여 있으면 덮어쓰지 않고 멈춥니다.

### 실행 (이 컴퓨터에서 시험)

터미널 두 개에서 서버와 rhwp-studio 개발 서버를 각각 띄웁니다. 서버가 `127.0.0.1` 에서만 받으면 접속 인증 없이 뜹니다.

```sh
node server/server.mjs                        # 공동편집 서버 (ws://127.0.0.1:8787)
```

```sh
cd upstream/rhwp/rhwp-studio && npx vite      # 편집기 (http://127.0.0.1:7700)
```

브라우저 창 두 개에서 아래 주소를 열면, 두 창이 같은 문서를 함께 편집합니다.

```
http://127.0.0.1:7700/?collab=ws://127.0.0.1:8787&room=demo&name=A
http://127.0.0.1:7700/?collab=ws://127.0.0.1:8787&room=demo&name=B
```

### 실행 (배포)

편집기를 정적 파일로 빌드해 서버가 함께 내주게 합니다. 그러면 한 주소가 편집기이자 공동편집 서버가 됩니다.

```sh
scripts/build-studio.sh                                          # 편집기 빌드 → target/studio
node server/token.mjs --new-secret > /안전한/경로/collab-secret    # 비밀키 (저장소 밖에 둡니다)

HOST=0.0.0.0 PORT=8443 \
COLLAB_AUTH=hs256 COLLAB_AUTH_SECRET_FILE=/안전한/경로/collab-secret \
COLLAB_TLS_CERT=/경로/cert.pem COLLAB_TLS_KEY=/경로/key.pem \
COLLAB_STATIC_DIR=target/studio COLLAB_DATA_DIR=./data \
node server/server.mjs
```

방은 파일을 올려 만듭니다. 만들기 권한이 있는 토큰으로 업로드 페이지를 엽니다.

```sh
node server/token.mjs --room '*' --scope create --name 관리자 --ttl 1h   # 비밀키는 COLLAB_AUTH_SECRET(_FILE)에서 읽습니다
```

```
https://호스트:8443/upload#token=<위에서 만든 토큰>
```

파일을 올리면 편집, 보기, 양식 입력, 메모 링크가 나옵니다. 받은 사람은 링크를 열고 자기 이름을 입력하면 들어옵니다.
편집기 파일 메뉴의 "공동편집 시작…"으로도 만들 수 있습니다(사용 방법 참고).

## 사용 방법

### 방에 들어가기

편집기 주소 뒤에 다음 값을 붙여서 엽니다. 쿼리(`?`)와 조각(`#`) 어느 쪽에 두어도 되지만, 토큰은 조각에만 둡니다.

| 이름 | 자리 | 설명 |
|---|---|---|
| `collab` | 쿼리 | 공동편집 서버 주소. 값을 비우면(`?collab`) 편집기와 같은 주소(`wss://<현재 호스트>/`)를 씁니다 |
| `room` | 조각 또는 쿼리 | 방 이름. 같은 방에 들어온 사람끼리 같은 문서를 편집합니다 |
| `token` | 조각 | 접속 토큰. 편집기가 읽은 뒤 주소에서 지웁니다. 새로고침해도 같은 탭에서는 다시 들어옵니다 |
| `name` | 조각 또는 쿼리 | 다른 사람 화면의 커서 옆에 보일 이름. 토큰에 이름이 있으면 그 이름을 씁니다 |

배포한 서버의 링크는 `https://호스트/?collab#token=…&room=…` 모양입니다. 인증을 켠 서버에서는 방을 서버가 만들므로
(`POST /rooms`, 업로드 페이지), 주소에 아무 방 이름이나 넣어서는 들어갈 수 없습니다.

인증을 끈 서버(이 컴퓨터에서 시험)에서는 방에 처음 들어온 사람이 그때 열려 있는 문서를 방의 문서로 올리고, 열린 문서가
없으면 빈 문서로 시작합니다. 나중에 들어온 사람은 그 방의 최신 문서를 받습니다.

### 편집기에서 공동편집 시작

서버가 편집기를 함께 내주는 배포에서는(`scripts/build-studio.sh` 로 빌드해 `COLLAB_STATIC_DIR` 로 지정), 평소처럼 연
편집기의 파일 메뉴에서 "공동편집 시작…"을 골라 지금 문서를 방으로 만들 수 있습니다. 방을 만들면 편집, 보기, 양식 입력,
메모 링크와 복사 단추가 나오고, "이 방으로 들어가기"를 누르면 그 방으로 다시 열립니다. 문서는 이미 방에 올라가 있으므로
잃지 않습니다.

- 인증을 끈 서버(`COLLAB_AUTH=none`)에서는 토큰 없이 만듭니다. 링크는 편집기 링크 하나(`?collab#room=…`)입니다.
- `COLLAB_AUTH=hs256` 에서는 방 만들기(`create`) 권한이 있는 토큰이 필요합니다. 편집기를 `https://호스트/#create=<토큰>`
  으로 열면 편집기가 토큰을 읽고 주소에서 지웁니다. 토큰은 같은 탭에서만 기억합니다. 토큰 없이 열었다면 대화상자에 토큰을
  넣는 칸이 나옵니다. 링크를 받은 사람은 링크를 열고 자기 이름을 입력하면 들어옵니다.
- `COLLAB_AUTH=url`(바깥 시스템이 방과 토큰을 만드는 방식)에서는 메뉴가 보이지 않습니다.
- 암호를 풀고 연 문서는 "암호 문서는 공동편집할 수 없습니다"가 뜨고 방을 만들지 않습니다. 서버가
  `COLLAB_ALLOW_ENCRYPTED=1` 이면 경고를 보인 뒤 만듭니다.
- 서버를 찾지 못하면 메뉴가 생기지 않습니다. 공동편집 링크로 연 창과 다른 페이지에 넣은 편집기(iframe, embed)에도 메뉴가
  없습니다.

개발 서버(`npx vite`)에서 쓰려면 공동편집 서버 주소를 주고 띄웁니다. 개발 서버가 방 만들기 요청을 그 서버로 넘기고, 링크에는
그 서버의 ws 주소가 실립니다.

```sh
cd upstream/rhwp/rhwp-studio && COLLAB_DEV_SERVER=http://127.0.0.1:8787 npx vite
```

### 편집 중에 보이는 안내

- 다른 사람의 편집과 겹쳐 내 편집이 취소되면 알림이 뜹니다. 주로 표 만들기나 붙여넣기처럼 문서 구조를
  바꾸는 편집이 같은 구역의 다른 편집과 동시에 일어날 때 생깁니다.
- 연결이 끊기면 화면에 안내가 뜹니다. 그동안의 편집은 다시 연결되면 보내집니다.
- 공동편집 중에는 모든 참여자가 같은 배치를 보도록 rhwp 내장 글꼴 규칙으로 배치합니다. 그래서 혼자 편집할
  때와 줄이나 쪽 나눔이 조금 다를 수 있습니다.
- 링크가 만료됐거나 맞지 않으면 들어가지 않고 안내가 뜹니다. 편집 중에 만료되면 연결이 끊긴 뒤 다시 들어갈 때 안내가
  뜨고, 보내지 못한 편집 수를 알려 줍니다.
- 보기 링크로 들어오면 편집이 다른 사람에게 보내지지 않고, 서버 문서로 되돌아갑니다.
- `http://` 주소(이 컴퓨터가 아닌 곳)로 열면 "공동편집은 HTTPS 에서만 쓸 수 있습니다"가 뜨고 들어가지 않습니다.

### 문서 저장

서버를 띄울 때 `COLLAB_DATA_DIR`을 지정하면 방마다 문서가 디스크에 저장됩니다.

```sh
COLLAB_DATA_DIR=./data node server/server.mjs
```

방 디렉터리의 `doc.hwp`(또는 `doc.hwpx`)가 최신 문서 파일이고, 편집이 몇 초 멈추거나 모두 나갈 때 갱신됩니다.
서버를 다시 시작하면 저장된 기록으로 방을 그대로 복원합니다.

지금 문서는 API 로도 받을 수 있습니다: `GET /rooms/<방>/document`(그 방에 들어갈 수 있는 토큰을
`Authorization: Bearer` 로). 업로드 페이지의 "지금 문서 내려받기"도 같은 API 입니다. `COLLAB_DATA_DIR` 이 없으면 방과
문서는 서버 메모리에만 있습니다.

## 서버 설정

환경 변수로 설정합니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `8787` | 서버 포트. HTTP(S) 와 WebSocket 을 함께 받습니다 |
| `HOST` | `127.0.0.1` | 서버가 받을 주소. 루프백이 아니면 `COLLAB_AUTH` 를 정해야 시작합니다 |
| `COLLAB_AUTH` | 루프백이면 `none` | 접속 확인 방식: `hs256`(JWT 공유 비밀키), `url`(바깥 인증 서버), `none`(확인 안 함). 루프백이 아닌 주소에 `none` 을 주면 경고를 남기고 뜹니다 |
| `COLLAB_AUTH_SECRET` | 없음 | `hs256` 비밀키(32바이트 이상). `COLLAB_AUTH_SECRET_FILE` 로 파일에서 읽을 수도 있습니다 |
| `COLLAB_AUTH_URL` | 없음 | `url` 방식에서 `{token, room}` 을 POST 할 주소. `{ok, sub, name, scope}` 를 돌려줘야 합니다 |
| `COLLAB_INVITE_TTL` | `24h` | 방을 만들 때 서버가 만드는 초대 링크의 수명(`hs256` 만). `30m`, `7d`, 초 단위 숫자 |
| `COLLAB_ROLE_MAP` | 없음 | 바깥 시스템의 역할 이름 → 권한 매핑표(JSON 파일, 예: `{"작성자":"edit","검토자":"comment","열람자":"view"}`). 표에 모르는 권한 이름이 있으면 시작하지 않습니다 |
| `COLLAB_EMBED_ONLY` | 없음 | `1` 이면 부품 전용 모드: 편집기는 `COLLAB_EMBED_ORIGINS` 의 페이지 안(iframe)에서만 열리고, 업로드 페이지와 "공동편집 시작" 메뉴는 꺼집니다 |
| `COLLAB_EMBED_ORIGINS` | 없음 | 편집기를 넣을 수 있는 부모 페이지 출처(쉼표로 구분, 예: `https://docs.example.com`) |
| `COLLAB_ROUNDTRIP` | `warn` | 파일로 방을 만들 때 rhwp 가 문서의 모든 부분을 다룰 수 있는지 점검합니다. `warn` 은 방을 먼저 만들고 뒤에서 점검해 결과를 방에 알리고, `block` 은 점검이 끝날 때까지 기다려 통과하지 못한(또는 시간 안에 끝나지 않은) 문서로 방을 만들지 않고, `off` 는 점검하지 않습니다. `block` 은 내용 손실만 막고, 배치(`COLLAB_ROUNDTRIP_LAYOUT`) 경고는 경고로만 알립니다 |
| `COLLAB_ROUNDTRIP_TIMEOUT_MS` | `15000` | 왕복 점검 시간 상한(ms). 점검은 따로 둔 작업자에서 돌고, 넘으면 "점검 못 함(시간 초과)"으로 둡니다 |
| `COLLAB_ROUNDTRIP_LAYOUT` | `on` | 왕복 점검 다음에 배치(쪽 수·문단·개체 위치)도 같은지 봅니다. 같은 시간 상한 안에서 돌고, 시간이 모자라면 배치만 "점검 못 함"으로 둡니다. `off` 는 배치를 보지 않습니다 |
| `COLLAB_ALLOW_ENCRYPTED` | 없음 | `1` 이면 암호 문서로도 방을 엽니다. 문서 암호는 방을 만들 때 요청 머리 `X-Collab-Document-Password` 로 한 번 받고 저장하지 않습니다. 역방향 프록시가 요청 머리를 기록하지 않게 설정하세요. 그 방의 문서는 암호가 풀린 상태로 저장되고 오갑니다(기본은 거절) |
| `COLLAB_ENCRYPTED_DOWNLOAD` | `require` | 원래 암호 문서였던 방을 내려받을 때. `require` 는 암호를 걸어서만 내주고(내려받는 사람이 `X-Collab-Document-Password` 로 걸 암호를 줌 — 한글은 퍼센트 인코딩 + `X-Collab-Document-Password-Encoding: uri`, 저장하지 않음), `optional` 은 암호 없이도 내줍니다 |
| `COLLAB_ALLOWED_ORIGINS` | 없음 | 쉼표로 구분한 출처 목록. 있으면 그 밖의 브라우저 출처에서 오는 WebSocket·방 만들기를 거절합니다. 같은 출처는 언제나 허용합니다 |
| `COLLAB_TLS_CERT`, `COLLAB_TLS_KEY` | 없음 | PEM 인증서와 키 파일. 둘 다 있으면 HTTPS/wss 로 뜹니다 |
| `COLLAB_STATIC_DIR` | 없음 | 함께 내줄 편집기 빌드(`scripts/build-studio.sh` 의 `target/studio`) |
| `COLLAB_DATA_DIR` | 없음 | 문서를 저장할 디렉터리. 없으면 메모리에만 두고 서버를 끄면 사라집니다 |
| `COLLAB_CANONICAL` | 켜짐 | 서버에서 편집을 먼저 검사합니다. `0`이면 끕니다. 저장, 파일로 방 만들기, 문서 내려받기, 양식·메모 권한에 필요합니다 |
| `COLLAB_MAX_MESSAGE_BYTES` | 64MB | 주고받을 수 있는 최대 크기. 이보다 큰 문서로는 방을 열 수 없습니다 |
| `COLLAB_DOC_SAVE_IDLE_MS` | `5000` | 편집이 이 시간만큼 멈추면 문서 파일을 갱신합니다 |
| `COLLAB_GENERATION_IDLE_MS` | `600000` | 방이 이 시간만큼 비면 쌓인 기록을 문서 파일로 정리합니다 |

### 다른 기기에서 쓰기

다른 기기의 브라우저는 `https://` 주소에서만 공동편집을 합니다. 브라우저가 `http://` 주소(이 컴퓨터가 아닌 곳)에서는
공동편집에 필요한 기능을 주지 않기 때문입니다. 방법은 두 가지입니다.

- 서버가 직접 HTTPS 로 뜹니다: `COLLAB_TLS_CERT`·`COLLAB_TLS_KEY` 를 줍니다(위 [실행 (배포)](#실행-배포)).
- 앞단의 역방향 프록시(nginx, Caddy 등)가 TLS 를 맡고, 서버는 `127.0.0.1` 의 http 로 둡니다. 프록시는 WebSocket
  업그레이드를 넘겨야 하고, 큰 문서를 위해 본문 크기 제한을 `COLLAB_MAX_MESSAGE_BYTES` 이상으로 둡니다.

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 1h;
    client_max_body_size 64m;
}
```

프록시를 쓸 때도 서버가 루프백 주소에서만 받으면 인증 없이 뜹니다. 프록시 뒤에 둘 때는 `COLLAB_AUTH` 를 꼭 정하세요.

### 다른 시스템에 붙이기

- **토큰:** JWT HS256 을 쓰면 어느 언어의 라이브러리로도 토큰을 만들 수 있습니다. 클레임은 `sub`(사용자), `name`(보일 이름),
  `room`(방 또는 `*`), `exp`(만료), `scope`(`view`·`form`·`comment`·`edit`·`create`, 공백으로 구분)입니다. 이미 로그인
  세션이 있으면 `COLLAB_AUTH=url` 로 서버가 그 시스템에 토큰을 물어보게 할 수 있습니다.
- **방 만들기:** `POST /rooms`(본문 = HWP/HWPX 파일, `create` 권한 토큰) → `{room, invite}`. 사용자에게
  `https://호스트/?collab#token=…&room=…` 링크를 줍니다.
- **문서 받기:** `GET /rooms/<방>/document` → 최신 문서 파일.
- **역할 그대로 쓰기:** 바깥 시스템의 역할 이름(예: 작성자·검토자·열람자)을 토큰의 `roles` 나 확인 답에 그대로 주고,
  `COLLAB_ROLE_MAP` 매핑표로 권한을 정할 수 있습니다. 표에 없는 역할은 아무 권한도 받지 못합니다.
- **화면 안에 넣기:** `COLLAB_EMBED_ONLY=1` 이면 편집기는 허용한 페이지의 iframe 안에서만 열리고, 토큰은 그 페이지가
  편집기에 직접 넣습니다(주소에 싣지 않음). 부모 페이지 예시는 규약 §7 에 있습니다.
- 메시지 형식, 이유 코드, 재접속 절차는 [공동편집 규약](docs/collab-protocol.md)에 있습니다. 네이티브 클라이언트도 이 문서를
  따릅니다.

## 동작 원리

편집을 보내는 방법은 두 가지입니다. rhwp의 편집 함수 중 결과가 항상 같다고 확인된 함수는 "몇 번째 문단
몇 번째 글자에 무엇을 넣었다"처럼 호출 자체를 보내고, 다른 기기에서 같은 함수를 다시 실행합니다. 확인되지
않은 함수는 편집이 끝난 문서 전체를 보냅니다. rhwp를 업데이트하면 함수마다 이전 버전과 결과를 비교해서,
달라진 함수는 자동으로 문서 전체를 보내는 쪽으로 옮깁니다.

편집 순서는 서버가 정합니다. 내 편집이 서버에서 확정되기 전에 다른 사람의 편집이 먼저 도착하면, 내 편집을
잠시 되돌리고 서버 순서대로 다시 적용하면서 위치를 보정합니다. 그래서 모든 참여자의 문서가 항상 같은 결과로
모입니다.

서버도 같은 rhwp를 실행해서 원본 문서를 들고 있습니다. 편집이 오면 기록하기 전에 먼저 적용해 보고, 오류가
나는 편집은 거절합니다. 참여자의 문서가 서버와 달라지면 그 참여자만 문서를 다시 받습니다.

```
브라우저 (rhwp-studio + 공동편집 플러그인)          서버
  편집 기록 ─────────── 편집 ───────────▶  순서 결정, 검사, 저장
  되감기와 다시 적용 ◀── 확정된 편집 ────  다른 참여자에게 전달
```

## 프로젝트 구성

| 경로 | 내용 |
|---|---|
| `upstream.lock` | 사용하는 rhwp 저장소와 커밋 |
| `patches/rhwp/` | rhwp에 적용하는 패치 |
| `collab-core/` | rhwp와 함께 빌드되는 Rust 코드 (스냅샷, 위치 보정, 문서 비교) |
| `collab-client/` | 편집 기록 엔진, 플랫폼 중립 세션 계층(`src/session/`), rhwp-studio 플러그인 |
| `server/` | 공동편집 서버 (인증 `auth.mjs`, HTTP API·정적 파일 `http.mjs`, 업로드 페이지 `public/`, 토큰 도구 `token.mjs`) |
| `scripts/` | 설치, 빌드, rhwp 업데이트용 스크립트 |
| `docs/` | 단계별 설계와 검증 기록 |

## 개발

### 테스트

```sh
(cd collab-client && npm test)
(cd server && npm test)
(cd upstream/rhwp && CARGO_TARGET_DIR=../../target cargo test -p rhwp --lib --locked collab::)

# 여러 참여자의 무작위 동시 편집 시험
node collab-client/test/sim.mjs --seeds 500 --ops 200 --clients 3
```

브라우저 시험은 `collab-client/e2e/`에 있으며 Chrome이 필요합니다. 각 파일 첫머리에 준비할 것과 실행 방법이
적혀 있습니다. 배포 구성(HTTPS, 인증, 파일로 방 만들기)은 `collab-client/e2e/s5-deploy.mjs` 로 시험합니다.

### rhwp 버전 올리기

1. `upstream.lock`의 `rev`를 새 커밋으로 바꾸고 `scripts/bootstrap.sh`를 실행합니다. 적용해 둔 패치는
   `bootstrap.sh`가 먼저 되돌린 뒤 새 커밋으로 바꿉니다. `upstream/rhwp`에 패치가 아닌 변경이 있으면 아무것도
   바꾸지 않고 멈춥니다. 새 커밋에 패치가 맞지 않으면 `upstream/rhwp`에서 고친 뒤 `scripts/update-patch.sh`로
   패치를 다시 만들고 `bootstrap.sh`를 다시 실행합니다.
2. `scripts/build-wasm.sh`를 실행합니다. 함수별 결과 비교가 자동으로 돌아서 동기화 방식을 다시 정합니다.
3. 브라우저 간 시험 `collab-client/e2e/s31-cross-browser.mjs`를 다시 돌립니다.

참여자와 서버는 같은 버전으로 빌드되어 있어야 합니다. 버전이 다른 참여자는 방에 들어올 수 없습니다.

## 알려진 한계

- 공동편집 중 되돌리기(Ctrl+Z)는 내 편집만, 그 뒤에 다른 사람이 같은 자리를 고치지 않았을 때만 됩니다. 막히면 안내가 뜹니다.
  표 만들기·붙여넣기·표 지우기도 바꾼 문단 범위를 남이 건드리지 않았으면 되돌립니다. 쪽 설정처럼 구역 전체를 바꾸는 편집과
  표 만들기 대화상자의 상세 옵션 경로는 그 뒤에 누구든 편집했으면 되돌릴 수 없습니다.
- 보기 링크로 들어오면 편집 화면은 그대로 보이지만, 입력은 문서에 닿기 전에 막히고 안내가 뜹니다. 양식 입력 링크는 studio 의
  양식 모드로 열리고, 메모 링크는 메모만 달 수 있습니다(자기 메모만 고치고 지움).
- 암호가 걸린 문서는 기본으로 공동편집할 수 없습니다. `COLLAB_ALLOW_ENCRYPTED=1` 로 허용하면 업로드 페이지에서 문서 암호를
  받아 열지만, 그 방의 문서는 서버에 암호 없이 저장됩니다. 서버에서 내려받을 때는 암호를 걸어서만 내줍니다(업로드 페이지의
  암호 칸 — `COLLAB_ENCRYPTED_DOWNLOAD`). 공동편집 중 각자 편집기에서 "저장"할 때도 암호를 묻습니다. 칸을 비워 두면
  경고를 보인 뒤 암호 없이 저장할 수 있습니다.
- 한글이 든 문서 암호도 쓸 수 있습니다(업로드 페이지가 인코딩해서 보냅니다 — 규약 문서의 "문서 암호 머리"). 다만 rhwp 가 한글
  암호를 다루는 방식이 한컴과 같은지는 한컴에서 한글 암호로 저장한 실물로 확인하지 못했습니다.
- 편집 권한자가 결과 전송으로 보낸 문서는 서버가 다시 써서 모두에게 보냅니다. rhwp 가 해석하지 않는 레코드와, 한컴 원본을
  보존하려고 그대로 들고 있는 바이트는 서버가 그 방에서 본 적 있는 내용이 아니면 사라집니다(규약 문서의 알려진 한계).
  그림·OLE 같은 첨부 데이터의 내용은 그대로 갑니다. 편집 권한은 신뢰하는 사람에게 주세요. 양식 입력·메모 권한은 결과 전송을
  보낼 수 없어서 이 경로가 없습니다.
- 링크 하나로 받은 토큰은 갱신되지 않습니다. 만료되면 링크를 다시 받아야 합니다.
- 웹 브라우저에서만 동작합니다.
- Linux 브라우저에서는 시험하지 않았습니다.

## 문서

- [전체 구조와 1단계](docs/collab-design.md)
- [2단계: 모든 기능 동기화와 동시 편집](docs/collab-stage2.md)
- [3단계: 서버 검사, 저장, 재접속, 기기 간 시험](docs/collab-stage3.md)
- [4단계: 사용자별 되돌리기](docs/collab-stage4.md)
- [5단계: 배포 준비(인증, HTTPS, 파일로 방 열기, 권한)](docs/collab-stage5.md)
- [6단계: 보안 강화와 부품화 (진행 중)](docs/collab-stage6.md)
- [공동편집 규약 (클라이언트·서버 메시지, 토큰, 이유 코드)](docs/collab-protocol.md)

## 라이선스

[MIT](LICENSE)로 배포합니다. 패치 파일에 들어 있는 rhwp 코드는 rhwp의 MIT 라이선스를 따릅니다
([NOTICE.md](NOTICE.md)).
