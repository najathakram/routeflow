import { Module, forwardRef } from "@nestjs/common";
import { EmailService } from "./email.service";
import { SystemConfigModule } from "../system-config/system-config.module";

@Module({
  imports: [forwardRef(() => SystemConfigModule)],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
