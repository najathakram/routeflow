"use client";

import type { SavedPriceChange } from "./types";

/** RED SKELETON. */
export function usePriceSaveStatus() {
  return {
    state: { phase: "idle" as const },
    onSaved: (_c: SavedPriceChange) => {},
    onEdit: () => {},
  };
}

export function PriceSaveStatusLine(_props: {
  productId: string;
  status: ReturnType<typeof usePriceSaveStatus>;
}) {
  return null;
}
