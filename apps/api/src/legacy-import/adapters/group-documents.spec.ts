import type { CanonicalLine } from "./canonical";
import { groupDocuments } from "./group-documents";

let rec = 0;
function line(over: Partial<CanonicalLine> = {}): CanonicalLine {
  rec += 1;
  return {
    recordNo: rec + 1,
    physicalLine: rec + 1,
    docNumber: "1001",
    customerName: "ACME",
    issueDate: "2025-03-04",
    itemName: "Acme Widget",
    description: null,
    quantity: 1,
    unitPrice: 5,
    total: 5,
    sku: null,
    defects: [],
    ...over,
  };
}

// T5 (SA-1295): the same item twice in one document stays two lines.
describe("groupDocuments (T5 lines)", () => {
  it("keeps the same item twice in one document as 2 lines keyed by document key + position", () => {
    const { documents } = groupDocuments([
      line({ itemName: "Acme Widget", total: 5 }),
      line({ itemName: "Acme Widget", total: 7 }),
    ]);
    expect(documents).toHaveLength(1);
    const lines = documents[0].lines;
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(lines.map((l) => l.lineKey)).toEqual([
      `${documents[0].sourceKey}#1`,
      `${documents[0].sourceKey}#2`,
    ]);
    expect(lines.map((l) => l.total)).toEqual([5, 7]);
  });

  it("groups by document key, not adjacency", () => {
    const { documents } = groupDocuments([
      line({ docNumber: "1", total: 1 }),
      line({ docNumber: "2", total: 2 }),
      line({ docNumber: "1", total: 3 }),
    ]);
    expect(documents.map((d) => [d.docNumber, d.lines.map((l) => l.total)])).toEqual([
      ["1", [1, 3]],
      ["2", [2]],
    ]);
  });

  it("classifies each line and keeps the file total", () => {
    const { documents } = groupDocuments([
      line({ quantity: null, total: 4.5, unitPrice: 4.5 }),
      line({ itemName: null, description: "Shipping", quantity: null, unitPrice: null, total: 9 }),
    ]);
    expect(documents[0].lines.map((l) => [l.kind, l.quantity, l.total])).toEqual([
      ["PRODUCT", null, 4.5],
      ["SHIPPING", null, 9],
    ]);
  });
});

// T6, grouper half (SA-1295): blank customer is HELD, never silently skipped; no partial attach.
describe("groupDocuments (T6 customer)", () => {
  it("HOLDS a document whose first line has a blank customer, with a row error, not a skip", () => {
    const first = line({ customerName: "" });
    const second = line({ customerName: "ACME" });
    const { documents, issues } = groupDocuments([first, second]);
    expect(documents).toHaveLength(1);
    expect(documents[0].held).toBe(true);
    expect(documents[0].holdCodes).toContain("BLANK_CUSTOMER");
    expect(documents[0].customerKey).toBeNull();
    const issue = issues.find((i) => i.code === "BLANK_CUSTOMER");
    expect(issue).toMatchObject({
      severity: "ERROR",
      physicalLine: first.physicalLine,
      recordNo: first.recordNo,
    });
  });

  it("lets a later blank cell take the one name used on the document's other lines, as a warning", () => {
    const { documents, issues } = groupDocuments([
      line({ customerName: "ACME" }),
      line({ customerName: "" }),
    ]);
    expect(documents[0].held).toBe(false);
    expect(documents[0].customerKey).toBe("ACME");
    expect(issues.filter((i) => i.severity === "WARNING").map((i) => i.code)).toEqual([
      "BLANK_CUSTOMER_INHERITED",
    ]);
  });

  it("HOLDS a document that names two different customers", () => {
    const { documents } = groupDocuments([
      line({ customerName: "ACME" }),
      line({ customerName: "ACME 2" }),
    ]);
    expect(documents[0].held).toBe(true);
    expect(documents[0].holdCodes).toContain("CUSTOMER_CONFLICT");
  });

  it("never folds ACME and ACME 2: two documents keep two exact, distinct customer keys", () => {
    const { documents } = groupDocuments([
      line({ docNumber: "1", customerName: "ACME" }),
      line({ docNumber: "2", customerName: "ACME 2" }),
    ]);
    expect(documents.map((d) => d.customerKey)).toEqual(["ACME", "ACME 2"]);
    expect(documents.every((d) => !d.held)).toBe(true);
  });

  it("keeps the full Parent:Job text as the customer key", () => {
    const { documents } = groupDocuments([line({ customerName: "Acme Foods:Store 2" })]);
    expect(documents[0].customerKey).toBe("Acme Foods:Store 2");
  });
});

describe("groupDocuments (holds and reports)", () => {
  it("HOLDS a document with a defective line and reports the line's defect", () => {
    const bad = line({
      defects: [
        { code: "BAD_MONEY", column: "Item Price", message: "12.345 has more than 2 decimals" },
      ],
    });
    const { documents, issues } = groupDocuments([bad, line()]);
    expect(documents[0].held).toBe(true);
    expect(documents[0].holdCodes).toContain("BAD_MONEY");
    expect(issues.find((i) => i.code === "BAD_MONEY")).toMatchObject({
      severity: "ERROR",
      physicalLine: bad.physicalLine,
    });
  });

  it("reports a line with no invoice number and leaves it out of every document", () => {
    const orphan = line({ docNumber: "" });
    const { documents, issues } = groupDocuments([orphan, line({ docNumber: "5" })]);
    expect(documents.map((d) => d.docNumber)).toEqual(["5"]);
    expect(issues.find((i) => i.code === "BLANK_DOCUMENT_NUMBER")).toMatchObject({
      severity: "ERROR",
      physicalLine: orphan.physicalLine,
    });
  });

  it("HOLDS one number carrying two dates", () => {
    const { documents } = groupDocuments([
      line({ issueDate: "2025-01-01" }),
      line({ issueDate: "2025-02-02" }),
    ]);
    expect(documents[0].held).toBe(true);
    expect(documents[0].holdCodes).toContain("DOCUMENT_DATE_CONFLICT");
  });

  it("HOLDS a document with no usable date", () => {
    const { documents } = groupDocuments([line({ issueDate: null })]);
    expect(documents[0].held).toBe(true);
    expect(documents[0].holdCodes).toContain("MISSING_DATE");
  });
});

// T7, grouper side + sign-class key (SA-1295 A1 C6 Rule 3).
describe("groupDocuments (sign class, T7 kinds)", () => {
  it("an all-negative document is NEGATIVE_UNKNOWN, history only, keyed untyped-", () => {
    const { documents } = groupDocuments([
      line({ docNumber: "9", total: -5 }),
      line({ docNumber: "9", total: -7 }),
    ]);
    expect(documents[0]).toMatchObject({
      kind: "NEGATIVE_UNKNOWN",
      historyOnly: true,
      signClass: "untyped-",
      netTotal: -12,
      sourceKey: "untyped-:9",
    });
  });

  it("a positive document is an INVOICE keyed untyped+", () => {
    const { documents } = groupDocuments([line({ docNumber: "9", total: 5 })]);
    expect(documents[0]).toMatchObject({
      kind: "INVOICE",
      historyOnly: false,
      signClass: "untyped+",
      sourceKey: "untyped+:9",
    });
  });

  it("a mixed-sign document classes by its net", () => {
    const pos = groupDocuments([line({ total: 10 }), line({ total: -3 })]).documents[0];
    const neg = groupDocuments([line({ total: 3 }), line({ total: -10 })]).documents[0];
    expect([pos.signClass, pos.kind]).toEqual(["untyped+", "INVOICE"]);
    expect([neg.signClass, neg.kind]).toEqual(["untyped-", "NEGATIVE_UNKNOWN"]);
  });

  it("sums the document net from the file's totals only", () => {
    const { documents } = groupDocuments([
      line({ quantity: 3, unitPrice: 3.33, total: 10 }),
      line({ quantity: 2, unitPrice: 1, total: 2.01 }),
    ]);
    expect(documents[0].netTotal).toBe(12.01);
  });
});
