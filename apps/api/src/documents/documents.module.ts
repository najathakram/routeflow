import { Module } from "@nestjs/common";
import { EmailModule } from "../email/email.module";
import { ReceiptController } from "./receipt.controller";
import { ReceiptService } from "./receipt.service";

// PrismaModule is global. EmailModule supplies EmailService (the platform / tenant SMTP chain and the delivery log).
@Module({
  imports: [EmailModule],
  controllers: [ReceiptController],
  providers: [ReceiptService],
})
export class DocumentsModule {}
