"use client";

import * as React from "react";

/**
 * apple-ux r5 N10: Save Changes on Edit Items closes the editor and the page used to stay wherever the operator had
 * scrolled (the add-line row, far down the card), with the saved lines above the fold. After a SAVE the Line Items
 * card top comes into view; cancelling, publishing away or merely opening the editor does not scroll.
 *
 * `markSaved()` is called from the save's success handler; the scroll waits for the editor to actually close (the
 * card then holds its read-only cards) so it measures the final height. Instant under reduced motion.
 */
export function useScrollAfterSave(isEditing: boolean) {
  const cardRef = React.useRef<HTMLDivElement>(null);
  const pending = React.useRef(false);
  React.useEffect(() => {
    if (isEditing || !pending.current) return;
    pending.current = false;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    cardRef.current?.scrollIntoView?.({ block: "start", behavior: reduced ? "auto" : "smooth" });
  }, [isEditing]);
  const markSaved = React.useCallback(() => {
    pending.current = true;
  }, []);
  return { cardRef, markSaved };
}
