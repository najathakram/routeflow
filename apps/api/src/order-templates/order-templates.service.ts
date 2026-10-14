import {
  Optional,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { UserRole } from "@prisma/client";
import { LeaderCron } from "../common/cron-lock";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { OrdersService } from "../orders/orders.service";
import { resolveFulfilPath } from "../orders/fulfil-path-resolver";
import { syncOrderLineCompositions } from "../orders/order-composition";
import { orderTotalsOf } from "../orders/order-totals";
import { FeatureConfigService } from "../billing/feature-config.service";
import { isMergeContention } from "../orders/merge-contention";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { restrictionChannelForPrincipal } from "../selling-restrictions/selling-restrictions.core";
import { requireRestrictionTenantId } from "../selling-restrictions/restriction-tenant";
import { CreateOrderTemplateDto } from "./dto/create-order-template.dto";
import { UpdateOrderTemplateDto } from "./dto/update-order-template.dto";
import { AddTemplateItemDto } from "./dto/add-template-item.dto";
import {
  categoryTaxSnapshotOf,
  computeCategoryTax,
  computeLineSubtotal,
  roundMoney,
} from "@routeflow/pricing";
import type { CategoryTaxType } from "@routeflow/pricing";
import type { BuyerReorderSkippedLine } from "@routeflow/types";
import { taxRateFractionFrom } from "../common/tax-rate";
import { decrementStockForSale } from "../orders/order-stock";
import { resolveOversellAllowed } from "../orders/oversell-policy";
import { PolicyOversellReader } from "../orders/policy-oversell-reader";
import { assertSellableLines } from "../products/sellable-lines";
import { RegulatedVisibilityService } from "../buyer/regulated-visibility.service";
import { assertBuyerMayListProducts } from "./buyer-template-products";
import { assertBuyerMayListRegulated } from "./buyer-template-regulated";
import {
  BUYER_TEMPLATE_PRODUCT_SELECT,
  buyerTemplateReadContext,
  toBuyerView,
} from "./buyer-template-view";
import { assertPositiveTemplateQty } from "./template-qty";
import { assertMoneyInvariantsOrThrow } from "../common/money-invariants.util";
import { isoWeekdayUtc, startOfUtcDay } from "../common/utc-day";
import {
  GENERATED_ORDER_INCLUDE,
  findReplayOrder,
  lockTemplateThenFindReplay,
  replayCutoff,
} from "./generate-replay";

/** F-05 (SA-247): the LEAST privileged author of a template — STAFF only when creator AND last items-editor are staff. */
function leastPrivilegedAuthor(t: {
  createdByRole?: string | null;
  itemsEditedByRole?: string | null;
}) {
  const staff = (role?: string | null) =>
    restrictionChannelForPrincipal({ role: role ?? null }) === "STAFF";
  return staff(t.createdByRole) && staff(t.itemsEditedByRole)
    ? { role: t.createdByRole }
    : { type: "BUYER" };
}

/**
 * A template of LEGACY provenance: a creator or last items-editor role that was never recorded, with every recorded
 * role staff. It predates provenance and was staff-built, so a portal limit (a request to hide a product from the
 * portal) must not suspend its lines; a legal ban (surface ALL) still binds it, judged at the stricter channel.
 */
function isLegacyStaffBuilt(t: {
  createdByRole?: string | null;
  itemsEditedByRole?: string | null;
}) {
  const roles = [t.createdByRole, t.itemsEditedByRole];
  const known = roles.filter((r): r is string => !!r);
  const staff = (role: string) => restrictionChannelForPrincipal({ role }) === "STAFF";
  return known.length < roles.length && known.every(staff);
}

@Injectable()
export class OrderTemplatesService {
  private readonly logger = new Logger(OrderTemplatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
    private readonly ordersService: OrdersService,
    private readonly authGuard: AuthorizationGuardService,
    private readonly notifications: NotificationsService,
    private readonly systemConfig: SystemConfigService,
    private readonly sellingRestrictions: SellingRestrictionsService,
    // WS9: the backorder policy reader behind resolveOversellAllowed (once per generated order, before
    // the transaction). Required (never @Optional): a missing provider is a DI error (L-247).
    private readonly oversellReader: PolicyOversellReader,
    // The catalog's regulated-category gate, applied to a buyer's template reads and writes (row 479). Required.
    private readonly regulated: RegulatedVisibilityService,
    // #2717 M3: the `mixed_packs` mode read; absent = off (no composition work).
    @Optional() private readonly featureConfig?: FeatureConfigService,
  ) {}

  // ─── CRUD ────────────────────────────────────────────────────────────────────

  async findAll(customerId?: string) {
    return this.prisma.forTenant().orderTemplate.findMany({
      where: { ...(customerId ? { customerId } : {}) },
      include: {
        items: {
          include: { product: { select: { id: true, name: true, unit: true } } },
        },
        customer: { select: { id: true, businessName: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * The BUYER's own templates (portal list, standing orders). Staff keep `findAll`. Every line is judged by the ONE
   * catalog rule (`isBuyerVisibleProduct` over this buyer's `buyerVisibilityFor` context, exactly as
   * `BuyerCatalogService.getProductDetail`), and a line whose product the catalog would 404 is DROPPED from the
   * response, so neither its name nor any other product detail leaves the server. The template row itself stays.
   */
  async findAllForBuyer(customerId: string) {
    const templates = await this.prisma.forTenant().orderTemplate.findMany({
      where: { customerId },
      include: {
        items: { include: { product: { select: BUYER_TEMPLATE_PRODUCT_SELECT } } },
        customer: { select: { id: true, businessName: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    const ctx = await this.buyerReadContext(customerId);
    const data = templates.map((t) => toBuyerView(t, ctx));
    return { data, meta: { total: data.length } };
  }

  async findAllForUser(user: JwtPayload, customerId?: string) {
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer) return { data: [], meta: { total: 0 } };
      return this.findAllForBuyer(customer.id);
    }
    const data = await this.findAll(customerId);
    return { data, meta: { total: data.length } };
  }

  async findOne(id: string) {
    const template = await this.prisma.forTenant().orderTemplate.findUnique({
      where: { id },
      include: {
        items: {
          include: { product: { select: { id: true, name: true, unit: true } } },
        },
        customer: { select: { id: true, businessName: true } },
      },
    });
    if (!template) throw new NotFoundException("Order template not found");
    return template;
  }

  /**
   * 404 for a missing template, 403 for a CUSTOMER who does not own it; returns the staff-shaped row. The mutation and
   * generate paths use this (they read ids, qty and ownership, never a name for a response); the READ endpoint is
   * `findOneForUser`, which adds the buyer filter.
   */
  private async assertTemplateAccess(id: string, user: JwtPayload) {
    const template = await this.findOne(id);
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || template.customerId !== customer.id) throw new ForbiddenException();
    }
    return template;
  }

  async findOneForUser(id: string, user: JwtPayload) {
    const owned = await this.assertTemplateAccess(id, user);
    if (user.role !== "CUSTOMER") return owned;
    // A buyer's read: re-load with the visibility facts, judge each line by the catalog rule, drop the hidden ones.
    const template = await this.prisma.forTenant().orderTemplate.findUnique({
      where: { id },
      include: {
        items: { include: { product: { select: BUYER_TEMPLATE_PRODUCT_SELECT } } },
        customer: { select: { id: true, businessName: true } },
      },
    });
    if (!template) throw new NotFoundException("Order template not found");
    return toBuyerView(template, await this.buyerReadContext(owned.customerId));
  }

  /** The catalog rules a buyer's request is judged by: the portal context and the locked regulated categories. */
  private buyerReadContext(customerId: string) {
    return buyerTemplateReadContext(
      { restrictions: this.sellingRestrictions, regulated: this.regulated },
      this.prisma.getTenantId(),
      customerId,
    );
  }

  /** The buyer write gate: the same 404 for a hidden, regulated-locked, or missing product; nothing is stored first. */
  private async assertBuyerMayList(customerId: string, productIds: readonly string[]) {
    await assertBuyerMayListProducts(
      { prisma: this.prisma, restrictions: this.sellingRestrictions },
      customerId,
      productIds,
    );
    await assertBuyerMayListRegulated(
      { prisma: this.prisma, regulated: this.regulated },
      customerId,
      productIds,
    );
  }

  async createForUser(dto: CreateOrderTemplateDto, user: JwtPayload) {
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer) throw new ForbiddenException();
      dto.customerId = customer.id;
      await this.assertBuyerMayList(
        customer.id,
        (dto.items ?? []).map((i) => i.productId),
      );
      const created = await this.create(dto, { role: user.role, userId: user.sub });
      return this.findOneForUser(created.id, user); // the buyer-filtered read (row 479)
    }
    return this.create(dto, { role: user.role, userId: user.sub });
  }

  async updateForUser(id: string, dto: UpdateOrderTemplateDto, user: JwtPayload) {
    if (user.role === "CUSTOMER") {
      const template = await this.findOne(id);
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || template.customerId !== customer.id) throw new ForbiddenException();
      if (dto.items)
        await this.assertBuyerMayList(
          customer.id,
          dto.items.map((i) => i.productId),
        );
    }
    const updated = await this.update(id, dto, { role: user.role, userId: user.sub });
    // A buyer's answer is the buyer-filtered read, never the staff-shaped write result (row 479).
    return user.role === "CUSTOMER" ? this.findOneForUser(id, user) : updated;
  }

  async removeForUser(id: string, user: JwtPayload) {
    if (user.role === "CUSTOMER") {
      const template = await this.findOne(id);
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || template.customerId !== customer.id) throw new ForbiddenException();
    }
    return this.remove(id);
  }

  async create(dto: CreateOrderTemplateDto, creator?: { role: string; userId: string } | null) {
    if (!dto.customerId) throw new BadRequestException("customerId is required");
    assertPositiveTemplateQty(dto.items); // before any read or write
    // REG-B131: a removed (soft-deleted) customer is not a standing-order target either — the cron
    // already skips their templates, so creating one would only schedule a silent no-op. Refuse
    // through the existing not-found branch so no customer state leaks.
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: dto.customerId, deletedAt: null } });
    if (!customer) throw new BadRequestException("Customer not found");

    const productIds = dto.items.map((i) => i.productId);
    const products = await this.prisma
      .forTenant()
      .product.findMany({ where: { id: { in: productIds } } });
    if (products.length !== productIds.length) {
      throw new BadRequestException("One or more products not found");
    }
    assertSellableLines(products); // WS8: a standing order never lists a FAMILY

    return this.prisma.forTenant().orderTemplate.create({
      data: {
        customerId: dto.customerId,
        name: dto.name,
        daysOfWeek: dto.daysOfWeek,
        notes: dto.notes,
        // F-05 (SA-210): provenance snapshot; the unattended run's sell channel derives from it, NULL = buyer.
        createdByRole: (creator?.role as UserRole | undefined) ?? null,
        createdByUserId: creator?.userId ?? null,
        itemsEditedByRole: (creator?.role as UserRole | undefined) ?? null,
        items: {
          create: dto.items.map((item) => ({
            productId: item.productId,
            qty: item.qty,
            notes: item.notes,
            tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
          })),
        },
      },
      include: {
        items: {
          include: { product: { select: { id: true, name: true, unit: true } } },
        },
        customer: { select: { id: true, businessName: true } },
      },
    });
  }

  async update(
    id: string,
    dto: UpdateOrderTemplateDto,
    editor?: { role: string; userId: string } | null,
  ) {
    assertPositiveTemplateQty(dto.items); // before any read or write
    await this.findOne(id);
    const include = {
      items: { include: { product: { select: { id: true, name: true, unit: true } } } },
      customer: { select: { id: true, businessName: true } },
    };
    const scalar = {
      // F-05 (SA-247): every write of the ITEMS records its author's role; no known editor = unknown (NULL).
      ...(dto.items ? { itemsEditedByRole: (editor?.role as UserRole | undefined) ?? null } : {}),
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.daysOfWeek !== undefined ? { daysOfWeek: dto.daysOfWeek } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    };
    // `items: null` clears @IsOptional() at the pipe (class-validator skips every
    // validator for null), so it arrives here typed as an array but isn't one —
    // treat it as absent instead of mapping over it, exactly as the sibling guard in
    // recurring-invoices.service.update() does. `items: []` is still a 400 (ArrayMinSize).
    if (!dto.items) {
      return this.prisma.forTenant().orderTemplate.update({ where: { id }, data: scalar, include });
    }
    // REG-B09: an edit that carries `items` REPLACES the template's items — the web modal
    // sends the full list it displays, so what the operator sees is what saves. Every
    // productId must exist in this tenant (mirrors create()) BEFORE any write, and the
    // delete + re-create run in ONE transaction so a failure can never leave a template
    // with no items.
    const items = dto.items;
    const productIds = [...new Set(items.map((i) => i.productId))];
    const products = await this.prisma.forTenant().product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, kind: true },
    });
    if (products.length !== productIds.length) {
      throw new BadRequestException("One or more products not found");
    }
    assertSellableLines(products); // WS8
    const tenantId = this.prisma.getTenantId();
    // F-05: a suspension survives an edit of the template unless THAT line's product or qty changed
    // (a notes edit, or an edit of another line, must not launder a banned line back into the order).
    const suspended: {
      productId: string;
      qty: number;
      suspendedAt: Date | null;
      suspendedReason: string | null;
    }[] = await this.prisma.forTenant().orderTemplateItem.findMany({
      where: { templateId: id, suspendedAt: { not: null } },
      select: { productId: true, qty: true, suspendedAt: true, suspendedReason: true },
    });
    const carried = new Map(suspended.map((r) => [`${r.productId}:${r.qty}`, r]));
    const lifted = suspended.filter(
      (r) => !items.some((i) => i.productId === r.productId && i.qty === r.qty),
    );
    return this.prisma.tenantTransaction(async (tx) => {
      await tx.orderTemplateItem.deleteMany({ where: { templateId: id } });
      // the lift and its audit row commit together (AuditService swallows errors: no silent lift)
      for (const r of lifted)
        await this.auditInTx(
          tx,
          "order-template.line-suspension-lifted",
          id,
          editor?.userId ?? null,
          {
            how: "EDITED",
            productId: r.productId,
          },
        );
      return tx.orderTemplate.update({
        where: { id },
        data: {
          ...scalar,
          items: {
            create: items.map((item) => {
              const keep = carried.get(`${item.productId}:${item.qty}`);
              return {
                productId: item.productId,
                qty: item.qty,
                notes: item.notes,
                ...(keep
                  ? { suspendedAt: keep.suspendedAt, suspendedReason: keep.suspendedReason }
                  : {}),
                tenantId, // nested creates bypass forTenant() extension
              };
            }),
          },
        },
        include,
      });
    });
  }

  /** F-05: the audited way to put a suspended line back without changing it (the operator decides). */
  async liftItemSuspension(templateId: string, itemId: string, user: JwtPayload) {
    await this.findOne(templateId);
    const item = await this.prisma
      .forTenant()
      .orderTemplateItem.findFirst({ where: { id: itemId, templateId } });
    if (!item) throw new NotFoundException("Template item not found");
    if (!item.suspendedAt) throw new BadRequestException("This line is not suspended");
    await this.prisma.tenantTransaction(async (tx) => {
      await tx.orderTemplateItem.update({
        where: { id: itemId },
        data: { suspendedAt: null, suspendedReason: null },
      });
      await this.auditInTx(tx, "order-template.line-suspension-lifted", templateId, user.sub, {
        how: "LIFTED",
        productId: item.productId,
      });
    });
    return { success: true };
  }

  /** F-05: an audit row written in the SAME transaction as the change it records (AuditService swallows errors). */
  private async auditInTx(
    tx: any,
    action: string,
    entityId: string,
    userId: string | null,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId: this.prisma.getTenantId(),
        userId,
        action,
        entityType: "order-templates",
        entityId,
        meta: meta as any,
      },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.forTenant().orderTemplate.delete({ where: { id } });
    return { success: true };
  }

  // ─── Item management ─────────────────────────────────────────────────────────

  async addItem(templateId: string, dto: AddTemplateItemDto, editor?: { role: string } | null) {
    assertPositiveTemplateQty([dto]); // before any read or write
    await this.findOne(templateId);
    const product = await this.prisma
      .forTenant()
      .product.findUnique({ where: { id: dto.productId } });
    if (!product) throw new BadRequestException("Product not found");
    assertSellableLines([product]); // WS8

    await this.markItemsEdited(templateId, editor);
    return this.prisma.forTenant().orderTemplateItem.create({
      data: { templateId, productId: dto.productId, qty: dto.qty, notes: dto.notes },
      include: { product: { select: { id: true, name: true, unit: true } } },
    });
  }

  /** F-05 (SA-247): the role of whoever last wrote the items; no editor = unknown (NULL) = the stricter channel. */
  private async markItemsEdited(templateId: string, editor?: { role: string } | null) {
    await this.prisma.forTenant().orderTemplate.update({
      where: { id: templateId },
      data: { itemsEditedByRole: (editor?.role as UserRole | undefined) ?? null },
    });
  }

  async removeItem(templateId: string, itemId: string, editor?: { role: string } | null) {
    const item = await this.prisma.forTenant().orderTemplateItem.findFirst({
      where: { id: itemId, templateId },
    });
    if (!item) throw new NotFoundException("Template item not found");
    await this.markItemsEdited(templateId, editor);
    await this.prisma.forTenant().orderTemplateItem.delete({ where: { id: itemId } });
    return { success: true };
  }

  // ─── Order generation ─────────────────────────────────────────────────────────

  // `isStaffRole` (default true: the cron and any other internal caller keep the warn-and-oversell
  // posture) picks the selling-restriction channel of a manual run. WS9: `allowOversell` is the
  // ALREADY-RESOLVED oversell boolean (resolveOversellAllowed ran in the caller, before this
  // transaction); the two are independent (a buyer backorder run is still a BUYER_PORTAL run), and an
  // absent value falls back to `isStaffRole`, today's value.
  // B1054: a repeat within GENERATE_NOW_REPLAY_WINDOW_MS is answered with the order the first run
  // placed. Accepted limit: if that order lost a pending-order merge in the window, the retry places
  // a new one (see generate-replay.ts); the merge is not touched to carry a marker.
  async generateOrder(
    templateId: string,
    isStaffRole = true,
    allowOversell?: boolean,
    /** Out-param: a buyer's Reorder fills `skipped` with the lines a selling restriction left out. */
    outcome?: { skipped: BuyerReorderSkippedLine[] },
  ) {
    // Only a caller that asked for `skipped` (the buyer's Reorder) has restricted lines left out; every other
    // manual run keeps the 409 so nothing is dropped without the caller being told.
    const replaySince = replayCutoff(new Date()); // B1054: measured from the START of this request
    const template = await this.prisma.forTenant().orderTemplate.findUnique({
      where: { id: templateId },
      include: { items: true },
    });
    if (!template) throw new NotFoundException("Order template not found");
    if (!template.isActive) throw new BadRequestException("Template is not active");
    // B1054: a repeat press (double click, retried request) answers with the order the first one
    // placed, before any side effect. The locked re-check inside the order transaction closes the
    // concurrent case this unlocked read cannot.
    const replay = await findReplayOrder(this.prisma.forTenant(), template.id, replaySince);
    if (replay) return replay;
    const runCtx: { ban: null; restricted?: BuyerReorderSkippedLine[] } = {
      ban: null,
      ...(outcome ? { restricted: [] } : {}),
    };
    const order = await this.createOrderFromTemplate(
      template,
      isStaffRole,
      false,
      runCtx,
      allowOversell,
      replaySince,
    );
    if (outcome && runCtx.restricted) outcome.skipped = runCtx.restricted;
    // Null = every line was a license-gated category the customer isn't verified
    // for, so nothing was ordered. Surface it (the cron path tolerates null; a
    // manual reorder should tell the caller why the order is empty).
    if (!order) {
      throw new BadRequestException(
        "Every item in this standing order needs a license this customer isn't verified for — nothing was ordered.",
      );
    }
    return order;
  }

  // ─── SECURITY (F2-003): ownership-enforced wrappers ──────────────────────────
  // The customer-reachable item-removal and order-generation endpoints previously
  // had no role guard and no ownership check, letting any CUSTOMER edit/generate
  // from ANOTHER customer's template. assertTemplateAccess() throws for a non-owner.

  // B133: every mutation on the controller goes through an ownership wrapper. For
  // OPERATOR this is a pass-through today (the ownership branch is CUSTOMER-only);
  // its value is uniformity — a future CUSTOMER grant on addItem cannot ship unguarded.
  async addItemForUser(templateId: string, dto: AddTemplateItemDto, user: JwtPayload) {
    const template = await this.assertTemplateAccess(templateId, user);
    if (user.role === "CUSTOMER")
      await this.assertBuyerMayList(template.customerId, [dto.productId]);
    return this.addItem(templateId, dto, { role: user.role });
  }

  async removeItemForUser(templateId: string, itemId: string, user: JwtPayload) {
    await this.assertTemplateAccess(templateId, user);
    return this.removeItem(templateId, itemId, { role: user.role });
  }

  async generateOrderForUser(templateId: string, user: JwtPayload) {
    const template = await this.assertTemplateAccess(templateId, user);
    // #1208 review LOW-MED: POST :id/generate is open to CUSTOMER (controller); a buyer's own
    // "Reorder" must not oversell where their own checkout would 409. WS9: the policy is resolved
    // ONCE here, before the run's transaction (source "buyer" for a CUSTOMER, "staff_entry" else).
    const isStaffRole = user.role === UserRole.OPERATOR || user.role === UserRole.TENANT_ADMIN;
    const allowOversell = await resolveOversellAllowed(this.oversellReader, {
      tenantId: (user.tenantId ?? this.prisma.getTenantId()) as string,
      role: user.role,
      source: user.role === UserRole.CUSTOMER ? "buyer" : "staff_entry",
      customerId: template.customerId,
    });
    return this.generateOrder(templateId, isStaffRole, allowOversell);
  }

  @LeaderCron("0 6 * * *", "order-templates.generateDailyOrders")
  async generateDailyOrders() {
    const today = new Date();
    // ISO weekday: 1=Mon, 7=Sun
    const dayOfWeek = isoWeekdayUtc(today);

    this.logger.log(`Running daily order generation for day ${dayOfWeek}`);

    // RF-008: cron has no HTTP request context so ALS is empty. Fetch all
    // active tenants and run each in its own ALS scope so forTenant() works.
    const activeTenants = await this.prisma.tenant.findMany({
      where: { status: "ACTIVE" },
      select: { id: true },
    });

    let totalCreated = 0;
    let totalSkipped = 0;
    let totalSuppressed = 0;

    for (const tenant of activeTenants) {
      await this.tenantCtx.run(tenant.id, async () => {
        const templates = await this.prisma.forTenant().orderTemplate.findMany({
          // REG-B131: a removed (soft-deleted) customer's standing orders stop firing. Stateless on
          // purpose: restoreCustomer() clears deletedAt and the template resumes with no other write.
          where: { isActive: true, daysOfWeek: { has: dayOfWeek }, customer: { deletedAt: null } },
          include: { items: true },
        });

        // REG-B131: a template the filter above dropped enters neither counter, so a tenant whose only
        // due template belongs to a removed customer would log "0 created, 0 skipped" — identical to a
        // day with no templates at all. Count the suppressed set once per tenant per tick (cron path).
        const suppressed =
          (await this.prisma.forTenant().orderTemplate.count({
            where: {
              isActive: true,
              daysOfWeek: { has: dayOfWeek },
              customer: { deletedAt: { not: null } },
            },
          })) ?? 0;
        if (suppressed > 0) {
          totalSuppressed += suppressed;
          this.logger.warn(
            `[tenant:${tenant.id}] REG-B131: ${suppressed} standing-order template(s) suppressed — customer removed`,
          );
        }

        for (const template of templates) {
          // Idempotency: skip if ANY order (even a since-CANCELLED one) was already generated today for
          // this template. Cron-only rule: an order the operator cancelled is not placed again at 06:00.
          // Manual "Generate now" is different on purpose (findReplayOrder ignores cancelled orders).
          const existing = await this.prisma.forTenant().order.findFirst({
            where: {
              templateId: template.id,
              createdAt: { gte: startOfUtcDay(today) },
            },
          });
          if (existing) {
            totalSkipped++;
            continue;
          }

          // F-05: the ban notice is sent AFTER the attempt, whatever its outcome (the suspension already
          // committed, so a throw past it must not lose the one notice for good).
          const ctx: {
            ban: { count: number; names: string } | null;
            placed?: boolean;
            replayed?: boolean;
          } = { ban: null };
          try {
            // Unattended cron run — same warn-and-oversell posture as an operator.
            // B1054: the unlocked check above cannot see a manual "Generate now" that is still in
            // flight, so the run also passes the start of today (UTC) as `replaySince`: the order
            // transaction then takes the template's row lock first and re-reads, exactly like the
            // manual path, and a twin that committed meanwhile is answered instead of doubled.
            const order = await this.createOrderFromTemplate(
              template,
              true,
              true,
              ctx,
              undefined,
              startOfUtcDay(today),
            );
            // null = all lines were license-gated + skipped → nothing created.
            // ctx.replayed = a concurrent manual run placed today's order first → nothing created here.
            if (order && !ctx.replayed) totalCreated++;
            else totalSkipped++;
          } catch (err) {
            this.logger.error(
              `[tenant:${tenant.id}] Failed to generate order for template ${template.id} (${template.name})`,
              err instanceof Error ? err.stack : String(err),
            );
          } finally {
            // A replay means today's order exists (a manual run placed it; that path sends no ban
            // notice), so the customer is told it went ahead, not that it was held.
            if (ctx.ban)
              await this.notifyBanSkipped(
                template,
                ctx.ban,
                ctx.placed || ctx.replayed ? "ordered" : "held",
              );
          }
        }
      });
    }

    this.logger.log(
      `Daily order generation complete: ${totalCreated} created, ${totalSkipped} skipped, ${totalSuppressed} suppressed (customer removed) across ${activeTenants.length} tenant(s)`,
    );
  }

  private async createOrderFromTemplate(
    template: {
      id: string;
      customerId: string;
      name: string;
      isActive?: boolean;
      createdByRole?: string | null;
      itemsEditedByRole?: string | null;
      items: Array<{
        id?: string;
        productId: string;
        qty: number;
        notes?: string | null;
        suspendedAt?: Date | null;
      }>;
    },
    isStaffRole: boolean,
    unattended = false,
    /** Unattended runs: filled with the ban note, so the CALLER can notify after the attempt (finally). */
    ctx?: {
      ban: { count: number; names: string } | null;
      placed?: boolean;
      replayed?: boolean;
      /** A buyer's manual run: the lines left out because a selling restriction hides them from this buyer. */
      restricted?: BuyerReorderSkippedLine[];
    },
    /** WS9: the caller's resolved boolean for a manual run (default = isStaffRole, today's value). */
    allowOversellArg?: boolean,
    /** B1054: an order this template placed at/after it is returned instead of a second one (manual: now - 30 s; cron: UTC day start). */
    replaySince?: Date,
  ) {
    assertPositiveTemplateQty(template.items); // a stored or bypassed quantity never reaches an order or stock
    // F-05: a banned product refuses a manual run (409 — the operator decides). The unattended cron run
    // instead SKIPS the banned line(s), still orders the rest, notifies once and marks each banned template
    // line suspended until it is edited or lifted; only an all-banned template orders nothing (and is then
    // deactivated, so the cron does not notify again). A suspended line is never ordered, by either path.
    // Channel: the run is judged at the LEAST privileged of the template's creator and last items-editor
    // (SA-247): STAFF only when both are known staff, so a buyer's edit of an operator's template, or an
    // unknown author, is BUYER_PORTAL; a manual run is the caller's own role.
    const channel = restrictionChannelForPrincipal(
      unattended
        ? leastPrivilegedAuthor(template)
        : { role: isStaffRole ? UserRole.OPERATOR : UserRole.CUSTOMER },
    );
    const restrictionTenantId = requireRestrictionTenantId(this.prisma.getTenantId());
    const customerId = template.customerId;
    let live = template.items.filter((i) => !i.suspendedAt);
    let banNote: { count: number; names: string } | null = null;
    if (!unattended) {
      if (live.length === 0)
        throw new BadRequestException(
          "Every line on this standing order is suspended — lift a line or edit the template.",
        );
      if (channel === "BUYER_PORTAL" && ctx?.restricted) {
        // A buyer's Reorder leaves restricted lines out (they are hidden from this buyer everywhere else) and
        // orders the rest; `skipped` tells the portal. The 409 below stays the authority for a race (a rule
        // created since) and for every line left in.
        const verdict = await this.sellingRestrictions.checkLinesSellable({
          tenantId: restrictionTenantId,
          customerId,
          lines: live.map((i) => ({ productId: i.productId })),
          channel,
        });
        if (verdict.outcome === "BLOCK" || verdict.outcome === "INDETERMINATE") {
          const nameOf = new Map(verdict.reasons.map((r) => [r.productId, r.productName]));
          const left = live.filter((i) => nameOf.has(i.productId));
          live = live.filter((i) => !nameOf.has(i.productId));
          ctx.restricted = left.map((i) => ({
            productId: i.productId,
            name: nameOf.get(i.productId) ?? "",
          }));
          if (live.length === 0)
            throw new BadRequestException("None of these items are available to you right now.");
        }
      }
      await this.sellingRestrictions.assertLinesSellable({
        tenantId: restrictionTenantId,
        customerId,
        lines: live.map((i) => ({ productId: i.productId })),
        channel,
      });
    } else {
      const verdict = await this.sellingRestrictions.checkLinesSellable({
        tenantId: restrictionTenantId,
        customerId,
        lines: live.map((i) => ({ productId: i.productId })),
        channel,
        // A staff-built legacy template is not suspended by a portal limit; a legal ban still is.
        ...(isLegacyStaffBuilt(template) ? { skipPortalOnlyRules: true } : {}),
      });
      const banned = new Set(
        verdict.outcome === "BLOCK" || verdict.outcome === "INDETERMINATE"
          ? verdict.reasons.map((r) => r.productId)
          : [],
      );
      if (banned.size > 0) {
        await this.suspendBannedLines(template, banned, verdict.reasons);
        banNote = {
          count: banned.size,
          names: [...new Set(verdict.reasons.map((r) => r.productName).filter(Boolean))].join(", "),
        };
        if (ctx) ctx.ban = banNote;
      }
      template = { ...template, items: live.filter((i) => !banned.has(i.productId)) };
      if (template.items.length === 0) {
        // nothing left to order: deactivate (once — the cron no longer selects it) and say so once
        await this.deactivateForRestriction(template);
        await this.notifyBanSkipped(template, banNote, "deactivated");
        if (ctx) ctx.ban = null; // already told: the caller must not notify again
        return null;
      }
    }
    if (!unattended) template = { ...template, items: live };
    const productIds = template.items.map((i) => i.productId);
    const products = await this.prisma.forTenant().product.findMany({
      where: { id: { in: productIds } },
    });
    assertSellableLines(products); // WS8: a FAMILY line would become a SALE StockMovement
    const productMap = new Map(products.map((p) => [p.id, p]));

    // B1025: a DEACTIVATED (archived) product is never ordered — the interactive create path refuses it
    // ("Product X is archived"); this path never looked. Handled like the F-05 banned lines: the line is
    // SKIPPED and SUSPENDED (reason PRODUCT_INACTIVE, so `live` drops it on every later run and the notice
    // goes ONCE, at suspension, not on every run day), the rest is ordered, and the operator's lift-a-line
    // action puts it back after the product is reactivated. When nothing usable is left a manual run
    // refuses with a readable 400 (no change made); the unattended run suspends the lines, deactivates
    // the template once and notifies once (the deactivateForRestriction shape).
    const inactive = template.items.filter((i) => productMap.get(i.productId)?.isActive === false);
    const inactiveCount = inactive.length;
    // Told only AFTER the order commits (below): a run that then fails — a buyer oversell 409, or the
    // remaining lines being license-gated — must not announce an order that was never placed.
    let inactiveNotice: { count: number; names: string; productIds: string[] } | null = null;
    if (inactiveCount > 0) {
      const names = [
        ...new Set(inactive.map((i) => productMap.get(i.productId)?.name).filter(Boolean)),
      ].join(", ");
      template = {
        ...template,
        items: template.items.filter((i) => productMap.get(i.productId)?.isActive !== false),
      };
      // A manual run that has nothing left answers the caller directly; it needs no notice of its own.
      if (template.items.length === 0 && !unattended)
        throw new BadRequestException(
          "Every item on this standing order is no longer available — edit the template.",
        );
      const inactiveIds = [...new Set(inactive.map((i) => i.productId))];
      if (template.items.length === 0) {
        // unattended and nothing left to order: no order will follow, so suspend, deactivate the
        // template once (the cron no longer selects it) and tell both sides ONCE, now, in one notice
        // that says it was deactivated and covers any banned line suspended earlier in this same run.
        const suspended = await this.suspendInactiveLines(template, inactiveIds);
        if (suspended > 0) {
          await this.deactivateForRestriction(template, "NO_ACTIVE_PRODUCTS");
          await this.notifyDeactivatedNoOrderableLines(template, banNote, inactiveCount, names);
        }
        // already told (or a concurrent run owns the notice): the caller must not notify the ban again
        if (ctx) ctx.ban = null;
        return null;
      }
      inactiveNotice = { count: inactiveCount, names, productIds: inactiveIds };
    }

    // B658: the SAME regulated per-category levy the interactive create path computes
    // (orders.service.ts's own categoryMap) — a standing order never went through
    // OrdersService.create() at all, so categoryTaxAmount was hardcoded 0 below.
    const templateCatIds = [
      ...new Set(products.map((p) => p.trackedCategoryId).filter(Boolean)),
    ] as string[];
    const categoryMap = new Map<string, any>(
      (templateCatIds.length > 0
        ? await this.prisma.forTenant().trackedCategory.findMany({
            where: { id: { in: templateCatIds } },
          })
        : []
      ).map((c: any) => [c.id, c]),
    );

    // W6: regulated license guard. A standing order must never sell a
    // license-required line to a customer without a VERIFIED authorization (or an
    // active §8 override) — the same rule the interactive create/edit/promote hooks
    // enforce. Per spec §8, standing orders SKIP the blocked line(s) and notify both
    // sides (they don't hard-fail the whole run). Mirrors the create-hook check:
    // customerId + per-line trackedCategoryId, no delivery/order context here.
    const { blocked } = await this.authGuard.checkAuthorized({
      customerId: template.customerId,
      lines: template.items.map((i) => ({
        trackedCategoryId: productMap.get(i.productId)?.trackedCategoryId ?? null,
      })),
    });
    const blockedCategoryIds = new Set(blocked.map((b) => b.trackedCategoryId));
    const allowedItems = template.items.filter((i) => {
      const catId = productMap.get(i.productId)?.trackedCategoryId ?? null;
      return !catId || !blockedCategoryIds.has(catId);
    });
    const skippedCount = template.items.length - allowedItems.length;
    const unavailableNote =
      inactiveCount > 0 ? ` (${inactiveCount} item(s) skipped — no longer available)` : "";

    if (skippedCount > 0) {
      await this.notifySkippedRegulatedLines(template, blocked, skippedCount).catch(() => {});
    }
    // Every line was a license-gated category the customer isn't verified for —
    // there is nothing to order. Callers treat null as "skipped".
    if (allowedItems.length === 0) return null; // nothing is ordered

    // REG-B48: a standing order is the CUSTOMER's order whoever triggers it (06:00 cron,
    // operator "Generate now", buyer "Reorder"), so every line is priced exactly as the
    // buyer's own checkout in orders.service.create: per-product CustomerPrice tier >
    // customer default tier > list, then the best active CUSTOMER promotion (incl.
    // BUY_N_GET_M free units), with the remembered above-list price (sticky upsell)
    // honoured — all through the ONE shared resolver. Previously every line billed raw
    // product.pricePerUnit.
    const customerRecord = await this.prisma.forTenant().customer.findUnique({
      where: { id: template.customerId },
      select: { pricingTier: true, isTaxExempt: true },
    });
    const defaultTier = customerRecord?.pricingTier ?? 1;
    // RF-079 / RF-4: an exempt customer owes $0 of BOTH taxes on the standing order, as on its invoice.
    const isTaxExempt = customerRecord?.isTaxExempt === true;
    const customerPrices = await this.prisma.forTenant().customerPrice.findMany({
      where: { customerId: template.customerId, productId: { in: productIds } },
    });
    // An MSRP-only CustomerPrice row has pricingTier null — `??` below falls through it.
    const cpTier = new Map(customerPrices.map((cp) => [cp.productId, cp.pricingTier]));
    const activePromos = await this.ordersService.loadActivePromotions(UserRole.CUSTOMER);
    const priceHistory = await this.ordersService.getCustomerPriceHistory(template.customerId);

    const tenantId = this.prisma.getTenantId();
    let subtotal = 0;
    const lineItemsData = allowedItems.map((item) => {
      const product = productMap.get(item.productId);
      if (!product) throw new BadRequestException(`Product ${item.productId} not found`);
      const tierForProduct = cpTier.get(item.productId) ?? defaultTier;
      // A template qty is a SELLING-UNIT count (a box for boxed products) and is never
      // split into boxes/pieces here — the same "box-unaware boxed line" the interactive
      // path handles: unitPrice is the box price, qty bills as whole units, and the promo
      // context sees the true piece count so QTY_BREAK thresholds are measured in pieces.
      const upb = Number(product.unitsPerBox ?? 0);
      const qtyUnits = item.qty;
      // B661-sweep: a line-tax (not ledger) box-unaware multiply — follow-up PR converts this to
      // @routeflow/pricing's regulatedUnitBasis; see no-second-legacy-line-pieces.spec.ts's allowlist.
      const qtyPieces = upb > 1 ? item.qty * upb : item.qty;
      const resolved = this.ordersService.resolveBuyerLinePrice(
        product,
        tierForProduct,
        activePromos,
        qtyPieces,
        qtyUnits,
        priceHistory[item.productId]?.lastPrice ?? null,
        { boxes: null, pieces: null, unitsPerBox: upb },
      );
      // BUY_N_GET_M subtracts whole free selling units BEFORE pricing (exact, never a
      // rounded net unit price); every other line reduces to unitPrice × qty, rounded.
      const itemSubtotal = computeLineSubtotal({
        unitPrice: resolved.unitPrice,
        qty: item.qty,
        freeUnits: resolved.freeUnits,
      });
      subtotal = roundMoney(subtotal + itemSubtotal);
      // B658: same formula orders.service.ts's create() folds per line — EXCISE/DEPOSIT/
      // PER_VOLUME levies are basis-qty (true pieces), PERCENT_OF_SALE uses the subtotal.
      const category = product.trackedCategoryId
        ? categoryMap.get(product.trackedCategoryId)
        : null;
      const categoryTaxAmount =
        category && !isTaxExempt
          ? computeCategoryTax({
              taxType: category.taxType as CategoryTaxType,
              rate: Number(category.rate),
              unitBasisQty: qtyPieces,
              lineSubtotal: itemSubtotal,
              priceIncludesTax: category.priceIncludesTax,
            })
          : 0;
      // B297 (SA-088): freeze the trio categoryTaxAmount above was computed from.
      const categorySnapshot = categoryTaxSnapshotOf(
        category
          ? {
              taxType: category.taxType as CategoryTaxType,
              rate: category.rate,
              priceIncludesTax: category.priceIncludesTax,
            }
          : null,
      );
      return {
        productId: item.productId,
        qty: item.qty,
        unitPrice: resolved.unitPrice,
        priceType: resolved.priceType,
        originalPrice: resolved.originalPrice,
        promoFreeUnits: resolved.freeUnits > 0 ? resolved.freeUnits : null,
        subtotal: itemSubtotal,
        notes: item.notes ?? undefined,
        // W4/W6b: snapshot the product's regulated category at sale time (unchanged).
        trackedCategoryId: product.trackedCategoryId ?? null,
        categoryTaxAmount,
        ...categorySnapshot,
        tenantId, // nested creates bypass forTenant() extension
      };
    });

    // RF-4: read the tenant's own tax setting per-request rather than a
    // constructor-cached env fallback — standing orders were previously taxed
    // at a flat 10% (env TAX_RATE ?? 0.1) regardless of what the tenant had
    // configured in Settings, same unit-mismatch bug as orders.service.
    const storedTaxRate = await this.systemConfig.get("settings.taxRate");
    const taxRate = taxRateFractionFrom(storedTaxRate);
    // B658: fold Σ per-line categoryTaxAmount into the total, same as orders.service.ts's
    // create() — the `tax` column stays REGULAR tax only, category tax is reconstructable
    // from the line snapshots.
    const {
      regularTax: tax,
      categoryTax,
      total,
    } = orderTotalsOf(lineItemsData, {
      taxRate,
      isTaxExempt,
    });

    // #1208 review LOW: guard the generated total the same way create() does
    // (orders.service.ts :2164-2170) — before the stock transaction opens, never after.
    assertMoneyInvariantsOrThrow({
      subtotal,
      tax: tax + categoryTax,
      total,
    });

    const orderNumber = `ORD-${Date.now()}`;
    const today = new Date();
    const skipNote =
      (skippedCount > 0
        ? ` (${skippedCount} regulated line(s) skipped — license not verified)`
        : "") + unavailableNote;

    // B647: a standing order is a real (non-draft) sale the moment it's placed — it must
    // decrement stock through the SAME locked, aggregated helper OrdersService.create()
    // uses (decrementStockForSale), inside the SAME transaction as the order write, never
    // a second implementation. Un-fixed, the order posted with zero stock references at
    // all, while a later cancel still credited stock back — inflating currentStock on
    // every cancelled standing order.
    // WS9: ONE resolve per generated order, BEFORE the transaction. The unattended 06:00 run is
    // source "template_cron" (true for every role, policy NOT read: today's behaviour, owner
    // question Q6 is open). A manual run arrives with its caller's already-resolved boolean.
    const allowOversell = unattended
      ? await resolveOversellAllowed(this.oversellReader, {
          tenantId: this.prisma.getTenantId() as string,
          role: undefined,
          source: "template_cron",
          customerId: template.customerId,
        })
      : (allowOversellArg ?? isStaffRole);
    let replayed = false;
    // Fulfil path (SA-678): the standing order takes the path order create would give it (the shared
    // resolver) for EVERY tenant, so a SHIP customer's standing order is SHIP and folds with their
    // other SHIP orders (the column default made it ROUTE).
    const storedPath = (
      await this.prisma.forTenant().customer.findFirst({
        where: { id: template.customerId },
        select: { fulfillPath: true },
      })
    )?.fulfillPath;
    const fulfillPath = await resolveFulfilPath(
      {
        featureConfig: this.featureConfig,
        tenantId: this.prisma.getTenantId(),
        logger: this.logger,
      },
      // role null: a system caller never gets POS mode (SA-763r M1).
      { stored: storedPath, audience: "staff", role: null },
    );
    const created = await this.prisma.tenantTransaction(async (tx) => {
      if (replaySince) {
        // B1054: first statement. A concurrent twin that committed while we waited is returned as is.
        const prior = await lockTemplateThenFindReplay(
          tx,
          template.id,
          restrictionTenantId,
          replaySince,
        );
        if (prior) {
          replayed = true;
          if (ctx) ctx.replayed = true;
          return prior;
        }
      }
      const order = await tx.order.create({
        data: {
          customerId: template.customerId,
          templateId: template.id,
          fulfillPath,
          orderNumber,
          subtotal,
          tax,
          total,
          notes: `Auto-generated from standing order: ${template.name}${skipNote}`,
          requestedDeliveryDate: today,
          // Denormalized flag — true when any (allowed) line is regulated.
          hasRegulated: lineItemsData.some((li) => li.trackedCategoryId != null),
          lineItems: { create: lineItemsData },
        },
        include: GENERATED_ORDER_INCLUDE,
      });
      await syncOrderLineCompositions(tx, order.id, this.prisma.getTenantId(), this.featureConfig);
      // SA-714 R1: each stock line is paired with its created row (product + qty, consumed once) so the
      // decrement can SET that row's backorder marker; `position` is the template's own line order.
      const unmatched = [...(Array.isArray(order.lineItems) ? order.lineItems : [])];
      const stockLines = lineItemsData.map((li, position) => {
        const at = unmatched.findIndex(
          (r) => r.productId === li.productId && Number(r.qty) === Number(li.qty),
        );
        const id = at >= 0 ? unmatched.splice(at, 1)[0].id : undefined;
        return { id, position, productId: li.productId, qty: li.qty };
      });
      // WS9: `allowOversell` is the resolved boolean (cron: template_cron = true; staff manual run
      // = true; a buyer's Reorder = their checkout's policy). Never a policy read in this section.
      await decrementStockForSale(
        { logger: this.logger, tenantId: this.prisma.getTenantId() },
        tx,
        stockLines,
        allowOversell,
        // B562 PR-2: the standing order's SALE rows; the cron run has no acting user.
        // OOS PR2 (R4): a buyer's Reorder is customer-facing: a refusal carries the fixed copy, no numbers.
        {
          orderId: order.id,
          notes: `TEMPLATE:${template.id}`,
          performedById: null,
          customerFacing: !unattended && !isStaffRole,
        },
      );
      return order;
    });

    if (replayed) return created; // B1054: nothing was placed by THIS call: no notice, no merge
    if (ctx) ctx.placed = true; // the order tx committed: whatever happens next, the order EXISTS
    if (inactiveNotice) {
      // Suspension and notice both follow the commit, so a run that fails never leaves a silent
      // suspension behind; a failure to suspend must not fail the placed order (it just re-skips next run).
      // Only the run that actually wrote the suspension audits and notifies: a manual Reorder racing the
      // 06:00 cron (both read the lines unsuspended) must not announce the same lines twice.
      const suspended = await this.suspendInactiveLines(template, inactiveNotice.productIds).catch(
        (err) => {
          this.logger.warn(
            `B1025: could not suspend inactive lines on template ${template.id}: ${String(err)}`,
          );
          return 0;
        },
      );
      if (suspended > 0)
        await this.notifySkippedInactiveLines(
          template,
          inactiveNotice.count,
          inactiveNotice.names,
        ).catch(() => {});
    }

    // If the customer already had PENDING orders, fold the newly-created one
    // (and any pre-existing duplicates) into a single winner. The newest order
    // wins on price/metadata per the merge rules.
    //
    // POST-COMMIT (see orders/merge-contention.ts): `created` is already in the
    // database. On the 06:00 cron a thrown 409 lands in generateDailyOrders' per-
    // template catch, which logs an ERROR and counts the day's standing order as
    // neither created nor skipped — for an order that WAS placed; on the manual
    // generateOrder path it becomes the caller's response, reporting a placed order
    // as a failure. Contention here is deferred: log it and return the
    // unconsolidated order; the hourly sweep folds it later.
    let merged: Awaited<ReturnType<OrdersService["mergeAllPendingForCustomer"]>> | null = null;
    try {
      merged = await this.ordersService.mergeAllPendingForCustomer(
        template.customerId,
        // focusOrderId: only the standing order's path folds, so `merged` is never another path's pair
        { focusOrderId: created.id },
        // POST-COMMIT: `try`, never `wait`. On the 06:00 cron this runs once per template in a
        // loop — waiting 20 s on each contended customer would stretch the run without changing
        // the outcome, since the hourly sweep folds whatever is left anyway.
        { lockMode: "try" },
      );
    } catch (e) {
      if (!isMergeContention(e)) throw e;
      this.logger.warn(
        `post-commit consolidation deferred (merge in progress) tenant=${tenantId} customer=${template.customerId}`,
      );
    }
    return merged ?? created;
  }

  /**
   * F-05: the ONE notice a banning run sends, worded after the filtering — what actually happened:
   * "ordered" (the rest went ahead), "held" (banned lines suspended but nothing was ordered, e.g. the rest is
   * license-gated: the template stays active), "deactivated" (nothing left to order, the template was switched off).
   * Never claims a deactivation that did not happen. Best-effort: a failure here never fails the run.
   */
  private async notifyBanSkipped(
    template: { customerId: string; name: string },
    note: { count: number; names: string } | null,
    mode: "ordered" | "held" | "deactivated",
  ): Promise<void> {
    const what = note?.names ? ` (${note.names})` : "";
    const n = note?.count ?? 0;
    const cust = {
      ordered: `"${template.name}" went ahead without ${n} item(s) that can't be sold right now${what}. Contact your supplier.`,
      held: `"${template.name}" was not sent this time: ${n} item(s) can't be sold right now${what} and the rest could not be ordered. Contact your supplier.`,
      deactivated: `"${template.name}" was not sent: nothing on it can be sold right now${what}. Contact your supplier.`,
    }[mode];
    const ops = {
      ordered: `"${template.name}": ${n} line(s) are under a selling restriction${what} and are suspended until the line is edited or lifted.`,
      held: `"${template.name}" produced no order: ${n} line(s) are under a selling restriction${what} and suspended, and the remaining lines could not be ordered (for example a license). The template is still active.`,
      deactivated: `"${template.name}" was not generated and is deactivated: every line is under a selling restriction or suspended${what}.`,
    }[mode];
    if (!note && mode !== "deactivated") return;
    try {
      await this.notifications
        .sendToCustomer(template.customerId, "Standing order", cust)
        .catch(() => {});
      await this.notifyOperators(ops);
    } catch {
      /* best-effort */
    }
  }

  /** F-05: mark each banned template line suspended, atomically with its audit row. */
  private async suspendBannedLines(
    template: { id: string },
    bannedProductIds: ReadonlySet<string>,
    reasons: Array<{ ruleId?: string | null }>,
  ): Promise<void> {
    await this.prisma.tenantTransaction(async (tx) => {
      await tx.orderTemplateItem.updateMany({
        where: { templateId: template.id, productId: { in: [...bannedProductIds] } },
        data: { suspendedAt: new Date(), suspendedReason: "SELLING_RESTRICTED" },
      });
      await this.auditInTx(tx, "order-template.line-suspended", template.id, null, {
        reason: "SELLING_RESTRICTED",
        productIds: [...bannedProductIds],
        ruleIds: [...new Set(reasons.map((r) => r.ruleId).filter(Boolean))],
      });
    });
  }

  /** B1025: mark each line whose product was deactivated suspended, atomically with its audit row. */
  private async suspendInactiveLines(
    template: { id: string },
    productIds: string[],
  ): Promise<number> {
    return this.prisma.tenantTransaction(async (tx) => {
      // `suspendedAt: null`: only a line nobody has suspended yet is written, audited or announced.
      const { count } = await tx.orderTemplateItem.updateMany({
        where: { templateId: template.id, productId: { in: productIds }, suspendedAt: null },
        data: { suspendedAt: new Date(), suspendedReason: "PRODUCT_INACTIVE" },
      });
      if (count > 0)
        await this.auditInTx(tx, "order-template.line-suspended", template.id, null, {
          reason: "PRODUCT_INACTIVE",
          productIds,
        });
      return count as number;
    });
  }

  /** F-05: a template with no orderable line is deactivated once, with its audit row in the same tx. */
  private async deactivateForRestriction(
    template: { id: string },
    reason: "NO_SELLABLE_LINES" | "NO_ACTIVE_PRODUCTS" = "NO_SELLABLE_LINES",
  ): Promise<void> {
    await this.prisma.tenantTransaction(async (tx) => {
      await tx.orderTemplate.update({ where: { id: template.id }, data: { isActive: false } });
      await this.auditInTx(tx, "order-template.deactivated", template.id, null, { reason });
    });
  }

  private async notifyOperators(body: string): Promise<void> {
    const operators = await this.prisma.user.findMany({
      where: {
        tenantId: this.prisma.getTenantId(),
        role: { in: ["OPERATOR", "TENANT_ADMIN"] },
        status: "ACTIVE",
      },
      select: { id: true },
    });
    for (const op of operators) {
      await this.notifications.sendToUser(op.id, { title: "Standing order", body }).catch(() => {});
    }
  }

  /** B1025: the notice a run sends when it left deactivated product lines out. Best-effort: never fails the run. */
  private async notifySkippedInactiveLines(
    template: { customerId: string; name: string },
    skippedCount: number,
    names: string,
  ): Promise<void> {
    const what = names ? ` (${names})` : "";
    await this.notifications
      .sendToCustomer(
        template.customerId,
        "Unavailable items skipped from your standing order",
        `${skippedCount} item(s)${what} on "${template.name}" are no longer available and were left out. Contact your supplier.`,
      )
      .catch(() => {});
    await this.notifyOperators(
      `Standing order "${template.name}" skipped ${skippedCount} deactivated product(s)${what}. Edit the template to remove or replace them.`,
    );
  }

  /**
   * B1025 / #3110 review: an unattended run ended with NO orderable line because the remaining products are
   * deactivated (possibly after banned lines were suspended in the same run). ONE notice, truthful about the
   * outcome: the standing order was DEACTIVATED, and "edit the template" does not bring it back.
   */
  private async notifyDeactivatedNoOrderableLines(
    template: { customerId: string; name: string },
    ban: { count: number; names: string } | null,
    inactiveCount: number,
    inactiveNames: string,
  ): Promise<void> {
    const parts = [
      ban && ban.count > 0 ? `${ban.count} under a selling restriction (${ban.names})` : "",
      inactiveCount > 0 ? `${inactiveCount} deactivated (${inactiveNames})` : "",
    ].filter(Boolean);
    const what = parts.join(" and ");
    try {
      await this.notifications
        .sendToCustomer(
          template.customerId,
          "Standing order not sent",
          `"${template.name}" was not sent: nothing on it can be sold right now. Contact your supplier.`,
        )
        .catch(() => {});
      await this.notifyOperators(
        `"${template.name}" was not generated and is deactivated: every line is unavailable (${what}). It will not run again until you reactivate it, after restoring the products and lifting the suspended lines.`,
      );
    } catch {
      /* best-effort */
    }
  }

  private async notifySkippedRegulatedLines(
    template: { customerId: string; name: string },
    blocked: Array<{ categoryName: string }>,
    skippedCount: number,
  ): Promise<void> {
    const categories = [...new Set(blocked.map((b) => b.categoryName))].join(", ");
    await this.notifications
      .sendToCustomer(
        template.customerId,
        "Regulated items skipped from your standing order",
        `${skippedCount} line(s) were skipped from "${template.name}" because a verified license is required (${categories}). Submit or renew your license to include them.`,
      )
      .catch(() => {});

    const tenantId = this.prisma.getTenantId();
    const operators = await this.prisma.user.findMany({
      where: { tenantId, role: { in: ["OPERATOR", "TENANT_ADMIN"] }, status: "ACTIVE" },
      select: { id: true },
    });
    const opBody = `Standing order "${template.name}" skipped ${skippedCount} unlicensed regulated line(s): ${categories}.`;
    for (const op of operators) {
      await this.notifications
        .sendToUser(op.id, { title: "Standing order skipped regulated items", body: opBody })
        .catch(() => {});
    }
  }
}
