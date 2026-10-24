import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import type { OrderSuggestionsResponse } from "@routeflow/types";
import { Roles } from "../auth/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { CustomerOrderSuggestionsService } from "./customer-order-suggestions.service";

/**
 * "Usually buys" + "Order again" for the staff New Order builder. Staff only: OPERATOR admits
 * OPERATOR and TENANT_ADMIN through the RolesGuard hierarchy; a DRIVER or CUSTOMER gets 403.
 * Kept apart from CustomersController so that controller's constructor is untouched.
 */
@ApiTags("customers")
@ApiBearerAuth()
@Controller("customers")
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomerOrderSuggestionsController {
  constructor(private readonly suggestions: CustomerOrderSuggestionsService) {}

  @Get(":customerId/order-suggestions")
  @Roles(UserRole.OPERATOR)
  getSuggestions(@Param("customerId") customerId: string): Promise<OrderSuggestionsResponse> {
    return this.suggestions.getSuggestions(customerId);
  }
}
