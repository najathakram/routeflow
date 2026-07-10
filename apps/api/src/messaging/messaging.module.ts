import { Module } from "@nestjs/common";
import { MessagingService } from "./messaging.service";
import { MessagingController } from "./messaging.controller";
import { MESSAGE_PROVIDER } from "./providers/message-provider.interface";
import { StubProvider } from "./providers/stub.provider";
import { EntitlementsModule } from "../billing/entitlements.module";

/**
 * P6-2 messaging engine. Binds MESSAGE_PROVIDER → StubProvider (P6-3/P6-4 swap
 * in real Meta-WA/Twilio adapters here). EntitlementsModule supplies
 * MeterService for MSGS metering. Exports the engine so future trigger wiring
 * (P6-5) can call `notify()`.
 */
@Module({
  imports: [EntitlementsModule],
  controllers: [MessagingController],
  providers: [MessagingService, { provide: MESSAGE_PROVIDER, useClass: StubProvider }],
  exports: [MessagingService],
})
export class MessagingModule {}
