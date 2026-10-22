import { BadRequestException, ConflictException } from "@nestjs/common";
import { isPaymentKeyConflict } from "@routeflow/types/payment-submit-key";
import { optionalIdempotencyKey } from "../orders/counter-sale/required-idempotency-key";
import {
  advancePaymentKey,
  invoicePaymentKey,
  PaymentKeySettleMismatch,
  paymentRequestHash,
  standalonePaymentKey,
  withKeyHooks,
  withPaymentKey,
  type KeyedWriterOpts,
} from "./payment-idempotency";

/** SA-824: the header normaliser and the request hash the payment replay compares on. */
describe("SA-824 payment Idempotency-Key helpers", () => {
  describe("optionalIdempotencyKey (the orders/counter normaliser, optional)", () => {
    it("absent or blank is undefined: an old client keeps today's behaviour", () => {
      expect(optionalIdempotencyKey(undefined)).toBeUndefined();
      expect(optionalIdempotencyKey("   ")).toBeUndefined();
    });

    it("trims and keeps 1-128 printable ASCII", () => {
      expect(optionalIdempotencyKey("  abc-123  ")).toBe("abc-123");
      expect(optionalIdempotencyKey("k".repeat(128))).toBe("k".repeat(128));
    });

    it("refuses a key with spaces, non-ASCII or over 128 characters (400)", () => {
      for (const bad of ["a b", "clé", "k".repeat(129)]) {
        expect(() => optionalIdempotencyKey(bad)).toThrow(BadRequestException);
      }
    });
  });

  describe("paymentRequestHash", () => {
    const base: {
      customerId: string;
      totalAmount: number;
      method: string;
      paidAt: string;
      reference: string;
      allocations: Array<{ invoiceId: string; amount: number }>;
      status?: string;
      bankCharges?: number;
      settledAt?: string;
    } = {
      customerId: "c1",
      totalAmount: 100,
      method: "CASH",
      paidAt: "2026-10-20T15:00:00.000Z",
      reference: "r1",
      allocations: [
        { invoiceId: "i1", amount: 40 },
        { invoiceId: "i2", amount: 60 },
      ],
    };
    const h = (over: Partial<typeof base> = {}) =>
      paymentRequestHash(standalonePaymentKey({ ...base, ...over }).req);

    it("is insensitive to allocation order, sub-cent noise and the paid time of day", () => {
      expect(h({ allocations: [...base.allocations].reverse() })).toBe(h());
      expect(h({ totalAmount: 100.004 })).toBe(h());
      expect(h({ paidAt: "2026-10-20T09:00:00.000Z" })).toBe(h());
      expect(h({ reference: "  r1 " })).toBe(h());
      expect(h({ status: "PAID" })).toBe(h()); // absent = PAID, the writers' default
    });

    it("changes with the amount (in cents), method, paid date, reference, customer or an allocation", () => {
      const variants = [
        h({ totalAmount: 100.01 }),
        h({ method: "CHECK" }),
        h({ paidAt: "2026-10-21" }),
        h({ reference: "r2" }),
        h({ customerId: "c2" }),
        h({ allocations: [{ invoiceId: "i1", amount: 100 }] }),
        h({ status: "DRAFT" }),
        h({ bankCharges: 1.5 }),
        h({ settledAt: "2026-10-25" }),
      ];
      expect(new Set([h(), ...variants]).size).toBe(variants.length + 1);
    });

    it("each writer names its own scope", () => {
      const dto = { amount: 10, method: "CASH" };
      expect(standalonePaymentKey(base).scope).toBe("STANDALONE_PAYMENT");
      expect(invoicePaymentKey("i1", dto).scope).toBe("INVOICE_PAYMENT");
      expect(advancePaymentKey("c1", dto).scope).toBe("ADVANCE_PAYMENT");
    });
  });

  describe("withKeyHooks", () => {
    it("no hooks: the caller's opts pass through untouched", () => {
      const opts: KeyedWriterOpts<unknown> & { actor: string } = { actor: "u1" };
      expect(withKeyHooks(opts, undefined)).toBe(opts);
    });

    it("hooks: claim is set, and the caller's inTx runs BEFORE the key's settle, with the same refs", async () => {
      const order: string[] = [];
      const opts = withKeyHooks<{ ok: true }, any>(
        { inTx: async () => void order.push("caller") },
        {
          claim: async () => void order.push("claim"),
          settle: async (_tx, _r, refs) => void order.push(`settle:${refs?.advancePaymentId}`),
        },
      );
      await opts!.claim!({});
      await opts!.inTx!({}, { ok: true }, { advancePaymentId: "adv-1" });
      expect(order).toEqual(["claim", "caller", "settle:adv-1"]);
    });
  });
  describe("withPaymentKey", () => {
    const req = { invoiceId: "i1", amount: 10, method: "CASH" };
    const depsWith = (row: unknown, executeRaw: jest.Mock = jest.fn()) => ({
      getTenantId: () => "t1",
      forTenant: () => ({ paymentIdempotencyKey: { findFirst: jest.fn().mockResolvedValue(row) } }),
      executeRaw,
    });

    it("the 409 a different-body reuse throws is EXACTLY what the clients' isPaymentKeyConflict matches (one PAYMENT_MISMATCH constant)", async () => {
      const stored = {
        state: "COMPLETED",
        scope: "INVOICE_PAYMENT",
        requestHash: "another-hash",
        result: {},
      };
      const thrown = await withPaymentKey(
        depsWith(stored),
        "key-1",
        "INVOICE_PAYMENT",
        req,
        jest.fn(),
      ).catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(ConflictException);
      const body = (thrown as ConflictException).getResponse() as Record<string, unknown>;
      expect(body).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT", reason: "PAYMENT_MISMATCH" });
      // the client reads the server's real body, not a hand-copied literal
      expect(
        isPaymentKeyConflict({
          response: { status: (thrown as ConflictException).getStatus(), data: body },
        }),
      ).toBe(true);
      expect(
        isPaymentKeyConflict({ response: { status: 409, data: { ...body, reason: "OTHER" } } }),
      ).toBe(false);
    });

    it("settle: the COMPLETED update must change exactly 1 row; 0 or 2 throw so the money rolls back", async () => {
      const run = async (rows: number) => {
        const tx = {
          $queryRaw: jest.fn().mockResolvedValue([{ id: "claimed" }]),
          $executeRaw: jest.fn().mockResolvedValue(rows),
        };
        return withPaymentKey(depsWith(null), "key-2", "INVOICE_PAYMENT", req, async (hooks) => {
          await hooks!.claim(tx);
          await hooks!.settle(tx, { paymentGroupId: "g1" });
          return { ok: true };
        });
      };
      await expect(run(1)).resolves.toEqual({ ok: true });
      await expect(run(0)).rejects.toBeInstanceOf(PaymentKeySettleMismatch);
      await expect(run(2)).rejects.toThrow(/expected exactly 1/);
    });
  });
});
