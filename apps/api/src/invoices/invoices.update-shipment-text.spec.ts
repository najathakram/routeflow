import { InvoicesService } from "./invoices.service";

/**
 * Row 507 (must): the invoice EDIT (`update`) carries the same change-only carrier / tracking formula guard as
 * the shipment PATCH, against the stored row it already loads. The edit does not persist these two fields
 * today (headerData omits them), so this is defence in depth: a new "=..." typed on an edit is a coded 400, an
 * echoed legacy value or a move to a clean value is not.
 */
describe("InvoicesService.update: carrier / tracking text is change-only", () => {
  const stored = { shippingCarrier: "=x", shippingTrackingNumber: "=y" };
  const update = jest.fn();
  const mk = (row: object) => ({
    findOneOrThrow: jest.fn().mockResolvedValue({
      id: "inv-1",
      status: "DRAFT",
      orderId: null,
      ...row,
    }),
    assertOrderInvoiceUnlocked: jest.fn().mockResolvedValue(undefined),
    prisma: { forTenant: () => ({ invoice: { update } }), getTenantId: () => "t-1" },
  });
  const edit = (row: object, dto: object) =>
    InvoicesService.prototype.update.call(mk(row) as any, "inv-1", dto as any);

  beforeEach(() => {
    jest.resetAllMocks();
    update.mockResolvedValue({ id: "inv-1" });
  });

  it.each([
    ["shippingTrackingNumber", "=cmd"],
    ["shippingCarrier", "@SUM(1)"],
  ])(
    "a NEW formula-led %s %j is a coded 400 naming the field, nothing written",
    async (field, value) => {
      await expect(edit({}, { [field]: value })).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({ code: "TEXT_CELL_FORMULA_LEAD", field }),
      });
      expect(update).not.toHaveBeenCalled();
    },
  );

  it("changing a stored formula-led value to ANOTHER formula-led one is refused", async () => {
    await expect(edit(stored, { shippingCarrier: "=new" })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "TEXT_CELL_FORMULA_LEAD",
        field: "shippingCarrier",
      }),
    });
  });

  it("echoing the stored legacy pair is accepted (200 path: the update runs)", async () => {
    await edit(stored, { ...stored, notes: "n" });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("changing a stored legacy '=x' to a clean value is accepted", async () => {
    await edit(stored, { shippingCarrier: "UPS", shippingTrackingNumber: "1Z999" });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("an edit that sends neither field is untouched by the guard", async () => {
    await edit(stored, { notes: "n" });
    expect(update).toHaveBeenCalledTimes(1);
  });
});
