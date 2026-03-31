/// <reference types="multer" />
import {
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { UserRole } from "@prisma/client";
import { ImportService } from "./import.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

@Controller("import")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  @Post("contacts")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  importContacts(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: JwtPayload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.importService.importContacts(file.buffer, user.sub);
  }

  @Post("invoices")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 50 * 1024 * 1024 } }))
  importInvoices(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: JwtPayload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.importService.importInvoices(file.buffer, user.sub);
  }

  @Post("payments")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  importPayments(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: JwtPayload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.importService.importPayments(file.buffer, user.sub);
  }

  @Post("expenses")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  importExpenses(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: JwtPayload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.importService.importExpenses(file.buffer, user.sub);
  }

  @Post("products")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  importProducts(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: JwtPayload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.importService.importProducts(file.buffer, user.sub);
  }

  @Post("inventory")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  importInventory(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: JwtPayload) {
    if (!file) throw new BadRequestException("No file uploaded");
    return this.importService.importInventory(file.buffer, user.sub);
  }
}
