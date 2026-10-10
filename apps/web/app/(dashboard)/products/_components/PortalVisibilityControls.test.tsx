import * as React from "react";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import {
  PortalBulkButtons,
  PortalHiddenBadge,
  PortalHiddenFilter,
} from "./PortalVisibilityControls";

const mutate = jest.fn();
let role = "TENANT_ADMIN";

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/lib/api/product-portal-visibility", () => ({
  useBulkSetPortalVisibility: () => ({ mutate, isPending: false }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  role = "TENANT_ADMIN";
});

describe("PortalVisibilityControls", () => {
  it("badge: Hidden for own flag, Hidden by parent for a variant, none when visible", () => {
    const { rerender } = renderWithProviders(
      <PortalHiddenBadge product={{ portalVisible: false }} />,
    );
    expect(screen.getByText("Hidden from portal")).toBeInTheDocument();
    rerender(
      <PortalHiddenBadge product={{ portalVisible: true, parent: { portalVisible: false } }} />,
    );
    expect(screen.getByText("Hidden by parent")).toBeInTheDocument();
    rerender(<PortalHiddenBadge product={{ portalVisible: true, parent: null }} />);
    expect(screen.queryByTestId("portal-hidden-badge")).not.toBeInTheDocument();
  });

  it("bulk over the server cap of 200: buttons disabled with a plain message, never a raw 400", () => {
    const many = new Set(Array.from({ length: 201 }, (_, i) => `id${i}`));
    renderWithProviders(<PortalBulkButtons selected={many} onDone={jest.fn()} />);
    expect(screen.getByTestId("portal-bulk-limit")).toHaveTextContent(/up to 200/i);
    expect(screen.getByTestId("portal-bulk-hide")).toBeDisabled();
    expect(screen.getByTestId("portal-bulk-show")).toBeDisabled();
    fireEvent.click(screen.getByTestId("portal-bulk-hide"));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("filter reports its checked state", () => {
    const onChange = jest.fn();
    renderWithProviders(<PortalHiddenFilter checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Hidden from portal"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("admin bulk Hide sends the selected ids and clears via onDone", () => {
    const onDone = jest.fn();
    renderWithProviders(<PortalBulkButtons selected={new Set(["a", "b"])} onDone={onDone} />);
    fireEvent.click(screen.getByTestId("portal-bulk-hide"));
    expect(mutate).toHaveBeenCalledWith(
      { ids: ["a", "b"], portalVisible: false },
      expect.any(Object),
    );
    mutate.mock.calls[0][1].onSuccess({ updated: 2, unchanged: 0 });
    expect(onDone).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("portal-bulk-show"));
    expect(mutate).toHaveBeenLastCalledWith(
      { ids: ["a", "b"], portalVisible: true },
      expect.any(Object),
    );
  });

  it("operator sees no bulk buttons", () => {
    role = "OPERATOR";
    renderWithProviders(<PortalBulkButtons selected={new Set(["a"])} onDone={jest.fn()} />);
    expect(screen.queryByTestId("portal-bulk-hide")).not.toBeInTheDocument();
    expect(screen.queryByTestId("portal-bulk-show")).not.toBeInTheDocument();
  });
});
