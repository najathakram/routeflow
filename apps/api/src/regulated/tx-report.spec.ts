import {
  buildTxReport,
  digitsOnly,
  pickReportAddress,
  TxCategoryConfig,
  TxCustomerAddress,
  TxCustomerInfo,
  TxInvoiceInfo,
} from "./tx-report";
import { serializeReportCsv } from "./report-csv";

const COMPLETE_CATEGORY: TxCategoryConfig = {
  id: "cat-tx",
  name: "Cigarettes",
  wholesalerLicenseNo: "12345678",
  txItemType: 1,
  txUom: "CP",
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
        { invoiceId: "inv-1", unitBasisQty: 10, netSales: 100 },
        { invoiceId: "inv-1", unitBasisQty: 10, netSales: 100 },
      ],
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
        { invoiceId: "inv-1", unitBasisQty: 30, netSales: 300 },
        { invoiceId: "inv-1", unitBasisQty: -6, netSales: -60 },
      ],
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
        { invoiceId: "inv-1", unitBasisQty: 10, netSales: 100 },
        { invoiceId: "inv-1", unitBasisQty: -10, netSales: -100 },
      ],
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
        { invoiceId: "inv-1", unitBasisQty: 10, netSales: 100 },
        { invoiceId: "inv-1", unitBasisQty: -15, netSales: -150 },
      ],
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
        ledgerRows: [{ invoiceId: "inv-1", unitBasisQty: 10, netSales: net }],
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
      ledgerRows: [{ invoiceId: "inv-1", unitBasisQty: 10.4, netSales: 100 }],
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
      ledgerRows: [{ invoiceId: "inv-1", unitBasisQty: 10, netSales: 100 }],
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
      ledgerRows: [{ invoiceId: "inv-1", unitBasisQty: 10, netSales: 100 }],
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
      ledgerRows: [{ invoiceId: "inv-1", unitBasisQty: 10, netSales: 100 }],
      invoicesById: new Map([["inv-1", invoice()]]),
      customersById: new Map([["cust-1", customer({ taxId: "3-20123456-78" })]]),
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(valid.rows[0][1]).toBe("32012345678");
    expect(valid.warnings.some((w) => w.code === "INVALID_TAXPAYER_ID")).toBe(false);

    const invalid = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [{ invoiceId: "inv-1", unitBasisQty: 10, netSales: 100 }],
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
      ledgerRows: [{ invoiceId: "inv-1", unitBasisQty: 10, netSales: 100 }],
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
      ledgerRows: [{ invoiceId: "inv-1", unitBasisQty: 10, netSales: 100 }],
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
      ledgerRows: [{ invoiceId: "inv-1", unitBasisQty: 10, netSales: 100 }],
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

  it("missing category config emits each MISSING_* warning exactly once, across multiple rows", () => {
    const bareCategory: TxCategoryConfig = {
      id: "cat-tx",
      name: "Cigarettes",
      wholesalerLicenseNo: null,
      txItemType: null,
      txUom: null,
    };
    const report = buildTxReport({
      category: bareCategory,
      ledgerRows: [
        { invoiceId: "inv-1", unitBasisQty: 10, netSales: 100 },
        { invoiceId: "inv-2", unitBasisQty: 5, netSales: 50 },
      ],
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
    expect(report.warnings.filter((w) => w.code === "MISSING_ITEM_TYPE").length).toBe(1);
    expect(report.warnings.filter((w) => w.code === "MISSING_UOM").length).toBe(1);
  });

  it("excludes null-invoiceId ledger rows and counts them in one UNLINKED_LEDGER_ROWS warning", () => {
    const report = buildTxReport({
      category: COMPLETE_CATEGORY,
      ledgerRows: [
        { invoiceId: "inv-1", unitBasisQty: 10, netSales: 100 },
        { invoiceId: null, unitBasisQty: 5, netSales: 50 },
        { invoiceId: null, unitBasisQty: 2, netSales: 20 },
      ],
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
        { invoiceId: "inv-b", unitBasisQty: 1, netSales: 200 },
        { invoiceId: "inv-a", unitBasisQty: 1, netSales: 100 },
        { invoiceId: "inv-c", unitBasisQty: 1, netSales: 300 },
      ],
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
      ledgerRows: [{ invoiceId: "inv-1", unitBasisQty: 10, netSales: 100 }],
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
