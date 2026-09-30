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

let mockPathname = "/estimates";
let mockUser: { role: string } | undefined = { role: "OPERATOR" };
let mockSubscription: {
  data: unknown;
  isSuccess: boolean;
  isError: boolean;
} = { data: { flags: [] }, isSuccess: true, isError: false };

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ replace: jest.fn() }),
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
});
