/**
 * B1205 (review hold): a queued offline POST /orders carrying appliedCreditNotes that the server
 * answers 503 ORDER_SAVED_CREDITS_PENDING was SAVED. Retrying replays the same idempotency key,
 * returns 200 and the credits were silently dropped. The drain must classify it delivered-with-
 * warning (never retried) and also warn on a replayed 2xx carrying `creditsPending: true`.
 */
import type { QueuedAction } from "../store/offlineQueue";
import { drainQueue, describeCreditsPendingDrain } from "../lib/queue-drain";
import { CREDITS_PENDING_COPY } from "@routeflow/types";

const entry = (id: string): QueuedAction => ({
  id,
  endpoint: "/orders",
  method: "POST",
  body: { appliedCreditNotes: [{ creditNoteId: "c1" }] },
  timestamp: 1,
  retries: 0,
});

const httpError = (status: number, data?: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });

describe("drainQueue — credits pending (B1205)", () => {
  it("503 ORDER_SAVED_CREDITS_PENDING is delivered with a warning, never retried", async () => {
    const request = jest.fn(async () => {
      throw httpError(503, { code: "ORDER_SAVED_CREDITS_PENDING", orderId: "o1" });
    });
    const r = await drainQueue([entry("q1")], { request, notifyFailed: jest.fn() });
    expect(r.retriedIds).toEqual([]);
    expect(r.failedActions).toEqual([]);
    expect(r.delivered).toEqual(["q1"]);
    expect(r.creditsPending).toEqual([
      {
        action: expect.objectContaining({ id: "q1" }),
        orderId: "o1",
        message: CREDITS_PENDING_COPY,
      },
    ]);
  });

  it("a replayed 200 with creditsPending true is delivered WITH the warning", async () => {
    const request = jest.fn(async () => ({ id: "o2", creditsPending: true }));
    const r = await drainQueue([entry("q2")], { request, notifyFailed: jest.fn() });
    expect(r.delivered).toEqual(["q2"]);
    expect(r.creditsPending).toEqual([
      {
        action: expect.objectContaining({ id: "q2" }),
        orderId: "o2",
        message: CREDITS_PENDING_COPY,
      },
    ]);
  });

  it("a plain 200, and a plain 503, are unchanged", async () => {
    const ok = await drainQueue([entry("q3")], {
      request: async () => ({ id: "o3" }),
      notifyFailed: jest.fn(),
    });
    expect(ok.delivered).toEqual(["q3"]);
    expect(ok.creditsPending).toEqual([]);
    const bad = await drainQueue([entry("q4")], {
      request: async () => {
        throw httpError(503, { code: "LOCK_UNAVAILABLE" });
      },
      notifyFailed: jest.fn(),
    });
    expect(bad.retriedIds).toEqual(["q4"]);
    expect(bad.creditsPending).toEqual([]);
  });
});

describe("describeCreditsPendingDrain", () => {
  const rec = (id: string, orderId: string) => ({
    action: entry(id),
    orderId,
    message: CREDITS_PENDING_COPY,
  });
  it("one order: the fixed copy alone, that order opens", () => {
    expect(describeCreditsPendingDrain([rec("q1", "o1")])).toEqual({
      title: "Order saved",
      message: CREDITS_PENDING_COPY,
      orderId: "o1",
    });
  });
  it("several: a neutral count line, the fixed copy byte-identical, first order opens", () => {
    const d = describeCreditsPendingDrain([rec("q1", "o1"), rec("q2", "o2"), rec("q3", "o3")]);
    expect(d.title).toBe("3 orders saved");
    expect(d.message).toBe(`3 orders were saved.\n\n${CREDITS_PENDING_COPY}`);
    expect(d.orderId).toBe("o1");
  });
});
