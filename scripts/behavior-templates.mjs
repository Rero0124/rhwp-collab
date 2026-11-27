// R1b 사례 틀 — 인자 이름만으로 유효한 호출을 만들 수 없는 기능을 손으로 적는다(docs/collab-stage2.md §3).
//
// TEMPLATES[이름] = (r, s) => 인자 배열 (s = 문서 상태 요약: paras, lens, controls, tables, fields)
// jsonCandidates(이름, 인자 이름, s, 초점) = 그 JSON 인자 후보 목록(무작위로 하나를 쓴다)

const CHAR_PROPS = [{ bold: true }, { italic: true }, { underline: true }, { strikethrough: true }, { fontSize: 1400 }, { textColor: '#ff0000' }];
const PARA_PROPS = [{ alignment: 'center' }, { alignment: 'right' }, { lineSpacing: 200 }, { indent: 1000 }, { marginLeft: 2000 }, { spacingBefore: 500 }];

export function jsonCandidates(name, param, s, focus = {}) {
  const j = (xs) => xs.map((x) => JSON.stringify(x));
  const cell = focus.cell ?? 0;
  if (param === 'runs_json') return j([[{ start: 0, end: 1, charShapeId: 0 }], [{ start: 0, end: 2, charShapeId: 1 }]]);
  if (/resizeTableCells/.test(name)) return j([[{ cellIdx: cell, widthDelta: 300, heightDelta: 0 }], [{ cellIdx: cell, widthDelta: 0, heightDelta: 200 }]]);
  if (/applyCellBorderFillIds/.test(name)) return j([{ cells: [{ cellIdx: cell, id: 1 }] }, { cells: [{ cellIdx: cell, id: 2 }] }]);
  if (/CharFormat|CharShape|NumberingCharShape/.test(name) || param === 'char_mods_json') return j(CHAR_PROPS);
  if (/ParaFormat|ParaShape/.test(name) || param === 'para_mods_json') return j(PARA_PROPS);
  if (/Picture/.test(name)) return j([{ width: 3000, height: 3000 }, { brightness: 10 }, { contrast: 10 }, { description: '그림' }]);
  if (/Shape|Line/.test(name)) return j([{ width: 3000, height: 2000 }, { lineColor: '#0000ff' }, { lineWidth: 50 }]);
  if (/Equation/.test(name)) return j([{ script: 'x^2+1' }, { fontSize: 1200 }]);
  if (/TableProperties|setTable/.test(name)) return j([{ cellSpacing: 100 }, { treatAsChar: false }, { borderFillId: 1 }, { outerMarginLeft: 200 }]);
  if (/Cell/.test(name)) return j([{ width: 5000 }, { height: 1500 }, { verticalAlign: 'center' }, { borderFillId: 1 }, { cells: [{ cellIdx: 0, widthDelta: 200 }] }]);
  if (/PageDef/.test(name)) return j([{ marginLeft: 6000 }, { landscape: true }, { marginTop: 4000 }]);
  if (/SectionDef/.test(name)) return j([{ columnSpacing: 1000 }, { hideHeader: true }, { pageStartNum: 2 }]);
  if (/PageBorderFill/.test(name)) return j([{ borderFillId: 1 }, { applyTo: 0 }]);
  if (/Memo/.test(name)) return j([{ width: 4000 }, { lineColor: '#ff0000' }]);
  if (/Style/.test(name)) return j([{ name: '새 스타일' }, { nextStyleId: 0 }]);
  if (/Compose/.test(name)) return j([{ text: '가' }, { circle: true }]);
  if (/FootnoteShape|EndnoteShape/.test(name)) return j([{ numberFormat: 1 }, { startNum: 2 }]);
  if (/Formula/.test(name)) return j([{ formula: '=SUM(A1:A2)' }]);
  if (/Chart/.test(name)) return j([{ edits: [] }, [{ row: 0, col: 0, value: 1 }]]);
  if (param === 'runs_json') return j([[{ start: 0, end: 1, charShapeId: 0 }]]);
  if (param === 'value_json') return j([{ value: '값' }, { checked: true }]);
  return ['{}'];
}

const PNG_1PX = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const ctrls = (d) => { try { return JSON.parse(d.getControls()).filter((c) => c.list === 0); } catch { return []; } };
/** 문단 p 에서 종류가 ids 인 마지막 개체 번호 */
const findCtrl = (d, p, ids) => { const xs = ctrls(d).filter((c) => c.para === p && ids.includes(c.ctrlId.trim())); return xs.length ? xs[xs.length - 1].controlIndex : null; };
const spot = (r, s) => { const p = r.int(s.paras); return { p, o: r.int((s.lens[p] ?? 0) + 1) }; };
const uniq = (r) => `n${r.int(1e9)}`;
const fieldBy = (d, name) => { try { return JSON.parse(d.getFieldList()).find((f) => f.name === name) ?? null; } catch { return null; } };

/** 준비 단계에서 개체를 하나 만들고, 만든 개체 번호로 인자를 정하는 틀 */
function withCreated(prepOf, ids, argsOf) {
  return (r, s) => {
    const { p, o } = spot(r, s);
    return { prep: [prepOf(p, o, r)], argsFrom: (d) => { const ci = findCtrl(d, p, ids); return ci === null ? null : argsOf(p, ci, r, d); } };
  };
}
const picture = (p, o) => ['insertPicture', [0, p, o, '', PNG_1PX, 2000, 2000, 1, 1, 'png', 'img', 0, 0]];
const shape = (p, o) => ['createShapeControl', [JSON.stringify({ sectionIdx: 0, paraIdx: p, charOffset: o, width: 3000, height: 2000 })]];
const equation = (p, o) => ['insertEquation', [0, p, o, 'x+1', 1000, 0]];
const bookmark = (p, o, r) => ['addBookmark', [0, p, o, uniq(r)]];
const pick = (r, xs) => xs[r.int(xs.length)];

/** 머리말·꼬리말을 만들고 글자를 넣은 뒤 */
function inHf(argsOf) {
  return (r) => {
    const ih = r.chance(0.5);
    const text = '머리말 글자 하나 둘';
    return { prep: [['createHeaderFooter', [0, ih, 0]], ['insertTextInHeaderFooter', [0, ih, 0, 0, 0, text]]], args: argsOf(r, ih, text.length) };
  };
}
/** 누름틀을 만든 뒤 */
function withField(argsOf) {
  return (r, s) => {
    const { p, o } = spot(r, s);
    const name = uniq(r);
    return { prep: [['insertClickHereField', [0, p, o, '안내', '', name, true]]], argsFrom: (d) => { const f = fieldBy(d, name); return f ? argsOf(f, name, p, r) : null; } };
  };
}

/** 글자가 있는 문단에 하이퍼링크를 만든 뒤 */
function textPara(r, s) { const ps = s.lens.map((l, i) => [l, i]).filter(([l]) => l >= 2); return ps.length ? ps[r.int(ps.length)] : null; }
function link(r, s) {
  const tp = textPara(r, s);
  if (!tp) return null;
  const [len, p] = tp;
  const a = r.int(len - 1);
  const target = { section: 0, para: p, cellPath: [] };
  return { p, target, opts: { target, start: a, end: a + 1 + r.int(len - a - 1), uri: 'https://example.com/' + r.int(100) } };
}
function withLink(argsOf) {
  return (r, s) => {
    const l = link(r, s);
    if (!l) return null;
    return {
      prep: [['insertHyperlinkEx', [JSON.stringify(l.opts)]]],
      argsFrom: (d) => {
        let fields = [];
        try { fields = JSON.parse(d.getFieldList()); } catch { /* 없음 */ }
        const f = fields.find((x) => /hyper/i.test(x.fieldType) && x.location?.paraIndex === l.p);
        return f ? [JSON.stringify(argsOf(l.target, f.fieldId, r))] : null;
      },
    };
  };
}

/** 글자가 있는 문단의 일부를 복사한 뒤 붙여 넣는다(R13 ctx.clipboard 기능) */
function withCopy(argsOf) {
  return (r, s) => {
    const tp = textPara(r, s);
    if (!tp) return null;
    const [len, p] = tp;
    const a = r.int(len - 1);
    const args = argsOf(r, s);
    return args ? { prep: [['copySelection', [0, p, a, p, a + 1 + r.int(len - a - 1)]]], args } : null;
  };
}
const cellOf = (r, s) => {
  const t = s.tables.length ? s.tables[r.int(s.tables.length)] : null;
  if (!t) return null;
  const cell = r.int(t.cells.length);
  const cp = r.int(t.cells[cell].length);
  return { t, cell, cp, off: r.int(t.cells[cell][cp] + 1) };
};

const PNG_2PX = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M/AwMDAxAAFAAs+AQGBf4KkAAAAAElFTkSuQmCC', 'base64'));
const gso = (s) => s.controls.filter((c) => c.ctrlId.trim() === 'gso');
const cellPath = (ci, cell, cp) => JSON.stringify([{ controlIndex: ci, cellIndex: cell, cellParaIndex: cp }]);
/** 칸 문단에 그림을 넣은 뒤(셀 안 그림 번호는 그 칸 문단의 0번 — 샘플 칸에는 개체가 없다) */
function withCellPicture(argsOf) {
  return (r, s) => {
    const c = cellOf(r, s);
    if (!c) return null;
    const path = cellPath(c.t.ci, c.cell, c.cp);
    return { prep: [['insertPictureInCell', [0, c.t.para, c.off, path, PNG_1PX, 2000, 2000, 1, 1, 'png', 'img', 0, 0]]], args: argsOf(r, c, path) };
  };
}
/** 같은 문단에 도형 둘을 만든 뒤 */
function withTwoShapes(argsOf) {
  return (r, s) => {
    const { p, o } = spot(r, s);
    return {
      prep: [shape(p, o), shape(p, o)],
      argsFrom: (d) => {
        const xs = ctrls(d).filter((c) => c.para === p && c.ctrlId.trim() === 'gso').slice(-2);
        return xs.length < 2 ? null : argsOf(p, xs.map((c) => c.controlIndex), r);
      },
    };
  };
}
const groupJson = (p, cis) => JSON.stringify({ sectionIdx: 0, targets: cis.map((ci) => ({ paraIdx: p, controlIdx: ci })) });
const NOTE_SHAPE = [{ numberFormat: 1 }, { startNumber: 3 }, { prefixChar: '(', suffixChar: ')' }, { numberFormat: 2, startNumber: 2 }, { separatorLength: 5000 }];

const SAMPLES = new URL('../upstream/rhwp/samples/', import.meta.url);
let clipboardModel = null;
const hwpjsonModel = () => {
  if (clipboardModel === null) {
    try { clipboardModel = require_('fs').readFileSync(new URL('hwpjson/clipboard-model.json', SAMPLES), 'utf8'); } catch { clipboardModel = ''; }
  }
  return clipboardModel;
};
function require_(m) { return globalThis.process?.getBuiltinModule?.(m); }
/** 차트 값을 조금씩 바꾼 편집(값은 문자열) */
const chartEdits = (data, r) => ({ series: (data.series ?? []).map((x) => ({ values: x.values.map((v) => String((Number(v) || 0) + 1 + r.int(9))) })) });
/** 표 칸 안 도형(그림 아님)을 읽기 API 로 찾는다: [{ pp, path, ci }] */
function cellShapes(d, s) {
  const out = [];
  for (const t of s.tables) {
    for (let cell = 0; cell < t.cells.length; cell += 1) {
      for (let cp = 0; cp < t.cells[cell].length; cp += 1) {
        const path = JSON.stringify([{ controlIndex: t.ci, cellIndex: cell, cellParaIndex: cp }]);
        for (let ci = 0; ci < 3; ci += 1) {
          try { const v = JSON.parse(d.getCellShapePropertiesByPath(0, t.para, path, ci)); if (v && v.ok !== false) out.push({ pp: t.para, path, ci }); } catch { /* 없음 */ }
        }
      }
    }
  }
  return out;
}

// ── 5단계 D4 후속: 좁은 권한 함수(메모·양식)를 op 로 올리기 위한 사례 ──
/** 문서에 있는 고칠 수 있는 메모 하나(getMemoList 의 id = field_id) */
const memoOf = (d, r) => { try { const xs = JSON.parse(d.getMemoList()).filter((m) => m.editable); return xs.length ? xs[r.int(xs.length)] : null; } catch { return null; } };
const withMemo = (argsOf) => (r) => ({ prep: [], argsFrom: (d) => { const m = memoOf(d, r); return m ? argsOf(m, r, d) : null; } });
/** 끝 표의 칸 0 문단 0 의 양식 0 — form-in-cell(합성) 문서가 그 자리에 양식을 둔다 */
const lastTable = (s) => s.tables[s.tables.length - 1] ?? null;
const formValue = (r) => pick(r, [{ value: 1 }, { text: `칸 값 ${r.int(1000)}` }, { value: 1, text: `둘 다 ${r.int(1000)}` }]);

/** 각주를 하나 만든 뒤 그 각주를 대상으로(무작위 인자로는 각주 개체 번호를 잘 못 맞힌다) */
const inFootnote = (argsOf) => (r, s) => {
  const { p, o } = spot(r, s);
  return { prep: [['insertFootnote', [0, p, o]]], argsFrom: (d) => { const ci = findCtrl(d, p, ['fn']); return ci === null ? null : argsOf(p, ci, r); } };
};

export const TEMPLATES = {
  insertTextInFootnote: inFootnote((p, ci, r) => [0, p, ci, 0, 0, `각주 글자 ${r.int(1000)}`]),
  deleteTextInFootnote: inFootnote((p, ci, r) => ({ prep: [['insertTextInFootnote', [0, p, ci, 0, 0, '각주 글자 하나 둘']]], args: [0, p, ci, 0, r.int(4), 1 + r.int(2)] })),
  applyParaFormatInFootnote: inFootnote((p, ci, r) => ({ prep: [['insertTextInFootnote', [0, p, ci, 0, 0, '각주 글자']]], args: [0, p, ci, 0, JSON.stringify(pick(r, [{ alignment: 'center' }, { alignment: 'right' }, { indent: 1000 }]))] })),
  // 칸 안 누름틀을 만든 뒤 그 자리의 누름틀을 지운다
  removeFieldAtInCell: (r, s) => {
    const c = cellOf(r, s);
    if (!c) return null;
    return { prep: [['insertClickHereFieldInCell', [0, c.t.para, c.t.ci, c.cell, c.cp, c.off, false, '안내', '', uniq(r), true]]], args: [0, c.t.para, c.t.ci, c.cell, c.cp, c.off, false] };
  },
  // 글자가 둘 이상인 칸 문단 안의 범위를 지운다(무작위 인자는 칸 문단 범위를 자주 넘는다)
  deleteRangeInCellByPath: (r, s) => {
    const cs = [];
    for (const t of s.tables) t.cells.forEach((ps, cell) => ps.forEach((len, cp) => { if (len >= 2) cs.push({ t, cell, cp, len }); }));
    if (!cs.length) return null;
    const c = cs[r.int(cs.length)];
    const a = r.int(c.len - 1);
    const b = a + 1 + r.int(c.len - a - 1);
    return [0, c.t.para, cellPath(c.t.ci, c.cell, c.cp), c.cp, a, c.cp, b];
  },
  removeMemo: withMemo((m) => [m.id]),
  setMemoText: withMemo((m, r) => [m.id, `고친 메모 ${r.int(1000)}`]),
  insertMemoReply: withMemo((m, r) => [m.id, JSON.stringify({ author: '정', text: `답글 ${r.int(1000)}` })]),
  setMemoShape: (r) => ({ prep: [], argsFrom: (d) => {
    let shape;
    try { shape = JSON.parse(d.getMemoShape(0)); } catch { return null; }
    const change = pick(r, [{ width: 9000 + r.int(9000) }, { lineColor: '#ff0000' }, { fillColor: '#eeeeff' }, { lineType: 2 }]);
    return [0, JSON.stringify({ ...shape, ...change })];
  } }),
  setFormValueInCell: (r, s) => { const t = lastTable(s); return t && [0, t.para, t.ci, 0, 0, 0, JSON.stringify(formValue(r))]; },
  setFormValueInCellEx: (r, s) => { const t = lastTable(s); return t && [JSON.stringify({ sec: 0, tablePara: t.para, tableCi: t.ci, cellIdx: 0, cellPara: 0, formCi: 0, value: formValue(r) })]; },
  applyFormActionUpdates: (r, s) => ({ prep: [], argsFrom: (d) => {
    const fs = s.controls.filter((c) => c.ctrlId.trim() === 'form');
    if (!fs.length) return null;
    const c = fs[r.int(fs.length)];
    let info;
    try { info = JSON.parse(d.getFormObjectInfo(0, c.para, c.controlIndex)); } catch { return null; }
    const update = {
      address: { section: 0, para: c.para, control: c.controlIndex, cellPath: [] },
      text: r.chance(0.5) ? `단추 글 ${r.int(1000)}` : info.text ?? '',
      caption: info.caption ?? '',
      value: r.chance(0.5) ? 1 - (info.value ?? 0) : info.value ?? 0,
      enabled: info.enabled ?? true,
      items: [],
    };
    return [JSON.stringify([update])];
  } }),
  // 각주를 만들고 글을 넣은 뒤 그 안 문단을 나눈다
  splitParagraphInFootnote: (r, s) => {
    const { p, o } = spot(r, s);
    return {
      prep: [['insertFootnote', [0, p, o]]],
      argsFrom: (d) => {
        const ci = findCtrl(d, p, ['fn']);
        if (ci === null) return null;
        return { prep: [['insertTextInFootnote', [0, p, ci, 0, 0, '각주 글자 하나']]], args: [0, p, ci, 0, 1 + r.int(5), null] };
      },
    };
  },
  // ── R14 후속: 업스트림 샘플로 ──
  setChartDataByIndex: (r) => ({ prep: [], argsFrom: (d) => { const list = JSON.parse(d.listCharts()); if (!list.length) return null; const i = r.int(list.length); return [list[i].index, JSON.stringify(chartEdits(JSON.parse(d.getChartDataByIndex(list[i].index)), r))]; } }),
  setChartData: (r) => ({ prep: [], argsFrom: (d) => { const list = JSON.parse(d.listCharts()); if (!list.length) return null; const c = list[r.int(list.length)]; return [c.section, c.paragraph, c.control, JSON.stringify(chartEdits(JSON.parse(d.getChartDataByIndex(c.index)), r))]; } }),
  setHeaderFooterPictureProperties: (r, s) => {
    const hf = s.controls.filter((c) => ['head', 'foot'].includes(c.ctrlId.trim()));
    if (!hf.length) return null;
    const c = hf[r.int(hf.length)];
    return [0, c.para, c.controlIndex, 0, 0, JSON.stringify(pick(r, [{ width: 3000, height: 1500 }, { brightness: 20 }, { contrast: 15 }, { horzOffset: 500 }]))];
  },
  pasteHwpJson: (r, s) => { const json = hwpjsonModel(); if (!json) return null; const { p, o } = spot(r, s); return [0, p, o, json]; },
  setCellShapePropertiesByPath: (r) => ({ prep: [], argsFrom: (d, s) => { const xs = cellShapes(d, s); if (!xs.length) return null; const x = xs[r.int(xs.length)]; return [0, x.pp, x.path, x.ci, JSON.stringify(pick(r, [{ width: 2500, height: 1200 }, { lineColor: '#ff0000' }, { treatAsChar: true }]))]; } }),
  deleteCellShapeControlByPath: (r) => ({ prep: [], argsFrom: (d, s) => { const xs = cellShapes(d, s); if (!xs.length) return null; const x = xs[r.int(xs.length)]; return [0, x.pp, x.path, x.ci]; } }),
  // ── R14: studio 로 닿는 기능 ──
  applyEndnoteShape: (r) => [0, JSON.stringify(NOTE_SHAPE[r.int(NOTE_SHAPE.length)])],
  applyFootnoteShape: (r) => [0, JSON.stringify(NOTE_SHAPE[r.int(NOTE_SHAPE.length)])],
  // 도형·그림을 뒤집는다(원래 상태로 되돌리기 org_state 는 끔 — 바뀌는 호출만). 무작위 생성은 개체를 잘 못 맞힌다.
  setControlFlipAt: (r, s) => { const xs = gso(s); if (!xs.length) return null; const c = xs[r.int(xs.length)]; return [c.para, c.controlIndex, r.int(2) === 1, false]; },
  applyShapeZOrderPairs: (r, s) => { const xs = gso(s); if (!xs.length) return null; const c = xs[r.int(xs.length)]; return [0, JSON.stringify([{ ppi: c.para, ci: c.controlIndex, z: 1 + r.int(60) }])]; },
  groupShapes: withTwoShapes((p, cis) => [groupJson(p, cis)]),
  ungroupShape: withTwoShapes((p, cis) => ({ prep: [['groupShapes', [groupJson(p, cis)]]], args: [0, p, Math.min(...cis)] })),
  moveLineEndpoint: (r, s) => {
    const { p, o } = spot(r, s);
    return {
      prep: [['createShapeControl', [JSON.stringify({ sectionIdx: 0, paraIdx: p, charOffset: o, width: 3000, height: 1000, shapeType: 'line' })]]],
      argsFrom: (d) => { const ci = findCtrl(d, p, ['gso']); return ci === null ? null : [0, p, ci, 0, 0, 2000 + r.int(2000), 500 + r.int(1500)]; },
    };
  },
  setCharShapeRuns: (r, s) => { const tp = textPara(r, s); if (!tp) return null; const [len, p] = tp; const a = r.int(len - 1); const b = a + 1 + r.int(len - a - 1); return [0, p, a, b, JSON.stringify([{ startOffset: a, endOffset: b, charShapeId: r.int(3) }])]; },
  setCharShapeRunsInCellByPath: (r, s) => {
    const c = cellOf(r, s);
    if (!c) return null;
    const len = c.t.cells[c.cell][c.cp];
    if (len < 2) return null;
    const a = r.int(len - 1), b = a + 1 + r.int(len - a - 1);
    return [0, c.t.para, cellPath(c.t.ci, c.cell, c.cp), a, b, JSON.stringify([{ startOffset: a, endOffset: b, charShapeId: r.int(3) }])];
  },
  setEquationProperties: withCreated(equation, ['eqed'], (p, ci, r) => [0, p, ci, -1, -1, JSON.stringify(pick(r, [{ script: 'y+2' }, { fontSize: 1400 }, { color: 255 }, { script: 'a over b' }]))]),
  splitTableCell: (r, s) => {
    const ts = s.tables.filter((t) => t.cols >= 2);
    if (!ts.length) return null;
    const t = ts[r.int(ts.length)];
    const row = r.int(t.rows);
    return { prep: [['mergeTableCells', [0, t.para, t.ci, row, 0, row, 1]]], args: [0, t.para, t.ci, row, 0] };
  },
  deleteCellPictureControlByPath: withCellPicture((r, c, path) => [0, c.t.para, path, 0]),
  setCellPicturePropertiesByPath: withCellPicture((r, c, path) => [0, c.t.para, path, 0, JSON.stringify(pick(r, [{ width: 3000, height: 3000 }, { brightness: 20 }, { contrast: 20 }]))]),
  assignPictureImage: withCreated(picture, ['gso'], (p, ci) => [0, p, '', ci, PNG_2PX, 2, 2, 'png']),
  relocateFloatingPicture: (r, s) => {
    const { p, o } = spot(r, s);
    const q = r.int(s.paras);
    return { prep: [picture(p, o)], argsFrom: (d) => { const ci = findCtrl(d, p, ['gso']); return ci === null ? null : [0, p, '[]', ci, 0, q, 0, '[]', 300 + r.int(900), 300 + r.int(900)]; } };
  },
  setFormValue: (r, s) => {
    const fs = s.controls.filter((c) => c.ctrlId.trim() === 'form');
    if (!fs.length) return null;
    const c = fs[r.int(fs.length)];
    return [0, c.para, c.controlIndex, JSON.stringify(pick(r, [{ value: 1 }, { value: 0 }, { text: '입력값' + r.int(100) }, { value: 1, text: '둘 다' }]))];
  },
  pasteInternal: withCopy((r, s) => { const { p, o } = spot(r, s); return [0, p, o]; }),
  pasteInternalTextLogical: withCopy((r, s) => { const { p, o } = spot(r, s); return [0, p, o]; }),
  pasteInternalInCell: withCopy((r, s) => { const c = cellOf(r, s); return c && [0, c.t.para, c.t.ci, c.cell, c.cp, c.off]; }),
  pasteControl: (r, s) => {
    const objs = s.controls.filter((c) => ['gso', 'tbl', 'eqed'].includes(c.ctrlId.trim()));
    if (!objs.length) return null;
    const c = objs[r.int(objs.length)];
    const { p, o } = spot(r, s);
    return { prep: [['copyControl', [0, c.para, '', c.controlIndex]]], args: [0, p, o] };
  },
  pasteInternalInCellByPath: withCopy((r, s) => { const c = cellOf(r, s); return c && [0, c.t.para, JSON.stringify([{ controlIndex: c.t.ci, cellIndex: c.cell, cellParaIndex: c.cp }]), c.off]; }),
  insertHyperlinkEx: (r, s) => { const l = link(r, s); return l ? [JSON.stringify(l.opts)] : null; },
  updateHyperlinkEx: withLink((target, fieldId, r) => ({ target, fieldId, uri: 'https://example.org/' + r.int(100) })),
  replaceHyperlinkTextEx: withLink((target, fieldId) => ({ target, fieldId, text: '바꾼 링크' })),
  removeHyperlinkEx: withLink((target, fieldId, r) => ({ target, fieldId, restoreFormatting: r.chance(0.5) })),
  deleteBookmark: withCreated(bookmark, ['bokm'], (p, ci) => [0, p, ci]),
  renameBookmark: withCreated(bookmark, ['bokm'], (p, ci, r) => [0, p, ci, uniq(r)]),
  deletePictureControl: withCreated(picture, ['gso'], (p, ci) => [0, p, ci]),
  setPictureProperties: withCreated(picture, ['gso'], (p, ci, r) => [0, p, ci, JSON.stringify(pick(r, [{ width: 3000, height: 3000 }, { brightness: 20 }, { contrast: 20 }, { treatAsChar: true }]))]),
  deleteEquationControl: withCreated(equation, ['eqed'], (p, ci) => [0, p, ci]),
  deleteShapeControl: withCreated(shape, ['gso'], (p, ci) => [0, p, ci]),
  setShapeProperties: withCreated(shape, ['gso'], (p, ci, r) => [0, p, ci, JSON.stringify(pick(r, [{ width: 4000, height: 2500 }, { treatAsChar: true }, { lineColor: '#ff0000' }]))]),
  changeShapeZOrder: withCreated(shape, ['gso'], (p, ci, r) => [0, p, ci, pick(r, ['front', 'back', 'forward', 'backward'])]),
  // 머리말·꼬리말
  applyCharFormatInHeaderFooter: inHf((r, ih, n) => [0, ih, 0, 0, 0, 0, 1 + r.int(n - 1), JSON.stringify(pick(r, [{ bold: true }, { italic: true }, { underline: true }]))]),
  applyParaFormatInHf: inHf((r, ih) => [0, ih, 0, 0, JSON.stringify(pick(r, [{ alignment: 'center' }, { alignment: 'right' }]))]),
  deleteTextInHeaderFooter: inHf((r, ih, n) => [0, ih, 0, 0, r.int(n - 2), 1 + r.int(2)]),
  replaceRangeInHeaderFooter: inHf((r, ih, n) => { const a = r.int(n - 2); return [0, ih, 0, 0, a, 0, a + 1 + r.int(2), '바꿈']; }),
  insertFieldInHf: inHf((r, ih, n) => [0, ih, 0, 0, r.int(n + 1), r.int(3)]),
  mergeParagraphInHeaderFooter: (r) => {
    const ih = r.chance(0.5);
    const k = 1 + r.int(5);
    return { prep: [['createHeaderFooter', [0, ih, 0]], ['insertTextInHeaderFooter', [0, ih, 0, 0, 0, '머리말 글자 하나 둘']], ['splitParagraphInHeaderFooter', [0, ih, 0, 0, k, null]]], args: [0, ih, 0, 1] };
  },
  // 누름틀
  setFieldValue: withField((f, name, p, r) => [f.fieldId, pick(r, ['값', '새 값', '가나다'])]),
  setFieldValueByName: withField((f, name, p, r) => [name, pick(r, ['값', '새 값', '가나다'])]),
  renameField: withField((f, name, p, r) => [name, uniq(r)]),
  updateClickHereProps: withField((f, name, p, r) => [f.fieldId, '새 안내', '메모', name, r.chance(0.5)]),
  removeFieldAt: withField((f, name, p) => [0, p, f.startCharIdx]),
  // 각주 문단 합치기: 각주를 만들고 그 안 문단을 나눈 뒤 둘째 문단을 합친다
  mergeParagraphInFootnote: (r, s) => {
    const { p, o } = spot(r, s);
    return {
      prep: [['insertFootnote', [0, p, o]]],
      argsFrom: (d) => {
        const ci = findCtrl(d, p, ['fn']);
        if (ci === null) return null;
        return { prep: [['insertTextInFootnote', [0, p, ci, 0, 0, '각주 글자']], ['splitParagraphInFootnote', [0, p, ci, 0, 1 + r.int(3), null]]], args: [0, p, ci, 1] };
      },
    };
  },
};
