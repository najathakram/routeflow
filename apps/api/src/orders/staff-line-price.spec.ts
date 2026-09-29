/**
 * #2716c — the ONE staff price-override rule (`decideStaffOverride`, @routeflow/pricing) as the
 * three order-edit call sites use it: existing-line edit (B), add-during-edit (C), replaceAll
 * changed-price arm (SA-558d). Below list => DISCOUNTED, at/above list => MANUAL, originalPrice =
 * LIST; an untouched line keeps its stored type (forward-only, no re-stamp).
 */
import { BadRequestException } from "@nestjs/common";
import {
  decideAddedLinePrice,
  decideEditedLinePrice,
  decideReplaceAllLinePrice,
} from "./staff-line-price";

describe("decideEditedLinePrice (B: existing-line edit, baseline = stored price)", () => {
  const base = {
    storedPrice: 4.99,
    tierPrice: 6,
    listPrice: 6,
    isSpecialTier: false,
    hasReason: false,
    isUnlisted: false,
    productName: "Widget",
  };

  it("a price below list is DISCOUNTED with originalPrice = list", () => {
    expect(decideEditedLinePrice({ ...base, overridePrice: 4 })).toEqual({
      priceType: "DISCOUNTED",
      unitPrice: 4,
      originalPrice: 6,
    });
  });

  it("a price above list is MANUAL with originalPrice = list; AT list is MANUAL too", () => {
    expect(decideEditedLinePrice({ ...base, overridePrice: 8 })).toEqual({
      priceType: "MANUAL",
      unitPrice: 8,
      originalPrice: 6,
    });
    expect(
      decideEditedLinePrice({
        ...base,
        isSpecialTier: true,
        hasReason: true,
        tierPrice: 5,
        overridePrice: 6,
      })?.priceType,
    ).toBe("MANUAL");
  });

  it("within half a cent of the STORED price is untouched (null: no re-stamp)", () => {
    expect(decideEditedLinePrice({ ...base, overridePrice: 4.994 })).toBeNull();
    expect(decideEditedLinePrice({ ...base, overridePrice: null })).toBeNull();
  });

  it("a special-tier line with no sent or stored reason is refused", () => {
    expect(() => decideEditedLinePrice({ ...base, isSpecialTier: true, overridePrice: 4 })).toThrow(
      new BadRequestException(
        "A reason is required to change Widget — it's this customer's special price",
      ),
    );
  });

  it("a STORED reason counts (baseline = stored price, reason = sent-or-stored)", () => {
    expect(
      decideEditedLinePrice({ ...base, isSpecialTier: true, hasReason: true, overridePrice: 4 }),
    ).toEqual({ priceType: "DISCOUNTED", unitPrice: 4, originalPrice: 6 });
  });

  it("an unlisted line has no list: MANUAL, rounded, originalPrice null", () => {
    expect(decideEditedLinePrice({ ...base, isUnlisted: true, overridePrice: 7.777 })).toEqual({
      priceType: "MANUAL",
      unitPrice: 7.78,
      originalPrice: null,
    });
  });
});

describe("decideAddedLinePrice (C: add-during-edit, baseline = the customer's tier price)", () => {
  const base = {
    tierPrice: 5,
    listPrice: 6,
    isSpecialTier: false,
    hasReason: false,
    productName: "Widget",
  };

  it("below list is DISCOUNTED / above list is MANUAL, both anchored to list", () => {
    expect(decideAddedLinePrice({ ...base, overridePrice: 4 })).toEqual({
      priceType: "DISCOUNTED",
      unitPrice: 4,
      originalPrice: 6,
    });
    expect(decideAddedLinePrice({ ...base, overridePrice: 8 })).toEqual({
      priceType: "MANUAL",
      unitPrice: 8,
      originalPrice: 6,
    });
  });

  it("a special-tier price within half a cent of the tier price is SPECIAL at the clean tier price", () => {
    expect(decideAddedLinePrice({ ...base, isSpecialTier: true, overridePrice: 5.004 })).toEqual({
      priceType: "SPECIAL",
      unitPrice: 5,
      originalPrice: 6,
    });
  });

  it("a special-tier change without a reason is refused; the create-merge skip lets it through", () => {
    expect(() => decideAddedLinePrice({ ...base, isSpecialTier: true, overridePrice: 4 })).toThrow(
      BadRequestException,
    );
    expect(
      decideAddedLinePrice({ ...base, isSpecialTier: true, overridePrice: 4, hasReason: true }),
    ).toEqual({ priceType: "DISCOUNTED", unitPrice: 4, originalPrice: 6 });
  });

  it("a non-special typed price equal to list stays STANDARD with no original", () => {
    expect(decideAddedLinePrice({ ...base, tierPrice: 6, overridePrice: 6 })).toEqual({
      priceType: "STANDARD",
      unitPrice: 6,
      originalPrice: null,
    });
  });
});

describe("decideReplaceAllLinePrice (SA-558d: replaceAll changed-price arm)", () => {
  const stored = { unitPrice: 4, priceType: "MANUAL", originalPrice: 6 } as const;
  const base = {
    tierPrice: 5,
    listPrice: 6,
    isSpecialTier: false,
    hasReason: false,
    skipReasonGuard: false,
    productName: "Widget",
  };

  it("an echo of a stored MANUAL-below-list line is preserved verbatim (never re-stamped)", () => {
    expect(decideReplaceAllLinePrice({ ...base, existing: stored, overridePrice: 4.003 })).toEqual({
      priceType: "MANUAL",
      unitPrice: 4,
      originalPrice: 6,
      repriced: false,
    });
  });

  it("a changed price against the stored line: below list DISCOUNTED, above MANUAL", () => {
    const e = { unitPrice: 4.99, priceType: "STANDARD", originalPrice: null } as const;
    expect(decideReplaceAllLinePrice({ ...base, existing: e, overridePrice: 4 })).toEqual({
      priceType: "DISCOUNTED",
      unitPrice: 4,
      originalPrice: 6,
      repriced: true,
    });
    expect(decideReplaceAllLinePrice({ ...base, existing: e, overridePrice: 8 })).toMatchObject({
      priceType: "MANUAL",
      originalPrice: 6,
      repriced: true,
    });
  });

  it("a new line (no stored counterpart) classifies against the tier price", () => {
    expect(decideReplaceAllLinePrice({ ...base, existing: null, overridePrice: 4 })).toEqual({
      priceType: "DISCOUNTED",
      unitPrice: 4,
      originalPrice: 6,
      repriced: true,
    });
    expect(decideReplaceAllLinePrice({ ...base, existing: null, overridePrice: 8 })).toMatchObject({
      priceType: "MANUAL",
    });
  });

  it("a typed price at the tier price is not an override (STANDARD, no original)", () => {
    expect(decideReplaceAllLinePrice({ ...base, existing: null, overridePrice: 5.002 })).toEqual({
      priceType: "STANDARD",
      unitPrice: 5,
      originalPrice: null,
      repriced: false,
    });
  });

  it("special tier: refused without a reason; create-merge new line skips the guard", () => {
    const sp = { ...base, isSpecialTier: true, existing: null, overridePrice: 4 };
    expect(() => decideReplaceAllLinePrice(sp)).toThrow(BadRequestException);
    expect(decideReplaceAllLinePrice({ ...sp, skipReasonGuard: true })).toMatchObject({
      priceType: "DISCOUNTED",
      repriced: true,
    });
  });
});

describe("SA-592 fold 1 — the band is withinStaffOverrideTolerance, not a raw float compare", () => {
  it("edit: 8.005 against a stored 8 is inside the band (raw Math.abs is 0.00500000000000078)", () => {
    expect(
      decideEditedLinePrice({
        overridePrice: 8.005,
        storedPrice: 8,
        tierPrice: 10,
        listPrice: 10,
        isSpecialTier: false,
        hasReason: false,
        isUnlisted: false,
      }),
    ).toBeNull();
  });

  it("replaceAll: 8.005 against a stored 8 echoes the stored row verbatim", () => {
    const d = decideReplaceAllLinePrice({
      overridePrice: 8.005,
      existing: { unitPrice: 8, priceType: "DISCOUNTED", originalPrice: 10 },
      tierPrice: 10,
      listPrice: 10,
      isSpecialTier: false,
      hasReason: false,
      skipReasonGuard: false,
    });
    expect(d).toEqual({
      priceType: "DISCOUNTED",
      unitPrice: 8,
      originalPrice: 10,
      repriced: false,
    });
  });
});

describe("SA-592 fold 2 — typing the TIER price back restores the clean type (SA-558 (1))", () => {
  const edited = {
    listPrice: 12,
    isSpecialTier: true,
    hasReason: false,
    isUnlisted: false,
    productName: "Widget",
  };

  it("edit: stored MANUAL-12, special tier 10, typed 10 => SPECIAL/10, list 12, no reason needed", () => {
    expect(
      decideEditedLinePrice({ ...edited, storedPrice: 12, tierPrice: 10, overridePrice: 10 }),
    ).toEqual({ priceType: "SPECIAL", unitPrice: 10, originalPrice: 12 });
  });

  it("edit: within half a cent of the tier price restores at the clean tier price", () => {
    expect(
      decideEditedLinePrice({ ...edited, storedPrice: 12, tierPrice: 10, overridePrice: 10.004 }),
    ).toEqual({ priceType: "SPECIAL", unitPrice: 10, originalPrice: 12 });
  });

  it("edit: tier-1 line stored DISCOUNTED-8, list 10, typed 10 => STANDARD, no original", () => {
    expect(
      decideEditedLinePrice({
        ...edited,
        listPrice: 10,
        isSpecialTier: false,
        storedPrice: 8,
        tierPrice: 10,
        overridePrice: 10,
      }),
    ).toEqual({ priceType: "STANDARD", unitPrice: 10, originalPrice: null });
  });

  it("edit: a price that is neither stored nor tier still needs the reason on a special tier", () => {
    expect(() =>
      decideEditedLinePrice({ ...edited, storedPrice: 12, tierPrice: 10, overridePrice: 9 }),
    ).toThrow(BadRequestException);
  });

  it("replaceAll: existing MANUAL-12, special tier 10, typed 10 => SPECIAL/10, restored, no reason", () => {
    expect(
      decideReplaceAllLinePrice({
        overridePrice: 10,
        existing: { unitPrice: 12, priceType: "MANUAL", originalPrice: 12 },
        tierPrice: 10,
        listPrice: 12,
        isSpecialTier: true,
        hasReason: false,
        skipReasonGuard: false,
      }),
    ).toEqual({
      priceType: "SPECIAL",
      unitPrice: 10,
      originalPrice: 12,
      repriced: false,
      restored: true,
    });
  });

  it("replaceAll: tier-1 existing DISCOUNTED-8, list 10, typed 10 => STANDARD, restored", () => {
    expect(
      decideReplaceAllLinePrice({
        overridePrice: 10,
        existing: { unitPrice: 8, priceType: "DISCOUNTED", originalPrice: 10 },
        tierPrice: 10,
        listPrice: 10,
        isSpecialTier: false,
        hasReason: false,
        skipReasonGuard: false,
      }),
    ).toEqual({
      priceType: "STANDARD",
      unitPrice: 10,
      originalPrice: null,
      repriced: false,
      restored: true,
    });
  });
});
