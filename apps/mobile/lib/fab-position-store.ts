import { create } from "zustand";

/**
 * Persists the floating-action-button position across screen mounts (within
 * the same session) so an operator who drags the FAB to a new spot doesn't
 * have it jump back every time they navigate.
 *
 * `null` means "use the default" (right edge, ~2/3 down) — the BarcodeFab
 * computes that from `Dimensions.get("window")` since width/height aren't
 * known here.
 */
interface FabPositionState {
  x: number | null;
  y: number | null;
  setPosition: (x: number, y: number) => void;
}

export const useFabPositionStore = create<FabPositionState>((set) => ({
  x: null,
  y: null,
  setPosition: (x, y) => set({ x, y }),
}));
