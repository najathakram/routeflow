import * as React from "react";
import { act, fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import type { OrderItem } from "@/lib/api/orders";
import { OrderLineItemsTable } from "./OrderLineItemsTable";

/**
 * W-1187 R17: the saved order's lines can be moved. A drop of row 3 on row 1 sends ONE
 * `PUT /orders/:id/line-order` with every line id in the new order and the `updatedAt` the page read.
 * Master sends nothing: the table has no way to move a line.
 */
const mockPut = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    put: (...a: unknown[]) => mockPut(...a),
    get: jest.fn(),
    patch: jest.fn(),
    post: jest.fn(),
  },
}));

let dragEnd: ((e: { active: { id: string }; over: { id: string } | null }) => void) | undefined;
jest.mock("@dnd-kit/core", () => {
  const actual = jest.requireActual("@dnd-kit/core");
  return {
    ...actual,
    DndContext: (props: { onDragEnd?: typeof dragEnd; children: React.ReactNode }) => {
      dragEnd = props.onDragEnd;
      return <actual.DndContext {...props} />;
    },
  };
});

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

const LINES = [
  line("l1", "Sample Apple"),
  line("l2", "Sample Pear"),
  line("l3", "Sample Zucchini"),
];
const STAMP = "2026-11-11T08:00:00.000Z";

function renderTable(status = "CONFIRMED") {
  return renderWithProviders(
    <OrderLineItemsTable
      lineItems={LINES}
      orderStatus={status}
      total={30}
      orderId="o-1"
      updatedAt={STAMP}
    />,
  );
}
const names = () =>
  screen
    .getAllByRole("row")
    .map((r) => r.textContent ?? "")
    .filter((t) => t.includes("Sample"))
    .map((t) => /Sample [A-Za-z]+/.exec(t)![0]);

beforeEach(() => {
  mockPut.mockReset();
  mockPut.mockResolvedValue({
    data: { id: "o-1", updatedAt: "2026-11-11T08:00:05.000Z", lineIds: ["l3", "l1", "l2"] },
  });
  dragEnd = undefined;
});

describe("OrderLineItemsTable: moving a saved line (W-1187 PR-2a)", () => {
  it("R17: dropping row 3 on row 1 sends one PUT with the full permutation and updatedAt", async () => {
    renderTable();
    await act(async () => {
      dragEnd?.({ active: { id: "l3" }, over: { id: "l1" } });
    });
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockPut).toHaveBeenCalledWith("/orders/o-1/line-order", {
      expectedUpdatedAt: STAMP,
      lineIds: ["l3", "l1", "l2"],
    });
  });

  it("the list moves at once, and a toast names the move with Undo", async () => {
    renderTable();
    await act(async () => {
      dragEnd?.({ active: { id: "l3" }, over: { id: "l1" } });
    });
    expect(names()).toEqual(["Sample Zucchini", "Sample Apple", "Sample Pear"]);
    expect(await screen.findByText("Moved Sample Zucchini to line 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("Undo sends the previous list back", async () => {
    renderTable();
    await act(async () => {
      dragEnd?.({ active: { id: "l3" }, over: { id: "l1" } });
    });
    mockPut.mockClear();
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    });
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockPut.mock.calls[0][1].lineIds).toEqual(["l1", "l2", "l3"]);
    expect(mockPut.mock.calls[0][1].expectedUpdatedAt).toBe("2026-11-11T08:00:05.000Z");
  });

  it("Alt+Up on a row's handle moves that row up by one", async () => {
    renderTable();
    const handle = screen.getByRole("button", { name: /Move Sample Zucchini, line 3 of 3/ });
    await act(async () => {
      fireEvent.keyDown(handle, { key: "ArrowUp", altKey: true });
    });
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockPut.mock.calls[0][1].lineIds).toEqual(["l1", "l3", "l2"]);
  });

  it("a 409 snaps back to the server's order with the changed-elsewhere toast", async () => {
    mockPut.mockRejectedValueOnce({
      response: { status: 409, data: { code: "ORDER_CHANGED_DURING_EDIT" } },
    });
    renderTable();
    await act(async () => {
      dragEnd?.({ active: { id: "l3" }, over: { id: "l1" } });
    });
    expect(
      await screen.findByText("This order changed on another screen. Showing the latest."),
    ).toBeInTheDocument();
    expect(names()).toEqual(["Sample Apple", "Sample Pear", "Sample Zucchini"]);
  });

  it("a cancelled order and a one-line order show no handles", () => {
    const { unmount } = renderTable("CANCELLED");
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    unmount();
    renderWithProviders(
      <OrderLineItemsTable
        lineItems={[LINES[0]]}
        orderStatus="CONFIRMED"
        total={10}
        orderId="o-1"
        updatedAt={STAMP}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
  });

  it("the handle is described for a screen reader", () => {
    renderTable();
    const handle = screen.getByRole("button", { name: /Move Sample Apple, line 1 of 3/ });
    const desc = document.getElementById(handle.getAttribute("aria-describedby") ?? "");
    expect(desc?.textContent).toContain("Press Space to pick up");
    expect(
      within(handle.closest("tr") as HTMLElement).getByText("Sample Apple"),
    ).toBeInTheDocument();
  });
});
