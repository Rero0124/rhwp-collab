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

// ── 5단계 D4: 좁은 권한 결과 판정(collabCheckConfined)·누름틀 범위(collabFieldContains) ─────────────────

/// 스냅샷 → 편집 → 판정 → 되돌림. 판정 결과 JSON.
fn confined(core: &mut CollabCore, kind: &str, edit: impl FnOnce(&mut CollabCore)) -> Value {
    let snap = core.snapshot_save();
    edit(core);
    let verdict = core.check_confined(snap, kind).unwrap();
    core.snapshot_restore(snap).unwrap();
    core.snapshot_discard(snap);
    verdict
}
fn passes(v: &Value) -> bool {
    v["ok"] == json!(true)
}

fn ctrl_index(core: &CollabCore, para: usize, pick: impl Fn(&crate::model::control::Control) -> bool) -> usize {
    core.document.sections[0].paragraphs[para].controls.iter().position(pick).expect("개체")
}
fn click_here(c: &crate::model::control::Control) -> bool {
    matches!(c, crate::model::control::Control::Field(f) if f.field_type == crate::model::control::FieldType::ClickHere)
}
fn field_id_in(paras: &[crate::model::paragraph::Paragraph]) -> u32 {
    paras.iter().flat_map(|p| p.controls.iter()).find_map(|c| match c {
        crate::model::control::Control::Field(f) if f.field_type == crate::model::control::FieldType::ClickHere => Some(f.field_id),
        _ => None,
    }).expect("누름틀")
}

/// 양식 문서: 문단 0 "이름: [누름틀=abc] 끝", 문단 1 에 표(칸 0 에 "칸 [누름틀=xy]"), 머리말, 각주, 글상자.
/// (구역 0 문단 번호, 표 개체 번호, 글상자 문단·개체 번호)
fn form_doc() -> (CollabCore, usize, usize, (usize, usize)) {
    let mut c = CollabCore::new(blank());
    c.insert_text_native(0, 0, 0, "이름:  끝").unwrap();
    c.insert_click_here_field_at(0, 0, 4, "이름", "", "name", true).unwrap();
    let id = field_id_in(&c.document.sections[0].paragraphs);
    c.set_field_value_by_id(id, "abc").unwrap();
    let len0 = c.document.sections[0].paragraphs[0].text.chars().count();
    c.split_paragraph_native(0, 0, len0, None).unwrap();
    c.create_table_native(0, 1, 0, 1, 2).unwrap();
    let tbl_para = (0..c.document.sections[0].paragraphs.len())
        .find(|&p| c.document.sections[0].paragraphs[p].controls.iter().any(|x| matches!(x, crate::model::control::Control::Table(_))))
        .unwrap();
    let ci = ctrl_index(&c, tbl_para, |x| matches!(x, crate::model::control::Control::Table(_)));
    c.insert_text_in_cell_native(0, tbl_para, ci, 0, 0, 0, "칸 ").unwrap();
    c.insert_click_here_field_at_in_cell(0, tbl_para, ci, 0, 0, 2, false, "칸값", "", "cell", true).unwrap();
    c.create_header_footer_native(0, true, 0).unwrap();
    c.insert_text_in_header_footer_native(0, true, 0, 0, 0, "머리말").unwrap();
    c.insert_footnote_native(0, 0, 1).unwrap();
    let fn_ci = ctrl_index(&c, 0, |x| matches!(x, crate::model::control::Control::Footnote(_)));
    c.insert_text_in_footnote_native(0, 0, fn_ci, 0, 0, "각주").unwrap();
    let last = c.document.sections[0].paragraphs.len() - 1;
    c.create_shape_control_native(0, last, 0, 8000, 4000, 0, 0, true, "Square", "textbox", false, false, &[]).unwrap();
    let tb_ci = ctrl_index(&c, last, |x| matches!(x, crate::model::control::Control::Shape(_)));
    (c, tbl_para, ci, (last, tb_ci))
}

#[test]
fn confined_form_accepts_field_values_and_typing_inside_fields() {
    let (mut c, tbl_para, ci, _) = form_doc();
    let body_id = field_id_in(&c.document.sections[0].paragraphs[..1]);
    assert!(passes(&confined(&mut c, "form", |c| { c.set_field_value_by_id(body_id, "홍길동").unwrap(); })), "누름틀 값");
    // 누름틀 안 입력(본문) — 범위 [4, 7) 의 가운데
    let r = confined(&mut c, "form", |c| { c.insert_text_native(0, 0, 5, "Z").unwrap(); });
    assert!(passes(&r), "누름틀 안 입력: {r}");
    // 칸 안 누름틀 안 입력
    let r = confined(&mut c, "form", |c| { c.insert_text_in_cell_native(0, tbl_para, ci, 0, 0, 2, "Q").unwrap(); });
    // 칸 누름틀은 비어 있어 시작 = 끝 = 2 — 그 자리 입력이 누름틀 안인지는 개체 앞뒤에 달렸다. 값을 채운 뒤 가운데에 넣는다.
    let cell_id = {
        let crate::model::control::Control::Table(t) = &c.document.sections[0].paragraphs[tbl_para].controls[ci] else { panic!() };
        field_id_in(&t.cells[0].paragraphs)
    };
    let _ = r;
    c.set_field_value_by_id(cell_id, "xy").unwrap();
    let r = confined(&mut c, "form", |c| { c.insert_text_in_cell_native(0, tbl_para, ci, 0, 0, 3, "Q").unwrap(); });
    assert!(passes(&r), "칸 누름틀 안 입력: {r}");
    // 양식 개체 값(샘플)
    let mut f = CollabCore::new(DocumentCore::from_bytes(&sample("samples/form-01.hwp")).unwrap());
    let (para, fci) = f.document.sections[0].paragraphs.iter().enumerate()
        .find_map(|(p, para)| para.controls.iter().position(|x| matches!(x, crate::model::control::Control::Form(_))).map(|i| (p, i)))
        .expect("양식 개체");
    let r = confined(&mut f, "form", |f| { f.set_form_value_native(0, para, fci, r#"{"value":1,"text":"채움"}"#).unwrap(); });
    assert!(passes(&r), "양식 값: {r}");
}

#[test]
fn confined_form_rejects_everything_outside_fields_in_every_container() {
    let (mut c, tbl_para, ci, (tb_para, tb_ci)) = form_doc();
    let no = |v: Value, what: &str| assert!(!passes(&v) && v["reason"] == json!("confined"), "{what} 은 거절이어야: {v}");
    no(confined(&mut c, "form", |c| { c.insert_text_native(0, 0, 0, "X").unwrap(); }), "누름틀 밖 본문");
    no(confined(&mut c, "form", |c| { c.insert_text_in_cell_native(0, tbl_para, ci, 0, 0, 0, "X").unwrap(); }), "누름틀 밖 칸 문단");
    no(confined(&mut c, "form", |c| { c.insert_text_in_cell_native(0, tbl_para, ci, 1, 0, 0, "X").unwrap(); }), "다른 칸");
    no(confined(&mut c, "form", |c| { c.insert_text_in_header_footer_native(0, true, 0, 0, 0, "X").unwrap(); }), "머리말");
    let fn_ci = ctrl_index(&c, 0, |x| matches!(x, crate::model::control::Control::Footnote(_)));
    no(confined(&mut c, "form", |c| { c.insert_text_in_footnote_native(0, 0, fn_ci, 0, 0, "X").unwrap(); }), "각주");
    no(confined(&mut c, "form", |c| { c.insert_text_in_cell_by_path(0, tb_para, &[(tb_ci, 0, 0)], 0, "X").unwrap(); }), "글상자 안 문단");
    no(confined(&mut c, "form", |c| { c.create_table_native(0, 0, 5, 1, 1).unwrap(); }), "누름틀 안에 표 넣기");
    no(confined(&mut c, "form", |c| { c.rename_field_by_name("name", "other").unwrap(); }), "누름틀 이름 바꾸기");
    no(confined(&mut c, "form", |c| { c.document.doc_info.char_shapes[0].base_size += 100; }), "기존 글자 모양 고치기");
    // state 바이트로 본문 바꾸기: 다른 문서에서 본문을 고쳐 내보낸 결과를 적재
    let forged = {
        let mut other = CollabCore::new(blank());
        other.load_state(&c.export_state().unwrap()).unwrap();
        other.insert_text_native(0, 0, 0, "위조").unwrap();
        other.export_state().unwrap()
    };
    no(confined(&mut c, "form", |c| { c.load_state(&forged).unwrap(); }), "state 바이트로 본문 바꾸기");
    // 메모는 form 이 아니다
    no(confined(&mut c, "form", |c| { c.insert_memo_at(0, 0, 0, 2, "나", "메모").unwrap(); }), "form 으로 메모");
}

#[test]
fn confined_comment_accepts_memo_operations_only() {
    let (mut c, ..) = form_doc();
    let r = confined(&mut c, "comment", |c| { c.insert_memo_at(0, 0, 0, 2, "나", "첫 메모").unwrap(); });
    assert!(passes(&r), "메모 넣기: {r}");
    // 메모가 있는 상태에서 답글·고치기·지우기·모양
    c.insert_memo_at(0, 0, 0, 2, "나", "첫 메모").unwrap();
    let id = c.document.sections[0].paragraphs[0].controls.iter().find_map(|x| match x {
        crate::model::control::Control::Field(f) if f.field_type == crate::model::control::FieldType::Memo => Some(f.field_id),
        _ => None,
    }).unwrap();
    for (what, r) in [
        ("답글", confined(&mut c, "comment", |c| { c.insert_memo_reply_json_native(id, r#"{"author":"너","text":"답"}"#).unwrap(); })),
        ("고치기", confined(&mut c, "comment", |c| { c.set_memo_text(id, "고친 메모").unwrap(); })),
        ("지우기", confined(&mut c, "comment", |c| { c.remove_memo(id).unwrap(); })),
        ("모양", confined(&mut c, "comment", |c| {
            c.set_memo_shape_json(Some(0), r##"{"width":12000,"lineType":1,"lineWidth":2,"lineColor":"#112233","fillColor":"#FFFFCC","activeColor":"#FFCC00"}"##).unwrap();
        })),
    ] {
        assert!(passes(&r), "메모 {what}: {r}");
    }
    let no = |v: Value, what: &str| assert!(!passes(&v), "{what} 은 거절이어야: {v}");
    no(confined(&mut c, "comment", |c| { c.insert_text_native(0, 0, 0, "X").unwrap(); }), "comment 로 본문");
    let body_id = field_id_in(&c.document.sections[0].paragraphs[..1]);
    no(confined(&mut c, "comment", |c| { c.set_field_value_by_id(body_id, "x").unwrap(); }), "comment 로 누름틀 값");
    no(confined(&mut c, "comment", |c| { c.document.doc_info.char_shapes[0].base_size += 100; }), "comment 로 기존 글자 모양");
    // 두 권한을 함께 가지면 한 묶음에 양식과 메모가 섞여도 통과
    let mixed = |c: &mut CollabCore| {
        c.set_field_value_by_id(body_id, "섞음").unwrap();
        let end = c.document.sections[0].paragraphs[0].text.chars().count();
        c.insert_memo_at(0, 0, end - 1, end, "나", "섞음 메모").unwrap();
    };
    assert!(passes(&confined(&mut c, "form comment", mixed)), "form comment: 섞인 묶음");
    no(confined(&mut c, "form", mixed), "form 만으로는 섞인 묶음");
}

#[test]
fn field_contains_checks_the_active_click_here_range() {
    let (c, tbl_para, ci, _) = form_doc();
    let fci = ctrl_index(&c, 0, click_here);
    let af = json!({ "section": 0, "para": 0, "control": fci, "cellPath": null });
    let yes = |m: &str, a: Value| c.field_contains_call(m, a.as_array().unwrap(), &af).unwrap();
    // 본문 누름틀 범위 [4, 7) — 끝 지점 입력까지
    assert!(yes("insertText", json!([0, 0, 5, "x"])));
    assert!(yes("insertText", json!([0, 0, 7, "x"])));
    assert!(yes("deleteText", json!([0, 0, 4, 3])));
    assert!(!yes("insertText", json!([0, 0, 2, "x"])), "누름틀 밖");
    assert!(!yes("deleteText", json!([0, 0, 3, 2])), "걸침");
    assert!(!yes("splitParagraph", json!([0, 0, 5])), "문단 나누기");
    assert!(!yes("insertText", json!([0, 1, 0, "x"])), "다른 문단");
    assert!(!c.field_contains_call("insertText", json!([0, 0, 5, "x"]).as_array().unwrap(), &Value::Null).unwrap(), "활성 누름틀 없음");
    // 칸 안 누름틀
    let cell_fci = {
        let crate::model::control::Control::Table(t) = &c.document.sections[0].paragraphs[tbl_para].controls[ci] else { panic!() };
        t.cells[0].paragraphs[0].controls.iter().position(click_here).unwrap()
    };
    let caf = json!({ "section": 0, "para": tbl_para, "control": cell_fci, "cellPath": [[ci, 0, 0]] });
    assert!(c.field_contains_call("insertTextInCell", json!([0, tbl_para, ci, 0, 0, 2, "q"]).as_array().unwrap(), &caf).unwrap());
    assert!(!c.field_contains_call("insertTextInCell", json!([0, tbl_para, ci, 0, 0, 0, "q"]).as_array().unwrap(), &caf).unwrap(), "칸 누름틀 밖");
    assert!(!c.field_contains_call("insertTextInCell", json!([0, tbl_para, ci, 1, 0, 0, "q"]).as_array().unwrap(), &caf).unwrap(), "다른 칸");
}


// ── D4: 결과 전송(state)의 판정 — 사본을 내보낸 바이트를 정본이 적재한다 ─────────────────────────

/** 본문 "이름: [누름틀 abc] 끝"(9글자), `memo` 면 글자 0..2 에 메모가 이미 있다. 원본 바이트. */
fn state_doc(memo: bool) -> Vec<u8> {
    let mut c = CollabCore::new(blank());
    c.insert_text_native(0, 0, 0, "이름:  끝").unwrap();
    c.insert_click_here_field_at(0, 0, 4, "이름", "", "name", true).unwrap();
    let id = field_id_in(&c.document.sections[0].paragraphs);
    c.set_field_value_by_id(id, "abc").unwrap();
    if memo {
        c.insert_memo_at(0, 0, 0, 2, "나", "있던 메모").unwrap();
    }
    let packed = c.export_state().unwrap();
    super::unpack_state(&packed).unwrap().into_owned()
}

/// 정상 클라이언트의 결과 전송: 사본(같은 원본을 연 다른 문서)에서 고치고 내보낸 바이트를 정본이 적재한 뒤 판정.
fn state_confined(raw: &[u8], kind: &str, edit: impl FnOnce(&mut CollabCore)) -> Value {
    let mut canon = CollabCore::new(DocumentCore::from_bytes(raw).unwrap());
    let snap = canon.snapshot_save();
    let mut client = CollabCore::new(DocumentCore::from_bytes(raw).unwrap());
    edit(&mut client);
    canon.load_state(&client.export_state().unwrap()).unwrap();
    canon.check_confined(snap, kind).unwrap()
}

fn set_script(c: &mut CollabCore, path: &str, bytes: &[u8]) {
    let streams = &mut c.document.extra_streams;
    match streams.iter_mut().find(|(p, _)| p == path) {
        Some((_, b)) => *b = bytes.to_vec(),
        None => streams.push((path.to_string(), bytes.to_vec())),
    }
}

#[test]
fn confined_state_transfer_of_memo_and_field_value_passes() {
    // 회귀(5단계 서버 우회 시험): 저장 때 다시 쓰는 `/RhwpLineSegTags`(구역 바이트 다이제스트)가 메모·누름틀 값으로 바뀌어
    // "부속 스트림이 다름"으로 정상 결과 전송을 거절했다
    for memo in [false, true] {
        let raw = state_doc(memo);
        let at = if memo { 7 } else { 0 };
        let ok = |v: Value, what: &str| assert!(passes(&v), "{what}(메모 있던 문서 {memo}): {v}");
        ok(state_confined(&raw, "comment", |c| { c.insert_memo_at(0, 0, at, at + 2, "C", "메모").unwrap(); }), "comment 메모 넣기");
        ok(state_confined(&raw, "form", |c| {
            let id = field_id_in(&c.document.sections[0].paragraphs);
            c.set_field_value_by_id(id, "홍길동").unwrap();
        }), "form 누름틀 값");
        ok(state_confined(&raw, "form comment", |c| {
            let id = field_id_in(&c.document.sections[0].paragraphs);
            c.set_field_value_by_id(id, "섞음").unwrap();
            c.insert_memo_at(0, 0, 0, 1, "C", "섞음 메모").ok();
        }), "form comment 누름틀 + 메모");
        ok(state_confined(&raw, "form", |_| {}), "편집 없는 state(form)");
        ok(state_confined(&raw, "comment", |_| {}), "편집 없는 state(comment)");
    }
}

#[test]
fn confined_state_rejects_forged_streams_in_a_memo_document() {
    // 부속 스트림 비교는 파생 스트림 하나만 뺀다 — 스크립트 스트림을 state 바이트로 끼워 넣는 우회는 막는다
    let raw = state_doc(true);
    let script = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap())
        .document
        .extra_streams
        .iter()
        .find(|(p, _)| p.trim_start_matches('/') == "Scripts/DefaultJScript")
        .map(|(p, _)| p.clone())
        .expect("빈 문서에도 기본 스크립트 스트림이 있다");
    let rejects = |v: Value, what: &str, stream: &str| {
        assert_eq!(v["ok"], json!(false), "{what}: {v}");
        assert_eq!(v["reason"], json!("confined"), "{what}");
        assert!(v["detail"].as_str().unwrap_or("").contains(stream), "{what}: {v}");
    };
    rejects(state_confined(&raw, "comment", |c| {
        c.insert_memo_at(0, 0, 7, 9, "C", "메모").unwrap();
        set_script(c, &script, b"evil();");
    }), "메모 + 기본 스크립트 바꾸기", "Scripts");
    rejects(state_confined(&raw, "comment", |c| {
        c.insert_memo_at(0, 0, 7, 9, "C", "메모").unwrap();
        set_script(c, "/Scripts/Evil", b"evil();");
    }), "메모 + 스크립트 스트림 더하기", "/Scripts/Evil");
    rejects(state_confined(&raw, "form", |c| {
        let id = field_id_in(&c.document.sections[0].paragraphs);
        c.set_field_value_by_id(id, "값").unwrap();
        set_script(c, &script, b"evil();");
    }), "누름틀 값 + 기본 스크립트 바꾸기", "Scripts");
}

/// 실제 저장본(한/글)의 결과 전송: 정본은 원본을 읽은 문서, 사본은 같은 원본을 읽어 고친 뒤 rhwp 로 내보낸 바이트.
/// 내보내기→다시 읽기가 항등이 아니어서(HWPX 목록 파일 재작성, 파일 머리, 문단 번호 다시 매기기 등) 판정이 스냅샷 쪽도
/// 같은 정규화를 거쳐야 한다.
fn real_state(f: &str, kind: &str, edit: impl FnOnce(&mut CollabCore)) -> Value {
    state_confined(&sample(&format!("samples/{f}")), kind, edit)
}

#[test]
fn confined_state_on_real_files_compares_both_sides_after_export_and_reparse() {
    // 회귀(5단계 서버 우회 시험 뒤 실제 샘플 확인): 편집 없는 결과 전송도 "부속 스트림이 다름 (Contents/content.hpf)"
    // (HWPX), "파일 머리가 다름"(HWP)으로 거절했다
    for f in ["누름틀-2024.hwpx", "20250130-hongbo-no.hwp"] {
        for kind in ["comment", "form", "form comment"] {
            let v = real_state(f, kind, |_| {});
            assert!(passes(&v), "{f} 편집 없는 state({kind}): {v}");
        }
    }
    // 메모: 누름틀 안에 메모(다시 읽으면 메모 시작이 누름틀의 안쪽 슬롯으로 세어진다, HWPX 문단 번호가 밀린다),
    // 줄 수가 바뀌는 HWP 저장본
    for f in ["누름틀-2024.hwpx", "21_언어_기출_편집가능본.hwp"] {
        let v = real_state(f, "comment", |c| { c.insert_memo_at(0, 0, 0, 1, "C", "m").unwrap(); });
        assert!(passes(&v), "{f} 메모(state): {v}");
        // 같은 문서 객체에서 바로 넣어도(빈 CTRL_DATA 칸이 생긴다)
        let mut core = CollabCore::new(DocumentCore::from_bytes(&sample(&format!("samples/{f}"))).unwrap());
        let v = confined(&mut core, "comment", |c| { c.insert_memo_at(0, 0, 0, 1, "C", "m").unwrap(); });
        assert!(passes(&v), "{f} 메모(같은 객체): {v}");
        // 메모에 본문 글자를 섞으면 그대로 거절
        let v = real_state(f, "comment", |c| {
            c.insert_memo_at(0, 0, 0, 1, "C", "m").unwrap();
            c.insert_text_native(0, 0, 0, "덤").unwrap();
        });
        assert_eq!(v["ok"], json!(false), "{f} 메모 + 본문(state): {v}");
    }
}

// ── D4 후속: 메모 시각 고정(ctx.memoTime) ─────────────────────────────────────

#[test]
fn memo_inserts_are_deterministic_under_a_pinned_clock() {
    // 업스트림이 메모 명령에 지금 시각을 박는다 — 고정하면 같은 호출이 같은 문서. 업스트림이 다른 시각 원천이나
    // 난수를 더하면 여기와 R1b(check-behavior)가 잡는다.
    const T: u64 = 134_000_000_000_000_000;
    let run = || {
        let _pin = super::MemoTimePin::new(T);
        let mut c = CollabCore::new(blank());
        c.insert_text_native(0, 0, 0, "메모 달 글자입니다").unwrap();
        c.insert_memo_json_native(0, 0, 0, 2, r#"{"author":"갑","text":"첫 메모"}"#).unwrap();
        let list: Value = serde_json::from_str(&c.get_memo_list_json()).unwrap();
        let id = list[0]["id"].as_u64().unwrap() as u32;
        c.insert_memo_reply_json_native(id, r#"{"author":"을","text":"답글"}"#).unwrap();
        (c.export_state().unwrap(), c.digest(), c.get_memo_list_json())
    };
    let (a, b) = (run(), run());
    assert_eq!(a.1, b.1, "digest");
    assert_eq!(a.0, b.0, "내보낸 바이트");
    assert_eq!(a.2, b.2, "메모 목록");
    // 메모 명령에 고정한 시각이 들어간다(하위·상위 DWORD)
    assert!(a.2.contains(&crate::model::memo_time::date(&format!("MEMO/1/1/{}/{}/x", T as u32, T >> 32)).unwrap()), "{}", a.2);
    // 가드가 풀리면 원래대로
    assert_eq!(super::pinned_memo_time(), None);
}

#[test]
fn memo_time_pin_is_released_even_when_the_call_panics() {
    let r = std::panic::catch_unwind(|| {
        let _pin = super::MemoTimePin::new(7);
        assert_eq!(super::pinned_memo_time(), Some(7));
        panic!("호출 중 실패");
    });
    assert!(r.is_err());
    assert_eq!(super::pinned_memo_time(), None);
    // 겹쳐 걸면 안쪽이 풀릴 때 바깥 값으로
    let outer = super::MemoTimePin::new(1);
    {
        let _inner = super::MemoTimePin::new(2);
        assert_eq!(super::pinned_memo_time(), Some(2));
    }
    assert_eq!(super::pinned_memo_time(), Some(1));
    drop(outer);
    assert_eq!(super::pinned_memo_time(), None);
}
