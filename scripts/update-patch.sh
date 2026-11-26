#!/usr/bin/env bash
# 업스트림 작업 트리의 변경(git diff)을 patches/rhwp/*.patch 로 다시 쓴다.
#
#   scripts/update-patch.sh
#       기존 패치 파일마다, 그 패치가 다루는 파일들의 현재 diff 로 다시 쓴다.
#       어느 패치에도 속하지 않은 변경이 있으면 목록을 보이고 실패한다.
#
#   scripts/update-patch.sh <패치 이름> <경로>...
#       위와 같고, 추가로 <경로>들을 그 패치에 넣는다(패치가 없으면 만든다).
#       예: scripts/update-patch.sh 0002-studio-collab-plugin.patch rhwp-studio/src/main.ts
#
# 빌드 산출물(rhwp-studio/public/rhwp.js 등 업스트림이 추적하는 파일)은 패치에 넣지 않는다.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
upstream="${root}/upstream/rhwp"
patch_dir="${root}/patches/rhwp"

# build-wasm.sh 가 덮어쓰는, 업스트림이 추적하는 산출물
ignored_paths=("rhwp-studio/public/rhwp.js" "rhwp-studio/public/rhwp_bg.wasm")

die() { echo "update-patch: $*" >&2; exit 1; }

[ -d "${upstream}/.git" ] || die "업스트림이 없습니다. scripts/bootstrap.sh 를 먼저 실행하세요"
mkdir -p "${patch_dir}"
cd "${upstream}"

is_ignored() {
  local p
  for p in "${ignored_paths[@]}"; do [ "$1" = "${p}" ] && return 0; done
  return 1
}

patch_paths() {
  # 패치가 다루는 파일 경로 (a/ 쪽)
  sed -n 's#^diff --git a/\(.*\) b/.*#\1#p' "$1"
}

target_patch=""
extra_paths=()
if [ $# -gt 0 ]; then
  target_patch="$1"; shift
  case "${target_patch}" in */*) die "패치 이름만 주세요 (patches/rhwp/ 아래에 만듭니다)";; esac
  case "${target_patch}" in *.patch) ;; *) die "패치 이름은 .patch 로 끝나야 합니다";; esac
  [ $# -gt 0 ] || die "<경로>를 하나 이상 주세요"
  extra_paths=("$@")
  [ -e "${patch_dir}/${target_patch}" ] || : > "${patch_dir}/${target_patch}"
fi

claimed="$(mktemp)"
trap 'rm -f "${claimed}"' EXIT

shopt -s nullglob
for patch in "${patch_dir}"/*.patch; do
  name="$(basename "${patch}")"
  paths=()
  while IFS= read -r p; do
    [ -n "${p}" ] && paths+=("${p}")
  done < <(
    patch_paths "${patch}"
    if [ "${name}" = "${target_patch}" ]; then printf '%s\n' "${extra_paths[@]}"; fi
  )
  [ "${#paths[@]}" -gt 0 ] || die "${name}: 다루는 파일이 없습니다"
  printf '%s\n' "${paths[@]}" >> "${claimed}"

  # 패치가 다루는 새 파일이 추적되지 않은 상태면 git diff 에 나오지 않아 패치에서 빠진다.
  # intent-to-add 로 표시해 diff 에 포함시킨다(내용은 stage 하지 않는다).
  for p in "${paths[@]}"; do
    if [ -e "${p}" ] && ! git ls-files --error-unmatch -- "${p}" >/dev/null 2>&1; then
      git add --intent-to-add -- "${p}"
    fi
  done

  new="$(git diff --no-color --no-ext-diff -- "${paths[@]}")"
  if [ -z "${new}" ]; then
    die "${name}: 현재 변경이 없습니다 (패치가 적용되지 않은 트리일 수 있습니다)"
  fi
  if [ "${new}" = "$(cat "${patch}")" ]; then
    echo "update-patch: 그대로: ${name}"
  else
    printf '%s\n' "${new}" > "${patch}"
    echo "update-patch: 갱신: ${name} ($(printf '%s\n' "${new}" | grep -c '^diff --git') 파일)"
  fi
done
shopt -u nullglob

unclaimed=()
while IFS= read -r p; do
  [ -n "${p}" ] || continue
  is_ignored "${p}" && continue
  grep -qxF "${p}" "${claimed}" || unclaimed+=("${p}")
done < <(git diff --name-only)

# 패치 해시가 엔진 지문에 들어가므로 분류표를 다시 만든다.
if command -v node >/dev/null 2>&1; then
  node "${root}/scripts/gen-catalog.mjs" >/dev/null || die "분류표 생성 실패"
fi

untracked="$(git ls-files --others --exclude-standard)"
if [ "${#unclaimed[@]}" -gt 0 ] || [ -n "${untracked}" ]; then
  echo "update-patch: 어느 패치에도 속하지 않은 변경이 있습니다:" >&2
  for p in ${unclaimed[@]+"${unclaimed[@]}"}; do echo "  M ${p}" >&2; done
  if [ -n "${untracked}" ]; then printf '  ? %s\n' ${untracked} >&2; fi
  echo "  패치에 넣으려면: scripts/update-patch.sh <패치 이름> <경로>..." >&2
  echo "  (새 파일은 git add -N <경로> 후 넣는다)" >&2
  exit 1
fi
