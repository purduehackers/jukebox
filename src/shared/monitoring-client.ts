/**
 * Optional browser-side Sentry monitoring for jukebox pages. The DSN and
 * options are injected by the server into <html data-sentry-*> attributes at
 * request time (same JUKEBOX_SENTRY_DSN as the authority and audio worker), so
 * no build-time secret plumbing is needed. Without a DSN this is a no-op.
 */
import * as Sentry from '@sentry/react';

let initialized = false;

export function initClientMonitoring(): boolean {
  if (initialized) return true;
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  const root = document.documentElement;
  const dsn = root.dataset.sentryDsn?.trim();
  if (!dsn) return false;
  if (Sentry.getClient()) { initialized = true; return true; }
  const rawRate = root.dataset.sentryTraces ?? '';
  const parsed = Number(rawRate);
  const tracesSampleRate = rawRate && Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
  Sentry.init({
    dsn,
    environment: root.dataset.sentryEnvironment || undefined,
    release: root.dataset.sentryRelease || undefined,
    tracesSampleRate,
    // Sentry v11 never sends PII unless explicitly enabled, so no option needed.
    integrations: defaults =>
      tracesSampleRate > 0 && !defaults.some(integration => integration.name === 'BrowserTracing')
        ? [...defaults, Sentry.browserTracingIntegration()]
        : defaults,
  });
  Sentry.setTag('page', window.location.pathname);
  initialized = true;
  return true;
}
