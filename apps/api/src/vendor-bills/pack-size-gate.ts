import { ConflictException, type Logger } from "@nestjs/common";
import { classifyBillLinePack, knownPackHint, type PackLadderProduct } from "./bill-line-pack";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * Opus review (B743 PR A, finding 5): PLAN_FLAG_ENFORCEMENT — an env var
 * ALONE gating a server-side enforcement switch — caused a P0 in production
 * (plan-flag-policy.ts:29) when it was flipped before a prerequisite (the
 * plan catalog re-pin) had actually shipped: nothing in code forced that
 * ordering, so an infra-only env change was enough to break every tenant.
 * This gate requires BOTH this code constant AND the env var, so enforcing
 * needs PR D's reviewed diff (flipping this constant), not just an env
 * change — an operator (or a copy-pasted env block) can never enable
 * enforcement on their own.
 */
const PACK_SIZE_GATE_READY_FOR_ENFORCEMENT = false;

/**
 * Release toggle for the PACK_SIZE_UNKNOWN gate (B743). DARK FIRST — house
 * pattern for a new gate (mirrors `DARK_PLAN_FLAGS`): the gate computes the
 * would-deny set and logs it (blast-radius evidence for how common this
 * actually is in practice) but always allows the request through while
 * dark. `ScanInvoiceModal` (web) currently auto-sends `acknowledgeUnlinked`
 * on every scan-to-receive — enforcing this gate before that same client (and
 * mobile's receive screen) can show and acknowledge it would trade a silent
 * money bug for an outage on most scanned-bill receives. Flip to enforced
 * only once both clients handle the 409 (see B743's PR chain) — flipping
 * `PACK_SIZE_GATE_READY_FOR_ENFORCEMENT` above is PR D itself.
 */
export const isPackSizeGateEnforced = (env = process.env): boolean =>
  PACK_SIZE_GATE_READY_FOR_ENFORCEMENT && (env.PACK_SIZE_GATE_ENFORCED ?? "off") === "on";

export interface PackSizeUnknownLine {
  /** The existing VendorBillItem id; null for a line not yet persisted (create()'s raise-PO path). */
  id: string | null;
  /** Position in the caller's own item array — stable even when `id` is null. */
  lineIndex: number;
  description: string;
  productId: string;
  productName: string;
  /** As billed, in the line's own (supplier) denomination — never converted. */
  qty: number;
  unitCost: number;
  /** The product's own known pack, for display ONLY — never applied to the line. 0 = none known. */
  productPack: number;
}

export interface PackSizeGateLine {
  id: string | null;
  lineIndex: number;
  description: string;
  productId: string;
  packSize: number | null | undefined;
  qty: number;
  unitCost: number;
  product: (PackLadderProduct & { name?: string | null }) | null | undefined;
}

/** Pure: every line whose pack is ambiguous for a product the catalog already knows is boxed. */
export function findPackSizeUnknownLines(
  lines: ReadonlyArray<PackSizeGateLine>,
): PackSizeUnknownLine[] {
  return lines
    .filter((l) => classifyBillLinePack(l.packSize, l.product) === "unknown")
    .map((l) => ({
      id: l.id,
      lineIndex: l.lineIndex,
      description: l.description,
      productId: l.productId,
      productName: l.product?.name ?? "",
      qty: l.qty,
      unitCost: l.unitCost,
      productPack: knownPackHint(l.product),
    }));
}

/** Which call site raised the gate — mirrors the dark log's `path=` field so the two receive/raise-PO sites are distinguishable in the log stream. */
export type PackSizeGateContext = {
  path: "receive" | "raise-po";
  /** null before the bill exists yet (create()'s raise-PO path runs before billNumber is minted). */
  billId?: string | null;
  billNumber?: string | null;
};

/**
 * Refuses (once enforced, unless `acknowledged`) or logs-and-allows (while
 * dark) any line whose pack size is ambiguous for a product the catalog
 * already knows has a pack ladder. `acknowledged` is the caller's own
 * already-confirmed override (`acknowledgePackSizeUnknown`) — meaningless
 * while dark, since a dark gate never blocks regardless of it.
 *
 * Opus review (B743 PR A, finding 2): the dark log used to record only the
 * tenant and a bare count — not enough to read the blast radius or drive a
 * historic repair from later. Now also carries which call site raised it,
 * the bill (once one exists), and each line's productId/productPack, so a
 * later report can group by product and reconstruct exactly what a full
 * enforcement flip would have refused.
 */
export function assertPackSizeKnownOrLog(
  logger: Logger,
  tenantId: string | null | undefined,
  lines: ReadonlyArray<PackSizeGateLine>,
  acknowledged: boolean,
  context: PackSizeGateContext,
): void {
  const unknown = findPackSizeUnknownLines(lines);
  if (unknown.length === 0) return;

  if (!isPackSizeGateEnforced()) {
    const bill = context.billId
      ? `${context.billId}${context.billNumber ? `(${context.billNumber})` : ""}`
      : "new";
    const products = unknown.map((l) => `${l.productId}:pack=${l.productPack || "?"}`).join(",");
    logger.warn(
      `PACK_SIZE_UNKNOWN would-deny (dark, allowed through): tenant=${tenantId ?? "?"} ` +
        `path=${context.path} bill=${bill} lines=${unknown.length} products=[${products}]`,
    );
    return;
  }
  if (acknowledged) return;
  throw new ConflictException({
    code: API_ERROR_CODES.PACK_SIZE_UNKNOWN,
    message:
      unknown.length === 1
        ? `"${unknown[0].description || unknown[0].productName}" doesn't state units per case, and this product is normally sold by the case — confirm before it's recorded as loose pieces.`
        : `${unknown.length} lines don't state units per case for a product normally sold by the case — confirm before they're recorded as loose pieces.`,
    packSizeUnknownItems: unknown,
  });
}
