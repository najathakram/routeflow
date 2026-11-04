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
    const dialog = await screen.findByRole("dialog", { name: "Change Growth to $149/mo?" });
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
    const dialog = await screen.findByRole("dialog", { name: "Change Growth to $149/mo?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("Confirm runs the PATCH exactly once, with the price and annual as typed", async () => {
    await editAndSave();
    const dialog = await screen.findByRole("dialog", { name: "Change Growth to $149/mo?" });
    const confirm = within(dialog).getByRole("button", { name: "Change price for 12 businesses" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
    expect(mockPatch).toHaveBeenCalledWith("GROWTH", { monthly: 149, annual: 1000 });
    expect(await screen.findByText(/Saved Growth/)).toBeInTheDocument();
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
    await screen.findByRole("dialog", { name: "Change Growth to $149/mo?" });
  });

  it("a price drop says 'less'", async () => {
    mockImpact.mockResolvedValue(impact({ newMonthly: 90, monthlyDelta: -120 }));
    await editAndSave("90");
    const dialog = await screen.findByRole("dialog", { name: "Change Growth to $90/mo?" });
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
    await screen.findByRole("dialog", { name: "Change Growth to $149/mo?" });
    expect(mockImpact).toHaveBeenCalledTimes(2);
    expect(mockPatch).not.toHaveBeenCalled();
  });
});
