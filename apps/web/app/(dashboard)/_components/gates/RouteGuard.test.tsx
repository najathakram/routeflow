import * as React from "react";
import { render, screen } from "@testing-library/react";
import { RouteGuard } from "./RouteGuard";

/**
 * B449 fix-round finding 5: a wiring test for the layer the bug actually lived in.
 * `RouteGuard` itself never renders `LockedPage` — it delegates the lock/spinner/real-page
 * decision entirely to `PlanGateBoundary` (mocked here to a prop-recording stub) and must:
 *   1. pass `children` straight through, never wrapped in anything of its own;
 *   2. map `useSubscription()`'s `isSuccess`/`isError` onto `subscriptionResolved`/
 *      `subscriptionErrored` without inverting or dropping either;
 *   3. resolve `planGateKey` from the current pathname for a staff role, and pass `null`
 *      for a role plan-flag gating doesn't apply to.
 */

const mockReplace = jest.fn();
let mockPathname = "/estimates";
let mockUser: { role: string } | undefined = { role: "OPERATOR" };
let mockSubscription: {
  data: unknown;
  isSuccess: boolean;
  isError: boolean;
} = { data: { flags: [] }, isSuccess: true, isError: false };

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: mockUser }),
}));

jest.mock("@/lib/api/billing", () => ({
  useSubscription: () => mockSubscription,
}));

jest.mock("@/lib/api/addons", () => ({
  useRoutesAccess: () => ({ enabled: false, resolved: true }),
  useDeliveryAccess: () => ({ enabled: false, resolved: true }),
}));

const boundaryProps: unknown[] = [];
jest.mock("./PlanGateBoundary", () => ({
  PlanGateBoundary: (props: Record<string, unknown>) => {
    boundaryProps.push(props);
    return <div data-testid="boundary-stub">{props.children as React.ReactNode}</div>;
  },
}));

beforeEach(() => {
  mockReplace.mockClear();
  boundaryProps.length = 0;
  mockPathname = "/estimates";
  mockUser = { role: "OPERATOR" };
  mockSubscription = { data: { flags: [] }, isSuccess: true, isError: false };
});

describe("RouteGuard (B449 fix-round finding 5)", () => {
  it("passes children straight through to PlanGateBoundary — never wraps them itself", () => {
    render(
      <RouteGuard>
        <div data-testid="real-page">real page</div>
      </RouteGuard>,
    );

    expect(screen.getByTestId("real-page")).toBeInTheDocument();
    expect(screen.getByTestId("boundary-stub")).toContainElement(screen.getByTestId("real-page"));
  });

  it("maps useSubscription().isSuccess/isError onto subscriptionResolved/subscriptionErrored", () => {
    mockSubscription = { data: { flags: [] }, isSuccess: false, isError: true };
    render(
      <RouteGuard>
        <div />
      </RouteGuard>,
    );

    expect(boundaryProps).toHaveLength(1);
    expect(boundaryProps[0]).toMatchObject({
      subscriptionResolved: false,
      subscriptionErrored: true,
    });
  });

  it("resolves planGateKey from the pathname for a staff role", () => {
    mockPathname = "/estimates";
    render(
      <RouteGuard>
        <div />
      </RouteGuard>,
    );

    expect(boundaryProps[0]).toMatchObject({
      planGateKey: "flag.estimates",
      pathname: "/estimates",
    });
  });

  it("never plan-gates a CUSTOMER — planGateKey is always null regardless of pathname", () => {
    mockUser = { role: "CUSTOMER" };
    mockPathname = "/estimates";
    render(
      <RouteGuard>
        <div />
      </RouteGuard>,
    );

    expect(boundaryProps[0]).toMatchObject({ planGateKey: null });
  });

  it("passes null planGateKey for an ungated route", () => {
    mockPathname = "/orders";
    render(
      <RouteGuard>
        <div />
      </RouteGuard>,
    );

    expect(boundaryProps[0]).toMatchObject({ planGateKey: null });
  });

  // B966: the driver "Scan to add order" / "New order at door" links point here and are hidden for a
  // DRIVER; a typed URL is still bounced client-side (the API keeps DRIVER POST /orders for mobile).
  it("bounces a DRIVER off /orders to /dashboard", () => {
    mockUser = { role: "DRIVER" };
    mockPathname = "/orders";
    render(
      <RouteGuard>
        <div />
      </RouteGuard>,
    );
    expect(mockReplace).toHaveBeenCalledWith("/dashboard");
  });

  it.each(["DRIVER", "CUSTOMER"])("bounces a %s off /purchase-orders to /dashboard", (role) => {
    mockUser = { role };
    mockPathname = "/purchase-orders";
    render(
      <RouteGuard>
        <div />
      </RouteGuard>,
    );
    expect(mockReplace).toHaveBeenCalledWith("/dashboard");
  });

  it.each(["DRIVER", "CUSTOMER"])("bounces a %s off a PO detail page to /dashboard", (role) => {
    mockUser = { role };
    mockPathname = "/purchase-orders/po-1";
    render(
      <RouteGuard>
        <div />
      </RouteGuard>,
    );
    expect(mockReplace).toHaveBeenCalledWith("/dashboard");
  });

  it("lets an OPERATOR stay on /purchase-orders", () => {
    mockPathname = "/purchase-orders";
    render(
      <RouteGuard>
        <div />
      </RouteGuard>,
    );
    expect(mockReplace).not.toHaveBeenCalled();
  });

  // REG-B1013: "/settings" is the CUSTOMER/DRIVER account page only; the business sub-pages under it
  // (billing, restrictions, imports, migration, product categories) are staff-only.
  it.each(["DRIVER", "CUSTOMER"])(
    "lets a %s stay on /settings itself (their own account)",
    (role) => {
      mockUser = { role };
      mockPathname = "/settings";
      render(
        <RouteGuard>
          <div />
        </RouteGuard>,
      );
      expect(mockReplace).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["DRIVER", "/settings/billing"],
    ["CUSTOMER", "/settings/billing"],
    ["DRIVER", "/settings/restrictions"],
    ["CUSTOMER", "/settings/import"],
    ["CUSTOMER", "/settings/product-categories"],
  ])("bounces a %s off %s to /dashboard", (role, path) => {
    mockUser = { role };
    mockPathname = path;
    render(
      <RouteGuard>
        <div />
      </RouteGuard>,
    );
    expect(mockReplace).toHaveBeenCalledWith("/dashboard");
  });

  it("lets an OPERATOR stay on /settings/billing", () => {
    mockPathname = "/settings/billing";
    render(
      <RouteGuard>
        <div />
      </RouteGuard>,
    );
    expect(mockReplace).not.toHaveBeenCalled();
  });

  // Row 559: the install page is for every dashboard role, matched exactly like /settings.
  it("a CUSTOMER and a DRIVER may open /get-the-app", () => {
    for (const role of ["CUSTOMER", "DRIVER"]) {
      mockReplace.mockClear();
      mockUser = { role };
      mockPathname = "/get-the-app";
      const { unmount } = render(
        <RouteGuard>
          <div />
        </RouteGuard>,
      );
      expect(mockReplace).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("does not open the rest of a /get-the-app prefix to a CUSTOMER", () => {
    mockUser = { role: "CUSTOMER" };
    mockPathname = "/get-the-app/other";
    render(
      <RouteGuard>
        <div />
      </RouteGuard>,
    );
    expect(mockReplace).toHaveBeenCalledWith("/dashboard");
  });
});
