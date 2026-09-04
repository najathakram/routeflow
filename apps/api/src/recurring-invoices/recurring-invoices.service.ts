import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { InvoicesService } from "../invoices/invoices.service";
import { CreateRecurringInvoiceDto } from "./dto/create-recurring-invoice.dto";
import { UpdateRecurringInvoiceDto } from "./dto/update-recurring-invoice.dto";
import { RecurringFrequency } from "@prisma/client";

/** REG-B106: RecurringInvoice.lastRunStatus values (schema comment: "SUCCESS" | "FAILED"). */
export const RUN_STATUS_SUCCESS = "SUCCESS";
export const RUN_STATUS_FAILED = "FAILED";
/** Provisional lastError stamped at claim time; overwritten by SUCCESS or the real failure. */
export const RUN_INTERRUPTED_ERROR = "Generation was interrupted before the invoice was created";
/**
 * REG-B106: prefix of the lastError recorded when the invoice WAS created but the run could
 * not be finalized (the link or outcome write failed). Such a cycle is ALREADY BILLED, so
 * the schedule is never given back and operator surfaces must not offer a re-run — the web
 * card keys its "use Run Now to retry" hint off this exact text.
 */
export const RUN_UNFINALIZED_ERROR = "The invoice was created but the run could not be finalized";

@Injectable()
export class RecurringInvoicesService {
  private readonly logger = new Logger(RecurringInvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextService,
    private readonly invoicesService: InvoicesService,
  ) {}

  // ─── Next run calculation ──────────────────────────────────────────────────

  private calcNextRunAt(
    frequency: RecurringFrequency,
    dayOfWeek?: number | null,
    dayOfMonth?: number | null,
    from: Date = new Date(),
  ): Date {
    if (frequency === RecurringFrequency.MONTHLY) {
      // REG-B46: the old branch called d.setDate(1) BEFORE testing d.getDate() > dom, so
      // the test was always `1 > dom` (false) and the month never advanced — the midnight
      // cron re-selected every MONTHLY template nightly. Decide from `from` itself: the
      // template's dayOfMonth in the earliest month whose occurrence is STRICTLY after
      // `from`'s calendar day, re-applied from `dom` each month and clamped to that
      // month's length (dom 31 → Feb 28 → Mar 31, no drift; Dec → Jan of next year).
      // Clamp first: `dayOfMonth` is a nullable Int with no DB constraint and the PATCH was
      // unvalidated until REG-B92, so a stored 0 or negative is reachable — and it would
      // make the loop below never advance (occurrence(y, m) would land in month m-1 and
      // come straight back to the same date), hanging the event loop and with it the cron
      // and the whole API process. A corrupt row degrades to day 1, never to a hang.
      const dom = Math.min(31, Math.max(1, Math.trunc(Number(dayOfMonth)) || 1));
      const base = new Date(from);
      base.setHours(0, 0, 0, 0);
      const occurrence = (year: number, monthIndex: number): Date => {
        const lastDay = new Date(year, monthIndex + 1, 0).getDate();
        return new Date(year, monthIndex, Math.min(dom, lastDay));
      };
      let next = occurrence(base.getFullYear(), base.getMonth());
      while (next.getTime() <= base.getTime()) {
        next = occurrence(next.getFullYear(), next.getMonth() + 1);
      }
      return next;
    }

    const d = new Date(from);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1); // always at least tomorrow

    // WEEKLY or BIWEEKLY — find next occurrence of dayOfWeek   ← UNCHANGED from here down
    const dow = dayOfWeek ?? 1; // default Monday
    const current = d.getDay();
    const daysUntil = (dow - current + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntil);
    if (frequency === RecurringFrequency.BIWEEKLY) d.setDate(d.getDate() + 7);
    return d;
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async create(dto: CreateRecurringInvoiceDto) {
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException("Customer not found");

    return this.prisma.forTenant().recurringInvoice.create({
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
            tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
          })),
        },
      },
      include: { customer: { select: { id: true, businessName: true } }, items: true },
    });
  }

  async findAll(customerId?: string) {
    return this.prisma.forTenant().recurringInvoice.findMany({
      where: customerId ? { customerId } : {},
      include: { customer: { select: { id: true, businessName: true } }, items: true },
      orderBy: { nextRunAt: "asc" },
    });
  }

  async findOne(id: string) {
    const ri = await this.prisma.forTenant().recurringInvoice.findUnique({
      where: { id },
      include: { customer: { select: { id: true, businessName: true } }, items: true },
    });
    if (!ri) throw new NotFoundException("Recurring invoice not found");
    return ri;
  }

  async update(id: string, dto: UpdateRecurringInvoiceDto) {
    await this.findOne(id);
    const include = { customer: { select: { id: true, businessName: true } }, items: true };
    const data = {
      ...(dto.frequency && { frequency: dto.frequency }),
      ...(dto.dayOfWeek !== undefined && { dayOfWeek: dto.dayOfWeek }),
      ...(dto.dayOfMonth !== undefined && { dayOfMonth: dto.dayOfMonth }),
      ...(dto.autoSend !== undefined && { autoSend: dto.autoSend }),
      ...(dto.notes !== undefined && { notes: dto.notes }),
      ...(dto.terms !== undefined && { terms: dto.terms }),
      ...(dto.discount !== undefined && { discount: dto.discount }),
      ...(dto.shippingFee !== undefined && { shippingFee: dto.shippingFee }),
      ...(dto.nextRunAt && { nextRunAt: new Date(dto.nextRunAt) }),
    };
    if (!dto.items) {
      return this.prisma.forTenant().recurringInvoice.update({ where: { id }, data, include });
    }
    // REG-B92: replace the lines in ONE transaction — a failure between the delete and
    // the re-create must never leave a template with no items.
    const tenantId = this.prisma.getTenantId();
    const items = dto.items;
    return this.prisma.tenantTransaction(async (tx) => {
      await tx.recurringInvoiceItem.deleteMany({ where: { recurringInvoiceId: id } });
      return tx.recurringInvoice.update({
        where: { id },
        data: {
          ...data,
          items: {
            create: items.map((i) => ({
              description: i.description,
              productId: i.productId,
              qty: i.qty,
              unitPrice: i.unitPrice,
              discount: i.discount ?? 0,
              taxRate: i.taxRate ?? 0,
              tenantId, // nested creates bypass forTenant() extension
            })),
          },
        },
        include,
      });
    });
  }

  async deactivate(id: string) {
    await this.findOne(id);
    return this.prisma
      .forTenant()
      .recurringInvoice.update({ where: { id }, data: { isActive: false } });
  }

  /** Resume a paused template. Counterpart to deactivate() — the only path that
   *  sets isActive back to true (update() intentionally never maps isActive). */
  async activate(id: string) {
    await this.findOne(id);
    return this.prisma
      .forTenant()
      .recurringInvoice.update({ where: { id }, data: { isActive: true } });
  }

  async runNow(id: string) {
    const ri = await this.prisma.forTenant().recurringInvoice.findUnique({
      where: { id },
      include: { items: true, customer: true },
    });
    if (!ri) throw new NotFoundException("Recurring invoice not found");
    return this.generateInvoiceFromTemplate(ri);
  }

  // ─── Core generation logic ────────────────────────────────────────────────

  private async generateInvoiceFromTemplate(ri: any) {
    // Claim the cycle BEFORE creating anything (B9 — see the history in this comment's
    // previous version). REG-B106: the claim also stamps a PROVISIONAL outcome — until
    // the invoice exists this cycle has NOT succeeded, so a process crash between here
    // and the create below leaves an honest FAILED behind instead of a fresh lastRunAt
    // that reads as success. SUCCESS is written LAST (after the invoice is linked); a
    // create failure overwrites the provisional text with the real error and gives the
    // cycle back (below).
    // REG-B46: advance from the LATER of the due date and now. Advancing from `ri.nextRunAt`
    // alone is one cycle at a time, which is still in the PAST for a backlogged template —
    // and B46 froze every MONTHLY template at its original due date (a long pause via
    // deactivate/activate, or an operator-set past date, does the same). The cron selects on
    // `nextRunAt <= now`, so such a template would be re-selected every night, minting one
    // real customer invoice per night until it caught up. Missed cycles are deliberately NOT
    // billed retroactively: this run is the single make-up invoice and the schedule resumes
    // at the first occurrence after today, so the claim is always strictly future (R4).
    const now = new Date();
    const dueAt = ri.nextRunAt ? new Date(ri.nextRunAt) : now;
    const advanceFrom = dueAt.getTime() > now.getTime() ? dueAt : now;
    const nextRunAt = this.calcNextRunAt(ri.frequency, ri.dayOfWeek, ri.dayOfMonth, advanceFrom);
    const claimed = await this.prisma.forTenant().recurringInvoice.updateMany({
      where: { id: ri.id, nextRunAt: ri.nextRunAt },
      data: {
        nextRunAt,
        lastRunAt: new Date(),
        lastRunStatus: RUN_STATUS_FAILED,
        lastError: RUN_INTERRUPTED_ERROR,
      },
    });
    if (claimed.count === 0) {
      this.logger.warn(`Recurring invoice ${ri.id}: cycle already claimed, skipping`);
      return null;
    }

    let invoice: any;
    try {
      invoice = await this.invoicesService.create({
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
    } catch (err) {
      // REG-B106: record the failure AND give the cycle back. invoicesService.create
      // commits the invoice + its ledger rows in ONE tenantTransaction and has no
      // post-commit step on this path (it never passes `send`), so a throw means no
      // invoice exists — restoring nextRunAt cannot mint a duplicate, and it lets the
      // midnight cron retry tomorrow / "Run now" bill THIS cycle rather than the next.
      // lastRunAt is deliberately kept: it is the time of the attempt.
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await this.prisma
        .forTenant()
        .recurringInvoice.update({
          where: { id: ri.id },
          data: { nextRunAt: ri.nextRunAt, lastRunStatus: RUN_STATUS_FAILED, lastError: message },
        })
        .catch((e: any) =>
          this.logger.error(
            `Recurring invoice ${ri.id}: generation failed AND the failure could not be recorded (${e?.message ?? e})`,
          ),
        );
      throw err;
    }

    // If autoSend, actually EMAIL the invoice to the customer. R5: this previously used
    // the mark-as-sent-only path (`send`), so the invoice flipped to SENT without any
    // email going out — despite the "Auto-send generated invoices to customer" setting.
    // Failures (no email on file, email not configured, send error) are logged and leave
    // the invoice as a DRAFT for the operator to send manually — never a dishonest SENT.
    if (ri.autoSend) {
      try {
        await this.invoicesService.sendEmail(invoice.id);
      } catch (err: any) {
        const reason = err?.response?.code ?? err?.message ?? "unknown error";
        this.logger.warn(
          `Recurring invoice ${invoice.id} generated but auto-send email failed (${reason}) — left as DRAFT.`,
        );
      }
    }

    try {
      // Update recurringInvoice.recurringInvoiceId on the new invoice
      await this.prisma.forTenant().invoice.update({
        where: { id: invoice.id },
        data: { recurringInvoiceId: ri.id },
      });

      // REG-B106: only now — invoice created and linked — is the cycle a success. Never
      // carries nextRunAt (the claim above is the single schedule write on this path).
      await this.prisma.forTenant().recurringInvoice.update({
        where: { id: ri.id },
        data: { lastRunStatus: RUN_STATUS_SUCCESS, lastError: null },
      });
    } catch (err) {
      // REG-B106: the invoice EXISTS here — committed, and already emailed when autoSend is
      // on — and only the bookkeeping after it failed. Two rules follow. (1) Never restore
      // nextRunAt: this cycle IS billed, so giving the schedule back would bill it twice.
      // (2) Never leave the claim's "interrupted before the invoice was created" text
      // behind: it is false, and a FAILED cycle reads as retryable on the operator
      // surfaces, so a "Run now" would claim the advanced nextRunAt and mint a SECOND
      // invoice for the same cycle. The message is rewritten to RUN_UNFINALIZED_ERROR,
      // which those surfaces use to suppress the retry hint. The error is not rethrown:
      // the invoice was created, so the caller gets it and the log carries the detail.
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      this.logger.error(
        `Recurring invoice ${ri.id}: invoice ${invoice.id} was created but the run could not be finalized (${message})`,
      );
      await this.prisma
        .forTenant()
        .recurringInvoice.update({
          where: { id: ri.id },
          data: {
            lastRunStatus: RUN_STATUS_FAILED,
            lastError: `${RUN_UNFINALIZED_ERROR} (invoice ${invoice.id}): ${message}`.slice(0, 500),
          },
        })
        .catch((e: any) =>
          this.logger.error(
            `Recurring invoice ${ri.id}: the unfinalized outcome could not be recorded (${e?.message ?? e})`,
          ),
        );
    }

    return invoice;
  }

  // ─── Scheduled cron ──────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async generateDueRecurringInvoices() {
    // RF-008: cron has no HTTP request context so ALS is empty. Fetch all
    // active tenants and run each in its own ALS scope so forTenant() works.
    const activeTenants = await this.prisma.tenant.findMany({
      where: { status: "ACTIVE" },
      select: { id: true },
    });

    let totalSuccess = 0;
    let totalFail = 0;

    for (const tenant of activeTenants) {
      await this.tenantCtx.run(tenant.id, async () => {
        const due = await this.prisma.forTenant().recurringInvoice.findMany({
          where: { isActive: true, nextRunAt: { lte: new Date() } },
          include: { items: true, customer: true },
        });

        if (due.length === 0) return;
        this.logger.log(`[tenant:${tenant.id}] Processing ${due.length} due recurring invoice(s)…`);

        for (const ri of due) {
          try {
            await this.generateInvoiceFromTemplate(ri);
            totalSuccess++;
          } catch (err) {
            totalFail++;
            this.logger.error(
              `[tenant:${tenant.id}] Failed to generate invoice for recurring template ${ri.id} (customer: ${ri.customerId}): ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      });
    }

    this.logger.log(
      `Recurring invoices: ${totalSuccess} generated, ${totalFail} failed across ${activeTenants.length} tenant(s).`,
    );
  }
}
