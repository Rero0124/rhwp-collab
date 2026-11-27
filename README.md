# rhwp-collab

rhwp-collab은 한글(HWP/HWPX) 문서를 여러 사람이 웹 브라우저에서 동시에 편집할 수 있게 해 주는 공동편집
프로젝트입니다.

문서를 읽고, 편집하고, 화면에 그리는 일은 [rhwp](https://github.com/edwardkim/rhwp)가 합니다. rhwp-collab은
그 위에서 각자의 편집을 주고받고, 순서를 맞추고, 서버에 저장하는 일을 맡습니다. rhwp를 포크하지 않고 고정한
버전에 작은 패치 두 개만 적용하기 때문에, rhwp가 업데이트되어도 따라가기 쉽습니다.

> 실험 단계의 프로젝트입니다. 접속 인증이 없으므로 신뢰할 수 있는 네트워크에서만 사용하세요.

## 주요 기능

- 같은 방에 들어온 사람들이 하나의 문서를 실시간으로 함께 편집하고, 서로의 커서 위치를 봅니다.
- 같은 문단에 동시에 입력해도 서로의 글자가 사라지지 않고 이어집니다.
- rhwp-studio의 편집 기능을 모두 동기화합니다. 자주 쓰는 기능은 편집 동작만 보내서 빠르고, 그 밖의 기능은
  편집 결과를 보내서 느리지만 빠짐없이 맞춰집니다.
- 연결이 끊겨도 계속 편집할 수 있고, 다시 연결되면 밀린 편집을 자동으로 주고받습니다.
- 서버가 편집을 받는 즉시 디스크에 기록하므로, 서버가 갑자기 꺼져도 편집이 사라지지 않습니다.
- Chrome, Firefox, Safari 엔진(WebKit)과 macOS, Windows에서 같은 문서가 같은 배치로 보입니다.

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

### 실행

터미널 두 개에서 서버와 rhwp-studio를 각각 띄웁니다.

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

## 사용 방법

### 방에 들어가기

편집기 주소 뒤에 다음 값을 붙여서 엽니다.

| 이름 | 설명 |
|---|---|
| `collab` | 공동편집 서버 주소 |
| `room` | 방 이름. 같은 방에 들어온 사람끼리 같은 문서를 편집합니다 |
| `name` | 다른 사람 화면의 커서 옆에 보일 이름 |

방에 처음 들어온 사람이 그때 열려 있는 문서를 방의 문서로 올리고, 열린 문서가 없으면 빈 문서로 시작합니다.
나중에 들어온 사람은 그 방의 최신 문서를 받습니다.

### 편집 중에 보이는 안내

- 다른 사람의 편집과 겹쳐 내 편집이 취소되면 알림이 뜹니다. 주로 표 만들기나 붙여넣기처럼 문서 구조를
  바꾸는 편집이 같은 구역의 다른 편집과 동시에 일어날 때 생깁니다.
- 연결이 끊기면 화면에 안내가 뜹니다. 그동안의 편집은 다시 연결되면 보내집니다.
- 공동편집 중에는 모든 참여자가 같은 배치를 보도록 rhwp 내장 글꼴 규칙으로 배치합니다. 그래서 혼자 편집할
  때와 줄이나 쪽 나눔이 조금 다를 수 있습니다.

### 문서 저장

서버를 띄울 때 `COLLAB_DATA_DIR`을 지정하면 방마다 문서가 디스크에 저장됩니다.

```sh
COLLAB_DATA_DIR=./data node server/server.mjs
```

방 디렉터리의 `doc.hwp`(또는 `doc.hwpx`)가 최신 문서 파일이고, 편집이 몇 초 멈추거나 모두 나갈 때 갱신됩니다.
서버를 다시 시작하면 저장된 기록으로 방을 그대로 복원합니다.

## 서버 설정

환경 변수로 설정합니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `8787` | 서버 포트 |
| `HOST` | `127.0.0.1` | 서버가 받을 주소 |
| `COLLAB_DATA_DIR` | 없음 | 문서를 저장할 디렉터리. 없으면 메모리에만 두고 서버를 끄면 사라집니다 |
| `COLLAB_CANONICAL` | 켜짐 | 서버에서 편집을 먼저 검사합니다. `0`이면 끕니다. 저장을 쓰려면 켜 두어야 합니다 |
| `COLLAB_MAX_MESSAGE_BYTES` | 64MB | 주고받을 수 있는 최대 크기. 이보다 큰 문서로는 방을 열 수 없습니다 |
| `COLLAB_DOC_SAVE_IDLE_MS` | `5000` | 편집이 이 시간만큼 멈추면 문서 파일을 갱신합니다 |
| `COLLAB_GENERATION_IDLE_MS` | `600000` | 방이 이 시간만큼 비면 쌓인 기록을 문서 파일로 정리합니다 |

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
| `collab-client/` | 편집 기록 엔진과 rhwp-studio 플러그인 |
| `server/` | 공동편집 서버 |
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
적혀 있습니다.

### rhwp 버전 올리기

1. `upstream/rhwp`에 적용된 패치 변경을 되돌립니다. 패치 원본은 `patches/`에 있습니다.
2. `upstream.lock`의 `rev`를 새 커밋으로 바꾸고 `scripts/bootstrap.sh`를 실행합니다. 패치가 맞지 않으면
   `upstream/rhwp`에서 고친 뒤 `scripts/update-patch.sh`로 패치를 다시 만듭니다.
3. `scripts/build-wasm.sh`를 실행합니다. 함수별 결과 비교가 자동으로 돌아서 동기화 방식을 다시 정합니다.
4. 브라우저 간 시험 `collab-client/e2e/s31-cross-browser.mjs`를 다시 돌립니다.

참여자와 서버는 같은 버전으로 빌드되어 있어야 합니다. 버전이 다른 참여자는 방에 들어올 수 없습니다.

## 알려진 한계

- 공동편집 중에는 아직 되돌리기(Ctrl+Z)를 쓸 수 없습니다. 자기 편집만 되돌리는 기능을 만들고 있습니다.
- 파일을 골라 방을 여는 화면이 아직 없습니다.
- 접속 인증이 없어서, 방 이름을 아는 사람은 누구나 들어올 수 있습니다.
- 웹 브라우저에서만 동작합니다.
- Linux 브라우저에서는 시험하지 않았습니다.

## 문서

- [전체 구조와 1단계](docs/collab-design.md)
- [2단계: 모든 기능 동기화와 동시 편집](docs/collab-stage2.md)
- [3단계: 서버 검사, 저장, 재접속, 기기 간 시험](docs/collab-stage3.md)
- [4단계: 사용자별 되돌리기 (진행 중)](docs/collab-stage4.md)

## 라이선스

[MIT](LICENSE)로 배포합니다. 패치 파일에 들어 있는 rhwp 코드는 rhwp의 MIT 라이선스를 따릅니다
([NOTICE.md](NOTICE.md)).
