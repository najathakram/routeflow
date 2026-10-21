import { NotFoundException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * Ids a caller supplies on a write must resolve inside the caller's own tenant before they are stored
 * (R5-5). Every lookup but the expense category goes through `forTenant()`, so "resolves" means "resolves
 * inside the caller's tenant". An expense category is also valid when it is a GLOBAL one
 * (`ExpenseCategory.tenantId` is nullable: shared categories are legitimate), so it is accepted when its
 * tenant is the caller's OR null, and refused when it belongs to another business.
 * Empty / absent values are the caller's "none" and are left alone.
 */
export interface TenantRefs {
  expenseCategoryIds?: ReadonlyArray<string | null | undefined>;
  supplierIds?: ReadonlyArray<string | null | undefined>;
  customerIds?: ReadonlyArray<string | null | undefined>;
  productIds?: ReadonlyArray<string | null | undefined>;
}

const present = (ids: ReadonlyArray<string | null | undefined> | undefined): string[] => [
  ...new Set((ids ?? []).filter((v): v is string => !!v)),
];

export async function assertRefsInTenant(prisma: PrismaService, refs: TenantRefs): Promise<void> {
  const categoryIds = present(refs.expenseCategoryIds);
  if (categoryIds.length > 0) {
    const tenantId = prisma.getTenantId();
    const found = await prisma.expenseCategory.findMany({
      where: { id: { in: categoryIds }, OR: [{ tenantId: tenantId ?? null }, { tenantId: null }] },
      select: { id: true },
    });
    if ((found ?? []).length !== categoryIds.length) {
      throw new NotFoundException("Expense category not found");
    }
  }
  const checks: Array<[string[], string, (ids: string[]) => Promise<unknown[]>]> = [
    [
      present(refs.supplierIds),
      "Supplier not found",
      (ids) =>
        prisma.forTenant().supplier.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    ],
    [
      present(refs.customerIds),
      "Customer not found",
      (ids) =>
        prisma.forTenant().customer.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    ],
    [
      present(refs.productIds),
      "Product not found",
      (ids) =>
        prisma.forTenant().product.findMany({ where: { id: { in: ids } }, select: { id: true } }),
    ],
  ];
  for (const [ids, message, find] of checks) {
    if (ids.length === 0) continue;
    const found = await find(ids);
    if ((found ?? []).length !== ids.length) throw new NotFoundException(message);
  }
}
