import * as React from "react";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import SettingsPage from "./page";

// The Fulfillment tab is dark behind the API's FULFILMENT_SELF_SERVE: `?tab=fulfilment` renders it only
// when GET /settings/fulfilment says `selfServe`. Otherwise the page is exactly what it was (an unknown
// tab falls back to the hub), and a page that is not on that tab never calls the endpoint.

let mockRole = "TENANT_ADMIN";
let mockTab: string | null = null;
const get = jest.fn();

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", username: "someone", role: mockRole } }),
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockTab ? `tab=${mockTab}` : ""),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/api/restrictions-settings", () => ({
  useRestrictionsSettings: () => ({ data: { enabled: true }, isLoading: false, isError: false }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

const fulfilment = (selfServe: boolean) => ({
  fulfilmentModel: { value: "unset", effective: "unset", options: [] },
  counterSales: { value: "off", effective: "off" },
  capability: {},
  selfServe,
  canEdit: selfServe,
  fingerprint: "fp-aaaaaaaaaaaa1",
  lastChange: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = "TENANT_ADMIN";
  mockTab = null;
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/settings/fulfilment" ? fulfilment(true) : {} }),
  );
});

const asked = () => get.mock.calls.filter(([url]) => url === "/settings/fulfilment");

describe("SettingsPage — Fulfillment tab", () => {
  it("?tab=fulfilment shows the tab when selfServe is on", async () => {
    mockTab = "fulfilment";
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByRole("heading", { name: "Fulfillment" })).toBeInTheDocument();
    expect(await screen.findByText("Counter sales")).toBeInTheDocument();
    expect(screen.getByText("All settings")).toBeInTheDocument();
  });

  it("?tab=fulfilment with selfServe off falls back to the hub, as an unknown tab does", async () => {
    mockTab = "fulfilment";
    get.mockImplementation((url: string) =>
      Promise.resolve({ data: url === "/settings/fulfilment" ? fulfilment(false) : {} }),
    );
    renderWithProviders(<SettingsPage />);
    await waitFor(() => expect(asked()).toHaveLength(1));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Fulfillment" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Counter sales")).not.toBeInTheDocument();
    expect(screen.queryByText("All settings")).not.toBeInTheDocument();
  });

  it("the bare hub never calls the endpoint and has no Fulfillment entry", async () => {
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(asked()).toHaveLength(0);
    expect(screen.queryByText("Fulfillment")).not.toBeInTheDocument();
    expect(document.querySelector('a[href*="tab=fulfilment"]')).toBeNull();
  });

  it("another tab never calls the endpoint either", async () => {
    mockTab = "costing";
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByRole("heading", { name: "Costing" })).toBeInTheDocument();
    expect(asked()).toHaveLength(0);
  });

  it.each(["CUSTOMER", "DRIVER"])(
    "%s deep-linking ?tab=fulfilment gets only their account and no call",
    async (role) => {
      mockRole = role;
      mockTab = "fulfilment";
      renderWithProviders(<SettingsPage />);
      expect(await screen.findByText("Google Sign-In")).toBeInTheDocument();
      expect(asked()).toHaveLength(0);
      expect(screen.queryByRole("heading", { name: "Fulfillment" })).not.toBeInTheDocument();
    },
  );
});
