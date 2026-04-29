import { Module } from "@nestjs/common";
import { OrderTemplatesService } from "./order-templates.service";
import { OrderTemplatesController } from "./order-templates.controller";
import { OrdersModule } from "../orders/orders.module";

@Module({
  imports: [OrdersModule],
  controllers: [OrderTemplatesController],
  providers: [OrderTemplatesService],
  exports: [OrderTemplatesService],
})
export class OrderTemplatesModule {}
