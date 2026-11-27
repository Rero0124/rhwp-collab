#!/usr/bin/env bash
# 업스트림 rhwp 를 upstream.lock 대로 받아 패치를 적용한다.
#
#   1. upstream/rhwp 가 없으면 부분·희소·얕은 클론 (--filter=blob:none --sparse --depth 1)
#   2. upstream.lock 의 sparse 경로가 빠져 있으면 추가 (기존 경로는 건드리지 않는다)
#   3. HEAD 가 lock 의 rev 가 아니면 checkout. 적용해 둔 패치는 먼저 역적용한다. 패치가 아닌 변경이 있으면 멈춘다
#   4. patches/rhwp/*.patch 를 순서대로 적용. 이미 적용된 패치는 건너뛴다. 패치가 바뀌었으면(내용·이름·개수)
#      적용해 둔 옛 패치를 역순으로 역적용한 뒤 새 패치를 적용한다
#
# 적용한 패치의 사본을 업스트림 git 디렉터리 안(.git/cc-applied/: series = 적용 순서 + 패치 사본)에 남긴다. 그래서
# 패치가 바뀐 커밋을 받아도 사람이 upstream 을 되돌릴 필요가 없다. 패치 원본은 저장소(patches/)에 있으므로 잃는 것이 없다.
#
# 사람이 고친 변경은 덮어쓰지 않는다. 패치가 바뀌었을 때, 패치가 다루는 파일들이 "옛 패치를 적용한 상태"도 "새 패치를
# 적용한 상태"도 "원래 상태"도 아니면 아무것도 바꾸지 않고 멈춘다. 패치가 다루지 않는 파일의 변경은 그대로 둔다
# (rev 를 바꿀 때는 checkout 을 위해 그것도 없어야 한다). 빌드 산출물(build-wasm.sh 가 덮어쓰는, 업스트림이 추적하는
# 파일)은 사람이 고친 변경으로 보지 않는다.
#
# 여러 번 실행해도 결과가 같다.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
lock="${root}/upstream.lock"
dest="${root}/upstream/rhwp"
patch_dir="${root}/patches/rhwp"
# build-wasm.sh 가 덮어쓰는, 업스트림이 추적하는 산출물(scripts/update-patch.sh 의 ignored_paths 와 같다)
build_outputs=("rhwp-studio/public/rhwp.js" "rhwp-studio/public/rhwp_bg.wasm")

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

# ── 패치 기록 (.git/cc-applied) ─────────────────────────────────────────
record_dir="$(cd "$(git rev-parse --git-dir)" && pwd)/cc-applied"
mkdir -p "${record_dir}"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

# 기록된 패치 이름(적용 순서)
had_record="$([ -s "${record_dir}/series" ] && echo 1 || echo 0)"
recorded=()
if [ -f "${record_dir}/series" ]; then
  while IFS= read -r name; do
    [ -n "${name}" ] && [ -f "${record_dir}/${name}" ] && recorded+=("${name}")
  done < "${record_dir}/series"
fi
# 원하는 패치(patches/ 의 이름 순서)
shopt -s nullglob
desired_files=("${patch_dir}"/*.patch)
shopt -u nullglob
desired=()
for f in ${desired_files[@]+"${desired_files[@]}"}; do desired+=("$(basename "${f}")"); done

write_series() {
  if [ "$#" -gt 0 ]; then printf '%s\n' "$@" > "${record_dir}/series.tmp"; else : > "${record_dir}/series.tmp"; fi
  mv "${record_dir}/series.tmp" "${record_dir}/series"
}
# 기록 = 지금 적용된 패치 열. 사본은 기록에서 빠져도 이번 실행이 끝날 때까지 남겨 둔다(되돌릴 때 쓴다).
record_push() { cp "$1" "${record_dir}/$(basename "$1").tmp"; mv "${record_dir}/$(basename "$1").tmp" "${record_dir}/$(basename "$1")"; recorded+=("$(basename "$1")"); write_series "${recorded[@]}"; }
record_pop() { unset 'recorded[${#recorded[@]}-1]'; write_series ${recorded[@]+"${recorded[@]}"}; }
prune_copies() {
  local f keep n
  for f in "${record_dir}"/*.patch; do
    [ -e "${f}" ] || continue
    keep=0
    for n in ${recorded[@]+"${recorded[@]}"}; do [ "$(basename "${f}")" = "${n}" ] && keep=1; done
    [ "${keep}" = 1 ] || rm -f "${f}"
  done
}

is_build_output() { local p; for p in "${build_outputs[@]}"; do [ "$1" = "${p}" ] && return 0; done; return 1; }

# 패치가 다루는 파일 경로(a/·b/ 양쪽, /dev/null 제외)
patch_paths() { { sed -n 's#^diff --git a/\(.*\) b/.*$#\1#p' "$1"; sed -n 's#^diff --git a/.* b/\(.*\)$#\1#p' "$1"; } | grep -vx '/dev/null' | sort -u; }
# 패치가 새로 만드는 파일
created_paths() { git apply --summary "$1" | sed -n 's/^ create mode [0-7]* //p'; }

apply_one() {
  # 패치가 만드는 새 파일은 intent-to-add 로 표시한다. 그래야 git diff 에 나타나 update-patch.sh 가 패치를 다시 쓸 때
  # 빠뜨리지 않는다.
  git apply --intent-to-add "$1"
}
reverse_one() {
  git apply --reverse "$1"
  # 지운 새 파일의 intent-to-add 표시도 거둔다
  local p
  while IFS= read -r p; do
    [ -n "${p}" ] && git rm --cached --quiet --ignore-unmatch -- "${p}" >/dev/null
  done < <(created_paths "$1")
}

# 패치 열이 다루는 경로들에 대해, 트리 상태를 git 트리 하나로 만든다(임시 인덱스 — 실제 인덱스는 건드리지 않는다).
#   tree_with <경로 목록 파일> <패치 파일...>   HEAD 에 패치를 차례로 적용한 상태
#   tree_now  <경로 목록 파일>                  HEAD 위에 그 경로들의 지금 작업 트리 내용
# 부분 클론이라 희소 경로 밖의 blob 은 없다. write-tree 는 --missing-ok 로 쓰고(없으면 모든 blob 을 확인하려고
# 수백 MB 를 받는다), 그래도 받아야 하는 일이 생기면 받지 않고 실패하도록 GIT_NO_LAZY_FETCH 를 둔다.
tree_with() {
  shift
  local idx="${tmp}/idx.$$.$RANDOM" p
  GIT_NO_LAZY_FETCH=1 GIT_INDEX_FILE="${idx}" git read-tree HEAD
  for p in "$@"; do GIT_NO_LAZY_FETCH=1 GIT_INDEX_FILE="${idx}" git apply --cached "${p}" 2>/dev/null || { rm -f "${idx}"; return 1; }; done
  GIT_NO_LAZY_FETCH=1 GIT_INDEX_FILE="${idx}" git write-tree --missing-ok
  rm -f "${idx}"
}
tree_now() {
  local idx="${tmp}/idx.$$.$RANDOM"
  GIT_NO_LAZY_FETCH=1 GIT_INDEX_FILE="${idx}" git read-tree HEAD
  GIT_INDEX_FILE="${idx}" GIT_NO_LAZY_FETCH=1 xargs git update-index --add --remove -- < "$1"
  GIT_NO_LAZY_FETCH=1 GIT_INDEX_FILE="${idx}" git write-tree --missing-ok
  rm -f "${idx}"
}
# 두 트리가 경로 목록 파일의 경로들에서 같은가(목록이 비면 같지 않은 것으로 — 경로 없이 비교하면 트리 전체가 된다)
same_on() {
  [ "$2" != none ] && [ "$3" != none ] && [ -s "$1" ] || return 1
  GIT_NO_LAZY_FETCH=1 xargs git diff-tree --quiet -r "$2" "$3" -- < "$1"
}

# 기록된 패치를 끝에서부터 keep 개만 남기고 역적용한다. 하나라도 깨끗하지 않으면 이번에 역적용한 것을 다시 적용해
# 처음 상태로 두고 멈춘다.
reverse_recorded_to() {
  local keep="$1" undone=() name i
  while [ "${#recorded[@]}" -gt "${keep}" ]; do
    name="${recorded[${#recorded[@]}-1]}"
    if git apply --reverse --check "${record_dir}/${name}" 2>"${tmp}/err"; then
      reverse_one "${record_dir}/${name}"
      record_pop
      undone+=("${name}")
      log "역적용: ${name} (적용해 둔 사본)"
    else
      cat "${tmp}/err" >&2
      for ((i = ${#undone[@]} - 1; i >= 0; i -= 1)); do
        apply_one "${record_dir}/${undone[i]}"
        recorded+=("${undone[i]}")
      done
      write_series ${recorded[@]+"${recorded[@]}"}
      die "적용해 둔 ${name} 을 역적용할 수 없습니다(upstream/rhwp 에 패치가 아닌 변경이 섞여 있습니다). 아무것도 바꾸지 않았습니다"
    fi
  done
}

# 기록이 없는 체크아웃(이 기능 전에 받은 것)에서 i 번째 패치가 맞지 않을 때: 저장소 기록(git log)에서 그 패치의 옛 판 중
# 패치가 다루는 파일이 정확히 "그 판을 적용한 상태"인 것을 찾아 역적용한다. 찾지 못하면(저장소가 아니거나, 사람이 고친
# 변경이 섞임) 아무것도 바꾸지 않는다.
reverse_from_history() {
  local i="$1" name="${desired[$1]}" rel c j prefix=()
  git -C "${root}" rev-parse --git-dir >/dev/null 2>&1 || return 1
  rel="${patch_dir#"${root}/"}/${name}"
  for ((j = 0; j < i; j += 1)); do prefix+=("${patch_dir}/${desired[j]}"); done
  for c in $(git -C "${root}" log --format=%H -n 100 -- "${rel}" 2>/dev/null); do
    git -C "${root}" show "${c}:${rel}" > "${tmp}/old.patch" 2>/dev/null || continue
    cmp -s "${tmp}/old.patch" "${patch_dir}/${name}" && continue
    { patch_paths "${tmp}/old.patch"; patch_paths "${patch_dir}/${name}"; } | sort -u > "${tmp}/paths"
    if same_on "${tmp}/paths" "$(tree_now "${tmp}/paths")" "$(tree_with "${tmp}/paths" ${prefix[@]+"${prefix[@]}"} "${tmp}/old.patch" || echo none)" \
      && git apply --reverse --check "${tmp}/old.patch" 2>/dev/null; then
      reverse_one "${tmp}/old.patch"
      log "역적용: ${name} (패치 기록이 없어 저장소 기록에서 찾은 옛 판 ${c:0:12})"
      return 0
    fi
  done
  return 1
}

# 패치가 아닌 추적 파일 변경(빌드 산출물 제외)
dirty_paths() {
  local p
  git status --porcelain --untracked-files=no | sed 's/^...//' | while IFS= read -r p; do is_build_output "${p}" || printf '%s\n' "${p}"; done
}

# ── 3. checkout ───────────────────────────────────────────────────────
head="$(git rev-parse --verify --quiet HEAD || true)"
if [ "${head}" != "${rev}" ]; then
  if [ -n "${head}" ]; then
    # 적용해 둔 패치를 모두 역적용한 뒤에 rev 를 바꾼다(새 rev 의 패치는 4단계에서). 먼저 확인만 한다:
    #  - 패치가 다루지 않는 추적 파일의 변경(빌드 산출물 제외)이 없어야 한다
    #  - 패치가 다루는 파일은 정확히 "기록된 패치를 적용한 상태"여야 한다
    for name in ${recorded[@]+"${recorded[@]}"}; do patch_paths "${record_dir}/${name}"; done | sort -u > "${tmp}/paths"
    others="$(dirty_paths | grep -vxF -f "${tmp}/paths" || true)"
    if [ -n "${others}" ]; then
      printf '  %s\n' ${others} >&2
      die "작업 트리에 패치가 아닌 변경이 있어(위 파일) ${rev} 로 checkout 하지 않습니다. 아무것도 바꾸지 않았습니다. 변경을 정리하고(필요하면 scripts/update-patch.sh 로 패치에 반영) 다시 실행하세요$([ "${had_record}" = 1 ] || echo ' (패치 기록이 없는 체크아웃이면 적용된 패치도 직접 되돌려야 합니다)')"
    fi
    if [ "${#recorded[@]}" -gt 0 ]; then
      as_old="$(tree_with "${tmp}/paths" "${recorded[@]/#/${record_dir}/}" || echo none)"
      same_on "${tmp}/paths" "$(tree_now "${tmp}/paths")" "${as_old}" \
        || die "rev 를 바꾸려면 적용해 둔 패치를 역적용해야 하는데, 패치가 다루는 파일에 패치가 아닌 변경이 섞여 있습니다. 아무것도 바꾸지 않았습니다"
      log "rev 가 바뀜(${head:0:12} → ${rev:0:12}): 적용해 둔 패치를 먼저 역적용합니다"
      reverse_recorded_to 0
    fi
    # 빌드 산출물은 되돌린다 — build-wasm.sh 가 다시 만든다
    for p in "${build_outputs[@]}"; do
      if git ls-files --error-unmatch -- "${p}" >/dev/null 2>&1 && ! git diff --quiet -- "${p}"; then git checkout -- "${p}"; fi
    done
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
# 기록과 앞부분이 같은 패치(이름·내용)는 그대로 둔다.
keep=0
while [ "${keep}" -lt "${#recorded[@]}" ] && [ "${keep}" -lt "${#desired[@]}" ] \
  && [ "${recorded[keep]}" = "${desired[keep]}" ] && cmp -s "${record_dir}/${recorded[keep]}" "${patch_dir}/${desired[keep]}"; do
  keep=$((keep + 1))
done

if [ "${keep}" -lt "${#recorded[@]}" ]; then
  # 패치가 바뀌었다. 그 패치들이 다루는 파일이 지금 어떤 상태인지 정확히 비교해서 정한다.
  stale=()
  for ((i = keep; i < ${#recorded[@]}; i += 1)); do stale+=("${record_dir}/${recorded[i]}"); done
  fresh=()
  for ((i = keep; i < ${#desired[@]}; i += 1)); do fresh+=("${patch_dir}/${desired[i]}"); done
  prefix=()
  for ((i = 0; i < keep; i += 1)); do prefix+=("${patch_dir}/${desired[i]}"); done
  for f in "${stale[@]}" ${fresh[@]+"${fresh[@]}"}; do patch_paths "${f}"; done | grep -vx '/dev/null' | sort -u > "${tmp}/paths"
  now="$(tree_now "${tmp}/paths")"
  as_old="$(tree_with "${tmp}/paths" ${prefix[@]+"${prefix[@]}"} "${stale[@]}" || echo none)"
  as_new="$(tree_with "${tmp}/paths" ${prefix[@]+"${prefix[@]}"} ${fresh[@]+"${fresh[@]}"} || echo none)"
  as_base="$(tree_with "${tmp}/paths" ${prefix[@]+"${prefix[@]}"} || echo none)"
  if same_on "${tmp}/paths" "${now}" "${as_new}"; then
    # 트리가 이미 새 패치 상태다(예: scripts/update-patch.sh 로 트리에서 패치를 다시 만들었다). 기록만 고친다.
    log "트리가 이미 새 패치 상태입니다: 기록만 고칩니다 (${desired[*]:${keep}})"
    recorded=("${recorded[@]:0:${keep}}")
    for f in ${fresh[@]+"${fresh[@]}"}; do record_push "${f}"; done
    [ "${#fresh[@]}" -gt 0 ] || write_series ${recorded[@]+"${recorded[@]}"}
  elif same_on "${tmp}/paths" "${now}" "${as_old}"; then
    log "패치가 바뀌었습니다: 적용해 둔 ${recorded[*]:${keep}} 을 역적용하고 새 패치를 적용합니다"
    reverse_recorded_to "${keep}"
  elif same_on "${tmp}/paths" "${now}" "${as_base}"; then
    # 옛 패치가 이미 빠져 있다(사람이 되돌렸다). 기록만 맞춘다.
    recorded=("${recorded[@]:0:${keep}}")
    write_series ${recorded[@]+"${recorded[@]}"}
  else
    [ "${as_old}" = none ] || GIT_NO_LAZY_FETCH=1 xargs git diff-tree --name-only -r "${as_old}" "${now}" -- < "${tmp}/paths" 2>/dev/null | sed 's/^/  /' >&2 || true
    die "패치가 바뀌었지만 upstream/rhwp 에 패치가 아닌 변경이 섞여 있어(위 파일, 옛 패치를 적용한 상태와 다름) 아무것도 바꾸지 않았습니다. 변경을 패치에 넣으려면 scripts/update-patch.sh, 버리려면 그 파일을 되돌린 뒤 다시 실행하세요"
  fi
fi

for ((i = 0; i < ${#desired[@]}; i += 1)); do
  name="${desired[i]}"
  patch="${patch_dir}/${name}"
  if [ "${i}" -lt "${#recorded[@]}" ]; then
    # 기록에 있는 패치: 트리에도 있는지 확인한다(사람이 되돌렸으면 다시 적용)
    if git apply --reverse --check "${patch}" 2>/dev/null; then
      log "이미 적용됨: ${name}"
      continue
    fi
    git apply --check "${patch}" 2>/dev/null || { git apply --check "${patch}" || true; die "패치를 적용할 수 없습니다: ${name} (작업 트리가 패치와 다르게 바뀌었습니다)"; }
    apply_one "${patch}"
    log "다시 적용(기록에는 있었지만 트리에 없음): ${name}"
    continue
  fi
  if git apply --reverse --check "${patch}" 2>/dev/null; then
    log "이미 적용됨: ${name}"
  elif git apply --check "${patch}" 2>/dev/null; then
    apply_one "${patch}"
    log "적용: ${name}"
  elif [ "${had_record}" = 0 ] && reverse_from_history "${i}" && git apply --check "${patch}" 2>/dev/null; then
    apply_one "${patch}"
    log "적용: ${name}"
  else
    git apply --check "${patch}" || true
    hint=""
    [ "${had_record}" = 1 ] || hint=" — 패치 기록(.git/cc-applied)이 없는 체크아웃이면 옛 패치가 적용된 채일 수 있습니다. upstream/rhwp 의 패치 변경을 되돌린 뒤 다시 실행하세요"
    die "패치를 적용할 수 없습니다: ${name} (작업 트리가 패치와 다르게 바뀌었거나 rev 가 맞지 않습니다)${hint}"
  fi
  record_push "${patch}"
done
# 기록 = patches/ (이름·내용) — 사본도 지금 패치로 맞춘다
recorded=()
for name in ${desired[@]+"${desired[@]}"}; do
  cmp -s "${patch_dir}/${name}" "${record_dir}/${name}" 2>/dev/null || cp "${patch_dir}/${name}" "${record_dir}/${name}"
  recorded+=("${name}")
done
write_series ${recorded[@]+"${recorded[@]}"}
prune_copies

# ── 5. collab 분류표 ───────────────────────────────────────────────────
# 업스트림 변경 메서드 목록으로 분류표·엔진 지문을 다시 만든다. 새 기능은 멈추지 않고 경고만 한다
# (결과 전송으로 동기화된다, docs/collab-stage2.md §3).
if command -v node >/dev/null 2>&1; then
  node "${root}/scripts/gen-catalog.mjs" || die "분류표 생성 실패"
else
  log "경고: node 가 없어 분류표를 다시 만들지 않았습니다 (scripts/gen-catalog.mjs)"
fi

log "완료 (upstream/rhwp @ ${rev:0:12})"
