/**
 * Row 510 — real-Postgres proof of the staff restriction warning and override, THROUGH OrdersService with the REAL
 * SellingRestrictionsService (rules, labels, addresses and the store state all read from the database):
 *
 *   create        warning -> resubmit with the hash -> saved with reason / by / at / rule ids + ONE in-tx audit row;
 *                 a warning writes nothing; a short / long / formula-led reason is a 400; a DRIVER is hard-blocked;
 *                 a buyer keeps the hard 409; a PICKUP / counter sale is judged by the STORE, a delivery by the
 *                 customer's address; SUPER_ADMIN cannot override.
 *   edit          the hash changed under the lock -> 409 again with the fresh list (nothing written); sticky: a qty
 *                 raise keeps the stamp, a product swap clears it and re-warns, a new rule id re-warns, a replace-all
 *                 recreate carries it.
 *   promote       a draft with a pre-stamped line passes; an unstamped one warns and stamps.
 *   reopen        takes the Order lock first, warns, stamps.
 *   fulfil path   the switch warns at the path it switches TO; the stamp, the audit row and the path are ONE tx.
 *   merge         a fold carries the loser's stamp onto the winner's line.
 *   staff reads   an OPERATOR sees the overriding user's real name; a deleted user reads null; a buyer never gets it.
 *
 * The tenant has NO `selling_restrictions.enabled` row: the switch is gone, so it is judged all the same.
 * Collected only by jest.db.config.js (`RUN_DB_SPECS=local npx jest -c jest.db.config.js --runInBand <this file>`).
 * One throwaway `qa-r510-<run>` tenant approved by `assertTestTenant`, deleted in afterAll.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({
    createFromOrder: jest.fn().mockResolvedValue({ id: "inv-1" }),
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    reconcileOrderDraftInvoice: jest.fn().mockResolvedValue(null),
    resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([]),
    followPartialPrices: jest.fn().mockResolvedValue({ issuedPartialsUnchanged: [] }),
    projectEditedInvoiceTotals: jest.fn().mockResolvedValue([]),
    revertLinkedInvoicesForOrderEdit: jest.fn().mockResolvedValue([]),
    findOpenOrderDraft: jest.fn().mockResolvedValue(null),
    createInvoiceFromOrder: jest.fn().mockResolvedValue([{ id: "inv-1" }]),
    voidInvoiceInTx: jest.fn().mockResolvedValue({ id: "inv-1", status: "VOID" }),
  })),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({
    sendToCustomer: jest.fn().mockResolvedValue(undefined),
    sendToDriver: jest.fn().mockResolvedValue(undefined),
    sendToUser: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { randomUUID } from "crypto";
import { getQueueToken } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client, Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { OrdersService } from "./orders.service";
import { oversellReaderOffProvider } from "./testing/policy-reader-provider";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import {
  DRIVER_RESTRICTION_BLOCK_MESSAGE,
  SUPPORT_SESSION_RESTRICTION_BLOCK_MESSAGE,
} from "../selling-restrictions/override-constants";
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
  "row 510: a staff sale of a restricted product warns and takes an override — real Postgres",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let svc: OrdersService;
    let restrictions: SellingRestrictionsService;
    let dbPrisma: PrismaService;
    let tenantCtx: TenantContextService;
    let w: OverrideWorld;
    const url = () => requireLocalDatabaseUrl();

    const as = <T>(fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);
    const staff = (role: "OPERATOR" | "TENANT_ADMIN" | "DRIVER" | "SUPER_ADMIN" = "OPERATOR") =>
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
    const lineRows = (orderId: string) =>
      raw.orderItem.findMany({
        where: { orderId },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      });
    const audits = (orderId?: string) =>
      raw.auditLog.findMany({
        where: {
          tenantId: w.tenantId,
          action: "selling_restriction.overridden",
          ...(orderId ? { meta: { path: ["documentId"], equals: orderId } } : {}),
        },
      });
    const orderCount = (customerId: string) =>
      raw.order.count({ where: { tenantId: w.tenantId, customerId } });
    const STAMP_RULES = () => [`${w.ruleId}:CA`];

    /** An order written straight to the table: `lines` may carry a stamp. */
    async function seedOrder(
      customerId: string,
      lines: Array<{ productId: string; qty?: number; stamped?: boolean; status?: string }>,
      over: { status?: string; fulfillPath?: string } = {},
    ) {
      const order = await raw.order.create({
        data: {
          tenantId: w.tenantId,
          customerId,
          status: (over.status ?? "PENDING") as never,
          fulfillPath: (over.fulfillPath ?? "ROUTE") as never,
          source: "APP",
          subtotal: "0",
          total: "0",
          lineItems: {
            create: lines.map((l, i) => ({
              tenantId: w.tenantId,
              productId: l.productId,
              qty: String(l.qty ?? 2),
              unitPrice: "10.00",
              subtotal: String((l.qty ?? 2) * 10),
              status: (l.status ?? "PENDING") as never,
              position: i,
              ...(l.stamped
                ? {
                    restrictionOverrideReason: "earlier reason",
                    restrictionOverrideBy: w.operatorId,
                    restrictionOverrideAt: new Date("2026-10-01T00:00:00Z"),
                    restrictionOverrideRuleIds: STAMP_RULES(),
                  }
                : {}),
            })),
          },
        },
        include: { lineItems: true },
      });
      return {
        orderId: order.id,
        lines: order.lineItems.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
      };
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: url() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      dbPrisma = new PrismaService(tenantCtx);
      await dbPrisma.$connect();
      const module = await Test.createTestingModule({
        providers: [
          oversellReaderOffProvider,
          OrdersService,
          SellingRestrictionsService,
          ProductLabelsService,
          { provide: TenantContextService, useValue: tenantCtx },
          { provide: PrismaService, useValue: dbPrisma },
          { provide: getQueueToken("invoices"), useValue: { add: jest.fn() } },
          {
            provide: RouteFlowGateway,
            useValue: {
              emitStopCompleted: jest.fn(),
              emitOrderCreated: jest.fn(),
              emitUrgentOrder: jest.fn(),
              emitOrderStatusChanged: jest.fn(),
              emitLowStock: jest.fn(),
            },
          },
          { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(0.1) } },
          { provide: InvoicesService, useValue: new (InvoicesService as any)() },
          {
            provide: SystemConfigService,
            useValue: {
              get: jest.fn().mockResolvedValue(null),
              set: jest.fn().mockResolvedValue(undefined),
              getAll: jest.fn().mockResolvedValue({}),
            },
          },
          { provide: NotificationsService, useValue: new (NotificationsService as any)() },
          {
            provide: InventoryService,
            useValue: { recordSale: jest.fn().mockResolvedValue({ unitCost: 0, stockAfter: 0 }) },
          },
          {
            provide: AuthorizationGuardService,
            useValue: {
              assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
              checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
            },
          },
          {
            provide: PromotionsService,
            useValue: { activeForCatalog: jest.fn().mockResolvedValue([]) },
          },
          {
            provide: MessagingService,
            useValue: {
              notify: jest.fn().mockResolvedValue([]),
              notifyEvent: jest.fn().mockResolvedValue(undefined),
            },
          },
          {
            provide: CreditNotesService,
            useValue: {
              validateSelectionsForCustomer: jest.fn().mockResolvedValue(undefined),
              syncOrderCreditSelections: jest.fn().mockResolvedValue(undefined),
              settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
              releaseOrderCreditsInTx: jest.fn().mockResolvedValue([]),
              previewOrderCreditRelease: jest.fn().mockResolvedValue([]),
            },
          },
          {
            provide: CommissionEngineService,
            useValue: {
              syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
              syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
              removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
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
            useValue: { hasFlag: jest.fn().mockResolvedValue(true) },
          },
          {
            provide: RegulatedLedgerService,
            useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
          },
        ],
      }).compile();
      svc = module.get(OrdersService);
      restrictions = module.get(SellingRestrictionsService);
      w = await seedOverrideWorld(raw, RUN, "restriction-override.db.spec.ts");
      await setStoreState(raw, w.tenantId, null);
    }, 120_000);

    afterAll(async () => {
      if (w?.tenantId) await purgeOverrideWorld(pool, w.tenantId);
      await dbPrisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    afterEach(() => jest.restoreAllMocks());

    it("setup: the tenant has no selling_restrictions.enabled row, and is judged all the same", async () => {
      expect(await raw.systemConfig.count({ where: { tenantId: w.tenantId } })).toBe(0);
      const e = await errOf(
        as(() =>
          svc.create(
            { customerId: w.caCustomerId, items: [{ productId: w.banned, qty: 1 }] } as never,
            staff(),
          ),
        ),
      );
      expect(bodyOf(e).code).toBe("RESTRICTION_WARNING");
    });

    describe("create", () => {
      const dto = (over: Record<string, unknown> = {}) => ({
        customerId: w.caCustomerId,
        items: [
          { productId: w.banned, qty: 2 },
          { productId: w.clean, qty: 1 },
        ],
        ...over,
      });
      const create = (d: object, user = staff(), options: object = {}) =>
        as(() => svc.create(d as never, user, options));

      it("warning -> resubmit with the hash -> saved with reason, by and at, plus ONE audit row; a warning writes nothing", async () => {
        const before = await orderCount(w.caCustomerId);
        const e = await errOf(create(dto()));
        expect(e.getStatus()).toBe(409);
        expect(bodyOf(e)).toMatchObject({
          code: "RESTRICTION_WARNING",
          warningHash: expect.stringMatching(/^rw1:/),
          lines: [
            {
              lineKey: "n:0",
              productId: w.banned,
              outcome: "BLOCK",
              rules: [
                {
                  id: w.ruleId,
                  states: ["CA"],
                  legal: true,
                  reasonText: "This product is banned in CA by law.",
                },
              ],
            },
          ],
        });
        expect(await orderCount(w.caCustomerId)).toBe(before); // a warning writes nothing

        const order: any = await create(dto({ ...ackFrom(e) }));
        const rows = await lineRows(order.id);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
          productId: w.banned,
          restrictionOverrideReason: REASON,
          restrictionOverrideBy: w.operatorId,
          restrictionOverrideRuleIds: [`${w.ruleId}:CA`],
        });
        expect(rows[0].restrictionOverrideAt).toBeInstanceOf(Date);
        expect(rows[1]).toMatchObject({
          productId: w.clean,
          restrictionOverrideAt: null,
          restrictionOverrideRuleIds: [],
        });
        const a = await audits(order.id);
        expect(a).toHaveLength(1);
        expect(a[0]).toMatchObject({
          userId: w.operatorId,
          entityType: "OrderItem",
          entityId: rows[0].id,
          meta: expect.objectContaining({
            documentType: "ORDER",
            documentId: order.id,
            productId: w.banned,
            ruleIds: [`${w.ruleId}:CA`],
            reason: REASON,
            lineKey: "n:0",
            basis: "CUSTOMER",
          }),
        });
      });

      it("a stale hash is a 409 again with the fresh list; an override on a line that is not warned is ignored", async () => {
        const e = await errOf(create(dto()));
        const stale = await errOf(create(dto({ ...ackFrom(e), warningHash: "rw1:stale" })));
        expect(bodyOf(stale).code).toBe("RESTRICTION_WARNING");
        expect(bodyOf(stale).warningHash).toBe(bodyOf(e).warningHash);
        const ack = ackFrom(e);
        const order: any = await create(
          dto({
            ...ack,
            restrictionOverrides: [...ack.restrictionOverrides, { lineKey: "n:1", reason: "x" }],
          }),
        );
        const rows = await lineRows(order.id);
        expect(rows[1].restrictionOverrideAt).toBeNull(); // n:1 is the clean line: its override was ignored
      });

      it.each([
        ["too short", "ab"],
        ["too long", "z".repeat(201)],
        ["formula-led", "=HYPERLINK(1)"],
      ])("a reason that is %s is a 400 and nothing is written", async (_n, reason) => {
        const e = await errOf(create(dto()));
        const before = await orderCount(w.caCustomerId);
        const bad = await errOf(create(dto(ackFrom(e, reason))));
        expect(bad.getStatus()).toBe(400);
        expect(await orderCount(w.caCustomerId)).toBe(before);
      });

      it("a DRIVER is hard-blocked with 'Ask the office to approve this sale', even holding a valid acknowledgement", async () => {
        const e = await errOf(create(dto(), staff("DRIVER")));
        expect(e.getStatus()).toBe(409);
        expect(bodyOf(e)).toMatchObject({
          code: "SELLING_RESTRICTED",
          message: DRIVER_RESTRICTION_BLOCK_MESSAGE,
        });
        const warned = await errOf(create(dto()));
        const again = await errOf(create(dto(ackFrom(warned)), staff("DRIVER")));
        expect(bodyOf(again)).toMatchObject({
          code: "SELLING_RESTRICTED",
          message: DRIVER_RESTRICTION_BLOCK_MESSAGE,
        });
      });

      it("a TENANT_ADMIN may override, like an OPERATOR", async () => {
        const e = await errOf(create(dto(), staff("TENANT_ADMIN")));
        const order: any = await create(dto(ackFrom(e)), staff("TENANT_ADMIN"));
        expect((await lineRows(order.id))[0].restrictionOverrideBy).toBe(w.adminId);
      });

      it("a support session (a TENANT_ADMIN token carrying impersonatedBy) is hard-blocked with 'Ask the account admin': nothing created, nothing stamped, no audit row", async () => {
        const session = { ...staff("TENANT_ADMIN"), impersonatedBy: randomUUID() };
        const warned = await errOf(create(dto())); // an ordinary admin's warning, and its hash
        const before = await orderCount(w.caCustomerId);
        const auditsBefore = (await audits()).length;
        for (const body of [dto(), dto(ackFrom(warned))]) {
          const e = await errOf(create(body, session as never));
          expect(e.getStatus()).toBe(409);
          expect(bodyOf(e)).toMatchObject({
            code: "SELLING_RESTRICTED",
            message: SUPPORT_SESSION_RESTRICTION_BLOCK_MESSAGE,
            lines: [
              {
                lineKey: "n:0",
                productId: w.banned,
                rules: [expect.objectContaining({ id: w.ruleId, legal: true })],
              },
            ],
          });
          expect(bodyOf(e).warningHash).toBeUndefined();
        }
        expect(await orderCount(w.caCustomerId)).toBe(before);
        expect((await audits()).length).toBe(auditsBefore);
        expect(SUPPORT_SESSION_RESTRICTION_BLOCK_MESSAGE).toBe("Ask the account admin");
      });

      it("a BUYER keeps the hard 409 (never a warning) and nothing is stamped", async () => {
        const cust = await raw.customer.findUniqueOrThrow({ where: { id: w.caCustomerId } });
        const buyer = {
          sub: cust.userId,
          username: "buyer",
          role: "CUSTOMER",
          status: "ACTIVE",
          forcePasswordChange: false,
          tenantId: w.tenantId,
          tenantSlug: w.slug,
        };
        const before = await orderCount(w.caCustomerId);
        const e = await errOf(create({ items: [{ productId: w.banned, qty: 1 }] }, buyer as never));
        expect(e.getStatus()).toBe(409);
        expect(bodyOf(e).code).toBe("SELLING_RESTRICTED");
        expect(JSON.stringify(bodyOf(e))).not.toContain(w.ruleId); // the buyer body is redacted
        expect(await orderCount(w.caCustomerId)).toBe(before);
      });

      it("a PICKUP sale to a TX customer is judged by the STORE (CA): it warns; the same sale for delivery does not", async () => {
        await setStoreState(raw, w.tenantId, "CA");
        try {
          const items = [{ productId: w.banned, qty: 1 }];
          const pickup = await errOf(
            create({ customerId: w.txCustomerId, items }, staff(), { fulfillPath: "PICKUP" }),
          );
          expect(bodyOf(pickup).code).toBe("RESTRICTION_WARNING");
          expect(bodyOf(pickup).lines[0].rules[0].reasonText).toBe(
            "This product is banned in CA by law.",
          );
          const delivery: any = await create({ customerId: w.txCustomerId, items });
          expect((await lineRows(delivery.id))[0].restrictionOverrideAt).toBeNull(); // TX is allowed: no stamp
          // a counter sale to a NAMED customer is judged at the store too
          const counter = await errOf(
            create({ customerId: w.txCustomerId, items }, staff(), {
              counterSale: true,
              fulfillPath: "PICKUP",
            }),
          );
          expect(bodyOf(counter).code).toBe("RESTRICTION_WARNING");
          const a = await create(
            { customerId: w.txCustomerId, items, ...ackFrom(counter) },
            staff(),
            { counterSale: true, fulfillPath: "PICKUP" },
          );
          const stamped = await lineRows((a as any).id);
          expect(stamped[0].restrictionOverrideAt).toBeInstanceOf(Date);
          expect((await audits((a as any).id))[0].meta).toMatchObject({ basis: "STORE" });
        } finally {
          await setStoreState(raw, w.tenantId, null);
        }
      });

      it("a customer IN the banned state who picks up at a store elsewhere is not warned", async () => {
        await setStoreState(raw, w.tenantId, "TX");
        try {
          const order: any = await create(
            { customerId: w.caCustomerId, items: [{ productId: w.banned, qty: 1 }] },
            staff(),
            {
              fulfillPath: "PICKUP",
            },
          );
          expect((await lineRows(order.id))[0].restrictionOverrideAt).toBeNull();
        } finally {
          await setStoreState(raw, w.tenantId, null);
        }
      });
    });

    describe("edit (updateOrderItems)", () => {
      const edit = (orderId: string, body: object, user = staff()) =>
        as(() => svc.updateOrderItems(orderId, body as never, user));

      it("SUPER_ADMIN cannot override: the staff 409 for a newly added restricted line", async () => {
        const { orderId } = await seedOrder(w.caCustomerId, [{ productId: w.clean }]);
        const e = await errOf(
          edit(orderId, { items: [{ productId: w.banned, qty: 1 }] }, staff("SUPER_ADMIN")),
        );
        expect(bodyOf(e).code).toBe("SELLING_RESTRICTED");
        expect(await lineRows(orderId)).toHaveLength(1);
      });

      it("an added restricted line warns (keyed n:<index>), then stamps on the acknowledged resubmit", async () => {
        const { orderId } = await seedOrder(w.caCustomerId, [{ productId: w.clean }]);
        const body = { items: [{ productId: w.banned, qty: 1 }] };
        const e = await errOf(edit(orderId, body));
        expect(bodyOf(e).lines[0].lineKey).toBe("n:0");
        expect(await lineRows(orderId)).toHaveLength(1); // nothing written
        await edit(orderId, { ...body, ...ackFrom(e) });
        const rows = await lineRows(orderId);
        expect(rows.find((r) => r.productId === w.banned)).toMatchObject({
          restrictionOverrideReason: REASON,
        });
        expect(await audits(orderId)).toHaveLength(1);
      });

      it("the hash changed UNDER THE LOCK: a stamp that covered the product was cleared meanwhile -> 409 again with the fresh list, nothing written", async () => {
        const { orderId, lines } = await seedOrder(w.caCustomerId, [
          { productId: w.banned, qty: 2, stamped: true },
        ]);
        const original = restrictions.assertLinesSellable.bind(restrictions);
        jest.spyOn(restrictions, "assertLinesSellable").mockImplementationOnce(async (p) => {
          const decision = await original(p); // judged COVERED pre-lock
          await raw.orderItem.update({
            where: { id: lines[0].id },
            data: {
              restrictionOverrideReason: null,
              restrictionOverrideBy: null,
              restrictionOverrideAt: null,
              restrictionOverrideRuleIds: [],
            },
          }); // a concurrent edit cleared it before this tx took the lock
          return decision;
        });
        const e = await errOf(edit(orderId, { items: [{ id: lines[0].id, qty: 6 }] }));
        expect(bodyOf(e).code).toBe("RESTRICTION_WARNING");
        expect(bodyOf(e).lines.map((l: { lineKey: string }) => l.lineKey)).toEqual([
          `l:${lines[0].id}`,
        ]);
        expect(Number((await lineRows(orderId))[0].qty)).toBe(2); // the edit wrote nothing
        expect(await audits(orderId)).toHaveLength(0);
      });

      describe("sticky coverage", () => {
        it("a qty raise on a stamped line keeps the stamp and does not warn", async () => {
          const { orderId, lines } = await seedOrder(w.caCustomerId, [
            { productId: w.banned, qty: 2, stamped: true },
          ]);
          await edit(orderId, { items: [{ id: lines[0].id, qty: 7 }] });
          const [row] = await lineRows(orderId);
          expect(Number(row.qty)).toBe(7);
          expect(row).toMatchObject({
            restrictionOverrideReason: "earlier reason",
            restrictionOverrideBy: w.operatorId,
          });
          expect(await audits(orderId)).toHaveLength(0); // a carried stamp writes no audit row
        });

        it("a product swap CLEARS the stamp: to a clean product -> no warning, no stamp", async () => {
          const { orderId, lines } = await seedOrder(w.caCustomerId, [
            { productId: w.banned, qty: 2, stamped: true },
          ]);
          await edit(orderId, {
            items: [{ id: lines[0].id, substituteProductId: w.clean, qty: 2 }],
          });
          const [row] = await lineRows(orderId);
          expect(row.productId).toBe(w.clean);
          expect(row.restrictionOverrideAt).toBeNull();
          expect(row.restrictionOverrideRuleIds).toEqual([]);
        });

        it("a product swap to ANOTHER restricted product re-warns, then stamps the new product", async () => {
          const { orderId, lines } = await seedOrder(w.caCustomerId, [
            { productId: w.banned, qty: 2, stamped: true },
          ]);
          const body = { items: [{ id: lines[0].id, substituteProductId: w.banned2, qty: 2 }] };
          const e = await errOf(edit(orderId, body));
          expect(bodyOf(e).lines[0].productId).toBe(w.banned2);
          expect((await lineRows(orderId))[0].productId).toBe(w.banned); // nothing written
          await edit(orderId, { ...body, ...ackFrom(e, "second product reason") });
          const [row] = await lineRows(orderId);
          expect(row).toMatchObject({
            productId: w.banned2,
            restrictionOverrideReason: "second product reason",
          });
        });

        it("a NEW rule id on a covered product re-warns", async () => {
          const second = await raw.sellingRestriction.create({
            data: {
              tenantId: w.tenantId,
              categoryId: w.categoryId,
              jurisdiction: "STATE",
              states: ["CA"],
              reason: "R510 second ban",
              effectiveFrom: new Date("2026-02-01T00:00:00Z"),
            },
          });
          try {
            const { orderId, lines } = await seedOrder(w.caCustomerId, [
              { productId: w.banned, qty: 2, stamped: true },
            ]);
            const e = await errOf(edit(orderId, { items: [{ id: lines[0].id, qty: 3 }] }));
            expect(bodyOf(e).code).toBe("RESTRICTION_WARNING");
            expect(
              bodyOf(e)
                .lines[0].rules.map((r: { id: string }) => r.id)
                .sort(),
            ).toEqual([w.ruleId, second.id].sort());
            await edit(orderId, { items: [{ id: lines[0].id, qty: 3 }], ...ackFrom(e) });
            expect((await lineRows(orderId))[0].restrictionOverrideRuleIds.sort()).toEqual(
              [w.ruleId, second.id].map((id) => `${id}:CA`).sort(),
            );
          } finally {
            await raw.sellingRestriction.update({
              where: { id: second.id },
              data: { liftedAt: new Date() },
            });
          }
        });

        it("a replace-all RECREATE carries the stamp onto the new line (no warning)", async () => {
          const { orderId, lines } = await seedOrder(w.caCustomerId, [
            { productId: w.banned, qty: 2, stamped: true },
          ]);
          await edit(orderId, { replaceAll: true, items: [{ productId: w.banned, qty: 5 }] });
          const rows = await lineRows(orderId);
          expect(rows).toHaveLength(1);
          expect(rows[0].id).not.toBe(lines[0].id); // recreated
          expect(rows[0]).toMatchObject({
            restrictionOverrideReason: "earlier reason",
            restrictionOverrideBy: w.operatorId,
          });
          expect(await audits(orderId)).toHaveLength(0);
        });
      });
    });

    describe("promote (a DRAFT becomes a real sale)", () => {
      const promote = (orderId: string, body: object = {}) =>
        as(() => svc.changeStatus(orderId, { status: "PENDING", ...body } as never, staff()));

      it("a draft whose line is already stamped passes", async () => {
        const { orderId } = await seedOrder(
          w.caCustomerId,
          [{ productId: w.banned, stamped: true }],
          { status: "DRAFT" },
        );
        await promote(orderId);
        expect((await raw.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
          "PENDING",
        );
        expect(await audits(orderId)).toHaveLength(0);
      });

      it("an unstamped draft warns (keyed l:<lineId>), stays a draft, then promotes and stamps on the acknowledged resubmit", async () => {
        const { orderId, lines } = await seedOrder(w.caCustomerId, [{ productId: w.banned }], {
          status: "DRAFT",
        });
        const e = await errOf(promote(orderId));
        expect(bodyOf(e).lines[0].lineKey).toBe(`l:${lines[0].id}`);
        expect((await raw.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
          "DRAFT",
        );
        await promote(orderId, ackFrom(e));
        expect((await raw.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
          "PENDING",
        );
        expect((await lineRows(orderId))[0]).toMatchObject({ restrictionOverrideReason: REASON });
        expect(await audits(orderId)).toHaveLength(1);
      });
    });

    /**
     * Hold the Order row `FOR UPDATE` on a second connection, change the order's lines while holding it, run `action`
     * (which must be blocked behind the holder), then commit. Whatever the blocked write read BEFORE it got the lock is
     * stale; whatever it reads AFTER sees the holder's commit. Returns what `action` settled to.
     */
    async function withHolder<T>(
      orderId: string,
      whileHeld: (c: Client) => Promise<void>,
      action: () => Promise<T>,
    ) {
      const holder = new Client({ connectionString: url() });
      await holder.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(`SELECT id FROM "Order" WHERE id = $1 FOR UPDATE`, [orderId]);
        await whileHeld(holder);
        let settled = false;
        const pending = action().then(
          (v) => ({ ok: true as const, v }),
          (e) => ({ ok: false as const, e }),
        );
        void pending.then(() => (settled = true));
        await new Promise((r) => setTimeout(r, 600));
        const blocked = !settled;
        await holder.query("COMMIT");
        return { blocked, result: await pending };
      } finally {
        await holder.end().catch(() => undefined);
      }
    }
    const clearStamp = (c: Client, orderId: string) =>
      c
        .query(
          `UPDATE "OrderItem" SET "restrictionOverrideReason" = NULL, "restrictionOverrideBy" = NULL,
           "restrictionOverrideAt" = NULL, "restrictionOverrideRuleIds" = '{}' WHERE "orderId" = $1`,
          [orderId],
        )
        .then(() => undefined);

    describe("reopen", () => {
      it("warns on an unstamped line, writes nothing, then reopens and stamps on the acknowledged resubmit", async () => {
        const { orderId } = await seedOrder(
          w.caCustomerId,
          [{ productId: w.banned, status: "CANCELLED" }],
          { status: "CANCELLED" },
        );
        const reopen = (ack?: object) => as(() => svc.reopenOrder(orderId, staff(), ack as never));
        const e = await errOf(reopen());
        expect(bodyOf(e).code).toBe("RESTRICTION_WARNING");
        expect((await raw.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
          "CANCELLED",
        );
        await reopen(ackFrom(e));
        expect((await raw.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
          "PENDING",
        );
        expect((await lineRows(orderId))[0]).toMatchObject({
          status: "PENDING",
          restrictionOverrideReason: REASON,
        });
        expect(await audits(orderId)).toHaveLength(1);
      });

      it("takes the Order lock FIRST: a stamp cleared by the lock's holder is seen (the re-judge reads after the lock) -> 409, nothing written", async () => {
        const { orderId } = await seedOrder(
          w.caCustomerId,
          [{ productId: w.banned, stamped: true, status: "CANCELLED" }],
          { status: "CANCELLED" },
        );
        const { blocked, result } = await withHolder(
          orderId,
          (c) => clearStamp(c, orderId),
          () => as(() => svc.reopenOrder(orderId, staff())),
        );
        expect(blocked).toBe(true); // it waited behind the holder
        expect(result.ok).toBe(false);
        expect(bodyOf((result as { e: unknown }).e).code).toBe("RESTRICTION_WARNING");
        expect((await raw.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
          "CANCELLED",
        );
      }, 60_000);
    });

    describe("fulfil-path switch", () => {
      const sw = (orderId: string, fulfillPath: string, ack?: object, user = staff()) =>
        as(() => svc.updateFulfillPath(orderId, { fulfillPath, ...ack } as never, user));
      const pathOf = async (orderId: string) =>
        (await raw.order.findUniqueOrThrow({ where: { id: orderId } })).fulfillPath;

      it("ROUTE -> PICKUP is judged by the STORE state: a TX customer (allowed) at a CA store (banned) warns; the acknowledged switch stamps and switches in ONE tx", async () => {
        await setStoreState(raw, w.tenantId, "CA");
        try {
          const { orderId } = await seedOrder(w.txCustomerId, [{ productId: w.banned }]);
          const e = await errOf(sw(orderId, "PICKUP"));
          expect(bodyOf(e).code).toBe("RESTRICTION_WARNING");
          expect(await pathOf(orderId)).toBe("ROUTE");

          // atomicity: a failing audit insert rolls the PATH and the stamp back together
          const realTx = dbPrisma.tenantTransaction.bind(dbPrisma);
          jest.spyOn(dbPrisma, "tenantTransaction").mockImplementationOnce(((fn: any, opts: any) =>
            realTx(
              (tx: any) =>
                fn(
                  new Proxy(tx, {
                    get: (t, k) =>
                      k === "auditLog"
                        ? {
                            create: async () => {
                              throw new Error("audit down");
                            },
                          }
                        : t[k as never],
                  }),
                ),
              opts,
            )) as never);
          await expect(sw(orderId, "PICKUP", ackFrom(e))).rejects.toThrow("audit down");
          expect(await pathOf(orderId)).toBe("ROUTE");
          expect((await lineRows(orderId))[0].restrictionOverrideAt).toBeNull();

          await sw(orderId, "PICKUP", ackFrom(e));
          expect(await pathOf(orderId)).toBe("PICKUP");
          expect((await lineRows(orderId))[0]).toMatchObject({ restrictionOverrideReason: REASON });
          const a = await audits(orderId);
          expect(a).toHaveLength(1);
          expect(a[0].meta).toMatchObject({ basis: "STORE" });
        } finally {
          await setStoreState(raw, w.tenantId, null);
        }
      });

      it("PICKUP -> ROUTE for a CA customer is judged at the CUSTOMER's address and warns", async () => {
        await setStoreState(raw, w.tenantId, "TX");
        try {
          const { orderId } = await seedOrder(w.caCustomerId, [{ productId: w.banned }], {
            fulfillPath: "PICKUP",
          });
          const e = await errOf(sw(orderId, "ROUTE"));
          expect(bodyOf(e).code).toBe("RESTRICTION_WARNING");
          expect(await pathOf(orderId)).toBe("PICKUP");
        } finally {
          await setStoreState(raw, w.tenantId, null);
        }
      });

      it("an order of clean products switches with no warning and no stamp (no restriction in play)", async () => {
        await setStoreState(raw, w.tenantId, "CA");
        try {
          const { orderId } = await seedOrder(w.txCustomerId, [{ productId: w.clean }]);
          await sw(orderId, "PICKUP");
          expect(await pathOf(orderId)).toBe("PICKUP");
          expect(await audits(orderId)).toHaveLength(0);
        } finally {
          await setStoreState(raw, w.tenantId, null);
        }
      });

      it("takes the Order lock before it re-judges: a stamp cleared by the lock's holder is seen -> 409, the path is unchanged", async () => {
        await setStoreState(raw, w.tenantId, "CA");
        try {
          const { orderId } = await seedOrder(w.txCustomerId, [
            { productId: w.banned, stamped: true },
          ]);
          const { blocked, result } = await withHolder(
            orderId,
            (c) => clearStamp(c, orderId),
            () => sw(orderId, "PICKUP"),
          );
          expect(blocked).toBe(true);
          expect(result.ok).toBe(false);
          expect(bodyOf((result as { e: unknown }).e).code).toBe("RESTRICTION_WARNING");
          expect(await pathOf(orderId)).toBe("ROUTE");
        } finally {
          await setStoreState(raw, w.tenantId, null);
        }
      }, 60_000);

      it("a DRAFT is judged at its promotion, not at the switch", async () => {
        await setStoreState(raw, w.tenantId, "CA");
        try {
          const { orderId } = await seedOrder(w.txCustomerId, [{ productId: w.banned }], {
            status: "DRAFT",
          });
          await sw(orderId, "PICKUP");
          expect(await pathOf(orderId)).toBe("PICKUP");
        } finally {
          await setStoreState(raw, w.tenantId, null);
        }
      });
    });

    describe("merge carries the stamp", () => {
      it("a loser-only restricted line moves to the winner WITH its stamp; a fold onto an unstamped winner line stamps it", async () => {
        const cust = w.caCustomerId;
        const a = await seedOrder(cust, [
          { productId: w.clean },
          { productId: w.banned, stamped: true },
        ]);
        const b = await seedOrder(cust, [
          { productId: w.banned },
          { productId: w.banned2, stamped: true },
        ]);
        await as(() => svc.mergeAllPendingForCustomer(cust));
        const left = await raw.order.findMany({
          where: { tenantId: w.tenantId, customerId: cust, id: { in: [a.orderId, b.orderId] } },
        });
        expect(left).toHaveLength(1);
        const rows = await lineRows(left[0].id);
        for (const productId of [w.banned, w.banned2]) {
          const mine = rows.filter((r) => r.productId === productId);
          expect(mine.length).toBeGreaterThan(0);
          for (const r of mine) expect(r.restrictionOverrideAt).not.toBeNull();
        }
      }, 60_000);
    });

    describe("staff reads resolve the overriding user's name", () => {
      it("an OPERATOR sees the real name; a deleted user reads null; a buyer's read never carries it", async () => {
        const gone = await raw.user.create({
          data: {
            email: `gone-${RUN}@example.test`,
            username: `gone-${RUN}`,
            role: "OPERATOR",
            tenantId: w.tenantId,
            deletedAt: new Date(),
          },
        });
        const { orderId } = await seedOrder(w.caCustomerId, [
          { productId: w.banned, stamped: true },
          { productId: w.banned2, stamped: true },
        ]);
        const rows = await lineRows(orderId);
        await raw.orderItem.update({
          where: { id: rows[1].id },
          data: { restrictionOverrideBy: gone.id },
        });
        await raw.orderItem.create({
          data: {
            tenantId: w.tenantId,
            orderId,
            productId: w.clean,
            qty: "1",
            unitPrice: "1",
            subtotal: "1",
            position: 5,
            restrictionOverrideBy: randomUUID(), // a user that never existed
            restrictionOverrideAt: new Date(),
            restrictionOverrideReason: "orphan",
            restrictionOverrideRuleIds: [],
          },
        });
        const read: any = await as(() => svc.findOne(orderId, staff()));
        const byPos = (p: number) => read.lineItems.find((l: any) => l.position === p);
        expect(byPos(0).restrictionOverrideByName).toBe(`op-${RUN}`);
        expect(byPos(1).restrictionOverrideByName).toBeNull();
        expect(byPos(5).restrictionOverrideByName).toBeNull();

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
        const buyerRead: any = await as(() => svc.findOne(orderId, buyer as never));
        for (const l of buyerRead.lineItems)
          expect(l).not.toHaveProperty("restrictionOverrideByName");
      });
    });
  },
);
