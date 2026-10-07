import * as React from "react";

/**
 * Keyboard navigation for a combobox-style search + results list (ArrowUp/ArrowDown move the
 * highlight, Enter picks it, Escape closes). One implementation shared by the Create Order
 * customer/product searches and `SearchableProductPicker`.
 *
 * Scanner safety (PKG-4 guard): the highlight moves ONLY on an Arrow key. Typing or a refreshed
 * result list resets it to `initial` (-1 by default = nothing highlighted), so a wedge scan + Enter
 * keeps taking the caller's own Enter path and never silently picks a row.
 */
export interface UseListboxNavOptions<T> {
  items: readonly T[];
  /** Whether the results list is showing. A closed list ignores Arrow/Enter (returns false). */
  open: boolean;
  onPick: (item: T) => void;
  onClose?: () => void;
  /** Changing this (or the number of `items`) resets the highlight; pass the search text. */
  resetKey?: unknown;
  /** Highlight a fresh list starts at: -1 (default) = none, 0 = first row. */
  initial?: number;
  idPrefix: string;
}

export function useListboxNav<T>({
  items,
  open,
  onPick,
  onClose,
  resetKey,
  initial = -1,
  idPrefix,
}: UseListboxNavOptions<T>) {
  const [highlight, setHighlight] = React.useState(initial);

  React.useEffect(() => {
    setHighlight(initial);
    // Keyed on the result COUNT, not the array identity: callers re-derive `items` every render, and
    // an identity key would drop the highlight on each one.
  }, [resetKey, open, initial, items.length]);

  const optionId = (i: number) => `${idPrefix}-opt-${i}`;
  const listId = `${idPrefix}-list`;

  /** Returns true when the key was consumed (the caller then skips its own handling). */
  const onKeyDown = (e: React.KeyboardEvent): boolean => {
    if (e.defaultPrevented || !open) return false;
    if (e.key === "ArrowDown" && items.length > 0) {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, items.length - 1));
      return true;
    }
    if (e.key === "ArrowUp" && items.length > 0) {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, initial < 0 ? 0 : initial));
      return true;
    }
    if (e.key === "Enter" && highlight >= 0 && items[highlight] !== undefined) {
      e.preventDefault();
      e.stopPropagation();
      onPick(items[highlight]);
      return true;
    }
    if (e.key === "Escape" && onClose) {
      onClose(); // no preventDefault: an enclosing dialog's own Escape handling is the caller's call
      return true;
    }
    return false;
  };

  /** Spread on the search <input>. */
  const inputProps = {
    role: "combobox" as const,
    "aria-expanded": open,
    "aria-controls": listId,
    "aria-autocomplete": "list" as const,
    "aria-activedescendant": open && highlight >= 0 ? optionId(highlight) : undefined,
  };

  return { highlight, setHighlight, onKeyDown, inputProps, optionId, listId };
}
