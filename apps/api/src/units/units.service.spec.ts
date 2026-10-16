import { lockCalls } from "../testing/lock-calls";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { UnitsService } from "./units.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const user = { sub: "u1", username: "admin" } as JwtPayload;
const T = "t1";

function stubs() {
  const order: string[] = [];
  const db = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([]),
    tenantUnit: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      // Active units of the tenant (SA-810 cap): well under the 200 cap unless a test says otherwise.
      count: jest.fn().mockResolvedValue(3),
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
    auditLog: {
      create: jest.fn(async () => {
        order.push("tx-audit");
      }),
    },
  };
  const prisma = {
    getTenantId: jest.fn().mockReturnValue(T),
    forTenant: jest.fn().mockReturnValue(db),
    tenantTransaction: jest.fn(
      async (fn: (tx: unknown) => Promise<unknown>, _options?: unknown) => {
        const out = await fn(db);
        order.push("tx-end");
        return out;
      },
    ),
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
      await expect(service.list()).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.listArchived()).rejects.toBeInstanceOf(BadRequestException);
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
    it("list() is the ACTIVE units (one raw query, not per row); listArchived() pages the archived ones", async () => {
      const { service, prisma } = make();
      prisma.$queryRaw.mockResolvedValue([
        { id: "u1", name: "Case", archivedAt: null, productCount: 12, sortKey: "case" },
      ]);
      const out = await service.list();
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const sql = (prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql).sql;
      expect(sql).toContain('"archivedAt" IS NULL');
      expect(sql).not.toContain("LIMIT");
      expect(out).toEqual([dtoRow({ productCount: 12 })]);

      prisma.$queryRaw.mockClear();
      prisma.$queryRaw.mockResolvedValue([
        { id: "u2", name: "Pallet", archivedAt: new Date("2026-10-01T00:00:00Z"), productCount: 0 },
      ]);
      const page = await service.listArchived();
      expect((prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql).sql).toContain(
        '"archivedAt" IS NOT NULL',
      );
      expect(page.items[0].archivedAt).toBe("2026-10-01T00:00:00.000Z");
      expect(page.nextCursor).toBeNull();
    });

    it("counts DISTINCT products across ProductUnit.label (via tenantUnitId), baseUnitLabel, packLabel and unit by nameKey", async () => {
      const { service, prisma } = make();
      await service.list();
      const sql = (prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql).sql;
      expect(sql).toContain("UNION");
      expect(sql).toContain('"tenantUnitId"');
      for (const col of ['"baseUnitLabel"', '"packLabel"', '"unit"']) expect(sql).toContain(col);
      expect(sql).toContain('"tenantId"');
    });

    it("the SQL trim set uses only escapes PostgreSQL E-strings define (there is NO \\v: it reads as a literal v)", async () => {
      const { service, prisma } = make();
      await service.list();
      const sql = (prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql).sql;
      const trimSets = sql.match(/E'[^']*'/g) ?? [];
      expect(trimSets).toHaveLength(3);
      for (const set of trimSets) {
        expect(set).not.toMatch(/\\v/);
        expect(set).toContain("\\u000b");
        expect(set).toContain("\\u00a0");
      }
    });

    it("compares the text columns to nameKey through the same NFC normalisation", async () => {
      const { service, prisma } = make();
      await service.list();
      const sql = (prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql).sql;
      expect(sql.match(/normalize\(/g)).toHaveLength(3);
    });
  });

  describe("SA-810 G6e: ONE grouped usage query (not a correlated subquery per unit)", () => {
    const unitRows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `u${i}`,
        name: `Unit ${i}`,
        archivedAt: null,
        productCount: i,
        sortKey: `unit ${i}`,
      }));

    it.each([1, 200])("list() makes exactly one $queryRaw for %i unit(s)", async (n) => {
      const { service, prisma, db } = make();
      prisma.$queryRaw.mockResolvedValue(unitRows(n));
      const out = await service.list();
      expect(out).toHaveLength(n);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it("the query is the grouped shape: FK rows UNION text matches via LATERAL VALUES of the 3 keys, joined on nameKey, GROUP BY u.id", async () => {
      const { service, prisma } = make();
      await service.list();
      const sql = (prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql).sql.replace(/\s+/g, " ");
      // No per-unit correlation: the ProductUnit branch is filtered by tenant, not by the outer unit.
      expect(sql).not.toContain('pu."tenantUnitId" = u."id"');
      expect(sql).toContain('pu."tenantId" = ?');
      expect(sql).toContain('pu."tenantUnitId" IS NOT NULL');
      expect(sql).toContain("UNION");
      expect(sql).toContain("CROSS JOIN LATERAL (VALUES (");
      expect(sql).toMatch(
        /JOIN "TenantUnit" \w+ ON \w+\."tenantId" = p\."tenantId" AND \w+\."nameKey" = k\.key/,
      );
      expect(sql).toContain('LEFT JOIN used ON used.uid = u."id"');
      expect(sql).toContain('COUNT(used.pid)::int AS "productCount"');
      expect(sql).toContain('GROUP BY u."id"');
      expect(sql).toContain('ORDER BY lower(u."name"), u."id"');
    });

    it("oneRow (create / archive results) uses the same grouped query with the id filter", async () => {
      const { service, prisma, db } = make();
      db.tenantUnit.create.mockResolvedValue(row());
      prisma.$queryRaw.mockResolvedValue([dtoRow()]);
      await service.create({ name: "Case" }, user);
      const q = prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql;
      expect(q.sql).toContain('GROUP BY u."id"');
      expect(q.sql).toContain('u."id" = ?');
      expect(q.values).toContain("u1");
    });
  });

  describe("SA-810: the archived list pages (cursor on (lower(name), id), 100 per page)", () => {
    const archivedRows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `a${String(i).padStart(3, "0")}`,
        name: `Old ${String(i).padStart(3, "0")}`,
        archivedAt: new Date("2026-10-01T00:00:00Z"),
        productCount: 0,
        sortKey: `old ${String(i).padStart(3, "0")}`,
      }));

    it("asks for 101 rows and returns 100 plus a cursor when there are more", async () => {
      const { service, prisma } = make();
      prisma.$queryRaw.mockResolvedValue(archivedRows(101));
      const page = await service.listArchived();
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const q = prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql;
      expect(q.sql).toContain("LIMIT");
      expect(q.values).toContain(101);
      expect(page.items).toHaveLength(100);
      expect(page.items[99].id).toBe("a099");
      expect(page.nextCursor).toEqual(expect.any(String));
      // The cursor resumes AFTER the last row shown, keyed by the database's own lower(name).
      prisma.$queryRaw.mockClear();
      prisma.$queryRaw.mockResolvedValue(archivedRows(3));
      const next = await service.listArchived(page.nextCursor!);
      const q2 = prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql;
      expect(q2.sql.replace(/\s+/g, " ")).toContain('(lower(u."name"), u."id") > (?, ?)');
      expect(q2.values).toEqual(expect.arrayContaining(["old 099", "a099"]));
      expect(next.nextCursor).toBeNull();
    });

    it("exactly 100 archived rows is one page with no cursor", async () => {
      const { service, prisma } = make();
      prisma.$queryRaw.mockResolvedValue(archivedRows(100));
      const page = await service.listArchived();
      expect(page.items).toHaveLength(100);
      expect(page.nextCursor).toBeNull();
    });

    it.each(["not-a-cursor", Buffer.from('{"x":1}').toString("base64url")])(
      "a malformed cursor %j is a 400, never a query",
      async (cursor) => {
        const { service, prisma } = make();
        await expect(service.listArchived(cursor)).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
      },
    );
  });

  describe("SA-810 G6a: at most 200 ACTIVE units; a person at the cap gets 409 TENANT_UNIT_LIMIT", () => {
    const limitBody = (active: number) =>
      expect.objectContaining({
        code: "TENANT_UNIT_LIMIT",
        message: `You have ${active} units. Archive one you no longer use to add another.`,
        limit: 200,
      });
    const rejectsLimit = async (p: Promise<unknown>, active = 200) => {
      const err = await p.then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toEqual(limitBody(active));
    };

    it("adding unit #201 is a 409 and writes nothing", async () => {
      const h = make();
      h.db.tenantUnit.count.mockResolvedValue(200);
      await rejectsLimit(h.service.create({ name: "Crate" }, user));
      expect(h.db.tenantUnit.create).not.toHaveBeenCalled();
      expect(h.audit.log).not.toHaveBeenCalled();
      expect(h.db.tenantUnit.count).toHaveBeenCalledWith({
        where: { tenantId: T, archivedAt: null },
      });
    });

    it("unit #200 is still allowed", async () => {
      const h = make();
      h.db.tenantUnit.count.mockResolvedValue(199);
      h.db.tenantUnit.create.mockResolvedValue(row({ name: "Crate", nameKey: "crate" }));
      h.prisma.$queryRaw.mockResolvedValue([dtoRow({ name: "Crate" })]);
      await h.service.create({ name: "Crate" }, user);
      expect(h.db.tenantUnit.create).toHaveBeenCalledTimes(1);
    });

    it("adding a name that is already ACTIVE at the cap is not an add: it returns the unit (idempotent)", async () => {
      const h = make();
      h.db.tenantUnit.count.mockResolvedValue(200);
      h.db.tenantUnit.findFirst.mockResolvedValue(row());
      h.prisma.$queryRaw.mockResolvedValue([dtoRow()]);
      await expect(h.service.create({ name: "case" }, user)).resolves.toEqual(dtoRow());
      expect(h.db.tenantUnit.create).not.toHaveBeenCalled();
    });

    it("restore at the cap is an add: 409 through Restore and through adding the archived name", async () => {
      const h = make();
      h.db.tenantUnit.count.mockResolvedValue(200);
      h.db.tenantUnit.findFirst.mockResolvedValue(row({ archivedAt: new Date() }));
      await rejectsLimit(h.service.update("u1", { archived: false }, user));
      await rejectsLimit(h.service.create({ name: "Case" }, user));
      expect(h.db.tenantUnit.updateMany).not.toHaveBeenCalled();
      expect(h.audit.log).not.toHaveBeenCalled();
    });

    it("archive one, then the add succeeds (archive frees a slot and is never capped)", async () => {
      const h = make();
      h.db.tenantUnit.count.mockResolvedValue(200);
      h.db.tenantUnit.findFirst.mockResolvedValueOnce(row({ id: "u7", name: "Tray" }));
      h.prisma.$queryRaw.mockResolvedValue([dtoRow({ id: "u7", archivedAt: new Date() })]);
      await h.service.update("u7", { archived: true }, user);
      expect(h.db.tenantUnit.updateMany).toHaveBeenCalledTimes(1);
      h.db.tenantUnit.count.mockResolvedValue(199);
      h.db.tenantUnit.findFirst.mockResolvedValue(null);
      h.db.tenantUnit.create.mockResolvedValue(row({ id: "u8", name: "Crate" }));
      h.prisma.$queryRaw.mockResolvedValue([dtoRow({ id: "u8", name: "Crate" })]);
      await expect(h.service.create({ name: "Crate" }, user)).resolves.toMatchObject({
        id: "u8",
      });
    });

    it("a grandfathered tenant at 230 keeps its rows: it can archive, but cannot add or restore", async () => {
      const h = make();
      h.db.tenantUnit.count.mockResolvedValue(230);
      h.db.tenantUnit.findFirst.mockResolvedValueOnce(row());
      h.prisma.$queryRaw.mockResolvedValue([dtoRow({ archivedAt: new Date() })]);
      await h.service.update("u1", { archived: true }, user);
      expect(h.db.tenantUnit.updateMany).toHaveBeenCalledTimes(1);
      h.db.tenantUnit.count.mockResolvedValue(229);
      h.db.tenantUnit.findFirst.mockResolvedValue(null);
      await rejectsLimit(h.service.create({ name: "Crate" }, user), 229);
      expect(h.db.tenantUnit.create).not.toHaveBeenCalled();
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

    it.each(["Piece", " piece ", "PIECES", "Each", "unit", "Pcs"])(
      "refuses %j (Piece and its synonyms are the smallest unit, always there) with a 400 and no write",
      async (name) => {
        const { service, db } = make();
        await expect(service.create({ name }, user)).rejects.toMatchObject({
          status: 400,
          message: "Piece is always there as the smallest unit.",
        });
        expect(db.tenantUnit.findFirst).not.toHaveBeenCalled();
        expect(db.tenantUnit.create).not.toHaveBeenCalled();
      },
    );

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

    it("an NFD and an NFC spelling of one word are ONE unit: both look up the NFC nameKey", async () => {
      const { service, db, prisma } = make();
      db.tenantUnit.findFirst.mockResolvedValue(row({ name: "Caf\u00e9", nameKey: "caf\u00e9" }));
      prisma.$queryRaw.mockResolvedValue([dtoRow({ name: "Caf\u00e9" })]);
      await service.create({ name: "Cafe\u0301" }, user);
      await service.create({ name: "CAF\u00c9" }, user);
      for (const call of db.tenantUnit.findFirst.mock.calls) {
        expect(call[0].where).toEqual({ tenantId: T, nameKey: "caf\u00e9" });
      }
      expect(db.tenantUnit.create).not.toHaveBeenCalled();
    });

    it("a new unit is stored NFC (name and nameKey)", async () => {
      const { service, db, prisma } = make();
      db.tenantUnit.create.mockResolvedValue(row({ name: "Caf\u00e9" }));
      prisma.$queryRaw.mockResolvedValue([dtoRow()]);
      await service.create({ name: "Cafe\u0301" }, user);
      expect(db.tenantUnit.create.mock.calls[0][0].data).toEqual({
        tenantId: T,
        name: "Caf\u00e9",
        nameKey: "caf\u00e9",
      });
    });

    it.each(["Each", "\u00a0Each\u00a0", "PIECES", "\u00a0pcs"])(
      "%j is refused as a piece synonym (NBSP-wrapped included)",
      async (name) => {
        const { service } = make();
        await expect(service.create({ name }, user)).rejects.toMatchObject({ status: 400 });
      },
    );

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
        where: { id: "u1", tenantId: T, archivedAt: { not: null } },
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

    it("a NEW unit is audited (tenant_unit.created) after the row exists", async () => {
      const { service, db, prisma, audit } = make();
      db.tenantUnit.create.mockResolvedValue(
        row({ id: "u9", name: "Half Case", nameKey: "half case" }),
      );
      prisma.$queryRaw.mockResolvedValue([dtoRow({ id: "u9", name: "Half Case" })]);
      await service.create({ name: "Half Case" }, user);
      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: T,
          userId: "u1",
          action: "tenant_unit.created",
          entityType: "TenantUnit",
          entityId: "u9",
          meta: { name: "Half Case" },
        }),
      );
    });

    it("a P2002 loser of a concurrent add writes no created row (the winner audits)", async () => {
      const { service, db, prisma, audit } = make();
      db.tenantUnit.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(row());
      db.tenantUnit.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
      );
      prisma.$queryRaw.mockResolvedValue([dtoRow()]);
      await service.create({ name: "Case" }, user);
      expect(audit.log).not.toHaveBeenCalled();
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

  describe("update: Piece words", () => {
    it.each(["Piece", "pcs", "EACH"])(
      "renaming a unit to %j is a 400 before any read or write",
      async (name) => {
        const { service, db, prisma } = make();
        await expect(service.update("u1", { name }, user)).rejects.toMatchObject({
          status: 400,
          message: "Piece is always there as the smallest unit.",
        });
        expect(prisma.tenantTransaction).not.toHaveBeenCalled();
        expect(db.tenantUnit.update).not.toHaveBeenCalled();
      },
    );
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
      // the post-commit read of the renamed unit (oneRow): the name the tx wrote, its real count
      h.prisma.$queryRaw.mockImplementation(async () => [
        dtoRow({ name: h.db.tenantUnit.update.mock.calls.at(-1)?.[0]?.data?.name ?? "Case" }),
      ]);
      h.db.productUnit.findMany.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) =>
          where.tenantUnitId ? (opts.linked ?? []) : opts.levels,
      );
      h.db.product.findMany.mockResolvedValue(opts.products);
      // The SQL text-hit query: every seeded product is a candidate (linked ones dedupe).
      h.db.$queryRaw.mockResolvedValue(opts.products.map((p) => ({ id: p.id })));
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

    it("gate nit 3: the renamed unit's productCount is the REAL count read after commit, not productsUpdated", async () => {
      const h = make();
      seedRename(h, {
        products: [{ id: "p1", name: "Cup", baseUnitLabel: null, packLabel: null, unit: "Case" }],
        levels: [],
      });
      // A product that already sold by the word "Carton" (no unit of that name existed) now counts under it too.
      h.prisma.$queryRaw.mockResolvedValue([dtoRow({ name: "Carton", productCount: 2 })]);
      const out = await h.service.update("u1", { name: "Carton" }, user);
      expect(out.productsUpdated).toBe(1);
      expect(out.unit).toEqual(dtoRow({ name: "Carton", productCount: 2 }));
      // read after the transaction committed, scoped to this tenant and unit
      expect(h.order.indexOf("tx-end")).toBeGreaterThan(-1);
      expect(h.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it("takes the tenant's EXCLUSIVE units lock before reading anything, so no pack edit or level write interleaves", async () => {
      const h = make();
      seedRename(h, { products: [], levels: [] });
      await h.service.update("u1", { name: "Carton" }, user);
      const locks = lockCalls(h.db.$executeRaw);
      expect(locks.calls).toHaveLength(1);
      const [strings, ...values] = locks.calls[0];
      const sql = strings.join("?");
      expect(sql).toContain("pg_advisory_xact_lock(");
      expect(sql).not.toContain("_shared");
      expect(values).toEqual(["tenant-units", T]);
      // the wait is bounded (5 s) and the bound is set BEFORE the lock
      expect((h.db.$executeRaw.mock.calls[0][0] as TemplateStringsArray).join("?")).toBe(
        "SET LOCAL lock_timeout = '5s'",
      );
      expect(locks.order[0]).toBeLessThan(h.db.tenantUnit.findFirst.mock.invocationCallOrder[0]);
    });

    it("an archive or an add takes no units lock (only a rename relabels products)", async () => {
      const h = make();
      h.db.tenantUnit.findFirst.mockResolvedValue(row());
      h.prisma.$queryRaw.mockResolvedValue([dtoRow()]);
      await h.service.update("u1", { archived: true }, user);
      expect(h.db.$executeRaw).not.toHaveBeenCalled();
    });

    it("writes nothing to line snapshots: only TenantUnit, ProductUnit, Product and the audit row are touched", async () => {
      const h = make();
      seedRename(h, { products: [], levels: [] });
      await h.service.update("u1", { name: "Carton" }, user);
      expect(
        Object.keys(h.db)
          .filter((k) => !k.startsWith("$"))
          .sort(),
      ).toEqual(["auditLog", "product", "productUnit", "tenantUnit"]);
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

    it("a rename of a product's BASE label onto its pack word refuses the whole rename (409)", async () => {
      // No level is linked: the product holds the old name only as baseUnitLabel, and "Crate" is
      // its pack word. The base would read the same as the pack, so the rename is refused.
      const h = make();
      seedRename(h, {
        products: [
          { id: "p1", name: "Mug", baseUnitLabel: "Case", packLabel: null, unit: " crate " },
        ],
        levels: [],
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
      expect(h.db.product.updateMany).not.toHaveBeenCalled();
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

    it.each([["Carton"], ["CASE"]])(
      "two levels of ONE product linked to the unit (Case + case) refuse a rename to %s (409), never a P2002 500",
      async (name) => {
        const h = make();
        seedRename(h, {
          linked: [
            { id: "l1", productId: "p1" },
            { id: "l2", productId: "p1" },
          ],
          products: [{ id: "p1", name: "Mug", baseUnitLabel: null, packLabel: null, unit: "Each" }],
          levels: [
            { productId: "p1", label: "Case", tenantUnitId: "u1" },
            { productId: "p1", label: "case", tenantUnitId: "u1" },
          ],
        });
        // What the unique index would do if the whole-unit relabel were attempted.
        h.db.productUnit.updateMany.mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
        );
        const err = await h.service.update("u1", { name }, user).catch((e) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getResponse()).toEqual(
          expect.objectContaining({
            code: "UNIT_RENAME_COLLISION",
            products: [{ id: "p1", name: "Mug" }],
          }),
        );
        expect(h.db.tenantUnit.update).not.toHaveBeenCalled();
      },
    );

    it("NFC and NFD spellings of one word collide: a level typed Cafe+U+0301 blocks a rename to Caf\u00e9", async () => {
      const h = make();
      seedRename(h, {
        linked: [{ id: "l1", productId: "p1" }],
        products: [{ id: "p1", name: "Mug", baseUnitLabel: null, packLabel: null, unit: "Each" }],
        levels: [
          { productId: "p1", label: "Case", tenantUnitId: "u1" },
          { productId: "p1", label: "Cafe\u0301", tenantUnitId: null },
        ],
      });
      await expect(h.service.update("u1", { name: "Caf\u00e9" }, user)).rejects.toMatchObject({
        response: expect.objectContaining({ code: "UNIT_RENAME_COLLISION" }),
      });
      expect(h.db.tenantUnit.update).not.toHaveBeenCalled();
    });

    it("an NFD pack word blocks a rename to the NFC spelling of the same word", async () => {
      const h = make();
      seedRename(h, {
        linked: [{ id: "l1", productId: "p1" }],
        products: [
          { id: "p1", name: "Mug", baseUnitLabel: null, packLabel: null, unit: "Cafe\u0301" },
        ],
        levels: [{ productId: "p1", label: "Case", tenantUnitId: "u1" }],
      });
      await expect(h.service.update("u1", { name: "Caf\u00e9" }, user)).rejects.toMatchObject({
        response: expect.objectContaining({ code: "UNIT_RENAME_COLLISION" }),
      });
    });

    it("the stored nameKey is the NFC key, and the rename candidates are found by that same key in SQL", async () => {
      const h = make();
      seedRename(h, { products: [], levels: [] });
      await h.service.update("u1", { name: "Cafe\u0301" }, user);
      expect(h.db.tenantUnit.update.mock.calls[0][0].data).toEqual({
        name: "Caf\u00e9",
        nameKey: "caf\u00e9",
      });
      const sql = (h.db.$queryRaw.mock.calls[0][0] as Prisma.Sql).sql;
      expect(sql).toContain("normalize(");
      expect(sql).toContain('"baseUnitLabel"');
      expect(sql).toContain('"tenantId"');
    });

    it("runs under an explicit transaction budget sized for a large tenant (not Prisma's 5 s default)", async () => {
      const h = make();
      seedRename(h, { products: [], levels: [] });
      await h.service.update("u1", { name: "Carton" }, user);
      expect(h.prisma.tenantTransaction.mock.calls[0][1]).toEqual({
        timeout: 60_000,
        maxWait: 10_000,
      });
    });

    it("a 30,000-product tenant renames without a per-product scan of every level (the collision pass groups levels by product)", async () => {
      const h = make();
      const N = 30_000;
      const products = Array.from({ length: N }, (_, i) => ({
        id: `p${i}`,
        name: `Product ${i}`,
        baseUnitLabel: null,
        packLabel: null,
        unit: "Each",
      }));
      const levels = products.flatMap((p, i) => [
        { productId: p.id, label: "Case", tenantUnitId: "u1" },
        // every 10,000th product already has a Carton level: those are the collisions
        { productId: p.id, label: i % 10_000 === 0 ? "Carton" : `L${i}`, tenantUnitId: null },
      ]);
      h.db.tenantUnit.findFirst.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) => (where.id === "u1" ? row() : null),
      );
      h.db.productUnit.findMany.mockImplementation(
        async ({ where }: { where: { tenantUnitId?: string; productId?: { in: string[] } } }) => {
          if (where.tenantUnitId) {
            return levels
              .filter((l) => l.tenantUnitId === "u1")
              .map((l, i) => ({ id: `l${i}`, productId: l.productId }));
          }
          const ids = new Set(where.productId!.in);
          return levels.filter((l) => ids.has(l.productId));
        },
      );
      h.db.product.findMany.mockImplementation(
        async ({ where }: { where: { id: { in: string[] } } }) => {
          const ids = new Set(where.id.in);
          return products.filter((p) => ids.has(p.id));
        },
      );
      const started = Date.now();
      const err = await h.service.update("u1", { name: "Carton" }, user).catch((e) => e);
      expect(err.getResponse().total).toBe(3);
      // Sanity bound, not a benchmark: the O(products x levels) scan took ~10 s here, the grouped pass
      // well under one second.
      expect(Date.now() - started).toBeLessThan(4_000);
    }, 30_000);

    it("the Case + case refusal says what is really wrong (two linked levels), with its own reason", async () => {
      const h = make();
      seedRename(h, {
        linked: [
          { id: "l1", productId: "p1" },
          { id: "l2", productId: "p1" },
        ],
        products: [{ id: "p1", name: "Mug", baseUnitLabel: null, packLabel: null, unit: "Each" }],
        levels: [
          { productId: "p1", label: "Case", tenantUnitId: "u1" },
          { productId: "p1", label: "case", tenantUnitId: "u1" },
        ],
      });
      const body = (
        await h.service.update("u1", { name: "Carton" }, user).catch((e) => e)
      ).getResponse();
      expect(body.code).toBe("UNIT_RENAME_COLLISION");
      expect(body.reason).toBe("DUPLICATE_LEVELS");
      expect(body.message).toBe(
        "Can't rename to Carton: some products have two Case units that would both become Carton.",
      );
    });

    it("a name clash keeps its sentence and reason NAME", async () => {
      const h = make();
      seedRename(h, {
        linked: [{ id: "l1", productId: "p1" }],
        products: [{ id: "p1", name: "Mug", baseUnitLabel: null, packLabel: null, unit: "Each" }],
        levels: [
          { productId: "p1", label: "Case", tenantUnitId: "u1" },
          { productId: "p1", label: "Carton", tenantUnitId: null },
        ],
      });
      const body = (
        await h.service.update("u1", { name: "Carton" }, user).catch((e) => e)
      ).getResponse();
      expect(body.reason).toBe("NAME");
      expect(body.message).toBe("Can't rename to Carton: some products already have a Carton.");
    });

    it("a case-only rename onto an UNLINKED level of the exact new label is refused up front (linked Case + unlinked case -> case)", async () => {
      const h = make();
      seedRename(h, {
        linked: [{ id: "l1", productId: "p1" }],
        products: [{ id: "p1", name: "Mug", baseUnitLabel: null, packLabel: null, unit: "Each" }],
        levels: [
          { productId: "p1", label: "Case", tenantUnitId: "u1" },
          { productId: "p1", label: "case", tenantUnitId: null },
        ],
      });
      await expect(h.service.update("u1", { name: "case" }, user)).rejects.toMatchObject({
        response: expect.objectContaining({ code: "UNIT_RENAME_COLLISION", reason: "NAME" }),
      });
      expect(h.db.productUnit.updateMany).not.toHaveBeenCalled();
    });

    it("backstop: a P2002 from the level relabel (a race the pre-check could not see) is the collision 409, never a 500", async () => {
      const h = make();
      seedRename(h, { products: [], levels: [] });
      h.db.productUnit.updateMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
      );
      await expect(h.service.update("u1", { name: "Carton" }, user)).rejects.toMatchObject({
        response: expect.objectContaining({ code: "UNIT_RENAME_COLLISION" }),
      });
    });

    describe("line immutability (a level's meaning is fixed once lines carry its label)", () => {
      const seedCrate = (h: ReturnType<typeof make>, lines: Array<Record<string, unknown>>) => {
        seedRename(h, {
          linked: [{ id: "l1", productId: "p1" }],
          products: [{ id: "p1", name: "Mug", baseUnitLabel: null, packLabel: null, unit: "Each" }],
          levels: [{ productId: "p1", label: "Case", factorToBase: 12, tenantUnitId: "u1" }],
        });
        // 1st raw query: text hits; 2nd: order/invoice lines already carrying the NEW name.
        h.db.$queryRaw.mockReset();
        h.db.$queryRaw.mockResolvedValueOnce([{ id: "p1" }]).mockResolvedValueOnce(lines);
      };

      it("renaming Case(12) to Crate is refused when lines already say Crate at another size (409)", async () => {
        const h = make();
        seedCrate(h, [{ productId: "p1", unitsPerBox: 24 }]);
        const err = await h.service.update("u1", { name: "Crate" }, user).catch((e) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getResponse()).toEqual(
          expect.objectContaining({
            code: "UNIT_RENAME_COLLISION",
            reason: "LINES_AT_OTHER_SIZE",
            products: [{ id: "p1", name: "Mug" }],
          }),
        );
        expect(h.db.tenantUnit.update).not.toHaveBeenCalled();
        expect(h.db.productUnit.updateMany).not.toHaveBeenCalled();
      });

      describe("a PACK-word rename (Product.unit) is held to the pack size too", () => {
        const seedPack = (h: ReturnType<typeof make>, lines: Array<Record<string, unknown>>) => {
          seedRename(h, {
            products: [
              {
                id: "p1",
                name: "Mug",
                baseUnitLabel: null,
                packLabel: null,
                unit: "Case",
                unitsPerBox: 12,
              },
            ],
            levels: [],
          });
          h.db.$queryRaw.mockReset();
          h.db.$queryRaw.mockResolvedValueOnce([{ id: "p1" }]).mockResolvedValueOnce(lines);
        };

        it("refuses when lines already say the new word at another unitsPerBox (409)", async () => {
          const h = make();
          seedPack(h, [{ productId: "p1", unitsPerBox: 24 }]);
          const err = await h.service.update("u1", { name: "Crate" }, user).catch((e) => e);
          expect(err).toBeInstanceOf(ConflictException);
          expect(err.getResponse()).toEqual(
            expect.objectContaining({
              code: "UNIT_RENAME_COLLISION",
              reason: "LINES_AT_OTHER_SIZE",
              products: [{ id: "p1", name: "Mug" }],
            }),
          );
          expect(h.db.product.updateMany).not.toHaveBeenCalled();
        });

        it("allows it when every such line is at the pack's own size", async () => {
          const h = make();
          seedPack(h, [{ productId: "p1", unitsPerBox: 12 }]);
          await expect(h.service.update("u1", { name: "Crate" }, user)).resolves.toBeDefined();
        });
      });

      it("a line with NO size snapshot counts as a different size", async () => {
        const h = make();
        seedCrate(h, [{ productId: "p1", unitsPerBox: null }]);
        await expect(h.service.update("u1", { name: "Crate" }, user)).rejects.toMatchObject({
          response: expect.objectContaining({ reason: "LINES_AT_OTHER_SIZE" }),
        });
      });

      it("lines at the SAME size agree with the level and do not block", async () => {
        const h = make();
        seedCrate(h, [{ productId: "p1", unitsPerBox: 12 }]);
        await expect(h.service.update("u1", { name: "Crate" }, user)).resolves.toBeDefined();
      });

      it("looks the lines up through the parent order/invoice of THIS tenant, by the NFC key of the new name", async () => {
        const h = make();
        seedCrate(h, []);
        await h.service.update("u1", { name: "Crate" }, user);
        const q = h.db.$queryRaw.mock.calls[1][0] as Prisma.Sql;
        expect(q.sql).toContain('"OrderItem"');
        expect(q.sql).toContain('"InvoiceItem"');
        expect(q.sql).toContain('JOIN "Order"');
        expect(q.sql).toContain('JOIN "Invoice"');
        expect(q.sql).toContain("normalize(");
        expect(q.values).toEqual(expect.arrayContaining([T, "crate", "p1"]));
      });

      it("a case-only rename skips the line lookup (the label key is unchanged)", async () => {
        const h = make();
        seedCrate(h, []);
        await h.service.update("u1", { name: "CASE" }, user);
        expect(h.db.$queryRaw).toHaveBeenCalledTimes(1);
      });
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

    it("audits ONCE, INSIDE the rename's transaction (rolled back with it), with old and new name and the count", async () => {
      const h = make();
      seedRename(h, {
        linked: [{ id: "l1", productId: "p1" }],
        products: [{ id: "p1", name: "Mug", baseUnitLabel: null, packLabel: null, unit: "Each" }],
        levels: [{ productId: "p1", label: "Case", tenantUnitId: "u1" }],
      });
      await h.service.update("u1", { name: "Carton" }, user);
      expect(h.order).toEqual(["tx-audit", "tx-end"]);
      expect(h.audit.log).not.toHaveBeenCalled();
      expect(h.db.auditLog.create).toHaveBeenCalledTimes(1);
      expect(h.db.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: T,
          userId: "u1",
          action: "tenant_unit.renamed",
          entityType: "TenantUnit",
          entityId: "u1",
          meta: expect.objectContaining({ from: "Case", to: "Carton", productsUpdated: 1 }),
        }),
      });
    });

    it("a failed audit write fails the rename (the transaction rolls the relabel back)", async () => {
      const h = make();
      seedRename(h, { products: [], levels: [] });
      h.db.auditLog.create.mockRejectedValue(new Error("audit down"));
      await expect(h.service.update("u1", { name: "Carton" }, user)).rejects.toThrow("audit down");
    });

    it("a refused rename writes no audit row", async () => {
      const h = make();
      seedRename(h, {
        linked: [{ id: "l1", productId: "p1" }],
        products: [{ id: "p1", name: "Mug", baseUnitLabel: null, packLabel: null, unit: "Crate" }],
        levels: [{ productId: "p1", label: "Case", tenantUnitId: "u1" }],
      });
      await h.service.update("u1", { name: "Crate" }, user).catch(() => undefined);
      expect(h.db.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe("archive / restore", () => {
    it("archive sets archivedAt, changes no product row, audits after the write", async () => {
      const h = make();
      h.db.tenantUnit.findFirst.mockResolvedValue(row());
      h.prisma.$queryRaw.mockResolvedValue([dtoRow({ productCount: 40 })]);
      const out = await h.service.update("u1", { archived: true }, user);
      const call = h.db.tenantUnit.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: "u1", tenantId: T, archivedAt: null });
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

    it("restoring a unit that is NOT archived is a no-op: no write, no restored audit row", async () => {
      const h = make();
      h.db.tenantUnit.findFirst.mockResolvedValue(row());
      h.prisma.$queryRaw.mockResolvedValue([dtoRow()]);
      const out = await h.service.update("u1", { archived: false }, user);
      expect(out).toEqual({ unit: dtoRow(), productsUpdated: 0 });
      expect(h.db.tenantUnit.updateMany).not.toHaveBeenCalled();
      expect(h.audit.log).not.toHaveBeenCalled();
    });

    it("archiving a unit that is already archived is a no-op too (archivedAt keeps its date)", async () => {
      const h = make();
      h.db.tenantUnit.findFirst.mockResolvedValue(row({ archivedAt: new Date("2026-10-01") }));
      h.prisma.$queryRaw.mockResolvedValue([dtoRow({ archivedAt: new Date("2026-10-01") })]);
      await h.service.update("u1", { archived: true }, user);
      expect(h.db.tenantUnit.updateMany).not.toHaveBeenCalled();
      expect(h.audit.log).not.toHaveBeenCalled();
    });

    it("two concurrent archives audit ONCE: the loser's conditional write matches 0 rows and writes no audit row", async () => {
      const h = make();
      h.db.tenantUnit.findFirst.mockResolvedValue(row()); // both saw it active
      h.db.tenantUnit.updateMany.mockResolvedValue({ count: 0 }); // the other request already archived it
      h.prisma.$queryRaw.mockResolvedValue([dtoRow({ archivedAt: new Date() })]);
      const out = await h.service.update("u1", { archived: true }, user);
      expect(out.productsUpdated).toBe(0);
      expect(h.audit.log).not.toHaveBeenCalled();
    });

    it("two concurrent restores audit ONCE too (via update and via an add of the archived name)", async () => {
      const h = make();
      h.db.tenantUnit.findFirst.mockResolvedValue(row({ archivedAt: new Date() }));
      h.db.tenantUnit.updateMany.mockResolvedValue({ count: 0 });
      h.prisma.$queryRaw.mockResolvedValue([dtoRow()]);
      await h.service.update("u1", { archived: false }, user);
      await h.service.create({ name: "Case" }, user);
      expect(h.audit.log).not.toHaveBeenCalled();
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
