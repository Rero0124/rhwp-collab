#!/usr/bin/env bash
# 업스트림 rhwp 를 upstream.lock 대로 받아 패치를 적용한다.
#
#   1. upstream/rhwp 가 없으면 부분·희소·얕은 클론 (--filter=blob:none --sparse --depth 1)
#   2. upstream.lock 의 sparse 경로가 빠져 있으면 추가 (기존 경로는 건드리지 않는다)
#   3. HEAD 가 lock 의 rev 가 아니면 checkout. 작업 트리가 더러우면 checkout 하지 않고 멈춘다
#   4. patches/rhwp/*.patch 를 순서대로 적용. 이미 적용된 패치는 건너뛴다
#
# 여러 번 실행해도 안전하다.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
lock="${root}/upstream.lock"
dest="${root}/upstream/rhwp"
patch_dir="${root}/patches/rhwp"

die() { echo "bootstrap: $*" >&2; exit 1; }
log() { echo "bootstrap: $*"; }

lock_value() {
  # key=value 한 줄을 읽는다. 주석·빈 줄은 무시한다.
  local key="$1" value
  value="$(sed -n "s/^${key}=//p" "${lock}" | tail -n 1)"
  [ -n "${value}" ] || die "upstream.lock 에 ${key}= 가 없습니다"
  printf '%s' "${value}"
}

[ -f "${lock}" ] || die "upstream.lock 이 없습니다: ${lock}"
repo="$(lock_value repo)"
rev="$(lock_value rev)"
sparse="$(lock_value sparse)"
# shellcheck disable=SC2206 # 공백 구분 목록을 의도적으로 나눈다
sparse_paths=(${sparse})

# ── 1. 클론 ────────────────────────────────────────────────────────────
if [ ! -d "${dest}/.git" ]; then
  [ ! -e "${dest}" ] || die "${dest} 가 있지만 git 저장소가 아닙니다. 확인 후 지우고 다시 실행하세요"
  log "클론: ${repo} → upstream/rhwp"
  mkdir -p "$(dirname "${dest}")"
  # --sparse 클론은 최상위 파일만 checkout 한다. --no-checkout 을 쓰면 HEAD 가 이미 rev 일 때
  # 아래 3단계가 checkout 을 건너뛰어 인덱스가 빈 채로 남으므로 쓰지 않는다.
  git clone --filter=blob:none --sparse --depth 1 "${repo}" "${dest}"
  git -C "${dest}" sparse-checkout set --cone "${sparse_paths[@]}"
fi

cd "${dest}"

# ── 2. 희소 경로 ───────────────────────────────────────────────────────
current_sparse="$(git sparse-checkout list 2>/dev/null || true)"
missing=()
for path in "${sparse_paths[@]}"; do
  if ! printf '%s\n' "${current_sparse}" | grep -qxF "${path}"; then
    missing+=("${path}")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  log "희소 경로 추가: ${missing[*]}"
  git sparse-checkout add "${missing[@]}"
fi

# ── 3. checkout ───────────────────────────────────────────────────────
head="$(git rev-parse --verify --quiet HEAD || true)"
if [ "${head}" != "${rev}" ]; then
  if [ -n "${head}" ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    git status --short --untracked-files=no >&2
    die "작업 트리가 더러워 ${rev} 로 checkout 하지 않습니다. 변경을 정리하고(필요하면 scripts/update-patch.sh 로 패치에 반영) 다시 실행하세요"
  fi
  if ! git cat-file -e "${rev}^{commit}" 2>/dev/null; then
    log "fetch: ${rev}"
    git fetch --filter=blob:none --depth 1 origin "${rev}"
  fi
  log "checkout: ${rev}"
  git checkout --quiet --detach "${rev}"
else
  log "HEAD 가 이미 ${rev}"
fi

# ── 4. 패치 ────────────────────────────────────────────────────────────
shopt -s nullglob
patches=("${patch_dir}"/*.patch)
shopt -u nullglob
for patch in ${patches[@]+"${patches[@]}"}; do
  name="$(basename "${patch}")"
  if git apply --reverse --check "${patch}" 2>/dev/null; then
    log "이미 적용됨: ${name}"
  elif git apply --check "${patch}" 2>/dev/null; then
    # 패치가 만드는 새 파일은 intent-to-add 로 표시한다. 그래야 git diff 에 나타나
    # update-patch.sh 가 패치를 다시 쓸 때 빠뜨리지 않는다.
    git apply --intent-to-add "${patch}"
    log "적용: ${name}"
  else
    git apply --check "${patch}" || true
    die "패치를 적용할 수 없습니다: ${name} (작업 트리가 패치와 다르게 바뀌었거나 rev 가 맞지 않습니다)"
  fi
done

# ── 5. collab 분류표 ───────────────────────────────────────────────────
# 업스트림 변경 메서드 목록으로 분류표·엔진 지문을 다시 만든다. 새 기능은 멈추지 않고 경고만 한다
# (결과 전송으로 동기화된다, docs/collab-stage2.md §3).
if command -v node >/dev/null 2>&1; then
  node "${root}/scripts/gen-catalog.mjs" || die "분류표 생성 실패"
else
  log "경고: node 가 없어 분류표를 다시 만들지 않았습니다 (scripts/gen-catalog.mjs)"
fi

log "완료 (upstream/rhwp @ ${rev:0:12})"
