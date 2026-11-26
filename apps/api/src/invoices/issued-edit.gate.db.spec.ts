/**
 * SA-1508 commit 5 (gate) - DB-lane proof of an admin's in-place edit of an ISSUED invoice against a REAL Postgres:
 *   - a money edit goes through for an admin, and every refusal (waiting or confirmed payment, open payment request,
 *     credit note, operator, VOID, WRITTEN_OFF, moved issue date, order-linked) leaves the invoice and its lines
 *     byte-equal (DB-5);
 *   - a figure-free save (the screen payload with a note changed) is allowed with a payment waiting and writes no
 *     figure; an unchanged save writes nothing, `updatedAt` included (DB-12);
 *   - a line sold by a unit refuses a money edit but not a figure-free one (DB-13);
 *   - free units above the cap come back at the cap untouched, on SENT and on DRAFT (DB-16);
 *   - the token is required, and a second editor holding the old one is refused INVOICE_STALE.
 * Each case that is red on master is red because master answers 400 "Only DRAFT invoices can be edited".
 * Collected only by `jest.db.config.js` (`.db.spec.ts/**
 * ), run via `npm run local:test:db`. Every tenant is a throwaway
 * `qa-sa1508-<run>-<n>-<label>` slug approved by `assertTestTenant`; `afterAll` deletes the tenants THIS run created.
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-sa1508-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "issued-edit.gate.db.spec.ts",
  );
}

describeDb("an admin edits an issued invoice in place - real Postgres (SA-1508 gate)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoicesService: InvoicesService;
  const createdTenantIds: string[] = [];

  const mockCreditNotes = {
    autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
    settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
    releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
  };

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        EstimatesService,
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: RouteFlowGateway,
          useValue: {
            emitInvoiceUpdated: jest.fn(),
            emitOrderCreated: jest.fn(),
            emitOrderStatusChanged: jest.fn(),
            emitLowStock: jest.fn(),
            emitStopCompleted: jest.fn(),
            emitUrgentOrder: jest.fn(),
          },
        },
        {
          provide: EmailService,
          useValue: {
            sendInvoice: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }),
            isEmailConfigured: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            getAll: jest.fn().mockResolvedValue({}),
            set: jest.fn().mockResolvedValue(undefined),
          },
        },
        RegulatedLedgerService,
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        { provide: CreditNotesService, useValue: mockCreditNotes },
        {
          provide: MessagingService,
          useValue: {
            notify: jest.fn().mockResolvedValue([]),
            notifyEvent: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn().mockResolvedValue("stored"),
            presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    invoicesService = module.get(InvoicesService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.regulatedSalesLedger.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.invoicePayment.deleteMany({ where: { invoice: { tenantId } } });
    await prisma.creditNote.deleteMany({ where: { tenantId } });
    await prisma.buyerPaymentRequest.deleteMany({ where: { tenantId } });
    await prisma.invoiceItem.deleteMany({
      where: { OR: [{ tenantId }, { invoice: { tenantId } }] },
    });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.trackedCategory.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  type LineSeed = {
    qty: number;
    unitPrice: number;
    subtotal: number;
    boxes?: number | null;
    pieces?: number | null;
    unitsPerBox?: number | null;
    unitLabel?: string | null;
    promoFreeUnits?: number | null;
    taxRate?: number;
  };

  /** A standalone invoice (or an order-linked one) in `status`, with its lines; acme-style dummy data only. */
  async function seed(
    label: string,
    opts: {
      status?: string;
      lines?: LineSeed[];
      withOrder?: boolean;
      /** Stored header figures that the lines do not explain (an imported file total, an older tax). */
      header?: { taxAmount: number; total: number };
    } = {},
  ) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `sa1508 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const idBase = `${tenantId}-${label}`;
    const user = await prisma.user.create({
      data: { email: `${idBase}@example.invalid`, username: idBase, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `customer ${label}`, contactName: label, tenantId },
    });
    const product = await prisma.product.create({
      data: { tenantId, name: `widget ${label}`, unit: "each", pricePerUnit: 50 },
    });
    const lines = opts.lines ?? [{ qty: 2, unitPrice: 50, subtotal: 100 }];
    const total = lines.reduce((a, l) => a + l.subtotal, 0);
    let orderId: string | null = null;
    if (opts.withOrder) {
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderNumber: `ORD-SA1508-${RUN_SUFFIX}-${label}`,
          status: "DELIVERED",
          subtotal: total,
          total,
        },
      });
      orderId = order.id;
    }
    const inv = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderId,
        invoiceNumber: `INV-SA1508-${RUN_SUFFIX}-${label}`,
        status: (opts.status ?? "SENT") as any,
        subtotal: total,
        taxAmount: opts.header?.taxAmount ?? 0,
        total: opts.header?.total ?? total,
      },
    });
    const rows = [];
    for (const [i, l] of lines.entries()) {
      rows.push(
        await prisma.invoiceItem.create({
          data: {
            tenantId,
            invoiceId: inv.id,
            productId: product.id,
            description: `widget ${i}`,
            position: i,
            ...l,
          },
        }),
      );
    }
    const actor = (role: string) => ({ sub: user.id, role, tenantId }) as any;
    return { tenantId, customerId: customer.id, product, inv, rows, orderId, actor };
  }

  const run = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const snapshot = async (id: string) =>
    JSON.stringify(
      await prisma.invoice.findUnique({
        where: { id },
        include: { items: { orderBy: { id: "asc" } } },
      }),
    );
  const token = async (id: string) =>
    (await prisma.invoice.findUnique({ where: { id } }))!.updatedAt.toISOString();

  type S = Awaited<ReturnType<typeof seed>>;
  /** The edit screen's payload: every stored line back as stored, nothing changed. */
  const screen = (s: S, over: Partial<Record<string, unknown>> = {}) =>
    s.rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      description: r.description,
      qty: Number(r.qty),
      boxes: r.boxes,
      pieces: r.pieces,
      unitPrice: Number(r.unitPrice),
      discount: 0,
      taxRate: 0,
      promoFreeUnits: 0,
      ...over,
    }));
  const save = async (
    s: S,
    dto: Record<string, unknown>,
    role = "TENANT_ADMIN",
    withToken = true,
  ) =>
    run(s.tenantId, async () =>
      invoicesService.update(
        s.inv.id,
        { ...(withToken ? { expectedUpdatedAt: await token(s.inv.id) } : {}), ...dto } as never,
        s.actor(role),
      ),
    );
  const refusedUntouched = async (
    s: S,
    dto: Record<string, unknown>,
    expected: object,
    role?: string,
  ) => {
    const before = await snapshot(s.inv.id);
    await expect(save(s, dto, role)).rejects.toMatchObject({ response: expected });
    expect(await snapshot(s.inv.id)).toBe(before);
  };
  const refused = (reason: string) => ({ code: "INVOICE_EDIT_REFUSED", reason });

  it("DB-1: an admin's money edit of a SENT invoice goes through: the line and the total follow, the status stays SENT", async () => {
    const s = await seed("money");
    const out: any = await save(s, { items: screen(s, { qty: 3 }) });
    expect(out.status).toBe("SENT");
    const after = await prisma.invoice.findUnique({
      where: { id: s.inv.id },
      include: { items: true },
    });
    expect(after!.status).toBe("SENT");
    expect(Number(after!.items[0].qty)).toBe(3);
    expect(Number(after!.items[0].subtotal)).toBe(150);
    expect(Number(after!.total)).toBe(150);
  });

  it("DB-5: refusals leave the invoice and its lines byte-equal", async () => {
    const pendingPay = await seed("pending");
    await prisma.invoicePayment.create({
      data: {
        invoiceId: pendingPay.inv.id,
        amount: 10,
        method: "CASH",
        status: "PENDING" as any,
        tenantId: pendingPay.tenantId,
      },
    });
    await refusedUntouched(
      pendingPay,
      { items: screen(pendingPay, { qty: 3 }) },
      refused("PENDING_PAYMENT"),
    );

    const confirmed = await seed("confirmed", { status: "PARTIAL" });
    await prisma.invoicePayment.create({
      data: {
        invoiceId: confirmed.inv.id,
        amount: 10,
        method: "CASH",
        status: "PAID" as any,
        tenantId: confirmed.tenantId,
      },
    });
    await refusedUntouched(confirmed, { items: screen(confirmed, { qty: 3 }) }, refused("PAID"));

    const request = await seed("request");
    await prisma.buyerPaymentRequest.create({
      data: {
        tenantId: request.tenantId,
        customerId: request.customerId,
        kind: "CASH",
        status: "PENDING",
        amount: 100,
      },
    });
    await refusedUntouched(request, { items: screen(request, { qty: 3 }) }, refused("PAYING_CASH"));

    const credit = await seed("credit");
    await prisma.creditNote.create({
      data: {
        tenantId: credit.tenantId,
        customerId: credit.customerId,
        invoiceId: credit.inv.id,
        creditNoteNumber: `CN-${RUN_SUFFIX}`,
        amount: 5,
      },
    });
    await refusedUntouched(credit, { items: screen(credit, { qty: 3 }) }, refused("CREDIT"));

    const operator = await seed("operator");
    await refusedUntouched(operator, { notes: "x" }, refused("NOT_ADMIN"), "OPERATOR");

    const voided = await seed("void", { status: "VOID" });
    await refusedUntouched(voided, { notes: "x" }, refused("VOID"));
    const off = await seed("off", { status: "WRITTEN_OFF" });
    await refusedUntouched(off, { notes: "x" }, refused("WRITTEN_OFF"));

    const dated = await seed("dated");
    await refusedUntouched(dated, { issueDate: "2031-01-02", notes: "x" }, refused("ISSUE_DATE"));

    const linked = await seed("linked", { withOrder: true });
    await refusedUntouched(linked, { notes: "x" }, refused("ORDER_LINKED"));
  });

  it("figure-free: the screen payload with a note changed is allowed with a payment waiting and writes no figure", async () => {
    const s = await seed("figure-free");
    await prisma.invoicePayment.create({
      data: {
        invoiceId: s.inv.id,
        amount: 10,
        method: "CASH",
        status: "PENDING" as any,
        tenantId: s.tenantId,
      },
    });
    const before = await prisma.invoice.findUnique({
      where: { id: s.inv.id },
      include: { items: true },
    });
    const out: any = await save(s, {
      items: screen(s),
      discount: 0,
      shippingFee: 0,
      notes: "gate code 42",
    });
    expect(out.notes).toBe("gate code 42");
    const after = await prisma.invoice.findUnique({
      where: { id: s.inv.id },
      include: { items: true },
    });
    expect(after!.notes).toBe("gate code 42");
    for (const k of [
      "subtotal",
      "taxAmount",
      "discount",
      "shippingFee",
      "total",
      "status",
    ] as const)
      expect(String(after![k])).toBe(String(before![k]));
    expect(JSON.stringify(after!.items)).toBe(JSON.stringify(before!.items));
  });

  it("DB-12: an unchanged screen payload writes nothing, updatedAt included", async () => {
    const s = await seed("no-op");
    const before = await snapshot(s.inv.id);
    const out: any = await save(s, { items: screen(s), discount: 0, shippingFee: 0 });
    expect(out.id).toBe(s.inv.id);
    expect(await snapshot(s.inv.id)).toBe(before);
    expect(
      await prisma.auditLog.count({ where: { tenantId: s.tenantId, action: "invoice.revised" } }),
    ).toBe(0);
  });

  it("DB-13: a line sold by a unit refuses a money edit (UNIT_LINE) but not a figure-free save", async () => {
    const unitLine: LineSeed = {
      qty: 24,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 12,
      unitLabel: "Case",
      unitPrice: 50,
      subtotal: 100,
    };
    const s = await seed("unit-line", { lines: [unitLine] });
    const payload = (over = {}) =>
      screen(s, { boxes: undefined, pieces: undefined, qty: 2, ...over });
    const out: any = await save(s, { items: payload(), notes: "n" });
    expect(out.notes).toBe("n");
    await refusedUntouched(s, { items: payload({ unitPrice: 60 }) }, refused("UNIT_LINE"));
  });

  describe("consent (SA-1508 commit 6)", () => {
    const row100 = (): LineSeed => ({ qty: 2, unitPrice: 50, subtotal: 100, taxRate: 0 });
    const imported = () =>
      seed("imported", { lines: [row100()], header: { taxAmount: 0, total: 108.25 } });
    const legacy = (status = "SENT") =>
      seed(`legacy-${status.toLowerCase()}`, {
        status,
        lines: [row100(), row100(), row100()],
        header: { taxAmount: 24.75, total: 324.75 },
      });
    const stored = async (id: string) =>
      prisma.invoice.findUnique({
        where: { id },
        include: { items: { orderBy: { position: "asc" } } },
      });

    it("DB-9: an imported invoice's notes-only screen save is figure-free: its file total stands", async () => {
      const s = await imported();
      await save(s, { items: screen(s), discount: 0, shippingFee: 0, notes: "gate code 42" });
      const after = await stored(s.inv.id);
      expect(after!.notes).toBe("gate code 42");
      expect([Number(after!.total), Number(after!.subtotal), Number(after!.taxAmount)]).toEqual([
        108.25, 100, 0,
      ]);
    });

    it("DB-10: a money edit of it asks first (409 with the figures, nothing written); the echo lifts it; a stale echo asks again", async () => {
      const s = await imported();
      const items = screen(s, { qty: 3 });
      const ask = {
        ...refused("TOTAL_NOT_FROM_LINES"),
        storedTotal: 108.25,
        newTotal: 150,
        difference: -41.75,
        cause: "TOTAL_NOT_FROM_LINES",
      };
      await refusedUntouched(s, { items }, ask);
      await refusedUntouched(
        s,
        { items, acceptLineTotal: { storedTotal: 108.25, newTotal: 120 } },
        { ...ask, newTotal: 150 },
      );
      await save(s, { items, acceptLineTotal: { storedTotal: 108.25, newTotal: 150 } });
      const after = await stored(s.inv.id);
      expect([Number(after!.total), Number(after!.subtotal), Number(after!.taxAmount)]).toEqual([
        150, 150, 0,
      ]);
    });

    it("DB-10: a discount-only header save asks the same way, and the echo writes the line-based figures", async () => {
      const s = await imported();
      await refusedUntouched(
        s,
        { discount: 10 },
        { ...refused("TOTAL_NOT_FROM_LINES"), newTotal: 90 },
      );
      await save(s, { discount: 10, acceptLineTotal: { storedTotal: 108.25, newTotal: 90 } });
      const after = await stored(s.inv.id);
      expect([Number(after!.total), Number(after!.discount)]).toEqual([90, 10]);
    });

    it("DB-10b: a line added for the difference needs no dialog (the total reproduces)", async () => {
      const s = await imported();
      const extra = {
        productId: s.product.id,
        description: "freight",
        qty: 1,
        unitPrice: 8.25,
        discount: 0,
        taxRate: 0,
      };
      await save(s, { items: [...screen(s), extra] });
      expect(Number((await stored(s.inv.id))!.total)).toBe(108.25);
    });

    it("DB-11: a stale tax with no verified rate asks (OLDER_TAX); nothing is written", async () => {
      const s = await seed("unverified", {
        lines: [{ qty: 2, unitPrice: 50000, subtotal: 100000, taxRate: 0 }],
        header: { taxAmount: 8875.55, total: 108875.55 },
      });
      await refusedUntouched(
        s,
        { items: screen(s, { qty: 3 }) },
        { ...refused("TOTAL_NOT_FROM_LINES"), cause: "OLDER_TAX", storedTax: 8875.55 },
      );
    });

    it("DB-11b: a stale legacy invoice with a verified rate: a money edit stamps the rate on the rate-0 lines and keeps the billed tax", async () => {
      const s = await legacy();
      const items = screen(s);
      items[0] = { ...items[0], unitPrice: 55, taxRate: 0.0825 }; // A: 110.00 at the verified rate
      items[1] = { ...items[1], unitPrice: 45 }; // B: 90.00 at 0
      await save(s, { items, discount: 0, shippingFee: 0 });
      const after = await stored(s.inv.id);
      expect([Number(after!.taxAmount), Number(after!.total)]).toEqual([24.75, 324.75]);
      expect(after!.items.map((l) => Number(l.taxRate))).toEqual([0.0825, 0.0825, 0.0825]);
    });

    it("DB-11b variant: the screen's own payload (every line at the verified rate) is figure-free: nothing is restamped", async () => {
      const s = await legacy();
      const out = await save(s, {
        items: screen(s, { taxRate: 0.0825 }),
        discount: 0,
        shippingFee: 0,
        notes: "n",
      });
      expect((out as any).notes).toBe("n");
      const after = await stored(s.inv.id);
      expect([Number(after!.taxAmount), Number(after!.total)]).toEqual([24.75, 324.75]);
      expect(after!.items.map((l) => Number(l.taxRate))).toEqual([0, 0, 0]);
    });

    it("DB-17: a stale DRAFT edited from a screen that sends the verified rate on every line keeps the billed tax (master's rule, pinned)", async () => {
      const s = await legacy("DRAFT");
      await save(s, {
        items: screen(s, { taxRate: 0.0825 }),
        discount: 0,
        shippingFee: 0,
        notes: "n",
      });
      const after = await stored(s.inv.id);
      expect([Number(after!.taxAmount), Number(after!.total)]).toEqual([24.75, 324.75]);
      expect(after!.items.map((l) => Number(l.taxRate))).toEqual([0.0825, 0.0825, 0.0825]);
    });

    it("DB-17b: the web payload (rate 0 on every line) on the SENT invoice is figure-free: the billed total stands", async () => {
      const s = await legacy();
      await save(s, { items: screen(s), discount: 0, shippingFee: 0, notes: "n" });
      const after = await stored(s.inv.id);
      expect([Number(after!.taxAmount), Number(after!.total), after!.notes]).toEqual([
        24.75,
        324.75,
        "n",
      ]);
    });
  });

  it("DB-16: free units above the cap come back at the cap untouched: no re-price, on SENT and on DRAFT", async () => {
    for (const status of ["SENT", "DRAFT"]) {
      const overCap: LineSeed = {
        qty: 12,
        boxes: 1,
        pieces: 0,
        unitPrice: 10,
        subtotal: 0,
        promoFreeUnits: 1,
      };
      const s = await seed(`over-cap-${status.toLowerCase()}`, {
        status,
        lines: [overCap, { qty: 2, unitPrice: 50, subtotal: 100 }],
      });
      await save(s, { items: screen(s), discount: 0, shippingFee: 0, notes: "n" });
      const after = await prisma.invoice.findUnique({
        where: { id: s.inv.id },
        include: { items: { orderBy: { position: "asc" } } },
      });
      expect(Number(after!.items[0].subtotal)).toBe(0);
      expect(after!.items[0].promoFreeUnits).toBe(1);
      expect(Number(after!.total)).toBe(100);
    }
  });

  it("the token is required, and a second editor holding the old one is refused INVOICE_STALE", async () => {
    const s = await seed("token");
    const before = await snapshot(s.inv.id);
    await expect(save(s, { notes: "a" }, "TENANT_ADMIN", false)).rejects.toMatchObject({
      response: { code: "INVOICE_STALE" },
    });
    expect(await snapshot(s.inv.id)).toBe(before);

    const stale = await token(s.inv.id);
    await save(s, { notes: "first editor" });
    await expect(
      run(s.tenantId, () =>
        invoicesService.update(
          s.inv.id,
          { expectedUpdatedAt: stale, notes: "second editor" } as never,
          s.actor("TENANT_ADMIN"),
        ),
      ),
    ).rejects.toMatchObject({ response: { code: "INVOICE_STALE" } });
    expect((await prisma.invoice.findUnique({ where: { id: s.inv.id } }))!.notes).toBe(
      "first editor",
    );
  });
});
