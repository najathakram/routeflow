jest.mock("./day-close-facts", () => ({
  readWindowFacts: jest.fn(),
  countSalesSince: jest.fn(),
}));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { roundMoney, sumDenominations, type DenominationCount } from "@routeflow/pricing";
import type { JwtPayload } from "../../../auth/jwt-payload.interface";
import { countSalesSince, readWindowFacts } from "./day-close-facts";
import type { WindowFacts, WindowPayment } from "./day-close-fold";
import { CounterDayCloseService, zReportKey } from "./day-close.service";
import {
  makeFakeDayCloseDb,
  OTHER_TENANT,
  TENANT,
  type FakeOptions,
} from "./testing/fake-day-close-db";

/**
 * Counter day close, the service: the cutoff and the lock, the window chain across a non-UTC tenant day, the server-side
 * recompute, duplicate / re-close / reopen, the audit, the Z report and the gate. The window's queries are replaced by canned
 * facts (their SQL is pinned by day-close-facts.spec.ts and day-close.db.spec.ts). Placeholders only (acme).
 */
const user = {
  sub: "u-op",
  username: "op-acme",
  role: "OPERATOR",
  tenantId: TENANT,
} as unknown as JwtPayload;
const NY = "America/New_York";
const T = (iso: string) => new Date(iso);

const cash = (amount: number): WindowPayment => ({
  amount,
  method: "CASH",
  status: "PAID",
  paymentGroupId: null,
  invoice: { orderId: "o-1" },
});
const facts = (over: Partial<WindowFacts> = {}): WindowFacts => ({
  sales: { _count: { _all: 2 }, _sum: { total: 40 } },
  payments: [cash(30)],
  paidOnSales: { _sum: { amount: 30 } },
  returns: [],
  ...over,
});
const tens = (n: number): DenominationCount[] => [{ kind: "bill", value: 10, count: n }];

function setup(opts: FakeOptions = {}, counter: "optional" | "off" = "optional") {
  const fake = makeFakeDayCloseDb(opts);
  const email = {
    send: jest.fn(async (_params: Record<string, any>) => ({ delivered: true, transport: "smtp" })),
  };
  const capability = { get: jest.fn(async () => ({ counter })) };
  const service = new CounterDayCloseService(
    fake.prisma as never,
    capability as never,
    email as never,
  );
  (readWindowFacts as jest.Mock).mockReset().mockResolvedValue(facts());
  (countSalesSince as jest.Mock).mockReset().mockResolvedValue(0);
  return { fake, email, capability, service };
}

describe("CounterDayCloseService.close: the cutoff, the lock and the recompute", () => {
  it("takes the exclusive lock (after SET LOCAL lock_timeout), THEN reads the database clock, THEN reads the window", async () => {
    const { service, fake } = setup();
    await service.close({ openingFloat: 0, denominations: tens(3) }, user);
    expect(fake.events.slice(0, 4)).toEqual([
      "set-lock-timeout",
      "lock",
      "clock",
      "close.findFirst",
    ]);
    expect(fake.sql.map((s) => s.text)).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      "SELECT pg_advisory_xact_lock(hashtext('counter-close'), hashtext(?))",
    ]);
    expect(fake.sql[1].values).toEqual([`${TENANT}:main`]);
    // no other lock of any kind
    expect(
      fake.sql.some((s) => /FOR UPDATE|advisory_lock_shared|pg_advisory_lock\(/i.test(s.text)),
    ).toBe(false);
  });

  it("recomputes counted and expected on the server: a tampered client counted / expected is ignored", async () => {
    const { service, fake } = setup();
    (readWindowFacts as jest.Mock).mockResolvedValue(facts({ payments: [cash(50)] }));
    const dto = {
      openingFloat: 100,
      denominations: tens(14),
      counted: 9999,
      expected: 1,
      expectedCash: 1,
      countedCash: 9999,
      variance: 0,
    };
    const snap = await service.close(dto as never, user);
    expect(snap.countedCash).toBe(140);
    expect(snap.expectedCash).toBe(150); // 100 float + 50 till cash
    expect(snap.variance).toBe(-10); // counted - expected: short $10
    const stored = fake.closes[0];
    expect([stored.countedCash, stored.expectedCash, stored.variance]).toEqual([140, 150, -10]);
  });

  it("variance sign: over is positive, short is negative, exact is 0", async () => {
    for (const [tensCount, variance] of [
      [16, 10],
      [14, -10],
      [15, 0],
    ] as const) {
      const { service } = setup();
      (readWindowFacts as jest.Mock).mockResolvedValue(facts({ payments: [cash(50)] }));
      const snap = await service.close({ openingFloat: 100, denominations: tens(tensCount) }, user);
      expect(snap.variance).toBe(variance);
    }
  });

  it("0.10 x 3 counts as 0.30 and an expected 0.30 gives a variance of exactly 0", async () => {
    const { service } = setup();
    (readWindowFacts as jest.Mock).mockResolvedValue(
      facts({ payments: [cash(0.1), cash(0.1), cash(0.1)] }),
    );
    const snap = await service.close(
      { openingFloat: 0, denominations: [{ kind: "coin", value: 0.1, count: 3 }] },
      user,
    );
    expect(snap.countedCash).toBe(0.3);
    expect(snap.expectedCash).toBe(0.3);
    expect(snap.variance).toBe(0);
  });

  it("a large count (100000 of every note and coin) is summed to the cent and stored", async () => {
    const { service } = setup();
    (readWindowFacts as jest.Mock).mockResolvedValue(facts({ payments: [] }));
    const all: DenominationCount[] = [
      ...[100, 50, 20, 10, 5, 2, 1].map((value) => ({
        kind: "bill" as const,
        value,
        count: 100_000,
      })),
      ...[1, 0.25, 0.1, 0.05, 0.01].map((value) => ({
        kind: "coin" as const,
        value,
        count: 100_000,
      })),
    ];
    const snap = await service.close({ openingFloat: 0, denominations: all }, user);
    expect(snap.countedCash).toBe(18_941_000);
    expect(snap.countedCash).toBe(sumDenominations(all));
    expect(snap.variance).toBe(roundMoney(18_941_000 - 0));
  });

  it("stores the summary totals the fold produced: no rows, no customer names", async () => {
    const { service, fake } = setup();
    await service.close({ openingFloat: 0, denominations: tens(3) }, user);
    const totals = fake.closes[0].totals;
    expect(totals.moneyIn.cash).toBe(30);
    expect(Object.keys(totals)).not.toContain("rows");
    expect(JSON.stringify(totals)).not.toMatch(/customer/i);
  });

  it("refuses bad input with a 400 before opening a transaction", async () => {
    const { service, fake } = setup();
    const bad: Array<[string, any]> = [
      [
        "an unlisted value",
        { openingFloat: 0, denominations: [{ kind: "bill", value: 3, count: 1 }] },
      ],
      ["the $1 bill listed twice", { openingFloat: 0, denominations: [...tens(1), ...tens(2)] }],
      ["a fractional count", { openingFloat: 0, denominations: tens(1.5) }],
      ["a count over 100000", { openingFloat: 0, denominations: tens(100_001) }],
      ["a float of 0.001", { openingFloat: 0.001, denominations: tens(1) }],
      ["a negative float", { openingFloat: -1, denominations: tens(1) }],
      ["notes over 500", { openingFloat: 0, denominations: tens(1), notes: "x".repeat(501) }],
      ["a bad register key", { openingFloat: 0, denominations: tens(1), registerKey: "a b" }],
    ];
    for (const [, dto] of bad) {
      await expect(service.close(dto, user)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(fake.events).toEqual([]);
  });
});

describe("CounterDayCloseService.close: the window chain in a non-UTC tenant zone", () => {
  it("a close at 23:59 local and one at 00:01 local land on different days, and the second window starts where the first ended", async () => {
    const { service, fake } = setup({
      timezone: NY,
      // 2026-10-07 23:59 EDT, then 2026-10-08 00:01 EDT
      clock: [T("2026-10-08T03:59:00.000Z"), T("2026-10-08T04:01:00.000Z")],
    });
    const first = await service.close({ openingFloat: 0, denominations: tens(1) }, user);
    expect(first.day).toBe("2026-10-07");
    expect(first.zone).toBe(NY);
    expect(first.windowStart).toBe("2026-10-07T04:00:00.000Z"); // the first window opens at 00:00 New York time
    expect(first.windowEnd).toBe("2026-10-08T03:59:00.000Z");
    expect((readWindowFacts as jest.Mock).mock.calls[0][3]).toEqual({
      start: T("2026-10-07T04:00:00.000Z"),
      end: T("2026-10-08T03:59:00.000Z"),
    });

    const second = await service.close({ openingFloat: 0, denominations: tens(1) }, user);
    expect(second.day).toBe("2026-10-08");
    expect(second.windowStart).toBe(first.windowEnd); // close to close: nothing falls between
    expect(second.windowEnd).toBe("2026-10-08T04:01:00.000Z");
    expect(fake.closes).toHaveLength(2);
  });

  it("the same two closes in UTC are the same day: the second is refused", async () => {
    const { service } = setup({
      timezone: "UTC",
      clock: [T("2026-10-08T03:59:00.000Z"), T("2026-10-08T04:01:00.000Z")],
    });
    await service.close({ openingFloat: 0, denominations: tens(1) }, user);
    await expect(
      service.close({ openingFloat: 0, denominations: tens(1) }, user),
    ).rejects.toMatchObject({ response: { code: "DAY_ALREADY_CLOSED" } });
  });

  it("the first window of a register opens at the start of the tenant-zone day of the cutoff, even across DST", async () => {
    // 2026-11-01 is the US fall-back day: New York midnight is 04:00Z, the day is 25 hours long
    const { service } = setup({ timezone: NY, clock: [T("2026-11-01T20:00:00.000Z")] });
    const snap = await service.close({ openingFloat: 0, denominations: tens(1) }, user);
    expect(snap.windowStart).toBe("2026-11-01T04:00:00.000Z");
    expect(snap.day).toBe("2026-11-01");
  });

  it("an unknown zone falls back to UTC", async () => {
    const { service } = setup({ timezone: "Mars/Olympus", clock: [T("2026-10-08T10:00:00.000Z")] });
    const snap = await service.close({ openingFloat: 0, denominations: tens(1) }, user);
    expect(snap.zone).toBe("UTC");
    expect(snap.windowStart).toBe("2026-10-08T00:00:00.000Z");
  });
});

describe("CounterDayCloseService.close: duplicates", () => {
  it("a second close of the same day while the first stands is a 409 DAY_ALREADY_CLOSED and writes nothing", async () => {
    const { service, fake, email } = setup({
      clock: [T("2026-10-08T16:00:00.000Z"), T("2026-10-08T18:00:00.000Z")],
    });
    await service.close({ openingFloat: 0, denominations: tens(1) }, user);
    const err = await service
      .close({ openingFloat: 0, denominations: tens(1) }, user)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.response.code).toBe("DAY_ALREADY_CLOSED");
    expect(fake.closes).toHaveLength(1);
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it("a second close of the same day after a sale was rung since the first is a second window", async () => {
    const { service, fake } = setup({
      clock: [T("2026-10-08T16:00:00.000Z"), T("2026-10-08T18:00:00.000Z")],
    });
    const first = await service.close({ openingFloat: 0, denominations: tens(1) }, user);
    (countSalesSince as jest.Mock).mockResolvedValue(2);
    const second = await service.close({ openingFloat: 0, denominations: tens(1) }, user);
    expect(second.windowStart).toBe(first.windowEnd);
    expect(second.day).toBe(first.day);
    expect(fake.closes).toHaveLength(2);
  });

  it("a first close that loses the unique (tenant, register, windowStart) race (P2002) is a 409 DAY_ALREADY_CLOSED", async () => {
    const { service, fake } = setup();
    jest
      .spyOn(fake.prisma.forTenant().counterDayClose, "create")
      .mockRejectedValueOnce(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );
    await expect(
      service.close({ openingFloat: 0, denominations: tens(1) }, user),
    ).rejects.toMatchObject({ response: { code: "DAY_ALREADY_CLOSED" } });
    expect(fake.closes).toHaveLength(0);
  });

  it("a lock wait that times out is a retryable 503, not a 500", async () => {
    const { service, fake } = setup();
    jest
      .spyOn(fake.prisma, "tenantTransaction")
      .mockRejectedValueOnce(
        Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }),
      );
    await expect(
      service.close({ openingFloat: 0, denominations: tens(1) }, user),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe("CounterDayCloseService: registers", () => {
  it("a 'b' close is keyed (tenant:b), reads its own window, and does not chain from the main register's close", async () => {
    const { service, fake } = setup({
      clock: [T("2026-10-08T16:00:00.000Z"), T("2026-10-08T18:00:00.000Z")],
    });
    await service.close({ openingFloat: 0, denominations: tens(1) }, user); // main
    const b = await service.close(
      { openingFloat: 5, denominations: tens(1), registerKey: "b" },
      user,
    );
    expect(b.registerKey).toBe("b");
    expect(b.windowStart).toBe("2026-10-08T00:00:00.000Z"); // its own first window, not main's windowEnd
    expect(fake.sql.map((s) => s.values[0]).filter(Boolean)).toEqual([
      `${TENANT}:main`,
      `${TENANT}:b`,
    ]);
    const calls = (readWindowFacts as jest.Mock).mock.calls;
    expect(calls[0].slice(1, 3)).toEqual([TENANT, "main"]);
    expect(calls[1].slice(1, 3)).toEqual([TENANT, "b"]);
    expect(fake.closes.map((c) => c.registerKey)).toEqual(["main", "b"]);
  });

  it("the state of register 'b' ignores main's close", async () => {
    const { service, fake } = setup();
    fake.seedClose(standingClose({ registerKey: "main" }));
    const state = await service.state("b", T("2026-10-08T12:00:00.000Z"));
    expect(state.registerKey).toBe("b");
    expect(state.lastClose).toBeNull();
    expect((readWindowFacts as jest.Mock).mock.calls[0].slice(1, 3)).toEqual([TENANT, "b"]);
  });
});

function standingClose(over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    registerKey: "main",
    day: T("2026-10-08T00:00:00.000Z"),
    zone: "UTC",
    windowStart: T("2026-10-08T00:00:00.000Z"),
    windowEnd: T("2026-10-08T16:00:00.000Z"),
    closedAt: T("2026-10-08T16:00:00.000Z"),
    closedById: "u-op",
    openingFloat: 20,
    expectedCash: 50,
    countedCash: 50,
    variance: 0,
    denominations: [{ kind: "bill", value: 10, count: 5 }],
    totals: {
      salesCount: 1,
      salesTotal: 30,
      moneyIn: { cash: 30, card: 0, check: 0, other: 0, total: 30 },
      refunds: {
        count: 0,
        cash: 0,
        card: 0,
        check: 0,
        other: 0,
        total: 0,
        tenderKnown: true,
        unknownTenderCount: 0,
      },
      storeCreditUsed: 0,
      storeCreditIssued: { count: 0, amount: 0 },
      onAccount: 0,
      netCollected: 30,
      notAtTill: 0,
    },
    ...over,
  };
}

describe("CounterDayCloseService: reopen and re-close", () => {
  it("reopen sets reopenedAt / reopenedById and writes the audit row (the old snapshot) INSIDE the transaction", async () => {
    const { service, fake } = setup({ clock: [T("2026-10-08T17:00:00.000Z")] });
    fake.seedClose(standingClose());
    const snap = await service.reopen(fake.closes[0].id, user);
    expect(snap.reopenedAt).toBe("2026-10-08T17:00:00.000Z");
    expect(snap.reopenedById).toBe("u-op");
    expect(fake.audits).toHaveLength(1);
    expect(fake.audits[0]).toMatchObject({
      tenantId: TENANT,
      userId: "u-op",
      action: "COUNTER_DAY_CLOSE_REOPENED",
      entityType: "CounterDayClose",
      entityId: fake.closes[0].id,
    });
    expect(fake.audits[0].meta.snapshot).toMatchObject({
      countedCash: 50,
      expectedCash: 50,
      openingFloat: 20,
      reopenedAt: null,
    });
    // inside the transaction: after the lock and the update, before it returns
    expect(fake.events.indexOf("lock")).toBeLessThan(fake.events.indexOf("audit"));
    expect(fake.events.indexOf("close.updateMany:1")).toBeLessThan(fake.events.indexOf("audit"));
  });

  it("the audit write is AWAITED in the transaction: when it fails the reopen is rolled back and the error surfaces", async () => {
    const { service, fake } = setup({ auditFails: true });
    fake.seedClose(standingClose());
    await expect(service.reopen(fake.closes[0].id, user)).rejects.toThrow("audit write failed");
    expect(fake.closes[0].reopenedAt).toBeNull();
    expect(fake.closes[0].reopenedById).toBeNull();
  });

  it("only the latest close of a till can be reopened, and only once", async () => {
    const { service, fake } = setup();
    fake.seedClose(standingClose());
    fake.seedClose(
      standingClose({
        day: T("2026-10-09T00:00:00.000Z"),
        windowStart: T("2026-10-08T16:00:00.000Z"),
        windowEnd: T("2026-10-09T16:00:00.000Z"),
        closedAt: T("2026-10-09T16:00:00.000Z"),
      }),
    );
    const [older, newer] = fake.closes;
    await expect(service.reopen(older.id, user)).rejects.toBeInstanceOf(ConflictException);
    await service.reopen(newer.id, user);
    await expect(service.reopen(newer.id, user)).rejects.toBeInstanceOf(ConflictException);
    expect(fake.audits).toHaveLength(1);
  });

  it("an unknown close, and another tenant's close, are 404", async () => {
    const { service, fake } = setup();
    fake.seedClose(standingClose({ tenantId: OTHER_TENANT }));
    await expect(service.reopen(fake.closes[0].id, user)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.reopen("nope", user)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.resendReport(fake.closes[0].id)).rejects.toBeInstanceOf(NotFoundException);
    expect(fake.audits).toHaveLength(0);
  });

  it("re-close recomputes over the STORED window, never moves the cutoff, changes only the count / note / figures, and sends a SECOND Z report", async () => {
    const { service, fake, email } = setup({
      clock: [
        T("2026-10-08T16:00:00.000Z"),
        T("2026-10-08T17:00:00.000Z"),
        T("2026-10-08T18:30:00.000Z"),
      ],
    });
    const first = await service.close(
      { openingFloat: 20, denominations: tens(3), notes: "first" },
      user,
    );
    expect(email.send).toHaveBeenCalledTimes(1);
    await service.reopen(first.id, user);
    (readWindowFacts as jest.Mock).mockClear().mockResolvedValue(facts({ payments: [cash(45)] }));

    const again = await service.close(
      { openingFloat: 999, denominations: tens(6), notes: "recounted" },
      user,
    );
    // the window is the stored one, read once
    expect((readWindowFacts as jest.Mock).mock.calls).toHaveLength(1);
    expect((readWindowFacts as jest.Mock).mock.calls[0][3]).toEqual({
      start: T("2026-10-08T00:00:00.000Z"),
      end: T("2026-10-08T16:00:00.000Z"),
    });
    expect(again.id).toBe(first.id);
    expect(again.windowStart).toBe(first.windowStart);
    expect(again.windowEnd).toBe(first.windowEnd); // the cutoff did not move
    expect(again.openingFloat).toBe(20); // the float the window opened with stays
    expect(again.countedCash).toBe(60);
    expect(again.expectedCash).toBe(65); // 20 + 45 recomputed
    expect(again.variance).toBe(-5);
    expect(again.notes).toBe("recounted");
    expect(again.closedAt).toBe("2026-10-08T18:30:00.000Z"); // now
    expect(again.reopenedAt).toBeNull();
    expect(fake.closes).toHaveLength(1);
    // a corrected report went out: a new claim key (new closedAt), a second send
    expect(email.send).toHaveBeenCalledTimes(2);
    expect(fake.claims.map((c) => c.key)).toEqual([
      `${first.id}:2026-10-08T16:00:00.000Z`,
      `${first.id}:2026-10-08T18:30:00.000Z`,
    ]);
  });

  it("a re-close whose compare-and-set loses (the row is no longer reopened) is a 409 DAY_ALREADY_CLOSED", async () => {
    const { service, fake } = setup();
    fake.seedClose(
      standingClose({ reopenedAt: T("2026-10-08T17:00:00.000Z"), reopenedById: "u-op" }),
    );
    jest
      .spyOn(fake.prisma.forTenant().counterDayClose, "updateMany")
      .mockResolvedValueOnce({ count: 0 });
    await expect(
      service.close({ openingFloat: 0, denominations: tens(1) }, user),
    ).rejects.toMatchObject({ response: { code: "DAY_ALREADY_CLOSED" } });
  });

  it("a report cannot be re-sent for a reopened close", async () => {
    const { service, fake } = setup();
    fake.seedClose(standingClose({ reopenedAt: T("2026-10-08T17:00:00.000Z") }));
    await expect(service.resendReport(fake.closes[0].id)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("CounterDayCloseService: the Z report", () => {
  it("goes to every ACTIVE tenant admin, with the delivery context, and the close reports it sent", async () => {
    const { service, email } = setup({
      admins: [
        { email: "owner@acme.test" },
        { email: "second@acme.test" },
        { email: "gone@acme.test", status: "INACTIVE" },
        { email: "clerk@acme.test", role: "OPERATOR" },
      ],
    });
    const snap = await service.close({ openingFloat: 0, denominations: tens(3) }, user);
    expect(snap.reportSent).toBe(true);
    expect(email.send.mock.calls.map((c) => c[0].to)).toEqual([
      "owner@acme.test",
      "second@acme.test",
    ]);
    expect(email.send.mock.calls[0][0].delivery).toEqual({
      tenantId: TENANT,
      kind: "Z_REPORT",
      entityType: "CounterDayClose",
      entityId: snap.id,
    });
    expect(email.send.mock.calls[0][0].html).toContain("Z report for");
  });

  it("no admin to send to: the close succeeds and reportSent is null", async () => {
    const { service, email, fake } = setup({ admins: [] });
    const snap = await service.close({ openingFloat: 0, denominations: tens(3) }, user);
    expect(snap.reportSent).toBeNull();
    expect(email.send).not.toHaveBeenCalled();
    expect(fake.claims).toHaveLength(0);
  });

  it("a failed send never fails the close: reportSent is false and the claim is released so Resend can send", async () => {
    const { service, email, fake } = setup();
    email.send.mockResolvedValue({ delivered: false, transport: "none" } as never);
    const snap = await service.close({ openingFloat: 0, denominations: tens(3) }, user);
    expect(snap.reportSent).toBe(false);
    expect(fake.closes).toHaveLength(1);
    expect(fake.claims).toHaveLength(0);
  });

  it("a send that THROWS is the same: the close stands, the claim is released", async () => {
    const { service, email, fake } = setup();
    email.send.mockRejectedValue(new Error("smtp down") as never);
    const snap = await service.close({ openingFloat: 0, denominations: tens(3) }, user);
    expect(snap.reportSent).toBe(false);
    expect(fake.closes).toHaveLength(1);
    expect(fake.claims).toHaveLength(0);
  });

  it("is idempotent: an automatic send that finds the claim taken sends nothing", async () => {
    const { service, email, fake } = setup();
    await service.close({ openingFloat: 0, denominations: tens(3) }, user);
    expect(email.send).toHaveBeenCalledTimes(1);
    const row = fake.closes[0];
    expect(await service.sendReport(row as never, { manual: false })).toBe(true);
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(fake.claims).toEqual([
      { tenantId: TENANT, milestone: "ZREPORT", key: zReportKey(row as never) },
    ]);
  });

  it("Resend after a failure sends and the report reads as sent", async () => {
    const { service, email, fake } = setup();
    email.send.mockResolvedValueOnce({ delivered: false, transport: "none" } as never);
    const snap = await service.close({ openingFloat: 0, denominations: tens(3) }, user);
    expect(snap.reportSent).toBe(false);
    const resent = await service.resendReport(snap.id);
    expect(resent.reportSent).toBe(true);
    expect(email.send).toHaveBeenCalledTimes(2);
    expect(fake.claims).toHaveLength(1);
  });

  it("a manual Resend of a report that already went sends it again (bypasses the claim for its own key), still one claim", async () => {
    const { service, email, fake } = setup();
    const snap = await service.close({ openingFloat: 0, denominations: tens(3) }, user);
    await service.resendReport(snap.id);
    expect(email.send).toHaveBeenCalledTimes(2);
    expect(fake.claims).toHaveLength(1);
  });

  it("the email names no customer and no line, only the summary", async () => {
    const { service, email } = setup();
    await service.close({ openingFloat: 0, denominations: tens(3) }, user);
    const body = JSON.stringify(email.send.mock.calls[0][0]);
    expect(body).not.toMatch(/customer|walk-in|orderNumber/i);
  });
});

describe("CounterDayCloseService.state", () => {
  const NOW = T("2026-10-08T20:00:00.000Z");

  it("before any close: no last close, the window opens at the start of the tenant-zone day, the float suggestion is 0", async () => {
    const { service } = setup({ timezone: NY });
    const state = await service.state(undefined, NOW);
    expect(state.lastClose).toBeNull();
    expect(state.salesSince).toBe(0);
    expect(state.zone).toBe(NY);
    expect(state.preview).toMatchObject({
      windowStart: "2026-10-08T04:00:00.000Z",
      windowEnd: NOW.toISOString(),
      suggestedOpeningFloat: 0,
      tillCash: 30,
      cashRefunds: 0,
    });
  });

  it("after a close: the next window starts at the close's windowEnd, the float suggestion is its float, and the sales since are counted", async () => {
    const { service, fake } = setup();
    fake.seedClose(standingClose());
    (countSalesSince as jest.Mock).mockResolvedValue(4);
    const state = await service.state("main", NOW);
    expect(state.lastClose).toMatchObject({ openingFloat: 20, countedCash: 50, reopenedAt: null });
    expect(state.salesSince).toBe(4);
    expect(state.preview.windowStart).toBe("2026-10-08T16:00:00.000Z");
    expect(state.preview.windowEnd).toBe(NOW.toISOString());
    expect(state.preview.suggestedOpeningFloat).toBe(20);
    expect((countSalesSince as jest.Mock).mock.calls[0].slice(1, 4)).toEqual([
      TENANT,
      "main",
      T("2026-10-08T16:00:00.000Z"),
    ]);
  });

  it("when the latest close is reopened, the preview covers its STORED window", async () => {
    const { service, fake } = setup();
    fake.seedClose(standingClose({ reopenedAt: T("2026-10-08T17:00:00.000Z") }));
    const state = await service.state(undefined, NOW);
    expect(state.preview.windowStart).toBe("2026-10-08T00:00:00.000Z");
    expect(state.preview.windowEnd).toBe("2026-10-08T16:00:00.000Z");
    expect(state.lastClose?.reopenedAt).toBe("2026-10-08T17:00:00.000Z");
  });

  it("reportSent is derived: a send claim -> true; a failed delivery since the close -> false; neither -> null; an old failure before a re-close does not count", async () => {
    const { service, fake } = setup();
    fake.seedClose(standingClose());
    const row = fake.closes[0];
    expect((await service.state(undefined, NOW)).lastClose?.reportSent).toBeNull();

    fake.recordDelivery({
      tenantId: TENANT,
      kind: "Z_REPORT",
      entityId: row.id,
      createdAt: T("2026-10-08T16:00:05.000Z"),
    });
    expect((await service.state(undefined, NOW)).lastClose?.reportSent).toBe(false);

    row.closedAt = T("2026-10-08T18:00:00.000Z"); // re-closed after that failure
    expect((await service.state(undefined, NOW)).lastClose?.reportSent).toBeNull();

    fake.claims.push({ tenantId: TENANT, milestone: "ZREPORT", key: zReportKey(row as never) });
    expect((await service.state(undefined, NOW)).lastClose?.reportSent).toBe(true);
  });

  it("another tenant's close is never read", async () => {
    const { service, fake } = setup();
    fake.seedClose(standingClose({ tenantId: OTHER_TENANT }));
    const state = await service.state(undefined, NOW);
    expect(state.lastClose).toBeNull();
    expect((readWindowFacts as jest.Mock).mock.calls[0][1]).toBe(TENANT);
  });
});

describe("CounterDayCloseService: the gate and the tenant", () => {
  it("a tenant with counter sales off is refused COUNTER_SALES_DISABLED on every route, before anything is read or written", async () => {
    const { service, fake, email } = setup({}, "off");
    const refused = (p: Promise<unknown>) =>
      expect(p).rejects.toMatchObject({
        status: 403,
        response: { code: "COUNTER_SALES_DISABLED" },
      });
    await refused(service.state());
    await refused(service.close({ openingFloat: 0, denominations: tens(1) }, user));
    await refused(service.reopen("c-1", user));
    await refused(service.resendReport("c-1"));
    expect(fake.events).toEqual([]);
    expect(email.send).not.toHaveBeenCalled();
    expect(readWindowFacts).not.toHaveBeenCalled();
  });

  it("a session with no tenant is refused (forTenant() would be unscoped)", async () => {
    const { service } = setup({ tenantId: null });
    await expect(service.state()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.close({ openingFloat: 0, denominations: tens(1) }, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a close writes the session's tenant on the row and reads the window for that tenant only", async () => {
    const { service, fake } = setup();
    await service.close({ openingFloat: 0, denominations: tens(1) }, user);
    expect(fake.closes[0].tenantId).toBe(TENANT);
    expect((readWindowFacts as jest.Mock).mock.calls[0][1]).toBe(TENANT);
  });
});
