import { Test, TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { FeatureConfigService } from "../billing/feature-config.service";

/**
 * SA-584 B1 (#2717 M2 fold): with `mixed_packs` on, `assignToVariants` takes the FAMILY row lock
 * FIRST — before any variant row is written — so it can never hold a variant (V) while waiting for
 * the family (F) that a concurrent family price edit already holds while it waits for V
 * (V -> F against F -> V = 40P01). House order: family -> recipe product -> variant rows.
 * Mode `off` takes no lock at all (byte-for-byte today's behaviour).
 */
const D = (n: number | string) => new Prisma.Decimal(n);

const PARENT = {
  id: "parent-1",
  name: "Cola 24pk",
  unit: "case",
  parentProductId: null,
  currentStock: D(20),
  averageCost: D(4),
  standardCost: null,
  costingMethod: "AVCO",
  unitsPerBox: 12,
  pricePerUnit: D(30),
  priceTier2: D(28),
  priceTier3: D(26),
  priceTier4: D(24),
  priceTier5: D(22),
  category: "Beverages",
  isTobacco: false,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  regItemType: null,
  regUomCase: null,
  regUomUnit: null,
};
const EXISTING = {
  id: "variant-1",
  name: "Cola 24pk - Cherry",
  variantName: "Cherry",
  parentProductId: "parent-1",
  currentStock: D(0),
  averageCost: null,
  costingMethod: "AVCO",
};

async function run(mode: "on" | "off") {
  const prisma = createMockPrisma();
  const events: string[] = [];
  const tx: any = {
    ...prisma,
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const kind = /FOR UPDATE/i.test(strings.join("?")) ? "update" : "raw";
      events.push(`lock:${kind}:${String(values[0])}`);
      return [];
    }),
    $executeRaw: jest.fn().mockResolvedValue(0),
    product: {
      findUnique: jest.fn(async () => {
        events.push("read:parent");
        return PARENT;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.parentProductId && where.id) return EXISTING;
        if (where.name) return null;
        return {
          pricePerUnit: D(30),
          priceTier2: D(28),
          priceTier3: D(26),
          priceTier4: D(24),
          priceTier5: D(22),
        };
      }),
      create: jest.fn(async () => {
        events.push("write:create-variant");
        return { ...EXISTING, id: "variant-new", name: "Cola 24pk - Grape", variantName: "Grape" };
      }),
      update: jest.fn(async ({ where }: any) => {
        events.push(`write:product:${where.id}`);
        return {};
      }),
    },
  };
  prisma.tenantTransaction.mockImplementation(async (fn: any) => fn(tx));
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      InventoryService,
      { provide: PrismaService, useValue: prisma },
      {
        provide: StockAlertService,
        useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
      },
      {
        provide: FeatureConfigService,
        useValue: { getEffectiveMode: jest.fn().mockResolvedValue(mode) },
      },
    ],
  }).compile();
  const service = module.get(InventoryService);
  await service.assignToVariants(
    {
      parentProductId: "parent-1",
      assignments: [
        { productId: "variant-1", qty: 5 },
        { newVariant: { name: "Grape" }, qty: 5 },
      ],
    } as any,
    "user-1",
  );
  return events;
}

describe("assignToVariants lock order (SA-584 B1)", () => {
  it("mode on: the family row FOR UPDATE is the first statement, before any variant row is written", async () => {
    const events = await run("on");
    expect(events[0]).toBe("lock:update:parent-1");
    const firstWrite = events.findIndex((e) => e.startsWith("write:"));
    expect(firstWrite).toBeGreaterThan(0);
    // the lock precedes the existing variant's stock write AND the new variant's create
    expect(events.indexOf("lock:update:parent-1")).toBeLessThan(
      events.indexOf("write:product:variant-1"),
    );
    expect(events.indexOf("lock:update:parent-1")).toBeLessThan(
      events.indexOf("write:create-variant"),
    );
  });

  it("mode on: the parent read happens after the family lock (lock first, read after: L-239)", async () => {
    const events = await run("on");
    expect(events.indexOf("lock:update:parent-1")).toBeLessThan(events.indexOf("read:parent"));
  });

  it("mode off: no lock statement is issued at all", async () => {
    const events = await run("off");
    expect(events.filter((e) => e.startsWith("lock:"))).toEqual([]);
    expect(events).toContain("write:create-variant");
  });
});
