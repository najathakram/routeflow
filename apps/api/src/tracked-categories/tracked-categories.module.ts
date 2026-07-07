import { Module } from "@nestjs/common";
import { TrackedCategoriesController } from "./tracked-categories.controller";
import { TrackedCategoriesService } from "./tracked-categories.service";

@Module({
  controllers: [TrackedCategoriesController],
  providers: [TrackedCategoriesService],
  exports: [TrackedCategoriesService],
})
export class TrackedCategoriesModule {}
