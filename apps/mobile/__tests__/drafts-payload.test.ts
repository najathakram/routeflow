/**
 * Locks the parked-drafts payload contract (pos-cost-roles-spec §2, PR-3):
 * `toOrderDraftPayload`/`fromOrderDraftPayload` round-trip the order builder's
 * full state, unlisted lines fold into the SAME `DraftLineItem` array as
 * catalog lines (isUnlisted:true — no separate `unlisted[]` on the wire), and
 * `draftParkable` requires a customer AND at least one line.
 */
import {
  toOrderDraftPayload,
  fromOrderDraftPayload,
  draftParkable,
  draftDeviceLabel,
  parkedAgo,
  draftSummary,
  type DraftBuilderState,
  type DraftCatalogLine,
  type DraftLineItem,
  type OrderDraftPayload,
} from "../lib/drafts-payload";

const fixture: DraftBuilderState = {
  customer: { id: "cust-1", businessName: "Acme Wholesale", contactName: "Jane", pricingTier: 2 },
  items: [
    {
      productId: "prod-1",
      productName: "Widget Case",
      unit: "each",
      listPrice: 100,
      specialPrice: 90,
      discountedPrice: 75,
      unitPrice: 75, // MANUAL override
      priceType: "MANUAL",
      qty: 30,
      unitsPerBox: 24,
      boxes: 1,
      pieces: 6,
      unitCost: 40,
      category: "General",
      note: "Deliver to back dock",
    },
  ],
  unlisted: [
    {
      id: "local-1",
      name: "Pallet wrap (custom)",
      unitPrice: 12.5,
      qty: 2,
      note: "Customer's own request",
    },
  ],
  floorAcked: ["prod-1"],
  orderNotes: "Call ahead",
  orderUrgent: true,
  deliveryDate: "2026-08-20",
  orderDate: "2026-08-18",
  discountRaw: "10",
  shippingFeeRaw: "5",
  selectedCreditIds: ["credit-1", "credit-2"],
  // Deliberately the NON-default mode, so the round-trip test below proves the
  // parked value is restored rather than re-defaulted.
  fulfillPath: "SHIP",
};

describe("toOrderDraftPayload / fromOrderDraftPayload round-trip", () => {
  it("round-trips the full fixture (boxed+overridden+noted line, unlisted line, credit ids, floorAcked)", () => {
    const payload = toOrderDraftPayload(fixture);
    const restored = fromOrderDraftPayload(payload);
    expect(restored).toEqual(fixture);
  });

  it("folds the unlisted line into the SAME lineItems array with isUnlisted:true — no separate array", () => {
    const payload = toOrderDraftPayload(fixture);
    expect(payload.lineItems).toHaveLength(2);
    expect((payload as unknown as { unlisted?: unknown }).unlisted).toBeUndefined();
    const unlistedLine = payload.lineItems.find((li) => li.isUnlisted);
    expect(unlistedLine).toMatchObject({
      tempId: "local-1",
      productId: "",
      productName: "Pallet wrap (custom)",
      unitPrice: 12.5,
      qty: 2,
      note: "Customer's own request",
      isUnlisted: true,
    });
  });

  it("uses productId as tempId for catalog lines, keeping floorAcked stable", () => {
    const payload = toOrderDraftPayload(fixture);
    const catalogLine = payload.lineItems.find((li) => !li.isUnlisted);
    expect(catalogLine?.tempId).toBe("prod-1");
    expect(catalogLine?.productId).toBe("prod-1");
    expect(payload.floorAcked).toEqual(["prod-1"]);
  });

  it("carries boxed/override money through unchanged — never a raw qty*unitPrice recompute", () => {
    const payload = toOrderDraftPayload(fixture);
    const catalogLine = payload.lineItems.find((li) => !li.isUnlisted);
    expect(catalogLine).toMatchObject({
      unitPrice: 75,
      priceType: "MANUAL",
      boxes: 1,
      pieces: 6,
      unitsPerBox: 24,
      qty: 30,
    });
  });

  it("writes selectedCreditIds on the wire and restores it exactly", () => {
    const payload = toOrderDraftPayload(fixture);
    expect(payload.selectedCreditIds).toEqual(["credit-1", "credit-2"]);
    expect(fromOrderDraftPayload(payload).selectedCreditIds).toEqual(["credit-1", "credit-2"]);
  });

  it("omits selectedCreditIds from the wire when none are selected, and restores []", () => {
    const noCredits: DraftBuilderState = { ...fixture, selectedCreditIds: [] };
    const payload = toOrderDraftPayload(noCredits);
    expect(payload.selectedCreditIds).toBeUndefined();
    expect(fromOrderDraftPayload(payload).selectedCreditIds).toEqual([]);
  });

  it("defaults selectedCreditIds to [] when resuming a payload that never had the field (pre-PR-3 / web-parked)", () => {
    const legacyPayload = toOrderDraftPayload(fixture);
    delete legacyPayload.selectedCreditIds;
    expect(fromOrderDraftPayload(legacyPayload).selectedCreditIds).toEqual([]);
  });

  it("writes fulfillPath on the wire and restores it — a parked SHIP order resumes as SHIP", () => {
    const payload = toOrderDraftPayload(fixture);
    expect(payload.fulfillPath).toBe("SHIP");
    expect(fromOrderDraftPayload(payload).fulfillPath).toBe("SHIP");
  });

  it("defaults fulfillPath to ROUTE when resuming a payload parked before the field existed", () => {
    const legacyPayload = toOrderDraftPayload(fixture);
    delete legacyPayload.fulfillPath;
    expect(fromOrderDraftPayload(legacyPayload).fulfillPath).toBe("ROUTE");
  });
});

describe("draftParkable", () => {
  it("is false for a customer-only state — no lines at all", () => {
    expect(draftParkable({ ...fixture, items: [], unlisted: [] })).toBe(false);
  });

  it("is false with lines but no customer picked yet", () => {
    expect(draftParkable({ ...fixture, customer: null })).toBe(false);
  });

  it("is true once a customer AND at least one catalog line exist", () => {
    expect(draftParkable(fixture)).toBe(true);
  });

  it("is true with only an unlisted line (no catalog line)", () => {
    expect(draftParkable({ ...fixture, items: [] })).toBe(true);
  });
});

describe("draftDeviceLabel", () => {
  it("labels iOS/Android/other RN platforms without importing react-native itself", () => {
    expect(draftDeviceLabel("ios")).toBe("iOS app");
    expect(draftDeviceLabel("android")).toBe("Android app");
    expect(draftDeviceLabel("web")).toBe("Mobile web");
  });
});

describe("parkedAgo", () => {
  it("buckets elapsed time into just-now / min / h / d", () => {
    const now = Date.now();
    expect(parkedAgo(new Date(now - 10_000).toISOString())).toBe("just now");
    expect(parkedAgo(new Date(now - 5 * 60_000).toISOString())).toBe("5 min ago");
    expect(parkedAgo(new Date(now - 3 * 3600_000).toISOString())).toBe("3 h ago");
    expect(parkedAgo(new Date(now - 2 * 86400_000).toISOString())).toBe("2 d ago");
  });
});

describe("draftSummary", () => {
  it("sums line subtotals via computeLineSubtotal (boxed proration), never qty*unitPrice", () => {
    const payload = toOrderDraftPayload(fixture);
    const draft = {
      id: "d1",
      kind: "ORDER" as const,
      customerId: "cust-1",
      customerName: "Acme Wholesale",
      title: null,
      payload: payload as unknown as Record<string, unknown>,
      device: "iOS app",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const summary = draftSummary(draft);
    // catalog line: 75 * (1 + 6/24) = 93.75; unlisted: 12.5 * 2 = 25 -> 118.75
    expect(summary.itemCount).toBe(2);
    expect(summary.total).toBeCloseTo(118.75, 2);
    expect(summary.title).toBe("Order, Acme Wholesale");
  });

  it("falls back to a generic title when there's no customer name or saved title", () => {
    const draft = {
      id: "d2",
      kind: "ORDER" as const,
      payload: { lineItems: [] } as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(draftSummary(draft).title).toBe("Order draft");
    expect(draftSummary(draft).itemCount).toBe(0);
    expect(draftSummary(draft).total).toBe(0);
  });
});

// ─── B638: a hand-typed mirror of web's parked line must not drop what web parks ────────────────────
//
// Web parks its whole builder `LineItem`, which carries keys web's own `DraftLineItem` never declares
// (unitLabel, packBase, sellBy, trackedCategoryId, noteOpen, tierPrices, ...). The mirror used to drop
// them: a Case line parked on web resumed on mobile as a pack line. The guard below is STRUCTURAL: it
// enumerates the keys of a web-shaped line, so the next field web adds cannot be dropped silently.

const webPackBase = {
  unit: "each",
  qty: 288,
  unitsPerBox: 24,
  boxes: 12,
  pieces: 0,
  sellBy: "case" as const,
  listPrice: 42,
  unitPrice: 42,
  priceType: "STANDARD" as const,
  unitCost: 30,
};

/** A catalog line exactly as web's builder parks it — every LineItem key, plus one web has not added yet. */
const webUnitLine = {
  tempId: "web-tmp-1", // web mints a random tempId; the mirror re-derives it (= productId) by design
  productId: "prod-case",
  productName: "Widget",
  unit: "each",
  listPrice: 480,
  unitPrice: 480,
  priceType: "STANDARD",
  qty: 1,
  unitCost: 30,
  category: "General",
  isUnlisted: false,
  note: "one case",
  trackedCategoryId: "cat-tracked",
  noteOpen: true,
  sellBy: "case",
  unitLabel: "Case",
  packBase: webPackBase,
  tierPrices: { pricePerUnit: "42", priceTier2: "40" },
  zzFutureWebField: { nested: [1, 2, 3] }, // a key nobody has modeled yet
} as const;

const webUnlistedLine = {
  tempId: "web-unl-1",
  productId: "",
  productName: "Pallet wrap",
  unit: "each",
  listPrice: 12.5,
  unitPrice: 12.5,
  priceType: "STANDARD",
  qty: 2,
  isUnlisted: true,
  noteOpen: true,
  zzFutureWebField: "keep me",
} as const;

function webPayload(lines: readonly object[]): OrderDraftPayload {
  return {
    customer: { id: "cust-1", businessName: "Acme" },
    lineItems: lines as unknown as DraftLineItem[],
    orderDiscount: "",
    shippingFee: "",
    requestedDeliveryDate: "",
    orderDate: "",
    notes: "",
    urgent: false,
    floorAcked: [],
  };
}

describe("structural round-trip: every key web parks on a line survives", () => {
  const before = webPayload([webUnitLine, webUnlistedLine]);
  const after = toOrderDraftPayload(fromOrderDraftPayload(before));

  // Catalog lines re-derive tempId = productId on purpose (keeps floorAcked stable on mobile).
  const DERIVED = new Set(["tempId"]);

  it.each(before.lineItems.map((li) => [li.productName, li] as const))(
    "%s: no key is dropped or changed on park -> resume -> re-park",
    (name, original) => {
      const roundTripped = after.lineItems.find((li) => li.productName === name);
      expect(roundTripped).toBeDefined();
      const lost = Object.keys(original).filter(
        (key) =>
          !DERIVED.has(key) &&
          JSON.stringify(roundTripped?.[key]) !== JSON.stringify(original[key]),
      );
      expect(lost).toEqual([]);
    },
  );

  it("keeps a unit line's unitLabel and packBase as typed fields on the builder state", () => {
    const state = fromOrderDraftPayload(before);
    expect(state.items[0].unitLabel).toBe("Case");
    expect(state.items[0].packBase).toEqual(webPackBase);
  });

  it("a mobile-origin line (no extra keys) still emits exactly what it did before", () => {
    const out = toOrderDraftPayload(fixture);
    expect(Object.keys(out.lineItems[0]).sort()).toEqual(
      [
        "tempId",
        "productId",
        "productName",
        "unit",
        "listPrice",
        "specialPrice",
        "discountedPrice",
        "unitPrice",
        "priceType",
        "qty",
        "unitsPerBox",
        "boxes",
        "pieces",
        "unitCost",
        "category",
        "note",
        "unitLabel",
        "packBase",
        "priceSource",
      ].sort(),
    );
  });
});

describe("priceSource (B755) round-trips through the draft payload", () => {
  it("toOrderDraftPayload -> fromOrderDraftPayload -> toOrderDraftPayload carries priceSource through intact", () => {
    const withHistory: DraftBuilderState = {
      ...fixture,
      items: [{ ...fixture.items[0], priceType: "MANUAL", unitPrice: 39, priceSource: "history" }],
    };
    const payload = toOrderDraftPayload(withHistory);
    expect(payload.lineItems[0].priceSource).toBe("history");

    const restored = fromOrderDraftPayload(payload);
    expect(restored.items[0].priceSource).toBe("history");

    const again = toOrderDraftPayload(restored);
    expect(again.lineItems[0].priceSource).toBe("history");
  });

  it('an operator override (priceSource: "operator") round-trips the same way', () => {
    const withOperator: DraftBuilderState = {
      ...fixture,
      items: [{ ...fixture.items[0], priceType: "MANUAL", unitPrice: 39, priceSource: "operator" }],
    };
    const restored = fromOrderDraftPayload(toOrderDraftPayload(withOperator));
    expect(restored.items[0].priceSource).toBe("operator");
  });

  it("a legacy line with no priceSource at all round-trips as undefined, not defaulted to either value", () => {
    const restored = fromOrderDraftPayload(toOrderDraftPayload(fixture));
    expect(restored.items[0].priceSource).toBeUndefined();
  });
});
