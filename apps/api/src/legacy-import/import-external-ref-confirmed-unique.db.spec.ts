/**
 * SA-1295 T45, the index half: migration 20261126000100 puts a PARTIAL unique index on "ImportExternalRef"
 * ("tenantId","externalSource","entityType","entityId") WHERE "confirmedAt" IS NOT NULL: one confirmed binding per entity
 * and source, in a database migrated from the tree. An unconfirmed binding is unconstrained by it, so the old
 * (tenantId, externalSource, externalId, entityType) unique and every existing writer keep working (no old path sets
 * confirmedAt). The constraint is the claim, so the rows go in as raw SQL. Synthetic `acme` ids, one throwaway
 * `qa-sa1295-<run>` tenant, cleaned in `afterAll`.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const INDEX = "ImportExternalRef_confirmed_entity_key";

const text = (err: any): string =>
  String(
    err?.meta?.driverAdapterError?.cause?.originalMessage ??
      err?.meta?.message ??
      err?.message ??
      "",
  );
const state = (err: any): string | undefined =>
  err?.meta?.driverAdapterError?.cause?.originalCode ??
  err?.cause?.originalCode ??
  err?.meta?.code ??
  err?.code;

describeDb("T45 index half: one confirmed binding per entity and source (real Postgres)", () => {
  let prisma: PrismaClient;
  const run = randomUUID().slice(0, 8);
  let tenantId: string;

  const bind = (p: {
    entity: string;
    source: string;
    externalId: string;
    confirmed: boolean;
    entityType?: string;
  }) =>
    prisma.$executeRaw`
      INSERT INTO "ImportExternalRef"
        ("id", "tenantId", "entityType", "entityId", "externalSource", "externalId", "updatedAt", "confirmedAt")
      VALUES
        (${randomUUID()}, ${tenantId}, ${p.entityType ?? "CUSTOMER"}::"ImportEntityType", ${p.entity}, ${p.source},
         ${p.externalId}, now(), ${p.confirmed ? new Date() : null})`;

  beforeAll(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: requireLocalDatabaseUrl() }),
    });
    const tenant = await prisma.tenant.create({
      data: { slug: assertTestTenant(`qa-sa1295-${run}`, "t45"), name: "SA-1295 T45" },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM "ImportExternalRef" WHERE "tenantId" = ${tenantId}`;
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it("the index exists, is unique and partial on confirmedAt IS NOT NULL", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${INDEX}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/^CREATE UNIQUE INDEX/);
    expect(rows[0].indexdef).toMatch(
      /WHERE \(\("?confirmedAt"?\) IS NOT NULL\)|WHERE \("confirmedAt" IS NOT NULL\)/,
    );
  });

  it("a second CONFIRMED binding for one entity and source is refused with 23505 on the index", async () => {
    await bind({ entity: "acme-cust-1", source: "qb", externalId: "acme-ext-1", confirmed: true });
    const err = await bind({
      entity: "acme-cust-1",
      source: "qb",
      externalId: "acme-ext-2",
      confirmed: true,
    }).then(
      () => undefined,
      (e) => e,
    );
    expect(err).toBeDefined();
    expect(state(err)).toBe("23505");
    expect(text(err)).toContain(INDEX);
  });

  it("an unconfirmed binding is not constrained by it (old writers keep working)", async () => {
    await bind({ entity: "acme-cust-2", source: "qb", externalId: "acme-ext-3", confirmed: false });
    await bind({ entity: "acme-cust-2", source: "qb", externalId: "acme-ext-4", confirmed: false });
    // and one confirmed next to unconfirmed ones is fine
    await bind({ entity: "acme-cust-2", source: "qb", externalId: "acme-ext-5", confirmed: true });
    const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM "ImportExternalRef" WHERE "tenantId" = ${tenantId} AND "entityId" = 'acme-cust-2'`;
    expect(n).toBe(3);
  });

  it("a confirmed binding for another source, another entity type or another entity is allowed", async () => {
    await bind({ entity: "acme-cust-3", source: "qb", externalId: "acme-ext-6", confirmed: true });
    await bind({
      entity: "acme-cust-3",
      source: "odoo",
      externalId: "acme-ext-7",
      confirmed: true,
    });
    await bind({
      entity: "acme-cust-3",
      source: "qb",
      externalId: "acme-ext-8",
      confirmed: true,
      entityType: "PRODUCT",
    });
    await bind({ entity: "acme-cust-4", source: "qb", externalId: "acme-ext-9", confirmed: true });
  });

  it("the existing unique on (tenantId, externalSource, externalId, entityType) still holds", async () => {
    await bind({
      entity: "acme-cust-5",
      source: "qb",
      externalId: "acme-ext-10",
      confirmed: false,
    });
    const err = await bind({
      entity: "acme-cust-6",
      source: "qb",
      externalId: "acme-ext-10",
      confirmed: false,
    }).then(
      () => undefined,
      (e) => e,
    );
    expect(state(err)).toBe("23505");
    expect(text(err)).not.toContain(INDEX);
  });
});
