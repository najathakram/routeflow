import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { OrdersService } from './orders.service';
import { OrdersController, RouteRunDeliveryController } from './orders.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule,
    BullModule.registerQueue({ name: 'invoices' }),
  ],
  controllers: [OrdersController, RouteRunDeliveryController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
