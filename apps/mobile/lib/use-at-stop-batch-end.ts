import * as React from "react";
import { decideAtStopBatchEnd, type AtStopBatchEnd } from "./at-stop-cr-outcome";

/**
 * The end of an at-door batch, as its OWN signal. The screen used to flag "the batch completed" in a ref and consume it in
 * an effect keyed on `[saving, added]`. That effect only re-runs when one of those CHANGES, and the resume after the
 * driver reads the restricted block does `setSaving(true)` and, with no entry left, `setSaving(false)` in the same tick:
 * React batches the two, `saving` is unchanged, the effect never ran, and the driver saw no confirmation at all.
 *
 * `markEnded()` bumps a counter that IS an effect dependency, so every end of a batch re-runs the effect after the commit;
 * the effect then waits for `saving` to settle false and reads the SETTLED draft list (a concurrent re-scan's own
 * `setAdded` may not have committed when the batch finished). It fires `onEnd` exactly once per `markEnded()`.
 */
export function useAtStopBatchEnd(args: {
  saving: boolean;
  added: ReadonlyArray<unknown>;
  /** Read at the settled moment: did an entry go to the office during this batch? */
  handedToOffice: () => boolean;
  onEnd: (end: AtStopBatchEnd) => void;
}): { markEnded: () => void } {
  const [ended, setEnded] = React.useState(0);
  const pending = React.useRef(false);
  const latest = React.useRef(args);
  latest.current = args;

  const markEnded = React.useCallback(() => {
    pending.current = true;
    setEnded((n) => n + 1);
  }, []);

  React.useEffect(() => {
    if (!pending.current || args.saving) return;
    pending.current = false;
    const { added, handedToOffice, onEnd } = latest.current;
    onEnd(decideAtStopBatchEnd({ added, handedToOffice: handedToOffice() }));
  }, [ended, args.saving, args.added]);

  return { markEnded };
}
