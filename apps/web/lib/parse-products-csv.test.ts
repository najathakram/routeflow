import { parseProductsCsv, splitCsv } from "./parse-products-csv";

/**
 * B205: the Migration Hub's products-CSV parser used a bare `line.split(",")`, so an Excel export's quoted "1,234.56"
 * became two cells and every later column shifted. These pin the quote-aware reader (RFC 4180).
 */
describe("splitCsv", () => {
  it("keeps a quoted thousands-comma price in ONE cell", () => {
    expect(splitCsv('name,price,unit\nCola,"1,234.56",each')).toEqual([
      ["name", "price", "unit"],
      ["Cola", "1,234.56", "each"],
    ]);
  });

  it("reads doubled quotes, CRLF, a quoted newline and a trailing blank line", () => {
    expect(splitCsv('a,b\r\n"say ""hi""","x\ny"\r\n\r\n')).toEqual([
      ["a", "b"],
      ['say "hi"', "x\ny"],
    ]);
  });

  it("drops a UTF-8 BOM on the header", () => {
    expect(splitCsv("\uFEFFname,sku\nCola,C1")[0]).toEqual(["name", "sku"]);
  });
});

describe("parseProductsCsv", () => {
  it("B205: a quoted price keeps its value and the unit/category stay in their own columns", () => {
    const rows = parseProductsCsv(
      'Name,SKU,Price,Unit,Category\nCola,C1,"1,234.56",case,Drinks\n"Chips, large",C2,3.5,each,Snacks',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].payload).toMatchObject({
      name: "Cola",
      sku: "C1",
      pricePerUnit: "1,234.56",
      unit: "case",
      category: "Drinks",
    });
    expect(rows[1].payload).toMatchObject({ name: "Chips, large", unit: "each", category: "Snacks" });
    expect(rows[0].externalId).toBe("C1");
  });

  it("accepts priceperunit as the price header, skips rows with no name, returns [] for a header-only file", () => {
    expect(parseProductsCsv("name,pricePerUnit\nCola,2\n,5")).toHaveLength(1);
    expect(parseProductsCsv("name,price")).toEqual([]);
  });
});
