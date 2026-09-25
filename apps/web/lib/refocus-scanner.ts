import type { RefObject } from "react";

/**
 * B744 — the shared, guarded barcode-scanner re-arm.
 *
 * Screens that add a line (by scan, Enter or a mouse pick) re-focus their search / scan input a
 * few ms later so a barcode wedge's next scan lands there. Before B744 each screen did that with a
 * bare `setTimeout(() => ref.current?.focus(), N)` that fired unconditionally — so an operator who
 * had moved into a note in that window had focus yanked back into search mid-typing, and their
 * Enter then ran the half-typed text through the scan lookup (a phantom "New Product" modal, or a
 * phantom line when the text happened to match a product).
 *
 * The rule, evaluated when each timer FIRES (never when it is scheduled):
 * - skip if focus sits on a text-entry control other than the target — typing is never stolen;
 * - otherwise focus the target exactly as before — nothing focused, <body>, a button, a checkbox,
 *   a link, a Radix dialog container, or the target itself. Scanning never dies: after a mouse
 *   pick in a Radix dialog, focus rests on the dialog's container div, and a stricter
 *   "only from nothing or <body>" rule would refuse every re-arm there.
 *
 * Deliberately NOT routed through here: a one-time autofocus when a screen opens (e.g. order
 * edit's B62 mount focus) and an explicit Escape handler moving focus back to search — different
 * triggers with their own intent.
 */

/** Input types that do not take typed text; any other type (and any future one) is protected. */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "file",
  "image",
  "range",
  "color",
  "hidden",
]);

function isTextEntryElement(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(el.type);
  if (el.isContentEditable) return true;
  // jsdom does not implement isContentEditable; read the (inheritable) attribute as well.
  return el.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/**
 * Whether the focused element takes typed text: a textarea, a select, contenteditable, or an
 * input whose type is not one of the non-text types above. Readonly and disabled are not
 * inspected — a focused text-entry control is protected regardless.
 */
export function isTextEntryActive(doc: Document = document): boolean {
  return isTextEntryElement(doc.activeElement);
}

/**
 * Re-arm the scanner: after each delay, focus `ref`'s input — and with `select`, select its text
 * so the next wedge scan overwrites rather than appends — unless the operator is typing in some
 * other text-entry field by then. Each delay is guarded on its own. A target that is null or
 * unmounted when a timer fires is a no-op. Returns a cancel function that clears every pending
 * timer.
 */
export function scheduleScannerRefocus(
  ref: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  delaysMs: number | readonly number[],
  opts: { select?: boolean } = {},
): () => void {
  const delays = typeof delaysMs === "number" ? [delaysMs] : delaysMs;
  const timers = delays.map((ms) =>
    setTimeout(() => {
      const target = ref.current;
      if (!target || !target.isConnected) return;
      const active = target.ownerDocument.activeElement;
      if (active !== target && isTextEntryElement(active)) return;
      target.focus();
      if (opts.select) target.select();
    }, ms),
  );
  return () => timers.forEach((t) => clearTimeout(t));
}
