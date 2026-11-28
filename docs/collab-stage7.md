# 공동편집 7단계: 결과 전송 충돌 줄이기, 배치 점검, 암호 다시 걸기

6단계(`docs/collab-stage6.md`) 다음으로 남은 후보를 필요한 순서대로 한다(사용자 결정, 2026-11-28, Linux 시험은 제외).

1. **A 결과 전송에 자동 범위 표시** — 사용감에 가장 크게 닿는다. rhwp 가 아직 op 로 못 보내는 기능(state 53종)을 쓸 때마다
   다른 참여자의 왕복 중 입력이 취소되는 문제를 줄인다.
2. **B 방을 열 때 배치 점검** — 6단계 S2 왕복 점검에 "다시 쓰면 화면 배치가 달라지는가"를 더한다.
3. **C 내려받을 때 암호 다시 걸기** — 5단계 D5 의 다음 후보.

B·C 는 A 와 겹치지 않아 동시에 한다. A 는 4단계 U3-b 를 마친 뒤 시작한다.

## A 결과 전송에 자동 범위 표시

U3(4단계 §6)의 범위 표시 장치(`range: {section, lo, before, after}`, 받는 쪽 보정, 서버 확인, 미확정 다시 만들기)를 되돌리기
밖의 일반 state 에도 쓴다.

- **보내는 쪽:** state 가 될 호출 직전의 문서와 직후의 문서를 견준다. 다음이 모두 맞을 때만 범위 표시를 단다.
  - 바뀐 구역이 하나이고, 그 구역에서 바뀐 부분이 연속 문단 범위다(앞뒤 공통 문단을 깎아 구함, vpos 는 빼고 비교 — 서버의
    `para_same` 을 다시 쓴다).
  - **DocInfo 가 바뀌지 않았다.** 덧붙인 항목이 있으면 다시 만들 때 남이 그사이 덧붙인 항목과 번호가 겹칠 수 있으므로 이번에는
    표시를 달지 않는다(보통 state 로 보낸다). 덧붙인 항목을 다시 번호 매기는 일은 다음 후보다.
  - 그 밖의 문서 부분(구역 정의, 바탕쪽, 머리말 등 범위 밖)이 그대로다.
- **미확정 다시 만들기:** 보정에서 범위가 남과 겹치지 않으면 "after 문단을 옮긴 lo 에 다시 끼우기"로 다시 만든다(재료는 after
  문단). 겹치면 지금처럼 충돌이다.
- **받는 쪽·서버:** U3 와 같다(구조 발자국처럼 보정, `check_range_hint` 로 확인, 거짓이면 invalid range).
- **측정:** R1b 사례 문서로 state 53종을 한 번씩 돌려, 몇 종이 범위 표시를 얻는지(구역·DocInfo 조건별) 표로 남긴다.
- **시험:** R5 에 state 기능 섞기 + 범위 표시, 브라우저에서 B 가 계속 치는 중 A 가 state 기능(예: 덧말 넣기)을 써도 B 의 입력이
  취소되지 않음, 조건이 안 맞는 state 는 지금처럼 보통 state.

## B 방을 열 때 배치 점검

- 6단계 S2 의 왕복 점검은 모델·레코드·첨부만 본다. rhwp 가 모델에서 다시 쓴 뒤 **조판 결과**(쪽 수, 문단·개체 위치)가 달라지는지도
  본다. rhwp 의 `render-diff`(라운드트립 시각 정합성 게이트) 핵심을 쓴다.
- 결과는 왕복 점검의 `lost` 에 `kind: 'layout'` 으로 더한다: `{pages: [원본, 다시 쓴 것], maxDisp(px), worstPage}`.
  쪽 수가 다르거나 변위가 정한 값(예: 1px)을 넘으면 경고다.
- 무겁다. 점검 워커의 시간 상한(`COLLAB_ROUNDTRIP_TIMEOUT_MS`) 안에서 돌고, 설정 `COLLAB_ROUNDTRIP_LAYOUT=on|off` 로 켜고 끈다.
  기본값은 샘플 측정(걸린 시간, 경고 수) 뒤 정한다.
- 정본 엔진(글꼴 정책 bundled-only, 3단계 S3-1)과 같은 조판 환경에서 잰다.

## C 내려받을 때 암호 다시 걸기

- `GET /rooms/{room}/document` 가 요청 머리 `X-Collab-Document-Password` 를 받으면 정본을 암호를 걸어 내보낸다
  (`exportHwpWithPassword`·`exportHwpxWithPassword`, 원본 형식 계열). 암호는 저장하지도 기록하지도 않는다.
- 원래 암호 문서였던 방(`encryptedSource`)은 설정 `COLLAB_ENCRYPTED_DOWNLOAD=require|optional`(기본 `require`)을 따른다.
  `require` 면 암호 없이 내려받기를 거절한다(403 `password-required`). 작성자가 건 보호를 내려받을 때라도 되살리게 한다.
- 업로드 페이지의 내려받기는 그런 방이면 암호 칸을 보인다.
- 한계: 공동편집 중 각자 브라우저에서 studio 로 "저장"하는 파일은 이 경로를 거치지 않는다(암호 없음). studio 의 저장 경로에
  "저장할 때 암호 묻기"를 거는 일(0002)은 다음 후보로 둔다.

## 분담

| 일 | 세션 |
|---|---|
| A | cc-rhwp-f6 (U3-b 뒤, 범위 표시 장치를 만든 세션) |
| B | cc-rhwp-3b (collab-core 왕복 점검 보조를 만든 세션) |
| C | cc-rhwp-68 (서버·업로드 페이지, 6단계 마무리 회귀 뒤) |

## 기록

| 날짜 | 항목 | 결과 |
|---|---|---|
| 2026-11-28 | **B 방을 열 때 배치 점검**(기존 코드 세션) | **보조 `doc.collabLayoutCheck()` → JSON 문자열 `null`(통과) 또는 `{kind:"layout", count, detail, pages:[원본, 다시 쓴 것], maxDisp, worstPage}`**(collab-core `layout_check`, 이 문서는 바꾸지 않음). 왕복 점검(S2)과 같은 두 문서 — 저장본을 읽어 원본 바이트 캐시를 버린 것과, 그것을 모델에서만 써서 다시 읽은 것 — 의 조판을 업스트림 render-diff 핵심 `diagnostics::render_geom_diff::diff_render_geometry`(쪽마다 렌더 트리 노드를 타입 LCS 로 맞춰 bbox 변위, 파일 시스템 안 씀, 이미 pub — **0001 변경 없음**)로 견준다. 판정은 업스트림 게이트와 같다: 쪽 수 다름 / TextRun ±1 이 아닌 구조 어긋남 / 최대 변위 1px 초과 → 경고. `count` = 문제 쪽 수(쪽 수만 다르면 1), `maxDisp` px 소수 둘째 자리, `worstPage` 1부터, `detail` 에 가장 많이 움직인 노드 경로. S2 가 읽은 두 문서를 들고 있다가 이어 부르는 배치 점검이 다시 읽지 않고 쓴다(저장본이 그 사이 바뀌었으면 다시 만든다; 렌더러는 원본 바이트 캐시를 읽지 않아 캐시를 버린 문서와 새로 읽은 문서의 판정이 같다 — 샘플 7개 확인). **서버**: `COLLAB_ROUNDTRIP_LAYOUT=on|off`(기본 off, 측정 뒤 정함) — 왕복 점검 다음에 같은 점검 워커·같은 시간 상한(남은 시간)으로 워커 op `roundtripLayout` 을 부르고 경고를 `lost` 에 더한다(`summarizeRoundtrip` 이 layout 의 pages·maxDisp·worstPage 를 남긴다). 배치 점검만 시간을 넘거나 실패하면 왕복 점검 결과는 그대로 두고 `layoutUnknown: 'timeout'\|'error'`. `roundtrip.ts` 이름표 `layout: '조판(쪽·위치)'`(단위 쪽), 배치만 못 했을 때 "(조판 점검 못 함: …)". 규약 §5 에 한 단락. **측정**(업스트림 샘플 16MB 미만 441개, Node + pkg = 정본 조판 환경, 읽기만): 열림 438(암호 3), **배치 경고 10**(모두 변위, 쪽 수·구조 차이 없음, 모두 S2 는 통과 — S2 가 못 보는 것): 모두 표 칸 글줄 높이가 줄어듦 — mel-001·multi-table-001/002 4.41px, tac-img-02 9.28px(9쪽), synam-001 13.79px(11쪽), hwp3-sample16 다섯 판 1.33px. **원인(아래 "B 측정 원인 정정"에서 다시 잼)**: 본문 구역을 모델에서 다시 쓰면 업스트림 저장기가 rhwp 전용 스트림 `/RhwpLineSegTags`(업스트림 #8939)에 그 구역을 "rhwp 가 만든 줄 캐시"로 표지하고, 그것을 다시 읽으면 표 칸 줄을 지금 메트릭으로 다시 잰다(`owns_section_line_cache` → `owned_cell_with_current_metrics`) — 한/글이 저장한 줄 높이 대신 rhwp 가 잰 값. 다시 쓴 저장본에서 이 스트림만 지우면 10개 모두 0px. **반올림 같은 측정 잡음은 없었다**. *(정정: 처음에는 원인을 ① 글자 모양 `attr` 의 밑줄 종류·취소선 비트(0x3C0400F8 → 0x3C0000F0, 0x40008 → 0x80000) ② 글꼴 기본 이름(`default_name` None → "GulimChe"/"Batang")으로 적었으나 **틀렸다** — 둘 다 원본 레코드 없이 다시 쓰면 바이트는 바뀌지만 그것만으로는 조판 0px.)* **시간**(배치 점검만): 중앙 9ms, p90 0.65s, p99 2.2s(S2 두 문서를 다시 쓰기 전에는 16ms·1.43s·5.4s); 열기+S2+배치 p99 9.9s, 15s 를 넘는 것은 S2 만으로도 넘는 1개(issue2063_huge_cellbreak_table). **시험** Rust collab **114/114**(+5: 모델에서 다 쓰는 문서는 HWP·HWPX 통과 / S2 두 문서 재사용·바뀐 문서는 다시 만듦 / 판정이 업스트림 게이트와 같음 / multi-table-001 은 S2 통과·배치 경고), 새 서버 시험 `server/test/roundtrip-layout.test.mjs` 5(경고 합치기·필드 유지 / S2 경고 + 배치 통과 / 배치만 시간 초과·실패면 layoutUnknown / off 는 부르지 않음·모르는 값 거부 / 진짜 보조로 통과), 서버 **93 + 2 건너뜀**, collab-client **95/95**, 지문 `981ce66b4183-501584aa365e-b99baa2da1a4-d0e76ac479bb`, 패치 둘 다 그대로 |
| 2026-11-28 | **C 내려받을 때 암호 다시 걸기** (배포 세션) | `GET /rooms/{room}/document` 가 `X-Collab-Document-Password` 를 받으면 정본을 원본 형식 계열로 암호를 걸어 내보낸다(정본 워커 `exportEncrypted` — 열 때 본 바이트로 형식 계열을 기억, HWPX 는 `exportHwpxWithPassword`, HWP·HWP3 는 `exportHwpWithPassword`). 응답 머리 `X-Collab-Encrypted: 1`, 빈 값은 없는 것으로, 256자 넘으면 400 bad-password. 원래 암호 문서였던 방은 `COLLAB_ENCRYPTED_DOWNLOAD=require`(기본)면 암호 없이 403 password-required, `optional` 이면 암호 없이도. `POST /rooms` 응답에 `encryptedSource: true`. 암호는 저장·기록하지 않는다(로그에는 "암호를 걸어"만). 업로드 페이지: 그런 방이면 내려받기에 암호 칸, 403 이면 칸을 보이고 안내, 머리에 실을 수 없는 문자(한글 등)는 보내기 전에 알림(방 만들기 암호 칸도 같음). 시험 `encrypted-download.test.mjs` 4: 원래 암호 HWPX 방 — 암호 없이 403, 새 암호로 HWPX(zip) 내려받기 → 암호 없이·틀린 암호·원래 암호로는 안 열리고 새 암호로 열면 digest = 정본을 내보내 다시 연 것(정본 메모리 digest 와도 같음), 로그·저장소 파일 어디에도 두 암호 없음, 다시 시작해도 403 / optional / 암호 문서가 아니던 HWP 방(걸면 HWP 암호 파일, 안 걸면 그대로) / 400·빈 값·설정 검사. 기존 D5 시험(encrypted.test)의 "내려받은 파일 암호 없음" 기대를 새 기본으로 바꿈(암호 없이 403, 걸면 그 암호로 열림 — HWPX·HWP5 2024·HWP3 세 샘플). 업로드 페이지 브라우저 확인 5/5(저장소 밖 스크립트: 칸 보임·빈 암호 막음·한글 암호 알림·"암호를 걸어 내려받았습니다"·내려받은 .hwpx 는 그 암호로만 열림). 서버 92 + 건너뜀 2, collab-client 95, s5-deploy 16/16. 알게 된 것: 문서 암호를 요청 머리로 보내므로 그대로는 인쇄 가능한 ASCII 만 된다(5단계 D5 의 방 만들기 암호도 같음) — 아래 행에서 한글 암호를 넣었다 |
| 2026-11-28 | **C 덧붙임: 한글 문서 암호** (배포 세션, 설계 세션 결정) | 문서 암호 머리를 UTF-8 퍼센트 인코딩으로 보내고 `X-Collab-Document-Password-Encoding: uri` 가 있을 때만 서버가 푼다(없으면 날 값 — 옛 클라이언트·'%' 가 든 ASCII 암호). 방 만들기(POST /rooms)·내려받기(GET document) 공통 `documentPassword(req)`: 잘못된 퍼센트 인코딩·모르는 인코딩 이름·푼 뒤 256자 초과는 400 bad-password, 빈 값은 없는 것으로. 업로드 페이지는 늘 인코딩해서 보내고 "영문·숫자·기호만" 안내를 걷음. 시험 +3(`encrypted-download.test.mjs` 7/7): 한글 암호("비밀번호123")로 HWP·HWPX(원래 암호 문서) 방을 내려받아 그 암호로 열면 정본과 같고 틀린 한글 암호·인코딩된 문자열로는 안 열림, 로그·저장소에 날 값·인코딩한 값 모두 없음 / 시험 중 rhwp 가 한글 암호로 건 HWP·HWPX 로 방 만들기(틀린 한글 암호는 400 wrong-password) → 같은 한글 암호로 다시 걸어 내려받아 열림 / 인코딩 머리 없이 'p%41ss%zz' 는 날 값 그대로 걸림, 잘못된 인코딩·모르는 인코딩 400, 푼 뒤 256자 됨·257자 400, 방 만들기도 잘못된 인코딩 400. 한계(규약 §5·README): rhwp 가 암호 문자열을 바이트로 바꾸는 방식이 한컴과 같은지는 한컴에서 한글 암호로 저장한 실물이 없어 확인하지 못함 — 확인한 것은 rhwp 자기 왕복과 ASCII 암호 한컴 샘플 |
| 2026-11-28 | **B 후속**(기존 코드 세션) | **기본값 on**(`COLLAB_ROUNDTRIP_LAYOUT` 기본 `on` — 근거: 더하는 시간 p90 0.65초, 새 시간 초과 0, 경고 2.3% 모두 실제 차이). **문구를 나눔**: 내용 손실(ir·record·bindata·ole-clsid·cfb·package)은 그대로 "이 부분이 있는 쪽을 편집하면 사라질 수 있습니다", 배치(layout)는 "rhwp 가 이 문서를 다시 쓰면 일부 쪽의 배치(줄 높이·위치)가 달라질 수 있습니다(5쪽 등)"(쪽 수가 달라지면 "(쪽 수 12 → 13)", 문제 쪽이 하나면 "등" 없이), 둘 다 있으면 두 문장. `roundtrip.ts`(`ROUNDTRIP_LAYOUT_WARNING`·`roundtripLayoutText`)·업로드 페이지(이름표·단위 포함)가 같은 규칙, launcher 는 `roundtripText` 를 써서 따라감. 막힌 방 문구(block)는 모든 종류를 목록으로. README 설정 표에 한 줄, 규약 §5 기본값·문구. 시험: collab-client **101/101**(문구 4줄), 서버 **100 + 2 건너뜀**(기본 on·off 시험), `--check`. **브라우저 회귀**(합친 상태 6a5cb4b + 이 고침, 원래 폴더 포트): s5-deploy **16/16**(PORT=8787), u1-undo **10/10**, R8 **22/22**, s1-rewrite **5/5**, u3-undo-range **14/14**(8788·7700), T4 **30/30**, d3-launcher(none) **9/9**. **block 판정**(결정): `COLLAB_ROUNDTRIP=block` 은 내용 손실(ir·record·bindata·ole-clsid·cfb·package)과 왕복 점검 시간 초과·오류만 막는다 — 배치 경고만 있거나 배치 점검만 못 했으면(layoutUnknown) 방을 만들고 경고를 응답·welcome 에 싣는다. 시험 +2(block + 배치만 → 201·응답·welcome / 내용 손실 → 422 / 배치만 시간 초과 → 201), 서버 **102 + 2 건너뜀**, 규약 §5·README 한 줄 |
| 2026-11-28 | **A 구현: 결과 전송에 자동 범위 표시** (코드 세션 cc-rhwp-f6, worktree `collab/undo3`, `9b87685` 위) | **Rust(`collab-core/src/undo_restore.rs`)**: `state_range`(호출 직전 문서 → 지금 문서. DocInfo 표시(U3-b 의 목록 개수·항목 저장 바이트)와 BinData(번호·확장자·내용 — 메모리 바이트는 그대로 견주고 지연 항목은 같은 원본·같은 키면 같다, 그 밖은 다이제스트)가 같고, 문서 속성·메모 관계·구역 수가 같고, 바뀐 구역이 하나이며 그 구역의 구역 정의·꼬리가 같을 때 앞 공통 문단(줄 정보까지)·뒤 공통 문단(줄 세로 위치 뺌)을 깎아 [lo, lo+before) → [lo, lo+after). 한쪽이 0 개면 이웃 공통 문단 하나를 넣는다. 못 달면 사유 `nochange`·`docinfo`·`props`·`sections`·`section-def`), `CollabCore::state_range_hint(pre)`(구한 범위를 서버와 같은 규칙으로 한 번 더 확인 — DocInfo `check_doc_info`, 그 구역 `compare_section`. 다른 구역은 `state_range` 가 같은 `section_model_digest` 로 이미 견줬으므로 다시 해시하지 않는다(큰 문서에서 비용의 대부분이 구역 해시라 처음 판의 164ms 를 88ms 로). 맞으면 after 문단과 DocInfo 표시로 복원 재료), `state_recipe(section, lo, n)`(지금 문서의 범위로 재료 — 합칠 때). U3 `compare_hint` 를 `check_bins`·`compare_section` 으로 나눴다(서버 판단은 그대로). JS `collabStateRangeHint`·`collabStateRecipe`·`collabSnapshotCount`(시험용). `lib.rs`·`wasm.rs`·`ot.rs` 무변경. **엔진(`engine.ts`)**: state·watch 호출 직전에 자체 스냅샷을 뜨고, 호출 뒤 **내보내기→다시 읽기 전에** 범위 표시를 구해 state 기록에 `range`·`recipe` 를 단다(U3 와 같은 필드 — 받는 쪽 보정, 미확정 다시 만들기, 재료 해제가 그대로 쓰인다). 미리 뜬 스냅샷은 성공·호출 실패·보조 예외 모두에서 그 호출 안에서 버린다. 보조가 없거나 예외를 던지거나 조건이 맞지 않으면 표시 없이 보통 state(편집은 막지 않음, `stateHints` 에 사유 — 예외는 `error`). 보내지 않은 연속 state 합치기: 둘 다 범위 표시가 있고 같은 구역이면 두 범위를 덮는 한 범위(재료는 지금 문서에서 새로)로 합친다 — U3 의 "범위 표시 state 는 합치지 않음"을 바꿈(시험 U3 ⑫ 기대를 고침). 표시 있는 것과 없는 것, 다른 구역, 재료를 못 만듦은 지금처럼 따로 둔다(보통 state 와 합치면 그것이 버려질 때 범위 편집도 함께 버려진다). op 가 기록 중 결과로 바뀌는 경우(인자 인코딩 실패·실측 불변식 위반)는 미리 뜬 스냅샷이 없어 보통 state. **세션**: `status().stateHints`(진단). **규약 문서** §3.3·§4.2 에 일반 state 의 범위 표시와 합치기. 서버 무변경(U3 의 `range` 통과·`check_range_hint` 그대로). U3 범위 복원을 못 해 원래 경로로 가는 `restoreSnapshot`·`restoreDeleteFragment`(보통 state)도 이제 실제 차이가 한 범위면 표시를 단다 |
| 2026-11-28 | A 시험 | Rust collab **119/119**(+5: 한 문단·나누기·합치기·떨어진 두 문단의 범위, 바뀐 것 없음·DocInfo 덧붙임·구역 정의·두 구역·스냅샷 없음, 재료로 남의 앞 Enter 뒤 다시 만들기 + 정본 확인, 지금 문서로 재료, BinData 내용이 바뀌거나 덧붙으면 표시 없음), collab-client **108/108**(새 `test/state-range.test.mjs` ①–⑦: 덧말 넣기 state 에 범위 표시·정본 확인·남은 스냅샷 0·재료 0, B 가 계속 치는 중 A 먼저·B 먼저 모두 취소 0, 조건이 안 맞는 state 는 보통 state 이고 그러면 B 의 입력이 취소됨(대조군), **보조가 예외를 던져도 편집은 보통 state 로 나감·남은 스냅샷 0**, 호출이 실패해도 남은 스냅샷 0, 보내지 않은 범위 state 둘은 한 범위로, 아래 한계의 번호 밀림), studio 27/27·tsc, 서버 88 통과 + 2 건너뜀, 분류표 `--check`(지문 `981ce66b4183-da6b3d6051f6-54b7092dc7d6-d0e76ac479bb`). R5 500×200: `--rewrite-state --verify-fast` 실패 0·불일치 0, 덧말 2103 전부 표시(못 단 것 0), 정본 범위 확인 738·거절 0. **표시를 끈 같은 섞기(`--no-state-hint`)와 견주면 취소된 편집 29,900 → 26,096(−12.7%), 글자 입력 충돌률 26.47% → 22.47%, 사유 "결과 전송(state) 기록과 겹침" 2,100 → 0, 서버까지 간 state 510 → 738.** `--rewrite-state --range-undo --verify-fast` 실패 0·표시 1,950·확인 1,063·거절 0·재료 0, `--s3 --rewrite-state --range-undo` 실패 0·표시 2,001·확인 806·거절 0·재료 0(세대 704·새 참여자 666·재시작 521), `--realistic --rewrite-state --verify-fast` 실패 0. 브라우저(지연 300ms) 새 `e2e/s7a-state-range.mjs` **4/4**(B 가 키보드로 치는 중 A 덧말 — A 먼저, B 의 Enter 먼저, 덧말 두 번 연달아: 두 탭 일치·취소 0·재동기화 0·B 의 글자 모두 남음·남은 스냅샷·재료 0), u3-undo-range 14/14, u1-undo 10/10, R8 22/22, s1-rewrite 5/5, T4 30/30 |
| 2026-11-28 | A 측정 | 아래 "A 측정표". `node scripts/check-behavior.mjs --state-range` — state 53종마다 R1b 사례 생성기로 문서를 바꾼 호출을 모으고, 생성기가 못 만들면 손으로 쓴 사례(이 측정 전용 — R1b 감사·분류표에는 쓰지 않는다)로 문서마다 한 번씩. 사례가 있는 26종 195건 중 **157건(22종)이 언제나 범위 표시**, 4종은 언제나 못 단다(설계의 조건대로: 글머리표 만들기 `docinfo`, 바탕쪽 만들기·지우기 `section-def`, 구역 합치기 `sections`). 한 기능 안에서 갈리는 것은 없었다. **비용(보내는 쪽, 스냅샷 + 비교)**: R1b 문서에서 기능별 중앙값 0.1~5.7ms·최대 8.2ms. 가장 큰 샘플(10.7MB·14구역·383쪽)에서 중앙값 90ms(스냅샷 2ms + 비교 88ms) — state 기록이 원래 하는 내보내기→다시 읽기(1,099ms)의 약 8%. **비용(정본)**: 범위 표시 state 마다 범위 확인(스냅샷 → C 읽기 → 적용 전 정본을 내보내 다시 읽어 견줌)이 더해진다. 같은 큰 샘플에서 C 읽기 ≈1.0s + 확인 1.7~3.0s — 보통 state 의 다시 쓰기(≈1.0s)·S 읽기(≈1.0s)에 더해져 정본 처리가 약 2배가 된다(작은 문서는 수 ms) |
| 2026-11-28 | A 한계·남은 것 | (1) DocInfo 를 덧붙이는 state(글머리표 만들기 등), 구역 정의를 바꾸는 state(바탕쪽), 여러 구역을 바꾸는 state(구역 합치기)는 보통 state — 설계대로. (2) **번호 밀림**: 미확정에 DocInfo 를 덧붙이는 내 op(서식 등)가 범위 state 보다 앞에 있고 남도 그사이 덧붙이면, 되감기 재적용에서 내 항목 번호가 밀려 재료 문단이 가리키는 번호가 달라진다 — DocInfo 표시가 맞지 않아 다시 만들지 않고 충돌로 버린다(표시가 없을 때와 같은 결과, 수렴). R5 `--rewrite-state` 500×200 에서 범위 state 약 2,100 건 중 4~13 건. 덧붙인 항목 번호 다시 매기기(다음 후보)가 이것도 푼다. (3) **큰 문서의 정본 비용**(위 측정) — 줄이는 후보: 확인을 C 대신 S(같은 모델)로 해 C 읽기 한 번을 덜기(`canonical-worker.mjs`), 적용 전 정본의 "다시 읽은 모양"을 두고 쓰기. 이번에는 서버를 바꾸지 않았다. (4) 측정에서 사례를 못 만든 27종(커서 목록 기반 표 편집·나누기·자동 번호, OLE 수식·연결선·그림 변환 보관·행/열 바꿈 복사처럼 준비가 필요한 것, 샘플에서 문서를 바꾸지 않는 것 — `ensureDefaultNumbering`·`reflowLinesegs`·`restoreSectionRaw` 등)은 실제 호출에서 조건이 맞으면 표시를 단다 — 측정으로는 확인하지 못했다. (5) 덧말 넣기는 studio 메뉴가 없어 브라우저 시험은 문서 핸들로 불렀다(공동편집 엔진이 기록하는 경로는 같다). (6) 보내는 쪽은 state 호출마다 문서 한 벌을 잠시 더 들고 있다(미리 뜬 스냅샷). watch(분류표 밖 이름, 지금 0 종)도 같다. (7) 시험 위생: 복원 재료 저장소가 WASM 인스턴스 전체에 하나라, 한 시험이 정리 전에 실패하면 뒤 시험의 "재료 0" 이 함께 실패한다(U3 ⑫ 를 고치는 중에 봄) |
| 2026-11-28 | **A 후속: 정본의 범위 확인을 C 대신 S 로** (설계 세션 결정, 코드 세션 cc-rhwp-f6, 합친 `d686c09` 위) | **순서**: 스냅샷 → S = rewrite(C) → S 읽기 → `check_range_hint`(스냅샷, S 를 읽은 문서). 받는 쪽이 모두 읽는 것이 S 이므로 표시가 S 위에서 참인지 보는 것이 정확하고, 정상 클라이언트는 S 와 C 의 모델이 같으며, 끼운 날 바이트가 있는 C 는 S 에서 이미 걸러진 뒤 판정한다. C 를 따로 읽던 한 번이 빠진다. 다시 쓰기 보조가 없는 정본은 C 를 읽어 확인한다. `server/canonical-worker.mjs` state 반복문(`checkRangeHint` → `loadHinted(e, S ?? C)`), 같은 순서로 시험 harness(`collab-client/test/support/harness.mjs`)와 Rust 시험 도우미 `canonical_apply_hinted`, 규약 문서 §4.2. Rust 판정(`check_range_hint`)은 그대로. **시험**: Rust collab **124/124**(+1: 정본 흐름에서 참인 표시는 지나고, 거짓 표시·범위 밖을 몰래 고친 state 는 S 를 읽은 문서에서도 `range`), 서버 **103 통과 + 2 건너뜀**(+1 `range-hint.test.mjs`: 구역 끝(범위 밖)에 모르는 레코드를 끼운 C 에 참인 범위 표시(덧말, 보낸 쪽 보조가 단 표시) — 확인을 지나고 ack 는 replaced·범위 표시 그대로, ack·방송·다른 참여자가 내보낸 바이트에 그 레코드가 없음, digest = 정본. 거짓 범위 표시는 여전히 invalid range), collab-client 108/108, studio 27/27·tsc, 분류표 `--check`(지문 `981ce66b4183-da6b3d6051f6-bb72754b1dc2-d0e76ac479bb`). R5 500×200 `--rewrite-state --verify-fast`·`--rewrite-state --range-undo --verify-fast`·`--s3 --rewrite-state --range-undo` 실패 0·거절 0·재료 0 — 숫자가 고치기 전과 똑같다(정상 클라이언트는 S 와 C 의 모델이 같다). 브라우저(지연 300ms) s7a 4/4, u3-undo-range 14/14, s1-rewrite 5/5, u1-undo 10/10, R8 22/22, T4 30/30. **정본 시간**(10.7MB·383쪽 샘플, 덧말 한 번의 범위 표시 state, 흐름마다 따로 띄운 프로세스에서 데우기 뒤 4번의 중앙값): 보통 state(S 만들기·읽기) 1.29s, 범위 표시 state 고치기 전 3.10s → 고친 뒤 **2.43s**(−0.67s, −22%). 범위 표시가 보통 state 에 더하는 몫은 1.81s → 1.14s. 남은 몫은 확인이 적용 전 정본을 내보내 다시 읽는 일(`reparsed_like_current`)이다 |
| 2026-11-28 | **B 측정 원인 정정·업스트림 이슈 문안**(기존 코드 세션, 사용자 결정으로 문안만 — 올리는 것은 배포 세션) | 처음 기록(위 B 행)의 원인 ①②가 틀려 다시 쟀다. 저장소 샘플 10개(위 배치 경고 10개)를 고정 rev 981ce66b 와 업스트림 devel 274ae9d4 에서 원본 바이트 캐시를 종류별로 버리고 다시 써 견주니, **글자 모양만·글꼴만 다시 쓰면 조판 0px**, **본문 구역만 다시 쓰면 위 변위 그대로**. 다시 쓴 저장본에 `/RhwpLineSegTags` 가 생기고, 이 스트림만 지우면 10개 모두 0px — 표지가 다시 읽을 때 그 구역을 rhwp 관리 줄 캐시로 보게 해 표 칸 줄을 다시 잰다(업스트림 `owns_section_line_cache` → `owned_cell_with_current_metrics`). mel-001 은 다시 쓴 구역 레코드가 원본과 바이트까지 같은데 표지만 붙는다. **정상 편집에서도 생긴다**: multi-table-001 1쪽 문단에 글자 하나를 넣고 저장해 다시 열면 편집하지 않은 2쪽 표 숫자 칸 글줄이 17.75 → 13.33px(글자 2.21px 내려감, 편집 전후 화면은 2쪽이 같았음). 한 번 더 저장하면 그 칸 `PARA_LINE_SEG` 40개가 다시 잰 값으로 파일에 들어가고 그 뒤로는 그대로. 편집 없이 저장하면 0px. 공동편집 배치 점검의 판정·문구는 그대로 맞다(다시 쓰면 배치가 달라질 수 있다). 시험 이름·주석을 원인에 맞게 고침(`layout_check_catches_the_line_cache_marker_relayout_s2_does_not_see`, 기대값 그대로). 업스트림 이슈 문안은 이 원인으로 썼고, 글자 모양 `attr`·`default_name` 은 "바뀌지만 조판 영향이 없던 것"으로 참고에 남겼다. **확인 안 한 관찰**(원인은 보지 않음): ① multi-table-001 본문을 모델에서 다시 쓰면 새 번호 지정 컨트롤이 있는 문단의 char_count 17 → 18, control_mask 0x40800 → 0x200800(조판 영향 0) ② mel-001 1쪽 글자 하나에 굵게를 주면 편집 세션 안에서 3~17쪽이 최대 382px 움직인다 — 나중에 따로 볼 후보 |

### A 측정표 (2026-11-28, `check-behavior.mjs --state-range`)

사례가 있는 기능만 싣는다. "(손)" 은 손으로 쓴 사례, 닿는 곳은 분류표의 `reach`. 시간은 사례마다 스냅샷 + 비교(호출 자체는 뺌).

| 기능 | 닿는 곳 | 사례 | 표시 | 못 단 사유 | 스냅샷+비교 ms (중앙값/최대) |
|---|---|---|---|---|---|
| `applyCharFormatInCellEx` | none | 1 | 1 | - | 2.95 / 2.95 |
| `attachCaptionAt` | none | 4 | 4 | - | 2.07 / 5.51 |
| `createBullet` | none | 13 (손) | 0 | docinfo 13 | 0.11 / 0.88 |
| `createMasterPage` | none | 12 (손) | 0 | section-def 12 | 0.43 / 1.32 |
| `deleteCellTableControlByPath` | none | 5 | 5 | - | 1.35 / 5.10 |
| `deleteComposeControl` | none | 5 (손) | 5 | - | 1.83 / 5.08 |
| `deleteComposeControlByPath` | none | 13 (손) | 13 | - | 1.36 / 4.45 |
| `deleteComposeControlInFootnote` | none | 5 (손) | 5 | - | 1.53 / 4.67 |
| `deleteMasterPage` | none | 12 (손) | 0 | section-def 12 | 0.38 / 1.23 |
| `insertCharOverlap` | none | 5 (손) | 5 | - | 5.74 / 8.24 |
| `insertCharOverlapByPath` | none | 13 (손) | 13 | - | 1.48 / 7.29 |
| `insertCharOverlapInFootnote` | none | 5 (손) | 5 | - | 1.79 / 5.12 |
| `insertRuby` | none | 5 (손) | 5 | - | 1.70 / 4.71 |
| `insertRubyByPath` | none | 13 (손) | 13 | - | 1.31 / 4.86 |
| `insertRubyInFootnote` | none | 5 (손) | 5 | - | 1.81 / 4.49 |
| `mergeSection` | none | 1 (손) | 0 | sections 1 | 0.19 / 0.19 |
| `recalculateTableFormulas` | none | 13 (손) | 13 | - | 1.71 / 4.91 |
| `removeFieldAtInCellEx` | none | 5 | 5 | - | 1.43 / 1.50 |
| `removeTableCellFormulas` | none | 13 (손) | 13 | - | 1.35 / 4.95 |
| `restoreDeleteFragment` | studio | 4 (손) | 4 | - | 3.99 / 5.36 |
| `restoreSnapshot` | studio | 5 (손) | 5 | - | 1.73 / 6.03 |
| `setComposeControl` | none | 5 (손) | 5 | - | 1.82 / 4.71 |
| `setComposeControlByPath` | none | 13 (손) | 13 | - | 1.30 / 4.67 |
| `setComposeControlInFootnote` | none | 5 (손) | 5 | - | 1.79 / 5.01 |
| `setTableCellFormula` | none | 13 (손) | 13 | - | 1.02 / 3.77 |
| `setTextBoxAt` | none | 2 | 2 | - | 1.39 / 1.39 |

사례가 없는 27종: 커서 목록 기반(`breakAtCursor`·`clearTableCellsAtCursor`·`insertAutoNumberAtCursor`·`tableEditAtCursor`·`tableMergeAtCursor`), 준비할 개체·자료가 필요(`applyTemplateOperation`·`importParagraphBlock`·`insertClickHereFieldByPathEx`·`moveInlineControl`·`moveLineEndpointEx`·`pasteTableCellsTransposed`·`pasteTableCellsTransposedAsTable`·`promoteOleEquation`·`removeBorderFillTails`·`setHeaderFooterPictureProperties`·`setNoteEquationProperties`·`setNoteEquationPropertiesEx`·`swapPictureTransform`), 샘플에서 문서를 바꾸지 않음(`convertToEditable`·`detachCaptionAt`·`ensureDefaultNumbering`·`injectExternalImage`·`injectExternalImageByKey`·`reflowLinesegs`·`restoreSectionRaw`·`setControlZOrderAt`·`updateConnectorsInSection`).

가장 큰 샘플(10.7MB, 14구역, 383쪽, 구역 0 의 문단 97 에 덧말): 스냅샷+비교 중앙값 90ms·최대 126ms(스냅샷 2ms, 비교 88ms), 내보내기→다시 읽기 1,099ms. 정본의 범위 확인은 C 읽기 ≈1.0s + 확인 1.7~3.0s.
