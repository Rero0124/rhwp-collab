//! 5단계 D4: 좁은 권한(`form`·`comment`) 편집의 결과 판정과 누름틀 범위 판정.
//!
//! 서버 정본은 좁은 권한 연결의 묶음을 스냅샷 뒤 적용해 보고, **바뀐 곳이 허용된 부분뿐인지**를 결과로 판정한다
//! (함수 이름·state 바이트를 믿지 않는다 — `check`). 방법: 앞뒤 문서의 사본에 "가리기 변환"을 한 뒤 기존 모델
//! 다이제스트로 비교한다. 다이제스트가 문서의 모든 그릇(본문·표 칸·머리말·꼬리말·각주·미주·글상자·캡션·숨은 설명·
//! 필드 안…)을 직렬화하므로 덮는 범위가 다이제스트와 같다. 가리기 변환이 어떤 그릇을 놓치면 그 그릇의 허용된 변경이
//! 가려지지 않아 **거절**로 떨어진다(실패가 안전 쪽 — 구멍이 아니다).
//!
//! - `comment`: 메모 필드(컨트롤·범위·본문·번호)를 빼고(개체 위치를 먼저 잰 뒤 빼고 흐름 좌표를 다시 짠다 —
//!   업스트림 `drop_memo_fields` 는 컨트롤을 뺀 뒤 옛 흐름 좌표로 위치를 재서, 같은 틈의 다른 개체가 자리를 옮긴다).
//!   메모 모양(DocInfo 목록·구역의 메모 모양 번호)은 다른 사람 메모의 겉모습까지 바꾸는 문서 설정이라 `edit` 몫이다 —
//!   그대로여야 한다(메모 넣기는 모양을 읽기만 한다).
//! - `form`: 누름틀(ClickHere) 안 글자를 지우고(`delete_text_at` — 범위·글자 모양·흐름 좌표가 함께 맞는다),
//!   누름틀의 "채워짐" 비트(15)와 양식 개체의 값(`value`·`text`)을 가린다. 누름틀의 개수·이름·명령·그 밖의
//!   속성은 그대로여야 한다(구조 변경은 `edit`).
//! - 둘 다: 조판 결과(`line_segs`·`layout_*`)와 파생 값(`char_count`·`control_mask`)은 비교하지 않고, 흐름 좌표
//!   (`char_offsets` 와 같은 좌표를 쓰는 글자 모양·영역 태그 등)는 개체 위치로 다시 짠 정규형으로 비교한다.
//!   DocInfo 목록은 앞부분이 같아야 한다(덧붙이기만 허용), 그 밖의 DocInfo·문서 속성(캐럿 제외)·BinData·
//!   부속 스트림은 같아야 한다.

use std::sync::Arc;

use serde::Serialize;

use crate::model::bin_data::{BinDataBytes, BinDataContent};
use crate::model::control::{Control, FieldType};
use crate::model::document::{Document, Section};
use crate::model::paragraph::Paragraph;
use crate::model::raw_provenance::{bytes_digest, record_digest, section_model_digest};
use crate::model::shape::ShapeObject;
use crate::parser::tags::HWPTAG_MEMO_SHAPE;

/// 판정할 권한(목록이라 함께 가질 수 있다).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Kinds {
    pub form: bool,
    pub comment: bool,
}

impl Kinds {
    /// `"form"`·`"comment"`·`"form comment"`(공백 구분).
    pub fn parse(s: &str) -> Result<Kinds, String> {
        let mut k = Kinds::default();
        for w in s.split_whitespace() {
            match w {
                "form" => k.form = true,
                "comment" => k.comment = true,
                other => return Err(format!("알 수 없는 권한: {other}")),
            }
        }
        if !k.form && !k.comment {
            return Err("권한이 비어 있음".into());
        }
        Ok(k)
    }
}

/// `before`(스냅샷) → `after`(적용 뒤)의 변경이 `kinds` 가 허용하는 부분뿐인가. 아니면 어디가 다른지.
pub fn check(before: &Document, after: &Document, kinds: Kinds) -> Result<(), String> {
    // 문서 필드를 빠짐없이 나열한다(`..` 없음) — 업스트림이 필드를 더하면 여기가 컴파일 오류로 판단을 강제한다.
    let Document {
        header: header_a,
        doc_properties: props_a,
        doc_info: info_a,
        sections: sections_a,
        preview: _,
        bin_data_content: bins_a,
        extra_streams: streams_a,
        hwpx_aux_entries: aux_a,
        is_hwp3_variant: hwp3_a,
        is_hwpx_variant: hwpx_a,
        provenance: _,
        memo_parents: memo_parents_a,
    } = before;
    let b = after;
    if format!("{header_a:?}") != format!("{:?}", b.header) {
        return Err("파일 머리가 다름".into());
    }
    if let Some(name) = stream_difference(streams_a, &b.extra_streams).or_else(|| stream_difference(aux_a, &b.hwpx_aux_entries)) {
        return Err(format!("부속 스트림이 다름 ({name})"));
    }
    if *hwp3_a != b.is_hwp3_variant || *hwpx_a != b.is_hwpx_variant {
        return Err("파일 형식 표지가 다름".into());
    }
    if !kinds.comment && memo_parents_a != &b.memo_parents {
        return Err("메모 답글 관계가 다름".into());
    }
    if props_digest(props_a) != props_digest(&b.doc_properties) {
        return Err("문서 속성이 다름".into());
    }
    check_doc_info(info_a, &b.doc_info)?;
    check_bins(bins_a, &b.bin_data_content)?;
    if sections_a.len() != b.sections.len() {
        return Err(format!("구역 수가 다름 ({} → {})", sections_a.len(), b.sections.len()));
    }
    for (i, (sa, sb)) in sections_a.iter().zip(&b.sections).enumerate() {
        let (mut ma, mut mb) = (sa.clone(), sb.clone());
        mask_section(&mut ma, kinds);
        mask_section(&mut mb, kinds);
        if section_model_digest(&ma) == section_model_digest(&mb) {
            continue;
        }
        return Err(where_differs(i, &ma, &mb));
    }
    Ok(())
}

/// 다른 곳을 좁혀 사유로 쓴다(구역 정의 / 문단 수 / 문단 i / 구역 꼬리).
fn where_differs(i: usize, a: &Section, b: &Section) -> String {
    if record_digest(&a.section_def) != record_digest(&b.section_def) {
        return format!("구역 {i} 의 구역 정의가 다름");
    }
    if a.paragraphs.len() != b.paragraphs.len() {
        return format!("구역 {i} 의 문단 수가 다름 ({} → {})", a.paragraphs.len(), b.paragraphs.len());
    }
    for (p, (pa, pb)) in a.paragraphs.iter().zip(&b.paragraphs).enumerate() {
        if record_digest(pa) != record_digest(pb) {
            return format!("구역 {i} 문단 {p}(또는 그 안의 표·글상자·머리말·각주 등)가 허용되지 않은 부분에서 다름");
        }
    }
    format!("구역 {i} 의 꼬리 기록이 다름")
}

/// 비교에서 빼는 부속 스트림 — 직렬화기가 저장할 때마다 다시 쓰는 파생값이고 문서 내용이 아니다.
///
/// `/RhwpLineSegTags`(업스트림 `model/line_seg_tags.rs`): rhwp 가 쓴 구역 레코드 바이트의 SHA-256 목록. HWP 저장
/// (`serializer/cfb_writer.rs`)이 매번 기존 것을 지우고 그때 쓴 구역 바이트로 다시 만든다. 결과 전송(state)은 사본을
/// 내보낸 바이트라 구역 바이트가 조금이라도 바뀌면(메모 넣기, 누름틀 값) 이 목록도 바뀐다 — 같은 문서 객체에서 고친
/// 정본은 아직 저장 전이라 옛 목록을 들고 있다. 읽는 쪽은 저장 줄 정보(`line_segs`) 비트 31 의 해석과 줄 캐시 소유
/// 판정뿐이고, 줄 정보는 이 판정이 이미 비교에서 뺀다(가리기). 다른 스트림(스크립트·연결 문서 등)은 그대로 비교한다.
const DERIVED_STREAMS: &[&str] = &[crate::model::line_seg_tags::HWP_STREAM];

/// 두 스트림 목록이 파생 스트림을 빼고 다르면 처음 다른 스트림 이름(경로 순). 순서는 보지 않는다 — 다시 읽으면 복합
/// 파일 디렉터리 순서(이름 길이 먼저)로 온다. 같은 경로가 두 번 있으면 그 경로를 다르다고 본다.
fn stream_difference<'a>(a: &'a [(String, Vec<u8>)], b: &'a [(String, Vec<u8>)]) -> Option<&'a str> {
    use std::collections::BTreeMap;
    let content = |s: &'a [(String, Vec<u8>)]| -> Result<BTreeMap<&'a str, &'a [u8]>, &'a str> {
        let mut out = BTreeMap::new();
        for (path, bytes) in s.iter().filter(|(path, _)| !DERIVED_STREAMS.contains(&path.as_str())) {
            if out.insert(path.as_str(), bytes.as_slice()).is_some() {
                return Err(path.as_str());
            }
        }
        Ok(out)
    };
    let (ca, cb) = match (content(a), content(b)) {
        (Err(dup), _) | (_, Err(dup)) => return Some(dup),
        (Ok(x), Ok(y)) => (x, y),
    };
    ca.keys().chain(cb.keys()).copied().collect::<std::collections::BTreeSet<_>>().into_iter().find(|k| ca.get(k) != cb.get(k))
}

fn props_digest(p: &crate::model::document::DocProperties) -> [u8; 32] {
    // 디지스트(`CollabCore::digest`)와 같이 캐럿을 지운다.
    let mut props = p.clone();
    props.caret_list_id = 0;
    props.caret_para_id = 0;
    props.caret_char_pos = 0;
    if let Some(raw) = props.raw_data.as_mut() {
        if raw.len() >= 26 {
            raw[14..26].fill(0);
        }
    }
    record_digest(&props)
}

/// 목록 `b` 의 앞부분이 `a` 와 같은가(덧붙이기만 허용).
fn prefix_eq<T: Serialize>(a: &[T], b: &[T]) -> bool {
    b.len() >= a.len() && a.iter().zip(b).all(|(x, y)| record_digest(x) == record_digest(y))
}

fn check_doc_info(a: &crate::model::document::DocInfo, b: &crate::model::document::DocInfo) -> Result<(), String> {
    let crate::model::document::DocInfo {
        bin_data_list,
        font_faces,
        border_fills,
        char_shapes,
        tab_defs,
        numberings,
        bullets,
        para_shapes,
        styles,
        extra_records,
        print_method: _,
        raw_stream: _,
        bullet_count,
        memo_shape_count,
        memo_properties_xml,
        distribute_doc_data_removed: _,
        raw_stream_dirty: _,
        hwpx_head_tail,
        hwpml_version,
        raw_provenance: _,
    } = a;
    let lists: [(&str, bool); 8] = [
        ("bin_data_list", prefix_eq(bin_data_list, &b.bin_data_list)),
        ("border_fills", prefix_eq(border_fills, &b.border_fills)),
        ("char_shapes", prefix_eq(char_shapes, &b.char_shapes)),
        ("tab_defs", prefix_eq(tab_defs, &b.tab_defs)),
        ("numberings", prefix_eq(numberings, &b.numberings)),
        ("bullets", prefix_eq(bullets, &b.bullets)),
        ("para_shapes", prefix_eq(para_shapes, &b.para_shapes)),
        ("styles", prefix_eq(styles, &b.styles)),
    ];
    if let Some((name, _)) = lists.iter().find(|(_, ok)| !ok) {
        return Err(format!("DocInfo {name} 의 기존 항목이 바뀜(덧붙이기만 허용)"));
    }
    if font_faces.len() != b.font_faces.len() || font_faces.iter().zip(&b.font_faces).any(|(x, y)| !prefix_eq(x, y)) {
        return Err("DocInfo font_faces 의 기존 항목이 바뀜(덧붙이기만 허용)".into());
    }
    // 기타 레코드: 메모 모양을 뺀 나머지는 같아야 한다(메모 모양은 따로 보아 사유를 가른다).
    let not_memo_shape = |r: &&crate::model::document::RawRecord| r.tag_id != HWPTAG_MEMO_SHAPE;
    let rest_a: Vec<_> = extra_records.iter().filter(not_memo_shape).collect();
    let rest_b: Vec<_> = b.extra_records.iter().filter(not_memo_shape).collect();
    if rest_a.len() != rest_b.len() || rest_a.iter().zip(&rest_b).any(|(x, y)| record_digest(*x) != record_digest(*y)) {
        return Err("DocInfo 기타 레코드가 바뀜".into());
    }
    // 메모 모양: 다른 사람 메모의 겉모습까지 바꾸는 문서 설정 — 어느 좁은 권한에서도 그대로여야 한다(`edit` 몫)
    let shapes_a: Vec<_> = extra_records.iter().filter(|r| r.tag_id == HWPTAG_MEMO_SHAPE).collect();
    let shapes_b: Vec<_> = b.extra_records.iter().filter(|r| r.tag_id == HWPTAG_MEMO_SHAPE).collect();
    if shapes_a.len() != shapes_b.len()
        || shapes_a.iter().zip(&shapes_b).any(|(x, y)| record_digest(*x) != record_digest(*y))
        || *memo_shape_count != b.memo_shape_count
        || memo_properties_xml != &b.memo_properties_xml
    {
        return Err("메모 모양이 바뀜".into());
    }
    if *bullet_count != b.bullet_count || hwpx_head_tail != &b.hwpx_head_tail || hwpml_version != &b.hwpml_version {
        return Err("DocInfo 속성이 바뀜".into());
    }
    Ok(())
}

/// BinData 는 같아야 한다(좁은 권한은 그림을 넣거나 바꾸지 않는다). 압축을 풀지 않고 같은 저장 값이면 같다고 본다.
fn check_bins(a: &[BinDataContent], b: &[BinDataContent]) -> Result<(), String> {
    if a.len() != b.len() {
        return Err("BinData 항목 수가 다름".into());
    }
    for (x, y) in a.iter().zip(b) {
        let same = x.id == y.id
            && x.extension == y.extension
            && match (&x.data, &y.data) {
                (BinDataBytes::Loaded(p), BinDataBytes::Loaded(q)) => p == q,
                (BinDataBytes::Lazy { resolver: r1, key: k1 }, BinDataBytes::Lazy { resolver: r2, key: k2 })
                    if k1 == k2 && std::ptr::addr_eq(Arc::as_ptr(r1), Arc::as_ptr(r2)) =>
                {
                    true
                }
                _ => bytes_digest(&x.data.load_shared()) == bytes_digest(&y.data.load_shared()),
            };
        if !same {
            return Err(format!("BinData {} 가 다름", x.id));
        }
    }
    Ok(())
}

// ── 가리기 변환 ─────────────────────────────────────────────────────────────

fn mask_section(s: &mut Section, kinds: Kinds) {
    if kinds.comment {
        // HWP5 마지막 구역 꼬리의 메모 본문 기록 묶음(모델에서는 메모 필드의 본문)
        if let Some(tail) = s.trailing_lists.as_mut() {
            let kept: Vec<_> = tail.record_groups().filter(|(memo, _)| !memo).flat_map(|(_, recs)| recs.to_vec()).collect();
            tail.records = kept;
        }
        // 메모만 있던 꼬리를 비우면 꼬리가 없는 것과 같다 — 메모 없던 문서에 결과 전송으로 첫 메모가 오면 다시 읽은
        // 쪽에만 꼬리가 생긴다(같은 객체에서 고친 쪽은 저장 전이라 꼬리가 없다)
        if s.trailing_lists.as_ref().is_some_and(|t| t.records.is_empty()) {
            s.trailing_lists = None;
        }
    }
    for page in &mut s.section_def.master_pages {
        mask_paragraphs(&mut page.paragraphs, kinds);
    }
    mask_paragraphs(&mut s.paragraphs, kinds);
}

/// 문단 목록 하나(와 그 안의 모든 그릇)를 가린다.
fn mask_paragraphs(paras: &mut Vec<Paragraph>, kinds: Kinds) {
    for p in paras.iter_mut() {
        if kinds.comment {
            drop_memos(p);
        }
        if kinds.form {
            mask_form(p);
        }
        // 흐름 좌표 정규형: 같은 글자·같은 개체 위치면 같은 값(틈 배치 차이를 지운다)
        let positions = p.control_text_positions();
        p.rebuild_char_offsets(&positions);
        // 조판 결과와 파생 값
        p.line_segs.clear();
        p.layout_space_metrics.clear();
        p.layout_field_values.clear();
        p.layout_object_projection = false;
        p.layout_float_band = false;
        p.char_count = 0;
        p.control_mask = 0;
        // 개체별 CTRL_DATA: 모두 비었으면 목록이 없는 것과 같다(HWPX 출처는 빈 목록, 개체를 넣고 빼면 빈 칸으로 채워진다)
        if p.ctrl_data_records.iter().all(Option::is_none) {
            p.ctrl_data_records.clear();
        }
        // 문단 머리 꼬리: [0..6] 은 글자 모양·영역 태그·줄 수 자리(저장기가 실제 배열로 다시 쓰고 이 자리는 쓰지 않는다)
        for b in p.raw_header_extra.iter_mut().take(6) {
            *b = 0;
        }
        // [6..10] 은 문단 instanceId — HWPX 저장이 문단마다 번호를 다시 매기므로 메모 문단이 생기면 뒤 문단 번호가 밀린다.
        // 메모 권한에서만 가린다(그 뒤의 변경 추적 꼬리는 그대로 비교)
        if kinds.comment {
            for b in p.raw_header_extra.iter_mut().skip(6).take(4) {
                *b = 0;
            }
        }
        for ctrl in &mut p.controls {
            mask_control(ctrl, kinds);
        }
    }
}

fn mask_control(ctrl: &mut Control, kinds: Kinds) {
    match ctrl {
        Control::Table(t) => {
            for cell in &mut t.cells {
                mask_paragraphs(&mut cell.paragraphs, kinds);
            }
            if let Some(c) = t.caption.as_mut() {
                mask_paragraphs(&mut c.paragraphs, kinds);
            }
        }
        Control::Shape(sh) => mask_shape(sh, kinds),
        Control::Picture(pic) => {
            if let Some(c) = pic.caption.as_mut() {
                mask_paragraphs(&mut c.paragraphs, kinds);
            }
        }
        Control::Header(h) => mask_paragraphs(&mut h.paragraphs, kinds),
        Control::Footer(f) => mask_paragraphs(&mut f.paragraphs, kinds),
        Control::Footnote(n) => mask_paragraphs(&mut n.paragraphs, kinds),
        Control::Endnote(n) => mask_paragraphs(&mut n.paragraphs, kinds),
        Control::HiddenComment(h) => mask_paragraphs(&mut h.paragraphs, kinds),
        Control::SectionDef(def) => {
            for page in &mut def.master_pages {
                mask_paragraphs(&mut page.paragraphs, kinds);
            }
        }
        Control::Field(f) => mask_paragraphs(&mut f.memo_paragraphs, kinds),
        _ => {}
    }
}

fn mask_shape(sh: &mut ShapeObject, kinds: Kinds) {
    if let Some(d) = sh.drawing_mut() {
        if let Some(tb) = d.text_box.as_mut() {
            mask_paragraphs(&mut tb.paragraphs, kinds);
        }
        if let Some(c) = d.caption.as_mut() {
            mask_paragraphs(&mut c.paragraphs, kinds);
        }
    }
    match sh {
        ShapeObject::Group(g) => {
            for child in &mut g.children {
                mask_shape(child, kinds);
            }
            if let Some(c) = g.caption.as_mut() {
                mask_paragraphs(&mut c.paragraphs, kinds);
            }
        }
        ShapeObject::Picture(p) => {
            if let Some(c) = p.caption.as_mut() {
                mask_paragraphs(&mut c.paragraphs, kinds);
            }
        }
        _ => {}
    }
}

/// 메모 필드를 뺀다. 개체 위치는 메모가 있는 채로 잰다(흐름 좌표와 개체 목록이 맞는 상태).
fn drop_memos(p: &mut Paragraph) {
    let is_memo = |c: &Control| matches!(c, Control::Field(f) if crate::document_core::queries::memo_query::is_memo_field(f));
    if !p.controls.iter().any(is_memo) {
        return;
    }
    let positions = p.control_text_positions();
    let old_controls = std::mem::take(&mut p.controls);
    let old_records = std::mem::take(&mut p.ctrl_data_records);
    let mut index_map = vec![None; old_controls.len()];
    let mut kept_positions = Vec::new();
    let mut memo_slots = Vec::new();
    for (i, c) in old_controls.into_iter().enumerate() {
        if is_memo(&c) {
            memo_slots.push(i);
            continue;
        }
        index_map[i] = Some(p.controls.len());
        kept_positions.push(positions.get(i).copied().unwrap_or(0));
        p.controls.push(c);
        p.ctrl_data_records.push(old_records.get(i).cloned().flatten());
    }
    p.field_ranges = std::mem::take(&mut p.field_ranges)
        .into_iter()
        .filter_map(|mut r| {
            // 누름틀 안(시작 개체 뒤 `inner_slot_count` 개 슬롯)에 있던 메모 개체만큼 줄인다 — 다시 읽은 쪽은 메모 시작을
            // 안쪽 슬롯으로 세고, 같은 객체에서 넣은 쪽은 세지 않는다. 남은 개체가 필드 안·밖에 있는지는 그대로 비교된다.
            let inside = memo_slots.iter().filter(|&&i| r.control_idx < i && i <= r.control_idx + r.inner_slot_count).count();
            r.inner_slot_count -= inside;
            r.control_idx = index_map.get(r.control_idx).copied().flatten()?;
            Some(r)
        })
        .collect();
    p.rebuild_char_offsets(&kept_positions);
}

/// 양식 권한이 바꿀 수 있는 것: 누름틀 안 글자(지움), 누름틀의 채워짐 비트, 양식 개체의 값.
fn mask_form(p: &mut Paragraph) {
    let mut interiors: Vec<(usize, usize)> = p
        .field_ranges
        .iter()
        .filter(|r| matches!(p.controls.get(r.control_idx), Some(Control::Field(f)) if f.field_type == FieldType::ClickHere))
        .map(|r| (r.start_char_idx, r.end_char_idx))
        .filter(|(s, e)| e > s)
        .collect();
    interiors.sort_by(|a, b| b.0.cmp(&a.0));
    for (s, e) in interiors {
        p.delete_text_at(s, e - s);
    }
    for ctrl in &mut p.controls {
        match ctrl {
            Control::Field(f) if f.field_type == FieldType::ClickHere => f.properties &= !(1 << 15),
            Control::Form(f) => {
                f.value = 0;
                f.text.clear();
            }
            _ => {}
        }
    }
}

// ── 누름틀 범위 판정 (클라이언트 문) ─────────────────────────────────────────

/// 글자 연산(`op`, 텍스트 좌표로 바꾼 것)이 활성 누름틀(`af` = `{section, para, control, cellPath}`)의 범위 안에
/// 완전히 드는가. 문단을 나누거나 합치거나 여러 문단에 걸치는 연산, 개체까지 지우는 연산은 아니다.
pub fn field_contains(doc: &super::CollabCore, op: &super::ot::TOp, af: &serde_json::Value) -> bool {
    use super::ot::{Space, TOp};
    let g = |k: &str| af.get(k).and_then(serde_json::Value::as_u64).map(|v| v as usize);
    let (Some(sec), Some(para), Some(control)) = (g("section"), g("para"), g("control")) else { return false };
    let path: Vec<(usize, usize, usize)> = match af.get("cellPath") {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|t| {
                let a = t.as_array()?;
                Some((a.first()?.as_u64()? as usize, a.get(1)?.as_u64()? as usize, a.get(2)?.as_u64()? as usize))
            })
            .collect(),
        _ => vec![],
    };
    // 연산의 공간이 활성 누름틀의 문단과 같아야 한다
    let target = match (op.space(), path.as_slice()) {
        (Space::Body { sec: s }, []) if *s == sec => Some(para),
        (Space::Cell { sec: s, hosts, chain }, steps) if *s == sec && !steps.is_empty() && chain.len() == steps.len() && hosts[0] == para => {
            let same = steps.iter().enumerate().all(|(k, &(ci, cell, cp))| chain[k] == (ci, cell) && (k + 1 == steps.len() || hosts[k + 1] == cp));
            same.then(|| steps.last().unwrap().2)
        }
        _ => None,
    };
    let Some(target) = target else { return false };
    let (lo, hi) = match op {
        TOp::Ins { at, .. } if at.para == target => (at.off, at.off),
        TOp::Replace { at, del, .. } if at.para == target => (at.off, at.off + del),
        TOp::Del { from, to, objects: false, .. } if from.para == target && to.para == target => (from.off, to.off),
        _ => return false,
    };
    let paragraph = match op.space() {
        Space::Body { .. } => doc.inner.document.sections.get(sec).and_then(|s| s.paragraphs.get(para)),
        space => doc.cell_paras_of(space).and_then(|ps| ps.get(target)),
    };
    let Some(p) = paragraph else { return false };
    if !matches!(p.controls.get(control), Some(Control::Field(f)) if f.field_type == FieldType::ClickHere) {
        return false;
    }
    p.field_ranges.iter().any(|r| r.control_idx == control && r.start_char_idx <= lo && hi <= r.end_char_idx)
}
