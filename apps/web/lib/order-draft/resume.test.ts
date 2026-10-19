import {
  findResumable,
  priceChangedCopy,
  repriceResumedLines,
  RESUME_PROMPT_TITLE,
} from "./resume";
import type { ResumeLine, ServerDraftSummary } from "./resume";
import { payloadHash } from "./payload-hash";
import type { LocalDraftRecord } from "./storage";

// SA-817 (A) 3/5/7: which local copies are offered on open, and how a resumed order is re-priced for display.

const line = (over: Partial<ResumeLine> = {}): ResumeLine => ({
  tempId: "t1",
  productId: "p1",
  unitPrice: 10,
  priceType: "STANDARD",
  tierPrices: { pricePerUnit: 12 }, // today's price at tier 1
  ...over,
});

const payload = (lines: ResumeLine[], extra: Record<string, unknown> = {}) => ({
  customer: { id: "c1", businessName: "Acme" },
  lineItems: lines,
  _submitKey: "K-1",
  ...extra,
});

const record = (over: Partial<LocalDraftRecord> = {}): LocalDraftRecord => {
  const p = (over.payload ?? payload([line()])) as LocalDraftRecord["payload"];
  return {
    localId: "L1",
    tenantId: "t1",
    userId: "u1",
    serverDraftId: null,
    serverUpdatedAt: null,
    syncedHash: null,
    customerId: "c1",
    customerName: "Acme",
    payload: p,
    hash: payloadHash(p),
    savedAt: "2026-10-19T10:00:00.000Z",
    ...over,
  };
};

describe("findResumable (A3, A7)", () => {
  it("the prompt title is the spec's", () => {
    expect(RESUME_PROMPT_TITLE).toBe("Resume your unsent order?");
  });

  it("A3: a local copy with no server draft is offered", () => {
    const r = record();
    expect(findResumable([r], []).resumable.map((c) => c.record.localId)).toEqual(["L1"]);
  });

  it("A3: a local copy that differs from its server draft is offered; one the server holds identically is not (and is reported obsolete)", () => {
    const ahead = record({ serverDraftId: "d1", serverUpdatedAt: "2026-10-19T09:00:00.000Z" });
    const behind: ServerDraftSummary = {
      id: "d1",
      updatedAt: "2026-10-19T09:00:00.000Z",
      payload: payload([]),
    };
    const scan = findResumable([ahead], [behind]);
    expect(scan.resumable).toHaveLength(1);
    expect(scan.resumable[0].serverMoved).toBe(false);

    const same: ServerDraftSummary = { ...behind, payload: ahead.payload };
    const done = findResumable([ahead], [same]);
    expect(done.resumable).toEqual([]);
    expect(done.obsolete.map((r) => r.localId)).toEqual(["L1"]);
  });

  it("A4: a server draft that moved since our last sync still offers the copy, flagged serverMoved (saving will offer both)", () => {
    const ahead = record({ serverDraftId: "d1", serverUpdatedAt: "2026-10-19T09:00:00.000Z" });
    const moved: ServerDraftSummary = {
      id: "d1",
      updatedAt: "2026-10-19T09:30:00.000Z",
      payload: payload([]),
    };
    expect(findResumable([ahead], [moved]).resumable[0].serverMoved).toBe(true);
  });

  it("a server draft that was deleted does not delete the copy: it is still offered", () => {
    const orphan = record({ serverDraftId: "gone", serverUpdatedAt: "2026-10-19T09:00:00.000Z" });
    expect(findResumable([orphan], []).resumable).toHaveLength(1);
  });

  it("an order that was submitted (payload.submittedAt, the existing poison pill) is never offered and is obsolete", () => {
    const sent = record({
      payload: payload([line()], { submittedAt: "2026-10-19T10:01:00.000Z" }) as never,
    });
    const scan = findResumable([sent], []);
    expect(scan.resumable).toEqual([]);
    expect(scan.obsolete).toHaveLength(1);
  });

  it("a copy with no customer or no line is not worth offering - but it is kept, never deleted", () => {
    const empty = record({ payload: payload([]) as never });
    const scan = findResumable([empty], []);
    expect(scan.resumable).toEqual([]);
    expect(scan.obsolete).toEqual([]);
  });

  it("the newest copy is first", () => {
    const old = record({ localId: "old", savedAt: "2026-10-19T08:00:00.000Z" });
    const fresh = record({ localId: "fresh", savedAt: "2026-10-19T11:00:00.000Z" });
    expect(findResumable([old, fresh], []).resumable.map((c) => c.record.localId)).toEqual([
      "fresh",
      "old",
    ]);
  });
});

describe("A5 - resume re-prices for display and flags what moved", () => {
  const tier1 = () => 1;

  it("A5: a draft parked at $10 with today's price $12 shows $12 and carries the parked price for the note", () => {
    const r = repriceResumedLines([line()], tier1);
    expect(r.changed).toBe(1);
    expect(r.lines[0]).toMatchObject({
      unitPrice: 12,
      priceChangedFrom: 10,
      priceType: "STANDARD",
    });
  });

  it("A5: the note reads 'Price changed since you started ($10.00 → $12.00)'", () => {
    expect(priceChangedCopy(10, 12)).toBe("Price changed since you started ($10.00 → $12.00)");
  });

  it("A5: a line whose price did not move is untouched (no note)", () => {
    const same = line({ unitPrice: 12 });
    const r = repriceResumedLines([same], tier1);
    expect(r.changed).toBe(0);
    expect(r.lines[0]).toBe(same);
  });

  it("A5: a staff-typed override with its reason survives exactly as typed", () => {
    const typed = line({
      tempId: "t2",
      unitPrice: 8,
      priceType: "DISCOUNTED",
      discountedPrice: 8,
      overrideReason: "Damaged box",
    });
    const r = repriceResumedLines([typed], tier1);
    expect(r.changed).toBe(0);
    expect(r.lines[0]).toBe(typed);
    expect(r.lines[0]).toMatchObject({ unitPrice: 8, overrideReason: "Damaged box" });
  });

  it("A5: an above-list MANUAL price typed by staff (it carries a discountedPrice) survives too", () => {
    const upsell = line({
      unitPrice: 15,
      priceType: "MANUAL",
      discountedPrice: 15,
      overrideReason: "Rush",
    });
    expect(repriceResumedLines([upsell], tier1).lines[0]).toBe(upsell);
  });

  it("A5: unlisted lines, unit lines and lines with no tier snapshot are left alone", () => {
    const lines = [
      line({ tempId: "u", isUnlisted: true }),
      line({ tempId: "n", unitLabel: "Each" }),
      line({ tempId: "s", tierPrices: undefined }),
    ];
    const r = repriceResumedLines(lines, tier1);
    expect(r.changed).toBe(0);
    expect(r.lines).toEqual(lines);
  });

  it("A5: the customer's own price for the product (the price layer) wins over the list price", () => {
    const layer = [
      {
        ref: "pack",
        label: null,
        price: 9.5,
        listPrice: 12,
        source: "customer" as const,
        aboveList: false,
      },
    ];
    const r = repriceResumedLines([line({ unitPrice: 12 })], tier1, (id) =>
      id === "p1" ? layer : undefined,
    );
    expect(r.lines[0]).toMatchObject({
      unitPrice: 9.5,
      priceChangedFrom: 12,
      priceType: "SPECIAL",
    });
  });

  it("A5: a half-cent difference is not a change (money tolerance from @routeflow/pricing)", () => {
    const r = repriceResumedLines([line({ unitPrice: 11.999 })], tier1);
    expect(r.changed).toBe(0);
  });

  it("A5: re-pricing twice keeps the ORIGINAL parked price in the note", () => {
    const once = repriceResumedLines([line()], tier1).lines;
    const twice = repriceResumedLines(
      once.map((l) => ({ ...l, tierPrices: { pricePerUnit: 14 } })),
      tier1,
    );
    expect(twice.lines[0]).toMatchObject({ unitPrice: 14, priceChangedFrom: 10 });
  });
});
