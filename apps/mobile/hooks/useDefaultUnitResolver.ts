import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { LineState } from "../lib/cart-line-state";
import {
  isPendingDefaultUnit,
  mergeResolvedDefaults,
  resolvePendingDefaultUnits,
  type DefaultUnitDeps,
} from "../lib/default-unit-line";
import { fetchProductUnits, productUnitsKey, UNITS_FLAG } from "../lib/api/product-units";
import { useSubscription } from "../lib/api/billing";

type Items = Record<string, LineState>;

/**
 * SA-626c (tier 1 money): resolves a line's default unit when the line is ADDED, not when a sheet mounts.
 * - an effect starts every pending line on its default unit as soon as the ladder is known (cached or fetched);
 * - the returned `resolveBeforeSubmit(items)` is the submit gate: it resolves whatever is still pending and reports
 *   `blocked` lines (ladder unavailable) so the caller refuses to send the pack/case by default.
 */
export function useDefaultUnitResolver(
  items: Items,
  setItems: (fn: (m: Items) => Items) => void,
  isStaff: boolean,
  productFor: DefaultUnitDeps["productFor"],
  tierFor: DefaultUnitDeps["tierFor"],
) {
  const qc = useQueryClient();
  // GET /billing/subscription is operator-only: a DRIVER makes no read (and never starts on a default unit, SA-626f).
  const sub = useSubscription({ enabled: isStaff });
  const unitsKnown = sub.isSuccess;
  const unitsEnabled = (sub.data?.flags ?? []).includes(UNITS_FLAG);
  const depsRef = useRef<DefaultUnitDeps | null>(null);
  depsRef.current = {
    isStaff,
    unitsEnabled,
    unitsKnown,
    productFor,
    tierFor,
    getUnits: (id) =>
      qc.ensureQueryData({ queryKey: productUnitsKey(id), queryFn: () => fetchProductUnits(id) }),
  };
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const pendingKey = Object.entries(items)
    .filter(([, l]) => isPendingDefaultUnit(l))
    .map(([id, l]) => `${id}:${l.qty}`)
    .join("|");
  useEffect(() => {
    if (!pendingKey) return;
    const before = itemsRef.current;
    let live = true;
    void resolvePendingDefaultUnits(before, depsRef.current!).then(({ items: done }) => {
      if (live) setItems((cur) => mergeResolvedDefaults(cur, before, done));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, unitsEnabled, unitsKnown]);

  return useCallback((cur: Items) => resolvePendingDefaultUnits(cur, depsRef.current!), []);
}
