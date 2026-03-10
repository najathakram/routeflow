import { Module } from '@nestjs/common';
import { BookkeepingService } from './bookkeeping.service';
import { BookkeepingController } from './bookkeeping.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [BookkeepingController],
  providers: [BookkeepingService],
})
export class BookkeepingModule {}
