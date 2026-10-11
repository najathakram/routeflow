import { MutationCache, QueryClient } from "@tanstack/react-query";
import { handleMutationError } from "@/lib/mutation-error-toast";

/**
 * A QueryClient whose MutationCache runs the REAL app-wide error handler (`handleMutationError`, the one
 * app/providers.tsx installs) into `toast`. Point the page's own `useToast` at the same `toast` and the
 * spy counts EVERY toast a failed mutation raises: the global one and the page's local one.
 */
export function queryClientWithGlobalErrorToast(toast: (opts: never) => unknown): QueryClient {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) =>
        handleMutationError(error, mutation, toast as never, { push: jest.fn() }),
    }),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** An axios-shaped refusal as the API client rejects it. */
export function refusal(status: number, data: Record<string, unknown>): Error {
  return Object.assign(new Error("Request failed"), { response: { status, data } });
}
