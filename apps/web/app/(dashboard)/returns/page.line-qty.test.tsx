import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import ReturnsPage from "./page";

/**
 * SA-1042 B9a. R-w1 (A6-1): the "Ordered" cell says what a line counts, in pieces with its own unit beside it, not a bare
 * "400". R-w2: two lines of one product are two rows (the row key is the order line, not the product).
 */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  usePathname: () => "/returns",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/hooks/useUrlSearch", () => ({ useUrlSearch: () => ["", jest.fn(), ""] }));
jest.mock("@/lib/hooks/useUrlPage", () => ({
  useUrlPage: () => [1, jest.fn()],
  useClampPage: () => undefined,
}));
const mockCreate = jest.fn();
jest.mock("@/lib/api/returns", () => ({
  useReturns: () => ({ data: { data: [], meta: { total: 0, totalPages: 1 } }, isLoading: false }),
  useCreateReturn: () => ({ mutate: mockCreate, isPending: false }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [{ id: "c-acme", businessName: "Acme Deli" }] } }),
}));

const line = (over: Record<string, unknown>) => ({
  productId: "p-1",
  product: { name: "Cola" },
  name: "Cola",
  ...over,
});
const ORDER = {
  id: "o-1",
  orderNumber: "ORD-00010",
  customerId: "c-acme",
  customer: { id: "c-acme", businessName: "Acme Deli" },
  status: "DELIVERED",
  lineItems: [
    line({ id: "li-a", qty: 400, boxes: 2, pieces: 0, unitsPerBox: 200, unitLabel: "Case" }),
    line({ id: "li-b", qty: 100, boxes: 10, pieces: 0, unitsPerBox: 10 }),
    line({ id: "li-c", productId: "p-2", product: { name: "Chips" }, qty: 12 }),
  ],
};
jest.mock("@/lib/api/orders", () => ({
  useOrders: () => ({ data: { data: [ORDER] }, isLoading: false }),
  useOrder: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/invoices", () => ({ useInvoices: () => ({ data: { data: [] } }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/addons", () => ({ ORDERS_INLINE_RETURNS_ADDON: "orders_inline_returns" }));

async function openOrder() {
  renderWithProviders(<ReturnsPage />);
  fireEvent.click(screen.getAllByRole("button", { name: /new return|create return/i })[0]);
  await screen.findByRole("dialog");
  const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
  fireEvent.change(
    selects.find((s) => s.querySelector("option[value='c-acme']"))!,
    {
      target: { value: "c-acme" },
    },
  );
  const orderSel = await waitFor(() => {
    const s = (screen.getAllByRole("combobox") as HTMLSelectElement[]).find((x) =>
      x.querySelector("option[value='o-1']"),
    );
    if (!s) throw new Error("order select not ready");
    return s;
  });
  fireEvent.change(orderSel, { target: { value: "o-1" } });
}

describe("New Return form: what a line counts (SA-1042 B9a)", () => {
  it("R-w1: the Ordered cell reads pieces with the line's own unit", async () => {
    await openOrder();
    const rows = await screen.findAllByRole("row");
    const text = (name: string) => rows.find((r) => within(r).queryByText(name))?.textContent ?? "";
    const colaRows = rows.filter((r) => r.textContent?.startsWith("Cola"));
    expect(colaRows).toHaveLength(2);
    expect(colaRows[0].textContent).toContain("400 pcs (2 Cases)");
    expect(colaRows[1].textContent).toContain("100 pcs (10 boxes)");
    expect(text("Chips")).toContain("12 pcs");
  });

  it("the Return qty header names the unit it counts in", async () => {
    await openOrder();
    expect(await screen.findByText("Return qty (pcs)")).toBeInTheDocument();
  });
});
