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
