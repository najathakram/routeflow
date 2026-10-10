import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { pendingResolveKey, pendingStatus, type PendingBlockReason } from "@routeflow/pricing";
import { useSubscription } from "@/lib/api/billing";
import { fetchProductUnits, productUnitsKey, UNITS_FLAG } from "@/lib/api/product-units";
import {
  isPendingDefaultUnit,
  mergeResolvedLines,
  pendingCount,
  refreshUnitsAnswer,
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
  isStaff: boolean,
) {
  const qc = useQueryClient();
  const sub = useSubscription({ staleTime: 60_000, enabled: isStaff });
  const subRef = useRef(sub);
  subRef.current = sub;
  const unitsKnown = sub.isSuccess;
  const unitsEnabled = (sub.data?.flags ?? []).includes(UNITS_FLAG);
  const depsRef = useRef<DefaultUnitDeps | null>(null);
  depsRef.current = {
    isStaff,
    unitsEnabled,
    unitsKnown,
    tierFor,
    getUnits: (id) =>
      qc.ensureQueryData({ queryKey: productUnitsKey(id), queryFn: () => fetchProductUnits(id) }),
  };
  const linesRef = useRef(lines);
  linesRef.current = lines;

  // #2865 case c (SA-632): the lines whose units ladder FAILED to load (tempIds). A pending line not in this set is
  // still loading. The controls stay locked either way; a failed line shows the error and a Retry.
  const [blockedReasons, setBlockedReasons] = useState<
    Readonly<Record<string, PendingBlockReason>>
  >({});
  // Retry in flight (LOW): the Retry button shows it and a failed retry returns to the failed state.
  const [retrying, setRetrying] = useState(false);

  const pendingKey = pendingResolveKey(
    lines.filter(isPendingDefaultUnit).map((l) => ({ id: l.tempId, count: pendingCount(l) })),
  );
  useEffect(() => {
    if (!pendingKey) return;
    const before = linesRef.current;
    let live = true;
    void resolvePendingDefaultUnits(before, depsRef.current!).then(
      ({ lines: done, reasons, folds }) => {
        if (!live) return;
        setLines((cur) => mergeResolvedLines(cur, before, done, folds));
        setBlockedReasons(reasons);
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, unitsEnabled, unitsKnown]);

  // "Try again" after a blocked submit refetches the units answer first (N10).
  const resolveBeforeSubmit = useCallback(async (cur: T[]) => {
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
    const before = linesRef.current;
    setRetrying(true);
    try {
      const { lines: done, reasons, folds } = await resolveBeforeSubmit(before);
      setLines((cur) => mergeResolvedLines(cur, before, done, folds));
      setBlockedReasons(reasons);
    } finally {
      setRetrying(false);
    }
  }, [resolveBeforeSubmit, setLines]);

  /**
   * `loading` while the units answer or the ladder is still being fetched (the subscription read in flight is NOT a
   * failure, M1); `failed` once it could not be loaded; undefined for a settled line. The shared rule decides.
   */
  const statusFor = useCallback(
    (line: T): "loading" | "failed" | undefined =>
      pendingStatus(isPendingDefaultUnit(line), {
        reason: blockedReasons[line.tempId],
        subscriptionFailed: sub.isError,
      }),
    [blockedReasons, sub.isError],
  );

  return { resolveBeforeSubmit, retry, statusFor, retrying };
}
