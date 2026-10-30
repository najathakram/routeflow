/**
 * SA-1058, real Postgres: one seeded invoice, every line written in one create (one `createdAt`, the
 * case the old `[createdAt, id]` read left to a random id), reads back in ONE product-wise order on
 * the detail read, the PDF model, the send email and the reminder. The sort is on a copy: R5 proves
 * the send fingerprint and the snapshot's own read order are untouched, R8 and R9 that nothing is
 * written. `@react-pdf/renderer` is mocked to capture the model the template receives.
 *
 * Runs only under `npm run local:test:db`. Tenants are throwaway `qa-1058-<run>-<n>` slugs approved by
 * `assertTestTenant`; `afterAll` deletes what they hold. Scaffold: split-invoice-no-rebuild-sa681.db.
 */

let mockCapturedInvoice: any = null;

jest.mock("@react-pdf/renderer", () => ({
  renderToBuffer: jest.fn(async (element: any) => {
    mockCapturedInvoice = element?.props?.invoice ?? null;
    return Buffer.from("");
  }),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
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
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { SEND_SNAPSHOT_INCLUDE } from "./invoice-send-snapshot";
import { invoiceFingerprint } from "./invoice-send-state";
import { buildInvoiceEmailPayload } from "./invoice-email-payload";
import { sendReminder } from "./invoice-reminder-email";
import { pickCustomerInvoiceFields } from "../common/staff-only-fields";
import { inScanOrder } from "../orders/counter-sale/counter-sale-readback";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(): string {
  tenantSeq += 1;
  return assertTestTenant(`qa-1058-${RUN_SUFFIX}-${tenantSeq}`, "invoice-line-order.db.spec.ts");
}

describeDb("invoice lines read back in one product-wise order on every copy (SA-1058)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoicesService: InvoicesService;
  let pdf: InvoicePdfService;
  const createdTenantIds: string[] = [];

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
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        { provide: EmailService, useValue: { sendInvoice: jest.fn() } },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
        },
        {
          provide: RegulatedLedgerService,
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
          },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        {
          provide: CreditNotesService,
          useValue: {
            autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0 }),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: MessagingService,
          useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
        },
        { provide: StorageService, useValue: { upload: jest.fn() } },
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
        },
        entitlementAuthorityFromEntitlements,
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn(),
            syncOrderInvoices: jest.fn(),
            removeInvoiceCommission: jest.fn(),
          },
        },
      ],
    }).compile();
    invoicesService = module.get(InvoicesService);
    const pdfModule = await Test.createTestingModule({
      providers: [
        InvoicePdfService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn(),
            presignedUrl: jest.fn().mockResolvedValue("https://x.invalid/i.pdf"),
          },
        },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
        },
      ],
    }).compile();
    pdf = pdfModule.get(InvoicePdfService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      const where = { tenantId };
      await (async () => {
        await prisma.invoiceItem.deleteMany({ where });
        await prisma.invoice.deleteMany({ where });
        await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
        await prisma.order.deleteMany({ where });
        await prisma.product.deleteMany({ where });
        await prisma.customer.deleteMany({ where });
        await prisma.user.deleteMany({ where });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
      })().catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  const LINES = [
    { desc: "Zebra Gum", product: true },
    { desc: "Delivery charge", product: false },
    { desc: "Chips BBQ", product: true, levy: 0.33 },
    { desc: "NSF fee — returned check 12", product: false, system: "NSF_FEE" },
    { desc: "Cola 12oz", product: true, boxes: 0, pieces: 5, unitsPerBox: 24 },
    { desc: "Apple Tea", product: true, discount: 1 },
    { desc: "Cola 12oz", product: true, boxes: 3, pieces: 0, unitsPerBox: 24 },
  ];
  const SHOWN = [
    "Apple Tea",
    "Chips BBQ",
    "Cola 12oz",
    "Cola 12oz",
    "Zebra Gum",
    "Delivery charge",
    "NSF fee — returned check 12",
  ];

  async function seedInvoice(status: "SENT" | "DRAFT") {
    const slug = freshTenantSlug();
    const tenant = await prisma.tenant.create({ data: { slug, name: `1058 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: "1058",
        contactName: "1058",
        email: `${slug}-c@example.invalid`,
        tenantId: tenant.id,
      } as any,
    });
    const productOf = new Map<string, string>();
    for (const l of LINES) {
      if (!l.product || productOf.has(l.desc)) continue;
      const p = await prisma.product.create({
        data: { name: l.desc, unit: "ea", pricePerUnit: 2, tenantId: tenant.id } as any,
      });
      productOf.set(l.desc, p.id);
    }
    const invoice = await prisma.invoice.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        invoiceNumber: `INV-1058-${slug}`,
        status,
        subtotal: 14,
        taxAmount: 0.33,
        total: 14.33,
      } as any,
    });
    await prisma.invoiceItem.createMany({
      data: LINES.map((l) => ({
        invoiceId: invoice.id,
        tenantId: tenant.id,
        productId: l.product ? productOf.get(l.desc) : null,
        description: l.desc,
        qty: 1,
        unitPrice: 2,
        discount: l.discount ?? 0,
        subtotal: 2,
        boxes: l.boxes ?? null,
        pieces: l.pieces ?? null,
        unitsPerBox: l.unitsPerBox ?? null,
        categoryTaxAmount: l.levy ?? 0,
        systemKind: l.system ?? null,
      })) as any,
    });
    return { tenantId: tenant.id, id: invoice.id };
  }

  const inTenant = <T>(s: { tenantId: string }, fn: () => Promise<T>) =>
    tenantCtx.run(s.tenantId, fn);
  const detail = (s: { tenantId: string; id: string }) =>
    inTenant(s, () => invoicesService.findOne(s.id)) as Promise<any>;
  const snapshotOf = (id: string) =>
    prisma.invoice.findUnique({ where: { id }, include: SEND_SNAPSHOT_INCLUDE }) as Promise<any>;
  const pdfItems = async (s: { tenantId: string; id: string }, model?: any) => {
    mockCapturedInvoice = null;
    await inTenant(s, () => pdf.generateAndUpload(s.id, undefined, model));
    return mockCapturedInvoice.items as any[];
  };
  const emailItems = (inv: any) =>
    buildInvoiceEmailPayload(inv, {
      recipientEmail: "x@example.invalid",
      pdfUrl: undefined,
      attachment: undefined,
      hideOriginalPrice: false,
    }).items;
  const reminderItems = async (s: { tenantId: string; id: string }) => {
    const sendInvoice = jest.fn().mockResolvedValue({ delivered: true });
    await inTenant(s, () =>
      sendReminder(
        {
          prisma,
          emailService: { isEmailConfigured: async () => true, sendInvoice },
          pdfService: { getOrGenerate: jest.fn().mockResolvedValue(undefined) },
          storage: {},
          systemConfig: { get: jest.fn().mockResolvedValue(null) },
          logger: new Logger("sa1058"),
        } as any,
        s.id,
      ),
    );
    return sendInvoice.mock.calls[0][0].items as any[];
  };
  const texts = (rows: any[]) => rows.map((r) => r.description);
  const rowClock = async (id: string) =>
    (
      await prisma.invoiceItem.findMany({
        where: { invoiceId: id },
        orderBy: { id: "asc" },
        select: { id: true, updatedAt: true },
      })
    ).map((r) => `${r.id}@${r.updatedAt.toISOString()}`);

  it("R7: the detail read, the PDF, the send email and the reminder give one sequence", async () => {
    const s = await seedInvoice("SENT");
    expect(texts((await detail(s)).items)).toEqual(SHOWN);
    expect(texts(await pdfItems(s))).toEqual(SHOWN);
    expect(texts(emailItems(await snapshotOf(s.id)))).toEqual(SHOWN);
    expect(texts(await reminderItems(s))).toEqual(SHOWN);
  });

  it("R5: rendering and emailing a sent invoice leaves its fingerprint and read order alone", async () => {
    const s = await seedInvoice("SENT");
    const model = await snapshotOf(s.id);
    const readOrder = model.items.map((i: any) => i.id);
    const before = invoiceFingerprint(model);
    await pdfItems(s, model);
    emailItems(model);
    expect(model.items.map((i: any) => i.id)).toEqual(readOrder);
    expect(invoiceFingerprint(model)).toBe(before);
    expect(invoiceFingerprint(await snapshotOf(s.id))).toBe(before);
  });

  it("R6: every figure on the shown copies equals the stored row, and the header is unmoved", async () => {
    const s = await seedInvoice("SENT");
    const stored = await prisma.invoiceItem.findMany({ where: { invoiceId: s.id } });
    const figures = (r: any) => [
      Number(r.qty),
      Number(r.unitPrice),
      Number(r.discount),
      Number(r.subtotal),
      r.categoryTaxAmount == null ? null : Number(r.categoryTaxAmount),
    ];
    const byId = new Map(stored.map((r) => [r.id, figures(r)]));
    const shown = await detail(s);
    for (const row of shown.items) expect(figures(row)).toEqual(byId.get(row.id));
    const pdfRows = await pdfItems(s);
    for (const row of pdfRows) expect(figures(row)).toEqual(byId.get(row.id));
    expect(Number(shown.total)).toBe(14.33);
    expect(Number(shown.taxAmount)).toBe(0.33);
  });

  it("R8: reading every copy writes no line", async () => {
    const s = await seedInvoice("SENT");
    const before = await rowClock(s.id);
    await detail(s);
    await pdfItems(s);
    emailItems(await snapshotOf(s.id));
    await reminderItems(s);
    expect(await rowClock(s.id)).toEqual(before);
  });

  it("R9: the edit form opened and saved unchanged keeps every line, its figures and its id", async () => {
    const s = await seedInvoice("DRAFT");
    const shown = await detail(s);
    const figures = async () =>
      (
        await prisma.invoiceItem.findMany({ where: { invoiceId: s.id }, orderBy: { id: "asc" } })
      ).map((r) => [
        r.id,
        r.description,
        Number(r.qty),
        Number(r.unitPrice),
        Number(r.subtotal),
        r.boxes,
        r.pieces,
      ]);
    const before = await figures();
    const clock = await rowClock(s.id);
    await inTenant(s, () =>
      invoicesService.update(s.id, {
        items: shown.items.map((i: any) => ({
          id: i.id,
          productId: i.productId ?? undefined,
          description: i.description,
          qty: Number(i.qty),
          boxes: i.boxes ?? undefined,
          pieces: i.pieces ?? undefined,
          unitPrice: Number(i.unitPrice),
          discount: Number(i.discount),
        })),
      } as any),
    );
    expect(await figures()).toEqual(before);
    expect(await rowClock(s.id)).toEqual(clock);
  });

  it("the buyer's copy keeps the order", async () => {
    const s = await seedInvoice("SENT");
    const shaped: any = pickCustomerInvoiceFields(await detail(s));
    expect(texts(shaped.items)).toEqual(SHOWN);
  });

  it("R2: the case line prints above the loose line of the same name", async () => {
    const s = await seedInvoice("SENT");
    const cola = (await detail(s)).items.filter((i: any) => i.description === "Cola 12oz");
    expect(cola.map((i: any) => i.boxes)).toEqual([3, 0]);
  });

  it("R10: renaming a product after issue moves no line on any copy", async () => {
    const s = await seedInvoice("SENT");
    await prisma.product.updateMany({
      where: { tenantId: s.tenantId, name: "Apple Tea" },
      data: { name: "Zulu Tea" },
    });
    expect(texts((await detail(s)).items)).toEqual(SHOWN);
    expect(texts(await pdfItems(s))).toEqual(SHOWN);
  });

  it("R16: the counter's read-back stays in scan order while the same sale's PDF is by name", async () => {
    const s = await seedInvoice("SENT");
    const rows = await prisma.invoiceItem.findMany({
      where: { invoiceId: s.id },
      orderBy: { id: "asc" },
    });
    // What the counter's read selects (counter-sale.service.ts): the order line's scan position.
    const scanned = rows.map((r) => ({
      ...r,
      orderItem: { position: LINES.findIndex((l) => l.desc === r.description) },
    }));
    const scanOrder = [...new Set(LINES.map((l) => l.desc))];
    expect([...new Set(texts(inScanOrder(scanned as any)))]).toEqual(scanOrder);
    expect(texts(await pdfItems(s))).toEqual(SHOWN);
  });
});
