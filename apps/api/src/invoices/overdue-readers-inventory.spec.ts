/**
 * SA-770 (ACTION-ITEMS row 294) — the class pin: "overdue" means a balance is due, so every SQL/ORM
 * reader that selects rows by an OVERDUE CUTOFF (`overdueCutoff(...)`, `dueDate: { lt ... }`,
 * `"dueDate" < ...`) must either go through the one SQL predicate in `invoice-balance-sql.ts` or be
 * listed here with the reason it is already balance-aware / not an invoice reader. A NEW overdue reader
 * that is on neither list fails this spec, instead of re-opening the bug (an overpaid or exactly-paid
 * invoice listed as overdue).
 *
 * Source scan, comments excluded; `*.spec.ts` skipped. Paths are relative to apps/api/src.
 */
jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../bookkeeping/invoice.service", () => ({ InvoiceService: jest.fn() }));
jest.mock("../vendor-bills/vendor-bills.service", () => ({ VendorBillsService: jest.fn() }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import * as fs from "fs";
import * as path from "path";
import { BookkeepingService } from "../bookkeeping/bookkeeping.service";
import { CustomersService } from "../customers/customers.service";
import { createMockPrisma } from "../testing/prisma-mock";

const SRC_ROOT = path.resolve(__dirname, "..");
const norm = (p: string) => path.relative(SRC_ROOT, p).split(path.sep).join("/");

/** Files that read through the shared predicate — each MUST import `invoice-balance-sql`. */
const USES_SQL_PREDICATE: Record<string, string> = {
  "bookkeeping/bookkeeping.service.ts": "getSummary overdueCount -> overdueInvoiceCount",
  "invoices/overdue-sweep.service.ts":
    "the hourly sweep -> markInvoicesOverdue / overdueInvoiceCount",
  // The list's status + due-day clauses are only the first stage: `applyOverdueBalanceFilter`
  // (called by InvoicesService.findAll) adds `id IN overdueInvoiceIds(...)`.
  "invoices/invoice-list-query.ts":
    "the list filter -> applyOverdueBalanceFilter -> overdueInvoiceIds",
};

/**
 * Files whose balance / overdue classification is the ONE TS classifier (invoice-balance-classify.ts).
 * Each MUST import it (and carries no inline `total - sumConfirmed` copy of its own).
 */
const USES_CLASSIFIER: Record<string, string> = {
  "invoices/invoice-detail-read.ts": "detail read: balanceDue / isOverdue",
  "invoices/invoices.service.ts": "list enrichment (findAll), sendEmail and sendReminder balances",
  "invoices/invoice-kpi-summary.ts": "KPI tiles: per-invoice balance (confirmedBalance)",
  "bookkeeping/bookkeeping.service.ts":
    "receivables / aging / AR / per-customer balances: clamped confirmedBalance per invoice (row 310). SIGNED by design: the per-customer closingBalance (invoiced - received, the Dr/Cr net position) and recordPayment's capacity guard (totalOwed - alreadyPaid)",
  "buyer/buyer.controller.ts":
    "getAnalytics: overdue / unpaid counts + BALANCE total (SA-770 r-note)",
  "buyer/buyer-dashboard.service.ts":
    "dashboard unpaid strip: BALANCE count + total (SA-770 r-note)",
};

/** Files that select by an overdue cutoff but are NOT a raw invoice-status reader, or already net the balance. */
const OTHER_READERS: Record<string, string> = {
  "common/calendar-date.ts": "defines overdueCutoff / isOverdue (the date rule itself)",
  "platform-admin/rf-invoices.service.ts":
    "RouteFlow's own platform invoices (a different table, RfInvoice); not tenant AR",
  "invoices/invoice-balance-sql.ts": "the predicate itself",
  "customers/customers.service.ts":
    "advance-apply status write: OVERDUE only when newPaid == 0 (already balance-aware); the statements moved to customer-statement.ts",
};

/**
 * Reviewed-known TS readers that still net a gross figure or classify by status + date. NOT changed in
 * SA-770 (the buyer ones need an SA ruling on gross vs balance). Each one is a follow-up that must land
 * with P-3: clamp with max(0, ...) or move onto one shared overdue rule.
 */
const FOLLOW_UP_READERS: Record<string, string> = {
  "import/import-payment-status.ts":
    "Zoho import status rule: OVERDUE only when nothing is confirmed-paid, paid >= total is PAID (already balance-aware)",
};

/**
 * Readers whose overdue FIGURE sums a per-invoice balance: each contribution is clamped at max(0,
 * roundMoney(balance)), so an overpaid open invoice can never make the figure negative (the selection of
 * which invoices count is unchanged). The spec asserts the clamp is still in the source.
 */
const BALANCE_CLAMPED: Record<string, { clamp: RegExp; reason: string; method?: string }> = {
  "customers/customer-statement.ts": {
    clamp: /Math\.max\(0, roundMoney\(Number\(i\.total\) - i\.amountPaid\)\)/g,
    reason:
      "statement overdueAmount, both the buyer's (getMyStatement) and the operator's statement",
  },
  "bookkeeping/bookkeeping.service.ts": {
    clamp: /confirmedBalance\(inv\.total, inv\.payments\)/g,
    method: "getCustomerBalanceSummary",
    reason: "per-customer aging (getCustomerBalanceSummary) `overdue`",
  },
};

/** The source of ONE method (from `async name(` to the next `async` member), comments excluded. */
function methodSource(src: string, name: string): string {
  const start = src.indexOf(`async ${name}(`);
  if (start < 0) throw new Error(`method ${name} not found`);
  const next = src.indexOf("\n  async ", start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

/** Every bookkeeping reader that shows a receivable / aging / balance figure: each must call confirmedBalance. */
const BOOKKEEPING_BALANCE_READERS = [
  "getSummary",
  "getMobileDashboard",
  "getFinanceDashboard",
  "getArAgingInvoices",
  "getCustomerBalanceSummary",
  "getInvoiceDetailsReport",
  "getBadDebtsReport",
  "getArAgingDetails",
  "getReceivableSummary",
];

const CUTOFF_READER = [
  /\boverdueCutoff\s*\(/,
  /\bdueDate["']?\s*[:=]\s*\{\s*lte?\b/,
  /["']dueDate["']\s*<=?\s/,
  // The TS readers: a due date compared in JS, and an overdue figure accumulated per row.
  /\bdueDate\s*<=?\s/,
  /new Date\([^)]*dueDate[^)]*\)\s*<=?\s/,
  /\boverdue\s*\+=/,
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") walk(full, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

describe("SA-770 — every overdue-cutoff reader is balance-aware or accounted for", () => {
  const readers = walk(SRC_ROOT)
    .filter((f) => {
      const src = stripComments(fs.readFileSync(f, "utf8"));
      return CUTOFF_READER.some((re) => re.test(src));
    })
    .map(norm)
    .sort();

  it("finds the known readers (the scan itself works)", () => {
    expect(readers).toEqual(
      expect.arrayContaining([
        ...Object.keys(USES_SQL_PREDICATE),
        "invoices/invoice-kpi-summary.ts",
      ]),
    );
  });

  it("no overdue-cutoff reader is outside the two lists", () => {
    const known = new Set([
      ...Object.keys(USES_SQL_PREDICATE),
      ...Object.keys(OTHER_READERS),
      ...Object.keys(FOLLOW_UP_READERS),
      ...Object.keys(BALANCE_CLAMPED),
      ...Object.keys(USES_CLASSIFIER),
    ]);
    const unknown = readers.filter((f) => !known.has(f));
    expect(unknown).toEqual([]); // route it through invoice-balance-sql.ts, or list it with a reason
  });

  it.each(Object.keys({ ...OTHER_READERS, ...FOLLOW_UP_READERS }))(
    "%s (listed with a reason) still exists",
    (rel) => {
      expect(fs.existsSync(path.join(SRC_ROOT, rel))).toBe(true);
    },
  );

  it.each(Object.entries(BALANCE_CLAMPED))("%s clamps its overdue contributions at 0", (rel, c) => {
    const whole = stripComments(fs.readFileSync(path.join(SRC_ROOT, rel), "utf8"));
    // pinned to the overdue site's own method when one is named, not to any call in the file
    const src = c.method ? methodSource(whole, c.method) : whole;
    expect(src.match(c.clamp)?.length ?? 0).toBeGreaterThanOrEqual(1);
    if (rel.startsWith("customers/")) expect(src.match(c.clamp)).toHaveLength(2); // both statements
    // the raw, unclamped accumulations are gone
    expect(src).not.toMatch(/overdue\s*\+=\s*bal\b/);
  });

  it.each(BOOKKEEPING_BALANCE_READERS)(
    "bookkeeping %s computes its balance through confirmedBalance (no inline total - paid)",
    (name) => {
      const src = stripComments(
        fs.readFileSync(path.join(SRC_ROOT, "bookkeeping/bookkeeping.service.ts"), "utf8"),
      );
      const body = methodSource(src, name);
      expect(body).toMatch(/\bconfirmedBalance\(/);
      expect(body).not.toMatch(
        /Number\((inv|i|invoice)\.total\)\s*-\s*(paid|inv\.payments|sumConfirmed)/,
      );
    },
  );

  // What each classifier user must actually CALL (an import alone proves nothing).
  const REQUIRED_CALL: Record<string, RegExp> = {
    "invoices/invoice-detail-read.ts": /\bclassifyInvoiceBalance\(/,
    "invoices/invoices.service.ts": /\bclassifyInvoiceBalance\([\s\S]*\bconfirmedBalance\(/,
    "invoices/invoice-kpi-summary.ts": /\bclassifyInvoiceBalance\(/,
    "bookkeeping/bookkeeping.service.ts": /\bconfirmedBalance\(/,
    "buyer/buyer.controller.ts": /\bsummarizeOpenInvoices\(/,
    "buyer/buyer-dashboard.service.ts": /\bsummarizeOpenInvoices\(/,
  };

  it.each(Object.keys(USES_CLASSIFIER))("%s uses the one TS classifier", (rel) => {
    const src = stripComments(fs.readFileSync(path.join(SRC_ROOT, rel), "utf8"));
    expect(src).toMatch(/from\s+["'](\.\.?\/)+(invoices\/)?invoice-balance-classify["']/);
    expect(src).toMatch(REQUIRED_CALL[rel]);
    // the inline copies are gone: no hand-rolled `total - <paid>` balance in these readers
    expect(src).not.toMatch(
      /Number\((inv|i|invoice)\.total\)\s*-\s*(sumConfirmed|totalConfirmed|totalPaid|paidAmount|amountPaid|paid|(inv|i|invoice)\.payments)\b/,
    );
  });

  it.each(Object.keys(USES_SQL_PREDICATE))("%s imports the shared SQL predicate", (rel) => {
    const src = stripComments(fs.readFileSync(path.join(SRC_ROOT, rel), "utf8"));
    expect(src).toMatch(
      /from\s+["'](\.\.?\/)+(invoices\/)?invoice-balance-sql["']|from\s+["']\.\/invoice-balance-sql["']/,
    );
  });

  it("InvoicesService.findAll runs the balance stage after the status filter", () => {
    const src = stripComments(
      fs.readFileSync(path.join(SRC_ROOT, "invoices/invoices.service.ts"), "utf8"),
    );
    const status = src.indexOf("applyInvoiceStatusFilters(where, query, tz)");
    const balance = src.indexOf("applyOverdueBalanceFilter(where, query");
    expect(status).toBeGreaterThan(-1);
    expect(balance).toBeGreaterThan(status);
  });
});

/** The BEHAVIOUR behind the source-shape pin: an overpaid open past-due invoice adds 0, never a negative. */
describe("SA-770 — BALANCE_CLAMPED readers behave (overpaid adds 0; a genuinely overdue invoice still counts)", () => {
  const PAST = new Date("2020-01-01T00:00:00.000Z");
  const overpaid = {
    id: "over",
    invoiceNumber: "OVER",
    customerId: "c1",
    status: "SENT",
    total: 100,
    dueDate: PAST,
    createdAt: PAST,
    payments: [{ amount: 110, status: "PAID", method: "CASH" }],
  };
  const owes = { ...overpaid, id: "owes", invoiceNumber: "OWES", total: 50, payments: [] };

  it("customers: both statement readers", async () => {
    const prisma = createMockPrisma();
    prisma.customer.findFirst.mockResolvedValue({ id: "c1", userId: "u1", businessName: "Acme" });
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.advancePayment.findMany.mockResolvedValue([]);
    prisma.order.findMany.mockResolvedValue([]);
    const svc = Object.create(CustomersService.prototype) as CustomersService;
    Object.assign(svc as any, {
      prisma,
      findCustomerOrThrow: jest.fn().mockResolvedValue({ id: "c1" }),
    });
    for (const rows of [[overpaid], [overpaid, owes]]) {
      prisma.invoice.findMany.mockResolvedValue(rows);
      const want = rows.length === 1 ? 0 : 50;
      expect((await svc.getMyStatement({ sub: "u1" } as any)).overdueAmount).toBe(want);
      expect((await svc.getStatementForOperator("c1")).overdueAmount).toBe(want);
    }
  });

  it("bookkeeping: the per-customer aging overdue figure", async () => {
    const prisma = createMockPrisma();
    prisma.tenantConfig.findUnique.mockResolvedValue(null);
    const svc = Object.create(BookkeepingService.prototype) as BookkeepingService;
    (svc as any).prisma = prisma;
    const cust = { id: "c1", businessName: "Acme", contactName: null, phone: null };
    for (const [rows, want] of [
      [[overpaid], 0],
      [[overpaid, owes], 50],
    ] as const) {
      prisma.invoice.findMany.mockResolvedValue(rows.map((r) => ({ ...r, customer: cust })));
      const res: any = await svc.getCustomerBalanceSummary();
      expect(res.data[0].overdue).toBe(want);
    }
  });
});
