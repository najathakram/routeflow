import { Module } from "@nestjs/common";
import { OrderTemplatesService } from "./order-templates.service";
import { OrderTemplatesController } from "./order-templates.controller";

@Module({
  controllers: [OrderTemplatesController],
  providers: [OrderTemplatesService],
  exports: [OrderTemplatesService],
})
export class OrderTemplatesModule {}
