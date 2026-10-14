import { useRef, useState } from "react";
import { PosFinishError, usePosFinish, usePosModePreference } from "./api/pos-orders";
import { posFinishFailureMessage, posFinishSuccessMessage } from "./pos-mode";
import type { useRestrictionWarningRetry } from "./use-restriction-warning-retry";

/** Row 510: the screen's warning hook (its `attach` and `handle`); the finish borrows them, it never builds its own modal. */
export type RestrictionRetry = Pick<
  ReturnType<typeof useRestrictionWarningRetry>,
  "attach" | "handle"
>;

/**
 * POS mode (SA-763r P-2) state for NewOrderScreen: the staff-only switch (seeded from
 * GET /users/me/preferences, written with PATCH on flip, never AsyncStorage) and the
 * "Confirm & invoice" finish that runs after the order is created.
 */
export function usePosModeState(enabled: boolean) {
  const pref = usePosModePreference();
  const [override, setOverride] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const finish = usePosFinish();
  // Which finishing action was pressed ("Confirm & invoice" vs "Confirm only"); survives the merge prompt.
  const finishRef = useRef<"invoice" | "confirm">("invoice");
  const posMode = enabled && (override ?? pref.seeded);
  const flip = (next: boolean) => {
    const previous = override ?? pref.seeded;
    setOverride(next);
    setFailed(false);
    pref.save.mutate(next, {
      onError: () => {
        setOverride(previous);
        setFailed(true);
      },
    });
  };
  /**
   * Confirm (+ invoice) the freshly created order; resolves with the toast copy to show.
   * Row 510: with `rw`, the request carries a pending ack (`rw.attach`) and a RESTRICTION_WARNING on the confirm opens the
   * shared modal (`rw.handle` reads the failed step's CAUSE: PosFinishError wraps the axios error). Resolves `null` then:
   * "Sell anyway" runs `again`, "Go back" runs `dismissed`, and the caller shows nothing meanwhile.
   */
  const finishOrder = async (
    orderId: string,
    target?: { status?: string | null; merged?: boolean },
    rw?: RestrictionRetry,
    again?: () => void | PromiseLike<unknown>,
    dismissed?: () => void,
  ): Promise<string | null> => {
    const mode = finishRef.current;
    const vars = { orderId, invoice: mode === "invoice", fromStatus: target?.status };
    try {
      await finish.mutateAsync(rw ? rw.attach(vars) : vars);
      return posFinishSuccessMessage(mode === "invoice");
    } catch (e) {
      if (rw && again && rw.handle(e instanceof PosFinishError ? e.cause : e, again, dismissed)) {
        return null;
      }
      return posFinishFailureMessage(
        e instanceof PosFinishError ? e.step : "confirm",
        !!target?.merged,
      );
    }
  };
  /** Confirm (+ invoice), toast the outcome, then open the new order (Hand over / Print live there). */
  const finishAndOpen = async (
    orderId: string,
    target: { status?: string | null; merged?: boolean },
    toast: (m: string) => void,
    open: () => void,
    rw?: RestrictionRetry,
  ): Promise<void> => {
    const again = () => finishAndOpen(orderId, target, toast, open, rw);
    // "Go back" sells nothing: the order exists but is not confirmed, so say so and open it (as any other failed confirm).
    const dismissed = () => {
      toast(posFinishFailureMessage("confirm", !!target.merged));
      open();
    };
    const msg = await finishOrder(orderId, target, rw, again, dismissed);
    if (msg === null) return; // the modal is up
    toast(msg);
    open();
  };
  return {
    /** The fulfil path the merge preview should look for (POS = PICKUP). */
    activePath: posMode ? ("PICKUP" as const) : undefined,
    finishAndOpen,
    posMode,
    flip,
    failed,
    busy: pref.prefs.isPending || pref.save.isPending,
    finishRef,
    finishOrder,
  };
}
