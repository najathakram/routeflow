import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";
import { CreditNotesService } from "./credit-notes.service";
import { CreditNoteReissueService } from "./credit-note-reissue.service";
import { ReissueCreditNoteDto } from "./dto/reissue-credit-note.dto";
import { CreateCreditNoteDto } from "./dto/create-credit-note.dto";
import { UpdateCreditNoteDto } from "./dto/update-credit-note.dto";
import { SetAutoApplyExclusionDto } from "./dto/set-auto-apply-exclusion.dto";
import { ApplyCreditNoteDto, UnapplyCreditNoteDto } from "./dto/apply-credit-note.dto";

// WP5b (R3b.3, R3b.5): flag.credit_notes ships dark (DARK_PLAN_FLAGS in
// plan-flag-policy.ts) — this class-level guard is a courtesy allow until the
// PLAN_FLAG_ENFORCEMENT switch flips on. Per-handler RolesGuard/@Roles stays as-is —
// not moved to the class level.
@Controller("credit-notes")
@UseGuards(JwtAuthGuard, PlanFlagGuard)
@RequirePlanFlag("flag.credit_notes")
export class CreditNotesController {
  constructor(
    private readonly creditNotesService: CreditNotesService,
    private readonly reissueService: CreditNoteReissueService,
  ) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  create(@Body() dto: CreateCreditNoteDto) {
    return this.creditNotesService.create(dto);
  }

  @Get()
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query("customerId") customerId?: string,
    @Query("status") status?: string,
    @Query("search") search?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.creditNotesService.findAllForUser(
      user,
      customerId,
      status,
      search,
      dateFrom,
      dateTo,
      page ? +page : 1,
      limit ? +limit : 20,
    );
  }

  @Get(":id")
  findOne(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.creditNotesService.findOneForUser(id, user);
  }

  @Post(":id/apply")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  apply(@Param("id") id: string, @Body() body: ApplyCreditNoteDto) {
    return this.creditNotesService.applyToInvoice(id, body.invoiceId, body.amount);
  }

  @Post(":id/void")
  @UseGuards(RolesGuard)
  // #2403 / SA-436 PR-3: a staff action; TENANT_ADMIN named explicitly (RolesGuard already
  // lets it satisfy OPERATOR).
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  voidNote(@Param("id") id: string) {
    return this.creditNotesService.voidCreditNote(id);
  }

  // SA-436 PR-2 (#2402): the invoices a void-with-reversal reopens, and any refusal. Read-only.
  @Get(":id/void-preview")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  voidPreview(@Param("id") id: string) {
    return this.creditNotesService.voidPreview(id);
  }

  // SA-436 PR-2 (#2402): un-apply everywhere, remember each pair, then void.
  @Post(":id/void-with-reversal")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  voidWithReversal(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.creditNotesService.voidWithReversal(id, user?.sub ?? null);
  }

  // #2648 / SA-535(b): an amount/line edit = void-with-reversal + an unapplied replacement, in ONE
  // transaction. The Idempotency-Key is required; a replay returns the same new note.
  @Post(":id/reissue")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  reissue(
    @Param("id") id: string,
    @Body() dto: ReissueCreditNoteDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.reissueService.reissue(id, dto, idempotencyKey, user?.sub ?? null);
  }

  @Post(":id/unapply")
  @UseGuards(RolesGuard)
  // #2403 / SA-436 PR-3: a staff action; TENANT_ADMIN named explicitly (RolesGuard already
  // lets it satisfy OPERATOR).
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  unapply(
    @Param("id") id: string,
    @Body() body: UnapplyCreditNoteDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.creditNotesService.unapplyFromInvoice(id, body.invoiceId, user?.sub ?? null);
  }

  // SA-436 (#2401): OPERATOR and TENANT_ADMIN only; a DRIVER or CUSTOMER gets 403.
  @Patch(":id/auto-apply-exclusion")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.TENANT_ADMIN)
  setAutoApplyExclusion(
    @Param("id") id: string,
    @Body() dto: SetAutoApplyExclusionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.creditNotesService.setAutoApplyExcluded(id, dto.excluded, user?.sub ?? null);
  }

  @Patch(":id")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  update(
    @Param("id") id: string,
    @Body() body: UpdateCreditNoteDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.creditNotesService.updateCreditNote(id, body, user?.sub ?? null);
  }
}
