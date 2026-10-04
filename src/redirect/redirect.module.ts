import { Module } from '@nestjs/common';
import { QueueProducersModule } from '../queues/queues.module';
import { RedirectController } from './redirect.controller';
import { RedirectService } from './redirect.service';

@Module({
  imports: [QueueProducersModule],
  controllers: [RedirectController],
  providers: [RedirectService],
})
export class RedirectModule {}
