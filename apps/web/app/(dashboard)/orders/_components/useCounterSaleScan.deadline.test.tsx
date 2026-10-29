import { act, renderHook, waitFor } from "@testing-library/react";
import { SCAN_LOOKUP_TIMEOUT_MS } from "@/lib/barcode-resolve";
import { useCounterSaleScan } from "./useCounterSaleScan";

/**
 * Row 541 (counter half): the till's FIFO scan queue pauses behind a Retry when a lookup FAILS, but a lookup that never
 * answered never failed, so the till waited on it for good. Every counter lookup now has the shared deadline, so a
 * stuck one ends as a failure: the queue pauses with its existing retry cue and nothing is added.
 */
const mockResolve = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: (code: string, opts?: unknown) => mockResolve(code, opts),
}));

const timeoutError = () =>
  Object.assign(new Error(`timeout of ${SCAN_LOOKUP_TIMEOUT_MS}ms exceeded`), {
    code: "ECONNABORTED",
  });

beforeEach(() => jest.clearAllMocks());

it("every counter lookup is given the shared deadline", async () => {
  mockResolve.mockResolvedValue({ product: { id: "p1", name: "Cola" }, source: "barcode" });
  const add = jest.fn();
  const { result } = renderHook(() =>
    useCounterSaleScan({ locked: false, add, refocus: jest.fn() }),
  );
  act(() => result.current.submit("012345678905"));
  await waitFor(() => expect(add).toHaveBeenCalled());
  expect(mockResolve).toHaveBeenCalledWith("012345678905", { timeoutMs: SCAN_LOOKUP_TIMEOUT_MS });
});

it("a timed-out lookup pauses the queue behind the retry cue and adds nothing", async () => {
  mockResolve.mockRejectedValue(timeoutError());
  const add = jest.fn();
  const { result } = renderHook(() =>
    useCounterSaleScan({ locked: false, add, refocus: jest.fn() }),
  );
  act(() => result.current.submit("012345678905"));
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(add).not.toHaveBeenCalled();
});
