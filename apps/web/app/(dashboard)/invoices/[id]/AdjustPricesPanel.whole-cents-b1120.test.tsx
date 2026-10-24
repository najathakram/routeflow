/**
 * B1120: the Adjust Prices panel took whatever number was typed (`parseFloat`) and sent it, so 8.355 reached
 * the API, was stored as 8.36, and the line total was computed from the raw 8.355 (6 x $8.36 = $50.13).
 * The API now refuses a 3rd decimal (400); the panel stops it first, in the field, instead of at a toast:
 * a sub-cent price marks THAT line invalid (inline, with the nearest whole-cent price), Apply is disabled
 * until every line is whole cents, and nothing is sent. A whole-cent price is sent exactly as typed.
 */
import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdjustPricesPanel } from "./AdjustPricesPanel";

const toast = jest.fn();
const post = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { post: (...a: unknown[]) => post(...a) },
}));

const invoice: any = {
  id: "inv-1",
  customer: { businessName: "Acme Foods" },
  items: [
    { id: "l1", description: "Widget", qty: 6, unitPrice: 10 },
    { id: "l2", description: "Gadget", qty: 3, unitPrice: 20 },
  ],
};

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AdjustPricesPanel invoice={invoice} onClose={jest.fn()} />
    </QueryClientProvider>,
  );
}
const inputs = () => screen.getAllByRole("spinbutton") as HTMLInputElement[];
const type = (index: number, value: string) =>
  fireEvent.change(inputs()[index], { target: { value } });
const apply = () => screen.getByRole("button", { name: /Apply Price Changes/ });

beforeEach(() => {
  jest.clearAllMocks();
  post.mockResolvedValue({ data: { id: "inv-1" } });
});

describe("AdjustPricesPanel: whole-cent unit prices only (B1120)", () => {
  it.each(["8.355", "17.335", "24.985", "9.995", "0.001"])(
    "%s marks the line invalid with the nearest whole-cent price, disables Apply and sends nothing",
    (typed) => {
      setup();
      type(0, typed);

      expect(inputs()[0]).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByTestId("adjust-price-error-l1")).toHaveTextContent(/whole cents/i);
      expect(apply()).toBeDisabled();
      fireEvent.click(apply());
      expect(post).not.toHaveBeenCalled();
    },
  );

  it("the hint names the nearest whole-cent price (8.355 -> $8.36)", () => {
    setup();
    type(0, "8.355");
    expect(screen.getByTestId("adjust-price-error-l1")).toHaveTextContent("$8.36");
  });

  it("one bad line blocks the whole save even when the other line is fine, and clearing it unblocks", async () => {
    setup();
    type(1, "17.335");
    type(0, "9.99");
    expect(screen.queryByTestId("adjust-price-error-l1")).toBeNull();
    expect(screen.getByTestId("adjust-price-error-l2")).toBeInTheDocument();
    expect(apply()).toBeDisabled();

    type(1, "17.34");
    expect(screen.queryByTestId("adjust-price-error-l2")).toBeNull();
    expect(inputs()[1]).not.toHaveAttribute("aria-invalid", "true");
    expect(apply()).toBeEnabled();
    fireEvent.click(apply());

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body] = post.mock.calls[0];
    expect(url).toBe("/invoices/inv-1/price-adjustment");
    expect(body.items).toEqual([
      { itemId: "l1", newUnitPrice: 9.99 },
      { itemId: "l2", newUnitPrice: 17.34 },
    ]);
  });

  it.each([
    ["8.36", 8.36],
    ["9.99", 9.99],
    ["19.9", 19.9],
    ["0", 10], // an unchanged-or-zero field falls back to the current price, exactly as before
    ["", 10], // blank: the current price
  ])("the whole-cent entry %p is sent as %p", async (typed, sent) => {
    setup();
    type(0, typed);
    expect(inputs()[0]).not.toHaveAttribute("aria-invalid", "true");
    fireEvent.click(apply());

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1].items[0]).toEqual({ itemId: "l1", newUnitPrice: sent });
  });

  it("the untouched panel (every line prefilled with its current price) saves as before", async () => {
    setup();
    expect(apply()).toBeEnabled();
    fireEvent.click(apply());

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1].items).toEqual([
      { itemId: "l1", newUnitPrice: 10 },
      { itemId: "l2", newUnitPrice: 20 },
    ]);
  });
});
