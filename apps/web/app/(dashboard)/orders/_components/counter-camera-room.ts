/**
 * SA-1059 MUST 10: the layout arithmetic behind "the scan bar rests at the top while the camera strip is open" (see the layout
 * effects in CounterSaleScreen). Kept out of the screen: it reads the DOM, not React state.
 */

/** Tailwind's `md`: from here up the checkout bar is not floating over the scroller, so the strip needs no help. */
export const MD_UP_QUERY = "(min-width: 768px)";

export function isMdUp(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.(MD_UP_QUERY).matches === true;
}

/**
 * Sizes the spacer so the scroller can scroll the sticky scan bar all the way to its top, and returns the scrollTop that puts
 * it there. The spacer is reset first: it is part of the page height being measured.
 */
export function fitCameraRoom(
  main: HTMLElement,
  bar: HTMLElement,
  room: HTMLElement | null,
): number {
  if (room) room.style.height = "0px";
  const target =
    main.scrollTop + (bar.getBoundingClientRect().top - main.getBoundingClientRect().top);
  const short = target + main.clientHeight - main.scrollHeight;
  if (room && short > 0) room.style.height = `${Math.ceil(short)}px`;
  return target;
}
