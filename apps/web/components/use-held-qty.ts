import * as React from "react";

/**
 * SA-1262 PR A: opt-in entry mode for a quantity box. Absent = the row's own per-keystroke commit. `commit: "enter"` (the
 * counter only) holds ALL the box's text until Enter, Tab or blur, then commits it once, so a barcode scanned into a focused
 * box is judged as one whole number instead of committing each digit prefix. Kept apart from `acceptSums`.
 */
export interface QtyEntry {
  commit: "enter";
}

/** Props to spread on a qty `<input>` in hold mode; null when the mode is off (the caller keeps its own handlers). */
export interface HeldQtyProps {
  "data-qty-held"?: "";
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * `committed` is the number the line holds; `commit` gets the parsed text once (NaN = unparseable: the caller refuses it).
 * The held text lives in a ref as well as state: it is cleared BEFORE the commit, so the blur that follows an Enter's refocus
 * (or a stale blur) finds nothing to commit. Esc drops it. A change of the committed number under the held text (Undo merge,
 * another tab's cart) drops it too, so a later blur never commits a stale value.
 */
export function useHeldQty(
  committed: number,
  commit: (n: number) => void,
  entry?: QtyEntry,
): HeldQtyProps | null {
  const [held, setHeld] = React.useState<string | null>(null);
  const ref = React.useRef<string | null>(null);
  const put = (text: string | null) => {
    ref.current = text;
    setHeld(text);
  };
  React.useEffect(() => {
    ref.current = null;
    setHeld(null);
  }, [committed]);
  if (entry?.commit !== "enter") return null;
  const flush = () => {
    const text = ref.current;
    if (text === null) return;
    put(null);
    commit(parseInt(text, 10));
  };
  return {
    ...(held === null ? null : { "data-qty-held": "" as const }),
    value: held ?? String(committed),
    onChange: (e) => put(e.target.value),
    onBlur: flush,
    onKeyDown: (e) => {
      if (e.key === "Enter") flush();
      else if (e.key === "Escape") put(null);
    },
  };
}

/** The one line shown beside the boxes while any holds uncommitted text (SA-1262 G7); null otherwise. */
export const heldNote = (...boxes: Array<HeldQtyProps | null>): React.ReactNode =>
  boxes.some((b) => b?.["data-qty-held"] !== undefined)
    ? React.createElement(
        "span",
        { role: "status", className: "text-[10px] text-navy/70" },
        "press Enter",
      )
    : null;
