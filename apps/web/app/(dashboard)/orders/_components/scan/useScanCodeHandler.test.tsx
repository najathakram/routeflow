import { renderHook, waitFor } from "@testing-library/react";
import { useScanCodeHandler, type ScanCodeHandlerDeps } from "./useScanCodeHandler";

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

    await waitFor(() => expect(d.addLineItem).toHaveBeenCalledWith(product));
    expect(d.onUnknownCode).not.toHaveBeenCalled();
    expect(d.toast).not.toHaveBeenCalled();
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

    await waitFor(() => expect(second.addLineItem).toHaveBeenCalledWith(product));
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
