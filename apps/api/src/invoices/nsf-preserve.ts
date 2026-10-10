import { roundMoney } from "@routeflow/pricing";
import { isNsfLine } from "./nsf-line";

/**
 * #2242 (SA-395 5a): the system NSF bounce-fee lines an invoice already carries, which a
 * delete-and-rebuild from the ORDER must keep. The order has no NSF line (setCheckStatus's BOUNCED
 * branch books it on the invoice alone, untaxed, straight into subtotal and total), so a rebuild
 * that deletes every line and re-sums the order's lines silently drops the customer's owed fee.
 *
 * Callers delete with `keepIds` excluded and add `feeTotal` to the invoice subtotal AFTER any tax
 * proration (the fee is untaxed, so it must not enter the order-proportion tax share).
 * Classification is #2169's shared predicate (`isNsfLine`), never a local description match.
 */
export async function preservedNsfLines(
  db: any,
  invoiceId: string,
): Promise<{ keepIds: string[]; feeTotal: number }> {
  const items: Array<{
    id: string;
    subtotal: unknown;
    description: string | null;
    systemKind: any;
  }> = await db.invoiceItem.findMany({
    where: { invoiceId },
    select: { id: true, subtotal: true, description: true, systemKind: true },
  });
  const nsf = items.filter((it) => isNsfLine(it));
  return {
    keepIds: nsf.map((it) => it.id),
    feeTotal: roundMoney(nsf.reduce((s, it) => s + Number(it.subtotal), 0)),
  };
}
