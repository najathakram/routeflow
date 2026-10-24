import { AutoLockAdminService } from "./auto-lock-admin.service";

/**
 * Row 412: the unpause PREVIEW must not promise "locks within the hour" for a dunning tenant whose final notice is
 * stale (sent before the pause started): that tenant gets a FRESH final first and is locked 24 h after it. The
 * tenant stays in the list (the owner should still see it), under `via: "fresh_final_first"`.
 */

const H = 3_600_000;
const SINCE = new Date("2026-11-01T00:00:00Z");
const NOW = new Date("2026-11-20T09:00:00Z");
const EP = `in_1:${SINCE.toISOString()}`;
const at = (h: number) => new Date(SINCE.getTime() + h * H);

function make(
  state: { paused: boolean; unpausedAt: Date | null },
  claims: { tenantId: string; key: string; sentAt: Date }[],
) {
  const prisma: any = {
    tenant: { findMany: jest.fn().mockResolvedValue([]) },
    tenantSubscription: {
      findMany: jest.fn(async (args: any) =>
        args?.where?.pastDueInvoiceId
          ? [{ tenantId: "t1", pastDueInvoiceId: "in_1", pastDueSince: SINCE }]
          : [],
      ),
    },
    billingNotificationLog: {
      findMany: jest.fn(async () => claims.map((c) => ({ ...c, milestone: "DUNNING_FINAL" }))),
    },
  };
  const switchSvc: any = {
    getState: jest.fn().mockResolvedValue({
      paused: state.paused,
      since: null,
      reason: null,
      by: null,
      unpausedAt: state.unpausedAt,
    }),
  };
  return new AutoLockAdminService(prisma, switchSvc);
}

describe("AutoLockAdminService.wouldLockNow: dunning tenants with a stale final (row 412)", () => {
  const saved = process.env.BILLING_PAUSE_MODE;
  beforeEach(() => {
    process.env.BILLING_PAUSE_MODE = "enforced";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BILLING_PAUSE_MODE;
    else process.env.BILLING_PAUSE_MODE = saved;
  });

  const dunning = (rows: any[]) => rows.filter((r) => r.kind === "payment_overdue");

  it("paused now: an unpause would start a new boundary, so ANY earlier final is stale -> fresh_final_first", async () => {
    const svc = make({ paused: true, unpausedAt: null }, [
      { tenantId: "t1", key: EP, sentAt: at(150) },
    ]);
    expect(dunning(await svc.wouldLockNow(NOW))).toEqual([
      { tenantId: "t1", kind: "payment_overdue", key: "in_1", via: "fresh_final_first" },
    ]);
  });

  it("unpaused, final older than the last unpause -> fresh_final_first", async () => {
    const svc = make({ paused: false, unpausedAt: at(270) }, [
      { tenantId: "t1", key: EP, sentAt: at(150) },
    ]);
    expect(dunning(await svc.wouldLockNow(NOW))[0].via).toBe("fresh_final_first");
  });

  it("unpaused, final at/after the last unpause -> a plain lock (no via)", async () => {
    const svc = make({ paused: false, unpausedAt: at(140) }, [
      { tenantId: "t1", key: EP, sentAt: at(150) },
    ]);
    expect(dunning(await svc.wouldLockNow(NOW))).toEqual([
      { tenantId: "t1", kind: "payment_overdue", key: "in_1" },
    ]);
  });

  it("unpaused, a final re-issued after the last unpause is honoured -> a plain lock", async () => {
    const svc = make({ paused: false, unpausedAt: at(270) }, [
      { tenantId: "t1", key: EP, sentAt: at(150) },
      { tenantId: "t1", key: `${EP}:u${at(270).toISOString()}`, sentAt: at(271) },
    ]);
    expect(dunning(await svc.wouldLockNow(NOW))[0]).not.toHaveProperty("via");
  });

  it("a tenant that never had a final is unchanged (no via), paused or not", async () => {
    for (const st of [
      { paused: true, unpausedAt: null },
      { paused: false, unpausedAt: at(270) },
    ]) {
      const svc = make(st, []);
      expect(dunning(await svc.wouldLockNow(NOW))[0]).not.toHaveProperty("via");
    }
  });

  it("another episode's final (a different clock) is not this tenant's final", async () => {
    const other = `in_1:${new Date("2026-09-01T00:00:00Z").toISOString()}`;
    const svc = make({ paused: true, unpausedAt: null }, [
      { tenantId: "t1", key: other, sentAt: at(150) },
    ]);
    expect(dunning(await svc.wouldLockNow(NOW))[0]).not.toHaveProperty("via");
  });
});
