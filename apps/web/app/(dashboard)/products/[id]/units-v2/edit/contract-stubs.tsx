"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { EDIT_TESTIDS } from "./edit-testids";

/**
 * LOCAL STUBS for the seams the lead's SPRINT-CONTRACT.md will name (save hook, the "also update"
 * panel slot, the Change prices opener). Rewire these three exports to the contract and delete
 * this file; nothing else in this folder should need to change.
 */

/** One cell the user typed: a set price, or null = clear it (Auto again). */
export interface SaveCellPatch {
  ref: string;
  tier: 1 | 2 | 3 | 4 | 5;
  to: number | null;
}

export interface SavePriceGridPayload {
  productId: string;
  patches: SaveCellPatch[];
  /** The order unit the user picked, or null when it did not change. */
  orderUnit: string | null;
  /** Auto prices the user chose to pin as set at their current value (Keep). */
  keeps: { ref: string; tier: number; value: number }[];
}

/** STUB save mutation: the contract's real hook replaces it. Fails loudly until it is wired. */
export function useSavePriceGrid(productId: string) {
  return useMutation({
    mutationKey: ["units-v2", "save-price-grid", productId],
    mutationFn: async (_payload: SavePriceGridPayload): Promise<void> => {
      throw new Error("useSavePriceGrid is a stub until SPRINT-CONTRACT lands");
    },
  });
}

/** The Change prices opener (K4 owns the panel). */
export type OnOpenChangePrices = () => void;

/** STUB for K4's "also update" panel: the followers and offers of the edit render here only. */
export function AlsoUpdateSlot({ hasEdits }: { hasEdits: boolean }) {
  return hasEdits ? <div data-testid={EDIT_TESTIDS.alsoSlot} hidden /> : null;
}
