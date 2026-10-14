/**
 * Row 510 — real-Postgres proof of the staff restriction warning and override on the INVOICE side, through the real
 * InvoicesService and EstimatesService with the REAL SellingRestrictionsService:
 *
 *   manual create   warning -> resubmit with the hash -> stamped + ONE in-tx audit row; a system caller (no actor) and a
 *                   SUPER_ADMIN cannot override.
 *   draft edit      kept lines keep their stamp (a qty raise does not warn); a RECREATED line (no id, same product) is
 *                   re-stamped from the held coverage; a product swap on a kept row clears the stamp and re-warns.
 *   duplicate       a copy is a new sale: the source stamp is NOT copied, the copy warns again, then stamps.
 *   estimate        converting an ACCEPTED estimate warns, then stamps the invoice line.
 *   order -> invoice  the order line's stamp rides the invoice line (C1, no warning); and back (C17).
 *   staff reads     an OPERATOR reading the invoice sees the overriding user's real name; a deleted user reads null;
 *                   a buyer's read never carries it.
 *
 * No `selling_restrictions.enabled` row exists for the tenant: the switch is gone. Collected only by
 * jest.db.config.js. One throwaway `qa-r510-<run>` tenant (assertTestTenant), purged in afterAll.
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
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
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import {
  purgeOverrideWorld,
  seedOverrideWorld,
  setStoreState,
  staffPayload,
  type OverrideWorld,
} from "../../test/restriction-override-fixture";

const RUN = randomUUID().slice(0, 8);
const REASON = "Licensed buyer, paperwork on file";

describeDb(
  "row 510: a staff invoice of a restricted product warns and takes an override — real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let dbPrisma: PrismaService;
    let tenantCtx: TenantContextService;
    let invoices: InvoicesService;
    let estimates: EstimatesService;
    let w: OverrideWorld;
    let seq = 0;

    const as = <T>(fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);
    const staff = (role: "OPERATOR" | "TENANT_ADMIN" | "SUPER_ADMIN" = "OPERATOR") =>
      staffPayload(w, role);
    const errOf = async (p: Promise<unknown>): Promise<any> => {
      try {
        await p;
      } catch (e) {
        return e;
      }
      throw new Error("expected a rejection");
    };
    const bodyOf = (e: any) => e.getResponse() as any;
    const ackFrom = (e: any, reason = REASON) => ({
      warningHash: bodyOf(e).warningHash as string,
      restrictionOverrides: (bodyOf(e).lines as Array<{ lineKey: string }>).map((l) => ({
        lineKey: l.lineKey,
        reason,
      })),
    });
    const itemRows = (invoiceId: string) =>
      raw.invoiceItem.findMany({ where: { invoiceId }, orderBy: { createdAt: "asc" } });
    const audits = (documentId: string) =>
      raw.auditLog.findMany({
        where: {
          tenantId: w.tenantId,
          action: "selling_restriction.overridden",
          meta: { path: ["documentId"], equals: documentId },
        },
      });
    const STAMPED = () => ({
      restrictionOverrideReason: "earlier reason",
      restrictionOverrideBy: w.operatorId,
      restrictionOverrideAt: new Date("2026-10-01T00:00:00Z"),
      restrictionOverrideRuleIds: [`${w.ruleId}:CA`],
    });

    async function seedInvoice(
      lines: Array<{ productId: string; qty?: number; stamped?: boolean }>,
      over: { status?: string; orderId?: string; customerId?: string } = {},
    ) {
      seq += 1;
      const invoice = await raw.invoice.create({
        data: {
          tenantId: w.tenantId,
          customerId: over.customerId ?? w.caCustomerId,
          invoiceNumber: `INV-R510-${RUN}-${seq}`,
          status: (over.status ?? "DRAFT") as never,
          orderId: over.orderId ?? null,
          subtotal: 0,
          taxAmount: 0,
          total: 0,
          items: {
            create: lines.map((l) => ({
              tenantId: w.tenantId,
              productId: l.productId,
              description: `line ${l.productId}`,
              qty: l.qty ?? 2,
              unitPrice: 10,
              discount: 0,
              taxRate: 0,
              subtotal: (l.qty ?? 2) * 10,
              ...(l.stamped ? STAMPED() : {}),
            })),
          },
        },
        include: { items: { orderBy: { createdAt: "asc" } } },
      });
      return { invoiceId: invoice.id, items: invoice.items };
    }

    beforeAll(async () => {
      const url = requireLocalDatabaseUrl();
      pool = new Pool({ connectionString: url });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      dbPrisma = new PrismaService(tenantCtx);
      await dbPrisma.$connect();
      const mod = await Test.createTestingModule({
        providers: [
          InvoicesService,
          EstimatesService,
          NumberingService,
          SellingRestrictionsService,
          ProductLabelsService,
          { provide: PrismaService, useValue: dbPrisma },
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
              sendInvoice: jest.fn(),
              isEmailConfigured: jest.fn().mockResolvedValue(true),
            },
          },
          { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
          {
            provide: SystemConfigService,
            useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
          },
          RegulatedLedgerService,
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
              autoApplyOldestCreditsInTx: jest
                .fn()
                .mockResolvedValue({ applied: 0, invoiceStatus: null }),
              settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
              releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
            },
          },
          {
            provide: MessagingService,
            useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
          },
          {
            provide: StorageService,
            useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
          },
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
          },
          entitlementAuthorityFromEntitlements,
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
      invoices = mod.get(InvoicesService);
      estimates = mod.get(EstimatesService);
      w = await seedOverrideWorld(raw, RUN, "restriction-override.invoices.db.spec.ts");
    }, 120_000);

    afterAll(async () => {
      if (w?.tenantId) await purgeOverrideWorld(pool, w.tenantId);
      await dbPrisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it("setup: the tenant has no selling_restrictions.enabled row and is judged all the same", async () => {
      expect(await raw.systemConfig.count({ where: { tenantId: w.tenantId } })).toBe(0);
    });

    describe("manual create", () => {
      const dto = (over: Record<string, unknown> = {}) => ({
        customerId: w.caCustomerId,
        items: [
          { description: "Gummies", productId: w.banned, qty: 2, unitPrice: 10 },
          { description: "Water", productId: w.clean, qty: 1, unitPrice: 2 },
        ],
        ...over,
      });
      const create = (d: object, actor: unknown = staff()) =>
        as(() => invoices.create(d as never, actor as never));

      it("warning -> resubmit with the hash -> stamped with reason, by and at, plus ONE audit row; the warning wrote nothing", async () => {
        const before = await raw.invoice.count({ where: { tenantId: w.tenantId } });
        const e = await errOf(create(dto()));
        expect(bodyOf(e)).toMatchObject({
          code: "RESTRICTION_WARNING",
          lines: [
            {
              lineKey: "n:0",
              productId: w.banned,
              rules: [
                expect.objectContaining({ reasonText: "This product is banned in CA by law." }),
              ],
            },
          ],
        });
        expect(await raw.invoice.count({ where: { tenantId: w.tenantId } })).toBe(before);
        const inv: any = await create({ ...dto(), ...ackFrom(e) });
        const rows = await itemRows(inv.id);
        const banned = rows.find((r) => r.productId === w.banned)!;
        expect(banned).toMatchObject({
          restrictionOverrideReason: REASON,
          restrictionOverrideBy: w.operatorId,
          restrictionOverrideRuleIds: [`${w.ruleId}:CA`],
        });
        expect(banned.restrictionOverrideAt).toBeInstanceOf(Date);
        expect(rows.find((r) => r.productId === w.clean)!.restrictionOverrideAt).toBeNull();
        const a = await audits(inv.id);
        expect(a).toHaveLength(1);
        expect(a[0]).toMatchObject({
          entityType: "InvoiceItem",
          entityId: banned.id,
          meta: expect.objectContaining({
            documentType: "INVOICE",
            reason: REASON,
            basis: "CUSTOMER",
          }),
        });
      });

      it("a reason that is too short is a 400; a system caller (no actor) and a SUPER_ADMIN get the ordinary staff 409", async () => {
        const e = await errOf(create(dto()));
        expect((await errOf(create({ ...dto(), ...ackFrom(e, "no") }))).getStatus()).toBe(400);
        for (const actor of [null, staff("SUPER_ADMIN")]) {
          const hard = await errOf(create({ ...dto(), ...ackFrom(e) }, actor));
          expect(bodyOf(hard).code).toBe("SELLING_RESTRICTED");
        }
      });
    });

    describe("draft edit", () => {
      const edit = (invoiceId: string, items: object[], ack: object = {}) =>
        as(() => invoices.update(invoiceId, { items, ...ack } as never, staff()));
      const row = (id: string, productId: string, qty: number) => ({
        id,
        description: "x",
        productId,
        qty,
        unitPrice: 10,
      });

      it("a qty raise on a KEPT stamped line keeps the stamp and does not warn", async () => {
        const { invoiceId, items } = await seedInvoice([
          { productId: w.banned, qty: 2, stamped: true },
        ]);
        await edit(invoiceId, [row(items[0].id, w.banned, 9)]);
        const [r] = await itemRows(invoiceId);
        expect(Number(r.qty)).toBe(9);
        expect(r).toMatchObject({
          id: items[0].id,
          restrictionOverrideReason: "earlier reason",
          restrictionOverrideBy: w.operatorId,
        });
        expect(await audits(invoiceId)).toHaveLength(0);
      });

      it("a RECREATED line (no id, same product) is re-stamped from the held coverage, no warning", async () => {
        const { invoiceId, items } = await seedInvoice([
          { productId: w.banned, qty: 2, stamped: true },
        ]);
        await edit(invoiceId, [{ description: "x", productId: w.banned, qty: 7, unitPrice: 10 }]);
        const rows = await itemRows(invoiceId);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).not.toBe(items[0].id);
        expect(rows[0]).toMatchObject({
          restrictionOverrideReason: "earlier reason",
          restrictionOverrideBy: w.operatorId,
        });
      });

      it("a product swap on a KEPT row clears the stamp (clean target) or re-warns (restricted target) and then stamps", async () => {
        const a = await seedInvoice([{ productId: w.banned, qty: 2, stamped: true }]);
        await edit(a.invoiceId, [row(a.items[0].id, w.clean, 2)]);
        const [cleared] = await itemRows(a.invoiceId);
        expect(cleared).toMatchObject({
          productId: w.clean,
          restrictionOverrideAt: null,
          restrictionOverrideRuleIds: [],
        });

        const b = await seedInvoice([{ productId: w.banned, qty: 2, stamped: true }]);
        const e = await errOf(edit(b.invoiceId, [row(b.items[0].id, w.banned2, 2)]));
        expect(bodyOf(e).lines[0]).toMatchObject({
          lineKey: `l:${b.items[0].id}`,
          productId: w.banned2,
        });
        expect((await itemRows(b.invoiceId))[0].productId).toBe(w.banned); // nothing written
        await edit(b.invoiceId, [row(b.items[0].id, w.banned2, 2)], ackFrom(e, "swap reason"));
        expect((await itemRows(b.invoiceId))[0]).toMatchObject({
          productId: w.banned2,
          restrictionOverrideReason: "swap reason",
        });
        expect(await audits(b.invoiceId)).toHaveLength(1);
      });

      it("an added restricted line warns (keyed n:<index>) and stamps on the acknowledged resubmit", async () => {
        const { invoiceId, items } = await seedInvoice([{ productId: w.clean, qty: 1 }]);
        const lines = [
          row(items[0].id, w.clean, 1),
          { description: "new", productId: w.banned, qty: 1, unitPrice: 10 },
        ];
        const e = await errOf(edit(invoiceId, lines));
        expect(bodyOf(e).lines[0].lineKey).toBe("n:1");
        await edit(invoiceId, lines, ackFrom(e));
        const rows = await itemRows(invoiceId);
        expect(rows.find((r) => r.productId === w.banned)).toMatchObject({
          restrictionOverrideReason: REASON,
        });
      });

      it("an edit of an invoice linked to a PICKUP order is judged at the STORE, like its order (a TX customer, a CA store)", async () => {
        await setStoreState(raw, w.tenantId, "CA");
        try {
          const order = await raw.order.create({
            data: {
              tenantId: w.tenantId,
              customerId: w.txCustomerId,
              status: "DELIVERED",
              fulfillPath: "PICKUP",
              source: "APP",
              subtotal: "10",
              total: "10",
              lineItems: {
                create: [
                  {
                    tenantId: w.tenantId,
                    productId: w.clean,
                    qty: "1",
                    unitPrice: "10.00",
                    subtotal: "10",
                    position: 0,
                    deliveredQty: "1",
                  },
                ],
              },
            },
            include: { lineItems: true },
          });
          const { invoiceId, items } = await seedInvoice([{ productId: w.clean, qty: 1 }], {
            orderId: order.id,
            customerId: w.txCustomerId,
          });
          await raw.invoiceItem.update({
            where: { id: items[0].id },
            data: { orderItemId: order.lineItems[0].id },
          });
          const e = await errOf(
            edit(invoiceId, [
              { ...row(items[0].id, w.clean, 1), orderItemId: order.lineItems[0].id },
              { description: "new", productId: w.banned, qty: 1, unitPrice: 10 },
            ]),
          );
          expect(bodyOf(e).code).toBe("RESTRICTION_WARNING");
          expect(bodyOf(e).lines[0].rules[0].reasonText).toBe(
            "This product is banned in CA by law.",
          );
          // the same edit on a ROUTE order for the same TX customer is NOT judged at the store
          await raw.order.update({ where: { id: order.id }, data: { fulfillPath: "ROUTE" } });
          let outcome: any = null;
          try {
            await edit(invoiceId, [
              { ...row(items[0].id, w.clean, 1), orderItemId: order.lineItems[0].id },
              { description: "new", productId: w.banned, qty: 1, unitPrice: 10 },
            ]);
          } catch (err) {
            outcome = err;
          }
          expect(outcome?.getResponse?.().code).not.toBe("RESTRICTION_WARNING");
        } finally {
          await setStoreState(raw, w.tenantId, null);
        }
      });

      it("the hash changed UNDER THE LOCK: a stamp that covered the product was cleared meanwhile -> 409 again, nothing written", async () => {
        const { invoiceId, items } = await seedInvoice([
          { productId: w.banned, qty: 2, stamped: true },
        ]);
        const restrictions = (invoices as any).sellingRestrictions as SellingRestrictionsService;
        const original = restrictions.assertLinesSellable.bind(restrictions);
        jest.spyOn(restrictions, "assertLinesSellable").mockImplementationOnce(async (p) => {
          const decision = await original(p);
          await raw.invoiceItem.update({
            where: { id: items[0].id },
            data: {
              restrictionOverrideReason: null,
              restrictionOverrideBy: null,
              restrictionOverrideAt: null,
              restrictionOverrideRuleIds: [],
            },
          });
          return decision;
        });
        try {
          const e = await errOf(edit(invoiceId, [row(items[0].id, w.banned, 9)]));
          expect(bodyOf(e).code).toBe("RESTRICTION_WARNING");
          expect(bodyOf(e).lines[0].lineKey).toBe(`l:${items[0].id}`);
          expect(Number((await itemRows(invoiceId))[0].qty)).toBe(2);
        } finally {
          jest.restoreAllMocks();
        }
      });
    });

    describe("duplicate", () => {
      it("a copy is a new sale: the source stamp is NOT copied, the copy warns again, then stamps", async () => {
        const { invoiceId } = await seedInvoice([{ productId: w.banned, qty: 2, stamped: true }], {
          status: "SENT",
        });
        const dup = (ack?: object) =>
          as(() => invoices.duplicate(invoiceId, staff(), ack as never));
        const e = await errOf(dup());
        expect(bodyOf(e).code).toBe("RESTRICTION_WARNING");
        expect(bodyOf(e).lines[0].lineKey).toMatch(/^l:/);
        const copy: any = await dup(ackFrom(e));
        const [r] = await itemRows(copy.id);
        expect(r).toMatchObject({
          restrictionOverrideReason: REASON,
          restrictionOverrideBy: w.operatorId,
        });
        expect(await audits(copy.id)).toHaveLength(1);
      });

      it("a copy of a clean invoice needs no acknowledgement and carries no stamp", async () => {
        const { invoiceId } = await seedInvoice([{ productId: w.clean }], { status: "SENT" });
        const copy: any = await as(() => invoices.duplicate(invoiceId, staff()));
        expect((await itemRows(copy.id))[0].restrictionOverrideAt).toBeNull();
      });
    });

    describe("estimate -> invoice", () => {
      it("converting an ACCEPTED estimate with a restricted line warns, then stamps the invoice line", async () => {
        const est: any = await as(() =>
          estimates.create({
            customerId: w.caCustomerId,
            items: [{ description: "Gummies", productId: w.banned, qty: 2, unitPrice: 10 }],
          } as never),
        );
        await raw.estimate.update({ where: { id: est.id }, data: { status: "ACCEPTED" } });
        const convert = (ack?: object) =>
          as(() => estimates.convertToInvoice(est.id, staff(), ack as never));
        const e = await errOf(convert());
        expect(bodyOf(e).code).toBe("RESTRICTION_WARNING");
        expect((await raw.estimate.findUniqueOrThrow({ where: { id: est.id } })).status).toBe(
          "ACCEPTED",
        );
        const inv: any = await convert(ackFrom(e));
        const [r] = await itemRows(inv.id);
        expect(r).toMatchObject({
          restrictionOverrideReason: REASON,
          restrictionOverrideBy: w.operatorId,
        });
        expect(await audits(inv.id)).toHaveLength(1);
      });
    });

    describe("order -> invoice carries the stamp, with no re-warning (C1) and back (C17)", () => {
      it("createInvoiceFromOrder copies the order line's stamp onto the invoice line", async () => {
        const order = await raw.order.create({
          data: {
            tenantId: w.tenantId,
            customerId: w.caCustomerId,
            status: "DELIVERED",
            source: "APP",
            subtotal: "20",
            total: "20",
            lineItems: {
              create: [
                {
                  tenantId: w.tenantId,
                  productId: w.banned,
                  qty: "2",
                  unitPrice: "10.00",
                  subtotal: "20",
                  deliveredQty: "2",
                  ...STAMPED(),
                },
              ],
            },
          },
        });
        const made: any = await as(() => invoices.createInvoiceFromOrder(order.id));
        const inv = Array.isArray(made) ? made[0] : made;
        const [r] = await itemRows(inv.id);
        expect(r).toMatchObject({
          restrictionOverrideReason: "earlier reason",
          restrictionOverrideBy: w.operatorId,
          restrictionOverrideRuleIds: [`${w.ruleId}:CA`],
        });
        expect(r.restrictionOverrideAt).toEqual(new Date("2026-10-01T00:00:00Z"));
        expect(await audits(inv.id)).toHaveLength(0); // a carried stamp writes no audit row
      });

      it("the back-sync creates an order line from an invoice line WITH its stamp", async () => {
        const order = await raw.order.create({
          data: {
            tenantId: w.tenantId,
            customerId: w.caCustomerId,
            status: "PENDING",
            source: "APP",
            subtotal: "10",
            total: "10",
            lineItems: {
              create: [
                {
                  tenantId: w.tenantId,
                  productId: w.clean,
                  qty: "1",
                  unitPrice: "10.00",
                  subtotal: "10",
                  position: 0,
                },
              ],
            },
          },
          include: { lineItems: true },
        });
        const inv = await raw.invoice.create({
          data: {
            tenantId: w.tenantId,
            customerId: w.caCustomerId,
            orderId: order.id,
            invoiceNumber: `INV-R510-${RUN}-bs`,
            status: "DRAFT",
            subtotal: 30,
            taxAmount: 0,
            total: 30,
            items: {
              create: [
                {
                  tenantId: w.tenantId,
                  productId: w.clean,
                  description: "Water",
                  qty: 1,
                  unitPrice: 10,
                  discount: 0,
                  taxRate: 0,
                  subtotal: 10,
                  orderItemId: order.lineItems[0].id,
                },
                {
                  tenantId: w.tenantId,
                  productId: w.banned,
                  description: "Gummies",
                  qty: 2,
                  unitPrice: 10,
                  discount: 0,
                  taxRate: 0,
                  subtotal: 20,
                  ...STAMPED(),
                },
              ],
            },
          },
        });
        expect(inv.id).toBeDefined();
        await as(() => invoices.recomputeOrderFromInvoices(order.id));
        const lines = await raw.orderItem.findMany({ where: { orderId: order.id } });
        const banned = lines.find((l) => l.productId === w.banned);
        expect(banned).toBeDefined();
        expect(banned).toMatchObject({
          restrictionOverrideReason: "earlier reason",
          restrictionOverrideBy: w.operatorId,
          restrictionOverrideRuleIds: [`${w.ruleId}:CA`],
        });
        expect(lines.find((l) => l.productId === w.clean)!.restrictionOverrideAt).toBeNull();
      });
    });

    describe("staff reads resolve the overriding user's name", () => {
      it("an OPERATOR sees the real name; a deleted or missing user reads null; a buyer's read never carries it", async () => {
        const gone = await raw.user.create({
          data: {
            email: `gone-${RUN}@example.test`,
            username: `gone-${RUN}`,
            role: "OPERATOR",
            tenantId: w.tenantId,
            deletedAt: new Date(),
          },
        });
        const { invoiceId, items } = await seedInvoice(
          [
            { productId: w.banned, stamped: true },
            { productId: w.banned2, stamped: true },
            { productId: w.clean, stamped: true },
          ],
          { status: "SENT" },
        );
        await raw.invoiceItem.update({
          where: { id: items[1].id },
          data: { restrictionOverrideBy: gone.id },
        });
        await raw.invoiceItem.update({
          where: { id: items[2].id },
          data: { restrictionOverrideBy: randomUUID() },
        });
        const read: any = await as(() => invoices.findOne(invoiceId, staff()));
        const byProduct = (p: string) => read.items.find((i: any) => i.productId === p);
        expect(byProduct(w.banned).restrictionOverrideByName).toBe(`op-${RUN}`);
        expect(byProduct(w.banned2).restrictionOverrideByName).toBeNull();
        expect(byProduct(w.clean).restrictionOverrideByName).toBeNull();

        const cust = await raw.customer.findUniqueOrThrow({ where: { id: w.caCustomerId } });
        const buyer = {
          sub: cust.userId,
          role: "CUSTOMER",
          tenantId: w.tenantId,
          tenantSlug: w.slug,
          status: "ACTIVE",
          forcePasswordChange: false,
          username: "b",
        };
        const buyerRead: any = await as(() => invoices.findOne(invoiceId, buyer as never));
        for (const i of buyerRead.items) {
          expect(Object.keys(i).filter((k) => k.startsWith("restrictionOverride"))).toEqual([]);
        }
      });
    });
  },
);
