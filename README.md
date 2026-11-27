# rhwp-collab

[rhwp](https://github.com/edwardkim/rhwp)(Rust + WebAssembly로 만든 HWP/HWPX 문서 엔진) 위에 얹는 **실시간 공동편집**입니다.
여러 사람이 브라우저의 rhwp-studio에서 같은 한글 문서를 동시에 편집합니다.

rhwp 저장소를 포크해서 고치지 않습니다. 고정한 rhwp 버전에 작은 패치 두 개를 적용하고, 공동편집 기능은 이
저장소의 바깥 모듈(편집 기록 엔진, 중계 서버, studio 플러그인)에 둡니다.

## 무엇이 되나

- **모든 편집 기능 동기화:** rhwp가 내보내는 편집 함수 314개를 분류했습니다.
  - 동작으로 보내는 기능은 182개입니다. "3번째 문단 10번째 글자에 '가' 입력"처럼 작게 보내서 빠릅니다.
  - 그 밖의 기능은 결과로 보냅니다. 편집 뒤의 문서 전체를 보내므로 느리지만 동기화는 됩니다.
  - 편집을 바꾸지 않는 함수 69개는 보내지 않습니다.
- **동시 편집:** 서버가 편집 순서를 정합니다. 내 편집이 아직 확정되지 않았을 때 남의 편집이 오면, 되감고
  서버 순서대로 다시 적용하면서 위치를 보정합니다. 그래서 같은 문단에서 동시에 쳐도 각자 글자가 이어집니다.
  CRDT는 쓰지 않습니다.
- **rhwp 업데이트에 강함:** rhwp를 올리면 기능마다 이전 버전과 동작이 같은지 자동으로 검사합니다. 같으면
  계속 동작으로 보내고, 달라졌거나 새로 생긴 기능은 결과로 보냅니다. 업데이트 뒤에도 기존 기능은 빠르고, 새
  기능도 느리지만 동기화됩니다.
- **서버 검사:** 서버가 rhwp로 원본 문서를 들고, 편집을 기록하기 전에 먼저 적용해 봅니다. 잘못된 편집은
  거절하고, rhwp가 멈추는 편집이 와도 서버는 계속 돕니다.
- **저장:** 편집은 들어오는 즉시 디스크에 기록합니다. 서버가 강제로 꺼져도 잃지 않습니다. 사용자가 받을
  문서 파일(HWP/HWPX)은 잠잠할 때 갱신합니다.
- **재접속:** 연결이 끊겨도 계속 편집할 수 있고, 다시 붙으면 밀린 편집을 주고받습니다.
- **기기 간 같은 결과:** Chrome·Firefox·Safari 엔진(WebKit), macOS·Windows, 서버(Node)가 같은 문서를
  만듭니다. 공동편집 중에는 rhwp 내장 글꼴 규칙으로 배치하기 때문입니다.
- **다른 사람 커서 표시**

## 구조

```
브라우저 (rhwp-studio)                                   서버 (Node)
┌──────────────────────────────────────┐   WebSocket   ┌──────────────────────────────┐
│ studio 화면                           │ ◀───────────▶ │ server/server.mjs            │
│   └ 공동편집 플러그인 (collab-client) │               │   순서 정하기·중계·재접속    │
│       └ 편집 기록 엔진                │               │   정본 문서 (rhwp WASM)      │
│ rhwp WASM (+ patches, collab-core)   │               │   저장 (기준 파일 + 기록)    │
└──────────────────────────────────────┘               └──────────────────────────────┘
```

| 경로 | 내용 |
|---|---|
| `upstream.lock` | 쓰는 rhwp 저장소와 커밋 |
| `patches/rhwp/` | rhwp에 적용하는 패치 두 개: 엔진 훅(0001), studio 플러그인 API(0002) |
| `collab-core/` | rhwp 안에 함께 빌드되는 Rust 보조 코드: 스냅샷, 결과 적재·내보내기, 위치 보정, 문서 지문(digest) |
| `collab-client/` | 편집 기록 엔진과 studio 플러그인(TypeScript), 기능 분류표, 시험 |
| `server/` | 중계 서버, 정본 검증 워커, 저장소 |
| `scripts/` | rhwp 받기·패치·빌드, 분류표 생성, 동작 동일성 검사 |
| `docs/` | 단계별 설계와 검증 기록 |

## 준비물

- Rust: rhwp의 `rust-toolchain.toml`이 1.93.1과 wasm32 타깃을 고정하므로, rustup만 있으면 됩니다.
- wasm-pack 0.15.0: 아래 설치 단계에서 프로젝트 안(`.tools/`)에 설치합니다.
- Node 23.6 이상: `collab-client`가 TypeScript를 그대로 실행합니다.
- git

## 설치

```sh
scripts/bootstrap.sh                                           # rhwp를 upstream/rhwp에 받고 패치 적용
cargo install wasm-pack --version 0.15.0 --locked --root .tools
scripts/build-wasm.sh                                          # WASM 빌드 → upstream/rhwp/pkg/
(cd upstream/rhwp/rhwp-studio && npm ci)
(cd server && npm ci)
```

`bootstrap.sh`는 rhwp 저장소 전체(4GB 이상) 대신 필요한 경로만 받습니다(약 430MB). 여러 번 실행해도 안전합니다.

## 실행

```sh
node server/server.mjs                           # ws://127.0.0.1:8787
(cd upstream/rhwp/rhwp-studio && npx vite)       # http://127.0.0.1:7700
```

브라우저 두 개(또는 탭 두 개)에서 이름만 다르게 엽니다.

```
http://127.0.0.1:7700/?collab=ws://127.0.0.1:8787&room=demo&name=A
http://127.0.0.1:7700/?collab=ws://127.0.0.1:8787&room=demo&name=B
```

- `room`: 방 이름. 같은 방에 들어온 사람끼리 같은 문서를 편집합니다.
- `name`: 다른 사람 화면에 보이는 커서 이름.
- 방에 처음 들어온 사람이 그때 열려 있는 문서를 방의 문서로 올립니다. 열린 문서가 없으면 빈 문서로 시작합니다.

### 서버 설정 (환경 변수)

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `PORT`, `HOST` | `8787`, `127.0.0.1` | 서버 주소 |
| `COLLAB_DATA_DIR` | 없음 | 저장할 디렉터리. 없으면 메모리에만 둡니다(서버를 끄면 사라짐) |
| `COLLAB_CANONICAL` | 켬 | `0`이면 서버 검사(정본)를 끕니다. 저장을 쓰려면 켜져 있어야 합니다 |
| `COLLAB_MAX_MESSAGE_BYTES` | 64MB | 한 메시지 상한. 이보다 큰 문서는 공동편집을 시작할 수 없습니다 |
| `COLLAB_DOC_SAVE_IDLE_MS` | `5000` | 편집이 이만큼 멈추면 문서 파일을 갱신합니다 |
| `COLLAB_GENERATION_IDLE_MS` | `600000` | 방이 이만큼 비면 기록을 문서 파일로 정리합니다 |
| `COLLAB_DELAY_MS` | `0` | 시험용 인위 지연 |

`COLLAB_DATA_DIR`을 주면 방마다 `base.<hwp|hwpx>`(출발점), `log.jsonl`(편집 기록), `doc.<hwp|hwpx>`(최신 문서
파일)를 씁니다. 사용자가 내려받을 파일은 `doc.*`입니다.

## 시험

```sh
# Rust (collab-core)
(cd upstream/rhwp && CARGO_TARGET_DIR=../../target cargo test -p rhwp --lib --locked collab::)

# 엔진·서버
(cd collab-client && npm test)
(cd server && npm test)

# 무작위 동시 편집 모의 시험 (3명, 시드 500 × 편집 200)
node collab-client/test/sim.mjs --seeds 500 --ops 200 --clients 3
node collab-client/test/sim.mjs --seeds 100 --ops 200 --clients 3 --s3        # 끊김·서버 재시작·세대 전환 포함
node collab-client/test/sim.mjs --seeds 100 --ops 300 --clients 3 --realistic # 사람 속도, 왕복 100ms
```

브라우저 시험은 `collab-client/e2e/*.mjs`에 있습니다. 파일마다 첫머리에 준비할 것과 실행 방법이 적혀 있습니다.
Chrome이 필요하고(`CHROME_PATH`), 브라우저 간 시험(`s31-*`)은 Playwright를 씁니다.

## rhwp 버전 올리기

1. `upstream/rhwp`에 적용된 패치 변경을 먼저 되돌립니다. 작업 트리가 깨끗해야 `bootstrap.sh`가 버전을
   바꿉니다(패치 원본은 `patches/`에 있으니 잃지 않습니다).
2. `upstream.lock`의 `rev`를 바꾸고 `scripts/bootstrap.sh`를 실행합니다. 패치가 안 맞으면 `upstream/rhwp`에서
   고친 뒤 `scripts/update-patch.sh`로 패치 파일을 다시 만듭니다.
3. `scripts/build-wasm.sh`를 실행합니다. 이전 버전 빌드가 남아 있으면 기능별 동작 동일성 검사가 자동으로 돌고,
   동작이 바뀐 기능은 결과 전송으로 분류됩니다.
4. 브라우저 간 시험(`collab-client/e2e/s31-cross-browser.mjs`)을 다시 돌립니다. 가능하면 Windows 기기도 넣습니다.

참여자 모두 같은 엔진 버전이어야 합니다. 버전이 다른 클라이언트는 서버가 방에 들이지 않습니다.

## 알려진 한계

- **되돌리기:** 공동편집 중에는 아직 꺼져 있습니다. "내 편집만, 다른 사람이 같은 자리를 고치지 않았을 때만"
  되돌리는 방식을 만들고 있습니다(`docs/collab-stage4.md`).
- **구조 편집과 겹칠 때:** 표 만들기·붙여넣기 같은 편집이 같은 구역의 동시 편집과 겹치면, 늦게 도착한 쪽의
  편집이 취소되고 알림이 뜹니다. 사람 속도 모의 시험에서 이렇게 잃는 편집은 0.01%였습니다.
- **배치:** 공동편집 중에는 rhwp 내장 글꼴 규칙으로 배치합니다. 그래서 혼자 편집할 때와 줄·쪽 나눔이 조금 다를
  수 있습니다. 샘플 21개 기준으로 한컴 배치와 맞는 비율은 비슷하거나 조금 더 높았습니다. 글자 모양과 굵기는
  기기에 설치된 글꼴에 따라 다를 수 있지만, 위치는 같습니다.
- **방 열기:** 파일을 골라 방을 여는 화면은 아직 없습니다. 첫 참여자가 그때 열어 둔 문서를 씁니다.
- **인증 없음:** 방 이름을 아는 사람은 누구나 들어올 수 있습니다. 로컬이나 내부 시험용으로만 쓰고, 공개망에
  그대로 열지 마세요.
- **웹만:** rhwp-studio(브라우저)에서만 동작합니다. 네이티브 앱 경로는 없습니다.
- **Linux:** Linux 브라우저에서는 아직 시험하지 않았습니다.

## 문서

- [docs/collab-design.md](docs/collab-design.md): 1단계(결정성 검증)와 전체 구조
- [docs/collab-stage2.md](docs/collab-stage2.md): 2단계(모든 기능 동기화, 동시 편집, 동작 동일성 검사)
- [docs/collab-stage3.md](docs/collab-stage3.md): 3단계(글꼴 고정, 서버 검사, 저장, 재접속, 기기 간 시험)
- [docs/collab-stage4.md](docs/collab-stage4.md): 4단계(사용자별 되돌리기, 진행 중)

## 라이선스

[MIT](LICENSE). 패치 파일에 들어 있는 rhwp 코드는 rhwp의 MIT 라이선스를 따릅니다([NOTICE.md](NOTICE.md)).
