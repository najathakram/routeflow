/**
 * SA-733r7 PR-B3 fold (Opus review of 00801c8b3, BLOCKER 1): the interleaving that stranded a tenant.
 *
 *   invoice.paid reads the row (tenant still ACTIVE, clock set)  ->  the sweep's pause COMMITS  ->  invoice.paid's
 *   resume decision. The old code decided "not paused" from the pre-lock read, lost its CAS, and then wiped the
 *   clock: READ_ONLY(payment_overdue) with NO clock and an unmatched -MRR row.
 *
 * This is a DETERMINISTIC test, not a Promise.all hope: a stateful in-memory fake of the Tenant / TenantSubscription
 * rows and the ledger, plus a hook that commits the racing pause exactly between the webhook's first read and its
 * transaction. (dunning.db.spec.ts keeps a Promise.all smoke test against real Postgres.)
 */
import { DunningService } from "./dunning.service";
import { pauseTenantTx, setPauseCollection } from "./dunning-pause";

interface State {
  status: string;
  reason: string | null;
  clock: string | null;
  since: Date | null;
  pausedAt: Date | null;
  ledger: number[];
}

function world(initial: Partial<State> = {}) {
  const st: State = {
    status: "ACTIVE",
    reason: null,
    clock: "in_1",
    since: new Date("2026-11-01T00:00:00Z"),
    pausedAt: null,
    ledger: [],
    ...initial,
  };
  const stripeCalls: any[] = [];
  const hooks: { beforeFirstTx?: () => Promise<void> } = {};
  let inHook = false;
  let txCount = 0;

  const tx: any = {
    $queryRaw: async () => [],
    tenant: {
      findUnique: async () => ({ status: st.status, readOnlyReason: st.reason }),
    },
    tenantSubscription: {
      findUnique: async () => ({
        pastDueInvoiceId: st.clock,
        pausedAt: st.pausedAt,
        stripeSubId: "sub_1",
      }),
      updateMany: async ({ where, data }: any) => {
        // the pause CAS
        if ("pausedAt" in (where ?? {}) && where.pausedAt === null) {
          if (st.pausedAt !== null || st.clock !== where.pastDueInvoiceId) return { count: 0 };
          st.pausedAt = data.pausedAt;
          return { count: 1 };
        }
        // the marker clear (only the CAS-loser path may write this)
        if (data && "pastDueInvoiceId" in data && data.pastDueInvoiceId === null) {
          if (st.clock !== where.pastDueInvoiceId) return { count: 0 };
          st.clock = null;
          st.since = null;
          st.pausedAt = null;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  };
  const prisma: any = {
    getTenantId: () => null,
    tenantSubscription: {
      // invoice.paid's FIRST read: taken before the racing pause, so it sees an ACTIVE tenant with a live clock
      findFirst: async () => ({
        tenantId: "t1",
        stripeSubId: "sub_1",
        externalPayment: false,
        catchupState: null,
        pastDueSince: st.since,
        pastDueInvoiceId: "in_1",
        pausedAt: null,
        tenant: { status: "ACTIVE", readOnlyReason: null, deletedAt: null, class: "PRODUCTION" },
      }),
      findUnique: async () => ({ pausedAt: st.pausedAt }),
    },
    tenantConfig: { findUnique: async () => ({ timezone: "UTC" }) },
    $transaction: async (fn: any) => {
      txCount++;
      if (txCount === 1 && hooks.beforeFirstTx && !inHook) {
        inHook = true;
        await hooks.beforeFirstTx();
        inHook = false;
      }
      return fn(tx);
    },
  };
  // the status writer: what BillingService.transitionAndEmit does to the row + ledger, in the caller's tx
  const transition = async (
    _t: string,
    where: any,
    to: string,
    dir: number,
    _e: string,
    _p: unknown,
    opts: any,
  ) => {
    if (where.status !== undefined && where.status !== st.status) return false;
    if (where.readOnlyReason !== undefined && where.readOnlyReason !== st.reason) return false;
    if (to === "READ_ONLY") {
      st.status = "READ_ONLY";
      st.reason = opts?.data?.readOnlyReason ?? null;
    } else {
      const exitAt = new Date("2026-11-09T12:00:00Z");
      const wasPaused = st.pausedAt !== null;
      st.status = "ACTIVE";
      st.reason = null;
      st.clock = null;
      st.since = null;
      st.pausedAt = null;
      opts?.onExit?.(wasPaused ? { tenantId: "t1", stripeSubId: "sub_1", exitAt } : null);
    }
    st.ledger.push(dir);
    return true;
  };
  const stripe: any = {
    isConfigured: true,
    getInvoiceFacts: async () => ({
      status: "open",
      amountPaid: 0,
      amountDue: 4900,
      amountRemaining: 4900,
      paymentProcessing: false,
      nextPaymentAttempt: null,
      attemptCount: 2,
      subscriptionId: "sub_1",
    }),
    listOpenSubscriptionInvoices: async () => [],
    getSubscription: async () => ({ status: "active" }),
    updateSubscription: async (...a: any[]) => {
      stripeCalls.push(a);
      return {};
    },
  };
  const notifications: any = {
    notifyDunning: async () => ({ status: "sent", recipients: 1 }),
    recordDunningMilestone: async () => true,
    localDateLabel: async () => "Nov 9, 2026",
  };
  const svc = new DunningService(prisma, stripe, notifications, {
    invalidate: () => undefined,
  } as any);
  svc.bindTransition(transition as any);
  const PAUSED_AT = new Date("2026-11-08T09:00:00Z");
  const deps = {
    prisma,
    stripe,
    notifications,
    logger: console as any,
    transition: transition as any,
    mode: () => "enforced" as const,
    once: () => true,
    cursors: new Map<string, string>(),
  };
  const pause = () => pauseTenantTx(deps, { tenantId: "t1" }, "in_1", PAUSED_AT);
  return { st, svc, hooks, stripeCalls, pause, prisma, deps, PAUSED_AT };
}

const invoice = {
  id: "in_1",
  customer: "cus_1",
  parent: { subscription_details: { subscription: "sub_1" } },
};

describe("sweep racing invoice.paid (deterministic interleavings)", () => {
  const saved = process.env.BILLING_PAUSE_MODE;
  beforeEach(() => {
    process.env.BILLING_PAUSE_MODE = "enforced";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BILLING_PAUSE_MODE;
    else process.env.BILLING_PAUSE_MODE = saved;
  });

  it("the pause commits BETWEEN invoice.paid's read and its transaction: the tenant is RESUMED, ledger -1 then +1, pause_collection cleared", async () => {
    const w = world();
    let paused = false;
    w.hooks.beforeFirstTx = async () => {
      paused = await w.pause();
    };

    const out = await w.svc.onInvoicePaid(invoice, new Date("2026-11-09T12:00:00Z"));

    expect(paused).toBe(true); // the racing pause really did commit first
    expect(out).toBe("resumed");
    // THE regression: never READ_ONLY(payment_overdue) with no clock
    expect(w.st.status).toBe("ACTIVE");
    expect(w.st.reason).toBeNull();
    expect(w.st.clock).toBeNull();
    expect(w.st.pausedAt).toBeNull();
    // -MRR once, +MRR once: the ledger nets to zero
    expect(w.st.ledger).toEqual([-1, 1]);
    // the pause's Stripe pause_collection is cleared after the resume commits
    expect(w.stripeCalls).toEqual([
      [
        "sub_1",
        { pause_collection: "" },
        { idempotencyKey: "t1:unpause:2026-11-09T12:00:00.000Z" },
      ],
    ]);
  });

  it("invoice.paid wins the lock first: the sweep's pause CAS finds no clock and pauses NOTHING", async () => {
    const w = world();
    const out = await w.svc.onInvoicePaid(invoice, new Date("2026-11-09T12:00:00Z"));
    expect(out).toBe("cleared"); // ACTIVE tenant: just the marker clears
    expect(await w.pause()).toBe(false);
    expect(w.st.status).toBe("ACTIVE");
    expect(w.st.ledger).toEqual([]);
    expect(w.stripeCalls).toEqual([]);
  });

  describe("after-commit ordering: the sweep's pause_collection SET against a resume that commits in between", () => {
    const target = { tenantId: "t1", stripeSubId: "sub_1" };
    const resumeAt = new Date("2026-11-09T12:00:00Z");

    it("pause commits -> invoice.paid resumes and clears pause_collection -> the sweep's late set is SKIPPED (Stripe is not left paused while local is ACTIVE)", async () => {
      const w = world();
      expect(await w.pause()).toBe(true);
      expect(await w.svc.onInvoicePaid(invoice, resumeAt)).toBe("resumed");
      expect(w.st.status).toBe("ACTIVE");
      expect(w.st.pausedAt).toBeNull();

      const set = await setPauseCollection(w.deps, target, w.PAUSED_AT);

      expect(set).toBe(false);
      // the ONLY Stripe call is the resume's unpause: the stale set never lands last
      expect(w.stripeCalls).toHaveLength(1);
      expect(w.stripeCalls[0][1]).toEqual({ pause_collection: "" });
    });

    it("no resume in between: the set runs (under the Tenant lock, key unchanged) and Stripe is paused", async () => {
      const w = world();
      await w.pause();
      expect(await setPauseCollection(w.deps, target, w.PAUSED_AT)).toBe(true);
      expect(w.stripeCalls).toEqual([
        [
          "sub_1",
          { pause_collection: { behavior: "void" } },
          { idempotencyKey: `t1:pause:${w.PAUSED_AT.toISOString()}` },
        ],
      ]);
    });

    it("a different (later) pause is not overwritten by an earlier sweep's set", async () => {
      const w = world();
      await w.pause();
      w.st.pausedAt = new Date(w.PAUSED_AT.getTime() + 3_600_000); // paused again since
      expect(await setPauseCollection(w.deps, target, w.PAUSED_AT)).toBe(false);
      expect(w.stripeCalls).toEqual([]);
    });

    it("a Stripe error in the set is reported false and never throws (the reconciler corrects it)", async () => {
      const w = world();
      await w.pause();
      w.deps.stripe.updateSubscription = async () => {
        throw new Error("stripe down");
      };
      await expect(setPauseCollection(w.deps, target, w.PAUSED_AT)).resolves.toBe(false);
    });
  });
});
