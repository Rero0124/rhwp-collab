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
    // 메모가 있는 상태에서 답글·고치기·지우기(모양은 edit 몫 — 아래 거절)
    c.insert_memo_at(0, 0, 0, 2, "나", "첫 메모").unwrap();
    let id = c.document.sections[0].paragraphs[0].controls.iter().find_map(|x| match x {
        crate::model::control::Control::Field(f) if f.field_type == crate::model::control::FieldType::Memo => Some(f.field_id),
        _ => None,
    }).unwrap();
    for (what, r) in [
        ("답글", confined(&mut c, "comment", |c| { c.insert_memo_reply_json_native(id, r#"{"author":"너","text":"답"}"#).unwrap(); })),
        ("고치기", confined(&mut c, "comment", |c| { c.set_memo_text(id, "고친 메모").unwrap(); })),
        ("지우기", confined(&mut c, "comment", |c| { c.remove_memo(id).unwrap(); })),
    ] {
        assert!(passes(&r), "메모 {what}: {r}");
    }
    let no = |v: Value, what: &str| assert!(!passes(&v), "{what} 은 거절이어야: {v}");
    // 메모 모양은 다른 사람 메모의 겉모습까지 바꾸는 문서 설정 — comment 로는 거절(DocInfo 고쳐 쓰기·구역 번호 바꾸기 모두)
    let shape = |c: &mut CollabCore| {
        c.set_memo_shape_json(Some(0), r##"{"width":12000,"lineType":1,"lineWidth":2,"lineColor":"#112233","fillColor":"#FFFFCC","activeColor":"#FFCC00"}"##).unwrap();
    };
    let v = confined(&mut c, "comment", shape);
    assert_eq!(v["detail"], json!("메모 모양이 바뀜"), "comment 로 메모 모양: {v}");
    no(confined(&mut c, "comment", |c| { c.document.sections[0].section_def.memo_shape_id = 7; }), "comment 로 구역의 메모 모양 번호");
    no(confined(&mut c, "form comment", shape), "form comment 로 메모 모양");
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

// ── 6단계 S1: 받은 결과(state)를 바뀐 부분만 모델에서 다시 쓰기 ────────────────────────────

const MARKER: &[u8] = b"EVIL-RECORD-PAYLOAD";
const PNG_1PX: [u8; 70] = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 218, 99, 252, 207, 192, 80, 15, 0, 4, 133, 1, 128, 132, 169, 140, 33, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];

/// 바이트(결과 전송 gzip 또는 원본)의 어느 구역 원본 바이트에 표지가 있는가 — 다시 읽어서 본다.
fn sections_carry_marker(bytes: &[u8]) -> bool {
    let doc = DocumentCore::from_bytes(&super::unpack_state(bytes).unwrap()).unwrap();
    doc.document.sections.iter().any(|s| s.raw_stream.as_ref().is_some_and(|r| r.windows(MARKER.len()).any(|w| w == MARKER)))
}

/// 구역 0 의 원본 바이트 끝에 모르는 태그(0x3f0) 레코드를 끼우고 봉인을 다시 해 저장기가 그 바이트를 그대로 쓰게 한 결과.
/// 한/글 파일을 직접 고친 위조와 같은 바이트가 나온다.
fn with_injected_record(c: &mut CollabCore) -> Vec<u8> {
    let section = &mut c.document.sections[0];
    let raw = section.raw_stream.as_mut().expect("구역 원본 바이트");
    let header: u32 = 0x3f0 | ((MARKER.len() as u32) << 20);
    raw.extend_from_slice(&header.to_le_bytes());
    raw.extend_from_slice(MARKER);
    section.seal_raw_provenance();
    c.export_state().unwrap()
}

fn text_doc() -> Vec<u8> {
    let mut c = CollabCore::new(blank());
    c.insert_text_native(0, 0, 0, "본문 글자입니다").unwrap();
    let packed = c.export_state().unwrap();
    super::unpack_state(&packed).unwrap().into_owned()
}

#[test]
fn rewrite_state_keeps_the_canonical_document_and_reloads_to_the_same_model() {
    let raw = text_doc();
    let mut canon = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    let before = canon.digest();
    let mut client = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    client.insert_text_native(0, 0, 0, "더 ").unwrap();
    let c = client.export_state().unwrap();
    let s = canon.rewrite_state(&c).unwrap();
    assert_eq!(canon.digest(), before, "정본은 바꾸지 않는다");
    let mut via_c = CollabCore::new(blank());
    via_c.load_state(&c).unwrap();
    canon.load_state(&s).unwrap();
    assert_eq!(canon.digest(), via_c.digest(), "R(S) 와 R(C) 는 같은 모델");
    // 편집 없는 결과 전송: 바이트까지 정본의 지금 것을 그대로(구역·DocInfo 원본 바이트 재사용)
    let same = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap()).export_state().unwrap();
    let s2 = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap()).rewrite_state(&same).unwrap();
    let mut a = CollabCore::new(blank());
    a.load_state(&s2).unwrap();
    assert_eq!(a.digest(), CollabCore::new(DocumentCore::from_bytes(&raw).unwrap()).digest());
}

#[test]
fn rewrite_state_drops_a_record_injected_into_section_bytes() {
    let raw = text_doc();
    let mut canon = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    let mut client = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    let c = with_injected_record(&mut client);
    assert!(sections_carry_marker(&c), "위조 바이트에 레코드가 있다(전제)");
    let s = canon.rewrite_state(&c).unwrap();
    assert!(!sections_carry_marker(&s), "다시 쓴 바이트에는 없다");
    let unpacked = super::unpack_state(&s).unwrap();
    assert!(!unpacked.windows(MARKER.len()).any(|w| w == MARKER) || !sections_carry_marker(&s), "S 안 어디에도(압축 안 된 구역 포함)");
}

#[test]
fn rewrite_state_trusts_canonical_bytes_only_while_their_seal_matches() {
    // 정본의 원본에 모르는 레코드가 있다(올린 파일 — 믿는 바이트). 그 바이트를 그대로 돌려보낸 결과는 재사용되고(표지 남음),
    // 정본에서 연산으로 그 구역이 바뀐 뒤에는 같은 바이트여도 "같음"으로 보지 않고 모델에서 다시 쓴다(표지 사라짐).
    let raw = text_doc();
    let mut origin = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    let base = super::unpack_state(&with_injected_record(&mut origin)).unwrap().into_owned();
    assert!(sections_carry_marker(&base));
    let mut canon = CollabCore::new(DocumentCore::from_bytes(&base).unwrap());
    let stale = CollabCore::new(DocumentCore::from_bytes(&base).unwrap()).export_state().unwrap();
    assert!(sections_carry_marker(&canon.rewrite_state(&stale).unwrap()), "봉인이 맞는 정본 바이트와 같으면 그대로");
    canon.insert_text_native(0, 0, 0, "연산 ").unwrap();
    assert!(!sections_carry_marker(&canon.rewrite_state(&stale).unwrap()), "연산으로 바뀐 구역은 낡은 바이트와 같다고 보지 않는다");
}

#[test]
fn rewrite_state_uses_canonical_streams_and_drops_unreferenced_bin_data() {
    let raw = text_doc();
    let mut canon = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    let mut client = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    // 그림을 넣었다 지워 참조 없는 BinData 를 남기고, 스크립트 스트림을 더한다
    client.insert_picture_native(0, 0, 0, &[], &PNG_1PX, 1000, 1000, 1, 1, "png", "그림", None, None).unwrap();
    let ci = client.document.sections[0].paragraphs[0].controls.iter().position(|c| matches!(c, crate::model::control::Control::Picture(_)) || matches!(c, crate::model::control::Control::Shape(_))).expect("그림");
    client.delete_picture_control_native(0, 0, ci).unwrap();
    client.document.extra_streams.push(("/Scripts/Evil".to_string(), b"evil();".to_vec()));
    let c = client.export_state().unwrap();
    let reread = DocumentCore::from_bytes(&super::unpack_state(&c).unwrap()).unwrap();
    assert!(!reread.document.bin_data_content.is_empty(), "결과 전송에 참조 없는 BinData 가 있다(전제)");
    assert!(reread.document.extra_streams.iter().any(|(p, _)| p == "/Scripts/Evil"), "결과 전송에 더한 스트림이 있다(전제)");
    let s = canon.rewrite_state(&c).unwrap();
    let out = DocumentCore::from_bytes(&super::unpack_state(&s).unwrap()).unwrap();
    assert!(out.document.bin_data_content.is_empty(), "참조 없는 BinData 를 버림");
    assert!(!out.document.extra_streams.iter().any(|(p, _)| p == "/Scripts/Evil"), "부속 스트림은 정본의 것");
    let names = |d: &crate::model::document::Document| d.extra_streams.iter().map(|(p, _)| p.clone()).filter(|p| p != crate::model::line_seg_tags::HWP_STREAM).collect::<Vec<_>>();
    assert_eq!(names(&out.document), names(&canon.document));
}

/// 결과 바이트를 다시 읽은 문서 모델
fn reread(bytes: &[u8]) -> DocumentCore {
    DocumentCore::from_bytes(&super::unpack_state(bytes).unwrap()).unwrap()
}
fn digest_of(bytes: &[u8]) -> String {
    let mut c = CollabCore::new(blank());
    c.load_state(bytes).unwrap();
    c.digest()
}
fn doc_info_marker(doc: &DocumentCore) -> bool {
    doc.document.doc_info.extra_records.iter().any(|r| r.data == MARKER)
}
fn tail_marker(doc: &DocumentCore) -> bool {
    doc.document.sections.iter().filter_map(|s| s.trailing_lists.as_ref()).any(|t| t.records.iter().any(|r| r.data.windows(MARKER.len()).any(|w| w == MARKER)))
}
fn memo_texts(doc: &DocumentCore) -> Vec<String> {
    let lists = crate::model::section_tail::collect(&doc.document.sections, &crate::storage::Unbounded).unwrap();
    lists.iter().map(|(_, paras)| paras.iter().map(|p| p.text.clone()).collect::<Vec<_>>().join("\n")).collect()
}
const MEMO_SHAPE_JSON: &str = r##"{"width":15591,"lineType":0,"lineWidth":1,"lineColor":"#112233","fillColor":"#F0F0F0","activeColor":"#CCDDEE"}"##;

#[test]
fn rewrite_state_drops_unknown_doc_info_records_the_canonical_does_not_have() {
    // 결정 (C): 파서가 해석하지 않아 모델이 날 바이트로 들고 있는 DocInfo 레코드(extra_records)에 끼운 것 — 모델에서 다시
    // 써도 남으므로(전제) 정본에 같은 내용으로 없던 것을 버린다. 정본에 있던 것은 그대로.
    let raw = text_doc();
    let mut canon = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    let mut client = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    client.document.doc_info.extra_records.push(crate::model::document::RawRecord { tag_id: 0x0fe, level: 0, data: MARKER.to_vec() });
    client.document.doc_info.raw_stream = None;
    let c = client.export_state().unwrap();
    assert!(doc_info_marker(&reread(&c)), "끼운 레코드는 결과와, 다시 읽은 모델에 남는다(전제)");
    let s = canon.rewrite_state(&c).unwrap();
    let out = reread(&s);
    assert!(!doc_info_marker(&out), "다시 쓴 결과에서는 사라진다");
    let keys = |d: &DocumentCore| d.document.doc_info.extra_records.iter().map(|r| (r.tag_id, r.level, r.data.clone())).collect::<Vec<_>>();
    assert_eq!(keys(&out), keys(&canon), "정본에 있던 모르는 레코드는 그대로");
    // 버린 만큼 S 의 내용은 C 와 다르다(모두가 S 를 읽으므로 계보는 맞다) — 끼운 것 말고는 바꾼 것이 없으니 정본과 같다
    assert_ne!(digest_of(&s), digest_of(&c));
    assert_eq!(digest_of(&s), canon.digest());
}

#[test]
fn rewrite_state_keeps_memo_shapes_an_earlier_op_made() {
    // 정상 기능 중 DocInfo 모르는 레코드에 새 내용을 만드는 유일한 것: 메모 모양(연산). 정본이 state 보다 먼저 적용하므로
    // 같은 내용이 있어 남는다.
    let raw = text_doc();
    let mut canon = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    let mut client = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    canon.set_memo_shape_json(Some(0), MEMO_SHAPE_JSON).unwrap();
    client.set_memo_shape_json(Some(0), MEMO_SHAPE_JSON).unwrap();
    client.insert_text_native(0, 0, 0, "더 ").unwrap();
    let c = client.export_state().unwrap();
    let s = canon.rewrite_state(&c).unwrap();
    let out = reread(&s);
    let shapes = crate::model::memo_shape::memo_shapes(&out.document.doc_info);
    assert_eq!(shapes, crate::model::memo_shape::memo_shapes(&canon.document.doc_info));
    assert!(!shapes.is_empty());
    assert_eq!(out.document.doc_info.memo_shape_count, canon.document.doc_info.memo_shape_count);
    assert_eq!(digest_of(&s), digest_of(&c));
}

/// 메모가 있는 문서(마지막 구역 끝 목록에 메모 묶음이 날 레코드로 있다)
fn memo_doc() -> Vec<u8> {
    let mut c = CollabCore::new(DocumentCore::from_bytes(&text_doc()).unwrap());
    c.insert_memo_json_native(0, 0, 0, 2, r#"{"author":"가","text":"메모 본문"}"#).unwrap();
    super::unpack_state(&c.export_state().unwrap()).unwrap().into_owned()
}

#[test]
fn rewrite_state_rewrites_memo_lists_from_the_model_instead_of_dropping_memos() {
    // 메모를 고치면 저장기가 메모 목록을 모델에서 써서, 다시 읽으면 끝 목록이 된다 — 정본(끝 목록 없음)에 같은 내용이 없어
    // 버리지만 메모 봉인을 풀어 모델(메모 본문)에서 다시 쓴다: 메모를 잃지 않는다.
    let raw = text_doc();
    let mut canon = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    let mut client = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    for c in [&mut canon, &mut client] {
        c.insert_memo_json_native(0, 0, 0, 2, r#"{"author":"가","text":"메모 본문"}"#).unwrap();
    }
    let c = client.export_state().unwrap();
    assert!(reread(&c).document.sections.iter().any(|s| s.trailing_lists.is_some()), "결과에는 끝 목록(메모 묶음)이 있다(전제)");
    let s = canon.rewrite_state(&c).unwrap();
    assert_eq!(memo_texts(&reread(&s)), vec!["메모 본문".to_string()]);
    assert_eq!(digest_of(&s), digest_of(&c));
}

#[test]
fn rewrite_state_drops_records_injected_into_the_section_tail() {
    // 결정 (C): 구역 끝 목록에 끼운 것 — (가) 메모 묶음 안, (나) 따로 선 목록(바탕쪽이 아닌 0×0 LIST_HEADER — 끝 목록의
    // 묶음은 늘 수준 1 LIST_HEADER·MEMO_LIST 로 시작한다). 둘 다 사라지고 메모는 그대로.
    let raw = memo_doc();
    let mut canon = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    let inject = |front: bool| {
        let mut client = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
        let last = client.document.sections.len() - 1;
        let section = &mut client.document.sections[last];
        let tail = section.trailing_lists.as_mut().expect("메모 끝 목록");
        if front {
            tail.records.push(crate::model::document::RawRecord { tag_id: crate::parser::tags::HWPTAG_LIST_HEADER, level: 1, data: vec![0; 34] });
        }
        tail.records.push(crate::model::document::RawRecord { tag_id: 0x3f0, level: 2, data: MARKER.to_vec() });
        section.raw_stream = None;
        client.export_state().unwrap()
    };
    for front in [false, true] {
        let c = inject(front);
        assert!(tail_marker(&reread(&c)), "끼운 레코드는 결과와, 다시 읽은 끝 목록에 남는다(전제, front={front})");
        let s = canon.rewrite_state(&c).unwrap();
        let out = reread(&s);
        assert!(!tail_marker(&out), "다시 쓴 결과에서는 사라진다(front={front})");
        assert_eq!(memo_texts(&out), vec!["메모 본문".to_string()], "메모는 그대로(front={front})");
        assert_eq!(digest_of(&s), canon.digest(), "끼운 것 말고는 바꾼 것이 없으니 정본과 같다(front={front})");
    }
    // 끼운 것이 없으면 끝 목록은 정본 것 그대로
    let untouched = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    let mut edited = untouched;
    edited.insert_text_native(0, 0, 0, "더 ").unwrap();
    let s = canon.rewrite_state(&edited.export_state().unwrap()).unwrap();
    let tails = |d: &DocumentCore| d.document.sections.iter().map(|s| s.trailing_lists.as_ref().map(|t| t.records.iter().map(|r| (r.tag_id, r.level, r.data.clone())).collect::<Vec<_>>())).collect::<Vec<_>>();
    assert_eq!(tails(&reread(&s)), tails(&canon));
}

#[test]
fn rewrite_state_rewrites_extension_master_pages_from_the_model() {
    // 확장 바탕쪽 만들기(state): 저장기가 모델에서 확장 바탕쪽 목록을 끝 목록에 쓴다 — 정본에 같은 내용이 없어 버리지만
    // 그 구역의 원본 바탕쪽 묶음을 모두 버려 모델이 다시 쓴다(바탕쪽을 잃지 않는다). 다시 쓴 뒤에는 그 목록이 정본과 같아
    // 그대로 남는다.
    let raw = text_doc();
    let mut canon = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    let mut client = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    client.create_master_page_native(0, r#"{"kind":"last"}"#).unwrap();
    let c = client.export_state().unwrap();
    assert!(reread(&c).document.sections[0].trailing_lists.is_some(), "결과에는 끝 목록(확장 바탕쪽)이 있다(전제)");
    let s = canon.rewrite_state(&c).unwrap();
    let out = reread(&s);
    assert!(out.document.sections[0].section_def.master_pages.iter().any(|m| m.is_extension), "확장 바탕쪽이 남는다");
    assert_eq!(digest_of(&s), digest_of(&c));
    // 그 결과를 읽은 정본에서는 같은 끝 목록이 그대로 재사용된다
    let raw2 = super::unpack_state(&s).unwrap().into_owned();
    let mut canon2 = CollabCore::new(DocumentCore::from_bytes(&raw2).unwrap());
    let mut client2 = CollabCore::new(DocumentCore::from_bytes(&raw2).unwrap());
    client2.insert_text_native(0, 0, 0, "더 ").unwrap();
    let c2 = client2.export_state().unwrap();
    let s2 = canon2.rewrite_state(&c2).unwrap();
    let tail = |d: &DocumentCore| d.document.sections[0].trailing_lists.as_ref().map(|t| t.records.iter().map(|r| (r.tag_id, r.level, r.data.clone())).collect::<Vec<_>>());
    assert_eq!(tail(&reread(&s2)), tail(&canon2));
    assert_eq!(digest_of(&s2), digest_of(&c2));
}

#[test]
fn roundtrip_check_passes_a_document_rhwp_writes_fully_from_its_model() {
    let mut c = CollabCore::new(DocumentCore::from_bytes(&text_doc()).unwrap());
    let before = c.digest();
    let v = c.roundtrip_check().unwrap();
    assert_eq!(v, serde_json::json!({ "ok": true, "lost": [], "irDiff": 0 }));
    assert_eq!(c.digest(), before, "문서를 바꾸지 않는다");
    // HWPX 출처(형식 계열 그대로 점검)
    let hwpx = c.export_hwpx_native().unwrap();
    let h = CollabCore::new(DocumentCore::from_bytes(&hwpx).unwrap());
    assert!(matches!(h.source_format, crate::parser::FileFormat::Hwpx));
    assert_eq!(h.roundtrip_check().unwrap(), serde_json::json!({ "ok": true, "lost": [], "irDiff": 0 }));
}

#[test]
fn roundtrip_check_reports_records_only_the_cached_bytes_keep() {
    // 원본 바이트 캐시 덕에 저장하면 남지만(그대로 저장은 통과) 그 구역을 편집하면 사라지는 레코드 — 점검이 알려야 한다.
    let mut c = CollabCore::new(DocumentCore::from_bytes(&text_doc()).unwrap());
    let packed = with_injected_record(&mut c);
    assert!(sections_carry_marker(&packed), "그대로 저장하면 남는다(전제)");
    let doc = CollabCore::new(reread(&packed));
    let v = doc.roundtrip_check().unwrap();
    assert_eq!(v["ok"], false);
    assert_eq!(v["irDiff"], 0, "모델에는 없던 레코드라 다시 읽은 모델은 같다");
    assert_eq!(v["lost"], serde_json::json!([{ "kind": "record", "count": 1, "detail": "0x3f0×1" }]));
}

// ── 6단계 결과 다시 쓰기 강화(규약 §8.1, collab-core/src/rewrite_raw.rs) ──────────────────────────

/// 표·그림·글상자가 든 문서
fn rich_doc() -> Vec<u8> {
    let mut c = CollabCore::new(DocumentCore::from_bytes(&text_doc()).unwrap());
    let end = c.document.sections[0].paragraphs[0].text.chars().count();
    c.create_table_native(0, 0, end, 2, 2).unwrap();
    let last = c.document.sections[0].paragraphs.len() - 1;
    c.insert_picture_native(0, last, 0, &[], &PNG_1PX, 1000, 1000, 1, 1, "png", "", None, None).unwrap();
    let last = c.document.sections[0].paragraphs.len() - 1;
    c.create_shape_control_native(0, last, 0, 4000, 2000, 0, 0, false, "Square", "textbox", false, false, &[]).unwrap();
    super::unpack_state(&c.export_state().unwrap()).unwrap().into_owned()
}

/// (문단 번호, 컨트롤 번호) — 첫 번째로 `pick` 이 맞는 컨트롤
fn find_ctrl(doc: &DocumentCore, pick: impl Fn(&crate::model::control::Control) -> bool) -> (usize, usize) {
    for (p, para) in doc.document.sections[0].paragraphs.iter().enumerate() {
        if let Some(i) = para.controls.iter().position(&pick) {
            return (p, i);
        }
    }
    panic!("컨트롤 없음");
}

/// 다시 읽은 바이트의 모든 구역·DocInfo 레코드 스트림에서 표지("EVIL-…")를 찾는다
fn evil_marks(bytes: &[u8]) -> Vec<String> {
    let doc = reread(bytes);
    let mut streams: Vec<&Vec<u8>> = doc.document.sections.iter().filter_map(|s| s.raw_stream.as_ref()).collect();
    streams.extend(doc.document.doc_info.raw_stream.as_ref());
    let mut found = std::collections::BTreeSet::new();
    for s in streams {
        for (i, w) in s.windows(5).enumerate() {
            if w == b"EVIL-" {
                let tail = &s[i + 5..(i + 5 + 6).min(s.len())];
                found.insert(String::from_utf8_lossy(tail).chars().take_while(|c| c.is_ascii_alphanumeric()).collect::<String>());
            }
        }
    }
    found.into_iter().collect()
}

fn evil(name: &str) -> Vec<u8> {
    format!("EVIL-{name}").into_bytes()
}

#[test]
fn hardened_rewrite_drops_bytes_injected_into_raw_fields_of_the_model() {
    use crate::model::control::Control;
    use crate::model::shape::ShapeObject;
    let raw = rich_doc();
    let mut canon = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    let mut client = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    let (tp, ti) = find_ctrl(&client, |c| matches!(c, Control::Table(_)));
    let (pp, pi) = find_ctrl(&client, |c| matches!(c, Control::Picture(_)) || matches!(c, Control::Shape(s) if matches!(**s, ShapeObject::Picture(_))));
    let (sp, si) = find_ctrl(&client, |c| matches!(c, Control::Shape(s) if matches!(**s, ShapeObject::Rectangle(_))));
    {
        let doc = &mut client.document;
        doc.doc_info.raw_stream = None;
        doc.doc_info.raw_provenance = None; // 항목별 봉인 없음 → 저장기가 항목 원본을 그대로 쓴다
        doc.doc_info.char_shapes[0].raw_data.as_mut().unwrap().extend(evil("CHARS"));
        let s0 = &mut doc.sections[0];
        s0.raw_stream = None;
        s0.section_def.raw_ctrl_extra.extend(evil("SECD"));
        let paras = &mut s0.paragraphs;
        for c in &mut paras[0].controls {
            if let Control::SectionDef(sd) = c {
                sd.raw_ctrl_extra.extend(evil("SECD"));
            }
        }
        paras[1].raw_header_extra.extend(evil("PHEAD"));
        paras[tp].ctrl_data_records[ti] = Some(evil("CTRLD"));
        if let Control::Table(t) = &mut paras[tp].controls[ti] {
            t.raw_ctrl_data.extend(evil("TBLHD"));
            t.common.raw_extra.extend(evil("COMMON"));
            t.raw_table_record_extra.extend(evil("TBLREC"));
        }
        let pic = match &mut paras[pp].controls[pi] {
            Control::Picture(p) => p.as_mut(),
            Control::Shape(s) => match s.as_mut() {
                ShapeObject::Picture(p) => p.as_mut(),
                _ => unreachable!(),
            },
            _ => unreachable!(),
        };
        let mut extra = vec![0u8; 18];
        extra.extend(evil("PICX"));
        pic.raw_picture_extra = extra;
        if let Control::Shape(s) = &mut paras[sp].controls[si] {
            s.shape_attr_mut().raw_rendering = evil("RENDER");
            if let Some(tb) = s.drawing_mut().and_then(|d| d.text_box.as_mut()) {
                tb.raw_list_header_extra.extend(evil("TBOX"));
            }
        }
    }
    let c = client.export_state().unwrap();
    let planted = evil_marks(&c);
    // 저장기가 그대로 쓰는 자리 — 결과와 다시 읽은 모델에 남는다(전제). 표 머리(TBLHD)는 공통 꼬리를 바꿔 봉인이 어긋나
    // 저장기가 `common` 으로 다시 쓰므로 실리지 않는다(그 길로는 공통 꼬리 COMMON 이 실린다).
    for name in ["CHARS", "SECD", "PHEAD", "CTRLD", "COMMON", "TBLREC", "PIC", "RENDER", "TBOX"] {
        assert!(planted.iter().any(|p| p.starts_with(name)), "{name} 이 결과에 실려야 한다(전제): {planted:?}");
    }
    let (s, changes) = canon.rewrite_state_report(&c).unwrap();
    assert_eq!(evil_marks(&s), Vec::<String>::new(), "다시 쓴 결과에는 하나도 없다 (바꾼 자리 {changes:?})");
    // 내용(글자·표·그림·도형)은 그대로
    let out = reread(&s);
    assert_eq!(texts(&out), texts(&reread(&c)));
    let kinds = |d: &DocumentCore| d.document.sections[0].paragraphs.iter().flat_map(|p| p.controls.iter().map(|c| std::mem::discriminant(c))).count();
    assert_eq!(kinds(&out), kinds(&reread(&c)));
    // 문단 머리 꼬리는 사양 길이(12)로 잘린다 — 앞 12바이트는 그대로
    let before = &reread(&c).document.sections[0].paragraphs[1].raw_header_extra;
    let after = &out.document.sections[0].paragraphs[1].raw_header_extra;
    assert!(after.len() == 10 || after.len() == 12, "{}", after.len());
    assert_eq!(&before[..after.len()], &after[..]);
}

#[test]
fn hardened_rewrite_keeps_raw_fields_the_canonical_has_and_well_formed_numbers() {
    // 끼운 것 없는 결과(다른 구역 편집): 정본의 날 바이트·사양 모양의 숫자 자리는 그대로 남는다
    use crate::model::control::Control;
    let raw = rich_doc();
    let mut canon = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    let mut client = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    client.insert_text_native(0, 0, 0, "더 ").unwrap();
    let c = client.export_state().unwrap();
    let (s, changes) = canon.rewrite_state_report(&c).unwrap();
    let (cin, sout) = (reread(&c), reread(&s));
    let renderings = |d: &DocumentCore| {
        d.document.sections[0].paragraphs.iter().flat_map(|p| p.controls.iter()).filter_map(|c| match c {
            Control::Shape(s) => Some(s.clone().shape_attr_mut().raw_rendering.clone()),
            _ => None,
        }).collect::<Vec<_>>()
    };
    assert!(renderings(&cin).iter().all(|r| !r.is_empty()), "도형 렌더링 행렬이 있다(전제)");
    assert_eq!(renderings(&sout), renderings(&cin), "사양 모양의 렌더링 행렬은 그대로");
    let heads = |d: &DocumentCore| d.document.sections[0].paragraphs.iter().map(|p| p.raw_header_extra.clone()).collect::<Vec<_>>();
    assert_eq!(heads(&sout), heads(&cin), "문단 머리 꼬리(10·12바이트)는 그대로");
    assert!(changes.is_empty(), "정본 것만 있으면 바꾸지 않는다: {changes:?}");
    assert_eq!(digest_of(&s), digest_of(&c));
}

#[test]
fn hardened_rewrite_remembers_raw_bytes_the_canonical_saw_before_an_op_removed_them() {
    // 결정 2: 되돌리기 계열 state 가 지금 정본에 없는 옛 날 바이트를 되살려도 잃지 않는다 — 정본을 열 때부터 모은 기록.
    use crate::model::control::Control;
    let raw = {
        // 표 컨트롤에 한컴이 둔 듯한 CTRL_DATA(모델에서 다시 만들 수 없는 자리)
        let mut c = CollabCore::new(DocumentCore::from_bytes(&rich_doc()).unwrap());
        let (tp, ti) = find_ctrl(&c, |c| matches!(c, Control::Table(_)));
        c.document.sections[0].paragraphs[tp].ctrl_data_records[ti] = Some(b"\x1b\x02\x01\x00\x00\x00PARAMSET-FROM-HANCOM".to_vec());
        c.document.sections[0].raw_stream = None;
        super::unpack_state(&c.export_state().unwrap()).unwrap().into_owned()
    };
    let restored = super::pack_state(&raw).unwrap(); // 표를 지운 뒤 되살린 결과(옛 문서 그대로)
    let has_param = |bytes: &[u8]| {
        let d = reread(bytes);
        d.document.sections[0].paragraphs.iter().flat_map(|p| p.ctrl_data_records.iter().flatten()).any(|b| b.ends_with(b"PARAMSET-FROM-HANCOM"))
    };
    assert!(has_param(&restored), "전제");
    let delete_table = |c: &mut CollabCore| {
        let (tp, ti) = find_ctrl(c, |c| matches!(c, Control::Table(_)));
        c.delete_table_control_native(0, tp, ti).unwrap();
    };
    // 정본이 열 때부터 모았으면: 표를 지운 op 뒤에도 그 바이트를 안다
    let mut tracked = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    tracked.track_raw_seen();
    delete_table(&mut tracked);
    assert!(has_param(&tracked.rewrite_state(&restored).unwrap()), "열 때부터 모은 정본은 되살린 바이트를 남긴다");
    // 모으기 전에 지워졌으면(지금 정본에만 견주면) 버린다 — 기록이 하는 일
    let mut late = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    delete_table(&mut late);
    assert!(!has_param(&late.rewrite_state(&restored).unwrap()));
    // 결과를 읽을 때도 모은다: 지운 문서를 결과로 읽은 뒤에도 그 전 문서의 바이트를 안다
    let mut via_state = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    via_state.track_raw_seen();
    let mut deleted = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    delete_table(&mut deleted);
    via_state.load_state(&deleted.export_state().unwrap()).unwrap();
    assert!(has_param(&via_state.rewrite_state(&restored).unwrap()));
}

/// HWPX 결과 바이트의 모든 패키지 항목 글(압축 풀어 이어 붙임)
fn hwpx_text(packed: &[u8]) -> String {
    let raw = super::unpack_state(packed).unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(raw.as_ref())).unwrap();
    let mut all = String::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).unwrap();
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut f, &mut buf).unwrap();
        all.push_str(&String::from_utf8_lossy(&buf));
    }
    all
}

/// 하이퍼링크(누름틀)가 든 HWPX 출처 문서
fn hwpx_doc() -> Vec<u8> {
    let mut c = CollabCore::new(DocumentCore::from_bytes(&text_doc()).unwrap());
    c.insert_hyperlink_native(&crate::document_core::hyperlink::HyperlinkTarget::body(0, 0), 0, 2, "https://example.com/").unwrap();
    let hwpx = c.export_hwpx_native().unwrap();
    let doc = DocumentCore::from_bytes(&hwpx).unwrap();
    assert!(matches!(doc.source_format, crate::parser::FileFormat::Hwpx));
    hwpx
}

#[test]
fn hardened_rewrite_drops_xml_injected_into_hwpx_verbatim_fragments() {
    use crate::model::control::Control;
    let raw = hwpx_doc();
    let mut canon = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    let mut client = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    {
        let doc = &mut client.document;
        doc.doc_info.memo_properties_xml = Some(r#"<hh:memoProperties itemCnt="1"><EVIL-MEMOPR/></hh:memoProperties>"#.to_string());
        let tail = doc.doc_info.hwpx_head_tail.as_mut().expect("문서 설정 구간(전제)");
        tail.insert_str(0, "<EVIL-HEADTAIL/>");
        if let Some(n) = doc.doc_info.numberings.first_mut() {
            n.raw_para_heads = Some("<EVIL-NUMHEAD/>".to_string());
        }
        let field = doc.sections[0].paragraphs.iter_mut().flat_map(|p| p.controls.iter_mut()).find_map(|c| match c {
            Control::Field(f) => Some(f),
            _ => None,
        }).expect("하이퍼링크 누름틀(전제)");
        let params = field.raw_parameters_xml.as_mut().expect("parameters 원문(전제)");
        params.push_str("<EVIL-PARAMS/>");
    }
    let c = client.export_state().unwrap();
    let text = hwpx_text(&c);
    let mut planted = vec!["EVIL-MEMOPR", "EVIL-HEADTAIL", "EVIL-PARAMS"];
    if client.document.doc_info.numberings.first().is_some() {
        planted.push("EVIL-NUMHEAD");
    }
    for m in &planted {
        assert!(text.contains(m), "{m} 이 결과에 실려야 한다(전제)");
    }
    let (s, changes) = canon.rewrite_state_report(&c).unwrap();
    let out = hwpx_text(&s);
    assert!(!out.contains("EVIL-"), "다시 쓴 결과에는 없다 (바꾼 자리 {changes:?})");
    // 내용은 그대로: 글자, 하이퍼링크 대상
    assert_eq!(texts(&reread(&s)), texts(&reread(&c)));
    assert!(out.contains("example.com"), "하이퍼링크 대상은 command 로 다시 쓴다");
}

#[test]
fn hardened_rewrite_keeps_hwpx_fragments_the_canonical_has() {
    let raw = hwpx_doc();
    let mut canon = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    let mut client = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    client.insert_text_native(0, 0, 0, "더 ").unwrap();
    let c = client.export_state().unwrap();
    let (s, changes) = canon.rewrite_state_report(&c).unwrap();
    assert!(changes.is_empty(), "{changes:?}");
    let (cin, sout) = (reread(&c), reread(&s));
    assert_eq!(sout.document.doc_info.hwpx_head_tail, cin.document.doc_info.hwpx_head_tail);
    assert_eq!(digest_of(&s), digest_of(&c));
}

#[test]
fn hardened_rewrite_keeps_memo_shapes_an_earlier_op_made_on_hwpx() {
    // 메모 모양 op 는 정본에서 memoProperties 원문을 비우고 레코드로 둔다. 결과 C 는 저장기가 쓴 원문을 싣고 오므로 원문은
    // "모르는 것"이지만, 비워도 메모 모양 레코드로 다시 쓴다 — 메모 모양을 잃지 않는다.
    let raw = hwpx_doc();
    let mut canon = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    let mut client = CollabCore::new(DocumentCore::from_bytes(&raw).unwrap());
    canon.set_memo_shape_json(Some(0), MEMO_SHAPE_JSON).unwrap();
    client.set_memo_shape_json(Some(0), MEMO_SHAPE_JSON).unwrap();
    client.insert_text_native(0, 0, 0, "더 ").unwrap();
    let c = client.export_state().unwrap();
    let s = canon.rewrite_state(&c).unwrap();
    let shapes = |d: &DocumentCore| crate::model::memo_shape::memo_shapes(&d.document.doc_info);
    assert!(!shapes(&reread(&c)).is_empty(), "전제");
    assert_eq!(shapes(&reread(&s)), shapes(&reread(&c)));
    assert!(hwpx_text(&s).contains("memoPr"), "memoProperties 를 다시 쓴다");
}

#[test]
fn dropping_a_bullet_para_head_keeps_the_image_reference() {
    let mut bullet = crate::model::style::Bullet { image_bullet: 3, raw_para_head: Some("<hh:paraHead/><hh:img/>".to_string()), ..Default::default() };
    assert_eq!(bullet.image_reference(), Some(3));
    let mut info = crate::model::document::DocInfo::default();
    info.bullets.push(std::mem::take(&mut bullet));
    let mut props = crate::model::document::DocProperties::default();
    let mut changes = Default::default();
    super::rewrite_raw::sanitize_doc_info(&mut info, &mut props, &Default::default(), &mut changes);
    assert_eq!(info.bullets[0].raw_para_head, None);
    assert_eq!(info.bullets[0].image_reference(), Some(3), "그림 번호를 모델 필드로 옮긴다");
}

#[test]
fn op_args_gate_limits_para_header_tails_carried_by_split_undo_meta() {
    let mut c = CollabCore::new(DocumentCore::from_bytes(&text_doc()).unwrap());
    let meta = |n: usize| serde_json::json!({ "para_shape_id": 0, "style_id": 0, "column_type": "None", "raw_break_type": 0, "numbering_restart": null, "raw_header_extra": vec![0u8; n], "tab_extended": [] }).to_string();
    for n in [0, 10, 12] {
        assert_eq!(c.check_op_args("splitParagraph", &serde_json::json!([0, 0, 1, meta(n)])), Ok(()), "{n}");
        assert_eq!(c.check_op_args("splitParagraphInCellByPath", &serde_json::json!([0, 0, "[]", 1, meta(n)])), Ok(()), "{n}");
    }
    for n in [4, 11, 40] {
        assert!(c.check_op_args("splitParagraph", &serde_json::json!([0, 0, 1, meta(n)])).is_err(), "{n}");
        assert!(c.check_op_args("splitParagraphInHeaderFooter", &serde_json::json!([0, true, 0, 0, 1, meta(n)])).is_err(), "{n}");
    }
    // 메타가 없는 보통 Enter, 다른 함수는 그대로
    assert_eq!(c.check_op_args("splitParagraph", &serde_json::json!([0, 0, 1])), Ok(()));
    assert_eq!(c.check_op_args("splitParagraph", &serde_json::json!([0, 0, 1, null])), Ok(()));
    assert_eq!(c.check_op_args("insertText", &serde_json::json!([0, 0, 0, "가"])), Ok(()));
    assert!(c.check_op_args("splitParagraph", &serde_json::json!([0, 0, 1, "{깨진"])).is_err());
    assert!(c.raw_seen_len().is_some(), "처음 부르면 본 바이트 기록을 켠다");
}

/// XML 조각에 나오는 요소 이름(시작·빈 요소)
fn xml_element_names(fragment: &str) -> Vec<String> {
    let mut reader = quick_xml::Reader::from_str(fragment);
    let mut names = Vec::new();
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e)) | Ok(quick_xml::events::Event::Empty(e)) => {
                let name = e.name();
                let text: &str = name.as_ref();
                names.push(text.to_string());
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Ok(_) => {}
            Err(e) => panic!("조각이 올바른 XML 이 아니다: {e} — {fragment}"),
        }
    }
    names
}

/// 악의적인 값을 담은 한컴 클립보드 모델(hwpjson) — 번호·글머리표 문단 머리, 메모 모양, 본문 글자
fn hostile_hwpjson(text: &str, format: &str, bullet: &str) -> String {
    serde_json::json!({
        "ro": { "hp": "p0", "p0": { "id": 0, "ru": [{ "cp": "", "ch": [{ "t": text }] }] } },
        "nu": { "n1": { "sn": 1, "ph": [{ "le": 1, "sf": format }] } },
        "bu": { "b1": { "ch": bullet, "ph": { "le": 1, "sf": format } } },
        "mp": { "m1": { "wi": 15591 } },
    })
    .to_string()
}

#[test]
fn hancom_paste_fragments_are_escaped_xml_rhwp_builds_not_a_raw_channel() {
    // 규약 §8.1: 한컴 조각(pasteHwpJson)은 rhwp 가 JSON 에서 이스케이프해 만든 XML 이라 원문·날 바이트 통로가 아니다 —
    // 변환기의 이스케이프가 깨지면 이 시험이 잡는다(문서에 붙는 원문 조각 자리에 모르는 요소가 생기거나 값이 글자 그대로가 아님).
    let text = "글\"><x/></hp:t></hp:run><evil/>&lt;&";
    let format = "^1.\"><x/></hh:paraHead><evil/>&amp;&";
    let bullet = "\"/><evil/>";
    let mut c = CollabCore::new(DocumentCore::from_bytes(&text_doc()).unwrap());
    c.paste_hwp_json_native(0, 0, 0, &hostile_hwpjson(text, format, bullet)).expect("붙여넣기");
    let info = &c.document.doc_info;
    // 번호: 형식 문자열이 글자 그대로, 원문 조각은 rhwp 가 만든 paraHead 뿐
    let numbering = info.numberings.iter().find(|n| n.level_formats.iter().any(|f| f == format)).expect("붙인 번호 정의의 형식이 글자 그대로");
    let heads = numbering.raw_para_heads.as_deref().expect("번호 원문 조각(전제)");
    assert!(xml_element_names(heads).iter().all(|n| n == "hh:paraHead"), "{heads}");
    // 글머리표: 원문 조각에는 paraHead(·img)뿐. 글자는 첫 글자 — 업스트림 HWPX 파서가 `char` 속성을 풀지 않고 읽어
    // (`attr_str` 를 쓰지 않음) `&quot;` 의 '&' 가 된다. 이스케이프는 지켜졌다(요소가 생기지 않음) — 글자 그대로가 아닌 것은
    // 업스트림 결함이라 고쳐지면 '"' 가 된다.
    let pasted_bullet = info.bullets.iter().find(|b| b.raw_para_head.is_some()).expect("붙인 글머리표(전제)");
    assert!(matches!(pasted_bullet.bullet_char, '"' | '&'), "{:?}", pasted_bullet.bullet_char);
    let head = pasted_bullet.raw_para_head.as_deref().unwrap();
    assert!(xml_element_names(head).iter().all(|n| n == "hh:paraHead" || n == "hh:img"), "{head}");
    // 메모 모양: rhwp 가 만든 memoProperties/memoPr 뿐
    let memo = info.memo_properties_xml.as_deref().expect("메모 모양 원문 조각(전제 — 문서에 없어 조각 것을 옮긴다)");
    assert!(xml_element_names(memo).iter().all(|n| n == "hh:memoProperties" || n == "hh:memoPr"), "{memo}");
    // 누름틀 parameters: hwpjson 은 누름틀을 만들지 않는다 — 원문 조각이 생기지 않는다
    let fields = c.document.sections[0].paragraphs.iter().flat_map(|p| p.controls.iter()).filter_map(|ctrl| match ctrl {
        crate::model::control::Control::Field(f) => f.raw_parameters_xml.clone(),
        _ => None,
    }).count();
    assert_eq!(fields, 0);
    // 본문 글자도 글자 그대로
    assert!(texts(&c).iter().any(|t| t.contains(text)), "{:?}", texts(&c));
    // 제어 문자: 받아들이면 글자로만 남고(요소가 생기지 않음), 받아들이지 않으면 붙여넣기 전체가 실패한다 — 어느 쪽도 통로가 아니다
    let mut d = CollabCore::new(DocumentCore::from_bytes(&text_doc()).unwrap());
    let before = d.digest();
    match d.paste_hwp_json_native(0, 0, 0, &hostile_hwpjson("제어\u{1}\u{8}글자", "^1.\u{1}<evil/>", "\u{1}")) {
        Ok(_) => {
            for n in &d.document.doc_info.numberings {
                if let Some(h) = &n.raw_para_heads {
                    assert!(xml_element_names(h).iter().all(|x| x == "hh:paraHead"), "{h}");
                }
            }
        }
        Err(_) => assert_eq!(d.digest(), before, "실패하면 문서는 그대로"),
    }
}

#[test]
fn roundtrip_check_ignores_empty_bin_data_hwp3_link_placeholders_leave() {
    // hwp3-sample10: 그림 셋이 연결(Link) 그림이라 내용이 없고, HWP3 파서가 채워 둔 빈 자리(id 0)를 HWP5 저장기가 빈 deflate
    // `BIN0000.` 스트림으로 쓴다 — 다시 읽으면 아무 레코드도 가리키지 않아 사라지지만 잃는 내용은 없다(거짓 경고였다).
    let bytes = sample("samples/hwp3-sample10.hwp");
    let c = CollabCore::new(DocumentCore::from_bytes(&bytes).unwrap());
    let saved = c.export_hwp_native().unwrap();
    let fp = crate::diagnostics::hwp5_roundtrip_batch::bindata_fingerprint(&saved).expect("CFB");
    assert_eq!(fp.get(&super::bytes_hash(&[])), Some(&1), "저장본에 빈 BinData 하나(전제): {fp:?}");
    let v = c.roundtrip_check().unwrap();
    assert!(!v["lost"].as_array().unwrap().iter().any(|l| l["kind"] == "bindata"), "{v}");
}

#[test]
fn empty_bin_data_is_dropped_from_the_original_fingerprint_only() {
    use crate::diagnostics::hwp5_roundtrip_batch::multiset_lost;
    let empty = super::bytes_hash(&[]);
    let image = super::bytes_hash(b"PNG...");
    let mut orig = std::collections::BTreeMap::from([(empty, 1), (image, 2)]);
    super::drop_empty_bindata(&mut orig);
    assert_eq!(orig, std::collections::BTreeMap::from([(image, 2)]));
    // 내용 있는 항목이 사라진 것은 그대로 센다
    assert_eq!(multiset_lost(&orig, &std::collections::BTreeMap::from([(image, 1)])), 1);
    assert_eq!(multiset_lost(&orig, &std::collections::BTreeMap::new()), 2);
}
