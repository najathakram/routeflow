/**
 * R24 / T24: saving a catalog price no longer PATCHes straight away. It asks the API how many businesses the
 * change re-prices (GET price-impact), shows a confirm that names the count and the monthly total, and only
 * Confirm runs the PATCH. Cancel makes no call; a failed check blocks the confirm and offers Retry.
 */
import * as React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import AdminPlansPage from "./page";

const mockStats = jest.fn();
jest.mock("@/lib/admin-api", () => ({
  superAdminClient: { get: (...args: unknown[]) => mockStats(...args) },
}));

const mockCatalog = jest.fn();
const mockImpact = jest.fn();
const mockPatch = jest.fn();
jest.mock("@/lib/api/platform-pricing", () => ({
  // the real 409 matcher (the code constant lives in the module under test's neighbour, not in this mock)
  isPlanPriceImpactChanged: jest.requireActual("@/lib/api/platform-pricing")
    .isPlanPriceImpactChanged,
  fetchPlanCatalog: () => mockCatalog(),
  fetchPlanPriceImpact: (...args: unknown[]) => mockImpact(...args),
  updatePlanPrices: (...args: unknown[]) => mockPatch(...args),
  platformPricingErrorMessage: (
    err: { response?: { data?: { message?: string } } },
    fallback: string,
  ) => err?.response?.data?.message ?? fallback,
}));

const growth = {
  planKey: "GROWTH",
  name: "Growth",
  monthlyPrice: "100",
  annualPrice: "1000",
  isCustom: false,
  sortOrder: 1,
};

const impact = (over: Record<string, unknown> = {}) => ({
  planKey: "GROWTH",
  currentMonthly: 100,
  newMonthly: 149,
  affected: 12,
  ownPrice: 3,
  monthlyDelta: 100,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockStats.mockResolvedValue({ data: { planBreakdown: { GROWTH: 15 } } });
  mockCatalog.mockResolvedValue({ version: 11, effectiveAt: null, plans: [growth] });
  mockImpact.mockResolvedValue(impact());
  mockPatch.mockResolvedValue({
    planKey: "GROWTH",
    monthlyPrice: 149,
    annualPrice: 1490,
    updated: 12,
    synced: 12,
    failed: 0,
  });
});

async function editAndSave(price = "149") {
  render(<AdminPlansPage />);
  const input = await screen.findByLabelText("Growth monthly price (USD)");
  fireEvent.change(input, { target: { value: price } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

describe("R24 plan price confirm", () => {
  it("Save asks for the count first and opens a dialog naming the businesses and the monthly total; no PATCH yet", async () => {
    await editAndSave();
    const dialog = await screen.findByRole("dialog", {
      name: "Change Growth from $100 to $149 a month?",
    });
    expect(mockImpact).toHaveBeenCalledWith("GROWTH", 149);
    expect(
      within(dialog).getByText(
        "This changes the bill for 12 businesses on their next renewal. $100 more each month in total. 3 with their own price are not affected.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Change price for 12 businesses" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("Cancel closes the dialog and makes no PATCH", async () => {
    await editAndSave();
    const dialog = await screen.findByRole("dialog", {
      name: "Change Growth from $100 to $149 a month?",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("Confirm runs the PATCH exactly once, with the price and annual as typed", async () => {
    await editAndSave();
    const dialog = await screen.findByRole("dialog", {
      name: "Change Growth from $100 to $149 a month?",
    });
    const confirm = within(dialog).getByRole("button", { name: "Change price for 12 businesses" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
    // SA-1100 §2: the PATCH carries the count the admin confirmed
    expect(mockPatch).toHaveBeenCalledWith("GROWTH", {
      monthly: 149,
      annual: 1000,
      expectedAffected: 12,
    });
    expect(await screen.findByText(/Saved Growth/)).toBeInTheDocument();
  });

  // SA-1100 §2: the price edit is a RED second confirm that shows the old price beside the new one.
  describe("SA-1100 §2 danger confirm", () => {
    it("the title shows the current price beside the new one (the typo catcher)", async () => {
      mockImpact.mockResolvedValue(impact({ currentMonthly: 249, newMonthly: 2490 }));
      await editAndSave("2490");
      expect(
        await screen.findByRole("dialog", { name: "Change Growth from $249 to $2,490 a month?" }),
      ).toBeInTheDocument();
    });

    it("keeps cents when the old or new price has them", async () => {
      mockImpact.mockResolvedValue(impact({ currentMonthly: 99.5, newMonthly: 149.99 }));
      await editAndSave("149.99");
      expect(
        await screen.findByRole("dialog", {
          name: "Change Growth from $99.50 to $149.99 a month?",
        }),
      ).toBeInTheDocument();
    });

    it("the confirm button is the red danger button and focus opens on Cancel, not on the red button", async () => {
      await editAndSave();
      const dialog = await screen.findByRole("dialog");
      const confirm = within(dialog).getByRole("button", {
        name: "Change price for 12 businesses",
      });
      expect(confirm.className).toContain("bg-danger");
      await waitFor(() =>
        expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus(),
      );
    });

    it("a 409 (the count moved) fetches the count again and keeps the dialog open on the new number; nothing is saved", async () => {
      mockPatch.mockRejectedValueOnce({
        response: {
          status: 409,
          data: { code: "PLAN_PRICE_IMPACT_CHANGED", expectedAffected: 12, affected: 13 },
        },
      });
      mockImpact
        .mockResolvedValueOnce(impact())
        .mockResolvedValueOnce(impact({ affected: 13, monthlyDelta: 637 }));
      await editAndSave();
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Change price for 12 businesses" }),
      );

      const again = await screen.findByRole("button", { name: "Change price for 13 businesses" });
      expect(mockImpact).toHaveBeenCalledTimes(2);
      expect(mockImpact).toHaveBeenLastCalledWith("GROWTH", 149);
      expect(screen.getByRole("dialog")).toHaveTextContent(
        "The number of businesses changed since you looked.",
      );
      expect(screen.getByRole("dialog")).toHaveTextContent("13 businesses");
      expect(screen.queryByText(/Saved Growth/)).toBeNull();
      expect(mockPatch).toHaveBeenCalledTimes(1);

      // the admin has read the new number: the next Confirm carries it
      mockPatch.mockResolvedValueOnce({
        planKey: "GROWTH",
        monthlyPrice: 149,
        annualPrice: 1490,
        updated: 13,
        synced: 13,
        failed: 0,
      });
      fireEvent.click(again);
      await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(2));
      expect(mockPatch).toHaveBeenLastCalledWith("GROWTH", {
        monthly: 149,
        annual: 1000,
        expectedAffected: 13,
      });
    });

    it("a 409 whose re-check fails closes the dialog and offers Retry (never saves blind)", async () => {
      mockPatch.mockRejectedValueOnce({
        response: { status: 409, data: { code: "PLAN_PRICE_IMPACT_CHANGED", affected: 13 } },
      });
      mockImpact.mockResolvedValueOnce(impact()).mockRejectedValueOnce(new Error("down"));
      await editAndSave();
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Change price for 12 businesses" }),
      );
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Couldn't check how many businesses this changes.");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(mockPatch).toHaveBeenCalledTimes(1);
    });

    it("any other save failure still closes the dialog and shows the error", async () => {
      mockPatch.mockRejectedValueOnce({ response: { status: 500, data: { message: "boom" } } });
      await editAndSave();
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Change price for 12 businesses" }),
      );
      expect(await screen.findByText("boom")).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(mockImpact).toHaveBeenCalledTimes(1);
    });
  });

  it("while the count is being fetched the button says Checking and cannot be pressed twice", async () => {
    let resolve!: (v: unknown) => void;
    mockImpact.mockReturnValue(new Promise((r) => (resolve = r)));
    await editAndSave();
    const checking = await screen.findByRole("button", { name: /Checking/ });
    expect(checking).toBeDisabled();
    fireEvent.click(checking);
    expect(mockImpact).toHaveBeenCalledTimes(1);
    resolve(impact());
    await screen.findByRole("dialog", { name: "Change Growth from $100 to $149 a month?" });
  });

  it("a price drop says 'less'", async () => {
    mockImpact.mockResolvedValue(impact({ newMonthly: 90, monthlyDelta: -120 }));
    await editAndSave("90");
    const dialog = await screen.findByRole("dialog", {
      name: "Change Growth from $100 to $90 a month?",
    });
    expect(within(dialog).getByText(/\$120 less each month in total\./)).toBeInTheDocument();
    expect(within(dialog).queryByText(/more each month/)).toBeNull();
  });

  it("one business and no own-price businesses read naturally", async () => {
    mockImpact.mockResolvedValue(impact({ affected: 1, ownPrice: 0, monthlyDelta: 49 }));
    await editAndSave();
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "This changes the bill for 1 business on their next renewal. $49 more each month in total.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Change price for 1 business" }),
    ).toBeInTheDocument();
  });

  it("no business on the plan: says so, and the button is plain 'Change price'", async () => {
    mockImpact.mockResolvedValue(impact({ affected: 0, ownPrice: 0, monthlyDelta: 0 }));
    await editAndSave();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("No business pays this price yet.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Change price" })).toBeInTheDocument();
  });

  it("a failed check blocks the confirm: message + Retry, no dialog, no PATCH; Retry asks again", async () => {
    mockImpact.mockRejectedValueOnce({ response: { data: { message: "db constraint x_fk" } } });
    await editAndSave();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't check how many businesses this changes.");
    expect(alert).not.toHaveTextContent("x_fk");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockPatch).not.toHaveBeenCalled();

    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByRole("dialog", { name: "Change Growth from $100 to $149 a month?" });
    expect(mockImpact).toHaveBeenCalledTimes(2);
    expect(mockPatch).not.toHaveBeenCalled();
  });
});
