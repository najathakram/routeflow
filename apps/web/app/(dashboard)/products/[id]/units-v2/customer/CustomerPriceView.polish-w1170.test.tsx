import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import type { CustomerUnitPricesResponse } from "@routeflow/types";
import { CustomerPriceView, resetCustomerViewMemory } from "./CustomerPriceView";
import { CUSTOMER_VIEW_TESTIDS as T } from "./customer-testids";

// W-1170 polish P9 / P21 / P22 / P23 on the product page's Customer view.
const mockPrices = jest.fn();
jest.mock("@/lib/api/useCustomerUnitPrices", () => ({
  useCustomerUnitPrices: (...a: unknown[]) => mockPrices(...a),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
}));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "1": "Retail", "2": "Wholesale" } }),
}));
jest.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("customer=c1") }));

const row = (ref: string, price: number, listPrice: number, source = "tier") => ({
  ref,
  label: ref === "pack" ? "Case" : "Piece",
  factor: ref === "pack" ? 24 : 1,
  kind: ref === "pack" ? ("pack" as const) : ("base" as const),
  code: null,
  price,
  listPrice,
  tierPrice: listPrice,
  source: source as "tier",
});
const data = (rows: ReturnType<typeof row>[]): CustomerUnitPricesResponse => ({
  customerId: "c1",
  customerName: "UX Corner Market",
  tier: 2,
  total: 1,
  page: 1,
  limit: 10,
  products: [
    {
      productId: "p1",
      productName: "UX Cola",
      tier: 2,
      orderUnit: null,
      orderUnitScope: "default",
      orderUnitLabel: "Case",
      revision: 1,
      rows,
    },
  ],
});
const show = (rows: ReturnType<typeof row>[]) =>
  mockPrices.mockReturnValue({ data: data(rows), isLoading: false, isError: false });
const heads = () =>
  within(screen.getByTestId(T.prices("p1")))
    .getAllByRole("columnheader")
    .map((h) => h.textContent);

beforeEach(() => {
  resetCustomerViewMemory();
  mockPrices.mockReset();
});

describe("W-1170 polish: Customer view", () => {
  it("P22: the Retail column is drawn only when some price differs from Retail", () => {
    show([row("pack", 36, 36), row("base", 1.5, 1.5)]);
    const { unmount } = render(<CustomerPriceView productId="p1" />);
    expect(heads()).toEqual(["Unit", "Price"]);
    unmount();
    show([row("pack", 30, 36), row("base", 1.5, 1.5)]);
    render(<CustomerPriceView productId="p1" />);
    expect(heads()).toEqual(["Unit", "Price", "Retail"]);
    // the row that does not differ leaves its comparison cell empty
    const cells = screen.getByTestId(T.row("p1", "base")).querySelectorAll("td");
    expect(cells[2].textContent).toBe("");
  });

  it("P21 / P23: Auto is the plain caption (no pill) and the headers share the grid's small-caps style", () => {
    show([row("pack", 30, 36)]);
    render(<CustomerPriceView productId="p1" />);
    const auto = within(screen.getByTestId(T.row("p1", "pack"))).getByText("Auto");
    expect(auto.className).not.toContain("rounded-full");
    expect(auto.className).not.toContain("bg-navy/10");
    const head = screen.getAllByRole("columnheader")[0].closest("tr")!;
    expect(head.className).toContain("uppercase");
    expect(head.className).toContain("text-[11px]");
  });

  it("P9: on the product page the section is a bordered card like its siblings, with no card inside the card", () => {
    show([row("pack", 30, 36)]);
    render(<CustomerPriceView productId="p1" />);
    const section = screen.getByTestId(T.section);
    expect(section.className).toContain("border");
    expect(section.className).toContain("rounded-lg");
    expect(screen.getByTestId(T.product("p1")).className).not.toContain("border");
  });
});
