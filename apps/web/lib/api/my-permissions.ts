import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { API_ERROR_CODES, allPermissionGroups, type MyPermissions } from "@routeflow/types";
import { apiClient } from "../api-client";
import { useOptionalAuth } from "../auth-context";

/**
 * `GET /users/me/permissions`: the groups the signed-in user holds. Only an OPERATOR's answer can differ from "all
 * groups", so callers enable it for operators alone. The server is the authority on every request; this read only
 * decides what to SHOW. The mode (shadow / live) is deliberately not consulted: the till is live regardless (BO-07).
 */
export const MY_PERMISSIONS_KEY = ["me", "permissions"] as const;

/** Keyed by user, so a sign-out and sign-in on the same tab never shows the previous operator's answer. */
export function useMyPermissions(userId: string | undefined, options?: { enabled?: boolean }) {
  return useQuery<MyPermissions>({
    queryKey: [...MY_PERMISSIONS_KEY, userId ?? null],
    queryFn: () => apiClient.get<MyPermissions>("/users/me/permissions").then((r) => r.data),
    staleTime: 60_000,
    ...options,
  });
}

/** The groups switched OFF: every group minus the ones held. Feed it to `staffMay(role, action, denied)`. */
export function deniedGroupsOf(perms: Pick<MyPermissions, "groups"> | null | undefined): string[] {
  if (!perms) return [];
  const held = new Set<string>(perms.groups);
  return allPermissionGroups().filter((g) => !held.has(g));
}

/**
 * The signed-in OPERATOR's denied groups, for a control that depends on one (the void button). Everyone else, and an
 * operator whose read is pending or failed, gets [] (the server is the authority and refuses what the screen offered).
 */
export function useDeniedGroups(): string[] {
  const user = useOptionalAuth()?.user;
  const perms = useMyPermissions(user?.id, { enabled: user?.role === "OPERATOR" });
  return user?.role === "OPERATOR" ? deniedGroupsOf(perms.data) : [];
}

/** A till call the server refused because the account's admin has not turned selling on (403 PERMISSION_DENIED). */
export function isPermissionDenied(err: unknown): boolean {
  return (
    (err as { response?: { data?: { code?: unknown } } } | null | undefined)?.response?.data
      ?.code === API_ERROR_CODES.PERMISSION_DENIED
  );
}

/**
 * Mount on a screen whose calls the permission can refuse (the Counter). A query or mutation that fails with
 * PERMISSION_DENIED re-reads `["me","permissions"]`, so the gate flips and the screen shows its no-access panel
 * instead of an error toast. The permissions read itself is ignored (it cannot loop).
 */
export function usePermissionDeniedWatcher(): void {
  const qc = useQueryClient();
  React.useEffect(() => {
    const refresh = () => void qc.invalidateQueries({ queryKey: MY_PERMISSIONS_KEY });
    const offQueries = qc.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "error" &&
        event.query.queryKey[0] !== MY_PERMISSIONS_KEY[0] &&
        isPermissionDenied(event.action.error)
      )
        refresh();
    });
    const offMutations = qc.getMutationCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "error" &&
        isPermissionDenied(event.action.error)
      )
        refresh();
    });
    return () => {
      offQueries();
      offMutations();
    };
  }, [qc]);
}

/**
 * SA-1034 rule 10: may the signed-in user type a line price (so add a custom item)? The SERVER's mode-applied answer
 * (`priceEditAllowed`, never a role guess here), read for an OPERATOR only: an account admin always may, and nobody
 * else reaches these screens. Pending, failed and missing answers read as ALLOWED: this only decides what to show, and
 * the server refuses (403 PRICE_EDIT_NOT_PERMITTED, same sentence) whatever the screen offered.
 */
export function usePriceEditAllowed(): boolean {
  const authUser = useOptionalAuth()?.user;
  const perms = useMyPermissions(authUser?.id, { enabled: authUser?.role === "OPERATOR" });
  if (authUser?.role !== "OPERATOR") return true;
  return perms.data?.priceEditAllowed !== false;
}
