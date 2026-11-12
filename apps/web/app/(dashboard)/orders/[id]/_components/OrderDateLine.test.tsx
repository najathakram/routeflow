import * as React from "react";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { OrderDateHeader, OrderDateRow } from "./OrderDateLine";

// W-1188: what the order shows. A dated sale reads as ONE pair "Dated … · entered …"; an undated one is unchanged.
const get = jest.fn();
jest.mock("@/lib/api-client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));

beforeEach(() => {
  jest.clearAllMocks();
  get.mockResolvedValue({ data: { timezone: "America/Chicago" } });
});

// entered Mon Nov 9 2026 4:12 PM Chicago = 22:12Z
const ENTERED = "2026-11-09T22:12:00.000Z";

describe("OrderDateHeader", () => {
  it("a backdated order is one line: Dated Fri, Nov 6 · entered Mon, Nov 9, 4:12 PM", async () => {
    renderWithProviders(
      <OrderDateHeader createdAt={ENTERED} orderDate="2026-11-06T00:00:00.000Z" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("order-dated-line")).toHaveTextContent(
        "Dated Fri, Nov 6 · entered Mon, Nov 9, 4:12 PM",
      ),
    );
    expect(screen.queryByText(/^Created/)).toBeNull();
    expect(screen.queryByText(/Order date:/)).toBeNull();
  });

  it("a future-dated order says future", async () => {
    renderWithProviders(
      <OrderDateHeader createdAt={ENTERED} orderDate="2026-11-16T00:00:00.000Z" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("order-dated-line")).toHaveTextContent(
        "Dated Mon, Nov 16 (future) · entered Mon, Nov 9, 4:12 PM",
      ),
    );
  });

  it("an undated order keeps Created", async () => {
    renderWithProviders(<OrderDateHeader createdAt={ENTERED} orderDate={null} />);
    expect(await screen.findByText(/^Created Nov 9, 2026/)).toBeInTheDocument();
    expect(screen.queryByTestId("order-dated-line")).toBeNull();
  });

  it("an order dated to its own entry day keeps Created and the plain Order date pill", async () => {
    renderWithProviders(
      <OrderDateHeader createdAt={ENTERED} orderDate="2026-11-09T00:00:00.000Z" />,
    );
    expect(await screen.findByText(/^Created Nov 9, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Order date: Nov 9, 2026/)).toBeInTheDocument();
    expect(screen.queryByTestId("order-dated-line")).toBeNull();
  });
});

describe("OrderDateRow", () => {
  it("shows the chosen day and when it was entered", async () => {
    renderWithProviders(<OrderDateRow createdAt={ENTERED} orderDate="2026-11-06T00:00:00.000Z" />);
    await waitFor(() =>
      expect(screen.getByTestId("order-dated-row")).toHaveTextContent(
        "Order dateFri, Nov 6 · entered Mon, Nov 9, 4:12 PM",
      ),
    );
  });
  it("renders nothing for an undated order", () => {
    renderWithProviders(<OrderDateRow createdAt={ENTERED} orderDate={null} />);
    expect(screen.queryByText("Order date")).toBeNull();
  });
});
