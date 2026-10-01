import { UserRole } from "@prisma/client";
import { linePieceQty } from "./line-piece-qty";

/**
 * WS9 backorder policy: pure, injected-reader modules. No DB, no schema.
 * The adapter onto the PolicyValue resolver is `PolicyOversellReader` (policy-oversell-reader.ts).
 * Call-site note: the buyer portal path must pass role CUSTOMER (never a staff role) for source "buyer",
 * and a buyer "Reorder" must never be labelled `template_cron` (that source is true for every role).
 */

export type OversellPolicy = "off" | "backorder";

export type OversellSource = "staff_entry" | "buyer" | "promotion" | "edit" | "template_cron";

export type OversellRole = UserRole | undefined | null;

export interface OversellPolicyReader {
  read(args: { tenantId: string; customerId?: string | null }): Promise<unknown>;
}

/** Fail closed: ONLY the exact string "backorder" enables backorders. */
export function parseOversellPolicy(raw: unknown): OversellPolicy {
  return raw === "backorder" ? "backorder" : "off";
}

/**
 * The ONE predicate: may this actor oversell (order past available stock)?
 *
 * Each source pins the rule of the path it mirrors TODAY (current behaviour, not a decision):
 * - "template_cron": true for every role, policy not read (pending owner question Q6: the
 *   standing-order cron oversells silently today).
 * - DRIVER: always false, policy not read.
 * - "edit": mirrors settleStockForEdit, which refuses only CUSTOMER and DRIVER, so any other role
 *   (OPERATOR, TENANT_ADMIN, SUPER_ADMIN and a missing user) may oversell.
 * - "staff_entry" | "buyer" | "promotion": mirror create()'s `isStaffRole` (orders.service.ts),
 *   which is OPERATOR or TENANT_ADMIN exactly. SUPER_ADMIN is NOT staff there (blocked today) and
 *   a missing role is not staff. This create-vs-edit SUPER_ADMIN asymmetry is pinned, not changed.
 * - CUSTOMER: only when the resolved policy is exactly "backorder" (one read).
 * A throwing reader yields false (fail closed); never rejects. Reads at most once, only for CUSTOMER.
 */
export async function resolveOversellAllowed(
  reader: OversellPolicyReader,
  args: {
    tenantId: string;
    role: OversellRole;
    source: OversellSource;
    customerId?: string | null;
  },
): Promise<boolean> {
  if (args.source === "template_cron") return true;
  if (args.role === UserRole.DRIVER) return false;
  if (args.source === "edit") {
    if (args.role !== UserRole.CUSTOMER) return true;
  } else if (args.role === UserRole.OPERATOR || args.role === UserRole.TENANT_ADMIN) {
    return true;
  }
  if (args.role !== UserRole.CUSTOMER) return false;
  try {
    const raw = await reader.read({ tenantId: args.tenantId, customerId: args.customerId });
    return parseOversellPolicy(raw) === "backorder";
  } catch {
    return false;
  }
}

/** A line's unit fields, as the stock paths read them (`linePieceQty`). */
export interface BackorderLine {
  qty: unknown;
  boxes?: unknown;
  pieces?: unknown;
  unitsPerBox?: unknown;
  unitLabel?: unknown;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The line in PIECES, at the column's 3 decimals — the same conversion order-stock.ts applies. */
const linePieces = (line: BackorderLine, productPack?: number | null): number =>
  round3(linePieceQty({ ...line, boxes: line.boxes ?? null }, productPack ?? undefined));

/**
 * Pieces of ONE line that exceed available stock (`currentStock` counts PIECES, B703/B920 class —
 * a 2-box line of a 12-pack is 24, never 2).
 */
export function backorderPiecesForLine(args: {
  line: BackorderLine;
  productPack?: number | null;
  availablePieces: number;
  allowOversell: boolean;
}): number {
  return backorderPiecesForLines({ ...args, lines: [args.line] });
}

/**
 * Per-product rule: sum every line's pieces FIRST, then subtract available (mirrors B920).
 * SA ruling N5: every line's pieces must be >= 0. A negative sale line is a CALLER bug, so it
 * throws a `RangeError` (never clamped, never netted against a positive line), even when
 * `allowOversell` is false, so the bug cannot hide behind the policy.
 */
export function backorderPiecesForLines(args: {
  lines: BackorderLine[];
  productPack?: number | null;
  availablePieces: number;
  allowOversell: boolean;
}): number {
  const pieces = args.lines.map((l) => linePieces(l, args.productPack));
  if (pieces.some((p) => p < 0)) {
    throw new RangeError("backorderPiecesForLines: a sale line has negative pieces");
  }
  if (!args.allowOversell) return 0;
  const requested = round3(pieces.reduce((sum, p) => sum + p, 0));
  return round3(Math.max(0, requested - Math.max(0, args.availablePieces)));
}

/**
 * EDIT path (SA ruling): backorder pieces per product from `settleStockForEdit`'s per-product
 * DELTA map. For each product with delta > 0: `max(0, delta - max(0, available))`. A product
 * with delta <= 0 (a lowered or unchanged line) is 0 and never affects another product.
 * `allowOversell=false` yields 0 for every product. Every product in `deltaByProduct` is present
 * in the result.
 */
export function backorderPiecesForEditDelta(args: {
  deltaByProduct: ReadonlyMap<string, number>;
  availableByProduct: ReadonlyMap<string, number>;
  allowOversell: boolean;
}): Map<string, number> {
  const out = new Map<string, number>();
  for (const [productId, delta] of args.deltaByProduct) {
    if (!args.allowOversell || !(delta > 0)) {
      out.set(productId, 0);
      continue;
    }
    const available = Math.max(0, args.availableByProduct.get(productId) ?? 0);
    out.set(productId, round3(Math.max(0, delta - available)));
  }
  return out;
}

export function orderableAndBackorder(args: { stock: number; allowOversell: boolean }): {
  orderable: boolean;
  backorder: boolean;
} {
  if (args.stock > 0) return { orderable: true, backorder: false };
  return args.allowOversell
    ? { orderable: true, backorder: true }
    : { orderable: false, backorder: false };
}
