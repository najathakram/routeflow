import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { SystemConfigService } from "./system-config.service";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { UpdateRouteSettingsDto } from "./dto/update-route-settings.dto";
import { UpdateInvoiceSettingsDto } from "./dto/update-invoice-settings.dto";

// RF-213: serve under both /settings and /tenant/settings so the frontend
// calling the latter doesn't get a 404 while the operator app uses /settings.
@Controller(["settings", "tenant/settings"])
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class SettingsController {
  constructor(
    private readonly svc: SystemConfigService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  @Get()
  async getSettings() {
    const all = await this.svc.getAll("settings.");

    // Source businessName from TenantConfig (set by super admin, read-only for tenant)
    const tenantId = this.prisma.getTenantId();
    let businessName = all["settings.businessName"] ?? "";
    let ownerName = all["settings.ownerName"] ?? "";
    let accountEmail = all["settings.email"] ?? "";
    let customerEmail = "";
    let invoiceNotes = "";
    let invoiceTerms = "";

    // Address / phone resolved below (TenantConfig takes precedence over SystemConfig)
    let street = all["settings.street"] ?? "";
    let city = all["settings.city"] ?? "";
    let state = all["settings.state"] ?? "";
    let zip = all["settings.zip"] ?? "";
    let phone = all["settings.phone"] ?? "";

    if (tenantId) {
      const config = await this.prisma.tenantConfig.findUnique({
        where: { tenantId },
        select: {
          businessName: true,
          ownerName: true,
          customerEmail: true,
          addressLine1: true,
          city: true,
          state: true,
          zip: true,
          phone: true,
          invoiceNotes: true,
          invoiceTerms: true,
        },
      });
      if (config?.businessName) businessName = config.businessName;
      if (config?.ownerName) ownerName = config.ownerName;
      if (config?.customerEmail) customerEmail = config.customerEmail;
      // Address from TenantConfig overrides any legacy SystemConfig values
      if (config?.addressLine1 != null) street = config.addressLine1;
      if (config?.city != null) city = config.city;
      if (config?.state != null) state = config.state;
      if (config?.zip != null) zip = config.zip;
      if (config?.phone != null) phone = config.phone;
      if (config?.invoiceNotes != null) invoiceNotes = config.invoiceNotes;
      if (config?.invoiceTerms != null) invoiceTerms = config.invoiceTerms;

      // If account email is not explicitly set in system config, source it from
      // the TENANT_ADMIN user's email — this is the email used when the tenant
      // was created and serves as the primary account identifier.
      if (!accountEmail) {
        const admin = await this.prisma.forTenant().user.findFirst({
          where: { tenantId, role: UserRole.TENANT_ADMIN, deletedAt: null },
          select: { email: true },
        });
        if (admin?.email) accountEmail = admin.email;
      }
    }

    return {
      businessName,
      ownerName,
      phone,
      email: accountEmail,
      customerEmail,
      street,
      city,
      state,
      zip,
      taxRate: all["settings.taxRate"] != null ? parseFloat(all["settings.taxRate"]) : 0,
      logoUrl: all["settings.logoUrl"] ?? null,
      invoiceNotes,
      invoiceTerms,
    };
  }

  @Patch()
  async updateSettings(@Body() dto: Record<string, unknown>) {
    // businessName and email are NOT editable by tenant admin (set by super admin).
    // taxRate and logoUrl stay in SystemConfig (no dedicated TenantConfig column for them yet).
    const allowed = ["taxRate", "logoUrl"];
    await Promise.all(
      allowed
        .filter((k) => dto[k] !== undefined)
        .map((k) => this.svc.set(`settings.${k}`, String(dto[k]))),
    );

    // ownerName, customerEmail, and address fields are stored in TenantConfig
    const tenantId = this.prisma.getTenantId();
    if (tenantId) {
      const configUpdate: Record<string, unknown> = {};
      if (dto.ownerName !== undefined)
        configUpdate.ownerName = typeof dto.ownerName === "string" ? dto.ownerName : "";
      if (dto.customerEmail !== undefined)
        configUpdate.customerEmail = typeof dto.customerEmail === "string" ? dto.customerEmail : "";
      // Address / phone — map frontend field names to TenantConfig column names
      if (dto.street !== undefined)
        configUpdate.addressLine1 = typeof dto.street === "string" ? dto.street : "";
      if (dto.city !== undefined) configUpdate.city = typeof dto.city === "string" ? dto.city : "";
      if (dto.state !== undefined)
        configUpdate.state = typeof dto.state === "string" ? dto.state : "";
      if (dto.zip !== undefined) configUpdate.zip = typeof dto.zip === "string" ? dto.zip : "";
      if (dto.phone !== undefined)
        configUpdate.phone = typeof dto.phone === "string" ? dto.phone : "";
      if (dto.invoiceNotes !== undefined)
        configUpdate.invoiceNotes = typeof dto.invoiceNotes === "string" ? dto.invoiceNotes : "";
      if (dto.invoiceTerms !== undefined)
        configUpdate.invoiceTerms = typeof dto.invoiceTerms === "string" ? dto.invoiceTerms : "";
      if (Object.keys(configUpdate).length > 0) {
        await this.prisma.tenantConfig.upsert({
          where: { tenantId },
          create: { tenantId, ...configUpdate },
          update: configUpdate,
        });

        // Anything we just updated shows on the invoice header (address /
        // phone / customer email / business name) or on the body (notes /
        // terms). Cached invoice PDFs would still show the OLD values until
        // the next regeneration — invalidate them so the next download for
        // any invoice picks up the change.
        const invoiceVisibleKeys = [
          "addressLine1",
          "city",
          "state",
          "zip",
          "phone",
          "customerEmail",
          "ownerName",
          "invoiceNotes",
          "invoiceTerms",
        ];
        const touchesInvoice = invoiceVisibleKeys.some((k) => k in configUpdate);
        if (touchesInvoice) {
          await this.prisma.invoice.updateMany({
            where: { tenantId, pdfUrl: { not: null } },
            data: { pdfUrl: null },
          });
        }
      }
    }

    return this.getSettings();
  }

  // ─── Anthropic API Key ───────────────────────────────────────────────────────

  @Get("anthropic")
  async getAnthropicSettings() {
    const stored = await this.svc.get("anthropic.apiKey");
    const envKey = this.configService.get<string>("ANTHROPIC_API_KEY");
    const key = stored || envKey || null;
    const configured = !!key && key.length > 0;
    const keyPreview = key ? `${key.slice(0, 10)}...${key.slice(-4)}` : null;
    return {
      configured,
      keyPreview,
      source: stored ? "database" : envKey ? "environment" : "none",
    };
  }

  @Patch("anthropic")
  async updateAnthropicSettings(@Body() dto: { apiKey?: string }) {
    if (dto.apiKey !== undefined) {
      if (dto.apiKey === "") {
        // Allow clearing the key
        await this.svc.set("anthropic.apiKey", "");
      } else {
        await this.svc.set("anthropic.apiKey", dto.apiKey);
      }
    }
    return this.getAnthropicSettings();
  }

  // ─── Email Settings ──────────────────────────────────────────────────────────

  @Get("email")
  async getEmailSettings() {
    const all = await this.svc.getAll("email.");
    return {
      fromName: all["email.fromName"] ?? "",
      fromEmail: all["email.fromEmail"] ?? "",
      smtpHost: all["email.smtpHost"] ?? "",
      smtpPort: all["email.smtpPort"] ? parseInt(all["email.smtpPort"]) : 587,
      smtpUser: all["email.smtpUser"] ?? "",
      smtpPassword: all["email.smtpPassword"] ? "••••••••" : "", // mask password in response
      smtpSecure: all["email.smtpSecure"] === "true",
      configured: !!(all["email.smtpHost"] && all["email.smtpUser"] && all["email.smtpPassword"]),
    };
  }

  @Post("email")
  async updateEmailSettings(@Body() dto: Record<string, unknown>) {
    const allowed = [
      "fromName",
      "fromEmail",
      "smtpHost",
      "smtpPort",
      "smtpUser",
      "smtpPassword",
      "smtpSecure",
    ];
    await Promise.all(
      allowed
        .filter((k) => dto[k] !== undefined && dto[k] !== "••••••••") // don't overwrite with masked password
        .map((k) => this.svc.set(`email.${k}`, String(dto[k]))),
    );
    return this.getEmailSettings();
  }

  @Post("email/test")
  @HttpCode(HttpStatus.OK)
  async testEmailSettings(@Body() dto: { toEmail: string }) {
    return this.emailService.sendTestEmail(dto.toEmail);
  }

  // ─── Clear Financial Data ────────────────────────────────────────────────────

  @Delete("financial-data")
  async clearFinancialData() {
    await this.prisma.$transaction(async (tx) => {
      // Payments on invoices
      await tx.invoicePayment.deleteMany({});
      // Invoice line items
      await tx.invoiceItem.deleteMany({});
      // Invoices
      await tx.invoice.deleteMany({});
      // Credit notes
      await tx.creditNote.deleteMany({});
      // Vendor bill payments
      await tx.billPayment.deleteMany({});
      // Vendor bill items
      await tx.vendorBillItem.deleteMany({});
      // Vendor bills
      await tx.vendorBill.deleteMany({});
      // Purchase order items
      await tx.purchaseOrderItem.deleteMany({});
      // Purchase orders
      await tx.purchaseOrder.deleteMany({});
      // Generic payments (transaction-linked)
      await tx.payment.deleteMany({});
    });
    return { success: true, message: "All financial data cleared successfully" };
  }

  // ─── Route Settings ───────────────────────────────────────────────────────────

  @Get("route")
  async getRouteSettings() {
    const speedRaw = await this.svc.get("route.averageSpeedKmh");
    const serviceRaw = await this.svc.get("route.serviceTimeMinutes");
    const startTimeRaw = await this.svc.get("route.defaultStartTime");
    const depotLatRaw = await this.svc.get("route.defaultDepotLat");
    const depotLngRaw = await this.svc.get("route.defaultDepotLng");

    // Build depot address from TenantConfig
    let depotAddress = "";
    const tenantId = this.prisma.getTenantId();
    if (tenantId) {
      const config = await this.prisma.tenantConfig.findUnique({
        where: { tenantId },
        select: {
          addressLine1: true,
          city: true,
          state: true,
          zip: true,
        },
      });
      if (config) {
        const parts = [
          config.addressLine1,
          config.city,
          [config.state, config.zip].filter(Boolean).join(" "),
        ].filter(Boolean);
        depotAddress = parts.join(", ");
      }
    }

    return {
      averageSpeedKmh: speedRaw != null ? parseFloat(speedRaw) : 50,
      serviceTimeMinutes: serviceRaw != null ? parseFloat(serviceRaw) : 15,
      defaultStartTime: startTimeRaw ?? "08:00",
      depotLat: depotLatRaw != null ? parseFloat(depotLatRaw) : null,
      depotLng: depotLngRaw != null ? parseFloat(depotLngRaw) : null,
      depotAddress,
    };
  }

  @Patch("route")
  @UsePipes(new ValidationPipe({ whitelist: true }))
  async updateRouteSettings(@Body() dto: UpdateRouteSettingsDto) {
    if (dto.averageSpeedKmh !== undefined) {
      await this.svc.set("route.averageSpeedKmh", String(dto.averageSpeedKmh));
    }
    if (dto.serviceTimeMinutes !== undefined) {
      await this.svc.set("route.serviceTimeMinutes", String(dto.serviceTimeMinutes));
    }
    if (dto.defaultStartTime !== undefined) {
      await this.svc.set("route.defaultStartTime", dto.defaultStartTime);
    }
    return this.getRouteSettings();
  }

  // ─── Invoice Settings ─────────────────────────────────────────────────────────

  @Get("invoice")
  async getInvoiceSettings() {
    const defaultTerms = await this.svc.get("invoice.defaultTerms");
    return {
      defaultTerms: defaultTerms ?? "Net 30",
    };
  }

  @Patch("invoice")
  @UsePipes(new ValidationPipe({ whitelist: true }))
  async updateInvoiceSettings(@Body() dto: UpdateInvoiceSettingsDto) {
    if (dto.defaultTerms !== undefined) {
      await this.svc.set("invoice.defaultTerms", dto.defaultTerms);
    }
    return this.getInvoiceSettings();
  }
}
