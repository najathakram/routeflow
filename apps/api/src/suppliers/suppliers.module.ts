import { Module } from "@nestjs/common";
import { SuppliersController } from "./suppliers.controller";
import { SuppliersService } from "./suppliers.service";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { EntitlementsModule } from "../billing/entitlements.module";

@Module({
  imports: [PrismaModule, AuthModule, EntitlementsModule],
  controllers: [SuppliersController],
  providers: [SuppliersService],
  exports: [SuppliersService],
})
export class SuppliersModule {}
