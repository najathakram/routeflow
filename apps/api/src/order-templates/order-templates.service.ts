import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { OrdersService } from "../orders/orders.service";
import { isMergeContention } from "../orders/merge-contention";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { CreateOrderTemplateDto } from "./dto/create-order-template.dto";
import { UpdateOrderTemplateDto } from "./dto/update-order-template.dto";
import { AddTemplateItemDto } from "./dto/add-template-item.dto";
import { computeLineSubtotal, roundMoney } from "@routeflow/pricing";
import { taxRateFractionFrom } from "../common/tax-rate";

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
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

  async findAllForUser(user: JwtPayload, customerId?: string) {
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer) return { data: [], meta: { total: 0 } };
      const data = await this.findAll(customer.id);
      return { data, meta: { total: data.length } };
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

  async findOneForUser(id: string, user: JwtPayload) {
    const template = await this.findOne(id);
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || template.customerId !== customer.id) throw new ForbiddenException();
    }
    return template;
  }

  async createForUser(dto: CreateOrderTemplateDto, user: JwtPayload) {
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer) throw new ForbiddenException();
      dto.customerId = customer.id;
    }
    return this.create(dto);
  }

  async updateForUser(id: string, dto: UpdateOrderTemplateDto, user: JwtPayload) {
    if (user.role === "CUSTOMER") {
      const template = await this.findOne(id);
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || template.customerId !== customer.id) throw new ForbiddenException();
    }
    return this.update(id, dto);
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

  async create(dto: CreateOrderTemplateDto) {
    if (!dto.customerId) throw new BadRequestException("customerId is required");
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new BadRequestException("Customer not found");

    const productIds = dto.items.map((i) => i.productId);
    const products = await this.prisma
      .forTenant()
      .product.findMany({ where: { id: { in: productIds } } });
    if (products.length !== productIds.length) {
      throw new BadRequestException("One or more products not found");
    }

    return this.prisma.forTenant().orderTemplate.create({
      data: {
        customerId: dto.customerId,
        name: dto.name,
        daysOfWeek: dto.daysOfWeek,
        notes: dto.notes,
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

  async update(id: string, dto: UpdateOrderTemplateDto) {
    await this.findOne(id);
    return this.prisma.forTenant().orderTemplate.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.daysOfWeek !== undefined ? { daysOfWeek: dto.daysOfWeek } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
      include: {
        items: {
          include: { product: { select: { id: true, name: true, unit: true } } },
        },
        customer: { select: { id: true, businessName: true } },
      },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.forTenant().orderTemplate.delete({ where: { id } });
    return { success: true };
  }

  // ─── Item management ─────────────────────────────────────────────────────────

  async addItem(templateId: string, dto: AddTemplateItemDto) {
    await this.findOne(templateId);
    const product = await this.prisma
      .forTenant()
      .product.findUnique({ where: { id: dto.productId } });
    if (!product) throw new BadRequestException("Product not found");

    return this.prisma.forTenant().orderTemplateItem.create({
      data: { templateId, productId: dto.productId, qty: dto.qty, notes: dto.notes },
      include: { product: { select: { id: true, name: true, unit: true } } },
    });
  }

  async removeItem(templateId: string, itemId: string) {
    const item = await this.prisma.forTenant().orderTemplateItem.findFirst({
      where: { id: itemId, templateId },
    });
    if (!item) throw new NotFoundException("Template item not found");
    await this.prisma.forTenant().orderTemplateItem.delete({ where: { id: itemId } });
    return { success: true };
  }

  // ─── Order generation ─────────────────────────────────────────────────────────

  async generateOrder(templateId: string) {
    const template = await this.prisma.forTenant().orderTemplate.findUnique({
      where: { id: templateId },
      include: { items: true },
    });
    if (!template) throw new NotFoundException("Order template not found");
    if (!template.isActive) throw new BadRequestException("Template is not active");
    const order = await this.createOrderFromTemplate(template);
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
  // from ANOTHER customer's template. findOneForUser() throws for a non-owner.

  // B133: every mutation on the controller goes through an ownership wrapper. For
  // OPERATOR this is a pass-through today (the ownership branch is CUSTOMER-only);
  // its value is uniformity — a future CUSTOMER grant on addItem cannot ship unguarded.
  async addItemForUser(templateId: string, dto: AddTemplateItemDto, user: JwtPayload) {
    await this.findOneForUser(templateId, user);
    return this.addItem(templateId, dto);
  }

  async removeItemForUser(templateId: string, itemId: string, user: JwtPayload) {
    await this.findOneForUser(templateId, user);
    return this.removeItem(templateId, itemId);
  }

  async generateOrderForUser(templateId: string, user: JwtPayload) {
    await this.findOneForUser(templateId, user);
    return this.generateOrder(templateId);
  }

  @Cron("0 6 * * *")
  async generateDailyOrders() {
    const today = new Date();
    // ISO weekday: 1=Mon, 7=Sun
    const dayOfWeek = today.getDay() === 0 ? 7 : today.getDay();

    this.logger.log(`Running daily order generation for day ${dayOfWeek}`);

    // RF-008: cron has no HTTP request context so ALS is empty. Fetch all
    // active tenants and run each in its own ALS scope so forTenant() works.
    const activeTenants = await this.prisma.tenant.findMany({
      where: { status: "ACTIVE" },
      select: { id: true },
    });

    let totalCreated = 0;
    let totalSkipped = 0;

    for (const tenant of activeTenants) {
      await this.tenantCtx.run(tenant.id, async () => {
        const templates = await this.prisma.forTenant().orderTemplate.findMany({
          where: { isActive: true, daysOfWeek: { has: dayOfWeek } },
          include: { items: true },
        });

        for (const template of templates) {
          // Idempotency: skip if order already generated today for this template
          const existing = await this.prisma.forTenant().order.findFirst({
            where: {
              templateId: template.id,
              createdAt: { gte: startOfDay(today) },
            },
          });
          if (existing) {
            totalSkipped++;
            continue;
          }

          try {
            const order = await this.createOrderFromTemplate(template);
            // null = all lines were license-gated + skipped → nothing created.
            if (order) totalCreated++;
            else totalSkipped++;
          } catch (err) {
            this.logger.error(
              `[tenant:${tenant.id}] Failed to generate order for template ${template.id} (${template.name})`,
              err instanceof Error ? err.stack : String(err),
            );
          }
        }
      });
    }

    this.logger.log(
      `Daily order generation complete: ${totalCreated} created, ${totalSkipped} skipped across ${activeTenants.length} tenant(s)`,
    );
  }

  private async createOrderFromTemplate(template: {
    id: string;
    customerId: string;
    name: string;
    items: Array<{ productId: string; qty: number; notes?: string | null }>;
  }) {
    const productIds = template.items.map((i) => i.productId);
    const products = await this.prisma.forTenant().product.findMany({
      where: { id: { in: productIds } },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

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

    if (skippedCount > 0) {
      await this.notifySkippedRegulatedLines(template, blocked, skippedCount).catch(() => {});
    }
    // Every line was a license-gated category the customer isn't verified for —
    // there is nothing to order. Callers treat null as "skipped".
    if (allowedItems.length === 0) return null;

    const tenantId = this.prisma.getTenantId();
    let subtotal = 0;
    const lineItemsData = allowedItems.map((item) => {
      const product = productMap.get(item.productId);
      if (!product) throw new BadRequestException(`Product ${item.productId} not found`);
      const unitPrice = Number(product.pricePerUnit);
      // A template qty is a SELLING-UNIT count (a box for boxed products), so the
      // line subtotal is unitPrice × qty — but go through the shared helper (which
      // rounds) rather than raw float math, so totals never carry sub-cent drift.
      const itemSubtotal = computeLineSubtotal({ unitPrice, qty: item.qty });
      subtotal = roundMoney(subtotal + itemSubtotal);
      return {
        productId: item.productId,
        qty: item.qty,
        unitPrice,
        subtotal: itemSubtotal,
        notes: item.notes ?? undefined,
        // W4/W6b: snapshot the product's regulated category at sale time so
        // invoice generation splits by it and the ledger is written — same as the
        // interactive create path (orders.service.create). Without this an allowed
        // regulated standing-order line would invoice as standard.
        trackedCategoryId: product.trackedCategoryId ?? null,
        categoryTaxAmount: 0,
        tenantId, // nested creates bypass forTenant() extension
      };
    });

    // RF-4: read the tenant's own tax setting per-request rather than a
    // constructor-cached env fallback — standing orders were previously taxed
    // at a flat 10% (env TAX_RATE ?? 0.1) regardless of what the tenant had
    // configured in Settings, same unit-mismatch bug as orders.service.
    const storedTaxRate = await this.systemConfig.get("settings.taxRate");
    const taxRate = taxRateFractionFrom(storedTaxRate);
    const tax = roundMoney(subtotal * taxRate);
    const total = roundMoney(subtotal + tax);
    const orderNumber = `ORD-${Date.now()}`;
    const today = new Date();
    const skipNote =
      skippedCount > 0 ? ` (${skippedCount} regulated line(s) skipped — license not verified)` : "";

    const created = await this.prisma.forTenant().order.create({
      data: {
        customerId: template.customerId,
        templateId: template.id,
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
      include: {
        lineItems: { include: { product: { select: { id: true, name: true, unit: true } } } },
        customer: { select: { id: true, businessName: true } },
      },
    });

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
        {},
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

  /** Spec §8: when a standing order skips license-gated lines, notify the buyer
   *  (push) and the seller's operators (push). Best-effort per recipient. */
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
