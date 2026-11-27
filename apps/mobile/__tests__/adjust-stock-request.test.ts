/**
 * B1415 M1b (SA-1504 R5): the Adjust stock sheet sends ONE Idempotency-Key per attempt, as a header. The key goes into
 * the args once per sheet open and resets on success, so two taps carry identical args (and collapse), a retry of an
 * unknown outcome carries the same key, and a deliberate second adjustment after a success gets a fresh one.
 */
import { ADJUSTMENT_KEY_REUSED_COPY, isAdjustmentKeyReused } from "@routeflow/types/sale-attempt";
import * as fs from "fs";
import * as path from "path";
import {
  adjustmentFingerprint,
  adjustmentRequest,
  createAdjustmentAttemptKey,
  submitAdjustment,
  type AdjustmentMutateCallbacks,
} from "../lib/adjust-stock-request";

let n = 0;
const holder = () => createAdjustmentAttemptKey(() => `key-${++n}`);
const apiError = (status: number) => ({ response: { status, data: {} } });
const dto = { productId: "p1", quantity: 5, reference: "COUNT", notes: "COUNT — shelf" };

/** What the screen does on Apply: the key for this body, folded into the mutation args. */
const args = (h: ReturnType<typeof holder>, body: typeof dto) => ({
  ...body,
  idempotencyKey: h.keyFor(adjustmentFingerprint(body)),
});
const reused = {
  response: {
    status: 409,
    data: { code: "IDEMPOTENCY_KEY_CONFLICT", reason: "ADJUSTMENT_MISMATCH" },
  },
};

describe("the adjustment key lifecycle (one sheet open)", () => {
  it("two taps carry identical args", () => {
    const h = holder();
    expect(args(h, dto)).toEqual(args(h, { ...dto }));
    expect(JSON.stringify(args(h, dto))).toBe(JSON.stringify(args(h, { ...dto })));
  });

  it("the key does not change with the order the body's fields were built in", () => {
    const h = holder();
    const a = h.keyFor(adjustmentFingerprint(dto));
    const b = h.keyFor(
      adjustmentFingerprint({
        notes: dto.notes,
        reference: dto.reference,
        quantity: 5,
        productId: "p1",
      }),
    );
    expect(b).toBe(a);
  });

  it("a retry after a dropped connection or a 5xx keeps the key", () => {
    const h = holder();
    const first = args(h, dto).idempotencyKey;
    h.settle(first, { ok: false, error: new Error("Network Error") });
    expect(args(h, dto).idempotencyKey).toBe(first);
    h.settle(first, { ok: false, error: apiError(503) });
    expect(args(h, dto).idempotencyKey).toBe(first);
  });

  it("a success resets it: the next deliberate adjustment is fresh", () => {
    const h = holder();
    const first = args(h, dto).idempotencyKey;
    h.settle(first, { ok: true });
    expect(h.peek()).toBeNull();
    expect(args(h, dto).idempotencyKey).not.toBe(first);
  });

  it("a refusal that wrote nothing (a 400) drops the key too", () => {
    const h = holder();
    const first = args(h, dto).idempotencyKey;
    h.settle(first, { ok: false, error: apiError(400) });
    expect(args(h, dto).idempotencyKey).not.toBe(first);
  });

  it("an edited body with nothing unknown is a different attempt with a new key", () => {
    const h = holder();
    const first = args(h, dto).idempotencyKey;
    expect(args(h, { ...dto, quantity: 6 }).idempotencyKey).not.toBe(first);
  });

  it("a refusal that wrote nothing, then an edit: a fresh key", () => {
    const h = holder();
    const first = args(h, dto).idempotencyKey;
    h.settle(first, { ok: false, error: apiError(400) });
    expect(args(h, { ...dto, quantity: 6 }).idempotencyKey).not.toBe(first);
  });

  it("an UNKNOWN outcome, then an edit: the same key (the first call may have landed)", () => {
    const h = holder();
    const first = args(h, dto).idempotencyKey; // +5, a network error: it may have landed
    h.settle(first, { ok: false, error: new Error("Network Error") });
    expect(args(h, { ...dto, quantity: 50 }).idempotencyKey).toBe(first); // the server will answer 409
    h.settle(first, { ok: false, error: apiError(502) });
    expect(args(h, { ...dto, quantity: 7 }).idempotencyKey).toBe(first);
  });

  it("after an unknown outcome a plain refusal keeps the key", () => {
    const h = holder();
    const first = args(h, dto).idempotencyKey;
    h.settle(first, { ok: false, error: new Error("timeout") });
    h.settle(first, { ok: false, error: apiError(400) });
    expect(args(h, { ...dto, quantity: 6 }).idempotencyKey).toBe(first);
  });

  it("unknown, then the key-reuse 409: the key and the unknown state are cleared, and the copy is plain", () => {
    const h = holder();
    const first = args(h, dto).idempotencyKey;
    h.settle(first, { ok: false, error: new Error("Network Error") });
    expect(isAdjustmentKeyReused(reused)).toBe(true);
    expect(isAdjustmentKeyReused(apiError(409))).toBe(false);
    // an order-scoped CONFLICT (or a payment one) is never an adjustment
    expect(
      isAdjustmentKeyReused({
        response: {
          status: 409,
          data: { code: "IDEMPOTENCY_KEY_CONFLICT", reason: "CART_MISMATCH" },
        },
      }),
    ).toBe(false);
    expect(
      isAdjustmentKeyReused({
        response: { status: 409, data: { code: "IDEMPOTENCY_KEY_CONFLICT" } },
      }),
    ).toBe(false);
    h.settle(first, { ok: false, error: reused });
    expect(h.peek()).toBeNull();
    expect(args(h, { ...dto, quantity: 6 }).idempotencyKey).not.toBe(first);
    expect(ADJUSTMENT_KEY_REUSED_COPY).toBe(
      "Your earlier adjustment was saved. Check the stock before you save again.",
    );
  });

  it("a settle for a key that is no longer held does nothing (a slow older call cannot clear a newer attempt)", () => {
    const h = holder();
    const k1 = args(h, dto).idempotencyKey; // A in flight
    const k2 = args(h, { ...dto, quantity: 6 }).idempotencyKey; // edit, B in flight
    expect(k2).not.toBe(k1);
    h.settle(k1, { ok: true }); // A succeeds late
    expect(h.peek()).toBe(k2);
    h.settle(k1, { ok: false, error: new Error("Network Error") });
    expect(args(h, { ...dto, quantity: 9 }).idempotencyKey).not.toBe(k2); // A's failure did not make B unknown
  });

  it("a new sheet open is a new holder: a new key", () => {
    expect(args(holder(), dto).idempotencyKey).not.toBe(args(holder(), dto).idempotencyKey);
  });
});

describe("adjustmentRequest: the key is a header, never in the body", () => {
  it("splits the key off the dto", () => {
    const { body, config } = adjustmentRequest({ ...dto, idempotencyKey: "k-1" });
    expect(body).toEqual(dto);
    expect("idempotencyKey" in body).toBe(false);
    expect(config).toEqual({ headers: { "Idempotency-Key": "k-1" } });
  });

  it("without a key it sends the plain body and no config (a legacy caller)", () => {
    expect(adjustmentRequest(dto)).toEqual({ body: dto, config: undefined });
  });
});

describe("submitAdjustment: what the sheet does on Apply (R-342 M1)", () => {
  /** A mutate that records its args and lets the test end each call. */
  function recorder() {
    const calls: { args: Record<string, unknown>; cb: AdjustmentMutateCallbacks }[] = [];
    const mutate = (args: Record<string, unknown>, cb: AdjustmentMutateCallbacks) =>
      void calls.push({ args, cb });
    return { calls, mutate };
  }
  const then = () => ({ success: jest.fn(), error: jest.fn() });

  it("mints one key per adjust intent and folds it into the args, with the body unchanged", () => {
    const h = holder();
    const m = recorder();
    submitAdjustment(h, dto, m.mutate, then());
    submitAdjustment(h, { ...dto }, m.mutate, then()); // the second tap
    expect(m.calls).toHaveLength(2);
    const key = m.calls[0].args.idempotencyKey;
    expect(typeof key).toBe("string");
    expect(m.calls[0].args).toEqual({ ...dto, idempotencyKey: key });
    expect(m.calls[1].args).toEqual(m.calls[0].args);
  });

  it("a retry after an unknown outcome reuses the key; a success clears it, so the next intent is fresh", () => {
    const h = holder();
    const m = recorder();
    const t = then();
    submitAdjustment(h, dto, m.mutate, t);
    const key = m.calls[0].args.idempotencyKey;
    const dropped = new Error("Network Error");
    m.calls[0].cb.onError(dropped);
    expect(t.error).toHaveBeenCalledWith(dropped);
    submitAdjustment(h, dto, m.mutate, t);
    expect(m.calls[1].args.idempotencyKey).toBe(key);
    m.calls[1].cb.onSuccess();
    expect(t.success).toHaveBeenCalledTimes(1);
    expect(h.peek()).toBeNull();
    submitAdjustment(h, dto, m.mutate, t);
    expect(m.calls[2].args.idempotencyKey).not.toBe(key);
  });

  it("the key-reuse 409 clears the key and reaches the error callback", () => {
    const h = holder();
    const m = recorder();
    const t = then();
    submitAdjustment(h, dto, m.mutate, t);
    m.calls[0].cb.onError(reused);
    expect(h.peek()).toBeNull();
    expect(t.error).toHaveBeenCalledWith(reused);
  });

  it("the Adjust stock sheet applies through submitAdjustment with its one holder per open", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "app", "(operator)", "products", "[id]", "adjust-stock.tsx"),
      "utf8",
    );
    expect(src).toContain("const [attempt] = useState(createAdjustmentAttemptKey)");
    expect(src).toContain("submitAdjustment(attempt, dto, mut.mutate,");
    // the screen never posts around the helper (that would send an adjustment with no key)
    expect(src).not.toContain("mut.mutate(");
    expect(src).not.toContain("mut.mutateAsync(");
  });
});
