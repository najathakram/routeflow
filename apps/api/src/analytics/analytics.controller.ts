import { BadRequestException, Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { AnalyticsService } from "./analytics.service";
import { DEMAND_RANGES, isDemandRange } from "./demand-range";

@Controller("analytics")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get()
  getIndex() {
    // RF-222: root endpoint so GET /analytics returns a helpful summary instead of 404.
    return {
      endpoints: [
        "GET /analytics/revenue",
        "GET /analytics/products/top",
        "GET /analytics/customers/top",
        "GET /analytics/routes/performance",
        "GET /analytics/drivers/performance",
        "GET /analytics/inventory/turnover",
        "GET /analytics/inventory/dead-stock",
        "GET /analytics/inventory/margin-alerts",
        "GET /analytics/dso",
        "GET /analytics/sales-by-category",
        "GET /analytics/gross-margin",
        "GET /analytics/aov",
        "GET /analytics/price-history/:productId",
        "GET /analytics/cost-history/:productId",
        "GET /analytics/demand/:productId",
      ],
    };
  }

  @Get("revenue")
  getRevenue(@Query("from") from?: string, @Query("to") to?: string, @Query("groupBy") g?: string) {
    return this.analyticsService.getRevenueTrend(from, to, g);
  }

  @Get("products/top")
  getTopProducts(
    @Query("metric") metric?: string,
    @Query("limit") limit?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.analyticsService.getTopProducts(metric, limit ? parseInt(limit) : 10, from, to);
  }

  @Get("customers/top")
  getTopCustomers(
    @Query("metric") metric?: string,
    @Query("limit") limit?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.analyticsService.getTopCustomers(metric, limit ? parseInt(limit) : 10, from, to);
  }

  @Get("routes/performance")
  getRoutes() {
    return this.analyticsService.getRoutePerformance();
  }

  @Get("drivers/performance")
  getDrivers() {
    return this.analyticsService.getDriverPerformance();
  }

  @Get("inventory/turnover")
  getTurnover(@Query("from") from?: string, @Query("to") to?: string) {
    return this.analyticsService.getInventoryTurnover(from, to);
  }

  @Get("inventory/dead-stock")
  getDeadStock(@Query("daysInactive") days?: string) {
    return this.analyticsService.getDeadStock(days ? parseInt(days) : 30);
  }

  @Get("inventory/margin-alerts")
  getMarginAlerts() {
    return this.analyticsService.getMarginAlerts();
  }

  @Get("dso")
  getDso() {
    return this.analyticsService.getDso();
  }

  @Get("sales-by-category")
  getSalesByCategory(@Query("from") from?: string, @Query("to") to?: string) {
    return this.analyticsService.getSalesByCategory(from, to);
  }

  @Get("gross-margin")
  getGrossMargin(@Query("from") from?: string, @Query("to") to?: string) {
    return this.analyticsService.getGrossMarginTrend(from, to);
  }

  @Get("aov")
  getAov(@Query("from") from?: string, @Query("to") to?: string) {
    return this.analyticsService.getAverageOrderValue(from, to);
  }

  @Get("price-history/:productId")
  getPriceHistory(@Param("productId") id: string) {
    return this.analyticsService.getPriceHistory(id);
  }

  @Get("cost-history/:productId")
  getCostHistory(@Param("productId") id: string) {
    return this.analyticsService.getCostHistory(id);
  }

  @Get("demand/:productId")
  getProductDemand(@Param("productId") id: string, @Query("range") range?: string) {
    // An empty `?range=` is treated as absent, matching how the other params here read
    // (`limit ? parseInt(limit) : 10`). Only a non-empty unrecognised value is an error.
    const r = (range?.trim() || "30d").toLowerCase();
    // Reject rather than silently defaulting (as getRevenueTrend's groupBy does): an
    // unrecognised range would return a 30-day chart LABELLED 6 months, and this is a
    // surface operators read to make reorder decisions.
    if (!isDemandRange(r)) {
      throw new BadRequestException(`range must be one of: ${DEMAND_RANGES.join(", ")}`);
    }
    return this.analyticsService.getProductDemand(id, r);
  }
}
