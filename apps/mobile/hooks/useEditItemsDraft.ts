import { useRef, useState } from "react";
import type { DraftItem } from "../lib/edit-items-draft";

/**
 * The stateful half of edit-items.tsx's draft record — extracted so the
 * screen shrinks to a single hook call (B805, size-ratchet-driven).
 *
 * SA-108: `draft` is keyed by the line's own identity, never productId —
 * see hydrateFromOrder/resolveDraftKeyForPick (lib/edit-items-draft.ts).
 *
 * SA-108d (E44 correction of SA-108a): `draftRef` is a manually-kept-fresh
 * mirror of `draft`. React's functional setState eager-dispatch path needs
 * BOTH the fiber's AND its alternate's lanes empty — after this
 * component's own earlier state-driven renders the alternate can retain
 * stale lanes, so even the FIRST setDraft call of a burst is often
 * deferred too, not just the second. A ref write placed INSIDE the
 * updater is therefore never reliable as a synchronization point.
 * Instead: assigned here on every render, AND at every mutation's own
 * call site via `draftRef.current = fn(draftRef.current)` (a pure
 * transform, run once synchronously by us) immediately before handing
 * that SAME pure function to `setDraft` — never inside a setDraft updater
 * itself, so it never depends on whether or when React actually invokes it.
 *
 * B805: `updateDraft(fn)` is the ONE write path every draft mutator in the
 * screen goes through (setQty, setBoxes, setPieces, setUnits, setSellBy,
 * setUnitLabel, setLinePrice, setLineNote, removeLine, the price-override modal, the
 * last-added strip's price edit, the substitute-apply branch, and
 * addPickedToDraft). `fn` MUST be pure: it may run twice for one logical
 * call — once here, synchronously, to keep `draftRef` an accurate
 * same-tick mirror, and once more whenever React actually processes the
 * functional setState update it's also handed (eager or deferred, never
 * reliably either one). A writer with its own side effect (e.g.
 * removeLine's pendingDeletes append) must perform that OUTSIDE `fn`,
 * never inside it.
 *
 * `setDraft` is still returned directly for the three WHOLE-draft
 * lifecycle replacements (hydrateFromOrder on order load, the on-device
 * snapshot restore, and the post-save rebuild) — none of those are a
 * same-tick burst with another mutator, so the per-render ref sync alone
 * keeps `draftRef` correct for them; only the per-line EDIT mutators need
 * `updateDraft`'s synchronous ref update.
 */
export function useEditItemsDraft() {
  const [draft, setDraft] = useState<Record<string, DraftItem>>({});
  const draftRef = useRef<Record<string, DraftItem>>({});
  draftRef.current = draft;
  const updateDraft = (fn: (d: Record<string, DraftItem>) => Record<string, DraftItem>) => {
    draftRef.current = fn(draftRef.current);
    setDraft(fn);
  };
  return { draft, setDraft, draftRef, updateDraft };
}
