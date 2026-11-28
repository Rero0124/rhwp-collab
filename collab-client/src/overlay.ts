/**
 * 공동편집이 studio 위에 띄우는 대화 칸(launcher 대화상자, 이름 칸)의 공통 처리 — studio 의 키보드·포커스가 그 칸을
 * 건드리지 않게 한다. studio 를 import 하지 않는다(그 약속 — 클래스 이름·사건 이름 — 만 쓴다).
 *
 * - 뿌리에 studio 의 모달 표시(`modal-overlay`)를 붙인다. studio 는 이것이 있으면 편집·그리기 뒤에 textarea 로 포커스를
 *   되가져가지 않는다(input-handler `focusTextarea`). 이 표시가 없으면 문서를 처음 그리는 중에 포커스가 넘어가 칸에 치던
 *   글자가 문서로 간다. 모양은 칸의 인라인 스타일이 정한다(studio 의 `.modal-overlay` 스타일도 같은 고정 전면 층이다).
 * - 입력 칸의 키·입력·조합·붙여넣기 사건을 그 칸에서 멈춘다(studio 의 전역 단축키·입력 처리로 올라가지 않게 — 글자 넣기·
 *   Enter 로 보내기 같은 기본 동작은 그대로).
 * - 닫을 때 마지막 대화 칸이었으면 studio 의 "대화상자 닫힘" 사건을 보내 편집기 포커스를 되돌린다(studio 대화상자와 같다).
 */
export const STUDIO_MODAL_CLASS = 'modal-overlay';
const STUDIO_MODAL_CLOSED_EVENT = 'rhwp-modal-dialog-closed';
const SHIELDED_EVENTS = [
  'keydown', 'keypress', 'keyup', 'beforeinput', 'input',
  'compositionstart', 'compositionupdate', 'compositionend', 'paste', 'copy', 'cut',
] as const;

/** 대화 칸의 뿌리를 studio 에 모달로 알린다 */
export function markModal(root: HTMLElement): void {
  root.classList.add(STUDIO_MODAL_CLASS);
}

/** 입력 칸의 사건이 studio 로 올라가지 않게 한다 */
export function shieldInput(el: HTMLElement): void {
  for (const type of SHIELDED_EVENTS) el.addEventListener(type, (e) => e.stopPropagation());
}

/** 뿌리 안의 입력 칸(input·textarea) 모두 */
export function shieldInputs(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('input, textarea'))) shieldInput(el);
}

/** 칸에 포커스를 준다 — 지금, 그리고 다음 틱에 한 번 더(열자마자 다른 것이 포커스를 가져가도 칸으로) */
export function focusInput(el: HTMLElement): void {
  el.focus();
  setTimeout(() => { if (el.isConnected && document.activeElement !== el) el.focus(); }, 0);
}

/** 대화 칸을 닫는다. 마지막 모달이었으면 studio 가 편집기 포커스를 되돌리게 알린다. */
export function closeModal(root: HTMLElement | null): void {
  if (!root?.isConnected) return;
  root.remove();
  if (!document.querySelector(`.${STUDIO_MODAL_CLASS}`)) document.dispatchEvent(new Event(STUDIO_MODAL_CLOSED_EVENT));
}
