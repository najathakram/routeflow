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
  Req,
  ServiceUnavailableException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request } from "express";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiBody } from "@nestjs/swagger";
import { TenantsService } from "./tenants.service";
import { EmailService } from "../email/email.service";
import { AddonService } from "../billing/addon.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { gateVia, FEATURE_REGISTRY } from "../billing/feature-registry";
import type { ResolvedFeatures } from "../billing/feature-resolver.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { PolicyService } from "../policy/policy.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import {
  capabilityFromInputs,
  heldAddonKeys,
  readFulfilmentInputs,
} from "../billing/fulfilment-capability";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { UserRole } from "@prisma/client";
import { UpdateEmailConfigDto } from "./dto/update-email-config.dto";
import { UpdateGoogleOAuthConfigDto } from "./dto/update-google-oauth-config.dto";
import { UpdateBrandingDto } from "./dto/update-branding.dto";
import { MB, uploadLimits } from "../common/upload-limits";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { TenantFeaturesResponse } from "@routeflow/types";
import { API_ERROR_CODES } from "../common/api-error-codes";

@ApiTags("tenants")
@Controller("tenants")
export class TenantsController {
  constructor(
    private readonly tenantsService: TenantsService,
    private readonly emailService: EmailService,
    private readonly addonService: AddonService,
    private readonly featureOverrides: FeatureOverrideService,
    private readonly authority: EntitlementAuthority,
    private readonly policies: PolicyService,
    private readonly featureConfig: FeatureConfigService,
  ) {}

  // ─── Me: Features (feature grants v2 brief A) ─────────────────────────────────

  @Get("me/features")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Server-computed feature trace for the current tenant (design 2026-09-17 §2): `served` " +
      "(the old enforcement path, what's actually enforced today) and `resolver` (the shadow " +
      "resolver's own verdict, informational). Not yet a client gating read path (Opus review " +
      "of 9923b87c, item 1) — web/mobile still gate on useSubscription().flags.",
  })
  async getMyFeatures(@CurrentUser() user: JwtPayload): Promise<TenantFeaturesResponse> {
    // Opus review of 9923b87c, item 2: no tenant context or a resolver/old-path failure must
    // 503, never 200 with an empty list — a client gate reading this endpoint someday must be
    // able to tell "genuinely nothing granted" apart from "the server couldn't tell you."
    if (!user.tenantId) {
      throw new ServiceUnavailableException({
        code: API_ERROR_CODES.FEATURES_UNAVAILABLE,
        message: "No tenant context.",
      });
    }
    // SA-138: the TENANT-scope effective policy values ride `modes`. `effectiveForClient` never
    // throws — a failed policy read yields the registry defaults, i.e. today's behaviour.
    const [resolved, served, policyModes]: [
      ResolvedFeatures | null,
      string[] | null,
      Record<string, string>,
    ] = await Promise.all([
      this.authority.resolveAll(user.tenantId),
      this.authority.servedFlags(user.tenantId).catch(() => null),
      this.policies.effectiveForClient(user.tenantId),
    ]);
    if (!resolved || served === null) {
      throw new ServiceUnavailableException({
        code: API_ERROR_CODES.FEATURES_UNAVAILABLE,
        message: "Feature resolution is temporarily unavailable. Please retry.",
      });
    }
    const resolver: Record<string, boolean> = {};
    for (const f of FEATURE_REGISTRY) {
      resolver[f.key] = resolved.byKey.get(f.key)?.effective ?? false;
    }
    // Business profiles 1A: the fulfilment modes and the ONE derived capability answer, read by the shared
    // `readFulfilmentInputs` (also behind the counter-sale gate). A failed mode read falls back to `unset`
    // (today's behavior): never a 5xx for a field old clients ignore. A failed fleet read must not 500 (and
    // must not guess fleet=false): the existing 503.
    const fulfilment = await readFulfilmentInputs(
      {
        featureConfig: this.featureConfig,
        addonService: this.addonService,
        featureOverrides: this.featureOverrides,
      },
      user.tenantId,
    );
    if (fulfilment.fleet === null) {
      throw new ServiceUnavailableException({
        code: API_ERROR_CODES.FEATURES_UNAVAILABLE,
        message: "Feature resolution is temporarily unavailable. Please retry.",
      });
    }
    return {
      served,
      resolver,
      modes: {
        ...policyModes,
        fulfilment_model: fulfilment.fulfilmentMode,
        counter_sales: fulfilment.counterSales,
      },
      capabilities: { fulfilment: capabilityFromInputs(fulfilment) },
      catalogVersionId: resolved.catalogVersionId,
      computedAt: resolved.computedAt,
    };
  }

  // ─── Me: Addons ──────────────────────────────────────────────────────────────

  @Get("me/addons")
  @UseGuards(JwtAuthGuard, RolesGuard)
  // Widened for developer_mode: pure DRIVER-role users of a dev-mode tenant
  // must be able to read this flag (useDeveloperMode runs on driver screens).
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Active add-on keys for the current tenant (feature flags)" })
  async getMyAddons(@CurrentUser() user: JwtPayload) {
    if (!user.tenantId) return { addons: [] };
    return {
      addons: Array.from(
        await heldAddonKeys(this.addonService, this.featureOverrides, user.tenantId),
      ),
    };
  }

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
  @ApiOperation({ summary: "Check whether this tenant's Google OAuth settings are complete" })
  async testGoogleOAuthConfig(@Param() _: any, @CurrentUser() user: JwtPayload) {
    const cfg = await this.tenantsService.getGoogleOAuthConfig(user.tenantId!);
    if (!cfg.clientId || !cfg.callbackUrl || !cfg.enabled) {
      return { success: false, message: "Google OAuth is not fully configured or not enabled" };
    }
    // No sign-in URL is advertised: the legacy per-tenant sign-in routes are retired, and the
    // standard start (GET /auth/google?tenant=) answers JSON that a plain link cannot open.
    return { success: true, message: "Google OAuth is configured" };
  }

  // ─── Me/Config: Branding ───────────────────────────────────────────────────

  @Get("me/config/branding")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get current tenant branding settings" })
  async getBranding(@CurrentUser() user: JwtPayload, @Req() req: Request) {
    const tenant = await this.tenantsService.getBranding(user.tenantSlug!);
    if (!tenant) return { businessName: null, primaryColor: null, logoKey: null, logoUrl: null };
    // Use the public /public/tenants/:slug/logo endpoint (no auth, inline
    // disposition) so an `<img src>` can render the logo. The raw uploads
    // URL is JWT-protected AND served as Content-Disposition: attachment.
    const logoUrl = tenant.logoKey
      ? `${req.protocol}://${req.get("host")}/api/v1/public/tenants/${encodeURIComponent(user.tenantSlug!)}/logo`
      : null;
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
  @UseInterceptors(FileInterceptor("logo", { limits: uploadLimits(MB(5)) }))
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: { type: "object", properties: { logo: { type: "string", format: "binary" } } },
  })
  @ApiOperation({ summary: "Upload tenant logo (max 5 MB; PNG, JPG, WEBP)" })
  async uploadLogo(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
  ) {
    if (!file) throw new BadRequestException("No file uploaded");
    // RF-076: SVG removed from allowlist. SVGs can embed <script> tags and were
    // served inline as image/svg+xml, enabling stored XSS via tenant logos.
    const allowed = ["image/png", "image/jpeg", "image/webp"];
    if (
      !allowed.includes(file.mimetype) ||
      file.mimetype === "image/svg+xml" ||
      file.originalname.toLowerCase().endsWith(".svg")
    ) {
      throw new BadRequestException("Only PNG, JPG, and WEBP images are allowed");
    }
    const result = await this.tenantsService.uploadLogo(user.tenantId!, file);
    // Override the storage's protected uploads URL with the public endpoint so
    // the front-end can drop the returned URL straight into an `<img src>`.
    // Cache-buster query (?v=<timestamp>) forces browsers to fetch the new
    // bytes immediately when the operator re-uploads.
    return {
      ...result,
      logoUrl: `${req.protocol}://${req.get("host")}/api/v1/public/tenants/${encodeURIComponent(user.tenantSlug!)}/logo?v=${Date.now()}`,
    };
  }
}
