"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { AuthProvider } from "@/lib/auth-context";
import { getStoredUser } from "@/lib/auth";
import { BuyerAuthProvider } from "@/lib/buyer-auth-context";
import { ToastProvider, useToast } from "@routeflow/ui/web";
import { I18nProvider } from "@/lib/i18n";
import { ReAuthProvider } from "@/components/ReAuthProvider";
import { PlanGateNotice } from "@/components/PlanGateNotice";
import type { SubscriptionView } from "@routeflow/types";
import { handleMutationError } from "@/lib/mutation-error-toast";

function QueryProviders({ children }: { children: React.ReactNode }) {
  const { toast } = useToast();
  const router = useRouter();
  const queryClient: QueryClient = React.useRef(
    new QueryClient({
      mutationCache: new MutationCache({
        onError: (error, _variables, _context, mutation) =>
          handleMutationError(error, mutation, toast, router, {
            // SA-733r6: the read-only line names the admin from the cached subscription read.
            view: () => queryClient.getQueryData<SubscriptionView>(["billing", "subscription"]),
            refresh: () =>
              void queryClient.invalidateQueries({ queryKey: ["billing", "subscription"] }),
            // SA-776: the admin sees the action in the read-only toast, anyone else the contact line.
            isAdmin: () => getStoredUser()?.role === "TENANT_ADMIN",
          }),
      }),
      defaultOptions: {
        queries: {
          // A 403 is a decision, not a transient failure: retrying it only
          // doubles the wasted requests (and, for PLAN_GATE bodies, the
          // notices the bridge fires). Everything else keeps the one retry.
          retry: (failureCount, error) =>
            (error as any)?.response?.status !== 403 && failureCount < 1,
          staleTime: 30_000,
          refetchOnWindowFocus: false,
        },
      },
    }),
  ).current;

  return (
    <QueryClientProvider client={queryClient}>
      <BuyerAuthProvider>
        <AuthProvider>{children}</AuthProvider>
      </BuyerAuthProvider>
    </QueryClientProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      {/* Renders nothing; turns PLAN_GATE 403s on gated GETs into a toast (lib/api-client.ts). */}
      <PlanGateNotice />
      <I18nProvider>
        <ReAuthProvider>
          <QueryProviders>{children}</QueryProviders>
        </ReAuthProvider>
      </I18nProvider>
    </ToastProvider>
  );
}
