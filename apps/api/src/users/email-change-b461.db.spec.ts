/**
 * B461 (SA-1116), real Postgres: a signed-in user's login email is not written until the NEW address confirms.
 *
 * Why a DB spec: the pending address is a `UserEmailChange` row written with raw SQL inside the REAL tenant
 * transaction (the proxy would add `tenantId` to a typed write and the table has none, SA-1096), the confirm is a
 * compare-and-set plus a unique index race, and R-8 reads B448's real `signupLinkState`. Mocks prove none of that.
 *
 * Rows: R-1 self edit holds, R-2 admin edit holds, R-3 never-signed-in invitee is written at once (guard),
 * R-4 a confirm writes the email, R-5 a dead link (newer request, password reset, deactivation, expiry),
 * R-6 the email moved since the request (CAS), R-7 the address was taken meanwhile, R-8 B448 stays closed.
 *
 * Run via `npm run test:db`. Throwaway `qa-b461-<run>-<tag>` tenants (approved by `assertTestTenant`); afterAll
 * deletes exactly what it made.
 */
import { createHash, randomUUID } from "crypto";
import { JwtService } from "@nestjs/jwt";
import { UserRole, UserStatus } from "@prisma/client";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { UsersService } from "./users.service";
import { TenantsService } from "../tenants/tenants.service";
import { AuthService } from "../auth/auth.service";
import * as bcrypt from "bcrypt";
import { signupLinkState } from "../auth/verification-link-eligibility";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "email-change-b461.db.spec.ts";
const RUN = randomUUID().slice(0, 8);
const SECRET = "qa-b461-secret-0123456789-abcdefghijklmnop";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

interface Mail {
  kind: string;
  to: string;
  [k: string]: unknown;
}

describeDb("B461: a login-email change waits for the new address (real database)", () => {
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let users: UsersService;
  let tenants: TenantsService;
  let auth: AuthService;
  const tenantIds: string[] = [];
  let mails: Mail[] = [];
  let seq = 0;
  let failInvite = false;

  const mkTenant = async (tag: string) => {
    const slug = assertTestTenant(`qa-b461-${RUN}-${tag}`, SPEC);
    const id = (await prisma.tenant.create({ data: { slug, name: slug } })).id;
    tenantIds.push(id);
    return id;
  };
  const mkUser = (
    tenantId: string,
    name: string,
    opts: {
      role?: UserRole;
      status?: UserStatus;
      signedIn?: boolean;
      forcePasswordChange?: boolean;
      /** a fixed date, never the clock */
      createdAt?: Date;
      password?: string;
    } = {},
  ) =>
    prisma.user.create({
      data: {
        tenantId,
        username: `${name}_${RUN}_${++seq}`,
        email: `${name}-${RUN}-${seq}@example.invalid`,
        role: opts.role ?? UserRole.OPERATOR,
        status: opts.status ?? UserStatus.ACTIVE,
        lastLoginAt: opts.signedIn === false ? null : new Date("2026-11-01T12:00:00Z"),
        forcePasswordChange: opts.forcePasswordChange ?? false,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        ...(opts.password ? { password: opts.password } : {}),
      },
    });
  const newAddress = (name: string) => `${name}-${RUN}-${++seq}@example.invalid`;

  /** The editor's id is the sixth argument. */
  const edit = (
    tenantId: string,
    targetId: string,
    dto: Record<string, unknown>,
    caller: { id: string; role: UserRole; username?: string },
  ) =>
    ctx.run(tenantId, () =>
      (users.updateUser as (...a: unknown[]) => Promise<Record<string, unknown>>).call(
        users,
        targetId,
        dto,
        caller.username ?? "editor",
        caller.role,
        undefined,
        caller.id,
      ),
    );
  const confirm = (token: string) =>
    (auth as unknown as { confirmEmailChange(t: string): Promise<unknown> }).confirmEmailChange(
      token,
    );

  const rowsOf = (userId: string) =>
    prisma.userEmailChange.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  const emailOf = async (userId: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).email;
  const mailsOfKind = (kind: string) => mails.filter((m) => m.kind === kind);
  /** The raw token from the last mailed confirm link. */
  const lastToken = () => {
    const url = String(mailsOfKind("link").pop()?.confirmUrl ?? "");
    return url.match(/token=([\w-]+)/)?.[1] ?? "";
  };
  /** Insert a live change row with a known token, bypassing the service. */
  const plantRow = async (userId: string, from: string, to: string, expiresInMs = 3_600_000) => {
    const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    await prisma.userEmailChange.create({
      data: {
        userId,
        fromEmail: from,
        toEmail: to,
        tokenHash: sha(token),
        requestedByUserId: userId,
        expiresAt: new Date(Date.now() + expiresInMs),
      },
    });
    return token;
  };

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    const rec =
      (kind: string) =>
      async (p: Record<string, unknown>): Promise<{ delivered: boolean; transport: string }> => {
        mails.push({ kind, ...p } as Mail);
        return { delivered: true, transport: "test" };
      };
    const email = {
      send: rec("send"),
      sendSetPasswordEmail: async (p: Record<string, unknown>) => {
        if (failInvite) throw new Error("smtp down");
        return rec("invite")(p);
      },
      sendEmailChangedNotice: rec("changed-notice"),
      sendEmailChangeConfirmation: rec("changed-confirmation"),
      sendEmailChangeLink: rec("link"),
      sendEmailChangeRequestedNotice: rec("requested-notice"),
      sendRoleChangedNotice: rec("role-notice"),
    };
    const jwtConfig = {
      secret: SECRET,
      refreshSecret: "rs",
      expiresIn: "15m",
      refreshExpiresIn: "30d",
    };
    const config = {
      get: (k: string) =>
        k === "jwt"
          ? jwtConfig
          : k === "jwt.secret"
            ? SECRET
            : k === "WEB_URL"
              ? "https://web.test"
              : { web: "https://web.test", mobileWeb: "https://mobile.test" },
    };
    const jwt = new JwtService({ secret: SECRET });
    users = new UsersService(prisma, email as never, config as never);
    tenants = new TenantsService(
      prisma,
      {} as never,
      {} as never,
      email as never,
      config as never,
      jwt,
    );
    auth = new AuthService(
      prisma,
      users,
      jwt,
      config as never,
      email as never,
      {
        claimsFor: async () => null,
      } as never,
    );
  }, 120_000);

  beforeEach(() => {
    mails = [];
    failInvite = false;
  });

  afterAll(async () => {
    for (const id of tenantIds) {
      await prisma.refreshToken.deleteMany({ where: { user: { tenantId: id } } });
      await prisma.passwordResetToken.deleteMany({ where: { user: { tenantId: id } } });
      await prisma.auditLog.deleteMany({ where: { tenantId: id } });
      await prisma.user.deleteMany({ where: { tenantId: id } }); // token rows cascade
      await prisma.tenant.deleteMany({ where: { id } });
    }
    await prisma?.$disconnect();
  }, 120_000);

  it("R-1: a signed-in user edits their own email: the stored email stays, one live row, the new address gets the link", async () => {
    const tenantId = await mkTenant("r1");
    const user = await mkUser(tenantId, "self");
    const next = newAddress("self-new");
    const res = await edit(tenantId, user.id, { email: next }, { id: user.id, role: user.role });

    const rows = await rowsOf(user.id);
    expect({
      storedEmail: await emailOf(user.id),
      responseEmail: res.email,
      pendingEmail: res.pendingEmail,
      liveRows: rows.filter((r) => !r.usedAt).map((r) => [r.fromEmail, r.toEmail]),
      linkTo: mailsOfKind("link").map((m) => m.to),
      requestedNoticeTo: mailsOfKind("requested-notice").map((m) => m.to),
      changedNoticeTo: mailsOfKind("changed-notice").map((m) => m.to),
    }).toEqual({
      storedEmail: user.email,
      responseEmail: user.email,
      pendingEmail: next,
      liveRows: [[user.email, next]],
      linkTo: [next],
      requestedNoticeTo: [user.email],
      changedNoticeTo: [],
    });
    expect(String(mailsOfKind("link")[0].confirmUrl)).toMatch(
      /^https:\/\/web\.test\/confirm-email-change\?token=[0-9a-f]{64}$/,
    );
    expect(rows[0].requestedByUserId).toBe(user.id);
    // the new address is masked in the notice to the old one
    expect(JSON.stringify(mailsOfKind("requested-notice")[0])).not.toContain(next);
  });

  it("R-2: an admin edits a signed-in operator's email: the same hold, the editor is recorded", async () => {
    const tenantId = await mkTenant("r2");
    const admin = await mkUser(tenantId, "admin", { role: UserRole.TENANT_ADMIN });
    const operator = await mkUser(tenantId, "op");
    const next = newAddress("op-new");
    const renamed = `renamed_${RUN}_${++seq}`;
    const res = await edit(
      tenantId,
      operator.id,
      { email: next, username: renamed },
      { id: admin.id, role: UserRole.TENANT_ADMIN },
    );

    const rows = await rowsOf(operator.id);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: operator.id } });
    expect({
      storedEmail: stored.email,
      storedUsername: stored.username,
      pendingEmail: res.pendingEmail,
      liveRows: rows.filter((r) => !r.usedAt).map((r) => [r.toEmail, r.requestedByUserId]),
      linkTo: mailsOfKind("link").map((m) => m.to),
    }).toEqual({
      storedEmail: operator.email,
      storedUsername: renamed, // a username edit applies at once (Q5)
      pendingEmail: next,
      liveRows: [[next, admin.id]],
      linkTo: [next],
    });
  });

  it("R-3 (guard): an admin corrects a never-signed-in invitee's email: written at once, with the invite, no row", async () => {
    const tenantId = await mkTenant("r3");
    const admin = await mkUser(tenantId, "admin", { role: UserRole.TENANT_ADMIN });
    const invitee = await mkUser(tenantId, "invitee", {
      signedIn: false,
      forcePasswordChange: true,
    });
    const next = newAddress("invitee-fixed");
    const res = await edit(
      tenantId,
      invitee.id,
      { email: next },
      { id: admin.id, role: UserRole.TENANT_ADMIN },
    );

    expect({
      storedEmail: await emailOf(invitee.id),
      responseEmail: res.email,
      pendingEmail: res.pendingEmail ?? null,
      rows: (await rowsOf(invitee.id)).length,
      inviteTo: mailsOfKind("invite").map((m) => m.to),
      linkMails: mailsOfKind("link").length,
    }).toEqual({
      storedEmail: next,
      responseEmail: next,
      pendingEmail: null,
      rows: 0,
      inviteTo: [next],
      linkMails: 0,
    });
  });

  // Reader M1: `lastLoginAt` alone is not "never signed in". `refresh()` never stamps it and the stamp is unreliable
  // before 2026-09-29, so an account with no stamp may still be signed in on a phone. Both rows are red on the
  // `lastLoginAt !== null` rule: the email was written at once.
  it("R-9a: no sign-in stamp but created before the stamp was reliable (2026-09-01): the edit holds", async () => {
    const tenantId = await mkTenant("r9a");
    const admin = await mkUser(tenantId, "admin", { role: UserRole.TENANT_ADMIN });
    const old = await mkUser(tenantId, "legacy", {
      signedIn: false,
      createdAt: new Date("2026-09-01T00:00:00Z"),
    });
    const next = newAddress("legacy-new");
    const res = await edit(
      tenantId,
      old.id,
      { email: next },
      { id: admin.id, role: UserRole.TENANT_ADMIN },
    );

    expect({
      stored: await emailOf(old.id),
      pending: res.pendingEmail,
      liveRows: (await rowsOf(old.id)).filter((r) => !r.usedAt).length,
    }).toEqual({ stored: old.email, pending: next, liveRows: 1 });
  });

  it("R-9b: no sign-in stamp but a refresh-token row (signed in on a phone): the edit holds", async () => {
    const tenantId = await mkTenant("r9b");
    const admin = await mkUser(tenantId, "admin", { role: UserRole.TENANT_ADMIN });
    const driver = await mkUser(tenantId, "phone", { signedIn: false, role: UserRole.DRIVER });
    await prisma.refreshToken.create({
      data: {
        userId: driver.id,
        tenantId,
        tokenHash: sha(randomUUID()),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const next = newAddress("phone-new");
    const res = await edit(
      tenantId,
      driver.id,
      { email: next },
      { id: admin.id, role: UserRole.TENANT_ADMIN },
    );

    expect({
      stored: await emailOf(driver.id),
      pending: res.pendingEmail,
      liveRows: (await rowsOf(driver.id)).filter((r) => !r.usedAt).length,
    }).toEqual({ stored: driver.email, pending: next, liveRows: 1 });
  });

  // Reader S-new-2: a legacy invitee (created before the sign-in stamp was reliable) now HOLDS an email edit. The
  // set-password link mailed to the old, mistyped address must still die when an admin corrects it. Red before: the
  // hold burned nothing, so the link stayed live in the wrong inbox.
  // SA-1126 (a): a confirm that lands for an account still owing a first password sends a fresh set-password invite
  // to the NEW address (the old address's link died with the hold). Red before: the confirm sent none.
  it("A-1: a legacy invitee's admin-corrected change is confirmed: exactly one invite, to the NEW address", async () => {
    const tenantId = await mkTenant("a1");
    const admin = await mkUser(tenantId, "admin", { role: UserRole.TENANT_ADMIN });
    const invitee = await mkUser(tenantId, "a1inv", {
      signedIn: false,
      forcePasswordChange: true,
      createdAt: new Date("2026-09-01T00:00:00Z"),
    });
    const next = newAddress("a1inv-fixed");
    await edit(
      tenantId,
      invitee.id,
      { email: next },
      { id: admin.id, role: UserRole.TENANT_ADMIN },
    );
    const token = lastToken();
    mails = [];

    await confirm(token);

    expect(await emailOf(invitee.id)).toBe(next);
    expect(mailsOfKind("invite").map((m) => m.to)).toEqual([next]);
    expect(
      await prisma.passwordResetToken.count({ where: { userId: invitee.id, usedAt: null } }),
    ).toBe(1);
  });

  it("A-2: a signed-in account after an admin password reset confirms: the invite goes to the new address", async () => {
    const tenantId = await mkTenant("a2");
    const user = await mkUser(tenantId, "a2user");
    await ctx.run(tenantId, () => users.resetPassword(user.id, UserRole.TENANT_ADMIN));
    const next = newAddress("a2user-new");
    await edit(tenantId, user.id, { email: next }, { id: user.id, role: user.role });
    const token = lastToken();
    mails = [];

    await confirm(token);

    expect(mailsOfKind("invite").map((m) => m.to)).toEqual([next]);
  });

  it("A-3: no forced password change means no invite; a failing invite mail never undoes the confirm", async () => {
    const tenantId = await mkTenant("a3");
    const plain = await mkUser(tenantId, "a3plain");
    const next = newAddress("a3plain-new");
    await edit(tenantId, plain.id, { email: next }, { id: plain.id, role: plain.role });
    const token = lastToken();
    mails = [];
    await confirm(token);
    expect(await emailOf(plain.id)).toBe(next);
    expect(mailsOfKind("invite")).toEqual([]);

    const owing = await mkUser(tenantId, "a3owing", { forcePasswordChange: true });
    const next2 = newAddress("a3owing-new");
    await edit(tenantId, owing.id, { email: next2 }, { id: owing.id, role: owing.role });
    const token2 = lastToken();
    failInvite = true;
    await expect(confirm(token2)).resolves.toMatchObject({ email: next2 });
    expect(await emailOf(owing.id)).toBe(next2);
  });
  it("R-13: a legacy invitee's live set-password link dies when an admin corrects the email, though the change is held", async () => {
    const tenantId = await mkTenant("r13");
    const admin = await mkUser(tenantId, "admin", { role: UserRole.TENANT_ADMIN });
    const invitee = await mkUser(tenantId, "legacyinv", {
      signedIn: false,
      forcePasswordChange: true,
      createdAt: new Date("2026-09-01T00:00:00Z"),
    });
    const linkToken = randomUUID().replace(/-/g, "");
    await prisma.passwordResetToken.create({
      data: {
        userId: invitee.id,
        tokenHash: sha(linkToken),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const next = newAddress("legacyinv-fixed");
    const res = await edit(
      tenantId,
      invitee.id,
      { email: next },
      { id: admin.id, role: UserRole.TENANT_ADMIN },
    );

    expect({
      held: res.pendingEmail,
      stored: await emailOf(invitee.id),
      liveSetPasswordLinks: await prisma.passwordResetToken.count({
        where: { userId: invitee.id, usedAt: null },
      }),
    }).toEqual({ held: next, stored: invitee.email, liveSetPasswordLinks: 0 });
    await expect(auth.resetPassword(linkToken, "Abcdefg1!")).rejects.toBeDefined();
    // B448 stays closed: the hold wrote nothing to the sign-up link table
    expect(await prisma.userEmailVerificationToken.count({ where: { userId: invitee.id } })).toBe(
      0,
    );
  });

  it("R-10: a new address another live user already holds is refused at the request (case-insensitive): EMAIL_TAKEN, no row, no mail", async () => {
    const tenantId = await mkTenant("r10");
    const holder = await mkUser(tenantId, "holder");
    const user = await mkUser(tenantId, "wants");
    await expect(
      edit(
        tenantId,
        user.id,
        { email: holder.email.toUpperCase() },
        { id: user.id, role: user.role },
      ),
    ).rejects.toMatchObject({ response: { code: "EMAIL_TAKEN" } });

    expect({
      stored: await emailOf(user.id),
      rows: (await rowsOf(user.id)).length,
      mails: mails.length,
    }).toEqual({ stored: user.email, rows: 0, mails: 0 });
  });

  it("R-11: a pending change, then an admin's role-only edit, then the old link: refused, email unchanged", async () => {
    const tenantId = await mkTenant("r11");
    const admin = await mkUser(tenantId, "admin", { role: UserRole.TENANT_ADMIN });
    const user = await mkUser(tenantId, "rolechg");
    await edit(
      tenantId,
      user.id,
      { email: newAddress("rolechg-new") },
      { id: user.id, role: user.role },
    );
    const token = lastToken();
    await edit(
      tenantId,
      user.id,
      { role: UserRole.DRIVER },
      { id: admin.id, role: UserRole.TENANT_ADMIN },
    );

    await expect(confirm(token)).rejects.toMatchObject({
      response: { code: "EMAIL_CHANGE_LINK_INVALID" },
    });
    expect(await emailOf(user.id)).toBe(user.email);
  });

  it("R-12: changePassword and setPassword each kill a pending link, in the password write's transaction", async () => {
    const tenantId = await mkTenant("r12");
    const hash = await bcrypt.hash("Old-pass-1!", 4);
    const withPw = await mkUser(tenantId, "haspw", { password: hash });
    await edit(
      tenantId,
      withPw.id,
      { email: newAddress("haspw-new") },
      { id: withPw.id, role: withPw.role },
    );
    const tokenA = lastToken();
    await auth.changePassword(withPw.id, "Old-pass-1!", "New-pass-2@");
    await expect(confirm(tokenA)).rejects.toMatchObject({
      response: { code: "EMAIL_CHANGE_LINK_INVALID" },
    });
    expect(await emailOf(withPw.id)).toBe(withPw.email);

    const noPw = await mkUser(tenantId, "nopw");
    await edit(
      tenantId,
      noPw.id,
      { email: newAddress("nopw-new") },
      { id: noPw.id, role: noPw.role },
    );
    const tokenB = lastToken();
    await auth.setPassword(noPw.id, "Fresh-pass-3#");
    await expect(confirm(tokenB)).rejects.toMatchObject({
      response: { code: "EMAIL_CHANGE_LINK_INVALID" },
    });
    expect(await emailOf(noPw.id)).toBe(noPw.email);
  });

  it("R-4: a valid confirm writes the email and emailVerifiedAt, marks the row used and notices both addresses", async () => {
    const tenantId = await mkTenant("r4");
    const user = await mkUser(tenantId, "confirm");
    const next = newAddress("confirm-new");
    const token = await plantRow(user.id, user.email, next);

    const out = await confirm(token).then(
      (r) => r,
      (e: Error) => ({ error: e.message }),
    );
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const [row] = await rowsOf(user.id);
    expect({
      out,
      storedEmail: stored.email,
      verified: stored.emailVerifiedAt != null,
      rowUsed: row.usedAt != null,
      changedNoticeTo: mailsOfKind("changed-notice").map((m) => m.to),
      confirmationTo: mailsOfKind("changed-confirmation").map((m) => m.to),
    }).toEqual({
      out: { email: next },
      storedEmail: next,
      verified: true,
      rowUsed: true,
      changedNoticeTo: [user.email],
      confirmationTo: [next],
    });
    // single use: a redelivered confirm finds the row used and writes nothing
    await expect(confirm(token)).rejects.toMatchObject({
      response: { code: "EMAIL_CHANGE_LINK_INVALID" },
    });
    expect(await emailOf(user.id)).toBe(next);
  });

  it("R-5: a link after a newer request is dead; the newer one works", async () => {
    const tenantId = await mkTenant("r5a");
    const user = await mkUser(tenantId, "twice");
    const self = { id: user.id, role: user.role };
    await edit(tenantId, user.id, { email: newAddress("first") }, self);
    const first = lastToken();
    const second = newAddress("second");
    await edit(tenantId, user.id, { email: second }, self);
    const secondToken = lastToken();
    expect(first).not.toBe(secondToken);
    expect((await rowsOf(user.id)).filter((r) => !r.usedAt)).toHaveLength(1);

    await expect(confirm(first)).rejects.toMatchObject({
      response: { code: "EMAIL_CHANGE_LINK_INVALID" },
    });
    expect(await emailOf(user.id)).toBe(user.email);
    await expect(confirm(secondToken)).resolves.toEqual({ email: second });
  });

  it("R-5: an admin password reset kills a pending link", async () => {
    const tenantId = await mkTenant("r5b");
    const user = await mkUser(tenantId, "reset");
    const self = { id: user.id, role: user.role };
    await edit(tenantId, user.id, { email: newAddress("reset-new") }, self);
    const token = lastToken();
    await ctx.run(tenantId, () => users.resetPassword(user.id, UserRole.TENANT_ADMIN));
    await expect(confirm(token)).rejects.toMatchObject({
      response: { code: "EMAIL_CHANGE_LINK_INVALID" },
    });
    expect(await emailOf(user.id)).toBe(user.email);
  });

  it("R-5: a self-service password reset (the emailed reset link) kills a pending link", async () => {
    const tenantId = await mkTenant("r5c");
    const user = await mkUser(tenantId, "reset2");
    const self = { id: user.id, role: user.role };
    await edit(tenantId, user.id, { email: newAddress("reset2-new") }, self);
    const token = lastToken();
    const resetToken = randomUUID().replace(/-/g, "");
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha(resetToken),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    await auth.resetPassword(resetToken, "Abcdefg1!");
    await expect(confirm(token)).rejects.toMatchObject({
      response: { code: "EMAIL_CHANGE_LINK_INVALID" },
    });
    expect(await emailOf(user.id)).toBe(user.email);
  });

  it("R-5: a deactivation kills a pending link", async () => {
    const tenantId = await mkTenant("r5d");
    const keeper = await mkUser(tenantId, "keeper", { role: UserRole.TENANT_ADMIN });
    const user = await mkUser(tenantId, "gone");
    await edit(
      tenantId,
      user.id,
      { email: newAddress("gone-new") },
      { id: user.id, role: user.role },
    );
    const token = lastToken();
    await ctx.run(tenantId, () =>
      users.changeStatus(
        user.id,
        { status: UserStatus.INACTIVE },
        UserRole.TENANT_ADMIN,
        keeper.id,
      ),
    );
    await expect(confirm(token)).rejects.toMatchObject({
      response: { code: "EMAIL_CHANGE_LINK_INVALID" },
    });
    expect(await emailOf(user.id)).toBe(user.email);
  });

  it("R-5: an expired link and a made-up token are refused with the same code", async () => {
    const tenantId = await mkTenant("r5e");
    const user = await mkUser(tenantId, "expired");
    const token = await plantRow(user.id, user.email, newAddress("expired-new"), -60_000);
    await expect(confirm(token)).rejects.toMatchObject({
      response: { code: "EMAIL_CHANGE_LINK_INVALID" },
    });
    await expect(confirm("0".repeat(64))).rejects.toMatchObject({
      response: { code: "EMAIL_CHANGE_LINK_INVALID" },
    });
    expect(await emailOf(user.id)).toBe(user.email);
  });

  it("R-6: the email moved after the request (CAS): refused, nothing written, the row stays unused", async () => {
    const tenantId = await mkTenant("r6");
    const user = await mkUser(tenantId, "cas");
    const next = newAddress("cas-new");
    const token = await plantRow(user.id, user.email, next);
    const moved = newAddress("cas-moved");
    await prisma.user.update({ where: { id: user.id }, data: { email: moved } });

    await expect(confirm(token)).rejects.toMatchObject({
      response: { code: "EMAIL_CHANGE_LINK_INVALID" },
    });
    expect(await emailOf(user.id)).toBe(moved);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt,
    ).toBeNull();
    expect((await rowsOf(user.id))[0].usedAt).toBeNull();
    expect(mails).toHaveLength(0);
  });

  it("R-7: the new address is taken in the tenant at confirm time: EMAIL_TAKEN, nothing written", async () => {
    const tenantId = await mkTenant("r7");
    const user = await mkUser(tenantId, "taken");
    const next = newAddress("taken-new");
    const token = await plantRow(user.id, user.email, next);
    await prisma.user.create({
      data: {
        tenantId,
        username: `squatter_${RUN}_${++seq}`,
        email: next,
        role: UserRole.OPERATOR,
        status: UserStatus.ACTIVE,
      },
    });

    await expect(confirm(token)).rejects.toMatchObject({ response: { code: "EMAIL_TAKEN" } });
    expect(await emailOf(user.id)).toBe(user.email);
    expect((await rowsOf(user.id))[0].usedAt).toBeNull();
    expect(mails).toHaveLength(0);
  });

  it("R-8 (B448 guard): a change request for a deactivated admin writes no sign-up link row: signupLinkState stays none, resend does nothing", async () => {
    const tenantId = await mkTenant("r8");
    const keeper = await mkUser(tenantId, "keeper", { role: UserRole.TENANT_ADMIN });
    const target = await mkUser(tenantId, "target", { role: UserRole.TENANT_ADMIN });
    await ctx.run(tenantId, () =>
      users.changeStatus(
        target.id,
        { status: UserStatus.INACTIVE },
        UserRole.TENANT_ADMIN,
        keeper.id,
      ),
    );
    const next = newAddress("target-new");
    await edit(
      tenantId,
      target.id,
      { email: next },
      { id: keeper.id, role: UserRole.TENANT_ADMIN },
    );

    // the hold really ran (a live change row), and it never touched the sign-up link table
    expect((await rowsOf(target.id)).filter((r) => !r.usedAt)).toHaveLength(1);
    expect(await prisma.userEmailVerificationToken.count({ where: { userId: target.id } })).toBe(0);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(await signupLinkState(prisma, fresh)).toBe("none");
    mails = [];
    expect(await tenants.resendVerification(fresh.email)).toBe(false);
    expect(mails).toHaveLength(0);
    expect(fresh.status).toBe(UserStatus.INACTIVE);
  });
});
