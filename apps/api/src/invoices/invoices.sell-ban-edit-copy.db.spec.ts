/**
 * F-05 (#2117) — real-Postgres pin for the selling-restrictions ban on the two invoice paths the
 * create/convert spec does not drive: `InvoicesService.update` (an item replace is netted PER PRODUCT
 * in pieces — qtyDelta = requested - held) and `InvoicesService.duplicate` (a copy is a new sale of
 * every catalog line). REAL InvoicesService + SellingRestrictionsService + ProductLabelsService over a
 * REAL STATE ban on a category and a REAL CA customer address. Each DRAFT invoice is created while the
 * tenant flag is OFF (the "since-banned" state), then the flag is turned ON before the edit/copy.
 * Every tenant is a throwaway `qa-f2ban-*` slug approved by `assertTestTenant`; afterAll deletes what
 * it made. Collected only by `jest.db.config.js`; run via `npm run local:test:db`.
 */

// Prevent Jest from traversing ESM-only dependencies (same guard as invoices.service.spec.ts /
// invoice-numbering.db.spec.ts).
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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
/** A fresh, policy-approved throwaway tenant slug — never reused across tests in this file. */
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-f2ban-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "invoices.sell-ban-edit-copy.db.spec.ts",
  );
}

describeDb("F05 ban check on invoice update (net delta) + duplicate — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoicesService: InvoicesService;
  let estimatesService: EstimatesService;
  const createdTenantIds: string[] = [];

  const mockGateway = {
    emitInvoiceUpdated: jest.fn(),
    emitOrderCreated: jest.fn(),
    emitOrderStatusChanged: jest.fn(),
    emitLowStock: jest.fn(),
    emitStopCompleted: jest.fn(),
    emitUrgentOrder: jest.fn(),
  };
  const mockEmailService = {
    sendInvoice: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }),
    isEmailConfigured: jest.fn().mockResolvedValue(true),
  };
  const mockSystemConfig = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const mockCreditNotes = {
    autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
    settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
    releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
  };
  const mockMessaging = {
    notify: jest.fn().mockResolvedValue([]),
    notifyEvent: jest.fn().mockResolvedValue(undefined),
  };
  const mockStorage = {
    upload: jest.fn().mockResolvedValue("stored"),
    presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  // flag.msrp OFF: applyMsrpSnapshots no-ops.
  const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
  const mockCommissionEngine = {
    syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
    syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
    removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    // Nothing env-dependent may run at collection time (db-lane rule): the real connection is
    // built here, inside a hook, never at module top level.
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        SellingRestrictionsService,
        ProductLabelsService,
        EstimatesService,
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: mockGateway },
        { provide: EmailService, useValue: mockEmailService },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: mockSystemConfig },
        {
          provide: RegulatedLedgerService,
          useValue: { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        { provide: CreditNotesService, useValue: mockCreditNotes },
        { provide: MessagingService, useValue: mockMessaging },
        { provide: StorageService, useValue: mockStorage },
        { provide: EntitlementsService, useValue: mockEntitlements },
        entitlementAuthorityFromEntitlements, // #2241
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
      ],
    }).compile();

    invoicesService = module.get(InvoicesService);
    estimatesService = module.get(EstimatesService);
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
    await prisma.sellingRestriction.deleteMany({ where: { tenantId } });
    await prisma.productCategoryLabel.deleteMany({ where: { tenantId } });
    await prisma.systemConfig.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.estimate.deleteMany({ where: { tenantId } });
    await prisma.invoiceItem.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.numberingSequence.deleteMany({ where: { tenantId } });
    await prisma.customerAddress.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.productCategory.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  /** A CA customer, a banned category (STATE ban on CA), a loose banned product, a BOXED banned product
   *  (pack 12) and an unbanned product. Flag starts OFF so DRAFTs can be created holding banned lines. */
  async function seed(label: string) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `F05 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const idBase = `${tenantId}-c`;
    const user = await prisma.user.create({
      data: { email: `${idBase}@example.invalid`, username: idBase, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: "F05 customer", contactName: "F05", tenantId },
    });
    await prisma.customerAddress.create({
      data: {
        tenantId,
        customerId: customer.id,
        line1: "1 Test St",
        city: "Testville",
        state: "CA",
        stateCode: "CA",
        zip: "00000",
        isDefault: true,
        addressType: "BILLING",
      },
    });
    const category = await prisma.productCategory.create({
      data: { tenantId, name: "Banned goods" },
    });
    const banned = await prisma.product.create({
      data: { tenantId, name: "F05 banned loose", unit: "each", pricePerUnit: 10 },
    });
    const boxed = await prisma.product.create({
      data: { tenantId, name: "F05 banned boxed", unit: "each", pricePerUnit: 1, unitsPerBox: 12 },
    });
    const ok = await prisma.product.create({
      data: { tenantId, name: "F05 allowed", unit: "each", pricePerUnit: 5 },
    });
    for (const p of [banned, boxed]) {
      await prisma.productCategoryLabel.create({
        data: { tenantId, productId: p.id, categoryId: category.id, mode: "INCLUDE" },
      });
    }
    await prisma.sellingRestriction.create({
      data: {
        tenantId,
        categoryId: category.id,
        jurisdiction: "STATE",
        states: ["CA"],
        reason: "F05 edit/copy pin",
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await prisma.systemConfig.create({
      data: { tenantId, key: "selling_restrictions.enabled", value: "false" },
    });
    return { tenantId, customerId: customer.id, banned: banned.id, boxed: boxed.id, ok: ok.id };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  const setFlag = (s: Seed, on: boolean) =>
    prisma.systemConfig.updateMany({
      where: { tenantId: s.tenantId, key: "selling_restrictions.enabled" },
      data: { value: on ? "true" : "false" },
    });
  const run = <T>(s: Seed, fn: () => Promise<T>) => tenantCtx.run(s.tenantId, fn);
  const createDraft = (s: Seed, items: any[]) =>
    run(s, () =>
      invoicesService.create({ customerId: s.customerId, items } as any),
    ) as Promise<any>;
  const rows = (invoiceId: string) =>
    prisma.invoiceItem.findMany({
      where: { invoiceId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        productId: true,
        qty: true,
        boxes: true,
        pieces: true,
        unitsPerBox: true,
      },
    });
  const snapshot = async (invoiceId: string) =>
    JSON.stringify(
      (await rows(invoiceId))
        .map((r) => ({ ...r, qty: Number(r.qty) }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  const REFUSED = { response: { code: "SELLING_RESTRICTED" } };
  const line = (productId: string, qty: number, extra: Record<string, unknown> = {}) => ({
    description: "line",
    productId,
    qty,
    unitPrice: 10,
    ...extra,
  });

  describe("update(): net delta per product, in pieces", () => {
    it("N1 re-sending a held banned line unchanged is ALLOWED (delta 0)", async () => {
      const s = await seed("n1");
      const inv = await createDraft(s, [line(s.banned, 5)]);
      await setFlag(s, true);
      const [held] = await rows(inv.id);
      await run(s, () =>
        invoicesService.update(inv.id, { items: [line(s.banned, 5, { id: held.id })] } as any),
      );
      expect(Number((await rows(inv.id))[0].qty)).toBe(5);
    });

    it("N2 decreasing a held banned line 5 -> 3 is ALLOWED and written", async () => {
      const s = await seed("n2");
      const inv = await createDraft(s, [line(s.banned, 5)]);
      await setFlag(s, true);
      const [held] = await rows(inv.id);
      await run(s, () =>
        invoicesService.update(inv.id, { items: [line(s.banned, 3, { id: held.id })] } as any),
      );
      expect(Number((await rows(inv.id))[0].qty)).toBe(3);
    });

    it("N3 increasing a held banned line 5 -> 50 is REFUSED 409 SELLING_RESTRICTED, nothing written", async () => {
      const s = await seed("n3");
      const inv = await createDraft(s, [line(s.banned, 5)]);
      await setFlag(s, true);
      const [held] = await rows(inv.id);
      const before = await snapshot(inv.id);
      const err = await run(s, () =>
        invoicesService.update(inv.id, { items: [line(s.banned, 50, { id: held.id })] } as any),
      ).catch((e: any) => e);
      // #2225: the name promises 409 — assert the status, not only the code.
      expect(err).toMatchObject(REFUSED);
      expect(err.getStatus()).toBe(409);
      expect(await snapshot(inv.id)).toBe(before);
    });

    it("N4 adding a banned product the invoice did not hold is REFUSED, nothing written", async () => {
      const s = await seed("n4");
      const inv = await createDraft(s, [line(s.ok, 2)]);
      await setFlag(s, true);
      const [held] = await rows(inv.id);
      const before = await snapshot(inv.id);
      await expect(
        run(s, () =>
          invoicesService.update(inv.id, {
            items: [line(s.ok, 2, { id: held.id }), line(s.banned, 1)],
          } as any),
        ),
      ).rejects.toMatchObject(REFUSED);
      expect(await snapshot(inv.id)).toBe(before);
    });

    it("N5 splitting a held banned 5 into two lines of 3 + 3 (net +1) is REFUSED — netted per product", async () => {
      const s = await seed("n5");
      const inv = await createDraft(s, [line(s.banned, 5)]);
      await setFlag(s, true);
      const [held] = await rows(inv.id);
      const before = await snapshot(inv.id);
      await expect(
        run(s, () =>
          invoicesService.update(inv.id, {
            items: [line(s.banned, 3, { id: held.id }), line(s.banned, 3)],
          } as any),
        ),
      ).rejects.toMatchObject(REFUSED);
      expect(await snapshot(inv.id)).toBe(before);
    });

    it("N6 the same edit on an UNBANNED product is ALLOWED (5 -> 50)", async () => {
      const s = await seed("n6");
      const inv = await createDraft(s, [line(s.ok, 5)]);
      await setFlag(s, true);
      const [held] = await rows(inv.id);
      await run(s, () =>
        invoicesService.update(inv.id, { items: [line(s.ok, 50, { id: held.id })] } as any),
      );
      expect(Number((await rows(inv.id))[0].qty)).toBe(50);
    });
  });

  describe("update(): split rows (SA-250 / SA-377)", () => {
    it("D1 no-split DECREASE on a held split row (2 boxes + 3 pcs = 27 -> qty 20, no split) is ALLOWED", async () => {
      const s = await seed("d1");
      const inv = await createDraft(s, [line(s.boxed, 27, { boxes: 2, pieces: 3 })]);
      await setFlag(s, true);
      const [held] = await rows(inv.id);
      expect([held.boxes, held.pieces, held.unitsPerBox]).toEqual([2, 3, 12]);
      await run(s, () =>
        invoicesService.update(inv.id, { items: [line(s.boxed, 20, { id: held.id })] } as any),
      );
      const [after] = await rows(inv.id);
      // #2225: exactly what was sent was written (a bare `<= 27` also passed when nothing was):
      // qty 20, billing 20 pieces.
      expect(Number(after.qty)).toBe(20);
      expect(Number(after.boxes ?? 0) * 12 + Number(after.pieces ?? 0) || Number(after.qty)).toBe(
        20,
      );
    });

    // #2225: a line that names a held row's id but a DIFFERENT held product is not that row's
    // line (heldMatch requires the same product, invoice-restriction-lines.ts): it counts at the
    // target product's LIVE pack. Built to discriminate — the target (loose, banned) has no pack:
    // live pack ⇒ 20 + 5 = 25 ≤ 30 held ⇒ ALLOWED; a bug that matched by id alone would reuse the
    // held row's pack, 20 + 5×12 = 80 ⇒ REFUSED.
    // SA-465a: the held boxed row must carry a STORED pack of 12 and NO split. create() stores
    // unitsPerBox NULL for an unsplit line, which fell back to live either way (not
    // discriminating). A box-split row would not discriminate either: the id-only bug then takes
    // SA-250's re-split branch and counts qty 5. So the pack is stored on the unsplit row directly.
    it("S1 swapping a held boxed row's id onto another HELD product counts at the target's LIVE pack (ALLOWED)", async () => {
      const s = await seed("s1");
      const inv = await createDraft(s, [line(s.banned, 30), line(s.boxed, 2)]);
      await setFlag(s, true);
      const created = await rows(inv.id);
      await prisma.invoiceItem.update({
        where: { id: created.find((r: any) => r.productId === s.boxed)!.id },
        data: { unitsPerBox: 12 },
      });
      const held = await rows(inv.id);
      const loose = held.find((r: any) => r.productId === s.banned)!;
      const boxedRow = held.find((r: any) => r.productId === s.boxed)!;
      // The premise that makes S1 discriminate: a stored pack of 12 on an unsplit row.
      expect(boxedRow.unitsPerBox).toBe(12);
      expect(boxedRow.boxes ?? null).toBeNull();
      expect(boxedRow.pieces ?? null).toBeNull();
      await run(s, () =>
        invoicesService.update(inv.id, {
          items: [line(s.banned, 20, { id: loose.id }), line(s.banned, 5, { id: boxedRow.id })],
        } as any),
      );
      const after = await rows(inv.id);
      expect(after.every((r: any) => r.productId === s.banned)).toBe(true);
      expect(after.map((r: any) => Number(r.qty)).sort((a: number, b: number) => a - b)).toEqual([
        5, 20,
      ]);
    });

    it("D2 no-split INCREASE on the same held split row (27 -> qty 30) is REFUSED, nothing written", async () => {
      const s = await seed("d2");
      const inv = await createDraft(s, [line(s.boxed, 27, { boxes: 2, pieces: 3 })]);
      await setFlag(s, true);
      const [held] = await rows(inv.id);
      const before = await snapshot(inv.id);
      await expect(
        run(s, () =>
          invoicesService.update(inv.id, { items: [line(s.boxed, 30, { id: held.id })] } as any),
        ),
      ).rejects.toMatchObject(REFUSED);
      expect(await snapshot(inv.id)).toBe(before);
    });

    it("SA-377 pin (i): held split row on a REPACKED banned product (pack 12 -> 24) — a notes-only save SUCCEEDS", async () => {
      const s = await seed("pin-i");
      const inv = await createDraft(s, [line(s.boxed, 27, { boxes: 2, pieces: 3 })]);
      await prisma.product.update({ where: { id: s.boxed }, data: { unitsPerBox: 24 } });
      await setFlag(s, true);
      const [held] = await rows(inv.id);
      expect(held.unitsPerBox).toBe(12);
      const before = await snapshot(inv.id);
      await run(s, () =>
        invoicesService.update(inv.id, {
          notes: "notes-only save",
          items: [line(s.boxed, 27, { id: held.id, boxes: 2, pieces: 3 })],
        } as any),
      );
      expect(await snapshot(inv.id)).toBe(before);
      expect((await prisma.invoice.findUnique({ where: { id: inv.id } }))!.notes).toBe(
        "notes-only save",
      );
    });
  });

  describe("duplicate(): a copy is a new sale of every catalog line", () => {
    it("C1 flag ON: duplicating an invoice holding a banned line is REFUSED, no copy written", async () => {
      const s = await seed("c1");
      const inv = await createDraft(s, [line(s.ok, 1), line(s.banned, 1)]);
      await setFlag(s, true);
      await expect(run(s, () => invoicesService.duplicate(inv.id))).rejects.toMatchObject(REFUSED);
      expect(await prisma.invoice.count({ where: { tenantId: s.tenantId } })).toBe(1);
    });

    it("C2 flag ON: duplicating an invoice with only unbanned lines is ALLOWED", async () => {
      const s = await seed("c2");
      const inv = await createDraft(s, [line(s.ok, 1)]);
      await setFlag(s, true);
      const copy: any = await run(s, () => invoicesService.duplicate(inv.id));
      expect(copy.id).toBeDefined();
      expect(await prisma.invoice.count({ where: { tenantId: s.tenantId } })).toBe(2);
    });

    it("C3 flag OFF: duplicating the banned invoice is ALLOWED", async () => {
      const s = await seed("c3");
      const inv = await createDraft(s, [line(s.banned, 1)]);
      const copy: any = await run(s, () => invoicesService.duplicate(inv.id));
      expect(copy.id).toBeDefined();
    });
  });
});
