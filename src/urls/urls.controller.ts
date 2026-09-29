import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiInternalServerErrorResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CreateUrlDto } from './dto/create-url.dto';
import { CreatedUrlDto, ErrorDto, UrlInfoDto } from './dto/url-response.dto';
import { UrlsService } from './urls.service';

@ApiTags('urls')
@Controller('api/urls')
export class UrlsController {
  constructor(private readonly urls: UrlsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Create a short URL',
    description:
      'Every call creates a new short code, even for a URL that was shortened before. ' +
      'The response includes a deleteToken that is shown once.',
  })
  @ApiBody({ type: CreateUrlDto })
  @ApiCreatedResponse({ type: CreatedUrlDto })
  @ApiBadRequestResponse({ type: ErrorDto, description: 'Validation failed' })
  @ApiPayloadTooLargeResponse({ type: ErrorDto, description: 'Body exceeds BODY_LIMIT' })
  @ApiInternalServerErrorResponse({ type: ErrorDto })
  create(@Body() body: unknown): Promise<CreatedUrlDto> {
    return this.urls.create(body);
  }

  @Get(':shortCode')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Inspect a short URL',
    description:
      'Returns 200 for expired and deleted URLs so their state can be inspected. ' +
      'Reads PostgreSQL directly and is never cached.',
  })
  @ApiParam({ name: 'shortCode', example: 'a8K2xPq' })
  @ApiOkResponse({ type: UrlInfoDto })
  @ApiNotFoundResponse({ type: ErrorDto, description: 'Unknown or malformed short code' })
  getInfo(@Param('shortCode') shortCode: string): Promise<UrlInfoDto> {
    return this.urls.getInfo(shortCode);
  }

  @Delete(':shortCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Delete a short URL',
    description:
      'Soft delete: the redirect starts returning 410 and the info endpoint reports status ' +
      '"deleted". Idempotent: repeating the call with a valid token returns 204 again.',
  })
  @ApiParam({ name: 'shortCode', example: 'a8K2xPq' })
  @ApiHeader({
    name: 'X-Delete-Token',
    required: true,
    description: 'The deleteToken returned when the URL was created',
  })
  @ApiNoContentResponse({ description: 'Deleted, or already deleted' })
  @ApiForbiddenResponse({ type: ErrorDto, description: 'Missing or wrong delete token' })
  @ApiNotFoundResponse({ type: ErrorDto, description: 'Unknown or malformed short code' })
  async remove(
    @Param('shortCode') shortCode: string,
    @Headers('x-delete-token') token: string | undefined,
  ): Promise<void> {
    await this.urls.delete(shortCode, token);
  }
}
