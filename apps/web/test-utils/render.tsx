import * as React from "react";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@routeflow/ui/web";
import { I18nProvider } from "@/lib/i18n";
import { AuthProvider } from "@/lib/auth-context";
import { BuyerAuthProvider } from "@/lib/buyer-auth-context";

/**
 * A fresh QueryClient per test — retries off (so a mocked-rejected query fails
 * fast instead of eating the test's timeout) and no caching between renders.
 * `AuthProvider`/`BuyerAuthProvider` are the REAL context providers: on mount
 * they call `getStoredUser()`/`getStoredBuyer()` (empty jsdom localStorage ->
 * null) then `refreshTokens()`/`buyerRefreshTokens()`, which both short-circuit
 * to `null` with NO network call when there's no stored refresh token — so
 * they're safe to mount with zero mocking as long as a test doesn't seed
 * localStorage with a token. `TenantProvider` and `ReAuthProvider` are
 * deliberately NOT included: `useTenant()`'s context has a non-null default
 * (branding: null) so components render fine without the real provider, and
 * `useI18n()`'s server-preference sync effect no-ops without a stored access
 * token — see apps/web/lib/i18n/index.tsx:41-63.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

export interface RenderWithProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  queryClient?: QueryClient;
}

export interface RenderWithProvidersResult extends RenderResult {
  queryClient: QueryClient;
}

export function renderWithProviders(
  ui: React.ReactElement,
  { queryClient = createTestQueryClient(), ...options }: RenderWithProvidersOptions = {},
): RenderWithProvidersResult {
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <I18nProvider>
            <BuyerAuthProvider>
              <AuthProvider>{children}</AuthProvider>
            </BuyerAuthProvider>
          </I18nProvider>
        </ToastProvider>
      </QueryClientProvider>
    );
  }

  return { queryClient, ...render(ui, { wrapper: Wrapper, ...options }) };
}

export * from "@testing-library/react";
