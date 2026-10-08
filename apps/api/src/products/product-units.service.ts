import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PIECE_LABEL } from "@routeflow/pricing";
import { inferBarcodeSymbology } from "../common/barcode-symbology";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLock } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { CreateProductUnitDto, UpdateProductUnitDto } from "./dto/product-unit.dto";
import { ReplaceProductUnitsDto } from "./dto/replace-product-units.dto";
import { syncProductBarcodesFromLegacy } from "./product-catalog-sync";
import {
  assertCodeFree,
  CodeValidationError,
  lockClaims,
  normalizeCode,
  type CodeClaim,
} from "./unit-codes";
import { baseWord, flattenLadder, LadderError, type FlatLevel } from "./unit-ladder";

interface PackInfo {
  label: string;
  factor: number;
  regulated: boolean;
}

interface LevelKey {
  label: string;
  factorToBase: number;
}

const norm = (s: string) => s.trim().toLowerCase();

/** What the API returns for a level — never `tenantId` or audit columns. */
const UNIT_SELECT = {
  id: true,
  label: true,
  factorToBase: true,
  price: true,
  priceTier2: true,
  priceTier3: true,
  priceTier4: true,
  priceTier5: true,
  isDefaultSelling: true,
  sortOrder: true,
  // Units rebuild: the chain count, the level's own SKU and its tenant unit name.
  perParent: true,
  sku: true,
  tenantUnitId: true,
} as const;

const COULDNT_CHECK = "Couldn't check that code right now. Your entry is still here. Try again.";
const NAME_MAX = 30;
/** Ladder levels carry their own barcode rows under these (BOX and UNIT stay the pack's and the base's). */
const LEVEL_BARCODE_SLOTS = ["INNER", "CASE", "DISPLAY", "PALLET"] as const;
const TIER_COLUMNS = ["priceTier2", "priceTier3", "priceTier4", "priceTier5"] as const;

const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";

/**
 * CRUD on a product's `ProductUnit` ladder (units_v1). Every rule here protects a money/stock
 * invariant: a line snapshots its factor, so what must never change under an existing document
 * is the (label → factor) meaning — a level is immutable once any line carries it (mint a new
 * level instead).
 *
 * Every mutation runs as ONE transaction holding a per-product advisory lock, with all reads
 * (pack, siblings, line check) inside it: the label/factor uniqueness, the single default unit
 * and the immutability check all see the committed truth and cannot race a concurrent editor.
 */
@Injectable()
export class ProductUnitsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(productId: string) {
    await this.loadPack(this.prisma.forTenant(), productId);
    return this.prisma.forTenant().productUnit.findMany({
      where: { productId },
      select: UNIT_SELECT,
      orderBy: [{ sortOrder: "asc" }, { factorToBase: "asc" }],
    });
  }

  /** Tenant unit names A-Z (archived ones flagged); the editor offers only active ones for new picks. */
  async tenantUnitNames() {
    const rows: Array<{ id: string; name: string; archivedAt: Date | null }> = await this.prisma
      .forTenant()
      .tenantUnit.findMany({ select: { id: true, name: true, archivedAt: true } });
    return rows
      .map((r) => ({ id: r.id, name: r.name, archived: r.archivedAt != null }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  create(productId: string, dto: CreateProductUnitDto) {
    return this.locked(productId, async (tx) => {
      const pack = await this.loadPack(tx, productId);
      const label = this.cleanLabel(dto.label, dto.factorToBase);
      this.assertLevelValid(pack, await this.siblings(tx, productId), {
        label,
        factorToBase: dto.factorToBase,
      });
      await this.assertNoLineDisagrees(tx, productId, label, dto.factorToBase);
      const makeDefault = dto.isDefaultSelling === true;
      if (makeDefault) await this.clearDefaults(tx, productId);
      return tx.productUnit.create({
        data: {
          productId,
          label,
          factorToBase: dto.factorToBase,
          price: dto.price ?? null,
          priceTier2: dto.priceTier2 ?? null,
          priceTier3: dto.priceTier3 ?? null,
          priceTier4: dto.priceTier4 ?? null,
          priceTier5: dto.priceTier5 ?? null,
          isDefaultSelling: makeDefault,
          sortOrder: dto.sortOrder ?? 0,
        },
        select: UNIT_SELECT,
      });
    });
  }

  update(productId: string, unitId: string, dto: UpdateProductUnitDto) {
    return this.locked(productId, async (tx) => {
      const pack = await this.loadPack(tx, productId);
      const row = await tx.productUnit.findFirst({ where: { id: unitId, productId } });
      if (!row) throw new NotFoundException("Unit not found");
      const factorToBase = dto.factorToBase ?? row.factorToBase;
      const label = this.cleanLabel(dto.label ?? row.label, factorToBase);
      const siblings = (await this.siblings(tx, productId)).filter((s) => s.id !== unitId);
      this.assertLevelValid(pack, siblings, { label, factorToBase });
      await this.assertImmutableIfUsed(tx, productId, row, { label, factorToBase });
      const { label: _l, factorToBase: _f, isDefaultSelling, ...rest } = dto;
      if (isDefaultSelling === true) await this.clearDefaults(tx, productId, unitId);
      return tx.productUnit.update({
        where: { id: unitId },
        data: {
          ...rest,
          label,
          factorToBase,
          ...(isDefaultSelling !== undefined ? { isDefaultSelling } : {}),
        },
        select: UNIT_SELECT,
      });
    });
  }

  /**
   * Lines snapshot their own factor + price, so deleting a level cannot change what a document
   * charged. (Their `unitLabel` then names a level that no longer exists — a later re-resolution
   * of that label must fall back to the line's own snapshot, never throw.)
   */
  remove(productId: string, unitId: string) {
    return this.locked(productId, async (tx) => {
      await this.loadPack(tx, productId);
      const row = await tx.productUnit.findFirst({
        where: { id: unitId, productId },
        select: { id: true },
      });
      if (!row) throw new NotFoundException("Unit not found");
      // The level's own barcode rows go with it (the FK would only orphan them as legacy-looking rows).
      await tx.productBarcode.deleteMany({ where: { productUnitId: unitId } });
      await tx.productUnit.delete({ where: { id: unitId } });
      return { deleted: true };
    });
  }

  /**
   * PUT /products/:id/units: replace the whole ladder (and the product's base / pack words) in ONE transaction.
   * The chain the editor sends is flattened here (`factorToBase` is the only math source), the per-tenant
   * `catalog-code` lock is taken FIRST, and any failure rolls back everything, TenantUnit upserts included.
   * A used level's size still cannot change, and no order or invoice line is ever touched.
   */
  async replace(productId: string, dto: ReplaceProductUnitsDto) {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) {
      throw new BadRequestException("Select a tenant before editing a product's units.");
    }
    const baseClean = this.cleanBase(dto.baseUnitLabel);
    let flat: FlatLevel[];
    try {
      flat = flattenLadder(baseClean, dto.levels);
    } catch (e) {
      throw this.mapLadderError(e);
    }
    try {
      const res = await withAdvisoryLock(
        { family: "catalog-code", key: tenantId, mode: "wait", waitMs: 10_000 },
        () =>
          this.prisma.tenantTransaction((tx) =>
            this.applyReplace(tx, tenantId, productId, dto, baseClean, flat),
          ),
      );
      return (res as { acquired: true; value: unknown }).value;
    } catch (e) {
      if (e instanceof LockTimeoutError || e instanceof LockUnavailableError) {
        throw new ServiceUnavailableException(COULDNT_CHECK);
      }
      if (isUniqueViolation(e)) {
        throw new ConflictException("This product already has a unit with that name or size.");
      }
      throw e;
    }
  }

  private cleanBase(raw: string | null | undefined): string | null {
    const t = (raw ?? "").trim();
    return !t || norm(t) === norm(PIECE_LABEL) ? null : t;
  }

  private mapLadderError(e: unknown): unknown {
    if (e instanceof LadderError) {
      const body = { message: e.message, field: e.field, level: e.level };
      return e.status === 409 ? new ConflictException(body) : new BadRequestException(body);
    }
    return e;
  }

  private code(
    raw: string | null | undefined,
    kind: "sku" | "barcode",
    level: string | undefined,
    existing?: string | null,
  ): string | null {
    try {
      return normalizeCode(raw, { existing });
    } catch (e) {
      if (e instanceof CodeValidationError) {
        throw new BadRequestException({ message: e.message, field: kind, level });
      }
      throw e;
    }
  }

  private async applyReplace(
    tx: any,
    tenantId: string,
    productId: string,
    dto: ReplaceProductUnitsDto,
    baseClean: string | null,
    flat: FlatLevel[],
  ) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('product-units'), hashtext(${productId}))`;
    const product = await tx.product.findFirst({
      where: { id: productId, tenantId },
      select: {
        id: true,
        unit: true,
        unitsPerBox: true,
        trackedCategoryId: true,
        sku: true,
        unitSku: true,
        barcode: true,
        baseUnitLabel: true,
        packLabel: true,
      },
    });
    if (!product) throw new NotFoundException("Product not found");
    const existing: any[] = await tx.productUnit.findMany({ where: { productId } });
    const existingByLabel = new Map(existing.map((u) => [norm(u.label), u]));
    const dtoByLabel = new Map(dto.levels.map((l) => [norm(l.label), l]));
    const base = baseWord(baseClean);

    // ── pack: one of the levels (or the base); never a ladder row of its own ──
    const packRaw = (dto.packLevel ?? "").trim();
    let packFactor: number;
    let packFlat: FlatLevel | null = null;
    let packIsBase = false;
    if (packRaw) {
      if (norm(packRaw) === norm(base)) {
        packIsBase = true;
        packFactor = 1;
      } else {
        packFlat = flat.find((l) => norm(l.label) === norm(packRaw)) ?? null;
        if (!packFlat) {
          throw new BadRequestException({
            message: "Pick the pack from the units in this ladder.",
            field: "pack",
          });
        }
        packFactor = packFlat.factorToBase;
      }
    } else {
      const upb = Math.trunc(Number(product.unitsPerBox ?? 0));
      packFactor = upb > 1 ? upb : 1;
    }
    if (product.trackedCategoryId != null) {
      const above = flat.some((l) => l !== packFlat && l.factorToBase > packFactor);
      if (above) {
        throw new BadRequestException(
          "A regulated product cannot be sold above its pack size (a filing could not count it).",
        );
      }
    }
    const persisted = flat.filter((l) => l !== packFlat);
    // The same naming rule as the one-level routes: "Piece" is always exactly the factor-1 unit.
    for (const l of persisted) this.cleanLabel(l.label, l.factorToBase);

    // ── tenant unit names ──
    const tenantUnitIds = await this.upsertTenantUnits(tx, tenantId, {
      names: [
        ...(baseClean ? [baseClean] : []),
        ...flat.map((l) => l.label),
        ...(dto.newUnits ?? []),
      ],
      newUnits: dto.newUnits ?? [],
      alreadyOnProduct: new Set(
        [...existing.map((u) => u.label), product.baseUnitLabel, product.packLabel]
          .filter((v): v is string => typeof v === "string")
          .map(norm),
      ),
    });

    // ── a used level's size never changes ──
    for (const l of persisted) {
      const was = existingByLabel.get(norm(l.label));
      if (!was || was.factorToBase !== l.factorToBase) {
        await this.assertNoLineDisagrees(tx, productId, l.label, l.factorToBase);
      }
    }

    // ── codes: validate, then lock, then check ──
    // Single writer (SA-729g 5): the base / pack SKUs (Product.unitSku / Product.sku) and their barcodes belong to
    // the product editor. This save writes only ProductUnit.sku and ladder-row barcodes.
    const baseSku = product.unitSku ?? product.sku ?? null;
    const levelCodes = persisted.map((l) => {
      const d = dtoByLabel.get(norm(l.label)) as NonNullable<ReturnType<typeof dtoByLabel.get>>;
      const was = existingByLabel.get(norm(l.label));
      let sku = this.code(d.sku, "sku", l.label, was?.sku);
      let barcode = this.code(d.barcode, "barcode", l.label);
      if (sku != null && sku === baseSku) sku = null;
      if (barcode != null && (barcode === baseSku || barcode === product.barcode)) barcode = null;
      return { l, sku, barcode };
    });
    const held = new Set<string>(
      [
        product.sku,
        product.unitSku,
        product.barcode,
        ...existing.map((u) => u.sku),
        ...(
          await tx.productBarcode.findMany({
            where: { tenantId, productId, code: { not: null } },
          })
        ).map((b: any) => b.code),
      ].filter((v): v is string => typeof v === "string"),
    );
    const claims: CodeClaim[] = [];
    const claim = (kind: "sku" | "barcode", value: string | null, level?: string) => {
      if (value && !held.has(value) && !claims.some((c) => c.value === value && c.kind === kind)) {
        claims.push({ kind, value, level });
      }
    };
    for (const c of levelCodes) {
      claim("sku", c.sku, c.l.label);
      claim("barcode", c.barcode, c.l.label);
    }
    if (claims.length > 0) {
      await lockClaims(tx, tenantId, claims);
      for (const c of claims.sort((a, b) => a.value.localeCompare(b.value))) {
        await assertCodeFree(tx, { tenantId, productId, claim: c });
      }
    }
    if (levelCodes.filter((c) => c.barcode).length > LEVEL_BARCODE_SLOTS.length) {
      throw new ConflictException({
        code: API_ERROR_CODES.LEVEL_CODES_FULL,
        message:
          "Only 4 levels can have their own code. Leave this level\'s code blank and it will use the code of the level above, or remove a code from another level.",
        field: "barcode",
      });
    }

    // ── writes ──
    const keepLabels = new Set(persisted.map((l) => norm(l.label)));
    const pieceRow = existing.find((u) => u.factorToBase === 1);
    const dropIds = existing
      .filter((u) => !keepLabels.has(norm(u.label)) && !(u === pieceRow && dto.base === undefined))
      .map((u) => u.id);
    if (dropIds.length > 0) {
      await tx.productBarcode.deleteMany({ where: { productUnitId: { in: dropIds } } });
      await tx.productUnit.deleteMany({ where: { id: { in: dropIds } } });
    }
    // Park resized rows on a negative size first so a swap cannot trip (productId, factorToBase).
    const resized = persisted.filter((l) => {
      const was = existingByLabel.get(norm(l.label));
      return was && was.factorToBase !== l.factorToBase;
    });
    let parked = 0;
    for (const l of resized) {
      const was = existingByLabel.get(norm(l.label));
      await tx.productUnit.update({
        where: { id: was.id },
        data: { factorToBase: -++parked },
      });
    }

    const defaultLabel =
      persisted.find((l) => dtoByLabel.get(norm(l.label))?.isDefaultSelling)?.label ?? null;
    const ids = new Map<string, string>();
    for (const [i, l] of persisted.entries()) {
      const d = dtoByLabel.get(norm(l.label)) as NonNullable<ReturnType<typeof dtoByLabel.get>>;
      const was = existingByLabel.get(norm(l.label));
      const code = levelCodes[i];
      const data = {
        label: l.label,
        factorToBase: l.factorToBase,
        perParent: l.perParent,
        tenantUnitId: tenantUnitIds.get(norm(l.label)) ?? null,
        price: d.price ?? null,
        ...this.tierData(d.tiers),
        isDefaultSelling: defaultLabel != null && norm(defaultLabel) === norm(l.label),
        sortOrder: d.sortOrder,
        sku: code.sku,
      };
      if (was) {
        await tx.productUnit.update({ where: { id: was.id }, data });
        ids.set(norm(l.label), was.id);
      } else {
        const made = await tx.productUnit.create({ data: { productId, tenantId, ...data } });
        ids.set(norm(l.label), made.id);
      }
    }
    for (const l of persisted) {
      if (!l.parentLabel) continue;
      const parentId = ids.get(norm(l.parentLabel));
      const id = ids.get(norm(l.label)) as string;
      const was = existingByLabel.get(norm(l.label));
      if (parentId && (was?.parentUnitId ?? null) !== parentId) {
        await tx.productUnit.update({ where: { id }, data: { parentUnitId: parentId } });
      }
    }
    for (const l of persisted) {
      if (l.parentLabel) continue;
      const was = existingByLabel.get(norm(l.label));
      if (was?.parentUnitId) {
        await tx.productUnit.update({ where: { id: was.id }, data: { parentUnitId: null } });
      }
    }
    if (dto.base !== undefined)
      await this.writePieceRow(tx, productId, pieceRow, dto.base, defaultLabel);

    await this.writeLevelBarcodes(tx, tenantId, productId, levelCodes, ids);

    // ── the product's own words and codes ──
    const packLabelNew = packFlat
      ? packFlat.label
      : packIsBase
        ? null
        : this.cleanWord(dto.packLabel);
    // `undefined` = leave the column alone (Prisma ignores it): the pack and the codes only move when this save says so.
    const unitsPerBoxNew: number | null | undefined = packRaw
      ? packIsBase
        ? null
        : packFactor
      : undefined;
    await tx.product.update({
      where: { id: productId },
      data: {
        baseUnitLabel: baseClean,
        packLabel: packLabelNew,
        unitsPerBox: unitsPerBoxNew,
      },
    });
    const upbAfter = unitsPerBoxNew === undefined ? product.unitsPerBox : unitsPerBoxNew;
    const barcodeAfter = product.barcode;
    // The BOX/UNIT mirror rows depend on unitsPerBox, so a changed pack re-syncs them (ladder rows are left alone).
    if (barcodeAfter && unitsPerBoxNew !== undefined && upbAfter !== product.unitsPerBox) {
      await syncProductBarcodesFromLegacy(tx, {
        tenantId,
        productId,
        barcode: barcodeAfter,
        unitsPerBox: upbAfter,
        previousBarcode: product.barcode,
      });
    }

    const levels = await tx.productUnit.findMany({
      where: { productId },
      select: UNIT_SELECT,
      orderBy: [{ sortOrder: "asc" }, { factorToBase: "asc" }],
    });
    return {
      baseUnitLabel: baseClean,
      packLabel: packLabelNew,
      unitsPerBox: upbAfter ?? null,
      levels,
    };
  }

  private cleanWord(raw: string | null | undefined): string | null {
    const t = (raw ?? "").trim();
    return t || null;
  }

  private tierData(tiers: Array<number | null> | undefined) {
    const out: Record<string, number | null> = {};
    TIER_COLUMNS.forEach((col, i) => {
      out[col] = tiers?.[i] ?? null;
    });
    return out;
  }

  /** The legacy factor-1 "Piece" row carries the base unit's own price / tiers / default flag. */
  private async writePieceRow(
    tx: any,
    productId: string,
    row: any,
    base: NonNullable<ReplaceProductUnitsDto["base"]> | null,
    levelDefault: string | null,
  ) {
    const isDefault = levelDefault == null && base?.isDefaultSelling === true;
    const empty =
      !base || (base.price == null && !(base.tiers ?? []).some((t) => t != null) && !isDefault);
    if (empty) {
      if (row) {
        await tx.productBarcode.deleteMany({ where: { productUnitId: row.id } });
        await tx.productUnit.delete({ where: { id: row.id } });
      }
      return;
    }
    const data = {
      label: PIECE_LABEL,
      factorToBase: 1,
      price: base.price ?? null,
      ...this.tierData(base.tiers),
      isDefaultSelling: isDefault,
      sortOrder: 0,
    };
    if (row) await tx.productUnit.update({ where: { id: row.id }, data });
    else await tx.productUnit.create({ data: { productId, ...data } });
  }

  private async writeLevelBarcodes(
    tx: any,
    tenantId: string,
    productId: string,
    levelCodes: Array<{ l: FlatLevel; barcode: string | null }>,
    ids: Map<string, string>,
  ) {
    const wanted = levelCodes
      .filter((c) => c.barcode)
      .sort((a, b) => a.l.factorToBase - b.l.factorToBase)
      .map((c, i) => ({
        productUnitId: ids.get(norm(c.l.label)) as string,
        code: c.barcode as string,
        level: LEVEL_BARCODE_SLOTS[i],
      }));
    const key = (r: { productUnitId: string; code: string; level: string }) =>
      `${r.productUnitId}|${r.code}|${r.level}`;
    const unitIds = [...ids.values()];
    const current: any[] = await tx.productBarcode.findMany({
      where: { tenantId, productId, productUnitId: { in: unitIds }, code: { not: null } },
    });
    const wantedKeys = new Set(wanted.map(key));
    const stale = current.filter((r) => !wantedKeys.has(key(r)));
    if (stale.length > 0) {
      await tx.productBarcode.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
    }
    const have = new Set(current.filter((r) => wantedKeys.has(key(r))).map(key));
    for (const w of wanted.filter((x) => !have.has(key(x)))) {
      await tx.productBarcode.create({
        data: {
          tenantId,
          productId,
          productUnitId: w.productUnitId,
          code: w.code,
          level: w.level,
          symbology: inferBarcodeSymbology(w.code),
          origin: "ENTERED",
          copiedFromLevel: null,
          primaryFor: null,
        },
      });
    }
  }

  /** Idempotent by nameKey. An ARCHIVED name is never silently restored, unless this product already uses it. */
  private async upsertTenantUnits(
    tx: any,
    tenantId: string,
    input: { names: string[]; newUnits: string[]; alreadyOnProduct: Set<string> },
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const rows: any[] = await tx.tenantUnit.findMany({ where: { tenantId } });
    const byKey = new Map(rows.map((r) => [r.nameKey as string, r]));
    const seen = new Set<string>();
    const newKeys = new Set(input.newUnits.map(norm));
    for (const raw of input.names) {
      const name = (raw ?? "").trim();
      if (!name) {
        if (newKeys.has(norm(raw ?? ""))) throw new BadRequestException("Enter a name.");
        continue;
      }
      const key = norm(name);
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = byKey.get(key);
      if (hit) {
        if (hit.archivedAt && !input.alreadyOnProduct.has(key)) {
          throw new BadRequestException({
            code: API_ERROR_CODES.UNIT_ARCHIVED,
            message: `${hit.name} is archived. Restore it in Settings, or pick another unit.`,
            field: "label",
          });
        }
        out.set(key, hit.id);
        continue;
      }
      if (name.length > NAME_MAX) {
        throw new BadRequestException("Keep it to 30 characters or fewer.");
      }
      const made = await tx.tenantUnit.create({ data: { tenantId, name, nameKey: key } });
      out.set(key, made.id);
    }
    // A blank entry in newUnits (the loop above skips blanks it could not name) is a 400.
    if (input.newUnits.some((n) => !(n ?? "").trim())) {
      throw new BadRequestException("Enter a name.");
    }
    return out;
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  /** One transaction + a per-product advisory xact lock; unique-index races become a 409. */
  private async locked<T>(productId: string, fn: (tx: any) => Promise<T>): Promise<T> {
    // A write needs a tenant: without one `tenantTransaction` hands back the raw client and the
    // insert would carry no tenantId (a 500 on the NOT NULL column). SUPER_ADMIN must act inside a tenant.
    if (!this.prisma.getTenantId()) {
      throw new BadRequestException("Select a tenant before editing a product's units.");
    }
    try {
      return await this.prisma.tenantTransaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('product-units'), hashtext(${productId}))`;
        return fn(tx);
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException("This product already has a unit with that name or size.");
      }
      throw e;
    }
  }

  /** `findFirst` (not `findUnique`) so the tenant filter is ANDed into the WHERE — a foreign
   *  product 404s instead of leaking its pack shape. */
  private async loadPack(db: any, productId: string): Promise<PackInfo> {
    const p = await db.product.findFirst({
      where: { id: productId },
      select: { unit: true, unitsPerBox: true, trackedCategoryId: true },
    });
    if (!p) throw new NotFoundException("Product not found");
    const upb = Math.trunc(Number(p.unitsPerBox ?? 0));
    return {
      label: (p.unit ?? "").trim() || "Box",
      factor: upb > 1 ? upb : 1,
      regulated: p.trackedCategoryId != null,
    };
  }

  private siblings(db: any, productId: string): Promise<Array<LevelKey & { id: string }>> {
    return db.productUnit.findMany({
      where: { productId },
      select: { id: true, label: true, factorToBase: true },
    });
  }

  private clearDefaults(db: any, productId: string, exceptUnitId?: string) {
    return db.productUnit.updateMany({
      where: {
        productId,
        isDefaultSelling: true,
        ...(exceptUnitId ? { NOT: { id: exceptUnitId } } : {}),
      },
      data: { isDefaultSelling: false },
    });
  }

  /** The Piece level is always factor 1 and factor 1 is always exactly "Piece" — never renamed. */
  private cleanLabel(raw: string, factorToBase: number): string {
    const label = (raw ?? "").trim();
    if (!label) throw new BadRequestException("A unit needs a name");
    const isPiece = norm(label) === norm(PIECE_LABEL);
    if (factorToBase === 1 && !isPiece) {
      throw new BadRequestException(`A 1-piece unit is always named "${PIECE_LABEL}".`);
    }
    if (factorToBase !== 1 && isPiece) {
      throw new BadRequestException(`"${PIECE_LABEL}" is always exactly 1 piece.`);
    }
    return factorToBase === 1 ? PIECE_LABEL : label;
  }

  private assertLevelValid(pack: PackInfo, siblings: LevelKey[], level: LevelKey): void {
    if (level.factorToBase === pack.factor) {
      throw new BadRequestException(
        pack.factor === 1
          ? "This product has no pack size — a piece is the product itself; set its price on the product."
          : `${level.factorToBase} pieces is the pack size — set the pack's own price on the product.`,
      );
    }
    if (norm(level.label) === norm(pack.label)) {
      throw new BadRequestException(`"${level.label}" is already the name of the pack.`);
    }
    if (pack.regulated && level.factorToBase > pack.factor) {
      throw new BadRequestException(
        "A regulated product cannot be sold above its pack size (a filing could not count it).",
      );
    }
    if (siblings.some((s) => norm(s.label) === norm(level.label))) {
      throw new ConflictException(`This product already has a unit named "${level.label}".`);
    }
    if (siblings.some((s) => s.factorToBase === level.factorToBase)) {
      throw new ConflictException(
        `This product already has a unit of ${level.factorToBase} pieces.`,
      );
    }
  }

  /** A factor change checks the OLD label (its lines keep the old factor); any factor or label
   *  change checks the NEW pair. A price/default/order-only edit never queries the lines. */
  private async assertImmutableIfUsed(
    tx: any,
    productId: string,
    row: LevelKey,
    next: LevelKey,
  ): Promise<void> {
    const factorChanged = next.factorToBase !== row.factorToBase;
    const labelChanged = norm(next.label) !== norm(row.label);
    // Factor AND label both change: the OLD label's lines would no longer match this row.
    if (factorChanged && labelChanged) {
      await this.assertNoLineDisagrees(tx, productId, row.label, next.factorToBase);
    }
    if (factorChanged || labelChanged) {
      await this.assertNoLineDisagrees(tx, productId, next.label, next.factorToBase);
    }
  }

  /**
   * Factors are immutable once used: refuse when any order/invoice line for this product carries
   * `label` with a DIFFERENT factor than the one being written. Catches a factor edit, a rename
   * onto a used label, and delete-then-recreate with a new factor.
   */
  private async assertNoLineDisagrees(
    db: any,
    productId: string,
    label: string,
    factorToBase: number,
  ): Promise<void> {
    // Through the PARENT (order/invoice) relation, never `orderItem`/`invoiceItem` top-level: a
    // top-level read is scoped by the ITEM's nullable tenantId and would miss a NULL-tenant line.
    const lineWhere = {
      productId,
      unitLabel: { equals: label, mode: "insensitive" as const },
      // Explicit OR: SQL `NOT (col = n)` drops NULL rows, and a line with no snapshot factor is
      // exactly the one we must not let slip past.
      OR: [{ unitsPerBox: null }, { unitsPerBox: { not: factorToBase } }],
    };
    const [order, invoice] = await Promise.all([
      db.order.findFirst({ where: { lineItems: { some: lineWhere } }, select: { id: true } }),
      db.invoice.findFirst({ where: { items: { some: lineWhere } }, select: { id: true } }),
    ]);
    if (order || invoice) {
      throw new ConflictException({
        code: API_ERROR_CODES.UNIT_SIZE_IN_USE,
        message: `"${label}" is already used on an order or invoice at a different size, so its size cannot change. Create a new unit instead.`,
        level: label,
      });
    }
  }
}
