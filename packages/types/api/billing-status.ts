// SA-1146 B-5: the ONE billing status the server builds for every surface that tells a business what it owes or how
// to pay (shell banner, strip, Billing status card, Settings card, blocked-save toast). The web only renders it.
// Served by `GET /billing/status` (OPERATOR and up). Types, plus the one runtime constant the API and the web share.

/** The trial notice window in days: the same 7 days on the API status and on the web strip (SA-1150 S18). */
export const TRIAL_NOTICE_DAYS = 7;

/** The exhaustive set of states, in the order SA-1146 section 1 lists them (plus `none`: nothing to say). */
export type BillingStatusState =
  "paid_up" | "due" | "failed" | "read_only" | "processing" | "trial" | "trial_ended" | "none";

/** What the one primary button does: the word (`kind`) and where it goes (`target`; SA-1146 section 3). */
export type BillingStatusAction =
  | { kind: "pay"; target: "hosted_invoice" | "checkout" }
  | { kind: "add_card"; target: "checkout" }
  /** `portal` stays a seam for the secondary Change card; no state's primary action is this today. */
  | { kind: "change_card"; target: "portal" }
  | { kind: "choose_plan"; target: "choose_plan" };

export interface BillingStatusView {
  state: BillingStatusState;
  /** Dollars, rounded with `roundMoney` on the server. Null when the state names no amount. */
  amount: number | null;
  /** A calendar day, "YYYY-MM-DD", in the TENANT's zone (the due day, the deadline, the next payment, the trial end). */
  dueOn: string | null;
  /** Set by the server for a TENANT_ADMIN (or SUPER_ADMIN in a tenant) only; null for staff and for a state with no button. */
  action: BillingStatusAction | null;
}
