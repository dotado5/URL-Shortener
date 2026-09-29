import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { createApp, installShutdownHandlers, setupSwagger } from './bootstrap';
import type { Env } from './config/env.schema';

async function main(): Promise<void> {
  const app = await createApp(AppModule);
  setupSwagger(app);
  installShutdownHandlers(app, 'api');

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  app.get(Logger).log(`API listening on port ${port}`, 'Bootstrap');
}

main().catch((err: unknown) => {
  // Config validation and other boot failures land here before any logger exists.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
