/**
 * api-client's offline-enqueue branch, hardened (F30 · REG-B196).
 *
 * T-B196a: any no-response axios error — the 15s ECONNABORTED timeout
 * included — is classified as "offline" and silently enqueued today, with
 * NO check of the app's actual connectivity (api-client.ts:125-131). A
 * POST /orders that merely times out while the device is online must NOT be
 * queued: the operator still has the full cart open and needs the failure
 * to surface immediately (S1's duplicate-or-vanish chain starts here).
 *
 * T-B196b: useNetworkSync's drain loop replays a queued action through a
 * brand-new `apiClient.request({...})` config with no marker carried over
 * from the original attempt. If that replay also times out, today's
 * interceptor cannot tell it apart from a fresh request and enqueues a
 * SECOND, duplicate entry — the queue self-duplicates, and each copy
 * re-applies the mutation on the next drain. The fix marks a replay's
 * request (lib/queue-drain.ts's `buildReplayRequestConfig`, REG-B196) so the
 * interceptor's existing `!original?._offlineQueued` guard recognizes it.
 *
 * House convention (session-expired-wiring.test.ts): grab the response
 * interceptor's `rejected` handler directly off the live axios instance
 * instead of mocking axios itself.
 */

jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));

const mockEnqueue = jest.fn();
let mockIsOnline = true;
jest.mock("../store/offlineQueue", () => ({
  useOfflineQueue: {
    getState: () => ({ enqueue: mockEnqueue, isOnline: mockIsOnline }),
  },
}));

import { readFileSync } from "fs";
import { join } from "path";
import { AxiosHeaders } from "axios";
import { apiClient } from "../lib/api-client";
import { buildReplayRequestConfig } from "../lib/queue-drain";
import {
  clearAllOrderSubmitKeys,
  getOrderSubmitKey,
  resetOrderSubmitKey,
} from "../lib/order-submit-key";
import type { QueuedAction } from "../store/offlineQueue";

/** The single response interceptor's rejection branch, straight off axios. */
function responseRejectedHandler(): (err: unknown) => Promise<unknown> {
  const handlers = (apiClient.interceptors.response as unknown as { handlers: any[] }).handlers;
  return handlers[0]!.rejected;
}

/** An axios ECONNABORTED timeout: no `response`, but `request` is set. */
function fakeTimeout(config: Record<string, unknown>) {
  return {
    config,
    request: {},
    code: "ECONNABORTED",
    message: "timeout of 15000ms exceeded",
  };
}

describe("api-client — offline-enqueue hardening (REG-B196)", () => {
  beforeEach(() => {
    mockEnqueue.mockClear();
    mockIsOnline = true;
  });

  it("T-B196a (REG-B196): a POST /orders timeout while online is NOT enqueued and surfaces the original failure", async () => {
    mockIsOnline = true;
    const originalError = fakeTimeout({
      url: "/orders",
      method: "post",
      headers: {},
      data: JSON.stringify({ lines: [] }),
    });

    // Must reject with the ORIGINAL error (visible failure path) — not the
    // wrapped "You are offline. Action queued." error the enqueue branch
    // produces today.
    await expect(responseRejectedHandler()(originalError)).rejects.toBe(originalError);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  /**
   * The other half of the same guard. Without this, deleting the enqueue
   * branch outright — or the store renaming `isOnline`, so `=== false` never
   * holds — leaves every assertion above green while a genuinely offline
   * POST /orders is silently dropped and the operator's cart is lost.
   */
  it("T-B196a (REG-B196): the same timeout while actually offline IS enqueued intact and rejects as queued", async () => {
    mockIsOnline = false;
    const body = { lines: [{ productId: "p-1", quantity: 2 }] };
    const originalError = fakeTimeout({
      url: "/orders",
      method: "post",
      headers: {},
      data: JSON.stringify(body),
    });

    await expect(responseRejectedHandler()(originalError)).rejects.toMatchObject({
      isOfflineQueued: true,
    });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "/orders", method: "POST", body }),
    );
  });

  it("T-B196b (REG-B196): a replayed action's request is marked so a timed-out replay retries the SAME entry, never a duplicate enqueue", async () => {
    // Offline, so the `isActuallyOffline` guard is satisfied and the
    // `_offlineQueued` marker is the ONLY thing standing between this replay
    // and a duplicate entry — otherwise this test passes for the wrong reason.
    mockIsOnline = false;
    const queued: QueuedAction = {
      id: "q-1",
      endpoint: "/orders",
      method: "POST",
      body: { lines: [] },
      timestamp: 1_000,
      retries: 1,
    };

    const replayConfig = buildReplayRequestConfig(queued);
    // Gating assertion — fails cleanly on the stub's `undefined` return
    // instead of crashing on a property read, until the real extraction
    // marks the config.
    expect(replayConfig).toBeTruthy();
    expect(replayConfig._offlineQueued).toBe(true);

    const replayTimeout = fakeTimeout({
      url: replayConfig.url,
      method: replayConfig.method,
      headers: replayConfig.headers ?? {},
      data: replayConfig.data,
      _offlineQueued: replayConfig._offlineQueued,
    });

    await expect(responseRejectedHandler()(replayTimeout)).rejects.toBeTruthy();

    // No second, duplicate queue entry — the drain loop's own retry counter
    // (incrementRetry on the SAME id) owns this outcome instead.
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  /**
   * T-B196c QUEUE LEG (R8). The mint/send wiring asserted below only survives
   * an OFFLINE submit if the interceptor carries the header into the queued
   * action — the drain replays from that persisted record, not from the
   * original config. Every other fake config in this file sets `headers: {}`,
   * so nothing else exercises api-client's preservation loop: deleting it, or
   * narrowing it to an exact-case `headers["idempotency-key"]` lookup, keeps
   * this whole file green while every offline-replayed cart lands as a second
   * order — the exact B196 leg R8 exists to close.
   *
   * Driven through a real `AxiosHeaders` (not a plain object) because that is
   * what `error.config.headers` actually is at interceptor time, and it keeps
   * the CALLER's casing as the own-property key — which is precisely why the
   * loop lowercases before comparing.
   */
  it("T-B196c (REG-B196): an offline POST /orders carries its Idempotency-Key into the queued action", async () => {
    mockIsOnline = false;
    // B215/R3: keys are per customer — this leg only needs one customer's slot.
    resetOrderSubmitKey("cust-1");
    const key = getOrderSubmitKey("cust-1");

    await expect(
      responseRejectedHandler()(
        fakeTimeout({
          url: "/orders",
          method: "post",
          // Capitalized deliberately — axios preserves the caller's casing.
          headers: AxiosHeaders.from({
            "Idempotency-Key": key,
            Authorization: "Bearer stale-token",
          }),
          data: JSON.stringify({ items: [{ productId: "p-1", qty: 2 }] }),
        }),
      ),
    ).rejects.toMatchObject({ isOfflineQueued: true });

    const queued = mockEnqueue.mock.calls[0]![0];
    expect(queued.headers).toEqual({ "Idempotency-Key": key });
    // Auth is re-attached by the request interceptor on replay. Freezing a
    // bearer token into a queue that persists to AsyncStorage would write a
    // credential to disk and replay it long after it expired.
    expect(queued.headers).not.toHaveProperty("Authorization");
  });

  it("T-B196c (REG-B196): a mutation with no Idempotency-Key queues with no headers field at all", async () => {
    mockIsOnline = false;

    await expect(
      responseRejectedHandler()(
        fakeTimeout({
          url: "/customers",
          method: "post",
          headers: AxiosHeaders.from({ Authorization: "Bearer x" }),
          data: JSON.stringify({ name: "Acme" }),
        }),
      ),
    ).rejects.toMatchObject({ isOfflineQueued: true });

    expect(mockEnqueue.mock.calls[0]![0]).not.toHaveProperty("headers");
  });

  /**
   * WIRING — T-B196b's marker only prevents the duplicate if the code that
   * REPLAYS a queued action actually uses it. `useNetworkSync.ts:45-50` builds
   * its replay by hand (`apiClient.request({ method, url, data, headers })`)
   * with no marker at all; a builder could implement
   * `buildReplayRequestConfig` and leave that call site untouched, turning the
   * test above green while the queue keeps self-duplicating.
   */
  it("T-B196b (REG-B196): the drain loop builds its replay through buildReplayRequestConfig", () => {
    const hookSrc = readFileSync(join(__dirname, "..", "hooks", "useNetworkSync.ts"), "utf8");
    expect(hookSrc).toMatch(/buildReplayRequestConfig/);
    // The hand-rolled config that loses the marker.
    expect(hookSrc).not.toMatch(/apiClient\.request\(\s*\{\s*\n?\s*method:\s*action\.method/);
  });
});

/**
 * T-B196c CLIENT LEG (R8). The server's replay store, its `Order.idempotencyKey`
 * column and the `@@unique([tenantId, idempotencyKey])` index are all dead
 * weight unless a client actually SENDS the header: `OrdersService.create`
 * skips both the pre-check and the P2002 replay branch when the key is
 * undefined, so a timed-out-but-committed POST /orders still creates a second
 * whole order. These lock the mint/reset rule and the two wiring points.
 */
describe("order submit key — the client leg of Idempotency-Key (T-B196c / R8)", () => {
  beforeEach(() => clearAllOrderSubmitKeys());

  it("reuses ONE key across every retry/replay of the same cart", () => {
    const first = getOrderSubmitKey("cust-1");
    expect(getOrderSubmitKey("cust-1")).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("mints a fresh key only once the cart session ends", () => {
    const first = getOrderSubmitKey("cust-1");
    resetOrderSubmitKey("cust-1");
    expect(getOrderSubmitKey("cust-1")).not.toBe(first);
  });

  it("NewOrderScreen sends the key on submit and resets it only on success", () => {
    const screenSrc = readFileSync(
      join(__dirname, "..", "components", "NewOrderScreen.tsx"),
      "utf8",
    );
    // B215/R3: both calls are CUSTOMER-scoped — a bare call would key every customer's cart
    // off one slot again, which is the wedge this round removed.
    expect(screenSrc).toMatch(/idempotencyKey:\s*getOrderSubmitKey\(customerId\)/);
    expect(screenSrc).toMatch(/resetOrderSubmitKey\(customerId\)/);
    expect(screenSrc).not.toMatch(/(get|reset)OrderSubmitKey\(\)/);
    // The pre-fix claim this batch invalidates.
    expect(screenSrc).not.toMatch(/no idempotency key on POST \/orders/);
  });

  it("useCreateOrderAsDriver forwards it as a HEADER, not in the body", () => {
    const apiSrc = readFileSync(join(__dirname, "..", "lib", "api", "orders.ts"), "utf8");
    expect(apiSrc).toMatch(/"idempotency-key":\s*idempotencyKey/);
    // Destructured OUT of the posted body — the server reads the header only.
    expect(apiSrc).toMatch(/mutationFn:\s*\(\{\s*idempotencyKey,\s*\.\.\.body\s*\}\)/);
  });
});
