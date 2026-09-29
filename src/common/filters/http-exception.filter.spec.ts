import { BadRequestException, GoneException, NotFoundException } from '@nestjs/common';
import { toErrorBody } from './http-exception.filter';

describe('toErrorBody', () => {
  it('maps an HttpException with a string message', () => {
    expect(toErrorBody(new NotFoundException('Short URL not found'))).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Short URL not found',
    });
  });

  it('keeps an array message from validation errors', () => {
    const e = new BadRequestException(['url must be a URL', 'expiresAt must be in the future']);
    expect(toErrorBody(e)).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: ['url must be a URL', 'expiresAt must be in the future'],
    });
  });

  it('uses the reason phrase for 410', () => {
    expect(toErrorBody(new GoneException('This short URL has expired'))).toMatchObject({
      statusCode: 410,
      error: 'Gone',
    });
  });

  it('preserves a 4xx status from express middleware errors such as body-parser', () => {
    const e = Object.assign(new Error('request entity too large'), {
      status: 413,
      type: 'entity.too.large',
    });
    expect(toErrorBody(e)).toEqual({
      statusCode: 413,
      error: 'Payload Too Large',
      message: 'Payload Too Large',
    });
  });

  it('hides details of unexpected errors', () => {
    const body = toErrorBody(new Error('connection refused to 10.0.0.5:5432'));
    expect(body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
    });
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });

  it('treats non-error throws as 500', () => {
    expect(toErrorBody('boom').statusCode).toBe(500);
    expect(toErrorBody(undefined).statusCode).toBe(500);
  });
});
