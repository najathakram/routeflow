// The two settle calls in useCaptureInlineReturn (onSuccess / onError) tested behaviourally:
// the hook's mutation options are built by a pure-ish factory so deleting either settle call,
// or mis-wiring the variables, turns this red (Opus review of #1270, point 4).
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));
jest.mock("../store/offlineQueue", () => ({
  useOfflineQueue: { getState: () => ({ enqueue: jest.fn(), isOnline: true }) },
}));
jest.mock("../store/inlineReturnSubmissionStore", () => ({
  useInlineReturnSubmissionStore: (sel: (s: unknown) => unknown) =>
    sel({ settleCapture: jest.fn() }),
}));

import { buildCaptureMutationOptions } from "../lib/api/inline-returns";

const vars = { customerId: "c", orderId: "o", returnKey: "inl:c:o:n1" } as any;
const setup = () => {
  const settle = jest.fn();
  const qc = { invalidateQueries: jest.fn() };
  const opts = buildCaptureMutationOptions(qc as any, settle);
  return { settle, qc, opts };
};

it("onSuccess settles with success for THIS attempt's variables and invalidates the caches", () => {
  const { settle, qc, opts } = setup();
  opts.onSuccess!(
    { orderId: "o", customerId: "c" } as any,
    vars,
    undefined as any,
    undefined as any,
  );
  expect(settle).toHaveBeenCalledWith(vars, { kind: "success" });
  // Mobile's OWN query keys (lib/api/admin.ts, returns.ts, credit-notes.ts) — web's bare
  // ["orders"]/["customers"] keys are not used by any mobile screen, so refreshing them left the
  // order and returns screens stale.
  const keys = qc.invalidateQueries.mock.calls.map((c) => JSON.stringify(c[0].queryKey));
  expect(keys).toEqual(
    expect.arrayContaining([
      JSON.stringify(["admin", "orders", "o"]),
      JSON.stringify(["admin", "orders"]),
      JSON.stringify(["admin", "customers", "c"]),
      JSON.stringify(["admin", "returns"]),
      JSON.stringify(["returns"]),
      JSON.stringify(["credit-notes"]),
    ]),
  );
  expect(keys).not.toContain(JSON.stringify(["orders"]));
  expect(keys).not.toContain(JSON.stringify(["customers", "c"]));
});

it.each([
  [
    { response: { status: 400, data: { code: "INLINE_RETURN_ORDER_CANCELLED" } } },
    { kind: "error", refused: true },
  ],
  [{ response: { status: 403, data: {} } }, { kind: "error", refused: false }],
  [{ response: { status: 429, data: {} } }, { kind: "error", refused: false }],
  [{ response: { status: 503, data: {} } }, { kind: "error", refused: false }],
  [{ isOfflineQueued: true }, { kind: "queued" }],
])("onError %j settles with the REAL classifier's outcome", (err, outcome) => {
  const { settle, opts } = setup();
  opts.onError!(err as any, vars, undefined as any, undefined as any);
  expect(settle).toHaveBeenCalledWith(vars, outcome);
});

// #2420 (F2 at 27271e9c, the #2265 class): a capture confirmed OFFLINE sat as a spinner — TanStack's
// default networkMode "online" PAUSED the mutation, so the api-client interceptor never queued it
// and the screen never showed "Saved offline". The capture must fail fast offline like the driver's
// critical calls (lib/live-online.ts DRIVER_CRITICAL_NETWORK_MODE).
it("#2420: the capture mutation never pauses offline (networkMode 'always')", () => {
  const { opts } = setup();
  expect(opts.networkMode).toBe("always");
});
