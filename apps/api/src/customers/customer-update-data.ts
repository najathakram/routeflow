import { UpdateCustomerDto } from "./dto/update-customer.dto";

/**
 * dto -> Prisma `data` mapping for `CustomersService.update()`, extracted verbatim to keep
 * customers.service.ts under its size ratchet.
 */
export function customerUpdateData(dto: UpdateCustomerDto) {
  return {
    ...(dto.businessName && { businessName: dto.businessName }),
    ...(dto.contactName && { contactName: dto.contactName }),
    ...(dto.phone !== undefined && { phone: dto.phone }),
    ...(dto.notes !== undefined && { notes: dto.notes }),
    ...(dto.fulfillPath && { fulfillPath: dto.fulfillPath }),
    ...(dto.deliveryWindowStart !== undefined && {
      deliveryWindowStart: dto.deliveryWindowStart || null,
    }),
    ...(dto.deliveryWindowEnd !== undefined && {
      deliveryWindowEnd: dto.deliveryWindowEnd || null,
    }),
    ...(dto.email !== undefined && { email: dto.email }),
    ...(dto.mobile !== undefined && { mobile: dto.mobile }),
    ...(dto.customerType !== undefined && { customerType: dto.customerType }),
    ...(dto.displayName !== undefined && { displayName: dto.displayName }),
    ...(dto.salutation !== undefined && { salutation: dto.salutation }),
    ...(dto.firstName !== undefined && { firstName: dto.firstName }),
    ...(dto.lastName !== undefined && { lastName: dto.lastName }),
    ...(dto.taxId !== undefined && { taxId: dto.taxId }),
    ...(dto.isTaxExempt !== undefined && { isTaxExempt: dto.isTaxExempt }),
    ...(dto.creditLimit !== undefined && { creditLimit: dto.creditLimit }),
    ...(dto.currency !== undefined && { currency: dto.currency }),
    ...(dto.pricingTier !== undefined && { pricingTier: dto.pricingTier }),
    // "" clears to null ("use the tenant default"); a real label is stored verbatim.
    ...(dto.defaultPaymentTerms !== undefined && {
      defaultPaymentTerms: dto.defaultPaymentTerms || null,
    }),
    // SA-827: staff-only customer-wide invoice unit; absent leaves it unchanged.
    ...(dto.invoiceUnitDefault !== undefined && { invoiceUnitDefault: dto.invoiceUnitDefault }),
    // null clears the deposit default; a number sets/replaces it.
    ...(dto.defaultDepositPercent !== undefined && {
      defaultDepositPercent: dto.defaultDepositPercent,
    }),
    ...(dto.orderStatusEmails !== undefined && {
      orderStatusEmails: dto.orderStatusEmails,
    }),
  };
}
