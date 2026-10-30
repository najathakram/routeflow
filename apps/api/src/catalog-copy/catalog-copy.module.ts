import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { configuration } from "../config/configuration";
import { PrismaModule } from "../prisma/prisma.module";
import { CommonModule } from "../common/common.module";
import { TenantModule } from "../tenant/tenant.module";
import { AuditModule } from "../audit/audit.module";
import { StorageModule } from "../storage/storage.module";
import { ProductsModule } from "../products/products.module";
import { FeatureConfigModule } from "../billing/feature-config.module";
import { CatalogCopyService } from "./catalog-copy.service";

/**
 * SA-1027 rule 2: the script-only Nest module. It carries exactly what `ProductsService` needs to run the app's own
 * writers outside HTTP: config, Prisma, tenant context, audit, storage, the products module and the (global) feature
 * config. It is NEVER `AppModule` and never `ScheduleModule`, so no `@LeaderCron` job, no queue and no throttler
 * starts; `catalog-copy.module.spec.ts` pins that. The runner (`catalog-copy.runner.ts`) opens it with
 * `NestFactory.createApplicationContext`, which starts no HTTP server and no websocket server.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    PrismaModule,
    CommonModule,
    TenantModule,
    AuditModule,
    StorageModule,
    ProductsModule,
    FeatureConfigModule,
  ],
  providers: [CatalogCopyService],
  exports: [CatalogCopyService],
})
export class CatalogCopyModule {}
