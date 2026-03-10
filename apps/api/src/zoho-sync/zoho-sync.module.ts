import { Module } from '@nestjs/common';
import { ZohoSyncController } from './zoho-sync.controller';
import { ZohoSyncService } from './zoho-sync.service';

@Module({
  controllers: [ZohoSyncController],
  providers: [ZohoSyncService],
  exports: [ZohoSyncService],
})
export class ZohoSyncModule {}
