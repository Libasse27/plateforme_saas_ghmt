import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Env } from '../../infrastructure/config/env';
import { DEFAULT_RATE_LIMIT, buildThrottlerOptions } from './throttler-options';

const MEMORY_ENV = { RATE_LIMIT_STORE: 'memory', RATE_LIMIT_KEY_PREFIX: 'ghmt:rl:' } as unknown as Env;
const context = {} as ExecutionContext;

describe('buildThrottlerOptions', () => {
  it('le limiteur par IP regroupe les IPv6 par /64 et ramène l’IPv4 encapsulée à l’IPv4', async () => {
    const tracker = DEFAULT_RATE_LIMIT.getTracker;

    expect(await tracker({ ip: '2001:db8:abcd:12::1' }, context)).toBe('2001:db8:abcd:12::/64');
    expect(await tracker({ ip: '2001:db8:abcd:12:ffff::9' }, context)).toBe('2001:db8:abcd:12::/64');
    expect(await tracker({ ip: '::ffff:198.51.100.4' }, context)).toBe('198.51.100.4');
    expect(await tracker({ ip: '198.51.100.4' }, context)).toBe('198.51.100.4');
  });

  it('déclare le limiteur par IP et le limiteur « compte », avec un stockage', () => {
    const options = buildThrottlerOptions(MEMORY_ENV);

    expect(Array.isArray(options)).toBe(false);
    if (Array.isArray(options)) return;
    expect(options.throttlers.map((t) => t.name ?? 'default')).toEqual(['default', 'account']);
    expect(options.storage).toBeDefined();
  });
});
