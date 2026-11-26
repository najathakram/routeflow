/**
 * SA-1507 rule 1 + Amendment 1 (A1-1, A1-2, A1-10) — real-Postgres proof of the history-import tenant guard
 * (`legacy_import_tenant_guard()` and its six `<Model>_tenant_guard` row triggers, migration
 * 20261126000000_legacy_import_stage1). DB-1 to DB-11, with DB-6a and DB-6b.
 *
 * Every spec names its SESSION TENANT S (A, B or ''): the value of `app.current_tenant_id` the transaction ran with.
 * Writes are raw SQL on purpose: the guard is the claim, not the ORM, and raw SQL is the path no pin can see. Tenants
 * A and B are throwaway `qa-sa1507-<run>-*` tenants (`assertTestTenant`, which `withTenantTx` also calls); every row
 * is synthetic (`acme`); `afterAll` deletes exactly what this file made. Collected only by `jest.db.config.js`.
 *
 * Each case's "red without its rule" value is observed by the builder against a mutated function and written in the PR
 * body (the mutation driver is not part of the repo).
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { IMPORT_HISTORY_MODELS } from "./import-history-models";
import { withTenantTx } from "./testing/with-tenant-tx";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

/** The SQLSTATE of a pg error, however Prisma's raw-query path wrapped it (observed and reported in the PR body). */
const sqlState = (err: any): string | undefined =>
  err?.meta?.driverAdapterError?.cause?.originalCode ??
  err?.cause?.originalCode ??
  err?.meta?.code ??
  err?.code;
const pgText = (err: any): string =>
  String(
    err?.meta?.driverAdapterError?.cause?.originalMessage ??
      err?.meta?.message ??
      err?.message ??
      "",
  );

class RollbackSignal<T> extends Error {
  constructor(readonly value: T) {
    super("rollback");
  }
}

interface World {
  batch: string;
  file: string;
  issue: string;
  doc: string;
  line: string;
  alias: string;
}
interface Owner {
  id: string; // tenant id
  customerId: string;
  productId: string;
}

describeDb("SA-1507 tenant guard: DB-1 to DB-11 (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let svc: PrismaService;
  let tenantCtx: TenantContextService;
  const run = randomUUID().slice(0, 8);
  const created: { tenants: string[]; users: string[]; customers: string[]; products: string[] } = {
    tenants: [],
    users: [],
    customers: [],
    products: [],
  };
  let A: Owner;
  let B: Owner;
  let worldA: World;
  let worldB: World;

  const slugOf = (tag: string) =>
    assertTestTenant(`qa-sa1507-${run}-${tag}`, "tenant-guard.db.spec");

  async function seedOwner(tag: string): Promise<Owner> {
    const tenant = await prisma.tenant.create({
      data: { slug: slugOf(tag), name: `SA-1507 ${tag}` },
    });
    created.tenants.push(tenant.id);
    const owner = await seedCustomerAndProduct(tenant.id, tag);
    return { id: tenant.id, ...owner };
  }

  async function seedCustomerAndProduct(tenantId: string, tag: string) {
    const user = await prisma.user.create({
      data: {
        email: `${tag}-${randomUUID().slice(0, 6)}-${run}@example.test`,
        username: `sa1507-${tag}-${randomUUID().slice(0, 6)}-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    created.users.push(user.id);
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `Acme ${tag}`, contactName: "Acme Buyer", tenantId },
    });
    created.customers.push(customer.id);
    const product = await prisma.product.create({
      data: {
        tenantId,
        kind: "STANDARD",
        name: `Acme ${tag} ${randomUUID().slice(0, 8)}`,
        unit: "ea",
        pricePerUnit: 5,
        currentStock: 0,
      },
    });
    created.products.push(product.id);
    return { customerId: customer.id, productId: product.id };
  }

  /** One transaction whose session tenant is S (a tenant id, or '' for none). */
  function asSession<T>(session: string, fn: (tx: any) => Promise<T>): Promise<T> {
    if (session !== "") return withTenantTx(prisma as any, session, fn);
    return prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', '', true)`;
      return fn(tx);
    });
  }

  /** Runs `fn` and always rolls back; returns what `fn` returned. A pg error from `fn` propagates unchanged. */
  async function rolledBack<T>(session: string, fn: (tx: any) => Promise<T>): Promise<T> {
    try {
      await asSession(session, async (tx) => {
        throw new RollbackSignal(await fn(tx));
      });
    } catch (e) {
      if (e instanceof RollbackSignal) return e.value as T;
      throw e;
    }
    throw new Error("unreachable");
  }

  async function refusedWith(code: string, session: string, fn: (tx: any) => Promise<unknown>) {
    const err = await asSession(session, fn).then(
      () => undefined,
      (e) => e,
    );
    expect(err).toBeDefined();
    expect(sqlState(err)).toBe(code);
    return err;
  }
  const refused = (session: string, table: string, fn: (tx: any) => Promise<unknown>) =>
    refusedWith("42501", session, fn).then((err) => {
      // the text names the table and nothing else: no id, no tenant, no word after the table name (A2-4 L-8, mutation M12)
      const tail = pgText(err).replace(/[\s`'".]+$/, "");
      expect(tail.endsWith(`legacy_import_tenant_guard: ${table}`)).toBe(true);
      for (const secret of [A.id, B.id, A.customerId, B.customerId, A.productId, B.productId]) {
        expect(pgText(err)).not.toContain(secret);
      }
    });

  const exists = async (table: string, id: string): Promise<boolean> => {
    const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "${table}" WHERE "id" = $1`,
      id,
    );
    return rows[0]!.n === 1;
  };
  const cell = async (table: string, id: string, col: string) => {
    const rows = await prisma.$queryRawUnsafe<{ v: unknown }[]>(
      `SELECT "${col}" AS v FROM "${table}" WHERE "id" = $1`,
      id,
    );
    return rows[0]?.v;
  };

  // ── synthetic writers (raw SQL; every id is supplied, there is no DB default for "id") ──
  const insertBatch = (tx: any, tenantId: string, id: string) =>
    tx.$executeRawUnsafe(
      `INSERT INTO "LegacyImportBatch" ("id","tenantId","source","createdById","updatedAt")
       VALUES ($1,$2,'QUICKBOOKS'::"MigrationSource",'acme-user',now())`,
      id,
      tenantId,
    );
  const insertFile = (tx: any, tenantId: string, id: string, batchId: string) =>
    tx.$executeRawUnsafe(
      `INSERT INTO "LegacyImportFile" ("id","tenantId","batchId","kind","adapterKey","adapterVersion","fileName","fileSha256","fileBytes")
       VALUES ($1,$2,$3,'SALES_LINES'::"LegacyImportFileKind",'acme-adapter',1,'acme.csv','acme-sha',1)`,
      id,
      tenantId,
      batchId,
    );
  const insertIssue = (tx: any, tenantId: string, id: string, batchId: string, fileId: string) =>
    tx.$executeRawUnsafe(
      `INSERT INTO "LegacyImportIssue" ("id","tenantId","batchId","fileId","physicalLine","severity","code","message")
       VALUES ($1,$2,$3,$4,2,'ERROR'::"LegacyImportIssueSeverity",'ACME_CODE','acme message')`,
      id,
      tenantId,
      batchId,
      fileId,
    );
  const insertDoc = (
    tx: any,
    tenantId: string,
    id: string,
    batchId: string,
    fileId: string,
    customerId: string | null,
  ) =>
    tx.$executeRawUnsafe(
      `INSERT INTO "LegacySalesDocument" ("id","tenantId","batchId","fileId","source","kind","sourceKey","sourceCustomerKey","customerId","docDate","linesTotal","contentHash")
       VALUES ($1,$2,$3,$4,'QUICKBOOKS'::"MigrationSource",'INVOICE'::"LegacySalesDocumentKind",$5,'acme-customer',$6::text,'2026-01-01'::date,10,'acme-hash')`,
      id,
      tenantId,
      batchId,
      fileId,
      `key-${id}`,
      customerId,
    );
  const insertLine = (
    tx: any,
    tenantId: string,
    id: string,
    documentId: string,
    productId: string | null,
    customerId: string | null,
    lineNo = 1,
  ) =>
    tx.$executeRawUnsafe(
      `INSERT INTO "LegacySalesLine" ("id","tenantId","documentId","lineNo","physicalLine","kind","productId","customerId","docDate")
       VALUES ($1,$2,$3,$4,2,'PRODUCT'::"LegacySalesLineKind",$5::text,$6::text,'2026-01-01'::date)`,
      id,
      tenantId,
      documentId,
      lineNo,
      productId,
      customerId,
    );
  const insertAlias = (tx: any, tenantId: string, id: string, productId: string | null) =>
    tx.$executeRawUnsafe(
      `INSERT INTO "SourceItemAlias" ("id","tenantId","source","sourceItemKey","sourceItemText","productId","createdById","updatedAt")
       VALUES ($1,$2,'QUICKBOOKS'::"MigrationSource",$3,'Acme item',$4::text,'acme-user',now())`,
      id,
      tenantId,
      `item-${id}`,
      productId,
    );

  /** Writes one row to each of the six for `owner`, inside `tx` (the session tenant must already be the owner). */
  async function writeWorld(
    tx: any,
    owner: Owner,
    customerId = owner.customerId,
    productId = owner.productId,
  ) {
    const w: World = {
      batch: randomUUID(),
      file: randomUUID(),
      issue: randomUUID(),
      doc: randomUUID(),
      line: randomUUID(),
      alias: randomUUID(),
    };
    await insertBatch(tx, owner.id, w.batch);
    await insertFile(tx, owner.id, w.file, w.batch);
    await insertIssue(tx, owner.id, w.issue, w.batch, w.file);
    await insertDoc(tx, owner.id, w.doc, w.batch, w.file, customerId);
    await insertLine(tx, owner.id, w.line, w.doc, productId, customerId);
    await insertAlias(tx, owner.id, w.alias, productId);
    return w;
  }

  beforeAll(async () => {
    const url = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: url });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    tenantCtx = new TenantContextService();
    svc = new PrismaService(tenantCtx);
    await svc.$connect();
    A = await seedOwner("a");
    B = await seedOwner("b");
    worldA = await withTenantTx(prisma as any, A.id, (tx) => writeWorld(tx, A));
    worldB = await withTenantTx(prisma as any, B.id, (tx) => writeWorld(tx, B));
  }, 120_000);

  afterAll(async () => {
    for (const owner of [A, B]) {
      if (!owner) continue;
      /* eslint-disable no-await-in-loop */
      await withTenantTx(prisma as any, owner.id, async (tx) => {
        await tx.$executeRawUnsafe(`DELETE FROM "SourceItemAlias" WHERE "tenantId" = $1`, owner.id);
        await tx.$executeRawUnsafe(
          `DELETE FROM "LegacyImportBatch" WHERE "tenantId" = $1`,
          owner.id,
        );
      }).catch(() => undefined);
      /* eslint-enable no-await-in-loop */
    }
    await prisma?.customer
      .deleteMany({ where: { id: { in: created.customers } } })
      .catch(() => undefined);
    await prisma?.product
      .deleteMany({ where: { id: { in: created.products } } })
      .catch(() => undefined);
    await prisma?.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => undefined);
    await prisma?.tenant
      .deleteMany({ where: { id: { in: created.tenants } } })
      .catch(() => undefined);
    await prisma?.$disconnect();
    await svc?.$disconnect();
    await pool?.end();
  }, 120_000);

  // ── the six inserts for one session and one row owner, parents taken from `parents` ──
  const sixInserts = (
    owner: Owner,
    parents: World,
    customerId: string | null,
    productId: string | null,
  ) =>
    [
      ["LegacyImportBatch", (tx: any) => insertBatch(tx, owner.id, randomUUID())],
      ["LegacyImportFile", (tx: any) => insertFile(tx, owner.id, randomUUID(), parents.batch)],
      [
        "LegacyImportIssue",
        (tx: any) => insertIssue(tx, owner.id, randomUUID(), parents.batch, parents.file),
      ],
      [
        "LegacySalesDocument",
        (tx: any) => insertDoc(tx, owner.id, randomUUID(), parents.batch, parents.file, customerId),
      ],
      [
        "LegacySalesLine",
        (tx: any) => insertLine(tx, owner.id, randomUUID(), parents.doc, productId, customerId, 99),
      ],
      ["SourceItemAlias", (tx: any) => insertAlias(tx, owner.id, randomUUID(), productId)],
    ] as Array<[string, (tx: any) => Promise<unknown>]>;

  it("DB-1 (S=''): an insert into each of the six is refused with 42501, naming the table only", async () => {
    for (const [table, insert] of sixInserts(A, worldA, null, null)) {
      // eslint-disable-next-line no-await-in-loop
      await refused("", table, insert);
    }
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "LegacyImportBatch" WHERE "tenantId" = $1`,
      A.id,
    );
    expect(n).toBe(1); // only the world seeded in beforeAll: the refused inserts left nothing
  });

  it("DB-2 (S=A): an insert with tenantId B is refused with 42501 on each of the six", async () => {
    for (const [table, insert] of sixInserts(B, worldB, null, null)) {
      // eslint-disable-next-line no-await-in-loop
      await refused(A.id, table, insert);
    }
    const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "LegacyImportBatch" WHERE "tenantId" = $1`,
      B.id,
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("DB-3 (S=A): an update, then a delete, of B's row by id is refused with 42501 and B is unchanged", async () => {
    const targets: Array<[string, string, string, string]> = [
      ["LegacyImportBatch", worldB.batch, "numberPrefix", "acme-x"],
      ["LegacyImportFile", worldB.file, "fileName", "acme-x.csv"],
      ["LegacyImportIssue", worldB.issue, "message", "acme x"],
      ["LegacySalesDocument", worldB.doc, "sourceCustomerKey", "acme-x"],
      ["LegacySalesLine", worldB.line, "description", "acme x"],
      ["SourceItemAlias", worldB.alias, "sourceItemText", "Acme x"],
    ];
    for (const [table, id, col, value] of targets) {
      /* eslint-disable no-await-in-loop */
      const before = await cell(table, id, col);
      await refused(A.id, table, (tx) =>
        tx.$executeRawUnsafe(`UPDATE "${table}" SET "${col}" = $1 WHERE "id" = $2`, value, id),
      );
      await refused(A.id, table, (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "id" = $1`, id),
      );
      expect(await exists(table, id)).toBe(true);
      expect(await cell(table, id, col)).toEqual(before);
      /* eslint-enable no-await-in-loop */
    }
    // moving A's own row to tenant B is the same refusal (the row's tenant may not change)
    await refused(A.id, "LegacyImportBatch", (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "LegacyImportBatch" SET "tenantId" = $1 WHERE "id" = $2`,
        B.id,
        worldA.batch,
      ),
    );
    expect(await cell("LegacyImportBatch", worldA.batch, "tenantId")).toBe(A.id);
  });

  it("DB-4: a child under another tenant's parent is refused by the composite FK (23503), both ways", async () => {
    const asB = [
      (tx: any) => insertFile(tx, B.id, randomUUID(), worldA.batch),
      (tx: any) => insertIssue(tx, B.id, randomUUID(), worldA.batch, worldB.file),
      (tx: any) => insertIssue(tx, B.id, randomUUID(), worldB.batch, worldA.file),
      (tx: any) => insertDoc(tx, B.id, randomUUID(), worldA.batch, worldB.file, null),
      (tx: any) => insertDoc(tx, B.id, randomUUID(), worldB.batch, worldA.file, null),
      (tx: any) => insertLine(tx, B.id, randomUUID(), worldA.doc, null, null, 98),
    ];
    for (const insert of asB) {
      // eslint-disable-next-line no-await-in-loop
      await refusedWith("23503", B.id, insert);
    }
    const asA = [
      (tx: any) => insertFile(tx, A.id, randomUUID(), worldB.batch),
      (tx: any) => insertIssue(tx, A.id, randomUUID(), worldB.batch, worldA.file),
      (tx: any) => insertIssue(tx, A.id, randomUUID(), worldA.batch, worldB.file),
      (tx: any) => insertDoc(tx, A.id, randomUUID(), worldB.batch, worldA.file, null),
      (tx: any) => insertDoc(tx, A.id, randomUUID(), worldA.batch, worldB.file, null),
      (tx: any) => insertLine(tx, A.id, randomUUID(), worldB.doc, null, null, 98),
    ];
    for (const insert of asA) {
      // eslint-disable-next-line no-await-in-loop
      await refusedWith("23503", A.id, insert);
    }
  });

  it("DB-5 (S=A): a stored Customer or Product id of tenant B is refused with 42501 (document, line, alias: three probes, A3 LOW-D)", async () => {
    await refused(A.id, "LegacySalesDocument", (tx) =>
      insertDoc(tx, A.id, randomUUID(), worldA.batch, worldA.file, B.customerId),
    );
    await refused(A.id, "LegacySalesLine", (tx) =>
      insertLine(tx, A.id, randomUUID(), worldA.doc, B.productId, null, 97),
    );
    await refused(A.id, "SourceItemAlias", (tx) =>
      insertAlias(tx, A.id, randomUUID(), B.productId),
    );
    // an UPDATE that points an existing row at B's customer or product is the same refusal
    await refused(A.id, "LegacySalesDocument", (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "LegacySalesDocument" SET "customerId" = $1 WHERE "id" = $2`,
        B.customerId,
        worldA.doc,
      ),
    );
    await refused(A.id, "SourceItemAlias", (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "SourceItemAlias" SET "productId" = $1 WHERE "id" = $2`,
        B.productId,
        worldA.alias,
      ),
    );
    expect(await cell("LegacySalesDocument", worldA.doc, "customerId")).toBe(A.customerId);
    expect(await cell("SourceItemAlias", worldA.alias, "productId")).toBe(A.productId);
  });

  describe.each([
    ["''", ""],
    ["A", "A"],
  ])(
    "DB-6a (S=%s): a Customer hard delete nulls the document's customerId (S='' is red without the UPDATE exemption; S=A is a positive control, A2-4)",
    (_label, which) => {
      it("the delete succeeds, the ref becomes NULL, and pg_trigger_depth() inside the action is above 1", async () => {
        const session = which === "A" ? A.id : "";
        const owner = await seedCustomerAndProduct(A.id, "6a");
        const w = await withTenantTx(prisma as any, A.id, (tx) =>
          writeWorld(tx, A, owner.customerId, owner.productId),
        );
        const seen = await rolledBack(session, async (tx) => {
          await tx.$executeRawUnsafe(`
          CREATE FUNCTION zz_depth_probe() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM set_config('zz.depth', pg_trigger_depth()::text, true); RETURN NEW; END; $$`);
          await tx.$executeRawUnsafe(
            `CREATE TRIGGER zz_depth_probe BEFORE UPDATE ON "LegacySalesDocument" FOR EACH ROW EXECUTE FUNCTION zz_depth_probe()`,
          );
          await tx.$executeRawUnsafe(`DELETE FROM "Customer" WHERE "id" = $1`, owner.customerId);
          const [{ customerId, depth }] = await tx.$queryRawUnsafe(
            `SELECT (SELECT "customerId" FROM "LegacySalesDocument" WHERE "id" = $1) AS "customerId",
                  current_setting('zz.depth', true) AS depth`,
            w.doc,
          );
          return { customerId, depth };
        });
        // eslint-disable-next-line no-console
        console.info(
          `DB-6a S=${which || "''"}: pg_trigger_depth() inside the SET NULL action = ${seen.depth}`,
        );
        expect(seen.customerId).toBeNull();
        expect(Number(seen.depth)).toBeGreaterThan(1);
        // rolled back: the customer is still there
        expect(await exists("Customer", owner.customerId)).toBe(true);
      });
    },
  );

  it("DB-6b (S=A): a Product named by a line or an alias cannot be hard-deleted (RESTRICT, 23503)", async () => {
    const withLine = await seedCustomerAndProduct(A.id, "6b1");
    await withTenantTx(prisma as any, A.id, async (tx) => {
      const w = await writeWorld(tx, A, A.customerId, withLine.productId);
      // the alias of this world names the same product too: delete it so the line is the only name
      await tx.$executeRawUnsafe(`DELETE FROM "SourceItemAlias" WHERE "id" = $1`, w.alias);
    });
    await refusedWith("23503", A.id, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM "Product" WHERE "id" = $1`, withLine.productId),
    );
    expect(await exists("Product", withLine.productId)).toBe(true);

    const withAlias = await seedCustomerAndProduct(A.id, "6b2");
    const aliasId = randomUUID();
    await withTenantTx(prisma as any, A.id, (tx) =>
      insertAlias(tx, A.id, aliasId, withAlias.productId),
    );
    await refusedWith("23503", A.id, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM "Product" WHERE "id" = $1`, withAlias.productId),
    );
    expect(await exists("Product", withAlias.productId)).toBe(true);
    expect(await cell("SourceItemAlias", aliasId, "productId")).toBe(withAlias.productId);
  });

  it("DB-7 (S=A, positive control): deleting A's batch removes every child (files, issues, documents, lines)", async () => {
    // Amendment 2 A2-3: a POSITIVE CONTROL. The guard has no DELETE depth exemption; every cascaded child is A's own row, so
    // step 4 admits it at depth 2. Red only if the cascade or the guard breaks (42501, or a non-zero count).
    const w = await withTenantTx(prisma as any, A.id, (tx) => writeWorld(tx, A));
    await withTenantTx(prisma as any, A.id, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM "LegacyImportBatch" WHERE "id" = $1`, w.batch),
    );
    expect(await exists("LegacyImportBatch", w.batch)).toBe(false);
    for (const [table, id] of [
      ["LegacyImportFile", w.file],
      ["LegacyImportIssue", w.issue],
      ["LegacySalesDocument", w.doc],
      ["LegacySalesLine", w.line],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      expect(await exists(table, id)).toBe(false);
    }
    // the alias is not a child of the batch
    expect(await exists("SourceItemAlias", w.alias)).toBe(true);
  });

  /** A test-only AFTER INSERT trigger on a temp table that runs `body` at depth 2 (rolled back with the transaction). */
  const depthTwo = async (tx: any, body: string) => {
    await tx.$executeRawUnsafe(`CREATE TEMP TABLE zz_probe (i int) ON COMMIT DROP`);
    await tx.$executeRawUnsafe(
      `CREATE FUNCTION zz_probe_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END; $$`,
    );
    await tx.$executeRawUnsafe(
      `CREATE TRIGGER zz_probe AFTER INSERT ON zz_probe FOR EACH ROW EXECUTE FUNCTION zz_probe_fn()`,
    );
    await tx.$executeRawUnsafe(`INSERT INTO zz_probe VALUES (1)`);
  };

  it("DB-8 (S=A, rolled back): a trigger on another table that INSERTs a B row at depth 2 is refused with 42501", async () => {
    const bBatch = randomUUID();
    const err = await rolledBack(A.id, (tx) =>
      depthTwo(
        tx,
        `INSERT INTO "LegacyImportBatch" ("id","tenantId","source","createdById","updatedAt")
         VALUES ('${bBatch}','${B.id}','QUICKBOOKS','acme-user',now());`,
      ).then(
        () => undefined,
        (e) => e,
      ),
    );
    expect(sqlState(err)).toBe("42501");
    expect(await exists("LegacyImportBatch", bBatch)).toBe(false);
  });

  /**
   * A depth-2 probe inside a SAVEPOINT (A3-2): runs `body` through the test-only scratch-table trigger, rolls back to the
   * savepoint when it raised (so the read-back does not hit 25P02), then reads `readSql` in the same transaction. The
   * read-back is what shows the red value (the row changed) when the guard does not refuse.
   */
  const nestedProbe = (session: string, body: string, readSql: string, readArgs: unknown[]) =>
    rolledBack(session, async (tx) => {
      await tx.$executeRawUnsafe(`SAVEPOINT zz_probe_sp`);
      const err = await depthTwo(tx, body).then(
        () => undefined,
        (e) => e,
      );
      if (err) await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT zz_probe_sp`);
      const rows = await tx.$queryRawUnsafe(readSql, ...readArgs);
      return { err, rows: rows as Array<Record<string, unknown>> };
    });

  /** The A3-2 unlink probe: one UPDATE that nulls customerId AND changes sourceKey (the equality clause is what refuses it). */
  const unlinkAndEdit = (docId: string) =>
    `UPDATE "LegacySalesDocument" SET "customerId" = NULL, "sourceKey" = 'x' WHERE "id" = '${docId}';`;
  const docRead = `SELECT "customerId", "sourceKey" FROM "LegacySalesDocument" WHERE "id" = $1`;

  it("DB-9 (S=A, rolled back, savepoint): a depth-2 UPDATE that nulls customerId AND changes sourceKey on B's document is refused with 42501", async () => {
    const beforeCustomer = await cell("LegacySalesDocument", worldB.doc, "customerId");
    const beforeKey = await cell("LegacySalesDocument", worldB.doc, "sourceKey");
    expect(beforeCustomer).toBe(B.customerId); // the unlink form needs a NON-NULL customerId
    expect(beforeKey).not.toBe("x");
    const { err, rows } = await nestedProbe(A.id, unlinkAndEdit(worldB.doc), docRead, [worldB.doc]);
    expect(sqlState(err)).toBe("42501");
    // red without the equality clause: customerId NULL and sourceKey 'x'
    expect(rows[0]).toEqual({ customerId: B.customerId, sourceKey: beforeKey });
    expect(await cell("LegacySalesDocument", worldB.doc, "sourceKey")).toBe(beforeKey);
  });

  it("DB-9b (S='', rolled back, savepoint): the same UPDATE through the same trigger on A's own document is refused with 42501 and the row is unchanged", async () => {
    // Not the 'own row is fine' control (DB-11 and DB-6a are): with no session tenant a nested change cannot ride the
    // unlink form to edit other columns, and A's row separates this refusal (step 3) from DB-9's tenant mismatch (step 4).
    const beforeCustomer = await cell("LegacySalesDocument", worldA.doc, "customerId");
    const beforeKey = await cell("LegacySalesDocument", worldA.doc, "sourceKey");
    expect(beforeCustomer).toBe(A.customerId);
    expect(beforeKey).not.toBe("x");
    const { err, rows } = await nestedProbe("", unlinkAndEdit(worldA.doc), docRead, [worldA.doc]);
    expect(sqlState(err)).toBe("42501");
    // red without the equality clause: customerId NULL and sourceKey 'x'
    expect(rows[0]).toEqual({ customerId: A.customerId, sourceKey: beforeKey });
    expect(await cell("LegacySalesDocument", worldA.doc, "sourceKey")).toBe(beforeKey);
  });

  it("DB-8d (S=A, rolled back, savepoint): a trigger on another table that DELETEs B's issue at depth 2 is refused with 42501 (no DELETE exemption)", async () => {
    expect(await exists("LegacyImportIssue", worldB.issue)).toBe(true);
    const { err, rows } = await nestedProbe(
      A.id,
      `DELETE FROM "LegacyImportIssue" WHERE "id" = '${worldB.issue}';`,
      `SELECT count(*)::int AS n FROM "LegacyImportIssue" WHERE "id" = $1`,
      [worldB.issue],
    );
    expect(sqlState(err)).toBe("42501");
    // red with a nested DELETE exemption: no error and n = 0
    expect(rows[0]).toEqual({ n: 1 });
    expect(await exists("LegacyImportIssue", worldB.issue)).toBe(true);
  });

  it("DB-12 (S=A): A's product that A's line names cannot be deleted (23503); after the six, children-first, it can (rolled back)", async () => {
    const own = await seedCustomerAndProduct(A.id, "12");
    const w = await withTenantTx(prisma as any, A.id, (tx) =>
      writeWorld(tx, A, A.customerId, own.productId),
    );
    await refusedWith("23503", A.id, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM "Product" WHERE "id" = $1`, own.productId),
    );
    const left = await rolledBack(A.id, async (tx) => {
      // the wipe order of SA-1507 A2-1: line, document, issue, file, batch, alias, then the product
      for (const [table, id] of [
        ["LegacySalesLine", w.line],
        ["LegacySalesDocument", w.doc],
        ["LegacyImportIssue", w.issue],
        ["LegacyImportFile", w.file],
        ["LegacyImportBatch", w.batch],
        ["SourceItemAlias", w.alias],
      ] as const) {
        // eslint-disable-next-line no-await-in-loop
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "id" = $1`, id);
      }
      await tx.$executeRawUnsafe(`DELETE FROM "Product" WHERE "id" = $1`, own.productId);
      const rows = await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM "Product" WHERE "id" = $1`,
        own.productId,
      );
      return rows[0].n as number;
    });
    expect(left).toBe(0);
    expect(await exists("Product", own.productId)).toBe(true);
  });

  it("DB-10: the FK set, the triggers, the function bodies and the rules on the six are exactly the contract (A1-10)", async () => {
    const six = [...IMPORT_HISTORY_MODELS];
    const fks = await prisma.$queryRawUnsafe<
      { table: string; ref: string; cols: string; refcols: string; del: string; upd: string }[]
    >(
      `SELECT c.conrelid::regclass::text AS "table", c.confrelid::regclass::text AS ref,
              (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
              (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS refcols,
              c.confdeltype::text AS del, c.confupdtype::text AS upd
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND (c.conrelid::regclass::text = ANY($1) OR c.confrelid::regclass::text = ANY($1)
               OR c.conrelid::regclass::text = ANY($2) OR c.confrelid::regclass::text = ANY($2))`,
      six,
      six.map((m) => `"${m}"`),
    );
    const norm = (t: string) => t.replace(/"/g, "");
    const got = fks
      .map(
        (f) =>
          `${norm(f.table)}(${f.cols}) -> ${norm(f.ref)}(${f.refcols}) del=${f.del} upd=${f.upd}`,
      )
      .sort();
    const want = [
      "LegacyImportFile(tenantId,batchId) -> LegacyImportBatch(tenantId,id) del=c upd=a",
      "LegacyImportIssue(tenantId,batchId) -> LegacyImportBatch(tenantId,id) del=c upd=a",
      "LegacyImportIssue(tenantId,fileId) -> LegacyImportFile(tenantId,id) del=c upd=a",
      "LegacySalesDocument(tenantId,batchId) -> LegacyImportBatch(tenantId,id) del=c upd=a",
      "LegacySalesDocument(tenantId,fileId) -> LegacyImportFile(tenantId,id) del=c upd=a",
      "LegacySalesLine(tenantId,documentId) -> LegacySalesDocument(tenantId,id) del=c upd=a",
      "LegacySalesDocument(customerId) -> Customer(id) del=n upd=a",
      "LegacySalesLine(productId) -> Product(id) del=r upd=a",
      "SourceItemAlias(productId) -> Product(id) del=r upd=a",
    ].sort();
    expect(got).toEqual(want);

    const triggers = await prisma.$queryRawUnsafe<
      { rel: string; name: string; fn: string; type: number }[]
    >(
      `SELECT t.tgrelid::regclass::text AS rel, t.tgname AS name, p.proname AS fn, t.tgtype::int AS type
         FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal AND (t.tgrelid::regclass::text = ANY($1) OR t.tgrelid::regclass::text = ANY($2))`,
      six,
      six.map((m) => `"${m}"`),
    );
    // tgtype 31 = ROW (1) + BEFORE (2) + INSERT (4) + DELETE (8) + UPDATE (16)
    expect(triggers.map((t) => `${norm(t.rel)} ${t.name} ${t.fn} ${t.type}`).sort()).toEqual(
      six.map((m) => `${m} ${m}_tenant_guard legacy_import_tenant_guard 31`).sort(),
    );

    const procs = await prisma.$queryRawUnsafe<{ proname: string }[]>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosrc ~ $1`,
      `(${six.join("|")})`,
    );
    expect(procs.map((p) => p.proname)).toEqual(["legacy_import_tenant_guard"]);

    const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_rules WHERE tablename = ANY($1)`,
      six,
    );
    expect(n).toBe(0);
  });

  it("DB-11 (S=A, positive control): writes to all six succeed for A, in raw SQL and through tenantTransaction", async () => {
    const w = await withTenantTx(prisma as any, A.id, (tx) => writeWorld(tx, A));
    for (const [table, id] of [
      ["LegacyImportBatch", w.batch],
      ["LegacyImportFile", w.file],
      ["LegacyImportIssue", w.issue],
      ["LegacySalesDocument", w.doc],
      ["LegacySalesLine", w.line],
      ["SourceItemAlias", w.alias],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      expect(await exists(table, id)).toBe(true);
    }
    // update and delete of A's own row
    await withTenantTx(prisma as any, A.id, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE "LegacySalesDocument" SET "sourceCustomerKey" = 'acme-2' WHERE "id" = $1`,
        w.doc,
      );
      await tx.$executeRawUnsafe(`DELETE FROM "LegacySalesLine" WHERE "id" = $1`, w.line);
    });
    expect(await cell("LegacySalesDocument", w.doc, "sourceCustomerKey")).toBe("acme-2");
    expect(await exists("LegacySalesLine", w.line)).toBe(false);

    // the same writes through the real PrismaService.tenantTransaction, which sets the session tenant from the context
    const ids = { batch: randomUUID(), file: randomUUID(), doc: randomUUID() };
    await tenantCtx.run(A.id, () =>
      svc.tenantTransaction(async (tx: any) => {
        await insertBatch(tx, A.id, ids.batch);
        await insertFile(tx, A.id, ids.file, ids.batch);
        await insertDoc(tx, A.id, ids.doc, ids.batch, ids.file, A.customerId);
      }),
    );
    expect(await exists("LegacySalesDocument", ids.doc)).toBe(true);
    // and with no tenant in the context the same transaction sets '' and the guard refuses it
    const err = await svc
      .tenantTransaction((tx: any) => insertBatch(tx, A.id, randomUUID()))
      .then(
        () => undefined,
        (e) => e,
      );
    expect(sqlState(err)).toBe("42501");
  });
});
