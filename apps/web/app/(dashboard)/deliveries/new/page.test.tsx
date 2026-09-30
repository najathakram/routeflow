import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import NewTripPage from "./page";

/**
 * `/deliveries/new` below `lg` swaps the classic two-column body for the
 * map-canvas + bottom-sheet layout (owner-requested phone UX, 2026-09-17).
 * This file proves the desktop branch is untouched at a `lg`+ width and that
 * the mobile branch mounts instead below it — see DeliveryMobileLayout's own
 * test file for the map⇄sheet interplay itself.
 *
 * Every data hook is mocked to a stable, empty-but-valid shape: this is a
 * layout-selection test, not an integration test of the trip-builder's
 * business logic (that's what the rest of this page's behavior already
 * relies on manual/e2e coverage for — see e2e/20-trip-builder-gate.spec.ts).
 */

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock("@/lib/api/routes", () => ({
  useCreateTrip: () => ({ mutate: jest.fn(), isPending: false }),
  useCreateRouteRun: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteRoute: () => ({ mutate: jest.fn(), isPending: false }),
  useOptimizeTemplate: () => ({ mutate: jest.fn(), isPending: false }),
  useRoute: () => ({ data: undefined }),
  useRouteSettings: () => ({ data: undefined }),
  useTripEligibility: () => ({ data: [], isLoading: false, isError: false, refetch: jest.fn() }),
  useUpdateRoute: () => ({ mutate: jest.fn(), isPending: false }),
  useRouteVariants: () => ({ mutate: jest.fn(), isPending: false }),
  useApplyRouteVariant: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock("@/lib/api/drivers", () => ({
  useDrivers: () => ({ data: { data: [] } }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

// TemplateRouteMap mounts a real Google Maps instance — irrelevant to layout
// selection and unavailable in jsdom. Stubbed identically for both branches;
// DeliveryMobileLayout.test.tsx covers the real map⇄sheet behavior.
jest.mock("../../routes/templates/[id]/TemplateRouteMap", () => ({
  TemplateRouteMap: () => <div data-testid="mock-map" />,
}));

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
}

describe("NewTripPage — layout selection", () => {
  const originalInnerWidth = window.innerWidth;
  afterEach(() => {
    setViewportWidth(originalInnerWidth);
  });

  it("at a desktop width (1440), renders the classic two-column layout with no bottom sheet", async () => {
    setViewportWidth(1440);
    renderWithProviders(<NewTripPage />);

    expect(await screen.findByTestId("delivery-desktop-layout")).toBeInTheDocument();
    expect(screen.queryByTestId("delivery-mobile-layout")).not.toBeInTheDocument();
    expect(screen.queryByTestId("delivery-sheet")).not.toBeInTheDocument();
    // The Build button lives in the top bar at this width, not a sheet.
    expect(screen.getByRole("button", { name: /^build/i })).toBeInTheDocument();
  });

  it("below `lg` (390), renders the map-canvas + bottom-sheet layout instead", async () => {
    setViewportWidth(390);
    renderWithProviders(<NewTripPage />);

    expect(await screen.findByTestId("delivery-mobile-layout")).toBeInTheDocument();
    expect(screen.queryByTestId("delivery-desktop-layout")).not.toBeInTheDocument();
    expect(screen.getByTestId("delivery-sheet")).toBeInTheDocument();
  });
});
