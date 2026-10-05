import { useQueryClient } from "@tanstack/react-query";
import type { LadderProduct } from "@routeflow/pricing";
import type {
  OrderSuggestionProduct,
  OrderSuggestionsResponse,
  RecentOrderSummary,
} from "@routeflow/types";
import { fetchProductUnits, productUnitsKey } from "@/lib/api/product-units";
import { buildUnitOptions, type UnitOption } from "@/lib/unit-options";
import { planOrderAgain, unavailableMessage, type OrderedAdd } from "./order-again";

/** The modal's add-line path, as far as the suggestions need it. */
export type SuggestionAddLine = (
  product: OrderSuggestionProduct,
  level: "BOX",
  opts: { startOnDefaultUnit?: boolean; ordered?: OrderedAdd; noHistoryPrice?: boolean },
) => { created: boolean; refused?: boolean };

interface Deps {
  suggestions: OrderSuggestionsResponse | undefined;
  addLine: SuggestionAddLine;
  /** The price tier the customer buys this product at (per-product override, else their tier). */
  tierFor: (productId: string) => number;
  toast: (t: { title: string; variant?: "success" | "info" | "error" | "warning" }) => void;
}

const str = (v: unknown) => (v == null ? null : String(v));

const ladderProductOf = (p: OrderSuggestionProduct): LadderProduct => ({
  unit: p.unit,
  unitsPerBox: p.unitsPerBox,
  pricePerUnit: String(p.pricePerUnit),
  priceTier2: str(p.priceTier2),
  priceTier3: str(p.priceTier3),
  priceTier4: str(p.priceTier4),
  priceTier5: str(p.priceTier5),
});

/**
 * The two actions of the staff New Order suggestions bar. Both go through the modal's own add-line
 * path with `noHistoryPrice`, so a line is priced from TODAY's catalog (customer tier / special
 * price) and never from the customer's last-given price or from what an old order paid.
 */
export function useOrderSuggestionActions({ suggestions, addLine, tierFor, toast }: Deps) {
  const qc = useQueryClient();

  /** A chip tap: exactly a picker tap (the product's default unit, one case), priced today. */
  const addProduct = (product: OrderSuggestionProduct) => {
    addLine(product, "BOX", { startOnDefaultUnit: true, noHistoryPrice: true });
  };

  /** The unit option a past line sold by, from the product's CURRENT ladder; null = gone. */
  const resolveUnit = async (
    product: OrderSuggestionProduct,
    label: string,
  ): Promise<UnitOption | null> => {
    try {
      const units = await qc.ensureQueryData({
        queryKey: productUnitsKey(product.id),
        queryFn: () => fetchProductUnits(product.id),
      });
      const wanted = label.trim().toLowerCase();
      const options = buildUnitOptions(ladderProductOf(product), units, tierFor(product.id));
      return (
        options.find((o) => o.kind !== "pack" && o.value.trim().toLowerCase() === wanted) ?? null
      );
    } catch {
      return null;
    }
  };

  const orderAgain = async (order: RecentOrderSummary) => {
    const plan = planOrderAgain(order, suggestions?.products ?? {});
    let unavailable = plan.unavailable;
    // Units are looked up first so every line lands in the order's own order, in one pass.
    const resolved = await Promise.all(
      plan.items.map(async (item) => ({
        item,
        unit: item.unitLabel ? await resolveUnit(item.product, item.unitLabel) : undefined,
      })),
    );
    let added = 0;
    for (const { item, unit } of resolved) {
      if (item.unitLabel && !unit) {
        unavailable += 1; // that unit is no longer offered for the product
        continue;
      }
      const res = addLine(item.product, "BOX", {
        ordered: { qty: item.qty, unit: unit ?? undefined },
        noHistoryPrice: true,
      });
      if (!res.refused) added += 1;
    }
    if (added > 0) {
      toast({
        title: `Added ${added} ${added === 1 ? "line" : "lines"} from ${order.orderNumber ?? "that order"}`,
        variant: "success",
      });
    }
    if (unavailable > 0) toast({ title: unavailableMessage(unavailable), variant: "info" });
  };

  return { addProduct, orderAgain };
}
