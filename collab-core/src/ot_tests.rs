//! 보정 함수 표 테스트 (docs/collab-stage2.md §4.4 이름 붙은 사례, §4.5 표). 문서 없이 기록 JSON 만 쓴다.

use super::*;
use serde_json::json;

fn cat() -> Value {
    json!({
        "insertText": { "conc": "text", "section": 0 },
        "insertTextLogical": { "conc": "text", "section": 0 },
        "deleteText": { "conc": "text", "section": 0 },
        "replaceBodyTextLocal": { "conc": "text", "section": 0 },
        "splitParagraph": { "conc": "text", "section": 0 },
        "mergeParagraph": { "conc": "text", "section": 0 },
        "deleteRange": { "conc": "text", "section": 0 },
        "deleteRangeInCell": { "conc": "text", "section": 0 },
        "applyCharFormat": { "conc": "neutral", "section": 0, "roles": [{ "kind": "range", "para": 1, "start": 2, "end": 3 }] },
        "applyParaFormat": { "conc": "neutral", "section": 0, "roles": [{ "kind": "para", "arg": 1 }] },
        "setTableProperties": { "conc": "neutral", "section": 0, "roles": [{ "kind": "anchor", "arg": 1 }] },
        "updateStyle": { "conc": "neutral", "section": null, "roles": [] },
        "createTable": { "conc": "structural", "section": 0 },
        "createStyle": { "conc": "structural", "section": null },
    })
}

fn ins(p: usize, o: usize, t: &str) -> Value {
    json!({ "kind": "op", "m": "insertText", "a": [0, p, o, t], "meta": { "len": t.chars().count() } })
}
fn ins_sec(sec: usize, p: usize, o: usize, t: &str) -> Value {
    json!({ "kind": "op", "m": "insertText", "a": [sec, p, o, t], "meta": { "len": t.chars().count() } })
}
fn del(p: usize, o: usize, n: usize) -> Value {
    json!({ "kind": "op", "m": "deleteText", "a": [0, p, o, n], "meta": { "count": n } })
}
fn split(p: usize, o: usize) -> Value {
    json!({ "kind": "op", "m": "splitParagraph", "a": [0, p, o], "meta": {} })
}
fn merge(p: usize, prev: usize) -> Value {
    json!({ "kind": "op", "m": "mergeParagraph", "a": [0, p], "meta": { "prevLen": prev } })
}
fn range(sp: usize, so: usize, ep: usize, eo: usize) -> Value {
    json!({ "kind": "op", "m": "deleteRange", "a": [0, sp, so, ep, eo], "meta": {} })
}
fn op(m: &str, a: Value) -> Value {
    json!({ "kind": "op", "m": m, "a": a })
}
fn state() -> Value {
    json!({ "kind": "state", "data": "AAAA" })
}

/// pending 을 remote 뒤로 보정한 결과의 (메서드, 인자) 목록과 dropFrom.
fn rb(pending: &[Value], remote: &[Value]) -> (Vec<(String, Value)>, Value) {
    let out = rebase(pending, remote, &cat(), &Value::Null);
    let list = out["pending"].as_array().unwrap().iter().map(|r| (r["m"].as_str().unwrap().to_string(), r["a"].clone())).collect();
    (list, out["dropFrom"].clone())
}
fn one(m: &str, a: Value) -> Vec<(String, Value)> {
    vec![(m.to_string(), a)]
}

// ── §4.4 이름 붙은 사례 ─────────────────────────────────────────────────

#[test]
fn same_point_concurrent_insert_both_orders() {
    // 원격이 먼저 확정됐으면 내 글자는 뒤로(Second = After)
    assert_eq!(rb(&[ins(0, 3, "B")], &[ins(0, 3, "AA")]).0, one("insertText", json!([0, 0, 5, "B"])));
    // 원격(First)을 내 삽입 뒤로 옮기면 원격은 앞에 남는다(Before) — 캐럿 지도로 확인
    let out = rebase(&[ins(0, 3, "B")], &[ins(0, 3, "AA")], &cat(), &json!({ "section": 0, "para": 0, "offset": 4 }));
    assert_eq!(out["caret"]["offset"], json!(6), "내 글자 뒤에 있던 캐럿은 원격 글자만큼 밀린다");
}

#[test]
fn others_insert_inside_my_delete_survives() {
    // 내 삭제 [2,8) 안에 남이 5 에 "XY" 를 넣음 → [2,5) 와 [7,10) 두 삭제(뒤부터)
    let (got, drop) = rb(&[del(0, 2, 6)], &[ins(0, 5, "XY")]);
    assert_eq!(drop, Value::Null);
    assert_eq!(got, vec![("deleteText".into(), json!([0, 0, 7, 3])), ("deleteText".into(), json!([0, 0, 2, 3]))]);
}

#[test]
fn overlapping_deletes() {
    // 내 [2,6), 원격 [4,9) → 남는 내 것은 [2,4)
    assert_eq!(rb(&[del(0, 2, 4)], &[del(0, 4, 5)]).0, one("deleteText", json!([0, 0, 2, 2])));
    // 원격이 내 범위를 다 지웠으면 버림
    assert_eq!(rb(&[del(0, 3, 2)], &[del(0, 1, 6)]).0, vec![]);
}

#[test]
fn others_enter_splits_my_delete_into_delete_range() {
    // 내 [2,7), 원격이 4 에서 Enter → (0,2)~(1,3) 걸친 삭제
    assert_eq!(rb(&[del(0, 2, 5)], &[split(0, 4)]).0, one("deleteRange", json!([0, 0, 2, 1, 3])));
}

#[test]
fn enter_at_paragraph_end_vs_backspace_at_next_paragraph_start() {
    // 문단 0 길이 5. 원격: 0 끝(5)에서 Enter → 빈 문단 1 생김, 옛 1 은 2.
    // 내 것: 옛 문단 1 처음 Backspace(merge(1), prevLen 5) → 이제 문단 2 를 빈 문단 1 에 합친다.
    assert_eq!(rb(&[merge(1, 5)], &[split(0, 5)]).0, one("mergeParagraph", json!([0, 2])));
    // 반대 순서: 원격 merge(1) 가 먼저, 내 Enter(0,5) 는 합쳐진 문단의 같은 자리에서 다시 나눈다.
    assert_eq!(rb(&[split(0, 5)], &[merge(1, 5)]).0, one("splitParagraph", json!([0, 0, 5])));
}

#[test]
fn same_boundary_concurrent_backspace_drops_one() {
    assert_eq!(rb(&[merge(1, 4)], &[merge(1, 4)]).0, vec![], "경계가 이미 없다 → 버림");
}

#[test]
fn my_insert_in_paragraph_others_merged() {
    // 원격이 문단 2 를 문단 1(길이 7) 끝에 붙임 → 내 (2,3) 삽입은 (1,10)
    assert_eq!(rb(&[ins(2, 3, "x")], &[merge(2, 7)]).0, one("insertText", json!([0, 1, 10, "x"])));
}

#[test]
fn my_split_inside_others_delete_range() {
    // 원격 (0,2)~(2,1) 삭제, 내 (1,3) Enter → 삭제 시작점 (0,2) 에서 나눈다
    assert_eq!(rb(&[split(1, 3)], &[range(0, 2, 2, 1)]).0, one("splitParagraph", json!([0, 0, 2])));
}

#[test]
fn cell_delete_vs_parent_paragraph_split_conflicts() {
    let cell = op("deleteRangeInCell", json!([0, 3, 0, 1, 0, 1, 0, 4]));
    let (got, drop) = rb(&[cell.clone()], &[split(3, 2)]);
    assert_eq!(drop, json!(0), "셀을 품은 문단이 나뉘면 충돌");
    assert!(got.is_empty());
    // 다른 문단의 나눔이면 부모 문단 번호만 옮긴다
    assert_eq!(rb(&[cell], &[split(1, 0)]).0, one("deleteRangeInCell", json!([0, 4, 0, 1, 0, 1, 0, 4])));
}

#[test]
fn merge_whose_boundary_moved_into_the_middle_becomes_delete_range() {
    // 원격이 문단 0 의 2 에서 Enter: 내 merge(1, prevLen 5) 의 경계 (0,5) 는 (1,3), 끝 (1,0) 은 (2,0)
    assert_eq!(rb(&[merge(1, 5)], &[split(0, 2)]).0, one("mergeParagraph", json!([0, 2])));
    // 원격이 문단 1 처음에 글자를 넣으면 경계는 그대로 — 남의 글자를 지우지 않는다
    assert_eq!(rb(&[merge(1, 5)], &[ins(1, 0, "ab")]).0, one("mergeParagraph", json!([0, 1])));
    // 원격이 문단 0 끝에 덧붙인 글자도 지워지지 않는다(B 는 bias After)
    let out = rebase(&[merge(1, 5)], &[ins(0, 5, "zz")], &cat(), &Value::Null);
    assert_eq!(out["pending"][0]["meta"]["prevLen"], json!(7));
}

#[test]
fn replace_vs_insert_and_delete() {
    let rep = json!({ "kind": "op", "m": "replaceBodyTextLocal", "a": [0, 0, 2, 3, "가나"], "meta": { "deleted": 3, "insLen": 2 } });
    // 앞에 넣은 원격 → 위치만 밀림
    assert_eq!(rb(&[rep.clone()], &[ins(0, 0, "xx")]).0, one("replaceBodyTextLocal", json!([0, 0, 4, 3, "가나"])));
    // 범위 안 원격 삽입 → 삭제 둘 + 삽입
    let (got, _) = rb(&[rep.clone()], &[ins(0, 3, "Q")]);
    assert_eq!(got, vec![
        ("deleteText".into(), json!([0, 0, 4, 2])),
        ("deleteText".into(), json!([0, 0, 2, 1])),
        ("insertText".into(), json!([0, 0, 2, "가나"])),
    ]);
    // 원격이 범위를 다 지웠으면 삽입만(삭제 0 인 replace)
    assert_eq!(rb(&[rep], &[del(0, 1, 5)]).0, one("replaceBodyTextLocal", json!([0, 0, 1, 0, "가나"])));
}

#[test]
fn insert_text_logical_keeps_text_coordinates_and_flags_relogical() {
    let logical = json!({ "kind": "op", "m": "insertTextLogical", "a": [0, 2, 5, "뒤"], "meta": { "offset": 4, "afterControl": true, "len": 1 } });
    let out = rebase(&[logical.clone()], &[ins(2, 0, "ab")], &cat(), &Value::Null);
    let r = &out["pending"][0];
    assert_eq!(r["m"], json!("insertTextLogical"));
    assert_eq!(r["meta"]["offset"], json!(6));
    assert_eq!(r["meta"]["afterControl"], json!(true));
    assert_eq!(r["meta"]["relogical"], json!(true), "재적용 때 논리 오프셋을 다시 계산하라는 표시");
    // 다른 문단 편집이면 바뀌지 않는다(표시 없음)
    let out = rebase(&[logical], &[ins(0, 0, "ab")], &cat(), &Value::Null);
    assert_eq!(out["pending"][0]["meta"].get("relogical"), None);
}

// ── §4.5 표 ─────────────────────────────────────────────────────────────

#[test]
fn table_text_vs_non_text() {
    let fmt = op("applyCharFormat", json!([0, 0, 1, 3, "{}"]));
    // P text, R neutral → 그대로
    assert_eq!(rb(&[ins(0, 1, "x")], &[fmt.clone()]).0, one("insertText", json!([0, 0, 1, "x"])));
    // P text, R structural (같은 구역) → 충돌
    assert_eq!(rb(&[ins(0, 1, "x")], &[op("createTable", json!([0, 0, 0, 2, 2]))]).1, json!(0));
    // P text, R structural (다른 구역) → 그대로
    assert_eq!(rb(&[ins(0, 1, "x")], &[op("createTable", json!([1, 0, 0, 2, 2]))]).1, Value::Null);
    // P text, R 문서 전체 structural → 충돌
    assert_eq!(rb(&[ins(0, 1, "x")], &[op("createStyle", json!(["{}"]))]).1, json!(0));
    // P text, R state → 충돌
    assert_eq!(rb(&[ins(0, 1, "x")], &[state()]).1, json!(0));
}

#[test]
fn table_neutral_vs_text_moves_roles() {
    // range: 원격 삽입만큼 밀림
    assert_eq!(rb(&[op("applyCharFormat", json!([0, 0, 2, 4, "{}"]))], &[ins(0, 0, "ab")]).0, one("applyCharFormat", json!([0, 0, 4, 6, "{}"])));
    // range: 원격이 다 지우면 버림
    assert_eq!(rb(&[op("applyCharFormat", json!([0, 0, 2, 4, "{}"]))], &[del(0, 1, 5)]).0, vec![]);
    // range: 원격 Enter 로 범위가 두 문단에 걸치면 충돌
    assert_eq!(rb(&[op("applyCharFormat", json!([0, 0, 2, 4, "{}"]))], &[split(0, 3)]).1, json!(0));
    // para: 문단 번호를 옮긴다
    assert_eq!(rb(&[op("applyParaFormat", json!([0, 3, "{}"]))], &[split(1, 0)]).0, one("applyParaFormat", json!([0, 4, "{}"])));
    // anchor: 개체 문단이 나뉘면 충돌, 다른 문단이면 옮김
    assert_eq!(rb(&[op("setTableProperties", json!([0, 2, 0, "{}"]))], &[split(2, 1)]).1, json!(0));
    assert_eq!(rb(&[op("setTableProperties", json!([0, 2, 0, "{}"]))], &[merge(2, 3)]).1, json!(0), "개체 문단이 앞 문단에 합쳐짐");
    assert_eq!(rb(&[op("setTableProperties", json!([0, 2, 0, "{}"]))], &[merge(3, 3)]).1, json!(0), "뒷 문단이 개체 문단에 합쳐짐");
    assert_eq!(rb(&[op("setTableProperties", json!([0, 2, 0, "{}"]))], &[merge(1, 3)]).0, one("setTableProperties", json!([0, 1, 0, "{}"])), "앞쪽 합침은 번호만 당긴다");
    assert_eq!(rb(&[op("setTableProperties", json!([0, 2, 0, "{}"]))], &[split(0, 1)]).0, one("setTableProperties", json!([0, 3, 0, "{}"])));
    // 구역이 다르면 그대로
    assert_eq!(rb(&[op("applyParaFormat", json!([0, 3, "{}"]))], &[ins_sec(1, 0, 0, "x")]).0, one("applyParaFormat", json!([0, 3, "{}"])));
}

#[test]
fn table_neutral_and_structural_rows() {
    let fmt = op("applyCharFormat", json!([0, 0, 1, 3, "{}"]));
    // neutral vs neutral → 그대로
    assert_eq!(rb(&[fmt.clone()], &[op("updateStyle", json!([1, "{}"]))]).0, one("applyCharFormat", json!([0, 0, 1, 3, "{}"])));
    // neutral vs structural 같은 구역 → 충돌
    assert_eq!(rb(&[fmt.clone()], &[op("createTable", json!([0, 0, 0, 2, 2]))]).1, json!(0));
    // structural vs text 같은 구역 → 충돌, 다른 구역 → 그대로
    assert_eq!(rb(&[op("createTable", json!([0, 1, 0, 2, 2]))], &[ins(0, 0, "x")]).1, json!(0));
    assert_eq!(rb(&[op("createTable", json!([0, 1, 0, 2, 2]))], &[ins_sec(1, 0, 0, "x")]).1, Value::Null);
    // state vs 무엇이든 → 충돌
    assert_eq!(rb(&[state()], &[op("updateStyle", json!([1, "{}"]))]).1, json!(0));
    // 분류표에 없는 이름은 structural 로 본다(문서 전체 → 충돌)
    assert_eq!(rb(&[op("unknownThing", json!([0]))], &[ins(0, 0, "x")]).1, json!(0));
}

#[test]
fn conflict_drops_that_op_and_the_tail_keeps_the_head() {
    let pending = [ins(0, 0, "a"), op("createTable", json!([0, 1, 0, 2, 2])), ins(0, 1, "b")];
    let out = rebase(&pending, &[ins(0, 0, "R")], &cat(), &Value::Null);
    assert_eq!(out["dropFrom"], json!(1));
    assert_eq!(out["pending"].as_array().unwrap().len(), 1, "앞의 것은 보정해서 둔다");
    assert_eq!(out["pending"][0]["a"], json!([0, 0, 1, "a"]));
    assert!(out["dropReason"].as_str().unwrap().contains("구조"));
}

#[test]
fn ordered_pending_sequence_is_rebased_in_order() {
    // 내가 "ab" 를 0 에 넣고 이어서 2 에 "c" (내 첫 연산 위에서 만든 위치)
    // 원격은 처음에 "XY" → 내 두 연산 모두 2 칸 밀린다
    let (got, _) = rb(&[ins(0, 0, "ab"), ins(0, 2, "c")], &[ins(0, 0, "XY")]);
    assert_eq!(got, vec![("insertText".into(), json!([0, 0, 2, "ab"])), ("insertText".into(), json!([0, 0, 4, "c"]))]);
}

#[test]
fn active_field_ctx_moves_and_conflicts_like_anchor() {
    let mut p = ins(2, 1, "x");
    p["ctx"] = json!({ "activeField": { "section": 0, "para": 2, "control": 0, "cellPath": null } });
    let out = rebase(&[p.clone()], &[split(0, 0)], &cat(), &Value::Null);
    assert_eq!(out["pending"][0]["ctx"]["activeField"]["para"], json!(3));
    let out = rebase(&[p], &[split(2, 0)], &cat(), &Value::Null);
    assert_eq!(out["dropFrom"], json!(0), "누름틀 문단이 나뉘면 충돌");
}

#[test]
fn caret_maps_before_remote_insert_at_same_point() {
    let caret = json!({ "section": 0, "para": 0, "offset": 3 });
    let c = map_caret_through(&[ins(0, 3, "XY")], &cat(), &caret);
    assert_eq!(c["offset"], json!(3), "내 캐럿 자리에 온 남의 글자는 캐럿 뒤로");
    let c = map_caret_through(&[ins(0, 1, "XY")], &cat(), &caret);
    assert_eq!(c["offset"], json!(5));
    let c = map_caret_through(&[split(0, 1)], &cat(), &caret);
    assert_eq!((c["para"].clone(), c["offset"].clone()), (json!(1), json!(2)));
    let c = map_caret_through(&[del(0, 1, 5)], &cat(), &caret);
    assert_eq!(c["offset"], json!(1), "지워진 범위 안이면 삭제 시작점");
    let c = map_caret_through(&[op("createTable", json!([0, 0, 0, 2, 2]))], &cat(), &caret);
    assert_eq!(c, caret, "텍스트 외 연산은 그대로(호스트가 범위로 자른다)");
}

// ── 위치 지도 단위 ──────────────────────────────────────────────────────

#[test]
fn map_pos_rules() {
    let body = Space::Body { sec: 0 };
    let d = TOp::Del { space: body.clone(), from: Pos::new(1, 2), to: Pos::new(3, 4), objects: true };
    assert_eq!(map_pos(Pos::new(1, 1), &d, Bias::After).pos, Pos::new(1, 1));
    assert_eq!(map_pos(Pos::new(2, 9), &d, Bias::After), Mapped { pos: Pos::new(1, 2), deleted: true });
    assert_eq!(map_pos(Pos::new(3, 6), &d, Bias::After).pos, Pos::new(1, 4));
    assert_eq!(map_pos(Pos::new(5, 1), &d, Bias::After).pos, Pos::new(3, 1));
    assert_eq!(map_para(2, &d), ParaFate::Gone(1));
    assert_eq!(map_para(3, &d), ParaFate::Touched(1));
    assert_eq!(map_para(5, &d), ParaFate::Kept(3));
    let m = TOp::Merge { space: body.clone(), para: 2, prev_len: 7 };
    assert_eq!(map_para(1, &m), ParaFate::Touched(1));
    assert_eq!(map_para(2, &m), ParaFate::Touched(1));
    assert_eq!(map_para(3, &m), ParaFate::Kept(2));
    let s = TOp::Split { space: body, at: Pos::new(1, 3), meta: None };
    assert_eq!(map_pos(Pos::new(1, 3), &s, Bias::Before).pos, Pos::new(1, 3));
    assert_eq!(map_pos(Pos::new(1, 3), &s, Bias::After).pos, Pos::new(2, 0));
}

#[test]
fn split_inside_delete_range_has_one_fate_in_both_directions() {
    // R5 에서 발견한 TP1 위반: 미확정 삭제가 원격 나눔 경계를 흡수하면, 원격 나눔을 미확정 삭제 뒤로 옮길 때도
    // 사라져야 한다. 반대로 미확정 나눔은 살아남고, 원격 삭제가 그 경계를 넘지 않게 쪼개진다.
    let body = Space::Body { sec: 0 };
    let d = TOp::Del { space: body.clone(), from: Pos::new(0, 7), to: Pos::new(2, 0), objects: true };
    let s = TOp::Split { space: body.clone(), at: Pos::new(1, 0), meta: None };
    // 미확정 삭제(Second) vs 원격 나눔 → 경계까지 지움, 원격 나눔(First) 은 흡수되어 사라짐
    assert_eq!(transform_text(&d, &s, Side::Second).unwrap(), vec![TOp::Del { space: body.clone(), from: Pos::new(0, 7), to: Pos::new(3, 0), objects: true }]);
    assert_eq!(transform_text(&s, &d, Side::First).unwrap(), vec![]);
    // 미확정 나눔(Second) vs 원격 삭제 → 삭제 시작점에서 나눔, 원격 삭제(First) 는 둘로 쪼개짐
    let s2 = TOp::Split { space: body.clone(), at: Pos::new(0, 9), meta: None };
    let d2 = TOp::Del { space: body.clone(), from: Pos::new(0, 7), to: Pos::new(1, 2), objects: true };
    assert_eq!(transform_text(&s2, &d2, Side::Second).unwrap(), vec![TOp::Split { space: body.clone(), at: Pos::new(0, 7), meta: None }]);
    assert_eq!(transform_text(&d2, &s2, Side::First).unwrap(), vec![
        TOp::Del { space: body.clone(), from: Pos::new(1, 0), to: Pos::new(2, 2), objects: true },
        TOp::Del { space: body, from: Pos::new(0, 7), to: Pos::new(0, 9), objects: true },
    ]);
    // 기록 열 수준: 미확정 [삭제(경계 흡수), 그 위의 입력] 이 원격 나눔 뒤에서도 같은 문단을 가리킨다
    let (got, _) = rb(&[range(0, 7, 2, 0), ins(0, 7, "x")], &[split(1, 0)]);
    assert_eq!(got, vec![("deleteRange".into(), json!([0, 0, 7, 3, 0])), ("insertText".into(), json!([0, 0, 7, "x"]))]);
}

// ── R11 빠른 경로 ────────────────────────────────────────────────────────

fn fast(pending: &[Value], remote: &[Value]) -> Result<Vec<(String, Value)>, String> {
    let out = rebase(pending, remote, &cat(), &Value::Null);
    match out["fastRemote"].as_array() {
        Some(rs) => Ok(rs.iter().map(|r| (r["m"].as_str().unwrap_or("state").to_string(), r["a"].clone())).collect()),
        None => Err(out["fastBlock"].as_str().unwrap_or("").to_string()),
    }
}
fn fmt(p: usize, s: usize, e: usize) -> Value {
    op("applyCharFormat", json!([0, p, s, e, "{\"bold\":true}"]))
}

#[test]
fn fast_path_moves_remote_through_my_edits_in_other_paragraphs() {
    // 내 입력(문단 0)과 원격 입력(문단 2): 원격은 그대로
    assert_eq!(fast(&[ins(0, 0, "AB")], &[ins(2, 4, "x")]).unwrap(), one("insertText", json!([0, 2, 4, "x"])));
    // 원격 Enter·합침이 내 편집보다 **뒤** 문단이면 내 편집은 그대로, 원격은 그대로
    assert_eq!(fast(&[ins(0, 1, "A")], &[split(2, 1)]).unwrap(), one("splitParagraph", json!([0, 2, 1])));
    assert_eq!(fast(&[del(0, 0, 1)], &[merge(3, 2)]).unwrap(), one("mergeParagraph", json!([0, 3])));
    // 내 Enter 가 원격 편집보다 뒤 문단이면 원격은 그대로
    assert_eq!(fast(&[split(4, 0)], &[ins(1, 0, "x"), del(2, 0, 1)]).unwrap(),
        vec![("insertText".into(), json!([0, 1, 0, "x"])), ("deleteText".into(), json!([0, 2, 0, 1]))]);
    // 원격 서식(다른 문단)과 내 입력
    assert_eq!(fast(&[ins(0, 0, "A")], &[fmt(2, 3, 5)]).unwrap(), one("applyCharFormat", json!([0, 2, 3, 5, "{\"bold\":true}"])));
    assert_eq!(fast(&[fmt(0, 3, 5)], &[ins(1, 0, "x")]).unwrap(), one("insertText", json!([0, 1, 0, "x"])));
    // 다른 구역은 언제나 독립
    assert_eq!(fast(&[ins_sec(1, 0, 0, "A")], &[split(0, 0)]).unwrap(), one("splitParagraph", json!([0, 0, 0])));
}

#[test]
fn fast_path_blocks_same_paragraph_and_order_sensitive_pairs() {
    let blocked = |p: &[Value], r: &[Value]| fast(p, r).expect_err("막혀야 한다");
    // 같은 문단: 글자만 같아도 문단 모델의 이력 흔적(글자 모양 구간 등)이 순서에 따라 달라진다
    assert!(blocked(&[ins(0, 0, "AB")], &[ins(0, 3, "x")]).contains("같은 문단"));
    assert!(blocked(&[ins(0, 5, "A")], &[fmt(0, 3, 5)]).contains("같은 문단"));
    assert!(blocked(&[split(0, 1)], &[op("applyParaFormat", json!([0, 0, "{}"]))]).contains("같은 문단"));
    // 합침은 앞 문단도 고친다, 여러 문단 삭제는 그 범위 전부
    assert!(blocked(&[merge(2, 3)], &[ins(1, 0, "x")]).contains("같은 문단"));
    assert!(blocked(&[range(0, 1, 2, 0)], &[ins(1, 0, "x")]).contains("같은 문단"));
    // 문단 수를 바꾸는 편집은 뒤 문단 전부를 고치는 것으로 본다(뒤 문단 줄 세로 위치, R5 재검증)
    assert!(blocked(&[range(1, 0, 2, 0)], &[ins(3, 0, "x")]).contains("같은 문단"));
    assert!(blocked(&[split(0, 2)], &[ins(5, 0, "x")]).contains("같은 문단"));
    assert!(blocked(&[ins(5, 0, "x")], &[merge(2, 1)]).contains("같은 문단"));
    assert!(blocked(&[fmt(0, 0, 2)], &[fmt(1, 0, 2)]).contains("서식끼리"), "서식끼리는 구역·문단이 달라도");
    // 문단을 특정할 수 없는 neutral (문서 전체 스타일 등)
    assert!(blocked(&[ins(0, 0, "A")], &[op("updateStyle", json!([1, "{}"]))]).contains("특정할 수 없는"));
    // 셀 텍스트는 표를 품은 본문 문단을 고친다
    let cell_del = op("deleteRangeInCell", json!([0, 2, 0, 0, 0, 0, 0, 1]));
    assert!(blocked(&[cell_del.clone()], &[op("setTableProperties", json!([0, 2, 0, "{}"]))]).contains("같은 문단"));
    assert!(fast(&[cell_del.clone()], &[ins(0, 0, "x")]).is_ok(), "앞 문단 본문 편집과는 독립");
    assert!(blocked(&[cell_del], &[ins(4, 0, "x")]).contains("같은 문단"), "셀 편집(표 높이)은 뒤 문단 세로 위치를 바꾼다");
    // 구조·state 와 겹치면 §4.5 충돌(미확정을 버림)이라 어차피 되감기 경로
    blocked(&[ins(0, 0, "A")], &[op("createTable", json!([0, 0, 0, 2, 2]))]);
    blocked(&[ins(0, 0, "A")], &[state()]);
    assert!(blocked(&[ins_sec(1, 0, 0, "A")], &[op("createTable", json!([0, 0, 0, 2, 2]))]).contains("텍스트·neutral"));
}

#[test]
fn replace_vs_replace_at_same_point_keeps_first_in_front_both_ways() {
    // R(먼저 확정): [0,2) 를 "글" 로, P: [0,1) 을 "나나" 로. 되감기 순서(R 다음 P')와 빠른 순서(P 다음 R')가
    // 같은 글 "글나나…" 이 되려면 R' 의 삽입은 P 의 글자 앞(0)이어야 한다.
    let p = op("replaceBodyTextLocal", json!([0, 0, 0, 1, "나나"]));
    let r = op("replaceBodyTextLocal", json!([0, 0, 0, 2, "글"]));
    let (pending, _) = rb(&[p.clone()], &[r.clone()]);
    assert_eq!(pending, one("replaceBodyTextLocal", json!([0, 0, 1, 0, "나나"])));
    let pr = classify(&p, &cat());
    let rr = classify(&r, &cat());
    let r2: Vec<(String, Value)> = transform_remote(&rr, &pr, &cat(), Mode::Rebase)
        .unwrap()
        .into_iter()
        .map(|x| (x.json["m"].as_str().unwrap().to_string(), x.json["a"].clone()))
        .collect();
    assert_eq!(r2, vec![("deleteText".into(), json!([0, 0, 2, 1])), ("insertText".into(), json!([0, 0, 0, "글"]))]);
}

#[test]
fn relogical_mark_survives_a_second_transform() {
    // 빠른 경로는 보정된 미확정을 적용하지 않고 들고 있다 — 다시 보정할 때 위치가 그대로여도 표시를 잇는다.
    let marked = json!({ "kind": "op", "m": "insertTextLogical", "a": [0, 2, 5, "뒤"], "meta": { "offset": 6, "afterControl": true, "len": 1, "relogical": true } });
    let out = rebase(&[marked], &[ins(0, 0, "ab")], &cat(), &Value::Null);
    assert_eq!(out["pending"][0]["meta"]["relogical"], json!(true));
    assert_eq!(out["pending"][0]["meta"]["offset"], json!(6));
}

#[test]
fn emitted_text_names_missing_from_catalog_slice_stay_text() {
    // 엔진은 입력 기록의 이름만 분류표 조각에 넣는다. 원격 deleteRange 가 내 삽입 둘레로 쪼개지면 deleteText 가 되는데,
    // 그 이름이 조각에 없어도 텍스트로 다뤄야 다음 미확정이 구조 충돌로 버려지지 않는다(R8 에서 발견).
    let slice = json!({
        "replaceBodyTextLocal": { "conc": "text", "section": 0 },
        "deleteRange": { "conc": "text", "section": 0 },
    });
    let rep = |o: usize, t: &str| json!({ "kind": "op", "m": "replaceBodyTextLocal", "a": [0, 0, o, 0, t], "meta": { "deleted": 0, "insLen": 1 } });
    let out = rebase(&[rep(7, "I"), rep(8, "N")], &[range(0, 2, 0, 12)], &slice, &Value::Null);
    assert_eq!(out["dropFrom"], Value::Null, "충돌 없음: {out}");
    let a: Vec<Value> = out["pending"].as_array().unwrap().iter().map(|r| r["a"].clone()).collect();
    assert_eq!(a, vec![json!([0, 0, 2, 0, "I"]), json!([0, 0, 3, 0, "N"])], "각자 친 글자가 이어진다");
}

// ── R13 (§4.6) ──────────────────────────────────────────────────────────

fn cat13() -> Value {
    let mut c = cat();
    for m in ["insertTextInCell", "deleteTextInCell", "splitParagraphInCell", "mergeParagraphInCell", "insertTextInCellByPath"] {
        c[m] = json!({ "conc": "text", "section": 0 });
    }
    c["createTable"] = json!({ "conc": "structural", "section": 0, "roles": [{ "kind": "anchor", "arg": 1 }] });
    c["insertTableRow"] = json!({ "conc": "structural", "section": 0, "roles": [{ "kind": "anchor", "arg": 1, "control": 2 }] });
    c
}
fn rb13(pending: &[Value], remote: &[Value]) -> Value {
    rebase(pending, remote, &cat13(), &Value::Null)
}
fn names_args(out: &Value) -> Vec<(String, Value)> {
    out["pending"].as_array().unwrap().iter().map(|r| (r["m"].as_str().unwrap().to_string(), r["a"].clone())).collect()
}
fn cins(pp: usize, ci: usize, cell: usize, cp: usize, o: usize, t: &str) -> Value {
    json!({ "kind": "op", "m": "insertTextInCell", "a": [0, pp, ci, cell, cp, o, t], "meta": { "len": t.chars().count() } })
}
fn table(p: usize, pd: i64) -> Value {
    json!({ "kind": "op", "m": "createTable", "a": [0, p, 0, 2, 2], "meta": { "pd": pd } })
}
fn row(pp: usize, ci: usize) -> Value {
    json!({ "kind": "op", "m": "insertTableRow", "a": [0, pp, ci, 0, true], "meta": { "pd": 0 } })
}

#[test]
fn cell_text_same_cell_transforms_and_other_cells_are_independent() {
    // 같은 칸: 원격이 앞에 넣으면 밀린다
    let out = rb13(&[cins(2, 0, 1, 0, 3, "B")], &[cins(2, 0, 1, 0, 0, "AA")]);
    assert_eq!(names_args(&out), one("insertTextInCell", json!([0, 2, 0, 1, 0, 5, "B"])));
    // 다른 칸·다른 표는 서로 영향 없음
    let out = rb13(&[cins(2, 0, 1, 0, 3, "B")], &[cins(2, 0, 2, 0, 0, "AA"), cins(2, 1, 1, 0, 0, "CC")]);
    assert_eq!(names_args(&out), one("insertTextInCell", json!([0, 2, 0, 1, 0, 3, "B"])));
    // 앞 본문 Enter 는 표를 품은 문단 번호를 민다, 그 문단을 나누면 충돌
    let out = rb13(&[cins(2, 0, 1, 0, 3, "B")], &[split(0, 1)]);
    assert_eq!(names_args(&out), one("insertTextInCell", json!([0, 3, 0, 1, 0, 3, "B"])));
    assert_eq!(rb13(&[cins(2, 0, 1, 0, 3, "B")], &[split(2, 0)])["dropFrom"], json!(0));
}

#[test]
fn nested_cell_path_round_trips_and_outer_cell_split_moves_inner_host() {
    // 바깥 표(문단 1, 개체 0) 칸 2 의 칸 문단 3 에 든 안쪽 표(개체 0) 칸 1 의 칸 문단 0
    let path = json!([{ "controlIndex": 0, "cellIndex": 2, "cellParaIndex": 3 }, { "controlIndex": 0, "cellIndex": 1, "cellParaIndex": 0 }]).to_string();
    let inner = json!({ "kind": "op", "m": "insertTextInCellByPath", "a": [0, 1, path, 2, "x"], "meta": { "len": 1 } });
    let t = parse_text(&inner).unwrap();
    assert_eq!(t.space(), &Space::Cell { sec: 0, hosts: vec![1, 3], chain: vec![(0, 2), (0, 1)] });
    // 바깥 칸에서 칸 문단 0 을 나누면 안쪽 표를 품은 칸 문단 3 → 4
    let outer_split = json!({ "kind": "op", "m": "splitParagraphInCell", "a": [0, 1, 0, 2, 0, 0, null], "meta": {} });
    let out = rb13(&[inner], &[outer_split]);
    let r = &out["pending"][0];
    assert_eq!(r["m"], json!("insertTextInCellByPath"));
    let steps: Value = serde_json::from_str(r["a"][2].as_str().unwrap()).unwrap();
    assert_eq!(steps[0]["cellParaIndex"], json!(4));
    assert_eq!(steps[1]["cellParaIndex"], json!(0));
}

#[test]
fn structural_footprint_conflicts_inside_and_shifts_outside() {
    // 원격 표 만들기(문단 2, 문단 +3): 뒤 문단 6 의 내 입력은 9 로, 문단 2 의 입력은 충돌
    assert_eq!(names_args(&rb13(&[ins(6, 0, "x")], &[table(2, 3)])), one("insertText", json!([0, 9, 0, "x"])));
    assert_eq!(names_args(&rb13(&[ins(1, 0, "x")], &[table(2, 3)])), one("insertText", json!([0, 1, 0, "x"])));
    assert_eq!(rb13(&[ins(2, 0, "x")], &[table(2, 3)])["dropReason"], json!("구조 변경 연산의 발자국과 겹침"));
    // 내 표 만들기는 앞 문단 Enter 만큼 기준이 밀리고, 뒤 문단 편집과는 겹치지 않는다
    assert_eq!(names_args(&rb13(&[table(4, 3)], &[split(1, 0)])), one("createTable", json!([0, 5, 0, 2, 2])));
    assert_eq!(names_args(&rb13(&[table(4, 3)], &[ins(7, 0, "y")])), one("createTable", json!([0, 4, 0, 2, 2])));
    // 구조끼리: 발자국이 떨어져 있으면 둘 다 산다
    assert_eq!(names_args(&rb13(&[table(8, 3)], &[table(2, 3)])), one("createTable", json!([0, 11, 0, 2, 2])));
    assert!(rb13(&[table(2, 3)], &[table(2, 3)])["dropFrom"].is_number());
}

#[test]
fn table_structure_footprint_is_the_table_only() {
    // 행 넣기(문단 4 의 표 0): 그 문단 글자 입력·다른 표의 칸 입력과는 겹치지 않고, 그 표의 칸 입력과는 겹친다
    assert_eq!(names_args(&rb13(&[row(4, 0)], &[ins(4, 0, "x")])), one("insertTableRow", json!([0, 4, 0, 0, true])));
    assert_eq!(names_args(&rb13(&[cins(4, 1, 0, 0, 0, "x")], &[row(4, 0)])), one("insertTextInCell", json!([0, 4, 1, 0, 0, 0, "x"])));
    assert!(rb13(&[cins(4, 0, 0, 0, 0, "x")], &[row(4, 0)])["dropFrom"].is_number());
    // 그 문단을 나누면 표가 옮겨질 수 있으니 충돌
    assert!(rb13(&[row(4, 0)], &[split(4, 0)])["dropFrom"].is_number());
}

#[test]
fn dropping_an_op_keeps_the_tail_through_its_inverse() {
    // 내 표 만들기(문단 5, +3)가 원격 입력(문단 5)과 겹쳐 버려진다. 그 뒤 내 입력(표 뒤 문단 9 = 원래 6)은 살아서 6 으로 간다.
    let out = rb13(&[table(5, 3), ins(9, 0, "z")], &[ins(5, 0, "r")]);
    assert_eq!(out["dropped"], json!([0]));
    assert_eq!(names_args(&out), one("insertText", json!([0, 6, 0, "z"])));
    // 표가 만든 문단(6~8) 안의 입력은 함께 버린다
    let out = rb13(&[table(5, 3), ins(7, 0, "z")], &[ins(5, 0, "r")]);
    assert_eq!(out["dropped"], json!([0, 1]));
    // 서식이 버려져도(neutral) 뒤 입력은 그대로
    let out = rb13(&[op("applyCharFormat", json!([0, 0, 2, 6, "{}"])), ins(0, 3, "x")], &[split(0, 4)]);
    assert_eq!(out["dropped"], json!([0]));
    assert_eq!(names_args(&out), one("insertText", json!([0, 0, 3, "x"])));
    // 텍스트 되돌림: 버린 입력 뒤에 친 글자는 그만큼 당겨진다
    let state_like = op("createStyle", json!([1]));
    let out = rb13(&[ins(0, 0, "abc"), state_like], &[ins(0, 0, "r")]);
    assert_eq!(out["dropped"], json!([1]), "발자국 없는 구조는 구역 단위 충돌");
    // 되돌릴 수 없는 것(state)을 버리면 뒤는 모두 버린다
    let out = rb13(&[state(), ins(0, 0, "x")], &[ins(0, 0, "r")]);
    assert_eq!(out["dropped"], json!([0, 1]));
}

#[test]
fn cell_edit_does_not_move_body_anchor_of_structural_op() {
    // 문단 0 의 붙여넣기(발자국 문단 0) vs 문단 6 표 칸 안의 문단 나눔: 서로 무관
    let split_in_cell = json!({ "kind": "op", "m": "splitParagraphInCell", "a": [0, 6, 0, 2, 0, 0, null], "meta": {} });
    assert_eq!(names_args(&rb13(&[table(0, 3)], &[split_in_cell])), one("createTable", json!([0, 0, 0, 2, 2])));
}

#[test]
fn delete_range_in_one_paragraph_may_delete_objects() {
    // 한 문단 안 deleteRange 는 표 같은 개체도 지운다 — 그 문단의 표 칸 편집은 충돌, 다시 내보낼 때도 deleteRange
    let cell_ins = cins(1, 0, 0, 0, 0, "x");
    assert!(rb13(&[cell_ins.clone()], &[range(1, 0, 1, 2)])["dropFrom"].is_number(), "표가 지워졌을 수 있다");
    assert_eq!(names_args(&rb13(&[cell_ins], &[del(1, 0, 2)])).len(), 1, "deleteText 는 글자만 — 칸 편집은 산다");
    let out = rb13(&[range(0, 2, 0, 6)], &[ins(0, 0, "ab")]);
    assert_eq!(names_args(&out), one("deleteRange", json!([0, 0, 4, 0, 8])), "옮겨도 deleteRange 로 잇는다");
}

// ── 4단계 U1: 되돌리기 스택의 위치 옮기기·발자국 ─────────────────────────────────

fn cat4() -> Value {
    let mut c = cat();
    c["insertTextInCell"] = json!({ "conc": "text", "section": 0 });
    c["applyCharFormatInCell"] = json!({ "conc": "neutral", "section": 0, "roles": [{ "kind": "anchor", "arg": 1 }] });
    c["insertTextInCellByPath"] = json!({ "conc": "text", "section": 0 });
    c
}
fn body(p: usize, o: usize) -> Value {
    json!({ "section": 0, "para": p, "offset": o })
}
fn cellpos(pp: usize, ci: usize, cell: usize, cp: usize, o: usize) -> Value {
    json!({ "section": 0, "para": pp, "offset": o, "cell": { "control": ci, "cell": cell, "cellPara": cp } })
}
fn cell_ins(pp: usize, ci: usize, cell: usize, cp: usize, o: usize, t: &str) -> Value {
    json!({ "kind": "op", "m": "insertTextInCell", "a": [0, pp, ci, cell, cp, o, t], "meta": { "len": t.chars().count() } })
}
/// (문단, 글자, hit) — 셀이면 문단은 칸 문단.
fn mp(recs: &[Value], item: Value) -> (usize, usize, Option<String>) {
    let out = map_positions(recs, &cat4(), &[item]);
    let v = &out[0];
    let para = if v["cell"].is_null() { v["para"].as_u64().unwrap() } else { v["cell"]["cellPara"].as_u64().unwrap() } as usize;
    (para, v["offset"].as_u64().unwrap() as usize, v["hit"].as_str().map(String::from))
}

#[test]
fn undo_positions_move_with_edits_elsewhere_and_flag_same_paragraph() {
    // 다른 문단 입력: 그대로, 막힘 없음
    assert_eq!(mp(&[ins(1, 0, "abc")], body(3, 2)), (3, 2, None));
    // 앞 문단 Enter: 문단 번호만 밀림(3.1 — 막지 않음)
    assert_eq!(mp(&[split(1, 2)], body(3, 2)), (4, 2, None));
    // 앞 문단 합침: 당겨짐
    assert_eq!(mp(&[merge(2, 5)], body(3, 2)), (2, 2, None));
    // 같은 문단 입력(앞이든 뒤든) → touched (3.2-1, 글자도 막는다)
    assert_eq!(mp(&[ins(3, 9, "x")], body(3, 2)).2.as_deref(), Some("touched"));
    assert_eq!(mp(&[ins(3, 0, "x")], body(3, 2)), (3, 3, Some("touched".into())));
    // 같은 문단을 나눔 → touched
    assert_eq!(mp(&[split(3, 5)], body(3, 2)).2.as_deref(), Some("touched"));
    // 문단을 통째로 지움 → gone
    assert_eq!(mp(&[range(2, 0, 4, 0)], body(3, 2)).2.as_deref(), Some("gone"));
    // 같은 문단 서식(neutral) → touched, 다른 문단 서식 → 없음
    assert_eq!(mp(&[op("applyCharFormat", json!([0, 3, 0, 1, "{}"]))], body(3, 2)).2.as_deref(), Some("touched"));
    assert_eq!(mp(&[op("applyCharFormat", json!([0, 4, 0, 1, "{}"]))], body(3, 2)).2, None);
    // 같은 구역 구조 편집 → structural (3.2-2), 다른 구역 → 없음
    assert_eq!(mp(&[op("createTable", json!([0, 7, 0, 2, 2]))], body(3, 2)).2.as_deref(), Some("structural"));
    assert_eq!(mp(&[op("createTable", json!([1, 7, 0, 2, 2]))], body(3, 2)).2, None);
    // state → whole
    assert_eq!(mp(&[state()], body(3, 2)).2.as_deref(), Some("whole"));
    // 다른 구역 글자 → 없음
    assert_eq!(mp(&[ins_sec(1, 3, 0, "x")], body(3, 2)), (3, 2, None));
    // 첫 사유만 남는다
    assert_eq!(mp(&[ins(3, 0, "x"), state()], body(3, 2)).2.as_deref(), Some("touched"));
}

#[test]
fn undo_positions_bias_follows_content_at_split_point() {
    // 기본(after): 나눔 지점에 있던 위치는 뒤 문단으로 따라간다 — 내 Enter 를 되돌리면(merge) 원래 자리
    let after = map_positions(&[split(3, 4)], &cat4(), &[body(3, 4)]);
    assert_eq!((after[0]["para"].as_u64(), after[0]["offset"].as_u64()), (Some(4), Some(0)));
    let back = map_positions(&[merge(4, 4)], &cat4(), &[after[0].clone()]);
    assert_eq!((back[0]["para"].as_u64(), back[0]["offset"].as_u64()), (Some(3), Some(4)));
    // before: 범위 끝처럼 앞에 남는다
    let mut b = body(3, 4);
    b["bias"] = json!("before");
    let out = map_positions(&[split(3, 4)], &cat4(), &[b]);
    assert_eq!((out[0]["para"].as_u64(), out[0]["offset"].as_u64()), (Some(3), Some(4)));
}

#[test]
fn undo_positions_in_cells() {
    // 같은 칸 같은 칸 문단 입력 → touched, 같은 칸 다른 칸 문단 → 없음, 다른 칸 → 없음
    assert_eq!(mp(&[cell_ins(2, 0, 1, 0, 0, "x")], cellpos(2, 0, 1, 0, 3)), (0, 4, Some("touched".into())));
    assert_eq!(mp(&[cell_ins(2, 0, 1, 1, 0, "x")], cellpos(2, 0, 1, 0, 3)), (0, 3, None));
    assert_eq!(mp(&[cell_ins(2, 0, 2, 0, 0, "x")], cellpos(2, 0, 1, 0, 3)), (0, 3, None));
    // 본문에서 표 앞 문단 Enter → 표를 품은 문단 번호만 밀림
    let out = map_positions(&[split(0, 0)], &cat4(), &[cellpos(2, 0, 1, 0, 3)]);
    assert_eq!((out[0]["para"].as_u64(), out[0]["hit"].clone()), (Some(3), Value::Null));
    // 표를 품은 문단 안 글자 입력은 칸과 무관
    assert_eq!(mp(&[ins(2, 0, "x")], cellpos(2, 0, 1, 0, 3)).2, None);
    // 같은 칸 문단 서식 → touched, 다른 칸 서식 → 없음
    assert_eq!(mp(&[op("applyCharFormatInCell", json!([0, 2, 0, 1, 0, 0, 1, "{}"]))], cellpos(2, 0, 1, 0, 3)).2.as_deref(), Some("touched"));
    assert_eq!(mp(&[op("applyCharFormatInCell", json!([0, 2, 0, 2, 0, 0, 1, "{}"]))], cellpos(2, 0, 1, 0, 3)).2, None);
    // 셀 위치의 칸 문단 안 중첩 표 편집 → touched
    let nested = json!({ "kind": "op", "m": "insertTextInCellByPath", "a": [0, 2, "[{\"controlIndex\":0,\"cellIndex\":1,\"cellParaIndex\":0},{\"controlIndex\":0,\"cellIndex\":0,\"cellParaIndex\":0}]", 0, "x"], "meta": { "len": 1 } });
    assert_eq!(mp(&[nested], cellpos(2, 0, 1, 0, 3)).2.as_deref(), Some("touched"));
}

fn fp(entries: &[Value]) -> (Vec<(usize, Option<usize>)>, bool, bool) {
    let out = footprint(entries, &cat4());
    let items = out["items"].as_array().unwrap().iter().map(|v| (v["para"].as_u64().unwrap() as usize, v["cell"]["cellPara"].as_u64().map(|x| x as usize))).collect();
    (items, out["whole"].as_bool().unwrap(), out["nested"].as_bool().unwrap())
}

#[test]
fn footprint_of_a_command_is_the_paragraphs_it_left_changed() {
    assert_eq!(fp(&[ins(3, 0, "ab"), ins(3, 2, "c")]), (vec![(3, None)], false, false));
    // Enter: 앞뒤 두 문단
    assert_eq!(fp(&[split(3, 2)]), (vec![(3, None), (4, None)], false, false));
    // 입력 뒤 앞 문단에서 Enter(같은 명령 안): 입력 문단이 밀린 번호로
    assert_eq!(fp(&[ins(3, 0, "ab"), split(1, 0)]), (vec![(4, None), (1, None), (2, None)], false, false));
    // 여러 문단 지움: 남은 한 문단
    assert_eq!(fp(&[range(2, 1, 4, 0)]), (vec![(2, None)], false, false));
    // Backspace 로 합침: 앞 문단
    assert_eq!(fp(&[merge(4, 3)]), (vec![(3, None)], false, false));
    // 서식
    assert_eq!(fp(&[op("applyCharFormat", json!([0, 5, 0, 2, "{}"]))]), (vec![(5, None)], false, false));
    assert_eq!(fp(&[op("applyParaFormat", json!([0, 5, "{}"])), op("applyParaFormat", json!([0, 6, "{}"]))]), (vec![(5, None), (6, None)], false, false));
    // 셀
    assert_eq!(fp(&[cell_ins(2, 0, 1, 1, 0, "x")]), (vec![(2, Some(1))], false, false));
    assert_eq!(fp(&[op("applyCharFormatInCell", json!([0, 2, 0, 1, 0, 0, 1, "{}"]))]), (vec![(2, Some(0))], false, false));
    // 결과 전송·구조(발자국 없음)·역할 없는 neutral → whole
    assert!(fp(&[state()]).1);
    assert!(fp(&[op("createTable", json!([0, 7, 0, 2, 2]))]).1);
    assert!(fp(&[op("updateStyle", json!([1, "{}"]))]).1);
    // 중첩 셀
    let nested = json!({ "kind": "op", "m": "insertTextInCellByPath", "a": [0, 2, "[{\"controlIndex\":0,\"cellIndex\":1,\"cellParaIndex\":0},{\"controlIndex\":0,\"cellIndex\":0,\"cellParaIndex\":0}]", 0, "x"], "meta": { "len": 1 } });
    assert!(fp(&[nested]).2);
}

#[test]
fn rebase_reports_origin_and_remote_after_pending() {
    // 미확정 2개(문단 1, 문단 3), 원격은 문단 0 에서 Enter
    let out = rebase(&[ins(1, 0, "a"), ins(3, 0, "b")], &[split(0, 0)], &cat4(), &Value::Null);
    assert_eq!(out["origin"], json!([0, 1]));
    // 원격을 미확정 뒤로 옮긴 열(이 경우 미확정이 원격 앞 문단을 바꾸지 않으므로 같은 자리)
    assert_eq!(out["remoteAfter"].as_array().unwrap().len(), 1);
    assert_eq!(out["remoteAfter"][0]["a"], json!([0, 0, 0]));
    // 미확정이 원격 위치를 민다: 내 입력이 같은 문단 앞이면 원격 Enter 자리가 뒤로
    let out = rebase(&[ins(0, 0, "xy")], &[split(0, 1)], &cat4(), &Value::Null);
    assert_eq!(out["remoteAfter"][0]["a"], json!([0, 0, 3]));
    // 버린 미확정은 origin 에 없다(구역 1 의 구조 편집끼리 충돌, 구역 0 의 입력은 남음)
    let out = rebase(&[ins(1, 0, "a"), op("createTable", json!([1, 2, 0, 1, 1]))], &[op("createTable", json!([1, 5, 0, 1, 1]))], &cat4(), &Value::Null);
    assert_eq!(out["origin"], json!([0]));
    assert_eq!(out["dropped"], json!([1]));
}

#[test]
fn rebase_reports_the_undo_of_dropped_pending_as_a_map() {
    // 내 Enter(문단 1 처음)가 같은 구역 구조 편집(발자국 없음)과 충돌해 버려진다 → 되돌림 열 = 그 문단 합침
    let out = rebase(&[split(1, 0)], &[op("createTable", json!([0, 5, 0, 1, 1]))], &cat4(), &Value::Null);
    assert_eq!(out["dropped"], json!([0]));
    assert_eq!(out["dropUndoComplete"], json!(true));
    let undo = out["dropUndo"].as_array().unwrap();
    assert_eq!(undo.len(), 1);
    assert_eq!((undo[0]["m"].as_str(), undo[0]["a"].clone()), (Some("mergeParagraph"), json!([0, 2])));
    // 그 지도로 버리기 전 좌표의 뒤 문단 위치가 원래 번호로 돌아온다(문단 6 → 5)
    let back = map_positions(undo, &cat4(), &[body(6, 1)]);
    assert_eq!(back[0]["para"], json!(5));
    // 구조 발자국(문단 수 +1)을 버리면 지도 전용 기록으로 그 뒤 문단을 당긴다
    let mut c = cat4();
    c["createTableA"] = json!({ "conc": "structural", "section": 0, "roles": [{ "kind": "anchor", "arg": 1 }] });
    let mine = json!({ "kind": "op", "m": "createTableA", "a": [0, 2, 0, 1, 1], "meta": { "pd": 1 } });
    let theirs = json!({ "kind": "op", "m": "createTableA", "a": [0, 2, 0, 1, 1], "meta": { "pd": 1 } });
    let out = rebase(&[mine], &[theirs], &c, &Value::Null);
    assert_eq!(out["dropped"], json!([0]));
    let undo = out["dropUndo"].as_array().unwrap();
    assert_eq!(undo[0]["m"], json!(UNDO_FOOT));
    assert_eq!(map_positions(undo, &c, &[body(6, 1)])[0]["para"], json!(5));
    // 되돌릴 수 없는 것(state)을 버리면 불완전
    let out = rebase(&[state()], &[op("createTable", json!([0, 5, 0, 1, 1]))], &cat4(), &Value::Null);
    assert_eq!(out["dropUndoComplete"], json!(false));
}

#[test]
fn set_char_shape_runs_with_paragraph_footprint_moves_and_conflicts_by_paragraph() {
    // 4단계: setCharShapeRuns 는 문단 발자국(anchor) 구조 연산 — 다른 문단 편집에는 문단 번호만 옮기고, 같은 문단과는 충돌
    let mut c = cat4();
    c["setCharShapeRuns"] = json!({ "conc": "structural", "section": 0, "roles": [{ "kind": "anchor", "arg": 1 }] });
    let runs = |p: usize| json!({ "kind": "op", "m": "setCharShapeRuns", "a": [0, p, 0, 2, "[{\"startOffset\":0,\"endOffset\":2,\"charShapeId\":0}]"], "meta": { "pd": 0 } });
    // 내 되돌리기(문단 3)가 미확정, 남이 문단 0 에서 Enter → 문단 번호만 4 로
    let out = rebase(&[runs(3)], &[split(0, 1)], &c, &Value::Null);
    assert_eq!(out["dropped"], json!([]));
    assert_eq!(out["pending"][0]["a"][1], json!(4));
    // 빠른 경로(R11)는 text·neutral 만 — 구조 연산은 발자국이 있어도 언제나 되감기(R11 관문 대상 밖)
    assert!(out["fastRemote"].is_null());
    assert_eq!(out["fastBlock"].as_str(), Some("빠른 경로 불가: 텍스트·neutral 외 기록"));
    // 같은 문단을 남이 고치면 충돌(버림), 빠른 경로 아님
    let out = rebase(&[runs(3)], &[ins(3, 0, "x")], &c, &Value::Null);
    assert_eq!(out["dropped"], json!([0]));
    assert!(out["fastRemote"].is_null());
}
