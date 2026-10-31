import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({ mayUseTill: true, loading: false }),
}));
jest.mock("@/lib/api/invoices", () => ({
  useCreateInvoiceFromOrder: () => ({ isPending: false, mutate: jest.fn() }),
}));
jest.mock("@/components/OrderStatusBadge", () => ({ useOrderStatusLabel: () => (s: string) => s }));
jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return { ...actual, useToast: () => ({ toast: jest.fn() }) };
});

import { PosOrderActions } from "./PosOrderActions";

function renderActions(status: string, onReadyForPickup = jest.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PosOrderActions
        order={{ invoices: [] } as never}
        orderId="o1"
        status={status}
        onHandOver={() => undefined}
        onReadyForPickup={onReadyForPickup}
        onConfirm={() => undefined}
        moveOptions={{ delivery: "ROUTE", ship: false }}
        onMove={() => undefined}
      />
    </QueryClientProvider>,
  );
  return onReadyForPickup;
}
const ready = () => screen.queryAllByRole("button", { name: "Ready for pickup" });

/** W-1043 (SA-1062 #2): a PICKUP order offers Ready for pickup at PENDING and CONFIRMED; at Ready and after, Hand over. */
describe("PosOrderActions: Ready for pickup", () => {
  it("PENDING offers it, 44 px, ahead of the move-off-pickup buttons", () => {
    const onReady = renderActions("PENDING");
    const buttons = ready();
    expect(buttons).toHaveLength(1);
    expect(buttons[0].className).toMatch(/\bh-11\b/);
    const all = screen.getAllByRole("button");
    expect(all[0]).toBe(buttons[0]);
    fireEvent.click(buttons[0]);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("CONFIRMED still offers exactly one", () => {
    renderActions("CONFIRMED");
    expect(ready()).toHaveLength(1);
  });

  it.each(["OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"])("%s offers none", (status) => {
    renderActions(status);
    expect(ready()).toHaveLength(0);
  });
});
