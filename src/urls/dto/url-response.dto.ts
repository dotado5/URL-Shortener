import { ApiProperty } from '@nestjs/swagger';
import type { UrlStatus } from '../url-status';

export class CreatedUrlDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'a8K2xPq' })
  shortCode!: string;

  @ApiProperty({ example: 'https://short.ly/a8K2xPq' })
  shortUrl!: string;

  @ApiProperty({ example: 'https://example.com/a/very/long/path' })
  originalUrl!: string;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  expiresAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({
    description:
      'Required in the X-Delete-Token header to delete this URL. Shown once; only its hash is stored, so it cannot be recovered.',
    example: 'q0tq2v0mB1m7b6mJ3m1m0Yc0r0v4l5yXoQJr8a7b9cE',
  })
  deleteToken!: string;
}

export class UrlInfoDto {
  @ApiProperty({ example: 'a8K2xPq' })
  shortCode!: string;

  @ApiProperty({ example: 'https://example.com' })
  originalUrl!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  expiresAt!: string | null;

  @ApiProperty({
    description: 'Eventually consistent. Updated asynchronously by the analytics worker.',
    example: 153,
  })
  clickCount!: number;

  @ApiProperty({ enum: ['active', 'expired', 'deleted'] })
  status!: UrlStatus;
}

export class ErrorDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'Bad Request' })
  error!: string;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: ['url must use http or https'],
  })
  message!: string | string[];

  @ApiProperty({ format: 'uuid' })
  requestId!: string;
}
