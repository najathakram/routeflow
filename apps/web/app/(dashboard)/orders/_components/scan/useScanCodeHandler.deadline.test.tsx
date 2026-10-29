import { act, renderHook } from "@testing-library/react";
import {
  SCAN_LOOKUP_TIMEOUT_MS,
  useScanCodeHandler,
  type ScanCodeHandlerDeps,
} from "./useScanCodeHandler";
import { createSerialScanQueue } from "./serial-scan-queue";

/**
 * Row 541: a lookup that never answered held the order builder's ONE FIFO scan queue, so every later scan waited
 * behind it with no cue. The handler now gives each lookup a deadline (SCAN_LOOKUP_TIMEOUT_MS, the axios timeout).
 * A timed-out lookup is a connectivity error: it commits nothing, says which code was skipped, and the queue moves on.
 */
const mockResolve = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: (code: string, opts?: unknown) => mockResolve(code, opts),
}));

const product = { id: "p1", name: "Widget" };
const timeoutError = () =>
  Object.assign(new Error(`timeout of ${SCAN_LOOKUP_TIMEOUT_MS}ms exceeded`), {
    code: "ECONNABORTED",
  });
const deps = (over: Partial<ScanCodeHandlerDeps> = {}): ScanCodeHandlerDeps => ({
  addLineItem: jest.fn(),
  onUnknownCode: jest.fn(),
  toast: jest.fn(),
  ...over,
});

beforeEach(() => jest.clearAllMocks());

it("every lookup is given the deadline", async () => {
  mockResolve.mockResolvedValue({ product });
  const d = deps();
  const { result } = renderHook(() => useScanCodeHandler(d));
  await act(async () => {
    await result.current.current("0123");
  });
  expect(mockResolve).toHaveBeenCalledWith("0123", { timeoutMs: SCAN_LOOKUP_TIMEOUT_MS });
  expect(SCAN_LOOKUP_TIMEOUT_MS).toBeGreaterThanOrEqual(3000);
  expect(SCAN_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(10000);
});

it("a timed-out lookup commits nothing, names the code it skipped, and is a retryable (offline) error", async () => {
  mockResolve.mockRejectedValue(timeoutError());
  const d = deps();
  const { result } = renderHook(() => useScanCodeHandler(d));
  let out: unknown;
  await act(async () => {
    out = await result.current.current("0123");
  });
  expect(out).toEqual(expect.objectContaining({ kind: "error", offline: true }));
  expect(d.addLineItem).not.toHaveBeenCalled();
  expect(d.onUnknownCode).not.toHaveBeenCalled();
  expect(d.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      variant: "error",
      title: "Couldn't look up the code",
      description: "The lookup for 0123 took too long. Scan it again.",
    }),
  );
});

it("in the FIFO queue, a stuck first scan no longer holds the next one", async () => {
  // the first lookup only ever ends by its deadline; the second answers at once
  mockResolve.mockImplementation((code: string) =>
    code === "STUCK" ? Promise.reject(timeoutError()) : Promise.resolve({ product }),
  );
  const d = deps();
  const { result } = renderHook(() => useScanCodeHandler(d));
  const queue = createSerialScanQueue((code: string) => result.current.current(code));
  await act(async () => {
    await Promise.allSettled([queue.enqueue("STUCK"), queue.enqueue("0456")]);
  });
  expect(d.addLineItem).toHaveBeenCalledTimes(1);
  expect(d.addLineItem).toHaveBeenCalledWith(product, expect.anything());
});
