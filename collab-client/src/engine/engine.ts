/**
 * collab 엔진 (docs/collab-stage2.md §5). studio 를 모른다 — 문서 핸들과 콜백만 받는다. 3단계에서 Node
 * 서버가 같은 모듈을 쓴다.
 *
 * 문서는 언제나 "서버 순서로 확정된 기록 + 내 미확정 기록" 이다. 남의 기록이 오면 확정 상태로 되감고, 그것을
 * 적용하고, 내 미확정을 보정해 다시 적용한다(되감기 방식 — 수렴이 구조적으로 보장된다, §4.1).
 *
 * 상태
 * - `snapshot`: 확정 상태 S 의 자체 스냅샷 id. 미확정이나 확정 대기열이 있을 때만 있다.
 * - `acked`: S 이후 서버가 확정한 내 기록(다음 되감기 때 S 위에 다시 얹는다 — 확정마다 스냅샷을 다시 뜨지
 *   않으려고 미룬다).
 * - `unconfirmed`: 아직 확정되지 않은 내 기록. 앞의 `sent` 개는 보냈다.
 *
 * 빠른 경로(R11): 미확정과 원격이 모두 text/neutral 이고 보정이 두 순서의 결과가 같다고 판정하면(`fastRemote`),
 * 되감지 않고 원격을 미확정 뒤로 옮긴 R' 를 지금 문서에 바로 적용한다. 스냅샷은 그대로 두고 원격을 `acked` 에
 * 더한다(다음 되감기 때 S 위에 서버 순서대로 얹힌다). 그 밖은 되감기 경로.
 */
import { classify } from './classify.ts';
import { base64ToBytes, bytesToBase64, decodeArgs, encodeArgs, UnencodableArgument } from './codec.ts';
import type { CatalogEntry } from './types.ts';

/** 기록 하나 (§3 기록 형태). */
export type Entry =
  | { kind: 'op'; m: string; a: unknown[]; meta?: Record<string, unknown>; ctx?: { activeField?: unknown; clipboard?: unknown; memoTime?: string } }
  | { kind: 'state'; data: string };

/** 엔진이 쓰는 문서 핸들 — `HwpDocument` 의 collab 보조 export 와, 이름으로 부를 변경 export 들. */
export interface EngineDoc {
  collabSnapshotSave(): number;
  collabSnapshotRestore(id: number): void;
  collabSnapshotDiscard(id: number): void;
  collabLoadState(bytes: Uint8Array): void;
  collabExportState(): Uint8Array;
  collabMeasure(phase: string, method: string, argsJson: string, beforeJson: string): string;
  collabGetActiveField(): string;
  collabSetActiveField(json: string): string;
  collabTextToLogical(section: number, para: number, offset: number, afterControl: boolean): number;
  collabLogicalToText(section: number, para: number, logical: number): string;
  collabTransform(pendingJson: string, remoteJson: string, catalogJson: string, caretJson: string): string;
  collabMapCaret(remoteJson: string, catalogJson: string, caretJson: string): string;
  /** 4단계: 되돌리기 스택의 위치들을 기록 열 뒤로 옮긴다(순수 함수). */
  collabMapPositions?(recsJson: string, catalogJson: string, itemsJson: string): string;
  /** 4단계: 명령이 만든 기록 열의 발자국. */
  collabFootprint?(entriesJson: string, catalogJson: string): string;
  /** 5단계 D4 클라이언트 문: 글자 연산 호출(호출 전)이 활성 누름틀 안에 완전히 드는가. */
  collabFieldContains?(method: string, argsJson: string, activeFieldJson: string): boolean;
  /** D6: 메모 목록(작성자 확인) — 업스트림 `getMemoList` */
  getMemoList?(): string;
  collabDigest(): string;
  collabFlushLayout(): void;
  /** rhwp 배치 괄호 — 안의 편집은 쪽 배치(pagination)를 끝에 한 번만 한다(R1 감사: 쪽 소속 확정만 미룸). */
  beginBatch?(): string;
  endBatch?(): string;
  /** R13 ctx.clipboard: 기록 쪽 — 내부 클립보드를 직렬화→다시 읽은 값으로 바꾸고 그 JSON. */
  collabNormalizeClipboard(): string;
  /** 재생 쪽 — 기록의 클립보드로 잠시 바꾼다 / 되돌린다. */
  collabPushClipboard(json: string): void;
  collabPopClipboard(): void;
  /** 메모 시각 고정(FILETIME 틱 10진 문자열, "" = 풂). 이전 값을 돌려준다. */
  collabSetMemoTime(ticks: string): string;
  collabMemoTimeNow(): string;
  /** 구역의 문단 수(읽기 전용 조회 — 기록 훅에 걸리지 않는다). 구조 연산의 문단 수 변화 `pd` 를 잰다(R13). */
  getParagraphCount(section: number): number;
}

/** 캐럿(텍스트 좌표). 셀이면 `cell` 이 있다. */
export interface TextCaret {
  section: number;
  para: number;
  offset: number;
  cell?: { control: number; cell: number; cellPara: number } | null;
}

export interface ReceiveResult {
  ok: boolean;
  rebased: boolean;
  /** R11 빠른 경로로 적용했다(되감지 않음) */
  fast?: boolean;
  /** 충돌·재적용 실패로 버린 내 기록 수 */
  dropped: number;
  /** 버린 기록(보정 전 원래 기록 — 충돌 지점부터, 재적용 실패면 보정된 기록) */
  droppedEntries?: Entry[];
  dropReason?: string;
  /** 4단계: 버린 기록의 로컬 번호(`drainLocalLog` 의 `lid`). 한 기록이 보정으로 쪼개졌으면 같은 번호. */
  droppedLids?: number[];
  /**
   * 4단계: 지금 문서 좌표를 새 좌표로 옮기는 지도 — 미확정이 없으면 원격 그대로, 있으면 원격을 남긴 미확정 뒤로
   * 옮긴 열(빠른 경로면 적용한 R′). 되돌리기 스택의 위치를 이것으로 옮긴다(캐럿과 같은 지도).
   */
  remap?: Entry[];
  /**
   * 4단계: 버린 내 기록의 되돌림 열(지금 문서 좌표, 앞에서부터) — `remap` 보다 먼저 적용하는 지도(내 기록이므로
   * 막힘 판정에는 쓰지 않는다). 버린 것이 없으면 빈 열.
   */
  remapLocal?: Entry[];
  /** 4단계: `remapLocal` 이 버린 기록을 모두 되돌리는가(state 처럼 되돌릴 수 없는 것을 버렸거나 재적용 실패면 false). */
  remapComplete?: boolean;
  caret: TextCaret | null;
  error?: string;
}

/** 4단계: 로컬 기록 하나와 그 번호(명령 ↔ 기록 연결). */
export interface LocalLogItem {
  lid: number;
  entry: Entry;
}

/** 4단계: 위치 하나(텍스트 좌표) — `collabMapPositions` 의 입력·출력. */
export interface UndoPosition extends TextCaret {
  bias?: 'before' | 'after';
  /**
   * U2: 셀 경로(중첩 포함, 바깥 → 안쪽). `[k].cellPara` 는 k 단계 칸의 문단 — 마지막이 위치의 칸 문단, 그 앞은 다음 단계
   * 표를 품은 문단. 한 단계면 `cell` 과 같다(출력은 둘 다 채운다).
   */
  cellPath?: Array<{ control: number; cell: number; cellPara: number }> | null;
  /**
   * U2: 문단으로 특정할 수 없는 자리. `section` 은 구역 안 어딘가(머리말·꼬리말 안, 구역 정의 등 — 같은 구역의 구조
   * 편집·구역 서식이 닿음), `sectionAll` 은 그 구역의 어떤 기록이든 닿는 지킴(구역 원본 저널에 기대는 되돌리기).
   */
  scope?: 'section' | 'sectionAll';
  /** 출력: 남의 기록이 닿았으면 첫 사유 */
  hit?: 'touched' | 'gone' | 'structural' | 'whole' | 'section' | null;
}

export interface EngineOptions {
  /** 분류표 조회. 기본은 생성된 분류표. */
  classify?: (name: string) => CatalogEntry;
  /** 로컬 기록이 추가됐다(호스트가 flush 를 예약한다). */
  onLocal?: () => void;
  /** 기록 경고(불변식 위반으로 state 로 바꿈 등). */
  onWarn?: (message: string) => void;
  /** 5단계 D4: 권한 문에서 막았다(문서는 그대로). 호스트가 안내한다. */
  onDenied?: (message: string, method: string) => void;
  /** R11 빠른 경로를 쓴다(기본 true). 끄면 언제나 되감는다(`?collabFast=0`). */
  fast?: boolean;
  /**
   * 시험용: 빠른 경로를 쓸 때마다 되감기 경로 결과를 따로 계산해 digest 를 비교한다(문서는 빠른 경로 결과로
   * 되돌린다). 다르면 `fastStats.mismatches` 에 남긴다.
   */
  verifyFast?: boolean;
}

/** 5단계 D4: 권한 문이 막은 호출. 문서 코어에 닿기 전에 던진다. */
export class PermissionDenied extends Error {
  readonly method: string;
  constructor(message: string, method: string) {
    super(message);
    this.name = 'PermissionDenied';
    this.method = method;
  }
}

/** 5단계 D4: 권한 문의 안내 문구(docs/collab-protocol.md §4.8). */
export const DENIED_TEXT = {
  view: '보기 권한이라 문서를 고칠 수 없습니다',
  form: '양식 칸에만 입력할 수 있습니다',
  comment: '메모만 달 수 있습니다',
  /** D6: comment 권한으로 남의 메모를 고치거나 지우려 함 */
  ownMemo: '자기 메모만 고칠 수 있습니다',
} as const;

/** D6: 메모를 만드는 함수 — `{author,text}` JSON 인자의 작성자를 세션 이름으로 바꿔 넣는다. */
const MEMO_AUTHORED = new Set(['insertMemo', 'insertMemoByPath', 'insertMemoReply']);
/** D6: comment 권한은 자기 메모만 고친다(답글은 누구의 메모에나). `setMemoShape` 은 구역 단위라 그 구역 메모가 모두 내 것일 때만. */
const OWN_MEMO_ONLY = new Set(['setMemoText', 'removeMemo', 'setMemoShape']);

/** 업스트림 `sanitize_author` 와 같은 정리(앞뒤 공백, `/`·`\`·`;`·제어 문자 뺌) — 저장된 작성자와 비교할 때 쓴다. */
export function sanitizeMemoAuthor(name: string): string {
  return name.trim().replace(/[/\\;\p{Cc}]/gu, '');
}

/** 빠른 경로 통계 (R11 측정·관문). */
export interface FastStats {
  /** 미확정이 있을 때 원격을 받은 횟수 중 빠른 경로 */
  fast: number;
  /** 되감기 경로 */
  slow: number;
  /** 빠른 경로 R' 적용이 예외로 실패해 되감기로 넘어간 횟수 */
  fallback: number;
  /** 되감기로 간 이유별 횟수 */
  blocks: Record<string, number>;
  /** verifyFast: 두 경로 결과가 달랐던 사례 */
  mismatches: Array<{
    pending: Entry[]; remote: Entry[]; fastRemote: Entry[]; rebased: Entry[]; error?: string;
    /** 진단: 빠른 경로 전 문서가 이미 S + 확정분 + 미확정과 달랐다(앞 단계에서 어긋남) */
    invariantBroken?: boolean;
    /** 진단: 확정 상태 S 의 내보내기(base64)와 확정분 */
    s?: string; acked?: Entry[];
  }>;
  /** 원격 수신 처리 시간(ms) 합 */
  fastMs: number;
  slowMs: number;
}

const callMethod = (doc: EngineDoc, name: string, args: unknown[]): unknown => {
  const fn = (doc as unknown as Record<string, unknown>)[name];
  if (typeof fn !== 'function') throw new Error(`문서에 ${name} 메서드가 없습니다`);
  return (fn as (...a: unknown[]) => unknown).apply(doc, args);
};

export class CollabEngine {
  private doc: EngineDoc | null = null;
  private snapshot: number | null = null;
  private acked: Entry[] = [];
  private unconfirmed: Entry[] = [];
  /** 4단계: `unconfirmed` 와 같은 자리의 로컬 번호들(보내지 않은 state 를 새 state 가 덮으면 번호가 모인다). */
  private lids: number[][] = [];
  private nextLid = 1;
  /** 4단계: 아직 호스트가 가져가지 않은 로컬 기록(명령 경계에서 `drainLocalLog`). */
  private localLog: LocalLogItem[] = [];
  private sent = 0;
  /** 원격 적용·되감기·재생 중 — 이때의 호출은 기록하지 않는다. */
  private replaying = false;
  private recording = false;
  private readonly classifyFn: (name: string) => CatalogEntry;
  private readonly onLocal: () => void;
  private readonly onWarn: (message: string) => void;
  private readonly onDenied: (message: string, method: string) => void;
  /** 5단계 D4: 이 연결의 권한(`welcome.user.scope`). `null` = 제한 없음(edit, 인증을 끈 서버). */
  private scope: { edit: boolean; form: boolean; comment: boolean } | null = null;
  /** D6: 메모 작성자로 쓸 세션 이름(`null` = 인증을 끈 서버, 넘긴 작성자 그대로) */
  private memoAuthor: string | null = null;
  private readonly fast: boolean;
  private readonly verifyFast: boolean;
  readonly fastStats: FastStats = { fast: 0, slow: 0, fallback: 0, blocks: {}, mismatches: [], fastMs: 0, slowMs: 0 };

  constructor(options: EngineOptions = {}) {
    this.classifyFn = options.classify ?? ((n) => classify(n));
    this.onLocal = options.onLocal ?? (() => {});
    this.onWarn = options.onWarn ?? ((m) => console.warn(`[collab engine] ${m}`));
    this.onDenied = options.onDenied ?? (() => {});
    this.fast = options.fast ?? true;
    this.verifyFast = options.verifyFast ?? false;
  }

  // ── 문서 연결 ─────────────────────────────────────────────────────

  /** 공유 문서 핸들을 정한다(이 객체의 호출만 기록한다). 상태를 비운다. */
  attach(doc: EngineDoc): void {
    this.reset();
    this.doc = doc;
  }

  /** 공유 문서를 놓는다(교체 중·방을 나감). 이후 어떤 객체의 호출도 기록하지 않는다. */
  detach(): void {
    this.reset();
    this.doc = null;
  }

  get attached(): EngineDoc | null {
    return this.doc;
  }

  setRecording(on: boolean): void {
    this.recording = on;
  }

  /**
   * D6: 메모 작성자로 쓸 세션 이름(서버가 확인한 이름 — 토큰의 `name`, 없으면 hello 의 이름). `null` 이면(인증을 끈
   * 서버) 넘긴 작성자 그대로. 메모를 만드는 호출의 `author` 를 이 이름으로 바꿔 core 에 넘기고 기록한다.
   */
  setMemoAuthor(name: string | null): void {
    this.memoAuthor = name;
  }

  /**
   * 5단계 D4: 권한을 정한다(공백 구분 문자열 또는 목록, `null` = 제한 없음). `edit` 가 없으면 권한 문이 켜진다:
   * 기록하는 호출(분류표 `op`·`state`·`watch`)을 문서 코어에 닿기 전에 판정하고, 허용되지 않으면 `PermissionDenied`.
   * `view`: 모두 거절. `form`: `perm: 'form'` 과, 활성 누름틀 안에 완전히 드는 글자 연산. `comment`: `perm: 'memo'`.
   */
  setScope(scope: string | readonly string[] | null): void {
    if (scope === null) {
      this.scope = null;
      return;
    }
    const list = typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : [...scope];
    const s = { edit: list.includes('edit'), form: list.includes('form'), comment: list.includes('comment') };
    this.scope = s.edit ? null : s;
  }

  /** 권한 문 판정. 허용이면 `null`, 아니면 안내 문구. */
  private denial(doc: EngineDoc, name: string, args: unknown[], info: CatalogEntry): string | null {
    const s = this.scope;
    if (!s) return null;
    if (info.perm === 'form' && s.form) return null;
    if (info.perm === 'memo' && s.comment) return OWN_MEMO_ONLY.has(name) ? this.ownMemoDenial(doc, name, args, info) : null;
    if (s.form && info.sync === 'op' && info.conc === 'text' && doc.collabFieldContains) {
      const af = doc.collabGetActiveField();
      if (af !== 'null') {
        let encoded: unknown[] | null = null;
        try { encoded = encodeArgs(args); } catch { encoded = null; }
        if (encoded && doc.collabFieldContains(name, JSON.stringify(encoded), af)) return null;
      }
    }
    return s.form ? DENIED_TEXT.form : s.comment ? DENIED_TEXT.comment : DENIED_TEXT.view;
  }

  /** D6: comment 권한의 메모 고치기·지우기·모양 — 대상 메모가 모두 내 것인가. 판정할 수 없으면 막는다. */
  private ownMemoDenial(doc: EngineDoc, name: string, args: unknown[], info: CatalogEntry): string | null {
    const me = this.memoAuthor === null ? null : sanitizeMemoAuthor(this.memoAuthor);
    let memos: Array<{ id: number; author: string; sectionIndex?: number }>;
    try { memos = JSON.parse(doc.getMemoList?.() ?? 'null'); } catch { memos = null as never; }
    if (me === null || !Array.isArray(memos)) return DENIED_TEXT.ownMemo;
    const params = info.params ?? [];
    let targets: typeof memos;
    if (name === 'setMemoShape') {
      const sec = args[params.indexOf('section_idx')];
      targets = memos.filter((m) => sec === -1 || m.sectionIndex === sec);
    } else {
      const id = args[params.indexOf('id')];
      targets = memos.filter((m) => m.id === id);
      if (targets.length === 0) return null; // 없는 메모 — core 가 거절한다(문서는 그대로)
    }
    return targets.every((m) => m.author === me) ? null : DENIED_TEXT.ownMemo;
  }

  /** D6: 메모를 만드는 호출의 `{author}` 를 세션 이름으로(인자 배열을 고친다 — 원래 호출도 이 배열로 부른다). */
  private stampMemoAuthor(args: unknown[], info: CatalogEntry): void {
    const at = (info.params ?? []).indexOf('json');
    if (at < 0 || typeof args[at] !== 'string' || this.memoAuthor === null) return;
    let input: unknown;
    try { input = JSON.parse(args[at] as string); } catch { return; } // core 가 거절한다
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    args[at] = JSON.stringify({ ...(input as Record<string, unknown>), author: this.memoAuthor });
  }

  /** 미확정·확정 대기·스냅샷을 모두 버린다. */
  reset(): void {
    if (this.doc && this.snapshot !== null) {
      try { this.doc.collabSnapshotDiscard(this.snapshot); } catch { /* 문서가 이미 해제됨 */ }
    }
    this.snapshot = null;
    this.acked = [];
    this.unconfirmed = [];
    this.lids = [];
    this.localLog = [];
    this.sent = 0;
  }

  get pendingCount(): number {
    return this.unconfirmed.length;
  }

  get unsentCount(): number {
    return this.unconfirmed.length - this.sent;
  }

  get hasSnapshot(): boolean {
    return this.snapshot !== null;
  }

  // ── 로컬 기록 (기록 훅이 부른다) ──────────────────────────────────

  /**
   * 감싼 메서드 호출 하나. `target` 이 공유 문서가 아니거나, 녹화 중이 아니거나, 재생 중이면 그대로 실행한다.
   * 반환값은 원래 메서드의 반환값이다.
   */
  intercept(name: string, args: unknown[], invoke: () => unknown, target: unknown): unknown {
    const doc = this.doc;
    if (!doc || target !== doc || this.replaying) return invoke();
    const info = this.classifyFn(name);
    if (info.sync === 'none' || info.sync === 'local') return invoke();
    // 5단계 D4 권한 문: 기록 여부와 상관없이(재동기화 중에도) 공유 문서의 편집 호출을 코어에 닿기 전에 판정한다.
    if (this.scope) {
      const denied = this.denial(doc, name, args, info);
      if (denied !== null) {
        this.onDenied(denied, name);
        throw new PermissionDenied(denied, name);
      }
    }
    if (MEMO_AUTHORED.has(name)) this.stampMemoAuthor(args, info);
    if (!this.recording) return invoke();

    const createdSnapshot = this.ensureSnapshot(doc);
    let digestBefore: string | null = null;
    let measureBefore: string | null = null;
    // R13: 발자국이 있는 구조 연산은 그 구역의 문단 수 변화(pd)를 잰다.
    const anchored = info.sync === 'op' && info.conc === 'structural' && info.section !== null && (info.roles ?? []).some((r) => r.kind === 'anchor');
    const footSec = anchored ? (args[info.section as number] as number) : -1;
    let parasBefore: number | null = null;
    let ctx: { activeField?: unknown; clipboard?: unknown; memoTime?: string } | undefined;
    try {
      if (info.layout) doc.collabFlushLayout();
      if (info.sync === 'watch') digestBefore = doc.collabDigest();
      if (info.sync === 'op' && info.conc === 'text') {
        measureBefore = doc.collabMeasure('before', name, JSON.stringify(encodeArgs(args)), '');
      }
      if (info.ctx?.includes('activeField')) ctx = { activeField: JSON.parse(doc.collabGetActiveField()) };
      // 붙여넣기: 받는 쪽은 직렬화→다시 읽은 클립보드로 붙이므로 나도 같은 값으로 붙인다(R13)
      if (info.ctx?.includes('clipboard')) ctx = { ...ctx, clipboard: JSON.parse(doc.collabNormalizeClipboard()) };
      // 메모를 만드는 함수는 지금 시각을 메모에 박는다 — 시각 T 를 정해 이 호출 하나 동안 고정하고 같이 보낸다
      if (info.ctx?.includes('memoTime')) ctx = { ...ctx, memoTime: doc.collabMemoTimeNow() };
      if (anchored && Number.isInteger(footSec)) parasBefore = doc.getParagraphCount(footSec);
    } catch (error) {
      if (createdSnapshot) this.dropSnapshotIfIdle(doc);
      throw error;
    }

    let result: unknown;
    const pinned = ctx?.memoTime !== undefined ? doc.collabSetMemoTime(ctx.memoTime) : null;
    try {
      result = invoke();
    } catch (error) {
      // 원래 호출이 실패하면 기록하지 않는다(대부분의 export 는 바꾸기 전에 검증한다).
      if (createdSnapshot) this.dropSnapshotIfIdle(doc);
      throw error;
    } finally {
      if (pinned !== null) doc.collabSetMemoTime(pinned);
    }

    let entry: Entry | null = null;
    if (info.sync === 'watch') {
      if (doc.collabDigest() !== digestBefore) {
        this.onWarn(`분류되지 않은 ${name} 가 문서를 바꿨다 — 결과로 보낸다`);
        entry = this.stateEntry(doc);
      }
    } else if (info.sync === 'state') {
      entry = this.stateEntry(doc);
    } else {
      try {
        entry = { kind: 'op', m: name, a: encodeArgs(args) };
      } catch (error) {
        if (!(error instanceof UnencodableArgument)) throw error;
        this.onWarn(`${name}: ${error.message} — 결과로 보낸다`);
        entry = this.stateEntry(doc);
      }
      if (entry.kind === 'op' && measureBefore !== null) {
        const after = JSON.parse(doc.collabMeasure('after', name, JSON.stringify(entry.a), measureBefore)) as { ok: boolean; meta?: Record<string, unknown> | null; reason?: string };
        if (!after.ok) {
          this.onWarn(`${name}: ${after.reason} — 결과로 보낸다`);
          entry = this.stateEntry(doc);
        } else if (after.meta) {
          entry.meta = after.meta;
        }
      }
      if (entry.kind === 'op' && ctx) entry.ctx = ctx;
      if (entry.kind === 'op' && parasBefore !== null) entry.meta = { ...(entry.meta ?? {}), pd: doc.getParagraphCount(footSec) - parasBefore };
    }

    if (entry) this.push(entry);
    else if (createdSnapshot) this.dropSnapshotIfIdle(doc);
    return result;
  }

  /**
   * 결과(문서 전체) 기록. 보낸 바이트를 **내 문서에도 다시 적재한다** — 내보내기→다시 읽기는 항등이 아니라서
   * (R4 시험에서 확인) 받는 쪽은 다시 읽은 문서를 갖는데 나만 원래 문서를 들고 있으면 갈린다. 1단계에서 base
   * 담당이 자기 base 를 다시 연 것과 같은 이유다.
   */
  private stateEntry(doc: EngineDoc): Entry {
    const bytes = doc.collabExportState();
    doc.collabLoadState(bytes);
    return { kind: 'state', data: bytesToBase64(bytes) };
  }

  private push(entry: Entry): void {
    const lid = this.nextLid++;
    this.localLog.push({ lid, entry });
    // 보내지 않은 state 가 끝에 있으면 새 state 가 그것을 포함한다 — 마지막 것만 남긴다.
    const last = this.unconfirmed[this.unconfirmed.length - 1];
    if (entry.kind === 'state' && last?.kind === 'state' && this.unconfirmed.length > this.sent) {
      this.unconfirmed[this.unconfirmed.length - 1] = entry;
      this.lids[this.lids.length - 1].push(lid);
    } else {
      this.unconfirmed.push(entry);
      this.lids.push([lid]);
    }
    this.onLocal();
  }

  /** 4단계: 지난번 이후 생긴 로컬 기록(번호와 함께)을 가져간다. 명령 경계에서 부른다. */
  drainLocalLog(): LocalLogItem[] {
    const out = this.localLog;
    this.localLog = [];
    return out;
  }

  private ensureSnapshot(doc: EngineDoc): boolean {
    if (this.snapshot !== null) return false;
    this.snapshot = doc.collabSnapshotSave();
    return true;
  }

  private dropSnapshotIfIdle(doc: EngineDoc): void {
    if (this.snapshot !== null && this.unconfirmed.length === 0 && this.acked.length === 0) {
      doc.collabSnapshotDiscard(this.snapshot);
      this.snapshot = null;
    }
  }

  // ── 전송·확정·거절 ───────────────────────────────────────────────

  /** 보내지 않은 기록. 부르면 보낸 것으로 친다. */
  takePending(): Entry[] {
    const out = this.unconfirmed.slice(this.sent);
    this.sent = this.unconfirmed.length;
    return out;
  }

  /** 서버가 내 기록 앞의 `n` 개를 확정했다. */
  ack(n: number): void {
    const done = this.unconfirmed.splice(0, Math.min(n, this.unconfirmed.length));
    this.lids.splice(0, done.length);
    this.sent = Math.max(0, this.sent - done.length);
    this.acked.push(...done);
    if (this.unconfirmed.length === 0 && this.doc) {
      // 지금 문서가 곧 확정 상태다.
      if (this.snapshot !== null) this.doc.collabSnapshotDiscard(this.snapshot);
      this.snapshot = null;
      this.acked = [];
    }
  }

  /** 서버가 거절했다(낡은 base). 미확정 전부를 다시 보낸다. */
  requeue(): void {
    this.sent = 0;
  }

  // ── 원격 적용 ─────────────────────────────────────────────────────

  /** 기록 하나를 지금 문서에 적용한다(기록하지 않음). `insertTextLogical` 재적용이면 논리 오프셋을 다시 잰다. */
  private applyEntry(doc: EngineDoc, entry: Entry): void {
    if (entry.kind === 'state') {
      doc.collabLoadState(base64ToBytes(entry.data));
      return;
    }
    const info = this.classifyFn(entry.m);
    if (info.layout) doc.collabFlushLayout();
    if (entry.m === 'insertTextLogical' && entry.meta?.relogical) {
      const [sec, para] = entry.a as number[];
      entry.a[2] = doc.collabTextToLogical(sec, para, entry.meta.offset as number, entry.meta.afterControl as boolean);
      delete entry.meta.relogical;
    }
    const args = decodeArgs(entry.a);
    const hasField = Boolean(entry.ctx && 'activeField' in entry.ctx);
    const hasClip = Boolean(entry.ctx && 'clipboard' in entry.ctx);
    const memoTime = typeof entry.ctx?.memoTime === 'string' ? entry.ctx.memoTime : null;
    const previous = hasField ? doc.collabSetActiveField(JSON.stringify(entry.ctx?.activeField ?? null)) : null;
    if (hasClip) doc.collabPushClipboard(JSON.stringify(entry.ctx?.clipboard ?? null));
    const pinned = memoTime !== null ? doc.collabSetMemoTime(memoTime) : null;
    try {
      callMethod(doc, entry.m, args);
    } finally {
      if (pinned !== null) doc.collabSetMemoTime(pinned);
      if (hasClip) doc.collabPopClipboard();
      if (previous !== null) doc.collabSetActiveField(previous);
    }
  }

  /** 보정에 넘길 분류표 조각. */
  private catalogFor(entries: readonly Entry[]): string {
    const out: Record<string, unknown> = {};
    for (const e of entries) {
      if (e.kind !== 'op' || out[e.m]) continue;
      const info = this.classifyFn(e.m);
      out[e.m] = { conc: info.conc, section: info.section, roles: info.roles ?? [] };
    }
    return JSON.stringify(out);
  }

  /**
   * 남의 기록 열(서버 순서)을 받는다. 캐럿은 텍스트 좌표로 받아 옮긴 값을 돌려준다.
   * `ok:false` 면 원격 적용 자체가 실패한 것 — 문서가 이미 어긋났으니 호스트가 재동기화한다.
   */
  receiveRemote(entries: readonly Entry[], caret: TextCaret | null): ReceiveResult {
    const doc = this.doc;
    if (!doc) return { ok: false, rebased: false, dropped: 0, caret, error: '공유 문서가 없습니다' };
    const remote = entries.map((e) => structuredClone(e)) as Entry[];
    this.replaying = true;
    try {
      if (this.unconfirmed.length === 0) {
        for (const e of remote) this.applyEntry(doc, e);
        this.ack(0); // 확정 대기열이 있으면 정리(미확정이 없으므로 지금 문서 = 확정)
        const mapped = caret ? JSON.parse(doc.collabMapCaret(JSON.stringify(remote), this.catalogFor(remote), JSON.stringify(caret))) : null;
        return { ok: true, rebased: false, dropped: 0, droppedLids: [], remap: remote, remapLocal: [], remapComplete: true, caret: mapped };
      }
      if (this.snapshot === null) throw new Error('미확정이 있는데 스냅샷이 없습니다');
      const t0 = performance.now();
      const pending = this.unconfirmed;
      const res = JSON.parse(doc.collabTransform(
        JSON.stringify(pending), JSON.stringify(remote),
        this.catalogFor([...pending, ...remote]), JSON.stringify(caret),
      )) as {
        pending: Entry[]; origin?: number[]; dropped: number[]; dropReasons: string[]; dropFrom: number | null; dropReason: string | null; caret: TextCaret | null;
        remoteAfter?: Entry[]; dropUndo?: Entry[]; dropUndoComplete?: boolean; fastRemote: Entry[] | null; fastBlock: string | null;
      };
      // 4단계: 보정된 미확정 각각의 로컬 번호(쪼개진 기록은 같은 번호)
      const oldLids = this.lids;
      const lidsOf = (j: number): number[] => oldLids[res.origin?.[j] ?? j] ?? [];

      // 빠른 경로 (R11): 지금 문서(S + 확정분 + 미확정)에 R' 를 바로 적용한다.
      if (this.fast && res.fastRemote) {
        const fastRemote = res.fastRemote;
        const beforeDigest = this.verifyFast ? doc.collabDigest() : '';
        let applied = true;
        try {
          for (const e of fastRemote) this.applyEntry(doc, structuredClone(e));
        } catch {
          applied = false; // 되감기 경로가 스냅샷부터 다시 하므로 반쯤 적용된 문서는 상관없다
          this.fastStats.fallback += 1;
        }
        if (applied) {
          const ackedBefore = this.acked;
          this.acked = [...ackedBefore, ...remote];
          this.unconfirmed = res.pending;
          this.lids = res.pending.map((_, j) => lidsOf(j));
          this.sent = 0;
          if (this.verifyFast) this.verifyFastPath(doc, ackedBefore, remote, pending, fastRemote, res.pending, beforeDigest);
          if (this.unconfirmed.length === 0) {
            doc.collabSnapshotDiscard(this.snapshot);
            this.snapshot = null;
            this.acked = [];
          }
          this.fastStats.fast += 1;
          this.fastStats.fastMs += performance.now() - t0;
          return { ok: true, rebased: true, fast: true, dropped: 0, droppedEntries: [], droppedLids: [], remap: fastRemote, remapLocal: [], remapComplete: true, caret: res.caret };
        }
      }
      const why = res.fastBlock ?? (this.fast ? 'R′ 적용 실패' : '빠른 경로 꺼짐');
      this.fastStats.blocks[why] = (this.fastStats.blocks[why] ?? 0) + 1;
      this.fastStats.slow += 1;

      // 되감기 → 확정분 재적용 → 원격 적용 → 새 확정 스냅샷 → 보정 → 재적용
      doc.collabSnapshotRestore(this.snapshot);
      for (const e of this.acked) this.applyEntry(doc, structuredClone(e));
      for (const e of remote) this.applyEntry(doc, structuredClone(e));
      doc.collabSnapshotDiscard(this.snapshot);
      this.snapshot = doc.collabSnapshotSave();
      this.acked = [];

      // R13: 꼬리를 통째로 버리지 않는다 — 버린 것은 인덱스 목록이다(나머지는 res.pending 에 보정돼 있다).
      const droppedEntries: Entry[] = (res.dropped ?? []).map((i) => pending[i]);
      const droppedLids = new Set<number>((res.dropped ?? []).flatMap((i) => oldLids[i] ?? []));
      let dropReason = res.dropReason ?? undefined;
      const kept: Entry[] = [];
      const keptLids: number[][] = [];
      let reapplyFailed = false;
      for (let i = 0; i < res.pending.length; i += 1) {
        try {
          this.applyEntry(doc, res.pending[i]);
          kept.push(res.pending[i]);
          keptLids.push(lidsOf(i));
        } catch (error) {
          // 재적용이 실패하면 그것과 그 뒤를 버린다(뒤는 그 위에서 만들어졌다). 앞은 이미 적용됐다.
          droppedEntries.push(...res.pending.slice(i));
          for (let j = i; j < res.pending.length; j += 1) for (const lid of lidsOf(j)) droppedLids.add(lid);
          reapplyFailed = true;
          const failed = res.pending[i];
          const what = failed.kind === 'op' ? `${failed.m}(${JSON.stringify(failed.a)})` : 'state';
          dropReason = `보정한 연산 재적용 실패: ${what}: ${error instanceof Error ? error.message : String(error)}`;
          break;
        }
      }
      const dropped = droppedEntries.length;
      this.unconfirmed = kept;
      this.lids = keptLids;
      this.sent = 0;
      if (kept.length === 0) {
        doc.collabSnapshotDiscard(this.snapshot);
        this.snapshot = null;
      }
      this.fastStats.slowMs += performance.now() - t0;
      return {
        ok: true, rebased: true, dropped, droppedEntries, dropReason, droppedLids: [...droppedLids],
        remap: res.remoteAfter ?? remote, remapLocal: res.dropUndo ?? [],
        remapComplete: !reapplyFailed && (res.dropUndoComplete ?? (res.dropped ?? []).length === 0),
        caret: res.caret,
      };
    } catch (error) {
      return { ok: false, rebased: false, dropped: 0, caret, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.replaying = false;
    }
  }

  /**
   * 시험용 (R11 관문): 빠른 경로 결과와 되감기 경로 결과(S + 확정분 + 원격 + 보정된 미확정)를 비교한다.
   * 문서는 빠른 경로 결과로 되돌린다.
   */
  private verifyFastPath(doc: EngineDoc, ackedBefore: Entry[], remote: Entry[], pending: Entry[], fastRemote: Entry[], rebased: Entry[], beforeDigest: string): void {
    if (this.snapshot === null) return;
    const fastDigest = doc.collabDigest();
    const here = doc.collabSnapshotSave();
    let error: string | undefined;
    let slowDigest = '';
    let invariantBroken = false;
    let sBytes = '';
    try {
      doc.collabSnapshotRestore(this.snapshot);
      sBytes = bytesToBase64(doc.collabExportState());
      for (const e of [...ackedBefore, ...pending]) this.applyEntry(doc, structuredClone(e));
      invariantBroken = doc.collabDigest() !== beforeDigest;
      doc.collabSnapshotRestore(this.snapshot);
      for (const e of [...ackedBefore, ...remote, ...rebased]) this.applyEntry(doc, structuredClone(e));
      slowDigest = doc.collabDigest();
    } catch (e) {
      error = `되감기 경로 적용 실패: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      doc.collabSnapshotRestore(here);
      doc.collabSnapshotDiscard(here);
    }
    if (error || slowDigest !== fastDigest) {
      this.fastStats.mismatches.push({
        pending: structuredClone(pending), remote: structuredClone(remote), fastRemote, rebased: structuredClone(rebased), error,
        invariantBroken, s: sBytes, acked: structuredClone(ackedBefore),
      });
    }
  }

  /**
   * 캐럿(텍스트 좌표)을 기록 열의 지도로 옮긴다(R10 다른 사람 커서 — 받은 캐럿을 그 뒤 원격·내 편집만큼 옮긴다).
   * 문서는 바꾸지 않는다.
   */
  mapCaret(entries: readonly Entry[], caret: TextCaret | null): TextCaret | null {
    const doc = this.doc;
    if (!doc || !caret || entries.length === 0) return caret;
    try {
      return JSON.parse(doc.collabMapCaret(JSON.stringify(entries), this.catalogFor(entries), JSON.stringify(caret))) as TextCaret | null;
    } catch {
      return caret;
    }
  }

  /** 마지막으로 기록한 내 기록(다른 사람 커서를 옮기는 데 쓴다). */
  /**
   * 4단계: 위치들을 기록 열(지금 문서 좌표, 순서대로) 뒤로 옮긴다. 원격 열이면 `hit` 이 막힘 판정의 재료다.
   * 문서가 없거나 WASM 이 이 보조를 모르면 `null`.
   */
  mapPositions(recs: readonly Entry[], items: readonly UndoPosition[]): UndoPosition[] | null {
    const doc = this.doc;
    if (!doc?.collabMapPositions) return null;
    if (recs.length === 0 || items.length === 0) return items.map((it) => ({ ...it, hit: null }));
    return JSON.parse(doc.collabMapPositions(JSON.stringify(recs), this.catalogFor(recs), JSON.stringify(items))) as UndoPosition[];
  }

  /** 4단계: 명령이 만든 기록 열의 발자국(기록이 끝난 문서 좌표). */
  /** 발자국. `nested` 는 U1 호환(언제나 false — U2 부터 중첩 셀을 `cellPath` 로 다룬다). */
  footprint(entries: readonly Entry[]): { items: UndoPosition[]; whole: boolean; nested: boolean } | null {
    const doc = this.doc;
    if (!doc?.collabFootprint) return null;
    return JSON.parse(doc.collabFootprint(JSON.stringify(entries), this.catalogFor(entries)));
  }

  get lastLocal(): Entry | null {
    return this.unconfirmed[this.unconfirmed.length - 1] ?? null;
  }

  /**
   * 여러 묶음을 한 번에 재생한다(늦은 참여·재동기화·정본 복원, S3-3). 상태를 비우고 적용한다(기록하지 않음).
   * 묶음마다 쪽 배치를 하지 않고 rhwp 배치 괄호(beginBatch/endBatch)로 끝에 한 번만 한다 — 조판에 기대는 연산
   * (`layout`)과 state 기록 앞에서는 괄호를 닫아 쪽 배치를 맞춘 뒤 적용한다. 결과는 묶음마다 재생한 것과 같다
   * (S3-3 측정: 20쪽 문서 10,000 묶음 digest 같음, 86.8s → 0.9s).
   */
  replayAll(batches: readonly { entries: readonly Entry[] }[]): void {
    const doc = this.doc;
    if (!doc) throw new Error('공유 문서가 없습니다');
    this.reset();
    this.replaying = true;
    const canBatch = typeof doc.beginBatch === 'function' && typeof doc.endBatch === 'function';
    let open = false;
    try {
      for (const batch of batches) {
        for (const e of batch.entries) {
          const needsLayout = e.kind === 'state' || this.classifyFn(e.m).layout === true;
          if (canBatch && needsLayout && open) { doc.endBatch!(); open = false; }
          if (canBatch && !needsLayout && !open) { doc.beginBatch!(); open = true; }
          this.applyEntry(doc, structuredClone(e) as Entry);
        }
      }
    } finally {
      if (open) doc.endBatch!();
      this.replaying = false;
    }
  }

  /** 재동기화·늦은 참여의 로그 재생. 상태를 비우고 적용한다(기록하지 않음). */
  replay(entries: readonly Entry[]): void {
    const doc = this.doc;
    if (!doc) throw new Error('공유 문서가 없습니다');
    this.reset();
    this.replaying = true;
    try {
      for (const e of entries) this.applyEntry(doc, structuredClone(e) as Entry);
    } finally {
      this.replaying = false;
    }
  }
}
