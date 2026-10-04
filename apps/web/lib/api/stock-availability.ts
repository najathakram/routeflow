import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import { lineStockView, type LineStockLine, type LineStockView } from "@/lib/line-stock";

/** `GET /orders/stock-availability` - Product.currentStock (pieces) + the save path's oversell verdict. */
export interface StockAvailability {
  allowOversell: boolean;
  items: Array<{ productId: string; availablePieces: number }>;
}

export function useStockAvailability(args: {
  productIds: string[];
  mode: "entry" | "edit";
  customerId?: string | null;
}) {
  const ids = [...new Set(args.productIds.filter(Boolean))].sort();
  return useQuery<StockAvailability>({
    queryKey: ["stock-availability", args.mode, args.customerId ?? null, ids],
    queryFn: () =>
      apiClient
        .get("/orders/stock-availability", {
          params: {
            productIds: ids.join(","),
            mode: args.mode,
            ...(args.customerId ? { customerId: args.customerId } : {}),
          },
        })
        .then((r) => {
          // A malformed body is a failed lookup (hidden), never a crash or a fake 0.
          if (
            !r.data ||
            !Array.isArray(r.data.items) ||
            typeof r.data.allowOversell !== "boolean"
          ) {
            throw new Error("stock-availability: unexpected response");
          }
          return r.data as StockAvailability;
        }),
    enabled: ids.length > 0,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
}

/**
 * The view for one line, or `undefined` when there is nothing honest to show (an unlisted line,
 * a failed lookup, a product the server did not return) - the server stays the authority on save.
 */
export function stockViewForLine(
  q: { data?: StockAvailability; isError: boolean; isFetching: boolean },
  line: LineStockLine & {
    productId: string;
    isUnlisted?: boolean;
    sellBy?: "case" | "unit";
    unit?: string;
  },
  savedPieces?: number,
): LineStockView | undefined {
  if (line.isUnlisted || !line.productId) return undefined;
  if (q.isError && !q.data) return undefined;
  const item = q.data?.items?.find((i) => i.productId === line.productId);
  if (!item) return q.isFetching || !q.data ? { state: "loading" } : undefined;
  return lineStockView({
    line,
    availablePieces: item.availablePieces,
    allowOversell: q.data?.allowOversell,
    sellByUnit: line.sellBy === "unit",
    unit: line.unit,
    savedPieces,
  });
}
