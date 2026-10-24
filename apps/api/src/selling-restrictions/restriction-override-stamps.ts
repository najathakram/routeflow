import {
  CLEARED_OVERRIDE_STAMP,
  OVERRIDE_STAMP_SELECT,
  hasOverrideStamp,
  type OverrideStamp,
} from "../common/restriction-override-columns";
import type { HeldLine, StampPlan, StaffWriteDecision } from "./restriction-warning";
import {
  writeOverrideAuditRows,
  type AuditLogTx,
  type OverrideAuditLine,
  type OverrideDocumentType,
} from "./restriction-override-audit";

/**
 * Row 510: the transaction half of the override protocol. Inside the write's OWN transaction, after its line writes,
 * this reconciles the stamp columns of the document's live lines with the gate's `StaffWriteDecision` and writes one
 * audit row per newly stamped line (`tx.auditLog.create`, so an override without its audit row rolls the write back):
 *
 *   1. a line whose product changed since the lock-time read (a substitution) loses its stamp: it is a new sale of
 *      another product and re-warns on its own;
 *   2. every live line of a newly acknowledged product takes the new stamp (reason, by, at, rule ids) and gets an audit
 *      row; a new override REPLACES an older stamp;
 *   3. a stamp the document already carried is re-applied, by product, to the live lines that lack one (a recreated or a
 *      newly added line of an acknowledged product): no audit row, it is not a new override.
 *
 * Writes only the four stamp columns (a status / quantity / money write never goes through here). Costs one read of the
 * document's lines, and only when there is something to stamp, carry or clear. Never `updateMany` without ids (the
 * undefined-where widening trap): every write is `id in <ids read just now> AND <parent> = parentId`.
 */

export interface StampContext {
  model: "orderItem" | "invoiceItem";
  parentId: string;
  documentType: OverrideDocumentType;
  tenantId: string;
  /** The overriding User id. Required whenever the decision stamps a new override. */
  by: string | null;
  impersonatedBy?: string | null;
  at?: Date;
}

type LineRow = HeldLine & { id: string };

/** The minimal transaction surface (a Prisma tx, or a test double). */
export interface StampTx extends AuditLogTx {
  orderItem?: LineDelegate;
  invoiceItem?: LineDelegate;
}
interface LineDelegate {
  findMany(args: unknown): Promise<unknown[]>;
  updateMany(args: unknown): Promise<unknown>;
}

const PARENT_KEY = { orderItem: "orderId", invoiceItem: "invoiceId" } as const;
const ENTITY = { orderItem: "OrderItem", invoiceItem: "InvoiceItem" } as const;

function assertIds(ids: readonly string[], parentId: string): void {
  if (!parentId || ids.length === 0 || ids.some((id) => typeof id !== "string" || id === "")) {
    throw new Error("restriction override stamp: refusing an updateMany without ids and a parent");
  }
}

/** Stamp, carry and clear the document's lines per `ov`; returns the number of newly stamped lines. */
export async function stampRestrictionOverrides(
  tx: StampTx,
  ov: StaffWriteDecision | null | undefined,
  ctx: StampContext,
): Promise<number> {
  if (!ov || (ov.stamps.length === 0 && ov.carried.length === 0)) return 0;
  const delegate = tx[ctx.model];
  if (!delegate) throw new Error(`restriction override stamp: no ${ctx.model} delegate on the tx`);
  if (!ctx.parentId) throw new Error("restriction override stamp: parentId is required");
  const parentKey = PARENT_KEY[ctx.model];
  const at = ctx.at ?? new Date();

  const rows = (await delegate.findMany({
    where: { [parentKey]: ctx.parentId },
    select: {
      id: true,
      productId: true,
      ...(ctx.model === "orderItem" ? { status: true } : {}),
      ...OVERRIDE_STAMP_SELECT,
    },
  })) as LineRow[];
  const live = rows.filter((r) => r.status !== "CANCELLED");
  const write = (ids: string[], data: OverrideStamp) => {
    assertIds(ids, ctx.parentId);
    return delegate.updateMany({ where: { id: { in: ids }, [parentKey]: ctx.parentId }, data });
  };

  // 1. Substitutions: a held, stamped line whose product is no longer the one it was stamped for.
  const swapped = new Set(
    live
      .filter((r) => ov.heldStamped.has(r.id) && ov.heldStamped.get(r.id) !== (r.productId ?? null))
      .map((r) => r.id),
  );
  if (swapped.size > 0) await write([...swapped], { ...CLEARED_OVERRIDE_STAMP });
  const stampedNow = (r: LineRow) => !swapped.has(r.id) && hasOverrideStamp(r);

  // 2. Newly acknowledged products: every live line of the product takes the (per-line) stamp, one audit row each.
  const plansByProduct = new Map<string, StampPlan[]>();
  for (const s of ov.stamps)
    plansByProduct.set(s.productId, [...(plansByProduct.get(s.productId) ?? []), s]);
  const audit: OverrideAuditLine[] = [];
  const stamped = new Set<string>();
  for (const [productId, plans] of plansByProduct) {
    const mine = live.filter((r) => r.productId === productId);
    if (mine.length === 0) continue;
    if (!ctx.by)
      throw new Error("restriction override stamp: a new override needs the overriding user id");
    const planFor = (r: LineRow) => plans.find((p) => p.lineKey === `l:${r.id}`) ?? plans[0];
    const groups = new Map<StampPlan, string[]>();
    for (const r of mine) groups.set(planFor(r), [...(groups.get(planFor(r)) ?? []), r.id]);
    for (const [plan, ids] of groups) {
      await write(ids, {
        restrictionOverrideReason: plan.reason,
        restrictionOverrideBy: ctx.by,
        restrictionOverrideAt: at,
        restrictionOverrideRuleIds: [...plan.ruleIds],
      });
      for (const id of ids) {
        stamped.add(id);
        audit.push({
          lineId: id,
          productId,
          lineKey: plan.lineKey,
          ruleIds: plan.ruleIds,
          reason: plan.reason,
        });
      }
    }
  }

  // 3. Carried stamps: re-applied by product to live lines that lack one now.
  for (const c of ov.carried) {
    const lacking = live
      .filter((r) => r.productId === c.productId && !stamped.has(r.id) && !stampedNow(r))
      .map((r) => r.id);
    if (lacking.length > 0)
      await write(lacking, {
        ...c.stamp,
        restrictionOverrideRuleIds: [...c.stamp.restrictionOverrideRuleIds],
      });
  }

  if (audit.length > 0) {
    await writeOverrideAuditRows(
      tx,
      {
        tenantId: ctx.tenantId,
        by: ctx.by as string,
        impersonatedBy: ctx.impersonatedBy ?? null,
        entityType: ENTITY[ctx.model],
        documentType: ctx.documentType,
        documentId: ctx.parentId,
        warningHash: ov.warningHash,
        basis: ov.basis,
      },
      audit,
    );
  }
  return audit.length;
}
