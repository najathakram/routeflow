import { API_ERROR_CODES } from "../common/api-error-codes";
import { productCodeInUse } from "./product-code-in-use";
import {
  assertSafeProductCategory,
  assertSafeProductNames,
  productCategoryViolation,
  productNameViolation,
} from "../common/text-cell-guards";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { CostingMethod, MovementType, Prisma, StockAlertStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { compressImage } from "../storage/compress.util";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { buildPlanFlagDenial } from "../billing/plan-flag-denial";
import { isDarkFlag } from "../billing/plan-flag-policy";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { FeatureConfigService } from "../billing/feature-config.service";
import { buildPlanGateBody } from "../billing/plan-gate";
import { CreateProductDto } from "./dto/create-product.dto";
import {
  assertImageKeysReorder,
  firstSignableImageKey,
  isOwnProductImageKey,
  signableImageKeys,
} from "./product-image-keys";
import { UpdateProductDto } from "./dto/update-product.dto";
import { BulkAssignParentDto } from "./dto/bulk-assign-parent.dto";
import { BulkSetMsrpDto } from "./dto/bulk-set-msrp.dto";
import { ListProductsDto } from "./dto/list-products.dto";
import { ImportProductsDto } from "./dto/import-products.dto";
import { isValidItemType, isValidUom, templateByKey } from "../regulated/template-registry";
import { normalizeScanCode } from "@routeflow/scanning";
import { findScanMatches } from "./scan-match";
import { buildProductListWhere } from "./product-list-where";
import { assertPackKeepsLevelsValid } from "./unit-pack-rules";
import { isMsrpBelowWholesale, wholesalePerPiece } from "../common/msrp";
import { TOBACCO_CATEGORY_NAME, isTobaccoCategoryName } from "../common/tobacco-category";
import {
  assertBarcodeAvailable,
  lockBarcodeCodes,
  mapBarcodeUniqueViolation,
  syncProductBarcodesFromLegacy,
  syncProductImagesFromLegacy,
} from "./product-catalog-sync";
import { labelNameKey, syncCategoryLabel } from "../product-categories/label-writer";
import { keepLabelsOnReparent } from "../product-labels/keep-labels-on-reparent";
import {
  claimCodes,
  codeClaims,
  lockCodesOfProducts,
  peekProductCodes,
  releaseProductCodes,
  restoreProductCodes,
} from "./product-code-release";
import { assertNameFree, mapNameUniqueViolation } from "./product-name-rules";
import {
  reactivationLockCodes,
  resolveReactivationConflicts,
} from "./product-reactivation-holders";
import { recipeReferenceGroupers } from "./recipe-references";
import { lockAndAssertRecipeGuards } from "./recipe-update-guard";
import {
  applyFamilyPriceBeforeUpdate,
  familyPricesForNewVariant,
  hasPriceColumns,
  lockFamilyRow,
  propagateFamilyPrice,
  readFamilyPriceMode,
} from "./family-price";
import {
  assertValidParent,
  parentInvalid,
  PRODUCT_PARENT_REASONS,
  tenantSafeParent,
  tenantSafeParentView,
} from "./product-parent";
import { scanReadInclude } from "./scan-product-view";
import {
  activeVariantIds,
  assertParentActiveForReactivation,
  cascadeDeactivate,
  familyHasActiveVariants,
  variantCodes,
} from "./product-family-cascade";
import {
  barcodeRowsToView,
  liveBarcodeRows,
  mirrorableImageKeys,
  parseFocalFromKey,
  synthesizeLegacyBarcodes,
} from "./product-barcode-rules";

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

/** One product a bulk delete refused: a machine `code` (clients show fixed copy for it) and the legacy `reason` sentence. */
export interface BulkDeleteSkip {
  id: string;
  code: string;
  reason: string;
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly addonService: AddonService,
    private readonly systemConfig: SystemConfigService,
    // Kept alongside `authority`: buildPlanFlagDenial (the forecasting gate's denial body) reads it.
    private readonly entitlements: EntitlementsService,
    private readonly planCatalog: PlanCatalogService,
    private readonly gateway: RouteFlowGateway,
    // #2198/#2241: the ONE EntitlementAuthority (MSRP + forecasting gates).
    private readonly authority: EntitlementAuthority,
    private readonly featureOverrides: FeatureOverrideService,
    // #2717 M2 (SA-574 Q5): the `mixed_packs` mode read. Optional on purpose — FeatureConfigModule is
    // global, so production always has it; a missing provider reads as mode "off" (no authority).
    @Optional() private readonly featureConfig?: FeatureConfigService,
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

  /** Public wrapper so a bulk-write caller (e.g. CSV import) can fire ONE coalesced
   * catalog-changed event after its own loop, instead of one per row. */
  emitCatalogBulkChanged(): void {
    this.emitProductChanged(null, "bulk");
  }

  /**
   * MSRP writes are flag-gated INSIDE the service, not on the whole route —
   * gating the whole create/update PATCH would 403 an ordinary product edit for
   * a tenant that never touches MSRP. Callers only invoke this when the DTO
   * actually carries an `msrp` key.
   */
  async assertMsrpAllowed(): Promise<void> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return; // no tenant context (e.g. SUPER_ADMIN) — nothing to gate
    // #2198: the ONE evaluation point the flag.msrp route guard uses (overrides + live-mode resolver).
    if (await this.authority.can(tenantId, "flag.msrp")) return;
    const upgrade = await this.planCatalog.upgradeTargetForFlag("flag.msrp").catch(() => ({
      planKey: null,
      planMonthlyPrice: null,
      addonSku: null,
      addonMonthlyPrice: null,
    }));
    throw new ForbiddenException(buildPlanGateBody("flag.msrp", upgrade));
  }

  /**
   * Reorder Point / Reorder Qty are a flag.forecasting feature: their original writer,
   * PATCH /inventory/products/:id/reorder-settings, is @RequirePlanFlag("flag.forecasting").
   * Every other writer (create, update, the bulk import, the CSV importer's file gate) asks
   * THIS, which makes the same decision PlanFlagGuard makes for that route — the
   * EntitlementAuthority verdict, overrides and the DARK_PLAN_FLAGS courtesy allow included — so
   * no writer is an ungated side door. Called only when the payload carries either field.
   */
  async assertReorderAllowed(): Promise<void> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return; // no tenant context (e.g. SUPER_ADMIN) — nothing to gate
    if (await this.authority.can(tenantId, "flag.forecasting")) {
      // Ships DARK (DARK_PLAN_FLAGS, PLAN_FLAG_ENFORCEMENT off): the authority allowed by the
      // courtesy, so log the would-deny from ITS OWN resolver (preset + grants − denies — no second
      // plan-lookup path) to make the blast radius readable before the flag is enforced.
      if (isDarkFlag("flag.forecasting")) {
        try {
          const resolved = await this.authority.resolveAll(tenantId);
          if (resolved?.byKey.get("flag.forecasting")?.effective === false) {
            this.logger.warn(
              `reorder gate would deny (dark): flag=flag.forecasting tenant=${tenantId}`,
            );
          }
        } catch {
          // Observation only: a resolver failure never turns an allowed write into a refusal.
        }
      }
      return;
    }
    // The guard's own deny-body builder (override DENY → no upgrade CTA; unresolvable →
    // PLAN_GATE_UNAVAILABLE), so this 403 can never drift from the inventory route's.
    throw await buildPlanFlagDenial(
      {
        featureOverrides: this.featureOverrides,
        entitlements: this.entitlements,
        catalog: this.planCatalog,
        logger: this.logger,
      },
      tenantId,
      "flag.forecasting",
    );
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
  async assertCanFlagTobacco(isTobacco?: boolean) {
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

    const where: any = buildProductListWhere(query, opts);

    // Always include `parent` so the web can compose "<Parent> - <Variant>"
    // display names for line items. The parent row is small (no nested
    // relations) so this is cheap. variants{} is still gated behind
    // includeVariants since it materially expands the payload.
    // B1211 (read side): `tenantId` is selected only to drop a parent / variant from another tenant, and
    // is removed again below, so the response keeps its shape.
    const readTenantId = this.prisma.getTenantId();
    const includeRelations = {
      parent: {
        select: { id: true, name: true, kind: true, portalVisible: true, tenantId: true },
      },
      // #2717 M1 (SA-572b Q5): additive barcodes[] on the list too (rows, else synthesized below).
      barcodes: { orderBy: { level: "asc" as const } },
      ...(query.includeVariants
        ? {
            variants: {
              where: { isActive: true, ...(readTenantId ? { tenantId: readTenantId } : {}) },
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
        // #2533: only a key under this product's own prefix is ever signed.
        const thumbKey = firstSignableImageKey(p.id, p.imageKeys);
        const thumbnailUrl = thumbKey ? await this.storage.presignedUrl(thumbKey) : null;
        // #2717 M1 (SA-572b Q5): rows first, else synthesized from the legacy columns.
        const pBarcodeRows = (p as { barcodes?: unknown[] }).barcodes ?? [];
        const barcodes =
          pBarcodeRows.length > 0
            ? barcodeRowsToView(pBarcodeRows as Parameters<typeof barcodeRowsToView>[0])
            : synthesizeLegacyBarcodes({ barcode: p.barcode, unitsPerBox: p.unitsPerBox });
        return {
          ...p,
          parent: tenantSafeParentView(p.parent, readTenantId),
          thumbnailUrl,
          barcodes,
        };
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
    // B1211 (read side): a variant / parent link is only followed inside THIS tenant, so a link that
    // predates the write-time parent check can never hand back another tenant's row.
    const readTenantId = this.prisma.getTenantId();
    const product = await this.prisma.forTenant().product.findUnique({
      where: { id },
      include: {
        variants: {
          ...(readTenantId ? { where: { tenantId: readTenantId } } : {}),
          orderBy: [{ isActive: "desc" as const }, { variantName: "asc" as const }],
        },
        parent: true,
        // Phase 4: the assigned regulated ("separately handled") section +
        // subcategory, shown on the product detail. Null for standard products.
        trackedCategory: { select: { id: true, name: true } },
        trackedSubcategory: { select: { id: true, name: true, trackedCategoryId: true } },
        // #2717 M1 (SA-572b Q5): rows first; synthesized from the legacy columns below when empty.
        barcodes: { orderBy: { level: "asc" as const } },
        images: { orderBy: { sortOrder: "asc" as const } },
      },
    });
    if (!product) throw new NotFoundException("Product not found");
    // Attach presigned image URLs so the frontend can render them directly. #2533: only keys under
    // this product's own prefix are returned or signed; imageUrls[i] still lines up with imageKeys[i].
    const imageKeys = signableImageKeys(product.id, product.imageKeys);
    const imageUrls = imageKeys.length > 0 ? await this.storage.presignedUrls(imageKeys) : [];
    // P5-03: operator waitlist count — additive, buyer-facing DTOs never see it.
    const stockAlertCount = await this.prisma.forTenant().stockAlert.count({
      where: { productId: id, status: StockAlertStatus.PENDING },
    });
    // #2717 M1 (SA-572b Q5): additive read-model fallback. Rows exist (post-backfill or a fresh
    // dual-write) -> map them; NO rows yet -> synthesize from the legacy columns (origin "LEGACY").
    // The presigned-url map below reuses the SAME imageKeys/imageUrls pairing above (never a second
    // presign of the same key).
    const urlByKey = new Map(imageKeys.map((k, i) => [k, imageUrls[i] ?? null]));
    const barcodeRows = liveBarcodeRows(product.barcodes);
    const imageRows = product.images ?? [];
    const barcodes =
      barcodeRows.length > 0
        ? barcodeRowsToView(barcodeRows)
        : synthesizeLegacyBarcodes({ barcode: product.barcode, unitsPerBox: product.unitsPerBox });
    // #2728 M1 follow-up (SA-572f, amendment 1 — FINAL): a PER-KEY merge over
    // mirrorableImageKeys(product), not an all-or-nothing switch on imageRows.length. A key the
    // dual-write's per-key belt skipped (held by another product) or that's simply never had a row
    // created for it yet still renders — via its LEGACY fallback — right alongside the keys that do
    // have rows, so an edit that (correctly) leaves some keys row-less never blanks the gallery.
    const mirrorKeys = mirrorableImageKeys(product.id, product.imageKeys);
    const imageRowByKey = new Map(imageRows.map((row) => [row.storageKey, row]));
    const images = mirrorKeys.map((key, index) => {
      const existingRow = imageRowByKey.get(key);
      if (existingRow) {
        return {
          storageKey: existingRow.storageKey,
          url: urlByKey.get(existingRow.storageKey) ?? null,
          focalX: existingRow.focalX,
          focalY: existingRow.focalY,
          sortOrder: existingRow.sortOrder,
          isPrimary: existingRow.isPrimary,
          altText: existingRow.altText,
          origin: "ROW" as const,
        };
      }
      const focal = parseFocalFromKey(key);
      return {
        storageKey: key,
        url: urlByKey.get(key) ?? null,
        focalX: focal ? focal.x : null,
        focalY: focal ? focal.y : null,
        sortOrder: index,
        isPrimary: index === 0,
        altText: null,
        origin: "LEGACY" as const,
      };
    });
    return {
      ...product,
      parent: tenantSafeParent(product.parent, readTenantId),
      imageKeys,
      imageUrls,
      stockAlertCount,
      barcodes,
      images,
    };
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

    // Append key to the product's imageKeys array (#2717 M1: dual-write the row in the same tx).
    const tenantIdForUpload = this.prisma.getTenantId();
    if (!tenantIdForUpload) throw new BadRequestException("No tenant context");
    await this.prisma.tenantTransaction(async (tx: any) => {
      // Sync from the value the UPDATE actually wrote (it holds the row lock until commit), never
      // from the earlier read: a concurrent upload's push would otherwise be missing from the rows.
      const written = await tx.product.update({
        where: { id },
        data: { imageKeys: { push: key } },
        select: { imageKeys: true },
      });
      await syncProductImagesFromLegacy(tx, {
        tenantId: tenantIdForUpload,
        productId: id,
        imageKeys: written.imageKeys,
      });
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

    // Remove from R2. #2533: only a file under this product's own prefix is ever deleted; a key
    // planted before the write guard (another tenant's file) is unlinked below but never deleted.
    if (isOwnProductImageKey(id, key)) await this.storage.delete(key);

    // Remove key from array (#2717 M1: dual-write the row in the same tx).
    const tenantIdForDelete = this.prisma.getTenantId();
    if (!tenantIdForDelete) throw new BadRequestException("No tenant context");
    const nextImageKeysDel = product.imageKeys.filter((k) => k !== key);
    await this.prisma.tenantTransaction(async (tx: any) => {
      const written = await tx.product.update({
        where: { id },
        data: { imageKeys: nextImageKeysDel },
        select: { imageKeys: true },
      });
      await syncProductImagesFromLegacy(tx, {
        tenantId: tenantIdForDelete,
        productId: id,
        imageKeys: written.imageKeys,
      });
    });
    return;
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

    // B1211 (read side): only this tenant's variants and parent are followed (see findOne).
    const readTenantId = this.prisma.getTenantId();
    const hit = await findScanMatches(
      this.prisma.forTenant(),
      candidates,
      {},
      scanReadInclude(readTenantId),
    );
    if (!hit) throw new NotFoundException("Product not found");
    return {
      ...hit.product,
      parent: tenantSafeParent(hit.product.parent, readTenantId),
      scanMatch: hit.scanMatch,
    };
  }

  /**
   * Read-only identity checks shared by create() and update(), public so a preview (the CSV
   * import dry run) can ask the same questions without writing. Name uniqueness is scoped by
   * parent, matching the partial unique indexes (variant_name_per_parent): a standalone product
   * is unique among standalone products, a variant among its siblings. A case sku / barcode must
   * not collide with another product's sku|barcode (resp.) or unit code — a sku equal to another
   * product's barcode stays allowed (pre-existing; findByBarcode ranks barcode > sku). A unit code
   * must not collide with ANY product's sku/barcode/unitSku. `excludeId` is the product being
   * updated. Throws exactly what create()/update() always threw.
   */
  async assertIdentityAvailable(
    p: {
      name?: string;
      parentProductId?: string | null;
      sku?: string;
      barcode?: string;
      unitSku?: string | null;
    },
    excludeId?: string,
  ): Promise<void> {
    const db = this.prisma.forTenant().product;
    const notSelf = excludeId ? { id: { not: excludeId } } : {};
    if (p.name !== undefined) {
      const nameTaken = await db.findFirst({
        where: {
          name: { equals: p.name, mode: "insensitive" },
          // SA-603a: an INACTIVE product never holds a name or a code (released in the write tx).
          isActive: true,
          ...notSelf,
          parentProductId: p.parentProductId ?? null,
        },
        select: { id: true },
      });
      if (nameTaken) {
        throw new ConflictException(
          p.parentProductId
            ? `A variant named "${p.name}" already exists for this product`
            : `A product named "${p.name}" already exists`,
        );
      }
    }
    if (p.sku) {
      const clash = await db.findFirst({
        where: { OR: [{ sku: p.sku }, { unitSku: p.sku }], isActive: true, ...notSelf },
      });
      if (clash) throw productCodeInUse("sku", "SKU already exists");
    }
    if (p.barcode) {
      const clash = await db.findFirst({
        where: {
          OR: [{ barcode: p.barcode }, { unitSku: p.barcode }],
          isActive: true,
          ...notSelf,
        },
      });
      if (clash) throw productCodeInUse("barcode", "Barcode already exists");
    }
    if (p.unitSku) {
      const clash = await db.findFirst({
        where: {
          OR: [{ unitSku: p.unitSku }, { sku: p.unitSku }, { barcode: p.unitSku }],
          isActive: true,
          ...notSelf,
        },
        select: { id: true },
      });
      if (clash) {
        throw productCodeInUse(
          "unitSku",
          "Unit code already used by another product's SKU, barcode, or unit code",
        );
      }
    }
  }

  async create(
    dto: CreateProductDto,
    options?: { suppressEmit?: boolean; actorId?: string | null; actorName?: string | null },
  ) {
    assertSafeProductNames(dto); // B964-2: a formula-led name/variantName is refused before any read or write
    // B990: the typed free-text category too, UNCONDITIONALLY: even with a structured subcategory chosen or a parent without one
    // the written value can still be the typed text, and checking at the top is before any read or write.
    if (dto.category !== undefined) assertSafeProductCategory(dto.category);
    await this.assertCanFlagTobacco(dto.isTobacco);
    if (dto.msrp !== undefined) await this.assertMsrpAllowed();
    if (dto.reorderPoint !== undefined || dto.reorderQty !== undefined) {
      await this.assertReorderAllowed();
    }
    // Name (scoped by parent) and sku/barcode/unitSku collisions — see assertIdentityAvailable.
    await this.assertIdentityAvailable({
      name: dto.name,
      parentProductId: dto.parentProductId ?? null,
      sku: dto.sku,
      barcode: dto.barcode,
      unitSku: dto.unitSku,
    });
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
      throw parentInvalid(PRODUCT_PARENT_REASONS.NOT_FOUND, "Parent product not found");
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
    // #2717 M1 (SA-572b Q4/Q6): the resolved costingMethod is computed OUTSIDE the transaction
    // below (it may call resolveCostingMethod, which itself reads/writes SystemConfig) so the tx
    // body stays a plain product-create + barcode-row sync.
    const resolvedCostingMethod = parent
      ? (dto.costingMethod ?? parent.costingMethod)
      : await this.resolveCostingMethod(dto.costingMethod);
    const resolvedUnitsPerBox = dto.unitsPerBox ?? parent?.unitsPerBox ?? undefined;
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("No tenant context");
    // #2717 M2 (SA-574 Q2): a variant of a family takes the family's ladder while the mode is on.
    const familyMode = dto.parentProductId
      ? await readFamilyPriceMode(this.featureConfig, tenantId)
      : "off";
    const created = await this.prisma.tenantTransaction(async (tx: any) => {
      // SA-572b Q4/SA-572c: lock the code BEFORE the create — otherwise a concurrent create of the
      // same code races on the legacy unique index and surfaces a raw P2002 instead of a 409.
      await claimCodes(tx, {
        tenantId,
        productId: null,
        actorId: options?.actorId ?? null,
        codes: codeClaims(dto, null),
      });
      // SA-603a (a): the active-only name check again, under the name lock (code locks first, house order).
      await assertNameFree(tx, {
        tenantId,
        parentProductId: dto.parentProductId ?? null,
        name: dto.name,
        excludeId: null,
      });
      if (dto.barcode) {
        await lockBarcodeCodes(tx, tenantId, [dto.barcode]);
        await assertBarcodeAvailable(tx, { tenantId, productId: null, code: dto.barcode });
      }
      // The parent is judged under its row lock, the same check update() and bulkAssignParent() use: it must
      // exist in THIS tenant, be active and standalone. A FAMILY parent makes the new row a VARIANT.
      let parentKind: string | null = null;
      if (dto.parentProductId) {
        await lockFamilyRow(tx, tenantId, dto.parentProductId);
        ({ parentKind } = await assertValidParent(tx, {
          tenantId,
          id: null,
          parentId: dto.parentProductId,
        }));
      }
      // The family's five columns, read under its row lock (family-price.ts), or today's inheritance.
      const priceColumns =
        dto.parentProductId && familyMode === "on"
          ? await familyPricesForNewVariant(tx, {
              tenantId,
              familyId: dto.parentProductId,
              dto,
            })
          : {
              pricePerUnit: dto.pricePerUnit,
              priceTier2:
                dto.priceTier2 ?? (parent ? parent.priceTier2.toString() : dto.pricePerUnit),
              priceTier3:
                dto.priceTier3 ?? (parent ? parent.priceTier3.toString() : dto.pricePerUnit),
              priceTier4:
                dto.priceTier4 ?? (parent ? parent.priceTier4.toString() : dto.pricePerUnit),
              priceTier5:
                dto.priceTier5 ?? (parent ? parent.priceTier5.toString() : dto.pricePerUnit),
            };
      let row;
      try {
        row = await tx.product.create({
          data: {
            name: dto.name,
            sku: dto.sku,
            barcode: dto.barcode,
            unitSku: dto.unitSku,
            unit: dto.unit,
            ...priceColumns,
            category: syncedCategory ?? dto.category ?? parent?.category ?? undefined,
            description: dto.description,
            isActive: dto.isActive,
            // Inherited-from-parent tobacco skips the addon re-check (top of create):
            // the parent already passed it when IT was flagged. `isTobacco` here is
            // the mirror-derived value computed above (category is the one axis).
            isTobacco,
            costingMethod: resolvedCostingMethod,
            standardCost: dto.standardCost ?? parent?.standardCost?.toString(),
            // MSRP (suggested retail price) — per PIECE, display-only, never money math.
            // 0/negative are normalized to null (never rendered as $0.00).
            msrp: normalizeMsrpForWrite(dto.msrp),
            unitsPerBox: resolvedUnitsPerBox,
            // B858: part of the one create write — never a follow-up update (atomic).
            reorderPoint: dto.reorderPoint,
            reorderQty: dto.reorderQty,
            parentProductId: dto.parentProductId ?? null,
            ...(parentKind === "FAMILY" ? { kind: "VARIANT" as const } : {}),
            variantName: dto.variantName ?? null,
            trackedCategoryId: regulated.trackedCategoryId,
            trackedSubcategoryId: regulated.trackedSubcategoryId,
            regItemType: regulated.regItemType,
            regUomCase: regulated.regUomCase,
            regUomUnit: regulated.regUomUnit,
          },
          include: { variants: true, parent: true },
        });
      } catch (e) {
        try {
          mapBarcodeUniqueViolation(e, dto.barcode ?? "");
        } catch (mapped) {
          mapNameUniqueViolation(mapped, dto.name, dto.parentProductId != null);
        }
      }
      await syncProductBarcodesFromLegacy(tx, {
        tenantId,
        productId: row.id,
        barcode: row.barcode,
        unitsPerBox: row.unitsPerBox,
      });
      // Add-only label sync from the category text this INSERT wrote (same tx).
      await syncCategoryLabel(tx, {
        tenantId,
        productId: row.id,
        text: row.category,
        actor: { id: options?.actorId ?? null, name: options?.actorName ?? null },
      });
      return row;
    });
    if (!options?.suppressEmit) this.emitProductChanged(created.id, "created");
    return created;
  }

  async update(
    id: string,
    dto: UpdateProductDto,
    options?: { suppressEmit?: boolean; actorId?: string | null; actorName?: string | null },
  ) {
    await this.assertCanFlagTobacco(dto.isTobacco);
    if (dto.msrp !== undefined) await this.assertMsrpAllowed();
    if (dto.reorderPoint !== undefined || dto.reorderQty !== undefined) {
      await this.assertReorderAllowed();
    }
    const existing = await this.findOne(id);
    if (
      dto.deactivateHolderIds?.length &&
      !(existing.isActive === false && dto.isActive === true)
    ) {
      throw new BadRequestException(
        "deactivateHolderIds only applies when reactivating an inactive product",
      );
    }
    assertSafeProductNames(dto, existing); // B964-2: change-only against the one read already made
    // B990: change-only for the free-text category, BEFORE resolveOrCreateTobaccoCategory below, so a refusal never leaves an orphan Tobacco type
    if (dto.category !== undefined)
      assertSafeProductCategory(dto.category, existing.category ?? null);
    // #2533: a PATCH may only reorder/drop this product's own images (400 before any write).
    if (dto.imageKeys !== undefined) assertImageKeysReorder(id, existing.imageKeys, dto.imageKeys);
    // The product's effective parent is the dto value if provided (could be null to promote a
    // variant to standalone), otherwise the existing one — so reparenting + renaming in one
    // PATCH checks the RIGHT scope. The name is only re-checked when it or the parent moves.
    const renamedOrReparented = !!dto.name || dto.parentProductId !== undefined;
    await this.assertIdentityAvailable(
      {
        name: renamedOrReparented ? (dto.name ?? existing.name) : undefined,
        parentProductId:
          dto.parentProductId !== undefined ? dto.parentProductId : existing.parentProductId,
        sku: dto.sku,
        barcode: dto.barcode,
        unitSku: dto.unitSku,
      },
      id,
    );
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
    // #2717 M2 (I6, SA-584 B2): the recipe guards run inside the update tx, after the row locks.
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
    // units_v1: a pack edit (name, size, or moving into a regulated section) must not
    // invalidate the unit levels already defined on this product.
    const nextUnit = dto.unit !== undefined ? dto.unit : existing.unit;
    const nextUnitsPerBox = dto.unitsPerBox !== undefined ? dto.unitsPerBox : existing.unitsPerBox;
    const packTouched =
      nextUnit !== existing.unit ||
      (nextUnitsPerBox ?? null) !== (existing.unitsPerBox ?? null) ||
      (sectionChanged && effectiveCategoryId != null);
    if (packTouched) {
      const levels = await this.prisma.forTenant().productUnit.findMany({
        where: { productId: id },
        select: { label: true, factorToBase: true },
      });
      assertPackKeepsLevelsValid(levels, {
        unit: nextUnit,
        unitsPerBox: nextUnitsPerBox,
        regulated: effectiveCategoryId != null,
      });
    }
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
    // Not a column: the one-tx reactivation door reads it from `dto` (see deactivateReactivationHolders).
    delete data.deactivateHolderIds;
    // Not a column either: B1213's family-deactivation confirmation, read from `dto` inside the tx.
    delete data.confirmCascade;
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
    // #2717 M1 (SA-572b Q4/Q6, SA-572c): the effective post-write barcode (the PATCH's value, else the
    // current one) decides which codes to lock and check BEFORE the write; the rows are then synced from
    // the row the UPDATE returns. Always synced on every update: the diff inside the sync helpers
    // writes nothing when nothing moved.
    const effectiveBarcode: string | null | undefined =
      data.barcode !== undefined ? data.barcode : existing.barcode;
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("No tenant context");
    // #2717 M2 (SA-574 Q2): only a price write or an adoption into a family consults the mode.
    const familyMode =
      hasPriceColumns(dto) || dto.parentProductId
        ? await readFamilyPriceMode(this.featureConfig, tenantId)
        : "off";
    let propagatedRows = 0;
    let doorDeactivated: string[] = [];
    let cascaded: string[] = [];
    let keptLabels: string[] | null = null;
    const updated = await this.prisma.tenantTransaction(async (tx: any) => {
      // SA-603a: reactivate restores the retired codes still free; a code this PATCH sets is claimed (an inactive
      // holder is released + audited, an active one is a 409); deactivate releases BEFORE the isActive write.
      const claims = codeClaims(dto, existing);
      const reactivating = existing.isActive === false && data.isActive === true;
      const deactivating = existing.isActive !== false && data.isActive === false;
      const effectiveParent =
        dto.parentProductId !== undefined ? dto.parentProductId : existing.parentProductId;
      // B1213: deactivating a family that still has ACTIVE variants is a coded 409 unless confirmed; a confirmed one
      // deactivates them in this tx, so their codes join the ONE sorted lock call below.
      const cascadeIds = deactivating ? await activeVariantIds(tx, tenantId, id) : [];
      if (cascadeIds.length > 0 && !dto.confirmCascade) {
        throw familyHasActiveVariants(cascadeIds.length);
      }
      // ONE sorted lockBarcodeCodes call for EVERY code this write can touch, taken before the first write or row lock
      // (SA-572c / Opus #2860 B2): the new and old barcode, this product's own live and retired codes (level rows
      // too), the claims and, for the one-tx door, the blocking holders' live codes (their codes are released below).
      // Every later lock in this tx is a subset of it, so it acquires nothing new and cannot invert the order.
      const lockList = [
        effectiveBarcode,
        existing.barcode,
        ...claims.map((c) => c.value),
        ...(await peekProductCodes(tx, tenantId, id)),
        ...(await variantCodes(tx, tenantId, cascadeIds)),
        ...(reactivating
          ? await reactivationLockCodes(tx, {
              tenantId,
              productId: id,
              name: dto.name ?? existing.name,
              parentProductId: effectiveParent,
              skip: claims.map((c) => c.field),
              withHolders: !!dto.deactivateHolderIds?.length,
            })
          : []),
      ].filter((c): c is string => typeof c === "string" && c.trim().length > 0);
      await lockBarcodeCodes(tx, tenantId, lockList);
      // B1213: a variant is only as live as its family. The family row is locked before anything of this variant is
      // written (house order F -> V); a CHANGED parent is judged by assertValidParent below, which refuses an
      // inactive one.
      if (
        reactivating &&
        existing.parentProductId &&
        (dto.parentProductId === undefined || dto.parentProductId === existing.parentProductId)
      ) {
        await assertParentActiveForReactivation(tx, {
          tenantId,
          parentId: existing.parentProductId,
        });
      }
      if (reactivating) {
        // SA-603i: any ACTIVE holder of a retired code / the name is a 409 listing ALL of them; with
        // `deactivateHolderIds` exactly that set is deactivated in this tx (codes -> name -> rows sorted).
        const res = await resolveReactivationConflicts(tx, {
          tenantId,
          productId: id,
          name: dto.name ?? existing.name,
          parentProductId: effectiveParent,
          skip: claims.map((c) => c.field),
          holderIds: dto.deactivateHolderIds,
          actorId: options?.actorId ?? null,
          lockedCodes: new Set(lockList),
        });
        doorDeactivated = res.deactivatedIds;
      }
      if (reactivating) {
        await restoreProductCodes(tx, {
          tenantId,
          productId: id,
          actorId: options?.actorId ?? null,
          skip: claims.map((c) => c.field),
        });
      }
      await claimCodes(tx, {
        tenantId,
        productId: id,
        actorId: options?.actorId ?? null,
        codes: claims,
      });
      // SA-603a (a): a name or parent change, or a reactivation, re-checks the active-only name under its lock;
      // reactivating against an ACTIVE same-name holder is a 409 naming it.
      if (dto.name || dto.parentProductId !== undefined || reactivating) {
        await assertNameFree(tx, {
          tenantId,
          parentProductId:
            dto.parentProductId !== undefined ? dto.parentProductId : existing.parentProductId,
          name: dto.name ?? existing.name,
          excludeId: id,
          reactivating,
        });
      }
      if (effectiveBarcode) {
        await assertBarcodeAvailable(tx, { tenantId, productId: id, code: effectiveBarcode });
      }
      // SA-584 B2: family rows, then this row, then the open-recipe checks (I6/I2/Q1/Q10).
      await lockAndAssertRecipeGuards(tx, {
        tenantId,
        id,
        existing,
        dto,
        effective: {
          trackedCategoryId: effectiveCategoryId ?? null,
          trackedSubcategoryId: effectiveSubcategoryId ?? null,
        },
      });
      // A CHANGED parent is judged here, after the recipe guards took the family rows and this row (house lock
      // order): it must exist in this tenant, be active and standalone, not be this product, and this product
      // must have no variants of its own. A FAMILY parent makes this row a VARIANT. An echo of the current
      // parent is not re-judged (an archived family must not block editing its existing variants).
      if (dto.parentProductId && dto.parentProductId !== existing.parentProductId) {
        const { parentKind } = await assertValidParent(tx, {
          tenantId,
          id,
          parentId: dto.parentProductId,
        });
        if (parentKind === "FAMILY" && existing.kind !== "VARIANT") data.kind = "VARIANT";
        // A VARIANT moved under a STANDARD parent is no variant of a family any more: reset it, as un-parenting does.
        else if (parentKind !== "FAMILY" && existing.kind === "VARIANT") data.kind = "STANDARD";
      }
      // Promoting a variant to standalone (parentProductId: null) must not leave a VARIANT with no parent.
      if (dto.parentProductId === null && existing.kind === "VARIANT") data.kind = "STANDARD";
      // Family price authority: may refuse (409), rewrite `data`'s price columns, or ask for a
      // propagation to this row's children after the write. Off = nothing runs.
      const family =
        familyMode === "on"
          ? await applyFamilyPriceBeforeUpdate(tx, { tenantId, id, existing, dto, data })
          : { propagate: false };
      // Codes + row lock BEFORE the isActive write (Opus #2860 B1): the release takes this product's code locks, then
      // its row lock; the UPDATE below must never be the first thing to lock the row.
      if (deactivating) {
        await releaseProductCodes(tx, { tenantId, productId: id, lockedCodes: new Set(lockList) });
        // The family row is held now: its variants follow in id order (re-read under the lock).
        cascaded = await cascadeDeactivate(tx, {
          tenantId,
          familyId: id,
          lockedCodes: new Set(lockList),
          confirmed: !!dto.confirmCascade,
        });
      }
      // The category text this write REPLACES, read inside the tx (the label sync below compares name keys against it,
      // never the pre-transaction read). A plain read: the UPDATE right after takes the row lock (house lock order).
      const before = await tx.product.findFirst({
        where: { id },
        select: { category: true, parentProductId: true },
      });
      let row;
      try {
        row = await tx.product.update({ where: { id }, data });
      } catch (e) {
        try {
          mapBarcodeUniqueViolation(e, effectiveBarcode ?? "");
        } catch (mapped) {
          mapNameUniqueViolation(mapped, dto.name ?? existing.name, !!existing.parentProductId);
        }
      }
      // Sync from the row the UPDATE returned (the post-write values, under its row lock), not from
      // `existing`: a concurrent image upload between the read and this write would otherwise be
      // dropped from the rows. The lock/assert above used the effective values (same codes).
      await syncProductBarcodesFromLegacy(tx, {
        tenantId,
        productId: id,
        barcode: row.barcode,
        unitsPerBox: row.unitsPerBox,
        previousBarcode: existing.barcode,
      });
      await syncProductImagesFromLegacy(tx, {
        tenantId,
        productId: id,
        imageKeys: row.imageKeys,
      });
      // Add-only label sync, only when the category NAME KEY changed: re-saving the same text (or a case/space
      // variant of it) must not resurrect a membership an operator removed.
      if (labelNameKey(row.category) !== labelNameKey(before?.category ?? existing.category)) {
        await syncCategoryLabel(tx, {
          tenantId,
          productId: id,
          text: row.category,
          actor: { id: options?.actorId ?? null, name: options?.actorName ?? null },
        });
      }
      // H2: a CHANGED parent (incl. an unlink) never drops a label the variant carried through the old one: what was
      // effective before and is not after becomes its own INCLUDE, in this tx (rolls the parent write back on failure).
      const fromParentId = before?.parentProductId ?? existing.parentProductId ?? null;
      if (dto.parentProductId !== undefined && (dto.parentProductId ?? null) !== fromParentId) {
        keptLabels = (
          await keepLabelsOnReparent(tx, {
            tenantId,
            productId: id,
            fromParentId,
            toParentId: dto.parentProductId ?? null,
            text: row.category,
            actor: { id: options?.actorId ?? null, name: options?.actorName ?? null },
          })
        ).keptLabels;
      }
      if (family.propagate) {
        const moved = await propagateFamilyPrice(tx, { tenantId, familyId: id });
        propagatedRows = moved.variants + moved.recipes;
      }
      return row;
    });
    // suppressEmit lets a caller that loops this method (bulkAssignParent) emit
    // ONE coalesced event after the loop instead of one per row.
    if (!options?.suppressEmit) this.emitProductChanged(id, "updated");
    // The one-tx door deactivated blocking products too: buyer/driver caches must not keep them visible (SA-603j LOW, N4).
    if (doorDeactivated.length > 0 || cascaded.length > 0) this.emitProductChanged(null, "bulk");
    // The family edit moved its children's prices: ONE coalesced event, after the commit (L-237).
    if (propagatedRows > 0) this.emitProductChanged(null, "bulk");
    // A reparent reports the labels it kept (names; [] = nothing was lost); any other write returns the row as before.
    return keptLabels ? { ...updated, keptLabels } : updated;
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
    actor?: { actorId?: string | null; actorName?: string | null },
  ): Promise<{
    succeeded: string[];
    failed: { id: string; reason: string }[];
    /** Per child that kept labels it carried through its old parent (children that lost nothing are absent). */
    keptLabels: { id: string; labels: string[] }[];
  }> {
    const bulkTenantId = this.prisma.getTenantId();
    if (!bulkTenantId) throw new BadRequestException("No tenant context");
    await assertValidParent(this.prisma.forTenant(), {
      tenantId: bulkTenantId,
      id: null,
      parentId: dto.parentProductId,
    });
    // B964-2: validate EVERY assignment before the first write: one formula-led variant name rejects the WHOLE request with a coded 400
    // that names the row (index + product id), never a half-applied batch.
    dto.assignments.forEach((assignment, index) => {
      const violation = productNameViolation({ variantName: assignment.variantName });
      if (violation) {
        throw new BadRequestException({
          statusCode: 400,
          code: API_ERROR_CODES.TEXT_CELL_FORMULA_LEAD,
          field: "variantName",
          index,
          productId: assignment.id,
          message: violation,
          error: "Bad Request",
        });
      }
    });
    const succeeded: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    const keptLabels: { id: string; labels: string[] }[] = [];
    for (const assignment of dto.assignments) {
      try {
        // suppressEmit: this loop can reassign N products in one request — emit
        // ONE coalesced event after the loop below, never one per row (the same
        // rule bulkSetMsrp/bulkDelete/importFromZoho already follow).
        const moved = await this.update(
          assignment.id,
          {
            parentProductId: dto.parentProductId,
            variantName: assignment.variantName,
            // Variants store JUST the variant name in `name` (PR #44).
            name: assignment.variantName,
          } as UpdateProductDto,
          {
            suppressEmit: true,
            actorId: actor?.actorId ?? null,
            actorName: actor?.actorName ?? null,
          },
        );
        succeeded.push(assignment.id);
        const labels = (moved as { keptLabels?: string[] } | null)?.keptLabels ?? [];
        if (labels.length > 0) keptLabels.push({ id: assignment.id, labels });
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
    return { succeeded, failed, keptLabels };
  }

  async remove(id: string, options?: { confirmCascade?: boolean }) {
    await this.findOne(id);
    const activeItems = await this.prisma.forTenant().orderItem.count({
      where: { productId: id, status: { notIn: ["DELIVERED", "CANCELLED"] } },
    });
    if (activeItems > 0) {
      throw new BadRequestException("Cannot delete product with active order items");
    }
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("No tenant context");
    let cascaded: string[] = [];
    const archived = await this.prisma.tenantTransaction(async (tx: any) => {
      // B1213: archiving a family with ACTIVE variants is a coded 409 unless confirmed; a confirmed one archives them
      // in this tx, so their codes join the ONE sorted lock call.
      const cascadeIds = await activeVariantIds(tx, tenantId, id);
      if (cascadeIds.length > 0 && !options?.confirmCascade) {
        throw familyHasActiveVariants(cascadeIds.length);
      }
      // SA-603a: archiving releases the codes, so a new product can reuse them. Codes + row lock FIRST, the isActive
      // write after (house order, Opus #2860 B1).
      // ONE sorted lock call for every code of the product (Opus #2860 R1), then the release, then the write.
      const codes = [
        ...(await peekProductCodes(tx, tenantId, id)),
        ...(await variantCodes(tx, tenantId, cascadeIds)),
      ].filter((c) => c.trim().length > 0);
      await lockBarcodeCodes(tx, tenantId, codes);
      await releaseProductCodes(tx, { tenantId, productId: id, lockedCodes: new Set(codes) });
      cascaded = await cascadeDeactivate(tx, {
        tenantId,
        familyId: id,
        lockedCodes: new Set(codes),
        confirmed: !!options?.confirmCascade,
      });
      return tx.product.update({ where: { id }, data: { isActive: false } });
    });
    this.emitProductChanged(id, "archived");
    if (cascaded.length > 0) this.emitProductChanged(null, "bulk");
    return archived;
  }

  async clearAll(): Promise<{
    deleted: number;
    softDeleted: number;
    skipped: BulkDeleteSkip[];
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
    skipped: BulkDeleteSkip[];
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

    const skipped: BulkDeleteSkip[] = [];
    const remaining: string[] = [];
    for (const id of ids) {
      if (activeIds.has(id)) {
        skipped.push({
          id,
          code: API_ERROR_CODES.PRODUCT_HAS_ACTIVE_ORDER_ITEMS,
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
      // #2717 M2: a product a recipe names (RESTRICT FKs) is referenced — soft-delete, never P2003.
      ...recipeReferenceGroupers(this.prisma.forTenant()),
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

    let softDeleteIds = remaining.filter((id) => referencedIds.has(id));
    let hardDeleteIds = remaining.filter((id) => !referencedIds.has(id));

    // B1212: a product that still has variants is never hard-deleted. The variants' parent link is SET NULL on
    // delete, so they would fall back to standalone products and could collide with another product of the same
    // name (a unique violation). A parent keeps (or archives) its variants: refused while one of them stays
    // active, archived when every variant that stays is already inactive or is archived in this same batch, and
    // only hard-deleted when ALL its variants are hard-deleted with it.
    const delTenantId = this.prisma.getTenantId();
    if (!delTenantId) throw new BadRequestException("No tenant context");
    const variantRows = (await this.prisma.forTenant().product.findMany({
      where: { tenantId: delTenantId, parentProductId: { in: remaining } },
      select: { id: true, parentProductId: true, isActive: true },
    })) as Array<{ id: string; parentProductId: string | null; isActive: boolean }>;
    if (variantRows.length > 0) {
      const hardSet = new Set(hardDeleteIds);
      const inBatch = new Set(remaining);
      const refused = new Set<string>();
      const forceSoft = new Set<string>();
      for (const v of variantRows) {
        const parentId = v.parentProductId;
        if (!parentId || hardSet.has(v.id)) continue; // goes away with its parent
        const archivedHere = inBatch.has(v.id) && !hardSet.has(v.id);
        if (v.isActive && !archivedHere) refused.add(parentId);
        else forceSoft.add(parentId);
      }
      for (const id of refused) {
        skipped.push({
          id,
          code: API_ERROR_CODES.FAMILY_HAS_ACTIVE_VARIANTS,
          reason: `${nameById.get(id) ?? id} has variants that are still active; delete or archive them first`,
        });
      }
      softDeleteIds = softDeleteIds.filter((id) => !refused.has(id));
      hardDeleteIds = hardDeleteIds.filter((id) => !refused.has(id));
      for (const id of forceSoft) {
        if (refused.has(id) || !hardDeleteIds.includes(id)) continue;
        hardDeleteIds = hardDeleteIds.filter((h) => h !== id);
        softDeleteIds.push(id);
      }
    }
    if (softDeleteIds.length === 0 && hardDeleteIds.length === 0) {
      return { deleted: 0, softDeleted: 0, skipped };
    }

    if (softDeleteIds.length > 0) {
      const clearTenantId = this.prisma.getTenantId();
      if (!clearTenantId) throw new BadRequestException("No tenant context");
      await this.prisma.tenantTransaction(async (tx: any) => {
        // SA-603a: an archived product releases its codes (same rule as remove()), codes + row lock FIRST in sorted id
        // order, THEN the isActive write (Opus #2860 B1).
        // ONE sorted lock call over EVERY soft-deleted product's codes BEFORE the loop (Opus #2860 r2): per-product
        // lock-then-row would deadlock against a concurrent PATCH B {sku: <A's code>} (codes A -> row A -> codes B).
        const lockedCodes = await lockCodesOfProducts(tx, clearTenantId, softDeleteIds);
        for (const productId of [...softDeleteIds].sort()) {
          // eslint-disable-next-line no-await-in-loop
          await releaseProductCodes(tx, { tenantId: clearTenantId, productId, lockedCodes });
        }
        await tx.product.updateMany({
          where: { id: { in: softDeleteIds } },
          data: { isActive: false },
        });
      });
    }

    if (hardDeleteIds.length > 0) {
      // Delete all dependent records first, then the products themselves —
      // scoped to only the reference-free ids.
      try {
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
      } catch (e) {
        // B1212: a unique violation (e.g. a variant orphaned by the delete colliding with a same-named product) is a
        // coded 409 (the delete is one transaction), never an uncoded 500.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          throw new ConflictException({
            code: API_ERROR_CODES.PRODUCT_DELETE_CONFLICT,
            message:
              "A product in this selection changed while it was being deleted, so the delete did not go through. Reload the list and try again.",
          });
        }
        throw e;
      }
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
    // Same flag.forecasting gate as every other reorder writer — the whole batch is refused
    // before any write when one item carries a reorder point.
    if (dto.items.some((item) => item.reorderPoint != null)) await this.assertReorderAllowed();

    let created = 0;
    let skipped = 0;
    const errors: Array<{ row: number; name: string; reason: string }> = [];

    for (let i = 0; i < dto.items.length; i++) {
      const item = dto.items[i];
      const rowNum = i + 1;

      try {
        // Check for duplicate name
        const nameTaken = await this.prisma.forTenant().product.findFirst({
          where: { name: { equals: item.name, mode: "insensitive" }, isActive: true },
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
            .product.findFirst({ where: { sku: item.sku, isActive: true } });
          if (existing) {
            skipped++;
            continue;
          }
        }

        // Check for duplicate barcode
        if (item.barcode) {
          const existing = await this.prisma.forTenant().product.findFirst({
            where: { barcode: item.barcode, isActive: true },
          });
          if (existing) {
            // If no SKU collision but barcode exists, skip
            skipped++;
            continue;
          }
        }

        // B964-2: a formula-led NEW name rejects THIS row (readable reason); the rest of the batch still imports. Checked only
        // once the row would actually be created (change-only): a name that matches a stored product is a plain skip above.
        const nameViolation =
          productNameViolation({ name: item.name }) ?? productCategoryViolation(item.category);
        if (nameViolation) {
          errors.push({ row: rowNum, name: item.name, reason: nameViolation });
          continue;
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
        const tenantIdForBulk = this.prisma.getTenantId();
        if (!tenantIdForBulk) throw new BadRequestException("No tenant context");
        await this.prisma.tenantTransaction(async (tx: any) => {
          // #2717 M1 (SA-572b Q4/Q6): lock+check BEFORE the create, same as the single-row create().
          await claimCodes(tx, {
            tenantId: tenantIdForBulk,
            productId: null,
            actorId: null,
            codes: codeClaims(item, null),
          });
          if (item.barcode) {
            await lockBarcodeCodes(tx, tenantIdForBulk, [item.barcode]);
            await assertBarcodeAvailable(tx, {
              tenantId: tenantIdForBulk,
              productId: null,
              code: item.barcode,
            });
          }
          let created: { id: string };
          try {
            created = await tx.product.create({
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
          } catch (e) {
            mapBarcodeUniqueViolation(e, item.barcode ?? "");
          }
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
          await syncProductBarcodesFromLegacy(tx, {
            tenantId: tenantIdForBulk,
            productId: created.id,
            barcode: item.barcode ?? null,
            unitsPerBox: null,
          });
          await syncCategoryLabel(tx, {
            tenantId: tenantIdForBulk,
            productId: created.id,
            text: item.category,
          });
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
