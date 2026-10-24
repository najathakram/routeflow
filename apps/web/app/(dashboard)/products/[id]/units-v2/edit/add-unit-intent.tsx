"use client";

import * as React from "react";

/**
 * K11-11: how the grid's "Add the Piece unit first" pointer tells the Add a unit panel it should open as that Piece.
 * The grid and the panel are siblings in the v2 shell, so they share one flag through a provider that the editable
 * grid mounts around both. The pointer sets the flag for the span of its own click on the opener; the panel's onOpen
 * reads it and clears it. A click that opens nothing (opener disabled) leaves the flag cleared by the pointer's `finally`.
 * Without a provider (the read-only grid, the old Units card) there is no flag and the pointer just clicks.
 */
export type AddUnitIntent = React.MutableRefObject<boolean>;

const Ctx = React.createContext<AddUnitIntent | null>(null);

export function AddUnitIntentProvider({ children }: { children: React.ReactNode }) {
  const intent = React.useRef(false);
  return <Ctx.Provider value={intent}>{children}</Ctx.Provider>;
}

export const useAddUnitIntent = (): AddUnitIntent | null => React.useContext(Ctx);

/** Read the "open as a Piece" flag once and clear it. */
export function takeAddUnitIntent(intent: AddUnitIntent | null): boolean {
  if (!intent) return false;
  const asPiece = intent.current;
  intent.current = false;
  return asPiece;
}
