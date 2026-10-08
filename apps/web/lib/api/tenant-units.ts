import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_ERROR_CODES, isPieceSynonym } from "@routeflow/types";
import { apiClient } from "../api-client";

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

export const MAX_UNIT_NAME = 30;
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
  const dup = units.find(
    (u) => !u.archivedAt && u.name.trim().toLowerCase() === name.toLowerCase(),
  );
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
    return many
      ? `Can't rename to ${name}. ${text} already have a ${name}. Change those first.`
      : `Can't rename to ${name}. ${text} already has a ${name}. Change that first.`;
  }
  // A 400 (empty / too long) is caught client-side first; the server text is never shown (B986).
  return SAVE_FAILED;
}

/** One request: every unit with its product count. Archived rows come too (the page folds them). */
export function useTenantUnits() {
  return useQuery<TenantUnitDto[]>({
    queryKey: UNITS_KEY,
    queryFn: () => apiClient.get("/units", { params: { includeArchived: 1 } }).then((r) => r.data),
  });
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
