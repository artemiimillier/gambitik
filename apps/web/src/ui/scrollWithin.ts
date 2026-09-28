/**
 * Brings `element` into view inside its nearest scrolling box (a move list) — and NEVER scrolls the page itself.
 * `element.scrollIntoView()` also scrolls every ancestor up to the window: on a phone, where the move list sits under
 * the board, that pulled the whole page down after every move.
 */
export function scrollIntoViewWithin(element: HTMLElement | null | undefined): void {
  if (!element || typeof window === 'undefined') return;
  let box: HTMLElement | null = element.parentElement;
  while (box && box !== document.body && box !== document.documentElement) {
    const style = window.getComputedStyle(box);
    const scrollsY = /(auto|scroll)/.test(style.overflowY) && box.scrollHeight > box.clientHeight;
    const scrollsX = /(auto|scroll)/.test(style.overflowX) && box.scrollWidth > box.clientWidth;
    if (scrollsY || scrollsX) {
      const boxRect = box.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      if (scrollsY) {
        if (rect.top < boxRect.top) box.scrollTop -= boxRect.top - rect.top;
        else if (rect.bottom > boxRect.bottom) box.scrollTop += rect.bottom - boxRect.bottom;
      }
      if (scrollsX) {
        if (rect.left < boxRect.left) box.scrollLeft -= boxRect.left - rect.left;
        else if (rect.right > boxRect.right) box.scrollLeft += rect.right - boxRect.right;
      }
      return;
    }
    box = box.parentElement;
  }
}
