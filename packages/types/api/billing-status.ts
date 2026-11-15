// SA-1146 B-5: the ONE billing status the server builds for every surface that tells a business what it owes or how
// to pay (shell banner, strip, Billing status card, Settings card, blocked-save toast). The web only renders it.
// Served by `GET /billing/status` (OPERATOR and up). A TYPE-only file: the API imports it with `import type`.

/** The exhaustive set of states, in the order SA-1146 section 1 lists them (plus `none`: nothing to say). */
export type BillingStatusState =
  "paid_up" | "due" | "failed" | "read_only" | "processing" | "trial" | "trial_ended" | "none";

/** What the one primary button does: the word (`kind`) and where it goes (`target`; SA-1146 section 3). */
export interface BillingStatusAction {
  kind: "pay" | "change_card" | "choose_plan";
  target: "hosted_invoice" | "checkout" | "portal" | "choose_plan";
}

export interface BillingStatusView {
  state: BillingStatusState;
  /** Dollars, rounded with `roundMoney` on the server. Null when the state names no amount. */
  amount: number | null;
  /** A calendar day, "YYYY-MM-DD", in the TENANT's zone (the due day, the deadline, the next payment, the trial end). */
  dueOn: string | null;
  /** Set by the server for a TENANT_ADMIN only; null for staff and for a state with no button. */
  action: BillingStatusAction | null;
}
