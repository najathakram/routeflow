import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import type { AddressStateResponse } from "@routeflow/types";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { normalizeUsState } from "../common/us-states";
import { PrismaService } from "../prisma/prisma.service";
import { addressStateFields } from "./address-state";
import { createMinimalAddresses, setChosenAddressState } from "./address-state-writes";
import { AddressStateDto, MinimalAddressDto } from "./dto/address-state.dto";
import { assertNotWalkIn } from "./walk-in-protected";

/** Audit actions of the two single-customer state fixes. */
export const AUDIT_ADDRESS_STATE_SET = "customer_address.state_set";
export const AUDIT_MINIMAL_ADDRESS_CREATED = "customer_address.minimal_created";

const ZIP = /^\d{5}(?:-\d{4})?$/;

/** A state as a USPS code, or the 400 every state-fix route answers. */
export function chosenStateOr400(state: string): string {
  const code = normalizeUsState(state);
  if (!code) throw new BadRequestException(`"${state}" is not a recognised US state.`);
  return code;
}

/**
 * Fix a customer's state in place (Addendum D): set the state on one existing address, or give a
 * customer with no address a minimal default billing address. Writes go through the shared
 * `address-state-writes.ts` writers; each request is ONE transaction with ONE audit row written
 * inside it (a failed audit rolls the fix back). Every read and write is tenant-scoped: a customer or
 * address of another tenant (or another customer's address) is a 404.
 */
@Injectable()
export class CustomerAddressStateService {
  constructor(private readonly prisma: PrismaService) {}

  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }

  /** PATCH /customers/:id/addresses/:addressId/state. Confirms the address: a code, review flag cleared. */
  async setState(
    customerId: string,
    addressId: string,
    dto: AddressStateDto,
    user: JwtPayload,
  ): Promise<AddressStateResponse> {
    const tenantId = this.requireTenant();
    const code = chosenStateOr400(dto.state);
    return this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
      const customer = await tx.customer.findFirst({
        where: { tenantId, id: customerId, deletedAt: null },
        select: { id: true },
      });
      if (!customer) throw new NotFoundException("Customer not found");
      const before = await tx.customerAddress.findFirst({
        where: { tenantId, id: addressId, customerId },
        select: { state: true, stateCode: true, stateNeedsReview: true },
      });
      if (!before) throw new NotFoundException("Address not found");
      const count = await setChosenAddressState(tx, tenantId, [addressId], code, customerId);
      if (count !== 1) throw new NotFoundException("Address not found");
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: user.sub,
          impersonatedBy: user.impersonatedBy ?? null,
          action: AUDIT_ADDRESS_STATE_SET,
          entityType: "CustomerAddress",
          entityId: addressId,
          meta: {
            customerId,
            from: before,
            to: { state: code },
            confirmReview: !!dto.confirmReview,
          },
        },
      });
      return { customerId, addressId, state: code };
    });
  }

  /**
   * POST /customers/:id/addresses/minimal. Only for a customer with NO address (409 otherwise: set the
   * state on the address it has). A ZIP must be a 5-digit ZIP / ZIP+4 inside the chosen state (400).
   */
  async addMinimal(
    customerId: string,
    dto: MinimalAddressDto,
    user: JwtPayload,
  ): Promise<AddressStateResponse> {
    const tenantId = this.requireTenant();
    const code = chosenStateOr400(dto.state);
    const zip = dto.zip?.trim() ? dto.zip.trim() : null;
    if (zip !== null && !ZIP.test(zip)) {
      throw new BadRequestException("Enter a 5-digit ZIP code, or leave it blank.");
    }
    if (zip !== null && addressStateFields(code, zip).stateCode !== code) {
      throw new BadRequestException(`ZIP ${zip} is not in ${code}. Check the state or the ZIP.`);
    }
    return this.prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
      // The nested count is not tenant-rewritten, so a legacy address row with a NULL tenantId counts too.
      const customer = await tx.customer.findFirst({
        where: { tenantId, id: customerId, deletedAt: null },
        select: { id: true, isWalkIn: true, _count: { select: { addresses: true } } },
      });
      if (!customer) throw new NotFoundException("Customer not found");
      assertNotWalkIn(customer);
      if (customer._count.addresses > 0) {
        throw new ConflictException(
          "This customer already has an address. Set the state on that address instead.",
        );
      }
      const addressId = randomUUID();
      await createMinimalAddresses(tx, tenantId, [{ id: addressId, customerId, zip }], code);
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: user.sub,
          impersonatedBy: user.impersonatedBy ?? null,
          action: AUDIT_MINIMAL_ADDRESS_CREATED,
          entityType: "CustomerAddress",
          entityId: addressId,
          meta: { customerId, state: code, zip },
        },
      });
      return { customerId, addressId, state: code };
    });
  }
}
