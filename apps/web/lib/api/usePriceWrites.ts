import { useMutation, useQueryClient } from "@tanstack/react-query";
import { API_ERROR_CODES } from "@routeflow/types";
import type { SavePricesRequest, SavePricesResponse, UndoPricesRequest } from "@routeflow/types";
import { apiClient } from "../api-client";
import { priceGridKey } from "./usePriceGrid";

/** The HTTP method of both price writes (lead final ruling 2026-10-16: POST; the method is one constant, change it here). */
export const PRICE_WRITE_METHOD = "post" as const;

/** What no code maps to: the server's own text is never shown (B986). */
export const PRICE_WRITE_GENERIC_COPY = "Couldn't save prices. Try again.";

/** Why a price write failed. `copy` is fixed product text chosen by the code, never the server's message. */
export interface PriceWriteError {
  code: "stale" | "invalid" | "rules" | "unavailable" | "family" | "other";
  copy: string;
  problems: string[];
}

/** The contract's refusals, by `body.code` (same shape as `codedToastCopy`'s code table). */
const PRICE_WRITE_CODES: Record<string, Pick<PriceWriteError, "code" | "copy">> = {
  [API_ERROR_CODES.LADDER_REVISION_STALE]: {
    code: "stale",
    copy: "Prices changed since you opened this; review and save again",
  },
  [API_ERROR_CODES.PRICE_EDIT_INVALID]: { code: "invalid", copy: "Some prices are not valid." },
  [API_ERROR_CODES.PRICING_RULES_NOT_READY]: {
    code: "rules",
    copy: "Changing the order unit is not available yet. Your other changes were not saved.",
  },
  // 409: a variant's price is set on its family. (A family or recipe row is a 400 PRICE_EDIT_INVALID with its own problem text.)
  [API_ERROR_CODES.FAMILY_PRICE_AUTHORITY]: {
    code: "family",
    copy: "This price is set on its family, so it can't be changed here. Change it on the family.",
  },
  [API_ERROR_CODES.PRICE_UNDO_UNAVAILABLE]: {
    code: "unavailable",
    copy: "That save can no longer be undone.",
  },
};

export function priceWriteError(err: unknown): PriceWriteError | null {
  if (err == null) return null;
  const data = (err as { response?: { data?: { code?: string; problems?: string[] } } }).response
    ?.data;
  // Own keys only: a code like "constructor" must not hit the table's prototype.
  const hit =
    data?.code && Object.hasOwn(PRICE_WRITE_CODES, data.code)
      ? PRICE_WRITE_CODES[data.code]
      : undefined;
  if (!hit) return { code: "other", copy: PRICE_WRITE_GENERIC_COPY, problems: [] };
  // Only the invalid answer carries the server's per-cell problem lines (contract product text).
  return { ...hit, problems: hit.code === "invalid" ? (data?.problems ?? []) : [] };
}

/**
 * `refetchOnStale`: a stale answer refetches the grid. Undo wants it (its preview reads the served grid); Save does
 * not: its notice owns the reload. Save itself never auto-refetches the grid on a stale answer.
 */
function usePriceWrite<Req>(productId: string, path: string, refetchOnStale: boolean) {
  const qc = useQueryClient();
  return useMutation<SavePricesResponse, unknown, Req>({
    // The edit bar (Save) and the status line (Undo) say every failure themselves: no second, app-wide toast.
    meta: { localErrorToast: true },
    mutationFn: (body) =>
      apiClient[PRICE_WRITE_METHOD](`/products/${productId}${path}`, body).then((r) => r.data),
    onSuccess: (res) => qc.setQueryData(priceGridKey(productId), res.grid),
    onError: (err) => {
      if (refetchOnStale && priceWriteError(err)?.code === "stale") {
        void qc.invalidateQueries({ queryKey: priceGridKey(productId) });
      }
    },
  });
}

/** POST /products/:id/prices: everything one Save commits. On success the fresh grid replaces the cache. */
export const useSavePrices = (productId: string) =>
  usePriceWrite<SavePricesRequest>(productId, "/prices", false);

/** POST /products/:id/prices/undo: reverses one save by its audit id. */
export const useUndoPrices = (productId: string) =>
  usePriceWrite<UndoPricesRequest>(productId, "/prices/undo", true);
