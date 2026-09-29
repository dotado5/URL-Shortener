import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

export { ConfigModule } from './config.module';
export { envSchema, validateEnv, EnvValidationError } from './env.schema';
export type { Env } from './env.schema';

/** Typed alias so injection sites read `AppConfig` instead of `ConfigService<Env, true>`. */
export type AppConfig = ConfigService<Env, true>;
