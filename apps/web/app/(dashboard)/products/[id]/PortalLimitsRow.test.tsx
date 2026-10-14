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
const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
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
  viaLabel: null,
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
      data: {
        items: [
          limit({ id: "r1" }),
          limit({
            id: "r2",
            jurisdiction: "FEDERAL",
            states: [],
            via: "CATEGORY",
            viaLabel: "Vapes",
          }),
        ],
        nextCursor: null,
      },
    });
    renderWithProviders(<PortalLimitsRow productId="p1" />);
    expect(await screen.findByText("Not offered in TX")).toBeInTheDocument();
    expect(screen.getByText("Hidden from all portal customers")).toBeInTheDocument();
    expect(screen.getByText("via Vapes")).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith("/selling-restrictions", { params: { productId: "p1" } });
  });

  it("Lift asks `Lift this limit?`, then lifts that rule with the note", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ data: { items: [limit({ id: "r1" })], nextCursor: null } });
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
    mockGet.mockResolvedValue({ data: { items: [limit({ id: "r1" })], nextCursor: null } });
    renderWithProviders(<PortalLimitsRow productId="p1" />);
    expect(await screen.findByText("Not offered in TX")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Lift" })).toBeNull();
  });

  it("no rules reads as offered to everyone", async () => {
    mockGet.mockResolvedValue({ data: { items: [], nextCursor: null } });
    renderWithProviders(<PortalLimitsRow productId="p1" />);
    expect(await screen.findByText("Offered to every portal customer.")).toBeInTheDocument();
  });

  describe("row 509: rules that cover many products", () => {
    const multi = (over: Record<string, unknown> = {}) =>
      limit({
        id: "r9",
        directTarget: true,
        targetSummary: { products: 12, categories: 0, preview: [] },
        ...over,
      });

    it("the chip links to the rule and says how many products it covers", async () => {
      mockGet.mockResolvedValue({ data: { items: [multi()], nextCursor: null } });
      renderWithProviders(<PortalLimitsRow productId="p1" />);
      const link = await screen.findByRole("link", { name: /not offered in tx/i });
      expect(link).toHaveAttribute("href", "/settings/restrictions/rules/r9");
      expect(screen.getByText("· 12 products")).toBeInTheDocument();
    });

    it("a one-product rule says nothing about a count and keeps Lift", async () => {
      mockGet.mockResolvedValue({
        data: {
          items: [
            multi({
              targetSummary: { products: 1, categories: 0, preview: [] },
            }),
          ],
          nextCursor: null,
        },
      });
      renderWithProviders(<PortalLimitsRow productId="p1" />);
      await screen.findByText("Not offered in TX");
      expect(screen.queryByText(/products$/)).toBeNull();
      expect(screen.getByRole("button", { name: "Lift" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Remove from rule" })).toBeNull();
    });

    it("a direct target of a multi-product rule gets Remove from rule, not Lift; Undo re-adds", async () => {
      const user = userEvent.setup();
      mockGet.mockResolvedValue({ data: { items: [multi()], nextCursor: null } });
      mockPost.mockResolvedValue({ data: { removed: 1, notInRule: [], activeTargets: 11 } });
      renderWithProviders(<PortalLimitsRow productId="p1" />);
      await user.click(await screen.findByRole("button", { name: "Remove from rule" }));
      expect(screen.queryByRole("button", { name: "Lift" })).toBeNull();
      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith("/selling-restrictions/r9/targets/remove", {
          productIds: ["p1"],
        }),
      );
      await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
      const shown = toast.mock.calls[0][0];
      expect(shown.title).toBe("Removed from the rule");
      expect(shown.action.label).toBe("Undo");
      expect(shown.secondaryAction.label).toBe("View rule");
      mockPost.mockResolvedValue({ data: { added: 1, skippedIds: [], addedTargetIds: [] } });
      shown.action.onClick();
      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith("/selling-restrictions/r9/targets", {
          productIds: ["p1"],
        }),
      );
    });

    it("an inherited chip keeps Lift even when the rule covers many products", async () => {
      mockGet.mockResolvedValue({
        data: {
          items: [multi({ directTarget: false, via: "CATEGORY", viaLabel: "Vapes" })],
          nextCursor: null,
        },
      });
      renderWithProviders(<PortalLimitsRow productId="p1" />);
      await screen.findByText("via Vapes");
      expect(screen.getByRole("button", { name: "Lift" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Remove from rule" })).toBeNull();
    });

    it("an operator cannot remove a product from an all-customer rule (owner L5)", async () => {
      mockRole = "OPERATOR";
      mockGet.mockResolvedValue({
        data: { items: [multi({ jurisdiction: "FEDERAL", states: [] })], nextCursor: null },
      });
      renderWithProviders(<PortalLimitsRow productId="p1" />);
      expect(await screen.findByRole("button", { name: "Remove from rule" })).toBeDisabled();
    });

    it("Add to a rule… opens the chooser for this one product (operator and up)", async () => {
      const user = userEvent.setup();
      mockGet.mockImplementation(async (url: string, cfg?: { params?: { productId?: string } }) =>
        cfg?.params?.productId ? { data: { items: [multi()], nextCursor: null } } : { data: [] },
      );
      renderWithProviders(<PortalLimitsRow productId="p1" />);
      await user.click(await screen.findByRole("button", { name: "Add to a rule…" }));
      expect(await screen.findByText("Add this product to a rule")).toBeInTheDocument();
    });

    it("Add to a rule… is there even when no rule binds the product", async () => {
      mockGet.mockResolvedValue({ data: { items: [], nextCursor: null } });
      renderWithProviders(<PortalLimitsRow productId="p1" />);
      expect(await screen.findByRole("button", { name: "Add to a rule…" })).toBeInTheDocument();
    });

    it("other roles get no link and no Add to a rule…", async () => {
      mockRole = "DRIVER";
      mockGet.mockResolvedValue({ data: { items: [multi()], nextCursor: null } });
      renderWithProviders(<PortalLimitsRow productId="p1" />);
      await screen.findByText("Not offered in TX");
      expect(screen.queryByRole("link")).toBeNull();
      expect(screen.queryByRole("button", { name: "Add to a rule…" })).toBeNull();
    });
  });
});
