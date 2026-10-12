import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InvoiceRevisionMarks, TenantInvoiceRevisionMarks } from "./InvoiceRevisionMarks";
import { orderRevisionLogHref } from "@/lib/invoice-revision";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(() => Promise.resolve({ data: { timezone: "America/Los_Angeles" } })) },
}));

describe("InvoiceRevisionMarks", () => {
  it("renders nothing when the API sends neither field (contract-first)", () => {
    const { container } = render(<InvoiceRevisionMarks />);
    expect(container).toBeEmptyDOMElement();
  });
  it("renders the Revised badge", () => {
    render(<InvoiceRevisionMarks revisedAt="2026-10-05T15:30:00.000Z" />);
    expect(screen.getByTestId("invoice-revised-badge")).toHaveTextContent(/^Revised \w{3} \d/);
  });
  it("renders Overpaid by only when > 0", () => {
    const { rerender } = render(<InvoiceRevisionMarks overpaidBy={0} />);
    expect(screen.queryByTestId("invoice-overpaid")).toBeNull();
    rerender(<InvoiceRevisionMarks overpaidBy={7.5} />);
    expect(screen.getByTestId("invoice-overpaid")).toHaveTextContent("Overpaid by $7.50");
  });
  it("row 330d: the Revised badge is a one-tap link to the order's edit log when the order is known", () => {
    render(
      <InvoiceRevisionMarks
        revisedAt="2026-10-05T15:30:00.000Z"
        logHref="/orders/o-1#order-revisions"
      />,
    );
    const badge = screen.getByTestId("invoice-revised-badge");
    expect(badge.tagName).toBe("A");
    expect(badge).toHaveAttribute("href", "/orders/o-1#order-revisions");
    expect(badge).toHaveTextContent(/^Revised \w{3} \d/);
  });
  it("row 330d: with no order to link to the badge stays a plain label", () => {
    render(<InvoiceRevisionMarks revisedAt="2026-10-05T15:30:00.000Z" />);
    expect(screen.getByTestId("invoice-revised-badge").tagName).toBe("SPAN");
  });
  it("row 330d: orderRevisionLogHref points at the order page's revisions anchor", () => {
    expect(orderRevisionLogHref("o-1")).toBe("/orders/o-1#order-revisions");
    expect(orderRevisionLogHref(null)).toBeNull();
    expect(orderRevisionLogHref(undefined)).toBeNull();
  });
  it("TenantInvoiceRevisionMarks reads the revised day in the tenant's zone", async () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <TenantInvoiceRevisionMarks revisedAt="2026-10-06T03:30:00.000Z" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Revised Oct 5, 2026")).toBeInTheDocument();
  });
});
