/**
 * SA-1078 (W-1096) PR-3 rows PD1–PD5. Jest cannot load react-pdf or the `.tsx` templates (they are stubbed in
 * package.json's moduleNameMapper), so: PD1 and PD3 are proven on the pure model that holds every word and figure the
 * page prints; PD4 pins the template's layout rules from its source; PD2 and PD5 go through the service with storage and
 * the read mocked at the boundary. A real render (letterhead, logo failure, 150 rows) is proven outside Jest on the built
 * output — see the PR body.
 */
import { readFileSync } from "fs";
import { join } from "path";
import type { AccountStatement, AccountStatementInvoice } from "@routeflow/types";

let mockRendered: any[] = [];
jest.mock("@react-pdf/renderer", () => ({
  renderToBuffer: jest.fn(async (element: any) => {
    mockRendered.push(element);
    return Buffer.from("%PDF-test");
  }),
}));
const mockBuild = jest.fn();
jest.mock("./account-statement", () => ({
  ...jest.requireActual("./account-statement"),
  buildAccountStatement: (...args: unknown[]) => mockBuild(...args),
}));

import { StatementPdfService } from "../buyer/statement-pdf.service";
import { buildAccountStatementPdfModel, methodWords } from "./account-statement-pdf-model";
import { createMockPrisma } from "../testing/prisma-mock";

const invoice = (
  n: number,
  over: Partial<AccountStatementInvoice> = {},
): AccountStatementInvoice => ({
  id: `inv-${n}`,
  invoiceNumber: `INV-${1000 + n}`,
  issueDate: "2026-09-01T00:00:00.000Z",
  dueDate: "2026-09-15T00:00:00.000Z",
  total: 100.5,
  paid: 20.25,
  credit: 0,
  unpaid: 80.25,
  daysLate: 12,
  ...over,
});

const statement = (over: Partial<AccountStatement> = {}): AccountStatement => ({
  asOf: "2026-10-31",
  customer: { id: "c1", businessName: "Buyer Co" },
  openBalance: 160.5,
  overdue: 80.25,
  creditAvailable: 30,
  afterCredit: 130.5,
  waitingToClear: 15,
  openInvoices: [invoice(1), invoice(2, { daysLate: 0, dueDate: null })],
  recentPayments: [
    {
      date: "2026-10-20T15:00:00.000Z",
      kind: "PAYMENT",
      method: "CHECK",
      reference: "1042",
      invoiceNumber: "INV-1001",
      amount: 50,
    },
    {
      date: "2026-10-18T15:00:00.000Z",
      kind: "CREDIT",
      method: "CREDIT_NOTE",
      reference: null,
      invoiceNumber: "INV-1002",
      amount: 10,
    },
  ],
  recentPaymentsTruncated: false,
  credits: [
    {
      kind: "CREDIT_NOTE",
      id: "cn1",
      number: "CN-7",
      date: "2026-10-01T00:00:00.000Z",
      reason: "Damaged goods",
      remaining: 30,
      expiresAt: null,
    },
  ],
  ...over,
});

/** Every string the page prints, in order. */
const allText = (s: AccountStatement): string => {
  const m = buildAccountStatementPdfModel(s);
  return [
    m.title,
    m.asOfLabel,
    m.customerName,
    ...m.summary.flatMap((l) => [l.label, l.value]),
    ...m.invoices.flatMap((r) => [
      r.invoice,
      r.due,
      r.late ?? "",
      r.total,
      r.paid,
      r.credit,
      r.unpaid,
    ]),
    ...m.payments.flatMap((p) => [p.date, p.what, p.amount]),
    m.paymentsNote ?? "",
    ...m.credits.flatMap((c) => [c.date, c.what, c.amount]),
    m.foot.label,
    m.foot.value,
  ].join(" | ");
};

describe("PD1: every figure on the page is the read's, to the cent", () => {
  it("carries the open balance, overdue, credit, after credit, waiting, each row and the foot", () => {
    const m = buildAccountStatementPdfModel(statement());
    expect(m.summary).toEqual([
      { label: "Open balance", value: "$160.50", tone: "danger" },
      { label: "Overdue", value: "$80.25", tone: "danger" },
      { label: "Credit available", value: "$30.00", tone: "success" },
      { label: "After credit", value: "$130.50", tone: "plain" },
      { label: "Waiting to clear", value: "$15.00", tone: "plain" },
    ]);
    expect(m.asOfLabel).toBe("As of Oct 31, 2026");
    expect(m.invoices[0]).toMatchObject({
      invoice: "INV-1001",
      due: "Sep 15, 2026",
      late: "12 days late",
      total: "$100.50",
      paid: "$20.25",
      unpaid: "$80.25",
    });
    expect(m.invoices[1]).toMatchObject({ due: "—", late: null });
    expect(m.foot).toEqual({ label: "Open balance", value: "$160.50" });
  });

  it("prints the rows' unpaid column and the foot from the same numbers the read gave", () => {
    const s = statement();
    const m = buildAccountStatementPdfModel(s);
    expect(m.invoices.map((r) => r.unpaid)).toEqual(
      s.openInvoices.map((i) => `$${i.unpaid.toFixed(2)}`),
    );
    expect(m.foot.value).toBe(`$${s.openBalance.toFixed(2)}`);
  });

  it("says '1 day late' in the singular", () => {
    const m = buildAccountStatementPdfModel(
      statement({ openInvoices: [invoice(1, { daysLate: 1 })] }),
    );
    expect(m.invoices[0].late).toBe("1 day late");
  });

  it("leaves out Overdue, Credit, After credit and Waiting when there is none", () => {
    const m = buildAccountStatementPdfModel(
      statement({
        overdue: 0,
        creditAvailable: 0,
        afterCredit: 160.5,
        waitingToClear: 0,
        credits: [],
      }),
    );
    expect(m.summary.map((l) => l.label)).toEqual(["Open balance"]);
    expect(m.credits).toEqual([]);
  });

  it("drops the Credit column when no row has credit applied, and keeps it when one does", () => {
    expect(buildAccountStatementPdfModel(statement()).showCreditColumn).toBe(false);
    const withCredit = buildAccountStatementPdfModel(
      statement({ openInvoices: [invoice(1, { credit: 5, unpaid: 75.25 })] }),
    );
    expect(withCredit.showCreditColumn).toBe(true);
    expect(withCredit.invoices[0].credit).toBe("$5.00");
  });

  it("at $0 owed: no open rows, a green zero, and the credit and recent payments still print", () => {
    const m = buildAccountStatementPdfModel(
      statement({ openBalance: 0, overdue: 0, afterCredit: 0, openInvoices: [] }),
    );
    expect(m.invoices).toEqual([]);
    expect(m.summary[0]).toEqual({ label: "Open balance", value: "$0.00", tone: "success" });
    expect(m.payments).toHaveLength(2);
    expect(m.credits).toHaveLength(1);
  });

  it("notes when the payments list was cut", () => {
    const m = buildAccountStatementPdfModel(statement({ recentPaymentsTruncated: true }));
    expect(m.paymentsNote).toBe("The latest 2 payments are shown.");
    expect(buildAccountStatementPdfModel(statement()).paymentsNote).toBeNull();
  });
});

describe("PD3: nothing internal reaches the page", () => {
  it("prints methods as words, with no stored code, draft or To collect text", () => {
    const withTag = statement({
      openInvoices: [invoice(1, { toCollect: { kind: "COLLECT" } as any })],
    });
    const text = allText(withTag);
    expect(text).toContain("Check · 1042 · Invoice INV-1001");
    expect(text).toContain("Credit note · Invoice INV-1002");
    expect(text).not.toMatch(/CREDIT_NOTE|CHECK|ADVANCE|CREDIT_CARD|DRAFT/);
    expect(text).not.toMatch(/to collect/i);
  });

  it("never prints an unknown future method's code", () => {
    expect(methodWords("SOMETHING_NEW")).toBe("Payment");
    expect(methodWords("ACH")).toBe("Bank transfer");
    expect(methodWords("ZELLE")).toBe("Zelle");
  });
});

describe("PD4: a long statement wraps and the foot stays whole at the end", () => {
  const source = readFileSync(join(__dirname, "account-statement-pdf-template.tsx"), "utf8");

  it("the model keeps all 150 rows (nothing is capped for print)", () => {
    const rows = Array.from({ length: 150 }, (_, i) => invoice(i));
    expect(buildAccountStatementPdfModel(statement({ openInvoices: rows })).invoices).toHaveLength(
      150,
    );
  });

  it("every row and the foot are unbreakable blocks, and the foot is the last block before the page footer", () => {
    // every table row View carries wrap={false}
    const rowViews = source.match(/<View\s+key=\{[^}]+\}\s+wrap=\{false\}/g) ?? [];
    expect(rowViews.length).toBeGreaterThanOrEqual(3);
    // the foot: an unbreakable totals block that sits directly before the fixed page footer
    const tail = source.slice(source.lastIndexOf("The foot:"));
    expect(tail).toMatch(/<View style=\{styles\.totalsWrapper\} wrap=\{false\}>/);
    expect(tail.indexOf("m.foot.label")).toBeGreaterThan(-1);
    expect(tail.indexOf("<StatementFooter")).toBeGreaterThan(tail.indexOf("m.foot.value"));
    expect(tail.indexOf("m.payments")).toBe(-1);
    expect(tail.indexOf("m.credits")).toBe(-1);
  });
});

describe("service: PD2 letterhead fallback, the current key, PD5 the monthly key", () => {
  const TENANT_CONFIG = {
    businessName: "Acme Wholesale",
    addressLine1: "1 Main St",
    addressLine2: null,
    city: "Dallas",
    state: "TX",
    zip: "75001",
    country: null,
    phone: "555-0100",
    website: null,
    customerEmail: null,
    primaryColor: null,
    logoKey: "logos/acme.png",
  };
  const setup = () => {
    mockRendered = [];
    const prisma = createMockPrisma() as any;
    prisma.getTenantId = jest.fn().mockReturnValue("t1");
    prisma.forTenant = jest.fn().mockReturnValue(prisma);
    prisma.customer.findFirst.mockResolvedValue({ id: "c1", businessName: "Buyer Co" });
    prisma.tenantConfig.findUnique.mockResolvedValue(TENANT_CONFIG);
    const storage = {
      download: jest.fn().mockRejectedValue(new Error("gone")),
      upload: jest.fn().mockResolvedValue(undefined),
      presignedUrl: jest.fn().mockResolvedValue("https://signed.example/x.pdf"),
    };
    const statements = { buildMonthlyStatement: jest.fn() };
    const service = new StatementPdfService(prisma, storage as any, statements as any);
    return { prisma, storage, statements, service };
  };

  it("PD2: a logo that fails to load still renders, handing the template the tenant's name and address", async () => {
    mockBuild.mockResolvedValue(statement());
    const { service, storage } = setup();
    const url = await service.generateCurrent("c1");
    expect(url).toBe("https://signed.example/x.pdf");
    expect(storage.download).toHaveBeenCalledWith("logos/acme.png");
    expect(mockRendered).toHaveLength(1);
    const props = mockRendered[0].props;
    expect(props.tenant).toMatchObject({
      businessName: "Acme Wholesale",
      addressLine1: "1 Main St",
      city: "Dallas",
    });
    expect(props.tenant.logoDataUri).toBeUndefined();
    expect(props.statement.openBalance).toBe(160.5);
    // the customer's read: no staff-only keys on the page
    expect(mockBuild.mock.calls[0][2]).toEqual({ staff: false });
  });

  it("stores the current statement at its own key and returns the signed URL", async () => {
    mockBuild.mockResolvedValue(statement());
    const { service, storage } = setup();
    await service.generateCurrent("c1");
    const [key, , mime] = storage.upload.mock.calls[0];
    expect(key).toBe("statement-pdfs/c1/current.pdf");
    expect(mime).toBe("application/pdf");
    expect(storage.presignedUrl).toHaveBeenCalledWith("statement-pdfs/c1/current.pdf");
  });

  it("404s on a customer that is not this tenant's, before any render", async () => {
    const { service, prisma } = setup();
    prisma.customer.findFirst.mockResolvedValue(null);
    await expect(service.generateCurrent("nope")).rejects.toThrow("Customer not found");
    expect(mockRendered).toHaveLength(0);
  });

  it("PD5: the monthly PDF is stored under its own, unchanged key", async () => {
    const { service, storage, statements } = setup();
    statements.buildMonthlyStatement.mockResolvedValue({ closing: 100 });
    const url = await service.generateAndUpload("c1", "2026-10");
    expect(url).toBe("https://signed.example/x.pdf");
    expect(storage.upload.mock.calls[0][0]).toBe("statement-pdfs/c1/2026-10.pdf");
    expect(statements.buildMonthlyStatement).toHaveBeenCalledWith("c1", "2026-10");
  });
});
