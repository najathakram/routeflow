/**
 * W-1187 PR-1c, real Postgres: an invoice lists its lines in the order its ORDER lists them (D6), written by the real
 * writers over real rows. The helper's rules are unit-pinned (invoice-line-position.spec.ts) and every writer is pinned
 * by the AST spec; this proves what the database holds and what every copy shows.
 *
 *   R10  full bill from an order built [Zebra, Apple]: the detail read shows Zebra, Apple (A-Z would say Apple, Zebra)
 *   R11  the same invoice on the PDF model and the send email
 *   R12  a partial bill requested as [Apple, Zebra] stores and shows the ORDER's order
 *   create / update / duplicate of a standalone invoice follow the payload's / the source's shown order; a linked
 *   invoice's edit never lets the payload override its order
 *   G-c  an invoice with a NULL position keeps the permanent A-Z read (owner Q2) and a duplicate of it is positioned
 *   G-d  `position` is not a fingerprint field: rewriting every slot never reads as "changed since sent"
 *
 * Runs only under `npm run local:test:db`. Tenants are throwaway `qa-w1187-<run>-<n>` slugs approved by
 * `assertTestTenant`; `afterAll` deletes what they hold. Scaffold: invoice-line-order.db.spec.ts (SA-1058).
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-w1187-${RUN_SUFFIX}-${tenantSeq}`,
    "invoice-line-position.db.spec.ts",
  );
}

describeDb("an invoice lists its lines in its order's order (W-1187 PR-1c)", () => {
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
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            getAll: jest.fn().mockResolvedValue({}),
            set: jest.fn(),
          },
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
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            getAll: jest.fn().mockResolvedValue({}),
            set: jest.fn(),
          },
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

  type Seed = {
    tenantId: string;
    customerId: string;
    orderId: string;
    zebra: { productId: string; orderItemId: string };
    apple: { productId: string; orderItemId: string };
  };

  /** A CONFIRMED order built [Zebra, Apple]: Zebra holds slot 0, Apple slot 1 (A-Z would print Apple first). */
  async function seedOrder(): Promise<Seed> {
    const slug = freshTenantSlug();
    const tenant = await prisma.tenant.create({ data: { slug, name: `w1187 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: "w1187",
        contactName: "w1187",
        email: `${slug}-c@example.invalid`,
        tenantId,
      } as any,
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderNumber: `ORD-W1187-${slug}`,
        status: "CONFIRMED",
        subtotal: 5,
        tax: 0,
        total: 5,
      } as any,
    });
    const line = async (name: string, price: number, position: number) => {
      const product = await prisma.product.create({
        data: { name, unit: "ea", pricePerUnit: price, tenantId } as any,
      });
      const item = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          qty: 1,
          unitPrice: price,
          subtotal: price,
          status: "CONFIRMED",
          position,
          tenantId,
        } as any,
      });
      return { productId: product.id, orderItemId: item.id };
    };
    const zebra = await line("Zebra", 2, 0);
    const apple = await line("Apple", 3, 1);
    return { tenantId, customerId: customer.id, orderId: order.id, zebra, apple };
  }

  const inTenant = <T>(s: { tenantId: string }, fn: () => Promise<T>) =>
    tenantCtx.run(s.tenantId, fn);
  const detail = (s: { tenantId: string }, id: string) =>
    inTenant(s, () => invoicesService.findOne(id)) as Promise<any>;
  const names = (rows: any[]) => rows.map((r) => r.description);
  const slots = async (invoiceId: string) =>
    Object.fromEntries(
      (await prisma.invoiceItem.findMany({ where: { invoiceId } })).map((r) => [
        r.description,
        r.position,
      ]),
    );
  const fullBill = async (s: Seed) =>
    ((await inTenant(s, () => invoicesService.createInvoiceFromOrder(s.orderId))) as any[])[0];
  const standalone = (s: Seed, order: string[]) =>
    inTenant(s, () =>
      invoicesService.create({
        customerId: s.customerId,
        items: order.map((description) => ({ description, qty: 1, unitPrice: 2 })),
      } as any),
    ) as Promise<any>;

  it("R10: a full bill lists the lines in the order's order, and stores the order's slots", async () => {
    const s = await seedOrder();
    const inv = await fullBill(s);
    expect(names((await detail(s, inv.id)).items)).toEqual(["Zebra", "Apple"]);
    expect(await slots(inv.id)).toEqual({ Zebra: 0, Apple: 1 });
  });

  it("R11: the PDF model and the send email show the same sequence", async () => {
    const s = await seedOrder();
    const inv = await fullBill(s);
    mockCapturedInvoice = null;
    await inTenant(s, () => pdf.generateAndUpload(inv.id));
    expect(names(mockCapturedInvoice.items)).toEqual(["Zebra", "Apple"]);
    const snapshot = (await prisma.invoice.findUnique({
      where: { id: inv.id },
      include: SEND_SNAPSHOT_INCLUDE,
    })) as any;
    const email = buildInvoiceEmailPayload(snapshot, {
      recipientEmail: "x@example.invalid",
      pdfUrl: undefined,
      attachment: undefined,
      hideOriginalPrice: false,
    });
    expect(names(email.items)).toEqual(["Zebra", "Apple"]);
  });

  it("R12: a partial bill requested [Apple, Zebra] stores and shows the ORDER's order", async () => {
    const s = await seedOrder();
    const inv: any = await inTenant(s, () =>
      invoicesService.createPartialFromOrder(s.orderId, {
        items: [
          { orderItemId: s.apple.orderItemId, qty: 1 },
          { orderItemId: s.zebra.orderItemId, qty: 1 },
        ],
      } as any),
    );
    const id = inv.id ?? inv.invoice?.id;
    expect(names((await detail(s, id)).items)).toEqual(["Zebra", "Apple"]);
    expect(await slots(id)).toEqual({ Zebra: 0, Apple: 1 });
  });

  it("a standalone invoice lists its lines in the order they were entered, not A-Z", async () => {
    const s = await seedOrder();
    const inv = await standalone(s, ["Zebra", "Apple", "Mango"]);
    expect(names((await detail(s, inv.id)).items)).toEqual(["Zebra", "Apple", "Mango"]);
    expect(await slots(inv.id)).toEqual({ Zebra: 0, Apple: 1, Mango: 2 });
  });

  it("editing a standalone draft re-slots the lines in the saved order and keeps every row", async () => {
    const s = await seedOrder();
    const inv = await standalone(s, ["Zebra", "Apple"]);
    const before = await detail(s, inv.id);
    const ids = before.items.map((i: any) => i.id).sort();
    await inTenant(s, () =>
      invoicesService.update(inv.id, {
        items: [...before.items].reverse().map((i: any) => ({
          id: i.id,
          description: i.description,
          qty: Number(i.qty),
          unitPrice: Number(i.unitPrice),
          discount: Number(i.discount ?? 0),
        })),
      } as any),
    );
    const after = await detail(s, inv.id);
    expect(names(after.items)).toEqual(["Apple", "Zebra"]);
    expect(after.items.map((i: any) => i.id).sort()).toEqual(ids); // same rows, re-slotted
  });

  it("editing an order-linked draft never lets the payload override its order", async () => {
    const s = await seedOrder();
    const inv = await fullBill(s);
    // an open order's mirror invoice is locked ("edit the order instead"); after delivery the invoice is editable
    await prisma.order.updateMany({ where: { id: s.orderId }, data: { status: "DELIVERED" } });
    const before = await detail(s, inv.id);
    await inTenant(s, () =>
      invoicesService.update(inv.id, {
        items: [...before.items].reverse().map((i: any) => ({
          id: i.id,
          productId: i.productId ?? undefined,
          description: i.description,
          qty: Number(i.qty),
          unitPrice: Number(i.unitPrice),
          discount: Number(i.discount ?? 0),
        })),
      } as any),
    );
    expect(names((await detail(s, inv.id)).items)).toEqual(["Zebra", "Apple"]);
  });

  it("a duplicate keeps its source's shown order", async () => {
    const s = await seedOrder();
    const inv = await standalone(s, ["Zebra", "Apple", "Mango"]);
    const copy: any = await inTenant(s, () => invoicesService.duplicate(inv.id));
    const id = copy.id ?? copy.invoice?.id;
    expect(names((await detail(s, id)).items)).toEqual(["Zebra", "Apple", "Mango"]);
    expect(await slots(id)).toEqual({ Zebra: 0, Apple: 1, Mango: 2 });
  });

  it("G-c: one NULL position and the invoice reads A-Z for good; a duplicate of it is positioned A-Z", async () => {
    const s = await seedOrder();
    const inv = await fullBill(s);
    await prisma.invoiceItem.updateMany({
      where: { invoiceId: inv.id, description: "Apple" },
      data: { position: null },
    });
    const before = await prisma.invoiceItem.findMany({
      where: { invoiceId: inv.id },
      orderBy: { id: "asc" },
      select: { id: true, position: true, updatedAt: true },
    });
    expect(names((await detail(s, inv.id)).items)).toEqual(["Apple", "Zebra"]); // legacy fallback
    // the read wrote nothing
    expect(
      await prisma.invoiceItem.findMany({
        where: { invoiceId: inv.id },
        orderBy: { id: "asc" },
        select: { id: true, position: true, updatedAt: true },
      }),
    ).toEqual(before);
    // a duplicate of a legacy invoice (an order-linked one is refused, so a standalone one here) is positioned in
    // the SHOWN (A-Z) order it was read in
    const legacy = await standalone(s, ["Zebra", "Apple"]);
    await prisma.invoiceItem.updateMany({
      where: { invoiceId: legacy.id },
      data: { position: null },
    });
    const copy: any = await inTenant(s, () => invoicesService.duplicate(legacy.id));
    const id = copy.id ?? copy.invoice?.id;
    expect(await slots(id)).toEqual({ Apple: 0, Zebra: 1 });
  });

  it("G-c edit: a legacy invoice saved in the order it is shown writes nothing; saved in a NEW order it is stamped", async () => {
    const s = await seedOrder();
    const legacy = await standalone(s, ["Zebra", "Apple"]);
    await prisma.invoiceItem.updateMany({
      where: { invoiceId: legacy.id },
      data: { position: null },
    });
    const shown = await detail(s, legacy.id); // A-Z: Apple, Zebra
    expect(names(shown.items)).toEqual(["Apple", "Zebra"]);
    const save = (items: any[]) =>
      inTenant(s, () =>
        invoicesService.update(legacy.id, {
          items: items.map((i: any) => ({
            id: i.id,
            description: i.description,
            qty: Number(i.qty),
            unitPrice: Number(i.unitPrice),
            discount: Number(i.discount ?? 0),
          })),
        } as any),
      );
    await save(shown.items); // unchanged
    expect(await slots(legacy.id)).toEqual({ Apple: null, Zebra: null });
    await save([...shown.items].reverse()); // the person puts Zebra first
    expect(await slots(legacy.id)).toEqual({ Zebra: 0, Apple: 1 });
    expect(names((await detail(s, legacy.id)).items)).toEqual(["Zebra", "Apple"]);
  });

  it("G-d: rewriting every slot of a sent invoice leaves its fingerprint alone", async () => {
    const s = await seedOrder();
    const inv = await fullBill(s);
    await prisma.invoice.updateMany({ where: { id: inv.id }, data: { status: "SENT" } });
    const snap = () =>
      prisma.invoice.findUnique({ where: { id: inv.id }, include: SEND_SNAPSHOT_INCLUDE }) as any;
    const before = invoiceFingerprint(await snap());
    await prisma.invoiceItem.updateMany({
      where: { invoiceId: inv.id, description: "Zebra" },
      data: { position: 5 },
    });
    await prisma.invoiceItem.updateMany({
      where: { invoiceId: inv.id, description: "Apple" },
      data: { position: 4 },
    });
    expect(invoiceFingerprint(await snap())).toBe(before);
  });
});
