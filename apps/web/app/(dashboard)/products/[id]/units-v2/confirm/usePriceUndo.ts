import type { UndoFn } from "./types";

/** RED SKELETON. */
export function usePriceUndo(_deps: unknown): UndoFn {
  return () => Promise.reject(new Error("skeleton"));
}
