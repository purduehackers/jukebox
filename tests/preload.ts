// Bun auto-loads .env.local into `bun test`, which would enable real Sentry
// monitoring (JUKEBOX_SENTRY_DSN) inside the test process. Tests must never
// send events, so strip every Sentry-related variable before any test file
// (and therefore before createRuntime/initMonitoring) runs.
for (const key of [
  'JUKEBOX_SENTRY_DSN', 'JUKEBOX_SENTRY_ENVIRONMENT', 'JUKEBOX_SENTRY_RELEASE', 'JUKEBOX_SENTRY_TRACES_SAMPLE_RATE',
  'SENTRY_DSN', 'SENTRY_ENVIRONMENT', 'SENTRY_RELEASE', 'SENTRY_TRACES_SAMPLE_RATE',
]) delete process.env[key];
