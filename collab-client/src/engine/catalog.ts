// 생성 파일 — 직접 고치지 않는다. scripts/gen-catalog.mjs 가 만든다.
// 판정은 catalog-overrides.ts, 동작 동일성 검사 결과는 catalog-drift.json 에서 온다.
import type { CatalogEntry } from './types.ts';

/** 엔진 지문: 업스트림 커밋-패치 해시-보정·기록 코드 해시-분류표 해시. 방의 참여자는 모두 같아야 한다. */
export const ENGINE_FINGERPRINT = "981ce66b4183-501584aa365e-839b81717d23-d0e76ac479bb";

/** studio 합성 메서드(레지스트리에 있으나 export 가 아님). 내부에서 분류표의 export 를 부른다. */
export const COMPOSED_METHODS: readonly string[] = ["setPageMargin","insertHyperlink","updateHyperlink","replaceHyperlinkText","removeHyperlink"];

/** {"total":314,"op":191,"state":53,"local":1,"none":69,"watch":0,"text":23,"neutral":50,"structural":118,"ctx":28,"layout":11,"permForm":6,"permMemo":5,"unreviewed":0} */
export const CATALOG: Readonly<Record<string, CatalogEntry>> = {
  "addBookmark": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "sec",
      "para",
      "char_offset",
      "name"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "applyCellBorderFillIds": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "셀 테두리·배경 id 만 바꾼다(되돌리기 저널은 비문서 저장소)",
    "reviewed": true,
    "reach": "studio"
  },
  "applyCellStyle": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "sec_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx",
      "style_id"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "셀 안 글자·문단 모양만 바꾼다(본문 문단·개체 번호 불변)",
    "reviewed": true,
    "reach": "studio"
  },
  "applyCharFormat": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "sec_idx",
      "para_idx",
      "start_offset",
      "end_offset",
      "props_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "range",
        "para": 1,
        "start": 2,
        "end": 3
      }
    ],
    "why": "글자 모양만 바꾼다(글자 모양 목록에 덧붙일 수 있으나 기존 id 불변)",
    "reviewed": true,
    "reach": "studio"
  },
  "applyCharFormatAtCursor": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "list_id",
      "para_in_list",
      "start_pos",
      "end_pos",
      "props_json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "applyCharFormatInCell": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "sec_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx",
      "start_offset",
      "end_offset",
      "props_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "셀 안 글자·문단 모양만 바꾼다(본문 문단·개체 번호 불변)",
    "reviewed": true,
    "reach": "studio"
  },
  "applyCharFormatInCellByPath": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "path_json",
      "start_offset",
      "end_offset",
      "props_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "셀 안 글자·문단 모양만 바꾼다(본문 문단·개체 번호 불변)",
    "reviewed": true,
    "reach": "studio"
  },
  "applyCharFormatInCellEx": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 1개 < 5, 성공 230/300)",
    "reach": "none"
  },
  "applyCharFormatInHeaderFooter": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "is_header",
      "apply_to",
      "start_hf_para_idx",
      "start_char_offset",
      "end_hf_para_idx",
      "end_char_offset",
      "props_json"
    ],
    "section": 0,
    "roles": [],
    "why": "머리말·꼬리말 안 글자 모양만 바꾼다(본문 위치 무관)",
    "reviewed": true,
    "reach": "studio"
  },
  "applyEndnoteShape": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "props_json"
    ],
    "section": 0,
    "roles": [],
    "why": "구역의 미주 모양만 바꾼다",
    "reviewed": true,
    "reach": "studio"
  },
  "applyFootnoteShape": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "props_json"
    ],
    "section": 0,
    "roles": [],
    "layout": true,
    "why": "구역의 각주 모양만 바꾼다. 쪽별 번호를 조판 결과로 다시 매긴다",
    "reviewed": true,
    "reach": "none"
  },
  "applyFormActionUpdates": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "updates_json"
    ],
    "section": null,
    "perm": "form",
    "reviewed": true,
    "reach": "studio"
  },
  "applyHfTemplate": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "is_header",
      "apply_to",
      "template_id"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "applyParaFormat": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "sec_idx",
      "para_idx",
      "props_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "para",
        "arg": 1
      }
    ],
    "layout": true,
    "why": "문단 모양만 바꾼다. 미주 가상 문단 주소는 조판 결과로 찾는다",
    "reviewed": true,
    "reach": "studio"
  },
  "applyParaFormatAtCursor": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "list_id",
      "para_in_list",
      "props_json"
    ],
    "section": null,
    "layout": true,
    "why": "목록·문단 주소(list_id·para_in_list)는 문서로 정해지나 roles 로 옮길 수 없다. 미주 가상 문단은 조판 결과로 찾는다",
    "reviewed": true,
    "reach": "none"
  },
  "applyParaFormatInCell": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "sec_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx",
      "props_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "셀 안 글자·문단 모양만 바꾼다(본문 문단·개체 번호 불변)",
    "reviewed": true,
    "reach": "studio"
  },
  "applyParaFormatInCellByPath": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "path_json",
      "props_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "셀 안 글자·문단 모양만 바꾼다(본문 문단·개체 번호 불변)",
    "reviewed": true,
    "reach": "studio"
  },
  "applyParaFormatInFootnote": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "para_idx",
      "control_idx",
      "fn_para_idx",
      "props_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "각주 안 문단 모양만 바꾼다",
    "reviewed": true,
    "reach": "studio"
  },
  "applyParaFormatInHf": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "is_header",
      "apply_to",
      "hf_para_idx",
      "props_json"
    ],
    "section": 0,
    "roles": [],
    "why": "머리말·꼬리말 안 문단 모양만 바꾼다(본문 위치 무관)",
    "reviewed": true,
    "reach": "studio"
  },
  "applyShapeZOrderPairs": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "pairs_json"
    ],
    "section": 0,
    "why": "z 대입 쌍의 문단·개체 위치가 JSON 안에 있어 옮길 수 없다",
    "reviewed": true,
    "reach": "studio"
  },
  "applyStyle": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "sec_idx",
      "para_idx",
      "style_id"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "para",
        "arg": 1
      }
    ],
    "why": "문단에 스타일을 적용한다(문단 수·텍스트 불변)",
    "reviewed": true,
    "reach": "studio"
  },
  "applyTemplateOperation": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "assignPictureImage": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "cell_path_json",
      "control_idx",
      "image_data",
      "natural_width_px",
      "natural_height_px",
      "extension"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "attachCaptionAt": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "para_in_list",
      "control_index"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 4개 < 5, 성공 300/300)",
    "reach": "none"
  },
  "beginBatch": {
    "sync": "none",
    "conc": "structural",
    "params": [],
    "section": null,
    "why": "배치 괄호 — 쪽 소속 확정만 endBatch 로 미룬다. 배치 밖 재생과 문서 결과가 같다고 보고 R5 runInBatch 사례로 검증한다",
    "reviewed": true,
    "reach": "plugin"
  },
  "beginDeferredPagination": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "fragment_budget"
    ],
    "section": null,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "breakAtCursor": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "list_id",
      "para_in_list",
      "pos",
      "kind"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "cancelDeferredPagination": {
    "sync": "none",
    "conc": "structural",
    "params": [],
    "section": null,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "captureDeleteRange": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "section_idx",
      "start_para",
      "end_para"
    ],
    "section": 0,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "capturePictureTransform": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "target_json"
    ],
    "section": null,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "captureSectionRaw": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "section_idx"
    ],
    "section": 0,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "changeShapeZOrder": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "operation"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "구역 안 도형의 z 순서 값만 바꾼다(개체 목록 순서 불변)",
    "reviewed": true,
    "reach": "studio"
  },
  "clearActiveField": {
    "sync": "none",
    "conc": "structural",
    "params": [],
    "section": null,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "clearClipboard": {
    "sync": "none",
    "conc": "structural",
    "params": [],
    "section": null,
    "why": "내부 클립보드만 채우거나 비운다(문서는 읽기만). 붙여넣기 쪽이 state",
    "reviewed": true,
    "reach": "none"
  },
  "clearExactFontInstance": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "none"
  },
  "clearMetafileFonts": {
    "sync": "none",
    "conc": "structural",
    "params": [],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "clearNativePuaFonts": {
    "sync": "none",
    "conc": "structural",
    "params": [],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "clearPrintFontPrimary": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "family"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "clearTableCellsAtCursor": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "list_id",
      "end_row",
      "end_col"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "clearTextFontFamily": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "family"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "clearTextFontOutline": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "family"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "collectCanvasMetricRequests": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "document",
      "fonts"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "convertToEditable": {
    "sync": "state",
    "conc": "structural",
    "params": [],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 300/300)",
    "reach": "plugin"
  },
  "copyControl": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "cell_path_json",
      "control_idx"
    ],
    "section": 0,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "copySelection": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "section_idx",
      "start_para_idx",
      "start_char_offset",
      "end_para_idx",
      "end_char_offset"
    ],
    "section": 0,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "copySelectionInCell": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "start_cell_para_idx",
      "start_char_offset",
      "end_cell_para_idx",
      "end_char_offset"
    ],
    "section": 0,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "copySelectionInCellByPath": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "path_json",
      "start_cell_para_idx",
      "start_char_offset",
      "end_cell_para_idx",
      "end_char_offset"
    ],
    "section": 0,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "copySelectionInCellEx": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "why": "내부 클립보드만 채우거나 비운다(문서는 읽기만). 붙여넣기 쪽이 state",
    "reviewed": true,
    "reach": "none"
  },
  "copySelectionInHeaderFooter": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "section_idx",
      "is_header",
      "apply_to",
      "start_hf_para_idx",
      "start_char_offset",
      "end_hf_para_idx",
      "end_char_offset"
    ],
    "section": 0,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "copySelectionLogical": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "section_idx",
      "start_para_idx",
      "start_logical_offset",
      "end_para_idx",
      "end_logical_offset"
    ],
    "section": 0,
    "why": "내부 클립보드만 채우거나 비운다(문서는 읽기만). 붙여넣기 쪽이 state",
    "reviewed": true,
    "reach": "none"
  },
  "copyTableCellsTransposed": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "start_row",
      "start_col",
      "end_row",
      "end_col"
    ],
    "section": 0,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "createBlankDocument": {
    "sync": "none",
    "conc": "structural",
    "params": [],
    "section": null,
    "why": "문서 교체 수명주기(studio 새 문서) — 플러그인의 예상치 못한 문서 교체 감지(재동기화)가 맡는다",
    "reviewed": true,
    "reach": "studio"
  },
  "createBullet": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "json",
      "image_data",
      "extension"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "createHeaderFooter": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "is_header",
      "apply_to"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "createMasterPage": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "section_idx",
      "options_json"
    ],
    "section": 0,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "createNumbering": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "studio"
  },
  "createShapeControl": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "studio"
  },
  "createStyle": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "studio"
  },
  "createTable": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset",
      "row_count",
      "col_count"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "createTableEx": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "studio"
  },
  "createTableInCellByPath": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "cell_path_json",
      "char_offset",
      "options_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "deleteAtCursor": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "list_id",
      "para_in_list",
      "start_pos",
      "end_pos"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "deleteBookmark": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "sec",
      "para",
      "ctrl_idx"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "deleteCellPictureControlByPath": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "cell_path_json",
      "inner_control_idx"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "deleteCellShapeControlByPath": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "cell_path_json",
      "inner_control_idx"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "deleteCellTableControlByPath": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "cell_path_json",
      "inner_control_idx"
    ],
    "section": 0,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 4개 < 5, 성공 9/300)",
    "reach": "none"
  },
  "deleteComposeControl": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "sec",
      "para",
      "ctrl_idx",
      "keep_main_text"
    ],
    "section": 0,
    "ctx": [
      "activeField"
    ],
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "deleteComposeControlByPath": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "sec",
      "parent_para",
      "path_json",
      "ctrl_idx",
      "keep_main_text"
    ],
    "section": 0,
    "ctx": [
      "activeField"
    ],
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "deleteComposeControlInFootnote": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "sec",
      "para",
      "control_idx",
      "fn_para",
      "ctrl_idx",
      "keep_main_text"
    ],
    "section": 0,
    "ctx": [
      "activeField"
    ],
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "deleteControlAt": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "list_id",
      "para_in_list",
      "control_index"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "deleteEquationControl": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "deleteFootnote": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "control_idx"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "layout": true,
    "why": "쪽별 각주 번호를 조판 결과로 다시 매긴다",
    "reviewed": true,
    "reach": "studio"
  },
  "deleteHeaderFooter": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "is_header",
      "apply_to"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "deleteMasterPage": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "section_idx",
      "apply_to"
    ],
    "section": 0,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "deleteParagraph": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "plugin"
  },
  "deletePictureControl": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "deleteRange": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "start_para_idx",
      "start_char_offset",
      "end_para_idx",
      "end_char_offset"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "deleteRangeInCell": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "start_cell_para_idx",
      "start_char_offset",
      "end_cell_para_idx",
      "end_char_offset"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "deleteRangeInCellByPath": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "parent_para_idx",
      "path_json",
      "start_para",
      "start_offset",
      "end_para",
      "end_offset"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "deleteRangeInCellEx": {
    "sync": "op",
    "conc": "text",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "deleteRangeLogical": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "start_para_idx",
      "start_logical",
      "end_para_idx",
      "end_logical"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "none"
  },
  "deleteShapeControl": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "deleteStyle": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "style_id"
    ],
    "section": null,
    "reviewed": true,
    "reach": "studio"
  },
  "deleteTableColumn": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "col_idx"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1,
        "control": 2
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "deleteTableControl": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "deleteTableRow": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "row_idx"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1,
        "control": 2
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "deleteText": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset",
      "count"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "deleteTextInCell": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx",
      "char_offset",
      "count"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "deleteTextInCellByPath": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "parent_para_idx",
      "path_json",
      "char_offset",
      "count"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "deleteTextInCellDeferredPagination": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx",
      "char_offset",
      "count"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "deleteTextInCellEx": {
    "sync": "op",
    "conc": "text",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "deleteTextInFootnote": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "control_idx",
      "fn_para_idx",
      "char_offset",
      "count"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1,
        "control": 2
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "deleteTextInHeaderFooter": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "is_header",
      "apply_to",
      "hf_para_idx",
      "char_offset",
      "count"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "detachCaptionAt": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "para_in_list",
      "control_index"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 300/300)",
    "reach": "none"
  },
  "discardBorderPaintUndo": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "id"
    ],
    "section": null,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "discardDeleteFragment": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "id"
    ],
    "section": null,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "discardPictureTransform": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "id"
    ],
    "section": null,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "discardSectionRaw": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "id"
    ],
    "section": null,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "discardSnapshot": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "id"
    ],
    "section": null,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "endBatch": {
    "sync": "none",
    "conc": "structural",
    "params": [],
    "section": null,
    "why": "배치 괄호 — 쪽 소속 확정만 endBatch 로 미룬다. 배치 밖 재생과 문서 결과가 같다고 보고 R5 runInBatch 사례로 검증한다",
    "reviewed": true,
    "reach": "plugin"
  },
  "ensureDefaultBullet": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "bullet_char_str"
    ],
    "section": null,
    "reviewed": true,
    "reach": "studio"
  },
  "ensureDefaultNumbering": {
    "sync": "state",
    "conc": "structural",
    "params": [],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 300/300)",
    "reach": "studio"
  },
  "equalizeTableCellSizes": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "start_row",
      "start_col",
      "end_row",
      "end_col",
      "axis"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "셀 크기만 고르게 한다(행·열 구조 불변)",
    "reviewed": true,
    "reach": "none"
  },
  "evaluateTableFormula": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "target_row",
      "target_col",
      "formula",
      "write_result"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "ctx": [
      "activeField"
    ],
    "why": "표 계산식 결과를 같은 표의 셀에 쓴다(본문 문단·개체 번호 불변, 시각·난수 없음)",
    "reviewed": true,
    "reach": "studio"
  },
  "evaluateTableFormulaEx": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "ctx": [
      "activeField"
    ],
    "reviewed": true,
    "reach": "none"
  },
  "findOrCreateFontId": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "name"
    ],
    "section": null,
    "reviewed": true,
    "reach": "studio"
  },
  "findOrCreateFontIdForLang": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "lang",
      "name"
    ],
    "section": null,
    "reviewed": true,
    "reach": "studio"
  },
  "flushDeferredPagination": {
    "sync": "none",
    "conc": "structural",
    "params": [],
    "section": null,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "getCellCharPropertiesAtByPath": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "path_json",
      "char_offset"
    ],
    "section": 0,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "getCharShapeRunsInCellByPath": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "sec",
      "para",
      "path_json",
      "start",
      "end"
    ],
    "section": 0,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "groupShapes": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "json"
    ],
    "section": null,
    "layout": true,
    "why": "묶음 원점을 렌더된 위치로 정한다",
    "reviewed": true,
    "reach": "studio"
  },
  "importParagraphBlock": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "source",
      "options_json"
    ],
    "section": null,
    "why": "인자가 다른 문서 객체(HwpDocument)라 이름+인자로 기록할 수 없다",
    "reviewed": true,
    "reach": "none"
  },
  "injectExternalImage": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "basename",
      "data",
      "display_path"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 300/300)",
    "reach": "plugin"
  },
  "injectExternalImageByKey": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "key",
      "data",
      "display_path"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 300/300)",
    "reach": "none"
  },
  "insertAutoNumberAtCursor": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "list_id",
      "para_in_list",
      "pos",
      "kind"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "insertCharOverlap": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "sec",
      "para",
      "char_offset",
      "json"
    ],
    "section": 0,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "insertCharOverlapByPath": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "sec",
      "parent_para",
      "path_json",
      "char_offset",
      "json"
    ],
    "section": 0,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "insertCharOverlapInFootnote": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "sec",
      "para",
      "control_idx",
      "fn_para",
      "char_offset",
      "json"
    ],
    "section": 0,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "insertClickHereField": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset",
      "guide",
      "memo",
      "name",
      "editable"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "insertClickHereFieldAtCursor": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "list_id",
      "para_in_list",
      "pos",
      "guide",
      "memo",
      "name",
      "editable"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "insertClickHereFieldByPath": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "path_json",
      "char_offset",
      "guide",
      "memo",
      "name",
      "editable"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "plugin"
  },
  "insertClickHereFieldByPathEx": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "insertClickHereFieldEx": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "insertClickHereFieldInCell": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx",
      "char_offset",
      "is_textbox",
      "guide",
      "memo",
      "name",
      "editable"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1,
        "control": 2
      }
    ],
    "reviewed": true,
    "reach": "plugin"
  },
  "insertClickHereFieldInCellEx": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "insertColumnBreak": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "insertEndnote": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "insertEquation": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset",
      "script",
      "font_size",
      "color"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "insertFieldInHf": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "is_header",
      "apply_to",
      "hf_para_idx",
      "char_offset",
      "field_type"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "insertFootnote": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "layout": true,
    "why": "쪽별 각주 번호를 조판 결과로 다시 매긴다",
    "reviewed": true,
    "reach": "studio"
  },
  "insertHyperlinkEx": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "plugin"
  },
  "insertMemo": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "start_char_idx",
      "end_char_idx",
      "json"
    ],
    "section": 0,
    "ctx": [
      "memoTime"
    ],
    "perm": "memo",
    "reviewed": true,
    "reach": "none"
  },
  "insertMemoByPath": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "path_json",
      "start_char_idx",
      "end_char_idx",
      "json"
    ],
    "section": 0,
    "ctx": [
      "memoTime"
    ],
    "perm": "memo",
    "reviewed": true,
    "reach": "none"
  },
  "insertMemoReply": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "parent_id",
      "json"
    ],
    "section": null,
    "ctx": [
      "memoTime"
    ],
    "perm": "memo",
    "reviewed": true,
    "reach": "none"
  },
  "insertNewNumber": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset",
      "start_num"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "insertPageBreak": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "insertParagraph": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "none"
  },
  "insertPicture": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset",
      "cell_path_json",
      "image_data",
      "width",
      "height",
      "natural_width_px",
      "natural_height_px",
      "extension",
      "description",
      "paper_offset_x_hu",
      "paper_offset_y_hu"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "layout": true,
    "why": "셀 안 그림 위치를 쪽 기준으로 계산한다(compute_cell_page_offset)",
    "reviewed": true,
    "reach": "studio"
  },
  "insertPictureEx": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "options_json",
      "image_data"
    ],
    "section": null,
    "layout": true,
    "why": "셀 안 그림 위치를 쪽 기준으로 계산한다(compute_cell_page_offset)",
    "reviewed": true,
    "reach": "none"
  },
  "insertPictureInCell": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset",
      "cell_path_json",
      "image_data",
      "width",
      "height",
      "natural_width_px",
      "natural_height_px",
      "extension",
      "description",
      "offset_x_hu",
      "offset_y_hu"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "layout": true,
    "why": "셀 안 그림 위치를 쪽 기준으로 계산한다(compute_cell_page_offset)",
    "reviewed": true,
    "reach": "plugin"
  },
  "insertRuby": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "sec",
      "para",
      "char_offset",
      "json"
    ],
    "section": 0,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "insertRubyByPath": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "sec",
      "parent_para",
      "path_json",
      "char_offset",
      "json"
    ],
    "section": 0,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "insertRubyInFootnote": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "sec",
      "para",
      "control_idx",
      "fn_para",
      "char_offset",
      "json"
    ],
    "section": 0,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "insertTableColumn": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "col_idx",
      "right"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1,
        "control": 2
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "insertTableRow": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "row_idx",
      "below"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1,
        "control": 2
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "insertText": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset",
      "text"
    ],
    "section": 0,
    "ctx": [
      "activeField"
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "insertTextAtCursor": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "list_id",
      "para_in_list",
      "pos",
      "text"
    ],
    "section": null,
    "ctx": [
      "activeField"
    ],
    "reviewed": true,
    "reach": "none"
  },
  "insertTextInCell": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx",
      "char_offset",
      "text"
    ],
    "section": 0,
    "ctx": [
      "activeField"
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "insertTextInCellByPath": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "parent_para_idx",
      "path_json",
      "char_offset",
      "text"
    ],
    "section": 0,
    "ctx": [
      "activeField"
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "insertTextInCellDeferredPagination": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx",
      "char_offset",
      "text"
    ],
    "section": 0,
    "ctx": [
      "activeField"
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "insertTextInCellEx": {
    "sync": "op",
    "conc": "text",
    "params": [
      "options_json"
    ],
    "section": null,
    "ctx": [
      "activeField"
    ],
    "reviewed": true,
    "reach": "none"
  },
  "insertTextInFootnote": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "control_idx",
      "fn_para_idx",
      "char_offset",
      "text"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1,
        "control": 2
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "insertTextInHeaderFooter": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "is_header",
      "apply_to",
      "hf_para_idx",
      "char_offset",
      "text"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "insertTextLogical": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "para_idx",
      "logical_offset",
      "text"
    ],
    "section": 0,
    "ctx": [
      "activeField"
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "mergeParagraph": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "para_idx"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "mergeParagraphInCell": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "mergeParagraphInCellByPath": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "parent_para_idx",
      "path_json"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "mergeParagraphInFootnote": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "control_idx",
      "fn_para_idx"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1,
        "control": 2
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "mergeParagraphInHeaderFooter": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "is_header",
      "apply_to",
      "hf_para_idx"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "mergeSection": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "section_idx"
    ],
    "section": 0,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "mergeTableCells": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "start_row",
      "start_col",
      "end_row",
      "end_col"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1,
        "control": 2
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "mergeTableCellsEx": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "mergeTableWithNext": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "moveControlAt": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "para_in_list",
      "control_index",
      "dx",
      "dy"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "moveInlineControl": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "source_json",
      "destination_json"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "moveLineEndpoint": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "sec",
      "para",
      "ci",
      "sx",
      "sy",
      "ex",
      "ey"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "선 끝점 좌표만 바꾼다",
    "reviewed": true,
    "reach": "studio"
  },
  "moveLineEndpointEx": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "moveTableOffset": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "delta_h",
      "delta_v"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "표 위치 오프셋만 바꾼다",
    "reviewed": true,
    "reach": "studio"
  },
  "pasteControl": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "ctx": [
      "clipboard"
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "pasteHtml": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset",
      "html"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "ctx": [
      "activeField"
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "pasteHtmlInCell": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx",
      "char_offset",
      "html"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1,
        "control": 2
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "pasteHtmlInCellByPath": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "path_json",
      "char_offset",
      "html"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "pasteHtmlInCellEx": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "ctx": [
      "activeField"
    ],
    "reviewed": true,
    "reach": "none"
  },
  "pasteHtmlTextLogical": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "logical_offset",
      "html"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "ctx": [
      "activeField"
    ],
    "reviewed": true,
    "reach": "none"
  },
  "pasteHwpJson": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset",
      "json"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "pasteInternal": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "ctx": [
      "clipboard"
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "pasteInternalInCell": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx",
      "char_offset"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1,
        "control": 2
      }
    ],
    "ctx": [
      "clipboard"
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "pasteInternalInCellByPath": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "path_json",
      "char_offset"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "ctx": [
      "clipboard"
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "pasteInternalTextLogical": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "logical_offset"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "ctx": [
      "clipboard"
    ],
    "reviewed": true,
    "reach": "none"
  },
  "pasteTableCellsTransposed": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "start_row",
      "start_col"
    ],
    "section": 0,
    "why": "전치 클립보드(table_transpose_clipboard)를 붙여 넣는다 — 전치 클립보드(TableTransposeData)는 직렬화 경로가 없어 R13 에서도 결과로 보낸다",
    "reviewed": true,
    "reach": "studio"
  },
  "pasteTableCellsTransposedAsTable": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset"
    ],
    "section": 0,
    "why": "전치 클립보드(table_transpose_clipboard)를 새 표로 붙여 넣는다 — 전치 클립보드(TableTransposeData)는 직렬화 경로가 없어 R13 에서도 결과로 보낸다",
    "reviewed": true,
    "reach": "studio"
  },
  "prepareNativeOtfFontFaces": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "provider"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "prepareNativeOtfFonts": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "provider"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "promoteOleEquation": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "control_idx"
    ],
    "section": 0,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "studio"
  },
  "rebuildDerivedState": {
    "sync": "none",
    "conc": "structural",
    "params": [],
    "section": null,
    "why": "렌더·조판 설정 또는 파생 상태 재구성(문서 IR 비변경)",
    "reviewed": true,
    "reach": "studio"
  },
  "recalculateTableFormulas": {
    "sync": "state",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "edited_cell",
      "paginate"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "ctx": [
      "activeField"
    ],
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 230/300)",
    "reviewed": true,
    "reach": "none"
  },
  "reflowLinesegs": {
    "sync": "state",
    "conc": "neutral",
    "params": [],
    "section": null,
    "roles": [],
    "layout": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 300/300)",
    "reviewed": true,
    "reach": "plugin"
  },
  "registerCanvasMetricReplies": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "document",
      "fonts",
      "revision",
      "json"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "registerExactFontSource": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "char_shape_id",
      "language_index",
      "font_bytes",
      "face_index"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "none"
  },
  "registerHftOutlineFont": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "family",
      "bytes",
      "face_index"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "registerHftOutlineFontCandidates": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "family",
      "programs"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "registerHftOutlineFontFaces": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "family",
      "programs"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "registerLiteralFigureSpaceFont": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "family",
      "bold",
      "italic",
      "bytes",
      "face_index"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "registerLiteralFigureSpaceFontForSource": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "family",
      "bold",
      "italic",
      "source_ttf",
      "bytes",
      "face_index"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "registerMetafileFont": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "family",
      "bytes",
      "face_index"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "registerNativePuaFont": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "family",
      "bold",
      "italic",
      "bytes",
      "face_index"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "registerNativePuaFontForSource": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "family",
      "bold",
      "italic",
      "source_ttf",
      "bytes",
      "face_index"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "registerPrintFontPrimary": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "family",
      "bytes",
      "index",
      "complete"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "registerTextFontGlyphCoverage": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "family",
      "bytes",
      "face_index"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "relocateFloatingPicture": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "src_section",
      "src_para",
      "src_cell_path_json",
      "src_control",
      "dst_section",
      "dst_para",
      "dst_char_offset",
      "dst_cell_path_json",
      "horz_offset",
      "vert_offset"
    ],
    "section": null,
    "reviewed": true,
    "reach": "studio"
  },
  "removeBorderFillTails": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "json"
    ],
    "section": null,
    "why": "되돌리기 전용(셀 테두리·배경 명령의 undo 가 문서 전체 테두리·배경 목록의 꼬리를 개수로 지운다) — 결과 전송으로 둔다. 공동편집 되돌리기(4단계)는 이 명령을 뒤에 남의 편집이 하나라도 있으면 막는다(3.2-3, 남이 더한 테두리를 지울 수 있으므로)",
    "reviewed": true,
    "reach": "studio"
  },
  "removeFieldAt": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "removeFieldAtInCell": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx",
      "char_offset",
      "is_textbox"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "plugin"
  },
  "removeFieldAtInCellEx": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 4개 < 5, 성공 300/300)",
    "reach": "none"
  },
  "removeHyperlinkEx": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "plugin"
  },
  "removeMemo": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "id"
    ],
    "section": null,
    "perm": "memo",
    "reviewed": true,
    "reach": "none"
  },
  "removeTableCellFormulas": {
    "sync": "state",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "ctx": [
      "activeField"
    ],
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 230/300)",
    "reviewed": true,
    "reach": "none"
  },
  "renameBookmark": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "sec",
      "para",
      "ctrl_idx",
      "new_name"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "책갈피 이름만 바꾼다",
    "reviewed": true,
    "reach": "studio"
  },
  "renameField": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "oldname",
      "newname"
    ],
    "section": null,
    "roles": [],
    "why": "필드 이름만 바꾼다(문서 전체, 위치 인자 없음)",
    "reviewed": true,
    "reach": "none"
  },
  "replaceAll": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "query",
      "new_text",
      "case_sensitive"
    ],
    "section": null,
    "reviewed": true,
    "reach": "studio"
  },
  "replaceBodyTextLocal": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset",
      "delete_count",
      "text"
    ],
    "section": 0,
    "ctx": [
      "activeField"
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "replaceHyperlinkTextEx": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "plugin"
  },
  "replaceOne": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "query",
      "new_text",
      "case_sensitive"
    ],
    "section": null,
    "reviewed": true,
    "reach": "plugin"
  },
  "replaceRangeInHeaderFooter": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "is_header",
      "apply_to",
      "start_hf_para_idx",
      "start_char_offset",
      "end_hf_para_idx",
      "end_char_offset",
      "replacement_text"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "replaceText": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "sec",
      "para",
      "char_offset",
      "length",
      "new_text"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "replaceTextInCellDeferredPagination": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx",
      "char_offset",
      "delete_count",
      "text"
    ],
    "section": 0,
    "ctx": [
      "activeField"
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "resizeControlAt": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "para_in_list",
      "control_index",
      "d_width",
      "d_height"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "resizeTableCells": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "셀 크기만 바꾼다(행·열 구조 불변)",
    "reviewed": true,
    "reach": "studio"
  },
  "resizeTableCellsByPath": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "cell_path_json",
      "json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "중첩 표 셀 크기만 바꾼다",
    "reviewed": true,
    "reach": "studio"
  },
  "restoreDeleteFragment": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "id"
    ],
    "section": null,
    "why": "로컬 삭제 조각 저장소 id 로 복원한다",
    "reviewed": true,
    "reach": "studio"
  },
  "restoreSectionRaw": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "id"
    ],
    "section": null,
    "why": "로컬 구역 raw 저장소 id 로 복원한다",
    "reviewed": true,
    "reach": "studio"
  },
  "restoreSnapshot": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "id"
    ],
    "section": null,
    "why": "로컬 스냅샷 저장소 id 로 문서를 복원한다",
    "reviewed": true,
    "reach": "studio"
  },
  "saveSnapshot": {
    "sync": "none",
    "conc": "structural",
    "params": [],
    "section": null,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "selectCanvasMetrics": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "enabled"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "studio"
  },
  "setActiveField": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset"
    ],
    "section": 0,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "setActiveFieldByPath": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "path_json",
      "char_offset"
    ],
    "section": 0,
    "why": "편집 세션 상태(active_field). 영향받는 기능은 ctx.activeField 로 기록한다",
    "reviewed": true,
    "reach": "plugin"
  },
  "setActiveFieldInCell": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx",
      "char_offset",
      "is_textbox"
    ],
    "section": 0,
    "why": "편집 세션 상태(active_field). 영향받는 기능은 ctx.activeField 로 기록한다",
    "reviewed": true,
    "reach": "plugin"
  },
  "setActiveFieldInCellEx": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "why": "편집 세션 상태(active_field). 영향받는 기능은 ctx.activeField 로 기록한다",
    "reviewed": true,
    "reach": "none"
  },
  "setAnnotateMetricFont": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "enabled"
    ],
    "section": null,
    "why": "렌더·조판 설정 또는 파생 상태 재구성(문서 IR 비변경)",
    "reviewed": true,
    "reach": "none"
  },
  "setCaretPosition": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset"
    ],
    "section": 0,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "setCellParaShapeId": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "sec_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx",
      "para_shape_id"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "셀 안 글자·문단 모양만 바꾼다(본문 문단·개체 번호 불변)",
    "reviewed": true,
    "reach": "studio"
  },
  "setCellParaShapeIdByPath": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "path_json",
      "para_shape_id"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "셀 안 글자·문단 모양만 바꾼다(본문 문단·개체 번호 불변)",
    "reviewed": true,
    "reach": "studio"
  },
  "setCellPicturePropertiesByPath": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "cell_path_json",
      "inner_control_idx",
      "props_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "셀 안 그림 속성만 바꾼다",
    "reviewed": true,
    "reach": "studio"
  },
  "setCellProperties": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "셀 속성만 바꾼다",
    "reviewed": true,
    "reach": "studio"
  },
  "setCellShapePropertiesByPath": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "cell_path_json",
      "inner_control_idx",
      "props_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "셀 안 도형 속성만 바꾼다",
    "reviewed": true,
    "reach": "studio"
  },
  "setCellZoneProperties": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "start_row",
      "start_col",
      "end_row",
      "end_col",
      "json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "셀 범위 속성만 바꾼다",
    "reviewed": true,
    "reach": "studio"
  },
  "setCharShapeId": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "sec_idx",
      "para_idx",
      "start_offset",
      "end_offset",
      "char_shape_id"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "range",
        "para": 1,
        "start": 2,
        "end": 3
      }
    ],
    "why": "범위의 글자 모양 id 만 바꾼다",
    "reviewed": true,
    "reach": "plugin"
  },
  "setCharShapeIdInCell": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "sec_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx",
      "start_offset",
      "end_offset",
      "char_shape_id"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "셀 안 글자·문단 모양만 바꾼다(본문 문단·개체 번호 불변)",
    "reviewed": true,
    "reach": "plugin"
  },
  "setCharShapeIdInCellByPath": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "path_json",
      "start_offset",
      "end_offset",
      "char_shape_id"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "셀 안 글자·문단 모양만 바꾼다(본문 문단·개체 번호 불변)",
    "reviewed": true,
    "reach": "plugin"
  },
  "setCharShapeIdInCellEx": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "setCharShapeRuns": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "sec",
      "para",
      "start",
      "end",
      "runs_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "구간 JSON 안에 그 문단의 글자 오프셋이 있어 글자 단위로는 옮길 수 없다 — 문단 발자국(anchor)으로 그 문단을 고치는 편집과만 충돌하고 다른 문단 편집에는 문단 번호만 옮긴다(4단계: 글자 서식 되돌리기가 쓰는 연산)",
    "reviewed": true,
    "reach": "studio"
  },
  "setCharShapeRunsInCellByPath": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "sec",
      "para",
      "path_json",
      "start",
      "end",
      "runs_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "셀 안 글자 모양 구간만 바꾼다(JSON 의 오프셋은 셀 안 좌표라 본문 연산과 무관)",
    "reviewed": true,
    "reach": "studio"
  },
  "setChartData": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "edits_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "차트 데이터(바이너리 슬롯)만 바꾼다",
    "reviewed": true,
    "reach": "plugin"
  },
  "setChartDataByIndex": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "index",
      "edits_json"
    ],
    "section": null,
    "why": "문서 전체 차트 순번으로 찾는다(위치로 옮길 수 없음)",
    "reviewed": true,
    "reach": "studio"
  },
  "setClipEnabled": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "enabled"
    ],
    "section": null,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "setColumnDef": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "column_count",
      "column_type",
      "same_width",
      "spacing_hu"
    ],
    "section": 0,
    "why": "단 정의 개체가 없으면 첫 문단에 새로 넣는다(개체 번호가 바뀔 수 있음)",
    "reviewed": true,
    "reach": "studio"
  },
  "setComposeControl": {
    "sync": "state",
    "conc": "neutral",
    "params": [
      "sec",
      "para",
      "ctrl_idx",
      "json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reviewed": true,
    "reach": "none"
  },
  "setComposeControlByPath": {
    "sync": "state",
    "conc": "neutral",
    "params": [
      "sec",
      "parent_para",
      "path_json",
      "ctrl_idx",
      "json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reviewed": true,
    "reach": "none"
  },
  "setComposeControlInFootnote": {
    "sync": "state",
    "conc": "neutral",
    "params": [
      "sec",
      "para",
      "control_idx",
      "fn_para",
      "ctrl_idx",
      "json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reviewed": true,
    "reach": "none"
  },
  "setControlFlipAt": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "para_in_list",
      "control_index",
      "vertical",
      "org_state"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "setControlLock": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "para_in_list",
      "control_index",
      "locked"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "setControlZOrderAt": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "para_in_list",
      "control_index",
      "mode"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 300/300)",
    "reach": "none"
  },
  "setDimMasterPages": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "enabled"
    ],
    "section": null,
    "why": "렌더·조판 설정 또는 파생 상태 재구성(문서 IR 비변경)",
    "reviewed": true,
    "reach": "none"
  },
  "setDpi": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "dpi"
    ],
    "section": null,
    "why": "렌더·조판 설정 또는 파생 상태 재구성(문서 IR 비변경)",
    "reviewed": true,
    "reach": "none"
  },
  "setEquationProperties": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx",
      "props_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "수식 속성만 바꾼다",
    "reviewed": true,
    "reach": "studio"
  },
  "setExactFontInstance": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "none"
  },
  "setFallbackFont": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "path"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "none"
  },
  "setFieldValue": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "field_id",
      "value"
    ],
    "section": null,
    "perm": "form",
    "reviewed": true,
    "reach": "plugin"
  },
  "setFieldValueByName": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "name",
      "value"
    ],
    "section": null,
    "perm": "form",
    "reviewed": true,
    "reach": "plugin"
  },
  "setFileName": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "name"
    ],
    "section": null,
    "why": "파일 이름(DocumentCore.file_name — 문서 IR 아님)",
    "reviewed": true,
    "reach": "plugin"
  },
  "setFontEnvironment": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "json"
    ],
    "section": null,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "plugin"
  },
  "setFormValue": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "sec",
      "para",
      "ci",
      "value_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "perm": "form",
    "why": "양식 개체 값만 바꾼다",
    "reviewed": true,
    "reach": "studio"
  },
  "setFormValueInCell": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "sec",
      "table_para",
      "table_ci",
      "cell_idx",
      "cell_para",
      "form_ci",
      "value_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "perm": "form",
    "why": "셀 안 양식 개체 값만 바꾼다",
    "reviewed": true,
    "reach": "studio"
  },
  "setFormValueInCellEx": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "perm": "form",
    "reviewed": true,
    "reach": "none"
  },
  "setHangul2024Compat": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "enabled"
    ],
    "section": null,
    "why": "렌더·조판 설정 또는 파생 상태 재구성(문서 IR 비변경)",
    "reviewed": true,
    "reach": "none"
  },
  "setHeaderFooterPictureProperties": {
    "sync": "state",
    "conc": "neutral",
    "params": [
      "section_idx",
      "outer_para_idx",
      "outer_control_idx",
      "inner_para_idx",
      "inner_control_idx",
      "props_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reviewed": true,
    "reach": "studio"
  },
  "setMemoShape": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "json"
    ],
    "section": 0,
    "roles": [],
    "why": "구역의 메모 모양만 바꾼다",
    "reviewed": true,
    "reach": "none"
  },
  "setMemoText": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "id",
      "text"
    ],
    "section": null,
    "roles": [],
    "perm": "memo",
    "why": "메모 본문만 바꾼다(본문 문단 텍스트가 아님)",
    "reviewed": true,
    "reach": "none"
  },
  "setNoteEquationProperties": {
    "sync": "state",
    "conc": "neutral",
    "params": [
      "kind",
      "section_idx",
      "parent_para_idx",
      "note_control_idx",
      "note_para_idx",
      "inner_control_idx",
      "props_json"
    ],
    "section": 1,
    "roles": [
      {
        "kind": "anchor",
        "arg": 2
      }
    ],
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reviewed": true,
    "reach": "studio"
  },
  "setNoteEquationPropertiesEx": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "setNumberingCharShape": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "numbering_id",
      "level",
      "json"
    ],
    "section": null,
    "roles": [],
    "why": "번호 정의의 글자 모양만 바꾼다",
    "reviewed": true,
    "reach": "none"
  },
  "setNumberingRestart": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "para_idx",
      "mode",
      "start_num"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "para",
        "arg": 1
      }
    ],
    "why": "문단의 numbering_restart 속성만 바꾼다",
    "reviewed": true,
    "reach": "plugin"
  },
  "setObservedFontFallbacks": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "json"
    ],
    "section": null,
    "why": "글꼴·글자 측정 환경 등록(문서 IR 비변경, 각자의 환경)",
    "reviewed": true,
    "reach": "none"
  },
  "setPageBorderFill": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "json"
    ],
    "section": 0,
    "roles": [],
    "why": "구역의 쪽 테두리·배경만 바꾼다",
    "reviewed": true,
    "reach": "studio"
  },
  "setPageDef": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "json"
    ],
    "section": 0,
    "roles": [],
    "why": "구역 용지 설정만 바꾼다(문단·텍스트·개체 번호 불변)",
    "reviewed": true,
    "reach": "studio"
  },
  "setPageHide": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "sec",
      "para",
      "hide_header",
      "hide_footer",
      "hide_master",
      "hide_border",
      "hide_fill",
      "hide_page_num"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "setPageHideEx": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "setPageNumberPosition": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "position",
      "format",
      "dash"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "none"
  },
  "setParaShapeId": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "sec_idx",
      "para_idx",
      "para_shape_id"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "para",
        "arg": 1
      }
    ],
    "why": "문단 모양 id 만 바꾼다",
    "reviewed": true,
    "reach": "studio"
  },
  "setPictureProperties": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "props_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1,
        "control": 2
      }
    ],
    "why": "그림 띠 편집으로 구역을 통째로 다시 짤 수 있다(commit_picture_band_edit)",
    "reviewed": true,
    "reach": "studio"
  },
  "setSectionDef": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "json"
    ],
    "section": 0,
    "roles": [],
    "why": "구역 정의 속성만 바꾼다",
    "reviewed": true,
    "reach": "studio"
  },
  "setSectionDefAll": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "json"
    ],
    "section": null,
    "roles": [],
    "why": "모든 구역의 구역 정의 속성만 바꾼다",
    "reviewed": true,
    "reach": "studio"
  },
  "setShapeProperties": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "props_json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1,
        "control": 2
      }
    ],
    "why": "그림 띠 편집으로 구역을 통째로 다시 짤 수 있다(commit_picture_band_edit)",
    "reviewed": true,
    "reach": "studio"
  },
  "setShowControlCodes": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "enabled"
    ],
    "section": null,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "setShowParagraphMarks": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "enabled"
    ],
    "section": null,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "setShowTransparentBorders": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "enabled"
    ],
    "section": null,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "setTableCellFormula": {
    "sync": "state",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "formula",
      "result_format"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "ctx": [
      "activeField"
    ],
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reviewed": true,
    "reach": "none"
  },
  "setTableProperties": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "json"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "why": "표 속성만 바꾼다(행·열 구조 불변)",
    "reviewed": true,
    "reach": "studio"
  },
  "setTextBoxAt": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "para_in_list",
      "control_index",
      "attach"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 3개 < 5, 성공 300/300)",
    "reach": "none"
  },
  "splitParaAtCursor": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "list_id",
      "para_in_list",
      "pos"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "splitParagraph": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset",
      "removed_para_meta"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "splitParagraphInCell": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "cell_idx",
      "cell_para_idx",
      "char_offset",
      "removed_para_meta"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "splitParagraphInCellByPath": {
    "sync": "op",
    "conc": "text",
    "params": [
      "section_idx",
      "parent_para_idx",
      "path_json",
      "char_offset",
      "removed_para_meta"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "splitParagraphInFootnote": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "control_idx",
      "fn_para_idx",
      "char_offset",
      "removed_para_meta"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1,
        "control": 2
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "splitParagraphInHeaderFooter": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "is_header",
      "apply_to",
      "hf_para_idx",
      "char_offset",
      "removed_para_meta"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "splitSection": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "char_offset"
    ],
    "section": 0,
    "layout": true,
    "why": "구역 나눔에서 조판 결과를 읽는다",
    "reviewed": true,
    "reach": "studio"
  },
  "splitTable": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "at_row"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "splitTableCell": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "row",
      "col"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "splitTableCellInto": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "row",
      "col",
      "n_rows",
      "m_cols",
      "equal_row_height",
      "merge_first"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1,
        "control": 2
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "splitTableCellIntoEx": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "splitTableCellsInRange": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx",
      "start_row",
      "start_col",
      "end_row",
      "end_col",
      "n_rows",
      "m_cols",
      "equal_row_height"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1,
        "control": 2
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "splitTableCellsInRangeEx": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "none"
  },
  "stepDeferredPagination": {
    "sync": "none",
    "conc": "structural",
    "params": [
      "fragment_budget"
    ],
    "section": null,
    "why": "studio 레지스트리의 문서 비변경 목록(EXCLUDED_NON_DOCUMENT)",
    "reviewed": true,
    "reach": "studio"
  },
  "swapPictureTransform": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "id"
    ],
    "section": null,
    "why": "로컬 그림 변환 저장소 id 와 교환한다(그림 크기 조절 실행·취소)",
    "reviewed": true,
    "reach": "studio"
  },
  "tableEditAtCursor": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "list_id",
      "op"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "tableMergeAtCursor": {
    "sync": "state",
    "conc": "structural",
    "params": [
      "list_id",
      "end_row",
      "end_col"
    ],
    "section": null,
    "reviewed": true,
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 0/300)",
    "reach": "none"
  },
  "toggleHideHeaderFooter": {
    "sync": "local",
    "conc": "structural",
    "params": [
      "page_index",
      "is_header"
    ],
    "section": null,
    "why": "문서 IR 이 아닌 보기 상태(hidden_header_footer) — 공유하지 않는다. 숨김은 머리말·꼬리말 영역 안 내용을 그리지 않을 뿐 영역·쪽 나눔·본문 영역은 바꾸지 않는다(renderer/layout.rs, pagination 미참조)",
    "reviewed": true,
    "reach": "studio"
  },
  "transposeTableCellsInPlace": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "parent_para_idx",
      "control_idx"
    ],
    "section": 0,
    "roles": [
      {
        "kind": "anchor",
        "arg": 1,
        "control": 2
      }
    ],
    "reviewed": true,
    "reach": "studio"
  },
  "ungroupShape": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "section_idx",
      "para_idx",
      "control_idx"
    ],
    "section": 0,
    "reviewed": true,
    "reach": "studio"
  },
  "updateClickHereProps": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "field_id",
      "guide",
      "memo",
      "name",
      "editable"
    ],
    "section": null,
    "roles": [],
    "why": "누름틀 속성(안내문·메모·이름·편집 가능)만 바꾼다(안내문은 문단 텍스트가 아님)",
    "reviewed": true,
    "reach": "studio"
  },
  "updateConnectorsInSection": {
    "sync": "state",
    "conc": "neutral",
    "params": [
      "section_idx"
    ],
    "section": 0,
    "roles": [],
    "why": "동작 동일성 검사: 사례 부족 (문서를 바꾼 성공 호출 0개 < 5, 성공 300/300)",
    "reviewed": true,
    "reach": "studio"
  },
  "updateHyperlinkEx": {
    "sync": "op",
    "conc": "structural",
    "params": [
      "options_json"
    ],
    "section": null,
    "reviewed": true,
    "reach": "plugin"
  },
  "updateStyle": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "style_id",
      "json"
    ],
    "section": null,
    "roles": [],
    "why": "스타일 정의만 바꾼다(스타일 id 불변)",
    "reviewed": true,
    "reach": "studio"
  },
  "updateStyleShapes": {
    "sync": "op",
    "conc": "neutral",
    "params": [
      "style_id",
      "char_mods_json",
      "para_mods_json"
    ],
    "section": null,
    "roles": [],
    "why": "스타일의 글자·문단 모양 정의만 바꾼다(스타일 id 불변)",
    "reviewed": true,
    "reach": "studio"
  }
};
