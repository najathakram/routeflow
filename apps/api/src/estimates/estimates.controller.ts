import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";
import { EstimatesService } from "./estimates.service";
import { CreateEstimateDto } from "./dto/create-estimate.dto";

// WP5a (R3b.3, R3b.5): flag.estimates ships dark (DARK_PLAN_FLAGS in
// plan-flag-policy.ts) — this class-level guard is a courtesy allow until the
// PLAN_FLAG_ENFORCEMENT switch flips on.
@Controller("estimates")
@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)
@Roles(UserRole.OPERATOR)
@RequirePlanFlag("flag.estimates")
export class EstimatesController {
  constructor(private readonly estimatesService: EstimatesService) {}

  @Post() create(@Body() dto: CreateEstimateDto) {
    return this.estimatesService.create(dto);
  }
  @Get() findAll(
    @Query("customerId") cId?: string,
    @Query("status") status?: string,
    @Query("search") search?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.estimatesService.findAll(
      cId,
      status,
      search,
      dateFrom,
      dateTo,
      page ? +page : 1,
      limit ? +limit : 20,
    );
  }
  @Get(":id") findOne(@Param("id") id: string) {
    return this.estimatesService.findOne(id);
  }
  @Post(":id/send") send(@Param("id") id: string) {
    return this.estimatesService.send(id);
  }
  @Post(":id/accept") accept(@Param("id") id: string) {
    return this.estimatesService.accept(id);
  }
  @Post(":id/decline") decline(@Param("id") id: string) {
    return this.estimatesService.decline(id);
  }
  @Post(":id/convert-to-invoice") convertToInvoice(@Param("id") id: string) {
    return this.estimatesService.convertToInvoice(id);
  }
  @Post(":id/convert") convert(@Param("id") id: string) {
    return this.estimatesService.convertToInvoice(id);
  }

  @Post(":id/void") void(@Param("id") id: string) {
    return this.estimatesService.voidEstimate(id);
  }
}
