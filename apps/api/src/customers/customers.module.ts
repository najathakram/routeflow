import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { CustomersController } from "./customers.controller";
import { CustomersService } from "./customers.service";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [AuthModule, ConfigModule, StorageModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
