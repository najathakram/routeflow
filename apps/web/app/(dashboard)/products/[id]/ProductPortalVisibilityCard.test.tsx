import * as React from "react";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { ProductPortalVisibilityCard } from "./ProductPortalVisibilityCard";

const mutate = jest.fn();
const hookFactory = jest.fn((_id: string) => ({ mutate, isPending: false }));
let role = "TENANT_ADMIN";

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
let flag = { enabled: true, resolved: true, failed: false };
jest.mock("@/lib/api/plan-flags", () => ({ usePlanFlag: () => flag }));
jest.mock("@/lib/api/product-portal-visibility", () => ({
  useSetProductPortalVisibility: (id: string) => hookFactory(id),
  useBulkSetPortalVisibility: () => ({ mutate: jest.fn(), isPending: false }),
}));

const render = (props: Record<string, unknown> = {}) =>
  renderWithProviders(
    <ProductPortalVisibilityCard
      product={{ id: "v1", portalVisible: true, parent: null, ...props }}
    />,
  );

beforeEach(() => {
  jest.clearAllMocks();
  role = "TENANT_ADMIN";
  flag = { enabled: true, resolved: true, failed: false };
});

describe("ProductPortalVisibilityCard", () => {
  it("admin toggles the switch and the mutation gets the new value", () => {
    render();
    const sw = screen.getByRole("switch", { name: "Show in buyer portal" });
    expect(sw).toBeChecked();
    expect(screen.getByText(/hidden parent hides all its variants/i)).toBeInTheDocument();
    fireEvent.click(sw);
    expect(hookFactory).toHaveBeenCalledWith("v1");
    expect(mutate).toHaveBeenCalledWith({ portalVisible: false });
  });

  it("operator (owner ruling 2026-10-14): the switch is shown DISABLED with the visible admin-only hint, plus the status", () => {
    role = "OPERATOR";
    render({ portalVisible: false });
    const sw = screen.getByRole("switch");
    expect(sw).toBeDisabled();
    const hint = document.getElementById(sw.getAttribute("aria-describedby") as string);
    expect(hint).toHaveTextContent(
      "Only an account admin can hide a product from every portal customer.",
    );
    expect(hint).toBeVisible();
    expect(screen.getByTestId("portal-visibility-status")).toHaveTextContent(/hidden/i);
    fireEvent.click(sw);
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each(["TENANT_ADMIN", "SUPER_ADMIN"])("%s gets the live switch and no hint", (r) => {
    role = r;
    render();
    const sw = screen.getByRole("switch");
    expect(sw).toBeEnabled();
    expect(sw).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText(/Only an account admin/)).toBeNull();
  });

  it.each(["DRIVER", "CUSTOMER"])("%s sees the status only: no switch, no hint", (r) => {
    role = r;
    render();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText(/Only an account admin/)).toBeNull();
    expect(screen.getByTestId("portal-visibility-status")).toBeInTheDocument();
  });

  it("a variant whose parent is hidden shows 'Hidden by parent'; the switch still edits its own flag", () => {
    render({ parent: { portalVisible: false } });
    expect(screen.getByText("Hidden by parent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch"));
    expect(mutate).toHaveBeenCalledWith({ portalVisible: false });
  });

  it("off state shows the owner's caption: staff can still add it to orders", () => {
    render({ portalVisible: false });
    expect(screen.getByTestId("portal-visibility-caption")).toHaveTextContent(
      "Hidden from your online shop. Your team can still add it to orders.",
    );
  });

  it("an operator's view of a variant under a hidden parent says 'Hidden by parent', never 'Visible'", () => {
    role = "OPERATOR";
    render({ parent: { portalVisible: false } });
    expect(screen.getByTestId("portal-visibility-status")).toHaveTextContent("Hidden by parent");
    expect(screen.queryByText(/visible in buyer portal/i)).not.toBeInTheDocument();
  });

  it("renders nothing for a tenant without the buyer-portal add-on; fails open while the flag is unknown", () => {
    flag = { enabled: false, resolved: true, failed: false };
    render();
    // The card itself is absent. (The test wrapper's ToastProvider renders its own empty notification
    // region, so "the whole container is empty" is not a property of the card.)
    expect(screen.queryByTestId("portal-visibility-card")).toBeNull();
    flag = { enabled: true, resolved: false, failed: false };
    render();
    expect(screen.getByTestId("portal-visibility-card")).toBeInTheDocument();
  });
});
