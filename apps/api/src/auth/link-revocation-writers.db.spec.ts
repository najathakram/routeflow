/**
 * F03 slice 2 (SA-1096), real Postgres: the account writers that burn live one-time links run through the REAL
 * `PrismaService.tenantTransaction` proxy, never a mock and never a plain `$transaction`.
 *
 * Why this file exists: the first cut of `revokeUserLinkTokens` passed every unit spec and its own DB spec, then
 * threw `Unknown argument tenantId` in production wiring, because the tenant proxy adds `tenantId` to every
 * `updateMany` and the token tables have no such column. Staff deactivation, the admin flag and a customer's
 * removal all rolled back. A writer is only proved when a row drives it on the real service.
 *
 * Run via `npm run local:test:db`. Throwaway `qa-linkwriters-<run>` tenant (approved by `assertTestTenant`);
 * afterAll deletes exactly what it made.
 */
import { createHash, randomUUID } from "crypto";
import { UserRole, UserStatus } from "@prisma/client";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { UsersService } from "../users/users.service";
import { BuyerAdminService } from "../buyer/buyer-admin.service";
import { BuyerMergeService } from "../buyer/buyer-merge.service";
import { CustomersService } from "../customers/customers.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "link-revocation-writers.db.spec.ts";
const RUN = randomUUID().slice(0, 8);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

describeDb("account writers burn live links through the real tenant transaction proxy", () => {
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let users: UsersService;
  let buyerAdmin: BuyerAdminService;
  let buyerMerge: BuyerMergeService;
  let customers: CustomersService;
  let otherTenantId: string;
  let tenantId: string;
  let seq = 0;
  let emailCalls: Record<string, number> = {};
  const sent = (name: string) => emailCalls[name] ?? 0;
  beforeEach(() => {
    emailCalls = {};
  });

  const mkUser = (name: string, role: UserRole = UserRole.OPERATOR) =>
    prisma.user.create({
      data: {
        tenantId,
        username: `${name}-${RUN}-${++seq}`,
        email: `${name}-${RUN}-${seq}@example.invalid`,
        role,
        status: UserStatus.ACTIVE,
      },
    });

  /** One live reset link and one live verification link for the user. */
  const mintLinks = async (userId: string, salt = "") => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    await prisma.passwordResetToken.create({
      data: { userId, tokenHash: hash(`reset-${userId}${salt}`), expiresAt },
    });
    await prisma.userEmailVerificationToken.create({
      data: { userId, tokenHash: hash(`verify-${userId}${salt}`), expiresAt },
    });
  };
  const liveLinks = async (userId: string) =>
    (await prisma.passwordResetToken.count({ where: { userId, usedAt: null } })) +
    (await prisma.userEmailVerificationToken.count({ where: { userId, usedAt: null } }));

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    emailCalls = {};
    const email = new Proxy(
      {},
      {
        get: (_t, name: string) => async () => {
          emailCalls[name] = (emailCalls[name] ?? 0) + 1;
          return { delivered: true, transport: "test" };
        },
      },
    );
    users = new UsersService(
      prisma,
      email as never,
      {
        get: () => ({ web: "http://localhost:3001" }),
      } as never,
    );
    buyerAdmin = new BuyerAdminService(prisma, {} as never, { get: () => ({}) } as never);
    buyerMerge = new BuyerMergeService(prisma, email as never, {} as never);
    // changeStatus reads the customer and writes the login user; none of the other collaborators is touched.
    customers = new CustomersService(
      prisma,
      ...(Array(8).fill({}) as [never, never, never, never, never, never, never, never]),
    );
    const slug = assertTestTenant(`qa-linkwriters-${RUN}`, SPEC);
    tenantId = (await prisma.tenant.create({ data: { slug, name: `Link writers ${slug}` } })).id;
    const otherSlug = assertTestTenant(`qa-linkwriters-${RUN}-b`, SPEC);
    otherTenantId = (
      await prisma.tenant.create({ data: { slug: otherSlug, name: `Link writers ${otherSlug}` } })
    ).id;
  }, 120_000);

  afterAll(async () => {
    for (const id of [tenantId, otherTenantId]) {
      if (!id) continue;
      await prisma.customer.deleteMany({ where: { tenantId: id } });
      await prisma.user.deleteMany({ where: { tenantId: id } }); // tokens cascade
      await prisma.tenant.deleteMany({ where: { id } });
    }
    await prisma?.$disconnect();
  }, 120_000);

  it("S1: deactivating an operator commits the status and burns both live links", async () => {
    const op = await mkUser("op");
    await mintLinks(op.id);
    await ctx.run(tenantId, () =>
      users.changeStatus(op.id, { status: UserStatus.INACTIVE }, UserRole.TENANT_ADMIN),
    );
    expect((await prisma.user.findUniqueOrThrow({ where: { id: op.id } })).status).toBe(
      UserStatus.INACTIVE,
    );
    expect(await liveLinks(op.id)).toBe(0);
  });

  it("S2: deactivating an admin (the locked path) commits and burns both live links", async () => {
    const keeper = await mkUser("keeper", UserRole.TENANT_ADMIN);
    const admin = await mkUser("admin", UserRole.TENANT_ADMIN);
    await mintLinks(admin.id);
    await ctx.run(tenantId, () =>
      users.changeStatus(
        admin.id,
        { status: UserStatus.INACTIVE },
        UserRole.TENANT_ADMIN,
        keeper.id,
      ),
    );
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).status).toBe(
      UserStatus.INACTIVE,
    );
    expect(await liveLinks(admin.id)).toBe(0);
  });

  it("S3: ticking the admin flag commits and burns both live links", async () => {
    const op = await mkUser("flag");
    await mintLinks(op.id);
    await ctx.run(tenantId, () => users.toggleAdmin(op.id, true));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: op.id } })).isAdmin).toBe(true);
    expect(await liveLinks(op.id)).toBe(0);
  });

  it("S4: reactivating burns nothing (only a deactivation does)", async () => {
    const op = await mkUser("react");
    await prisma.user.update({ where: { id: op.id }, data: { status: UserStatus.INACTIVE } });
    await mintLinks(op.id);
    await ctx.run(tenantId, () =>
      users.changeStatus(op.id, { status: UserStatus.ACTIVE }, UserRole.TENANT_ADMIN),
    );
    expect(await liveLinks(op.id)).toBe(2);
  });

  it("S5: deactivate then reactivate, link not clicked in between, leaves the old link dead", async () => {
    const op = await mkUser("susp");
    await mintLinks(op.id);
    await ctx.run(tenantId, async () => {
      await users.changeStatus(op.id, { status: UserStatus.INACTIVE }, UserRole.TENANT_ADMIN);
      await users.changeStatus(op.id, { status: UserStatus.ACTIVE }, UserRole.TENANT_ADMIN);
    });
    expect(await liveLinks(op.id)).toBe(0);
  });

  it("S6: a role change commits the role, burns the old links and sends a fresh invite to a never-signed-in user", async () => {
    const op = await mkUser("role");
    await prisma.user.update({ where: { id: op.id }, data: { forcePasswordChange: true } });
    await mintLinks(op.id);
    await ctx.run(tenantId, () =>
      users.updateUser(op.id, { role: UserRole.DRIVER } as never, "admin", UserRole.TENANT_ADMIN),
    );
    expect((await prisma.user.findUniqueOrThrow({ where: { id: op.id } })).role).toBe(
      UserRole.DRIVER,
    );
    // the two minted links are dead; exactly one NEW reset link (the invite) is live
    expect(
      await prisma.userEmailVerificationToken.count({ where: { userId: op.id, usedAt: null } }),
    ).toBe(0);
    expect(await prisma.passwordResetToken.count({ where: { userId: op.id, usedAt: null } })).toBe(
      1,
    );
    expect(sent("sendSetPasswordEmail")).toBe(1);
  });

  it("S7: a role change on a user who has signed in burns the links and mints no invite", async () => {
    const op = await mkUser("rolesigned");
    await mintLinks(op.id);
    await ctx.run(tenantId, () =>
      users.updateUser(op.id, { role: UserRole.DRIVER } as never, "admin", UserRole.TENANT_ADMIN),
    );
    expect(await liveLinks(op.id)).toBe(0);
    expect(sent("sendSetPasswordEmail")).toBe(0);
  });

  it("S8: an email correction commits and burns the old links, with one fresh invite for a never-signed-in user", async () => {
    const op = await mkUser("mail");
    await prisma.user.update({ where: { id: op.id }, data: { forcePasswordChange: true } });
    await mintLinks(op.id);
    await ctx.run(tenantId, () =>
      users.updateUser(
        op.id,
        { email: `fixed-${RUN}-${++seq}@example.invalid` } as never,
        "admin",
        UserRole.TENANT_ADMIN,
      ),
    );
    expect(
      await prisma.userEmailVerificationToken.count({ where: { userId: op.id, usedAt: null } }),
    ).toBe(0);
    expect(await prisma.passwordResetToken.count({ where: { userId: op.id, usedAt: null } })).toBe(
      1,
    );
    expect(sent("sendSetPasswordEmail")).toBe(1);
  });

  it("S9: ticking the admin flag on a never-signed-in user re-mints the invite", async () => {
    const op = await mkUser("flagnew");
    await prisma.user.update({ where: { id: op.id }, data: { forcePasswordChange: true } });
    await mintLinks(op.id);
    await ctx.run(tenantId, () => users.toggleAdmin(op.id, true));
    expect(await prisma.passwordResetToken.count({ where: { userId: op.id, usedAt: null } })).toBe(
      1,
    );
    expect(sent("sendSetPasswordEmail")).toBe(1);
  });

  it("S10: the burn reaches only the account it names, in this tenant and in another", async () => {
    const target = await mkUser("target");
    const sameTenant = await mkUser("bystander");
    const otherTenant = await prisma.user.create({
      data: {
        tenantId: otherTenantId,
        username: `other-${RUN}-${++seq}`,
        email: `other-${RUN}-${seq}@example.invalid`,
        role: UserRole.OPERATOR,
        status: UserStatus.ACTIVE,
      },
    });
    for (const u of [target, sameTenant, otherTenant]) await mintLinks(u.id);
    await ctx.run(tenantId, () =>
      users.changeStatus(target.id, { status: UserStatus.INACTIVE }, UserRole.TENANT_ADMIN),
    );
    expect(await liveLinks(target.id)).toBe(0);
    // each bystander keeps BOTH its reset link and its verification link
    expect(await liveLinks(sameTenant.id)).toBe(2);
    expect(await liveLinks(otherTenant.id)).toBe(2);
  });

  it("S11: an email correction together with a role change sends ONE invite, not two", async () => {
    const op = await mkUser("both");
    await prisma.user.update({ where: { id: op.id }, data: { forcePasswordChange: true } });
    await mintLinks(op.id);
    await ctx.run(tenantId, () =>
      users.updateUser(
        op.id,
        { email: `both-${RUN}-${++seq}@example.invalid`, role: UserRole.DRIVER } as never,
        "admin",
        UserRole.TENANT_ADMIN,
      ),
    );
    expect(await prisma.passwordResetToken.count({ where: { userId: op.id, usedAt: null } })).toBe(
      1,
    );
    expect(sent("sendSetPasswordEmail")).toBe(1);
  });

  // SA-1096: every issuer mints only for an ACTIVE, undeleted account. A link minted while the account is off would
  // survive to its reactivation, handing a locked-out person a way back in (the admin reset's own N2 rule).
  describe.each([
    ["an INACTIVE account", { status: UserStatus.INACTIVE }],
    ["a SUSPENDED account", { status: UserStatus.SUSPENDED }],
    [
      "a soft-deleted account still marked ACTIVE",
      { status: UserStatus.ACTIVE, deletedAt: new Date() },
    ],
  ])("S13: no invite is minted or mailed for %s", (_label, off) => {
    const setUp = async (name: string) => {
      const op = await mkUser(name);
      await prisma.user.update({
        where: { id: op.id },
        data: { forcePasswordChange: true, ...off },
      });
      await mintLinks(op.id);
      return op;
    };
    /** The call may be refused outright (a deleted row is not found); either way nothing may be minted or mailed. */
    const settle = (run: () => Promise<unknown>) => run().catch(() => undefined);

    it("the admin flag", async () => {
      const op = await setUp("offflag");
      await settle(() => ctx.run(tenantId, () => users.toggleAdmin(op.id, true)));
      expect(await liveLinks(op.id)).toBe(0);
      expect(sent("sendSetPasswordEmail")).toBe(0);
    });
    it("a role change", async () => {
      const op = await setUp("offrole");
      await settle(() =>
        ctx.run(tenantId, () =>
          users.updateUser(
            op.id,
            { role: UserRole.DRIVER } as never,
            "admin",
            UserRole.TENANT_ADMIN,
          ),
        ),
      );
      expect(await liveLinks(op.id)).toBe(0);
      expect(sent("sendSetPasswordEmail")).toBe(0);
    });
    it("an email correction", async () => {
      const op = await setUp("offmail");
      await settle(() =>
        ctx.run(tenantId, () =>
          users.updateUser(
            op.id,
            { email: `off-${RUN}-${++seq}@example.invalid` } as never,
            "admin",
            UserRole.TENANT_ADMIN,
          ),
        ),
      );
      expect(await liveLinks(op.id)).toBe(0);
      expect(sent("sendSetPasswordEmail")).toBe(0);
    });
  });

  describe("customers, through the real CustomersService", () => {
    const mkCustomer = async (name: string) => {
      const user = await prisma.user.create({
        data: {
          tenantId,
          username: `${name}-${RUN}-${++seq}`,
          email: `${name}-${RUN}-${seq}@example.invalid`,
          role: UserRole.CUSTOMER,
          status: UserStatus.ACTIVE,
        },
      });
      const customer = await prisma.customer.create({
        data: { tenantId, userId: user.id, businessName: `Cust ${name}`, contactName: name },
      });
      return { user, customer };
    };

    it("C1: suspending a customer burns its live links, and reactivating burns nothing", async () => {
      const { user, customer } = await mkCustomer("cstat");
      await mintLinks(user.id);
      await ctx.run(tenantId, () =>
        customers.changeStatus(customer.id, { status: UserStatus.INACTIVE }),
      );
      expect(await liveLinks(user.id)).toBe(0);
      // a link minted while suspended (an admin re-invite) survives the reactivation
      await mintLinks(user.id, "-again");
      await ctx.run(tenantId, () =>
        customers.changeStatus(customer.id, { status: UserStatus.ACTIVE }),
      );
      expect(await liveLinks(user.id)).toBe(2);
    });
  });

  describe("buyers, through the real BuyerAdminService", () => {
    const mkBuyer = (name: string) =>
      prisma.buyerAccount.create({
        data: {
          email: `${name}-${RUN}-${++seq}@example.invalid`,
          passwordHash: "x",
          name: `Buyer ${name}`,
          status: "ACTIVE",
          emailVerified: true,
        },
      });
    const mintBuyerLinks = async (buyerAccountId: string) => {
      const expiresAt = new Date(Date.now() + 3_600_000);
      await prisma.buyerPasswordResetToken.create({
        data: { buyerAccountId, tokenHash: hash(`breset-${buyerAccountId}`), expiresAt },
      });
      await prisma.buyerEmailVerificationToken.create({
        data: { buyerAccountId, tokenHash: hash(`bverify-${buyerAccountId}`), expiresAt },
      });
    };
    const liveBuyerReset = (buyerAccountId: string) =>
      prisma.buyerPasswordResetToken.count({ where: { buyerAccountId, usedAt: null } });
    const liveBuyerVerify = (buyerAccountId: string) =>
      prisma.buyerEmailVerificationToken.count({ where: { buyerAccountId, usedAt: null } });
    const buyerIds: string[] = [];
    afterAll(async () => {
      await prisma.buyerMergeRequest.deleteMany({
        where: {
          OR: [{ primaryAccountId: { in: buyerIds } }, { secondaryAccountId: { in: buyerIds } }],
        },
      });
      await prisma.buyerAccount.deleteMany({ where: { id: { in: buyerIds } } }); // tokens cascade
    });

    it("B1: suspend then reactivate leaves the old reset link dead", async () => {
      const b = await mkBuyer("b1");
      buyerIds.push(b.id);
      await mintBuyerLinks(b.id);
      await buyerAdmin.setBuyerStatus(b.id, "SUSPENDED");
      await buyerAdmin.setBuyerStatus(b.id, "ACTIVE");
      expect(await liveBuyerReset(b.id)).toBe(0);
    });

    it("B1b: remove then reactivate leaves the old reset link dead", async () => {
      const b = await mkBuyer("b1b");
      buyerIds.push(b.id);
      await mintBuyerLinks(b.id);
      await buyerAdmin.setBuyerStatus(b.id, "DELETED");
      await buyerAdmin.setBuyerStatus(b.id, "ACTIVE");
      expect(await liveBuyerReset(b.id)).toBe(0);
    });

    it("B2: suspend then reactivate leaves the old verification link dead", async () => {
      const b = await mkBuyer("b2");
      buyerIds.push(b.id);
      await mintBuyerLinks(b.id);
      await buyerAdmin.setBuyerStatus(b.id, "SUSPENDED");
      await buyerAdmin.setBuyerStatus(b.id, "ACTIVE");
      expect(await liveBuyerVerify(b.id)).toBe(0);
    });

    it("B3: an email change kills a reset link mailed to the old address", async () => {
      const b = await mkBuyer("b3");
      buyerIds.push(b.id);
      await mintBuyerLinks(b.id);
      await buyerAdmin.updateBuyer(b.id, { email: `new-${RUN}-${++seq}@example.invalid` });
      expect(await liveBuyerReset(b.id)).toBe(0);
    });

    it("B4: a name-only save burns nothing", async () => {
      const b = await mkBuyer("b4");
      buyerIds.push(b.id);
      await mintBuyerLinks(b.id);
      await buyerAdmin.updateBuyer(b.id, { name: "Same Buyer" });
      expect(await liveBuyerReset(b.id)).toBe(1);
    });

    it("B6: the burn reaches only the account it names (the other buyer keeps both links)", async () => {
      const target = await mkBuyer("b6t");
      const bystander = await mkBuyer("b6o");
      buyerIds.push(target.id, bystander.id);
      await mintBuyerLinks(target.id);
      await mintBuyerLinks(bystander.id);
      await buyerAdmin.setBuyerStatus(target.id, "SUSPENDED");
      expect(await liveBuyerReset(target.id)).toBe(0);
      expect(await liveBuyerVerify(target.id)).toBe(0);
      expect(await liveBuyerReset(bystander.id)).toBe(1);
      expect(await liveBuyerVerify(bystander.id)).toBe(1);
    });

    it("B7: a merge kills the removed account's links and leaves the kept account's alive", async () => {
      const primary = await mkBuyer("b7p");
      const secondary = await mkBuyer("b7s");
      buyerIds.push(primary.id, secondary.id);
      await mintBuyerLinks(primary.id);
      await mintBuyerLinks(secondary.id);
      const request = await prisma.buyerMergeRequest.create({
        data: {
          primaryAccountId: primary.id,
          secondaryAccountId: secondary.id,
          status: "PENDING_REVIEW",
          initiatedBy: "SUPER_ADMIN",
        },
      });
      await buyerMerge.executeMerge(request.id);
      expect(
        (await prisma.buyerAccount.findUniqueOrThrow({ where: { id: secondary.id } })).status,
      ).toBe("DELETED");
      expect(await liveBuyerReset(secondary.id)).toBe(0);
      expect(await liveBuyerVerify(secondary.id)).toBe(0);
      expect(await liveBuyerReset(primary.id)).toBe(1);
      expect(await liveBuyerVerify(primary.id)).toBe(1);
    });

    it("B5: reactivation alone burns nothing new (a link minted after the burn survives)", async () => {
      const b = await mkBuyer("b5");
      buyerIds.push(b.id);
      await prisma.buyerAccount.update({ where: { id: b.id }, data: { status: "SUSPENDED" } });
      await mintBuyerLinks(b.id);
      await buyerAdmin.setBuyerStatus(b.id, "ACTIVE");
      expect(await liveBuyerReset(b.id)).toBe(1);
    });
  });
});
