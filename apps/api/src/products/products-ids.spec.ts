import { readFileSync } from "fs";
import { join } from "path";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { createMockPrisma } from "../testing/prisma-mock";
import { ProductsController } from "./products.controller";
import { ProductsService } from "./products.service";
import { StockStatusFilter } from "./dto/list-products.dto";

/**
 * Row 509 PR2: GET /products/ids returns the ids of EVERY product the list filters match (the same where-clause as
 * GET /products), capped at 1,000 with `total` / `capped`, OPERATOR only, and declared before GET /products/:id.
 */
function service() {
  const prisma = createMockPrisma();
  const product = (prisma.forTenant() as any).product;
  const svc = Object.create(ProductsService.prototype) as ProductsService;
  Object.assign(svc, {
    prisma,
    storage: { presignedUrl: jest.fn() },
  });
  return { svc, product };
}

const FILTERS = {
  search: "pod",
  category: "Vapes",
  stockStatus: StockStatusFilter.LOW,
  portalVisible: false,
  section: "any",
  isActive: true,
  includeVariants: true,
};

describe("ProductsService.findIds", () => {
  it("uses the SAME where as the list for every filter, selects ids only and caps at 1,000", async () => {
    const { svc, product } = service();
    product.findMany.mockResolvedValue([]);
    product.count.mockResolvedValue(0);
    await svc.findAll(FILTERS as never);
    await svc.findIds(FILTERS as never);
    const listWhere = product.findMany.mock.calls[0][0].where;
    const idsCall = product.findMany.mock.calls[1][0];
    expect(idsCall.where).toEqual(listWhere);
    expect(product.count.mock.calls[1][0].where).toEqual(listWhere);
    expect(idsCall.select).toEqual({ id: true });
    expect(idsCall.take).toBe(1000);
    expect(idsCall.skip).toBeUndefined();
  });

  it("reports total and capped", async () => {
    const { svc, product } = service();
    product.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    product.count.mockResolvedValue(2);
    expect(await svc.findIds({} as never)).toEqual({ ids: ["a", "b"], total: 2, capped: false });
    product.count.mockResolvedValue(1500);
    expect(await svc.findIds({} as never)).toEqual({ ids: ["a", "b"], total: 1500, capped: true });
    product.count.mockResolvedValue(1000);
    expect((await svc.findIds({} as never)).capped).toBe(false);
  });
});

describe("GET /products/ids route", () => {
  const proto = ProductsController.prototype as unknown as Record<string, object>;

  it("is OPERATOR only (a driver may list products but not pull every id)", () => {
    expect(Reflect.getMetadata(ROLES_KEY, proto.findIds)).toEqual([UserRole.OPERATOR]);
    expect(Reflect.getMetadata("path", proto.findIds)).toBe("ids");
  });

  it("is declared before GET :id, which would otherwise capture it", () => {
    const src = readFileSync(join(__dirname, "products.controller.ts"), "utf8");
    expect(src.indexOf('@Get("ids")')).toBeGreaterThan(0);
    expect(src.indexOf('@Get("ids")')).toBeLessThan(src.indexOf('@Get(":id")'));
  });
});
