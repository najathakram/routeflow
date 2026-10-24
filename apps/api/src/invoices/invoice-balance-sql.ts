import { BadRequestException, UnprocessableEntityException } from "@nestjs/common";
import { InvoiceStatus, Prisma } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { confirmedBalance } from "./invoice-balance-classify";
import { OPEN_INVOICE_STATUSES } from "./invoice-status-sets";
import { CONFIRMED_STATUS } from "./payment-predicates";

/**
 * SA-770 (ACTION-ITEMS row 294): "overdue" means a BALANCE IS DUE. The `Invoice` model stores no balance
 * (the TS readers derive it, `deriveInvoiceDetailFields`: `total - splitConfirmed(payments)` rounded to
 * cents), so a SQL reader that selects overdue rows needs the same rule in SQL. This is that rule, once:
 * every query that means "past its due day AND still owes" goes through `balanceDueSql` / the readers
 * below, and invoice-balance-sql.parity.db.spec.ts pins the SQL against the TS balance row for row.
 *
 * The rule: balance = `total - SUM(InvoicePayment.amount WHERE status = CONFIRMED_STATUS)`. Every method
 * counts (cash, credit-note and advance applications are all `InvoicePayment` rows, exactly as
 * `splitConfirmed` adds its three buckets); DRAFT, VOID and PENDING rows never do. "Owes" is `> 0.005`,
 * the SQL twin of `roundMoney(balance) > 0` on a cents-exact `numeric(10,2)` difference. The status rule
 * (`isSettled`: PAID / VOID / WRITTEN_OFF read as 0) is NOT part of the arithmetic; the readers apply it
 * through their open-status set.
 */

/** Above this many matching ids the overdue LIST is refused (422), never truncated. */
export const OVERDUE_IDS_CAP = 10_000;

/** The raw-SQL surface the readers need (a `PrismaService`, a transaction client or a test fake). */
export interface RawSqlDb {
  $queryRaw: (sql: Prisma.Sql) => Promise<unknown>;
  $executeRaw: (sql: Prisma.Sql) => Promise<number>;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The SQL predicate "this invoice still owes": `<alias>."total" - COALESCE(SUM(confirmed payments), 0) > 0.005`.
 * `alias` must name the `"Invoice"` row in the surrounding query. The confirmed status is a bound value
 * built from the pricing constant, never a typed literal; the alias is checked as a plain identifier.
 */
export function balanceDueSql(alias: string): Prisma.Sql {
  if (!IDENTIFIER.test(alias))
    throw new Error(`balanceDueSql: "${alias}" is not a plain SQL alias`);
  const a = Prisma.raw(`"${alias}"`);
  return Prisma.sql`${a}."total" - COALESCE((SELECT SUM(p."amount") FROM "InvoicePayment" p WHERE p."invoiceId" = ${a}."id" AND p."status" = ${CONFIRMED_STATUS}::"PaymentStatus"), 0) > 0.005`;
}

export interface OverdueScope {
  /** The open statuses to select from (the caller's set: list, bookkeeping and the sweep differ). */
  statuses: readonly string[];
  /** Narrow to one customer (a buyer's own list, or the list's customer filter). */
  customerId?: string | null;
}

/** `i.status IN (<each bound and cast to the enum>)`. */
function statusIn(statuses: readonly string[]): Prisma.Sql {
  return Prisma.join(statuses.map((s) => Prisma.sql`${s}::"InvoiceStatus"`));
}

/** A cutoff rides as a bound ISO instant cast to `timestamp` (the column's UTC wall clock). */
function cutoffSql(cutoff: Date): Prisma.Sql {
  return Prisma.sql`${cutoff.toISOString()}::timestamp`;
}

function requireTenant(tenantId: string): void {
  if (!tenantId) throw new Error("overdue invoice reads need a tenant id (never an unscoped read)");
}

/** The shared WHERE body: tenant, open status, due day over, balance due (and optionally one customer). */
function overdueWhere(
  tenantId: string,
  cutoff: Date,
  statuses: readonly string[],
  customerId?: string | null,
): Prisma.Sql {
  return Prisma.sql`"i"."tenantId" = ${tenantId}
      AND "i"."status" IN (${statusIn(statuses)})
      AND "i"."dueDate" < ${cutoffSql(cutoff)}
      ${customerId ? Prisma.sql`AND "i"."customerId" = ${customerId}` : Prisma.empty}
      AND ${balanceDueSql("i")}`;
}

/**
 * The ids of the tenant's invoices in `statuses` whose due day has passed (`dueDate < cutoff`) and that
 * still owe. Tenant-scoped, every value bound. More than `OVERDUE_IDS_CAP` matches is a coded 422
 * `OVERDUE_FILTER_TOO_BROAD`: the list pages over `id IN ids`, so a silently truncated set would make
 * the counts and the pages lie.
 */
export async function overdueInvoiceIds(
  db: RawSqlDb,
  tenantId: string,
  cutoff: Date,
  scope: OverdueScope,
): Promise<string[]> {
  requireTenant(tenantId);
  if (scope.statuses.length === 0) return [];
  const rows = (await db.$queryRaw(
    Prisma.sql`SELECT "i"."id" AS "id" FROM "Invoice" "i"
      WHERE ${overdueWhere(tenantId, cutoff, scope.statuses, scope.customerId)}
      ORDER BY "i"."id"
      LIMIT ${OVERDUE_IDS_CAP + 1}`,
  )) as { id: string }[];
  if (rows.length > OVERDUE_IDS_CAP) {
    throw new UnprocessableEntityException({
      code: API_ERROR_CODES.OVERDUE_FILTER_TOO_BROAD,
      message: "Too many invoices are overdue to list at once. Filter by customer and try again.",
    });
  }
  return rows.map((r) => r.id);
}

/** How many invoices `overdueInvoiceIds` would select — uncapped (a dashboard number must not 422). */
export async function overdueInvoiceCount(
  db: RawSqlDb,
  tenantId: string,
  cutoff: Date,
  scope: OverdueScope,
): Promise<number> {
  requireTenant(tenantId);
  if (scope.statuses.length === 0) return 0;
  const rows = (await db.$queryRaw(
    Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "Invoice" "i"
      WHERE ${overdueWhere(tenantId, cutoff, scope.statuses, scope.customerId)}`,
  )) as { count: number | bigint }[];
  return Number(rows[0]?.count ?? 0);
}

/**
 * The overdue sweep's write: flip the tenant's `statuses` invoices to OVERDUE once their due day has
 * ended AND they still owe, in ONE statement. Returns the number of rows flipped. `updatedAt` is stamped
 * here because a raw UPDATE bypasses Prisma's `@updatedAt`.
 *
 * RACE, stated exactly. Under READ COMMITTED, when this UPDATE waits on a row lock and the holder
 * commits, Postgres re-checks the WHERE against the NEW version of that Invoice row only; the correlated
 * InvoicePayment subquery keeps the statement's snapshot, so the balance test is NOT re-evaluated. What
 * keeps a just-paid invoice from being flipped today is the STATUS re-check: the payment path takes
 * `lockInvoicesForPayment` (FOR UPDATE) and moves the invoice to PAID or PARTIAL, so the re-check on
 * `status IN (SENT, VIEWED)` fails. That protection ends once P-3 holds an OVERPAID invoice at SENT:
 * an overpayment would then leave the status unchanged and the stale balance could flip it.
 * TODO (tied to P-3): make it lock-first, in one transaction: `SELECT id ... FOR UPDATE` the candidate
 * ids, then `UPDATE ... WHERE id = ANY(ids) AND <balanceDueSql>`, so the balance is read after the lock.
 */
export async function markInvoicesOverdue(
  db: RawSqlDb,
  tenantId: string,
  cutoff: Date,
  statuses: readonly string[],
): Promise<number> {
  requireTenant(tenantId);
  if (statuses.length === 0) return 0;
  return db.$executeRaw(
    Prisma.sql`UPDATE "Invoice" AS "i"
      SET "status" = ${InvoiceStatus.OVERDUE}::"InvoiceStatus", "updatedAt" = NOW()
      WHERE ${overdueWhere(tenantId, cutoff, statuses)}`,
  );
}

/**
 * Row 318a: a reminder demands money on an ISSUED, UNPAID invoice. Only SENT, VIEWED, PARTIAL and OVERDUE
 * (`OPEN_INVOICE_STATUSES`, the web `canSendReminder` set) qualify; a DRAFT (never issued), PAID, VOID or
 * WRITTEN_OFF invoice is refused with the coded 400 REMINDER_NOT_ISSUED.
 */
export function assertReminderIssued(status: string): void {
  if ((OPEN_INVOICE_STATUSES as readonly string[]).includes(status)) return;
  throw new BadRequestException({
    code: API_ERROR_CODES.REMINDER_NOT_ISSUED,
    message: "A reminder can only be sent for an invoice that has been issued and is still unpaid.",
  });
}

/**
 * A payment reminder demands a balance: refuse (coded 400, before any PDF or email work) when the
 * confirmed payments already cover the total. `sendReminder` only refused VOID and PAID, so an
 * exactly-paid or overpaid invoice still SENT (P-3) emailed a "$0.00 balance due" reminder. Same
 * arithmetic as `deriveInvoiceDetailFields`: `roundMoney(total - sumConfirmed(payments)) > 0`.
 */
export function assertReminderOwes(
  total: unknown,
  payments: ReadonlyArray<{ amount: unknown; status?: string }> | null | undefined,
): void {
  if (confirmedBalance(total, payments) > 0) return;
  throw new BadRequestException({
    code: API_ERROR_CODES.REMINDER_NO_BALANCE_DUE,
    message: "This invoice has no balance due, so there is nothing to remind about.",
  });
}
