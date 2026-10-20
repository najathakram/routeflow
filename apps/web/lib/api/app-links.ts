import { useQuery } from "@tanstack/react-query";
import type { AppLinks } from "@routeflow/types";
import { apiClient } from "../api-client";

export { hasAnyAppLink } from "@routeflow/types";

export const APP_LINKS_QUERY_KEY = "app-links";

/**
 * The install links every signed-in role may read (GET /app-links). An older api without the route
 * errors here; callers treat an error like "no link ready", so the entry points hide (fail closed).
 */
export function useAppLinks() {
  return useQuery<AppLinks>({
    queryKey: [APP_LINKS_QUERY_KEY],
    queryFn: () => apiClient.get("/app-links").then((r) => r.data),
    staleTime: 60_000,
    retry: false,
  });
}
