import { useRef, useState } from "react";
import { PosFinishError, usePosFinish, usePosModePreference } from "./api/pos-orders";
import { posFinishFailureMessage, posFinishSuccessMessage } from "./pos-mode";

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
  /** Confirm (+ invoice) the freshly created order; resolves with the toast copy to show. */
  const finishOrder = async (
    orderId: string,
    target?: { status?: string | null; merged?: boolean },
  ): Promise<string> => {
    const mode = finishRef.current;
    try {
      await finish.mutateAsync({
        orderId,
        invoice: mode === "invoice",
        fromStatus: target?.status,
      });
      return posFinishSuccessMessage(mode === "invoice");
    } catch (e) {
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
  ) => {
    toast(await finishOrder(orderId, target));
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
