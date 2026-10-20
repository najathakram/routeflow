/**
 * SA-802 / SA-828 DB specs - one InventoryService on a real PrismaService, throwaway `qa-sa802-*`
 * tenants (approved by `assertTestTenant`), and an FK-ordered cleanup of exactly what a run created.
 * Call `useStockDateWorld(spec)` INSIDE a `describeDb` callback; it registers its own hooks.
 */
import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InventoryService } from "../inventory.service";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { StockAlertService } from "../../stock-alerts/stock-alert.service";
import { AuditService } from "../../audit/audit.service";
import { requireLocalDatabaseUrl } from "../../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let seq = 0;

export interface World {
  tenantId: string;
  userId: string;
}

export function useStockDateWorld(spec: string) {
  const tenantIds: string[] = [];
  const h = {} as {
    prisma: PrismaService;
    tenantCtx: TenantContextService;
    inventory: InventoryService;
  };

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    h.tenantCtx = new TenantContextService();
    h.prisma = new PrismaService(h.tenantCtx);
    await h.prisma.$connect();
    const module = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: h.prisma },
        { provide: AuditService, useValue: new AuditService(h.prisma) },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
      ],
    }).compile();
    h.inventory = module.get(InventoryService);
  }, 120_000);

  afterAll(async () => {
    const p = h.prisma;
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        await p.auditLog.deleteMany({ where: { tenantId } });
        await p.stockCountLine.deleteMany({ where: { tenantId } });
        await p.stockCountSession.deleteMany({ where: { tenantId } });
        await p.stockLot.deleteMany({ where: { tenantId } });
        await p.stockMovement.deleteMany({ where: { tenantId } });
        await p.productUnit.deleteMany({ where: { tenantId } });
        await p.product.deleteMany({ where: { tenantId } });
        await p.regulatedFiling.deleteMany({ where: { tenantId } });
        await p.trackedCategory.deleteMany({ where: { tenantId } });
        await p.tobaccoReport.deleteMany({ where: { tenantId } });
        await p.user.deleteMany({ where: { tenantId } });
        await p.tenant.delete({ where: { id: tenantId } });
      })().catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`${spec} cleanup failed for tenant ${tenantId}:`, e);
      });
    }
    await p?.$disconnect();
  }, 120_000);

  async function newWorld(label: string): Promise<World> {
    seq += 1;
    const slug = assertTestTenant(`qa-sa802-${RUN_SUFFIX}-${seq}-${label}`, spec);
    const tenant = await h.prisma.tenant.create({ data: { slug, name: `SA-802 ${slug}` } });
    tenantIds.push(tenant.id);
    const user = await h.prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "OPERATOR",
        tenantId: tenant.id,
      },
    });
    return { tenantId: tenant.id, userId: user.id };
  }

  async function newProduct(
    w: World,
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const p = await h.prisma.product.create({
      data: {
        name,
        unit: "ea",
        pricePerUnit: 10,
        currentStock: 100,
        averageCost: 2,
        costingMethod: "AVCO",
        tenantId: w.tenantId,
        ...extra,
      } as any,
    });
    return p.id;
  }

  const inTenant = <T>(w: World, fn: () => Promise<T>) => h.tenantCtx.run(w.tenantId, fn);
  const stockOf = async (id: string) =>
    Number((await h.prisma.product.findUniqueOrThrow({ where: { id } })).currentStock);
  const movementsOf = (productId: string) =>
    h.prisma.stockMovement.findMany({ where: { productId }, orderBy: { createdAt: "asc" } });

  return Object.assign(h, { newWorld, newProduct, inTenant, stockOf, movementsOf });
}
