/**
 * Optional Sentry monitoring for the Bun authority process (and the dev/prod
 * supervisor). Everything is keyed off JUKEBOX_SENTRY_DSN: when it is unset or
 * blank, monitoring is fully disabled and these helpers are cheap no-ops, so
 * local tests and fixture runs never send events.
 */
import * as Sentry from '@sentry/bun';

export interface MonitoringConfig {
  dsn: string;
  environment: string;
  release?: string;
  tracesSampleRate: number;
}

function sampleRate(raw: string | undefined): number {
  if (!raw) return 0;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
}

export function resolveMonitoringConfig(env: Record<string, string | undefined> = process.env): MonitoringConfig | null {
  const dsn = env.JUKEBOX_SENTRY_DSN?.trim();
  if (!dsn) return null;
  // The container image bakes JUKEBOX_SENTRY_RELEASE from the (possibly empty)
  // SENTRY_RELEASE build arg, so treat blank as unset.
  const release = (env.JUKEBOX_SENTRY_RELEASE ?? env.SENTRY_RELEASE ?? '').trim();
  return {
    dsn,
    environment: env.JUKEBOX_SENTRY_ENVIRONMENT ?? env.SENTRY_ENVIRONMENT ?? (env.NODE_ENV === 'production' ? 'production' : 'development'),
    release: release || undefined,
    tracesSampleRate: sampleRate(env.JUKEBOX_SENTRY_TRACES_SAMPLE_RATE ?? env.SENTRY_TRACES_SAMPLE_RATE),
  };
}

/** Idempotent: safe to call from the supervisor and from createRuntime. */
export function initMonitoring(env: Record<string, string | undefined> = process.env): boolean {
  if (Sentry.isEnabled()) return true;
  const config = resolveMonitoringConfig(env);
  if (!config) return false;
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    tracesSampleRate: config.tracesSampleRate,
    // Sentry v11 never sends PII unless explicitly enabled, so no option needed.
  });
  console.log(`[jukebox] Sentry monitoring enabled (environment: ${config.environment}${config.release ? `, release: ${config.release}` : ''})`);
  return true;
}

/** Capture an error when monitoring is active; a no-op otherwise. */
export function captureError(error: unknown, context?: Record<string, string>): void {
  if (!Sentry.isEnabled()) return;
  Sentry.withScope(scope => {
    if (context) for (const [key, value] of Object.entries(context)) scope.setTag(key, value);
    Sentry.captureException(error);
  });
}
