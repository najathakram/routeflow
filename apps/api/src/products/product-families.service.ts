import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { FamilyRowConflict } from "@routeflow/types";
import { roundMoney, roundUnitCost } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { assertSafeProductNames } from "../common/text-cell-guards";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { PrismaService } from "../prisma/prisma.service";
import {
  codeTakenBy,
  familyGridConflicts,
  nameTakenBy,
  type FamilyCodeInput,
  type FamilyNameInput,
} from "./product-family-conflicts";
import {
  lockBarcodeCodes,
  lockProductRow,
  syncProductBarcodesFromLegacy,
  type CatalogTx,
} from "./product-catalog-sync";
import {
  claimCodes,
  peekProductCodes,
  releaseProductCodes,
  type CodeField,
} from "./product-code-release";
import {
  FAMILY_PRICE_COLUMNS,
  familyPriceAuthorityError,
  familyPricesForNewVariant,
  lockFamilyRow,
  readFamilyPriceMode,
  type FamilyPriceColumn,
} from "./family-price";
import { UnitsPricesV2FlagCache, variantTierValue } from "./new-product-tiers";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { writeFamilyAssigned } from "./product-parent";
import { lockProductName } from "./product-name-rules";
import { bareRowNames } from "./product-variant-name";
import { syncCategoryLabel } from "../product-categories/label-writer";
import type {
  CreateFamilyDto,
  FamilyVariantDto,
  FamilyVariantUpdateDto,
  UpdateFamilyVariantsDto,
} from "./dto/family.dto";
import { blankToUndefined } from "./dto/family.dto";

/**
 * WS8 (SA-606): families. A FAMILY (kind FAMILY, parentProductId null) is a non-stocked, NON-SELLABLE container; its
 * variants (kind VARIANT, parentProductId = the family) are the sellable rows. Both writes are ALL-OR-NOTHING in ONE
 * tenantTransaction with the house lock order (every code, sorted, in ONE call -> the name lock -> rows), and a conflict
 * is a 409 FAMILY_ROWS_CONFLICT listing EVERY conflicting row. The cap is 200 rows per call.
 */
const CODE_FIELDS: readonly CodeField[] = ["sku", "barcode", "unitSku"];
const MAX_ROWS = 200;

/**
 * B998: a formula-led VARIANT name is refused with the same TEXT_CELL_FORMULA_LEAD body as ever, plus WHICH row: the 0-based
 * `variantIndex` into the request list `variantList` ("variants" on create, "add" / "update" on an edit), so the web can put the
 * message under that row instead of under Family name. Numbers and an enum only; the refused text is never echoed.
 */
type VariantList = "variants" | "add" | "update";
function assertSafeVariantName(
  list: VariantList,
  index: number,
  next: Parameters<typeof assertSafeProductNames>[0],
  stored?: Parameters<typeof assertSafeProductNames>[1],
): void {
  try {
    assertSafeProductNames(next, stored);
  } catch (e) {
    if (e instanceof BadRequestException) {
      const body = e.getResponse();
      if (typeof body === "object" && body !== null) {
        throw new BadRequestException({
          ...(body as Record<string, unknown>),
          variantIndex: index,
          variantList: list,
        });
      }
    }
    throw e;
  }
}
export const FAMILY_CREATED_ACTION = "product.family_created";
export const FAMILY_VARIANTS_UPDATED_ACTION = "product.family_variants_updated";

/** A code / text value, trimmed (" A1" and "A1" are one code); blank -> null. */
const blank = (v: string | undefined | null): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
const sameMoney = (a: Prisma.Decimal | null, b: Prisma.Decimal | null): boolean =>
  a != null && b != null && roundMoney(Number(a)) === roundMoney(Number(b));
/**
 * A money field that is PRESENT must hold a value: null / "" would otherwise fall through to $0 (Tier 1, #2881 r3).
 * In "required" mode an ABSENT (undefined) value is refused too (SA-606i): no price is ever implied.
 */
const given = (v: unknown, field: string, mode: "omit" | "required" = "omit"): void => {
  if (
    v === null ||
    (mode === "required" && v === undefined) ||
    (typeof v === "string" && v.trim() === "")
  ) {
    throw new BadRequestException(
      mode === "required"
        ? `${field} is required`
        : `${field} cannot be ${v === null ? "null" : "empty"}; omit the field to leave it unchanged.`,
    );
  }
};
/** Create-side cost: null / "" / whitespace = omitted; a NON-string (a JSON number) is a 400, never an inherit (SA-606g). */
const costOf = (v: unknown): string | undefined => {
  const x = blankToUndefined(v);
  if (x === undefined) return undefined;
  if (typeof x !== "string") throw new BadRequestException("standardCost must be a string amount.");
  return x;
};
const outOfRange = (what: string) =>
  new BadRequestException(`${what} is out of range for a stored amount.`);
/** Decimal(10,2): the DTO bounds the integer part, this catches a ROUNDING overflow (99999999.999 -> 100000000.00). */
const money = (v: unknown): string => {
  // SA-606i: NO implicit fallback. A caller with no price handles that itself (PATCH update rows call this only for a PRESENT
  // price; everything on create goes through given(..., "required") first).
  if (typeof v !== "string" || v.trim() === "") {
    throw new BadRequestException("A price is required and must be a string amount.");
  }
  if (!Number.isFinite(Number(v))) {
    throw new BadRequestException("A price must be a non-negative amount.");
  }
  const r = roundMoney(Number(v));
  if (!(r >= 0 && r < 1e8)) throw outOfRange("A price");
  return r.toFixed(2);
};
/** Decimal(10,4) cost, the same rounding-overflow guard (999999.99999 -> 1000000.0000). */
const cost4 = (v: unknown): string => {
  if (typeof v !== "string") throw new BadRequestException("A cost must be a string amount.");
  if (!Number.isFinite(Number(v)))
    throw new BadRequestException("A cost must be a non-negative amount.");
  const r = roundUnitCost(Number(v));
  if (!(r >= 0 && r < 1e6)) throw outOfRange("A cost");
  return r.toFixed(4);
};

@Injectable()
export class ProductFamiliesService {
  private readonly logger = new Logger(ProductFamiliesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RouteFlowGateway,
    private readonly audit: AuditService,
    // #2717 M2 price authority: optional like ProductsService (a missing provider reads as mode "off").
    @Optional() private readonly featureConfig?: FeatureConfigService,
    // S4: flag.units_prices_v2 (a missing provider reads as OFF = master's behaviour).
    @Optional() private readonly entitlements?: EntitlementsService,
  ) {}

  /** S4: flag.units_prices_v2, cached 30 s per tenant, read before a transaction opens. */
  private readonly unitsPricesV2 = new UnitsPricesV2FlagCache();

  private tenant(): string {
    const t = this.prisma.getTenantId();
    if (!t) throw new BadRequestException("No tenant context");
    return t;
  }

  private rowsConflict(rows: FamilyRowConflict[]): ConflictException {
    return new ConflictException({
      code: API_ERROR_CODES.FAMILY_ROWS_CONFLICT,
      message:
        rows.length === 1
          ? "One row conflicts with an existing product or another row. Nothing was saved."
          : `${rows.length} rows conflict with existing products or each other. Nothing was saved.`,
      rows,
    });
  }

  private codeInputs(
    rows: ReadonlyArray<{
      row: number | "family";
      id?: string;
      sku?: string;
      barcode?: string;
      unitSku?: string;
    }>,
  ): FamilyCodeInput[] {
    const out: FamilyCodeInput[] = [];
    for (const r of rows) {
      for (const field of CODE_FIELDS) {
        const value = blank(r[field]);
        if (value) out.push({ row: r.row, field, value, ...(r.id ? { ownerId: r.id } : {}) });
      }
    }
    return out;
  }

  /**
   * SA-823: reserve a FAMILY name inside the caller's transaction: the existing root-scope name lock (house order: codes ->
   * name -> rows) plus the root-name `nameTakenBy` check, returned as conflicts. A WRAPPER over product-name-rules; it adds
   * no second lock. createFamily and the import both call it before createFamilyContainer.
   */
  async reserveFamilyName(
    tx: CatalogTx,
    tenantId: string,
    name: string,
  ): Promise<FamilyRowConflict[]> {
    await lockProductName(tx, tenantId, null, name);
    return nameTakenBy(tx, tenantId, [{ row: "family", name, parentProductId: null }]);
  }

  /**
   * SA-823: THE one writer of a FAMILY row (kind FAMILY, unit each, no sku/barcode/stock, parentProductId null, active)
   * plus its one add-only category-label sync, in the caller's tx. PRECONDITION: the caller holds the family-name lock
   * and has checked the name is free (reserveFamilyName) and ran assertSafeProductNames; it does not lock codes.
   */
  async createFamilyContainer(
    tx: CatalogTx,
    input: {
      name: string;
      category?: string | null;
      pricePerUnit: string;
      description?: string | null;
      standardCost?: string;
      actorId?: string | null;
    },
  ) {
    const family = await tx.product.create({
      data: {
        name: input.name,
        unit: "each",
        pricePerUnit: input.pricePerUnit,
        ...(input.standardCost !== undefined ? { standardCost: input.standardCost } : {}),
        category: input.category ?? null,
        description: input.description ?? null,
        kind: "FAMILY",
        parentProductId: null,
        isActive: true,
      },
    });
    // Add-only label sync from the family's category text (the variants carry none), same tx.
    await syncCategoryLabel(tx, {
      productId: family.id,
      tenantId: this.tenant(),
      text: family.category,
      actor: { id: input.actorId ?? null, name: null },
    });
    return family;
  }

  /**
   * SA-823 (PR-2): reactivate an EMPTY family container (the import's re-run reuse of the family an earlier, all-failed run
   * made). House lock order: the name lock first, then the row; refused when it has members or the name is taken again.
   */
  async reactivateFamilyContainer(familyId: string, actorId: string | null): Promise<void> {
    const tenantId = this.tenant();
    await this.prisma.tenantTransaction(async (tx: CatalogTx) => {
      const probe = await tx.product.findFirst({
        where: { id: familyId, tenantId, parentProductId: null },
        select: { name: true },
      });
      if (!probe) throw new NotFoundException("Family not found");
      const conflicts = await this.reserveFamilyName(tx, tenantId, probe.name);
      if (conflicts.length > 0) throw this.rowsConflict(conflicts);
      await lockProductRow(tx, tenantId, familyId);
      const row = await tx.product.findFirst({
        where: { id: familyId, tenantId },
        select: { kind: true },
      });
      const members = await tx.product.count({ where: { parentProductId: familyId, tenantId } });
      if (!row || row.kind !== "FAMILY" || members > 0) {
        throw new ConflictException("Only an empty family can be reactivated here.");
      }
      await tx.product.update({ where: { id: familyId }, data: { isActive: true } });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: actorId,
          action: AUDIT_ACTIONS.PRODUCT_FAMILY_REACTIVATED,
          entityType: "Product",
          entityId: familyId,
          meta: { reason: "import re-run" },
        },
      });
    });
  }

  /** POST /products/families */
  async createFamily(dto: CreateFamilyDto, actorId: string | null) {
    const tenantId = this.tenant();
    if (dto.variants.length < 1 || dto.variants.length > MAX_ROWS) {
      throw new BadRequestException(`A family takes 1 to ${MAX_ROWS} variants per request.`);
    }
    const familyName = dto.family.name.trim();
    // B1: every variant stores its BARE label; a name typed or pasted as "<family> - <label>" is stripped first.
    bareRowNames(dto.variants, familyName);
    const variantRows = dto.variants.map((v, i) => ({ row: i, ...v }));
    // B964-2: a formula-led family / variant name is refused before any read or write (it is printed on invoices, exports, filings)
    assertSafeProductNames({ name: familyName });
    dto.variants.forEach((v, i) =>
      assertSafeVariantName("variants", i, { name: v.name.trim(), variantName: v.name.trim() }),
    );
    // A family price copied to every variant must be a real price: missing or <= 0 would write $0.00 onto every variant.
    // Coded so a client can show it; checked BEFORE the generic "required" so the code is stable (nothing written).
    const copyPriceError = () =>
      new BadRequestException({
        code: API_ERROR_CODES.FAMILY_COPY_PRICE_REQUIRED,
        message:
          "Enter a family price above $0.00 to copy it to every variant, or turn off copying the family price.",
      });
    if (
      dto.copyFamilyPrice &&
      (typeof dto.family.pricePerUnit !== "string" || dto.family.pricePerUnit.trim() === "")
    ) {
      throw copyPriceError();
    }
    given(dto.family.pricePerUnit, "family pricePerUnit", "required");
    const familyPrice = money(dto.family.pricePerUnit);
    if (dto.copyFamilyPrice && !(Number(familyPrice) > 0)) throw copyPriceError();
    const familyCost = costOf(dto.family.standardCost);
    if (familyCost !== undefined) cost4(familyCost);
    for (const v of dto.variants) {
      if (v.pricePerUnit == null) throw new BadRequestException("pricePerUnit is required.");
      given(v.pricePerUnit, "pricePerUnit", "required");
      // a create-side cost that is null / "" means OMITTED (the variant inherits the family's, SA-606a)
      money(v.pricePerUnit);
      const c = costOf(v.standardCost);
      if (c !== undefined) cost4(c);
    }
    // S4: one cached flag read, before the transaction opens.
    const unitsV2 = await this.unitsPricesV2.isOn(this.entitlements, this.prisma.getTenantId());
    const run = () =>
      this.prisma.tenantTransaction(async (tx: CatalogTx) => {
        const codes = this.codeInputs(variantRows);
        // House order: ONE sorted code-lock call, then the name lock, then rows.
        await lockBarcodeCodes(
          tx,
          tenantId,
          codes.map((c) => c.value),
        );
        const familyNameConflicts = await this.reserveFamilyName(tx, tenantId, familyName);
        const conflicts: FamilyRowConflict[] = [
          ...familyGridConflicts(
            variantRows.map((v) => ({
              row: v.row,
              name: v.name,
              sku: v.sku,
              barcode: v.barcode,
              unitSku: v.unitSku,
            })),
          ),
          ...(await codeTakenBy(tx, tenantId, codes)),
          ...familyNameConflicts,
        ];
        if (conflicts.length > 0) throw this.rowsConflict(conflicts);
        // #2860 claim semantics (Opus #2881 B2): a legacy INACTIVE holder still holds its code LIVE; release it (one
        // audit row) before the insert instead of answering a raw P2002.
        for (const v of variantRows) {
          // eslint-disable-next-line no-await-in-loop
          await claimCodes(tx, {
            tenantId,
            productId: null,
            actorId,
            codes: this.codeInputs([v]).map((c) => ({ field: c.field, value: c.value })),
          });
        }

        const family = await this.createFamilyContainer(tx, {
          name: familyName,
          category: dto.family.category,
          pricePerUnit: familyPrice,
          description: dto.family.description,
          standardCost: familyCost !== undefined ? cost4(familyCost) : undefined,
          actorId,
        });
        const variants: Array<{ id: string; name: string }> = [];
        for (const v of dto.variants) {
          // eslint-disable-next-line no-await-in-loop -- <= 200 rows, ordered, one tx
          const created = await tx.product.create({
            data: this.variantData(
              family.id,
              v,
              dto.copyFamilyPrice ? familyPrice : undefined,
              familyCost,
              unitsV2,
            ),
          });
          variants.push({ id: created.id, name: created.name });
          // eslint-disable-next-line no-await-in-loop
          await writeFamilyAssigned(tx, {
            tenantId,
            actorId,
            productId: created.id,
            fromParentId: null,
            toParentId: family.id,
            variantName: v.name.trim(),
            via: "family_editor",
          });
          // eslint-disable-next-line no-await-in-loop
          await syncProductBarcodesFromLegacy(tx, {
            tenantId,
            productId: created.id,
            barcode: blank(v.barcode),
            unitsPerBox: v.unitsPerBox ?? null,
          });
        }
        return { family: { id: family.id, name: family.name }, variants };
      });
    let result;
    try {
      result = await run();
    } catch (e) {
      await this.reattribute(e, tenantId, this.codeInputs(variantRows), [
        { row: "family", name: familyName, parentProductId: null },
      ]);
      throw e;
    }
    await this.afterWrite(actorId, result.family.id, FAMILY_CREATED_ACTION, {
      variantCount: result.variants.length,
    });
    return result;
  }

  private variantData(
    familyId: string,
    v: FamilyVariantDto,
    prices?: string | Record<FamilyPriceColumn, Prisma.Decimal>,
    familyCost?: string | null,
    unitsV2 = false,
  ): Prisma.ProductUncheckedCreateInput {
    const cost = costOf(v.standardCost) ?? familyCost;
    const own = typeof prices === "string" ? prices : money(v.pricePerUnit);
    const record = prices && typeof prices !== "string" ? prices : undefined;
    const col = (c: FamilyPriceColumn): string =>
      c === "pricePerUnit"
        ? (record?.[c].toString() ?? own)
        : variantTierValue(unitsV2, record?.[c].toString(), own);
    return {
      name: v.name.trim(),
      variantName: v.name.trim(),
      parentProductId: familyId,
      kind: "VARIANT",
      unit: "each",
      sku: blank(v.sku),
      barcode: blank(v.barcode),
      unitSku: blank(v.unitSku),
      unitsPerBox: v.unitsPerBox ?? null,
      pricePerUnit: col("pricePerUnit"),
      priceTier2: col("priceTier2"),
      priceTier3: col("priceTier3"),
      priceTier4: col("priceTier4"),
      priceTier5: col("priceTier5"),
      ...(cost != null && cost !== "" ? { standardCost: cost4(cost) } : {}),
      isActive: true,
    };
  }

  /** A P2002 backstop that slipped past the locks: re-run the ONE check and answer with the same 409 shape. */
  private async reattribute(
    e: unknown,
    tenantId: string,
    codes: readonly FamilyCodeInput[],
    names: ReadonlyArray<FamilyNameInput>,
    excludeProductIds: readonly string[] = [],
  ): Promise<void> {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return;
    const db = this.prisma.forTenant() as unknown as CatalogTx;
    const conflicts = [
      ...(await codeTakenBy(db, tenantId, codes, { excludeProductIds })),
      ...(await nameTakenBy(db, tenantId, names, { excludeProductIds })),
    ];
    if (conflicts.length > 0) throw this.rowsConflict(conflicts);
  }

  private async afterWrite(
    actorId: string | null,
    productId: string,
    action: string,
    meta: Record<string, unknown>,
  ) {
    await this.audit.log({
      tenantId: this.prisma.getTenantId(),
      userId: actorId,
      action,
      entityType: "Product",
      entityId: productId,
      meta,
    });
    try {
      this.gateway.emitProductUpdated(this.prisma.getTenantId(), {
        productId: null,
        action: "bulk",
      });
    } catch (err) {
      this.logger.warn(
        `product.updated emit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** PATCH /products/:id/variants: ALL-OR-NOTHING add / update / deactivate on one family, <= 200 rows in total. */
  async updateVariants(familyId: string, dto: UpdateFamilyVariantsDto, actorId: string | null) {
    const tenantId = this.tenant();
    const add = dto.add ?? [];
    const update = dto.update ?? [];
    const deactivate = [...new Set(dto.deactivate ?? [])];
    if (add.length + update.length + deactivate.length > MAX_ROWS) {
      throw new BadRequestException(`At most ${MAX_ROWS} rows per request.`);
    }
    // B1: an added / renamed variant stores its BARE label; the family's name is read once (tenant-scoped) to strip a
    // pasted "<family> - <label>". An unreadable family is left to the 404 inside the transaction.
    if (add.length + update.length > 0) {
      const family: { name: string } | null = await this.prisma
        .forTenant()
        .product.findFirst({ where: { id: familyId }, select: { name: true } });
      bareRowNames(add, family?.name);
      bareRowNames(update, family?.name);
    }
    // M2 price authority: while mixed_packs is ON the family owns the variants' price, so a price EDIT is a 409 and an
    // added variant takes the family's five columns (never a price of its own).
    const authority = (await readFamilyPriceMode(this.featureConfig, tenantId)) === "on";
    if (authority && update.some((u) => u.pricePerUnit !== undefined)) {
      throw familyPriceAuthorityError(familyId);
    }
    // Range-check every price / cost BEFORE the transaction (a rounding overflow is a 400, never after locks + writes).
    for (const u of update) {
      given(u.pricePerUnit, "pricePerUnit");
      given(u.standardCost, "standardCost");
      if (u.pricePerUnit !== undefined) money(u.pricePerUnit);
      if (u.standardCost !== undefined) cost4(u.standardCost);
    }
    for (const v of add) {
      if (v.pricePerUnit == null) throw new BadRequestException("pricePerUnit is required.");
      given(v.pricePerUnit, "pricePerUnit", "required");
      // a create-side cost that is null / "" means OMITTED (the variant inherits the family's, SA-606a)
      money(v.pricePerUnit);
      const c = costOf(v.standardCost);
      if (c !== undefined) cost4(c);
    }
    // B964-2: an ADDED variant's name is new text, so it is guarded here, before any read or write. A RENAME is guarded
    // CHANGE-ONLY inside the transaction (against the stored name), before any write.
    add.forEach((v, i) =>
      assertSafeVariantName("add", i, { name: v.name.trim(), variantName: v.name.trim() }),
    );
    const touchedIds = [...new Set([...update.map((u) => u.id), ...deactivate])];
    const addRows = add.map((v, i) => ({ row: i, ...v }));
    const updRows = update.map((u, i) => ({ row: add.length + i, ...u }));
    const codes = this.codeInputs([...addRows, ...updRows]);
    const nameInputs = [
      ...addRows.map((r) => ({ row: r.row, name: r.name.trim(), parentProductId: familyId })),
      ...updRows
        .filter((r) => r.name)
        .map((r) => ({
          row: r.row,
          name: (r.name as string).trim(),
          parentProductId: familyId,
          excludeId: r.id,
        })),
    ];

    // S4: one cached flag read, before the transaction opens.
    const unitsV2 = await this.unitsPricesV2.isOn(this.entitlements, tenantId);
    const run = () =>
      this.prisma.tenantTransaction(async (tx: CatalogTx) => {
        // House order (Opus #2881 B4): the family row FIRST (an add must not race propagateFamilyPrice), then every code
        // in ONE sorted call, then the name locks (sorted), then the touched rows in id order.
        await lockFamilyRow(tx, tenantId, familyId);
        const family: {
          id: string;
          kind: string;
          standardCost: Prisma.Decimal | null;
        } | null = await tx.product.findFirst({
          where: { id: familyId, tenantId },
          select: { id: true, kind: true, standardCost: true },
        });
        if (!family) {
          throw new NotFoundException({
            code: API_ERROR_CODES.FAMILY_NOT_FOUND,
            message: "Product family not found.",
          });
        }
        if (family.kind !== "FAMILY") {
          throw new BadRequestException("This product is not a family.");
        }
        const mine: Array<{ id: string; name: string; variantName: string | null }> =
          touchedIds.length
            ? await tx.product.findMany({
                where: { tenantId, parentProductId: familyId, id: { in: touchedIds } },
                select: { id: true, name: true, variantName: true },
              })
            : [];
        const foreign = touchedIds.filter((id) => !mine.some((m) => m.id === id));
        if (foreign.length > 0) {
          throw new BadRequestException(
            "Every updated or deactivated id must be a variant of this family.",
          );
        }
        // B964-2 (CHANGE-ONLY, as master's rule): a legacy formula-led name that is sent back UNCHANGED (e.g. with a sku
        // edit) is not refused; only a name that CHANGES to formula-led text is, before any write.
        update.forEach((u, i) => {
          if (!u.name) return;
          const stored = mine.find((m) => m.id === u.id);
          assertSafeVariantName(
            "update",
            i,
            { name: u.name.trim(), variantName: u.name.trim() },
            stored && { name: stored.name, variantName: stored.variantName },
          );
        });

        // ONE sorted lock call: the codes written AND every code of the variants being changed/deactivated.
        const held: string[] = [];
        for (const id of touchedIds) {
          // eslint-disable-next-line no-await-in-loop -- a bounded set, before any lock is taken
          held.push(...(await peekProductCodes(tx, tenantId, id)));
        }
        const lockList = [...codes.map((c) => c.value), ...held].filter((c) => c.trim().length > 0);
        await lockBarcodeCodes(tx, tenantId, lockList);
        const lockedCodes = new Set(lockList);
        const nameKeys = [...new Set(nameInputs.map((n) => n.name.toLowerCase()))].sort();
        for (const key of nameKeys) {
          const name = nameInputs.find((n) => n.name.toLowerCase() === key)!.name;
          // eslint-disable-next-line no-await-in-loop -- sorted, reentrant name locks
          await lockProductName(tx, tenantId, familyId, name);
        }
        for (const id of [...touchedIds].sort()) {
          // eslint-disable-next-line no-await-in-loop -- id order: two PATCHes on one family cannot deadlock
          await lockProductRow(tx, tenantId, id);
        }

        const conflicts: FamilyRowConflict[] = [
          ...familyGridConflicts(
            [...addRows, ...updRows]
              .filter((r) => r.name != null)
              .map((r) => ({
                row: r.row,
                name: r.name as string,
                sku: r.sku,
                barcode: r.barcode,
                unitSku: r.unitSku,
              })),
          ),
          ...(await codeTakenBy(tx, tenantId, codes, { excludeProductIds: deactivate })),
          ...(await nameTakenBy(tx, tenantId, nameInputs, { excludeProductIds: deactivate })),
        ];
        if (conflicts.length > 0) throw this.rowsConflict(conflicts);

        // Writes: deactivate first (codes released BEFORE the isActive write, SA-603a, under the locks taken above).
        for (const id of [...deactivate].sort()) {
          // eslint-disable-next-line no-await-in-loop
          await releaseProductCodes(tx, { tenantId, productId: id, lockedCodes });
          // eslint-disable-next-line no-await-in-loop
          await tx.product.update({ where: { id }, data: { isActive: false } });
        }
        // #2860 claim semantics (Opus #2881 B2): a legacy INACTIVE holder of a code still holds it LIVE, so the claim
        // releases it (one audit row) before the write instead of hitting the unique index.
        for (const r of [...updRows, ...addRows]) {
          const claimed = this.codeInputs([r]).map((c) => ({ field: c.field, value: c.value }));
          // eslint-disable-next-line no-await-in-loop
          await claimCodes(tx, {
            tenantId,
            productId: "id" in r ? (r as { id: string }).id : null,
            actorId,
            codes: claimed,
          });
        }
        const priceEdits = update.filter((u) => u.pricePerUnit !== undefined).map((u) => u.id);
        const oldPrices = new Map<string, Record<FamilyPriceColumn, Prisma.Decimal | null>>(
          priceEdits.length > 0
            ? (
                await tx.product.findMany({
                  where: { tenantId, id: { in: priceEdits } },
                  select: {
                    id: true,
                    pricePerUnit: true,
                    priceTier2: true,
                    priceTier3: true,
                    priceTier4: true,
                    priceTier5: true,
                  },
                })
              ).map((p: { id: string } & Record<FamilyPriceColumn, Prisma.Decimal | null>) => [
                p.id,
                p,
              ])
            : [],
        );
        for (const u of update) {
          // eslint-disable-next-line no-await-in-loop
          await tx.product.update({
            where: { id: u.id },
            data: this.variantPatch(u, oldPrices.get(u.id)),
          });
          if (u.barcode !== undefined || u.unitsPerBox !== undefined) {
            // eslint-disable-next-line no-await-in-loop
            const row: { barcode: string | null; unitsPerBox: number | null } =
              await tx.product.findFirst({
                where: { id: u.id, tenantId },
                select: { barcode: true, unitsPerBox: true },
              });
            // eslint-disable-next-line no-await-in-loop
            await syncProductBarcodesFromLegacy(tx, {
              tenantId,
              productId: u.id,
              barcode: row.barcode,
              unitsPerBox: row.unitsPerBox,
            });
          }
        }
        const familyPrices =
          authority && add.length > 0
            ? await familyPricesForNewVariant(tx, { tenantId, familyId, dto: {} })
            : undefined;
        const added: string[] = [];
        for (const v of add) {
          // eslint-disable-next-line no-await-in-loop
          const created = await tx.product.create({
            data: this.variantData(
              familyId,
              v,
              familyPrices,
              family.standardCost == null ? null : family.standardCost.toString(),
              unitsV2,
            ),
          });
          added.push(created.id);
          // eslint-disable-next-line no-await-in-loop
          await writeFamilyAssigned(tx, {
            tenantId,
            actorId,
            productId: created.id,
            fromParentId: null,
            toParentId: familyId,
            variantName: v.name.trim(),
            via: "family_editor",
          });
          // eslint-disable-next-line no-await-in-loop
          await syncProductBarcodesFromLegacy(tx, {
            tenantId,
            productId: created.id,
            barcode: blank(v.barcode),
            unitsPerBox: v.unitsPerBox ?? null,
          });
        }
        return { added, updated: update.map((u) => u.id), deactivated: deactivate };
      });

    let result;
    try {
      result = await run();
    } catch (e) {
      // The P2002 backstop (Opus #2881 B3): a unique-index hit that slipped past the locks answers the same 409.
      await this.reattribute(e, tenantId, codes, nameInputs, deactivate);
      throw e;
    }
    await this.afterWrite(actorId, familyId, FAMILY_VARIANTS_UPDATED_ACTION, {
      added: result.added.length,
      updated: result.updated.length,
      deactivated: result.deactivated.length,
    });
    return result;
  }

  private variantPatch(
    u: FamilyVariantUpdateDto,
    old?: Record<FamilyPriceColumn, Prisma.Decimal | null>,
  ): Prisma.ProductUncheckedUpdateInput {
    const data: Prisma.ProductUncheckedUpdateInput = {};
    if (u.name !== undefined) {
      data.name = u.name.trim();
      data.variantName = u.name.trim();
    }
    if (u.sku !== undefined) data.sku = blank(u.sku);
    if (u.barcode !== undefined) data.barcode = blank(u.barcode);
    if (u.unitSku !== undefined) data.unitSku = blank(u.unitSku);
    if (u.unitsPerBox !== undefined) data.unitsPerBox = u.unitsPerBox;
    if (u.pricePerUnit !== undefined) {
      // Authority off: create sets all five columns to the price, so an edit moves every tier that still EQUALS the old
      // price (Opus #2881 B5) — a tier-2..5 customer must not keep being billed the old price, and a deliberately
      // different tier stays as the operator set it.
      const price = money(u.pricePerUnit);
      for (const c of FAMILY_PRICE_COLUMNS) {
        const following = c === "pricePerUnit" || !old || sameMoney(old[c], old.pricePerUnit);
        if (following) data[c] = price;
      }
    }
    if (u.standardCost !== undefined) data.standardCost = cost4(u.standardCost);
    return data;
  }

  /** GET /products/sku-available: advisory only (the write is the authority), through the SAME codeTakenBy. */
  async skuAvailable(code: string, excludeProductId?: string) {
    if (typeof code !== "string" || code.trim().length === 0) {
      // An empty code would OR-match every product; answer a 400 instead of a random product's name.
      throw new BadRequestException("A code is required.");
    }
    const tenantId = this.tenant();
    const db = this.prisma.forTenant() as unknown as CatalogTx;
    for (const field of CODE_FIELDS) {
      // eslint-disable-next-line no-await-in-loop
      const [hit] = await codeTakenBy(db, tenantId, [{ row: 0, field, value: code }], {
        excludeProductIds: excludeProductId ? [excludeProductId] : [],
      });
      if (hit) {
        return { available: false, takenBy: { productId: hit.conflictProductId as string, field } };
      }
    }
    return { available: true };
  }
}
