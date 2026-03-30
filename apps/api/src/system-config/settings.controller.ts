import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { SystemConfigService } from "./system-config.service";

@Controller("settings")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class SettingsController {
  constructor(private readonly svc: SystemConfigService) {}

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
      taxRate: all["settings.taxRate"] ? parseFloat(all["settings.taxRate"]) : 10,
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
}
