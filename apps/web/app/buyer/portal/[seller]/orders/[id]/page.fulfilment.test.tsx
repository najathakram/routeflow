import * as React from "react";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import type { BuyerSellerCapability } from "@routeflow/types";
import BuyerOrderDetailPage from "./page";

/**
 * Business profiles 1B — the buyer order page for a shipping-only seller. A SHIP order shows
 * the shipment (carrier + tracking number, linked when the carrier is known) and a
 * Confirmed → Shipped → Delivered timeline, with no route / driver / ETA wording. A configured
 * seller without a fleet shows no route wording on any order. An UNSET seller, or a capability
 * that cannot be read, is today's screen exactly.
 *
 * Fixtures are placeholders (`Sample …`, `acme`); no live-client names.
 */

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme", id: "ord-1" }),
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({
    isLoading: false,
    activeSeller: {
      tenant: { slug: "acme", name: "Acme Wholesale" },
      customer: { businessName: "Sample Buyer Co" },
    },
  }),
}));

let mockOrder: unknown;
const mockTrackingHook = jest.fn();
jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerOrderTracking: (id: string) => mockTrackingHook(id),
  useBuyerOrder: () => ({ data: mockOrder, isLoading: false, isError: false }),
  useBuyerCancelOrder: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useBuyerUpdateOrderItems: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useBuyerProducts: () => ({ data: undefined }),
  useBuyerCreateChangeRequest: () => ({
    mutateAsync: jest.fn(),
    mutate: jest.fn(),
    isPending: false,
  }),
}));

let mockCaps: { data: unknown; isLoading: boolean; isError: boolean };
jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => mockCaps,
}));

function cap(over: Partial<BuyerSellerCapability> = {}): BuyerSellerCapability {
  return { portalMethods: ["SHIP"], portalDefault: "SHIP", fleet: false, ...over };
}
const SHIP_ONLY = cap();
const UNSET = cap({
  portalMethods: [],
  portalDefault: null,
  fleet: true,
});
const BOTH_FLEET = cap({
  portalMethods: ["ROUTE", "SHIP"],
  portalDefault: "ROUTE",
  fleet: true,
});
const ready = (c: BuyerSellerCapability) => ({
  data: c,
  isLoading: false,
  isError: false,
});

const LINE = {
  id: "li-1",
  productId: "p-1",
  qty: 2,
  unitPrice: 10,
  subtotal: 20,
  priceType: "STANDARD",
  originalPrice: null,
  notes: null,
  status: "PENDING",
  deliveredQty: 0,
  boxes: null,
  pieces: null,
  product: { id: "p-1", name: "Sample Cola 12oz", unit: "each", unitsPerBox: null },
};

function order(over: Record<string, unknown> = {}) {
  return {
    id: "ord-1",
    orderNumber: "ORD-00001",
    status: "CONFIRMED",
    total: 20,
    subtotal: 20,
    taxAmount: 0,
    createdAt: "2026-09-10T12:00:00Z",
    requestedDeliveryDate: null,
    customer: { id: "c-1", businessName: "Sample Buyer Co" },
    lineItems: [LINE],
    invoices: [],
    changeRequests: [],
    editWindow: { editable: false, editableUntil: null, closedReason: null },
    routeRun: null,
    fulfillPath: "ROUTE",
    shippingCarrier: null,
    shippingTrackingNumber: null,
    shippedAt: null,
    ...over,
  };
}

const SHIPPED_UPS = {
  fulfillPath: "SHIP",
  shippingCarrier: "UPS",
  shippingTrackingNumber: "1Z999AA10123456784",
  shippedAt: "2026-10-01T10:00:00Z",
};

/** Route / driver / ETA wording a shipping-only seller's buyer must never see. */
const ROUTE_WORDING =
  /track your delivery|out for delivery|partial delivery|driver|delivery route|stops? before you|arrival window|on the route/i;

beforeEach(() => {
  jest.clearAllMocks();
  mockTrackingHook.mockReturnValue({
    data: { status: "CONFIRMED", tracking: null },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  });
});

describe("shipping-only seller — a shipped SHIP order", () => {
  beforeEach(() => {
    mockCaps = ready(SHIP_ONLY);
    mockOrder = order(SHIPPED_UPS);
  });

  it("shows Shipped, the carrier, and the tracking number linked to the carrier's page", () => {
    renderWithProviders(<BuyerOrderDetailPage />);
    const card = screen.getByTestId("shipment-card");
    expect(within(card).getByRole("heading", { name: "Shipment" })).toBeInTheDocument();
    expect(within(card).getByTestId("shipment-headline")).toHaveTextContent("Shipped");
    expect(within(card).getByText("UPS")).toBeInTheDocument();
    const link = within(card).getByRole("link", { name: "1Z999AA10123456784" });
    expect(link).toHaveAttribute(
      "href",
      "https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456784",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("the timeline is Confirmed → Shipped → Delivered, at Shipped", () => {
    renderWithProviders(<BuyerOrderDetailPage />);
    const timeline = screen.getByTestId("order-timeline");
    const steps = within(timeline)
      .getAllByTestId("timeline-step")
      .map((s) => [s.textContent, s.getAttribute("data-state")]);
    expect(steps).toEqual([
      ["Confirmed", "complete"],
      ["Shipped", "current"],
      ["Delivered", "upcoming"],
    ]);
  });

  it("the status badge reads Shipped", () => {
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.getByTestId("order-status-badge")).toHaveTextContent(/^Shipped$/);
  });

  it("no route, driver or ETA wording anywhere, and no route tracking is fetched", () => {
    const { container } = renderWithProviders(<BuyerOrderDetailPage />);
    expect(container.textContent).not.toMatch(ROUTE_WORDING);
    expect(screen.queryByRole("heading", { name: "Track your delivery" })).toBeNull();
    expect(mockTrackingHook).not.toHaveBeenCalledWith("ord-1");
  });
});

describe("shipping-only seller — other SHIP order states", () => {
  beforeEach(() => {
    mockCaps = ready(SHIP_ONLY);
  });

  it("not shipped yet: says so and where the tracking number will appear", () => {
    mockOrder = order({ fulfillPath: "SHIP" });
    const { container } = renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.getByTestId("shipment-headline")).toHaveTextContent("Not shipped yet");
    expect(screen.getByTestId("shipment-card")).toHaveTextContent(
      "The carrier and tracking number will show here once the seller ships this order.",
    );
    expect(container.textContent).not.toMatch(ROUTE_WORDING);
  });

  it("an unrecognised carrier: the tracking number is plain text, not a link", () => {
    mockOrder = order({ ...SHIPPED_UPS, shippingCarrier: "Acme Couriers" });
    renderWithProviders(<BuyerOrderDetailPage />);
    const card = screen.getByTestId("shipment-card");
    expect(within(card).getByText("Acme Couriers")).toBeInTheDocument();
    expect(within(card).getByText("1Z999AA10123456784")).toBeInTheDocument();
    expect(within(card).queryByRole("link")).toBeNull();
  });

  it("delivered: the timeline is complete and the card says Delivered", () => {
    mockOrder = order({ ...SHIPPED_UPS, status: "DELIVERED" });
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.getByTestId("shipment-headline")).toHaveTextContent("Delivered");
    const states = screen.getAllByTestId("timeline-step").map((s) => s.getAttribute("data-state"));
    expect(states).toEqual(["complete", "complete", "current"]);
  });

  it("a ROUTE order of a seller without a fleet: no tracking card, no route wording", () => {
    mockOrder = order({ status: "OUT_FOR_DELIVERY" });
    const { container } = renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.queryByTestId("shipment-card")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Track your delivery" })).toBeNull();
    expect(container.textContent).not.toMatch(ROUTE_WORDING);
    expect(screen.getAllByTestId("timeline-step").map((s) => s.textContent)).toEqual([
      "Pending",
      "Confirmed",
      "Delivered",
    ]);
  });
});

describe("delivery + shipping seller with a fleet", () => {
  it("a SHIP order is a shipment; a ROUTE order keeps today's tracking card", () => {
    mockCaps = ready(BOTH_FLEET);
    mockOrder = order(SHIPPED_UPS);
    const first = renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.getByTestId("shipment-card")).toBeInTheDocument();
    first.unmount();

    mockOrder = order();
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.queryByTestId("shipment-card")).toBeNull();
    expect(screen.getByRole("heading", { name: "Track your delivery" })).toBeInTheDocument();
  });
});

describe("before == after: unset sellers and an unreadable capability see today's screen", () => {
  const TODAY_STEPS = ["Pending", "Confirmed", "Out for Delivery", "Partial Delivery", "Delivered"];

  it.each([
    ["an unset seller", () => ready(UNSET)],
    ["a capability read that failed", () => ({ data: undefined, isLoading: false, isError: true })],
  ])("%s: today's timeline and tracking card, even on a SHIP order", (_label, caps) => {
    mockCaps = caps();
    for (const o of [order(), order(SHIPPED_UPS)]) {
      mockOrder = o;
      const r = renderWithProviders(<BuyerOrderDetailPage />);
      expect(screen.getAllByTestId("timeline-step").map((s) => s.textContent)).toEqual(TODAY_STEPS);
      expect(screen.getByRole("heading", { name: "Track your delivery" })).toBeInTheDocument();
      expect(screen.queryByTestId("shipment-card")).toBeNull();
      expect(screen.getByTestId("order-status-badge")).toHaveTextContent(/^Confirmed$/);
      r.unmount();
    }
  });

  it("while the capability loads, neither the route card nor the shipment card shows", () => {
    mockCaps = { data: undefined, isLoading: true, isError: false };
    mockOrder = order(SHIPPED_UPS);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.getByText("Sample Cola 12oz")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Track your delivery" })).toBeNull();
    expect(screen.queryByTestId("shipment-card")).toBeNull();
    expect(screen.queryByTestId("order-timeline")).toBeNull();
  });
});
