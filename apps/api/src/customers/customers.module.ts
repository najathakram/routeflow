import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { CustomersController } from "./customers.controller";
import { CustomersService } from "./customers.service";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule, ConfigModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
