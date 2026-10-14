import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ProductLabelsAdminService } from "./product-labels-admin.service";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { LabelFakeDb } from "./testing/label-fake-db";

const user = { sub: "u1", username: "admin" } as JwtPayload;
const TENANT = "t1";

function setup(tenantId: string | null = TENANT) {
  const db = new LabelFakeDb();
  const prisma = db.prisma(tenantId);
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const labels = new ProductLabelsService(prisma);
  const service = new ProductLabelsAdminService(prisma, audit as any, labels);
  return { db, prisma, audit, labels, service };
}

/** Fixture: GP → P → V, category "c" (Alcohol). */
function family() {
  const s = setup();
  s.db.addProduct("GP").addProduct("P", "GP").addProduct("V", "P").addCategory("c", "Alcohol");
  return s;
}

const effective = async (s: ReturnType<typeof setup>, id: string) => [
  ...(await s.labels.effectiveLabels(TENANT, [id])).get(id)!.effectiveCategoryIds,
];

describe("ProductLabelsAdminService — setLabel", () => {
  it("INCLUDE creates one row, unpinned, stamped with tenant and acting user", async () => {
    const s = family();
    const out = await s.service.setLabel("GP", "c", { mode: "INCLUDE" }, user);
    expect(s.db.labels).toHaveLength(1);
    expect(s.db.labels[0]).toMatchObject({
      tenantId: TENANT,
      productId: "GP",
      categoryId: "c",
      mode: "INCLUDE",
      reason: null,
      parentProductIdAtWrite: null,
      createdById: "u1",
      createdByName: "admin",
    });
    expect(out).toMatchObject({ mode: "INCLUDE", optOutActive: null, categoryName: "Alcohol" });
    expect(s.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "product_label.set", entityId: "GP" }),
    );
  });

  it("an existing (product, category) row is updated in place, not duplicated", async () => {
    const s = family();
    await s.service.setLabel("GP", "c", { mode: "INCLUDE" }, user);
    await s.service.setLabel("GP", "c", { mode: "INCLUDE" }, user);
    expect(s.db.labels).toHaveLength(1);
  });

  it("404s an unknown product / category and refuses an archived category", async () => {
    const s = family();
    await expect(s.service.setLabel("nope", "c", { mode: "INCLUDE" }, user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      s.service.setLabel("GP", "nope", { mode: "INCLUDE" }, user),
    ).rejects.toBeInstanceOf(NotFoundException);
    s.db.addCategory("old", "Old", TENANT, new Date());
    await expect(s.service.setLabel("GP", "old", { mode: "INCLUDE" }, user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(s.db.labels).toHaveLength(0);
  });

  it("a product or category of ANOTHER tenant is not found", async () => {
    const s = family();
    s.db.addProduct("X", null, "t2").addCategory("cx", "Other", "t2");
    await expect(s.service.setLabel("X", "c", { mode: "INCLUDE" }, user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(s.service.setLabel("GP", "cx", { mode: "INCLUDE" }, user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("every write refuses without a tenant context (SUPER_ADMIN)", async () => {
    const s = setup(null);
    await expect(s.service.setLabel("GP", "c", { mode: "INCLUDE" }, user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(s.service.removeLabel("GP", "c", user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(s.service.getForProduct("GP")).rejects.toBeInstanceOf(BadRequestException);
  });

  describe("EXCLUDE (variant opt-out)", () => {
    it("is rejected on a product with no parent, and writes nothing", async () => {
      const s = family();
      await expect(
        s.service.setLabel("GP", "c", { mode: "EXCLUDE", reason: "why" }, user),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(s.db.labels).toHaveLength(0);
    });

    it.each([undefined, "", "   "])("requires a reason (got %p)", async (reason) => {
      const s = family();
      s.db.addLabel("P", "c", "INCLUDE");
      await expect(
        s.service.setLabel("V", "c", { mode: "EXCLUDE", reason }, user),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(s.db.label("V", "c")).toBeUndefined();
    });

    it("is rejected when the label does not reach the parent", async () => {
      const s = family();
      await expect(
        s.service.setLabel("V", "c", { mode: "EXCLUDE", reason: "THC-free" }, user),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(s.db.labels).toHaveLength(0);
    });

    it("stores the trimmed reason and PINS the opt-out to the variant's current parent", async () => {
      const s = family();
      s.db.addLabel("P", "c", "INCLUDE");
      const out = await s.service.setLabel(
        "V",
        "c",
        { mode: "EXCLUDE", reason: "  THC-free " },
        user,
      );
      expect(s.db.label("V", "c")).toMatchObject({
        mode: "EXCLUDE",
        reason: "THC-free",
        parentProductIdAtWrite: "P",
      });
      expect(out.optOutActive).toBe(true);
      // The engine agrees: the opt-out is honoured while V stays under P.
      expect(await effective(s, "V")).toEqual([]);
    });

    it("accepts an opt-out of a label that reaches the parent from a GRANDparent (no own row on the parent)", async () => {
      const s = family();
      s.db.addLabel("GP", "c", "INCLUDE"); // P carries nothing of its own
      await s.service.setLabel("V", "c", { mode: "EXCLUDE", reason: "THC-free" }, user);
      expect(s.db.label("V", "c")).toMatchObject({ mode: "EXCLUDE", parentProductIdAtWrite: "P" });
      expect(await effective(s, "V")).toEqual([]);
    });

    it("rejects an opt-out when the parent has itself opted out of that label", async () => {
      const s = family();
      s.db.addLabel("GP", "c", "INCLUDE");
      s.db.addLabel("P", "c", "EXCLUDE", "GP"); // label no longer reaches P
      await expect(
        s.service.setLabel("V", "c", { mode: "EXCLUDE", reason: "x" }, user),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("fails closed when the ancestry can't be resolved (a parent in another tenant)", async () => {
      const s = setup();
      s.db.addCategory("c", "Alcohol").addProduct("FP", null, "t2").addProduct("V", "FP");
      s.db.addLabel("FP", "c", "INCLUDE", null, "t2");
      await expect(
        s.service.setLabel("V", "c", { mode: "EXCLUDE", reason: "x" }, user),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(s.db.label("V", "c")).toBeUndefined();
    });

    it("fails closed on a parent cycle", async () => {
      const s = setup();
      s.db.addCategory("c").addProduct("A", "B").addProduct("B", "A").addProduct("V", "A");
      s.db.addLabel("A", "c", "INCLUDE");
      await expect(
        s.service.setLabel("V", "c", { mode: "EXCLUDE", reason: "x" }, user),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("every ancestor-chain read inside the transaction carries the explicit tenantId", async () => {
      const s = family();
      s.db.addLabel("P", "c", "INCLUDE");
      await s.service.setLabel("V", "c", { mode: "EXCLUDE", reason: "x" }, user);
      const chainReads = s.db.calls.filter(
        (c) => c.model === "product" && c.args.select?.categoryLabels,
      );
      expect(chainReads.length).toBeGreaterThan(0); // the walk really happened
      for (const c of chainReads) expect(c.args.where.tenantId).toBe(TENANT);
    });
  });

  describe("reparenting never moves the pin (an opt-out approved for one parent can't ride to another)", () => {
    it("a moved variant's old opt-out is INERT for the engine and reads as optOutActive:false", async () => {
      const s = family();
      s.db.addProduct("Q", null).addLabel("Q", "c", "INCLUDE");
      s.db.addLabel("P", "c", "INCLUDE");
      await s.service.setLabel("V", "c", { mode: "EXCLUDE", reason: "THC-free" }, user);
      expect(await effective(s, "V")).toEqual([]); // opted out under P

      // An operator reparents V (what PATCH /products/:id / bulk-assign-parent do).
      s.db.products.find((p) => p.id === "V")!.parentProductId = "Q";
      const before = { ...s.db.label("V", "c")! };

      expect(s.db.label("V", "c")!.parentProductIdAtWrite).toBe("P"); // pin untouched
      expect(await effective(s, "V")).toEqual(["c"]); // engine: inert ⇒ the label applies again
      const view = await s.service.getForProduct("V");
      expect(view.own[0]).toMatchObject({ mode: "EXCLUDE", optOutActive: false });
      expect(s.db.label("V", "c")).toEqual(before); // reading never rewrites it
    });

    it("re-recording the opt-out under the NEW parent re-pins it there", async () => {
      const s = family();
      s.db.addProduct("Q", null).addLabel("Q", "c", "INCLUDE");
      s.db.addLabel("P", "c", "INCLUDE");
      await s.service.setLabel("V", "c", { mode: "EXCLUDE", reason: "a" }, user);
      s.db.products.find((p) => p.id === "V")!.parentProductId = "Q";
      await s.service.setLabel("V", "c", { mode: "EXCLUDE", reason: "b" }, user);
      expect(s.db.label("V", "c")!.parentProductIdAtWrite).toBe("Q");
      expect(await effective(s, "V")).toEqual([]);
    });
  });

  it("flipping an opt-out back to INCLUDE clears its pin and reason", async () => {
    const s = family();
    s.db.addLabel("P", "c", "INCLUDE");
    await s.service.setLabel("V", "c", { mode: "EXCLUDE", reason: "x" }, user);
    await s.service.setLabel("V", "c", { mode: "INCLUDE", reason: "stale" }, user);
    expect(s.db.label("V", "c")).toMatchObject({
      mode: "INCLUDE",
      reason: null,
      parentProductIdAtWrite: null,
    });
  });

  it("B581: turning a variant's own INCLUDE into an opt-out voids the opt-outs below it that only cancelled it", async () => {
    const s = setup();
    s.db.addCategory("c").addProduct("P").addProduct("V", "P").addProduct("W", "V");
    s.db.addLabel("P", "c", "INCLUDE");
    s.db.addLabel("V", "c", "INCLUDE"); // V re-asserts the label…
    s.db.addLabel("W", "c", "EXCLUDE", "V"); // …and W opted out of it
    await s.service.setLabel("V", "c", { mode: "EXCLUDE", reason: "V is exempt" }, user);
    // V now cancels the label, so W's opt-out cancels nothing and must be gone.
    expect(s.db.label("W", "c")).toBeUndefined();
    expect(s.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ voidedOptOuts: 1 }) }),
    );
  });

  it("rolls the whole write back when the cleanup fails (no half-applied state)", async () => {
    const s = setup();
    s.db.addCategory("c").addProduct("P").addProduct("V", "P").addProduct("K", "V");
    s.db.addLabel("P", "c", "INCLUDE");
    s.db.addLabel("V", "c", "INCLUDE");
    s.db.addLabel("K", "c", "EXCLUDE", "V");
    // The subtree read inside the cleanup fails once.
    jest
      .spyOn(s.prisma.forTenant().product, "findMany")
      .mockRejectedValueOnce(new Error("db down"));
    await expect(
      s.service.setLabel("V", "c", { mode: "EXCLUDE", reason: "x" }, user),
    ).rejects.toThrow("db down");
    expect(s.db.label("V", "c")!.mode).toBe("INCLUDE"); // the flip was rolled back
    expect(s.db.label("K", "c")).toBeDefined();
    expect(s.audit.log).not.toHaveBeenCalled();
  });
});

describe("ProductLabelsAdminService — removeLabel (B581: an INCLUDE that stops reaching a subtree voids the opt-outs that depended on it)", () => {
  it("voids a child's opt-out, and re-adding the label later does NOT leave the child exempt", async () => {
    const s = family();
    s.db.addLabel("P", "c", "INCLUDE");
    s.db.addLabel("V", "c", "EXCLUDE", "P");
    const out = await s.service.removeLabel("P", "c", user);
    expect(out).toEqual({ removed: true, clearedOptOuts: 1 });
    expect(s.db.label("V", "c")).toBeUndefined();

    await s.service.setLabel("P", "c", { mode: "INCLUDE" }, user); // "I removed that by mistake"
    expect(await effective(s, "V")).toEqual(["c"]); // the ban is back — V is NOT silently exempt
    expect(s.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "product_label.removed",
        meta: expect.objectContaining({ categoryId: "c", clearedOptOuts: 1 }),
      }),
    );
  });

  it("reaches a GRANDchild whose parent carries no row of its own", async () => {
    const s = family();
    s.db.addLabel("GP", "c", "INCLUDE");
    s.db.addLabel("V", "c", "EXCLUDE", "P");
    expect((await s.service.removeLabel("GP", "c", user)).clearedOptOuts).toBe(1);
    expect(s.db.label("V", "c")).toBeUndefined();
  });

  it("KEEPS an opt-out whose label still reaches the parent from a higher ancestor", async () => {
    const s = setup();
    s.db
      .addCategory("c")
      .addProduct("GG")
      .addProduct("GP", "GG")
      .addProduct("P", "GP")
      .addProduct("V", "P");
    s.db.addLabel("GG", "c", "INCLUDE");
    s.db.addLabel("GP", "c", "INCLUDE");
    s.db.addLabel("V", "c", "EXCLUDE", "P");
    const out = await s.service.removeLabel("GP", "c", user);
    expect(out.clearedOptOuts).toBe(0);
    expect(s.db.label("V", "c")).toBeDefined();
    expect(await effective(s, "V")).toEqual([]); // still opted out of GG's label
  });

  it("touches only the same category's opt-outs and only this subtree", async () => {
    const s = family();
    s.db.addCategory("d", "THC").addProduct("Other").addProduct("OV", "Other");
    s.db.addLabel("P", "c", "INCLUDE");
    s.db.addLabel("V", "c", "EXCLUDE", "P");
    s.db.addLabel("P", "d", "INCLUDE");
    s.db.addLabel("V", "d", "EXCLUDE", "P"); // other category
    s.db.addLabel("Other", "c", "INCLUDE");
    s.db.addLabel("OV", "c", "EXCLUDE", "Other"); // other subtree
    await s.service.removeLabel("P", "c", user);
    expect(s.db.label("V", "c")).toBeUndefined();
    expect(s.db.label("V", "d")).toBeDefined();
    expect(s.db.label("OV", "c")).toBeDefined();
  });

  it("removing an opt-out (EXCLUDE) strands nothing and deletes only that row", async () => {
    const s = family();
    s.db.addLabel("P", "c", "INCLUDE");
    s.db.addLabel("V", "c", "EXCLUDE", "P");
    const out = await s.service.removeLabel("V", "c", user);
    expect(out.clearedOptOuts).toBe(0);
    expect(s.db.label("P", "c")).toBeDefined();
    expect(await effective(s, "V")).toEqual(["c"]);
  });

  it("fails closed when the ancestry can't be resolved: every opt-out below is voided", async () => {
    const s = setup();
    s.db.addCategory("c").addProduct("FP", null, "t2").addProduct("R", "FP").addProduct("K", "R");
    s.db.addLabel("R", "c", "INCLUDE");
    s.db.addLabel("K", "c", "EXCLUDE", "R");
    const out = await s.service.removeLabel("R", "c", user);
    expect(out.clearedOptOuts).toBe(1);
    expect(s.db.label("K", "c")).toBeUndefined();
  });

  it("404s when the product does not carry the label, deleting nothing", async () => {
    const s = family();
    s.db.addLabel("V", "c", "EXCLUDE", "P");
    await expect(s.service.removeLabel("P", "c", user)).rejects.toBeInstanceOf(NotFoundException);
    expect(s.db.labels).toHaveLength(1);
  });

  it("the subtree walk terminates on a parent cycle", async () => {
    const s = setup();
    s.db.addCategory("c").addProduct("A", "B").addProduct("B", "A");
    s.db.addLabel("A", "c", "INCLUDE");
    s.db.addLabel("B", "c", "EXCLUDE", "A");
    await expect(s.service.removeLabel("A", "c", user)).resolves.toEqual({
      removed: true,
      clearedOptOuts: 1,
    });
  });
});

describe("ProductLabelsAdminService — getForProduct", () => {
  it("a standalone product lists its own labels and never resolves ancestors", async () => {
    const s = family();
    s.db.addLabel("GP", "c", "INCLUDE");
    const spy = jest.spyOn(s.labels, "effectiveLabels");
    const out = await s.service.getForProduct("GP");
    expect(spy).not.toHaveBeenCalled();
    expect(out).toMatchObject({ parentProductId: null, ancestryResolvable: true, inherited: [] });
    expect(out.own).toHaveLength(1);
  });

  it("a variant inherits the parent's EFFECTIVE set — through a grandparent — with names", async () => {
    const s = family();
    s.db.addLabel("GP", "c", "INCLUDE");
    const out = await s.service.getForProduct("V");
    expect(out.inherited).toEqual([
      { categoryId: "c", categoryName: "Alcohol", categoryArchived: false },
    ]);
    expect(out.ancestryResolvable).toBe(true);
  });

  it("flags an unresolvable ancestry instead of silently showing a partial set", async () => {
    const s = setup();
    s.db.addCategory("c").addProduct("FP", null, "t2").addProduct("P", "FP").addProduct("V", "P");
    const out = await s.service.getForProduct("V");
    expect(out.ancestryResolvable).toBe(false);
  });

  it("an active opt-out reads optOutActive:true", async () => {
    const s = family();
    s.db.addLabel("P", "c", "INCLUDE");
    s.db.addLabel("V", "c", "EXCLUDE", "P");
    const out = await s.service.getForProduct("V");
    expect(out.own[0].optOutActive).toBe(true);
  });

  it("a legacy (unpinned) opt-out reads as inactive", async () => {
    const s = family();
    s.db.addLabel("P", "c", "INCLUDE");
    s.db.addLabel("V", "c", "EXCLUDE", null);
    expect((await s.service.getForProduct("V")).own[0].optOutActive).toBe(false);
  });
});

describe("ProductLabelsAdminService — B581 keyed on the MEMBERSHIP transition (review round)", () => {
  /** R carries c; P under R; K under P has an opt-out pinned to P. */
  function chain3() {
    const s = setup();
    s.db.addCategory("c", "Alcohol").addProduct("R").addProduct("P", "R").addProduct("K", "P");
    s.db.addLabel("R", "c", "INCLUDE");
    return s;
  }

  it("a FRESH opt-out written where the product had no row voids the opt-outs below it", async () => {
    const s = chain3();
    await s.service.setLabel("K", "c", { mode: "EXCLUDE", reason: "alcohol-free" }, user);
    // P had no row of its own; its brand-new opt-out stops R's label reaching K's whole subtree…
    await s.service.setLabel("P", "c", { mode: "EXCLUDE", reason: "family exempt" }, user);
    // …so K's opt-out cancels nothing and must be gone (it used to survive and revive on re-add).
    expect(s.db.label("K", "c")).toBeUndefined();
    await s.service.removeLabel("P", "c", user); // remove the family opt-out again
    expect(await effective(s, "K")).toEqual(["c"]); // K is NOT silently exempt
  });

  it("removing an opt-out (label starts reaching again) voids nothing", async () => {
    const s = chain3();
    await s.service.setLabel("P", "c", { mode: "EXCLUDE", reason: "family exempt" }, user);
    const out = await s.service.removeLabel("P", "c", user);
    expect(out.clearedOptOuts).toBe(0);
  });

  it("an opt-out written where the label already did NOT reach voids nothing (no-op transition)", async () => {
    const s = setup();
    s.db.addCategory("c").addProduct("P").addProduct("K", "P");
    await s.service.setLabel("P", "c", { mode: "INCLUDE" }, user);
    const out = await s.service.setLabel("K", "c", { mode: "EXCLUDE", reason: "x" }, user);
    expect(out.mode).toBe("EXCLUDE");
    expect(s.db.label("P", "c")).toBeDefined();
  });

  it("the audit row keeps WHAT was voided — including each destroyed opt-out's reason", async () => {
    const s = chain3();
    await s.service.setLabel("K", "c", { mode: "EXCLUDE", reason: "alcohol-free formula" }, user);
    await s.service.removeLabel("R", "c", user);
    const call = s.audit.log.mock.calls.find((c) => c[0].action === "product_label.removed")![0];
    expect(call.meta.clearedOptOuts).toBe(1);
    expect(call.meta.voided).toEqual([
      { id: expect.any(String), productId: "K", categoryId: "c", reason: "alcohol-free formula" },
    ]);
  });
});

describe("ProductLabelsAdminService — write serialization (review round)", () => {
  const lockIndex = (s: ReturnType<typeof setup>) =>
    s.db.calls.findIndex((c) => c.model === "$executeRaw");

  it("setLabel takes the tenant×category advisory lock before it reads any label state", async () => {
    const s = family();
    await s.service.setLabel("GP", "c", { mode: "INCLUDE" }, user);
    const i = lockIndex(s);
    expect(i).toBeGreaterThan(-1);
    expect(s.db.calls[i].op).toContain("pg_advisory_xact_lock");
    expect(s.db.calls[i].args).toEqual(["product-labels", `${TENANT}:c`]);
    // …and before the first label read/write of the transaction.
    const firstLabelOp = s.db.calls.findIndex(
      (c, idx) => idx > i - 1 && c.model === "productCategoryLabel",
    );
    expect(i).toBeLessThan(firstLabelOp);
  });

  it("removeLabel takes the same lock before reading the row", async () => {
    const s = family();
    s.db.addLabel("GP", "c", "INCLUDE");
    await s.service.removeLabel("GP", "c", user);
    const i = lockIndex(s);
    expect(i).toBeGreaterThan(-1);
    expect(s.db.calls[i].args).toEqual(["product-labels", `${TENANT}:c`]);
    expect(
      s.db.calls.findIndex((c, idx) => idx > i && c.model === "productCategoryLabel"),
    ).toBeGreaterThan(i);
  });

  it("a concurrent first write that hits the unique index becomes a 409", async () => {
    const s = family();
    const create = jest
      .spyOn(s.prisma.forTenant().productCategoryLabel, "create")
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
      );
    await expect(s.service.setLabel("GP", "c", { mode: "INCLUDE" }, user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(create).toHaveBeenCalled();
    expect(s.audit.log).not.toHaveBeenCalled();
  });
});

describe("ProductLabelsAdminService — lock budget and in-transaction checks (#990 follow-up)", () => {
  const idx = (s: ReturnType<typeof setup>, model: string, sqlPart = "") =>
    s.db.calls.findIndex(
      (c) => c.model === model && (c.op.includes(sqlPart) || c.args?.includes?.(sqlPart)),
    );

  it("bounds the lock wait well inside Prisma's 5 s budget, then restores the CALLER'S own lock_timeout", async () => {
    const s = family();
    await s.service.setLabel("GP", "c", { mode: "INCLUDE" }, user);
    const read = idx(s, "$queryRaw", "current_setting('lock_timeout')");
    const set = s.db.calls.findIndex((c) => c.op === "SET LOCAL lock_timeout = '2s'");
    const lock = idx(s, "$executeRaw", "pg_advisory_xact_lock");
    const restore = idx(s, "$executeRaw", "set_config('lock_timeout'");
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(set);
    expect(set).toBeLessThan(lock);
    expect(lock).toBeLessThan(restore);
    // restored to exactly what was read (a script's own lock_timeout survives the label lock)
    expect(s.db.calls[restore].args).toEqual(["0"]);
  });

  it.each([
    [
      "setLabel",
      (s: ReturnType<typeof setup>) => s.service.setLabel("GP", "c", { mode: "INCLUDE" }, user),
    ],
    ["removeLabel", (s: ReturnType<typeof setup>) => s.service.removeLabel("GP", "c", user)],
  ])(
    "%s: a lock timeout surfaces as a clear 409, not an opaque tx-expired error",
    async (_n, run) => {
      const s = family();
      s.db.addLabel("GP", "c", "INCLUDE");
      s.db.lockError = Object.assign(new Error("canceling statement due to lock timeout"), {
        meta: { code: "55P03" },
      });
      await expect(run(s)).rejects.toBeInstanceOf(ConflictException);
      s.db.lockError = new Error("connection reset");
      await expect(run(s)).rejects.toThrow("connection reset"); // anything else still propagates
    },
  );

  it("the category (archived / unknown) is checked INSIDE the transaction, after the lock", async () => {
    const s = family();
    s.db.addCategory("old", "Old", TENANT, new Date());
    await expect(s.service.setLabel("GP", "old", { mode: "INCLUDE" }, user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    const lock = idx(s, "$executeRaw");
    const categoryRead = s.db.calls.findIndex((c) => c.model === "productCategory");
    expect(lock).toBeGreaterThan(-1);
    expect(categoryRead).toBeGreaterThan(lock); // no category read happens before the lock is held
    expect(s.db.labels).toHaveLength(0);
  });
});

describe("ProductLabelsAdminService — owner ruling 2026-10-14: operators write labels, except a federal-covered one", () => {
  const operator = { sub: "op", username: "op", role: "OPERATOR" } as JwtPayload;
  const admin = { sub: "ad", username: "ad", role: "TENANT_ADMIN" } as JwtPayload;
  const FROM = new Date("2026-01-01T00:00:00Z");
  const federalLegacy = { jurisdiction: "FEDERAL", categoryId: "c", targets: [] };
  const federalTarget = {
    jurisdiction: "FEDERAL",
    categoryId: "other",
    targets: [{ productId: null, categoryId: "c", addedAt: FROM, removedAt: null }],
  };
  const COPY = "Only an account admin can change (or lift) a federal rule.";

  it.each([
    ["a legacy categoryId rule", federalLegacy],
    ["an active target-row rule", federalTarget],
  ])("an operator adding a label %s covers: 403, nothing written", async (_, rule) => {
    const s = family();
    s.db.rules.push(rule);
    await expect(s.service.setLabel("GP", "c", { mode: "INCLUDE" }, operator)).rejects.toThrow(
      COPY,
    );
    expect(s.db.labels).toHaveLength(0);
  });

  it("an operator removing a federal-covered label: 403, the row stays", async () => {
    const s = family();
    await s.service.setLabel("GP", "c", { mode: "INCLUDE" }, admin);
    s.db.rules.push(federalLegacy);
    await expect(s.service.removeLabel("GP", "c", operator)).rejects.toThrow(COPY);
    expect(s.db.labels).toHaveLength(1);
  });

  it("an operator opting a variant out of a federal-covered label: 403", async () => {
    const s = family();
    await s.service.setLabel("GP", "c", { mode: "INCLUDE" }, admin);
    s.db.rules.push(federalTarget);
    await expect(
      s.service.setLabel("V", "c", { mode: "EXCLUDE", reason: "not this one" }, operator),
    ).rejects.toThrow(COPY);
    expect(s.db.labels.filter((l) => l.mode === "EXCLUDE")).toHaveLength(0);
  });

  it("an operator on a STATE-only label is allowed (add and remove)", async () => {
    const s = family();
    s.db.rules.push({ jurisdiction: "STATE", categoryId: "c", targets: [] });
    await s.service.setLabel("GP", "c", { mode: "INCLUDE" }, operator);
    expect(s.db.labels).toHaveLength(1);
    await s.service.removeLabel("GP", "c", operator);
    expect(s.db.labels).toHaveLength(0);
  });

  it("a target row REMOVED from the federal rule no longer protects the label", async () => {
    const s = family();
    s.db.rules.push({
      jurisdiction: "FEDERAL",
      categoryId: "other",
      targets: [{ productId: null, categoryId: "c", addedAt: FROM, removedAt: FROM }],
    });
    await s.service.setLabel("GP", "c", { mode: "INCLUDE" }, operator);
    expect(s.db.labels).toHaveLength(1);
  });

  it("an account admin writes a federal-covered label", async () => {
    const s = family();
    s.db.rules.push(federalLegacy);
    await s.service.setLabel("GP", "c", { mode: "INCLUDE" }, admin);
    await s.service.removeLabel("GP", "c", admin);
    expect(s.db.labels).toHaveLength(0);
  });

  it("the federal check runs AFTER the category lock", async () => {
    const s = family();
    await s.service.setLabel("GP", "c", { mode: "INCLUDE" }, operator);
    const ops = s.db.calls.map((c) => `${c.model}.${c.op}`);
    const rule = ops.indexOf("sellingRestriction.findMany");
    expect(rule).toBeGreaterThan(-1);
    expect(ops.slice(0, rule).some((o) => /lock|queryRaw|executeRaw/i.test(o))).toBe(true);
  });
});

describe("ProductLabelsAdminService — getForProduct lists the labels a federal rule covers (owner ruling 2026-10-14)", () => {
  it("returns the federal-covered label ids (legacy and active target rows), never a STATE rule's or a removed target's", async () => {
    const s = family();
    const FROM = new Date("2026-01-01T00:00:00Z");
    s.db.rules.push(
      { jurisdiction: "FEDERAL", categoryId: "c", targets: [] },
      {
        jurisdiction: "FEDERAL",
        categoryId: "x",
        targets: [
          { productId: null, categoryId: "t1", addedAt: FROM, removedAt: null },
          { productId: null, categoryId: "gone", addedAt: FROM, removedAt: FROM },
        ],
      },
      { jurisdiction: "STATE", categoryId: "s", targets: [] },
    );
    const out = await s.service.getForProduct("V");
    expect(out.federalCategoryIds).toEqual(["c", "t1"]);
  });
});
