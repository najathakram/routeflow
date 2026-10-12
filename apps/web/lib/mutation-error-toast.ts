import type { ToastData } from "@routeflow/ui/web";
import { API_ERROR_CODES } from "@routeflow/types";
import { genericToastCopy } from "./generic-toast-copy";
import { safeTextBodyCopy } from "./safe-text-error-copy";
import { markReadOnlyRefused } from "./read-only-gate";
import type { SubscriptionView } from "@routeflow/types";
import { readOnlyCopyForView } from "./read-only-copy";
import { ownsBillingBanner } from "./subscription-banner-state";

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
  /** SA-733r6: the cached subscription read + a way to refresh it, for the read-only line (providers.tsx wires it). */
  readOnlyState?: {
    view: () => import("@routeflow/types").SubscriptionView | undefined;
    refresh: () => void;
    /** SA-776: a TENANT_ADMIN is shown the action, anyone else the contact line. Unknown = admin (the old shape). */
    isAdmin?: () => boolean;
  },
): void {
  const data = (error as any)?.response?.data;
  // (ORDER_EDIT_WOULD_OVERPAY is deliberately NOT here: its notice renders only in edit mode, so the order page
  // opts the edit save out via `localErrorToast`; the same 409 anywhere else gets the generic toast.)
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
    // B1135: a change request on an order with the carrier; the buyer's request form says it inline.
    API_ERROR_CODES.ORDER_WITH_CARRIER_NO_CHANGE_REQUEST,
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
    // SA-733r6 (B4): the control was enabled from a stale read - re-read now so every write control on screen
    // switches to its disabled-with-the-line state, and say the fixed line (never "Choose a plan" while a
    // payment is owed; the server answers a plan change with 409 PAYMENT_OVERDUE).
    const view = readOnlyState?.view();
    const isAdmin = readOnlyState?.isAdmin?.() ?? true;
    readOnlyState?.refresh();
    markReadOnlyRefused();
    // SA-776: the owner's sentence + the mapped reason (+ the contact line for a non-admin), composed from the
    // subscription view in ONE helper - never from the 403's text. The reason in the 403 body is the fallback when
    // no subscription read is cached yet.
    const copy = readOnlyCopyForView(
      view ?? ({ readOnlyReason: data?.reason ?? null } as SubscriptionView),
      isAdmin,
    );
    if (ownsBillingBanner(view)) {
      // never "Choose a plan" while a payment is owed (the server answers a plan change with 409 PAYMENT_OVERDUE)
      toast({ title: copy.text, variant: "warning" });
      return;
    }
    toast({
      title: copy.sentence,
      description: [copy.reasonLine, copy.contactLine].filter(Boolean).join(" ") || undefined,
      variant: "warning",
      ...(isAdmin
        ? { action: { label: "Choose a plan", onClick: () => router.push("/choose-plan") } }
        : {}),
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
