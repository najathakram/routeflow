/**
 * SA-1059: a touch-first device is a phone or tablet whose PRIMARY input is a finger: no hover, a coarse pointer. There the
 * soft keyboard rises over whatever takes the cursor, so the counter stops putting the cursor in the scan field and offers
 * the camera instead. A desktop till (mouse, or a barcode wedge on a laptop) answers false, so it behaves exactly as before.
 *
 * Read when needed, not cached: it is false when `matchMedia` is missing (jsdom, an old browser, the server), which keeps every
 * test and every desktop on today's behaviour.
 */
export const TOUCH_FIRST_QUERY = "(hover: none) and (pointer: coarse)";

export function isTouchFirst(): boolean {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(TOUCH_FIRST_QUERY).matches === true;
  } catch {
    return false;
  }
}
