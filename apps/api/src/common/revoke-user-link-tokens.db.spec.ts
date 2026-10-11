/**
 * DB-lane proof for the account link-revocation helper (real Postgres, throwaway `qa-*` tenant).
 *
 * Run through the DB lane (`npm run local:test:db`; collected only by `jest.db.config.js`).
 * `requireLocalDatabaseUrl()` refuses any non-local host; the tenant is a `qa-*` slug approved by
 * `assertTestTenant`. The unit pins (`revoke-user-link-tokens.spec.ts`) cover the statement shape;
 * this file proves the ROW behaviour and that the helper works under BOTH transaction kinds the
 * writers use (a plain `$transaction` and the tenant-scoping `tenantTransaction` proxy).
 */
import { randomUUID } from "crypto";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import {
  revokeBuyerLinkTokens,
  revokeUserLinkTokens,
  revokeUserLinkTokensMany,
} from "./revoke-user-link-tokens";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
const HOUR = 60 * 60 * 1000;

describeDb("revokeUserLinkTokens / revokeBuyerLinkTokens — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let tenantId: string;
  const buyerIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const slug = assertTestTenant(`qa-linkrev-${RUN_SUFFIX}`, "revoke-user-link-tokens.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `linkrev ${slug}` } })).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.buyerAccount
      .deleteMany({ where: { id: { in: buyerIds } } })
      .catch(() => undefined);
    await prisma.user.deleteMany({ where: { tenantId } }).catch(() => undefined);
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  const seedUser = (name: string) =>
    prisma.user.create({
      data: {
        tenantId,
        role: UserRole.OPERATOR,
        username: `${name}-${RUN_SUFFIX}`,
        email: `${name}-${RUN_SUFFIX}@example.test`,
      },
    });

  const seedBuyer = async (name: string) => {
    const buyer = await prisma.buyerAccount.create({
      data: {
        email: `${name}-${RUN_SUFFIX}@example.test`,
        passwordHash: "x",
        name,
      },
    });
    buyerIds.push(buyer.id);
    return buyer;
  };

  const token = <T extends object>(over: T) => ({
    tokenHash: randomUUID() + randomUUID(),
    expiresAt: new Date(Date.now() + HOUR),
    ...over,
  });

  it("burns the account's unused unexpired links and nothing else (staff)", async () => {
    const a = await seedUser("rev-a");
    const b = await seedUser("rev-b");
    const live = await prisma.passwordResetToken.create({ data: token({ userId: a.id }) });
    const used = await prisma.passwordResetToken.create({
      data: token({ userId: a.id, usedAt: new Date(Date.now() - HOUR) }),
    });
    const expired = await prisma.passwordResetToken.create({
      data: token({ userId: a.id, expiresAt: new Date(Date.now() - HOUR) }),
    });
    const other = await prisma.passwordResetToken.create({ data: token({ userId: b.id }) });

    const burned = await prisma.$transaction((tx) => revokeUserLinkTokens(tx, a.id));

    expect(burned).toBe(1);
    const after = async (id: string) =>
      (await prisma.passwordResetToken.findUniqueOrThrow({ where: { id } })).usedAt;
    expect(await after(live.id)).not.toBeNull();
    expect(await after(used.id)).toEqual(used.usedAt); // not re-stamped
    expect(await after(expired.id)).toBeNull(); // already dead; left as it was
    expect(await after(other.id)).toBeNull(); // another account's link is untouched
    // idempotent
    expect(await prisma.$transaction((tx) => revokeUserLinkTokens(tx, a.id))).toBe(0);
  });

  it("burns the account's unused unexpired email-verification links and nothing else", async () => {
    const a = await seedUser("rev-verify-a");
    const b = await seedUser("rev-verify-b");
    const live = await prisma.userEmailVerificationToken.create({ data: token({ userId: a.id }) });
    const used = await prisma.userEmailVerificationToken.create({
      data: token({ userId: a.id, usedAt: new Date(Date.now() - HOUR) }),
    });
    const expired = await prisma.userEmailVerificationToken.create({
      data: token({ userId: a.id, expiresAt: new Date(Date.now() - HOUR) }),
    });
    const other = await prisma.userEmailVerificationToken.create({ data: token({ userId: b.id }) });
    const manyLive = await prisma.userEmailVerificationToken.create({
      data: token({ userId: b.id }),
    });

    expect(await prisma.$transaction((tx) => revokeUserLinkTokens(tx, a.id))).toBe(1);

    const after = async (id: string) =>
      (await prisma.userEmailVerificationToken.findUniqueOrThrow({ where: { id } })).usedAt;
    expect(await after(live.id)).not.toBeNull();
    expect(await after(used.id)).toEqual(used.usedAt); // not re-stamped
    expect(await after(expired.id)).toBeNull(); // already dead; left as it was
    expect(await after(other.id)).toBeNull(); // another account's link is untouched

    // the many-user variant covers the same table
    expect(await prisma.$transaction((tx) => revokeUserLinkTokensMany(tx, [b.id]))).toBe(2);
    expect(await after(other.id)).not.toBeNull();
    expect(await after(manyLive.id)).not.toBeNull();
  });

  it("the many-user variant burns only the listed users' live links (both tables)", async () => {
    const a = await seedUser("many-a");
    const b = await seedUser("many-b");
    const c = await seedUser("many-c");
    const liveA = await prisma.passwordResetToken.create({ data: token({ userId: a.id }) });
    const liveB = await prisma.passwordResetToken.create({ data: token({ userId: b.id }) });
    const liveC = await prisma.passwordResetToken.create({ data: token({ userId: c.id }) });
    const usedA = await prisma.passwordResetToken.create({
      data: token({ userId: a.id, usedAt: new Date(Date.now() - HOUR) }),
    });
    const expiredB = await prisma.passwordResetToken.create({
      data: token({ userId: b.id, expiresAt: new Date(Date.now() - HOUR) }),
    });
    const verifyA = await prisma.userEmailVerificationToken.create({
      data: token({ userId: a.id }),
    });
    const verifyC = await prisma.userEmailVerificationToken.create({
      data: token({ userId: c.id }),
    });

    const burned = await prisma.$transaction((tx) => revokeUserLinkTokensMany(tx, [a.id, b.id]));

    expect(burned).toBe(3);
    const reset = async (id: string) =>
      (await prisma.passwordResetToken.findUniqueOrThrow({ where: { id } })).usedAt;
    const verify = async (id: string) =>
      (await prisma.userEmailVerificationToken.findUniqueOrThrow({ where: { id } })).usedAt;
    expect(await reset(liveA.id)).not.toBeNull();
    expect(await reset(liveB.id)).not.toBeNull();
    expect(await verify(verifyA.id)).not.toBeNull();
    expect(await reset(usedA.id)).toEqual(usedA.usedAt); // not re-stamped
    expect(await reset(expiredB.id)).toBeNull(); // already dead; left as it was
    expect(await reset(liveC.id)).toBeNull(); // an unlisted user's links are untouched
    expect(await verify(verifyC.id)).toBeNull();
    // idempotent, and an empty list is a no-op
    expect(await prisma.$transaction((tx) => revokeUserLinkTokensMany(tx, [a.id, b.id]))).toBe(0);
    expect(await prisma.$transaction((tx) => revokeUserLinkTokensMany(tx, []))).toBe(0);
  });

  it("works inside the tenant transaction proxy, and rolls back with the caller", async () => {
    const u = await seedUser("rev-proxy");
    const live = await prisma.passwordResetToken.create({ data: token({ userId: u.id }) });

    await expect(
      tenantCtx.run(tenantId, () =>
        prisma.tenantTransaction(async (tx) => {
          expect(await revokeUserLinkTokens(tx, u.id)).toBe(1);
          throw new Error("force rollback");
        }),
      ),
    ).rejects.toThrow("force rollback");
    expect(
      (await prisma.passwordResetToken.findUniqueOrThrow({ where: { id: live.id } })).usedAt,
    ).toBeNull();

    await tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction((tx) => revokeUserLinkTokens(tx, u.id)),
    );
    expect(
      (await prisma.passwordResetToken.findUniqueOrThrow({ where: { id: live.id } })).usedAt,
    ).not.toBeNull();
  });

  it("burns both buyer twins for one buyer and leaves another buyer's links alone", async () => {
    const a = await seedBuyer("rev-buyer-a");
    const b = await seedBuyer("rev-buyer-b");
    const reset = await prisma.buyerPasswordResetToken.create({
      data: token({ buyerAccountId: a.id }),
    });
    const verify = await prisma.buyerEmailVerificationToken.create({
      data: token({ buyerAccountId: a.id }),
    });
    const otherReset = await prisma.buyerPasswordResetToken.create({
      data: token({ buyerAccountId: b.id }),
    });
    const otherVerify = await prisma.buyerEmailVerificationToken.create({
      data: token({ buyerAccountId: b.id }),
    });

    const burned = await prisma.$transaction((tx) => revokeBuyerLinkTokens(tx, a.id));

    expect(burned).toBe(2);
    const usedAt = async (kind: "reset" | "verify", id: string) =>
      (kind === "reset"
        ? await prisma.buyerPasswordResetToken.findUniqueOrThrow({ where: { id } })
        : await prisma.buyerEmailVerificationToken.findUniqueOrThrow({ where: { id } })
      ).usedAt;
    expect(await usedAt("reset", reset.id)).not.toBeNull();
    expect(await usedAt("verify", verify.id)).not.toBeNull();
    expect(await usedAt("reset", otherReset.id)).toBeNull();
    expect(await usedAt("verify", otherVerify.id)).toBeNull();
  });
});
