/**
 * Navigation-state walk backing the bottom nav's pop-to-root behaviour.
 *
 * Pressing a tab has always returned that tab to its root rather than restoring
 * the sub-screen you were last on ("when I go to home and press orders again,
 * still goes to where it was before"). That used to be a `tabPress` listener in
 * `(tabs)/_layout.tsx`, but `tabPress` is only emitted by the tab bar itself —
 * and the bar now lives outside the navigator. So the bar has to find the tab's
 * nested stack and pop it directly.
 *
 * Pure so it can be tested; mobile Jest is node-only with no renderer.
 */

interface NavNode {
  type?: string;
  index?: number;
  key?: string;
  routes?: ReadonlyArray<{ name?: string; state?: unknown }>;
}

function findTabRoute(node: unknown, tab: string): { state?: unknown } | null {
  const n = node as NavNode | null | undefined;
  if (!n?.routes) return null;
  if (n.type === "tab") {
    const hit = n.routes.find((r) => r.name === tab);
    if (hit) return hit;
  }
  for (const r of n.routes) {
    const deeper = findTabRoute(r.state, tab);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * Key of `tab`'s nested stack, but only when it is deeper than its root — so the
 * caller can dispatch a targeted `popToTop` at it. Returns null when the tab is
 * already at its root, is a leaf with no nested navigator, or has never been
 * visited (tab screens are lazy, so unvisited routes carry no `state`).
 */
export function findDeepTabStackKey(rootState: unknown, tab: string): string | null {
  const found = findTabRoute(rootState, tab);
  const inner = found?.state as NavNode | undefined;
  if (!inner?.key) return null;
  return (inner.index ?? 0) > 0 ? inner.key : null;
}
