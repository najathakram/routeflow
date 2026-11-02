import { readFileSync } from "fs";
import { join } from "path";
import {
  closedTenantRefusal,
  isClosedTenantState,
  proveClosedTenant,
  tenantClassAllowsPurge,
} from "./closed-tenant-proof";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const daysAgo = (d: number, ms = 0) => new Date(NOW.getTime() - d * 86_400_000 + ms);

const PROVABLE = {
  slug: "acme",
  class: "PRODUCTION",
  status: "CANCELLED",
  readOnlyReason: null as string | null,
  closedAt: daysAgo(40) as Date | null,
  retentionHoldAt: null as Date | null,
  purgeApprovedAt: daysAgo(1) as Date | null,
  purgeNoticeAt: daysAgo(35) as Date | null,
  copyRequestOpenAt: null as Date | null,
};

describe("SA-1083: tenantClassAllowsPurge", () => {
  it.each([
    ["PRODUCTION", "acme", true],
    ["PRODUCTION", "qa-retention-1", true],
    ["TEST", "qa-retention-1", true],
    ["DEMO", "qa-retention-1", false],
    ["INTERNAL", "qa-retention-1", false],
    ["DEMO", "acme", false],
    ["INTERNAL", "acme", false],
    ["TEST", "acme", false],
    ["PRODUCTION", "test", false],
    ["PRODUCTION", "e2e-routeflow", false],
    ["PRODUCTION", "routeflow-demo", false],
    ["TEST", "test", false],
    ["PRODUCTION", "e2e-throwaway", false],
    ["PRODUCTION", "ux-audit-1", false],
  ])("%s %s -> %s", (cls, slug, allowed) => {
    expect(tenantClassAllowsPurge({ class: cls, slug })).toBe(allowed);
  });
});

describe("SA-1083: closedTenantRefusal", () => {
  it("a tenant that meets every condition isn't refused, and neither does the read-only closed state", () => {
    expect(closedTenantRefusal(PROVABLE, NOW)).toBeNull();
    expect(
      closedTenantRefusal(
        { ...PROVABLE, status: "READ_ONLY", readOnlyReason: "subscription_cancelled" },
        NOW,
      ),
    ).toBeNull();
  });

  it.each([
    ["active", { status: "ACTIVE" }, "NOT_CLOSED"],
    ["expired trial", { status: "READ_ONLY", readOnlyReason: "trial_expired" }, "NOT_CLOSED"],
    ["suspended", { status: "SUSPENDED" }, "NOT_CLOSED"],
    ["no date", { closedAt: null }, "NO_CLOSED_DATE"],
    ["day 29", { closedAt: daysAgo(29) }, "CLOSED_TOO_RECENTLY"],
    ["1 ms short of day 30", { closedAt: daysAgo(30, 1) }, "CLOSED_TOO_RECENTLY"],
    ["hold", { retentionHoldAt: daysAgo(1) }, "ON_HOLD"],
    ["open copy request", { copyRequestOpenAt: daysAgo(1) }, "COPY_REQUEST_OPEN"],
    ["no notice", { purgeNoticeAt: null }, "NO_NOTICE"],
    ["notice from before the closing", { purgeNoticeAt: daysAgo(41) }, "NOTICE_BEFORE_CLOSING"],
    ["notice 29 days old", { purgeNoticeAt: daysAgo(29) }, "NOTICE_TOO_RECENT"],
    ["no approval", { purgeApprovedAt: null }, "NO_APPROVAL"],
    [
      "approval older than the closing",
      { purgeApprovedAt: daysAgo(41) },
      "APPROVAL_BEFORE_CLOSING",
    ],
    ["approval at the closing", { purgeApprovedAt: daysAgo(40) }, "APPROVAL_BEFORE_CLOSING"],
    ["demo", { class: "DEMO" }, "TENANT_CLASS_REFUSED"],
    ["internal", { class: "INTERNAL" }, "TENANT_CLASS_REFUSED"],
    ["standing test tenant", { slug: "test" }, "TENANT_CLASS_REFUSED"],
  ])("%s is refused", (_name, change, reason) => {
    expect(closedTenantRefusal({ ...PROVABLE, ...change }, NOW)).toBe(reason);
  });

  it("day 30 exactly, and a notice 30 days old exactly, aren't refused", () => {
    expect(
      closedTenantRefusal({ ...PROVABLE, closedAt: daysAgo(30), purgeNoticeAt: daysAgo(30) }, NOW),
    ).toBeNull();
  });
});

describe("SA-1083: the proof", () => {
  it("an empty tenant id throws before anything is read", async () => {
    const tx = { $queryRaw: jest.fn() };
    await expect(
      proveClosedTenant(tx as never, undefined as never, NOW, { stripeSubId: null }),
    ).rejects.toThrow(/needs a tenant id/);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("the trigger names the same closed reason as isClosedTenantState", () => {
    const sql = readFileSync(
      join(__dirname, "../../prisma/migrations/20261102130000_tenant_closed_clock/migration.sql"),
      "utf8",
    );
    expect(sql).toContain(`NEW."readOnlyReason" IS NOT DISTINCT FROM 'subscription_cancelled'`);
    expect(
      isClosedTenantState({ status: "READ_ONLY", readOnlyReason: "subscription_cancelled" }),
    ).toBe(true);
  });
});
