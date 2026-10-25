/**
 * 681 (R5-5, SA-936 MUST 7) against real Postgres and two real tenants: tenant B's ids, sent as tenant A, are refused with
 * the same 404 as a missing id - the FK alone is NOT a tenant proof (a foreign id exists, so the FK is satisfied).
 *  - one case per kind PR A adds or relies on: customer, product, tracked category (the new row);
 *  - site 10: `recordStandalonePayment` with `allocations: []` and tenant B's customer writes NO AdvancePayment row;
 *  - the proof never reads archived state (an inactive product of the caller's own tenant still passes).
 * PR B adds the routeRunIds / routeRunStopIds cases and the legacy NULL-tenant run that 404s (those kinds do not exist yet).
 * Throwaway `qa-r681-*` tenants (approved test-tenant shape). Collected only by `jest.db.config.js`
 * (`npm run local:test:db`); `requireLocalDatabaseUrl()` refuses any non-local host.
 */
jest.mock("../invoices/invoice-pdf.service", () => ({
  InvoicePdfService: class InvoicePdfService {},
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { assertRefsInTenant } from "./assert-refs-in-tenant";
import { InvoicesService } from "../invoices/invoices.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

type World = { tenantId: string; customerId: string; productId: string; categoryId: string };

describeDb("681: cross-tenant refs are refused against real rows - real Postgres", () => {
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let invoices: InvoicesService;
  let a: World;
  let b: World;
  let inactiveProductId: string;
  const tenantIds: string[] = [];

  async function world(label: string): Promise<World> {
    const slug = assertTestTenant(`qa-r681-${RUN}-${label}`, "tenant-refs-cross-tenant.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `R681 ${slug}` } });
    tenantIds.push(tenant.id);
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
        businessName: `R681 customer ${label}`,
        contactName: `R681 contact ${label}`,
        tenantId: tenant.id,
      },
    });
    const product = await prisma.product.create({
      data: {
        tenantId: tenant.id,
        name: `R681 product ${label}`,
        sku: `R681-${RUN}-${label}`,
        unit: "box",
        pricePerUnit: 5,
      },
    });
    const category = await prisma.trackedCategory.create({
      data: { tenantId: tenant.id, name: `R681 category ${label}` },
    });
    return {
      tenantId: tenant.id,
      customerId: customer.id,
      productId: product.id,
      categoryId: category.id,
    };
  }

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    a = await world("a");
    b = await world("b");
    inactiveProductId = (
      await prisma.product.create({
        data: {
          tenantId: a.tenantId,
          name: "R681 inactive",
          sku: `R681-${RUN}-inactive`,
          unit: "box",
          pricePerUnit: 5,
          isActive: false,
        },
      })
    ).id;
    const module = await Test.createTestingModule({ providers: [InvoicesService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === EntitlementsService) return { hasFlag: jest.fn().mockResolvedValue(false) };
        if (token === SellingRestrictionsService) return { assertLinesSellable: jest.fn() };
        if (token === NumberingService) return { reserveNext: jest.fn() };
        return autoMock();
      })
      .compile();
    invoices = module.get(InvoicesService);
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        await prisma.advancePayment.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.trackedCategory.deleteMany({ where: { tenantId } });
        await prisma.customer.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`681 cleanup failed for ${tenantId}:`, e);
      });
    }
    await prisma.$disconnect();
  });

  const asA = <T>(fn: () => Promise<T>) => ctx.run(a.tenantId, fn);

  describe("the helper, one case per kind", () => {
    it("customer: own passes; tenant B's and a missing id are the same 404", async () => {
      await asA(() => assertRefsInTenant(prisma, { customerIds: [a.customerId] }));
      for (const id of [b.customerId, randomUUID()]) {
        await expect(asA(() => assertRefsInTenant(prisma, { customerIds: [id] }))).rejects.toThrow(
          NotFoundException,
        );
      }
    });

    it("product: own passes (archived or not); tenant B's and a missing id are the same 404", async () => {
      await asA(() => assertRefsInTenant(prisma, { productIds: [a.productId, inactiveProductId] }));
      for (const id of [b.productId, randomUUID()]) {
        await expect(asA(() => assertRefsInTenant(prisma, { productIds: [id] }))).rejects.toThrow(
          NotFoundException,
        );
      }
    });

    it("tracked category (the new row): own passes; tenant B's and a missing id are the same 404", async () => {
      await asA(() => assertRefsInTenant(prisma, { trackedCategoryIds: [a.categoryId] }));
      for (const id of [b.categoryId, randomUUID()]) {
        await expect(
          asA(() => assertRefsInTenant(prisma, { trackedCategoryIds: [id] })),
        ).rejects.toThrow("Tracked category not found");
      }
    });

    it("one foreign id among own ids fails the whole set", async () => {
      await expect(
        asA(() => assertRefsInTenant(prisma, { productIds: [a.productId, b.productId] })),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("site 10 - recordStandalonePayment (allocations: [])", () => {
    it("tenant B's customer writes no AdvancePayment row, in either tenant", async () => {
      await expect(
        asA(() =>
          invoices.recordStandalonePayment({
            customerId: b.customerId,
            totalAmount: 50,
            method: "CASH",
            allocations: [],
          } as never),
        ),
      ).rejects.toThrow(NotFoundException);
      expect(await prisma.advancePayment.count({ where: { customerId: b.customerId } })).toBe(0);
      expect(await prisma.advancePayment.count({ where: { tenantId: a.tenantId } })).toBe(0);
    });
  });
});
