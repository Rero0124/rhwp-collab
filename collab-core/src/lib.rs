//! cc-rhwp 공동편집 코어 보조 (`CollabCore`) — 2단계 (docs/collab-stage2.md §2, §5).
//!
//! `HwpDocument`(WASM 바인딩)와 실제 `DocumentCore` 사이에 끼운다.
//!
//! ```text
//! HwpDocument ──Deref──▶ CollabCore ──Deref──▶ DocumentCore
//! ```
//!
//! 2단계에서 **기록은 JS 의 기록 훅(WASM export 경계)이 한다.** 이 타입은 기록하지 않고(1단계의 가로채기·
//! outbox·복원 desync 는 은퇴), 엔진이 쓰는 보조 기능만 둔다:
//!
//! - 자체 스냅샷 저장소 — 업스트림 `snapshot_store` 는 studio undo 예산과 공유하므로 쓰지 않는다.
//! - 결과 적재·내보내기 (`state` 기록)
//! - 텍스트 연산 메타데이터 실측과 기록 시 불변식 (`measure`)
//! - 숨은 입력 `active_field` 읽기·맞추기 (`ctx.activeField`)
//! - 논리↔텍스트 오프셋 변환
//! - 문서 지문 (`digest`)
//! - 보정 함수 (`ot`, 문서를 보지 않는 순수 함수)
//!
//! 이 파일은 업스트림 rhwp 크레이트 안에 `#[path]` 로 포함된다 (`patches/rhwp/0001`). 크레이트 내부
//! 모듈이라 `pub(crate)` 필드·메서드를 쓸 수 있다.

use std::collections::{HashMap, HashSet};
use std::ops::{Deref, DerefMut};

use serde_json::{json, Value};

use crate::document_core::{ActiveFieldInfo, DocumentCore};
use crate::error::HwpError;
use crate::model::document::Document;
use crate::model::raw_provenance::{bytes_digest, doc_info_model_digest, section_model_digest};
use crate::renderer::render_normalization::RenderPath;

#[path = "ot.rs"]
pub mod ot;
// 5단계 D4: 좁은 권한(form·comment) 편집의 결과 판정·누름틀 범위 판정
mod confine;

#[cfg(feature = "wasm-api")]
#[path = "wasm.rs"]
mod wasm;

// ── 메모 시각 고정 (5단계 D4 후속: 메모 함수를 op 로) ─────────────────────────────
//
// 메모를 만들 때 업스트림이 지금 UTC 시각(FILETIME)을 메모 명령에 박는다(`model/memo_time.rs`) — 같은 호출을 다른
// 때 재생하면 다른 문서가 된다. 기록 쪽은 시각 T 를 정해 고정한 채 부르고 `ctx.memoTime = T` 로 남기며, 재생 쪽은 같은
// T 로 고정한 채 부른다. 업스트림 `memo_time::now()` 는 고정값이 있으면 그 값을 쓴다(0001 의 한 줄).

thread_local! {
    static MEMO_TIME: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

/// 지금 고정된 메모 시각(FILETIME 틱). 업스트림 `memo_time::now()` 가 부른다.
pub fn pinned_memo_time() -> Option<u64> {
    MEMO_TIME.with(std::cell::Cell::get)
}

/// 메모 시각을 고정하는 동안 살아 있는 가드. 버리면(패닉으로 풀릴 때도) 이전 값으로 돌아간다.
pub struct MemoTimePin(Option<u64>);

impl MemoTimePin {
    pub fn new(ticks: u64) -> Self {
        Self(MEMO_TIME.with(|c| c.replace(Some(ticks))))
    }
}

impl Drop for MemoTimePin {
    fn drop(&mut self) {
        MEMO_TIME.with(|c| c.set(self.0));
    }
}

/// 고정값을 바꾸고 이전 값을 돌려준다(JS 경계용 — 호출하는 쪽이 `finally` 에서 이전 값으로 되돌린다).
pub fn set_pinned_memo_time(ticks: Option<u64>) -> Option<u64> {
    MEMO_TIME.with(|c| c.replace(ticks))
}

/// 지금 시각(FILETIME 틱) — 고정돼 있으면 그 값. 기록 쪽이 고정할 T 를 정할 때 쓴다.
pub fn memo_time_now() -> u64 {
    crate::model::memo_time::now()
}

/// gzip 머리 (RFC 1952)
const GZIP_MAGIC: [u8; 2] = [0x1f, 0x8b];
/// 결과 풀기 상한 — 압축 폭탄으로 메모리를 다 쓰지 않게 한다.
const MAX_STATE_BYTES: u64 = 512 * 1024 * 1024;

/// 결과 바이트를 전송용으로 감싼다(gzip, 빠른 수준 — HWP·HWPX 는 이미 대부분 압축돼 있다).
pub fn pack_state(raw: &[u8]) -> Result<Vec<u8>, HwpError> {
    use std::io::Write;
    let mut enc = flate2::write::GzEncoder::new(Vec::with_capacity(raw.len() / 2 + 64), flate2::Compression::fast());
    enc.write_all(raw).map_err(|e| HwpError::RenderError(format!("결과 압축 실패: {e}")))?;
    enc.finish().map_err(|e| HwpError::RenderError(format!("결과 압축 실패: {e}")))
}

/// 원본 레코드 묶음의 내용 열쇠(태그·수준·길이·바이트) — 6단계 S1 의 "같은 내용" 비교.
fn raw_records_key(records: &[crate::model::document::RawRecord]) -> Vec<u8> {
    let mut key = Vec::with_capacity(records.iter().map(|r| 8 + r.data.len()).sum());
    for r in records {
        key.extend_from_slice(&r.tag_id.to_le_bytes());
        key.extend_from_slice(&r.level.to_le_bytes());
        key.extend_from_slice(&(r.data.len() as u32).to_le_bytes());
        key.extend_from_slice(&r.data);
    }
    key
}

/// 열쇠마다 남은 개수 — 같은 내용이 둘이면 둘까지만 받아들인다.
fn take_known(known: &mut HashMap<Vec<u8>, usize>, key: &[u8]) -> bool {
    match known.get_mut(key) {
        Some(n) if *n > 0 => {
            *n -= 1;
            true
        }
        _ => false,
    }
}

/// 6단계 S1 결정 (C): DocInfo 의 모르는 레코드(`extra_records` — 파서가 해석하지 않아 날 바이트로 들고 있는 레코드) 중
/// 정본에 같은 내용으로 없는 것을 버린다. 정상 기능 중 여기에 새 내용을 만드는 것은 메모 모양(`setMemoShape`, 연산 —
/// 정본이 state 보다 먼저 적용한다)뿐이고, 배포용 문서 풀기(`convertToEditable`)는 빼기만 한다. 메모 모양을 버렸으면
/// ID_MAPPINGS 의 메모 모양 수를 남은 레코드 수로 맞춘다. 버린 것이 있으면 true.
fn keep_known_doc_info_records(doc: &mut Document, canon: &Document) -> bool {
    use crate::parser::tags::HWPTAG_MEMO_SHAPE;
    let mut known: HashMap<Vec<u8>, usize> = HashMap::new();
    for r in &canon.doc_info.extra_records {
        *known.entry(raw_records_key(std::slice::from_ref(r))).or_default() += 1;
    }
    let memo_shapes = |records: &[crate::model::document::RawRecord]| records.iter().filter(|r| r.tag_id == HWPTAG_MEMO_SHAPE).count();
    let (before, memo_before) = (doc.doc_info.extra_records.len(), memo_shapes(&doc.doc_info.extra_records));
    doc.doc_info.extra_records.retain(|r| take_known(&mut known, &raw_records_key(std::slice::from_ref(r))));
    if doc.doc_info.extra_records.len() == before {
        return false;
    }
    let memo_after = memo_shapes(&doc.doc_info.extra_records);
    if memo_after != memo_before {
        doc.doc_info.memo_shape_count = memo_after as u32;
    }
    doc.doc_info.raw_stream = None;
    doc.doc_info.raw_provenance = None;
    true
}

/// 6단계 S1 결정 (C): 구역 끝 목록(`trailing_lists` — 마지막 문단 뒤의 메모 목록·확장 바탕쪽 목록·모르는 목록을 날
/// 레코드로 들고 있다)의 묶음 중 정본 문서 어디에도 같은 내용으로 없는 것을 버린다(구역을 합치거나 나눠 자리가 옮겨도
/// 받아들이게 문서 전체에서 찾는다).
///
/// 정상 기능이 여기에 새 내용을 만드는 길은 저장기뿐이다 — 메모를 고치면 메모 목록을, 원본 바탕쪽 목록이 없는 구역은
/// 확장 바탕쪽 목록을 모델에서 써서, 그 바이트를 다시 읽으면 끝 목록이 된다. 그래서 버려도 모델에서 다시 쓰게 한다:
/// - 메모 묶음을 버리면 그 끝 목록의 메모 봉인을 푼다 → 저장기가 원본 메모 묶음을 쓰지 않고 모델(메모 본문)에서 다시 쓴다.
/// - 바탕쪽 묶음을 하나라도 버리면 그 구역의 원본 바탕쪽 묶음을 **모두** 버린다 → 모델이 확장 바탕쪽을 모두 쓴다
///   (일부만 남기면 저장기가 남은 원본만 쓰고 모델의 나머지를 잃는다). 업스트림 바탕쪽 편집과 같은 방식으로, 봉인이
///   맞았으면 버린 뒤의 투영으로 다시 봉인한다.
/// - 그 밖의 모르는 목록은 그냥 버린다(모델에 없다).
///
/// 버린 것이 있으면 true.
fn keep_known_section_tails(doc: &mut Document, canon: &Document) -> bool {
    let mut known: HashMap<Vec<u8>, usize> = HashMap::new();
    for tail in canon.sections.iter().filter_map(|s| s.trailing_lists.as_ref()) {
        for (_, group) in tail.record_groups() {
            *known.entry(raw_records_key(group)).or_default() += 1;
        }
    }
    let sealed = crate::model::section_tail::validate_preservation(doc).is_ok();
    let mut changed = false;
    for section in &mut doc.sections {
        let Some(tail) = section.trailing_lists.as_mut() else { continue };
        let masters = tail.master_list_mask();
        let mut keep = Vec::with_capacity(tail.records.len());
        let (mut memo_dropped, mut master_dropped) = (false, false);
        for (memo, group) in tail.record_groups() {
            let ok = take_known(&mut known, &raw_records_key(group));
            if !ok {
                if memo {
                    memo_dropped = true;
                } else if masters[keep.len()] {
                    master_dropped = true;
                }
            }
            keep.extend(std::iter::repeat_n(ok, group.len()));
        }
        if master_dropped {
            for (k, master) in keep.iter_mut().zip(&masters) {
                *k &= !master;
            }
        }
        if keep.iter().all(|k| *k) {
            continue;
        }
        changed = true;
        let mut flags = keep.into_iter();
        tail.records.retain(|_| flags.next().unwrap_or(false));
        if memo_dropped {
            tail.memo_seal = None;
        }
        if tail.records.is_empty() {
            section.trailing_lists = None;
        }
        section.raw_stream = None;
        section.raw_provenance = None;
    }
    if changed && sealed {
        doc.seal_section_tail_provenance();
    }
    changed
}

/// 6단계 S2: 원본 바이트 캐시를 모두 버린다 — 저장기가 모든 부분을 모델에서 쓴다(편집했을 때와 같다).
fn strip_raw_caches(doc: &mut Document) {
    for section in &mut doc.sections {
        section.raw_stream = None;
        section.raw_provenance = None;
    }
    let info = &mut doc.doc_info;
    info.raw_stream = None;
    info.raw_provenance = None;
    for font in info.font_faces.iter_mut().flatten() {
        font.raw_data = None;
    }
    for x in &mut info.border_fills {
        x.raw_data = None;
    }
    for x in &mut info.char_shapes {
        x.raw_data = None;
    }
    for x in &mut info.tab_defs {
        x.raw_data = None;
    }
    for x in &mut info.numberings {
        x.raw_data = None;
    }
    for x in &mut info.bullets {
        x.raw_data = None;
    }
    for x in &mut info.para_shapes {
        x.raw_data = None;
    }
    for x in &mut info.styles {
        x.raw_data = None;
    }
    doc.doc_properties.raw_data = None;
}

/// 6단계 S2: 스트림(DocInfo·구역 순번)마다 레코드 태그 멀티셋에서 사라진 레코드 수와 태그별 요약.
fn lost_records(before: &Document, after: &Document) -> (usize, String) {
    use crate::parser::record::Record;
    let tags = |raw: Option<&Vec<u8>>| -> Option<std::collections::BTreeMap<u16, usize>> {
        let mut m = std::collections::BTreeMap::new();
        for r in Record::read_all(raw?).ok()? {
            *m.entry(r.tag_id).or_default() += 1;
        }
        Some(m)
    };
    let mut by_tag: std::collections::BTreeMap<u16, usize> = std::collections::BTreeMap::new();
    let mut pairs = vec![(before.doc_info.raw_stream.as_ref(), after.doc_info.raw_stream.as_ref())];
    pairs.extend(before.sections.iter().zip(&after.sections).map(|(a, b)| (a.raw_stream.as_ref(), b.raw_stream.as_ref())));
    for (a, b) in pairs {
        let (Some(a), Some(b)) = (tags(a), tags(b)) else { continue };
        for (tag, n) in a {
            let have = b.get(&tag).copied().unwrap_or(0);
            if n > have {
                *by_tag.entry(tag).or_default() += n - have;
            }
        }
    }
    let total = by_tag.values().sum();
    let name = |tag: u16| match crate::parser::tags::tag_name(tag) {
        "UNKNOWN" | "" => format!("0x{tag:03x}"),
        n => n.to_string(),
    };
    (total, summarize(by_tag.iter().map(|(t, n)| format!("{}×{n}", name(*t))), 6))
}

/// 앞의 `max` 개를 "; " 로 잇고, 남으면 "외 N" 을 붙인다.
fn summarize(items: impl Iterator<Item = String>, max: usize) -> String {
    let all: Vec<String> = items.collect();
    let mut s = all.iter().take(max).cloned().collect::<Vec<_>>().join("; ");
    if all.len() > max {
        s.push_str(&format!(" 외 {}", all.len() - max));
    }
    s
}

fn bytes_hash(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

/// gzip 이면 풀고, 아니면(HWP·HWPX 원본) 그대로 돌려준다.
pub fn unpack_state(bytes: &[u8]) -> Result<std::borrow::Cow<'_, [u8]>, HwpError> {
    use std::io::Read;
    if !bytes.starts_with(&GZIP_MAGIC) {
        return Ok(std::borrow::Cow::Borrowed(bytes));
    }
    let mut out = Vec::with_capacity(bytes.len() * 2);
    flate2::read::GzDecoder::new(bytes)
        .take(MAX_STATE_BYTES + 1)
        .read_to_end(&mut out)
        .map_err(|e| HwpError::InvalidFile(format!("결과 압축 풀기 실패: {e}")))?;
    if out.len() as u64 > MAX_STATE_BYTES {
        return Err(HwpError::InvalidFile(format!("결과가 상한 {MAX_STATE_BYTES}바이트를 넘음")));
    }
    Ok(std::borrow::Cow::Owned(out))
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

/// 자체 스냅샷: 업스트림 `save_snapshot_native` 이 담는 것과 같다.
struct Snapshot {
    document: Document,
    text_reflowed_table_paths: HashSet<RenderPath>,
    /// 뜰 때의 `CollabCore::state_loads` — 그 뒤 결과 적재가 있었는지(D4 판정의 정규화)
    state_loads: u64,
}

/// 실제 `DocumentCore` 를 감싸 공동편집 보조 기능을 더하는 래퍼.
pub struct CollabCore {
    inner: DocumentCore,
    snapshots: Vec<(u32, Snapshot)>,
    next_snapshot_id: u32,
    /// 재생 때 잠시 바꾼 내부 클립보드를 되돌려 놓을 자리(R13 ctx.clipboard).
    clipboard_stash: Vec<(Option<crate::document_core::ClipboardData>, u32)>,
    /// S3-0: BinData 항목 내용 해시 캐시 (`digest` 는 `&self` 라 내부 가변).
    bin_digest: std::sync::Mutex<BinDigestCache>,
    /// 결과 적재(`load_state`) 횟수. 스냅샷 뒤에 적재가 있었으면 D4 판정이 스냅샷 쪽도 내보내기→다시 읽기로 맞춘다.
    state_loads: u64,
}

/// S3-0 BinData 내용 해시 캐시 (docs/collab-stage3.md S3-0).
///
/// digest 는 **저장 표현이 아니라 내용**을 본다 — 편집한 쪽은 `Loaded`(비압축), 그 결과를 다시 읽은 쪽은
/// 압축된 원본 스트림을 들고 있어도 같은 값이 나와야 한다(체크포인트·welcome 경로). 압축 해제 비용은 두 단계
/// 캐시로 피한다:
/// - (a) `(bin_data_epoch, id)` → 내용 해시. 업스트림 계약상 바이트를 제자리에서 바꾸는 곳은 epoch 를 올린다.
///   항목의 정체(Lazy 리졸버·키, Loaded 버퍼 주소·길이)도 함께 맞춰 봐서, epoch 를 올리지 않는 경로가
///   생겨도 틀린 값을 내지 않는다.
/// - (b) 저장 바이트의 해시 → 내용 해시. 편집하지 않은 항목은 내보내기 → 다시 읽기를 거쳐도 저장 바이트가
///   같으므로(§기록 S3-0) state 적재·되감기 뒤에도 압축을 다시 풀지 않는다.
/// - (c) `Loaded`·메모리 공유 항목은 이미 풀린 바이트라 그대로 해시한다.
#[derive(Default)]
struct BinDigestCache {
    epoch: Option<u32>,
    by_id: std::collections::HashMap<u16, (BinIdent, [u8; 32])>,
    by_stored: std::collections::HashMap<[u8; 32], [u8; 32]>,
    /// 저장 표현이 있는 항목의 내용을 실제로 꺼낸(압축 해제) 횟수 — 시험용.
    content_loads: u64,
}

/// 캐시 항목이 가리키던 BinData 값의 정체. Lazy 는 리졸버를 `Weak` 로 쥐어 주소 재사용을 막는다.
enum BinIdent {
    Lazy(std::sync::Weak<dyn crate::model::bin_data::BinDataResolver>, String),
    Loaded(usize, usize),
}

impl BinIdent {
    fn of(data: &crate::model::bin_data::BinDataBytes) -> Self {
        use crate::model::bin_data::BinDataBytes;
        match data {
            BinDataBytes::Loaded(v) => BinIdent::Loaded(v.as_ptr() as usize, v.len()),
            BinDataBytes::Lazy { resolver, key } => BinIdent::Lazy(std::sync::Arc::downgrade(resolver), key.clone()),
        }
    }

    fn same(&self, data: &crate::model::bin_data::BinDataBytes) -> bool {
        use crate::model::bin_data::BinDataBytes;
        match (self, data) {
            (BinIdent::Loaded(p, n), BinDataBytes::Loaded(v)) => *p == v.as_ptr() as usize && *n == v.len(),
            (BinIdent::Lazy(w, k), BinDataBytes::Lazy { resolver, key }) => {
                k == key && w.strong_count() > 0 && std::ptr::addr_eq(w.as_ptr(), std::sync::Arc::as_ptr(resolver))
            }
            _ => false,
        }
    }
}

/// (b) 의 메모가 끝없이 자라지 않게 하는 상한.
const BIN_STORED_MEMO_MAX: usize = 8192;

impl BinDigestCache {
    /// 항목 하나의 내용 해시.
    fn item(&mut self, epoch: u32, content: &crate::model::bin_data::BinDataContent) -> [u8; 32] {
        use crate::model::bin_data::BinDataBytes;
        if self.epoch != Some(epoch) {
            self.epoch = Some(epoch);
            self.by_id.clear();
        }
        if let Some((ident, hash)) = self.by_id.get(&content.id) {
            if ident.same(&content.data) {
                return *hash;
            }
        }
        let hash = match &content.data {
            BinDataBytes::Loaded(v) => bytes_digest(v),
            BinDataBytes::Lazy { .. } => {
                let stored = Self::stored_digest(&content.data);
                match stored.and_then(|k| self.by_stored.get(&k).copied()) {
                    Some(hash) => hash,
                    None => {
                        let hash = bytes_digest(&content.data.load_shared());
                        if let Some(k) = stored {
                            self.content_loads += 1;
                            if self.by_stored.len() >= BIN_STORED_MEMO_MAX {
                                self.by_stored.clear();
                            }
                            self.by_stored.insert(k, hash);
                        }
                        hash
                    }
                }
            }
        };
        self.by_id.insert(content.id, (BinIdent::of(&content.data), hash));
        hash
    }

    /// 저장 표현(압축을 풀지 않은 원본 바이트)의 해시. HWP5 는 원본 스트림, HWPX 는 deflate 엔트리.
    /// 메모리 공유 항목처럼 저장 표현이 없으면 `None`.
    fn stored_digest(data: &crate::model::bin_data::BinDataBytes) -> Option<[u8; 32]> {
        let mut h = blake3::Hasher::new();
        if let Some(raw) = data.load_raw() {
            h.update(b"raw");
            h.update(&[raw.compressed as u8]);
            h.update(&raw.bytes);
        } else if let Some(zip) = data.load_deflated_zip_entry() {
            h.update(b"zip");
            h.update(&zip.crc32.to_le_bytes());
            h.update(&zip.uncompressed_size.to_le_bytes());
            h.update(&zip.compressed_bytes);
        } else {
            return None;
        }
        Some(*h.finalize().as_bytes())
    }
}

/// `measure` 인자 오류.
fn bad_args(method: &str, detail: impl std::fmt::Display) -> HwpError {
    HwpError::RenderError(format!("collab measure {method}: {detail}"))
}

impl CollabCore {
    pub fn new(inner: DocumentCore) -> Self {
        Self { inner, snapshots: Vec::new(), next_snapshot_id: 1, clipboard_stash: Vec::new(), bin_digest: Default::default(), state_loads: 0 }
    }

    // ── 자체 스냅샷 (§5) ────────────────────────────────────────────────
    // 저장·복원 순서는 업스트림 `save_snapshot_native` / `restore_snapshot_native`
    // (document_core/commands/document.rs)와 같다. 업스트림이 순서를 바꾸면 동일성 테스트가 깨진다.

    pub fn snapshot_save(&mut self) -> u32 {
        self.inner.flush_cell_format_vpos();
        let id = self.next_snapshot_id;
        self.next_snapshot_id = self.next_snapshot_id.wrapping_add(1).max(1);
        self.snapshots.push((
            id,
            Snapshot {
                document: self.inner.document.clone(),
                text_reflowed_table_paths: self.inner.text_reflowed_table_paths_for_snapshot(),
                state_loads: self.state_loads,
            },
        ));
        id
    }

    pub fn snapshot_restore(&mut self, id: u32) -> Result<(), HwpError> {
        let (document, paths) = self
            .snapshots
            .iter()
            .find(|(sid, _)| *sid == id)
            .map(|(_, s)| (s.document.clone(), s.text_reflowed_table_paths.clone()))
            .ok_or_else(|| HwpError::RenderError(format!("collab 스냅샷 {id} 없음")))?;
        self.install(document, &paths);
        Ok(())
    }

    pub fn snapshot_discard(&mut self, id: u32) {
        self.snapshots.retain(|(sid, _)| *sid != id);
    }

    pub fn snapshot_count(&self) -> usize {
        self.snapshots.len()
    }

    /// 문서를 통째로 갈아끼운다 — 업스트림 스냅샷 복원과 같은 설치 순서.
    fn install(&mut self, document: Document, paths: &HashSet<RenderPath>) {
        self.inner.document = document;
        self.inner.restore_text_reflowed_tables_from_snapshot(paths);
        self.inner.bump_bin_data_epoch();
        self.inner.rebuild_derived_state();
    }

    // ── 결과 적재·내보내기 (`state` 기록) ─────────────────────────────────

    /// 바이트를 파싱해 **지금 문서 객체 안에서** 문서를 교체한다. studio 의 문서 교체(재열기·글꼴 확인·
    /// 세대 증가)를 거치지 않고, studio 가 이 객체에 넣어 둔 글꼴·측정 환경은 그대로 둔다. 옛 문서의
    /// 위치를 가리키던 세션 상태(`active_field`)는 비운다.
    ///
    /// `bytes` 는 gzip 으로 감싼 결과(`export_state`) 또는 HWP·HWPX 원본 바이트다(R12). 문서의 원본 형식
    /// (`source_format`)도 읽은 바이트의 형식으로 바꾼다 — 다음 `export_state` 가 같은 형식 계열로 나간다.
    pub fn load_state(&mut self, bytes: &[u8]) -> Result<(), HwpError> {
        let raw = unpack_state(bytes)?;
        let parsed = DocumentCore::from_bytes(&raw)?;
        let paths = parsed.text_reflowed_table_paths_for_snapshot();
        let format = parsed.source_format;
        self.install(parsed.document, &paths);
        self.inner.source_format = format;
        self.inner.active_field = None;
        self.state_loads += 1;
        Ok(())
    }

    /// 결과 전송용 내보내기. 캐럿을 써 넣지 않는 원시 export 다(studio 의 `onBeforeExport` 를 타지 않음).
    ///
    /// R12: 원본 형식 계열로 내보낸다 — HWPX 로 연 문서는 HWPX, 그 밖은 HWP. HWPX 출처 문서를 HWP 원시
    /// 직렬화(`export_hwp_native`)로 내보내면 HWPX→HWP 어댑터(파일 헤더 압축 표시)를 거치지 않아 모든
    /// 스트림이 압축 없이 들어간다(그림이 비압축 BMP 인 샘플에서 7.9MB → 174MB, §10 R12). 전송용으로
    /// gzip 으로 감싼다.
    pub fn export_state(&self) -> Result<Vec<u8>, HwpError> {
        let raw = match self.inner.source_format {
            crate::parser::FileFormat::Hwpx => self.inner.export_hwpx_native()?,
            _ => self.inner.export_hwp_native()?,
        };
        pack_state(&raw)
    }

    fn measure_cell(&self, phase: &str, method: &str, args: &[Value], before: &Value, space: &ot::Space, cp: usize) -> Value {
        let Some(paras) = self.cell_paras_of(space) else {
            return if phase == "before" { json!({}) } else { json!({ "ok": false, "reason": format!("{method}: 칸을 찾을 수 없음") }) };
        };
        let len = |p: usize| paras.get(p).map(|x| x.text.chars().count() as i64);
        let now = json!({ "count": paras.len(), "len": len(cp), "prev": if cp > 0 { json!(len(cp - 1)) } else { Value::Null } });
        if phase == "before" {
            return now;
        }
        let num = |v: &Value, k: &str| v.get(k).and_then(Value::as_i64);
        let fail = |reason: String| json!({ "ok": false, "reason": reason });
        let dcount = num(&now, "count").zip(num(before, "count")).map(|(a, b)| a - b);
        let dlen = num(&now, "len").zip(num(before, "len")).map(|(a, b)| a - b);
        let want_count = |want: i64| -> Option<Value> {
            if dcount == Some(want) { None } else { Some(fail(format!("{method}: 칸 문단 수 변화 {dcount:?} (기대 {want})"))) }
        };
        let arg_num = |i: usize| args.get(i).and_then(Value::as_u64).map(|v| v as i64);
        let meta = if method.starts_with("insertText") {
            if let Some(f) = want_count(0) {
                return f;
            }
            match dlen {
                Some(d) if d >= 0 => json!({ "len": d }),
                _ => return fail(format!("{method}: 칸 문단 길이가 줄었다")),
            }
        } else if method.starts_with("deleteText") {
            if let Some(f) = want_count(0) {
                return f;
            }
            match dlen {
                Some(d) if d <= 0 => json!({ "count": -d }),
                _ => return fail(format!("{method}: 칸 문단 길이가 늘었다")),
            }
        } else if method.starts_with("replaceText") {
            if let Some(f) = want_count(0) {
                return f;
            }
            let ins = args.get(7).and_then(Value::as_str).map(|t| t.chars().count() as i64).unwrap_or(0);
            match dlen.map(|d| ins - d) {
                Some(del) if del >= 0 => json!({ "deleted": del, "insLen": ins }),
                _ => return fail(format!("{method}: 삭제 수가 음수")),
            }
        } else if method.starts_with("splitParagraph") {
            if let Some(f) = want_count(1) {
                return f;
            }
            json!({})
        } else if method.starts_with("mergeParagraph") {
            if let Some(f) = want_count(-1) {
                return f;
            }
            match num(before, "prev") {
                Some(prev) if cp > 0 => json!({ "prevLen": prev }),
                _ => return fail(format!("{method}: 앞 칸 문단이 없음")),
            }
        } else if method == "deleteRangeInCellByPath" {
            let (sp, ep) = (arg_num(3).unwrap_or(0), arg_num(5).unwrap_or(0));
            if let Some(f) = want_count(-(ep - sp)) {
                return f;
            }
            json!({})
        } else {
            return json!({ "ok": true, "meta": null });
        };
        json!({ "ok": true, "meta": meta })
    }

    // ── 숨은 입력: 내부 클립보드 (ctx.clipboard, R13 §4.6-4) ─────────────────

    /// 내부 클립보드와 붙여넣기 연쇄 수를 기록용 JSON 으로. 문단 목록은 HWP 문단 레코드로 직렬화한다(모델 타입은
    /// 역직렬화를 갖지 않는다). 글자·문단 모양은 이 문서의 모양 번호를 그대로 가리킨다(같은 문서 안 복사).
    /// `{"paras": base64|null, "plain": 글, "reflowed": bool, "cascade": n}` (클립보드가 없으면 `paras` 가 null).
    pub fn export_clipboard(&self) -> Value {
        use base64::Engine as _;
        let cascade = self.inner.paste_cascade_count;
        match &self.inner.clipboard {
            None => json!({ "paras": null, "plain": "", "reflowed": false, "cascade": cascade }),
            Some(c) => {
                let mut records = Vec::new();
                crate::serializer::body_text::serialize_paragraph_list(&c.paragraphs, 0, &mut records);
                let bytes = crate::serializer::record_writer::write_records(&records);
                json!({
                    "paras": base64::engine::general_purpose::STANDARD.encode(bytes),
                    "plain": c.plain_text, "reflowed": c.copied_table_text_reflowed, "cascade": cascade,
                })
            }
        }
    }

    fn parse_clipboard(v: &Value) -> Result<(Option<crate::document_core::ClipboardData>, u32), HwpError> {
        use base64::Engine as _;
        let cascade = v.get("cascade").and_then(Value::as_u64).unwrap_or(0) as u32;
        let Some(b64) = v.get("paras").and_then(Value::as_str) else { return Ok((None, cascade)) };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| HwpError::InvalidFile(format!("클립보드 기록 풀기 실패: {e}")))?;
        let records = crate::parser::record::Record::read_all(&bytes).map_err(|e| HwpError::InvalidFile(format!("클립보드 레코드: {e}")))?;
        let paragraphs = crate::parser::body_text::parse_paragraph_list(&records);
        Ok((
            Some(crate::document_core::ClipboardData {
                paragraphs,
                plain_text: v.get("plain").and_then(Value::as_str).unwrap_or("").to_string(),
                copied_table_text_reflowed: v.get("reflowed").and_then(Value::as_bool).unwrap_or(false),
            }),
            cascade,
        ))
    }

    /// 기록하는 쪽: 내 클립보드를 직렬화했다가 다시 읽은 값으로 바꾼다 — 받는 쪽은 다시 읽은 클립보드로 붙여
    /// 넣으므로, 나도 같은 값으로 붙여 넣어야 갈리지 않는다(state 자기 적재와 같은 이유). 기록할 JSON 을 돌려준다.
    pub fn normalize_clipboard(&mut self) -> Result<Value, HwpError> {
        let v = self.export_clipboard();
        let (clip, cascade) = Self::parse_clipboard(&v)?;
        self.inner.clipboard = clip;
        self.inner.paste_cascade_count = cascade;
        Ok(v)
    }

    /// 재생하는 쪽: 지금 클립보드를 맡겨 두고 기록의 클립보드로 바꾼다. `pop_clipboard` 로 되돌린다.
    pub fn push_clipboard(&mut self, v: &Value) -> Result<(), HwpError> {
        let (clip, cascade) = Self::parse_clipboard(v)?;
        let prev = (std::mem::replace(&mut self.inner.clipboard, clip), self.inner.paste_cascade_count);
        self.inner.paste_cascade_count = cascade;
        self.clipboard_stash.push(prev);
        Ok(())
    }

    pub fn pop_clipboard(&mut self) {
        if let Some((clip, cascade)) = self.clipboard_stash.pop() {
            self.inner.clipboard = clip;
            self.inner.paste_cascade_count = cascade;
        }
    }

    // ── 숨은 입력: active_field (ctx.activeField) ────────────────────────

    pub fn active_field_json(&self) -> Value {
        match &self.inner.active_field {
            None => Value::Null,
            Some(af) => json!({
                "section": af.section_idx,
                "para": af.para_idx,
                "control": af.control_idx,
                "cellPath": af.cell_path.as_ref().map(|p| p.iter().map(|(c, i, q)| json!([c, i, q])).collect::<Vec<_>>()),
            }),
        }
    }

    /// `active_field` 를 기록된 값으로 맞추고 이전 값을 돌려준다(재생 때 잠시 맞추고 되돌리는 용도).
    pub fn set_active_field_json(&mut self, value: &Value) -> Result<Value, HwpError> {
        let previous = self.active_field_json();
        self.inner.active_field = parse_active_field(value)?;
        Ok(previous)
    }

    // ── 논리↔텍스트 오프셋 (§3 오프셋 단위) ─────────────────────────────

    pub fn logical_to_text(&self, section: usize, para: usize, logical: usize) -> Result<(usize, bool), HwpError> {
        let p = self.paragraph(section, para)?;
        Ok(crate::document_core::helpers::logical_to_text_offset(p, logical))
    }

    /// 텍스트 오프셋 → 논리 오프셋. `after_control` 이면 그 자리 개체 **뒤**를 가리키는 논리 오프셋.
    pub fn text_to_logical(&self, section: usize, para: usize, offset: usize, after_control: bool) -> Result<usize, HwpError> {
        let p = self.paragraph(section, para)?;
        let base = crate::document_core::helpers::text_to_logical_offset(p, offset);
        if !after_control {
            return Ok(base);
        }
        // 같은 텍스트 오프셋에 놓인 논리 인라인 개체 뒤 = 그 개체 칸 다음.
        let mut logical = base;
        while crate::document_core::helpers::logical_to_text_offset(p, logical + 1) == (offset, true) {
            logical += 1;
        }
        Ok(logical)
    }

    fn paragraph(&self, section: usize, para: usize) -> Result<&crate::model::paragraph::Paragraph, HwpError> {
        self.inner
            .document
            .sections
            .get(section)
            .and_then(|s| s.paragraphs.get(para))
            .ok_or_else(|| HwpError::RenderError(format!("구역 {section} 문단 {para} 없음")))
    }

    fn para_len(&self, section: usize, para: usize) -> Option<usize> {
        self.inner.document.sections.get(section)?.paragraphs.get(para).map(|p| p.text.chars().count())
    }

    fn para_count(&self, section: usize) -> Option<usize> {
        self.inner.document.sections.get(section).map(|s| s.paragraphs.len())
    }

    fn cell_para_count(&self, section: usize, pp: usize, ci: usize, cell: usize) -> Option<usize> {
        use crate::model::control::Control;
        let para = self.inner.document.sections.get(section)?.paragraphs.get(pp)?;
        match para.controls.get(ci)? {
            Control::Table(t) => t.cells.get(cell).map(|c| c.paragraphs.len()),
            _ => None,
        }
    }

    /// 셀 공간(중첩 포함)의 칸 문단 목록. 표 칸·글상자·캡션.
    fn cell_paras_of(&self, space: &ot::Space) -> Option<&[crate::model::paragraph::Paragraph]> {
        use crate::model::control::Control;
        let ot::Space::Cell { sec, hosts, chain } = space else { return None };
        let mut paras: &[crate::model::paragraph::Paragraph] = &self.inner.document.sections.get(*sec)?.paragraphs;
        for (k, &(ci, cell)) in chain.iter().enumerate() {
            let host = paras.get(hosts[k])?;
            paras = match host.controls.get(ci)? {
                Control::Table(t) if cell == 65534 => &t.caption.as_ref()?.paragraphs,
                Control::Table(t) => &t.cells.get(cell)?.paragraphs,
                Control::Shape(sh) => &crate::document_core::helpers::get_textbox_at(sh, cell)?.paragraphs,
                Control::Picture(pic) => &pic.caption.as_ref()?.paragraphs,
                _ => return None,
            };
        }
        Some(paras)
    }

    // ── 텍스트 연산 메타데이터 실측 (§3) ─────────────────────────────────

    /// `phase = "before"`: 호출 전 측정값. `phase = "after"`: 호출 뒤 측정 + `before` 로 `meta` 를 만든다.
    ///
    /// after 결과 `{"ok":true,"meta":{..}}` 또는 불변식 위반 `{"ok":false,"reason":".."}` — 위반이면 호출자가
    /// 그 기록을 `state` 로 바꾼다. 텍스트 연산이 아니면 `{"ok":true,"meta":null}`.
    pub fn measure(&self, phase: &str, method: &str, args: &[Value], before: &Value) -> Result<Value, HwpError> {
        let n = |i: usize| -> Result<usize, HwpError> {
            args.get(i).and_then(Value::as_u64).map(|v| v as usize).ok_or_else(|| bad_args(method, format!("인자 {i}")))
        };
        let text = |i: usize| -> Result<String, HwpError> {
            args.get(i).and_then(Value::as_str).map(str::to_string).ok_or_else(|| bad_args(method, format!("인자 {i}")))
        };
        let opts = || -> Result<Value, HwpError> {
            serde_json::from_str(args.first().and_then(Value::as_str).unwrap_or("{}")).map_err(|e| bad_args(method, e))
        };
        let body = |sec: usize, paras: &[usize]| -> Value {
            let lens: serde_json::Map<String, Value> =
                paras.iter().map(|&p| (p.to_string(), json!(self.para_len(sec, p)))).collect();
            json!({ "paraCount": self.para_count(sec), "lens": lens })
        };
        // R13: 셀 텍스트 연산(평면·경로·Ex·조판 미룸) — 칸 문단 수와 대상·앞 칸 문단 길이
        if !matches!(method, "deleteRangeInCell" | "deleteRangeInCellEx") {
            if let Some((space, cp)) = ot::cell_target(method, args) {
                return Ok(self.measure_cell(phase, method, args, before, &space, cp));
            }
        }
        let measured = match method {
            "insertText" | "deleteText" | "replaceBodyTextLocal" => body(n(0)?, &[n(1)?]),
            "insertTextLogical" => {
                let (sec, para) = (n(0)?, n(1)?);
                let mut v = body(sec, &[para]);
                if phase == "before" {
                    let (offset, after) = self.logical_to_text(sec, para, n(2)?)?;
                    v["offset"] = json!(offset);
                    v["afterControl"] = json!(after);
                }
                v
            }
            "splitParagraph" | "deleteRange" => body(n(0)?, &[]),
            "mergeParagraph" => body(n(0)?, &[n(1)?.saturating_sub(1)]),
            "deleteRangeInCell" => json!({ "cellParaCount": self.cell_para_count(n(0)?, n(1)?, n(2)?, n(3)?) }),
            "deleteRangeInCellEx" => {
                let o = opts()?;
                let g = |k: &str| o.get(k).and_then(Value::as_u64).unwrap_or(0) as usize;
                json!({ "cellParaCount": self.cell_para_count(g("sectionIdx"), g("parentParaIdx"), g("controlIdx"), g("cellIdx")) })
            }
            _ => return Ok(json!({ "ok": true, "meta": null })),
        };
        if phase == "before" {
            return Ok(measured);
        }
        // ── after: meta 와 불변식 ──
        let count = |v: &Value| v.get("paraCount").and_then(Value::as_u64).map(|c| c as i64);
        let len = |v: &Value, p: usize| v["lens"].get(p.to_string()).and_then(Value::as_u64).map(|c| c as i64);
        let fail = |reason: String| -> Result<Value, HwpError> { Ok(json!({ "ok": false, "reason": reason })) };
        let expect_paras = |want: i64| -> Option<String> {
            match (count(before), count(&measured)) {
                (Some(b), Some(a)) if a - b == want => None,
                (Some(b), Some(a)) => Some(format!("{method}: 문단 수 변화 {} (기대 {want})", a - b)),
                _ => Some(format!("{method}: 문단 수를 잴 수 없음")),
            }
        };
        let meta = match method {
            "insertText" | "insertTextLogical" => {
                if let Some(r) = expect_paras(0) {
                    return fail(r);
                }
                let para = n(1)?;
                let Some(grown) = len(before, para).zip(len(&measured, para)).map(|(b, a)| a - b).filter(|d| *d >= 0) else {
                    return fail(format!("{method}: 문단 길이가 줄었다"));
                };
                if method == "insertText" {
                    json!({ "len": grown })
                } else {
                    json!({ "offset": before["offset"], "afterControl": before["afterControl"], "len": grown })
                }
            }
            "deleteText" => {
                if let Some(r) = expect_paras(0) {
                    return fail(r);
                }
                let para = n(1)?;
                let Some(removed) = len(before, para).zip(len(&measured, para)).map(|(b, a)| b - a).filter(|d| *d >= 0) else {
                    return fail(format!("{method}: 문단 길이가 늘었다"));
                };
                json!({ "count": removed })
            }
            "replaceBodyTextLocal" => {
                if let Some(r) = expect_paras(0) {
                    return fail(r);
                }
                let para = n(1)?;
                let ins = text(4)?.chars().count() as i64;
                let Some(deleted) = len(before, para).zip(len(&measured, para)).map(|(b, a)| b + ins - a).filter(|d| *d >= 0) else {
                    return fail(format!("{method}: 삭제 수가 음수"));
                };
                json!({ "deleted": deleted, "insLen": ins })
            }
            "splitParagraph" => {
                if let Some(r) = expect_paras(1) {
                    return fail(r);
                }
                json!({})
            }
            "mergeParagraph" => {
                if let Some(r) = expect_paras(-1) {
                    return fail(r);
                }
                let para = n(1)?;
                match len(before, para.saturating_sub(1)) {
                    Some(prev) if para > 0 => json!({ "prevLen": prev }),
                    _ => return fail(format!("{method}: 앞 문단이 없음")),
                }
            }
            "deleteRange" => {
                let (sp, ep) = (n(1)? as i64, n(3)? as i64);
                if let Some(r) = expect_paras(-(ep - sp)) {
                    return fail(r);
                }
                json!({})
            }
            "deleteRangeInCell" | "deleteRangeInCellEx" => {
                let (sp, ep) = if method == "deleteRangeInCell" {
                    (n(4)? as i64, n(6)? as i64)
                } else {
                    let o = opts()?;
                    let g = |k: &str| o.get(k).and_then(Value::as_u64).unwrap_or(0) as i64;
                    (g("startCellParaIdx"), g("endCellParaIdx"))
                };
                let c = |v: &Value| v.get("cellParaCount").and_then(Value::as_u64).map(|x| x as i64);
                match (c(before), c(&measured)) {
                    (Some(b), Some(a)) if a - b == -(ep - sp) => json!({}),
                    _ => return fail(format!("{method}: 셀 문단 수 변화가 기대와 다름")),
                }
            }
            _ => unreachable!(),
        };
        Ok(json!({ "ok": true, "meta": meta }))
    }

    // ── 문서 지문 (1단계 T6) ─────────────────────────────────────────────

    /// 문서 모델의 지문(blake3, hex 64자). 사용자별 메타데이터(문서 속성의 캐럿 세 필드)는 뺀다.
    ///
    /// S3-0: DocInfo·구역 모델 지문에 **BinData 항목별 내용 해시**(id 순)를 더한다 — 그림·OLE·차트 바이트만
    /// 갈려도 잡힌다. 저장 표현이 아니라 압축을 푼 내용을 보며, 비용은 [`BinDigestCache`] 가 줄인다.
    /// `extra_streams`·`hwpx_aux_entries`(라운드트립 보존용 원본 조각)는 편집으로 바뀌지 않아 넣지 않는다.
    /// 5단계 D4: 스냅샷(`snapshot_id`) 뒤의 변경이 `kind`(`form`·`comment`·`form comment`)가 허용하는 부분뿐인가.
    /// `{"ok":true}` 또는 `{"ok":false,"reason":"confined","detail":".."}`.
    ///
    /// 스냅샷 뒤에 결과 적재(`state`)가 있었으면 지금 문서는 다른 객체가 내보낸 바이트를 다시 읽은 문서다. 내보내기 →
    /// 다시 읽기는 항등이 아니다: HWPX 목록 파일(`Contents/content.hpf`) 재작성, 파일 머리, 그리고 HWP 저장이 고치지 않은
    /// 구역은 원본 바이트를 그대로 쓰고 고친 구역은 모델에서 다시 쓰므로 그림 크기·문단 머리 꼬리·채우기 같은 직렬화 표현이
    /// 원본과 갈린다(실제 한/글 저장본에서 정상 메모가 거절됐다). 그래서 스냅샷 쪽을 보낸 쪽 내보내기와 같게 한 번 내보내
    /// 다시 읽고 비교한다(`reparsed_like_current`). 양쪽 모두 내보내기→다시 읽기 한 번이다 — 지금 문서를 한 번 더 거치면
    /// 큰 HWPX 문서에서 다시 갈린다(왕복이 멱등이 아님).
    pub fn check_confined(&mut self, snapshot_id: u32, kind: &str) -> Result<Value, HwpError> {
        let kinds = confine::Kinds::parse(kind).map_err(HwpError::RenderError)?;
        let loaded = self
            .snapshots
            .iter()
            .find(|(id, _)| *id == snapshot_id)
            .map(|(_, s)| s.state_loads != self.state_loads)
            .ok_or_else(|| HwpError::RenderError(format!("collab 스냅샷 {snapshot_id} 없음")))?;
        let verdict = if loaded {
            let before = self.reparsed_like_current(snapshot_id)?;
            confine::check(&before, &self.inner.document, kinds)
        } else {
            let (_, snap) = self.snapshots.iter().find(|(id, _)| *id == snapshot_id).expect("위에서 찾은 스냅샷");
            confine::check(&snap.document, &self.inner.document, kinds)
        };
        Ok(match verdict {
            Ok(()) => json!({ "ok": true }),
            Err(detail) => json!({ "ok": false, "reason": "confined", "detail": detail }),
        })
    }

    /// 스냅샷 문서를 지금 형식 계열로 내보내 다시 읽은 문서 — 보낸 쪽 내보내기를 흉내 낸다. 지금 문서의 구역 바이트(적재한
    /// 바이트 그대로)가 스냅샷의 원본 바이트와 같은 구역·DocInfo 는 보낸 쪽도 원본 바이트를 다시 쓴 것이므로 원본 바이트를
    /// 그대로 쓰고, 다른 것은 모델에서 쓴다. 지금 문서는 (원본 바이트 캐시까지) 그대로 돌려 놓는다.
    fn reparsed_like_current(&mut self, snapshot_id: u32) -> Result<Document, HwpError> {
        let sent: Vec<Option<Vec<u8>>> = self.inner.document.sections.iter().map(|s| s.raw_stream.clone()).collect();
        let sent_info = self.inner.document.doc_info.raw_stream.clone();
        let current = self.snapshot_save();
        let raw = self.snapshot_restore(snapshot_id).and_then(|()| {
            let doc = &mut self.inner.document;
            for (i, section) in doc.sections.iter_mut().enumerate() {
                if sent.get(i).map(Option::as_ref) != Some(section.raw_stream.as_ref()) {
                    section.raw_stream = None;
                }
            }
            if doc.doc_info.raw_stream != sent_info {
                doc.doc_info.raw_stream = None;
            }
            match self.inner.source_format {
                crate::parser::FileFormat::Hwpx => self.inner.export_hwpx_native(),
                _ => self.inner.export_hwp_native(),
            }
        });
        let back = self.snapshot_restore(current);
        self.snapshot_discard(current);
        back?;
        Ok(DocumentCore::from_bytes(&raw?)?.document)
    }

    /// 6단계 S1(docs/collab-stage6.md): 받은 결과(state) 바이트 C 를 "바뀐 부분만 모델에서 다시 쓴" 바이트 S 로 바꾼다.
    /// C·S 모두 `export_state` 와 같은 gzip 감싸기다. **정본(이 문서)은 바꾸지 않는다** — 부른 쪽이 S 를 `load_state` 로
    /// 읽는다(계보: 모두가 같은 바이트 S 를 읽는다).
    ///
    /// - 구역·DocInfo: C 를 읽은 모델의 원본 바이트가 정본의 지금 원본 바이트와 같으면 그 바이트를 그대로 쓰고, 다르면
    ///   캐시를 버려 모델에서 다시 쓴다 — 파서가 모델에 남기지 않는 레코드가 사라진다. 정본의 원본 바이트는 **봉인이 지금
    ///   모델과 맞을 때만**(저장기가 다시 쓰는 조건과 같다) 기준으로 삼는다: 연산으로 바뀐 구역의 낡은 바이트와 같다고 보지
    ///   않는다. 어느 쪽이든 S 의 내용은 C 의 모델이다.
    /// - 부속 스트림(`extra_streams`·HWPX 부속 항목)·미리보기·파일 머리·출처 표지는 정본의 지금 것을 쓴다. 저장기가 모델에서
    ///   다시 만드는 것(`/RhwpLineSegTags`, 테두리 칠 표지)은 저장할 때 새로 생긴다. 편집 기능 중 문서 객체의 부속 스트림을
    ///   바꾸는 것은 없다(내보낼 때 사본에 붙이는 계보 표지뿐).
    /// - 모델 안에 날 바이트로 보존되는 자리 중 두 곳(결정 (C))은 **정본 문서에 같은 내용으로 없던 것을 버린다** —
    ///   DocInfo 의 모르는 레코드(`extra_records`, [`keep_known_doc_info_records`])와 구역 끝 목록(`trailing_lists`,
    ///   [`keep_known_section_tails`]). 정상 기능이 여기에 새 내용을 만드는 길은 메모 모양(연산 — 정본이 먼저 적용해 같은
    ///   내용이 있다)과 저장기가 모델에서 만드는 메모 목록·확장 바탕쪽 목록뿐이고, 뒤의 둘은 버려도 모델에서 다시 쓴다.
    ///   그 밖의 날 바이트 자리(개체 `ctrl_data_records`, 스타일 `raw_data` 등)는 그대로 남는다(규약 문서의 알려진 한계).
    /// - BinData: 모델이 참조하는 것만 남긴다(업스트림 `prune_unreferenced_bin_data` — 참조 번호를 함께 옮긴다).
    /// - 형식: 정본의 형식 계열로 쓴다.
    pub fn rewrite_state(&self, state: &[u8]) -> Result<Vec<u8>, HwpError> {
        let raw = unpack_state(state)?;
        let mut tmp = DocumentCore::from_bytes(&raw)?;
        let canon = &self.inner.document;
        {
            let doc = &mut tmp.document;
            for (i, section) in doc.sections.iter_mut().enumerate() {
                let trusted = canon.sections.get(i).filter(|c| c.raw_provenance_permits_reuse()).and_then(|c| c.raw_stream.as_ref());
                if section.raw_stream.is_none() || section.raw_stream.as_ref() != trusted {
                    section.raw_stream = None;
                    section.raw_provenance = None;
                }
            }
            let trusted_info = if canon.doc_info.raw_provenance_permits_reuse(&canon.doc_properties) { canon.doc_info.raw_stream.as_ref() } else { None };
            if doc.doc_info.raw_stream.is_none() || doc.doc_info.raw_stream.as_ref() != trusted_info {
                doc.doc_info.raw_stream = None;
                doc.doc_info.raw_provenance = None;
            }
            doc.extra_streams = canon.extra_streams.clone();
            doc.hwpx_aux_entries = canon.hwpx_aux_entries.clone();
            doc.preview = canon.preview.clone();
            doc.header = canon.header.clone();
            doc.is_hwp3_variant = canon.is_hwp3_variant;
            doc.is_hwpx_variant = canon.is_hwpx_variant;
            doc.provenance = canon.provenance.clone();
            keep_known_doc_info_records(doc, canon);
            keep_known_section_tails(doc, canon);
            crate::document_core::prune_unreferenced_bin_data(doc);
        }
        tmp.source_format = self.inner.source_format;
        let out = match tmp.source_format {
            crate::parser::FileFormat::Hwpx => tmp.export_hwpx_native()?,
            _ => tmp.export_hwp_native()?,
        };
        pack_state(&out)
    }

    /// 6단계 S2(docs/collab-stage6.md): 방을 열 때 왕복 점검. rhwp 는 저장할 때 손대지 않은 부분의 원본 바이트를 그대로
    /// 써서 "저장 후 비교"는 rhwp 가 모르는 기능이 있어도 통과한다. 그 부분을 편집하면 모델에서 다시 쓰므로, **원본 바이트
    /// 캐시를 모두 버리고 모델에서만 쓴 결과**를 지금 문서의 저장본(원본)과 견준다. 이 문서는 바꾸지 않는다.
    ///
    /// 결과 `{ok, lost: [{kind, count, detail}], irDiff}` — `kind`:
    /// - `ir`: 다시 읽은 모델의 차이(업스트림 저장 자기검증 `diff_exported_hwp(x)_documents` — 저장기가 다시 만드는 줄
    ///   캐시는 빼고 견준다). `count` = `irDiff`, `detail` = 앞의 몇 건.
    /// - `record`(HWP): 스트림(DocInfo·구역)마다 레코드 태그 멀티셋에서 사라진 레코드 — 파서가 모델에 남기지 않는 레코드.
    ///   `detail` = 태그별 개수.
    /// - `bindata`: 그림·첨부 데이터의 내용 멀티셋에서 사라진 것(HWP 는 업스트림 `hwp5_roundtrip_batch` 의 검사).
    /// - `ole-clsid`(HWP): BinData 안 OLE 개체의 루트 CLSID 가 사라진 것(같은 검사 — 한컴이 개체를 알아보지 못한다).
    /// - `cfb`(HWP): 저장본 CFB 구조(필수 스트림·구역 수). `package`(HWPX): 패키지 구조(업스트림 `check_package`).
    ///
    /// 버리는 캐시(HWP): 구역·DocInfo 원본 바이트와 그 봉인, DocInfo 항목별 원본 레코드(`raw_data`), 문서 속성 원본.
    /// 모델 안의 날 바이트 자리(개체 `ctrl_data_records` 등 — 편집해도 남는다)는 모델의 일부로 둔다. HWPX 저장기는 원본
    /// 캐시 없이 늘 모델(과 원문 조각)에서 쓰므로 그대로 저장한다.
    pub fn roundtrip_check(&self) -> Result<Value, HwpError> {
        use crate::diagnostics::hwp5_roundtrip_batch::{bindata_fingerprint, cfb_structure_ok, multiset_lost, nested_ole_clsid_fingerprint};
        let hwpx = matches!(self.inner.source_format, crate::parser::FileFormat::Hwpx);
        let export = |core: &DocumentCore| if hwpx { core.export_hwpx_native() } else { core.export_hwp_native() };
        let orig = export(&self.inner)?;
        let mut tmp = DocumentCore::from_bytes(&orig)?;
        let before = tmp.document.clone();
        if !hwpx {
            strip_raw_caches(&mut tmp.document);
        }
        let out = export(&tmp)?;
        let after = DocumentCore::from_bytes(&out)?.document;
        let mut lost: Vec<Value> = Vec::new();
        let mut push = |kind: &str, count: usize, detail: String| {
            if count > 0 {
                lost.push(if detail.is_empty() { json!({ "kind": kind, "count": count }) } else { json!({ "kind": kind, "count": count, "detail": detail }) });
            }
        };
        let diff = if hwpx {
            crate::serializer::hwpx::roundtrip::diff_exported_hwpx_documents(&before, &after)
        } else {
            crate::serializer::hwpx::roundtrip::diff_exported_hwp_documents(&before, &after)
        };
        let ir_diff = diff.differences.len();
        push("ir", ir_diff, summarize(diff.differences.iter().map(|d| d.to_string()), 3));
        if hwpx {
            let contents = |d: &Document| {
                let mut m: std::collections::BTreeMap<u64, usize> = std::collections::BTreeMap::new();
                for c in &d.bin_data_content {
                    *m.entry(bytes_hash(&c.data.load_shared())).or_default() += 1;
                }
                m
            };
            let (a, b) = (contents(&before), contents(&after));
            let n = multiset_lost(&a, &b);
            push("bindata", n, format!("{n}/{}", a.values().sum::<usize>()));
            let pkg = crate::serializer::hwpx::package_check::check_package(&out, &before);
            push("package", pkg.problems.len(), summarize(pkg.problems.iter().cloned(), 3));
        } else {
            let (records, detail) = lost_records(&before, &after);
            push("record", records, detail);
            if let (Some(a), Some(b)) = (bindata_fingerprint(&orig), bindata_fingerprint(&out)) {
                let n = multiset_lost(&a, &b);
                push("bindata", n, format!("{n}/{}", a.values().sum::<usize>()));
            }
            if let (Some(a), Some(b)) = (nested_ole_clsid_fingerprint(&orig), nested_ole_clsid_fingerprint(&out)) {
                let n = multiset_lost(&a, &b);
                push("ole-clsid", n, format!("{n}/{}", a.values().sum::<usize>()));
            }
            let (ok, problems) = cfb_structure_ok(&out, before.sections.len());
            if !ok {
                push("cfb", 1, problems);
            }
        }
        Ok(json!({ "ok": lost.is_empty(), "lost": lost, "irDiff": ir_diff }))
    }

    /// 5단계 D4 클라이언트 문: 글자 연산 호출(`method`·`args`, 호출 전)이 활성 누름틀(`active_field`) 안에 완전히 드는가.
    /// `insertTextLogical` 은 논리 오프셋을 텍스트 좌표로 바꿔 본다.
    pub fn field_contains_call(&self, method: &str, args: &[Value], active_field: &Value) -> Result<bool, HwpError> {
        if active_field.is_null() {
            return Ok(false);
        }
        let mut rec = json!({ "kind": "op", "m": method, "a": args });
        if method == "insertTextLogical" {
            let n = |i: usize| args.get(i).and_then(Value::as_u64).map(|v| v as usize).ok_or_else(|| bad_args(method, format!("인자 {i}")));
            let (off, after) = self.logical_to_text(n(0)?, n(1)?, n(2)?)?;
            let len = args.get(3).and_then(Value::as_str).map(|t| t.chars().count()).unwrap_or(0);
            rec["meta"] = json!({ "offset": off, "afterControl": after, "len": len });
        }
        Ok(match ot::parse_text(&rec) {
            Some(op) => confine::field_contains(self, &op, active_field),
            None => false,
        })
    }

    pub fn digest(&self) -> String {
        let doc = &self.inner.document;
        let mut props = doc.doc_properties.clone();
        props.caret_list_id = 0;
        props.caret_para_id = 0;
        props.caret_char_pos = 0;
        // S3-3: 원본 레코드 사본(`raw_data`)의 같은 세 필드(offset 14..26, serializer/doc_info.rs)도 지운다 — 내보낼
        // 때 캐럿이 실려 다시 읽은 쪽만 값이 달라진다(체크포인트·welcome 경로의 거짓 어긋남).
        if let Some(raw) = props.raw_data.as_mut() {
            if raw.len() >= 26 {
                raw[14..26].fill(0);
            }
        }
        let mut parts = Vec::with_capacity(32 * (1 + doc.sections.len()) + 34 * doc.bin_data_content.len() + 16);
        parts.extend_from_slice(&doc_info_model_digest(&doc.doc_info, &props));
        for section in &doc.sections {
            parts.extend_from_slice(&section_model_digest(section));
        }
        let bins = self.bin_data_hashes();
        parts.extend_from_slice(b"bindata");
        parts.extend_from_slice(&(bins.len() as u32).to_le_bytes());
        for (id, hash) in bins {
            parts.extend_from_slice(&id.to_le_bytes());
            parts.extend_from_slice(&hash);
        }
        bytes_digest(&parts).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// BinData 항목별 `(id, 내용 해시)`, id 순.
    pub(crate) fn bin_data_hashes(&self) -> Vec<(u16, [u8; 32])> {
        let contents = &self.inner.document.bin_data_content;
        let mut order: Vec<usize> = (0..contents.len()).collect();
        order.sort_by_key(|&i| contents[i].id);
        let mut cache = self.bin_digest.lock().unwrap_or_else(|e| e.into_inner());
        let epoch = self.inner.bin_data_epoch;
        order.into_iter().map(|i| (contents[i].id, cache.item(epoch, &contents[i]))).collect()
    }

    /// S3-0 시험용: 저장 표현이 있는 BinData 의 내용을 실제로 꺼낸 누적 횟수.
    pub fn bin_digest_content_loads(&self) -> u64 {
        self.bin_digest.lock().unwrap_or_else(|e| e.into_inner()).content_loads
    }
}

fn parse_active_field(value: &Value) -> Result<Option<ActiveFieldInfo>, HwpError> {
    if value.is_null() {
        return Ok(None);
    }
    let g = |k: &str| {
        value
            .get(k)
            .and_then(Value::as_u64)
            .map(|v| v as usize)
            .ok_or_else(|| HwpError::RenderError(format!("activeField.{k} 가 없음")))
    };
    let cell_path = match value.get("cellPath") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .map(|t| {
                    let a = t
                        .as_array()
                        .filter(|a| a.len() == 3)
                        .ok_or_else(|| HwpError::RenderError("cellPath 항목".into()))?;
                    let u = |i: usize| a[i].as_u64().map(|v| v as usize).ok_or_else(|| HwpError::RenderError("cellPath 값".into()));
                    Ok((u(0)?, u(1)?, u(2)?))
                })
                .collect::<Result<Vec<_>, HwpError>>()?,
        ),
        Some(_) => return Err(HwpError::RenderError("cellPath 형식".into())),
    };
    Ok(Some(ActiveFieldInfo { section_idx: g("section")?, para_idx: g("para")?, control_idx: g("control")?, cell_path }))
}

impl From<DocumentCore> for CollabCore {
    fn from(inner: DocumentCore) -> Self {
        Self::new(inner)
    }
}

impl Deref for CollabCore {
    type Target = DocumentCore;
    fn deref(&self) -> &DocumentCore {
        &self.inner
    }
}

impl DerefMut for CollabCore {
    fn deref_mut(&mut self) -> &mut DocumentCore {
        &mut self.inner
    }
}
