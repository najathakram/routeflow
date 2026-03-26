import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { CustomersService } from "./customers.service";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";
import { ChangeCustomerStatusDto } from "./dto/change-customer-status.dto";
import { CreateAddressDto } from "./dto/create-address.dto";
import { UpdateAddressDto } from "./dto/update-address.dto";
import { ListCustomersDto } from "./dto/list-customers.dto";

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

  @Get(":id")
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
}
