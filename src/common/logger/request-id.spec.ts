import type { IncomingMessage, ServerResponse } from 'node:http';
import { REQUEST_ID_HEADER, assignRequestId } from './request-id';

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    headers,
    headersSent: false,
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
  } as unknown as ServerResponse & { headers: Record<string, string> };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('assignRequestId', () => {
  it('generates a UUID and echoes it on the response', () => {
    const res = fakeRes();
    const id = assignRequestId(fakeReq(), res, false);
    expect(id).toMatch(UUID);
    expect(res.headers[REQUEST_ID_HEADER]).toBe(id);
  });

  it('is idempotent: a second call returns the first id', () => {
    const req = fakeReq();
    const res = fakeRes();
    const first = assignRequestId(req, res, false);
    expect(assignRequestId(req, res, false)).toBe(first);
  });

  it('ignores an incoming header when no proxy is trusted', () => {
    const id = assignRequestId(fakeReq({ [REQUEST_ID_HEADER]: 'from-client' }), fakeRes(), false);
    expect(id).not.toBe('from-client');
    expect(id).toMatch(UUID);
  });

  it('honours an incoming header behind a trusted proxy', () => {
    const id = assignRequestId(
      fakeReq({ [REQUEST_ID_HEADER]: 'Root=1-67891233-abcdef012345678912345678' }),
      fakeRes(),
      true,
    );
    expect(id).toBe('Root=1-67891233-abcdef012345678912345678');
  });

  it.each([
    ['too long', 'a'.repeat(129)],
    ['newline injection', 'abc\n{"level":"fatal"}'],
    ['spaces', 'a b c'],
    ['empty', ''],
  ])('rejects a %s incoming header even behind a trusted proxy', (_name, value) => {
    const id = assignRequestId(fakeReq({ [REQUEST_ID_HEADER]: value }), fakeRes(), true);
    expect(id).toMatch(UUID);
  });
});
