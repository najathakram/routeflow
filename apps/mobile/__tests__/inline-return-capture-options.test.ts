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
  expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["returns"] });
  expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["credit-notes"] });
});

it.each([
  [{ response: { status: 403, data: {} } }, { kind: "error", refused: true }],
  [{ response: { status: 429, data: {} } }, { kind: "error", refused: false }],
  [{ response: { status: 503, data: {} } }, { kind: "error", refused: false }],
  [{ isOfflineQueued: true }, { kind: "queued" }],
])("onError %j settles with the REAL classifier's outcome", (err, outcome) => {
  const { settle, opts } = setup();
  opts.onError!(err as any, vars, undefined as any, undefined as any);
  expect(settle).toHaveBeenCalledWith(vars, outcome);
});
