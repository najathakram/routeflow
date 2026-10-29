import type * as React from "react";

/**
 * apple-ux r5 N04: Ctrl+Enter (Cmd+Enter on a Mac) creates the order from any field of the Create Order dialog, the
 * same chord as Edit Items' save (r4 F05). A chord, never a bare key: Enter alone still belongs to the field (the
 * form swallows it, so a stray Enter can never create an order).
 *
 * It presses the very Create Order button (`form="create-order-form"`), so every guard on that button applies as it
 * does to a click: disabled while saving, while the fulfilment or a price layer is still loading, or while a line waits
 * on its default unit; and the click handler's own state (the finish mode) is set the same way. A dialog opened from
 * inside this one (the merge prompt, the licence capture) keeps its own keys: the chord is ignored when it comes from
 * a dialog other than the one holding the form.
 */
export const CREATE_CHORD_KEYS = "Control+Enter Meta+Enter";

/** "⌘↵" on a Mac, "Ctrl+↵" elsewhere: the label of the small hint beside Create Order. */
export function createChordLabel(): string {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform ?? "");
  return mac ? "⌘↵" : "Ctrl+↵";
}

/** True when the key was the chord (and the Create Order button was pressed or refused by its disabled state). */
export function createOrderChord(e: React.KeyboardEvent<HTMLElement>): boolean {
  if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
  if (e.repeat || e.defaultPrevented) return false;
  const nearestDialog = (e.target as HTMLElement).closest?.(
    '[role="dialog"], [role="alertdialog"]',
  );
  if (nearestDialog && !nearestDialog.contains(e.currentTarget)) return false;
  e.preventDefault();
  e.currentTarget.ownerDocument
    .querySelector<HTMLButtonElement>('button[type="submit"][form="create-order-form"]')
    ?.click();
  return true;
}
