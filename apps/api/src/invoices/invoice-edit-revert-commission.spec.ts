/**
 * B1372 K5a (SA-1177): like the manual revert (`revertToDraft`, which re-syncs inside its tx), an order edit's revert
 * re-syncs the commission of each invoice it turns back into a DRAFT (a DRAFT targets zero), on the caller's db, so a
 * sales agent never keeps the pre-edit commission. The read-only preflight writes nothing, so it syncs nothing.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: jest.fn() }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("./invoice-display-unit", () => ({
  ...jest.requireActual("./invoice-display-unit"),
  clearIssueDisplayUnits: jest.fn(async () => undefined),
}));
import { InvoicesService } from "./invoices.service";

function db(sent: string[]) {
  return {
    invoice: {
      // the SENT selection; the money-holding (blocking) read asks with `OR` and finds none
      findMany: jest.fn(async (args: any) =>
        args?.where?.OR
          ? []
          : sent.map((id) => ({ id, invoiceNumber: `INV-${id}`, internalNotes: null })),
      ),
      count: jest.fn(async () => 1),
      update: jest.fn(async () => ({})),
    },
    order: { findFirst: jest.fn(async () => ({ status: "CONFIRMED" })) },
  };
}

function service(d: ReturnType<typeof db>) {
  const sync = jest.fn(async () => undefined);
  const svc = Object.assign(Object.create(InvoicesService.prototype), {
    prisma: { forTenant: () => d },
    commissionEngine: { syncInvoiceCommissionSafe: sync },
  }) as InvoicesService;
  return { svc, sync };
}

describe("B1372 K5a: an order edit's revert re-syncs commission", () => {
  it("re-syncs every reverted invoice, on the caller's db", async () => {
    const d = db(["a", "b"]);
    const { svc, sync } = service(d);

    expect(await svc.revertLinkedInvoicesForOrderEdit("o1", d)).toEqual(["a", "b"]);

    expect(sync.mock.calls).toEqual([
      ["a", d],
      ["b", d],
    ]);
  });

  it("the read-only preflight reverts nothing and syncs nothing", async () => {
    const d = db(["a"]);
    const { svc, sync } = service(d);

    expect(
      await svc.revertLinkedInvoicesForOrderEdit("o1", undefined, { preflightOnly: true }),
    ).toEqual([]);

    expect(d.invoice.update).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("no SENT invoice: nothing to sync", async () => {
    const d = db([]);
    const { svc, sync } = service(d);

    expect(await svc.revertLinkedInvoicesForOrderEdit("o1", d)).toEqual([]);
    expect(sync).not.toHaveBeenCalled();
  });
});
