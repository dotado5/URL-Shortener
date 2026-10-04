import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule, ConfigService } from '@nestjs/config';
import { validateEnv } from './env.schema';

/**
 * Wraps @nestjs/config so that every consumer gets a validated, typed `ConfigService<Env, true>`.
 * `.env` is loaded only outside production; production reads the real process environment.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      ignoreEnvFile: process.env.NODE_ENV === 'production',
      // Tests read only .env.test so a developer's local .env can never leak into them.
      envFilePath: process.env.NODE_ENV === 'test' ? ['.env.test'] : ['.env'],
    }),
  ],
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
