"use client";

import * as React from "react";
import type { RestrictionAck } from "@routeflow/types";
import {
  RestrictionWarningDialog,
  type RestrictionDialogView,
} from "@/components/RestrictionWarningDialog";
import {
  isRepeatWarning,
  mergeAck,
  type IdWithAck,
  parseRestrictionHardBlock,
  parseRestrictionWarning,
} from "@/lib/api/restriction-warning";

/** The flow's own submit; it may be async (then the ack stays pending until it has sent). */
type Retry = () => void | PromiseLike<unknown>;

/** `attach(payload)` = the payload (plus the pending ack, once); `attach(id)` = the bare id until there is an ack to carry. */
interface Attach {
  (vars: string): IdWithAck;
  <T extends object>(vars: T): T;
}

/**
 * Row 510: ONE hook per staff write flow. The flow does two things:
 *   - sends `rw.attach(vars)` (a plain payload when there is no pending ack), and
 *   - in its error path calls `rw.handle(err, retry)`: true = a RESTRICTION_WARNING (or a driver's hard block) was shown
 *     and the flow must stop; false = not ours, carry on with the flow's own handling.
 * "Sell anyway" calls `retry()` synchronously with the ack pending, so the flow re-runs its own submit and `attach` adds
 * the ack to the SAME payload exactly once (it is consumed on read, so it can never ride an unrelated later send).
 * A REPEAT 409 is keyed on the hash, never a clock: the dialog was shown with hash H1, the user re-sent with H1, and the
 * answer is a warning with H2 ≠ H1, so the server's list changed. The dialog re-shows with the new lines, a polite "The
 * list changed; review it again" notice and an EMPTY reason: a reason typed for the old list is never reused for a new
 * one. The same hash again, or a first warning, is not a repeat (the reason is kept / empty). `attach` with no pending ack
 * is a fresh attempt and forgets the old hash and reason, so an earlier save never makes a later warning look like a
 * repeat. Render `rw.dialog` once.
 */
export function useRestrictionWarningRetry() {
  const [view, setView] = React.useState<RestrictionDialogView | null>(null);
  const [seq, setSeq] = React.useState(0);
  const [listChanged, setListChanged] = React.useState(false);
  const retryRef = React.useRef<Retry | null>(null);
  const ackRef = React.useRef<RestrictionAck | null>(null);
  const reasonRef = React.useRef("");
  /** The warningHash the user last acknowledged (the re-send in flight); null = no re-send is pending. */
  const sentHashRef = React.useRef<string | null>(null);

  const forgetReason = React.useCallback(() => {
    reasonRef.current = "";
  }, []);

  const handle = React.useCallback(
    (err: unknown, retry: Retry): boolean => {
      const warning = parseRestrictionWarning(err);
      const blocked = warning ? null : parseRestrictionHardBlock(err);
      if (!warning && !blocked) return false;
      // The answer to our re-send carries a DIFFERENT hash: the list changed. Nothing else makes a repeat.
      const repeat = !!warning && isRepeatWarning(sentHashRef.current, warning.warningHash);
      if (repeat || !warning) forgetReason();
      if (!warning) sentHashRef.current = null;
      setListChanged(repeat);
      retryRef.current = retry;
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

  const dialog = (
    <RestrictionWarningDialog
      key={seq}
      view={view}
      initialReason={reasonRef.current}
      listChanged={listChanged}
      onCancel={() => {
        forgetReason();
        sentHashRef.current = null;
        retryRef.current = null;
        setListChanged(false);
        setView(null);
      }}
      onConfirm={(ack, reason) => {
        const retry = retryRef.current;
        retryRef.current = null;
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

  return { handle, attach, dialog };
}
