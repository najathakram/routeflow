import { Global, Module } from "@nestjs/common";
import { EncryptionService } from "./encryption.service";

/**
 * Global module exposing platform-level utilities (encryption, etc.)
 * Marked @Global so any module can inject EncryptionService without re-importing.
 */
@Global()
@Module({
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class CommonModule {}
