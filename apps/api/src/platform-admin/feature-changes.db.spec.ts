/**
 * WP11 (SA-1106 C2; R27 R28 R32 R53), real Postgres: one reviewed set of feature changes is one transaction.
 *
 * Oracles are worked by hand: a fresh STARTER business has no override rows, so the live rows after a save are
 * exactly the rows the set asked for; a refused or failed set leaves the table and the audit trail as they were.
 *   - T32: a stale `expected` is refused with 409 and writes nothing; the hash moves on any override change.
 *   - T27: one set = one audit row; a set with one bad change writes nothing; a write that throws mid-set
 *     leaves nothing behind (no rows, no audit row); two saves at the same hash: one wins, one gets 409.
 *   - T53: the audit meta carries before / after / actor / ids / both hashes.
 *   - T28: undo restores the state before the save; refused after a later change, after a first undo, and across
 *     businesses.
 *   - Cache: a rolled-back set invalidates nothing and the cached override view still equals the database; a
 *     committed set invalidates after the commit.
 *
 * Collected only by `jest.db.config.js`. SAFETY: throwaway `qa-fchg-<run>-*` tenants approved by
 * `assertTestTenant`; afterAll deletes exactly what this run created.
 */
import { randomUUID } from "crypto";
import { ConflictException } from "@nestjs/common";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { EntitlementsModeService } from "../billing/entitlements-mode.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { FeatureDiffService } from "../billing/feature-diff.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { FeatureResolverService } from "../billing/feature-resolver.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { ADMIN_AUDIT_ENTITY, AdminAuditAction } from "./audit-actions.constant";
import { ApplyFeatureChangesDto } from "./dto/feature-changes.dto";
import { FeatureChangeService, FeatureChangeSetMeta } from "./feature-change.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "feature-changes.db.spec.ts";
const A = "ocr"; // overridable, no requires
const B = "tobacco_dealer"; // overridable, no requires
const NOT_OVERRIDABLE = "flag.dispatch_live"; // grant.override === false
const NEEDS = "driver_payments"; // requires anyOf recurring_routes | order_delivery
const PREREQ = "order_delivery";

describeDb("WP11: feature change sets (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let svc: FeatureChangeService;
  let overrides: FeatureOverrideService;
  let authority: EntitlementAuthority;
  let versionId: string;
  let createdVersionId: string | undefined;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  const actor = randomUUID();
  let seq = 0;

  async function tenant(): Promise<string> {
    const slug = assertTestTenant(`qa-fchg-${run}-${++seq}`, SPEC);
    const row = await prisma.tenant.create({
      data: {
        slug,
        name: `Acme Change Fixture ${seq} ${run}`,
        class: TenantClass.PRODUCTION,
        status: TenantStatus.ACTIVE,
        planVersionId: versionId,
      } as never,
    });
    tenantIds.push(row.id);
    await prisma.tenantSubscription.create({
      data: {
        tenantId: row.id,
        planKey: "STARTER",
        planVersionId: versionId,
        discount: 0,
      } as never,
    });
    return row.id;
  }

  const dto = (
    expected: string,
    changes: ApplyFeatureChangesDto["changes"],
    extra: Partial<ApplyFeatureChangesDto> = {},
  ): ApplyFeatureChangesDto => ({ expected, reason: `${SPEC} fixture`, changes, ...extra });

  const live = (tenantId: string) =>
    prisma.tenantFeatureOverride.findMany({
      where: { tenantId, revokedAt: null },
      orderBy: { featureKey: "asc" },
    });
  const allRows = (tenantId: string) => prisma.tenantFeatureOverride.count({ where: { tenantId } });
  const audits = (tenantId: string, action?: string) =>
    prisma.auditLog.findMany({
      where: { tenantId, entityType: ADMIN_AUDIT_ENTITY, ...(action ? { action } : {}) },
      orderBy: { createdAt: "asc" },
    });
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (e) {
      const body = (e as { getResponse?: () => unknown }).getResponse?.() as
        { code?: string } | string;
      return typeof body === "object" && body?.code ? body.code : String((e as Error).message);
    }
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    createdVersionId = await ensurePublishedCatalog(
      prisma,
      { plans: [{ planKey: "STARTER", name: "Starter", monthlyPrice: 99 }], addons: [] },
      SPEC,
    );
    versionId = (await prisma.planVersion.findFirstOrThrow({ where: { status: "PUBLISHED" } })).id;
    const catalog = new PlanCatalogService(prisma as never);
    overrides = new FeatureOverrideService(prisma as never);
    const entitlements = new EntitlementsService(prisma as never, catalog, overrides);
    const resolver = new FeatureResolverService(entitlements, overrides, catalog, prisma as never);
    authority = new EntitlementAuthority(
      entitlements,
      overrides,
      resolver,
      new EntitlementsModeService(prisma as never),
      new FeatureDiffService(prisma as never),
      prisma as never,
    );
    svc = new FeatureChangeService(prisma as never, overrides, authority);
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    if (createdVersionId) await dropPublishedCatalog(prisma, createdVersionId);
    await prisma.$disconnect();
    await pool.end();
  });

  afterEach(() => jest.restoreAllMocks());

  it("T32b: the hash moves when an override is added, and when it is revoked; a plain read does not move it", async () => {
    const t = await tenant();
    const h0 = await svc.inputsHash(t);
    expect(await svc.inputsHash(t)).toBe(h0);
    const row = await prisma.tenantFeatureOverride.create({
      data: { tenantId: t, featureKey: A, effect: "GRANT", reason: `${SPEC} fixture` } as never,
    });
    const h1 = await svc.inputsHash(t);
    expect(h1).not.toBe(h0);
    await prisma.tenantFeatureOverride.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
    const h2 = await svc.inputsHash(t);
    expect(h2).not.toBe(h1);
    expect(h2).toBe(h0); // the table is back to its first state
  });

  it("T27a + T53: three changes are one audit row that carries before, after, actor, ids and both hashes", async () => {
    const t = await tenant();
    const h0 = await svc.inputsHash(t);
    const out = await svc.apply(
      t,
      actor,
      dto(h0, [
        { key: A, action: "GRANT" },
        { key: B, action: "DENY", kind: "PILOT" },
      ]),
    );
    expect((await live(t)).map((r) => [r.featureKey, r.effect])).toEqual(
      [
        [B, "DENY"],
        [A, "GRANT"],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    const rows = await audits(t, AdminAuditAction.FEATURE_CHANGE_SET_APPLIED);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(out.changeSetId);
    expect(rows[0].userId).toBe(actor);
    expect(rows[0].entityId).toBe(t);
    const meta = rows[0].meta as unknown as FeatureChangeSetMeta & { platformAdmin: boolean };
    expect(meta.platformAdmin).toBe(true);
    expect(meta.actor).toBe(actor);
    expect(meta.reason).toBe(`${SPEC} fixture`);
    expect(meta.hashBefore).toBe(h0);
    expect(meta.hashAfter).toBe(await svc.inputsHash(t));
    expect(meta.changes).toHaveLength(2);
    const byKey = Object.fromEntries(meta.changes.map((c) => [c.key, c]));
    expect(byKey[A].before).toBeNull();
    expect(byKey[A].after).toMatchObject({ effect: "GRANT", kind: "COMP" });
    expect(byKey[A].createdIds).toHaveLength(1);
    expect(byKey[A].revokedIds).toEqual([]);
    expect(byKey[B].after).toMatchObject({ effect: "DENY", kind: "PILOT" });
  });

  it("T32a: a stale expected is refused 409 and writes nothing (no rows, no audit row)", async () => {
    const t = await tenant();
    const stale = await svc.inputsHash(t);
    await prisma.tenantFeatureOverride.create({
      data: {
        tenantId: t,
        featureKey: B,
        effect: "GRANT",
        reason: `${SPEC} someone else`,
      } as never,
    });
    const rowsBefore = await allRows(t);
    expect(await codeOf(svc.apply(t, actor, dto(stale, [{ key: A, action: "GRANT" }])))).toBe(
      "FEATURE_INPUTS_CHANGED",
    );
    expect(await allRows(t)).toBe(rowsBefore);
    expect(await audits(t)).toHaveLength(0);
  });

  it("T27b/c: a set with one bad change writes nothing, whatever the bad change is", async () => {
    const t = await tenant();
    const h = await svc.inputsHash(t);
    const bad: Array<[string, ApplyFeatureChangesDto["changes"]]> = [
      ["FEATURE_KEY_UNKNOWN", [{ key: "no_such_key", action: "GRANT" }]],
      ["FEATURE_NOT_OVERRIDABLE", [{ key: NOT_OVERRIDABLE, action: "GRANT" }]],
      [
        "EXPIRES_AT_MUST_BE_FUTURE",
        [{ key: B, action: "GRANT", expiresAt: "2020-01-01T00:00:00.000Z" }],
      ],
      ["FEATURE_REQUIRES_UNMET", [{ key: NEEDS, action: "GRANT" }]],
    ];
    for (const [code, tail] of bad) {
      // the good first change must NOT be applied when a later one is refused
      expect(
        await codeOf(svc.apply(t, actor, dto(h, [{ key: A, action: "GRANT" }, ...tail]))),
      ).toBe(code);
      expect(await allRows(t)).toBe(0);
      expect(await audits(t)).toHaveLength(0);
    }
    // a key twice in one save
    expect(
      await codeOf(
        svc.apply(
          t,
          actor,
          dto(h, [
            { key: A, action: "GRANT" },
            { key: A, action: "DENY" },
          ]),
        ),
      ),
    ).toMatch(/twice/);
    expect(await allRows(t)).toBe(0);
  });

  it("T27c: requires is counted across the set: a feature and the one it needs can be granted together", async () => {
    const t = await tenant();
    const h = await svc.inputsHash(t);
    await svc.apply(
      t,
      actor,
      dto(h, [
        { key: NEEDS, action: "GRANT" },
        { key: PREREQ, action: "GRANT" },
      ]),
    );
    expect((await live(t)).map((r) => r.featureKey).sort()).toEqual([NEEDS, PREREQ].sort());
  });

  it("T27d: more than 50 changes is refused whole", async () => {
    const t = await tenant();
    const h = await svc.inputsHash(t);
    const many = Array.from({ length: 51 }, (_, i) => ({ key: A, action: "GRANT" as const, i }));
    expect(await codeOf(svc.apply(t, actor, dto(h, many)))).toMatch(/at most 50/);
    expect(await allRows(t)).toBe(0);
  });

  it("an empty reason, or a set where every key is already set that way, writes nothing", async () => {
    const t = await tenant();
    const h = await svc.inputsHash(t);
    await svc.apply(t, actor, dto(h, [{ key: A, action: "GRANT" }]));
    const h2 = await svc.inputsHash(t);
    const rows = await allRows(t);
    expect(await codeOf(svc.apply(t, actor, dto(h2, [{ key: A, action: "GRANT" }])))).toMatch(
      /Nothing to change/,
    );
    expect(await codeOf(svc.apply(t, actor, dto(h2, [{ key: B, action: "CLEAR" }])))).toMatch(
      /Nothing to change/,
    );
    expect(await allRows(t)).toBe(rows);
    expect(await audits(t, AdminAuditAction.FEATURE_CHANGE_SET_APPLIED)).toHaveLength(1);
  });

  it("T27e: a write that throws mid-set leaves nothing behind: no rows, no audit row, the error comes back", async () => {
    const t = await tenant();
    const h = await svc.inputsHash(t);
    const realCreate = overrides.create.bind(overrides);
    let calls = 0;
    jest.spyOn(overrides, "create").mockImplementation((async (
      ...args: Parameters<typeof realCreate>
    ) => {
      if (++calls === 2) throw new Error("second write failed");
      return realCreate(...args);
    }) as never);
    await expect(
      svc.apply(
        t,
        actor,
        dto(h, [
          { key: A, action: "GRANT" },
          { key: B, action: "GRANT" },
        ]),
      ),
    ).rejects.toThrow("second write failed");
    expect(calls).toBe(2);
    expect(await allRows(t)).toBe(0); // the first create was rolled back with the transaction
    expect(await audits(t)).toHaveLength(0);
  });

  it("T27e': a failed audit write fails the whole set (the audit row is part of the transaction)", async () => {
    const t = await tenant();
    const h = await svc.inputsHash(t);
    jest.spyOn(svc, "writeAudit").mockRejectedValue(new Error("audit write failed"));
    await expect(svc.apply(t, actor, dto(h, [{ key: A, action: "GRANT" }]))).rejects.toThrow(
      "audit write failed",
    );
    expect(await allRows(t)).toBe(0);
  });

  it("T27f: two saves at the same hash: exactly one succeeds, the other gets 409, only the winner's rows exist", async () => {
    const t = await tenant();
    const h = await svc.inputsHash(t);
    const results = await Promise.allSettled([
      svc.apply(t, actor, dto(h, [{ key: A, action: "GRANT" }])),
      svc.apply(t, actor, dto(h, [{ key: B, action: "GRANT" }])),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(ConflictException);
    expect((lost[0].reason as ConflictException).getResponse()).toMatchObject({
      code: "FEATURE_INPUTS_CHANGED",
    });
    expect(await live(t)).toHaveLength(1);
    expect(await audits(t, AdminAuditAction.FEATURE_CHANGE_SET_APPLIED)).toHaveLength(1);
  });

  it("CLEAR revokes the live row, history is kept; a re-GRANT replaces a live DENY in one set", async () => {
    const t = await tenant();
    await svc.apply(t, actor, dto(await svc.inputsHash(t), [{ key: A, action: "DENY" }]));
    await svc.apply(t, actor, dto(await svc.inputsHash(t), [{ key: A, action: "GRANT" }]));
    const rows = await prisma.tenantFeatureOverride.findMany({
      where: { tenantId: t, featureKey: A },
    });
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.revokedAt === null).map((r) => r.effect)).toEqual(["GRANT"]);
    await svc.apply(t, actor, dto(await svc.inputsHash(t), [{ key: A, action: "CLEAR" }]));
    expect(await live(t)).toHaveLength(0);
    expect(
      await prisma.tenantFeatureOverride.count({ where: { tenantId: t, featureKey: A } }),
    ).toBe(2);
  });

  it("dryRun (preview) reports before/after and the hash, and writes nothing", async () => {
    const t = await tenant();
    const h = await svc.inputsHash(t);
    const out = await svc.preview(t, dto(h, [{ key: A, action: "GRANT" }], { dryRun: true }));
    expect(out.inputsHash).toBe(h);
    expect(out.stale).toBe(false);
    expect(out.changes[0]).toMatchObject({
      key: A,
      before: null,
      after: { effect: "GRANT" },
      unchanged: false,
    });
    expect(await allRows(t)).toBe(0);
    expect(await audits(t)).toHaveLength(0);
    expect((await svc.preview(t, dto("old-hash-value", [{ key: A, action: "GRANT" }]))).stale).toBe(
      true,
    );
  });

  it("T28a: undo puts the state back as it was before the save, and writes its own audit row with undoOf", async () => {
    const t = await tenant();
    // start with a live DENY on A with its own reason and end date
    const end = new Date(Date.now() + 90 * 86_400_000).toISOString();
    await svc.apply(
      t,
      actor,
      dto(await svc.inputsHash(t), [{ key: A, action: "DENY", expiresAt: end }]),
    );
    const before = await live(t);
    const set = await svc.apply(
      t,
      actor,
      dto(await svc.inputsHash(t), [
        { key: A, action: "GRANT" },
        { key: B, action: "GRANT" },
      ]),
    );
    expect((await live(t)).map((r) => r.featureKey).sort()).toEqual([A, B].sort());
    const undone = await svc.undo(t, actor, set.changeSetId, "mistake");
    const after = await live(t);
    expect(
      after.map((r) => [
        r.featureKey,
        r.effect,
        r.kind,
        r.reason,
        r.expiresAt?.toISOString() ?? null,
      ]),
    ).toEqual(
      before.map((r) => [
        r.featureKey,
        r.effect,
        r.kind,
        r.reason,
        r.expiresAt?.toISOString() ?? null,
      ]),
    );
    const rows = await audits(t, AdminAuditAction.FEATURE_CHANGE_SET_UNDONE);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(undone.changeSetId);
    expect((rows[0].meta as { undoOf?: string }).undoOf).toBe(set.changeSetId);
  });

  it("T28e: an earlier override that has ended since the save is skipped, the undo still goes through and says so", async () => {
    const t = await tenant();
    const soon = new Date(Date.now() + 1_500).toISOString();
    await svc.apply(
      t,
      actor,
      dto(await svc.inputsHash(t), [{ key: A, action: "DENY", expiresAt: soon }]),
    );
    const set = await svc.apply(
      t,
      actor,
      dto(await svc.inputsHash(t), [{ key: A, action: "GRANT" }]),
    );
    await new Promise((r) => setTimeout(r, 1_800));
    const undone = await svc.undo(t, actor, set.changeSetId, "mistake");
    expect(undone.skippedExpired.map((s) => s.key)).toEqual([A]);
    expect(await live(t)).toHaveLength(0);
    expect(await audits(t, AdminAuditAction.FEATURE_CHANGE_SET_UNDONE)).toHaveLength(1);
  });

  /** An end date a moment ahead, so the row really reaches it during the test (the table is never edited to fake it). */
  const soonEnd = () => new Date(Date.now() + 1_500);
  const waitPastEnd = () => new Promise((r) => setTimeout(r, 1_800));
  /** What the expiry job does once the end date has passed: it revokes the row and leaves its end date alone. */
  const jobRevoke = async (id: string) => {
    await prisma.tenantFeatureOverride.update({ where: { id }, data: { revokedAt: new Date() } });
  };

  it("U-1 (SA-1133): a row the save created that has since ended does not block the undo, and is not re-stamped", async () => {
    const t = await tenant();
    const set = await svc.apply(
      t,
      actor,
      dto(await svc.inputsHash(t), [
        { key: A, action: "GRANT", expiresAt: soonEnd().toISOString() },
      ]),
    );
    const createdId = set.changes[0].createdIds[0];
    await waitPastEnd();
    await jobRevoke(createdId);
    const stamp = (
      await prisma.tenantFeatureOverride.findUniqueOrThrow({ where: { id: createdId } })
    ).revokedAt;
    expect(await codeOf(svc.undo(t, actor, set.changeSetId, "late"))).toBe("ok");
    const after = await prisma.tenantFeatureOverride.findUniqueOrThrow({
      where: { id: createdId },
    });
    expect(after.revokedAt?.toISOString()).toBe(stamp?.toISOString());
  });

  it("U-2 (SA-1133): an unrelated override reaching its end date after the save does not block the undo", async () => {
    const t = await tenant();
    const other = await overrides.create({
      tenantId: t,
      featureKey: B,
      effect: "GRANT",
      kind: "COMP",
      reason: "fixture",
      expiresAt: soonEnd(),
      createdById: actor,
    } as never);
    const set = await svc.apply(
      t,
      actor,
      dto(await svc.inputsHash(t), [{ key: A, action: "GRANT" }]),
    );
    await waitPastEnd();
    await jobRevoke(other.id);
    expect(await codeOf(svc.undo(t, actor, set.changeSetId, "later"))).toBe("ok");
    expect((await live(t)).map((r) => r.featureKey)).toEqual([]);
  });

  it("U-3 (SA-1133): an ended earlier row is skipped, named in the response AND in the undo audit row", async () => {
    const t = await tenant();
    const end = soonEnd();
    const first = await svc.apply(
      t,
      actor,
      dto(await svc.inputsHash(t), [{ key: A, action: "DENY", expiresAt: end.toISOString() }]),
    );
    const oldId = first.changes[0].createdIds[0];
    const set = await svc.apply(
      t,
      actor,
      dto(await svc.inputsHash(t), [{ key: A, action: "GRANT" }]),
    );
    await waitPastEnd();
    const undone = await svc.undo(t, actor, set.changeSetId, "mistake");
    const want = [{ key: A, id: oldId, expiresAt: end.toISOString() }];
    expect(undone.skippedExpired).toEqual(want);
    const row = (await audits(t, AdminAuditAction.FEATURE_CHANGE_SET_UNDONE))[0];
    expect((row.meta as { skippedExpired?: unknown }).skippedExpired).toEqual(want);
    expect(await live(t)).toHaveLength(0);
  });

  it("U-4 (guard): real newer work after the save still refuses the undo", async () => {
    const t = await tenant();
    const set = await svc.apply(
      t,
      actor,
      dto(await svc.inputsHash(t), [{ key: A, action: "GRANT" }]),
    );
    await svc.apply(t, actor, dto(await svc.inputsHash(t), [{ key: B, action: "GRANT" }]));
    expect(await codeOf(svc.undo(t, actor, set.changeSetId, "newer work"))).toBe(
      "FEATURE_CHANGE_NOT_UNDOABLE",
    );
  });

  it("U-5 (guard): preview to save still uses inputsHash, which moves when a live row's end date passes", async () => {
    const t = await tenant();
    const row = await overrides.create({
      tenantId: t,
      featureKey: B,
      effect: "GRANT",
      kind: "COMP",
      reason: "fixture",
      expiresAt: soonEnd(),
      createdById: actor,
    } as never);
    const h1 = await svc.inputsHash(t);
    const p = await svc.preview(t, dto(h1, [{ key: A, action: "GRANT" }]));
    expect(p.inputsHash).toBe(h1);
    expect(p.stale).toBe(false);
    await waitPastEnd();
    await jobRevoke(row.id);
    expect(await svc.inputsHash(t)).not.toBe(h1);
    expect(await codeOf(svc.apply(t, actor, dto(h1, [{ key: A, action: "GRANT" }])))).toBe(
      "FEATURE_INPUTS_CHANGED",
    );
  });

  it("T28b: undo after a later change is refused and writes nothing", async () => {
    const t = await tenant();
    const set = await svc.apply(
      t,
      actor,
      dto(await svc.inputsHash(t), [{ key: A, action: "GRANT" }]),
    );
    await svc.apply(t, actor, dto(await svc.inputsHash(t), [{ key: B, action: "GRANT" }]));
    const rows = await allRows(t);
    const live0 = (await live(t)).map((r) => r.id);
    expect(await codeOf(svc.undo(t, actor, set.changeSetId, "late"))).toBe(
      "FEATURE_CHANGE_NOT_UNDOABLE",
    );
    expect(await allRows(t)).toBe(rows);
    expect((await live(t)).map((r) => r.id)).toEqual(live0);
    expect(await audits(t, AdminAuditAction.FEATURE_CHANGE_SET_UNDONE)).toHaveLength(0);
  });

  it("T28c: a set is undone once", async () => {
    const t = await tenant();
    const set = await svc.apply(
      t,
      actor,
      dto(await svc.inputsHash(t), [{ key: A, action: "GRANT" }]),
    );
    await svc.undo(t, actor, set.changeSetId, "first");
    expect(await codeOf(svc.undo(t, actor, set.changeSetId, "second"))).toBe(
      "FEATURE_CHANGE_NOT_UNDOABLE",
    );
    expect(await audits(t, AdminAuditAction.FEATURE_CHANGE_SET_UNDONE)).toHaveLength(1);
  });

  it("T28d: another business's set cannot be undone under this business's id", async () => {
    const mine = await tenant();
    const theirs = await tenant();
    const set = await svc.apply(
      theirs,
      actor,
      dto(await svc.inputsHash(theirs), [{ key: A, action: "GRANT" }]),
    );
    await expect(svc.undo(mine, actor, set.changeSetId, "wrong business")).rejects.toThrow(
      /No saved change set/,
    );
    expect(await live(theirs)).toHaveLength(1);
    expect(await allRows(mine)).toBe(0);
  });

  it("T-cache: a rolled-back set invalidates nothing and the cached view still equals the database", async () => {
    const t = await tenant();
    await overrides.allActive(t); // prime the cache: empty
    const invalidateOverrides = jest.spyOn(overrides, "invalidate");
    const invalidateAuthority = jest.spyOn(authority, "invalidate");
    const realCreate = overrides.create.bind(overrides);
    let calls = 0;
    jest.spyOn(overrides, "create").mockImplementation((async (
      ...args: Parameters<typeof realCreate>
    ) => {
      if (++calls === 2) throw new Error("boom");
      return realCreate(...args);
    }) as never);
    await expect(
      svc.apply(
        t,
        actor,
        dto(await svc.inputsHash(t), [
          { key: A, action: "GRANT" },
          { key: B, action: "GRANT" },
        ]),
      ),
    ).rejects.toThrow("boom");
    expect(invalidateOverrides).not.toHaveBeenCalled();
    expect(invalidateAuthority).not.toHaveBeenCalled();
    const cached = await overrides.allActive(t);
    const fromDb = await live(t);
    expect([...cached.keys()].sort()).toEqual(fromDb.map((r) => r.featureKey).sort());
    expect(cached.size).toBe(0);
  });

  it("T-cache: a committed set invalidates once, after the commit, and the next read shows the new rows", async () => {
    const t = await tenant();
    await overrides.allActive(t); // prime: empty
    const seenInTx: number[] = [];
    const invalidate = jest.spyOn(overrides, "invalidate").mockImplementation(() => {
      // by the time it is called the rows are committed and visible outside the transaction
      seenInTx.push(1);
    });
    await svc.apply(t, actor, dto(await svc.inputsHash(t), [{ key: A, action: "GRANT" }]));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(await live(t)).toHaveLength(1);
    invalidate.mockRestore();
    overrides.invalidate(t);
    expect((await overrides.allActive(t)).get(A)).toBe("GRANT");
  });
});
