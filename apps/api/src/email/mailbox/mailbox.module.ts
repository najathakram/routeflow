import { Module, forwardRef } from "@nestjs/common";
import { BillingModule } from "../../billing/billing.module";
import { MailboxController } from "./mailbox.controller";
import { MailboxConnectionService } from "./mailbox-connection.service";
import { MailboxSendService } from "./mailbox-send.service";

/**
 * PrismaModule/CommonModule (EncryptionService)/AuditModule are @Global — no explicit imports
 * needed. `BillingModule` is required so `MailboxController`'s `@UseGuards(AddonGuard)` can
 * resolve `AddonService`/`AddonGuard` from this module's scope (same boot-time requirement
 * `CrmModule` documents). `forwardRef` on both ends breaks the cycle this creates:
 * `BillingModule` → `EmailModule` (billing notifications) → `MailboxModule` (for
 * `MailboxSendService`, injected into `EmailService.send()`) → `BillingModule` (for
 * `AddonGuard`) — see the matching `forwardRef` in `billing.module.ts` and `email.module.ts`.
 *
 * F-10a: `MailboxSendService` writes the `mailbox.revoked_detected` / `mailbox.throttled_detected`
 * audit rows itself, in the same transaction as the status change they record; the admin
 * notifications come from `MailboxAlertService`, which EmailModule provides (it needs
 * `EmailService`) and which subscribes to `MailboxSendService.onStateChange`.
 */
@Module({
  imports: [forwardRef(() => BillingModule)],
  controllers: [MailboxController],
  providers: [MailboxConnectionService, MailboxSendService],
  exports: [MailboxSendService, MailboxConnectionService],
})
export class MailboxModule {}
