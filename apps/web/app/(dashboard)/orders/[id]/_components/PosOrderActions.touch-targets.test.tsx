import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/lib/api/invoices", () => ({
  useCreateInvoiceFromOrder: () => ({ isPending: false, mutate: jest.fn() }),
}));
jest.mock("@/components/OrderStatusBadge", () => ({ useOrderStatusLabel: () => (s: string) => s }));
jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return { ...actual, useToast: () => ({ toast: jest.fn() }) };
});

import { PosOrderActions, posMoveOptions } from "./PosOrderActions";
import { PickupHandOverButton } from "./PickupHandOver";

const noop = () => undefined;
const draftInvoice = { id: "i1", status: "DRAFT" } as never;

// jsdom has no layout, so the 44 px touch target (h-11) is asserted as the size class: the shared Button's
// `sm` is h-7 (28 px), which is too small for a till.
function renderActions(status: string, invoices: unknown[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PosOrderActions
        order={{ invoices } as never}
        orderId="o1"
        status={status}
        onHandOver={noop}
        onReadyForPickup={noop}
        moveOptions={{ delivery: "ROUTE", ship: true }}
        onMove={noop}
      />
    </QueryClientProvider>,
  );
}

describe("POS order action buttons are touch-sized (>= 44 px)", () => {
  it.each([
    ["PENDING", []],
    ["CONFIRMED", []],
    ["CONFIRMED", [draftInvoice]],
  ])("every button on a %s order (%j invoices) has the 44 px class", (status, invoices) => {
    renderActions(status as string, invoices as unknown[]);
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.className).toMatch(/\bh-11\b/);
  });

  it("the Picked up button is 44 px too", () => {
    // BO-07: the entry reads the till gate, which needs a query client.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PickupHandOverButton onOpen={noop} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button", { name: "Picked up" }).className).toMatch(/\bh-11\b/);
  });
});

describe("posMoveOptions (M8)", () => {
  it("both paths: two buttons, delivery is the route", () => {
    expect(posMoveOptions(["ROUTE", "SHIP"], "SHIP")).toEqual({ delivery: "ROUTE", ship: true });
  });
  it("ship only: one button, Ship by carrier", () => {
    expect(posMoveOptions(["SHIP"], "SHIP")).toEqual({ delivery: null, ship: true });
  });
  it("route only: the old single Switch to delivery", () => {
    expect(posMoveOptions(["ROUTE"], "ROUTE")).toEqual({ delivery: "ROUTE", ship: false });
  });
  it("neither (pickup-only account): today's lone button, to the account default", () => {
    expect(posMoveOptions([], "SHIP")).toEqual({ delivery: "SHIP", ship: false });
  });
});
