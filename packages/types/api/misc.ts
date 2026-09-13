// ─── Misc: margin config, cost history, sale drafts, estimates (wave E / imp-10b) ─

import type { EstimateStatus } from "./enums";

export interface MarginConfig {
  costingMethod: "WEIGHTED_AVERAGE" | "FIFO" | "LAST_COST";
  /** Default minimum margin as a fraction (0.15 = 15%). */
  defaultMarginFloor: number;
  /** Per-category floor overrides, keyed by Product.category. */
  categoryFloors: Record<string, number>;
}

export interface CostHistoryEntry {
  date: string;
  unitCost: number;
  avgCostAfter: number | null;
  /** StockMovement type — PURCHASE, COST_BASIS, etc. */
  type: string;
}

export interface SaleDraft {
  id: string;
  kind: "ORDER" | "INVOICE";
  customerId?: string | null;
  customerName?: string | null;
  title?: string | null;
  payload: Record<string, unknown>;
  device?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SaveDraftInput = Partial<
  Pick<SaleDraft, "kind" | "customerId" | "customerName" | "title" | "payload" | "device">
>;

/**
 * ⚠️ Drift fixed here (Wave E / imp-10b, L-072, sibling-sweep find): both apps
 * hand-typed a phantom `"EXPIRED"` value on `EstimateStatus` that the Prisma
 * schema has never had (`DRAFT|SENT|ACCEPTED|DECLINED|CONVERTED`) — an unreachable
 * branch, since the API can never return it. `status` now derives from the
 * shared, schema-pinned union.
 */
export interface EstimateItem {
  id: string;
  productId?: string;
  product?: { id: string; name: string; unit?: string };
  description: string;
  qty: number;
  unitPrice: number;
  subtotal?: number;
  total?: number;
  priceType?: "STANDARD" | "SPECIAL" | "DISCOUNTED";
  originalPrice?: number;
  boxes?: number;
  pieces?: number;
}

export interface Estimate {
  id: string;
  estimateNumber: string;
  customerId: string;
  customer?: { id: string; businessName: string; contactName?: string; address?: string };
  status: EstimateStatus;
  /** Operator-picked issue date (F27); null on legacy rows — fall back to createdAt. */
  issueDate?: string | null;
  expiresAt?: string;
  subtotal: number;
  taxAmount?: number;
  discount?: number;
  total: number;
  notes?: string;
  terms?: string;
  items: EstimateItem[];
  createdAt: string;
  updatedAt: string;
}
