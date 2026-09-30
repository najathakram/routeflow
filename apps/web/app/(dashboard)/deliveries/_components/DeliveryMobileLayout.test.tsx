import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import type { RouteTemplateStop } from "@/lib/api/routes";
import { DeliveryMobileLayout } from "./DeliveryMobileLayout";

// TemplateRouteMap mounts a real (billable) Google Maps instance and needs a
// `google` global jsdom doesn't provide — stub it with plain buttons that
// call the same callback props, so this test exercises DeliveryMobileLayout's
// own interplay logic (map⇄list sync, collapse-on-map-tap) without touching
// the maps library at all.
jest.mock("../../routes/templates/[id]/TemplateRouteMap", () => ({
  TemplateRouteMap: (props: {
    stops: RouteTemplateStop[];
    selectedStopId?: string | null;
    onSelectStop?: (id: string) => void;
    onMapClick?: () => void;
  }) => (
    <div data-testid="mock-map">
      <button type="button" onClick={() => props.onMapClick?.()}>
        map background
      </button>
      {props.stops.map((s) => (
        <button key={s.id} type="button" onClick={() => props.onSelectStop?.(s.id)}>
          marker {s.stopNumber}
        </button>
      ))}
      <span data-testid="map-selected-stop">{props.selectedStopId ?? ""}</span>
    </div>
  ),
}));

const stop: RouteTemplateStop = {
  id: "stop-1",
  stopNumber: 1,
  customerId: "c1",
  customer: { id: "c1", businessName: "Acme Foods" },
  customerAddress: { id: "addr-1", line1: "1 Main St", city: "Town", state: "ST", lat: 1, lng: 1 },
};

function builtProps(overrides: Partial<React.ComponentProps<typeof DeliveryMobileLayout>> = {}) {
  return {
    phase: "BUILT" as const,
    mapStops: [stop],
    groups: [{ customerId: "c1", customerName: "Acme Foods", orderIds: ["o1"] }],
    orderLookup: { o1: { orderNumber: "1001" } },
    skipped: [],
    orderIds: [],
    onAddOrder: jest.fn(),
    variants: [],
    selectedVariantKey: null,
    onSelectVariant: jest.fn(),
    variantsLoading: false,
    onUseVariant: jest.fn(),
    useVariantDisabled: true,
    useVariantPending: false,
    summary: "1 stop · 1 order",
    primary: { label: "Send", onClick: jest.fn() },
    builtSummarySlot: <p>built summary</p>,
    ...overrides,
  };
}

describe("DeliveryMobileLayout — map⇄sheet interplay", () => {
  it("tapping the empty map background collapses the sheet to peek and clears the selection", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DeliveryMobileLayout {...builtProps()} />);

    // Select a marker first so there's something to clear.
    await user.click(screen.getByRole("button", { name: "marker 1" }));
    expect(screen.getByTestId("map-selected-stop")).toHaveTextContent("stop-1");
    expect(screen.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "half");

    await user.click(screen.getByRole("button", { name: "map background" }));

    expect(screen.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "peek");
    expect(screen.getByTestId("map-selected-stop")).toHaveTextContent("");
  });

  it("tapping a marker highlights it, lifts the sheet from peek to half, and highlights the matching list row", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DeliveryMobileLayout {...builtProps()} />);

    // Force peek first (default is half) via the drag-handle button, then
    // exercise the marker tap from there.
    const handle = screen.getByRole("button", { name: /delivery details, half expanded/i });
    await user.click(handle);
    expect(screen.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "full");
    await user.click(screen.getByRole("button", { name: /delivery details, fully expanded/i }));
    expect(screen.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "peek");

    await user.click(screen.getByRole("button", { name: "marker 1" }));

    expect(screen.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "half");
    expect(screen.getByTestId("map-selected-stop")).toHaveTextContent("stop-1");
    // TripStopList's row for this customer is highlighted (ring/selected styling).
    expect(document.getElementById("trip-stop-c1")).toHaveClass("border-brand-500");
  });

  it("tapping a stop in the list highlights its marker (list → map sync)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DeliveryMobileLayout {...builtProps()} />);

    const row = document.getElementById("trip-stop-c1");
    expect(row).toBeTruthy();
    await user.click(row!);

    expect(screen.getByTestId("map-selected-stop")).toHaveTextContent("stop-1");
  });

  it("PICKING phase: the order picker and skipped panel only render at the full detent", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <DeliveryMobileLayout
        {...builtProps({
          phase: "PICKING",
          planningSlot: <p>planning form</p>,
          builtSummarySlot: undefined,
          onRemoveCustomer: jest.fn(),
          onRemoveOrder: jest.fn(),
        })}
      />,
    );

    // Default detent is "half" — no order picker / skipped panel yet.
    expect(screen.queryByPlaceholderText(/search order # or customer/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/skipped \(/i)).not.toBeInTheDocument();

    const handle = screen.getByRole("button", { name: /delivery details, half expanded/i });
    await user.click(handle);
    expect(screen.getByTestId("delivery-sheet")).toHaveAttribute("data-detent", "full");

    expect(screen.getByPlaceholderText(/search order # or customer/i)).toBeInTheDocument();
    expect(screen.getByText(/skipped \(/i)).toBeInTheDocument();
  });
});
