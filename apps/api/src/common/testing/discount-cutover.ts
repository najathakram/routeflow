/**
 * SA-1153 (W-989 PR-2, round 3): the ONE harness that makes a discount-mode test able to go red.
 *
 * Why it exists. `discountModeOf` / `newDocumentDiscountMode` read `DISCOUNT_PRE_TAX_FROM`, which is `null` while dark, and
 * `null` answers LEGACY at every site. A test that leaves the constant alone cannot tell `discountModeOf(order)` from
 * `newDocumentDiscountMode()`: both say LEGACY, so a swap of one for the other stays green. The cutover must be SET in the test.
 *
 * Use (the import must come FIRST in the spec, before anything that loads `@routeflow/pricing`):
 *
 *   import { withDiscountCutover, BEFORE, underCutover } from "../common/testing/discount-cutover";
 *   describe("a site", () => {
 *     withDiscountCutover();                          // the cutover reads CUTOVER (a past instant) for each test, null after
 *     it("...", async () => {
 *       const legacy = await underCutover(null, () => run(BEFORE_SOURCE)); // the same call with the cutover null (R3)
 *       expect(await run(BEFORE_SOURCE)).toEqual(legacy);
 *     });
 *   });
 *
 * Every behavioural row asserts TWO things (SA-1153): the fixture discriminates (the two modes give different figures on it)
 * and the site's written figure equals the cutover-null run for a LEGACY source / the PRE_TAX figure for a new one. No expected
 * number is typed: it is the same run with the cutover null.
 */
import { sumInvoiceTotals, type DiscountTaxBase } from "@routeflow/pricing";
import { discountModeOf } from "../discount-tax-mode";

// The module mock: a getter over the REAL module, so every other export is real and only the constant is movable.
let mockCutover: Date | null = null;
jest.mock("@routeflow/pricing", () => ({
  ...jest.requireActual<typeof import("@routeflow/pricing")>("@routeflow/pricing"),
  get DISCOUNT_PRE_TAX_FROM() {
    return mockCutover;
  },
}));

/** In the past, so the real `new Date()` that `newDocumentDiscountMode()` reads is after it (no fake timers needed). */
export const CUTOVER = new Date("2026-01-01T00:00:00Z");
/** A LEGACY source: created before the cutover. */
export const BEFORE = new Date("2025-12-15T12:00:00Z");
/** A PRE_TAX source: created after the cutover, before any real clock a test runs on. */
export const AFTER = new Date("2026-02-01T12:00:00Z");

/** The money fixture of SA-1153: subtotal 100, rate 10%, invoice discount 20, shipping 0. PRE_TAX tax 8; LEGACY (master) tax 10. */
export const FIXTURE = { subtotal: 100, rate: 0.1, discount: 20, shipping: 0 } as const;

/** Sets the constant for the current test (null restores dark). */
export function setDiscountCutover(at: Date | null): void {
  mockCutover = at;
}

/** Runs `fn` with the cutover at `at` (null = the dark run) and puts back whatever was set before. */
export async function underCutover<T>(at: Date | null, fn: () => T | Promise<T>): Promise<T> {
  const previous = mockCutover;
  mockCutover = at;
  try {
    return await fn();
  } finally {
    mockCutover = previous;
  }
}

/**
 * Fails loudly when the mock did not take: the spec loaded `@routeflow/pricing` (or the mode module) BEFORE this harness, so the
 * services hold the real, never-movable constant and every row would silently pass dark.
 */
function assertCutoverIsLive(): void {
  const probe = new Date(CUTOVER.getTime() + 1);
  const seen = discountModeOf({ createdAt: probe });
  const want: DiscountTaxBase = mockCutover == null ? "LEGACY_POST_TAX" : "PRE_TAX";
  if (seen !== want) {
    throw new Error(
      "discount-cutover harness: the mock is not live. Import it FIRST in the spec, before any module that loads @routeflow/pricing.",
    );
  }
}

/** Registers the per-test cutover: `at` for each test (default CUTOVER), null again after it. Call inside a `describe` or at the top level. */
export function withDiscountCutover(at: Date | null = CUTOVER): void {
  beforeEach(() => {
    mockCutover = at;
    assertCutoverIsLive();
  });
  afterEach(() => {
    mockCutover = null;
  });
}

/** The fixture's totals under one mode, through the ONE formula (`sumInvoiceTotals`). Nothing here is typed by hand. */
export function fixtureTotals(mode: DiscountTaxBase): { tax: number; total: number } {
  const t = sumInvoiceTotals([{ subtotal: FIXTURE.subtotal, taxRate: FIXTURE.rate }], {
    discount: FIXTURE.discount,
    shipping: FIXTURE.shipping,
    isTaxExempt: false,
    discountBase: mode,
  });
  return { tax: t.tax, total: t.total };
}

/** Assertion 1 of every behavioural row: on the fixture the two modes give different figures (a fixture where they agree proves nothing). */
export function expectFixtureDiscriminates(): void {
  const pre = fixtureTotals("PRE_TAX");
  const legacy = fixtureTotals("LEGACY_POST_TAX");
  expect(pre).not.toEqual(legacy);
}

/** A figure, or the refusal the site throws (a stored LEGACY tax read as PRE_TAX is STALE: also a difference, not a pass). */
export async function settled<T>(f: () => Promise<T> | T): Promise<T | { refused: string }> {
  try {
    return await f();
  } catch (e) {
    return { refused: (e as Error).message };
  }
}
