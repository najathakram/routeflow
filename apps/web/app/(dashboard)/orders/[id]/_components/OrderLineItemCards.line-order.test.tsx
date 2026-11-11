import * as React from "react";
import { act, fireEvent } from "@testing-library/react";
import { renderWithProviders, screen } from "@/test-utils/render";
import type { OrderItem } from "@/lib/api/orders";
import { OrderLineItemCards } from "./OrderLineItemCards";

/** W-1187: the card list (order_ui_v2) moves a saved line the same way the table does. */
const mockPut = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    put: (...a: unknown[]) => mockPut(...a),
    get: jest.fn(),
    patch: jest.fn(),
    post: jest.fn(),
  },
}));

const line = (id: string, name: string): OrderItem =>
  ({
    id,
    productId: `p-${id}`,
    product: { id: `p-${id}`, name, unit: "each" },
    qty: 1,
    unitPrice: 10,
    priceType: "STANDARD",
    status: "PENDING",
    subtotal: 10,
  }) as unknown as OrderItem;

const many = (n: number) =>
  Array.from({ length: n }, (_, i) => line(`l${i + 1}`, `Sample Item ${i + 1}`));

beforeEach(() => {
  mockPut.mockReset();
  mockPut.mockResolvedValue({
    data: { id: "o-1", updatedAt: "2026-11-11T09:00:00.000Z", lineIds: [] },
  });
});

describe("OrderLineItemCards: moving a saved line (W-1187)", () => {
  it("Alt+Down on a handle sends one PUT with the full permutation", async () => {
    renderWithProviders(
      <OrderLineItemCards
        lineItems={many(3)}
        orderStatus="CONFIRMED"
        total={30}
        orderId="o-1"
        updatedAt="2026-11-11T08:00:00.000Z"
      />,
    );
    const handle = screen.getByRole("button", { name: /Move Sample Item 1, line 1 of 3/ });
    await act(async () => {
      fireEvent.keyDown(handle, { key: "ArrowDown", altKey: true });
    });
    expect(mockPut).toHaveBeenCalledWith("/orders/o-1/line-order", {
      expectedUpdatedAt: "2026-11-11T08:00:00.000Z",
      lineIds: ["l2", "l1", "l3"],
    });
  });

  it("a folded long list has no handles until it is expanded", () => {
    renderWithProviders(
      <OrderLineItemCards
        lineItems={many(8)}
        orderStatus="CONFIRMED"
        total={80}
        orderId="o-1"
        updatedAt="2026-11-11T08:00:00.000Z"
      />,
    );
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show 2 more items/ }));
    expect(screen.getAllByRole("button", { name: /^Move / })).toHaveLength(8);
  });

  it("without the order's id and stamp the list is read-only", () => {
    renderWithProviders(
      <OrderLineItemCards lineItems={many(3)} orderStatus="CONFIRMED" total={30} />,
    );
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
  });

  it("Sort A–Z (PR-2a2) sends one PUT carrying sort name; a read-only list shows no button", async () => {
    const { unmount } = renderWithProviders(
      <OrderLineItemCards
        lineItems={many(3)}
        orderStatus="CONFIRMED"
        total={30}
        orderId="o-1"
        updatedAt="2026-11-11T08:00:00.000Z"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sort A–Z" }));
    });
    expect(mockPut).toHaveBeenCalledWith("/orders/o-1/line-order", {
      expectedUpdatedAt: "2026-11-11T08:00:00.000Z",
      sort: "name",
    });
    unmount();
    renderWithProviders(
      <OrderLineItemCards lineItems={many(3)} orderStatus="CONFIRMED" total={30} />,
    );
    expect(screen.queryByRole("button", { name: "Sort A–Z" })).toBeNull();
  });
});
