import { Global, Module } from "@nestjs/common";
import { EncryptionService } from "./encryption.service";
import { IdempotencyService } from "./idempotency.service";

/**
 * Global module exposing platform-level utilities (encryption, idempotency, etc.)
 * Marked @Global so any module can inject these without re-importing. PrismaModule
 * is @Global too, so IdempotencyService resolves with no extra wiring.
 */
@Global()
@Module({
  providers: [EncryptionService, IdempotencyService],
  exports: [EncryptionService, IdempotencyService],
})
export class CommonModule {}
