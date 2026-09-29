import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Documentation-only shape. Validation is done by `validateCreateUrlInput` so that every rule
 * is a plain function with its own tests rather than decorator metadata.
 */
export class CreateUrlDto {
  @ApiProperty({
    description:
      'Absolute http or https URL. Must not point at this service. Maximum 2048 characters.',
    example: 'https://example.com/a/very/long/path',
    maxLength: 2048,
  })
  url!: string;

  @ApiPropertyOptional({
    description:
      'ISO 8601 timestamp with a time zone. Must be in the future. Omit for a link that never expires.',
    example: '2027-01-01T00:00:00.000Z',
    format: 'date-time',
    nullable: true,
    type: String,
  })
  expiresAt?: string | null;
}
