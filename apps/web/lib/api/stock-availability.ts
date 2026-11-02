import * as React from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { StockAvailability } from "@routeflow/types";
import { apiClient } from "../api-client";
import type { LineItemRowItem } from "@/components/LineItemRow";
import { lineStockViews, type LineStockView, type StockLine } from "@/lib/line-stock";

/** `GET /orders/stock-availability` - Product.currentStock (pieces) + the save path's oversell verdict (SA-1086). */
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
          // A malformed body is a failed lookup (nothing shown), never a crash or a fake 0.
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
 * One read for every listed product on a draft, folded into a note per line (see `lineStockViews`).
 * `savedPiecesByProduct` is edit only: the pieces each product already holds on the saved order.
 */
export function useLineStockViews(args: {
  lines: StockLine[];
  mode: "entry" | "edit";
  customerId?: string | null;
  savedPiecesByProduct?: ReadonlyMap<string, number>;
}): Map<string, LineStockView> {
  const query = useStockAvailability({
    productIds: args.lines.filter((l) => !l.isUnlisted).map((l) => l.productId),
    mode: args.mode,
    customerId: args.customerId,
  });
  const { lines, savedPiecesByProduct } = args;
  return React.useMemo(
    () =>
      lineStockViews({
        lines,
        availability: query.data,
        failed: query.isError,
        fetching: query.isFetching,
        savedPiecesByProduct,
      }),
    [lines, query.data, query.isError, query.isFetching, savedPiecesByProduct],
  );
}

/**
 * New Order's lines as the save will read them: a boxed line always sends `boxes`/`pieces` (the modal's
 * payload does the same), so its `qty` is already pieces; a plain line sends `qty` as is, and a named-unit line's
 * `qty` is a count whose factor rides on the line (`unitFactor`, set by `applyLineUnit`).
 */
export function stockLineOfNewOrderLine(li: LineItemRowItem): StockLine {
  const boxed = Boolean(li.unitsPerBox);
  return {
    key: li.tempId,
    productId: li.productId,
    isUnlisted: li.isUnlisted,
    qty: li.qty,
    boxes: boxed ? (li.boxes ?? 0) : null,
    pieces: boxed ? (li.pieces ?? 0) : null,
    unitsPerBox: li.unitsPerBox,
    unitLabel: li.unitLabel,
    unitFactor: li.unitFactor,
    unit: li.unit,
    packLabel: li.packLabel,
    baseLabel: li.baseLabel,
  };
}

/** The live stock note for every line of the New Order screen: one hook call, keyed by the line's `tempId`. */
export function useNewOrderLineStock(lineItems: LineItemRowItem[], customerId?: string | null) {
  const lines = React.useMemo(() => lineItems.map(stockLineOfNewOrderLine), [lineItems]);
  return useLineStockViews({ lines, mode: "entry", customerId });
}
