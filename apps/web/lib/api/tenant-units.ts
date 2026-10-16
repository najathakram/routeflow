import * as React from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_ERROR_CODES, isPieceSynonym, unitNameKey } from "@routeflow/types";
import { apiClient } from "../api-client";
import { codedToastCopy } from "../generic-toast-copy";

// Tenant unit NAMES (Settings > Units). A names list, not a math source: order, invoice and return
// lines snapshot their unit words and never reference these rows.

export interface TenantUnitDto {
  id: string;
  name: string;
  archivedAt: string | null;
  productCount: number;
}
export interface TenantUnitUpdateResult {
  unit: TenantUnitDto;
  /** Distinct products whose label was rewritten by a rename (0 for archive / restore). */
  productsUpdated: number;
}

/** GET /units?archived=1 — one page of archived units (SA-810); `nextCursor` null = the last page. */
export interface TenantUnitsPage {
  items: TenantUnitDto[];
  nextCursor: string | null;
}

export const MAX_UNIT_NAME = 30;
/** The API's active-unit cap (SA-810); the 409 body carries the live value as `limit`. */
const UNIT_LIMIT = 200;
export const SAVE_FAILED = "Couldn't save. Your change is still here. Try again.";

const UNITS_KEY = ["tenant-units"] as const;

/** Trim, and upper-case the first letter ONLY when the name was typed all lowercase ("12pk" stays). */
export function normalizeUnitName(raw: string): string {
  const name = raw.trim();
  if (!name || name !== name.toLowerCase()) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Client-side check before a request. An ARCHIVED match is fine: adding it restores it. */
export function checkUnitName(raw: string, units: TenantUnitDto[]): string | null {
  const name = raw.trim();
  if (!name) return "Enter a name.";
  if (name.length > MAX_UNIT_NAME) return "Keep it to 30 characters or fewer.";
  if (isPieceSynonym(name)) return "Piece is always there as the smallest unit.";
  const dup = units.find((u) => !u.archivedAt && unitNameKey(u.name) === unitNameKey(name));
  return dup ? `You already have a unit called ${dup.name}.` : null;
}

function joinNames(names: string[], total: number): { text: string; many: boolean } {
  const shown = names.slice(0, 3);
  const more = total - shown.length;
  if (more > 0) return { text: `${shown.join(", ")} and ${more} more`, many: true };
  if (shown.length === 1) return { text: shown[0], many: false };
  return { text: `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`, many: true };
}

/** The exact inline sentence for a failed add / rename / archive. `name` is the name being saved. */
export function unitErrorMessage(err: unknown, name: string): string {
  const res = (err as { response?: { status?: number; data?: Record<string, unknown> } })?.response;
  const data = res?.data ?? {};
  if (res?.status === 409 && data.code === API_ERROR_CODES.UNIT_NAME_TAKEN) {
    return `You already have a unit called ${name}.`;
  }
  if (res?.status === 409 && data.code === API_ERROR_CODES.UNIT_RENAME_COLLISION) {
    const products = (data.products as Array<{ name: string }> | undefined) ?? [];
    const total = typeof data.total === "number" ? data.total : products.length;
    const { text, many } = joinNames(
      products.map((p) => p.name),
      total,
    );
    if (products.length === 0 && total === 0) {
      return `Can't rename to ${name}. Some products already have a ${name}. Change those first.`;
    }
    const reason = data.reason;
    if (reason === "DUPLICATE_LEVELS") {
      return many
        ? `Can't rename to ${name}. ${text} have two units that would both become ${name}. Change those first.`
        : `Can't rename to ${name}. ${text} has two units that would both become ${name}. Change that first.`;
    }
    if (reason === "LINES_AT_OTHER_SIZE") {
      return `Can't rename to ${name}. ${text} already sold ${name} at a different size on an order or invoice. Pick another name.`;
    }
    if (reason === "MIXED") {
      return `Can't rename to ${name}. ${text} can't take that name. Change ${many ? "those" : "that"} first.`;
    }
    return many
      ? `Can't rename to ${name}. ${text} already have a ${name}. Change those first.`
      : `Can't rename to ${name}. ${text} already has a ${name}. Change that first.`;
  }
  if (res?.status === 409 && data.code === API_ERROR_CODES.TENANT_UNIT_LIMIT) {
    const limit = typeof data.limit === "number" ? data.limit : UNIT_LIMIT;
    const active = typeof data.active === "number" ? data.active : limit;
    return `You have ${active} units. Archive one you no longer use to add another.`;
  }
  // A rename is already running for this tenant: the shared fixed sentence (same copy as the toast).
  if (data.code === API_ERROR_CODES.UNITS_RENAME_IN_PROGRESS)
    return codedToastCopy(err) ?? SAVE_FAILED;
  // A 400 (empty / too long) is caught client-side first; the server text is never shown (B986).
  return SAVE_FAILED;
}

/**
 * A level write whose name was NOT added to the unit list because the list is full (SA-810): the level
 * saved unlinked and the response carries `unitNotListed`. Null for a normal save.
 */
export function unitNotListedNotice(saved: unknown): string | null {
  const names = (saved as { unitNotListed?: unknown } | undefined)?.unitNotListed;
  if (!Array.isArray(names) || names.length === 0) return null;
  return `Saved. '${names.join("', '")}' wasn't added to your unit list because the list is full (${UNIT_LIMIT}).`;
}

/**
 * The ACTIVE units (one request, at most about 200) plus the ARCHIVED ones, paged 100 at a time
 * (SA-810). `data` is both lists together (the page folds the archived ones); `fetchMoreArchived`
 * loads the next archived page while `hasMoreArchived`.
 */
export function useTenantUnits() {
  const active = useQuery<TenantUnitDto[]>({
    queryKey: [...UNITS_KEY, "active"],
    queryFn: () => apiClient.get("/units").then((r) => r.data),
  });
  const archived = useInfiniteQuery<TenantUnitsPage>({
    queryKey: [...UNITS_KEY, "archived"],
    initialPageParam: null,
    queryFn: ({ pageParam }) =>
      apiClient
        .get("/units", { params: pageParam ? { archived: 1, cursor: pageParam } : { archived: 1 } })
        .then((r) => r.data),
    getNextPageParam: (last) => last.nextCursor,
  });
  const data = React.useMemo(
    () =>
      active.data && archived.data
        ? [...active.data, ...archived.data.pages.flatMap((p) => p.items)]
        : undefined,
    [active.data, archived.data],
  );
  const { refetch: refetchActive } = active;
  const { refetch: refetchArchived, fetchNextPage } = archived;
  const refetch = React.useCallback(
    () => Promise.all([refetchActive(), refetchArchived()]),
    [refetchActive, refetchArchived],
  );
  return {
    data,
    isLoading: active.isLoading || archived.isLoading,
    isError: active.isError || archived.isError,
    isSuccess: active.isSuccess && archived.isSuccess,
    refetch,
    hasMoreArchived: archived.hasNextPage,
    fetchMoreArchived: () => fetchNextPage(),
  };
}

// Both mutations render their own inline error, so the global error toast stays off (B594).
const LOCAL = { localErrorToast: true } as const;

export function useCreateTenantUnit() {
  const qc = useQueryClient();
  return useMutation<TenantUnitDto, Error, { name: string }>({
    mutationFn: (dto) => apiClient.post("/units", dto).then((r) => r.data),
    meta: LOCAL,
    onSuccess: () => qc.invalidateQueries({ queryKey: UNITS_KEY }),
  });
}

export type TenantUnitChange = { id: string; name: string } | { id: string; archived: boolean };

export function useUpdateTenantUnit() {
  const qc = useQueryClient();
  return useMutation<TenantUnitUpdateResult, Error, TenantUnitChange>({
    mutationFn: ({ id, ...body }) => apiClient.patch(`/units/${id}`, body).then((r) => r.data),
    meta: LOCAL,
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: UNITS_KEY });
      // A rename rewrote product labels: any cached product list is stale.
      if ("name" in vars) qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}
