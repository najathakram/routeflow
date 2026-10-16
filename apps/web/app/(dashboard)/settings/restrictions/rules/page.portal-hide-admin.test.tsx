import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import RestrictionRulesPage from "./page";

/**
 * L5: lifting a rule that hides products from every portal customer is account-admin only. An operator may still
 * lift state-scoped rules; the all-portal rule's tick box is disabled with the fixed line "Ask an account admin".
 */
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
  categoryId: null,
  productId: "p1",
  categoryName: null,
  productName: "Acme pod",
  jurisdiction: "STATE",
  states: ["TX"],
  surface: "BUYER_PORTAL",
  effectiveFrom: "2026-03-05T12:00:00Z",
  effectiveTo: null,
  reason: "Portal limit",
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
const all = rule({ id: "r2", productName: "Acme tin", jurisdiction: "FEDERAL", states: [] });

beforeEach(() => {
  jest.clearAllMocks();
  role = "OPERATOR";
  get.mockResolvedValue({ data: [rule(), all] });
});

const cardOf = async (name: string) =>
  (await screen.findAllByTestId("rule-card")).find((c) => within(c).queryByText(name))!;

describe("rules page: all-portal hide is admin-only to lift (L5)", () => {
  it("an operator can tick a state-scoped rule but not an all-portal one, which says 'Ask an account admin'", async () => {
    renderWithProviders(<RestrictionRulesPage />);
    const state = await cardOf("Acme pod");
    const fed = await cardOf("Acme tin");
    expect(within(state).getByRole("checkbox")).toBeEnabled();
    expect(within(state).queryByText("Ask an account admin")).toBeNull();
    expect(within(fed).getByRole("checkbox")).toBeDisabled();
    const line = within(fed).getByText("Ask an account admin");
    expect(line).toBeInTheDocument();
    // the disabled tick box names its reason for assistive tech
    const id = within(fed).getByRole("checkbox").getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    expect(line.id).toBe(id);
    expect(within(state).getByRole("checkbox")).not.toHaveAttribute("aria-describedby");
  });

  it("an admin can tick both", async () => {
    role = "TENANT_ADMIN";
    renderWithProviders(<RestrictionRulesPage />);
    const fed = await cardOf("Acme tin");
    expect(within(fed).getByRole("checkbox")).toBeEnabled();
    expect(within(fed).queryByText("Ask an account admin")).toBeNull();
  });
});
