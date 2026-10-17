import { useSubscription } from "./billing";

/**
 * The plan flag that gates Settings > Units and every /units API route (server registry row).
 * Its own key, NOT `flag.units_v1`: units_v1 already runs on a live tenant, and a rename rewrites
 * product rows, so the owner grants this one per tenant only after that tenant's backfill is clean.
 */
export const UNITS_SETTINGS_FLAG = "flag.units_settings_v1";

/**
 * Does the tenant's subscription serve `flag.units_settings_v1`? FAIL-CLOSED like `useUnitsFlag`:
 * an unknown answer never reveals a page whose every call would 403. `isLoading` / `isError` let
 * the page tell "still asking" and "could not ask" from "not granted".
 */
export function useUnitsSettingsFlag(opts?: { enabled?: boolean }): {
  enabled: boolean;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const q = useSubscription({ staleTime: 60_000, ...opts });
  return {
    enabled: (q.data?.flags ?? []).includes(UNITS_SETTINGS_FLAG),
    isLoading: q.isLoading,
    isError: q.isError,
    refetch: () => void q.refetch(),
  };
}

export function useUnitsSettingsEnabled(opts?: { enabled?: boolean }): boolean {
  return useUnitsSettingsFlag(opts).enabled;
}
