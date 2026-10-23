import { DRAFT_SAVED_ON_LEAVE } from "./order-draft-copy";

export { DRAFT_SAVED_ON_LEAVE };

/**
 * Row 699 (604 audit; decisions/sa/699-preread.md): leaving Create Order kept a draft WITHOUT saying so. Say where it is,
 * but ONLY when a draft really remains, judged AT LEAVE TIME: a server draft id (`getDraftId()`, never a render's stale
 * `draftId`), the screen still parkable (`draftParkable`: a customer and at least one line), and not submitted (a submit
 * pills and discards the draft first). Otherwise say nothing.
 */
export function draftLeaveNotice(i: {
  draftId: string | null;
  parkable: boolean;
  submitted: boolean;
  /** A submit is still in flight: its own outcome speaks (never "Draft saved" over an order being placed). */
  submitting?: boolean;
}): string | null {
  if (!i.draftId || !i.parkable || i.submitted || i.submitting) return null;
  return DRAFT_SAVED_ON_LEAVE;
}

/**
 * Row 699 review MUST: "Draft saved" only after the save really happened. The leave flush is awaited; a rejected flush
 * (offline: drafts are not on the offline allow-list; the draft deleted elsewhere: 404) reports its error and says NOTHING.
 * It also covers leaving within the 900 ms debounce of the first line (the create is still pending until the flush).
 */
export async function announceAfterFlush(
  flush: () => Promise<void>,
  onSaved: () => void,
  onError: (err: unknown) => void,
): Promise<void> {
  try {
    await flush();
  } catch (err) {
    onError(err);
    return;
  }
  onSaved();
}
