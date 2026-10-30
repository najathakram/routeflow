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
    line({ id: "li-d", productId: "p-3", product: { name: "Bulk Rice" }, qty: 2.5 }),
    line({
      id: "li-e",
      productId: "p-4",
      product: { name: "Tea" },
      qty: 10,
      unitLabel: "Case",
      unitsPerBox: 1,
    }),
    line({ id: "li-f", productId: "p-5", product: { name: "Salt" }, qty: 10, unitsPerBox: 12 }),
    line({
      id: "li-g",
      productId: "p-6",
      product: { name: "Oil" },
      qty: 10,
      unitLabel: "Case",
      unitsPerBox: 12,
    }),
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

describe("New Return form: what a line counts and how it is returned (SA-1042 B9a, B9c)", () => {
  beforeEach(() => mockCreate.mockReset());

  it("R-w1: the Ordered cell reads pieces with the line's own unit", async () => {
    await openOrder();
    const rows = await screen.findAllByRole("row");
    const text = (name: string) => rows.find((r) => within(r).queryByText(name))?.textContent ?? "";
    const colaRows = rows.filter((r) => r.textContent?.startsWith("Cola"));
    expect(colaRows).toHaveLength(2);
    expect(colaRows[0].textContent).toContain("400 pcs (2 Cases)");
    expect(colaRows[1].textContent).toContain("100 pcs (10 boxes)");
    expect(text("Chips")).not.toContain("pcs");
  });

  const colaRow = (n: number) =>
    screen.getAllByRole("row").filter((r) => r.textContent?.startsWith("Cola"))[n];
  const rowInput = (row: HTMLElement, label: RegExp) => within(row).getByLabelText(label);
  const submit = () => {
    const reasonSel = (screen.getAllByRole("combobox") as HTMLSelectElement[]).find((x) =>
      x.textContent?.includes("Select reason"),
    )!;
    fireEvent.change(reasonSel, { target: { value: "DAMAGED" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Return" }));
  };
  const sent = () => mockCreate.mock.calls[0][0].items;

  it("R-r3: one Case on the Case line sends the line and boxes: 1, not a bare qty of 1", async () => {
    await openOrder();
    await screen.findAllByRole("row");
    fireEvent.change(rowInput(colaRow(0), /^Cases to return/), { target: { value: "1" } });
    submit();
    expect(sent()).toEqual([{ productId: "p-1", orderItemId: "li-a", boxes: 1, pieces: 0 }]);
  });

  it("a pack line sends boxes and loose pieces in its own unit, and nothing else about money", async () => {
    await openOrder();
    await screen.findAllByRole("row");
    fireEvent.change(rowInput(colaRow(1), /^boxes to return/), { target: { value: "3" } });
    fireEvent.change(rowInput(colaRow(1), /^pcs to return/), { target: { value: "2" } });
    submit();
    expect(sent()).toEqual([{ productId: "p-1", orderItemId: "li-b", boxes: 3, pieces: 2 }]);
    // no price, amount or total travels with the count: the server re-prices
    const present = Object.entries(sent()[0])
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    expect(present.sort()).toEqual(["boxes", "orderItemId", "pieces", "productId"]);
  });

  it("G-w3: a box-unaware line sends qty in its own unit, with its line", async () => {
    await openOrder();
    await screen.findAllByRole("row");
    const chips = screen.getAllByRole("row").find((r) => r.textContent?.startsWith("Chips"))!;
    fireEvent.change(rowInput(chips, /^Quantity to return/), { target: { value: "5" } });
    submit();
    expect(sent()).toEqual([{ productId: "p-2", orderItemId: "li-c", qty: 5 }]);
  });

  it("a 2.5 legacy line returns 1.5: no problem shown, qty 1.5 sent, and only that cell takes a fraction", async () => {
    await openOrder();
    await screen.findAllByRole("row");
    const rice = screen.getAllByRole("row").find((r) => r.textContent?.startsWith("Bulk Rice"))!;
    const count = rowInput(rice, /^Quantity to return/);
    expect(count).toHaveAttribute("inputmode", "decimal");
    expect(count).toHaveAttribute("step", "any");
    expect(rowInput(colaRow(0), /^Cases to return/)).toHaveAttribute("inputmode", "numeric");
    expect(rowInput(colaRow(0), /^Cases to return/)).toHaveAttribute("step", "1");
    fireEvent.change(count, { target: { value: "1.5" } });
    submit();
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(screen.queryByText("Use whole numbers.")).toBeNull();
    expect(sent()).toEqual([{ productId: "p-3", orderItemId: "li-d", qty: 1.5 }]);
  });

  it("the Return header no longer says pcs, and an over-cap count shows the line's own words and sends nothing", async () => {
    await openOrder();
    expect(await screen.findByText("Return")).toBeInTheDocument();
    expect(screen.queryByText("Return qty (pcs)")).toBeNull();
    fireEvent.change(rowInput(colaRow(0), /^Cases to return/), { target: { value: "3" } });
    submit();
    expect(
      await screen.findByText("Cannot exceed what was ordered (400 pcs (2 Cases))."),
    ).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("an over-cap count on the second line lands on that line's row, not the first", async () => {
    await openOrder();
    await screen.findAllByRole("row");
    fireEvent.change(rowInput(colaRow(1), /^boxes to return/), { target: { value: "11" } });
    submit();
    const msg = await screen.findByText("Cannot exceed what was ordered (100 pcs (10 boxes)).");
    expect(colaRow(1)).toContainElement(msg);
    expect(colaRow(0).textContent).not.toContain("Cannot exceed");
  });

  it("a half Case is refused in the form (whole numbers), nothing sent", async () => {
    await openOrder();
    await screen.findAllByRole("row");
    fireEvent.change(rowInput(colaRow(0), /^Cases to return/), { target: { value: "1.5" } });
    submit();
    expect(await screen.findByText("Use whole numbers.")).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("a refused return shows the server's own reason, not a retry that can never work", async () => {
    const message = "Return qty exceeds what is left on this line: 100 pcs (10 boxes).";
    mockCreate.mockImplementation((_body, opts) =>
      opts.onError({ response: { status: 400, data: { message } } }),
    );
    await openOrder();
    await screen.findAllByRole("row");
    fireEvent.change(rowInput(colaRow(1), /^boxes to return/), { target: { value: "10" } });
    submit();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText("Please try again.")).toBeNull();
  });

  it("a phone row keeps its Ordered word, because the header row is hidden there", async () => {
    await openOrder();
    await screen.findAllByRole("row");
    expect(within(colaRow(0)).getByText("Ordered").className).toContain("sm:hidden");
    expect(within(colaRow(0)).getByText("400 pcs (2 Cases)")).toBeInTheDocument();
  });

  it("A-8: a unit line says its word, a legacy line says the bare number with no word at the input", async () => {
    await openOrder();
    await screen.findAllByRole("row");
    const row = (name: string) =>
      screen.getAllByRole("row").find((r) => r.textContent?.startsWith(name))!;
    expect(row("Tea").textContent).toContain("10 Cases");
    expect(row("Salt").textContent).not.toMatch(/pcs|boxes/);
    expect(row("Oil").textContent).not.toMatch(/pcs|boxes|Case/);

    fireEvent.change(rowInput(row("Tea"), /^Cases to return/), { target: { value: "11" } });
    fireEvent.change(rowInput(row("Salt"), /^Quantity to return/), { target: { value: "11" } });
    submit();
    expect(
      await screen.findByText("Cannot exceed what was ordered (10 Cases)."),
    ).toBeInTheDocument();
    expect(screen.getByText("Cannot exceed what was ordered (10).")).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("I-167: at phone width the table scrolls instead of clipping Notes, and the Ordered text does not wrap", async () => {
    await openOrder();
    await screen.findAllByRole("row");
    const wrap = screen.getByTestId("return-lines-table");
    expect(wrap.className).toContain("overflow-x-auto");
    expect(wrap.className).not.toContain("overflow-hidden");
    expect(within(colaRow(0)).getByText("400 pcs (2 Cases)").className).toContain(
      "whitespace-nowrap",
    );
    expect(within(colaRow(0)).getByPlaceholderText("Condition / notes…").className).toContain(
      "min-w-",
    );
  });

  it("the line rows cannot push Create Return off the screen: the dialog is capped and its body scrolls", async () => {
    await openOrder();
    await screen.findAllByRole("row");
    expect(screen.getByRole("dialog").className).toMatch(/max-h-\[92vh\]/);
  });

  it("R-w2: two lines of one product raise no duplicate-key warning", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await openOrder();
    await screen.findAllByRole("row");
    const dup = spy.mock.calls.filter((c) => String(c[0]).includes("same key"));
    spy.mockRestore();
    expect(dup).toHaveLength(0);
  });
});
