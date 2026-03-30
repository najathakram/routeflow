import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { InvoicesService } from "../invoices/invoices.service";
import { CreateRecurringInvoiceDto } from "./dto/create-recurring-invoice.dto";
import { RecurringFrequency } from "@prisma/client";

@Injectable()
export class RecurringInvoicesService {
  private readonly logger = new Logger(RecurringInvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoicesService: InvoicesService,
  ) {}

  // ─── Next run calculation ──────────────────────────────────────────────────

  private calcNextRunAt(
    frequency: RecurringFrequency,
    dayOfWeek?: number | null,
    dayOfMonth?: number | null,
    from: Date = new Date(),
  ): Date {
    const d = new Date(from);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1); // always at least tomorrow

    if (frequency === RecurringFrequency.MONTHLY) {
      const dom = dayOfMonth ?? 1;
      d.setDate(1);
      d.setMonth(d.getMonth()); // reset to start of month
      // Find next occurrence of dayOfMonth
      if (d.getDate() > dom) d.setMonth(d.getMonth() + 1);
      d.setDate(Math.min(dom, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
      return d;
    }

    // WEEKLY or BIWEEKLY — find next occurrence of dayOfWeek
    const dow = dayOfWeek ?? 1; // default Monday
    const current = d.getDay();
    const daysUntil = (dow - current + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntil);
    if (frequency === RecurringFrequency.BIWEEKLY) d.setDate(d.getDate() + 7);
    return d;
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async create(dto: CreateRecurringInvoiceDto) {
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException("Customer not found");

    return this.prisma.recurringInvoice.create({
      data: {
        customerId: dto.customerId,
        frequency: dto.frequency,
        dayOfWeek: dto.dayOfWeek,
        dayOfMonth: dto.dayOfMonth,
        autoSend: dto.autoSend ?? false,
        notes: dto.notes,
        terms: dto.terms,
        discount: dto.discount ?? 0,
        shippingFee: dto.shippingFee ?? 0,
        nextRunAt: new Date(dto.nextRunAt),
        items: {
          create: dto.items.map((i) => ({
            description: i.description,
            productId: i.productId,
            qty: i.qty,
            unitPrice: i.unitPrice,
            discount: i.discount ?? 0,
            taxRate: i.taxRate ?? 0,
          })),
        },
      },
      include: { customer: { select: { id: true, businessName: true } }, items: true },
    });
  }

  async findAll(customerId?: string) {
    return this.prisma.recurringInvoice.findMany({
      where: customerId ? { customerId } : {},
      include: { customer: { select: { id: true, businessName: true } }, items: true },
      orderBy: { nextRunAt: "asc" },
    });
  }

  async findOne(id: string) {
    const ri = await this.prisma.recurringInvoice.findUnique({
      where: { id },
      include: { customer: { select: { id: true, businessName: true } }, items: true },
    });
    if (!ri) throw new NotFoundException("Recurring invoice not found");
    return ri;
  }

  async update(id: string, dto: Partial<CreateRecurringInvoiceDto>) {
    const ri = await this.findOne(id);

    if (dto.items) {
      await this.prisma.recurringInvoiceItem.deleteMany({ where: { recurringInvoiceId: id } });
    }

    return this.prisma.recurringInvoice.update({
      where: { id },
      data: {
        ...(dto.frequency && { frequency: dto.frequency }),
        ...(dto.dayOfWeek !== undefined && { dayOfWeek: dto.dayOfWeek }),
        ...(dto.dayOfMonth !== undefined && { dayOfMonth: dto.dayOfMonth }),
        ...(dto.autoSend !== undefined && { autoSend: dto.autoSend }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.terms !== undefined && { terms: dto.terms }),
        ...(dto.discount !== undefined && { discount: dto.discount }),
        ...(dto.shippingFee !== undefined && { shippingFee: dto.shippingFee }),
        ...(dto.nextRunAt && { nextRunAt: new Date(dto.nextRunAt) }),
        ...(dto.items && {
          items: {
            create: dto.items.map((i) => ({
              description: i.description,
              productId: i.productId,
              qty: i.qty,
              unitPrice: i.unitPrice,
              discount: i.discount ?? 0,
              taxRate: i.taxRate ?? 0,
            })),
          },
        }),
      },
      include: { customer: { select: { id: true, businessName: true } }, items: true },
    });
  }

  async deactivate(id: string) {
    await this.findOne(id);
    return this.prisma.recurringInvoice.update({ where: { id }, data: { isActive: false } });
  }

  async runNow(id: string) {
    const ri = await this.prisma.recurringInvoice.findUnique({
      where: { id },
      include: { items: true, customer: true },
    });
    if (!ri) throw new NotFoundException("Recurring invoice not found");
    return this.generateInvoiceFromTemplate(ri);
  }

  // ─── Core generation logic ────────────────────────────────────────────────

  private async generateInvoiceFromTemplate(ri: any) {
    const invoice = await this.invoicesService.create({
      customerId: ri.customerId,
      discount: Number(ri.discount),
      shippingFee: Number(ri.shippingFee),
      notes: ri.notes,
      terms: ri.terms,
      items: ri.items.map((item: any) => ({
        description: item.description,
        productId: item.productId,
        qty: Number(item.qty),
        unitPrice: Number(item.unitPrice),
        discount: Number(item.discount),
        taxRate: Number(item.taxRate),
      })),
    });

    // If autoSend, send the invoice
    if (ri.autoSend) {
      await this.invoicesService.send(invoice.id);
    }

    // Update recurringInvoice.recurringInvoiceId on the new invoice
    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: { recurringInvoiceId: ri.id },
    });

    // Advance nextRunAt
    const nextRunAt = this.calcNextRunAt(ri.frequency, ri.dayOfWeek, ri.dayOfMonth, ri.nextRunAt);
    await this.prisma.recurringInvoice.update({
      where: { id: ri.id },
      data: { lastRunAt: new Date(), nextRunAt },
    });

    return invoice;
  }

  // ─── Scheduled cron ──────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async generateDueRecurringInvoices() {
    const due = await this.prisma.recurringInvoice.findMany({
      where: { isActive: true, nextRunAt: { lte: new Date() } },
      include: { items: true, customer: true },
    });

    if (due.length === 0) return;
    this.logger.log(`Processing ${due.length} due recurring invoice(s)…`);

    let successCount = 0;
    let failCount = 0;

    for (const ri of due) {
      try {
        await this.generateInvoiceFromTemplate(ri);
        successCount++;
      } catch (err) {
        failCount++;
        this.logger.error(
          `Failed to generate invoice for recurring template ${ri.id} (customer: ${ri.customerId}): ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    this.logger.log(`Recurring invoices: ${successCount} generated, ${failCount} failed out of ${due.length} due.`);
  }
}
