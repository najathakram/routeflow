import type { PurchaseOrderChargeBasisValue } from "@routeflow/types";
import { allocateCentsLargestRemainder } from "./largest-remainder";
import { MoneyInvariantError } from "./money-invariants";
import { isWholeCents } from "./pricing";

/**
 * SA-1540 P1 (Ops W-1483) - landed cost: freight, duty and fees on a purchase order.
 * All money here is whole cents in dollars; the integer-cents work goes through
 * `allocateCentsLargestRemainder`, so every split sums EXACTLY to its input.
 */

/**
 * How a purchase-order charge is spread over its received lines: the Prisma `PurchaseOrderChargeBasis` through its one
 * shared mirror (`@routeflow/types`, pinned by enum-parity.spec.ts; L-072, never a local copy), plus "MANUAL" until
 * SA-1540 P2 adds it to the enum and its mirror. WEIGHT and VOLUME are LATER.
 */
export type PoChargeBasis = PurchaseOrderChargeBasisValue | "MANUAL";

export interface PoChargeLine {
  /** Pieces received on this line (integer >= 0). */
  receivedPieces: number;
  /** Merchandise value of the RECEIVED pieces, whole-cents dollars >= 0 (0 when nothing received). */
  receivedValue: number;
  /** MANUAL basis only: the typed share for this line, whole-cents dollars >= 0. */
  manualAmount?: number;
}

export interface AllocatePoChargeInput {
  /** The charge BEFORE tax, whole-cents dollars >= 0. Tax is never allocated. */
  amount: number;
  /** Defaults to VALUE. */
  basis?: PoChargeBasis;
  lines: PoChargeLine[];
}

const toCents = (n: number): number => Math.round(n * 100);
/** Whole-cent dollars from rounded dollars, never -0 (x + 0 turns -0 into +0). */
const clean = (n: number): number => toCents(n) / 100 + 0;

function assertCents(label: string, n: number): void {
  if (!Number.isFinite(n) || n < 0 || !isWholeCents(n)) {
    throw new MoneyInvariantError(`${label} must be whole cents >= 0 (got ${n})`);
  }
}

function assertPieces(label: string, n: number): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new MoneyInvariantError(`${label} must be an integer >= 0 (got ${n})`);
  }
}

/**
 * SA-1540 F16 / R19: the allocator multiplies `cents * weight` in float. Past 2^53 that is no
 * longer exact, so refuse HERE (not in the shared allocator, whose other callers weigh by cents x
 * tax-rate micros) before calling it. Throws MoneyInvariantError.
 */
function allocateExact(total: number, weights: number[]): number[] {
  const sumW = weights.reduce((a, w) => a + w, 0);
  if (toCents(total) * sumW > Number.MAX_SAFE_INTEGER) {
    throw new MoneyInvariantError(
      `landed cost allocation is too large to split exactly (${total} over weight ${sumW})`,
    );
  }
  return allocateCentsLargestRemainder(total, weights);
}

/**
 * One whole-cent share of `amount` per line, in input order, summing exactly to `amount`.
 * VALUE weighs each line by its received merchandise cents, QUANTITY by received pieces, MANUAL
 * takes the typed per-line amounts (which must sum to `amount` exactly). A line with nothing
 * received (0 pieces, 0 value) gets 0; only received lines carry a posting.
 *
 * Callers must pass the lines in a STABLE order (PO line position, else line id): on an exact tie the odd cent goes
 * to the earlier line (largest remainder breaks ties by index), so the preview, the post and any re-split agree only
 * when every caller orders the lines the same way (R-322 LOW-3).
 *
 * Throws MoneyInvariantError on a bad amount/value/pieces, a line with a value but no pieces, an
 * unknown basis, a positive amount with no received weight, an allocation whose cents x weight sum
 * exceeds 2^53, MANUAL amounts that do not sum to the charge, or a manual amount on a line with
 * nothing received.
 */
export function allocatePoCharge(input: AllocatePoChargeInput): number[] {
  const { amount, basis = "VALUE", lines } = input;
  assertCents("charge amount", amount);
  lines.forEach((l, i) => {
    assertPieces(`line ${i} received pieces`, l.receivedPieces);
    assertCents(`line ${i} received value`, l.receivedValue);
    if (l.receivedPieces === 0 && l.receivedValue > 0) {
      throw new MoneyInvariantError(`line ${i} has a received value but no received pieces`);
    }
  });
  switch (basis) {
    case "VALUE":
      return allocateExact(
        amount,
        lines.map((l) => toCents(l.receivedValue)),
      );
    case "QUANTITY":
      return allocateExact(
        amount,
        lines.map((l) => l.receivedPieces * 1000),
      );
    case "MANUAL": {
      let sum = 0;
      const shares = lines.map((l, i) => {
        const manual = l.manualAmount ?? 0;
        assertCents(`line ${i} manual amount`, manual);
        if (manual > 0 && l.receivedPieces === 0) {
          throw new MoneyInvariantError(`line ${i} has nothing received, so it takes no charge`);
        }
        sum += toCents(manual);
        return clean(manual);
      });
      if (sum !== toCents(amount)) {
        throw new MoneyInvariantError(
          `manual amounts (${sum / 100}) must add up to the charge (${amount}) exactly`,
        );
      }
      return shares;
    }
    default:
      throw new MoneyInvariantError(`unknown charge basis ${String(basis)}`);
  }
}

export type LandedShareMode =
  "CAPITALISED" | "EXPENSED_STANDARD" | "EXPENSED_LEDGER_GAP" | "EXPENSED_NO_STOCK";

export interface SplitLandedShareInput {
  /** The line's allocated charge, whole-cents dollars. Negative = a reversal posting. */
  allocated: number;
  /** LINE: this line's received pieces whose cost of goods sold is not read yet (newest-first clamp). */
  notYetCostedPieces: number;
  /** LINE: this line's received pieces already invoiced (costed at the old average). */
  alreadyCostedPieces: number;
  /** PRODUCT: stock of the product at the posting instant. May be negative (oversold). */
  productInStock: number;
  /** PRODUCT: pieces of the product out on orders not yet invoiced at the posting instant. */
  productOpenOrderPieces: number;
  /** STANDARD-cost product: everything is a variance in cost of goods sold. */
  standard?: boolean;
  /** The product's ledger replay found a gap: everything goes to cost of goods sold. */
  ledgerGap?: boolean;
}

export interface LandedShareSplit {
  /** Capitalised into stock value. */
  toStock: number;
  /** Rides the average to goods on open orders; reaches cost of goods sold when invoiced. */
  toOpenOrders: number;
  /** The cost of goods sold true-up for units already invoiced (or the whole share if expensed). */
  toCogs: number;
  mode: LandedShareMode;
}

/**
 * Split one line's share three ways (spec 3.4/3.5). Precedence: STANDARD, then a ledger gap (both
 * validate no piece counts, so they never block), then a PRODUCT with no stock at B
 * (productInStock <= 0, R8: no ledger row can raise the average, so open orders would be invoiced
 * at the old one): all EXPENSED, all to `toCogs`. Otherwise CAPITALISED: the line's allocation by
 * largest remainder over [notYetCosted, alreadyCosted] -> notYetCosted$ / toCogs, then
 * notYetCosted$ over the product's [productInStock, productOpenOrderPieces] -> toStock /
 * toOpenOrders. A negative `allocated` splits its size the
 * same way and negates every share. toStock + toOpenOrders + toCogs === allocated, always.
 *
 * Throws MoneyInvariantError on a non-whole-cents `allocated`; on the paths that use them, on a
 * non-integer stock, a negative or non-integer piece count, or a line's notYetCostedPieces above
 * max(0, productInStock) + productOpenOrderPieces; and on cents x weights above 2^53.
 */
export function splitLandedShare(input: SplitLandedShareInput): LandedShareSplit {
  const { allocated, notYetCostedPieces, alreadyCostedPieces, productInStock } = input;
  const { productOpenOrderPieces } = input;
  if (!Number.isFinite(allocated) || !isWholeCents(allocated)) {
    throw new MoneyInvariantError(`allocated must be whole cents (got ${allocated})`);
  }
  const expensed = (mode: LandedShareMode): LandedShareSplit => ({
    toStock: 0,
    toOpenOrders: 0,
    toCogs: clean(allocated),
    mode,
  });
  if (input.standard) return expensed("EXPENSED_STANDARD");
  if (input.ledgerGap) return expensed("EXPENSED_LEDGER_GAP");

  if (!Number.isInteger(productInStock)) {
    throw new MoneyInvariantError(`productInStock must be an integer (got ${productInStock})`);
  }
  assertPieces("productOpenOrderPieces", productOpenOrderPieces);
  // R8: a LANDED_COST row needs stock > 0 to raise the average. With none, open orders are invoiced at the old
  // average, so a share kept for them would vanish: stock <= 0 sends everything to toCogs, open orders or not.
  if (productInStock <= 0) return expensed("EXPENSED_NO_STOCK");

  assertPieces("notYetCostedPieces", notYetCostedPieces);
  assertPieces("alreadyCostedPieces", alreadyCostedPieces);
  const stockWeight = productInStock; // > 0 here
  if (notYetCostedPieces > stockWeight + productOpenOrderPieces) {
    throw new MoneyInvariantError(
      `notYetCostedPieces ${notYetCostedPieces} exceeds the product's stock ${stockWeight} + open orders ${productOpenOrderPieces}`,
    );
  }

  const size = Math.abs(allocated);
  const [notYetCosted, toCogs] = allocateExact(size, [notYetCostedPieces, alreadyCostedPieces]);
  const [toStock, toOpenOrders] = allocateExact(notYetCosted, [
    stockWeight,
    productOpenOrderPieces,
  ]);
  const sign = allocated < 0 ? -1 : 1;
  const signed = (x: number): number => (x === 0 ? 0 : sign * x);
  const out: LandedShareSplit = {
    toStock: signed(toStock),
    toOpenOrders: signed(toOpenOrders),
    toCogs: signed(toCogs),
    mode: "CAPITALISED",
  };
  const total = toCents(out.toStock) + toCents(out.toOpenOrders) + toCents(out.toCogs);
  if (total !== toCents(allocated)) {
    throw new MoneyInvariantError(
      `landed share split ${total / 100} does not add up to ${allocated}`,
    );
  }
  return out;
}
