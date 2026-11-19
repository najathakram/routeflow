/**
 * The dashboard shell's keyboard navigation: "g" then a letter jumps to a page ("g i" = Invoices; the letters come from the menu, see nav-index), "?" toggles the help.
 *
 * Typing is never hijacked (an editable target or focus in a text field resets the sequence). Every jump goes through the
 * counter's shared leave guard: with a cart holding lines it opens the same "Discard this sale?" dialog as every other way
 * out (a button after "Add note" is not a text field, so the editable-target check alone cannot save the cart), mid-sale it
 * is refused with the notice, and off the counter it just navigates.
 */
import { guardCounterLeave } from "./counter-cart-signal";
import { SHORTCUT_KEYS } from "@/app/(dashboard)/_components/nav-index";

/** Every key of the map, for a caller that does not pass the menu's own (a bare handler in a test). */
const ALL_TARGETS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SHORTCUT_KEYS).map(([href, letter]) => [letter, href]),
);

/** An element the user types text into (input, textarea, select, contenteditable). */
export function isEditableElement(el: EventTarget | Element | null | undefined): boolean {
  const node = el as HTMLElement | null | undefined;
  if (!node) return false;
  const tag = node.tagName;
  return (
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable === true
  );
}

/** How long a half-typed sequence ("g" waiting for its letter) stays alive. */
const SEQUENCE_MS = 800;

export interface NavShortcutDeps {
  /** The RAW router push: the handler asks `guardCounterLeave` itself, so a guarded push here would ask twice. */
  push: (href: string) => void;
  /** letter -> page for "g" + letter: the shortcuts of the menu this person has (navShortcutTargets), so a key never
   *  opens a page the menu does not hold. */
  targets?: Readonly<Record<string, string>>;
  /** Ignored: the keys come from the menu now. Kept optional only so older callers still type-check. */
  routesAccess?: boolean;
  /** Ignored, see routesAccess. */
  counterEnabled?: boolean;
  toggleHelp: () => void;
  now?: () => number;
}

/** A keydown handler for `window`. State (the half-typed sequence) lives in the closure: build one per effect run. */
export function createNavShortcutHandler(deps: NavShortcutDeps): (e: KeyboardEvent) => void {
  const now = deps.now ?? Date.now;
  let sequence = "";
  let lastAt = 0;

  // Ask the leave guard first; Discard runs the raw push once (the parked leave is never re-asked).
  const nav = (path: string) => {
    if (!guardCounterLeave(() => deps.push(path))) deps.push(path);
  };

  const go = (seq: string) => {
    const href = (deps.targets ?? ALL_TARGETS)[seq.slice(1)];
    return href ? nav(href) : undefined;
  };

  return (e: KeyboardEvent) => {
    // Skip while a window holds the scan (SA-1066 F10): a barcode's letters are not shortcuts, and focus on a box is not "typing".
    if (document.querySelector("[data-scan-pause]")) return;
    // Skip if the user is typing: the event target, or whatever holds focus.
    if (isEditableElement(e.target) || isEditableElement(document.activeElement)) {
      sequence = "";
      return;
    }
    // Skip if modifier keys held (except shift for ?)
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === "?") {
      deps.toggleHelp();
      return;
    }

    if (e.key.length !== 1) return; // Shift, Tab, arrows...: not part of a sequence
    const t = now();
    if (t - lastAt > SEQUENCE_MS) sequence = "";
    lastAt = t;
    sequence += e.key.toLowerCase();
    if (!sequence.startsWith("g")) {
      sequence = "";
      return;
    }

    if (/^g[a-z]$/.test(sequence)) {
      const seq = sequence;
      sequence = "";
      go(seq);
    }
  };
}
