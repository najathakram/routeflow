import { Module } from "@nestjs/common";
import { EmailService } from "./email.service";

// PrismaModule and CommonModule (EncryptionService) are global — no explicit imports needed.
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
