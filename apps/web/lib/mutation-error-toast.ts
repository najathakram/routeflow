import type { ToastData } from "@routeflow/ui/web";
import { API_ERROR_CODES } from "@routeflow/types";
import { genericToastCopy } from "./generic-toast-copy";
import { safeTextBodyCopy } from "./safe-text-error-copy";

/**
 * The app-wide MutationCache error handler (extracted from `app/providers.tsx`, #1965 so it is
 * testable). A mutation that renders its own error UI opts out with
 * `meta: { localErrorToast: true }` — otherwise a failed save shows this generic toast (FIXED copy by
 * code/status, B980) on top of the page's own sentence.
 */
type ToastFn = (opts: Omit<ToastData, "id">) => unknown;

export function handleMutationError(
  error: unknown,
  mutation: { meta?: Record<string, unknown> } | undefined,
  toast: ToastFn,
  router: { push: (href: string) => void },
): void {
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
    // Selling restrictions settings: the page turns these into guided in-app messages
    // (a fix list / a two-step instruction) and toasts them itself, once.
    "SELLING_RESTRICTIONS_NOT_READY",
    "SELLING_RESTRICTIONS_ENABLE_AND_POLICY_TOGETHER",
    // Selling restrictions: the order UIs show a blocked-lines dialog (the lines and why),
    // so the generic toast would only say "Request failed with status code 409".
    "SELLING_RESTRICTED",
    // Credit limit: the order detail opens a guard dialog (the server's limit / exposure and a
    // "collect a payment" exit); CreateOrderModal keeps its inline banner. No override exists.
    "CREDIT_LIMIT_EXCEEDED",
    // RO-1: a blocked write against a READ_ONLY tenant — handled explicitly
    // below with its own toast + CTA, never the bare guard message.
    API_ERROR_CODES.READ_ONLY,
  ];
  // RO-1: TenantStatusGuard's 403 on a blocked write — replace the raw guard
  // message with a title the tenant understands plus a way out, instead of
  // just swallowing the toast like the other HANDLED_CODES above.
  if (data?.code === API_ERROR_CODES.READ_ONLY) {
    toast({
      title: "Your workspace is read-only",
      description: "Choose a plan to make changes.",
      variant: "warning",
      action: { label: "Choose a plan", onClick: () => router.push("/choose-plan") },
    });
    return;
  }
  // The mutation renders its own (fixed-sentence) error UI. Checked AFTER the read-only branch so a
  // read-only tenant still gets "Choose a plan" from any mutation.
  // `localErrorToast` is `true` (the mutation owns every error) or a predicate (it owns only the errors it matches).
  const local = mutation?.meta?.localErrorToast;
  if (typeof local === "function" ? local(error) : local) return;
  if (data?.code && HANDLED_CODES.includes(data.code)) return;
  // B956: a refused formula-led name is fixed copy with a human field label, never the raw message.
  const refusedName = safeTextBodyCopy(data);
  if (refusedName) {
    toast({ title: refusedName, variant: "error" });
    return;
  }
  // B980: fixed copy by code/status, never the server message (lib/generic-toast-copy.ts).
  toast({ title: genericToastCopy(error), variant: "error" });
}
