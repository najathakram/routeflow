import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { pendingResolveKey, pendingStatus, type PendingBlockReason } from "@routeflow/pricing";
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

  // #2865 case c (SA-632): why a pending line is blocked (line ids). A pending line with no reason is still loading, and
  // so is one whose subscription read is still in flight: only a real failure is "failed" (the shared pendingStatus).
  const [reasons, setReasons] = useState<Readonly<Record<string, PendingBlockReason>>>({});

  // #2865 (N1): keyed on each pending line's TAP COUNT (a tap no longer moves qty), so a tap that lands during the
  // ladder fetch re-runs the resolver instead of leaving the line on "loading" forever.
  const pendingKey = pendingResolveKey(
    Object.entries(items)
      .filter(([, l]) => isPendingDefaultUnit(l))
      .map(([id, l]) => ({ id, count: l.pendingTaps ?? l.qty })),
  );
  useEffect(() => {
    if (!pendingKey) return;
    const before = itemsRef.current;
    let live = true;
    void resolvePendingDefaultUnits(before, depsRef.current!).then(
      ({ items: done, reasons: why }) => {
        if (!live) return;
        setItems((cur) => mergeResolvedDefaults(cur, before, done));
        setReasons(why);
      },
    );
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

  /** `loading` while the units answer or the ladder is being fetched, `failed` once it could not be; undefined if settled. */
  const statusFor = useCallback(
    (id: string, line: LineState | undefined): "loading" | "failed" | undefined =>
      pendingStatus(isPendingDefaultUnit(line), {
        reason: reasons[id],
        subscriptionFailed: sub.isError,
      }),
    [reasons, sub.isError],
  );

  return { resolveBeforeSubmit, statusFor };
}
