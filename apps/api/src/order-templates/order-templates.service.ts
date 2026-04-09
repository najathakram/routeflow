import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { CreateOrderTemplateDto } from "./dto/create-order-template.dto";
import { UpdateOrderTemplateDto } from "./dto/update-order-template.dto";
import { AddTemplateItemDto } from "./dto/add-template-item.dto";

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

@Injectable()
export class OrderTemplatesService {
  private readonly logger = new Logger(OrderTemplatesService.name);
  private readonly taxRate: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.taxRate = this.config.get<number>("taxRate") ?? 0.1;
  }

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
      const customer = await this.prisma.forTenant().customer.findFirst({ where: { userId: user.sub } });
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
      const customer = await this.prisma.forTenant().customer.findFirst({ where: { userId: user.sub } });
      if (!customer || template.customerId !== customer.id) throw new ForbiddenException();
    }
    return template;
  }

  async createForUser(dto: CreateOrderTemplateDto, user: JwtPayload) {
    if (user.role === "CUSTOMER") {
      const customer = await this.prisma.forTenant().customer.findFirst({ where: { userId: user.sub } });
      if (!customer) throw new ForbiddenException();
      dto.customerId = customer.id;
    }
    return this.create(dto);
  }

  async updateForUser(id: string, dto: UpdateOrderTemplateDto, user: JwtPayload) {
    if (user.role === "CUSTOMER") {
      const template = await this.findOne(id);
      const customer = await this.prisma.forTenant().customer.findFirst({ where: { userId: user.sub } });
      if (!customer || template.customerId !== customer.id) throw new ForbiddenException();
    }
    return this.update(id, dto);
  }

  async removeForUser(id: string, user: JwtPayload) {
    if (user.role === "CUSTOMER") {
      const template = await this.findOne(id);
      const customer = await this.prisma.forTenant().customer.findFirst({ where: { userId: user.sub } });
      if (!customer || template.customerId !== customer.id) throw new ForbiddenException();
    }
    return this.remove(id);
  }

  async create(dto: CreateOrderTemplateDto) {
    if (!dto.customerId) throw new BadRequestException("customerId is required");
    const customer = await this.prisma.forTenant().customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new BadRequestException("Customer not found");

    const productIds = dto.items.map((i) => i.productId);
    const products = await this.prisma.forTenant().product.findMany({ where: { id: { in: productIds } } });
    if (products.length !== productIds.length) {
      throw new BadRequestException("One or more products not found");
    }

    return this.prisma.forTenant().orderTemplate.create({
      data: {
        customerId: dto.customerId!,
        name: dto.name,
        daysOfWeek: dto.daysOfWeek,
        notes: dto.notes,
        items: {
          create: dto.items.map((item) => ({
            productId: item.productId,
            qty: item.qty,
            notes: item.notes,
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
    const product = await this.prisma.forTenant().product.findUnique({ where: { id: dto.productId } });
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
    return this.createOrderFromTemplate(template);
  }

  @Cron("0 6 * * *")
  async generateDailyOrders() {
    const today = new Date();
    // ISO weekday: 1=Mon, 7=Sun
    const dayOfWeek = today.getDay() === 0 ? 7 : today.getDay();

    this.logger.log(`Running daily order generation for day ${dayOfWeek}`);

    const templates = await this.prisma.forTenant().orderTemplate.findMany({
      where: { isActive: true, daysOfWeek: { has: dayOfWeek } },
      include: { items: true },
    });

    let created = 0;
    let skipped = 0;

    for (const template of templates) {
      // Idempotency: skip if order already generated today for this template
      const existing = await this.prisma.forTenant().order.findFirst({
        where: {
          templateId: template.id,
          createdAt: { gte: startOfDay(today) },
        },
      });
      if (existing) {
        skipped++;
        continue;
      }

      try {
        await this.createOrderFromTemplate(template);
        created++;
      } catch (err) {
        this.logger.error(
          `Failed to generate order for template ${template.id} (${template.name})`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    this.logger.log(`Daily order generation complete: ${created} created, ${skipped} skipped`);
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

    let subtotal = 0;
    const lineItemsData = template.items.map((item) => {
      const product = productMap.get(item.productId);
      if (!product) throw new BadRequestException(`Product ${item.productId} not found`);
      const unitPrice = Number(product.pricePerUnit);
      const itemSubtotal = unitPrice * item.qty;
      subtotal += itemSubtotal;
      return {
        productId: item.productId,
        qty: item.qty,
        unitPrice,
        subtotal: itemSubtotal,
        notes: item.notes ?? undefined,
      };
    });

    const tax = subtotal * this.taxRate;
    const total = subtotal + tax;
    const orderNumber = `ORD-${Date.now()}`;
    const today = new Date();

    return this.prisma.forTenant().order.create({
      data: {
        customerId: template.customerId,
        templateId: template.id,
        orderNumber,
        subtotal,
        tax,
        total,
        notes: `Auto-generated from standing order: ${template.name}`,
        requestedDeliveryDate: today,
        lineItems: { create: lineItemsData },
      },
      include: {
        lineItems: { include: { product: { select: { id: true, name: true, unit: true } } } },
        customer: { select: { id: true, businessName: true } },
      },
    });
  }
}
