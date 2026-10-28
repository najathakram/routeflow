class MockLockTimeoutError extends Error {}
class MockLockUnavailableError extends Error {}
// The per-tenant customer lock is covered by trial-addon-checkout.spec; here it just runs the callback.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: jest.fn(async (_o: unknown, fn: () => Promise<unknown>) => ({
    acquired: true as const,
    value: await fn(),
  })),
  LockTimeoutError: MockLockTimeoutError,
  LockUnavailableError: MockLockUnavailableError,
}));

import { BillingService } from "./billing.service";
import { BillingNotificationService } from "./billing-notification.service";
import { accountAdminsOf } from "./account-admins";

/**
 * SA-1037 r3 PR-3 (MUST 2 + MUST 8): a NEW Stripe customer gets the one account admin's email, or none. The
 * placeholder `tenant-<id>@routeflow.app` is never written, and the account admin is read through the SAME
 * predicate billing notifications use (ACTIVE TENANT_ADMIN, oldest first, tenantId-filtered). Stripe is MOCKED;
 * an existing customer is never touched (no `customers.update` exists on the mock at all).
 */

type U = {
  tenantId: string;
  email: string;
  username: string | null;
  role: string;
  status: string;
  deletedAt: Date | null;
  createdAt: Date;
};

const user = (o: Partial<U>): U => ({
  tenantId: "t1",
  email: "admin@acme.test",
  username: "admin",
  role: "TENANT_ADMIN",
  status: "ACTIVE",
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...o,
});

/** A users table that honours the `where` / `orderBy` it is given, so a query that forgets a filter shows it. */
function usersTable(rows: U[]) {
  const match = (u: U, where: any = {}) =>
    Object.entries(where).every(([k, v]) => (u as any)[k] === v);
  const sorted = (list: U[], orderBy?: { createdAt?: "asc" | "desc" }) =>
    orderBy?.createdAt === "asc"
      ? [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      : list;
  return {
    findFirst: jest.fn(async ({ where, orderBy }: any = {}) => {
      return (
        sorted(
          rows.filter((u) => match(u, where)),
          orderBy,
        )[0] ?? null
      );
    }),
    findMany: jest.fn(async ({ where, orderBy }: any = {}) =>
      sorted(
        rows.filter((u) => match(u, where)),
        orderBy,
      ),
    ),
  };
}

function make(rows: U[]) {
  const createCustomer = jest.fn(async (_p: { email?: string; name: string }) => ({
    id: "cus_new",
  }));
  const stripe: any = { isConfigured: true, createCustomer };
  const upsert = jest.fn(async () => ({}));
  const prisma: any = {
    tenant: {
      findUnique: jest.fn(async () => ({
        id: "t1",
        slug: "acme",
        name: "Acme",
        plan: "STARTER",
        subscription: null,
        config: { businessName: "Acme" },
      })),
    },
    tenantSubscription: { findUnique: jest.fn(async () => null), upsert },
    user: usersTable(rows),
  };
  const billing = new BillingService(
    prisma,
    stripe,
    { send: jest.fn() } as any,
    { invalidate: jest.fn() } as any,
    { emit: jest.fn() } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { billing, prisma, createCustomer, upsert };
}

const emailSent = (h: ReturnType<typeof make>) => h.createCustomer.mock.calls[0][0].email;

describe("ensureStripeCustomer: the email of a NEW customer (SA-1037 r3 PR-3)", () => {
  it("R3: the only TENANT_ADMIN is deactivated (status not ACTIVE, deletedAt null): the customer gets NO email", async () => {
    const h = make([user({ status: "SUSPENDED", email: "gone@acme.test" })]);
    await h.billing.ensureStripeCustomer("t1");
    expect(emailSent(h)).toBeUndefined();
  });

  it("R3: no TENANT_ADMIN at all: NO email, and never the routeflow.app placeholder", async () => {
    const h = make([user({ role: "STAFF" })]);
    await h.billing.ensureStripeCustomer("t1");
    expect(emailSent(h)).toBeUndefined();
    expect(JSON.stringify(h.createCustomer.mock.calls)).not.toContain("routeflow.app");
  });

  it("an ACTIVE TENANT_ADMIN: the oldest one's address", async () => {
    const h = make([
      user({ email: "newer@acme.test", createdAt: new Date("2026-03-01T00:00:00Z") }),
      user({ email: "oldest@acme.test", createdAt: new Date("2026-01-01T00:00:00Z") }),
      user({ email: "middle@acme.test", createdAt: new Date("2026-02-01T00:00:00Z") }),
    ]);
    await h.billing.ensureStripeCustomer("t1");
    expect(emailSent(h)).toBe("oldest@acme.test");
  });

  it("a soft-deleted admin and an admin of ANOTHER tenant are never used", async () => {
    const h = make([
      user({ email: "deleted@acme.test", deletedAt: new Date("2026-02-01T00:00:00Z") }),
      user({ email: "other-tenant@other.test", tenantId: "t2" }),
    ]);
    await h.billing.ensureStripeCustomer("t1");
    expect(emailSent(h)).toBeUndefined();
  });

  it("the customer is still created and stored when there is no email (name + metadata unchanged)", async () => {
    const h = make([]);
    await expect(h.billing.ensureStripeCustomer("t1")).resolves.toBe("cus_new");
    expect(h.createCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.any(String),
        metadata: { tenantId: "t1", slug: "acme" },
      }),
    );
    expect(h.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { stripeCustomerId: "cus_new" } }),
    );
  });

  it("an existing customer: nothing is read and nothing is written (MUST 8)", async () => {
    const h = make([user({})]);
    h.prisma.tenant.findUnique.mockResolvedValueOnce({
      id: "t1",
      slug: "acme",
      name: "Acme",
      plan: "STARTER",
      subscription: { stripeCustomerId: "cus_existing" },
      config: { businessName: "Acme" },
    });
    await expect(h.billing.ensureStripeCustomer("t1")).resolves.toBe("cus_existing");
    expect(h.createCustomer).not.toHaveBeenCalled();
    expect(h.prisma.user.findMany).not.toHaveBeenCalled();
    expect(h.prisma.user.findFirst).not.toHaveBeenCalled();
  });
});

describe("one definition of the account admin (G4): billing notifications and the Stripe customer read the same helper", () => {
  const rows = [
    user({ email: "b@acme.test", createdAt: new Date("2026-02-01T00:00:00Z") }),
    user({ email: "a@acme.test", createdAt: new Date("2026-01-01T00:00:00Z") }),
    user({ email: "off@acme.test", status: "SUSPENDED" }),
    user({ email: "x@other.test", tenantId: "t2" }),
  ];

  it("accountAdminsOf: ACTIVE TENANT_ADMIN of the tenant, oldest first", async () => {
    const admins = await accountAdminsOf({ user: usersTable(rows) } as any, "t1");
    expect(admins.map((a) => a.email)).toEqual(["a@acme.test", "b@acme.test"]);
  });

  it("accountAdminsOf drops a row with no email", async () => {
    const admins = await accountAdminsOf(
      { user: usersTable([user({ email: "" }), user({ email: "ok@acme.test" })]) } as any,
      "t1",
    );
    expect(admins.map((a) => a.email)).toEqual(["ok@acme.test"]);
  });

  it("the billing notification recipients are exactly that list", async () => {
    const prisma: any = { user: usersTable(rows) };
    const svc = new BillingNotificationService(prisma, {} as any);
    const recipients = await (svc as any).adminsOf("t1");
    expect(recipients.map((r: any) => r.email)).toEqual(
      (await accountAdminsOf(prisma, "t1")).map((a) => a.email),
    );
  });
});
