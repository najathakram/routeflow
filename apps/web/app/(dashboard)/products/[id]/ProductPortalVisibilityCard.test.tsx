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

  it("operator sees a read-only status: no switch, no mutation", () => {
    role = "OPERATOR";
    render({ portalVisible: false });
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByTestId("portal-visibility-status")).toHaveTextContent(/hidden/i);
    expect(mutate).not.toHaveBeenCalled();
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
