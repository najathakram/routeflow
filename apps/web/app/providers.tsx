"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { AuthProvider } from "@/lib/auth-context";
import { BuyerAuthProvider } from "@/lib/buyer-auth-context";
import { ToastProvider, useToast } from "@routeflow/ui/web";
import { I18nProvider } from "@/lib/i18n";
import { ReAuthProvider } from "@/components/ReAuthProvider";

function QueryProviders({ children }: { children: React.ReactNode }) {
  const { toast } = useToast();
  const queryClient = React.useRef(
    new QueryClient({
      mutationCache: new MutationCache({
        onError: (error) => {
          const data = (error as any)?.response?.data;
          // These 409s are turned into guided in-app flows by the initiating
          // component (merge prompt, license guard) — don't also surface them as a
          // generic error toast.
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
          ];
          if (data?.code && HANDLED_CODES.includes(data.code)) return;
          const message = data?.message || (error as Error)?.message || "Something went wrong";
          toast({ title: message, variant: "error" });
        },
      }),
      defaultOptions: {
        queries: {
          retry: 1,
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
      <I18nProvider>
        <ReAuthProvider>
          <QueryProviders>{children}</QueryProviders>
        </ReAuthProvider>
      </I18nProvider>
    </ToastProvider>
  );
}
