/**
 * B717 / SA-077 — how `InvoicesService.update()` resolves the pack (`unitsPerBox`) for a line it
 * is about to delete and recreate. Pure functions only, no DB and no logging, so the rule is
 * testable without standing up the service; `invoices.service.ts` keeps only the query and the
 * warn. Extracted rather than inlined because that file sits at its size-ratchet ceiling
 * (`common/size-ratchet.spec.ts`), which asks new code to move to its own module.
 *
 * THE DEFECT THIS EXISTS FOR. The edit page sends a quantity BELOW one full case as
 * `boxes: 0, pieces: N` (`lineSplit` normalizes qty 5 at pack 12 to exactly that, and the payload
 * spreads `boxes: boxes ?? 0`). SA-068's branch is entered on `item.boxes != null` — and 0 is not
 * null — but `packFromOwnSplit` refuses the split (`!(boxes > 0)`), so the pack stayed undefined
 * and `computeLineSubtotal` took its NON-boxed branch, where `unitPrice` is read as a PER-PIECE
 * price. 5 pieces of an $11.00 case billed $55.00 instead of $4.58; the multiplier is the pack
 * size, so a 24-pack overcharged 24x.
 *
 * THE ORDER (SA-077 step 3, SA-077b/c): the payload's own split, then the stored lines of the SAME
 * productId when they all AGREE, then the live product — the write moment is the snapshot moment
 * for a new line — with a warn naming the contradiction. Stored lines that disagree carry nothing
 * rather than one being picked arbitrarily. Money always comes FROM THE SPLIT at whichever pack
 * resolves, so no shape is priced at the box price per piece.
 *
 * STORAGE vs PRICING gate differently, on purpose. `computeLineSubtotal` prorates only when a
 * split is PRESENT, while the pack is a ledger fact that `toSaleLedgerLines` (B700) reads, so a
 * box-unaware line is priced `unitPrice * qty` AND still stores its pack. `create()` has always
 * done exactly this — `buildInvoiceItemData` stores the pack whenever it is > 0, split or not —
 * so keeping it here makes `update()` AGREE with `create()`; nulling it was the divergence.
 *
 * QTY IS STORED AS SENT, ALWAYS — never recomputed as boxes * pack + pieces. That recomputation
 * was designed and withdrawn (SA-077c): `update()` back-syncs to the linked order line through
 * `recomputeOrderFromInvoices`, which writes the invoice item's qty onto `OrderItem.qty` and
 * `invoicedQty`, so normalizing here would silently rewrite an order quantity nobody edited.
 *
 * KNOWN RESIDUAL, stated rather than hidden: a contradictory split keeps a qty that disagrees with
 * its own boxes and pieces, so it under-files on the ledger's piece axis. It is bounded (no
 * first-party client emits one — the DTO validates qty, boxes and pieces independently, so it
 * arrives only from a hand-rolled caller), findable (this module's warn, plus a read-only query
 * for InvoiceItems with a split where qty != boxes * unitsPerBox + pieces), not covered by the
 * B681 guard (that is a piece-axis check, and this is a wrong qty), and CLOSED by the SA-077(2)
 * refusal, which rejects the shape and ships that query so anything already stored is listed.
 */

import { BadRequestException } from "@nestjs/common";
import { computeLineSubtotal, roundMoney, splitWithoutPack } from "@routeflow/pricing";

/**
 * SA-077(2): the 4xx message for a split that no pack can price, or null when the line is fine.
 * Wraps `splitWithoutPack` — the ONE definition — and adds the line label so the caller's refusal
 * names which line was rejected rather than failing the whole save anonymously.
 */
export function unpackableSplit(
  line: {
    productId?: string | null;
    description?: string | null;
    boxes?: number | null;
    pieces?: number | null;
  },
  resolvedPack: number | undefined,
): string | null {
  const reason = splitWithoutPack({
    boxes: line.boxes,
    pieces: line.pieces,
    unitsPerBox: resolvedPack ?? null,
  });
  if (reason == null) return null;
  const label = line.description?.trim() || line.productId || "unnamed line";
  return `Line "${label}": ${reason}`;
}

export interface UpdateLinePackResult {
  /** The pack to price and snapshot with; undefined leaves the line unboxed, as before. */
  pack?: number;
  /** Ready-to-log reason the live pack was used, or undefined. The caller prefixes the invoice. */
  warn?: string;
}

/** The order in this module's header. Never invents a pack for a self-contradictory split. */
export function resolveUpdateLinePack(
  payloadPack: number | null,
  line: { productId?: string | null; boxes?: number | null; pieces?: number | null; qty?: number },
  livePack: number | null | undefined,
  storedPacks: Map<string, number>,
): UpdateLinePackResult {
  if (payloadPack != null) return { pack: payloadPack };
  // Keyed off the pack being UNDERIVABLE, never off the box count. packFromOwnSplit returns null
  // three ways — no boxes, a non-integer quotient, and a quotient of exactly 1 — and every one of
  // them used to leave the pack undefined, which prices the split as loose pieces at the BOX
  // price. All three resolve the same way here.
  const stored = line.productId ? storedPacks.get(line.productId) : undefined;
  if (stored != null && stored > 1) return { pack: stored };
  const live = Number(livePack ?? 0);
  // No pack anywhere — the product is unboxed or gone. This is the one shape still priced
  // unboxed tonight, and it is exactly what the SA-077(2) refusal closes.
  if (!(live > 1)) return {};
  return {
    pack: live,
    warn:
      `productId ${line.productId ?? "?"} — the payload's split (qty ${line.qty ?? "?"}, boxes ` +
      `${line.boxes ?? 0}, pieces ${line.pieces ?? 0}) implies no usable pack and no stored line ` +
      `carries one; pricing FROM THE SPLIT at the live pack ${live} (new-line semantics). qty is ` +
      `stored as sent, so a contradictory split under-files on the ledger's piece axis.`,
  };
}

/**
 * Validate and price ONE line of the replace payload, post-discount — the money half of
 * `update()`'s line mapper, lifted out of `invoices.service.ts` because that file is at its size
 * ratchet and the ratchet's own instruction is to move code out rather than raise the baseline.
 *
 * Order matters: the unpackable split is refused BEFORE pricing, so a line no pack can price never
 * reaches `computeLineSubtotal`'s non-boxed branch, where `unitPrice` would be read as a per-piece
 * price. BUY_N_GET_M free units come off BEFORE pricing (never a rounded net unit price): dropping
 * that snapshot re-prices an agreed 12-boxes-2-free line from $350 to 12 x $35 = $420 on a plain
 * re-save. Reads no product — it takes the already-resolved pack — so it stays off the line-units
 * call-site ratchet.
 */
export function priceReplacedLine(
  item: {
    productId?: string | null;
    description?: string | null;
    unitPrice: number;
    discount?: number | null;
    boxes?: number | null;
    pieces?: number | null;
  },
  resolved: {
    qty: number;
    boxes: number | null;
    pieces: number | null;
    unitsPerBox?: number;
    freeUnits: number;
  },
): number {
  const bad = unpackableSplit(item, resolved.unitsPerBox);
  if (bad) throw new BadRequestException(bad);
  const beforeDiscount = computeLineSubtotal({
    unitPrice: item.unitPrice,
    qty: resolved.qty,
    boxes: resolved.boxes,
    pieces: resolved.pieces,
    unitsPerBox: resolved.unitsPerBox,
    freeUnits: resolved.freeUnits,
  });
  return roundMoney(beforeDiscount - (item.discount ?? 0));
}
