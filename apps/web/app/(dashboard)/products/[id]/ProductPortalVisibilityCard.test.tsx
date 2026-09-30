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
});
