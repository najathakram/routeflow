import { isTextEntryElement } from "@/lib/refocus-scanner";

/**
 * SA-1138: where a scan goes when focus is not in a text field. ONE rule for "this key starts a scan run": a printable key
 * pressed while focus is on something that is not a text field (a button, a handle, a checkbox, the page), whatever its case.
 * Key order only: nothing here reads a clock (the burst-timing rule was withdrawn in #4293, and a pin fails on a clock word).
 * Destinations stay with their surfaces: the till's scan box, the order builder's line Search.
 */

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey"> & {
  // method syntax: React's synthetic events type the argument as a narrower union
  getModifierState?(key: string): boolean;
};

/** A Radix Select / Menu / combobox typeahead owns the printable keys while its list or trigger holds focus. */
const TYPEAHEAD_OWNER =
  '[role="listbox"],[role="menu"],[role="combobox"],[data-radix-popper-content-wrapper],[data-radix-select-viewport],[data-radix-menu-content]';

/** One character, not Space, and no Ctrl / Meta / Alt (AltGr, which types a character, counts). */
export function isScanKey(e: KeyLike): boolean {
  if (e.key.length !== 1 || e.key === " ") return false;
  if (e.getModifierState?.("AltGraph") === true) return true;
  return !e.ctrlKey && !e.metaKey && !e.altKey;
}

/** `isScanKey` and focus is not a text field (a field inside a closing dialog is not one) and not a typeahead owner. */
export function startsScanRun(
  e: KeyLike,
  focused: Element | null = document.activeElement,
): boolean {
  if (!isScanKey(e)) return false;
  if (isTextEntryElement(focused)) return false;
  return !focused?.closest(TYPEAHEAD_OWNER);
}

/**
 * Focus `field` and hand it the key as the field's own keydown. For a field with a key detector of its own (the line Search's
 * wedge detector hears keydowns on the field only); the browser still types a printable key itself.
 */
export function handScanKeyTo(field: HTMLElement, e: { key: string; code: string }): void {
  field.focus();
  field.dispatchEvent(
    new KeyboardEvent("keydown", { key: e.key, code: e.code, bubbles: true, cancelable: true }),
  );
}

const IGNORED_KEYS = ["Shift", "CapsLock", "Alt", "Control", "Meta", "AltGraph"];

/**
 * The key-order state a surface needs to send a whole scan to one field: arm on a scan key, send the Enter that ends the run
 * (and one more Enter after it, a CR+LF scanner) to the field, reset on any other key or a pointer press.
 */
export function createFieldScanRun() {
  let state: "idle" | "run" | "afterEnter" = "idle";
  return {
    reset(): void {
      state = "idle";
    },
    /**
     * Call from a capture-phase keydown. Returns true when the key was handed to the field. A printable key is NOT stopped
     * (a keyboard line move still has to see it and cancel); only the Enter that ends a run is.
     */
    onKeyDown(e: KeyboardEvent, field: HTMLElement | null): boolean {
      if (!field) {
        state = "idle";
        return false;
      }
      if (IGNORED_KEYS.includes(e.key)) return false;
      if (startsScanRun(e)) {
        handScanKeyTo(field, e);
        state = "run";
        return true;
      }
      if (e.key === "Enter" && state !== "idle" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTextEntryElement(document.activeElement)) {
          state = "afterEnter"; // the field has it: its own Enter ends the run
          return false;
        }
        handScanKeyTo(field, e);
        e.preventDefault();
        e.stopPropagation();
        state = state === "run" ? "afterEnter" : "idle";
        return true;
      }
      if (isScanKey(e) && state !== "idle") return false; // a scan key typed inside a text field: the run goes on
      state = "idle";
      return false;
    },
  };
}
