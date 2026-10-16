/**
 * SA-788 (b) - the daily add-on invariant (B-R1..B-R5 at unit level; the real-Postgres rows are in
 * addon-invariant.job.db.spec.ts). Prisma, the catalog, Stripe and e-mail are mocked at the module boundary.
 *
 * Covered: I1 (a deactivation with no human record), I2 (an owed re-price), I3 (billing an included add-on); the dedupe
 * claim (a second run writes nothing new); the dark e-mail (`log` by default, nothing is sent; `email` sends ONE
 * message per recipient for the run); a failed send releases the claims; the findings cap; the registry shape.
 */
import { Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  ADDON_INVARIANTS,
  ADDON_INVARIANT_MAX_FINDINGS_PER_RUN,
  AddonInvariantJob,
  findingMessage,
} from "./addon-invariant.job";

const NOW = new Date("2026-10-16T07:00:00.000Z");
const HOUR = 3_600_000;

const CATALOG = {
  id: "v1",
  addonSkus: [
    { sku: "REGULATED_ITEMS", name: "Regulated items", monthlyPrice: 39, includedAtPlan: "SCALE" },
    { sku: "FORECASTING", name: "Forecasting", monthlyPrice: 25, includedAtPlan: null },
  ],
};

const tenant = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  slug: "acme",
  name: "Acme",
  status: "ACTIVE",
  plan: "TEAM",
  subscription: {
    planKey: "GROWTH",
    planVersionId: "v1",
    stripeSubId: "sub_1",
    externalPayment: false,
    couponFull: false,
  },
  ...over,
});

const row = (over: Record<string, unknown> = {}) => ({
  id: "ta1",
  tenantId: "t1",
  addonKey: "REGULATED_ITEMS",
  sku: "REGULATED_ITEMS",
  active: true,
  isComp: false,
  quantity: 1,
  priceSnapshot: 0,
  stripeItemId: null,
  updatedAt: new Date(NOW.getTime() - HOUR),
  ...over,
});

function make(
  o: {
    pages?: any[][];
    rows?: any[];
    events?: any[];
    send?: jest.Mock;
  } = {},
) {
  const claims = new Set<string>();
  const pages = o.pages ?? [[tenant()]];
  let page = 0;
  const prisma: any = {
    tenant: {
      findMany: jest.fn(async () => pages[page++] ?? []),
    },
    tenantAddon: { findMany: jest.fn(async () => o.rows ?? []) },
    billingEvent: { findMany: jest.fn(async () => o.events ?? []) },
    billingNotificationLog: {
      create: jest.fn(async ({ data }: any) => {
        const k = `${data.tenantId}/${data.milestone}/${data.key}`;
        if (claims.has(k)) {
          throw new Prisma.PrismaClientKnownRequestError("dup", {
            code: "P2002",
            clientVersion: "test",
          });
        }
        claims.add(k);
        return data;
      }),
      delete: jest.fn(async ({ where }: any) => {
        const w = where.tenantId_milestone_key;
        claims.delete(`${w.tenantId}/${w.milestone}/${w.key}`);
        return {};
      }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const catalog: any = {
    getVersionForTenant: jest.fn().mockResolvedValue(CATALOG),
    getPublishedCatalog: jest.fn().mockResolvedValue(CATALOG),
  };
  const stripe: any = { isConfigured: true };
  const send = o.send ?? jest.fn().mockResolvedValue({ delivered: true, transport: "smtp" });
  const email: any = { sendPlatform: send };
  const job = new AddonInvariantJob(prisma, catalog, stripe, email);
  return { job, prisma, send, claims };
}

let errorSpy: jest.SpyInstance;
beforeEach(() => {
  errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  delete process.env.ADDON_INVARIANT_EMAIL;
  delete process.env.PLATFORM_ALERT_EMAILS;
});
afterEach(() => errorSpy.mockRestore());

const inactive = () => row({ active: false });

describe("I1: a deactivation no owner, admin or tenant made", () => {
  it("B-R1: an inactive row with NO record -> one finding: logged, one in-app notice, none in log mode", async () => {
    const { job, prisma, send } = make({ rows: [inactive()] });
    const found = await job.run(NOW);

    expect(found.map((f) => [f.invariant, f.sku])).toEqual([["I1", "REGULATED_ITEMS"]]);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("addon invariant I1"))).toBe(true);
    const notices = prisma.auditLog.create.mock.calls.map((c: any[]) => c[0].data);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ tenantId: "t1", action: "ADDON_INVARIANT_BROKEN" });
    expect(notices[0].meta.message).toBe(
      "Add-on Regulated items for Acme: was switched off with no owner, admin or tenant action on record. Check the tenant's add-ons.",
    );
    expect(send).not.toHaveBeenCalled(); // dark by default
  });

  it("B-R1: a second run gives no duplicate (the claim is the dedupe)", async () => {
    const m = make({ rows: [inactive()], pages: [[tenant()], [tenant()]] });
    expect(await m.job.run(NOW)).toHaveLength(1);
    expect(await m.job.run(NOW)).toHaveLength(0);
    expect(m.prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("B-R1: in `email` mode ONE message per recipient lists the run's findings", async () => {
    process.env.ADDON_INVARIANT_EMAIL = "email";
    process.env.PLATFORM_ALERT_EMAILS = "ops@example.test, owner@example.test";
    const { job, send } = make({ rows: [inactive()] });
    await job.run(NOW);

    expect(send).toHaveBeenCalledTimes(2);
    const first = send.mock.calls[0][0];
    expect(first.to).toBe("ops@example.test");
    expect(first.subject).toBe("RouteFlow alert: 1 add-on issue(s) need a look");
    expect(first.text).toContain("Acme (acme): add-on Regulated items was switched off");
    expect(first.text).toContain("/admin/tenants/t1");
    expect(`${first.subject}${first.text}${first.html}`).not.toMatch(/[–—]/); // no em or en dashes
  });

  it("B-R2: a deactivation by the TENANT (or an admin) is not a finding; a SYSTEM one is", async () => {
    const byTenant = make({
      rows: [inactive()],
      events: [{ payload: { rowId: "ta1", actor: { kind: "TENANT_USER", id: "u1" } } }],
    });
    expect(await byTenant.job.run(NOW)).toHaveLength(0);
    const bySystem = make({
      rows: [inactive()],
      events: [{ payload: { rowId: "ta1", actor: { kind: "SYSTEM", id: null } } }],
    });
    expect((await bySystem.job.run(NOW)).map((f) => f.invariant)).toEqual(["I1"]);
  });

  it("only the LATEST record of a row counts (events arrive oldest first)", async () => {
    const { job } = make({
      rows: [inactive()],
      events: [
        { payload: { rowId: "ta1", actor: { kind: "SYSTEM", id: null } } },
        { payload: { rowId: "ta1", actor: { kind: "PLATFORM_ADMIN", id: "a1" } } },
      ],
    });
    expect(await job.run(NOW)).toHaveLength(0);
  });

  it("a row older than the 26 h window, and a tenant that is not ACTIVE, are not findings", async () => {
    const old = make({
      rows: [row({ active: false, updatedAt: new Date(NOW.getTime() - 30 * HOUR) })],
    });
    expect(await old.job.run(NOW)).toHaveLength(0);
    const locked = make({ pages: [[tenant({ status: "READ_ONLY" })]], rows: [inactive()] });
    expect(await locked.job.run(NOW)).toHaveLength(0);
  });
});

describe("I2 and I3: a re-price owed, and billing an included add-on", () => {
  it("B-R3: a $0 row GROWTH does not include (STRIPE) is I2; a priced row SCALE includes is I3", async () => {
    const i2 = make({ rows: [row()] });
    const f2 = await i2.job.run(NOW);
    expect(f2.map((f) => f.invariant)).toEqual(["I2"]);
    expect(findingMessage(f2[0])).toBe(
      "Add-on Regulated items for Acme: is on at $0 but GROWTH does not include it: $39.00 a month is owed. Check the tenant's add-ons.",
    );

    const i3 = make({
      pages: [[tenant({ subscription: { ...tenant().subscription, planKey: "SCALE" } })]],
      rows: [row({ priceSnapshot: 39, stripeItemId: "si_1" })],
    });
    const f3 = await i3.job.run(NOW);
    expect(f3.map((f) => f.invariant)).toEqual(["I3"]);
    expect(f3[0].sentence).toBe("is billed although SCALE includes it");
  });

  it("an UNBILLED tenant is never an I2; a comp, a quantity-owner of an included $0 row, a non-included priced row are clean", async () => {
    const unbilled = make({
      pages: [[tenant({ subscription: { planKey: "GROWTH", planVersionId: "v1" } })]],
      rows: [row()],
    });
    expect(await unbilled.job.run(NOW)).toHaveLength(0);

    const clean = make({
      pages: [[tenant({ subscription: { ...tenant().subscription, planKey: "SCALE" } })]],
      rows: [
        row({ id: "a", isComp: true, priceSnapshot: 39 }), // a comp is never billed or owed
        row({ id: "b", priceSnapshot: 0 }), // included at SCALE and free: the intended state
        row({ id: "c", addonKey: "FORECASTING", sku: "FORECASTING", priceSnapshot: 25 }), // priced, not included
      ],
    });
    expect(await clean.job.run(NOW)).toHaveLength(0);
  });
});

describe("the e-mail is dark, never throws, and a failed send is retried", () => {
  it("B-R5: a failed send releases the claims, so the next run retries; the job does not throw", async () => {
    process.env.ADDON_INVARIANT_EMAIL = "email";
    process.env.PLATFORM_ALERT_EMAILS = "ops@example.test";
    const send = jest.fn().mockResolvedValue({ delivered: false, transport: "none" });
    const m = make({ rows: [inactive()], send, pages: [[tenant()], [tenant()]] });

    await expect(m.job.run(NOW)).resolves.toHaveLength(1);
    expect(m.prisma.billingNotificationLog.delete).toHaveBeenCalledTimes(1);
    expect(m.claims.size).toBe(0);
    await expect(m.job.run(NOW)).resolves.toHaveLength(1); // the retry finds it new again
  });

  it("a send that THROWS also releases and never fails the run", async () => {
    process.env.ADDON_INVARIANT_EMAIL = "email";
    process.env.PLATFORM_ALERT_EMAILS = "ops@example.test";
    const send = jest.fn().mockRejectedValue(new Error("smtp down"));
    const m = make({ rows: [inactive()], send });
    await expect(m.job.run(NOW)).resolves.toHaveLength(1);
    expect(m.prisma.billingNotificationLog.delete).toHaveBeenCalledTimes(1);
  });

  it("`email` mode with no recipients logs one error and still never fails", async () => {
    process.env.ADDON_INVARIANT_EMAIL = "email";
    const m = make({ rows: [inactive()] });
    await expect(m.job.run(NOW)).resolves.toHaveLength(1);
    expect(
      errorSpy.mock.calls.some((c) =>
        String(c[0]).includes("addon invariant: no alert recipients configured"),
      ),
    ).toBe(true);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("any ADDON_INVARIANT_EMAIL value other than `email` is `log`", async () => {
    process.env.ADDON_INVARIANT_EMAIL = "yes";
    process.env.PLATFORM_ALERT_EMAILS = "ops@example.test";
    const m = make({ rows: [inactive()] });
    await m.job.run(NOW);
    expect(m.send).not.toHaveBeenCalled();
  });
});

describe("scope, paging, cap and registry", () => {
  it("B-R4: reads PRODUCTION, not-deleted tenants only, one rows query and one events query per page", async () => {
    const m = make({ rows: [] });
    await m.job.run(NOW);
    expect(m.prisma.tenant.findMany.mock.calls[0][0].where).toMatchObject({
      class: "PRODUCTION",
      deletedAt: null,
    });
    expect(m.prisma.tenantAddon.findMany).toHaveBeenCalledTimes(1);
    expect(m.prisma.billingEvent.findMany).toHaveBeenCalledTimes(1);
    expect(m.prisma.billingEvent.findMany.mock.calls[0][0].where.type).toBe("addon.state_changed");
  });

  it("walks every page of 200 tenants", async () => {
    const full = Array.from({ length: 200 }, (_, i) => tenant({ id: `t${i}`, slug: `s${i}` }));
    const m = make({ pages: [full, [tenant({ id: "tz", slug: "z" })]] });
    await m.job.run(NOW);
    expect(m.prisma.tenant.findMany).toHaveBeenCalledTimes(2);
    expect(m.prisma.tenant.findMany.mock.calls[1][0].where.id).toEqual({ gt: "t199" });
  });

  it("past the cap the rest are not claimed and one notice says the run was truncated", async () => {
    const tenants = Array.from({ length: ADDON_INVARIANT_MAX_FINDINGS_PER_RUN + 5 }, (_, i) =>
      tenant({ id: `t${i}`, slug: `s${i}` }),
    );
    const rows = tenants.map((t, i) => row({ id: `ta${i}`, tenantId: t.id, active: false }));
    const m = make({ pages: [tenants], rows });
    const found = await m.job.run(NOW);

    expect(found).toHaveLength(ADDON_INVARIANT_MAX_FINDINGS_PER_RUN);
    const truncated = m.prisma.auditLog.create.mock.calls
      .map((c: any[]) => c[0].data)
      .filter((d: any) => d.meta?.truncated);
    expect(truncated).toHaveLength(1);
    expect(truncated[0].tenantId).toBeNull();
  });

  it("the registry is one array of checks I1..I3 (a new invariant is one entry)", () => {
    expect(ADDON_INVARIANTS.map((c) => c.id)).toEqual(["I1", "I2", "I3"]);
  });
});
