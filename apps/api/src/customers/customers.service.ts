import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { BuyerMergeRequestStatus, MergeInitiator } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { roundMoney } from "@routeflow/pricing";
import {
  CONFIRMED_PAYMENT,
  RECEIVED_METHOD_FILTER,
  sumConfirmed,
} from "../invoices/payment-predicates";
import {
  CREDIT_NOT_APPLICABLE,
  KPI_SUMMARY_EXCLUDED,
  LIFETIME_INVOICED_EXCLUDED,
} from "../invoices/invoice-status-sets";
import { geocodeAddress, GeocodableAddress, GeocodeCoords } from "../common/geocode.util";
import { withAdvisoryLock, LockTimeoutError, LockUnavailableError } from "../common/db-locks";
import { SCHEDULED_ROUTE_KIND_WHERE } from "../routes/route-stop-filters.util";
import { StorageService } from "../storage/storage.service";
import { compressDocument } from "../storage/compress.util";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";
import { ChangeCustomerStatusDto } from "./dto/change-customer-status.dto";
import { CreateAddressDto } from "./dto/create-address.dto";
import { UpdateAddressDto } from "./dto/update-address.dto";
import { ListCustomersDto } from "./dto/list-customers.dto";
import { UpsertCustomerPriceDto } from "./dto/customer-price.dto";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { UserRole } from "@prisma/client";
import { MeterService, MeterReading } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { buildPlanGateBody, PlanGateUpgrade } from "../billing/plan-gate";
// Same grace window BillingCronService.expireGrace() clears hourly — the create()
// gate applies it synchronously rather than waiting for the cron to run.
import { GRACE_DAYS } from "../billing/plan-catalog.constants";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Cap on how many blocking customers deleteAllCustomers() names in its 409 message.
const MAX_LISTED_BLOCKERS = 10;

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
    private readonly meter: MeterService,
    private readonly catalog: PlanCatalogService,
    private readonly entitlements: EntitlementsService,
    private readonly commissionEngine: CommissionEngineService,
    // Every path that DESTROYS an invoice must reverse its regulated-sales
    // ledger rows first — the ledger is append-only with no FK to Invoice, so
    // once the invoice row is gone the entries can never be matched back.
    private readonly ledger: RegulatedLedgerService,
  ) {}

  /**
   * MSRP writes are flag-gated INSIDE the service, not on the whole route —
   * mirrors ProductsService.assertMsrpAllowed. Callers only invoke this when
   * the DTO actually carries an `msrp` key.
   */
  private async assertMsrpAllowed(): Promise<void> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return; // no tenant context (e.g. SUPER_ADMIN) — nothing to gate
    if (await this.entitlements.hasFlag(tenantId, "flag.msrp")) return;
    const upgrade = await this.catalog.upgradeTargetForFlag("flag.msrp").catch(() => ({
      planKey: null,
      planMonthlyPrice: null,
      addonSku: null,
      addonMonthlyPrice: null,
    }));
    throw new ForbiddenException(buildPlanGateBody("flag.msrp", upgrade));
  }

  /**
   * Geocode an address, best-effort. Wraps the shared `geocodeAddress` util with this
   * service's own API key + logger — geocoding failure NEVER fails the caller's write,
   * it just leaves lat/lng null.
   */
  private async geocodeIfPossible(addr: GeocodableAddress): Promise<GeocodeCoords | null> {
    const key = this.config.get<string>("googleMaps.apiKey") ?? "";
    return geocodeAddress(addr, key, this.logger);
  }

  /** Geocode all CustomerAddress records that are missing lat/lng. Returns counts. */
  async geocodeAllAddresses(): Promise<{ total: number; geocoded: number; failed: number }> {
    const addresses = await this.prisma.forTenant().customerAddress.findMany({
      where: { OR: [{ lat: null }, { lng: null }] },
    });
    let geocoded = 0;
    let failed = 0;
    for (const addr of addresses) {
      const coords = await this.geocodeIfPossible(addr);
      if (coords) {
        await this.prisma.forTenant().customerAddress.update({
          where: { id: addr.id },
          data: coords,
        });
        geocoded++;
      } else {
        failed++;
      }
    }
    return { total: addresses.length, geocoded, failed };
  }

  /**
   * REG-B158: the ONE where-builder for both the paginated list and the CSV
   * export — they drifted (export had no supplierOnly/deletedAt/regulated
   * clause at all) because each hand-rolled its own `where`. Also the landing
   * site for REG-B156 (unassigned) and REG-B170 (removed): list/export drift
   * on a new filter becomes unwritable, not merely tested.
   */
  private buildListWhere(query: ListCustomersDto): any {
    const where: any = {
      // Exclude supplier-only contacts (vendors imported from expense CSVs that have no orders)
      supplierOnly: false,
      // REG-B170: default excludes soft-deleted customers (RF-197); removed=1 is an explicit
      // trash view — it shows ONLY removed customers, never mixed with live ones.
      deletedAt: query.removed === "1" ? { not: null } : null,
    };
    if (query.search) {
      const q = query.search;
      where.OR = [
        { businessName: { contains: q, mode: "insensitive" } },
        { contactName: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { displayName: { contains: q, mode: "insensitive" } },
      ];
    }
    if (query.status) {
      where.user = { status: query.status };
    }
    if (query.customerType) {
      where.customerType = query.customerType;
    }
    if (query.tag) {
      where.tagAssignments = {
        some: { tagId: query.tag },
      };
    }
    // Customers authorized to sell regulated items — i.e. holding at least one authorization
    // against a license-requiring tracked category. Mirrors the `tag` relation filter above.
    if (query.regulated === "1") {
      where.authorizations = { some: { trackedCategory: { requiresLicense: true } } };
    }
    // REG-B156: no stop on a currently SCHEDULED route. Shares SCHEDULED_ROUTE_KIND_WHERE with
    // routes.service.ts's getCustomerRouteAssignments so the "Currently in" hint on the same
    // screen can never disagree with this filter about what counts as assigned.
    if (query.unassigned === "1") {
      where.routeStops = { none: { route: SCHEDULED_ROUTE_KIND_WHERE } };
    }
    return where;
  }

  async findAll(query: ListCustomersDto) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 20);
    const skip = (page - 1) * limit;

    const where = this.buildListWhere(query);

    // Build orderBy. F4-002: sortBy reaches Prisma's orderBy, so it MUST be an
    // allowlisted scalar column — a free-form field name lets a caller inject an
    // unknown/relation field (Prisma 500 → DoS) or probe relation ordering.
    // Non-scalar UI columns (e.g. "receivables", computed post-query) and any
    // unknown value fall back to the safe default instead of hitting Prisma.
    const validSortFields: Record<string, string> = {
      businessName: "businessName",
      contactName: "contactName",
      displayName: "displayName",
      customerType: "customerType",
      pricingTier: "pricingTier",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    };
    // Object.hasOwn (not a bare index) so prototype keys — __proto__, constructor,
    // toString, valueOf… — can't resolve to a truthy inherited value and reach Prisma
    // as a malformed orderBy (→ 500). Unknown OR inherited → safe createdAt-desc default.
    const orderField =
      query.sortBy && Object.hasOwn(validSortFields, query.sortBy)
        ? validSortFields[query.sortBy]
        : undefined;
    const dir = query.sortDir === "asc" ? "asc" : "desc";
    // REG-B169: an id tiebreaker — createdAt (or any other sortable column)
    // can tie across many rows (a bulk import routinely shares one
    // createdAt), so a single-key orderBy leaves those rows in
    // undefined/unstable order across pages.
    const orderBy: any = orderField
      ? [{ [orderField]: dir }, { id: dir }]
      : [{ createdAt: "desc" }, { id: "desc" }];

    const [data, total] = await Promise.all([
      this.prisma.forTenant().customer.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, username: true, status: true } },
          addresses: true,
          tagAssignments: { include: { tag: true } },
          // Per-row count of regulated authorizations (badge on the "Regulated" filter).
          _count: {
            select: { authorizations: { where: { trackedCategory: { requiresLicense: true } } } },
          },
        },
        skip,
        take: limit,
        orderBy,
      }),
      this.prisma.forTenant().customer.count({ where }),
    ]);

    // Compute receivables and unusedCredits for each customer
    const customerIds = data.map((c) => c.id);

    const [invoices, advancePayments] = await Promise.all([
      this.prisma.forTenant().invoice.findMany({
        where: {
          customerId: { in: customerIds },
          status: { notIn: ["PAID", "VOID", "WRITTEN_OFF"] },
        },
        select: {
          customerId: true,
          total: true,
          payments: { select: { amount: true, status: true } },
        },
      }),
      this.prisma.forTenant().advancePayment.findMany({
        where: {
          customerId: { in: customerIds },
          balance: { gt: 0 },
        },
        select: { customerId: true, balance: true },
      }),
    ]);

    const receivablesMap: Record<string, number> = {};
    for (const inv of invoices) {
      // Exclude VOID payments (a bounced check flips InvoicePayment.status to VOID
      // in P5-12) so a reversed payment no longer counts against the receivable.
      const paid = inv.payments
        .filter((p) => p.status !== "VOID")
        .reduce((s, p) => s + Number(p.amount), 0);
      const outstanding = Number(inv.total) - paid;
      receivablesMap[inv.customerId] = (receivablesMap[inv.customerId] ?? 0) + outstanding;
    }

    const creditsMap: Record<string, number> = {};
    for (const ap of advancePayments) {
      creditsMap[ap.customerId] = (creditsMap[ap.customerId] ?? 0) + Number(ap.balance);
    }

    const enriched = data.map((c) => ({
      ...c,
      receivables: receivablesMap[c.id] ?? 0,
      unusedCredits: creditsMap[c.id] ?? 0,
      regulatedCount: (c as any)._count?.authorizations ?? 0,
    }));

    return { data: enriched, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findMyProfile(user: JwtPayload) {
    const customer = await this.prisma.forTenant().customer.findFirst({
      where: { userId: user.sub },
      include: {
        user: { select: { id: true, email: true, username: true, status: true } },
        addresses: true,
      },
    });
    if (!customer) throw new NotFoundException("Customer profile not found");
    return customer;
  }

  async updateMyProfile(user: JwtPayload, dto: UpdateCustomerDto) {
    const customer = await this.prisma
      .forTenant()
      .customer.findFirst({ where: { userId: user.sub } });
    if (!customer) throw new NotFoundException("Customer profile not found");
    return this.update(customer.id, dto);
  }

  async getMyStatement(user: JwtPayload) {
    const customer = await this.prisma
      .forTenant()
      .customer.findFirst({ where: { userId: user.sub } });
    if (!customer) throw new NotFoundException("Customer profile not found");

    const INVOICE_SELECT = {
      id: true,
      invoiceNumber: true,
      total: true,
      status: true,
      dueDate: true,
      createdAt: true,
      payments: { select: { amount: true, status: true } },
    } as const;
    const CREDIT_NOTE_SELECT = {
      id: true,
      creditNoteNumber: true,
      amount: true,
      status: true,
      createdAt: true,
      amountUsed: true,
      expiresAt: true,
    } as const;
    // REG-B110: the LEDGER caps below are for the transactions DISPLAY only —
    // the money figures (outstanding/overdue/availableCredit) are computed
    // from the separate, uncapped OPEN-set reads further down, never from a
    // take-capped page.
    const LEDGER_INVOICE_CAP = 50;
    const LEDGER_CREDIT_NOTE_CAP = 50;

    const [
      openInvoices,
      ledgerInvoicesRaw,
      openCreditNotes,
      ledgerCreditNotesRaw,
      lifetimeInvoicedAgg,
      lifetimeReceivedAgg,
    ] = await Promise.all([
      this.prisma.forTenant().invoice.findMany({
        // DRAFT is excluded with the settled/dead/forgiven statuses: a
        // not-yet-issued invoice is not receivable, so it must not inflate
        // outstanding/overdue. Same set as the invoices KPI summary (and the
        // Invoices-tab card's former client-side filter).
        where: { customerId: customer.id, status: { notIn: KPI_SUMMARY_EXCLUDED } },
        select: INVOICE_SELECT,
      }),
      this.prisma.forTenant().invoice.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: "desc" },
        take: LEDGER_INVOICE_CAP + 1,
        select: INVOICE_SELECT,
      }),
      this.prisma.forTenant().creditNote.findMany({
        where: { customerId: customer.id, status: { not: "VOID" } },
        select: CREDIT_NOTE_SELECT,
      }),
      this.prisma.forTenant().creditNote.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: "desc" },
        take: LEDGER_CREDIT_NOTE_CAP + 1,
        select: CREDIT_NOTE_SELECT,
      }),
      // M1 — lifetime "Invoiced Amount" / "Amount Received", summed by the
      // DATABASE over the buyer's whole history (never a reduce over the
      // take-capped ledger below, which under-reports past one page).
      this.prisma.forTenant().invoice.aggregate({
        _sum: { total: true },
        // DRAFT was never issued and VOID was cancelled — neither was billed.
        where: { customerId: customer.id, status: { notIn: LIFETIME_INVOICED_EXCLUDED } },
      }),
      this.prisma.forTenant().invoicePayment.aggregate({
        _sum: { amount: true },
        // B421: feeds `lifetimeReceived` below — "money genuinely received",
        // so CREDIT_NOTE is excluded (never cash) but ADVANCE stays (an
        // advance application is the only place that already-real cash is
        // ever recorded — see RECEIVED_METHOD_FILTER's own doc).
        where: {
          ...CONFIRMED_PAYMENT,
          method: RECEIVED_METHOD_FILTER,
          invoice: { customerId: customer.id },
        },
      }),
    ]);

    // Each ledger read asks for one row MORE than its cap; a read that comes
    // back over the cap is the proof that rows were left behind. The extra row
    // is sliced off before the ledger is built.
    const invoicesTruncated = ledgerInvoicesRaw.length > LEDGER_INVOICE_CAP;
    const creditNotesTruncated = ledgerCreditNotesRaw.length > LEDGER_CREDIT_NOTE_CAP;
    const ledgerInvoices = ledgerInvoicesRaw.slice(0, LEDGER_INVOICE_CAP);
    const ledgerCreditNotes = ledgerCreditNotesRaw.slice(0, LEDGER_CREDIT_NOTE_CAP);

    // CONFIRMED (PAID) basis — a DRAFT (unconfirmed) payment must never count
    // as paid (F03/sumConfirmed); VOID (e.g. a bounced check, P5-12) already
    // doesn't. B421: `amountPaid` here is NEVER returned to the client — it
    // only feeds `total - amountPaid` (outstanding/runningBalance below), so
    // it deliberately stays the FULL confirmed total (sumConfirmed, not
    // splitConfirmed's cash-only figure): a credit note or advance genuinely
    // reduces what's outstanding on this invoice, same basis as
    // invoices.service.ts's own balanceDue.
    const withPaid = <T extends { payments: { amount: unknown; status: string }[] }>(rows: T[]) =>
      rows.map((i) => ({ ...i, amountPaid: sumConfirmed(i.payments) }));

    const openInvoicesWithPaid = withPaid(openInvoices);
    const ledgerInvoicesWithPaid = withPaid(ledgerInvoices);

    // H2: every money figure this statement returns is rounded to cents —
    // a float reduce over many invoices leaks binary-float dust
    // (0.1 + 0.2 = 0.30000000000000004) straight into the UI.
    const outstanding = roundMoney(
      openInvoicesWithPaid.reduce((sum, i) => sum + (Number(i.total) - i.amountPaid), 0),
    );

    const overdue = roundMoney(
      openInvoicesWithPaid
        .filter((i) => i.dueDate && new Date(i.dueDate) < new Date())
        .reduce((sum, i) => sum + (Number(i.total) - i.amountPaid), 0),
    );

    // P5-13: wallet = Σ remaining over OPEN, non-expired credits. amount − amountUsed
    // (not face amount) prevents the double-count — a partial credit already sits on
    // the invoice as a CREDIT_NOTE payment, so only its unused remainder appears here.
    const now = new Date();
    const availableCredit = roundMoney(
      openCreditNotes
        .filter(
          (c) =>
            c.status !== "VOID" &&
            Number(c.amount) - Number(c.amountUsed) > 0.001 &&
            (!c.expiresAt || new Date(c.expiresAt) > now),
        )
        .reduce((sum, c) => sum + roundMoney(Number(c.amount) - Number(c.amountUsed)), 0),
    );

    // True whenever the transactions ledger below is a partial view of the
    // customer's full history (the ledger reads ALL statuses, capped) —
    // derived from the ledger read itself, never from the open-set size.
    // Read by the customer statement ledgers on web and mobile, which render a
    // partial-view line above the ledger when it is true and nothing when it is
    // false (LedgerTruncationNote on web, the mobile statement screen's line).
    const transactionsTruncated = invoicesTruncated || creditNotesTruncated;

    // Aggregate over an empty set returns a NULL sum — `?? 0` so a brand-new
    // buyer reads $0.00, never NaN.
    const lifetimeInvoiced = roundMoney(Number(lifetimeInvoicedAgg?._sum?.total ?? 0));
    const lifetimeReceived = roundMoney(Number(lifetimeReceivedAgg?._sum?.amount ?? 0));

    const transactions = [
      ...ledgerInvoicesWithPaid.map((i) => ({
        type: "INVOICE" as const,
        id: i.id,
        description: `Invoice #${i.invoiceNumber}`,
        date: i.createdAt.toISOString(),
        amount: Number(i.total),
        runningBalance: -(Number(i.total) - i.amountPaid),
        status: i.status,
      })),
      ...ledgerCreditNotes.map((c) => {
        const expired = !!c.expiresAt && new Date(c.expiresAt) <= now;
        const remaining =
          c.status === "VOID" || expired ? 0 : roundMoney(Number(c.amount) - Number(c.amountUsed));
        return {
          type: "CREDIT_NOTE" as const,
          id: c.id,
          description: `Credit Note #${c.creditNoteNumber}`,
          date: c.createdAt.toISOString(),
          amount: -Number(c.amount),
          runningBalance: remaining > 0.001 ? remaining : 0,
          status: c.status,
          expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
        };
      }),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return {
      outstandingAmount: outstanding,
      overdueAmount: overdue,
      availableCredit,
      lifetimeInvoiced,
      lifetimeReceived,
      transactionsTruncated,
      transactions,
    };
  }

  async findOne(id: string, user: JwtPayload) {
    const customer = await this.prisma.forTenant().customer.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true, username: true, status: true } },
        addresses: true,
        tagAssignments: { include: { tag: true } },
      },
    });
    if (!customer) throw new NotFoundException("Customer not found");
    if (
      user.role !== UserRole.OPERATOR &&
      user.role !== UserRole.TENANT_ADMIN &&
      user.role !== UserRole.DRIVER &&
      customer.userId !== user.sub
    ) {
      throw new ForbiddenException();
    }
    return customer;
  }

  async create(dto: CreateCustomerDto) {
    // Soft-cap gate: only ever blocks a BRAND-NEW create, and only once a prior
    // over-cap grace window has expired. Never blocks anything else.
    await this.assertCustomerCapNotExceeded();

    const email = dto.email?.trim() || undefined;
    // Only treat email as a uniqueness key when one was actually provided —
    // `{ email: undefined }` inside the OR would match every user.
    const existingUser = await this.prisma.forTenant().user.findFirst({
      where: { OR: [...(email ? [{ email }] : []), { username: dto.username }] },
    });
    if (existingUser) throw new BadRequestException("Email or username already taken");

    // User.email is required + unique per tenant; mint a non-routable internal
    // placeholder when the customer has no email. Customer.email stays null so
    // nothing customer-facing ever shows the placeholder.
    const userEmail = email ?? `no-email+${crypto.randomUUID()}@placeholder.local`;

    const tempPassword = this.generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    // Geocode addresses BEFORE opening the transaction — createMany can't carry
    // per-row computed values conditionally, and an HTTP call must never hold a DB
    // transaction open. Geocode failure never blocks the create; it just leaves
    // that row's lat/lng null (same semantics as addAddress).
    const addressCoords = dto.addresses
      ? await Promise.all(dto.addresses.map((addr) => this.geocodeIfPossible(addr)))
      : [];

    const result = await this.prisma.tenantTransaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: userEmail,
          username: dto.username,
          password: hashedPassword,
          role: UserRole.CUSTOMER,
          forcePasswordChange: true,
        },
      });

      const customer = await tx.customer.create({
        data: {
          userId: user.id,
          ...(email && { email }),
          businessName: dto.businessName,
          contactName: dto.contactName,
          phone: dto.phone,
          notes: dto.notes,
          fulfillPath: dto.fulfillPath ?? "ROUTE",
          ...(dto.mobile !== undefined && { mobile: dto.mobile }),
          ...(dto.customerType !== undefined && { customerType: dto.customerType }),
          ...(dto.displayName !== undefined && { displayName: dto.displayName }),
          ...(dto.salutation !== undefined && { salutation: dto.salutation }),
          ...(dto.firstName !== undefined && { firstName: dto.firstName }),
          ...(dto.lastName !== undefined && { lastName: dto.lastName }),
          ...(dto.taxId !== undefined && { taxId: dto.taxId }),
          ...(dto.isTaxExempt !== undefined && { isTaxExempt: dto.isTaxExempt }),
          ...(dto.creditLimit !== undefined && { creditLimit: dto.creditLimit }),
          ...(dto.currency !== undefined && { currency: dto.currency }),
          ...(dto.pricingTier !== undefined && { pricingTier: dto.pricingTier }),
          // "" clears to null ("use the tenant default"); a real label is stored verbatim.
          ...(dto.defaultPaymentTerms !== undefined && {
            defaultPaymentTerms: dto.defaultPaymentTerms || null,
          }),
          ...(dto.defaultDepositPercent !== undefined && {
            defaultDepositPercent: dto.defaultDepositPercent,
          }),
        },
      });

      // Sales agents & commissions: opens the customer's first attribution
      // window inside this same create tx. No entitlement check here —
      // writing an assignment for an un-flagged tenant is inert (the engine
      // never reads it while flag.sales_agents is off) and the field is only
      // surfaced in UI in PR-D. No CommissionEngineService injection needed —
      // this is a plain tx insert, not an engine call.
      if (dto.salesAgentId) {
        const agent = await tx.salesAgent.findFirst({
          where: { id: dto.salesAgentId, deletedAt: null },
          select: { id: true },
        });
        if (!agent) throw new BadRequestException("Unknown sales agent");
        await tx.agentAssignment.create({
          data: { customerId: customer.id, agentId: agent.id, effectiveFrom: new Date() },
        });
      }

      if (dto.addresses && dto.addresses.length > 0) {
        await tx.customerAddress.createMany({
          data: dto.addresses.map((addr, idx) => ({
            customerId: customer.id,
            label: addr.label,
            line1: addr.line1,
            line2: addr.line2,
            city: addr.city,
            state: addr.state,
            zip: addr.zip,
            isDefault: idx === 0,
            ...(addressCoords[idx] ?? {}),
          })),
        });
      }

      return {
        customer,
        // Surface the real email (null when the customer has none) — never the
        // internal placeholder minted for the User record.
        user: { id: user.id, email: email ?? null, username: user.username },
        tempPassword,
      };
    });

    // The create ALWAYS succeeds — this only opens a grace window when the new
    // count pushes the tenant over cap; it never undoes or gates the create above.
    await this.maybeStartCustomerGrace();

    return result;
  }

  // ─── Plan cap: CUSTOMERS soft-cap + grace ─────────────────────────────────

  /**
   * Soft-cap guard for CUSTOMERS, run BEFORE a create. While under cap, or
   * within an open grace window, this is a no-op — the create always proceeds.
   * It blocks ONLY a brand-new customer create, and only once a prior over-cap
   * grace window is older than {@link GRACE_DAYS} while the tenant
   * is still over cap. FAILS OPEN: any billing/catalog lookup failure (no
   * catalog, DB error) is treated as unlimited so a billing outage never blocks
   * customer creation.
   *
   * The aged window this reads is what makes the block durable:
   * `BillingCronService.expireGrace()` deliberately does NOT clear a CUSTOMERS window
   * while the tenant is over cap, because a cleared window reads here as "no grace yet"
   * and {@link maybeStartCustomerGrace} would simply open a fresh one.
   *
   * Public so the CSV/bulk contact import (`ImportService.importContacts`) gates on
   * the same rule as the single-create path instead of re-implementing it.
   */
  async assertCustomerCapNotExceeded(): Promise<void> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return; // no tenant context (e.g. SUPER_ADMIN) — nothing to gate

    let reading: MeterReading;
    try {
      reading = await this.meter.read(tenantId, "CUSTOMERS");
    } catch (err) {
      this.logger.warn(
        `Customer cap lookup failed for tenant ${tenantId}; failing open.`,
        err as Error,
      );
      return;
    }
    // Unlimited, or at/under cap — the create that would breach the cap is the
    // one that is always allowed to succeed (it's what starts the grace window).
    if (reading.included == null || reading.used <= reading.included) return;

    let sub: { graceStartedAt: Date | null } | null;
    try {
      sub = await this.prisma.tenantSubscription.findUnique({
        where: { tenantId },
        select: { graceStartedAt: true },
      });
    } catch (err) {
      this.logger.warn(
        `Customer cap grace lookup failed for tenant ${tenantId}; failing open.`,
        err as Error,
      );
      return;
    }
    if (!sub?.graceStartedAt) return; // over cap but no grace window yet — allow (post-create hook opens one)

    const graceAgeMs = Date.now() - sub.graceStartedAt.getTime();
    if (graceAgeMs <= GRACE_DAYS * MS_PER_DAY) return; // still within grace

    // Grace window expired and still over cap — block only this NEW create.
    const upgrade = await this.customerPackUpgrade();
    throw new ForbiddenException(buildPlanGateBody("meter.customers", upgrade));
  }

  /**
   * Post-create hook: if the tenant is now over the CUSTOMERS cap and no grace
   * window is open, start one. Never throws — a failure here must never appear
   * to undo a customer that was already created successfully.
   *
   * Public for the same reason as {@link assertCustomerCapNotExceeded}: the CSV
   * import calls it once after its run instead of duplicating the grace logic.
   */
  async maybeStartCustomerGrace(): Promise<void> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return;
    try {
      const reading = await this.meter.read(tenantId, "CUSTOMERS");
      if (reading.included == null || reading.used <= reading.included) return; // unlimited or still within cap

      const sub = await this.prisma.tenantSubscription.findUnique({
        where: { tenantId },
        select: { graceStartedAt: true },
      });
      if (sub?.graceStartedAt) return; // a grace window is already open

      // upsert, not update: most tenants have NO TenantSubscription row (caps still
      // resolve for them — EntitlementsService falls back to the tenant `plan` enum), and
      // `update` would throw P2025 on every over-cap create, logging an error and never
      // recording the window. `planKey` stays null — a grace window pins nothing, so
      // snapshot-based MRR (`mrr.service.ts`, which filters `planKey != null`) ignores the
      // row. `currentPlan` must still be stamped from the tenant: its Prisma default is
      // STARTER, and platform-admin reads `currentPlan` straight out of this table (billing
      // overview + tenant detail), so a defaulted row would report a Scale tenant as Starter.
      // Same write billing.service.ts makes when it mints a row for a Stripe customer.
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { plan: true },
      });
      const startedAt = new Date();
      await this.prisma.tenantSubscription.upsert({
        where: { tenantId },
        create: {
          tenantId,
          currentPlan: tenant?.plan ?? "STARTER",
          graceStartedAt: startedAt,
          graceMeter: "CUSTOMERS",
        },
        update: { graceStartedAt: startedAt, graceMeter: "CUSTOMERS" },
      });
    } catch (err) {
      // Best-effort: opening the grace window must never affect the (already
      // successful) customer creation.
      this.logger.error(
        `Failed to open customer-cap grace window for tenant ${tenantId}`,
        err as Error,
      );
    }
  }

  /** À-la-carte upsell target for the customer soft-cap gate (INLINE_RESOLVE). */
  private async customerPackUpgrade(): Promise<PlanGateUpgrade> {
    const empty: PlanGateUpgrade = {
      planKey: null,
      planMonthlyPrice: null,
      addonSku: "CUSTOMER_PACK_100",
      addonMonthlyPrice: null,
    };
    try {
      const version = await this.catalog.getPublishedVersion();
      const addon = version?.addonSkus.find((s) => s.sku === "CUSTOMER_PACK_100");
      return {
        ...empty,
        addonMonthlyPrice: addon?.monthlyPrice != null ? addon.monthlyPrice.toString() : null,
      };
    } catch {
      return empty; // catalog unresolvable — still name the SKU, just without a price
    }
  }

  async update(id: string, dto: UpdateCustomerDto) {
    const existing = await this.findCustomerOrThrow(id);
    // REG-B170: a removed customer's page still rendered its edit controls; refuse the write
    // rather than silently editing a customer nobody can see in the list.
    if (existing.deletedAt) {
      throw new ConflictException("Restore the customer first");
    }
    return this.prisma.forTenant().customer.update({
      where: { id },
      data: {
        ...(dto.businessName && { businessName: dto.businessName }),
        ...(dto.contactName && { contactName: dto.contactName }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.fulfillPath && { fulfillPath: dto.fulfillPath }),
        ...(dto.deliveryWindowStart !== undefined && {
          deliveryWindowStart: dto.deliveryWindowStart || null,
        }),
        ...(dto.deliveryWindowEnd !== undefined && {
          deliveryWindowEnd: dto.deliveryWindowEnd || null,
        }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.mobile !== undefined && { mobile: dto.mobile }),
        ...(dto.customerType !== undefined && { customerType: dto.customerType }),
        ...(dto.displayName !== undefined && { displayName: dto.displayName }),
        ...(dto.salutation !== undefined && { salutation: dto.salutation }),
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        ...(dto.taxId !== undefined && { taxId: dto.taxId }),
        ...(dto.isTaxExempt !== undefined && { isTaxExempt: dto.isTaxExempt }),
        ...(dto.creditLimit !== undefined && { creditLimit: dto.creditLimit }),
        ...(dto.currency !== undefined && { currency: dto.currency }),
        ...(dto.pricingTier !== undefined && { pricingTier: dto.pricingTier }),
        // "" clears to null ("use the tenant default"); a real label is stored verbatim.
        ...(dto.defaultPaymentTerms !== undefined && {
          defaultPaymentTerms: dto.defaultPaymentTerms || null,
        }),
        // null clears the deposit default; a number sets/replaces it.
        ...(dto.defaultDepositPercent !== undefined && {
          defaultDepositPercent: dto.defaultDepositPercent,
        }),
      },
    });
  }

  async changeStatus(id: string, dto: ChangeCustomerStatusDto) {
    const customer = await this.findCustomerOrThrow(id);
    // REG-B170: changeStatus had no removed gate at all — clicking "Active" on a removed
    // customer's still-visible status buttons wrote a zombie (deletedAt set + User.status
    // ACTIVE) hidden from every list yet able to log in. Refuse instead; restore first.
    if (customer.deletedAt) {
      throw new ConflictException("Restore the customer first");
    }
    return this.prisma.forTenant().user.update({
      where: { id: customer.userId },
      data: { status: dto.status },
      select: { id: true, status: true },
    });
  }

  async findRoutes(id: string) {
    await this.findCustomerOrThrow(id);
    const stops = await this.prisma.forTenant().routeStop.findMany({
      where: { customerId: id },
      include: {
        route: {
          include: {
            driver: {
              select: { id: true, contactName: true, user: { select: { username: true } } },
            },
          },
        },
        customerAddress: { select: { id: true, label: true, line1: true, city: true } },
      },
      orderBy: { route: { name: "asc" } },
    });

    // Deduplicate by routeId — keep the first stop per route
    const seen = new Set<string>();
    return stops
      .filter((s) => {
        if (seen.has(s.routeId)) return false;
        seen.add(s.routeId);
        return true;
      })
      .map((s) => ({
        id: s.route.id,
        name: s.route.name,
        isActive: s.route.isActive,
        stopNumber: s.stopNumber,
        stopId: s.id,
        addressLabel: s.customerAddress?.label ?? null,
        driverName: s.route.driver?.contactName ?? s.route.driver?.user?.username ?? null,
      }));
  }

  async findOrders(id: string, user: JwtPayload) {
    const customer = await this.findCustomerOrThrow(id);
    if (
      user.role !== UserRole.OPERATOR &&
      user.role !== UserRole.TENANT_ADMIN &&
      customer.userId !== user.sub
    ) {
      throw new ForbiddenException();
    }
    const [data, total] = await Promise.all([
      this.prisma.forTenant().order.findMany({
        where: { customerId: id },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      this.prisma.forTenant().order.count({ where: { customerId: id } }),
    ]);
    return { data, meta: { total, page: 1, limit: 50, totalPages: Math.ceil(total / 50) } };
  }

  async addAddress(id: string, dto: CreateAddressDto) {
    await this.findCustomerOrThrow(id);
    // Geocode before creating so lat/lng are set from the start
    const coords = await this.geocodeIfPossible(dto);
    return this.prisma.tenantTransaction(async (tx) => {
      if (dto.isDefault) {
        await tx.customerAddress.updateMany({
          where: { customerId: id },
          data: { isDefault: false },
        });
      }
      return tx.customerAddress.create({
        data: {
          customerId: id,
          label: dto.label,
          line1: dto.line1,
          line2: dto.line2,
          city: dto.city,
          state: dto.state,
          zip: dto.zip,
          isDefault: dto.isDefault ?? false,
          addressType: dto.addressType ?? "BILLING",
          ...(coords ?? {}),
        },
      });
    });
  }

  async updateAddress(id: string, addrId: string, dto: UpdateAddressDto) {
    await this.findCustomerOrThrow(id);
    const updated = await this.prisma.tenantTransaction(async (tx) => {
      if (dto.isDefault) {
        await tx.customerAddress.updateMany({
          where: { customerId: id, id: { not: addrId } },
          data: { isDefault: false },
        });
      }
      return tx.customerAddress.update({
        where: { id: addrId, customerId: id },
        data: { ...dto, lat: null, lng: null }, // clear stale coords when address changes
      });
    });
    // Re-geocode asynchronously (don't block the response)
    this.geocodeIfPossible(updated)
      .then((coords) => {
        if (coords) {
          this.prisma
            .forTenant()
            .customerAddress.update({ where: { id: addrId }, data: coords })
            .catch(() => {
              /* ignore */
            });
        }
      })
      .catch(() => {
        /* ignore */
      });
    return updated;
  }

  async deleteAddress(id: string, addrId: string) {
    await this.findCustomerOrThrow(id);
    const address = await this.prisma.forTenant().customerAddress.findFirst({
      where: { id: addrId, customerId: id },
    });
    if (!address) throw new NotFoundException("Address not found");

    // Deleting an address a live route stop points at would orphan the stop —
    // block with a clear reason instead. Both RouteStop (the route template)
    // and RouteRunStop (a scheduled run's per-stop instance) can reference it.
    const [stopCount, runStopCount] = await Promise.all([
      this.prisma.forTenant().routeStop.count({ where: { customerAddressId: addrId } }),
      this.prisma.forTenant().routeRunStop.count({ where: { customerAddressId: addrId } }),
    ]);
    if (stopCount > 0 || runStopCount > 0) {
      throw new ConflictException(
        "This address is used by a delivery route stop — remove it from the route first.",
      );
    }

    return this.prisma.tenantTransaction(async (tx) => {
      await tx.customerAddress.delete({ where: { id: addrId, customerId: id } });
      // Deleting the primary leaves the customer without one — promote the
      // oldest remaining address so isDefault always resolves to exactly one
      // row (or zero, if this was the last address).
      if (address.isDefault) {
        const oldestRemaining = await tx.customerAddress.findFirst({
          where: { customerId: id },
          orderBy: { createdAt: "asc" },
        });
        if (oldestRemaining) {
          await tx.customerAddress.update({
            where: { id: oldestRemaining.id },
            data: { isDefault: true },
          });
        }
      }
      return { success: true };
    });
  }

  private async findCustomerOrThrow(id: string) {
    const customer = await this.prisma.forTenant().customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException("Customer not found");
    return customer;
  }

  private generateTempPassword(): string {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const raw = Array.from(crypto.randomBytes(8))
      .map((b) => chars[b % chars.length])
      .join("");
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  }

  // ─── Operator statement ────────────────────────────────────────────────────

  async getStatementForOperator(customerId: string) {
    await this.findCustomerOrThrow(customerId);

    const INVOICE_SELECT = {
      id: true,
      invoiceNumber: true,
      total: true,
      status: true,
      dueDate: true,
      createdAt: true,
      payments: { select: { amount: true, status: true } },
    } as const;
    const CREDIT_NOTE_SELECT = {
      id: true,
      creditNoteNumber: true,
      amount: true,
      status: true,
      createdAt: true,
      amountUsed: true,
      expiresAt: true,
    } as const;
    const ADVANCE_PAYMENT_SELECT = {
      id: true,
      amount: true,
      balance: true,
      method: true,
      reference: true,
      receivedAt: true,
    } as const;
    // REG-B110: the LEDGER caps below are for the transactions DISPLAY only —
    // the money figures (outstanding/overdue/availableCredit/advanceBalance)
    // are computed from the separate, uncapped OPEN-set reads further down,
    // never from a take-capped page (a customer with >100 open invoices was
    // silently under-reported).
    const LEDGER_INVOICE_CAP = 100;
    const LEDGER_CREDIT_NOTE_CAP = 50;
    const LEDGER_ADVANCE_CAP = 50;

    const [
      openInvoices,
      ledgerInvoicesRaw,
      openCreditNotes,
      ledgerCreditNotesRaw,
      openAdvancePayments,
      ledgerAdvancePaymentsRaw,
      pendingOrders,
      lifetimeInvoicedAgg,
      lifetimeReceivedAgg,
    ] = await Promise.all([
      this.prisma.forTenant().invoice.findMany({
        // DRAFT is excluded with the settled/dead/forgiven statuses: a
        // not-yet-issued invoice is not receivable, so it must not inflate
        // outstanding/overdue. Same set as the invoices KPI summary (and the
        // Invoices-tab card's former client-side filter).
        where: { customerId, status: { notIn: KPI_SUMMARY_EXCLUDED } },
        select: INVOICE_SELECT,
      }),
      this.prisma.forTenant().invoice.findMany({
        where: { customerId },
        orderBy: { createdAt: "desc" },
        take: LEDGER_INVOICE_CAP + 1,
        select: INVOICE_SELECT,
      }),
      this.prisma.forTenant().creditNote.findMany({
        where: { customerId, status: { not: "VOID" } },
        select: CREDIT_NOTE_SELECT,
      }),
      this.prisma.forTenant().creditNote.findMany({
        where: { customerId },
        orderBy: { createdAt: "desc" },
        take: LEDGER_CREDIT_NOTE_CAP + 1,
        select: CREDIT_NOTE_SELECT,
      }),
      this.prisma.forTenant().advancePayment.findMany({
        where: { customerId, balance: { gt: 0 } },
        select: ADVANCE_PAYMENT_SELECT,
      }),
      this.prisma.forTenant().advancePayment.findMany({
        where: { customerId },
        orderBy: { receivedAt: "desc" },
        take: LEDGER_ADVANCE_CAP + 1,
        select: ADVANCE_PAYMENT_SELECT,
      }),
      // Pending / confirmed / out-for-delivery orders not yet invoiced
      this.prisma.forTenant().order.findMany({
        where: {
          customerId,
          status: { in: ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"] as any },
        },
        select: { id: true, total: true, orderNumber: true, status: true, createdAt: true },
      }),
      // M1 — the statement header's "Invoiced Amount" / "Amount Received"
      // tiles are LIFETIME figures over the customer's WHOLE history, so the
      // DATABASE sums them: a reduce over the take-capped `transactions`
      // ledger below under-reports every customer with more history than one
      // capped page holds, right beside the uncapped Outstanding/Overdue.
      // Aggregates — no rows materialised, no cap to out-grow.
      this.prisma.forTenant().invoice.aggregate({
        _sum: { total: true },
        // DRAFT was never issued and VOID was cancelled — neither was billed.
        // PAID/OVERDUE/WRITTEN_OFF are real past billings and DO belong here.
        where: { customerId, status: { notIn: LIFETIME_INVOICED_EXCLUDED } },
      }),
      this.prisma.forTenant().invoicePayment.aggregate({
        _sum: { amount: true },
        // B421: feeds `lifetimeReceived` below — "money genuinely received",
        // so CREDIT_NOTE is excluded (never cash) but ADVANCE stays (an
        // advance application is the only place that already-real cash is
        // ever recorded — see RECEIVED_METHOD_FILTER's own doc). A DRAFT
        // (unconfirmed) or VOID (bounced check) payment is not money
        // received either way, via CONFIRMED_PAYMENT.
        where: { ...CONFIRMED_PAYMENT, method: RECEIVED_METHOD_FILTER, invoice: { customerId } },
      }),
    ]);

    // Each ledger read asks for one row MORE than its cap; a read that comes
    // back over the cap is the proof that rows were left behind. The extra row
    // is sliced off before the ledger is built.
    const invoicesTruncated = ledgerInvoicesRaw.length > LEDGER_INVOICE_CAP;
    const creditNotesTruncated = ledgerCreditNotesRaw.length > LEDGER_CREDIT_NOTE_CAP;
    const advancesTruncated = ledgerAdvancePaymentsRaw.length > LEDGER_ADVANCE_CAP;
    const ledgerInvoices = ledgerInvoicesRaw.slice(0, LEDGER_INVOICE_CAP);
    const ledgerCreditNotes = ledgerCreditNotesRaw.slice(0, LEDGER_CREDIT_NOTE_CAP);
    const ledgerAdvancePayments = ledgerAdvancePaymentsRaw.slice(0, LEDGER_ADVANCE_CAP);

    // CONFIRMED (PAID) basis — a DRAFT (unconfirmed) payment must never count
    // as paid (F03/sumConfirmed); VOID (e.g. a bounced check, P5-12) already
    // doesn't. B421: `amountPaid` here is NEVER returned to the client — it
    // only feeds `total - amountPaid` (outstanding/runningBalance below), so
    // it deliberately stays the FULL confirmed total (sumConfirmed, not
    // splitConfirmed's cash-only figure): a credit note or advance genuinely
    // reduces what's outstanding on this invoice, same basis as
    // invoices.service.ts's own balanceDue.
    const withPaid = <T extends { payments: { amount: unknown; status: string }[] }>(rows: T[]) =>
      rows.map((i) => ({ ...i, amountPaid: sumConfirmed(i.payments) }));

    const openInvoicesWithPaid = withPaid(openInvoices);
    const ledgerInvoicesWithPaid = withPaid(ledgerInvoices);

    // H2: every money figure this statement returns is rounded to cents —
    // a float reduce over many invoices leaks binary-float dust
    // (0.1 + 0.2 = 0.30000000000000004) straight into the UI.
    const outstanding = roundMoney(
      openInvoicesWithPaid.reduce((sum, i) => sum + (Number(i.total) - i.amountPaid), 0),
    );

    const overdue = roundMoney(
      openInvoicesWithPaid
        .filter((i) => i.dueDate && new Date(i.dueDate) < new Date())
        .reduce((sum, i) => sum + (Number(i.total) - i.amountPaid), 0),
    );

    // P5-13: wallet = Σ remaining over OPEN, non-expired credits. amount − amountUsed
    // (not face amount) prevents the double-count — a partial credit already sits on
    // the invoice as a CREDIT_NOTE payment, so only its unused remainder appears here.
    const now = new Date();
    const availableCredit = roundMoney(
      openCreditNotes
        .filter(
          (c) =>
            c.status !== "VOID" &&
            Number(c.amount) - Number(c.amountUsed) > 0.001 &&
            (!c.expiresAt || new Date(c.expiresAt) > now),
        )
        .reduce((sum, c) => sum + roundMoney(Number(c.amount) - Number(c.amountUsed)), 0),
    );

    const advanceBalance = roundMoney(
      openAdvancePayments.reduce((sum, a) => sum + Number(a.balance), 0),
    );

    const pendingOrdersAmount = roundMoney(
      pendingOrders.reduce((sum, o) => sum + Number(o.total), 0),
    );

    // Aggregate over an empty set returns a NULL sum — `?? 0` so an untouched
    // customer reads $0.00, never NaN.
    const lifetimeInvoiced = roundMoney(Number(lifetimeInvoicedAgg?._sum?.total ?? 0));
    const lifetimeReceived = roundMoney(Number(lifetimeReceivedAgg?._sum?.amount ?? 0));

    // True whenever the transactions ledger below is a partial view of the
    // customer's full history (the ledger reads ALL statuses, capped) —
    // derived from the ledger read itself, never from the open-set size.
    // Read by the customer statement ledgers on web and mobile, which render a
    // partial-view line above the ledger when it is true and nothing when it is
    // false (LedgerTruncationNote on web, the mobile statement screen's line).
    const transactionsTruncated = invoicesTruncated || creditNotesTruncated || advancesTruncated;

    const transactions = [
      ...ledgerInvoicesWithPaid.map((i) => ({
        type: "INVOICE" as const,
        id: i.id,
        description: `Invoice #${i.invoiceNumber}`,
        date: i.createdAt.toISOString(),
        amount: Number(i.total),
        runningBalance: -(Number(i.total) - i.amountPaid),
        status: i.status,
      })),
      ...ledgerCreditNotes.map((c) => {
        const expired = !!c.expiresAt && new Date(c.expiresAt) <= now;
        const remaining =
          c.status === "VOID" || expired ? 0 : roundMoney(Number(c.amount) - Number(c.amountUsed));
        return {
          type: "CREDIT_NOTE" as const,
          id: c.id,
          description: `Credit Note #${c.creditNoteNumber}`,
          date: c.createdAt.toISOString(),
          amount: -Number(c.amount),
          runningBalance: remaining > 0.001 ? remaining : 0,
          status: c.status,
          expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
        };
      }),
      ...ledgerAdvancePayments.map((a) => ({
        type: "ADVANCE_PAYMENT" as const,
        id: a.id,
        description: `Advance Payment${a.reference ? ` (${a.reference})` : ""}`,
        date: a.receivedAt.toISOString(),
        amount: Number(a.amount),
        runningBalance: Number(a.balance),
        status: Number(a.balance) > 0 ? "AVAILABLE" : "USED",
      })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return {
      outstandingAmount: outstanding,
      overdueAmount: overdue,
      availableCredit,
      advanceBalance,
      pendingOrdersAmount,
      lifetimeInvoiced,
      lifetimeReceived,
      transactionsTruncated,
      transactions,
    };
  }

  // ─── Advance payments ──────────────────────────────────────────────────────

  async createAdvancePayment(
    customerId: string,
    dto: {
      amount: number;
      method: string;
      reference?: string;
      notes?: string;
      receivedAt?: string;
    },
  ) {
    await this.findCustomerOrThrow(customerId);
    if (dto.amount <= 0) throw new BadRequestException("Amount must be greater than 0");
    return this.prisma.forTenant().advancePayment.create({
      data: {
        customerId,
        amount: dto.amount,
        balance: dto.amount, // initial balance equals amount
        method: dto.method as any,
        reference: dto.reference,
        notes: dto.notes,
        receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : new Date(),
      },
    });
  }

  async getAdvancePayments(customerId: string) {
    await this.findCustomerOrThrow(customerId);
    return this.prisma.forTenant().advancePayment.findMany({
      where: { customerId },
      orderBy: { receivedAt: "desc" },
    });
  }

  // ─── Customer Prices ───────────────────────────────────────────────────────

  async getCustomerPrices(customerId: string) {
    return this.prisma.forTenant().customerPrice.findMany({
      where: { customerId },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
            unit: true,
            pricePerUnit: true,
            priceTier2: true,
            priceTier3: true,
            priceTier4: true,
            priceTier5: true,
            // For the Price Memory margin column (their price vs cost now).
            averageCost: true,
            unitsPerBox: true,
            // Product-level MSRP default, rendered beside the per-customer override.
            msrp: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Partial update: only touches the field(s) the caller actually sent, so a
   * tier-only PATCH never clobbers an existing MSRP override and vice versa. A
   * row cleared of BOTH fields has nothing left to say and is deleted instead
   * of left behind empty (frees the customerId_productId unique slot).
   */
  async upsertCustomerPrice(customerId: string, dto: UpsertCustomerPriceDto, user: JwtPayload) {
    // B132: authorization before semantics and before ANY read — a non-operator must
    // not learn whether an override exists. The role set is the DELETE sibling's
    // effective set under RolesGuard's ROLE_SATISFIES (TENANT_ADMIN ⊇ OPERATOR).
    const role = user?.role as UserRole | undefined;
    const operatorLevel =
      role === UserRole.OPERATOR || role === UserRole.TENANT_ADMIN || role === UserRole.SUPER_ADMIN;
    if (!operatorLevel) {
      throw new ForbiddenException("Only operators can change a price override");
    }
    if (dto.pricingTier === undefined && dto.msrp === undefined) {
      throw new BadRequestException("Provide a pricing tier, an MSRP override, or both");
    }
    if (dto.msrp !== undefined) {
      await this.assertMsrpAllowed();
    }

    const existing = await this.prisma.forTenant().customerPrice.findUnique({
      where: { customerId_productId: { customerId, productId: dto.productId } },
    });

    const nextPricingTier =
      dto.pricingTier !== undefined ? dto.pricingTier : (existing?.pricingTier ?? null);
    const nextMsrp =
      dto.msrp !== undefined
        ? dto.msrp === null
          ? null
          : roundMoney(dto.msrp)
        : existing?.msrp != null
          ? Number(existing.msrp)
          : null;

    if (nextPricingTier == null && nextMsrp == null) {
      if (existing) {
        // Clearing both fields removes the row (role already gated above — B132).
        await this.prisma.forTenant().customerPrice.delete({ where: { id: existing.id } });
      }
      return null;
    }

    return this.prisma.forTenant().customerPrice.upsert({
      where: {
        customerId_productId: { customerId, productId: dto.productId },
      },
      create: {
        customerId,
        productId: dto.productId,
        pricingTier: nextPricingTier,
        msrp: nextMsrp,
        notes: dto.notes,
      },
      update: {
        pricingTier: nextPricingTier,
        msrp: nextMsrp,
        notes: dto.notes,
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
            unit: true,
            pricePerUnit: true,
            priceTier2: true,
            priceTier3: true,
            priceTier4: true,
            priceTier5: true,
          },
        },
      },
    });
  }

  async deleteCustomerPrice(customerId: string, priceId: string) {
    const cp = await this.prisma.forTenant().customerPrice.findUnique({ where: { id: priceId } });
    if (!cp || cp.customerId !== customerId) {
      throw new NotFoundException("Customer price not found");
    }
    await this.prisma.forTenant().customerPrice.delete({ where: { id: priceId } });
  }

  /**
   * B310: reading `ap.balance` and later decrementing it were two separate statements with no
   * lock between them — two concurrent applies of the SAME advance could both read the
   * balance BEFORE either decrement landed, both pass the "has remaining balance" check, and
   * both apply, driving `balance` negative (money spent twice). Serialized with the house
   * `withAdvisoryLock` primitive (`family: "order-merge"`, customer-keyed — the same
   * customer-level lock order-merges already use for money serialization; see CLAUDE.md
   * "Money discipline"), never a second in-process lock. The pre-lock read below only fetches
   * the immutable `customerId` to build the lock key — it never informs the balance decision,
   * which is re-read fresh INSIDE the lock.
   */
  async applyAdvancePaymentToInvoice(
    advancePaymentId: string,
    dto: { invoiceId: string; amount?: number },
  ) {
    const apStub = await this.prisma.forTenant().advancePayment.findUnique({
      where: { id: advancePaymentId },
      select: { customerId: true },
    });
    if (!apStub) throw new NotFoundException("Advance payment not found");

    try {
      const lock = await withAdvisoryLock(
        { family: "order-merge", key: apStub.customerId, mode: "wait", waitMs: 10_000 },
        () => this.applyAdvancePaymentToInvoiceLocked(advancePaymentId, dto),
      );
      // Unreachable in practice: `mode: "wait"` either resolves acquired (fn ran) or the
      // acquire itself rejects (LockTimeoutError/LockUnavailableError, caught below) — it
      // never returns `{ acquired: false }`. Narrowed so `lock.value` type-checks.
      if (!lock.acquired) {
        throw new ServiceUnavailableException({
          code: "LOCK_UNAVAILABLE",
          message: "Wallet lock unavailable — retry shortly.",
        });
      }
      return lock.value;
    } catch (e) {
      if (e instanceof LockTimeoutError) {
        throw new ConflictException({
          code: "WALLET_LOCK_BUSY",
          message:
            "Another payment against this customer's wallet is in progress. Try again in a moment.",
        });
      }
      if (e instanceof LockUnavailableError) {
        throw new ServiceUnavailableException({
          code: "LOCK_UNAVAILABLE",
          message: "Wallet lock unavailable — retry shortly.",
        });
      }
      throw e;
    }
  }

  private async applyAdvancePaymentToInvoiceLocked(
    advancePaymentId: string,
    dto: { invoiceId: string; amount?: number },
  ) {
    return this.prisma.tenantTransaction(async (tx) => {
      const ap = await tx.advancePayment.findUnique({ where: { id: advancePaymentId } });
      if (!ap) throw new NotFoundException("Advance payment not found");
      if (Number(ap.balance) <= 0)
        throw new BadRequestException("Advance payment has no remaining balance");

      // Opus review (F39): withAdvisoryLock above only serializes concurrent applies of THIS
      // advance against EACH OTHER (keyed by customerId) — it does nothing against a totally
      // different writer of the same Invoice, e.g. a concurrent invoices.service.ts
      // `recordPayment` insert (invoices.service.ts never calls withAdvisoryLock, so that path
      // takes no such lock). Without locking the row here too, that path could still overpay
      // the invoice from the other side — the B311 race, reachable through this door instead.
      // The `SELECT ... FOR UPDATE` below is what actually conflicts with it: an ordinary
      // InsertPayment only holds `FOR KEY SHARE` on the parent Invoice row, and plain
      // `FOR UPDATE` (not the NOWAIT house primitive) is strong enough to block against that —
      // `FOR NO KEY UPDATE` would not be.
      await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${dto.invoiceId} FOR UPDATE`;

      const inv = await tx.invoice.findUnique({
        where: { id: dto.invoiceId },
        include: { payments: true },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (CREDIT_NOT_APPLICABLE.includes(inv.status)) {
        throw new BadRequestException(
          `Cannot apply advance payment to invoice with status ${inv.status}`,
        );
      }

      // Ignore VOID payments (a bounced check reverses to VOID in P5-12); otherwise a
      // reversed payment would understate the balance and under-apply the advance.
      const alreadyPaid = inv.payments
        .filter((p) => p.status !== "VOID")
        .reduce((s, p) => s + Number(p.amount), 0);
      const invoiceBalance = Number(inv.total) - alreadyPaid;
      const applyAmount = Math.min(Number(ap.balance), invoiceBalance, dto.amount ?? Infinity);

      if (applyAmount <= 0) throw new BadRequestException("Invoice has no outstanding balance");

      await tx.invoicePayment.create({
        data: {
          invoiceId: dto.invoiceId,
          amount: applyAmount,
          method: "ADVANCE" as any,
          advancePaymentId: ap.id,
          reference: `AP-${ap.id.slice(0, 8)}`,
        },
      });

      await tx.advancePayment.update({
        where: { id: ap.id },
        data: { balance: { decrement: applyAmount } },
      });

      const newPaid = alreadyPaid + applyAmount;
      const total = Number(inv.total);
      let newStatus: any = "SENT";
      if (newPaid >= total - 0.001) newStatus = "PAID";
      else if (newPaid > 0) newStatus = "PARTIAL";
      else if (inv.dueDate && new Date(inv.dueDate) < new Date()) newStatus = "OVERDUE";

      const updatedInvoice = await tx.invoice.update({
        where: { id: dto.invoiceId },
        data: { status: newStatus, paidAt: newStatus === "PAID" ? new Date() : null },
        include: {
          customer: { select: { id: true, businessName: true } },
          items: true,
          payments: { orderBy: { createdAt: "desc" } },
        },
      });

      // Commission hook: applying an advance IS cash hitting the invoice —
      // the accrual's payable must move with it in the same tx.
      await this.commissionEngine.syncInvoiceCommissionSafe(dto.invoiceId, tx);

      // F7 (money discipline): report the SERVER's own applied amount instead of making
      // the caller re-derive it client-side (e.g. web's `Math.min(remaining, balanceDue)`,
      // which can drift from what actually got applied). Additive field — existing
      // consumers (mobile) that ignore it are unaffected.
      return { ...updatedInvoice, appliedAmount: roundMoney(applyAmount) };
    });
  }

  // ─── Contact Persons CRUD ─────────────────────────────────────────────────

  async listContactPersons(customerId: string) {
    await this.findCustomerOrThrow(customerId);
    return this.prisma.forTenant().contactPerson.findMany({
      where: { customerId },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    });
  }

  async addContactPerson(
    customerId: string,
    dto: {
      salutation?: string;
      firstName: string;
      lastName?: string;
      email?: string;
      phone?: string;
      mobile?: string;
      isPrimary?: boolean;
    },
  ) {
    await this.findCustomerOrThrow(customerId);
    return this.prisma.tenantTransaction(async (tx) => {
      if (dto.isPrimary) {
        await tx.contactPerson.updateMany({
          where: { customerId },
          data: { isPrimary: false },
        });
      }
      return tx.contactPerson.create({
        data: {
          customerId,
          salutation: dto.salutation,
          firstName: dto.firstName,
          lastName: dto.lastName,
          email: dto.email,
          phone: dto.phone,
          mobile: dto.mobile,
          isPrimary: dto.isPrimary ?? false,
        },
      });
    });
  }

  async updateContactPerson(
    customerId: string,
    contactId: string,
    dto: {
      salutation?: string;
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      mobile?: string;
      isPrimary?: boolean;
    },
  ) {
    await this.findCustomerOrThrow(customerId);
    const existing = await this.prisma.forTenant().contactPerson.findFirst({
      where: { id: contactId, customerId },
    });
    if (!existing) throw new NotFoundException("Contact person not found");

    return this.prisma.tenantTransaction(async (tx) => {
      if (dto.isPrimary) {
        await tx.contactPerson.updateMany({
          where: { customerId, id: { not: contactId } },
          data: { isPrimary: false },
        });
      }
      return tx.contactPerson.update({
        where: { id: contactId },
        data: {
          ...(dto.salutation !== undefined && { salutation: dto.salutation }),
          ...(dto.firstName !== undefined && { firstName: dto.firstName }),
          ...(dto.lastName !== undefined && { lastName: dto.lastName }),
          ...(dto.email !== undefined && { email: dto.email }),
          ...(dto.phone !== undefined && { phone: dto.phone }),
          ...(dto.mobile !== undefined && { mobile: dto.mobile }),
          ...(dto.isPrimary !== undefined && { isPrimary: dto.isPrimary }),
        },
      });
    });
  }

  async deleteContactPerson(customerId: string, contactId: string) {
    await this.findCustomerOrThrow(customerId);
    const existing = await this.prisma.forTenant().contactPerson.findFirst({
      where: { id: contactId, customerId },
    });
    if (!existing) throw new NotFoundException("Contact person not found");
    await this.prisma.forTenant().contactPerson.delete({ where: { id: contactId } });
    return { success: true };
  }

  // ─── Tags ─────────────────────────────────────────────────────────────────

  async listTags() {
    return this.prisma.forTenant().customerTag.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { assignments: true } } },
    });
  }

  async createTag(dto: { name: string; color?: string }) {
    return this.prisma.forTenant().customerTag.create({
      data: {
        name: dto.name,
        ...(dto.color && { color: dto.color }),
      },
    });
  }

  async deleteTag(tagId: string) {
    const tag = await this.prisma.forTenant().customerTag.findUnique({ where: { id: tagId } });
    if (!tag) throw new NotFoundException("Tag not found");
    await this.prisma.forTenant().customerTag.delete({ where: { id: tagId } });
    return { success: true };
  }

  async assignTag(customerId: string, tagId: string) {
    await this.findCustomerOrThrow(customerId);
    const tag = await this.prisma.forTenant().customerTag.findUnique({ where: { id: tagId } });
    if (!tag) throw new NotFoundException("Tag not found");

    // Upsert to avoid duplicate constraint errors
    return this.prisma.forTenant().customerTagAssignment.upsert({
      where: { customerId_tagId: { customerId, tagId } },
      create: { customerId, tagId },
      update: {},
      include: { tag: true },
    });
  }

  async removeTag(customerId: string, tagId: string) {
    await this.findCustomerOrThrow(customerId);
    const assignment = await this.prisma.forTenant().customerTagAssignment.findUnique({
      where: { customerId_tagId: { customerId, tagId } },
    });
    if (!assignment) throw new NotFoundException("Tag assignment not found");
    await this.prisma.forTenant().customerTagAssignment.delete({
      where: { customerId_tagId: { customerId, tagId } },
    });
    return { success: true };
  }

  // ─── Comments ─────────────────────────────────────────────────────────────

  async listComments(customerId: string) {
    await this.findCustomerOrThrow(customerId);
    return this.prisma.forTenant().customerComment.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
    });
  }

  async addComment(customerId: string, userId: string, content: string) {
    await this.findCustomerOrThrow(customerId);
    if (!content || content.trim().length === 0) {
      throw new BadRequestException("Comment content cannot be empty");
    }
    return this.prisma.forTenant().customerComment.create({
      data: { customerId, userId, content: content.trim() },
    });
  }

  async deleteComment(customerId: string, commentId: string) {
    await this.findCustomerOrThrow(customerId);
    const comment = await this.prisma.forTenant().customerComment.findFirst({
      where: { id: commentId, customerId },
    });
    if (!comment) throw new NotFoundException("Comment not found");
    await this.prisma.forTenant().customerComment.delete({ where: { id: commentId } });
    return { success: true };
  }

  // ─── Income Chart ─────────────────────────────────────────────────────────

  async getIncomeChart(customerId: string) {
    await this.findCustomerOrThrow(customerId);

    const now = new Date();
    const months: Array<{ month: string; start: Date; end: Date }> = [];

    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
      const label = d.toLocaleString("en-US", { month: "short", year: "numeric" });
      months.push({ month: label, start, end });
    }

    const sixMonthsAgo = months[0].start;

    // Get the CONFIRMED invoice payments for this customer's invoices in the last 6 months
    const payments = await this.prisma.forTenant().invoicePayment.findMany({
      where: {
        invoice: { customerId },
        // Only confirmed money is income: a DRAFT row is an unconfirmed import and a
        // bounced/reversed payment (VOID in P5-12) was never really received, so neither
        // may inflate a month's income. Same predicate as getCashFlow / the bookkeeping
        // dashboards, so this chart cannot diverge from them.
        // B421: this comment's own promise didn't hold until now — a CREDIT_NOTE
        // application (never cash) had no method filter here either. Same
        // RECEIVED_METHOD_FILTER as getCashFlow's totalIn (B421, 8/N): excludes
        // only CREDIT_NOTE, keeps ADVANCE.
        ...CONFIRMED_PAYMENT,
        method: RECEIVED_METHOD_FILTER,
        paidAt: { gte: sixMonthsAgo },
      },
      select: { amount: true, paidAt: true },
    });

    // Get all expenses for this customer in the last 6 months
    const expenses = await this.prisma.forTenant().expense.findMany({
      where: {
        customerId,
        date: { gte: sixMonthsAgo },
        deletedAt: null,
      },
      select: { amount: true, date: true },
    });

    return months.map(({ month, start, end }) => {
      const income = payments
        .filter((p) => p.paidAt >= start && p.paidAt <= end)
        .reduce((sum, p) => sum + Number(p.amount), 0);

      const expense = expenses
        .filter((e) => e.date >= start && e.date <= end)
        .reduce((sum, e) => sum + Number(e.amount), 0);

      return {
        month,
        income: Math.round(income * 100) / 100,
        expenses: Math.round(expense * 100) / 100,
      };
    });
  }

  // ─── Export CSV ────────────────────────────────────────────────────────────

  async exportCustomers(query: ListCustomersDto): Promise<string> {
    const where = this.buildListWhere(query);

    const customers = await this.prisma.forTenant().customer.findMany({
      where,
      include: {
        user: { select: { status: true } },
        invoices: {
          where: { status: { notIn: ["PAID", "VOID", "WRITTEN_OFF"] } },
          select: { total: true, payments: { select: { amount: true, status: true } } },
        },
        advancePayments: {
          where: { balance: { gt: 0 } },
          select: { balance: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const escCsv = (val: string | null | undefined) => {
      if (!val) return "";
      if (val.includes(",") || val.includes('"') || val.includes("\n")) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };

    const header =
      "Business Name,Contact Name,Email,Phone,Customer Type,Status,Receivables,Credits";
    const rows = customers.map((c) => {
      const receivables = c.invoices.reduce((sum, inv) => {
        // Exclude VOID payments (a bounced check flips InvoicePayment.status to VOID
        // in P5-12) so a reversed payment no longer counts against the receivable.
        const paid = inv.payments
          .filter((p) => p.status !== "VOID")
          .reduce((s, p) => s + Number(p.amount), 0);
        return sum + (Number(inv.total) - paid);
      }, 0);
      const credits = c.advancePayments.reduce((s, a) => s + Number(a.balance), 0);

      return [
        escCsv(c.businessName),
        escCsv(c.contactName),
        escCsv(c.email),
        escCsv(c.phone),
        escCsv(c.customerType),
        escCsv(c.user?.status),
        receivables.toFixed(2),
        credits.toFixed(2),
      ].join(",");
    });

    return [header, ...rows].join("\n");
  }

  // ─── Merge Customers ──────────────────────────────────────────────────────

  /**
   * Effective strength of a regulated authorization, used to resolve a
   * per-category collision when merging two customers. Mirrors the guard's
   * lazy-expiry semantics: a VERIFIED row past its expiry is no stronger than an
   * EXPIRED one. Higher wins. An explicit REJECTED outranks a default NONE so a
   * deliberate denial is never silently replaced by "never asked".
   */
  private authRank(a: { status: string; expiresAt: Date | string | null }): number {
    const expired = a.expiresAt ? new Date(a.expiresAt).getTime() <= Date.now() : false;
    switch (a.status) {
      case "VERIFIED":
        return expired ? 2 : 4;
      case "PENDING_REVIEW":
        return 3;
      case "EXPIRED":
        return 2;
      case "REJECTED":
        return 1;
      default:
        return 0; // NONE
    }
  }

  /** True if the secondary authorization is strictly stronger than the primary's
   * (rank, then later expiry). Ties keep the primary — the surviving customer. */
  private authSecondaryWins(
    sec: { status: string; expiresAt: Date | string | null },
    pri: { status: string; expiresAt: Date | string | null },
  ): boolean {
    const rs = this.authRank(sec);
    const rp = this.authRank(pri);
    if (rs !== rp) return rs > rp;
    const es = sec.expiresAt ? new Date(sec.expiresAt).getTime() : -Infinity;
    const ep = pri.expiresAt ? new Date(pri.expiresAt).getTime() : -Infinity;
    return es > ep;
  }

  async mergeCustomers(primaryId: string, secondaryId: string) {
    if (primaryId === secondaryId) {
      throw new BadRequestException("Cannot merge a customer into itself");
    }

    const primary = await this.findCustomerOrThrow(primaryId);
    const secondary = await this.findCustomerOrThrow(secondaryId);
    // F2: a removed customer on either side must be restored before it can be merged —
    // merging financial records onto (or off of) a tombstoned row leaves them attached to
    // an identity that is mid-removal.
    if (primary.deletedAt || secondary.deletedAt) {
      throw new ConflictException("Restore the customer first");
    }

    try {
      return await this.prisma.tenantTransaction(
        async (tx) => {
          // Move invoices
          await tx.invoice.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });

          // Move orders
          await tx.order.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });

          // Move estimates
          await tx.estimate.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });

          // Move credit notes
          await tx.creditNote.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });

          // Move returns
          await tx.return.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });

          // Move advance payments
          await tx.advancePayment.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });

          // Move expenses
          await tx.expense.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });

          // Move transactions
          await tx.transaction.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });

          // Portal link, sales-agent bookkeeping, buyer-portal artifacts, and delivery
          // history must be RE-POINTED to the primary, never dropped (B101): these are
          // Restrict relations, so an unconditional delete/deleteMany here either
          // destroys history (RouteRunStop's POD photos/signatures) or crashes the
          // customer.delete below with a P2003.
          //
          // CustomerLink.customerId is unique — a primary that already has a link
          // cannot also receive the secondary's, so the secondary's (now-redundant)
          // link is dropped instead of re-pointed.
          const primaryLink = await tx.customerLink.findFirst({
            where: { customerId: primaryId },
          });
          if (primaryLink) {
            await tx.customerLink.deleteMany({ where: { customerId: secondaryId } });
          } else {
            await tx.customerLink.updateMany({
              where: { customerId: secondaryId },
              data: { customerId: primaryId },
            });
          }
          // Optional-chained: these five models postdate several older tests' fixtures
          // (see the ad-hoc attachment in customers.service.spec.ts) — a real Prisma tx
          // always has them, so this is a no-op only against those older test doubles.
          await tx.agentAssignment?.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });
          await tx.commissionAccrual?.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });
          await tx.customerCommissionRate?.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });
          await tx.buyerPaymentRequest?.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });
          await tx.customerDocument?.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });

          // Clean up secondary's own records before deleting
          await tx.contactPerson.deleteMany({ where: { customerId: secondaryId } });
          await tx.customerTagAssignment.deleteMany({ where: { customerId: secondaryId } });
          await tx.customerComment.deleteMany({ where: { customerId: secondaryId } });
          await tx.customerPrice.deleteMany({ where: { customerId: secondaryId } });
          await tx.customerAddress.deleteMany({ where: { customerId: secondaryId } });
          // POD photos/signatures live on RouteRunStop — re-point, never delete (B101).
          await tx.routeRunStop.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });
          await tx.routeCustomer.deleteMany({ where: { customerId: secondaryId } });
          // RouteStop must be re-pointed too, NOT deleted: the run stops re-pointed just
          // above still carry their original routeStopId, and
          // RouteRunStop_routeStopId_fkey is ON DELETE RESTRICT (0_init/migration.sql) —
          // deleting the parent stops here would raise a P2003 and roll the whole merge
          // back for exactly the customers with delivery history (B101). RouteStop has no
          // (routeId, customerId) uniqueness, so a re-point can never collide.
          await tx.routeStop.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });
          await tx.recurringInvoice.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });
          await tx.orderTemplate.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });

          // Regulated compliance: re-point the secondary's licenses/overrides to the
          // primary. Both CustomerAuthorization and AuthorizationOverride FK-cascade on
          // customer delete, so WITHOUT this the merge below would silently destroy the
          // secondary's regulated authorizations. CustomerAuthorization is unique per
          // (customerId, trackedCategoryId), so per-category collisions are resolved by
          // keeping the stronger authorization (see authSecondaryWins); the loser is
          // deleted so the re-point never trips the unique constraint.
          const [primaryAuths, secondaryAuths] = await Promise.all([
            tx.customerAuthorization.findMany({ where: { customerId: primaryId } }),
            tx.customerAuthorization.findMany({ where: { customerId: secondaryId } }),
          ]);
          const primaryAuthByCategory = new Map<string, (typeof primaryAuths)[number]>(
            primaryAuths.map((a) => [a.trackedCategoryId, a]),
          );
          for (const sec of secondaryAuths) {
            const pri = primaryAuthByCategory.get(sec.trackedCategoryId);
            if (!pri) {
              await tx.customerAuthorization.update({
                where: { id: sec.id },
                data: { customerId: primaryId },
              });
            } else if (this.authSecondaryWins(sec, pri)) {
              await tx.customerAuthorization.delete({ where: { id: pri.id } });
              await tx.customerAuthorization.update({
                where: { id: sec.id },
                data: { customerId: primaryId },
              });
            } else {
              await tx.customerAuthorization.delete({ where: { id: sec.id } });
            }
          }
          // Overrides carry no per-category uniqueness — move them all.
          await tx.authorizationOverride.updateMany({
            where: { customerId: secondaryId },
            data: { customerId: primaryId },
          });

          // Delete secondary customer and their user
          await tx.customer.delete({ where: { id: secondaryId } });
          await tx.user.delete({ where: { id: secondary.userId } });

          // Return the primary customer
          return tx.customer.findUnique({
            where: { id: primaryId },
            include: {
              user: { select: { id: true, email: true, username: true, status: true } },
              addresses: true,
              tagAssignments: { include: { tag: true } },
            },
          });
        },
        { timeout: 30_000 },
      );
    } catch (err: any) {
      // Any relation this method's re-point list doesn't yet know about still
      // Restricts the delete above — surface it as a named 409 instead of a raw
      // P2003 escaping as a 500 (B101c).
      if (err?.code === "P2003") {
        const relation = err?.meta?.field_name ?? err?.meta?.modelName ?? "a related record";
        throw new ConflictException(
          `Cannot merge customers: ${relation} still references the customer being merged away.`,
        );
      }
      throw err;
    }
  }

  // ─── Restore ───────────────────────────────────────────────────────────────

  /**
   * Restore a soft-deleted customer — the server side of the 8-second Undo
   * (unified/ux-standards.html). Clears `deletedAt` and reactivates the
   * customer's user account to `restoreStatus` (the caller passes the user's
   * pre-delete status so the undo restores exactly — e.g. a SUSPENDED customer
   * comes back SUSPENDED, not ACTIVE). Idempotent: restoring a live customer is
   * a no-op.
   *
   * `tenantId` is selected so `forTenant()`'s findUnique post-filter can reject
   * cross-tenant ids (returns null → NotFound), preventing a tenant-isolation
   * oracle.
   */
  async restoreCustomer(id: string, restoreStatus?: string, overrideUsername?: string) {
    const customer = await this.prisma.forTenant().customer.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        deletedAt: true,
        tenantId: true,
        email: true,
        user: { select: { username: true, status: true } },
      },
    });
    if (!customer) throw new NotFoundException("Customer not found");
    if (!customer.deletedAt) return { success: true, restored: false };

    // F4: an explicit restoreStatus (the 8-second Undo passes the user's pre-delete
    // status) always wins. Otherwise fall back to whatever status is already on the
    // User row — post-fix, the tombstone write no longer overwrites it to INACTIVE, so
    // that row already carries the right status. The INACTIVE fallback exists only for
    // a LEGACY pre-fix tombstone (which does carry INACTIVE): those must still restore
    // to ACTIVE, exactly as master did, rather than coming back permanently INACTIVE.
    const status =
      restoreStatus === "SUSPENDED" || restoreStatus === "ACTIVE"
        ? restoreStatus
        : customer.user.status === "INACTIVE"
          ? "ACTIVE"
          : customer.user.status;

    // REG-B159: reverse the soft-delete tombstone. A pre-fix removed row carries no
    // "~removed~<id8>" suffix — nothing to strip, its username was never touched. The real
    // email always lived on Customer.email (untouched by the delete), so restoring it here
    // is correct whether or not this row was ever tombstoned; a customer created with no
    // email gets a fresh placeholder, same as create() mints for one today.
    const tombstoneSuffix = `~removed~${id.slice(0, 8)}`;
    const currentUsername = customer.user.username;
    const restoredUsername =
      overrideUsername ||
      (currentUsername.endsWith(tombstoneSuffix)
        ? currentUsername.slice(0, -tombstoneSuffix.length)
        : currentUsername);
    const restoredEmail = customer.email ?? `no-email+${crypto.randomUUID()}@placeholder.local`;

    try {
      await this.prisma.tenantTransaction(async (tx) => {
        await tx.customer.update({ where: { id }, data: { deletedAt: null } });

        // F6: a live user may have since claimed this customer's real email (a fresh
        // signup, or another restore) while this one was removed. tx is already
        // tenant-scoped (prisma.service.ts _wrapTxWithTenant injects tenantId into every
        // findFirst), so this check never crosses tenants. Falling back to a placeholder
        // here — rather than letting the write hit the @@unique([tenantId, email])
        // constraint — keeps restore from failing outright over an email collision that
        // has nothing to do with the username the caller may be retrying with.
        let emailToRestore = restoredEmail;
        if (customer.email) {
          const emailHolder = await tx.user.findFirst({
            where: { email: customer.email, id: { not: customer.userId } },
          });
          if (emailHolder) {
            emailToRestore = `no-email+${crypto.randomUUID()}@placeholder.local`;
          }
        }

        await tx.user.update({
          where: { id: customer.userId },
          data: {
            status,
            deletedAt: null,
            username: restoredUsername,
            email: emailToRestore,
          },
        });
      });
    } catch (err: any) {
      // A newer customer claimed this username or (in the unlikely race the pre-check
      // above missed) email while the original was removed.
      if (err?.code !== "P2002") throw err;
      throw new ConflictException(
        "Another customer now uses this username or email — restore with a different username",
      );
    }
    return { success: true, restored: true };
  }

  // ─── Delete ────────────────────────────────────────────────────────────────

  /**
   * RF-197: Delete a customer safely.
   *
   * Without force: rejects with ConflictException if the customer has any
   * orders, invoices, or returns — financial records must never be silently
   * destroyed.
   *
   * With force=true (operator-only): performs a soft-delete (sets deletedAt)
   * instead of a hard delete, preserving all financial records with their
   * customer FK intact.  The customer user account is also deactivated
   * (status INACTIVE) rather than deleted.  This is the contract the web's
   * "Remove customer" + 8-second Undo relies on (useSoftDeleteCustomer always
   * sends force=true, and Undo calls POST /customers/:id/restore), so force
   * must keep meaning "reversible" for every HTTP caller.
   *
   * `opts.hardDeleteWhenRecordFree` narrows force to "waive the 409 only": a
   * customer with NO financial records is still hard-deleted. Internal callers
   * only — batchDelete() uses it so a record-holding customer soft-deletes
   * while a record-free one is genuinely removed (F02b/B130).
   *
   * Previously this method unconditionally cascade-deleted all related
   * financial data in a single transaction.
   */
  async deleteCustomer(
    id: string,
    force = false,
    opts: { hardDeleteWhenRecordFree?: boolean } = {},
  ) {
    const customer = await this.prisma.forTenant().customer.findUnique({
      where: { id },
      include: { user: { select: { status: true, username: true } } },
    });
    if (!customer) throw new NotFoundException("Customer not found");
    // F1: a second delete on an already-tombstoned customer must be a no-op. Without this,
    // the soft-delete branch below re-appends "~removed~<id8>" onto a username that already
    // carries the suffix (restoreCustomer only ever strips ONE), permanently mangling the
    // login identity on a repeat delete.
    if (customer.deletedAt) return { success: true, softDeleted: true };

    // Count financial records that would be orphaned by a hard delete. Deliberately
    // kind-agnostic (PR-1a review): a hard/soft customer delete counts and removes
    // every Return regardless of kind — there is no INLINE-specific record here to
    // miss (its CreditNote/OrderCreditNote rows are already covered by the credit
    // note cleanup below, same as a STANDARD return's).
    const [orderCount, invoiceCount, returnCount] = await Promise.all([
      this.prisma.forTenant().order.count({ where: { customerId: id } }),
      this.prisma.forTenant().invoice.count({ where: { customerId: id } }),
      this.prisma.forTenant().return.count({ where: { customerId: id } }),
    ]);

    const hasFinancialRecords = orderCount + invoiceCount + returnCount > 0;

    if (hasFinancialRecords && !force) {
      throw new ConflictException(
        `Cannot delete customer with existing financial records. ` +
          `Affected: ${orderCount} order(s), ${invoiceCount} invoice(s), ${returnCount} return(s). ` +
          `Use force=true to soft-delete the customer account while preserving all records.`,
      );
    }

    if (hasFinancialRecords || (force && !opts.hardDeleteWhenRecordFree)) {
      // Soft-delete: mark the customer and deactivate their user account.
      // All financial records are preserved with their customerId FK intact.
      // A forced delete stays reversible unless the caller explicitly opted into
      // hardDeleteWhenRecordFree (batchDelete) — the web's Undo depends on it.
      //
      // REG-B159: also release the User row's identity. tenantId-scoped @@unique
      // constraints on email/username/googleId (tenancy.prisma) stayed occupied by a
      // merely-deactivated row, so re-adding the same shop (or a CSV re-import) always
      // collided — the real email lives on Customer.email untouched, so nothing is lost;
      // the real username is deterministically recoverable as the prefix before
      // "~removed~". isInternalEmail already treats @placeholder.local as non-routable.
      await this.prisma.tenantTransaction(async (tx) => {
        await tx.customer.update({ where: { id }, data: { deletedAt: new Date() } });
        await tx.user.update({
          where: { id: customer.userId },
          data: {
            // F4: status is deliberately left untouched — login is already refused on
            // User.deletedAt (auth.service.ts:63, :272, :440), so overwriting status to
            // INACTIVE only threw away the pre-delete status restoreCustomer needs to
            // bring back exactly (a SUSPENDED customer must come back SUSPENDED).
            deletedAt: new Date(),
            username: `${customer.user.username}~removed~${id.slice(0, 8)}`,
            email: `removed+${id}@placeholder.local`,
            // F5: googleId is deliberately left untouched — restoreCustomer never restores
            // it, so nulling it here made restore lossy for no gain.
          },
        });
      });
      return { success: true, softDeleted: true };
    }

    // Hard-delete path (only reached when there are no financial records).
    // Delete all dependent non-financial records in correct order.
    await this.prisma.tenantTransaction(async (tx) => {
      // Payments on invoices
      const invoices = await tx.invoice.findMany({
        where: { customerId: id },
        select: { id: true },
      });
      const invoiceIds = invoices.map((i) => i.id);
      // DEFENSIVE, and deliberately not dead code: this path is only reached
      // when the pre-flight counted ZERO invoices, but that count is read
      // OUTSIDE this transaction, so an invoice created in between would be
      // destroyed here. Reversing keeps the file-wide invariant uniform —
      // every invoice destruction reverses its ledger entries first.
      for (const invoiceId of invoiceIds) {
        await this.ledger.reverseInvoiceEntries({ invoiceId, db: tx });
      }
      if (invoiceIds.length)
        await tx.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });

      // Invoice items
      if (invoiceIds.length)
        await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await tx.invoice.deleteMany({ where: { customerId: id } });

      // Credit notes — order↔credit-note links must be deleted BEFORE the notes
      // (OrderCreditNote.creditNoteId has no onDelete, so the FK restricts the parent delete)
      const creditNotes = await tx.creditNote.findMany({
        where: { customerId: id },
        select: { id: true },
      });
      if (creditNotes.length) {
        await tx.orderCreditNote.deleteMany({
          where: { creditNoteId: { in: creditNotes.map((n) => n.id) } },
        });
      }
      await tx.creditNote.deleteMany({ where: { customerId: id } });

      // Returns must be deleted BEFORE orders (Return has orderId FK on Order). Kind-agnostic
      // by design (PR-1a review) — removes every Return regardless of kind.
      const returns = await tx.return.findMany({ where: { customerId: id }, select: { id: true } });
      if (returns.length) {
        await tx.returnItem.deleteMany({ where: { returnId: { in: returns.map((r) => r.id) } } });
        await tx.return.deleteMany({ where: { customerId: id } });
      }

      // Orders and their items (must delete referencing records first)
      const orders = await tx.order.findMany({ where: { customerId: id }, select: { id: true } });
      if (orders.length) {
        const orderIds = orders.map((o) => o.id);
        // Delivery mutations reference orders and order items
        await tx.deliveryMutation.deleteMany({ where: { orderId: { in: orderIds } } });
        // Transactions and their items/payments reference orders
        const transactions = await tx.transaction.findMany({
          where: { orderId: { in: orderIds } },
          select: { id: true },
        });
        if (transactions.length) {
          const txIds = transactions.map((t) => t.id);
          await tx.payment.deleteMany({ where: { transactionId: { in: txIds } } });
          await tx.transactionItem.deleteMany({ where: { transactionId: { in: txIds } } });
          await tx.transaction.deleteMany({ where: { id: { in: txIds } } });
        }
        await tx.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.order.deleteMany({ where: { customerId: id } });
      }

      // Estimates
      const estimates = await tx.estimate.findMany({
        where: { customerId: id },
        select: { id: true },
      });
      if (estimates.length) {
        await tx.estimateItem.deleteMany({
          where: { estimateId: { in: estimates.map((e) => e.id) } },
        });
        await tx.estimate.deleteMany({ where: { customerId: id } });
      }

      // Recurring invoices
      const recurrings = await tx.recurringInvoice.findMany({
        where: { customerId: id },
        select: { id: true },
      });
      if (recurrings.length) {
        await tx.recurringInvoiceItem.deleteMany({
          where: { recurringInvoiceId: { in: recurrings.map((r) => r.id) } },
        });
        await tx.recurringInvoice.deleteMany({ where: { customerId: id } });
      }

      // Order templates
      const templates = await tx.orderTemplate.findMany({
        where: { customerId: id },
        select: { id: true },
      });
      if (templates.length) {
        await tx.orderTemplateItem.deleteMany({
          where: { templateId: { in: templates.map((t) => t.id) } },
        });
        await tx.orderTemplate.deleteMany({ where: { customerId: id } });
      }

      // Route associations (RouteRunStop references RouteStop, so delete run stops first)
      await tx.routeRunStop.deleteMany({ where: { customerId: id } });
      await tx.routeCustomer.deleteMany({ where: { customerId: id } });
      await tx.routeStop.deleteMany({ where: { customerId: id } });

      // Misc — Transactions that might still reference this customer directly (not via orders)
      const remainingTxns = await tx.transaction.findMany({
        where: { customerId: id },
        select: { id: true },
      });
      if (remainingTxns.length) {
        const txnIds = remainingTxns.map((t) => t.id);
        await tx.payment.deleteMany({ where: { transactionId: { in: txnIds } } });
        await tx.transactionItem.deleteMany({ where: { transactionId: { in: txnIds } } });
        await tx.transaction.deleteMany({ where: { customerId: id } });
      }
      await tx.advancePayment.deleteMany({ where: { customerId: id } });
      await tx.customerPrice.deleteMany({ where: { customerId: id } });
      await tx.customerAddress.deleteMany({ where: { customerId: id } });

      // Delete new related records
      await tx.contactPerson.deleteMany({ where: { customerId: id } });
      await tx.customerTagAssignment.deleteMany({ where: { customerId: id } });
      await tx.customerComment.deleteMany({ where: { customerId: id } });

      // Expenses
      await tx.expense.updateMany({ where: { customerId: id }, data: { customerId: null } });

      // Finally delete customer + user
      await tx.customer.delete({ where: { id } });
      await tx.user.delete({ where: { id: customer.userId } });
    });

    return { success: true };
  }

  /**
   * RF-080: Bulk customer delete.
   *
   * Before attempting any deletion the method checks every customer for PAID
   * or SENT invoices and returns a per-customer breakdown.  The entire batch
   * is blocked if any customer has such invoices — financial records from PAID
   * or SENT invoices must never be silently destroyed.
   *
   * Previously batchDelete() called deleteCustomer() in a plain loop without
   * checking invoice statuses, allowing bulk deletion to destroy PAID invoices.
   */
  async batchDelete(
    ids: string[],
  ): Promise<{ deleted: number; failed: { id: string; reason: string }[] }> {
    // Pre-flight: collect per-customer PAID/SENT invoice counts.
    const blockers = await this.prisma.forTenant().invoice.groupBy({
      by: ["customerId"],
      where: {
        customerId: { in: ids },
        status: { in: ["PAID", "SENT"] },
      },
      _count: { _all: true },
    });

    if (blockers.length > 0) {
      const breakdown = blockers.map((b) => `${b.customerId}: ${b._count._all} invoice(s)`);
      throw new ConflictException(
        `Bulk delete blocked — the following customers have PAID or SENT invoices that cannot be destroyed: ${breakdown.join("; ")}.`,
      );
    }

    const failed: { id: string; reason: string }[] = [];
    let deleted = 0;
    for (const id of ids) {
      try {
        // force=true: the pre-flight above already blocked the whole batch on any
        // PAID/SENT invoice, so a customer reaching here that still holds records
        // (orders, non-PAID/SENT invoices, returns) takes deleteCustomer's
        // soft-delete branch instead of 409-ing per-id into failed[] (B130).
        // hardDeleteWhenRecordFree keeps a record-free customer a real delete —
        // force alone means "reversible" for the HTTP callers, and this batch
        // path must not inherit that.
        await this.deleteCustomer(id, true, { hardDeleteWhenRecordFree: true });
        deleted++;
      } catch (e: any) {
        failed.push({ id, reason: e?.message ?? "unknown" });
      }
    }
    return { deleted, failed };
  }

  async deleteAllCustomers(): Promise<{ deleted: number }> {
    // R2 — refuse a null tenant. forTenant() returns the UNSCOPED client and
    // tenantTransaction hands back the raw tx when there is no tenant context
    // (prisma.service.ts `if (!tenantId) return this` / `return fn(rawTx)`), so on a
    // SUPER_ADMIN token every query below — the listing, the pre-flight groupBy and
    // the wipe itself — would span EVERY tenant. A destructive bulk delete has no
    // legitimate all-tenant mode; refuse, exactly as the financial-data wipe does.
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) {
      throw new ForbiddenException(
        "Deleting all customers requires a tenant context; it cannot be run across tenants.",
      );
    }

    const customers = await this.prisma
      .forTenant()
      .customer.findMany({ select: { id: true, userId: true } });
    if (customers.length === 0) return { deleted: 0 };

    const customerIds = customers.map((c) => c.id);
    const userIds = customers.map((c) => c.userId);

    // Pre-flight: collect per-customer PAID/SENT invoice counts. Mirrors
    // batchDelete()'s pre-flight above — financial records from PAID or SENT
    // invoices must never be silently destroyed, including by a full wipe.
    const blockers = await this.prisma.forTenant().invoice.groupBy({
      by: ["customerId"],
      where: {
        customerId: { in: customerIds },
        status: { in: ["PAID", "SENT"] },
      },
      _count: { _all: true },
    });

    if (blockers.length > 0) {
      // batchDelete() enumerates every blocker because its `ids` are a bounded UI
      // selection; here they are every customer in the tenant, so cap the list —
      // a 409 body listing thousands of opaque uuids is unreadable, not actionable.
      const breakdown = blockers
        .slice(0, MAX_LISTED_BLOCKERS)
        .map((b) => `${b.customerId}: ${b._count._all} invoice(s)`);
      if (blockers.length > MAX_LISTED_BLOCKERS) {
        breakdown.push(`and ${blockers.length - MAX_LISTED_BLOCKERS} more`);
      }
      throw new ConflictException(
        `Bulk delete blocked — the following customers have PAID or SENT invoices that cannot be destroyed: ${breakdown.join("; ")}.`,
      );
    }

    await this.prisma.tenantTransaction(
      async (tx) => {
        const invoices = await tx.invoice.findMany({
          where: { customerId: { in: customerIds } },
          select: { id: true },
        });
        const invoiceIds = invoices.map((i) => i.id);
        if (invoiceIds.length) {
          // Reverse each invoice's regulated-sales ledger rows BEFORE its items
          // are removed. The ledger keeps its own snapshot and has no FK to
          // Invoice, so an invoice destroyed without this leaves entries that
          // permanently overstate regulated sales and excise. Same ordering and
          // shape as invoices.service deleteInvoice. NOTE: a DRAFT invoice DOES
          // carry ledger rows — createSplitInvoices writes them at creation,
          // before the DRAFT is ever sent — so filtering by status here would
          // reintroduce the leak.
          for (const invoiceId of invoiceIds) {
            await this.ledger.reverseInvoiceEntries({ invoiceId, db: tx });
          }
          await tx.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
          await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
        }
        await tx.invoice.deleteMany({ where: { customerId: { in: customerIds } } });

        // Order↔credit-note links must be deleted BEFORE the credit notes
        // (OrderCreditNote.creditNoteId has no onDelete, so the FK restricts the parent delete)
        const creditNotes = await tx.creditNote.findMany({
          where: { customerId: { in: customerIds } },
          select: { id: true },
        });
        if (creditNotes.length) {
          await tx.orderCreditNote.deleteMany({
            where: { creditNoteId: { in: creditNotes.map((n) => n.id) } },
          });
        }
        await tx.creditNote.deleteMany({ where: { customerId: { in: customerIds } } });

        // Returns must be deleted BEFORE orders (Return has orderId FK on Order). Kind-agnostic
        // by design (PR-1a review) — removes every Return regardless of kind.
        const returns = await tx.return.findMany({
          where: { customerId: { in: customerIds } },
          select: { id: true },
        });
        if (returns.length) {
          await tx.returnItem.deleteMany({ where: { returnId: { in: returns.map((r) => r.id) } } });
          await tx.return.deleteMany({ where: { customerId: { in: customerIds } } });
        }

        const orders = await tx.order.findMany({
          where: { customerId: { in: customerIds } },
          select: { id: true },
        });
        if (orders.length) {
          const orderIds = orders.map((o) => o.id);
          await tx.deliveryMutation.deleteMany({ where: { orderId: { in: orderIds } } });
          const txns = await tx.transaction.findMany({
            where: { orderId: { in: orderIds } },
            select: { id: true },
          });
          if (txns.length) {
            const txnIds = txns.map((t) => t.id);
            await tx.payment.deleteMany({ where: { transactionId: { in: txnIds } } });
            await tx.transactionItem.deleteMany({ where: { transactionId: { in: txnIds } } });
            await tx.transaction.deleteMany({ where: { id: { in: txnIds } } });
          }
          await tx.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
          await tx.order.deleteMany({ where: { customerId: { in: customerIds } } });
        }

        const estimates = await tx.estimate.findMany({
          where: { customerId: { in: customerIds } },
          select: { id: true },
        });
        if (estimates.length) {
          await tx.estimateItem.deleteMany({
            where: { estimateId: { in: estimates.map((e) => e.id) } },
          });
          await tx.estimate.deleteMany({ where: { customerId: { in: customerIds } } });
        }

        const recurrings = await tx.recurringInvoice.findMany({
          where: { customerId: { in: customerIds } },
          select: { id: true },
        });
        if (recurrings.length) {
          await tx.recurringInvoiceItem.deleteMany({
            where: { recurringInvoiceId: { in: recurrings.map((r) => r.id) } },
          });
          await tx.recurringInvoice.deleteMany({ where: { customerId: { in: customerIds } } });
        }

        const templates = await tx.orderTemplate.findMany({
          where: { customerId: { in: customerIds } },
          select: { id: true },
        });
        if (templates.length) {
          await tx.orderTemplateItem.deleteMany({
            where: { templateId: { in: templates.map((t) => t.id) } },
          });
          await tx.orderTemplate.deleteMany({ where: { customerId: { in: customerIds } } });
        }

        await tx.routeRunStop.deleteMany({ where: { customerId: { in: customerIds } } });
        await tx.routeCustomer.deleteMany({ where: { customerId: { in: customerIds } } });
        await tx.routeStop.deleteMany({ where: { customerId: { in: customerIds } } });
        await tx.routeRunStop.deleteMany({ where: { customerId: { in: customerIds } } });
        await tx.transaction.deleteMany({ where: { customerId: { in: customerIds } } });
        await tx.advancePayment.deleteMany({ where: { customerId: { in: customerIds } } });
        await tx.customerPrice.deleteMany({ where: { customerId: { in: customerIds } } });
        await tx.customerAddress.deleteMany({ where: { customerId: { in: customerIds } } });

        // Delete new related records
        await tx.contactPerson.deleteMany({ where: { customerId: { in: customerIds } } });
        await tx.customerTagAssignment.deleteMany({ where: { customerId: { in: customerIds } } });
        await tx.customerComment.deleteMany({ where: { customerId: { in: customerIds } } });

        // Expenses — detach rather than delete
        await tx.expense.updateMany({
          where: { customerId: { in: customerIds } },
          data: { customerId: null },
        });

        await tx.customer.deleteMany({ where: { id: { in: customerIds } } });
        await tx.user.deleteMany({ where: { id: { in: userIds } } });
      },
      { timeout: 60_000 },
    );

    return { deleted: customers.length };
  }

  // ─── Cleanup Imported Customers ───────────────────────────────────────────────

  async previewImportedCleanup(): Promise<{
    toDelete: number;
    toKeep: number;
    buyers: { id: string; businessName: string }[];
  }> {
    const all = await this.prisma.forTenant().customer.findMany({
      select: {
        id: true,
        businessName: true,
        customerLink: { select: { status: true } },
      },
    });
    const buyers = all.filter((c) => c.customerLink?.status === "ACTIVE");
    const toDelete = all.filter((c) => c.customerLink?.status !== "ACTIVE");
    return {
      toDelete: toDelete.length,
      toKeep: buyers.length,
      buyers: buyers.map((b) => ({ id: b.id, businessName: b.businessName })),
    };
  }

  async deleteImportedCustomers(): Promise<{ deleted: number; preserved: number }> {
    const all = await this.prisma.forTenant().customer.findMany({
      select: {
        id: true,
        userId: true,
        customerLink: { select: { status: true } },
      },
    });

    const toDelete = all.filter((c) => c.customerLink?.status !== "ACTIVE");
    const preserved = all.length - toDelete.length;
    if (toDelete.length === 0) return { deleted: 0, preserved };

    const ids = toDelete.map((c) => c.id);
    const uids = toDelete.map((c) => c.userId);

    await this.prisma.tenantTransaction(
      async (tx) => {
        // Invoices
        const invoices = await tx.invoice.findMany({
          where: { customerId: { in: ids } },
          select: { id: true },
        });
        const invoiceIds = invoices.map((i) => i.id);
        if (invoiceIds.length) {
          // Reverse each invoice's regulated-sales ledger rows BEFORE its items
          // are removed. The ledger keeps its own snapshot and has no FK to
          // Invoice, so an invoice destroyed without this leaves entries that
          // permanently overstate regulated sales and excise. Same ordering and
          // shape as invoices.service deleteInvoice. NOTE: a DRAFT invoice DOES
          // carry ledger rows — createSplitInvoices writes them at creation,
          // before the DRAFT is ever sent — so filtering by status here would
          // reintroduce the leak.
          for (const invoiceId of invoiceIds) {
            await this.ledger.reverseInvoiceEntries({ invoiceId, db: tx });
          }
          await tx.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
          await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
        }
        await tx.invoice.deleteMany({ where: { customerId: { in: ids } } });

        // Credit notes — order↔credit-note links must be deleted BEFORE the notes
        // (OrderCreditNote.creditNoteId has no onDelete, so the FK restricts the parent delete)
        const creditNotes = await tx.creditNote.findMany({
          where: { customerId: { in: ids } },
          select: { id: true },
        });
        if (creditNotes.length) {
          await tx.orderCreditNote.deleteMany({
            where: { creditNoteId: { in: creditNotes.map((n) => n.id) } },
          });
        }
        await tx.creditNote.deleteMany({ where: { customerId: { in: ids } } });

        // Returns (must precede orders due to FK). Kind-agnostic by design (PR-1a
        // review) — removes every Return regardless of kind.
        const returns = await tx.return.findMany({
          where: { customerId: { in: ids } },
          select: { id: true },
        });
        if (returns.length) {
          await tx.returnItem.deleteMany({ where: { returnId: { in: returns.map((r) => r.id) } } });
          await tx.return.deleteMany({ where: { customerId: { in: ids } } });
        }

        // Orders
        const orders = await tx.order.findMany({
          where: { customerId: { in: ids } },
          select: { id: true },
        });
        if (orders.length) {
          const orderIds = orders.map((o) => o.id);
          await tx.deliveryMutation.deleteMany({ where: { orderId: { in: orderIds } } });
          const txns = await tx.transaction.findMany({
            where: { orderId: { in: orderIds } },
            select: { id: true },
          });
          if (txns.length) {
            const txnIds = txns.map((t) => t.id);
            await tx.payment.deleteMany({ where: { transactionId: { in: txnIds } } });
            await tx.transactionItem.deleteMany({ where: { transactionId: { in: txnIds } } });
            await tx.transaction.deleteMany({ where: { id: { in: txnIds } } });
          }
          await tx.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
          await tx.order.deleteMany({ where: { customerId: { in: ids } } });
        }

        // Estimates
        const estimates = await tx.estimate.findMany({
          where: { customerId: { in: ids } },
          select: { id: true },
        });
        if (estimates.length) {
          await tx.estimateItem.deleteMany({
            where: { estimateId: { in: estimates.map((e) => e.id) } },
          });
          await tx.estimate.deleteMany({ where: { customerId: { in: ids } } });
        }

        // Recurring invoices
        const recurrings = await tx.recurringInvoice.findMany({
          where: { customerId: { in: ids } },
          select: { id: true },
        });
        if (recurrings.length) {
          await tx.recurringInvoiceItem.deleteMany({
            where: { recurringInvoiceId: { in: recurrings.map((r) => r.id) } },
          });
          await tx.recurringInvoice.deleteMany({ where: { customerId: { in: ids } } });
        }

        // Order templates
        const templates = await tx.orderTemplate.findMany({
          where: { customerId: { in: ids } },
          select: { id: true },
        });
        if (templates.length) {
          await tx.orderTemplateItem.deleteMany({
            where: { templateId: { in: templates.map((t) => t.id) } },
          });
          await tx.orderTemplate.deleteMany({ where: { customerId: { in: ids } } });
        }

        // Route associations
        await tx.routeRunStop.deleteMany({ where: { customerId: { in: ids } } });
        await tx.routeCustomer.deleteMany({ where: { customerId: { in: ids } } });
        await tx.routeStop.deleteMany({ where: { customerId: { in: ids } } });

        // Remaining transactions
        const remainingTxns = await tx.transaction.findMany({
          where: { customerId: { in: ids } },
          select: { id: true },
        });
        if (remainingTxns.length) {
          const txnIds = remainingTxns.map((t) => t.id);
          await tx.payment.deleteMany({ where: { transactionId: { in: txnIds } } });
          await tx.transactionItem.deleteMany({ where: { transactionId: { in: txnIds } } });
          await tx.transaction.deleteMany({ where: { customerId: { in: ids } } });
        }
        await tx.advancePayment.deleteMany({ where: { customerId: { in: ids } } });
        await tx.customerPrice.deleteMany({ where: { customerId: { in: ids } } });
        await tx.customerAddress.deleteMany({ where: { customerId: { in: ids } } });
        await tx.contactPerson.deleteMany({ where: { customerId: { in: ids } } });
        await tx.customerTagAssignment.deleteMany({ where: { customerId: { in: ids } } });
        await tx.customerComment.deleteMany({ where: { customerId: { in: ids } } });

        // Expenses — detach rather than delete
        await tx.expense.updateMany({
          where: { customerId: { in: ids } },
          data: { customerId: null },
        });

        // CustomerLink records (FK constraint — must delete before customer rows)
        await tx.customerLink.deleteMany({ where: { customerId: { in: ids } } });

        // Finally delete customer + user rows
        await tx.customer.deleteMany({ where: { id: { in: ids } } });
        await tx.user.deleteMany({ where: { id: { in: uids } } });
      },
      { timeout: 120_000 },
    );

    return { deleted: toDelete.length, preserved };
  }

  // ─── Buyer Portal Management ──────────────────────────────────────────────────
  // Direct Prisma queries — no BuyerModule dependency to avoid circular imports

  async sendPortalInvite(
    customerId: string,
    dto: { method: "EMAIL" | "SMS"; overrideEmail?: string },
    tenantId: string,
  ) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId },
      include: { user: { select: { email: true } } },
    });
    if (!customer) throw new NotFoundException("Customer not found");

    // Use override email first, then customer's own email, then User's login email.
    // Ignore internal placeholders minted for emailless customers (@placeholder.local).
    const loginEmail = customer.user?.email?.endsWith("@placeholder.local")
      ? null
      : customer.user?.email;
    const toEmail = dto.overrideEmail ?? customer.email ?? loginEmail ?? null;
    if (!toEmail) {
      throw new BadRequestException(
        "Customer has no email address. Add an email or provide an override.",
      );
    }

    const cryptoModule = await import("crypto");
    const token = cryptoModule.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await this.prisma.customerLink.upsert({
      where: { customerId },
      create: {
        customerId,
        tenantId,
        buyerAccountId: null,
        status: "INVITED",
        inviteToken: token,
        inviteExpiresAt: expiresAt,
        inviteMethod: dto.method as any,
      },
      update: {
        buyerAccountId: null,
        status: "INVITED",
        inviteToken: token,
        inviteExpiresAt: expiresAt,
        inviteMethod: dto.method as any,
        disconnectedAt: null,
        disconnectedBy: null,
        linkedAt: null,
      },
    });

    const tenantCfg = await this.prisma.tenantConfig.findFirst({
      where: { tenantId },
      select: { businessName: true },
    });
    const sellerName = tenantCfg?.businessName ?? "Your supplier";
    const webUrl = this.config.get<string>("WEB_URL") ?? "http://localhost:3001";
    const inviteUrl = `${webUrl}/buyer/invite/${token}`;

    this.logger.log(
      `Portal invite for customer ${customerId} → ${toEmail} | token ${token.slice(0, 8)}...`,
    );

    // Email sending is best-effort — if no email transport, it logs only
    // Import EmailService lazily to avoid circular module issue
    return {
      message: `Invite prepared for ${toEmail}. ${sellerName} can share: ${inviteUrl}`,
      inviteUrl,
      expiresAt,
    };
  }

  async resendPortalInvite(customerId: string, tenantId: string) {
    const link = await this.prisma.customerLink.findFirst({ where: { customerId, tenantId } });
    if (!link) throw new NotFoundException("No invite found for this customer");
    if (link.status === "ACTIVE") {
      throw new BadRequestException("Customer is already connected to the buyer portal");
    }
    return this.sendPortalInvite(
      customerId,
      { method: (link.inviteMethod as any) ?? "EMAIL" },
      tenantId,
    );
  }

  async disconnectPortal(customerId: string, tenantId: string) {
    const link = await this.prisma.customerLink.findFirst({ where: { customerId, tenantId } });
    if (!link || link.status === "DISCONNECTED") {
      return { message: "Customer is not connected to the buyer portal" };
    }
    await this.prisma.customerLink.update({
      where: { id: link.id },
      data: {
        status: "DISCONNECTED",
        disconnectedBy: "SELLER",
        disconnectedAt: new Date(),
        // Disconnecting revokes the link (this button also cancels an outstanding INVITED
        // invite) — burn the token with it so it can never be redeemed, or revived by a
        // later buyer connect request flipping the row to PENDING_SELLER_APPROVAL.
        inviteToken: null,
        inviteExpiresAt: null,
      },
    });
    return { message: "Customer disconnected from buyer portal. All business data preserved." };
  }

  async getPortalStatus(customerId: string, tenantId: string) {
    const link = await this.prisma.customerLink.findFirst({
      where: { customerId, tenantId },
      include: { buyerAccount: { select: { id: true, email: true, name: true } } },
    });
    if (!link) return { status: "NOT_INVITED" };
    const isPending = link.status === "PENDING_SELLER_APPROVAL";
    return {
      status: link.status,
      inviteMethod: link.inviteMethod,
      inviteExpiresAt: link.inviteExpiresAt,
      linkedAt: link.linkedAt,
      disconnectedAt: link.disconnectedAt,
      disconnectedBy: link.disconnectedBy,
      buyerAccount: link.status === "ACTIVE" ? link.buyerAccount : null,
      // Additive: who is asking, so the Buyer Portal card can say WHO wants to connect
      // while the request is pending (buyerAccount above stays gated to ACTIVE only).
      buyerName: isPending ? (link.buyerAccount?.name ?? null) : null,
      buyerEmail: isPending ? (link.buyerAccount?.email ?? null) : null,
    };
  }

  async approveBuyerRequest(customerId: string, tenantId: string) {
    const link = await this.prisma.customerLink.findFirst({ where: { customerId, tenantId } });
    if (!link) throw new NotFoundException("No pending buyer request found");
    if (link.status !== "PENDING_SELLER_APPROVAL") {
      throw new ConflictException("This request is no longer pending");
    }
    await this.prisma.customerLink.update({
      where: { id: link.id },
      // Approving consumes the customer's single link slot — any invite token the pending
      // row inherited from an INVITED invite is spent and must not outlive the approval.
      data: { status: "ACTIVE", linkedAt: new Date(), inviteToken: null, inviteExpiresAt: null },
    });
    return { message: "Buyer connection approved" };
  }

  async declineBuyerRequest(customerId: string, tenantId: string) {
    const link = await this.prisma.customerLink.findFirst({ where: { customerId, tenantId } });
    if (!link) throw new NotFoundException("No pending buyer request found");
    if (link.status !== "PENDING_SELLER_APPROVAL") {
      throw new ConflictException("This request is no longer pending");
    }
    // A row that still carries a LIVE invite token was an INVITED link a buyer requested
    // against (the request preserves inviteToken/inviteExpiresAt so the true invitee's
    // emailed link keeps working). Deleting it would destroy an invite the seller already
    // sent — revert it to INVITED and drop the requester instead. An expired token is
    // worthless, so those rows fall through to the delete and free the slot.
    const inviteStillLive =
      !!link.inviteToken && (!link.inviteExpiresAt || link.inviteExpiresAt > new Date());
    if (inviteStillLive) {
      await this.prisma.customerLink.update({
        where: { id: link.id },
        data: { status: "INVITED", buyerAccountId: null },
      });
      return { declined: true };
    }
    // customerId is @unique on CustomerLink — one link row per customer, ever. A declined
    // stranger must not permanently occupy that one slot (it would block a future legitimate
    // invite), so decline DELETES the row rather than marking it DISCONNECTED. DISCONNECTED
    // stays reserved for severing a previously ACTIVE link. A re-request simply creates a
    // fresh pending row the seller can decline again.
    await this.prisma.customerLink.delete({ where: { id: link.id } });
    return { declined: true };
  }

  async listPendingPortalApprovals(tenantId: string) {
    const links = await this.prisma.customerLink.findMany({
      where: { tenantId, status: "PENDING_SELLER_APPROVAL" },
      include: {
        customer: {
          select: { id: true, businessName: true, contactName: true, email: true },
        },
        buyerAccount: {
          select: { id: true, email: true, name: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    // Additive: flatten the requesting buyer's identity onto each row so consumers (the
    // web bell's pinned "Action needed" list) don't need to reach into nested relations.
    return links.map((link) => ({
      ...link,
      customerName: link.customer?.businessName || link.customer?.contactName || "Unknown customer",
      buyerName: link.buyerAccount?.name ?? null,
      buyerEmail: link.buyerAccount?.email ?? null,
      requestedAt: link.updatedAt,
    }));
  }

  // ─── Suggest buyer account merge (tenant-initiated) ───────────────────────────

  async suggestMerge(
    tenantId: string,
    primaryCustomerId: string,
    secondaryCustomerId: string,
    notes?: string,
  ) {
    if (primaryCustomerId === secondaryCustomerId) {
      throw new BadRequestException("Cannot merge a customer with itself");
    }

    const [primaryLink, secondaryLink] = await Promise.all([
      this.prisma.customerLink.findFirst({
        where: { customerId: primaryCustomerId, tenantId },
        include: { customer: { select: { businessName: true } } },
      }),
      this.prisma.customerLink.findFirst({
        where: { customerId: secondaryCustomerId, tenantId },
        include: { customer: { select: { businessName: true } } },
      }),
    ]);

    if (!primaryLink?.buyerAccountId) {
      const name = primaryLink?.customer?.businessName ?? primaryCustomerId;
      throw new UnprocessableEntityException(
        `Customer "${name}" is not connected to a buyer portal account`,
      );
    }
    if (!secondaryLink?.buyerAccountId) {
      const name = secondaryLink?.customer?.businessName ?? secondaryCustomerId;
      throw new UnprocessableEntityException(
        `Customer "${name}" is not connected to a buyer portal account`,
      );
    }
    if (primaryLink.buyerAccountId === secondaryLink.buyerAccountId) {
      throw new ConflictException("Both customers are already linked to the same buyer account");
    }

    const existing = await this.prisma.buyerMergeRequest.findFirst({
      where: {
        primaryAccountId: primaryLink.buyerAccountId,
        secondaryAccountId: secondaryLink.buyerAccountId,
        status: {
          in: [
            BuyerMergeRequestStatus.PENDING_VERIFICATION,
            BuyerMergeRequestStatus.PENDING_REVIEW,
          ],
        },
      },
    });
    if (existing) {
      throw new ConflictException("An open merge request between these accounts already exists");
    }

    const mergeRequest = await this.prisma.buyerMergeRequest.create({
      data: {
        primaryAccountId: primaryLink.buyerAccountId,
        secondaryAccountId: secondaryLink.buyerAccountId,
        status: BuyerMergeRequestStatus.PENDING_REVIEW,
        initiatedBy: MergeInitiator.TENANT,
        initiatedByTenantId: tenantId,
        initiatorNotes: notes,
      },
    });

    return {
      id: mergeRequest.id,
      status: mergeRequest.status,
      message: "Merge suggestion submitted for platform admin review.",
    };
  }

  // ── Tax-exempt document upload ───────────────────────────────────────────────

  async uploadTaxDocument(id: string, buffer: Buffer, originalName: string, mimetype: string) {
    const customer = await this.prisma.forTenant().customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException("Customer not found");

    const compressed = await compressDocument(buffer, mimetype);
    const key = `customers/${id}/tax-documents/${crypto.randomUUID()}.${compressed.ext}`;
    await this.storage.upload(key, compressed.buffer, compressed.mimeType);

    await this.prisma.forTenant().customer.update({
      where: { id },
      data: { taxExemptDocumentKeys: { push: key } },
    });

    const url = await this.storage.presignedUrl(key);
    return { key, url };
  }

  async deleteTaxDocument(id: string, key: string): Promise<void> {
    const customer = await this.prisma.forTenant().customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException("Customer not found");
    if (!(customer as any).taxExemptDocumentKeys?.includes(key)) {
      throw new NotFoundException("Document not found on this customer");
    }
    await this.storage.delete(key);
    await this.prisma.forTenant().customer.update({
      where: { id },
      data: {
        taxExemptDocumentKeys: {
          set: (customer as any).taxExemptDocumentKeys.filter((k: string) => k !== key),
        },
      },
    });
  }

  async getTaxDocumentUrls(id: string): Promise<{ key: string; url: string }[]> {
    const customer = await this.prisma.forTenant().customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException("Customer not found");
    const keys: string[] = (customer as any).taxExemptDocumentKeys ?? [];
    return Promise.all(
      keys.map(async (key) => ({ key, url: await this.storage.presignedUrl(key) })),
    );
  }

  // ── Generic customer documents ──────────────────────────────────────────────

  async uploadCustomerDocument(
    id: string,
    buffer: Buffer,
    originalName: string,
    mimetype: string,
    docType: string,
    uploadedById?: string,
  ) {
    const customer = await this.prisma.forTenant().customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException("Customer not found");

    const compressed = await compressDocument(buffer, mimetype);
    const key = `customers/${id}/documents/${crypto.randomUUID()}.${compressed.ext}`;
    await this.storage.upload(key, compressed.buffer, compressed.mimeType);

    const doc = await this.prisma.forTenant().customerDocument.create({
      data: {
        customerId: id,
        storageKey: key,
        originalName,
        mimeType: compressed.mimeType,
        sizeBytes: compressed.buffer.length,
        docType,
        uploadedById: uploadedById ?? null,
      },
    });

    const url = await this.storage.presignedUrl(key);
    return {
      id: doc.id,
      docType: doc.docType,
      originalName: doc.originalName,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      createdAt: doc.createdAt,
      url,
    };
  }

  async listCustomerDocuments(id: string) {
    const customer = await this.prisma.forTenant().customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException("Customer not found");
    const docs = await this.prisma.forTenant().customerDocument.findMany({
      where: { customerId: id },
      orderBy: { createdAt: "desc" },
    });
    return Promise.all(
      docs.map(async (d) => ({
        id: d.id,
        docType: d.docType,
        originalName: d.originalName,
        mimeType: d.mimeType,
        sizeBytes: d.sizeBytes,
        createdAt: d.createdAt,
        url: await this.storage.presignedUrl(d.storageKey),
      })),
    );
  }

  async deleteCustomerDocument(customerId: string, docId: string): Promise<void> {
    const doc = await this.prisma.forTenant().customerDocument.findFirst({
      where: { id: docId, customerId },
    });
    if (!doc) throw new NotFoundException("Document not found");
    await this.storage.delete(doc.storageKey).catch(() => {});
    await this.prisma.forTenant().customerDocument.delete({ where: { id: docId } });
  }
}
