import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import PromotionsPage from "./page";

/**
 * SA-1032: with promotions turned off for the business, the page stays readable but offers no
 * way to create, edit, pause or delete, and says why. On (or unset) is today's page.
 */

let mockMode: string | undefined = "off";
// SA-1032 rule 3: the page reads the mode through the shared promotionsOn, never its own "off".
// Undefined → the real helper; a test sets a value to prove the page obeys the helper.
const mockPromotionsOn = jest.fn<boolean | undefined, [string | null | undefined]>();
jest.mock("@routeflow/types", () => {
  const actual = jest.requireActual("@routeflow/types");
  return {
    ...actual,
    promotionsOn: (mode?: string | null) => mockPromotionsOn(mode) ?? actual.promotionsOn(mode),
  };
});

jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/lib/tenant-features", () => ({
  ...jest.requireActual("@/lib/tenant-features"),
  useTenantFeatures: () => ({
    data: { modes: mockMode === undefined ? {} : { promotions: mockMode } },
  }),
}));
jest.mock("@/lib/api/promotions", () => ({
  ...jest.requireActual("@/lib/api/promotions"),
  usePromotions: () => ({
    data: [
      {
        id: "promo-1",
        name: "Ten off",
        type: "PERCENT",
        value: 10,
        scope: "ALL",
        startsAt: "2026-01-01T00:00:00.000Z",
        endsAt: "2099-01-01T00:00:00.000Z",
        isActive: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    isLoading: false,
    isError: false,
  }),
  useCreatePromotion: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdatePromotion: () => ({ mutate: jest.fn(), isPending: false }),
  useSetPromotionActive: () => ({ mutate: jest.fn(), isPending: false }),
  useDeletePromotion: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
}));

const NOTICE = /Promotions are turned off for this business/;

describe("promotions page with promotions off (SA-1032)", () => {
  it("W-R2: off → read-only list with the notice and no create, edit, pause or delete", () => {
    mockMode = "off";
    renderWithProviders(<PromotionsPage />);
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.getByText("Ten off")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New promotion" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByTitle("Edit")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Delete")).not.toBeInTheDocument();
  });

  it.each([["on"], [undefined]])("mode %s → today's page, every control present", (mode) => {
    mockMode = mode;
    renderWithProviders(<PromotionsPage />);
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New promotion" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByTitle("Edit")).toBeInTheDocument();
    expect(screen.getByTitle("Delete")).toBeInTheDocument();
  });

  it("SA-1032 rule 3: the page decides through the shared promotionsOn", () => {
    mockMode = "on";
    mockPromotionsOn.mockReturnValue(false);
    try {
      renderWithProviders(<PromotionsPage />);
      expect(mockPromotionsOn).toHaveBeenCalledWith("on");
      expect(screen.getByText(NOTICE)).toBeInTheDocument();
    } finally {
      mockPromotionsOn.mockReset();
    }
  });
});
