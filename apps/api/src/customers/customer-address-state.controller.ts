import { Body, Controller, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { CustomerAddressStateService } from "./customer-address-state.service";
import { AddressStateDto, MinimalAddressDto } from "./dto/address-state.dto";

// Fix a customer's state in place (Addendum D). OPERATOR and TENANT_ADMIN (TENANT_ADMIN satisfies
// OPERATOR in RolesGuard); CUSTOMER, DRIVER and buyer tokens get 403. Staff-JWT writes, so the global
// TenantStatusGuard refuses them in a read-only workspace (no read-only allow-list entry).
@ApiTags("customers")
@ApiBearerAuth()
@Controller("customers")
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomerAddressStateController {
  constructor(private readonly addressState: CustomerAddressStateService) {}

  @Patch(":id/addresses/:addressId/state")
  @Roles(UserRole.OPERATOR)
  @ApiOperation({
    summary:
      "Set the state on one of the customer's addresses (audited); confirmReview marks a read state as checked",
  })
  @ApiBody({ type: AddressStateDto })
  setState(
    @Param("id") id: string,
    @Param("addressId") addressId: string,
    @Body() dto: AddressStateDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.addressState.setState(id, addressId, dto, user);
  }

  @Post(":id/addresses/minimal")
  @Roles(UserRole.OPERATOR)
  @ApiOperation({
    summary:
      "Give a customer with no address a default billing address with only a state (and ZIP); 409 if it has one (audited)",
  })
  @ApiBody({ type: MinimalAddressDto })
  addMinimal(
    @Param("id") id: string,
    @Body() dto: MinimalAddressDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.addressState.addMinimal(id, dto, user);
  }
}
