import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { CustomersService } from "./customers.service";
import { PortalInviteDto } from "../buyer/dto/portal-invite.dto";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";
import { ChangeCustomerStatusDto } from "./dto/change-customer-status.dto";
import { CreateAddressDto } from "./dto/create-address.dto";
import { UpdateAddressDto } from "./dto/update-address.dto";
import { ListCustomersDto } from "./dto/list-customers.dto";
import { UpsertCustomerPriceDto } from "./dto/customer-price.dto";

@ApiTags("customers")
@ApiBearerAuth()
@Controller("customers")
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  @Roles(UserRole.OPERATOR)
  findAll(@Query() query: ListCustomersDto) {
    return this.customersService.findAll(query);
  }

  @Post()
  @Roles(UserRole.OPERATOR)
  create(@Body() dto: CreateCustomerDto) {
    return this.customersService.create(dto);
  }

  // ─── Static routes (must come BEFORE ":id" param routes) ──────────────────

  @Get("export")
  @Roles(UserRole.OPERATOR)
  async exportCsv(@Query() query: ListCustomersDto, @Res() res: Response) {
    const csv = await this.customersService.exportCustomers(query);
    res.set({
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="customers.csv"',
    });
    res.send(csv);
  }

  @Get("tags")
  @Roles(UserRole.OPERATOR)
  listTags() {
    return this.customersService.listTags();
  }

  @Post("tags")
  @Roles(UserRole.OPERATOR)
  createTag(@Body() dto: { name: string; color?: string }) {
    return this.customersService.createTag(dto);
  }

  @Delete("tags/:tagId")
  @Roles(UserRole.OPERATOR)
  deleteTag(@Param("tagId") tagId: string) {
    return this.customersService.deleteTag(tagId);
  }

  @Post("merge")
  @Roles(UserRole.OPERATOR)
  mergeCustomers(@Body() dto: { primaryId: string; secondaryId: string }) {
    return this.customersService.mergeCustomers(dto.primaryId, dto.secondaryId);
  }

  @Post("geocode-all")
  @Roles(UserRole.OPERATOR)
  geocodeAllAddresses() {
    return this.customersService.geocodeAllAddresses();
  }

  @Get("pending-portal-approvals")
  @Roles(UserRole.OPERATOR)
  listPendingPortalApprovals(@CurrentUser() user: JwtPayload) {
    return this.customersService.listPendingPortalApprovals(user.tenantId!);
  }

  @Get("me")
  @Roles(UserRole.CUSTOMER)
  getMyProfile(@CurrentUser() user: JwtPayload) {
    return this.customersService.findMyProfile(user);
  }

  @Get("me/statement")
  @Roles(UserRole.CUSTOMER)
  getMyStatement(@CurrentUser() user: JwtPayload) {
    return this.customersService.getMyStatement(user);
  }

  @Patch("me")
  @Roles(UserRole.CUSTOMER)
  updateMyProfile(@CurrentUser() user: JwtPayload, @Body() dto: UpdateCustomerDto) {
    return this.customersService.updateMyProfile(user, dto);
  }

  @Delete("all")
  @Roles(UserRole.OPERATOR)
  deleteAll() {
    return this.customersService.deleteAllCustomers();
  }

  @Post("batch-delete")
  @Roles(UserRole.OPERATOR)
  @HttpCode(200)
  batchDelete(@Body() body: { ids: string[] }) {
    return this.customersService.batchDelete(body?.ids ?? []);
  }

  @Get("cleanup-preview")
  @Roles(UserRole.OPERATOR)
  cleanupPreview() {
    return this.customersService.previewImportedCleanup();
  }

  @Delete("cleanup-imported")
  @Roles(UserRole.OPERATOR)
  @HttpCode(200)
  cleanupImported() {
    return this.customersService.deleteImportedCustomers();
  }

  // ─── :id param routes ─────────────────────────────────────────────────────

  @Get(":id")
  @Roles(UserRole.OPERATOR, UserRole.CUSTOMER, UserRole.DRIVER)
  findOne(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.customersService.findOne(id, user);
  }

  @Patch(":id")
  @Roles(UserRole.OPERATOR)
  update(@Param("id") id: string, @Body() dto: UpdateCustomerDto) {
    return this.customersService.update(id, dto);
  }

  @Patch(":id/status")
  @Roles(UserRole.OPERATOR)
  changeStatus(@Param("id") id: string, @Body() dto: ChangeCustomerStatusDto) {
    return this.customersService.changeStatus(id, dto);
  }

  @Get(":id/routes")
  @Roles(UserRole.OPERATOR)
  findRoutes(@Param("id") id: string) {
    return this.customersService.findRoutes(id);
  }

  @Get(":id/orders")
  findOrders(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.customersService.findOrders(id, user);
  }

  @Get(":id/statement")
  @Roles(UserRole.OPERATOR)
  getStatement(@Param("id") id: string) {
    return this.customersService.getStatementForOperator(id);
  }

  @Post(":id/advance-payments")
  @Roles(UserRole.OPERATOR)
  createAdvancePayment(@Param("id") id: string, @Body() dto: any) {
    return this.customersService.createAdvancePayment(id, dto);
  }

  @Get(":id/advance-payments")
  @Roles(UserRole.OPERATOR)
  getAdvancePayments(@Param("id") id: string) {
    return this.customersService.getAdvancePayments(id);
  }

  @Post(":id/advance-payments/:apId/apply")
  @Roles(UserRole.OPERATOR)
  applyAdvancePayment(@Param("apId") apId: string, @Body() dto: any) {
    return this.customersService.applyAdvancePaymentToInvoice(apId, dto);
  }

  @Get(":id/prices")
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  getCustomerPrices(@Param("id") id: string) {
    return this.customersService.getCustomerPrices(id);
  }

  @Post(":id/prices")
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  upsertCustomerPrice(@Param("id") id: string, @Body() dto: UpsertCustomerPriceDto) {
    return this.customersService.upsertCustomerPrice(id, dto);
  }

  @Delete(":id/prices/:priceId")
  @Roles(UserRole.OPERATOR)
  deleteCustomerPrice(@Param("id") id: string, @Param("priceId") priceId: string) {
    return this.customersService.deleteCustomerPrice(id, priceId);
  }

  @Post(":id/addresses")
  @Roles(UserRole.OPERATOR)
  addAddress(@Param("id") id: string, @Body() dto: CreateAddressDto) {
    return this.customersService.addAddress(id, dto);
  }

  @Patch(":id/addresses/:addrId")
  @Roles(UserRole.OPERATOR)
  updateAddress(
    @Param("id") id: string,
    @Param("addrId") addrId: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.customersService.updateAddress(id, addrId, dto);
  }

  // ─── Tags (per customer) ──────────────────────────────────────────────────

  @Post(":id/tags")
  @Roles(UserRole.OPERATOR)
  assignTag(@Param("id") id: string, @Body() dto: { tagId: string }) {
    return this.customersService.assignTag(id, dto.tagId);
  }

  @Delete(":id/tags/:tagId")
  @Roles(UserRole.OPERATOR)
  removeTag(@Param("id") id: string, @Param("tagId") tagId: string) {
    return this.customersService.removeTag(id, tagId);
  }

  // ─── Contact Persons ──────────────────────────────────────────────────────

  @Get(":id/contacts")
  @Roles(UserRole.OPERATOR)
  listContacts(@Param("id") id: string) {
    return this.customersService.listContactPersons(id);
  }

  @Post(":id/contacts")
  @Roles(UserRole.OPERATOR)
  addContact(@Param("id") id: string, @Body() dto: any) {
    return this.customersService.addContactPerson(id, dto);
  }

  @Patch(":id/contacts/:cid")
  @Roles(UserRole.OPERATOR)
  updateContact(@Param("id") id: string, @Param("cid") cid: string, @Body() dto: any) {
    return this.customersService.updateContactPerson(id, cid, dto);
  }

  @Delete(":id/contacts/:cid")
  @Roles(UserRole.OPERATOR)
  deleteContact(@Param("id") id: string, @Param("cid") cid: string) {
    return this.customersService.deleteContactPerson(id, cid);
  }

  // ─── Comments ─────────────────────────────────────────────────────────────

  @Get(":id/comments")
  @Roles(UserRole.OPERATOR)
  listComments(@Param("id") id: string) {
    return this.customersService.listComments(id);
  }

  @Post(":id/comments")
  @Roles(UserRole.OPERATOR)
  addComment(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: { content: string },
  ) {
    return this.customersService.addComment(id, user.sub, dto.content);
  }

  @Delete(":id/comments/:cid")
  @Roles(UserRole.OPERATOR)
  deleteComment(@Param("id") id: string, @Param("cid") cid: string) {
    return this.customersService.deleteComment(id, cid);
  }

  // ─── Income Chart ─────────────────────────────────────────────────────────

  @Get(":id/income-chart")
  @Roles(UserRole.OPERATOR)
  getIncomeChart(@Param("id") id: string) {
    return this.customersService.getIncomeChart(id);
  }

  // ─── Buyer Portal Management ──────────────────────────────────────────────

  @Post(":id/portal-invite")
  @Roles(UserRole.OPERATOR)
  sendPortalInvite(
    @Param("id") id: string,
    @Body() dto: PortalInviteDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.customersService.sendPortalInvite(id, dto, user.tenantId!);
  }

  @Post(":id/portal-resend")
  @Roles(UserRole.OPERATOR)
  resendPortalInvite(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.customersService.resendPortalInvite(id, user.tenantId!);
  }

  @Post(":id/portal-disconnect")
  @Roles(UserRole.OPERATOR)
  disconnectPortal(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.customersService.disconnectPortal(id, user.tenantId!);
  }

  @Get(":id/portal-status")
  @Roles(UserRole.OPERATOR)
  getPortalStatus(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.customersService.getPortalStatus(id, user.tenantId!);
  }

  @Post(":id/portal-approve")
  @Roles(UserRole.OPERATOR)
  approveBuyerRequest(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.customersService.approveBuyerRequest(id, user.tenantId!);
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  @Delete(":id")
  @Roles(UserRole.OPERATOR)
  remove(@Param("id") id: string) {
    return this.customersService.deleteCustomer(id);
  }

  // ─── Suggest buyer account merge ──────────────────────────────────────────

  @Post("suggest-merge")
  @Roles(UserRole.OPERATOR)
  @HttpCode(200)
  suggestMerge(
    @Body() dto: { primaryCustomerId: string; secondaryCustomerId: string; notes?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.customersService.suggestMerge(
      user.tenantId!,
      dto.primaryCustomerId,
      dto.secondaryCustomerId,
      dto.notes,
    );
  }

  // ── Tax-exempt document endpoints ────────────────────────────────────────────

  @Get(":id/tax-documents")
  @Roles(UserRole.OPERATOR)
  getTaxDocuments(@Param("id") id: string) {
    return this.customersService.getTaxDocumentUrls(id);
  }

  @Post(":id/tax-documents")
  @Roles(UserRole.OPERATOR)
  @UseInterceptors(
    FilesInterceptor("files", 5, {
      storage: memoryStorage(),
      limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB (frontend compresses first)
      fileFilter: (_req, file, cb) => {
        cb(null, file.mimetype.startsWith("image/"));
      },
    }),
  )
  async uploadTaxDocuments(@Param("id") id: string, @UploadedFiles() files: Express.Multer.File[]) {
    const results = await Promise.all(
      files.map((f) =>
        this.customersService.uploadTaxDocument(id, f.buffer, f.originalname, f.mimetype),
      ),
    );
    return { uploaded: results };
  }

  @Delete(":id/tax-documents")
  @Roles(UserRole.OPERATOR)
  @HttpCode(204)
  deleteTaxDocument(@Param("id") id: string, @Body() dto: { key: string }) {
    return this.customersService.deleteTaxDocument(id, dto.key);
  }

  // ── Generic customer documents (tax forms, agreements, other) ──────────────

  @Get(":id/documents")
  @Roles(UserRole.OPERATOR)
  listCustomerDocuments(@Param("id") id: string) {
    return this.customersService.listCustomerDocuments(id);
  }

  @Post(":id/documents")
  @Roles(UserRole.OPERATOR)
  @UseInterceptors(
    FilesInterceptor("files", 10, {
      storage: memoryStorage(),
      limits: { fileSize: 15 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const ok = file.mimetype.startsWith("image/") || file.mimetype === "application/pdf";
        cb(null, ok);
      },
    }),
  )
  async uploadCustomerDocuments(
    @Param("id") id: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: { docType?: string },
    @CurrentUser() user: JwtPayload,
  ) {
    const docType = (body?.docType || "Other").trim() || "Other";
    const results = await Promise.all(
      files.map((f) =>
        this.customersService.uploadCustomerDocument(
          id,
          f.buffer,
          f.originalname,
          f.mimetype,
          docType,
          user.sub,
        ),
      ),
    );
    return { uploaded: results };
  }

  @Delete(":id/documents/:docId")
  @Roles(UserRole.OPERATOR)
  @HttpCode(204)
  deleteCustomerDocument(@Param("id") id: string, @Param("docId") docId: string) {
    return this.customersService.deleteCustomerDocument(id, docId);
  }
}
