import { QueryClient } from "@tanstack/react-query";

/**
 * The single QueryClient instance shared by the root layout's
 * `QueryClientProvider` (app/_layout.tsx) and `lib/session-teardown.ts`
 * (B140/D1, cause-ruling.md §3). Sign-out cancels in-flight queries then
 * clears the cache on THIS instance — a client the layout allocated for
 * itself would leave a stale, unclearable cache behind after logout.
 */
export const queryClient = new QueryClient();
