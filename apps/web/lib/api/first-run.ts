import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FirstRunAnswer, FirstRunResult, FirstRunStatus } from "@routeflow/types";
import { apiClient } from "../api-client";

export type { FirstRunAnswer, FirstRunResult, FirstRunStatus };

/**
 * W1: the first question on a new account's dashboard (`GET`/`POST /settings/fulfilment/first-run`, TENANT_ADMIN).
 * `state: null` means the account has no marker (not a new sign-up), so there is no card. A failed read is an
 * error here and the card renders nothing: the dashboard never waits on, or breaks over, this question.
 */
export const FIRST_RUN_QUERY_KEY = ["first-run"] as const;

export function useFirstRun(enabled: boolean) {
  return useQuery<FirstRunStatus>({
    queryKey: FIRST_RUN_QUERY_KEY,
    queryFn: () => apiClient.get("/settings/fulfilment/first-run").then((r) => r.data),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useAnswerFirstRun() {
  const qc = useQueryClient();
  return useMutation<FirstRunResult, Error, FirstRunAnswer>({
    mutationFn: (answer) =>
      apiClient.post("/settings/fulfilment/first-run", answer).then((r) => r.data),
    onSuccess: () => {
      // The ticks changed the add-ons: the menu (Dispatch, Counter sale) and the capability answers live under ["tenant"].
      void qc.invalidateQueries({ queryKey: FIRST_RUN_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["tenant"] });
    },
    onError: (err) => {
      // A 409 FIRST_RUN_CLOSED means another tab or a team member got there first: re-read, so the card goes away.
      if (firstRunErrorCode(err) === "FIRST_RUN_CLOSED") {
        void qc.invalidateQueries({ queryKey: FIRST_RUN_QUERY_KEY });
      }
    },
  });
}

export function firstRunErrorCode(error: unknown): string | undefined {
  const code = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof code === "string" ? code : undefined;
}
