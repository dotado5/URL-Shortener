import { Controller, Get, Header, HttpStatus, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { HealthService } from './health.service';

/**
 * Liveness: is the process alive. Never touches dependencies.
 * Readiness: can it serve traffic. Only a critical dependency (PostgreSQL) yields 503;
 * Redis being down yields 200 + "degraded" because redirects fall back to the database.
 */
@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @Header('Cache-Control', 'no-store')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready(@Res() res: Response): Promise<void> {
    const report = await this.health.readiness();
    const code = report.status === 'down' ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK;
    res.status(code).json(report);
  }
}
