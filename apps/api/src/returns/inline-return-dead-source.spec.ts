import { readFileSync } from "fs";
import { join } from "path";
import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { assertInlineSourcesOpen } from "./inline-return-refund";

/**
 * SA-1091 piece 3: the dead-source refusal. The helper on a fake client (the real-Postgres rows DS-1..DS-3 are in
 * inline-return-dead-source-sa1091.db.spec.ts), and a pin that both mints reach it before they write anything.
 */
type Row = Record<string, unknown>;

function fakeTx(state: { lines: Row[]; invoices: Row[] }) {
  const locks: unknown[][] = [];
  const tx = {
    $executeRaw: jest.fn(async (...args: unknown[]) => {
      locks.push(args);
      return 1;
    }),
    invoiceItem: { findMany: jest.fn(async () => state.lines) },
    invoice: {
      findFirst: jest.fn(async (arg: { where: { id: { in: string[] } } }) => {
        const dead = state.invoices
          .filter((i) => arg.where.id.in.includes(i.id as string))
          .filter((i) => i.status === "VOID" || i.status === "WRITTEN_OFF")
          .sort((a, b) => String(a.id).localeCompare(String(b.id)));
        return dead[0] ? { id: dead[0].id } : null;
      }),
    },
  };
  return { tx, locks };
}

describe("SA-1091 assertInlineSourcesOpen", () => {
  it("DS-1/DS-3: a voided or written-off source is a 409 RETURN_NOTHING_BILLED that names the invoice", async () => {
    for (const status of ["VOID", "WRITTEN_OFF"]) {
      const { tx } = fakeTx({
        lines: [{ id: "l1", invoiceId: "inv-9" }],
        invoices: [{ id: "inv-9", status }],
      });
      const err = await assertInlineSourcesOpen(tx, "t1", [{ sourceInvoiceItemId: "l1" }]).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: API_ERROR_CODES.RETURN_NOTHING_BILLED,
        invoiceId: "inv-9",
      });
    }
  });

  it("DS-3: per source — one dead among live sources refuses, naming the dead one (the first by id when two are)", async () => {
    const { tx } = fakeTx({
      lines: [
        { id: "l1", invoiceId: "inv-a" },
        { id: "l2", invoiceId: "inv-c" },
        { id: "l3", invoiceId: "inv-b" },
      ],
      invoices: [
        { id: "inv-a", status: "PAID" },
        { id: "inv-b", status: "VOID" },
        { id: "inv-c", status: "WRITTEN_OFF" },
      ],
    });
    const err = await assertInlineSourcesOpen(tx, "t1", [
      { sourceInvoiceItemId: "l1" },
      { sourceInvoiceItemId: "l2" },
      { sourceInvoiceItemId: "l3" },
    ]).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ invoiceId: "inv-b" });
  });

  it("live sources pass, and the source invoices are locked first (id-sorted, one statement)", async () => {
    const { tx, locks } = fakeTx({
      lines: [
        { id: "l1", invoiceId: "inv-b" },
        { id: "l2", invoiceId: "inv-a" },
      ],
      invoices: [
        { id: "inv-a", status: "PAID" },
        { id: "inv-b", status: "SENT" },
      ],
    });
    await expect(
      assertInlineSourcesOpen(tx, "t1", [
        { sourceInvoiceItemId: "l1" },
        { sourceInvoiceItemId: "l2" },
      ]),
    ).resolves.toBeUndefined();
    expect(locks).toHaveLength(1);
    expect(String((locks[0][0] as string[]).join("?"))).toContain('FROM "Invoice"');
  });

  it("DS-3: an unreferenced return (no source line) is not asked and takes no lock", async () => {
    const { tx, locks } = fakeTx({ lines: [], invoices: [] });
    await expect(
      assertInlineSourcesOpen(tx, "t1", [{ sourceInvoiceItemId: null }, {}]),
    ).resolves.toBeUndefined();
    expect(locks).toHaveLength(0);
    expect(tx.invoice.findFirst).not.toHaveBeenCalled();
  });
});

describe("SA-1091 piece 3: both mints refuse a dead source before they write", () => {
  const src = readFileSync(join(__dirname, "inline-returns.service.ts"), "utf8");
  const bodyOf = (decl: string, until: string) => {
    const start = src.indexOf(decl);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf(until, start));
  };

  it("approve() asks after the order locks and before the restock, the reversal and the mint", () => {
    const body = bodyOf("async approve(id: string", "SA-727: resolves a captured inline return");
    const ask = body.indexOf("assertInlineSourcesOpen(");
    expect(ask).toBeGreaterThan(body.indexOf("await lockOrderRows("));
    expect(ask).toBeLessThan(body.indexOf("await restockReturnItems("));
    expect(ask).toBeLessThan(body.indexOf("await this.reverseLedgerForReturn("));
    expect(ask).toBeLessThan(body.indexOf("await this.issueCreditInTx("));
  });

  it("the stuck-row re-issue asks after the order lock and before the mint", () => {
    const body = bodyOf("private async issueCredit(returnId: string)", "N-5/Q-C: approves");
    const ask = body.indexOf("assertInlineSourcesOpen(");
    expect(ask).toBeGreaterThan(body.indexOf("await lockOrderRow("));
    expect(ask).toBeLessThan(body.indexOf("await this.issueCreditInTx("));
  });
});
