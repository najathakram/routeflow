import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

/** PATCH /customers/:id/addresses/:addressId/state (wire shape `AddressStateRequest`). */
export class AddressStateDto {
  /** A USPS code or full state name; stored as the 2-letter code (400 when it is not one). */
  @IsString() @MaxLength(40) state: string;

  /** True = the staff member confirms the state the system read from the address text. */
  @IsOptional() @IsBoolean() confirmReview?: boolean;
}

/** POST /customers/:id/addresses/minimal (wire shape `MinimalAddressRequest`). */
export class MinimalAddressDto {
  @IsString() @MaxLength(40) state: string;

  /** 5-digit ZIP or ZIP+4; must lie in `state` when given. */
  @IsOptional() @IsString() @MaxLength(12) zip?: string;
}
