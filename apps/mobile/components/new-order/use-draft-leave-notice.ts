import { useCallback, useRef } from "react";
import { showToast } from "../../lib/toast";
import { draftLeaveNotice } from "../../lib/draft-leave-notice";

/**
 * Row 699: Create Order's leave notice. The screen's `beforeRemove` listener is registered once, so parkability and a
 * finalized submit are read through refs AT LEAVE TIME, and the draft id from `getDraftId()` then.
 */
export function useDraftLeaveNotice(getDraftId: () => string | null, parkable: boolean) {
  const parkableRef = useRef(parkable);
  parkableRef.current = parkable;
  /** Set when the submit path pills and discards the draft: leaving after a submit says nothing. */
  const finalizedRef = useRef(false);
  /** Call only after a SUCCESSFUL flush (announceAfterFlush). `submitting`: a submit is in flight at leave time. */
  const announce = useCallback(
    (submitting = false) => {
      const notice = draftLeaveNotice({
        draftId: getDraftId(),
        parkable: parkableRef.current,
        submitted: finalizedRef.current,
        submitting,
      });
      if (notice) showToast(notice);
    },
    [getDraftId],
  );
  const markFinalized = useCallback(() => {
    finalizedRef.current = true;
  }, []);
  return { announce, markFinalized };
}
