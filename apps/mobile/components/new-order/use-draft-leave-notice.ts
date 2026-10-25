import { useCallback, useEffect, useRef } from "react";
import { showToast } from "../../lib/toast";
import { announceAfterFlush, draftLeaveNotice } from "../../lib/draft-leave-notice";

/**
 * Row 699: Create Order's leave notice. The screen's `beforeRemove` listener is registered once, so parkability and a
 * finalized submit are read through refs AT LEAVE TIME, and the draft id from `getDraftId()` then. With `leave`, the hook
 * registers that listener itself (Discard stays in DraftStrip): flush the draft, then "Draft saved" only after the flush succeeded (a failed save raises
 * its own error via `onError`, never the notice).
 */
export function useDraftLeaveNotice(
  getDraftId: () => string | null,
  parkable: boolean,
  leave?: {
    navigation: unknown;
    flush: () => Promise<void>;
    onSaved: () => void;
    onError: (err: unknown) => void;
    /** A submit is in flight at leave time (read lazily: the screen declares its ref later). */
    isSubmitting: () => boolean;
  },
) {
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
  // The latest callbacks, read at leave time: the screen passes them inline, and the listener is registered once per screen.
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  const navigation = leave?.navigation;
  useEffect(() => {
    if (!navigation) return;
    const nav = navigation as {
      addListener: (event: "beforeRemove", cb: () => void) => () => void;
    };
    return nav.addListener("beforeRemove", () => {
      const l = leaveRef.current;
      if (!l) return;
      const saved = () => (l.onSaved(), announce(l.isSubmitting()));
      void announceAfterFlush(l.flush, saved, l.onError);
    });
  }, [navigation, announce]);
  return { announce, markFinalized };
}
