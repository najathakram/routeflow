"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { AuthProvider } from "@/lib/auth-context";
import { ToastProvider, useToast } from "@routeflow/ui/web";

function QueryProviders({ children }: { children: React.ReactNode }) {
  const { toast } = useToast();
  const queryClient = React.useRef(
    new QueryClient({
      mutationCache: new MutationCache({
        onError: (error) => {
          const message =
            (error as any)?.response?.data?.message ||
            (error as Error)?.message ||
            "Something went wrong";
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
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <QueryProviders>{children}</QueryProviders>
    </ToastProvider>
  );
}
