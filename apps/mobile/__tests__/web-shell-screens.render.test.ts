/**
 * W-830 review nit 4 (#3727): render tests of the two native buyer screens that redirect to the
 * shell and the three entry buttons that were rewired. With the shell on, the (customer) layout and
 * customer-login render a redirect to the buyer shell (no native screen mounts, no buyer socket
 * opens); each "buyer" button pushes the shell route. With the shell off they behave as before.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
import * as React from "react";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer: any = require("react-test-renderer");
const { act } = TestRenderer;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockShell = { on: true };
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockBuyerSocket = jest.fn();

jest.mock("react-native", () => require("./support/rn-render-stubs").reactNativeStub());
jest.mock("@routeflow/ui/tokens", () => require("./support/rn-render-stubs").uiKitStub());
jest.mock("react-native-safe-area-context", () =>
  require("./support/rn-render-stubs").hostComponents(),
);
jest.mock("expo-linear-gradient", () => require("./support/rn-render-stubs").hostComponents());
jest.mock("@expo/vector-icons", () => require("./support/rn-render-stubs").hostComponents());
jest.mock("expo-router", () => ({
  Redirect: (p: Record<string, unknown>) => React.createElement("Redirect", p),
  Stack: (p: Record<string, unknown>) => React.createElement("Stack", p),
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSegments: () => ["(customer)", "home"],
  useLocalSearchParams: () => ({}),
}));
jest.mock("../lib/web-shell/shell-env", () => ({
  get SHELL_ON() {
    return mockShell.on;
  },
}));
jest.mock("../hooks/useBuyerSocket", () => ({ useBuyerSocket: () => mockBuyerSocket() }));
jest.mock("../lib/buyer-session-store", () => ({
  useBuyerSessionStore: () => ({
    buyer: null,
    activeSeller: null,
    isLoading: false,
    setBuyer: jest.fn(),
    setActiveSeller: jest.fn(),
  }),
}));
jest.mock("../lib/buyer-auth", () => ({
  buyerLogin: jest.fn(),
  buyerLoginWithGoogle: jest.fn(),
  getBuyerSellers: jest.fn(),
}));
jest.mock("../components/OptionPickerSheet", () => ({ OptionPickerSheet: () => null }));
jest.mock("../lib/tenant-store", () => ({
  useTenantStore: (sel: (s: unknown) => unknown) => sel({ setSlug: jest.fn() }),
}));

import CustomerLayout from "../app/(customer)/_layout";
import CustomerLoginScreen from "../app/(auth)/customer-login";
import SignIn from "../app/(auth)/sign-in";
import CompanyCode from "../app/(auth)/company-code";
import Landing from "../app/index";
import { findByText } from "./support/rn-render-stubs";

const BUYER_SHELL = "/(shell)/web?role=buyer";

function mount(Screen: React.ComponentType, shellOn: boolean) {
  mockShell.on = shellOn;
  mockPush.mockClear();
  mockReplace.mockClear();
  mockBuyerSocket.mockClear();
  let root: any;
  act(() => {
    root = TestRenderer.create(React.createElement(Screen));
  });
  return root;
}

describe("(customer)/_layout with the shell on", () => {
  it("renders a redirect to the buyer shell and mounts no native screen or buyer socket", () => {
    const root = mount(CustomerLayout, true);
    const redirects = root.root.findAllByType("Redirect");
    expect(redirects).toHaveLength(1);
    expect(redirects[0].props.href).toBe(BUYER_SHELL);
    expect(root.root.findAllByType("Stack")).toHaveLength(0);
    expect(mockBuyerSocket).not.toHaveBeenCalled();
  });

  it("with the shell off it is the native layout, as before", () => {
    const root = mount(CustomerLayout, false);
    expect(root.root.findAllByType("Redirect")).toHaveLength(0);
    expect(root.root.findAllByType("Stack")).toHaveLength(1);
    expect(mockBuyerSocket).toHaveBeenCalled();
  });
});

describe("(auth)/customer-login with the shell on", () => {
  it("redirects to the buyer shell and shows no native sign-in form", () => {
    const root = mount(CustomerLoginScreen, true);
    const redirects = root.root.findAllByType("Redirect");
    expect(redirects).toHaveLength(1);
    expect(redirects[0].props.href).toBe(BUYER_SHELL);
    expect(root.root.findAllByType("TextInput")).toHaveLength(0);
  });

  it("with the shell off it is the native sign-in form, as before", () => {
    const root = mount(CustomerLoginScreen, false);
    expect(root.root.findAllByType("Redirect")).toHaveLength(0);
    expect(root.root.findAllByType("TextInput").length).toBeGreaterThan(0);
  });
});

describe("the three buyer buttons (W-830 entry points)", () => {
  const cases: Array<[string, React.ComponentType, string]> = [
    ["landing: I'm a Buyer", Landing, "I'm a Buyer"],
    ["sign-in: Customer Portal card", SignIn, "Customer Portal"],
    ["company-code: Customer Portal link", CompanyCode, "Customer Portal"],
  ];

  it.each(cases)("%s opens the buyer shell when the shell is on", (_n, Screen, label) => {
    const root = mount(Screen, true);
    act(() => findByText(root.root, "Pressable", label).props.onPress());
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(BUYER_SHELL);
  });

  it.each(cases)("%s opens native customer-login when the shell is off", (_n, Screen, label) => {
    const root = mount(Screen, false);
    act(() => findByText(root.root, "Pressable", label).props.onPress());
    expect(mockPush).toHaveBeenCalledWith("/(auth)/customer-login");
  });
});
