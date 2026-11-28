//! 4단계 U3 시험: 범위 계산·옮기기(순수), 범위 표시 state 의 보정(ot), 실제 문서의 범위 복원·다시 만들기·DocInfo 전제,
//! 서버 정본의 범위 표시 확인.

use super::super::{map_positions, rebase};
use super::*;
use serde_json::json;

fn cat() -> Value {
    json!({
        "insertText": { "conc": "text", "section": 0 },
        "deleteText": { "conc": "text", "section": 0 },
        "splitParagraph": { "conc": "text", "section": 0 },
        "mergeParagraph": { "conc": "text", "section": 0 },
        "deleteRange": { "conc": "text", "section": 0 },
        "insertTextInCell": { "conc": "text", "section": 0 },
        "applyParaFormat": { "conc": "neutral", "section": 0, "roles": [{ "kind": "para", "arg": 1 }] },
        "createTable": { "conc": "structural", "section": 0, "roles": [{ "kind": "anchor", "arg": 1 }] },
        "insertTableRow": { "conc": "structural", "section": 0, "roles": [{ "kind": "anchor", "arg": 1, "control": 2 }] },
        "pasteInternal": { "conc": "structural", "section": 0, "roles": [{ "kind": "anchor", "arg": 1 }] },
        "createTableEx": { "conc": "structural", "section": null },
        "createStyle": { "conc": "structural", "section": null },
        "updateStyle": { "conc": "neutral", "section": null, "roles": [] },
        "renameField": { "conc": "neutral", "section": null, "roles": [] },
        "splitTableCell": { "conc": "structural", "section": 0 },
    })
}

fn ins(sec: usize, p: usize, o: usize, t: &str) -> Value {
    json!({ "kind": "op", "m": "insertText", "a": [sec, p, o, t], "meta": { "len": t.chars().count() } })
}
fn split(p: usize, o: usize) -> Value {
    json!({ "kind": "op", "m": "splitParagraph", "a": [0, p, o], "meta": {} })
}
fn merge(p: usize, prev: usize) -> Value {
    json!({ "kind": "op", "m": "mergeParagraph", "a": [0, p], "meta": { "prevLen": prev } })
}
fn table(p: usize, pd: i64) -> Value {
    json!({ "kind": "op", "m": "createTable", "a": [0, p, 0, 2, 2], "meta": { "pd": pd } })
}
fn row(p: usize, ci: usize) -> Value {
    json!({ "kind": "op", "m": "insertTableRow", "a": [0, p, ci, 0, false], "meta": { "pd": 0 } })
}
fn cell_ins(p: usize, t: &str) -> Value {
    json!({ "kind": "op", "m": "insertTextInCell", "a": [0, p, 0, 0, 0, 0, t], "meta": { "len": t.chars().count() } })
}
fn hinted(lo: usize, before: usize, after: usize) -> Value {
    json!({ "kind": "state", "data": "AAAA", "range": { "section": 0, "lo": lo, "before": before, "after": after } })
}
fn range_json(es: &[Value]) -> Value {
    range_of(es, &cat())
}
fn mapped(recs: &[Value], lo: usize, hi: usize) -> Value {
    map_ranges(recs, &cat(), &[json!({ "section": 0, "lo": lo, "hi": hi })])[0].clone()
}

// ── 범위 계산 ────────────────────────────────────────────────────────────

#[test]
fn range_of_structural_foot_and_text() {
    // 표 만들기: 문단 2 를 나눠 표 문단을 끼움(pd +2) → 명령 전 [2,3), 명령 후 [2,5)
    assert_eq!(range_json(&[table(2, 2)]), json!({ "section": 0, "lo": 2, "before": 1, "after": 3 }));
    // 표 지우기처럼 문단이 줄어듦(pd -1): 명령 전 [3,5), 뒤 [3,4)
    assert_eq!(range_json(&[table(3, -1)]), json!({ "section": 0, "lo": 3, "before": 2, "after": 1 }));
    // 붙여넣기 뒤 그 안에 글자 입력 — 같은 범위
    let paste = json!({ "kind": "op", "m": "pasteInternal", "a": [0, 1, 0], "meta": { "pd": 3 } });
    assert_eq!(range_json(&[paste, ins(0, 3, 0, "x")]), json!({ "section": 0, "lo": 1, "before": 1, "after": 4 }));
    // 나눔 + 합침
    assert_eq!(range_json(&[split(4, 1)]), json!({ "section": 0, "lo": 4, "before": 1, "after": 2 }));
    assert_eq!(range_json(&[merge(4, 2)]), json!({ "section": 0, "lo": 3, "before": 2, "after": 1 }));
    // 떨어진 두 곳: 사이 문단도 범위(원래 문단이라 before 에도 셈)
    assert_eq!(range_json(&[ins(0, 1, 0, "a"), ins(0, 5, 0, "b")]), json!({ "section": 0, "lo": 1, "before": 5, "after": 5 }));
    // 셀 글자: 표를 품은 본문 문단
    assert_eq!(range_json(&[cell_ins(6, "c")]), json!({ "section": 0, "lo": 6, "before": 1, "after": 1 }));
}

#[test]
fn range_of_refuses_what_cannot_be_a_range() {
    assert_eq!(range_json(&[json!({ "kind": "state", "data": "AAAA" })]), Value::Null, "결과 전송");
    assert_eq!(range_json(&[json!({ "kind": "op", "m": "createTableEx", "a": [0, 1] })]), Value::Null, "구역 모르는 구조");
    assert_eq!(range_json(&[json!({ "kind": "op", "m": "splitTableCell", "a": [0, 1, 0] })]), Value::Null, "발자국 없는 구조");
    assert_eq!(range_json(&[ins(0, 1, 0, "a"), ins(1, 1, 0, "b")]), Value::Null, "두 구역");
    assert_eq!(range_json(&[json!({ "kind": "op", "m": "createTable", "a": [0, 1, 0, 2, 2] })]), Value::Null, "pd 없는 구조");
    assert_eq!(range_json(&[]), Value::Null);
}

// ── 범위 옮기기 ──────────────────────────────────────────────────────────

#[test]
fn map_ranges_moves_outside_edits_and_marks_inside() {
    let hit = |v: &Value| v["hit"].clone();
    let span = |v: &Value| (v["lo"].as_u64().unwrap(), v["hi"].as_u64().unwrap());
    // 범위 앞 Enter → 번호만 옮김
    let m = mapped(&[split(0, 1)], 2, 5);
    assert_eq!((span(&m), hit(&m)), ((3, 6), Value::Null));
    // 범위 뒤 글자·Enter → 그대로
    let m = mapped(&[ins(0, 6, 0, "x"), split(7, 0)], 2, 5);
    assert_eq!((span(&m), hit(&m)), ((2, 5), Value::Null));
    // 범위 안 글자 → 닿음
    assert_eq!(hit(&mapped(&[ins(0, 3, 0, "x")], 2, 5)), json!("touched"));
    // 범위 첫 문단을 앞 문단에 합침 / 범위 뒤 문단을 마지막 문단에 합침 → 닿음
    assert_eq!(hit(&mapped(&[merge(2, 1)], 2, 5)), json!("touched"));
    assert_eq!(hit(&mapped(&[merge(5, 1)], 2, 5)), json!("touched"));
    // 범위 앞 합침 → 하나 당김
    let m = mapped(&[merge(1, 1)], 2, 5);
    assert_eq!((span(&m), hit(&m)), ((1, 4), Value::Null));
    // 범위 안 표의 칸 편집·행 넣기 → 닿음(바꾸기가 그 표를 통째로 지운다), 범위 밖 표는 무관
    assert_eq!(hit(&mapped(&[cell_ins(3, "c")], 2, 5)), json!("touched"));
    assert_eq!(hit(&mapped(&[cell_ins(6, "c")], 2, 5)), Value::Null);
    assert_eq!(hit(&mapped(&[row(4, 0)], 2, 5)), json!("structural"));
    assert_eq!(hit(&mapped(&[row(6, 0)], 2, 5)), Value::Null);
    // 같은 구역 다른 곳의 표 만들기 → 막지 않고 번호만(3.2-2 를 이 경우만 풂)
    let m = mapped(&[table(0, 2)], 2, 5);
    assert_eq!((span(&m), hit(&m)), ((4, 7), Value::Null));
    let m = mapped(&[table(8, 2)], 2, 5);
    assert_eq!((span(&m), hit(&m)), ((2, 5), Value::Null));
    assert_eq!(hit(&mapped(&[table(4, 2)], 2, 5)), json!("structural"));
    // 발자국 없는 구조·구역 모르는 구조·state → 막힘
    assert_eq!(hit(&mapped(&[json!({ "kind": "op", "m": "splitTableCell", "a": [0, 9, 0] })], 2, 5)), json!("structural"));
    assert_eq!(hit(&mapped(&[json!({ "kind": "op", "m": "createStyle", "a": ["{}"] })], 2, 5)), json!("structural"));
    // DocInfo 정의만 고치는 서식은 범위에 닿지 않는다(DocInfo 전제가 걸러 따로 안내), 그 밖의 문서 단위 서식은 막힘
    assert_eq!(hit(&mapped(&[json!({ "kind": "op", "m": "updateStyle", "a": [0, "{}"] })], 2, 5)), Value::Null);
    assert_eq!(hit(&mapped(&[json!({ "kind": "op", "m": "renameField", "a": ["a", "b"] })], 2, 5)), json!("structural"));
    assert_eq!(hit(&mapped(&[json!({ "kind": "state", "data": "AAAA" })], 2, 5)), json!("whole"));
    // 다른 구역 → 무관
    assert_eq!(hit(&mapped(&[ins(1, 3, 0, "x")], 2, 5)), Value::Null);
    // 서식: 범위 안 문단이면 닿음
    let fmt = |p: usize| json!({ "kind": "op", "m": "applyParaFormat", "a": [0, p, "{}"] });
    assert_eq!(hit(&mapped(&[fmt(4)], 2, 5)), json!("touched"));
    assert_eq!(hit(&mapped(&[fmt(5)], 2, 5)), Value::Null);
    // 남의 범위 표시 state: 밖이면 옮김, 겹치면 막힘
    let m = mapped(&[hinted(0, 1, 3)], 2, 5);
    assert_eq!((span(&m), hit(&m)), ((4, 7), Value::Null));
    assert_eq!(hit(&mapped(&[hinted(4, 2, 1)], 2, 5)), json!("structural"));
    // 닿은 기록도 범위를 품도록 넓혀 문단 수를 맞춘다(내 기록으로 옮길 때 범위가 지금 문서와 맞아야 한다): 범위 안 선택
    // 삭제(3..4) → [2,4), 범위 첫 문단을 앞에 합침 → [1,4), 범위 안 Enter → [2,6), 범위 끝 문단의 표 만들기 → 넓어짐
    let del = |sp: usize, ep: usize| json!({ "kind": "op", "m": "deleteRange", "a": [0, sp, 0, ep, 0], "meta": {} });
    let m = mapped(&[del(3, 4)], 2, 5);
    assert_eq!((span(&m), hit(&m)), ((2, 4), json!("touched")));
    assert_eq!(span(&mapped(&[merge(2, 1)], 2, 5)), (1, 4));
    assert_eq!(span(&mapped(&[split(3, 1)], 2, 5)), (2, 6));
    assert_eq!(span(&mapped(&[table(4, 2)], 2, 5)), (2, 7));
    // 닿은 뒤의 기록도 계속 옮긴다
    assert_eq!(span(&mapped(&[del(3, 4), split(0, 1)], 2, 5)), (3, 5));
}

// ── 범위 표시 state 의 보정 (ot) ──────────────────────────────────────────

#[test]
fn hinted_state_is_a_structural_footprint_in_rebase() {
    let r = |p: &[Value], q: &[Value]| rebase(p, q, &cat(), &Value::Null);
    // 원격 범위 표시 state(문단 2 → 3개) 뒤로 내 미확정: 범위 밖이면 번호만 옮겨 살림
    let out = r(&[ins(0, 7, 0, "B")], &[hinted(2, 1, 3)]);
    assert_eq!(out["dropFrom"], Value::Null);
    assert_eq!(out["pending"][0]["a"], json!([0, 9, 0, "B"]));
    let out = r(&[ins(0, 1, 0, "B")], &[hinted(2, 1, 3)]);
    assert_eq!(out["pending"][0]["a"], json!([0, 1, 0, "B"]), "범위 앞은 그대로");
    // 범위 안이면 충돌
    assert_eq!(r(&[ins(0, 2, 0, "B")], &[hinted(2, 1, 3)])["dropFrom"], json!(0));
    // 다른 구역이면 그대로
    assert_eq!(r(&[ins(1, 2, 0, "B")], &[hinted(2, 1, 3)])["pending"][0]["a"], json!([1, 2, 0, "B"]));
    // 보통 state 는 예전처럼 모두와 충돌
    assert_eq!(r(&[ins(0, 9, 0, "B")], &[json!({ "kind": "state", "data": "AAAA" })])["dropFrom"], json!(0));

    // 내 미확정 범위 표시 state 를 원격 뒤로: 범위 밖이면 표시의 lo 를 고쳐 쓴다(엔진이 그 자리에서 다시 만든다)
    let mine = json!({ "kind": "state", "data": "AAAA", "recipe": 7, "range": { "section": 0, "lo": 5, "before": 2, "after": 1 } });
    let out = r(std::slice::from_ref(&mine), &[split(0, 1)]);
    assert_eq!(out["dropFrom"], Value::Null);
    assert_eq!(out["pending"][0]["range"], json!({ "section": 0, "lo": 6, "before": 2, "after": 1 }));
    assert_eq!(out["pending"][0]["recipe"], json!(7), "보낸 쪽 전용 필드는 그대로");
    // 원격 지도(remoteAfter)는 내 범위 표시 뒤로 옮겨진다(되돌리기 스택 지도)
    let out = r(std::slice::from_ref(&mine), &[ins(0, 9, 0, "B")]);
    assert_eq!(out["remoteAfter"][0]["a"], json!([0, 8, 0, "B"]));
    // 범위를 고친 원격 → 충돌, 되돌림 지도는 span 을 실은 __undoFoot
    let out = r(std::slice::from_ref(&mine), &[ins(0, 6, 0, "B")]);
    assert_eq!(out["dropFrom"], json!(0));
    assert_eq!(out["dropUndoComplete"], json!(true));
    let undo = out["dropUndo"].as_array().unwrap().clone();
    assert_eq!(undo[0]["meta"], json!({ "pd": 1, "span": 1 }));
    let pos = map_positions(&undo, &cat(), &[json!({ "section": 0, "para": 8, "offset": 0 })]);
    assert_eq!(pos[0]["para"], json!(9), "버린 범위 바꾸기의 되돌림: 뒤 문단 하나 밂");
}

#[test]
fn hinted_state_moves_undo_positions_instead_of_whole() {
    let out = map_positions(&[hinted(2, 1, 3)], &cat(), &[json!({ "section": 0, "para": 7, "offset": 1 }), json!({ "section": 1, "para": 7, "offset": 1 })]);
    assert_eq!(out[0]["para"], json!(9));
    assert_eq!(out[0]["hit"], json!("structural"), "같은 구역의 구조 편집(3.2-2)");
    assert_eq!(out[1]["para"], json!(7));
    assert_eq!(out[1]["hit"], Value::Null, "다른 구역은 막지 않는다 — 문서 전체(whole)가 아님");
}

// ── 실제 문서 ────────────────────────────────────────────────────────────

fn blank() -> DocumentCore {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().expect("빈 문서 생성");
    core
}

/// 문단 n 개(문단 i 의 글자는 `p{i}`)
fn doc_with(n: usize) -> CollabCore {
    let mut c = CollabCore::new(blank());
    for i in 0..n {
        if i > 0 {
            let len = c.document.sections[0].paragraphs[i - 1].text.chars().count();
            c.split_paragraph_native(0, i - 1, len, None).unwrap();
        }
        c.insert_text_native(0, i, 0, &format!("p{i}")).unwrap();
    }
    c
}

fn texts(c: &CollabCore) -> Vec<String> {
    c.document.sections[0].paragraphs.iter().map(|p| p.text.clone()).collect()
}
/// 본문의 표 개수(빈 문서 첫 문단의 구역·단 정의 개체는 세지 않는다)
fn controls(c: &CollabCore) -> usize {
    use crate::model::control::Control;
    c.document.sections[0].paragraphs.iter().flat_map(|p| &p.controls).filter(|x| matches!(x, Control::Table(_))).count()
}

/// 표 만들기(엔진처럼 구역 문단 수 변화 pd 를 실측해 기록에 붙인다)
fn create_table(c: &mut CollabCore, p: usize) -> Value {
    let off = c.document.sections[0].paragraphs[p].text.chars().count();
    let before = c.document.sections[0].paragraphs.len() as i64;
    c.create_table_native(0, p, off, 2, 2).unwrap();
    let pd = c.document.sections[0].paragraphs.len() as i64 - before;
    json!({ "kind": "op", "m": "createTable", "a": [0, p, off, 2, 2], "meta": { "pd": pd } })
}

fn spec(section: usize, src: (usize, usize), dst: (usize, usize)) -> Value {
    json!({ "section": section, "src": { "lo": src.0, "n": src.1 }, "dst": { "lo": dst.0, "n": dst.1 } })
}

#[test]
fn restore_range_removes_only_my_table_and_keeps_others_edits() {
    let mut c = doc_with(5);
    let snap = c.save_snapshot_native();
    let rec = create_table(&mut c, 2);
    let r = range_of(&[rec], &cat());
    let (lo, before, after) = (r["lo"].as_u64().unwrap() as usize, r["before"].as_u64().unwrap() as usize, r["after"].as_u64().unwrap() as usize);
    assert_eq!((lo, before), (2, 1));
    assert!(after >= 2, "표 문단이 생긴다: {r}");
    let mut check = spec(0, (lo, before), (lo, after));
    check["counts"] = json!(true);
    assert_eq!(c.undo_range_check(snap, &check).unwrap()["ok"], json!(true));
    assert_eq!(controls(&c), 1);

    // 남의 편집: 범위 앞 글자와 Enter, 범위 뒤 글자
    let remote = vec![ins(0, 0, 0, "B"), split(0, 1), ins(0, lo + after + 1, 0, "C")];
    c.insert_text_native(0, 0, 0, "B").unwrap();
    c.split_paragraph_native(0, 0, 1, None).unwrap();
    c.insert_text_native(0, lo + after + 1, 0, "C").unwrap();
    let m = map_ranges(&remote, &cat(), &[json!({ "section": 0, "lo": lo, "hi": lo + after })])[0].clone();
    assert_eq!(m["hit"], Value::Null);
    let dlo = m["lo"].as_u64().unwrap() as usize;
    assert_eq!(dlo, lo + 1);

    let n0 = recipe_count();
    let recipe = c.undo_restore_range(snap, &spec(0, (lo, before), (dlo, after))).unwrap();
    assert_eq!(recipe_count(), n0 + 1);
    assert_eq!(texts(&c), vec!["B", "p0", "p1", "p2", "Cp3", "p4"], "내 표만 빠지고 남의 편집은 그대로");
    assert_eq!(controls(&c), 0);
    // 내보내기 → 다시 읽기가 된다(그 결과가 state 로 나간다)
    let bytes = c.export_state().unwrap();
    let mut back = CollabCore::new(blank());
    back.load_state(&bytes).unwrap();
    assert_eq!(texts(&back), texts(&c));
    recipe_discard(recipe);
    assert_eq!(recipe_count(), n0, "재료를 풀면 저장소에서 빠진다");
    assert!(c.undo_reapply_range(recipe, &json!({ "section": 0, "lo": 0, "n": 1 })).is_err(), "푼 재료는 쓸 수 없다");
}

#[test]
fn reapply_range_rebuilds_on_a_new_document() {
    // 보낸 쪽 보정 흉내: 복원 → (되감기) → 원격 Enter 를 먼저 적용 → 옮긴 자리에서 재료로 다시 복원
    let mut c = doc_with(4);
    let snap = c.save_snapshot_native();
    let rec = create_table(&mut c, 1);
    let r = range_of(&[rec], &cat());
    let (lo, before, after) = (r["lo"].as_u64().unwrap() as usize, r["before"].as_u64().unwrap() as usize, r["after"].as_u64().unwrap() as usize);
    let confirmed = c.snapshot_save();
    let n0 = recipe_count();
    let recipe = c.undo_restore_range(snap, &spec(0, (lo, before), (lo, after))).unwrap();
    c.snapshot_restore(confirmed).unwrap();
    c.split_paragraph_native(0, 0, 1, None).unwrap(); // 원격: 범위 앞 Enter
    c.undo_reapply_range(recipe, &json!({ "section": 0, "lo": lo + 1, "n": after })).unwrap();
    assert_eq!(texts(&c), vec!["p", "0", "p1", "p2", "p3"]);
    assert_eq!(controls(&c), 0);
    recipe_discard(recipe);
    assert_eq!(recipe_count(), n0);
}

#[test]
fn docinfo_precondition_allows_appends_and_blocks_changes() {
    let mut c = doc_with(3);
    let snap = c.save_snapshot_native();
    let rec = create_table(&mut c, 1);
    let r = range_of(&[rec], &cat());
    let (lo, before, after) = (r["lo"].as_u64().unwrap() as usize, r["before"].as_u64().unwrap() as usize, r["after"].as_u64().unwrap() as usize);
    let s = spec(0, (lo, before), (lo, after));
    // 덧붙이기: 통과
    let extra = c.document.doc_info.char_shapes[0].clone();
    c.document.doc_info.char_shapes.push(extra);
    assert_eq!(c.undo_range_check(snap, &s).unwrap()["ok"], json!(true));
    // 원본 바이트만 다름: 통과(다시 읽은 문서에는 새 항목에도 원본 바이트가 생긴다)
    c.document.doc_info.char_shapes[0].raw_data = Some(vec![1, 2, 3]);
    assert_eq!(c.undo_range_check(snap, &s).unwrap()["ok"], json!(true));
    // 기존 항목의 내용이 바뀜: 막힘(docinfo), 문서는 그대로
    c.document.doc_info.char_shapes[0].base_size += 100;
    let v = c.undo_range_check(snap, &s).unwrap();
    assert_eq!(v["reason"], json!("docinfo"), "{v}");
    let before_texts = texts(&c);
    assert!(c.undo_restore_range(snap, &s).is_err());
    assert_eq!(texts(&c), before_texts);
    // 스냅샷이 없으면 snapshot
    assert_eq!(c.undo_range_check(snap + 1000, &s).unwrap()["reason"], json!("snapshot"));
    // 범위가 문단 수를 넘으면 bounds, 명령 직후 문단 수가 범위와 안 맞으면 counts
    assert_eq!(c.undo_range_check(snap, &spec(0, (lo, before), (lo, 99))).unwrap()["reason"], json!("bounds"));
    let mut bad_counts = spec(0, (lo, before), (lo, 1));
    bad_counts["counts"] = json!(true);
    c.document.doc_info.char_shapes[0].base_size -= 100;
    assert_eq!(c.undo_range_check(snap, &bad_counts).unwrap()["reason"], json!("counts"));
}

/// 서버 흉내: 같은 바이트로 연 정본과 클라이언트. 클라이언트가 표 만들기(정본도 같은 op) → 범위 복원 → 범위 표시 state.
fn server_case() -> (CollabCore, Vec<u8>, Value) {
    let base = doc_with(5).export_state().unwrap();
    let open = || {
        let mut c = CollabCore::new(blank());
        c.load_state(&base).unwrap();
        c
    };
    let (mut canon, mut client) = (open(), open());
    let snap = client.save_snapshot_native();
    let rec = create_table(&mut client, 2);
    let a = rec["a"].as_array().unwrap();
    canon.create_table_native(0, 2, a[2].as_u64().unwrap() as usize, 2, 2).unwrap();
    assert_eq!(canon.digest(), client.digest(), "같은 op 를 적용한 정본과 클라이언트");
    let r = range_of(&[rec], &cat());
    let (lo, before, after) = (r["lo"].as_u64().unwrap() as usize, r["before"].as_u64().unwrap() as usize, r["after"].as_u64().unwrap() as usize);
    let recipe = client.undo_restore_range(snap, &spec(0, (lo, before), (lo, after))).unwrap();
    recipe_discard(recipe);
    let hint = json!({ "section": 0, "lo": lo, "before": after, "after": before });
    (canon, client.export_state().unwrap(), hint)
}

#[test]
fn server_accepts_a_true_range_hint() {
    let (mut canon, c_bytes, hint) = server_case();
    let snap = canon.snapshot_save();
    canon.load_state(&c_bytes).unwrap();
    let v = canon.check_range_hint(snap, &hint).unwrap();
    assert_eq!(v, json!({ "ok": true }));
}

#[test]
fn server_rejects_a_false_range_hint() {
    let (mut canon, c_bytes, hint) = server_case();
    let snap = canon.snapshot_save();
    canon.load_state(&c_bytes).unwrap();
    // (범위를 바뀌지 않은 이웃 문단까지 넓힌 표시는 맞는 표시다 — 범위 밖이 그대로이므로. 거짓은 바뀐 문단을 범위 밖에
    // 두는 표시다.)
    let lo = hint["lo"].as_u64().unwrap();
    for bad in [
        json!({ "section": 0, "lo": lo + 2, "before": hint["before"], "after": hint["after"] }),
        json!({ "section": 0, "lo": lo + hint["before"].as_u64().unwrap(), "before": hint["before"], "after": hint["after"] }),
        json!({ "section": 0, "lo": hint["lo"], "before": hint["before"], "after": hint["after"].as_u64().unwrap() + 1 }),
        json!({ "section": 0, "lo": 0, "before": 1, "after": 1 }),
        json!({ "section": 0, "lo": hint["lo"], "before": 0, "after": 1 }),
    ] {
        let v = canon.check_range_hint(snap, &bad).unwrap();
        assert_eq!(v["reason"], json!("range"), "{bad} → {v}");
    }
}

#[test]
fn server_rejects_a_hint_that_hides_an_edit_outside_the_range() {
    // 범위 표시는 맞지만 범위 밖 문단(문단 0)도 몰래 고친 state
    let base = doc_with(5).export_state().unwrap();
    let mut canon = CollabCore::new(blank());
    canon.load_state(&base).unwrap();
    let mut client = CollabCore::new(blank());
    client.load_state(&base).unwrap();
    let snap = client.save_snapshot_native();
    let rec = create_table(&mut client, 2);
    let a = rec["a"].as_array().unwrap();
    canon.create_table_native(0, 2, a[2].as_u64().unwrap() as usize, 2, 2).unwrap();
    let r = range_of(&[rec], &cat());
    let (lo, before, after) = (r["lo"].as_u64().unwrap() as usize, r["before"].as_u64().unwrap() as usize, r["after"].as_u64().unwrap() as usize);
    recipe_discard(client.undo_restore_range(snap, &spec(0, (lo, before), (lo, after))).unwrap());
    client.insert_text_native(0, 0, 0, "몰래").unwrap();
    let hint = json!({ "section": 0, "lo": lo, "before": after, "after": before });
    let cs = canon.snapshot_save();
    canon.load_state(&client.export_state().unwrap()).unwrap();
    let v = canon.check_range_hint(cs, &hint).unwrap();
    assert_eq!(v["reason"], json!("range"), "{v}");
}

#[test]
fn docinfo_precondition_survives_state_reload_of_items_made_in_session() {
    // 세션 안에서 만든 글자·문단 모양은 모델의 속성 비트(attr)가 저장 때 필드에서 다시 계산된다 — 다시 읽은 문서와도 같다고
    // 봐야 state 한 번 뒤의 범위 되돌리기가 거짓으로 막히지 않는다(R5 범위 되돌리기 섞기에서 발견)
    let mut c = doc_with(3);
    c.apply_char_format_native(0, 1, 0, 2, r#"{"bold":true}"#).unwrap();
    c.apply_para_format_native(0, 0, r#"{"alignment":"center"}"#).unwrap();
    let snap = c.save_snapshot_native();
    let bytes = c.export_state().unwrap();
    c.load_state(&bytes).unwrap();
    let v = c.undo_range_check(snap, &spec(0, (0, 1), (0, 1))).unwrap();
    assert_eq!(v, json!({ "ok": true }), "다시 읽은 뒤에도 같은 서식 목록");
    // 기존 항목을 정말 바꾸면 여전히 막는다
    c.document.doc_info.char_shapes[0].base_size += 100;
    assert_eq!(c.undo_range_check(snap, &spec(0, (0, 1), (0, 1))).unwrap()["reason"], json!("docinfo"));
}

#[test]
fn docinfo_item_bytes_are_stable_across_repeated_state_reloads() {
    // DocInfo 전제는 항목을 저장 레코드 바이트로 견준다 — 세션 안에서 만든 문단 모양(정렬 바꿈)·표의 항목이 결과를 여러 번
    // 다시 읽어도 같은 바이트여야 한다(직렬화 → 다시 읽기 → 직렬화가 멱등)
    use crate::serializer::doc_info::{serialize_border_fill, serialize_char_shape, serialize_para_shape};
    let mut c = doc_with(4);
    for (p, a) in [(0, "center"), (1, "right"), (2, "justify"), (3, "left"), (0, "left"), (1, "justify")] {
        c.apply_para_format_native(0, p, &format!(r#"{{"alignment":"{a}"}}"#)).unwrap();
    }
    c.apply_char_format_native(0, 1, 0, 1, r#"{"italic":true,"underline":true}"#).unwrap();
    c.create_table_native(0, 2, 0, 2, 2).unwrap();
    let bytes_of = |c: &CollabCore| {
        let d = &c.document.doc_info;
        (
            d.para_shapes.iter().map(serialize_para_shape).collect::<Vec<_>>(),
            d.char_shapes.iter().map(serialize_char_shape).collect::<Vec<_>>(),
            d.border_fills.iter().map(serialize_border_fill).collect::<Vec<_>>(),
        )
    };
    let first = bytes_of(&c);
    for _ in 0..3 {
        let bytes = c.export_state().unwrap();
        c.load_state(&bytes).unwrap();
        assert_eq!(bytes_of(&c), first);
    }
}

/// 서버 정본 흐름(canonical-worker 와 같은 순서): 적용 전 스냅샷 → S = 다시 쓰기(적용 전 정본 기준) → C 읽기 → 범위 표시 확인
/// → S 읽기. 확인 결과를 돌려준다.
fn canonical_apply_hinted(canon: &mut CollabCore, c_bytes: &[u8], hint: &Value) -> Value {
    // 정본 흐름(7단계 A): 스냅샷 → S = rewrite(C) → S 읽기 → S 를 읽은 문서로 범위 확인
    let pre = canon.snapshot_save();
    let s_bytes = canon.rewrite_state(c_bytes).unwrap();
    canon.load_state(&s_bytes).unwrap();
    let v = canon.check_range_hint(pre, hint).unwrap();
    canon.snapshot_discard(pre);
    v
}

#[test]
fn range_restore_of_a_deleted_file_table_keeps_its_raw_bytes_through_the_rewrite() {
    // 6단계 결과 다시 쓰기 강화(정본이 본 날 바이트만 남김)를 지나도, 지운 표를 범위 복원으로 되살리면 표 머리·표 레코드 꼬리·
    // 셀 목록 꼬리 같은 날 바이트가 남아야 한다 — 파일에서 온 표의 바이트는 정본이 열 때 본 것이다
    use crate::model::control::Control;
    let bytes = std::fs::read(format!("{}/samples/hwp_table_test-m.hwp", env!("CARGO_MANIFEST_DIR"))).expect("샘플");
    let open = || CollabCore::new(DocumentCore::from_bytes(&bytes).unwrap());
    let (mut canon, mut client) = (open(), open());
    canon.track_raw_seen();
    let table_at = |c: &CollabCore| {
        c.document.sections[0].paragraphs.iter().enumerate().find_map(|(p, para)| {
            para.controls.iter().position(|x| matches!(x, Control::Table(_))).map(|ci| (p, ci))
        })
    };
    let (p, ci) = table_at(&client).expect("본문 표");
    let original = client.document.sections[0].paragraphs[p].clone();
    let Control::Table(t) = &original.controls[ci] else { unreachable!() };
    assert!(!t.raw_ctrl_data.is_empty() || !t.raw_table_record_extra.is_empty() || t.cells.iter().any(|c| !c.raw_list_extra.is_empty()), "시험이 헛돌지 않게: 날 바이트가 있는 표");
    // 표 지우기(op) — 클라이언트는 studio 스냅샷을 뜬 뒤 지우고, 정본도 같은 op 를 적용
    let snap = client.save_snapshot_native();
    let n0 = client.document.sections[0].paragraphs.len() as i64;
    client.delete_table_control_native(0, p, ci).unwrap();
    let pd = client.document.sections[0].paragraphs.len() as i64 - n0;
    canon.delete_table_control_native(0, p, ci).unwrap();
    assert_eq!(canon.digest(), client.digest());
    let rec = json!({ "kind": "op", "m": "deleteTableControl", "a": [0, p, ci], "meta": { "pd": pd } });
    let cat = json!({ "deleteTableControl": { "conc": "structural", "section": 0, "roles": [{ "kind": "anchor", "arg": 1 }] } });
    let r = range_of(&[rec], &cat);
    let (lo, before, after) = (r["lo"].as_u64().unwrap() as usize, r["before"].as_u64().unwrap() as usize, r["after"].as_u64().unwrap() as usize);
    recipe_discard(client.undo_restore_range(snap, &spec(0, (lo, before), (lo, after))).unwrap());
    let hint = json!({ "section": 0, "lo": lo, "before": after, "after": before });
    let v = canonical_apply_hinted(&mut canon, &client.export_state().unwrap(), &hint);
    assert_eq!(v, json!({ "ok": true }));
    // 정본(= 모두가 읽는 S)의 되살린 표가 지우기 전 표와 같다(날 바이트 포함, 줄 세로 위치만 빼고)
    let (p2, ci2) = table_at(&canon).expect("표가 돌아옴");
    assert_eq!((p2, ci2), (p, ci));
    let restored = &canon.document.sections[0].paragraphs[p2];
    let (Control::Table(a), Control::Table(b)) = (&original.controls[ci], &restored.controls[ci2]) else { unreachable!() };
    assert_eq!(a.raw_ctrl_data, b.raw_ctrl_data, "표 머리");
    assert_eq!(a.raw_table_record_extra, b.raw_table_record_extra, "표 레코드 꼬리");
    assert_eq!(a.cells.iter().map(|c| c.raw_list_extra.clone()).collect::<Vec<_>>(), b.cells.iter().map(|c| c.raw_list_extra.clone()).collect::<Vec<_>>(), "셀 목록 꼬리");
    assert_eq!(original.ctrl_data_records, restored.ctrl_data_records, "문단의 CTRL_DATA");
    assert!(para_same(&original, restored, true), "문단 전체(줄 세로 위치 뺌)");
    // 남의 편집이 없었으면 문서 전체가 지우기 전과 같다(정본이 S 를 읽은 뒤의 digest — 모든 참여자가 같은 S 를 읽는다)
    let mut fresh = open();
    fresh.load_state(&fresh.export_state().unwrap()).unwrap();
    let mut back = open();
    back.load_state(&canon.export_state().unwrap()).unwrap();
    assert_eq!(back.digest(), fresh.digest(), "지우기 전 문서와 같다");
}

// ── U3-b: 삭제 조각의 범위 복원 ─────────────────────────────────────────────

/// 선택 삭제(studio FragmentDeleteCommand 순서): 조각 캡처 [s..=e] → deleteRange. 기록과 조각 번호, DocInfo 표시를 돌려준다.
fn select_delete(c: &mut CollabCore, s: usize, so: usize, e: usize, eo: usize) -> (Value, u32, Value) {
    let frag = c.capture_delete_range_native(0, s, e).unwrap();
    c.delete_range_native(0, s, so, e, eo, None).unwrap();
    let rec = json!({ "kind": "op", "m": "deleteRange", "a": [0, s, so, e, eo], "meta": {} });
    (rec, frag, c.docinfo_mark())
}

#[test]
fn fragment_restore_puts_back_the_deleted_paragraphs_where_the_range_moved() {
    let mut c = doc_with(6);
    let (rec, frag, mark) = select_delete(&mut c, 1, 1, 3, 1);
    assert_eq!(texts(&c), vec!["p0", "p3", "p4", "p5"], "p1 의 앞 글자와 p3 의 뒤 글자가 합쳐짐");
    let r = range_of(&[rec], &cat());
    assert_eq!(r, json!({ "section": 0, "lo": 1, "before": 3, "after": 1 }));
    let mut first = spec(0, (1, 3), (1, 1));
    first["counts"] = json!(true);
    assert_eq!(c.undo_fragment_check(frag, &first, &mark).unwrap(), json!({ "ok": true }), "실행 직후 조각과 범위가 맞다");
    // 남의 편집: 범위 앞 Enter(업스트림 U1 은 조각이 옮겨졌다고 막음), 범위 뒤 Enter(업스트림 복원은 문단 수 전제에 걸려 실패)
    let remote = vec![split(0, 1), split(4, 1)];
    c.split_paragraph_native(0, 0, 1, None).unwrap();
    c.split_paragraph_native(0, 4, 1, None).unwrap();
    let m = map_ranges(&remote, &cat(), &[json!({ "section": 0, "lo": 1, "hi": 2 })])[0].clone();
    assert_eq!((m["lo"].clone(), m["hit"].clone()), (json!(2), Value::Null));
    let n0 = recipe_count();
    let recipe = c.undo_restore_fragment(frag, &spec(0, (1, 3), (2, 1)), &mark).unwrap();
    assert_eq!(texts(&c), vec!["p", "0", "p1", "p2", "p3", "p4", "p", "5"], "지운 문단만 돌아오고 남의 Enter 둘은 그대로");
    assert!(c.fragment_of(frag).is_none(), "조각을 소비한다(업스트림 복원과 같은 계약)");
    assert_eq!(recipe_count(), n0 + 1);
    recipe_discard(recipe);
    // 소비한 조각으로는 다시 못 한다
    assert_eq!(c.undo_fragment_check(frag, &spec(0, (1, 3), (2, 1)), &mark).unwrap()["reason"], json!("fragment"));
}

#[test]
fn fragment_check_refuses_mismatches_and_changed_docinfo() {
    let mut c = doc_with(4);
    let (_, frag, mark) = select_delete(&mut c, 1, 0, 2, 1);
    // 조각과 다른 범위
    assert_eq!(c.undo_fragment_check(frag, &spec(0, (0, 2), (1, 1)), &mark).unwrap()["reason"], json!("fragment"));
    assert_eq!(c.undo_fragment_check(frag, &spec(0, (1, 3), (1, 1)), &mark).unwrap()["reason"], json!("fragment"));
    // 명령 직후 문단 수가 범위와 안 맞음
    let mut counts = spec(0, (1, 2), (1, 2));
    counts["counts"] = json!(true);
    assert_eq!(c.undo_fragment_check(frag, &counts, &mark).unwrap()["reason"], json!("counts"));
    // DocInfo: 덧붙이기는 통과, 기존 항목 바뀜은 막힘, 표시 형식이 틀리면 막힘
    let extra = c.document.doc_info.para_shapes[0].clone();
    c.document.doc_info.para_shapes.push(extra);
    assert_eq!(c.undo_fragment_check(frag, &spec(0, (1, 2), (1, 1)), &mark).unwrap(), json!({ "ok": true }));
    c.document.doc_info.para_shapes[1].indent += 10;
    let v = c.undo_fragment_check(frag, &spec(0, (1, 2), (1, 1)), &mark).unwrap();
    assert_eq!(v["reason"], json!("docinfo"), "{v}");
    assert_eq!(c.undo_fragment_check(frag, &spec(0, (1, 2), (1, 1)), &json!({})).unwrap()["reason"], json!("docinfo"));
    let before = texts(&c);
    assert!(c.undo_restore_fragment(frag, &spec(0, (1, 2), (1, 1)), &mark).is_err());
    assert_eq!(texts(&c), before, "막히면 문서를 바꾸지 않는다");
    assert!(c.fragment_of(frag).is_some(), "막히면 조각을 남긴다");
}

#[test]
fn docinfo_mark_round_trips_and_sees_shrinking_lists() {
    let mut c = doc_with(2);
    let mark = DocInfoMark::of(&c.document);
    assert_eq!(DocInfoMark::parse(&mark.json()), Some(mark.clone()));
    assert_eq!(mark.matches(&c.document), Ok(()));
    c.document.doc_info.char_shapes.pop();
    assert!(mark.matches(&c.document).is_err(), "목록이 줄면 어긋남");
}

#[test]
fn fragment_restore_state_passes_the_server_range_check() {
    // 보낸 쪽 조각 복원 결과(state)에 범위 표시를 달면 정본의 확인을 지난다
    let base = doc_with(5).export_state().unwrap();
    let open = || {
        let mut c = CollabCore::new(blank());
        c.load_state(&base).unwrap();
        c
    };
    let (mut canon, mut client) = (open(), open());
    let (_, frag, mark) = select_delete(&mut client, 1, 1, 3, 1);
    canon.delete_range_native(0, 1, 1, 3, 1, None).unwrap();
    assert_eq!(canon.digest(), client.digest());
    recipe_discard(client.undo_restore_fragment(frag, &spec(0, (1, 3), (1, 1)), &mark).unwrap());
    let hint = json!({ "section": 0, "lo": 1, "before": 1, "after": 3 });
    assert_eq!(canonical_apply_hinted(&mut canon, &client.export_state().unwrap(), &hint), json!({ "ok": true }));
    assert_eq!(texts(&canon), vec!["p0", "p1", "p2", "p3", "p4"]);
}

// ── 7단계 A: 결과 전송에 자동 범위 표시 ─────────────────────────────────────

/// 자체 스냅샷을 뜨고 `edit` 를 한 뒤 범위 표시를 구한다(엔진이 state 호출 앞뒤로 하는 일). 재료는 푼다.
fn hint_after(c: &mut CollabCore, edit: impl FnOnce(&mut CollabCore)) -> Value {
    let pre = c.snapshot_save();
    edit(c);
    let v = c.state_range_hint(pre).unwrap();
    c.snapshot_discard(pre);
    if let Some(id) = v["recipe"].as_u64() {
        recipe_discard(id as u32);
    }
    v
}

#[test]
fn state_range_hint_finds_one_paragraph_range() {
    let mut c = doc_with(5);
    let v = hint_after(&mut c, |c| { c.insert_text_native(0, 2, 1, "덧").unwrap(); });
    assert_eq!(v["range"], json!({ "section": 0, "lo": 2, "before": 1, "after": 1 }), "{v}");
    let v = hint_after(&mut c, |c| { c.split_paragraph_native(0, 3, 1, None).unwrap(); });
    assert_eq!(v["range"], json!({ "section": 0, "lo": 3, "before": 1, "after": 2 }), "{v}");
    let v = hint_after(&mut c, |c| { c.merge_paragraph_native(0, 1).unwrap(); });
    assert_eq!(v["range"], json!({ "section": 0, "lo": 0, "before": 2, "after": 1 }), "{v}");
    // 떨어진 두 문단을 고치면 그 사이까지 범위
    let v = hint_after(&mut c, |c| {
        c.insert_text_native(0, 0, 0, "a").unwrap();
        c.insert_text_native(0, 3, 0, "b").unwrap();
    });
    assert_eq!(v["range"], json!({ "section": 0, "lo": 0, "before": 4, "after": 4 }), "{v}");
}

#[test]
fn state_range_hint_refuses_docinfo_props_sections_and_no_change() {
    let mut c = doc_with(3);
    assert_eq!(hint_after(&mut c, |_| {})["reason"], json!("nochange"));
    // 새 글자 모양을 덧붙이는 서식 → DocInfo 가 바뀜(덧붙이기여도 다시 만들 때 번호가 겹칠 수 있다)
    assert_eq!(hint_after(&mut c, |c| { c.apply_char_format_native(0, 1, 0, 2, r#"{"bold":true}"#).unwrap(); })["reason"], json!("docinfo"));
    // 구역 정의의 해석 밖 꼬리가 바뀜
    assert_eq!(hint_after(&mut c, |c| { c.document.sections[0].section_def.raw_ctrl_extra.push(7); })["reason"], json!("section-def"));
    // 두 구역이 바뀜
    let mut two = doc_with(2);
    let extra = two.document.sections[0].clone();
    two.document.sections.push(extra);
    let v = hint_after(&mut two, |c| {
        c.insert_text_native(0, 0, 0, "x").unwrap();
        c.document.sections[1].paragraphs[0].text.push('y');
    });
    assert_eq!(v["reason"], json!("sections"), "{v}");
    // 스냅샷이 없으면 오류(엔진은 보통 state 로 보낸다)
    assert!(c.state_range_hint(9999).is_err());
}

#[test]
fn state_range_hint_recipe_rebuilds_after_a_remote_enter_and_passes_the_server_check() {
    // 보낸 쪽: state 기능 대신 문단 안 고침을 범위로 — 재료(after 문단)로 옮긴 자리에서 다시 만들고, 정본 확인을 지난다
    let base = doc_with(5).export_state().unwrap();
    let open = || {
        let mut c = CollabCore::new(blank());
        c.load_state(&base).unwrap();
        c
    };
    let (mut canon, mut client) = (open(), open());
    let confirmed = client.snapshot_save();
    let pre = client.snapshot_save();
    client.insert_text_native(0, 3, 0, "덧말").unwrap();
    client.split_paragraph_native(0, 3, 2, None).unwrap();
    let v = client.state_range_hint(pre).unwrap();
    client.snapshot_discard(pre);
    let range = v["range"].clone();
    // 가장 작은 차이: 나눈 뒤의 "p3" 가 원래 "p3" 와 같아 [2] → [2, "덧말"] 로 잡힌다
    assert_eq!(range, json!({ "section": 0, "lo": 2, "before": 1, "after": 2 }));
    let recipe = v["recipe"].as_u64().unwrap() as u32;
    // 정본: 범위 표시 확인
    assert_eq!(canonical_apply_hinted(&mut canon, &client.export_state().unwrap(), &range), json!({ "ok": true }));
    // 보낸 쪽 보정: 확정 상태로 되감고 남의 앞 문단 Enter 를 먼저 → 옮긴 lo 에서 재료로 다시 만듦
    client.snapshot_restore(confirmed).unwrap();
    client.snapshot_discard(confirmed);
    client.split_paragraph_native(0, 0, 1, None).unwrap();
    client.undo_reapply_range(recipe, &json!({ "section": 0, "lo": 3, "n": 1 })).unwrap();
    recipe_discard(recipe);
    assert_eq!(texts(&client), vec!["p", "0", "p1", "p2", "덧말", "p3", "p4"]);
}

#[test]
fn state_recipe_from_the_current_document_rebuilds_that_range() {
    let mut c = doc_with(4);
    assert!(c.state_recipe(0, 3, 2).is_err() && c.state_recipe(0, 1, 0).is_err() && c.state_recipe(1, 0, 1).is_err());
    c.insert_text_native(0, 1, 0, "가").unwrap();
    c.insert_text_native(0, 2, 0, "나").unwrap();
    let recipe = c.state_recipe(0, 1, 2).unwrap();
    let mut other = doc_with(4);
    other.undo_reapply_range(recipe, &json!({ "section": 0, "lo": 1, "n": 2 })).unwrap();
    recipe_discard(recipe);
    assert_eq!(texts(&other), texts(&c));
}

#[test]
fn state_range_hint_refuses_changed_or_added_bin_data() {
    use crate::model::bin_data::{BinDataBytes, BinDataContent};
    let mut c = doc_with(3);
    c.document.bin_data_content.push(BinDataContent { id: 1, data: BinDataBytes::Loaded(vec![1, 2, 3]), extension: "png".into() });
    // 문단 고침과 함께 그림 바이트가 바뀜 → 범위 밖 변경
    let v = hint_after(&mut c, |c| {
        c.insert_text_native(0, 1, 0, "x").unwrap();
        c.document.bin_data_content[0].data = BinDataBytes::Loaded(vec![9, 2, 3]);
    });
    assert_eq!(v["reason"], json!("docinfo"), "{v}");
    // 그림 항목이 덧붙음
    let v = hint_after(&mut c, |c| {
        c.insert_text_native(0, 1, 0, "y").unwrap();
        c.document.bin_data_content.push(BinDataContent { id: 2, data: BinDataBytes::Loaded(vec![4]), extension: "png".into() });
    });
    assert_eq!(v["reason"], json!("docinfo"), "{v}");
    // 그림이 그대로면 표시
    let v = hint_after(&mut c, |c| { c.insert_text_native(0, 1, 0, "z").unwrap(); });
    assert_eq!(v["range"], json!({ "section": 0, "lo": 1, "before": 1, "after": 1 }), "{v}");
}

#[test]
fn canonical_flow_checks_the_hint_on_the_rewritten_bytes() {
    // 7단계 A 정본 흐름(스냅샷 → S = rewrite(C) → S 읽기 → 확인): 참인 표시는 지나고, 거짓 표시·범위 밖을 몰래 고친 state 는
    // S 를 읽은 문서에서도 걸린다
    let (mut canon, c_bytes, hint) = server_case();
    let start = canon.snapshot_save();
    assert_eq!(canonical_apply_hinted(&mut canon, &c_bytes, &hint), json!({ "ok": true }));
    canon.snapshot_restore(start).unwrap();
    let lo = hint["lo"].as_u64().unwrap();
    let bad = json!({ "section": 0, "lo": lo + 2, "before": hint["before"], "after": hint["after"] });
    assert_eq!(canonical_apply_hinted(&mut canon, &c_bytes, &bad)["reason"], json!("range"));
    canon.snapshot_restore(start).unwrap();
    let mut sneaky = CollabCore::new(blank());
    sneaky.load_state(&c_bytes).unwrap();
    sneaky.insert_text_native(0, 0, 0, "몰래").unwrap();
    assert_eq!(canonical_apply_hinted(&mut canon, &sneaky.export_state().unwrap(), &hint)["reason"], json!("range"));
    canon.snapshot_discard(start);
}
