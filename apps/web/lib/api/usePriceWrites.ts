import { useMutation, useQueryClient } from "@tanstack/react-query";
import { API_ERROR_CODES } from "@routeflow/types";
import type { SavePricesRequest, SavePricesResponse, UndoPricesRequest } from "@routeflow/types";
import { apiClient } from "../api-client";
import { priceGridKey } from "./usePriceGrid";

/** The HTTP method of both price writes (SPRINT-CONTRACT §1 says POST; the lead may rule PATCH: change it here). */
export const PRICE_WRITE_METHOD = "post" as const;

/** Why a price write failed, in words the edit bar can show. */
export interface PriceWriteError {
  code: "stale" | "invalid" | "rules" | "unavailable" | "other";
  message: string;
  problems: string[];
}

export function priceWriteError(err: unknown): PriceWriteError | null {
  if (err == null) return null;
  const data = (err as { response?: { data?: { code?: string; problems?: string[] } } }).response
    ?.data;
  switch (data?.code) {
    case API_ERROR_CODES.LADDER_REVISION_STALE:
      return {
        code: "stale",
        message: "Prices changed since you opened this; review and save again",
        problems: [],
      };
    case API_ERROR_CODES.PRICE_EDIT_INVALID:
      return {
        code: "invalid",
        message: "Some prices are not valid.",
        problems: data.problems ?? [],
      };
    case API_ERROR_CODES.PRICING_RULES_NOT_READY:
      return {
        code: "rules",
        message: "Changing the order unit is not available yet. Your other changes were not saved.",
        problems: [],
      };
    case API_ERROR_CODES.PRICE_UNDO_UNAVAILABLE:
      return { code: "unavailable", message: "That save can no longer be undone.", problems: [] };
    default:
      return { code: "other", message: "Could not save. Try again.", problems: [] };
  }
}

function usePriceWrite<Req>(productId: string, path: string) {
  const qc = useQueryClient();
  return useMutation<SavePricesResponse, unknown, Req>({
    mutationFn: (body) =>
      apiClient[PRICE_WRITE_METHOD](`/products/${productId}${path}`, body).then((r) => r.data),
    onSuccess: (res) => qc.setQueryData(priceGridKey(productId), res.grid),
    onError: (err) => {
      if (priceWriteError(err)?.code === "stale") {
        void qc.invalidateQueries({ queryKey: priceGridKey(productId) });
      }
    },
  });
}

/** POST /products/:id/prices: everything one Save commits. On success the fresh grid replaces the cache. */
export const useSavePrices = (productId: string) =>
  usePriceWrite<SavePricesRequest>(productId, "/prices");

/** POST /products/:id/prices/undo: reverses one save by its audit id. */
export const useUndoPrices = (productId: string) =>
  usePriceWrite<UndoPricesRequest>(productId, "/prices/undo");
