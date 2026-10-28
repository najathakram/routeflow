import { Injectable, Logger } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StorageService } from "../storage/storage.service";
import { ProductsService } from "../products/products.service";
import { ProductFamiliesService } from "../products/product-families.service";
import { ProductUnitsService } from "../products/product-units.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { assertSafeProductNames } from "../common/text-cell-guards";
import {
  assertApplyAllowed,
  assertConfirmed,
  type CopyArgs,
  CopyRefusal,
} from "./catalog-copy.guard";
import {
  buildFamilyContainerInput,
  buildLadderLevelInput,
  buildProductCreateInput,
  planCatalogCopy,
  readPrices,
  toMoney,
  type CopyPlan,
  type CopySource,
  type PlannedFamily,
  type TargetCatalog,
} from "./catalog-copy.plan";

/** Storage and compression load on a live API's bucket: photos go one at a time (G6). */
export const PHOTO_CONCURRENCY = 1;
/** The page size of the source read; the source is only ever read. */
const PAGE = 500;
/** The entitlement the unit-ladder writer sits behind (`product-units.controller.ts`). */
const UNITS_FLAG = "flag.units_v1";

/** The columns `create` carries (rule 3) plus what the plan and the report need. Nothing else is read for a write. */
interface SourceRow extends CopySource {
  // the columns no app writer takes (rule 3): read only so the dry run can list what will differ
  packLabel: string | null;
  baseUnitLabel: string | null;
  orderUnitRef: string;
  invoiceUnitRef: string | null;
  invoiceLineCode: string | null;
  familyPriceOverride: boolean;
  hasTierUnits: boolean;
}

export const DIFFERS_COLUMNS = [
  "packLabel",
  "baseUnitLabel",
  "orderUnitRef",
  "invoiceUnitRef",
  "invoiceLineCode",
  "familyPriceOverride",
  "tierUnits",
  // display-only, but `create` refuses it unless the target holds flag.msrp (the same gate as the UI)
  "msrp",
] as const;
export type DiffersColumn = (typeof DIFFERS_COLUMNS)[number];

/** What the target holds that decides a write: the ladder writer's flag and the MSRP gate. */
interface TargetState extends TargetCatalog {
  msrp: boolean;
}

export interface PhotoRecord {
  sourceKey: string;
  status: "copied" | "failed" | "missing";
  detail?: string;
}

export interface ManifestEntry {
  sourceId: string;
  targetId: string;
  sku: string | null;
  photos: PhotoRecord[];
}

/** One thing the run could not do: a family that was not copied ("copy"), or a product its undo could not remove ("undo"). */
export interface CopyError {
  rootId: string;
  kind: "copy" | "undo";
  message: string;
}

export interface Manifest {
  version: 1;
  createdAt: string;
  source: string;
  target: string;
  entries: ManifestEntry[];
  /** The same rows as the report's `errors`, so a manifest alone says what is left at the target. */
  errors?: CopyError[];
}

/** A family that failed, with the rows its undo left (an id `bulkDelete` skipped or archived, or an undo that threw). */
class FamilyFailure extends Error {
  constructor(
    cause: Error,
    readonly undo: CopyError[],
  ) {
    super(cause.message);
    this.name = "FamilyFailure";
  }
}

export interface CopyReport {
  mode: "dry-run" | "apply";
  /** Source rows read (active only). */
  sourceProducts: number;
  inactiveLeftOut: number;
  /** RECIPE products: counted and listed, not built (rule 3: with 0 there is nothing to build). */
  recipesLeftOut: string[];
  families: number;
  toCreate: number;
  skippedBySku: string[];
  skippedByName: number;
  variantsSkipped: string[];
  regulated: number;
  regulatedIds: string[];
  codesDropped: Array<{ sku: string | null; kind: string; code: string }>;
  packOnly: string[];
  photos: number;
  /** Per column: every source product (by SKU, else id) whose value differs from what the target will hold. */
  differs: Record<DiffersColumn, string[]>;
  unitsV1: boolean;
  /** Set on `--apply`. */
  created?: number;
  photosCopied?: number;
  errors?: CopyError[];
  manifest?: Manifest;
}

export interface RunOptions {
  /** Runs after the plan and the confirmation, before the first write (the CLI's protected-tenant guard). */
  beforeWrite?: (info: { targetTenantId: string; createCount: number }) => Promise<void>;
  /** Called after every family with the manifest so far (written to disk by the runner). */
  onManifest?: (manifest: Manifest) => void;
}

@Injectable()
export class CatalogCopyService {
  private readonly logger = new Logger(CatalogCopyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
    private readonly storage: StorageService,
    private readonly products: ProductsService,
    private readonly families: ProductFamiliesService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private get units(): ProductUnitsService {
    return this.moduleRef.get(ProductUnitsService, { strict: false });
  }
  private get authority(): EntitlementAuthority {
    return this.moduleRef.get(EntitlementAuthority, { strict: false });
  }
  private get entitlements(): EntitlementsService {
    return this.moduleRef.get(EntitlementsService, { strict: false });
  }

  private async tenantBySlug(slug: string): Promise<{ id: string; slug: string }> {
    const t = await this.prisma.tenant.findUnique({
      where: { slug },
      select: { id: true, slug: true },
    });
    if (!t) throw new CopyRefusal("tenant not found for an argument (check --source / --target)");
    return t;
  }

  /** The whole run. Source is only read; every write happens under the TARGET's tenant context. */
  async run(args: CopyArgs, options: RunOptions = {}): Promise<CopyReport> {
    // Rule 5: the refusals come before ANY read of the target's rows.
    assertApplyAllowed(args);
    const source = await this.tenantBySlug(args.source);
    const target = await this.tenantBySlug(args.target);

    const { rows, inactive, recipes } = await this.readSource(source.id);
    const targetCatalog = await this.readTarget(target.id);
    const plan = planCatalogCopy(rows, targetCatalog);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const report = this.buildReport(
      args.apply ? "apply" : "dry-run",
      rows,
      inactive,
      recipes,
      plan,
      byId,
      targetCatalog,
    );
    if (!args.apply) return report;

    assertConfirmed(args, plan.createCount);
    // The counts must not have moved between the plan and the first write.
    const before = await this.targetCount(target.id);
    if (options.beforeWrite)
      await options.beforeWrite({ targetTenantId: target.id, createCount: plan.createCount });

    const manifest: Manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      source: source.id,
      target: target.id,
      entries: [],
    };
    report.manifest = manifest;
    report.created = 0;
    report.photosCopied = 0;
    report.errors = [];
    manifest.errors = report.errors;
    if ((await this.targetCount(target.id)) !== before) {
      throw new CopyRefusal(
        "refused: the target's product count moved since the plan; run the dry run again",
      );
    }

    for (const family of plan.create) {
      try {
        const done = await this.copyFamily(family, byId, source.id, target.id, targetCatalog);
        report.created += done.entries.length;
        for (const e of done.entries) {
          manifest.entries.push(e);
          report.photosCopied += e.photos.filter((p) => p.status === "copied").length;
        }
      } catch (e) {
        report.errors.push(
          { rootId: family.rootId, kind: "copy", message: (e as Error).message },
          ...(e instanceof FamilyFailure ? e.undo : []),
        );
        this.logger.warn(`family ${family.rootId} not copied: ${(e as Error).message}`);
      }
      options.onManifest?.(manifest);
    }
    return report;
  }

  /** `--resume`: finish the photos of the products THIS manifest says a run created; nothing else is touched. */
  async resumePhotos(manifest: Manifest, args: CopyArgs): Promise<{ photosCopied: number }> {
    assertApplyAllowed(args);
    const source = await this.tenantBySlug(args.source);
    const target = await this.tenantBySlug(args.target);
    if (manifest.source !== source.id || manifest.target !== target.id) {
      throw new CopyRefusal("refused: the manifest belongs to a different source/target pair");
    }
    let photosCopied = 0;
    for (const entry of manifest.entries) {
      const pending = entry.photos.filter((p) => p.status !== "copied");
      if (pending.length === 0) continue;
      const done = await this.copyPhotos(
        entry.sourceId,
        entry.targetId,
        pending.map((p) => p.sourceKey),
        target.id,
      );
      for (const p of done) {
        const rec = entry.photos.find((x) => x.sourceKey === p.sourceKey);
        if (rec) Object.assign(rec, p);
        if (p.status === "copied") photosCopied += 1;
      }
    }
    return { photosCopied };
  }

  // ─── reads (source is only ever read) ─────────────────────────────────────────────────────────

  private async readSource(tenantId: string) {
    const rows: SourceRow[] = [];
    let inactive = 0;
    const recipes: string[] = [];
    const ladderIds = new Set(
      (
        await this.prisma.productUnit.findMany({ where: { tenantId }, select: { productId: true } })
      ).map((u) => u.productId),
    );
    const tierIds = new Set(
      (
        await this.prisma.productTierUnit.findMany({
          where: { tenantId },
          select: { productId: true },
        })
      ).map((u) => u.productId),
    );
    const levels = new Map<string, Array<{ code: string; level: string }>>();
    for (const b of await this.prisma.productBarcode.findMany({
      where: { tenantId, code: { not: null } },
      select: { productId: true, code: true, level: true },
    })) {
      const list = levels.get(b.productId) ?? [];
      list.push({ code: b.code as string, level: String(b.level) });
      levels.set(b.productId, list);
    }

    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.product.findMany({
        where: { tenantId },
        orderBy: { id: "asc" },
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (page.length === 0) break;
      cursor = page[page.length - 1].id;
      for (const p of page) {
        if (!p.isActive) {
          inactive += 1;
          continue;
        }
        if (p.kind === "RECIPE") {
          recipes.push(p.sku ?? p.id);
          continue;
        }
        rows.push({
          id: p.id,
          name: p.name,
          sku: p.sku,
          unitSku: p.unitSku,
          barcode: p.barcode,
          parentProductId: p.parentProductId,
          variantName: p.variantName,
          isTobacco: p.isTobacco,
          trackedCategoryId: p.trackedCategoryId,
          trackedSubcategoryId: p.trackedSubcategoryId,
          regItemType: p.regItemType,
          regUomCase: p.regUomCase,
          regUomUnit: p.regUomUnit,
          imageKeys: p.imageKeys ?? [],
          levelBarcodes: levels.get(p.id) ?? [],
          hasLadder: ladderIds.has(p.id),
          kind: p.kind,
          description: p.description,
          unit: p.unit,
          unitsPerBox: p.unitsPerBox,
          category: p.category,
          msrp: p.msrp === null ? null : toMoney(p.msrp),
          prices: readPrices(p),
          packLabel: p.packLabel,
          baseUnitLabel: p.baseUnitLabel,
          orderUnitRef: p.orderUnitRef,
          invoiceUnitRef: p.invoiceUnitRef,
          invoiceLineCode: p.invoiceLineCode,
          familyPriceOverride: p.familyPriceOverride,
          hasTierUnits: tierIds.has(p.id),
        });
      }
    }
    return { rows, inactive, recipes };
  }

  private async readTarget(tenantId: string): Promise<TargetState> {
    const products = await this.prisma.product.findMany({
      where: { tenantId, isActive: true },
      select: { name: true, sku: true, unitSku: true, barcode: true, parentProductId: true },
    });
    const levelBarcodes = (
      await this.prisma.productBarcode.findMany({
        where: { tenantId, code: { not: null } },
        select: { code: true, level: true },
      })
    ).map((b) => ({ code: b.code as string, level: String(b.level) }));
    const unitsV1 = await this.entitlements.hasFlag(tenantId, UNITS_FLAG);
    // the same evaluation point `ProductsService` uses for the MSRP gate (overrides + live-mode resolver)
    const msrp = await this.authority.can(tenantId, "flag.msrp");
    return { products, levelBarcodes, unitsV1, msrp };
  }

  private targetCount(tenantId: string): Promise<number> {
    return this.prisma.product.count({ where: { tenantId } });
  }

  // ─── the report ───────────────────────────────────────────────────────────────────────────────

  private buildReport(
    mode: CopyReport["mode"],
    rows: SourceRow[],
    inactive: number,
    recipes: string[],
    plan: CopyPlan,
    byId: Map<string, SourceRow>,
    target: TargetState,
  ): CopyReport {
    const label = (id: string) => byId.get(id)?.sku ?? id;
    const differs = Object.fromEntries(DIFFERS_COLUMNS.map((c) => [c, [] as string[]])) as Record<
      DiffersColumn,
      string[]
    >;
    const copied = new Set(plan.create.flatMap((f) => f.members.map((m) => m.sourceId)));
    for (const r of rows) {
      if (!copied.has(r.id)) continue; // only products the target will receive
      if (r.packLabel !== null) differs.packLabel.push(label(r.id));
      if (r.baseUnitLabel !== null) differs.baseUnitLabel.push(label(r.id));
      if (r.orderUnitRef !== "pack") differs.orderUnitRef.push(label(r.id));
      if (r.invoiceUnitRef !== null) differs.invoiceUnitRef.push(label(r.id));
      if (r.invoiceLineCode !== null) differs.invoiceLineCode.push(label(r.id));
      if (r.familyPriceOverride) differs.familyPriceOverride.push(label(r.id));
      if (r.hasTierUnits) differs.tierUnits.push(label(r.id));
      if (r.msrp !== null && !target.msrp) differs.msrp.push(label(r.id));
    }
    return {
      mode,
      sourceProducts: rows.length,
      inactiveLeftOut: inactive,
      recipesLeftOut: recipes,
      families: plan.create.length,
      toCreate: plan.createCount,
      skippedBySku: plan.skippedBySku.map((s) => s.sku),
      skippedByName: plan.skippedByName.length,
      variantsSkipped: plan.variantsSkipped.map((s) => s.sku),
      regulated: plan.regulated.length,
      regulatedIds: plan.regulated.map((r) => label(r.sourceId)),
      codesDropped: plan.codesDropped.map((d) => ({
        sku: byId.get(d.sourceId)?.sku ?? null,
        kind: d.kind,
        code: d.code,
      })),
      packOnly: plan.packOnly.map(label),
      photos: plan.photos,
      differs,
      unitsV1: target.unitsV1,
    };
  }

  // ─── writes (every one through the app's own service, under the target's tenant context) ──────

  private async copyFamily(
    family: PlannedFamily,
    byId: Map<string, SourceRow>,
    sourceTenantId: string,
    targetTenantId: string,
    target: { unitsV1: boolean; msrp: boolean },
  ): Promise<{ entries: ManifestEntry[] }> {
    const created: Array<{ sourceId: string; targetId: string }> = [];
    const entries: ManifestEntry[] = [];
    try {
      await this.tenantCtx.run(targetTenantId, async () => {
        const root = byId.get(family.rootId)!;
        let rootTargetId: string;
        if (root.kind === "FAMILY") {
          rootTargetId = await this.createFamilyContainer(root, targetTenantId);
        } else {
          rootTargetId = await this.createProduct(root, family.members[0], null, target.msrp);
        }
        created.push({ sourceId: root.id, targetId: rootTargetId });
        const idMap = new Map<string, string>([[root.id, rootTargetId]]);
        for (const m of family.members.slice(1)) {
          const v = byId.get(m.sourceId)!;
          const id = await this.createProduct(v, m, rootTargetId, target.msrp);
          created.push({ sourceId: v.id, targetId: id });
          idMap.set(v.id, id);
        }
        if (target.unitsV1) {
          for (const m of family.members) {
            const src = byId.get(m.sourceId)!;
            if (m.packOnly || !src.hasLadder) continue;
            await this.copyLadder(sourceTenantId, src.id, idMap.get(src.id)!);
          }
        }
      });
    } catch (e) {
      // No partial family: undo what this family created in ONE call to the app's own bulk delete.
      throw new FamilyFailure(
        e as Error,
        await this.undoFamily(
          family.rootId,
          created.map((c) => c.targetId).reverse(),
          targetTenantId,
        ),
      );
    }
    // Photos after the family's create has committed.
    for (const c of created) {
      const src = byId.get(c.sourceId)!;
      const photos = src.imageKeys.length
        ? await this.copyPhotos(src.id, c.targetId, src.imageKeys, targetTenantId)
        : [];
      entries.push({ sourceId: c.sourceId, targetId: c.targetId, sku: src.sku, photos });
    }
    return { entries };
  }

  /**
   * One `ProductsService.bulkDelete(ids)`: it hard-deletes what nothing references and archives what something does.
   * Whatever it skips or archives, and an undo that throws, comes back as an error row: a half-removed family is
   * never silent, and the run exits non-zero for it.
   */
  private async undoFamily(
    rootId: string,
    targetIds: string[],
    targetTenantId: string,
  ): Promise<CopyError[]> {
    if (targetIds.length === 0) return [];
    const row = (message: string): CopyError => ({ rootId, kind: "undo", message });
    try {
      const out = await this.tenantCtx.run(targetTenantId, () =>
        this.products.bulkDelete(targetIds),
      );
      const rows = out.skipped.map((s) =>
        row(`undo skipped ${s.id} (${s.code}): ${s.reason}; it is still at the target`),
      );
      if (out.softDeleted > 0) {
        rows.push(
          row(
            `undo archived ${out.softDeleted} of ${targetIds.length} product(s) instead of deleting them ` +
              `(inactive at the target): ${targetIds.join(", ")}`,
          ),
        );
      }
      const accounted = out.deleted + out.softDeleted + out.skipped.length;
      if (accounted !== targetIds.length) {
        rows.push(
          row(
            `undo accounted for ${accounted} of ${targetIds.length} product(s): ${targetIds.join(", ")}`,
          ),
        );
      }
      for (const r of rows) this.logger.warn(r.message);
      return rows;
    } catch (err) {
      const message = `undo failed for ${targetIds.join(", ")}: ${(err as Error).message}`;
      this.logger.warn(message);
      return [row(message)];
    }
  }

  private async createFamilyContainer(root: SourceRow, targetTenantId: string): Promise<string> {
    assertSafeProductNames({ name: root.name });
    return this.prisma.tenantTransaction(async (tx: any) => {
      const conflicts = await this.families.reserveFamilyName(tx, targetTenantId, root.name);
      if (conflicts.length > 0)
        throw new CopyRefusal(`family name is taken at the target: ${root.name}`);
      const container = await this.families.createFamilyContainer(
        tx,
        buildFamilyContainerInput(root),
      );
      return container.id as string;
    });
  }

  /** The input comes whole from the plan's builder (rule 3): this method only hands it to the app's own writer. */
  private async createProduct(
    src: SourceRow,
    planned: PlannedFamily["members"][number],
    parentTargetId: string | null,
    msrpHeld: boolean,
  ): Promise<string> {
    const created = await this.products.create(
      buildProductCreateInput(src, planned, parentTargetId, msrpHeld) as never,
      { actorId: null, ...(parentTargetId ? { reparentVia: "import" as const } : {}) },
    );
    return (created as { id: string }).id;
  }

  /** The ladder, parents first, through the units service (its flag gate is the planner's `packOnly`). */
  private async copyLadder(
    sourceTenantId: string,
    sourceProductId: string,
    targetProductId: string,
  ): Promise<void> {
    const levels = await this.prisma.productUnit.findMany({
      where: { tenantId: sourceTenantId, productId: sourceProductId },
      orderBy: [{ factorToBase: "asc" }],
    });
    const idMap = new Map<string, string>();
    const pending = [...levels];
    while (pending.length > 0) {
      const ready = pending.findIndex((l) => !l.parentUnitId || idMap.has(l.parentUnitId));
      const level = pending.splice(ready === -1 ? 0 : ready, 1)[0];
      const made = await this.units.create(
        targetProductId,
        buildLadderLevelInput(
          level,
          level.parentUnitId ? (idMap.get(level.parentUnitId) ?? null) : null,
        ) as never,
        null,
      );
      idMap.set(level.id, (made as { id: string }).id);
    }
  }

  /**
   * Rule 1: the object is copied, never the key. `download(sourceKey)` then the product's own `uploadImage`, which mints
   * the key under the NEW product, compresses it and writes the mirror, as a UI upload does (#2533).
   */
  private async copyPhotos(
    _sourceProductId: string,
    targetProductId: string,
    keys: string[],
    targetTenantId: string,
  ): Promise<PhotoRecord[]> {
    const out: PhotoRecord[] = [];
    for (const key of keys) {
      try {
        const buffer = await this.storage.download(key);
        const focal = focalOf(key);
        await this.tenantCtx.run(targetTenantId, () =>
          this.products.uploadImage(
            targetProductId,
            buffer,
            key.split("/").pop() ?? "photo",
            mimeOf(key),
            focal,
          ),
        );
        out.push({ sourceKey: key, status: "copied" });
      } catch (e) {
        const gone = (e as NodeJS.ErrnoException).code === "ENOENT" || /NoSuchKey/.test(String(e));
        out.push({
          sourceKey: key,
          status: gone ? "missing" : "failed",
          detail: (e as Error).message,
        });
      }
    }
    return out;
  }
}

function mimeOf(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase();
  return ext === "png"
    ? "image/png"
    : ext === "webp"
      ? "image/webp"
      : ext === "gif"
        ? "image/gif"
        : "image/jpeg";
}

/** A key's `-fp<X>x<Y>` focal suffix (`uploadImage`'s own encoding), so the focal point survives the copy. */
function focalOf(key: string): { x: number; y: number } | undefined {
  const m = /-fp(\d{1,3})x(\d{1,3})\./.exec(key);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : undefined;
}
