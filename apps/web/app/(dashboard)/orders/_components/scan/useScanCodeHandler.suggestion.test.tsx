import { renderHook, waitFor } from "@testing-library/react";
import { useScanCodeHandler, type ScanCodeHandlerDeps } from "./useScanCodeHandler";

const mockResolve = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => mockResolve(code),
}));

const product = { id: "p1", name: "Widget" };
const suggestion = {
  product,
  source: "search",
  ambiguous: true,
  suggestion: true,
  matches: [product],
};

function deps(o: Partial<ScanCodeHandlerDeps> = {}): ScanCodeHandlerDeps {
  return { addLineItem: jest.fn(), onUnknownCode: jest.fn(), toast: jest.fn(), ...o };
}

describe("useScanCodeHandler — B1219 fuzzy suggestion", () => {
  beforeEach(() => jest.clearAllMocks());

  it("hands a suggestion to onSuggestion and adds nothing / opens no create-product", async () => {
    mockResolve.mockResolvedValue(suggestion);
    const onSuggestion = jest.fn();
    const d = deps({ onSuggestion });
    const { result } = renderHook(() => useScanCodeHandler(d));
    const res = await result.current.current("12345");
    expect(onSuggestion).toHaveBeenCalledWith(product, "12345");
    expect(d.addLineItem).not.toHaveBeenCalled();
    expect(d.onUnknownCode).not.toHaveBeenCalled();
    expect(res).toEqual({ kind: "suggested", product });
  });

  it("without an onSuggestion consumer it still adds nothing and tells the operator", async () => {
    mockResolve.mockResolvedValue(suggestion);
    const d = deps();
    const { result } = renderHook(() => useScanCodeHandler(d));
    const res = await result.current.current("12345");
    expect(d.addLineItem).not.toHaveBeenCalled();
    await waitFor(() => expect(d.toast).toHaveBeenCalled());
    expect(res.kind).toBe("suggested");
  });

  it("a plain exact hit still adds", async () => {
    mockResolve.mockResolvedValue({ product, source: "sku" });
    const d = deps({ onSuggestion: jest.fn() });
    const { result } = renderHook(() => useScanCodeHandler(d));
    await result.current.current("W-1");
    expect(d.addLineItem).toHaveBeenCalled();
  });
});
