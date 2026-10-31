import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mutate = jest.fn();
jest.mock("@/lib/api/invoices", () => ({
  useCreateInvoiceFromOrder: () => ({ isPending: false, mutate }),
}));
jest.mock("@/components/OrderStatusBadge", () => ({ useOrderStatusLabel: () => (s: string) => s }));
jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return { ...actual, useToast: () => ({ toast: jest.fn() }) };
});

import { PosOrderActions } from "./PosOrderActions";

function renderActions(status: string, invoices: Array<{ id: string; status: string }> = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PosOrderActions
        order={{ invoices, fulfillPath: "PICKUP" } as never}
        orderId="o1"
        status={status}
        onHandOver={() => undefined}
        onReadyForPickup={() => undefined}
        onConfirm={() => undefined}
        moveOptions={{ delivery: "ROUTE", ship: false }}
        onMove={() => undefined}
      />
    </QueryClientProvider>,
  );
}
const create = () => screen.queryByRole("button", { name: "Create invoice" });

beforeEach(() => mutate.mockClear());

/** SA-1066 M2: a Ready (OUT_FOR_DELIVERY) POS order with no invoice can still make one, as a secondary. */
describe("PosOrderActions: Create invoice at Ready", () => {
  it("R2: Ready with no invoice offers Create invoice, 44 px, as a secondary (never a filled primary)", () => {
    renderActions("OUT_FOR_DELIVERY");
    expect(create()).toBeInTheDocument();
    expect(create()).not.toHaveClass("bg-accent-strong");
    expect(create()).toHaveClass("h-11");
  });

  it("R2: it runs the same mutation for the same order", () => {
    renderActions("OUT_FOR_DELIVERY");
    fireEvent.click(create()!);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toBe("o1");
  });

  it("R2a: an invoice exists, so there is no Create invoice", () => {
    renderActions("OUT_FOR_DELIVERY", [{ id: "i1", status: "SENT" }]);
    expect(create()).toBeNull();
  });

  it("R2a: a VOID invoice is not an invoice, so the button is still offered", () => {
    renderActions("OUT_FOR_DELIVERY", [{ id: "i1", status: "VOID" }]);
    expect(create()).toBeInTheDocument();
  });

  it("R2c: this component adds nothing else at Ready (Hand over stays the page's one primary)", () => {
    renderActions("OUT_FOR_DELIVERY");
    expect(screen.queryAllByRole("button")).toHaveLength(1);
  });
});

/** SA-1066 F02: a Pending POS order with no invoice shows Create invoice in the top buttons, as a secondary. */
describe("PosOrderActions: Create invoice at Pending", () => {
  it("F02: Pending with no invoice offers Create invoice, 44 px, never a filled primary", () => {
    renderActions("PENDING");
    expect(create()).toBeInTheDocument();
    expect(create()).not.toHaveClass("bg-accent-strong");
    expect(create()).toHaveClass("h-11");
  });

  it("F02: it runs the same mutation for the same order", () => {
    renderActions("PENDING");
    fireEvent.click(create()!);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toBe("o1");
  });

  it("F02: Ready for pickup stays the first (primary) button", () => {
    renderActions("PENDING");
    expect(screen.getAllByRole("button")[0]).toHaveTextContent("Ready for pickup");
  });

  it("F02: an invoice exists, so there is no Create invoice", () => {
    renderActions("PENDING", [{ id: "i1", status: "SENT" }]);
    expect(create()).toBeNull();
  });

  it("F02: a VOID invoice is not an invoice, so the button is still offered", () => {
    renderActions("PENDING", [{ id: "i1", status: "VOID" }]);
    expect(create()).toBeInTheDocument();
  });
});
