import * as apiPricing from "./pricing";
import * as apiTierUtils from "../utils/pricing";
import * as webPricing from "../../../web/lib/pricing";
import * as mobilePricing from "../../../mobile/lib/pricing";
import {
  ROUND_MONEY_FIXTURES,
  COMPUTE_LINE_SUBTOTAL_FIXTURES,
  APPLY_BEST_PROMOTION_FIXTURES,
  PRORATE_LINE_SUBTOTAL_FIXTURES,
  PRORATE_EDGE_FIXTURES,
  TIER_PRICE_FIXTURES,
  CASCADE_TIER_PRICE_FIXTURES,
  NORMALIZE_BOXES_PIECES_FIXTURES,
} from "./pricing-parity.fixtures";

/**
 * Cross-mirror parity spec (T-G3, R4/R6). Every expected value comes from
 * `pricing-parity.fixtures.ts` — hand-worked decimal arithmetic, never read
 * out of any mirror and never a mirror-vs-mirror diff. A bug replicated
 * identically in all three mirrors (REG-B122's EPSILON no-op, REG-B109's
 * saving basis) still fails here because the assertion target is the
 * mathematically correct value.
 *
 * `apps/web/lib/pricing.ts` and `apps/mobile/lib/pricing.ts` are dependency-free
 * pure modules, so they are imported straight by relative path from this api
 * jest project — no moduleNameMapper alias needed (verified empirically; see
 * the test plan's fallback note in case that ever stops being true).
 */

type PricingModule = Record<string, unknown>;

const MIRRORS: ReadonlyArray<{ name: string; mod: PricingModule }> = [
  { name: "api (apps/api/src/common/pricing.ts)", mod: apiPricing as unknown as PricingModule },
  { name: "web (apps/web/lib/pricing.ts)", mod: webPricing as unknown as PricingModule },
  { name: "mobile (apps/mobile/lib/pricing.ts)", mod: mobilePricing as unknown as PricingModule },
];

const TIER_MIRRORS: ReadonlyArray<{ name: string; mod: PricingModule }> = [
  { name: "api (apps/api/src/utils/pricing.ts)", mod: apiTierUtils as unknown as PricingModule },
  { name: "web (apps/web/lib/pricing.ts)", mod: webPricing as unknown as PricingModule },
  { name: "mobile (apps/mobile/lib/pricing.ts)", mod: mobilePricing as unknown as PricingModule },
];

/**
 * Call a named export defensively: `undefined` (never a thrown TypeError)
 * when the mirror doesn't have it yet. `prorateLineSubtotal` today exists
 * only on the mobile mirror (discovery.md) — api/web returning `undefined`
 * is a clean, real assertion mismatch against the fixture's expected value,
 * never an unresolvable-import or config failure.
 */
function callFn(mod: PricingModule, name: string, ...args: unknown[]): unknown {
  const fn = mod[name];
  return typeof fn === "function" ? (fn as (...a: unknown[]) => unknown)(...args) : undefined;
}

describe("pricing-parity — cross-mirror fixture table (T-G3)", () => {
  describe("roundMoney — REG-B122 half-away-from-zero counter-examples, all three mirrors", () => {
    for (const { name, mod } of MIRRORS) {
      it(`${name} matches every hand-worked pin (REG-B122)`, () => {
        const failures: string[] = [];
        for (const row of ROUND_MONEY_FIXTURES) {
          const actual = callFn(mod, "roundMoney", row.input);
          if (actual !== row.expected) {
            failures.push(
              `${row.label}: roundMoney(${row.input}) = ${actual}, expected ${row.expected}`,
            );
          }
        }
        expect(failures).toEqual([]);
      });
    }
  });

  describe("applyBestPromotion — REG-B109 selects by the money actually billed, all three mirrors", () => {
    for (const { name, mod } of MIRRORS) {
      it(`${name} picks the promo with the largest TRUE dollar saving (REG-B109)`, () => {
        const failures: string[] = [];
        for (const row of APPLY_BEST_PROMOTION_FIXTURES) {
          const result = callFn(mod, "applyBestPromotion", row.basePrice, row.promos, row.ctx) as
            | {
                unitPrice: number;
                originalPrice: number | null;
                appliedPromoId: string | null;
                freeUnits: number;
              }
            | undefined;
          if (
            !result ||
            result.appliedPromoId !== row.expected.appliedPromoId ||
            result.unitPrice !== row.expected.unitPrice ||
            result.originalPrice !== row.expected.originalPrice ||
            result.freeUnits !== row.expected.freeUnits
          ) {
            failures.push(
              `${row.label}: applyBestPromotion returned ${JSON.stringify(result)}, expected ${JSON.stringify(row.expected)}`,
            );
            continue;
          }
          const billed = callFn(mod, "computeLineSubtotal", {
            unitPrice: result.unitPrice,
            qty: row.bill.qty,
            boxes: row.bill.boxes,
            pieces: row.bill.pieces,
            unitsPerBox: row.bill.unitsPerBox,
            freeUnits: result.freeUnits,
          });
          if (billed !== row.expectedBilled) {
            failures.push(`${row.label}: billed ${billed}, expected ${row.expectedBilled}`);
          }
        }
        expect(failures).toEqual([]);
      });
    }
  });

  describe("prorateLineSubtotal — REG-B50 paid-basis floored cumulative telescope, all three mirrors", () => {
    for (const { name, mod } of MIRRORS) {
      it(`${name} matches the server's buildInvoiceItemData telescope (REG-B50)`, () => {
        const failures: string[] = [];
        for (const row of PRORATE_LINE_SUBTOTAL_FIXTURES) {
          const actual = callFn(
            mod,
            "prorateLineSubtotal",
            row.storedSubtotal,
            row.deliveredQty,
            row.orderQty,
            row.freeUnits,
            row.freeUnitSize ?? 1,
          );
          if (actual !== row.expected) {
            failures.push(`${row.label}: got ${actual}, expected ${row.expected}`);
          }
        }
        expect(failures).toEqual([]);
      });
    }
  });

  describe("computeLineSubtotal — boxed/loose/promo parity (no known divergence, R4)", () => {
    for (const { name, mod } of MIRRORS) {
      it(`${name} matches every fixture row`, () => {
        const failures: string[] = [];
        for (const row of COMPUTE_LINE_SUBTOTAL_FIXTURES) {
          const actual = callFn(mod, "computeLineSubtotal", row.input);
          if (actual !== row.expected) {
            failures.push(`${row.label}: got ${actual}, expected ${row.expected}`);
          }
        }
        expect(failures).toEqual([]);
      });
    }
  });

  describe("tier ladder — getTierPrice / cascadeTierPrices parity (R6)", () => {
    for (const { name, mod } of TIER_MIRRORS) {
      it(`${name} getTierPrice matches every fixture row`, () => {
        const failures: string[] = [];
        for (const row of TIER_PRICE_FIXTURES) {
          const actual = callFn(mod, "getTierPrice", row.product, row.tier);
          if (actual !== row.expected) {
            failures.push(`${row.label}: got ${actual}, expected ${row.expected}`);
          }
        }
        expect(failures).toEqual([]);
      });

      it(`${name} cascadeTierPrices matches every fixture row`, () => {
        const failures: string[] = [];
        for (const row of CASCADE_TIER_PRICE_FIXTURES) {
          const actual = callFn(mod, "cascadeTierPrices", row.field, row.value);
          if (JSON.stringify(actual) !== JSON.stringify(row.expected)) {
            failures.push(
              `${row.label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(row.expected)}`,
            );
          }
        }
        expect(failures).toEqual([]);
      });
    }
  });
});

// normalizeBoxesPieces is currently CORRECT and already identical across all
// three mirrors — kept in a separate UNTOKENED describe (no "REG-B50",
// "REG-B109" or "REG-B122" substring anywhere in its test names) so the red
// gate's `-t "REG-B(50|109|122)"` reads only the tokened set above, per the
// test plan: "put those rows in a separate untokened describe."
describe("pricing-parity — normalizeBoxesPieces (currently correct; not part of the red gate)", () => {
  for (const { name, mod } of MIRRORS) {
    it(`${name} matches every fixture row`, () => {
      const failures: string[] = [];
      for (const row of NORMALIZE_BOXES_PIECES_FIXTURES) {
        const actual = callFn(mod, "normalizeBoxesPieces", row.input);
        if (JSON.stringify(actual) !== JSON.stringify(row.expected)) {
          failures.push(
            `${row.label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(row.expected)}`,
          );
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

// prorateLineSubtotal's defensive branches — an empty order basis, a line with
// no stored money, an unclamped over-delivery, a negative delivered qty. They
// are contract pins rather than known-broken behavior, so they sit in their own
// UNTOKENED describe alongside normalizeBoxesPieces (same red-gate reasoning).
// Without them every guard in the helper can be deleted with the suite still
// green, and a driver's at-door total goes Infinity, NaN or negative.
describe("pricing-parity — prorateLineSubtotal guards (contract pins; not part of the red gate)", () => {
  for (const { name, mod } of MIRRORS) {
    it(`${name} matches every degenerate-input fixture row`, () => {
      const failures: string[] = [];
      for (const row of PRORATE_EDGE_FIXTURES) {
        const actual = callFn(
          mod,
          "prorateLineSubtotal",
          row.storedSubtotal,
          row.deliveredQty,
          row.orderQty,
          row.freeUnits,
          row.freeUnitSize ?? 1,
        );
        if (actual !== row.expected) {
          failures.push(`${row.label}: got ${actual}, expected ${row.expected}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
