import * as React from "react";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import RestrictionsSettingsPage from "./page";

const mutate = jest.fn();
let role = "TENANT_ADMIN";
let settings: any;

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/restrictions-settings", () => ({
  ...jest.requireActual("@/lib/api/restrictions-settings"),
  useRestrictionsSettings: () => ({ data: settings }),
  useUpdateRestrictionsSettings: () => ({ mutate, isPending: false }),
}));
jest.mock("./_components/CustomersWithoutState", () => ({
  CustomersWithoutState: ({ canFix }: { canFix: boolean }) => (
    <div data-testid="customers-without-state-card">{canFix ? "can-fix" : "view-only"}</div>
  ),
}));

const render = () => renderWithProviders(<RestrictionsSettingsPage />);

beforeEach(() => {
  jest.clearAllMocks();
  role = "TENANT_ADMIN";
  settings = { governingAddress: "BILLING_FIRST" };
});

describe("Selling restrictions settings page (row 510: staff sales are always checked)", () => {
  it("has no switch any more: the owner removed 'Also block restricted products on staff orders and invoices'", () => {
    render();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText(/also block restricted products/i)).toBeNull();
    expect(screen.queryByText(/turn this on for legal bans/i)).toBeNull();
  });

  it("says in one line that staff are warned and can sell with a reason", () => {
    render();
    expect(
      screen.getByText(
        "Staff sales are always checked. Staff can sell a restricted product with a reason.",
      ),
    ).toBeInTheDocument();
  });

  it("every other control is still there: the address choice saves, the rules link, the customers card", () => {
    render();
    fireEvent.click(screen.getByLabelText(/shipping address first/i));
    expect(mutate).toHaveBeenLastCalledWith(
      { governingAddress: "SHIPPING_FIRST" },
      expect.any(Object),
    );
    expect(screen.getByLabelText(/billing address first/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /all settings/i })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.getByRole("link", { name: /portal limits & rules/i })).toHaveAttribute(
      "href",
      "/settings/restrictions/rules",
    );
    expect(screen.getByTestId("customers-without-state-card")).toHaveTextContent("can-fix");
  });

  it("never sends `enabled` (the API no longer has it)", () => {
    render();
    fireEvent.click(screen.getByLabelText(/shipping address first/i));
    expect(JSON.stringify(mutate.mock.calls)).not.toMatch(/enabled/);
  });

  it("an operator cannot change the settings but can fix customer data (owner ruling 10-07)", () => {
    role = "OPERATOR";
    render();
    expect(screen.getByText(/only a workspace admin/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/billing address first/i)).toBeDisabled();
    expect(screen.getByTestId("customers-without-state-card")).toHaveTextContent("can-fix");
  });
});
