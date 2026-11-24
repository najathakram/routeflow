import { useQuery } from "@tanstack/react-query";
import type { NavLayout } from "@routeflow/types";
import { apiClient } from "../api-client";

/**
 * SA-1209: the business's sidebar layout, read from the same `GET /settings` the rest of the app uses (one shared cache
 * entry, key ["settings"]). `retry: false`, so a failed read leaves `data` undefined and the sidebar stays the default.
 */
export function useNavLayout(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
    staleTime: 60_000,
    retry: false,
    enabled: opts.enabled ?? true,
    select: (s: { navLayout?: NavLayout } | undefined) => s?.navLayout,
  });
}
