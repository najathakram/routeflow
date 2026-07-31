import {
  buildTxReport,
  digitsOnly,
  pickReportAddress,
  TxCategoryConfig,
  TxCustomerAddress,
  TxCustomerInfo,
  TxInvoiceInfo,
  TxLineInfo,
  TxProductConfig,
} from "./tx-report";
import { serializeReportCsv } from "./report-csv";

const COMPLETE_CATEGORY: TxCategoryConfig = {
  id: "cat-tx",
  name: "Cigarettes",
  wholesalerLicenseNo: "12345678",
};

const ADDR: TxCustomerAddress = {
  line1: "1 Main St",
  line2: null,
  city: "Austin",
  state: "TX",
  zip: "78701",
  isDefault: true,
  addressType: "BILLING",
};

function customer(over: Partial<TxCustomerInfo> = {}): TxCustomerInfo {
  return {
    id: "cust-1",
    businessName: "Acme Retail",
    taxId: "12345678901",
    tobaccoLicenseNo: null,
    authLicenseNumber: "87654321",
    addresses: [ADDR],
    ...over,
  };
}

function invoice(over: Partial<TxInvoiceInfo> = {}): TxInvoiceInfo {
  return {
    id: "inv-1",
    invoiceNumber: "INV-1",
    issueDate: new Date("2026-07-05T00:00:00.000Z"),
    customerId: "cust-1",
    ...over,
  };
}

/** A fully-configured, non-boxed default line/product pair (item type "1"/CP). */
function line(over: Partial<TxLineInfo> = {}): TxLineInfo {
  return {
    id: "line-1",
    productId: "prod-1",
    qty: 10,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    ...over,
  };
}

function productCfg(over: Partial<TxProductConfig> = {}): TxProductConfig {
  return {
    id: "prod-1",
    name: "Marlboro Red",
    unitsPerBox: null,
    regItemType: "1",
    regUomCase: null,
    regUomUnit: "CP",
    ...over,
  };
}

const DEFAULT_LINES_BY_ID = new Map<string, TxLineInfo>([["line-1", line()]]);
const DEFAULT_PRODUCTS_BY_ID = new Map<string, TxProductConfig>([["prod-1", productCfg()]]);

describe("digitsOnly", () => {
  it("strips non-digit characters", () => {
    expect(digitsOnly("3-20123456-78")).toBe("32012345678");
    expect(digitsOnly("78701-1234")).toBe("787011234");
    expect(digitsOnly(null)).toBe("");
    expect(digitsOnly(undefined)).toBe("");
  });
});

describe("pickReportAddress", () => {
  const billing = { ...ADDR, addressType: "BILLING", isDefault: false };
  const defaultBilling = { ...ADDR, addressType: "BILLING", isDefault: true };
  const shipping = { ...ADDR, addressType: "SHIPPING", isDefault: false };
  const defaultShipping = { ...ADDR, addressType: "SHIPPING", isDefault: true };

  it("prefers default+BILLING", () => {
    expect(pickReportAddress([shipping, billing, defaultBilling])).toBe(defaultBilling);
  });
  it("falls back to any BILLING when no default+BILLING", () => {
    expect(pickReportAddress([shipping, billing])).toBe(billing);
  });
  it("falls back to any default when no BILLING at all", () => {
    expect(pickReportAddress([shipping, defaultShipping])).toBe(defaultShipping);
  });
  it("falls back to the first address when nothing matches", () => {
    expect(pickReportAddress([shipping])).toBe(shipping);
  });
  it("returns null for an empty list", () => {
    expect(pickReportAddress([])).toBeNull();
  });
});

describe("buildTxReport", () => {
  it("collapses two ledger rows on one invoice into one report row", () => {
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: 100 },
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: 100 },
      ],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(1);
    expect(report.rows[0][10]).toBe("20"); // quantity
    expect(report.rows[0][11]).toBe("200"); // invoice amount
  });

  it("nets a SALE + partial REVERSAL (300 − 60 → 240)", () => {
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 30, netSales: 300 },
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: -6, netSales: -60 },
      ],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(1);
    expect(report.rows[0][11]).toBe("240");
  });

  it("drops a fully reversed invoice", () => {
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: 100 },
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: -10, netSales: -100 },
      ],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(0);
  });

  it("still emits a negative-net invoice, with a NEGATIVE_NET_INVOICE warning", () => {
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: 100 },
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: -15, netSales: -150 },
      ],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(1);
    expect(report.rows[0][11]).toBe("-50");
    expect(
      report.warnings.some((w) => w.code === "NEGATIVE_NET_INVOICE" && w.invoiceId === "inv-1"),
    ).toBe(true);
  });

  it("rounds invoice amount half-up to the nearest dollar (1873.49 -> 1873, 1873.50 -> 1874)", () => {
    const build = (net: number) =>
      buildTxReport({
        category: COMPLETE_CATEGORY,
        ledgerRows: [
          { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: net },
        ],
        linesById: DEFAULT_LINES_BY_ID,
        productsById: DEFAULT_PRODUCTS_BY_ID,
        invoicesById: new Map([["inv-1", invoice()]]),
        customersById: new Map([["cust-1", customer()]]),
        from: "2026-07-01",
        to: "2026-07-31",
      });
    expect(build(1873.49).rows[0][11]).toBe("1873");
    expect(build(1873.5).rows[0][11]).toBe("1874");
  });

  it("rounds a fractional quantity and raises FRACTIONAL_QTY", () => {
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10.4, netSales: 100 },
      ],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows[0][10]).toBe("10");
    expect(
      report.warnings.some((w) => w.code === "FRACTIONAL_QTY" && w.invoiceId === "inv-1"),
    ).toBe(true);
  });

  it("truncates a 60-char business name to 50 and a 35-char city to 30", () => {
    const longName = "A".repeat(60);
    const longCity = "B".repeat(35);
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: 100 },
      ],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([
        ["cust-1", customer({ businessName: longName, addresses: [{ ...ADDR, city: longCity }] })],
      ]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows[0][2]).toBe("A".repeat(50));
    expect(report.rows[0][2].length).toBe(50);
    expect(report.rows[0][4]).toBe("B".repeat(30));
    expect(report.rows[0][4].length).toBe(30);
  });

  it("normalizes state to uppercase 2-char and zip to the first 5 digits", () => {
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: 100 },
      ],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([
        ["cust-1", customer({ addresses: [{ ...ADDR, state: "tx", zip: "78701-1234" }] })],
      ]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows[0][5]).toBe("TX");
    expect(report.rows[0][6]).toBe("78701");
  });

  it("writes a valid 11-digit taxpayer ID as-stored with no warning; a 9-digit ID warns INVALID_TAXPAYER_ID and is still written", () => {
    const valid = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: 100 },
      ],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer({ taxId: "3-20123456-78" })]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(valid.rows[0][1]).toBe("32012345678");
    expect(valid.warnings.some((w) => w.code === "INVALID_TAXPAYER_ID")).toBe(false);

    const invalid = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: 100 },
      ],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer({ taxId: "123456789" })]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(invalid.rows[0][1]).toBe("123456789"); // still written as stored, not padded
    expect(invalid.warnings.some((w) => w.code === "INVALID_TAXPAYER_ID")).toBe(true);
  });

  it("retailer-license fallback chain: this category's authorization first, else the customer's tobacco license", () => {
    const withAuth = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: 100 },
      ],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([
        ["cust-1", customer({ authLicenseNumber: "11112222", tobaccoLicenseNo: "99998888" })],
      ]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(withAuth.rows[0][7]).toBe("11112222");

    const fallback = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: 100 },
      ],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([
        ["cust-1", customer({ authLicenseNumber: null, tobaccoLicenseNo: "99998888" })],
      ]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(fallback.rows[0][7]).toBe("99998888");

    const missing = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: 100 },
      ],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([
        ["cust-1", customer({ authLicenseNumber: null, tobaccoLicenseNo: null })],
      ]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(missing.rows[0][7]).toBe("");
    expect(missing.warnings.some((w) => w.code === "MISSING_RETAILER_LICENSE")).toBe(true);
  });

  it("missing wholesaler license emits MISSING_WHOLESALER_LICENSE exactly once, across multiple invoices", () => {
    const bareCategory: TxCategoryConfig = {
      id: "cat-tx",
      name: "Cigarettes",
      wholesalerLicenseNo: null,
    };
    const report = buildTxReport({
      category: bareCategory,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: 100 },
        { invoiceId: "inv-2", invoiceItemId: "line-1", unitBasisQty: 5, netSales: 50 },
      ],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([
        ["inv-1", invoice()],
        ["inv-2", invoice({ id: "inv-2", invoiceNumber: "INV-2", customerId: "cust-2" })],
      ]),
      customersById: new Map([
        ["cust-1", customer()],
        ["cust-2", customer({ id: "cust-2", businessName: "Beta Mart" })],
      ]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(2);
    expect(report.warnings.filter((w) => w.code === "MISSING_WHOLESALER_LICENSE").length).toBe(1);
  });

  it("excludes null-invoiceId ledger rows and counts them in one UNLINKED_LEDGER_ROWS warning", () => {
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: 100 },
        { invoiceId: null, invoiceItemId: null, unitBasisQty: 5, netSales: 50 },
        { invoiceId: null, invoiceItemId: null, unitBasisQty: 2, netSales: 20 },
      ],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(1);
    const w = report.warnings.find((x) => x.code === "UNLINKED_LEDGER_ROWS");
    expect(w?.message).toContain("2");
  });

  it("sorts rows by invoice issue date, then invoice number", () => {
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-b", invoiceItemId: "line-1", unitBasisQty: 1, netSales: 200 },
        { invoiceId: "inv-a", invoiceItemId: "line-1", unitBasisQty: 1, netSales: 100 },
        { invoiceId: "inv-c", invoiceItemId: "line-1", unitBasisQty: 1, netSales: 300 },
      ],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([
        [
          "inv-b",
          invoice({ id: "inv-b", invoiceNumber: "INV-2", issueDate: new Date("2026-07-05") }),
        ],
        [
          "inv-a",
          invoice({ id: "inv-a", invoiceNumber: "INV-1", issueDate: new Date("2026-07-05") }),
        ],
        [
          "inv-c",
          invoice({ id: "inv-c", invoiceNumber: "INV-3", issueDate: new Date("2026-07-01") }),
        ],
      ]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    // inv-c (earlier date) first, then inv-a before inv-b (same date, number order).
    expect(report.rows.map((r) => r[11])).toEqual(["300", "100", "200"]);
  });

  // ─── CSV shape ────────────────────────────────────────────────────────────
  it("serializes with no header line, quotes a comma-containing name, and carries no totals/disclosure", () => {
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: 100 },
      ],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer({ businessName: "Acme Retail, Inc." })]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    const csv = serializeReportCsv(report);
    expect(csv).not.toContain("Wholesaler Permit #");
    expect(csv).not.toContain("TOTALS");
    expect(csv).not.toContain("Note,");
    expect(csv).toContain('"Acme Retail, Inc."');
    const lines = csv.split("\n").filter(Boolean);
    expect(lines.length).toBe(1); // exactly one data row, no header/totals/footer
  });
});

describe("buildTxReport — per-product case/unit bucketing", () => {
  it(
    "back-compat identity: with every product's regUomCase null, a split/legacy/non-boxed mix " +
      "still nets to ONE row per invoice with the raw summed unitBasisQty (no unitsPerBox multiplication)",
    () => {
      const productSplit = productCfg({ id: "p-split", regUomCase: null, unitsPerBox: 12 });
      const productLegacy = productCfg({ id: "p-legacy", regUomCase: null, unitsPerBox: 12 });
      const productNonBoxed = productCfg({ id: "p-nonboxed", regUomCase: null, unitsPerBox: null });

      const lineSplit = line({
        id: "line-split",
        productId: "p-split",
        qty: 27,
        boxes: 2,
        pieces: 3,
        unitsPerBox: 12,
      });
      const lineLegacy = line({
        id: "line-legacy",
        productId: "p-legacy",
        qty: 4,
        boxes: null,
        pieces: null,
        unitsPerBox: 12,
      });
      const lineNonBoxed = line({
        id: "line-nonboxed",
        productId: "p-nonboxed",
        qty: 3,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
      });

      const report = buildTxReport({
        category: COMPLETE_CATEGORY,
        ledgerRows: [
          { invoiceId: "inv-1", invoiceItemId: "line-split", unitBasisQty: 27, netSales: 270 },
          { invoiceId: "inv-1", invoiceItemId: "line-legacy", unitBasisQty: 4, netSales: 40 },
          { invoiceId: "inv-1", invoiceItemId: "line-nonboxed", unitBasisQty: 3, netSales: 30 },
        ],
        linesById: new Map([
          ["line-split", lineSplit],
          ["line-legacy", lineLegacy],
          ["line-nonboxed", lineNonBoxed],
        ]),
        productsById: new Map([
          ["p-split", productSplit],
          ["p-legacy", productLegacy],
          ["p-nonboxed", productNonBoxed],
        ]),
        invoicesById: new Map([["inv-1", invoice()]]),
        customersById: new Map([["cust-1", customer()]]),
        from: "2026-07-01",
        to: "2026-07-31",
      });

      expect(report.rows.length).toBe(1);
      expect(report.rows[0][10]).toBe("34"); // 27 + 4 + 3, NOT 27 + 48 + 3
      expect(report.rows[0][11]).toBe("340");
    },
  );

  it("splits a case-configured product's boxed sale into a CC bucket and a CP bucket whose nets sum to the line's net", () => {
    const product = productCfg({ regUomCase: "CC", regUomUnit: "CP", unitsPerBox: 12 });
    const ln = line({ qty: 27, boxes: 2, pieces: 3, unitsPerBox: 12 });
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 27, netSales: 270 },
      ],
      linesById: new Map([["line-1", ln]]),
      productsById: new Map([["prod-1", product]]),
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(2);
    const caseRow = report.rows.find((r) => r[9] === "CC");
    const unitRow = report.rows.find((r) => r[9] === "CP");
    expect(caseRow?.[10]).toBe("2");
    expect(caseRow?.[11]).toBe("240");
    expect(unitRow?.[10]).toBe("3");
    expect(unitRow?.[11]).toBe("30");
    expect(Number(caseRow?.[11]) + Number(unitRow?.[11])).toBe(270);
  });

  it("a split line with 0 boxes emits only the unit bucket", () => {
    const product = productCfg({ regUomCase: "CC", regUomUnit: "CP", unitsPerBox: 12 });
    const ln = line({ qty: 5, boxes: 0, pieces: 5, unitsPerBox: 12 });
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [{ invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 5, netSales: 50 }],
      linesById: new Map([["line-1", ln]]),
      productsById: new Map([["prod-1", product]]),
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(1);
    expect(report.rows[0][9]).toBe("CP");
    expect(report.rows[0][10]).toBe("5");
    expect(report.rows[0][11]).toBe("50");
  });

  it("a legacy no-split boxed line with regUomCase set reports the stored CASES quantity, not qty*unitsPerBox", () => {
    const product = productCfg({ regUomCase: "CC", regUomUnit: "CP", unitsPerBox: 12 });
    const ln = line({ qty: 4, boxes: null, pieces: null, unitsPerBox: 12 });
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [{ invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 4, netSales: 40 }],
      linesById: new Map([["line-1", ln]]),
      productsById: new Map([["prod-1", product]]),
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(1);
    expect(report.rows[0][9]).toBe("CC");
    expect(report.rows[0][10]).toBe("4"); // NOT 48
  });

  it("the same legacy boxed line with regUomCase null reports under the unit UoM instead", () => {
    const product = productCfg({ regUomCase: null, regUomUnit: "CP", unitsPerBox: 12 });
    const ln = line({ qty: 4, boxes: null, pieces: null, unitsPerBox: 12 });
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [{ invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 4, netSales: 40 }],
      linesById: new Map([["line-1", ln]]),
      productsById: new Map([["prod-1", product]]),
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(1);
    expect(report.rows[0][9]).toBe("CP");
    expect(report.rows[0][10]).toBe("4");
  });

  it("a non-boxed product reports entirely under the unit UoM even when regUomCase is configured", () => {
    const product = productCfg({ regUomCase: "CC", regUomUnit: "CP", unitsPerBox: null });
    const ln = line({ qty: 10, boxes: null, pieces: null, unitsPerBox: null });
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 10, netSales: 100 },
      ],
      linesById: new Map([["line-1", ln]]),
      productsById: new Map([["prod-1", product]]),
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(1);
    expect(report.rows[0][9]).toBe("CP");
    expect(report.rows[0][10]).toBe("10");
  });

  it("a full reversal of a case-split line nets both buckets to zero and emits no rows", () => {
    const product = productCfg({ regUomCase: "CC", regUomUnit: "CP", unitsPerBox: 12 });
    const ln = line({ qty: 27, boxes: 2, pieces: 3, unitsPerBox: 12 });
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: 27, netSales: 270 },
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: -27, netSales: -270 },
      ],
      linesById: new Map([["line-1", ln]]),
      productsById: new Map([["prod-1", product]]),
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(0);
  });

  it("a partial return (factor -3/27) leaves fractional bucket sums and raises FRACTIONAL_QTY per bucket", () => {
    const product = productCfg({ regUomCase: "CC", regUomUnit: "CP", unitsPerBox: 12 });
    const ln = line({ qty: 27, boxes: 2, pieces: 3, unitsPerBox: 12 });
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: -3, netSales: -30 },
      ],
      linesById: new Map([["line-1", ln]]),
      productsById: new Map([["prod-1", product]]),
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(2);
    const caseRow = report.rows.find((r) => r[9] === "CC");
    const unitRow = report.rows.find((r) => r[9] === "CP");
    expect(caseRow?.[10]).toBe("0");
    expect(caseRow?.[11]).toBe("-27");
    expect(unitRow?.[10]).toBe("0");
    expect(unitRow?.[11]).toBe("-3");
    expect(report.warnings.filter((w) => w.code === "FRACTIONAL_QTY").length).toBe(2);
  });

  it("a reversal whose SALE is outside the report range still nets to a negative bucket and raises NEGATIVE_NET_INVOICE once", () => {
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-1", unitBasisQty: -10, netSales: -100 },
      ],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(1);
    expect(report.rows[0][11]).toBe("-100");
    expect(
      report.warnings.filter((w) => w.code === "NEGATIVE_NET_INVOICE" && w.invoiceId === "inv-1")
        .length,
    ).toBe(1);
  });

  it("a dangling invoiceItemId (missing from linesById) still contributes its full quantity via raw passthrough and raises one UNMATCHED_LEDGER_LINE warning", () => {
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-ghost", unitBasisQty: 7, netSales: 70 },
      ],
      linesById: DEFAULT_LINES_BY_ID, // "line-ghost" is not in this map
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(1);
    expect(report.rows[0][10]).toBe("7");
    expect(report.rows[0][11]).toBe("70");
    const w = report.warnings.find((x) => x.code === "UNMATCHED_LEDGER_LINE");
    expect(w?.message).toContain("1");
  });

  it("invoiceItemId null (but invoiceId set) passes the quantity through raw with no crash and no UNMATCHED_LEDGER_LINE warning", () => {
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [{ invoiceId: "inv-1", invoiceItemId: null, unitBasisQty: 5, netSales: 50 }],
      linesById: DEFAULT_LINES_BY_ID,
      productsById: DEFAULT_PRODUCTS_BY_ID,
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(1);
    expect(report.rows[0][10]).toBe("5");
    expect(report.rows[0][11]).toBe("50");
    expect(report.warnings.some((w) => w.code === "UNMATCHED_LEDGER_LINE")).toBe(false);
  });

  it("a line with productId null reports empty Item Type/UoM cells, the full quantity, and one UNLISTED_PRODUCT_LINE warning", () => {
    const ln = line({
      id: "line-noprod",
      productId: null,
      qty: 8,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
    });
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-noprod", unitBasisQty: 8, netSales: 80 },
      ],
      linesById: new Map([["line-noprod", ln]]),
      productsById: new Map(),
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(1);
    expect(report.rows[0][8]).toBe(""); // Item Type
    expect(report.rows[0][9]).toBe(""); // UoM
    expect(report.rows[0][10]).toBe("8");
    const w = report.warnings.find((x) => x.code === "UNLISTED_PRODUCT_LINE");
    expect(w?.invoiceId).toBe("inv-1");
  });

  it("a product missing regItemType/regUomUnit reports empty cells and emits each warning exactly once, even across many invoices", () => {
    const bareProduct = productCfg({
      id: "prod-bare",
      name: "Bare Co",
      regItemType: null,
      regUomUnit: null,
      regUomCase: null,
    });
    const lineA = line({ id: "line-bare-1", productId: "prod-bare", qty: 5 });
    const lineB = line({ id: "line-bare-2", productId: "prod-bare", qty: 6 });
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-bare-1", unitBasisQty: 5, netSales: 50 },
        { invoiceId: "inv-2", invoiceItemId: "line-bare-2", unitBasisQty: 6, netSales: 60 },
      ],
      linesById: new Map([
        ["line-bare-1", lineA],
        ["line-bare-2", lineB],
      ]),
      productsById: new Map([["prod-bare", bareProduct]]),
      invoicesById: new Map([
        ["inv-1", invoice()],
        ["inv-2", invoice({ id: "inv-2", invoiceNumber: "INV-2", customerId: "cust-2" })],
      ]),
      customersById: new Map([
        ["cust-1", customer()],
        ["cust-2", customer({ id: "cust-2", businessName: "Beta Mart" })],
      ]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(2);
    expect(report.rows[0][8]).toBe("");
    expect(report.rows[0][9]).toBe("");
    expect(report.warnings.filter((w) => w.code === "MISSING_ITEM_TYPE").length).toBe(1);
    expect(report.warnings.filter((w) => w.code === "MISSING_UOM").length).toBe(1);
  });

  it("two products with different configs on one invoice emit two rows sharing that invoice's customer data, with per-invoice warnings raised once", () => {
    const productX = productCfg({ id: "prod-x", regItemType: "1", regUomUnit: "CP" });
    const productY = productCfg({ id: "prod-y", regItemType: "2", regUomUnit: "SB" });
    const lineX = line({ id: "line-x", productId: "prod-x", qty: 10 });
    const lineY = line({ id: "line-y", productId: "prod-y", qty: 6 });
    const noAddressCustomer = customer({ addresses: [] });
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-x", unitBasisQty: 10, netSales: 100 },
        { invoiceId: "inv-1", invoiceItemId: "line-y", unitBasisQty: 6, netSales: 60 },
      ],
      linesById: new Map([
        ["line-x", lineX],
        ["line-y", lineY],
      ]),
      productsById: new Map([
        ["prod-x", productX],
        ["prod-y", productY],
      ]),
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", noAddressCustomer]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(report.rows.length).toBe(2);
    expect(report.rows.every((r) => r[2] === "Acme Retail")).toBe(true);
    expect(report.warnings.filter((w) => w.code === "MISSING_ADDRESS").length).toBe(1);
  });

  it("includeOptionalColumns: ['itemDescription'] adds an Item Description column and splits rows per product", () => {
    const productOne = productCfg({
      id: "p1",
      name: "Product One",
      regItemType: "1",
      regUomUnit: "CP",
    });
    const productTwo = productCfg({
      id: "p2",
      name: "Product Two",
      regItemType: "1",
      regUomUnit: "CP",
    });
    const lineOne = line({ id: "line-p1", productId: "p1", qty: 9 });
    const lineTwo = line({ id: "line-p2", productId: "p2", qty: 4 });
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", invoiceItemId: "line-p1", unitBasisQty: 9, netSales: 90 },
        { invoiceId: "inv-1", invoiceItemId: "line-p2", unitBasisQty: 4, netSales: 40 },
      ],
      linesById: new Map([
        ["line-p1", lineOne],
        ["line-p2", lineTwo],
      ]),
      productsById: new Map([
        ["p1", productOne],
        ["p2", productTwo],
      ]),
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer()]]),
      from: "2026-07-01",
      to: "2026-07-31",
      includeOptionalColumns: ["itemDescription"],
    });
    expect(report.columns.length).toBe(13);
    expect(report.columns[12]).toEqual({ key: "itemDescription", label: "Item Description" });
    expect(report.rows.length).toBe(2);
    expect(report.rows[0][12]).toBe("Product One");
    expect(report.rows[1][12]).toBe("Product Two");
  });
});
