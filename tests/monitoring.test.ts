import { describe, expect, test } from 'bun:test';
import * as Sentry from '@sentry/bun';
import { captureError, initMonitoring, resolveMonitoringConfig } from '../src/server/monitoring.ts';

// The enabled path is intentionally not exercised here: it would create a real
// Sentry client. These tests cover the disabled default and config parsing,
// which is what keeps fixture/test runs from ever sending events.
describe('server monitoring', () => {
  test('disabled when JUKEBOX_SENTRY_DSN is unset or blank', () => {
    expect(resolveMonitoringConfig({})).toBeNull();
    expect(resolveMonitoringConfig({ JUKEBOX_SENTRY_DSN: '   ' })).toBeNull();
    expect(initMonitoring({})).toBe(false);
    expect(Sentry.isEnabled()).toBe(false);
    expect(() => captureError(new Error('no-op'), { source: 'test' })).not.toThrow();
  });

  test('parses DSN, environment, release and traces rate', () => {
    const config = resolveMonitoringConfig({
      JUKEBOX_SENTRY_DSN: 'https://key@o123.ingest.us.sentry.io/456',
      JUKEBOX_SENTRY_ENVIRONMENT: 'venue',
      JUKEBOX_SENTRY_RELEASE: 'nightly-1',
      JUKEBOX_SENTRY_TRACES_SAMPLE_RATE: '0.25',
    });
    expect(config).toEqual({
      dsn: 'https://key@o123.ingest.us.sentry.io/456',
      environment: 'venue',
      release: 'nightly-1',
      tracesSampleRate: 0.25,
    });
  });

  test('environment defaults from NODE_ENV and rate is clamped', () => {
    expect(resolveMonitoringConfig({ JUKEBOX_SENTRY_DSN: 'https://k@o/1', NODE_ENV: 'production' })?.environment).toBe('production');
    expect(resolveMonitoringConfig({ JUKEBOX_SENTRY_DSN: 'https://k@o/1' })?.environment).toBe('development');
    expect(resolveMonitoringConfig({ JUKEBOX_SENTRY_DSN: 'https://k@o/1', JUKEBOX_SENTRY_TRACES_SAMPLE_RATE: '5' })?.tracesSampleRate).toBe(1);
    expect(resolveMonitoringConfig({ JUKEBOX_SENTRY_DSN: 'https://k@o/1', JUKEBOX_SENTRY_TRACES_SAMPLE_RATE: 'nope' })?.tracesSampleRate).toBe(0);
    expect(resolveMonitoringConfig({ JUKEBOX_SENTRY_DSN: 'https://k@o/1' })?.release).toBeUndefined();
  });
});
