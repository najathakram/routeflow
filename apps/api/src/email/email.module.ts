import { Module, forwardRef } from "@nestjs/common";
import { EmailService } from "./email.service";
import { EmailDeliveryService } from "./email-delivery.service";
import { EmailDeliveryPruneService } from "./email-delivery-prune.service";
import { MailboxModule } from "./mailbox/mailbox.module";
import { MailboxAlertService } from "./mailbox/mailbox-alert.service";
import { NotificationsModule } from "../notifications/notifications.module";

// PrismaModule and CommonModule (EncryptionService) are global — no explicit imports needed.
// `forwardRef` breaks the BillingModule → EmailModule → MailboxModule → BillingModule cycle —
// see MailboxModule's doc comment.
//
// F-10a: `MailboxAlertService` lives here, not in MailboxModule, because it emails through
// `EmailService` (which depends on MailboxModule's `MailboxSendService`) — providing it in
// MailboxModule would need MailboxModule to import EmailModule back. It subscribes to
// `MailboxSendService.onStateChange` at module init, so the provider graph stays acyclic.
// `NotificationsModule` supplies `NotificationsService` for the in-app notification.
@Module({
  imports: [forwardRef(() => MailboxModule), NotificationsModule],
  providers: [EmailService, MailboxAlertService, EmailDeliveryService, EmailDeliveryPruneService],
  exports: [EmailService, EmailDeliveryService],
})
export class EmailModule {}
