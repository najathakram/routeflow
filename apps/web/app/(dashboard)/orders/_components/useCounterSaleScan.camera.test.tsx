import { act, renderHook, waitFor } from "@testing-library/react";
import { playScanCue } from "@/lib/scan-cue";
import { useCounterSaleScan } from "./useCounterSaleScan";

/**
 * SA-1059: `submitCamera` is the camera's entry to the till's ONE scan queue. A decoded code is looked up whole (never parsed
 * as typed text), leaves the typed-quantity carry alone, keeps queue order with the wedge, and is the only kind of scan that
 * is answered by a sound.
 */
jest.mock("@/lib/scan-cue", () => ({ playScanCue: jest.fn(), unlockScanCue: jest.fn() }));
const mockResolve = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: (code: string) => mockResolve(code),
}));
jest.mock("@/lib/counter-category-search", () => ({
  fetchCategoryPage: jest.fn(),
  findCategoryProducts: jest.fn().mockResolvedValue(null),
}));

const COLA = { id: "p-cola", name: "Sample Cola", unitsPerBox: null };
const hit = (product: unknown = COLA) => ({ notFound: false, archived: false, product });

function setup(over: { locked?: boolean; add?: jest.Mock } = {}) {
  const add = over.add ?? jest.fn().mockReturnValue(true);
  const refocus = jest.fn();
  const view = renderHook(() => useCounterSaleScan({ locked: over.locked ?? false, add, refocus }));
  return { ...view, add, refocus };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolve.mockResolvedValue(hit());
});

describe("submitCamera", () => {
  it("looks a 1-3 digit decode up as a CODE (submit() would turn it into a typed quantity)", async () => {
    mockResolve.mockResolvedValue({ notFound: true });
    const { result } = setup();
    act(() => result.current.submitCamera("123"));
    await waitFor(() => expect(result.current.message).toBe("No product for '123'"));
    expect(mockResolve).toHaveBeenCalledWith("123");
    expect(result.current.pendingQty).toBe(1);
  });

  it.each(["2*1234", "2x 1234", "2x1234"])(
    "looks '%s' up whole (submit() would send '1234' with quantity 2)",
    async (decoded) => {
      const { result, add } = setup();
      act(() => result.current.submitCamera(decoded));
      await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
      expect(mockResolve).toHaveBeenCalledWith(decoded);
      expect(add.mock.calls[0][2]).toBe(1);
    },
  );

  it("leaves the typed quantity alone: it multiplies the camera scan that follows it, in queue order", async () => {
    mockResolve.mockImplementation(async (code: string) =>
      code === "3" ? { notFound: true } : hit(),
    ); // "3" is no product, so it stays a quantity for the next scan
    const { result, add } = setup();
    act(() => result.current.submit("3"));
    act(() => result.current.submitCamera("200000000001"));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add.mock.calls[0][2]).toBe(3);
  });

  it("ignores an empty decode", () => {
    const { result } = setup();
    act(() => result.current.submitCamera(""));
    expect(mockResolve).not.toHaveBeenCalled();
    expect(result.current.waiting).toBe(0);
  });
});

describe("the cue belongs to camera scans only", () => {
  it("a camera add is 'accepted', a camera miss and a refused add are 'rejected'", async () => {
    const add = jest.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const { result } = setup({ add });
    act(() => result.current.submitCamera("A"));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(playScanCue).toHaveBeenLastCalledWith("accepted");
    act(() => result.current.submitCamera("A"));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(2));
    expect(playScanCue).toHaveBeenLastCalledWith("rejected");
    mockResolve.mockResolvedValue({ notFound: true });
    act(() => result.current.submitCamera("B"));
    await waitFor(() => expect(playScanCue).toHaveBeenCalledTimes(3));
    expect(playScanCue).toHaveBeenLastCalledWith("rejected");
  });

  it("a wedge scan makes no sound, whatever it comes to", async () => {
    const { result, add } = setup();
    act(() => result.current.submit("200000000001"));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    mockResolve.mockResolvedValue({ notFound: true });
    act(() => result.current.submit("200000000002"));
    await waitFor(() => expect(result.current.message).not.toBe(""));
    mockResolve.mockRejectedValue(new Error("down"));
    act(() => result.current.submit("200000000003"));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(playScanCue).not.toHaveBeenCalled();
  });

  it("a camera scan dropped because the cart is locked is not counted, and says so", async () => {
    const { result, add } = setup({ locked: true });
    act(() => result.current.submitCamera("200000000001"));
    await waitFor(() => expect(result.current.waiting).toBe(0));
    expect(add).not.toHaveBeenCalled();
    expect(playScanCue).toHaveBeenCalledWith("rejected");
  });
});
