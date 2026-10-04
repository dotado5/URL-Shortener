import { Controller, Get, GoneException, NotFoundException, Param, Req, Res } from '@nestjs/common';
import {
  ApiFoundResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { clientIp } from '../common/utils/ip';
import { AnalyticsProducer } from '../queues/analytics/analytics.producer';
import { ErrorDto } from '../urls/dto/url-response.dto';
import { RedirectService } from './redirect.service';

export const REDIRECT_CACHE_CONTROL = 'private, no-store';

/**
 * Root-level catch-all. It must be registered after every other controller, which is why
 * RedirectModule is imported last in AppModule. Express answers HEAD from this GET handler;
 * HEAD responses do not produce a click.
 */
@ApiTags('redirect')
@Controller()
export class RedirectController {
  constructor(
    private readonly redirects: RedirectService,
    private readonly analytics: AnalyticsProducer,
  ) {}

  @Get(':shortCode')
  @ApiOperation({
    summary: 'Follow a short URL',
    description:
      'Returns 302 with the destination in Location. Every response from this route, including ' +
      'errors, carries Cache-Control: private, no-store so browsers and CDNs never cache the ' +
      'redirect and deletion or expiry take effect immediately.',
  })
  @ApiParam({ name: 'shortCode', example: 'a8K2xPq' })
  @ApiFoundResponse({
    description: 'Redirect to the original URL',
    headers: {
      Location: { description: 'The original URL', schema: { type: 'string' } },
      'Cache-Control': { schema: { type: 'string', example: REDIRECT_CACHE_CONTROL } },
    },
  })
  @ApiNotFoundResponse({ type: ErrorDto, description: 'Unknown or malformed short code' })
  @ApiGoneResponse({ type: ErrorDto, description: 'The short URL has expired or been deleted' })
  async follow(
    @Param('shortCode') shortCode: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Set before any throw so error responses from the exception filter carry it too.
    res.setHeader('Cache-Control', REDIRECT_CACHE_CONTROL);

    const result = await this.redirects.resolve(shortCode);
    switch (result.kind) {
      case 'redirect':
        // The URL was normalised by the WHATWG parser at creation, so it is already encoded and
        // free of control characters. Set Location directly instead of res.redirect(), which would
        // re-encode it and write an HTML body nobody reads.
        res.status(302).setHeader('Location', result.location);
        res.end();
        // After the response is sent, never awaited (D10). HEAD is a probe, not a click.
        if (req.method === 'GET') {
          this.analytics.record({
            shortCode,
            ip: clientIp(req),
            userAgent: req.headers['user-agent'],
            referer: req.headers.referer,
          });
        }
        return;
      case 'expired':
        throw new GoneException('This short URL has expired');
      case 'deleted':
        throw new GoneException('This short URL has been deleted');
      case 'not_found':
        throw new NotFoundException('Short URL not found');
    }
  }
}
