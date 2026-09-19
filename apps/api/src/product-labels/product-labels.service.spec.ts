import { InternalServerErrorException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { labelSelect, ProductLabelsService } from "./product-labels.service";

const T = "tenant-1";
const row = (
  id: string,
  parentProductId: string | null,
  labels: Array<[string, "INCLUDE" | "EXCLUDE", (string | null)?]> = [],
) => ({
  id,
  name: `name-${id}`,
  parentProductId,
  categoryLabels: labels.map(([categoryId, mode, parentProductIdAtWrite]) => ({
    categoryId,
    mode,
    ...(parentProductIdAtWrite !== undefined ? { parentProductIdAtWrite } : {}),
  })),
});

describe("ProductLabelsService.effectiveLabels (read side)", () => {
  let service: ProductLabelsService;
  let mock: any;
  let products: any;

  beforeEach(async () => {
    mock = createMockPrisma();
    mock.getTenantId.mockReturnValue(null); // cron/system path: no ambient tenant
    products = mock.forTenant().product;
    const mod = await Test.createTestingModule({
      providers: [ProductLabelsService, { provide: PrismaService, useValue: mock }],
    }).compile();
    service = mod.get(ProductLabelsService);
  });

  it("returns an empty map (and reads nothing) for no ids", async () => {
    expect((await service.effectiveLabels(T, [])).size).toBe(0);
    expect(products.findMany).not.toHaveBeenCalled();
  });

  it("a standalone product: its own INCLUDE labels, lineage = itself, resolvable", async () => {
    products.findMany.mockResolvedValue([row("p1", null, [["a", "INCLUDE"]])]);
    const res = (await service.effectiveLabels(T, ["p1", "p1"])).get("p1")!;
    expect([...res.effectiveCategoryIds]).toEqual(["a"]);
    expect([...res.lineageIds]).toEqual(["p1"]);
    expect(res).toMatchObject({ resolvable: true, name: "name-p1" });
  });

  it("a variant inherits the parent's labels and its lineage includes the parent", async () => {
    products.findMany
      .mockResolvedValueOnce([row("v1", "p1")])
      .mockResolvedValueOnce([row("p1", null, [["a", "INCLUDE"]])]);
    const res = (await service.effectiveLabels(T, ["v1"])).get("v1")!;
    expect([...res.effectiveCategoryIds]).toEqual(["a"]);
    expect([...res.lineageIds].sort()).toEqual(["p1", "v1"]);
  });

  it("REPARENT: the CURRENT parent decides at each call — an opt-out active under one parent is inert under another", async () => {
    // The EXCLUDE was approved (pinned) while the variant sat under P1.
    const variant = (parent: string) => row("v1", parent, [["a", "EXCLUDE", "P1"]]);
    // 1st call: v1 under P1 (carries a) → opt-out active, effective = {}.
    products.findMany
      .mockResolvedValueOnce([variant("P1")])
      .mockResolvedValueOnce([row("P1", null, [["a", "INCLUDE"]])]);
    const before = (await service.effectiveLabels(T, ["v1"])).get("v1")!;
    expect([...before.effectiveCategoryIds]).toEqual([]);
    // Reparented under P2 (carries only b, NOT a) → the opt-out has no effect; effective = {b}.
    products.findMany
      .mockResolvedValueOnce([variant("P2")])
      .mockResolvedValueOnce([row("P2", null, [["b", "INCLUDE"]])]);
    const after = (await service.effectiveLabels(T, ["v1"])).get("v1")!;
    expect([...after.effectiveCategoryIds]).toEqual(["b"]);
    expect(after.lineageIds.has("P2")).toBe(true);
    expect(after.lineageIds.has("P1")).toBe(false);
  });

  it("an unknown product id is not resolvable", async () => {
    products.findMany.mockResolvedValue([]);
    const res = (await service.effectiveLabels(T, ["ghost"])).get("ghost")!;
    expect(res).toMatchObject({ resolvable: false, name: "ghost" });
  });

  it("a missing / foreign ancestor makes the product not resolvable", async () => {
    products.findMany.mockResolvedValueOnce([row("v1", "p1")]).mockResolvedValue([]);
    expect((await service.effectiveLabels(T, ["v1"])).get("v1")!.resolvable).toBe(false);
  });

  it("a parent cycle terminates and is not resolvable", async () => {
    products.findMany
      .mockResolvedValueOnce([row("a", "b")])
      .mockResolvedValueOnce([row("b", "a")])
      .mockResolvedValue([]);
    expect((await service.effectiveLabels(T, ["a"])).get("a")!.resolvable).toBe(false);
  });

  it("a chain deeper than the cap is not resolvable; a 5-ancestor chain still is", async () => {
    const chain = (n: number) =>
      Array.from({ length: n + 1 }, (_, i) => row(`n${i}`, i < n ? `n${i + 1}` : null));
    const load = (rows: ReturnType<typeof chain>) => {
      products.findMany.mockReset();
      rows.forEach((r) => products.findMany.mockResolvedValueOnce([r]));
      products.findMany.mockResolvedValue([]);
    };
    load(chain(5));
    expect((await service.effectiveLabels(T, ["n0"])).get("n0")!.resolvable).toBe(true);
    load(chain(6));
    expect((await service.effectiveLabels(T, ["n0"])).get("n0")!.resolvable).toBe(false);
  });

  it("scopes every query by the explicit tenantId", async () => {
    products.findMany.mockResolvedValue([row("p1", null)]);
    await service.effectiveLabels(T, ["p1"]);
    expect(products.findMany.mock.calls[0][0].where.tenantId).toBe(T);
  });

  it("refuses a tenant other than the ambient one (nothing is read)", async () => {
    mock.getTenantId.mockReturnValue("tenant-2");
    await expect(service.effectiveLabels(T, ["p1"])).rejects.toThrow(InternalServerErrorException);
    expect(products.findMany).not.toHaveBeenCalled();
  });

  it("REPARENT onto a DIFFERENT parent that ALSO carries the label: the pinned opt-out is inert → the label is carried (DENY)", async () => {
    products.findMany
      .mockResolvedValueOnce([row("v1", "P2", [["a", "EXCLUDE", "P1"]])])
      .mockResolvedValueOnce([row("P2", null, [["a", "INCLUDE"]])]);
    const res = (await service.effectiveLabels(T, ["v1"])).get("v1")!;
    expect([...res.effectiveCategoryIds]).toEqual(["a"]);
  });

  it("an EXCLUDE with NO pin (legacy row / column not yet present) is inert", async () => {
    products.findMany
      .mockResolvedValueOnce([row("v1", "P1", [["a", "EXCLUDE"]])])
      .mockResolvedValueOnce([row("P1", null, [["a", "INCLUDE"]])]);
    expect([...(await service.effectiveLabels(T, ["v1"])).get("v1")!.effectiveCategoryIds]).toEqual(
      ["a"],
    );
  });

  it("a MATCHING pin makes the opt-out effective", async () => {
    products.findMany
      .mockResolvedValueOnce([row("v1", "P1", [["a", "EXCLUDE", "P1"]])])
      .mockResolvedValueOnce([row("P1", null, [["a", "INCLUDE"]])]);
    expect([...(await service.effectiveLabels(T, ["v1"])).get("v1")!.effectiveCategoryIds]).toEqual(
      [],
    );
  });

  describe("labelSelect (the pin is selected only once the column exists)", () => {
    it("without the column in the generated client's field enum: categoryId + mode only", () => {
      expect(labelSelect({ id: "id", categoryId: "categoryId", mode: "mode" })).toEqual({
        categoryId: true,
        mode: true,
      });
    });

    it("with the column present: the pin is selected too — no manual flip", () => {
      expect(
        labelSelect({
          categoryId: "categoryId",
          mode: "mode",
          parentProductIdAtWrite: "parentProductIdAtWrite",
        }),
      ).toEqual({ categoryId: true, mode: true, parentProductIdAtWrite: true });
    });
  });

  describe("contract with the write side's column (PC-lead ruling: ProductCategoryLabel.parentProductIdAtWrite)", () => {
    it("the real generated client either lacks the pin column or spells it EXACTLY `parentProductIdAtWrite` — a near-miss spelling would silently keep every opt-out inert", () => {
      const fields = Object.keys(Prisma.ProductCategoryLabelScalarFieldEnum);
      const pinLike = fields.filter((f) => /parent.*(write|pin)|(write|pin).*parent/i.test(f));
      expect(pinLike.every((f) => f === "parentProductIdAtWrite")).toBe(true);
      // and labelSelect really follows the real field list, whichever side of the migration we are on
      expect(
        "parentProductIdAtWrite" in labelSelect(Prisma.ProductCategoryLabelScalarFieldEnum),
      ).toBe(fields.includes("parentProductIdAtWrite"));
    });
  });

  /** A `product.findMany` that answers by `where.id.in`, like the database — not by call order. */
  const serve = (rows: Array<ReturnType<typeof row>>) =>
    products.findMany.mockImplementation(async ({ where }: any) =>
      rows.filter((r) => where.id.in.includes(r.id)),
    );

  describe("grandchild opt-out through the loader, 3-level chain GP[a] ← P ← G (review MAJOR 2)", () => {
    const GP = row("GP", null, [["a", "INCLUDE"]]);
    const P = row("P", "GP");
    const P2 = row("P2", "GP");
    const effective = async (g: ReturnType<typeof row>) => {
      serve([GP, P, P2, g]);
      const res = (await service.effectiveLabels(T, [g.id])).get(g.id)!;
      return { labels: [...res.effectiveCategoryIds], resolvable: res.resolvable };
    };

    it("(i) pinned to the IMMEDIATE parent P: the label inherited through P from GP is removed", async () => {
      expect(await effective(row("G", "P", [["a", "EXCLUDE", "P"]]))).toEqual({
        labels: [],
        resolvable: true,
      });
    });

    it("(ii) pinned to GP (a non-immediate ancestor): INERT — the label stays", async () => {
      expect((await effective(row("G", "P", [["a", "EXCLUDE", "GP"]]))).labels).toEqual(["a"]);
    });

    it("(iii) unpinned (null and absent): INERT", async () => {
      expect((await effective(row("G", "P", [["a", "EXCLUDE", null]]))).labels).toEqual(["a"]);
      expect((await effective(row("G", "P", [["a", "EXCLUDE"]]))).labels).toEqual(["a"]);
    });

    it("(iv) G reparented under P2 (which also inherits a): the pin (P) no longer matches → INERT", async () => {
      expect((await effective(row("G", "P2", [["a", "EXCLUDE", "P"]]))).labels).toEqual(["a"]);
    });

    it("the lineage still reaches the grandparent (product-scoped rules on GP bind G)", async () => {
      serve([GP, P, row("G", "P", [["a", "EXCLUDE", "P"]])]);
      const res = (await service.effectiveLabels(T, ["G"])).get("G")!;
      expect([...res.lineageIds].sort()).toEqual(["G", "GP", "P"]);
    });
  });

  describe("the depth cap is per ROOT, never per batch (review MINOR 3)", () => {
    /** n0 → n1 → … → n{hops}: n0 has `hops` ancestors. */
    const chain = (hops: number) =>
      Array.from({ length: hops + 1 }, (_, i) => row(`n${i}`, i < hops ? `n${i + 1}` : null));
    const resolvable = async (ids: string[]) => {
      const res = await service.effectiveLabels(T, ids);
      return Object.fromEntries(ids.map((id) => [id, res.get(id)!.resolvable]));
    };

    it("a chain deeper than the cap is unresolvable ALONE and also when its ancestor is ALSO in the batch", async () => {
      serve(chain(6)); // n0 has 6 ancestors (cap is 5); n1 has exactly 5
      expect(await resolvable(["n0"])).toEqual({ n0: false });
      // n1 is a requested line, so the shared loader reaches n6 for n0 — n0 must STILL not resolve
      expect(await resolvable(["n0", "n1"])).toEqual({ n0: false, n1: true });
      expect(await resolvable(["n1", "n0", "n2"])).toEqual({ n0: false, n1: true, n2: true });
    });

    it("a 5-hop chain resolves alone and with its ancestors in the batch", async () => {
      serve(chain(5));
      expect(await resolvable(["n0"])).toEqual({ n0: true });
      expect(await resolvable(["n0", "n1"])).toEqual({ n0: true, n1: true });
      expect(await resolvable(["n0", "n3", "n5"])).toEqual({ n0: true, n3: true, n5: true });
    });

    it("a product's answer (resolvable, labels, lineage) is identical for EVERY batch it can appear in", async () => {
      const rows = chain(7);
      rows[7] = row("n7", null, [["a", "INCLUDE"]]);
      serve(rows);
      const ids = rows.map((r) => r.id);
      const shape = (res: Awaited<ReturnType<typeof service.effectiveLabels>>, id: string) => {
        const e = res.get(id)!;
        return {
          resolvable: e.resolvable,
          labels: [...e.effectiveCategoryIds].sort(),
          lineage: [...e.lineageIds].sort(),
        };
      };
      const alone = new Map<string, ReturnType<typeof shape>>();
      for (const id of ids) alone.set(id, shape(await service.effectiveLabels(T, [id]), id));
      // n{i} has 7-i ancestors: resolvable iff that is within the cap of 5
      ids.forEach((id, i) => expect(alone.get(id)!.resolvable).toBe(7 - i <= 5));

      for (let mask = 1; mask < 1 << ids.length; mask++) {
        const batch = ids.filter((_, i) => mask & (1 << i));
        const res = await service.effectiveLabels(T, batch);
        for (const id of batch)
          expect({ id, ...shape(res, id) }).toEqual({ id, ...alone.get(id)! });
      }
    });
  });
});
