import { Injectable, Optional } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { ProductFamiliesService } from "../products/product-families.service";
import { ProductsService } from "../products/products.service";

/** SA-823 section 5: the most rows a file with a Family column may carry (it fits the largest known catalog, 2,202). */
export const IMPORT_FAMILY_MAX_ROWS = 2500;

/**
 * SA-823 (row 655 PR-2): the Family / Variant name columns of the product import. Skeleton: the planning and apply
 * steps land with the implementation commit.
 */
@Injectable()
export class ProductFamilyImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly productsService: ProductsService,
    private readonly families: ProductFamiliesService,
    private readonly audit: AuditService,
    @Optional() private readonly featureConfig?: FeatureConfigService,
  ) {}
}
