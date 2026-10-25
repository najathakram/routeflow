import type * as React from "react";

/**
 * apple-ux r4 F05: while Edit Items is open, Ctrl+Enter (Cmd+Enter on a Mac) saves from any field, so a
 * keyboard user does not Tab through every line to reach Save Changes. A chord, never a bare key: Enter
 * alone still belongs to the field. Attach the returned handler to the edit area only (it is not mounted
 * outside an edit), and give the Save button `aria-keyshortcuts={SAVE_CHORD_KEYS}`.
 *
 * A dialog opened from the edit area (a picker, a confirm) keeps its own Enter: the chord is ignored when
 * it comes from inside one. `save` is the very handler the Save button runs, so the double-save latch,
 * the locked-line refusal and the missing-reason check all apply unchanged.
 */
export const SAVE_CHORD_KEYS = "Control+Enter Meta+Enter";

export function saveChordHandler(save: () => void, blocked: boolean) {
  return (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.repeat || e.defaultPrevented || blocked) return;
    if ((e.target as HTMLElement).closest?.('[role="dialog"], [role="alertdialog"]')) return;
    e.preventDefault();
    save();
  };
}
