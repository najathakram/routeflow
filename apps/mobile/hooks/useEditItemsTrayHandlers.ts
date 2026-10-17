import { useCallback, useRef } from "react";
import { isUnitLine } from "../lib/sale-line";
import type { DraftItem, UnlistedDraft } from "../lib/edit-items-draft";

interface TrayDeps {
  draft: Record<string, DraftItem>;
  unlisted: UnlistedDraft[];
  setUnits: (id: string, units: number) => void;
  setQty: (id: string, qty: number) => void;
  incQty: (id: string) => void;
  decQty: (id: string) => void;
  removeLine: (id: string) => void;
  setUnlistedQty: (id: string, qty: number) => void;
  removeUnlisted: (id: string) => void;
}

/**
 * The order editor's ScanTray handlers, all but `onTrayChangeQty` which stays in the screen (extracted verbatim from
 * edit-items.tsx, size-ratchet).
 * ScanTray memoizes its rows on callback identity (components/ScanTray.tsx), so these have to be referentially
 * stable — a "latest deps" ref keeps them stable while still dispatching against the current draft.
 */
export function useEditItemsTrayHandlers(deps: TrayDeps) {
  const trayDepsRef = useRef(deps);
  trayDepsRef.current = deps;
  const unlistedRow = (id: string) => trayDepsRef.current.unlisted.find((u) => u.id === id);
  const onTrayIncrement = useCallback((id: string) => {
    const d = trayDepsRef.current;
    const u = unlistedRow(id);
    if (u) d.setUnlistedQty(id, u.qty + 1);
    else d.incQty(id);
  }, []);
  const onTrayDecrement = useCallback((id: string) => {
    const d = trayDepsRef.current;
    const u = unlistedRow(id);
    if (u) d.setUnlistedQty(id, u.qty - 1);
    else d.decQty(id);
  }, []);
  const onTrayRemove = useCallback((id: string) => {
    const d = trayDepsRef.current;
    if (unlistedRow(id)) d.removeUnlisted(id);
    else d.removeLine(id);
  }, []);
  // `trayDepsRef` / `unlistedRow` are returned for the screen's own `onTrayChangeQty` (it stays there: its unit-line routing is
  // pinned in __tests__/unit-line-qty-writers.pins.test.ts).
  return { trayDepsRef, unlistedRow, onTrayIncrement, onTrayDecrement, onTrayRemove };
}
