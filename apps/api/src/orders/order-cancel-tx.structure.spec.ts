import { readdirSync, readFileSync, statSync } from "fs";
import { join, sep } from "path";

// SA-762r test 9 (structural): the cancel unwind has ONE implementation. The "CANCEL" stock event (the restock of a
// cancelled order) is written by cancelOrderInTx's caller-supplied `notes` only, and every cancel caller goes through
// cancelOrderInTx. A second cancel path would be a second restock path and would drift (a double restock is a stock lie).
const SRC = join(__dirname, "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".spec.ts") && name !== "order-stock-world.ts")
      out.push(p); // B695: that DB-spec fixture seeds a CANCEL row by hand, it is not a cancel path
  }
  return out;
}

describe("cancelOrderInTx is the only cancel/restock path (SA-762r)", () => {
  const files = sources(SRC).map((p) => ({ p, src: readFileSync(p, "utf8") }));

  it('only the two callers of cancelOrderInTx name the "CANCEL" stock event: the office cancel and the counter-sale void', () => {
    const naming = files
      .filter(({ src }) => /notes:\s*"CANCEL"/.test(src))
      .map(({ p }) =>
        p
          .slice(SRC.length + 1)
          .split(sep)
          .join("/"),
      )
      .sort();
    expect(naming).toEqual([
      "orders/counter-sale/counter-sale-void.service.ts",
      "orders/orders.service.ts",
    ]);
  });

  it("the counter-sale void restocks ONLY through cancelOrderInTx: no stock, wallet or invoice-void write of its own", () => {
    const voidSrc = readFileSync(
      join(SRC, "orders/counter-sale/counter-sale-void.service.ts"),
      "utf8",
    );
    expect(voidSrc.match(/\bthis\.orders\.cancelOrderInTx\(/g)).toHaveLength(1);
    for (const own of [
      /settleStockForEdit/,
      /decrementStockForSale|restoreStockForReopen/,
      /\.product\.update|currentStock|stockMovement/,
      /voidInvoiceInTx|releaseWalletPaymentsInTx|releaseOrderCreditsInTx/,
      /orderItem\.update/,
    ])
      expect(voidSrc).not.toMatch(own);
    // and the one payment-void writer is voidPaymentInTx (no payment status write here)
    expect(voidSrc.match(/\bthis\.invoices\.voidPaymentInTx\(/g)).toHaveLength(1);
    expect(voidSrc).not.toMatch(/invoicePayment\.(update|updateMany|delete)/);
  });

  it("the unwind body (claim, stock credit, credit + wallet release, invoice voids, line marking) lives in order-cancel-tx.ts alone", () => {
    const body = files
      .filter(({ src }) => /export async function cancelOrderInTx\(/.test(src))
      .map(({ p }) =>
        p
          .slice(SRC.length + 1)
          .split(sep)
          .join("/"),
      );
    expect(body).toEqual(["orders/order-cancel-tx.ts"]);
    const service = readFileSync(join(SRC, "orders/orders.service.ts"), "utf8");
    expect(service).not.toMatch(/releaseOrderCreditsInTx\(tx, id\)[\s\S]{0,200}voidInvoiceInTx/);
    expect(service.match(/\bthis\.cancelOrderInTx\(/g) ?? []).toHaveLength(1);
  });
});
