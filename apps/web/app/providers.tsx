"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { AuthProvider } from "@/lib/auth-context";
import { BuyerAuthProvider } from "@/lib/buyer-auth-context";
import { ToastProvider, useToast } from "@routeflow/ui/web";
import { I18nProvider } from "@/lib/i18n";
import { ReAuthProvider } from "@/components/ReAuthProvider";
import { PlanGateNotice } from "@/components/PlanGateNotice";

function QueryProviders({ children }: { children: React.ReactNode }) {
  const { toast } = useToast();
  const router = useRouter();
  const queryClient = React.useRef(
    new QueryClient({
      mutationCache: new MutationCache({
        onError: (error) => {
          const data = (error as any)?.response?.data;
          // These 409s (and READ_ONLY's 403) are turned into guided in-app flows by the
          // initiating component (merge prompt, license guard, the read-only toast below)
          // — don't also surface them as a generic error toast.
          const HANDLED_CODES = [
            "MERGE_CHOICE_REQUIRED",
            "REGULATED_AUTH_REQUIRED",
            // P5-10/11: change-request 409s are turned into guided flows by the
            // initiating components (friendly buyer banners; operator toast +
            // refetch on the first-resolution-wins race). Their bodies carry no
            // user-facing `message`, so the generic toast would show a raw axios
            // error. CR-specific codes — nothing else throws them.
            "CHANGE_REQUEST_ALREADY_RESOLVED",
            "STOP_ALREADY_COMPLETED",
            "LINE_ALREADY_DELIVERED",
            "CHANGE_WINDOW_CLOSED",
            "EDIT_WINDOW_OPEN",
            // RO-1: a blocked write against a READ_ONLY tenant — handled explicitly
            // below with its own toast + CTA, never the bare guard message.
            "READ_ONLY",
          ];
          // RO-1: TenantStatusGuard's 403 on a blocked write — replace the raw guard
          // message with a title the tenant understands plus a way out, instead of
          // just swallowing the toast like the other HANDLED_CODES above.
          if (data?.code === "READ_ONLY") {
            const message = data?.message || "This action is unavailable while read-only.";
            toast({
              title: "Your workspace is read-only",
              description: message,
              variant: "warning",
              action: { label: "Choose a plan", onClick: () => router.push("/choose-plan") },
            });
            return;
          }
          if (data?.code && HANDLED_CODES.includes(data.code)) return;
          const message = data?.message || (error as Error)?.message || "Something went wrong";
          toast({ title: message, variant: "error" });
        },
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
