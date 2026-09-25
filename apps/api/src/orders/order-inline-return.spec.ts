import { ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import { ConflictException } from "@nestjs/common";
import { INLINE_RETURN_KEY_TAKEN } from "../returns/inline-returns.service";
import {
  applyInlineReturnInTx,
  assertReplayCarriesReturn,
  assertReplayCarriesReturnKey,
  reserveEditReturnNumber,
  retryTxOnDeadlock,
  isRetryableTxError,
  preflightInlineReturn,
  emitInlineReturnCredit,
  lockInlineReturnCustomer,
  prepareInlineReturn,
  reserveInlineReturnNumber,
} from "./order-inline-return";

/**
 * #2094: the order-side glue. The service behind it is stubbed; what is pinned here is WHEN each
 * call happens and what the client can and cannot choose (customer/order are derived).
 */
const LINES = { returnKey: "k1", items: [{ productId: "p1", boxes: 0, pieces: 2 }] } as any;
const STAFF = { sub: "u1", role: "OPERATOR", tenantId: "t1" } as any;

const svcStub = () => ({
  assertInlineReturnAllowed: jest.fn().mockResolvedValue(undefined),
  reserveCreditNoteNumber: jest.fn().mockResolvedValue("CN-2026-0001"),
  lockCustomerInTx: jest.fn().mockResolvedValue(undefined),
  captureAndIssueInTx: jest.fn().mockResolvedValue({ minted: { id: "cn-1" } }),
  emitCreditIssued: jest.fn(),
  preflightNewOrderReturn: jest.fn().mockResolvedValue(30),
});

describe("prepareInlineReturn", () => {
  it("no inlineReturn: null, and the service is never touched (every existing caller is unchanged)", async () => {
    const svc = svcStub();
    expect(await prepareInlineReturn(svc as any, undefined, STAFF)).toBeNull();
    expect(svc.assertInlineReturnAllowed).not.toHaveBeenCalled();
  });

  it("a call without a user is refused", async () => {
    await expect(prepareInlineReturn(svcStub() as any, LINES, undefined)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("a missing provider fails closed (503), never a silent skip", async () => {
    await expect(prepareInlineReturn(undefined, LINES, STAFF)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it("the service's guard runs (buyer / add-on) and its refusal propagates untouched", async () => {
    const svc = svcStub();
    svc.assertInlineReturnAllowed.mockRejectedValue(new ForbiddenException("Buyers cannot"));
    await expect(prepareInlineReturn(svc as any, LINES, STAFF)).rejects.toThrow(ForbiddenException);
    expect(svc.reserveCreditNoteNumber).not.toHaveBeenCalled();
  });

  it("a granted staff call returns the prepared handle with no number reserved yet", async () => {
    const svc = svcStub();
    const p = await prepareInlineReturn(svc as any, LINES, STAFF);
    expect(p).toMatchObject({ lines: LINES });
    expect(p!.creditNoteNumber).toBeUndefined();
    expect(svc.reserveCreditNoteNumber).not.toHaveBeenCalled();
  });
});

describe("reserveInlineReturnNumber / lockInlineReturnCustomer", () => {
  it("reserves the credit-note number once and stores it on the handle", async () => {
    const svc = svcStub();
    const p = await prepareInlineReturn(svc as any, LINES, STAFF);
    await reserveInlineReturnNumber(p, "c1", STAFF);
    expect(p!.creditNoteNumber).toBe("CN-2026-0001");
    expect(svc.reserveCreditNoteNumber).toHaveBeenCalledTimes(1);
  });

  it("validates BEFORE it reserves: a refused return burns no number (N1)", async () => {
    const svc = svcStub();
    svc.preflightNewOrderReturn.mockRejectedValue(new ConflictException("stale quote"));
    const p = await prepareInlineReturn(svc as any, LINES, STAFF);
    await expect(reserveInlineReturnNumber(p, "c1", STAFF)).rejects.toThrow(ConflictException);
    expect(svc.reserveCreditNoteNumber).not.toHaveBeenCalled();
    expect(svc.preflightNewOrderReturn).toHaveBeenCalledWith(LINES, "c1", STAFF);
  });

  it("a return that dry-runs to $0 reserves no number", async () => {
    const svc = svcStub();
    svc.preflightNewOrderReturn.mockResolvedValue(0);
    const p = await prepareInlineReturn(svc as any, LINES, STAFF);
    await reserveInlineReturnNumber(p, "c1", STAFF);
    expect(svc.reserveCreditNoteNumber).not.toHaveBeenCalled();
    expect(p!.creditNoteNumber).toBeUndefined();
  });

  describe("a returnKey already taken (Opus R1: a concurrent twin is a replay, not a false 409)", () => {
    const taken = () =>
      new ConflictException({ code: INLINE_RETURN_KEY_TAKEN, message: "key already used" });
    const setup = async () => {
      const svc = svcStub();
      svc.preflightNewOrderReturn.mockRejectedValue(taken());
      const p = await prepareInlineReturn(svc as any, LINES, STAFF);
      return { svc, p };
    };

    it("the pre-check missed, the preflight hits, this key's order carries the returnKey: the result is that order (the replay), no number reserved", async () => {
      const { svc, p } = await setup();
      const twin = { id: "ord-A", customerId: "c1" };
      const db = { return: { findFirst: jest.fn().mockResolvedValue({ id: "ret-A" }) } };
      const out = await reserveInlineReturnNumber(p, "c1", STAFF, {
        db,
        find: async () => twin,
      });
      expect(out).toBe(twin);
      expect(db.return.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ orderId: "ord-A", returnKey: "k1" }),
        }),
      );
      expect(svc.reserveCreditNoteNumber).not.toHaveBeenCalled();
    });

    it("the key's order does NOT carry this returnKey: 409 (a different return)", async () => {
      const { p } = await setup();
      const db = { return: { findFirst: jest.fn().mockResolvedValue(null) } };
      await expect(
        reserveInlineReturnNumber(p, "c1", STAFF, {
          db,
          find: async () => ({ id: "ord-A", customerId: "c1" }),
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("no Idempotency-Key, no order for it, or another customer's order: the 409 stands", async () => {
      for (const replay of [
        undefined,
        { db: {}, find: async () => null },
        { db: {}, find: async () => ({ id: "o", customerId: "OTHER" }) },
      ]) {
        const { p } = await setup();
        await expect(reserveInlineReturnNumber(p, "c1", STAFF, replay as any)).rejects.toThrow(
          ConflictException,
        );
      }
    });

    it("a stale-quote 409 (no key code) is never mistaken for a replay", async () => {
      const svc = svcStub();
      svc.preflightNewOrderReturn.mockRejectedValue(new ConflictException("stale quote"));
      const p = await prepareInlineReturn(svc as any, LINES, STAFF);
      const find = jest.fn();
      await expect(reserveInlineReturnNumber(p, "c1", STAFF, { db: {}, find })).rejects.toThrow(
        ConflictException,
      );
      expect(find).not.toHaveBeenCalled();
    });
  });

  it("both are no-ops without an inline return", async () => {
    await expect(reserveInlineReturnNumber(null, "c1", STAFF)).resolves.toBeNull();
    await expect(lockInlineReturnCustomer({}, null, "c1")).resolves.toBeUndefined();
  });

  it("the lock is taken on the caller's tx for the document's customer", async () => {
    const svc = svcStub();
    const p = await prepareInlineReturn(svc as any, LINES, STAFF);
    const tx = { id: "tx" };
    await lockInlineReturnCustomer(tx, p, "cust-9");
    expect(svc.lockCustomerInTx).toHaveBeenCalledWith(tx, "cust-9");
  });
});

describe("applyInlineReturnInTx", () => {
  it("derives customer and order from the document and passes the reserved number and driver run", async () => {
    const svc = svcStub();
    const p = await prepareInlineReturn(svc as any, LINES, STAFF);
    await reserveInlineReturnNumber(p, "c1", STAFF);
    const tx = {};
    const minted = await applyInlineReturnInTx(tx, p, {
      customerId: "cust-1",
      orderId: "ord-1",
      user: STAFF,
      orderRouteRunId: "run-1",
    });
    expect(minted).toEqual({ id: "cn-1" });
    expect(svc.captureAndIssueInTx).toHaveBeenCalledWith(
      tx,
      { ...LINES, customerId: "cust-1", orderId: "ord-1" },
      STAFF,
      { creditNoteNumber: "CN-2026-0001", orderRouteRunId: "run-1" },
    );
  });

  it("a client-supplied customer/order in the lines can never win: the document's own ids overwrite them", async () => {
    const svc = svcStub();
    const p = await prepareInlineReturn(
      svc as any,
      { ...LINES, customerId: "evil", orderId: "evil" },
      STAFF,
    );
    await applyInlineReturnInTx({}, p, { customerId: "cust-1", orderId: "ord-1", user: STAFF });
    const passed = svc.captureAndIssueInTx.mock.calls[0][1];
    expect([passed.customerId, passed.orderId]).toEqual(["cust-1", "ord-1"]);
  });

  it("null when there is no inline return", async () => {
    expect(
      await applyInlineReturnInTx({}, null, { customerId: "c", orderId: "o", user: STAFF }),
    ).toBeNull();
  });
});

describe("emitInlineReturnCredit", () => {
  it("emits only when a credit note was minted, and only through the after-commit hook", async () => {
    const svc = svcStub();
    const p = await prepareInlineReturn(svc as any, LINES, STAFF);
    emitInlineReturnCredit(p, "t1", null);
    expect(svc.emitCreditIssued).not.toHaveBeenCalled();
    emitInlineReturnCredit(p, "t1", { id: "cn-1" });
    expect(svc.emitCreditIssued).toHaveBeenCalledWith("t1", { id: "cn-1" });
    emitInlineReturnCredit(null, "t1", { id: "cn-1" });
    expect(svc.emitCreditIssued).toHaveBeenCalledTimes(1);
  });
});

describe("reserveInlineReturnNumber for a DRIVER (SA-261)", () => {
  it("reserves ahead like every role: a DRIVER_CAP hold mints no credit note and burns the number", async () => {
    const svc = svcStub();
    const p = await prepareInlineReturn(svc as any, LINES, { ...STAFF, role: "DRIVER" });
    await reserveInlineReturnNumber(p, "c1", STAFF);
    expect(svc.reserveCreditNoteNumber).toHaveBeenCalledTimes(1);
    expect(p!.creditNoteNumber).toBeDefined();
  });
});

describe("assertReplayCarriesReturn (#2094 R1)", () => {
  const db = (found: boolean) => ({
    return: { findFirst: jest.fn().mockResolvedValue(found ? { id: "ret-1" } : null) },
  });

  it("no inline return on the request and none on the order: a plain replay is unchanged", async () => {
    const d = db(false);
    await expect(assertReplayCarriesReturn(d, null, "ord-1")).resolves.toBeUndefined();
    expect(d.return.findFirst).toHaveBeenCalledWith({
      where: { orderId: "ord-1", kind: "INLINE" },
      select: { id: true },
    });
  });

  it("a replay WITHOUT a return of an order created WITH one: 409, never a silent 201 (W)", async () => {
    await expect(assertReplayCarriesReturn(db(true), null, "ord-1")).rejects.toThrow(
      ConflictException,
    );
  });

  it("the replayed order carries THIS returnKey: a true replay, allowed", async () => {
    const svc = svcStub();
    const p = await prepareInlineReturn(svc as any, LINES, STAFF);
    const d = db(true);
    await expect(assertReplayCarriesReturn(d, p, "ord-1")).resolves.toBeUndefined();
    expect(d.return.findFirst).toHaveBeenCalledWith({
      where: { returnKey: "k1", orderId: "ord-1", kind: "INLINE" },
      select: { id: true },
    });
  });

  it("the replayed order does NOT carry it (the return was edited, new nonce): 409, never a silent 201", async () => {
    const svc = svcStub();
    const p = await prepareInlineReturn(svc as any, { ...LINES, returnKey: "k2" }, STAFF);
    await expect(assertReplayCarriesReturn(db(false), p, "ord-1")).rejects.toThrow(
      ConflictException,
    );
  });
});

describe("assertReplayCarriesReturnKey / edit reserve / retry (#2094 A2)", () => {
  const db = (found: boolean) => ({
    return: { findFirst: jest.fn().mockResolvedValue(found ? { id: "r" } : null) },
  });

  it("no returnKey: never queried (a plain merge replay onto an order with earlier returns is fine)", async () => {
    const d = db(true);
    await expect(assertReplayCarriesReturnKey(d, undefined, "o1")).resolves.toBeUndefined();
    expect(d.return.findFirst).not.toHaveBeenCalled();
  });

  it("a returnKey the replayed order does not carry: 409", async () => {
    await expect(assertReplayCarriesReturnKey(db(false), "k9", "o1")).rejects.toThrow(
      ConflictException,
    );
  });

  it("reserveEditReturnNumber skips ONLY a same-return replay (null): a $0 preflight still reserves (SA-292)", async () => {
    for (const [total, expected] of [
      [null, 0],
      [0, 1],
      [25, 1],
    ] as const) {
      const svc = svcStub();
      const p = await prepareInlineReturn(svc as any, LINES, STAFF);
      p!.preflightTotal = total;
      await reserveEditReturnNumber(p);
      expect(svc.reserveCreditNoteNumber).toHaveBeenCalledTimes(expected);
    }
  });

  it("the edit tx never reserves a counter: the number reserved ahead is what the in-tx capture is handed, even when the preflight priced $0", async () => {
    const svc = svcStub();
    const p = await prepareInlineReturn(svc as any, LINES, STAFF);
    p!.preflightTotal = 0; // the stale-price race: dry-run 0, in-tx > 0
    await reserveEditReturnNumber(p);
    await applyInlineReturnInTx({}, p, { customerId: "c1", orderId: "o1", user: STAFF });
    expect(svc.reserveCreditNoteNumber).toHaveBeenCalledTimes(1); // once, ahead of the tx
    expect(svc.captureAndIssueInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      STAFF,
      expect.objectContaining({ creditNoteNumber: "CN-2026-0001" }),
    );
  });

  it("retryTxOnDeadlock: retries a deadlock twice then succeeds; gives up after 3 attempts; never retries without a return or on another error", async () => {
    const svc = svcStub();
    const p = await prepareInlineReturn(svc as any, LINES, STAFF);
    const dead = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const flaky = jest
      .fn()
      .mockRejectedValueOnce(dead)
      .mockRejectedValueOnce(dead)
      .mockResolvedValue("ok");
    await expect(retryTxOnDeadlock(p, flaky)).resolves.toBe("ok");
    const always = jest.fn().mockRejectedValue(dead);
    await expect(retryTxOnDeadlock(p, always)).rejects.toBe(dead);
    expect(always).toHaveBeenCalledTimes(3);
    const none = jest.fn().mockRejectedValue(dead);
    await expect(retryTxOnDeadlock(null, none)).rejects.toBe(dead);
    expect(none).toHaveBeenCalledTimes(1);
    const other = jest.fn().mockRejectedValue(new Error("boom"));
    await expect(retryTxOnDeadlock(p, other)).rejects.toThrow("boom");
    expect(other).toHaveBeenCalledTimes(1);
  });
});

describe("isRetryableTxError (#2094 W1)", () => {
  it.each([
    [{ code: "P2034" }],
    [{ code: "40P01" }],
    [{ meta: { code: "40P01" } }],
    [{ message: "ERROR: deadlock detected" }],
  ])("retries %j", (e) => expect(isRetryableTxError(e)).toBe(true));

  it.each([[{ code: "P2002" }], [new Error("boom")], [undefined], [{ code: "P2025" }]])(
    "does not retry %j",
    (e) => expect(isRetryableTxError(e)).toBe(false),
  );
});

describe("preflightInlineReturn (Opus R1)", () => {
  it("no inline return: nothing is touched", async () => {
    await expect(
      preflightInlineReturn(null, { id: "o", customerId: "c", routeRunId: null }, STAFF),
    ).resolves.toBeUndefined();
  });

  it("derives customer and order from the order, and hands the run to the driver check", async () => {
    const svc = { ...svcStub(), preflightCapture: jest.fn().mockResolvedValue(undefined) };
    const p = await prepareInlineReturn(svc as any, { ...LINES, customerId: "evil" }, STAFF);
    await preflightInlineReturn(
      p,
      { id: "ord-1", customerId: "cust-1", routeRunId: "run-1" },
      STAFF,
    );
    expect(svc.preflightCapture).toHaveBeenCalledWith(
      { ...LINES, customerId: "cust-1", orderId: "ord-1" },
      STAFF,
      { routeRunId: "run-1" },
    );
  });
});
