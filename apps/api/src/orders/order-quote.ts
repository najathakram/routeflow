import type { FulfillPath } from "@prisma/client";
import type { CreateOrderDto } from "./dto/create-order.dto";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { PricedForWrite } from "./order-create-options";
import type { OrdersService } from "./orders.service";

/**
 * SA-1172 K1: the buyer cart quote. It is create()'s OWN number: create() prices the cart exactly as for a real
 * order, hands its figures to B1209's `beforeWrite`, and this file's hook throws a private sentinel carrying them.
 * Nothing is written (the hook sits before the first write, and `quote: true` adds a fence right after it).
 *
 * The one setter of `quote: true` (a structural pin fails if it appears elsewhere in apps/api/src). It never
 * computes a figure: no `orderTotalsOf`, `sumInvoiceTotals`, `computeCategoryTax` or `saleTotals` call here.
 */
export interface BuyerCartQuote {
  subtotal: number;
  tax: number;
  /** The regulated per-category levy (create's `categoryTax`); 0 for none. */
  levy: number;
  total: number;
  taxExempt: boolean;
}

class QuoteCaptured extends Error {
  constructor(readonly priced: PricedForWrite) {
    super("quote captured");
  }
}

export async function quoteForBuyer(
  orders: Pick<OrdersService, "create">,
  items: ReadonlyArray<{ productId: string; qty: number; boxes?: number; pieces?: number }>,
  fulfillPath: FulfillPath | undefined,
  user: JwtPayload,
): Promise<BuyerCartQuote> {
  try {
    await orders.create(
      {
        items: items.map((i) => ({ ...i })),
        status: "PENDING",
        fulfillPath,
      } satisfies CreateOrderDto,
      user,
      {
        quote: true,
        skipAutoMerge: true,
        beforeWrite: (priced) => {
          throw new QuoteCaptured(priced);
        },
      },
    );
  } catch (e) {
    if (e instanceof QuoteCaptured) {
      const p = e.priced;
      return {
        subtotal: p.subtotal,
        tax: p.tax,
        levy: p.categoryTax,
        total: p.total,
        taxExempt: p.isTaxExempt,
      };
    }
    throw e; // create's own refusal, untouched
  }
  // create() returned: the fence did not fire either. Never reachable; refuse rather than invent a figure.
  throw new Error("quote did not reach its capture");
}
