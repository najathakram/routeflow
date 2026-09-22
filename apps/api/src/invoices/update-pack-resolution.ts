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
 * THE ORDER (SA-077): the payload's own split, then the stored line for the SAME productId when
 * EXACTLY ONE such line exists on the invoice, then the live product — which is a guess about a
 * sale that may have happened at a different pack, so the caller warns and calls it new-line
 * semantics. Two stored lines for one product make the pairing POSITIONAL, and a positionally
 * matched snapshot is refused: such a line takes the live path instead.
 *
 * SCOPE. Only "no boxes to divide by" falls back. A split that contradicts itself
 * ({qty 10, boxes 3, pieces 2}) keeps today's behaviour — stored as sent with a null pack — because
 * no denominator there is defensible and the edit page cannot emit it. SA-077(2) will REFUSE that
 * shape through the existing `lineAmbiguity` guard so money fails closed; that is a deliberate
 * behaviour change for every client and lands as its own PR, not inside a hotfix.
 */

/** A surviving `InvoiceItem` row, as this module needs it. */
export interface PriorPackRow {
  productId: string | null;
  unitsPerBox: unknown;
}

/**
 * The pack each product's own stored line carries, keyed by productId — and ONLY where exactly
 * one line on this invoice holds that product (see the header: positional pairing is refused).
 * A pack of 1 or 0 is not a pack and never enters the map.
 */
export async function loadPriorPacks(
  invoiceItem: { findMany: (args: unknown) => Promise<PriorPackRow[]> },
  invoiceId: string,
  productIds: string[],
): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map();
  return buildPriorPackMap(
    await invoiceItem.findMany({
      where: { invoiceId, productId: { in: productIds } },
      select: { productId: true, unitsPerBox: true },
    }),
  );
}

export function buildPriorPackMap(rows: PriorPackRow[]): Map<string, number> {
  const linesPerProduct = new Map<string, number>();
  for (const r of rows) {
    if (!r.productId) continue;
    linesPerProduct.set(r.productId, (linesPerProduct.get(r.productId) ?? 0) + 1);
  }
  const packs = new Map<string, number>();
  for (const r of rows) {
    const pack = Number(r.unitsPerBox ?? 0);
    if (r.productId && pack > 1 && linesPerProduct.get(r.productId) === 1) {
      packs.set(r.productId, pack);
    }
  }
  return packs;
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
  line: { productId?: string | null; boxes?: number | null },
  livePack: number | null | undefined,
  storedPacks: Map<string, number>,
): UpdateLinePackResult {
  if (payloadPack != null) return { pack: payloadPack };
  if (Number(line.boxes ?? 0) > 0) return {};
  const stored = line.productId ? storedPacks.get(line.productId) : undefined;
  if (stored != null && stored > 1) return { pack: stored };
  const live = Number(livePack ?? 0);
  if (!(live > 1)) return {};
  return {
    pack: live,
    warn:
      `productId ${line.productId ?? "?"} — a sub-one-box split carries no stored pack; ` +
      `pricing at the LIVE product pack ${live} (new-line semantics).`,
  };
}
