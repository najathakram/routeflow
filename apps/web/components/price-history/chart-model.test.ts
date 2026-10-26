import type { PriceHistoryComparisonLine, PriceHistoryRow } from "@/lib/api/price-history";
import { buildChartModel, monthLabel, monthMid, NOTE_COPY, unitPhrase } from "./chart-model";

const row = (o: Partial<PriceHistoryRow> = {}): PriceHistoryRow => ({
  date: "2026-09-10T00:00:00.000Z",
  source: "INVOICE",
  unitPrice: 25,
  unitLabel: "Box",
  unitsPerBox: 12,
  qty: 1,
  boxes: null,
  pieces: null,
  avgCostAtSale: null,
  invoiceId: "i1",
  invoiceNumber: "INV-1",
  orderId: "o1",
  orderNumber: "ORD-1",
  priceType: null,
  ...o,
});
const entry = (o: Partial<PriceHistoryComparisonLine> = {}): PriceHistoryComparisonLine => ({
  unitLabel: "Box",
  unitsPerBox: 12,
  likeForLike: [{ month: "2026-09", average: 24 }],
  converted: [{ month: "2026-09", average: 25.11 }],
  ...o,
});
const model = (o: Partial<Parameters<typeof buildChartModel>[0]> = {}) =>
  buildChartModel({
    unit: "Box",
    rows: [row()],
    comparison: [entry()],
    comparisonState: "ready",
    panelOpen: false,
    ...o,
  });

describe("unitPhrase", () => {
  it.each([
    ["Box", 12, "Box of 12"],
    ["Case", 48, "Case of 48"],
    ["Piece", 1, "Piece"],
    ["Piece", null, "Piece"],
    ["Case of 24", 24, "Case of 24"],
  ])("%s + %s -> %s", (label, pack, out) => {
    expect(unitPhrase(label as string, pack as number | null)).toBe(out);
  });
});

describe("months", () => {
  it("monthMid is the 15th, UTC", () => {
    expect(new Date(monthMid("2026-09")).toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });
  it("monthLabel reads 'Aug 2026' in any local zone", () => {
    expect(monthLabel("2026-08")).toBe("Aug 2026");
  });
});

describe("the matching entry and the plot pack", () => {
  it("a tab whose pack differs from the summary's draws lines 2 and 3 from the matching entry", () => {
    const m = model({
      rows: [row({ unitsPerBox: 12 })],
      comparison: [
        entry({ unitsPerBox: 24, likeForLike: [{ month: "2026-09", average: 50 }], converted: [] }),
        entry({ unitsPerBox: 12 }),
      ],
    });
    expect(m.like).toHaveLength(1);
    expect(m.like[0]!.price).toBe(24);
    expect(m.conv[0]!.price).toBe(25.11);
    expect(m.unitPhrase).toBe("Box of 12");
  });

  it("the unit match uses the box/case equivalence", () => {
    expect(model({ unit: "Case", rows: [row({ unitLabel: "Case" })] }).like).toHaveLength(1);
  });

  it("a null pack and a pack of 1 both mean by the piece", () => {
    const m = model({
      unit: "pc",
      rows: [row({ unitLabel: "pc", unitsPerBox: null })],
      comparison: [entry({ unitLabel: "pc", unitsPerBox: null })],
    });
    expect(m.plotPack).toBe(1);
    expect(m.canDraw.like).toBe(true);
  });

  it("an unknown pack is its own honest state, never piece prices (review-b: packOf(null) was 1)", () => {
    // a pre-snapshot Box line: the wire sends unitsPerBox null for BOTH "by the piece" and "pack unknown", and the
    // unit label ("Box") is what tells them apart
    const m = model({
      unit: "Box",
      rows: [row({ unitLabel: "Box", unitsPerBox: null, unitPrice: 25 })],
      comparison: [entry({ unitLabel: "Box", unitsPerBox: null })],
    });
    expect(m.plotPack).toBeNull();
    expect(m.own).toEqual([]);
    expect(m.canDraw).toEqual({ own: false, like: false, conv: false });
    expect(m.notes).toHaveLength(1);
    expect(m.notes[0]!.text).toMatch(/pack size/i);
    expect(m.notes[0]!.lines).toEqual(["own", "like", "conv"]);
  });

  it("an unknown-pack newest row says so even when older rows have a pack (the newest decides the plot)", () => {
    const m = model({
      rows: [
        row({ date: "2026-08-01T00:00:00.000Z", unitsPerBox: 12 }),
        row({ unitsPerBox: null, unitLabel: "Box" }),
      ],
    });
    expect(m.plotPack).toBeNull();
    expect(m.own).toEqual([]);
    expect(m.notes[0]!.text).toMatch(/pack size/i);
  });

  it("a piece unit with no pack is still by the piece (only a pack-type label with no pack is unknown)", () => {
    for (const unitLabel of ["Each", "Piece", "pc", "bottle"]) {
      const m = model({
        unit: unitLabel,
        rows: [row({ unitLabel, unitsPerBox: null })],
        comparison: [entry({ unitLabel, unitsPerBox: null })],
      });
      expect(m.plotPack).toBe(1);
      expect(m.canDraw.own).toBe(true);
    }
  });

  it("no matching entry: lines 2 and 3 cannot draw", () => {
    const m = model({ comparison: [entry({ unitsPerBox: 24 })] });
    expect(m.canDraw).toMatchObject({ own: true, like: false, conv: false });
  });
});

describe("line 1 draws only the plot pack", () => {
  const rows = [
    row({ date: "2026-09-10T00:00:00.000Z", unitsPerBox: 12, unitPrice: 25 }),
    row({ date: "2026-08-10T00:00:00.000Z", unitsPerBox: 12, unitPrice: 24 }),
    row({ date: "2026-07-10T00:00:00.000Z", unitsPerBox: 24, unitPrice: 48 }),
  ];
  it("keeps the newest row's pack, oldest first, and says rows were left out (B1074 chart half)", () => {
    const m = model({ rows });
    expect(m.own.map((p) => p.price)).toEqual([24, 25]);
    expect(m.ownFiltered).toBe(true);
    expect(m.notes.map((n) => n.text)).toContain(NOTE_COPY.filtered("Box of 12"));
  });
  it("a single sale in the plot pack is still one point", () => {
    expect(model({ rows: [row()] }).own).toHaveLength(1);
  });
  it("no filtered note when every row is in the plot pack", () => {
    const m = model({ rows: rows.slice(0, 2) });
    expect(m.ownFiltered).toBe(false);
    expect(m.notes.some((n) => n.id === "ph-note-filtered")).toBe(false);
  });
});

describe("never sold", () => {
  it("the one entry for the unit is the plot, with its pack", () => {
    const m = model({ rows: [], comparison: [entry()] });
    expect(m.plotPack).toBe(12);
    expect(m.canDraw).toMatchObject({ own: false, like: true, conv: true });
    expect(m.unitPhrase).toBe("Box of 12");
  });
  it("both reference lines empty: the KEPT sentence replaces the combined note", () => {
    const m = model({ rows: [], comparison: [entry({ likeForLike: [], converted: [] })] });
    expect(m.notes.map((n) => n.text)).toEqual([NOTE_COPY.neverSoldNoAverages]);
  });
  it("no entry at all reads the same", () => {
    expect(model({ rows: [], comparison: [] }).notes[0]!.text).toBe(NOTE_COPY.neverSoldNoAverages);
  });
  it("line 2 empty and line 3 drawn: line 2's note only (spec state 8)", () => {
    const m = model({ rows: [], comparison: [entry({ likeForLike: [] })] });
    expect(m.notes.map((n) => n.text)).toEqual([NOTE_COPY.likeEmpty("Box of 12")]);
  });
});

describe("the notes", () => {
  it("line 2 empty only", () => {
    const m = model({ comparison: [entry({ likeForLike: [] })] });
    expect(m.notes.map((n) => [n.id, n.lines])).toEqual([["ph-note-like", ["like"]]]);
    expect(m.notes[0]!.text).toBe(
      "Other customers: no average for Box of 12 yet. It needs 3 other buyers in a month.",
    );
  });
  it("line 3 empty only", () => {
    const m = model({ comparison: [entry({ converted: [] })] });
    expect(m.notes.map((n) => n.text)).toEqual([
      "All units: no average yet. It needs 3 other buyers in a month.",
    ]);
  });
  it("both empty: one line replaces both", () => {
    const m = model({ comparison: [entry({ likeForLike: [], converted: [] })] });
    expect(m.notes.map((n) => n.text)).toEqual([
      "No averages yet. Each needs 3 other buyers in a month.",
    ]);
  });
  it("an older server (no comparison field)", () => {
    const m = model({ comparison: undefined });
    expect(m.notes.map((n) => n.text)).toEqual(["Averages aren't available."]);
    expect(m.canDraw.like || m.canDraw.conv).toBe(false);
  });
  it("loading and failed", () => {
    expect(model({ comparisonState: "loading", comparison: undefined }).notes[0]).toMatchObject({
      text: "Loading averages…",
      role: "status",
    });
    expect(model({ comparisonState: "error", comparison: undefined }).notes[0]).toMatchObject({
      text: "Couldn't load the averages.",
      role: "alert",
      retry: true,
    });
  });
  it("one loading or failure message, not two: the open compare panel carries it", () => {
    const loading = model({ comparisonState: "loading", comparison: undefined, panelOpen: true });
    expect(loading.notes).toEqual([]);
    expect(loading.coveredByPanel).toBe(true);
    expect(
      model({ comparisonState: "error", comparison: undefined, panelOpen: true }).notes,
    ).toEqual([]);
  });
  it("lines are not drawn while loading or failed, even with data in hand", () => {
    expect(model({ comparisonState: "loading" }).canDraw).toMatchObject({
      like: false,
      conv: false,
    });
  });
});
