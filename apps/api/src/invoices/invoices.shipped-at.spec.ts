import { InvoicesService } from "./invoices.service";

/**
 * W-904 / SA-1142 R4: `updateInvoiceShipment`'s SET branch never overwrites a `shippedAt` it did not read at write
 * time: the stamp is fill-only (`where shippedAt: null`), so a mirror that filled it between this method's read and
 * its write survives. The CLEAR branch keeps writing null (the stated rule: clearing the tracking clears the date).
 * A small stateful fake honours the `where` of the writes under test, so a case is red on the stored value.
 */
const T = new Date("2026-11-13T15:00:00.000Z");

type Row = Record<string, any>;
function fake(inv: Row, afterRead?: (row: Row) => void) {
  let reads = 0;
  const invoice = {
    findFirst: jest.fn(async () => {
      const snapshot = { ...inv };
      reads += 1;
      if (reads === 1) afterRead?.(inv);
      return reads === 1 ? snapshot : { ...inv };
    }),
    update: jest.fn(async (args: any) => {
      Object.assign(inv, args.data);
      return { ...inv };
    }),
    updateMany: jest.fn(async (args: any) => {
      const w = args.where;
      if (w.id !== inv.id || ("shippedAt" in w && w.shippedAt === null && inv.shippedAt != null))
        return { count: 0 };
      Object.assign(inv, args.data);
      return { count: 1 };
    }),
  };
  const self = { prisma: { forTenant: () => ({ invoice }) } };
  const save = (body: Row) =>
    InvoicesService.prototype.updateInvoiceShipment.call(self as any, "inv-1", body as any);
  return { invoice, save };
}

describe("W-904 InvoicesService.updateInvoiceShipment shippedAt", () => {
  it("9: a stamp a mirror wrote between the read and the write survives a tracking SET", async () => {
    const inv = { id: "inv-1", status: "SENT", shippedAt: null as Date | null };
    const f = fake(inv, (row) => (row.shippedAt = T));
    await f.save({ shippingCarrier: "UPS", shippingTrackingNumber: "1Z999" });
    expect(inv.shippedAt).toEqual(T);
  });

  it("SET on an unstamped invoice stamps it once", async () => {
    const inv = { id: "inv-1", status: "SENT", shippedAt: null as Date | null };
    const f = fake(inv);
    await f.save({ shippingCarrier: "UPS", shippingTrackingNumber: "1Z999" });
    expect(inv.shippedAt).toBeInstanceOf(Date);
  });

  it("SET on an already stamped invoice keeps the date", async () => {
    const inv = { id: "inv-1", status: "SENT", shippedAt: T };
    const f = fake(inv);
    await f.save({ shippingTrackingNumber: "1Z999" });
    expect(inv.shippedAt).toEqual(T);
  });

  it("10: CLEAR still clears the date (the stated rule, by design)", async () => {
    const inv = {
      id: "inv-1",
      status: "SENT",
      shippedAt: T as Date | null,
      shippingTrackingNumber: "1Z",
    };
    const f = fake(inv);
    await f.save({ shippingTrackingNumber: "" });
    expect(inv.shippedAt).toBeNull();
  });
});
