import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Param,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { Response } from "express";
import type { ProductInsightsResponse, ProductSalesPage } from "@routeflow/types";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";
import { InsightWindowError } from "../analytics/demand-range";
import { InvalidLineCursorError } from "./sales-facts.rules";
import { ProductInsightsService } from "./product-insights.service";
import {
  ProductInsightsCsvQueryDto,
  ProductInsightsQueryDto,
  ProductSalesQueryDto,
} from "./dto/product-insights-query.dto";

/** A refused window or a forged cursor is the caller's mistake: 400, never 500. */
function asHttp(err: unknown): unknown {
  if (err instanceof InsightWindowError || err instanceof InvalidLineCursorError) {
    return new BadRequestException(err.message);
  }
  return err;
}

/** Resolves when the socket can take more, or when it closed (a `drain` that never comes). */
function drainedOrClosed(res: Response): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

/**
 * #2118 (plan §B) — per-product sales facts on the accrual-net basis. Same gate as every other
 * `/analytics/*` route (plan A8): the guard trio, OPERATOR (TENANT_ADMIN satisfies it through
 * `ROLE_SATISFIES`) and the dark `flag.analytics`; no buyer access.
 */
@Controller("analytics/products")
@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)
@Roles(UserRole.OPERATOR)
@RequirePlanFlag("flag.analytics")
export class ProductInsightsController {
  private readonly logger = new Logger(ProductInsightsController.name);

  constructor(private readonly insights: ProductInsightsService) {}

  /** Totals, price facts, a zero-filled series and the buyers for one window. */
  @Get(":id/insights")
  async getInsights(
    @Param("id") id: string,
    @Query() query: ProductInsightsQueryDto,
  ): Promise<ProductInsightsResponse> {
    try {
      return await this.insights.getProductInsights(id, query);
    } catch (err) {
      throw asHttp(err);
    }
  }

  /** The window's sold lines, newest first, paged by LINE with an opaque cursor. */
  @Get(":id/sales")
  async getSales(
    @Param("id") id: string,
    @Query() query: ProductSalesQueryDto,
  ): Promise<ProductSalesPage> {
    try {
      return await this.insights.getProductSalesPage(id, query);
    } catch (err) {
      throw asHttp(err);
    }
  }

  /**
   * The window's lines as CSV, streamed (at most `INSIGHT_CSV_MAX_LINES` rows, then a
   * truncation row), followed by the totals footer. Validation and the 404 happen before the
   * first byte, so a refused request is still a JSON error, never a partial file. Once bytes
   * are out, a failure can only be reported IN the file: it ends with an "incomplete" row.
   */
  @Get(":id/insights.csv")
  async exportCsv(
    @Param("id") id: string,
    @Query() query: ProductInsightsCsvQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    let csv: AsyncIterable<string>;
    let filename: string;
    try {
      ({ csv, filename } = await this.insights.prepareCsvExport(id, query));
    } catch (err) {
      throw asHttp(err);
    }
    res.status(200);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    try {
      for await (const chunk of csv) {
        if (res.destroyed) return; // the client went away: stop reading the database
        if (!res.write(chunk)) await drainedOrClosed(res);
      }
    } catch (err) {
      this.logger.error(
        `CSV export of product ${id} failed mid-stream: ${(err as Error)?.message}`,
      );
      if (!res.destroyed) res.write("\r\n# export failed: the file is incomplete\r\n");
    }
    res.end();
  }
}
