import { isPrettyTransportAvailable } from './logger.module';

describe('isPrettyTransportAvailable', () => {
  it('is true when pino-pretty resolves, as in a dev install', () => {
    expect(isPrettyTransportAvailable()).toBe(true);
  });

  it('is false when pino-pretty is absent, as in a production image', () => {
    const missing = () => {
      throw Object.assign(new Error("Cannot find module 'pino-pretty'"), {
        code: 'MODULE_NOT_FOUND',
      });
    };
    expect(isPrettyTransportAvailable(missing)).toBe(false);
  });
});
