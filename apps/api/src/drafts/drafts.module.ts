import { Module } from "@nestjs/common";
import { DraftsController } from "./drafts.controller";
import { DraftsService } from "./drafts.service";

// PrismaModule is @Global, so PrismaService is available without importing it.
@Module({
  controllers: [DraftsController],
  providers: [DraftsService],
  exports: [DraftsService],
})
export class DraftsModule {}
