/**
 * B983: ProductCategory (label category) names refuse a leading = + - @ TAB CR LF on create and rename (readable coded 400,
 * change-only on rename). The rename writes through a variable `data` + updateMany, which the writer scan cannot see, so this spec
 * is the pin for that write.
 */
import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ProductCategoriesService } from "./product-categories.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const user = { sub: "u1", username: "admin" } as JwtPayload;

describe("ProductCategoriesService name guards (B983)", () => {
  let service: ProductCategoriesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let cat: Record<string, jest.Mock>;

  const row = (over: Record<string, unknown> = {}) => ({
    id: "c1",
    name: "Alcohol",
    archivedAt: null,
    createdAt: new Date("2026-09-19T00:00:00Z"),
    _count: { labels: 0, sellingRestrictions: 0 },
    ...over,
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    cat = {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    (prisma.forTenant() as any).productCategory = cat;
    // Name writes run in a tx under the per-tenant names lock (label-writer): the same stub, plus the lock's raw calls.
    (prisma as any).tenantTransaction = jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        productCategory: cat,
        $queryRaw: jest.fn().mockResolvedValue([{ lock_timeout: "0" }]),
        $executeRaw: jest.fn().mockResolvedValue(0),
        $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      }),
    );
    const mod = await Test.createTestingModule({
      providers: [
        ProductCategoriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = mod.get(ProductCategoriesService);
  });

  const refused = async (p: Promise<unknown>) => {
    const err: any = await p.catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({
      code: "TEXT_CELL_FORMULA_LEAD",
      field: "categoryName",
    });
    expect(err.getResponse().message).toBe(
      "Category name can't start with =, +, -, @ or a tab/line break",
    );
  };

  it("create refuses a formula-led name before any write or audit", async () => {
    await refused(service.create({ name: "=HYPERLINK(1)" } as never, user));
    expect(cat.create).not.toHaveBeenCalled();
  });

  it("rename refuses a CHANGED formula-led name and writes nothing", async () => {
    cat.findFirst.mockResolvedValue(row());
    await refused(service.update("c1", { name: "@evil" } as never, user));
    expect(cat.updateMany).not.toHaveBeenCalled();
  });

  it("rename to an unchanged LEGACY formula-led name is not refused (archive still works)", async () => {
    cat.findFirst.mockResolvedValue(row({ name: "=LEGACY" }));
    await expect(
      service.update("c1", { name: "=LEGACY", archived: true } as never, user),
    ).resolves.toBeDefined();
    expect(cat.updateMany).toHaveBeenCalledTimes(1);
  });

  it("an archive that does not touch the name never checks it", async () => {
    cat.findFirst.mockResolvedValue(row({ name: "=LEGACY" }));
    await expect(service.update("c1", { archived: true } as never, user)).resolves.toBeDefined();
  });
});
