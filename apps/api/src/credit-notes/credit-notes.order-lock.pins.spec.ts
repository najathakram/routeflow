import { readFileSync } from "fs";
import { join } from "path";

/**
 * B947 lock-order pins (SA-214: Order -> Invoice, each set id-sorted). create() takes the Order and ALL the order's creditable
 * invoices FIRST (lockOrderPoolRows), then its own Invoice row, then reads the pool (validateAndBuildCnItems). Taking them AFTER
 * the reads (or the Invoice before the Order) inverts the order against the returns / void / delete paths: Postgres kills one
 * transaction with 40P01 and `retryOnTxConflict` hides it, so only a deadlock counter shows it; this pin shows it as a red test.
 * The refund path's pre-claim check is an unlocked READ by design; the locked re-check is create()'s (`pooledRefund`, `returnId`).
 */
const cns = readFileSync(join(__dirname, "credit-notes.service.ts"), "utf8");
const lch = readFileSync(join(__dirname, "line-credit-headroom.ts"), "utf8");
const rs = readFileSync(join(__dirname, "..", "returns", "returns.service.ts"), "utf8");
const create = cns.slice(cns.search(/\n  async create\(/));

describe("B947: the order lock comes first, in create() and on the refund path", () => {
  it("create(): lockOrderPoolRows -> the Invoice row lock -> the in-tx pool read (validateAndBuildCnItems(tx))", () => {
    const orderLocks = create.indexOf("await lockOrderPoolRows(tx, dto.invoiceId, tenantId)");
    const invoiceLock = create.indexOf(
      'SELECT id FROM "Invoice" WHERE id = ${dto.invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE',
    );
    const poolRead = create.indexOf("await this.validateAndBuildCnItems(tx, dto");
    expect(orderLocks).toBeGreaterThan(-1);
    expect(orderLocks).toBeLessThan(invoiceLock);
    expect(invoiceLock).toBeLessThan(poolRead);
  });

  it("the pool read itself takes no lock, and lockOrderPoolRows locks the Order BEFORE the invoices, tenant-scoped", () => {
    const loadPool = lch.slice(
      lch.indexOf("export async function loadOrderPool("),
      lch.indexOf("export function pooledRefundRefusal"),
    );
    expect(loadPool).not.toMatch(/FOR UPDATE|\$executeRaw/);
    const lockFn = lch.slice(lch.indexOf("export async function lockOrderPoolRows("));
    expect(lockFn.indexOf('FROM "Order"')).toBeGreaterThan(-1);
    expect(lockFn.indexOf('FROM "Order"')).toBeLessThan(lockFn.indexOf('FROM "Invoice"'));
    expect(lockFn).toMatch(/orderBy: \[\{ id: "asc" \}\]/);
    expect(lockFn.match(/"tenantId" = \$\{tenantId\}/g)?.length).toBe(2);
  });

  it("the refund path hands create() the returned products AND the return id, so the re-check runs under the locks and the link is written in the mint tx", () => {
    expect(rs).toMatch(/pooledRefund, returnId: id/);
    // N7: the in-tx Return link sits inside the tenantTransaction, after the insert, before the return
    const tx = create.slice(create.indexOf("await this.prisma.tenantTransaction("));
    const insert = tx.indexOf("await this.insertCreditNoteInTx(");
    const link = tx.indexOf("tx.return.updateMany(");
    const ret = tx.indexOf("return created;");
    expect(insert).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(insert);
    expect(ret).toBeGreaterThan(link);
    expect(tx.slice(link, link + 200)).toMatch(/creditNoteId: null/);
  });

  it("the pooled refund re-check runs in the SAME validate as the lock-protected read, before the early return for lump sums", () => {
    const validate = cns.slice(cns.indexOf("async validateAndBuildCnItems("));
    const refundCheck = validate.indexOf("pooledRefundRefusal(pool");
    const earlyReturn = validate.indexOf("if (!lineItems) {");
    expect(refundCheck).toBeGreaterThan(-1);
    expect(refundCheck).toBeLessThan(earlyReturn);
  });
});
