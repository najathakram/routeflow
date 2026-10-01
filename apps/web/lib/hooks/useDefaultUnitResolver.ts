import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSubscription } from "@/lib/api/billing";
import { fetchProductUnits, productUnitsKey, UNITS_FLAG } from "@/lib/api/product-units";
import {
  isPendingDefaultUnit,
  mergeResolvedLines,
  pendingCount,
  resolvePendingDefaultUnits,
  type DefaultUnitDeps,
  type DefaultUnitLine,
} from "@/lib/default-unit-line";

/**
 * SA-626c (tier 1 money): resolves a line's default unit when the line is ADDED, not when its row's unit picker mounts.
 * - an effect starts every pending line on its default unit as soon as the ladder is known (cached or fetched);
 * - the returned `resolveBeforeSubmit(lines)` is the submit gate: it resolves whatever is still pending and reports
 *   `blocked` lines (ladder unavailable) so the caller refuses to submit rather than send the pack by default.
 */
export function useDefaultUnitResolver<T extends DefaultUnitLine>(
  lines: T[],
  setLines: (fn: (prev: T[]) => T[]) => void,
  tierFor: DefaultUnitDeps["tierFor"],
) {
  const qc = useQueryClient();
  const sub = useSubscription({ staleTime: 60_000 });
  const unitsKnown = sub.isSuccess;
  const unitsEnabled = (sub.data?.flags ?? []).includes(UNITS_FLAG);
  const depsRef = useRef<DefaultUnitDeps | null>(null);
  depsRef.current = {
    unitsEnabled,
    unitsKnown,
    tierFor,
    getUnits: (id) =>
      qc.ensureQueryData({ queryKey: productUnitsKey(id), queryFn: () => fetchProductUnits(id) }),
  };
  const linesRef = useRef(lines);
  linesRef.current = lines;

  const pendingKey = lines
    .filter(isPendingDefaultUnit)
    .map((l) => `${l.tempId}:${pendingCount(l)}`)
    .join("|");
  useEffect(() => {
    if (!pendingKey) return;
    const before = linesRef.current;
    let live = true;
    void resolvePendingDefaultUnits(before, depsRef.current!).then(({ lines: done }) => {
      if (live) setLines((cur) => mergeResolvedLines(cur, before, done));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, unitsEnabled, unitsKnown]);

  return useCallback((cur: T[]) => resolvePendingDefaultUnits(cur, depsRef.current!), []);
}
