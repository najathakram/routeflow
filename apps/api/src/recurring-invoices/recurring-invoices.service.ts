import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { RestrictionAck } from "@routeflow/types";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { LeaderCron } from "../common/cron-lock";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { requireRestrictionTenantId } from "../selling-restrictions/restriction-tenant";
import { CronExpression } from "@nestjs/schedule";
import { defaultSaleFulfilmentKind } from "../orders/default-sale-fulfilment";
import { blockedTemplateLines } from "./recurring-invoice-restrictions";
import { calcNextRunAt } from "./recurring-schedule";
import { NotificationsService } from "../notifications/notifications.service";
import { CreateRecurringInvoiceDto } from "./dto/create-recurring-invoice.dto";
import { UpdateRecurringInvoiceDto } from "./dto/update-recurring-invoice.dto";
import { RecurringFrequency } from "@prisma/client";
import { recurringLineSplit } from "./recurring-line-split";
import { assertNsfLinesUntaxed, nsfSafeTaxRate } from "../invoices/nsf-line-tax-guard";
import { assertSellableLines } from "../products/sellable-lines";

/** REG-B106: RecurringInvoice.lastRunStatus values (schema comment: "SUCCESS" | "FAILED"). */
export const RUN_STATUS_SUCCESS = "SUCCESS";
export const RUN_STATUS_FAILED = "FAILED";
/** F-05: the `lastError` prefix a selling-restriction suspension records (reactivation clears exactly that notice). */
export const SUSPENDED_ERROR_PREFIX = "Suspended:";
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
    private readonly sellingRestrictions: SellingRestrictionsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ─── Next run calculation ──────────────────────────────────────────────────

  private calcNextRunAt(
    frequency: RecurringFrequency,
    dayOfWeek?: number | null,
    dayOfMonth?: number | null,
    from: Date = new Date(),
  ): Date {
    return calcNextRunAt(frequency, dayOfWeek, dayOfMonth, from);
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async create(dto: CreateRecurringInvoiceDto) {
    assertNsfLinesUntaxed(dto.items ?? []); // #2656: a template's NSF-described line is never taxed
    // REG-B131: a removed (soft-deleted) customer is not a recurring-invoice target — the sweep
    // already skips their schedules, so creating one would only schedule a silent no-op. Refuse
    // through the existing not-found branch so no customer state leaks.
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: dto.customerId, deletedAt: null } });
    if (!customer) throw new NotFoundException("Customer not found");
    await this.assertNoFamilyLines(dto.items ?? []);

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

  /** WS8: a template line never names a FAMILY (the generated invoice line would). */
  private async assertNoFamilyLines(items: ReadonlyArray<{ productId?: string | null }>) {
    const ids = [...new Set(items.map((i) => i.productId).filter((id): id is string => !!id))];
    if (ids.length === 0) return;
    const products = await this.prisma.forTenant().product.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, kind: true },
    });
    assertSellableLines(products);
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
    assertNsfLinesUntaxed(dto.items ?? []); // #2656: 400 before any read or write
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
    await this.assertNoFamilyLines(items);
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
  async activate(id: string, actorUserId: string | null = null) {
    const ri = await this.findOne(id);
    // Toggling an ACTIVE template is a no-op (a stale list, a double click): advancing its nextRunAt here would
    // silently skip a cycle whose run FAILED, which is then never billed.
    if (ri.isActive) return ri;
    // F-05 (SA-247(b), SA-268): a resumed schedule bills from the NEXT occurrence — a cycle that fell inside ANY
    // pause (a selling-restriction suspension or an admin pause) is billed only by an explicit "Run now". If
    // nextRunAt has passed, the midnight run would otherwise issue a make-up for it, so reactivation moves it to
    // the next occurrence after NOW in the same transaction and records the skipped cycle in the audit row.
    // A nextRunAt still in the future is left untouched.
    const now = new Date();
    const stale = ri.nextRunAt != null && ri.nextRunAt.getTime() <= now.getTime();
    // The suspension notice must not outlive the suspension (the card would show it on an active template).
    const clearNotice = String(ri.lastError ?? "").startsWith(SUSPENDED_ERROR_PREFIX);
    const nextRunAt = stale
      ? this.calcNextRunAt(ri.frequency, ri.dayOfWeek, ri.dayOfMonth, now)
      : undefined;
    return this.prisma.tenantTransaction(async (tx: any) => {
      // Conditional on the row still being inactive: a concurrent toggle makes this a no-op, never a second advance.
      const { count } = await tx.recurringInvoice.updateMany({
        where: { id, isActive: false },
        data: {
          isActive: true,
          ...(nextRunAt ? { nextRunAt } : {}),
          ...(clearNotice ? { lastRunStatus: null, lastError: null } : {}),
        },
      });
      if (count === 0) return tx.recurringInvoice.findUnique({ where: { id } }); // a fresh read, never the stale row
      // F-05: a reactivation is an explicit, audited act (it may follow a selling-restriction suspension)
      await this.auditInTx(
        tx,
        "recurring-invoice.reactivated",
        id,
        actorUserId,
        stale ? { skippedCycleDueAt: ri.nextRunAt!.toISOString(), resumedAt: nextRunAt } : {},
      );
      return tx.recurringInvoice.findUnique({ where: { id } });
    });
  }

  /** F-05: an audit row committed in the SAME transaction as the change it records. */
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
        entityType: "recurring-invoices",
        entityId,
        meta: meta as any,
      },
    });
  }

  /** `actor` + `ack`: the clicker and the acknowledgement of a prior 409 RESTRICTION_WARNING (row 510). */
  async runNow(id: string, actor?: JwtPayload, ack?: RestrictionAck) {
    const ri = await this.prisma.forTenant().recurringInvoice.findUnique({
      where: { id },
      include: { items: true, customer: true },
    });
    if (!ri) throw new NotFoundException("Recurring invoice not found");
    return this.generateInvoiceFromTemplate(ri, false, actor ? { actor, ack } : undefined);
  }

  // ─── Core generation logic ────────────────────────────────────────────────

  /** B142: builds a one-line note when the template still references an
   *  archived product — never blocks generation, only makes the gap visible
   *  on the resulting invoice. Returns null when nothing is archived. */
  private async suspendForSellingRestriction(
    ri: {
      id: string;
      customerId: string;
      frequency: RecurringFrequency;
      dayOfWeek?: number | null;
      dayOfMonth?: number | null;
      nextRunAt?: Date | string | null;
    },
    reasons: Array<{ productName?: string | null; ruleId?: string | null }>,
  ): Promise<void> {
    const names = [...new Set(reasons.map((r) => r.productName).filter(Boolean))].join(", ");
    // The skipped cycle is NEVER billed as a make-up: nextRunAt moves to the next occurrence AFTER now in
    // the SAME update that suspends, so reactivation resumes from the schedule. The flag and its audit row
    // commit together (AuditService swallows errors, so it cannot be the record of a state change).
    const now = new Date();
    const dueAt = ri.nextRunAt ? new Date(ri.nextRunAt) : now;
    const nextRunAt = this.calcNextRunAt(
      ri.frequency,
      ri.dayOfWeek,
      ri.dayOfMonth,
      dueAt.getTime() > now.getTime() ? dueAt : now,
    );
    await this.prisma.tenantTransaction(async (tx: any) => {
      await tx.recurringInvoice.update({
        where: { id: ri.id },
        data: {
          isActive: false,
          nextRunAt,
          lastRunStatus: RUN_STATUS_FAILED,
          lastError: `${SUSPENDED_ERROR_PREFIX} a line is under a selling restriction${names ? ` (${names})` : ""}. Fix the template and reactivate it; the skipped cycle is not billed.`,
        },
      });
      await this.auditInTx(tx, "recurring-invoice.suspended", ri.id, null, {
        reason: "SELLING_RESTRICTED",
        ruleIds: [...new Set(reasons.map((r) => r.ruleId).filter(Boolean))],
        skippedCycle: (ri.nextRunAt ? new Date(ri.nextRunAt) : now).toISOString(),
      });
    });
    const operators = await this.prisma.user.findMany({
      where: {
        tenantId: this.prisma.getTenantId(),
        role: { in: ["OPERATOR", "TENANT_ADMIN"] },
        status: "ACTIVE",
      },
      select: { id: true },
    });
    for (const op of operators) {
      await this.notifications
        .sendToUser(op.id, {
          title: "Recurring invoice suspended",
          body: `A recurring invoice was not issued and is suspended: a line is under a selling restriction${names ? ` (${names})` : ""}. Fix the template and reactivate it.`,
        })
        .catch(() => {});
    }
  }

  private async buildArchivedItemsNote(productIds: string[]): Promise<string | null> {
    if (productIds.length === 0) return null;
    const products = await this.prisma.forTenant().product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, sku: true, name: true, isActive: true },
    });
    const archived = products.filter((p: any) => p.isActive === false);
    if (archived.length === 0) return null;
    const labels = archived.map((p: any) => p.sku ?? p.name).join(", ");
    return `Note: ${labels} ${archived.length > 1 ? "are" : "is"} archived; billed as scheduled.`;
  }

  /** B646: the boxed split of a template line; warns (findable later) when a boxed line's qty is not a whole number of pieces. */
  private boxedSplitOrWarn(ri: any, item: any, livePack: number | null | undefined) {
    const split = recurringLineSplit(item, livePack);
    if (split) return { ...split, packSnapshot: Math.trunc(Number(livePack)) };
    if (
      !split &&
      item.productId &&
      !item.unitLabel &&
      Number(livePack ?? 0) > 1 &&
      Number(item.qty) > 0
    ) {
      this.logger.warn(
        `Recurring invoice ${ri.id}: template line "${item.description}" (product ${item.productId}) qty ${item.qty} is not a whole number of pieces of a ${livePack}-pack; generated as today (qty stored in the pieces column)`,
      );
    }
    return split;
  }

  /** #2656 / B142: billing never pauses — a legacy NSF template line's rate is billed at 0 and logged. */
  private runLineTaxRate(ri: any, item: any): number {
    const { taxRate, zeroed } = nsfSafeTaxRate(item);
    if (zeroed)
      this.logger.warn(
        `Recurring invoice ${ri.id}: NSF fee line carried taxRate ${String(item.taxRate)}; billed at 0 (#2656)`,
      );
    return taxRate;
  }

  private async generateInvoiceFromTemplate(
    ri: any,
    unattended = true,
    /** Row 510, "Run now" only: who clicked and what they acknowledged (stamps are written by THAT user). */
    run?: { actor: JwtPayload; ack?: RestrictionAck },
  ) {
    // #2656 / SA-549e: "Run now" is an operator deciding — a template whose NSF line carries a rate is
    // refused (400 NSF_LINE_UNTAXED) before the cycle is claimed, so nothing is issued or written.
    // Only the UNATTENDED run bills that line at 0 and logs it (B142: billing never pauses).
    if (!unattended) assertNsfLinesUntaxed(ri.items ?? []);
    // F-05 (SA-205): a banned line refuses the whole document — it is never dropped so the rest issues, since
    // that would change the invoice's money with nobody deciding. "Run now" is a staff member deciding (row 510:
    // 409 RESTRICTION_WARNING, the template untouched; a resubmit with the ack generates with stamps by the
    // clicker); the unattended run skips the cycle BEFORE it is claimed, notifies once and SUSPENDS the template
    // until a tenant admin reactivates it. A tenant-owned template sells as STAFF.
    const restrictionTenantId = requireRestrictionTenantId(this.prisma.getTenantId());
    const blocked = await blockedTemplateLines(
      this.sellingRestrictions,
      restrictionTenantId,
      ri,
      unattended,
      {
        fulfilmentKind: await defaultSaleFulfilmentKind(
          this.prisma,
          restrictionTenantId,
          ri.customerId,
        ),
      },
      run,
    );
    if (blocked) {
      await this.suspendForSellingRestriction(ri, blocked);
      return null;
    }
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

    // B142 (cause-ruling.md §2/§3, D3 batch path): billing must NEVER pause on
    // a catalog flag — a reject here would throw inside invoicesService.create(),
    // and REG-B106's failure handler gives the cycle back, re-failing every
    // night with the customer never billed (cause-refutation.md §2). Allow
    // through and record a visible note instead.
    const templateProductIds = [
      ...new Set(ri.items.map((item: any) => item.productId).filter(Boolean) as string[]),
    ];
    const archivedNote = await this.buildArchivedItemsNote(templateProductIds);

    let invoice: any;
    try {
      // B646: the LIVE pack at generation time (generation is the sale), to store a boxed line's boxes.
      // Read INSIDE the try, after the claim: a failed read records FAILED and gives the cycle back.
      const packRows: any[] =
        templateProductIds.length > 0
          ? await this.prisma.forTenant().product.findMany({
              where: { id: { in: templateProductIds } },
              select: { id: true, unitsPerBox: true },
            })
          : [];
      const packByProduct = new Map<string, number | null>(
        (packRows ?? []).map((p: any) => [p.id, p.unitsPerBox ?? null]),
      );
      invoice = await this.invoicesService.create(
        {
          customerId: ri.customerId,
          // row 510: the clicker's acknowledgement rides to the create, which stamps with the same line keys
          ...(run?.ack ?? {}),
          discount: Number(ri.discount),
          shippingFee: Number(ri.shippingFee),
          notes: archivedNote ? `${ri.notes ? `${ri.notes}\n` : ""}${archivedNote}` : ri.notes,
          terms: ri.terms,
          items: ri.items.map((item: any) => ({
            description: item.description,
            productId: item.productId,
            qty: Number(item.qty),
            unitPrice: Number(item.unitPrice),
            discount: Number(item.discount),
            taxRate: unattended ? this.runLineTaxRate(ri, item) : Number(item.taxRate),
            // B646: a boxed pack count carries its split, so qty is stored in PIECES (boxes x pack), and
            // SA-135: the pack it was split with rides along as packSnapshot (ONE read, never re-read).
            ...this.boxedSplitOrWarn(ri, item, packByProduct.get(item.productId)),
          })),
        },
        run?.actor,
      );
    } catch (err) {
      // REG-B106: record the failure AND give the cycle back. invoicesService.create
      // commits the invoice + its ledger rows in ONE tenantTransaction and has no
      // post-commit step on this path (it never passes `send`), so a throw means no
      // invoice exists — restoring nextRunAt cannot mint a duplicate, and it lets the
      // midnight cron retry tomorrow / "Run now" bill THIS cycle rather than the next.
      // lastRunAt is deliberately kept: it is the time of the attempt.
      // REG-B106: the restore is a COMPARE-AND-SET on the value this run's own claim
      // wrote (`nextRunAt`), not a plain update on the id. Between the claim and this
      // catch a newer run ("Run now", or the next tick) can claim the row and bill the
      // cycle for real; an unconditional restore would hand the schedule back to a
      // pre-claim date for a cycle that is already invoiced and mint a duplicate. A
      // `count: 0` means someone newer owns the row — write NOTHING and still rethrow.
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      const rolledBack = await this.prisma
        .forTenant()
        .recurringInvoice.updateMany({
          where: { id: ri.id, nextRunAt },
          data: { nextRunAt: ri.nextRunAt, lastRunStatus: RUN_STATUS_FAILED, lastError: message },
        })
        .catch((e: any) => {
          this.logger.error(
            `Recurring invoice ${ri.id}: generation failed AND the failure could not be recorded (${e?.message ?? e})`,
          );
          return null;
        });
      if (rolledBack && rolledBack.count === 0) {
        this.logger.warn(
          `Recurring invoice ${ri.id}: recurring-invoice rollback skipped: row re-claimed ` +
            `(claimed nextRunAt ${nextRunAt.toISOString()}, pre-claim nextRunAt ${
              ri.nextRunAt ? new Date(ri.nextRunAt).toISOString() : "null"
            })`,
        );
      }
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

  @LeaderCron(
    CronExpression.EVERY_DAY_AT_MIDNIGHT,
    "recurring-invoices.generateDueRecurringInvoices",
  )
  async generateDueRecurringInvoices() {
    // RF-008: cron has no HTTP request context so ALS is empty. Fetch all
    // active tenants and run each in its own ALS scope so forTenant() works.
    const activeTenants = await this.prisma.tenant.findMany({
      where: { status: "ACTIVE" },
      select: { id: true },
    });

    let totalSuccess = 0;
    let totalFail = 0;
    let totalSuppressed = 0;

    for (const tenant of activeTenants) {
      await this.tenantCtx.run(tenant.id, async () => {
        const due = await this.prisma.forTenant().recurringInvoice.findMany({
          // REG-B131: never generate (or auto-email) for a removed customer. Stateless, so a restored
          // customer's schedule resumes on its own; nextRunAt is left untouched while removed.
          where: { isActive: true, nextRunAt: { lte: new Date() }, customer: { deletedAt: null } },
          include: { items: true, customer: true },
        });

        // REG-B131: without this the tenant returns below before its per-tenant log whenever every due
        // row belongs to a removed customer, leaving no line at all for that night. Count the suppressed
        // set once per tenant per tick (cron path) so the suppression is visible and dated.
        const suppressed =
          (await this.prisma.forTenant().recurringInvoice.count({
            where: {
              isActive: true,
              nextRunAt: { lte: new Date() },
              customer: { deletedAt: { not: null } },
            },
          })) ?? 0;
        if (suppressed > 0) {
          totalSuppressed += suppressed;
          this.logger.warn(
            `[tenant:${tenant.id}] REG-B131: ${suppressed} recurring invoice(s) suppressed — customer removed`,
          );
        }

        if (due.length === 0) return;
        this.logger.log(`[tenant:${tenant.id}] Processing ${due.length} due recurring invoice(s)…`);

        for (const ri of due) {
          try {
            // null = skipped (cycle already claimed, or suspended by a selling restriction): not "generated"
            if (await this.generateInvoiceFromTemplate(ri)) totalSuccess++;
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
      `Recurring invoices: ${totalSuccess} generated, ${totalFail} failed, ${totalSuppressed} suppressed (customer removed) across ${activeTenants.length} tenant(s).`,
    );
  }
}
