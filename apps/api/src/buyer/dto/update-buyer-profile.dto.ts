import { PickType } from "@nestjs/mapped-types";
import { UpdateCustomerDto } from "../../customers/dto/update-customer.dto";
import { SELF_SERVICE_FIELDS } from "../../customers/self-service-fields";

/**
 * SECURITY (F4-001, SA-653): a customer may edit ONLY their own contact and preference fields. This body type
 * is DERIVED from the staff UpdateCustomerDto with the ONE allowlist (customers/self-service-fields.ts) that
 * also drives pickSelfServiceFields, so every field carries the staff DTO's own validators and the type cannot
 * drift from the list. The seller-controlled commercial fields (price tier, credit limit, tax status, terms,
 * ...) and the staff-internal `notes` are not in it, so the global ValidationPipe (whitelist +
 * forbidNonWhitelisted) refuses them with a 400.
 */
export class UpdateBuyerProfileDto extends PickType(UpdateCustomerDto, SELF_SERVICE_FIELDS) {}
