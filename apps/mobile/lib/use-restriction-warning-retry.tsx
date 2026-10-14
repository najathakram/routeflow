import * as React from "react";
import type { RestrictionAck } from "@routeflow/types";
import {
  RestrictionWarningModal,
  type RestrictionModalView,
} from "../components/RestrictionWarningModal";
import {
  mergeAck,
  parseDriverRestrictionBlock,
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

/** How long a typed reason is kept for a second 409 of the SAME save (a re-show comes one round trip after "Sell anyway"). */
const REASON_KEPT_MS = 15_000;

/**
 * Row 510: ONE hook per staff write flow (mobile twin of web's useRestrictionWarningRetry). The flow:
 *   - sends `rw.attach(vars)` (a plain payload when there is no pending ack), and
 *   - in its error path calls `rw.handle(err, retry)`: true = a RESTRICTION_WARNING (or a driver's hard block) was shown
 *     and the flow must stop; false = not ours, carry on with the flow's own handling.
 * "Sell anyway" calls `retry()` with the ack pending, so the flow re-runs its own submit and `attach` adds the ack to the
 * SAME payload exactly once (consumed on read). A second 409 with a fresh list re-shows the modal with the new lines and
 * the reason already typed. Render `rw.modal` once.
 */
export function useRestrictionWarningRetry() {
  const [view, setView] = React.useState<RestrictionModalView | null>(null);
  const [seq, setSeq] = React.useState(0);
  const retryRef = React.useRef<Retry | null>(null);
  const ackRef = React.useRef<RestrictionAck | null>(null);
  const reasonRef = React.useRef("");
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const forgetReason = React.useCallback(() => {
    reasonRef.current = "";
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  React.useEffect(() => () => forgetReason(), [forgetReason]);

  const handle = React.useCallback((err: unknown, retry: Retry): boolean => {
    const warning = parseRestrictionWarning(err);
    const blocked = warning ? null : parseDriverRestrictionBlock(err);
    if (!warning && !blocked) return false;
    retryRef.current = retry;
    setSeq((n) => n + 1);
    setView(warning ? { kind: "warning", warning } : { kind: "blocked", ...blocked! });
    return true;
  }, []);

  const attach = React.useCallback(
    ((vars: string | object) => {
      const ack = ackRef.current;
      ackRef.current = null;
      return mergeAck(vars as string, ack);
    }) as Attach,
    [],
  );

  const modal = (
    <RestrictionWarningModal
      key={seq}
      view={view}
      initialReason={reasonRef.current}
      onCancel={() => {
        forgetReason();
        retryRef.current = null;
        setView(null);
      }}
      onConfirm={(ack, reason) => {
        const retry = retryRef.current;
        retryRef.current = null;
        reasonRef.current = reason;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(forgetReason, REASON_KEPT_MS);
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
