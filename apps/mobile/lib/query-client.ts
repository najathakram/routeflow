import { QueryClient, focusManager } from "@tanstack/react-query";
import { AppState, type AppStateStatus, Platform } from "react-native";

/**
 * TanStack's own `focusManager` only listens for the DOM `visibilitychange`
 * event (see `@tanstack/query-core`'s `FocusManager#setup` — it checks for
 * `window.addEventListener`, which React Native never fires), so on native a
 * query that went stale while the app sat backgrounded just keeps serving
 * that stale cache forever: nothing ever tells TanStack "the app is back,
 * check your queries". Wiring `AppState` in is the documented React Native
 * recipe for this gap. Exported (not just registered) so the mapping itself
 * is pinned as pure logic, independent of whether AppState.addEventListener
 * ever actually fires in a test.
 */
export function onAppStateChange(status: AppStateStatus): void {
  if (Platform.OS !== "web") {
    focusManager.setFocused(status === "active");
  }
}

// Guarded: some existing "react-native" test doubles (e.g.
// session-teardown.test.ts's `jest.mock("react-native", () => ({ Platform:
// { OS: "ios" } }))`, which predates this file caring about AppState) stub
// only `Platform`. Wiring a foreground listener must never throw for a module
// graph that doesn't care about it.
if (typeof AppState?.addEventListener === "function") {
  AppState.addEventListener("change", onAppStateChange);
}

/**
 * The single QueryClient instance shared by the root layout's
 * `QueryClientProvider` (app/_layout.tsx) and `lib/session-teardown.ts`
 * (B140/D1, cause-ruling.md §3). Sign-out cancels in-flight queries then
 * clears the cache on THIS instance — a client the layout allocated for
 * itself would leave a stale, unclearable cache behind after logout.
 */
export const queryClient = new QueryClient();
