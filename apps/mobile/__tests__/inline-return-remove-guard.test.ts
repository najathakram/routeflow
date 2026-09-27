// DRIVES real react-navigation (@react-navigation/core 7.x, the version we ship) through a
// minimal stack: while a capture is in flight the screen must survive `goBack()` (what Android's
// hardware back and every in-app back dispatch), and must register itself as remove-prevented in
// the prevent-remove context — the ONLY thing native-stack reads to set `preventNativeDismiss`
// (the iOS parent-stack swipe). A raw `beforeRemove` listener does the first but not the second
// (Opus #2111).
import * as React from "react";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer: any = require("react-test-renderer");
const { act } = TestRenderer;
import {
  BaseNavigationContainer,
  CommonActions,
  StackActions,
  StackRouter,
  createNavigationContainerRef,
  createNavigatorFactory,
  usePreventRemoveContext,
  useNavigationBuilder,
} from "@react-navigation/core";

// `@react-navigation/native` just re-exports core; importing it in node needs react-native.
jest.mock("@react-navigation/native", () => jest.requireActual("@react-navigation/core"));

import { useInlineReturnRemoveGuard } from "../lib/use-inline-return-remove-guard";
import {
  initialInlineReturnScreen,
  inlineReturnScreenReducer,
  type InlineReturnScreenState,
} from "../lib/inline-return-screen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let screenState: InlineReturnScreenState = initialInlineReturnScreen;
let preventedRoutes: Record<string, { preventRemove: boolean }> = {};
let parentPrevented: Record<string, { preventRemove: boolean }> = {};
let signedOut = false;
const redirect = jest.fn();
let setScreenState: (s: InlineReturnScreenState) => void = () => undefined;

function InlineScreen() {
  const [s, set] = React.useState<InlineReturnScreenState>(screenState);
  setScreenState = set;
  useInlineReturnRemoveGuard(s, { signedOut, onSignedOutRedirect: redirect });
  preventedRoutes = usePreventRemoveContext().preventedRoutes as typeof preventedRoutes;
  return null;
}
function Home() {
  return null;
}
function ReturnsIndex() {
  return null;
}

function TestNavigator(props: any) {
  const { state, descriptors, NavigationContent } = useNavigationBuilder(StackRouter, props);
  return React.createElement(
    NavigationContent,
    null,
    state.routes.map((r) =>
      React.createElement(React.Fragment, { key: r.key }, descriptors[r.key]!.render()),
    ),
  );
}
const Stack = createNavigatorFactory(TestNavigator)();

// The real app shape: the inline screen lives in the returns stack, which is itself a screen of a
// PARENT stack. `ReturnsStack` reads the PARENT navigator's prevent-remove context — what the
// parent's native-stack view turns into preventNativeDismiss for the iOS parent swipe.
function ReturnsStack() {
  parentPrevented = usePreventRemoveContext().preventedRoutes as typeof parentPrevented;
  return React.createElement(
    Stack.Navigator,
    null,
    React.createElement(Stack.Screen, { name: "ReturnsIndex", component: ReturnsIndex }),
    React.createElement(Stack.Screen, { name: "Inline", component: InlineScreen }),
  );
}

const ref = createNavigationContainerRef<any>();

function mount() {
  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(
        BaseNavigationContainer as any,
        { ref },
        React.createElement(
          Stack.Navigator,
          null,
          React.createElement(Stack.Screen, { name: "Home", component: Home }),
          React.createElement(Stack.Screen, { name: "ReturnsStack", component: ReturnsStack }),
        ),
      ),
    );
  });
  act(() => {
    ref.navigate("ReturnsStack");
  });
  act(() => {
    ref.navigate("Inline");
  });
  return renderer;
}

const rootRoutes = (): Array<{ name: string; key: string }> => (ref.getRootState() as any).routes;
const routeNames = () => rootRoutes().map((r) => r.name);
const returnsStackKey = () => rootRoutes().find((r) => r.name === "ReturnsStack")!.key;
const nestedNames = () =>
  ((rootRoutes().find((r) => r.name === "ReturnsStack") as any).state?.routes ?? []).map(
    (r: { name: string }) => r.name,
  );

const capturingState = () =>
  [{ type: "quoted", quote: {} as any, lines: [] }, { type: "captureStarted" }].reduce(
    inlineReturnScreenReducer as any,
    initialInlineReturnScreen,
  ) as InlineReturnScreenState;

describe("useInlineReturnRemoveGuard — driven through real (nested) navigation", () => {
  beforeEach(() => {
    screenState = initialInlineReturnScreen;
    signedOut = false;
    redirect.mockClear();
  });

  it("goBack (hardware back) inside the returns stack is BLOCKED mid-capture and works again once it settles", () => {
    const r = mount();
    expect(nestedNames()).toEqual(["ReturnsIndex", "Inline"]);
    act(() => setScreenState(capturingState()));
    act(() => {
      ref.dispatch(CommonActions.goBack());
    });
    expect(nestedNames()).toEqual(["ReturnsIndex", "Inline"]);
    act(() =>
      setScreenState(
        inlineReturnScreenReducer(capturingState(), {
          type: "captured",
          result: { id: "r1" } as any,
        }),
      ),
    );
    act(() => {
      ref.dispatch(CommonActions.goBack());
    });
    expect(nestedNames()).toEqual(["ReturnsIndex"]);
    act(() => r.unmount());
  });

  it("the PARENT navigator's prevent-remove context marks the returns-stack route (the iOS parent swipe), and clears when settled", () => {
    const r = mount();
    act(() => setScreenState(capturingState()));
    expect(parentPrevented[returnsStackKey()]?.preventRemove).toBe(true);
    act(() => setScreenState(initialInlineReturnScreen));
    expect(parentPrevented[returnsStackKey()]?.preventRemove).toBeFalsy();
    act(() => r.unmount());
  });

  const settle = () =>
    setScreenState(
      inlineReturnScreenReducer(capturingState(), {
        type: "captured",
        result: { id: "r1" } as any,
      }),
    );

  it("SIGNED OUT mid-capture: a root-targeted REPLACE (expo-router's session-expired redirect) is blocked, and the login redirect is RE-ISSUED once the capture settles", () => {
    const r = mount();
    signedOut = true;
    act(() => setScreenState(capturingState()));
    const rootKey = (ref.getRootState() as any).key;
    act(() => {
      ref.dispatch({ ...StackActions.replace("Home"), target: rootKey } as any);
    });
    expect(routeNames()).toEqual(["Home", "ReturnsStack"]); // blocked while in flight
    expect(redirect).not.toHaveBeenCalled();
    act(() => settle());
    expect(redirect).toHaveBeenCalledTimes(1); // re-issued from the container, not replayed through the screen
    act(() => r.unmount());
  });

  it("SIGNED IN: a tab tap (untargeted POP_TO '(tabs)') mid-capture is DROPPED, never replayed — the result screen stays and no redirect fires", () => {
    const r = mount();
    act(() => setScreenState(capturingState()));
    act(() => {
      ref.dispatch(StackActions.popTo("Home") as any);
    });
    expect(routeNames()).toEqual(["Home", "ReturnsStack"]);
    act(() => settle());
    expect(routeNames()).toEqual(["Home", "ReturnsStack"]); // result screen still there
    expect(nestedNames()).toEqual(["ReturnsIndex", "Inline"]);
    expect(redirect).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it("a blocked user back press is NOT replayed after the capture settles", () => {
    const r = mount();
    act(() => setScreenState(capturingState()));
    act(() => {
      ref.dispatch(CommonActions.goBack());
    });
    act(() => settle());
    expect(nestedNames()).toEqual(["ReturnsIndex", "Inline"]); // the result stays visible
    expect(redirect).not.toHaveBeenCalled();
    act(() => r.unmount());
  });
});
