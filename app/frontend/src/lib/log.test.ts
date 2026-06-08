import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Wails runtime log functions so we can assert forwarding.
// vi.hoisted keeps the spies available to the hoisted vi.mock factory.
const mocks = vi.hoisted(() => ({
  LogDebug: vi.fn(),
  LogInfo: vi.fn(),
  LogWarning: vi.fn(),
  LogError: vi.fn(),
}));
vi.mock('../../wailsjs/runtime/runtime', () => mocks);

import { log, installGlobalHandlers } from './log';

describe('log wrapper', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockClear());
  });

  it('forwards each level to the matching runtime fn', () => {
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(mocks.LogDebug).toHaveBeenCalledWith('d');
    expect(mocks.LogInfo).toHaveBeenCalledWith('i');
    expect(mocks.LogWarning).toHaveBeenCalledWith('w');
    expect(mocks.LogError).toHaveBeenCalledWith('e');
  });

  it('joins mixed args and includes Error stacks', () => {
    log.info('count', 3, { a: 1 });
    expect(mocks.LogInfo).toHaveBeenCalledWith('count 3 {"a":1}');

    const err = new Error('boom');
    log.error('failed:', err);
    const arg = mocks.LogError.mock.calls[0][0] as string;
    expect(arg).toContain('failed:');
    expect(arg).toContain('boom');
  });

  it('forwards uncaught errors and unhandled rejections to LogError', () => {
    installGlobalHandlers();

    window.dispatchEvent(new ErrorEvent('error', { message: 'window blew up' }));
    expect(mocks.LogError.mock.calls.some((c) => String(c[0]).includes('uncaught error'))).toBe(true);

    // PromiseRejectionEvent isn't in jsdom; synthesize the shape the handler reads.
    const evt = new Event('unhandledrejection') as Event & { reason?: unknown };
    evt.reason = new Error('rejected');
    window.dispatchEvent(evt);
    expect(mocks.LogError.mock.calls.some((c) => String(c[0]).includes('unhandled rejection'))).toBe(true);
  });
});
