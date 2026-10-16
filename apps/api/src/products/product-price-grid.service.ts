import { Injectable } from "@nestjs/common";
import type { ProductPriceGridDto } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { ProductUnitsService } from "./product-units.service";

// RED stub (C0 part B): returns no rows.
@Injectable()
export class ProductPriceGridService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly units: ProductUnitsService,
  ) {}

  async get(productId: string): Promise<ProductPriceGridDto> {
    void this.prisma;
    void this.units;
    return { productId, anchor: "pack", rows: [] };
  }
}
