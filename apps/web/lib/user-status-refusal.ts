import { API_ERROR_CODES } from "@routeflow/types";

/**
 * SA #3412: PATCH /users/:id/status answers 409 with a `code` when a deactivation would leave the workspace
 * without an admin. Each refusal maps to a fixed sentence that says what to do; the server message is never
 * shown. Any other failure returns null, so the caller keeps its generic toast.
 */
export const USER_STATUS_REFUSAL_COPY = {
  [API_ERROR_CODES.LAST_TENANT_ADMIN]:
    "This is the only active admin. Make someone else an admin first.",
  [API_ERROR_CODES.SELF_DEACTIVATION_REFUSED]:
    "You can't deactivate your own account. Ask another admin.",
} as const;

export function userStatusRefusalCopy(error: unknown): string | null {
  const res = (error as { response?: { status?: number; data?: { code?: unknown } } })?.response;
  if (res?.status !== 409 || typeof res.data?.code !== "string") return null;
  return (USER_STATUS_REFUSAL_COPY as Record<string, string>)[res.data.code] ?? null;
}
