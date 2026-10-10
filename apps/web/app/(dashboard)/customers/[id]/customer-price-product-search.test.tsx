import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  CustomerPriceProductSearch,
  PRICE_PRODUCT_SEARCH_LIMIT,
} from "./customer-price-product-search";

/**
 * B1215 item 4 (and C7): the customer special-price product picker searches the WHOLE catalog on
 * the server, debounced and only while open, instead of filtering a fixed first page of 200
 * products; and it never offers a FAMILY.
 */

const MINT = {
  id: "v-mint",
  name: "Mint",
  variantName: "Mint",
  kind: "VARIANT",
  parentProductId: "f-pod",
  unit: "each",
  sku: "POD-MINT",
};
const FAMILY = { id: "f-pod", name: "Sample Pod", kind: "FAMILY", variants: [MINT] };
const COLA = { id: "p-cola", name: "Sample Cola", kind: "STANDARD", unit: "case" };

const mockUseProducts = jest.fn((..._args: unknown[]) => ({ data: { data: [FAMILY, COLA] } }));
jest.mock("@/lib/api/products", () => ({
  useProducts: (...args: unknown[]) => mockUseProducts(...args),
}));

function Harness({ onPick }: { onPick: (p: unknown) => void }) {
  const [value, setValue] = React.useState("");
  return <CustomerPriceProductSearch value={value} onValueChange={setValue} onPick={onPick} />;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockUseProducts.mockClear();
});
afterEach(() => jest.useRealTimers());

describe("customer price product search (B1215 item 4)", () => {
  it("asks the server for the typed term (debounced) instead of a fixed first page", () => {
    render(<Harness onPick={jest.fn()} />);
    const input = screen.getByPlaceholderText("Search by name or SKU…");
    fireEvent.change(input, { target: { value: "pod" } });
    act(() => {
      jest.advanceTimersByTime(350);
    });
    const [params, options] = mockUseProducts.mock.calls[mockUseProducts.mock.calls.length - 1] as [
      Record<string, unknown>,
      { enabled?: boolean },
    ];
    expect(params).toEqual(
      expect.objectContaining({ search: "pod", isActive: true, includeVariants: true }),
    );
    expect(params.limit).toBe(PRICE_PRODUCT_SEARCH_LIMIT);
    expect(Number(params.limit)).toBeLessThan(200);
    expect(options.enabled).toBe(true);
  });

  it("does not fetch before the operator opens the field and types", () => {
    render(<Harness onPick={jest.fn()} />);
    const last = mockUseProducts.mock.calls[mockUseProducts.mock.calls.length - 1] as [
      unknown,
      { enabled?: boolean },
    ];
    expect(last[1].enabled).toBe(false);
  });

  it("lists variants under the parent name and never the family; picking reports the row", () => {
    const onPick = jest.fn();
    render(<Harness onPick={onPick} />);
    fireEvent.change(screen.getByPlaceholderText("Search by name or SKU…"), {
      target: { value: "pod" },
    });
    const mint = screen.getByRole("button", { name: /Sample Pod - Mint/ });
    expect(screen.getByRole("button", { name: /Sample Cola/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Sample Pod\b(?! -)/ })).not.toBeInTheDocument();
    fireEvent.click(mint);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "v-mint" }));
  });
});
