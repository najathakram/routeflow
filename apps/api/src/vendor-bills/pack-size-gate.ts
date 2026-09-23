import { ConflictException, type Logger } from "@nestjs/common";
import { classifyBillLinePack, knownPackHint, type PackLadderProduct } from "./bill-line-pack";

/**
 * Release toggle for the PACK_SIZE_UNKNOWN gate (B743). DARK FIRST — house
 * pattern for a new gate (mirrors `DARK_PLAN_FLAGS`): the gate computes the
 * would-deny set and logs it (blast-radius evidence for how common this
 * actually is in practice) but always allows the request through while
 * dark. `ScanInvoiceModal` (web) currently auto-sends `acknowledgeUnlinked`
 * on every scan-to-receive — enforcing this gate before that same client (and
 * mobile's receive screen) can show and acknowledge it would trade a silent
 * money bug for an outage on most scanned-bill receives. Flip to enforced
 * only once both clients handle the 409 (see B743's PR chain).
 */
export const isPackSizeGateEnforced = (env = process.env): boolean =>
  (env.PACK_SIZE_GATE_ENFORCED ?? "off") === "on";

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

/**
 * Refuses (once enforced, unless `acknowledged`) or logs-and-allows (while
 * dark) any line whose pack size is ambiguous for a product the catalog
 * already knows has a pack ladder. `acknowledged` is the caller's own
 * already-confirmed override (`acknowledgePackSizeUnknown`) — meaningless
 * while dark, since a dark gate never blocks regardless of it.
 */
export function assertPackSizeKnownOrLog(
  logger: Logger,
  tenantId: string | null | undefined,
  lines: ReadonlyArray<PackSizeGateLine>,
  acknowledged: boolean,
): void {
  const unknown = findPackSizeUnknownLines(lines);
  if (unknown.length === 0) return;

  if (!isPackSizeGateEnforced()) {
    logger.warn(
      `PACK_SIZE_UNKNOWN would-deny (dark, allowed through): tenant=${tenantId ?? "?"} lines=${unknown.length}`,
    );
    return;
  }
  if (acknowledged) return;
  throw new ConflictException({
    code: "PACK_SIZE_UNKNOWN",
    message:
      unknown.length === 1
        ? `"${unknown[0].description || unknown[0].productName}" doesn't state units per case, and this product is normally sold by the case — confirm before it's recorded as loose pieces.`
        : `${unknown.length} lines don't state units per case for a product normally sold by the case — confirm before they're recorded as loose pieces.`,
    packSizeUnknownItems: unknown,
  });
}
