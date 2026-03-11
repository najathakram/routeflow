import { Module } from "@nestjs/common";
import { ZohoSyncController } from "./zoho-sync.controller";
import { ZohoSyncService } from "./zoho-sync.service";
import { PrismaModule } from "../prisma/prisma.module";
import { SystemConfigModule } from "../system-config/system-config.module";

@Module({
  imports: [PrismaModule, SystemConfigModule],
  controllers: [ZohoSyncController],
  providers: [ZohoSyncService],
  exports: [ZohoSyncService],
})
export class ZohoSyncModule {}
