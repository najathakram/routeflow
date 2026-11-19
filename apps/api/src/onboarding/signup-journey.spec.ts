import { ACCOUNT_ADMIN_WHERE, accountAdminsOf } from "../billing/account-admins";
import { AUTOMATED_WRITE_STATUSES } from "../tenant/tenant-automation";
import {
  JOURNEY_BATCH,
  JOURNEY_GATE_CLOSED,
  JOURNEY_OFF_KEY,
  JOURNEY_STOP_LINKS,
  JOURNEY_WELCOME_KEY,
  JOURNEY_WELCOME_MILESTONE,
  JOURNEY_WINDOW_DAYS,
  eligibleTenantWhere,
  journeyWindowStart,
} from "./signup-journey";

const DAY = 24 * 60 * 60 * 1000;
// Every instant below is derived from this one `now`, never from the real clock (L-353).
const NOW = new Date(Date.UTC(2026, 10, 20, 12, 0, 0));

describe("signup journey constants", () => {
  it("names the welcome claim and the stop marker exactly", () => {
    expect(JOURNEY_WELCOME_MILESTONE).toBe("onboarding.welcome");
    expect(JOURNEY_WELCOME_KEY).toBe("");
    expect(JOURNEY_OFF_KEY).toBe("signup.journeyOff");
    expect(JOURNEY_WINDOW_DAYS).toBe(30);
    expect(JOURNEY_BATCH).toBe(200);
    expect(typeof JOURNEY_STOP_LINKS).toBe("string");
  });

  it("the closed gate is a frozen constant that sends nothing", () => {
    expect(JOURNEY_GATE_CLOSED).toEqual({ welcome: false, since: null });
    expect(Object.isFrozen(JOURNEY_GATE_CLOSED)).toBe(true);
  });
});

describe("ACCOUNT_ADMIN_WHERE (W9): the one admin definition", () => {
  it("is ACTIVE, not deleted, TENANT_ADMIN, with a non-empty email", () => {
    expect(ACCOUNT_ADMIN_WHERE).toEqual({
      role: "TENANT_ADMIN",
      status: "ACTIVE",
      deletedAt: null,
      email: { not: "" },
    });
  });
});

describe("journeyWindowStart", () => {
  it("is the later of since and now - 30 days", () => {
    const recent = new Date(NOW.getTime() - 2 * DAY);
    const old = new Date(NOW.getTime() - 90 * DAY);
    expect(journeyWindowStart(NOW, recent)).toEqual(recent);
    expect(journeyWindowStart(NOW, old)).toEqual(new Date(NOW.getTime() - 30 * DAY));
  });
});

describe("eligibleTenantWhere (W10, W11 first half, W9)", () => {
  const since = new Date(NOW.getTime() - 3 * DAY);
  const where = eligibleTenantWhere(NOW, since);

  it("is exactly this shape", () => {
    expect(where).toEqual({
      deletedAt: null,
      class: "PRODUCTION",
      createdAt: { gte: since },
      AND: [
        { systemConfigs: { some: { key: "signup.firstRun" } } },
        { systemConfigs: { none: { key: "signup.journeyOff" } } },
        { users: { some: ACCOUNT_ADMIN_WHERE } },
        { billingNotificationLogs: { none: { milestone: "onboarding.welcome" } } },
        { status: { in: [...AUTOMATED_WRITE_STATUSES] } },
        { OR: [{ status: { not: "TRIAL" } }, { trialEndsAt: { gt: NOW } }] },
        { OR: [{ onboardingCase: { is: null } }, { onboardingCase: { is: { status: "LOST" } } }] },
      ],
    });
  });

  it("the admin clause is the exported object itself, not a retyped copy", () => {
    const clause = (where.AND as any[]).find((c) => c.users);
    expect(clause.users.some).toBe(ACCOUNT_ADMIN_WHERE);
  });

  it("the window never reaches back more than 30 days, whatever since says", () => {
    const wide = eligibleTenantWhere(NOW, new Date(NOW.getTime() - 400 * DAY));
    expect(wide.createdAt).toEqual({ gte: new Date(NOW.getTime() - 30 * DAY) });
  });

  it("holds the welcome exclusion so finished tenants never fill the batch", () => {
    expect(JSON.stringify(where)).toContain('"milestone":"onboarding.welcome"');
  });
});

describe("accountAdminsOf keeps one definition with the journey (W9)", () => {
  it("asks the database for exactly ACCOUNT_ADMIN_WHERE plus the tenant (the email rule lives in the where)", async () => {
    // The database drops an empty email now, so the mocked rows carry none; that proof is the T8 DB row and the
    // stripe-customer-email "drops a row with no email" case (SA-1165 A1 B3a).
    const findMany = jest.fn().mockResolvedValue([{ email: "a@acme.test", username: "A" }]);
    const out = await accountAdminsOf({ user: { findMany } } as never, "t1");
    expect(findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", ...ACCOUNT_ADMIN_WHERE });
    expect(out).toEqual([{ email: "a@acme.test", username: "A" }]);
  });
});
