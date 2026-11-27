#!/usr/bin/env bash
# 편집기(rhwp-studio + 공동편집 플러그인)를 정적 파일로 빌드한다 (docs/collab-stage5.md D2).
#
# 산출물: target/studio (STUDIO_OUT_DIR 로 바꿀 수 있다). 서버에 COLLAB_STATIC_DIR 로 주면 서버가 같은 출처로
# 내준다 — https://호스트/ 가 편집기, wss://호스트/ 가 공동편집 서버.
# 플러그인은 vite alias(0002 패치)로 collab-client/src/plugin.ts 를 묶는다. dev 서버(npx vite)는 개발용으로 그대로 둔다.
# rhwp-studio 의 빌드 옵션 환경 변수(RHWP_WITHOUT_AI, RHWP_WITHOUT_HWPCTRL, RHWP_DISABLE_EXTERNAL_WEBFONTS)는 그대로
# 넘어간다.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
studio="${root}/upstream/rhwp/rhwp-studio"
out="${STUDIO_OUT_DIR:-${root}/target/studio}"

die() { echo "build-studio: $*" >&2; exit 1; }

[ -d "${studio}" ] || die "업스트림이 없습니다. scripts/bootstrap.sh 를 먼저 실행하세요"
[ -f "${root}/upstream/rhwp/pkg/rhwp_bg.wasm" ] || die "WASM 빌드가 없습니다. scripts/build-wasm.sh 를 먼저 실행하세요"
[ -x "${studio}/node_modules/.bin/vite" ] || die "studio 의존성이 없습니다. (cd upstream/rhwp/rhwp-studio && npm ci)"

cd "${studio}"
# 타입 검사(플러그인 포함 — tsconfig paths 가 collab-client 를 가리킨다)
node_modules/.bin/tsc --noEmit -p .
node_modules/.bin/vite build --outDir "${out}" --emptyOutDir

[ -f "${out}/index.html" ] || die "산출물에 index.html 이 없습니다: ${out}"

# 서비스 워커(업스트림 PWA)는 공동편집 배포에서 쓰지 않는다:
#  - 모든 탐색을 index.html 로 돌려(NavigationRoute) 같은 출처의 /upload 페이지를 가린다
#  - 편집은 서버가 있어야 하므로 오프라인 설치의 이점이 없다
# 워커 파일을 빼고, 등록 스크립트는 예전에 설치된 워커를 걷어 내는 것으로 바꾼다(index.html 은 그대로).
rm -f "${out}/sw.js" "${out}"/workbox-*.js
cat > "${out}/registerSW.js" <<'EOF'
// cc-rhwp(scripts/build-studio.sh): 공동편집 배포에서는 서비스 워커를 쓰지 않는다. 예전에 설치된 것이 있으면 걷어 낸다.
if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
EOF

echo "build-studio: ${out}"
echo "  서버: COLLAB_STATIC_DIR=${out} node server/server.mjs"
