/**
 * The dashboard shell's keyboard navigation: "g" then a letter jumps to a page ("g i" = Invoices), "?" toggles the help.
 *
 * A screen that holds work a navigation would throw away (the counter sale's cart) opts out by rendering an element with
 * `data-nav-shortcuts-suspended="true"` while it holds that work: the "g" sequences are then ignored everywhere on the page,
 * whatever has focus (a button after "Add note" is not a text field, so the editable-target check alone cannot save the cart).
 */

/** Put this attribute (value "true") on any rendered element to switch the g-sequences off while it is mounted. */
export const NAV_SHORTCUTS_SUSPENDED_ATTR = "data-nav-shortcuts-suspended";

/** True while a mounted screen has asked for the g-sequences to be off. */
export function navShortcutsSuspended(doc: Document = document): boolean {
  return doc.querySelector(`[${NAV_SHORTCUTS_SUSPENDED_ATTR}="true"]`) !== null;
}

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
  push: (href: string) => void;
  /** "g r" / "g d" only exist for a tenant with routes */
  routesAccess: boolean;
  /** "g t" only exists for a tenant with counter sales */
  counterEnabled: boolean;
  toggleHelp: () => void;
  now?: () => number;
}

/** A keydown handler for `window`. State (the half-typed sequence) lives in the closure: build one per effect run. */
export function createNavShortcutHandler(deps: NavShortcutDeps): (e: KeyboardEvent) => void {
  const now = deps.now ?? Date.now;
  let sequence = "";
  let lastAt = 0;

  const go = (seq: string) => {
    switch (seq) {
      case "go":
        return deps.push("/orders");
      case "gr":
        return deps.routesAccess ? deps.push("/routes") : undefined;
      case "gd":
        return deps.routesAccess ? deps.push("/drivers") : undefined;
      case "gc":
        return deps.push("/customers");
      case "gi":
        return deps.push("/invoices");
      case "gf":
        return deps.push("/finance/dashboard");
      case "gs":
        return deps.push("/settings");
      case "gt":
        return deps.counterEnabled ? deps.push("/orders/counter-sale") : undefined;
      case "gh":
        return deps.push("/dashboard");
      default:
        return undefined;
    }
  };

  return (e: KeyboardEvent) => {
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

    // A screen holding work that a jump would lose (the counter cart) switches the g-sequences off.
    if (navShortcutsSuspended()) {
      sequence = "";
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
