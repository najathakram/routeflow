import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { FLAG_TO_ADDON_SKU } from "./plan-catalog.constants";
import { PlanGateUpgrade } from "./plan-gate";

/** Editable fields on a plan definition (draft only). */
export interface PlanDefinitionPatch {
  name?: string;
  monthlyPrice?: number | string | null;
  annualPrice?: number | string | null;
  isCustom?: boolean;
  seatsIncluded?: number | null;
  routesConcurrent?: number | null;
  scansIncluded?: number | null;
  msgsIncluded?: number;
  customersIncluded?: number | null;
  featureFlags?: string[];
  sortOrder?: number;
}

/** Editable fields on an add-on SKU (draft only). */
export interface AddonSkuPatch {
  name?: string;
  monthlyPrice?: number | string;
  includedAtPlan?: string | null;
  stackable?: boolean;
  grantsFlags?: string[];
  capacityPerUnit?: number | null;
  sortOrder?: number;
}

/** A PlanVersion with its definitions + addon SKUs eagerly loaded. */
const WITH_CATALOG = {
  definitions: { orderBy: { sortOrder: "asc" } },
  addonSkus: { orderBy: { sortOrder: "asc" } },
} satisfies Prisma.PlanVersionInclude;

export type PlanVersionWithCatalog = Prisma.PlanVersionGetPayload<{ include: typeof WITH_CATALOG }>;

/**
 * Read side of the versioned plan catalog (Plans & Billing). Plans are GLOBAL
 * reference data (not tenant-scoped) — a published PlanVersion holds the four
 * PlanDefinitions and the AddonSku catalog that entitlements resolve against.
 *
 * The draft → publish lifecycle (create/edit/publish new versions) is added by
 * the platform-admin Plans editor in a later phase; this service is the read
 * authority every other billing surface consults.
 */
@Injectable()
export class PlanCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /** The current published catalog version (highest version number), or null if unseeded. */
  async getPublishedVersion(): Promise<PlanVersionWithCatalog | null> {
    return this.prisma.planVersion.findFirst({
      where: { status: "PUBLISHED" },
      orderBy: { version: "desc" },
      include: WITH_CATALOG,
    });
  }

  /** A specific version by id (used when a tenant is pinned to an older version). */
  async getVersionById(id: string): Promise<PlanVersionWithCatalog | null> {
    return this.prisma.planVersion.findUnique({ where: { id }, include: WITH_CATALOG });
  }

  /**
   * Resolve the catalog a tenant should see: its pinned version if still present,
   * otherwise the current published version. Throws if the catalog is unseeded.
   */
  async getVersionForTenant(planVersionId: string | null): Promise<PlanVersionWithCatalog> {
    const version = planVersionId
      ? ((await this.getVersionById(planVersionId)) ?? (await this.getPublishedVersion()))
      : await this.getPublishedVersion();
    if (!version) {
      throw new NotFoundException(
        "No published plan catalog exists. Seed the billing catalog first.",
      );
    }
    return version;
  }

  /** The published catalog (full entity) — for authenticated in-app surfaces. */
  async getPublishedCatalog(): Promise<PlanVersionWithCatalog> {
    const version = await this.getPublishedVersion();
    if (!version) {
      throw new NotFoundException(
        "No published plan catalog exists. Seed the billing catalog first.",
      );
    }
    return version;
  }

  /**
   * The published catalog projected to CUSTOMER-FACING fields only — for the public
   * (unauthenticated) pricing + choose-plan surfaces. Drops internal columns: row ids,
   * planVersionId FKs, publishedBy actor id, authoring notes, and timestamps.
   */
  async getPublicCatalog() {
    const v = await this.getPublishedCatalog();
    return {
      version: v.version,
      effectiveAt: v.effectiveAt,
      plans: v.definitions.map((d) => ({
        planKey: d.planKey,
        name: d.name,
        monthlyPrice: d.monthlyPrice,
        annualPrice: d.annualPrice,
        isCustom: d.isCustom,
        seatsIncluded: d.seatsIncluded,
        routesConcurrent: d.routesConcurrent,
        scansIncluded: d.scansIncluded,
        msgsIncluded: d.msgsIncluded,
        customersIncluded: d.customersIncluded,
        featureFlags: d.featureFlags,
        sortOrder: d.sortOrder,
      })),
      addons: v.addonSkus.map((s) => ({
        sku: s.sku,
        name: s.name,
        monthlyPrice: s.monthlyPrice,
        unit: s.unit,
        includedAtPlan: s.includedAtPlan,
        meteredKey: s.meteredKey,
        capacityPerUnit: s.capacityPerUnit,
        stackable: s.stackable,
        grantsFlags: s.grantsFlags,
        sortOrder: s.sortOrder,
      })),
    };
  }

  /**
   * The upsell target for a missing flag, from the published catalog: the cheapest
   * plan whose featureFlags grant it (LOCKED_PAGE) and the à-la-carte SKU that grants
   * it (INLINE_RESOLVE), if any. Money is returned as a Decimal string. Returns all
   * nulls when the catalog is unseeded (the gate still denies; there's just no CTA).
   */
  async upgradeTargetForFlag(flagKey: string): Promise<PlanGateUpgrade> {
    const empty: PlanGateUpgrade = {
      planKey: null,
      planMonthlyPrice: null,
      addonSku: null,
      addonMonthlyPrice: null,
    };
    const version = await this.getPublishedVersion();
    if (!version) return empty;

    const cheapestPlan = version.definitions
      .filter((d) => d.featureFlags.includes(flagKey) && d.monthlyPrice != null)
      .sort((a, b) => Number(a.monthlyPrice) - Number(b.monthlyPrice))[0];

    const skuCode = FLAG_TO_ADDON_SKU[flagKey];
    const addon = skuCode ? version.addonSkus.find((s) => s.sku === skuCode) : undefined;

    return {
      planKey: cheapestPlan?.planKey ?? null,
      planMonthlyPrice:
        cheapestPlan?.monthlyPrice != null ? cheapestPlan.monthlyPrice.toString() : null,
      addonSku: addon?.sku ?? null,
      addonMonthlyPrice: addon?.monthlyPrice != null ? addon.monthlyPrice.toString() : null,
    };
  }

  // ─── Draft → publish lifecycle (platform-admin authored) ──────────────────────

  /** Every version (newest first) with its definitions + SKUs. */
  async listVersions(): Promise<PlanVersionWithCatalog[]> {
    return this.prisma.planVersion.findMany({
      orderBy: { version: "desc" },
      include: WITH_CATALOG,
    });
  }

  /**
   * Open a new DRAFT version cloned from the current published catalog. Only one
   * draft may exist at a time. Publishing existing tenants is NOT affected — they
   * stay pinned to their version until they next subscribe/change.
   */
  async createDraft(): Promise<PlanVersionWithCatalog> {
    const existingDraft = await this.prisma.planVersion.findFirst({ where: { status: "DRAFT" } });
    if (existingDraft) {
      throw new ConflictException("A draft plan version already exists; edit or discard it first.");
    }
    const published = await this.getPublishedVersion();
    const maxVer = await this.prisma.planVersion.aggregate({ _max: { version: true } });
    const nextVersion = (maxVer._max.version ?? 0) + 1;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const draft = await tx.planVersion.create({
          data: {
            version: nextVersion,
            status: "DRAFT",
            notes: published ? `Draft cloned from v${published.version}` : "Initial draft",
          },
        });
        if (published) {
          await tx.planDefinition.createMany({
            data: published.definitions.map((d) => ({
              planVersionId: draft.id,
              planKey: d.planKey,
              name: d.name,
              monthlyPrice: d.monthlyPrice,
              annualPrice: d.annualPrice,
              isCustom: d.isCustom,
              seatsIncluded: d.seatsIncluded,
              routesConcurrent: d.routesConcurrent,
              scansIncluded: d.scansIncluded,
              msgsIncluded: d.msgsIncluded,
              customersIncluded: d.customersIncluded,
              featureFlags: d.featureFlags,
              sortOrder: d.sortOrder,
            })),
          });
          await tx.addonSku.createMany({
            data: published.addonSkus.map((s) => ({
              planVersionId: draft.id,
              sku: s.sku,
              name: s.name,
              monthlyPrice: s.monthlyPrice,
              unit: s.unit,
              includedAtPlan: s.includedAtPlan,
              meteredKey: s.meteredKey,
              capacityPerUnit: s.capacityPerUnit,
              stackable: s.stackable,
              grantsFlags: s.grantsFlags,
              sortOrder: s.sortOrder,
            })),
          });
        }
        return tx.planVersion.findUniqueOrThrow({ where: { id: draft.id }, include: WITH_CATALOG });
      });
    } catch (e) {
      // Race with another createDraft: the partial-unique index / version-unique
      // constraint rejects the second insert. Surface a clean 409, not a raw P2002.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException(
          "A draft plan version already exists; edit or discard it first.",
        );
      }
      throw e;
    }
  }

  /** Patch a plan definition in a DRAFT version. annualPrice auto-fills to monthly×10 when unset. */
  async updateDefinition(versionId: string, planKey: string, patch: PlanDefinitionPatch) {
    await this.assertDraft(versionId);
    const data: Prisma.PlanDefinitionUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.isCustom !== undefined) data.isCustom = patch.isCustom;
    if (patch.seatsIncluded !== undefined) data.seatsIncluded = patch.seatsIncluded;
    if (patch.routesConcurrent !== undefined) data.routesConcurrent = patch.routesConcurrent;
    if (patch.scansIncluded !== undefined) data.scansIncluded = patch.scansIncluded;
    if (patch.msgsIncluded !== undefined) data.msgsIncluded = patch.msgsIncluded;
    if (patch.customersIncluded !== undefined) data.customersIncluded = patch.customersIncluded;
    if (patch.featureFlags !== undefined) data.featureFlags = patch.featureFlags;
    if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
    if (patch.monthlyPrice !== undefined) {
      data.monthlyPrice = patch.monthlyPrice;
      // Annual is exactly two months free (×10). Keep it in lock-step unless the
      // caller sets it explicitly. Decimal ×10 is exact for a 2-dp price.
      if (patch.annualPrice === undefined) {
        data.annualPrice =
          patch.monthlyPrice == null ? null : new Prisma.Decimal(patch.monthlyPrice).mul(10);
      }
    }
    if (patch.annualPrice !== undefined) data.annualPrice = patch.annualPrice;

    return this.prisma.planDefinition.update({
      where: { planVersionId_planKey: { planVersionId: versionId, planKey } },
      data,
    });
  }

  /** Patch an add-on SKU in a DRAFT version (price/flags/capacity — not the SKU code or meter). */
  async updateSku(versionId: string, sku: string, patch: AddonSkuPatch) {
    await this.assertDraft(versionId);
    const data: Prisma.AddonSkuUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.monthlyPrice !== undefined) data.monthlyPrice = patch.monthlyPrice;
    if (patch.includedAtPlan !== undefined) data.includedAtPlan = patch.includedAtPlan;
    if (patch.stackable !== undefined) data.stackable = patch.stackable;
    if (patch.grantsFlags !== undefined) data.grantsFlags = patch.grantsFlags;
    if (patch.capacityPerUnit !== undefined) data.capacityPerUnit = patch.capacityPerUnit;
    if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;

    return this.prisma.addonSku.update({
      where: { planVersionId_sku: { planVersionId: versionId, sku } },
      data,
    });
  }

  /**
   * Publish a DRAFT version: it becomes PUBLISHED (with effectiveAt=now) and the
   * prior published version is marked SUPERSEDED. New subscribers bind to it;
   * existing tenants stay pinned to their version until they next change plan.
   */
  async publish(versionId: string, actorId?: string): Promise<PlanVersionWithCatalog> {
    const version = await this.prisma.planVersion.findUnique({
      where: { id: versionId },
      include: { definitions: true },
    });
    if (!version) throw new NotFoundException("Plan version not found");
    if (version.status !== "DRAFT") {
      throw new BadRequestException("Only a DRAFT version can be published");
    }
    if (version.definitions.length === 0) {
      throw new BadRequestException("Cannot publish a version with no plan definitions");
    }
    const now = new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.planVersion.updateMany({
          where: { status: "PUBLISHED" },
          data: { status: "SUPERSEDED" },
        });
        return tx.planVersion.update({
          where: { id: versionId },
          data: {
            status: "PUBLISHED",
            publishedAt: now,
            effectiveAt: now,
            publishedBy: actorId ?? null,
          },
          include: WITH_CATALOG,
        });
      });
    } catch (e) {
      // Race with another publish: the partial-unique index on status=PUBLISHED
      // rejects the second one. Surface a clean 409 rather than a raw P2002.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("Another catalog version is already published; retry.");
      }
      throw e;
    }
  }

  /** Discard a DRAFT version (cascades its definitions + SKUs). */
  async discardDraft(versionId: string): Promise<{ discarded: string }> {
    await this.assertDraft(versionId);
    await this.prisma.planVersion.delete({ where: { id: versionId } });
    return { discarded: versionId };
  }

  private async assertDraft(versionId: string): Promise<void> {
    const v = await this.prisma.planVersion.findUnique({
      where: { id: versionId },
      select: { status: true },
    });
    if (!v) throw new NotFoundException("Plan version not found");
    if (v.status !== "DRAFT")
      throw new BadRequestException("Only DRAFT plan versions can be edited");
  }
}
