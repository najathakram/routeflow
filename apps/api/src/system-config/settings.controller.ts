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
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { SystemConfigService } from "./system-config.service";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";

@Controller("settings")
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
    return {
      businessName: all["settings.businessName"] ?? "",
      ownerName: all["settings.ownerName"] ?? "",
      phone: all["settings.phone"] ?? "",
      email: all["settings.email"] ?? "",
      street: all["settings.street"] ?? "",
      city: all["settings.city"] ?? "",
      zip: all["settings.zip"] ?? "",
      taxRate: all["settings.taxRate"] != null ? parseFloat(all["settings.taxRate"]) : 10,
      logoUrl: all["settings.logoUrl"] ?? null,
    };
  }

  @Patch()
  async updateSettings(@Body() dto: Record<string, unknown>) {
    const allowed = [
      "businessName",
      "ownerName",
      "phone",
      "email",
      "street",
      "city",
      "zip",
      "taxRate",
      "logoUrl",
    ];
    await Promise.all(
      allowed
        .filter((k) => dto[k] !== undefined)
        .map((k) => this.svc.set(`settings.${k}`, String(dto[k]))),
    );
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
    return { configured, keyPreview, source: stored ? "database" : envKey ? "environment" : "none" };
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
}
