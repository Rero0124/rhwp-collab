#!/usr/bin/env bash
# 패치된 업스트림을 WASM(web 타깃)으로 빌드한다.
#
# 산출물: upstream/rhwp/pkg/{rhwp.js,rhwp_bg.wasm}  (studio vite 가 ../pkg/rhwp.js 를 읽는다)
#         업스트림 래퍼가 rhwp-studio/public/ 에도 같은 파일을 복사한다.
#
# wasm-pack 은 프로젝트 로컬(.tools/bin)의 것을 쓴다. 추가 인자는 wasm-pack build 로 넘어간다
# (예: --dev).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
upstream="${root}/upstream/rhwp"

[ -x "${root}/.tools/bin/wasm-pack" ] || {
  echo "build-wasm: ${root}/.tools/bin/wasm-pack 이 없습니다" >&2
  echo "  설치: cargo install wasm-pack --version 0.15.0 --locked --root .tools" >&2
  exit 1
}
[ -x "${upstream}/scripts/wasm-pack-locked.sh" ] || {
  echo "build-wasm: 업스트림이 없습니다. scripts/bootstrap.sh 를 먼저 실행하세요" >&2
  exit 1
}

export PATH="${root}/.tools/bin:${PATH}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${root}/target}"

cd "${upstream}"
scripts/wasm-pack-locked.sh --target web "$@"

for artifact in pkg/rhwp.js pkg/rhwp_bg.wasm; do
  shasum -a 256 "${artifact}"
done

# 엔진 지문(보정 코드 해시 포함)을 지금 소스에 맞춘다 — 빌드한 WASM 과 플러그인 지문이 어긋나지 않게.
node "${root}/scripts/gen-catalog.mjs" >/dev/null

# 기본 산출물(pkg/)이면 이 rev 의 빌드로 보관한다(R1b 동작 동일성 검사의 "이전 엔진").
# 다른 rev 의 보관 빌드가 있으면(업스트림을 올린 뒤 첫 빌드) 동작 동일성 검사를 돌려 분류표에 반영한다.
# 동작 동일성 검사는 Node 의 엔진만 본다 — 업스트림을 올리면 브라우저 간 시험(s31-cross-browser)도 다시 돌린다
# (Windows 기기가 있으면 포함, docs/collab-stage2.md §3 동작 동일성 검사).
case " $* " in
  *" --out-dir "*|*" --out-dir="*) ;;
  *)
    rev="$(sed -n 's/^rev=//p' "${root}/upstream.lock")"
    keep="${root}/.tools/engine-builds/${rev}"
    mkdir -p "${keep}"
    cp pkg/rhwp.js pkg/rhwp_bg.wasm "${keep}/"
    if ls -d "${root}/.tools/engine-builds/"*/ 2>/dev/null | grep -v "/${rev}/$" | grep -q .; then
      echo "build-wasm: 업스트림이 바뀌었습니다 — 동작 동일성 검사(scripts/check-behavior.mjs)를 돌립니다"
      node "${root}/scripts/check-behavior.mjs"
      echo "build-wasm: 브라우저 간 시험도 다시 돌리세요 — collab-client/e2e/s31-cross-browser.mjs (Windows 기기가 있으면 포함)"
    fi
    ;;
esac
