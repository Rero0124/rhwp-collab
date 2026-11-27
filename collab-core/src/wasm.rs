//! 공동편집 보조의 JS 표면 (docs/collab-stage2.md §5). 업스트림 `HwpDocument` 에 메서드를 덧붙인다.
//!
//! `HwpDocument` 는 `Deref<Target = CollabCore>` 이므로 `self.snapshot_save()` 같은 호출은 `CollabCore` 로
//! 내려간다. 이 메서드들은 `collab*` 이름이라 기록 훅 대상이 아니다(분류표 생성 스크립트가 뺀다).

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

#[wasm_bindgen]
impl HwpDocument {
    /// 자체 스냅샷을 뜬다(업스트림 undo 저장소와 별개). 반환: id.
    #[wasm_bindgen(js_name = collabSnapshotSave)]
    pub fn collab_snapshot_save(&mut self) -> u32 {
        self.snapshot_save()
    }

    /// 자체 스냅샷으로 문서를 되돌린다(스냅샷은 남는다).
    #[wasm_bindgen(js_name = collabSnapshotRestore)]
    pub fn collab_snapshot_restore(&mut self, id: u32) -> Result<(), JsValue> {
        self.snapshot_restore(id).map_err(js_err)
    }

    #[wasm_bindgen(js_name = collabSnapshotDiscard)]
    pub fn collab_snapshot_discard(&mut self, id: u32) {
        self.snapshot_discard(id)
    }

    /// 결과(문서 전체)를 이 객체 안에서 적재한다. studio 문서 교체를 거치지 않는다.
    #[wasm_bindgen(js_name = collabLoadState)]
    pub fn collab_load_state(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        self.load_state(bytes).map_err(js_err)
    }

    /// 결과 전송용 내보내기(캐럿을 쓰지 않음). 원본 형식 계열(HWPX→HWPX, 그 밖 → HWP)을 gzip 으로 감싼 바이트.
    #[wasm_bindgen(js_name = collabExportState)]
    pub fn collab_export_state(&self) -> Result<Vec<u8>, JsValue> {
        self.export_state().map_err(js_err)
    }

    /// 텍스트 연산 메타 실측. `phase` 는 `"before"`/`"after"`, `before_json` 은 before 결과(after 때만).
    #[wasm_bindgen(js_name = collabMeasure)]
    pub fn collab_measure(&self, phase: &str, method: &str, args_json: &str, before_json: &str) -> Result<String, JsValue> {
        let args = parse(args_json, "args")?;
        let args = args.as_array().cloned().unwrap_or_default();
        let before = parse(before_json, "before")?;
        self.measure(phase, method, &args, &before).map(|v| v.to_string()).map_err(js_err)
    }

    /// 지금 `active_field`(숨은 입력) — JSON 또는 `"null"`.
    #[wasm_bindgen(js_name = collabGetActiveField)]
    pub fn collab_get_active_field(&self) -> String {
        self.active_field_json().to_string()
    }

    /// `active_field` 를 맞추고 이전 값을 돌려준다(재생 때 잠시 맞추고 되돌리는 용도).
    #[wasm_bindgen(js_name = collabSetActiveField)]
    pub fn collab_set_active_field(&mut self, json: &str) -> Result<String, JsValue> {
        let v = parse(json, "activeField")?;
        self.set_active_field_json(&v).map(|p| p.to_string()).map_err(js_err)
    }

    /// 논리 오프셋 → `{"offset":N,"afterControl":bool}` (텍스트 좌표).
    #[wasm_bindgen(js_name = collabLogicalToText)]
    pub fn collab_logical_to_text(&self, section: u32, para: u32, logical: u32) -> Result<String, JsValue> {
        let (offset, after) = self.logical_to_text(section as usize, para as usize, logical as usize).map_err(js_err)?;
        Ok(serde_json::json!({ "offset": offset, "afterControl": after }).to_string())
    }

    /// 텍스트 오프셋(+개체 뒤 여부) → 논리 오프셋.
    #[wasm_bindgen(js_name = collabTextToLogical)]
    pub fn collab_text_to_logical(&self, section: u32, para: u32, offset: u32, after_control: bool) -> Result<u32, JsValue> {
        self.text_to_logical(section as usize, para as usize, offset as usize, after_control)
            .map(|v| v as u32)
            .map_err(js_err)
    }

    /// 되감기 재적용용 보정(순수 함수). 결과 `{"pending":[..],"dropFrom":i|null,"dropReason":..,"caret":..}`.
    #[wasm_bindgen(js_name = collabTransform)]
    pub fn collab_transform(&self, pending_json: &str, remote_json: &str, catalog_json: &str, caret_json: &str) -> Result<String, JsValue> {
        let pending = parse(pending_json, "pending")?.as_array().cloned().unwrap_or_default();
        let remote = parse(remote_json, "remote")?.as_array().cloned().unwrap_or_default();
        let catalog = parse(catalog_json, "catalog")?;
        let caret = parse(caret_json, "caret")?;
        Ok(super::ot::rebase(&pending, &remote, &catalog, &caret).to_string())
    }

    /// 미확정이 없을 때 원격 열의 지도로 캐럿만 옮긴다.
    #[wasm_bindgen(js_name = collabMapCaret)]
    pub fn collab_map_caret(&self, remote_json: &str, catalog_json: &str, caret_json: &str) -> Result<String, JsValue> {
        let remote = parse(remote_json, "remote")?.as_array().cloned().unwrap_or_default();
        let catalog = parse(catalog_json, "catalog")?;
        let caret = parse(caret_json, "caret")?;
        Ok(super::ot::map_caret_through(&remote, &catalog, &caret).to_string())
    }

    /// 4단계: 되돌리기 스택의 위치들을 기록 열 뒤로 옮긴다(순수 함수). 결과는 위치마다 `{…, hit}`.
    #[wasm_bindgen(js_name = collabMapPositions)]
    pub fn collab_map_positions(&self, recs_json: &str, catalog_json: &str, items_json: &str) -> Result<String, JsValue> {
        let recs = parse(recs_json, "recs")?.as_array().cloned().unwrap_or_default();
        let catalog = parse(catalog_json, "catalog")?;
        let items = parse(items_json, "items")?.as_array().cloned().unwrap_or_default();
        Ok(super::ot::map_positions(&recs, &catalog, &items).to_string())
    }

    /// 5단계 D4(서버 정본): 스냅샷 뒤의 변경이 좁은 권한(`form`·`comment`·`form comment`)이 허용하는 부분뿐인가.
    /// `{"ok":true}` | `{"ok":false,"reason":"confined","detail":".."}`.
    #[wasm_bindgen(js_name = collabCheckConfined)]
    pub fn collab_check_confined(&self, snapshot_id: u32, kind: &str) -> Result<String, JsValue> {
        self.check_confined(snapshot_id, kind).map(|v| v.to_string()).map_err(js_err)
    }

    /// 5단계 D4(클라이언트 문): 글자 연산 호출(호출 전)이 활성 누름틀 안에 완전히 드는가.
    #[wasm_bindgen(js_name = collabFieldContains)]
    pub fn collab_field_contains(&self, method: &str, args_json: &str, active_field_json: &str) -> Result<bool, JsValue> {
        let args = parse(args_json, "args")?.as_array().cloned().unwrap_or_default();
        let af = parse(active_field_json, "activeField")?;
        self.field_contains_call(method, &args, &af).map_err(js_err)
    }

    /// 4단계: 명령이 만든 기록 열의 발자국 `{items, whole, nested}`(순수 함수).
    #[wasm_bindgen(js_name = collabFootprint)]
    pub fn collab_footprint(&self, entries_json: &str, catalog_json: &str) -> Result<String, JsValue> {
        let entries = parse(entries_json, "entries")?.as_array().cloned().unwrap_or_default();
        let catalog = parse(catalog_json, "catalog")?;
        Ok(super::ot::footprint(&entries, &catalog).to_string())
    }

    /// 문서 모델의 지문(hex, 캐럿 제외).
    #[wasm_bindgen(js_name = collabDigest)]
    pub fn collab_digest(&self) -> String {
        self.digest()
    }

    /// 기록하는 쪽: 내부 클립보드를 직렬화→다시 읽은 값으로 바꾸고 그 JSON 을 돌려준다(ctx.clipboard).
    #[wasm_bindgen(js_name = collabNormalizeClipboard)]
    pub fn collab_normalize_clipboard(&mut self) -> Result<String, JsValue> {
        self.normalize_clipboard().map(|v| v.to_string()).map_err(js_err)
    }

    /// 재생하는 쪽: 기록의 클립보드로 잠시 바꾼다(지금 것은 맡겨 둠).
    #[wasm_bindgen(js_name = collabPushClipboard)]
    pub fn collab_push_clipboard(&mut self, json: &str) -> Result<(), JsValue> {
        let v = parse(json, "clipboard")?;
        self.push_clipboard(&v).map_err(js_err)
    }

    /// 맡겨 둔 클립보드로 되돌린다.
    #[wasm_bindgen(js_name = collabPopClipboard)]
    pub fn collab_pop_clipboard(&mut self) {
        self.pop_clipboard();
    }

    /// 미뤄 둔 조판을 끝낸다(`layout` 연산의 기록·재생 직전). 문서 IR 은 바꾸지 않는다.
    #[wasm_bindgen(js_name = collabFlushLayout)]
    pub fn collab_flush_layout(&mut self) {
        let _ = self.flush_deferred_pagination();
    }
}
