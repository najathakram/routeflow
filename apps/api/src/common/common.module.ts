import { Global, Module } from "@nestjs/common";
import { EncryptionService } from "./encryption.service";
import { IdempotencyService } from "./idempotency.service";

/**
 * Global module exposing platform-level utilities (encryption, idempotency, etc.)
 * Marked @Global so any module can inject these without re-importing. IdempotencyService takes
 * no constructor dependencies of its own (F5 round 2, N1) — every caller supplies its own
 * transaction client, so there is nothing here to wire up beyond the provider itself.
 */
@Global()
@Module({
  providers: [EncryptionService, IdempotencyService],
  exports: [EncryptionService, IdempotencyService],
})
export class CommonModule {}
