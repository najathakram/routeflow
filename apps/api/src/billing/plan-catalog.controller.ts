import { Controller, Get } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { PlanCatalogService } from "./plan-catalog.service";

/**
 * Public read of the published plan catalog — consumed by the marketing pricing
 * page and the in-app choose-plan chooser. No auth: pricing is public. Decimal
 * prices serialize as strings.
 */
@ApiTags("billing")
@Controller("billing")
export class PlanCatalogController {
  constructor(private readonly catalog: PlanCatalogService) {}

  @Get("plans")
  @ApiOperation({ summary: "The current published plan catalog (plans + add-on SKUs)" })
  getPlans() {
    // Public projection only — no internal ids / publishedBy / notes / timestamps.
    return this.catalog.getPublicCatalog();
  }
}
