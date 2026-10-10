import { lockCounterClose, registerKeyOfOrder } from "../returns/counter-close-lock";
import { assertCounterWindowOpen } from "../returns/counter-close-window";

/**
 * SA-750r3 / SA-762r F7: the payment-edit paths (voidPayment, deletePayment, updatePayment, setCheckStatus(BOUNCED)) of a COUNTER
 * sale join the end-of-day close. Only an invoice whose order has `counterSale = true` is a till event; every other invoice gets
 * `null` here and every helper below is then a no-op (no lock statement, no window read), exactly as before.
 *
 * Lock order: counter-close (shared) -> Invoice FOR UPDATE. The scope is read BEFORE the transaction (the order's marker and
 * register are immutable), so the shared lock can be the transaction's first statement.
 */
export interface CounterPaymentScope {
  tenantId: string;
  registerKey: string;
}

type ScopeReader = {
  getTenantId: () => string | null;
  forTenant: () => {
    order: {
      findFirst: (args: {
        where: { invoices: { some: { id: string } } };
        select: { counterSale: true; registerKey: true };
      }) => Promise<{ counterSale?: boolean | null; registerKey?: string | null } | null>;
    };
  };
};

/** The till scope of this invoice's payments, or null (non-counter, no order, no tenant, or `applies` false: no read at all). */
async function scope(
  prisma: ScopeReader,
  invoiceId: string,
  applies = true,
): Promise<CounterPaymentScope | null> {
  const tenantId = prisma.getTenantId();
  if (!applies || !tenantId) return null;
  const order = await prisma.forTenant().order.findFirst({
    where: { invoices: { some: { id: invoiceId } } },
    select: { counterSale: true, registerKey: true },
  });
  const registerKey = registerKeyOfOrder(order);
  return registerKey ? { tenantId, registerKey } : null;
}

/** The transaction's FIRST statement for a counter invoice (the SHARED close lock); a no-op for any other. */
async function lock(
  tx: Parameters<typeof lockCounterClose>[0],
  scope: CounterPaymentScope | null,
): Promise<void> {
  if (scope) await lockCounterClose(tx, scope.tenantId, scope.registerKey);
}

/**
 * Under the shared lock: refuse 409 COUNTER_SALE_DAY_CLOSED when ANY of these instants (a payment's stored `paidAt`; for an edit
 * that changes the date, the new one too) falls inside a closed window of the register. A no-op for a non-counter invoice.
 */
async function assertOpen(
  tx: Parameters<typeof assertCounterWindowOpen>[0],
  scope: CounterPaymentScope | null,
  ...dates: Array<Date | string | null | undefined>
): Promise<void> {
  if (!scope) return;
  for (const d of dates) {
    if (d != null)
      await assertCounterWindowOpen(tx, scope.tenantId, scope.registerKey, new Date(d));
  }
}

/** One namespace so the 5.9k-line invoices service imports it in a single line (size ratchet). */
export const counterPay = { scope, lock, assertOpen };
