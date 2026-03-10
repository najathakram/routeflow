"use client";

import * as React from "react";
import { AuthProvider } from "@/lib/auth-context";
import { ToastProvider } from "@routeflow/ui/web";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ToastProvider>{children}</ToastProvider>
    </AuthProvider>
  );
}
