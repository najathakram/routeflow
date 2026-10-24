import * as React from "react";
import { render, screen } from "@testing-library/react";
import { TotalsSummary } from "./TotalsSummary";
import { orderBuilderTotals } from "@/lib/order-builder-totals";

describe("TotalsSummary (W-882)", () => {
  it("prints grouped money: $12,345.67", () => {
    const totals = orderBuilderTotals([{ unitPrice: 12345.67, qty: 1 }]);
    render(<TotalsSummary totals={totals} />);
    expect(screen.getByTestId("totals-summary-total")).toHaveTextContent("$12,345.67");
  });

  it('the last row reads exactly "Total", never Order total, Estimated total or Amount due (owner ruling 10-24)', () => {
    const totals = orderBuilderTotals([{ unitPrice: 10, qty: 1 }]);
    render(<TotalsSummary totals={totals} />);
    const row = screen.getByTestId("totals-summary-total").parentElement as HTMLElement;
    expect(row.firstElementChild).toHaveTextContent(/^Total$/);
    expect(row.parentElement?.lastElementChild).toBe(row);
    expect(screen.queryByText(/order total|estimated total|amount due/i)).toBeNull();
  });

  it("the tax label names a percent only when a rate is set", () => {
    const totals = orderBuilderTotals([{ unitPrice: 10, qty: 1 }]);
    const { rerender } = render(<TotalsSummary totals={totals} taxRatePct={null} />);
    expect(screen.getByText("Tax")).toBeInTheDocument();
    expect(screen.queryByText(/10%/)).toBeNull();
    rerender(<TotalsSummary totals={totals} taxRatePct={8.25} />);
    expect(screen.getByText("Tax (8.25%)")).toBeInTheDocument();
  });

  it("shows a regulated levy as its own named row, between Tax and Total", () => {
    const cats = new Map([
      ["c1", { id: "c1", name: "CRV deposit", taxType: "EXCISE_PER_UNIT", rate: "0.05" }],
    ]);
    const totals = orderBuilderTotals([{ unitPrice: 2, qty: 10, trackedCategoryId: "c1" }], {
      categoryById: cats,
    });
    render(<TotalsSummary totals={totals} />);
    const row = screen.getByTestId("totals-charge-row");
    expect(row).toHaveTextContent("$0.50");
    expect(screen.getByTestId("totals-summary-total")).toHaveTextContent("$20.50");
  });

  it("the Total equals saleTotals' total to the cent", () => {
    const totals = orderBuilderTotals([{ unitPrice: 10, qty: 1 }], { taxRatePct: 8.25 });
    render(<TotalsSummary totals={totals} taxRatePct={8.25} />);
    expect(screen.getByTestId("totals-summary-total")).toHaveTextContent("$10.83");
  });
});
