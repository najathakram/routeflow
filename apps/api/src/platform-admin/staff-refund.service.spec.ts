import { readFileSync, readdirSync } from "fs";
import { join, relative, sep } from "path";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { latestYearlyPayment, type YearlyPaymentRecord } from "../billing/yearly-payment-record";
import { BILLING_EVENTS } from "../billing/plan-catalog.constants";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { strictFake } from "../testing/strict-fake";
import { AdminAuditAction, ADMIN_AUDIT_ACTION_LABELS } from "./audit-actions.constant";
import { StaffRefundDto } from "./dto/staff-refund.dto";
import { STAFF_REFUND_NOTICE_MESSAGE, StaffRefundService } from "./staff-refund.service";

// The reader is PR-4's (SA-1304); every spec here mocks it with a fixture row (SA-1297 ruling 2).
jest.mock("../billing/yearly-payment-record", () => ({ latestYearlyPayment: jest.fn() }));
const reader = latestYearlyPayment as jest.MockedFunction<typeof latestYearlyPayment>;

/**
 * R-2 (SA-1297): the service over a mocked reader and a strict in-memory fake of the transaction client (a model or
 * method the service touches that the fake lacks is recorded in `misses`, so a read of the subscription, an RfInvoice or
 * the provider would fail here by name, not pass on `undefined`). L-353: the clock is pinned and every date derives from it.
 * The race, MRR-unchanged, cross-tenant and pause rows against Postgres are in staff-refund.db.spec.ts.
 */
const NOW = new Date("2026-11-20T12:00:00.000Z");
const TENANT_A = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const TENANT_B = "7a1a2b3c-8b86-4011-b42d-00c04fc964aa";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const ADMIN_2 = "22222222-2222-4222-8222-222222222222";
const USERS = [
  { id: ADMIN, username: "pat.staff", email: "pat@example.test" },
  { id: ADMIN_2, username: "", email: "sam@example.test" },
];

const payment = (over: Partial<YearlyPaymentRecord> = {}): YearlyPaymentRecord => ({
  invoiceId: "in_acme_0002",
  amount: "1188.50",
  currency: "usd",
  paidAt: new Date("2026-11-10T08:00:00.000Z"), // deadline 2026-11-24T08:00Z
  periodStart: new Date("2026-11-10T08:00:00.000Z"),
  periodEnd: new Date("2027-11-10T08:00:00.000Z"),
  planKey: "GROWTH",
  ...over,
});

const body = (over: Partial<StaffRefundDto> = {}): StaffRefundDto => ({
  refundedInFull: true,
  cancelledImmediately: true,
  providerRef: "re_acme_001",
  refundDate: "2026-11-15",
  ...over,
});

interface Row {
  id: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  amountDelta: null;
  actorId: string | null;
  createdAt: Date;
}

function makeHarness() {
  const order: string[] = [];
  const misses: string[] = [];
  const store: Row[] = [];
  const audit: Array<{ data: Record<string, any> }> = [];
  const eventQueries: any[] = [];
  const events = {
    emit: jest.fn(
      async (tenantId: string, type: string, payload: any, opts?: { actorId?: string }) => {
        order.push("emit");
        const row: Row = {
          id: `ev-${store.length + 1}`,
          tenantId,
          type,
          payload,
          amountDelta: null,
          actorId: opts?.actorId ?? null,
          createdAt: new Date(),
        };
        store.push(row);
        return row;
      },
    ),
  };
  const billingEvent = {
    findFirst: jest.fn(async (args: any) => {
      order.push("dedupe");
      eventQueries.push(args);
      return (
        store.find(
          (r) =>
            r.tenantId === args.where.tenantId &&
            r.type === args.where.type &&
            r.payload.invoiceId === args.where.payload.equals,
        ) ?? null
      );
    }),
    findMany: jest.fn(async (args: any) => {
      eventQueries.push(args);
      return store
        .filter((r) => r.tenantId === args.where.tenantId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
        .slice(0, args.take);
    }),
  };
  const user = {
    findMany: jest.fn(async (args: any) => USERS.filter((u) => args.where.id.in.includes(u.id))),
  };
  const tx = strictFake(
    {
      $queryRaw: jest.fn(async () => {
        order.push("lock");
        return [];
      }),
      billingEvent,
      user,
      auditLog: {
        create: jest.fn(async (a: any) => {
          order.push("audit");
          audit.push(a);
        }),
      },
    },
    "tx",
    misses,
  );
  const prisma = strictFake(
    {
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => {
        order.push("tx-open");
        return fn(tx);
      }),
      billingEvent,
      user,
    },
    "prisma",
    misses,
  );
  const svc = new StaffRefundService(prisma as any, events as any);
  const readerAs = (records: Record<string, YearlyPaymentRecord | null>) =>
    reader.mockImplementation(async (db, tenantId) => {
      order.push(db === (tx as unknown) ? "read:tx" : "read:client");
      return records[tenantId] ?? null;
    });
  return {
    svc,
    tx,
    prisma,
    events,
    billingEvent,
    user,
    order,
    misses,
    store,
    audit,
    eventQueries,
    readerAs,
  };
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  reader.mockReset();
});
afterEach(() => {
  jest.useRealTimers();
});

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e: any) {
    return e;
  }
  throw new Error("expected a refusal");
};

describe("R-2 test 9: before PR-4 the reader returns null", () => {
  it("every route answers STAFF_REFUND_NO_YEARLY_PAYMENT (404): no BillingEvent and no AuditLog row", async () => {
    const h = makeHarness();
    h.readerAs({});
    const e = await refusal(h.svc.record(TENANT_A, body(), ADMIN));
    expect(e).toBeInstanceOf(NotFoundException);
    expect(e.getStatus()).toBe(404);
    expect(e.getResponse()).toMatchObject({ code: API_ERROR_CODES.STAFF_REFUND_NO_YEARLY_PAYMENT });
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.tx.auditLog.create).not.toHaveBeenCalled();
    expect(h.store).toHaveLength(0);
    expect(h.misses).toEqual([]);
  });

  it("the refundable read says so, with no payment, no deadline and no existing row", async () => {
    const h = makeHarness();
    h.readerAs({});
    await expect(h.svc.resolveRefundable(TENANT_A)).resolves.toEqual({
      payment: null,
      deadline: null,
      refusal: API_ERROR_CODES.STAFF_REFUND_NO_YEARLY_PAYMENT,
      existing: null,
    });
  });

  it("a payment that disappears between the unlocked read and the lock writes nothing", async () => {
    const h = makeHarness();
    reader
      .mockResolvedValueOnce(payment()) // the unlocked early read
      .mockResolvedValueOnce(null); // the read under the lock
    const e = await refusal(h.svc.record(TENANT_A, body(), ADMIN));
    expect(e.getResponse()).toMatchObject({ code: API_ERROR_CODES.STAFF_REFUND_NO_YEARLY_PAYMENT });
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("R-2 test 10: the reader is asked for the route's tenant only", () => {
  it("only tenant B has a yearly record; POST against tenant A is NO_YEARLY_PAYMENT and writes no row for B", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_B]: payment({ invoiceId: "in_acme_B" }) });
    const e = await refusal(h.svc.record(TENANT_A, body(), ADMIN));
    expect(e.getResponse()).toMatchObject({ code: API_ERROR_CODES.STAFF_REFUND_NO_YEARLY_PAYMENT });
    expect(h.store.filter((r) => r.tenantId === TENANT_B)).toEqual([]);
    expect(reader.mock.calls.length).toBeGreaterThan(0);
    for (const call of reader.mock.calls) expect(call[1]).toBe(TENANT_A);
  });
});

describe("R-2: a recorded refund (the happy path)", () => {
  it("writes ONE refund.staff row whose payload copies the record verbatim and carries the form's fields; the emit options are exactly { actorId, tx }", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: payment() });
    const row = await h.svc.record(TENANT_A, body({ note: "Customer asked on the phone" }), ADMIN);

    expect(h.events.emit).toHaveBeenCalledTimes(1);
    const [tenantId, type, payload, opts] = h.events.emit.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(tenantId).toBe(TENANT_A);
    expect(type).toBe("refund.staff");
    expect(payload).toEqual({
      invoiceId: "in_acme_0002",
      amount: "1188.50", // the record's string, copied, never recomputed
      currency: "usd",
      paidAt: "2026-11-10T08:00:00.000Z",
      refundDate: "2026-11-15",
      providerRef: "re_acme_001",
      refundedInFull: true,
      cancelledImmediately: true,
      note: "Customer asked on the phone",
    });
    expect(Object.keys(opts).sort()).toEqual(["actorId", "tx"]);
    expect(opts.actorId).toBe(ADMIN);
    expect(opts.tx).toBe(h.tx);
    expect(row).toMatchObject({ type: "refund.staff", amountDelta: null, tenantId: TENANT_A });
    expect(h.misses).toEqual([]);
  });

  it("no note is no key (an empty note is not stored)", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: payment() });
    await h.svc.record(TENANT_A, body({ note: "" }), ADMIN);
    expect(h.events.emit.mock.calls[0][2]).not.toHaveProperty("note");
  });

  it("L-301: the tenant lock is the first statement of the transaction; the payment, the dedupe, the emit and the notice follow it, all in the same tx", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: payment() });
    await h.svc.record(TENANT_A, body(), ADMIN);
    // the unlocked early read, then the transaction: lock FIRST, then the locked reads, then the writes
    expect(h.order).toEqual([
      "read:client",
      "tx-open",
      "lock",
      "read:tx",
      "dedupe",
      "emit",
      "audit",
    ]);
    expect(h.events.emit.mock.calls[0][3]).toMatchObject({ tx: h.tx });
  });
});

describe("R-2 test 16: the audit row", () => {
  it("one AuditLog row, action TENANT_STAFF_REFUND_RECORDED, the neutral line in meta.message, label present, ids only otherwise", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: payment() });
    await h.svc.record(TENANT_A, body({ note: "secret note stays out of the audit meta" }), ADMIN);
    expect(h.audit).toHaveLength(1);
    const { data } = h.audit[0];
    expect(data.action).toBe("TENANT_STAFF_REFUND_RECORDED");
    expect(data.action).toBe(AdminAuditAction.TENANT_STAFF_REFUND_RECORDED);
    expect(ADMIN_AUDIT_ACTION_LABELS.TENANT_STAFF_REFUND_RECORDED).toBe("Staff refund recorded");
    expect(data.tenantId).toBe(TENANT_A);
    expect(data.userId).toBe(ADMIN);
    expect(data.meta).toEqual({
      platformAdmin: true,
      message:
        "Recorded only; the subscription status here is unchanged until the provider's cancellation is processed.",
      invoiceId: "in_acme_0002",
      providerRef: "re_acme_001",
      refundDate: "2026-11-15",
    });
    expect(data.meta.message).toBe(STAFF_REFUND_NOTICE_MESSAGE);
  });
});

describe("R-2 test 11: double submit", () => {
  it("the second POST of the same body is 409 STAFF_REFUND_ALREADY_RECORDED with the existing date, reference and actor; exactly one row", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: payment() });
    await h.svc.record(TENANT_A, body(), ADMIN);
    const e = await refusal(h.svc.record(TENANT_A, body({ providerRef: "re_other" }), ADMIN_2));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toMatchObject({
      code: API_ERROR_CODES.STAFF_REFUND_ALREADY_RECORDED,
      refundDate: "2026-11-15",
      providerRef: "re_acme_001",
      actorName: "pat.staff",
    });
    expect(e.getResponse().createdAt).toEqual(NOW);
    expect(h.store.filter((r) => r.type === "refund.staff")).toHaveLength(1);
    expect(h.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(h.events.emit).toHaveBeenCalledTimes(1);
  });

  it("the dedupe filter is the tenant, the type and the payment's invoiceId (a second year is a second payment, so a new row)", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: payment({ invoiceId: "in_acme_year1" }) });
    await h.svc.record(TENANT_A, body(), ADMIN);
    const where = h.billingEvent.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({
      tenantId: TENANT_A,
      type: "refund.staff",
      payload: { path: ["invoiceId"], equals: "in_acme_year1" },
    });
    // the next yearly payment supersedes it: recording its refund is a new row, not a 409
    h.readerAs({
      [TENANT_A]: payment({
        invoiceId: "in_acme_year2",
        paidAt: new Date("2026-11-12T08:00:00.000Z"),
      }),
    });
    await h.svc.record(TENANT_A, body({ providerRef: "re_acme_002" }), ADMIN);
    expect(h.store.map((r) => r.payload.invoiceId)).toEqual(["in_acme_year1", "in_acme_year2"]);
  });

  it("the refundable read shows the existing row so the button turns into the muted line", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: payment() });
    await h.svc.record(TENANT_A, body(), ADMIN);
    const view = await h.svc.resolveRefundable(TENANT_A);
    expect(view.refusal).toBe(API_ERROR_CODES.STAFF_REFUND_ALREADY_RECORDED);
    expect(view.existing).toEqual({
      createdAt: NOW,
      providerRef: "re_acme_001",
      actorName: "pat.staff",
      refundDate: "2026-11-15",
    });
    expect(view.payment).toMatchObject({ invoiceId: "in_acme_0002", amount: "1188.50" });
  });

  it("an actor with no username shows the email", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: payment() });
    await h.svc.record(TENANT_A, body(), ADMIN_2);
    expect((await h.svc.resolveRefundable(TENANT_A)).existing?.actorName).toBe("sam@example.test");
  });
});

describe("R-2: the refundable read", () => {
  it("an eligible payment: the record's figures, the deadline paidAt + 14 x 24h, no refusal", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: payment() });
    await expect(h.svc.resolveRefundable(TENANT_A)).resolves.toEqual({
      payment: {
        invoiceId: "in_acme_0002",
        amount: "1188.50",
        currency: "usd",
        paidAt: new Date("2026-11-10T08:00:00.000Z"),
      },
      deadline: new Date("2026-11-24T08:00:00.000Z"),
      refusal: null,
      existing: null,
    });
    expect(h.order).not.toContain("lock"); // a read, no lock
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("past the deadline it is still eligible (the button stays active; the dialog states the window's end)", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: payment({ paidAt: new Date("2026-10-01T00:00:00.000Z") }) });
    const view = await h.svc.resolveRefundable(TENANT_A);
    expect(view.refusal).toBeNull();
    expect(view.deadline).toEqual(new Date("2026-10-15T00:00:00.000Z"));
  });
});

describe("R-2 tests 1-5 through the service: the window and the range", () => {
  it("test 1 through the service: the refund day that starts exactly at paidAt + 14 x 24h is recorded", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: payment({ paidAt: new Date("2026-11-01T00:00:00.000Z") }) });
    await h.svc.record(TENANT_A, body({ refundDate: "2026-11-15" }), ADMIN);
    expect(h.store).toHaveLength(1);
  });

  it("test 2 through the service: one ms past the boundary is 409 STAFF_REFUND_WINDOW_PASSED, nothing written", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: payment({ paidAt: new Date("2026-10-31T23:59:59.999Z") }) });
    const e = await refusal(h.svc.record(TENANT_A, body({ refundDate: "2026-11-15" }), ADMIN));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({ code: API_ERROR_CODES.STAFF_REFUND_WINDOW_PASSED });
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("test 3 through the service: recorded after the deadline for a refund day inside the window", async () => {
    const h = makeHarness();
    // paid 10 days before NOW is fine; here paid 15+ days before NOW and the refund day is paidAt + 13d
    h.readerAs({ [TENANT_A]: payment({ paidAt: new Date("2026-11-04T09:30:00.000Z") }) });
    await h.svc.record(TENANT_A, body({ refundDate: "2026-11-17" }), ADMIN);
    expect(h.store).toHaveLength(1);
  });

  it.each([
    ["the paid UTC day minus one", "2026-11-09"],
    ["UTC tomorrow", "2026-11-21"],
  ])("test 5: %s is a plain 400 with the ruled text, no code, nothing written", async (_n, day) => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: payment() });
    const e = await refusal(h.svc.record(TENANT_A, body({ refundDate: day }), ADMIN));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.getStatus()).toBe(400);
    expect(e.getResponse()).toMatchObject({
      message: "Choose a refund date between the payment date and today.",
    });
    expect(e.getResponse()).not.toHaveProperty("code");
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("the date is checked again UNDER the lock: a newer payment that lands between the early read and the lock decides", async () => {
    const h = makeHarness();
    reader
      .mockResolvedValueOnce(payment()) // early: paid 11-10, 11-15 is fine
      .mockResolvedValueOnce(
        payment({ invoiceId: "in_acme_0003", paidAt: new Date("2026-11-18T08:00:00.000Z") }),
      ); // under the lock: a later payment; 11-15 is now before it
    const e = await refusal(h.svc.record(TENANT_A, body({ refundDate: "2026-11-15" }), ADMIN));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.order).toContain("lock");
  });

  it("the window refusal carries the deadline for the dialog", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: payment({ paidAt: new Date("2026-11-01T00:00:00.000Z") }) });
    const e = await refusal(h.svc.record(TENANT_A, body({ refundDate: "2026-11-16" }), ADMIN));
    expect(e.getResponse().deadline).toEqual(new Date("2026-11-15T00:00:00.000Z"));
  });
});

describe("R-2 test 22 (contract): the service shows and refunds exactly the record the reader returns", () => {
  // The ordering itself (createdAt desc, then id desc; SA-A C3) is PR-4's reader body and is tested THERE. R-2 can only prove
  // that it neither re-reads nor re-sorts payments: whatever the reader returns is the one shown and refunded.
  const sameCreatedAt = new Date("2026-11-10T08:00:00.000Z");
  const lowerId = payment({ invoiceId: "in_acme_a1", amount: "100.00", paidAt: sameCreatedAt });
  const higherId = payment({ invoiceId: "in_acme_b2", amount: "1188.50", paidAt: sameCreatedAt });

  it("two same-createdAt fixtures, the reader returns the higher id: it is the one shown and the one refunded", async () => {
    const h = makeHarness();
    reader.mockImplementation(async () => higherId); // the reader's pick; `lowerId` is never offered to the service
    const view = await h.svc.resolveRefundable(TENANT_A);
    expect(view.payment?.invoiceId).toBe("in_acme_b2");
    expect(view.payment?.amount).toBe("1188.50");
    await h.svc.record(TENANT_A, body(), ADMIN);
    expect(h.store).toHaveLength(1);
    expect(h.store[0].payload.invoiceId).toBe("in_acme_b2");
    expect(h.store[0].payload.amount).toBe("1188.50");
    expect(h.store[0].payload.invoiceId).not.toBe(lowerId.invoiceId);
  });

  it("the service never queries a BillingEvent other than refund.staff (it does not read invoice.yearly_paid itself)", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: higherId });
    await h.svc.resolveRefundable(TENANT_A);
    await h.svc.record(TENANT_A, body(), ADMIN);
    await h.svc.listBillingEvents(TENANT_A);
    const typed = h.eventQueries.filter((q) => q.where && "type" in q.where);
    expect(typed.length).toBeGreaterThan(0);
    for (const q of typed) expect(q.where.type).toBe("refund.staff");
    for (const q of h.eventQueries) expect(JSON.stringify(q)).not.toContain("yearly_paid");
  });

  it("the reader is called as (db, tenantId) with nothing else: the service passes no ordering, filter or limit", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: higherId });
    await h.svc.resolveRefundable(TENANT_A);
    for (const call of reader.mock.calls) {
      expect(call).toHaveLength(2);
      expect(call[1]).toBe(TENANT_A);
    }
  });

  it("the source never names the yearly-payment event, the subscription, an RfInvoice or the provider (it reads payments only through the reader)", () => {
    const text = withoutComments(readFileSync(join(__dirname, "staff-refund.service.ts"), "utf8"));
    for (const banned of [
      "yearly_paid",
      "YEARLY_PAYMENT_RECORDED",
      "tenantSubscription",
      "rfInvoice",
      "stripe",
      "annualPrice",
    ]) {
      expect(text).not.toContain(banned);
    }
  });
});

describe("R-2 test 18 (mocked half): the action reads and writes no tenant or subscription state", () => {
  it("a recorded refund touches only the lock, billingEvent, user and auditLog (the strict fake lists any other model)", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: payment() });
    await h.svc.record(TENANT_A, body(), ADMIN);
    await h.svc.resolveRefundable(TENANT_A);
    await h.svc.listBillingEvents(TENANT_A);
    expect(h.misses).toEqual([]); // no tx.tenant / tx.tenantSubscription / prisma.tenant... access
  });

  it("the audit notice always carries the one neutral line about the unchanged subscription", async () => {
    const h = makeHarness();
    h.readerAs({ [TENANT_A]: payment() });
    await h.svc.record(TENANT_A, body(), ADMIN);
    expect(h.audit[0].data.meta.message).toBe(
      "Recorded only; the subscription status here is unchanged until the provider's cancellation is processed.",
    );
  });
});

describe("R-2: the billing-events list", () => {
  it("newest first, take 100, refund.staff labelled 'Staff refund', every other type label null, actor names joined here", async () => {
    const h = makeHarness();
    h.store.push(
      {
        id: "ev-a",
        tenantId: TENANT_A,
        type: "plan.changed",
        payload: { fromPlan: "STARTER" },
        amountDelta: null,
        actorId: ADMIN_2,
        createdAt: new Date("2026-11-01T00:00:00.000Z"),
      },
      {
        id: "ev-b",
        tenantId: TENANT_A,
        type: "refund.staff",
        payload: { invoiceId: "in_acme_0002" },
        amountDelta: null,
        actorId: ADMIN,
        createdAt: new Date("2026-11-19T00:00:00.000Z"),
      },
      {
        id: "ev-c",
        tenantId: TENANT_B,
        type: "plan.changed",
        payload: {},
        amountDelta: null,
        actorId: null,
        createdAt: new Date("2026-11-19T12:00:00.000Z"),
      },
    );
    const rows = await h.svc.listBillingEvents(TENANT_A);
    expect(rows.map((r) => [r.id, r.type, r.label, r.actorName])).toEqual([
      ["ev-b", "refund.staff", "Staff refund", "pat.staff"],
      ["ev-a", "plan.changed", null, "sam@example.test"],
    ]);
    const q = h.billingEvent.findMany.mock.calls[0][0];
    expect(q.where).toEqual({ tenantId: TENANT_A });
    expect(q.take).toBe(100);
    expect(q.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(rows[0]).toEqual({
      id: "ev-b",
      type: "refund.staff",
      label: "Staff refund",
      createdAt: new Date("2026-11-19T00:00:00.000Z"),
      actorName: "pat.staff",
      payload: { invoiceId: "in_acme_0002" },
    });
  });

  it("a row with no actor reads actorName null", async () => {
    const h = makeHarness();
    h.store.push({
      id: "ev-z",
      tenantId: TENANT_A,
      type: "trial.expired",
      payload: {},
      amountDelta: null,
      actorId: null,
      createdAt: NOW,
    });
    expect((await h.svc.listBillingEvents(TENANT_A))[0].actorName).toBeNull();
  });
});

// ─── Test 14: one writer, no amountDelta (L-223: every emit and every amountDelta site, not only the ones the brief named) ───
const SRC = join(__dirname, "..");
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "dist" ? [] : walk(p);
    return /\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name) ? [p] : [];
  });
const rel = (f: string) => relative(SRC, f).split(sep).join("/");
/** Source with block and line comments blanked, so a rule written in prose (a doc comment) never counts as code. */
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** The full text of every `.emit(` call that names STAFF_REFUND_RECORDED, balanced to its closing paren. */
function staffRefundEmitCalls(text: string): string[] {
  const out: string[] = [];
  const re = /\.emit\(\s*[^,()]+,\s*BILLING_EVENTS\.STAFF_REFUND_RECORDED\b/g;
  for (const m of text.matchAll(re)) {
    const open = text.indexOf("(", m.index);
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "(") depth += 1;
      if (text[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          out.push(text.slice(open, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

describe("R-2 test 14: BILLING_EVENTS.STAFF_REFUND_RECORDED has one writer and its emit carries no amountDelta", () => {
  const files = walk(SRC);
  const usedBy = files
    .map((f) => ({ f: rel(f), text: withoutComments(readFileSync(f, "utf8")) }))
    .filter(
      (x) =>
        /(?<![A-Z_])STAFF_REFUND_RECORDED\b/.test(x.text) || /["'`]refund\.staff["'`]/.test(x.text),
    );

  it("the walk really covers the named edge files and skips specs (not a vacuous scan)", () => {
    const rels = files.map(rel);
    expect(rels).toContain("platform-admin/staff-refund.service.ts");
    expect(rels).toContain("billing/addon-ledger.ts");
    expect(rels).toContain("billing/billing-event.service.ts");
    expect(rels.some((r) => /\.spec\.ts$/.test(r))).toBe(false);
    expect(files.length).toBeGreaterThan(300);
  });

  it("exactly one file emits it: platform-admin/staff-refund.service.ts, exactly once", () => {
    const emitting = usedBy
      .map((x) => ({ f: x.f, n: staffRefundEmitCalls(x.text).length }))
      .filter((x) => x.n > 0);
    expect(emitting).toEqual([{ f: "platform-admin/staff-refund.service.ts", n: 1 }]);
  });

  it("the only files that spell the type at all are the constants, the export exclusion and the writer", () => {
    expect(usedBy.map((x) => x.f).sort()).toEqual([
      "billing/billing-export-fields.ts",
      "billing/plan-catalog.constants.ts",
      "platform-admin/staff-refund.service.ts",
    ]);
  });

  it("the writer's emit call passes { actorId, tx } and no amountDelta key (a delta fails the build)", () => {
    const text = withoutComments(
      readFileSync(join(SRC, "platform-admin", "staff-refund.service.ts"), "utf8"),
    );
    const [call] = staffRefundEmitCalls(text);
    expect(call).toBeDefined();
    expect(call).not.toMatch(/amountDelta/);
    expect(call).toMatch(/\{\s*actorId,\s*tx\s*\}\s*,?\s*\)$/);
    expect(text).not.toMatch(/amountDelta/);
  });

  it("probe (L-377): the scanner flags a planted second emit and a planted amountDelta", () => {
    const planted = `await this.events.emit(id, BILLING_EVENTS.STAFF_REFUND_RECORDED, { a: f(1) }, { amountDelta: 5, actorId, tx });`;
    const calls = staffRefundEmitCalls(planted);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/amountDelta/);
    expect(staffRefundEmitCalls(`${planted}\n${planted}`)).toHaveLength(2);
    expect(staffRefundEmitCalls(`x.emit(id, BILLING_EVENTS.PLAN_CHANGED, {}, {})`)).toHaveLength(0);
  });

  it("BILLING_EVENTS.STAFF_REFUND_RECORDED is refund.staff (the constant the pin scans for)", () => {
    expect(BILLING_EVENTS.STAFF_REFUND_RECORDED).toBe("refund.staff");
  });
});
