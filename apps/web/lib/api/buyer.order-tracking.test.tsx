/**
 * #2095 — `useBuyerOrderTracking`: reads the buyer tracking endpoint for this order through the
 * buyer client, keeps refreshing every minute while the delivery is live, and stops once the
 * order is delivered or cancelled. The HTTP client is mocked; TanStack Query and its timer run
 * for real (under Jest's fake clock). Fixtures are placeholders.
 */
import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { OrderTracking, OrderTrackingResponse } from "@routeflow/types";
import { createTestQueryClient } from "@/test-utils/render";
import { buyerApiClient } from "@/lib/buyer-api-client";
import {
  BUYER_TRACKING_POLL_MS,
  buyerTrackingRefetchInterval,
  useBuyerOrderTracking,
} from "./buyer";

jest.mock("@/lib/buyer-api-client", () => ({ buyerApiClient: { get: jest.fn() } }));
const get = buyerApiClient.get as jest.Mock;

function tracking(over: Partial<OrderTracking> = {}): OrderTracking {
  return {
    runId: "run-1",
    routeName: null,
    driverName: "Sam",
    runStatus: "IN_PROGRESS",
    stopNumber: 4,
    stopStatus: "PENDING",
    stopsAhead: 3,
    scheduledDate: "2026-09-29T00:00:00.000Z",
    estimatedArrivalWindow: { start: "09:00", end: "11:30" },
    ...over,
  };
}

const LIVE: OrderTrackingResponse = { status: "CONFIRMED", tracking: tracking() };

function wrapper() {
  const client = createTestQueryClient();
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  get.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("buyerTrackingRefetchInterval", () => {
  it("every minute while the delivery is live", () => {
    expect(BUYER_TRACKING_POLL_MS).toBe(60_000);
    expect(buyerTrackingRefetchInterval(LIVE)).toBe(60_000);
    expect(buyerTrackingRefetchInterval({ status: "OUT_FOR_DELIVERY", tracking: null })).toBe(
      60_000,
    );
    expect(buyerTrackingRefetchInterval({ status: "PARTIALLY_DELIVERED", tracking: null })).toBe(
      60_000,
    );
  });

  it("never once delivered or cancelled, even while the run is still live", () => {
    expect(buyerTrackingRefetchInterval({ status: "DELIVERED", tracking: tracking() })).toBe(false);
    expect(buyerTrackingRefetchInterval({ status: "CANCELLED", tracking: tracking() })).toBe(false);
  });

  it("not before the run starts, and not without data", () => {
    const scheduled = {
      status: "CONFIRMED" as const,
      tracking: tracking({ runStatus: "SCHEDULED" }),
    };
    expect(buyerTrackingRefetchInterval(scheduled)).toBe(false);
    expect(buyerTrackingRefetchInterval({ status: "PENDING", tracking: null })).toBe(false);
    expect(buyerTrackingRefetchInterval(undefined)).toBe(false);
  });
});

describe("useBuyerOrderTracking (#2095)", () => {
  it("reads GET /buyer/orders/:id/tracking through the buyer client", async () => {
    get.mockResolvedValue({ data: LIVE });
    const { result } = renderHook(() => useBuyerOrderTracking("ord-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toEqual(LIVE));
    expect(get).toHaveBeenCalledWith("/buyer/orders/ord-1/tracking");
  });

  it("refreshes every 60 s while the delivery is live", async () => {
    jest.useFakeTimers();
    get.mockResolvedValue({ data: LIVE });
    const { result } = renderHook(() => useBuyerOrderTracking("ord-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toEqual(LIVE));
    expect(get).toHaveBeenCalledTimes(1);

    // Half a period (waitFor's own clock steps are milliseconds, far inside this margin).
    await act(async () => {
      jest.advanceTimersByTime(BUYER_TRACKING_POLL_MS / 2);
    });
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(BUYER_TRACKING_POLL_MS / 2);
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await act(async () => {
      jest.advanceTimersByTime(BUYER_TRACKING_POLL_MS);
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  });

  it("stops refreshing once the order reads delivered", async () => {
    jest.useFakeTimers();
    get.mockResolvedValueOnce({ data: LIVE }).mockResolvedValue({
      data: { status: "DELIVERED", tracking: tracking({ stopStatus: "COMPLETED" }) },
    });
    const { result } = renderHook(() => useBuyerOrderTracking("ord-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.status).toBe("CONFIRMED"));

    await act(async () => {
      jest.advanceTimersByTime(BUYER_TRACKING_POLL_MS);
    });
    await waitFor(() => expect(result.current.data?.status).toBe("DELIVERED"));
    expect(get).toHaveBeenCalledTimes(2);

    await act(async () => {
      jest.advanceTimersByTime(BUYER_TRACKING_POLL_MS * 5);
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not poll a delivery that is not live yet", async () => {
    jest.useFakeTimers();
    get.mockResolvedValue({ data: { status: "PENDING", tracking: null } });
    const { result } = renderHook(() => useBuyerOrderTracking("ord-1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.status).toBe("PENDING"));
    await act(async () => {
      jest.advanceTimersByTime(BUYER_TRACKING_POLL_MS * 3);
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("does nothing without an order id", () => {
    renderHook(() => useBuyerOrderTracking(""), { wrapper: wrapper() });
    expect(get).not.toHaveBeenCalled();
  });
});
