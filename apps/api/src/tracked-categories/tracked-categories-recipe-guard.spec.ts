import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { TrackedCategoriesService } from "./tracked-categories.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * SA-587a (#2717 M2 fold): `assignProducts` / `unassignProducts` are a second writer of the I6-locked
 * `Product.trackedCategoryId`. Each runs in ONE transaction in the house lock order (families ->
 * recipe products -> the rows), then refuses with 409 RECIPE_CATEGORY_LOCKED, writing NOTHING, when
 * any product it would MOVE sits in a DRAFT/ACTIVE recipe (product, family or component role).
 */
type Recipe = { productId: string; familyProductId: string; components: string[] };

const has = (r: Recipe, ids: string[]) =>
  ids.some((i) => r.productId === i || r.familyProductId === i || r.components.includes(i));
const idsOf = (where: any): string[] => where.OR[0].productId.in;

async function build(opts: {
  recipes: () => Recipe[];
  members?: string[]; // ids currently in category c1
  parents?: Record<string, string | null>;
}) {
  const prisma = createMockPrisma();
  const events: string[] = [];
  const members = opts.members ?? [];
  const tx: any = {
    ...prisma,
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const kind = /FOR UPDATE/i.test(strings.join("?")) ? "update" : "raw";
      events.push(`lock:${kind}:${values.flat().join(",")}`);
      return [];
    }),
    recipe: {
      findMany: jest.fn(async ({ where }: any) => {
        events.push("recipe.findMany");
        return opts
          .recipes()
          .filter((r) => has(r, idsOf(where)))
          .map((r) => ({
            ...r,
            components: r.components.map((componentProductId) => ({ componentProductId })),
          }));
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        events.push("recipe.findFirst");
        return opts.recipes().find((r) => has(r, idsOf(where))) ? { id: "r1" } : null;
      }),
    },
    product: {
      findMany: jest.fn(async ({ where, select }: any) => {
        if (select?.parentProductId) {
          events.push("product.findMany:parents");
          return (where.id.in as string[]).map((id) => ({
            id,
            parentProductId: opts.parents?.[id] ?? null,
          }));
        }
        events.push("product.findMany:movers");
        const ids = where.id.in as string[];
        const rows = where.OR
          ? ids.filter((i) => !members.includes(i))
          : ids.filter((i) => members.includes(i));
        return rows.map((id) => ({ id, category: null, trackedSubcategory: null }));
      }),
      updateMany: jest.fn(async ({ where }: any) => {
        events.push("write:product.updateMany");
        return { count: (where.id.in as string[]).length };
      }),
    },
  };
  prisma.tenantTransaction.mockImplementation(async (fn: any) => fn(tx));
  prisma.trackedCategory.findUnique.mockResolvedValue({
    id: "c1",
    name: "Beverage",
    active: true,
    _count: { products: 0 },
  } as any);
  const mod = await Test.createTestingModule({
    providers: [TrackedCategoriesService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return { service: mod.get(TrackedCategoriesService), prisma, tx, events };
}

const recipe: Recipe = { productId: "rp", familyProductId: "fam", components: ["v1", "v2"] };
const body = (e: any) => e.getResponse();

describe.each([
  ["assignProducts", (s: TrackedCategoriesService) => s.assignProducts("c1", ["v1", "p9"])],
  ["unassignProducts", (s: TrackedCategoriesService) => s.unassignProducts("c1", ["v1", "p9"])],
])("%s vs an open recipe (I6, SA-587a)", (name, run) => {
  const members = name === "unassignProducts" ? ["v1", "p9"] : [];

  it("a moved component of a DRAFT/ACTIVE recipe -> 409 RECIPE_CATEGORY_LOCKED and NOTHING is written (not even p9)", async () => {
    const { service, tx, prisma } = await build({ recipes: () => [recipe], members });
    const err = await run(service).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(body(err)).toMatchObject({ code: "RECIPE_CATEGORY_LOCKED" });
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
  });

  it("the 409 carries the COUNT of locked products (never ids or names)", async () => {
    const both = ["v1", "v2", "p9"];
    const { service } = await build({
      recipes: () => [recipe],
      members: name === "unassignProducts" ? both : [],
    });
    const call =
      name === "assignProducts"
        ? service.assignProducts("c1", both)
        : service.unassignProducts("c1", both);
    const err = await call.catch((e) => e);
    expect(body(err)).toMatchObject({ code: "RECIPE_CATEGORY_LOCKED", lockedCount: 2 });
    expect(JSON.stringify(body(err))).not.toMatch(/v1|v2|p9|fam|"rp"/);
  });

  it("a RETIRED-only / recipe-free product is written as before", async () => {
    const { service, tx } = await build({ recipes: () => [], members });
    await expect(run(service)).resolves.toBeDefined();
    expect(tx.product.updateMany).toHaveBeenCalled();
  });

  it("house order: family, recipe product, then the rows FOR UPDATE, all before the recipe check and every write", async () => {
    const { service, events } = await build({
      recipes: () => [{ ...recipe, components: ["v1"], productId: "p9" }],
      members,
      parents: { v1: "fam" },
    });
    await run(service).catch(() => undefined);
    const locks = events.filter((e) => e.startsWith("lock:update:"));
    expect(locks[0]).toMatch(/^lock:update:fam,/);
    expect(locks[1]).toMatch(/^lock:update:p9,/);
    expect(locks.length).toBeGreaterThanOrEqual(3);
    const lastLock = events
      .map((e, i) => (e.startsWith("lock:") ? i : -1))
      .reduce((a, b) => Math.max(a, b));
    expect(events.indexOf("recipe.findFirst")).toBeGreaterThan(lastLock);
    expect(events.indexOf("write:product.updateMany")).toBe(-1);
  });

  it("the decision rests on a POST-lock read: a recipe that appears while we wait on the rows still refuses", async () => {
    let recipes: Recipe[] = [];
    const { service, tx, events } = await build({ recipes: () => recipes, members });
    const lock = tx.$queryRaw;
    tx.$queryRaw = jest.fn(async (s: TemplateStringsArray, ...v: unknown[]) => {
      const out = await lock(s, ...v);
      recipes = [recipe]; // a recipes.create/activate committed once its share locks released
      return out;
    });
    const err = await run(service).catch((e) => e);
    expect(body(err)).toMatchObject({ code: "RECIPE_CATEGORY_LOCKED" });
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(events).toContain("recipe.findFirst");
  });
});

describe("rows that would not move never trip the guard", () => {
  it("assign: a product already in the category is not a mover even if it sits in an open recipe", async () => {
    const { service, tx } = await build({ recipes: () => [recipe], members: ["v1"] });
    await expect(service.assignProducts("c1", ["v1"])).resolves.toBeDefined();
    expect(tx.product.updateMany).toHaveBeenCalled();
  });
});
