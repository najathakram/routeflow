import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PaymentKeyStatusController } from "./payment-key-status.controller";
import { PaymentKeyStatusService } from "./payment-key-status.service";

/**
 * SA-824 (SA condition a/b): GET /invoices/payments/by-key/:key. The server-definitive answer about a
 * payment Idempotency-Key after a lost response: the stored result with CURRENT statuses, or 404
 * PAYMENT_KEY_NOT_FOUND (nothing recorded). Tenant-scoped and read-only.
 */
type Row = {
  tenantId: string;
  key: string;
  scope: string | null;
  result: Record<string, unknown>;
  /** SA-824 race ruling 1 (absent = COMPLETED, the only committed state before the ruling). */
  state?: "CLAIMED" | "COMPLETED" | "TOMBSTONED";
};

function build(tenant: string | null, rows: Row[]) {
  const writes = {
    create: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  };
  const live = {
    payments: [{ id: "pay-1", status: "VOIDED", checkStatus: null }],
    invoice: { status: "PARTIALLY_PAID", paidAt: null as Date | null },
    advance: { balance: 12.5 },
  };
  const scoped = {
    paymentIdempotencyKey: {
      findFirst: jest.fn(async (a: { where: { key: string } }) => {
        const r = rows.find((x) => x.tenantId === tenant && x.key === a.where.key);
        return r
          ? { scope: r.scope, requestHash: "h", result: r.result, state: r.state ?? "COMPLETED" }
          : null;
      }),
      ...writes,
    },
    invoicePayment: { findMany: jest.fn(async () => live.payments), ...writes },
    invoice: { findFirst: jest.fn(async () => live.invoice), ...writes },
    advancePayment: { findFirst: jest.fn(async () => live.advance), ...writes },
  };
  const prisma = { getTenantId: () => tenant, forTenant: () => scoped, ...writes };
  const audit = { log: jest.fn() };
  const service = new (PaymentKeyStatusService as any)(prisma, audit) as PaymentKeyStatusService;
  return { service, controller: new PaymentKeyStatusController(service), writes, scoped };
}

const standalone: Row = {
  tenantId: "tA",
  key: "k-1",
  scope: "STANDALONE_PAYMENT",
  result: { paymentGroupId: "g1", payments: [{ id: "pay-1", status: "RECORDED" }] },
};

describe("SA-824 GET /invoices/payments/by-key/:key", () => {
  it("found: the stored result with each payment's CURRENT status, replayed:true, scope named", async () => {
    const { controller } = build("tA", [standalone]);
    const out: any = await controller.byKey("k-1");
    expect(out.paymentGroupId).toBe("g1");
    expect(out.payments[0].status).toBe("VOIDED");
    expect(out.replayed).toBe(true);
    expect(out.scope).toBe("STANDALONE_PAYMENT");
    expect(out.state).toBe("found"); // SA-824 race ruling: the same body the resolve answers
  });

  it("a TOMBSTONED key (closed by resolve): { state: 'tombstoned' }, never a payment and never a 404", async () => {
    const row: Row = { tenantId: "tA", key: "k-t", scope: null, result: {}, state: "TOMBSTONED" };
    expect(await build("tA", [row]).controller.byKey("k-t")).toEqual({ state: "tombstoned" });
  });

  it("a committed CLAIMED row (never settled): 409 PAYMENT_KEY_IN_FLIGHT, never 'found' with an empty result", async () => {
    const row: Row = { ...standalone, result: {}, state: "CLAIMED" };
    const err: any = await build("tA", [row])
      .controller.byKey("k-1")
      .catch((e) => e);
    expect(err?.getStatus?.()).toBe(409);
    expect(err.getResponse().code).toBe("PAYMENT_KEY_IN_FLIGHT");
  });

  it("found (invoice scope): the invoice's current status and paidAt overlay the stored one", async () => {
    const row: Row = {
      tenantId: "tA",
      key: "k-2",
      scope: "INVOICE_PAYMENT",
      result: { id: "inv-1", status: "PAID", payments: [] },
    };
    const out: any = await build("tA", [row]).controller.byKey("k-2");
    expect(out.status).toBe("PARTIALLY_PAID");
  });

  it("found (advance scope): the advance's current balance", async () => {
    const row: Row = {
      tenantId: "tA",
      key: "k-3",
      scope: "ADVANCE_PAYMENT",
      result: { id: "adv-1", balance: 50 },
    };
    const out: any = await build("tA", [row]).controller.byKey("k-3");
    expect(out.balance).toBe(12.5);
  });

  it("not found: 404 PAYMENT_KEY_NOT_FOUND, the server-definitive 'nothing recorded'", async () => {
    const { controller } = build("tA", [standalone]);
    const err: any = await controller.byKey("nope").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.getResponse().code).toBe(API_ERROR_CODES.PAYMENT_KEY_NOT_FOUND);
    expect(API_ERROR_CODES.PAYMENT_KEY_NOT_FOUND).toBe("PAYMENT_KEY_NOT_FOUND");
  });

  it("another tenant's key is a 404, never its payment", async () => {
    const { controller } = build("tB", [standalone]);
    await expect(controller.byKey("k-1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a malformed key is a 400 (the shared normaliser), blank too", async () => {
    const { controller, scoped } = build("tA", [standalone]);
    for (const bad of ["a b", "k".repeat(129), "  "]) {
      await expect(controller.byKey(bad)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(scoped.paymentIdempotencyKey.findFirst).not.toHaveBeenCalled();
  });

  it("no tenant on the session: refused, never an unscoped read", async () => {
    const { controller } = build(null, [standalone]);
    await expect(controller.byKey("k-1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("writes nothing, found or not", async () => {
    const { controller, writes } = build("tA", [standalone]);
    await controller.byKey("k-1");
    await controller.byKey("nope").catch(() => undefined);
    for (const fn of Object.values(writes)) expect(fn).not.toHaveBeenCalled();
  });
});
