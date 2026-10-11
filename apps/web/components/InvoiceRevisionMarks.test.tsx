import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InvoiceRevisionMarks, TenantInvoiceRevisionMarks } from "./InvoiceRevisionMarks";

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
