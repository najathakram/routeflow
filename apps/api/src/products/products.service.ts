import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { CostingMethod, StockAlertStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { compressImage } from "../storage/compress.util";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { BulkAssignParentDto } from "./dto/bulk-assign-parent.dto";
import { ListProductsDto, StockStatusFilter } from "./dto/list-products.dto";
import { ImportProductsDto } from "./dto/import-products.dto";
import { isValidItemType, isValidUom, templateByKey } from "../regulated/template-registry";

/** `-fp50x40` → focal point 50% across, 40% down. Omitted if focal is centre. */
function encodeFocalSuffix(focal?: { x: number; y: number }): string {
  if (!focal) return "";
  const x = clampPct(focal.x);
  const y = clampPct(focal.y);
  if (x === 50 && y === 50) return ""; // skip the suffix for the default
  return `-fp${x}x${y}`;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 50;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

/**
 * The tenant costing method (SystemConfig `costing.method`, pos-cost-roles-spec §1)
 * mapped to the per-product `CostingMethod` enum. WEIGHTED_AVERAGE ≙ AVCO.
 */
const TENANT_COSTING_TO_PRODUCT: Record<string, CostingMethod> = {
  WEIGHTED_AVERAGE: CostingMethod.AVCO,
  FIFO: CostingMethod.FIFO,
  LAST_COST: CostingMethod.LAST_COST,
};

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly addonService: AddonService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  /**
   * The costing method a NEW product should use (pos-cost-roles-spec §1): an
   * explicit choice on the DTO wins; otherwise fall back to the tenant's
   * configured `costing.method`. Returns `undefined` when the tenant has NOT set
   * one, so the Prisma schema default (AVCO) applies — existing products are
   * never re-costed.
   */
  private async resolveCostingMethod(explicit?: CostingMethod): Promise<CostingMethod | undefined> {
    if (explicit) return explicit;
    const tenantMethod = await this.systemConfig.get("costing.method");
    return TENANT_COSTING_TO_PRODUCT[tenantMethod ?? ""] ?? undefined;
  }

  /**
   * Flagging a product as tobacco requires the tenant's "tobacco_dealer"
   * addon. Clearing the flag is always allowed so a tenant whose addon was
   * revoked can still un-flag products.
   */
  private async assertCanFlagTobacco(isTobacco?: boolean) {
    if (isTobacco !== true) return;
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return; // SUPER_ADMIN context
    if (!(await this.addonService.hasAddon(tenantId, "tobacco_dealer"))) {
      throw new ForbiddenException(
        'Marking products as tobacco requires the "tobacco_dealer" add-on.',
      );
    }
  }

  async findAll(
    query: ListProductsDto,
    opts?: { excludeTrackedCategoryIds?: string[]; andWhere?: Record<string, unknown>[] },
  ) {
    const page = Number(query.page ?? 1);
    // limit=0 is the internal "fetch-all" sentinel used by BuyerCatalogService for
    // price-based sorts (buyer pricing is resolved in-memory so can't use DB ORDER BY).
    // External callers are blocked from setting limit=0 by the @Min(1) DTO constraint.
    // Hard-cap at 10_000 to bound memory use even for internal callers.
    const limitRaw = Number(query.limit ?? 20);
    const fetchAll = limitRaw === 0;
    const limit = fetchAll ? 10_000 : limitRaw;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: "insensitive" } },
        { sku: { contains: query.search, mode: "insensitive" } },
        { barcode: { contains: query.search, mode: "insensitive" } },
        { unitSku: { contains: query.search, mode: "insensitive" } },
      ];
    }
    if (query.category) where.category = query.category;
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.isTobacco !== undefined) where.isTobacco = query.isTobacco;
    // W7 buyer gate: exclude regulated categories the buyer isn't licensed for (set
    // internally by BuyerCatalogService — never from buyer input). In the query so
    // pagination counts stay correct.
    if (opts?.excludeTrackedCategoryIds?.length) {
      where.trackedCategoryId = { notIn: opts.excludeTrackedCategoryIds };
    }

    // Regulated-section filter ("any" | "none" | <sectionId>). When the internal
    // buyer-catalog exclusion already occupies where.trackedCategoryId, fold this
    // clause into AND so BOTH apply.
    if (query.section) {
      const clause =
        query.section === "any" ? { not: null } : query.section === "none" ? null : query.section;
      if (where.trackedCategoryId !== undefined) {
        where.AND = [...(where.AND ?? []), { trackedCategoryId: clause }];
      } else {
        where.trackedCategoryId = clause;
      }
    }

    // Server-side stock-status filtering so pagination counts are accurate
    if (query.stockStatus === StockStatusFilter.OUT_OF_STOCK) {
      // "Out" = inactive OR zero/negative stock. Keep it as its own disjunction
      // AND-ed with any search OR — reusing `where.OR` would merge the two into a
      // single OR, so every out-of-stock product would match regardless of the
      // search text (and every search hit would show even if in stock).
      const outOfStock = [{ isActive: false }, { currentStock: { lte: 0 } }];
      if (where.OR) {
        where.AND = [...(where.AND ?? []), { OR: where.OR }, { OR: outOfStock }];
        delete where.OR;
      } else {
        where.OR = outOfStock;
      }
    } else if (query.stockStatus === StockStatusFilter.LOW) {
      where.isActive = true;
      // lte:5 covers 0, negatives, and low stock; null check invalid for Decimal in Prisma 7.7
      where.currentStock = { lte: 5 };
    } else if (query.stockStatus === StockStatusFilter.IN_STOCK) {
      where.isActive = true;
      where.currentStock = { gt: 5 };
    }

    // Internal-only extra AND clauses (buyer catalog v2 smart collections —
    // set by BuyerCatalogService, never from client input). Folded via AND so
    // they compose with the search OR and the stock-status OR.
    if (opts?.andWhere?.length) {
      where.AND = [...(where.AND ?? []), ...opts.andWhere];
    }

    // Always include `parent` so the web can compose "<Parent> - <Variant>"
    // display names for line items. The parent row is small (no nested
    // relations) so this is cheap. variants{} is still gated behind
    // includeVariants since it materially expands the payload.
    const includeRelations = {
      parent: { select: { id: true, name: true } },
      ...(query.includeVariants
        ? {
            variants: {
              where: { isActive: true },
              orderBy: { variantName: "asc" as const },
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.forTenant().product.findMany({
        where,
        skip,
        take: limit,
        orderBy: { name: "asc" },
        include: includeRelations,
      }),
      this.prisma.forTenant().product.count({ where }),
    ]);

    // Attach thumbnailUrl (first image only) for list/grid display without loading all images
    const enriched = await Promise.all(
      data.map(async (p) => {
        const thumbnailUrl =
          p.imageKeys.length > 0 ? await this.storage.presignedUrl(p.imageKeys[0]) : null;
        return { ...p, thumbnailUrl };
      }),
    );

    return {
      data: enriched,
      meta: {
        total,
        page: fetchAll ? 1 : page,
        limit: fetchAll ? total : limit,
        totalPages: fetchAll ? 1 : Math.ceil(total / limit),
      },
    };
  }

  /**
   * Distinct category strings for this tenant, for autocomplete. Trimmed,
   * de-duplicated case-insensitively (first casing wins), sorted. Rides the
   * `@@index([category])` — no product rows or thumbnails are materialized.
   */
  async listCategories(): Promise<string[]> {
    const rows = await this.prisma.forTenant().product.findMany({
      where: { category: { not: null } },
      select: { category: true },
      distinct: ["category"],
      orderBy: { category: "asc" },
    });
    const seen = new Set<string>();
    const out: string[] = [];
    for (const { category } of rows) {
      const trimmed = category?.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
    return out.sort((a, b) => a.localeCompare(b));
  }

  async findOne(id: string) {
    const product = await this.prisma.forTenant().product.findUnique({
      where: { id },
      include: {
        variants: { orderBy: [{ isActive: "desc" as const }, { variantName: "asc" as const }] },
        parent: true,
        // Phase 4: the assigned regulated ("separately handled") section +
        // subcategory, shown on the product detail. Null for standard products.
        trackedCategory: { select: { id: true, name: true } },
        trackedSubcategory: { select: { id: true, name: true, trackedCategoryId: true } },
      },
    });
    if (!product) throw new NotFoundException("Product not found");
    // Attach presigned image URLs so the frontend can render them directly
    const imageUrls =
      product.imageKeys.length > 0 ? await this.storage.presignedUrls(product.imageKeys) : [];
    // P5-03: operator waitlist count — additive, buyer-facing DTOs never see it.
    const stockAlertCount = await this.prisma.forTenant().stockAlert.count({
      where: { productId: id, status: StockAlertStatus.PENDING },
    });
    return { ...product, imageUrls, stockAlertCount };
  }

  async uploadImage(
    id: string,
    buffer: Buffer,
    originalName: string,
    mimetype: string,
    /**
     * Focal point as integer percentages (0..100). Encoded into the
     * storage key as `-fp<X>x<Y>` so the frontend can recover it from
     * the URL without a DB schema change. Defaults to centre.
     */
    focal?: { x: number; y: number },
  ): Promise<{ key: string; url: string }> {
    const product = await this.prisma.forTenant().product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException("Product not found");

    const compressed = await compressImage(buffer, mimetype);
    const fpSuffix = encodeFocalSuffix(focal);
    const key = `products/${id}/${crypto.randomUUID()}${fpSuffix}.${compressed.ext}`;
    await this.storage.upload(key, compressed.buffer, compressed.mimeType);

    // Append key to the product's imageKeys array
    await this.prisma.forTenant().product.update({
      where: { id },
      data: { imageKeys: { push: key } },
    });

    const url = await this.storage.presignedUrl(key);
    return { key, url };
  }

  async deleteImage(id: string, key: string): Promise<void> {
    const product = await this.prisma.forTenant().product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException("Product not found");
    if (!product.imageKeys.includes(key)) {
      throw new NotFoundException("Image not found on this product");
    }

    // Remove from R2
    await this.storage.delete(key);

    // Remove key from array
    await this.prisma.forTenant().product.update({
      where: { id },
      data: { imageKeys: product.imageKeys.filter((k) => k !== key) },
    });
  }

  /**
   * Resolves a scanned code to a product across all three scannable
   * identities — case `barcode`, case `sku`, or the retail-unit `unitSku` —
   * each tenant-unique, so at most 3 rows can match. Deterministic priority
   * when a code somehow matches more than one product: barcode > sku > unitSku.
   */
  async findByBarcode(code: string) {
    const matches = await this.prisma.forTenant().product.findMany({
      where: { OR: [{ barcode: code }, { sku: code }, { unitSku: code }] },
      include: { variants: { where: { isActive: true } }, parent: true },
    });
    if (matches.length === 0) throw new NotFoundException("Product not found");
    return (
      matches.find((p) => p.barcode === code) ??
      matches.find((p) => p.sku === code) ??
      matches.find((p) => p.unitSku === code)!
    );
  }

  async create(dto: CreateProductDto) {
    await this.assertCanFlagTobacco(dto.isTobacco);
    // Name uniqueness is scoped by parent, matching the partial unique
    // indexes in the DB (see prisma/migrations/.../variant_name_per_parent).
    //   - Standalone product → unique among other STANDALONE products.
    //   - Variant            → unique among siblings of the same parent.
    // Two flavors named "Strawberry" under different parents are allowed.
    const parentScope = dto.parentProductId
      ? { parentProductId: dto.parentProductId }
      : { parentProductId: null };
    const nameTaken = await this.prisma.forTenant().product.findFirst({
      where: { name: { equals: dto.name, mode: "insensitive" }, ...parentScope },
      select: { id: true },
    });
    if (nameTaken) {
      throw new ConflictException(
        dto.parentProductId
          ? `A variant named "${dto.name}" already exists for this product`
          : `A product named "${dto.name}" already exists`,
      );
    }
    // Auto-generate a SKU if none supplied: first 3 alpha chars of name + 4 hex digits
    if (!dto.sku) {
      const prefix = dto.name
        .replace(/[^a-zA-Z]/g, "")
        .slice(0, 3)
        .toUpperCase()
        .padEnd(3, "X");
      const suffix = Math.floor(Math.random() * 0xffff)
        .toString(16)
        .toUpperCase()
        .padStart(4, "0");
      dto.sku = `${prefix}-${suffix}`;
    } else {
      // A case sku must not collide with another product's sku or unit code
      // (the unit code is what the customer invoice prints, so a sku equal to it
      // would resolve a scan to the wrong product). unitSku is a new all-null
      // column, so this widening can't retroactively reject existing catalogs.
      // We deliberately do NOT reject a sku that equals another product's barcode:
      // that was always allowed, findByBarcode ranks barcode > sku so it still
      // resolves deterministically, and blocking it would 400 edits on existing data.
      const existing = await this.prisma.forTenant().product.findFirst({
        where: { OR: [{ sku: dto.sku }, { unitSku: dto.sku }] },
      });
      if (existing) throw new BadRequestException("SKU already exists");
    }
    if (dto.barcode) {
      // Symmetric to the sku check: reject a barcode colliding with another
      // product's barcode or unit code, but not its case sku (pre-existing behavior).
      const existing = await this.prisma.forTenant().product.findFirst({
        where: { OR: [{ barcode: dto.barcode }, { unitSku: dto.barcode }] },
      });
      if (existing) throw new BadRequestException("Barcode already exists");
    }
    // A unit code must not collide with ANY product's sku/barcode/unitSku — it's a
    // scannable identity in the same namespace, so an ambiguous match would resolve
    // to the wrong product.
    if (dto.unitSku) {
      const clash = await this.prisma.forTenant().product.findFirst({
        where: { OR: [{ unitSku: dto.unitSku }, { sku: dto.unitSku }, { barcode: dto.unitSku }] },
        select: { id: true },
      });
      if (clash) {
        throw new BadRequestException(
          "Unit code already used by another product's SKU, barcode, or unit code",
        );
      }
    }
    // Variant creation inherits the parent family's defaults for every field the
    // DTO left unset — price tiers, category, case size, costing method, standard
    // cost, tobacco flag (mirrors the import module's variant resolution, so ALL
    // clients get the same behavior). DTO-explicit values always win.
    const parent = dto.parentProductId
      ? await this.prisma.forTenant().product.findUnique({
          where: { id: dto.parentProductId },
          select: {
            priceTier2: true,
            priceTier3: true,
            priceTier4: true,
            priceTier5: true,
            category: true,
            unitsPerBox: true,
            costingMethod: true,
            standardCost: true,
            isTobacco: true,
            trackedCategoryId: true,
            trackedSubcategoryId: true,
            regItemType: true,
            regUomCase: true,
            regUomUnit: true,
          },
        })
      : null;
    if (dto.parentProductId && !parent) {
      throw new BadRequestException("Parent product not found");
    }
    // Phase 4: regulated section + subcategory. Explicit DTO wins; when the DTO
    // omits the section entirely, a variant inherits the parent family's pair
    // (kept together so they stay same-section). Absent/"" section → null.
    // The regulatory reporting trio inherits alongside the section pair, but each
    // of its three fields still falls back to the parent independently — a
    // variant can override just its case UoM, say, without breaking away from
    // the parent's section.
    const regulated =
      dto.trackedCategoryId === undefined && parent
        ? {
            trackedCategoryId: parent.trackedCategoryId ?? null,
            trackedSubcategoryId: parent.trackedSubcategoryId ?? null,
            regItemType:
              dto.regItemType !== undefined ? dto.regItemType : (parent.regItemType ?? null),
            regUomCase: dto.regUomCase !== undefined ? dto.regUomCase : (parent.regUomCase ?? null),
            regUomUnit: dto.regUomUnit !== undefined ? dto.regUomUnit : (parent.regUomUnit ?? null),
          }
        : {
            trackedCategoryId: dto.trackedCategoryId ?? null,
            trackedSubcategoryId: dto.trackedSubcategoryId ?? null,
            regItemType: dto.regItemType ?? null,
            regUomCase: dto.regUomCase ?? null,
            regUomUnit: dto.regUomUnit ?? null,
          };
    await this.assertSubcategoryInSection(
      regulated.trackedCategoryId,
      regulated.trackedSubcategoryId,
    );
    await this.assertRegConfigValid({
      trackedCategoryId: regulated.trackedCategoryId,
      regItemType: regulated.regItemType,
      regUomCase: regulated.regUomCase,
      regUomUnit: regulated.regUomUnit,
    });
    // One-category-axis rule: a regulated product's category IS its structured
    // (per-type) category name — synced server-side so every category surface
    // (filters, analytics, buyer facets) shows "Zyn", never the type name.
    let syncedCategory: string | undefined;
    if (regulated.trackedSubcategoryId) {
      const sub = await this.prisma.forTenant().trackedSubcategory.findUnique({
        where: { id: regulated.trackedSubcategoryId },
        select: { name: true },
      });
      syncedCategory = sub?.name;
    }
    return this.prisma.forTenant().product.create({
      data: {
        name: dto.name,
        sku: dto.sku,
        barcode: dto.barcode,
        unitSku: dto.unitSku,
        unit: dto.unit,
        pricePerUnit: dto.pricePerUnit,
        priceTier2: dto.priceTier2 ?? (parent ? parent.priceTier2.toString() : dto.pricePerUnit),
        priceTier3: dto.priceTier3 ?? (parent ? parent.priceTier3.toString() : dto.pricePerUnit),
        priceTier4: dto.priceTier4 ?? (parent ? parent.priceTier4.toString() : dto.pricePerUnit),
        priceTier5: dto.priceTier5 ?? (parent ? parent.priceTier5.toString() : dto.pricePerUnit),
        category: syncedCategory ?? dto.category ?? parent?.category ?? undefined,
        description: dto.description,
        isActive: dto.isActive,
        // Inherited-from-parent tobacco skips the addon re-check (top of create):
        // the parent already passed it when IT was flagged.
        isTobacco: dto.isTobacco ?? parent?.isTobacco ?? false,
        // Default new products to the tenant's configured costing method when the
        // operator didn't pick one (pos-cost-roles-spec §1). Variants inherit the
        // parent's method instead so the family is costed consistently.
        costingMethod: parent
          ? (dto.costingMethod ?? parent.costingMethod)
          : await this.resolveCostingMethod(dto.costingMethod),
        standardCost: dto.standardCost ?? parent?.standardCost?.toString(),
        unitsPerBox: dto.unitsPerBox ?? parent?.unitsPerBox ?? undefined,
        parentProductId: dto.parentProductId ?? null,
        variantName: dto.variantName ?? null,
        trackedCategoryId: regulated.trackedCategoryId,
        trackedSubcategoryId: regulated.trackedSubcategoryId,
        regItemType: regulated.regItemType,
        regUomCase: regulated.regUomCase,
        regUomUnit: regulated.regUomUnit,
      },
      include: { variants: true, parent: true },
    });
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.assertCanFlagTobacco(dto.isTobacco);
    const existing = await this.findOne(id);
    if (dto.name || dto.parentProductId !== undefined) {
      // The product's effective parent is the dto value if provided (could be
      // null to promote a variant to standalone), otherwise the existing one.
      // The check has to use this effective parent, otherwise reparenting +
      // renaming in one PATCH would check the WRONG scope.
      const effectiveParentId =
        dto.parentProductId !== undefined ? dto.parentProductId : existing.parentProductId;
      const effectiveName = dto.name ?? existing.name;
      const parentScope = effectiveParentId
        ? { parentProductId: effectiveParentId }
        : { parentProductId: null };
      const nameTaken = await this.prisma.forTenant().product.findFirst({
        where: {
          name: { equals: effectiveName, mode: "insensitive" },
          id: { not: id },
          ...parentScope,
        },
        select: { id: true },
      });
      if (nameTaken) {
        throw new ConflictException(
          effectiveParentId
            ? `A variant named "${effectiveName}" already exists for this product`
            : `A product named "${effectiveName}" already exists`,
        );
      }
    }
    if (dto.sku) {
      // Reject a case sku colliding with another product's sku or unit code (see
      // create() — unitSku widening is safe on the new column; sku↔barcode is left
      // as-is to avoid retroactively breaking existing catalogs).
      const existing = await this.prisma.forTenant().product.findFirst({
        where: {
          OR: [{ sku: dto.sku }, { unitSku: dto.sku }],
          id: { not: id },
        },
      });
      if (existing) throw new BadRequestException("SKU already exists");
    }
    if (dto.barcode) {
      const existing = await this.prisma.forTenant().product.findFirst({
        where: {
          OR: [{ barcode: dto.barcode }, { unitSku: dto.barcode }],
          id: { not: id },
        },
      });
      if (existing) throw new BadRequestException("Barcode already exists");
    }
    // Same cross-namespace collision check as create() — a unit code must not
    // collide with any OTHER product's sku/barcode/unitSku.
    if (dto.unitSku) {
      const clash = await this.prisma.forTenant().product.findFirst({
        where: {
          OR: [{ unitSku: dto.unitSku }, { sku: dto.unitSku }, { barcode: dto.unitSku }],
          id: { not: id },
        },
      });
      if (clash) {
        throw new BadRequestException(
          "Unit code already used by another product's SKU, barcode, or unit code",
        );
      }
    }
    // Keep a variant's name and variantName in sync — create() enforces
    // name === variantName, so a rename (via the generic name field, e.g. the
    // mobile edit form which has no dedicated flavor input) must carry variantName
    // too, or the variants list keeps rendering the stale flavor.
    const effectiveParentId =
      dto.parentProductId !== undefined ? dto.parentProductId : existing.parentProductId;
    // Phase 4: validate the regulated section/subcategory pair on the EFFECTIVE
    // (post-update) values; clearing the section also clears the subcategory so no
    // orphaned subcategory can survive.
    const effectiveCategoryId =
      dto.trackedCategoryId !== undefined ? dto.trackedCategoryId : existing.trackedCategoryId;
    const effectiveSubcategoryId =
      effectiveCategoryId == null
        ? null
        : dto.trackedSubcategoryId !== undefined
          ? dto.trackedSubcategoryId
          : existing.trackedSubcategoryId;
    await this.assertSubcategoryInSection(effectiveCategoryId, effectiveSubcategoryId);
    // Clearing the section clears the regulatory trio with it — gated on the
    // section actually TRANSITIONING to null, so editing a product that already
    // has no section (e.g. one detached from its section but still carrying the
    // config its historic ledger rows are reported under) never erases it.
    const clearingSection = existing.trackedCategoryId != null && effectiveCategoryId == null;
    // The gate below fires on a real TRANSITION only — when this request CHANGES
    // the trio, or MOVES the product to a different section — and never on an echo.
    // Both product forms resend the section and all three codes on every save, even
    // when the section's template makes them render none of them, so a presence test
    // would 400 unrelated edits (a rename, a price change) on any product whose
    // codes were stranded by a later template switch, with no UI able to clear them.
    // A change to the trio re-validates the whole effective trio, so an item-type
    // switch can't leave an orphan UoM. A move re-validates for the same reason
    // create() rejects the end state: the ledger is append-only and keeps the OLD
    // section, while the report resolves item type / UoM from the product row LIVE,
    // so codes carried into a template that can't express them would silently
    // restate already-filed periods. A move is REJECTED, never auto-cleared — both
    // forms clear the trio client-side on a section change, so the 400 only reaches
    // API-direct callers, which must send the nulls explicitly.
    const regConfigChanged = (["regItemType", "regUomCase", "regUomUnit"] as const).some(
      (field) => dto[field] !== undefined && (dto[field] ?? null) !== (existing[field] ?? null),
    );
    const sectionChanged = (effectiveCategoryId ?? null) !== (existing.trackedCategoryId ?? null);
    // `!clearingSection` is load-bearing: a legitimate section clear is a move too,
    // and validating it would 400 on "requires a regulated type" before the
    // auto-clear below ever runs.
    if ((regConfigChanged || sectionChanged) && !clearingSection) {
      await this.assertRegConfigValid({
        trackedCategoryId: effectiveCategoryId,
        regItemType: dto.regItemType !== undefined ? dto.regItemType : existing.regItemType,
        regUomCase: dto.regUomCase !== undefined ? dto.regUomCase : existing.regUomCase,
        regUomUnit: dto.regUomUnit !== undefined ? dto.regUomUnit : existing.regUomUnit,
      });
    }
    // `data.category` needs to accept `null` below (a `string | undefined` DTO
    // field), which the spread's inferred type won't allow — loosen it like the
    // `where: any` Prisma clauses elsewhere in this file.
    const data: any =
      dto.name !== undefined && effectiveParentId ? { ...dto, variantName: dto.name } : { ...dto };
    // Force the (possibly auto-cleared) subcategory into the write when the section
    // was cleared but the client didn't also clear the subcategory.
    if (effectiveCategoryId == null && existing.trackedSubcategoryId != null) {
      data.trackedSubcategoryId = null;
    }
    // Same auto-clear for the regulatory reporting trio — it's only meaningful
    // within a regulated section. Unconditional over the DTO: a request that
    // clears the section while ALSO sending reg codes must not persist config with
    // no section to validate it against, and only the raw `{ ...dto }` spread
    // could leak them through.
    if (clearingSection) {
      data.regItemType = null;
      data.regUomCase = null;
      data.regUomUnit = null;
    }
    // One-category-axis rule: keep Product.category in sync with the structured
    // category so filters/analytics/buyer facets never see the type name instead
    // of "Zyn". See products.service.spec "category sync" scenarios.
    if (typeof dto.trackedSubcategoryId === "string") {
      // Structured category being SET/CHANGED — its name wins over any
      // dto.category sent in the same request (the form never sends both;
      // imports/legacy clients shouldn't be able to desync the axis).
      const sub = await this.prisma.forTenant().trackedSubcategory.findUnique({
        where: { id: dto.trackedSubcategoryId },
        select: { name: true },
      });
      if (sub?.name) data.category = sub.name;
    } else if (data.trackedSubcategoryId === null) {
      // Structured category being CLEARED — either explicitly, or because its
      // parent section was just cleared above. Only clear the mirrored
      // category if it was actually synced; a diverged free-text category
      // (legacy) survives.
      if (existing.category != null && existing.category === existing.trackedSubcategory?.name) {
        data.category = null;
      }
    } else if (existing.trackedSubcategoryId != null && dto.category !== undefined) {
      // Category-only edit on a product that still has a structured category:
      // the free-text field is hidden by the form for regulated items, so
      // force it back to the synced name rather than letting it desync.
      data.category = existing.trackedSubcategory?.name ?? null;
    }
    return this.prisma.forTenant().product.update({
      where: { id },
      data,
    });
  }

  /**
   * A product's regulated subcategory (when set) must belong to the chosen
   * section — Prisma can't express the composite FK, so validate app-side. A
   * subcategory without a section is rejected. Tenant-scoped lookup.
   */
  private async assertSubcategoryInSection(
    categoryId: string | null | undefined,
    subcategoryId: string | null | undefined,
  ): Promise<void> {
    if (subcategoryId == null) return;
    if (categoryId == null) {
      throw new BadRequestException("A regulated subcategory requires a section.");
    }
    const sub = await this.prisma.forTenant().trackedSubcategory.findUnique({
      where: { id: subcategoryId },
      select: { trackedCategoryId: true },
    });
    if (!sub) throw new BadRequestException("Regulated subcategory not found.");
    if (sub.trackedCategoryId !== categoryId) {
      throw new BadRequestException("Subcategory does not belong to the chosen section.");
    }
  }

  /**
   * Regulatory reporting codes must belong to the section's report template. A
   * product with no regulatory config is always valid (the common case).
   */
  private async assertRegConfigValid(params: {
    trackedCategoryId: string | null;
    regItemType: string | null;
    regUomCase: string | null;
    regUomUnit: string | null;
  }): Promise<void> {
    const { trackedCategoryId, regItemType, regUomCase, regUomUnit } = params;
    if (!regItemType && !regUomCase && !regUomUnit) return;
    if (!trackedCategoryId) {
      throw new BadRequestException("Regulatory reporting configuration requires a regulated type");
    }
    const cat = await this.prisma.forTenant().trackedCategory.findUnique({
      where: { id: trackedCategoryId },
      select: { name: true, reportTemplate: true },
    });
    if (!cat) throw new BadRequestException("Regulated type not found");
    if (!templateByKey(cat.reportTemplate)?.productConfig) {
      throw new BadRequestException(
        `"${cat.name}" uses a report template with no per-product configuration`,
      );
    }
    if (regItemType && !isValidItemType(cat.reportTemplate, regItemType)) {
      throw new BadRequestException(
        `"${regItemType}" is not a valid item type for ${cat.reportTemplate}`,
      );
    }
    for (const uom of [regUomCase, regUomUnit]) {
      if (uom && !isValidUom(cat.reportTemplate, regItemType ?? null, uom)) {
        throw new BadRequestException(
          `"${uom}" is not a valid unit of measure for ${cat.reportTemplate}`,
        );
      }
    }
  }

  /**
   * Promote existing standalone products to variants of one parent in a single
   * request (the web's "Group as variants of…" bulk action). Runs SEQUENTIALLY
   * through update() so each row gets the full validation (per-parent name
   * uniqueness, tobacco addon, …) and one failure doesn't abort the rest —
   * per-item success/failure is reported back to the caller.
   */
  async bulkAssignParent(
    dto: BulkAssignParentDto,
  ): Promise<{ succeeded: string[]; failed: { id: string; reason: string }[] }> {
    const parent = await this.prisma.forTenant().product.findUnique({
      where: { id: dto.parentProductId },
      select: { id: true, parentProductId: true },
    });
    if (!parent) throw new BadRequestException("Parent product not found");
    if (parent.parentProductId) {
      throw new BadRequestException("Parent must be a standalone product, not a variant");
    }
    const succeeded: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const assignment of dto.assignments) {
      try {
        await this.update(assignment.id, {
          parentProductId: dto.parentProductId,
          variantName: assignment.variantName,
          // Variants store JUST the variant name in `name` (PR #44).
          name: assignment.variantName,
        } as UpdateProductDto);
        succeeded.push(assignment.id);
      } catch (err) {
        // F8-003: surface the app's OWN validation messages (HttpException — intentional
        // and user-facing, e.g. "A variant named X already exists"), but genericize any
        // raw/unknown error (e.g. a Prisma constraint) so internal schema text isn't
        // disclosed. Always log the real error server-side.
        if (err instanceof HttpException) {
          failed.push({ id: assignment.id, reason: err.message });
        } else {
          this.logger.warn(
            `bulkAssignParent failed for ${assignment.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          failed.push({ id: assignment.id, reason: "Update failed" });
        }
      }
    }
    return { succeeded, failed };
  }

  async remove(id: string) {
    await this.findOne(id);
    const activeItems = await this.prisma.forTenant().orderItem.count({
      where: { productId: id, status: { notIn: ["DELIVERED", "CANCELLED"] } },
    });
    if (activeItems > 0) {
      throw new BadRequestException("Cannot delete product with active order items");
    }
    return this.prisma.forTenant().product.update({ where: { id }, data: { isActive: false } });
  }

  async clearAll(): Promise<{ deleted: number }> {
    // Count before clearing so we can report back
    const count = await this.prisma.forTenant().product.count();
    // CASCADE removes all rows in dependent tables (OrderItem, InvoiceItem, etc.)
    await this.prisma.$executeRaw`TRUNCATE TABLE "Product" CASCADE`;
    return { deleted: count };
  }

  async bulkDelete(ids: string[]): Promise<{ deleted: number }> {
    if (ids.length === 0) return { deleted: 0 };
    // Delete all dependent records first, then the products themselves
    await this.prisma.$transaction([
      this.prisma.forTenant().customerPrice.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma
        .forTenant()
        .recurringInvoiceItem.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.forTenant().productMapping.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.forTenant().vendorBillItem.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.forTenant().estimateItem.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.forTenant().returnItem.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.forTenant().purchaseOrderItem.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.forTenant().invoiceItem.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.forTenant().orderTemplateItem.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.forTenant().deliveryMutation.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.forTenant().orderItem.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.forTenant().stockLot.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.forTenant().stockMovement.deleteMany({ where: { productId: { in: ids } } }),
      this.prisma.forTenant().product.deleteMany({ where: { id: { in: ids } } }),
    ]);
    return { deleted: ids.length };
  }

  async importFromZoho(dto: ImportProductsDto): Promise<{
    created: number;
    skipped: number;
    errors: Array<{ row: number; name: string; reason: string }>;
  }> {
    let created = 0;
    let skipped = 0;
    const errors: Array<{ row: number; name: string; reason: string }> = [];

    for (let i = 0; i < dto.items.length; i++) {
      const item = dto.items[i];
      const rowNum = i + 1;

      try {
        // Check for duplicate name
        const nameTaken = await this.prisma.forTenant().product.findFirst({
          where: { name: { equals: item.name, mode: "insensitive" } },
          select: { id: true },
        });
        if (nameTaken) {
          skipped++;
          continue;
        }

        // Check for duplicate SKU
        if (item.sku) {
          const existing = await this.prisma
            .forTenant()
            .product.findFirst({ where: { sku: item.sku } });
          if (existing) {
            skipped++;
            continue;
          }
        }

        // Check for duplicate barcode
        if (item.barcode) {
          const existing = await this.prisma.forTenant().product.findFirst({
            where: { barcode: item.barcode },
          });
          if (existing) {
            // If no SKU collision but barcode exists, skip
            skipped++;
            continue;
          }
        }

        await this.prisma.forTenant().product.create({
          data: {
            name: item.name,
            sku: item.sku ?? null,
            barcode: item.barcode ?? null,
            unit: item.unit,
            pricePerUnit: item.pricePerUnit,
            priceTier2: item.pricePerUnit,
            priceTier3: item.pricePerUnit,
            priceTier4: item.pricePerUnit,
            priceTier5: item.pricePerUnit,
            category: item.category ?? null,
            description: item.description ?? null,
            isActive: item.isActive ?? true,
            currentStock: item.currentStock ?? "0",
            averageCost: item.averageCost ?? null,
            reorderPoint: item.reorderPoint ?? null,
          },
        });

        created++;
      } catch (err: any) {
        // F8-003: never echo the raw Prisma/exception text (it discloses table
        // and column names). Log the real error server-side; return a generic
        // per-row reason to the client.
        this.logger.warn(
          `Bulk product import row ${rowNum} ("${item.name}") failed: ${err?.message}`,
        );
        errors.push({ row: rowNum, name: item.name, reason: "Import failed" });
      }
    }

    return { created, skipped, errors };
  }
}
