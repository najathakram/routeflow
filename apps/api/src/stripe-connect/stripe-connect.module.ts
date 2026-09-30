import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { StripeConnectService } from "./stripe-connect.service";
import { CONNECT_OAUTH_PROVIDER } from "./provider/connect-oauth.interface";
import { StripeConnectOAuthProvider } from "./provider/stripe-connect-oauth.provider";
import {
  StripeConnectCallbackController,
  StripeConnectController,
} from "./stripe-connect.controller";

/**
 * Deliberately does NOT import BillingModule (invariant 4): OAuth linking runs
 * through the CONNECT_OAUTH_PROVIDER port, whose adapter builds its own Stripe
 * client from env rather than borrowing the SaaS billing module's
 * StripeService. PaymentRequestsModule imports this module, so that borrow
 * would have re-coupled buyer card payments to platform billing through the
 * back door.
 */
@Module({
  imports: [
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
  providers: [
    StripeConnectService,
    { provide: CONNECT_OAUTH_PROVIDER, useClass: StripeConnectOAuthProvider },
  ],
  // PaymentRequests gates buyer card actions on chargeableAccount().
  exports: [StripeConnectService],
})
export class StripeConnectModule {}
