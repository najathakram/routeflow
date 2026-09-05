/**
 * Pure decision layer behind `apps/api/scripts/backfill-legacy-tenant-ids.mjs` — no I/O, no
 * database, no `process` access, no printing. Every branch below is unit-tested from
 * `apps/api/src/common/backfill-legacy-tenant-ids-script.spec.ts`; the CLI only queries,
 * formats and (in `--live`) executes what these functions decide.
 *
 * Each classifier takes ONE joined row (shape documented per function, matching the SELECT in
 * the CLI verbatim) and returns `{ verdict, tenantId, reason }`:
 *   - `verdict` is one of the five constants below — `ok` means the row's tenant is derivable
 *     from its parent with no ambiguity; every `refuse: *` means the tool must leave the row
 *     alone and let the owner decide.
 *   - `tenantId` is the proposed value for an `ok` row, and ALWAYS `null` for a refusal.
 *   - `reason` is short prose for the report line; it never carries names, emails or amounts.
 *
 * The refusals are deliberately conservative: this repairs invisible rows in a production
 * database, so "I am not sure" must always mean "do nothing", never "pick one".
 */

/** The only tables this tool may ever write. `buildUpdates` interpolates the table name into
 *  SQL, so it must come from THIS list — never from a row, a report field or argv. */
export const BACKFILL_TABLES = ["RouteRunStop", "PaymentCounter", "CreditNote"];

export const VERDICT_OK = "ok";
export const VERDICT_PARENT_MISSING = "refuse: parent missing";
export const VERDICT_PARENTS_DISAGREE = "refuse: parents disagree";
export const VERDICT_SINGLETON = "refuse: singleton";
export const VERDICT_PAIR_COLLISION = "refuse: unique-pair collision";

/** `PaymentCounter.id` defaults to this literal in the schema — the pre-multi-tenant global
 *  counter. It is not a tenant id and must never be given one. */
export const SINGLETON_COUNTER_ID = "singleton";

/** Guarded, id-pinned, still-NULL-only. The `AND "tenantId" IS NULL` is what makes a re-run and
 *  a concurrent writer safe: a row repaired under us returns zero rows and aborts the batch. */
export function updateSql(table) {
  if (!BACKFILL_TABLES.includes(table)) {
    throw new Error(`legacy-tenant-backfill: refusing to build SQL for unknown table "${table}"`);
  }
  return `UPDATE "${table}" SET "tenantId" = $1 WHERE "id" = $2 AND "tenantId" IS NULL RETURNING "id"`;
}

const accept = (tenantId, reason) => ({ verdict: VERDICT_OK, tenantId, reason });
const refuse = (verdict, reason) => ({ verdict, tenantId: null, reason });

/**
 * RouteRunStop — the row shape that actually hurts today: a NULL-tenant stop still renders on
 * the run card through a nested include, but every tenant-scoped write (complete / skip)
 * cannot see it, so the run auto-completes with the stop stuck PENDING.
 *
 * Its tenant is only unambiguous when all THREE ancestors agree: the RouteRun it belongs to,
 * the RouteStop it instantiates, and the Route that owns both. Two of three agreeing is not
 * enough — a disagreement means the graph itself is inconsistent and a human must look.
 *
 * @param {{ runTenantId?: string|null, routeStopTenantId?: string|null, routeTenantId?: string|null }} row
 */
export function classifyRouteRunStop(row) {
  const { runTenantId, routeStopTenantId, routeTenantId } = row ?? {};
  const missing = [];
  if (!runTenantId) missing.push("RouteRun");
  if (!routeStopTenantId) missing.push("RouteStop");
  if (!routeTenantId) missing.push("Route");
  if (missing.length > 0) {
    return refuse(
      VERDICT_PARENT_MISSING,
      `no tenant on ${missing.join(", ")} (row missing, or its own tenantId is NULL)`,
    );
  }
  const distinct = new Set([runTenantId, routeStopTenantId, routeTenantId]);
  if (distinct.size > 1) {
    return refuse(
      VERDICT_PARENTS_DISAGREE,
      `RouteRun/RouteStop/Route name ${distinct.size} different tenants`,
    );
  }
  return accept(runTenantId, "RouteRun, RouteStop and Route all name the same tenant");
}

/**
 * PaymentCounter is keyed BY tenant: its `id` IS the tenant id (the join in the CLI proves a
 * Tenant with that id exists). Two shapes are refused, both as `refuse: singleton`:
 *   - the literal `singleton` id — the schema default, i.e. the single global counter that
 *     predates multi-tenancy. Giving it a tenant would silently hand one tenant a counter
 *     whose `next` was advanced by every other tenant's payments.
 *   - an id no Tenant row matches — then the id is not a tenant id and nothing can be derived.
 *
 * @param {{ id?: string|null, parentTenantId?: string|null }} row
 */
export function classifyPaymentCounter(row) {
  const { id, parentTenantId } = row ?? {};
  if (id === SINGLETON_COUNTER_ID) {
    return refuse(
      VERDICT_SINGLETON,
      'id is the literal "singleton" — the pre-multi-tenant global counter, not a tenant',
    );
  }
  if (!parentTenantId) {
    return refuse(VERDICT_SINGLETON, "no Tenant row carries this id — it is not a tenant id");
  }
  return accept(parentTenantId, "the counter id is itself the tenant id");
}

/**
 * CreditNote takes its tenant from its Customer (the only required parent). Four refusals:
 *   - no Customer tenant → nothing to derive from;
 *   - a LINKED Invoice that is itself unusable — the row is gone, or its own `tenantId` is NULL.
 *     `invoiceTenantId` alone cannot tell those apart from "no invoice linked at all": all three
 *     read as NULL after the LEFT JOIN, and the first two silently degraded to "derive from the
 *     Customer, no invoice to check" — accepting a row whose second parent was never inspected.
 *     `invoiceRowId` (the joined `Invoice."id"`) is what separates them: `invoiceId` set with a
 *     NULL `invoiceRowId` means the parent is missing; set with a NULL `invoiceTenantId` means
 *     the parent is itself an unrepaired legacy row. Both are `refuse: parent missing`, so the
 *     owner repairs the Invoice first and re-runs, rather than this tool guessing;
 *   - a linked Invoice whose tenant differs → the row straddles two tenants, a human decides;
 *   - `(tenantId, creditNoteNumber)` is `@@unique`, so writing the derived tenant would collide
 *     with a credit note that already holds that number for that tenant. Renumbering is a
 *     business decision, never a repair script's.
 *
 * @param {{ customerTenantId?: string|null, invoiceId?: string|null, invoiceRowId?: string|null,
 *           invoiceTenantId?: string|null, pairCollision?: boolean }} row
 */
export function classifyCreditNote(row) {
  const { customerTenantId, invoiceId, invoiceRowId, invoiceTenantId, pairCollision } = row ?? {};
  if (!customerTenantId) {
    return refuse(VERDICT_PARENT_MISSING, "Customer row missing or its tenantId is NULL");
  }
  if (invoiceId && !invoiceRowId) {
    return refuse(VERDICT_PARENT_MISSING, "invoiceId points at an Invoice row that does not exist");
  }
  if (invoiceId && !invoiceTenantId) {
    return refuse(
      VERDICT_PARENT_MISSING,
      "the linked Invoice has a NULL tenantId — repair the Invoice first, then re-run",
    );
  }
  if (invoiceTenantId && invoiceTenantId !== customerTenantId) {
    return refuse(VERDICT_PARENTS_DISAGREE, "Invoice.tenantId differs from Customer.tenantId");
  }
  if (pairCollision === true) {
    return refuse(
      VERDICT_PAIR_COLLISION,
      "another CreditNote already holds (tenantId, creditNoteNumber) — writing this one " +
        "would violate the @@unique([tenantId, creditNoteNumber]) constraint",
    );
  }
  return accept(
    customerTenantId,
    invoiceTenantId
      ? "tenant derived from Customer; Invoice agrees"
      : "tenant derived from Customer",
  );
}

/**
 * The explicit, ordered write list — one guarded UPDATE per `ok` report, nothing at all for a
 * refusal. There is deliberately no blanket `WHERE "tenantId" IS NULL` form: every statement
 * pins one id that appeared in the report the owner just read.
 *
 * Throws rather than returning a half-safe list when a report is malformed (unknown table, no
 * proposed tenant) or when two `ok` CreditNote rows would claim the same
 * `(tenantId, creditNoteNumber)` — the per-row `pairCollision` flag cannot see that case,
 * because both siblings still have a NULL tenantId and so match neither's EXISTS subquery.
 *
 * @param {Array<{ table: string, id: string, verdict: string, tenantId: string|null, creditNoteNumber?: string }>} reports
 * @returns {Array<{ table: string, id: string, tenantId: string, sql: string, params: [string, string] }>}
 */
export function buildUpdates(reports) {
  const updates = [];
  const creditNotePairs = new Set();
  for (const report of reports ?? []) {
    if (!report || report.verdict !== VERDICT_OK) continue;
    if (!BACKFILL_TABLES.includes(report.table)) {
      throw new Error(`legacy-tenant-backfill: unknown table "${report.table}" in report`);
    }
    if (!report.id || !report.tenantId) {
      throw new Error(
        `legacy-tenant-backfill: ${report.table} report marked ok without both an id and a tenantId`,
      );
    }
    if (report.table === "CreditNote" && report.creditNoteNumber) {
      const pair = JSON.stringify([report.tenantId, report.creditNoteNumber]);
      if (creditNotePairs.has(pair)) {
        throw new Error(
          "legacy-tenant-backfill: two NULL-tenant CreditNote rows would claim the same " +
            "(tenantId, creditNoteNumber) — refusing the whole batch",
        );
      }
      creditNotePairs.add(pair);
    }
    updates.push({
      table: report.table,
      id: report.id,
      tenantId: report.tenantId,
      sql: updateSql(report.table),
      params: [report.tenantId, report.id],
    });
  }
  return updates;
}
