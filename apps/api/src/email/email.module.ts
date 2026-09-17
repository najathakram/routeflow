import { Module, forwardRef } from "@nestjs/common";
import { EmailService } from "./email.service";
import { MailboxModule } from "./mailbox/mailbox.module";

// PrismaModule and CommonModule (EncryptionService) are global — no explicit imports needed.
// `forwardRef` breaks the BillingModule → EmailModule → MailboxModule → BillingModule cycle —
// see MailboxModule's doc comment.
@Module({
  imports: [forwardRef(() => MailboxModule)],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
