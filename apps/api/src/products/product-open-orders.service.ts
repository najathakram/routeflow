import { Injectable } from "@nestjs/common";
import type { ProductOpenOrders } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";

export const OPEN_ORDERS_DEFAULT_LIMIT = 200;
export const OPEN_ORDERS_MAX_LIMIT = 500;

/** `?limit=` for the open-orders card: clamped 1-500, default 200 (same rule as product-sales). */
export function clampOpenOrdersLimit(raw: unknown): number {
  void raw;
  return 0; // STUB (test-first)
}

@Injectable()
export class ProductOpenOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /** STUB (test-first): replaced by the real read in the next commit. */
  async getOpenOrders(productId: string, limit: number): Promise<ProductOpenOrders> {
    void limit;
    return {
      productId,
      lines: [],
      summary: { orders: 0, customers: 0, totalQty: 0 },
      truncated: false,
    };
  }
}
