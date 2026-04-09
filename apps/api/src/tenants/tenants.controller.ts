import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiBody } from "@nestjs/swagger";
import { TenantsService } from "./tenants.service";
import { EmailService } from "../email/email.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { UserRole } from "@prisma/client";
import { UpdateEmailConfigDto } from "./dto/update-email-config.dto";
import { UpdateGoogleOAuthConfigDto } from "./dto/update-google-oauth-config.dto";
import { UpdateBrandingDto } from "./dto/update-branding.dto";
import type { JwtPayload } from "../auth/jwt-payload.interface";

@ApiTags("tenants")
@Controller("tenants")
export class TenantsController {
  constructor(
    private readonly tenantsService: TenantsService,
    private readonly emailService: EmailService,
  ) {}

  // ─── Me/Config: Email ──────────────────────────────────────────────────────

  @Get("me/config/email")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get current tenant SMTP config (passwords masked)" })
  getEmailConfig(@CurrentUser() user: JwtPayload) {
    return this.tenantsService.getEmailConfig(user.tenantId!);
  }

  @Put("me/config/email")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update current tenant SMTP config" })
  updateEmailConfig(@CurrentUser() user: JwtPayload, @Body() dto: UpdateEmailConfigDto) {
    return this.tenantsService.updateEmailConfig(user.tenantId!, dto);
  }

  @Post("me/config/email/test")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Send a test email using current tenant SMTP config" })
  async testEmailConfig(@CurrentUser() user: JwtPayload, @Body() body: { email: string }) {
    return this.emailService.sendTestEmail(body.email ?? user.username);
  }

  // ─── Me/Config: Google OAuth ───────────────────────────────────────────────

  @Get("me/config/google-oauth")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get current tenant Google OAuth config (secrets masked)" })
  getGoogleOAuthConfig(@CurrentUser() user: JwtPayload) {
    return this.tenantsService.getGoogleOAuthConfig(user.tenantId!);
  }

  @Put("me/config/google-oauth")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update current tenant Google OAuth credentials" })
  updateGoogleOAuthConfig(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateGoogleOAuthConfigDto,
  ) {
    return this.tenantsService.updateGoogleOAuthConfig(user.tenantId!, dto);
  }

  @Post("me/config/google-oauth/test")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the Google OAuth authorization URL for this tenant" })
  async testGoogleOAuthConfig(@Param() _: any, @CurrentUser() user: JwtPayload) {
    const cfg = await this.tenantsService.getGoogleOAuthConfig(user.tenantId!);
    if (!cfg.clientId || !cfg.callbackUrl || !cfg.enabled) {
      return { success: false, message: "Google OAuth is not fully configured or not enabled" };
    }
    return {
      success: true,
      message: "Google OAuth is configured",
      authUrl: `/api/v1/auth/google/${user.tenantId}`,
    };
  }

  // ─── Me/Config: Branding ───────────────────────────────────────────────────

  @Get("me/config/branding")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get current tenant branding settings" })
  async getBranding(@CurrentUser() user: JwtPayload) {
    const tenant = await this.tenantsService.getBranding(user.tenantSlug!);
    if (!tenant) return { businessName: null, primaryColor: null, logoKey: null, logoUrl: null };
    const logoUrl = tenant.logoKey ? await this.tenantsService.getLogoUrl(tenant.logoKey) : null;
    return { ...tenant, logoUrl };
  }

  @Put("me/config/branding")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update tenant branding (business name, primary color)" })
  updateBranding(@CurrentUser() user: JwtPayload, @Body() dto: UpdateBrandingDto) {
    return this.tenantsService.updateBranding(user.tenantId!, dto);
  }

  @Post("me/config/branding/logo")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @UseInterceptors(FileInterceptor("logo", { limits: { fileSize: 5 * 1024 * 1024 } }))
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: { type: "object", properties: { logo: { type: "string", format: "binary" } } },
  })
  @ApiOperation({ summary: "Upload tenant logo (max 5 MB; PNG, JPG, SVG, WEBP)" })
  async uploadLogo(@CurrentUser() user: JwtPayload, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException("No file uploaded");
    const allowed = ["image/png", "image/jpeg", "image/svg+xml", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException("Only PNG, JPG, SVG, and WEBP images are allowed");
    }
    return this.tenantsService.uploadLogo(user.tenantId!, file);
  }
}
