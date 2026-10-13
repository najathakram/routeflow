import { InvoicesService } from "./invoices.service";

/**
 * Row 398: the invoice detail read selects each line's category row with its tax TYPE, so a buyer page, the staff
 * preview and the mobile screen name an older line's levy ("CRV deposit") the way the PDF does. Lines billed before the
 * B297 migration have no frozen categoryTaxType, so the category's own type is the only name for them.
 */
describe("InvoicesService.findOne category select (row 398)", () => {
  it("includes taxType with the category's id, name and treatment", async () => {
    const findUnique = jest.fn().mockResolvedValue({
      id: "inv-1",
      status: "SENT",
      total: 30,
      dueDate: null,
      payments: [],
      items: [],
    });
    const service = new (InvoicesService as unknown as new (...a: unknown[]) => InvoicesService)(
      ...Array(14).fill(undefined),
    );
    Object.assign(service, {
      prisma: {
        getTenantId: () => null,
        forTenant: () => ({
          invoice: { findUnique },
          auditLog: { groupBy: jest.fn().mockResolvedValue([]) },
        }),
      },
      systemConfig: { get: jest.fn().mockResolvedValue(null) },
    });
    await service.findOne("inv-1");
    const arg = findUnique.mock.calls[0][0] as {
      include: { items: { include: { trackedCategory: { select: Record<string, boolean> } } } };
    };
    expect(arg.include.items.include.trackedCategory.select).toEqual({
      id: true,
      name: true,
      taxType: true,
      invoiceTreatment: true,
    });
  });
});
