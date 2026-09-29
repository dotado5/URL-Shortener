import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { createApp, installShutdownHandlers } from './bootstrap';
import type { Env } from './config/env.schema';
import { WorkerModule } from './worker.module';

async function main(): Promise<void> {
  const app = await createApp(WorkerModule);
  installShutdownHandlers(app, 'worker');

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('WORKER_HEALTH_PORT', { infer: true });
  await app.listen(port);
  app.get(Logger).log(`Worker health endpoint listening on port ${port}`, 'Bootstrap');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
