// Platform-admin card payment link for a business that is invoiced by hand (SA-1206 R2). Plain async functions over
// `superAdminClient`, like platform-pricing.ts. The server decides eligibility and every amount: these only carry
// its JSON, and the checkout link is returned to the caller and never logged here.
import { API_ERROR_CODES } from "@routeflow/types";
import { superAdminClient } from "@/lib/admin-api";

/** One line the one-time charge is made of (the API's planner output, whole cents). */
export interface CatchupStubLine {
  code: string;
  kind: string;
  cents: number;
}

/** `plan` of `GET /platform-admin/tenants/:id/billing/catchup-plan` (`catchupReportJson`): a plan, or the refusal reason. */
export type CatchupPlanView =
  | {
      ok: true;
      shape: "trial" | "trial_one_time";
      paidThrough: string;
      trialEndAt: string;
      stub: {
        from: string;
        to: string;
        label: string;
        lines: CatchupStubLine[];
        totalCents: number;
        belowStripeMinimum: boolean;
      };
      voidInvoiceIds: string[];
    }
  | { ok: false; reason: string };

/** `GET /platform-admin/tenants/:id/billing/catchup-plan`: a dry run that writes nothing. */
export interface CatchupReportView {
  eligible: boolean;
  /** Internal lower_snake reasons (for `claim_held` only; the sentences come from `refusals`). */
  ineligible: string[];
  /** Distinct UPPER_SNAKE refusal codes, in first-seen order. */
  refusals: string[];
  hasStripeSubscription: boolean;
  externalPayment: boolean;
  monthlyCents: number | null;
  /** What the checkout bills every month: the plan plus its add-ons, whole cents. The card prints this, never `monthlyCents`. */
  recurringCents: number | null;
  rfInvoices: { open: number; paid: number };
  plan: CatchupPlanView;
}

/** `POST …/billing/catchup-checkout`'s answer: the hosted payment page (`ADMIN_LINK` is always hosted). */
export interface CatchupCheckoutResult {
  checkoutUrl: string | null;
  sessionId: string;
  stubCents: number;
  shape: string;
}

export async function fetchCatchupPlan(tenantId: string): Promise<CatchupReportView> {
  const res = await superAdminClient.get(
    `/platform-admin/tenants/${tenantId}/billing/catchup-plan`,
  );
  return res.data;
}

/** `expectedStubCents` is the plan's own `stub.totalCents`, exactly as read; the server re-plans and refuses a change. */
export async function openCatchupCheckout(
  tenantId: string,
  expectedStubCents: number,
): Promise<CatchupCheckoutResult> {
  const res = await superAdminClient.post(
    `/platform-admin/tenants/${tenantId}/billing/catchup-checkout`,
    { expectedStubCents },
  );
  return res.data;
}

/** The 409 whose amount no longer matches the plan the admin confirmed: nothing was created. */
export function isCatchupAmountChanged(err: unknown): boolean {
  const res = (err as { response?: { status?: unknown; data?: { code?: unknown } } } | undefined)
    ?.response;
  return res?.status === 409 && res?.data?.code === API_ERROR_CODES.CATCHUP_AMOUNT_CHANGED;
}
