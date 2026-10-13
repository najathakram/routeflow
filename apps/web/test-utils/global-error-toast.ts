import { MutationCache, QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { handleMutationError } from "@/lib/mutation-error-toast";

/**
 * A QueryClient whose MutationCache runs the REAL app-wide error handler (`handleMutationError`, the one
 * app/providers.tsx installs) into `toast`. Give it a spy of its OWN (not the one behind the page's `useToast`)
 * and a test can tell WHICH toast fired: this spy is the global one, the page's `useToast` spy is the local one.
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

/**
 * Row 348: a closed-day refusal is toasted ONCE and by the PAGE: the page-local spy took exactly one toast (the
 * `expected` fields), and the app-wide handler stayed quiet (the mutation's `meta.localErrorToast`).
 * Wait for the local toast first: the global handler runs before the mutation rejects, so it has already fired by then.
 */
export async function expectOnlyThePageToasted(
  local: jest.Mock,
  global: jest.Mock,
  expected: Record<string, unknown>,
): Promise<void> {
  await waitFor(() => expect(local).toHaveBeenCalledTimes(1));
  expect(local).toHaveBeenCalledWith(expect.objectContaining({ variant: "error", ...expected }));
  expect(global).not.toHaveBeenCalled();
}
