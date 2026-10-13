import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import RestrictionRulesPage from "./page";

const get = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...a: unknown[]) => get(...a) },
}));
let role = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));

const rule = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  tenantId: "t1",
  categoryId: "c1",
  productId: null,
  categoryName: "Hemp",
  productName: null,
  jurisdiction: "STATE",
  states: ["TX", "FL"],
  surface: "ALL",
  effectiveFrom: "2026-03-05T12:00:00Z",
  effectiveTo: null,
  reason: "State ban on hemp edibles",
  createdById: "u1",
  createdByName: "Pat Admin",
  createdAt: "2026-03-04T12:00:00Z",
  liftedById: null,
  liftedByName: null,
  liftedAt: null,
  liftReason: null,
  status: "ACTIVE",
  ...over,
});
const ok = (rows: unknown[]) => get.mockResolvedValueOnce({ data: rows });

beforeEach(() => {
  jest.clearAllMocks();
  role = "OPERATOR";
});

describe("RestrictionRulesPage", () => {
  it("lists a rule: target, status, state chips, channel, window, reason — no raw ids", async () => {
    ok([rule()]);
    renderWithProviders(<RestrictionRulesPage />);
    const card = await screen.findByTestId("rule-card");
    expect(within(card).getByText("Hemp")).toBeInTheDocument();
    expect(within(card).getByText("Category")).toBeInTheDocument();
    expect(within(card).getByText("Active")).toBeInTheDocument();
    const chips = within(card).getByRole("list", { name: "Banned states" });
    expect(
      within(chips)
        .getAllByRole("listitem")
        .map((l) => l.textContent),
    ).toEqual(["TX", "FL"]);
    expect(within(card).getByText("All sales")).toBeInTheDocument();
    expect(within(card).getByText(/no end date/)).toBeInTheDocument();
    expect(within(card).getByText("State ban on hemp edibles")).toBeInTheDocument();
    expect(within(card).getByText(/by Pat Admin/)).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/\bc1\b|\br1\b|\bt1\b/);
  });

  it("a lifted rule shows who lifted it and why", async () => {
    ok([
      rule({
        status: "LIFTED",
        liftedAt: "2026-04-01T12:00:00Z",
        liftedByName: "Sam Admin",
        liftReason: "Law repealed",
      }),
    ]);
    renderWithProviders(<RestrictionRulesPage />);
    const card = await screen.findByTestId("rule-card");
    expect(within(card).getByText("Lifted", { selector: "span" })).toBeInTheDocument();
    expect(within(card).getByText(/Lifted .* by Sam Admin/)).toBeInTheDocument();
    expect(within(card).getByText("Law repealed")).toBeInTheDocument();
  });

  it("a federal rule reads as federal and has no state chips", async () => {
    ok([rule({ jurisdiction: "FEDERAL", states: [], surface: "BUYER_PORTAL" })]);
    renderWithProviders(<RestrictionRulesPage />);
    const card = await screen.findByTestId("rule-card");
    expect(within(card).getByText(/federal/)).toBeInTheDocument();
    expect(within(card).queryByRole("list", { name: "Banned states" })).toBeNull();
    expect(within(card).getByText(/Buyer portal only/)).toBeInTheDocument();
  });

  it("the status filter re-queries with ?status, and 'All' sends none", async () => {
    ok([rule()]);
    renderWithProviders(<RestrictionRulesPage />);
    await screen.findByTestId("rule-card");
    expect(get).toHaveBeenLastCalledWith("/selling-restrictions", { params: undefined });
    ok([]);
    fireEvent.click(screen.getByRole("button", { name: "Lifted" }));
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith("/selling-restrictions", {
        params: { status: "LIFTED" },
      }),
    );
    expect(await screen.findByText("No lifted rules")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lifted" })).toHaveAttribute("aria-pressed", "true");
  });

  it("empty (unfiltered) invites the first rule; a failed load offers a retry", async () => {
    ok([]);
    const { unmount } = renderWithProviders(<RestrictionRulesPage />);
    expect(await screen.findByText("No selling restrictions yet")).toBeInTheDocument();
    unmount();

    get.mockRejectedValueOnce({ response: { status: 500 } });
    renderWithProviders(<RestrictionRulesPage />);
    expect(await screen.findByText("Couldn't load the rules.")).toBeInTheDocument();
    ok([rule()]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("rule-card")).toBeInTheDocument();
  });

  it("a 403 says so plainly (no retry button)", async () => {
    get.mockRejectedValueOnce({ response: { status: 403 } });
    renderWithProviders(<RestrictionRulesPage />);
    expect(await screen.findByText(/don't have access/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("is honest when the API's 500-row cap is reached (it returns no total)", async () => {
    ok(Array.from({ length: 500 }, (_, i) => rule({ id: `r${i}` })));
    renderWithProviders(<RestrictionRulesPage />);
    expect(await screen.findByText(/Showing the newest 500 rules/)).toBeInTheDocument();
  }, 120_000); // renders 500 cards: ~10 s alone, past the 30 s default on a loaded machine

  it("does not claim truncation just under the cap", async () => {
    ok(Array.from({ length: 499 }, (_, i) => rule({ id: `r${i}` })));
    renderWithProviders(<RestrictionRulesPage />);
    await screen.findAllByTestId("rule-card");
    expect(screen.queryByText(/Showing the newest/)).toBeNull();
  }, 120_000);

  it("a tenant admin gets a New rule button that opens the dialog; an operator does not", async () => {
    ok([]);
    const { unmount } = renderWithProviders(<RestrictionRulesPage />);
    await screen.findByText("No selling restrictions yet");
    expect(screen.queryByRole("button", { name: "New rule" })).toBeNull();
    unmount();

    role = "TENANT_ADMIN";
    get.mockResolvedValue({ data: [] });
    renderWithProviders(<RestrictionRulesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "New rule" }));
    expect(
      await screen.findByRole("dialog", { name: "New selling restriction" }),
    ).toBeInTheDocument();
  });

  it("lift is offered on active and scheduled rules only, and only to a tenant admin", async () => {
    role = "TENANT_ADMIN";
    ok([
      rule({ id: "a", status: "ACTIVE" }),
      rule({ id: "b", status: "SCHEDULED" }),
      rule({ id: "c", status: "EXPIRED" }),
      rule({ id: "d", status: "LIFTED", liftedAt: "2026-03-06T12:00:00Z" }),
    ]);
    renderWithProviders(<RestrictionRulesPage />);
    await screen.findAllByTestId("rule-card");
    expect(screen.getAllByRole("button", { name: "Lift rule" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Lift rule" })[0]);
    expect(await screen.findByRole("dialog", { name: "Lift this rule?" })).toBeInTheDocument();
  });
});

describe("Portal limits & rules: multi-select Lift N", () => {
  it("is titled Portal limits & rules", async () => {
    ok([rule()]);
    renderWithProviders(<RestrictionRulesPage />);
    expect(await screen.findByText("Portal limits & rules")).toBeInTheDocument();
  });

  it("ticking rows shows Lift N; only rules that can still be lifted are tickable", async () => {
    role = "TENANT_ADMIN";
    ok([
      rule({ id: "a", categoryName: "Vapes" }),
      rule({ id: "b", categoryName: "Kratom" }),
      rule({ id: "c", categoryName: "Old", status: "LIFTED", liftedAt: "2026-03-10T00:00:00Z" }),
    ]);
    renderWithProviders(<RestrictionRulesPage />);
    await screen.findAllByTestId("rule-card");
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.click(screen.getByRole("checkbox", { name: /limit on vapes/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /limit on kratom/i }));
    expect(screen.getByRole("button", { name: "Lift 2" })).toBeInTheDocument();
  });
});
