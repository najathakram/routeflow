import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { InheritedLabelDto, ProductLabelDto, ProductLabelsDto } from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import {
  computeEffectiveCategoryIds,
  type LabelChainLink,
} from "../product-labels/effective-labels";
import { SetProductLabelDto } from "./dto/set-product-label.dto";
import { lockLabelCategory, writeLabelRow } from "./label-writer";

const LABEL_INCLUDE = { category: { select: { name: true, archivedAt: true } } } as const;
type LabelRow = Prisma.ProductCategoryLabelGetPayload<{ include: typeof LABEL_INCLUDE }>;

/** Same hop bound as the engine (`MAX_ANCESTOR_DEPTH` in product-labels.service): a product has at most this many ancestors. */
const MAX_HOPS = 5;
/** Upper bound on the descendants one label removal will inspect — a runaway subtree fails closed. */
const MAX_SUBTREE = 5000;
/** How many voided opt-outs are spelled out in the audit row (the rest are counted). */
const AUDIT_VOIDED_CAP = 50;

/** One opt-out destroyed by the B581 cleanup, kept in the audit trail (its `reason` was the approval). */
interface VoidedOptOut {
  id: string;
  productId: string;
  categoryId: string;
  reason: string | null;
}

function toDto(row: LabelRow, currentParentId: string | null): ProductLabelDto {
  return {
    id: row.id,
    categoryId: row.categoryId,
    categoryName: row.category.name,
    categoryArchived: !!row.category.archivedAt,
    mode: row.mode,
    reason: row.reason,
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
    // The pin must equal the variant's CURRENT parent for the engine to honour the opt-out.
    optOutActive:
      row.mode === "EXCLUDE"
        ? !!row.parentProductIdAtWrite && row.parentProductIdAtWrite === currentParentId
        : null,
  };
}

/** A product row read for one category's labels (everything the chain rule needs, nothing else). */
const CHAIN_SELECT = (categoryId: string) =>
  ({
    id: true,
    parentProductId: true,
    categoryLabels: {
      where: { categoryId },
      select: {
        id: true,
        categoryId: true,
        mode: true,
        reason: true,
        parentProductIdAtWrite: true,
      },
    },
  }) satisfies Prisma.ProductSelect;
type ChainProduct = Prisma.ProductGetPayload<{ select: ReturnType<typeof CHAIN_SELECT> }>;

const linkOf = (p: ChainProduct): LabelChainLink => ({
  productId: p.id,
  assignments: p.categoryLabels.map((l) => ({
    categoryId: l.categoryId,
    mode: l.mode,
    parentProductIdAtWrite: l.parentProductIdAtWrite,
  })),
});

/**
 * WRITE side of product↔category labels (Lane R step 4a). The READ side — the effective label set,
 * own INCLUDE + ancestors' INCLUDE − own EFFECTIVE EXCLUDE — is the engine's, never re-implemented
 * here: `computeEffectiveCategoryIds` is the one rule and `ProductLabelsService.effectiveLabels` the
 * one reader (this file only feeds them chains loaded inside its own transactions).
 *
 * Opt-out (EXCLUDE) contract, agreed with the engine:
 *  - only a variant can opt out, only with a reason, and only of a label that actually REACHES it
 *    through its IMMEDIATE parent (the parent's EFFECTIVE set, through every ancestor — not merely
 *    the parent's own row);
 *  - every EXCLUDE write stamps `parentProductIdAtWrite` with the variant's CURRENT parent (read in
 *    the same transaction). Reparenting never touches it, so the engine treats a moved variant's old
 *    opt-out as inert (fail closed) — an approval given for one parent can't ride along to another;
 *  - B581: when an INCLUDE stops reaching a subtree (row deleted, or flipped to an opt-out), the
 *    opt-outs below it that only existed to cancel it are voided in the same transaction, so that
 *    re-adding the label later can't leave a descendant silently exempt.
 */
@Injectable()
export class ProductLabelsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly productLabels: ProductLabelsService,
  ) {}

  /** Writes and label reads need a tenant: SUPER_ADMIN's unscoped client would otherwise cross tenants. */
  private requireTenant(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }

  private async loadProduct(productId: string) {
    const product = await this.prisma
      .forTenant()
      .product.findFirst({ where: { id: productId }, select: { id: true, parentProductId: true } });
    if (!product) throw new NotFoundException("Product not found");
    return product;
  }

  async getForProduct(productId: string): Promise<ProductLabelsDto> {
    const tenantId = this.requireTenant();
    const product = await this.loadProduct(productId);
    const db = this.prisma.forTenant();
    const own = await db.productCategoryLabel.findMany({
      where: { productId },
      include: LABEL_INCLUDE,
      orderBy: { createdAt: "asc" },
    });

    let inherited: InheritedLabelDto[] = [];
    let ancestryResolvable = true;
    if (product.parentProductId) {
      const effective = (
        await this.productLabels.effectiveLabels(tenantId, [product.parentProductId])
      ).get(product.parentProductId);
      ancestryResolvable = !!effective?.resolvable;
      const ids = [...(effective?.effectiveCategoryIds ?? [])];
      if (ids.length > 0) {
        const cats = await db.productCategory.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, archivedAt: true },
          orderBy: { name: "asc" },
        });
        inherited = cats.map((c) => ({
          categoryId: c.id,
          categoryName: c.name,
          categoryArchived: !!c.archivedAt,
        }));
      }
    }
    return {
      productId,
      parentProductId: product.parentProductId,
      ancestryResolvable,
      own: own.map((r) => toDto(r, product.parentProductId)),
      inherited,
    };
  }

  /**
   * Serializes label writes for one tenant × category on the transaction's OWN connection
   * (`pg_advisory_xact_lock`, released at commit/rollback — the idempotency-service pattern; no
   * extra pool). Without it a `setLabel(EXCLUDE)` validated against a parent's INCLUDE can commit
   * just after a concurrent `removeLabel` of that INCLUDE finished its cleanup, stranding an opt-out
   * that revives when the label is re-added (B581). Label writes are rare admin actions: coarse is fine.
   */
  private async lockCategory(
    tx: Prisma.TransactionClient,
    tenantId: string,
    categoryId: string,
  ): Promise<void> {
    // A busy lock throws LabelLockTimeoutError: a coded 409 (LABEL_CHANGE_IN_PROGRESS).
    await lockLabelCategory(tx, tenantId, categoryId); // the single writer's lock (label-writer.ts)
  }

  /**
   * Does the label currently REACH this product (its effective set contains it)? true / false, or
   * null when the ancestry can't be resolved (unknown — callers treat unknown as "may have been
   * carried" before a change and "may have stopped" after it, i.e. they fail closed).
   */
  private async carries(
    tx: Prisma.TransactionClient,
    tenantId: string,
    productId: string,
    categoryId: string,
  ): Promise<boolean | null> {
    const chain = await this.loadChain(tx, tenantId, productId, categoryId);
    return chain ? computeEffectiveCategoryIds(chain).has(categoryId) : null;
  }

  /**
   * The ancestor chain of `startProductId` (root first, ending AT it) carrying only `categoryId`'s
   * label rows — the exact input `computeEffectiveCategoryIds` takes. null = the ancestry can't be
   * resolved (a link missing / another tenant's / a cycle / deeper than the engine's cap): callers
   * fail closed.
   */
  private async loadChain(
    tx: Prisma.TransactionClient,
    tenantId: string,
    startProductId: string,
    categoryId: string,
  ): Promise<LabelChainLink[] | null> {
    const chain: LabelChainLink[] = [];
    const seen = new Set<string>();
    let cursor: string | null = startProductId;
    for (let hops = 0; cursor; hops++) {
      if (hops > MAX_HOPS || seen.has(cursor)) return null;
      seen.add(cursor);
      const row: ChainProduct | null = await tx.product.findFirst({
        where: { id: cursor, tenantId },
        select: CHAIN_SELECT(categoryId),
      });
      if (!row) return null;
      chain.unshift(linkOf(row));
      cursor = row.parentProductId;
    }
    return chain;
  }

  /**
   * B581. After an INCLUDE for `categoryId` on `rootId` stopped reaching its subtree, delete every
   * descendant EXCLUDE for that category whose label no longer reaches its (immediate) parent —
   * those opt-outs cancel nothing now and would silently revive if the label came back. An opt-out
   * still cancelling a label that reaches the variant another way (e.g. from a higher ancestor) is
   * kept. Runs inside the caller's transaction; returns the opt-outs it deleted (their `reason` was the
   * approval, so the caller records them in the audit row).
   */
  private async voidDependentOptOuts(
    tx: Prisma.TransactionClient,
    tenantId: string,
    rootId: string,
    categoryId: string,
  ): Promise<VoidedOptOut[]> {
    const up = await this.loadChain(tx, tenantId, rootId, categoryId);
    // Unresolvable ancestry: we cannot prove any opt-out below still cancels something, and
    // removing an opt-out only ever makes the ban stricter — fail closed and void them all.
    const chains = new Map<string, LabelChainLink[] | null>([[rootId, up]]);
    const dead: VoidedOptOut[] = [];
    const seen = new Set<string>([rootId]);
    let frontier = [rootId];
    let inspected = 0;
    for (let depth = 0; depth < MAX_HOPS && frontier.length > 0; depth++) {
      const kids: ChainProduct[] = await tx.product.findMany({
        where: { tenantId, parentProductId: { in: frontier } },
        select: CHAIN_SELECT(categoryId),
      });
      frontier = [];
      for (const kid of kids) {
        if (seen.has(kid.id)) continue; // a cycle can't loop us
        seen.add(kid.id);
        if (++inspected > MAX_SUBTREE) {
          throw new ConflictException(
            "This product has too many variants to update in one step. Contact support.",
          );
        }
        const parentChain = chains.get(kid.parentProductId as string) ?? null;
        const reachesParent =
          !!parentChain && computeEffectiveCategoryIds(parentChain).has(categoryId);
        const optOut = kid.categoryLabels.find((l) => l.mode === "EXCLUDE");
        if (optOut && !reachesParent) {
          dead.push({
            id: optOut.id,
            productId: kid.id,
            categoryId,
            reason: optOut.reason,
          });
        }
        // Extend the chain with this kid MINUS a voided opt-out (which cancelled nothing anyway).
        chains.set(
          kid.id,
          parentChain
            ? [
                ...parentChain,
                linkOf({
                  ...kid,
                  categoryLabels: kid.categoryLabels.filter(
                    (l) => l.id !== optOut?.id || reachesParent,
                  ),
                }),
              ]
            : null,
        );
        frontier.push(kid.id);
      }
    }
    if (dead.length === 0) return [];
    await tx.productCategoryLabel.deleteMany({ where: { id: { in: dead.map((d) => d.id) } } });
    return dead;
  }

  /**
   * B581 trigger, keyed on the MEMBERSHIP transition rather than on which row changed: void when the
   * label may have reached `productId` before the write and may no longer after it. That one rule
   * covers an INCLUDE delete, an INCLUDE→EXCLUDE flip AND a fresh EXCLUDE written where the product
   * had no row (all three stop the label reaching the subtree), and correctly does nothing when an
   * EXCLUDE is removed (the label starts reaching again).
   */
  private async voidIfStoppedCarrying(
    tx: Prisma.TransactionClient,
    tenantId: string,
    productId: string,
    categoryId: string,
    before: boolean | null,
  ): Promise<VoidedOptOut[]> {
    const after = await this.carries(tx, tenantId, productId, categoryId);
    if (before === false || after === true) return [];
    return this.voidDependentOptOuts(tx, tenantId, productId, categoryId);
  }

  async setLabel(
    productId: string,
    categoryId: string,
    dto: SetProductLabelDto,
    user: JwtPayload,
  ): Promise<ProductLabelDto> {
    const tenantId = this.requireTenant();
    await this.loadProduct(productId);
    const reason = dto.mode === "EXCLUDE" ? dto.reason?.trim() || null : null;
    if (dto.mode === "EXCLUDE" && !reason) {
      throw new BadRequestException("A reason is required to opt out of a label.");
    }

    const stamp = { createdById: user.sub, createdByName: user.username };
    try {
      const { row, currentParentId, voided } = await this.prisma.tenantTransaction(async (tx) => {
        // Re-read the product INSIDE the transaction: its parent at this instant is what an
        // opt-out is pinned to and validated against.
        const product = await tx.product.findFirst({
          where: { id: productId, tenantId },
          select: { id: true, parentProductId: true },
        });
        if (!product) throw new NotFoundException("Product not found");

        await this.lockCategory(tx, tenantId, categoryId);
        // The category is checked INSIDE the transaction, after the lock: an archive that commits
        // between an outside check and the write could otherwise still get a label written to it.
        const category = await tx.productCategory.findFirst({
          where: { id: categoryId, tenantId },
          select: { archivedAt: true },
        });
        if (!category) throw new NotFoundException("Category not found");
        if (category.archivedAt) {
          throw new ConflictException("This category is archived. Restore it before labelling.");
        }
        const before = await this.carries(tx, tenantId, productId, categoryId);

        let pin: string | null = null;
        if (dto.mode === "EXCLUDE") {
          if (!product.parentProductId) {
            throw new BadRequestException(
              "Only a variant can opt out of a label its parent carries.",
            );
          }
          const parentChain = await this.loadChain(
            tx,
            tenantId,
            product.parentProductId,
            categoryId,
          );
          if (!parentChain) {
            throw new BadRequestException(
              "This variant's parent chain can't be resolved, so an opt-out can't be recorded.",
            );
          }
          if (!computeEffectiveCategoryIds(parentChain).has(categoryId)) {
            throw new BadRequestException("The parent product does not carry this label.");
          }
          pin = product.parentProductId;
        }

        const written: LabelRow = await writeLabelRow(tx, {
          tenantId,
          productId,
          categoryId,
          data: { mode: dto.mode, reason, parentProductIdAtWrite: pin, ...stamp },
          include: LABEL_INCLUDE,
        });
        const voidedRows = await this.voidIfStoppedCarrying(
          tx,
          tenantId,
          productId,
          categoryId,
          before,
        );
        return { row: written, currentParentId: product.parentProductId, voided: voidedRows };
      });
      await this.audit.log({
        tenantId,
        userId: user.sub,
        action: "product_label.set",
        entityType: "Product",
        entityId: productId,
        meta: {
          categoryId,
          mode: dto.mode,
          reason,
          voidedOptOuts: voided.length,
          voided: voided.slice(0, AUDIT_VOIDED_CAP),
        },
      });
      return toDto(row, currentParentId);
    } catch (e) {
      // Concurrent first-write of the same (product, category) pair.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("This product already has that label.");
      }
      throw e;
    }
  }

  async removeLabel(
    productId: string,
    categoryId: string,
    user: JwtPayload,
  ): Promise<{ removed: true; clearedOptOuts: number }> {
    const tenantId = this.requireTenant();
    await this.loadProduct(productId);
    const voided = await this.prisma.tenantTransaction(async (tx) => {
      await this.lockCategory(tx, tenantId, categoryId);
      const row = await tx.productCategoryLabel.findFirst({ where: { productId, categoryId } });
      if (!row) throw new NotFoundException("Label not found on this product");
      const before = await this.carries(tx, tenantId, productId, categoryId);
      await tx.productCategoryLabel.deleteMany({ where: { id: row.id } });
      // Removing an opt-out re-applies the label (nothing stops reaching the subtree); removing an
      // INCLUDE can stop it. The membership rule decides — never the row's mode.
      return this.voidIfStoppedCarrying(tx, tenantId, productId, categoryId, before);
    });
    await this.audit.log({
      tenantId,
      userId: user.sub,
      action: "product_label.removed",
      entityType: "Product",
      entityId: productId,
      meta: {
        categoryId,
        clearedOptOuts: voided.length,
        voided: voided.slice(0, AUDIT_VOIDED_CAP),
      },
    });
    return { removed: true, clearedOptOuts: voided.length };
  }
}
