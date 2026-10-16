import * as React from "react";
import type { PricePlanWrite } from "./selection";

/**
 * STUB until the lead's SPRINT-CONTRACT names the real save hook. It rejects, so the Change prices panel
 * shows its error line instead of pretending a price was saved.
 */
export function usePricePlanSave(): {
  save: (write: PricePlanWrite) => Promise<void>;
  isPending: boolean;
} {
  const save = React.useCallback((write: PricePlanWrite) => {
    void write;
    return Promise.reject(new Error("Saving prices is not available yet."));
  }, []);
  return { save, isPending: false };
}
