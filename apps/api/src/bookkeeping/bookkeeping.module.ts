import { Module } from '@nestjs/common';
import { BookkeepingController } from './bookkeeping.controller';
import { BookkeepingService } from './bookkeeping.service';

@Module({
  controllers: [BookkeepingController],
  providers: [BookkeepingService],
  exports: [BookkeepingService],
})
export class BookkeepingModule {}
