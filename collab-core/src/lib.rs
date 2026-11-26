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

use std::collections::HashSet;
use std::ops::{Deref, DerefMut};

use serde_json::{json, Value};

use crate::document_core::{ActiveFieldInfo, DocumentCore};
use crate::error::HwpError;
use crate::model::document::Document;
use crate::model::raw_provenance::{bytes_digest, doc_info_model_digest, section_model_digest};
use crate::renderer::render_normalization::RenderPath;

#[path = "ot.rs"]
pub mod ot;

#[cfg(feature = "wasm-api")]
#[path = "wasm.rs"]
mod wasm;

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
}

/// 실제 `DocumentCore` 를 감싸 공동편집 보조 기능을 더하는 래퍼.
pub struct CollabCore {
    inner: DocumentCore,
    snapshots: Vec<(u32, Snapshot)>,
    next_snapshot_id: u32,
    /// 재생 때 잠시 바꾼 내부 클립보드를 되돌려 놓을 자리(R13 ctx.clipboard).
    clipboard_stash: Vec<(Option<crate::document_core::ClipboardData>, u32)>,
}

/// `measure` 인자 오류.
fn bad_args(method: &str, detail: impl std::fmt::Display) -> HwpError {
    HwpError::RenderError(format!("collab measure {method}: {detail}"))
}

impl CollabCore {
    pub fn new(inner: DocumentCore) -> Self {
        Self { inner, snapshots: Vec::new(), next_snapshot_id: 1, clipboard_stash: Vec::new() }
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
    pub fn digest(&self) -> String {
        let doc = &self.inner.document;
        let mut props = doc.doc_properties.clone();
        props.caret_list_id = 0;
        props.caret_para_id = 0;
        props.caret_char_pos = 0;
        let mut parts = Vec::with_capacity(32 * (1 + doc.sections.len()));
        parts.extend_from_slice(&doc_info_model_digest(&doc.doc_info, &props));
        for section in &doc.sections {
            parts.extend_from_slice(&section_model_digest(section));
        }
        bytes_digest(&parts).iter().map(|b| format!("{b:02x}")).collect()
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
