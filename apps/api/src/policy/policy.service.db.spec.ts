/**
 * SA-138 §3.6 — PolicyService against a REAL Postgres: layering default → TENANT → CATEGORY →
 * CUSTOMER, append-only supersede, two concurrent sets serialised by the `policy-write` advisory
 * lock (exactly one active row), an invalid stored value skipped, a DB error resolving the
 * default, cache invalidation, the audit row's shape, and tenant isolation.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`;
 * `requireLocalDatabaseUrl()` refuses any non-local host. SAFETY: every tenant is a throwaway
 * `qa-policy-<run>-<n>` slug approved by `assertTestTenant`; `afterAll` deletes exactly the
 * tenants THIS run created (PolicyValue cascades; AuditLog has no FK, so it is deleted by tenantId).
 *
 * None of the three pilot keys allows CATEGORY scope (the registry keeps it closed until a pilot
 * needs it), so the full four-layer order is proven on a spec-only probe key added through a
 * `jest.mock` of the registry — the resolver is generic over entries, and the probe never ships.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { PolicyService } from "./policy.service";
import type { PolicyKey } from "./policy-registry";

const PROBE = "qa.layerProbe";

jest.mock("./policy-registry", () => {
  const actual = jest.requireActual("./policy-registry");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { z } = require("zod/v4");
  const probe = {
    key: "qa.layerProbe",
    area: "qa",
    kind: "enum",
    schema: z.enum(["default", "tenant", "category", "customer"]),
    default: "default",
    scopes: ["TENANT", "CATEGORY", "CUSTOMER"],
    description: "spec-only probe",
    added: "2026-09-24",
  };
  return {
    ...actual,
    POLICY_REGISTRY: [...actual.POLICY_REGISTRY, probe],
    policyEntry: (k: string) => (k === probe.key ? probe : actual.policyEntry(k)),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const probeKey = PROBE as PolicyKey;

describeDb("PolicyService — real Postgres (SA-138 phase 1)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanup(tenantId).catch((e) => {
        console.warn(`policy.service.db.spec: cleanup of tenant ${tenantId} failed: ${e}`);
      });
    }
    await _resetLockPoolForTests();
    await prisma?.$disconnect();
  });

  async function cleanup(tenantId: string): Promise<void> {
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.policyValue.deleteMany({ where: { tenantId } });
    await prisma.trackedCategory.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  /** A fresh qa-* tenant with one customer and one tracked category. */
  async function seed() {
    seq += 1;
    const slug = assertTestTenant(`qa-policy-${RUN}-${seq}`, "policy.service.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `Policy ${slug}` } });
    tenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `Acme ${seq}`, contactName: "c", tenantId: tenant.id },
    });
    const category = await prisma.trackedCategory.create({
      data: { tenantId: tenant.id, name: `cat-${seq}` },
    });
    return { tenantId: tenant.id, customerId: customer.id, categoryId: category.id };
  }

  const actor = { id: null, name: "qa-admin", impersonatedBy: null };
  /** Writes run inside the tenant's request context, as the controller's do. */
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const fresh = () => new PolicyService(prisma); // no cache carried between phases

  it("no rows → every key resolves its registry default", async () => {
    const t = await seed();
    const svc = fresh();
    expect(await svc.resolve(t.tenantId, "orders.driverAtDoorEdit")).toBe("amend");
    expect(await svc.resolve(t.tenantId, "credit.approvalThreshold")).toBeNull();
    expect(await svc.resolve(t.tenantId, "invoicing.priceDisclosure")).toEqual([
      "originalPrice",
      "discount",
      "msrp",
    ]);
    expect(await svc.resolve(t.tenantId, probeKey)).toBe("default");
  });

  it("layers default → TENANT → CATEGORY → CUSTOMER, the most specific winning", async () => {
    const t = await seed();
    const svc = fresh();
    const set = (
      scopeType: "TENANT" | "CATEGORY" | "CUSTOMER",
      scopeId: string | null,
      value: string,
    ) =>
      inTenant(t.tenantId, () =>
        svc.set({
          tenantId: t.tenantId,
          key: PROBE,
          scopeType,
          scopeId,
          value,
          reason: "layer",
          actor,
        }),
      );

    await set("TENANT", null, "tenant");
    expect(await svc.resolve(t.tenantId, probeKey)).toBe("tenant");
    await set("CATEGORY", t.categoryId, "category");
    expect(await svc.resolve(t.tenantId, probeKey)).toBe("tenant"); // no category in scope
    expect(await svc.resolve(t.tenantId, probeKey, { categoryId: t.categoryId })).toBe("category");
    await set("CUSTOMER", t.customerId, "customer");
    expect(
      await svc.resolve(t.tenantId, probeKey, {
        categoryId: t.categoryId,
        customerId: t.customerId,
      }),
    ).toBe("customer");
    expect(await svc.resolve(t.tenantId, probeKey, { customerId: "someone-else" })).toBe("tenant");

    // A real pilot key: CUSTOMER over TENANT through the same path.
    await inTenant(t.tenantId, () =>
      svc.set({
        tenantId: t.tenantId,
        key: "credit.approvalThreshold",
        scopeType: "TENANT",
        value: 500,
        reason: "band",
        actor,
      }),
    );
    await inTenant(t.tenantId, () =>
      svc.set({
        tenantId: t.tenantId,
        key: "credit.approvalThreshold",
        scopeType: "CUSTOMER",
        scopeId: t.customerId,
        value: 0,
        reason: "tight",
        actor,
      }),
    );
    expect(await svc.resolve(t.tenantId, "credit.approvalThreshold")).toBe(500);
    expect(
      await svc.resolve(t.tenantId, "credit.approvalThreshold", { customerId: t.customerId }),
    ).toBe(0);

    // `null` ("no band" — today's hard block) is a real value that overrides a tenant band: it is
    // stored as JSON null (jsonb 'null'), never SQL NULL, and resolves as null, not as "unset".
    await inTenant(t.tenantId, () =>
      svc.set({
        tenantId: t.tenantId,
        key: "credit.approvalThreshold",
        scopeType: "CUSTOMER",
        scopeId: t.customerId,
        value: null,
        reason: "no band for this one",
        actor,
      }),
    );
    expect(
      await svc.resolve(t.tenantId, "credit.approvalThreshold", { customerId: t.customerId }),
    ).toBeNull();
    const [stored] = await prisma.$queryRaw<{ t: string }[]>`
      SELECT jsonb_typeof(value) AS t FROM "PolicyValue"
      WHERE "tenantId" = ${t.tenantId} AND key = 'credit.approvalThreshold'
        AND "scopeType" = 'CUSTOMER' AND "supersededAt" IS NULL`;
    expect(stored.t).toBe("null");
  });

  it("append-only: a second set supersedes the first (stamped with the new row's id); a superseded row is ignored", async () => {
    const t = await seed();
    const svc = fresh();
    const first = await inTenant(t.tenantId, () =>
      svc.set({
        tenantId: t.tenantId,
        key: "orders.driverAtDoorEdit",
        scopeType: "TENANT",
        value: "replace",
        reason: "one",
        actor,
      }),
    );
    const second = await inTenant(t.tenantId, () =>
      svc.set({
        tenantId: t.tenantId,
        key: "orders.driverAtDoorEdit",
        scopeType: "TENANT",
        value: "disabled",
        reason: "two",
        actor,
      }),
    );

    const rows = await prisma.policyValue.findMany({
      where: { tenantId: t.tenantId, key: "orders.driverAtDoorEdit" },
    });
    expect(rows).toHaveLength(2); // nothing deleted
    const old = rows.find((r) => r.id === first.id)!;
    expect(old.supersededAt).not.toBeNull();
    expect(old.supersededById).toBe(second.id);
    expect(old.value).toBe("replace"); // nothing updated but the stamps
    expect(rows.find((r) => r.id === second.id)!.supersededAt).toBeNull();
    expect(await fresh().resolve(t.tenantId, "orders.driverAtDoorEdit")).toBe("disabled");

    // A superseded row is ignored even when it is the NEWEST row at that scope.
    await prisma.policyValue.create({
      data: {
        tenantId: t.tenantId,
        key: "orders.driverAtDoorEdit",
        scopeType: "TENANT",
        value: "amend",
        reason: "hand-planted",
        createdAt: new Date(Date.now() + 60_000),
        supersededAt: new Date(),
      },
    });
    expect(await fresh().resolve(t.tenantId, "orders.driverAtDoorEdit")).toBe("disabled");

    // History = the superseded rows, newest first.
    const history = await svc.history(t.tenantId, "orders.driverAtDoorEdit");
    expect(history.map((r) => r.reason)).toEqual(["hand-planted", "one"]);
  });

  it("two concurrent sets on one key serialise on the policy-write lock and leave exactly ONE active row", async () => {
    const t = await seed();
    const a = fresh();
    const b = fresh(); // two "replicas": separate caches, shared DB + advisory lock
    // Force the race window open: a test-scoped trigger sleeps 300 ms inside each writer's INSERT
    // (only for this test's `race-*` reasons). Without the lock both transactions read "no active
    // row" before either commits and BOTH rows stay active — verified by bypassing the lock. The
    // trigger and its function are dropped in `finally`, so the shared DB lane is left untouched.
    const RACE = `qa_policy_race_${RUN}`; // per-run name: parallel DB lanes never share it
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ${RACE}() RETURNS trigger AS $$
      BEGIN
        IF NEW."reason" LIKE 'race-%' THEN PERFORM pg_sleep(0.3); END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER ${RACE} BEFORE INSERT ON "PolicyValue"
      FOR EACH ROW EXECUTE FUNCTION ${RACE}()`);
    let results;
    try {
      results = await Promise.all([
        inTenant(t.tenantId, () =>
          a.set({
            tenantId: t.tenantId,
            key: "credit.approvalThreshold",
            scopeType: "TENANT",
            value: 100,
            reason: "race-a",
            actor,
          }),
        ),
        inTenant(t.tenantId, () =>
          b.set({
            tenantId: t.tenantId,
            key: "credit.approvalThreshold",
            scopeType: "TENANT",
            value: 200,
            reason: "race-b",
            actor,
          }),
        ),
      ]);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${RACE} ON "PolicyValue"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${RACE}()`);
    }

    const rows = await prisma.policyValue.findMany({
      where: { tenantId: t.tenantId, key: "credit.approvalThreshold" },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    const active = rows.filter((r) => r.supersededAt === null);
    expect(active).toHaveLength(1);
    const loser = rows.find((r) => r.supersededAt !== null)!;
    expect(loser.supersededById).toBe(active[0].id); // the later writer saw and superseded the earlier
    expect(results.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it("an invalid stored value is skipped and the next layer down wins", async () => {
    const t = await seed();
    await inTenant(t.tenantId, () =>
      fresh().set({
        tenantId: t.tenantId,
        key: "orders.driverAtDoorEdit",
        scopeType: "TENANT",
        value: "replace",
        reason: "ok",
        actor,
      }),
    );
    // Hand-written garbage at the CUSTOMER layer (a value the registry no longer accepts).
    await prisma.policyValue.create({
      data: {
        tenantId: t.tenantId,
        key: "orders.driverAtDoorEdit",
        scopeType: "CUSTOMER",
        scopeId: t.customerId,
        value: { mode: "sometimes" },
        reason: "hand-planted",
      },
    });
    expect(
      await fresh().resolve(t.tenantId, "orders.driverAtDoorEdit", { customerId: t.customerId }),
    ).toBe("replace");

    // And an invalid TENANT layer falls all the way back to the default.
    const t2 = await seed();
    await prisma.policyValue.create({
      data: {
        tenantId: t2.tenantId,
        key: "credit.approvalThreshold",
        scopeType: "TENANT",
        value: -5,
        reason: "bad",
      },
    });
    expect(await fresh().resolve(t2.tenantId, "credit.approvalThreshold")).toBeNull();
  });

  it("a DB error (at the client boundary) resolves the default and never throws", async () => {
    const t = await seed();
    await inTenant(t.tenantId, () =>
      fresh().set({
        tenantId: t.tenantId,
        key: "credit.approvalThreshold",
        scopeType: "TENANT",
        value: 900,
        reason: "x",
        actor,
      }),
    );
    const svc = fresh();
    const spy = jest
      .spyOn(prisma.policyValue, "findMany")
      .mockRejectedValueOnce(new Error("connection terminated unexpectedly"));
    try {
      await expect(svc.resolve(t.tenantId, "credit.approvalThreshold")).resolves.toBeNull();
    } finally {
      spy.mockRestore();
    }
    // Nothing poisoned the cache: the next read sees the real row.
    expect(await svc.resolve(t.tenantId, "credit.approvalThreshold")).toBe(900);
  });

  it("the 30 s cache serves a stale value until invalidate(); set() invalidates on its own", async () => {
    const t = await seed();
    const svc = fresh();
    expect(await svc.resolve(t.tenantId, "orders.driverAtDoorEdit")).toBe("amend"); // cached
    await prisma.policyValue.create({
      data: {
        tenantId: t.tenantId,
        key: "orders.driverAtDoorEdit",
        scopeType: "TENANT",
        value: "disabled",
        reason: "behind the cache",
      },
    });
    expect(await svc.resolve(t.tenantId, "orders.driverAtDoorEdit")).toBe("amend");
    svc.invalidate(t.tenantId);
    expect(await svc.resolve(t.tenantId, "orders.driverAtDoorEdit")).toBe("disabled");

    await inTenant(t.tenantId, () =>
      svc.set({
        tenantId: t.tenantId,
        key: "orders.driverAtDoorEdit",
        scopeType: "TENANT",
        value: "replace",
        reason: "via set",
        actor,
      }),
    );
    expect(await svc.resolve(t.tenantId, "orders.driverAtDoorEdit")).toBe("replace");
  });

  it("each set/clear writes exactly ONE audit row with the {key, scopeType, scopeId, old, new, reason} meta", async () => {
    const t = await seed();
    const svc = fresh();
    const who = { id: null, name: "qa-admin", impersonatedBy: "sa-qa" };
    const first = await inTenant(t.tenantId, () =>
      svc.set({
        tenantId: t.tenantId,
        key: "invoicing.priceDisclosure",
        scopeType: "CUSTOMER",
        scopeId: t.customerId,
        value: ["discount"],
        reason: "hide msrp",
        actor: who,
      }),
    );
    const second = await inTenant(t.tenantId, () =>
      svc.set({
        tenantId: t.tenantId,
        key: "invoicing.priceDisclosure",
        scopeType: "CUSTOMER",
        scopeId: t.customerId,
        value: [],
        reason: "hide all",
        actor: who,
      }),
    );
    await inTenant(t.tenantId, () =>
      svc.clear({
        tenantId: t.tenantId,
        key: "invoicing.priceDisclosure",
        scopeType: "CUSTOMER",
        scopeId: t.customerId,
        reason: "back to tenant",
        actor: who,
      }),
    );

    const audit = await prisma.auditLog.findMany({
      where: { tenantId: t.tenantId, entityType: "PolicyValue" },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((a) => [a.action, a.entityId, a.impersonatedBy])).toEqual([
      ["policy.set", first.id, "sa-qa"],
      ["policy.set", second.id, "sa-qa"],
      ["policy.clear", second.id, "sa-qa"],
    ]);
    expect(audit.map((a) => a.meta)).toEqual([
      {
        key: "invoicing.priceDisclosure",
        scopeType: "CUSTOMER",
        scopeId: t.customerId,
        old: null,
        new: ["discount"],
        reason: "hide msrp",
      },
      {
        key: "invoicing.priceDisclosure",
        scopeType: "CUSTOMER",
        scopeId: t.customerId,
        old: ["discount"],
        new: [],
        reason: "hide all",
      },
      {
        key: "invoicing.priceDisclosure",
        scopeType: "CUSTOMER",
        scopeId: t.customerId,
        old: [],
        new: null,
        reason: "back to tenant",
      },
    ]);

    const active = await prisma.policyValue.count({
      where: { tenantId: t.tenantId, supersededAt: null },
    });
    expect(active).toBe(0); // the clear superseded, never deleted
    expect(await prisma.policyValue.count({ where: { tenantId: t.tenantId } })).toBe(2);
    expect(
      await svc.resolve(t.tenantId, "invoicing.priceDisclosure", { customerId: t.customerId }),
    ).toEqual(["originalPrice", "discount", "msrp"]);
  });

  it("tenant isolation: another tenant's rows are invisible to resolve and under forTenant(), and its customer is not a valid scope target", async () => {
    const a = await seed();
    const b = await seed();
    await inTenant(b.tenantId, () =>
      fresh().set({
        tenantId: b.tenantId,
        key: "orders.driverAtDoorEdit",
        scopeType: "TENANT",
        value: "disabled",
        reason: "b only",
        actor,
      }),
    );

    expect(await fresh().resolve(a.tenantId, "orders.driverAtDoorEdit")).toBe("amend");
    expect(await fresh().resolve(b.tenantId, "orders.driverAtDoorEdit")).toBe("disabled");

    const seenByA = await tenantCtx.run(a.tenantId, () =>
      prisma.forTenant().policyValue.findMany({ where: { key: "orders.driverAtDoorEdit" } }),
    );
    expect(seenByA).toEqual([]);

    const err = await inTenant(a.tenantId, () =>
      fresh().set({
        tenantId: a.tenantId,
        key: "orders.driverAtDoorEdit",
        scopeType: "CUSTOMER",
        scopeId: b.customerId,
        value: "replace",
        reason: "cross",
        actor,
      }),
    ).catch((e) => e);
    expect(err.getResponse?.().code).toBe("POLICY_SCOPE_TARGET_UNKNOWN");
    expect(await prisma.policyValue.count({ where: { tenantId: a.tenantId } })).toBe(0);
  });
});
