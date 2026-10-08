import { Module } from "@nestjs/common";
import { EntitlementsModule } from "../billing/entitlements.module";
import { UnitsController } from "./units.controller";
import { UnitsService } from "./units.service";

@Module({
  imports: [EntitlementsModule],
  controllers: [UnitsController],
  providers: [UnitsService],
  exports: [UnitsService],
})
export class UnitsModule {}
