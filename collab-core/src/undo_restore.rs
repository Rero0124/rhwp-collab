//! 4단계 U3: snapshot 경로의 문단 범위 복원 (docs/collab-stage4.md §6).
//!
//! studio 의 스냅샷 명령(`SnapshotCommand` 계열)은 문서 전체 스냅샷으로 되돌린다 — 공동편집 중에는 그사이 남의 편집까지
//! 지우므로 막혀 있었다(3.2-3). 명령이 만든 기록이 **한 구역의 연속 문단 범위**로 모이면, 그 범위만 스냅샷에서 되살린다.
//!
//! - [`range_of`]: 명령이 만든 기록 열 → 스냅샷(명령 전) [lo, lo+before) 와 지금 문서(명령 후) [lo, lo+after). 순수.
//! - [`map_ranges`]: 범위를 기록 열 뒤로 옮기며 범위 안을 고친 기록을 표시한다(막힘 판정). 범위 밖 구조 편집은 번호만
//!   옮긴다. 순수.
//! - [`CollabCore::undo_range_check`]·[`CollabCore::undo_restore_range`]: studio 스냅샷 저장소(`snapshot_store`)의 문서에서
//!   범위를 가져와 지금 문서의 범위와 바꾼다. 전제: 스냅샷의 DocInfo 목록이 지금 문서의 앞부분과 같다(덧붙이기만).
//!   복원할 때 원본 문단·DocInfo 를 따로 떠 둔다(복원 재료) — 보낸 쪽의 미확정 복원 state 가 보정될 때 새 문서 위에서
//!   다시 만든다([`CollabCore::undo_reapply_range`]). 확정·버림·리셋 때 엔진이 푼다([`recipe_discard`]).
//! - [`CollabCore::undo_fragment_check`]·[`CollabCore::undo_restore_fragment`](U3-b): 삭제 조각(본문 선택 삭제·덮어쓰기
//!   입력·링크·메모 앵커를 걸친 삭제)의 되돌리기도 같은 범위 복원으로 한다. 조각은 DocInfo 를 들고 있지 않으므로 실행 직후
//!   뜬 DocInfo 표시([`DocInfoMark`])로 전제를 본다.
//! - [`CollabCore::check_range_hint`]: 서버 정본 — 범위 표시가 붙은 state 를 읽은 뒤, 범위 밖이 적용 전과 같은지 확인한다.
//! - [`CollabCore::state_range_hint`](7단계 A): 되돌리기 밖의 일반 state 에도 범위 표시를 단다 — 호출 직전 스냅샷과 견주어
//!   한 구역의 연속 문단 범위만 바뀌었고 DocInfo 가 그대로면.
//!
//! 이 모듈은 `ot` 의 자식이다(분류·발자국을 다시 쓴다). 문서를 바꾸는 부분(`CollabCore` impl)도 여기 둔다 — `lib.rs`·
//! `wasm.rs` 를 고치지 않고 JS 표면도 이 파일에 둔다(맨 아래).

use std::cell::RefCell;
use std::collections::HashMap;

use serde::Serialize;
use serde_json::{json, Value};

use super::{cell_space_of, classify, touches, Conc, Rec, Space, TOp, Touch};
use crate::collab::CollabCore;
use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::document::{DocInfo, Document, Section};
use crate::model::paragraph::Paragraph;
use crate::model::raw_provenance::{bytes_digest, record_digest, section_model_digest};

// ── 범위 계산 (순수) ─────────────────────────────────────────────────────

/// 기록 하나가 적용 전 좌표에서 고친 본문 문단 [a, b](포함)와 그 구역의 문단 수 변화. 범위로 나타낼 수 없으면 `None`.
fn touched_span(r: &Rec) -> Option<(usize, usize, usize, i64)> {
    if r.state {
        return None;
    }
    if let Some(t) = &r.text {
        return Some(match (t, t.space()) {
            (_, Space::Cell { sec, hosts, .. }) => (*sec, hosts[0], hosts[0], 0),
            (TOp::Ins { at, .. } | TOp::Replace { at, .. }, Space::Body { sec }) => (*sec, at.para, at.para, 0),
            (TOp::Split { at, .. }, Space::Body { sec }) => (*sec, at.para, at.para, 1),
            (TOp::Merge { para, .. }, Space::Body { sec }) => (*sec, para.checked_sub(1)?, *para, -1),
            (TOp::Del { from, to, .. }, Space::Body { sec }) => (*sec, from.para, to.para, -((to.para - from.para) as i64)),
        });
    }
    let sec = r.section?;
    match r.conc {
        Conc::Structural => {
            let f = r.foot.as_ref()?;
            Some((f.sec, f.anchor, f.end(), f.pd))
        }
        Conc::Neutral => {
            let args = r.json["a"].as_array().cloned().unwrap_or_default();
            let m = r.json["m"].as_str().unwrap_or("");
            if let Some((Space::Cell { hosts, .. }, _)) = cell_space_of(m, &args) {
                return Some((sec, hosts[0], hosts[0], 0));
            }
            let mut span: Option<(usize, usize)> = None;
            for t in touches(r) {
                match t {
                    Touch::Paras { lo, hi, .. } => span = Some(span.map_or((lo, hi), |(a, b)| (a.min(lo), b.max(hi)))),
                    _ => return None,
                }
            }
            span.map(|(a, b)| (sec, a, b, 0))
        }
        Conc::Text => None,
    }
}

/// 명령이 만든 기록 열(순서대로)이 한 구역의 연속 문단 범위로 모이면 `{section, lo, before, after}`, 아니면 `null`.
/// 스냅샷(명령 전)의 [lo, lo+before) 가 지금 문서(명령 후)의 [lo, lo+after) 가 됐다. 기록 사이의 손대지 않은 문단도
/// 범위에 든다(원래 문단이므로 before 에도 센다).
pub fn range_of(entries: &[Value], catalog: &Value) -> Value {
    // (구역, lo, hi(지금 좌표, 제외), before)
    let mut cur: Option<(usize, usize, usize, usize)> = None;
    for e in entries {
        let r = classify(e, catalog);
        let Some((sec, a, b, pd)) = touched_span(&r) else { return Value::Null };
        let next = match cur {
            None => (sec, a, b + 1, b + 1 - a),
            Some((s, lo, hi, before)) => {
                if s != sec {
                    return Value::Null;
                }
                let (ulo, uhi) = (lo.min(a), hi.max(b + 1));
                (s, ulo, uhi, before + (uhi - ulo) - (hi - lo))
            }
        };
        let hi = next.2 as i64 + pd;
        if hi <= next.1 as i64 {
            return Value::Null;
        }
        cur = Some((next.0, next.1, hi as usize, next.3));
    }
    match cur {
        Some((section, lo, hi, before)) if before > 0 && hi > lo => json!({ "section": section, "lo": lo, "before": before, "after": hi - lo }),
        _ => Value::Null,
    }
}

// ── 범위 옮기기 (순수) ───────────────────────────────────────────────────

/// 되돌리기 스택이 기억하는 문단 범위(지금 문서 좌표 [lo, hi)).
struct RangeItem {
    sec: usize,
    lo: usize,
    hi: usize,
    hit: Option<&'static str>,
}

impl RangeItem {
    fn mark(&mut self, why: &'static str) {
        self.hit.get_or_insert(why);
    }
    fn has(&self, q: usize) -> bool {
        self.lo <= q && q < self.hi
    }
    /// [a, b](포함)이 범위와 겹치는가
    fn meets(&self, a: usize, b: usize) -> bool {
        a < self.hi && self.lo <= b
    }
    /// 범위에 닿은 기록(적용 전 [a, b] 를 고치고 문단 수가 pd 바뀜)을 범위에 합친다 — 닿음으로 표시하고, 범위도 그 기록을
    /// 품도록 넓혀 문단 수를 맞춘다(`range_of` 와 같은 합집합). 남의 기록이면 어차피 막히지만, 내 기록(호스트가 닿음을 무시)
    /// 이면 범위가 지금 문서와 계속 맞아야 한다(범위 안의 내 선택 삭제 뒤 아래 표 명령의 범위 등).
    fn absorb(&mut self, why: &'static str, a: usize, b: usize, pd: i64) {
        self.mark(why);
        let (lo, hi) = (self.lo.min(a), self.hi.max(b + 1));
        let hi = (hi as i64 + pd).max(lo as i64 + 1) as usize;
        self.lo = lo;
        self.hi = hi;
    }
}

/// DocInfo 정의(스타일·번호의 글자 모양)만 고치는 문서 단위 서식 — 분류표 why 가 "정의만 바꾼다"인 neutral.
const DOCINFO_ONLY: &[&str] = &["updateStyle", "updateStyleShapes", "setNumberingCharShape"];

/// 범위 하나를 기록 하나 뒤로. 범위를 바꾸기는 그 문단(안의 표·개체 포함)을 통째로 되살리므로, 범위 안의 무엇이든
/// 고친 기록은 닿음이다. 범위 밖의 구조 편집은 번호만 옮긴다(3.2-2 를 이 경우만 풂).
fn map_range(it: &mut RangeItem, r: &Rec) {
    if r.state {
        it.mark("whole");
        return;
    }
    if let Some(t) = &r.text {
        match t.space() {
            Space::Body { sec } if *sec == it.sec => {
                let (a, b, pd) = match t {
                    TOp::Ins { at, .. } | TOp::Replace { at, .. } => (at.para, at.para, 0),
                    TOp::Split { at, .. } => (at.para, at.para, 1),
                    TOp::Del { from, to, .. } => (from.para, to.para, -((to.para - from.para) as i64)),
                    TOp::Merge { para, .. } => (para.saturating_sub(1), *para, -1),
                };
                if it.meets(a, b) {
                    it.absorb("touched", a, b, pd);
                    return;
                }
                match (super::map_para(it.lo, t), super::map_para(it.hi - 1, t)) {
                    (super::ParaFate::Kept(lo), super::ParaFate::Kept(last)) if last >= lo => {
                        it.lo = lo;
                        it.hi = last + 1;
                    }
                    _ => it.mark("touched"),
                }
            }
            Space::Cell { sec, hosts, .. } if *sec == it.sec && it.has(hosts[0]) => it.mark("touched"),
            _ => {}
        }
        return;
    }
    match r.section {
        Some(s) if s != it.sec => return,
        // DocInfo 정의만 고치는 문서 단위 서식은 범위 문단을 고치지 않는다 — 되돌릴 때 DocInfo 전제(기존 항목이 그대로인가)가
        // 걸러 따로 안내한다
        None if r.conc == Conc::Neutral && DOCINFO_ONLY.contains(&r.json["m"].as_str().unwrap_or("")) => return,
        // 구역을 모르는 그 밖의 문서 단위 기록 — 범위 안의 필드·메모·문단을 고칠 수 있다(필드 이름, 메모 본문, 누름틀 속성…)
        None => {
            it.mark("structural");
            return;
        }
        Some(_) => {}
    }
    match r.conc {
        Conc::Structural => match &r.foot {
            Some(f) => {
                let overlap = if f.paragraph_level() { it.meets(f.anchor, f.end()) } else { it.has(f.anchor) };
                if overlap {
                    it.absorb("structural", f.anchor, f.end(), f.pd);
                    return;
                }
                match (f.shift(it.lo), f.shift(it.hi - 1)) {
                    (Some(lo), Some(last)) if last >= lo => {
                        it.lo = lo;
                        it.hi = last + 1;
                    }
                    _ => it.mark("structural"),
                }
            }
            None => it.mark("structural"),
        },
        Conc::Neutral => {
            let args = r.json["a"].as_array().cloned().unwrap_or_default();
            let m = r.json["m"].as_str().unwrap_or("");
            if let Some((Space::Cell { hosts, .. }, _)) = cell_space_of(m, &args) {
                if it.has(hosts[0]) {
                    it.mark("touched");
                }
                return;
            }
            for t in touches(r) {
                match t {
                    Touch::Paras { lo, hi, .. } if !it.meets(lo, hi) => {}
                    _ => it.mark("touched"),
                }
            }
        }
        Conc::Text => it.mark("structural"),
    }
}

/// 범위들(`{section, lo, hi}`, hi 제외)을 기록 열(지금 문서 좌표, 순서대로) 뒤로 옮긴다. 결과는 범위마다
/// `{section, lo, hi, hit}`. 원격 열이면 `hit` 이 막힘 판정이다(내 기록이면 호스트가 무시한다).
pub fn map_ranges(recs: &[Value], catalog: &Value, ranges: &[Value]) -> Value {
    let rs: Vec<Rec> = recs.iter().map(|r| classify(r, catalog)).collect();
    let g = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64).map(|x| x as usize);
    Value::Array(
        ranges
            .iter()
            .map(|v| {
                let (Some(sec), Some(lo), Some(hi)) = (g(v, "section"), g(v, "lo"), g(v, "hi")) else { return Value::Null };
                if hi <= lo {
                    return Value::Null;
                }
                let mut it = RangeItem { sec, lo, hi, hit: None };
                // 닿은 뒤에도 끝까지 옮긴다 — 내 기록으로 옮길 때는 범위가 지금 문서와 맞아야 한다
                for r in &rs {
                    map_range(&mut it, r);
                }
                json!({ "section": it.sec, "lo": it.lo, "hi": it.hi, "hit": it.hit })
            })
            .collect(),
    )
}

// ── DocInfo 전제 ─────────────────────────────────────────────────────────

/// raw_data(원본 레코드 바이트)를 비우고 본 다이제스트 — 직렬화기가 공개되지 않은 목록(번호·글머리표)에 쓴다.
fn digest_wo_raw<T: Clone + Serialize>(x: &T, clear: fn(&mut T)) -> [u8; 32] {
    let mut c = x.clone();
    clear(&mut c);
    record_digest(&c)
}

/// DocInfo 표시 — 목록마다 (항목 수, 앞부분 항목 저장 바이트의 해시). 되살릴 문단이 참조할 수 있는 DocInfo 목록이 나중에도
/// 같은 번호·같은 내용으로 있는지(덧붙이기만 허용) 보는 기준이다. 참조한 항목만 보지 않는다 — 목록끼리 서로 참조해(문단
/// 모양 → 번호·탭·테두리, 스타일 → 모양) 닫힘을 구해야 하므로, 보수적으로 목록 전체의 앞부분을 본다. 수백 바이트라 플러그인이
/// 명령마다 들고 있을 수 있다(U3-b: 조각은 DocInfo 를 들고 있지 않다 — 실행 직후 떠 둔다).
///
/// 같은 내용은 **저장할 때 쓰일 레코드 바이트**로 본다(업스트림 항목 직렬화기 — 원본 바이트가 아니라 모델에서 쓴다). 세션
/// 안에서 만든 항목은 모델의 속성 비트(`attr` 등)가 저장 때 필드에서 다시 계산되므로, 결과(state)를 다시 읽은 문서와 모델
/// 값으로 견주면 같은 항목도 다르게 나온다. 직렬화기가 공개되지 않은 번호·글머리표는 원본 바이트를 뺀 모델 값으로 본다(다시
/// 읽은 뒤 거짓으로 막을 수 있다 — 안전 쪽). BinData 는 레코드(목록)와 내용 항목의 번호·확장자(내용 바이트는 보지 않는다 —
/// 같은 번호의 바이트를 제자리에서 바꾸는 차트 편집은 그 그림을 쓰는 문단에 그대로 보이는 것이 맞다).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DocInfoMark {
    lists: Vec<(&'static str, usize, String)>,
    fonts: Vec<(usize, String)>,
}

/// 항목 열의 앞 `n` 개를 하나의 해시로(항목마다 길이를 앞에 붙여 경계를 가른다).
fn prefix_hash<T>(items: &[T], n: usize, key: impl Fn(&T) -> Vec<u8>) -> String {
    let mut h = blake3::Hasher::new();
    for x in &items[..n] {
        let b = key(x);
        h.update(&(b.len() as u64).to_le_bytes());
        h.update(&b);
    }
    h.finalize().to_hex().to_string()
}

/// 목록마다의 (이름, 항목 열 → 해시) — 표시를 뜰 때와 견줄 때 같은 열을 쓴다.
fn mark_lists(info: &DocInfo, bins: &[crate::model::bin_data::BinDataContent], n: impl Fn(&str, usize) -> usize) -> Vec<(&'static str, usize, String)> {
    use crate::serializer::doc_info as ser;
    let raw = |x: [u8; 32]| x.to_vec();
    let one = |name: &'static str, len: usize, f: &dyn Fn(usize) -> String| {
        let k = n(name, len);
        (name, k, if k <= len { f(k) } else { String::new() })
    };
    vec![
        one("bin_data_list", info.bin_data_list.len(), &|k| prefix_hash(&info.bin_data_list, k, ser::serialize_bin_data)),
        one("border_fills", info.border_fills.len(), &|k| prefix_hash(&info.border_fills, k, ser::serialize_border_fill)),
        one("char_shapes", info.char_shapes.len(), &|k| prefix_hash(&info.char_shapes, k, ser::serialize_char_shape)),
        one("tab_defs", info.tab_defs.len(), &|k| prefix_hash(&info.tab_defs, k, ser::serialize_tab_def)),
        one("numberings", info.numberings.len(), &|k| prefix_hash(&info.numberings, k, |x| raw(digest_wo_raw(x, |v| v.raw_data = None)))),
        one("bullets", info.bullets.len(), &|k| prefix_hash(&info.bullets, k, |x| raw(digest_wo_raw(x, |v| v.raw_data = None)))),
        one("para_shapes", info.para_shapes.len(), &|k| prefix_hash(&info.para_shapes, k, ser::serialize_para_shape)),
        one("styles", info.styles.len(), &|k| prefix_hash(&info.styles, k, ser::serialize_style)),
        one("bin_data_content", bins.len(), &|k| prefix_hash(bins, k, |c| [c.id.to_le_bytes().to_vec(), c.extension.as_bytes().to_vec()].concat())),
    ]
}

impl DocInfoMark {
    pub(crate) fn of(doc: &Document) -> DocInfoMark {
        use crate::serializer::doc_info as ser;
        DocInfoMark {
            lists: mark_lists(&doc.doc_info, &doc.bin_data_content, |_, len| len),
            fonts: doc.doc_info.font_faces.iter().map(|f| (f.len(), prefix_hash(f, f.len(), ser::serialize_face_name))).collect(),
        }
    }

    /// 지금 문서의 목록 앞부분이 표시와 같은가(덧붙이기만 허용). 아니면 처음 어긋난 목록.
    pub(crate) fn matches(&self, now: &Document) -> Result<(), String> {
        use crate::serializer::doc_info as ser;
        let want = |name: &str| self.lists.iter().find(|(n, _, _)| *n == name).map(|(_, k, _)| *k).unwrap_or(0);
        let got = mark_lists(&now.doc_info, &now.bin_data_content, |name, _| want(name));
        for ((name, k, h), (_, _, g)) in self.lists.iter().zip(&got) {
            if h != g {
                return Err(if name.starts_with("bin_data_content") {
                    "BinData 항목이 바뀜".into()
                } else {
                    format!("DocInfo {name} 의 기존 항목이 바뀜(앞 {k}개)")
                });
            }
        }
        let fonts = &now.doc_info.font_faces;
        if self.fonts.len() > fonts.len()
            || self.fonts.iter().zip(fonts).any(|((k, h), f)| *k > f.len() || prefix_hash(f, *k, ser::serialize_face_name) != *h)
        {
            return Err("DocInfo font_faces 의 기존 항목이 바뀜".into());
        }
        Ok(())
    }

    pub(crate) fn json(&self) -> Value {
        json!({
            "lists": self.lists.iter().map(|(n, k, h)| json!([n, k, h])).collect::<Vec<_>>(),
            "fonts": self.fonts.iter().map(|(k, h)| json!([k, h])).collect::<Vec<_>>(),
        })
    }

    pub(crate) fn parse(v: &Value) -> Option<DocInfoMark> {
        let names = ["bin_data_list", "border_fills", "char_shapes", "tab_defs", "numberings", "bullets", "para_shapes", "styles", "bin_data_content"];
        let lists = v.get("lists")?.as_array()?.iter().map(|x| {
            let n = x.get(0)?.as_str()?;
            let name = *names.iter().find(|m| **m == n)?;
            Some((name, x.get(1)?.as_u64()? as usize, x.get(2)?.as_str()?.to_string()))
        }).collect::<Option<Vec<_>>>()?;
        let fonts = v.get("fonts")?.as_array()?.iter().map(|x| Some((x.get(0)?.as_u64()? as usize, x.get(1)?.as_str()?.to_string()))).collect::<Option<Vec<_>>>()?;
        (lists.len() == names.len()).then_some(DocInfoMark { lists, fonts })
    }
}

// ── 복원 재료 ────────────────────────────────────────────────────────────

/// 복원 재료: 되살린 원본 문단과 그때의 DocInfo 표시. 보낸 쪽의 미확정 복원 state 가 보정되면 이것으로 새 문서 위에서 다시
/// 만든다. 엔진이 그 state 를 확정·버림·리셋할 때 푼다. studio 스냅샷(redo 쪽 `afterId`)은 redo 직후 지워지므로 따로 둔다.
struct Recipe {
    section: usize,
    paras: Vec<Paragraph>,
    mark: DocInfoMark,
}

thread_local! {
    /// 복원 재료 저장소(번호는 문서 객체와 무관하게 전역으로 늘린다 — 엔진이 문서마다 따로 풀므로 섞이지 않는다).
    static RECIPES: RefCell<(u32, HashMap<u32, Recipe>)> = RefCell::new((1, HashMap::new()));
}

/// 복원 재료를 푼다(없으면 아무것도 하지 않음).
pub fn recipe_discard(id: u32) {
    RECIPES.with(|r| {
        r.borrow_mut().1.remove(&id);
    });
}

/// 시험용: 살아 있는 복원 재료 수.
pub fn recipe_count() -> usize {
    RECIPES.with(|r| r.borrow().1.len())
}

fn keep_recipe(recipe: Recipe) -> u32 {
    RECIPES.with(|r| {
        let mut r = r.borrow_mut();
        let id = r.0;
        r.0 = r.0.wrapping_add(1).max(1);
        r.1.insert(id, recipe);
        id
    })
}

/// 문단 범위 지정 `{lo, n}`.
fn span_of(v: &Value, what: &str) -> Result<(usize, usize), HwpError> {
    let g = |k: &str| v.get(k).and_then(Value::as_u64).map(|x| x as usize);
    match (g("lo"), g("n")) {
        (Some(lo), Some(n)) if n > 0 => Ok((lo, n)),
        _ => Err(HwpError::RenderError(format!("범위 복원: {what} 범위 형식"))),
    }
}

fn bad(detail: impl Into<String>) -> HwpError {
    HwpError::RenderError(format!("범위 복원: {}", detail.into()))
}

/// 지금 문서 구역 `section` 의 [lo, lo+n) 을 `paras` 로 바꾼다 — 업스트림 `restore_delete_fragment_native`·붙여넣기와
/// 같은 순서(구역 원본 바이트 버림 → 끼우기 → 줄 세로 위치 다시 잇기 → 파생 상태 재구성).
fn splice(core: &mut DocumentCore, section: usize, lo: usize, n: usize, paras: &[Paragraph]) -> Result<(), HwpError> {
    let hwp3 = core.document.layout_profile().hwp3_layout();
    let sec = core.document.sections.get_mut(section).ok_or_else(|| bad(format!("구역 {section} 없음")))?;
    if lo + n > sec.paragraphs.len() {
        return Err(bad(format!("구역 {section} 의 [{lo}, {}) 가 문단 수 {} 를 넘음", lo + n, sec.paragraphs.len())));
    }
    sec.raw_stream = None;
    sec.raw_provenance = None;
    sec.paragraphs.splice(lo..lo + n, paras.iter().cloned());
    // 되살린 문단은 원래 흐름의 세로 위치를 들고 있다 — 지금 흐름에 다시 잇는다(새로 끼운 구간은 리셋 보존에서 뺀다)
    crate::renderer::composer::recalculate_section_vpos(
        &mut sec.paragraphs,
        lo,
        Some(lo..lo + paras.len()),
        None,
        &core.styles,
        core.dpi,
        hwp3,
    );
    core.rebuild_derived_state();
    Ok(())
}

impl CollabCore {
    /// studio 스냅샷 저장소의 문서.
    fn studio_snapshot(&self, id: u32) -> Option<&Document> {
        self.inner.snapshot_store.iter().find(|(sid, _, _)| *sid == id).map(|(_, d, _)| d)
    }

    /// 범위 복원을 할 수 있는가. `spec = {section, src: {lo, n}, dst: {lo, n}, counts?}` — 스냅샷의 src 를 지금 문서의 dst
    /// 와 바꾼다. `counts` 면(명령 직후 한 번) 스냅샷 구역 문단 수 + (dst.n - src.n) = 지금 구역 문단 수, 다른 구역의 문단
    /// 수가 같은지도 본다. 반환 `{"ok":true}` | `{"ok":false,"reason":"snapshot"|"bounds"|"counts"|"docinfo","detail":..}`.
    pub fn undo_range_check(&self, snapshot_id: u32, spec: &Value) -> Result<Value, HwpError> {
        let fail = |reason: &str, detail: String| json!({ "ok": false, "reason": reason, "detail": detail });
        let section = spec.get("section").and_then(Value::as_u64).ok_or_else(|| bad("section 이 없음"))? as usize;
        let (slo, sn) = span_of(&spec["src"], "src")?;
        let (dlo, dn) = span_of(&spec["dst"], "dst")?;
        let Some(snap) = self.studio_snapshot(snapshot_id) else {
            return Ok(fail("snapshot", format!("스냅샷 {snapshot_id} 없음")));
        };
        let now = &self.inner.document;
        let (Some(ss), Some(cs)) = (snap.sections.get(section), now.sections.get(section)) else {
            return Ok(fail("bounds", format!("구역 {section} 없음")));
        };
        if slo + sn > ss.paragraphs.len() || dlo + dn > cs.paragraphs.len() {
            return Ok(fail("bounds", format!("범위가 문단 수를 넘음 (src {slo}+{sn}/{}, dst {dlo}+{dn}/{})", ss.paragraphs.len(), cs.paragraphs.len())));
        }
        if spec.get("counts").and_then(Value::as_bool) == Some(true) {
            let expect = ss.paragraphs.len() as i64 + dn as i64 - sn as i64;
            if snap.sections.len() != now.sections.len()
                || cs.paragraphs.len() as i64 != expect
                || snap.sections.iter().zip(&now.sections).enumerate().any(|(i, (a, b))| i != section && a.paragraphs.len() != b.paragraphs.len())
            {
                return Ok(fail("counts", "명령 전후 문단 수가 범위와 맞지 않음".into()));
            }
        }
        if let Err(detail) = DocInfoMark::of(snap).matches(now) {
            return Ok(fail("docinfo", detail));
        }
        Ok(json!({ "ok": true }))
    }

    /// 범위 복원: studio 스냅샷 `snapshot_id` 의 src 문단을 지금 문서의 dst 와 바꾼다. 복원 재료 번호를 돌려준다(엔진이 그
    /// state 를 확정·버림·리셋할 때 [`recipe_discard`]). 전제가 어긋나면 문서를 바꾸지 않고 오류.
    pub fn undo_restore_range(&mut self, snapshot_id: u32, spec: &Value) -> Result<u32, HwpError> {
        let verdict = self.undo_range_check(snapshot_id, &json!({ "section": spec["section"], "src": spec["src"], "dst": spec["dst"] }))?;
        if verdict["ok"] != json!(true) {
            return Err(bad(format!("{}: {}", verdict["reason"].as_str().unwrap_or(""), verdict["detail"].as_str().unwrap_or(""))));
        }
        let section = spec["section"].as_u64().unwrap_or(0) as usize;
        let (slo, sn) = span_of(&spec["src"], "src")?;
        let (dlo, dn) = span_of(&spec["dst"], "dst")?;
        let snap = self.studio_snapshot(snapshot_id).expect("위에서 확인한 스냅샷");
        let recipe = Recipe { section, paras: snap.sections[section].paragraphs[slo..slo + sn].to_vec(), mark: DocInfoMark::of(snap) };
        splice(&mut self.inner, section, dlo, dn, &recipe.paras)?;
        Ok(keep_recipe(recipe))
    }

    /// 복원 재료로 다시 복원한다(보정된 미확정 복원 state 를 새 문서 위에서 다시 만들 때). `spec = {section, lo, n}` —
    /// 지금 문서의 [lo, lo+n) 을 재료 문단으로 바꾼다. 전제가 어긋나면 문서를 바꾸지 않고 오류.
    pub fn undo_reapply_range(&mut self, recipe_id: u32, spec: &Value) -> Result<(), HwpError> {
        let (lo, n) = span_of(spec, "dst")?;
        let section = spec.get("section").and_then(Value::as_u64).ok_or_else(|| bad("section 이 없음"))? as usize;
        let paras = RECIPES.with(|r| -> Result<Vec<Paragraph>, HwpError> {
            let r = r.borrow();
            let recipe = r.1.get(&recipe_id).ok_or_else(|| bad(format!("복원 재료 {recipe_id} 없음")))?;
            if recipe.section != section {
                return Err(bad("구역이 다름"));
            }
            recipe.mark.matches(&self.inner.document).map_err(bad)?;
            Ok(recipe.paras.clone())
        })?;
        splice(&mut self.inner, section, lo, n, &paras)
    }

    /// U3-b: 지금 DocInfo 의 표시(플러그인이 조각 명령마다 실행 직후 떠 둔다 — 조각은 DocInfo 를 들고 있지 않다).
    pub fn docinfo_mark(&self) -> Value {
        DocInfoMark::of(&self.inner.document).json()
    }

    /// U3-b: 삭제 조각(업스트림 `fragment_store`)의 (구역, 시작 문단, 끝 문단, 캡처 때 구역 문단 수).
    fn fragment_of(&self, id: u32) -> Option<(usize, usize, usize, usize)> {
        self.inner.fragment_store.iter().find(|(fid, _)| *fid == id).map(|(_, f)| (f.section_idx, f.start_para, f.end_para, f.pre_para_count))
    }

    /// U3-b: 조각 복원을 범위로 할 수 있는가. `spec = {section, src: {lo, n}, dst: {lo, n}, counts?}` — 조각(캡처한 [start,
    /// end])이 src 이고 지금 문서의 dst 와 바꾼다. `counts` 면(명령 직후 한 번) 캡처 때 문단 수 − src.n + dst.n = 지금 문단 수.
    /// `mark` 는 실행 직후 뜬 DocInfo 표시. 반환은 [`Self::undo_range_check`] 와 같은 모양(`reason` 에 `fragment` 가 더 있다).
    pub fn undo_fragment_check(&self, frag_id: u32, spec: &Value, mark: &Value) -> Result<Value, HwpError> {
        let fail = |reason: &str, detail: String| json!({ "ok": false, "reason": reason, "detail": detail });
        let section = spec.get("section").and_then(Value::as_u64).ok_or_else(|| bad("section 이 없음"))? as usize;
        let (slo, sn) = span_of(&spec["src"], "src")?;
        let (dlo, dn) = span_of(&spec["dst"], "dst")?;
        let Some((fsec, start, end, pre)) = self.fragment_of(frag_id) else {
            return Ok(fail("fragment", format!("삭제 조각 {frag_id} 없음")));
        };
        if fsec != section || start != slo || end + 1 - start != sn {
            return Ok(fail("fragment", format!("조각 [{start}, {end}] 이 범위 {slo}+{sn} 와 다름")));
        }
        let now = &self.inner.document;
        let Some(cs) = now.sections.get(section) else {
            return Ok(fail("bounds", format!("구역 {section} 없음")));
        };
        if dlo + dn > cs.paragraphs.len() {
            return Ok(fail("bounds", format!("dst {dlo}+{dn} 가 문단 수 {} 를 넘음", cs.paragraphs.len())));
        }
        if spec.get("counts").and_then(Value::as_bool) == Some(true) && cs.paragraphs.len() as i64 != pre as i64 - sn as i64 + dn as i64 {
            return Ok(fail("counts", "명령 전후 문단 수가 범위와 맞지 않음".into()));
        }
        let Some(m) = DocInfoMark::parse(mark) else {
            return Ok(fail("docinfo", "DocInfo 표시 형식".into()));
        };
        if let Err(detail) = m.matches(now) {
            return Ok(fail("docinfo", detail));
        }
        Ok(json!({ "ok": true }))
    }

    /// U3-b: 조각 복원을 범위로 — 조각 문단을 지금 문서의 dst 와 바꾸고 조각을 소비한다(업스트림 `restore_delete_fragment`
    /// 와 같은 계약: studio 는 성공 뒤 그 번호를 버린다). 업스트림 복원과 달리 캡처 때 문단 수 전제·구역 원본 바이트·뒤 문단
    /// 줄 좌표를 되살리지 않는다 — 범위 지도로 옮긴 자리에 끼우고 뒤 문단 세로 위치를 다시 잇는다(그 구역은 원본 바이트를
    /// 잃고 다음 저장 때 모델에서 쓰인다). 복원 재료 번호를 돌려준다.
    pub fn undo_restore_fragment(&mut self, frag_id: u32, spec: &Value, mark: &Value) -> Result<u32, HwpError> {
        let verdict = self.undo_fragment_check(frag_id, &json!({ "section": spec["section"], "src": spec["src"], "dst": spec["dst"] }), mark)?;
        if verdict["ok"] != json!(true) {
            return Err(bad(format!("{}: {}", verdict["reason"].as_str().unwrap_or(""), verdict["detail"].as_str().unwrap_or(""))));
        }
        let section = spec["section"].as_u64().unwrap_or(0) as usize;
        let (dlo, dn) = span_of(&spec["dst"], "dst")?;
        let pos = self.inner.fragment_store.iter().position(|(fid, _)| *fid == frag_id).expect("위에서 확인한 조각");
        let paras = self.inner.fragment_store[pos].1.captured_paras.clone();
        splice(&mut self.inner, section, dlo, dn, &paras)?;
        self.inner.fragment_store.remove(pos);
        let mark = DocInfoMark::parse(mark).expect("위에서 확인한 표시");
        Ok(keep_recipe(Recipe { section, paras, mark }))
    }

    /// 서버 정본: 범위 표시(`{section, lo, before, after}`)가 붙은 state 를 읽은 지금 문서가, 자체 스냅샷 `snapshot_id`
    /// (적용 전) 에서 그 범위만 바뀐 것인가. 스냅샷 쪽은 보낸 쪽 내보내기와 같게 한 번 내보내 다시 읽고 비교한다
    /// (`check_confined` 와 같은 이유 — 내보내기→다시 읽기는 항등이 아니다).
    ///
    /// 같아야 하는 것: 다른 구역 전체, 그 구역의 구역 정의·꼬리 기록·범위 앞 문단·범위 뒤 문단(번호만 밀림), 문서 속성
    /// (캐럿 제외), 메모 답글 관계, DocInfo(목록은 덧붙이기만), BinData(덧붙이기만). 범위 뒤 문단은 줄 정보의 세로 위치
    /// (`vertical_pos`)를 빼고 본다 — 범위 높이가 바뀌면 보낸 쪽이 다시 이어 계산한다. 파일 머리·미리보기·부속 스트림·출처
    /// 표지는 보지 않는다 — S1 다시 쓰기가 정본의 것으로 바꾼다.
    /// 반환 `{"ok":true}` | `{"ok":false,"reason":"range","detail":..}`.
    pub fn check_range_hint(&mut self, snapshot_id: u32, range: &Value) -> Result<Value, HwpError> {
        let fail = |detail: String| json!({ "ok": false, "reason": "range", "detail": detail });
        let g = |k: &str| range.get(k).and_then(Value::as_u64).map(|v| v as usize);
        let (Some(sec), Some(lo), Some(before), Some(after)) = (g("section"), g("lo"), g("before"), g("after")) else {
            return Ok(fail("범위 표시 형식".into()));
        };
        if before == 0 || after == 0 {
            return Ok(fail("범위 표시 형식".into()));
        }
        let base = self.reparsed_like_current(snapshot_id)?;
        Ok(match compare_hint(&base, &self.inner.document, sec, lo, before, after) {
            Ok(()) => json!({ "ok": true }),
            Err(detail) => fail(detail),
        })
    }
}

/// 문단이 같은가 — 먼저 그대로, 다르면 줄 정보 세로 위치를 지우고 본다.
fn para_same(a: &Paragraph, b: &Paragraph, ignore_vpos: bool) -> bool {
    if record_digest(a) == record_digest(b) {
        return true;
    }
    if !ignore_vpos {
        return false;
    }
    let strip = |p: &Paragraph| {
        let mut c = p.clone();
        for s in c.line_segs.iter_mut() {
            s.vertical_pos = 0;
        }
        record_digest(&c)
    };
    strip(a) == strip(b)
}

fn props_digest(p: &crate::model::document::DocProperties) -> [u8; 32] {
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

fn prefix_digest<T: Serialize>(a: &[T], b: &[T]) -> bool {
    b.len() >= a.len() && a.iter().zip(b).all(|(x, y)| record_digest(x) == record_digest(y))
}

/// `base`(적용 전, 정규화) → `now`(적용 뒤)의 변경이 구역 `sec` 의 [lo, lo+before) → [lo, lo+after) 뿐인가.
fn compare_hint(base: &Document, now: &Document, sec: usize, lo: usize, before: usize, after: usize) -> Result<(), String> {
    // 문서 필드를 빠짐없이 나열한다 — 업스트림이 필드를 더하면 컴파일 오류로 판단을 강제한다.
    let Document {
        header: _,
        doc_properties,
        doc_info,
        sections,
        preview: _,
        bin_data_content,
        extra_streams: _,
        hwpx_aux_entries: _,
        is_hwp3_variant: _,
        is_hwpx_variant: _,
        provenance: _,
        memo_parents,
    } = base;
    if props_digest(doc_properties) != props_digest(&now.doc_properties) {
        return Err("문서 속성이 다름".into());
    }
    if memo_parents != &now.memo_parents {
        return Err("메모 답글 관계가 다름".into());
    }
    check_doc_info(doc_info, &now.doc_info)?;
    check_bins(bin_data_content, &now.bin_data_content)?;
    if sections.len() != now.sections.len() {
        return Err(format!("구역 수가 다름 ({} → {})", sections.len(), now.sections.len()));
    }
    for (i, (a, b)) in sections.iter().zip(&now.sections).enumerate() {
        if i != sec {
            if section_model_digest(a) != section_model_digest(b) {
                return Err(format!("범위 밖 구역 {i} 가 다름"));
            }
            continue;
        }
        compare_section(a, b, i, lo, before, after)?;
    }
    Ok(())
}

/// BinData 내용: 덧붙이기만, 있던 항목은 번호·확장자·내용이 같다(내용은 저장된 다이제스트 — 없으면 바이트를 해시).
fn check_bins(a: &[crate::model::bin_data::BinDataContent], b: &[crate::model::bin_data::BinDataContent]) -> Result<(), String> {
    if a.len() > b.len() {
        return Err("BinData 항목이 줄었음".into());
    }
    use crate::model::bin_data::BinDataBytes;
    let stored = |c: &crate::model::bin_data::BinDataContent| {
        crate::collab::BinDigestCache::stored_digest(&c.data).unwrap_or_else(|| bytes_digest(&c.data.load_shared()))
    };
    // 빠른 길: 메모리 바이트는 그대로 견주고(해시 둘보다 싸다), 지연 항목은 같은 원본 컨테이너·같은 키면 같다(7단계 A —
    // 보낸 쪽의 호출 직전 스냅샷은 지연 항목의 리졸버를 나눠 갖는다). 그 밖은 다이제스트.
    let same = |x: &crate::model::bin_data::BinDataContent, y: &crate::model::bin_data::BinDataContent| match (&x.data, &y.data) {
        (BinDataBytes::Loaded(p), BinDataBytes::Loaded(q)) => p == q,
        (BinDataBytes::Lazy { resolver: r1, key: k1 }, BinDataBytes::Lazy { resolver: r2, key: k2 }) if std::sync::Arc::ptr_eq(r1, r2) && k1 == k2 => true,
        _ => stored(x) == stored(y),
    };
    for (x, y) in a.iter().zip(b) {
        if x.id != y.id || x.extension != y.extension || !same(x, y) {
            return Err(format!("BinData {} 가 다름", x.id));
        }
    }
    Ok(())
}

/// 범위 표시의 구역 안: 구역 정의·꼬리 같음, 문단 수가 범위와 맞음, 범위 앞 문단 같음(줄 정보까지), 범위 뒤 문단 같음(줄 세로
/// 위치 뺌 — 범위가 문단 높이를 바꾸면 뒤 문단의 세로 위치가 밀린다).
fn compare_section(a: &Section, b: &Section, i: usize, lo: usize, before: usize, after: usize) -> Result<(), String> {
    if record_digest(&a.section_def) != record_digest(&b.section_def) {
        return Err(format!("구역 {i} 의 구역 정의가 다름"));
    }
    if record_digest(&a.trailing_lists) != record_digest(&b.trailing_lists) {
        return Err(format!("구역 {i} 의 꼬리 기록이 다름"));
    }
    let (na, nb) = (a.paragraphs.len(), b.paragraphs.len());
    if lo + before > na || nb as i64 != na as i64 - before as i64 + after as i64 {
        return Err(format!("구역 {i} 의 문단 수가 범위와 맞지 않음 ({na} → {nb}, 범위 {lo}+{before}→{after})"));
    }
    if let Some(p) = (0..lo).find(|&p| !para_same(&a.paragraphs[p], &b.paragraphs[p], false)) {
        return Err(format!("범위 앞 문단 {p} 가 다름"));
    }
    if let Some(k) = (0..na - lo - before).find(|&k| !para_same(&a.paragraphs[lo + before + k], &b.paragraphs[lo + after + k], true)) {
        return Err(format!("범위 뒤 문단 {} 가 다름", lo + before + k));
    }
    Ok(())
}

/// DocInfo: 목록은 덧붙이기만, 그 밖의 레코드·속성은 같아야 한다(원본 바이트까지 — 양쪽 모두 다시 읽은 문서다).
fn check_doc_info(a: &DocInfo, b: &DocInfo) -> Result<(), String> {
    let DocInfo {
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
    let lists = [
        ("bin_data_list", prefix_digest(bin_data_list, &b.bin_data_list)),
        ("border_fills", prefix_digest(border_fills, &b.border_fills)),
        ("char_shapes", prefix_digest(char_shapes, &b.char_shapes)),
        ("tab_defs", prefix_digest(tab_defs, &b.tab_defs)),
        ("numberings", prefix_digest(numberings, &b.numberings)),
        ("bullets", prefix_digest(bullets, &b.bullets)),
        ("para_shapes", prefix_digest(para_shapes, &b.para_shapes)),
        ("styles", prefix_digest(styles, &b.styles)),
    ];
    if let Some((name, _)) = lists.iter().find(|(_, ok)| !ok) {
        return Err(format!("DocInfo {name} 의 기존 항목이 바뀜"));
    }
    if font_faces.len() != b.font_faces.len() || font_faces.iter().zip(&b.font_faces).any(|(x, y)| !prefix_digest(x, y)) {
        return Err("DocInfo font_faces 의 기존 항목이 바뀜".into());
    }
    if extra_records.len() != b.extra_records.len() || extra_records.iter().zip(&b.extra_records).any(|(x, y)| record_digest(x) != record_digest(y)) {
        return Err("DocInfo 기타 레코드가 바뀜".into());
    }
    if *bullet_count != b.bullet_count
        || *memo_shape_count != b.memo_shape_count
        || memo_properties_xml != &b.memo_properties_xml
        || hwpx_head_tail != &b.hwpx_head_tail
        || hwpml_version != &b.hwpml_version
    {
        return Err("DocInfo 속성이 바뀜".into());
    }
    Ok(())
}

// ── 7단계 A: 결과 전송에 자동 범위 표시 ───────────────────────────────────────

/// 호출 전 문서 `pre` → 지금 문서 `now` 의 차이가 한 구역의 연속 문단 범위뿐이면 (구역, lo, before, after). 아니면 사유:
/// `nochange` 바뀐 것 없음, `docinfo` DocInfo·BinData 가 바뀜(덧붙이기 포함 — 다시 만들 때 남이 그사이 덧붙인 항목과 번호가
/// 겹칠 수 있다), `props` 문서 속성·메모 관계, `sections` 구역 수가 다르거나 둘 이상 바뀜, `section-def` 그 구역의 구역 정의·
/// 꼬리 기록이 바뀜. 범위는 앞 공통 문단(줄 정보 그대로)과 뒤 공통 문단(줄 세로 위치 뺌 — 서버 확인과 같다)을 깎아 구한다.
fn state_range(pre: &Document, now: &Document) -> Result<(usize, usize, usize, usize), &'static str> {
    if DocInfoMark::of(pre) != DocInfoMark::of(now) || check_bins(&pre.bin_data_content, &now.bin_data_content).is_err() || pre.bin_data_content.len() != now.bin_data_content.len() {
        return Err("docinfo");
    }
    if props_digest(&pre.doc_properties) != props_digest(&now.doc_properties) || pre.memo_parents != now.memo_parents {
        return Err("props");
    }
    if pre.sections.len() != now.sections.len() {
        return Err("sections");
    }
    let changed: Vec<usize> = (0..pre.sections.len()).filter(|&i| section_model_digest(&pre.sections[i]) != section_model_digest(&now.sections[i])).collect();
    let sec = match changed.as_slice() {
        [] => return Err("nochange"),
        [one] => *one,
        _ => return Err("sections"),
    };
    let (a, b) = (&pre.sections[sec], &now.sections[sec]);
    if record_digest(&a.section_def) != record_digest(&b.section_def) || record_digest(&a.trailing_lists) != record_digest(&b.trailing_lists) {
        return Err("section-def");
    }
    let (na, nb) = (a.paragraphs.len(), b.paragraphs.len());
    let mut lo = 0;
    while lo < na && lo < nb && para_same(&a.paragraphs[lo], &b.paragraphs[lo], false) {
        lo += 1;
    }
    let mut tail = 0;
    while tail < na - lo && tail < nb - lo && para_same(&a.paragraphs[na - 1 - tail], &b.paragraphs[nb - 1 - tail], true) {
        tail += 1;
    }
    // 순수 끼워 넣기·지우기(한쪽이 0 개)는 이웃 공통 문단 하나를 범위에 넣는다(범위 표시는 before·after ≥ 1)
    if na - lo - tail == 0 || nb - lo - tail == 0 {
        if lo > 0 {
            lo -= 1;
        } else if tail > 0 {
            tail -= 1;
        } else {
            return Err("nochange");
        }
    }
    Ok((sec, lo, na - lo - tail, nb - lo - tail))
}

impl CollabCore {
    /// 7단계 A: 결과 전송(state)이 될 호출 직전에 뜬 자체 스냅샷 `pre` 와 지금 문서를 견주어, 한 범위 바꾸기면 범위 표시와
    /// 복원 재료(after 문단 — 보정된 미확정을 옮긴 자리에서 다시 만들 때)를 돌려준다. 구한 범위는 서버 정본과 같은 규칙으로
    /// 한 번 더 확인한다(DocInfo `check_doc_info`, 그 구역 `compare_section` — 다른 구역은 `state_range` 가 같은
    /// `section_model_digest` 로 이미 견줬으므로 다시 해시하지 않는다. 큰 문서에서 비용의 대부분이 구역 해시다). 엔진은
    /// **내보내기→다시 읽기 전에** 부른다(다시 읽은 문서는 항등이 아니라 범위 밖도 달라 보인다).
    /// 반환 `{"range":{..},"recipe":n}` | `{"reason":".."}`.
    pub fn state_range_hint(&self, pre_snapshot: u32) -> Result<Value, HwpError> {
        let pre = self
            .snapshots
            .iter()
            .find(|(id, _)| *id == pre_snapshot)
            .map(|(_, s)| &s.document)
            .ok_or_else(|| bad(format!("collab 스냅샷 {pre_snapshot} 없음")))?;
        let now = &self.inner.document;
        let found = state_range(pre, now).and_then(|r| {
            check_doc_info(&pre.doc_info, &now.doc_info)
                .and_then(|()| compare_section(&pre.sections[r.0], &now.sections[r.0], r.0, r.1, r.2, r.3))
                .map(|()| r)
                .map_err(|_| "check")
        });
        Ok(match found {
            Ok((section, lo, before, after)) => {
                let recipe = keep_recipe(Recipe { section, paras: now.sections[section].paragraphs[lo..lo + after].to_vec(), mark: DocInfoMark::of(now) });
                json!({ "range": { "section": section, "lo": lo, "before": before, "after": after }, "recipe": recipe })
            }
            Err(reason) => json!({ "reason": reason }),
        })
    }

    /// 7단계 A: 지금 문서의 (구역, `lo`부터 `n` 문단)으로 복원 재료를 만든다 — 엔진이 보내지 않은 범위 state 둘을 한 범위로
    /// 합칠 때(합친 범위의 after 문단).
    pub fn state_recipe(&self, section: usize, lo: usize, n: usize) -> Result<u32, HwpError> {
        let paras = &self.inner.document.sections.get(section).ok_or_else(|| bad("구역 범위 밖"))?.paragraphs;
        if n == 0 || lo + n > paras.len() {
            return Err(bad("문단 범위 밖"));
        }
        Ok(keep_recipe(Recipe { section, paras: paras[lo..lo + n].to_vec(), mark: DocInfoMark::of(&self.inner.document) }))
    }
}

// ── JS 표면 ──────────────────────────────────────────────────────────────

#[cfg(feature = "wasm-api")]
mod js {
    use serde_json::Value;
    use wasm_bindgen::prelude::*;

    use crate::wasm_api::HwpDocument;

    fn js_err(e: impl std::fmt::Display) -> JsValue {
        JsValue::from_str(&e.to_string())
    }

    fn parse(json: &str, what: &str) -> Result<Value, JsValue> {
        if json.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("{what} JSON 해석 실패: {e}")))
    }

    fn list(json: &str, what: &str) -> Result<Vec<Value>, JsValue> {
        Ok(parse(json, what)?.as_array().cloned().unwrap_or_default())
    }

    #[wasm_bindgen]
    impl HwpDocument {
        /// 4단계 U3: 명령이 만든 기록 열의 문단 범위 `{section, lo, before, after}` 또는 `null`(순수 함수).
        #[wasm_bindgen(js_name = collabUndoRange)]
        pub fn collab_undo_range(&self, entries_json: &str, catalog_json: &str) -> Result<String, JsValue> {
            Ok(super::range_of(&list(entries_json, "entries")?, &parse(catalog_json, "catalog")?).to_string())
        }

        /// 4단계 U3: 문단 범위들을 기록 열 뒤로 옮긴다(순수 함수). 결과는 범위마다 `{section, lo, hi, hit}`.
        #[wasm_bindgen(js_name = collabMapRanges)]
        pub fn collab_map_ranges(&self, recs_json: &str, catalog_json: &str, ranges_json: &str) -> Result<String, JsValue> {
            Ok(super::map_ranges(&list(recs_json, "recs")?, &parse(catalog_json, "catalog")?, &list(ranges_json, "ranges")?).to_string())
        }

        /// 4단계 U3: 범위 복원을 할 수 있는가(studio 스냅샷 `snapshot_id`). `{ok, reason?, detail?}`.
        #[wasm_bindgen(js_name = collabUndoRangeCheck)]
        pub fn collab_undo_range_check(&self, snapshot_id: u32, spec_json: &str) -> Result<String, JsValue> {
            self.undo_range_check(snapshot_id, &parse(spec_json, "spec")?).map(|v| v.to_string()).map_err(js_err)
        }

        /// 4단계 U3: 범위 복원. 복원 재료 번호를 돌려준다. 기록 훅 대상이 아니다 — 엔진이 결과를 state 로 기록한다.
        #[wasm_bindgen(js_name = collabUndoRestoreRange)]
        pub fn collab_undo_restore_range(&mut self, snapshot_id: u32, spec_json: &str) -> Result<u32, JsValue> {
            let spec = parse(spec_json, "spec")?;
            self.undo_restore_range(snapshot_id, &spec).map_err(js_err)
        }

        /// 4단계 U3: 복원 재료로 다시 복원한다(보정된 미확정 복원 state 를 새 문서 위에서 다시 만들 때).
        #[wasm_bindgen(js_name = collabUndoReapplyRange)]
        pub fn collab_undo_reapply_range(&mut self, recipe_id: u32, spec_json: &str) -> Result<(), JsValue> {
            let spec = parse(spec_json, "spec")?;
            self.undo_reapply_range(recipe_id, &spec).map_err(js_err)
        }

        /// 4단계 U3: 복원 재료를 푼다.
        #[wasm_bindgen(js_name = collabUndoRecipeDiscard)]
        pub fn collab_undo_recipe_discard(&self, recipe_id: u32) {
            super::recipe_discard(recipe_id);
        }

        /// 4단계 U3 시험용: 살아 있는 복원 재료 수.
        #[wasm_bindgen(js_name = collabUndoRecipeCount)]
        pub fn collab_undo_recipe_count(&self) -> u32 {
            super::recipe_count() as u32
        }

        /// 4단계 U3-b: 지금 DocInfo 의 표시(JSON) — 조각 명령의 되돌리기 전제.
        #[wasm_bindgen(js_name = collabDocInfoMark)]
        pub fn collab_docinfo_mark(&self) -> String {
            self.docinfo_mark().to_string()
        }

        /// 4단계 U3-b: 조각 복원을 범위로 할 수 있는가. `{ok, reason?, detail?}`.
        #[wasm_bindgen(js_name = collabUndoFragmentCheck)]
        pub fn collab_undo_fragment_check(&self, frag_id: u32, spec_json: &str, mark_json: &str) -> Result<String, JsValue> {
            self.undo_fragment_check(frag_id, &parse(spec_json, "spec")?, &parse(mark_json, "mark")?).map(|v| v.to_string()).map_err(js_err)
        }

        /// 4단계 U3-b: 조각 복원을 범위로(조각 소비). 복원 재료 번호. 기록 훅 대상이 아니다 — 엔진이 결과를 state 로 기록한다.
        #[wasm_bindgen(js_name = collabUndoRestoreFragment)]
        pub fn collab_undo_restore_fragment(&mut self, frag_id: u32, spec_json: &str, mark_json: &str) -> Result<u32, JsValue> {
            let (spec, mark) = (parse(spec_json, "spec")?, parse(mark_json, "mark")?);
            self.undo_restore_fragment(frag_id, &spec, &mark).map_err(js_err)
        }

        /// 7단계 A: state 가 될 호출 직전의 자체 스냅샷과 견주어 범위 표시·복원 재료 `{range, recipe}` 또는 `{reason}`.
        #[wasm_bindgen(js_name = collabStateRangeHint)]
        pub fn collab_state_range_hint(&self, pre_snapshot: u32) -> Result<String, JsValue> {
            self.state_range_hint(pre_snapshot).map(|v| v.to_string()).map_err(js_err)
        }

        /// 7단계 A: 지금 문서의 한 범위로 복원 재료(보내지 않은 범위 state 둘을 합칠 때).
        #[wasm_bindgen(js_name = collabStateRecipe)]
        pub fn collab_state_recipe(&self, section: u32, lo: u32, n: u32) -> Result<u32, JsValue> {
            self.state_recipe(section as usize, lo as usize, n as usize).map_err(js_err)
        }

        /// 7단계 A 시험용: 살아 있는 자체 스냅샷 수(미리 뜬 스냅샷이 남지 않는지).
        #[wasm_bindgen(js_name = collabSnapshotCount)]
        pub fn collab_snapshot_count(&self) -> u32 {
            self.snapshot_count() as u32
        }

        /// 4단계 U3(서버 정본): 범위 표시가 붙은 state 를 읽은 지금 문서가 자체 스냅샷에서 그 범위만 바뀐 것인가.
        #[wasm_bindgen(js_name = collabCheckRangeHint)]
        pub fn collab_check_range_hint(&mut self, snapshot_id: u32, range_json: &str) -> Result<String, JsValue> {
            let range = parse(range_json, "range")?;
            self.check_range_hint(snapshot_id, &range).map(|v| v.to_string()).map_err(js_err)
        }
    }
}

#[cfg(test)]
#[path = "undo_restore_tests.rs"]
mod tests;
