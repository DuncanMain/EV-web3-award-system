import { Module } from '@nestjs/common';
import { SpendController } from './spend.controller';
import { SpendService } from './spend.service';

@Module({
  controllers: [SpendController],
  providers: [SpendService],
})
export class SpendModule {}
