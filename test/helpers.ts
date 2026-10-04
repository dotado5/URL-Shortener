import type { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { createApp, setupSwagger } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';

/** Builds the same app `main.ts` does so e2e tests exercise real middleware. */
export async function createTestApp(): Promise<NestExpressApplication> {
  const app = await createApp(AppModule);
  setupSwagger(app);
  // Listening on an ephemeral port lets supertest reuse one server instead of binding per request.
  await app.listen(0, '127.0.0.1');
  return app;
}

/** Empties every table between tests. Order follows foreign keys. */
export async function resetDatabase(app: NestExpressApplication): Promise<void> {
  const prisma = app.get(PrismaService);
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ClickEvent", "Url" RESTART IDENTITY CASCADE');
}

/**
 * Direct connection to the test Redis for resetting state and inspecting keys.
 * Separate from the app's client so assertions never go through the code under test.
 */
export function testRedis(): Redis {
  return new Redis(process.env.REDIS_URL!, { lazyConnect: false, maxRetriesPerRequest: 1 });
}

/** Reads one labelled sample from the app's Prometheus output. */
export async function metricValue(
  app: NestExpressApplication,
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const res = await request(app.getHttpServer()).get('/metrics');
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of res.text.split('\n')) {
    if (!line.startsWith(name)) continue;
    const [series, value] = line.split(' ');
    const bare = series === name || series.startsWith(`${name}{`);
    if (bare && wanted.every((w) => series.includes(w))) return Number(value);
  }
  return 0;
}
