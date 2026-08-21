import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { BillingModule } from "../billing/billing.module";
import { StripeConnectService } from "./stripe-connect.service";
import {
  StripeConnectCallbackController,
  StripeConnectController,
} from "./stripe-connect.controller";

@Module({
  imports: [
    BillingModule,
    // Signs the Connect OAuth `state` (15-min tenant-bound token). Same secret
    // as auth so nothing new to provision.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>("jwt.secret"),
      }),
    }),
  ],
  controllers: [StripeConnectController, StripeConnectCallbackController],
  providers: [StripeConnectService],
  // PaymentRequests gates buyer card actions on chargeableAccount().
  exports: [StripeConnectService],
})
export class StripeConnectModule {}
