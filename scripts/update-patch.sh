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
#
# bootstrap.sh 의 적용 기록(upstream/rhwp/.git/cc-applied: series + 패치 사본)도 맞춘다. 여기서 쓴 패치는 트리에서 뽑은
# 것이라 트리는 이미 그 패치를 적용한 상태다. 기록 사본이 옛 판으로 남으면, 그 뒤 다른 패치가 바뀐 커밋을 받았을 때
# bootstrap 이 트리("옛 0001 + 새 0002")를 알아보지 못하고 멈춘다.
#
# 처음에 적용 기록이 지금 patches/ 와 같은지(이름·순서·내용) 본다. 다르면 patches/ 가 트리보다 새롭다(새 커밋을 받고
# bootstrap 을 아직 안 함). 그 트리에서 패치를 뽑으면 새 패치를 옛 판으로 조용히 덮어쓰므로, 아무것도 쓰지 않고 멈춘다.
# 기록이 없는 체크아웃(이 기능 전)은 확인할 수 없어 경고만 하고 진행한다.
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
fi

# ── 트리가 지금 patches/ 의 판인가(bootstrap 의 적용 기록으로 본다) ──
record_dir="$(cd "$(git rev-parse --git-dir)" && pwd)/cc-applied"
if [ -f "${record_dir}/series" ]; then
  shopt -s nullglob
  current=()
  for f in "${patch_dir}"/*.patch; do current+=("$(basename "${f}")"); done
  shopt -u nullglob
  recorded=()
  while IFS= read -r n; do [ -n "${n}" ] && recorded+=("${n}"); done < "${record_dir}/series"
  stale=()
  if [ "${current[*]-}" != "${recorded[*]-}" ]; then
    stale+=("적용 순서: 기록 [${recorded[*]-}] / patches/ [${current[*]-}]")
  fi
  for n in ${current[@]+"${current[@]}"}; do
    cmp -s "${patch_dir}/${n}" "${record_dir}/${n}" 2>/dev/null || stale+=("${n}")
  done
  if [ "${#stale[@]}" -gt 0 ]; then
    printf '  %s\n' "${stale[@]}" >&2
    die "patches/ 가 트리보다 새롭습니다(위 패치가 upstream/rhwp 에 적용된 판과 다름 — 새 커밋을 받고 bootstrap 을 하지 않은 듯합니다). 먼저 scripts/bootstrap.sh 를 실행하세요. 아무것도 쓰지 않았습니다"
  fi
else
  echo "update-patch: 경고: 적용 기록(upstream/rhwp/.git/cc-applied)이 없어 트리가 지금 patches/ 의 판인지 확인하지 못했습니다(scripts/bootstrap.sh 를 한 번 실행하면 생깁니다)" >&2
fi
# 새 패치 파일은 확인을 지난 뒤에 만든다
if [ -n "${target_patch}" ]; then
  [ -e "${patch_dir}/${target_patch}" ] || : > "${patch_dir}/${target_patch}"
fi

claimed="$(mktemp)"
trap 'rm -f "${claimed}"' EXIT

# bootstrap 의 적용 기록 — 패치 사본을 트리에 적용된 판(= 방금 쓴 패치)으로
synced=()
sync_record() {
  local name
  name="$(basename "$1")"
  mkdir -p "${record_dir}"
  if ! cmp -s "$1" "${record_dir}/${name}" 2>/dev/null; then
    cp "$1" "${record_dir}/${name}.tmp"
    mv "${record_dir}/${name}.tmp" "${record_dir}/${name}"
  fi
  synced+=("${name}")
}

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
  # 그대로여도 맞춘다 — 이 수정 전에 남은 옛 사본도 고쳐진다
  sync_record "${patch}"
done
shopt -u nullglob
# 적용 순서 = patches/ 의 이름 순서(bootstrap 과 같다). 모든 패치를 트리에서 뽑았으니 트리에는 이 패치들이 적용돼 있다.
if [ "${#synced[@]}" -gt 0 ]; then
  printf '%s\n' "${synced[@]}" > "${record_dir}/series.tmp"
  mv "${record_dir}/series.tmp" "${record_dir}/series"
fi

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
