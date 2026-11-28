//! 6단계 "결과 다시 쓰기 강화"(docs/collab-stage6.md, 규약 §8.1 의 남는 자리 (가)~(다)).
//!
//! 결과(state) C 를 정본이 다시 쓸 때(`CollabCore::rewrite_state`), 파서가 해석하지 않아 **모델이 날 바이트로 들고 있다가
//! 저장기가 그대로 쓰는 자리**를 자리마다 정한 방식으로 다룬다. 봉인은 읽을 때 그 바이트로 다시 계산돼 C 의 바이트를
//! 보증해 버리므로 기준이 되지 못한다 — 날 바이트를 비울 뿐 봉인은 건드리지 않는다(빈 바이트는 저장기가 쓰지 않는다;
//! 봉인만 지우면 날 바이트를 그대로 믿는다).
//!
//! - (A) 모델에서 그대로 다시 만들 수 있는 자리 — 표·수식 머리(`raw_ctrl_data`): 저장기가 `common` 과 그 꼬리
//!   `raw_extra` 로 다시 쓰므로 잃는 것이 없다. 다만 늘 다시 만들면 깨끗한 문서의 바이트도 바뀌므로(빈 설명 필드 4바이트
//!   등) (C) 처럼 정본이 본 것이면 두고, 아니면 비워 다시 만든다.
//! - (B) 사양 모양으로 자른다(숫자 필드만 남는다): 문단 머리 꼬리(길이 0·10·12), 렌더링 행렬(u16 개수 N 과 f64 행렬 —
//!   길이가 정확히 50 + 96N 일 때만), 문서 속성(사양 26바이트면 그대로, 아니면 (C)).
//! - (C) **정본이 본 내용일 때만** 둔다(아니면 비워 저장기가 모델에서 다시 만들거나 기본값을 쓴다): 그 밖의 자리. 자리
//!   종류마다 문서 어디든 같은 내용이면 된다(개수는 보지 않는다 — 이미 문서에 있는 바이트를 같은 종류의 다른 자리로
//!   옮기는 것은 새 내용이 아니다). 종류를 넘나들지는 않는다.
//!
//! "정본이 본 내용"([`Seen`])은 방이 살아 있는 동안 모은다(결정 2): 정본을 열 때(재시작 복원 포함, 기록 재생 전),
//! 결과를 읽을 때마다(읽기 전·후 문서), 다시 쓰기 직전의 정본. 되돌리기 계열 state(`restoreSnapshot` 등)가 지금
//! 정본에 없는 옛 내용을 되살려도 잃지 않게 한다. op 로 생겼다가 지워진 바이트는 놓칠 수 있지만 op 가 만드는 날
//! 바이트(책갈피·누름틀 CTRL_DATA, 표 머리 등)는 비워도 모델에서 다시 만들어진다.

use std::collections::{BTreeMap, HashSet};

use crate::model::control::Control;
use crate::model::document::{DocInfo, DocProperties, RawRecord, Section, SectionDef};
use crate::model::paragraph::Paragraph;
use crate::model::shape::{Caption, DrawingObjAttr, ShapeComponentAttr, ShapeObject};

/// (C) 자리의 종류 — 같은 종류 안에서만 같은 내용을 찾는다.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub(crate) enum Kind {
    /// 문단의 컨트롤마다 CTRL_DATA(`Paragraph.ctrl_data_records`)
    CtrlData,
    /// (A) 표 머리(`Table.raw_ctrl_data`) — 비우면 저장기가 `common` 으로 다시 쓴다
    TableHeader,
    /// (A) 수식 머리(`Equation.raw_ctrl_data`) — 같다
    EquationHeader,
    /// 묶음 안 자식 도형의 CTRL_DATA(`ShapeComponentAttr.ctrl_data`)
    ShapeCtrlData,
    /// 개체 공통 속성의 해석 밖 꼬리(`CommonObjAttr.raw_extra`)
    CommonExtra,
    /// 표 레코드의 해석 밖 꼬리(`Table.raw_table_record_extra`)
    TableRecordExtra,
    /// 셀 목록 머리 꼬리(`Cell.raw_list_extra`)
    CellListExtra,
    /// 그림 꼬리(`Picture.raw_picture_extra`, 개체 번호 1..5 는 가리고 견준다)
    PictureExtra,
    /// 글상자 목록 머리 꼬리(`TextBox.raw_list_header_extra`)
    TextBoxListExtra,
    /// 연결선 꼬리(`ConnectorData.raw_trailing`)
    ConnectorTrailing,
    /// 다각형 꼬리(`PolygonShape.raw_trailing`)
    PolygonTrailing,
    /// 차트 레코드(`ChartShape.raw_chart_data`) — 비우면 차트가 사라지므로 본 것만 남는다
    ChartData,
    /// OLE 태그(`OleShape.raw_tag_data`)
    OleTag,
    /// 머리말·꼬리말 컨트롤 꼬리(`Header/Footer.raw_ctrl_extra`)
    HeaderFooterExtra,
    /// 바탕쪽 목록 머리(`MasterPage.raw_list_header`)
    MasterListHeader,
    /// 구역 정의 꼬리(`SectionDef.raw_ctrl_extra`)
    SectionDefExtra,
    /// 구역 정의의 해석 밖 자식 레코드(`SectionDef.extra_child_records`, 레코드 단위)
    SectionChild,
    /// DocInfo 항목별 원본 레코드(`raw_data`)
    DocFont,
    DocBorderFill,
    DocCharShape,
    DocTabDef,
    DocNumbering,
    DocBullet,
    DocParaShape,
    DocStyle,
    DocBinData,
    DocProperties,
    // ── HWPX 원문 조각(규약 §8.1 (다)) — 저장기가 이스케이프 없이 그대로 넣는 XML 구간 ──
    /// `<hh:memoProperties>`(`DocInfo.memo_properties_xml`) — 비우면 메모 모양 레코드로 다시 쓴다
    MemoPropertiesXml,
    /// `</hh:refList>`~`</hh:head>` 문서 설정 구간(`DocInfo.hwpx_head_tail`) — 비우면 기본 설정을 쓴다
    HeadTailXml,
    /// 번호 문단 머리들(`Numbering.raw_para_heads`) — 비우면 모델 수준 값으로 다시 쓴다
    NumberingParaHeadsXml,
    /// 글머리표 문단 머리(+그림)(`Bullet.raw_para_head`) — 비우면 그림 번호를 모델 필드로 옮긴다
    BulletParaHeadXml,
    /// 누름틀 `<hp:parameters>`(`Field.raw_parameters_xml`) — 비우면 해석한 매개변수·command 로 다시 쓴다
    FieldParametersXml,
}

/// 날 바이트 자리 하나 — 걷기([`walk_section`]·[`walk_doc_info`])가 넘긴다.
pub(crate) enum Slot<'a> {
    /// (C)
    Bytes(Kind, &'a mut Vec<u8>),
    /// (C)
    Opt(Kind, &'a mut Option<Vec<u8>>),
    /// (C) HWPX 원문 조각
    Str(Kind, &'a mut Option<String>),
    /// (C) 글머리표 원문 조각 — 비울 때 그림 번호를 모델 필드로 옮긴다
    BulletHead(&'a mut crate::model::style::Bullet),
    /// (C) 컨트롤마다
    CtrlData(&'a mut Vec<Option<Vec<u8>>>),
    /// (C) 레코드 단위 — 바탕쪽 원본 목록은 하나라도 모르면 모두 버려 모델이 쓰게 한다
    Children(&'a mut Vec<RawRecord>),
    /// (B) 문단 머리 꼬리
    ParaHeader(&'a mut Vec<u8>),
    /// (B) 렌더링 행렬
    Rendering(&'a mut Vec<u8>),
}

/// 정본이 본 날 바이트(종류, 내용 해시).
#[derive(Default)]
pub(crate) struct Seen(HashSet<(Kind, [u8; 32])>);

/// 견줄 때 가리는 숫자 바이트 — 정상 편집이나 저장기가 고쳐 쓰는 자리라 같은 내용이어도 값이 달라질 수 있다.
fn masked_ranges(kind: Kind) -> &'static [std::ops::Range<usize>] {
    match kind {
        // 붙여넣기·가져오기가 개체 번호를 새로 매긴다
        Kind::PictureExtra => &[1..5],
        // 저장기가 모델에서 고쳐 쓴다: 2..4 구역 끝 바탕쪽 목록 수(바탕쪽 만들기·지우기 state), 6..8 메모 모양 번호
        // (`section_def.memo_shape_id` — 메모 모양 op 는 모델만 바꾸므로 정본의 날 바이트는 옛 값이다)
        Kind::SectionDefExtra => &[2..4, 6..8],
        // 저장기가 고쳐 쓴다
        Kind::MasterListHeader => &[18..20],
        // 글 영역 너비 — 셀 합치기(state)·크기 바꾸기가 고쳐 쓴다
        Kind::CellListExtra => &[0..4],
        _ => &[],
    }
}

fn key(kind: Kind, bytes: &[u8]) -> [u8; 32] {
    let ranges = masked_ranges(kind);
    if ranges.is_empty() {
        return crate::model::raw_provenance::bytes_digest(bytes);
    }
    let mut masked = bytes.to_vec();
    for range in ranges {
        let end = range.end.min(masked.len());
        if range.start < end {
            masked[range.start..end].fill(0);
        }
    }
    crate::model::raw_provenance::bytes_digest(&masked)
}

impl Seen {
    fn insert(&mut self, kind: Kind, bytes: &[u8]) {
        if !bytes.is_empty() {
            self.0.insert((kind, key(kind, bytes)));
        }
    }

    fn has(&self, kind: Kind, bytes: &[u8]) -> bool {
        self.0.contains(&(kind, key(kind, bytes)))
    }

    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }

    /// 문서의 (C) 자리 내용을 모두 모은다.
    pub(crate) fn collect(&mut self, doc_info: &mut DocInfo, props: &mut DocProperties, sections: &mut [Section]) {
        let mut f = |slot: Slot<'_>| match slot {
            Slot::Bytes(kind, b) => self.insert(kind, b),
            Slot::Opt(kind, b) => {
                if let Some(b) = b {
                    self.insert(kind, b)
                }
            }
            Slot::Str(kind, s) => {
                if let Some(s) = s {
                    self.insert(kind, s.as_bytes())
                }
            }
            Slot::BulletHead(bullet) => {
                if let Some(s) = &bullet.raw_para_head {
                    self.insert(Kind::BulletParaHeadXml, s.as_bytes())
                }
            }
            Slot::CtrlData(v) => {
                for b in v.iter().flatten() {
                    self.insert(Kind::CtrlData, b);
                }
            }
            Slot::Children(records) => {
                for r in records.iter() {
                    self.insert(Kind::SectionChild, &record_bytes(r));
                }
            }
            Slot::ParaHeader(_) | Slot::Rendering(_) => {}
        };
        walk_doc_info(doc_info, props, &mut f);
        for section in sections {
            walk_section(section, &mut f);
        }
    }
}

fn record_bytes(r: &RawRecord) -> Vec<u8> {
    let mut v = Vec::with_capacity(r.data.len() + 4);
    v.extend_from_slice(&r.tag_id.to_le_bytes());
    v.extend_from_slice(&r.level.to_le_bytes());
    v.extend_from_slice(&r.data);
    v
}

/// 다시 쓰기가 바꾼 자리 수(종류 이름 → 개수) — 시험·기록용.
pub(crate) type Changes = BTreeMap<String, usize>;

/// 한 자리에 정한 방식을 적용한다. 바꿨으면 그 이름.
fn sanitize_slot(slot: Slot<'_>, seen: &Seen) -> Option<String> {
    match slot {
        Slot::Bytes(kind, b) => (!b.is_empty() && !seen.has(kind, b)).then(|| {
            b.clear();
            format!("{kind:?}")
        }),
        Slot::Opt(kind, b) => match b {
            // 문서 속성(DOCUMENT_PROPERTIES)은 사양 26바이트가 모두 숫자 필드다 — 그 길이면 둔다(캐럿 위치가 늘 바뀐다)
            Some(bytes) if kind == Kind::DocProperties && bytes.len() == 26 => None,
            Some(bytes) if !seen.has(kind, bytes) => {
                *b = None;
                Some(format!("{kind:?}"))
            }
            _ => None,
        },
        Slot::Str(kind, s) => match s {
            Some(text) if !seen.has(kind, text.as_bytes()) => {
                *s = None;
                Some(format!("{kind:?}"))
            }
            _ => None,
        },
        Slot::BulletHead(bullet) => match &bullet.raw_para_head {
            Some(text) if !seen.has(Kind::BulletParaHeadXml, text.as_bytes()) => {
                // 원문 조각이 있으면 그림 번호를 `image_bullet`(BinData 순번)에서, 없으면 `image_data[3]` 에서 읽는다
                // (`Bullet::image_reference`) — 비우기 전에 옮겨 그림 글머리표의 그림을 잃지 않게 한다. 255 를 넘으면
                // 그 자리에 담을 수 없어 그림을 잃는다(BinData 가 255개 넘는 문서의 그림 글머리표).
                let image = bullet.image_reference();
                bullet.raw_para_head = None;
                if let Some(id) = image.and_then(|id| u8::try_from(id).ok()) {
                    bullet.image_data[3] = id;
                }
                Some("BulletParaHeadXml".to_string())
            }
            _ => None,
        },
        Slot::CtrlData(v) => {
            let mut changed = false;
            for b in v.iter_mut() {
                if b.as_deref().is_some_and(|bytes| !seen.has(Kind::CtrlData, bytes)) {
                    *b = None;
                    changed = true;
                }
            }
            changed.then(|| "CtrlData".to_string())
        }
        Slot::Children(records) => sanitize_children(records, seen).then(|| "SectionChild".to_string()),
        Slot::ParaHeader(b) => {
            // 문단 머리(PARA_HEADER) 22바이트(5.0.3.2 부터 +2) 중 앞 12바이트 뒤 — 사양 길이는 10 또는 12.
            let keep = match b.len() {
                0 | 10 | 12 => return None,
                n if n > 12 => 12,
                n if n > 10 => 10,
                _ => 0,
            };
            b.truncate(keep);
            Some("ParaHeader".to_string())
        }
        Slot::Rendering(b) => {
            if b.is_empty() {
                return None;
            }
            let count = b.get(0..2).map(|c| u16::from_le_bytes([c[0], c[1]]) as usize);
            if count.is_some_and(|n| b.len() == 2 + 48 + 96 * n) {
                return None;
            }
            b.clear();
            Some("Rendering".to_string())
        }
    }
}

/// 구역 정의의 해석 밖 자식 레코드. 원본 바탕쪽 목록(가장 얕은 수준의 첫 LIST_HEADER 부터 — 업스트림
/// `release_raw_master_pages` 와 같은 범위)에 모르는 레코드가 하나라도 있으면 그 범위를 모두 버려 모델이 바탕쪽을
/// 쓰게 하고, 그 앞의 모르는 레코드는 하나씩 버린다. 바꿨으면 true.
fn sanitize_children(records: &mut Vec<RawRecord>, seen: &Seen) -> bool {
    use crate::parser::tags::HWPTAG_LIST_HEADER;
    let known = |r: &RawRecord| seen.has(Kind::SectionChild, &record_bytes(r));
    if records.iter().all(known) {
        return false;
    }
    let top = records.iter().filter(|r| r.tag_id == HWPTAG_LIST_HEADER).map(|r| r.level).min();
    let start = top
        .and_then(|top| records.iter().position(|r| r.tag_id == HWPTAG_LIST_HEADER && r.level == top))
        .unwrap_or(records.len());
    if !records[start..].iter().all(known) {
        records.truncate(start);
    }
    let mut i = 0;
    records.retain(|r| {
        i += 1;
        i > start || known(r)
    });
    true
}

/// 구역 하나에 적용한다(부른 쪽이 구역 원본 바이트를 버린 구역에만). 바꾼 자리 수를 `changes` 에 더한다.
pub(crate) fn sanitize_section(section: &mut Section, seen: &Seen, changes: &mut Changes) {
    walk_section(section, &mut |slot| {
        if let Some(name) = sanitize_slot(slot, seen) {
            *changes.entry(name).or_default() += 1;
        }
    });
}

/// DocInfo 항목과 문서 속성에 적용한다(부른 쪽이 DocInfo 원본 바이트를 버렸을 때만).
pub(crate) fn sanitize_doc_info(doc_info: &mut DocInfo, props: &mut DocProperties, seen: &Seen, changes: &mut Changes) {
    walk_doc_info(doc_info, props, &mut |slot| {
        if let Some(name) = sanitize_slot(slot, seen) {
            *changes.entry(name).or_default() += 1;
        }
    });
}

// ── 걷기 ────────────────────────────────────────────────────────────────

type Visit<'f> = dyn FnMut(Slot<'_>) + 'f;

pub(crate) fn walk_doc_info(doc_info: &mut DocInfo, props: &mut DocProperties, f: &mut Visit<'_>) {
    for x in doc_info.font_faces.iter_mut().flatten() {
        f(Slot::Opt(Kind::DocFont, &mut x.raw_data));
    }
    for x in &mut doc_info.border_fills {
        f(Slot::Opt(Kind::DocBorderFill, &mut x.raw_data));
    }
    for x in &mut doc_info.char_shapes {
        f(Slot::Opt(Kind::DocCharShape, &mut x.raw_data));
    }
    for x in &mut doc_info.tab_defs {
        f(Slot::Opt(Kind::DocTabDef, &mut x.raw_data));
    }
    for x in &mut doc_info.numberings {
        f(Slot::Opt(Kind::DocNumbering, &mut x.raw_data));
        f(Slot::Str(Kind::NumberingParaHeadsXml, &mut x.raw_para_heads));
    }
    for x in &mut doc_info.bullets {
        f(Slot::Opt(Kind::DocBullet, &mut x.raw_data));
        f(Slot::BulletHead(x));
    }
    for x in &mut doc_info.para_shapes {
        f(Slot::Opt(Kind::DocParaShape, &mut x.raw_data));
    }
    for x in &mut doc_info.styles {
        f(Slot::Opt(Kind::DocStyle, &mut x.raw_data));
    }
    for x in &mut doc_info.bin_data_list {
        f(Slot::Opt(Kind::DocBinData, &mut x.raw_data));
    }
    f(Slot::Opt(Kind::DocProperties, &mut props.raw_data));
    f(Slot::Str(Kind::MemoPropertiesXml, &mut doc_info.memo_properties_xml));
    f(Slot::Str(Kind::HeadTailXml, &mut doc_info.hwpx_head_tail));
}

pub(crate) fn walk_section(section: &mut Section, f: &mut Visit<'_>) {
    walk_section_def(&mut section.section_def, f);
    walk_paragraphs(&mut section.paragraphs, f);
}

fn walk_section_def(sd: &mut SectionDef, f: &mut Visit<'_>) {
    f(Slot::Bytes(Kind::SectionDefExtra, &mut sd.raw_ctrl_extra));
    f(Slot::Children(&mut sd.extra_child_records));
    for mp in &mut sd.master_pages {
        f(Slot::Bytes(Kind::MasterListHeader, &mut mp.raw_list_header));
        walk_paragraphs(&mut mp.paragraphs, f);
    }
}

fn walk_paragraphs(paragraphs: &mut [Paragraph], f: &mut Visit<'_>) {
    for para in paragraphs {
        f(Slot::ParaHeader(&mut para.raw_header_extra));
        f(Slot::CtrlData(&mut para.ctrl_data_records));
        for control in &mut para.controls {
            match control {
                Control::Table(t) => {
                    f(Slot::Bytes(Kind::TableHeader, &mut t.raw_ctrl_data));
                    f(Slot::Bytes(Kind::TableRecordExtra, &mut t.raw_table_record_extra));
                    f(Slot::Bytes(Kind::CommonExtra, &mut t.common.raw_extra));
                    for cell in &mut t.cells {
                        f(Slot::Bytes(Kind::CellListExtra, &mut cell.raw_list_extra));
                        walk_paragraphs(&mut cell.paragraphs, f);
                    }
                    walk_caption(&mut t.caption, f);
                }
                Control::Equation(eq) => {
                    f(Slot::Bytes(Kind::EquationHeader, &mut eq.raw_ctrl_data));
                    f(Slot::Bytes(Kind::CommonExtra, &mut eq.common.raw_extra));
                }
                Control::Picture(pic) => {
                    f(Slot::Bytes(Kind::CommonExtra, &mut pic.common.raw_extra));
                    walk_shape_attr(&mut pic.shape_attr, f);
                    f(Slot::Bytes(Kind::PictureExtra, &mut pic.raw_picture_extra));
                    walk_caption(&mut pic.caption, f);
                }
                Control::Shape(shape) => walk_shape(shape, f),
                Control::Header(h) => {
                    f(Slot::Bytes(Kind::HeaderFooterExtra, &mut h.raw_ctrl_extra));
                    walk_paragraphs(&mut h.paragraphs, f);
                }
                Control::Footer(h) => {
                    f(Slot::Bytes(Kind::HeaderFooterExtra, &mut h.raw_ctrl_extra));
                    walk_paragraphs(&mut h.paragraphs, f);
                }
                Control::Footnote(n) => walk_paragraphs(&mut n.paragraphs, f),
                Control::Endnote(n) => walk_paragraphs(&mut n.paragraphs, f),
                Control::HiddenComment(c) => walk_paragraphs(&mut c.paragraphs, f),
                Control::Field(field) => {
                    f(Slot::Str(Kind::FieldParametersXml, &mut field.raw_parameters_xml));
                    walk_paragraphs(&mut field.memo_paragraphs, f);
                }
                Control::SectionDef(sd) => walk_section_def(sd, f),
                _ => {}
            }
        }
    }
}

fn walk_caption(caption: &mut Option<Caption>, f: &mut Visit<'_>) {
    if let Some(c) = caption {
        walk_paragraphs(&mut c.paragraphs, f);
    }
}

fn walk_shape_attr(attr: &mut ShapeComponentAttr, f: &mut Visit<'_>) {
    f(Slot::Rendering(&mut attr.raw_rendering));
    f(Slot::Opt(Kind::ShapeCtrlData, &mut attr.ctrl_data));
}

fn walk_drawing(drawing: &mut DrawingObjAttr, f: &mut Visit<'_>) {
    if let Some(tb) = &mut drawing.text_box {
        f(Slot::Bytes(Kind::TextBoxListExtra, &mut tb.raw_list_header_extra));
        walk_paragraphs(&mut tb.paragraphs, f);
    }
    walk_caption(&mut drawing.caption, f);
}

fn walk_shape(shape: &mut ShapeObject, f: &mut Visit<'_>) {
    f(Slot::Bytes(Kind::CommonExtra, &mut shape.common_mut().raw_extra));
    walk_shape_attr(shape.shape_attr_mut(), f);
    match shape {
        ShapeObject::Picture(pic) => {
            f(Slot::Bytes(Kind::PictureExtra, &mut pic.raw_picture_extra));
            walk_caption(&mut pic.caption, f);
        }
        ShapeObject::Group(g) => {
            for child in &mut g.children {
                walk_shape(child, f);
            }
            walk_caption(&mut g.caption, f);
        }
        ShapeObject::Chart(c) => {
            f(Slot::Bytes(Kind::ChartData, &mut c.raw_chart_data));
            walk_drawing(&mut c.drawing, f);
            walk_caption(&mut c.caption, f);
        }
        ShapeObject::Ole(o) => {
            f(Slot::Bytes(Kind::OleTag, &mut o.raw_tag_data));
            walk_drawing(&mut o.drawing, f);
            walk_caption(&mut o.caption, f);
        }
        ShapeObject::Line(l) => {
            if let Some(conn) = &mut l.connector {
                f(Slot::Bytes(Kind::ConnectorTrailing, &mut conn.raw_trailing));
            }
            walk_drawing(&mut l.drawing, f);
        }
        ShapeObject::Polygon(p) => {
            f(Slot::Bytes(Kind::PolygonTrailing, &mut p.raw_trailing));
            walk_drawing(&mut p.drawing, f);
        }
        ShapeObject::Rectangle(s) => walk_drawing(&mut s.drawing, f),
        ShapeObject::Ellipse(s) => walk_drawing(&mut s.drawing, f),
        ShapeObject::Arc(s) => walk_drawing(&mut s.drawing, f),
        ShapeObject::Curve(s) => walk_drawing(&mut s.drawing, f),
    }
}

// ── op 인자 문(결정 3) ─────────────────────────────────────────────────────

/// 문단 나누기 계열의 `removedParaMeta`(병합 되돌리기용 문단 메타 JSON) 인자 자리
fn split_meta_index(method: &str) -> Option<usize> {
    match method {
        "splitParagraph" => Some(3),
        "splitParagraphInCell" => Some(6),
        "splitParagraphInCellByPath" => Some(4),
        "splitParagraphInFootnote" => Some(5),
        "splitParagraphInHeaderFooter" => Some(5),
        _ => None,
    }
}

/// op 인자로 들어오는 날 바이트를 정본이 적용하기 전에 본다(결과 다시 쓰기로는 막을 수 없다 — op 는 모든 참여자가 그대로
/// 적용한다). 통과하지 못하면 그 까닭.
///
/// - 문단 나누기 계열 `removedParaMeta.raw_header_extra`: 문단 머리 꼬리라 사양 길이 0·10·12 만 받는다(업스트림은 길이를
///   보지 않고 그대로 저장한다).
pub(crate) fn check_op_args(method: &str, args: &serde_json::Value, _seen: &Seen) -> Result<(), String> {
    if let Some(at) = split_meta_index(method) {
        if let Some(serde_json::Value::String(json)) = args.get(at) {
            let meta: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("{method}: removedParaMeta 를 읽지 못함 ({e})"))?;
            let n = meta.get("raw_header_extra").and_then(serde_json::Value::as_array).map_or(0, Vec::len);
            if !matches!(n, 0 | 10 | 12) {
                return Err(format!("{method}: removedParaMeta.raw_header_extra 길이 {n} — 문단 머리 꼬리는 0·10·12바이트만"));
            }
        }
    }
    Ok(())
}
