# rhwp-collab

[rhwp](https://github.com/edwardkim/rhwp) 기반 HWP/HWPX 실시간 공동편집.

rhwp는 포크하지 않는다. `upstream.lock`에 고정한 커밋을 받아 패치 두 개를 적용하고, 공동편집 코드는 이 저장소에
따로 둔다. 지금은 웹(rhwp-studio)만 된다.

아직 실험 단계다. 인증이 없으니 공개망에 띄우지 말 것.

## 동작 방식

편집은 rhwp WASM의 export 경계에서 기록한다. 기록 방식을 확인한 함수(지금 182개)는 호출 자체를 보내고, 나머지는
편집 후 문서 전체를 보낸다. rhwp를 올리면 함수마다 이전 버전과 결과를 비교해서, 달라진 함수는 문서 전송 쪽으로
자동으로 돌린다.

순서는 서버가 정한다. 내 편집이 확정되기 전에 다른 사람 편집이 오면 되감고 서버 순서대로 다시 적용한다(CRDT는
쓰지 않았다). 서버도 같은 rhwp WASM으로 문서를 들고 있다가 편집을 먼저 적용해 보고, 실패하면 거절한다.

공동편집 중에는 기기마다 배치가 달라지지 않게 rhwp 내장 글꼴 규칙만 쓴다. 그래서 혼자 편집할 때와 줄 나눔이
조금 다를 수 있다.

설계와 검증 기록은 `docs/`에 단계별로 있다.

## 시작하기

rustup, Node 23.6 이상, git이 필요하다. Rust 버전과 wasm32 타깃은 rhwp의 `rust-toolchain.toml`이 정한다.

```sh
scripts/bootstrap.sh
cargo install wasm-pack --version 0.15.0 --locked --root .tools
scripts/build-wasm.sh
(cd upstream/rhwp/rhwp-studio && npm ci)
(cd server && npm ci)
```

```sh
node server/server.mjs
(cd upstream/rhwp/rhwp-studio && npx vite)
```

브라우저 두 개에서 연다.

```
http://127.0.0.1:7700/?collab=ws://127.0.0.1:8787&room=demo&name=A
http://127.0.0.1:7700/?collab=ws://127.0.0.1:8787&room=demo&name=B
```

방에 처음 들어온 사람이 열어 둔 문서가 방 문서가 된다. 열린 문서가 없으면 빈 문서로 시작한다.

서버를 재시작해도 문서를 남기려면 `COLLAB_DATA_DIR=./data`를 준다. 다른 환경 변수는 `server/server.mjs`의
`startServer` 기본값을 보면 된다.

## 디렉터리

```
patches/rhwp/    rhwp 패치 (엔진 훅, studio 플러그인 API)
collab-core/     rhwp와 같이 빌드되는 Rust 코드
collab-client/   편집 기록 엔진, studio 플러그인, 시험
server/          중계 서버
scripts/         받기, 빌드, 분류표 생성, 동작 비교
docs/            설계와 검증 기록
```

## 테스트

```sh
(cd collab-client && npm test)
(cd server && npm test)
(cd upstream/rhwp && CARGO_TARGET_DIR=../../target cargo test -p rhwp --lib --locked collab::)
node collab-client/test/sim.mjs --seeds 500 --ops 200 --clients 3
```

브라우저 시험은 `collab-client/e2e/`에 있고 Chrome이 필요하다. 파일 첫머리에 실행법을 적어 뒀다.

## rhwp 버전 올리기

`upstream/rhwp`에 적용된 패치 변경을 되돌리고, `upstream.lock`의 `rev`를 바꾼 뒤 `scripts/bootstrap.sh`와
`scripts/build-wasm.sh`를 돌린다. 빌드 스크립트가 동작 비교를 돌려서 분류표를 고친다. 패치가 안 맞으면
`upstream/rhwp`에서 고치고 `scripts/update-patch.sh`로 패치를 다시 만든다. 끝나면
`collab-client/e2e/s31-cross-browser.mjs`도 다시 돌린다.

## 한계

- 공동편집 중에는 되돌리기가 꺼져 있다. 작업 중이다(`docs/collab-stage4.md`).
- 표 만들기나 붙여넣기처럼 구조를 바꾸는 편집이 같은 구역의 동시 편집과 겹치면 늦게 온 쪽이 취소된다.
- 파일을 골라 방을 여는 화면이 없다.
- 인증이 없다.
- Linux 브라우저에서는 시험하지 않았다.

## 라이선스

MIT. 패치에 들어 있는 rhwp 코드는 rhwp의 MIT 라이선스를 따른다([NOTICE.md](NOTICE.md)).
