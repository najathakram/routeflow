/**
 * SA-1262 PR A (B1373 kept): the till's quantity-box keys, one place. The list handler in `CounterSaleScreen` asks
 * `isQtyBox` and `handsBackToScan`; it never matches on `type="number"` (the boxes may stop being number inputs later).
 */

/** The attribute every counter quantity box carries (qty, boxes, pieces, unit qty). */
export const QTY_BOX_SELECTOR = "input[data-qty-box]";

export function isQtyBox(el: EventTarget | null): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.hasAttribute("data-qty-box");
}

interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

/**
 * Whether this key hands the cursor back to the scan box: Enter in a quantity box, or a plain Tab out of the LAST quantity box
 * of its line after the clerk typed in it (`typed` is that box). Ctrl, Meta and Alt combinations are never a hand-back: a
 * modified Enter commits the held text (the box does that) and stays put, so the clerk sees the new total first.
 */
export function handsBackToScan(e: KeyLike, typed: HTMLElement | null): boolean {
  const t = e.target;
  if (!isQtyBox(t) || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key === "Enter") return true;
  if (e.key !== "Tab" || e.shiftKey || typed !== t) return false;
  const fields = t.closest("li")?.querySelectorAll(QTY_BOX_SELECTOR);
  return fields?.[fields.length - 1] === t;
}
