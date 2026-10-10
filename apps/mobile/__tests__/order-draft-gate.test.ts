/**
 * Locks the operator order-builder save gate: normal submit needs customer + ≥1
 * item; "Save as draft" needs only a customer (zero-item DRAFT allowed).
 */
import { readFileSync } from "fs";
import { join } from "path";
import type { ProductUnitLevel } from "@routeflow/types";
import { buildUnitOptions } from "../lib/unit-options";
import {
  decideResumeHydrationStart,
  decideResumeLine,
  decideResumeUnitPrice,
  orderSubmitGate,
  resolveResumeLineBoxes,
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
 * B747 REQUIRED fix (Opus @267fb9f0, disagreeing with SA-153's PASS): NewOrderScreen's
 * resume-hydration effect used to gate on `customerPricesFetched || customerPricesErrored`
 * directly in an inline `if`, but the effect's OWN dep array never included either flag — only
 * `customerPrices` (the data). A late-settling 403 (behind the pricing_tiers plan gate, LITE/
 * STARTER) flips `isError` without ever populating `data`, so the dep array never changed and the
 * effect never re-ran: every resumed draft sat on the spinner forever. These pin the DECISION
 * (never a regex scrape of the effect's source, L-205 — a purely additive refactor of the effect
 * must not break this).
 */
describe("decideResumeHydrationStart (B747 REQUIRED)", () => {
  it("waits when customerDetail hasn't loaded, even if prices already settled", () => {
    expect(decideResumeHydrationStart(false, true, false, false, undefined)).toBe("waiting");
  });

  it("waits while the prices query is still in flight (neither fetched nor errored)", () => {
    expect(decideResumeHydrationStart(true, false, false, true, undefined)).toBe("waiting");
  });

  it("starts once prices fetch successfully", () => {
    expect(decideResumeHydrationStart(true, true, false, false, undefined)).toBe("start");
  });

  it("starts on a 403 — the pricing_tiers plan gate means genuinely no overrides, not a failure", () => {
    expect(decideResumeHydrationStart(true, false, true, false, 403)).toBe("start");
  });

  it("fails on any other error status — a 5xx must never silently resume at the default tier", () => {
    expect(decideResumeHydrationStart(true, false, true, false, 500)).toBe("failed");
  });

  it("fails on a network error / timeout with no response status at all", () => {
    expect(decideResumeHydrationStart(true, false, true, false, undefined)).toBe("failed");
  });

  it("SA-165 REQUIRED: errored AND currently refetching (a Retry in flight) is waiting, not an instant re-fail", () => {
    expect(decideResumeHydrationStart(true, false, true, true, 500)).toBe("waiting");
    expect(decideResumeHydrationStart(true, false, true, true, 403)).toBe("waiting");
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
    { value: "", price: 24, factorToBase: 1 },
    { value: "Case", price: 220, factorToBase: 12 },
    { value: "Piece", price: 1, factorToBase: 1 },
  ];

  it("a parked Case line resumes as a Case line, priced at the LIVE ladder's CURRENT tier — never the parked price", () => {
    expect(
      decideResumeUnitPrice({ unitLabel: "Case", priceType: "STANDARD" }, liveOptions),
    ).toEqual({
      unitLabel: "Case",
      unitBasePrice: 220,
      operatorUnitPrice: undefined,
      unitFactor: 12,
      fellBackToPack: false,
    });
  });

  it("a plain pack line (no unitLabel) resumes unchanged — regression pin, nothing above touches this path", () => {
    expect(decideResumeUnitPrice({ priceType: "STANDARD" }, liveOptions)).toEqual({
      unitLabel: undefined,
      unitBasePrice: undefined,
      operatorUnitPrice: undefined,
      unitFactor: undefined,
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
      unitFactor: undefined,
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
      unitFactor: 12,
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
      unitFactor: 12,
      fellBackToPack: false,
    });
  });

  it("W/N (Opus REQUIRED, B747): a Case's piece factor is restored from the live ladder match — never left undefined, which CartRow's marginFactorFor reads as 1", () => {
    expect(
      decideResumeUnitPrice({ unitLabel: "Case", priceType: "STANDARD" }, liveOptions).unitFactor,
    ).toBe(12);
    expect(
      decideResumeUnitPrice({ unitLabel: "Piece", priceType: "STANDARD" }, liveOptions).unitFactor,
    ).toBe(1);
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
    ).toEqual({ unitLabel: "Case", unitBasePrice: liveCasePrice, unitFactor: 288 });
  });

  it("W/N (Opus REQUIRED, B747): restores the Case's real piece factor (288), never leaving it undefined for CartRow's margin hint", () => {
    const result = resolveResumeLinePricing(
      { unitLabel: "Case", priceType: "STANDARD", productId: "p1" },
      product,
      units,
      1,
    );
    expect(result.unitFactor).toBe(288);
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

/**
 * R2 (Opus REQUIRED, B747): resume used to price a unit-labeled line at the header
 * `customerTier` — which reads 1 until `useCustomer` resolves and is read exactly once (the
 * hydration effect's own ref-guard never re-runs it) — instead of `effectiveTierFor(productId)`,
 * the per-product tier every OTHER price computation in this screen already uses (the picker,
 * the cart total, the price editor). A per-product CustomerPrice override, or simply resuming
 * before customerDetail/customerPrices finished loading, silently priced the line wrong forever.
 * Mobile tests are pure-logic only (no RN tree) — pinned at the source level, the technique this
 * file already uses for the screen's other resume wiring.
 */
describe("NewOrderScreen resume prices off the PER-PRODUCT tier (R2, B747)", () => {
  const screenSrc = readFileSync(join(__dirname, "..", "components", "NewOrderScreen.tsx"), "utf8");
  const hydrationEffectSrc = screenSrc.slice(
    screenSrc.indexOf("const hydrationStartedRef"),
    screenSrc.indexOf("hydrating, hydrateAttempt, customerDetail, customerPrices"),
  );

  it("resolveResumeLinePricing is called with effectiveTierFor(li.productId), never the bare customerTier", () => {
    expect(hydrationEffectSrc).toMatch(
      /resolveResumeLinePricing\([^)]*effectiveTierFor\(li\.productId\)/,
    );
    expect(hydrationEffectSrc).not.toMatch(
      /resolveResumeLinePricing\(\s*li,\s*product,\s*units,\s*customerTier\s*\)/,
    );
  });

  it("the hydration effect delegates its start/wait/fail decision to decideResumeHydrationStart, never re-inlines the gate", () => {
    expect(hydrationEffectSrc).toMatch(/decideResumeHydrationStart\(/);
  });

  it("the effect re-runs once customerDetail/customerPrices/pricesSettled change — all three are in its dependency array", () => {
    expect(screenSrc).toMatch(
      /\[hydrating, hydrateAttempt, customerDetail, customerPrices, pricesSettled\]/,
    );
  });
});

/**
 * SA-136b/SA-153 (Opus REQUIRED, B747): GET /customers/:id/prices is plan-gated
 * (flag.pricing_tiers) — on LITE/STARTER, or any network error, useCustomerPrices' `data` stays
 * undefined FOREVER (TanStack Query never resolves an errored query's data), so gating the
 * hydration effect on `customerPrices === undefined` (R2's own original fix) left it stuck behind
 * an infinite spinner with no Retry for exactly those tenants. Gating on the query having SETTLED
 * (isFetched || isError) instead lets hydration proceed with an empty per-product override map —
 * completing at the customer's own default tier, never blocked.
 *
 * Second bug this uncovered: customerDetail/customerPrices sit in the effect's OWN dependency
 * array, so a background refetch mid-hydration re-runs the effect — but the cleanup never reset
 * hydrationStartedRef, so the re-run's own top guard (`hydrationStartedRef.current`) silently
 * refused to start, permanently stranding `hydrating` at true with the cancelled run's results
 * discarded and nothing to replace them.
 */
describe("NewOrderScreen resume never hangs on a plan-gated prices query (SA-136b/SA-153, B747)", () => {
  const screenSrc = readFileSync(join(__dirname, "..", "components", "NewOrderScreen.tsx"), "utf8");

  it("destructures isFetched/isError/isFetching/error/refetch from useCustomerPrices, not just data", () => {
    expect(screenSrc).toMatch(
      /const\s*\{\s*data:\s*customerPrices,\s*isFetched:\s*fetched,\s*isError:\s*errored,\s*isFetching:\s*fetching,\s*error:\s*pricesError,\s*refetch:\s*refetchPrices,?\s*\}\s*=\s*useCustomerPrices/,
    );
  });

  it("pricesSettled excludes an in-flight refetch (SA-165) and is not read inline-only", () => {
    expect(screenSrc).toMatch(/const pricesSettled = \(fetched \|\| errored\) && !fetching;/);
    expect(screenSrc).not.toMatch(/!customerDetail\s*\|\|\s*customerPrices\s*===\s*undefined/);
  });

  it("SA-165 wiring: retryHydrate calls refetchPrices before bumping hydrateAttempt", () => {
    const retrySrc = screenSrc.slice(
      screenSrc.indexOf("const retryHydrate = useCallback"),
      screenSrc.indexOf("const hydrationStartedRef"),
    );
    expect(retrySrc).toMatch(/refetchPrices\(\)/);
    expect(retrySrc.indexOf("refetchPrices()")).toBeLessThan(retrySrc.indexOf("setHydrateAttempt"));
  });

  it("Opus wiring: an already-showing failure dialog is never re-triggered by a later dep change", () => {
    expect(screenSrc).toMatch(/gate === "failed" && !hydrateFailed/);
  });

  it("the cleanup resets hydrationStartedRef — a dep-cancelled run can always be re-run, never stranded", () => {
    const cleanupSrc = screenSrc.slice(
      screenSrc.indexOf("return () => {\n      cancelled = true;"),
      screenSrc.indexOf(
        "[hydrating, hydrateAttempt, customerDetail, customerPrices, pricesSettled]",
      ),
    );
    expect(cleanupSrc).toMatch(/hydrationStartedRef\.current\s*=\s*false;/);
  });
});

/**
 * W/N (Opus REQUIRED, B747): the pack-changed re-split (normalizeBoxesPieces, triggered when the
 * live product's unitsPerBox differs from the parked snapshot) must never run for a unit-labeled
 * line — its qty is a plain COUNT of the chosen unit, unrelated to the pack's own box size, and
 * the units_v1 convention requires boxes/pieces to stay undefined on such a line.
 */
describe("resolveResumeLineBoxes — never re-splits a unit-labeled line (W/N, B747)", () => {
  it("a plain pack line whose product's unitsPerBox shrank re-splits (and rolls loose pieces over) via normalizeBoxesPieces", () => {
    // Parked: 2 boxes of 12 + 10 loose = 34 pieces. Live pack shrank to 8: the SAME 2 physical
    // boxes + 10 loose reinterprets to 2*8+10=26 pieces, which rolls over into 3 boxes + 2 loose.
    expect(resolveResumeLineBoxes({ qty: 34, boxes: 2, pieces: 10, unitsPerBox: 12 }, 8)).toEqual({
      boxes: 3,
      pieces: 2,
      qty: 26,
    });
  });

  it("a plain pack line whose product's unitsPerBox is UNCHANGED is left exactly as parked", () => {
    expect(resolveResumeLineBoxes({ qty: 27, boxes: 2, pieces: 3, unitsPerBox: 12 }, 12)).toEqual({
      boxes: 2,
      pieces: 3,
      qty: 27,
    });
  });

  it("W/N (red on the pre-fix code): a unit-labeled line is NEVER re-split, even when unitsPerBox changed", () => {
    expect(resolveResumeLineBoxes({ qty: 3, unitLabel: "Case", unitsPerBox: 12 }, 24)).toEqual({
      boxes: undefined,
      pieces: undefined,
      qty: 3,
    });
  });
});

describe("NewOrderScreen resume wiring (W/N, B747)", () => {
  const screenSrc = readFileSync(join(__dirname, "..", "components", "NewOrderScreen.tsx"), "utf8");

  it("delegates the pack-changed re-split to resolveResumeLineBoxes, never re-implements it inline", () => {
    expect(screenSrc).toMatch(/resolveResumeLineBoxes\(li, Number\(product\.unitsPerBox/);
    expect(screenSrc).not.toMatch(/normalizeBoxesPieces/);
  });

  it("restores unitFactor from resolveResumeLinePricing's result onto the resumed line", () => {
    expect(screenSrc).toMatch(
      /pricing\.unitFactor\s*!==\s*undefined\)\s*line\.unitFactor\s*=\s*pricing\.unitFactor/,
    );
  });
});

describe("decideResumeLine refuses a FAMILY container", () => {
  it("drops a parked line whose product is a FAMILY (never queued from a restored draft)", () => {
    expect(decideResumeLine({ ok: true, product: { id: "f1", kind: "FAMILY" } })).toEqual({
      product: null,
      failed: false,
    });
  });
  it("keeps a variant or plain product", () => {
    const v = { id: "v1", kind: "VARIANT" };
    expect(decideResumeLine({ ok: true, product: v }).product).toBe(v);
  });
});
