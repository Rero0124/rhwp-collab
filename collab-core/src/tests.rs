//! 공동편집 코어 보조 검증 (docs/collab-stage2.md §5, R3).
//!
//! 1단계의 기록 테스트(가로채기·outbox·복원 desync·deleteRange 가로채기)는 기록이 JS 기록 훅으로 옮겨 가며
//! 코드와 함께 은퇴했다. 여기서는 엔진이 쓰는 Rust 보조 기능을 실제 `DocumentCore` 위에서 확인한다.

use super::*;
use serde_json::json;

fn blank() -> DocumentCore {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().expect("빈 문서 생성");
    core
}

fn texts(core: &DocumentCore) -> Vec<String> {
    core.document.sections[0].paragraphs.iter().map(|p| p.text.clone()).collect()
}

fn sample(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/{}", env!("CARGO_MANIFEST_DIR"), name)).expect("샘플")
}

fn assert_converged(a: &CollabCore, b: &CollabCore) {
    assert_eq!(texts(a), texts(b), "문단 텍스트가 다르다");
    assert_eq!(a.digest(), b.digest(), "모델 digest 가 다르다");
    let bytes_a = a.export_hwp_native().expect("A 내보내기");
    let bytes_b = b.export_hwp_native().expect("B 내보내기");
    assert!(bytes_a == bytes_b, "내보낸 HWP 바이트가 다르다 ({} vs {})", bytes_a.len(), bytes_b.len());
}

/// 테스트용 재생기: 기록을 같은 이름의 코어 메서드로 적용한다(브라우저에서는 같은 export 를 다시 부른다).
fn apply(core: &mut CollabCore, rec: &Value) -> Result<(), HwpError> {
    let m = rec["m"].as_str().unwrap();
    let a = rec["a"].as_array().unwrap();
    let n = |i: usize| a[i].as_u64().unwrap() as usize;
    let s = |i: usize| a[i].as_str().unwrap();
    match m {
        "insertText" => core.insert_text_native(n(0), n(1), n(2), s(3)).map(drop),
        "insertTextLogical" => {
            // 처음 적용은 논리 인자 그대로. 재적용(meta 있음)은 텍스트 좌표를 그 시점 문서의 논리 오프셋으로
            // 바꿔 부른다(엔진 규칙).
            let meta = &rec["meta"];
            let logical = match (meta["offset"].as_u64(), meta["afterControl"].as_bool()) {
                (Some(o), Some(after)) => core.text_to_logical(n(0), n(1), o as usize, after)?,
                _ => n(2),
            };
            let (off, after) = core.logical_to_text(n(0), n(1), logical)?;
            core.insert_text_at_caret_native(n(0), n(1), off, after, s(3)).map(drop)
        }
        "deleteText" => core.delete_text_native(n(0), n(1), n(2), n(3)).map(drop),
        "replaceBodyTextLocal" => core.replace_body_text_local_native(n(0), n(1), n(2), n(3), s(4)).map(drop),
        "splitParagraph" => core.split_paragraph_native(n(0), n(1), n(2), None).map(drop),
        "mergeParagraph" => core.merge_paragraph_native(n(0), n(1)).map(drop),
        "deleteRange" => core.delete_range_native(n(0), n(1), n(2), n(3), n(4), None).map(drop),
        "applyCharFormat" => core.apply_char_format_native(n(0), n(1), n(2), n(3), s(4)).map(drop),
        "applyParaFormat" => core.apply_para_format_native(n(0), n(1), s(2)).map(drop),
        "createTable" => core.create_table_native(n(0), n(1), n(2), n(3) as u16, n(4) as u16).map(drop),
        "insertTextInCell" => core.insert_text_in_cell_native(n(0), n(1), n(2), n(3), n(4), n(5), s(6)).map(drop),
        "deleteTextInCell" => core.delete_text_in_cell_native(n(0), n(1), n(2), n(3), n(4), n(5), n(6)).map(drop),
        "splitParagraphInCell" => core.split_paragraph_in_cell_native(n(0), n(1), n(2), n(3), n(4), n(5), None).map(drop),
        "mergeParagraphInCell" => core.merge_paragraph_in_cell_native(n(0), n(1), n(2), n(3), n(4)).map(drop),
        other => panic!("테스트 재생기에 없는 메서드 {other}"),
    }
}

/// 기록 훅이 하는 일: 호출 전후로 측정해 meta 를 붙인다.
fn record(core: &mut CollabCore, m: &str, a: Value) -> Value {
    let args = a.as_array().unwrap().clone();
    let before = core.measure("before", m, &args, &Value::Null).unwrap();
    let mut rec = json!({ "kind": "op", "m": m, "a": a });
    apply(core, &rec).expect("로컬 적용");
    let after = core.measure("after", m, &args, &before).unwrap();
    assert_eq!(after["ok"], json!(true), "{m}: 불변식 {after}");
    if !after["meta"].is_null() {
        rec["meta"] = after["meta"].clone();
    }
    rec
}

fn catalog() -> Value {
    json!({
        "insertText": { "conc": "text", "section": 0 },
        "insertTextLogical": { "conc": "text", "section": 0 },
        "deleteText": { "conc": "text", "section": 0 },
        "replaceBodyTextLocal": { "conc": "text", "section": 0 },
        "splitParagraph": { "conc": "text", "section": 0 },
        "mergeParagraph": { "conc": "text", "section": 0 },
        "deleteRange": { "conc": "text", "section": 0 },
        "applyCharFormat": { "conc": "neutral", "section": 0, "roles": [{ "kind": "range", "para": 1, "start": 2, "end": 3 }] },
        "applyParaFormat": { "conc": "neutral", "section": 0, "roles": [{ "kind": "para", "arg": 1 }] },
    })
}

// ── 오프셋 단위 (S2-T1) ──────────────────────────────────────────────────

/// S2-T1: 코어 연산의 오프셋 단위 확인 (docs/collab-stage2.md §3).
///
/// 오프셋은 `para.text` 의 유니코드 스칼라 인덱스다. 인라인 개체(수식·표·그림 등)는 `text` 에 없고
/// 자리를 차지하지 않는다 — 같은 오프셋에서 개체 앞/뒤는 `after_inline_control` 로만 갈린다.
/// studio 커서·`insertTextLogical` 의 "논리 오프셋"(논리 인라인 개체를 1 로 셈)과 다르다.
#[test]
fn offsets_are_text_scalar_indices_excluding_inline_controls() {
    use crate::document_core::helpers::{find_control_text_positions, logical_to_text_offset};
    let bytes = sample("samples/hml/exambank_math_equations_min.hwp");
    let fresh = || CollabCore::new(DocumentCore::from_bytes(&bytes).expect("열기"));
    let para = |c: &CollabCore| c.document.sections[0].paragraphs[2].clone();

    let core = fresh();
    let p = para(&core);
    assert_eq!(p.text, "다항식 을 전개하시오.");
    assert_eq!(find_control_text_positions(&p), vec![4]);
    assert_eq!(core.get_paragraph_length_native(0, 2).unwrap(), 12, "개체는 길이에 없다");
    assert_eq!(&p.char_offsets[3..5], &[3, 12], "개체는 UTF-16 8 유닛을 차지하지만 글자 인덱스는 아니다");

    // 논리 오프셋은 논리 인라인 개체만 1 로 센다. 이 수식은 글자처럼 취급이 아니다.
    assert!(!p.controls[0].is_logical_inline());
    assert_eq!(logical_to_text_offset(&p, 5), (5, false));
    let mut inline = p.clone();
    if let crate::model::control::Control::Equation(eq) = &mut inline.controls[0] {
        eq.common.treat_as_char = true;
    }
    assert!(inline.controls[0].is_logical_inline());
    assert_eq!(logical_to_text_offset(&inline, 4), (4, false));
    assert_eq!(logical_to_text_offset(&inline, 5), (4, true));
    assert_eq!(logical_to_text_offset(&inline, 6), (5, false));

    let mut core = fresh();
    core.insert_text_native(0, 2, 4, "X").unwrap();
    assert_eq!(para(&core).text, "다항식 X을 전개하시오.");
    assert_eq!(find_control_text_positions(&para(&core)), vec![5], "개체 앞에 들어가 개체가 밀림");
    let mut core = fresh();
    core.insert_text_at_caret_native(0, 2, 4, true, "Y").unwrap();
    assert_eq!(para(&core).text, "다항식 Y을 전개하시오.");
    assert_eq!(find_control_text_positions(&para(&core)), vec![4], "개체 뒤에 들어가 개체는 그대로");

    let mut core = fresh();
    core.delete_text_native(0, 2, 3, 2).unwrap();
    // "다항식 을 전개하시오." 의 인덱스 3(공백)·4(을) 를 지운다.
    assert_eq!(para(&core).text, "다항식 전개하시오.");
    assert_eq!(para(&core).controls.len(), 1, "개체는 지워지지 않는다");
    assert_eq!(find_control_text_positions(&para(&core)), vec![3]);

    let mut core = CollabCore::new(blank());
    core.insert_text_native(0, 0, 0, "a😀가").unwrap();
    assert_eq!(core.get_paragraph_length_native(0, 0).unwrap(), 3);
    core.insert_text_native(0, 0, 2, "b").unwrap();
    assert_eq!(texts(&core)[0], "a😀b가");
    core.delete_text_native(0, 0, 2, 100).unwrap();
    assert_eq!(texts(&core)[0], "a😀", "범위를 넘는 삭제는 잘린다 — count 는 실측해야 한다");
}

// ── 결정성·digest ────────────────────────────────────────────────────────

#[test]
fn same_calls_on_two_documents_converge_to_identical_bytes_and_digest() {
    let mut a = CollabCore::new(blank());
    let mut b = CollabCore::new(blank());
    for core in [&mut a, &mut b] {
        core.insert_text_native(0, 0, 0, "첫째 줄 둘째 줄").unwrap();
        core.split_paragraph_native(0, 0, 5, None).unwrap();
        core.replace_body_text_local_native(0, 0, 0, 2, "1번").unwrap();
        core.delete_text_native(0, 1, 2, 2).unwrap();
        core.merge_paragraph_native(0, 1).unwrap();
        core.apply_char_format_native(0, 0, 0, 2, r#"{"bold":true}"#).unwrap();
    }
    assert_converged(&a, &b);
}

#[test]
fn digest_ignores_per_user_caret_and_rendering_but_sees_edits() {
    let mut a = CollabCore::new(blank());
    let b = CollabCore::new(blank());
    let d0 = a.digest();
    assert_eq!(d0.len(), 64);
    a.set_caret_position_native(0, 0, 0);
    assert_eq!(a.digest(), b.digest(), "캐럿 기록은 digest 밖");
    a.insert_text_native(0, 0, 0, "조판 전후로 같아야 하는 문단").unwrap();
    let d1 = a.digest();
    assert_ne!(d1, d0);
    let _ = a.flush_deferred_pagination();
    let _ = a.render_page_svg_native(0).expect("렌더링");
    assert_eq!(a.digest(), d1, "조판·렌더링은 모델을 바꾸지 않는다");
    a.document.doc_properties.section_count += 1;
    assert_ne!(a.digest(), d1, "캐럿 외 문서 속성은 digest 안");
}

// ── 자체 스냅샷 (§5) ────────────────────────────────────────────────────

/// 자체 스냅샷 복원 = 업스트림 스냅샷 복원 (digest·내보내기·문단). 업스트림 저장소는 건드리지 않는다.
#[test]
fn own_snapshot_restore_matches_upstream_restore() {
    for src in [None, Some("samples/hml/exambank_math_equations_min.hwp")] {
        let open = || {
            CollabCore::new(match src {
                None => blank(),
                Some(p) => DocumentCore::from_bytes(&sample(p)).unwrap(),
            })
        };
        let prepare = |c: &mut CollabCore| {
            c.insert_text_native(0, 0, 0, "스냅샷 전").unwrap();
            c.split_paragraph_native(0, 0, 3, None).unwrap();
        };
        let mutate = |c: &mut CollabCore| {
            c.insert_text_native(0, 1, 0, "스냅샷 뒤 ").unwrap();
            c.apply_char_format_native(0, 0, 0, 2, r#"{"italic":true}"#).unwrap();
            c.merge_paragraph_native(0, 1).unwrap();
        };
        let (mut ours, mut theirs) = (open(), open());
        prepare(&mut ours);
        prepare(&mut theirs);
        let upstream_before = ours.snapshot_store.len();
        let id = ours.snapshot_save();
        assert_eq!(ours.snapshot_store.len(), upstream_before, "업스트림 snapshot_store 를 쓰지 않는다");
        let up = theirs.save_snapshot_native();
        mutate(&mut ours);
        mutate(&mut theirs);
        ours.snapshot_restore(id).unwrap();
        theirs.restore_snapshot_native(up).unwrap();
        assert_converged(&ours, &theirs);
        assert_eq!(ours.snapshot_count(), 1, "복원해도 스냅샷은 남는다");
        ours.snapshot_discard(id);
        assert_eq!(ours.snapshot_count(), 0);
        assert!(ours.snapshot_restore(id).is_err());
    }
}

// ── 결과 적재 (state) ───────────────────────────────────────────────────

#[test]
fn load_state_installs_parsed_document_in_place() {
    let mut a = CollabCore::new(blank());
    a.insert_text_native(0, 0, 0, "결과로 보낼 문서").unwrap();
    a.split_paragraph_native(0, 0, 3, None).unwrap();
    a.apply_char_format_native(0, 1, 0, 2, r#"{"bold":true}"#).unwrap();
    let bytes = a.export_state().unwrap();

    let mut b = CollabCore::new(DocumentCore::from_bytes(&sample("samples/hml/exambank_math_equations_min.hwp")).unwrap());
    b.set_active_field_json(&json!({ "section": 0, "para": 2, "control": 0, "cellPath": null })).unwrap();
    b.load_state(&bytes).unwrap();
    let reference = CollabCore::new(DocumentCore::from_bytes(&unpack_state(&bytes).unwrap()).unwrap());
    assert_converged(&b, &reference);
    assert_eq!(texts(&b), texts(&a));
    assert_eq!(b.active_field_json(), Value::Null, "옛 문서의 세션 상태는 비운다");
    assert!(b.load_state(b"not a document").is_err());
    assert!(b.load_state(&[0x1f, 0x8b, 0, 1, 2]).is_err(), "깨진 gzip");
    assert_converged(&b, &reference);
}

#[test]
fn state_keeps_source_format_family_and_is_gzipped() {
    // R12: HWPX 로 연 문서는 HWPX 로, HWP 는 HWP 로. 전송 바이트는 gzip.
    let hwpx = sample("samples/hwpx/blank_hwpx.hwpx");
    let mut x = CollabCore::new(DocumentCore::from_bytes(&hwpx).unwrap());
    x.insert_text_native(0, 0, 0, "HWPX 문서").unwrap();
    let packed = x.export_state().unwrap();
    assert!(packed.starts_with(&[0x1f, 0x8b]), "gzip");
    let raw = unpack_state(&packed).unwrap();
    assert!(raw.starts_with(b"PK"), "HWPX(zip) 계열");

    let mut h = CollabCore::new(blank());
    assert_eq!(h.source_format, crate::parser::FileFormat::Hwp);
    h.load_state(&packed).unwrap();
    assert_eq!(h.source_format, crate::parser::FileFormat::Hwpx, "적재한 형식으로 바뀐다");
    assert_eq!(h.digest(), CollabCore::new(DocumentCore::from_bytes(&raw).unwrap()).digest());
    assert!(unpack_state(&h.export_state().unwrap()).unwrap().starts_with(b"PK"), "다음 내보내기도 HWPX");

    // HWP 로 된 결과를 받으면 다시 HWP 계열, 원본(gzip 아닌) 바이트도 받는다
    let hwp_raw = unpack_state(&CollabCore::new(blank()).export_state().unwrap()).unwrap().into_owned();
    assert!(hwp_raw.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]), "HWP(CFB) 계열");
    h.load_state(&hwp_raw).unwrap();
    assert_eq!(h.source_format, crate::parser::FileFormat::Hwp);
}

// ── 메타 실측과 불변식 (§3) ─────────────────────────────────────────────

#[test]
fn measure_records_meta_for_text_ops() {
    let mut c = CollabCore::new(blank());
    let r = record(&mut c, "insertText", json!([0, 0, 0, "abc😀"]));
    assert_eq!(r["meta"], json!({ "len": 4 }), "스칼라 단위");
    let r = record(&mut c, "deleteText", json!([0, 0, 2, 100]));
    assert_eq!(r["meta"], json!({ "count": 2 }), "잘린 삭제는 실제 지운 수");
    let r = record(&mut c, "replaceBodyTextLocal", json!([0, 0, 1, 1, "XYZ"]));
    assert_eq!(r["meta"], json!({ "deleted": 1, "insLen": 3 }));
    assert_eq!(texts(&c)[0], "aXYZ");
    let r = record(&mut c, "splitParagraph", json!([0, 0, 2]));
    assert_eq!(r["meta"], json!({}));
    let r = record(&mut c, "mergeParagraph", json!([0, 1]));
    assert_eq!(r["meta"], json!({ "prevLen": 2 }));
    record(&mut c, "splitParagraph", json!([0, 0, 1]));
    record(&mut c, "splitParagraph", json!([0, 1, 1]));
    let r = record(&mut c, "deleteRange", json!([0, 0, 1, 2, 0]));
    assert_eq!(r["meta"], json!({}));
    let args = vec![json!(0), json!(0), json!(0), json!(1), json!("{}")];
    assert_eq!(c.measure("after", "applyCharFormat", &args, &Value::Null).unwrap(), json!({ "ok": true, "meta": null }), "텍스트 연산이 아니면 meta 없음");
}

#[test]
fn measure_insert_text_logical_converts_to_text_coordinates() {
    let mut c = CollabCore::new(DocumentCore::from_bytes(&sample("samples/hml/exambank_math_equations_min.hwp")).unwrap());
    if let crate::model::control::Control::Equation(eq) = &mut c.document.sections[0].paragraphs[2].controls[0] {
        eq.common.treat_as_char = true;
    }
    // 논리 5 = 수식 뒤 (텍스트 4, 개체 뒤)
    let r = record(&mut c, "insertTextLogical", json!([0, 2, 5, "뒤"]));
    assert_eq!(r["meta"], json!({ "offset": 4, "afterControl": true, "len": 1 }));
    assert_eq!(c.document.sections[0].paragraphs[2].text, "다항식 뒤을 전개하시오.");
    assert_eq!(c.text_to_logical(0, 2, 4, true).unwrap(), 5);
    assert_eq!(c.text_to_logical(0, 2, 4, false).unwrap(), 4);
    assert_eq!(c.logical_to_text(0, 2, 5).unwrap(), (4, true));
}

#[test]
fn measure_detects_invariant_violation() {
    let mut c = CollabCore::new(blank());
    c.insert_text_native(0, 0, 0, "문단 수가 바뀌면 보정할 수 없다").unwrap();
    let args = vec![json!(0), json!(0), json!(0), json!("x")];
    let before = c.measure("before", "insertText", &args, &Value::Null).unwrap();
    c.split_paragraph_native(0, 0, 2, None).unwrap(); // 같은 호출 안에서 문단이 나뉜 상황을 흉내 낸다
    let after = c.measure("after", "insertText", &args, &before).unwrap();
    assert_eq!(after["ok"], json!(false));
    assert!(after["reason"].as_str().unwrap().contains("문단 수 변화"));
}

#[test]
fn active_field_round_trips_and_resets() {
    let mut c = CollabCore::new(blank());
    assert_eq!(c.active_field_json(), Value::Null);
    let af = json!({ "section": 0, "para": 3, "control": 1, "cellPath": [[2, 0, 1]] });
    assert_eq!(c.set_active_field_json(&af).unwrap(), Value::Null);
    assert_eq!(c.active_field_json(), af);
    assert_eq!(c.set_active_field_json(&Value::Null).unwrap(), af, "이전 값을 돌려준다");
    assert!(c.set_active_field_json(&json!({ "section": 0 })).is_err());
}

// ── 되감기 재적용 (실제 문서) ───────────────────────────────────────────

/// 두 클라이언트가 같은 상태에서 동시에 편집하고, 서버가 A 를 먼저 확정했다. B 는 되감고 A 를 적용한 뒤
/// 자기 미확정을 보정해 다시 적용한다. A 는 B 의 보정된 연산을 받는다. 두 문서가 같아야 한다.
fn concurrent(setup: &[(&str, Value)], a_ops: &[(&str, Value)], b_ops: &[(&str, Value)]) -> (CollabCore, CollabCore, Value) {
    let mut a = CollabCore::new(blank());
    let mut b = CollabCore::new(blank());
    for (m, args) in setup {
        record(&mut a, m, args.clone());
        record(&mut b, m, args.clone());
    }
    let snap = b.snapshot_save();
    let ra: Vec<Value> = a_ops.iter().map(|(m, x)| record(&mut a, m, x.clone())).collect();
    let pb: Vec<Value> = b_ops.iter().map(|(m, x)| record(&mut b, m, x.clone())).collect();
    b.snapshot_restore(snap).unwrap();
    b.snapshot_discard(snap);
    for r in &ra {
        apply(&mut b, r).unwrap();
    }
    let out = ot::rebase(&pb, &ra, &catalog(), &Value::Null);
    let rebased = out["pending"].as_array().unwrap().clone();
    for p in &rebased {
        apply(&mut b, p).unwrap();
    }
    for p in &rebased {
        apply(&mut a, p).unwrap();
    }
    (a, b, out)
}

#[test]
fn concurrent_same_point_insert_converges_first_wins() {
    let (a, b, _) = concurrent(&[("insertText", json!([0, 0, 0, "ab"]))], &[("insertText", json!([0, 0, 1, "A"]))], &[("insertText", json!([0, 0, 1, "B"]))]);
    assert_converged(&a, &b);
    assert_eq!(texts(&a)[0], "aABb", "먼저 확정된 쪽이 앞");
}

#[test]
fn concurrent_delete_vs_insert_inside_keeps_the_insert() {
    let (a, b, out) = concurrent(&[("insertText", json!([0, 0, 0, "0123456789"]))], &[("insertText", json!([0, 0, 5, "XY"]))], &[("deleteText", json!([0, 0, 2, 6]))]);
    assert_converged(&a, &b);
    assert_eq!(texts(&a)[0], "01XY89", "남의 입력은 내 삭제에 같이 지워지지 않는다");
    assert_eq!(out["pending"].as_array().unwrap().len(), 2, "삭제가 둘로 쪼개진다");
}

#[test]
fn concurrent_enter_vs_backspace_converge() {
    let setup = [("insertText", json!([0, 0, 0, "위아래"])), ("splitParagraph", json!([0, 0, 1]))];
    let (a, b, _) = concurrent(&setup, &[("splitParagraph", json!([0, 0, 1]))], &[("mergeParagraph", json!([0, 1]))]);
    assert_converged(&a, &b);
    let (a, b, _) = concurrent(&setup, &[("mergeParagraph", json!([0, 1]))], &[("splitParagraph", json!([0, 1, 1]))]);
    assert_converged(&a, &b);
}

#[test]
fn concurrent_format_moves_with_remote_insert() {
    let setup = [("insertText", json!([0, 0, 0, "abcdef"]))];
    let (a, b, out) = concurrent(&setup, &[("insertText", json!([0, 0, 0, "__"]))], &[("applyCharFormat", json!([0, 0, 2, 4, r#"{"bold":true}"#]))]);
    assert_converged(&a, &b);
    assert_eq!(out["pending"][0]["a"], json!([0, 0, 4, 6, r#"{"bold":true}"#]), "서식 범위가 남의 삽입만큼 밀린다");
}


// ── R11 빠른 경로: 두 순서의 결과가 같은가 (실제 문서, 무작위) ─────────────

/// xorshift64* — 시드 고정 PRNG
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn int(&mut self, n: usize) -> usize {
        if n == 0 { 0 } else { (self.next() % n as u64) as usize }
    }
    fn chance(&mut self, p: f64) -> bool {
        (self.next() % 10_000) as f64 / 10_000.0 < p
    }
    fn off(&mut self, len: usize) -> usize {
        match self.int(10) {
            0..=2 => 0,
            3..=5 => len,
            _ => self.int(len + 1),
        }
    }
}

fn para_lens(c: &CollabCore) -> Vec<usize> {
    c.document.sections[0].paragraphs.iter().map(|p| p.text.chars().count()).collect()
}

/// 무작위 텍스트·서식 편집 하나를 실제로 가하고 기록을 돌려준다(거절되면 `None`). `kinds` 로 종류를 고른다.
fn random_edit(r: &mut Rng, c: &mut CollabCore, kinds: &[&str]) -> Option<Value> {
    let lens = para_lens(c);
    let p = r.int(lens.len());
    let len = lens[p];
    let words = ["가", "나다", "ab", "xyz", "한글", "Q"];
    let w = words[r.int(words.len())];
    let kind = kinds[r.int(kinds.len())];
    let (m, a) = match kind {
        "insertText" => ("insertText", json!([0, p, r.off(len), w])),
        "insertTextLogical" => ("insertTextLogical", json!([0, p, r.off(len), w])),
        "deleteText" if len > 0 => {
            let o = r.int(len);
            ("deleteText", json!([0, p, o, 1 + r.int((len - o).min(4) + 2)]))
        }
        "replaceBodyTextLocal" => {
            let o = r.off(len);
            ("replaceBodyTextLocal", json!([0, p, o, r.int(3).min(len - o), w]))
        }
        "splitParagraph" => ("splitParagraph", json!([0, p, r.off(len)])),
        "mergeParagraph" if p > 0 => ("mergeParagraph", json!([0, p])),
        "deleteRange" if lens.len() > 1 => {
            let sp = r.int(lens.len() - 1);
            let ep = sp + 1 + r.int((lens.len() - 1 - sp).min(2));
            ("deleteRange", json!([0, sp, r.int(lens[sp] + 1), ep, r.int(lens[ep] + 1)]))
        }
        "applyCharFormat" if len > 0 => {
            let s0 = r.int(len);
            let props = [r#"{"bold":true}"#, r#"{"italic":true}"#, r#"{"bold":false}"#][r.int(3)];
            ("applyCharFormat", json!([0, p, s0, s0 + 1 + r.int(len - s0), props]))
        }
        "applyParaFormat" => {
            let props = [r#"{"alignment":"center"}"#, r#"{"alignment":"right"}"#][r.int(2)];
            ("applyParaFormat", json!([0, p, props]))
        }
        _ => return None,
    };
    let args = a.as_array().unwrap().clone();
    let before = c.measure("before", m, &args, &Value::Null).ok()?;
    let mut rec = json!({ "kind": "op", "m": m, "a": a });
    apply(c, &rec).ok()?;
    let after = c.measure("after", m, &args, &before).ok()?;
    if after["ok"] != json!(true) {
        return None;
    }
    if !after["meta"].is_null() {
        rec["meta"] = after["meta"].clone();
    }
    Some(rec)
}

/// 같은 상태 S 에서 만든 미확정 P·원격 R 에 대해: 빠른 경로를 허용하면 S+P+R' = S+R+P' 이어야 한다.
fn fast_path_tp1(kinds: &[&str], cases: usize, seed: u64) -> (usize, usize, Vec<String>) {
    let mut r = Rng(seed);
    let (mut fast, mut total) = (0, 0);
    let mut bad = Vec::new();
    let short = |es: &[Value]| es.iter().map(|e| format!("{}{}", e["m"].as_str().unwrap_or("?"), e["a"])).collect::<Vec<_>>().join(" ; ");
    for case in 0..cases {
        // S: 몇 문단짜리 무작위 문서
        let mut s = CollabCore::new(blank());
        // 문단이 여럿이어야 서로 다른 문단 편집(빠른 경로)이 자주 나온다. 빈 문단도 섞는다(나눔 위치가
        // 끝·처음이면 빈 문단) — 빈 문단은 저장 줄 정보의 모양이 달라 세로 위치 계산이 갈리는 데 걸렸다.
        for _ in 0..12 + r.int(10) {
            random_edit(&mut r, &mut s, &["insertText", "splitParagraph", "splitParagraph", "applyCharFormat"]);
        }
        if r.chance(0.5) {
            let n = s.document.sections[0].paragraphs.len();
            let _ = s.split_paragraph_native(0, r.int(n), 0, None);
        }
        let bytes = s.export_hwp_native().unwrap();
        let fresh = || CollabCore::new(DocumentCore::from_bytes(&bytes).unwrap());
        let mut cp = fresh();
        let mut cr = fresh();
        let p: Vec<Value> = (0..1 + r.int(4)).filter_map(|_| random_edit(&mut r, &mut cp, kinds)).collect();
        let rm: Vec<Value> = (0..1 + r.int(4)).filter_map(|_| random_edit(&mut r, &mut cr, kinds)).collect();
        if p.is_empty() || rm.is_empty() {
            continue;
        }
        total += 1;
        let out = ot::rebase(&p, &rm, &catalog(), &Value::Null);
        let Some(r2) = out["fastRemote"].as_array() else { continue };
        fast += 1;
        let p2 = out["pending"].as_array().unwrap();
        let mut a = fresh();
        let mut b = fresh();
        let ok_a = p.iter().chain(r2.iter()).all(|e| apply(&mut a, e).is_ok());
        let ok_b = rm.iter().chain(p2.iter()).all(|e| apply(&mut b, e).is_ok());
        if !ok_a || !ok_b || a.digest() != b.digest() {
            bad.push(format!(
                "case {case}: 적용 {ok_a}/{ok_b} 빠른 {:?} 되감기 {:?}\n  S  {:?}\n  P  {}\n  R  {}\n  R' {}\n  P' {}",
                texts(&a), texts(&b), texts(&fresh()), short(&p), short(&rm), short(r2), short(p2)
            ));
        }
    }
    (fast, total, bad)
}

#[test]
fn fast_path_two_orders_agree_on_real_documents() {
    let groups: &[&[&str]] = &[
        &["insertText", "deleteText"],
        &["insertText", "replaceBodyTextLocal", "deleteText"],
        &["insertText", "splitParagraph", "mergeParagraph"],
        &["insertText", "deleteRange", "splitParagraph"],
        &["insertText", "insertTextLogical", "deleteText", "replaceBodyTextLocal", "splitParagraph", "mergeParagraph", "deleteRange"],
        &["insertText", "splitParagraph", "deleteText", "applyCharFormat", "applyParaFormat"],
        // R5 재검증에서 걸린 모양: 여러 문단 삭제 + 뒤 문단 입력
        &["insertText", "deleteRange", "replaceBodyTextLocal", "insertTextLogical", "splitParagraph"],
    ];
    let mut report = Vec::new();
    for (i, kinds) in groups.iter().enumerate() {
        let (fast, total, bad) = fast_path_tp1(kinds, 500, 0x5EED_0000 + i as u64);
        report.push(format!("{kinds:?}: 빠른 경로 {fast}/{total}, 불일치 {}", bad.len()));
        for b in bad.iter().take(2) {
            report.push(b.clone());
        }
    }
    let text = report.join("\n");
    assert!(!text.contains("case "), "빠른 경로 결과가 되감기 결과와 다르다:\n{text}");
    eprintln!("{text}");
}



#[test]
fn measure_records_meta_for_cell_text_ops() {
    // R13: 셀 텍스트 연산도 본문처럼 meta 를 실측한다(잘린 삭제는 실제 지운 수).
    let mut c = CollabCore::new(blank());
    c.create_table_native(0, 0, 0, 2, 2).unwrap();
    let (pp, ci) = c.document.sections[0].paragraphs.iter().enumerate()
        .find_map(|(i, p)| p.controls.iter().position(|x| matches!(x, crate::model::control::Control::Table(_))).map(|ci| (i, ci)))
        .expect("표");
    let r = record(&mut c, "insertTextInCell", json!([0, pp, ci, 1, 0, 0, "칸글😀"]));
    assert_eq!(r["meta"], json!({ "len": 3 }));
    let r = record(&mut c, "deleteTextInCell", json!([0, pp, ci, 1, 0, 1, 100]));
    assert_eq!(r["meta"], json!({ "count": 2 }), "잘린 삭제");
    let r = record(&mut c, "splitParagraphInCell", json!([0, pp, ci, 1, 0, 1]));
    assert_eq!(r["meta"], json!({}));
    let r = record(&mut c, "mergeParagraphInCell", json!([0, pp, ci, 1, 1]));
    assert_eq!(r["meta"], json!({ "prevLen": 1 }));
    // 보정 함수가 읽을 수 있는 기록이다
    assert!(ot::parse_text(&r).is_some());
}

#[test]
fn clipboard_ctx_round_trips_and_replays_to_the_same_paste() {
    // R13 §4.6-4: 붙여넣기를 op 로 — 보낸 쪽은 직렬화→다시 읽은 클립보드로 붙이고, 받는 쪽은 그 값으로 맞춰 붙인다.
    let mut a = CollabCore::new(blank());
    a.insert_text_native(0, 0, 0, "첫 문단 글").unwrap();
    a.split_paragraph_native(0, 0, 3, None).unwrap();
    a.apply_char_format_native(0, 1, 0, 2, r#"{"bold":true}"#).unwrap();
    let bytes = a.export_hwp_native().unwrap();
    let mut a = CollabCore::new(DocumentCore::from_bytes(&bytes).unwrap()); // 둘 다 같은 바이트에서
    let mut b = CollabCore::new(DocumentCore::from_bytes(&bytes).unwrap());
    a.copy_selection_native(0, 0, 1, 1, 2).unwrap();
    let ctx = a.normalize_clipboard().unwrap();
    assert!(ctx["paras"].is_string(), "클립보드가 담김: {ctx}");
    a.paste_internal_native(0, 0, 0).unwrap();
    // B 는 클립보드가 비어 있다(또는 다른 것이 있다) — 기록의 값으로 맞춘 뒤 붙이고 되돌린다
    b.push_clipboard(&ctx).unwrap();
    b.paste_internal_native(0, 0, 0).unwrap();
    b.pop_clipboard();
    assert!(b.inner.clipboard.is_none(), "B 의 클립보드는 원래대로(비어 있음)");
    assert_eq!(texts(&a), texts(&b));
    assert_eq!(a.digest(), b.digest(), "보낸 쪽과 받는 쪽의 붙여넣기 결과가 같다");
}

// ── S3-0 digest 에 BinData 내용 ─────────────────────────────────────────

const CHART_SAMPLE: &str = "samples/chart/가로막대형/묶은가로막대형.hwp";
const CHART_EDIT: &str = r#"{"series":[{"values":["9","2.5","3.5","4.5"]},{"values":["2.4","4.4","1.8","2.8"]},{"values":["2","2","3","5"]}]}"#;

/// 차트 데이터만 바꿔도 digest 가 바뀌고, 같은 편집을 재생하면 다시 같다. 편집한 쪽(Loaded, 비압축)과
/// 그 결과를 다시 읽은 쪽(압축 스트림)도 BinData 해시가 같다 — 저장 표현이 아니라 내용을 본다.
#[test]
fn digest_sees_bin_data_content_not_its_stored_form() {
    use crate::model::bin_data::BinDataBytes;
    let open = || CollabCore::new(DocumentCore::from_bytes(&sample(CHART_SAMPLE)).unwrap());
    let (mut a, mut b) = (open(), open());
    let before = a.digest();
    assert_eq!(before, b.digest());
    let model_only = |c: &CollabCore| {
        let doc = &c.inner.document;
        let mut props = doc.doc_properties.clone();
        props.caret_list_id = 0;
        props.caret_para_id = 0;
        props.caret_char_pos = 0;
        let mut parts = doc_info_model_digest(&doc.doc_info, &props).to_vec();
        for s in &doc.sections {
            parts.extend_from_slice(&section_model_digest(s));
        }
        bytes_digest(&parts)
    };
    let model_before = model_only(&a);

    let r: Value = serde_json::from_str(&a.inner.set_chart_data_by_index_native(0, CHART_EDIT).unwrap()).unwrap();
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(model_only(&a), model_before, "차트 값은 구역·DocInfo 모델 밖(BinData)에 있다 — 예전 digest 의 사각");
    let after = a.digest();
    assert_ne!(after, before, "BinData 만 바뀌어도 digest 가 바뀐다");
    b.inner.set_chart_data_by_index_native(0, CHART_EDIT).unwrap();
    assert_eq!(b.digest(), after, "같은 편집을 재생하면 다시 같다");

    let mut c = open();
    c.load_state(&a.export_state().unwrap()).unwrap();
    assert!(matches!(a.inner.document.bin_data_content[0].data, BinDataBytes::Loaded(_)));
    assert!(c.inner.document.bin_data_content[0].data.load_raw().is_some(), "다시 읽은 쪽은 압축 원본 스트림");
    assert_eq!(c.bin_data_hashes(), a.bin_data_hashes(), "저장 표현이 달라도 내용이 같으면 같은 해시");
    assert_ne!(c.bin_data_hashes(), open().bin_data_hashes());
}

/// 캐시: 두 번째 digest 는 (epoch, id) 로, 다시 읽기(state 적재)·되감기(스냅샷 복원) 뒤 첫 digest 는 저장
/// 바이트 메모로 — 어느 쪽도 압축을 다시 풀지 않는다. 시간은 기록용으로 찍는다.
#[test]
fn bin_digest_cache_avoids_reinflation() {
    let f = "samples/basic/treatise sample.hwp";
    let mut a = CollabCore::new(DocumentCore::from_bytes(&sample(f)).unwrap());
    let items = a.inner.document.bin_data_content.len();
    let bytes: usize = a.inner.document.bin_data_content.iter().map(|c| c.data.len()).sum();
    assert!(items >= 4 && bytes > 4_000_000, "큰 그림 문서여야 한다: {items}개 {bytes}B");
    let time = |c: &CollabCore| {
        let t = std::time::Instant::now();
        let d = c.digest();
        (d, t.elapsed())
    };
    let (d1, first) = time(&a);
    let loads = a.bin_digest_content_loads();
    assert_eq!(loads as usize, items, "처음에는 항목마다 한 번 푼다");
    let (d2, second) = time(&a);
    assert_eq!(d2, d1);
    assert_eq!(a.bin_digest_content_loads(), loads, "두 번째는 (epoch, id) 캐시");

    let id = a.snapshot_save();
    a.inner.insert_text_native(0, 0, 0, "가").unwrap();
    a.snapshot_restore(id).unwrap();
    let (d3, rewind) = time(&a);
    assert_eq!(d3, d1);
    assert_eq!(a.bin_digest_content_loads(), loads, "되감기(epoch 올림) 뒤에도 저장 바이트 메모로 풀지 않는다");

    let state = a.export_state().unwrap();
    a.load_state(&state).unwrap();
    let (_, reload) = time(&a);
    assert_eq!(a.bin_digest_content_loads(), loads, "다시 읽은 뒤 첫 digest 도 풀지 않는다");
    println!("S3-0 digest {items}개 {bytes}B: 처음 {first:?}, 두 번째 {second:?}, 되감기 뒤 {rewind:?}, 다시 읽은 뒤 {reload:?}");
}

/// epoch 를 올리지 않는 제자리 교체가 생겨도(업스트림 계약 위반) 캐시가 옛 해시를 내지 않는다.
#[test]
fn bin_digest_cache_checks_item_identity() {
    use crate::model::bin_data::BinDataBytes;
    let mut a = CollabCore::new(DocumentCore::from_bytes(&sample(CHART_SAMPLE)).unwrap());
    a.inner.set_chart_data_by_index_native(0, CHART_EDIT).unwrap();
    let d1 = a.digest();
    let mut bytes = a.inner.document.bin_data_content[0].data.load();
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    a.inner.document.bin_data_content[0].data = BinDataBytes::Loaded(bytes);
    assert_ne!(a.digest(), d1);
}

/// S3-3: 편집 → 캐럿 이동 → 내보내기 → 다시 읽기에서 digest 가 같다. 캐럿은 문서 속성의 세 필드와 그 원본
/// 레코드 사본(`raw_data` offset 14..26)에 함께 실린다 — 사본을 놓치면 다시 읽은 쪽(체크포인트·welcome)만
/// digest 가 달라진다(전 샘플 HWP 에서 그랬다). HWPX 도 같은 경로로 본다.
#[test]
fn digest_survives_export_reload_after_edit_and_caret_move() {
    for f in ["samples/biz_plan.hwp", "samples/hwpx/ref/ref_text.hwpx"] {
        let mut a = CollabCore::new(DocumentCore::from_bytes(&sample(f)).unwrap());
        a.load_state(&a.export_state().unwrap()).unwrap(); // 세션 시작과 같은 첫 왕복
        a.inner.insert_text_native(0, 0, 0, "편집").unwrap();
        a.inner.set_caret_position_native(0, 0, 2);
        let mut b = CollabCore::new(DocumentCore::from_bytes(&sample(f)).unwrap());
        b.load_state(&a.export_state().unwrap()).unwrap();
        let caret_bytes = |c: &CollabCore| c.inner.document.doc_properties.raw_data.as_ref().filter(|r| r.len() >= 26).map(|r| r[14..26].to_vec());
        if f.ends_with(".hwp") {
            assert_ne!(caret_bytes(&a), caret_bytes(&b), "{f}: 다시 읽은 쪽 원본 레코드에 캐럿이 실려 있어야 이 시험이 그 경로를 지난다");
        }
        assert_eq!(a.digest(), b.digest(), "{f}: 편집·캐럿 이동 뒤 내보내기 → 다시 읽기");
        // 캐럿만 또 옮겨도 digest 는 그대로(사용자별 메타데이터)
        let before = b.digest();
        b.inner.set_caret_position_native(0, 0, 1);
        assert_eq!(b.digest(), before, "{f}: 캐럿 이동은 digest 에 들어가지 않는다");
    }
}
