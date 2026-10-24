import { HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { BillingWebhookController } from "./billing-webhook.controller";
import { DB_NOW_UTC } from "../common/webhook-ledger-claim";

const T_INSERT = new Date("2026-09-28T05:00:00.000Z");
const T_CLAIM = new Date("2026-09-28T05:07:00.000Z");
const rawOf = (m: jest.Mock, verb: string) =>
  (m.mock.calls as any[]).map((c) => c[0] as Prisma.Sql).find((q) => q.sql.trim().startsWith(verb));

// B593 review F1: a handler failure must not masquerade as a signature failure.
function build(
  opts: {
    construct?: () => unknown;
    handle?: () => Promise<void>;
    /** #2442: the ledger insert (default: a first delivery). */
    create?: () => Promise<unknown>;
    /** #2442: the already-ledgered row a duplicate insert finds. */
    existing?: { outcome: string | null } | null;
    /** #2476: rows the redelivery claim (one raw UPDATE) takes — 1 = claimed. */
    claimed?: number;
  } = {},
) {
  const stripe = {
    isConfigured: true,
    constructWebhookEvent: jest.fn(
      opts.construct ?? (() => ({ type: "checkout.session.completed", id: "evt_1" })),
    ),
  };
  const billing = { handleWebhookEvent: jest.fn(opts.handle ?? (async () => undefined)) };
  // #2476: the ledger insert and the claim are raw SQL (common/webhook-ledger-claim.ts). `create` keeps
  // its #2442 meaning — it models the INSERT: resolve = inserted, reject P2002 = a redelivery (ON
  // CONFLICT DO NOTHING returns no row), any other rejection = an insert failure.
  const create = jest.fn(opts.create ?? (async () => ({})));
  const $queryRaw = jest.fn(async (q: Prisma.Sql) => {
    const sql = q.sql.trim();
    if (/^INSERT/i.test(sql)) {
      try {
        await create();
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return [];
        throw e;
      }
      return [{ processedAt: T_INSERT }];
    }
    if (/^UPDATE/i.test(sql)) return (opts.claimed ?? 1) === 1 ? [{ processedAt: T_CLAIM }] : [];
    if (/^SELECT/i.test(sql)) return opts.existing ? [{ outcome: opts.existing.outcome }] : [];
    return [];
  });
  const prisma = {
    $queryRaw,
    stripeBillingEvent: {
      create,
      update: jest.fn(async () => ({})),
      // #2476: the fenced outcome write — 1 = this delivery still held its claim.
      updateMany: jest.fn(async (_arg?: unknown) => ({ count: 1 })),
    },
  };
  const controller = new BillingWebhookController(
    stripe as never,
    billing as never,
    prisma as never,
  );
  const json = jest.fn();
  const res = { status: jest.fn().mockReturnValue({ json }) };
  const req = { headers: { "stripe-signature": "sig" }, rawBody: Buffer.from("{}") };
  return { controller, stripe, billing, prisma, res, json, req };
}

describe("BillingWebhookController — signature vs handler failures", () => {
  it("a good event is handled and acknowledged with 200", async () => {
    const { controller, billing, res, json, req } = build();

    await controller.handleWebhook(req as never, res as never);

    expect(billing.handleWebhookEvent).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(json).toHaveBeenCalledWith({ received: true });
  });

  it("a bad signature is a 400 and the handler is never invoked", async () => {
    const { controller, billing, res, json, req } = build({
      construct: () => {
        throw new Error("No signatures found matching the expected signature");
      },
    });

    await controller.handleWebhook(req as never, res as never);

    expect(billing.handleWebhookEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith({ error: "Webhook signature verification failed" });
  });

  it("a HANDLER failure is a 500 (Stripe redelivers), never the 'signature verification failed' 400", async () => {
    const { controller, res, json, req } = build({
      handle: async () => {
        throw new Error("Transaction already closed");
      },
    });

    await controller.handleWebhook(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(res.status).not.toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith({ error: "Webhook handler failed" });
  });
});

// #2442: the billing webhook mirrors the Connect webhook — Stripe, not a browser, is the caller
// (@SkipThrottle), and an insert-first event ledger makes a redelivery of a COMPLETED event a no-op
// (closing #2440's residual: a redelivered invoice.payment_failed incremented failedPaymentCount
// twice). A delivery whose first attempt errored or never finished is re-run — that is the retry
// our own 500 asked for.
describe("#2442 BillingWebhookController — throttle skip and event-id ledger", () => {
  const dup = () =>
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
  const failedEvt = () => ({
    type: "invoice.payment_failed",
    id: "evt_pf",
    created: 1_700_000_000,
  });

  it("is exempt from the per-IP throttler", () => {
    expect(Reflect.getMetadata("THROTTLER:SKIPdefault", BillingWebhookController)).toBe(true);
  });

  it("ledgers the event id BEFORE the handler runs", async () => {
    const { controller, billing, prisma, req, res } = build({ construct: failedEvt });
    await controller.handleWebhook(req as never, res as never);
    const insert = rawOf(prisma.$queryRaw, "INSERT");
    expect(insert?.sql).toMatch(/INSERT INTO "StripeBillingEvent"/);
    expect(insert?.values).toEqual(
      expect.arrayContaining(["evt_pf", "invoice.payment_failed", "2023-11-14T22:13:20.000Z"]),
    );
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      billing.handleWebhookEvent.mock.invocationCallOrder[0],
    );
  });

  it("a redelivered, already-COMPLETED invoice.payment_failed is a no-op (200, handler not run)", async () => {
    const { controller, billing, res, json, req } = build({
      construct: failedEvt,
      create: async () => {
        throw dup();
      },
      existing: { outcome: "processed" },
      claimed: 0, // #2476: a completed row is never claimable
    });
    await controller.handleWebhook(req as never, res as never);
    expect(billing.handleWebhookEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(json).toHaveBeenCalledWith({ received: true });
  });

  it("R1 option B: invoice.upcoming rides the same ledger - ledgered before the handler, and a redelivery of a COMPLETED one never re-runs it", async () => {
    const upcoming = () => ({ type: "invoice.upcoming", id: "evt_up", created: 1_700_000_000 });
    const first = build({ construct: upcoming });
    await first.controller.handleWebhook(first.req as never, first.res as never);
    expect(rawOf(first.prisma.$queryRaw, "INSERT")?.values).toEqual(
      expect.arrayContaining(["evt_up", "invoice.upcoming"]),
    );
    expect(first.billing.handleWebhookEvent).toHaveBeenCalledTimes(1);

    const replay = build({
      construct: upcoming,
      create: async () => {
        throw dup();
      },
      existing: { outcome: "processed" },
      claimed: 0,
    });
    await replay.controller.handleWebhook(replay.req as never, replay.res as never);
    expect(replay.billing.handleWebhookEvent).not.toHaveBeenCalled();
    expect(replay.res.status).toHaveBeenCalledWith(HttpStatus.OK);
  });

  it.each([
    ["an error outcome", { outcome: "error:boom" }],
    ["no outcome (the first attempt never finished)", { outcome: null }],
  ])("a redelivery after %s is re-run", async (_label, existing) => {
    const { controller, billing, res, req } = build({
      construct: failedEvt,
      create: async () => {
        throw dup();
      },
      existing,
    });
    await controller.handleWebhook(req as never, res as never);
    expect(billing.handleWebhookEvent).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
  });

  it("a ledger insert failure (not a duplicate) is a 500 and the handler never runs", async () => {
    const { controller, billing, res, req } = build({
      create: async () => {
        throw new Error("connection reset");
      },
    });
    await controller.handleWebhook(req as never, res as never);
    expect(billing.handleWebhookEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it("records outcome 'processed' on success", async () => {
    const { controller, prisma, req, res } = build({ construct: failedEvt });
    await controller.handleWebhook(req as never, res as never);
    expect(prisma.stripeBillingEvent.updateMany).toHaveBeenCalledWith({
      where: { id: "evt_pf", outcome: null, processedAt: T_INSERT },
      data: { outcome: "processed" },
    });
  });

  it("records an 'error:' outcome on a handler failure, so Stripe's redelivery re-runs it", async () => {
    const { controller, prisma, req, res } = build({
      construct: failedEvt,
      handle: async () => {
        throw new Error("db down");
      },
    });
    await controller.handleWebhook(req as never, res as never);
    expect(prisma.stripeBillingEvent.updateMany).toHaveBeenCalledWith({
      where: { id: "evt_pf", outcome: null, processedAt: T_INSERT },
      data: { outcome: "error:db down" },
    });
    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it("a failed outcome write never changes the response already sent", async () => {
    const { controller, prisma, res, req } = build({ construct: failedEvt });
    prisma.stripeBillingEvent.updateMany.mockRejectedValue(new Error("db blip"));
    await expect(controller.handleWebhook(req as never, res as never)).resolves.toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
  });
});

// #2476 / SA-472: a redelivery (P2002) claims the ledger row EXCLUSIVELY with one updateMany — an
// "error:" row at once, a NULL (in-flight) row only once its lease (5 min, processedAt) has expired.
// Count 0 ⇒ re-read: completed ⇒ 200 duplicate; still in flight elsewhere ⇒ 503 (a 2xx would ack an
// event another worker may still fail). The outcome write in finally is LOGGED on failure.
describe("#2476 BillingWebhookController — exclusive claim on redelivery (SA-472)", () => {
  const LEASE_MS = 5 * 60 * 1000;
  const dup = () =>
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
  const evt = () => ({ type: "invoice.payment_failed", id: "evt_pf", created: 1_700_000_000 });

  it("claims with ONE raw UPDATE: an error: row, or a NULL row older than the 5-minute lease", async () => {
    const { controller, prisma, req, res } = build({
      construct: evt,
      create: async () => {
        throw dup();
      },
    });
    await controller.handleWebhook(req as never, res as never);
    const q = rawOf(prisma.$queryRaw, "UPDATE");
    expect(q?.sql).toMatch(/UPDATE "StripeBillingEvent"/);
    expect(q?.sql).toMatch(/"outcome" LIKE 'error:%'/);
    expect(q?.sql).toMatch(/"outcome" IS NULL AND "processedAt" </);
    expect(q?.sql).toMatch(/RETURNING "processedAt"/);
    expect(q?.values).toEqual(["evt_pf", `${LEASE_MS} milliseconds`]);
  });

  it("claimed (count 1) ⇒ the handler runs", async () => {
    const { controller, billing, req, res } = build({
      construct: evt,
      create: async () => {
        throw dup();
      },
      claimed: 1,
    });
    await controller.handleWebhook(req as never, res as never);
    expect(billing.handleWebhookEvent).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
  });

  it("not claimed and completed ⇒ 200 duplicate, handler not run", async () => {
    const { controller, billing, req, res, json } = build({
      construct: evt,
      create: async () => {
        throw dup();
      },
      claimed: 0,
      existing: { outcome: "processed" },
    });
    await controller.handleWebhook(req as never, res as never);
    expect(billing.handleWebhookEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(json).toHaveBeenCalledWith({ received: true });
  });

  it("not claimed and still in flight elsewhere (NULL inside the lease) ⇒ 503, handler not run", async () => {
    const { controller, billing, req, res, json } = build({
      construct: evt,
      create: async () => {
        throw dup();
      },
      claimed: 0,
      existing: { outcome: null },
    });
    await controller.handleWebhook(req as never, res as never);
    expect(billing.handleWebhookEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(json).toHaveBeenCalledWith({ error: "Webhook event in progress" });
  });

  it("an outcome-write failure is LOGGED (never swallowed) and never changes the response", async () => {
    const { controller, prisma, req, res } = build({ construct: evt });
    prisma.stripeBillingEvent.updateMany.mockRejectedValue(new Error("db blip"));
    const err = jest.spyOn((controller as any).logger, "error").mockImplementation(() => undefined);
    await controller.handleWebhook(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(err.mock.calls.some((c: any[]) => /outcome/i.test(String(c[0])))).toBe(true);
  });
});

// #2476 lead verdict "must" list (2026-09-28): the claim and the lease run on the DATABASE clock (one
// standalone UPDATE, no app-clock Date), and the final outcome write lands only while this delivery
// still holds its claim (fenced on outcome NULL + its own processedAt token). Written to hold whether
// the insert stays a Prisma create or becomes raw SQL (that choice is with the SA).
describe("#2476 BillingWebhookController — DB-clock claim and fenced outcome write", () => {
  const T_INS = new Date("2026-09-28T06:00:00.000Z");
  const T_CLAIM = new Date("2026-09-28T06:10:00.000Z");
  const dup = () =>
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
  const evt = () => ({ type: "invoice.payment_failed", id: "evt_pf", created: 1_700_000_000 });

  function buildDb(
    opts: {
      redelivery?: boolean;
      claimed?: boolean;
      current?: string | null;
      outcomeCount?: number;
      claimThrows?: boolean;
    } = {},
  ) {
    const b = build({
      construct: evt,
      create: async () => {
        if (opts.redelivery) throw dup();
        return { id: "evt_pf", processedAt: T_INS, outcome: null };
      },
      existing: { outcome: opts.current ?? null },
      claimed: opts.claimed ? 1 : 0,
    });
    const $queryRaw = jest.fn(async (q: Prisma.Sql) => {
      const s = q.sql.trim();
      if (/^INSERT/i.test(s)) return opts.redelivery ? [] : [{ processedAt: T_INS }];
      if (/^UPDATE/i.test(s)) {
        if (opts.claimThrows) throw new Error("connection reset");
        return opts.claimed ? [{ processedAt: T_CLAIM }] : [];
      }
      if (/^SELECT/i.test(s)) return [{ outcome: opts.current ?? null }];
      return [];
    });
    (b.prisma as any).$queryRaw = $queryRaw;
    b.prisma.stripeBillingEvent.updateMany.mockImplementation(async (arg: any) =>
      arg?.data && "processedAt" in arg.data
        ? { count: opts.claimed ? 1 : 0 }
        : { count: opts.outcomeCount ?? 1 },
    );
    return { ...b, $queryRaw };
  }

  const claimSql = (m: jest.Mock) =>
    (m.mock.calls as any[]).map((c) => c[0] as Prisma.Sql).find((q) => /^\s*UPDATE/i.test(q.sql));

  it("the redelivery claim is ONE raw UPDATE on the DB clock — no app-clock Date is bound", async () => {
    const { controller, prisma, $queryRaw, req, res } = buildDb({
      redelivery: true,
      claimed: true,
    });
    await controller.handleWebhook(req as never, res as never);
    const q = claimSql($queryRaw);
    expect(q).toBeDefined();
    expect(q!.sql).toMatch(/CURRENT_TIMESTAMP/);
    expect(q!.values.some((v) => v instanceof Date)).toBe(false);
    const appClockClaim = (prisma.stripeBillingEvent.updateMany.mock.calls as any[]).some(
      (c) => c[0]?.data && "processedAt" in c[0].data,
    );
    expect(appClockClaim).toBe(false);
  });

  it("a first delivery writes its outcome fenced on its own claim token (outcome NULL + processedAt)", async () => {
    const { controller, prisma, req, res } = buildDb();
    await controller.handleWebhook(req as never, res as never);
    expect(prisma.stripeBillingEvent.update).not.toHaveBeenCalled();
    expect(prisma.stripeBillingEvent.updateMany).toHaveBeenCalledWith({
      where: { id: "evt_pf", outcome: null, processedAt: T_INS },
      data: { outcome: "processed" },
    });
  });

  it("a claimed redelivery writes its outcome fenced on the CLAIM's token", async () => {
    const { controller, prisma, req, res } = buildDb({ redelivery: true, claimed: true });
    await controller.handleWebhook(req as never, res as never);
    expect(prisma.stripeBillingEvent.updateMany).toHaveBeenCalledWith({
      where: { id: "evt_pf", outcome: null, processedAt: T_CLAIM },
      data: { outcome: "processed" },
    });
  });

  it("a lost claim (the fenced write matches 0 rows) is LOGGED and never changes the response", async () => {
    const { controller, req, res } = buildDb({ outcomeCount: 0 });
    const err = jest.spyOn((controller as any).logger, "error").mockImplementation(() => undefined);
    await controller.handleWebhook(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(err.mock.calls.some((c: any[]) => /claim/i.test(String(c[0])))).toBe(true);
  });

  it("a claim query failure is a 500 and the handler never runs", async () => {
    const { controller, billing, req, res } = buildDb({ redelivery: true, claimThrows: true });
    await controller.handleWebhook(req as never, res as never);
    expect(billing.handleWebhookEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });
});

// SA-472b: ONE spelling of the database clock in all three places — the INSERT value, the claim SET
// and the lease compare — never a bare now() (timestamptz, cast by the session time zone).
describe("#2476 SA-472b — one DB-clock fragment", () => {
  it("the insert and the claim both use DB_NOW_UTC, and nothing spells now() any other way", async () => {
    const { controller, prisma, req, res } = build({
      construct: () => ({ type: "invoice.paid", id: "evt_tz", created: 1_700_000_000 }),
      create: async () => {
        throw new Prisma.PrismaClientKnownRequestError("dup", {
          code: "P2002",
          clientVersion: "t",
        });
      },
      existing: { outcome: "processed" },
    });
    await controller.handleWebhook(req as never, res as never);
    const insert = rawOf(prisma.$queryRaw, "INSERT")!.sql;
    const claim = rawOf(prisma.$queryRaw, "UPDATE")!.sql;
    const frag = DB_NOW_UTC.sql;
    expect(frag).toBe("(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')");
    expect(insert.split(frag).length - 1).toBe(1); // the processedAt value
    expect(claim.split(frag).length - 1).toBe(2); // the SET and the lease compare
    for (const q of [insert, claim]) {
      expect(q.replaceAll(frag, "").match(/now\(\)|CURRENT_TIMESTAMP|LOCALTIMESTAMP/gi)).toBeNull();
    }
  });
});
