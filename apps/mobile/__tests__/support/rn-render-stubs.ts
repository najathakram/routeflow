/**
 * Render-test stubs for the W-830 screen/layout tests. The mobile Jest lane runs in plain Node
 * (no react-native), so a render test swaps react-native and the UI kit for host elements that
 * react-test-renderer can walk. Use inside `jest.mock(name, () => require("./support/rn-render-stubs").x())`.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

function hostFor(name: string) {
  const React = require("react");
  const Comp = (props: any) => React.createElement(name, props, props.children);
  Comp.displayName = name;
  return Comp;
}

/** Any capitalised export is a host element of that name; everything else is undefined. */
function hostProxy(base: Record<string, unknown>) {
  const cache: Record<string, unknown> = {};
  return new Proxy(base, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === "__esModule" || typeof prop !== "string") return undefined;
      if (/^[A-Z]/.test(prop)) return (cache[prop] ??= hostFor(prop));
      return undefined;
    },
    has(target, prop: string) {
      return prop in target || (typeof prop === "string" && /^[A-Z]/.test(prop));
    },
  });
}

export function reactNativeStub() {
  return hostProxy({
    Platform: { OS: "ios", select: (o: any) => o.ios ?? o.default },
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1 },
    Linking: { openURL: jest.fn() },
    Dimensions: { get: () => ({ width: 390, height: 844 }) },
  });
}

export function uiKitStub() {
  const gray = ["#111", "#222", "#333", "#444", "#555", "#666"];
  return hostProxy({
    ios: new Proxy(
      { bg: "#fff", bgElev: "#fff", brand: "#06f", label: "#000", label2: "#444", gray },
      {
        get(t: any, p: string) {
          if (p in t) return t[p];
          // any other token (nested colour groups, gradients) is a harmless string/array
          return new Proxy([] as any, { get: (a: any, k: any) => (k in a ? a[k] : "#000") });
        },
      },
    ),
  });
}

export function hostComponents() {
  return hostProxy({});
}

/** Every text string under a node, joined. */
export function textOf(node: any): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.children);
}

/** The first element of `type` ("Pressable") whose subtree text contains `text`. */
export function findByText(root: any, type: string, text: string): any {
  const hits = root.findAll(
    (n: any) =>
      n.type === type && typeof n.props.onPress === "function" && textOf(n.children).includes(text),
  );
  if (hits.length === 0) throw new Error(`no ${type} with text "${text}"`);
  return hits[hits.length - 1];
}
