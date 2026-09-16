import { Module } from "@nestjs/common";
import { MessagingService } from "./messaging.service";
import { MessagingConfigService } from "./messaging-config.service";
import { MessagingController } from "./messaging.controller";
import { MESSAGE_PROVIDER } from "./providers/message-provider.interface";
import { EmailChannelProvider } from "./providers/email-channel.provider";
import { EntitlementsModule } from "../billing/entitlements.module";
import { EmailModule } from "../email/email.module";

/**
 * P6-2 messaging engine. MESSAGE_PROVIDER → `EmailChannelProvider` (N1) — a
 * real EMAIL transport backed by `EmailService`; every other channel
 * (WhatsApp/SMS/PORTAL) stays NO_TRANSPORT exactly as `StubProvider` left it
 * (`EmailChannelProvider.transports()` declares EMAIL only), so this is a
 * pure upgrade, not a regression for the other channels — P6-3/P6-4 will
 * still swap in real Meta-WA/Twilio adapters at this same token.
 * EntitlementsModule supplies MeterService for MSGS metering. EmailModule
 * supplies EmailService for the new provider. Exports the engine so trigger
 * wiring (P6-5) can call `notify()`. MessagingConfigService (P6-6) owns the
 * event×channel rules matrix + template CRUD + settings the engine consults.
 */
@Module({
  imports: [EntitlementsModule, EmailModule],
  controllers: [MessagingController],
  providers: [
    MessagingService,
    MessagingConfigService,
    { provide: MESSAGE_PROVIDER, useClass: EmailChannelProvider },
  ],
  exports: [MessagingService, MessagingConfigService],
})
export class MessagingModule {}
