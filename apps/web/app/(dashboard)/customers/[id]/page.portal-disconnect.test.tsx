import * as React from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import CustomerDetailPage from "./page";

/**
 * UX guide improvement 6: Disconnect Portal used to act on one click. It now asks first, names the
 * consequence, and "Keep connected" leaves the connection alone. The button itself is a red outline.
 */
const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "c1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  usePathname: () => "/customers/c1",
  useSearchParams: () => new URLSearchParams(""),
}));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => mockGet(...a),
    patch: jest.fn(),
    post: (...a: unknown[]) => mockPost(...a),
    delete: jest.fn(),
  },
}));

const customer = {
  id: "c1",
  businessName: "Acme Foods",
  contactName: "Pat Lee",
  customerType: "BUSINESS",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "ACTIVE",
  pricingTier: 1,
  user: { status: "ACTIVE" },
  addresses: [],
};
const route = (url: string) => {
  if (url === "/customers/c1") return Promise.resolve({ data: customer });
  if (url === "/customers/c1/portal-status") {
    return Promise.resolve({ data: { status: "ACTIVE", email: "pat@example.com" } });
  }
  if (url === "/customers/c1/statement") {
    return Promise.resolve({ data: { transactions: [], creditExposure: 0 } });
  }
  if (url === "/policies") return Promise.resolve({ data: { policies: [] } });
  return Promise.resolve({ data: [] });
};
const disconnectCalls = () =>
  mockPost.mock.calls.filter((c) => String(c[0]).includes("/portal-disconnect"));

describe("customers/[id] Disconnect Portal confirmation (UX guide improvement 6)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockImplementation(route);
    mockPost.mockResolvedValue({ data: {} });
  });

  it("the first click opens a confirmation and does not disconnect", async () => {
    renderWithProviders(<CustomerDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Portal" }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("Disconnect this customer's portal?")).toBeTruthy();
    expect(
      within(dlg).getByText("They can't sign in to order or pay until you invite them again."),
    ).toBeTruthy();
    expect(disconnectCalls()).toHaveLength(0);
  });

  it("Disconnect in the dialog calls the mutation once", async () => {
    renderWithProviders(<CustomerDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Portal" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(disconnectCalls()).toHaveLength(1));
  });

  it("Keep connected closes the dialog with no call", async () => {
    renderWithProviders(<CustomerDetailPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Portal" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "Keep connected" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(disconnectCalls()).toHaveLength(0);
  });
});
