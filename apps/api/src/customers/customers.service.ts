import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  UnprocessableEntityException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { BuyerMergeRequestStatus, MergeInitiator } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service";
import { roundMoney } from "../common/pricing";
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

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
  ) {}

  /** Geocode an address string using Google Maps API. Returns null if key missing or call fails. */
  private async geocodeAddress(addr: {
    line1: string;
    city: string;
    state: string;
    zip: string;
  }): Promise<{ lat: number; lng: number } | null> {
    const key = this.config.get<string>("googleMaps.apiKey") ?? "";
    if (!key) return null;
    const q = encodeURIComponent(`${addr.line1}, ${addr.city}, ${addr.state} ${addr.zip}`);
    try {
      const res = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${q}&key=${key}`,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        results: Array<{ geometry: { location: { lat: number; lng: number } } }>;
      };
      const loc = data.results?.[0]?.geometry?.location;
      return loc ? { lat: loc.lat, lng: loc.lng } : null;
    } catch (err) {
      this.logger.warn("Geocoding failed", err);
      return null;
    }
  }

  /** Geocode all CustomerAddress records that are missing lat/lng. Returns counts. */
  async geocodeAllAddresses(): Promise<{ total: number; geocoded: number; failed: number }> {
    const addresses = await this.prisma.forTenant().customerAddress.findMany({
      where: { OR: [{ lat: null }, { lng: null }] },
    });
    let geocoded = 0;
    let failed = 0;
    for (const addr of addresses) {
      const coords = await this.geocodeAddress(addr);
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

  async findAll(query: ListCustomersDto) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 20);
    const skip = (page - 1) * limit;

    const where: any = {
      // Exclude supplier-only contacts (vendors imported from expense CSVs that have no orders)
      supplierOnly: false,
      // Exclude soft-deleted customers (RF-197)
      deletedAt: null,
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
    const orderBy: any = orderField ? { [orderField]: dir } : { createdAt: "desc" };

    const [data, total] = await Promise.all([
      this.prisma.forTenant().customer.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, username: true, status: true } },
          addresses: true,
          tagAssignments: { include: { tag: true } },
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

    const [invoices, creditNotes] = await Promise.all([
      this.prisma.forTenant().invoice.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          invoiceNumber: true,
          total: true,
          status: true,
          dueDate: true,
          createdAt: true,
          payments: { select: { amount: true, status: true } },
        },
      }),
      this.prisma.forTenant().creditNote.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          creditNoteNumber: true,
          amount: true,
          status: true,
          createdAt: true,
          amountUsed: true,
          expiresAt: true,
        },
      }),
    ]);

    const invoicesWithPaid = invoices.map((i) => ({
      ...i,
      // VOID payments (e.g. a bounced check reversed in P5-12) must not count as paid.
      amountPaid: i.payments
        .filter((p) => p.status !== "VOID")
        .reduce((sum, p) => sum + Number(p.amount), 0),
    }));

    const outstanding = invoicesWithPaid
      .filter((i) => i.status !== "PAID" && i.status !== "VOID")
      .reduce((sum, i) => sum + (Number(i.total) - i.amountPaid), 0);

    const overdue = invoicesWithPaid
      .filter(
        (i) =>
          i.status !== "PAID" &&
          i.status !== "VOID" &&
          i.dueDate &&
          new Date(i.dueDate) < new Date(),
      )
      .reduce((sum, i) => sum + (Number(i.total) - i.amountPaid), 0);

    // P5-13: wallet = Σ remaining over OPEN, non-expired credits. amount − amountUsed
    // (not face amount) prevents the double-count — a partial credit already sits on
    // the invoice as a CREDIT_NOTE payment, so only its unused remainder appears here.
    const now = new Date();
    const availableCredit = roundMoney(
      creditNotes
        .filter(
          (c) =>
            c.status !== "VOID" &&
            Number(c.amount) - Number(c.amountUsed) > 0.001 &&
            (!c.expiresAt || new Date(c.expiresAt) > now),
        )
        .reduce((sum, c) => sum + roundMoney(Number(c.amount) - Number(c.amountUsed)), 0),
    );

    const transactions = [
      ...invoicesWithPaid.map((i) => ({
        type: "INVOICE" as const,
        id: i.id,
        description: `Invoice #${i.invoiceNumber}`,
        date: i.createdAt.toISOString(),
        amount: Number(i.total),
        runningBalance: -(Number(i.total) - i.amountPaid),
        status: i.status,
      })),
      ...creditNotes.map((c) => {
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

    return this.prisma.tenantTransaction(async (tx) => {
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
        },
      });

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
  }

  async update(id: string, dto: UpdateCustomerDto) {
    await this.findCustomerOrThrow(id);
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
      },
    });
  }

  async changeStatus(id: string, dto: ChangeCustomerStatusDto) {
    const customer = await this.findCustomerOrThrow(id);
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
    const coords = await this.geocodeAddress(dto);
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
    this.geocodeAddress(updated)
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

    const [invoices, creditNotes, advancePayments, pendingOrders] = await Promise.all([
      this.prisma.forTenant().invoice.findMany({
        where: { customerId },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          invoiceNumber: true,
          total: true,
          status: true,
          dueDate: true,
          createdAt: true,
          payments: { select: { amount: true, status: true } },
        },
      }),
      this.prisma.forTenant().creditNote.findMany({
        where: { customerId },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          creditNoteNumber: true,
          amount: true,
          status: true,
          createdAt: true,
          amountUsed: true,
          expiresAt: true,
        },
      }),
      this.prisma.forTenant().advancePayment.findMany({
        where: { customerId },
        orderBy: { receivedAt: "desc" },
        take: 50,
        select: {
          id: true,
          amount: true,
          balance: true,
          method: true,
          reference: true,
          receivedAt: true,
        },
      }),
      // Pending / confirmed / out-for-delivery orders not yet invoiced
      this.prisma.forTenant().order.findMany({
        where: {
          customerId,
          status: { in: ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"] as any },
        },
        select: { id: true, total: true, orderNumber: true, status: true, createdAt: true },
      }),
    ]);

    const invoicesWithPaid = invoices.map((i) => ({
      ...i,
      // VOID payments (e.g. a bounced check reversed in P5-12) must not count as paid.
      amountPaid: i.payments
        .filter((p) => p.status !== "VOID")
        .reduce((sum, p) => sum + Number(p.amount), 0),
    }));

    const outstanding = invoicesWithPaid
      .filter((i) => !["PAID", "VOID", "WRITTEN_OFF"].includes(i.status))
      .reduce((sum, i) => sum + (Number(i.total) - i.amountPaid), 0);

    const overdue = invoicesWithPaid
      .filter(
        (i) =>
          !["PAID", "VOID", "WRITTEN_OFF"].includes(i.status) &&
          i.dueDate &&
          new Date(i.dueDate) < new Date(),
      )
      .reduce((sum, i) => sum + (Number(i.total) - i.amountPaid), 0);

    // P5-13: wallet = Σ remaining over OPEN, non-expired credits. amount − amountUsed
    // (not face amount) prevents the double-count — a partial credit already sits on
    // the invoice as a CREDIT_NOTE payment, so only its unused remainder appears here.
    const now = new Date();
    const availableCredit = roundMoney(
      creditNotes
        .filter(
          (c) =>
            c.status !== "VOID" &&
            Number(c.amount) - Number(c.amountUsed) > 0.001 &&
            (!c.expiresAt || new Date(c.expiresAt) > now),
        )
        .reduce((sum, c) => sum + roundMoney(Number(c.amount) - Number(c.amountUsed)), 0),
    );

    const advanceBalance = advancePayments.reduce((sum, a) => sum + Number(a.balance), 0);

    const pendingOrdersAmount = pendingOrders.reduce((sum, o) => sum + Number(o.total), 0);

    const transactions = [
      ...invoicesWithPaid.map((i) => ({
        type: "INVOICE" as const,
        id: i.id,
        description: `Invoice #${i.invoiceNumber}`,
        date: i.createdAt.toISOString(),
        amount: Number(i.total),
        runningBalance: -(Number(i.total) - i.amountPaid),
        status: i.status,
      })),
      ...creditNotes.map((c) => {
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
      ...advancePayments.map((a) => ({
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
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async upsertCustomerPrice(customerId: string, dto: UpsertCustomerPriceDto) {
    return this.prisma.forTenant().customerPrice.upsert({
      where: {
        customerId_productId: { customerId, productId: dto.productId },
      },
      create: {
        customerId,
        productId: dto.productId,
        pricingTier: dto.pricingTier,
        notes: dto.notes,
      },
      update: {
        pricingTier: dto.pricingTier,
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

  async applyAdvancePaymentToInvoice(
    advancePaymentId: string,
    dto: { invoiceId: string; amount?: number },
  ) {
    return this.prisma.tenantTransaction(async (tx) => {
      const ap = await tx.advancePayment.findUnique({ where: { id: advancePaymentId } });
      if (!ap) throw new NotFoundException("Advance payment not found");
      if (Number(ap.balance) <= 0)
        throw new BadRequestException("Advance payment has no remaining balance");

      const inv = await tx.invoice.findUnique({
        where: { id: dto.invoiceId },
        include: { payments: true },
      });
      if (!inv) throw new NotFoundException("Invoice not found");
      if (["PAID", "VOID", "WRITTEN_OFF"].includes(inv.status)) {
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

      return tx.invoice.update({
        where: { id: dto.invoiceId },
        data: { status: newStatus, paidAt: newStatus === "PAID" ? new Date() : null },
        include: {
          customer: { select: { id: true, businessName: true } },
          items: true,
          payments: { orderBy: { createdAt: "desc" } },
        },
      });
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

    // Get all invoice payments for this customer's invoices in the last 6 months
    const payments = await this.prisma.forTenant().invoicePayment.findMany({
      where: {
        invoice: { customerId },
        // A bounced/reversed payment (VOID in P5-12) was never really received, so it
        // must not inflate a month's income.
        status: { not: "VOID" },
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
    const where: any = {};
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

    return this.prisma.tenantTransaction(
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

        // Clean up secondary's own records before deleting
        await tx.contactPerson.deleteMany({ where: { customerId: secondaryId } });
        await tx.customerTagAssignment.deleteMany({ where: { customerId: secondaryId } });
        await tx.customerComment.deleteMany({ where: { customerId: secondaryId } });
        await tx.customerPrice.deleteMany({ where: { customerId: secondaryId } });
        await tx.customerAddress.deleteMany({ where: { customerId: secondaryId } });
        await tx.routeRunStop.deleteMany({ where: { customerId: secondaryId } });
        await tx.routeCustomer.deleteMany({ where: { customerId: secondaryId } });
        await tx.routeStop.deleteMany({ where: { customerId: secondaryId } });
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
  async restoreCustomer(id: string, restoreStatus?: string) {
    const customer = await this.prisma.forTenant().customer.findUnique({
      where: { id },
      select: { id: true, userId: true, deletedAt: true, tenantId: true },
    });
    if (!customer) throw new NotFoundException("Customer not found");
    if (!customer.deletedAt) return { success: true, restored: false };

    // Only ACTIVE/SUSPENDED are valid restore targets (INACTIVE = the removed
    // state); default to ACTIVE when the caller does not specify.
    const status = restoreStatus === "SUSPENDED" ? "SUSPENDED" : "ACTIVE";

    await this.prisma.tenantTransaction(async (tx) => {
      await tx.customer.update({ where: { id }, data: { deletedAt: null } });
      if (customer.userId) {
        await tx.user.update({ where: { id: customer.userId }, data: { status } });
      }
    });
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
   * (status INACTIVE) rather than deleted.
   *
   * Previously this method unconditionally cascade-deleted all related
   * financial data in a single transaction.
   */
  async deleteCustomer(id: string, force = false) {
    const customer = await this.prisma.forTenant().customer.findUnique({
      where: { id },
      include: { user: { select: { status: true } } },
    });
    if (!customer) throw new NotFoundException("Customer not found");

    // Count financial records that would be orphaned by a hard delete.
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

    if (force || hasFinancialRecords) {
      // Soft-delete: mark the customer and deactivate their user account.
      // All financial records are preserved with their customerId FK intact.
      await this.prisma.tenantTransaction(async (tx) => {
        await tx.customer.update({ where: { id }, data: { deletedAt: new Date() } });
        await tx.user.update({ where: { id: customer.userId }, data: { status: "INACTIVE" } });
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
      if (invoiceIds.length)
        await tx.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });

      // Invoice items
      if (invoiceIds.length)
        await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      await tx.invoice.deleteMany({ where: { customerId: id } });

      // Credit notes
      await tx.creditNote.deleteMany({ where: { customerId: id } });

      // Returns must be deleted BEFORE orders (Return has orderId FK on Order)
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
        await this.deleteCustomer(id);
        deleted++;
      } catch (e: any) {
        failed.push({ id, reason: e?.message ?? "unknown" });
      }
    }
    return { deleted, failed };
  }

  async deleteAllCustomers(): Promise<{ deleted: number }> {
    const customers = await this.prisma
      .forTenant()
      .customer.findMany({ select: { id: true, userId: true } });
    if (customers.length === 0) return { deleted: 0 };

    const customerIds = customers.map((c) => c.id);
    const userIds = customers.map((c) => c.userId);

    await this.prisma.tenantTransaction(
      async (tx) => {
        const invoices = await tx.invoice.findMany({
          where: { customerId: { in: customerIds } },
          select: { id: true },
        });
        const invoiceIds = invoices.map((i) => i.id);
        if (invoiceIds.length) {
          await tx.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
          await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
        }
        await tx.invoice.deleteMany({ where: { customerId: { in: customerIds } } });

        await tx.creditNote.deleteMany({ where: { customerId: { in: customerIds } } });

        // Returns must be deleted BEFORE orders (Return has orderId FK on Order)
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
          await tx.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
          await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
        }
        await tx.invoice.deleteMany({ where: { customerId: { in: ids } } });

        // Credit notes
        await tx.creditNote.deleteMany({ where: { customerId: { in: ids } } });

        // Returns (must precede orders due to FK)
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
      data: { status: "DISCONNECTED", disconnectedBy: "SELLER", disconnectedAt: new Date() },
    });
    return { message: "Customer disconnected from buyer portal. All business data preserved." };
  }

  async getPortalStatus(customerId: string, tenantId: string) {
    const link = await this.prisma.customerLink.findFirst({
      where: { customerId, tenantId },
      include: { buyerAccount: { select: { id: true, email: true, name: true } } },
    });
    if (!link) return { status: "NOT_INVITED" };
    return {
      status: link.status,
      inviteMethod: link.inviteMethod,
      inviteExpiresAt: link.inviteExpiresAt,
      linkedAt: link.linkedAt,
      disconnectedAt: link.disconnectedAt,
      disconnectedBy: link.disconnectedBy,
      buyerAccount: link.status === "ACTIVE" ? link.buyerAccount : null,
    };
  }

  async approveBuyerRequest(customerId: string, tenantId: string) {
    const link = await this.prisma.customerLink.findFirst({
      where: { customerId, tenantId, status: "PENDING_SELLER_APPROVAL" },
    });
    if (!link) throw new NotFoundException("No pending buyer request found");
    await this.prisma.customerLink.update({
      where: { id: link.id },
      data: { status: "ACTIVE", linkedAt: new Date() },
    });
    return { message: "Buyer connection approved" };
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
    return links;
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

    const ext = (originalName.split(".").pop() ?? "jpg").toLowerCase();
    const key = `customers/${id}/tax-documents/${crypto.randomUUID()}.${ext}`;
    await this.storage.upload(key, buffer, mimetype);

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
