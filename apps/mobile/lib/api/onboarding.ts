import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OnboardingSignOffRequest, TenantOnboardingResponse } from "@routeflow/types";
import { apiClient } from "../api-client";

// ─── Tenant side: "Getting started" (#2159 S4) — same endpoints as the web ─────────

const KEY = ["onboarding", "me"] as const;

export function useTenantOnboarding(enabled = true) {
  return useQuery<TenantOnboardingResponse>({
    queryKey: KEY,
    queryFn: () => apiClient.get("/onboarding/me").then((r) => r.data),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function useOnboardingSignOff() {
  const qc = useQueryClient();
  return useMutation<TenantOnboardingResponse, unknown, OnboardingSignOffRequest>({
    mutationFn: (body) => apiClient.post("/onboarding/me/sign-off", body).then((r) => r.data),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
}
