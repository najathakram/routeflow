import "reflect-metadata";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UserRole } from "@prisma/client";
import { ProductUnitsService } from "./product-units.service";
import { ProductUnitsController } from "./product-units.controller";
import { CreateProductUnitDto, UpdateProductUnitDto } from "./dto/product-unit.dto";
import { REQUIRE_PLAN_FLAG_KEY } from "../billing/require-plan-flag.decorator";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { FEATURE_REGISTRY } from "../billing/feature-registry";

type Row = { id: string; label: string; factorToBase: number };

function build(opts: {
  product?: Record<string, unknown> | null;
  rows?: Row[];
  orderLineHit?: boolean;
  invoiceLineHit?: boolean;
}) {
  const product =
    opts.product === undefined
      ? { unit: "Box", unitsPerBox: 24, trackedCategoryId: null }
      : opts.product;
  const tx = {
    productUnit: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockImplementation(async ({ data }) => ({ id: "new", ...data })),
      update: jest.fn().mockImplementation(async ({ where, data }) => ({ id: where.id, ...data })),
    },
  };
  const db = {
    product: { findUnique: jest.fn().mockResolvedValue(product) },
    productUnit: {
      findMany: jest.fn().mockResolvedValue(opts.rows ?? []),
      findFirst: jest
        .fn()
        .mockImplementation(
          async ({ where }) => (opts.rows ?? []).find((r) => r.id === where.id) ?? null,
        ),
      delete: jest.fn().mockResolvedValue({}),
    },
    orderItem: {
      findFirst: jest.fn().mockResolvedValue(opts.orderLineHit ? { id: "oi" } : null),
    },
    invoiceItem: {
      findFirst: jest.fn().mockResolvedValue(opts.invoiceLineHit ? { id: "ii" } : null),
    },
  };
  const prisma = {
    forTenant: () => db,
    tenantTransaction: jest.fn().mockImplementation(async (fn) => fn(tx)),
  };
  return { service: new ProductUnitsService(prisma as never), db, tx, prisma };
}

const caseRow: Row = { id: "u-case", label: "Case", factorToBase: 288 };

describe("ProductUnitsService.create", () => {
  it("creates a level, storing null for every unset price and the trimmed label", async () => {
    const { service, tx } = build({});
    await service.create("p1", { label: "  Case ", factorToBase: 288, price: 480 });
    expect(tx.productUnit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: "p1",
        label: "Case",
        factorToBase: 288,
        price: 480,
        priceTier2: null,
        priceTier5: null,
        isDefaultSelling: false,
        sortOrder: 0,
      }),
    });
    expect(tx.productUnit.updateMany).not.toHaveBeenCalled();
  });

  it("404s for a product that is not in the tenant", async () => {
    const { service } = build({ product: null });
    await expect(service.create("nope", { label: "Case", factorToBase: 288 })).rejects.toThrow(
      NotFoundException,
    );
  });

  it("making a level the default clears every other default in the same transaction", async () => {
    const { service, tx, prisma } = build({});
    await service.create("p1", { label: "Case", factorToBase: 288, isDefaultSelling: true });
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(tx.productUnit.updateMany).toHaveBeenCalledWith({
      where: { productId: "p1", isDefaultSelling: true },
      data: { isDefaultSelling: false },
    });
  });

  it("rejects the pack's own size (its price lives on the product)", async () => {
    const { service, tx } = build({});
    await expect(service.create("p1", { label: "Carton", factorToBase: 24 })).rejects.toThrow(
      BadRequestException,
    );
    expect(tx.productUnit.create).not.toHaveBeenCalled();
  });

  it("rejects a piece row on a product with no pack size (the piece IS the product)", async () => {
    const { service } = build({
      product: { unit: "Each", unitsPerBox: null, trackedCategoryId: null },
    });
    await expect(service.create("p1", { label: "Piece", factorToBase: 1 })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("factor 1 is always named Piece; the name Piece is always factor 1", async () => {
    const { service, tx } = build({});
    await service.create("p1", { label: "each one", factorToBase: 1, price: 2 });
    expect(tx.productUnit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ label: "Piece", factorToBase: 1 }),
    });
    await expect(service.create("p1", { label: "piece", factorToBase: 6 })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects a label equal to the pack's name (case-insensitive)", async () => {
    const { service } = build({});
    await expect(service.create("p1", { label: "BOX", factorToBase: 6 })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects a duplicate label or a duplicate factor (409)", async () => {
    const { service } = build({ rows: [caseRow] });
    await expect(service.create("p1", { label: "case", factorToBase: 100 })).rejects.toThrow(
      ConflictException,
    );
    await expect(service.create("p1", { label: "Crate", factorToBase: 288 })).rejects.toThrow(
      ConflictException,
    );
  });

  it("guard (c): a regulated product cannot get a level above its pack, but may get one below", async () => {
    const regulated = { unit: "Box", unitsPerBox: 24, trackedCategoryId: "cat1" };
    const above = build({ product: regulated });
    await expect(above.service.create("p1", { label: "Case", factorToBase: 288 })).rejects.toThrow(
      BadRequestException,
    );
    const below = build({ product: regulated });
    await expect(
      below.service.create("p1", { label: "Piece", factorToBase: 1 }),
    ).resolves.toBeDefined();
  });

  it("factors immutable: refuses a label an existing order/invoice line carries at a different size", async () => {
    const order = build({ orderLineHit: true });
    await expect(order.service.create("p1", { label: "Case", factorToBase: 300 })).rejects.toThrow(
      ConflictException,
    );
    const invoice = build({ invoiceLineHit: true });
    await expect(
      invoice.service.create("p1", { label: "Case", factorToBase: 300 }),
    ).rejects.toThrow(ConflictException);
    expect(order.db.orderItem.findFirst).toHaveBeenCalledWith({
      where: {
        productId: "p1",
        unitLabel: { equals: "Case", mode: "insensitive" },
        OR: [{ unitsPerBox: null }, { unitsPerBox: { not: 300 } }],
      },
      select: { id: true },
    });
  });
});

describe("ProductUnitsService.update", () => {
  it("a price-only edit never consults the lines (prices are not immutable)", async () => {
    const { service, db, tx } = build({ rows: [caseRow], orderLineHit: true });
    await service.update("p1", "u-case", { price: 500 });
    expect(db.orderItem.findFirst).not.toHaveBeenCalled();
    expect(tx.productUnit.update).toHaveBeenCalledWith({
      where: { id: "u-case" },
      data: expect.objectContaining({ price: 500, label: "Case", factorToBase: 288 }),
    });
  });

  it("a factor edit is refused (409) once a line carries the level — mint a new level instead", async () => {
    const { service, tx } = build({ rows: [caseRow], orderLineHit: true });
    await expect(service.update("p1", "u-case", { factorToBase: 300 })).rejects.toThrow(
      ConflictException,
    );
    expect(tx.productUnit.update).not.toHaveBeenCalled();
  });

  it("a factor edit is allowed while no line uses the level, and checks the OLD label too", async () => {
    const { service, db, tx } = build({ rows: [caseRow] });
    await service.update("p1", "u-case", { factorToBase: 300 });
    const labels = db.orderItem.findFirst.mock.calls.map((c) => c[0].where.unitLabel.equals);
    expect(labels).toEqual(["Case", "Case"]);
    expect(tx.productUnit.update).toHaveBeenCalled();
  });

  it("does not collide with itself when re-saving the same label/factor", async () => {
    const { service } = build({ rows: [caseRow] });
    await expect(
      service.update("p1", "u-case", { label: "Case", factorToBase: 288, price: 1 }),
    ).resolves.toBeDefined();
  });

  it("switching the default keeps the edited row and clears the rest", async () => {
    const { service, tx } = build({ rows: [caseRow] });
    await service.update("p1", "u-case", { isDefaultSelling: true });
    expect(tx.productUnit.updateMany).toHaveBeenCalledWith({
      where: { productId: "p1", isDefaultSelling: true, NOT: { id: "u-case" } },
      data: { isDefaultSelling: false },
    });
  });

  it("unsetting the default does not touch other rows", async () => {
    const { service, tx } = build({ rows: [caseRow] });
    await service.update("p1", "u-case", { isDefaultSelling: false });
    expect(tx.productUnit.updateMany).not.toHaveBeenCalled();
  });

  it("404s for a unit that belongs to another product/tenant", async () => {
    const { service } = build({ rows: [] });
    await expect(service.update("p1", "ghost", { price: 1 })).rejects.toThrow(NotFoundException);
  });
});

describe("ProductUnitsService.remove / list", () => {
  it("deletes a level without consulting lines (lines snapshot their own factor)", async () => {
    const { service, db } = build({ rows: [caseRow] });
    await expect(service.remove("p1", "u-case")).resolves.toEqual({ deleted: true });
    expect(db.productUnit.delete).toHaveBeenCalledWith({ where: { id: "u-case" } });
    expect(db.orderItem.findFirst).not.toHaveBeenCalled();
  });

  it("lists in sortOrder then factor order", async () => {
    const { service, db } = build({ rows: [caseRow] });
    await service.list("p1");
    expect(db.productUnit.findMany).toHaveBeenCalledWith({
      where: { productId: "p1" },
      orderBy: [{ sortOrder: "asc" }, { factorToBase: "asc" }],
    });
  });
});

describe("delete-then-recreate cannot smuggle a factor change", () => {
  it("re-creating a used label at a new factor is refused even though the old row is gone", async () => {
    const { service } = build({ rows: [], orderLineHit: true });
    await expect(service.create("p1", { label: "Case", factorToBase: 300 })).rejects.toThrow(
      ConflictException,
    );
  });
});

describe("ProductUnit DTOs", () => {
  const ok = async (cls: new () => object, body: object) =>
    (await validate(plainToInstance(cls, body))).length === 0;

  it("accepts a minimal level and a fully priced one (null = derived)", async () => {
    expect(await ok(CreateProductUnitDto, { label: "Case", factorToBase: 12 })).toBe(true);
    expect(
      await ok(CreateProductUnitDto, {
        label: "Case",
        factorToBase: 12,
        price: 40.5,
        priceTier2: null,
        isDefaultSelling: true,
      }),
    ).toBe(true);
  });

  it.each([
    ["zero factor", { label: "x", factorToBase: 0 }],
    ["negative factor", { label: "x", factorToBase: -3 }],
    ["fractional factor", { label: "x", factorToBase: 1.5 }],
    ["3-dp price", { label: "x", factorToBase: 2, price: 1.005 }],
    ["negative price", { label: "x", factorToBase: 2, price: -1 }],
    ["price over Decimal(10,2)", { label: "x", factorToBase: 2, price: 100_000_000 }],
    ["label over 40 chars", { label: "x".repeat(41), factorToBase: 2 }],
    ["non-string label", { label: 5, factorToBase: 2 }],
  ])("rejects %s", async (_n, body) => {
    expect(await ok(CreateProductUnitDto, body)).toBe(false);
  });

  it("the update DTO is all-optional but still validates what is sent", async () => {
    expect(await ok(UpdateProductUnitDto, {})).toBe(true);
    expect(await ok(UpdateProductUnitDto, { price: null })).toBe(true);
    expect(await ok(UpdateProductUnitDto, { factorToBase: 0 })).toBe(false);
  });
});

describe("ProductUnitsController — gate wiring", () => {
  it("sits behind Jwt + Roles + PlanFlag guards and requires flag.units_v1 at the class level", () => {
    const guards = (Reflect.getMetadata("__guards__", ProductUnitsController) ?? []) as Array<{
      name: string;
    }>;
    expect(guards.map((g) => g.name)).toEqual(["JwtAuthGuard", "RolesGuard", "PlanFlagGuard"]);
    expect(Reflect.getMetadata(REQUIRE_PLAN_FLAG_KEY, ProductUnitsController)).toBe(
      "flag.units_v1",
    );
  });

  it("every handler declares its roles: reads OPERATOR+DRIVER, writes OPERATOR only", () => {
    const proto = ProductUnitsController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(ROLES_KEY, proto.list)).toEqual([
      UserRole.OPERATOR,
      UserRole.DRIVER,
    ]);
    for (const h of ["create", "update", "remove"]) {
      expect(Reflect.getMetadata(ROLES_KEY, proto[h])).toEqual([UserRole.OPERATOR]);
    }
  });

  it("flag.units_v1 is registered enforced, ungranted by default, with a grant path", () => {
    const row = FEATURE_REGISTRY.find((f) => f.key === "flag.units_v1");
    expect(row).toBeDefined();
    expect(row?.gate.via).toBe("RequirePlanFlag");
    expect(row?.gate.state).toBe("enforced");
    expect(row?.defaultGranted).toBe(false);
    expect(row?.gate.grantPath.length).toBeGreaterThan(0);
  });
});
