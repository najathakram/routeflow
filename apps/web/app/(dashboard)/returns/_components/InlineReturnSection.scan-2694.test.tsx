import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { InlineReturnSection, type InlineReturnSectionState } from "./InlineReturnSection";

/**
 * #2694 — the Returns section scans products in with the SAME scanner as order items: the shared
 * `BarcodeScannerButton` (camera + USB wedge) and the order modal's `useScanCodeHandler` resolve
 * ladder. A scan adds the product to "What came back" with 1 piece; a repeat scan adds a piece;
 * Enter in the search field is a scan; an unknown code is a message, never a new product.
 */
jest.mock("@/lib/api/orders", () => ({ useOrder: () => ({ data: undefined }) }));
jest.mock("@/lib/api/products", () => ({ useProducts: () => ({ data: { data: [] } }) }));
jest.mock("@/lib/api/inline-returns", () => ({
  useInlineReturnQuote: () => ({ mutate: jest.fn(), isPending: false }),
}));

const WIDGET = { id: "prod-1", name: "Widget", unit: "each", unitsPerBox: null };
const resolveProductByCode = jest.fn();
jest.mock("@/lib/barcode-resolve", () => ({
  resolveProductByCode: (code: string) => resolveProductByCode(code),
}));

// The real button needs a camera; the stub exposes the SAME onScan contract the section wires up.
jest.mock("@/components/BarcodeScannerButton", () => ({
  BarcodeScannerButton: ({ onScan }: { onScan: (code: string) => void }) => (
    <button type="button" onClick={() => onScan("0123456789012")}>
      Scan barcode
    </button>
  ),
}));

beforeEach(() => {
  resolveProductByCode.mockReset();
});

function renderSection(): InlineReturnSectionState[] {
  const states: InlineReturnSectionState[] = [];
  renderWithProviders(
    <InlineReturnSection customerId="cust-1" onStateChange={(s) => states.push(s)} />,
  );
  return states;
}
const lastLines = (states: InlineReturnSectionState[]) =>
  (states[states.length - 1]?.lines ?? []).map((l) => [l.productId, l.pieces]);

describe("#2694 InlineReturnSection — scan items into Returns", () => {
  it("a scanned product lands in What came back with 1 piece", async () => {
    resolveProductByCode.mockResolvedValue({ product: WIDGET, source: "barcode" });
    const states = renderSection();
    fireEvent.click(screen.getByRole("button", { name: /scan barcode/i }));
    await waitFor(() => expect(lastLines(states)).toEqual([["prod-1", "1"]]));
    expect(resolveProductByCode).toHaveBeenCalledWith("0123456789012");
    expect(screen.getByText("Widget")).toBeInTheDocument();
  });

  it("a repeat scan adds a piece to the same line", async () => {
    resolveProductByCode.mockResolvedValue({ product: WIDGET, source: "barcode" });
    const states = renderSection();
    fireEvent.click(screen.getByRole("button", { name: /scan barcode/i }));
    await waitFor(() => expect(lastLines(states)).toEqual([["prod-1", "1"]]));
    fireEvent.click(screen.getByRole("button", { name: /scan barcode/i }));
    await waitFor(() => expect(lastLines(states)).toEqual([["prod-1", "2"]]));
  });

  it("Enter in the search field is a scan (USB / paste-mode scanners)", async () => {
    resolveProductByCode.mockResolvedValue({ product: WIDGET, source: "sku" });
    const states = renderSection();
    const search = screen.getByLabelText(/add another product/i);
    fireEvent.change(search, { target: { value: "WID-001" } });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(lastLines(states)).toEqual([["prod-1", "1"]]));
    expect(resolveProductByCode).toHaveBeenCalledWith("WID-001");
  });

  it("an unknown code is a message and adds nothing (returns never create products)", async () => {
    resolveProductByCode.mockResolvedValue({ notFound: true });
    const states = renderSection();
    fireEvent.click(screen.getByRole("button", { name: /scan barcode/i }));
    expect(await screen.findByText(/no product with barcode 0123456789012/i)).toBeInTheDocument();
    expect(lastLines(states)).toEqual([]);
  });

  describe("B1219 - a single fuzzy match is confirmed, not added", () => {
    const suggestion = {
      product: WIDGET,
      source: "search",
      ambiguous: true,
      suggestion: true,
      matches: [WIDGET],
    };

    it("adds nothing until Add", async () => {
      resolveProductByCode.mockResolvedValue(suggestion);
      const states = renderSection();
      fireEvent.click(screen.getByRole("button", { name: /scan barcode/i }));
      const picker = await screen.findByRole("group", { name: /did you mean/i });
      expect(picker).toHaveTextContent("Did you mean Widget?");
      expect(lastLines(states)).toEqual([]);
      fireEvent.click(within(picker).getByRole("button", { name: "Add" }));
      await waitFor(() => expect(lastLines(states)).toEqual([["prod-1", "1"]]));
      expect(screen.queryByRole("group", { name: /did you mean/i })).toBeNull();
    });

    it("Cancel adds nothing", async () => {
      resolveProductByCode.mockResolvedValue(suggestion);
      const states = renderSection();
      fireEvent.click(screen.getByRole("button", { name: /scan barcode/i }));
      const picker = await screen.findByRole("group", { name: /did you mean/i });
      fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
      await waitFor(() =>
        expect(screen.queryByRole("group", { name: /did you mean/i })).toBeNull(),
      );
      expect(lastLines(states)).toEqual([]);
    });
  });
});
