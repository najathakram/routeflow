import { Body, Controller, Param, Patch, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { ProductPortalVisibilityService } from "./product-portal-visibility.service";
import { BulkSetPortalVisibilityDto, SetPortalVisibilityDto } from "./dto/portal-visibility.dto";

/**
 * Must be registered BEFORE ProductsController in ProductsModule: the bulk route
 * `PATCH products/portal-visibility` would otherwise be captured by `PATCH products/:id`.
 */
@Controller("products")
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProductPortalVisibilityController {
  constructor(private readonly service: ProductPortalVisibilityService) {}

  @Patch("portal-visibility")
  @Roles(UserRole.TENANT_ADMIN)
  setBulk(@Body() dto: BulkSetPortalVisibilityDto, @CurrentUser() user: JwtPayload) {
    return this.service.setBulk(dto.ids, dto.portalVisible, user.sub ?? null);
  }

  @Patch(":id/portal-visibility")
  @Roles(UserRole.TENANT_ADMIN)
  setOne(
    @Param("id") id: string,
    @Body() dto: SetPortalVisibilityDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.setOne(id, dto.portalVisible, user.sub ?? null);
  }
}
