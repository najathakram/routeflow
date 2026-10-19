import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpenOrdersCard } from "./OpenOrdersCard";

type Q = {
  data?: unknown;
  isLoading: boolean;
  isError: boolean;
  refetch: jest.Mock;
};
let query: Q;
jest.mock("@/lib/api/product-open-orders", () => ({
  useProductOpenOrders: () => query,
}));

const line = (over: Record<string, unknown> = {}) => ({
  orderId: "o1",
  orderNumber: "ORD-1001",
  status: "PENDING",
  orderDate: "2026-10-12T00:00:00.000Z",
  customerId: "c1",
  customerName: "Acme Foods",
  qty: 30,
  remainingQty: 30,
  boxes: 2,
  pieces: 6,
  unitsPerBox: 12,
  unitLabel: null,
  ...over,
});

const data = (lines: unknown[], over: Record<string, unknown> = {}) => ({
  productId: "p1",
  lines,
  summary: { orders: lines.length, customers: 2, totalQty: 54 },
  truncated: false,
  ...over,
});

beforeEach(() => {
  query = { isLoading: false, isError: false, refetch: jest.fn() };
});

describe("OpenOrdersCard", () => {
  it("lists each open line with customer link, order link, remaining qty as boxes/pieces, status and date", () => {
    query.data = data([
      line(),
      line({
        orderId: "o2",
        orderNumber: "ORD-1002",
        status: "OUT_FOR_DELIVERY",
        orderDate: "2026-10-10T00:00:00.000Z",
        customerId: "c2",
        customerName: "Globex Market",
        qty: 24,
        remainingQty: 24,
        boxes: 2,
        pieces: 0,
      }),
    ]);
    render(<OpenOrdersCard productId="p1" unitsPerBox={12} />);
    expect(screen.getByRole("heading", { name: "Open orders" })).toHaveAttribute(
      "id",
      "h-open-orders",
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const first = within(rows[0]);
    expect(first.getByRole("link", { name: "Acme Foods" })).toHaveAttribute(
      "href",
      "/customers/c1",
    );
    expect(first.getByRole("link", { name: "ORD-1001" })).toHaveAttribute("href", "/orders/o1");
    expect(first.getByText("2 boxes + 6 pcs")).toBeInTheDocument();
    expect(first.getByText(/pending/i)).toBeInTheDocument();
    expect(first.getByText("Oct 12, 2026")).toBeInTheDocument();
    const second = within(rows[1]);
    expect(second.getByText("2 boxes")).toBeInTheDocument();
    expect(second.getByText(/out for delivery/i)).toBeInTheDocument();
  });

  it("a part-billed line reads 'of N ordered'", () => {
    query.data = data([line({ qty: 60, remainingQty: 30, boxes: 2, pieces: 6 })]);
    render(<OpenOrdersCard productId="p1" unitsPerBox={12} />);
    expect(screen.getByText("of 5 boxes ordered")).toBeInTheDocument();
  });

  it("a line with nothing billed does not say 'ordered'", () => {
    query.data = data([line()]);
    render(<OpenOrdersCard productId="p1" unitsPerBox={12} />);
    expect(screen.queryByText(/ordered/)).toBeNull();
  });

  it("chips show open orders, customers and total qty as boxes + pieces", () => {
    query.data = data([line(), line({ orderId: "o2", customerId: "c2", customerName: "Globex" })], {
      summary: { orders: 2, customers: 2, totalQty: 54 },
    });
    render(<OpenOrdersCard productId="p1" unitsPerBox={12} />);
    // "Open orders" is also the card heading; the chip label is the <p>.
    const chip = (label: string) =>
      screen
        .getAllByText(label)
        .find((el) => el.tagName === "P")!
        .closest("div")!;
    expect(chip("Open orders")).toHaveTextContent("2");
    expect(chip("Customers")).toHaveTextContent("2");
    expect(chip("Total qty")).toHaveTextContent("4 boxes + 6 pcs");
  });

  it("says when only the newest lines are shown", () => {
    query.data = data(
      Array.from({ length: 200 }, (_, i) => line({ orderId: `o${i}` })),
      { truncated: true },
    );
    render(<OpenOrdersCard productId="p1" unitsPerBox={12} />);
    expect(screen.getByText("Showing the newest 200")).toBeInTheDocument();
  });

  it("empty: 'No open orders'", () => {
    query.data = data([], { summary: { orders: 0, customers: 0, totalQty: 0 } });
    render(<OpenOrdersCard productId="p1" unitsPerBox={12} />);
    expect(screen.getByText("No open orders")).toBeInTheDocument();
    expect(screen.getByText("Nobody has this product on an open order.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("error: message and Try again refetches", async () => {
    query = { isLoading: false, isError: true, refetch: jest.fn() };
    render(<OpenOrdersCard productId="p1" unitsPerBox={12} />);
    expect(screen.getByText("Couldn't load open orders.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(query.refetch).toHaveBeenCalledTimes(1);
  });

  it("loading: a skeleton, no table and no empty copy", () => {
    query = { isLoading: true, isError: false, refetch: jest.fn() };
    const { container } = render(<OpenOrdersCard productId="p1" unitsPerBox={12} />);
    expect(screen.getByRole("heading", { name: "Open orders" })).toBeInTheDocument();
    expect(screen.queryByText("No open orders")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(container.querySelector(".skeleton")).not.toBeNull();
  });
});
