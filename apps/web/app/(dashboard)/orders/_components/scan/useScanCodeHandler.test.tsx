import { renderHook, waitFor } from "@testing-library/react";
import {
  isConnectivityError,
  useScanCodeHandler,
  type ScanCodeHandlerDeps,
} from "./useScanCodeHandler";

const mockResolve = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolve(code),
}));

const product = { id: "p1", name: "Widget" };

function deps(overrides: Partial<ScanCodeHandlerDeps> = {}): ScanCodeHandlerDeps {
  return {
    addLineItem: jest.fn(),
    onUnknownCode: jest.fn(),
    toast: jest.fn(),
    ...overrides,
  };
}

describe("useScanCodeHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("routes a hit to addLineItem and nothing else", async () => {
    mockResolve.mockResolvedValue({ notFound: false, archived: false, product });
    const d = deps();
    const { result } = renderHook(() => useScanCodeHandler(d));

    result.current.current("012345678905");

    await waitFor(() =>
      expect(d.addLineItem).toHaveBeenCalledWith(product, expect.stringMatching(/^(BOX|UNIT)$/)),
    );
    expect(d.onUnknownCode).not.toHaveBeenCalled();
    expect(d.toast).not.toHaveBeenCalled();
  });

  it("#2784: a SHARED code (box + unit) tells addLineItem the new line may start on the default selling unit; a box-only or unit-only code never does", async () => {
    const shared = { id: "p1", name: "Widget", barcode: "012345678905", unitsPerBox: 6 };
    mockResolve.mockResolvedValue({ notFound: false, archived: false, product: shared });
    const d = deps();
    const { result } = renderHook(() => useScanCodeHandler(d));
    result.current.current("012345678905");
    await waitFor(() =>
      expect(d.addLineItem).toHaveBeenCalledWith(shared, "BOX", { startOnDefaultUnit: true }),
    );

    // The CODE decides: a sku (box-only) and a unitSku (unit-only) keep their level and pass no third argument.
    const boxOnly = { id: "p2", name: "Crate", sku: "CRATE-1", unitsPerBox: 6 };
    mockResolve.mockResolvedValue({ notFound: false, archived: false, product: boxOnly });
    const d2 = deps();
    const r2 = renderHook(() => useScanCodeHandler(d2));
    r2.result.current.current("CRATE-1");
    await waitFor(() => expect(d2.addLineItem).toHaveBeenCalledWith(boxOnly, "BOX"));

    const unitOnly = { id: "p3", name: "Single", unitSku: "SINGLE-1", unitsPerBox: 6 };
    mockResolve.mockResolvedValue({ notFound: false, archived: false, product: unitOnly });
    const d3 = deps();
    const r3 = renderHook(() => useScanCodeHandler(d3));
    r3.result.current.current("SINGLE-1");
    await waitFor(() => expect(d3.addLineItem).toHaveBeenCalledWith(unitOnly, "UNIT"));
  });

  it("uses the LATEST render's deps, so a callback that captured the ref once never goes stale", async () => {
    mockResolve.mockResolvedValue({ notFound: false, archived: false, product });
    const first = deps();
    const second = deps();
    const { result, rerender } = renderHook(({ d }) => useScanCodeHandler(d), {
      initialProps: { d: first },
    });
    const captured = result.current; // what a keydown listener / camera callback would hold

    rerender({ d: second });
    captured.current("012345678905");

    await waitFor(() =>
      expect(second.addLineItem).toHaveBeenCalledWith(
        product,
        expect.stringMatching(/^(BOX|UNIT)$/),
      ),
    );
    expect(first.addLineItem).not.toHaveBeenCalled();
  });

  it("does not touch addLineItem while the hook is called — only when a code is scanned (thunk deferral)", () => {
    const addLineItem = jest.fn();
    renderHook(() => useScanCodeHandler(deps({ addLineItem })));
    expect(addLineItem).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("an archived product toasts and neither adds nor reports an unknown code", async () => {
    mockResolve.mockResolvedValue({ notFound: false, archived: true, product });
    const d = deps();
    const { result } = renderHook(() => useScanCodeHandler(d));

    result.current.current("012345678905");

    await waitFor(() =>
      expect(d.toast).toHaveBeenCalledWith({
        variant: "error",
        title: "Widget is archived — reactivate to sell",
      }),
    );
    expect(d.addLineItem).not.toHaveBeenCalled();
    expect(d.onUnknownCode).not.toHaveBeenCalled();
  });

  it("falls back to a generic message when the failure carries none", async () => {
    mockResolve.mockRejectedValue({});
    const d = deps();
    const { result } = renderHook(() => useScanCodeHandler(d));

    result.current.current("012345678905");

    await waitFor(() =>
      expect(d.toast).toHaveBeenCalledWith({
        variant: "error",
        title: "Couldn't look up the code",
        description: "Check the connection and rescan.",
      }),
    );
    expect(d.onUnknownCode).not.toHaveBeenCalled();
  });
});

describe("isConnectivityError", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ["axios ERR_NETWORK", { code: "ERR_NETWORK", message: "Network Error" }],
    ["axios timeout", { code: "ECONNABORTED", message: "timeout of 10000ms exceeded" }],
    ["ETIMEDOUT", { code: "ETIMEDOUT" }],
    ["a bare 'Network Error'", { message: "Network Error" }],
    ["a message that says timeout", { message: "Request timeout" }],
  ])("%s is a connectivity failure", (_n, err) => {
    expect(isConnectivityError(err)).toBe(true);
  });

  it("the browser reporting offline is a connectivity failure even with no code", () => {
    jest.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(isConnectivityError(new Error("boom"))).toBe(true);
  });

  it("an HTTP response - even a 500 - means the server was reached, so it is NOT a signal problem", () => {
    expect(isConnectivityError({ response: { status: 500 }, message: "Network Error" })).toBe(
      false,
    );
    expect(isConnectivityError({ response: { status: 404 } })).toBe(false);
  });

  it("an unrelated error is not a connectivity failure", () => {
    expect(isConnectivityError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isConnectivityError(null)).toBe(false);
    expect(isConnectivityError(undefined)).toBe(false);
  });
});

describe("useScanCodeHandler - connectivity + quiet", () => {
  beforeEach(() => jest.clearAllMocks());

  it("reports offline: true for a transport failure, and false for an HTTP error", async () => {
    const d = deps();
    const { result } = renderHook(() => useScanCodeHandler(d));

    mockResolve.mockRejectedValueOnce({ code: "ERR_NETWORK", message: "Network Error" });
    await expect(result.current.current("111")).resolves.toMatchObject({
      kind: "error",
      offline: true,
    });

    mockResolve.mockRejectedValueOnce({ response: { status: 500, data: { message: "boom" } } });
    await expect(result.current.current("222")).resolves.toMatchObject({
      kind: "error",
      offline: false,
      message: "Something went wrong on our side. Please try again.",
    });
  });

  it("quiet suppresses the lookup-failure toast but still returns the error", async () => {
    mockResolve.mockRejectedValue({ code: "ERR_NETWORK", message: "Network Error" });
    const d = deps();
    const { result } = renderHook(() => useScanCodeHandler(d));

    const res = await result.current.current("111", { quiet: true });

    expect(res).toMatchObject({ kind: "error", offline: true });
    expect(d.toast).not.toHaveBeenCalled();
  });

  it("without quiet the classic behaviour is unchanged: it toasts", async () => {
    mockResolve.mockRejectedValue({ code: "ERR_NETWORK", message: "Network Error" });
    const d = deps();
    const { result } = renderHook(() => useScanCodeHandler(d));

    await result.current.current("111");

    expect(d.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't look up the code" }),
    );
  });

  it("a BACKGROUND lookup that finds nothing reports unknown but never opens create-product", async () => {
    mockResolve.mockResolvedValue({ notFound: true, archived: false });
    const d = deps();
    const { result } = renderHook(() => useScanCodeHandler(d));

    await expect(result.current.current("111", { background: true })).resolves.toEqual({
      kind: "unknown",
    });
    expect(d.onUnknownCode).not.toHaveBeenCalled();

    await result.current.current("222"); // a live scan still does
    expect(d.onUnknownCode).toHaveBeenCalledWith("222");
  });

  it("quiet does NOT silence an archived-product toast (that is not a lookup failure)", async () => {
    mockResolve.mockResolvedValue({ notFound: false, archived: true, product: { name: "Old" } });
    const d = deps();
    const { result } = renderHook(() => useScanCodeHandler(d));

    await result.current.current("111", { quiet: true });

    expect(d.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Old is archived — reactivate to sell" }),
    );
  });
});
