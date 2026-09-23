/**
 * Locks the operator order-builder save gate: normal submit needs customer + ≥1
 * item; "Save as draft" needs only a customer (zero-item DRAFT allowed).
 */
import { readFileSync } from "fs";
import { join } from "path";
import type { ProductUnitLevel } from "@routeflow/types";
import { buildUnitOptions } from "../lib/unit-options";
import {
  decideResumeLine,
  decideResumeUnitPrice,
  orderSubmitGate,
  resolveResumeLinePricing,
} from "../lib/order-draft-logic";

describe("orderSubmitGate", () => {
  it("blocks both paths without a customer", () => {
    expect(orderSubmitGate({ hasCustomer: false, itemCount: 0, asDraft: false }).ok).toBe(false);
    expect(orderSubmitGate({ hasCustomer: false, itemCount: 3, asDraft: true }).ok).toBe(false);
  });

  it("blocks a normal submit with zero items", () => {
    const g = orderSubmitGate({ hasCustomer: true, itemCount: 0, asDraft: false });
    expect(g.ok).toBe(false);
    expect(g.title).toBe("Add at least one item");
  });

  it("allows a zero-item DRAFT once a customer is chosen", () => {
    expect(orderSubmitGate({ hasCustomer: true, itemCount: 0, asDraft: true })).toEqual({
      ok: true,
    });
  });

  it("allows a normal submit with a customer and items", () => {
    expect(orderSubmitGate({ hasCustomer: true, itemCount: 2, asDraft: false })).toEqual({
      ok: true,
    });
  });
});

/**
 * F30 · R5 (T-B195, draft-resume half). The scan ladder resolves an ARCHIVED
 * product, so one can legitimately be scanned into a draft and parked. Resume
 * used to map `isActive:false` to `null` and delete the line with a "no longer
 * in your catalog" alert — the vanish-on-resume half of B195. Only a genuine
 * 404 may drop a line; anything else aborts hydration instead of truncating.
 */
describe("decideResumeLine", () => {
  const live = { id: "p1", isActive: true };
  const archived = { id: "p2", isActive: false };

  it("keeps an ARCHIVED product on the order instead of dropping the line", () => {
    expect(decideResumeLine({ ok: true, product: archived })).toEqual({
      product: archived,
      failed: false,
    });
  });

  it("keeps a live product", () => {
    expect(decideResumeLine({ ok: true, product: live })).toEqual({ product: live, failed: false });
  });

  it("drops the line only on a genuine 404", () => {
    expect(decideResumeLine({ ok: false, status: 404 })).toEqual({ product: null, failed: false });
  });

  it("aborts hydration on a transient failure rather than dropping the line", () => {
    // 5xx, and a network error / timeout with no response at all.
    expect(decideResumeLine({ ok: false, status: 500 })).toEqual({ product: null, failed: true });
    expect(decideResumeLine({ ok: false, status: undefined })).toEqual({
      product: null,
      failed: true,
    });
  });
});

/**
 * Mobile tests are pure-logic only (no RN tree), so the screen's use of the
 * helper is pinned at the source level — the technique wedge-submit.test.ts
 * already uses. Re-inlining the archived check would turn this red.
 */
describe("NewOrderScreen delegates resume-line classification (REG-B195 wiring)", () => {
  const screenSrc = readFileSync(join(__dirname, "..", "components", "NewOrderScreen.tsx"), "utf8");
  // B747 (size-ratchet extraction): decideResumeLine's own call site moved from this screen
  // into lib/resume-draft-hydration.ts's hydrateParkedLine — read THAT source for this pin,
  // not the screen's (which now only calls hydrateParkedLine, never decideResumeLine directly).
  const hydrationSrc = readFileSync(
    join(__dirname, "..", "lib", "resume-draft-hydration.ts"),
    "utf8",
  );

  it("calls decideResumeLine and no longer nulls an archived product itself", () => {
    expect(hydrationSrc).toMatch(/decideResumeLine/);
    expect(screenSrc).not.toMatch(/if\s*\(\s*data\.isActive\s*===\s*false\s*\)/);
  });

  it("the screen delegates the fetch/decide to hydrateParkedLine, not decideResumeLine directly", () => {
    expect(screenSrc).toMatch(/hydrateParkedLine/);
    expect(screenSrc).not.toMatch(/decideResumeLine/);
  });
});

/**
 * B747 (SA-085a). Resume used to refuse the WHOLE draft the moment any parked line carried a
 * `unitLabel` (B638's `unitLineRefusal`) — a driver's cart with one Case line, saved before the
 * app was killed, was lost. This decides what such a line resumes AS instead: the unit restored,
 * priced off the LIVE ladder at the CURRENT customer's tier, never the parked price — that is
 * the entire reason this can't just carry the parked `unitPrice` forward.
 */
describe("decideResumeUnitPrice (B747 / B755)", () => {
  const liveOptions = [
    { value: "", price: 24 },
    { value: "Case", price: 220 },
    { value: "Piece", price: 1 },
  ];

  it("a parked Case line resumes as a Case line, priced at the LIVE ladder's CURRENT tier — never the parked price", () => {
    expect(
      decideResumeUnitPrice({ unitLabel: "Case", priceType: "STANDARD" }, liveOptions),
    ).toEqual({
      unitLabel: "Case",
      unitBasePrice: 220,
      operatorUnitPrice: undefined,
      fellBackToPack: false,
    });
  });

  it("a plain pack line (no unitLabel) resumes unchanged — regression pin, nothing above touches this path", () => {
    expect(decideResumeUnitPrice({ priceType: "STANDARD" }, liveOptions)).toEqual({
      unitLabel: undefined,
      unitBasePrice: undefined,
      operatorUnitPrice: undefined,
      fellBackToPack: false,
    });
  });

  it("a parked unit line whose product lost that ladder level falls back to the pack", () => {
    expect(
      decideResumeUnitPrice({ unitLabel: "Pallet", priceType: "STANDARD" }, liveOptions),
    ).toEqual({
      unitLabel: undefined,
      unitBasePrice: undefined,
      operatorUnitPrice: undefined,
      fellBackToPack: true, // the caller's job to console.warn on this
    });
  });

  it("PRECEDENCE: an operator override on a Case line is pinned ON TOP of the live ladder price, never instead of it", () => {
    expect(
      decideResumeUnitPrice(
        { unitLabel: "Case", priceType: "MANUAL", unitPrice: 200, priceSource: "operator" },
        liveOptions,
      ),
    ).toEqual({
      unitLabel: "Case",
      unitBasePrice: 220, // still the LIVE price — the override rides alongside it, not over it
      operatorUnitPrice: 200,
      fellBackToPack: false,
    });

    // A MANUAL priceType with a MISSING priceSource is still an operator override (a legacy
    // draft, or one parked before this field existed) — missing means "operator", by design.
    expect(
      decideResumeUnitPrice(
        { unitLabel: "Case", priceType: "MANUAL", unitPrice: 200 },
        liveOptions,
      ),
    ).toMatchObject({ operatorUnitPrice: 200 });
  });

  it("B755: a HISTORY-sourced price is never pinned — resuming under a different customer re-prices to the live ladder, no override carried", () => {
    expect(
      decideResumeUnitPrice(
        { unitLabel: "Case", priceType: "MANUAL", unitPrice: 210, priceSource: "history" },
        liveOptions,
      ),
    ).toEqual({
      unitLabel: "Case",
      unitBasePrice: 220,
      operatorUnitPrice: undefined, // the history price (210) is discarded, not pinned
      fellBackToPack: false,
    });
  });
});

/**
 * B747 (SA-085a) / B755 (size-ratchet extraction). `resolveResumeLinePricing` composes
 * `buildUnitOptions` + `decideResumeUnitPrice` + the B755 non-unit branch — the exact logic
 * NewOrderScreen's hydration effect used to run inline. Real `buildUnitOptions` output (not a
 * hand-shaped `liveOptions` array like `decideResumeUnitPrice`'s own tests above) so this pins
 * the WIRING between them, not just the pure decision.
 */
describe("resolveResumeLinePricing (B747/B755 — the size-ratchet extraction)", () => {
  const product = { unit: "Box", unitsPerBox: 24, pricePerUnit: "42.00" };
  const level = (
    over: Partial<ProductUnitLevel> & Pick<ProductUnitLevel, "label" | "factorToBase">,
  ) =>
    ({
      id: over.label,
      price: null,
      priceTier2: null,
      priceTier3: null,
      priceTier4: null,
      priceTier5: null,
      isDefaultSelling: false,
      sortOrder: 0,
      ...over,
    }) as ProductUnitLevel;
  const CASE = level({ label: "Case", factorToBase: 288, price: "480.00" });
  const units = [CASE];

  it("a parked Case line resolves unitBasePrice to buildUnitOptions' own live Case price", () => {
    const liveCasePrice = buildUnitOptions(product, units, 1).find(
      (o) => o.value === "Case",
    )!.price;
    expect(
      resolveResumeLinePricing(
        { unitLabel: "Case", priceType: "STANDARD", productId: "p1" },
        product,
        units,
        1,
      ),
    ).toEqual({ unitLabel: "Case", unitBasePrice: liveCasePrice });
  });

  it("a ladder that lost the parked level returns ONLY a fallbackWarning naming the unit and product", () => {
    const result = resolveResumeLinePricing(
      { unitLabel: "Pallet", priceType: "STANDARD", productId: "p1", productName: "Widgets" },
      product,
      units,
      1,
    );
    expect(result).toEqual({
      fallbackWarning: expect.stringContaining('"Pallet"'),
    });
    expect(result.fallbackWarning).toContain("Widgets");
  });

  it("a plain pack line (no unitLabel) with a genuine operator override is pinned — B755", () => {
    expect(
      resolveResumeLinePricing(
        { priceType: "MANUAL", unitPrice: 39, priceSource: "operator", productId: "p1" },
        product,
        units,
        1,
      ),
    ).toEqual({ unitPrice: 39 });
  });

  it("a plain pack line with a HISTORY-tagged price is never pinned — B755", () => {
    expect(
      resolveResumeLinePricing(
        { priceType: "MANUAL", unitPrice: 39, priceSource: "history", productId: "p1" },
        product,
        units,
        1,
      ),
    ).toEqual({});
  });

  it("a plain pack line with no override at all resolves to an empty result", () => {
    expect(
      resolveResumeLinePricing({ priceType: "STANDARD", productId: "p1" }, product, units, 1),
    ).toEqual({});
  });
});

describe("NewOrderScreen resume no longer refuses a unit-aware draft (B747 wiring)", () => {
  const screenSrc = readFileSync(join(__dirname, "..", "components", "NewOrderScreen.tsx"), "utf8");

  it("calls resolveResumeLinePricing (which wraps decideResumeUnitPrice) and no longer refuses the whole draft via unitLineRefusal", () => {
    expect(screenSrc).toMatch(/resolveResumeLinePricing/);
    expect(screenSrc).not.toMatch(/unitLineRefusal/);
  });

  it("size-ratchet: hydration fetch/decide is delegated to hydrateParkedLine, not inlined", () => {
    expect(screenSrc).toMatch(/hydrateParkedLine/);
    expect(screenSrc).not.toMatch(/decideResumeLine/);
  });
});
