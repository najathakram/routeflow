import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { CostingMethod, MovementType, Prisma, StockAlertStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { compressImage } from "../storage/compress.util";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { buildPlanGateBody } from "../billing/plan-gate";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { BulkAssignParentDto } from "./dto/bulk-assign-parent.dto";
import { BulkSetMsrpDto } from "./dto/bulk-set-msrp.dto";
import { ListProductsDto, StockStatusFilter } from "./dto/list-products.dto";
import { ImportProductsDto } from "./dto/import-products.dto";
import { isValidItemType, isValidUom, templateByKey } from "../regulated/template-registry";
import { normalizeScanCode, pickBestScanMatch } from "../common/barcode-normalize";
import { buildScanSearchOr } from "./scan-search";
import { isMsrpBelowWholesale, wholesalePerPiece } from "../common/msrp";
import { TOBACCO_CATEGORY_NAME, isTobaccoCategoryName } from "../common/tobacco-category";

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
 * MSRP writes are normalized before they reach Prisma: 0, negative, and
 * non-numeric decimal strings are never stored — a "$0.00" MSRP must render
 * blank per the resolver's contract (common/msrp.ts), so it can't be allowed
 * to reach the column at all. `undefined` (key not sent) passes through so
 * Prisma leaves the column untouched.
 */
function normalizeMsrpForWrite(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? v : null;
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
    private readonly entitlements: EntitlementsService,
    private readonly planCatalog: PlanCatalogService,
    private readonly gateway: RouteFlowGateway,
  ) {}

  /**
   * Tell every operator socket in this tenant that the catalog moved, so a
   * mounted scan/picker/list screen refetches instead of serving a stale price
   * or an archived product for its whole staleTime. Fire-and-forget: a socket
   * failure must never fail the catalog write that already committed.
   */
  private emitProductChanged(
    productId: string | null,
    action: "created" | "updated" | "archived" | "bulk",
  ): void {
    try {
      this.gateway.emitProductUpdated(this.prisma.getTenantId(), { productId, action });
    } catch (err) {
      this.logger.warn(
        `product.updated emit failed (${action}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * MSRP writes are flag-gated INSIDE the service, not on the whole route —
   * gating the whole create/update PATCH would 403 an ordinary product edit for
   * a tenant that never touches MSRP. Callers only invoke this when the DTO
   * actually carries an `msrp` key.
   */
  private async assertMsrpAllowed(): Promise<void> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return; // no tenant context (e.g. SUPER_ADMIN) — nothing to gate
    if (await this.entitlements.hasFlag(tenantId, "flag.msrp")) return;
    const upgrade = await this.planCatalog.upgradeTargetForFlag("flag.msrp").catch(() => ({
      planKey: null,
      planMonthlyPrice: null,
      addonSku: null,
      addonMonthlyPrice: null,
    }));
    throw new ForbiddenException(buildPlanGateBody("flag.msrp", upgrade));
  }

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

  /** The tenant's Tobacco regulated type, matched by name (case-insensitive). */
  private async findTobaccoCategory(): Promise<{ id: string; name: string } | null> {
    return this.prisma.forTenant().trackedCategory.findFirst({
      where: { name: { equals: TOBACCO_CATEGORY_NAME, mode: "insensitive" } },
      select: { id: true, name: true },
    });
  }

  /**
   * Resolve the tenant's Tobacco type, creating it when absent. The created row
   * mirrors the Phase-4 W1 seed exactly (warn-only: taxType NONE, no license,
   * CA_CDTFA / MONTHLY, SEPARATE_INVOICE) so flagging a first tobacco product
   * never enables tax or license enforcement as a side effect.
   *
   * Seeding that row is a WRITE, and it is NOT in the same transaction as the
   * product write it serves — so `pending` (the request's effective subcategory
   * and regulatory trio) is validated against the row we are ABOUT to seed
   * BEFORE creating it. Without that, a request the section validations reject
   * downstream — e.g. quick-toggling tobacco on a product carrying reg codes
   * from a non-CA_CDTFA section — would 400 and still leave an orphan "Tobacco"
   * type in the Regulated Items nav for a tenant that never had one.
   */
  private async resolveOrCreateTobaccoCategory(pending: {
    trackedSubcategoryId: string | null;
    regItemType: string | null;
    regUomCase: string | null;
    regUomUnit: string | null;
  }): Promise<{ id: string }> {
    const existing = await this.findTobaccoCategory();
    if (existing) return existing;
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) {
      throw new BadRequestException("A tenant context is required to flag tobacco products.");
    }
    const reportTemplate = "CA_CDTFA";
    // A brand-new type has no subcategories, so any subcategory carried by the
    // request belongs to another section — assertSubcategoryInSection would
    // reject it below, which must happen before the seed, not after.
    if (pending.trackedSubcategoryId != null) {
      throw new BadRequestException("Subcategory does not belong to the chosen section.");
    }
    this.assertRegConfigMatchesTemplate({ name: TOBACCO_CATEGORY_NAME, reportTemplate }, pending);
    return this.prisma.forTenant().trackedCategory.create({
      data: {
        tenantId,
        name: TOBACCO_CATEGORY_NAME,
        taxType: "NONE",
        requiresLicense: false,
        reportTemplate,
        reportCadence: "MONTHLY",
        invoiceTreatment: "SEPARATE_INVOICE",
        active: true,
      },
      select: { id: true },
    });
  }

  async findAll(
    query: ListProductsDto,
    opts?: { excludeTrackedCategoryIds?: string[]; andWhere?: Record<string, unknown>[] },
  ) {
    const page = Number(query.page ?? 1);
    // limit=0 is the "fetch-all" sentinel used by BuyerCatalogService for
    // price-based sorts (buyer pricing is resolved in-memory so can't use DB ORDER BY).
    // NOTE: the DTO allows it from external callers too (@Min(0) — web pickers
    // relied on it); bounding that is a separate hardening change.
    // Hard-cap at 10_000 to bound memory use either way.
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
    } else if (query.scanCode) {
      // Scan-fallback rung: same four columns, but contains-matched against
      // EVERY normalizeScanCode candidate instead of the raw decode — the raw
      // string misses whenever this camera's decode differs from the stored
      // shape (iOS 13-digit vs a 12-digit code kept in the product name).
      // OR: [] when the code yields no candidates — matches nothing, correctly.
      where.OR = buildScanSearchOr(query.scanCode);
    }
    if (query.category) where.category = query.category;
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.isTobacco !== undefined) where.isTobacco = query.isTobacco;
    // W7 buyer gate: exclude regulated categories the buyer isn't licensed for (set
    // internally by BuyerCatalogService — never from buyer input). In the query so
    // pagination counts stay correct.
    if (opts?.excludeTrackedCategoryIds?.length) {
      // Hide license-gated categories WITHOUT hiding untracked products.
      // Prisma's `notIn` never matches NULL rows, so the previous bare filter
      // (`trackedCategoryId: { notIn: [...] }`) made every product with NO
      // tracked category vanish the moment a tenant had one requiresLicense
      // category — on a live tenant that hid 1,757 of 1,823 products from
      // every unlicensed buyer. NULL must be allowed back in explicitly.
      // AND-pushed (not where.trackedCategoryId) so it can't collide with the
      // regulated fold-in below or a search OR.
      where.AND = [
        ...((where.AND as Record<string, unknown>[] | undefined) ?? []),
        {
          OR: [
            { trackedCategoryId: null },
            { trackedCategoryId: { notIn: opts.excludeTrackedCategoryIds } },
          ],
        },
      ];
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
   * Resolves a scanned code to a product across all three scannable identities
   * — case `barcode`, case `sku`, or the retail-unit `unitSku`.
   *
   * Matching is done against the CANDIDATE SET from `normalizeScanCode`, not
   * the literal string: the same physical label decodes differently on
   * different hardware (iOS reports a UPC-A as a 13-digit EAN-13 with a leading
   * zero; the web decoders report 12 digits), so an exact-equality lookup 404s
   * on products that plainly exist. `pickBestScanMatch` keeps the winner
   * deterministic when several rows match.
   */
  async findByBarcode(code: string) {
    const candidates = normalizeScanCode(code);
    if (candidates.length === 0) throw new NotFoundException("Product not found");

    const include = { variants: { where: { isActive: true } }, parent: true };
    const db = this.prisma.forTenant();

    // Tier 1 — exact. Rides @@unique([tenantId, barcode|sku|unitSku]) and the
    // @@index([barcode]) / @@index([unitSku]) as a BitmapOr of index scans:
    // at most MAX_SCAN_CANDIDATES probes per column.
    let matches = await db.product.findMany({
      where: {
        OR: [
          { barcode: { in: candidates } },
          { sku: { in: candidates } },
          { unitSku: { in: candidates } },
        ],
      },
      include,
    });

    // Tier 2 — case-insensitive, MISS ONLY. Prisma emits ILIKE for
    // `mode: "insensitive"`, which a btree can't serve, so this is a
    // tenant-scoped seq scan. It runs only on the path that used to 404
    // outright, and camera-decoded EAN/UPC codes (all digits) never reach it —
    // it exists for typed or lowercased alpha SKUs.
    if (matches.length === 0) {
      matches = await db.product.findMany({
        where: {
          OR: candidates.flatMap((c) => [
            { barcode: { equals: c, mode: "insensitive" as const } },
            { sku: { equals: c, mode: "insensitive" as const } },
            { unitSku: { equals: c, mode: "insensitive" as const } },
          ]),
        },
        include,
        take: 25,
      });
    }

    if (matches.length === 0) throw new NotFoundException("Product not found");
    return pickBestScanMatch(matches, candidates);
  }

  async create(dto: CreateProductDto) {
    await this.assertCanFlagTobacco(dto.isTobacco);
    if (dto.msrp !== undefined) await this.assertMsrpAllowed();
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
      ? await this.prisma.forTenant().product.findFirst({
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
    const regulated: {
      trackedCategoryId: string | null;
      trackedSubcategoryId: string | null;
      regItemType: string | null;
      regUomCase: string | null;
      regUomUnit: string | null;
    } =
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
    // ── Compliance-pack sync: Category is the ONE axis; isTobacco is a derived
    // mirror of membership in the tenant's Tobacco type. An isTobacco-only create
    // (no category sent — legacy clients / quick flows) is sugar for "put it in
    // the Tobacco type"; when a category IS sent, the category wins.
    let isTobacco = dto.isTobacco ?? parent?.isTobacco ?? false;
    if (regulated.trackedCategoryId == null && dto.isTobacco === true) {
      // The end state is handed to the resolver so it can validate BEFORE
      // seeding a first Tobacco type — the assertions below run after it.
      const tobacco = await this.resolveOrCreateTobaccoCategory({
        trackedSubcategoryId: regulated.trackedSubcategoryId,
        regItemType: regulated.regItemType,
        regUomCase: regulated.regUomCase,
        regUomUnit: regulated.regUomUnit,
      });
      regulated.trackedCategoryId = tobacco.id;
      isTobacco = true;
    } else if (regulated.trackedCategoryId != null) {
      const cat = await this.prisma.forTenant().trackedCategory.findFirst({
        where: { id: regulated.trackedCategoryId },
        select: { name: true },
      });
      isTobacco = isTobaccoCategoryName(cat?.name);
    }
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
      const sub = await this.prisma.forTenant().trackedSubcategory.findFirst({
        where: { id: regulated.trackedSubcategoryId },
        select: { name: true },
      });
      syncedCategory = sub?.name;
    }
    const created = await this.prisma.forTenant().product.create({
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
        // the parent already passed it when IT was flagged. `isTobacco` here is
        // the mirror-derived value computed above (category is the one axis).
        isTobacco,
        // Default new products to the tenant's configured costing method when the
        // operator didn't pick one (pos-cost-roles-spec §1). Variants inherit the
        // parent's method instead so the family is costed consistently.
        costingMethod: parent
          ? (dto.costingMethod ?? parent.costingMethod)
          : await this.resolveCostingMethod(dto.costingMethod),
        standardCost: dto.standardCost ?? parent?.standardCost?.toString(),
        // MSRP (suggested retail price) — per PIECE, display-only, never money math.
        // 0/negative are normalized to null (never rendered as $0.00).
        msrp: normalizeMsrpForWrite(dto.msrp),
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
    this.emitProductChanged(created.id, "created");
    return created;
  }

  async update(id: string, dto: UpdateProductDto, options?: { suppressEmit?: boolean }) {
    await this.assertCanFlagTobacco(dto.isTobacco);
    if (dto.msrp !== undefined) await this.assertMsrpAllowed();
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
    // ── Compliance-pack sync: an isTobacco-only PATCH (the mobile quick-toggle)
    // is sugar for a Tobacco-type assign/unassign. When the request also carries
    // an explicit trackedCategoryId, the category wins and the mirror derivation
    // below reconciles the flag. Deliberately placed AFTER the uniqueness checks
    // and given the request's end state: resolving the type can SEED it, and a
    // request rejected after that write would leave an orphan regulated section
    // behind (the seed and the product write are not one transaction).
    let unflagClear = false;
    if (dto.isTobacco !== undefined && dto.trackedCategoryId === undefined) {
      if (dto.isTobacco === true) {
        const tobacco = await this.resolveOrCreateTobaccoCategory({
          // A move into the Tobacco type clears the old section's subcategory,
          // so only an EXPLICIT subcategory survives into the end state.
          trackedSubcategoryId: dto.trackedSubcategoryId ?? null,
          regItemType: dto.regItemType !== undefined ? dto.regItemType : existing.regItemType,
          regUomCase: dto.regUomCase !== undefined ? dto.regUomCase : existing.regUomCase,
          regUomUnit: dto.regUomUnit !== undefined ? dto.regUomUnit : existing.regUomUnit,
        });
        if (existing.trackedCategoryId !== tobacco.id) {
          dto.trackedCategoryId = tobacco.id;
          // A section move always clears the old section's subcategory (the
          // parent==section invariant) unless the request set one explicitly.
          if (dto.trackedSubcategoryId === undefined) dto.trackedSubcategoryId = null;
        }
      } else {
        const tobacco = await this.findTobaccoCategory();
        if (tobacco && existing.trackedCategoryId === tobacco.id) {
          dto.trackedCategoryId = null; // un-flagging = leaving the Tobacco type
          unflagClear = true;
        }
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
    // A clear that came from the isTobacco quick-toggle (`unflagClear`) leaves the
    // trio ALONE instead: "Unmark tobacco product" is a single unconfirmed menu
    // action that used to write ONLY the boolean, re-flagging does not restore the
    // codes, and the filing resolves item type / UoM from the product row LIVE — so
    // discarding them there would silently restate already-filed periods. A detached
    // product keeping the config its historic ledger rows are reported under is
    // exactly the tolerated state the comment above describes. The DTO is still
    // stripped, so an API-direct caller can't slip unvalidated codes in either.
    if (clearingSection) {
      if (unflagClear) {
        delete data.regItemType;
        delete data.regUomCase;
        delete data.regUomUnit;
      } else {
        data.regItemType = null;
        data.regUomCase = null;
        data.regUomUnit = null;
      }
    }
    // One-category-axis rule: keep Product.category in sync with the structured
    // category so filters/analytics/buyer facets never see the type name instead
    // of "Zyn". See products.service.spec "category sync" scenarios.
    if (typeof dto.trackedSubcategoryId === "string") {
      // Structured category being SET/CHANGED — its name wins over any
      // dto.category sent in the same request (the form never sends both;
      // imports/legacy clients shouldn't be able to desync the axis).
      const sub = await this.prisma.forTenant().trackedSubcategory.findFirst({
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
    // MSRP: normalize 0/negative to null even though the spread already carries
    // dto.msrp through — a bare "0" decimal string must never persist.
    if (dto.msrp !== undefined) {
      data.msrp = normalizeMsrpForWrite(dto.msrp);
    }
    // ── Mirror derivation: after this write, isTobacco always reflects membership
    // in the Tobacco type. Recomputed only when the section actually changes or
    // the caller sent isTobacco — unrelated PATCHes never touch the flag.
    if (sectionChanged || dto.isTobacco !== undefined) {
      if (effectiveCategoryId == null) {
        data.isTobacco = false;
      } else {
        const cat = await this.prisma.forTenant().trackedCategory.findFirst({
          where: { id: effectiveCategoryId },
          select: { name: true },
        });
        data.isTobacco = isTobaccoCategoryName(cat?.name);
      }
    }
    // The primary path for a price change, an isActive toggle, or a category/MSRP
    // edit — but not the only writer of those fields (remove() also flips
    // isActive, bulkSetMsrp() also writes msrp) or of Product rows in general
    // (import/variant-resolution paths write directly and emit nothing; see
    // products.gateway-emit.spec.ts for the paths that DO emit).
    const updated = await this.prisma.forTenant().product.update({
      where: { id },
      data,
    });
    // suppressEmit lets a caller that loops this method (bulkAssignParent) emit
    // ONE coalesced event after the loop instead of one per row.
    if (!options?.suppressEmit) this.emitProductChanged(id, "updated");
    return updated;
  }

  /**
   * POST /products/msrp/bulk — the primary MSRP bulk-edit path (mirrors
   * bulkSetCostBasis: validate every id belongs to the tenant, then one
   * tenantTransaction). The route itself is gated by @RequirePlanFlag —
   * unlike create/update this endpoint has no OTHER purpose a flag-less
   * tenant needs, so gating the whole route (rather than per-field) is correct
   * here. Returns warnings (never blocks) for rows whose new MSRP undercuts the
   * product's wholesale per-piece price.
   */
  async bulkSetMsrp(dto: BulkSetMsrpDto) {
    const productIds = Array.from(new Set(dto.items.map((i) => i.productId)));
    const products = await this.prisma.forTenant().product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, pricePerUnit: true, unitsPerBox: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));
    const missing = productIds.filter((id) => !productMap.has(id));
    if (missing.length > 0) {
      throw new NotFoundException({
        message: "One or more products could not be found",
        missingProductIds: missing,
      });
    }

    const result = await this.prisma.tenantTransaction(async (tx) => {
      let updated = 0;
      const warnings: Array<{ productId: string; msrp: number; wholesalePerPiece: number }> = [];
      for (const item of dto.items) {
        const normalized = normalizeMsrpForWrite(item.msrp == null ? null : String(item.msrp));
        await tx.product.update({ where: { id: item.productId }, data: { msrp: normalized } });
        updated++;
        if (normalized != null) {
          const product = productMap.get(item.productId)!;
          if (isMsrpBelowWholesale(normalized, product.pricePerUnit, product.unitsPerBox)) {
            warnings.push({
              productId: item.productId,
              msrp: Number(normalized),
              wholesalePerPiece: wholesalePerPiece(product.pricePerUnit, product.unitsPerBox) ?? 0,
            });
          }
        }
      }
      return { updated, warnings };
    });
    // ONE coalesced event for the whole batch, never one per row — the payload
    // carries no data, so clients just mark the catalog families stale.
    if (result.updated > 0) this.emitProductChanged(null, "bulk");
    return result;
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
    const sub = await this.prisma.forTenant().trackedSubcategory.findFirst({
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
    const cat = await this.prisma.forTenant().trackedCategory.findFirst({
      where: { id: trackedCategoryId },
      select: { name: true, reportTemplate: true },
    });
    if (!cat) throw new BadRequestException("Regulated type not found");
    this.assertRegConfigMatchesTemplate(cat, { regItemType, regUomCase, regUomUnit });
  }

  /**
   * The template half of `assertRegConfigValid`, split out so a section that does
   * not exist YET — the Tobacco type `resolveOrCreateTobaccoCategory` is about to
   * seed — can be validated from its known template before anything is written.
   */
  private assertRegConfigMatchesTemplate(
    cat: { name: string; reportTemplate: string },
    trio: { regItemType: string | null; regUomCase: string | null; regUomUnit: string | null },
  ): void {
    const { regItemType, regUomCase, regUomUnit } = trio;
    if (!regItemType && !regUomCase && !regUomUnit) return;
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
    const parent = await this.prisma.forTenant().product.findFirst({
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
        // suppressEmit: this loop can reassign N products in one request — emit
        // ONE coalesced event after the loop below, never one per row (the same
        // rule bulkSetMsrp/bulkDelete/importFromZoho already follow).
        await this.update(
          assignment.id,
          {
            parentProductId: dto.parentProductId,
            variantName: assignment.variantName,
            // Variants store JUST the variant name in `name` (PR #44).
            name: assignment.variantName,
          } as UpdateProductDto,
          { suppressEmit: true },
        );
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
    // ONE coalesced event for the whole request, never one per reassigned row —
    // each call above ran with suppressEmit so this is the only emit it produces.
    if (succeeded.length > 0) this.emitProductChanged(null, "bulk");
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
    const archived = await this.prisma
      .forTenant()
      .product.update({ where: { id }, data: { isActive: false } });
    this.emitProductChanged(id, "archived");
    return archived;
  }

  async clearAll(): Promise<{
    deleted: number;
    softDeleted: number;
    skipped: Array<{ id: string; reason: string }>;
  }> {
    // Tenant-scoped by construction.
    //
    // This previously ran `TRUNCATE TABLE "Product" CASCADE`. TRUNCATE takes no
    // WHERE clause and is NOT subject to row-level security, so any single tenant's
    // OPERATOR calling DELETE /products/clear-all destroyed the catalog, orders,
    // invoices and inventory of EVERY tenant on the platform — while the returned
    // count, read through forTenant(), reported only the caller's own products and
    // so hid the true blast radius.
    //
    // bulkDelete() reaches every dependent table through forTenant(), so it can only
    // ever touch the caller's own rows, and it clears the five RESTRICT dependents
    // (OrderTemplateItem, PurchaseOrderItem, ReturnItem, StockLot, StockMovement)
    // before the products themselves. The remaining FKs are CASCADE or SET NULL.
    //
    // R1's per-id classification applies here too, so "clear all" is not a wipe:
    // a product with order/invoice/stock history is deactivated rather than
    // destroyed, and one with active order items is skipped. The full
    // {deleted, softDeleted, skipped} breakdown is passed through unchanged —
    // reporting only `deleted` would read as 0 on a catalog that was in fact
    // fully cleared by deactivation.
    const ids = (await this.prisma.forTenant().product.findMany({ select: { id: true } })).map(
      (p) => p.id,
    );
    return this.bulkDelete(ids);
  }

  async bulkDelete(ids: string[]): Promise<{
    deleted: number;
    softDeleted: number;
    skipped: Array<{ id: string; reason: string }>;
  }> {
    if (ids.length === 0) return { deleted: 0, softDeleted: 0, skipped: [] };

    // R1: per-id classification before any delete — this used to hard-delete
    // every id unconditionally, which meant a product with real order/invoice
    // history (or, worse, an in-flight order) lost that history the instant
    // it was swept up in a bulk selection. Three outcomes, same as remove():
    //   1. active order items (not DELIVERED/CANCELLED) -> skip, reported by name
    //   2. any other reference in the dependent tables  -> soft-delete
    //      (isActive:false, exactly what remove() does), touching NO rows
    //   3. reference-free                                -> hard delete
    const products = await this.prisma
      .forTenant()
      .product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const nameById = new Map(products.map((p) => [p.id, p.name]));

    // ONE grouped query for the whole batch, never one count per id: the DTO
    // allows 500 ids and clearAll() passes the entire catalog, so a per-id
    // `count` would be hundreds of sequential round-trips in a single request.
    const activeGroups = await this.prisma.forTenant().orderItem.groupBy({
      by: ["productId"],
      where: { productId: { in: ids }, status: { notIn: ["DELIVERED", "CANCELLED"] } },
    });
    const activeIds = new Set(
      activeGroups.map((g) => g.productId).filter((id): id is string => !!id),
    );

    const skipped: Array<{ id: string; reason: string }> = [];
    const remaining: string[] = [];
    for (const id of ids) {
      if (activeIds.has(id)) {
        skipped.push({
          id,
          reason: `${nameById.get(id) ?? id} has active order items and cannot be deleted`,
        });
        continue;
      }
      remaining.push(id);
    }

    if (remaining.length === 0) {
      return { deleted: 0, softDeleted: 0, skipped };
    }

    // One GROUPED query per dependent table (not per id, and never a row
    // fetch): `groupBy` collapses to at most one row per referenced product,
    // so probing a 500-id batch costs eleven bounded queries however much
    // order/invoice/stock history those products carry — a plain `findMany`
    // would drag every referencing row into API memory just to build this set.
    // Each delegate's `groupBy` has an incompatible generic signature from the
    // next, so the array is typed loosely here — only `productId` is ever read
    // off the result.
    const referencedIds = new Set<string>();
    const dependentModels: Array<{
      groupBy: (args: unknown) => Promise<Array<{ productId: string | null }>>;
    }> = [
      this.prisma.forTenant().orderItem,
      this.prisma.forTenant().invoiceItem,
      this.prisma.forTenant().stockMovement,
      this.prisma.forTenant().vendorBillItem,
      this.prisma.forTenant().purchaseOrderItem,
      this.prisma.forTenant().estimateItem,
      this.prisma.forTenant().returnItem,
      this.prisma.forTenant().recurringInvoiceItem,
      this.prisma.forTenant().orderTemplateItem,
      this.prisma.forTenant().deliveryMutation,
      this.prisma.forTenant().stockLot,
    ];
    for (const model of dependentModels) {
      const groups = await model.groupBy({
        by: ["productId"],
        where: { productId: { in: remaining } },
      });
      for (const group of groups) if (group.productId) referencedIds.add(group.productId);
      // Every remaining id is already known to be referenced — the outcome
      // cannot change, so skip the rest of the tables.
      if (referencedIds.size === remaining.length) break;
    }

    const softDeleteIds = remaining.filter((id) => referencedIds.has(id));
    const hardDeleteIds = remaining.filter((id) => !referencedIds.has(id));

    if (softDeleteIds.length > 0) {
      await this.prisma
        .forTenant()
        .product.updateMany({ where: { id: { in: softDeleteIds } }, data: { isActive: false } });
    }

    if (hardDeleteIds.length > 0) {
      // Delete all dependent records first, then the products themselves —
      // scoped to only the reference-free ids.
      await this.prisma.$transaction([
        this.prisma
          .forTenant()
          .customerPrice.deleteMany({ where: { productId: { in: hardDeleteIds } } }),
        this.prisma
          .forTenant()
          .recurringInvoiceItem.deleteMany({ where: { productId: { in: hardDeleteIds } } }),
        this.prisma
          .forTenant()
          .productMapping.deleteMany({ where: { productId: { in: hardDeleteIds } } }),
        this.prisma
          .forTenant()
          .vendorBillItem.deleteMany({ where: { productId: { in: hardDeleteIds } } }),
        this.prisma
          .forTenant()
          .estimateItem.deleteMany({ where: { productId: { in: hardDeleteIds } } }),
        this.prisma
          .forTenant()
          .returnItem.deleteMany({ where: { productId: { in: hardDeleteIds } } }),
        this.prisma
          .forTenant()
          .purchaseOrderItem.deleteMany({ where: { productId: { in: hardDeleteIds } } }),
        this.prisma
          .forTenant()
          .invoiceItem.deleteMany({ where: { productId: { in: hardDeleteIds } } }),
        this.prisma
          .forTenant()
          .orderTemplateItem.deleteMany({ where: { productId: { in: hardDeleteIds } } }),
        this.prisma
          .forTenant()
          .deliveryMutation.deleteMany({ where: { productId: { in: hardDeleteIds } } }),
        this.prisma
          .forTenant()
          .orderItem.deleteMany({ where: { productId: { in: hardDeleteIds } } }),
        this.prisma
          .forTenant()
          .stockLot.deleteMany({ where: { productId: { in: hardDeleteIds } } }),
        this.prisma
          .forTenant()
          .stockMovement.deleteMany({ where: { productId: { in: hardDeleteIds } } }),
        this.prisma.forTenant().product.deleteMany({ where: { id: { in: hardDeleteIds } } }),
      ]);
    }

    // ONE coalesced event for the whole batch (clearAll delegates HERE, so it
    // must NOT emit as well — that would double-fire for a single request).
    if (softDeleteIds.length > 0 || hardDeleteIds.length > 0) this.emitProductChanged(null, "bulk");
    return { deleted: hardDeleteIds.length, softDeleted: softDeleteIds.length, skipped };
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

        // B562 follow-up: an opening balance written straight onto
        // currentStock with no StockMovement permanently "gaps" this
        // product's ledger — replayProduct (inventory.service.ts) would
        // never see where that quantity came from, so it refuses EVERY
        // future backdated purchase/adjustment on it forever. Model the
        // opening stock as a PURCHASE movement instead, exactly like a real
        // recordPurchase would, so the replay treats it as a legitimate
        // ledger baseline rather than a gap. Wrapped in a transaction so the
        // product and its opening movement land atomically.
        const openingStock = new Prisma.Decimal(item.currentStock ?? "0");
        const openingCost = item.averageCost != null ? new Prisma.Decimal(item.averageCost) : null;
        await this.prisma.tenantTransaction(async (tx) => {
          const created = await tx.product.create({
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
              currentStock: openingStock,
              averageCost: openingCost,
              reorderPoint: item.reorderPoint ?? null,
            },
          });
          if (!openingStock.isZero()) {
            await tx.stockMovement.create({
              data: {
                productId: created.id,
                type: MovementType.PURCHASE,
                quantity: openingStock,
                unitCost: openingCost,
                avgCostAfter: openingCost,
                stockAfter: openingStock,
                notes: "Opening stock (bulk import)",
              },
            });
          }
          return created;
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

    // ONE coalesced event for the whole import, never one per created row.
    if (created > 0) this.emitProductChanged(null, "bulk");
    return { created, skipped, errors };
  }
}
