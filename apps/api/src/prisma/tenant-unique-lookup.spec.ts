import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { Prisma } from "@prisma/client";
import { PrismaService, getTenantModelNames, isTenantModel } from "./prisma.service";

// Unique lookups (`findUnique` / `findUniqueOrThrow`) on a tenant-scoped model carry the
// tenant filter inside the query itself, in BOTH tenancy layers (the `forTenant()` `$extends`
// handler and the `tenantTransaction` proxy), and the defensive result check fails closed.
//
// The fake store below honours the whole `where` it is handed (including the injected
// `tenantId`) and returns only the fields a `select` asks for — the two behaviours a
// result-only check could not rely on. The black-box drive goes through the REAL
// `_tenantExtension` / `_wrapTxWithTenant` off the prototype, as prisma-isolation.spec.ts does.

interface Row {
  id: string;
  tenantId: string;
  addonKey?: string;
  deletedAt: Date | null;
}

const ROWS: Row[] = [
  { id: "row-a1", tenantId: "tenant-a", addonKey: "k1", deletedAt: null },
  { id: "row-b1", tenantId: "tenant-b", addonKey: "k1", deletedAt: null },
];

/** Mirrors Prisma's unique-where semantics: the compound selector plus any extra filters. */
function matches(row: Row, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "tenantId_addonKey") {
      return row.tenantId === value.tenantId && row.addonKey === value.addonKey;
    }
    return (row as any)[key] === value;
  });
}

function project(
  row: Row,
  args: { select?: Record<string, boolean>; omit?: Record<string, boolean> },
) {
  if (args.select) {
    return Object.fromEntries(
      Object.entries(args.select)
        .filter(([, on]) => on)
        .map(([k]) => [k, (row as any)[k]]),
    );
  }
  if (args.omit) {
    return Object.fromEntries(Object.entries(row).filter(([k]) => !args.omit![k]));
  }
  return { ...row };
}

/** Prisma's `query` continuation for a unique lookup against the fake store. */
function storeQuery(operation: "findUnique" | "findUniqueOrThrow") {
  return jest.fn(async (args: any) => {
    const found = ROWS.find((r) => matches(r, args.where));
    if (!found) {
      if (operation === "findUniqueOrThrow") {
        throw Object.assign(new Error("No record found"), { code: "P2025" });
      }
      return null;
    }
    return project(found, args);
  });
}

const extensionHandler = (tenantId: string) =>
  (
    PrismaService.prototype as unknown as {
      _tenantExtension(t: string): {
        query: { $allModels: { $allOperations(ctx: Record<string, unknown>): Promise<any> } };
      };
    }
  )._tenantExtension(tenantId).query.$allModels.$allOperations;

function viaExtension(
  operation: "findUnique" | "findUniqueOrThrow",
  model: string,
  args: Record<string, unknown>,
  query: jest.Mock,
  tenantId = "tenant-a",
) {
  return extensionHandler(tenantId)({ args, query, model, operation });
}

/** Tx-proxy drive: `delegateKey` is the client delegate name (`order`, `tenantAddon`, …). */
function viaTxProxy(
  delegateKey: string,
  operation: "findUnique" | "findUniqueOrThrow",
  args: Record<string, unknown>,
  fn: jest.Mock,
  tenantId = "tenant-a",
) {
  const tx = (
    PrismaService.prototype as unknown as {
      _wrapTxWithTenant(rawTx: unknown, t: string): Record<string, any>;
    }
  )._wrapTxWithTenant({ [delegateKey]: { [operation]: fn } }, tenantId);
  return tx[delegateKey][operation](args);
}

/** Independent source for the sweep: the schema folder itself (model blocks with a tenantId column). */
function tenantModelsFromSchemaFolder(): string[] {
  const dir = join(__dirname, "..", "..", "prisma", "schema");
  const found: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".prisma"))) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const m of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      if (/^\s*tenantId\s+String\??\b/m.test(m[2])) found.push(m[1]);
    }
  }
  return found.sort();
}

const lowerFirst = (n: string) => n.charAt(0).toLowerCase() + n.slice(1);

describe("tenant model set (derived from the generated client)", () => {
  it("contains every model that has a tenantId column, under BOTH casings, and nothing else", () => {
    const expected = tenantModelsFromSchemaFolder();
    expect(expected.length).toBeGreaterThan(20); // a vacuous sweep is a failed sweep
    const expectedKeys = [...expected, ...expected.map(lowerFirst)].sort();
    expect([...getTenantModelNames()].sort()).toEqual(expectedKeys);
    for (const name of expected) {
      expect(isTenantModel(name)).toBe(true); // extension layer: PascalCase
      expect(isTenantModel(lowerFirst(name))).toBe(true); // transaction proxy: camelCase delegate
    }
  });

  it("agrees with Prisma's own generated field enums", () => {
    const fromEnums = Object.keys(Prisma.ModelName).filter((n) =>
      Object.prototype.hasOwnProperty.call(
        (Prisma as unknown as Record<string, object>)[`${n}ScalarFieldEnum`] ?? {},
        "tenantId",
      ),
    );
    expect(fromEnums.sort()).toEqual(tenantModelsFromSchemaFolder());
  });

  it("recognises a tenant model under both casings; non-tenant and unknown names are not tenant models", () => {
    expect(isTenantModel("Customer")).toBe(true);
    expect(isTenantModel("customer")).toBe(true);
    expect(isTenantModel("TenantAddon")).toBe(true);
    expect(isTenantModel("tenantAddon")).toBe(true);
    expect(isTenantModel("PlatformConfig")).toBe(false);
    expect(isTenantModel("platformConfig")).toBe(false);
    expect(isTenantModel("NoSuchModel")).toBe(false);
    expect(isTenantModel("")).toBe(false);
  });
});

describe.each([
  [
    "forTenant() extension",
    (op: "findUnique" | "findUniqueOrThrow", model: string, args: any, q: jest.Mock) =>
      viaExtension(op, model, args, q),
  ],
  [
    "tenantTransaction proxy",
    (op: "findUnique" | "findUniqueOrThrow", model: string, args: any, q: jest.Mock) =>
      viaTxProxy(model.charAt(0).toLowerCase() + model.slice(1), op, args, q),
  ],
] as const)("unique lookup tenant scoping — %s", (_layer, run) => {
  it("injects tenantId into `where` beside the unique selector (findUnique)", async () => {
    const q = storeQuery("findUnique");
    await run("findUnique", "Customer", { where: { id: "row-a1" } }, q);
    expect(q).toHaveBeenCalledWith({ where: { id: "row-a1", tenantId: "tenant-a" } });
  });

  it("injects tenantId into `where` for findUniqueOrThrow too", async () => {
    const q = storeQuery("findUniqueOrThrow");
    await run("findUniqueOrThrow", "Customer", { where: { id: "row-a1" } }, q);
    expect(q).toHaveBeenCalledWith({ where: { id: "row-a1", tenantId: "tenant-a" } });
  });

  it("keeps a compound unique selector and adds the plain tenantId filter next to it", async () => {
    const q = storeQuery("findUnique");
    const own = await run(
      "findUnique",
      "TenantAddon",
      { where: { tenantId_addonKey: { tenantId: "tenant-a", addonKey: "k1" } } },
      q,
    );
    expect(q).toHaveBeenCalledWith({
      where: { tenantId_addonKey: { tenantId: "tenant-a", addonKey: "k1" }, tenantId: "tenant-a" },
    });
    expect(own).toMatchObject({ id: "row-a1" });
  });

  it("a foreign id whose select omits tenantId resolves to null", async () => {
    const q = storeQuery("findUnique");
    await expect(
      run("findUnique", "Customer", { where: { id: "row-b1" }, select: { id: true } }, q),
    ).resolves.toBeNull();
  });

  it("a foreign id with a select of another column resolves to null", async () => {
    const q = storeQuery("findUnique");
    await expect(
      run("findUnique", "Customer", { where: { id: "row-b1" }, select: { deletedAt: true } }, q),
    ).resolves.toBeNull();
  });

  it("a nested-select shape without tenantId (estimate convert) is scoped and not widened", async () => {
    const q = storeQuery("findUnique");
    const select = {
      id: true,
      status: true,
      items: { orderBy: { id: "asc" }, select: { id: true } },
    };
    await expect(
      run("findUnique", "Estimate", { where: { id: "row-b1" }, select }, q),
    ).resolves.toBeNull();
    expect(q.mock.calls[0][0].where).toEqual({ id: "row-b1", tenantId: "tenant-a" });
    // the caller's nested select is carried through untouched
    expect(q.mock.calls[0][0].select.items).toEqual(select.items);
  });

  it("findUniqueOrThrow on a foreign id rejects with P2025", async () => {
    const q = storeQuery("findUniqueOrThrow");
    await expect(
      run("findUniqueOrThrow", "Customer", { where: { id: "row-b1" }, select: { id: true } }, q),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("an own-tenant select without tenantId still returns exactly the selected shape", async () => {
    const q = storeQuery("findUnique");
    const out = await run(
      "findUnique",
      "Customer",
      { where: { id: "row-a1" }, select: { id: true } },
      q,
    );
    expect(out).toEqual({ id: "row-a1" });
    expect(out).not.toHaveProperty("tenantId");
  });

  it("an own-tenant `omit` of tenantId is honoured on the way out", async () => {
    const q = storeQuery("findUnique");
    const out = await run(
      "findUnique",
      "Customer",
      { where: { id: "row-a1" }, omit: { tenantId: true } },
      q,
    );
    expect(out).not.toHaveProperty("tenantId");
    expect(out).toMatchObject({ id: "row-a1" });
  });

  it("an explicit select of tenantId is passed through as the caller wrote it", async () => {
    const q = storeQuery("findUnique");
    const out = await run(
      "findUnique",
      "Customer",
      { where: { id: "row-a1" }, select: { id: true, tenantId: true } },
      q,
    );
    expect(out).toEqual({ id: "row-a1", tenantId: "tenant-a" });
  });

  it("defense in depth: a backend that ignores the injected filter still cannot hand out a foreign row", async () => {
    // A continuation that returns the foreign row regardless of `where` — the result check
    // must catch it, with or without the column in the caller's select.
    const leaky = jest.fn(async (args: any) => project(ROWS[1], args));
    await expect(
      run("findUnique", "Customer", { where: { id: "row-b1" } }, leaky),
    ).resolves.toBeNull();
    await expect(
      run(
        "findUnique",
        "Customer",
        { where: { id: "row-b1" }, select: { deletedAt: true } },
        leaky,
      ),
    ).resolves.toBeNull();
    await expect(
      run(
        "findUniqueOrThrow",
        "Customer",
        { where: { id: "row-b1" }, select: { id: true } },
        leaky,
      ),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("a non-tenant model is passed through unchanged (no tenantId injected, result untouched)", async () => {
    const result = { id: "pc-1", key: "k", value: "v" };
    const q = jest.fn(async () => result);
    const out = await run("findUnique", "PlatformConfig", { where: { key: "k" } }, q);
    expect(q).toHaveBeenCalledWith({ where: { key: "k" } });
    expect(out).toBe(result);
  });

  it("does not mutate the caller's args object", async () => {
    const q = storeQuery("findUnique");
    const args = { where: { id: "row-a1" }, select: { id: true } };
    await run("findUnique", "Customer", args, q);
    expect(args).toEqual({ where: { id: "row-a1" }, select: { id: true } });
  });
});
