import { NotFoundException } from "@nestjs/common";
import { assertRefsInTenant, type TenantRefs } from "./assert-refs-in-tenant";

// R5-5 / 681: the one helper every "a caller-supplied id is stored" writer proves through. Existence AND
// tenant only, so a foreign id and a missing id are the same 404 (no tenant oracle).

type Kind = {
  name: string;
  field: keyof TenantRefs;
  model: string;
  message: string;
};

const KINDS: Kind[] = [
  { name: "supplier", field: "supplierIds", model: "supplier", message: "Supplier not found" },
  { name: "customer", field: "customerIds", model: "customer", message: "Customer not found" },
  { name: "product", field: "productIds", model: "product", message: "Product not found" },
  {
    name: "trackedCategory",
    field: "trackedCategoryIds",
    model: "trackedCategory",
    message: "Tracked category not found",
  },
];

function makePrisma() {
  const models: Record<string, { findMany: jest.Mock }> = {};
  for (const k of KINDS) models[k.model] = { findMany: jest.fn().mockResolvedValue([]) };
  const expenseCategory = { findMany: jest.fn().mockResolvedValue([]) };
  const forTenant = jest.fn().mockReturnValue(models);
  const prisma = {
    forTenant,
    getTenantId: jest.fn().mockReturnValue("tenant-a"),
    expenseCategory,
  } as any;
  return { prisma, models, forTenant, expenseCategory };
}

describe.each(KINDS)("assertRefsInTenant — $name", ({ field, model, message }) => {
  it("a missing id is a 404 with the model message", async () => {
    const { prisma, models } = makePrisma();
    models[model].findMany.mockResolvedValue([]);
    const err = await assertRefsInTenant(prisma, { [field]: ["x1"] }).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe(message);
  });

  it("a foreign id (the tenant-scoped read finds fewer) is the same 404", async () => {
    const { prisma, models } = makePrisma();
    models[model].findMany.mockResolvedValue([{ id: "mine" }]);
    const err = await assertRefsInTenant(prisma, { [field]: ["mine", "theirs"] }).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe(message);
  });

  it("a same-tenant id passes, read through forTenant() by id", async () => {
    const { prisma, models, forTenant } = makePrisma();
    models[model].findMany.mockResolvedValue([{ id: "mine" }]);
    await expect(assertRefsInTenant(prisma, { [field]: ["mine"] })).resolves.toBeUndefined();
    expect(forTenant).toHaveBeenCalled();
    expect(models[model].findMany).toHaveBeenCalledWith({
      where: { id: { in: ["mine"] } },
      select: { id: true },
    });
  });

  it("duplicate ids are de-duplicated before the count compare", async () => {
    const { prisma, models } = makePrisma();
    models[model].findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    await expect(
      assertRefsInTenant(prisma, { [field]: ["a", "b", "a", "b", "a"] }),
    ).resolves.toBeUndefined();
    expect(models[model].findMany.mock.calls[0][0].where.id.in).toEqual(["a", "b"]);
  });

  it.each([
    ["empty array", []],
    ["null / undefined / empty-string entries", [null, undefined, ""]],
    ["undefined field", undefined],
  ])("%s -> no read at all", async (_label, value) => {
    const { prisma, models, forTenant, expenseCategory } = makePrisma();
    await expect(
      assertRefsInTenant(prisma, { [field]: value as any } as TenantRefs),
    ).resolves.toBeUndefined();
    expect(forTenant).not.toHaveBeenCalled();
    expect(models[model].findMany).not.toHaveBeenCalled();
    expect(expenseCategory.findMany).not.toHaveBeenCalled();
  });

  it("never reads deletedAt / archived / sellable state (MUST 2)", async () => {
    const { prisma, models } = makePrisma();
    models[model].findMany.mockResolvedValue([{ id: "mine" }]);
    await assertRefsInTenant(prisma, { [field]: ["mine"] });
    expect(JSON.stringify(models[model].findMany.mock.calls[0][0])).not.toMatch(
      /deletedAt|archived|sellable|active/i,
    );
  });
});

describe("assertRefsInTenant — trackedCategory has no null-tenant exemption", () => {
  it("is read through forTenant() only, with no tenantId:null OR branch", async () => {
    const { prisma, models, expenseCategory } = makePrisma();
    models.trackedCategory.findMany.mockResolvedValue([{ id: "t1" }]);
    await assertRefsInTenant(prisma, { trackedCategoryIds: ["t1"] });
    expect(JSON.stringify(models.trackedCategory.findMany.mock.calls[0][0])).not.toContain("null");
    expect(expenseCategory.findMany).not.toHaveBeenCalled();
  });
});

describe("assertRefsInTenant — expense category (null-tenant global allowed)", () => {
  it("accepts the caller's tenant OR a null-tenant global, on the unscoped client", async () => {
    const { prisma, expenseCategory, forTenant } = makePrisma();
    expenseCategory.findMany.mockResolvedValue([{ id: "mine" }, { id: "global" }]);
    await expect(
      assertRefsInTenant(prisma, { expenseCategoryIds: ["mine", "global"] }),
    ).resolves.toBeUndefined();
    expect(expenseCategory.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["mine", "global"] },
        OR: [{ tenantId: "tenant-a" }, { tenantId: null }],
      },
      select: { id: true },
    });
    expect(forTenant).not.toHaveBeenCalled();
  });

  it("a miss or another tenant's category is a 404", async () => {
    const { prisma, expenseCategory } = makePrisma();
    expenseCategory.findMany.mockResolvedValue([{ id: "mine" }]);
    const err = await assertRefsInTenant(prisma, { expenseCategoryIds: ["mine", "theirs"] }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe("Expense category not found");
  });

  it("duplicates dedupe and empty / null reads nothing", async () => {
    const { prisma, expenseCategory } = makePrisma();
    expenseCategory.findMany.mockResolvedValue([{ id: "g" }]);
    await assertRefsInTenant(prisma, { expenseCategoryIds: ["g", "g"] });
    expect(expenseCategory.findMany.mock.calls[0][0].where.id.in).toEqual(["g"]);
    expenseCategory.findMany.mockClear();
    await assertRefsInTenant(prisma, { expenseCategoryIds: [null, undefined] });
    await assertRefsInTenant(prisma, {});
    expect(expenseCategory.findMany).not.toHaveBeenCalled();
  });
});
