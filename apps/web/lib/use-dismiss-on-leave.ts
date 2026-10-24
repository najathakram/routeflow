import * as React from "react";

/**
 * The ONE close-on-leave behaviour for a search field with a popup list (row 446, W-686; the third copy of it, now shared).
 * Tab, or focus moving anywhere outside the popup's own list, closes the popup so it never sits over the next field; focus
 * moving INTO the list keeps it open. A press inside the list keeps focus on the input (Safari never focuses a clicked
 * button, so a blur would close the list before the click lands).
 *
 * Spread `inputProps` on the <input> and `listProps` on the popup's list container:
 *   const leave = useDismissOnLeave(setOpen);
 *   <input {...leave.inputProps} />
 *   {open && <div {...leave.listProps}>...</div>}
 */
export function useDismissOnLeave(setOpen: (open: boolean) => void) {
  const listRef = React.useRef<HTMLDivElement>(null);
  return {
    inputProps: {
      onBlur: (e: React.FocusEvent) => {
        if (!listRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      },
      // Tab leaves the field: close first, so focus moves to the next field, never into the list
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === "Tab") setOpen(false);
      },
    },
    listProps: {
      ref: listRef,
      onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
    },
  };
}
