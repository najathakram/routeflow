import { Injectable, NotImplementedException } from "@nestjs/common";
import type { ProductInsightsResponse, ProductSalesPage } from "@routeflow/types";
import { SalesFactsService } from "./sales-facts.service";
import type {
  ProductInsightsCsvQueryDto,
  ProductInsightsQueryDto,
  ProductSalesQueryDto,
} from "./dto/product-insights-query.dto";

/**
 * #2118 (plan §B) — shapes the sales facts of ONE product: totals, price facts, a zero-filled
 * series, buyers, line pages and the CSV export. Every figure comes from `SalesFactsService`.
 */
@Injectable()
export class ProductInsightsService {
  constructor(private readonly facts: SalesFactsService) {}

  async getProductInsights(
    productId: string,
    query: ProductInsightsQueryDto,
  ): Promise<ProductInsightsResponse> {
    void productId;
    void query;
    void this.facts;
    throw new NotImplementedException(
      "GET /analytics/products/:id/insights is being built (#2118)",
    );
  }

  async getProductSalesPage(
    productId: string,
    query: ProductSalesQueryDto,
  ): Promise<ProductSalesPage> {
    void productId;
    void query;
    throw new NotImplementedException("GET /analytics/products/:id/sales is being built (#2118)");
  }

  async prepareCsvExport(
    productId: string,
    query: ProductInsightsCsvQueryDto,
  ): Promise<{ csv: AsyncIterable<string>; filename: string }> {
    void productId;
    void query;
    throw new NotImplementedException(
      "GET /analytics/products/:id/insights.csv is being built (#2118)",
    );
  }
}
