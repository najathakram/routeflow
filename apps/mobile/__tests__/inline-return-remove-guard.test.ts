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
let setScreenState: (s: InlineReturnScreenState) => void = () => undefined;

function InlineScreen() {
  const [s, set] = React.useState<InlineReturnScreenState>(screenState);
  setScreenState = set;
  useInlineReturnRemoveGuard(s);
  preventedRoutes = usePreventRemoveContext().preventedRoutes as typeof preventedRoutes;
  return null;
}
function Home() {
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
          React.createElement(Stack.Screen, { name: "Inline", component: InlineScreen }),
        ),
      ),
    );
  });
  act(() => {
    ref.navigate("Inline");
  });
  return renderer;
}

const rootRoutes = (): Array<{ name: string; key: string }> => (ref.getRootState() as any).routes;
const routeNames = () => rootRoutes().map((r) => r.name);
const inlineKey = () => rootRoutes().find((r) => r.name === "Inline")!.key;

describe("useInlineReturnRemoveGuard — driven through real navigation", () => {
  beforeEach(() => {
    screenState = initialInlineReturnScreen;
  });

  it("hardware back / goBack is BLOCKED while a capture is in flight, and works again once it settles", () => {
    const r = mount();
    expect(routeNames()).toEqual(["Home", "Inline"]);

    const capturing = [
      { type: "quoted", quote: {} as any, lines: [] },
      { type: "captureStarted" },
    ].reduce(
      inlineReturnScreenReducer as any,
      initialInlineReturnScreen,
    ) as InlineReturnScreenState;
    act(() => setScreenState(capturing));

    act(() => {
      ref.dispatch(CommonActions.goBack());
    });
    expect(routeNames()).toEqual(["Home", "Inline"]); // the screen survived the back press

    act(() =>
      setScreenState(
        inlineReturnScreenReducer(capturing, { type: "captured", result: { id: "r1" } as any }),
      ),
    );
    act(() => {
      ref.dispatch(CommonActions.goBack());
    });
    expect(routeNames()).toEqual(["Home"]);
    act(() => r.unmount());
  });

  it("registers as remove-prevented in the prevent-remove context (what native-stack turns into preventNativeDismiss for the iOS parent swipe)", () => {
    const r = mount();
    const capturing = [
      { type: "quoted", quote: {} as any, lines: [] },
      { type: "captureStarted" },
    ].reduce(
      inlineReturnScreenReducer as any,
      initialInlineReturnScreen,
    ) as InlineReturnScreenState;
    act(() => setScreenState(capturing));
    expect(preventedRoutes[inlineKey()]?.preventRemove).toBe(true);
    act(() => setScreenState(initialInlineReturnScreen));
    expect(preventedRoutes[inlineKey()]?.preventRemove).toBeFalsy();
    act(() => r.unmount());
  });
});
