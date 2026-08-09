import { hashFile, lineFingerprint, normalizeInvoiceNumber } from "./invoice-scan.fingerprint";

describe("hashFile", () => {
  it("is stable for the same bytes", () => {
    const a = hashFile([Buffer.from("page-one"), Buffer.from("page-two")]);
    const b = hashFile([Buffer.from("page-one"), Buffer.from("page-two")]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats a re-ordered multi-page upload as a different document", () => {
    const forwards = hashFile([Buffer.from("page-one"), Buffer.from("page-two")]);
    const backwards = hashFile([Buffer.from("page-two"), Buffer.from("page-one")]);
    expect(forwards).not.toBe(backwards);
  });

  it("changes when any byte changes", () => {
    expect(hashFile([Buffer.from("invoice")])).not.toBe(hashFile([Buffer.from("invoicf")]));
  });
});

describe("lineFingerprint", () => {
  const lines = [
    { qty: 12, unitCost: 3.25 },
    { qty: 4, unitCost: 19.5 },
  ];

  it("ignores how the lines were transcribed — only the numbers count", () => {
    const firstScan = lineFingerprint(
      [
        { qty: 12, unitCost: 3.25, description: "COCA COLA 12OZ CAN" },
        { qty: 4, unitCost: 19.5, description: "LAYS CLASSIC 1OZ" },
      ] as never,
      117,
    );
    const rescan = lineFingerprint(
      [
        { qty: 12, unitCost: 3.25, description: "Coke 12 oz cans" },
        { qty: 4, unitCost: 19.5, description: "Lay's Classic, 1 oz" },
      ] as never,
      117,
    );
    expect(firstScan).toBe(rescan);
    expect(firstScan).not.toBeNull();
  });

  it("does not depend on line order", () => {
    expect(lineFingerprint(lines, 117)).toBe(lineFingerprint([...lines].reverse(), 117));
  });

  it("changes when a quantity differs", () => {
    const changed = [{ qty: 13, unitCost: 3.25 }, lines[1]];
    expect(lineFingerprint(changed, 117)).not.toBe(lineFingerprint(lines, 117));
  });

  it("changes when a unit cost differs", () => {
    const changed = [{ qty: 12, unitCost: 3.26 }, lines[1]];
    expect(lineFingerprint(changed, 117)).not.toBe(lineFingerprint(lines, 117));
  });

  it("changes when the document total differs", () => {
    expect(lineFingerprint(lines, 117)).not.toBe(lineFingerprint(lines, 125));
  });

  it("accepts numeric strings the same as numbers", () => {
    expect(lineFingerprint([{ qty: "12", unitCost: "3.25" }], 39)).toBe(
      lineFingerprint([{ qty: 12, unitCost: 3.25 }], 39),
    );
  });

  it("falls back to the line extension when the total was never read", () => {
    // 12 x 3.25 = 39
    expect(lineFingerprint([{ qty: 12, unitCost: 3.25 }], null)).toBe(
      lineFingerprint([{ qty: 12, unitCost: 3.25 }], 39),
    );
  });

  it("returns null for no lines", () => {
    expect(lineFingerprint([], 100)).toBeNull();
  });

  it("returns null when every line is unusable", () => {
    expect(
      lineFingerprint(
        [
          { qty: NaN, unitCost: 3 },
          { qty: "abc", unitCost: "xyz" },
          { qty: 0, unitCost: 5 },
          { qty: null, unitCost: undefined },
        ],
        100,
      ),
    ).toBeNull();
  });

  it("returns null for a line set worth nothing, which would collide across documents", () => {
    expect(lineFingerprint([{ qty: 3, unitCost: 0 }], 0)).toBeNull();
  });

  it("drops the unusable lines and fingerprints the rest", () => {
    const withGarbage = lineFingerprint([{ qty: 12, unitCost: 3.25 }, { qty: NaN }], 39);
    expect(withGarbage).toBe(lineFingerprint([{ qty: 12, unitCost: 3.25 }], 39));
  });
});

describe("normalizeInvoiceNumber", () => {
  it("reuses the matcher's rule — uppercase, whitespace stripped", () => {
    expect(normalizeInvoiceNumber("inv 088 41")).toBe("INV08841");
    expect(normalizeInvoiceNumber(null)).toBe("");
  });
});
