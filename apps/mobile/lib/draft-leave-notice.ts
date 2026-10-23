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
}): string | null {
  if (!i.draftId || !i.parkable || i.submitted) return null;
  return DRAFT_SAVED_ON_LEAVE;
}
