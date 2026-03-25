import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { AnalyticsService } from "./analytics.service";

@Controller("analytics")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get("revenue")
  getRevenue(@Query("from") from?: string, @Query("to") to?: string, @Query("groupBy") g?: string) {
    return this.analyticsService.getRevenueTrend(from, to, g);
  }

  @Get("products/top")
  getTopProducts(@Query("metric") metric?: string, @Query("limit") limit?: string) {
    return this.analyticsService.getTopProducts(metric, limit ? parseInt(limit) : 10);
  }

  @Get("customers/top")
  getTopCustomers(@Query("metric") metric?: string, @Query("limit") limit?: string) {
    return this.analyticsService.getTopCustomers(metric, limit ? parseInt(limit) : 10);
  }

  @Get("routes/performance")
  getRoutes() { return this.analyticsService.getRoutePerformance(); }

  @Get("drivers/performance")
  getDrivers() { return this.analyticsService.getDriverPerformance(); }

  @Get("inventory/turnover")
  getTurnover(@Query("from") from?: string, @Query("to") to?: string) {
    return this.analyticsService.getInventoryTurnover(from, to);
  }

  @Get("inventory/dead-stock")
  getDeadStock(@Query("daysInactive") days?: string) {
    return this.analyticsService.getDeadStock(days ? parseInt(days) : 30);
  }

  @Get("inventory/margin-alerts")
  getMarginAlerts() { return this.analyticsService.getMarginAlerts(); }

  @Get("dso")
  getDso() { return this.analyticsService.getDso(); }

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
}
