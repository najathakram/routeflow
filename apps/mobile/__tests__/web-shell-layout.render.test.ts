/**
 * W-830 review nit 4 (#3727): a render-level test of app/_layout.tsx. The root layout is mounted
 * with its stores and router stubbed, and the decisions it makes are read off the router: with the
 * shell on a buyer goes to the shell BEFORE rootBuyerGate can send them to the old native
 * (customer) home, the native buyer session is cleared locally, an operator is routed by the role
 * the shell was opened with, and a store build with no web URL shows "update required" instead of
 * the old native screens.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
import * as React from "react";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer: any = require("react-test-renderer");
const { act } = TestRenderer;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── mutable test state (mock-prefixed so the hoisted factories may read it)
const mockOrder: string[] = [];
const mockReplace = jest.fn();
const mockClearForShell = jest.fn(async () => undefined);
const mockRoute = { segments: [] as string[], params: {} as Record<string, string> };
const mockShell = { on: true, mode: "on" };
const mockAuth: { current: Record<string, unknown> } = { current: {} };
const mockBuyerState: { current: Record<string, unknown> } = { current: {} };

jest.mock("react-native", () => require("./support/rn-render-stubs").reactNativeStub());
jest.mock("@routeflow/ui/tokens", () => require("./support/rn-render-stubs").uiKitStub());
jest.mock("@routeflow/types", () => ({
  UserRole: { CUSTOMER: "CUSTOMER", DRIVER: "DRIVER", OPERATOR: "OPERATOR" },
}));
jest.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: (p: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, p.children),
}));
jest.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: (p: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, p.children),
}));
jest.mock("@tanstack/react-query", () => ({
  QueryClientProvider: (p: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, p.children),
}));
jest.mock("@expo-google-fonts/inter", () => ({ useFonts: () => [true, null] }));
jest.mock("@expo-google-fonts/spline-sans", () => ({}));
jest.mock("@expo-google-fonts/spline-sans-mono", () => ({}));
jest.mock("@expo-google-fonts/instrument-serif", () => ({}));
jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: jest.fn(),
  hideAsync: jest.fn(),
}));
jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  addNotificationReceivedListener: () => ({ remove: jest.fn() }),
}));
jest.mock("expo-router", () => ({
  Slot: () => React.createElement("Slot"),
  useRouter: () => ({ replace: mockReplace }),
  useSegments: () => mockRoute.segments,
  useGlobalSearchParams: () => mockRoute.params,
}));
jest.mock("../lib/auth-store", () => ({ useAuthStore: () => mockAuth.current }));
jest.mock("../lib/tenant-store", () => ({
  useTenantStore: () => ({ slug: "acme", isLoading: false, initialize: jest.fn() }),
}));
jest.mock("../lib/buyer-session-store", () => ({
  useBuyerSessionStore: () => mockBuyerState.current,
}));
jest.mock("../lib/api/addons", () => ({
  useDeveloperMode: () => ({ enabled: true, isLoading: false, resolved: true }),
}));
jest.mock("../components/ConfirmModal", () => ({ ConfirmModal: () => null }));
jest.mock("../lib/sentry", () => ({ initSentry: jest.fn() }));
jest.mock("../lib/dev-parity-login", () => ({ maybeDevParityLogin: jest.fn() }));
jest.mock("../lib/query-client", () => ({ queryClient: {} }));
jest.mock("../lib/theme", () => ({
  AppThemeProvider: (p: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, p.children),
}));
jest.mock("../lib/web-shell/shell-env", () => ({
  get SHELL_ON() {
    return mockShell.on;
  },
  get SHELL_MODE() {
    return mockShell.mode;
  },
}));
// Record the order the two gates are consulted in (the real functions still decide).
jest.mock("../lib/web-shell/shell-routing", () => {
  const actual = jest.requireActual("../lib/web-shell/shell-routing");
  return {
    ...actual,
    shellGate: jest.fn((...a: unknown[]) => {
      mockOrder.push("shellGate");
      return (actual.shellGate as (...x: unknown[]) => unknown)(...a);
    }),
  };
});
jest.mock("../lib/buyer-route-guard", () => {
  const actual = jest.requireActual("../lib/buyer-route-guard");
  return {
    ...actual,
    rootBuyerGate: jest.fn((...a: unknown[]) => {
      mockOrder.push("rootBuyerGate");
      return (actual.rootBuyerGate as (...x: unknown[]) => unknown)(...a);
    }),
  };
});

import RootLayout from "../app/_layout";
import { textOf } from "./support/rn-render-stubs";

const staff = (activeRole: string) => ({
  user: { role: activeRole === "driver" ? "DRIVER" : "OPERATOR", forcePasswordChange: false },
  isLoading: false,
  activeRole,
  setActiveRole: jest.fn(),
  initialize: jest.fn(),
});
const signedOut = {
  user: null,
  isLoading: false,
  activeRole: null,
  setActiveRole: jest.fn(),
  initialize: jest.fn(),
};
const buyerState = (over: Record<string, unknown> = {}) => ({
  buyer: null,
  activeSeller: null,
  hasStoredSession: false,
  isLoading: false,
  initialize: jest.fn(async () => undefined),
  clearForShell: mockClearForShell,
  ...over,
});

function mount(opts: {
  auth?: Record<string, unknown>;
  buyer?: Record<string, unknown>;
  segments?: string[];
  params?: Record<string, string>;
  shell?: { on: boolean; mode: string };
}) {
  mockOrder.length = 0;
  mockReplace.mockClear();
  mockClearForShell.mockClear();
  mockAuth.current = opts.auth ?? signedOut;
  mockBuyerState.current = buyerState(opts.buyer);
  mockRoute.segments = opts.segments ?? [];
  mockRoute.params = opts.params ?? {};
  mockShell.on = opts.shell?.on ?? true;
  mockShell.mode = opts.shell?.mode ?? "on";
  let root: any;
  act(() => {
    root = TestRenderer.create(React.createElement(RootLayout));
  });
  return root;
}

const replacedWith = () => mockReplace.mock.calls.map((c) => c[0]);
const seller = { linkId: "l1" };
const BUYER_SHELL = "/(shell)/web?role=buyer";
const OPERATOR_SHELL = "/(shell)/web?role=operator";

describe("app/_layout.tsx with the shell on (render)", () => {
  it("a buyer with a native session goes to the shell BEFORE rootBuyerGate can pick the native home", () => {
    mount({
      buyer: { buyer: { id: "b1" }, activeSeller: seller },
      segments: ["(auth)", "sign-in"],
    });
    expect(replacedWith()).toEqual([BUYER_SHELL]);
    expect(mockOrder).toEqual(["shellGate"]); // rootBuyerGate never ran for this buyer
  });

  it("shellGate is consulted before rootBuyerGate when the shell does not handle the user", () => {
    mount({ segments: ["(auth)", "login"] }); // signed out on the staff login: not a shell decision
    expect(mockOrder.slice(0, 2)).toEqual(["shellGate", "rootBuyerGate"]);
  });

  it("clears the native buyer session locally, once the buyer is sent to the shell", () => {
    mount({ buyer: { buyer: { id: "b1" }, activeSeller: seller }, segments: [] });
    expect(mockClearForShell).toHaveBeenCalledTimes(1);
  });

  it("clears a stored refresh token even when the access token has expired (no buyer decoded)", () => {
    mount({ buyer: { buyer: null, hasStoredSession: true }, segments: [] });
    expect(replacedWith()).toEqual([BUYER_SHELL]);
    expect(mockClearForShell).toHaveBeenCalledTimes(1);
  });

  it("clears a stale native buyer session under a staff user and carries on to the operator shell", () => {
    mount({
      auth: staff("operator"),
      buyer: { buyer: { id: "b1" }, hasStoredSession: true },
      segments: ["(operator)", "home"],
    });
    expect(mockClearForShell).toHaveBeenCalledTimes(1);
    expect(replacedWith()).toEqual([OPERATOR_SHELL]);
  });

  it("a signed-out user on a (customer) route goes to the buyer shell", () => {
    mount({ segments: ["(customer)", "home"] });
    expect(replacedWith()).toEqual([BUYER_SHELL]);
  });

  it("an operator who deep-links to customer-login lands in the operator shell", () => {
    mount({ auth: staff("operator"), segments: ["(auth)", "customer-login"] });
    expect(replacedWith()).toEqual([OPERATOR_SHELL]);
  });

  it("an operator in a shell opened as buyer is moved to the operator shell (not stuck)", () => {
    mount({ auth: staff("operator"), segments: ["(shell)", "web"], params: { role: "buyer" } });
    expect(replacedWith()).toEqual([OPERATOR_SHELL]);
  });

  it("an operator in a shell opened as operator stays put", () => {
    mount({ auth: staff("operator"), segments: ["(shell)", "web"], params: { role: "operator" } });
    expect(replacedWith()).toEqual([]);
  });

  it("a driver is moved off customer-login back to the driver app (the shell is not a driver surface)", () => {
    mount({ auth: staff("driver"), segments: ["(auth)", "customer-login"] });
    expect(replacedWith()).toEqual(["/(driver)/route"]);
  });
});

describe("app/_layout.tsx with the shell off keeps the native flow (render)", () => {
  it("does not clear the buyer session and routes the buyer to the native home", () => {
    mount({
      shell: { on: false, mode: "off" },
      buyer: { buyer: { id: "b1" }, activeSeller: seller, hasStoredSession: true },
      segments: ["(auth)", "sign-in"],
    });
    expect(mockClearForShell).not.toHaveBeenCalled();
    expect(replacedWith()[0]).toMatch(/^\/\(customer\)/);
  });
});

describe("app/_layout.tsx runtime fail-closed (render)", () => {
  const unavailable = { on: false, mode: "unavailable" };

  it.each([[["(customer)", "home"]], [["(operator)", "home"]], [["(auth)", "customer-login"]]])(
    "a store build with no web URL shows 'update required' on %j, not the native screen",
    (segments) => {
      const root = mount({ shell: unavailable, segments });
      const text = textOf(root.root.findAll(() => true).map((n: any) => n.children));
      expect(text).toContain("Update RouteFlow");
      expect(root.root.findAllByType("Slot")).toHaveLength(0);
    },
  );

  it("drivers and the plain sign-in screens still render", () => {
    expect(
      mount({ shell: unavailable, segments: ["(driver)", "route"] }).root.findAllByType("Slot"),
    ).toHaveLength(1);
    expect(
      mount({ shell: unavailable, segments: ["(auth)", "login"] }).root.findAllByType("Slot"),
    ).toHaveLength(1);
  });

  it("with the shell on or deliberately off the native/web screens render as before", () => {
    expect(
      mount({
        segments: ["(shell)", "web"],
        auth: staff("operator"),
        params: { role: "operator" },
      }).root.findAllByType("Slot"),
    ).toHaveLength(1);
    expect(
      mount({
        shell: { on: false, mode: "off" },
        segments: ["(auth)", "sign-in"],
      }).root.findAllByType("Slot"),
    ).toHaveLength(1);
  });
});
