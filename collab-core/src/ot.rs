//! 보정 함수 (docs/collab-stage2.md §4). 문서를 보지 않는 순수 함수다.
//!
//! - 텍스트 연산 7종(+셀 `deleteRange`)은 위치 지도로 정밀 보정한다(§4.3, §4.4).
//! - 그 밖은 분류(`conc`)와 구역으로 판정한다(§4.5): `neutral` 은 `roles` 위치만 옮기고, 같은 구역의
//!   `structural`·모든 `state` 는 충돌이다.
//! - 되감기 방식(§4.1)이라 보정이 다소 틀려도 수렴은 깨지지 않는다 — 의도만 어긋난다.
//!
//! 위치는 텍스트 좌표(`para.text` 의 유니코드 스칼라 인덱스, §3)다. 개체는 이 좌표에 자리를 차지하지 않는다.

use serde_json::{json, Map, Value};

/// 한 공간 안의 위치. 본문이면 (문단, 글자), 셀이면 (셀 문단, 글자).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Pos {
    pub para: usize,
    pub off: usize,
}

impl Pos {
    pub fn new(para: usize, off: usize) -> Self {
        Self { para, off }
    }
}

/// 위치 공간. 셀 공간은 중첩될 수 있다(R13): `chain[k]` = k 단계 (개체 번호, 칸 번호), `hosts[0]` = 바깥 표를
/// 품은 본문 문단, `hosts[k]`(k ≥ 1) = k 단계 표를 품은 바깥 칸의 문단. 위치는 가장 안쪽 칸의 (칸 문단, 글자).
/// 바깥 공간의 연산은 안쪽 공간의 `hosts` 자리를 문단 번호처럼 옮긴다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Space {
    Body { sec: usize },
    Cell { sec: usize, hosts: Vec<usize>, chain: Vec<(usize, usize)> },
}

impl Space {
    fn sec(&self) -> usize {
        match self {
            Space::Body { sec } | Space::Cell { sec, .. } => *sec,
        }
    }

    /// 한 단계 표 칸 공간.
    pub fn cell(sec: usize, pp: usize, ci: usize, cell: usize) -> Self {
        Space::Cell { sec, hosts: vec![pp], chain: vec![(ci, cell)] }
    }

    /// `inner` 가 이 공간의 문단에 놓인 표 안이면, 그 문단 번호가 든 `inner` 의 `hosts` 자리.
    fn host_level(&self, inner: &Space) -> Option<usize> {
        match (self, inner) {
            (Space::Body { sec }, Space::Cell { sec: s2, .. }) if sec == s2 => Some(0),
            (Space::Cell { sec, hosts, chain }, Space::Cell { sec: s2, hosts: h2, chain: c2 })
                if sec == s2 && c2.len() > chain.len() && c2.starts_with(chain) && h2.starts_with(hosts) =>
            {
                Some(chain.len())
            }
            _ => None,
        }
    }

    fn with_host(&self, level: usize, q: usize) -> Space {
        let mut s = self.clone();
        if let Space::Cell { hosts, .. } = &mut s {
            hosts[level] = q;
        }
        s
    }

    /// 본문 기준 문단(셀이면 바깥 표를 품은 본문 문단).
    fn body_para(&self) -> Option<usize> {
        match self {
            Space::Body { .. } => None,
            Space::Cell { hosts, .. } => hosts.first().copied(),
        }
    }

    /// 셀 경로 JSON (`[{controlIndex, cellIndex, cellParaIndex}…]`). 마지막 단계의 칸 문단은 `last_para`.
    fn path_json(&self, last_para: usize) -> String {
        let Space::Cell { hosts, chain, .. } = self else { return "[]".into() };
        let steps: Vec<Value> = chain
            .iter()
            .enumerate()
            .map(|(k, (ci, cell))| {
                let cp = if k + 1 < chain.len() { hosts[k + 1] } else { last_para };
                json!({ "controlIndex": ci, "cellIndex": cell, "cellParaIndex": cp })
            })
            .collect();
        Value::Array(steps).to_string()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bias {
    Before,
    After,
}

/// 누가 먼저냐. 미확정 P 를 원격 R 에 맞출 때 P 는 `Second`, R 을 P 에 맞출 때 R 은 `First`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    First,
    Second,
}

fn insert_bias(side: Side) -> Bias {
    match side {
        Side::First => Bias::Before,
        Side::Second => Bias::After,
    }
}

/// 텍스트 연산 (텍스트 좌표).
#[derive(Clone, Debug, PartialEq)]
pub enum TOp {
    /// `insertText` / `insertTextLogical`(`logical = Some(개체 뒤 여부)`)
    Ins { space: Space, at: Pos, len: usize, text: String, logical: Option<bool> },
    /// `deleteText` / `deleteRange` / 셀 `deleteRange` — `[from, to)`. `objects` 면 범위 안의 개체(표·그림 등)도
    /// 지운다(deleteRange 계열 — 한 문단 안이어도 표를 지운다, R13 에서 확인). deleteText 계열은 글자만.
    Del { space: Space, from: Pos, to: Pos, objects: bool },
    /// `replaceBodyTextLocal` — `[at, at+del)` 를 지우고 `at` 에 `text`
    Replace { space: Space, at: Pos, del: usize, text: String },
    /// `splitParagraph` (`meta` 는 4번째 인자 그대로, 없으면 `None`)
    Split { space: Space, at: Pos, meta: Option<Value> },
    /// `mergeParagraph` — `para` 를 `para-1` 끝(`prev_len`)에 붙인다
    Merge { space: Space, para: usize, prev_len: usize },
}

impl TOp {
    pub fn space(&self) -> &Space {
        match self {
            TOp::Ins { space, .. } | TOp::Del { space, .. } | TOp::Replace { space, .. } | TOp::Split { space, .. } | TOp::Merge { space, .. } => space,
        }
    }

    fn with_space(mut self, s: Space) -> Self {
        match &mut self {
            TOp::Ins { space, .. } | TOp::Del { space, .. } | TOp::Replace { space, .. } | TOp::Split { space, .. } | TOp::Merge { space, .. } => *space = s,
        }
        self
    }
}

/// 보정할 수 없음(§4.5 충돌, 셀 부모 문단 구조 변경 등).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Conflict(pub String);

fn conflict<T>(why: impl Into<String>) -> Result<T, Conflict> {
    Err(Conflict(why.into()))
}

// ── 위치 지도 (§4.3) ─────────────────────────────────────────────────────

/// 지도 결과. `deleted` 면 원래 위치가 지워진 범위 안이었다(삭제 시작점으로 접힘).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mapped {
    pub pos: Pos,
    pub deleted: bool,
}

fn kept(pos: Pos) -> Mapped {
    Mapped { pos, deleted: false }
}

fn map_ins(pos: Pos, at: Pos, len: usize, bias: Bias) -> Mapped {
    if pos.para != at.para || pos.off < at.off || (pos.off == at.off && bias == Bias::Before) {
        kept(pos)
    } else {
        kept(Pos::new(pos.para, pos.off + len))
    }
}

fn map_del(pos: Pos, from: Pos, to: Pos) -> Mapped {
    if pos <= from {
        kept(pos)
    } else if pos >= to {
        if pos.para == to.para {
            kept(Pos::new(from.para, from.off + (pos.off - to.off)))
        } else {
            kept(Pos::new(pos.para - (to.para - from.para), pos.off))
        }
    } else {
        Mapped { pos: from, deleted: true }
    }
}

/// 같은 공간 안 위치를 텍스트 연산 하나 뒤로 옮긴다.
pub fn map_pos(pos: Pos, op: &TOp, bias: Bias) -> Mapped {
    match op {
        TOp::Ins { at, len, .. } => map_ins(pos, *at, *len, bias),
        TOp::Del { from, to, .. } => map_del(pos, *from, *to),
        TOp::Replace { at, del, text, .. } => {
            let d = map_del(pos, *at, Pos::new(at.para, at.off + del));
            let i = map_ins(d.pos, *at, text.chars().count(), bias);
            Mapped { pos: i.pos, deleted: d.deleted }
        }
        TOp::Split { at, .. } => {
            if pos.para == at.para {
                if pos.off < at.off || (pos.off == at.off && bias == Bias::Before) {
                    kept(pos)
                } else {
                    kept(Pos::new(pos.para + 1, pos.off - at.off))
                }
            } else if pos.para > at.para {
                kept(Pos::new(pos.para + 1, pos.off))
            } else {
                kept(pos)
            }
        }
        TOp::Merge { para, prev_len, .. } => {
            if pos.para == *para {
                kept(Pos::new(para - 1, prev_len + pos.off))
            } else if pos.para > *para {
                kept(Pos::new(pos.para - 1, pos.off))
            } else {
                kept(pos)
            }
        }
    }
}

/// 문단 번호의 운명. `Touched` 는 그 문단이 나뉘거나 합쳐지거나 걸친 삭제에 들어갔다는 뜻이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParaFate {
    Kept(usize),
    Touched(usize),
    Gone(usize),
}

pub fn map_para(q: usize, op: &TOp) -> ParaFate {
    match op {
        TOp::Ins { .. } | TOp::Replace { .. } => ParaFate::Kept(q),
        TOp::Del { from, to, objects: true, .. } if from.para == to.para && q == from.para => ParaFate::Touched(q),
        TOp::Del { from, to, .. } if from.para == to.para => ParaFate::Kept(q),
        TOp::Del { from, to, .. } => {
            if q < from.para {
                ParaFate::Kept(q)
            } else if q > to.para {
                ParaFate::Kept(q - (to.para - from.para))
            } else if q == from.para || q == to.para {
                ParaFate::Touched(from.para)
            } else {
                ParaFate::Gone(from.para)
            }
        }
        TOp::Split { at, .. } => {
            if q < at.para {
                ParaFate::Kept(q)
            } else if q == at.para {
                ParaFate::Touched(q)
            } else {
                ParaFate::Kept(q + 1)
            }
        }
        TOp::Merge { para, .. } => {
            if q + 1 < *para {
                ParaFate::Kept(q)
            } else if q + 1 == *para || q == *para {
                ParaFate::Touched(para - 1)
            } else {
                ParaFate::Kept(q - 1)
            }
        }
    }
}

// ── 텍스트 연산끼리의 보정 (§4.4) ─────────────────────────────────────────

/// 삭제 범위 `[from, to)` 를 `b` 뒤로 옮긴 구간들. 시작은 bias After, 끝은 bias Before. 상대가 범위 안에
/// 끼워 넣은 글자는 살린다(구간을 쪼갠다). 비면 빈 목록.
///
/// 범위 안의 문단 나눔(`b` 가 Split)은 **누가 미확정이냐**로 운명을 정하고, 반대 방향 보정(`transform_text` 의
/// Split 분기)과 반드시 같은 판정을 한다(TP1 — 다르면 다음 미확정 연산의 위치가 어긋난다, R5 에서 발견):
/// - 삭제가 미확정(`Second`): 나눔 경계까지 지운다(`deleteRange`, 설계 §4.4) — 상대 나눔은 흡수된다.
/// - 삭제가 원격(`First`): 미확정 나눔이 살아남으므로 경계를 넘지 않게 둘로 쪼갠다.
fn delete_intervals(from: Pos, to: Pos, b: &TOp, side: Side) -> Vec<(Pos, Pos)> {
    if let (TOp::Split { at, .. }, Side::First) = (b, side) {
        if from < *at && *at < to {
            let e = map_pos(to, b, Bias::Before).pos;
            let boundary_after = Pos::new(at.para + 1, 0);
            return [(from, *at), (boundary_after, e)].into_iter().filter(|(a, b)| a < b).collect();
        }
    }
    let s = map_pos(from, b, Bias::After).pos;
    let e = map_pos(to, b, Bias::Before).pos;
    if s >= e {
        return vec![];
    }
    let inserted = match b {
        TOp::Ins { at, len, .. } => Some((*at, *len)),
        TOp::Replace { at, text, .. } => Some((*at, text.chars().count())),
        _ => None,
    };
    if let Some((at, len)) = inserted {
        let end = Pos::new(at.para, at.off + len);
        if len > 0 && s < at && end <= e {
            return [(s, at), (end, e)].into_iter().filter(|(a, b)| a < b).collect();
        }
    }
    vec![(s, e)]
}

/// 삭제 구간들을 연산으로. 뒤 구간부터 지워 앞 구간의 위치가 바뀌지 않게 한다.
fn delete_ops(space: &Space, mut intervals: Vec<(Pos, Pos)>, objects: bool) -> Vec<TOp> {
    intervals.sort_by(|a, b| b.0.cmp(&a.0));
    intervals.into_iter().map(|(from, to)| TOp::Del { space: space.clone(), from, to, objects }).collect()
}

/// `a` 를 `b` 뒤로 옮긴다(둘은 같은 상태에서 출발).
pub fn transform_text(a: &TOp, b: &TOp, side: Side) -> Result<Vec<TOp>, Conflict> {
    let (sa, sb) = (a.space(), b.space());
    if sa != sb {
        // a 가 b 공간의 문단에 놓인 표 안이면: 그 문단(hosts 자리)을 문단 번호처럼 옮긴다. 다른 칸·다른 표는 무관.
        if let (Some(k), Space::Cell { hosts, .. }) = (sb.host_level(sa), sa) {
            return match map_para(hosts[k], b) {
                ParaFate::Kept(q) => Ok(vec![a.clone().with_space(sa.with_host(k, q))]),
                _ => conflict("셀을 품은 본문 문단이 구조적으로 바뀜"),
            };
        }
        return Ok(vec![a.clone()]);
    }
    let space = sa.clone();
    Ok(match a {
        TOp::Ins { at, len, text, logical, .. } => {
            let m = map_pos(*at, b, insert_bias(side));
            vec![TOp::Ins { space, at: m.pos, len: *len, text: text.clone(), logical: *logical }]
        }
        TOp::Split { at, meta, .. } => {
            let m = map_pos(*at, b, insert_bias(side));
            // 원격 나눔이 미확정 삭제 범위 안에 있었으면 흡수된다(delete_intervals 의 Second 판정과 짝).
            // 미확정 나눔이면 삭제 시작점에서 나눈다(설계 §4.4 Split).
            if m.deleted && side == Side::First {
                vec![]
            } else {
                vec![TOp::Split { space, at: m.pos, meta: meta.clone() }]
            }
        }
        TOp::Del { from, to, objects, .. } => delete_ops(&space, delete_intervals(*from, *to, b, side), *objects),
        TOp::Replace { at, del, text, .. } => {
            let intervals = delete_intervals(*at, Pos::new(at.para, at.off + del), b, side);
            // 삽입 위치는 삭제 구간과 따로 정한다. 같은 자리에 상대도 글자를 넣었으면 먼저 확정된 쪽(First)이
            // 앞이다 — 삭제 구간 시작(bias After)을 쓰면 First 도 상대 글자 뒤에 넣어 두 순서가 갈린다(R11 에서 발견).
            let ins_at = map_pos(*at, b, insert_bias(side)).pos;
            match intervals.as_slice() {
                [] => vec![TOp::Replace { space, at: ins_at, del: 0, text: text.clone() }],
                [(s, e)] if s.para == e.para && *s == ins_at => {
                    vec![TOp::Replace { space, at: *s, del: e.off - s.off, text: text.clone() }]
                }
                _ => {
                    let mut ops = delete_ops(&space, intervals, false);
                    if !text.is_empty() {
                        ops.push(TOp::Ins { space, at: ins_at, len: text.chars().count(), text: text.clone(), logical: None });
                    }
                    ops
                }
            }
        }
        TOp::Merge { para, prev_len, .. } => {
            // 문단 경계 삭제로 본다. 경계 시작은 bias After, 끝은 bias Before.
            let b0 = map_pos(Pos::new(para - 1, *prev_len), b, Bias::After).pos;
            let e0 = map_pos(Pos::new(*para, 0), b, Bias::Before).pos;
            if b0 >= e0 {
                vec![]
            } else if e0.para == b0.para + 1 && e0.off == 0 {
                vec![TOp::Merge { space, para: e0.para, prev_len: b0.off }]
            } else {
                vec![TOp::Del { space, from: b0, to: e0, objects: false }]
            }
        }
    })
}

// ── 기록 (JSON) ↔ 텍스트 연산 ──────────────────────────────────────────

fn num(a: &[Value], i: usize) -> Option<usize> {
    a.get(i).and_then(Value::as_u64).map(|v| v as usize)
}
fn meta_num(meta: &Value, k: &str) -> Option<usize> {
    meta.get(k).and_then(Value::as_u64).map(|v| v as usize)
}

/// 텍스트 기록을 연산으로. 텍스트 연산이 아니거나 필요한 값(인자·meta)이 없으면 `None`.
pub fn parse_text(rec: &Value) -> Option<TOp> {
    let m = rec.get("m")?.as_str()?;
    let a = rec.get("a")?.as_array()?;
    let meta = rec.get("meta").cloned().unwrap_or(Value::Null);
    let body = |i| Some(Space::Body { sec: num(a, i)? });
    Some(match m {
        "insertText" => {
            let text = a.get(3)?.as_str()?.to_string();
            let len = meta_num(&meta, "len").unwrap_or_else(|| text.chars().count());
            TOp::Ins { space: body(0)?, at: Pos::new(num(a, 1)?, num(a, 2)?), len, text, logical: None }
        }
        "insertTextLogical" => {
            let text = a.get(3)?.as_str()?.to_string();
            TOp::Ins {
                space: body(0)?,
                at: Pos::new(num(a, 1)?, meta_num(&meta, "offset")?),
                len: meta_num(&meta, "len")?,
                text,
                logical: Some(meta.get("afterControl")?.as_bool()?),
            }
        }
        "deleteText" => {
            let (para, off) = (num(a, 1)?, num(a, 2)?);
            let count = meta_num(&meta, "count").or_else(|| num(a, 3))?;
            TOp::Del { space: body(0)?, from: Pos::new(para, off), to: Pos::new(para, off + count), objects: false }
        }
        "replaceBodyTextLocal" => TOp::Replace {
            space: body(0)?,
            at: Pos::new(num(a, 1)?, num(a, 2)?),
            del: meta_num(&meta, "deleted").or_else(|| num(a, 3))?,
            text: a.get(4)?.as_str()?.to_string(),
        },
        "splitParagraph" => TOp::Split {
            space: body(0)?,
            at: Pos::new(num(a, 1)?, num(a, 2)?),
            meta: if a.len() > 3 { Some(a[3].clone()) } else { None },
        },
        "mergeParagraph" => {
            let para = num(a, 1)?;
            if para == 0 {
                return None;
            }
            TOp::Merge { space: body(0)?, para, prev_len: meta_num(&meta, "prevLen")? }
        }
        "deleteRange" => TOp::Del {
            space: body(0)?,
            from: Pos::new(num(a, 1)?, num(a, 2)?),
            to: Pos::new(num(a, 3)?, num(a, 4)?),
            objects: true,
        },
        "deleteRangeInCellEx" => {
            let o: Value = serde_json::from_str(a.first()?.as_str()?).ok()?;
            let g = |k: &str| o.get(k).and_then(Value::as_u64).map(|v| v as usize);
            TOp::Del {
                space: Space::cell(g("sectionIdx")?, g("parentParaIdx")?, g("controlIdx")?, g("cellIdx")?),
                from: Pos::new(g("startCellParaIdx")?, g("startCharOffset")?),
                to: Pos::new(g("endCellParaIdx")?, g("endCharOffset")?),
                objects: true,
            }
        }
        _ => return parse_cell_text(m, a, &meta),
    })
}

/// 셀 텍스트 연산의 공간과 대상 칸 문단(R13). 평면(`sec,pp,ci,cell,cp,…`)·경로(`sec,pp,path_json,…`)·Ex(옵션
/// JSON) 형식. 대상 칸 문단이 없는 형식(deleteRange 계열)은 `para` 가 0.
pub fn cell_target(m: &str, a: &[Value]) -> Option<(Space, usize)> {
    let flat = || Some((Space::cell(num(a, 0)?, num(a, 1)?, num(a, 2)?, num(a, 3)?), num(a, 4).unwrap_or(0)));
    let path = || {
        let steps: Value = serde_json::from_str(a.get(2)?.as_str()?).ok()?;
        let steps = steps.as_array()?;
        if steps.is_empty() {
            return None;
        }
        // 키는 `controlIndex` 계열과 `controlIdx` 계열 둘 다(업스트림 `parse_cell_path_json` 과 같음)
        let g = |v: &Value, k: &str, alt: &str| v.get(k).or_else(|| v.get(alt)).and_then(Value::as_u64).map(|x| x as usize);
        let mut hosts = vec![num(a, 1)?];
        let mut chain = Vec::new();
        let mut last = 0;
        for (k, st) in steps.iter().enumerate() {
            chain.push((g(st, "controlIndex", "controlIdx")?, g(st, "cellIndex", "cellIdx")?));
            let cp = g(st, "cellParaIndex", "cellParaIdx").unwrap_or(0);
            if k + 1 < steps.len() {
                hosts.push(cp);
            } else {
                last = cp;
            }
        }
        Some((Space::Cell { sec: num(a, 0)?, hosts, chain }, last))
    };
    let ex = || {
        let o: Value = serde_json::from_str(a.first()?.as_str()?).ok()?;
        let g = |k: &str| o.get(k).and_then(Value::as_u64).map(|v| v as usize);
        Some((Space::cell(g("sectionIdx")?, g("parentParaIdx")?, g("controlIdx")?, g("cellIdx")?), g("cellParaIdx").unwrap_or(0)))
    };
    match m {
        "insertTextInCell" | "insertTextInCellDeferredPagination" | "deleteTextInCell" | "deleteTextInCellDeferredPagination"
        | "replaceTextInCellDeferredPagination" | "splitParagraphInCell" | "mergeParagraphInCell" | "deleteRangeInCell" => flat(),
        "insertTextInCellByPath" | "deleteTextInCellByPath" | "splitParagraphInCellByPath" | "mergeParagraphInCellByPath"
        | "deleteRangeInCellByPath" => path(),
        "insertTextInCellEx" | "deleteTextInCellEx" => ex(),
        _ => None,
    }
}

fn parse_cell_text(m: &str, a: &[Value], meta: &Value) -> Option<TOp> {
    let (space, cp) = cell_target(m, a)?;
    let ex_opts = || -> Option<Value> { serde_json::from_str(a.first()?.as_str()?).ok() };
    Some(match m {
        "insertTextInCell" | "insertTextInCellDeferredPagination" | "insertTextInCellByPath" | "insertTextInCellEx" => {
            let (off, text) = match m {
                "insertTextInCellByPath" => (num(a, 3)?, a.get(4)?.as_str()?.to_string()),
                "insertTextInCellEx" => {
                    let o = ex_opts()?;
                    (o.get("charOffset")?.as_u64()? as usize, o.get("text")?.as_str()?.to_string())
                }
                _ => (num(a, 5)?, a.get(6)?.as_str()?.to_string()),
            };
            let len = meta_num(meta, "len").unwrap_or_else(|| text.chars().count());
            TOp::Ins { space, at: Pos::new(cp, off), len, text, logical: None }
        }
        "deleteTextInCell" | "deleteTextInCellDeferredPagination" | "deleteTextInCellByPath" | "deleteTextInCellEx" => {
            let (off, count) = match m {
                "deleteTextInCellByPath" => (num(a, 3)?, num(a, 4)?),
                "deleteTextInCellEx" => {
                    let o = ex_opts()?;
                    (o.get("charOffset")?.as_u64()? as usize, o.get("count")?.as_u64()? as usize)
                }
                _ => (num(a, 5)?, num(a, 6)?),
            };
            let count = meta_num(meta, "count").unwrap_or(count);
            TOp::Del { space, from: Pos::new(cp, off), to: Pos::new(cp, off + count), objects: false }
        }
        "replaceTextInCellDeferredPagination" => TOp::Replace {
            space,
            at: Pos::new(cp, num(a, 5)?),
            del: meta_num(meta, "deleted").or_else(|| num(a, 6))?,
            text: a.get(7)?.as_str()?.to_string(),
        },
        "splitParagraphInCell" => TOp::Split { space, at: Pos::new(cp, num(a, 5)?), meta: a.get(6).cloned() },
        "splitParagraphInCellByPath" => TOp::Split { space, at: Pos::new(cp, num(a, 3)?), meta: a.get(4).cloned() },
        "mergeParagraphInCell" | "mergeParagraphInCellByPath" => {
            if cp == 0 {
                return None;
            }
            TOp::Merge { space, para: cp, prev_len: meta_num(meta, "prevLen")? }
        }
        "deleteRangeInCell" => TOp::Del { space, from: Pos::new(num(a, 4)?, num(a, 5)?), to: Pos::new(num(a, 6)?, num(a, 7)?), objects: true },
        "deleteRangeInCellByPath" => TOp::Del { space, from: Pos::new(num(a, 3)?, num(a, 4)?), to: Pos::new(num(a, 5)?, num(a, 6)?), objects: true },
        _ => return None,
    })
}

/// 연산을 기록으로. `template` 의 `ctx` 와 (insertTextLogical 이면) 원래 논리 오프셋을 물려받는다.
/// `insertTextLogical` 의 논리 오프셋은 재적용하는 쪽이 그 시점 문서로 다시 계산한다(`meta.relogical`).
pub fn emit_text(op: &TOp, template: &Value) -> Value {
    let mut rec = Map::new();
    rec.insert("kind".into(), json!("op"));
    let (m, a, meta) = match op {
        TOp::Ins { space: Space::Body { sec }, at, len, text, logical: None } => {
            ("insertText", json!([sec, at.para, at.off, text]), json!({ "len": len }))
        }
        TOp::Ins { space: Space::Body { sec }, at, len, text, logical: Some(after) } => {
            // 빠른 경로(R11)에서는 보정된 미확정을 적용하지 않고 들고 있으므로 relogical 표시가 남아 있을 수 있다.
            // 다시 보정할 때 위치가 그대로여도 그 표시는 이어 가야 한다(논리 오프셋 a[2] 가 아직 옛 값이다).
            let carried = template.get("meta").and_then(|m| m.get("relogical")).and_then(Value::as_bool) == Some(true);
            let changed = carried || parse_text(template).map(|t| &t != op).unwrap_or(true);
            let logical = template["a"].get(2).cloned().unwrap_or(json!(at.off));
            let mut meta = json!({ "offset": at.off, "afterControl": after, "len": len });
            if changed {
                meta["relogical"] = json!(true);
            }
            ("insertTextLogical", json!([sec, at.para, logical, text]), meta)
        }
        TOp::Del { space: Space::Body { sec }, from, to, objects: false } if from.para == to.para => {
            ("deleteText", json!([sec, from.para, from.off, to.off - from.off]), json!({ "count": to.off - from.off }))
        }
        TOp::Del { space: Space::Body { sec }, from, to, .. } => {
            ("deleteRange", json!([sec, from.para, from.off, to.para, to.off]), json!({}))
        }
        TOp::Ins { space: s @ Space::Cell { .. }, .. }
        | TOp::Del { space: s @ Space::Cell { .. }, .. }
        | TOp::Replace { space: s @ Space::Cell { .. }, .. }
        | TOp::Split { space: s @ Space::Cell { .. }, .. }
        | TOp::Merge { space: s @ Space::Cell { .. }, .. } => emit_cell(op, s, template),
        TOp::Replace { space: Space::Body { sec }, at, del, text } => (
            "replaceBodyTextLocal",
            json!([sec, at.para, at.off, del, text]),
            json!({ "deleted": del, "insLen": text.chars().count() }),
        ),
        TOp::Split { space: Space::Body { sec }, at, meta } => {
            let mut a = vec![json!(sec), json!(at.para), json!(at.off)];
            if let Some(m) = meta {
                a.push(m.clone());
            }
            ("splitParagraph", Value::Array(a), json!({}))
        }
        TOp::Merge { space: Space::Body { sec }, para, prev_len } => {
            ("mergeParagraph", json!([sec, para]), json!({ "prevLen": prev_len }))
        }
    };
    rec.insert("m".into(), json!(m));
    rec.insert("a".into(), a);
    rec.insert("meta".into(), meta);
    if let Some(ctx) = template.get("ctx") {
        rec.insert("ctx".into(), ctx.clone());
    }
    Value::Object(rec)
}

/// 셀 공간 텍스트 연산을 기록으로(R13). 한 단계 칸이면 평면 형식, 중첩이면 경로 형식. 원래 기록이 같은 종류의
/// 조판 미룸 변형(`*DeferredPagination`)이면 그대로 잇는다.
fn emit_cell(op: &TOp, space: &Space, template: &Value) -> (&'static str, Value, Value) {
    let Space::Cell { sec, hosts, chain } = space else { unreachable!() };
    let tm = template.get("m").and_then(Value::as_str).unwrap_or("");
    let nested = chain.len() > 1 || tm.ends_with("ByPath");
    let deferred = tm.ends_with("DeferredPagination");
    // 범위 삭제(개체도 지울 수 있음)는 한 문단 안이 돼도 범위 삭제로 잇는다
    let range = matches!(op, TOp::Del { objects: true, .. });
    let _ = tm.starts_with("deleteRange");
    let (pp, (ci, cell)) = (hosts[0], chain[0]);
    match op {
        TOp::Ins { at, len, text, .. } if nested => ("insertTextInCellByPath", json!([sec, pp, space.path_json(at.para), at.off, text]), json!({ "len": len })),
        TOp::Ins { at, len, text, .. } => (
            if deferred && tm.starts_with("insertText") { "insertTextInCellDeferredPagination" } else { "insertTextInCell" },
            json!([sec, pp, ci, cell, at.para, at.off, text]),
            json!({ "len": len }),
        ),
        TOp::Del { from, to, .. } if from.para == to.para && nested && !range => (
            "deleteTextInCellByPath",
            json!([sec, pp, space.path_json(from.para), from.off, to.off - from.off]),
            json!({ "count": to.off - from.off }),
        ),
        TOp::Del { from, to, .. } if from.para == to.para && !range => (
            if deferred && tm.starts_with("deleteText") { "deleteTextInCellDeferredPagination" } else { "deleteTextInCell" },
            json!([sec, pp, ci, cell, from.para, from.off, to.off - from.off]),
            json!({ "count": to.off - from.off }),
        ),
        TOp::Del { from, to, .. } if nested => (
            "deleteRangeInCellByPath",
            json!([sec, pp, space.path_json(0), from.para, from.off, to.para, to.off]),
            json!({}),
        ),
        TOp::Del { from, to, .. } => ("deleteRangeInCell", json!([sec, pp, ci, cell, from.para, from.off, to.para, to.off]), json!({})),
        // 셀 바꾸기는 평면 조판 미룸 형식뿐이다(중첩 칸의 바꾸기는 기록되지 않는다).
        TOp::Replace { at, del, text, .. } => (
            "replaceTextInCellDeferredPagination",
            json!([sec, pp, ci, cell, at.para, at.off, del, text]),
            json!({ "deleted": del, "insLen": text.chars().count() }),
        ),
        TOp::Split { at, meta, .. } if nested => {
            ("splitParagraphInCellByPath", json!([sec, pp, space.path_json(at.para), at.off, meta.clone().unwrap_or(Value::Null)]), json!({}))
        }
        TOp::Split { at, meta, .. } => {
            ("splitParagraphInCell", json!([sec, pp, ci, cell, at.para, at.off, meta.clone().unwrap_or(Value::Null)]), json!({}))
        }
        TOp::Merge { para, prev_len, .. } if nested => ("mergeParagraphInCellByPath", json!([sec, pp, space.path_json(*para)]), json!({ "prevLen": prev_len })),
        TOp::Merge { para, prev_len, .. } => ("mergeParagraphInCell", json!([sec, pp, ci, cell, para]), json!({ "prevLen": prev_len })),
    }
}

// ── 기록끼리의 보정 (§4.5) ──────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Conc {
    Text,
    Neutral,
    Structural,
}

/// 기록 하나와 그 분류.
#[derive(Clone, Debug)]
struct Rec {
    json: Value,
    conc: Conc,
    state: bool,
    /// 영향 범위 구역. `None` 이면 문서 전체.
    section: Option<usize>,
    text: Option<TOp>,
    roles: Vec<Value>,
    /// 구조 연산의 발자국(R13). 없으면 구역 단위로 판정한다.
    foot: Option<Foot>,
}

/// 구조 연산의 발자국 (§4.6-2). 기준 문단 `anchor`(표 구조 연산은 + 개체 `control`)와 그 구역의 문단 수 변화
/// `pd`(기록 때 실측). 적용 전 좌표에서 기준 ~ 기준+max(-pd,0) 문단이 바뀌거나 사라지고, 그 뒤 문단은 `pd` 만큼
/// 밀린다. `para_arg` 는 기록 인자 안의 기준 문단 자리(옮길 때 고쳐 쓴다, 되돌림 기록은 없음).
#[derive(Clone, Debug, PartialEq)]
struct Foot {
    sec: usize,
    anchor: usize,
    control: Option<usize>,
    pd: i64,
    para_arg: Option<usize>,
}

impl Foot {
    fn end(&self) -> usize {
        self.anchor + (-self.pd).max(0) as usize
    }
    /// 문단 단위 발자국인가(개체 단위는 개체만 — 그 문단의 글자 편집은 겹치지 않는다).
    fn paragraph_level(&self) -> bool {
        self.control.is_none() || self.pd != 0
    }
    /// 발자국 밖 문단 번호를 이 연산 뒤로 옮긴다. 발자국 안이면 `None`.
    fn shift(&self, q: usize) -> Option<usize> {
        if q < self.anchor {
            Some(q)
        } else if q > self.end() {
            Some((q as i64 + self.pd).max(0) as usize)
        } else if !self.paragraph_level() && q == self.anchor {
            Some(q)
        } else {
            None
        }
    }
    /// 되돌림(이 연산을 버렸을 때 뒤 연산을 옮기는 지도): 만든 문단은 발자국, 그 뒤는 반대로 민다.
    fn inverse(&self) -> Foot {
        Foot { pd: -self.pd, para_arg: None, ..self.clone() }
    }
}

/// 구조 연산의 발자국을 분류표의 `anchor` 역할과 `meta.pd` 로 만든다.
fn foot_of(rec: &Value, info: &Value, a: &[Value], section: Option<usize>) -> Option<Foot> {
    let sec = section?;
    let pd = rec.get("meta")?.get("pd")?.as_i64()?;
    let role = info.get("roles")?.as_array()?.iter().find(|r| r.get("kind").and_then(Value::as_str) == Some("anchor"))?;
    let pi = role.get("arg")?.as_u64()? as usize;
    let control = role.get("control").and_then(Value::as_u64).and_then(|ci| num(a, ci as usize));
    Some(Foot { sec, anchor: num(a, pi)?, control, pd, para_arg: Some(pi) })
}

fn classify(rec: &Value, catalog: &Value) -> Rec {
    let state = rec.get("kind").and_then(Value::as_str) != Some("op");
    let m = rec.get("m").and_then(Value::as_str).unwrap_or("");
    // 4단계: 지도 전용 기록 — 구조 연산 발자국의 되돌림(`undo_map_json`). 분류표를 보지 않는다.
    if m == UNDO_FOOT {
        let a = rec.get("a").and_then(Value::as_array).cloned().unwrap_or_default();
        let pd = rec.get("meta").and_then(|x| x.get("pd")).and_then(Value::as_i64).unwrap_or(0);
        let foot = num(&a, 0).zip(num(&a, 1)).map(|(sec, anchor)| Foot { sec, anchor, control: num(&a, 2), pd, para_arg: None });
        return Rec { json: rec.clone(), conc: Conc::Structural, state: false, section: foot.as_ref().map(|f| f.sec), text: None, roles: vec![], foot };
    }
    let info = catalog.get(m).cloned().unwrap_or(Value::Null);
    let a = rec.get("a").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut conc = match info.get("conc").and_then(Value::as_str) {
        Some("text") => Conc::Text,
        Some("neutral") => Conc::Neutral,
        Some(_) => Conc::Structural,
        // 분류표 조각에 없는 이름: 보정이 만든 텍스트 기록일 수 있다(`emit_text` 는 deleteRange 를 쪼개 deleteText 를
        // 내는 등 입력에 없던 이름을 낸다). 텍스트 연산으로 읽히면 텍스트, 아니면 안전하게 구조.
        None if parse_text(rec).is_some() => Conc::Text,
        None => Conc::Structural,
    };
    let text = if conc == Conc::Text { parse_text(rec) } else { None };
    if conc == Conc::Text && text.is_none() {
        conc = Conc::Structural; // meta 가 없는 등 보정할 수 없는 텍스트 기록
    }
    let section = match &text {
        Some(t) => Some(t.space().sec()),
        None => info.get("section").and_then(Value::as_u64).and_then(|i| num(&a, i as usize)),
    };
    let roles = info.get("roles").and_then(Value::as_array).cloned().unwrap_or_default();
    let foot = if conc == Conc::Structural && !state { foot_of(rec, &info, &a, section) } else { None };
    Rec { json: rec.clone(), conc, state, section, text, roles, foot }
}

fn same_scope(a: Option<usize>, b: Option<usize>) -> bool {
    a.is_none() || b.is_none() || a == b
}

/// `ctx.activeField` 의 문단을 본문 연산 뒤로 옮긴다(anchor 규칙: 구조적으로 건드렸으면 충돌).
fn map_active_field(rec: &mut Value, b: &TOp) -> Result<(), Conflict> {
    let Space::Body { sec } = b.space() else { return Ok(()) };
    let Some(af) = rec.get_mut("ctx").and_then(|c| c.get_mut("activeField")) else { return Ok(()) };
    if af.is_null() || af.get("section").and_then(Value::as_u64) != Some(*sec as u64) {
        return Ok(());
    }
    let para = af.get("para").and_then(Value::as_u64).unwrap_or(0) as usize;
    match map_para(para, b) {
        ParaFate::Kept(q) => {
            af["para"] = json!(q);
            Ok(())
        }
        _ => conflict("누름틀이 든 문단이 구조적으로 바뀜"),
    }
}

/// neutral 기록의 roles 위치를 본문 연산 뒤로 옮긴다. 범위가 사라지면 `None`(버림).
fn map_roles(rec: &Rec, b: &TOp) -> Result<Option<Value>, Conflict> {
    let mut out = rec.json.clone();
    let Space::Body { sec } = b.space() else { return Ok(Some(out)) };
    if rec.section != Some(*sec) {
        return Ok(Some(out));
    }
    let args = out["a"].as_array().cloned().unwrap_or_default();
    let arg = |i: u64| num(&args, i as usize);
    for role in &rec.roles {
        let ix = |k: &str| role.get(k).and_then(Value::as_u64);
        match role.get("kind").and_then(Value::as_str) {
            Some("para") => {
                let i = ix("arg").unwrap_or(0);
                let Some(q) = arg(i) else { continue };
                match map_para(q, b) {
                    ParaFate::Kept(x) | ParaFate::Touched(x) => out["a"][i as usize] = json!(x),
                    ParaFate::Gone(_) => return Ok(None),
                }
            }
            Some("anchor") => {
                let i = ix("arg").unwrap_or(0);
                let Some(q) = arg(i) else { continue };
                match map_para(q, b) {
                    ParaFate::Kept(x) => out["a"][i as usize] = json!(x),
                    _ => return conflict("개체가 든 문단이 구조적으로 바뀜"),
                }
            }
            Some("range") => {
                let (pi, si, ei) = (ix("para").unwrap_or(0), ix("start").unwrap_or(0), ix("end").unwrap_or(0));
                let (Some(p), Some(s), Some(e)) = (arg(pi), arg(si), arg(ei)) else { continue };
                let s2 = map_pos(Pos::new(p, s), b, Bias::After).pos;
                let e2 = map_pos(Pos::new(p, e), b, Bias::Before).pos;
                if s2.para != e2.para {
                    return conflict("서식 범위가 두 문단으로 갈림");
                }
                if s2.off >= e2.off {
                    return Ok(None);
                }
                out["a"][pi as usize] = json!(s2.para);
                out["a"][si as usize] = json!(s2.off);
                out["a"][ei as usize] = json!(e2.off);
            }
            _ => {}
        }
    }
    Ok(Some(out))
}

/// 기록이 건드리는 자리(같은 구역 안). 발자국과 겹치는지 볼 때 쓴다.
#[derive(Debug)]
enum Touch {
    /// 본문 문단 lo~hi. `structural` 이면 문단을 나누거나 합치거나 지운다(개체 단위 발자국과도 겹침).
    Paras { lo: usize, hi: usize, structural: bool },
    /// 문단 `para` 의 개체 `ci` 안(셀 텍스트).
    Control { para: usize, ci: usize },
    /// 구역 전체(state, 발자국 없는 구조, 문단을 특정할 수 없는 neutral).
    Whole,
}

fn touches(x: &Rec) -> Vec<Touch> {
    if x.state {
        return vec![Touch::Whole];
    }
    if let Some(f) = &x.foot {
        return vec![if f.paragraph_level() {
            Touch::Paras { lo: f.anchor, hi: f.end(), structural: true }
        } else {
            Touch::Control { para: f.anchor, ci: f.control.unwrap_or(0) }
        }];
    }
    match (x.conc, &x.text) {
        (Conc::Text, Some(t)) => match t.space() {
            Space::Cell { hosts, chain, .. } => vec![Touch::Control { para: hosts[0], ci: chain[0].0 }],
            Space::Body { .. } => vec![match t {
                TOp::Ins { at, .. } | TOp::Replace { at, .. } => Touch::Paras { lo: at.para, hi: at.para, structural: false },
                TOp::Del { from, to, objects, .. } if from.para == to.para => Touch::Paras { lo: from.para, hi: from.para, structural: *objects },
                TOp::Del { from, to, .. } => Touch::Paras { lo: from.para, hi: to.para, structural: true },
                TOp::Split { at, .. } => Touch::Paras { lo: at.para, hi: at.para, structural: true },
                TOp::Merge { para, .. } => Touch::Paras { lo: para - 1, hi: *para, structural: true },
            }],
        },
        (Conc::Neutral, _) if !x.roles.is_empty() && x.section.is_some() => {
            let args = x.json["a"].as_array().cloned().unwrap_or_default();
            let mut out = Vec::new();
            for role in &x.roles {
                let ix = |k: &str| role.get(k).and_then(Value::as_u64).map(|v| v as usize);
                let (i, structural) = match role.get("kind").and_then(Value::as_str) {
                    Some("para") => (ix("arg"), false),
                    Some("range") => (ix("para"), false),
                    // 개체 역할(표·개체 속성 등)은 그 문단의 개체를 가리킨다 — 개체 단위 발자국과도 겹친다고 본다.
                    Some("anchor") => (ix("arg"), true),
                    _ => (None, false),
                };
                match i.and_then(|i| num(&args, i)) {
                    Some(q) => out.push(Touch::Paras { lo: q, hi: q, structural }),
                    None => return vec![Touch::Whole],
                }
            }
            out
        }
        _ => vec![Touch::Whole],
    }
}

fn overlaps(t: &Touch, f: &Foot) -> bool {
    match t {
        Touch::Whole => true,
        Touch::Paras { lo, hi, structural } => {
            if f.paragraph_level() {
                *lo <= f.end() && f.anchor <= *hi
            } else {
                *structural && *lo <= f.anchor && f.anchor <= *hi
            }
        }
        Touch::Control { para, ci } => {
            if f.paragraph_level() {
                f.anchor <= *para && *para <= f.end()
            } else {
                *para == f.anchor && Some(*ci) == f.control
            }
        }
    }
}

fn footprint_conflict<T>() -> Result<T, Conflict> {
    conflict("구조 변경 연산의 발자국과 겹침")
}

/// 본문 연산의 문단 번호를 발자국 밖에서 옮긴다(셀이면 바깥 표를 품은 본문 문단).
fn shift_top(t: &TOp, f: &Foot) -> Option<TOp> {
    if t.space().sec() != f.sec {
        return Some(t.clone());
    }
    let sp = |p: Pos| Some(Pos::new(f.shift(p.para)?, p.off));
    Some(match t {
        _ if matches!(t.space(), Space::Cell { .. }) => {
            let q = f.shift(t.space().body_para()?)?;
            t.clone().with_space(t.space().with_host(0, q))
        }
        TOp::Ins { space, at, len, text, logical } => TOp::Ins { space: space.clone(), at: sp(*at)?, len: *len, text: text.clone(), logical: *logical },
        TOp::Del { space, from, to, objects } => TOp::Del { space: space.clone(), from: sp(*from)?, to: sp(*to)?, objects: *objects },
        TOp::Replace { space, at, del, text } => TOp::Replace { space: space.clone(), at: sp(*at)?, del: *del, text: text.clone() },
        TOp::Split { space, at, meta } => TOp::Split { space: space.clone(), at: sp(*at)?, meta: meta.clone() },
        TOp::Merge { space, para, prev_len } => TOp::Merge { space: space.clone(), para: f.shift(*para)?, prev_len: *prev_len },
    })
}

fn shift_active_field(rec: &mut Value, f: &Foot) -> Result<(), Conflict> {
    let Some(af) = rec.get_mut("ctx").and_then(|c| c.get_mut("activeField")) else { return Ok(()) };
    if af.is_null() || af.get("section").and_then(Value::as_u64) != Some(f.sec as u64) {
        return Ok(());
    }
    let para = af.get("para").and_then(Value::as_u64).unwrap_or(0) as usize;
    match f.shift(para) {
        Some(q) => {
            af["para"] = json!(q);
            Ok(())
        }
        None => conflict("누름틀이 든 문단이 구조적으로 바뀜"),
    }
}

/// 발자국 `f` 밖의 기록을 그 구조 연산 뒤로 옮긴다(범용 지도).
fn shift_rec(x: &Rec, f: &Foot, catalog: &Value) -> Result<Rec, Conflict> {
    if x.section.is_some() && x.section != Some(f.sec) {
        return Ok(x.clone());
    }
    if let Some(fx) = &x.foot {
        let q = fx.shift_anchor_by(f).ok_or_else(|| Conflict("구조 변경 연산의 발자국과 겹침".into()))?;
        return Ok(with_anchor(x, q, catalog));
    }
    match (x.conc, &x.text) {
        (Conc::Text, Some(t)) => {
            let t2 = shift_top(t, f).ok_or_else(|| Conflict("구조 변경 연산의 발자국과 겹침".into()))?;
            let mut j = if x.json.is_null() { emit_text(&t2, &Value::Null) } else { emit_text(&t2, &x.json) };
            shift_active_field(&mut j, f)?;
            Ok(Rec { json: j.clone(), text: Some(t2), ..classify(&j, catalog) })
        }
        (Conc::Neutral, _) => {
            let mut out = x.json.clone();
            let args = out["a"].as_array().cloned().unwrap_or_default();
            for role in &x.roles {
                let i = match role.get("kind").and_then(Value::as_str) {
                    Some("para") | Some("anchor") => role.get("arg"),
                    Some("range") => role.get("para"),
                    _ => None,
                };
                let Some(i) = i.and_then(Value::as_u64).map(|v| v as usize) else { continue };
                let Some(q) = num(&args, i) else { continue };
                out["a"][i] = json!(f.shift(q).ok_or_else(|| Conflict("구조 변경 연산의 발자국과 겹침".into()))?);
            }
            shift_active_field(&mut out, f)?;
            Ok(classify(&out, catalog))
        }
        _ => Ok(x.clone()),
    }
}

impl Foot {
    fn shift_anchor_by(&self, other: &Foot) -> Option<usize> {
        if self.sec != other.sec {
            return Some(self.anchor);
        }
        other.shift(self.anchor)
    }
}

/// 구조 기록의 기준 문단을 바꾼 기록(되돌림 기록은 발자국만 바꾼다).
fn with_anchor(x: &Rec, q: usize, catalog: &Value) -> Rec {
    let fx = x.foot.as_ref().expect("발자국");
    match fx.para_arg {
        Some(pi) if !x.json.is_null() => {
            let mut j = x.json.clone();
            j["a"][pi] = json!(q);
            classify(&j, catalog)
        }
        _ => Rec { foot: Some(Foot { anchor: q, ..fx.clone() }), ..x.clone() },
    }
}

/// `x` 를 `y` 뒤로 옮긴다(둘은 같은 상태에서 출발). `side` 는 `x` 가 미확정(Second)인지 원격·되돌림(First)인지.
/// §4.5 를 §4.6 으로 바꾼 표: state 는 언제나 충돌, 발자국 없는 구조 연산은 구역 단위, 발자국이 있으면 겹칠 때만
/// 충돌하고 아니면 범용 지도로 옮긴다. 텍스트·neutral 끼리는 §4.4·§4.5 그대로.
fn transform_any(x: &Rec, y: &Rec, side: Side, catalog: &Value) -> Result<Vec<Rec>, Conflict> {
    if x.state || y.state {
        return conflict("결과 전송(state) 기록과 겹침");
    }
    if !same_scope(x.section, y.section) {
        return Ok(vec![x.clone()]);
    }
    let x_free = x.conc == Conc::Structural && x.foot.is_none();
    let y_free = y.conc == Conc::Structural && y.foot.is_none();
    if x_free {
        return conflict("같은 구역의 구조 변경 연산이 다른 편집과 겹침");
    }
    if y_free {
        return conflict("같은 구역의 구조 변경 연산과 겹침");
    }
    if let Some(fy) = &y.foot {
        if touches(x).iter().any(|t| overlaps(t, fy)) {
            return footprint_conflict();
        }
        if let Some(fx) = &x.foot {
            if touches(y).iter().any(|t| overlaps(t, fx)) {
                return footprint_conflict();
            }
        }
        return Ok(vec![shift_rec(x, fy, catalog)?]);
    }
    if let Some(fx) = &x.foot {
        if touches(y).iter().any(|t| overlaps(t, fx)) {
            return footprint_conflict();
        }
        // 본문 문단을 옮기는 것은 같은 구역 본문 텍스트 연산뿐이다(셀 안 편집은 본문 문단 번호를 바꾸지 않는다).
        return match (&y.text, y.conc) {
            (Some(b), Conc::Text) if matches!(b.space(), Space::Body { sec } if *sec == fx.sec) => match map_para(fx.anchor, b) {
                ParaFate::Kept(q) => Ok(vec![with_anchor(x, q, catalog)]),
                _ => footprint_conflict(),
            },
            _ => Ok(vec![x.clone()]),
        };
    }
    match (x.conc, y.conc) {
        (Conc::Text, Conc::Text) => {
            let (a, b) = (x.text.as_ref().unwrap(), y.text.as_ref().unwrap());
            let mut out = Vec::new();
            for t in transform_text(a, b, side)? {
                let mut j = if x.json.is_null() { emit_text(&t, &Value::Null) } else { emit_text(&t, &x.json) };
                map_active_field(&mut j, b)?;
                out.push(Rec { text: Some(t), ..classify(&j, catalog) });
            }
            Ok(out)
        }
        (Conc::Neutral, Conc::Text) => {
            let b = y.text.as_ref().unwrap();
            match map_roles(x, b)? {
                None => Ok(vec![]),
                Some(mut j) => {
                    map_active_field(&mut j, b)?;
                    Ok(vec![classify(&j, catalog)])
                }
            }
        }
        _ => Ok(vec![x.clone()]),
    }
}

/// 미확정 `p` 를 원격 `r` 뒤로 옮긴다.
fn transform_rec(p: &Rec, r: &Rec, catalog: &Value) -> Result<Vec<Rec>, Conflict> {
    transform_any(p, r, Side::Second, catalog)
}

/// 버린 미확정의 되돌림(뒤 연산을 옮기는 지도). `None` 이면 되돌릴 수 없다(state·발자국 없는 구조·여러 문단
/// 삭제) — 그 뒤는 모두 버린다. 빈 목록이면 위치에 영향이 없다(neutral).
fn inverse(p: &Rec) -> Option<Vec<Rec>> {
    if p.state {
        return None;
    }
    match p.conc {
        Conc::Neutral => Some(vec![]),
        Conc::Structural => p.foot.as_ref().map(|f| {
            vec![Rec { json: Value::Null, conc: Conc::Structural, state: false, section: Some(f.sec), text: None, roles: vec![], foot: Some(f.inverse()) }]
        }),
        Conc::Text => {
            let t = p.text.as_ref()?;
            let fill = |n: usize| "\u{fffc}".repeat(n);
            let it = match t {
                TOp::Ins { space, at, len, .. } => TOp::Del { space: space.clone(), from: *at, to: Pos::new(at.para, at.off + len), objects: false },
                TOp::Del { space, from, to, .. } if from.para == to.para => {
                    let n = to.off - from.off;
                    TOp::Ins { space: space.clone(), at: *from, len: n, text: fill(n), logical: None }
                }
                TOp::Del { .. } => return None,
                TOp::Replace { space, at, del, text } => TOp::Replace { space: space.clone(), at: *at, del: text.chars().count(), text: fill(*del) },
                TOp::Split { space, at, .. } => TOp::Merge { space: space.clone(), para: at.para + 1, prev_len: at.off },
                TOp::Merge { space, para, prev_len } => TOp::Split { space: space.clone(), at: Pos::new(para - 1, *prev_len), meta: None },
            };
            Some(vec![Rec { json: Value::Null, conc: Conc::Text, state: false, section: Some(it.space().sec()), text: Some(it), roles: vec![], foot: None }])
        }
    }
}

/// 보정 방식. `Rebase` 는 되감기 재적용용(원격 쪽 결과 R' 는 다음 미확정과 캐럿을 옮기는 데만 쓴다).
/// `Fast` 는 R11 빠른 경로용: R' 를 **지금 문서에 바로 적용**하므로 R' 를 완전히 계산하고, 두 순서의 결과가
/// 같다(TP1)고 보장할 수 없는 쌍은 막는다(`Conflict` → 되감기 경로).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Rebase,
    Fast,
}

fn fast_block<T>(why: &str) -> Result<T, Conflict> {
    Err(Conflict(format!("빠른 경로 불가: {why}")))
}

/// R11: 기록이 고치는 본문 문단 범위(그 기록이 만들어진 상태의 번호). 셀 연산은 표를 품은 본문 문단.
/// neutral 은 역할(para·anchor·range)의 문단. 문단을 특정할 수 없으면 `None`(문서·구역 전체로 본다).
/// 문단 수를 바꾸는 연산(나눔·합침·여러 문단 삭제)과 셀 연산은 뒤 문단 전체로 본다(`usize::MAX` 까지) —
/// 아래 `fast_check_disjoint` 참고.
fn touched_paras(rec: &Rec) -> Option<(usize, usize, usize)> {
    if let Some(t) = &rec.text {
        let (sec, a, b) = match (t, t.space()) {
            (_, Space::Cell { sec, hosts, .. }) => (*sec, hosts[0], usize::MAX),
            (TOp::Ins { at, .. } | TOp::Replace { at, .. }, Space::Body { sec }) => (*sec, at.para, at.para),
            (TOp::Split { at, .. }, Space::Body { sec }) => (*sec, at.para, usize::MAX),
            (TOp::Del { from, to, objects: false, .. }, Space::Body { sec }) if from.para == to.para => (*sec, from.para, from.para),
            (TOp::Del { from, .. }, Space::Body { sec }) => (*sec, from.para, usize::MAX),
            (TOp::Merge { para, .. }, Space::Body { sec }) => (*sec, para - 1, usize::MAX),
        };
        return Some((sec, a, b));
    }
    let sec = rec.section?;
    let args = rec.json["a"].as_array().cloned().unwrap_or_default();
    let mut range: Option<(usize, usize)> = None;
    for role in &rec.roles {
        let i = match role.get("kind").and_then(Value::as_str) {
            Some("para") | Some("anchor") => role.get("arg"),
            Some("range") => role.get("para"),
            _ => None,
        };
        let q = num(&args, i.and_then(Value::as_u64)? as usize)?;
        range = Some(match range {
            None => (q, q),
            Some((a, b)) => (a.min(q), b.max(q)),
        });
    }
    let (a, b) = range?;
    Some((sec, a, b))
}

/// R11 빠른 경로의 조건: 두 기록이 서로 다른 문단만 고친다(문단이 겹치지 않음).
///
/// rhwp 의 편집 기능은 문단 모델에 편집 이력에 따른 흔적을 남긴다 — 글자 끝을 넘는 글자 모양 구간,
/// 비운 문단이 지닌 글자 모양, `has_para_text`, 문단 머리의 여분 바이트 등. 같은 문단을 두 순서로
/// 고치면 글자가 같아도 모델이 달라지고(R11 관문 진단, §10), 그 흔적은 뒤 입력의 모양을 바꾸므로
/// digest 에서 뺄 수도 없다. 다른 문단끼리는 각 문단이 자기 편집만 받고 번호만 밀리므로 순서와 무관하다.
///
/// 단 뒤 문단의 줄 세로 위치(`line_segs[].vertical_pos`)는 문단을 넘는 조판 캐시다. 편집마다 자기 문단부터
/// 구역 끝까지 다시 계산하는데(`recalculate_section_vpos`), 이 계산은 저장된 값을 보고 원본의 쪽 경계 등을
/// 보존하므로 문단 모델만의 함수가 아니다. 문단 수를 바꾸는 편집이 뒤 문단 편집과 순서를 바꾸면 뒤 문단의
/// 세로 위치가 달라진다(R5 재검증에서 발견, §10). 그래서 문단 수를 바꾸는 편집과 셀 편집(표 높이)은
/// 자기 문단부터 구역 끝까지를 고치는 것으로 본다.
fn fast_check_disjoint(x: &Rec, y: &Rec) -> Result<(), Conflict> {
    let (Some((sx, a1, b1)), Some((sy, a2, b2))) = (touched_paras(x), touched_paras(y)) else {
        return fast_block("문단을 특정할 수 없는 기록");
    };
    if sx == sy && a1 <= b2 && a2 <= b1 {
        return fast_block("같은 문단 동시 편집");
    }
    Ok(())
}

/// 원격 `r` 을 미확정 `p` 뒤로 옮긴다.
/// - `Rebase`: 다음 미확정 연산과 캐럿을 옮기는 데만 쓴다. 텍스트끼리만 움직인다.
/// - `Fast`: 지금 문서(미확정이 이미 적용됨)에 그대로 적용할 R'. 순서에 민감한 쌍은 막는다.
fn transform_remote(r: &Rec, p: &Rec, catalog: &Value, mode: Mode) -> Result<Vec<Rec>, Conflict> {
    if mode == Mode::Rebase {
        // 원격(또는 되돌림)을 남긴 미확정 뒤로 — 다음 미확정과 캐럿을 옮기는 데만 쓴다. 옮길 수 없으면 그대로 둔다
        // (그 미확정은 이미 이 원격과 충돌 없이 통과했다. 수렴은 되감기가 보장한다).
        return Ok(transform_any(r, p, Side::First, catalog).unwrap_or_else(|_| vec![r.clone()]));
    }
    if r.state || p.state || r.conc == Conc::Structural || p.conc == Conc::Structural {
        return fast_block("텍스트·neutral 외 기록");
    }
    match (r.conc, p.conc) {
        // 서식끼리는 구역이 달라도 문서 모양 목록(글자·문단 모양)에 새 항목이 생기는 순서가 달라진다.
        (Conc::Neutral, Conc::Neutral) => fast_block("서식끼리 동시"),
        _ => {
            fast_check_disjoint(r, p)?;
            match (r.conc, p.conc) {
                _ if !same_scope(r.section, p.section) => Ok(vec![r.clone()]),
                (Conc::Text, Conc::Text) => {
                    let (b, a) = (r.text.as_ref().unwrap(), p.text.as_ref().unwrap());
                    let mut out = Vec::new();
                    for t in transform_text(b, a, Side::First)? {
                        let mut j = emit_text(&t, &r.json);
                        map_active_field(&mut j, a)?;
                        out.push(classify(&j, catalog));
                    }
                    Ok(out)
                }
                (Conc::Neutral, Conc::Text) => {
                    let a = p.text.as_ref().unwrap();
                    match map_roles(r, a)? {
                        None => fast_block("서식 범위가 사라짐"),
                        Some(mut j) => {
                            map_active_field(&mut j, a)?;
                            Ok(vec![classify(&j, catalog)])
                        }
                    }
                }
                (Conc::Text, Conc::Neutral) => Ok(vec![r.clone()]),
                _ => fast_block("텍스트·neutral 외 기록"),
            }
        }
    }
}

/// 같은 상태에서 출발한 두 열의 보정. 반환: (pending 을 remote 뒤로, remote 를 pending 뒤로).
/// 어느 방향이든 보정할 수 없으면 충돌(`Rebase` 면 미확정 쪽을 버리고, `Fast` 면 되감기 경로로 간다).
fn xform(p: &[Rec], r: &[Rec], catalog: &Value, mode: Mode) -> Result<(Vec<Rec>, Vec<Rec>), Conflict> {
    if p.is_empty() || r.is_empty() {
        return Ok((p.to_vec(), r.to_vec()));
    }
    if p.len() == 1 && r.len() == 1 {
        return Ok((transform_rec(&p[0], &r[0], catalog)?, transform_remote(&r[0], &p[0], catalog, mode)?));
    }
    if p.len() > 1 {
        let (p1, r1) = xform(&p[..1], r, catalog, mode)?;
        let (p2, r2) = xform(&p[1..], &r1, catalog, mode)?;
        return Ok(([p1, p2].concat(), r2));
    }
    let (p1, r1) = xform(p, &r[..1], catalog, mode)?;
    let (p2, r2) = xform(&p1, &r[1..], catalog, mode)?;
    Ok((p2, [r1, r2].concat()))
}

/// 캐럿(텍스트 좌표)을 원격 열 뒤로 옮긴다. 원격 삽입이 캐럿 자리에 오면 캐럿은 앞에 남는다(Before) —
/// 각자 친 글자가 이어지게 하기 위해서다.
fn map_caret(caret: &Value, remote: &[Rec]) -> Value {
    let mut c = caret.clone();
    if c.is_null() {
        return c;
    }
    let g = |c: &Value, k: &str| c.get(k).and_then(Value::as_u64).map(|v| v as usize);
    for r in remote {
        if let (Some(f), Some(sec), Some(p)) = (&r.foot, g(&c, "section"), g(&c, "para")) {
            if f.sec == sec {
                if let Some(q) = f.shift(p) {
                    c["para"] = json!(q);
                }
            }
            continue;
        }
        let Some(b) = &r.text else { continue };
        let Some(sec) = g(&c, "section") else { break };
        let cell = c.get("cell").cloned().filter(|v| !v.is_null());
        match (b.space(), cell) {
            (Space::Body { sec: bs }, None) if *bs == sec => {
                let (Some(p), Some(o)) = (g(&c, "para"), g(&c, "offset")) else { break };
                let m = map_pos(Pos::new(p, o), b, Bias::Before).pos;
                c["para"] = json!(m.para);
                c["offset"] = json!(m.off);
            }
            (Space::Body { sec: bs }, Some(_)) if *bs == sec => {
                let Some(p) = g(&c, "para") else { break };
                let q = match map_para(p, b) {
                    ParaFate::Kept(q) | ParaFate::Touched(q) | ParaFate::Gone(q) => q,
                };
                c["para"] = json!(q);
            }
            (Space::Cell { sec: bs, hosts, chain }, Some(cv)) if *bs == sec && chain.len() == 1 => {
                let (pp, (ci, ce)) = (&hosts[0], &chain[0]);
                let same = g(&c, "para") == Some(*pp)
                    && cv.get("control").and_then(Value::as_u64) == Some(*ci as u64)
                    && cv.get("cell").and_then(Value::as_u64) == Some(*ce as u64);
                if same {
                    let (Some(cp), Some(o)) = (g(&cv, "cellPara"), g(&c, "offset")) else { break };
                    let m = map_pos(Pos::new(cp, o), b, Bias::Before).pos;
                    c["cell"]["cellPara"] = json!(m.para);
                    c["offset"] = json!(m.off);
                }
            }
            _ => {}
        }
    }
    c
}

/// 되감기 재적용용 보정 (§5 receiveRemote 2·3).
///
/// - `pending`: 미확정 기록 열 (같은 확정 상태에서 출발)
/// - `remote`: 원격 기록 열 (같은 확정 상태에서 출발, 서버 순서)
/// - `catalog`: `{메서드: {conc, section, roles}}` — 분류표의 해당 부분
/// - `caret`: `{section, para, offset, cell?: {control, cell, cellPara}}` (텍스트 좌표) 또는 `null`
///
/// 반환 `{"pending": [..], "dropFrom": i|null, "dropReason": ".."|null, "caret": {..}|null,
///        "fastRemote": [..]|null, "fastBlock": ".."|null}`.
/// `dropFrom` 이 있으면 `pending[dropFrom..]` 을 버렸다(충돌한 연산과 그 뒤는 그 위에서 만들어졌으므로).
/// `fastRemote` 가 있으면 R11 빠른 경로를 쓸 수 있다: 지금 문서(확정 + 미확정)에 `fastRemote` 를 적용한 결과가
/// 되감기 경로(확정 + 원격 + `pending`)와 같다. 없으면 `fastBlock` 이 이유다.
pub fn rebase(pending: &[Value], remote: &[Value], catalog: &Value, caret: &Value) -> Value {
    let all_p: Vec<Rec> = pending.iter().map(|p| classify(p, catalog)).collect();
    let all_r: Vec<Rec> = remote.iter().map(|r| classify(r, catalog)).collect();
    let (fast_remote, fast_block_why) = match xform(&all_p, &all_r, catalog, Mode::Fast) {
        Ok((_, r2)) => (Value::Array(r2.into_iter().map(|r| r.json).collect()), Value::Null),
        Err(Conflict(why)) => (Value::Null, json!(why)),
    };
    let mut rs: Vec<Rec> = all_r;
    let mut out: Vec<Value> = Vec::new();
    // 4단계: 보정된 미확정 각각이 원래 몇 번째 미확정에서 왔는가(한 기록이 여럿으로 쪼개질 수 있다).
    let mut origin: Vec<usize> = Vec::new();
    let mut dropped: Vec<usize> = Vec::new();
    let mut reasons: Vec<String> = Vec::new();
    // 버린 미확정의 되돌림 열(지금 원래 좌표 F_i 기준, 앞에서부터 적용). F_i + undo = 확정 + 남긴 미확정.
    let mut undo: Vec<Rec> = Vec::new();
    // 되돌릴 수 없는 것을 버렸으면 그 뒤는 모두 버린다.
    let mut dead = false;
    for (i, p) in all_p.iter().enumerate() {
        if dead {
            dropped.push(i);
            continue;
        }
        let step = xform(std::slice::from_ref(p), &undo, catalog, Mode::Rebase).and_then(|(ps, undo_after)| {
            let (ps2, rs2) = xform(&ps, &rs, catalog, Mode::Rebase)?;
            Ok((ps2, rs2, undo_after))
        });
        match step {
            Ok((ps, rs2, undo_after)) => {
                origin.extend(std::iter::repeat_n(i, ps.len()));
                out.extend(ps.into_iter().map(|r| r.json));
                rs = rs2;
                undo = undo_after;
            }
            Err(Conflict(why)) => {
                dropped.push(i);
                reasons.push(why);
                // F_{i+1} = F_i + p. 버린 p 를 되돌린 뒤 앞의 되돌림을 잇는다.
                match inverse(p) {
                    Some(inv) => undo = [inv, undo].concat(),
                    None => dead = true,
                }
            }
        }
    }
    let first_reason = reasons.first().cloned().map(Value::String).unwrap_or(Value::Null);
    let (fast_remote, fast_block_why) = if dropped.is_empty() { (fast_remote, fast_block_why) } else { (Value::Null, json!("충돌")) };
    let caret = map_caret(caret, &rs);
    json!({
        // 4단계: 버린 미확정의 되돌림 열(지금 문서 좌표 F_n 기준, 앞에서부터) — `remoteAfter` 앞에 붙이면 지금 문서
        // 좌표를 새 좌표로 옮기는 지도가 된다. 되돌릴 수 없는 것(state 등)을 버렸으면 `dropUndoComplete` 가 false.
        "dropUndo": undo.iter().filter_map(undo_map_json).collect::<Vec<_>>(), "dropUndoComplete": !dead,
        "pending": out, "origin": origin,
        "dropped": dropped, "dropReasons": reasons,
        "dropFrom": dropped.first().copied().map(Value::from).unwrap_or(Value::Null), "dropReason": first_reason,
        "caret": caret,
        // 4단계: 원격을 남긴 미확정 뒤로 옮긴 열 — 지금 문서 좌표의 위치(되돌리기 스택)를 옮기는 지도. 캐럿과 같다.
        "remoteAfter": rs.into_iter().map(|r| r.json).collect::<Vec<_>>(),
        "fastRemote": fast_remote, "fastBlock": fast_block_why,
    })
}

/// 지도 전용 기록 이름(구조 연산 발자국의 되돌림). 문서에 적용하지 않는다 — `map_positions` 만 읽는다.
const UNDO_FOOT: &str = "__undoFoot";

/// 되돌림 열의 기록 하나를 지도로 쓸 JSON 으로. 되돌림 기록은 내부 값이라 `json` 이 비어 있을 수 있다:
/// 글자 연산은 기록 형태로 다시 쓰고, 구조 발자국은 지도 전용 기록(`UNDO_FOOT`)으로 쓴다.
fn undo_map_json(r: &Rec) -> Option<Value> {
    if let Some(t) = &r.text {
        return Some(if r.json.is_null() { emit_text(t, &Value::Null) } else { r.json.clone() });
    }
    if let Some(f) = &r.foot {
        return Some(json!({ "kind": "op", "m": UNDO_FOOT, "a": [f.sec, f.anchor, f.control], "meta": { "pd": f.pd } }));
    }
    (!r.json.is_null()).then(|| r.json.clone())
}

/// 미확정이 없을 때 원격 열의 지도로 캐럿만 옮긴다(§5 receiveRemote 1).
pub fn map_caret_through(remote: &[Value], catalog: &Value, caret: &Value) -> Value {
    let rs: Vec<Rec> = remote.iter().map(|r| classify(r, catalog)).collect();
    map_caret(caret, &rs)
}

// ── 되돌리기 보조 (4단계 U1·U2, docs/collab-stage4.md §3·§5) ─────────────────────────────────────

/// 위치의 범위. `Section` 은 구역 안 어딘가(문단으로 특정할 수 없음), `SectionAll` 은 "그 구역의 어떤 기록이든"
/// — 구역 원본 저널(`captureSectionRaw` ↔ `restoreSectionRaw`)에 기대는 되돌리기의 지킴(캡처와 복원 사이 그 구역 편집
/// 금지가 저널 계약이다). 글자 연산은 `Section` 에 닿지 않지만 `SectionAll` 에는 닿는다.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Scope {
    Para,
    Section,
    SectionAll,
}

/// 되돌리기 스택이 기억하는 위치 하나(텍스트 좌표).
/// - 본문: `para`·`off`.
/// - 셀(중첩 포함, U2): `path[k]` = k 단계 (개체, 칸, 칸 문단), `para` 는 바깥 표를 품은 본문 문단. 위치는 가장 안쪽
///   칸의 (칸 문단 = `path[last].2`, `off`). 바깥 단계의 칸 문단(`path[k].2`, k < last)은 다음 단계 표를 품은 문단이다.
/// - 구역 단위(`scope`, U2): 본문 문단으로 특정할 수 없는 자리(머리말·꼬리말 안, 구역 정의 등). 글자 연산은 닿지 않고
///   같은 구역의 구조 편집·결과 전송·문단을 특정할 수 없는 서식이 닿는다.
#[derive(Clone, Debug, PartialEq)]
struct Item {
    sec: usize,
    para: usize,
    off: usize,
    path: Vec<(usize, usize, usize)>,
    scope: Scope,
    bias: Bias,
    /// 남의 기록이 이 자리에 닿았는가 — 첫 사유만 남긴다(`touched` 같은 문단 편집, `gone` 문단이 지워짐,
    /// `structural` 같은 구역의 구조 편집, `whole` 문서 전체 결과).
    hit: Option<&'static str>,
}

impl Item {
    fn parse(v: &Value) -> Option<Item> {
        let g = |o: &Value, k: &str| o.get(k).and_then(Value::as_u64).map(|x| x as usize);
        let step = |c: &Value| Some((g(c, "control")?, g(c, "cell")?, g(c, "cellPara")?));
        let path: Vec<(usize, usize, usize)> = match (v.get("cellPath"), v.get("cell")) {
            (Some(Value::Array(steps)), _) if !steps.is_empty() => steps.iter().map(step).collect::<Option<Vec<_>>>()?,
            (_, Some(c)) if !c.is_null() => vec![step(c)?],
            _ => vec![],
        };
        let scope = match v.get("scope").and_then(Value::as_str) {
            Some("section") => Scope::Section,
            Some("sectionAll") => Scope::SectionAll,
            _ => Scope::Para,
        };
        let bias = if v.get("bias").and_then(Value::as_str) == Some("before") { Bias::Before } else { Bias::After };
        Some(Item {
            sec: g(v, "section")?,
            para: if scope == Scope::Para { g(v, "para")? } else { g(v, "para").unwrap_or(0) },
            off: g(v, "offset").unwrap_or(0),
            path,
            scope,
            bias,
            hit: None,
        })
    }

    fn json(&self) -> Value {
        let step = |&(ci, cell, cp): &(usize, usize, usize)| json!({ "control": ci, "cell": cell, "cellPara": cp });
        let mut v = json!({
            "section": self.sec, "para": self.para, "offset": self.off,
            // 한 단계 셀은 `cell` 로도(U1 호환), 모든 깊이는 `cellPath`
            "cell": if self.path.len() == 1 { step(&self.path[0]) } else { Value::Null },
            "cellPath": if self.path.is_empty() { Value::Null } else { Value::Array(self.path.iter().map(step).collect()) },
            "bias": if self.bias == Bias::Before { "before" } else { "after" },
            "hit": self.hit,
        });
        match self.scope {
            Scope::Para => {}
            Scope::Section => v["scope"] = json!("section"),
            Scope::SectionAll => v["scope"] = json!("sectionAll"),
        }
        v
    }

    fn mark(&mut self, why: &'static str) {
        if self.hit.is_none() {
            self.hit = Some(why);
        }
    }

    /// 셀 공간(`hosts`, `chain`)과 이 위치의 단계가 앞쪽부터 맞는 단계 수. 어긋나면 `None`.
    fn agree(&self, hosts: &[usize], chain: &[(usize, usize)]) -> Option<usize> {
        if self.path.is_empty() || hosts.first() != Some(&self.para) {
            return None;
        }
        let common = chain.len().min(self.path.len());
        for k in 0..common {
            if chain[k] != (self.path[k].0, self.path[k].1) || (k >= 1 && hosts.get(k) != Some(&self.path[k - 1].2)) {
                return None;
            }
        }
        Some(common)
    }
}

/// 문단 `q` 를 글자 편집 `t` 가 고치는가(나눔·합침·지움만이 아니라 그 문단 안의 입력·삭제도).
fn text_touches_para(t: &TOp, q: usize) -> bool {
    match t {
        TOp::Ins { at, .. } | TOp::Replace { at, .. } | TOp::Split { at, .. } => at.para == q,
        TOp::Del { from, to, .. } => from.para <= q && q <= to.para,
        TOp::Merge { para, .. } => q + 1 == *para || q == *para,
    }
}

/// 셀 안 기록(글자 모양·문단 모양·개체 속성 등 neutral 포함)의 칸 공간과 칸 문단 — 평면(`sec,pp,ci,cell,cp,…`)·경로
/// (`sec,pp,path_json,…`) 형식. 이름에 `InCell` 이 없고 셀 안 개체 속성도 아니면 `None`.
fn cell_space_of(m: &str, a: &[Value]) -> Option<(Space, usize)> {
    if let Some(t) = cell_target(m, a) {
        return Some(t);
    }
    let by_path = a.get(2).and_then(Value::as_str).is_some();
    // 셀 안 개체 속성(`setCell{Shape,Picture}PropertiesByPath`): 개체를 품은 칸 문단
    if m.ends_with("PropertiesByPath") && by_path {
        return cell_target("insertTextInCellByPath", a);
    }
    if !m.contains("InCell") {
        return None;
    }
    if by_path {
        cell_target("insertTextInCellByPath", a)
    } else {
        cell_target("insertTextInCell", a)
    }
}

/// 같은 공간의 문단 `q`·글자 `off` 를 글자 연산 `t` 뒤로 옮기며 닿았는지 표시한다. 새 (문단, 글자).
fn map_in_space(it: &mut Item, q: usize, t: &TOp) -> Pos {
    match map_para(q, t) {
        ParaFate::Gone(_) => it.mark("gone"),
        ParaFate::Touched(_) => it.mark("touched"),
        ParaFate::Kept(_) if text_touches_para(t, q) => it.mark("touched"),
        ParaFate::Kept(_) => {}
    }
    map_pos(Pos::new(q, it.off), t, it.bias).pos
}

/// 문단 번호(내용과 무관한 자리)를 글자 연산 뒤로 옮긴다 — 구조적으로 바뀌면 표시.
fn map_host(it: &mut Item, q: usize, t: &TOp) -> usize {
    match map_para(q, t) {
        ParaFate::Kept(x) => x,
        ParaFate::Touched(x) => {
            it.mark("touched");
            x
        }
        ParaFate::Gone(x) => {
            it.mark("gone");
            x
        }
    }
}

fn map_item_text(it: &mut Item, t: &TOp) {
    match t.space() {
        Space::Body { .. } if it.path.is_empty() => {
            let m = map_in_space(it, it.para, t);
            it.para = m.para;
            it.off = m.off;
        }
        // 본문 편집이 표를 품은 문단을 옮기거나 구조적으로 바꿈(그 문단 안 글자 입력은 칸과 무관)
        Space::Body { .. } => it.para = map_host(it, it.para, t),
        Space::Cell { .. } if it.path.is_empty() => {}
        Space::Cell { hosts, chain, .. } => {
            if it.agree(hosts, chain).is_none() {
                return;
            }
            let (m, n) = (chain.len(), it.path.len());
            if m == n {
                // 같은 칸(가장 안쪽)
                let q = it.path[n - 1].2;
                let p = map_in_space(it, q, t);
                it.path[n - 1].2 = p.para;
                it.off = p.off;
            } else if m < n {
                // 바깥 칸의 편집: 그 칸에서 다음 단계 표를 품은 문단(path[m-1].2)을 옮긴다
                let q = it.path[m - 1].2;
                it.path[m - 1].2 = map_host(it, q, t);
            } else if hosts.get(n) == Some(&it.path[n - 1].2) {
                // 내 칸 문단 안의 중첩 표를 고침
                it.mark("touched");
            }
        }
    }
}

/// 위치 하나를 기록 하나 뒤로 옮기고, 그 기록이 위치에 닿았으면 표시한다.
fn map_item(it: &mut Item, r: &Rec) {
    if r.state {
        it.mark("whole");
        return;
    }
    if it.scope == Scope::SectionAll {
        let sec = r.text.as_ref().map(|t| Some(t.space().sec())).unwrap_or(r.section);
        if same_scope(sec, Some(it.sec)) {
            it.mark("section");
        }
        return;
    }
    if let Some(t) = &r.text {
        if t.space().sec() == it.sec && it.scope == Scope::Para {
            map_item_text(it, t);
        }
        return;
    }
    if !same_scope(r.section, Some(it.sec)) {
        return;
    }
    match r.conc {
        Conc::Structural => {
            it.mark("structural");
            if let Some(f) = r.foot.as_ref().filter(|_| it.scope == Scope::Para) {
                if let Some(q) = f.shift(it.para) {
                    it.para = q;
                }
            }
        }
        Conc::Neutral => {
            let args = r.json["a"].as_array().cloned().unwrap_or_default();
            let m = r.json["m"].as_str().unwrap_or("");
            if it.scope == Scope::Section {
                // 구역 단위 자리: 문단을 특정할 수 없는 서식(구역 정의·쪽 설정 등)만 닿는다
                if cell_space_of(m, &args).is_none() && touches(r).iter().any(|t| matches!(t, Touch::Whole)) {
                    it.mark("touched");
                }
                return;
            }
            if let Some((space, cp)) = cell_space_of(m, &args) {
                // 셀 안 서식: 같은 칸 문단, 또는 내 칸 문단 안의 중첩 표
                if let Space::Cell { hosts, chain, .. } = &space {
                    if it.agree(hosts, chain).is_some() {
                        let (mm, n) = (chain.len(), it.path.len());
                        if (mm == n && cp == it.path[n - 1].2) || (mm > n && hosts.get(n) == Some(&it.path[n - 1].2)) {
                            it.mark("touched");
                        }
                    }
                }
                return;
            }
            for t in touches(r) {
                match t {
                    Touch::Whole => it.mark("touched"),
                    Touch::Paras { lo, hi, .. } if it.path.is_empty() && lo <= it.para && it.para <= hi => it.mark("touched"),
                    _ => {}
                }
            }
        }
        Conc::Text => it.mark("structural"), // 글자 연산으로 읽히지 않은 글자 기록 — 안전하게
    }
}

/// 되돌리기 스택의 위치들을 기록 열(지금 문서 좌표, 순서대로) 뒤로 옮긴다. 원격 열이면 `hit` 이 막힘 판정
/// (3.2-1·3.2-2)의 재료다. 자기 로컬 기록으로 옮길 때는 호스트가 `hit` 을 무시한다.
pub fn map_positions(recs: &[Value], catalog: &Value, items: &[Value]) -> Value {
    let rs: Vec<Rec> = recs.iter().map(|r| classify(r, catalog)).collect();
    Value::Array(
        items
            .iter()
            .map(|v| match Item::parse(v) {
                Some(mut it) => {
                    for r in &rs {
                        map_item(&mut it, r);
                    }
                    it.json()
                }
                None => Value::Null,
            })
            .collect(),
    )
}

/// 명령이 만든 기록 열(순서대로)의 발자국 — 기록이 끝난 문서 좌표에서 고친 자리들. 문단으로 특정할 수 없지만 구역은
/// 아는 기록(발자국 없는 구조, 역할 없는 neutral — 머리말·꼬리말 안 편집, 구역 정의 등)은 구역 단위 자리(U2),
/// 구역도 모르면(`state`, 문서 전체 neutral) `whole`. `nested` 는 U1 호환으로 남는다(언제나 false — U2 에서 중첩 셀을
/// 경로로 다룬다).
pub fn footprint(entries: &[Value], catalog: &Value) -> Value {
    let mut items: Vec<Item> = Vec::new();
    let mut whole = false;
    let para_item = |sec: usize, para: usize| Item { sec, para, off: 0, path: vec![], scope: Scope::Para, bias: Bias::After, hit: None };
    let section_item = |sec: usize| Item { scope: Scope::Section, ..para_item(sec, 0) };
    for e in entries {
        let r = classify(e, catalog);
        // 앞 기록의 발자국을 이 기록 뒤로 옮긴다(지워진 문단은 뺀다)
        items = items
            .into_iter()
            .filter_map(|mut it| {
                map_item(&mut it, &r);
                (it.hit != Some("gone")).then_some(Item { hit: None, ..it })
            })
            .collect();
        let add = |items: &mut Vec<Item>, sec: usize, space: &Space, paras: &[usize]| match space {
            Space::Body { .. } => items.extend(paras.iter().map(|&p| para_item(sec, p))),
            Space::Cell { hosts, chain, .. } => items.extend(paras.iter().map(|&p| {
                let path = chain
                    .iter()
                    .enumerate()
                    .map(|(k, &(ci, cell))| (ci, cell, if k + 1 < chain.len() { hosts[k + 1] } else { p }))
                    .collect();
                Item { path, ..para_item(sec, hosts[0]) }
            })),
        };
        if r.state {
            whole = true;
            continue;
        }
        if let Some(t) = &r.text {
            let paras: Vec<usize> = match t {
                TOp::Ins { at, .. } | TOp::Replace { at, .. } => vec![at.para],
                TOp::Del { from, .. } => vec![from.para],
                TOp::Split { at, .. } => vec![at.para, at.para + 1],
                TOp::Merge { para, .. } => vec![para - 1],
            };
            add(&mut items, t.space().sec(), t.space(), &paras);
            continue;
        }
        let args = r.json["a"].as_array().cloned().unwrap_or_default();
        let m = r.json["m"].as_str().unwrap_or("");
        match (r.conc, r.section) {
            (Conc::Neutral, Some(sec)) => {
                if let Some((space, cp)) = cell_space_of(m, &args) {
                    add(&mut items, sec, &space, &[cp]);
                    continue;
                }
                let mut found = false;
                for t in touches(&r) {
                    match t {
                        Touch::Paras { lo, hi, .. } => {
                            found = true;
                            items.extend((lo..=hi).map(|p| para_item(sec, p)));
                        }
                        _ => items.push(section_item(sec)),
                    }
                }
                if !found {
                    items.push(section_item(sec));
                }
            }
            (Conc::Structural, Some(sec)) => match &r.foot {
                Some(f) => {
                    let hi = f.anchor + f.pd.max(0) as usize;
                    items.extend((f.anchor..=hi).map(|p| para_item(f.sec, p)));
                }
                None => items.push(section_item(sec)),
            },
            _ => whole = true,
        }
    }
    let mut out: Vec<Value> = Vec::new();
    for it in items {
        let v = it.json();
        if !out.contains(&v) {
            out.push(v);
        }
    }
    json!({ "items": out, "whole": whole, "nested": false })
}

#[cfg(test)]
#[path = "ot_tests.rs"]
mod ot_tests;
