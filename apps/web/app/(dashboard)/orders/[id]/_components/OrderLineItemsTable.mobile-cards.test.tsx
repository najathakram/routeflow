import * as React from "react";
import { render, screen } from "@testing-library/react";
import type { OrderItem } from "@/lib/api/orders";
import { OrderLineItemsTable } from "./OrderLineItemsTable";

/**
 * Row 508: at 390px the 5-column table ran Line Total / Status past the screen. Below md every
 * <tr> is a stacked card (product full width, then Qty / Unit Price / Line Total / Status as
 * labelled pairs); from md up the table is the one it always was. jsdom has no CSS, so these pin
 * the breakpoint wiring: the mobile-only classes, the label of every cell, the value of every
 * cell, and the untouched md+ class tokens. The pixel proof is the host-run capture.
 */

function line(over: Record<string, unknown>): OrderItem {
  return {
    id: "li-1",
    productId: "p-1",
    product: { id: "p-1", name: "Sample Cola 12oz", unit: "each" },
    qty: 8,
    unitPrice: 65,
    priceType: "STANDARD",
    status: "PENDING",
    subtotal: 520,
    ...over,
  } as unknown as OrderItem;
}

const LONG = "Sample Extra Long Wholesale Product Name With Many Words 128oz Family Pack Assorted";

function renderThree() {
  return render(
    <OrderLineItemsTable
      lineItems={[
        line({ id: "a", product: { id: "p-1", name: LONG, unit: "each" } }),
        line({
          id: "b",
          productId: "p-2",
          product: { id: "p-2", name: "Sample Nuts 16oz" },
          qty: 2,
          unitPrice: 7.99,
          subtotal: 15.98,
        }),
        line({
          id: "c",
          productId: null,
          product: null,
          description: "Delivery fee",
          qty: 1,
          unitPrice: 5,
          subtotal: 5,
        }),
      ]}
      orderStatus="CONFIRMED"
      total={540.98}
    />,
  );
}

const MOBILE_CELL_TOKENS = [
  "max-md:block",
  "max-md:p-0",
  "max-md:before:content-[attr(data-label)]",
];

describe("OrderLineItemsTable — stacked cards below md (row 508)", () => {
  it("re-flows the table into blocks and hides the column header below md", () => {
    renderThree();
    expect(screen.getByRole("table")).toHaveClass("max-md:block");
    expect(screen.getAllByRole("columnheader")[0].closest("thead")).toHaveClass("max-md:hidden");
    expect(document.querySelector("tbody")).toHaveClass("max-md:block", "max-md:divide-y-0");
  });

  it("makes every line a card with a full-width product cell", () => {
    renderThree();
    const rows = document.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(3);
    rows.forEach((tr) => {
      expect(tr).toHaveClass("max-md:grid", "max-md:grid-cols-2", "max-md:rounded-lg");
      expect(tr.querySelector("td")).toHaveClass("max-md:col-span-2");
    });
  });

  it("labels Qty, Unit Price, Line Total and Status on every line, on the cell itself", () => {
    renderThree();
    document.querySelectorAll("tbody tr").forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll("td"));
      expect(cells.map((c) => c.getAttribute("data-label"))).toEqual([
        null,
        "Qty",
        "Unit Price",
        "Line Total",
        "Status",
      ]);
      cells.slice(1).forEach((c) => expect(c).toHaveClass(...MOBILE_CELL_TOKENS));
    });
  });

  it("keeps the value of every cell on every line (Line Total included)", () => {
    renderThree();
    const [first, second, third] = Array.from(document.querySelectorAll("tbody tr"));
    expect(first.querySelector('td[data-label="Line Total"]')).toHaveTextContent("$520.00");
    expect(second.querySelector('td[data-label="Line Total"]')).toHaveTextContent("$15.98");
    expect(third.querySelector('td[data-label="Line Total"]')).toHaveTextContent("$5.00");
    expect(second.querySelector('td[data-label="Unit Price"]')).toHaveTextContent("$7.99");
    expect(second.querySelector('td[data-label="Qty"]')).toHaveTextContent("2");
    expect(first.querySelector('td[data-label="Status"]')).toHaveTextContent(/\w/);
    expect(screen.getByText(LONG)).toHaveClass("max-md:break-words");
    expect(screen.getAllByText("Custom")).toHaveLength(1);
  });

  it("keeps the Order Total on one flex line below md and hides the empty status cell", () => {
    renderThree();
    const tfoot = document.querySelector("tfoot") as HTMLElement;
    expect(tfoot).toHaveClass("max-md:block");
    expect(tfoot.querySelector("tr")).toHaveClass("max-md:flex", "max-md:justify-between");
    expect(screen.getByText("Order Total")).toBeInTheDocument();
    expect(screen.getByText("$540.98")).toBeInTheDocument();
    expect(tfoot.querySelector("td:last-child")).toHaveClass("max-md:hidden");
  });

  it("leaves the md+ table classes exactly as they were", () => {
    renderThree();
    expect(screen.getByRole("table")).toHaveClass("w-full", "text-sm");
    expect(document.querySelector("thead")).toHaveClass("border-b", "bg-surface-raised");
    expect(document.querySelector("tbody")).toHaveClass("divide-y", "divide-surface-border");
    const row = document.querySelector("tbody tr") as HTMLElement;
    expect(row).toHaveClass("hover:bg-surface-raised");
    const cells = Array.from(row.querySelectorAll("td"));
    expect(cells[0]).toHaveClass("px-6", "py-3");
    ["Qty", "Unit Price", "Line Total"].forEach((l, i) =>
      expect(cells[i + 1]).toHaveClass("px-4", "py-3", "text-right"),
    );
    expect(cells[4]).toHaveClass("px-6", "py-3");
    expect(document.querySelector("tfoot td")).toHaveClass("px-6", "py-3", "text-right");
  });
});
