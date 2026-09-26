/**
 * #2095 — the buyer's "Track your delivery" card on the order detail, in every state it can be
 * in. The tracking query is mocked at the module boundary; the card's own derivation, copy and
 * privacy rules run for real. Fixtures are placeholders (acme-style), no live-client data.
 */
import * as React from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import type { OrderTracking, OrderTrackingResponse } from "@routeflow/types";
import { createTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { DeliveryTrackingCard } from "./DeliveryTrackingCard";

let mockQuery: {
  data?: OrderTrackingResponse;
  isLoading: boolean;
  isError: boolean;
  refetch: jest.Mock;
};
const mockUseTracking = jest.fn();
jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerOrderTracking: (...args: unknown[]) => {
    mockUseTracking(...args);
    return mockQuery;
  },
}));

function tracking(over: Partial<OrderTracking> = {}): OrderTracking {
  return {
    runId: "run-1",
    routeName: null,
    driverName: "Sam",
    runStatus: "IN_PROGRESS",
    stopNumber: 7,
    stopStatus: "PENDING",
    stopsAhead: 3,
    scheduledDate: "2026-09-29T00:00:00.000Z",
    estimatedArrivalWindow: { start: "09:00", end: "11:30" },
    ...over,
  };
}

function answer(status: OrderTrackingResponse["status"], t: OrderTracking | null) {
  mockQuery = {
    data: { status, tracking: t },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  };
}

const ORDER = { id: "ord-1", status: "CONFIRMED", deliveredAt: null as string | null };

function renderCard(order: { id: string; status: string; deliveredAt?: string | null } = ORDER) {
  return renderWithProviders(<DeliveryTrackingCard order={order} />);
}

const card = () => screen.getByTestId("delivery-tracking");
const status = () => screen.getByTestId("tracking-status");
const headline = () => screen.getByTestId("tracking-headline");
function fact(label: string): string | null {
  const term = within(card()).queryByText(label, { selector: "dt" });
  return term?.nextElementSibling?.textContent ?? null;
}

beforeEach(() => {
  jest.clearAllMocks();
  answer("CONFIRMED", null);
});

describe("DeliveryTrackingCard (#2095)", () => {
  it("asks for this order's tracking", () => {
    renderCard();
    expect(mockUseTracking).toHaveBeenCalledWith("ord-1");
    expect(screen.getByRole("heading", { name: "Track your delivery" })).toBeInTheDocument();
  });

  it("not yet scheduled (no tracking): says so, with no driver, window or live updates", () => {
    answer("CONFIRMED", null);
    renderCard();
    expect(status()).toHaveTextContent("Not scheduled");
    expect(headline()).toHaveTextContent("Not scheduled yet");
    expect(fact("Driver")).toBeNull();
    expect(fact("Delivery window")).toBeNull();
    expect(screen.queryByTestId("tracking-live")).toBeNull();
  });

  it("scheduled: the delivery date, driver first name and window, no stop count yet", () => {
    answer("CONFIRMED", tracking({ runStatus: "SCHEDULED" }));
    renderCard();
    expect(status()).toHaveTextContent("Scheduled");
    expect(headline()).toHaveTextContent("Scheduled for delivery");
    expect(fact("Delivery date")).toBe("Tue, Sep 29");
    expect(fact("Driver")).toBe("Sam");
    expect(fact("Delivery window")).toBe("9:00 AM – 11:30 AM");
    expect(card()).not.toHaveTextContent(/stops? before you/);
  });

  it("out for delivery: N stops before you, the driver, the window, and live updates", () => {
    answer("CONFIRMED", tracking({ stopsAhead: 3 }));
    renderCard();
    expect(status()).toHaveTextContent("On the way");
    expect(headline()).toHaveTextContent("3 stops before you");
    expect(fact("Driver")).toBe("Sam");
    expect(fact("Delivery window")).toBe("9:00 AM – 11:30 AM");
    expect(screen.getByTestId("tracking-live")).toHaveTextContent("Updates every minute");
  });

  it("one stop out is singular", () => {
    answer("OUT_FOR_DELIVERY", tracking({ stopsAhead: 1 }));
    renderCard({ ...ORDER, status: "OUT_FOR_DELIVERY" });
    expect(headline()).toHaveTextContent("1 stop before you");
  });

  it("no stops out: You're next", () => {
    answer("CONFIRMED", tracking({ stopsAhead: 0 }));
    renderCard();
    expect(headline()).toHaveTextContent("You're next");
  });

  it("the driver at your stop: arriving", () => {
    answer("CONFIRMED", tracking({ stopStatus: "IN_PROGRESS", stopsAhead: 0 }));
    renderCard();
    expect(status()).toHaveTextContent("Arriving");
    expect(headline()).toHaveTextContent("Your driver has arrived");
  });

  it("delivered: shows when, and stops live updates", () => {
    answer("DELIVERED", tracking({ stopStatus: "COMPLETED", stopsAhead: 0 }));
    renderCard({ id: "ord-1", status: "DELIVERED", deliveredAt: "2026-09-24T12:00:00.000Z" });
    expect(status()).toHaveTextContent("Delivered");
    expect(headline()).toHaveTextContent("Delivered");
    expect(screen.getByTestId("tracking-detail")).toHaveTextContent(/Delivered on Sep 24, 2026/);
    expect(fact("Driver")).toBeNull();
    expect(screen.queryByTestId("tracking-live")).toBeNull();
  });

  it("delivered with no recorded time still reads delivered", () => {
    answer("DELIVERED", null);
    renderCard({ id: "ord-1", status: "DELIVERED", deliveredAt: null });
    expect(headline()).toHaveTextContent("Delivered");
    expect(screen.getByTestId("tracking-detail")).toHaveTextContent(
      "Your order has been delivered.",
    );
  });

  it("cancelled: nothing to track", () => {
    answer("CANCELLED", tracking());
    renderCard({ ...ORDER, status: "CANCELLED" });
    expect(status()).toHaveTextContent("Cancelled");
    expect(headline()).toHaveTextContent("This order was cancelled");
    expect(fact("Driver")).toBeNull();
    expect(card()).not.toHaveTextContent(/before you|You're next/);
  });

  it("skipped stop: never 'You're next', and says the seller will reschedule", () => {
    answer("CONFIRMED", tracking({ stopStatus: "SKIPPED", stopsAhead: 0 }));
    renderCard();
    expect(status()).toHaveTextContent("Stop skipped");
    expect(screen.getByTestId("tracking-detail")).toHaveTextContent(/reschedule/);
    expect(card()).not.toHaveTextContent("You're next");
  });

  it("partly delivered: says part of the order has come", () => {
    answer("PARTIALLY_DELIVERED", null);
    renderCard({ ...ORDER, status: "PARTIALLY_DELIVERED" });
    expect(status()).toHaveTextContent("Partly delivered");
    expect(headline()).toHaveTextContent("Partly delivered");
  });

  it("out for delivery by the office with no route: no live stop detail", () => {
    answer("OUT_FOR_DELIVERY", null);
    renderCard({ ...ORDER, status: "OUT_FOR_DELIVERY" });
    expect(status()).toHaveTextContent("Out for delivery");
    expect(card()).not.toHaveTextContent(/before you|You're next/);
  });

  describe("privacy", () => {
    it("shows the driver's first name only, whatever the payload carries", () => {
      answer("CONFIRMED", tracking({ driverName: "Sam Rivera" }));
      renderCard();
      expect(fact("Driver")).toBe("Sam");
      expect(card()).not.toHaveTextContent("Rivera");
    });

    it("never shows the route label or a stop number, only the count before you", () => {
      answer("CONFIRMED", tracking({ routeName: "Tuesday North", stopNumber: 7, stopsAhead: 3 }));
      renderCard();
      expect(card()).not.toHaveTextContent("Tuesday North");
      expect(card()).not.toHaveTextContent(/\b7\b/);
      expect(headline()).toHaveTextContent("3 stops before you");
    });
  });

  describe("loading and failure", () => {
    it("loading: a placeholder, not a guess", () => {
      mockQuery = { data: undefined, isLoading: true, isError: false, refetch: jest.fn() };
      renderCard();
      expect(screen.getByTestId("tracking-loading")).toBeInTheDocument();
      expect(screen.queryByTestId("tracking-headline")).toBeNull();
    });

    it("a delivered or cancelled order renders from the order itself while tracking loads", () => {
      mockQuery = { data: undefined, isLoading: true, isError: false, refetch: jest.fn() };
      renderCard({ id: "ord-1", status: "CANCELLED", deliveredAt: null });
      expect(headline()).toHaveTextContent("This order was cancelled");
    });

    it("failed: says so and offers a retry", () => {
      const refetch = jest.fn();
      mockQuery = { data: undefined, isLoading: false, isError: true, refetch };
      renderCard();
      expect(screen.getByTestId("tracking-error")).toHaveTextContent(
        "Live tracking isn't available right now.",
      );
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(refetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("freshness", () => {
    it("when tracking reports a newer order status, the order detail is refetched", () => {
      answer("DELIVERED", tracking({ stopStatus: "COMPLETED" }));
      const queryClient = createTestQueryClient();
      const invalidate = jest.spyOn(queryClient, "invalidateQueries");
      renderWithProviders(
        <DeliveryTrackingCard order={{ id: "ord-1", status: "CONFIRMED", deliveredAt: null }} />,
        { queryClient },
      );
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["buyer", "order", "ord-1"],
        exact: true,
      });
    });

    it("matching statuses refetch nothing", () => {
      answer("CONFIRMED", tracking());
      const queryClient = createTestQueryClient();
      const invalidate = jest.spyOn(queryClient, "invalidateQueries");
      renderWithProviders(<DeliveryTrackingCard order={ORDER} />, { queryClient });
      expect(invalidate).not.toHaveBeenCalled();
    });
  });
});
