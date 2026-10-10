import { roundMoney } from "@routeflow/pricing";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";

/**
 * SA-763r P-3: the invoice-money audit rows, written IN the writer's own transaction (an audit row for a
 * rolled-back restatement would be a lie). `tx.auditLog.create` is tenant-scoped by the tenant tx proxy.
 * One helper per action so the meta shape is declared once; `actor` is the editing user's id (null for a
 * system writer).
 */
type AuditTx = { auditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> } };

function write(tx: AuditTx, action: string, invoiceId: string, actor: string | null, meta: object) {
  return tx.auditLog.create({
    data: { userId: actor, action, entityType: "invoice", entityId: invoiceId, meta },
  });
}

/** R5.1: a re-sync of a NON-DRAFT invoice (the final document was restated). The issue date never moves. */
export function auditInvoiceRevised(
  tx: AuditTx,
  p: {
    invoiceId: string;
    orderId: string | null;
    actor: string | null;
    totalBefore: number;
    totalAfter: number;
    linesChanged: number;
  },
) {
  const { invoiceId, actor, ...meta } = p;
  return write(tx, AUDIT_ACTIONS.INVOICE_REVISED, invoiceId, actor, { invoiceId, actor, ...meta });
}

/** M6: a restatement left the invoice paid beyond its new total (it is held out of PAID, `overpaidBy` shows it). */
export function auditOverpaidAfterRestatement(
  tx: AuditTx,
  p: { invoiceId: string; paid: number; total: number; overpaidBy: number; actor: string | null },
) {
  return write(tx, AUDIT_ACTIONS.INVOICE_OVERPAID_AFTER_RESTATEMENT, p.invoiceId, p.actor, p);
}

/** [L-O2]: the operator's deliberate standalone overpayment (the only `onOverpaid: "PAID"` caller). */
export function auditDeliberateOverpayment(
  tx: AuditTx,
  p: { invoiceId: string; paymentGroupId: string; overpaidBy: number; actor: string | null },
) {
  return write(tx, AUDIT_ACTIONS.INVOICE_DELIBERATE_OVERPAYMENT, p.invoiceId, p.actor, p);
}

type PriorLine = { orderItemId?: string | null; qty?: unknown; subtotal?: unknown };

/**
 * How many order lines a restatement changed: a line whose qty or subtotal differs, plus lines added and
 * removed (by `orderItemId`; a line with no provenance counts as one changed line when the invoice's
 * line count differs). A no-op re-sync of an unchanged invoice is 0.
 */
export function countLinesChanged(prior: PriorLine[], next: PriorLine[]): number {
  const money = (v: unknown) => Math.round(Number(v ?? 0) * 100);
  const key = (l: PriorLine, i: number) => l.orderItemId ?? `#${i}`;
  const before = new Map(prior.map((l, i) => [key(l, i), l]));
  const after = new Map(next.map((l, i) => [key(l, i), l]));
  let changed = 0;
  for (const [k, l] of after) {
    const b = before.get(k);
    if (!b || Number(b.qty) !== Number(l.qty) || money(b.subtotal) !== money(l.subtotal)) changed++;
  }
  for (const k of before.keys()) if (!after.has(k)) changed++;
  return changed;
}

/**
 * A NON-DRAFT invoice was restated by an order edit (`rebuildSiblingDrafts` preserveStatus, or the issued
 * deposit mirror): the `invoice.revised` row, plus the `invoice.overpaid-after-restatement` row when the
 * confirmed payments now exceed the new total (the status helper holds it out of PAID; `overpaidBy`
 * shows the excess). Both in the restating transaction. The issue date is never touched by a revision.
 */
export async function auditRestatement(
  tx: AuditTx,
  p: {
    invoiceId: string;
    orderId: string | null;
    actor: string | null;
    totalBefore: number;
    totalAfter: number;
    linesChanged: number;
    paid: number;
  },
) {
  await auditInvoiceRevised(tx, {
    invoiceId: p.invoiceId,
    orderId: p.orderId,
    actor: p.actor,
    totalBefore: p.totalBefore,
    totalAfter: p.totalAfter,
    linesChanged: p.linesChanged,
  });
  const overpaidBy = roundMoney(p.paid - p.totalAfter);
  if (overpaidBy > 0.005)
    await auditOverpaidAfterRestatement(tx, {
      invoiceId: p.invoiceId,
      paid: roundMoney(p.paid),
      total: p.totalAfter,
      overpaidBy,
      actor: p.actor,
    });
}
