import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { BulkStateDto, BulkStateUndoDto } from "./dto/bulk-state.dto";
import { UnknownStateBulkService } from "./unknown-state-bulk.service";
import { UnknownStateCustomersQueryDto } from "./dto/unknown-state-customers-query.dto";
import { UnknownStateCustomersService } from "./unknown-state-customers.service";

// The "Customers without a state on file" card (Addendum D). OPERATOR and TENANT_ADMIN (TENANT_ADMIN
// satisfies OPERATOR in RolesGuard; owner 10-07: operators are near-admins). CUSTOMER, DRIVER and buyer
// tokens get 403. The two bulk writes are staff-JWT writes, so the global TenantStatusGuard refuses them
// in a read-only workspace (no read-only allow-list entry).
@ApiTags("settings")
@ApiBearerAuth()
@Controller("settings/restrictions/unknown-state-customers")
@UseGuards(JwtAuthGuard, RolesGuard)
export class UnknownStateCustomersController {
  constructor(
    private readonly unknownState: UnknownStateCustomersService,
    private readonly bulk: UnknownStateBulkService,
  ) {}

  @Get()
  @Roles(UserRole.OPERATOR)
  @ApiOperation({
    summary:
      "Customers whose state can't be resolved, in four buckets (no address, unusable state, needs a state check, needs a default), keyset-paged per bucket",
  })
  list(@Query() query: UnknownStateCustomersQueryDto) {
    return this.unknownState.list(query);
  }

  @Post("bulk-state")
  @Roles(UserRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Set one state for up to 200 customers of one bucket in one transaction (audited once); customers no longer in the bucket are skipped",
  })
  @ApiBody({ type: BulkStateDto })
  bulkSet(@Body() dto: BulkStateDto, @CurrentUser() user: JwtPayload) {
    return this.bulk.bulkSet(dto, user);
  }

  @Post("bulk-state/undo")
  @Roles(UserRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Undo a bulk state change within 10 minutes: restores prior states, removes only the addresses it created (untouched ones); a repeat restores 0; 409 after the window",
  })
  @ApiBody({ type: BulkStateUndoDto })
  undo(@Body() dto: BulkStateUndoDto, @CurrentUser() user: JwtPayload) {
    return this.bulk.undo(dto, user);
  }
}
