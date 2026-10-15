// SA-736r: the single coupon-column writer and the Stripe sync. A small STATEFUL fake stands in for the
// transaction client, so the specs assert END state (columns + ledger sum), not call shapes. Stripe is
// mocked at the StripeService boundary: no live call exists anywhere here.
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  applyCouponState,
  applyCouponStateTx,
  resetCouponState,
  syncCouponFromStripe,
} from "./coupon-state";
import { NO_COUPON } from "./coupon-unbilled";

interface Row {
  couponFull: boolean;
  couponId: string | null;
  couponEndsAt: Date | null;
  couponSyncedAt: Date | null;
  stripeSubId: string | null;
  externalPayment: boolean;
  planKey: string | null;
  basePriceSnapshot: number | null;
  discount: number | null;
}

function harness(
  over: Partial<Row> = {},
  tenant: Record<string, unknown> = {},
  addons: Array<{
    priceSnapshot: number | null;
    quantity: number;
    sku?: string;
    addonKey?: string;
    stripeItemId?: string | null;
  }> = [],
) {
  const row: Row = {
    couponFull: false,
    couponId: null,
    couponEndsAt: null,
    couponSyncedAt: null,
    stripeSubId: "sub_acme",
    externalPayment: false,
    planKey: "STARTER",
    basePriceSnapshot: 99,
    discount: 0,
    ...over,
  };
  const t = { status: "ACTIVE", class: "PRODUCTION", deletedAt: null, ...tenant };
  const ledger: Array<{ type: string; amountDelta: number }> = [];
  const order: string[] = [];
  const notices: any[] = [];
  const matches = (where: any): boolean => {
    if ("couponFull" in where && where.couponFull !== row.couponFull) return false;
    if (where.OR) {
      const ok = where.OR.some((c: any) =>
        "couponSyncedAt" in c && c.couponSyncedAt === null
          ? row.couponSyncedAt === null
          : row.couponSyncedAt !== null &&
            row.couponSyncedAt.getTime() < c.couponSyncedAt.lt.getTime(),
      );
      if (!ok) return false;
    }
    return true;
  };
  const tx: any = {
    tenantSubscription: {
      findUnique: jest.fn(async ({ select }: any) => {
        order.push("tx.read");
        const out: any = { ...row };
        if (select?.tenant) out.tenant = { ...t };
        return out;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!matches(where)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    tenantAddon: { findMany: jest.fn(async () => addons) },
    auditLog: {
      create: jest.fn(async ({ data }: any) => {
        notices.push(data);
        return {};
      }),
    },
    $queryRaw: jest.fn(async () => {
      order.push("tenant.lock");
      return [];
    }),
  };
  const prisma: any = {
    $transaction: jest.fn(async (fn: any) => {
      order.push("tx.open");
      return fn(tx);
    }),
    tenantSubscription: {
      findUnique: jest.fn(async () => ({
        stripeSubId: row.stripeSubId,
        externalPayment: row.externalPayment,
      })),
    },
  };
  const events: any = {
    emit: jest.fn(async (_tenantId: string, type: string, _payload: unknown, opts: any) => {
      ledger.push({ type, amountDelta: opts.amountDelta });
    }),
  };
  return { row, tx, prisma, events, ledger, order, notices };
}

const sum = (ledger: Array<{ amountDelta: number }>) =>
  Math.round(ledger.reduce((s, e) => s + e.amountDelta, 0) * 100) / 100;

describe("applyCouponState: the ledger crossing (M1)", () => {
  it("entry books -X once (X = base + billable add-ons - discount); a replay adds nothing", async () => {
    const h = harness({ basePriceSnapshot: 99, discount: 9 }, {}, [
      { priceSnapshot: 20, quantity: 2 },
    ]);
    const full = { full: true, couponId: "cp_pilot", endsAt: null };
    const a = await applyCouponState(h, "t1", full, { reason: "test", syncedAt: new Date(1000) });
    expect(a).toMatchObject({ applied: true, amountDelta: -130 });
    expect(h.row).toMatchObject({ couponFull: true, couponId: "cp_pilot" });
    expect(h.ledger).toEqual([{ type: "coupon.unbilled", amountDelta: -130 }]);

    const replay = await applyCouponState(h, "t1", full, {
      reason: "test",
      syncedAt: new Date(2000),
    });
    expect(replay.amountDelta).toBe(0);
    expect(h.ledger).toHaveLength(1);
  });

  it("entry -> exit round trip: -X then +X, ledger sum 0 (so mrr == ledgerMrr)", async () => {
    const h = harness({ basePriceSnapshot: 99 }, {}, [{ priceSnapshot: 20, quantity: 1 }]);
    await applyCouponState(
      h,
      "t1",
      { full: true, couponId: "cp", endsAt: null },
      { reason: "in", syncedAt: new Date(1000) },
    );
    await applyCouponState(h, "t1", NO_COUPON, { reason: "out", syncedAt: new Date(2000) });
    expect(h.ledger.map((e) => e.amountDelta)).toEqual([-119, 119]);
    expect(h.ledger.map((e) => e.type)).toEqual(["coupon.unbilled", "coupon.billed"]);
    expect(sum(h.ledger)).toBe(0);
    expect(h.row.couponFull).toBe(false);
  });

  it("a coupon added while SUSPENDED books 0 (not paying on either side)", async () => {
    const h = harness({}, { status: "SUSPENDED" }, []);
    const r = await applyCouponState(
      h,
      "t1",
      { full: true, couponId: "cp", endsAt: null },
      { reason: "x", syncedAt: new Date(1) },
    );
    expect(r).toMatchObject({ applied: true, amountDelta: 0 });
    expect(h.row.couponFull).toBe(true);
    expect(h.ledger).toEqual([]);
  });

  it("A: SUSPENDED + couponFull, the coupon ends, then the tenant is ACTIVE again: the exit books exactly +X", async () => {
    // reinstatement (transitionAndEmit) read couponFull=true and booked 0; the sync that follows books +X.
    const h = harness({ couponFull: true, basePriceSnapshot: 99 }, { status: "ACTIVE" }, []);
    const r = await applyCouponState(h, "t1", NO_COUPON, {
      reason: "payment_succeeded",
      syncedAt: new Date(5),
    });
    expect(r.amountDelta).toBe(99);
    expect(sum(h.ledger)).toBe(99);
  });

  it("a planKey-less row is not paying: nothing is booked on either side", async () => {
    const h = harness({ planKey: null });
    const r = await applyCouponState(
      h,
      "t1",
      { full: true, couponId: null, endsAt: null },
      { reason: "x", syncedAt: new Date(1) },
    );
    expect(r.amountDelta).toBe(0);
    expect(h.ledger).toEqual([]);
  });

  it("a zero contribution books no event", async () => {
    const h = harness({ basePriceSnapshot: 0 });
    await applyCouponState(
      h,
      "t1",
      { full: true, couponId: null, endsAt: null },
      { reason: "x", syncedAt: new Date(1) },
    );
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("bookDelta:false writes the columns and books nothing (the caller books its own crossing)", async () => {
    const h = harness({ couponFull: true });
    await applyCouponState(h, "t1", NO_COUPON, { reason: "manual_activation", bookDelta: false });
    expect(h.row.couponFull).toBe(false);
    expect(h.events.emit).not.toHaveBeenCalled();
  });
});

describe("applyCouponState: a coupon that ENDS never auto-bills the add-ons that rode it (B1079)", () => {
  const FULL = { full: true, couponId: "cp", endsAt: null };
  const rows = [
    { priceSnapshot: 0, quantity: 2, sku: "PACK_A", stripeItemId: null },
    { priceSnapshot: 0, quantity: 1, sku: "PACK_B", stripeItemId: null },
    { priceSnapshot: 20, quantity: 1, sku: "PACK_C", stripeItemId: "si_c" },
  ];

  it("the exit writes ONE platform notice naming the unbilled rows (counts and skus), and bills nothing", async () => {
    const h = harness({ couponFull: true }, {}, rows);
    await applyCouponState(h, "t1", NO_COUPON, { reason: "sync", syncedAt: new Date(2000) });
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({
      tenantId: "t1",
      action: "ADDON_COUPON_ENDED_UNBILLED",
      meta: { unbilledRows: 2, skus: ["PACK_A", "PACK_B"], reason: "sync" },
    });
    expect(String(h.notices[0].meta.message)).toMatch(/NOT billed automatically/);
  });

  it("no notice when every add-on row already has a Stripe item, or on the way IN", async () => {
    const billed = harness({ couponFull: true }, {}, [rows[2]]);
    await applyCouponState(billed, "t1", NO_COUPON, { reason: "sync", syncedAt: new Date(2000) });
    expect(billed.notices).toHaveLength(0);

    const entering = harness({ couponFull: false }, {}, rows);
    await applyCouponState(entering, "t1", FULL, { reason: "sync", syncedAt: new Date(1000) });
    expect(entering.notices).toHaveLength(0);
  });

  it("a replay of the exit (no flip) writes no second notice", async () => {
    const h = harness({ couponFull: true }, {}, rows);
    await applyCouponState(h, "t1", NO_COUPON, { reason: "sync", syncedAt: new Date(2000) });
    await applyCouponState(h, "t1", NO_COUPON, { reason: "sync", syncedAt: new Date(3000) });
    expect(h.notices).toHaveLength(1);
  });

  it("a manual payer or a row with no Stripe subscription is never noticed", async () => {
    const manual = harness({ couponFull: true, externalPayment: true }, {}, rows);
    await applyCouponState(manual, "t1", NO_COUPON, { reason: "sync", syncedAt: new Date(2000) });
    expect(manual.notices).toHaveLength(0);
    const noSub = harness({ couponFull: true, stripeSubId: null }, {}, rows);
    await applyCouponState(noSub, "t1", NO_COUPON, { reason: "sync", syncedAt: new Date(2000) });
    expect(noSub.notices).toHaveLength(0);
  });
});

describe("applyCouponState: ordering and lost updates (F3, F4)", () => {
  it("the wrapper takes the Tenant lock FIRST, inside its own tx; the Tx form opens no transaction", async () => {
    const h = harness();
    await applyCouponState(h, "t1", NO_COUPON, { reason: "x", syncedAt: new Date(1) });
    expect(h.order.slice(0, 3)).toEqual(["tx.open", "tenant.lock", "tx.read"]);

    const g = harness();
    await applyCouponStateTx(g.tx, g.events, "t1", NO_COUPON, {
      reason: "x",
      tenantLockHeld: true,
    });
    expect(g.prisma.$transaction).not.toHaveBeenCalled();
    expect(g.order).not.toContain("tx.open");
  });

  it("F4: an older read that commits later is a no-op (stored couponSyncedAt is newer)", async () => {
    const h = harness();
    const newer = await applyCouponState(h, "t1", NO_COUPON, {
      reason: "event 2",
      syncedAt: new Date(2000),
    });
    expect(newer.applied).toBe(true);
    const older = await applyCouponState(
      h,
      "t1",
      { full: true, couponId: "cp", endsAt: null },
      { reason: "event 1", syncedAt: new Date(1000) },
    );
    expect(older).toMatchObject({ applied: false, stale: true });
    expect(h.row.couponFull).toBe(false);
    expect(h.row.couponSyncedAt).toEqual(new Date(2000));
    expect(h.ledger).toEqual([]);
  });

  it("F4: the CAS itself refuses a write when couponSyncedAt moved between the read and the write", async () => {
    const h = harness();
    const real = h.tx.tenantSubscription.updateMany;
    h.tx.tenantSubscription.updateMany = jest.fn(async (args: any) => {
      h.row.couponSyncedAt = new Date(9000); // a concurrent writer lands in between
      return real(args);
    });
    const r = await applyCouponStateTx(
      h.tx,
      h.events,
      "t1",
      { full: true, couponId: null, endsAt: null },
      { reason: "x", syncedAt: new Date(1000), tenantLockHeld: true },
    );
    expect(r.stale).toBe(true);
    expect(h.row.couponFull).toBe(false);
  });

  it("a reset stamps 'now', so a Stripe read that STARTED before it cannot resurrect the coupon", async () => {
    const h = harness({ couponFull: true });
    const t0 = new Date(Date.now() - 60_000); // a retrieve that began a minute ago
    await resetCouponState(h, "t1", "stripe_subscription_deleted");
    expect(h.row).toMatchObject({ couponFull: false, couponId: null, couponEndsAt: null });
    const late = await applyCouponState(
      h,
      "t1",
      { full: true, couponId: "cp", endsAt: null },
      { reason: "late", syncedAt: t0 },
    );
    expect(late.stale).toBe(true);
    expect(h.row.couponFull).toBe(false);
  });

  it("a sync for a replaced Stripe subscription is a no-op (onlyStripeSubId)", async () => {
    const h = harness({ stripeSubId: "sub_new" });
    const r = await applyCouponState(
      h,
      "t1",
      { full: true, couponId: null, endsAt: null },
      { reason: "x", syncedAt: new Date(1), onlyStripeSubId: "sub_old" },
    );
    expect(r.stale).toBe(true);
    expect(h.row.couponFull).toBe(false);
  });

  it("no subscription row: nothing happens", async () => {
    const h = harness();
    h.tx.tenantSubscription.findUnique.mockResolvedValue(null);
    expect(await applyCouponState(h, "t1", NO_COUPON, { reason: "x" })).toMatchObject({
      applied: false,
      stale: false,
    });
  });
});

describe("syncCouponFromStripe (M3, F1, M5)", () => {
  const fullPreview = {
    lines: {
      has_more: false,
      data: [
        {
          amount: 9900,
          discount_amounts: [{ amount: 9900 }],
          parent: {
            type: "subscription_item_details",
            subscription_item_details: { proration: false },
          },
        },
      ],
    },
    total_discount_amounts: [{ amount: 9900 }],
  };
  const stripeFor = (
    h: ReturnType<typeof harness>,
    preview: any = fullPreview,
    sub: any = { status: "active", discounts: [{ source: { coupon: "cp_pilot" }, end: null }] },
  ) => ({
    retrieveSubscriptionWithDiscounts: jest.fn(async () => {
      h.order.push("stripe.retrieve");
      return sub;
    }),
    previewNextInvoice: jest.fn(async () => {
      h.order.push("stripe.preview");
      return preview;
    }),
  });

  it("retrieves + previews BEFORE and OUTSIDE any transaction, then writes through the single writer", async () => {
    const h = harness();
    const stripe = stripeFor(h);
    const out = await syncCouponFromStripe(
      { ...h, stripe },
      "t1",
      "sub_acme",
      "subscription_updated",
    );
    expect(out).toEqual({ outcome: "applied", full: true, amountDelta: -99 });
    expect(h.order.slice(0, 3)).toEqual(["stripe.retrieve", "stripe.preview", "tx.open"]);
    expect(h.row).toMatchObject({ couponFull: true, couponId: "cp_pilot" });
    expect(stripe.retrieveSubscriptionWithDiscounts).toHaveBeenCalledWith("sub_acme");
  });

  it("a failing retrieve or preview THROWS and writes nothing (the ledger records an error; Stripe retries)", async () => {
    const h = harness();
    const bad = stripeFor(h);
    bad.retrieveSubscriptionWithDiscounts.mockRejectedValue(new Error("Stripe timeout"));
    await expect(
      syncCouponFromStripe({ ...h, stripe: bad }, "t1", "sub_acme", "x"),
    ).rejects.toThrow("Stripe timeout");
    const bad2 = stripeFor(h);
    bad2.previewNextInvoice.mockRejectedValue(new Error("rate limited"));
    await expect(
      syncCouponFromStripe({ ...h, stripe: bad2 }, "t1", "sub_acme", "x"),
    ).rejects.toThrow("rate limited");
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.row.couponFull).toBe(false);
  });

  it("no upcoming invoice (preview null): the stored value is kept and nothing is written", async () => {
    const h = harness({ couponFull: true });
    const out = await syncCouponFromStripe(
      { ...h, stripe: stripeFor(h, null) },
      "t1",
      "sub_acme",
      "x",
    );
    expect(out).toEqual({ outcome: "skipped", why: "no_upcoming_invoice" });
    expect(h.row.couponFull).toBe(true);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("a canceled subscription is not synced (the cancel path resets)", async () => {
    const h = harness({ couponFull: true });
    const out = await syncCouponFromStripe(
      { ...h, stripe: stripeFor(h, fullPreview, { status: "canceled", discounts: [] }) },
      "t1",
      "sub_acme",
      "x",
    );
    expect(out).toEqual({ outcome: "skipped", why: "ended" });
    expect(h.row.couponFull).toBe(true);
  });

  it("M5: externalPayment forces full = false - no Stripe call at all; a manual payer is billed by RF invoices", async () => {
    const h = harness({ externalPayment: true, couponFull: true });
    const stripe = stripeFor(h);
    const out = await syncCouponFromStripe({ ...h, stripe }, "t1", "sub_acme", "x");
    expect(out).toMatchObject({ outcome: "applied", full: false });
    expect(h.row.couponFull).toBe(false);
    expect(stripe.retrieveSubscriptionWithDiscounts).not.toHaveBeenCalled();
    expect(stripe.previewNextInvoice).not.toHaveBeenCalled();
  });

  it("M5 race: a sync that read externalPayment=false, then the admin switched to manual billing: the in-tx re-read forces full=false (no -X booked)", async () => {
    const h = harness({ externalPayment: false });
    const stripe = stripeFor(h);
    // the pre-tx read (syncCouponFromStripe) says card-billed; the admin activation commits right after it
    stripe.retrieveSubscriptionWithDiscounts.mockImplementation(async () => {
      h.row.externalPayment = true;
      return { status: "active", discounts: [{ source: { coupon: "cp_pilot" }, end: null }] };
    });
    const out = await syncCouponFromStripe({ ...h, stripe }, "t1", "sub_acme", "x");
    expect(out).toMatchObject({ outcome: "applied" });
    expect(h.row.couponFull).toBe(false);
    expect(h.ledger).toEqual([]);
  });

  it("M5: applyCouponState itself never writes full=true onto an externalPayment row (the writer, not the caller, enforces it)", async () => {
    const h = harness({ externalPayment: true, couponFull: false });
    const r = await applyCouponState(
      h,
      "t1",
      { full: true, couponId: "cp", endsAt: null },
      { reason: "x", syncedAt: new Date(1) },
    );
    expect(r).toMatchObject({ applied: true, amountDelta: 0 });
    expect(h.row.couponFull).toBe(false);
    expect(h.ledger).toEqual([]);
  });

  it("a replaced subscription id or a missing row is skipped before any Stripe call", async () => {
    const h = harness({ stripeSubId: "sub_new" });
    const stripe = stripeFor(h);
    expect(await syncCouponFromStripe({ ...h, stripe }, "t1", "sub_old", "x")).toEqual({
      outcome: "skipped",
      why: "sub_changed",
    });
    h.prisma.tenantSubscription.findUnique.mockResolvedValue(null);
    expect(await syncCouponFromStripe({ ...h, stripe }, "t1", "sub_new", "x")).toEqual({
      outcome: "skipped",
      why: "no_row",
    });
    expect(stripe.retrieveSubscriptionWithDiscounts).not.toHaveBeenCalled();
  });

  it("a stale result (an older read) reports 'stale', not 'applied'", async () => {
    const h = harness({ couponSyncedAt: new Date(Date.now() + 60_000) });
    const out = await syncCouponFromStripe({ ...h, stripe: stripeFor(h) }, "t1", "sub_acme", "x");
    expect(out).toEqual({ outcome: "stale" });
  });
});

/**
 * The one-writer scanner (L-223). Walks a source's braces keeping a stack of the key/variable each `{` hangs
 * off, and reports every mention of a coupon column that sits where it could WRITE:
 *   - couponId / couponEndsAt / couponSyncedAt: ANY mention (they are read nowhere outside the writer);
 *   - couponFull: only a `select` / `where` / `include` key, a `...Where` constant or a type annotation is fine -
 *     inside `data` / `create` / `update` / `set` / `upsert`, or anywhere else, it is a violation.
 */
export function findCouponColumnWrites(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const found: string[] = [];
  const stack: string[] = [];
  const readOnlyKeys = new Set(["select", "where", "include", "orderBy"]);
  const writeKeys = new Set(["data", "create", "update", "set", "upsert"]);
  const re = /\{|\}|\bcoupon(Full|Id|EndsAt|SyncedAt)\b(\s*:)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[0] === "{") {
      const before = code.slice(Math.max(0, m.index - 80), m.index);
      stack.push(/([A-Za-z_$][\w$]*)\s*(?::|=|\(|=>)\s*$/.exec(before)?.[1] ?? "");
    } else if (m[0] === "}") {
      stack.pop();
    } else {
      const line = code.slice(0, m.index).split("\n").length;
      const col = m[1];
      const hasColon = !!m[2];
      const readOnly = stack.some((k) => readOnlyKeys.has(k) || /Where$/.test(k));
      const typeAnnotation =
        col === "Full" && hasColon && /^\s*boolean\b/.test(code.slice(m.index + m[0].length));
      const writeCtx = stack.some((k) => writeKeys.has(k));
      if (col !== "Full") found.push(`line ${line}: coupon${col}`);
      else if (writeCtx) found.push(`line ${line}: couponFull in a write object`);
      else if (hasColon && !readOnly && !typeAnnotation) {
        found.push(`line ${line}: couponFull outside select/where`);
      }
    }
  }
  return found;
}

/** Raw SQL that writes a coupon column of TenantSubscription. */
export function findCouponRawSqlWrites(source: string): boolean {
  return (
    /UPDATE\s+"?TenantSubscription"?[\s\S]{0,600}?\bcoupon(Full|Id|EndsAt|SyncedAt)/i.test(
      source,
    ) ||
    /INSERT\s+INTO\s+"?TenantSubscription"?[\s\S]{0,600}?\bcoupon(Full|Id|EndsAt|SyncedAt)/i.test(
      source,
    )
  );
}

describe("structural pin: ONE writer of the coupon columns (L-223)", () => {
  const apiRoot = join(__dirname, "..", "..");
  const files: string[] = [];
  const walk = (dir: string, exts: string[]) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", "dist", "migrations", ".next"].includes(e.name)) continue;
        walk(full, exts);
      } else if (exts.some((x) => e.name.endsWith(x)) && !/\.spec\.ts$/.test(e.name)) {
        files.push(full);
      }
    }
  };
  walk(join(apiRoot, "src"), [".ts"]);
  walk(join(apiRoot, "scripts"), [".ts", ".mjs", ".cjs", ".js"]);
  walk(join(apiRoot, "prisma"), [".ts", ".mjs", ".cjs", ".js", ".sql"]);
  const rel = (f: string) => f.slice(apiRoot.length).replace(/\\/g, "/");
  // The writer itself; coupon-unbilled.ts only DEFINES the CouponState type and parses Stripe objects.
  // The backfill script is exempt from the READ scan only: it selects the columns and calls the compiled
  // writer; backfill-coupon-state-script.spec.ts pins that it never builds a write object or runs SQL.
  const exempt = (f: string) =>
    /\/billing\/coupon-(state|unbilled)\.ts$/.test(rel(f)) ||
    rel(f) === "/scripts/backfill-coupon-state.mjs";

  it("self-test: planted violations are caught, legitimate reads are not", () => {
    const bad = [
      "await tx.tenantSubscription.update({ where: { tenantId }, data: { couponFull: false } });",
      "await tx.tenantSubscription.updateMany({ where: { tenantId }, data: { couponId: null } });",
      "await prisma.tenantSubscription.create({ data: { tenantId, couponFull: true } });",
      "await prisma.tenantSubscription.upsert({ where, update: { couponFull: true }, create: { tenantId } });",
      "const x = { set: { couponEndsAt: d } };",
      "const row = { couponFull: true }; // escapes a data: wrapper",
    ];
    for (const src of bad)
      expect([src, findCouponColumnWrites(src).length > 0]).toEqual([src, true]);
    const good = [
      "findMany({ where: { couponFull: false }, select: { couponFull: true } })",
      "const payingWhere = { planKey: { not: null }, couponFull: false };",
      "sub: { couponFull: boolean; planKey: string }",
      "updateMany({ where: { tenantId, couponFull: priorSub.couponFull }, data: { planKey } })",
      "const ok = row.couponFull === true;",
    ];
    for (const src of good) expect([src, findCouponColumnWrites(src)]).toEqual([src, []]);
    expect(findCouponRawSqlWrites('UPDATE "TenantSubscription" SET "couponFull" = true')).toBe(
      true,
    );
    expect(
      findCouponRawSqlWrites(
        'INSERT INTO "TenantSubscription" ("tenantId","couponId") VALUES (1,2)',
      ),
    ).toBe(true);
    expect(findCouponRawSqlWrites('UPDATE "Tenant" SET "name" = 1')).toBe(false);
  });

  // Scripts that SELECT couponFull from TenantSubscription and carry it as a plain key of an in-memory
  // snapshot object (the live-target classifier's `{ planKey, stripeSubId, couponFull }` input, or the default
  // row of a tenant with no subscription). They never write the column: only the "couponFull outside
  // select/where" read-shape finding is waived for them - a write object, a coupon{Id,EndsAt,SyncedAt}
  // mention and raw SQL writes still fail for these files like any other (the raw-SQL test below has no waiver).
  const SNAPSHOT_READERS = new Set([
    "/scripts/backfill-b294-order-line-taxrate.mjs",
    "/scripts/backfill-b297-rate-snapshot.mjs",
    "/scripts/backfill-refund-tender.mjs",
    "/scripts/billing-correct-activation.mjs",
    "/scripts/lib/billing-catchup-core.cjs",
    "/scripts/lib/billing-correct-activation-core.cjs",
    "/scripts/lib/live-target-guard.cjs",
    "/scripts/labels-from-categories.mjs", // the protected-tenant classifier input (subOf)
  ]);

  it("src, scripts and prisma (migrations excluded) hold no coupon-column write outside the writer", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (exempt(f) || f.endsWith(".sql")) continue;
      for (const hit of findCouponColumnWrites(readFileSync(f, "utf8"))) {
        if (SNAPSHOT_READERS.has(rel(f)) && /couponFull outside select\/where/.test(hit)) continue;
        offenders.push(`${rel(f)}: ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the snapshot-reader waiver names files that exist (a rename cannot leave a stale waiver)", () => {
    for (const p of SNAPSHOT_READERS) expect(files.map(rel)).toContain(p);
  });

  it("no raw SQL writes the coupon columns anywhere (src, scripts, prisma outside migrations)", () => {
    const bad = files.filter((f) => !exempt(f) && findCouponRawSqlWrites(readFileSync(f, "utf8")));
    expect(bad.map(rel)).toEqual([]);
  });

  it("the walk covers all three roots (a moved directory cannot silently empty the pin)", () => {
    for (const root of ["src", "scripts", "prisma"]) {
      expect(files.some((f) => rel(f).startsWith(`/${root}/`))).toBe(true);
    }
  });
});
