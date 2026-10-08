import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { UnitsService } from "./units.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const user = { sub: "u1", username: "admin" } as JwtPayload;
const T = "t1";

function stubs() {
  const order: string[] = [];
  const db = {
    tenantUnit: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    product: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn(),
    },
    productUnit: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn(),
    },
  };
  const prisma = {
    getTenantId: jest.fn().mockReturnValue(T),
    forTenant: jest.fn().mockReturnValue(db),
    tenantTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const out = await fn(db);
      order.push("tx-end");
      return out;
    }),
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const audit = {
    log: jest.fn(async () => {
      order.push("audit");
    }),
  };
  return { db, prisma, audit, order };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: "u1",
  name: "Case",
  nameKey: "case",
  tenantId: T,
  archivedAt: null,
  ...over,
});
const dtoRow = (over: Record<string, unknown> = {}) => ({
  id: "u1",
  name: "Case",
  archivedAt: null,
  productCount: 0,
  ...over,
});

function make() {
  const s = stubs();
  const service = new UnitsService(s.prisma as never, s.audit as never);
  return { service, ...s };
}

describe("UnitsService", () => {
  describe("tenant scope", () => {
    it("refuses without a tenant context (the JWT is the only source)", async () => {
      const { service, prisma } = make();
      prisma.getTenantId.mockReturnValue(null);
      await expect(service.list(false)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.create({ name: "Case" }, user)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.update("u1", { name: "Box" }, user)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("a cross-tenant id is a 404 on rename and on archive (lookup is scoped to the JWT tenant)", async () => {
      const { service, db } = make();
      db.tenantUnit.findFirst.mockResolvedValue(null);
      await expect(service.update("other-tenant-id", { name: "Box" }, user)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        service.update("other-tenant-id", { archived: true }, user),
      ).rejects.toBeInstanceOf(NotFoundException);
      for (const call of db.tenantUnit.findFirst.mock.calls) {
        expect(call[0].where.tenantId).toBe(T);
      }
      expect(db.tenantUnit.findFirst.mock.calls).toHaveLength(2);
      expect(db.tenantUnit.updateMany).not.toHaveBeenCalled();
    });

    it("ignores a body tenantId: writes carry the JWT tenant", async () => {
      const { service, db, prisma } = make();
      db.tenantUnit.create.mockResolvedValue(row());
      prisma.$queryRaw.mockResolvedValue([dtoRow()]);
      await service.create({ name: "Case", tenantId: "evil" } as never, user);
      expect(db.tenantUnit.create.mock.calls[0][0].data.tenantId).toBe(T);
    });
  });

  describe("list", () => {
    it("hides archived by default; includeArchived returns them (one raw query, not per row)", async () => {
      const { service, prisma } = make();
      prisma.$queryRaw.mockResolvedValue([
        { id: "u1", name: "Case", archivedAt: null, productCount: 12 },
      ]);
      const out = await service.list(false);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const sql = (prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql).sql;
      expect(sql).toContain('"archivedAt" IS NULL');
      expect(out).toEqual([dtoRow({ productCount: 12 })]);

      prisma.$queryRaw.mockClear();
      prisma.$queryRaw.mockResolvedValue([
        { id: "u2", name: "Pallet", archivedAt: new Date("2026-10-01T00:00:00Z"), productCount: 0 },
      ]);
      const all = await service.list(true);
      expect((prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql).sql).not.toContain(
        '"archivedAt" IS NULL',
      );
      expect(all[0].archivedAt).toBe("2026-10-01T00:00:00.000Z");
    });

    it("counts DISTINCT products across ProductUnit.label (via tenantUnitId), baseUnitLabel, packLabel and unit by nameKey", async () => {
      const { service, prisma } = make();
      await service.list(true);
      const sql = (prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql).sql;
      expect(sql).toContain("UNION");
      expect(sql).toContain('"tenantUnitId"');
      for (const col of ['"baseUnitLabel"', '"packLabel"', '"unit"']) expect(sql).toContain(col);
      expect(sql).toContain('"tenantId"');
    });
  });

  describe("create", () => {
    it.each([
      ["", "Enter a name."],
      ["   ", "Enter a name."],
      ["x".repeat(31), "Keep it to 30 characters or fewer."],
    ])("rejects %j with a 400 and the exact message", async (name, message) => {
      const { service, db } = make();
      await expect(service.create({ name }, user)).rejects.toMatchObject({
        status: 400,
        message,
      });
      expect(db.tenantUnit.create).not.toHaveBeenCalled();
    });

    it("trims, stores the nameKey as lower(trim(name)), and returns the row", async () => {
      const { service, db, prisma } = make();
      db.tenantUnit.create.mockResolvedValue(row({ name: "Half Case", nameKey: "half case" }));
      prisma.$queryRaw.mockResolvedValue([dtoRow({ name: "Half Case" })]);
      const out = await service.create({ name: "  Half Case  " }, user);
      expect(db.tenantUnit.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ tenantId: T, name: "Half Case", nameKey: "half case" }),
      );
      expect(out.name).toBe("Half Case");
    });

    it("is idempotent by nameKey: the same name in another case returns the existing row, no create, no 409", async () => {
      const { service, db, prisma } = make();
      db.tenantUnit.findFirst.mockResolvedValue(row());
      prisma.$queryRaw.mockResolvedValue([dtoRow({ productCount: 4 })]);
      const out = await service.create({ name: "CASE" }, user);
      expect(db.tenantUnit.findFirst.mock.calls[0][0].where).toEqual({
        tenantId: T,
        nameKey: "case",
      });
      expect(db.tenantUnit.create).not.toHaveBeenCalled();
      expect(out).toEqual(dtoRow({ productCount: 4 }));
    });

    it("two concurrent creates of one name end as ONE row: a P2002 loser re-reads the winner", async () => {
      const { service, db, prisma } = make();
      db.tenantUnit.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(row());
      db.tenantUnit.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
      );
      prisma.$queryRaw.mockResolvedValue([dtoRow()]);
      await expect(service.create({ name: "Case" }, user)).resolves.toEqual(dtoRow());
    });

    it("R4: a name matching an ARCHIVED row restores it (same id) and audits the restore", async () => {
      const { service, db, prisma, audit } = make();
      const archivedAt = new Date("2026-10-01T00:00:00Z");
      db.tenantUnit.findFirst.mockResolvedValue(row({ archivedAt }));
      prisma.$queryRaw.mockResolvedValue([dtoRow({ productCount: 2 })]);
      const out = await service.create({ name: "case" }, user);
      expect(db.tenantUnit.create).not.toHaveBeenCalled();
      expect(db.tenantUnit.updateMany).toHaveBeenCalledWith({
        where: { id: "u1", tenantId: T },
        data: { archivedAt: null },
      });
      expect(out.id).toBe("u1");
      expect(out.archivedAt).toBeNull();
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: T,
          userId: "u1",
          action: "tenant_unit.restored",
          entityType: "TenantUnit",
          entityId: "u1",
        }),
      );
    });

    it("an active duplicate writes no audit row", async () => {
      const { service, db, prisma, audit } = make();
      db.tenantUnit.findFirst.mockResolvedValue(row());
      prisma.$queryRaw.mockResolvedValue([dtoRow()]);
      await service.create({ name: "Case" }, user);
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe("update: argument rules", () => {
    it("needs exactly one of name / archived", async () => {
      const { service } = make();
      await expect(service.update("u1", {}, user)).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.update("u1", { name: "Box", archived: true }, user),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ["", "Enter a name."],
      ["y".repeat(31), "Keep it to 30 characters or fewer."],
    ])("rename to %j is a 400", async (name, message) => {
      const { service } = make();
      await expect(service.update("u1", { name }, user)).rejects.toMatchObject({
        status: 400,
        message,
      });
    });
  });

  describe("rename (one transaction, match by nameKey)", () => {
    function seedRename(
      h: ReturnType<typeof make>,
      opts: {
        products: Array<Record<string, unknown>>;
        levels: Array<Record<string, unknown>>;
        linked?: Array<{ id: string; productId: string }>;
      },
    ) {
      h.db.tenantUnit.findFirst.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) => (where.id === "u1" ? row() : null),
      );
      h.db.tenantUnit.update.mockImplementation(async ({ data }: { data: object }) =>
        row(data as Record<string, unknown>),
      );
      h.db.productUnit.findMany.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) =>
          where.tenantUnitId ? (opts.linked ?? []) : opts.levels,
      );
      h.db.product.findMany.mockResolvedValue(opts.products);
    }
    const productsUpdateCalls = (h: ReturnType<typeof make>, key: string) =>
      h.db.product.updateMany.mock.calls.filter(([a]) => key in a.data);

    it("updates level labels, baseUnitLabel, packLabel and unit together, and returns the DISTINCT product count", async () => {
      const h = make();
      seedRename(h, {
        linked: [
          { id: "l1", productId: "p1" },
          { id: "l2", productId: "p2" },
        ],
        products: [
          { id: "p1", name: "Gift Box", baseUnitLabel: null, packLabel: " CASE ", unit: "case" },
          { id: "p2", name: "Mug", baseUnitLabel: "Case", packLabel: null, unit: "Each" },
          { id: "p3", name: "Cup", baseUnitLabel: null, packLabel: null, unit: "Case" },
        ],
        levels: [
          { productId: "p1", label: "Case", tenantUnitId: "u1" },
          { productId: "p2", label: "Case", tenantUnitId: "u1" },
        ],
      });
      const out = await h.service.update("u1", { name: " Carton " }, user);
      expect(h.prisma.tenantTransaction).toHaveBeenCalledTimes(1);
      expect(h.db.tenantUnit.update.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ name: "Carton", nameKey: "carton" }),
      );
      expect(h.db.productUnit.updateMany).toHaveBeenCalledWith({
        where: { tenantId: T, tenantUnitId: "u1" },
        data: { label: "Carton" },
      });
      expect(productsUpdateCalls(h, "packLabel")[0][0].where.id.in).toEqual(["p1"]);
      expect(productsUpdateCalls(h, "baseUnitLabel")[0][0].where.id.in).toEqual(["p2"]);
      expect(productsUpdateCalls(h, "unit")[0][0].where.id.in.sort()).toEqual(["p1", "p3"]);
      for (const [a] of h.db.product.updateMany.mock.calls) expect(a.where.tenantId).toBe(T);
      expect(out.productsUpdated).toBe(3);
      expect(out.unit).toEqual(expect.objectContaining({ id: "u1", name: "Carton" }));
    });

    it("writes nothing to line snapshots: only TenantUnit, ProductUnit and Product are touched", async () => {
      const h = make();
      seedRename(h, { products: [], levels: [] });
      await h.service.update("u1", { name: "Carton" }, user);
      expect(Object.keys(h.db).sort()).toEqual(["product", "productUnit", "tenantUnit"]);
    });

    it("a collision inside one product refuses the WHOLE rename (409, names the products, nothing written)", async () => {
      const h = make();
      seedRename(h, {
        linked: [
          { id: "l1", productId: "p1" },
          { id: "l2", productId: "p2" },
        ],
        products: [
          { id: "p1", name: "Gift Box", baseUnitLabel: null, packLabel: null, unit: "Case" },
          { id: "p2", name: "Mug", baseUnitLabel: null, packLabel: null, unit: "Case" },
        ],
        levels: [
          { productId: "p1", label: "Case", tenantUnitId: "u1" },
          { productId: "p1", label: "Carton", tenantUnitId: null },
          { productId: "p2", label: "Case", tenantUnitId: "u1" },
        ],
      });
      const err = await h.service.update("u1", { name: "Carton" }, user).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({
          code: "UNIT_RENAME_COLLISION",
          products: [{ id: "p1", name: "Gift Box" }],
        }),
      );
      expect(h.db.tenantUnit.update).not.toHaveBeenCalled();
      expect(h.db.productUnit.updateMany).not.toHaveBeenCalled();
      expect(h.db.product.updateMany).not.toHaveBeenCalled();
      expect(h.audit.log).not.toHaveBeenCalled();
    });

    it("base or pack that would share the new name with another level also collides", async () => {
      const h = make();
      seedRename(h, {
        products: [
          { id: "p1", name: "Mug", baseUnitLabel: "Carton", packLabel: "Case", unit: "Case" },
        ],
        levels: [],
      });
      await expect(h.service.update("u1", { name: "carton" }, user)).rejects.toMatchObject({
        response: expect.objectContaining({ code: "UNIT_RENAME_COLLISION" }),
      });
      expect(h.db.product.updateMany).not.toHaveBeenCalled();
    });

    it("a rename onto the product's PACK word (Product.unit) refuses the whole rename (409)", async () => {
      // "Crate" is p1's pack word: resolveLadderLevel lets the pack win, so a level renamed to it
      // would be unreachable and every new "Crate" line would price at the pack factor.
      const h = make();
      seedRename(h, {
        linked: [{ id: "l1", productId: "p1" }],
        products: [
          { id: "p1", name: "Mug", baseUnitLabel: null, packLabel: null, unit: " crate " },
        ],
        levels: [{ productId: "p1", label: "Case", tenantUnitId: "u1" }],
      });
      const err = await h.service.update("u1", { name: "Crate" }, user).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({
          code: "UNIT_RENAME_COLLISION",
          products: [{ id: "p1", name: "Mug" }],
        }),
      );
      expect(h.db.tenantUnit.update).not.toHaveBeenCalled();
      expect(h.db.productUnit.updateMany).not.toHaveBeenCalled();
    });

    it("a blank Product.unit is the implicit pack word Box, so a level cannot be renamed to Box", async () => {
      const h = make();
      seedRename(h, {
        linked: [{ id: "l1", productId: "p1" }],
        products: [{ id: "p1", name: "Mug", baseUnitLabel: null, packLabel: null, unit: null }],
        levels: [{ productId: "p1", label: "Case", tenantUnitId: "u1" }],
      });
      await expect(h.service.update("u1", { name: "BOX" }, user)).rejects.toMatchObject({
        response: expect.objectContaining({ code: "UNIT_RENAME_COLLISION" }),
      });
      expect(h.db.productUnit.updateMany).not.toHaveBeenCalled();
    });

    it("a unit that IS the pack word renames with it: no self-collision", async () => {
      const h = make();
      seedRename(h, {
        products: [{ id: "p1", name: "Mug", baseUnitLabel: null, packLabel: null, unit: "Case" }],
        levels: [],
      });
      await expect(h.service.update("u1", { name: "Carton" }, user)).resolves.toBeDefined();
      expect(productsUpdateCalls(h, "unit")[0][0].where.id.in).toEqual(["p1"]);
    });

    it("the 409 names at most 10 products", async () => {
      const h = make();
      const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
      seedRename(h, {
        linked: ids.map((productId, i) => ({ id: `l${i}`, productId })),
        products: ids.map((id) => ({
          id,
          name: `Name ${id}`,
          baseUnitLabel: null,
          packLabel: null,
          unit: "Each",
        })),
        levels: ids.flatMap((productId) => [
          { productId, label: "Case", tenantUnitId: "u1" },
          { productId, label: "Carton", tenantUnitId: null },
        ]),
      });
      const err = await h.service.update("u1", { name: "Carton" }, user).catch((e) => e);
      expect(err.getResponse().products).toHaveLength(10);
    });

    it("renaming to a name another row already has (archived or not) is 409 UNIT_NAME_TAKEN", async () => {
      const h = make();
      h.db.tenantUnit.findFirst.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) =>
          where.id === "u1" ? row() : row({ id: "u2", name: "Box", nameKey: "box" }),
      );
      const err = await h.service.update("u1", { name: "BOX" }, user).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual(expect.objectContaining({ code: "UNIT_NAME_TAKEN" }));
      expect(h.db.tenantUnit.update).not.toHaveBeenCalled();
    });

    it("the clash lookup excludes the row itself, so a case-only change is allowed", async () => {
      const h = make();
      seedRename(h, { products: [], levels: [] });
      await h.service.update("u1", { name: "CASE" }, user);
      const clash = h.db.tenantUnit.findFirst.mock.calls.find(([a]) => a.where.nameKey)![0];
      expect(clash.where).toEqual(expect.objectContaining({ nameKey: "case", id: { not: "u1" } }));
      expect(h.db.tenantUnit.update).toHaveBeenCalled();
    });

    it("a P2002 from the unique index (concurrent rename) maps to UNIT_NAME_TAKEN", async () => {
      const h = make();
      seedRename(h, { products: [], levels: [] });
      h.db.tenantUnit.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
      );
      await expect(h.service.update("u1", { name: "Carton" }, user)).rejects.toMatchObject({
        response: expect.objectContaining({ code: "UNIT_NAME_TAKEN" }),
      });
    });

    it("audits ONCE, AFTER the transaction commits, with old and new name and the count", async () => {
      const h = make();
      seedRename(h, {
        linked: [{ id: "l1", productId: "p1" }],
        products: [{ id: "p1", name: "Mug", baseUnitLabel: null, packLabel: null, unit: "Each" }],
        levels: [{ productId: "p1", label: "Case", tenantUnitId: "u1" }],
      });
      await h.service.update("u1", { name: "Carton" }, user);
      expect(h.order).toEqual(["tx-end", "audit"]);
      expect(h.audit.log).toHaveBeenCalledTimes(1);
      expect(h.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: T,
          userId: "u1",
          action: "tenant_unit.renamed",
          entityType: "TenantUnit",
          entityId: "u1",
          meta: expect.objectContaining({ from: "Case", to: "Carton", productsUpdated: 1 }),
        }),
      );
    });
  });

  describe("archive / restore", () => {
    it("archive sets archivedAt, changes no product row, audits after the write", async () => {
      const h = make();
      h.db.tenantUnit.findFirst.mockResolvedValue(row());
      h.prisma.$queryRaw.mockResolvedValue([dtoRow({ productCount: 40 })]);
      const out = await h.service.update("u1", { archived: true }, user);
      const call = h.db.tenantUnit.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: "u1", tenantId: T });
      expect(call.data.archivedAt).toBeInstanceOf(Date);
      expect(h.db.product.updateMany).not.toHaveBeenCalled();
      expect(h.db.productUnit.updateMany).not.toHaveBeenCalled();
      expect(out.productsUpdated).toBe(0);
      expect(h.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "tenant_unit.archived",
          meta: expect.objectContaining({ name: "Case", productCount: 40 }),
        }),
      );
    });

    it("restore clears archivedAt and audits", async () => {
      const h = make();
      h.db.tenantUnit.findFirst.mockResolvedValue(row({ archivedAt: new Date() }));
      h.prisma.$queryRaw.mockResolvedValue([dtoRow()]);
      await h.service.update("u1", { archived: false }, user);
      expect(h.db.tenantUnit.updateMany.mock.calls[0][0].data).toEqual({ archivedAt: null });
      expect(h.db.product.updateMany).not.toHaveBeenCalled();
      expect(h.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "tenant_unit.restored" }),
      );
    });
  });
});
