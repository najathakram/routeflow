import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { PortalLimitsRow } from "./PortalLimitsRow";

/** C f: the product page's "Portal limits" chips render what the rule does and where it came from, with Lift. */
const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a) },
}));
let mockRole = "TENANT_ADMIN";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: mockRole } }),
}));
const toast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast, dismiss: jest.fn() }),
}));

const limit = (over: Record<string, unknown>) => ({
  id: "r1",
  jurisdiction: "STATE",
  states: ["TX"],
  surface: "BUYER_PORTAL",
  via: "PRODUCT",
  viaName: null,
  reason: "x",
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = "TENANT_ADMIN";
});

describe("PortalLimitsRow (C f)", () => {
  it("renders `Not offered in TX` and `via Vapes` for an inherited rule", async () => {
    mockGet.mockResolvedValue({
      data: [
        limit({ id: "r1" }),
        limit({ id: "r2", jurisdiction: "FEDERAL", states: [], via: "CATEGORY", viaName: "Vapes" }),
      ],
    });
    renderWithProviders(<PortalLimitsRow productId="p1" />);
    expect(await screen.findByText("Not offered in TX")).toBeInTheDocument();
    expect(screen.getByText("Hidden from all portal customers")).toBeInTheDocument();
    expect(screen.getByText("via Vapes")).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith("/selling-restrictions", { params: { productId: "p1" } });
  });

  it("Lift asks `Lift this limit?`, then lifts that rule with the note", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ data: [limit({ id: "r1" })] });
    mockPost.mockResolvedValue({ data: { lifted: 1 } });
    renderWithProviders(<PortalLimitsRow productId="p1" />);
    await user.click(await screen.findByRole("button", { name: "Lift" }));
    expect(screen.getByText("Lift this limit?")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/note/i), "Licensed now");
    await user.click(screen.getAllByRole("button", { name: "Lift" }).at(-1)!);
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith("/selling-restrictions/lift-batch", {
        ids: ["r1"],
        reason: "Licensed now",
      }),
    );
  });

  it("a customer-facing or read-only role sees the chips without Lift", async () => {
    mockRole = "DRIVER";
    mockGet.mockResolvedValue({ data: [limit({ id: "r1" })] });
    renderWithProviders(<PortalLimitsRow productId="p1" />);
    expect(await screen.findByText("Not offered in TX")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Lift" })).toBeNull();
  });

  it("no rules reads as offered to everyone", async () => {
    mockGet.mockResolvedValue({ data: [] });
    renderWithProviders(<PortalLimitsRow productId="p1" />);
    expect(await screen.findByText("Offered to every portal customer.")).toBeInTheDocument();
  });
});
