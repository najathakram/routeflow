import { asOfText, isPaidAtSale, roundMoney } from "@routeflow/pricing";
import type { InvoiceAccountRow } from "@routeflow/types";
import type { PrismaService } from "../prisma/prisma.service";
import { overdueCutoff, tenantTodayDay } from "../common/calendar-date";
import { FALLBACK_ZONE, tenantTimeZone } from "../common/tenant-time-zone";
import { classifyInvoiceBalance } from "../invoices/invoice-balance-classify";
import { OPEN_BALANCE_INVOICE_SELECT, OPEN_BALANCE_INVOICE_WHERE } from "./open-balance-basis";
import { statementOutstandingAmount } from "./customer-statement";

/**
 * SA-1197: the invoice's account block, the customer's open balance on the statement's own basis (S9: the same cents as
 * the statement and the customers list). It reads, it never writes. The one reader (`readInvoiceAccountBalance`) and the
 * one row builder (`accountBlockRows`); invoice-account-balance.sites.spec.ts pins their call sites.
 *
 * - C1 never subtract: open balance = roundMoney(others + this invoice); no figure is ever `account - x`.
 * - C2 this invoice's figure comes from the model the surface prints (the send snapshot on a send), never a second read;
 *   the exclusion is in the where (`id: { not }`), the shared select is unchanged.
 * - C3 clamped per invoice (`classifyInvoiceBalance`, `statementOutstandingAmount`): an overpaid invoice counts 0.
 * - C6/C7 one predicate: no block when the switch is off, there is no customer, the customer is the walk-in (or the model
 *   does not carry `isWalkIn` at all: fail closed), the sale was paid at the counter, or the invoice is VOID / WRITTEN_OFF.
 * - C8 nothing is read when the predicate fails. C9 every form carries the read instant (date, time, zone) in the tenant's zone.
 */

/**
 * The api's copy of `INVOICE_ACCOUNT_LABELS` (packages/types/api/invoice-account.ts, C12): the api may not load a runtime
 * value from @routeflow/types (no-runtime-types-import.spec.ts), so this mirror is pinned set-equal to it by
 * invoice-account-balance.labels.spec.ts. Every word of the block lives here; no renderer carries one.
 */
export const INVOICE_ACCOUNT_LABELS_API = {
  heading: "Customer account balance as of {asOf}",
  others: "Other unpaid invoices",
  thisInvoice: "This invoice",
  openBalance: "Open balance",
  openBalanceOn: "Open balance on {asOf}",
} as const;

/** The plain result (C4): `{ show: false }` or the figures, never undefined, so "handed, nothing to show" is not "not handed". */
export type InvoiceAccountBalance =
  | { show: false }
  | {
      show: true;
      others: number;
      thisInvoice: number;
      openBalance: number;
      /** The read day in the tenant's zone, YYYY-MM-DD. */
      asOf: string;
      /** SA-1209 D3: the instant this copy's balance was read (ISO), never the viewing time; a cached PDF keeps its own. */
      asOfAt: string;
      /** The tenant's zone the instant prints in. */
      zone: string;
    };

/** The fields of the printed model the block reads (the send snapshot, the PDF's own read, the detail read). */
export interface AccountModel {
  id: string;
  customerId: string | null;
  status: string;
  total: unknown;
  dueDate?: Date | string | null;
  createdAt?: Date | string | null;
  payments?: ReadonlyArray<{
    amount: unknown;
    status: string;
    createdAt?: Date | string | null;
  }> | null;
  order?: { counterSale?: boolean | null } | null;
  customer?: { isWalkIn?: boolean | null } | null;
}

const CLOSED: readonly string[] = ["VOID", "WRITTEN_OFF"];

/** C6/C7: whether this invoice may carry the block at all. An absent `isWalkIn` key reads as "not proven ordinary". */
export function accountBlockApplies(model: AccountModel, showAccountBalance: boolean): boolean {
  if (!showAccountBalance) return false;
  if (!model.customerId || !model.customer) return false;
  if (!("isWalkIn" in model.customer) || model.customer.isWalkIn === true) return false;
  if (CLOSED.includes(model.status)) return false;
  return !isPaidAtSale(model);
}

/**
 * The one reader. One indexed findMany on the customer's other open invoices (tenant-scoped client, C10), summed by the
 * statement's own `statementOutstandingAmount`; this invoice's clamped balance from the printed model. Zero queries when
 * the predicate fails (C8).
 */
export async function readInvoiceAccountBalance(
  prisma: PrismaService,
  model: AccountModel,
  layout: { showAccountBalance: boolean },
  now: Date = new Date(),
): Promise<InvoiceAccountBalance> {
  const customerId = model.customerId;
  if (!customerId || !accountBlockApplies(model, layout.showAccountBalance)) return { show: false };
  const zone = await tenantTimeZone(prisma);
  const otherOpen = await prisma.forTenant().invoice.findMany({
    where: { customerId, id: { not: model.id }, ...OPEN_BALANCE_INVOICE_WHERE },
    select: OPEN_BALANCE_INVOICE_SELECT,
  });
  const others = statementOutstandingAmount(otherOpen, zone, now);
  // Q4: nothing prints when nothing else is owed, in both forms.
  if (!(others > 0)) return { show: false };
  const thisInvoice = classifyInvoiceBalance(model, overdueCutoff(now, zone)).balanceDue;
  return {
    show: true,
    others,
    thisInvoice,
    openBalance: roundMoney(others + thisInvoice),
    asOf: tenantTodayDay(zone, now),
    asOfAt: now.toISOString(),
    zone: zone ?? FALLBACK_ZONE,
  };
}

/**
 * C5: the ONE decision of what prints. `[]`, the full block, or (Balance Due hidden, Q6 (c)) the single
 * "Open balance on <date>" line that re-prints neither this invoice's figure nor the others'. The PDF and the email pass
 * the tenant's `hideBalanceDue`; a screen passes false (it always shows Balance due).
 */
export function accountBlockRows(
  result: InvoiceAccountBalance,
  opts: { hideBalanceDue: boolean },
): InvoiceAccountRow[] {
  if (!result.show) return [];
  const L = INVOICE_ACCOUNT_LABELS_API;
  const asOf = asOfText(result.asOfAt, result.zone);
  if (opts.hideBalanceDue) {
    return [
      {
        kind: "openBalanceOn",
        label: L.openBalanceOn.replace("{asOf}", asOf),
        amount: result.openBalance,
      },
    ];
  }
  return [
    { kind: "heading", label: L.heading.replace("{asOf}", asOf), amount: null },
    { kind: "others", label: L.others, amount: result.others },
    { kind: "thisInvoice", label: L.thisInvoice, amount: result.thisInvoice },
    { kind: "openBalance", label: L.openBalance, amount: result.openBalance },
  ];
}

/** The detail read's rows (a screen: Balance due always shows). One line at the call site (C11 ratchet). */
export async function detailAccountBlock(
  prisma: PrismaService,
  model: AccountModel,
  layout: { showAccountBalance: boolean },
): Promise<InvoiceAccountRow[]> {
  return accountBlockRows(await readInvoiceAccountBalance(prisma, model, layout), {
    hideBalanceDue: false,
  });
}
