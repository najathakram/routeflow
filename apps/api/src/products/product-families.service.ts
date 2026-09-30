import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { FamilyRowConflict } from "@routeflow/types";
import { roundMoney, roundUnitCost } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { AuditService } from "../audit/audit.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { PrismaService } from "../prisma/prisma.service";
import {
  codeTakenBy,
  familyGridConflicts,
  nameTakenBy,
  type FamilyCodeInput,
} from "./product-family-conflicts";
import {
  lockBarcodeCodes,
  lockProductRow,
  syncProductBarcodesFromLegacy,
  type CatalogTx,
} from "./product-catalog-sync";
import { peekProductCodes, releaseProductCodes, type CodeField } from "./product-code-release";
import { familyPriceAuthorityError, readFamilyPriceMode } from "./family-price";
import { lockProductName } from "./product-name-rules";
import type {
  CreateFamilyDto,
  FamilyVariantDto,
  FamilyVariantUpdateDto,
  UpdateFamilyVariantsDto,
} from "./dto/family.dto";

/**
 * WS8 (SA-606): families. A FAMILY (kind FAMILY, parentProductId null) is a non-stocked, NON-SELLABLE container; its
 * variants (kind VARIANT, parentProductId = the family) are the sellable rows. Both writes are ALL-OR-NOTHING in ONE
 * tenantTransaction with the house lock order (every code, sorted, in ONE call -> the name lock -> rows), and a conflict
 * is a 409 FAMILY_ROWS_CONFLICT listing EVERY conflicting row. The cap is 200 rows per call.
 */
const CODE_FIELDS: readonly CodeField[] = ["sku", "barcode", "unitSku"];
const MAX_ROWS = 200;
export const FAMILY_CREATED_ACTION = "product.family_created";

const blank = (v: string | undefined | null): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v : null;
const money = (v: string | undefined | null, fallback = 0): string =>
  roundMoney(v != null && v !== "" ? Number(v) : fallback).toFixed(2);

@Injectable()
export class ProductFamiliesService {
  private readonly logger = new Logger(ProductFamiliesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RouteFlowGateway,
    private readonly audit: AuditService,
    // #2717 M2 price authority: optional like ProductsService (a missing provider reads as mode "off").
    @Optional() private readonly featureConfig?: FeatureConfigService,
  ) {}

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
      sku?: string;
      barcode?: string;
      unitSku?: string;
    }>,
  ): FamilyCodeInput[] {
    const out: FamilyCodeInput[] = [];
    for (const r of rows) {
      for (const field of CODE_FIELDS) {
        const value = blank(r[field]);
        if (value) out.push({ row: r.row, field, value });
      }
    }
    return out;
  }

  /** POST /products/families */
  async createFamily(dto: CreateFamilyDto, actorId: string | null) {
    const tenantId = this.tenant();
    if (dto.variants.length < 1 || dto.variants.length > MAX_ROWS) {
      throw new BadRequestException(`A family takes 1 to ${MAX_ROWS} variants per request.`);
    }
    const variantRows = dto.variants.map((v, i) => ({ row: i, ...v }));
    const familyPrice = money(dto.family.pricePerUnit);
    const run = () =>
      this.prisma.tenantTransaction(async (tx: CatalogTx) => {
        const codes = this.codeInputs(variantRows);
        // House order: ONE sorted code-lock call, then the name lock, then rows.
        await lockBarcodeCodes(
          tx,
          tenantId,
          codes.map((c) => c.value),
        );
        await lockProductName(tx, tenantId, null, dto.family.name);
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
          ...(await nameTakenBy(tx, tenantId, [
            { row: "family", name: dto.family.name, parentProductId: null },
          ])),
        ];
        if (conflicts.length > 0) throw this.rowsConflict(conflicts);

        const family = await tx.product.create({
          data: {
            name: dto.family.name,
            unit: "each",
            pricePerUnit: familyPrice,
            ...(dto.family.standardCost != null && dto.family.standardCost !== ""
              ? { standardCost: roundUnitCost(Number(dto.family.standardCost)).toFixed(4) }
              : {}),
            category: dto.family.category ?? null,
            description: dto.family.description ?? null,
            kind: "FAMILY",
            parentProductId: null,
            isActive: true,
          },
        });
        const variants: Array<{ id: string; name: string }> = [];
        for (const v of dto.variants) {
          // eslint-disable-next-line no-await-in-loop -- <= 200 rows, ordered, one tx
          const created = await tx.product.create({
            data: this.variantData(
              family.id,
              v,
              dto.copyFamilyPrice ? familyPrice : undefined,
              dto.family.standardCost,
            ),
          });
          variants.push({ id: created.id, name: created.name });
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
      await this.reattribute(e, tenantId, variantRows, dto.family.name, null);
      throw e;
    }
    await this.afterWrite(actorId, result.family.id, { variantCount: result.variants.length });
    return result;
  }

  private variantData(
    familyId: string,
    v: FamilyVariantDto,
    copiedPrice?: string,
    familyCost?: string | null,
  ): Prisma.ProductUncheckedCreateInput {
    const cost = v.standardCost ?? familyCost;
    const price = copiedPrice ?? money(v.pricePerUnit);
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
      pricePerUnit: price,
      priceTier2: price,
      priceTier3: price,
      priceTier4: price,
      priceTier5: price,
      ...(cost != null && cost !== ""
        ? { standardCost: roundUnitCost(Number(cost)).toFixed(4) }
        : {}),
      isActive: true,
    };
  }

  /** A P2002 backstop that slipped past the locks: re-run the ONE check and answer with the same 409 shape. */
  private async reattribute(
    e: unknown,
    tenantId: string,
    variantRows: ReadonlyArray<FamilyVariantDto & { row: number }>,
    familyName: string | null,
    parentProductId: string | null,
  ): Promise<void> {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return;
    const db = this.prisma.forTenant() as unknown as CatalogTx;
    const conflicts = [
      ...(await codeTakenBy(db, tenantId, this.codeInputs(variantRows))),
      ...(familyName
        ? await nameTakenBy(db, tenantId, [{ row: "family", name: familyName, parentProductId }])
        : []),
    ];
    if (conflicts.length > 0) throw this.rowsConflict(conflicts);
  }

  private async afterWrite(
    actorId: string | null,
    productId: string,
    meta: Record<string, unknown>,
  ) {
    await this.audit.log({
      tenantId: this.prisma.getTenantId(),
      userId: actorId,
      action: FAMILY_CREATED_ACTION,
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
    // M2 price authority: while mixed_packs is ON the family owns the variants' price, so a price EDIT is a 409 and an
    // added variant takes the family's price (never a price of its own).
    const authority = (await readFamilyPriceMode(this.featureConfig, tenantId)) === "on";
    if (authority && update.some((u) => u.pricePerUnit !== undefined)) {
      throw familyPriceAuthorityError(familyId);
    }
    const result = await this.prisma.tenantTransaction(async (tx: CatalogTx) => {
      const family: {
        id: string;
        kind: string;
        pricePerUnit: unknown;
        standardCost: unknown;
      } | null = await tx.product.findFirst({
        where: { id: familyId, tenantId },
        select: { id: true, kind: true, pricePerUnit: true, standardCost: true },
      });
      if (!family) throw new BadRequestException("Product not found");
      if (family.kind !== "FAMILY") throw new BadRequestException("This product is not a family.");
      const touchedIds = [...new Set([...update.map((u) => u.id), ...deactivate])];
      const mine: Array<{ id: string }> = touchedIds.length
        ? await tx.product.findMany({
            where: { tenantId, parentProductId: familyId, id: { in: touchedIds } },
            select: { id: true },
          })
        : [];
      const foreign = touchedIds.filter((id) => !mine.some((m) => m.id === id));
      if (foreign.length > 0) {
        throw new BadRequestException(
          "Every updated or deactivated id must be a variant of this family.",
        );
      }

      const addRows = add.map((v, i) => ({ row: i, ...v }));
      const updRows = update.map((u, i) => ({ row: add.length + i, ...u }));
      const codes = this.codeInputs([...addRows, ...updRows]);
      // ONE sorted lock call: the codes written AND every code of the variants being changed/deactivated.
      const held: string[] = [];
      for (const id of touchedIds) {
        // eslint-disable-next-line no-await-in-loop -- a bounded set, before any lock is taken
        held.push(...(await peekProductCodes(tx, tenantId, id)));
      }
      await lockBarcodeCodes(tx, tenantId, [...codes.map((c) => c.value), ...held]);
      for (const n of new Set([
        ...addRows.map((r) => r.name),
        ...updRows.filter((r) => r.name).map((r) => r.name as string),
      ])) {
        // eslint-disable-next-line no-await-in-loop
        await lockProductName(tx, tenantId, familyId, n);
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
        ...(await codeTakenBy(tx, tenantId, codes, { excludeProductIds: touchedIds })),
        ...(await nameTakenBy(
          tx,
          tenantId,
          [
            ...addRows.map((r) => ({ row: r.row, name: r.name, parentProductId: familyId })),
            ...updRows
              .filter((r) => r.name)
              .map((r) => ({
                row: r.row,
                name: r.name as string,
                parentProductId: familyId,
                excludeId: r.id,
              })),
          ].filter((n) => !deactivate.includes((n as { excludeId?: string }).excludeId ?? "")),
        )),
      ];
      if (conflicts.length > 0) throw this.rowsConflict(conflicts);

      // Writes: deactivate first (codes released BEFORE the isActive write, SA-603a), then updates, then adds.
      for (const id of [...deactivate].sort()) {
        // eslint-disable-next-line no-await-in-loop
        await releaseProductCodes(tx, { tenantId, productId: id });
        // eslint-disable-next-line no-await-in-loop
        await tx.product.update({ where: { id }, data: { isActive: false } });
      }
      for (const u of update) {
        // eslint-disable-next-line no-await-in-loop
        await lockProductRow(tx, tenantId, u.id);
        // eslint-disable-next-line no-await-in-loop
        await tx.product.update({ where: { id: u.id }, data: this.variantPatch(u) });
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
      const added: string[] = [];
      for (const v of add) {
        // eslint-disable-next-line no-await-in-loop
        const created = await tx.product.create({
          data: this.variantData(
            familyId,
            v,
            authority ? money(String(family.pricePerUnit)) : undefined,
            family.standardCost == null ? null : String(family.standardCost),
          ),
        });
        added.push(created.id);
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
    await this.afterWrite(actorId, familyId, {
      added: result.added.length,
      updated: result.updated.length,
      deactivated: result.deactivated.length,
    });
    return result;
  }

  private variantPatch(u: FamilyVariantUpdateDto): Prisma.ProductUncheckedUpdateInput {
    const data: Prisma.ProductUncheckedUpdateInput = {};
    if (u.name !== undefined) {
      data.name = u.name.trim();
      data.variantName = u.name.trim();
    }
    if (u.sku !== undefined) data.sku = blank(u.sku);
    if (u.barcode !== undefined) data.barcode = blank(u.barcode);
    if (u.unitSku !== undefined) data.unitSku = blank(u.unitSku);
    if (u.unitsPerBox !== undefined) data.unitsPerBox = u.unitsPerBox;
    if (u.pricePerUnit !== undefined) data.pricePerUnit = money(u.pricePerUnit);
    if (u.standardCost !== undefined)
      data.standardCost = roundUnitCost(Number(u.standardCost)).toFixed(4);
    return data;
  }

  /** GET /products/sku-available: advisory only (the write is the authority), through the SAME codeTakenBy. */
  async skuAvailable(code: string, excludeProductId?: string) {
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
