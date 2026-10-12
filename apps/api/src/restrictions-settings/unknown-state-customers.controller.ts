import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { UnknownStateCustomersQueryDto } from "./dto/unknown-state-customers-query.dto";
import { UnknownStateCustomersService } from "./unknown-state-customers.service";

// The "Customers without a state on file" card (Addendum D). OPERATOR and TENANT_ADMIN (TENANT_ADMIN
// satisfies OPERATOR in RolesGuard; owner 10-07: operators are near-admins). CUSTOMER, DRIVER and buyer
// tokens get 403.
@ApiTags("settings")
@ApiBearerAuth()
@Controller("settings/restrictions/unknown-state-customers")
@UseGuards(JwtAuthGuard, RolesGuard)
export class UnknownStateCustomersController {
  constructor(private readonly unknownState: UnknownStateCustomersService) {}

  @Get()
  @Roles(UserRole.OPERATOR)
  @ApiOperation({
    summary:
      "Customers whose state can't be resolved, in three buckets (no address, unusable state, needs a state check), keyset-paged per bucket",
  })
  list(@Query() query: UnknownStateCustomersQueryDto) {
    return this.unknownState.list(query);
  }
}
