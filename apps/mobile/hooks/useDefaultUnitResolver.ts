import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { LineState } from "../lib/cart-line-state";
import {
  isPendingDefaultUnit,
  mergeResolvedDefaults,
  refreshUnitsAnswer,
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
  const subRef = useRef(sub);
  subRef.current = sub;
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

  // #2865 case c (SA-632): the lines whose units ladder FAILED to load (line ids). A pending line not in this set is
  // still loading. The controls stay locked either way; a failed line shows the error and a Retry.
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());

  const pendingKey = Object.entries(items)
    .filter(([, l]) => isPendingDefaultUnit(l))
    .map(([id, l]) => `${id}:${l.qty}`)
    .join("|");
  useEffect(() => {
    if (!pendingKey) return;
    const before = itemsRef.current;
    let live = true;
    void resolvePendingDefaultUnits(before, depsRef.current!).then(({ items: done, blocked }) => {
      if (!live) return;
      setItems((cur) => mergeResolvedDefaults(cur, before, done));
      setFailed(new Set(blocked));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, unitsEnabled, unitsKnown]);

  // "Try again" after a blocked submit refetches the units answer first (N10).
  const resolveBeforeSubmit = useCallback(async (cur: Items) => {
    const fresh = await refreshUnitsAnswer(
      depsRef.current!,
      async () => {
        const r = await subRef.current.refetch();
        return { isSuccess: r.isSuccess, flags: r.data?.flags ?? [] };
      },
      UNITS_FLAG,
    );
    return resolvePendingDefaultUnits(cur, fresh);
  }, []);

  /** Retry from a failed line's own button: the same refetch + resolve path, merged back like the effect does. */
  const retry = useCallback(async () => {
    const before = itemsRef.current;
    const { items: done, blocked } = await resolveBeforeSubmit(before);
    setItems((cur) => mergeResolvedDefaults(cur, before, done));
    setFailed(new Set(blocked));
  }, [resolveBeforeSubmit, setItems]);

  /** `loading` while the ladder is being fetched, `failed` once it could not be; undefined for a settled line. */
  const statusFor = useCallback(
    (id: string, line: LineState | undefined): "loading" | "failed" | undefined =>
      isPendingDefaultUnit(line) ? (failed.has(id) ? "failed" : "loading") : undefined,
    [failed],
  );

  return { resolveBeforeSubmit, retry, statusFor };
}
