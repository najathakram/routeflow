import { Test } from "@nestjs/testing";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { AuditService } from "../audit/audit.service";

/**
 * A parent from another tenant is ignored on the movements list and the stock-count lines (B1211 read
 * rule, SA-1216 round 2): the row keeps the bare variant name, and the other tenant's family name never
 * reaches the caller. A parent of the caller's own tenant still shows.
 */
describe("InventoryService: a parent from another tenant is ignored (movements, stock counts)", () => {
  let service: InventoryService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const variant = (parent: { name: string; tenantId: string } | null) => ({
    id: "prod-v",
    name: "Blueberry",
    sku: "ACME-BB",
    unit: "each",
    variantName: "Blueberry",
    parentProductId: parent ? "prod-parent" : null,
    parent,
  });

  beforeEach(async () => {
    prisma = createMockPrisma(); // getTenantId() -> "test-tenant"
    const module = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        { provide: StockAlertService, useValue: { fireForProducts: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    service = module.get(InventoryService);
  });

  describe("movements list", () => {
    const run = async (parent: { name: string; tenantId: string } | null) => {
      prisma.stockMovement.findMany.mockResolvedValue([{ id: "m1", product: variant(parent) }]);
      prisma.stockMovement.count.mockResolvedValue(1);
      return service.listMovements({} as any);
    };

    it("selects the parent's tenantId so the read can be checked", async () => {
      await run(null);
      const include = prisma.stockMovement.findMany.mock.calls[0][0].include;
      expect(include.product.select.parent).toEqual({ select: { name: true, tenantId: true } });
    });

    it("does not show a parent from another tenant, and never returns its tenantId", async () => {
      const res = await run({ name: "Acme Other Parent", tenantId: "other-tenant" });
      expect(res.data[0].product.parent).toBeNull();
      expect(JSON.stringify(res)).not.toContain("Acme Other Parent");
      expect(res.data[0].product.name).toBe("Blueberry");
    });

    it("still shows the parent of the caller's own tenant, without its tenantId", async () => {
      const res = await run({ name: "Acme Cola", tenantId: "test-tenant" });
      expect(res.data[0].product.parent).toEqual({ name: "Acme Cola" });
    });
  });

  describe("stock-count session lines", () => {
    const run = async (parent: { name: string; tenantId: string } | null) => {
      prisma.stockCountSession.findUnique.mockResolvedValue({
        id: "sess-1",
        status: "COMMITTED",
        startedAt: new Date("2026-11-01T00:00:00Z"),
        lines: [{ id: "l1", productId: "prod-v", product: variant(parent) }],
      });
      return service.getStockCountSession("sess-1");
    };

    it("does not show a parent from another tenant", async () => {
      const res: any = await run({ name: "Acme Other Parent", tenantId: "other-tenant" });
      expect(res.lines[0].product.parent).toBeNull();
      expect(JSON.stringify(res)).not.toContain("Acme Other Parent");
    });

    it("still shows the parent of the caller's own tenant", async () => {
      const res: any = await run({ name: "Acme Cola", tenantId: "test-tenant" });
      expect(res.lines[0].product.parent).toEqual({ name: "Acme Cola" });
    });
  });
});
