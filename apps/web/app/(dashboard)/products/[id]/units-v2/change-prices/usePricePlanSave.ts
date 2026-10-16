import type { PricePlanWrite } from "./selection";

/** STUB until SPRINT-CONTRACT names the real save hook: it rejects, so the panel shows an error, never a fake save. */
export function usePricePlanSave(): {
  save: (write: PricePlanWrite) => Promise<void>;
  isPending: boolean;
} {
  return {
    save: () => Promise.reject(new Error("Saving prices is not available yet.")),
    isPending: false,
  };
}
