/**
 * SA-776 (row 382): what a tenant's STATUS allows the system to do on its own (cron ticks, queue processors).
 *
 * `TenantStatusGuard` (./tenant-status.guard.ts) refuses a READ_ONLY tenant's HTTP writes; this module is the same
 * rule for work nobody requested:
 *  - `acceptsAutomatedWrites(status)` - TRIAL or ACTIVE. A job that CREATES or CHANGES business records (orders,
 *    invoices, merges, commissions, CRM imports) filters its tenant set through it. READ_ONLY / SUSPENDED /
 *    CANCELLED get no new transactions from the system either.
 *  - `acceptsRecordKeeping(status)` - everything except SUSPENDED / CANCELLED. A job that only derives documents or
 *    notifications over EXISTING data (invoice PDFs, regulated filing prep, low-stock digest) keeps running for a
 *    READ_ONLY tenant ("view records" stays true) and stops for a suspended or cancelled one.
 *
 * `TENANT_JOBS` classifies EVERY `@LeaderCron` job and `@Process` handler. The structural pin
 * (`tenant-job-pin.spec.ts`) walks the source with the TypeScript compiler API: an unclassified job fails, and a
 * TRANSACTIONAL / RECORD_KEEPING job whose file does not reference its predicate fails. A new job without a class
 * is a red build, not a silent unfiltered writer.
 */

/** TRIAL and ACTIVE: the only statuses that get system-initiated writes. Prisma `in:` lists use this constant. */
export const AUTOMATED_WRITE_STATUSES = ["TRIAL", "ACTIVE"] as const;

/** SUSPENDED and CANCELLED: the only statuses record-keeping jobs skip. Prisma `notIn:` lists use this constant. */
export const RECORD_KEEPING_EXCLUDED_STATUSES = ["SUSPENDED", "CANCELLED"] as const;

/** True when the system may create or change this tenant's business records on its own. */
export function acceptsAutomatedWrites(status: string | null | undefined): boolean {
  return (AUTOMATED_WRITE_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * True when derived documents / notifications over existing records may still be produced. An unknown status
 * (the tenant row was not found) is NOT excluded: the caller's own lookup decides what a missing tenant means.
 */
export function acceptsRecordKeeping(status: string | null | undefined): boolean {
  return !(RECORD_KEEPING_EXCLUDED_STATUSES as readonly string[]).includes(status ?? "");
}

export type TenantJobClass = "TRANSACTIONAL" | "RECORD_KEEPING" | "HOUSEKEEPING" | "PLATFORM";

/**
 * How a job applies its class:
 *  - `AUTOMATED_WRITES`: references `acceptsAutomatedWrites` / `AUTOMATED_WRITE_STATUSES` (TRANSACTIONAL);
 *  - `ACTIVE_ONLY`: a TRANSACTIONAL job that deliberately keeps a STRICTER `status: "ACTIVE"` filter (SA-776 GAP-5:
 *    including TRIAL would start auto-orders / auto-invoices for trial tenants, a product call not made here);
 *  - `RECORD_KEEPING`: references `acceptsRecordKeeping` / `RECORD_KEEPING_EXCLUDED_STATUSES` (RECORD_KEEPING);
 *  - `NONE`: no tenant-status filter, and `reason` says why that is right.
 */
export type TenantJobFilter = "AUTOMATED_WRITES" | "ACTIVE_ONLY" | "RECORD_KEEPING" | "NONE";

export interface TenantJobSpec {
  class: TenantJobClass;
  filter: TenantJobFilter;
  /** Where the filter lives, relative to `apps/api/src`, when it is not the file that holds the decorator. */
  filterFile?: string;
  reason: string;
}

const PLATFORM = (reason: string): TenantJobSpec => ({ class: "PLATFORM", filter: "NONE", reason });

/**
 * Key = the `@LeaderCron` job name, or `<queue>.<process name>` for a Bull `@Process` handler.
 * Kept sorted by area; the pin reports a missing, extra or mis-filtered row by name.
 */
export const TENANT_JOBS: Readonly<Record<string, TenantJobSpec>> = {
  // ── TRANSACTIONAL: create or change business records ────────────────────────────────────────────────────────
  "order-templates.generateDailyOrders": {
    class: "TRANSACTIONAL",
    filter: "ACTIVE_ONLY",
    reason:
      "GAP-5: stays ACTIVE-only - TRIAL tenants get no auto-orders today; the predicate would start them (a product call)",
  },
  "recurring-invoices.generateDueRecurringInvoices": {
    class: "TRANSACTIONAL",
    filter: "ACTIVE_ONLY",
    reason:
      "GAP-5: stays ACTIVE-only - the predicate would start auto-invoices for trial tenants (a product call)",
  },
  "commission-reconciliation.reconcileCommissions": {
    class: "TRANSACTIONAL",
    filter: "ACTIVE_ONLY",
    reason: "GAP-5: stays ACTIVE-only (the predicate would add TRIAL tenants to commission writes)",
  },
  "tobacco-report.generateMonthlyReports": {
    class: "TRANSACTIONAL",
    filter: "ACTIVE_ONLY",
    reason:
      "GAP-5: stays ACTIVE-only (the predicate would add TRIAL tenants to monthly report writes)",
  },
  "authorization-expiry.runExpirySweep": {
    class: "TRANSACTIONAL",
    filter: "ACTIVE_ONLY",
    reason:
      "flips buyer authorizations to EXPIRED and notifies; already ACTIVE-only, kept as is (not in the fact pack: classified here)",
  },
  "invoices.markOverdue": {
    class: "TRANSACTIONAL",
    filter: "AUTOMATED_WRITES",
    reason: "TRIAL + ACTIVE is exactly the predicate; reads AUTOMATED_WRITE_STATUSES",
  },
  "orders.cronSweepPendingOrders": {
    class: "TRANSACTIONAL",
    filter: "AUTOMATED_WRITES",
    filterFile: "orders/sweep-tenant-gate.ts",
    reason:
      "merges PENDING orders; the sweep (and the boot sweep) skip a tenant that is not TRIAL / ACTIVE",
  },
  "crm-gohighlevel.poll": {
    class: "TRANSACTIONAL",
    filter: "AUTOMATED_WRITES",
    filterFile: "crm/gohighlevel/gohighlevel-poll.service.ts",
    reason:
      "imports CRM opportunities as customers / orders; pollAll skips a tenant that is not TRIAL / ACTIVE",
  },

  // ── RECORD_KEEPING: derived documents / notifications over existing data ────────────────────────────────────
  "regulated-filing.autoPrepareClosedFilings": {
    class: "RECORD_KEEPING",
    filter: "RECORD_KEEPING",
    reason:
      "compliance prep over CLOSED periods stays allowed when read-only; SUSPENDED / CANCELLED are skipped",
  },
  "inventory.sendLowStockDigest": {
    class: "RECORD_KEEPING",
    filter: "RECORD_KEEPING",
    reason:
      "a notification over existing stock; already not SUSPENDED / CANCELLED, now via the shared constant",
  },
  "invoices.generate-invoice": {
    class: "RECORD_KEEPING",
    filter: "RECORD_KEEPING",
    filterFile: "bookkeeping/invoice.processor.ts",
    reason:
      "the PDF of an EXISTING transaction; a SUSPENDED / CANCELLED tenant's job is skipped, not retried",
  },
  "mailbox-alert.sweepPending": {
    class: "RECORD_KEEPING",
    filter: "NONE",
    reason:
      "an owed mailbox-state alert to the tenant's own admins; a skip would have to clear or keep the owed row (a lost vs forever-re-claimed alert) - needs an outbox ruling, so unfiltered for now",
  },

  // ── HOUSEKEEPING: the system's own rows ─────────────────────────────────────────────────────────────────────
  "counter.parkSweep": {
    class: "HOUSEKEEPING",
    filter: "NONE",
    reason: "deletes the system's own expired parked carts; no business record changes",
  },
  "email.pruneDeliveries": {
    class: "HOUSEKEEPING",
    filter: "NONE",
    reason: "90-day retention prune of the system's own delivery log",
  },

  // ── PLATFORM / BILLING: governed by SA-775 / SA-733, not this predicate ─────────────────────────────────────
  "billing-cron.expireTrials": PLATFORM("billing lifecycle: sets tenant status itself"),
  "billing-cron.expireGrace": PLATFORM("billing lifecycle"),
  "billing-cron.applyScheduledDowngrades": PLATFORM("billing lifecycle"),
  "billing-cron.pushUpcomingDowngradePrices": PLATFORM("billing lifecycle"),
  "billing-cron.applyScheduledCancellations": PLATFORM("billing lifecycle"),
  "billing-cron.rollCycles": PLATFORM("billing lifecycle"),
  "billing-cron.warnTrialsEnding": PLATFORM("billing notification"),
  "billing-invoice.issueDue": PLATFORM("platform invoicing (RF_INVOICING_MODE)"),
  "billing-invoice.remind": PLATFORM("platform invoicing reminders"),
  "billing.suspendOverdueTenants": PLATFORM("billing lifecycle: sets tenant status itself"),
  "billing.reconcileParkedCheckouts": PLATFORM("billing reconciliation"),
  "billing.catchupSweep": PLATFORM("billing catch-up claims"),
  "billing.dunningSweep": PLATFORM("dunning"),
  "billing.dunningDiscovery": PLATFORM("dunning"),
  "billing.pauseReconcile": PLATFORM("dunning pause"),
  "billing.pauseReconcileFirst": PLATFORM("dunning pause"),
  "billing.reviewExpiredOverrides": PLATFORM("feature-grant lifecycle"),
  "billing.revokeExpiredOverrides": PLATFORM("feature-grant lifecycle"),
  "platform-admin.mirrorSync": PLATFORM(
    "mirrors tenants to the control plane; writes no tenant data",
  ),
  "onboarding.refreshAutoChecks": PLATFORM("white-glove onboarding checklist (platform-side)"),
  "onboarding.sendReminders": PLATFORM("white-glove onboarding reminders (platform-side)"),
  "onboarding.purgeIntakeFiles": PLATFORM("white-glove onboarding intake file retention"),
};

/** The spec's shape: `{ [jobName]: class }`, derived from `TENANT_JOBS` so the two cannot disagree. */
export const TENANT_JOB_CLASSES: Readonly<Record<string, TenantJobClass>> = Object.fromEntries(
  Object.entries(TENANT_JOBS).map(([name, spec]) => [name, spec.class]),
);
