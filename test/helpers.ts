import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module';
import { createApp, setupSwagger } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';

/** Builds the same app `main.ts` does, minus `listen`, so e2e tests exercise real middleware. */
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
