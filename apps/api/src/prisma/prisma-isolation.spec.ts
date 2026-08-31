import { PrismaService } from "./prisma.service";

// T-G8a (test-plan.md, F02b/G8) — the FIRST specs apps/api/src/prisma/ has ever had. They pin
// the tenant-isolation engine every other module leans on: `_wrapTxWithTenant` (the proxy
// `tenantTransaction` hands to its callback) and `tenantTransaction` itself (the `set_config`
// RLS hand-off).
//
// Green by design — characterization of unchanged engine behavior (R9's coverage clause).
// R9's red lives in rls-migration.spec.ts and rls-preflight.spec.ts.
//
// Per the plan's "vacuity trap": `apps/api/src/testing/prisma-mock.ts`'s `tenantTransaction` is
// a pass-through and proves nothing about tenancy. Every test below drives the REAL
// `_wrapTxWithTenant`/`tenantTransaction` off `PrismaService.prototype` (the
// `settings.controller.clear-financial.spec.ts` shape from #506) against a fake, partitioned
// two-tenant store — never a mock this file configured itself to already agree with.

interface FakeRow {
  id: string;
  tenantId: string;
  status: string;
}

function matchesWhere(row: FakeRow, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(
    ([key, value]) => (row as Record<string, unknown>)[key] === value,
  );
}

/** A minimal, faithful-enough model surface covering every verb the proxy touches. */
function makeFakeModel(rows: FakeRow[]) {
  return {
    findMany: jest.fn(async (args: { where?: Record<string, unknown> } = {}) =>
      rows.filter((r) => matchesWhere(r, args.where)),
    ),
    findFirst: jest.fn(
      async (args: { where?: Record<string, unknown> } = {}) =>
        rows.find((r) => matchesWhere(r, args.where)) ?? null,
    ),
    findFirstOrThrow: jest.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      const found = rows.find((r) => matchesWhere(r, args.where));
      if (!found) throw new Error("RecordNotFound");
      return found;
    }),
    findUnique: jest.fn(
      async (args: { where?: { id?: string } } = {}) =>
        rows.find((r) => r.id === args.where?.id) ?? null,
    ),
    count: jest.fn(
      async (args: { where?: Record<string, unknown> } = {}) =>
        rows.filter((r) => matchesWhere(r, args.where)).length,
    ),
    update: jest.fn(
      async (args: { where?: Record<string, unknown>; data?: Partial<FakeRow> } = {}) => {
        const row = rows.find((r) => matchesWhere(r, args.where));
        if (!row) throw new Error("RecordNotFound");
        Object.assign(row, args.data);
        return row;
      },
    ),
    updateMany: jest.fn(
      async (args: { where?: Record<string, unknown>; data?: Partial<FakeRow> } = {}) => {
        const matched = rows.filter((r) => matchesWhere(r, args.where));
        matched.forEach((r) => Object.assign(r, args.data));
        return { count: matched.length };
      },
    ),
    delete: jest.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      const idx = rows.findIndex((r) => matchesWhere(r, args.where));
      if (idx === -1) throw new Error("RecordNotFound");
      const [row] = rows.splice(idx, 1);
      return row;
    }),
    deleteMany: jest.fn(async (args: { where?: Record<string, unknown> } = {}) => {
      const before = rows.length;
      const remaining = rows.filter((r) => !matchesWhere(r, args.where));
      rows.length = 0;
      rows.push(...remaining);
      return { count: before - rows.length };
    }),
    aggregate: jest.fn(async (args: { where?: Record<string, unknown> } = {}) => ({
      _count: { _all: rows.filter((r) => matchesWhere(r, args.where)).length },
    })),
    groupBy: jest.fn(async (args: { where?: Record<string, unknown> } = {}) =>
      rows.filter((r) => matchesWhere(r, args.where)),
    ),
    create: jest.fn(async (args: { data?: Partial<FakeRow> } = {}) => {
      const row = { ...(args.data as FakeRow) };
      rows.push(row);
      return row;
    }),
    createMany: jest.fn(async (args: { data?: Partial<FakeRow> | Partial<FakeRow>[] } = {}) => {
      const list = Array.isArray(args.data) ? args.data : args.data ? [args.data] : [];
      list.forEach((d) => rows.push({ ...(d as FakeRow) }));
      return { count: list.length };
    }),
    upsert: jest.fn(
      async (
        args: {
          where?: Record<string, unknown>;
          create?: Partial<FakeRow>;
          update?: Partial<FakeRow>;
        } = {},
      ) => {
        const row = rows.find((r) => matchesWhere(r, args.where));
        if (row) {
          Object.assign(row, args.update);
          return row;
        }
        const created = { ...(args.create as FakeRow) };
        rows.push(created);
        return created;
      },
    ),
  };
}

type FakeModel = ReturnType<typeof makeFakeModel>;

/** Reconstructs a tagged-template call's SQL text (strings + interpolated values). */
function renderRawCall(call: readonly unknown[]): string {
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  return strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""), "");
}

function seedTwoTenantRows(): FakeRow[] {
  return [
    { id: "order-a1", tenantId: "tenant-a", status: "OPEN" },
    { id: "order-a2", tenantId: "tenant-a", status: "OPEN" },
    { id: "order-b1", tenantId: "tenant-b", status: "OPEN" },
  ];
}

// The REAL proxy from prisma.service.ts, not an imitation of it — `_wrapTxWithTenant` doesn't
// reference `this`, so the prototype reference alone is enough to drive it.
const wrapTxWithTenant = (rawTx: Record<string, unknown>, tenantId: string): Record<string, any> =>
  (
    PrismaService.prototype as unknown as {
      _wrapTxWithTenant(rawTx: unknown, tenantId: string): Record<string, any>;
    }
  )._wrapTxWithTenant(rawTx, tenantId);

function buildTx() {
  const rows = seedTwoTenantRows();
  const model = makeFakeModel(rows);
  const tx = wrapTxWithTenant({ order: model }, "tenant-a");
  return { rows, model: model as FakeModel, tx };
}

describe("REG-G8a PrismaService#_wrapTxWithTenant — tenant-isolation proxy (T-G8a)", () => {
  describe("(a) injects tenant-a into every WRITE_METHODS verb (data/create, never where)", () => {
    it("create: injects tenantId into `data`", async () => {
      const { rows, model, tx } = buildTx();

      await tx.order.create({ data: { id: "order-a3", status: "NEW" } });

      expect(model.create).toHaveBeenCalledWith({
        data: { id: "order-a3", status: "NEW", tenantId: "tenant-a" },
      });
      expect(rows.find((r) => r.id === "order-a3")?.tenantId).toBe("tenant-a");
    });

    it("createMany: injects tenantId into every element of `data`", async () => {
      const { rows, model, tx } = buildTx();

      await tx.order.createMany({ data: [{ id: "order-a4" }, { id: "order-a5" }] });

      expect(model.createMany).toHaveBeenCalledWith({
        data: [
          { id: "order-a4", tenantId: "tenant-a" },
          { id: "order-a5", tenantId: "tenant-a" },
        ],
      });
      expect(rows.filter((r) => r.tenantId === "tenant-a").map((r) => r.id)).toEqual(
        expect.arrayContaining(["order-a4", "order-a5"]),
      );
    });

    it("upsert: injects tenantId into `create` only — `where` must keep using declared unique fields", async () => {
      const { model, tx } = buildTx();

      await tx.order.upsert({
        where: { id: "order-a6" },
        create: { id: "order-a6", status: "NEW" },
        update: { status: "CHANGED" },
      });

      const call = model.upsert.mock.calls[0][0];
      // Prisma throws PrismaClientValidationError if `where` carries a field outside its
      // declared unique constraint — the proxy deliberately leaves `where` untouched.
      expect(call.where).toEqual({ id: "order-a6" });
      expect(call.create).toEqual({ id: "order-a6", status: "NEW", tenantId: "tenant-a" });
    });
  });

  describe("(a) injects tenant-a into every SCOPED_METHODS verb via `where`", () => {
    it("findMany: merges tenantId into `where` alongside the caller's own filter", async () => {
      const { model, tx } = buildTx();
      await tx.order.findMany({ where: { status: "OPEN" } });
      expect(model.findMany).toHaveBeenCalledWith({
        where: { status: "OPEN", tenantId: "tenant-a" },
      });
    });

    it("findFirst: merges tenantId into `where`", async () => {
      const { model, tx } = buildTx();
      await tx.order.findFirst({ where: { status: "OPEN" } });
      expect(model.findFirst).toHaveBeenCalledWith({
        where: { status: "OPEN", tenantId: "tenant-a" },
      });
    });

    it("findFirstOrThrow: merges tenantId into `where`", async () => {
      const { model, tx } = buildTx();
      await tx.order.findFirstOrThrow({ where: { status: "OPEN" } });
      expect(model.findFirstOrThrow).toHaveBeenCalledWith({
        where: { status: "OPEN", tenantId: "tenant-a" },
      });
    });

    it("count: merges tenantId into `where`", async () => {
      const { model, tx } = buildTx();
      await tx.order.count({ where: { status: "OPEN" } });
      expect(model.count).toHaveBeenCalledWith({
        where: { status: "OPEN", tenantId: "tenant-a" },
      });
    });

    it("aggregate: merges tenantId into `where`", async () => {
      const { model, tx } = buildTx();
      await tx.order.aggregate({ where: { status: "OPEN" } });
      expect(model.aggregate).toHaveBeenCalledWith({
        where: { status: "OPEN", tenantId: "tenant-a" },
      });
    });

    it("groupBy: merges tenantId into `where`", async () => {
      const { model, tx } = buildTx();
      await tx.order.groupBy({ where: { status: "OPEN" } });
      expect(model.groupBy).toHaveBeenCalledWith({
        where: { status: "OPEN", tenantId: "tenant-a" },
      });
    });

    it("update: merges tenantId into `where`, leaves `data` untouched", async () => {
      const { rows, model, tx } = buildTx();
      await tx.order.update({ where: { id: "order-a1" }, data: { status: "DONE" } });
      expect(model.update).toHaveBeenCalledWith({
        where: { id: "order-a1", tenantId: "tenant-a" },
        data: { status: "DONE" },
      });
      expect(rows.find((r) => r.id === "order-a1")?.status).toBe("DONE");
    });

    it("updateMany: merges tenantId into `where`, leaves `data` untouched", async () => {
      const { rows, model, tx } = buildTx();
      await tx.order.updateMany({ where: { status: "OPEN" }, data: { status: "DONE" } });
      expect(model.updateMany).toHaveBeenCalledWith({
        where: { status: "OPEN", tenantId: "tenant-a" },
        data: { status: "DONE" },
      });
      expect(rows.filter((r) => r.tenantId === "tenant-a").every((r) => r.status === "DONE")).toBe(
        true,
      );
    });

    it("delete: merges tenantId into `where`", async () => {
      const { rows, model, tx } = buildTx();
      await tx.order.delete({ where: { id: "order-a1" } });
      expect(model.delete).toHaveBeenCalledWith({
        where: { id: "order-a1", tenantId: "tenant-a" },
      });
      expect(rows.find((r) => r.id === "order-a1")).toBeUndefined();
    });

    it("deleteMany: merges tenantId into `where`", async () => {
      const { rows, model, tx } = buildTx();
      await tx.order.deleteMany({ where: { status: "OPEN" } });
      expect(model.deleteMany).toHaveBeenCalledWith({
        where: { status: "OPEN", tenantId: "tenant-a" },
      });
      expect(rows.some((r) => r.tenantId === "tenant-a")).toBe(false);
    });
  });

  describe("(a) post-filters the one POST_FILTER_METHODS verb (findUnique can't take an extra `where` field)", () => {
    it("findUnique: leaves `where` unchanged, but blanks a cross-tenant hit to null", async () => {
      const { model, tx } = buildTx();

      const ownRow = await tx.order.findUnique({ where: { id: "order-a1" } });
      const foreignRow = await tx.order.findUnique({ where: { id: "order-b1" } });

      // The underlying call never receives tenantId — Prisma's findUnique only accepts
      // @id/@@unique fields in `where`, so injecting it there throws at runtime.
      expect(model.findUnique).toHaveBeenNthCalledWith(1, { where: { id: "order-a1" } });
      expect(model.findUnique).toHaveBeenNthCalledWith(2, { where: { id: "order-b1" } });
      expect(ownRow).toEqual({ id: "order-a1", tenantId: "tenant-a", status: "OPEN" });
      expect(foreignRow).toBeNull();
    });
  });

  describe("(b) tenant B's rows are never visible or mutable through tenant A's transaction", () => {
    it("findMany never returns a tenant-B row, even with an empty filter", async () => {
      const { tx } = buildTx();
      const result = await tx.order.findMany({});
      expect(result.map((r: FakeRow) => r.id).sort()).toEqual(["order-a1", "order-a2"]);
    });

    it("update targeting a tenant-B row by id throws instead of mutating it", async () => {
      const { rows, tx } = buildTx();
      await expect(
        tx.order.update({ where: { id: "order-b1" }, data: { status: "HIJACKED" } }),
      ).rejects.toThrow();
      expect(rows.find((r) => r.id === "order-b1")?.status).toBe("OPEN");
    });

    it("delete targeting a tenant-B row by id throws instead of removing it", async () => {
      const { rows, tx } = buildTx();
      await expect(tx.order.delete({ where: { id: "order-b1" } })).rejects.toThrow();
      expect(rows.find((r) => r.id === "order-b1")).toBeDefined();
    });

    it("deleteMany with an empty filter (an attempted wipe-all) leaves every tenant-B row intact", async () => {
      const { rows, tx } = buildTx();
      await tx.order.deleteMany({});
      expect(rows.filter((r) => r.tenantId === "tenant-b")).toHaveLength(1);
      expect(rows.filter((r) => r.tenantId === "tenant-a")).toHaveLength(0);
    });

    it("findUnique by a tenant-B row's own id returns null, not the row", async () => {
      const { tx } = buildTx();
      expect(await tx.order.findUnique({ where: { id: "order-b1" } })).toBeNull();
    });
  });
});

describe("REG-G8a PrismaService#tenantTransaction — RLS session hand-off (T-G8a)", () => {
  // tenantTransaction is a genuine instance method (`this.getTenantId()`, `this.$transaction()`,
  // `this._wrapTxWithTenant()`), so it is driven the same way as the clear-financial-data spec
  // drives `_wrapTxWithTenant`: bind the REAL prototype method to a purpose-built host object,
  // never a from-scratch reimplementation of what it should do.
  const realTenantTransaction = (
    PrismaService.prototype as unknown as {
      tenantTransaction(
        this: unknown,
        fn: (tx: unknown) => Promise<unknown>,
        options?: unknown,
      ): Promise<unknown>;
    }
  ).tenantTransaction;

  function makeHost(tenantId: string | null, rawTx: Record<string, unknown>) {
    return {
      getTenantId: jest.fn().mockReturnValue(tenantId),
      _wrapTxWithTenant: (
        PrismaService.prototype as unknown as {
          _wrapTxWithTenant(rawTx: unknown, tenantId: string): unknown;
        }
      )._wrapTxWithTenant,
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(rawTx)),
    };
  }

  it("(c) issues set_config('app.current_tenant_id', tenant-a) inside the tx before the callback runs", async () => {
    const callOrder: string[] = [];
    const rows = seedTwoTenantRows();
    const rawTx = {
      order: {
        findMany: jest.fn(async () => {
          callOrder.push("read");
          return rows;
        }),
      },
      $executeRaw: jest.fn((..._args: unknown[]) => {
        callOrder.push("set_config");
        return Promise.resolve(0);
      }),
    };
    const host = makeHost("tenant-a", rawTx);

    await realTenantTransaction.call(host, async (tx) => {
      await (tx as { order: { findMany(): Promise<unknown> } }).order.findMany();
    });

    expect(callOrder).toEqual(["set_config", "read"]);
    // Tagged-template call shape: $executeRaw(strings, ...interpolatedValues) — the tenant id
    // is the sole interpolated value in `SELECT set_config('app.current_tenant_id', ${tenantId}, true)`.
    expect(renderRawCall(rawTx.$executeRaw.mock.calls[0])).toBe(
      "SELECT set_config('app.current_tenant_id', tenant-a, true)",
    );
  });

  it("(c) with no tenant in context: set_config gets an empty string and the callback runs on the raw, unscoped client", async () => {
    const rows = seedTwoTenantRows();
    const rawTx = { order: makeFakeModel(rows), $executeRaw: jest.fn().mockResolvedValue(0) };
    const host = makeHost(null, rawTx);

    let seenIds: string[] = [];
    await realTenantTransaction.call(host, async (tx) => {
      const result = await (
        tx as { order: { findMany(args?: unknown): Promise<FakeRow[]> } }
      ).order.findMany({});
      seenIds = result.map((r) => r.id);
    });

    // The `else` branch has no interpolation at all — `''` is literal SQL text, not a bound
    // param — so this call's args carry only the strings array, never a second element.
    expect(rawTx.$executeRaw.mock.calls[0]).toHaveLength(1);
    expect(renderRawCall(rawTx.$executeRaw.mock.calls[0])).toBe(
      "SELECT set_config('app.current_tenant_id', '', true)",
    );
    // No tenant in context ⇒ the callback receives the RAW client (`if (!tenantId) return
    // fn(rawTx)`), unscoped — it sees both tenants' rows.
    expect(seenIds.sort()).toEqual(["order-a1", "order-a2", "order-b1"]);
  });
});
