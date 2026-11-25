import {
  SAMPLE_DESCRIPTION_HEADER,
  SAMPLE_HEADERS,
  buildSyntheticSalesFile,
  salesCsv,
} from "../testing/synthetic-sales-file";
import { createAdapterRegistry, defaultAdapterRegistry, defineAdapter } from "./adapter-registry";
import { SALES_LINES_SAMPLE_ADAPTER } from "./sales-lines-sample";
import { readSalesFile } from "./read-sales-file";

type Row = string[];
const row = (over: Partial<Record<number, string>> = {}): Row => {
  const base = ["1001", "ACME", "3/4/2025", "Acme Widget", "", "3", "3.33", "10.00", ""];
  return base.map((v, i) => over[i] ?? v);
};

describe("sample-signature adapter: registry", () => {
  it("recognises the sample header (trimmed, 0xA0 already stripped by the decoder)", () => {
    const r = defaultAdapterRegistry.resolve([...SAMPLE_HEADERS]);
    expect(r).toEqual({ ok: true, adapter: SALES_LINES_SAMPLE_ADAPTER });
  });

  it("accepts any spelling in the description slot but exact names everywhere else", () => {
    const h = [...SAMPLE_HEADERS];
    h[4] = "Item Description";
    expect(defaultAdapterRegistry.resolve(h).ok).toBe(true);
    const wrong = [...SAMPLE_HEADERS];
    wrong[6] = "Price";
    expect(defaultAdapterRegistry.resolve(wrong).ok).toBe(false);
    const reordered = [...SAMPLE_HEADERS].reverse();
    expect(defaultAdapterRegistry.resolve(reordered).ok).toBe(false);
  });

  it("refuses an unknown header with exactly one sentence", () => {
    const r = defaultAdapterRegistry.resolve(["Date", "Num", "Name", "Amount"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/\.$/);
      expect(r.message).not.toMatch(/\n/);
      expect(r.message.match(/\./g)).toHaveLength(1);
    }
  });

  it("states linksKnown = false for the sample shape (no payment links in the file)", () => {
    expect(SALES_LINES_SAMPLE_ADAPTER.linksKnown).toBe(false);
  });

  it("linksKnown is required: defineAdapter throws without it", () => {
    const noLinks = {
      key: "x",
      version: 1,
      fileKind: "SALES_LINES",
      matches: () => true,
      adaptRecord: () => ({ line: null }),
    } as unknown;
    expect(() => defineAdapter(noLinks as Parameters<typeof defineAdapter>[0])).toThrow(
      /linksKnown/,
    );
  });

  it("refuses a registry with a duplicate key", () => {
    expect(() =>
      createAdapterRegistry([SALES_LINES_SAMPLE_ADAPTER, SALES_LINES_SAMPLE_ADAPTER]),
    ).toThrow(/duplicate/i);
  });

  it("refuses an ambiguous header (two adapters match)", () => {
    const twin = defineAdapter({ ...SALES_LINES_SAMPLE_ADAPTER, key: "twin" });
    const reg = createAdapterRegistry([SALES_LINES_SAMPLE_ADAPTER, twin]);
    const r = reg.resolve([...SAMPLE_HEADERS]);
    expect(r.ok).toBe(false);
  });

  it("has no Type / Open Balance adapter yet", () => {
    const withType = [...SAMPLE_HEADERS, "Type", "Open Balance"];
    expect(defaultAdapterRegistry.resolve(withType).ok).toBe(false);
  });
});

// T4: the stored total is the file's Total, never qty x price.
describe("sample-signature adapter: money (T4)", () => {
  const adapt = (r: Row) =>
    SALES_LINES_SAMPLE_ADAPTER.adaptRecord({
      headers: [...SAMPLE_HEADERS],
      cells: r,
      recordNo: 2,
      physicalLine: 2,
    }).line;

  it("keeps the file Total when qty x price differs from it by 1 cent", () => {
    // 3 x 3.33 = 9.99, the file says 10.00
    const line = adapt(row());
    expect(line?.total).toBe(10);
    expect(line?.quantity).toBe(3);
    expect(line?.unitPrice).toBe(3.33);
  });

  it("does not rebuild a blank Total", () => {
    expect(adapt(row({ 7: "" }))?.total).toBeNull();
  });

  it("reads thousands commas and parentheses negatives", () => {
    const line = adapt(row({ 5: "1", 6: "1,234.50", 7: "(1,234.50)" }));
    expect(line?.unitPrice).toBe(1234.5);
    expect(line?.total).toBe(-1234.5);
  });

  it("leaves a blank quantity null, never 1", () => {
    expect(adapt(row({ 5: "" }))?.quantity).toBeNull();
  });

  it("records a refused money cell as a defect, never as a rounded or zero value", () => {
    const line = adapt(row({ 6: "12.345" }));
    expect(line?.unitPrice).toBeNull();
    expect(line?.defects).toEqual([
      expect.objectContaining({ code: "BAD_MONEY", column: "Item Price" }),
    ]);
  });

  it("converts M/D/YYYY to an ISO date and defects an impossible one", () => {
    expect(adapt(row({ 2: "3/4/2025" }))?.issueDate).toBe("2025-03-04");
    expect(adapt(row({ 2: "12/31/2024" }))?.issueDate).toBe("2024-12-31");
    const bad = adapt(row({ 2: "2/30/2025" }));
    expect(bad?.issueDate).toBeNull();
    expect(bad?.defects[0]).toMatchObject({ code: "BAD_DATE" });
  });

  it("keeps the description verbatim, including line breaks", () => {
    expect(adapt(row({ 4: "line one\nline two" }))?.description).toBe("line one\nline two");
  });

  it("carries the physical line and record number for every issue row", () => {
    const line = adapt(row());
    expect(line).toMatchObject({ recordNo: 2, physicalLine: 2 });
  });
});

// T7, adapter half: an all-negative document that matches nothing is history only.
describe("readSalesFile (T7 adapter half, end to end)", () => {
  it("stages an all-negative document as NEGATIVE_UNKNOWN, history only, never a credit", async () => {
    const bytes = salesCsv(
      [
        ["2001", "ACME", "1/5/2025", "Acme Widget", "", "2", "5.00", "10.00", ""],
        ["2002", "ACME", "1/6/2025", "Acme Widget", "", "-1", "5.00", "-5.00", ""],
        ["2002", "ACME", "1/6/2025", "", "Discount", "", "", "-2.00", ""],
      ],
      { lead: [0xa0] },
    );
    const out = await readSalesFile(bytes);
    const byNumber = Object.fromEntries(out.documents.map((d) => [d.docNumber, d]));
    expect(byNumber["2001"]).toMatchObject({ kind: "INVOICE", historyOnly: false });
    expect(byNumber["2002"]).toMatchObject({
      kind: "NEGATIVE_UNKNOWN",
      historyOnly: true,
      netTotal: -7,
      sourceKey: "untyped-:2002",
    });
    expect(out.documents.some((d) => d.kind === ("CREDIT_MEMO" as string))).toBe(false);
    expect(out.adapterKey).toBe(SALES_LINES_SAMPLE_ADAPTER.key);
    expect(out.linksKnown).toBe(false);
  });

  it("refuses an unknown header file before reading any row", async () => {
    const bytes = salesCsv([["a", "b"]], { headers: ["Foo", "Bar"] });
    await expect(readSalesFile(bytes)).rejects.toMatchObject({ code: "UNKNOWN_SHAPE" });
  });

  it("reads the synthetic twin into 50 documents with the stray byte reported once", async () => {
    const twin = buildSyntheticSalesFile({ withShortRow: false });
    const out = await readSalesFile(twin.bytes);
    expect(out.documents).toHaveLength(twin.documentCount);
    expect(out.documents).toHaveLength(50);
    expect(out.documents.reduce((n, d) => n + d.lines.length, 0)).toBe(170);
    expect(out.issues.filter((i) => i.code === "LEADING_BYTE_STRIPPED")).toHaveLength(1);
    expect(SAMPLE_DESCRIPTION_HEADER).toBe(SAMPLE_HEADERS[4]);
  });

  it("surfaces a short row as an issue and keeps the other rows", async () => {
    const twin = buildSyntheticSalesFile({ withShortRow: true });
    const out = await readSalesFile(twin.bytes);
    expect(out.issues.filter((i) => i.code === "ROW_SHORT")).toHaveLength(1);
    expect(out.documents.reduce((n, d) => n + d.lines.length, 0)).toBe(169);
  });
});
