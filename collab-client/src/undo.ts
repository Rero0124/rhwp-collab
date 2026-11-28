/**
 * 4단계 U1·U2: 공동편집 중 되돌리기 (docs/collab-stage4.md). studio 히스토리 훅(`CollabHistoryHook`)을 구현한다.
 *
 * - 명령 ↔ 기록 연결: 히스토리 경계(기록·되돌리기·다시 하기)마다 엔진의 로컬 기록(`drainLocalLog`)을 그 명령에
 *   붙인다(항목 단위 — 300ms 병합 때문에 명령과 묶음은 1:1 이 아니다). record 경로(IME 조합 끝 등)는 직전 경계
 *   뒤의 기록이 그 명령 것이다.
 * - 발자국: 명령이 만든 기록 열에서 Rust 가 계산한다(`collabFootprint`, 기록이 끝난 문서 좌표의 문단들).
 * - 위치 옮기기(3.1): 내 기록이든 남의 기록이든 지금 문서를 바꾸면 스택의 다른 명령 위치·발자국을 그 기록으로
 *   옮긴다(`collabMapPositions`) — 그래야 스택 위치가 늘 지금 문서 좌표다. 남의 기록이면 `hit` 으로 막힘을 정한다.
 * - 막힘(3.2): 발자국에 남의 기록이 닿음(같은 문단 편집·같은 구역 구조·문서 전체 결과), 표에 없거나 옮길 수 없는
 *   명령·스냅샷 명령·발자국을 특정할 수 없는 명령은 뒤에 남의 기록이 하나라도 있으면, 삭제 조각 복원은 조각 문단이
 *   옮겨졌으면.
 * - 버려진 편집(3.3): 그 기록을 만든 명령과 같은 문단에 발자국이 있는 명령을 뺀다. 남은 명령은 버린 기록의
 *   되돌림 열(`remapLocal`)로 먼저 옮긴 뒤 원격 지도로 옮긴다 — 버린 Enter·합침 뒤의 문단 번호도 맞는다. 되돌림
 *   열이 불완전하면(state 등 되돌릴 수 없는 것을 버림·재적용 실패) 보수적으로 문단 수를 바꾼 기록의 구역 전체를 뺀다.
 * - U2: 위치는 중첩 셀 경로(`cellPath`)와 구역 단위 자리(`scope`)도 가진다. 구역 원본 저널에 기대는 되돌리기
 *   (`store: 'section'` — 구역 설정·z 순서)는 그 구역들에 지킴(`sectionAll`)을 발자국에 더한다: 실행 뒤 그 구역에 남의
 *   기록이 하나라도 오면 막는다(저널 계약: 캡처와 복원 사이 그 구역 편집 금지).
 *
 * - U3: 스냅샷 명령(문서 전체 스냅샷으로 되돌림)은 만든 기록이 한 구역의 연속 문단 범위로 모이면(`undoRange`) 그 범위만
 *   스냅샷에서 되살린다 — 히스토리가 묻는 `restoreSnapshot` 을 맡아 collab 보조로 바꾸고, 엔진이 결과를 **범위 표시가 붙은
 *   state** 로 기록한다(받는 쪽은 그 범위의 구조 편집으로 보고 보정하므로 왕복 중이던 남의 입력이 취소되지 않는다). 막힘은
 *   범위로 정한다: 범위 안을 남이 고쳤으면 막고, 범위 밖 구조 편집은 번호만 옮긴다. 전제: 스냅샷의 DocInfo 목록이 지금
 *   문서의 앞부분과 같다(덧붙이기만) — 아니면 따로 안내하고 막는다.
 *
 * studio 를 import 하지 않는다(플러그인 규약) — 히스토리 조작과 위치 표는 host 가 넘긴다.
 */
import type { CollabEngine, Entry, ReceiveResult, UndoPosition } from './engine/engine.ts';

/** studio `collab-undo.ts` 의 모양(플러그인은 import 하지 않는다). */
interface Slot {
  readonly key: object;
  readonly field: string;
  get(): UndoPosition | null;
  set(p: UndoPosition): void;
  readonly caret?: boolean;
}
interface Descriptor {
  slots: Slot[];
  store: 'none' | 'fragment' | 'snapshot' | 'section';
  fragmentAnchor?: Slot;
  /** `store === 'section'`: 되돌리기가 원본 저널로 복원하는 구역들 */
  sections?: number[];
  /** U3 `store === 'snapshot'`: studio 스냅샷 번호(명령 전 / 되돌리기 직전) */
  snapshot?: { before(): number | null; after(): number | null };
}
export interface UndoController {
  stacks(): { undo: readonly object[]; redo: readonly object[] };
  remove(commands: ReadonlySet<object>): void;
  clear(): void;
  describe(command: object): Descriptor | null;
}

export const UNDO_BLOCKED_NOTICE = '다른 사람이 이후에 고친 부분이라 되돌릴 수 없습니다';
export const REDO_BLOCKED_NOTICE = '다른 사람이 이후에 고친 부분이라 다시 실행할 수 없습니다';
export const UNDO_DROPPED_NOTICE = '되돌리기가 다른 사람 편집과 겹쳐 취소됐습니다';
export const UNDO_TRIMMED_NOTICE = '되돌릴 수 없는 단계가 있어 그 앞 기록도 정리했습니다';
/** U3: 범위 복원의 전제(스냅샷의 DocInfo 목록이 지금 문서의 앞부분과 같음)가 어긋남 — 원인이 남의 편집이 아니므로 따로 알린다. */
export const UNDO_DOCINFO_NOTICE = '문서의 서식 목록이 바뀌어 이 단계는 되돌릴 수 없습니다';
export const REDO_DOCINFO_NOTICE = '문서의 서식 목록이 바뀌어 이 단계는 다시 실행할 수 없습니다';

/** U3 스위치: `always` 면 범위가 있는 스냅샷 명령은 언제나 범위 복원, `remote` 면 남의 기록이 있을 때만(없으면 문서 전체 복원). */
export type RangeRestoreMode = 'always' | 'remote';

type Span = { lo: number; n: number };
/**
 * U3: 스냅샷 명령의 문단 범위. `cur` 는 지금 문서에서 다음 되돌리기/다시 하기가 바꿀 문단, `before` 는 명령 전 스냅샷
 * (`beforeId`)의 원본(처음 실행 때 좌표 그대로), `after` 는 되돌리기 직전 스냅샷(`afterId`)의 원본(되돌린 뒤에만).
 */
interface RangeMeta {
  section: number;
  cur: Span;
  before: Span;
  after: Span | null;
  /** 남의 기록이 범위에 닿은 첫 사유 */
  hit: string | null;
}

interface Meta {
  /** 실행·다시 하기가 만든 기록의 로컬 번호 */
  lids: Set<number>;
  /** 되돌리기가 만든 기록의 로컬 번호(버려지면 그 명령을 버린다 — "되돌리기가 취소됨") */
  undoLids: Set<number>;
  /** 발자국(지금 문서 좌표) — 다음 되돌리기/다시 하기가 지켜야 할 문단들 */
  foot: UndoPosition[];
  /** 발자국을 문단으로 특정할 수 없음(결과 전송·발자국 없는 구조 등) — 3.2-3, 그리고 아래 명령의 좌표를 깸 */
  whole: boolean;
  nested: boolean;
  /** 마지막 경계 뒤 남의 기록이 하나라도 들어왔다 */
  remoteSeen: boolean;
  /** 발자국·위치에 남의 기록이 닿은 첫 사유 */
  hit: string | null;
  /** 삭제 조각 복원: 경계 때의 조각 문단(옮겨졌으면 막는다) */
  fragment: { para: number; cellPara: number | null } | null;
  /** U3: 스냅샷 명령의 문단 범위(범위로 모이지 않으면 `null` — 3.2-3) */
  range: RangeMeta | null;
  /** U3: 막힘 판정이 이번 되돌리기/다시 하기를 범위 복원으로 정했다(히스토리가 곧 `restoreSnapshot` 을 묻는다) */
  rangeMode: boolean;
}

/** U3: 범위 안의 자리인가(셀 자리는 표를 품은 본문 문단으로). 구역 단위 자리는 범위로 특정할 수 없어 같은 구역이면 겹침. */
const inRange = (p: UndoPosition, r: RangeMeta): boolean =>
  p.section === r.section && (Boolean(p.scope) || (r.cur.lo <= p.para && p.para < r.cur.lo + r.cur.n));
const rangesMeet = (a: RangeMeta, b: RangeMeta): boolean =>
  a.section === b.section && a.cur.lo < b.cur.lo + b.cur.n && b.cur.lo < a.cur.lo + a.cur.n;

type Step = { control: number; cell: number; cellPara: number };
/** 셀 경로(바깥 → 안쪽). 한 단계 셀은 `cell` 로만 올 수도 있다(U1 모양). */
const pathOf = (p: UndoPosition): Step[] => p.cellPath ?? (p.cell ? [p.cell] : []);
const innerCellPara = (p: UndoPosition): number | null => {
  const path = pathOf(p);
  return path.length > 0 ? path[path.length - 1].cellPara : null;
};
const samePath = (a: Step[], b: Step[]): boolean =>
  a.length === b.length && a.every((s, i) => s.control === b[i].control && s.cell === b[i].cell && s.cellPara === b[i].cellPara);

/**
 * 같은 문단인가(버려진 편집과 겹치는 명령 고르기). 구역 단위 자리끼리는 같은 구역이면 같다고 본다 — 머리말·꼬리말 안
 * 좌표는 지도로 옮기지 않으므로 버려진 머리말 편집 뒤의 머리말 명령은 함께 뺀다. 지킴(`sectionAll`)은 발자국이 아니다.
 */
const samePara = (a: UndoPosition, b: UndoPosition): boolean => {
  if (a.section !== b.section) return false;
  if (a.scope || b.scope) return a.scope === 'section' && b.scope === 'section';
  return a.para === b.para && samePath(pathOf(a), pathOf(b));
};
const sameSpot = (a: UndoPosition, b: UndoPosition): boolean =>
  a.section === b.section && (a.scope ?? null) === (b.scope ?? null)
  && (a.scope ? true : a.para === b.para && samePath(pathOf(a), pathOf(b)));

/** 버려진 기록이 문단 수를 바꾸지 않는 문단 안 편집인가(아니면 그 구역의 뒤 문단 번호가 어긋난다). */
const IN_PARAGRAPH = new Set([
  'insertText', 'insertTextLogical', 'deleteText', 'replaceBodyTextLocal',
  'insertTextInCell', 'insertTextInCellByPath', 'insertTextInCellDeferredPagination', 'deleteTextInCell', 'deleteTextInCellByPath',
  'deleteTextInCellDeferredPagination', 'replaceTextInCellDeferredPagination',
  'applyCharFormat', 'applyCharFormatInCell', 'applyCharFormatInCellByPath', 'applyParaFormat', 'applyParaFormatInCell',
  'applyParaFormatInCellByPath', 'setParaShapeId', 'setCellParaShapeId', 'setCellParaShapeIdByPath', 'setCharShapeRunsInCellByPath',
]);

export class CollabUndo {
  private readonly meta = new WeakMap<object, Meta>();
  private controller: UndoController | null = null;
  private readonly engine: CollabEngine;
  private readonly notify: (text: string) => void;
  private readonly rangeRestore: RangeRestoreMode;

  constructor(engine: CollabEngine, notify: (text: string) => void, options: { rangeRestore?: RangeRestoreMode } = {}) {
    this.engine = engine;
    this.notify = notify;
    this.rangeRestore = options.rangeRestore ?? 'always';
  }

  attach(controller: UndoController | null): void {
    this.controller = controller;
  }

  /** 양 스택을 비운다(제자리 재동기화·문서 교체, 3.4). */
  clear(): void {
    this.engine.drainLocalLog();
    this.controller?.clear();
  }

  // ── 히스토리 훅 ──────────────────────────────────────────────────

  readonly hook = {
    recorded: (command: object, replaced: object | null): void => {
      const items = this.engine.drainLocalLog();
      const entries = items.map((i) => i.entry);
      this.mapLocal(entries, new Set([command, ...(replaced ? [replaced] : [])]));
      const prev = replaced ? this.meta.get(replaced) : undefined;
      const fp = this.footprintOf(entries);
      const m: Meta = {
        lids: new Set([...(prev?.lids ?? []), ...items.map((i) => i.lid)]),
        undoLids: new Set(),
        foot: dedupe([...(prev?.foot ?? []), ...fp.items, ...this.guardsOf(command)]),
        whole: (prev?.whole ?? false) || fp.whole,
        nested: (prev?.nested ?? false) || fp.nested,
        remoteSeen: prev?.remoteSeen ?? false,
        hit: prev?.hit ?? null,
        fragment: null,
        range: null,
        rangeMode: false,
      };
      m.fragment = this.fragmentAnchorOf(command);
      // U3: 스냅샷 명령의 기록이 한 구역의 문단 범위로 모이면 범위로 다룬다(발자국 대신 범위가 막힘을 정한다)
      if (!replaced) m.range = this.rangeOf(command, entries);
      if (m.range) {
        m.foot = [];
        m.whole = false;
        m.nested = false;
      }
      this.meta.set(command, m);
    },
    settled: (): void => {
      const entries = this.engine.drainLocalLog().map((i) => i.entry);
      this.mapLocal(entries, new Set());
    },
    blocked: (command: object, dir: 'undo' | 'redo'): string | null => this.blockReason(command, dir),
    rejected: (command: object, dir: 'undo' | 'redo', reason: string): void => {
      this.notify(reason);
      const m = this.meta.get(command);
      // 좌표를 옮길 수 없던 명령(결과 전송 등)을 되돌리지 못하고 버리면, 그 아래 명령들의 위치는 그 명령이 없던
      // 문서의 좌표로 남는다 — 지금 문서와 맞지 않으므로 함께 버린다.
      if (dir === 'undo' && m?.whole && this.controller) {
        const below = new Set(this.controller.stacks().undo);
        if (below.size > 0) {
          this.controller.remove(below);
          this.notify(UNDO_TRIMMED_NOTICE);
        }
      }
    },
    undone: (command: object): void => this.afterJump(command, 'undo'),
    redone: (command: object): void => this.afterJump(command, 'redo'),
    /** U3: 막힘 판정이 범위 복원으로 정한 명령이면 그 범위만 되살리고(범위 표시 state 로 기록) 맡는다. */
    restoreSnapshot: (command: object, dir: 'undo' | 'redo', id: number): boolean => this.restoreRange(command, dir, id),
  };

  // ── 원격 수신 (플러그인이 receiveRemote 뒤에 부른다) ─────────────────

  onRemote(result: ReceiveResult): void {
    if (!this.controller) return;
    const dropped = new Set(result.droppedLids ?? []);
    const complete = result.remapComplete !== false;
    // 버린 명령 고르기는 지금(버리기 전) 좌표에서 — 발자국끼리 같은 좌표라야 비교된다
    if (dropped.size > 0) this.dropFor(dropped, result.droppedEntries ?? [], complete);
    // 버린 내 기록을 지도로 걷어 낸 뒤(막힘 판정 없음) 원격 지도
    const local = result.remapLocal ?? [];
    if (local.length > 0 && complete) this.mapLocal(local, new Set());
    const remap = result.remap ?? [];
    if (remap.length > 0) this.mapRemote(remap);
  }

  /** 시험·진단용: 양 스택(아래→위)의 명령별 상태 */
  debug(): { enabled: boolean; undo: unknown[]; redo: unknown[] } {
    if (!this.controller) return { enabled: false, undo: [], redo: [] };
    const show = (cmd: object) => {
      const m = this.meta.get(cmd);
      const d = this.controller?.describe(cmd) ?? null;
      return {
        type: (cmd as { type?: unknown }).type,
        store: d?.store ?? null,
        slots: d?.slots.length ?? null,
        unmappable: d ? d.slots.some((s) => s.get() === null) : null,
        lids: m ? m.lids.size : null,
        foot: m?.foot ?? null,
        whole: m?.whole ?? null,
        nested: m?.nested ?? null,
        remoteSeen: m?.remoteSeen ?? null,
        hit: m?.hit ?? null,
        range: m?.range ? { ...m.range } : null,
      };
    };
    const { undo, redo } = this.controller.stacks();
    return { enabled: true, undo: undo.map(show), redo: redo.map(show) };
  }

  // ── 내부 ─────────────────────────────────────────────────────────

  private all(): object[] {
    if (!this.controller) return [];
    const { undo, redo } = this.controller.stacks();
    return [...undo, ...redo];
  }

  private footprintOf(entries: readonly Entry[]): { items: UndoPosition[]; whole: boolean; nested: boolean } {
    if (entries.length === 0) return { items: [], whole: false, nested: false };
    return this.engine.footprint(entries) ?? { items: [], whole: true, nested: false };
  }

  private fragmentAnchorOf(command: object): Meta['fragment'] {
    const d = this.controller?.describe(command);
    if (d?.store !== 'fragment' || !d.fragmentAnchor) return null;
    const p = d.fragmentAnchor.get();
    return p ? { para: p.para, cellPara: innerCellPara(p) } : null;
  }

  /** 구역 원본 저널에 기대는 되돌리기의 지킴(그 구역의 어떤 남의 기록이든 막음). */
  private guardsOf(command: object): UndoPosition[] {
    const d = this.controller?.describe(command);
    if (d?.store !== 'section') return [];
    return (d.sections ?? []).map((section) => ({ section, para: 0, offset: 0, scope: 'sectionAll' as const }));
  }

  private afterJump(command: object, dir: 'undo' | 'redo'): void {
    const items = this.engine.drainLocalLog();
    const entries = items.map((i) => i.entry);
    const m = this.meta.get(command);
    if (m?.range) return this.afterRangeJump(command, m, m.range, dir, items.map((i) => i.lid));
    this.mapLocal(entries, new Set([command]));
    if (!m) return;
    // 새 구간: 이제부터 들어오는 남의 기록이 다음 다시 하기/되돌리기를 막는다
    const fp = this.footprintOf(entries);
    // 다시 하기 뒤에는 다음 되돌리기를 위해 지킴을 다시 건다(되돌리기 뒤의 다시 하기는 새로 캡처한다)
    m.foot = dir === 'redo' ? dedupe([...fp.items, ...this.guardsOf(command)]) : fp.items;
    m.whole = fp.whole;
    m.nested = fp.nested;
    m.remoteSeen = false;
    m.hit = null;
    if (dir === 'undo') {
      m.undoLids = new Set(items.map((i) => i.lid));
      m.fragment = null;
    } else {
      m.lids = new Set(items.map((i) => i.lid));
      m.undoLids = new Set();
      m.fragment = this.fragmentAnchorOf(command);
    }
  }

  private blockReason(command: object, dir: 'undo' | 'redo'): string | null {
    const m = this.meta.get(command);
    const message = dir === 'undo' ? UNDO_BLOCKED_NOTICE : REDO_BLOCKED_NOTICE;
    if (!m) return null;
    const d = this.controller?.describe(command) ?? null;
    if (m.range && d?.store === 'snapshot') return this.rangeBlockReason(m, m.range, d, dir);
    // 다시 하기에서 조각은 쓰지 않는다(조각 명령의 다시 하기는 새로 잡아 지운다). 스냅샷은 양쪽 모두 문서 전체.
    const strict = !d || d.store === 'snapshot' || m.nested || m.whole || d.slots.some((s) => s.get() === null);
    if (strict) return m.remoteSeen ? message : null;
    if (m.hit) return message;
    if (dir === 'undo' && d.store === 'fragment') {
      const now = d.fragmentAnchor?.get();
      if (!now || !m.fragment || now.para !== m.fragment.para || innerCellPara(now) !== m.fragment.cellPara) {
        return m.remoteSeen ? message : null;
      }
    }
    return null;
  }

  // ── U3: 스냅샷 명령의 문단 범위 ────────────────────────────────────

  /** 실행 직후: 기록 열이 한 구역의 문단 범위로 모이고, 스냅샷과 문단 수·DocInfo 가 그 범위와 맞으면 범위. */
  private rangeOf(command: object, entries: readonly Entry[]): RangeMeta | null {
    const d = this.controller?.describe(command);
    const snap = d?.store === 'snapshot' ? d.snapshot?.before() ?? null : null;
    if (snap === null) return null;
    const r = this.engine.undoRange(entries);
    if (!r) return null;
    const before = { lo: r.lo, n: r.before };
    const cur = { lo: r.lo, n: r.after };
    // 명령이 기존 DocInfo 항목을 고쳤으면(범위 복원은 DocInfo 를 되돌리지 않는다) 여기서 걸러진다
    const v = this.engine.undoRangeCheck(snap, { section: r.section, src: before, dst: cur, counts: true });
    return v.ok ? { section: r.section, cur, before, after: null, hit: null } : null;
  }

  private rangeBlockReason(m: Meta, r: RangeMeta, d: Descriptor, dir: 'undo' | 'redo'): string | null {
    m.rangeMode = false;
    const message = dir === 'undo' ? UNDO_BLOCKED_NOTICE : REDO_BLOCKED_NOTICE;
    if (r.hit) return message;
    // 스위치 `remote`: 남의 기록이 없으면 문서 전체 복원(그대로 정확)
    if (!m.remoteSeen && this.rangeRestore === 'remote') return null;
    const snap = dir === 'undo' ? d.snapshot?.before() ?? null : d.snapshot?.after() ?? null;
    const src = dir === 'undo' ? r.before : r.after;
    // 원본 스냅샷이 없으면 범위로 할 수 없다 — 남의 기록이 없을 때만 문서 전체 복원
    if (snap === null || !src) return m.remoteSeen ? message : null;
    const v = this.engine.undoRangeCheck(snap, { section: r.section, src, dst: r.cur });
    if (!v.ok) {
      if (!m.remoteSeen) return null; // 남의 기록이 없으면 문서 전체 복원이 정확하다
      if (v.reason === 'docinfo') return dir === 'undo' ? UNDO_DOCINFO_NOTICE : REDO_DOCINFO_NOTICE;
      return message;
    }
    m.rangeMode = true;
    return null;
  }

  /** 히스토리의 `restoreSnapshot` 다리: 범위 복원으로 정한 명령이면 맡는다(엔진이 범위 표시 state 로 기록). */
  private restoreRange(command: object, dir: 'undo' | 'redo', id: number): boolean {
    const m = this.meta.get(command);
    if (!m?.range || !m.rangeMode) return false;
    m.rangeMode = false;
    const r = m.range;
    const d = this.controller?.describe(command);
    const expect = dir === 'undo' ? d?.snapshot?.before() : d?.snapshot?.after();
    const src = dir === 'undo' ? r.before : r.after;
    // 판정 때 본 스냅샷이 아니면 문서 전체 복원으로 물러서지 않는다(그사이 남의 편집까지 지운다) — 실패로 버리게 던진다
    if (id !== expect || !src) throw new Error(`범위 복원: 스냅샷 번호가 판정 때와 다름 (${id} ≠ ${String(expect)})`);
    this.engine.recordRangeRestore(id, { section: r.section, src, dst: { ...r.cur } });
    return true;
  }

  /**
   * 범위 명령의 되돌리기/다시 하기 뒤: 다른 명령의 위치는 "범위 [lo, lo+옛 개수) → 새 개수"의 지도로 옮긴다(범위 복원이든
   * 문서 전체 복원이든 같은 변경). 범위 갱신 — 되돌린 뒤: 대상 = 명령 전 개수, 다시 하기 원본 = 되돌리기 직전 스냅샷의 지금
   * 좌표. 다시 한 뒤: 대상 = 명령 후 개수, 원본 = 명령 전 스냅샷(처음 좌표).
   */
  private afterRangeJump(command: object, m: Meta, r: RangeMeta, dir: 'undo' | 'redo', lids: number[]): void {
    const oldN = r.cur.n;
    const newN = dir === 'undo' ? r.before.n : r.after?.n ?? r.cur.n;
    const map: Entry = { kind: 'op', m: '__undoFoot', a: [r.section, r.cur.lo, null], meta: { pd: newN - oldN, span: oldN } };
    this.mapLocal([map], new Set([command]));
    r.after = dir === 'undo' ? { lo: r.cur.lo, n: oldN } : null;
    r.cur = { lo: r.cur.lo, n: newN };
    r.hit = null;
    m.foot = [];
    m.whole = false;
    m.nested = false;
    m.remoteSeen = false;
    m.hit = null;
    m.rangeMode = false;
    if (dir === 'undo') {
      m.undoLids = new Set(lids);
    } else {
      m.lids = new Set(lids);
      m.undoLids = new Set();
    }
  }

  /** 범위 명령들의 범위를 기록 열로 옮긴다. `remote` 면 닿은 사유를 남긴다. 지도를 못 쓰면 막는다(원격일 때). */
  private mapRangesOf(commands: readonly object[], recs: readonly Entry[], remote: boolean): void {
    const metas = commands.map((c) => this.meta.get(c)).filter((m): m is Meta => Boolean(m?.range));
    if (metas.length === 0 || recs.length === 0) return;
    const ranges = metas.map((m) => ({ section: m.range!.section, lo: m.range!.cur.lo, hi: m.range!.cur.lo + m.range!.cur.n }));
    const out = this.engine.mapRanges(recs, ranges);
    metas.forEach((m, i) => {
      const r = m.range!;
      const o = out?.[i];
      if (!o) {
        if (remote) r.hit ??= 'unmapped';
        return;
      }
      r.cur = { lo: o.lo, n: o.hi - o.lo };
      if (remote && o.hit) r.hit ??= o.hit;
    });
  }

  /** 옮길 자리 모으기: 명령마다 위치 자리(같은 객체는 한 번) + 발자국. */
  private gather(exclude: ReadonlySet<object>): { commands: object[]; slots: Array<{ slot: Slot; at: number }>; feet: Array<{ m: Meta; at: number; n: number }>; items: UndoPosition[] } {
    const commands = this.all().filter((c) => !exclude.has(c));
    const seen = new Map<object, Set<string>>();
    const slots: Array<{ slot: Slot; at: number }> = [];
    const items: UndoPosition[] = [];
    const feet: Array<{ m: Meta; at: number; n: number }> = [];
    for (const cmd of commands) {
      const m = this.meta.get(cmd);
      const d = this.controller?.describe(cmd);
      if (d) {
        for (const s of d.slots) {
          const fields = seen.get(s.key) ?? new Set<string>();
          if (fields.has(s.field)) continue;
          fields.add(s.field);
          seen.set(s.key, fields);
          const p = s.get();
          if (!p) continue;
          slots.push({ slot: s, at: items.length });
          items.push(p);
        }
      }
      if (m && m.foot.length > 0) {
        feet.push({ m, at: items.length, n: m.foot.length });
        items.push(...m.foot);
      }
    }
    return { commands, slots, feet, items };
  }

  /** 내 기록으로 옮긴다(막힘 판정 없음). */
  private mapLocal(entries: readonly Entry[], exclude: ReadonlySet<object>): void {
    if (entries.length === 0 || !this.controller) return;
    const g = this.gather(exclude);
    this.mapRangesOf(g.commands, entries, false);
    if (g.items.length === 0) return;
    const out = this.engine.mapPositions(entries, g.items);
    if (!out) return;
    for (const { slot, at } of g.slots) slot.set(strip(out[at]));
    for (const f of g.feet) f.m.foot = out.slice(f.at, f.at + f.n).map(strip);
  }

  /** 남의 기록(지금 문서 좌표로 옮긴 열)으로 옮기고 막힘 사유를 모은다. */
  private mapRemote(remap: readonly Entry[]): void {
    const g = this.gather(new Set());
    for (const cmd of g.commands) {
      const m = this.meta.get(cmd);
      if (m) m.remoteSeen = true;
    }
    this.mapRangesOf(g.commands, remap, true);
    if (g.items.length === 0) return;
    const out = this.engine.mapPositions(remap, g.items);
    if (!out) {
      // 지도를 못 쓰면 위치를 믿을 수 없다 — 모두 막는다
      for (const cmd of g.commands) { const m = this.meta.get(cmd); if (m) m.hit ??= 'unmapped'; }
      return;
    }
    // 위치 자리의 'gone'(그 문단이 지워짐)도 막힘 — 자리가 어느 명령 것인지 거꾸로 찾는다
    const goneSlots = new Set<Slot>();
    for (const { slot, at } of g.slots) {
      if (out[at].hit === 'gone' && !slot.caret) goneSlots.add(slot);
      slot.set(strip(out[at]));
    }
    for (const f of g.feet) {
      const mapped = out.slice(f.at, f.at + f.n);
      const hit = mapped.find((p) => p.hit)?.hit ?? null;
      if (hit) f.m.hit ??= hit;
      f.m.foot = mapped.map(strip);
    }
    if (goneSlots.size > 0) {
      for (const cmd of g.commands) {
        const d = this.controller?.describe(cmd);
        const m = this.meta.get(cmd);
        if (m && d?.slots.some((s) => [...goneSlots].some((x) => x.key === s.key && x.field === s.field))) m.hit ??= 'gone';
      }
    }
  }

  /**
   * 버려진 기록을 만든 명령과, 그와 같은 문단에 발자국이 있는 명령을 뺀다. 되돌림 열이 불완전하면(`complete`
   * false) 문단 수를 바꾼 버려진 기록의 구역 명령도 뺀다(그 뒤 문단 번호를 바로잡을 지도가 없으므로).
   */
  private dropFor(dropped: ReadonlySet<number>, droppedEntries: readonly Entry[], complete: boolean): void {
    const victims = new Set<object>();
    let undoVictim = false;
    const commands = this.all();
    for (const cmd of commands) {
      const m = this.meta.get(cmd);
      if (!m) continue;
      if ([...m.lids].some((l) => dropped.has(l))) victims.add(cmd);
      if ([...m.undoLids].some((l) => dropped.has(l))) { victims.add(cmd); undoVictim = true; }
    }
    const victimFeet = [...victims].flatMap((c) => this.meta.get(c)?.foot ?? []);
    const victimRanges = [...victims].map((c) => this.meta.get(c)?.range).filter((r): r is RangeMeta => Boolean(r));
    // 문단 수를 바꾼 버려진 기록의 구역(null = 문서 전체) — 되돌림 열이 불완전할 때만
    const shifted = new Set<number | null>();
    for (const e of complete ? [] : droppedEntries) {
      if (e.kind === 'state') shifted.add(null);
      else if (!IN_PARAGRAPH.has(e.m)) shifted.add(typeof e.a[0] === 'number' ? e.a[0] : null);
    }
    for (const cmd of commands) {
      if (victims.has(cmd)) continue;
      const m = this.meta.get(cmd);
      if (!m) continue;
      const r = m.range;
      const sameParagraph = m.foot.some((f) => victimFeet.some((v) => samePara(f, v)) || victimRanges.some((vr) => inRange(f, vr)))
        || (r !== null && (victimFeet.some((v) => inRange(v, r)) || victimRanges.some((vr) => rangesMeet(vr, r))));
      const sameSection = shifted.has(null) || m.whole || m.foot.some((f) => shifted.has(f.section)) || (r !== null && shifted.has(r.section));
      if (sameParagraph || (shifted.size > 0 && sameSection)) victims.add(cmd);
    }
    if (victims.size === 0) return;
    this.controller?.remove(victims);
    if (undoVictim) this.notify(UNDO_DROPPED_NOTICE);
  }
}

const strip = (p: UndoPosition): UndoPosition => {
  const { hit: _hit, ...rest } = p;
  return rest;
};

const dedupe = (items: UndoPosition[]): UndoPosition[] => {
  const out: UndoPosition[] = [];
  for (const it of items) if (!out.some((o) => sameSpot(o, it))) out.push(it);
  return out;
};
