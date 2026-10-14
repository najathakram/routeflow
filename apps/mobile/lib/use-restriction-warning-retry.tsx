import * as React from "react";
import type { RestrictionAck } from "@routeflow/types";
import {
  RestrictionWarningModal,
  type RestrictionModalView,
} from "../components/RestrictionWarningModal";
import {
  isRepeatWarning,
  mergeAck,
  parseRestrictionHardBlock,
  parseRestrictionWarning,
  type IdWithAck,
} from "./restriction-warning";

/** The flow's own submit; it may be async (then the ack stays pending until it has sent). */
type Retry = () => void | PromiseLike<unknown>;

/** `attach(payload)` = the payload (plus the pending ack, once); `attach(id)` = the bare id until there is an ack to carry. */
interface Attach {
  (vars: string): IdWithAck;
  <T extends object>(vars: T): T;
}

/**
 * Row 510: ONE hook per staff write flow (mobile twin of web's useRestrictionWarningRetry). The flow:
 *   - sends `rw.attach(vars)` (a plain payload when there is no pending ack), and
 *   - in its error path calls `rw.handle(err, retry)`: true = a RESTRICTION_WARNING (or a driver's hard block) was shown
 *     and the flow must stop; false = not ours, carry on with the flow's own handling.
 * "Sell anyway" calls `retry()` with the ack pending, so the flow re-runs its own submit and `attach` adds the ack to the
 * SAME payload exactly once (consumed on read). A REPEAT 409 is keyed on the hash, never a clock: the modal was shown
 * with hash H1, the user re-sent with H1, and the answer is a warning with H2 ≠ H1, so the server's list changed. The modal
 * re-shows with the new lines, a polite "The list changed; review it again" notice and an EMPTY reason: a reason typed for
 * the old list is never reused. The same hash again, or a first warning, is not a repeat. `attach` with no pending ack is
 * a fresh attempt and forgets the old hash and reason, so an earlier save never makes a later warning look like a repeat.
 * Render `rw.modal` once.
 *
 * `handle(err, retry, onDismiss?)`: `onDismiss` runs when the modal is closed WITHOUT selling ("Go back", the driver
 * block's OK, the Android back button), so a flow that must carry on (the driver's at-stop batch) or must say what did not
 * happen (the POS finish) can. It never runs after "Sell anyway".
 */
export function useRestrictionWarningRetry() {
  const [view, setView] = React.useState<RestrictionModalView | null>(null);
  const [seq, setSeq] = React.useState(0);
  const [listChanged, setListChanged] = React.useState(false);
  const retryRef = React.useRef<Retry | null>(null);
  const dismissRef = React.useRef<(() => void) | null>(null);
  const ackRef = React.useRef<RestrictionAck | null>(null);
  const reasonRef = React.useRef("");
  /** The warningHash the user last acknowledged (the re-send in flight); null = no re-send is pending. */
  const sentHashRef = React.useRef<string | null>(null);

  const forgetReason = React.useCallback(() => {
    reasonRef.current = "";
  }, []);

  const handle = React.useCallback(
    (err: unknown, retry: Retry, onDismiss?: () => void): boolean => {
      const warning = parseRestrictionWarning(err);
      const blocked = warning ? null : parseRestrictionHardBlock(err);
      if (!warning && !blocked) return false;
      // The answer to our re-send carries a DIFFERENT hash: the list changed. Nothing else makes a repeat.
      const repeat = !!warning && isRepeatWarning(sentHashRef.current, warning.warningHash);
      if (repeat || !warning) forgetReason();
      if (!warning) sentHashRef.current = null;
      setListChanged(repeat);
      retryRef.current = retry;
      dismissRef.current = onDismiss ?? null;
      setSeq((n) => n + 1);
      setView(warning ? { kind: "warning", warning } : { kind: "blocked", ...blocked! });
      return true;
    },
    [forgetReason],
  );

  const attach = React.useCallback(
    ((vars: string | object) => {
      const ack = ackRef.current;
      ackRef.current = null;
      if (!ack) {
        // a fresh attempt, not our re-send: nothing from an earlier warning applies to it
        sentHashRef.current = null;
        reasonRef.current = "";
      }
      return mergeAck(vars as string, ack);
    }) as Attach,
    [],
  );

  const modal = (
    <RestrictionWarningModal
      key={seq}
      view={view}
      initialReason={reasonRef.current}
      listChanged={listChanged}
      onCancel={() => {
        const dismissed = dismissRef.current;
        dismissRef.current = null;
        forgetReason();
        sentHashRef.current = null;
        retryRef.current = null;
        setListChanged(false);
        setView(null);
        dismissed?.();
      }}
      onConfirm={(ack, reason) => {
        const retry = retryRef.current;
        retryRef.current = null;
        dismissRef.current = null; // sold: "closed without selling" no longer applies
        reasonRef.current = reason;
        sentHashRef.current = ack.warningHash ?? null;
        setView(null);
        if (!retry) return;
        ackRef.current = ack;
        const clear = () => {
          ackRef.current = null;
        };
        try {
          const done = retry();
          // An async submit (it awaits before it sends) keeps the ack until it has sent; a sync one clears it now.
          if (done && typeof done.then === "function") void done.then(clear, clear);
          else clear();
        } catch (e) {
          clear();
          throw e;
        }
      }}
    />
  );

  return { handle, attach, modal };
}
