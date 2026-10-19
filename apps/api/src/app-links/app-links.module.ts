import { Module } from "@nestjs/common";
import { PlatformAdminModule } from "../platform-admin/platform-admin.module";
import { AppLinksController } from "./app-links.controller";

/**
 * Imports PlatformAdminModule for its exported PlatformConfigService (the one reader of the app-link
 * rows). PlatformAdminModule imports only Email and Billing and nothing imports this module back, so
 * there is no cycle and no second Prisma reader to keep in step with the validator.
 */
@Module({
  imports: [PlatformAdminModule],
  controllers: [AppLinksController],
})
export class AppLinksModule {}
